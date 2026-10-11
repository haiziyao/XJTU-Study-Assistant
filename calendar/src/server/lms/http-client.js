/**
 * 极简 HTTP 客户端：Cookie 罐 + 手动跟踪重定向。
 *
 * 为什么不用 `fetch` 的自动重定向：CAS 登录的每一步都会 `Set-Cookie`，
 * 而 Node 的 fetch 没有 Cookie 罐，自动重定向会直接丢掉中间跳转种下的会话票，
 * 表现为「密码对了但仍然回到登录页」。所以这里显式接管重定向，
 * 在每一跳之后收集 Cookie，再带上继续走。
 */

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;

/** 解析单条 Set-Cookie。 */
function parseSetCookie(raw, requestUrl) {
  const parts = String(raw).split(';');
  const first = parts.shift() ?? '';
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;

  const url = new URL(requestUrl);
  const cookie = { name, value, domain: url.hostname, hostOnly: true, path: defaultPath(url.pathname), expiresAt: null, secure: false };
  for (const attr of parts) {
    const [keyRaw, ...rest] = attr.split('=');
    const key = keyRaw.trim().toLowerCase();
    const attrValue = rest.join('=').trim();
    if (key === 'domain' && attrValue) {
      cookie.domain = attrValue.replace(/^\./, '').toLowerCase();
      cookie.hostOnly = false;
    } else if (key === 'path' && attrValue) {
      cookie.path = attrValue;
    } else if (key === 'max-age' && attrValue) {
      const seconds = Number(attrValue);
      if (Number.isFinite(seconds)) cookie.expiresAt = Date.now() + seconds * 1000;
    } else if (key === 'expires' && attrValue && cookie.expiresAt === null) {
      const at = Date.parse(attrValue);
      if (!Number.isNaN(at)) cookie.expiresAt = at;
    } else if (key === 'secure') {
      cookie.secure = true;
    }
  }
  // 过期即删除：Max-Age=0 是服务端注销会话的常用写法
  if (cookie.expiresAt !== null && cookie.expiresAt <= Date.now()) cookie.expired = true;
  return cookie;
}

function defaultPath(pathname) {
  if (!pathname || pathname[0] !== '/') return '/';
  const index = pathname.lastIndexOf('/');
  if (index <= 0) return '/';
  return pathname.slice(0, index);
}

function domainMatches(host, cookie) {
  if (cookie.hostOnly) return host === cookie.domain;
  return host === cookie.domain || host.endsWith(`.${cookie.domain}`);
}

/** 会话票据的存放与筛选。可序列化，便于把登录态落到磁盘。 */
export class CookieJar {
  constructor(entries = []) {
    /** @type {Map<string, object>} */
    this.cookies = new Map();
    for (const entry of entries) this.#store(entry);
  }

  #key(cookie) {
    return `${cookie.domain}|${cookie.path}|${cookie.name}`;
  }

  #store(cookie) {
    if (!cookie || !cookie.name) return;
    const key = this.#key(cookie);
    if (cookie.expired) this.cookies.delete(key);
    else this.cookies.set(key, cookie);
  }

  /** 收集响应里的全部 Set-Cookie（getSetCookie 才能正确处理 Expires 中的逗号）。 */
  setFromResponse(requestUrl, headers) {
    let list = [];
    if (typeof headers.getSetCookie === 'function') list = headers.getSetCookie();
    if (!list.length) {
      const single = headers.get('set-cookie');
      if (single) list = [single];
    }
    for (const raw of list) {
      const cookie = parseSetCookie(raw, requestUrl);
      if (cookie) this.#store(cookie);
    }
    return this;
  }

  /** 生成该请求应携带的 Cookie 头；无可用票据时返回空串。 */
  header(url) {
    const parsed = new URL(url);
    const now = Date.now();
    const matched = [];
    for (const cookie of this.cookies.values()) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
        this.cookies.delete(this.#key(cookie));
        continue;
      }
      if (cookie.secure && parsed.protocol !== 'https:') continue;
      if (!domainMatches(parsed.hostname, cookie)) continue;
      if (!parsed.pathname.startsWith(cookie.path)) continue;
      matched.push(cookie);
    }
    matched.sort((a, b) => b.path.length - a.path.length);
    return matched.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }

  /** 判断某个域下是否存在票据（用于「有没有登录态」的快速判断）。 */
  has(domain) {
    for (const cookie of this.cookies.values()) {
      if (domainMatches(domain, cookie)) return true;
    }
    return false;
  }

  clear() {
    this.cookies.clear();
    return this;
  }

  toJSON() {
    return [...this.cookies.values()];
  }

  static fromJSON(data) {
    return new CookieJar(Array.isArray(data) ? data : []);
  }
}

