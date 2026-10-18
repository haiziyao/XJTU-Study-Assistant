/**
 * 待办「按范围批量删除 / 完成」的真实链路测试。
 *
 * 背景：界面上早就有 `POST /todos/bulk`，但 AI 草稿协议里没有范围概念，用户说
 * 「把已完成的待办全删掉」时模型只能如实回答"待办只能一条条删" —— 真机上 60 条待办、
 * 其中 20+ 条学堂同步的已完成作业，用户要的是一次清掉，不是点 20 次。
 *
 * 这份文件按「指令层 → 目标集合 → dryRun → 200 上限 → AI 真实链路 → 提示词」逐层钉住：
 *   - 六个 scope 的命中口径：all / completed / incomplete / lms / manual / ids；
 *   - 完成父级联子（autoCompletedBy）与取消完成只回滚被级联项；
 *   - dryRun 只预览，一条数据都不改；
 *   - 超过 200 条真的按 200 一批顺序走 `todos.bulk`，不是 400 也不是逐条单删；
 *   - `permission:'auto'` 一句话执行一条草稿；`manual` 只出一张确认卡；
 *   - 提示词里写明六种范围、"lms 删了会回来"，且不再出现旧限制的原话。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { startMockAi } from './helpers/ai-mock.js';
import { buildChatSystemPrompt } from '../src/modules/ai/prompt.js';

const KEY = 'sk-test-ai-todo-bulk-123456';
const fenced = (draft) => `\`\`\`command\n${JSON.stringify(draft)}\n\`\`\``;

/** 直接落库的最小完整形状：固定 id 才能精确断言"谁被删了、谁还在"。 */
const TODO_BASE = Object.freeze({
  deadline: '2026-12-01',
  estimatedHours: 1,
  priority: 1,
  completed: false,
  completedAt: null,
  description: '',
  tags: [],
  source: 'manual',
  category: '',
  parentId: null,
  autoCompletedBy: null,
  externalId: null,
});

/** 四种边界：手动/学堂 × 已完成/未完成。lms 判据只看 externalId 前缀，不看 source。 */
const MIXED_TODOS = [
  { id: 'm-open', title: '手动未完成', deadline: '2026-12-01' },
  { id: 'm-done', title: '手动已完成', deadline: '2026-12-02', completed: true },
  { id: 'l-open', title: '学堂未完成', deadline: '2026-12-03', source: 'import', externalId: 'lms:activity:1001', tags: ['学堂'] },
  { id: 'l-done', title: '学堂已完成', deadline: '2026-12-04', completed: true, source: 'import', externalId: 'lms:activity:1002', tags: ['学堂'] },
];

/** 层级场景：父 / 子 / 用户手动勾掉的子 / 无关项。 */
const CASCADE_TODOS = [
  { id: 'parent', title: '期末复习', deadline: '2026-12-01' },
  { id: 'child', title: '复习第一章', deadline: '2026-12-02', parentId: 'parent' },
  { id: 'manual-child', title: '手动完成的子任务', deadline: '2026-12-03', parentId: 'parent', completed: true },
  { id: 'other', title: '另一件事', deadline: '2026-12-04' },
];

async function startApp({ ai } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-ai-todo-bulk-'));
  const app = await createServer({ dataDir, ...(ai ? { ai } : {}) });
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
  return { app, call };
}

/** 落待办 + 各一条事件/日程，用来断言"清待办没有误伤其它集合"。 */
async function seed(app, todos = MIXED_TODOS) {
  for (const item of todos) await app.store.todos.insert({ ...TODO_BASE, ...item });
  await app.store.events.insert({
    id: 'event-keep',
    title: '期中考试',
    startDate: '2026-12-10',
    category: 'exam',
  });
  await app.store.schedules.insert({
    id: 'schedule-keep',
    title: '高等数学',
    date: '2026-12-02',
    startTime: '08:00',
    endTime: '09:00',
    category: 'other',
    priority: 1,
    source: 'manual',
    reminders: [],
    repeat: { type: 'none', interval: 1, weekdays: [], until: { mode: 'never' } },
  });
}

const allTodos = async (call) => (await call('GET', '/todos?limit=500')).body.items;
const idsOf = (items) => items.map((item) => item.id).sort();
const execute = (call, draft, dryRun = false) =>
  call('POST', '/commands/execute', dryRun ? { draft, dryRun: true } : { draft });

