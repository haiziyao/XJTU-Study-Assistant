/**
 * AI 接入配置：地址、模型、密钥与对话参数。
 *
 * 优先级（高 → 低）：
 *   1. `createServer({ ai: {...} })` 的显式切片 —— 测试与主程序注入用；
 *   2. `data/ai-config.json`（0600）—— 用户在设置里保存的；
 *   3. 环境变量 `PC_AI_*` —— CI / 容器里不想落盘时用；
 *   4. 内置默认值（DeepSeek 的 OpenAI 兼容端点）。
 *
 * 密钥规则：
 *   - **永不通过接口原样返回**，`maskAiConfig()` 只给 `hasKey` 与末四位提示；
 *     搜索用的 `searchApiKey` / `searchApiKeys` 同理（见 `maskAiConfig` 的 searchKeys）；
 *   - 任何错误信息在对外之前都要过 `redactSecret()`，避免上游把 Authorization 回显进报错。
 *
 * 联网检索配置（`search*`）：
 *   - `searchMaxPages`（网络搜索最大条数）**默认 8、只允许 5–30 的整数**；
 *   - `searchRetryMax`（**一个回合内**最多联网检索几次）**默认 3、只允许 1–6 的整数**。
 *     它管的是"这一轮对话里模型能自己重试几次"：每一次 web 查询都会把
 *     `attempt`（第几次）与 `remaining`（还剩几次）回灌给模型，用完就只能收尾作答。
 *     没有它的话，模型搜不到就会一直换关键词重搜，把 8 轮循环烧在一件事上 ——
 *     用户等半天，最后拿到的还是一句"没搜到"；有了上限，最坏情况也停在 6 次以内。
 *   - 用户在设置页填错 → `save()` 直接抛 `HttpError.badRequest`（`assertAiConfigInput`），
 *     而磁盘/环境变量里读出来的脏值只**静默回落默认值** ——
 *     一份手改坏的配置文件不该让服务起不来。
 *
 * 上下文窗口（`contextWindow`）：
 *   - 它**不是**截断规则，而是「上下文占用指示」的**分母**：
 *     真正的截断仍然是 `historyTurns` 条数 + 滚动摘要（见 chat-service）；
 *   - 默认 1_000_000（1M），合法区间 8000–2_000_000，越界同 `searchMaxPages` 的两段式处理；
 *   - 分母由用户填是因为不同模型/端点的窗口差别很大（128K / 1M / 自建代理），
 *     写死一个数只会让百分比长期对不上；`GET /ai/status` 会把它带出去，前端据此算百分比。
 *
 * 一轮最多执行几个操作（`maxActionsPerTurn`）：
 *   - **默认 3**，合法取值是 **1–50** 的整数，另有 **0 = 不限制**；
 *   - 为什么默认 3：这就是本项设置出现之前提示词里写死的那个数 —— 用户没动过设置时，
 *     行为必须与旧版完全一致；3 也确实是"一句话三件事"的常见规模，再多就该分两轮说。
 *   - 为什么 0 表示不限制、而不是 1：1 是一个**真实可选的严格档**（一轮只自动办一件事），
 *     若拿 1 当"不限制"，用户把它从 3 调到 1 时限制会**静默消失**，正好调反；
 *     0 则是"没有上限"的天然哨兵，与 `historyTurns: 0`（不带历史）的口径一致。
 *   - 它只管 **auto（自动审批）档**真正执行的写操作条数：超出的草稿留在 `drafts` 里走
 *     人工确认卡（manual 语义）。manual / strict 档本来就一条都不自动执行，因此不受它约束 ——
 *     草稿列表也不截断，用户自己决定点哪几张。
 *   - 提示词里那一句也由它生成（见 prompt.js），所以"提示"与"真正执行"是同一个数，
 *     不会出现"提示词说最多 3 条，服务端却执行了 5 条"的割裂。
 */

import path from 'node:path';

import { HttpError } from '../../core/http/router.js';

import { JsonFile } from './secret-store.js';
import { SEARCH_PROVIDERS, normalizeSearchKeys, resolveDeepSeekKey, resolveSearchBackend } from './web-search.js';

