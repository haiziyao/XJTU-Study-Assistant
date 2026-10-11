/**
 * 全局统一身份认证的配置。
 *
 * 这里成了**共享 HTTP 客户端的唯一来源**：`userAgent` / `timeoutMs` 只在此处定义一次，
 * 各业务模块不再各自维护（它们以前各自写了一份，值一样但散在三处）。
 *
 * 已实测的事实（见 `scripts/sso-probe.js` 与 docs/接口文档.md §13）：
 * 学校的统一认证底层是 **Keycloak**（`identity1.xjtu.edu.cn` 上的 KEYCLOAK_* 票据），
 * `login.xjtu.edu.cn` 是它的 CAS 门面。学堂走经典 CAS、教务走 OAuth2，
 * 但两者共用同一个 `TGC` —— 所以**共享一个 Cookie 罐就能单点登录**，双向都验过。
 */

/** 线上默认值。 */
export const AUTH_DEFAULTS = Object.freeze({
  /** 统一身份认证站点（2025-07 之后的新认证系统）。 */
  casOrigin: 'https://login.xjtu.edu.cn',
  /** 上报给服务端的浏览器标识；服务端会拒绝脚本默认 UA。 */
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  /** 单次请求超时；登录链路偶发慢响应，给得比普通接口宽一点。 */
  timeoutMs: 25_000,
  /** 会话最多认多久，超过就当没有（强制重新登录）。 */
  sessionMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  /**
   * 用哪个站点做密码登录的默认入口；null = 用第一个注册的站点。
   * 之所以需要它：密码登录必须**经由某个站点的登录 URL** 才能引出 CAS 链，
   * 而不同站点可能是不同的部署（测试里就是两个 mock），所以入口要能指定。
   */
  primarySite: null,
});

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * 解析配置。优先级：显式入参 > 环境变量 > 默认值。
 * 环境变量：PC_AUTH_CAS_ORIGIN / PC_AUTH_TIMEOUT_MS
 */
export function resolveAuthConfig(overrides = {}, env = process.env) {
  const source = isPlainObject(overrides) ? overrides : {};
  const config = { ...AUTH_DEFAULTS, ...source };
  if (!source.casOrigin && env.PC_AUTH_CAS_ORIGIN) config.casOrigin = env.PC_AUTH_CAS_ORIGIN;
  if (!source.timeoutMs && env.PC_AUTH_TIMEOUT_MS) {
    const parsed = Number(env.PC_AUTH_TIMEOUT_MS);
    if (Number.isFinite(parsed) && parsed > 0) config.timeoutMs = parsed;
  }
  config.casOrigin = String(config.casOrigin).replace(/\/+$/, '');
  return config;
}

/** 认证模块的错误码。 */
export const AUTH_ERROR = {
  /** 没有任何已注册的站点 —— 通常是装配顺序错了（auth 必须 order 最小）。 */
  NO_SITE: 'AUTH_NO_SITE',
  /** 缺少账号或密码。 */
  NEED_CREDENTIALS: 'AUTH_NEED_CREDENTIALS',
  /** 该站点未注册。 */
  UNKNOWN_SITE: 'AUTH_UNKNOWN_SITE',
  /** 需要用户去登录（票据过期 / 需要两步验证等）。 */
  NEEDS_LOGIN: 'AUTH_NEEDS_LOGIN',
  /** 上游请求失败。 */
  NETWORK: 'AUTH_NETWORK',
};

export class AuthError extends Error {
  constructor(message, { code = AUTH_ERROR.NETWORK, status = 0, details = null } = {}) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
