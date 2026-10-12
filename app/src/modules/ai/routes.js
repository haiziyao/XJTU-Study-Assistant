/**
 * AI 模块路由（前缀 `/api/v1/ai`）。
 *
 * 与框架的分工：
 * - `GET  /ai/capabilities`、`POST /ai/nl2command` 由**框架**注册（`core/routes.js`），本模块不重复注册，
 *   但 `createServices` 里会把 provider 注册进 `aiBridge`，于是那两个接口从「501 占位」变成真的可用；
 * - 本文件注册的是对话与配置：会话、消息、聊天、上下文。
 *
 * 约定：
 * - **密钥只进不出**：`GET /ai/config` 永远不返回 `apiKey` 原值；
 * - `POST /ai/chat` 的 `stream: true` 不会让 HTTP 变成流 —— 流式的增量走 WebSocket
 *   （`ai_delta` / `ai_message`），HTTP 仍然一次性返回最终结果。这样前端"重连即恢复"，
 *   不需要处理半截的 HTTP 流。
 */

import { HttpError } from '../../core/http/router.js';

const asBool = (value) => value === true || value === 'true' || value === '1' || value === 1;

/** 会话可改名 / 可归档 / 可置顶；其余键一律 400（挡住客户端拼错的字段名）。 */
const CONVERSATION_FIELDS = Object.freeze(['title', 'archived', 'pinned']);
/** 手动改名上限。注意与 chat-service 的 TITLE_MAX=24（自动取第一句话当标题）不是一回事。 */
const CONVERSATION_TITLE_MAX = 200;

