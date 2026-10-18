/**
 * 待办**多选 + 批量操作**测试（`POST /todos/bulk` 与待办页多选模式）。
 *
 * 六组口径，每组都对应一个"批量操作比单条危险得多"的点：
 *   1. delete：只删选中的记录；**删父不级联删子** —— 子任务 parentId 置空、记录与进度还在；
 *   2. complete：逐条走既有完成语义 —— 父完成**级联完成所有后代**并写 autoCompletedBy，
 *      已完成的进 skipped（reason=already），不能被批量改写一遍；
 *   3. uncomplete：只回滚 `autoCompletedBy === 父` 的后代，**用户手动完成的子任务保持完成**；
 *   4. category：批量改分类生效、空串 = 未分类、复用 ≤24 字校验；
 *   5. dryRun：只预览（matched + 最多 8 条样例），前后逐字段比对必须零改动；
 *   6. 上限与视图：201 个 id → 400 TOO_MANY_IDS；页面存在多选勾选框、批量条与删除二次确认文案。
 *
 * 视图部分用 `test/helpers/renderer-dom.js` 真跑一遍 render()，再配合源码断言：
 * 前者证明"节点真的画出来了"，后者盯住"删除确认文案 / 全选范围注释"这类不在 DOM 上的约定。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from '../src/server/index.js';
import { bootRenderer } from './helpers/renderer-dom.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEW_SOURCE = readFileSync(path.join(HERE, '../src/renderer/views/calendar.js'), 'utf8');
const VIEW_CSS = readFileSync(path.join(HERE, '../src/renderer/views/calendar.css'), 'utf8');

async function startTodo() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-todo-bulk-'));
  const app = await createServer({ dataDir, version: '0.1.0-test' });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const create = async (fields) => {
    const result = await call('POST', '/todos', { deadline: '2099-01-15', ...fields });
    assert.equal(result.status, 201, JSON.stringify(result.body).slice(0, 300));
    return result.body.item;
  };
  const get = async (id) => (await call('GET', `/todos/${id}`)).body.item;
  const bulk = (body) => call('POST', '/todos/bulk', body);
  const all = async () => (await call('GET', '/todos?limit=500')).body.items;
  return { app, call, create, get, bulk, all };
}

// ---------------------------------------------------------------- delete

test('批量删除：只删选中的 3 条；删父时子任务变独立（parentId 置空、记录还在）', async () => {
  const { app, call, bulk, create, get, all } = await startTodo();
  try {
    const a = await create({ title: '删 A' });
    const b = await create({ title: '删 B' });
    const c = await create({ title: '删 C' });
    const keep = await create({ title: '保留' });

    const parent = await create({ title: '期末复习' });
    const child = await create({ title: '复习第一章', parentId: parent.id });
    const grand = await create({ title: '看例题', parentId: child.id });

    const result = await bulk({ action: 'delete', ids: [a.id, b.id, c.id, parent.id] });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.action, 'delete');
    assert.equal(result.body.matched, 4);
    assert.equal(result.body.changed, 4, '选中的 4 条都应该真的被删掉');
    assert.deepEqual(result.body.skipped, [], '全都存在，不该有跳过项');
    assert.equal(result.body.dryRun, false);
    assert.deepEqual([...result.body.detachedChildren].sort(), [child.id].sort(), '删父要如实报出被解绑的直接子级');

    for (const id of [a.id, b.id, c.id, parent.id]) {
      assert.equal((await call('GET', `/todos/${id}`)).status, 404, '选中的记录必须 404');
    }
    assert.equal((await get(keep.id)).title, '保留', '没选中的记录一条都不能动');

    // 核心：删父不级联删子 —— 子任务 parentId 置空（独立显示），孙任务仍挂在子任务下面
    const childAfter = await get(child.id);
    assert.equal(childAfter.title, '复习第一章');
    assert.equal(childAfter.parentId, null, '父被删除后，直接子级必须置空 parentId（不留悬空）');
    const grandAfter = await get(grand.id);
    assert.equal(grandAfter.title, '看例题');
    assert.equal(grandAfter.parentId, child.id, '孙任务不属于被删父的直接子级：它的父（child）还在，父链不该被动');

    const titles = (await all()).map((item) => item.title).sort();
    assert.deepEqual(titles, ['保留', '复习第一章', '看例题'].sort(), '只少了选中的 4 条，子任务与孙任务都还在');
  } finally {
    await app.close();
  }
});

test('批量删除：父与子同时选中时也能删干净，不会因先删父而把子留成孤儿', async () => {
  const { app, call, bulk, create, get } = await startTodo();
  try {
    const parent = await create({ title: '父' });
    const child = await create({ title: '子', parentId: parent.id });
    const result = await bulk({ action: 'delete', ids: [parent.id, child.id] });
    assert.equal(result.status, 200);
    assert.equal(result.body.matched, 2);
    assert.equal(result.body.changed, 2);
    assert.equal((await call('GET', `/todos/${parent.id}`)).status, 404);
    assert.equal((await call('GET', `/todos/${child.id}`)).status, 404, '先删父只解绑子，随后仍要把子删掉');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------- complete

test('批量完成：父完成会级联完成子且写 autoCompletedBy；已完成的进 skipped（already）', async () => {
  const { app, bulk, create, get } = await startTodo();
  try {
    const parent = await create({ title: '期末复习' });
    const child = await create({ title: '复习第一章', parentId: parent.id });
    const grand = await create({ title: '看例题', parentId: child.id });
    const child2 = await create({ title: '复习第二章', parentId: parent.id });
    const done = await create({ title: '早就完成的', completed: true });

    const result = await bulk({ action: 'complete', ids: [parent.id, done.id, 'ghost-id'] });
    assert.equal(result.status, 200);
    assert.equal(result.body.action, 'complete');
    assert.equal(result.body.matched, 2, 'ghost 不存在，不计入 matched');
    assert.equal(result.body.changed, 1, '只数目标记录：被级联的子任务单列在 cascaded 里');
    assert.deepEqual(
      [...result.body.cascaded.completed].sort(),
      [child.id, grand.id, child2.id].sort(),
      '父完成必须级联所有后代（含孙辈）',
    );
    const reasons = Object.fromEntries(result.body.skipped.map((item) => [item.id, item.reason]));
    assert.equal(reasons[done.id], 'already', '已经完成的进 skipped，reason 是 already');
    assert.equal(reasons['ghost-id'], 'not_found');

    for (const id of [child.id, grand.id, child2.id]) {
      const item = await get(id);
      assert.equal(item.completed, true, '所有后代都要被连带完成');
      assert.equal(item.autoCompletedBy, parent.id, 'autoCompletedBy 标记规则与单条完成完全一致');
    }
    const parentAfter = await get(parent.id);
    assert.equal(parentAfter.completed, true);
    assert.equal(parentAfter.autoCompletedBy, null, '父自己是批量勾的，不是被连带');
    assert.equal(parentAfter.childDoneCount, 2);
    assert.equal((await get(done.id)).completed, true, '跳过不等于改成未完成');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------- uncomplete

test('批量取消完成：只回滚被级联的子任务，手动完成的子任务保持完成', async () => {
  const { app, bulk, create, get } = await startTodo();
  try {
    const parent = await create({ title: '期末复习' });
    const manual = await create({ title: '手动做完的', parentId: parent.id });
    const auto = await create({ title: '被连带的', parentId: parent.id });
    const open = await create({ title: '本来就没完成' });

    // 用户先手动勾完 manual，再点父任务 → auto 被级联，manual 保持"手动完成"
    await app.services.todos.setCompleted(manual.id, true);
    const completed = await bulk({ action: 'complete', ids: [parent.id] });
    assert.deepEqual(completed.body.cascaded.completed, [auto.id]);

    const result = await bulk({ action: 'uncomplete', ids: [parent.id, open.id] });
    assert.equal(result.status, 200);
    assert.equal(result.body.action, 'uncomplete');
    assert.equal(result.body.matched, 2);
    assert.equal(result.body.changed, 1, 'open 本来就没完成，不该写库');
    assert.deepEqual(result.body.cascaded.reverted, [auto.id], '只回滚被这条父任务连带完成的那批');
    const reasons = Object.fromEntries(result.body.skipped.map((item) => [item.id, item.reason]));
    assert.equal(reasons[open.id], 'already');

    assert.equal((await get(parent.id)).completed, false);
    assert.equal((await get(auto.id)).completed, false);
    assert.equal((await get(auto.id)).autoCompletedBy, null, '回滚后连带标记要清掉');
    assert.equal((await get(manual.id)).completed, true, '用户亲手完成的子任务绝不能被批量取消抹掉');
    assert.equal((await get(manual.id)).autoCompletedBy, null);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------- category

test('批量改分类：生效、空串 = 未分类、未变化的进 skipped、≤24 字校验复用既有规则', async () => {
  const { app, bulk, create, get } = await startTodo();
  try {
    const a = await create({ title: 'A' });
    const b = await create({ title: 'B', category: '旧分类' });
    const c = await create({ title: 'C' });

    const result = await bulk({ action: 'category', ids: [a.id, b.id, c.id, 'ghost-id'], category: '  期末复习  ' });
    assert.equal(result.status, 200);
    assert.equal(result.body.action, 'category');
    assert.equal(result.body.matched, 3);
    assert.equal(result.body.changed, 3);
    assert.deepEqual(result.body.skipped, [{ id: 'ghost-id', reason: 'not_found' }]);
    for (const id of [a.id, b.id, c.id]) assert.equal((await get(id)).category, '期末复习', '两端空白要被去掉');

    // 空串 = 未分类（不是"不修改"）
    const cleared = await bulk({ action: 'category', ids: [a.id, c.id], category: '' });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.changed, 2);
    assert.equal((await get(a.id)).category, '');
    assert.equal((await get(c.id)).category, '');

    // 已经在目标分类里的不写库：changed 只数真的变了的
    const same = await bulk({ action: 'category', ids: [b.id], category: '期末复习' });
    assert.equal(same.status, 200);
    assert.equal(same.body.changed, 0);
    assert.deepEqual(same.body.skipped, [{ id: b.id, reason: 'unchanged' }]);

    // 长度校验与单条完全一致：25 个字当场 400，且字段指向 category
    const tooLong = await bulk({ action: 'category', ids: [a.id], category: '一'.repeat(25) });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error.details.field, 'category');
    assert.match(tooLong.body.error.message, /24/);
    assert.equal((await get(a.id)).category, '', '失败时不能写半个分类');

    // category 动作必须传 category（空串是合法值，缺参数不是）
    const missing = await bulk({ action: 'category', ids: [a.id] });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.details.field, 'category');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------- dryRun

test('dryRun：只回 matched + 最多 8 条样例，前后条数与每个字段逐条比对零改动', async () => {
  const { app, bulk, create, get, all } = await startTodo();
  try {
    const parent = await create({ title: '期末复习' });
    const child = await create({ title: '复习第一章', parentId: parent.id });
    const list = [];
    for (let index = 0; index < 7; index += 1) list.push(await create({ title: `批量 ${index}` }));

    const before = await all();
    const beforeById = new Map(before.map((item) => [item.id, item]));

    const deleteDry = await bulk({ action: 'delete', ids: [parent.id, child.id], dryRun: true });
    assert.equal(deleteDry.status, 200);
    assert.equal(deleteDry.body.dryRun, true);
    assert.equal(deleteDry.body.matched, 2);
    assert.equal(deleteDry.body.changed, 0);
    assert.deepEqual(
      deleteDry.body.sample,
      [
        { id: parent.id, title: '期末复习' },
        { id: child.id, title: '复习第一章' },
      ],
      '样例只含 id + title',
    );
    assert.deepEqual(deleteDry.body.skipped, []);

    // 样例上限 8 条：10 个 id 只回 8 条
    const manyIds = [parent.id, child.id, ...list.map((item) => item.id)];
    const moreDry = await bulk({ action: 'delete', ids: manyIds, dryRun: true });
    assert.equal(moreDry.body.sample.length, 8, '样例最多 8 条，避免把整个库再传一遍');
    assert.equal(moreDry.body.matched, 9);
    assert.equal((await all()).length, before.length, 'dryRun 不能删任何记录');

    // 完成 / 分类的 dryRun 同样零改动：级联与分类都只在真写时发生
    const completeDry = await bulk({ action: 'complete', ids: [parent.id], dryRun: true });
    assert.equal(completeDry.body.matched, 1);
    assert.deepEqual(completeDry.body.sample, [{ id: parent.id, title: '期末复习' }]);
    assert.equal((await get(parent.id)).completed, false);
    assert.equal((await get(child.id)).completed, false, 'dryRun 绝不能级联完成子任务');

    const categoryDry = await bulk({ action: 'category', ids: [parent.id], category: '预览分类', dryRun: true });
    assert.equal(categoryDry.body.matched, 1);
    assert.equal((await get(parent.id)).category, '');

    // 重新拉一遍全量：条数、每条记录的每个字段都要与 dryRun 之前一致
    const after = await all();
    assert.equal(after.length, before.length, 'dryRun 前后条数必须一致');
    for (const item of after) {
      assert.deepEqual(item, beforeById.get(item.id), `记录 ${item.id} 在 dryRun 后不应有任何字段变化`);
    }
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------- 上限 / 非法入参

test('上限：201 个 id → 400 TOO_MANY_IDS；恰好 200 个仍可执行', async () => {
  const { app, call, bulk, create, all } = await startTodo();
  try {
    const keep = await create({ title: '不能误删' });
    const ids = Array.from({ length: 201 }, (_, index) => `fake-id-${index}`);

    const tooMany = await bulk({ action: 'delete', ids });
    assert.equal(tooMany.status, 400, '超过上限必须在服务端硬拦，不靠界面自觉');
    assert.equal(tooMany.body.error.details.code, 'TOO_MANY_IDS');
    assert.equal(tooMany.body.error.details.max, 200);
    assert.equal(tooMany.body.error.details.count, 201);
    assert.match(tooMany.body.error.message, /200/);
    assert.equal((await all()).length, 1, '被拒绝的批量请求不能改动任何数据');

    // 边界：恰好 200 个可以通过上限检查（这里都是不存在的 id，matched=0）
    const exactly = await bulk({ action: 'delete', ids: ids.slice(0, 200) });
    assert.equal(exactly.status, 200);
    assert.equal(exactly.body.matched, 0);
    assert.equal(exactly.body.changed, 0);
    assert.equal(exactly.body.skipped.length, 200);
    assert.ok(exactly.body.skipped.every((item) => item.reason === 'not_found'));

    // 兼容性：既有单条接口不受影响
    const single = await call('DELETE', `/todos/${keep.id}`);
    assert.equal(single.status, 200);
    assert.equal(single.body.deleted, true);
  } finally {
    await app.close();
  }
});

test('非法入参：未知 action / 缺 ids / 非字符串 id 都是 400，且不会误删', async () => {
  const { app, bulk, create, all } = await startTodo();
  try {
    const keep = await create({ title: '保留' });
    const unknown = await bulk({ action: 'purge', ids: [keep.id] });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.details.field, 'action');

    const noIds = await bulk({ action: 'delete' });
    assert.equal(noIds.status, 400);
    assert.equal(noIds.body.error.details.field, 'ids');

    const badId = await bulk({ action: 'delete', ids: [keep.id, 42] });
    assert.equal(badId.status, 400);
    assert.equal(badId.body.error.details.code, 'INVALID_IDS');
    assert.equal((await all()).length, 1, '参数错误时一条都不能删');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------- 视图

/** 一条待办的公共形状（与真实 /todos 响应对齐）。 */
function todo(overrides) {
  return {
    id: 'x',
    title: '待办',
    deadline: '2099-12-20',
    estimatedHours: 1,
    priority: 0,
    completed: false,
    completedAt: null,
    description: '',
    tags: [],
    source: 'manual',
    category: '',
    parentId: null,
    autoCompletedBy: null,
    spentSelfSec: 0,
    spentSec: 0,
    childCount: 0,
    childDoneCount: 0,
    hasChildren: false,
    isOverdue: false,
    isToday: false,
    daysRemaining: 100,
    complexity: 'simple',
    complexityLabel: '简单',
    ...overrides,
  };
}

