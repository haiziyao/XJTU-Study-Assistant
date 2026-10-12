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
 *   - `campus` ：三条通道，**顺序就是优先级**（见 `searchWebDetailed` 里的执行注释）：
 *                ① **站内直搜**（`searchCampusSites`）：直接打校内站点自己的检索接口，
 *                   命中的才必然是"校内的东西"；
 *                ② **公共结果页**：把检索词收窄到校内站点（`site:` + 校名，见 `campusScopedQuery`），
 *                   覆盖站内直搜够不到的部分（新子站、没有搜索入口的站、需登录的站）；
 *                ③ **mention 兜底分桶**：公网结果里标题/摘要提到本校的算作校内相关，并如实标注来源。
 *                另外：**校内域名探测可达时**再并走一次不分域的公网检索（原来就有的一路）。
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

/**
 * 校内站点直搜配置表（**逐条真机实测过**，不是照模板猜的）。
 *
 * 为什么要有这张表：校内站点绝大多数是同一套「博达 VSB（Visual SiteBuilder）站群」，
 * 检索接口的形状完全一致，站点之间只差三件事 ——
 *   ① 搜索页路径：各站自己起名，实测见过 `search.jsp` / `ssjgy.jsp` / `soso.jsp` / `soso_2.jsp` /
 *      `ss.jsp` / `ssjg.jsp` / `sousuo.jsp`，**猜不得**，只能从首页的 `<form action=…>` 里取；
 *   ② 关键词字段名：多数是 `lucenenewssearchkey`，研究生院是 `lucenenewssearchkeyword`（同一套
 *      cms 的不同版本）。字段名弄错时服务端**不报错**，而是安静地返回一张没有检索结果的默认页 ——
 *      实测「研究生院 + 推免/蓝桥杯/转专业」三个词返回的字节数一模一样，就是这么发现的；
 *   ③ 结果的域名范围：多数站只搜自己（`dean.xjtu.edu.cn`…），门户 `www` 搜的是整个 `*.xjtu.edu.cn`
 *      （实测能搜出 `news.xjtu.edu.cn` 的稿件），所以它多一条 `allowHosts`。
 *
 * 编码：所有实测站点都是 **base64(UTF-8)** 放进表单的隐藏字段，页面里
 * `/system/resource/js/base64.js` 开头就写着「文字采用 UTF-8 方式进行 Base64 编码」。
 * 另有"明文关键词"或"GBK base64"的老写法，但**这 20 个站点里一个都没出现**，所以这里不实现
 * （零依赖环境下做 GBK 编码要自带码表，为一个没实测到的分支塞几百行常量不划算）。
 *
 * 表单还必须带 `_lucenesearchtype=1` 与 `searchScope=0`：实测去掉这两个参数后服务端照样 200，
 * 但返回的是一张"没有检索结果"的默认页 —— 属于"看着成功、其实什么都没搜"的坑。
 *
 * 字段（`working: true` 的条目）：
 *   - `host`      站点主机名，同时用作**结果域名白名单**（只留本站域名下的条目）
 *   - `path`      搜索页路径（含 `wbtreeid`，VSB 用它区分站点/栏目）
 *   - `keyField`  关键词字段名（`lucenenewssearchkey` 或 `lucenenewssearchkeyword`）
 *   - `evidence`  实测日期 + 当时的结果条数（以后站点改版，先看这一行还成不成立）
 *   - `origin`    可选，仅测试注入本地假站点时用；默认 `https://<host>`
 * 字段（`working: false` 的条目）：只有 `id/label/host/reason`，运行时**不会发请求**；
 * 留着是为了下次不用重复试 —— 都是 2026-10-13 实测确认打不通或没有检索入口的。
 */
export const CAMPUS_SITE_SEARCH = Object.freeze([
  {
    id: 'dean', label: '教务处', host: 'dean.xjtu.edu.cn',
    path: '/search.jsp?wbtreeid=1001', keyField: 'lucenenewssearchkey', working: true,
    evidence: '2026-10-13 实测「转专业」15 条、「通知」15 条',
  },
  {
    id: 'gs', label: '研究生院', host: 'gs.xjtu.edu.cn',
    path: '/ssjgy.jsp?wbtreeid=1111', keyField: 'lucenenewssearchkeyword', working: true,
    evidence: '2026-10-13 实测「转专业」15 条、「通知」17 条（字段名是全表唯一的 keyword 版）',
  },
  {
    id: 'www', label: '学校门户（覆盖整个 *.xjtu.edu.cn）', host: 'www.xjtu.edu.cn',
    path: '/soso_2.jsp?wbtreeid=1001', keyField: 'lucenenewssearchkey',
    allowHosts: ['xjtu.edu.cn'], working: true,
    evidence: '2026-10-13 实测「转专业」10 条（含 news.xjtu.edu.cn 稿件）；无匹配时会返回一版默认推荐列表',
  },
  {
    id: 'sae', label: '航天航空学院', host: 'sae.xjtu.edu.cn',
    path: '/search.jsp?wbtreeid=1001', keyField: 'lucenenewssearchkey', working: true,
    evidence: '2026-10-13 实测「转专业」15 条（标题在 <h3> 里，日期在 <a> 内的 .a-date 块）',
  },
  {
    id: 'math', label: '数学与统计学院', host: 'math.xjtu.edu.cn',
    path: '/ssjgy.jsp?wbtreeid=1213', keyField: 'lucenenewssearchkey', working: true,
    evidence: '2026-10-13 实测「转专业」18 条、「通知」18 条',
  },
  {
    id: 'news', label: '新闻网', host: 'news.xjtu.edu.cn',
    path: '/xmb/ssjgg.jsp?wbtreeid=1001', keyField: 'lucenenewssearchkey', working: true,
    evidence: '2026-10-13 实测「转专业」8 条（每条带摘要，链接是 ../info/… 相对路径）',
  },
  {
    id: 'pksy', label: '彭康书院', host: 'pksy.xjtu.edu.cn',
    path: '/search.jsp?wbtreeid=1001', keyField: 'lucenenewssearchkey', working: true,
    evidence: '2026-10-13 实测「转专业」15 条（结果容器写成大写 <UL>）',
  },
  {
    id: 'wen', label: '文治书院', host: 'wen.xjtu.edu.cn',
    path: '/ssjg.jsp?wbtreeid=1001', keyField: 'lucenenewssearchkey', working: true,
    evidence: '2026-10-13 实测「转专业」15 条（日期和标题挤在同一个 <a> 里）',
  },
  {
    id: 'zlsy', label: '宗濂书院', host: 'zlsy.xjtu.edu.cn',
    path: '/ss.jsp?wbtreeid=1001', keyField: 'lucenenewssearchkey', working: true,
    evidence: '2026-10-13 实测「转专业」15 条',
  },
  {
    id: 'nanyang', label: '南洋书院', host: 'nanyang.xjtu.edu.cn',
    path: '/search.jsp?wbtreeid=1047', keyField: 'lucenenewssearchkey', working: true,
    evidence: '2026-10-13 实测「转专业」15 条',
  },
  {
    id: 'lizhi', label: '励志书院', host: 'lizhi.xjtu.edu.cn',
    path: '/sousuo.jsp?wbtreeid=1001', keyField: 'lucenenewssearchkey', working: true,
    evidence: '2026-10-13 实测「转专业」15 条',
  },
  {
    id: 'bjb', label: '钱学森学院（拔尖计划）', host: 'bjb.xjtu.edu.cn',
    path: '/soso.jsp?wbtreeid=1001', keyField: 'lucenenewssearchkey', working: true,
    evidence: '2026-10-13 实测「转专业」15 条（钱学森书院的内容也在这里）',
  },
  // ---- 以下站点 2026-10-13 实测打不通/没有检索入口：运行时直接跳过，不做无谓请求 ----
  {
    id: 'library', label: '图书馆', host: 'library.xjtu.edu.cn', working: false,
    reason: '域名能解析（202.117.24.24）但 http/https 都 20s 超时，疑似仅校园网内可达，本轮无法确认它有没有检索入口',
  },
  {
    id: 'qianxuesen', label: '钱学森书院', host: 'qianxuesen.xjtu.edu.cn', working: false,
    reason: '域名能解析（202.117.3.253）但连接 20s 超时；书院内容实测能从 www.xjtu.edu.cn/bksy/qxssy.htm 与 bjb.xjtu.edu.cn 搜到',
  },
  {
    id: 'sei', label: '软件学院（sei）', host: 'sei.xjtu.edu.cn', working: false,
    reason: '域名能解析（202.117.54.253）但连接 20s 超时，本轮不可达',
  },
  {
    id: 'eie', label: '电子与信息学部', host: 'eie.xjtu.edu.cn', working: false,
    reason: '首页是 JS 渲染的 VSB「AI 网站」模板（jQuery + home.js 往 #app 里注入正文），HTML 里没有搜索表单，直搜抓不到结果',
  },
  {
    id: 'cssy', label: '崇实书院', host: 'cssy.xjtu.edu.cn', working: false,
    reason: '站点可达（首页 40KB）但整页没有 <form>、也没有 base64.js，没有可调的站内检索接口',
  },
  {
    id: 'lms', label: '思源学堂', host: 'lms.xjtu.edu.cn', working: false,
    reason: '整站 302 到 jAccount 单点登录（identity1.xjtu.edu.cn），没有匿名可用的检索接口',
  },
  {
    id: 'ehall', label: '师生服务大厅', host: 'ehall.xjtu.edu.cn', working: false,
    reason: '跳转到 /new/index.html 的 JS 单页应用且需登录，匿名抓不到任何结果',
  },
]);

