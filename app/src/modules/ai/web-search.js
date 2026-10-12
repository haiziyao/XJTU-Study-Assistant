/**
 * 联网检索适配层（后端，零依赖）。
 *
 * 设计目标：让 AI 在多轮对话里完成「搜网页 → 读正文 → 带出处回答」这条链路，
 * 而**不引入任何运行时依赖**（不用 cheerio / jsdom / axios，只用 Node 内置 fetch + 正则）。
 *
 * 三层降级（按配置自动选择，见 `resolveSearchBackend`）
 * ---------------------------------------------------
 *   1. **配置了 API key** → 走官方 API（Tavily / Brave / Serper / Bing Web Search 任一），
 *      结构化 JSON，最稳；
 *   2. **没配 key** → 解析公共搜索引擎的结果页（Bing 优先，失败退百度），拿到标题 + 链接 + 摘要；
 *   3. **结果页也被反爬/改版挡住** → 返回**空数组**，并把原因写进 `log`。
 *
 * 第 3 条是本文件最重要的约定：**搜不到就如实说搜不到**。
 * 绝不允许返回伪造结果，也不允许把「没配置 / 被拦截」静默成「搜到 0 条」——
 * 后者会让模型在用户面前编出"我查了一下，没有相关结果"这种假结论，比直接说"检索失败"更糟。
 *
 * 两种模式（`mode`）
 * ----------------
 *   - `web`    ：校外，全网检索；
 *   - `campus` ：①把检索收窄到校内站点（`*.xjtu.edu.cn`，见 `isCampusUrl`）；
 *                ②**校内域名探测可达时**再并走一次公网检索，两批结果合并去重。
 *                注意：探测只能判断「校内域名可达」，**不能证明当前真的走了校园网**
 *                （校内站点也可能对公网开放），所以它只作为"是否并走公网"的启发式，
 *                并且在返回值里带 `caveat` 如实说明这一点。
 *
 * 可测试性
 * --------
 * 所有网络动作都走 `fetchImpl`（默认 `globalThis.fetch`），测试可注入本地假服务器；
 * 端点也允许用 `config.searchEndpoints` 覆盖，于是"假搜索引擎"可以是一个 127.0.0.1 上的
 * `node:http` 服务，测试**完全不碰真实外网**。
 */

const noop = () => {};

/** 一次检索最多读几页的合法区间（对应设置里的「网络搜索最大条数」）。 */
export const SEARCH_LIMIT_MIN = 5;
export const SEARCH_LIMIT_MAX = 30;
/** 设置里没填时的默认值（与 config.js 的 AI_DEFAULTS.searchMaxPages 保持一致）。 */
export const SEARCH_LIMIT_DEFAULT = 8;

/** 单页正文默认截断长度（字）。4000 字≈6~8k token，8 页全读也就 5 万 token 上下。 */
export const READ_MAX_CHARS = 4_000;
/** 读正文的并发上限：再高容易把目标站打出 429，收益也有限。 */
export const READ_CONCURRENCY_MAX = 4;
export const READ_CONCURRENCY_DEFAULT = 3;

/** 工具可选的模式（注意：对话层的 `search` 还有第三档 `off`，那一档根本不会调到本文件）。 */
export const WEB_SEARCH_MODES = Object.freeze(['web', 'campus']);

/** 支持"填了 key 就优先走 API"的四家。数组顺序 = auto 模式下的优先级。 */
export const SEARCH_PROVIDERS = Object.freeze(['tavily', 'brave', 'serper', 'bing']);

/**
 * 校内站点后缀。`*.xjtu.edu.cn` 覆盖教务/图书馆/学院/研究生院等子站。
 * 判据用**后缀**而不是硬编码主机名，新开一个子站不用改代码。
 */
export const CAMPUS_HOST_SUFFIXES = Object.freeze(['xjtu.edu.cn']);

/**
 * 默认探测目标：都是本仓库其它模块里**已经在用**的真实主机名
 * （`dean.xjtu.edu.cn` 来自校规知识库抓取源、`lms/ehall` 来自 lms/academic 模块），
 * 不是我凭空编的域名。
 */
export const CAMPUS_PROBES = Object.freeze([
  { url: 'https://dean.xjtu.edu.cn/', label: '教务处（dean）' },
  { url: 'https://gs.xjtu.edu.cn/', label: '研究生院（gs）' },
  { url: 'https://lms.xjtu.edu.cn/', label: '思源学堂（lms）' },
  { url: 'https://ehall.xjtu.edu.cn/', label: '师生服务大厅（ehall）' },
]);

/** 探测结论里必须带上的一句话，避免调用方把「可达」误读成「在校园网内」。 */
export const CAMPUS_PROBE_CAVEAT =
  '探测只能说明「校内域名在当前离线环境下可达」，不能证明流量真的走了校园网：' +
  '校内站点也可能对公网开放，反之校园网内的 DNS/代理异常也会造成误判。';

const DEFAULT_TIMEOUT_MS = 8_000;
const READ_TIMEOUT_MS = 12_000;
const PROBE_TIMEOUT_MS = 2_500;
/** 单个页面最多读多少字符再清洗（防止一个几 MB 的页面把内存吃满）。 */
const MAX_HTML_BYTES = 1_500_000;

/**
 * 结果页解析必须伪装成浏览器：默认 UA（node）会被搜索引擎直接回验证码，
 * 这不是"绕过反爬"，而是拿回和普通浏览器一样的公开结果页 —— 真被拦时我们照样如实报空。
 */
const BROWSER_HEADERS = Object.freeze({
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
});

/** 去重时要丢掉的跟踪参数（同一条结果带不带 utm_* 都是同一条）。 */
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'spm', 'from_source', 'ref', 'referer', 'source_from']);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 日志适配：允许三种写法
 *   1. `log(message)` —— 测试里最省事；
 *   2. `log(level, message)` —— chat-service 传进来的 `this.logger`，按"级别 + 正文"两条参数；
 *   3. `{ warn, info, error }` 对象（照 console 的形状）。
 * 用「形参个数」区分 1 与 2：写 `(message) => …` 的只吃第一条，
 * 写 `(level, message) => …` 的两条都要，谁也不会拿到 `undefined`。
 */
