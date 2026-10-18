/**
 * 番茄钟路由：`/api/v1/pomodoro/*`。
 *
 * 这一层只做 HTTP 参数 → 服务层类型的转换；所有状态迁移都在 service/state 里。
 *
 * 接口（冻结，前端/手机端照这个写）：
 *   GET  /pomodoro/status                 权威状态 + 今日/本周/近 7 天统计
 *   GET  /pomodoro/sessions?from=&to=&limit=
 *   POST /pomodoro/start|pause|resume|skip|stop|setTask|config
 *
 * POST 的响应**同时**平铺状态并保留一个 `status` 字段：前端可以直接用返回值更新界面，
 * 不必再跳一次 GET；`status` 的字段与 GET 完全一致，习惯嵌套调用的客户端也能用。
 */

import { HttpError } from '../../core/http/router.js';

const requireBody = (body) => {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw HttpError.badRequest('请求体必须是 JSON 对象');
  }
  return body;
};

/** POST 的统一返回形状：`{ status, ...status }`（理由见文件头）。 */
async function withStatus(promise) {
  const status = await promise;
  return { status, ...status };
}

export function registerPomodoroRoutes(router, { services, apiPrefix = '/api/v1' }) {
  const P = `${apiPrefix}/pomodoro`;
  const pomodoro = services.pomodoro;
  if (!pomodoro) return;

  router.get(`${P}/status`, async () => pomodoro.status());

  router.get(`${P}/sessions`, async ({ query }) =>
    pomodoro.sessionsList({
      from: query?.from,
      to: query?.to,
      limit: query?.limit,
    }),
  );

  router.post(`${P}/start`, async ({ body }) => {
    const input = requireBody(body);
    return withStatus(pomodoro.start(input));
  });

  router.post(`${P}/pause`, async () => withStatus(pomodoro.pause()));

  router.post(`${P}/resume`, async () => withStatus(pomodoro.resume()));

  router.post(`${P}/skip`, async () => withStatus(pomodoro.skip()));

  router.post(`${P}/stop`, async () => withStatus(pomodoro.stop()));

  router.post(`${P}/setTask`, async ({ body }) => {
    const input = requireBody(body);
    // 允许显式传 null（解除关联）；缺字段时服务层按 null 处理，语义一致
    return withStatus(pomodoro.setTask({ taskId: input.taskId ?? null }));
  });

  router.post(`${P}/config`, async ({ body }) => {
    const input = requireBody(body);
    // 同时接受扁平字段与 `{ config: {...} }`：两种写法在其它模块里都出现过，
    // 让调用方因为一层包装而 400 没有意义。
    const patch = input.config && typeof input.config === 'object' && !Array.isArray(input.config) ? input.config : input;
    return withStatus(pomodoro.updateConfig(patch));
  });
}