/** 默认指向 DeepSeek 的 OpenAI 兼容端点；换任何同协议的服务只需改 baseUrl + model。 */
export const AI_DEFAULTS = Object.freeze({
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  // 官方 Chat Completions 的合法取值是 deepseek-flash / deepseek-v4-pro；
  // 默认用 flash（快、便宜，而且是**唯一支持看图**的那个）
  model: 'deepseek-flash',
  timeoutMs: 60_000,
  temperature: 0.3,
  /** 送进模型的历史轮数（一轮 = 一问一答）；0 表示不带历史。 */
  historyTurns: 12,
  /**
   * 上下文窗口上限（token）：**只作为「已用多少 / 上限」里的分母**。
   *
   * 为什么需要它：窗口截断一直按 `historyTurns` 条数 + 滚动摘要走，于是"现在这轮到底占了多少窗口"
   * 在界面上完全不可见；要显示一个百分比就必须有个分母。不同端点差别很大（128K / 1M / 自建代理），
   * 所以做成可配置项，默认 1M。
   */
  contextWindow: 1_000_000,
  /**
   * 是否允许模型输出 ```svg 图形（沿用 dschat2 的 draw_mode 语义，默认开）。
   * 关掉只是"不再主动告诉模型可以画"，用户明说「画个图」时仍会临时开启（见 chat-service）。
   */
  drawMode: true,

  // ---------------------------------------------------------------- 联网检索
  /** 总开关：关掉后 web_search 直接返回空并在日志里说明原因（不会假装搜到）。 */
  searchEnabled: true,
  /** 「网络搜索最大条数」：一次最多读几个网页。**合法区间 5–30**，越界报错。 */
  searchMaxPages: 8,
  /**
   * 「一个回合内最多检索几次」：用户问一件事时，模型最多能发起几次联网检索（含自己重试）。
   * **合法区间 1–6**，默认 3；用完不再执行新的 web 查询，改为把
   * `SEARCH_RETRY_EXHAUSTED` 回灌给模型让它如实收尾（见 chat-service 的检索预算）。
   */
  searchRetryMax: 3,
  /**
   * 搜索服务：`auto`（默认，有 key 就用官方接口）/ `deepseek`（DeepSeek 官方 Search API）/
   * `tavily` / `brave` / `serper` / `bing` / `scrape`（强制解析结果页，哪怕配了 key）。
   *
   * `deepseek` 与 `auto` 用的是**「AI 接入」里的 `apiKey`**（同一个 DeepSeek 账号、同一份账单）；
   * 只有显式选了 `deepseek` 时才允许用 `searchApiKey` 覆盖它（自建代理常见这种需求）。
   */
  searchProvider: 'auto',
  /** 单个搜索密钥：配合 `searchProvider` 用；`''` 表示清空。 */
  searchApiKey: '',
  /** 每个服务各自的密钥（优先于 `searchApiKey`）：`{ tavily, brave, serper, bing }`。 */
  searchApiKeys: Object.freeze({}),
  /**
   * DeepSeek 官方 Search / Fetch 的 API 根地址（可指向自建代理）。
   * 实际端点是 `${searchApiBase}/v1/tools/search` 与 `${searchApiBase}/v1/tools/fetch`。
   */
  searchApiBase: 'https://api.deepseek.com',
  /**
   * 检索时是否让官方接口直接带回全文（请求体 `need_content`，默认 true）。
   *
   * 为什么默认开：官方按**成功请求次数**计费（Search 5 元/1000 次、Fetch 同价），
   * 一次 `search + need_content:true` 拿到 N 条正文，比"search 一次 + 逐页 Fetch N 次"
   * 便宜 N 倍；关掉只在"只要链接和摘要、不想要正文"时才有意义。
   */
  searchNeedContent: true,

  // ---------------------------------------------------------------- 写入执行
  /**
   * 「一轮最多执行几个操作」（auto 档真正落库的写操作条数）。
   * **默认 3 / 合法 1–50 / 0 = 不限制**；超出的草稿留成待确认卡，不静默丢弃。
   * 提示词里那句"一轮最多给 N 条写入草稿"与这里**同源**（见 prompt.js）。
   */
  maxActionsPerTurn: 3,
});

/** 允许被持久化的字段白名单：接口不能往里塞任意键。 */
export const AI_CONFIG_FIELDS = Object.freeze([
  'provider',
  'baseUrl',
  'model',
  'apiKey',
  'timeoutMs',
  'temperature',
  'historyTurns',
  'contextWindow',
  'drawMode',
  'searchEnabled',
  'searchMaxPages',
  'searchRetryMax',
  'searchProvider',
  'searchApiKey',
  'searchApiKeys',
  'searchApiBase',
  'searchNeedContent',
  'maxActionsPerTurn',
]);

/** 「网络搜索最大条数」的合法区间（与 web-search.js 的 SEARCH_LIMIT_MIN/MAX 一致）。 */
export const SEARCH_MAX_PAGES_MIN = 5;
export const SEARCH_MAX_PAGES_MAX = 30;

/**
 * 「一个回合内最多检索几次」的合法区间（`searchRetryMax`）。
 * 下限 1：设成 0 等于把联网关掉 —— 那件事应该由 `searchEnabled` 表达，不该藏在次数里。
 * 上限 6：工具循环本身最多只有 MAX_ROUNDS 轮（见 chat-service），次数比轮数还大就没有意义了。
 */