function makeLogger(log) {
  if (!log) return noop;
  if (typeof log === 'function') {
    if (log.length >= 2) {
      return (message, level = 'info') => {
        try {
          log(level, `[web-search] ${message}`);
        } catch {
          /* 日志失败绝不能影响检索本身 */
        }
      };
    }
    return (message) => {
      try {
        log(`[web-search] ${message}`);
      } catch {
        /* 同上 */
      }
    };
  }
  if (typeof log === 'object') {
    const fn = log.warn ?? log.info ?? log.debug ?? log.log;
    if (typeof fn === 'function') {
      return (message, level = 'info') => {
        try {
          const target = (level === 'warn' && typeof log.warn === 'function' ? log.warn : fn).bind(log);
          target(`[web-search] ${message}`);
        } catch {
          /* 同上 */
        }
      };
    }
  }
  return noop;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/**
 * 把外部传进来的 limit **收敛**到 5–30（而不是抛错）。
 *
 * 为什么运行时收敛、配置项却抛错：配置是用户手填的，填错必须立刻告诉他；
 * 而 limit 可能来自模型生成的工具参数 —— 模型偶尔传 0 或 100，
 * 这时候"少读几页"远好于"整轮对话报错"。
 */
export function normalizeSearchLimit(value, { fallback = SEARCH_LIMIT_DEFAULT } = {}) {
  const base = clampInt(fallback, SEARCH_LIMIT_MIN, SEARCH_LIMIT_MAX, SEARCH_LIMIT_DEFAULT);
  return clampInt(value, SEARCH_LIMIT_MIN, SEARCH_LIMIT_MAX, base);
}

/** 把值限制在 [min,max]；非法/缺省时用 fallback。 */
function clamp(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/** 超时用 AbortController 而不是 AbortSignal.timeout：后者在部分注入的 fetch 里不可用。 */
function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${ms}ms`)), ms);
  // 计时器 unref：否则测试进程会被一个待触发的 8s 定时器拖住
  if (typeof timer.unref === 'function') timer.unref();
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function describeError(error) {
  if (!error) return '未知错误';
  const name = error.name ?? '';
  const message = error.message ?? String(error);
  if (name === 'AbortError' || /aborted|timeout/i.test(message)) return `请求超时或被中断（${message}）`;
  if (/ENOTFOUND|EAI_AGAIN/.test(message)) return `域名解析失败（${message}）`;
  if (/ECONNREFUSED/.test(message)) return `连接被拒绝（${message}）`;
  if (/certificate|self-signed/i.test(message)) return `TLS 证书校验失败（${message}）`;
  return message;
}

function parseUrl(raw) {
  try {
    const url = new URL(String(raw ?? '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** 该 URL 是否属于校内站点（后缀匹配，含子站）。 */
export function isCampusUrl(raw) {
  const url = parseUrl(raw);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  return CAMPUS_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * 去重用的规范化 URL。
 * 去掉 hash、`www.` 前缀、跟踪参数和末尾斜杠 —— 同一条结果往往以好几种写法出现。
 */
export function canonicalUrl(raw) {
  const url = parseUrl(raw);
  if (!url) return null;
  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key) || /^utm_/i.test(key)) url.searchParams.delete(key);
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  url.searchParams.sort();
  return url.toString();
}

/**
 * 明显的垃圾结果：搜索引擎自己的检索页/站内跳转、静态资源、非 http(s) 链接。
 *
 * 特别说明**百度**：它的自然结果 href 基本都是 `www.baidu.com/link?url=…`，
 * 直接按"站内跳转"丢掉等于百度一路全废。这类链接跟着跳一次就能到真正的目标页
 * （`readPages` 抓正文时本来就会 follow 跳转），所以**保留**；
 * 真正要丢的是回到搜索页自身的链接（`/s?wd=`、`bing.com/search`）。
 */
export function isJunkUrl(raw) {
  const url = parseUrl(raw);
  if (!url) return true;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (/(^|\.)bing\.com$/.test(host) && path.startsWith('/search')) return true;
  if (/(^|\.)baidu\.com$/.test(host) && path.startsWith('/s')) return true;
  if (/(^|\.)google\./.test(host) && path === '/search') return true;
  if (/(^|\.)sogou\.com$/.test(host) && path.startsWith('/web')) return true;
  if (/(^|\.)so\.com$/.test(host) && path.startsWith('/s')) return true;
  if (/\.(?:jpe?g|png|gif|webp|svg|ico|css|js|mjs|woff2?|ttf|eot|mp4|mp3|avi|zip|rar|7z|exe|dmg|apk|pdf)$/i.test(path)) {
    return true;
  }
  return false;
}

/** HTML 实体解码（结果页里的标题/摘要几乎必然带实体）。 */
export function decodeEntities(text) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–',
    middot: '·', times: '×', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
    deg: '°', plusmn: '±', frac12: '½', bull: '•', dagger: '†', permil: '‰', euro: '€',
    pound: '£', yen: '¥', sect: '§', para: '¶', szlig: 'ß', agrave: 'à', eacute: 'é',
  };
  return String(text ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const lower = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(named, lower) ? named[lower] : match;
  });
}

/** 折叠空白：把连续空白压成一个空格，保留换行（正文分段靠换行）。 */
function collapseWhitespace(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0\u3000\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 结果页摘要这种**单行**文本：连换行也压成空格。 */
function collapseInline(text) {
  return collapseWhitespace(text).replace(/\s*\n\s*/g, ' ').trim();
}

/** 取第一段匹配并清理成纯文本。 */
function firstText(html, regex) {
  const match = regex.exec(String(html ?? ''));
  return match ? collapseInline(stripTags(match[1])) : '';
}

function stripTags(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' '));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * 统一的一次请求。**永远不 throw**：把失败折叠成 `{ ok:false, error }`，
 * 因为调用方（搜一批页 / 探测一批域名）必须能"一条失败不影响其余"。
 */
export async function requestText(fetchImpl, url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    accept = '*/*',
  } = options;
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { ok: false, status: 0, url, error: '当前运行环境没有可用的 fetch（Node 版本过低？）' };
  }
  const timer = withTimeout(timeoutMs);
  try {
    const response = await doFetch(url, {
      method,
      headers: { ...BROWSER_HEADERS, Accept: accept, ...headers },
      body,
      redirect: 'follow',
      signal: timer.signal,
    });
    if (!response) return { ok: false, status: 0, url, error: 'fetch 没有返回 Response' };
    const status = Number(response.status ?? 0);
    const contentType = String(response.headers?.get?.('content-type') ?? '');
    let text = '';
    try {
      text = String((await response.text()) ?? '');
    } catch (error) {
      return { ok: false, status, url: response.url || url, contentType, error: `读取响应体失败：${describeError(error)}` };
    }
    if (text.length > MAX_HTML_BYTES) text = text.slice(0, MAX_HTML_BYTES);
    return { ok: Boolean(response.ok), status, url: response.url || url, contentType, body: text };
  } catch (error) {
    return { ok: false, status: 0, url, error: describeError(error) };
  } finally {
    timer.done();
  }
}

// ---------------------------------------------------------------------------
// 结果页解析（无 key 通道）
// ---------------------------------------------------------------------------

/** 广告容器标记：结果页里最稳的"广告位"特征就是这些 class / 属性。 */
const AD_MARKERS = /(?:^|[\s"'=])(?:b_ad|b_algo_ad|ec_ad|data-tuiguang|adtag|ad-icon|result-op)(?:[\s"'=]|$)/i;

/** 反爬/风控页面的特征词。命中就当作"被拦截"，而不是"搜到 0 条"。 */
const BLOCK_MARKERS = [
  '验证码', '安全验证', '请输入验证码', '滑块验证', '人机验证', '访问过于频繁', '异常流量',
  'wappass', 'passport.baidu.com/v2/?login', 'captcha', 'unusual traffic', 'are you a robot',
  'verify you are human', 'enable javascript and cookies', '请求被拦截', '网络不给力',
];

/** 把 HTML 按"结果块起始标签"切开：搜索引擎的结果容器都有稳定 class，比整页 DOM 解析稳。 */
function splitBlocks(html, openRegex) {
  const source = String(html ?? '');
  const matches = [...source.matchAll(openRegex)];
  return matches.map((match, index) => ({
    header: match[0],
    body: source.slice(
      (match.index ?? 0) + match[0].length,
      index + 1 < matches.length ? matches[index + 1].index : source.length,
    ),
  }));
}

function firstAnchor(html) {
  const match = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(String(html ?? ''));
  if (!match) return null;
  return { href: decodeEntities(match[1]).trim(), text: collapseInline(stripTags(match[2])) };
}

function toResult(anchor, snippet, source) {
  if (!anchor?.href || !anchor.text) return null;
  if (isJunkUrl(anchor.href)) return null;
  return { title: anchor.text, url: anchor.href, snippet: collapseInline(snippet).slice(0, 400), source };
}

/** 解析 Bing 结果页（`<li class="b_algo">…</li>`）。结构变了就返回空数组，由调用方如实报错。 */
export function parseBingResults(html) {
  const out = [];
  for (const block of splitBlocks(html, /<li[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>/gi)) {
    if (AD_MARKERS.test(block.header)) continue;
    const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(block.body);
    const anchor = firstAnchor(heading ? heading[1] : block.body);
    const snippet =
      firstText(block.body, /<p\b[^>]*>([\s\S]*?)<\/p>/i) ||
      firstText(block.body, /<div[^>]*class=["'][^"']*b_caption[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) ||
      firstText(block.body, /<div[^>]*class=["'][^"']*b_snippet[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const result = toResult(anchor, snippet, 'bing-html');
    if (result) out.push(result);
  }
  return out;
}

/** 解析百度结果页（`<div class="result c-container">…</div>`）。 */
export function parseBaiduResults(html) {
  const out = [];
  for (const block of splitBlocks(html, /<div[^>]*class=["'][^"']*\bresult\b[^"']*["'][^>]*>/gi)) {
    if (AD_MARKERS.test(block.header)) continue;
    const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(block.body);
    const anchor = firstAnchor(heading ? heading[1] : block.body);
    const snippet =
      firstText(block.body, /<div[^>]*class=["'][^"']*c-abstract[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) ||
      firstText(block.body, /<span[^>]*class=["'][^"']*(?:content-right|c-color-text|abstract)[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) ||
      firstText(block.body, /<div[^>]*class=["'][^"']*c-span-last[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const result = toResult(anchor, snippet, 'baidu-html');
    if (result) out.push(result);
  }
  return out;
}

/** 各引擎结果块的"结构指纹"：有它才算拿到了真结果页。 */
const STRUCTURE_MARKERS = Object.freeze({ bing: /b_algo/i, baidu: /\bresult\b/i });

/**
 * 命中反爬/改版特征就返回原因文本，否则 null。
 *
 * 判定顺序刻意是「先看有没有结果块，再看风控特征」：
 * 结构指纹在就已经说明拿到了真结果页，此时页面多短都无所谓
 * （小站点/测试页可能只有几百字节，不能因为短就误判成被拦）。
 */
export function detectAntiBot(engine, status, body) {
  const text = String(body ?? '');
  if (status === 403 || status === 429 || status === 418) return `HTTP ${status}（被拒绝/限流）`;
  if (status >= 500) return `HTTP ${status}（对方服务异常）`;
  const lower = text.toLowerCase();
  for (const marker of BLOCK_MARKERS) {
    if (lower.includes(marker.toLowerCase())) return `命中风控页特征「${marker}」`;
  }
  const structure = STRUCTURE_MARKERS[engine];
  if (structure && structure.test(text)) return null;
  return `页面里没有 ${engine} 的结果块（响应 ${text.length} 字节，结构可能已改版或被风控页替换）`;
}

/**
 * 把查询参数拼到端点上。
 *
 * 端点允许被 `config.searchEndpoints` 覆盖（测试注入本地假服务器、或接自建网关），
 * 而**覆盖值本身可能已经带了参数**（例如 `.../bing?mode=captcha`），
 * 所以统一用 URLSearchParams 追加，而不是字符串拼 `?`。
 */
function withParams(endpoint, params) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** 无 key 通道的引擎定义。 */
const SCRAPE_ENGINES = Object.freeze([
  {
    id: 'bing',
    label: 'Bing',
    origin: 'https://www.bing.com/search',
    params: (query, limit) => ({ q: query, count: limit, setlang: 'zh-CN', ensearch: '0' }),
    parse: parseBingResults,
  },
  {
    id: 'baidu',
    label: '百度',
    origin: 'https://www.baidu.com/s',
    params: (query, limit) => ({ wd: query, rn: limit }),
    parse: parseBaiduResults,
  },
]);

/**
 * 依次尝试 Bing → 百度。**只要有一个引擎给出结果就返回**；
 * 全部失败返回 `[]`，并且每一条失败原因都写进 `note`（调用方可直接回灌给模型/用户）。
 */
async function scrapeSearch({ query, limit, fetchImpl, endpoints = {}, note }) {
  for (const engine of SCRAPE_ENGINES) {
    // 失败原因**立刻**记一条：如果后面的引擎成功了也不能把前面失败的事实吞掉
    // （用户看到的"为什么只有百度的结果"必须能在日志里找到答案）
    const fail = (reason) => note(`免密钥通道失败：${reason}`, 'warn');
    const url = withParams(endpoints[engine.id] ?? engine.origin, engine.params(query, limit));
    const response = await requestText(fetchImpl, url, { timeoutMs: DEFAULT_TIMEOUT_MS, accept: 'text/html' });
    if (!response.ok) {
      fail(`${engine.label} 请求失败：${response.error ?? `HTTP ${response.status}`}`);
      continue;
    }
    const blocked = detectAntiBot(engine.id, response.status, response.body);
    if (blocked) {
      fail(`${engine.label} 被反爬/改版挡住：${blocked}`);
      continue;
    }
    let items = [];
    try {
      items = engine.parse(response.body) ?? [];
    } catch (error) {
      fail(`${engine.label} 解析结果页时抛错：${error.message}`);
      continue;
    }
    if (!items.length) {
      fail(`${engine.label} 解析出 0 条（页面结构可能已变化）`);
      continue;
    }
    note(`结果页解析成功：${engine.label} 给出 ${items.length} 条候选（未配置搜索 API 密钥，走免密钥通道）`);
    return items;
  }
  note(
    '已尝试全部免密钥通道（Bing → 百度）都没有取到结果 → 返回空数组。' +
      '**这不是「搜到 0 条」，而是「没能取到搜索结果」**：可能被反爬拦截、结果页改版，或当前网络无法访问这些站点。',
  );
  return [];
}

// ---------------------------------------------------------------------------
// API 通道（有 key 时优先）
// ---------------------------------------------------------------------------

/**
 * 四家搜索 API 的适配。每家的形状都不一样，但都收敛成 `[{title,url,snippet,source}]`。
 * `endpoints` 允许覆盖 URL —— 测试注入本地假服务器，也方便接自建网关。
 */
const API_PROVIDERS = {
  tavily: {
    id: 'tavily',
    label: 'Tavily',
    endpoint: 'https://api.tavily.com/search',
    build: (query, limit, key) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ api_key: key, query, max_results: limit, search_depth: 'basic', include_answer: false }),
    }),
    parse: (json) =>
      (json?.results ?? []).map((item) => ({ title: item?.title, url: item?.url, snippet: item?.content, source: 'tavily' })),
  },
  brave: {
    id: 'brave',
    label: 'Brave Search',
    endpoint: 'https://api.search.brave.com/res/v1/web/search',
    build: (query, limit, key) => ({
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    }),
    url: (endpoint, query, limit) => withParams(endpoint, { q: query, count: limit }),
    parse: (json) =>
      (json?.web?.results ?? []).map((item) => ({
        title: item?.title,
        url: item?.url,
        snippet: item?.description,
        source: 'brave',
      })),
  },
  serper: {
    id: 'serper',
    label: 'Serper',
    endpoint: 'https://google.serper.dev/search',
    build: (query, limit, key) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
      body: JSON.stringify({ q: query, num: limit }),
    }),
    // Serper 的字段名是 `link`；个别自建网关会回 `url`，两个都认
    parse: (json) =>
      (json?.organic ?? []).map((item) => ({
        title: item?.title,
        url: item?.link ?? item?.url,
        snippet: item?.snippet,
        source: 'serper',
      })),
  },
  bing: {
    id: 'bing',
    label: 'Bing Web Search',
    endpoint: 'https://api.bing.microsoft.com/v7.0/search',
    build: (query, limit, key) => ({
      method: 'GET',
      headers: { Accept: 'application/json', 'Ocp-Apim-Subscription-Key': key },
    }),
    url: (endpoint, query, limit) =>
      withParams(endpoint, { q: query, count: limit, mkt: 'zh-CN', responseFilter: 'Webpages' }),
    parse: (json) =>
      (json?.webPages?.value ?? []).map((item) => ({
        title: item?.name,
        url: item?.url,
        snippet: item?.snippet,
        source: 'bing',
      })),
  },
};

/** 从配置里取出「每个 provider 各自的密钥」。 */
export function normalizeSearchKeys(config = {}) {
  const keys = {};
  const explicit = config.searchApiKeys;
  if (explicit && typeof explicit === 'object') {
    for (const provider of SEARCH_PROVIDERS) {
      const value = String(explicit[provider] ?? '').trim();
      if (value) keys[provider] = value;
    }
  }
  // 单个 `searchApiKey` 是"通用密钥"的简写：
  //   - searchProvider 明确指定了某一家 → 就喂给它；
  //   - 否则（auto / scrape / 没填）→ 喂给优先级最高、且还没有专属密钥的那家。
  const single = String(config.searchApiKey ?? '').trim();
  if (single) {
    const wanted = SEARCH_PROVIDERS.includes(config.searchProvider) ? config.searchProvider : null;
    const target = wanted ?? SEARCH_PROVIDERS.find((provider) => !keys[provider]) ?? SEARCH_PROVIDERS[0];
    if (target && !keys[target]) keys[target] = single;
  }
  return keys;
}

/**
 * 决定这一轮用哪个后端。
 *
 * 规则（用户已拍板的口径）：
 *   - `searchProvider = 'auto'`（默认）：**有 key 就用 API**（按 tavily → brave → serper → bing 优先），
 *     一个 key 都没有就退回解析结果页；
 *   - `searchProvider = 'tavily'|'brave'|'serper'|'bing'`：指定的那家有 key 就用它；
 *     没 key 则退到"其它有 key 的"；再没有就退回结果页，并在 reason 里说明；
 *   - `searchProvider = 'scrape'`：强制只解析结果页（哪怕配了 key）。
 *
 * @returns {{kind:'api'|'scrape', id:string, providers:string[], reason:string}}
 */
export function resolveSearchBackend(config = {}) {
  const wanted = String(config.searchProvider ?? 'auto').trim().toLowerCase();
  const keys = normalizeSearchKeys(config);
  const available = SEARCH_PROVIDERS.filter((provider) => keys[provider]);

  if (wanted === 'scrape') {
    return {
      kind: 'scrape',
      id: 'scrape',
      providers: SCRAPE_ENGINES.map((engine) => engine.id),
      reason: '配置要求只用结果页解析（searchProvider=scrape），不调用搜索 API',
    };
  }

  if (SEARCH_PROVIDERS.includes(wanted)) {
    if (keys[wanted]) {
      return { kind: 'api', id: wanted, providers: [wanted], reason: `使用已配置密钥的 ${API_PROVIDERS[wanted].label}` };
    }
    const fallback = available[0];
    if (fallback) {
      return {
        kind: 'api',
        id: fallback,
        providers: [fallback],
        reason: `指定了 ${wanted} 但没有它的密钥；改用已有密钥的 ${API_PROVIDERS[fallback].label}`,
      };
    }
    return {
      kind: 'scrape',
      id: 'scrape',
      providers: SCRAPE_ENGINES.map((engine) => engine.id),
      reason: `指定了 ${wanted} 但没有配置任何搜索 API 密钥 → 退回解析结果页`,
    };
  }

  if (available.length) {
    return {
      kind: 'api',
      id: available[0],
      providers: [available[0]],
      reason: `自动选择：${API_PROVIDERS[available[0]].label}（检测到已配置密钥）`,
    };
  }

  return {
    kind: 'scrape',
    id: 'scrape',
    providers: SCRAPE_ENGINES.map((engine) => engine.id),
    reason: '没有配置任何搜索 API 密钥 → 解析公共搜索引擎结果页（Bing 优先，失败退百度）',
  };
}

/** 调一家 API。失败返回 `{ items: [], error }`，由上层决定是否降级。 */
async function callApiProvider(provider, { query, limit, key, fetchImpl, endpoints = {} }) {
  const spec = API_PROVIDERS[provider];
  const endpoint = endpoints[provider] ?? spec.endpoint;
  const url = spec.url ? spec.url(endpoint, query, limit) : endpoint;
  const init = spec.build(query, limit, key);
  const response = await requestText(fetchImpl, url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    accept: 'application/json',
  });
  if (!response.ok) {
    return { items: [], error: `${spec.label} 请求失败：${response.error ?? `HTTP ${response.status}`}` };
  }
  let json;
  try {
    json = JSON.parse(response.body);
  } catch (error) {
    return { items: [], error: `${spec.label} 返回的不是合法 JSON（${error.message}），可能被网关/风控拦了` };
  }
  if (json?.error || json?.message) {
    // 上游把错误放在 200 的 body 里（Serper/百度系常见），这里必须当失败处理
    const message = json.error?.message ?? json.error ?? json.message;
    return { items: [], error: `${spec.label} 返回错误：${String(message).slice(0, 200)}` };
  }
  let items = [];
  try {
    items = spec.parse(json) ?? [];
  } catch (error) {
    return { items: [], error: `${spec.label} 结果结构不符合预期（${error.message}）` };
  }
  return { items, error: null };
}

// ---------------------------------------------------------------------------
// 去重 / 过滤
// ---------------------------------------------------------------------------

/** 统一把一条候选收敛成 `{title,url,snippet,source,scope}`，垃圾直接丢掉。 */
function normalizeResult(raw, scope) {
  if (!raw) return null;
  const url = String(raw.url ?? '').trim();
  if (!url || isJunkUrl(url)) return null;
  const title = collapseInline(raw.title ?? '');
  if (!title) return null;
  return {
    title,
    url,
    snippet: collapseInline(raw.snippet ?? '').slice(0, 400),
    source: String(raw.source ?? 'unknown'),
    scope,
  };
}

/** 去重（按 canonicalUrl）+ 过滤。campus 档只保留校内站点。 */
export function dedupeResults(items, { scope } = {}) {
  const seen = new Set();
  const out = [];
  for (const item of items ?? []) {
    const normalized = normalizeResult(item, item?.scope ?? scope ?? 'web');
    if (!normalized) continue;
    if (normalized.scope === 'campus' && !isCampusUrl(normalized.url)) continue;
    const key = canonicalUrl(normalized.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 校园网探测
// ---------------------------------------------------------------------------

/**
 * 探测校内域名是否可达。
 *
 * **只能判断「可达」**：任何一个探测目标给出响应（哪怕 401/403/302）就算可达；
 * 全部超时/DNS 失败才算不可达。它**不能证明**当前真的在校园网内 ——
 * 校内站点也可能对公网开放（那就谁都能"可达"），反之校园网内的 DNS/代理异常也会误判。
 * 因此返回值里固定带 `caveat`，调用方（以及模型）都不该把它当成网络位置的证明。
 */
export async function detectCampusNetwork({ fetchImpl, probes, timeoutMs = PROBE_TIMEOUT_MS, log } = {}) {
  const warn = makeLogger(log);
  const list = Array.isArray(probes) && probes.length ? probes : CAMPUS_PROBES;
  const settle = await Promise.all(
    list.map(async (probe) => {
      const response = await requestText(fetchImpl, probe.url, { timeoutMs, accept: 'text/html' });
      // 有响应（含 404/403/302）就算可达；`status === 0` 表示压根没连上
      const reachable = response.status > 0;
      return {
        url: probe.url,
        label: probe.label ?? probe.url,
        reachable,
        status: response.status,
        error: reachable ? null : (response.error ?? '无响应'),
      };
    }),
  );

  const reachable = settle.filter((probe) => probe.reachable);
  const unreachable = settle.filter((probe) => !probe.reachable);
  const onCampus = reachable.length > 0;
  const reason = onCampus
    ? `校内站点可达：${reachable.map((probe) => probe.label).join('、')}`
      + (unreachable.length ? `；另有 ${unreachable.length} 个不可达（${unreachable.map((p) => p.label).join('、')}）` : '')
    : `校内站点全部不可达（${unreachable.map((probe) => `${probe.label}: ${probe.error}`).join('；')}）`;
  warn(`campus 探测：${reason}`);

  return {
    onCampus,
    // 字段名直白一点，免得调用方把 onCampus 当成"已确认在校园网"
    onCampusNetwork: onCampus,
    reachable,
    unreachable,
    probes: settle,
    reason,
    caveat: CAMPUS_PROBE_CAVEAT,
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 对外主函数
// ---------------------------------------------------------------------------

/** campus 档的检索词：加 `site:` 收窄到校内站点（已有 site: 就不重复加）。 */
export function campusScopedQuery(query) {
  const text = String(query ?? '').trim();
  if (!text) return text;
  if (/\bsite\s*:/i.test(text)) return text;
  return `${text} site:xjtu.edu.cn`;
}

/**
 * 检索网页，返回候选结果。
 *
 * @param {object} options
 * @param {string} options.query 检索词
 * @param {'web'|'campus'} [options.mode='web'] web=校外全网；campus=校内站点定向（可达时并走公网）
 * @param {number} [options.limit] 最多返回几条（收敛到 5–30，默认取 `config.searchMaxPages`）
 * @param {object} [options.config] AI 配置切片（searchEnabled/searchMaxPages/searchProvider/searchApiKey/searchApiKeys）
 * @param {Function} [options.fetchImpl] 注入的 fetch（测试用本地假服务器）
 * @param {Function|object} [options.log] 日志：函数或 `{warn}` 形状
 * @returns {Promise<Array<{title:string,url:string,snippet:string,source:string,scope:'web'|'campus'}>>}
 */
export async function searchWeb(options = {}) {
  const detailed = await searchWebDetailed(options);
  return detailed.results;
}

/**
 * 与 `searchWeb` 相同，但额外返回诊断信息（后端选择、campus 探测、逐条说明）。
 * 对话层建议用这个：`notes` 可以直接回灌给模型，让它如实说明"为什么没搜到"。
 */
export async function searchWebDetailed({
  query,
  mode = 'web',
  limit,
  config = {},
  fetchImpl,
  log,
  endpoints,
  probes,
  probeCampus = true,
} = {}) {
  const warn = makeLogger(log);
  const notes = [];
  const note = (message, level = 'info') => {
    notes.push(message);
    warn(message, level);
  };

  const text = String(query ?? '').trim();
  const scope = mode === 'campus' ? 'campus' : 'web';
  const max = normalizeSearchLimit(limit, { fallback: config?.searchMaxPages });
  const backend = resolveSearchBackend(config);

  if (!text) {
    note('检索词为空，未发起任何请求（这不是"没有结果"，是"没问问题"）');
    return { query: '', mode: scope, limit: max, backend, campus: null, results: [], notes };
  }
  if (config?.searchEnabled === false) {
    note('设置里的「联网检索」总开关是关闭的（searchEnabled=false），本轮不检索，也不会假装搜到内容');
    return { query: text, mode: scope, limit: max, backend, campus: null, results: [], notes };
  }

  warn(`开始检索：mode=${scope} limit=${max} 后端=${backend.id}（${backend.reason}）`);

  // 没有密钥时把这件事说清楚：用户/模型要知道现在是"免密钥通道"，结果可能更少更糙
  if (backend.kind === 'scrape') note(`未配置搜索 API 密钥，走免密钥通道：${backend.reason}`);

  const apiKeys = normalizeSearchKeys(config);
  const endpointMap = endpoints ?? config?.searchEndpoints ?? {};
  const campusProbeList = probes ?? config?.campusProbes;

  // ---- 决定要跑哪几路检索 -------------------------------------------------
  const tasks = [];
  if (scope === 'campus') {
    tasks.push({ scope: 'campus', query: campusScopedQuery(text) });
  } else {
    tasks.push({ scope: 'web', query: text });
  }

  let campus = null;
  if (scope === 'campus' && probeCampus) {
    campus = await detectCampusNetwork({ fetchImpl, probes: campusProbeList, log: warn });
    if (campus.onCampus) {
      tasks.push({ scope: 'web', query: text });
      note('校内域名可达 → 除校内站点定向检索外，再并走一次公网检索（可达不等于确认在校园网，见 caveat）');
    } else {
      note('校内域名不可达 → 本轮只做校内站点定向检索，不并走公网（可能不在校园网，也可能是探测被拦）');
    }
  }

  // ---- 执行 ---------------------------------------------------------------
  const collected = [];
  for (const task of tasks) {
    let items = [];
    if (backend.kind === 'api') {
      const provider = backend.providers[0];
      const { items: apiItems, error } = await callApiProvider(provider, {
        query: task.query,
        limit: max,
        key: apiKeys[provider],
        fetchImpl,
        endpoints: endpointMap,
      });
      if (error) {
        // API 挂了要**降级**到免密钥通道，而不是直接空手而归 ——
        // 但必须记下原因，免得用户以为"确实没有结果"。
        note(`${error} → 降级到免密钥通道（结果页解析）`);
        items = await scrapeSearch({ query: task.query, limit: max, fetchImpl, endpoints: endpointMap, note });
      } else {
        items = apiItems;
        note(`${backend.id} 返回 ${items.length} 条候选（scope=${task.scope}）`);
      }
    } else {
      items = await scrapeSearch({ query: task.query, limit: max, fetchImpl, endpoints: endpointMap, log: warn, note });
    }
    for (const item of items ?? []) collected.push({ ...item, scope: task.scope });
  }

  const deduped = dedupeResults(collected);
  const results = deduped.slice(0, max);

  if (scope === 'campus' && results.length === 0) {
    note('校内档没有拿到任何结果：可能是校内站点检索被上游丢弃、关键词太窄，或免密钥通道被拦截；请如实告诉用户"没搜到"，不要编造校内链接');
  }
  if (results.length === 0 && collected.length > 0) {
    note(`原始候选 ${collected.length} 条，去重/过滤（广告、站内跳转、非 http 链接）后为空`);
  }

  return { query: text, mode: scope, limit: max, backend, campus, results, notes };
}

// ---------------------------------------------------------------------------
// 读正文
// ---------------------------------------------------------------------------

/** 正文清洗时要整块丢掉的标签（地图/表单/导航这些不是正文）。 */
const DROP_TAGS = 'script|style|noscript|template|svg|canvas|iframe|object|embed|form|nav|header|footer|aside|button|select|option|dialog';

/**
 * HTML → 纯文本。
 * 顺序很重要：先丢整块标签（连带内容），再把块级标签变成换行，最后才剥剩下的标签 ——
 * 反过来的话 `<script>` 里的代码会被当成正文留下来。
 */
export function htmlToText(html) {
  let text = String(html ?? '');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(new RegExp(`<(${DROP_TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, 'gi'), ' ');
  // 被截断的页面常常有**没闭合**的 <script>：上面那条配对失败，这里再兜一刀
  text = text.replace(new RegExp(`<(${DROP_TAGS})\\b[^>]*>[\\s\\S]*$`, 'gi'), ' ');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|li|tr|td|th|h[1-6]|section|article|blockquote|dd|dt|pre|figure)\s*>/gi, '\n');
  text = text.replace(/<[^>]*>/g, ' ');
  return collapseWhitespace(decodeEntities(text));
}