export function registerAiRoutes(router, { ai, files, aiScheduler, apiPrefix }) {
  const P = `${apiPrefix}/ai`;
  if (!ai) return;

  // ---------------------------------------------------------------- 状态与配置
  router.get(`${P}/status`, () => ({ ok: true, ...ai.status() }));

  router.get(`${P}/config`, () => ({ ok: true, config: ai.maskConfig() }));

  router.post(`${P}/config`, async ({ body }) => {
    if (!body || typeof body !== 'object') throw HttpError.badRequest('请求体必须是 JSON 对象');
    return { ok: true, config: await ai.updateConfig(body) };
  });

  /** 清掉磁盘上的配置（密钥失效，回落到环境变量或未配置）。 */
  router.delete(`${P}/config`, async () => ({ ok: true, config: await ai.resetConfig() }));

  /** 可选模型列表（顶栏「AI：<模型名>」点开后的选择器）。 */
  router.get(`${P}/models`, () => ai.listModels());

  /**
   * Token 用量与缓存命中率（「用量」气泡）。
   * `?conversationId=` 只看一个会话；不传统计全部。
   */
  router.get(`${P}/usage`, ({ query }) => ai.usage({ conversationId: query.conversationId || undefined }));

  // ---------------------------------------------------------------- 文件（Files API）
  if (files) {
    /** 本地账本（谁被上传过、对应的 file_id）。 */
    router.get(`${P}/files`, () => files.list());

    /** 上游真源的文件列表；`?upstream=1` 时去打上游。 */
    router.get(`${P}/files/upstream`, () => files.listUpstream());

    router.delete(`${P}/files/:id`, ({ params }) => files.remove(params.id));
  }

  // ---------------------------------------------------------------- 上下文
  router.get(`${P}/context`, async ({ query }) =>
    ai.buildContext({
      view: query.view,
      module: query.module,
      courseId: query.courseId,
      maxItems: query.maxItems,
      maxChars: query.maxChars,
    }),
  );

  // ---------------------------------------------------------------- 会话
  /**
   * 会话列表。`?archived=0|1|all`（默认 `0`：只列未归档的）。
   * 每条额外带 `archived` / `pinned` / `updatedAt` / `messageCount`，排序「置顶在前，其余按更新时间倒序」。
   */
  router.get(`${P}/conversations`, ({ query }) => listConversations(ai, query.archived));

  router.post(`${P}/conversations`, async ({ body }) => ({ ok: true, conversation: await ai.createConversation(body?.title) }));

  router.get(`${P}/conversations/:id`, ({ params }) => ai.getConversationDetail(params.id));

  /** 改名 / 归档 / 置顶：只改传进来的字段，其余保持原值。 */
  router.patch(`${P}/conversations/:id`, async ({ params, body }) => ({
    ok: true,
    conversation: await updateConversation(ai, params.id, body),
  }));

  /** 真删除（连消息一起删）。归档只是从默认列表里移开，不会走到这里。 */
  router.delete(`${P}/conversations/:id`, ({ params }) => ai.deleteConversation(params.id));

  /**
   * 清空全部会话（设置页用）。注意与 `DELETE /ai/conversations/:id` 的先后：带 :id 的先匹配。
   *
   * 语义：**归档的也一并清掉** —— 这里叫「清空全部」，用户按下它期望的是"一条不剩"，
   * 而不是"清完了列表里还藏着一堆归档的"。服务层本来就按集合全量删（不看 archived），
   * 这个注释只是把这个口径钉住，免得以后有人加上 `archived !== true` 的过滤。
   */
  router.delete(`${P}/conversations`, () => ai.clearConversations());

  // ---------------------------------------------------------------- 定时唤醒（时间 + 提示词）
  if (aiScheduler) {
    /** 全部定时任务（`{ ok, count, items }`）。 */
    router.get(`${P}/schedules`, () => aiScheduler.list());

    router.post(`${P}/schedules`, async ({ body }) => ({ ok: true, schedule: await aiScheduler.create(body) }));

    router.patch(`${P}/schedules/:id`, async ({ params, body }) => ({
      ok: true,
      schedule: await aiScheduler.update(params.id, body),
    }));

    router.delete(`${P}/schedules/:id`, ({ params }) => aiScheduler.remove(params.id));

    /**
     * 「现在试一下」：立刻跑一次。
     * 返回 `ran`（是否真的执行了）与 `succeeded`/`error`：执行器还没接线时是 `ran:false, reason:'no_runner'`，
     * 前端据此提示，而不是把 500 摆给用户看。
     */
    router.post(`${P}/schedules/:id/run`, ({ params }) => aiScheduler.runNow(params.id));
  }

  // ---------------------------------------------------------------- 对话
  /**
   * 试搜一次（设置里的「试一下」）：只做检索与抓正文，不写库、不进对话。
   * 返回里带诊断信息（用了哪个搜索后端、校内是否可达、每条为什么没抓到正文），
   * 这样"搜不到"能被当场定位，而不是只能看到一句"没搜到"。
   */
  router.post(`${P}/search/test`, async ({ body }) => {
    const query = String(body?.query ?? '').trim();
    if (!query) throw HttpError.badRequest('query 不能为空', { field: 'query' });
    return ai.searchPreview({ query, mode: body?.mode, limit: body?.limit });
  });

  router.post(`${P}/chat`, async ({ body }) => {
    const text = typeof body?.text === 'string' ? body.text : '';
    const hasFiles = Array.isArray(body?.attachments) && body.attachments.length > 0;
    if (!text.trim() && !hasFiles) throw HttpError.badRequest('text 与 attachments 至少要有一个', { field: 'text' });
    return ai.send({
      text,
      conversationId: body?.conversationId,
      context: body?.context && typeof body.context === 'object' ? body.context : {},
      stream: asBool(body?.stream),
      // 附件只在本轮使用：图片走多模态，文本内联进提示词（见 chat-service 的 normalizeAttachments）
      attachments: Array.isArray(body?.attachments) ? body.attachments : [],
      // 思考强度与写入权限：都是"这一轮"的选择，跟着消息一起落库。
      // thinking 不传就交给服务层用默认值（官方默认是**开思考**、effort=high）——
      // 这里**不能**兜成 'none'，否则"没传"会变成"关掉思考"，和官方语义相反。
      thinking: typeof body?.thinking === 'string' ? body.thinking : undefined,
      permission: typeof body?.permission === 'string' ? body.permission : 'manual',
      // 联网搜索：off / web（校外网）/ campus（校内网）。目前只是状态位，
      // 服务层会把它写进提示词，让模型**如实说明检索还没接入**，而不是编造搜到的内容。
      search: typeof body?.search === 'string' ? body.search : 'off',
    });
  });
}

/* ------------------------------------------------------------------ 会话生命周期
 *
 * 为什么这几段放在路由层而不是 chat-service.js：
 *   本次任务的硬约束是「chat-service.js 一行都不动」（那里的多轮循环很敏感），
 *   所以归档 / 置顶 / 改名这层"生命周期"逻辑落在这里 —— 但**存储只有一份**：
 *   读走 `ai.listConversations()`（服务层的唯一读取路径），写走同一个 `store.aiConversations`
 *   集合，广播也复用服务层手上那条通道。没有第二份会话存储，也没有第二套列表语义。
 * 如果以后要把它挪进服务层，整段搬过去即可，接口形状不用变。
 */

