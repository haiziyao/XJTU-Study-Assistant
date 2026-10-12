/**
 * 思源学堂（LMS）模块：统一身份认证登录 → 课程/活动缓存 → 同步到日历。
 *
 * 依赖声明
 * --------
 * - **order = 20**：> calendar(10)，同步时要调用 `services.schedules/events` 写日程，
 *   并直接读 `store.schedules/events` 统计已同步条数。**把 order 调小会静默失败**。
 * - **order = 20 > auth(5)**：登录已经收敛到全局认证模块，本模块在 createServices 里
 *   调 `services.auth.registerSite('lms')` 与 `adoptLegacySession('lms-session.json')`。
 *   排在 auth 前面就拿不到 `services.auth`，装配期会直接抛错。
 * - 需要 `ctx.dataDir`：同步元信息落在 `lms-meta.json`（0644）。
 *   **会话票据不再由本模块持有** —— 它在 `auth-session.json`（0600），由 auth 模块统一管理。
 *
 * 配置
 * ----
 * `createServer({ lms: {...} })` 的切片会**整份**透传给 LmsService。
 * 注意 LmsService 的子组件拿到的是原始 config 而非解析结果，因此：
 * 要么不传 `config`（走 `PC_LMS_*` 环境变量 + 内置默认值），
 * 要么传**完整**的 config（部分覆盖会让 baseUrl 变成 undefined）。
 * 测试即用 `{ config: { baseUrl, casOrigin, ... } }` 指向 mock 站点。
 */

import { LmsService } from './service.js';
import { LMS_TOOL_SPECS } from './tools.js';
import { registerLmsRoutes } from './routes.js';
import { resolveLmsConfig } from './config.js';

export default {
  id: 'lms',
  title: '思源学堂',
  order: 20,

  collections: [
    { name: 'lmsCourses', file: 'lms-courses.json' },
    { name: 'lmsActivities', file: 'lms-activities.json' },
  ],

  /** 聚合进 GET /api/v1/ai/capabilities，供 AI Agent 按 name + params 调用，无需了解登录细节。 */
  aiTools: LMS_TOOL_SPECS,

  createServices({ store, broadcast, services, dataDir, options }) {
    const auth = services.auth;
    if (!auth) {
      throw new Error('lms 需要 auth 模块（order=5）先装配，请检查 src/modules/auth/module.js 是否存在');
    }
    const config = resolveSiteConfig(options);
    // 把学堂登记成一个需要认证的站点：之后 auth 会替它用共享票据完成 CAS 认证
    // （SSO 生效时全程不需要密码）。
    auth.registerSite({
      id: 'lms',
      label: '思源学堂',
      loginUrl: config.baseUrl,
      // 逐站点覆盖 CAS 源：测试里学堂指向自己的 mock，教务指向另一个
      casOrigin: config.casOrigin,
      timeoutMs: config.timeoutMs,
    });
    // 认领旧版会话文件：本模块已切换到共享认证，下次启动把 lms-session.json 并进共享罐后删除。
    auth.adoptLegacySession('lms-session.json');

    const lms = new LmsService({ store, services, broadcast, dataDir, config, auth });
    return { lms };
  },

  /** 全部路由挂在 `/api/v1/lms` 下，见 ./routes.js。 */
  registerRoutes(router, ctx) {
    registerLmsRoutes(router, { lms: ctx.own.lms, apiPrefix: ctx.apiPrefix });
  },

  /** 恢复上次状态（会话票据由 auth 恢复，本模块只恢复自己的元信息与登录态投影）。 */
  async restore({ own }) {
    await own.lms.restore();
  },

  start({ own }) {
    own.lms.startAutoSync();
  },

  stop({ own }) {
    own.lms.stopAutoSync();
  },
};

/**
 * 取该站点自己的配置。
 *
 * `createServer({ lms: {...} })` 传进来的形状有两种（历史原因）：
 * 直接给 config 字段，或整份切片本身就是 config。两者都认，
 * 并且**必须补全 baseUrl/casOrigin**，否则 registerSite 会拿到 undefined。
 */
function resolveSiteConfig(options = {}) {
  const slice = options && typeof options === 'object' ? options : {};
  const nested = slice.config && typeof slice.config === 'object' ? slice.config : null;
  return resolveLmsConfig(nested ?? slice);
}
