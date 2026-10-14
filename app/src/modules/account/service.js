/**
 * 账号模块的服务层：**桌面端 ↔ 公开服务端**之间的那座桥。
 *
 * 为什么必须有这座桥（而不是渲染层直接 fetch 服务器）
 * ---------------------------------------------------
 * 桌面端页面来自 `http://127.0.0.1:3210`（Electron 窗口 / 局域网网关），而公开服务端在
 * `http://localhost:8866` —— 两者**不同源**。渲染层直接去 fetch 会踩两个坑：
 *   1. 服务端版**故意不发任何 CORS 头**（见 server 分支 `src/www/server.js` 的注释：
 *      同源部署不需要它，发了反而会把"浏览器读不到跨站响应"这层保护拆掉），
 *      所以浏览器根本读不到响应；
 *   2. 会话令牌是 `HttpOnly` Cookie，本来就该只存在于 HTTP 层。就算 CORS 放开，
 *      把令牌搬运到页面里也等于把凭据暴露给任何一段能跑在页面里的脚本。
 * 于是：**渲染层只跟我们自己的后端说话，后端再以 Node 的身份去跟服务器说话**。
 *
 * 存了什么、没存什么
 * ------------------
 *   `data/account.json`（0600）只存 `{serverUrl, token, user, loginAt}` ——「我现在是谁」。
 *   它**不是**同步配置：本模块不做任何数据上传/下载，合并规则也还没定。
 *   `GET /account` 绝不回传 token（有测试断言），token 只在服务端内部转发时用到。
 *
 * 服务端版（server 分支）怎么复用
 * ------------------------------
 * 服务端版里页面与 `/auth` **同源**，连桥都不需要——但同一份模块代码照样能跑：
 * 把模块配置的 `defaultServerUrl` 设为空串即可，此时 `serverUrl` 为空 -> 一律走**相对路径**
 * （`new URL('/auth/login', base)` 里空 base 会抛错，所以此处直接拼相对 URL）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { HttpError } from '../../core/http/router.js';

/** 桌面端的默认服务器地址（"本地跑的服务端"）。服务端版通过 options 覆盖成空串（= 同源）。 */
export const DEFAULT_SERVER_URL = 'http://localhost:8866';

/** 会话文件名（`data/` 整个目录已被 .gitignore 覆盖）。 */
export const ACCOUNT_FILE = 'account.json';

/** 凭据文件权限：只有当前用户可读写。 */
const FILE_MODE = 0o600;

/** 请求上游的超时。10 秒足够一次登录往返，又不至于让界面卡到用户以为死机。 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** 会话 Cookie 名（与 server 分支 `src/www/server.js` 的 `SESSION_COOKIE` 一字不差）。 */
export const SESSION_COOKIE = 'potato_session';

/**
 * 上游错误码 -> 中文人话。
 *
 * 为什么不直接把上游的 `error.message` 透传：那是**别人的服务器的文案**，措辞可能泄漏
 * 实现细节（例如"密码连续错误 5 次，已锁定 60 秒"这种）。这里按契约里冻结的错误码
 * 自己组织措辞，认不出来的码统一落到一句通用提示 + HTTP 状态码。
 */
export const ERROR_MESSAGES = {
  BAD_CREDENTIALS: '用户名或密码不对',
  INVITE_INVALID: '邀请码无效或已被使用',
  USER_EXISTS: '这个用户名已经被注册了',
  RATE_LIMITED: '失败次数太多，请等 60 秒再试',
  UNAUTHORIZED: '登录已经过期，请重新登录',
  FORBIDDEN: '这个账号没有权限做这件事',
  NOT_FOUND: '服务器上找不到这个接口（地址对不对？）',
  BAD_REQUEST: '用户名或密码不符合服务器要求（用户名 3–32 位，密码至少 8 位）',
  INTERNAL: '服务器内部出错了，稍后再试',
};

/** 连不上时的措辞（网络层失败：DNS / 拒绝连接 / 超时 / TLS）。 */
export const UNREACHABLE_MESSAGE = '连不上这个服务器（检查地址，或对方没在跑）';

