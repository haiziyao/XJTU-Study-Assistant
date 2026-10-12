/**
 * 局域网网关（挂在**传输模块自己那个 8886 设备服务器**上）。
 *
 * 要解决的问题：主服务只监听 `127.0.0.1`（刻意的安全默认），手机打开
 * `http://<电脑IP>:3210/app` 必然连不上 —— 回环地址在手机上指向手机自己。
 * 于是「手机/平板用这个程序」在 iOS 壳与 PWA 上都卡在同一个前置问题上：
 * **局域网里没有任何一个入口**。
 *
 * 为什么挂在 8886 而不是新开一个端口、也不改主服务：
 *   1. `src/core/**` 与 `src/server/**` 不许改（硬约束），而且"主服务只听本机"这个
 *      安全默认本身是对的，不该为了手机把它改成 0.0.0.0；
 *   2. 8886 本来就是**唯一一个局域网可达**的口子（设备直传用），网关开在它上面，
 *      对外暴露的面依旧只有这一个端口，用户关掉开关就彻底消失；
 *   3. 一个端口 = 一个来源，手机上只需记住 `http://<电脑IP>:8886/app`。
 *
 * 网关提供三件事（都要求局域网令牌，见下）：
 *   1. `GET /app/**`  —— 静态托管 `src/renderer/**`（前端本体，`index.html` 是目录默认页）；
 *   2. 反向代理 `/api/**` —— 转发到 `127.0.0.1:<主服务端口>`（方法/查询串/请求体/头逐项透传，管道流式）；
 *   3. WebSocket 代理 `/ws` —— 在 `upgrade` 事件里把 socket 双向接到后端，否则手机上的
 *      AI 流式回复与 `data_changed` 推送全是坏的（页面能开、数据不动，最难排查的那种"半坏"）。
 *
 * 鉴权（**关键**：网关不能把整台机器的接口裸奔在局域网上）：
 *   - 门票就是「传输」页上那个 6 位配对码：`GET /app?code=123456`
 *     → 校验通过后种一个 HttpOnly Cookie（`potato_lan=<token>`，有效期与传输 token 一致 30 分钟）
 *     → `302` 到 `/app/`（把 code 从地址栏与历史里去掉）；
 *   - 之后 `/app/**`、`/api/**`、`/ws` 都要令牌：Cookie 优先，其次 `X-Potato-Lan-Token` 头
 *     （给 `.ipa` 壳、curl 与调试用；WebSocket 额外允许 `?lan_token=`，原因见 `#authenticate`）；
 *   - **没有另外发明一套限流**：错码计数与"错 5 次锁 60 秒"走 `TransferService.verifyCode()`
 *     那一份实现（两份拷贝迟早在"锁定期内正确码也要拒"这类细节上分叉）；
 *     令牌本身错/过期**不计入**失败次数 —— 那是"过期"不是"猜码"，计进去只会让正常用户被锁。
 *
 * 超时的取舍（为什么不是"一刀切 30 秒"）：
 *   - 30 秒只盖到**响应头回来之前**（连不上、对面卡住不答，都要让手机看到一个明确的错误，
 *     而不是一个永远转圈的连接）；
 *   - 响应开始之后改成**空闲超时**（同样 30 秒，每来一块数据就重置）；
 *   - `text/event-stream`（SSE）与 WebSocket **完全豁免**：AI 流式回复可能几十秒才吐一个字，
 *     用总时长把它掐掉，表现就是"AI 偶尔答一半就没声了"，比不设超时更糟。
 *
 * 失败形状与主服务一致：`{ ok:false, error:{ code, message, details? } }`。
 * 这里自己写了一份最小的 `sendJson`/`sendError`（不 import `service.js`），
 * 是为了**避免 service ⇄ gateway 的循环依赖**；形状与主服务的 `sendError` 对齐。
 */

import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { API_PREFIX, DEFAULT_HOST, DEFAULT_PORT, ERROR_CODES, WS_PATH } from '../../shared/constants.js';
import { HttpError } from '../../core/http/router.js';
import { contentTypeOf, resolveInside } from '../../core/http/static.js';
import { TOKEN_TTL_MS } from './protocol.js';

/** 网关的 URL 前缀（与桌面端主服务一致，前端里的相对路径才不用分叉）。 */
export const GATEWAY_PREFIX = '/app';
/** API 根：`API_PREFIX` 是 `/api/v1`，网关按 `/api/**` 整片代理（将来 v2 也不用改）。 */
const API_ROOT = '/api';
/** 局域网令牌的 Cookie 名。 */
export const GATEWAY_COOKIE = 'potato_lan';
/** 局域网令牌的请求头（给 `.ipa` 壳与 curl 用）。 */
export const GATEWAY_TOKEN_HEADER = 'x-potato-lan-token';
/** WebSocket 升级专用的查询参数（浏览器无法给 WebSocket 设请求头，见 `#authenticate`）。 */
const GATEWAY_QUERY_TOKEN = 'lan_token';