/** 导航噪声行：菜单项、版权页脚、"上一页下一页"这类。只丢**整行都是噪声**的行。 */
const NOISE_LINE_RE = new RegExp(
  [
    '^(?:首页|主页|返回|返回首页|上一页|下一页|更多|查看更多|登录|注册|退出|搜索|菜单|导航|分享|打印|收藏|订阅|首页\\s*›.*)$',
    '^(?:版权所有|Copyright|©|京ICP|陕ICP|沪ICP|粤ICP|公安备案|增值电信)',
    '(?:Powered by|技术支持|网站地图|联系我们|关于我们|隐私政策|用户协议|免责声明)\\s*$',
  ].join('|'),
  'i',
);

/** 一行里塞了 3 段以上极短片段，基本都是导航条（"首页 | 概况 | 师资 | 招生"）。 */
function looksLikeMenuBar(line) {
  const parts = line.split(/[|·›»>/]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) return false;
  return parts.every((part) => part.length <= 8);
}

/** 逐行去噪：丢空行、导航行、菜单条，并合并相邻重复行。 */
export function stripNoiseLines(text) {
  const out = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (line.length < 2) continue;
    if (NOISE_LINE_RE.test(line)) continue;
    if (looksLikeMenuBar(line)) continue;
    if (out.length && out[out.length - 1] === line) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

/** 截断到 `maxChars`，并明确标注"后面还有内容"。 */
export function truncateText(text, maxChars) {
  const source = String(text ?? '');
  const limit = clamp(maxChars, 100, 200_000, READ_MAX_CHARS);
  if (source.length <= limit) return source;
  return `${source.slice(0, limit)}\n…（正文过长，已按设置截断，仅保留前 ${limit} 字）`;
}

/** 一个页面从 HTML 到可给模型看的正文。 */
export function extractPageText(html, { maxChars = READ_MAX_CHARS } = {}) {
  return truncateText(stripNoiseLines(htmlToText(html)), maxChars);
}

/** 读一个页面。**永远不 throw**：失败折叠成 `{ ok:false, error }`。 */
async function readOnePage(result, { fetchImpl, maxChars, timeoutMs }) {
  const { title = '', url = '' } = result ?? {};
  const response = await requestText(fetchImpl, url, { timeoutMs, accept: 'text/html,application/xhtml+xml' });
  if (!response.ok) {
    return { title, url, ok: false, text: '', error: response.error ?? `HTTP ${response.status}` };
  }
  const type = String(response.contentType ?? '').toLowerCase();
  // 非网页正文（PDF/图片/JSON 接口）不硬啃：如实报错，让模型知道"这一页读不了"
  if (type && !/^(?:text\/|application\/(?:xhtml\+xml|xml))/.test(type)) {
    return { title, url, ok: false, text: '', error: `不是网页正文（Content-Type: ${type.split(';')[0]}）` };
  }
  const text = extractPageText(response.body, { maxChars });
  if (!text) {
    return { title, url, ok: false, text: '', error: '页面没有可提取的正文（可能是纯脚本渲染或空页）' };
  }
  return { title, url, ok: true, text, error: null };
}

/**
 * 抓一批网页的正文。
 *
 * - **并发有上限**（默认 3，最大 4）：既避免把目标站打出 429，也避免本地开一堆连接；
 * - **单页失败不影响整批**：失败的那条给 `ok:false` + `error`，其余照常返回，
 *   顺序与入参一致（`Promise.all` 的 map 语义），方便和结果列表对齐；
 * - 每页截断到 `maxChars`（默认 4000 字）。
 *
 * @param {Array<{title?:string,url:string}>} results
 * @param {object} [options]
 * @param {number} [options.limit] 最多读几页（收敛到 1–30）
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.concurrency=3] 并发（收敛到 1–4）
 * @param {number} [options.maxChars=4000]
 * @returns {Promise<Array<{title:string,url:string,ok:boolean,text:string,error:string|null}>>}
 */
export async function readPages(results, options = {}) {
  const { fetchImpl, concurrency, maxChars = READ_MAX_CHARS, timeoutMs = READ_TIMEOUT_MS, log } = options;
  const warn = makeLogger(log);
  const list = (Array.isArray(results) ? results : []).filter((item) => item && typeof item.url === 'string' && item.url);
  const limit = clamp(options.limit, 1, SEARCH_LIMIT_MAX, SEARCH_LIMIT_MAX);
  const targets = list.slice(0, limit);
  const pool = clamp(concurrency, 1, READ_CONCURRENCY_MAX, READ_CONCURRENCY_DEFAULT);
  if (!targets.length) return [];

  const out = new Array(targets.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= targets.length) return;
      try {
        out[index] = await readOnePage(targets[index], { fetchImpl, maxChars, timeoutMs });
      } catch (error) {
        // readOnePage 已经吞了绝大多数异常；这里再兜一层，保证"绝不拖垮整批"
        out[index] = {
          title: targets[index]?.title ?? '',
          url: targets[index]?.url ?? '',
          ok: false,
          text: '',
          error: `读取时发生未预期错误：${error?.message ?? error}`,
        };
      }
      if (!out[index].ok) warn(`读正文失败：${out[index].url} → ${out[index].error}`, 'warn');
    }
  };
  await Promise.all(Array.from({ length: Math.min(pool, targets.length) }, () => worker()));
  return out.filter(Boolean);
}

