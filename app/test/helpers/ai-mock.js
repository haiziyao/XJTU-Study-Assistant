/**
 * OpenAI 兼容上游的 mock（测试用，零网络）。
 *
 * 复刻真实端点的三件事，用来验证我们这边的错误处理：
 *   1. 鉴权：`Authorization: Bearer <key>` 不对就回 401；
 *   2. 非流式：`{ choices: [{ message: { content } }], usage }`；
 *   3. 流式：`text/event-stream` 逐块 `data: {...}`，最后 `data: [DONE]`。
 *
 * 另外记录每个请求的 body，测试据此断言「历史消息真的带上了」。
 */

import http from 'node:http';

/** 把一段文本切成若干块（模拟模型逐字输出）。 */
export function chunkText(text, size = 4) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

/**
 * @param {object} [options]
 * @param {string} [options.apiKey] 期望的密钥，不符返回 401
 * @param {string} [options.reply] 非流式/流式的固定回复
 * @param {string[]} [options.replies] 依次返回的回复（多轮用）
 * @param {number} [options.delayMs] 每个响应前人为延迟（测超时用）
 * @param {boolean} [options.hang] 永不响应（测超时用）
 * @param {string[]} [options.failWith] 第 N 次请求返回 500（从 1 开始计数）
 */
export async function startMockAi(options = {}) {
  const state = {
    requests: [],
    calls: 0,
    /** 每次请求的 body（断言历史、模型参数）。 */
    bodies: [],
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      state.requests.push(`${req.method} ${req.url}`);
      if (req.url?.endsWith('/models')) {
        const auth = String(req.headers.authorization ?? '');
        if (auth !== `Bearer ${options.apiKey ?? 'test-key'}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'bad key' } }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }, { id: 'mock-chat' }] }));
      }
      if (req.url?.endsWith('/chat/completions') === false) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'not found' } }));
      }
      if (options.hang) return; // 故意不响应：等我们这边超时

      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* 忽略 */
      }
      state.calls += 1;
      state.bodies.push(body);

      const expected = options.apiKey ?? 'test-key';
      const auth = String(req.headers.authorization ?? '');
      if (auth !== `Bearer ${expected}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        // 真实服务端经常把请求头回显进报错，用来验证我们会抹掉密钥
        return res.end(JSON.stringify({ error: { message: `Invalid API key: ${auth}` } }));
      }

      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));

      if (Array.isArray(options.failWith) && options.failWith.includes(state.calls)) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'upstream boom' } }));
      }

      // 注意 `(Array.isArray(x) && x[i]) ?? fallback` 是个陷阱：条件不成立时左边是 false，
      // 而 `??` 只认 null/undefined，于是 false 会被原样返回 —— 这里显式用三元。
      const scripted = Array.isArray(options.replies) ? options.replies[state.calls - 1] : undefined;
      const reply = scripted ?? options.reply ?? '好的，记住了。';

      if (!body?.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            id: 'chatcmpl-mock',
            model: body?.model ?? 'mock-model',
            choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
          }),
        );
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      for (const piece of chunkText(reply)) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 18 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    /** 直接当 provider 的 baseUrl 用。 */
    baseUrl: `${origin}/v1`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