/** 代理超时上限（见文件头"超时的取舍"）。 */
export const UPSTREAM_TIMEOUT_MS = 30 * 1000;
/** 探测主服务端口时的单次超时：只连本机，给 400ms 已经非常宽裕。 */
const PROBE_TIMEOUT_MS = 400;
/** 主服务端口猜不到时扫多少个：Electron 启动时从 3210 起最多 +9（见 src/main/main.cjs）。 */
const PORT_SCAN_LIMIT = 10;
/** 局域网令牌上限（只为不无限增长；见 `#issueToken`）。 */
const GATEWAY_TOKEN_LIMIT = 64;

/** 渲染层目录：网关托管的就是桌面端测试窗口同一份文件（新增前端文件不必改这里）。 */
const RENDERER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'renderer');

/** 逐跳头（RFC 7230 §6.1）：属于"这一段连接"的，不能透传。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const STATUS_TEXT = { 401: 'Unauthorized', 404: 'Not Found', 429: 'Too Many Requests', 502: 'Bad Gateway', 504: 'Gateway Timeout' };

/* ---------------------------------------------------------------- 小工具 */

/** HTML 转义：说明页里会嵌入错误文案（目前都是我们自己写的字符串，仍然照转不误）。 */
const escapeHtml = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

/** 回 JSON（与主服务同形状；网关自己的最小实现，见文件头）。 */
function sendJson(res, status, payload) {
  // 流式响应已经发出去之后就不能再改状态码/头了（代理中途失败的那条路径靠这里兜底）
  if (res.writableEnded || res.headersSent) return;
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 回错误（`{ ok:false, error:{ code, message, details? } }`）。 */
function sendError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : ERROR_CODES.INTERNAL;
  const payload = { ok: false, error: { code, message: error?.message ?? '网关内部错误' } };
  if (error instanceof HttpError && error.details !== undefined) payload.error.details = error.details;
  sendJson(res, status, payload);
}

/** 已经升级成裸 socket 的连接上没法用 res，只能手写一行 HTTP 响应。 */
function writeSocketJson(socket, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  socket.write(
    [
      `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`,
      'Content-Type: application/json; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Cache-Control: no-store',
      'Connection: close',
      '',
      body,
    ].join('\r\n'),
  );
  socket.end();
}

/** 从 Cookie 头里取一个值（不引依赖，只做这一件事）。 */
function cookieValue(req, name) {
  const raw = req?.headers?.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim() || null;
  }
  return null;
}

/** 设备标签：让用户在「传输」页能分辨"这是哪台手机"。 */
function deviceLabelOf(req) {
  const ua = String(req?.headers?.['user-agent'] ?? '');
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS 设备';
  if (/Android/i.test(ua)) return 'Android 设备';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac 上的浏览器';
  if (/Windows/i.test(ua)) return 'Windows 上的浏览器';
  if (!ua) return '命令行客户端';
  return '浏览器';
}

/* ---------------------------------------------------------------- 说明页 */

/**
 * 「需要一个 6 位配对码」的极简说明页。
 *
 * 为什么不用前端页面本身来提示：这一页必须在**没有任何令牌**时就能看，
 * 而 `src/renderer/**` 的所有资源都是要令牌的 —— 白屏（或一个转圈的加载态）
 * 会让用户以为程序坏了，而不是"我少输了一个码"。所以这一页**完全由网关内联生成**：
 * 无脚本、无外部资源、只带 6 行内联样式，且不发 CSP 之外的任何东西。
 */
