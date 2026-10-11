/**
 * 思源学堂（LMS）路由。
 *
 * 全部挂在 `/api/v1/lms` 下，只有「登录 / 验证码 / 同步」三类动作。
 * 约定：
 * - 所有写操作都必须先通过 `/lms/sync/preview` 预览，再带 keys 调 `/lms/sync/apply`；
 * - `/lms/captcha` 直接回二进制图片，方便 `<img src>` 直接用；
 * - 未登录时统一返回 401 UNAUTHORIZED，前端据此弹登录框。
 */

import { HttpError } from '../../core/http/router.js';
import { activityTypesOf } from './config.js';

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

  router.get(`${P}/courses`, async ({ query }) => {
    if (asBool(query.refresh)) return lms.refreshCourses();
    const cached = lms.listCourses();
    // 第一次访问且没有缓存时自动拉一次，避免前端要多点一下
    if (!cached.count) return lms.refreshCourses();
    return cached;
  });

  router.post(`${P}/courses/refresh`, () => lms.refreshCourses());

  router.get(`${P}/activities`, async ({ query }) => {
    const courseIds = normalizeCourseIds(query.courseId ?? query.courseIds);
    // 与 lms.listActivities 用同一套归一：type 可以是 lesson/homework 这类底层类型，也可以是 online（网课 = 直播 + 回放 + 在线视频）分组
    const types = activityTypesOf(query.type);
    const typeFilter = (items) => (types ? items.filter((item) => types.includes(item.type)) : items);
    if (asBool(query.refresh)) {
      const refreshed = await lms.refreshActivities({ courseIds, force: true });
      return { ...refreshed, items: typeFilter(refreshed.items), count: typeFilter(refreshed.items).length };
    }
    const cached = lms.listActivities({ courseIds, type: query.type });
    if (!cached.count) {
      const refreshed = await lms.refreshActivities({ courseIds });
      const items = typeFilter(refreshed.items);
      return { ...refreshed, items, count: items.length };
    }
    return cached;
  });

  router.post(`${P}/activities/refresh`, ({ body }) => lms.refreshActivities({ courseIds: normalizeCourseIds(body?.courseIds), force: true }));

  router.get(`${P}/activities/:id`, ({ params }) => lms.activityDetail(params.id));

  /* ------------------------------------------------------------ 预置接口（尚未实现）
   *
   * 契约先定下来，实现留到后面。这里刻意返回 **501 而不是 404**：
   * 让调用方（尤其是 AI Agent）能区分「这个能力我认识，只是还没做」和「路径写错了」。
   * 对应的工具清单见 tools.js 里 `implemented: false` 的那几个。
   */
  const planned = (summary, contract) => () => {
    throw HttpError.notImplemented(`${summary}：接口已预置、尚未实现`, { planned: true, contract });
  };

  /** 某门课的详情（教师、学分、学期、教学班、起止、课件数）。 */
  router.get(
    `${P}/courses/:id`,
    planned('课程详情', { params: { id: 'string' }, returns: { id: 'string', name: 'string', instructors: 'array', credit: 'number', semester: 'object', startDate: 'string', endDate: 'string', materialCount: 'number' } }),
  );

  /** 某门课的课件/资料清单。 */
  router.get(
    `${P}/courses/:id/materials`,
    planned('课程资料清单', { params: { id: 'string' }, returns: { items: '[{ id, title, kind, bytes, uploadedAt, downloadable }]' } }),
  );

  /** 某门课的讨论区主题。 */
  router.get(
    `${P}/courses/:id/discussions`,
    planned('课程讨论区', { params: { id: 'string' }, returns: { items: '[{ id, title, author, replies, lastReplyAt }]' } }),
  );

  /** 某次作业的提交情况（是否提交、时间、得分、评语、附件）。 */
  router.get(
    `${P}/activities/:id/submission`,
    planned('作业提交情况', { params: { id: 'string' }, returns: { submitted: 'boolean', submittedAt: 'string?', score: 'number?', comment: 'string?', files: 'array' } }),
  );

  /** 课程通知/公告（可按课程过滤）。 */
  router.get(
    `${P}/notices`,
    planned('课程通知与公告', { params: { courseId: 'string?' }, returns: { items: '[{ id, courseId, courseName, title, publishedAt, body }]' } }),
  );

  /** 成绩（课程总分与各项得分）。 */
  router.get(
    `${P}/grades`,
    planned('成绩', { params: {}, returns: { items: '[{ courseId, courseName, score, fullScore, items }]' } }),
  );


  router.post(`${P}/sync/preview`, ({ body }) => lms.preview(syncOptionsFrom(body)));

  router.post(`${P}/sync/apply`, async ({ body }) => {
    if (body?.keys !== undefined && (!Array.isArray(body.keys) || !body.keys.length)) {
      throw HttpError.badRequest('字段 keys 不能为空数组（不传表示同步预览中的全部条目）');
    }
    return lms.apply(syncOptionsFrom(body));
  });
}
