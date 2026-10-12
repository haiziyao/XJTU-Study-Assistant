/**
 * AI 会话生命周期（改名 / 归档 / 置顶）的端到端测试。
 *
 * 真起后端（和 ai.test.js 一样），因为它要验证的东西全在"接口 + 存储 + 广播"这三层之间：
 *   - 归档是**不删除**：默认列表看不到，`?archived=1` 能看到，改回 false 就回来；
 *   - 置顶排在最前，其余按更新时间倒序；
 *   - 改名有上限（≤200 字）且非法输入要 400（而不是静默写入脏值）；
 *   - 列表每条都带 archived / pinned / updatedAt / messageCount，且**原有字段一个不少**
 *     （渲染层与设置页都在用，破坏它们等于把别处的功能搞坏）；
 *   - 改完要广播 `data_changed`（渲染层靠它刷新，不广播界面上就会停在旧状态）；
 *   - 清空全部时**归档的也要删掉**（"清空"不能留一手），而 DELETE :id 仍然是真删除（连消息）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { startMockAi } from './helpers/ai-mock.js';
import { connectWs } from './helpers/ws-client.js';

const KEY = 'sk-test-conversations-01';

/** 起一套后端（需要真对话的用例再传 mock）。 */
async function startApp({ mock, ai } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-ai-conv-'));
  const app = await createServer({
    dataDir,
    ...(ai ? { ai } : {}),
  });
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
  return { app, info, call };
}

/** 建一个会话，返回它的记录。 */
async function newConversation(call, title) {
  const created = await call('POST', '/ai/conversations', { title });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return created.body.conversation;
}

test('AI 会话：归档后默认列表看不到，archived=1 能看到，恢复后再回来', async () => {
  const { app, call } = await startApp();
  try {
    const keep = await newConversation(call, '留着的');
    const gone = await newConversation(call, '要归档的');

    const archived = await call('PATCH', `/ai/conversations/${gone.id}`, { archived: true });
    assert.equal(archived.status, 200);
    assert.equal(archived.body.conversation.archived, true);
    // 归档 ≠ 删除：记录、消息、标题都还在
    assert.equal(archived.body.conversation.title, '要归档的');

    const defaultList = await call('GET', '/ai/conversations');
    assert.equal(defaultList.body.count, 1);
    assert.deepEqual(defaultList.body.items.map((item) => item.id), [keep.id]);

    const onlyArchived = await call('GET', '/ai/conversations?archived=1');
    assert.equal(onlyArchived.body.count, 1);
    assert.equal(onlyArchived.body.items[0].id, gone.id);
    assert.equal(onlyArchived.body.items[0].archived, true);

    const all = await call('GET', '/ai/conversations?archived=all');
    assert.equal(all.body.count, 2);

    // 恢复：不删数据，改回来就回到默认列表
    const restored = await call('PATCH', `/ai/conversations/${gone.id}`, { archived: false });
    assert.equal(restored.body.conversation.archived, false);
    assert.equal((await call('GET', '/ai/conversations')).body.count, 2);
    assert.equal((await call('GET', '/ai/conversations?archived=1')).body.count, 0);

    // 详情接口对归档会话照常可用（"能从列表里恢复"的前提是它一直读得到）
    assert.equal((await call('GET', `/ai/conversations/${gone.id}`)).body.conversation.id, gone.id);
  } finally {
    await app.close();
  }
});

test('AI 会话：置顶排在最前，其余按更新时间倒序', async () => {
  const { app, call } = await startApp();
  try {
    const a = await newConversation(call, '甲');
    const b = await newConversation(call, '乙');

    // 先确认基线：最近更新的排前面（这条现有调用方也在依赖）
    const before = await call('GET', '/ai/conversations');
    assert.deepEqual(before.body.items.map((item) => item.id), [b.id, a.id]);

    // 把最老的甲置顶：它必须排到最新的乙前面
    assert.equal((await call('PATCH', `/ai/conversations/${a.id}`, { pinned: true })).body.conversation.pinned, true);
    const pinnedFirst = await call('GET', '/ai/conversations');
    assert.deepEqual(pinnedFirst.body.items.map((item) => item.id), [a.id, b.id]);
    assert.equal(pinnedFirst.body.items[0].pinned, true);

    // 再来一个更新的丙：置顶的甲仍然在最前，丙/乙按更新时间倒序
    const c = await newConversation(call, '丙');
    const mixed = await call('GET', '/ai/conversations');
    assert.deepEqual(mixed.body.items.map((item) => item.id), [a.id, c.id, b.id]);

    // 两个都置顶时，置顶组内部也按更新时间倒序
    await call('PATCH', `/ai/conversations/${c.id}`, { pinned: true });
    const bothPinned = await call('GET', '/ai/conversations');
    assert.deepEqual(bothPinned.body.items.slice(0, 2).map((item) => item.id), [c.id, a.id]);

    // 取消置顶后就完全按更新时间排（刚动过的甲排最前）
    await call('PATCH', `/ai/conversations/${a.id}`, { pinned: false });
    await call('PATCH', `/ai/conversations/${c.id}`, { pinned: false });
    const nonePinned = await call('GET', '/ai/conversations');
    assert.equal(nonePinned.body.items.every((item) => item.pinned === false), true);
    assert.deepEqual(nonePinned.body.items.map((item) => item.id), [c.id, a.id, b.id]);
  } finally {
    await app.close();
  }
});

