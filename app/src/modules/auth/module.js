/**
 * 全局统一身份认证模块。
 *
 * 职责：把「登录」收敛成一处，供所有需要学校账号的模块共用。
 * 已实测：学校的统一认证底层是 Keycloak，学堂（经典 CAS）与教务（OAuth2）
 * **共用同一个 TGC 票据**，所以共享一个 Cookie 罐就能单点登录（双向验过）。
 *
 * 依赖声明（重要）
 * ----------------
 * - `order = 5`：**必须早于所有需要认证的模块**（calendar 10 / lms 20 / academic 30）。
 *   它们在自己的 `createServices` 里调 `services.auth.registerSite(...)`，
 *   排在后面就拿不到 `services.auth`，装配期会直接抛错。
 * - 不声明任何 collection：登录态属于凭据，落在 `auth-session.json`（0600），
 *   不进 JsonStore（那是 0644 的业务数据，语义不同）。
 * - 不 import 任何业务模块。站点由各模块自己注册进来，auth 不认识"学堂""教务"是什么。
 */

import { AuthService } from './service.js';
import { registerAuthRoutes } from './routes.js';

/**
 * 给对话模型看的说明。
 *
 * 只讲"登录状态怎么查、需要登录时怎么办"，不讲账号密码怎么传 ——
 * 模型不该也不能替用户输密码，那是界面的事。
 */
const AI_PROMPT = `【统一身份认证】
思源学堂与教务系统用的是同一个学校账号，现在由全局认证统一管理（登录一次两边都通）。
- 查登录状态：GET /auth/status —— 返回 sites 数组，逐站点告诉你 ready（可用）还是未登录。
- 如果某个模块报「需要登录」「登录票据已过期」，**不要试图替用户登录**，
  也不要向用户索要密码：告诉对方「请到设置 → 统一身份认证里重新登录」即可。
- 用户问「我登录了吗」「学堂/教务连上了吗」，用 /auth/status 回答，逐站点说清楚。
- 登录、退出、短信验证码这些动作只有用户本人在设置页做，你没有对应的工具。`;

export default {
  id: 'auth',
  title: '统一身份认证',
  order: 5,

  /** 暴露 `services.auth`；业务模块在各自的 createServices 里取用它。 */
  createServices({ store, broadcast, services, dataDir, options }) {
    const auth = new AuthService({ store, broadcast, services, dataDir, options });
    return { auth };
  },

  registerRoutes(router, ctx) {
    registerAuthRoutes(router, { auth: ctx.own.auth, apiPrefix: ctx.apiPrefix });
  },

  /**
   * 恢复上次会话。
   *
   * 位置很关键：auth 的 order 最小，装配层按同一顺序调 restore，
   * 所以**它比 lms/academic 先恢复** —— 后者 restore 时就能直接依赖已恢复的共享罐。
   * 顺带会在这一步把旧版的 `lms-session.json` / `academic-session.json` 迁移过来。
   */
  async restore({ own }) {
    await own.auth.restore();
  },

  aiPrompt: AI_PROMPT,

  aiTools: [
    {
      name: 'auth_status',
      description: '全局登录状态：逐站点显示思源学堂 / 学业情况是否已就绪，以及当前账号',
      method: 'GET',
      path: '/auth/status',
      requiresAuth: false,
      mutates: false,
      implemented: true,
      params: {},
      returns: {
        status: 'string',
        loggedIn: 'boolean',
        username: 'string|null',
        readyCount: 'number',
        siteCount: 'number',
        sites: 'array',
      },
    },
    {
      name: 'auth_site_status',
      description: '单个站点的认证状态（是否可用、上次成功时间、不可用的原因）',
      method: 'GET',
      path: '/auth/sites/{id}',
      requiresAuth: false,
      mutates: false,
      implemented: true,
      params: { id: 'string' },
      returns: { id: 'string', label: 'string', ready: 'boolean', reason: 'string|null', lastOkAt: 'string|null' },
    },
  ],
};
