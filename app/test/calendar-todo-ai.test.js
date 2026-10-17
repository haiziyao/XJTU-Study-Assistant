/**
 * 「一句话让 AI 把一条待办拆成 3 个子待办」——真实链路测试（mock 上游，零网络）。
 *
 * 为什么值得单独一个文件：`parentId` 必须是**已存在待办的真实 id**，而新记录的 id 由服务端
 * 生成，模型拿不到。所以正确姿势只能是"先 query 拿到父 id，再 create 子任务"。
 * 这条链路要同时成立四件事，少一件用户就得到 3 条孤立的待办：
 *   1. 模型知道 `category` / `parentId` 这两个字段（提示词里写了）；
 *   2. 只读查询回灌里真的带 `id` / `category` / `parentId` / `childCount`
 *      （aiQueryFields 投影表；缺 id 模型根本没法建子任务）；
 *   3. 草稿能通过待办的严格字段校验（字段名与 todo-service 白名单一致）；
 *   4. `permission: "auto"` 下系统真的落库 4 条、父子关系正确。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { startMockAi } from './helpers/ai-mock.js';
import calendarModule from '../src/modules/calendar/module.js';

const KEY = 'sk-test-todo-tree-123456';
const PARENT_ID = 'todo-review-fixed-id';

const fenced = (draft) => `\`\`\`command\n${JSON.stringify(draft)}\n\`\`\``;

/** 模型查父待办的只读草稿（keyword 能在结果里命中"期末复习"）。 */
const queryDraft = { ok: true, action: 'query', target: 'todo', filters: { keyword: '期末复习' } };

/** 三个子任务草稿：parentId 是刚才 query 回灌里那条待办的真实 id。 */
const childDrafts = ['复习第一章', '复习第二章', '做往年真题'].map((title, index) => ({
  ok: true,
  action: 'create',
  target: 'todo',
  fields: {
    title,
    deadline: `2026-12-${10 + index}`,
    category: '期末复习',
    parentId: PARENT_ID,
  },
  explain: `把期末复习拆成：${title}`,
}));

async function startApp({ mock }) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-todo-ai-'));
  const app = await createServer({ dataDir, ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, call };
}

/** 回灌（模型看到的最后一条注入消息）。 */
const injectedOf = (body) => String(body?.messages?.at(-1)?.content ?? '');

