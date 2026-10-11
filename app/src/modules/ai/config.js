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
 *   - 任何错误信息在对外之前都要过 `redactSecret()`，避免上游把 Authorization 回显进报错。
 */

import path from 'node:path';

import { JsonFile } from './secret-store.js';

/** 默认指向 DeepSeek 的 OpenAI 兼容端点；换任何同协议的服务只需改 baseUrl + model。 */
export const AI_DEFAULTS = Object.freeze({
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  timeoutMs: 60_000,
  temperature: 0.3,
  /** 送进模型的历史轮数（一轮 = 一问一答）；0 表示不带历史。 */
  historyTurns: 12,
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
]);

const str = (value) => (value === undefined || value === null ? undefined : String(value).trim());

function num(value, { fallback, min, max }) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

/** 只保留白名单字段，并丢掉空值（这样「没传」与「传了空」都一样=不覆盖）。 */
export function pickAiConfig(input = {}) {
  const out = {};
  for (const key of AI_CONFIG_FIELDS) {
    const value = str(input[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
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
  return out;
}

/** 对外可见的配置：**没有 apiKey 原值**，只有 `hasKey` 与末四位。 */
export function maskAiConfig(config = {}) {
  const key = config.apiKey ?? '';
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    temperature: config.temperature,
    timeoutMs: config.timeoutMs,
    historyTurns: config.historyTurns,
    configured: Boolean(key),
    hasKey: Boolean(key),
    keyHint: key ? `…${key.slice(-4)}` : null,
  };
}

/** 把密钥从任意文本里抹掉（上游报错经常回显请求头）。 */
export function redactSecret(text, secret) {
  const source = String(text ?? '');
  if (!secret) return source;
  return source.split(String(secret)).join('***');
}

/** 从环境变量取配置（`PC_AI_API_KEY` / `PC_AI_BASE_URL` / `PC_AI_MODEL` / …）。 */
export function aiConfigFromEnv(env = process.env) {
  return pickAiConfig({
    provider: env.PC_AI_PROVIDER,
    baseUrl: env.PC_AI_BASE_URL,
    model: env.PC_AI_MODEL,
    apiKey: env.PC_AI_API_KEY,
    timeoutMs: env.PC_AI_TIMEOUT_MS,
    temperature: env.PC_AI_TEMPERATURE,
    historyTurns: env.PC_AI_HISTORY_TURNS,
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
    this.current = normalizeAiConfig({ ...aiConfigFromEnv(this.env), ...saved, ...this.options });
    return this.current;
  }

  get() {
    if (!this.current) this.current = normalizeAiConfig({ ...aiConfigFromEnv(this.env), ...this.options });
    return this.current;
  }

  /** 保存一份补丁（只认白名单字段），返回归一化后的新配置。 */
  async save(patch = {}) {
    const next = normalizeAiConfig(pickAiConfig(patch), this.get());
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