export class HttpError extends Error {
  constructor(message, { status = 0, url = '', body = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class HttpClient {
  /**
   * @param {object} options
   * @param {string} [options.userAgent] 请求头 UA
   * @param {number} [options.timeoutMs] 单次请求超时
   * @param {CookieJar} [options.jar] 复用的 Cookie 罐
   * @param {typeof fetch} [options.fetchImpl] 便于测试注入
   */
  constructor({ userAgent, timeoutMs = 20_000, jar = new CookieJar(), fetchImpl = globalThis.fetch } = {}) {
    this.userAgent = userAgent;
    this.timeoutMs = timeoutMs;
    this.jar = jar;
    this.fetchImpl = fetchImpl;
  }

  /** 是否安装过自定义 UA；服务端对默认 UA 会直接拒绝。 */
  get ready() {
    return typeof this.fetchImpl === 'function';
  }

  /**
   * 发起请求并手动跟随重定向，返回最终响应。
   * @returns {Promise<{status:number,url:string,headers:Headers,text:string,bytes:Uint8Array,redirects:string[]}>}
   */
  async request(url, { method = 'GET', headers = {}, body, follow = true, timeoutMs } = {}) {
    let currentUrl = typeof url === 'string' ? url : String(url);
    let currentMethod = method.toUpperCase();
    let currentBody = body;
    const redirects = [];
    const effectiveTimeout = timeoutMs ?? this.timeoutMs;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const parsed = new URL(currentUrl);
      const requestHeaders = {
        'User-Agent': this.userAgent ?? 'Mozilla/5.0',
        Accept: 'text/html,application/json,application/xhtml+xml,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...headers,
      };
      const cookie = this.jar.header(currentUrl);
      if (cookie) requestHeaders.Cookie = cookie;
      if (currentBody && !requestHeaders['Content-Type']) {
        requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      }

      const signal = effectiveTimeout > 0 ? AbortSignal.timeout(effectiveTimeout) : undefined;
      let response;
      try {
        response = await this.fetchImpl(currentUrl, {
          method: currentMethod,
          headers: requestHeaders,
          body: currentBody,
          redirect: 'manual',
          signal,
        });
      } catch (error) {
        throw new HttpError(`请求 ${parsed.origin}${parsed.pathname} 失败：${error.message ?? error}`, { url: currentUrl });
      }

      this.jar.setFromResponse(currentUrl, response.headers);

      const location = response.headers.get('location');
      if (follow && REDIRECT_STATUS.has(response.status) && location) {
        const nextUrl = new URL(location, currentUrl).href;
        if (!/^https?:/i.test(nextUrl)) {
          throw new HttpError(`重定向到不支持的协议：${nextUrl}`, { status: response.status, url: currentUrl });
        }
        redirects.push(nextUrl);
        // 303 与「POST 收到 301/302」按浏览器行为降级为 GET
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === 'POST')) {
          currentMethod = 'GET';
          currentBody = undefined;
        }
        currentUrl = nextUrl;
        continue;
      }

      const buffer = new Uint8Array(await response.arrayBuffer());
      return {
        status: response.status,
        url: currentUrl,
        headers: response.headers,
        bytes: buffer,
        text: new TextDecoder('utf-8').decode(buffer),
        redirects,
      };
    }

    throw new HttpError(`重定向次数超过 ${MAX_REDIRECTS} 次`, { url: currentUrl });
  }

  get(url, options = {}) {
    return this.request(url, { ...options, method: 'GET' });
  }

  postForm(url, fields, options = {}) {
    const body = fields instanceof URLSearchParams ? fields : new URLSearchParams(fields ?? {});
    return this.request(url, {
      ...options,
      method: 'POST',
      body: body.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(options.headers ?? {}) },
    });
  }

  postJson(url, data, options = {}) {
    return this.request(url, {
      ...options,
      method: 'POST',
      body: JSON.stringify(data ?? {}),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*', ...(options.headers ?? {}) },
    });
  }

  /** 请求 JSON，非 2xx 抛出 HttpError（附响应片段，便于定位校方接口变更）。 */
  async json(url, options = {}) {
    const response = await this.request(url, { ...options, headers: { Accept: 'application/json, text/plain, */*', ...(options.headers ?? {}) } });
    if (response.status < 200 || response.status >= 300) {
      throw new HttpError(`接口 ${url} 返回 HTTP ${response.status}`, {
        status: response.status,
        url,
        body: response.text.slice(0, 300),
      });
    }
    try {
      return JSON.parse(response.text);
    } catch (error) {
      throw new HttpError(`接口 ${url} 返回的不是 JSON（可能是登录态失效）`, { status: response.status, url, body: response.text.slice(0, 300) });
    }
  }
}
