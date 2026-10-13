/**
 * 「上下文占用指示 + 手动压缩（/com）」的端到端测试。
 *
 * 要证明的行为：
 *   1. `GET /ai/context?conversationId=` 的 `used` **优先取最近一次真实请求的 prompt_tokens**
 *      （准确、免费），并如实标 `source: "prompt_tokens"`；
 *   2. 还没有任何真实请求时退化成字符估算，且**标 `source: "estimate"`**（不假装精确）；
 *   3. `percent` / `limit` 自洽：改 `contextWindow` 之后百分比跟着变；
 *   4. `POST /ai/conversations/:id/compact` 把"窗口之外、尚未摘要"的部分压进摘要，
 *      **最近 historyTurns 轮一个字都不动**，且 `summaryCount` 累计增长；
 *   5. 再压一次 → `nothing_to_compact`（**不重复烧 token**）；短对话同样不调模型；
 *   6. 没配密钥 → 501（AI_UNAVAILABLE），不是 500；会话不存在 → 404。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { startMockAi } from './helpers/ai-mock.js';

const KEY = 'sk-test-context-0001';

async function startApp({ mock, dataDir, config = {} } = {}) {
  const dir = dataDir ?? (await mkdtemp(path.join(tmpdir(), 'potato-ai-context-')));
  const app = await createServer({ dataDir: dir });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  };
  if (mock) {
    await call('POST', '/ai/config', { apiKey: KEY, model: 'deepseek-flash', baseUrl: mock.baseUrl, ...config });
  }
  return { app, call };
}

/** 直接往集合里塞历史消息：模拟"这段对话已经聊了很久"。 */
async function seedMessages(app, conversationId, count, { contentFor } = {}) {
  const created = [];
  for (let index = 0; index < count; index += 1) {
    const record = await app.store.aiMessages.insert({
      conversationId,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: contentFor ? contentFor(index) : `第 ${index + 1} 句：我在准备高数复习`,
      status: 'done',
      createdAt: new Date(Date.now() - (count - index) * 60_000).toISOString(),
    });
    created.push(record);
  }
  return created;
}

test('上下文：有真实 usage 时 used 取最近一次请求的 prompt_tokens', async () => {
  const mock = await startMockAi({ apiKey: KEY, replies: ['好的。'] });
  const { app, call } = await startApp({ mock });
  try {
    const created = await call('POST', '/ai/conversations', { title: '上下文' });
    const conversationId = created.body.conversation.id;
    // 真发一轮，让 mock 上游回 usage（mock 固定给 prompt_tokens: 11）
    const sent = await call('POST', '/ai/chat', { text: '你好', conversationId, stream: false });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));

    const context = await call('GET', `/ai/context?conversationId=${conversationId}`);
    assert.equal(context.status, 200);
    assert.equal(context.body.source, 'prompt_tokens', '有真实请求就必须用真实值');
    assert.equal(context.body.used, 11, 'mock 上游固定返回 prompt_tokens=11');
    assert.equal(context.body.limit, 1_000_000, '默认上限 1M');
    assert.equal(context.body.percent, 0, '11 / 1M 保留一位小数就是 0');
    assert.ok(context.body.usedAt, '真实值要带取样时间');
    assert.equal(context.body.configured, true);
    assert.equal(typeof context.body.breakdown.system, 'number');
    assert.equal(typeof context.body.breakdown.tools, 'number');
    assert.equal(context.body.breakdown.injection, null, '算不准的字段给 null，不编数');

    // 多轮回复取 usageRounds 里**最后一次**的 prompt_tokens
    await app.store.aiMessages.update(sent.body.assistant.id, {
      usageRounds: [
        { prompt_tokens: 11, completion_tokens: 7 },
        { prompt_tokens: 42, completion_tokens: 3 },
      ],
    });
    const again = await call('GET', `/ai/context?conversationId=${conversationId}`);
    assert.equal(again.body.used, 42, '多轮时要取最后一轮');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('上下文：没有 usage 时退化成估算并如实标来源，percent 跟着 contextWindow 变', async () => {
  const { app, call } = await startApp({}); // 不配密钥：连 mock 上游都不需要
  try {
    const created = await call('POST', '/ai/conversations', { title: '估算' });
    const conversationId = created.body.conversation.id;
    await seedMessages(app, conversationId, 4);

    const context = await call('GET', `/ai/context?conversationId=${conversationId}`);
    assert.equal(context.status, 200);
    assert.equal(context.body.source, 'estimate', '没有真实请求时必须标估算');
    assert.equal(context.body.usedAt, null);
    assert.ok(context.body.used > 0, `估算值要 > 0（实际 ${context.body.used}）`);
    assert.equal(context.body.limit, 1_000_000);
    assert.equal(context.body.percent, Number(((context.body.used / 1_000_000) * 100).toFixed(1)));
    assert.equal(context.body.messages, 4);
    assert.equal(context.body.windowMessages, 4, '默认 historyTurns=12 → 窗口 24 条，4 条全在窗口里');
    assert.equal(context.body.configured, false);

    // 上限改小 → 同一个 used 的百分比必须随之变大（自洽性）
    const saved = await call('POST', '/ai/config', { contextWindow: 100_000 });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.config.contextWindow, 100_000, '设置页要能读回上限');
    const smaller = await call('GET', `/ai/context?conversationId=${conversationId}`);
    assert.equal(smaller.body.limit, 100_000);
    assert.equal(smaller.body.used, context.body.used, 'used 不该因为改分母而变');
    assert.equal(smaller.body.percent, Number(((context.body.used / 100_000) * 100).toFixed(1)));
    assert.ok(smaller.body.percent > context.body.percent, '分母变小 → 百分比变大');

    // 越界值要被严格拦下（400 而不是静默回落）
    const bad = await call('POST', '/ai/config', { contextWindow: 100 });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error?.details?.field, 'contextWindow');

    // /ai/status 里也要带上限（前端拿它算分母）
    const status = await call('GET', '/ai/status');
    assert.equal(status.body.config.contextWindow, 100_000);
  } finally {
    await app.close();
  }
});

