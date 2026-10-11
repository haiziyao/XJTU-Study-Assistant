/**
 * 学业情况模块的路由，全部挂在 `/api/v1/academic` 下。
 *
 * 约定（与学堂模块保持一致）：
 * - 写操作先预览后应用：`/sync/preview` 只读、`/sync/apply` 才落库；
 * - 未登录统一 401 `UNAUTHORIZED`，前端据此弹登录框；
 * - 上游错误按 `AcademicError.code` 翻译成合适的状态码与文案 ——
 *   尤其是 **403 必须说清是"授权握手失败"**，否则会被误读成"接口变了"或"没权限"，
 *   那样排查方向就全错了。
 */

import { ERROR_CODES } from '../../shared/constants.js';
import { HttpError } from '../../core/http/router.js';
import { ACADEMIC_ERROR } from './api.js';

const MAX_BULK_IDS = 2000;

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw HttpError.badRequest(`字段 ${field} 必填`, { field });
  }
  return value.trim();
}

function asBool(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

/** 空串 / undefined 都当"没传"，避免 ?term= 把结果过滤成空。 */
function optionalText(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
}

function normalizeIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw HttpError.badRequest('字段 ids 必须是数组');
  if (value.length > MAX_BULK_IDS) throw HttpError.badRequest(`字段 ids 最多 ${MAX_BULK_IDS} 项`);
  return value.map((item) => String(item));
}

/**
 * 把服务层抛出的 `AcademicError` 翻译成 HTTP 错误。
 *
 * 这张映射表是"错误信息有没有用"的关键：
 * - 401 → 前端弹登录框；
 * - 403 → 明确告诉用户/开发者是**握手**问题，并附上握手诊断；
 * - 上游结构变了 → 502，提示可能改版，而不是 500。
 */
export function translateAcademicError(error) {
  if (error instanceof HttpError) return error;
  const code = error?.code;
  const message = error?.message ?? '学业模块请求失败';
  // 本地产生的业务错误（如"记录不存在"）自带合适的状态码，要保住它；
  // 只有真正来自上游的失败才报 502。
  const own = Number(error?.status) || 0;
  const localStatus = own >= 400 && own < 500 ? own : 0;

  switch (code) {
    case ACADEMIC_ERROR.NOT_LOGGED_IN:
      return new HttpError(own || 401, ERROR_CODES.UNAUTHORIZED, message, { code });
    case ACADEMIC_ERROR.HANDSHAKE_FAILED:
      return new HttpError(502, ERROR_CODES.UPSTREAM_ERROR, message, {
        code,
        hint: '成绩接口需要先完成应用授权握手（getAppConfig + 应用初始化）才会返回数据。',
        handshake: error.details ?? null,
      });
    case ACADEMIC_ERROR.INTERFACE_CHANGED:
    case ACADEMIC_ERROR.BUSINESS_ERROR:
      if (localStatus) {
        return new HttpError(localStatus, localStatus === 404 ? ERROR_CODES.NOT_FOUND : ERROR_CODES.BAD_REQUEST, message, { code });
      }
      return new HttpError(502, ERROR_CODES.UPSTREAM_ERROR, message, { code, details: error.details ?? null });
    case ACADEMIC_ERROR.NETWORK:
      return new HttpError(502, ERROR_CODES.UPSTREAM_ERROR, message, { code });
    default:
      return undefined; // 交给上层按普通异常处理
  }
}

/** 把 async 处理器里的 AcademicError 包装成 HTTP 错误。 */
const guard = (handler) => async (ctx) => {
  try {
    return await handler(ctx);
  } catch (error) {
    const translated = translateAcademicError(error);
    if (translated) throw translated;
    throw error;
  }
};

