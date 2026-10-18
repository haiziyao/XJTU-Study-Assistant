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

/**
 * 给模型的领域说明（由 ai 模块聚合进系统提示词）。
 *
 * 为什么在**本模块**声明而不是改 `ai/prompt.js`：模块自己最清楚"学堂作业去了哪里"，
 * 而且 ai 模块的提示词是通用契约，不该被某个业务模块的数据流向污染。
 * 这里只讲事实（作业在 todo 里、带什么标记），不新增 target —— 学堂没有注册
 * `lms` 指令处理器，编一个模型会用不上的 target 只会让它反复调错。
 */
const AI_PROMPT = `- 思源学堂（LMS）的**作业**会被自动同步成待办（target: "todo"，不需要用户手动点同步）：
  标题形如「课程名：作业标题」，tags 含「学堂」，externalId 以 "lms:activity:" 开头，
  deadline 就是作业截止日（YYYY-MM-DD，北京时间）。
  用户问「哪天要交什么 / 这周有什么作业 / 某门课什么时候截止」→ 查 todo（可按 deadline 过滤），
  直接用 deadline 回答，**不要从标题里猜日期**。
  默认只同步**本学期**作业：历史学期的作业不在待办里是正常现象，不代表同步失败
  （用户在设置里关掉「只同步本学期作业」后才会把历史作业也建出来）。
- 学堂的直播、回放、资料**不在待办里**（直播是日程、回放与资料是附件/活动），不要把回放说成作业。
- 若待办里一条「学堂」标签都没有，可能是还没登录学堂或上次同步失败：如实说明这一点，
  不要断言"没有作业"。`;

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

  aiPrompt: AI_PROMPT,

  /**
   * 只读查询回灌给模型时保留的字段（`{ [target]: string[] }`）。
   *
   * 为什么改的是 `todo`：学堂作业自动变成待办之后，"作业截止日"就活在待办集合里
   * （`deadline`），AI 查 todo 即可回答"哪天要交什么" —— 学堂本身没有注册独立的指令 target，
   * 凭空声明一个 `lms` 投影表只会是一份永远不会被执行的配置。
   *
   * 为什么要在 calendar 已经声明过 todo 投影的情况下再声明一次：ai 模块用
   * `Object.assign({}, ...modules.map(mod => mod.aiQueryFields))` 聚合，**后装配的模块整份覆盖**
   * 同名 target 的数组；本模块 order=20 在 calendar(10) 之后。这里补 `tags` / `externalId`
   * 是为了让模型能认出"这条是学堂作业"（`tags` 含「学堂」、`externalId` 以 `lms:activity:` 开头），
   * 否则它只能从标题里猜来源。
   *
   * ⚠️ 代价（取舍，已写进 README/报告）：这是一个**完整覆盖**，不是追加。calendar 以后往
   * `aiQueryFields.todo` 加字段时，必须同步看这里一眼，否则模型会看不到新字段。
   */
  aiQueryFields: {
    todo: [
      'id',
      'title',
      'deadline',
      'completed',
      'priority',
      'estimatedHours',
      'category',
      'parentId',
      'childCount',
      'childDoneCount',
      'hasChildren',
      // 学堂来源标记：缺了模型就分不清"学堂作业"与用户自己记的待办
      'tags',
      'externalId',
    ],
  },

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
