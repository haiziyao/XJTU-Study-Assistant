/**
 * 校内通知聚合模块（id: notifications）。
 *
 * 一句话：**把校内各站点的通知沉淀到本地，让"最近有什么通知"变成一个能查、能问、能固定住的问题。**
 *
 * 为什么需要它
 * ------------
 * `ai/web-search.js` 的 campus 档已经能"栏目直读"，但那是一次性的：
 * 页面上现在有什么就返回什么，回答不了"这条我看过没有""哪条是新的""我上个月看到的那条还在吗"。
 * 校方的 `publishedAt` 经常缺、或者只到月份，也没法用它判断新旧。所以落库，
 * 并用 `firstSeenAt`（我们第一次见到它的时间）当"新"的判据 —— 详见 service.js 顶部。
 *
 * 依赖与装配顺序（order = 86）
 * ---------------------------
 * - 在 `aisearch`(85) 之后、`account`(88) / `sync`(89) 之前；
 * - **必须在 `ai`(90) 之前**：ai 模块在 `createServices` 里聚合各模块的
 *   `aiPrompt` / `aiQueryFields` / `aiQueryLimits`，排它后面声明就静默失效。
 * - 对 `ai/web-search.js` 是**纯函数/常量导入**（`readSiteNews`、`CAMPUS_SITE_SEARCH`），
 *   不是跨模块读写数据 —— 本模块只写自己的两个集合。复用那张站点表是因为它的栏目路径
 *   是**逐站实测校准过的**（每条带 `evidence`），另起一份爬虫只会更难维护。
 *
 * 集合
 * ----
 * `notifications`        → `data/notifications.json`          通知条目（含 read / pinned / firstSeenAt）
 * `notificationSettings` → `data/notification-settings.json`  单行：保留期、启用站点、自定义站点、上次同步
 */

import { NotificationService } from './service.js';
import { createNotificationCommands } from './commands.js';
import { registerNotificationRoutes } from './routes.js';
import { NOTIFICATION_TOOLS } from './tools.js';

const AI_PROMPT = `【校内通知（本地已同步）】
用户有一份**本地沉淀**的校内通知库，target 是 "notification"（教务处 / 研究生院 / 学校门户 / 新闻网，
以及用户自己添加的站点）。它与"校内网搜索"是两套东西：后者是**临时检索**，前者有沉淀、已读状态和固定标记。

- 查通知：{"action":"query","target":"notification","filters":{"site":"dean","unread":true,"limit":10}}
  filters 支持 siteId（站点 id）/ q（关键词）/ unreadOnly / pinned / since / limit / offset。
- 拉一次最新：{"action":"sync","target":"notification","filters":{"site":"dean"}}（**会联网、会写库**）
- 标为已读：{"action":"read","target":"notification","fields":{"ids":["…"]}} 或 {"all":true}
- 固定（不会被保留期清理）：{"action":"pin","target":"notification","fields":{"ids":["…"],"pinned":true}}

**什么时候用本地、什么时候去搜**
- 问"最近有什么通知""教务处的通知""有没有新的"→ **优先用本地 query**，不要再搜一遍网页。
- 本地为空、或用户明确要"最新的 / 刚发的"→ 先 \`sync\` 一次再 \`query\`。
- 用户问的是"**某条通知的正文讲了什么**"→ 用那条的 url 去读：
  {"action":"query","target":"web","fields":{"url":"<那条的 url>"}}（这一步会真的去抓，抓不到会如实报错）。
- 用户问的是校内**别的东西**（规定、流程、页面），那不是通知，用校规语料或 campus 检索。

**时间字段必须分清（说错就是骗人）**
- \`publishedAt\` 是校方给的发布日期，**可能是空的、也可能只到月份**。空了就说"校方没给发布日期"，
  只到月份就只说"某月"，**绝不许自己补一个具体日子**。
- \`firstSeenAt\` 是**我们本地第一次发现它**的时间。说"这是新的"必须有依据：
  要么 \`publishedAt\` 最近，要么 \`firstSeenAt\` 最近 —— 并说清是哪一种。

**数据新鲜度的边界**
- \`summary.lastSyncAt\` 是上次同步时间。如果很久没同步，回答时要说明"这是上次同步时的结果，
  现在校方可能已经发了新的"。不要把它说成"截至目前的最新通知"。
- \`summary.retentionNote\` 说明保留期：超期的通知**已经被清理**，本地查不到不代表校方没发过。
- 有站点 \`perSite[].error\` 非空时，不能说"那个站点没有新通知" —— 要说"那个站点这次没抓成（原因）"。

**引用规则**：每条通知都要带 url；本地没有的如实说没有，**不许编造通知标题、链接或日期**。`;

export default {
  id: 'notifications',
  title: '通知',
  order: 86,

  collections: [
    { name: 'notifications', file: 'notifications.json' },
    { name: 'notificationSettings', file: 'notification-settings.json' },
  ],

  aiTools: NOTIFICATION_TOOLS,
  aiPrompt: AI_PROMPT,

  /**
   * 回灌给模型时保留这些字段（**覆盖** ai 模块内置的投影表）。
   *
   * 刻意**不带** `readAt` / `lastSeenAt` / `pinnedAt`：它们几乎不影响任何判断，
   * 放在投影里只会挤掉别的条目。`publishedAt` 与 `firstSeenAt` 都在 —— 见提示词里那条"必须分清"。
   */
  aiQueryFields: {
    notification: [
      'id',
      'title',
      'url',
      'siteLabel',
      'publishedAt',
      'firstSeenAt',
      'read',
      'pinned',
      'snippet',
    ],
  },

  /** 通知条数会积累（保留期 90 天，10 个站大约几百条），给 20 条足够回答"最近有什么"。 */
  aiQueryLimits: {
    notification: 20,
  },

  createServices({ store, broadcast, log, services }) {
    const notifications = new NotificationService({ store, broadcast, log });

    /*
     * 注册对话里的 target `notification`。
     *
     * **只注册 handler，不注册 parser** —— "最近有什么通知"这种话由模型自己判断要不要查；
     * 用中文规则去抢反而会误伤（"通知"这个词在日常对话里太常见了，比如"通知他一下"）。
     */
    services.commands.registerHandler('notification', createNotificationCommands({ notifications }));

    return { notifications };
  },

  registerRoutes(router, ctx) {
    registerNotificationRoutes(router, { notifications: ctx.own.notifications, apiPrefix: ctx.apiPrefix });
  },
};