/**
 * 一步到位：搜 → 读 → 返回可回灌给模型的结构。
 * 对话层最省事的接法就是调它（见文件末尾的接线条）。
 */
export async function searchAndRead({
  query,
  mode = 'web',
  limit,
  config = {},
  fetchImpl,
  log,
  endpoints,
  probes,
  read = true,
  concurrency,
  maxChars = READ_MAX_CHARS,
} = {}) {
  const found = await searchWebDetailed({ query, mode, limit, config, fetchImpl, log, endpoints, probes });
  const pages = read
    ? await readPages(found.results, { limit: found.limit, fetchImpl, concurrency, maxChars, log })
    : [];
  return { ...found, pages };
}

// ---------------------------------------------------------------------------
// 工具描述符 + 系统提示词
// ---------------------------------------------------------------------------

/**
 * `web_search` 工具描述符。
 *
 * `mutates: false` —— 检索是只读动作，任何权限档位（auto/manual/strict）都不该拦它；
 * 真正的"写"发生在模型拿到正文之后按草稿协议走。
 */
export const WEB_SEARCH_TOOL = Object.freeze({
  name: 'web_search',
  title: '联网检索',
  description:
    '联网检索网页：先搜到候选结果（标题 / 真实链接 / 摘要），再抓取正文。'
    + '两种模式：web=校外全网；campus=校内站点定向（收窄到 *.xjtu.edu.cn，校内域名可达时并走公网）。'
    + '返回的都是**真实抓到的**内容；抓不到会明确报错，绝不能凭空写链接。',
  mutates: false,
  params: {
    query: 'string（必填）检索词，中文直接写中文',
    mode: "string?（web=校外全网 / campus=校内；默认 web）",
    limit: `number?（本次最多读几页正文，${SEARCH_LIMIT_MIN}–${SEARCH_LIMIT_MAX}；默认取设置里的「网络搜索最大条数」）`,
  },
});

