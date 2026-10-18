/**
 * 课表导入模块的路由，全部挂在 `/api/v1/timetable` 下。
 *
 * 服务层接口是冻结的（页面与测试都按它写）：
 *
 *   GET  /timetable/status                 登录态 / 当前学期 / 学期列表 / 已导入摘要（本地）
 *   GET  /timetable/preview?term=          预览（只读，会打学校接口）
 *   POST /timetable/import                 {term, courseIds, untilWeek?}
 *   POST /timetable/remove                 {term?, courseIds?, all?}
 *   GET  /timetable/imported?term=         已导入（只读本地）
 *
 * 错误语义（前端据此决定「去登录」还是「报上游故障」）：
 * - 未登录 / 票据失效 → **401 `NOT_LOGGED_IN`**；
 * - jwapp 应用授权握手失败（登录本身可能有效）→ **502 `EHALL_HANDSHAKE_FAILED`**，
 *   响应里带 `error.details.handshake.steps`（卡在哪一步）；这条必须和 401 分开，否则用户会被
 *   反复引导去重新登录，而问题其实在应用授权；
 * - 上游 302/500 / 非 JSON / `code!=="0"` → **502 `EHALL_ERROR`**，消息里带原始接口路径；
 * - 入参错误 → 400。
 *
 * `preview` 额外支持 `&refresh=1`（「刷新课表」按钮用），不在冻结形状里，属于可选参数。
 */

import { ERROR_CODES } from '../../shared/constants.js';
import { HttpError } from '../../core/http/router.js';
import { TIMETABLE_ERROR, TimetableError } from './api.js';
import { isTermString } from './term.js';

const MAX_COURSE_IDS = 2000;

function asBool(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

/** 学期参数：空 = 用当前学期；非空必须是 `2025-2026-1` 形式。 */
function normalizeTerm(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  // 用 term.js 的解析器而不是只写正则：它还会检查「学年必须连续」，
  // 否则 2026-2028-1 这种能过正则的脏值会在服务层抛错（表现为 500 而不是 400）。
  if (!isTermString(text)) {
    throw HttpError.badRequest('字段 term 必须是形如 2025-2026-1 的学期编号（-3 为小学期）', { field: 'term' });
  }
  return text;
}

/**
 * `courseIds`：省略 = 全部（导入）或空（删除，由服务层要求 all:true）；
 * 显式数组则逐项转字符串。数量设上限，避免异常请求把服务层拖死。
 */
function normalizeCourseIds(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw HttpError.badRequest('字段 courseIds 必须是数组', { field: 'courseIds' });
  if (value.length > MAX_COURSE_IDS) {
    throw HttpError.badRequest(`字段 courseIds 最多 ${MAX_COURSE_IDS} 项`, { field: 'courseIds' });
  }
  return value.map((item) => String(item));
}

/** 把服务层错误翻译成 HTTP 错误；不认识的原样交给上层。 */
export function translateTimetableError(error) {
  if (error instanceof HttpError) return error;
  if (!(error instanceof TimetableError)) return undefined;
  const details = error.details ?? {};

  switch (error.code) {
    case TIMETABLE_ERROR.NOT_LOGGED_IN:
      return new HttpError(401, TIMETABLE_ERROR.NOT_LOGGED_IN, error.message, {
        code: TIMETABLE_ERROR.NOT_LOGGED_IN,
        reason: details.reason ?? null,
      });
    case TIMETABLE_ERROR.BAD_REQUEST:
      return new HttpError(400, ERROR_CODES.BAD_REQUEST, error.message, {
        code: TIMETABLE_ERROR.BAD_REQUEST,
        ...details,
      });
    case TIMETABLE_ERROR.EHALL_HANDSHAKE_FAILED:
      return new HttpError(502, TIMETABLE_ERROR.EHALL_HANDSHAKE_FAILED, error.message, {
        hint: '课表接口需要先完成 jwapp 应用授权握手（应用页 → getAppConfig → appInit）才会返回数据；这不是登录过期。',
        step: details.step ?? null,
        handshake: details.handshake ?? null,
      });
    case TIMETABLE_ERROR.EHALL_ERROR:
    default:
      return new HttpError(502, TIMETABLE_ERROR.EHALL_ERROR, error.message, {
        code: TIMETABLE_ERROR.EHALL_ERROR,
        // 只回路径 / 状态 / 上游 code，**不回上游 HTML**（见 api.js 的说明）。
        path: details.path ?? null,
        status: details.status ?? null,
        upstreamCode: details.code ?? null,
      });
  }
}

const guard = (handler) => async (ctx) => {
  try {
    return await handler(ctx);
  } catch (error) {
    const translated = translateTimetableError(error);
    if (translated) throw translated;
    throw error;
  }
};

export function registerTimetableRoutes(router, { timetable, apiPrefix }) {
  if (!timetable) return;
  const P = `${apiPrefix}/timetable`;

  // ---------------------------------------------------------------- 状态
  // `?probe=1` 让服务层主动重试一次站点认证（页面上的「刷新状态」用它），
  // 不带时保持「只读本地状态」，未登录用户打开页面不会被强跳登录页。
  router.get(`${P}/status`, guard(({ query }) => timetable.status({ probe: asBool(query?.probe) })));

  // ---------------------------------------------------------------- 预览
  router.get(
    `${P}/preview`,
    guard(({ query }) => timetable.preview(normalizeTerm(query?.term), { refresh: asBool(query?.refresh) })),
  );

  // ---------------------------------------------------------------- 导入
  router.post(
    `${P}/import`,
    guard(({ body }) =>
      timetable.importCourses({
        term: normalizeTerm(body?.term),
        courseIds: normalizeCourseIds(body?.courseIds),
        untilWeek: body?.untilWeek,
      }),
    ),
  );

  // ---------------------------------------------------------------- 删除
  router.post(
    `${P}/remove`,
    guard(({ body }) =>
      timetable.remove({
        term: normalizeTerm(body?.term),
        courseIds: normalizeCourseIds(body?.courseIds),
        all: asBool(body?.all),
      }),
    ),
  );

  // ---------------------------------------------------------------- 已导入
  router.get(`${P}/imported`, guard(({ query }) => timetable.imported(normalizeTerm(query?.term))));
}
