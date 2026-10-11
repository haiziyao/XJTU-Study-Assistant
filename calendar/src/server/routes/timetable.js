/**
 * 西交大课表导入路由。
 *
 * 全部挂在 `/api/v1/tt` 下，风格与 `src/server/routes/lms.js` 一致：
 * - 登录 / 验证码 / 会话是「未登录也能调」的三类动作；
 * - 其他业务接口未登录一律 `401 UNAUTHORIZED`，前端据此弹登录框；
 * - `/tt/captcha` 直接回二进制图片，方便 `<img src>` 直接用；
 * - 写操作必须「先 preview 再 apply」，默认逐周展开、默认不导入已经过去的课。
 */

import { HttpError } from '../http/router.js';

const MAX_BODY_KEYS = 2000;

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw HttpError.badRequest(`字段 ${field} 必填`, { field });
  return value.trim();
}

function asBool(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

/** 学期参数：校验格式（`2025-2026-1`），空值交给服务层用「当前学期」。 */
function normalizeTerm(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  if (!/^\d{4}-\d{4}-[123]$/.test(text)) {
    throw HttpError.badRequest('字段 term 必须是形如 2025-2026-1 的学期编号', { field: 'term' });
  }
  return text;
}

function normalizeKeys(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw HttpError.badRequest('字段 keys 必须是数组');
  if (value.length > MAX_BODY_KEYS) throw HttpError.badRequest(`字段 keys 最多 ${MAX_BODY_KEYS} 项`);
  return value.map((item) => String(item));
}

/** 把请求体整理成服务层认识的同步选项。 */
function syncOptionsFrom(body = {}, query = {}) {
  return {
    term: normalizeTerm(body.term ?? query.term),
    includePast: asBool(body.includePast),
    compact: asBool(body.compact),
    pruneStale: asBool(body.pruneStale),
    refresh: asBool(body.refresh),
    today: typeof body.today === 'string' && body.today ? body.today : undefined,
    keys: normalizeKeys(body.keys),
  };
}

export function registerTimetableRoutes(router, { timetable, apiPrefix }) {
  if (!timetable) return;
  const P = `${apiPrefix}/tt`;

  // ---------------------------------------------------------------- 会话
  router.get(`${P}/status`, () => timetable.status());

  router.post(`${P}/login`, async ({ body }) => {
    const username = requireText(body?.username, 'username');
    const password = requireText(body?.password, 'password');
    const captcha = typeof body?.captcha === 'string' ? body.captcha.trim() : undefined;
    return timetable.login({ username, password, captcha, trustAgent: body?.trustAgent === undefined ? true : asBool(body.trustAgent) });
  });

  router.post(`${P}/mfa/send`, () => timetable.sendMfaCode());

  router.post(`${P}/mfa/verify`, async ({ body }) => {
    const code = requireText(body?.code, 'code');
    return timetable.verifyMfaCode(code);
  });

  router.get(`${P}/captcha`, async () => {
    const { bytes, contentType } = await timetable.captcha();
    return { __raw: { contentType, body: Buffer.from(bytes) } };
  });

  router.post(`${P}/logout`, () => timetable.logout());

  // ---------------------------------------------------------------- 学期
  router.get(`${P}/terms`, ({ query }) => timetable.listTerms({ refresh: asBool(query.refresh) }));

  router.post(`${P}/terms/:term`, ({ params, body }) =>
    timetable.setTermStart(params.term, requireText(body?.startDate, 'startDate')),
  );

  // ---------------------------------------------------------------- 课表
  router.get(`${P}/courses`, ({ query }) => timetable.courses(normalizeTerm(query.term), { refresh: asBool(query.refresh) }));

  router.post(`${P}/refresh`, ({ query, body }) => timetable.refreshTimetable(normalizeTerm(body?.term ?? query.term)));

  // ---------------------------------------------------------------- 同步
  router.post(`${P}/preview`, ({ query, body }) => timetable.preview(syncOptionsFrom(body ?? {}, query)));

  router.post(`${P}/apply`, async ({ query, body }) => {
    if (body?.keys !== undefined && (!Array.isArray(body.keys) || !body.keys.length)) {
      throw HttpError.badRequest('字段 keys 不能为空数组（不传表示应用预览里的全部条目）');
    }
    return timetable.apply(syncOptionsFrom(body ?? {}, query));
  });
}