/** 站内直搜的站点级并发上限：3。再高容易触发站群 WAF，收益也有限。 */
export const CAMPUS_SEARCH_CONCURRENCY = 3;
/** 单个校内站点检索的超时（比公共搜索短：站点自己的检索通常 1–4s 就有响应）。 */
export const CAMPUS_SITE_TIMEOUT_MS = 6_000;

/**
 * 一条结果"凭什么算校内的"——数值越小越优先（campus 档按它排序）：
 *   - `site`    站内站点自己的检索接口命中（最强：校方发布的内容页）
 *   - `domain`  公共结果页给出的链接落在 `*.xjtu.edu.cn`（域名对，但页面可能是转载/跳板）
 *   - `mention` 公网结果的标题/摘要里提到本校（最弱：只是"提到了"，页面本身在校外）
 *   - `web`     其它公网结果（校内档里排在最后）
 */
export const MATCHED_BY_RANK = Object.freeze({ site: 0, domain: 1, mention: 2, web: 3 });

/** 取一条结果的档位序号（没有 `matchedBy` 的当公网处理）。 */
export function matchedByRank(item) {
  if (!item || item.scope !== 'campus') return MATCHED_BY_RANK.web;
  return MATCHED_BY_RANK[item.matchedBy ?? 'domain'] ?? MATCHED_BY_RANK.domain;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const READ_TIMEOUT_MS = 12_000;
const PROBE_TIMEOUT_MS = 2_500;
/** 单个页面最多读多少字符再清洗（防止一个几 MB 的页面把内存吃满）。 */
const MAX_HTML_BYTES = 1_500_000;

/**
 * 结果页解析必须伪装成浏览器：默认 UA（node）会被搜索引擎直接回验证码，
 * 这不是"绕过反爬"，而是拿回和普通浏览器一样的公开结果页 —— 真被拦时我们照样如实报空。
 *
 * **诚实说明**（2026-10-13 实测）：把 UA/Accept/Accept-Language 都换成浏览器那套之后，
 * `baike.baidu.com` 与 `zhuanlan.zhihu.com` 依然回 **403**（裸头与浏览器头一模一样）——
 * 那是对出口 IP 的风控，不是请求头能解决的。加头能改善的是"普通站点把 node 当爬虫"这一类。
 * 另外：**不带 Cookie、不伪造登录态**，这是底线（要登录的内容不该靠抓）。
 */
const BROWSER_HEADERS = Object.freeze({
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  // 浏览器做文档级导航时一定会带它；不带会显得比浏览器"更可疑"
  'Upgrade-Insecure-Requests': '1',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
});

/**
 * 搜索引擎的跳转链要带上来源站 Referer。
 * 百度/搜狗/360 的自然结果 href 都是自家跳转链（`/link?url=…`、`/link?m=…`），
 * 这类 URL 直接从别处点过去时对方偶尔会 403；带上来源站的 Referer 就正常了。
 */
const ENGINE_REFERERS = Object.freeze([
  ['baidu.com', 'https://www.baidu.com/'],
  ['sogou.com', 'https://www.sogou.com/'],
  ['so.com', 'https://www.so.com/'],
  ['bing.com', 'https://www.bing.com/'],
]);

/** 该 URL 该带哪个 Referer（不是跳转链就返回空串）。 */
export function defaultReferer(raw) {
  const url = parseUrl(raw);
  if (!url) return '';
  const host = url.hostname.toLowerCase();
  for (const [suffix, referer] of ENGINE_REFERERS) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return referer;
  }
  return '';
}

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
  return match ? stripTitleTags(match[1]) : '';
}

function stripTags(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' '));
}

/**
 * 标题/摘要这类"要给人看的一行文本"：标签**直接删掉**，只有块级标签换成空格。
 *
 * 为什么不能统一用 `stripTags`：它把每个标签都换成空格，而检索结果页普遍会把命中关键词的
 * 每个词单独包一层高亮标签（`<em>`、`<strong>`、`<span class="keywordfontcolor…">`），
 * 于是"本科生转专业"会变成"本科生 转 专业"。真网实测：校内 12 个站点里 11 个的标题带高亮 span，
 * 搜狗/360/Bing 也都用 `<em>` 高亮 —— 用错清洗函数会同时毁掉可读性与相关度计算。
 */