test('AI 会话：改名（≤200 字），未提供的字段保持原值，非法输入一律 400', async () => {
  const { app, call } = await startApp();
  try {
    const one = await newConversation(call, '旧名字');
    await call('PATCH', `/ai/conversations/${one.id}`, { archived: true, pinned: true });

    const renamed = await call('PATCH', `/ai/conversations/${one.id}`, { title: '  新名字  ' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.conversation.title, '新名字', '两端空白应被去掉');
    // 只传 title 时 archived / pinned 必须原样保留
    assert.equal(renamed.body.conversation.archived, true);
    assert.equal(renamed.body.conversation.pinned, true);

    // 200 字可以，201 字不行
    const long = await call('PATCH', `/ai/conversations/${one.id}`, { title: '字'.repeat(200) });
    assert.equal(long.status, 200);
    assert.equal(long.body.conversation.title.length, 200);
    const tooLong = await call('PATCH', `/ai/conversations/${one.id}`, { title: '字'.repeat(201) });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error.details.field, 'title');

    // 非法值
    const badTitle = await call('PATCH', `/ai/conversations/${one.id}`, { title: '' });
    assert.equal(badTitle.status, 400);
    const badTitleType = await call('PATCH', `/ai/conversations/${one.id}`, { title: 123 });
    assert.equal(badTitleType.status, 400);
    for (const field of ['archived', 'pinned']) {
      const bad = await call('PATCH', `/ai/conversations/${one.id}`, { [field]: 'yes' });
      assert.equal(bad.status, 400, `${field} 传字符串必须 400（'false' 在 JS 里是真值）`);
      assert.equal(bad.body.error.details.field, field);
    }

    // 非法字段 / 空请求体：宁可 400 也不要静默无操作
    const unknown = await call('PATCH', `/ai/conversations/${one.id}`, { tite: 'x' });
    assert.equal(unknown.status, 400);
    assert.equal((await call('PATCH', `/ai/conversations/${one.id}`, {})).status, 400);

    // 未知 id：404（改名 / 归档 / 置顶都一样）
    assert.equal((await call('PATCH', '/ai/conversations/does-not-exist', { pinned: true })).status, 404);
    // 未知的 archived 过滤值同样 400，而不是悄悄当成默认值
    assert.equal((await call('GET', '/ai/conversations?archived=maybe')).status, 400);
    assert.equal((await call('GET', '/ai/conversations?archived=all')).status, 200);
  } finally {
    await app.close();
  }
});

test('AI 会话：列表字段齐全（archived / pinned / updatedAt / messageCount），原有字段不丢', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: '好的。' });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl, model: 'mock-chat' } });
  try {
    const chat = await call('POST', '/ai/chat', { text: '帮我记一下明天的实验' });
    assert.equal(chat.status, 200);

    const list = await call('GET', '/ai/conversations');
    assert.equal(list.status, 200);
    assert.equal(list.body.ok, true);
    assert.equal(list.body.count, 1);
    const item = list.body.items[0];

    // 新增字段
    assert.equal(item.archived, false);
    assert.equal(item.pinned, false);
    assert.equal(item.messageCount, 2);
    assert.match(String(item.updatedAt), /^\d{4}-\d{2}-\d{2}T/);

    // 原有字段（渲染层与设置页在用）不能缺
    for (const key of ['id', 'title', 'createdAt', 'lastMessageAt', 'messageCount']) {
      assert.ok(key in item, `列表项缺少原有字段 ${key}`);
    }
    assert.equal(item.id, chat.body.conversation.id);
    assert.equal(item.title, '帮我记一下明天的实验');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI 会话：改名 / 归档 / 置顶都会广播 data_changed（渲染层靠它刷新）', async () => {
  const { app, info, call } = await startApp();
  const ws = await connectWs({ port: info.port });
  try {
    const one = await newConversation(call, '广播用');

    await call('PATCH', `/ai/conversations/${one.id}`, { archived: true, pinned: true, title: '广播改名' });
    const message = await ws.waitFor(
      (item) => item.type === 'data_changed' && item.module === 'ai' && item.payload?.target === 'ai_conversations',
    );
    assert.equal(message.payload.id, one.id);
    assert.equal(message.payload.action, 'update');
    assert.deepEqual([...message.payload.fields].sort(), ['archived', 'pinned', 'title']);
  } finally {
    ws.close();
    await app.close();
  }
});

test('AI 会话：清空把归档的一起删掉；DELETE :id 仍是真删除（连消息）', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: '记下了。' });
  const { app, call } = await startApp({ mock, ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    await call('POST', '/ai/chat', { text: '第一件事' });
    await call('POST', '/ai/chat', { text: '第二件事' });

    const items = (await call('GET', '/ai/conversations?archived=all')).body.items;
    assert.equal(items.length, 2);
    for (const item of items) {
      assert.equal((await call('PATCH', `/ai/conversations/${item.id}`, { archived: true })).status, 200);
    }
    // 归档之后默认列表是空的，但数据还在
    assert.equal((await call('GET', '/ai/conversations')).body.count, 0);
    assert.equal((await call('GET', '/ai/status')).body.conversations, 2);

    // 清空：归档的也算在内，消息一并删掉
    const cleared = await call('DELETE', '/ai/conversations');
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.conversations, 2);
    assert.equal(cleared.body.messages, 4);
    assert.equal((await call('GET', '/ai/conversations?archived=all')).body.count, 0);
    assert.equal((await call('GET', '/ai/status')).body.messages, 0);

    // 单条删除对归档会话同样是真删除（消息也走）
    const chat = await call('POST', '/ai/chat', { text: '第三件事' });
    const id = chat.body.conversation.id;
    await call('PATCH', `/ai/conversations/${id}`, { archived: true });
    const removed = await call('DELETE', `/ai/conversations/${id}`);
    assert.equal(removed.body.deleted, true);
    assert.equal(removed.body.messages, 2);
    assert.equal((await call('GET', `/ai/conversations/${id}`)).status, 404);
    assert.equal((await call('GET', '/ai/status')).body.messages, 0);
  } finally {
    await app.close();
    await mock.close();
  }
});