/** 地址栏为空且没有默认值时的措辞。 */
const NO_SERVER_MESSAGE = '请先填服务器地址';

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * 把用户填的地址规格化成 `http://host:port`（无尾斜杠）。
 *
 * 宽容处理：不写协议时补 `http://`（校内/本机服务器基本都是 http，写 https 反而连不上）。
 * @returns {string} 规格化后的地址
 * @throws {HttpError} 地址不是合法 URL 时
 */
export function normalizeServerUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw HttpError.badRequest('服务器地址看起来不对：例如 http://localhost:8866');
  }
  if (!url.hostname) throw HttpError.badRequest('服务器地址看起来不对：例如 http://localhost:8866');
  // 只留 origin：用户可能顺手粘了 `/auth/login` 或查询串，留着会拼出双份路径
  return url.origin;
}

/** 去掉地址尾部的斜杠，返回不带斜杠的基址（空串表示同源）。 */
const trimBase = (serverUrl) => String(serverUrl ?? '').trim().replace(/\/+$/, '');

/**
 * 按基址拼出上游 URL。
 *
 * - 有 base：`new URL('/auth/login', base)` —— 绝对路径，会丢掉 base 里可能存在的子路径
 *   （这正是我们要的：`/auth/**` 挂在服务器根上）；
 * - 无 base（服务端版同源）：直接返回相对路径，交给 fetch 按当前 origin 解析。
 */
export function resolveUpstream(serverUrl, pathname) {
  const base = trimBase(serverUrl);
  if (!base) return pathname;
  try {
    return new URL(pathname, `${base}/`).toString();
  } catch {
    throw HttpError.badRequest('服务器地址看起来不对：例如 http://localhost:8866');
  }
}

/** 从 `Set-Cookie`（可能是数组，也可能只有一个）里取出会话令牌。 */
export function tokenFromSetCookie(header) {
  const values = Array.isArray(header) ? header : header ? [header] : [];
  for (const value of values) {
    for (const part of String(value).split(/,(?=[^;]+?=)/)) {
      const match = part.match(new RegExp(`(?:^|;)\\s*${SESSION_COOKIE}=([^;\\s]+)`));
      if (match?.[1]) return match[1];
    }
  }
  return null;
}

/** 私有 JSON 文件（0600），原子替换 + 写入串行化。 */
class PrivateJsonFile {
  constructor(filePath, { mode = FILE_MODE } = {}) {
    this.filePath = filePath;
    this.mode = mode;
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      // 损坏时不静默覆盖：备份成 .corrupt-<时间>，当作"没登录"继续（不能拖垮启动）
      await fs.rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}`).catch(() => {});
      return null;
    }
  }

  write(data) {
    this.queue = this.queue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: this.mode });
      await fs.rename(tmp, this.filePath);
      // rename 不带权限位，显式再收一次
      await fs.chmod(this.filePath, this.mode).catch(() => {});
    });
    return this.queue;
  }

  remove() {
    this.queue = this.queue.catch(() => {}).then(() => fs.rm(this.filePath, { force: true }));
    return this.queue;
  }
}

/**
 * 账号服务。
 *
 * @param {object} options
 * @param {string} options.dataDir  私有文件目录（`data/account.json` 放这里）
 * @param {string} [options.defaultServerUrl] 面板里预填的地址；空串 = 同源（服务端版）
 * @param {string} [options.origin] 同源模式（`serverUrl` 为空）时用来补全相对路径的基址，
 *   例如 `http://127.0.0.1:8866`。桌面版永远用不到；服务端版把它设成自己的监听地址即可。
 * @param {number} [options.timeoutMs]        上游请求超时
 * @param {Function} [options.fetchImpl]      注入 fetch（测试用）
 * @param {Function} [options.now]            注入时钟（测试固定 loginAt 用）
 */
export class AccountService {
  constructor({ dataDir = process.cwd(), defaultServerUrl = DEFAULT_SERVER_URL, origin = '', timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl, now = () => Date.now(), logger = console } = {}) {
    this.file = new PrivateJsonFile(path.join(dataDir, ACCOUNT_FILE));
    this.defaultServerUrl = String(defaultServerUrl ?? '');
    this.origin = String(origin ?? '') || 'http://127.0.0.1';
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.now = now;
    this.logger = logger;
    /** @type {{serverUrl:string, token:string, user:object, loginAt:string}|null} */
    this.session = null;
  }