/**
 * 伪后端：一棵三层树。
 * p1(期末复习) ├─ c1(复习第一章)
 *              └─ c2(复习第二章) └─ g1(看例题)
 * p2(交实验报告，未分类)
 */
function makeBatchApi() {
  const tree = [
    todo({
      id: 'p1',
      title: '期末复习',
      category: '期末复习',
      childCount: 2,
      childDoneCount: 0,
      hasChildren: true,
      children: [
        todo({ id: 'c1', title: '复习第一章', parentId: 'p1', category: '期末复习', children: [] }),
        todo({
          id: 'c2',
          title: '复习第二章',
          parentId: 'p1',
          category: '期末复习',
          childCount: 1,
          hasChildren: true,
          children: [todo({ id: 'g1', title: '看例题', parentId: 'c2', category: '期末复习', children: [] })],
        }),
      ],
    }),
    todo({ id: 'p2', title: '交实验报告', category: '', children: [] }),
  ];
  const bulkCalls = [];

  const api = async (url, options = {}) => {
    if (url.startsWith('/todos/categories')) {
      return { items: [{ name: '期末复习', total: 4, open: 4 }, { name: '', total: 1, open: 1 }] };
    }
    if (url.startsWith('/todos/bulk')) {
      bulkCalls.push(options.body);
      return {
        ok: true,
        action: options.body.action,
        matched: options.body.ids.length,
        changed: options.body.ids.length,
        skipped: [],
        dryRun: false,
      };
    }
    if (/^\/todos\/[^?]+$/.test(url)) return { item: tree[0] };
    if (url.startsWith('/todos?')) {
      // 带分类筛选时只返回未分类的 p2：用来证明"全选只作用于当前筛选后可见的行"
      if (url.includes('category=')) {
        return { items: [tree[1]], count: 1, totalCount: 1, stats: { total: 1, completed: 0, pending: 1, overdue: 0, completionRate: 0, plannedHours: 1 } };
      }
      return { items: tree, count: 2, totalCount: 5, stats: { total: 5, completed: 0, pending: 5, overdue: 0, completionRate: 0, plannedHours: 5 } };
    }
    return {};
  };
  api.bulkCalls = bulkCalls;
  // 暴露给会直接改状态的测试用例
  api.tree = tree;
  return api;
}