/** 给系统提示词用的中文说明（`context.search !== 'off'` 时注入）。 */
export const WEB_SEARCH_PROMPT = `【联网检索（web_search）】
- **什么时候该搜**：用户问的是**你不可能知道的最新/本地信息**时——最新政策与通知、教务/学院/研究生院的具体要求、某门课或某位老师的现状、近期新闻、某个网址上写了什么。用户明确说"搜一下""查一下""网上怎么说"时更要搜。
- **什么时候别搜**：纯聊天、写作/翻译/改写、代码与算法、基于本地已有数据（日程/待办/成绩/笔记）能回答的问题。**先看本地数据，本地没有才联网**。
- **怎么用**：需要联网时，按当前对话协议发出一次**联网检索请求**（检索词用关键词组合，别写整句口语；模式按下面那一档）。系统会真的去搜，并把**搜到的真实链接 + 抓到的正文**回灌给你；你**不能**拿记忆里的内容冒充搜索结果，也不要反复发起同一条检索。
- **必须引用真实 URL**：每个结论后面用 markdown 链接写出它来自哪一条结果，形如 [教务处通知](https://dean.xjtu.edu.cn/xxx)。**只允许引用系统真实返回过的 URL**。
- **绝对不许编造链接、标题、日期或引文**。编一个看起来很像的校内链接，比"没查到"糟糕得多。
- **搜不到就直说**：没有结果或检索失败时，如实告诉用户"这次没搜到 / 检索被拦截了"，可以说明你试过什么（例如"没配置搜索 API 密钥、结果页被反爬挡住"），并给出可行的下一步（换个说法再搜、自己打开某网址、等会儿再试）。**不要**用"根据我的知识"来掩盖一次失败的检索。
- **正文与摘要要分清**：只拿到摘要的条目，就说"这条只看到标题与摘要"，不要当成读完了全文。
- **校内信息的边界**：campus 档只保证把检索收窄到校内站点，**不等于**登录了校内系统。需要登录才能看到的成绩、作业、课表，仍然要用本地已同步的数据回答，不要假装看到了网页。`;