export const SEARCH_RETRY_MIN = 1;
export const SEARCH_RETRY_MAX = 6;

/**
 * 「上下文窗口上限」的合法区间。
 * 下限 8000：比这更小的窗口连系统提示词都装不下，当分母只会得到一个恒 >100% 的假警报。
 * 上限 2_000_000：留出比 1M 更大的一档（有些代理会聚合出更大的窗口），同时挡住手滑多敲的 0。
 */
export const CONTEXT_WINDOW_MIN = 8_000;
export const CONTEXT_WINDOW_MAX = 2_000_000;

/**
 * 「一轮最多执行几个操作」的合法取值。
 *
 * `0` 单独表示**不限制**（不是"一次也不执行"）：见文件头对"为什么不是用 1 表示不限制"的说明。
 * 上限 50：再往上用户已经分不清一轮里到底写了什么，确认卡也会刷屏；
 * 它挡的是"手滑多敲一个 0"，而不是限制正常使用（默认才 3）。
 */
export const MAX_ACTIONS_UNLIMITED = 0;
export const MAX_ACTIONS_MIN = 1;
export const MAX_ACTIONS_MAX = 50;

/** `searchProvider` 的合法取值：auto + DeepSeek 官方 + 四家 API + 强制只解析结果页。 */
export const SEARCH_PROVIDER_VALUES = Object.freeze(['auto', 'scrape', 'deepseek', ...SEARCH_PROVIDERS]);

const str = (value) => (value === undefined || value === null ? undefined : String(value).trim());

/**
 * 早期版本用过的模型名，现在官方已不再接受（当前合法值只有 deepseek-flash / deepseek-v4-pro）。
 * 老配置里存着它们的话，请求会被上游拒绝 —— 所以自动迁移。
 */
const LEGACY_MODEL_ALIASES = Object.freeze({
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
});

/**
 * 只对**官方端点**做迁移。
 * 自建/代理端点完全可能仍然提供名为 `deepseek-chat` 的模型，那就不能动人家的配置。
 */
function isOfficialDeepSeekEndpoint(baseUrl) {
  try {
    return new URL(baseUrl).hostname === 'api.deepseek.com';
  } catch {
    return false;
  }
}

/** 宽松布尔：表单/环境变量传来的 "true"/"1"/"on" 都算真。 */
function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function num(value, { fallback, min, max }) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

/**
 * 「网络搜索最大条数」的宽松归一化：取整 + 收敛到 5–30。
 * 注意与 `assertAiConfigInput` 的分工：那边抛 400 拦住用户输入，这边只保证**内部一定合法**。
 */
function normSearchMaxPages(value, fallback = AI_DEFAULTS.searchMaxPages) {
  const base = num(fallback, { fallback: AI_DEFAULTS.searchMaxPages, min: SEARCH_MAX_PAGES_MIN, max: SEARCH_MAX_PAGES_MAX });
  const parsed = num(value, { fallback: base, min: SEARCH_MAX_PAGES_MIN, max: SEARCH_MAX_PAGES_MAX });
  return Math.min(SEARCH_MAX_PAGES_MAX, Math.max(SEARCH_MAX_PAGES_MIN, Math.trunc(parsed)));
}

/**
 * 「一个回合内最多检索几次」的宽松归一化：取整 + 收敛到 1–6。
 * 与 `normSearchMaxPages` 同款分工：越界/脏值静默回落默认，只保证**内部一定合法**。
 */
function normSearchRetryMax(value, fallback = AI_DEFAULTS.searchRetryMax) {
  const base = num(fallback, { fallback: AI_DEFAULTS.searchRetryMax, min: SEARCH_RETRY_MIN, max: SEARCH_RETRY_MAX });
  const parsed = num(value, { fallback: base, min: SEARCH_RETRY_MIN, max: SEARCH_RETRY_MAX });
  return Math.min(SEARCH_RETRY_MAX, Math.max(SEARCH_RETRY_MIN, Math.trunc(parsed)));
}

/**
 * `searchApiBase` 的宽松归一化：不是合法的 http(s) 根地址就回落默认。
 * **不在末尾保留斜杠**：拼接 `/v1/tools/search` 时不能出现 `//v1`。
 */
function normSearchApiBase(value, fallback = AI_DEFAULTS.searchApiBase) {
  const base = String(fallback ?? AI_DEFAULTS.searchApiBase).trim().replace(/\/+$/, '') || AI_DEFAULTS.searchApiBase;
  const text = str(value);
  if (!text) return base;
  try {
    const url = new URL(text);
    if (!/^https?:$/.test(url.protocol) || !url.hostname) return base;
    return text.replace(/\/+$/, '');
  } catch {
    return base;
  }
}

