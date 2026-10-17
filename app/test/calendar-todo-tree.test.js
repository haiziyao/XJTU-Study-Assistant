/**
 * 待办的**分类**与**父子分级**（2026-10）端到端测试。
 *
 * 覆盖五组口径，每组都对应一个"改坏了用户会真的丢数据 / 看不清"的点：
 *   1. 模型：category 长度与自由文本、parentId 存在性 / 成环 / 3 层上限，错误必须可读；
 *   2. 父被删除：子任务**不级联删除**、也没有悬空 parentId（parentId 置空 = 独立显示）；
 *   3. 级联完成：完成父连带所有后代并写 autoCompletedBy；
 *      取消完成父**只回滚被连带的那批** —— 用户手动完成过的子任务不许被抹掉（核心用例）；
 *   4. 筛选 / 树 / 分类计数：category、parentId=root、tree=1 的形状与 count/totalCount 口径；
 *   5. 启动修复：同步合并可能带来悬空/成环/超层，repairHierarchy 要能修干净且不删数据。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';

async function startTodo() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-todo-tree-'));
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
  return { app, call, create, get };
}

// ---------------------------------------------------------------- 1. 模型

test('category：自由文本、≤24 字、空串 = 未分类；不做枚举校验', async () => {
  const { app, call, create } = await startTodo();
  try {
    const named = await create({ title: '复习第一章', category: '  期末复习  ' });
    assert.equal(named.category, '期末复习', '两端空白应被去掉（否则筛选里会出现两个看起来一样的分类）');

    // 24 个汉字可以，25 个不行（上限写进契约，不能静默截断）
    const ok24 = await create({ title: '刚好 24 字', category: '一'.repeat(24) });
    assert.equal(ok24.category.length, 24);
    const tooLong = await call('POST', '/todos', { title: '超长分类', deadline: '2099-01-15', category: '一'.repeat(25) });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error.details.field, 'category');
    assert.match(tooLong.body.error.message, /24/, '报错要说清上限是多少');
    assert.equal(tooLong.body.error.details.code, undefined);

    // 不传 / 传空 / 传 null 都落成未分类（同一个桶）
    const plain = await create({ title: '没分类' });
    assert.equal(plain.category, '');
    const cleared = await call('PATCH', `/todos/${plain.id}`, { category: '' });
    assert.equal(cleared.body.item.category, '');
    const nulled = await call('PATCH', `/todos/${plain.id}`, { category: null });
    assert.equal(nulled.body.item.category, '');

    // 类型错误：当场 400（而不是 String(123) 悄悄变成分类 "123"）
    const badType = await call('POST', '/todos', { title: 'x', deadline: '2099-01-15', category: 123 });
    assert.equal(badType.status, 400);
    assert.equal(badType.body.error.details.field, 'category');
  } finally {
    await app.close();
  }
});

test('parentId：父不存在 / 指向自己 / 指向后代 / 超 3 层都要 400，且错误可读', async () => {
  const { app, call, create } = await startTodo();
  try {
    const missing = await call('POST', '/todos', { title: 'x', deadline: '2099-01-15', parentId: 'no-such-id' });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.details.code, 'PARENT_NOT_FOUND');
    assert.match(missing.body.error.message, /父待办不存在/);

    // 数字不是合法 id：不猜、不 String()，直接 400
    const badType = await call('POST', '/todos', { title: 'x', deadline: '2099-01-15', parentId: 3 });
    assert.equal(badType.status, 400);
    assert.equal(badType.body.error.details.code, 'PARENT_INVALID');

    const root = await create({ title: '期末复习' });
    const child = await create({ title: '复习第一章', parentId: root.id });
    const grand = await create({ title: '看例题', parentId: child.id });

    // 自己当自己的父
    const self = await call('PATCH', `/todos/${root.id}`, { parentId: root.id });
    assert.equal(self.status, 400);
    assert.equal(self.body.error.details.code, 'PARENT_CYCLE');

    // 后代当父（成环）
    const cycle = await call('PATCH', `/todos/${root.id}`, { parentId: grand.id });
    assert.equal(cycle.status, 400);
    assert.equal(cycle.body.error.details.code, 'PARENT_CYCLE');
    assert.match(cycle.body.error.message, /环/);

    // 第 3 层已经是孙辈，再往下就是第 4 层
    const deep = await call('POST', '/todos', { title: '第四层', deadline: '2099-01-15', parentId: grand.id });
    assert.equal(deep.status, 400);
    assert.equal(deep.body.error.details.code, 'PARENT_TOO_DEEP');
    assert.equal(deep.body.error.details.maxDepth, 3);
    assert.match(deep.body.error.message, /最多 3 层/);

    // 父不变时改别的字段不受影响（重建路径也要过得去）
    const renamed = await call('PATCH', `/todos/${grand.id}`, { title: '看例题（改）' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.item.parentId, child.id);

    // 别名 parent_id / parent 都收（模型常见写法）
    const alias = await call('POST', '/todos', { title: '别名父级', deadline: '2099-01-15', parent_id: root.id });
    assert.equal(alias.status, 201);
    assert.equal(alias.body.item.parentId, root.id);

    // dryRun 预览也要提前报（用户点确认之前就该看见错误）
    const dry = await call('POST', '/commands/execute', {
      dryRun: true,
      draft: { ok: true, action: 'create', target: 'todo', fields: { title: 'x', deadline: '2099-01-15', parentId: 'ghost' } },
    });
    assert.equal(dry.status, 400);
    assert.equal(dry.body.error.details.code, 'PARENT_NOT_FOUND');
  } finally {
    await app.close();
  }
});

test('移动一棵子树也不能超 3 层（只看自己那一层是不够的）', async () => {
  const { app, call, create, get } = await startTodo();
  try {
    const root = await create({ title: '期末复习' });
    const child = await create({ title: '复习第一章', parentId: root.id });
    const grand = await create({ title: '看例题', parentId: child.id });
    const other = await create({ title: '其它顶层' });

    // root 下面还有两层：整棵挂到 other 下会把孙辈压到第 4 层
    const tooDeep = await call('PATCH', `/todos/${root.id}`, { parentId: other.id });
    assert.equal(tooDeep.status, 400);
    assert.equal(tooDeep.body.error.details.code, 'PARENT_TOO_DEEP');
    assert.equal(tooDeep.body.error.details.subtreeHeight, 3);
    assert.match(tooDeep.body.error.message, /最深/);
    assert.equal((await get(root.id)).parentId, null, '拒绝之后不能改动原有父级');

    // 只带一层子任务的 child：挂到 other（第 1 层）下则最深恰好是第 3 层，合法
    const moved = await call('PATCH', `/todos/${child.id}`, { parentId: other.id });
    assert.equal(moved.status, 200, JSON.stringify(moved.body).slice(0, 200));
    assert.equal((await get(child.id)).parentId, other.id);
    assert.equal((await get(grand.id)).parentId, child.id, '子树随着父一起挪');
  } finally {
    await app.close();
  }
});

test('父删除：子任务不级联删除，parentId 置空（不留悬空）', async () => {
  const { app, call, create, get } = await startTodo();
  try {
    const parent = await create({ title: '期末复习' });
    const child = await create({ title: '复习第一章', parentId: parent.id });
    const grand = await create({ title: '看例题', parentId: child.id });

    const removed = await call('DELETE', `/todos/${child.id}`);
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.detachedChildren, [grand.id], '删除父级要如实报出被"解绑"的子任务');
    assert.equal((await get(grand.id)).parentId, null, '孙任务不能留悬空 parentId');
    assert.equal((await get(grand.id)).title, '看例题', '子任务的数据一个字都不能丢');
    assert.equal((await call('GET', `/todos/${child.id}`)).status, 404);

    // 父（root）删除时同理
    await call('DELETE', `/todos/${parent.id}`);
    const after = await call('GET', '/todos?parentId=root');
    assert.deepEqual(after.body.items.map((item) => item.title).sort(), ['看例题'], '解绑后的孙任务成为顶层待办，仍然可见');
    assert.ok(after.body.items.every((item) => item.parentId === null));
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------- 3. 级联完成 / 回滚

test('完成父 → 所有后代完成且带 autoCompletedBy；子完成不反向完成父', async () => {
  const { app, call, create, get } = await startTodo();
  try {
    const parent = await create({ title: '期末复习' });
    const child = await create({ title: '复习第一章', parentId: parent.id });
    const grand = await create({ title: '看例题', parentId: child.id });
    const child2 = await create({ title: '复习第二章', parentId: parent.id });

    const done = await call('POST', `/todos/${parent.id}/completed`, { completed: true });
    assert.equal(done.status, 200);
    assert.deepEqual(
      [...done.body.cascaded.completed].sort(),
      [child.id, grand.id, child2.id].sort(),
      'cascaded.completed 要给出所有被连带完成的后代 id',
    );
    for (const id of [child.id, grand.id, child2.id]) {
      const item = await get(id);
      assert.equal(item.completed, true, '所有后代都要被完成');
      assert.equal(item.autoCompletedBy, parent.id, '被连带的后代要记下"是谁把我带完成的"');
    }
    const parentAfter = await get(parent.id);
    assert.equal(parentAfter.completed, true);
    assert.equal(parentAfter.autoCompletedBy, null, '父自己是手动勾的，不该有连带标记');
    assert.equal(parentAfter.childCount, 2);
    assert.equal(parentAfter.childDoneCount, 2, '父的 childDoneCount 要跟着变');

    // 子完成不自动完成父：另起一棵树验证
    const p2 = await create({ title: '写报告' });
    const c2 = await create({ title: '写引言', parentId: p2.id });
    await call('POST', `/todos/${c2.id}/completed`, { completed: true });
    assert.equal((await get(p2.id)).completed, false, '子任务完成不该顺手把父任务也标完成');
    assert.equal((await get(p2.id)).childDoneCount, 1);
  } finally {
    await app.close();
  }
});

test('取消完成父：只回滚被连带完成的子任务，手动完成过的子任务必须保持完成（核心用例）', async () => {
  const { app, call, create, get } = await startTodo();
  try {
    const parent = await create({ title: '期末复习' });
    const manual = await create({ title: '手动完成的（早就做完了）', parentId: parent.id });
    const auto = await create({ title: '被连带的', parentId: parent.id });

    // 用户先手动勾完 manual，再点父任务
    await call('POST', `/todos/${manual.id}/completed`, { completed: true });
    const done = await call('POST', `/todos/${parent.id}/completed`, { completed: true });
    assert.deepEqual(done.body.cascaded.completed, [auto.id], '已经手动完成的子任务不该被改写/记标记');
    assert.equal((await get(manual.id)).autoCompletedBy, null);

    const undone = await call('POST', `/todos/${parent.id}/completed`, { completed: false });
    assert.deepEqual(undone.body.cascaded.reverted, [auto.id], '只回滚被连带完成的那一条');
    assert.equal((await get(auto.id)).completed, false);
    assert.equal((await get(auto.id)).autoCompletedBy, null, '回滚后要清掉标记');
    assert.equal((await get(manual.id)).completed, true, '手动完成过的子任务不许被回滚');
    assert.equal((await get(manual.id)).autoCompletedBy, null);
    assert.equal((await get(parent.id)).completed, false);
  } finally {
    await app.close();
  }
});

test('取消/重新完成子任务会清掉连带标记：之后撤销父不会误伤"用户自己勾的"', async () => {
  const { app, call, create, get } = await startTodo();
  try {
    const parent = await create({ title: '期末复习' });
    const a = await create({ title: 'A', parentId: parent.id });
    const b = await create({ title: 'B', parentId: parent.id });

    await call('PATCH', `/todos/${parent.id}`, { completed: true });
    assert.equal((await get(a.id)).autoCompletedBy, parent.id);

    // 用户手动取消 A（标记必须清掉），再手动完成 A
    await call('PATCH', `/todos/${a.id}`, { completed: false });
    assert.equal((await get(a.id)).autoCompletedBy, null);
    await call('POST', `/todos/${a.id}/completed`, { completed: true });
    assert.equal((await get(a.id)).autoCompletedBy, null, '手动完成不该被误标成"被连带"');

    // 撤销父：只有 B 被回滚，A 保持完成
    const undone = await call('PATCH', `/todos/${parent.id}`, { completed: false });
    assert.deepEqual(undone.body.cascaded.reverted, [b.id]);
    assert.equal((await get(a.id)).completed, true, '手动重新勾上的 A 不能被父的撤销抹掉');
    assert.equal((await get(b.id)).completed, false);
  } finally {
    await app.close();
  }
});

test('PATCH 显式 completed 与 /completed 同一套级联；改标题不会顺手扫子任务', async () => {
  const { app, call, create, get } = await startTodo();
  try {
    const parent = await create({ title: '期末复习' });
    const a = await create({ title: 'A', parentId: parent.id });
    const b = await create({ title: 'B', parentId: parent.id });

    const viaPatch = await call('PATCH', `/todos/${parent.id}`, { completed: true });
    assert.equal(viaPatch.status, 200);
    assert.deepEqual([...viaPatch.body.cascaded.completed].sort(), [a.id, b.id].sort(), 'PATCH 也要级联');
    assert.equal(viaPatch.body.item.cascaded.completed.length, 2, 'item 上也带同一份影响清单（前端两个位置都能读）');

    // 用户手动取消 B，之后改父标题：不能把 B 重新勾上（只认显式 completed）
    await call('POST', `/todos/${b.id}/completed`, { completed: false });
    await call('PATCH', `/todos/${parent.id}`, { title: '期末复习（改）' });
    assert.equal((await get(b.id)).completed, false, '改标题不该重新级联完成');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------- 4. 筛选 / 树 / 分类计数

test('筛选：category（含未分类空串）、parentId=root、parentId=<id>', async () => {
  const { app, call, create } = await startTodo();
  try {
    const parent = await create({ title: '期末复习', category: '学习' });
    const child = await create({ title: '复习第一章', category: '学习', parentId: parent.id });
    await create({ title: '交实验报告', category: '课程' });
    await create({ title: '随手记', category: '' });
    await create({ title: '另一个顶层', category: '学习' });

    const study = await call('GET', `/todos?category=${encodeURIComponent('学习')}`);
    assert.deepEqual(study.body.items.map((item) => item.title).sort(), ['另一个顶层', '复习第一章', '期末复习'].sort());

    const unclassified = await call('GET', '/todos?category=');
    assert.deepEqual(unclassified.body.items.map((item) => item.title), ['随手记'], '?category=（空串）只筛未分类');

    const roots = await call('GET', '/todos?parentId=root');
    assert.deepEqual(roots.body.items.map((item) => item.title).sort(), ['交实验报告', '另一个顶层', '期末复习', '随手记'].sort());

    const children = await call('GET', `/todos?parentId=${parent.id}`);
    assert.deepEqual(children.body.items.map((item) => item.title), ['复习第一章']);

    // flat 模式下 count 与 totalCount 都是返回条数
    assert.equal(roots.body.count, roots.body.items.length);
    assert.equal(roots.body.totalCount, roots.body.items.length);
  } finally {
    await app.close();
  }
});

test('/todos?tree=1：顶层数组 + children，count 计顶层、totalCount 计全部', async () => {
  const { app, call, create } = await startTodo();
  try {
    const parent = await create({ title: '期末复习', category: '学习', deadline: '2099-01-01' });
    const child = await create({ title: '复习第一章', category: '学习', parentId: parent.id, deadline: '2099-01-03' });
    await create({ title: '看例题', category: '学习', parentId: child.id, deadline: '2099-01-02' });
    await create({ title: '复习第二章', category: '学习', parentId: parent.id, deadline: '2099-01-04' });
    const other = await create({ title: '交实验报告', category: '', deadline: '2099-01-20' });

    const tree = await call('GET', '/todos?tree=1');
    assert.equal(tree.body.tree, true);
    assert.equal(tree.body.count, 2, 'count 是顶层条数');
    assert.equal(tree.body.totalCount, 5, 'totalCount 是含子项的记录总数');
    assert.deepEqual(tree.body.items.map((item) => item.title), ['期末复习', '交实验报告']);

    const root = tree.body.items[0];
    assert.equal(root.children.length, 2);
    assert.deepEqual(root.children.map((item) => item.title).sort(), ['复习第二章', '复习第一章'].sort());
    const branch = root.children.find((item) => item.title === '复习第一章');
    assert.equal(branch.children.length, 1, '孙辈在第三层');
    assert.equal(branch.children[0].title, '看例题');
    assert.deepEqual(branch.children[0].children, [], '每个节点都有 children 数组（叶子是空数组）');
    assert.equal(tree.body.items[1].id, other.id);

    // 树模式下 stats 与 totalCount 同口径（返回的全部记录），才与界面上看到的行数对得上
    assert.equal(tree.body.stats.total, 5);

    // limit 作用在顶层：先截顶层再带上整棵子树
    const limited = await call('GET', '/todos?tree=1&limit=1');
    assert.equal(limited.body.count, 1);
    assert.equal(limited.body.totalCount, 4, '截到的顶层要把它的 3 个后代一起带上');

    // 分类筛选 + 树：只留该分类的节点，父不在结果里的提升为顶层（不静默丢数据）
    const study = await call('GET', `/todos?tree=1&category=${encodeURIComponent('学习')}`);
    assert.equal(study.body.count, 1);
    assert.equal(study.body.totalCount, 4);

    // parentId=root + tree 只看顶层
    const top = await call('GET', '/todos?tree=1&parentId=root');
    assert.equal(top.body.count, 2);
    assert.equal(top.body.totalCount, 2);
  } finally {
    await app.close();
  }
});

test('GET /todos/categories：按 total 降序，未分类用空串，计数含已完成的子任务', async () => {
  const { app, call, create } = await startTodo();
  try {
    const parent = await create({ title: '期末复习', category: '学习' });
    const child = await create({ title: '复习第一章', category: '学习', parentId: parent.id });
    await create({ title: '复习第二章', category: '学习', parentId: parent.id });
    await create({ title: '交实验报告', category: '课程' });
    await create({ title: '随手记', category: '' });

    // 完成父 → 两个子任务也被连带完成：total 不变、open 要跟着少
    await call('POST', `/todos/${parent.id}/completed`, { completed: true });

    const result = await call('GET', '/todos/categories');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.items, [
      { name: '学习', total: 3, open: 0 },
      { name: '课程', total: 1, open: 1 },
      { name: '', total: 1, open: 1 },
    ]);
    assert.equal((await call('GET', `/todos/${child.id}`)).body.item.completed, true);
  } finally {
    await app.close();
  }
});

test('指令层：/commands/execute 的 todo create / query / complete 也支持 category 与 parentId（AI 走的就是这条）', async () => {
  const { app, call, get } = await startTodo();
  try {
    const parent = await call('POST', '/commands/execute', {
      draft: {
        ok: true,
        action: 'create',
        target: 'todo',
        fields: { title: '期末复习', deadline: '2099-01-20', category: '学习' },
      },
    });
    assert.equal(parent.status, 200, JSON.stringify(parent.body).slice(0, 300));
    const parentId = parent.body.item.id;
    assert.equal(parent.body.item.category, '学习');

    const child = await call('POST', '/commands/execute', {
      draft: {
        ok: true,
        action: 'create',
        target: 'todo',
        fields: { title: '复习第一章', deadline: '2099-01-10', category: '学习', parentId },
      },
    });
    assert.equal(child.status, 200, JSON.stringify(child.body).slice(0, 300));
    assert.equal(child.body.item.parentId, parentId, '指令新建要能直接挂到父任务下');

    // 查询：分类 / 父级也能当 filters
    const byCategory = await call('POST', '/commands/execute', {
      draft: { ok: true, action: 'query', target: 'todo', filters: { category: '学习' } },
    });
    assert.equal(byCategory.body.count, 2);
    const byParent = await call('POST', '/commands/execute', {
      draft: { ok: true, action: 'query', target: 'todo', filters: { parentId } },
    });
    assert.equal(byParent.body.count, 1);

    // 完成父：回执里要有 cascaded，解释里要提“连带完成”
    const done = await call('POST', '/commands/execute', {
      draft: { ok: true, action: 'complete', target: 'todo', filters: { id: parentId } },
    });
    assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
    assert.deepEqual(done.body.cascaded.completed, [child.body.item.id]);
    assert.match(done.body.explain, /连带完成 1 个子任务/);
    assert.equal((await get(child.body.item.id)).completed, true);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------- 5. 启动修复

test('repairHierarchy：悬空 / 成环 / 超 3 层的父子关系都能修好，一条记录都不删', async () => {
  const { app } = await startTodo();
  try {
    const store = app.store.todos;
    // 悬空：父 id 在库里面不存在（同步冲突改名后的典型形态）
    const dangling = await store.insert({ title: '悬空', deadline: '2099-01-01', parentId: 'ghost-id' });
    // 成环：A 父 B、B 父 A
    const a = await store.insert({ title: 'A', deadline: '2099-01-01', parentId: null });
    const b = await store.insert({ title: 'B', deadline: '2099-01-01', parentId: a.id });
    await store.update(a.id, { parentId: b.id });
    // 超 3 层：w -> x -> y -> z
    const w = await store.insert({ title: 'w', deadline: '2099-01-01', parentId: null });
    const x = await store.insert({ title: 'x', deadline: '2099-01-01', parentId: w.id });
    const y = await store.insert({ title: 'y', deadline: '2099-01-01', parentId: x.id });
    const z = await store.insert({ title: 'z', deadline: '2099-01-01', parentId: y.id });

    const result = await app.services.todos.repairHierarchy();
    const reasons = Object.fromEntries(result.repaired.map((item) => [item.id, item.reason]));
    assert.equal(reasons[dangling.id], 'missing-parent');
    assert.ok(reasons[a.id] === 'cycle' || reasons[b.id] === 'cycle', '成环至少要断开一条');
    assert.equal(reasons[z.id], 'too-deep', '第 4 层的记录要被提升为顶层');

    // 一条记录都没删
    assert.equal(app.store.todos.all().length, 7);
    // 修完之后：没有悬空 parentId，树能正常遍历
    const all = app.store.todos.all();
    const byId = new Map(all.map((item) => [item.id, item]));
    for (const item of all) {
      if (!item.parentId) continue;
      assert.ok(byId.has(item.parentId), `不能留下指向不存在记录的 parentId：${item.title}`);
    }
    // 幂等：再跑一次不该再修任何东西
    const again = await app.services.todos.repairHierarchy();
    assert.deepEqual(again.repaired, []);
  } finally {
    await app.close();
  }
});
