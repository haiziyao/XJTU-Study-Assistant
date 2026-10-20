/**
 * 服务端版（公开网页）宿主：一个端口上同时提供「账号 + 静态页面 + 每用户后端代理」。
 *
 * 结构（`/` 之外的一切都按登录态放行）：
 *   GET  /                未登录 → 公开登录/介绍页；已登录 → 302 到 `/app/`
 *   *    /login/**        公开静态（登录页的 css/js；页面本身零构建、零内联）
 *   *    /auth/**         账号接口（见下；`/auth/config` 公开，其余按登录态）
 *   *    /app/**          **需登录** → `src/renderer/**`（应用页面本体）
 *   *    /api/**          **需登录** → 反向代理到**该账号自己的**后端实例
 *        /ws             **需登录** → WebSocket 代理到同一个实例
 *
 * 为什么把这几件事放在同一个端口、同一个进程里：
 *   - 一个端口 = 一个来源。前端里的相对路径（`kit/theme.js`、`/api/v1/...`、`/ws`）
 *     不用分叉，Cookie 不用跨域（`SameSite=Lax` 就够，不需要 CORS + credentials 那一套）；
 *   - 反代/隧道只需要对着一个端口做转发，部署与排错的复杂度都降一半。
 *
 * 未登录时**什么都不给**：`/api/**` 与 `/ws` 一律 401（不是重定向、不是空 200），
 * `/app/**` 302 回登录页。页面本身也不含任何用户数据 —— 它是一个静态文件，
 * 服务端渲染的部分只有"服务名 + 版本"这两个公开字段（`/auth/config`）。
 */

import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { HttpError } from '../core/http/router.js';
import { AccountStore, SESSION_TTL_MS, publicUser } from './accounts.js';
import { BackendPool } from './backends.js';
import { proxyHttp, proxyUpgrade, writeSocketJson, UPSTREAM_TIMEOUT_MS } from './proxy.js';
import { redirectToDirectory, resolveStaticFile, sendFile, sendHtml } from './static.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..', '..');

/** 默认监听端口（用户可以改，但对外只宣传这一个）。 */
export const WWW_PORT = 8866;
/** 默认账号库目录（相对 package 根）。 */
export const WWW_DIR = 'data-www';
/** 会话 Cookie 名。 */
export const SESSION_COOKIE = 'potato_session';
/** 公开登录页目录。 */
export const PUBLIC_DIR = path.join(HERE, 'public');
/** 应用页面（渲染层）目录。 */
export const RENDERER_DIR = path.join(PACKAGE_ROOT, 'src', 'renderer');
/** 服务端版名称（登录页与 `/auth/config` 用同一个字符串）。 */
export const SERVER_NAME = 'AI 智学';

/** 路由前缀。 */
const AUTH_PREFIX = '/auth';
const LOGIN_PREFIX = '/login';
const APP_PREFIX = '/app';
const API_ROOT = '/api';
const WS_PATH = '/ws';

/** 服务端版**明确禁用**的能力：思源学堂（原因见登录页与 README，也在 403 的 message 里）。 */
const LMS_DISABLED_MESSAGE =
  '服务端版不提供思源学堂（LMS）的登录与同步：那需要把学校账号密码托管在一台公网服务器上，本站不保存也不代持学校凭据。需要学堂同步请使用本地客户端。';

/** 登录页的 CSP：无内联脚本/样式、不允许被嵌框、不允许跨站提交表单之外的动作。 */
const LOGIN_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** 认证请求体上限：账号接口的 body 只有几十字节，给 64KB 已经非常宽裕。 */
const MAX_AUTH_BODY_BYTES = 64 * 1024;

/* ---------------------------------------------------------------- 小工具 */

/** 从 Cookie 头里取一个值（不引依赖，只做这一件事）。 */
export function cookieValue(req, name) {
  const raw = req?.headers?.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim() || null;
  }
  return null;
}