function gatePageHtml({ message = null, tone = 'warn' } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>需要一个 6 位配对码 · AI 智学</title>
    <style>
      :root { color-scheme: dark light; }
      body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
             background: #16161a; color: #eceff4; font: 16px/1.7 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
      main { width: min(30rem, 88vw); padding: 1.75rem; border: 1px solid #33333c; border-radius: 14px; background: #1d1d22; }
      h1 { margin: 0 0 0.75rem; font-size: 1.15rem; }
      p { margin: 0.5rem 0; color: #b9bcc6; }
      form { display: flex; gap: 0.5rem; margin: 1rem 0 0.75rem; }
      input { flex: 1; min-width: 0; padding: 0.7rem 0.8rem; font-size: 1.25rem; letter-spacing: 0.25em; text-align: center;
              border: 1px solid #43434f; border-radius: 10px; background: #121216; color: inherit; }
      button { padding: 0.7rem 1.1rem; font-size: 1rem; border: 0; border-radius: 10px; background: #4f7cf7; color: #fff; }
      .note { font-size: 0.82rem; color: #8b8e99; }
      .warn { color: #ffcf70; }
      .fail { color: #ff8b8b; }
    </style>
  </head>
  <body>
    <main>
      <h1>需要一个 6 位配对码</h1>
      <p>这个地址只对拿到配对码的人开放。请在<b>电脑端</b>打开「传输」页，把上面显示的 6 位数字填进来。</p>
      <form method="get" action="${GATEWAY_PREFIX}">
        <input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code"
               placeholder="6 位数字" aria-label="6 位配对码" autofocus required />
        <button type="submit">进入</button>
      </form>
      ${message ? `<p class="${tone === 'fail' ? 'fail' : 'warn'}">${escapeHtml(message)}</p>` : ''}
      <p class="note">配对码 10 分钟有效、错 5 次锁 60 秒。进入后这台设备可以打开本程序（令牌 30 分钟有效，过期重新输码即可）。</p>
      <p class="note">能看到这一页说明网关已经打开；如果电脑上关掉了「允许手机/平板在局域网内打开本程序」，这个地址会立刻失效。</p>
    </main>
  </body>
</html>
`;
}

/** 回说明页（纯 HTML，状态码如实反映"没通过鉴权"）。 */
function sendGatePage(res, { status = 401, message = null, tone = 'warn' } = {}) {
  if (res.writableEnded) return;
  const body = gatePageHtml({ message, tone });
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    // 故意**不**发 WWW-Authenticate：那会让 iOS 弹一个系统级账号密码框，
    // 而这里的门票是配对码，弹错东西比不弹更让人困惑。
  });
  res.end(body);
}

/* ---------------------------------------------------------------- 网关本体 */

export class LanGateway {
  /**
   * @param {object} options
   * @param {object} options.transfer               TransferService（借用配对码校验、端口与 info）
   * @param {object} [options.options]              模块配置切片 `.transfer.gateway`
   * @param {string} [options.rendererDir]          托管的渲染层根目录（测试可换）
   * @param {object} [options.logger]
   */
  constructor({ transfer, options = {}, rendererDir = RENDERER_DIR, logger = console } = {}) {
    this.transfer = transfer;
    this.logger = logger;
    this.rendererDir = path.resolve(rendererDir);
    this.config = options ?? {};

    /** 默认**关**：这是"把本机数据放到局域网上"的开关，必须由用户显式打开。 */
    this.enabled = this.config.enabled === true;
    this.timeoutMs = Number(this.config.timeoutMs) > 0 ? Number(this.config.timeoutMs) : UPSTREAM_TIMEOUT_MS;
    // 令牌有效期与传输 token 一致（同一个数字只有一个出处：protocol.js 的 TOKEN_TTL_MS）
    this.tokenTtlMs = Number(this.config.tokenTtlMs) > 0 ? Number(this.config.tokenTtlMs) : (Number(transfer?.tokenTtlMs) > 0 ? Number(transfer.tokenTtlMs) : TOKEN_TTL_MS);

    /** 显式指定的上游（测试与排查用）；没给就自己认（见 `#resolveUpstream`）。 */
    this.explicitUpstream = this.#parseUpstream(this.config);
    /** token -> { token, label, ip, issuedAt, expiresAt } */
    this.tokens = new Map();
    /** 已解析的上游（缓存；显式配置时直接落定，否则首次请求时探测）。 */
    this.upstream = this.explicitUpstream ? { ...this.explicitUpstream, source: 'config' } : null;
    /** 在飞的 WebSocket 上游连接：`close()` 要能立刻掐断，否则测试进程退不出去。 */
    this.upstreamSockets = new Set();
  }

  /* -------------------------------------------------------------- 开关与状态 */

  setEnabled(flag) {
    const next = Boolean(flag);
    if (next === this.enabled) return this.enabled;
    this.enabled = next;
    if (!next) {
      // 关掉即失效：README 里"关掉网关立刻失效"必须是真的，否则用户会以为关掉了还在裸奔。
      const revoked = this.revokeAll();
      this.#dropUpstreamSockets();
      this.logger?.log?.(`[transfer] 局域网网关已关闭${revoked ? `（同时注销 ${revoked} 个已授权设备）` : ''}`);
    } else {
      this.logger?.log?.('[transfer] 局域网网关已打开：/app、/api、/ws 都需要配对码换来的局域网令牌');
    }
    return this.enabled;
  }

  /** 当前有效的令牌数（过期的顺手清掉）。 */
  tokenCount() {
    this.#sweep();
    return this.tokens.size;
  }

  /** 一键踢掉所有手机（页面上那个「全部注销」）。 */
  revokeAll() {
    const count = this.tokens.size;
    this.tokens.clear();
    return count;
  }

  /** 局域网地址列表（非回环 IPv4）：给「传输」页直接显示/复制。 */
  urls() {
    return lanAddresses().map((address) => `http://${address}:${this.port()}${GATEWAY_PREFIX}`);
  }

  port() {
    return this.transfer?.info?.().port ?? this.transfer?.port ?? null;
  }

  status() {
    this.#sweep();
    const port = this.port();
    return {
      enabled: this.enabled,
      path: GATEWAY_PREFIX,
      port,
      // 地址列表照给（页面上只在开关打开时才显示）：用户"先看地址再决定开不开"是正常顺序
      urls: this.urls(),
      tokenCount: this.tokens.size,
      // 只给"能认人"的部分：完整令牌绝不出现在接口响应里（它等价于门票）
      tokens: [...this.tokens.values()].map((session) => ({
        id: session.token.slice(0, 6),
        label: session.label,
        issuedAt: new Date(session.issuedAt).toISOString(),
        expiresAt: new Date(session.expiresAt).toISOString(),
      })),
      upstream: this.upstream ? { host: this.upstream.host, port: this.upstream.port, source: this.upstream.source } : null,
      timeoutMs: this.timeoutMs,
      tokenTtlMs: this.tokenTtlMs,
      /** 手机端要用的完整入口（含配对码占位）；页面上直接显示这一行。 */
      entry: `http://<电脑IP>:${port}${GATEWAY_PREFIX}?code=xxxxxx`,
    };
  }

  /* -------------------------------------------------------------- 路由归属 */

  /** 这个（未解码的）路径是不是网关的地盘。关着的时候一律不是 —— 于是 8886 上只剩协议 4 条路由。 */
  owns(pathname) {
    if (!this.enabled) return false;
    if (pathname === GATEWAY_PREFIX || pathname.startsWith(`${GATEWAY_PREFIX}/`)) return true;
    if (pathname === API_ROOT || pathname.startsWith(`${API_ROOT}/`)) return true;
    return pathname === WS_PATH;
  }

  /** 升级请求是不是该由网关接（`/ws`）。 */
  ownsUpgrade(req) {
    if (!this.enabled) return false;
    try {
      return new URL(req.url ?? '/', `http://${req.headers?.host ?? '0.0.0.0'}`).pathname === WS_PATH;
    } catch {
      return false;
    }
  }

  /**
   * 处理一个普通 HTTP 请求。路径已经由 `owns()` 判过。
   *
   * 失败一律 `throw HttpError`，由设备服务器的 catch 统一回同形状 JSON —— 只有静态资源
   * 与说明页是自己写的响应（它们不是 JSON）。
   */
  async handle(req, res, url) {
    const pathname = url.pathname;

    if (pathname === WS_PATH) {
      // 普通 HTTP 打到 /ws：与主服务口径一致（426），别让人以为"网关把请求吞了"
      sendJson(res, 426, { ok: false, error: { code: 'UPGRADE_REQUIRED', message: '该路径需要 WebSocket 升级' } });
      return;
    }

    const isApp = pathname === GATEWAY_PREFIX || pathname.startsWith(`${GATEWAY_PREFIX}/`);
    const auth = this.#authenticate(req, url, { allowQueryToken: false });

    if (isApp) {
      // 第 1 步：?code= 是"换门票"，必须在令牌检查之前 —— 否则第一次进来的人永远进不来
      if (url.searchParams.has('code')) {
        this.#handleCodeEntry(req, res, url);
        return;
      }
      if (!auth.session) {
        sendGatePage(res, {
          status: 401,
          message: auth.reason === 'invalid' ? `上次的令牌已失效（${Math.round(this.tokenTtlMs / 60000)} 分钟有效），请重新输入配对码。` : null,
        });
        return;
      }
      await this.#serveStatic(res, url);
      return;
    }

    // `/api/**`：没有令牌一律 401 + 可读 JSON（告诉用户去哪儿看配对码，而不是一句"未授权"）
    if (!auth.session) {
      throw new HttpError(
        401,
        auth.reason === 'invalid' ? 'LAN_TOKEN_INVALID' : 'LAN_TOKEN_REQUIRED',
        auth.reason === 'invalid'
          ? `局域网令牌无效或已过期（${Math.round(this.tokenTtlMs / 60000)} 分钟有效）：${this.#authHint()}`
          : this.#authHint(),
        { hint: this.#authHint() },
      );
    }
    await this.#proxy(req, res);
  }

  /** 提示文案（页面与接口共用一句话，用户在任何地方看到的都是同一个入口）。 */
  #authHint() {
    return `请在电脑端的「传输」页查看配对码，用 http://<电脑IP>:${this.port()}${GATEWAY_PREFIX}?code=xxxxxx 打开`;
  }

  /* -------------------------------------------------------------- 鉴权 */

  /**
   * 取令牌并校验。
   *
   * 三个来源，按可信度排：
   *   1. Cookie（浏览器正常路径：HttpOnly，脚本读不到，页面里也不会出现在 URL 上）；
   *   2. `X-Potato-Lan-Token` 头（`.ipa` 壳、curl、调试；非浏览器客户端更自然）；
   *   3. `?lan_token=`（**只给 WebSocket 升级用**）：浏览器的 WebSocket API 不能自定义请求头，
   *      测试里的 ws 客户端同样不能 —— 而浏览器的正常路径其实是 Cookie（WebSocket 握手会带
   *      同源 Cookie），这一条是给"拿不到 Cookie 的客户端"的兜底。它的代价是令牌可能出现在
   *      访问日志里，所以**只**在 `/ws` 升级这一处放行，普通请求一律不认。
   */
  #authenticate(req, url, { allowQueryToken = false } = {}) {
    const cookie = cookieValue(req, GATEWAY_COOKIE);
    const header = req?.headers?.[GATEWAY_TOKEN_HEADER];
    const query = allowQueryToken ? url?.searchParams?.get(GATEWAY_QUERY_TOKEN) : null;
    const token = String(cookie ?? header ?? query ?? '').trim();
    if (!token) return { session: null, reason: 'missing' };
    const session = this.tokens.get(token);
    if (!session) return { session: null, reason: 'invalid' };
    if (session.expiresAt <= Date.now()) {
      this.tokens.delete(token);
      return { session: null, reason: 'invalid' };
    }
    return { session, reason: null };
  }

  /** 发一张局域网令牌（Cookie 值就是它）。 */
  #issueToken(req) {
    const now = Date.now();
    const token = randomBytes(24).toString('hex');
    const session = {
      token,
      label: deviceLabelOf(req),
      ip: req?.socket?.remoteAddress ?? null,
      userAgent: String(req?.headers?.['user-agent'] ?? '').slice(0, 120),
      issuedAt: now,
      expiresAt: now + this.tokenTtlMs,
    };
    // 上限只为"不无限长"：拿到配对码的人反复输码会不断发新票，30 分钟窗口内不设上限就是内存泄漏。
    // 满了从**最老的**开始丢（Map 保持插入顺序）：还没用上的新票一定比旧票更有用。
    while (this.tokens.size >= GATEWAY_TOKEN_LIMIT) {
      const oldest = this.tokens.keys().next().value;
      this.tokens.delete(oldest);
    }
    this.tokens.set(token, session);
    this.logger?.log?.(`[transfer] 网关：${session.label} 用配对码换到令牌（${Math.round(this.tokenTtlMs / 60000)} 分钟内有效）`);
    return session;
  }

  #cookieHeader(token) {
    // HttpOnly：脚本拿不到（XSS 也偷不走）；SameSite=Lax：够用且不会被 Safari 拒绝；
    // 不加 Secure —— 这是 http://<内网IP>，加了 Secure 浏览器会直接丢掉这个 Cookie。
    return `${GATEWAY_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(this.tokenTtlMs / 1000)}`;
  }

  #sweep() {
    const now = Date.now();
    for (const [token, session] of this.tokens) if (session.expiresAt <= now) this.tokens.delete(token);
  }

  /**
   * `GET /app?code=123456`：用配对码换令牌。
   *
   * 成功 → 种 Cookie + `302` 到 `/app/`（带斜杠：页面里的资源全是相对路径，
   * 少了这个斜杠浏览器会按 `/` 解析成 `/shell/app.js` 而 404）。
   * 失败 → **还是那张说明页**（401/429），并写清"还能试几次 / 锁到什么时候"：
   * 对用户来说这是"输错了"，给他一个空白 JSON 只会让人以为程序坏了。
   */
  #handleCodeEntry(req, res, url) {
    const code = String(url.searchParams.get('code') ?? '').trim();
    try {
      this.transfer.verifyCode(code);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      // 错码 / 锁定：原样复用配对那套计数（这里不另算一次）。剩余次数一并写在页面上 ——
      // 手机上没有控制台，"还能试几次/锁到什么时候"只能在页面上说清楚。
      const details = error.details ?? {};
      const extra = details.attemptsLeft !== undefined ? `（还能试 ${details.attemptsLeft} 次）` : details.locked ? '（已锁定，稍后再试）' : '';
      sendGatePage(res, { status: error.status === 429 ? 429 : 401, message: `${error.message}${extra}`, tone: 'fail' });
      return;
    }

    const session = this.#issueToken(req);
    const rest = new URL(url.toString());
    rest.searchParams.delete('code');
    let location = rest.pathname || `${GATEWAY_PREFIX}/`;
    if (location === GATEWAY_PREFIX || location === `${GATEWAY_PREFIX}/index.html`) location = `${GATEWAY_PREFIX}/`;
    const query = rest.searchParams.toString();
    if (query) location += `?${query}`;

    res.writeHead(302, {
      Location: location,
      'Set-Cookie': this.#cookieHeader(session.token),
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': 0,
      'Cache-Control': 'no-store',
    });
    res.end();
  }

  /* -------------------------------------------------------------- 静态托管 */

  /**
   * `GET /app/**`：把 `src/renderer/**` 原样发出去。
   *
   * 两条硬要求：
   *   - **路径穿越**必须挡住。这里做两层：`decodeURIComponent` 之后（`%2e%2e%2f` 这种
   *     编码过的 `../` 骗不过 WHATWG URL 的规范化，但编码过的 `/` 能），
   *     再用 core 的 `resolveInside()` 判"解析结果是否仍在 renderer 目录内"；
   *   - **MIME 正确 + `Cache-Control: no-store`**：前端更新要立刻生效（桌面端也是这么做的），
   *     否则手机上会一直跑旧代码，改了东西看不到效果是最容易浪费半天的坑。
   *
   * 复用 core/http/static.js 的 `resolveInside` / `contentTypeOf`（**只读复用**，不改 core）。
   */
  async #serveStatic(res, url) {
    /**
     * 裸 `/app` 必须 302 到 `/app/`，**带令牌时也一样**。
     *
     * 为什么这条不能只在"输配对码"那条路上做：已经进过门的手机（Cookie 还在）再从地址栏、
     * 书签或"添加到主屏幕"的图标打开 `http://IP:8886/app`（没有结尾斜杠）时，
     * 页面里的资源都是相对路径（`kit/theme.js`、`shell/shell.css`…），浏览器会以 `/` 为基准
     * 解析成 `/kit/theme.js` → 全部 404 → **HTTP 200 但白屏**，最难排查的那种坏法。
     */
    if (url.pathname === GATEWAY_PREFIX) {
      const query = url.searchParams.toString();
      res.writeHead(302, {
        Location: `${GATEWAY_PREFIX}/${query ? `?${query}` : ''}`,
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': 0,
        'Cache-Control': 'no-store',
      });
      res.end();
      return;
    }

    let decoded;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      throw HttpError.badRequest('静态资源路径不是合法的 URL 编码');
    }
    if (decoded.includes('\0')) throw HttpError.badRequest('静态资源路径包含非法字符');

    let relative = decoded.slice(GATEWAY_PREFIX.length).replace(/^\/+/, '');
    if (!relative || relative.endsWith('/')) relative += 'index.html';

    const file = resolveInside(this.rendererDir, relative);
    if (!file) {
      // 越界：400 而不是"悄悄 404"，排查时能立刻看出是攻击/写错了相对路径
      throw HttpError.badRequest(`静态资源越界：${relative}`);
    }

    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      throw HttpError.notFound(`静态资源不存在：${relative}`);
    }
    let target = file;
    if (stat.isDirectory()) {
      target = path.join(file, 'index.html');
      try {
        stat = await fs.stat(target);
      } catch {
        throw HttpError.notFound(`静态资源不存在：${relative}index.html`);
      }
    }
    let body;
    try {
      body = await fs.readFile(target);
    } catch {
      throw HttpError.notFound(`静态资源不存在：${relative}`);
    }
    if (res.writableEnded) return;
    res.writeHead(200, {
      'Content-Type': contentTypeOf(target),
      'Content-Length': body.length,
      // 前端更新立刻生效（桌面端走 core/http/static.js 也是 no-store）
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  }

  /* -------------------------------------------------------------- 反向代理 */

  /**
   * `/api/**` → `127.0.0.1:<主服务端口>`。
   *
   * 为什么用 pipe 而不是"读完再发"：传输接口里有 2 MB 分片、AI 请求里有大段上下文，
   * 整块读进内存既浪费又会把内存上限变成新的故障点；管道是流式的，大小不敏感。
   *
   * 方法 / 查询串（`req.url` 原样）/ 请求体 / 请求头逐项透传，响应的状态码与头也原样回。
   */
  async #proxy(req, res) {
    const target = await this.#resolveUpstream();
    const headers = {};
    for (const [name, value] of Object.entries(req.headers ?? {})) {
      if (value === undefined) continue;
      if (HOP_BY_HOP.has(name)) continue;
      if (name === 'host') continue;
      // 网关自己的门票不进后端：后端的日志/错误详情里不该出现局域网令牌
      if (name === GATEWAY_TOKEN_HEADER) continue;
      headers[name] = value;
    }
    headers.host = `${target.host}:${target.port}`;

    await new Promise((resolve, reject) => {
      let timer = null;
      let settled = false;
      const clearTimer = () => {
        if (timer) clearTimeout(timer);
        timer = null;
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimer();
        if (error) reject(error);
        else resolve();
      };

      const upstreamReq = http.request(
        { host: target.host, port: target.port, method: req.method, path: req.url ?? '/', headers },
        (upstreamRes) => {
          clearTimer();
          const contentType = String(upstreamRes.headers['content-type'] ?? '');
          const streaming = contentType.startsWith('text/event-stream');
          if (!streaming) {
            // 空闲超时（不是总时长）：每来一块数据就重置 —— 正常的 JSON 一次就到底，
            // 而"慢但在动"的流不会被误杀
            const bump = () => {
              clearTimer();
              timer = setTimeout(() => upstreamRes.destroy(new Error('GATEWAY_IDLE_TIMEOUT')), this.timeoutMs);
              timer.unref?.();
            };
            bump();
            upstreamRes.on('data', bump);
          }
          const responseHeaders = {};
          for (const [name, value] of Object.entries(upstreamRes.headers)) {
            if (value === undefined || HOP_BY_HOP.has(name)) continue;
            responseHeaders[name] = value;
          }
          if (!res.writableEnded) res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
          upstreamRes.on('error', () => {
            // 响应已经开始：没法再改成 JSON 了，只能断开，让前端看到"连接中断"而不是半截数据
            res.destroy();
            finish();
          });
          upstreamRes.pipe(res);
          res.on('close', () => upstreamRes.destroy());
          upstreamRes.on('end', () => finish());
          // 客户端提前断开时 upstreamRes 会被 destroy()（不触发 end）：补一次收尾，
          // 否则这个 Promise 永远不 resolve —— socket 不会漏，但请求生命周期收不干净
          upstreamRes.on('close', () => finish());
        },
      );

      // 请求阶段的超时：只盖到"响应头回来之前"。连不上/对面不回，手机要看到一个明确的错误，
      // 而不是一个永远转圈的连接（SSE 在 `response` 里已经把定时器清掉了）
      timer = setTimeout(() => {
        upstreamReq.destroy(new Error('GATEWAY_TIMEOUT'));
      }, this.timeoutMs);
      timer.unref?.();

      upstreamReq.on('error', (error) => {
        // 上游没起来最常见：把缓存的上游清掉，下次请求重新认（后端可能换了端口重启）
        if (!this.explicitUpstream) this.upstream = null;
        if (res.headersSent) {
          res.destroy();
          finish();
          return;
        }
        if (String(error?.message ?? '').includes('GATEWAY_TIMEOUT')) {
          finish(new HttpError(504, 'GATEWAY_TIMEOUT', `后端 ${Math.round(this.timeoutMs / 1000)} 秒没响应：${target.host}:${target.port}`));
          return;
        }
        if (String(error?.message ?? '').includes('GATEWAY_IDLE_TIMEOUT')) {
          finish(new HttpError(504, 'GATEWAY_TIMEOUT', `后端 ${Math.round(this.timeoutMs / 1000)} 秒没有新数据`));
          return;
        }
        finish(
          new HttpError(502, 'GATEWAY_UPSTREAM_DOWN', `后端没在跑：连不上 ${target.host}:${target.port}（主服务未启动或端口变了）`, {
            upstream: { host: target.host, port: target.port },
          }),
        );
      });

      // 客户端提前断开（手机锁屏、切后台）时别让上游请求悬着
      req.on('aborted', () => upstreamReq.destroy());
      req.on('error', () => upstreamReq.destroy());
      res.on('close', () => {
        if (!res.writableEnded) upstreamReq.destroy();
      });
      req.pipe(upstreamReq);
    });
  }

  /* -------------------------------------------------------------- WebSocket 代理 */

  /**
   * `/ws` 升级：把 socket 双向接到后端。
   *
   * 手写的原因（硬约束）：不许引 `ws` / `http-proxy` 之类依赖，而 `http` 的 `upgrade`
   * 事件已经把"还没被解析的原始 socket + 首次多读出来的 head"交给我们了 ——
   * 把请求行与头原样重写一遍给上游，然后把两个 socket 对插即可。
   * 关键是 **head 不能丢**：客户端可能在握手后立刻发了帧，那部分字节既不在 `req` 里
   * 也不会再触发一次 `data`，丢了就是"连上了但第一帧永远不到"。
   */
  async handleUpgrade(req, socket, head) {
    // 先暂停：解析上游地址是异步的，这期间到达的字节留在内核缓冲里，pipe 时不会丢
    socket.pause();
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers?.host ?? '0.0.0.0'}`);
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }

    const auth = this.#authenticate(req, url, { allowQueryToken: true });
    if (!auth.session) {
      writeSocketJson(socket, 401, {
        ok: false,
        error: {
          code: auth.reason === 'invalid' ? 'LAN_TOKEN_INVALID' : 'LAN_TOKEN_REQUIRED',
          message: this.#authHint(),
          details: { hint: this.#authHint() },
        },
      });
      return;
    }

    let target;
    try {
      target = await this.#resolveUpstream();
    } catch (error) {
      writeSocketJson(socket, 502, { ok: false, error: { code: 'GATEWAY_UPSTREAM_DOWN', message: `后端没在跑：${error?.message ?? error}` } });
      return;
    }
    if (socket.destroyed) return;

    const upstream = net.connect({ host: target.host, port: target.port });
    this.upstreamSockets.add(upstream);
    const cleanup = () => {
      this.upstreamSockets.delete(upstream);
      if (!upstream.destroyed) upstream.destroy();
      if (!socket.destroyed) socket.destroy();
    };

    upstream.on('connect', () => {
      const lines = [`GET ${req.url ?? WS_PATH} HTTP/1.1`, `Host: ${target.host}:${target.port}`];
      for (const [name, value] of Object.entries(req.headers ?? {})) {
        if (name === 'host' || value === undefined) continue;
        lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
      }
      lines.push('', '');
      upstream.write(lines.join('\r\n'));
      if (head?.length) upstream.write(head);
      upstream.setNoDelay(true);
      socket.setNoDelay(true);
      socket.pipe(upstream);
      upstream.pipe(socket);
      // 半关也要收干净：任一端关闭就两边都拆，避免留一个"永远挂着"的 socket
      socket.on('close', cleanup);
      socket.on('error', cleanup);
      upstream.on('close', cleanup);
      upstream.on('error', cleanup);
    });
    upstream.on('error', () => {
      this.upstreamSockets.delete(upstream);
      if (!socket.destroyed) {
        writeSocketJson(socket, 502, {
          ok: false,
          error: { code: 'GATEWAY_UPSTREAM_DOWN', message: `后端没在跑：连不上 ${target.host}:${target.port}` },
        });
      }
    });
  }

  /* -------------------------------------------------------------- 上游地址 */

  /** 显式配置：`{ upstream: 'http://127.0.0.1:3210' }` 或 `{ upstreamHost, upstreamPort }`。 */
  #parseUpstream(config) {
    const raw = typeof config?.upstream === 'string' ? config.upstream.trim() : '';
    if (raw) {
      try {
        const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
        return { host: parsed.hostname || DEFAULT_HOST, port: Number(parsed.port) || DEFAULT_PORT };
      } catch {
        this.logger?.warn?.(`[transfer] gateway.upstream 不是合法地址，已忽略：${raw}`);
      }
    }
    const port = Number(config?.upstreamPort);
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      return { host: String(config?.upstreamHost ?? '').trim() || DEFAULT_HOST, port };
    }
    return null;
  }

  /**
   * 认出主服务的端口。**不写死 3210**，按可信度依次尝试：
   *
   *   1. 显式配置（测试与排查时最省心，也是唯一"指到一个没人监听的端口"的入口）；
   *   2. 环境变量 `POTATO_API_PORT` / `PORT`（`bin/server.js` 就是靠 `PORT` 起服务的）；
   *   3. **本进程自己在监听哪些端口**（`process._getActiveHandles()`）—— 这一步是关键：
   *      Electron 在 3210 被占用时会依次试 3211、3212…，如果直接猜 3210，
   *      手机就会被代理到**另一个实例**上（看到的数据不是这台机器的），
   *      自查能精确命中"我自己"的那个端口；
   *   4. 兜底扫 `3210..3219`（Electron 的候选区间），每个候选都要答出本程序的
   *      `/api/v1/health` 签名才算数；
   *   5. 全都没命中就按默认端口走 —— 请求会以 502（后端没在跑）如实失败。
   *
   * 2/3/4 都要发一次本机 HTTP 探测：只在**用户打开网关之后**发生，目标是 127.0.0.1，
   * 不出网卡、不碰外网。
   */
  async #resolveUpstream() {
    if (this.upstream) return this.upstream;
    if (this.explicitUpstream) {
      this.upstream = { ...this.explicitUpstream, source: 'config' };
      return this.upstream;
    }
    const envPort = Number(process.env.POTATO_API_PORT ?? process.env.PORT);
    if (Number.isInteger(envPort) && envPort > 0 && envPort < 65536) {
      this.upstream = { host: DEFAULT_HOST, port: envPort, source: 'env' };
      return this.upstream;
    }
    const ownPorts = this.#selfListeningPorts().filter((port) => port !== this.port());
    for (const port of ownPorts) {
      if (await this.#probeHealth(port)) {
        this.upstream = { host: DEFAULT_HOST, port, source: 'self' };
        return this.upstream;
      }
    }
    for (let index = 0; index < PORT_SCAN_LIMIT; index += 1) {
      const port = DEFAULT_PORT + index;
      if (ownPorts.includes(port)) continue;
      if (await this.#probeHealth(port)) {
        this.upstream = { host: DEFAULT_HOST, port, source: 'scan' };
        return this.upstream;
      }
    }
    this.upstream = { host: DEFAULT_HOST, port: DEFAULT_PORT, source: 'default' };
    return this.upstream;
  }

  /**
   * 本进程正在监听的端口。
   *
   * `process._getActiveHandles()` 是 Node 的私有 API（故意不写进公开文档），
   * 所以整段都包在 try/catch 里：拿不到就返回空数组，后面的兜底扫描照常工作 ——
   * 这个能力是"更准"，不是"必须"。
   */
  #selfListeningPorts() {
    const ports = new Set();
    let handles = [];
    try {
      handles = process._getActiveHandles?.() ?? [];
    } catch {
      return [];
    }
    for (const handle of handles) {
      try {
        if (!handle || handle.listening !== true || typeof handle.address !== 'function') continue;
        const address = handle.address();
        if (address && typeof address === 'object' && Number.isInteger(address.port) && address.port > 0) ports.add(address.port);
      } catch {
        /* 单个 handle 读不出来不影响其它 */
      }
    }
    return [...ports];
  }

  /** 这个端口上是不是本程序的主服务（认 `/api/v1/health` 的签名，避免认错人）。 */
  #probeHealth(port) {
    return new Promise((resolve) => {
      const req = http.request(
        { host: DEFAULT_HOST, port, path: `${API_PREFIX}/health`, method: 'GET', headers: { 'X-Potato-Gateway-Probe': '1' } },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            try {
              const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              resolve(payload?.ok === true && payload?.status === 'ok' && payload?.websocket?.path === WS_PATH);
            } catch {
              resolve(false);
            }
          });
          res.on('error', () => resolve(false));
        },
      );
      req.setTimeout(PROBE_TIMEOUT_MS, () => req.destroy(new Error('probe timeout')));
      req.on('error', () => resolve(false));
      req.end();
    });
  }

  #dropUpstreamSockets() {
    for (const socket of [...this.upstreamSockets]) {
      this.upstreamSockets.delete(socket);
      socket.destroy();
    }
  }

  /** 关停：注销令牌、掐断在飞的 WebSocket 连接（否则测试进程会挂住）。 */
  close() {
    const revoked = this.revokeAll();
    this.#dropUpstreamSockets();
    this.upstream = this.explicitUpstream ? { ...this.explicitUpstream, source: 'config' } : null;
    return revoked;
  }
}

/**
 * 非回环 IPv4 地址（`http://<这个>:8886/app` 就是手机要打开的地址）。
 * 只看 IPv4：iOS/Android 上的 `http://[fe80::...]` 手输体验极差，而且很多家用路由器
 * 的 IPv6 根本不互通 —— 报一个连不上的地址比不报更糟。
 */
export function lanAddresses() {
  const out = [];
  const interfaces = os.networkInterfaces();
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      // Node ≥18：family 是字符串 'IPv4'（旧版是数字 4，一起认，避免踩版本差异）
      const isIPv4 = entry?.family === 'IPv4' || entry?.family === 4;
      if (!isIPv4 || entry.internal) continue;
      if (!entry.address || out.includes(entry.address)) continue;
      out.push(entry.address);
    }
  }
  return out;
}