const bulkDraft = (action, filters) => ({ ok: true, action, target: 'todo', filters });

/* ================================================================ 1. 六个 scope */

test("scope:'completed'：dryRun 只预览 2 条，执行后只删已完成，未完成与事件/日程不动", async () => {
  const { app, call } = await startApp();
  try {
    await seed(app);
    const draft = bulkDraft('delete', { scope: 'completed' });
    const preview = await execute(call, draft, true);
    assert.equal(preview.status, 200, JSON.stringify(preview.body).slice(0, 400));
    assert.equal(preview.body.dryRun, true);
    assert.equal(preview.body.planned, 'bulk');
    assert.equal(preview.body.action, 'delete');
    assert.equal(preview.body.scope, 'completed');
    assert.equal(preview.body.count, 2);
    assert.deepEqual(preview.body.samples.map((item) => item.id).sort(), ['l-done', 'm-done']);
    assert.ok(preview.body.samples.every((item) => item.deadline), '样例要带截止日，用户才认得出是哪一批');
    assert.match(preview.body.explain, /将删除 2 条待办（范围：已完成的）/);
    assert.equal(app.store.todos.all().length, 4, 'dryRun 一条都不能动');

    const result = await execute(call, draft);
    assert.equal(result.status, 200);
    assert.equal(result.body.planned, 'bulk');
    assert.equal(result.body.deleted, 2);
    assert.equal(result.body.changed, 2);
    assert.deepEqual(result.body.skipped, []);
    assert.deepEqual(result.body.detachedChildren, []);
    assert.match(result.body.explain, /已删除 2 条待办（范围：已完成的）/);
    assert.deepEqual(idsOf(await allTodos(call)), ['l-open', 'm-open'], '未完成的两条必须还在');
    assert.deepEqual(app.store.events.all().map((item) => item.id), ['event-keep']);
    assert.deepEqual(app.store.schedules.all().map((item) => item.id), ['schedule-keep']);
  } finally {
    await app.close();
  }
});

test("scope:'all'：警告写明含自己建的；一次删 4 条，events / schedules 不动", async () => {
  const { app, call } = await startApp();
  try {
    await seed(app);
    const preview = await execute(call, bulkDraft('delete', { scope: 'all' }), true);
    assert.equal(preview.body.count, 4);
    assert.match(preview.body.explain, /将删除 4 条待办（范围：全部）/);
    assert.ok(
      preview.body.warnings.some((text) => /这会删除全部 4 条待办（含你自己建的）/.test(text)),
      'scope:all 必须在确认前写清"含你自己建的"',
    );
    assert.equal(app.store.todos.all().length, 4);

    const result = await execute(call, bulkDraft('delete', { scope: 'all' }));
    assert.equal(result.body.deleted, 4);
    assert.match(result.body.explain, /已删除 4 条待办（范围：全部）/);
    assert.match(result.body.explain, /含你自己建的/, 'auto 档只回灌 explain，清空警告也要写进去');
    assert.ok(result.body.warnings.some((text) => /这会删除全部 4 条待办/.test(text)));
    assert.equal((await allTodos(call)).length, 0, '全部待办清零');
    assert.deepEqual(app.store.events.all().map((item) => item.id), ['event-keep'], '清空待办 ≠ 清空日历');
    assert.deepEqual(app.store.schedules.all().map((item) => item.id), ['schedule-keep']);
  } finally {
    await app.close();
  }
});

test("scope:'lms'：只删 lms: 前缀，且警告「下次同步会重新生成」", async () => {
  const { app, call } = await startApp();
  try {
    await seed(app);
    const preview = await execute(call, bulkDraft('delete', { scope: 'lms' }), true);
    assert.equal(preview.body.count, 2);
    assert.match(preview.body.explain, /范围：仅学堂同步的/);
    assert.ok(
      preview.body.warnings.some((text) => /下次同步会重新生成/.test(text)),
      '学堂范围必须提醒"删了会回来"，否则用户会以为永久清掉了',
    );

    const result = await execute(call, bulkDraft('delete', { scope: 'lms' }));
    assert.equal(result.body.deleted, 2);
    assert.deepEqual(idsOf(await allTodos(call)), ['m-done', 'm-open'], '非 lms 的一条都不能少');
    assert.ok(result.body.warnings.some((text) => /下次同步会重新生成/.test(text)));
    assert.match(result.body.explain, /下次同步会重新生成/, 'auto 档回灌只带 explain，关键提醒必须也写进去');
  } finally {
    await app.close();
  }
});

