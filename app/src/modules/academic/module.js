/**
 * 学业情况查询模块。
 *
 * 职责：从本科教务系统拉取成绩 → 落本地 → 算学分绩（每门课可单独选择是否纳入）→
 * 供界面展示、供 AI 读取并出学情分析。
 *
 * `order: 30` 是有意的：排在 `lms`(20) 之后、`ai`(90) 之前 ——
 * ai 模块要聚合本模块声明的 `aiPrompt` / `aiQueryFields`，所以必须排在它前面。
 */

import { defineModule } from '../../core/module/contract.js';
import { AcademicService } from './service.js';
import { AcademicParser } from './parser.js';
import { createAcademicCommands } from './commands.js';
import { registerAcademicRoutes } from './routes.js';
import { resolveAcademicConfig } from './config.js';

/**
 * 给对话模型看的领域说明。
 *
 * 两件事必须说清楚，否则模型一定会答错：
 * 1. 有 `grade` 这个 target 可以查，以及它的动作与筛选条件；
 * 2. **它和 `lms_grades` 不是一回事** —— 后者是思源学堂视角的「课程总分与各项得分」，
 *    本模块是教务系统的官方成绩单（含学分与绩点）。两者同时存在时模型很容易混用。
 */
const AI_PROMPT = `【学业成绩（教务系统）】
用户可以查询自己在**本科教务系统**里的官方成绩单。相关的 target 是 "grade"：
- 查成绩：{"action":"query","target":"grade","filters":{...}}
  可选 filters：term（学期代码，形如 "2025-2026-1"）、keyword（课程名关键词）、
  nature（"01"=必修，"02"=选修）、failedOnly（true 只看不及格）、
  included（true/false 只看已纳入/已排除的）
  term **可以不给**：不给就返回整份成绩单（默认就是全部，界面会按学期分组展示）；
  也可以给字符串 "current" 表示「这学期/本学期」，具体是哪一学期由系统按当天日期推断。
  query 是只读的，会直接返回结果，里面带 summary（gpa 学分绩、weightedAverage 加权平均分、
  totalCredits 参与计算的学分、earnedCredits 已获得学分），回答「我学分绩多少」直接用 summary。
- 纳入/排除某门课：{"action":"include"|"exclude","target":"grade","filters":{...}}
  这是**写操作**，必须先 dryRun 预览并让用户确认。

学情分析：接口 /academic/analysis（GET 读已存的、POST 生成一段新的）。
  用户问「分析一下我的学习情况」「我该怎么提升学分绩」时，可以直接读这段分析作为依据；
  但要注意它可能是**过期的**（返回里的 stale 为 true 就说明成绩或勾选已经变了），
  过期时应当以 grade 查询的实时数据为准，或提示用户重新生成。

三条口径，答问时要按它说，不要自己另立算法：
- **学分绩（GPA）**只统计**被纳入**的课程，按学分加权：Σ(学分×绩点)/Σ(学分)；
- 每门课的**绩点由教务直接给出**（字段 XFJD），不要自己按分数换算；
- 少数课程是**等级制**（优秀/良好这类），没有绩点也进不了学分绩，默认不纳入，
  在 needsAttention 里单独列出 —— 用户问起时要说明这一点，不要说成"缺数据"。

拿到成绩明细以后这样答：
- 先给一张**按学期分组**的简表（每学期列课程数/学分/学分绩），后面跟一两句**基于真实数据**的点评
  （哪门在拖后腿、必修与选修对比、以及"学分绩只算已纳入的课程"这个前提）；
- **不要**编排名、保研线、分数预测这类库里没有的信息；
- **不要**替用户决定某门课"是否计入学分绩" —— 那是写操作，得用户自己点确认。

注意与思源学堂的 lms_grades 区分：那是学堂里每门课的总分与各项得分（平时分、作业分），
**不是**官方成绩单；学分、绩点、学分绩只由本模块的 grade 提供。`;

