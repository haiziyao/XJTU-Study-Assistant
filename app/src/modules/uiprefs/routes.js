/**
 * 界面偏好路由：全部挂在 `/api/v1/ui` 下。
 *
 *   GET  /ui/prefs        → `{ items: { [key]: value } }`（一次取回全部，前端启动时读一遍）
 *   GET  /ui/prefs/:key   → `{ key, value }`（value 为 null 表示从未设置过）
 *   PUT  /ui/prefs/:key   → 写入 `{ value }`；`value: null` = 删除（回到默认）
 */

import { HttpError } from '../../core/http/router.js';

export function registerUiPrefRoutes(router, { prefs, apiPrefix }) {
  const P = `${apiPrefix}/ui`;

  router.get(`${P}/prefs`, () => prefs.all());

  router.get(`${P}/prefs/:key`, ({ params }) => prefs.get(params.key));

  router.put(`${P}/prefs/:key`, async ({ params, body }) => {
    // 显式要求"必须带 value 字段"：区分"设成 null"与"忘传了"，
    // 否则一个漏传的请求会静默把用户的偏好删掉。
    if (!body || !Object.prototype.hasOwnProperty.call(body, 'value')) {
      throw HttpError.badRequest('请求体必须包含 value 字段（想删除就显式传 value: null）', { field: 'value' });
    }
    return prefs.set(params.key, body.value);
  });
}