test("scope:'manual'：只删非 lms 的（自己建/指令建的），学堂记录留下", async () => {
  const { app, call } = await startApp();
  try {
    await seed(app);
    const preview = await execute(call, bulkDraft('delete', { scope: 'manual' }), true);
    assert.equal(preview.body.count, 2);
    assert.match(preview.body.explain, /范围：仅手动创建的/);
    const result = await execute(call, bulkDraft('delete', { scope: 'manual' }));
    assert.equal(result.body.deleted, 2);
    assert.deepEqual(idsOf(await allTodos(call)), ['l-done', 'l-open'], 'lms 记录不能算进 manual');
  } finally {
    await app.close();
  }
});

test("scope:'incomplete' 与 scope:'ids'：未完成全删；ids 精确命中、重复去重、未知 id 报 skipped", async () => {
  const { app, call } = await startApp();
  try {
    await seed(app);
    // 空 ids 不能因为"没指定范围"退回 locate 的"无过滤查询"，那会变成删除全部。
    const empty = await execute(call, bulkDraft('delete', { scope: 'ids', ids: [] }), true);
    assert.equal(empty.status, 400);
    assert.match(empty.body.error.message, /filters\.ids/);
    const noScope = await execute(call, { ok: true, action: 'delete', target: 'todo', filters: { ids: [] } }, true);
    assert.equal(noScope.status, 400, '只给空 ids 也必须进批量路径并 400');
    assert.equal(app.store.todos.all().length, 4, '被拒绝的批量动作不能误删任何待办');

    const incomplete = await execute(call, bulkDraft('delete', { scope: 'incomplete' }));
    assert.equal(incomplete.body.deleted, 2);
    assert.deepEqual(idsOf(await allTodos(call)), ['l-done', 'm-done'], '已完成的不能被 incomplete 删掉');

    const ids = await execute(call, bulkDraft('delete', { scope: 'ids', ids: ['m-done', 'l-done', 'm-done', 'ghost'] }), true);
    assert.equal(ids.body.count, 2, '重复 id 只算一次，未知 id 不计入目标数');
    const result = await execute(call, bulkDraft('delete', { scope: 'ids', ids: ['m-done', 'l-done', 'm-done', 'ghost'] }));
    assert.equal(result.body.deleted, 2);
    assert.deepEqual(result.body.skipped, [{ id: 'ghost', reason: 'not_found' }]);
    assert.equal((await allTodos(call)).length, 0);
  } finally {
    await app.close();
  }
});

/* ================================================================ 2. 级联 / dryRun */

test("scope:'incomplete' 批量完成：父级联完成子并写 autoCompletedBy；uncomplete 只回滚被级联项", async () => {
  const { app, call } = await startApp();
  try {
    await seed(app, CASCADE_TODOS);
    const preview = await execute(call, bulkDraft('complete', { scope: 'incomplete' }), true);
    assert.equal(preview.body.count, 3, '未完成的是父 / 子 / 另一件，手动完成的子任务不在目标里');
    assert.match(preview.body.explain, /将完成 3 条待办（范围：未完成的）/);
    assert.equal(app.store.todos.all().filter((item) => item.completed).length, 1, 'dryRun 不能改完成态');

    const completed = await execute(call, bulkDraft('complete', { scope: 'incomplete' }));
    assert.equal(completed.body.changed, 2, '父与另一件是目标；子任务已被父级联，第二次处理进 skipped');
    assert.deepEqual(completed.body.cascaded.completed, ['child']);
    assert.ok(completed.body.skipped.some((item) => item.id === 'child' && item.reason === 'already'));
    const afterComplete = await allTodos(call);
    const byId = new Map(afterComplete.map((item) => [item.id, item]));
    assert.equal(byId.get('parent').completed, true);
    assert.equal(byId.get('child').completed, true);
    assert.equal(byId.get('child').autoCompletedBy, 'parent', '级联完成的子任务必须记下是谁带完成的');
    assert.equal(byId.get('other').completed, true);
    assert.equal(byId.get('manual-child').completed, true, '用户手动完成的子任务保持不变');
    assert.equal(byId.get('manual-child').autoCompletedBy, null);

    const undone = await execute(call, bulkDraft('uncomplete', { scope: 'ids', ids: ['parent'] }));
    assert.equal(undone.body.changed, 1);
    assert.deepEqual(undone.body.cascaded.reverted, ['child']);
    const afterUndo = new Map((await allTodos(call)).map((item) => [item.id, item]));
    assert.equal(afterUndo.get('parent').completed, false);
    assert.equal(afterUndo.get('child').completed, false, '被父级联完成的子任务要回滚');
    assert.equal(afterUndo.get('child').autoCompletedBy, null);
    assert.equal(afterUndo.get('manual-child').completed, true, '用户亲手勾的子任务绝不能被撤销');
    assert.equal(afterUndo.get('other').completed, true, '不在 ids 里的完成项不能被顺手回滚');
  } finally {
    await app.close();
  }
});