function bootBatchUi(initialSelection) {
  const api = makeBatchApi();
  const state = {
    calendar: { mode: 'month', anchor: '2099-12-01', categories: {} },
    todo: {
      filter: 'all',
      // 默认收起 p1，用来验证多选模式会强制展开，避免"选了看不见的子任务"
      collapsed: { p1: true },
      select: { active: true, ids: new Set(initialSelection) },
    },
    panelCollapsed: false,
  };
  const booted = bootRenderer({ api, state });
  return { ...booted, api, state };
}

/** DOM 桩不支持后代选择器（`.a button`），所以先取操作区再读它的直接子按钮。 */
const batchButtons = (mount) => (mount.querySelector('.todo-batch-actions')?.children ?? []).map((button) => button.textContent);

test('视图：勾选框 / 已选 N 项 / 批量条按钮齐全；多选模式强制展开，父行勾选不自动勾子项', async () => {
  const { PC, render } = bootBatchUi(['p1']);
  const mount = await render('todo', { wait: 30 });

  // 多选模式强制展开：p1 虽然在 collapsed 里，子行仍要全部画出来（可见 = 可操作）
  assert.equal(mount.querySelectorAll('.todo-row').length, 5, '多选模式要展开整棵树，全选范围才不含糊');
  assert.equal(mount.querySelectorAll('.todo-parent-toggle').length, 0, '多选模式不提供收起，避免隐藏行被漏选');
  assert.equal(mount.querySelectorAll('.todo-select-check').length, 5, '每行左侧都要有选择勾选框');
  assert.equal(mount.querySelector('.todo-select-check').getAttribute('aria-pressed'), 'true', '已选中的行要画出勾选态');

  // 批量条：已选 N 项 + 五个操作按钮
  assert.equal(mount.querySelector('.todo-batch-count').textContent, '已选 1 项');
  assert.deepEqual(batchButtons(mount), ['完成', '取消完成', '改分类', '删除', '取消选择']);
  assert.equal(mount.querySelector('.todo-batch-selectall').textContent, '全选');

  // 父行勾选**不自动**勾子项
  const parentCheck = mount.querySelectorAll('.todo-select-check')[0];
  parentCheck.listeners.click[0]({ stopPropagation() {} });
  assert.deepEqual([...PC.state.todo.select.ids], [], '取消选择只对自己生效');
  parentCheck.listeners.click[0]({ stopPropagation() {} });
  assert.deepEqual([...PC.state.todo.select.ids], ['p1'], '勾父任务不会把 c1/c2/g1 一起勾上');

  // 想连子项时用行内的「含子项」显式按钮
  assert.equal(mount.querySelector('.todo-pick-sub').textContent, '含子项');
  mount.querySelector('.todo-pick-sub').listeners.click[0]({ stopPropagation() {} });
  assert.deepEqual(
    [...PC.state.todo.select.ids].sort(),
    ['c1', 'c2', 'g1', 'p1'].sort(),
    '「含子项」才把整棵子树一起选中（显式动作，结果可预期）',
  );
});

