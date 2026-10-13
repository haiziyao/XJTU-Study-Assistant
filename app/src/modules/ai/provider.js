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

/**
 * 上游列不出模型时的候选。取值来自官方文档的 Chat Completions 「Possible values」：
 * `deepseek-flash`（快、便宜、**支持看图**）与 `deepseek-v4-pro`（更强、不看图）。
 */
const BUILTIN_MODELS = ['deepseek-flash', 'deepseek-v4-pro'];

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
async function readStream(response, { onDelta, onReasoning, model }) {
  const reader = response.body?.getReader?.();
  if (!reader) throw HttpError.upstream('上游没有返回可读的流');
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
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
      // 思考模式的增量：`reasoning_content` 先来，`content` 后到（两者可能交错）
      const thinking = choice?.delta?.reasoning_content ?? '';
      if (thinking) {
        reasoning += thinking;
        onReasoning?.(thinking, { reasoning });
      }
      const delta = choice?.delta?.content ?? choice?.message?.content ?? '';
      if (delta) {
        text += delta;
        onDelta?.(delta, { text });
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }
  }

  return { text, reasoning, usage, finishReason, model, streamed: true };
}

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig 取当前配置（每次调用都读，改配置无需重建）
 * @param {typeof fetch} [deps.fetchImpl] 注入 fetch，测试用 mock 上游
 */
