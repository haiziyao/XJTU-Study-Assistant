/**
 * 长对话「滚动摘要」的端到端测试。
 *
 * 要证明的行为（用户感受对应"聊着聊着它就忘了"）：
 *   1. 窗口之外的旧内容会被压成摘要，并作为常驻上下文送进后续每一轮；
 *   2. **不会每轮都压**：已覆盖的部分不重复压（省钱、也避免摘要被反复改写）；
 *   3. **压缩失败不阻塞对话**：上游对压缩那次调用报错时，用户的消息照样发得出去、答得回来，
 *      只是这次没有摘要（宁可少记一点，也不能让对话发不出去）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { startMockAi } from './helpers/ai-mock.js';

const KEY = 'sk-test-summary-0001';

async function startApp({ mock, dataDir } = {}) {
  const dir = dataDir ?? (await mkdtemp(path.join(tmpdir(), 'potato-ai-summary-')));
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
  await call('POST', '/ai/config', {
    apiKey: KEY,
    model: 'deepseek-flash',
    baseUrl: mock.baseUrl,
    historyTurns: 2,
  });
  return { app, call };
}

/** 直接往集合里塞历史消息：模拟"这段对话已经聊了很久"。 */
async function seedHistory(app, conversationId, count) {
  for (let index = 0; index < count; index += 1) {
    await app.store.aiMessages.insert({
      conversationId,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: index % 2 === 0 ? `第 ${index + 1} 句：我在准备高数复习` : `第 ${index + 1} 句：好的，记下了`,
      status: 'done',
      createdAt: new Date(Date.now() - (count - index) * 60_000).toISOString(),
    });
  }
}

test('滚动摘要：窗口之外的旧内容被压缩，并注入后续每一轮的系统提示词', async () => {
  const mock = await startMockAi({
    apiKey: KEY,
    replies: ['摘要：用户在做高数复习计划，约定周三下午没空。', '好，接着上次说的。'],
  });
  const { app, call } = await startApp({ mock });
  try {
    const created = await call('POST', '/ai/conversations', { title: '长对话' });
    const conversationId = created.body.conversation.id;
    await seedHistory(app, conversationId, 12); // 12 条旧消息，窗口只有 2 轮（4 条）

    const sent = await call('POST', '/ai/chat', { text: '接着上次的继续说', conversationId, stream: false });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));

    // 第一次上游调用是"压缩"，第二次才是正常回答
    const compaction = mock.state.bodies[0];
    assert.match(compaction.messages[0].content, /压缩一段对话/, '第一次调用应该是压缩任务');
    assert.match(compaction.messages[1].content, /【需要并入的对话】/);

    const answerCall = mock.state.bodies[1];
    assert.match(answerCall.messages[0].content, /此前对话的摘要/, '回答那轮的系统提示词里要有摘要段');
    assert.match(answerCall.messages[0].content, /周三下午没空/, '摘要正文要真的进去');

    const saved = await call('GET', `/ai/conversations/${conversationId}`);
    assert.match(String(saved.body.conversation.summary ?? ''), /周三下午没空/);
    assert.ok(saved.body.conversation.summaryCount >= 6, `要记下覆盖了多少条：${saved.body.conversation.summaryCount}`);
    assert.equal(sent.body.compacted?.active, true, '响应里要告诉前端这次做了压缩');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('滚动摘要：已覆盖的部分不重复压（聊得越长也不该每轮都花一次压缩）', async () => {
  const mock = await startMockAi({
    apiKey: KEY,
    replies: ['摘要第一版：用户在准备高数复习。', '好。', '继续聊。'],
  });
  const { app, call } = await startApp({ mock });
  try {
    const created = await call('POST', '/ai/conversations', { title: '长对话' });
    const conversationId = created.body.conversation.id;
    await seedHistory(app, conversationId, 12);

    const first = await call('POST', '/ai/chat', { text: '第一问', conversationId, stream: false });
    assert.equal(first.body.compacted?.active, true);
    const callsAfterFirst = mock.state.calls;

    // 第二次：新攒的旧消息只有 2 条（不够阈值 6），不该再压
    const second = await call('POST', '/ai/chat', { text: '第二问', conversationId, stream: false });
    assert.equal(second.status, 200);
    assert.equal(mock.state.calls, callsAfterFirst + 1, '第二次只该有一次上游调用（正常回答），压缩不再发生');
    assert.equal(second.body.compacted?.active, true, '仍在压缩生效状态（沿用旧摘要）');
    const compactionCalls = mock.state.bodies.filter((body) => /压缩一段对话/.test(body.messages?.[0]?.content ?? '')).length;
    assert.equal(compactionCalls, 1, '整个过程中压缩只发生一次');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('滚动摘要：压缩失败不阻塞对话（用户的消息照样发得出去、答得回来）', async () => {
  const mock = await startMockAi({
    apiKey: KEY,
    // 第 1 次调用（压缩）故意 500，第 2 次（回答）正常
    failWith: [1],
    replies: ['这条不会被用到', '压缩没成，但我照样回答你。'],
  });
  const { app, call } = await startApp({ mock });
  try {
    const created = await call('POST', '/ai/conversations', { title: '长对话' });
    const conversationId = created.body.conversation.id;
    await seedHistory(app, conversationId, 12);

    const sent = await call('POST', '/ai/chat', { text: '接着上次', conversationId, stream: false });
    assert.equal(sent.status, 200, `压缩失败不该让对话失败：${JSON.stringify(sent.body)}`);
    assert.match(String(sent.body.assistant?.content ?? ''), /照样回答你/);
    const saved = await call('GET', `/ai/conversations/${conversationId}`);
    assert.ok(!saved.body.conversation.summary, '没压成就不该写一个假摘要');
    assert.equal(sent.body.compacted?.active, false, '如实告诉前端这次没有摘要可用');
  } finally {
    await app.close();
    await mock.close();
  }
});