test('视图：全选只作用于当前筛选后可见的行；已选 id 里筛选外的幽灵项会被裁掉', async () => {
  const { PC, render, state } = bootBatchUi([]);
  // 第一次渲染：全列表 5 行，先点全选 → 只应选中这 5 行
  const full = await render('todo', { wait: 30 });
  full.querySelector('.todo-batch-selectall').listeners.click[0]();
  assert.deepEqual([...PC.state.todo.select.ids].sort(), ['c1', 'c2', 'g1', 'p1', 'p2'].sort());

  // 数据新鲜度：筛选外的幽灵 id 在渲染时会被裁掉，不会跟着批量删除被带到服务端
  PC.state.todo.select.ids = new Set(['p1', 'ghost-outside']);
  const pruned = await render('todo', { wait: 30 });
  assert.equal(pruned.querySelector('.todo-batch-count').textContent, '已选 1 项');
  assert.deepEqual([...PC.state.todo.select.ids], ['p1'], '不在当前列表里的 id 不能留在选择集里');

  // 切到某个筛选（伪后端只回 p2）：全选只选中 p2，不碰原来的 5 行
  PC.state.todo.select.ids.clear();
  state.todo.category = '只看这一条';
  const filtered = await render('todo', { wait: 30 });
  assert.equal(filtered.querySelectorAll('.todo-row').length, 1, '当前筛选后只剩 1 行');
  filtered.querySelector('.todo-batch-selectall').listeners.click[0]();
  assert.deepEqual([...PC.state.todo.select.ids], ['p2'], '全选只遍历当前筛选后可见的行，不偷偷选到筛选外');
});