/**
 * 「上下文窗口上限」的宽松归一化：取整 + 收敛到 8000–2_000_000。
 * 与 `normSearchMaxPages` 同款：磁盘/环境变量里的脏值静默回落，服务照常起来。
 */
function normContextWindow(value, fallback = AI_DEFAULTS.contextWindow) {
  const base = num(fallback, { fallback: AI_DEFAULTS.contextWindow, min: CONTEXT_WINDOW_MIN, max: CONTEXT_WINDOW_MAX });
  const parsed = num(value, { fallback: base, min: CONTEXT_WINDOW_MIN, max: CONTEXT_WINDOW_MAX });
  return Math.min(CONTEXT_WINDOW_MAX, Math.max(CONTEXT_WINDOW_MIN, Math.trunc(parsed)));
}

/**
 * 「一轮最多执行几个操作」的宽松归一化：取整，只接受 **0 或 1–50**。
 *
 * 0 是合法值（不限制），不能像 `normSearchRetryMax` 那样把下界写成 1 —— 那会把
 * "用户明确关掉了限制"悄悄变成"一轮只办一件"，正好是相反的意思。
 * 磁盘/环境变量里的脏值（负数、51、非数字）静默回落默认 3，服务照常起来；
 * 用户在设置页填的越界值则由 `assertAiConfigInput` 抛 400。
 *
 * 导出给 prompt.js 用：提示词必须和真正执行用同一个数，不能让"默认值"有两份。
 */
export function normalizeMaxActionsPerTurn(value, fallback = AI_DEFAULTS.maxActionsPerTurn) {
  const parse = (input) => {
    // min 用 0 同时接住 0 与 1–50；小数先通过区间判断，再统一取整
    const parsed = num(input, { fallback: null, min: MAX_ACTIONS_UNLIMITED, max: MAX_ACTIONS_MAX });
    return parsed === null ? null : Math.trunc(parsed);
  };
  return parse(value) ?? parse(fallback) ?? AI_DEFAULTS.maxActionsPerTurn;
}

/**
 * 搜索密钥表：只认四家 provider。
 * **显式给空串/null = 清掉这一家的密钥**（区别于"根本没传这个字段"=不动它），
 * 于是设置页可以只提交"被改动的那一家"。
 */
function pickSearchApiKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const provider of SEARCH_PROVIDERS) {
    if (!Object.prototype.hasOwnProperty.call(value, provider)) continue;
    out[provider] = str(value[provider]) ?? '';
  }
  return out;
}

