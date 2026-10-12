/**
 * 学习周报路由：`/api/v1/weekly/*`（前缀由框架注入，见 core/http/router.js）。
 *
 * 这一层只做三件事，多余的都不做：
 *   1. **HTTP 参数 → 服务层类型**（`limit` 是字符串、`force` 可能没给）；
 *   2. **边界与错误语义**（非法日期 400、未知 id 404 —— `service` 里 `throw HttpError.*`，
 *      这里不 try/catch 把错误吞成 200：错误码是前端与 Agent 唯一能分辨"没写"与"写错了"的东西）；
 *   3. **不偷偷花钱**：`GET /weekly/report` 绝不触发模型调用，生成必须显式 POST。
 *      这不是洁癖 —— GET 会被前端轮询、被 Agent 重试、被浏览器预取，任何一次都不该花 token。
 *
 * 接口一览（详见本目录 README.md）：
 *   GET    /weekly/report?from=&to=   读某周（有缓存给缓存；没有只给 stats + report:null + hint）
 *   POST   /weekly/report/generate    生成（body: { from?, to?, force? }）
 *   GET    /weekly/reports?limit=     历史列表（按周倒序）
 *   DELETE /weekly/reports/:id        删除一条
 */

import { HttpError } from '../../core/http/router.js';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from './service.js';

/** 空串当"没传"：`?from=` 不应该被当成一个非法日期报 400（前端清空输入框就会这么发）。 */
const optionalText = (value) => {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
};

/** `limit` 给了就必须合法：静默回落默认值会让前端以为"一共就这么多"。 */
function optionalInt(value, field, { min, max }) {
  if (value === undefined || value === null || value === '') return undefined;
  const num = Number(value);
  if (!Number.isInteger(num)) throw HttpError.badRequest(`字段 ${field} 不合法：必须是整数`, { field });
  if (num < min || num > max) throw HttpError.badRequest(`字段 ${field} 不合法：取值范围 ${min}~${max}`, { field });
  return num;
}

/** 请求体：可以是空对象（全部走默认），但给了就必须是对象。 */
function requireBody(body) {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw HttpError.badRequest('请求体必须是 JSON 对象');
  return body;
}

export function registerWeeklyRoutes(router, { services, apiPrefix = '/api/v1' }) {
  const P = `${apiPrefix}/weekly`;
  const weekly = services.weekly;
  // 与其它模块一致的习惯：服务没装配好时宁可不注册，也不要让每个请求在运行期炸 undefined
  if (!weekly) return;

  /** 读某周：**只读、不调模型**。没有缓存时 `report: null` + `hint` 指路到 generate。 */
  router.get(`${P}/report`, ({ query }) => ({
    ok: true,
    ...weekly.getReport({ from: optionalText(query?.from), to: optionalText(query?.to) }),
  }));

  /**
   * 生成某周：唯一会调用模型（因而会花 token）的入口。
   *
   * 状态码刻意保持 200：模型不可用/调用失败是**降级**，不是错误 —— 返回体里用
   * `cached / fallback / reason` 说清这段字是怎么来的，让调用方决定要不要 `force` 重写。
   */
  router.post(`${P}/report/generate`, async ({ body }) => {
    const input = requireBody(body);
    return weekly.generate({
      from: optionalText(input.from),
      to: optionalText(input.to),
      force: input.force === true,
    });
  });

  /** 历史列表：按周倒序。`stats` 原样带出（报告是"当时那批数字"的产物，删掉就对不上了）。 */
  router.get(`${P}/reports`, ({ query }) => ({
    ok: true,
    ...weekly.list({ limit: optionalInt(query?.limit, 'limit', { min: 1, max: MAX_LIST_LIMIT }) ?? DEFAULT_LIST_LIMIT }),
  }));

  /** 删除一条（不可逆）：id 不存在 404，不猜。 */
  router.delete(`${P}/reports/:id`, async ({ params }) => weekly.remove(params.id));
}
