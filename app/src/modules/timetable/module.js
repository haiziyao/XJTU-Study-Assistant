/**
 * 课表导入模块：把 `ehall / jwapp / wdkb` 的课表写进日历日程。
 *
 * 边界
 * ----
 * - **order = 23**：> `calendar`(10)，因为写日程必须走 `services.schedules`；
 *   > `auth`(5)，因为 createServices 里要 `services.auth.registerSite(...)`；
 *   排在 `academic`(30) / `lms`(20) 之间不会互相影响，只是给左栏留出「课表导入」的位置。
 *   （`pomodoro` 预留 21、`lms` 20、`academic` 30。）
 * - **不自己实现登录**：账号密码、CAS、MFA 全在 `auth` 模块；这里只登记一个站点 `timetable`。
 *   登录 URL 直接用课表业务地址，让 CAS 状态机自己跟 302（未登录时它会一路跳到登录页）。
 * - **不声明 collection**：课表本身不落库（每次预览按需拉取，短缓存），
 *   写出去的是 calendar 模块的 `schedules`。
 */

import { defineModule } from '../../core/module/contract.js';
import { TimetableService } from './service.js';
import { registerTimetableRoutes } from './routes.js';
import { resolveTimetableConfig } from './config.js';

/**
 * 给对话模型看的领域说明。
 *
 * 重点只有两条：课表是「导入」而不是「实时查询」；写/删日程是有副作用的操作，
 * 必须先让用户确认 —— 模型不该自己替用户把几十条日程写进日历。
 */
const AI_PROMPT = `【课表导入（教务 wdkb）】
用户可以把本科教务系统的课表导入日历。数据来源固定为 https://ehall.xjtu.edu.cn/jwapp/sys/wdkb
（课表 / 当前学期 / 学期起始日三个接口都在它下面），登录复用全局统一身份认证。
- 查状态：GET /timetable/status（是否需要登录、当前学期、可选的 7 个学期、已导入条数）。
- 预览：GET /timetable/preview?term=2026-2027-1 —— 只读，返回课程、星期、节次、周次与将要写入的日程数。
- 导入：POST /timetable/import {term, courseIds, untilWeek?} —— **写操作**，会往日历里写日程；
  必须先预览并对用户说明会写多少条，得到确认后再调用。
- 删除：POST /timetable/remove {term, courseIds} 或 {all:true} —— 只删本模块导入的日程
  （externalId 以 timetable: 开头），用户手建的日程不会被删。
- 如果返回 401 NOT_LOGGED_IN：不要向用户索要密码，告诉对方「请到设置 → 统一身份认证登录」。
- 如果返回 502 EHALL_ERROR：说明学校接口异常或已改版，把返回里的 path 原样告诉用户即可，
  不要编造课表内容。`;

export default defineModule({
  id: 'timetable',
  title: '课表导入',
  order: 23,

  createServices({ store, broadcast, services, dataDir, options }) {
    const auth = services.auth;
    if (!auth) {
      throw new Error('timetable 需要 auth 模块（order=5）先装配，请检查 src/modules/auth/module.js 是否存在');
    }
    const config = resolveSiteConfig(options);
    // 登记「课表导入」为一个需要认证的站点：之后 auth 会用共享罐里的 CAS 票据替它完成认证
    // （在设置页登录过一次，这里就不用再输密码）。
    auth.registerSite({
      id: 'timetable',
      label: '课表导入',
      loginUrl: config.loginUrl,
      casOrigin: config.casOrigin,
      timeoutMs: config.timeoutMs,
    });

    const timetable = new TimetableService({
      store,
      broadcast,
      services,
      // 传原始切片给服务层：它自己走 resolveTimetableConfig，保证「注册站点用的配置」
      // 与「真正发请求用的配置」是同一份（否则会出现注册到 mock、请求打到线上的割裂）。
      config: nestedConfigOf(options),
      dataDir,
      auth,
    });
    return { timetable };
  },

  /** 启动时只记下「已恢复」，不发网络请求；页面打开时再按需拉取。 */
  async restore({ own }) {
    await own.timetable.restore();
  },

  registerRoutes(router, { own, apiPrefix }) {
    registerTimetableRoutes(router, { timetable: own.timetable, apiPrefix });
  },

  /** 暴露给 AI Agent 的工具清单（与 routes.js 一一对应）。 */
  aiTools: [
    {
      name: 'timetable_status',
      description: '课表导入状态：是否已登录统一身份认证、当前学期、可选学期、已导入日程条数',
      method: 'GET',
      path: '/timetable/status',
      requiresAuth: false,
      mutates: false,
      implemented: true,
      params: {},
      returns: {
        loggedIn: 'boolean',
        reason: 'string|null',
        currentTerm: 'string|null',
        terms: 'array',
        imported: 'object',
      },
    },
    {
      name: 'timetable_preview',
      description: '预览某学期的课表（只读）：课程、教师、教室、星期、节次、周次、将写入的日程数',
      method: 'GET',
      path: '/timetable/preview',
      requiresAuth: true,
      mutates: false,
      implemented: true,
      params: { term: 'string?' },
      returns: { term: 'string', termStart: 'string', courses: 'array', count: 'number' },
    },
    {
      name: 'timetable_import',
      description: '把选中的课程导入日历（写操作，Agent 必须先预览并征得用户确认）',
      method: 'POST',
      path: '/timetable/import',
      requiresAuth: true,
      mutates: true,
      implemented: true,
      params: { term: 'string?', courseIds: 'array', untilWeek: 'number?' },
      returns: { created: 'number', updated: 'number', skipped: 'array', events: 'number', removed: 'number' },
    },
    {
      name: 'timetable_remove',
      description: '删除本模块导入的日程（写操作；可指定 term + courseIds，或 all:true 清空）',
      method: 'POST',
      path: '/timetable/remove',
      requiresAuth: false,
      mutates: true,
      implemented: true,
      params: { term: 'string?', courseIds: 'array?', all: 'boolean?' },
      returns: { removed: 'number' },
    },
    {
      name: 'timetable_imported',
      description: '按课程分组列出已导入的日程（本地数据，不需要登录）',
      method: 'GET',
      path: '/timetable/imported',
      requiresAuth: false,
      mutates: false,
      implemented: true,
      params: { term: 'string?' },
      returns: { count: 'number', courses: 'array' },
    },
  ],

  aiPrompt: AI_PROMPT,
});

/**
 * 取该站点自己的配置。
 *
 * `createServer({ timetable: {...} })` 传进来的形状有两种：直接给扁平切片，
 * 或包一层 `{ config: {...} }`。两者都认 —— 与 academic / lms 的写法一致。
 */
function resolveSiteConfig(options = {}) {
  const slice = options && typeof options === 'object' ? options : {};
  const nested = slice.config && typeof slice.config === 'object' ? slice.config : null;
  return resolveTimetableConfig(nested ?? slice);
}

/** 交给 TimetableService 的原始切片（它自己会再解析一次，保持单一解析入口）。 */
function nestedConfigOf(options = {}) {
  const slice = options && typeof options === 'object' ? options : {};
  return slice.config && typeof slice.config === 'object' ? slice.config : slice;
}
