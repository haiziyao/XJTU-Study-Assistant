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

export function registerAiRoutes(router, { ai, files, apiPrefix }) {
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
  router.get(`${P}/conversations`, () => ai.listConversations());

  router.post(`${P}/conversations`, async ({ body }) => ({ ok: true, conversation: await ai.createConversation(body?.title) }));

  router.get(`${P}/conversations/:id`, ({ params }) => ai.getConversationDetail(params.id));

  router.delete(`${P}/conversations/:id`, ({ params }) => ai.deleteConversation(params.id));

  /** 清空全部会话（设置页用）。注意与 `DELETE /ai/conversations/:id` 的先后：带 :id 的先匹配。 */
  router.delete(`${P}/conversations`, () => ai.clearConversations());

  // ---------------------------------------------------------------- 对话
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
