/**
 * 更改日志路由（`/api/v1/audit`）。
 *
 * 只有两个只读接口：
 *   - `GET /audit/log?actor=&module=&action=&since=&limit=&offset=`
 *   - `GET /audit/stats`
 *
 * **刻意没有删除/清空接口**：日志是“谁改了什么”的证据，AI 与界面都不该能擦掉它。
 * 需要清理时只能由用户在磁盘上删 `data/audit-log.json`（或等 5000 条自动裁剪）。
 */

import { HttpError } from '../../core/http/router.js';
import { DEFAULT_LIMIT, MAX_LIMIT } from './service.js';

const text = (value, max = 80) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
};

/** limit 夹紧：默认 50，最大 500；非法值不静默当成默认，避免前端以为“就这么多”。 */
function limitOf(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
  const num = Number(value);
  if (!Number.isFinite(num)) throw HttpError.badRequest('字段 limit 不合法：必须是整数', { field: 'limit' });
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(num)));
}

function offsetOf(value) {
  if (value === undefined || value === null || value === '') return 0;
  const num = Number(value);
  if (!Number.isFinite(num)) throw HttpError.badRequest('字段 offset 不合法：必须是整数', { field: 'offset' });
  return Math.max(0, Math.floor(num));
}

export function registerAuditRoutes(router, { audit, apiPrefix = '/api/v1' }) {
  if (!audit) return;
  const P = `${apiPrefix}/audit`;

  /** 列表：默认最新 50 条；筛选条件全部可组合。 */
  router.get(`${P}/log`, async ({ query }) => {
    const actor = text(query?.actor, 20);
    if (actor && !['user', 'ai', 'system'].includes(actor)) {
      throw HttpError.badRequest('字段 actor 不合法：取值必须是 user / ai / system 之一', { field: 'actor' });
    }
    const since = text(query?.since, 40);
    if (since && Number.isNaN(Date.parse(since))) {
      throw HttpError.badRequest('字段 since 不合法：需要 ISO 时刻或 YYYY-MM-DD', { field: 'since' });
    }
    return audit.list({
      actor,
      module: text(query?.module, 40),
      action: text(query?.action, 40),
      since,
      limit: limitOf(query?.limit),
      offset: offsetOf(query?.offset),
    });
  });

  /** 计数：按 actor / module / action；`total` 是全部日志条数（裁剪前的逻辑见 service）。 */
  router.get(`${P}/stats`, () => audit.stats());
}
