/**
 * 更改日志模块（id `audit`，order 6 —— 紧跟 auth 之后）。
 *
 * 为什么 order 这么靠前
 * --------------------
 * 各业务模块要在自己的 `createServices` 里拿到 `services.audit` 并注入服务
 * （calendar 10 / notes 40 / memory 45），所以 audit 必须比它们先装配。
 * 它不依赖任何业务模块，也不会被循环依赖卡住。
 *
 * 为什么不在 `collections` 里声明
 * ------------------------------
 * JsonStore 的集合会写成 `{schemaVersion, items}` 且权限 0644；日志要求
 * `data/audit-log.json` 是裸数组、0600、最多 5000 条。所以本模块用自己的小存储
 * （见 service.js 的“为什么不用 JsonStore”）。
 *
 * 给 AI 的边界
 * ------------
 * 只开放只读查询 target `log`；**没有**任何删除/清空日志的写能力。
 * AI 可以回答“你什么时候删的”，但不能把证据删掉。
 */

import { AuditService, createAuditCommands } from './service.js';
import { registerAuditRoutes } from './routes.js';

/**
 * 给对话模型的领域说明（由 ai 模块聚合进系统提示词）。
 *
 * 必须写清“什么时候用”与“只读”：模型最容易犯的错是把“你之前改过什么”
 * 当成记忆查询（那是长期记忆，不是操作记录），或者以为自己能清日志。
 */
const AI_PROMPT = `【更改日志：谁在什么时候改了什么】
- 当用户问“你之前改过什么 / 我什么时候删的 / 上次那条待办是谁改的 / 最近有什么改动”时，
  用只读查询 target \`log\`：
  {"ok":true,"action":"query","target":"log","filters":{"actor":"ai","limit":10},"explain":"查最近的更改记录"}
  filters 支持 actor（user / ai / system）、module（todo / schedule / event / note / memory …）、
  action（create / update / delete / bulk / settings / login …）、since（ISO 时间或 YYYY-MM-DD）、limit。
- 日志只读：**你没有删除、修改或清空日志的能力**。用户要求“把日志删了”时，如实说明做不到。
- 回答时用“谁（用户/AI/系统）在什么时间、对哪个模块做了什么”的口吻；不要把自己的改动说成用户的。`;

export default {
  id: 'audit',
  title: '更改日志',
  order: 6,

  // 不声明 JsonStore 集合：日志文件是裸数组 + 0600，见文件头说明。
  collections: [],

  aiPrompt: AI_PROMPT,
  // 只读查询回灌给模型时保留的字段：够回答“谁/何时/对什么/做了什么”，不把 before/after 全塞回去。
  aiQueryFields: {
    log: ['at', 'actor', 'module', 'action', 'targetId', 'title', 'summary'],
  },
  // 日志量可能很大：一次给 20 条够模型说清“最近”，再多会挤掉对话上下文。
  aiQueryLimits: { log: 20 },

  aiTools: [
    {
      name: 'audit_log_query',
      description: '只读查询更改日志：谁（用户/AI/系统）在什么时候、对哪个模块做了什么改动',
      method: 'GET',
      path: '/audit/log',
      requiresAuth: false,
      mutates: false,
      implemented: true,
      params: {
        actor: 'string?（user / ai / system）',
        module: 'string?（todo / schedule / event / note / memory …）',
        action: 'string?（create / update / delete / bulk …）',
        since: 'string?（ISO 时刻或 YYYY-MM-DD）',
        limit: 'number?（默认 50，最大 500）',
        offset: 'number?',
      },
      returns: { items: 'AuditEntry[]', total: 'number', count: 'number', hasMore: 'boolean' },
    },
  ],

  createServices({ dataDir, services, options }) {
    const audit = new AuditService({
      dataDir,
      ...(options?.flushMs === undefined ? {} : { flushMs: options.flushMs }),
      ...(options?.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    });

    // 只读 target `log`：注册后 AI 的查询草稿会被 commands 自动执行并回灌。
    // 这里只登记 query —— 没有 create/update/delete，模型想删日志会收到“不支持 action”。
    services.commands.registerHandler('log', createAuditCommands({ audit }));

    return { audit };
  },

  /** listen 之前把已有日志读进内存（损坏时自动备份并空启动）。 */
  async restore({ own }) {
    await own.audit.load();
  },

  registerRoutes(router, ctx) {
    registerAuditRoutes(router, { audit: ctx.own.audit, apiPrefix: ctx.apiPrefix });
  },

  /** 逆序停止时会走到这里：同步落盘最后一批（框架 close 不 await stop）。 */
  stop({ own }) {
    own.audit?.stop();
  },
};
