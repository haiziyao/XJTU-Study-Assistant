/**
 * AI 扩展点的测试：业务模块**自己声明**领域说明与查询字段投影，不必回来改 ai 模块。
 *
 * 覆盖三件事：
 *   1. 契约校验：`aiPrompt` / `aiQueryFields` 写错要在装配期就报错，而不是运行时静默失效；
 *   2. 提示词拼接：模块声明的 `aiPrompt` 真的进了系统提示词；
 *   3. 字段投影：模块声明的 `aiQueryFields` 真的覆盖了内置表 ——
 *      即"只读查询自动执行 + 结果回灌"时，模型能看到模块自定义的字段。
 *
 * 第 3 条是这套机制的意义所在：只读查询靠「模型出 query 草稿 → 系统自动执行 → 结果回灌」
 * 实现，如果字段投影表写死在 ai 模块里，新模块的数据就会被截成 `['id','title']`，模型看不到
 * 关键字段，只能说"我拿不到数据"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { defineModule, ModuleError } from '../src/core/module/contract.js';
import { loadModules } from '../src/core/module/registry.js';
import { buildChatSystemPrompt } from '../src/modules/ai/prompt.js';
import { startMockAi } from './helpers/ai-mock.js';

const KEY = 'sk-test-extension-0001';

/* ------------------------------------------------------------------ 1. 契约校验 */

test('AI 扩展点：契约校验会挡住写错的 aiPrompt / aiQueryFields', () => {
  const base = { id: 'probe', title: '探针' };
  assert.throws(() => defineModule({ ...base, aiPrompt: 123 }), ModuleError, 'aiPrompt 必须是字符串');
  assert.throws(() => defineModule({ ...base, aiQueryFields: ['a'] }), ModuleError, 'aiQueryFields 必须是对象');
  assert.throws(
    () => defineModule({ ...base, aiQueryFields: { probeItem: 'title' } }),
    ModuleError,
    'aiQueryFields 的每个值必须是数组',
  );
  // 合法写法不报错
  const ok = defineModule({ ...base, aiPrompt: '【探针】', aiQueryFields: { probeItem: ['id', 'title'] } });
  assert.equal(ok.aiPrompt, '【探针】');
  assert.deepEqual(ok.aiQueryFields, { probeItem: ['id', 'title'] });
});

/* ------------------------------------------------------------------ 2. 提示词拼接 */

test('AI 扩展点：模块声明的 aiPrompt 会进系统提示词', () => {
  const without = buildChatSystemPrompt({});
  const with_ = buildChatSystemPrompt({ domainBlocks: ['【探针领域】可以查询 probeItem'] });
  assert.equal(without.includes('【探针领域】'), false, '没声明时不应该出现');
  assert.equal(with_.includes('【探针领域】可以查询 probeItem'), true, '声明后必须出现');
  // 空块与空白块不应留下空段
  const blank = buildChatSystemPrompt({ domainBlocks: ['', '   ', null] });
  assert.equal(blank.includes('undefined'), false);
  assert.equal(blank.replace(/\s+/g, '').length > 0, true);
});

/* ------------------------------------------------------------------ 3. 端到端

   注入一个探针模块（声明 aiPrompt + aiQueryFields + 一个可查询的 target），
   然后走一次真实对话：
     第 1 轮 mock 回一个 query 草稿 → 系统自动执行 → 结果回灌
     第 2 轮 mock 回一句自然语言
   断言两件事：提示词里有声明块；回灌内容里有模块自定义字段。                */

const PROMPT_BLOCK = '【探针领域】查探针数据用 target: "probeItem"，条件放 filters，不要说不拿不到数据。';

const probeModule = defineModule({
  id: 'probe',
  title: '探针',
  order: 50,
  collections: [{ name: 'probeItems', file: 'probe-items.json' }],
  aiPrompt: PROMPT_BLOCK,
  aiQueryFields: { probeItem: ['id', 'title', 'secretField'] },
  createServices({ store, services }) {
    services.commands.registerHandler('probeItem', {
      query() {
        return {
          filters: {},
          count: 1,
          items: [{ id: 'p1', title: '探针一', secretField: '模块自定义字段的值' }],
          explain: '共 1 条',
        };
      },
    });
    return { probe: { list: () => store.probeItems.all() } };
  },
});