/** 会话列表：过滤 + 补齐生命周期字段 + 排序。 */
function listConversations(ai, archivedParam) {
  const mode = normalizeArchivedFilter(archivedParam);
  const base = ai.listConversations(); // { ok, count, items } —— 已有调用方的形状
  const items = base.items
    .map((item) => ({
      ...item,
      // 老记录没有这两个字段：补成 false，前端不必到处判 undefined
      archived: item.archived === true,
      pinned: item.pinned === true,
      updatedAt: item.updatedAt ?? item.createdAt ?? null,
      // 消息数优先用记录上的字段（chat-service 每次对话都会更新它，读一次就够）；
      // 只有老记录缺这个字段时才回退到现算，避免列表接口为了一个数字全表扫消息
      messageCount: Number.isFinite(item.messageCount) ? item.messageCount : countMessages(ai, item.id),
    }))
    .filter((item) => (mode === 'all' ? true : mode === '1' ? item.archived : !item.archived))
    .sort(compareConversations);
  return { ok: true, count: items.length, items };
}

/** `?archived=0|1|all`，默认 `0`（只列未归档）。非法值 400，而不是悄悄当成默认值。 */
function normalizeArchivedFilter(value) {
  if (value === undefined || value === null || value === '') return '0';
  const text = String(value).trim().toLowerCase();
  if (text === '0' || text === '1' || text === 'all') return text;
  throw HttpError.badRequest('archived 只能是 0 / 1 / all', { field: 'archived', allowed: ['0', '1', 'all'] });
}

/** 排序：置顶在前；其余按更新时间倒序（同刻再按最后消息、创建时间、id 兜底，保证顺序稳定）。 */
function compareConversations(a, b) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const keys = ['updatedAt', 'lastMessageAt', 'createdAt'];
  for (const key of keys) {
    const left = String(a[key] ?? '');
    const right = String(b[key] ?? '');
    if (left !== right) return right.localeCompare(left);
  }
  return String(a.id ?? '').localeCompare(String(b.id ?? ''));
}

/** 会话真实消息数（只在记录缺 `messageCount` 时用）。 */
function countMessages(ai, conversationId) {
  return (ai.store?.aiMessages?.all?.() ?? []).filter((item) => item.conversationId === conversationId).length;
}

/** 改名 / 归档 / 置顶：校验 → 写库 → 广播。 */
async function updateConversation(ai, id, body) {
  const patch = validateConversationPatch(body);
  const current = ai.getConversation(id); // 未知 id 一律 404（复用服务层的判定）
  const updated = await ai.store.aiConversations.update(current.id, patch);
  if (!updated) throw HttpError.notFound(`会话 ${id} 不存在`);
  // 渲染层靠这条刷新列表（沿用现有广播机制：data_changed + module:'ai'）
  ai.broadcast?.({
    type: 'data_changed',
    module: 'ai',
    payload: {
      target: 'ai_conversations',
      action: 'update',
      id: updated.id,
      fields: Object.keys(patch),
    },
  });
  return updated;
}

/** 只接受 title / archived / pinned；未提供的字段保持原值。 */
function validateConversationPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw HttpError.badRequest('请求体必须是 JSON 对象');
  }
  const keys = Object.keys(body);
  const unknown = keys.filter((key) => !CONVERSATION_FIELDS.includes(key));
  if (unknown.length) throw HttpError.badRequest(`不认识的字段：${unknown.join('、')}`, { fields: unknown });
  if (!keys.length) throw HttpError.badRequest('至少要提供 title / archived / pinned 之一', { fields: [...CONVERSATION_FIELDS] });

  const patch = {};
  if ('title' in body) {
    if (typeof body.title !== 'string') throw HttpError.badRequest('title 必须是字符串', { field: 'title' });
    const title = body.title.trim();
    if (!title) throw HttpError.badRequest('title 不能为空', { field: 'title' });
    if (title.length > CONVERSATION_TITLE_MAX) {
      throw HttpError.badRequest(`title 最长 ${CONVERSATION_TITLE_MAX} 字，收到 ${title.length} 字`, {
        field: 'title',
        max: CONVERSATION_TITLE_MAX,
      });
    }
    patch.title = title;
  }
  // 布尔字段严格校验：`"false"` 这种字符串在 JS 里是真值，放过去就会"关归档反而归档了"
  for (const field of ['archived', 'pinned']) {
    if (!(field in body)) continue;
    if (typeof body[field] !== 'boolean') throw HttpError.badRequest(`${field} 必须是布尔值`, { field });
    patch[field] = body[field];
  }
  return patch;
}