test('视图：删除二次确认文案写明条数与子任务去向；批量完成后退出多选并 toast changed 条数', async () => {
  const { PC, render, window, api } = bootBatchUi([]);
  const toasts = [];
  PC.toast = (message) => toasts.push(message);
  const confirms = [];
  let confirmed = false;
  window.confirm = (message) => {
    confirms.push(message);
    return confirmed;
  };

  const mount = await render('todo', { wait: 30 });
  // 先全选（5 行）
  mount.querySelector('.todo-batch-selectall').listeners.click[0]();
  assert.equal(PC.state.todo.select.ids.size, 5);

  const actions = mount.querySelector('.todo-batch-actions').children;
  const deleteButton = actions.find((button) => button.textContent === '删除');
  deleteButton.listeners.click[0]();
  assert.equal(confirms.length, 1);
  assert.match(confirms[0], /将删除 5 条/, '确认文案要报出条数');
  assert.match(confirms[0], /父任务的子任务会变成独立待办/, '确认文案要说明删父不级联删子');
  assert.equal(api.bulkCalls.length, 0, '用户取消时不能发请求');

  // 确认删除 → 发 POST /todos/bulk，退出多选，toast 报 changed
  confirmed = true;
  deleteButton.listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(api.bulkCalls.length, 1);
  assert.equal(api.bulkCalls[0].action, 'delete');
  assert.equal(api.bulkCalls[0].ids.length, 5);
  assert.equal(PC.state.todo.select.active, false, '批量操作完成后要退出多选模式');
  assert.equal(PC.state.todo.select.ids.size, 0, '退出后不残留勾选');
  assert.ok(toasts.includes('已删除 5 条'), `toast 要报 changed 条数，实际：${toasts.join(' / ')}`);

  // 「完成」按钮走同一条批量通道（不再二次确认），并带级联提示位
  PC.state.todo.select.active = true;
  PC.state.todo.select.ids = new Set(['p1', 'c1']);
  const mount2 = await render('todo', { wait: 30 });
  mount2
    .querySelector('.todo-batch-actions')
    .children.find((button) => button.textContent === '完成')
    .listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(api.bulkCalls.at(-1).action, 'complete');
  assert.deepEqual([...api.bulkCalls.at(-1).ids], ['p1', 'c1']);
  assert.ok(toasts.at(-1).startsWith('已完成 2 条'), `toast：${toasts.at(-1)}`);
});

