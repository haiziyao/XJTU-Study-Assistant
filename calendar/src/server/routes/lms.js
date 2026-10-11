/**
 * 思源学堂（LMS）路由。
 *
 * 全部挂在 `/api/v1/lms` 下，只有「登录 / 验证码 / 同步」三类动作。
 * 约定：
 * - 所有写操作都必须先通过 `/lms/sync/preview` 预览，再带 keys 调 `/lms/sync/apply`；
 * - `/lms/captcha` 直接回二进制图片，方便 `<img src>` 直接用；
 * - 未登录时统一返回 401 UNAUTHORIZED，前端据此弹登录框。
 */

import { HttpError } from '../http/router.js';

const MAX_BODY_KEYS = 2000;

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw HttpError.badRequest(`字段 ${field} 必填`, { field });
  }
  return value.trim();
}

function asBool(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

function normalizeKeys(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw HttpError.badRequest('字段 keys 必须是数组');
  if (value.length > MAX_BODY_KEYS) throw HttpError.badRequest(`字段 keys 最多 ${MAX_BODY_KEYS} 项`);
  return value.map((item) => String(item));
}

/**
 * 学期参数：数字（学校侧学期 ID）、`none`（没有学期信息的课）、或空（不筛选）。
 */
function normalizeSemesterId(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  if (text === 'none') return 'none';
  const num = Number(text);
  return Number.isFinite(num) ? num : undefined;
}

function normalizeCourseIds(value) {
  if (value === undefined || value === null || value === '') return null;
  const list = Array.isArray(value) ? value : String(value).split(',');
  const ids = list
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
  return ids.length ? ids : null;
}

/** 把请求体里的同步选项整理成服务层认识的形状。 */
function syncOptionsFrom(body = {}) {
  const types = Array.isArray(body.types) ? body.types.map(String) : null;
  return {
    types,
    courseIds: normalizeCourseIds(body.courseIds),
    semesterId: normalizeSemesterId(body.semesterId),
    includePast: asBool(body.includePast),
    includeCourseRange: asBool(body.includeCourseRange),
    skipSubmitted: body.skipSubmitted === undefined ? true : asBool(body.skipSubmitted),
    markSubmittedDone: body.markSubmittedDone === undefined ? true : asBool(body.markSubmittedDone),
    pruneStale: asBool(body.pruneStale),
    refresh: asBool(body.refresh),
    today: typeof body.today === 'string' && body.today ? body.today : undefined,
    keys: normalizeKeys(body.keys),
  };
}

export function registerLmsRoutes(router, { lms, apiPrefix }) {
  const P = `${apiPrefix}/lms`;
  if (!lms) return;

  router.get(`${P}/status`, () => lms.status());

  router.post(`${P}/login`, async ({ body }) => {
    const username = requireText(body?.username, 'username');
    const password = requireText(body?.password, 'password');
    const captcha = typeof body?.captcha === 'string' ? body.captcha.trim() : undefined;
    return lms.login({ username, password, captcha, trustAgent: body?.trustAgent === undefined ? true : asBool(body.trustAgent) });
  });

  router.post(`${P}/mfa/send`, () => lms.sendMfaCode());

  router.post(`${P}/mfa/verify`, async ({ body }) => {
    const code = requireText(body?.code, 'code');
    return lms.verifyMfaCode(code);
  });

  router.get(`${P}/captcha`, async () => {
    const { bytes, contentType } = await lms.captcha();
    return { __raw: { contentType, body: Buffer.from(bytes) } };
  });

  router.post(`${P}/logout`, () => lms.logout());

  router.post(`${P}/settings`, ({ body }) => lms.updateSettings({ autoSync: body?.autoSync, autoSyncIntervalHours: body?.autoSyncIntervalHours }));

  // 学期列表（界面上的「选学期」下拉框）
  router.get(`${P}/semesters`, () => lms.listSemesters());

  router.get(`${P}/courses`, async ({ query }) => {
    const semesterId = normalizeSemesterId(query.semesterId);
    if (asBool(query.refresh)) return lms.refreshCourses({ semesterId });
    const cached = lms.listCourses({ semesterId });
    // 第一次访问且没有缓存时自动拉一次，避免前端要多点一下
    if (!cached.count) return lms.refreshCourses({ semesterId });
    return cached;
  });

  router.post(`${P}/courses/refresh`, ({ body }) => lms.refreshCourses({ semesterId: normalizeSemesterId(body?.semesterId) }));

  router.get(`${P}/activities`, async ({ query }) => {
    const courseIds = normalizeCourseIds(query.courseId ?? query.courseIds);
    const semesterId = normalizeSemesterId(query.semesterId);
    const typeFilter = (items) => (query.type ? items.filter((item) => item.type === query.type) : items);
    if (asBool(query.refresh)) {
      const refreshed = await lms.refreshActivities({ courseIds, semesterId, force: true });
      const items = typeFilter(refreshed.items);
      return { ...refreshed, items, count: items.length };
    }
    const cached = lms.listActivities({ courseIds, semesterId, type: query.type });
    // 注意判断依据不是「列表为空」：某个学期可能还没拉过活动，也可能是真的没有作业
    if (!cached.count || lms.needsActivityRefresh({ courseIds, semesterId })) {
      const refreshed = await lms.refreshActivities({ courseIds, semesterId });
      const items = typeFilter(refreshed.items);
      return { ...refreshed, items, count: items.length };
    }
    return cached;
  });

  router.post(`${P}/activities/refresh`, ({ body }) =>
    lms.refreshActivities({ courseIds: normalizeCourseIds(body?.courseIds), semesterId: normalizeSemesterId(body?.semesterId), force: true }),
  );

  router.get(`${P}/activities/:id`, ({ params }) => lms.activityDetail(params.id));

  router.post(`${P}/sync/preview`, ({ body }) => lms.preview(syncOptionsFrom(body)));

  router.post(`${P}/sync/apply`, async ({ body }) => {
    if (body?.keys !== undefined && (!Array.isArray(body.keys) || !body.keys.length)) {
      throw HttpError.badRequest('字段 keys 不能为空数组（不传表示同步预览中的全部条目）');
    }
    return lms.apply(syncOptionsFrom(body));
  });
}