export function registerAcademicRoutes(router, { academic, apiPrefix }) {
  if (!academic) return;
  const P = `${apiPrefix}/academic`;

  // ---------------------------------------------------------------- 状态与登录

  router.get(`${P}/status`, () => academic.status());

  router.post(
    `${P}/login`,
    guard(async ({ body }) => {
      const username = requireText(body?.username, 'username');
      const password = requireText(body?.password, 'password');
      const captcha = optionalText(body?.captcha);
      const result = await academic.login({
        username,
        password,
        captcha,
        trustAgent: body?.trustAgent === undefined ? true : asBool(body.trustAgent),
      });
      // 登录即顺手同步一次：用户点"登录"的意图本来就是"让我看到成绩"
      if (result?.status === 'ready' && body?.sync !== false) {
        try {
          const synced = await academic.sync();
          // ★ 重新读一次状态：握手是在 sync 里才做的，若直接用登录那一刻的 status()，
          //   返回的 handshake 会是空的（appId=null），看日志的人会以为握手没成功。
          return {
            ...academic.status(),
            synced: { counts: synced.counts, gpa: synced.stats.gpa, handshake: synced.handshake },
          };
        } catch (error) {
          // 同步失败不该让"登录成功"变成失败：把原因带回去让界面提示
          const translated = translateAcademicError(error);
          return { ...result, syncError: { message: translated?.message ?? error.message, code: error.code ?? null } };
        }
      }
      return result;
    }),
  );

  router.post(`${P}/mfa/send`, guard(() => academic.sendMfaCode()));

  router.post(
    `${P}/mfa/verify`,
    guard(async ({ body }) => {
      const code = requireText(body?.code, 'code');
      return academic.verifyMfaCode(code);
    }),
  );

  router.get(
    `${P}/captcha`,
    guard(async () => {
      const { bytes, contentType } = await academic.captcha();
      return { __raw: { contentType, body: Buffer.from(bytes) } };
    }),
  );

  router.post(`${P}/logout`, guard(() => academic.logout()));

  // ---------------------------------------------------------------- 同步

  router.post(`${P}/sync/preview`, guard(() => academic.sync({ dryRun: true })));
  router.post(`${P}/sync/apply`, guard(() => academic.sync()));

  // ---------------------------------------------------------------- 成绩

  /**
   * 成绩列表。
   *
   * ⚠️ 必须返回 `{ items, count }` 而不是裸数组 —— 路由层会把返回值展开成
   * `{ ok: true, ...result }`，裸数组展开后会变成 `{"0":…,"1":…}` 这种带数字键的对象，
   * 前端拿到的就不是数组了（这个坑踩过一次）。
   */
  router.get(`${P}/grades`, ({ query }) => {
    const items = academic.listGrades({
      term: optionalText(query?.term),
      nature: optionalText(query?.nature),
      included: query?.included === undefined || query.included === '' ? undefined : asBool(query.included),
      includeStale: query?.includeStale === undefined ? true : asBool(query.includeStale),
    });
    return { items, count: items.length };
  });

  router.get(`${P}/stats`, ({ query }) =>
    academic.stats({
      term: optionalText(query?.term),
      nature: optionalText(query?.nature),
      included: query?.included === undefined || query.included === '' ? undefined : asBool(query.included),
    }),
  );

  /** 题面里说的「每一项成绩都是可选的」—— 单项开关。 */
  router.post(
    `${P}/grades/:id/included`,
    guard(async ({ params, body }) => {
      const included = asBool(body?.included);
      const updated = await academic.setIncluded(params.id, included);
      return { grade: updated, stats: academic.stats() };
    }),
  );

  /** 批量开关：可以给显式 ids，也可以给 term / only 预设。 */
  router.post(
    `${P}/grades/included/bulk`,
    guard(async ({ body }) => {
      const included = asBool(body?.included);
      const result = await academic.setIncludedBulk({
        ids: normalizeIds(body?.ids),
        term: optionalText(body?.term),
        only: optionalText(body?.only),
        included,
      });
      return { ...result, stats: academic.stats() };
    }),
  );

  /** 一键恢复"同步时的默认纳入状态"（能算出绩点的纳入、算不出的不纳入）。 */
  router.post(
    `${P}/grades/included/reset`,
    guard(async () => {
      const result = await academic.resetIncluded();
      return { ...result, stats: academic.stats() };
    }),
  );

  /** 学期清单：界面用它渲染筛选项。 */
  router.get(`${P}/terms`, () => {
    const seen = new Map();
    for (const grade of academic.store.academicGrades.all()) {
      if (!grade.term) continue;
      if (!seen.has(grade.term)) seen.set(grade.term, { term: grade.term, label: grade.termLabel ?? grade.term, courses: 0 });
      seen.get(grade.term).courses += 1;
    }
    const items = [...seen.values()].sort((a, b) => String(b.term).localeCompare(String(a.term)));
    return { items, count: items.length };
  });

  // ---------------------------------------------------------------- 学情分析

  /** 读取已存的分析。`stale` 表示成绩/勾选已经变了、这段结论不再代表现状。 */
  router.get(`${P}/analysis`, guard(() => academic.analysisState()));

  /**
   * 生成分析。
   *
   * 同步完成或用户改了纳入开关后，界面调它拿一段新的点评；
   * 数据没变时会直接命中缓存（除非带 `force: true`）。
   */
  router.post(
    `${P}/analysis`,
    guard(async ({ body }) => academic.analyze({ force: asBool(body?.force) })),
  );
}
