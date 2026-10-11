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

export function registerAiRoutes(router, { ai, apiPrefix }) {
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
    if (!text.trim()) throw HttpError.badRequest('text 不能为空', { field: 'text' });
    return ai.send({
      text,
      conversationId: body?.conversationId,
      context: body?.context && typeof body.context === 'object' ? body.context : {},
      stream: asBool(body?.stream),
    });
  });
}