test('上下文：不传 conversationId 时保持老的「给模型的上下文」语义，窗口口径 400', async () => {
  const { app, call } = await startApp({});
  try {
    const legacy = await call('GET', '/ai/context');
    assert.equal(legacy.status, 200);
    assert.ok(legacy.body.today, '老调用方要的 today/now/memory 字段一个都不能少');
    assert.equal(legacy.body.limit, undefined);

    const missing = await call('GET', '/ai/context?conversationId=');
    assert.equal(missing.status, 200, '空 conversationId 等同于没传 → 走老语义');
    assert.ok(missing.body.today);

    const notFound = await call('GET', '/ai/context?conversationId=nope');
    assert.equal(notFound.status, 404);
  } finally {
    await app.close();
  }
});

test('/com：把窗口之外的旧消息压成摘要，最近 historyTurns 轮一个字不动', async () => {
  const mock = await startMockAi({ apiKey: KEY, replies: ['摘要：用户在做高数复习计划，约定周三下午没空。'] });
  // historyTurns=2 → 窗口只装最近 4 条，14 条会话里有 10 条可以压
  const { app, call } = await startApp({ mock, config: { historyTurns: 2 } });
  try {
    const created = await call('POST', '/ai/conversations', { title: '长对话' });
    const conversationId = created.body.conversation.id;
    const seeded = await seedMessages(app, conversationId, 14, { contentFor: (index) => `第 ${index + 1} 条正文` });

    const before = await call('GET', `/ai/context?conversationId=${conversationId}`);
    assert.equal(before.body.messages, 14);
    assert.equal(before.body.windowMessages, 4);
    assert.equal(before.body.source, 'estimate', '这次会话还没真发过请求');

    const compacted = await call('POST', `/ai/conversations/${conversationId}/compact`);
    assert.equal(compacted.status, 200, JSON.stringify(compacted.body));
    assert.equal(compacted.body.compacted, true);
    assert.equal(compacted.body.summarized, 10, '窗口外 10 条应该一起压');
    assert.equal(compacted.body.covered, 10, '覆盖到第 10 条');
    assert.ok(compacted.body.summaryChars > 0);
    assert.equal(compacted.body.after.source, 'estimate', 'after 只能是估算，如实标出来');
    assert.ok(compacted.body.after.summaryChars > 0);

    // 真的调了模型，而且是"压缩"那次调用
    assert.equal(mock.state.calls, 1);
    assert.match(mock.state.bodies[0].messages[0].content, /压缩一段对话/);
    assert.match(mock.state.bodies[0].messages[1].content, /第 1 条正文/);

    // 落库：summary + summaryCount，且覆盖数是累计的
    const detail = await call('GET', `/ai/conversations/${conversationId}`);
    assert.match(String(detail.body.conversation.summary), /周三下午没空/);
    assert.equal(detail.body.conversation.summaryCount, 10);

    // **最近 4 条（historyTurns=2 轮）一个字都不能被动过**
    const afterMessages = (await call('GET', `/ai/conversations/${conversationId}`)).body.messages;
    const tail = afterMessages.slice(-4).map((item) => item.content);
    assert.deepEqual(tail, seeded.slice(-4).map((item) => item.content));

    // 再压一次：没有新的可压内容 → 不调模型
    const again = await call('POST', `/ai/conversations/${conversationId}/compact`);
    assert.equal(again.status, 200);
    assert.equal(again.body.compacted, false);
    assert.equal(again.body.reason, 'nothing_to_compact');
    assert.equal(again.body.messages, 14);
    assert.equal(again.body.windowMessages, 4);
    assert.equal(mock.state.calls, 1, '第二次压缩不能再烧一次 token');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('/com：保留最近 historyTurns 条（12 条窗口）时的压缩与阈值', async () => {
  const mock = await startMockAi({ apiKey: KEY, replies: ['摘要：前面聊了高数与英语。'] });
  // historyTurns=6 → 窗口 12 条消息（就是界面上说的"保留最近 12 条"）
  const { app, call } = await startApp({ mock, config: { historyTurns: 6 } });
  try {
    const created = await call('POST', '/ai/conversations', { title: '20 条' });
    const conversationId = created.body.conversation.id;
    const seeded = await seedMessages(app, conversationId, 20, { contentFor: (index) => `第 ${index + 1} 条正文` });

    const compacted = await call('POST', `/ai/conversations/${conversationId}/compact`);
    assert.equal(compacted.body.compacted, true, JSON.stringify(compacted.body));
    assert.equal(compacted.body.windowMessages, 12);
    assert.equal(compacted.body.summarized, 8, '20 - 12 = 8 条在窗口外');

    const afterMessages = (await call('GET', `/ai/conversations/${conversationId}`)).body.messages;
    assert.deepEqual(
      afterMessages.slice(-12).map((item) => item.content),
      seeded.slice(-12).map((item) => item.content),
      '最近 12 条必须原样保留',
    );

    // 14 条 + 12 条窗口 → 只有 2 条在窗口外，不够 SUMMARY_MIN_MESSAGES(6)：不调模型
    const short = await call('POST', '/ai/conversations', { title: '14 条' });
    const shortId = short.body.conversation.id;
    await seedMessages(app, shortId, 14);
    const callsBefore = mock.state.calls;
    const result = await call('POST', `/ai/conversations/${shortId}/compact`);
    assert.equal(result.body.compacted, false);
    assert.equal(result.body.reason, 'nothing_to_compact');
    assert.equal(result.body.pending, 2, '窗口外只有 2 条，不到 6 条阈值');
    assert.equal(result.body.messages, 14);
    assert.equal(mock.state.calls, callsBefore, '不够阈值就不能调模型');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('/com：短会话没有可压缩的部分（不调模型）', async () => {
  const mock = await startMockAi({ apiKey: KEY, replies: ['不该被用到'] });
  const { app, call } = await startApp({ mock, config: { historyTurns: 2 } });
  try {
    const created = await call('POST', '/ai/conversations', { title: '短' });
    const conversationId = created.body.conversation.id;
    await seedMessages(app, conversationId, 4);

    const result = await call('POST', `/ai/conversations/${conversationId}/compact`);
    assert.equal(result.status, 200);
    assert.equal(result.body.compacted, false);
    assert.equal(result.body.reason, 'nothing_to_compact');
    assert.equal(result.body.messages, 4);
    assert.equal(result.body.windowMessages, 4, '4 条全在窗口里');
    assert.equal(mock.state.calls, 0, '一条都不该调上游');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('/com：没配密钥返回 501（AI_UNAVAILABLE）而不是 500；会话不存在 404', async () => {
  const { app, call } = await startApp({});
  try {
    const created = await call('POST', '/ai/conversations', { title: '没密钥' });
    const conversationId = created.body.conversation.id;
    const result = await call('POST', `/ai/conversations/${conversationId}/compact`);
    assert.equal(result.status, 501, JSON.stringify(result.body));
    assert.equal(result.body.error?.code, 'AI_UNAVAILABLE');

    const missing = await call('POST', '/ai/conversations/nope/compact');
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
  }
});