test('AI 一句话拆子任务：先 query 再 create ×3，落库 4 条且 parentId 全部正确', async () => {
  const mock = await startMockAi({
    apiKey: KEY,
    replies: [
      `我先找一下这条待办。\n${fenced(queryDraft)}`,
      `找到了，我把它拆成 3 个子任务。\n${childDrafts.map(fenced).join('\n')}`,
      '已经拆好了：期末复习下面多了 3 个子任务，逐个完成就行。',
    ],
  });
  const { app, call } = await startApp({ mock });
  try {
    // 父待办用**固定 id** 直接落库：mock 的回复是静态脚本，需要提前知道父 id。
    // 走 store 而不是 POST /todos，只是为了让 id 可预期；记录形状与真实建出来的一致。
    await app.store.todos.insert({
      id: PARENT_ID,
      title: '期末复习',
      deadline: '2026-12-20',
      estimatedHours: 2,
      priority: 1,
      completed: false,
      completedAt: null,
      description: '',
      tags: [],
      source: 'manual',
      category: '期末复习',
      parentId: null,
      autoCompletedBy: null,
    });

    const chat = await call('POST', '/ai/chat', { text: '把期末复习拆成 3 个子待办', permission: 'auto' });
    assert.equal(chat.status, 200, JSON.stringify(chat.body).slice(0, 300));

    // 真的执行了 3 条写入（自动审批档不留确认卡）
    assert.equal(chat.body.executed.length, 3, `auto 档应执行 3 条写入，实际 ${chat.body.executed.length}`);
    assert.deepEqual(chat.body.drafts, [], '自动执行完不该再留确认卡');

    // 落库：父 + 3 个孩子 = 4 条，父子关系全部指向固定 id
    const all = await call('GET', '/todos');
    assert.equal(all.body.items.length, 4, '断言落库 4 条（1 父 + 3 子）');
    const children = all.body.items.filter((item) => item.parentId === PARENT_ID);
    assert.equal(children.length, 3);
    assert.deepEqual(children.map((item) => item.title).sort(), ['做往年真题', '复习第一章', '复习第二章'].sort());
    assert.ok(children.every((item) => item.category === '期末复习'), '分类要跟着子任务一起落库');
    const parent = all.body.items.find((item) => item.id === PARENT_ID);
    assert.equal(parent.parentId, null);
    assert.equal(parent.childCount, 3, '父的派生字段要数出 3 个子任务');
    assert.equal(parent.childDoneCount, 0);

    // 模型确实先查再建：第一轮是 query，注入里带着父 id / 分类 / 子任务计数字段
    const injected = injectedOf(mock.state.bodies[1]);
    assert.match(injected, /todo-review-fixed-id/, '回灌里必须有父待办 id，模型才能填 parentId');
    assert.match(injected, /"category"/, 'aiQueryFields.todo 要投影 category');
    assert.match(injected, /"childCount"/, 'aiQueryFields.todo 要投影 childCount');
    assert.match(injected, /"childDoneCount"/, 'aiQueryFields.todo 要投影 childDoneCount');
    // parentId 在注入里可能因"顶层 = null"被投影表省略（null 不占 token），
    // 所以对声明本身做断言：投影表里必须有它，否则子任务的父子关系对模型不可见。
    for (const field of ['category', 'parentId', 'childCount', 'childDoneCount']) {
      assert.ok(calendarModule.aiQueryFields.todo.includes(field), `calendar.aiQueryFields.todo 缺 ${field}`);
    }

    // 系统提示词里写清了新字段的用法（模型只能从这里知道）
    const system = String(mock.state.bodies[0].messages[0].content ?? '');
    assert.match(system, /category（分类，自由文本/, 'ai/prompt.js 的待办字段清单要补 category');
    assert.match(system, /parentId（父待办的 id/, 'ai/prompt.js 的待办字段清单要补 parentId');
    assert.match(system, /可以把一件事拆成父子（parentId）/, 'calendar 模块的 aiPrompt 要说明父子拆解');
    assert.match(system, /分类填在 category/, 'calendar 模块的 aiPrompt 要说明分类字段');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('AI 建子任务指向不存在的父：服务端 400 如实回灌，不会静默落成顶层', async () => {
  const bad = {
    ok: true,
    action: 'create',
    target: 'todo',
    fields: { title: '复习第一章', deadline: '2026-12-10', parentId: 'not-exist-id' },
  };
  const mock = await startMockAi({
    apiKey: KEY,
    replies: [`${fenced(bad)}`, '这条没建成：父待办不存在。'],
  });
  const { app, call } = await startApp({ mock });
  try {
    const chat = await call('POST', '/ai/chat', { text: '把第一章挂到那条不存在的待办下面', permission: 'auto' });
    assert.equal(chat.status, 200, JSON.stringify(chat.body).slice(0, 300));
    assert.deepEqual(chat.body.executed, [], '写失败的草稿不该出现在"已执行"清单里');
    const failed = chat.body.drafts[0];
    assert.equal(failed.error.code, 'BAD_REQUEST');
    assert.equal(failed.error.details.code, 'PARENT_NOT_FOUND', '保留精确原因，前端/AI 才知道是父级没了');
    assert.match(failed.error.message, /父待办不存在/);
    const all = await call('GET', '/todos');
    assert.equal(all.body.items.length, 0, '失败的写入一条都不能落库（更不能落成顶层）');
  } finally {
    await app.close();
    await mock.close();
  }
});