test('dryRun 零改动：删除与完成两种预览前后，待办逐字段完全一致', async () => {
  const { app, call } = await startApp();
  try {
    await seed(app);
    const before = JSON.stringify(app.store.todos.all());
    const del = await execute(call, bulkDraft('delete', { scope: 'completed' }), true);
    const done = await execute(call, bulkDraft('complete', { scope: 'incomplete' }), true);
    assert.equal(del.body.count, 2);
    assert.equal(done.body.count, 2);
    assert.equal(JSON.stringify(app.store.todos.all()), before, 'dryRun 不能写任何一个字段');
    assert.deepEqual(idsOf(await allTodos(call)), ['l-done', 'l-open', 'm-done', 'm-open']);
  } finally {
    await app.close();
  }
});

test('scope all 删除父子同批：detachedChildren 不报最终也被删掉的子任务', async () => {
  const { app, call } = await startApp();
  try {
    await seed(app, [
      { id: 'delete-parent', title: '要删的父任务', deadline: '2026-12-01' },
      { id: 'delete-child', title: '也要删的子任务', deadline: '2026-12-02', parentId: 'delete-parent' },
    ]);
    const result = await execute(call, bulkDraft('delete', { scope: 'all' }));
    assert.equal(result.body.deleted, 2);
    assert.deepEqual(result.body.detachedChildren, [], '子任务最终也被删了，不能报成"独立待办"');
    assert.doesNotMatch(result.body.explain, /子任务改为独立待办/);
    assert.equal(app.store.todos.all().length, 0);
  } finally {
    await app.close();
  }
});

/* ================================================================ 3. 200 条上限 */

test('超过 200 条：按 200 一批顺序调用 todos.bulk，explain 报出批数，全部真的删掉', async () => {
  const { app, call } = await startApp();
  try {
    // 201 条：只比上限多 1 条，正好能证明"第二批真的发生了"，而不是全部 400 或一次塞进去。
    for (let index = 0; index < 201; index += 1) {
      await app.store.todos.insert({
        ...TODO_BASE,
        id: `bulk-${String(index).padStart(3, '0')}`,
        title: `批量任务 ${index}`,
        deadline: `2026-12-${String((index % 28) + 1).padStart(2, '0')}`,
      });
    }
    const preview = await execute(call, bulkDraft('delete', { scope: 'all' }), true);
    assert.equal(preview.body.count, 201);
    assert.equal(preview.body.batchCount, 2);
    assert.match(preview.body.explain, /服务层单批最多 200 条，将分 2 批顺序执行/);
    assert.equal(app.store.todos.all().length, 201, '分批预览同样不能删');

    const original = app.services.todos.bulk.bind(app.services.todos);
    const batches = [];
    app.services.todos.bulk = async (input) => {
      batches.push(input.ids.length);
      return original(input);
    };
    const result = await execute(call, bulkDraft('delete', { scope: 'all' }));
    assert.deepEqual(batches, [200, 1], '必须走服务层 bulk，按 200 一批；不能在命令层循环单删');
    assert.equal(result.body.deleted, 201);
    assert.equal(result.body.batchCount, 2);
    assert.match(result.body.explain, /已删除 201 条待办（范围：全部），分 2 批执行/);
    assert.equal(app.store.todos.all().length, 0);
  } finally {
    await app.close();
  }
});

/* ================================================================ 4. AI 真实链路 */