/** 会话 Cookie 的序列化（口径冻结，照契约逐字）。`secure` 只在 HTTPS 反代场景打开。 */
export function sessionCookie(token, { secure = false, maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000) } = {}) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/'];
  if (maxAgeSeconds > 0) parts.push(`Max-Age=${maxAgeSeconds}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** 清 Cookie：值置空 + `Max-Age=0`（只发 `Set-Cookie` 而不删服务端会话是假退出）。 */
export const clearSessionCookie = ({ secure = false } = {}) =>
  [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0', ...(secure ? ['Secure'] : [])].join('; ');

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

/** 成功响应：契约字段原样在顶层，另加项目惯用的 `ok:true`（纯增量，老客户端不受影响）。 */
const ok = (res, status, fields = {}, extraHeaders = {}) => sendJson(res, status, { ok: true, ...fields }, extraHeaders);

/** 失败响应：`{ok:false, error:{code,message,details?}}`（与主服务/网关同一形状）。 */
function fail(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'INTERNAL';
  const payload = { ok: false, error: { code, message: error?.message ?? '服务内部错误' } };
  if (error instanceof HttpError && error.details !== undefined) payload.error.details = error.details;
  sendJson(res, status, payload);
}

/** 读 JSON 请求体（体积上限 + 只接受 JSON，不做 urlencoded 表单解析）。 */
async function readJsonBody(req, limit = MAX_AUTH_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw HttpError.badRequest('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw HttpError.badRequest('请求体不是合法 JSON');
  }
}

/* ---------------------------------------------------------------- 宿主 */

/**
 * @param {object} [options]
 * @param {string} [options.dataDir]      账号库目录（默认 `<package>/data-www`）
 * @param {string} [options.rendererDir]  应用页面目录（默认 `src/renderer`）
 * @param {string} [options.publicDir]    公开登录页目录（默认 `src/www/public`）
 * @param {string} [options.serverName]   登录页显示的服务名
 * @param {string} [options.version]
 * @param {number} [options.idleMs]       后端实例空闲回收阈值（0 = 不回收）
 * @param {boolean} [options.secureCookies] 反代是 HTTPS 时给 Cookie 加 `Secure`
 * @param {boolean} [options.trustProxy]  是否信任 `X-Forwarded-For`（默认**不**信，见下）
 * @param {object} [options.logger]
 */
export function createWwwServer(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? path.join(PACKAGE_ROOT, WWW_DIR));
  const rendererDir = path.resolve(options.rendererDir ?? RENDERER_DIR);
  const publicDir = path.resolve(options.publicDir ?? PUBLIC_DIR);
  const logger = options.logger ?? console;
  const serverName = options.serverName ?? SERVER_NAME;
  const version = options.version ?? '0.2.0';
  const secureCookies = options.secureCookies === true;
  /**
   * 为什么默认**不**信 `X-Forwarded-For`：
   *   登录限速按"IP + 用户名"分桶。反向代理会把真实客户端 IP 放在 XFF 里，用它才准；
   *   但 8866 是普通 HTTP 且可能被直接访问 —— 直连时任何人都能伪造这个头，
   *   于是"每个请求换一个假 IP"就成了绕过限速的万能钥匙。
   *   所以：反代/隧道场景显式打开（`POTATO_WWW_TRUST_PROXY=1`），直连场景保持关闭。
   */
  const trustProxy = options.trustProxy === true;

  const accounts = new AccountStore({ dir: dataDir, logger, now: options.now });
  const backends = new BackendPool({ dataDir, logger, idleMs: options.idleMs });

  /** 登录页 HTML 读一次缓存起来（它是纯静态文件，每次请求读盘毫无必要）。 */
  let loginHtmlCache = null;
  /** 关停标记：`close()` 允许被重复调用（信号处理 + 测试 finally 都可能会调）。 */
  let shutdown = false;

  const clientIp = (req, url) => {
    if (trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
      if (xff) return xff;
    }
    return req.socket?.remoteAddress ?? null;
  };

  const clientUa = (req) => String(req.headers['user-agent'] ?? '').slice(0, 120);

  /**
   * 取本次请求的会话令牌。三个来源（口径冻结）：
   *   1. Cookie（浏览器正常路径；HttpOnly，脚本读不到，也不会出现在 URL 上）；
   *   2. `Authorization: Bearer <token>`（手机客户端最自然的方式）；
   *   3. `X-Potato-Token: <token>`（同上；注意它在本项目主服务里是"本地令牌"的预留位置，
   *      宿主**只在这里解析**，并且**不会**把它透传给用户后端 —— 见 proxy.js 的凭据头过滤）。
   *
   * 另外只对 `/ws` 升级额外接受 `?token=`：浏览器的 WebSocket API 不能自定义请求头，
   * 而某些原生客户端也懒得设头。代价是令牌可能进访问日志，所以**只**在这一个入口放行。
   */
  const tokenOf = (req, url, { allowQuery = false } = {}) => {
    const cookie = cookieValue(req, SESSION_COOKIE);
    if (cookie) return cookie;
    const auth = String(req.headers.authorization ?? '');
    if (/^Bearer\s+/i.test(auth)) {
      const token = auth.replace(/^Bearer\s+/i, '').trim();
      if (token) return token;
    }
    const header = req.headers['x-potato-token'];
    if (header) {
      const token = String(Array.isArray(header) ? header[0] : header).trim();
      if (token) return token;
    }
    if (allowQuery) {
      const query = url?.searchParams?.get('token');
      if (query) return String(query).trim();
    }
    return null;
  };

  /** 解析登录态：返回 `{user, session, token}` 或 `null`。**不抛异常**，由调用方决定回什么。 */
  const sessionOf = (req, url, opts) => {
    const token = tokenOf(req, url, opts);
    if (!token) return null;
    const auth = accounts.authenticate(token);
    return auth ? { ...auth, token } : null;
  };

  const requireSession = (req, url, opts) => {
    const auth = sessionOf(req, url, opts);
    if (!auth) throw new HttpError(401, 'UNAUTHORIZED', '需要先登录：请在 / 登录，或带上会话令牌（Cookie / Authorization: Bearer / X-Potato-Token）');
    return auth;
  };

  const requireAdmin = (req, url) => {
    const auth = requireSession(req, url);
    if (auth.user.role !== 'admin') throw new HttpError(403, 'FORBIDDEN', '只有管理员能管理邀请码');
    return auth;
  };

  /* -------------------------------------------------------------- 账号接口 */

  /**
   * `/auth/**`。
   *
   * 两个不显眼但必要的安全约束：
   *   1. **只接受 JSON 请求体**（`readJsonBody`）。跨站表单只能发 `application/x-www-form-urlencoded`
   *      与 `text/plain`，这里会直接 400；再加上会话 Cookie 是 `SameSite=Lax`（跨站 POST 根本
   *      不带 Cookie），改密码/发邀请码这类写操作就有了两道独立的门，而不用再发明一套 CSRF token；
   *   2. **不在这一层做 CORS**（一条 `Access-Control-Allow-Origin` 都不发）：同源部署不需要它，
   *      发了反而会把"浏览器读不到跨站响应"这层保护拆掉。
   */
  async function handleAuth(req, res, url, pathname) {
    const method = req.method;
    const rest = pathname.slice(AUTH_PREFIX.length) || '/';

    if (method === 'GET' && (rest === '/config' || rest === '/config/')) {
      // 公开：只暴露"这台服务器是什么、支不支持注册、需不需要邀请码"这类非敏感信息
      return ok(res, 200, {
        serverName,
        version,
        registration: 'invite',
        firstUserBecomesAdmin: true,
        features: { lms: false },
      });
    }

    if (method === 'POST' && rest === '/register') {
      const body = await readJsonBody(req);
      const { user, token } = await accounts.register({
        username: body?.username,
        password: body?.password,
        inviteCode: body?.inviteCode ?? body?.invite_code,
        ip: clientIp(req, url),
        ua: clientUa(req),
      });
      return ok(res, 201, { user }, { 'Set-Cookie': sessionCookie(token, { secure: secureCookies }) });
    }

    if (method === 'POST' && rest === '/login') {
      const body = await readJsonBody(req);
      const { user, token } = await accounts.login({
        username: body?.username,
        password: body?.password,
        ip: clientIp(req, url),
        ua: clientUa(req),
      });
      return ok(res, 200, { user }, { 'Set-Cookie': sessionCookie(token, { secure: secureCookies }) });
    }

    if (method === 'POST' && rest === '/logout') {
      const token = tokenOf(req, url);
      // 幂等：没登录也回 200（否则前端"退出"按钮在会话过期时会弹一个没有意义的错误）
      if (token) await accounts.logout(token);
      return ok(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie({ secure: secureCookies }) });
    }

    if (method === 'GET' && rest === '/me') {
      const auth = requireSession(req, url);
      return ok(res, 200, { user: publicUser(auth.user) });
    }

    if (method === 'POST' && rest === '/password') {
      const auth = requireSession(req, url);
      const body = await readJsonBody(req);
      const result = await accounts.changePassword({
        token: auth.token,
        currentPassword: body?.currentPassword ?? body?.current_password,
        newPassword: body?.newPassword ?? body?.new_password,
      });
      return ok(res, 200, { user: result.user, revokedSessions: result.revoked });
    }

    if (rest === '/invites' || rest.startsWith('/invites/')) {
      const auth = requireAdmin(req, url);
      if (method === 'POST' && rest === '/invites') {
        const invite = await accounts.createInvite(auth.user);
        return ok(res, 201, { invite });
      }
      if (method === 'GET' && rest === '/invites') {
        const invites = accounts.listInvites(auth.user);
        // 列表字段名契约没写死：`invites` 与 `items` 同时给（前端任取其一都能跑）
        return ok(res, 200, { invites, items: invites });
      }
      if (method === 'DELETE' && rest.startsWith('/invites/')) {
        // 手工解码：`%zz` 这种坏编码会让 `decodeURIComponent` 抛 URIError，
        // 落到全局错误处理里就变成 500 —— 这里是"路径写错了"，应当是 404
        let inviteId = rest.slice('/invites/'.length);
        try {
          inviteId = decodeURIComponent(inviteId);
        } catch {
          throw HttpError.notFound('邀请码不存在');
        }
        const invite = await accounts.deleteInvite(auth.user, inviteId);
        return ok(res, 200, { invite: { id: invite.id, code: invite.code } });
      }
    }

    throw HttpError.notFound(`未找到账号接口 ${method} ${pathname}`);
  }

  /* -------------------------------------------------------------- 静态 */

  async function loginPageHtml() {
    if (loginHtmlCache === null) {
      loginHtmlCache = await fs.readFile(path.join(publicDir, 'index.html'), 'utf8');
    }
    return loginHtmlCache;
  }

  async function serveLoginPage(res) {
    sendHtml(res, await loginPageHtml(), {
      extraHeaders: { 'Content-Security-Policy': LOGIN_CSP, 'Referrer-Policy': 'no-referrer' },
    });
  }

  async function servePublic(res, url, pathname) {
    let relative = pathname.slice(LOGIN_PREFIX.length).replace(/^\/+/, '');
    if (!relative) relative = 'index.html';
    const { file } = await resolveStaticFile(publicDir, relative, { label: '登录页资源' });
    await sendFile(res, file, {
      extraHeaders: {
        // 登录页的资源也走同一套 CSP：没有内联脚本/样式，所以这条不会把它自己打死
        'Content-Security-Policy': LOGIN_CSP,
        'Referrer-Policy': 'no-referrer',
      },
    });
  }

  /**
   * `/app/**`：**只有登录用户**能拿到应用页面。
   *
   * 裸 `/app` 必须 302 到 `/app/`：页面里的资源全是相对路径（`kit/theme.js`…），
   * 少了结尾斜杠浏览器会以 `/` 为基准解析成 `/kit/theme.js` → 全部 404 →
   * "HTTP 200 但白屏"，最难排查的那种坏法。
   */
  /**
   * 服务端版**放行的视图脚本**（其余全部不下发）。
   *
   * 为什么用白名单而不是黑名单：渲染层的左栏是「脚本一加载就 `PCModules.register` 自我登记」
   * 生成的（见 `renderer/kit/registry.js`），所以**不下发脚本 = 左栏不出现**。
   * 用白名单，以后有人往 `index.html` 里加新视图也不会意外漏进公网版。
   *
   * 只放三个：日历与待办（`calendar.js` 同时管这两块）、对话、对话设置。
   * 与 `backends.js` 的 `DISABLED_MODULE_IDS` 是**同一件事的两半**，改一处必须改另一处：
   * 只砍服务端会留下"点进去 404"的死入口，只砍脚本会留下用不了的接口面。
   */
  const WEB_VISIBLE_VIEWS = [
    'views/calendar.js',
    'views/chat-hub.js',
    'views/chat-settings.js',
  ];

  /**
   * 另外要剔掉的 **shell 层**脚本。
   *
   * `shell/message.js` 不是 `views/` 下的文件，但它同样只干一件事：注册「日志」视图
   * （`PCModules.register({ id: 'message' })`，读 `/audit/log`）。而 `audit` 模块在
   * `DISABLED_MODULE_IDS` 里已经禁用，留着这个入口点进去就是 404。
   * 外壳对它没有依赖（`app.js` 里的 `messages` 全是局部变量），剔掉不影响启动。
   */
  const WEB_HIDDEN_SHELL_SCRIPTS = ['shell/message.js'];

  /** 服务端版会下发的 index.html（按上面两张表裁剪），只算一次。 */
  let appIndexCache = null;

  async function appIndexHtml() {
    if (appIndexCache === null) {
      const raw = await fs.readFile(path.join(rendererDir, 'index.html'), 'utf8');
      appIndexCache = raw
        .split('\n')
        .filter((line) => {
          const hit = line.match(/<script\s[^>]*src="([^"?]+)/);
          if (!hit) return true;
          const src = hit[1];
          // views/** 走白名单；shell/** 只按黑名单剔
          if (src.startsWith('views/')) return WEB_VISIBLE_VIEWS.includes(src);
          return !WEB_HIDDEN_SHELL_SCRIPTS.includes(src);
        })
        .join('\n');
    }
    return appIndexCache;
  }

  async function serveApp(res, url, pathname) {
    if (pathname === APP_PREFIX) {
      redirectToDirectory(res, APP_PREFIX, url.searchParams.toString());
      return;
    }
    let relative = pathname.slice(APP_PREFIX.length).replace(/^\/+/, '');
    if (!relative || relative.endsWith('/')) relative += 'index.html';

    // 应用页外壳要按白名单裁剪后再发；其余静态资源原样发。
    if (relative === 'index.html') {
      sendHtml(res, await appIndexHtml());
      return;
    }

    const { file } = await resolveStaticFile(rendererDir, relative, { label: '应用页面资源' });
    await sendFile(res, file);
  }

  /* -------------------------------------------------------------- 请求分发 */

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    } catch {
      throw HttpError.badRequest('请求路径不合法');
    }
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      throw HttpError.badRequest('请求路径不是合法的 URL 编码');
    }

    if (req.method === 'OPTIONS') {
      // 同源部署不需要 CORS；这里只如实回答"这个路径允许哪些方法"，不发任何放行头
      res.writeHead(204, { Allow: 'GET, POST, DELETE, OPTIONS', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    // 1) 账号接口
    if (pathname === AUTH_PREFIX || pathname.startsWith(`${AUTH_PREFIX}/`)) {
      await handleAuth(req, res, url, pathname);
      return;
    }

    // 2) 公开登录页资源（css/js；页面本身在 `/`）
    if (pathname === LOGIN_PREFIX || pathname.startsWith(`${LOGIN_PREFIX}/`)) {
      await servePublic(res, url, pathname === LOGIN_PREFIX ? `${LOGIN_PREFIX}/index.html` : pathname);
      return;
    }

    // 3) 根路径：按登录态在"登录页"与"应用页面"之间切换
    if (pathname === '/') {
      const auth = sessionOf(req, url);
      if (auth) {
        // 302 而不是直接吐 index.html：应用页面的资源是相对路径，必须落到 `/app/` 下
        res.writeHead(302, { Location: `${APP_PREFIX}/`, 'Cache-Control': 'no-store', 'Content-Length': 0 });
        res.end();
        return;
      }
      await serveLoginPage(res);
      return;
    }

    // 4) 应用页面（渲染层）：未登录一律回登录页，绝不吐出应用外壳
    if (pathname === APP_PREFIX || pathname.startsWith(`${APP_PREFIX}/`)) {
      const auth = sessionOf(req, url);
      if (!auth) {
        res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store', 'Content-Length': 0 });
        res.end();
        return;
      }
      await serveApp(res, url, pathname);
      return;
    }

    // 5) `/ws` 的普通 HTTP 请求：与主服务一致回 426（别让人以为"宿主把请求吞了"）
    if (pathname === WS_PATH) {
      requireSession(req, url);
      sendJson(res, 426, { ok: false, error: { code: 'UPGRADE_REQUIRED', message: '该路径需要 WebSocket 升级' } });
      return;
    }

    // 6) 接口代理
    if (pathname === API_ROOT || pathname.startsWith(`${API_ROOT}/`)) {
      const auth = requireSession(req, url);
      if (pathname === '/api/v1/lms' || pathname.startsWith('/api/v1/lms/')) {
        // 明确禁用比"静默 404"好：客户端能拿到**原因**而不是一个空的 not found
        throw new HttpError(403, 'LMS_DISABLED', LMS_DISABLED_MESSAGE, { feature: 'lms', scope: 'server' });
      }
      let instance;
      try {
        instance = await backends.acquire(auth.user.id);
      } catch (error) {
        // 实例起不来（磁盘满、数据目录权限不对、模块装配失败…）：如实回 502 与原因，
        // 而不是一个 500 "内部错误" —— 用户与服务提供者都需要知道"是他的后端没起来"
        throw new HttpError(502, 'GATEWAY_UPSTREAM_DOWN', `该账号的后端实例起不来：${error.message}`, {
          userId: auth.user.id,
        });
      }
      backends.enter(instance);
      try {
        await proxyHttp(req, res, { target: instance, timeoutMs: options.timeoutMs ?? UPSTREAM_TIMEOUT_MS });
      } finally {
        backends.leave(instance);
      }
      return;
    }

    throw HttpError.notFound(`未找到路径 ${req.method} ${pathname}`);
  }

  /** `/ws` 升级：先验会话，再交给该账号自己的实例。 */
  async function handleUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers?.host ?? '127.0.0.1'}`);
    } catch {
      socket.destroy();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }

    const auth = sessionOf(req, url, { allowQuery: true });
    if (!auth) {
      writeSocketJson(socket, 401, {
        ok: false,
        error: { code: 'UNAUTHORIZED', message: '需要先登录：WebSocket 请带上会话 Cookie，或 ?token=<会话令牌>' },
      });
      return;
    }

    let instance;
    try {
      instance = await backends.acquire(auth.user.id);
    } catch (error) {
      writeSocketJson(socket, 502, { ok: false, error: { code: 'GATEWAY_UPSTREAM_DOWN', message: `该账号的后端实例起不来：${error.message}` } });
      return;
    }
    if (socket.destroyed) return;
    backends.socketOpen(instance);
    await proxyUpgrade(req, socket, head, { target: instance, onClose: () => backends.socketClose(instance) });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (!(error instanceof HttpError)) {
        logger?.error?.('[www] 未预期错误：', error);
      }
      fail(res, error);
    });
  });

  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head).catch((error) => {
      logger?.error?.('[www] 升级失败：', error);
      if (!socket.destroyed) socket.destroy();
    });
  });

  return {
    server,
    accounts,
    backends,
    dataDir,
    rendererDir,
    publicDir,
    serverName,
    version,

    /** 初始化账号库（读盘）。 */
    async init() {
      await accounts.init();
      return this;
    },

    listen({ host = '127.0.0.1', port = WWW_PORT } = {}) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const actual = server.address();
          resolve({ host, port: actual.port, url: `http://${host}:${actual.port}/` });
        });
      });
    },

    /** 关停：先掐掉实例（否则它们监听着的端口会让进程退不出去），再关自己。可重复调用。 */
    async close() {
      if (shutdown) return 0;
      shutdown = true;
      const count = await backends.close();
      await accounts.close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      return count;
    },
  };
}