test('视图源码 / CSS：多选入口、批量条、全选范围注释、删除确认文案、手机端 44px 与换行', () => {
  // 多选模式与批量条的源码级标记（DOM 测试之外再钉住不会出现在 DOM 上的文案与注释）
  assert.match(VIEW_SOURCE, /todo-select-check/, '行首选择勾选框');
  assert.match(VIEW_SOURCE, /todo-pick-sub/, '「含子项」小开关');
  assert.match(VIEW_SOURCE, /已选 \$\{selection\.ids\.size\} 项/, '批量条要显示已选 N 项');
  assert.match(VIEW_SOURCE, /\/todos\/bulk/, '批量操作走 POST /todos/bulk');
  assert.match(VIEW_SOURCE, /父任务的子任务会变成独立待办/, '删除二次确认文案');
  assert.match(VIEW_SOURCE, /全选|全不选/, '全选 / 全不选');
  // 全选范围必须在代码注释里说清"只对当前筛选后可见"
  assert.match(VIEW_SOURCE, /全选只遍历它|当前筛选后可见/, '要有注释说明全选只作用于当前筛选后的可见行');
  assert.match(VIEW_SOURCE, /setTodoSelectMode\(false\)/, '批量完成后退出多选');

  // 手机端（≤900px）：批量条换行、按钮 ≥44px；不出现横向滚动条
  const mobileStart = VIEW_CSS.indexOf('@media (max-width: 900px)');
  assert.ok(mobileStart >= 0, 'calendar.css 要有 900px 断点');
  const mobile = VIEW_CSS.slice(mobileStart);
  assert.match(mobile, /\.todo-batch \{[^}]*flex-wrap: wrap/, '批量条要允许换行，不能横向溢出');
  assert.match(mobile, /\.todo-batch-btn,[\s\S]*?min-height: 44px/, '手机端批量按钮 ≥44px');
  assert.match(mobile, /\.todo-batch-cat-input \{[^}]*min-height: 44px/, '手机端分类输入框 ≥44px');
  assert.doesNotMatch(VIEW_SOURCE, /todo-batch[^;]*\.style\./, 'CSP 禁 inline style：批量条尺寸/颜色一律走 class');
});
