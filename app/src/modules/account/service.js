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
 *
 * 真机上踩过的两个地址坑（改动都在这个文件里）
 * --------------------------------------------
 *   1. **不写协议的域名要补 https**：公网服务端（如 `https://study.xjtuwhy.com`）基本都是
 *      https，补成 http 会先挨一次 nginx 的 301；
 *   2. **301/302 会把 POST 改写成 GET**（fetch 规范如此），于是登录请求变成一次读 HTML 的
 *      GET —— 服务端根本没收到用户名密码，用户只看到"连不上/看不懂"。所以这里
 *      `redirect: 'manual'` 自己跟跳转，且**只跟同一 host**（登录 body 里是明文密码）。
 *      详见 `#assertRedirectAllowed` 与 `#request`。
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

/**
 * 连不上时的措辞（网络层失败：DNS 解析不了 / 拒绝连接 / 超时 / TLS）。
 *
 * 必须同时点出"检查地址**与端口**"：真机上把域名写对、端口写错（或忘了写端口）
 * 是最常见的形态，只说"连不上"用户不知道该动哪里。
 */
export const UNREACHABLE_MESSAGE = '连不上这个服务器：检查地址与端口，确认对方在跑';

/**
 * 连上了、但对面不是本项目服务端时的措辞。
 *
 * 典型场景：地址填成了博客/公司首页，或者 nginx 只反代了网页没反代 `/auth/**`。
 * 这句话必须说清"能打开 ≠ 是智学服务端"，否则用户会以为是自己网络的问题。
 */
export const NOT_POTATO_SERVER_MESSAGE =
  '这个地址能打开，但它不是「AI 智学」的服务端（缺少 /auth/config）';

/** 跳转被拒时的兜底措辞（具体原因见抛错处，都会带上是哪台主机）。 */
export const REDIRECT_REFUSED_MESSAGE = '服务器要求跳转到别处，为了不把密码发错地方已经停下';

/** 面板要展示的示例地址：错误文案里必须给例子，用户才知道"写对"长什么样。 */
export const SERVER_URL_EXAMPLE = 'https://study.xjtuwhy.com';

/** 地址栏为空且没有默认值时的措辞。 */
const NO_SERVER_MESSAGE = '请先填服务器地址';

/** 地址格式不对时的中文人话（`reason` 说明"哪里不对"，尾巴固定带示例）。 */
export function badServerUrlMessage(reason) {
  return `服务器地址看起来不对：${reason}（示例：${SERVER_URL_EXAMPLE}）`;
}

/** 构造一个"地址格式不对"的 400：**调用方拿到它就不该再发请求**。 */
function badServerUrl(reason) {
  return new HttpError(400, 'BAD_SERVER_URL', badServerUrlMessage(reason));
}

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** 只有 `scheme://` 才算"写了协议"—— `localhost:8866` 里那个冒号**不是**协议分隔符。 */
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;

/**
 * 是不是本机/内网直连地址（这些地址默认按 `http://` 试）。
 *
 * 只认字面量：`localhost`（含 `*.localhost`）、`127.0.0.1`、`[::1]`、纯 IP 字面量。
 * 不做 DNS 解析 —— 归一化必须是**纯函数**，不能因为网络状况给出不同结果。
 */