test("AI auto：说「把已完成的待办全部删掉」只执行 1 条批量草稿，已完成清零、未完成还在", async () => {
  const draft = bulkDraft('delete', { scope: 'completed' });
  const mock = await startMockAi({ apiKey: KEY, reply: `好，这就清掉已完成的。\n${fenced(draft)}` });
  const { app, call } = await startApp({ ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    await seed(app);
    const chat = await call('POST', '/ai/chat', { text: '把已完成的待办全部删掉', permission: 'auto' });
    assert.equal(chat.status, 200, JSON.stringify(chat.body).slice(0, 400));
    assert.equal(chat.body.executed.length, 1, '按范围删除是一个动作：只执行 1 条，不能拆成 2 条');
    assert.deepEqual(chat.body.drafts, [], 'auto 档执行完不该再留确认卡');
    const executed = chat.body.executed[0];
    assert.equal(executed.result.planned, 'bulk');
    assert.equal(executed.result.scope, 'completed');
    assert.equal(executed.result.deleted, 2);

    const remaining = await allTodos(call);
    assert.deepEqual(idsOf(remaining), ['l-open', 'm-open'], '未完成的必须还在');
    assert.equal(remaining.filter((item) => item.completed).length, 0, 'GET /todos 里已完成清零');

    const system = String(mock.state.bodies[0]?.messages?.[0]?.content ?? '');
    assert.match(system, /【按范围删除\/完成待办/, '模型必须从提示词里知道有这个通道');
  } finally {
    await app.close();
    await mock.close();
  }
});

test("AI manual：同一句话只出 1 张确认卡，确认前不改数据；草稿本身带范围警告", async () => {
  const draft = bulkDraft('delete', { scope: 'all' });
  const mock = await startMockAi({ apiKey: KEY, reply: `这会清空 4 条待办（含你自己建的）。\n${fenced(draft)}` });
  const { app, call } = await startApp({ ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    await seed(app);
    const chat = await call('POST', '/ai/chat', { text: '把待办全删掉', permission: 'manual' });
    assert.equal(chat.status, 200, JSON.stringify(chat.body).slice(0, 400));
    assert.equal(chat.body.drafts.length, 1, 'manual 档只该出一张确认卡');
    assert.equal(chat.body.executed.length, 0, 'manual 档不能执行');
    const entry = chat.body.drafts[0];
    assert.deepEqual(entry.draft.filters, { scope: 'all' });
    assert.equal(entry.preview.planned, 'bulk');
    assert.equal(entry.preview.count, 4);
    assert.ok(
      entry.draft.warnings.some((text) => /会删除全部 4 条待办（含你自己建的）/.test(text)),
      '确认卡读的是 draft.warnings，不能只放在 preview 里',
    );
    assert.equal((await allTodos(call)).length, 4, '确认前一条都不能少');

    const executed = await call('POST', '/commands/execute', { draft: entry.draft });
    assert.equal(executed.body.deleted, 4);
    assert.equal(
      executed.body.warnings.filter((text) => /会删除全部/.test(text)).length,
      1,
      '预览警告回传到执行后不能重复两遍',
    );
    assert.equal((await allTodos(call)).length, 0);
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ================================================================ 5. 提示词 */

test('提示词：六个 scope / 两个示例 / lms 会回来 / 旧限制原话已移除', () => {
  const prompt = buildChatSystemPrompt({ permission: 'manual' });
  assert.match(prompt, /【按范围删除\/完成待办 —— 一条草稿，不要拆成 N 条】/);
  assert.match(prompt, /filters\.scope.*六个值/);
  for (const scope of ['all', 'completed', 'incomplete', 'lms', 'manual', 'ids']) {
    assert.match(prompt, new RegExp(`\\\`${scope}\\\``), `提示词缺少 scope:${scope}`);
  }
  assert.ok(prompt.includes('删掉所有已完成的待办'), '缺少"删掉所有已完成的待办"示例');
  assert.ok(prompt.includes('把学堂同步的待办全删掉'), '缺少"把学堂同步的待办全删掉"示例');
  assert.match(prompt, /下次同步会重新生成/);
  assert.match(prompt, /uncomplete/);
  assert.match(prompt, /不要拆成 N 条/);
  assert.match(prompt, /【按范围删除日程/, '日程的既有段落不能被替换掉');
  assert.doesNotMatch(prompt, /只能一条条/, '旧限制"待办只能一条条删"必须从提示词移除');
  assert.doesNotMatch(prompt, /没有批量/, '旧限制"没有批量通道"必须从提示词移除');
});
