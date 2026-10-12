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
 *   - 用户在设置页填错 → `save()` 直接抛 `HttpError.badRequest`（`assertAiConfigInput`），
 *     而磁盘/环境变量里读出来的脏值只**静默回落默认值** ——
 *     一份手改坏的配置文件不该让服务起不来。
 */

import path from 'node:path';

import { HttpError } from '../../core/http/router.js';

import { JsonFile } from './secret-store.js';
import { SEARCH_PROVIDERS, normalizeSearchKeys, resolveSearchBackend } from './web-search.js';

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
   * 搜索服务：`auto`（默认，有 key 就用 API）/ `tavily` / `brave` / `serper` / `bing` /
   * `scrape`（强制解析结果页，哪怕配了 key）。
   */
  searchProvider: 'auto',
  /** 单个搜索密钥：配合 `searchProvider` 用；`''` 表示清空。 */
  searchApiKey: '',
  /** 每个服务各自的密钥（优先于 `searchApiKey`）：`{ tavily, brave, serper, bing }`。 */
  searchApiKeys: Object.freeze({}),
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
  'drawMode',
  'searchEnabled',
  'searchMaxPages',
  'searchProvider',
  'searchApiKey',
  'searchApiKeys',
]);

/** 「网络搜索最大条数」的合法区间（与 web-search.js 的 SEARCH_LIMIT_MIN/MAX 一致）。 */
export const SEARCH_MAX_PAGES_MIN = 5;
export const SEARCH_MAX_PAGES_MAX = 30;

/** `searchProvider` 的合法取值：auto + 四家 API + 强制只解析结果页。 */
export const SEARCH_PROVIDER_VALUES = Object.freeze(['auto', 'scrape', ...SEARCH_PROVIDERS]);

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
  const wantedProvider = String(raw.searchProvider ?? base.searchProvider ?? 'auto').trim().toLowerCase();
  out.searchProvider = SEARCH_PROVIDER_VALUES.includes(wantedProvider) ? wantedProvider : 'auto';
  if (raw.searchApiKey !== undefined) out.searchApiKey = raw.searchApiKey;
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
  const effectiveSearchKey = searchKeys[backend.id] ?? '';
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    temperature: config.temperature,
    timeoutMs: config.timeoutMs,
    historyTurns: config.historyTurns,
    drawMode: config.drawMode !== false,
    configured: Boolean(key),
    hasKey: Boolean(key),
    keyHint: key ? `…${key.slice(-4)}` : null,

    // ------------------------------------------------------------ 联网检索
    searchEnabled: config.searchEnabled !== false,
    searchMaxPages: config.searchMaxPages,
    searchProvider: config.searchProvider,
    /** 这一轮**实际**会用的通道：tavily / brave / serper / bing，或 scrape（免密钥解析结果页）。 */
    searchBackend: backend.id,
    searchBackendReason: backend.reason,
    hasSearchKey: Object.keys(searchKeys).length > 0,
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
 * （`PC_AI_API_KEY` / `PC_AI_BASE_URL` / `PC_AI_MODEL` / … / `PC_AI_SEARCH_*`）。
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
    drawMode: env.PC_AI_DRAW_MODE,
    searchEnabled: env.PC_AI_SEARCH_ENABLED,
    searchMaxPages: env.PC_AI_SEARCH_MAX_PAGES,
    searchProvider: env.PC_AI_SEARCH_PROVIDER,
    searchApiKey: env.PC_AI_SEARCH_API_KEY,
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