function isLocalHostname(hostname) {
  const host = String(hostname ?? '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // 纯 IPv4 字面量
  return host.includes(':'); // 纯 IPv6 字面量
}

/**
 * 归一化服务器地址 —— **本模块解析 `serverUrl` 的唯一口径**。
 *
 * 规则（每条都对应真机上真踩过的形态）：
 *   1. 去掉首尾空白与末尾多余的 `/`；
 *   2. **没写协议时按主机名补**：`localhost` / `127.0.0.1` / `[::1]` / 纯 IP 补 `http://`，
 *      其余域名补 `https://`。为什么不是一律补 http：公网服务器基本都是 https，
 *      补成 http 会先挨一次 301，而 **301 会把 POST 变成 GET**（见 `#assertRedirectAllowed`），
 *      用户看到的是"响应看不懂"而不是"地址写错了"；本机开发服务器则通常没有证书，补 https 直接连不上；
 *   3. 允许 `host:port`，允许带子路径（`https://x.com/study` 保留 `/study` 作为**前缀**）——
 *      服务端挂在子路径后面（nginx 反代）是合法部署，把路径吃掉会 404；
 *   4. 空串是合法的"同源"哨兵（服务端版把 `defaultServerUrl` 配成空串），返回空串而不是报错。
 *
 * @param {string} input 用户填的地址
 * @param {{defaultScheme?: 'http'|'https'}} [options] 强制"没写协议时"用的协议（测试/特殊部署用；
 *   写了协议时以用户写的为准）
 * @returns {string} 归一化后的地址（无尾斜杠，保留子路径前缀）
 * @throws {HttpError} 400 `BAD_SERVER_URL`（格式不对；调用方**不要**发请求）
 */
export function normalizeServerUrl(input, { defaultScheme } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) return ''; // 空 = 同源（服务端版），不是错误
  if (/\s/.test(raw)) throw badServerUrl('中间不能有空格');

  const explicit = SCHEME_RE.exec(raw);
  let scheme;
  if (explicit) {
    scheme = explicit[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      throw badServerUrl(`只认得 http:// 与 https://，不认得 ${scheme}://`);
    }
  } else {
    // 借 http:// 先解析一次，只为拿到主机名来判断"要不要补 http"。
    // （http 与 https 的主机名语法完全一样，所以这次试探不影响结论。）
    let probe;
    try {
      probe = new URL(`http://${raw}`);
    } catch {
      throw badServerUrl('看不懂这个地址');
    }
    const forced = String(defaultScheme ?? '').toLowerCase();
    scheme = forced === 'http' || forced === 'https' ? forced : isLocalHostname(probe.hostname) ? 'http' : 'https';
  }

  let url;
  try {
    url = new URL(explicit ? raw : `${scheme}://${raw}`);
  } catch {
    throw badServerUrl('看不懂这个地址');
  }
  if (!url.hostname) throw badServerUrl('缺了主机名');
  // 地址里塞用户名密码：既可能是误粘贴，也会被原样写进日志/凭据文件，直接拒绝更安全
  if (url.username || url.password) throw badServerUrl('不要在这里写用户名和密码');
  // 查询串与锚点不可能是 base 的一部分（留着只会拼出畸形地址）
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/** 去掉地址尾部的斜杠，返回不带斜杠的基址（空串表示同源）。 */
const trimBase = (serverUrl) => String(serverUrl ?? '').trim().replace(/\/+$/, '');

/**
 * 按基址拼出上游 URL。
 *
 * - 有 base：**字符串直接拼**（base 已经过 `normalizeServerUrl`：无尾斜杠、保留子路径前缀）。
 *   为什么不用 `new URL(pathname, base)`：那会把 base 里的子路径吃掉
 *   （`https://x.com/study` + `/auth/login` → `https://x.com/auth/login`），
 *   而"服务端挂在子路径下"是合法部署；
 * - 无 base（服务端版同源）：返回相对路径，交给调用方按当前 origin 解析。
 *
 * @throws {HttpError} 400 `BAD_SERVER_URL` 拼出来的地址不是合法 URL 时
 */
export function resolveUpstream(serverUrl, pathname) {
  const base = trimBase(serverUrl);
  const suffix = String(pathname ?? '');
  if (!base) return suffix;
  const joined = `${base}${suffix}`;
  try {
    new URL(joined);
  } catch {
    throw badServerUrl('看不懂这个地址');
  }
  return joined;
}

/**
 * 会"改写请求方法"的重定向状态码。
 *
 * 301/302 在 fetch 规范里会被改写成 GET（哪怕原来是 POST）；307/308 才是"原样重发"。
 * 不管哪一种，我们**都按同一方法、同一 body 自己重发**：登录的 body 里是明文密码，
 * 让运行库替我们决定"变成 GET"就会把用户名密码丢在半路上（真机上 nginx 的
 * `http -> https` 跳转正是这个形态）。303 的语义是"改用 GET 去取那个地址"，
 * 绝不能带着密码 body 跟，所以**不在名单里**。
 */
const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

/** 最多跟几跳。真机上 `http -> https` 只需要一跳，给 3 跳是留出多级反代的余地。 */
export const MAX_REDIRECTS = 3;

/**
 * 跳转之后的**新 base** 是什么。
 *
 * 归一化后的最终 base 会被写进 `data/account.json`、并回给面板（"下次就填这个"），
 * 所以必须算准：把这次请求的路径后缀从跳转目标上摘掉，剩下的就是新 base。
 *
 * 例：base `http://study.xjtuwhy.com` + `/auth/login`
 *     --301--> `https://study.xjtuwhy.com/auth/login`
 *     -> 新 base `https://study.xjtuwhy.com`
 *
 * 摘不掉（对方跳到了完全不同的路径）就退回 origin —— 宁可显示 origin，也别拼出畸形地址。
 */
function rebaseAfterRedirect(next, pathname) {
  const origin = `${next.protocol}//${next.host}`;
  const suffix = String(pathname ?? '');
  let href = `${origin}${next.pathname}`;
  if (suffix && href.endsWith(suffix)) href = href.slice(0, -suffix.length);
  return href.replace(/\/+$/, '') || origin;
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

  /**
   * 最终要用的服务器地址：请求里给的优先，其次上次登录的，最后是默认值。
   *
   * **三个来源都过 `normalizeServerUrl`**：老版本 `account.json` 里可能留着带尾斜杠的地址，
   * 配置文件里的默认值也可能被人手写成 `localhost:8866`。解析只留这一处口径，
   * 别的地方一律拿归一化后的字符串拼 URL。
   */
  resolveServerUrl(input) {
    const raw = input === undefined || input === null ? '' : String(input).trim();
    if (raw) return normalizeServerUrl(raw);
    if (this.session?.serverUrl) return normalizeServerUrl(this.session.serverUrl);
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
   * 把 base + pathname 变成 fetch 认得的绝对地址。
   *
   * 同源模式（`serverUrl` 为空 -> 拿到的是相对路径）下 Node 的 fetch 认不出相对 URL；
   * 同源语义是"本进程自己监听的那个地址"，所以用 `this.origin` 补全 ——
   * 服务端版会把 origin 设成自己的监听地址，相对路径这一语义因此得以保留。
   *
   * 注意区分两类失败：**地址本身不合法**（用户填错 -> 400 `BAD_SERVER_URL`，明确让他改地址）
   * 与**地址合法但连不上**（-> 502 `SERVER_UNREACHABLE` + "连不上这个服务器"）。
   * 若是把前者也吞成后者，用户会一直以为"服务器没开"，其实只是地址打错了。
   */
  #absoluteUrl(base, pathname) {
    const joined = resolveUpstream(base, pathname);
    if (/^https?:\/\//i.test(joined)) return joined;
    try {
      return new URL(joined, this.origin).toString();
    } catch {
      throw badServerUrl('看不懂这个地址');
    }
  }

  /** 发一次请求（**单跳**，不跟跳转）。网络层失败统一翻成 502 + 人话。 */
  async #fetchOnce(target, { method, headers, payload }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(target, {
        method,
        headers,
        body: payload,
        signal: controller.signal,
        // **必须手动跟跳转**（理由见 #assertRedirectAllowed）：fetch 的 `follow`
        // 会在 301/302 上把 POST 改写成 GET，而我们要的是"同一方法、同一 body 再发一次"。
        redirect: 'manual',
      });
    } catch (error) {
      // 网络层失败：DNS 解析不了、对方没监听、TLS 失败、超时被 abort……
      // 统一成一句人话，原因留在 details 里给排查用（不进 message）。
      const reason = error?.name === 'AbortError' ? `等待超过 ${Math.round(this.timeoutMs / 1000)} 秒` : error?.message;
      throw new HttpError(502, 'SERVER_UNREACHABLE', UNREACHABLE_MESSAGE, { hint: reason });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 这一跳能不能跟。
   *
   * 为什么必须手动跟、而不是把跳转交给 fetch（真机踩到的就是这件事）：
   *   - **301/302 会把 POST 改写成 GET**（fetch 规范如此，浏览器与 Node 一致）。
   *     nginx 一句 `return 301 https://…` 就能把登录 POST 变成一次读登录页的 GET：
   *     服务端根本没收到用户名密码，而用户看到的只是"响应看不懂 / 连不上"。
   *     只有手动跟，才能保证"同一方法、同一 body"重发。
   *   - 登录请求的 body 里是**明文密码**。跟着 `Location` 走到任意地址 = 把密码交给对方，
   *     所以只允许跳到**同一个 host**（同机才谈得上同一个信任域），别的 host 一律拒绝。
   *   - 公网域名只允许跳到 `https://`：明文 http 跳转等于把密码撒在路上。
   *     本机/回环地址（localhost、127.0.0.1、[::1]、IP 字面量）例外 —— 本地开发与自动化
   *     测试跑的就是 http，而且这类地址不会把凭据交给别人。
   */
  #assertRedirectAllowed(current, next) {
    const from = new URL(current);
    if (next.hostname.toLowerCase() !== from.hostname.toLowerCase()) {
      throw new HttpError(
        502,
        'REDIRECT_REFUSED',
        `服务器要把请求转到另一台主机（${next.host}），为了不把密码发错地方已经停下`,
      );
    }
    if (next.protocol !== 'https:' && !isLocalHostname(next.hostname)) {
      throw new HttpError(
        502,
        'REDIRECT_REFUSED',
        `服务器要把请求转到明文 http://（${next.host}），为了不把密码明文发出去已经停下`,
      );
    }
  }

  /**
   * 调一次上游，返回 `{status, body, token, base}`。
   *
   * - **`base` 是"跳转之后的最终 base URL"**：用户填 `http://study.xjtuwhy.com` 而 nginx
   *   301 到 https 时，调用方把 `base` 落盘 / 回给面板，用户下次就知道该填哪个地址；
   * - 错误分两层：**连不上 / 超时** -> `HttpError` 502 + 中文人话（`UNREACHABLE_MESSAGE`）；
   *   **上游返回了错误状态** -> 不抛，交给调用方按 `body.error.code` 映射，
   *   这样"登录失败"能拿到 401 语义，而不是被包成 502。
   *
   * `Authorization: Bearer` 与 `X-Potato-Token` 都带上：服务端版三种令牌载体都认
   * （Cookie / Bearer / 头），桌面端起见多发两个头，省得将来换载体又要改这里。
   */
  async #request(serverUrl, pathname, { method = 'GET', body, token } = {}) {
    let base = trimBase(serverUrl);
    let target = this.#absoluteUrl(base, pathname);
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      headers['X-Potato-Token'] = token;
    }
    // body 只序列化一次、每一跳复用同一个字符串：跟跳转时"同一 body"才有保证
    const payload = body === undefined ? undefined : JSON.stringify(body);

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await this.#fetchOnce(target, { method, headers, payload });

      if (!REDIRECT_STATUSES.has(response.status)) {
        const text = await response.text().catch(() => '');
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = null; // 非 JSON（反代登录页、网关 HTML）—— 调用方按状态码处理
        }
        return {
          status: response.status,
          body: parsed,
          token: tokenFromSetCookie(response.headers?.getSetCookie?.() ?? response.headers?.get?.('set-cookie')),
          base,
        };
      }

      // 跳转：先把响应体读干再去下一跳（不读干会占着这条连接，下一跳可能读到脏数据）
      await response.text().catch(() => {});
      const location = response.headers?.get?.('location') ?? null;
      if (!location) {
        throw new HttpError(502, 'REDIRECT_REFUSED', '服务器要求跳转，但没说跳到哪（缺少 Location），已经停下');
      }
      let next;
      try {
        next = new URL(location, target);
      } catch {
        throw new HttpError(502, 'REDIRECT_REFUSED', '服务器给的跳转地址看不懂，为了不把密码发错地方已经停下');
      }
      this.#assertRedirectAllowed(target, next);
      // 跳转后的新 base：登录成功要落盘的是**它**（用户下次就该填这个）
      base = rebaseAfterRedirect(next, pathname);
      target = next.toString();
    }
    throw new HttpError(502, 'REDIRECT_REFUSED', `服务器连续跳转超过 ${MAX_REDIRECTS} 次，地址可能配错了，已经停下`);
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
    // 连上了、但对面给的不是本项目的 JSON（HTML 登录页 / nginx 的 404 页 / 空响应）：
    // 这是"地址填到了别的服务"的典型形态，说清楚它比"看不懂的响应"有用得多。
    // 5xx 不在此列：那更像"服务端自己出问题了"，宁可说"稍后再试"，也别冤枉成"地址填错"。
    const notPotatoShape = response.status === 404 || response.status === 405 || (!response?.body && response.status < 500);
    if (notPotatoShape) {
      return new HttpError(502, 'NOT_POTATO_SERVER', NOT_POTATO_SERVER_MESSAGE);
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
      // **跳转之后的 base**：用户填 `http://study.xjtuwhy.com`、nginx 301 到 https 时，
      // 落盘的是 `https://study.xjtuwhy.com` —— 下次登录不必再挨一次跳转，
      // 面板也会把它显示出来（用户于是知道"该填什么"）。
      serverUrl: response.base,
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
      serverUrl: response.base, // 同登录：存跳转之后的最终 base
      token,
      user: response.body.user,
      loginAt: new Date(this.now()).toISOString(),
    });
    return { ok: true, user: clone(session.user), serverUrl: session.serverUrl };
  }

  /**
   * 探测服务器：永远是 `reachable:false` 而不是抛错——它的用途就是"帮用户判断填对没有"。
   *
   * 判定"这是不是本项目的服务端"的口径：`<base>/auth/config` 返回 200，
   * 且 JSON 里带 `serverName` 或 `registration`。不满足就说 `NOT_POTATO_SERVER` ——
   * 真机上"地址能打开但填成了别的站点"与"服务器没在跑"是两种完全不同的错，
   * 面板只显示 message，所以必须在这里分清。
   */
  async probe({ serverUrl } = {}) {
    let base;
    try {
      base = this.resolveServerUrl(serverUrl);
    } catch (error) {
      // 地址格式不对：当"不可达"回给面板，但 message 要说清是地址的问题
      return {
        reachable: false,
        serverUrl: String(serverUrl ?? ''),
        serverName: null,
        version: null,
        features: null,
        errorCode: error.code ?? null,
        error: error.message,
      };
    }
    if (!this.#hasServer({ serverUrl })) {
      return { reachable: false, serverUrl: '', serverName: null, version: null, features: null, errorCode: null, error: NO_SERVER_MESSAGE };
    }
    try {
      const response = await this.#request(base, '/auth/config');
      const config = response.body;
      const looksLikePotato =
        response.status === 200 &&
        Boolean(config) &&
        typeof config === 'object' &&
        (config.serverName !== undefined || config.registration !== undefined);
      if (!looksLikePotato) {
        return {
          reachable: false,
          serverUrl: response.base,
          serverName: null,
          version: null,
          features: null,
          errorCode: 'NOT_POTATO_SERVER',
          error: NOT_POTATO_SERVER_MESSAGE,
        };
      }
      return {
        reachable: true,
        // 归一化（含跳转）之后的地址：面板把它显示出来，用户下次照抄就行
        serverUrl: response.base,
        serverName: config.serverName ?? null,
        version: config.version ?? null,
        // 只挑面板要显示的几项，别把上游整包原样转出去
        features: config.features ? { lms: Boolean(config.features.lms) } : null,
        registration: config.registration ?? null,
        firstUserBecomesAdmin: Boolean(config.firstUserBecomesAdmin),
        errorCode: null,
      };
    } catch (error) {
      // 连不上 / 超时 / 跳转被拒 / 地址不合法：都算"不可达"，由面板显示一句人话
      return {
        reachable: false,
        serverUrl: base,
        serverName: null,
        version: null,
        features: null,
        errorCode: error.code ?? null,
        error: error.message,
      };
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