  /* ------------------------------------------------------------ 会话存取 */

  /** 启动时读回上次的登录态（损坏/缺失都当作未登录，不抛）。 */
  async load() {
    const saved = await this.file.read();
    this.session = this.#normalizeSession(saved);
    return this;
  }

  #normalizeSession(raw) {
    if (!raw || typeof raw !== 'object' || !raw.token) return null;
    const user = raw.user && typeof raw.user === 'object' ? raw.user : null;
    if (!user?.username) return null;
    return {
      serverUrl: String(raw.serverUrl ?? ''),
      token: String(raw.token),
      user: clone(user),
      loginAt: raw.loginAt ?? new Date(this.now()).toISOString(),
    };
  }

  async #save(session) {
    this.session = session;
    await this.file.write({
      serverUrl: session.serverUrl,
      token: session.token,
      user: session.user,
      loginAt: session.loginAt,
    });
    return session;
  }

  async #clear() {
    this.session = null;
    await this.file.remove();
  }

  /** 面板状态：**绝不包含 token**（凭据不出后端）。 */
  status() {
    if (!this.session) {
      return { connected: false, serverUrl: this.defaultServerUrl, user: null, loginAt: null };
    }
    return {
      connected: true,
      serverUrl: this.session.serverUrl,
      user: clone(this.session.user),
      loginAt: this.session.loginAt,
    };
  }

  /** 最终要用的服务器地址：请求里给的优先，其次上次登录的，最后是默认值。 */
  resolveServerUrl(input) {
    const raw = input === undefined || input === null ? '' : String(input).trim();
    if (raw) return normalizeServerUrl(raw);
    if (this.session?.serverUrl) return this.session.serverUrl;
    return normalizeServerUrl(this.defaultServerUrl);
  }

  /**
   * 这次请求到底有没有服务器可谈。
   *
   * **空 base 是合法的**：它表示"同源"（服务端版里页面与 `/auth` 在同一台服务器上），
   * 实现里走相对路径、由 `origin` 补全。判定顺序：
   *   1. 本次请求带了 serverUrl        -> 有
   *   2. 上次登录记着 serverUrl        -> 有
   *   3. 模块配了非空 defaultServerUrl -> 有
   *   4. 模块把 defaultServerUrl 配成空串 -> **同源模式**，也有（走相对路径）
   *   5. 以上都不是 -> 真的没配服务器
   *
   * @param {object} body 本次请求的 body（可能带了 serverUrl）
   */
  #hasServer(body = {}) {
    const given = body?.serverUrl === undefined || body?.serverUrl === null ? '' : String(body.serverUrl).trim();
    return Boolean(given) || Boolean(this.session?.serverUrl) || this.sameOrigin || Boolean(this.defaultServerUrl);
  }

  /** 模块是否被配成了"同源模式"（`defaultServerUrl` 显式为空串）。 */
  get sameOrigin() {
    return this.defaultServerUrl === '';
  }

  /* ------------------------------------------------------------ 上游请求 */

  /**
   * 调一次上游，返回 `{status, body, token}`。
   *
   * 错误分两层：
   *   - **连不上 / 超时** -> `HttpError` 502 + 中文人话（`UNREACHABLE_MESSAGE`）；
   *   - **上游返回了错误状态** -> 不抛，交给调用方按 `body.error.code` 映射，
   *     这样"登录失败"能拿到 401 语义，而不是被包成 502。
   *
   * `Authorization: Bearer` 与 `X-Potato-Token` 都带上：服务端版三种令牌载体都认
   * （Cookie / Bearer / 头），桌面端起见多发两个头，省得将来换载体又要改这里。
   */
  async #request(serverUrl, pathname, { method = 'GET', body, token } = {}) {
    const url = resolveUpstream(serverUrl, pathname);
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      headers['X-Potato-Token'] = token;
    }
    // 同源模式（`serverUrl` 为空 -> 这里拿到的是相对路径）下 Node 的 fetch 认不出相对 URL。
    // 同源语义是"本进程自己监听的那个地址"，所以用 this.origin 补全；服务端版会在模块配置里
    // 把 origin 设成自己的监听地址，相对路径这一语义因此得以保留。
    //
    // 注意区分两类失败：**地址本身不合法**（用户填错了 -> 400，明确告诉他改地址）与
    // **地址合法但连不上**（-> 502 + "连不上这个服务器"）。若是把前者也吞成后者，
    // 用户会一直以为"服务器没开"，其实只是地址打错了。
    let target = url;
    if (!/^https?:\/\//i.test(url)) {
      try {
        target = new URL(url, this.origin).toString();
      } catch {
        throw HttpError.badRequest('服务器地址看起来不对：例如 http://localhost:8866');
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(target, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (error) {
      // 网络层失败：DNS 解析不了、对方没监听、TLS 失败、超时被 abort……
      // 统一成一句人话，原因留在 details 里给排查用（不进 message）。
      const reason = error?.name === 'AbortError' ? `等待超过 ${Math.round(this.timeoutMs / 1000)} 秒` : error?.message;
      throw new HttpError(502, 'UPSTREAM_UNREACHABLE', UNREACHABLE_MESSAGE, { hint: reason });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text().catch(() => '');
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null; // 非 JSON（反代登录页、网关 HTML）—— 调用方按 status 处理
    }
    return {
      status: response.status,
      body: parsed,
      token: tokenFromSetCookie(response.headers?.getSetCookie?.() ?? response.headers?.get?.('set-cookie')),
    };
  }

  /**
   * 把上游失败响应翻译成人话 `HttpError`。
   *
   * **绝不整段透传上游响应体**：只取 `error.code` 做查表，认不出来就用一句通用提示，
   * 免得把别人的 HTML/堆栈/内部措辞端到用户脸上。
   */
  #toHumanError(response, fallbackStatus = 502) {
    const code = String(response?.body?.error?.code ?? '').toUpperCase();
    const message = ERROR_MESSAGES[code];
    if (message) {
      // 用上游的状态码（401/403/409/429 都是契约里冻结的语义），让前端能区分
      const status = response.status >= 400 && response.status < 500 ? response.status : fallbackStatus;
      return new HttpError(status, code, message);
    }
    return new HttpError(fallbackStatus, code || 'UPSTREAM_ERROR', '服务器返回了看不懂的响应，请确认地址填的是「智学公开服务端」');
  }

  /* ------------------------------------------------------------ 对外动作 */

  /** 登录：拿会话令牌 -> 落盘。 */
  async login({ serverUrl, username, password } = {}) {
    if (!this.#hasServer({ serverUrl })) throw HttpError.badRequest(NO_SERVER_MESSAGE);
    const base = this.resolveServerUrl(serverUrl);
    const name = String(username ?? '').trim();
    if (!name || !password) throw HttpError.badRequest('用户名和密码都要填');

    const response = await this.#request(base, '/auth/login', { method: 'POST', body: { username: name, password: String(password) } });
    if (response.status !== 200 || !response.body?.user) throw this.#toHumanError(response, response.status === 401 ? 401 : 502);
    // 令牌优先从 Set-Cookie 取（契约如此）；若某个部署把它放在响应体里也认
    const token = response.token ?? response.body.token ?? response.body.sessionToken ?? null;
    if (!token) throw new HttpError(502, 'UPSTREAM_ERROR', '服务器没有返回会话令牌，可能是版本不匹配');

    const session = await this.#save({
      serverUrl: base,
      token,
      user: response.body.user,
      loginAt: new Date(this.now()).toISOString(),
    });
    return { ok: true, user: clone(session.user), serverUrl: session.serverUrl };
  }

  /** 用邀请码注册：语义同 login（成功即登录）。 */
  async register({ serverUrl, username, password, inviteCode } = {}) {
    if (!this.#hasServer({ serverUrl })) throw HttpError.badRequest(NO_SERVER_MESSAGE);
    const base = this.resolveServerUrl(serverUrl);
    const name = String(username ?? '').trim();
    if (!name || !password) throw HttpError.badRequest('用户名和密码都要填');
    const code = String(inviteCode ?? '').trim();
    if (!code) throw new HttpError(403, 'INVITE_INVALID', ERROR_MESSAGES.INVITE_INVALID);

    const response = await this.#request(base, '/auth/register', {
      method: 'POST',
      body: { username: name, password: String(password), inviteCode: code },
    });
    // 契约里注册成功是 201
    const okStatus = response.status === 200 || response.status === 201;
    if (!okStatus || !response.body?.user) throw this.#toHumanError(response, 502);
    const token = response.token ?? response.body.token ?? response.body.sessionToken ?? null;
    if (!token) throw new HttpError(502, 'UPSTREAM_ERROR', '注册成功但服务器没有返回会话令牌，请直接登录一次');

    const session = await this.#save({
      serverUrl: base,
      token,
      user: response.body.user,
      loginAt: new Date(this.now()).toISOString(),
    });
    return { ok: true, user: clone(session.user), serverUrl: session.serverUrl };
  }

  /** 探测服务器：永远是 `reachable:false` 而不是抛错——它的用途就是"帮用户判断填对没有"。 */
  async probe({ serverUrl } = {}) {
    let base;
    try {
      base = this.resolveServerUrl(serverUrl);
    } catch (error) {
      return { reachable: false, serverUrl: String(serverUrl ?? ''), serverName: null, version: null, features: null, error: error.message };
    }
    if (!this.#hasServer({ serverUrl })) {
      return { reachable: false, serverUrl: '', serverName: null, version: null, features: null, error: NO_SERVER_MESSAGE };
    }
    try {
      const response = await this.#request(base, '/auth/config');
      if (response.status !== 200 || !response.body) {
        return {
          reachable: false,
          serverUrl: base,
          serverName: null,
          version: null,
          features: null,
          error: `服务器回了个 ${response.status}（地址对，但对面好像不是智学服务端）`,
        };
      }
      return {
        reachable: true,
        serverUrl: base,
        serverName: response.body.serverName ?? null,
        version: response.body.version ?? null,
        // 只挑面板要显示的几项，别把上游整包原样转出去
        features: response.body.features ? { lms: Boolean(response.body.features.lms) } : null,
        registration: response.body.registration ?? null,
        firstUserBecomesAdmin: Boolean(response.body.firstUserBecomesAdmin),
      };
    } catch (error) {
      // 连不上 / 超时 / 地址不合法：都算"不可达"，由面板显示一句人话
      return { reachable: false, serverUrl: base, serverName: null, version: null, features: null, error: error.message };
    }
  }

  /**
   * 退出登录：**先清本地，再尽力通知服务器**。
   *
   * 顺序很关键：服务器连不上时也必须把本地凭据清掉（否则用户点了"退出"却还显示已登录，
   * 只能手工删文件）。服务端那次调用失败只记一行日志，不影响结果。
   */
  async logout() {
    const session = this.session;
    await this.#clear();
    if (!session?.token) return { ok: true, remote: false };
    try {
      const response = await this.#request(session.serverUrl, '/auth/logout', { method: 'POST', token: session.token, body: {} });
      return { ok: true, remote: response.status === 200 };
    } catch (error) {
      this.logger?.warn?.(`[account] 服务器端登出失败（本地已清除）：${error.message}`);
      return { ok: true, remote: false };
    }
  }
}
