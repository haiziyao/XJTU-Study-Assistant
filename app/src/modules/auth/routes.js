/**
 * 全局统一身份认证的路由，挂在 `/api/v1/auth` 下。
 *
 * 与 `lms` / `academic` 的关系：那两个模块**保留**自己的登录端点（转发到本模块），
 * 以免破坏既有前端与测试；新代码应当只用这里的端点。
 *
 * 错误翻译原则与学业模块一致：认证类失败要**说清是"需要登录"还是"上游出问题"**，
 * 因为前端据此决定弹登录框还是报故障。
 */

import { ERROR_CODES } from '../../shared/constants.js';
import { HttpError } from '../../core/http/router.js';
import { AUTH_ERROR, AuthError } from './config.js';

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw HttpError.badRequest(`字段 ${field} 必填`, { field });
  }
  return value.trim();
}

function asBool(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

/** 把 AuthError 翻成 HTTP 错误。 */
export function translateAuthError(error) {
  if (error instanceof HttpError) return error;
  if (!(error instanceof AuthError)) return undefined;
  switch (error.code) {
    case AUTH_ERROR.NEED_CREDENTIALS:
      return new HttpError(400, ERROR_CODES.BAD_REQUEST, error.message, { code: error.code });
    case AUTH_ERROR.UNKNOWN_SITE:
      return new HttpError(404, ERROR_CODES.NOT_FOUND, error.message, { code: error.code });
    case AUTH_ERROR.NO_SITE:
      return new HttpError(500, ERROR_CODES.INTERNAL, error.message, { code: error.code });
    case AUTH_ERROR.NEEDS_LOGIN:
      return new HttpError(401, ERROR_CODES.UNAUTHORIZED, error.message, { code: error.code });
    default:
      return new HttpError(502, ERROR_CODES.UPSTREAM_ERROR, error.message, { code: error.code });
  }
}

const guard = (handler) => async (ctx) => {
  try {
    return await handler(ctx);
  } catch (error) {
    const translated = translateAuthError(error);
    if (translated) throw translated;
    throw error;
  }
};

export function registerAuthRoutes(router, { auth, apiPrefix }) {
  if (!auth) return;
  const P = `${apiPrefix}/auth`;

  router.get(`${P}/status`, () => auth.status());

  router.post(
    `${P}/login`,
    guard(async ({ body }) => {
      const username = requireText(body?.username, 'username');
      const password = requireText(body?.password, 'password');
      return auth.login({
        username,
        password,
        captcha: typeof body?.captcha === 'string' ? body.captcha.trim() : undefined,
        trustAgent: body?.trustAgent === undefined ? true : asBool(body.trustAgent),
        siteId: typeof body?.siteId === 'string' && body.siteId ? body.siteId : undefined,
      });
    }),
  );

  router.post(`${P}/mfa/send`, guard(() => auth.sendMfaCode()));

  router.post(
    `${P}/mfa/verify`,
    guard(async ({ body }) => auth.verifyMfaCode(requireText(body?.code, 'code'))),
  );

  router.get(
    `${P}/captcha`,
    guard(async () => {
      const { bytes, contentType } = await auth.captcha();
      return { __raw: { contentType, body: Buffer.from(bytes) } };
    }),
  );

  router.post(`${P}/logout`, guard(() => auth.logout()));

  /**
   * 单个站点的状态与"能否用"。
   * 给界面做「学堂 ✓ / 教务 未登录」这类逐站点展示，也给排障用。
   */
  router.get(`${P}/sites/:id`, ({ params }) => {
    if (!auth.hasSite(params.id)) throw HttpError.notFound(`站点 ${params.id} 未注册`);
    return auth.siteStatus(params.id);
  });

  /** 主动触发某站点的认证（SSO 静默重建，或告诉前端"它需要登录"）。 */
  router.post(
    `${P}/sites/:id/ensure`,
    guard(async ({ params, body }) => {
      if (!auth.hasSite(params.id)) throw HttpError.notFound(`站点 ${params.id} 未注册`);
      return auth.ensure(params.id, { revalidate: asBool(body?.revalidate) });
    }),
  );

  /** 只为某站点单独登录（SSO 不适用于该站点时的兜底路径；用的还是同一份账号密码）。 */
  router.post(
    `${P}/sites/:id/login`,
    guard(async ({ params, body }) => {
      if (!auth.hasSite(params.id)) throw HttpError.notFound(`站点 ${params.id} 未注册`);
      const username = requireText(body?.username, 'username');
      const password = requireText(body?.password, 'password');
      return auth.login({
        username,
        password,
        captcha: typeof body?.captcha === 'string' ? body.captcha.trim() : undefined,
        trustAgent: body?.trustAgent === undefined ? true : asBool(body.trustAgent),
        siteId: params.id,
      });
    }),
  );
}