function stripTitleTags(html) {
  const text = String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(?:p|div|li|tr|td|th|h[1-6]|section|article|ul|ol|table)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  return collapseInline(decodeEntities(text));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * 统一的一次请求。**永远不 throw**：把失败折叠成 `{ ok:false, error }`，
 * 因为调用方（搜一批页 / 探测一批域名）必须能"一条失败不影响其余"。
 *
 * 请求头默认就是一套浏览器头（见 `BROWSER_HEADERS`）；`referer` 不传时会按 URL 自动判断
 * （搜索引擎跳转链带上来源站，普通站点不带）。**不带 Cookie**，也不伪造登录态。
 */
export async function requestText(fetchImpl, url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    accept = '*/*',
    referer,
  } = options;
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { ok: false, status: 0, url, error: '当前运行环境没有可用的 fetch（Node 版本过低？）' };
  }
  const finalReferer = referer === undefined ? defaultReferer(url) : String(referer ?? '');
  const timer = withTimeout(timeoutMs);
  try {
    const response = await doFetch(url, {
      method,
      headers: {
        ...BROWSER_HEADERS,
        Accept: accept,
        ...(finalReferer ? { Referer: finalReferer } : {}),
        ...headers,
      },
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
  return { href: decodeEntities(match[1]).trim(), text: stripTitleTags(match[2]) };
}

/**
 * href → 绝对 URL。
 *
 * **必须有这一步**：搜狗的自然结果 href 是站内相对路径（`/link?url=…`），
 * 不解析就既过不了 `isJunkUrl`（相对 URL 拿不到 host，一律当垃圾），
 * 也没法在 `readPages` 里 follow —— 实测里这一条会让搜狗"整个引擎一条结果都不剩"。
 */
function absolutize(href, baseUrl) {
  const raw = decodeEntities(String(href ?? '')).trim();
  if (!raw) return '';
  try {
    return new URL(raw, baseUrl || undefined).toString();
  } catch {
    return '';
  }
}

function toResult(anchor, snippet, source, baseUrl = '') {
  if (!anchor?.href || !anchor.text) return null;
  const href = baseUrl ? absolutize(anchor.href, baseUrl) : anchor.href;
  if (!href || isJunkUrl(href)) return null;
  return { title: anchor.text, url: href, snippet: collapseInline(snippet).slice(0, 400), source };
}

/** 解析 Bing 结果页（`<li class="b_algo">…</li>`）。结构变了就返回空数组，由调用方如实报错。 */
export function parseBingResults(html, { baseUrl = '' } = {}) {
  const out = [];
  for (const block of splitBlocks(html, /<li[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>/gi)) {
    if (AD_MARKERS.test(block.header)) continue;
    const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(block.body);
    const anchor = firstAnchor(heading ? heading[1] : block.body);
    const snippet =
      firstText(block.body, /<p\b[^>]*>([\s\S]*?)<\/p>/i) ||
      firstText(block.body, /<div[^>]*class=["'][^"']*b_caption[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) ||
      firstText(block.body, /<div[^>]*class=["'][^"']*b_snippet[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const result = toResult(anchor, snippet, 'bing-html', baseUrl);
    if (result) out.push(result);
  }
  return out;
}

/** 解析百度结果页（`<div class="result c-container">…</div>`）。 */
export function parseBaiduResults(html, { baseUrl = '' } = {}) {
  const out = [];
  for (const block of splitBlocks(html, /<div[^>]*class=["'][^"']*\bresult\b[^"']*["'][^>]*>/gi)) {
    if (AD_MARKERS.test(block.header)) continue;
    const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(block.body);
    const anchor = firstAnchor(heading ? heading[1] : block.body);
    const snippet =
      firstText(block.body, /<div[^>]*class=["'][^"']*c-abstract[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) ||
      firstText(block.body, /<span[^>]*class=["'][^"']*(?:content-right|c-color-text|abstract)[^"']*["'][^>]*>([\s\S]*?)<\/span>/i) ||
      firstText(block.body, /<div[^>]*class=["'][^"']*c-span-last[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const result = toResult(anchor, snippet, 'baidu-html', baseUrl);
    if (result) out.push(result);
  }
  return out;
}

/**
 * 解析搜狗结果页（`<div class="vrwrap">…</div>`）。
 *
 * 真网实测（2026-10-13）结构：
 *   `<div class="vrwrap" id="sogou_vr_30000000_wrap_1"><h3 class="vr-title"><a href="/link?url=…">标题</a></h3>
 *    <div class="fz-mid space-txt base-ellipsis clamp2" id="cacheresult_summary_1">摘要</div>`
 * 自然结果的 href 是**站内相对路径** `/link?url=…` 跳转链（和百度 `www.baidu.com/link?url=` 一个套路）：
 * 这种链接必须先解析成绝对 URL 再保留 —— 相对链接过不了 `isJunkUrl`（拿不到 host，会被当成垃圾），
 * `readPages` 也没法 follow 它。实测口径：这一步不做，搜狗会"整个引擎一条结果都不剩"。
 */
export function parseSogouResults(html, { baseUrl = '' } = {}) {
  const out = [];
  for (const block of splitBlocks(html, /<div[^>]*class=["'][^"']*\bvrwrap\b[^"']*["'][^>]*>/gi)) {
    if (AD_MARKERS.test(block.header)) continue;
    const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(block.body);
    const anchor = firstAnchor(heading ? heading[1] : block.body);
    const snippet =
      firstText(block.body, /<div[^>]*class=["'][^"']*(?:space-txt|fz-mid|str_info|text-layout)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) ||
      firstText(block.body, /<div[^>]*id=["']cacheresult_summary_\d+["'][^>]*>([\s\S]*?)<\/div>/i);
    const result = toResult(anchor, snippet, 'sogou-html', baseUrl);
    if (result) out.push(result);
  }
  return out;
}

/**
 * 解析 360 搜索结果页（`<li class="res-list">…</li>`）。
 *
 * 真网实测（2026-10-13）结构：
 *   `<li class="res-list referer-news-flow"><h3 class="res-title"><a href="https://www.so.com/link?m=…">标题</a></h3>
 *    <p class="res-desc">摘要</p><p class="g-linkinfo"><cite>真实站点</cite></p></li>`
 * 注意两点：① 自然结果是 `so.com/link?m=…` 跳转链（保留，同上）；
 * ② 页面里还有"墨盒卡片"类结果（天气卡等，没有 `res-list` 类），按容器切块时天然不会混进来。
 */
export function parse360Results(html, { baseUrl = '' } = {}) {
  const out = [];
  for (const block of splitBlocks(html, /<li[^>]*class=["'][^"']*\bres-list\b[^"']*["'][^>]*>/gi)) {
    if (AD_MARKERS.test(block.header)) continue;
    const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(block.body);
    const anchor = firstAnchor(heading ? heading[1] : block.body);
    const snippet =
      firstText(block.body, /<p[^>]*class=["'][^"']*res-desc[^"']*["'][^>]*>([\s\S]*?)<\/p>/i) ||
      firstText(block.body, /<div[^>]*class=["'][^"']*res-desc[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const result = toResult(anchor, snippet, '360-html', baseUrl);
    if (result) out.push(result);
  }
  return out;
}

/** 各引擎结果块的"结构指纹"：有它才算拿到了真结果页。 */
const STRUCTURE_MARKERS = Object.freeze({
  bing: /b_algo/i,
  baidu: /\bresult\b/i,
  sogou: /\bvrwrap\b/i,
  so360: /\bres-list\b/i,
});

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

// ---------------------------------------------------------------------------
// 相关度：判断"这一批结果到底有没有答在问题上"
// ---------------------------------------------------------------------------

/**
 * 查询词里的功能词。它们出现在结果里不代表搜到了相关内容 ——
 * 典型的坑是"最近有什么单位来访我们航空航天学院吗"里的"最近/什么/我们/吗"。
 */
const QUERY_STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '与', '及', '或', '有', '没', '不', '也', '都', '就', '还', '又',
  '我', '我们', '你', '你们', '他', '他们', '她', '它', '这', '那', '这个', '那个', '这些', '那些',
  '什么', '怎么', '怎样', '如何', '哪些', '哪个', '哪里', '为什么', '多少', '几', '吗', '呢', '吧',
  '啊', '呀', '哦', '请问', '一下', '一个', '可以', '需要', '应该', '以及', '关于', '对于', '如果',
  // 注意「今天 / 明天 / 今年」这类**不**算功能词：它们出现在结果里是实打实的信息
  //（"西安天气预报**今天**"就靠它把无关的旅游攻略压下去），丢了反而降低区分度
  '最近', '现在', '目前', '有没有', '是不是', '能不能', '怎么样',
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'what', 'how', 'why',
]);

/**
 * 把检索词切成"内容词"。
 *
 * 没有分词器（零依赖）时的取舍：
 *   - 按空白/标点切成 token，丢掉整词都是功能词的 token；
 *   - ASCII/数字 token 长度 ≥ 2 才要（单字母没信息量）；
 *   - **中文长 token 再切成 2 字片段**：中文关键词常常整串写在一起（"航空航天学院"），
 *     整串去比对一个字都不能差，切片段才能量出"覆盖了几成"。
 *     片段会跨词边界（"空航"这种），但它是**所有引擎一起被扣分**，不影响引擎之间的比较。
 *
 * @returns {string[]} 去重后的词表（最多 16 个，够用且让 notes 不至于太长）
 */
export function queryTerms(query, { max = 16 } = {}) {
  const tokens = String(query ?? '')
    .toLowerCase()
    // 检索语法（`site:xjtu.edu.cn` / `filetype:pdf` / `intitle:xx`）是**过滤器**，不是内容词。
    // 不摘掉的话它们会变成 site/xjtu/edu/cn 这样的"查询词"，把覆盖率整体拉低 ——
    // campus 档的检索词天生带 `site:xjtu.edu.cn`，实测会被这套算法误判成"引擎答非所问"。
    .replace(/\b(?:site|filetype|inurl|intitle|inanchor|allintext|allintitle)\s*:\s*\S+/gi, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const terms = new Set();
  for (const token of tokens) {
    if (QUERY_STOPWORDS.has(token)) continue;
    if (/^[a-z0-9]+$/.test(token)) {
      if (token.length >= 2) terms.add(token);
      continue;
    }
    if (token.length <= 3) {
      terms.add(token);
      continue;
    }
    for (let i = 0; i + 2 <= token.length; i += 1) {
      const gram = token.slice(i, i + 2);
      if (!QUERY_STOPWORDS.has(gram)) terms.add(gram);
    }
  }
  return [...terms].slice(0, max);
}

/**
 * 一条结果对查询词的覆盖度 0–1。
 *
 * 权重口径：**命中在标题**里算满分（标题是这条结果在讲什么的最强信号），
 * **只在摘要**里命中打 6 折（摘要常常只是顺带提到），完全没命中算 0 分。
 * 于是"查询词 5 个只命中 1 个"≈0.2，能一眼看出这批结果答非所问。
 */
export function relevanceScore(terms, item = {}) {
  const list = Array.isArray(terms) ? terms : [];
  if (!list.length) return 1; // 查询词全是功能词（例如"最近怎么样"）→ 无从判断，不惩罚
  const title = String(item.title ?? '').toLowerCase();
  const snippet = String(item.snippet ?? '').toLowerCase();
  let hit = 0;
  for (const term of list) {
    if (title.includes(term)) hit += 1;
    else if (snippet.includes(term)) hit += 0.6;
  }
  return Math.min(1, hit / list.length);
}

/** 一批结果的平均覆盖度（**按解析出的全部条目算**，不是只算留下来的那些）。 */
export function averageRelevance(terms, items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return 0;
  const total = list.reduce((sum, item) => sum + relevanceScore(terms, item), 0);
  return total / list.length;
}

/**
 * 免密钥通道选引擎的口径：
 *   - 单引擎平均覆盖度 **≥ 0.5** 就认为"答在问题上了"，立即采用、不再打后面的引擎；
 *   - 低于 0.5 就接着试下一个（最多试 3 个），最后取平均覆盖度最高的那一批；
 *   - 覆盖度为 0 的单条结果**直接丢**（"西安"这类单字命中就是把结果带跑的元凶）。
 */
export const SCRAPE_RELEVANCE_THRESHOLD = 0.5;
export const SCRAPE_MAX_ENGINES = 3;

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

/**
 * 免密钥通道的引擎优先级（2026-10-13 真网实测）。
 *
 * 为什么把 Bing 从第一位挪到第三位：同一条网络下，Bing 的结果页对中文查询给的是**降级结果** ——
 * 实测查询 `西安 天气预报 今天`：Bing（网页与 RSS 都是 10 条）返回的是"西安市_百度百科 / 西安旅游攻略 /
 * 西安市政府 / 百度地图 geocoder"，**一条天气都没有**，而页面标题与搜索框都确认查询词完整送达；
 * 同一时刻搜狗给出"西安天气预报一周,15天…"、360 给出"西安天气预报_15天_45天天气查询…"。
 * 另一组查询"最近有什么单位来访我们航空航天学院吗"也是同样症状（"西安"把结果带跑）。
 * 所以默认按 **搜狗 → 360 → Bing → 百度** 试，并且用相关度而不是固定顺序来决定信谁。
 */
const SCRAPE_ENGINES = Object.freeze([
  {
    id: 'sogou',
    label: '搜狗',
    origin: 'https://www.sogou.com/web',
    params: (query, limit) => ({ query, num: limit }),
    parse: parseSogouResults,
  },
  {
    id: 'so360',
    label: '360 搜索',
    origin: 'https://www.so.com/s',
    params: (query) => ({ q: query }),
    parse: parse360Results,
  },
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

/** 免密钥通道会按顺序试哪些引擎（导出让调用方/界面能如实说明）。 */
export const SCRAPE_ENGINE_IDS = Object.freeze(SCRAPE_ENGINES.map((engine) => engine.id));

/**
 * 按**相关度**在免密钥通道里选引擎，而不是赌固定顺序里的第一个。
 *
 * 规则（详见 `SCRAPE_RELEVANCE_THRESHOLD` 的注释）：
 *   1. 依次试引擎，每个引擎解析完就按 `title + snippet` 算平均覆盖度；
 *   2. 覆盖度 ≥ 阈值 → 立即采用（省掉后面的请求）；
 *   3. 覆盖度 < 阈值 → 记一条"为什么换引擎"，继续试下一个；
 *   4. 最多试 `SCRAPE_MAX_ENGINES` 个；**但如果这 3 个一条可用结果都没给出来**
 *      （全被拦/全是 0 覆盖度），允许再补试剩下的引擎一次 —— "全空"比"多一次请求"糟得多；
 *   5. 覆盖度为 0 的条目一律丢掉，最后返回平均覆盖度最高的那一批；
 *   6. 最好的那批仍低于阈值时**照样返回**（毕竟是真的抓到的），但 notes 里必须写清相关度偏低，
 *      让模型知道"这次没搜准"，而不是把无关结果当成答案。
 */
async function scrapeSearch({ query, limit, fetchImpl, endpoints = {}, note }) {
  const terms = queryTerms(query);
  const attempts = [];
  let best = null;
  let tried = 0;
  /**
   * 本次允许试几个引擎。正常是 `SCRAPE_MAX_ENGINES`（3）；
   * 到上限时如果**一条可用结果都还没拿到**，就把预算放宽 1 —— "空手而归"比"多一次请求"糟得多。
   * 注意放宽的判定放在每次尝试之后（不管这次是成功还是被拦），否则"三个引擎全被墙"这种
   * 最需要兜底的情况反而轮不到第 4 个引擎。
   */
  let budget = Math.min(SCRAPE_MAX_ENGINES, SCRAPE_ENGINES.length);

  while (tried < budget && tried < SCRAPE_ENGINES.length) {
    const engine = SCRAPE_ENGINES[tried];
    tried += 1;
    // 失败原因**立刻**记一条：如果后面的引擎成功了也不能把前面失败的事实吞掉
    // （用户看到的"为什么最后用的是 360 的结果"必须能在日志里找到答案）
    const fail = (reason) => note(`免密钥通道失败：${reason}`, 'warn');
    const url = withParams(endpoints[engine.id] ?? engine.origin, engine.params(query, limit));
    const response = await requestText(fetchImpl, url, { timeoutMs: DEFAULT_TIMEOUT_MS, accept: 'text/html' });
    if (!response.ok) {
      fail(`${engine.label} 请求失败：${response.error ?? `HTTP ${response.status}`}`);
    } else {
      const blocked = detectAntiBot(engine.id, response.status, response.body);
      if (blocked) {
        fail(`${engine.label} 被反爬/改版挡住：${blocked}`);
      } else {
        let items = [];
        try {
          // baseUrl 传的是**响应最终 URL**：搜狗等引擎的结果 href 是相对路径，必须据此解析成绝对链接
          items = engine.parse(response.body, { baseUrl: response.url || url }) ?? [];
        } catch (error) {
          fail(`${engine.label} 解析结果页时抛错：${error.message}`);
          items = [];
        }
        if (!items.length) {
          fail(`${engine.label} 解析出 0 条（页面结构可能已变化）`);
        } else {
          const scored = items.map((item) => ({ item, score: relevanceScore(terms, item) }));
          const kept = scored.filter((entry) => entry.score > 0).map((entry) => entry.item);
          const average = scored.reduce((sum, entry) => sum + entry.score, 0) / scored.length;
          const dropped = items.length - kept.length;
          const hits = terms.length ? `（查询词 ${terms.length} 个，平均覆盖率 ${average.toFixed(2)}）` : '';
          const dropNote = dropped ? `，丢掉 ${dropped} 条覆盖率 0 的结果` : '';
          attempts.push({
            engine: engine.id,
            label: engine.label,
            count: items.length,
            kept: kept.length,
            relevance: Number(average.toFixed(2)),
          });

          if (average >= SCRAPE_RELEVANCE_THRESHOLD && kept.length) {
            note(
              `免密钥通道：结果页解析成功 —— ${engine.label} 给出 ${items.length} 条、平均相关度 ${average.toFixed(2)}${hits}`
              + `${dropNote} → 达到阈值 ${SCRAPE_RELEVANCE_THRESHOLD}，采用它（未配置搜索 API 密钥，走免密钥通道）`,
            );
            return kept;
          }
          note(
            `免密钥通道：${engine.label} 给出 ${items.length} 条，但平均相关度只有 ${average.toFixed(2)}${hits}${dropNote}`
            + ` → 低于阈值 ${SCRAPE_RELEVANCE_THRESHOLD}，换下一个引擎试试`,
            'warn',
          );
          if (!best || average > best.relevance) best = { engine, kept, relevance: average, count: items.length };
        }
      }
    }
    // 到预算了：已经有可用结果就收工，否则放宽 1 再试一个（只放宽一次）
    if (tried >= budget && tried < SCRAPE_ENGINES.length) {
      if (best && best.kept.length) break;
      budget += 1;
      note('免密钥通道：已试的引擎都没给出可用结果 → 再多试一个引擎（最后一搏）');
    }
  }

  if (best && best.kept.length) {
    const perEngine = attempts.map((entry) => `${entry.label} ${entry.relevance.toFixed(2)}`).join(' / ');
    note(
      `免密钥通道：共试了 ${tried} 个引擎（各自相关度：${perEngine}），采用相关度最高的 ${best.engine.label}`
      + `（${best.relevance.toFixed(2)}，共 ${best.count} 条、按相关度保留 ${best.kept.length} 条）。`
      + `**相关度仍低于阈值 ${SCRAPE_RELEVANCE_THRESHOLD}**，这批结果可能答非所问：`
      + '请如实告诉用户"这次没搜准"，可以换个说法再搜，不要硬当成答案。',
      'warn',
    );
    return best.kept;
  }

  note(
    `已尝试免密钥通道（${SCRAPE_ENGINES.slice(0, Math.max(tried, 1)).map((engine) => engine.label).join(' → ')}）都没有取到可用结果 → 返回空数组。`
      + '**这不是「搜到 0 条」，而是「没能取到搜索结果」**：可能被反爬拦截、结果页改版、'
      + '当前网络访问不到这些站点，或者引擎返回的内容与关键词完全对不上（相关度为 0）。',
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

/**
 * 统一把一条候选收敛成 `{title,url,snippet,source,scope}`，垃圾直接丢掉。
 *
 * `matchedBy`（'site' / 'domain' / 'mention'）与 `site`（站内直搜的来源站点 id）是可选字段：
 * **原条目带了才写出去** —— 这两个字段已经在 `dedupeResults` 的既有用例里被
 * `deepStrictEqual` 逐字段比对过，多写一个 `undefined` 键也会让那些断言挂掉。
 */
function normalizeResult(raw, scope) {
  if (!raw) return null;
  const url = String(raw.url ?? '').trim();
  if (!url || isJunkUrl(url)) return null;
  const title = collapseInline(raw.title ?? '');
  if (!title) return null;
  const out = {
    title,
    url,
    snippet: collapseInline(raw.snippet ?? '').slice(0, 400),
    source: String(raw.source ?? 'unknown'),
    scope,
  };
  if (raw.matchedBy) out.matchedBy = String(raw.matchedBy);
  if (raw.site) out.site = String(raw.site);
  return out;
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
// 校内站点直搜（campus 档的第一条通道）
// ---------------------------------------------------------------------------

/**
 * base64(UTF-8)。**零依赖**手写：不用 Buffer（这个模块要在只注入了 fetch 的环境里也能跑），
 * 也不用 `btoa`（它吃 latin1，中文直接抛错）。VSB 前端那个 `base64.js` 干的正是这件事 ——
 * 页面注释原文：「文字采用 UTF-8 方式进行 Base64 编码」。
 */
export function base64Utf8(text) {
  const bytes = [];
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0);
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : alphabet[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : alphabet[b2 & 63];
  }
  return out;
}

/** VSB 命中关键词时会给标题里的关键词套一层高亮 —— 判断"这页到底有没有检索结果"最可靠的信号。 */
const VSB_HIGHLIGHT_RE = /keywordfontcolor\s*\d*|color\s*:\s*#dd4b39/i;
/** 发布日期：`2026-07-31` / `2013.05` / `2026年7月4日` 都认（VSB 各模板写得不一致）。 */
const DATE_RE = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*(?:[-/.月]\s*(\d{1,2})\s*日?)?/;

/** 站点允许出现的结果域名：默认只看自己；门户那种"搜全校"的站点用 `allowHosts` 放宽。 */
function allowedHostsOf(site) {
  const list = Array.isArray(site?.allowHosts) && site.allowHosts.length ? site.allowHosts : [site?.host];
  return list.filter(Boolean).map((host) => String(host).toLowerCase().replace(/^\./, ''));
}

function hostAllowed(host, hosts) {
  return hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * href → 绝对 URL，并且**必须是本站域名下的内容页**，否则返回 null。
 *
 * 丢掉 `.jsp` 链接是这里最要紧的一条经验：VSB 的导航/入口几乎都是 `xynr.jsp?urltype=…`、
 * `index.jsp` 这类脚本页，而检索结果永远是发布出来的内容页（`info/1095/10422.htm`）。
 * 真网实测：教务处那张"没有检索结果"的空页里有 **147 个 `<li>`**，全是导航 ——
 * 不加这条闸门，"搜不到"会被解析成 147 条假结果。
 */
function resolveAllowedUrl(href, baseUrl, hosts) {
  const raw = String(href ?? '').trim();
  if (!raw || raw.startsWith('#') || /^javascript:/i.test(raw)) return null;
  let url;
  try {
    url = new URL(decodeEntities(raw), baseUrl || undefined);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!hostAllowed(url.hostname.toLowerCase(), hosts)) return null;
  if (/\.jsp$/i.test(url.pathname)) return null;
  // 静态资源（.xlsx/.pdf/.jpg…）与"搜索站自己的检索页"在这里一起丢掉，
  // 与 dedupeResults 用的是同一套判据，免得两处口径不一致
  if (isJunkUrl(url.toString())) return null;
  return url.toString();
}

/**
 * 锚文本（标题/摘要）走公共的 `stripTitleTags`（定义在小工具区）：
 * 校内站点的标题同样会被高亮 span 切碎，和搜索引擎结果页是同一个坑。
 */

/** 取 `block` 里所有 `<a>`：href、class、以及**优先取 `<h3>/<h2>` 的锚文本**。 */
function extractAnchors(block) {
  const out = [];
  for (const match of String(block ?? '').matchAll(/<a\b([^>]*)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = `${match[1]} ${match[3]}`;
    const cls = /class=["']([^"']*)["']/i.exec(attrs)?.[1] ?? '';
    const inner = match[4];
    // sae 的模板把日期块也塞在 <a> 里，标题必须取 <h3>，否则会读成"08 201 2012级本科生转专业通知"
    const heading = /<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/i.exec(inner);
    out.push({
      href: match[2],
      cls,
      text: stripTitleTags(heading ? heading[1] : inner),
    });
  }
  return out;
}

/** 结果标题：去掉模板塞进同一段文本里的日期（`2021-05-11 文治书院…` / `转专业指导 2018-11-17`）。 */
function cleanResultTitle(text) {
  const inline = collapseInline(text);
  const stripped = inline
    .replace(/^\s*\d{4}\s*[-/.年]\s*\d{1,2}\s*(?:[-/.月]\s*\d{1,2}\s*日?)?\s*/, '')
    .replace(/\s*\d{4}\s*[-/.年]\s*\d{1,2}\s*(?:[-/.月]\s*\d{1,2}\s*日?)?\s*$/, '');
  return stripped || inline;
}

/** 在一段**已经剥掉标签**的文本里找发布日期；`2013.05` 归一成 `2013-05`。 */
function findDate(text) {
  const match = DATE_RE.exec(String(text ?? ''));
  if (!match) return '';
  const [, year, month, day] = match;
  const mm = String(month).padStart(2, '0');
  return day ? `${year}-${mm}-${String(day).padStart(2, '0')}` : `${year}-${mm}`;
}

/** 页面上所有 `<ul>…</ul>`（大小写不敏感：彭康书院的结果容器就是大写 `<UL>`）。 */
function listBlocks(html) {
  const out = [];
  const open = /<ul\b[^>]*>/gi;
  const close = /<\/ul\s*>/gi;
  for (const match of html.matchAll(open)) {
    close.lastIndex = match.index + match[0].length;
    const end = close.exec(html);
    if (end) out.push(html.slice(match.index, end.index + end[0].length));
  }
  return out;
}

/** 高亮所在的 `<ul>`（大小写不敏感）；取不到返回 null。 */
function enclosingList(html, index) {
  const open = /<ul\b[^>]*>/gi;
  let start = -1;
  for (const match of html.matchAll(open)) {
    if (match.index < index) start = match.index;
    else break;
  }
  if (start < 0) return null;
  const close = /<\/ul\s*>/gi;
  close.lastIndex = index;
  const end = close.exec(html);
  return end ? html.slice(start, end.index + end[0].length) : null;
}

/**
 * 找"结果列表"所在的那段 HTML。两步：
 *   ① 页面里有关键词高亮 → 高亮所在的那个 `<ul>` 就是结果列表（实测 12 个站点全部成立）；
 *   ② 没有高亮（关键词只命中正文，或模板关了高亮）→ 在整页 `<ul>` 里挑**带发布日期条目最多**
 *      的那个。导航菜单不会给每个菜单项配发布日期，所以这条判据简单又稳；
 *      一个都挑不到就返回 null —— 宁可这一站报 0 条，也不把导航菜单当结果交出去。
 */
function pickResultRegion(html) {
  const hit = VSB_HIGHLIGHT_RE.exec(html);
  if (hit) {
    const region = enclosingList(html, hit.index);
    if (region) return region;
  }
  let best = null;
  let bestScore = 0;
  for (const block of listBlocks(html)) {
    let score = 0;
    for (const match of block.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)) {
      if (findDate(stripTags(match[1]))) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = block;
    }
  }
  return bestScore > 0 ? best : null;
}

/**
 * 解析一张 VSB 检索结果页 → `[{title,url,snippet}]`。
 *
 * 无依赖、只看结构，所以**站点改版时它会安静地返回 0 条**（上层会如实记一笔"解析出 0 条"），
 * 而不是编出别的东西来。已适配的模板形态（都是实测过的真页面）：
 *   - `<li><a href="info/1092/10425.htm"><i>[综合通知] </i>标题</a><span>2026-07-31</span></li>`（教务处）
 *   - `<li><span class="time">2026-07-31</span><a href="…">标题</a></li>`（研究生院/彭康/励志/数学院…）
 *   - `<li><a href="…"><div class="a-date"><b>08</b><span>2013.05</span></div><div><h3>标题</h3></div></a></li>`（航天学院）
 *   - `<li><div><a class="y">2026年07</a><a class="r">04</a></div><div><a class="bt">标题</a><a class="zy2">摘要…</a></div></li>`（新闻网，带摘要）
 *
 * @param {string} html 结果页 HTML
 * @param {{baseUrl?:string, allowHosts?:string[]}} [options] `baseUrl` 把相对链接变成绝对链接；
 *        `allowHosts` 是**只保留这些域名**的白名单（一般就是站点自己的 host）
 */
export function parseVsbSearchResults(html, { baseUrl = '', allowHosts = [] } = {}) {
  const source = String(html ?? '');
  const hosts = (Array.isArray(allowHosts) ? allowHosts : [allowHosts])
    .filter(Boolean)
    .map((host) => String(host).toLowerCase().replace(/^\./, ''));
  if (!source || !hosts.length) return [];

  const highlighted = VSB_HIGHLIGHT_RE.test(source);
  const region = pickResultRegion(source);
  if (!region) return [];

  const out = [];
  const seen = new Set();
  for (const match of region.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)) {
    const body = match[1];
    const usable = extractAnchors(body)
      .map((anchor) => ({ ...anchor, abs: resolveAllowedUrl(anchor.href, baseUrl, hosts) }))
      .filter((anchor) => anchor.abs && anchor.text);
    if (!usable.length) continue;

    // 标题锚：优先 class 里带 bt/tit/title 的（新闻网的标题就是 class="bt"），
    // 否则取文字最长的那个（日期锚总是短的）
    const titleAnchor =
      usable.find((anchor) => /(?:^|\s)(?:bt|tit|title)(?:\s|$)/i.test(anchor.cls))
      ?? usable.reduce((best, anchor) => (anchor.text.length > best.text.length ? anchor : best));
    const title = cleanResultTitle(titleAnchor.text);
    if (title.length < 4) continue;

    const date = findDate(stripTags(body));
    // 证据不足就丢：既没有发布日期、整页又没有高亮命中 → 大概率是导航/侧栏，不是检索结果。
    // 这条闸门专治"没搜到却返回一版默认列表"的模板（真网实测：门户 www 对垃圾词返回 10 条无关新闻）
    if (!date && !highlighted) continue;

    const summary = usable
      .filter((anchor) => anchor !== titleAnchor)
      .map((anchor) => collapseInline(anchor.text))
      .filter((line) => line.length >= title.length + 8)
      .sort((a, b) => b.length - a.length)[0];
    const key = canonicalUrl(titleAnchor.abs);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      title,
      url: titleAnchor.abs,
      snippet: collapseInline(summary || (date ? `发布日期：${date}` : '')).slice(0, 400),
    });
  }
  return out;
}

/** 一张站内检索请求的 body：`lucenenewssearchkey=base64(UTF-8)` + 两个必需参数。 */
export function buildCampusSiteSearchBody(site, query) {
  const params = new URLSearchParams();
  params.set(site?.keyField ?? 'lucenenewssearchkey', base64Utf8(query));
  // 实测：缺这两个参数时服务端照样 200，但返回"没有检索结果"的默认页（看着成功、其实没搜）
  params.set('_lucenesearchtype', '1');
  params.set('searchScope', '0');
  return params.toString();
}

/** 某个站点的检索 URL（`origin` 只在测试注入本地假站点时覆盖）。 */
export function buildCampusSiteSearchUrl(site) {
  return new URL(site?.path ?? '/', site?.origin ?? `https://${site?.host}`).toString();
}

/** 查一个站点。**永远不 throw**：请求/解析失败折叠成 `{ok:false, error}`。 */
async function searchOneCampusSite(site, { query, limit, fetchImpl, timeoutMs, log }) {
  const url = buildCampusSiteSearchUrl(site);
  const base = { id: site.id, label: site.label ?? site.host, host: site.host, url };
  const response = await requestText(fetchImpl, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: buildCampusSiteSearchBody(site, query),
    timeoutMs,
    accept: 'text/html',
  });
  if (!response.ok) {
    const error = response.error ?? `HTTP ${response.status}`;
    log(`站内直搜失败：${base.label}（${base.id}）→ ${error}`, 'warn');
    return { ...base, ok: false, count: 0, items: [], error };
  }
  let parsed = [];
  try {
    parsed = parseVsbSearchResults(response.body, {
      baseUrl: response.url || url,
      allowHosts: allowedHostsOf(site),
    });
  } catch (error) {
    const error2 = `解析结果页时抛错：${error?.message ?? error}`;
    log(`站内直搜失败：${base.label}（${base.id}）→ ${error2}`, 'warn');
    return { ...base, ok: false, count: 0, items: [], error: error2 };
  }
  // 最后一道域名闸门：解析器只保证"属于这个站点"，这里再确认它落在 *.xjtu.edu.cn 内
  const items = parsed
    .filter((item) => isCampusUrl(item.url))
    .slice(0, limit)
    .map((item) => ({ ...item, source: 'campus-site', scope: 'campus', matchedBy: 'site', site: site.id }));
  if (!items.length) log(`站内直搜无结果：${base.label}（${base.id}）解析出 0 条`, 'warn');
  return { ...base, ok: true, count: items.length, parsed: parsed.length, items, error: null };
}

/**
 * 校内站点直搜：并发打一批校内站点自己的检索接口（campus 档的第一条通道）。
 *
 * - **站点之间并发、上限 3**（`CAMPUS_SEARCH_CONCURRENCY`）：既快又不容易被站群 WAF 拦；
 * - **单站点失败完全隔离**：超时/500/解析不到只影响它自己，`sites[i].ok === false` + `error` 说原因；
 * - 结果统一带 `scope:'campus'` + `matchedBy:'site'` + `site:'dean'`，一眼能看出这条是
 *   "站内搜出来的"还是"公网结果里提到本校的"；
 * - `working:false` 的站点（实测打不通/没有检索入口）**不发请求**，只记一笔跳过说明。
 *
 * @param {object} options
 * @param {string} options.query 检索词
 * @param {number} [options.limit] 每个站点最多取几条（收敛到 5–30）
 * @param {Function} [options.fetchImpl] 注入的 fetch（测试用本地假站点）
 * @param {Function|object} [options.log] 日志
 * @param {Array} [options.sites] 覆盖站点表（测试用；形状同 `CAMPUS_SITE_SEARCH`）
 * @param {number} [options.concurrency] 并发（收敛到 1–3）
 * @param {number} [options.timeoutMs] 单站点超时
 * @returns {Promise<{query:string, results:Array, sites:Array, notes:string[]}>}
 */
export async function searchCampusSites({
  query,
  limit,
  fetchImpl,
  log,
  sites,
  concurrency,
  timeoutMs = CAMPUS_SITE_TIMEOUT_MS,
} = {}) {
  const warn = makeLogger(log);
  const notes = [];
  const note = (message, level = 'info') => {
    notes.push(message);
    warn(message, level);
  };

  const text = String(query ?? '').trim();
  const list = (Array.isArray(sites) && sites.length ? sites : CAMPUS_SITE_SEARCH)
    .filter((site) => site && site.id && site.host);
  const usable = list.filter((site) => site.working !== false);
  const skipped = list.filter((site) => site.working === false);

  if (!text) {
    note('站内直搜：检索词为空，未发起任何请求');
    return { query: '', results: [], sites: [], notes };
  }
  if (!usable.length) {
    note('站内直搜：配置里没有可用站点，本轮跳过（不代表校内没有内容）');
    return { query: text, results: [], sites: [], notes };
  }

  const perSite = clamp(limit, 1, SEARCH_LIMIT_MAX, SEARCH_LIMIT_DEFAULT);
  const pool = clamp(concurrency, 1, CAMPUS_SEARCH_CONCURRENCY, CAMPUS_SEARCH_CONCURRENCY);
  const reports = new Array(usable.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= usable.length) return;
      const site = usable[index];
      try {
        reports[index] = await searchOneCampusSite(site, {
          query: text,
          limit: perSite,
          fetchImpl,
          timeoutMs,
          log: warn,
        });
      } catch (error) {
        // searchOneCampusSite 已经吞了绝大多数异常；这里再兜一层，保证"一个站点绝不拖垮整批"
        reports[index] = {
          id: site.id,
          label: site.label ?? site.host,
          host: site.host,
          url: buildCampusSiteSearchUrl(site),
          ok: false,
          count: 0,
          items: [],
          error: `检索时发生未预期错误：${error?.message ?? error}`,
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(pool, usable.length) }, () => worker()));

  const settled = reports.filter(Boolean);
  const okSites = settled.filter((report) => report.ok);
  const failed = settled.filter((report) => !report.ok);
  const withHits = okSites.filter((report) => report.items.length);
  const emptySites = okSites.filter((report) => !report.items.length);
  const results = okSites.flatMap((report) => report.items);

  if (results.length) {
    note(`站内直搜命中 ${results.length} 条：${withHits.map((r) => `${r.id} ${r.count} 条`).join('、')}`);
  } else {
    note('站内直搜没有命中任何条目（站点可达但关键词没匹配上，或结果页模板已改版）');
  }
  if (emptySites.length) {
    note(`站内直搜解析出 0 条的站点（可能确实没匹配，也可能模板改版）：${emptySites.map((r) => r.id).join('、')}`);
  }
  for (const report of failed) {
    note(`站内直搜失败：${report.label}（${report.id}）→ ${report.error}`, 'warn');
  }
  if (skipped.length) {
    note(
      `站内直搜跳过 ${skipped.length} 个已知不可用的站点（${skipped.map((site) => site.id).join('、')}）：`
      + '实测打不通或没有检索入口，原因写在 CAMPUS_SITE_SEARCH 表里',
    );
  }

  return { query: text, results, sites: settled, notes };
}

// ---------------------------------------------------------------------------
// 对外主函数
// ---------------------------------------------------------------------------

/** campus 档的检索词：加 `site:` 收窄到校内站点（已有 site: 就不重复加）。 */
/**
 * 校内通道的检索词。
 *
 * `site:xjtu.edu.cn` 是**请求**不是**保证** —— 实测（真网，免密钥通道）Bing 的结果页
 * 对 `site:` 基本不认，返回的仍是各校教务处首页，被 `isCampusUrl` 一过滤就全没了，
 * 于是"校内检索"一条校内结果都没有（而公网结果又混在里面，用户看到的是北大/北航）。
 *
 * 所以这里两手都用上：既带 `site:`（对认它的后端有用），也带学校名（对结果页有用，
 * 让搜索引擎至少把西交大的页面排上来），最后仍由 `isCampusUrl` 做**域名级后置过滤**兜底。
 */
export function campusScopedQuery(query, { school = '西安交通大学' } = {}) {
  const text = String(query ?? '').trim();
  if (!text) return text;
  // 调用方（模型/用户）自己写了 site: 就照它说的做，别擅自改词 —— 它可能就是想精确限定域名
  if (/\bsite\s*:/i.test(text)) return text;
  // 只带 site: 在免密钥通道下实测拿不到校内结果（结果页基本不认这个语法），
  // 所以补上学校名让搜索引擎至少把西交大的页面排上来；域名级过滤仍由 isCampusUrl 兜底
  const withSchool = text.includes(school) ? text : `${text} ${school}`;
  return `${withSchool} site:xjtu.edu.cn`;
}

/**
 * 检索网页，返回候选结果。
 *
 * @param {object} options
 * @param {string} options.query 检索词
 * @param {'web'|'campus'} [options.mode='web'] web=校外全网；campus=校内站点直搜优先（再公共结果页、最后 mention 兜底）
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
  sites,
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
  const campusSiteList = sites ?? config?.campusSites;

  // ---- campus 档第 ① 条通道：站内直搜（三条通道的顺序就是优先级） ----------
  // 为什么它排最前：这是唯一"命中了就必然是校内的东西"的通道 —— 结果直接来自校内站点
  // 自己的检索接口，不可能像公共搜索引擎那样把北大/北航的教务处塞进来。
  // 真网实测（2026-10-13）：12 个站点可直搜，单站 0.3–6.5s，站点级并发 3。
  const collected = [];
  let siteSearch = null;
  if (scope === 'campus') {
    siteSearch = await searchCampusSites({
      query: text,
      limit: max,
      fetchImpl,
      log: warn,
      sites: campusSiteList,
    });
    // searchCampusSites 内部已经逐条 log 过，这里只把 notes 收进本轮结果，避免同一句话打两遍日志
    notes.push(...siteSearch.notes);
    collected.push(...siteSearch.results);
  }

  // ---- 决定还要跑哪几路公共检索 -------------------------------------------
  const tasks = [];
  if (scope === 'campus') {
    // campus 档第 ② 条通道：公共结果页（`site:` 收窄 + 校名）。它是**覆盖补充** ——
    // 新开的子站、没有检索入口的站、要登录才看得到的站，站内直搜都够不到，仍靠它兜一层。
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

  /**
   * 校内档第 ③ 条通道（兜底分桶）：**把公网结果里真正提到本校的那些算作校内相关**。
   *
   * 真网实测过两次：免密钥通道下 `site:xjtu.edu.cn` 与"带学校名"都拦不住结果页 ——
   * 查「教务处 通知」返回的是北大/北航/北理工的教务处首页，校内桶一条都没有，
   * 而用户要的是"校内的东西"。所以这里按**标题/摘要里有没有出现学校名**再分一次桶：
   *   - 命中的标成 `scope: 'campus'`（表示"与本校相关"），并如实说明它是从公网结果里认出来的；
   *   - 没命中的仍留在 `scope: 'web'`，界面与模型都能分清。
   * 这不是"假装校内命中"：站点级/域名级/文本级命中分别记在 `matchedBy` 里，
   * 界面上会写清这条是怎么被认出来的。
   */
  const SCHOOL_RE = /(西安交通大学|西交大|xjtu)/i;
  let results = deduped;
  if (scope === 'campus') {
    results = results.map((item) => {
      if (item.scope === 'campus') return { ...item, matchedBy: item.matchedBy ?? 'domain' };
      const haystack = `${item.title ?? ''} ${item.snippet ?? ''}`;
      if (!SCHOOL_RE.test(haystack)) return item;
      return { ...item, scope: 'campus', matchedBy: 'mention' };
    });
    // 排序：`matchedBy` site > domain > mention > web。`Array#sort` 是稳定的，
    // 所以同一档内保持各通道产出的原有顺序（站内直搜 → 公共结果页 → 公网 mention → 其它公网）。
    // 为什么 site 最优先：站内直搜命中的是校内站点自己发布的内容页；
    // domain 只是"域名看着像校内的"，mention 更是"标题里提了校名" —— 证据强度依次递减。
    results.sort((a, b) => matchedByRank(a) - matchedByRank(b));
    const count = (name) => results.filter((item) => matchedByRank(item) === MATCHED_BY_RANK[name]).length;
    note(
      `校内档分桶（本次候选 ${results.length} 条）：站内直搜 ${count('site')} 条`
      + ` / 公共结果页校内域名 ${count('domain')} 条`
      + ` / 公网提到本校 ${count('mention')} 条`
      + ` / 其它公网 ${count('web')} 条`,
    );
    if (count('mention')) {
      note('其中"公网提到本校"那批是按标题/摘要文本认定的，不是站内页面，引用时要说清来源');
    }
  }
  if (results.length > max) {
    note(`候选共 ${results.length} 条，按本次上限 ${max} 条返回（余下未带回）`);
  }
  results = results.slice(0, max);

  if (scope === 'campus' && results.length === 0) {
    note('校内档没有拿到任何结果：可能校内站点确实没有相关内容、关键词太窄，或免密钥通道被拦截；请如实告诉用户"没搜到"，不要编造校内链接');
  }
  if (results.length === 0 && collected.length > 0) {
    note(`原始候选 ${collected.length} 条，去重/过滤（广告、站内跳转、非 http 链接）后为空`);
  }

  return { query: text, mode: scope, limit: max, backend, campus, siteSearch, results, notes };
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
    + '两种模式：web=校外全网（按相关度自动在搜狗/360/Bing/百度之间选引擎）；'
    + 'campus=校内优先（先直搜校内站点自己的检索接口，再公共结果页，最后把提到本校的公网结果并入，'
    + '每条都标 matchedBy=site|domain|mention）。'
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
- 当前档位：**校内网（校内优先）**。检索按三条通道依次做：① 直接打校内站点自己的检索接口
  （教务处/研究生院/学院/书院等，命中的必然是校方页面）；② 公共结果页（\`site:\` + 校名收窄）；
  ③ 把公网结果里提到本校的并入。每条结果的 \`matchedBy\` 会标明它是怎么被认出来的
  （\`site\` 站内直搜 / \`domain\` 校内域名 / \`mention\` 只是提到了校名），引用时按这个如实说明来源。
  **校内域名可达 ≠ 已登录校内系统、也不等于确认在校园网内**，
  涉及需要登录的成绩/作业/课表，仍然用本地已同步的数据回答。`,
});

export default {
  searchWeb,
  searchWebDetailed,
  searchAndRead,
  readPages,
  detectCampusNetwork,
  searchCampusSites,
  parseVsbSearchResults,
  buildCampusSiteSearchBody,
  buildCampusSiteSearchUrl,
  base64Utf8,
  matchedByRank,
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
  parseSogouResults,
  parse360Results,
  queryTerms,
  relevanceScore,
  averageRelevance,
  defaultReferer,
  detectAntiBot,
  requestText,
  campusScopedQuery,
  CAMPUS_SITE_SEARCH,
  MATCHED_BY_RANK,
  SCRAPE_ENGINE_IDS,
  SCRAPE_RELEVANCE_THRESHOLD,
  SCRAPE_MAX_ENGINES,
  WEB_SEARCH_TOOL,
  WEB_SEARCH_PROMPT,
  WEB_SEARCH_MODE_NOTES,
};
