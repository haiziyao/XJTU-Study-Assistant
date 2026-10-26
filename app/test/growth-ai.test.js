/**
 * 成长模块 · AI 端点（mock 上游，绝不真调）。
 *
 * 这一组是移植时**新增**的：源项目的 AI 测试只覆盖“连不上就降级”，
 * 而 XJTU 版新增了「AI 配置打通」这条硬约束，必须证明：
 *   1. 优先读 `services.ai` 的 baseUrl/apiKey/model；
 *   2. `GET /growth/ai/status` 只回掩码，原始 key 从不出现在响应里；
 *   3. 成长模块的集合/备份里没有密钥；
 *   4. 没有 AI 模块时回落到 growth 自己的非密钥配置，且 keyless 本地端点也能用。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { startMockAi } from './helpers/ai-mock.js';

const KEY = 'sk-growth-test-key-1234';
const STATE = { sleepHours: 7, sleepQuality: 4, energy: 4, mood: 4, stress: 2, focus: 4, body: 4 };

async function startApp({ onlyModules = ['growth', 'ai'] } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-growth-ai-'));
  const app = await createServer({
    dataDir,
    onlyModules,
    growth: { now: () => new Date(2026, 9, 26, 9, 0, 0) },
  });
  const info = await app.listen({ port: 0 });
  const callGrowth = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}/growth${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const callRoot = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const close = async () => {
    await callGrowth('POST', '/system/shutdown', { reason: 'test-cleanup' }).catch(() => {});
    await app.close();
    await app.services.growth?.closing?.catch?.(() => {});
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  };
  return { app, info, callGrowth, callRoot, close, dataDir };
}

/** 不校验 Authorization 的本地模型端点（模拟 Ollama）。 */
async function startKeylessAi() {
  const state = { calls: 0, bodies: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'local-model' }] }));
      }
      if (!req.url?.endsWith('/chat/completions')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'not found' } }));
      }
      state.calls += 1;
      state.bodies.push(raw ? JSON.parse(raw) : null);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-local',
          choices: [{ index: 0, message: { role: 'assistant', content: '本地模型回复：先做最硬的那件事。' }, finish_reason: 'stop' }],
          usage: { total_tokens: 12 },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('AI 状态：优先读 XJTU services.ai，且只返回 masked key', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: 'ok' });
  const ctx = await startApp();
  try {
    const saved = await ctx.callRoot('POST', '/ai/config', {
      apiKey: KEY,
      baseUrl: mock.baseUrl,
      model: 'mock-model',
    });
    assert.equal(saved.status, 200);

    const status = await ctx.callGrowth('GET', '/ai/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.source, 'xjtu-ai', '共享密钥存在时以 XJTU AI 配置为准');
    assert.equal(status.body.hasKey, true);
    assert.equal(status.body.keyMask, `***${KEY.slice(-4)}`);
    assert.equal(status.body.baseUrl, mock.baseUrl);
    assert.equal(status.body.model, 'mock-model');
    assert.equal(status.body.sharedConfigured, true);
    assert.equal(JSON.stringify(status.body).includes(KEY), false, '响应里不能出现原始 key');
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('AI 配置：growth 不落密钥，apiKey 委托给 ai 模块保存', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: 'ok' });
  const ctx = await startApp();
  try {
    const saved = await ctx.callGrowth('POST', '/ai/config', {
      apiKey: KEY,
      baseUrl: mock.baseUrl,
      model: 'mock-model',
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.config.hasKey, true);
    assert.equal(saved.body.config.keyMask, `***${KEY.slice(-4)}`);

    // 共享 AI 配置拿到 key 与地址
    const shared = await ctx.callRoot('GET', '/ai/config');
    assert.equal(shared.body.config.hasKey, true);
    assert.equal(shared.body.config.keyHint, `…${KEY.slice(-4)}`);
    assert.equal(shared.body.config.baseUrl, mock.baseUrl);

    // 成长模块自己的集合里没有密钥
    const raw = await readFile(path.join(ctx.dataDir, 'growth-settings.json'), 'utf8');
    assert.equal(raw.includes('apiKey'), false, raw);
    assert.equal(raw.includes(KEY), false, raw);
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('AI 探测：GET /models 走 mock 上游，返回模型清单', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: 'ok' });
  const ctx = await startApp();
  try {
    await ctx.callRoot('POST', '/ai/config', { apiKey: KEY, baseUrl: mock.baseUrl, model: 'mock-model' });
    const probe = await ctx.callGrowth('POST', '/ai/probe', {});
    assert.equal(probe.status, 200);
    assert.equal(probe.body.probe.ok, true);
    assert.ok(probe.body.probe.models.includes('mock-model'));
    assert.ok(probe.body.probe.models.includes('mock-chat'));
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('AI 简报：成功时 source=ai，返回 mock 上游的正文', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: '今天先做最硬的那件事，别开新战线。' });
  const ctx = await startApp();
  try {
    await ctx.callRoot('POST', '/ai/config', { apiKey: KEY, baseUrl: mock.baseUrl, model: 'mock-model' });
    await ctx.callGrowth('POST', '/state', STATE);
    const briefing = await ctx.callGrowth('POST', '/ai/briefing', {});
    assert.equal(briefing.status, 200);
    assert.equal(briefing.body.source, 'ai');
    assert.equal(briefing.body.model, 'mock-model');
    assert.equal(briefing.body.text, '今天先做最硬的那件事，别开新战线。');
    assert.equal(mock.state.calls, 1);
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('AI 复盘与状态解读：成功时都走同一个上游', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: '证据是完成率与投入分钟，明天把条数减半。' });
  const ctx = await startApp();
  try {
    await ctx.callRoot('POST', '/ai/config', { apiKey: KEY, baseUrl: mock.baseUrl, model: 'mock-model' });
    await ctx.callGrowth('POST', '/state', STATE);

    const review = await ctx.callGrowth('POST', '/ai/review', {});
    assert.equal(review.body.source, 'ai');
    assert.equal(review.body.model, 'mock-model');

    const interpretation = await ctx.callGrowth('POST', '/ai/interpret', {});
    assert.equal(interpretation.body.source, 'ai');
    assert.equal(interpretation.body.model, 'mock-model');
    assert.equal(mock.state.calls, 2);
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('没有 AI 模块时：回落 growth 配置，keyless 本地端点也能出简报', async () => {
  const local = await startKeylessAi();
  const ctx = await startApp({ onlyModules: ['growth'] });
  try {
    const saved = await ctx.callGrowth('POST', '/ai/config', { baseUrl: local.baseUrl, model: 'local-model' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.config.hasKey, false);

    const status = await ctx.callGrowth('GET', '/ai/status');
    assert.equal(status.body.source, 'growth-settings');
    assert.equal(status.body.hasKey, false);
    assert.equal(status.body.baseUrl, local.baseUrl);

    await ctx.callGrowth('POST', '/state', STATE);
    const briefing = await ctx.callGrowth('POST', '/ai/briefing', {});
    assert.equal(briefing.body.source, 'ai');
    assert.equal(briefing.body.text, '本地模型回复：先做最硬的那件事。');
    assert.equal(local.state.calls, 1, '没有密钥也要真的打上游（本地模型不需要 key）');
  } finally {
    await ctx.close();
    await local.close();
  }
});