/** 三档检索开关对应的提示词（可直接替换 prompt.js 里的 SEARCH_NOTES）。 */
export const WEB_SEARCH_MODE_NOTES = Object.freeze({
  off: `【联网检索：关闭】
- 现在没有联网能力：被问到实时信息（最新政策、新闻、别人的主页、赛事比分…）时，
  如实说明你拿不到实时数据，只能按已有知识回答，并提醒可能不是最新的。
- **不要**编造搜索结果、链接或引用，也不要说"我查到了"。`,
  web: `${WEB_SEARCH_PROMPT}
- 当前档位：**校外网（全网检索）**。`,
  campus: `${WEB_SEARCH_PROMPT}
- 当前档位：**校内网（校内站点定向）**。检索词会自动收窄到 \`*.xjtu.edu.cn\`；
  只有探测到校内域名可达时才会额外并走一次公网检索。**校内域名可达 ≠ 已登录校内系统、也不等于确认在校园网内**，
  涉及需要登录的成绩/作业/课表，仍然用本地已同步的数据回答。`,
});

export default {
  searchWeb,
  searchWebDetailed,
  searchAndRead,
  readPages,
  detectCampusNetwork,
  resolveSearchBackend,
  normalizeSearchLimit,
  isCampusUrl,
  canonicalUrl,
  isJunkUrl,
  dedupeResults,
  htmlToText,
  stripNoiseLines,
  extractPageText,
  truncateText,
  parseBingResults,
  parseBaiduResults,
  detectAntiBot,
  requestText,
  campusScopedQuery,
  WEB_SEARCH_TOOL,
  WEB_SEARCH_PROMPT,
  WEB_SEARCH_MODE_NOTES,
};