async function startApp(mock, { configureAi = true } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-ai-ext-'));
  // 走真实注册表 + 注入探针模块；按 order 排好（createServer 不会为注入的列表重排）
  const modules = [...(await loadModules()), probeModule].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const app = await createServer({
    dataDir,
    modules,
    ...(configureAi ? { ai: { apiKey: KEY, baseUrl: mock.baseUrl, model: 'mock-chat' } } : {}),
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
  return { app, call, modules };
}

test('AI 扩展点：注入的模块出现在 /api/v1/modules 里', async () => {
  const mock = await startMockAi({ apiKey: KEY });
  const { app, call } = await startApp(mock);
  try {
    const listed = await call('GET', '/modules');
    const ids = listed.body.items.map((m) => m.id);
    assert.ok(ids.includes('probe'), `探针模块应已被装配，实际：${ids.join(', ')}`);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI 扩展点：只读查询结果按模块声明的字段回灌给模型', async () => {
  const mock = await startMockAi({
    apiKey: KEY,
    replies: [
      // 第 1 轮：模型给一个针对自定义 target 的只读查询草稿
      '我查一下。\n```command\n{"ok":true,"action":"query","target":"probeItem","filters":{},"explain":"查探针"}\n```',
      // 第 2 轮：拿到回灌结果后的自然语言回答
      '查到了 1 条。',
    ],
  });
  const { app, call } = await startApp(mock);
  try {
    const chat = await call('POST', '/ai/chat', { text: '看看我的探针数据' });
    assert.equal(chat.status, 200, JSON.stringify(chat.body).slice(0, 200));

    // 上游被调了两次：一次出草稿，一次根据回灌结果作答
    assert.equal(mock.state.calls, 2, `上游应被调用 2 次，实际 ${mock.state.calls}`);

    // 1) 系统提示词里带上了模块声明的领域说明
    const firstSystem = mock.state.bodies[0].messages.find((m) => m.role === 'system')?.content ?? '';
    assert.ok(firstSystem.includes('【探针领域】'), '系统提示词应包含模块声明的 aiPrompt');

    // 2) 第二次请求里带上了查询结果，且**含模块自定义字段**
    const secondBody = JSON.stringify(mock.state.bodies[1]);
    assert.ok(secondBody.includes('探针一'), '回灌内容应包含查询到的记录');
    assert.ok(
      secondBody.includes('模块自定义字段的值'),
      'aiQueryFields 未生效：自定义字段被截断了（内置表只留 id/title 时会这样）',
    );

    // 3) 只读查询被自动执行，所以响应里的 queried 有内容、且不留待确认草稿
    assert.ok(Array.isArray(chat.body.queried) || Array.isArray(chat.body.message?.queried), '响应应带 queried 记录');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI 扩展点：complete() 不落库、不建会话', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: '这是一段学情点评。' });
  const { app, call, modules } = await startApp(mock);
  try {
    const before = await call('GET', '/ai/conversations');
    const beforeCount = before.body.items?.length ?? before.body.count ?? 0;
    assert.equal(beforeCount, 0, '初始不应有会话');

    // 直接调服务层（complete 是给模块用的能力，没有对外 HTTP 端点）
    const ai = app.services.ai;
    const out = await ai.complete({ system: '你是点评助手。', user: '给这段成绩写一句点评。' });
    assert.equal(out.ok, true);
    assert.equal(out.text, '这是一段学情点评。');
    assert.equal(out.model, 'mock-chat');

    // 关键：没有产生任何会话/消息
    const after = await call('GET', '/ai/conversations');
    const afterCount = after.body.items?.length ?? after.body.count ?? 0;
    assert.equal(afterCount, 0, 'complete() 不应创建会话');
    assert.equal(app.store.aiMessages.all().length, 0, 'complete() 不应落消息');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI 扩展点：未配密钥时 complete() 抛 501（调用方据此降级）', async () => {
  const mock = await startMockAi({ apiKey: KEY });
  // 关键：这一套**不注入 ai 配置**，所以 provider 处于未配置状态
  const { app } = await startApp(mock, { configureAi: false });
  try {
    assert.equal(app.services.ai.status().configured, false, '前置条件：provider 应为未配置');
    await assert.rejects(
      () => app.services.ai.complete({ system: 'sys', user: 'hi' }),
      (error) => error.status === 501 && error.code === 'AI_UNAVAILABLE',
    );
  } finally {
    await app.close();
    await mock.close();
  }
});