export default defineModule({
  id: 'academic',
  title: '学业',
  order: 30,

  collections: [
    {
      name: 'academicGrades',
      file: 'academic-grades.json',
      // externalId 是幂等键（教务的 WID），term 用于按学期筛选
      indexes: ['externalId', 'term'],
    },
  ],

  createServices({ store, broadcast, services, dataDir, options }) {
    const auth = services.auth;
    if (!auth) {
      throw new Error('academic 需要 auth 模块（order=5）先装配，请检查 src/modules/auth/module.js 是否存在');
    }
    const config = resolveSiteConfig(options);
    // 登记教务为一个需要认证的站点：之后 auth 会用共享罐里的 CAS 票据替它完成
    // OAuth2 四跳认证 —— 只要用户在设置页登录过一次（哪怕是从学堂那个入口登的）。
    auth.registerSite({
      id: 'academic',
      label: '学业情况',
      loginUrl: config.loginUrl,
      casOrigin: config.casOrigin,
      timeoutMs: config.timeoutMs,
    });
    // 认领旧版会话文件：本模块已切到共享认证，下次启动把 academic-session.json 并进共享罐后删除。
    auth.adoptLegacySession('academic-session.json');

    const academic = new AcademicService({
      store,
      broadcast,
      services,
      // 传原始切片而不是 config：AcademicService 自己也走 resolveAcademicConfig，
      // 两边解析同一份输入，避免出现"注册站点用的 mock、发请求用的真实站点"这种割裂。
      config: nestedConfigOf(options),
      dataDir,
      auth,
    });

    // 登记对话能力：登记之后 /commands/parse|execute|run 就能操作 grade，
    // 框架无需认识"学业"这个概念。
    services.commands.registerParser('academic', new AcademicParser({ academic }));
    services.commands.registerHandler('grade', createAcademicCommands({ academic }));

    return { academic };
  },

  /** 启动时恢复上次会话；失败只降级为未登录，不阻断整个进程。 */
  async restore({ own }) {
    await own.academic.restore();
  },

  registerRoutes(router, { own, apiPrefix }) {
    registerAcademicRoutes(router, { academic: own.academic, apiPrefix });
  },

  /**
   * 暴露给 AI Agent 的工具清单。
   *
   * 全部标 `implemented: true` —— 与学堂模块那 6 条"契约先行"的预置项不同，
   * 这里的接口是真写完了的，标成 false 会让 Agent 以为不能用。
   */
  aiTools: [
    {
      name: 'academic_status',
      description: '学业模块状态：登录态、成绩条数、学分绩、上次同步时间、授权握手诊断',
      method: 'GET',
      path: '/academic/status',
      requiresAuth: false,
      mutates: false,
      implemented: true,
      params: {},
      returns: {
        status: 'string',
        loggedIn: 'boolean',
        grades: 'object',
        gpa: 'number|null',
        weightedAverage: 'number|null',
        lastSyncAt: 'string|null',
        handshake: 'object',
      },
    },
    {
      name: 'academic_login',
      description: '用统一身份认证登录教务系统（可能需要短信验证码）',
      method: 'POST',
      path: '/academic/login',
      requiresAuth: false,
      mutates: false,
      implemented: true,
      params: { username: 'string', password: 'string', captcha: 'string?' },
      returns: { status: 'string', mfa: 'object|null' },
    },
    {
      name: 'academic_grades',
      description: '列出已同步的成绩；支持 ?term= 与 ?included= 过滤',
      method: 'GET',
      path: '/academic/grades',
      requiresAuth: true,
      mutates: false,
      implemented: true,
      params: { term: 'string?', included: 'boolean?' },
      returns: { items: 'array', count: 'number' },
    },
    {
      name: 'academic_stats',
      description: '学分绩与加权平均分统计（可按学期）；含未纳入却算不出绩点的课程清单',
      method: 'GET',
      path: '/academic/stats',
      requiresAuth: true,
      mutates: false,
      implemented: true,
      params: { term: 'string?' },
      returns: {
        gpa: 'number|null',
        weightedAverage: 'number|null',
        totalCredits: 'number',
        earnedCredits: 'number',
        terms: 'array',
        needsAttention: 'array',
      },
    },
    {
      name: 'academic_terms',
      description: '有成绩的学期清单，用于渲染筛选项',
      method: 'GET',
      path: '/academic/terms',
      requiresAuth: true,
      mutates: false,
      implemented: true,
      params: {},
      returns: { items: 'array', count: 'number' },
    },
    {
      name: 'academic_toggle_included',
      description: '设置某门成绩是否计入学分绩（写操作，需用户确认）',
      method: 'POST',
      path: '/academic/grades/{id}/included',
      requiresAuth: true,
      mutates: true,
      implemented: true,
      params: { id: 'string', included: 'boolean' },
      returns: { grade: 'object', stats: 'object' },
    },
    {
      name: 'academic_toggle_bulk',
      description: '批量设置是否计入学分绩；可给 ids，也可给 term 或 only（all/failed/unmapped/stale）',
      method: 'POST',
      path: '/academic/grades/included/bulk',
      requiresAuth: true,
      mutates: true,
      implemented: true,
      params: { ids: 'array?', term: 'string?', only: 'string?', included: 'boolean' },
      returns: { changed: 'number', stats: 'object' },
    },
    {
      name: 'academic_sync_preview',
      description: '预览同步教务成绩（只读，不写库）',
      method: 'POST',
      path: '/academic/sync/preview',
      requiresAuth: true,
      mutates: false,
      implemented: true,
      params: {},
      returns: { counts: 'object', stats: 'object' },
    },
    {
      name: 'academic_sync_apply',
      description: '从教务系统同步成绩并落库（写操作，Agent 必须先预览并征得确认）',
      method: 'POST',
      path: '/academic/sync/apply',
      requiresAuth: true,
      mutates: true,
      implemented: true,
      params: {},
      returns: { counts: 'object', stats: 'object' },
    },
    {
      name: 'academic_analysis',
      description: '读取已有的学情分析（含 stale 标记：成绩或勾选变了以后旧结论就不代表现状）',
      method: 'GET',
      path: '/academic/analysis',
      requiresAuth: true,
      mutates: false,
      implemented: true,
      params: {},
      returns: { available: 'boolean', stale: 'boolean', text: 'string?', source: 'string?', basis: 'object?' },
    },
    {
      name: 'academic_analyze',
      description: '生成一段学情分析；未配置 AI 时退化为本地统计摘要（source 为 local）',
      method: 'POST',
      path: '/academic/analysis',
      requiresAuth: true,
      mutates: false,
      implemented: true,
      params: { force: 'boolean?' },
      returns: { ok: 'boolean', text: 'string', source: 'string', basis: 'object' },
    },
  ],

  aiPrompt: AI_PROMPT,

  /** 只读查询结果回灌给模型时保留这些字段（覆盖 ai 模块内置的投影表）。 */
  aiQueryFields: {
    // termLabel 让模型能按「2025-2026 学年 · 第 1 学期」分组；levelGrade 与 passedLabel 是
    // 等级制课程在对话里唯一的成绩来源（它们没有分数也没有绩点），缺了会显示成空分数。
    grade: [
      'id',
      'courseName',
      'credit',
      'score',
      'gradePoint',
      'levelGrade',
      'term',
      'termLabel',
      'natureLabel',
      'included',
      'passedLabel',
    ],
  },

  /**
   * 各 target 只读查询回灌给模型的条数上限（ai 模块默认 20 条）。
   *
   * 成绩单要能**整份**回灌：本地实测 44 门课，按默认 20 条会被腰斩一半，
   * 模型据此给出的"按学期分组的简表"和点评本身就是残的，而它自己看不出来。
   * 300 足够覆盖四年本科，也不至于让提示词失控。
   */
  aiQueryLimits: {
    grade: 300,
  },
});

/**
 * 取该站点自己的配置。
 *
 * `createServer({ academic: {...} })` 传进来的形状有两种（历史原因，lms 那边也一样）：
 * 直接给扁平切片，或包一层 `{ config: {...} }`。两者都认。
 *
 * 这一步不能省：`registerSite` 拿到的 `loginUrl`/`casOrigin` 必须与
 * `AcademicService` 实际发请求用的那份**完全一致**。否则会出现
 * 「注册的站点指向 mock、真正的请求打到真实教务」这种割裂 ——
 * 表现为 SSO 永远不就绪，而且要排查很久。
 */
function resolveSiteConfig(options = {}) {
  const slice = options && typeof options === 'object' ? options : {};
  const nested = slice.config && typeof slice.config === 'object' ? slice.config : null;
  return resolveAcademicConfig(nested ?? slice);
}

/** 交给 AcademicService 的原始切片（它自己会再解析一次，保持单一解析入口）。 */
function nestedConfigOf(options = {}) {
  const slice = options && typeof options === 'object' ? options : {};
  return slice.config && typeof slice.config === 'object' ? slice.config : slice;
}