/** 只保留白名单字段，并丢掉空值（这样「没传」与「传了空」都一样=不覆盖）。 */
export function pickAiConfig(input = {}) {
  const out = {};
  for (const key of AI_CONFIG_FIELDS) {
    // `searchApiKeys` 是**对象**，不能走 str()（否则变成 "[object Object]"）
    if (key === 'searchApiKeys') {
      const keys = pickSearchApiKeys(input[key]);
      if (keys !== undefined) out[key] = keys;
      continue;
    }
    const value = str(input[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * 严格校验**用户在设置页填进来的**检索配置；不合格直接 400。
 *
 * 为什么只在这一条路径上严格：这里是人手敲的输入，越界必须当场告诉他；
 * 而磁盘 / 环境变量里的脏值走 `normalizeAiConfig` 的宽松回落 ——
 * 一份手改坏的 ai-config.json 不该让整个服务起不来。
 *
 * 校验通过后**不做类型转换**（转换交给 `normalizeAiConfig`），免得两处口径不一致。
 */
export function assertAiConfigInput(input = {}) {
  if (!input || typeof input !== 'object') return input;

  const pages = input.searchMaxPages;
  if (pages !== undefined && pages !== null && pages !== '') {
    const value = Number(pages);
    if (!Number.isFinite(value)) {
      throw HttpError.badRequest(`网络搜索最大条数必须是数字，收到 ${JSON.stringify(pages)}`, { field: 'searchMaxPages' });
    }
    if (!Number.isInteger(value)) {
      throw HttpError.badRequest(`网络搜索最大条数必须是整数，收到 ${value}`, { field: 'searchMaxPages' });
    }
    if (value < SEARCH_MAX_PAGES_MIN || value > SEARCH_MAX_PAGES_MAX) {
      throw HttpError.badRequest(
        `网络搜索最大条数只能是 ${SEARCH_MAX_PAGES_MIN}–${SEARCH_MAX_PAGES_MAX} 之间的整数，收到 ${value}`,
        { field: 'searchMaxPages' },
      );
    }
  }

  // 检索次数预算：越界同样当场 400。它不是"可选的高级项"——
  // 设成 0 会让模型一次都搜不了（用户以为开着联网却永远搜不到），必须拦下来。
  const retries = input.searchRetryMax;
  if (retries !== undefined && retries !== null && retries !== '') {
    const value = Number(retries);
    if (!Number.isFinite(value)) {
      throw HttpError.badRequest(`检索重试上限必须是数字，收到 ${JSON.stringify(retries)}`, { field: 'searchRetryMax' });
    }
    if (!Number.isInteger(value)) {
      throw HttpError.badRequest(`检索重试上限必须是整数，收到 ${value}`, { field: 'searchRetryMax' });
    }
    if (value < SEARCH_RETRY_MIN || value > SEARCH_RETRY_MAX) {
      throw HttpError.badRequest(
        `检索重试上限只能是 ${SEARCH_RETRY_MIN}–${SEARCH_RETRY_MAX} 之间的整数，收到 ${value}`,
        { field: 'searchRetryMax' },
      );
    }
  }

  // 上下文窗口上限：它是「用量百分比」的分母，填错了指示会长期失真，所以同样当场 400。
  const window = input.contextWindow;
  if (window !== undefined && window !== null && window !== '') {
    const value = Number(window);
    if (!Number.isFinite(value)) {
      throw HttpError.badRequest(`上下文上限必须是数字，收到 ${JSON.stringify(window)}`, { field: 'contextWindow' });
    }
    if (!Number.isInteger(value)) {
      throw HttpError.badRequest(`上下文上限必须是整数，收到 ${value}`, { field: 'contextWindow' });
    }
    if (value < CONTEXT_WINDOW_MIN || value > CONTEXT_WINDOW_MAX) {
      throw HttpError.badRequest(
        `上下文上限只能是 ${CONTEXT_WINDOW_MIN}–${CONTEXT_WINDOW_MAX} 之间的整数（token），收到 ${value}`,
        { field: 'contextWindow' },
      );
    }
  }

  // 「一轮最多执行几个操作」：0 合法（不限制），1–50 合法；负数 / 51 / 小数 / 非数字一律 400。
  // 它是 auto 档真正落库的条数上限，填错会让"以为只办 3 件、结果办了 30 件"，所以必须当场拦住。
  const actions = input.maxActionsPerTurn;
  if (actions !== undefined && actions !== null && actions !== '') {
    // 布尔值不能当数字收：`Number(false) === 0` 会把它悄悄解释成"不限制"，
    // 而 `pickAiConfig` 存的是 "false"（归一化时又回落 3）—— 两边不一致必须当场拦住。
    const value = typeof actions === 'boolean' ? Number.NaN : Number(actions);
    if (!Number.isFinite(value)) {
      throw HttpError.badRequest(`一轮最多执行几个操作必须是数字，收到 ${JSON.stringify(actions)}`, {
        field: 'maxActionsPerTurn',
      });
    }
    if (!Number.isInteger(value)) {
      throw HttpError.badRequest(`一轮最多执行几个操作必须是整数，收到 ${value}`, { field: 'maxActionsPerTurn' });
    }
    if (value !== MAX_ACTIONS_UNLIMITED && (value < MAX_ACTIONS_MIN || value > MAX_ACTIONS_MAX)) {
      throw HttpError.badRequest(
        `一轮最多执行几个操作只能是 0（不限制）或 ${MAX_ACTIONS_MIN}–${MAX_ACTIONS_MAX} 之间的整数，收到 ${value}`,
        { field: 'maxActionsPerTurn' },
      );
    }
  }

  const provider = input.searchProvider;
  if (provider !== undefined && provider !== null && provider !== '') {
    const value = String(provider).trim().toLowerCase();
    if (!SEARCH_PROVIDER_VALUES.includes(value)) {
      throw HttpError.badRequest(
        `搜索服务只能是 ${SEARCH_PROVIDER_VALUES.join(' / ')}，收到 ${JSON.stringify(provider)}`,
        { field: 'searchProvider' },
      );
    }
  }

  const enabled = input.searchEnabled;
  if (enabled !== undefined && enabled !== null && enabled !== '') {
    const text = String(enabled).trim().toLowerCase();
    const legal = typeof enabled === 'boolean' || ['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off'].includes(text);
    if (!legal) {
      throw HttpError.badRequest(`联网检索开关只能是 true / false，收到 ${JSON.stringify(enabled)}`, { field: 'searchEnabled' });
    }
  }

  // DeepSeek 官方搜索的根地址：必须是 http(s) 且带 host（拼接时会直接接 `/v1/tools/...`）
  const apiBase = input.searchApiBase;
  if (apiBase !== undefined && apiBase !== null && apiBase !== '') {
    if (typeof apiBase !== 'string') {
      throw HttpError.badRequest('搜索 API 地址必须是字符串', { field: 'searchApiBase' });
    }
    let parsed;
    try {
      parsed = new URL(apiBase.trim());
    } catch {
      parsed = null;
    }
    if (!parsed || !/^https?:$/.test(parsed.protocol) || !parsed.hostname) {
      throw HttpError.badRequest(
        `搜索 API 地址必须是带主机名的 http(s) 地址，收到 ${JSON.stringify(apiBase)}`,
        { field: 'searchApiBase' },
      );
    }
  }

  // need_content 是布尔开关：只接受 0/1 与 true/false 这几种写法
  const needContent = input.searchNeedContent;
  if (needContent !== undefined && needContent !== null && needContent !== '') {
    const text = String(needContent).trim().toLowerCase();
    const legal = typeof needContent === 'boolean' || ['1', 'true', 'yes', 'on', '0', 'false', 'no', 'off'].includes(text);
    if (!legal) {
      throw HttpError.badRequest(`need_content 开关只能是 true / false，收到 ${JSON.stringify(needContent)}`, { field: 'searchNeedContent' });
    }
  }

  const keys = input.searchApiKeys;
  if (keys !== undefined && keys !== null) {
    if (typeof keys !== 'object' || Array.isArray(keys)) {
      throw HttpError.badRequest('searchApiKeys 必须是「服务名 → 密钥」的对象', { field: 'searchApiKeys' });
    }
    for (const [name, value] of Object.entries(keys)) {
      if (!SEARCH_PROVIDERS.includes(name)) {
        throw HttpError.badRequest(
          `searchApiKeys 里有不认识的服务 ${JSON.stringify(name)}（可选：${SEARCH_PROVIDERS.join(' / ')}）`,
          { field: `searchApiKeys.${name}` },
        );
      }
      if (value === null || value === undefined) continue;
      if (typeof value !== 'string') {
        throw HttpError.badRequest(`searchApiKeys.${name} 必须是字符串`, { field: `searchApiKeys.${name}` });
      }
    }
  }
  return input;
}

/** 归一化：类型、范围、去掉 baseUrl 末尾斜杠；`apiKey: ''` 视为「清空」。 */
export function normalizeAiConfig(input = {}, base = AI_DEFAULTS) {
  const raw = pickAiConfig(input);
  const out = { ...base };
  if (raw.provider) out.provider = raw.provider;
  if (raw.baseUrl) out.baseUrl = raw.baseUrl.replace(/\/+$/, '');
  if (raw.model) out.model = raw.model;
  if (raw.apiKey !== undefined) out.apiKey = raw.apiKey;
  out.timeoutMs = num(raw.timeoutMs, { fallback: base.timeoutMs, min: 1_000, max: 600_000 });
  out.temperature = num(raw.temperature, { fallback: base.temperature, min: 0, max: 2 });
  out.historyTurns = num(raw.historyTurns, { fallback: base.historyTurns, min: 0, max: 100 });
  // 上下文上限只影响「用量指示」的分母，不影响任何截断行为（截断仍看 historyTurns + 摘要）
  out.contextWindow = normContextWindow(raw.contextWindow, base.contextWindow);
  // 一轮最多执行几个操作：宽松归一（0 = 不限制；磁盘/环境变量脏值静默回落默认 3）。
  // 真正用它的是 chat-service 的 auto 档执行循环，提示词里那句也由同一个值生成。
  out.maxActionsPerTurn = normalizeMaxActionsPerTurn(raw.maxActionsPerTurn, base.maxActionsPerTurn);
  // 布尔字段：pickAiConfig 已把它转成字符串，这里再解释一次
  out.drawMode = bool(raw.drawMode === undefined ? base.drawMode : raw.drawMode, base.drawMode);

  // ---------------------------------------------------------------- 联网检索
  // 这里全部走**宽松归一化**：越界/不认识的值静默回落默认，服务照常起来。
  // （用户输入那条路径已经在 assertAiConfigInput 里被严格拦过一次了。）
  out.searchEnabled = bool(
    raw.searchEnabled === undefined ? base.searchEnabled : raw.searchEnabled,
    base.searchEnabled !== false,
  );
  out.searchMaxPages = normSearchMaxPages(raw.searchMaxPages, base.searchMaxPages);
  // 检索次数预算：同样宽松归一（磁盘/环境变量脏值静默回落），实际用它的地方在 chat-service
  out.searchRetryMax = normSearchRetryMax(raw.searchRetryMax, base.searchRetryMax);
  const wantedProvider = String(raw.searchProvider ?? base.searchProvider ?? 'auto').trim().toLowerCase();
  out.searchProvider = SEARCH_PROVIDER_VALUES.includes(wantedProvider) ? wantedProvider : 'auto';
  if (raw.searchApiKey !== undefined) out.searchApiKey = raw.searchApiKey;
  // DeepSeek 官方接口地址：脏值/非 http(s) 静默回落默认，保证拼接出来的端点一定可用
  out.searchApiBase = normSearchApiBase(raw.searchApiBase, base.searchApiBase);
  out.searchNeedContent = bool(
    raw.searchNeedContent === undefined ? base.searchNeedContent : raw.searchNeedContent,
    base.searchNeedContent !== false,
  );
  // 每家的密钥按"服务名"**合并**（旧值保留、新值覆盖），这样只改一家的 key 不会把别家清掉；
  // 想清掉某一家就显式传空串（合并后统一把空值剔除）。
  const mergedKeys = { ...(base.searchApiKeys ?? {}), ...(raw.searchApiKeys ?? {}) };
  out.searchApiKeys = Object.fromEntries(
    Object.entries(mergedKeys)
      .map(([provider, key]) => [provider, String(key ?? '').trim()])
      .filter(([, key]) => key),
  );

  // 旧模型名迁移：只在官方端点上做（自建端点可能有同名模型）
  if (isOfficialDeepSeekEndpoint(out.baseUrl) && LEGACY_MODEL_ALIASES[out.model]) {
    out.model = LEGACY_MODEL_ALIASES[out.model];
  }
  return out;
}

/**
 * 对外可见的配置：**没有 apiKey / searchApiKey 原值**，只有 `hasKey` 与末四位。
 * 搜索密钥按服务分别回报（界面要显示"哪家配了、哪家没配"），但**一律只给末四位**。
 */
export function maskAiConfig(config = {}) {
  const key = config.apiKey ?? '';
  const searchKeys = normalizeSearchKeys(config);
  const backend = resolveSearchBackend(config);
  // DeepSeek 官方通道复用 AI 接入的 apiKey：末四位提示也取它，否则界面上会显示"配了 key 但没有提示"。
  // 显式 provider=deepseek 时 searchApiKey 可以覆盖它（见 resolveDeepSeekKey），提示也跟着走。
  const deepseekKey = resolveDeepSeekKey(config);
  const effectiveSearchKey = backend.id === 'deepseek' ? deepseekKey : (searchKeys[backend.id] ?? '');
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    temperature: config.temperature,
    timeoutMs: config.timeoutMs,
    historyTurns: config.historyTurns,
    /** 上下文窗口上限：前端拿它当「已用 / 上限」的分母（见 shell/app.js 的圆环）。 */
    contextWindow: config.contextWindow,
    /**
     * 一轮最多执行几个操作：0 = 不限制，1–50 = 上限（默认 3）。
     * 设置页据此回显，前端不必自己猜默认值。
     */
    maxActionsPerTurn: normalizeMaxActionsPerTurn(config.maxActionsPerTurn),
    drawMode: config.drawMode !== false,
    configured: Boolean(key),
    hasKey: Boolean(key),
    keyHint: key ? `…${key.slice(-4)}` : null,

    // ------------------------------------------------------------ 联网检索
    searchEnabled: config.searchEnabled !== false,
    searchMaxPages: config.searchMaxPages,
    /** 一个回合内最多联网检索几次（界面上的「检索重试上限」）。 */
    searchRetryMax: config.searchRetryMax,
    searchProvider: config.searchProvider,
    /** DeepSeek 官方 Search / Fetch 的根地址（自建代理时与官方不同）。 */
    searchApiBase: config.searchApiBase,
    /** 检索时是否让官方接口直接带回全文（need_content）。 */
    searchNeedContent: config.searchNeedContent !== false,
    /** 这一轮**实际**会用的通道：deepseek / tavily / brave / serper / bing，或 scrape（免密钥解析结果页）。 */
    searchBackend: backend.id,
    searchBackendReason: backend.reason,
    hasSearchKey: Object.keys(searchKeys).length > 0,
    /** DeepSeek 官方搜索复用 AI 接入的 apiKey，所以有没有它要单独说明。 */
    hasDeepSeekKey: Boolean(resolveDeepSeekKey(config)),
    searchKeyHint: effectiveSearchKey ? `…${effectiveSearchKey.slice(-4)}` : null,
    searchKeys: Object.fromEntries(
      SEARCH_PROVIDERS.map((provider) => [
        provider,
        {
          hasKey: Boolean(searchKeys[provider]),
          keyHint: searchKeys[provider] ? `…${searchKeys[provider].slice(-4)}` : null,
        },
      ]),
    ),
  };
}

/** 把密钥从任意文本里抹掉（上游报错经常回显请求头）。 */
export function redactSecret(text, secret) {
  const source = String(text ?? '');
  if (!secret) return source;
  return source.split(String(secret)).join('***');
}

/**
 * 从环境变量取配置
 * （`PC_AI_API_KEY` / `PC_AI_BASE_URL` / `PC_AI_MODEL` / … / `PC_AI_MAX_ACTIONS_PER_TURN` / `PC_AI_SEARCH_*`）。
 * 搜索密钥可以按服务给：`PC_AI_TAVILY_API_KEY` / `PC_AI_BRAVE_API_KEY` /
 * `PC_AI_SERPER_API_KEY` / `PC_AI_BING_API_KEY`，或用一个通用的 `PC_AI_SEARCH_API_KEY`。
 */
export function aiConfigFromEnv(env = process.env) {
  return pickAiConfig({
    provider: env.PC_AI_PROVIDER,
    baseUrl: env.PC_AI_BASE_URL,
    model: env.PC_AI_MODEL,
    apiKey: env.PC_AI_API_KEY,
    timeoutMs: env.PC_AI_TIMEOUT_MS,
    temperature: env.PC_AI_TEMPERATURE,
    historyTurns: env.PC_AI_HISTORY_TURNS,
    contextWindow: env.PC_AI_CONTEXT_WINDOW,
    maxActionsPerTurn: env.PC_AI_MAX_ACTIONS_PER_TURN,
    drawMode: env.PC_AI_DRAW_MODE,
    searchEnabled: env.PC_AI_SEARCH_ENABLED,
    searchMaxPages: env.PC_AI_SEARCH_MAX_PAGES,
    searchRetryMax: env.PC_AI_SEARCH_RETRY_MAX,
    searchProvider: env.PC_AI_SEARCH_PROVIDER,
    searchApiKey: env.PC_AI_SEARCH_API_KEY,
    searchApiBase: env.PC_AI_SEARCH_API_BASE,
    searchNeedContent: env.PC_AI_SEARCH_NEED_CONTENT,
    searchApiKeys: {
      tavily: env.PC_AI_TAVILY_API_KEY,
      brave: env.PC_AI_BRAVE_API_KEY,
      serper: env.PC_AI_SERPER_API_KEY,
      bing: env.PC_AI_BING_API_KEY,
    },
  });
}

/**
 * 配置存储：内存里始终有一份「当前生效的配置」，磁盘上有一份 0600 的副本。
 * 服务层只跟它打交道，因此「改配置」不需要重建 provider。
 */
export class AiConfigStore {
  constructor({ dataDir, options = {}, env = process.env } = {}) {
    this.file = new JsonFile(path.join(dataDir, 'ai-config.json'));
    this.options = pickAiConfig(options);
    this.env = env;
    /** @type {ReturnType<typeof normalizeAiConfig>|undefined} */
    this.current = undefined;
  }

  /** 读盘 + 合并三层来源；读盘失败也不阻塞启动（降级成默认配置）。 */
  async load() {
    const saved = (await this.file.read()) ?? {};
    const fromEnv = aiConfigFromEnv(this.env);
    const before = { ...fromEnv, ...saved, ...this.options };
    // 密钥表**逐家合并**（而不是整份替换）：环境变量里补一家、磁盘上留另一家是很常见的组合
    before.searchApiKeys = { ...(fromEnv.searchApiKeys ?? {}), ...(saved.searchApiKeys ?? {}), ...(this.options.searchApiKeys ?? {}) };
    this.current = normalizeAiConfig(before);
    // 只记住"改过"这件事：配置文件里不写迁移痕迹，免得越攒越脏
    this.migratedFrom = before.model && before.model !== this.current.model ? before.model : null;
    return this.current;
  }

  get() {
    if (!this.current) this.current = normalizeAiConfig({ ...aiConfigFromEnv(this.env), ...this.options });
    return this.current;
  }

  /**
   * 保存一份补丁（只认白名单字段），返回归一化后的新配置。
   *
   * 这是**用户输入**的唯一入口（`POST /ai/config` → chat-service.updateConfig → 这里），
   * 所以越界值在这里抛 `HttpError.badRequest` —— 400 会带着字段名一路回到设置页。
   */
  async save(patch = {}) {
    assertAiConfigInput(patch);
    const clean = pickAiConfig(patch);
    const merged = { ...this.get(), ...clean };
    // `searchApiKeys` 单独**合并**：设置页只改一家时不要把另外三家的密钥抹掉
    if (clean.searchApiKeys) {
      merged.searchApiKeys = { ...(this.get().searchApiKeys ?? {}), ...clean.searchApiKeys };
    }
    const next = normalizeAiConfig(merged);
    this.migratedFrom = merged.model && merged.model !== next.model ? merged.model : null;
    this.current = next;
    await this.file.write(next);
    return next;
  }

  /** 清掉磁盘上的配置（密钥随之失效，环境变量若还在则仍然生效）。 */
  async reset() {
    await this.file.remove();
    this.current = normalizeAiConfig({ ...aiConfigFromEnv(this.env), ...this.options });
    return this.current;
  }
}