export function createOpenAiCompatProvider({ getConfig, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('createOpenAiCompatProvider 需要可用的 fetch');

  /** 真正的上游调用，流式/非流式共用入口与错误映射。 */
  async function chat({ messages, temperature, stream = false, onDelta, onReasoning, signal, reasoningEffort } = {}) {
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
          // 思考强度：官方取值 none / low / high / max（medium 只是兼容别名，会映射成 high）。
          // 注意**必须显式传**：DeepSeek 的思考模式默认是打开的（effort 默认 high），
          // 省略字段 ≠ 关闭思考。
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
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
      // 超时只覆盖"连上并拿到响应头"这一段（老行为，不要改：一个长回答流式输出几分钟很正常，
      // 让它受 timeoutMs 约束会把正常的慢回答掐掉）。
      clearTimeout(timer);
      /**
       * 但**取消**的监听从这里起必须继续挂着，直到这次调用真正结束 ——
       * 以前在这里 removeEventListener，于是 `signal` 只对"响应头到达之前"有效：
       * 用户按下停止时正文已经开流，abort 打不到正在读的响应体上，模型会继续把整段话吐完
       * （实测：界面上显示"已停止"，几秒后消息却变成了完整回答）。
       * 监听用 `{ once: true }` 注册，触发即自动摘除；没触发时它随这一轮的 AbortSignal 一起被回收。
       */
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
        // 思考模式下思维链与 content 同级返回；不给 UI 看就等于白花钱算了
        reasoning: choice.message?.reasoning_content ?? '',
        model: data.model ?? config.model,
        usage: data.usage ?? null,
        finishReason: choice.finish_reason ?? null,
        streamed: false,
      };
    }

    try {
      return await readStream(response, { onDelta, onReasoning, model: config.model });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (timedOut) {
        throw HttpError.upstream(`等待上游超时（${Math.round(timeoutMs / 1000)} 秒，流式）`, { timeoutMs });
      }
      // 调用方主动取消（用户按了停止）：如实说是"被取消"，而不是含糊的"流坏了" ——
      // 上层按 `signal.aborted` 判定这次要落成 stopped，这条文案只用于排查
      if (signal?.aborted) throw HttpError.upstream('请求已被取消');
      throw HttpError.upstream(`读取上游流失败：${redactSecret(error?.message ?? error, config.apiKey)}`);
    }
  }

  /* ---------------------------------------------------------------- Files API */

  const authHeaders = (config) => ({ Authorization: `Bearer ${config.apiKey}` });

  /** 统一的“要密钥/要能连上”的包装，避免每个文件接口各写一遍错误映射。 */
  async function filesFetch(config, path, init = {}) {
    if (!config.apiKey) throw unavailableError(config);
    let response;
    try {
      response = await withTimeout((signal) => fetchImpl(`${config.baseUrl}${path}`, { ...init, signal }));
    } catch (error) {
      throw HttpError.upstream(`连不上上游：${redactSecret(error?.message ?? error, config.apiKey)}`, {
        baseUrl: config.baseUrl,
      });
    }
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw HttpError.upstream(`上游返回 ${response.status}`, {
        upstreamStatus: response.status,
        body: truncate(redactSecret(bodyText, config.apiKey)),
      });
    }
    return response;
  }

  /**
   * 上传一个文件到官方 Files API。
   * `POST /files`，multipart/form-data，必填字段：`file` + `purpose=user_data`。
   * 注意**不要**手写 Content-Type —— multipart 的 boundary 由 FormData 自己带。
   */
  async function uploadFile({ filename, contentType, bytes }) {
    const config = getConfig();
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: contentType || 'application/octet-stream' }), filename || 'file');
    form.append('purpose', 'user_data'); // 官方要求必须是这个值
    const response = await filesFetch(config, '/files', {
      method: 'POST',
      headers: authHeaders(config),
      body: form,
    });
    const data = await response.json().catch(() => ({}));
    if (!data?.id) throw HttpError.upstream('上游没有返回 file_id', { body: truncate(JSON.stringify(data)) });
    return data;
  }

  async function listFiles({ limit = 100 } = {}) {
    const config = getConfig();
    const response = await filesFetch(config, `/files?limit=${Math.min(Math.max(Number(limit) || 100, 1), 1000)}`, {
      headers: authHeaders(config),
    });
    const data = await response.json().catch(() => ({}));
    return { files: data?.data ?? [], hasMore: Boolean(data?.has_more) };
  }

  async function deleteFile(fileId) {
    const config = getConfig();
    const response = await filesFetch(config, `/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
      headers: authHeaders(config),
    });
    return response.json().catch(() => ({}));
  }

  /**
   * 列上游可用模型（OpenAI 兼容的 `GET /models`）。
   * 上游不提供或调用失败时返回**内置候选**，并标明来源 —— 设置页的模型选择器据此渲染。
   */
  async function listModels() {
    const config = getConfig();
    const builtin = BUILTIN_MODELS.map((id) => ({ id, source: 'builtin' }));
    if (!config.apiKey) return { models: builtin, source: 'builtin', reason: '未配置密钥' };
    try {
      const response = await withTimeout((signal) =>
        fetchImpl(`${config.baseUrl}/models`, {
          headers: { Authorization: `Bearer ${config.apiKey}` },
          signal,
        }),
      );
      if (!response.ok) throw new Error(`上游返回 ${response.status}`);
      const data = await response.json();
      const models = (data?.data ?? data?.models ?? [])
        .map((item) => (typeof item === 'string' ? item : item?.id))
        .filter((id) => typeof id === 'string' && id)
        .map((id) => ({ id, source: 'upstream' }));
      if (!models.length) throw new Error('上游没有返回模型列表');
      // 当前模型必须出现在列表里，否则选择器会显示不出选中项
      if (!models.some((item) => item.id === config.model)) {
        models.unshift({ id: config.model, source: 'current' });
      }
      return { models, source: 'upstream' };
    } catch (error) {
      return {
        models: builtin.some((item) => item.id === config.model)
          ? builtin
          : [{ id: config.model, source: 'current' }, ...builtin],
        source: 'builtin',
        reason: redactSecret(error?.message ?? String(error), config.apiKey),
      };
    }
  }

  /** 带超时的轻量请求（列模型不需要流式与重试）。 */
  async function withTimeout(run) {
    const config = getConfig();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(config.timeoutMs, 15_000));
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
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
    listModels,
    uploadFile,
    listFiles,
    deleteFile,
  };
}
