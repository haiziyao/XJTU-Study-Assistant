/**
 * OpenAI 兼容的 chat completions 客户端（DeepSeek / 任何同协议端点都能用）。
 *
 * 为什么自己写而不用 SDK：本项目零运行时依赖，而上游协议就一个 POST + 一列 SSE，
 * 自己实现反而更容易看清「超时、断流、错误码、密钥回显」这几处真正会出事的地方。
 *
 * 约定：
 * - `chat()` 非流式返回整段文本；`stream: true` 时逐块回调 `onDelta`，并返回累计文本；
 * - 上游错误一律翻译成 `502 UPSTREAM_ERROR`（带 `upstreamStatus`），**密钥先抹掉再放进 details**；
 * - 超时用 `AbortController`，错误信息里明说「超时」而不是含糊的连接失败；
 * - 未配置密钥时抛 `501 AI_UNAVAILABLE` —— 与框架里 `/ai/nl2command` 的占位语义一致。
 */

import { ERROR_CODES } from '../../shared/constants.js';
import { HttpError } from '../../core/http/router.js';

import { redactSecret } from './config.js';

/** 上游报错体截断长度：够定位问题，又不至于把整页 HTML 塞进响应。 */
const MAX_ERROR_BODY = 400;

function truncate(text, max = MAX_ERROR_BODY) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function unavailableError(config) {
  return new HttpError(501, ERROR_CODES.AI_UNAVAILABLE, 'AI 尚未配置密钥', {
    hint: '在设置里填 API Key，或 POST /api/v1/ai/config {"apiKey":"sk-…"}；也可以用环境变量 PC_AI_API_KEY。',
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
  });
}

/**
 * 解析 SSE 流：只认 `data:` 行，忽略注释与心跳。
 * 返回累计文本、usage 与结束原因；过程中每块都回调 `onDelta(delta, { text })`。
 */
async function readStream(response, { onDelta, model }) {
  const reader = response.body?.getReader?.();
  if (!reader) throw HttpError.upstream('上游没有返回可读的流');
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage = null;
  let finishReason = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue; // 半行/非 JSON 的心跳，忽略即可
      }
      // 有些服务端会把错误塞进流里（HTTP 200 + {"error":{…}}）
      if (chunk.error) {
        throw HttpError.upstream(`上游在流中报错：${chunk.error.message ?? '未知错误'}`, { upstreamError: chunk.error });
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content ?? choice?.message?.content ?? '';
      if (delta) {
        text += delta;
        onDelta?.(delta, { text });
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }
  }

  return { text, usage, finishReason, model, streamed: true };
}

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig 取当前配置（每次调用都读，改配置无需重建）
 * @param {typeof fetch} [deps.fetchImpl] 注入 fetch，测试用 mock 上游
 */
export function createOpenAiCompatProvider({ getConfig, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('createOpenAiCompatProvider 需要可用的 fetch');

  /** 真正的上游调用，流式/非流式共用入口与错误映射。 */
  async function chat({ messages, temperature, stream = false, onDelta, signal } = {}) {
    const config = getConfig();
    if (!config.apiKey) throw unavailableError(config);
    if (!Array.isArray(messages) || !messages.length) throw HttpError.badRequest('messages 不能为空');

    const controller = new AbortController();
    const timeoutMs = config.timeoutMs;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const forwardAbort = () => controller.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });

    let response;
    try {
      response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: temperature ?? config.temperature,
          stream: Boolean(stream),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const name = error?.name ?? '';
      if (timedOut) {
        throw HttpError.upstream(`等待上游超时（${Math.round(timeoutMs / 1000)} 秒）`, {
          provider: config.provider,
          model: config.model,
          timeoutMs,
        });
      }
      if (name === 'AbortError') throw HttpError.upstream('请求已被取消');
      throw HttpError.upstream(`连不上上游：${redactSecret(error?.message ?? error, config.apiKey)}`, {
        baseUrl: config.baseUrl,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw HttpError.upstream(`上游返回 ${response.status}`, {
        upstreamStatus: response.status,
        provider: config.provider,
        model: config.model,
        body: truncate(redactSecret(bodyText, config.apiKey)),
        hint: response.status === 401 || response.status === 403 ? '检查 API Key 是否正确 / 是否有该模型的权限' : undefined,
      });
    }

    if (!stream) {
      const data = await response.json().catch(() => {
        throw HttpError.upstream('上游返回的不是合法 JSON');
      });
      if (data.error) {
        throw HttpError.upstream(`上游报错：${data.error.message ?? '未知错误'}`, { upstreamError: data.error });
      }
      const choice = data.choices?.[0] ?? {};
      return {
        text: choice.message?.content ?? '',
        model: data.model ?? config.model,
        usage: data.usage ?? null,
        finishReason: choice.finish_reason ?? null,
        streamed: false,
      };
    }

    try {
      return await readStream(response, { onDelta, model: config.model });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (timedOut) {
        throw HttpError.upstream(`等待上游超时（${Math.round(timeoutMs / 1000)} 秒，流式）`, { timeoutMs });
      }
      throw HttpError.upstream(`读取上游流失败：${redactSecret(error?.message ?? error, config.apiKey)}`);
    }
  }

  return {
    /** provider 名字会出现在 `/ai/capabilities` 里；配置改了也实时生效。 */
    get name() {
      return getConfig().provider;
    },
    configured() {
      return Boolean(getConfig().apiKey);
    },
    chat,
  };
}
