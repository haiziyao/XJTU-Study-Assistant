/**
 * 日程「批量删除 + 回收站」的端到端测试。
 *
 * 这条链路来自一次真机事故：用户说「删除所有日程」，模型回答"没有清空这个动作，
 * 只能逐条删，一轮最多 3 条"。缺的是服务端动作与界面，不是模型 —— 所以这里按
 * 「服务层 → 指令层 → AI 草稿 → 渲染层」四层各测一遍，任何一层断了都算没做完。
 *
 * 重点覆盖「删错就回不来」的几处：
 *   - 默认 dryRun（不传 dryRun:false 就只预览）；
 *   - 三个安全阀（confirm / confirmText）各自 400，且错误里回带预览数字；
 *   - 四个 scope 的命中口径（尤其 timetable: / lms: 前缀的区分，不看 source）；
 *   - events / todos / notes **一条都不能少**（清空日程 ≠ 清空所有数据）；
 *   - 回收站能原样恢复、同 id 已存在要 skip、连删 60 批不会无限涨；
 *   - 指令层与 AI 都只产出**一条** scope:'all' 草稿，而不是 N 条逐条确认。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from '../src/server/index.js';
import { startMockAi } from './helpers/ai-mock.js';
import { bootRenderer } from './helpers/renderer-dom.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEY = 'sk-test-bulk-delete-123456';

/** 十条例程，覆盖四个 scope 的每一类边界（详见 seed()）。 */
const SCHEDULES = [
  { id: 'm1', title: '手建一', date: '2026-03-01', source: 'manual' },
  { id: 'm2', title: '手建二', date: '2026-03-02', source: 'manual' },
  { id: 'm3', title: '手建三', date: '2026-03-03', source: 'manual' },
  // 指令 / AI 建的：source 不是 manual，但过滤上是"非导入" → 都算进 source:'manual'
  { id: 'c1', title: '指令建的', date: '2026-03-04', source: 'command' },
  { id: 'a1', title: 'AI 建的', date: '2026-03-05', source: 'ai' },
  // 课表导入：source=import + timetable: 前缀（正常形状）
  { id: 't1', title: '高数', date: '2026-03-06', source: 'import', externalId: 'timetable:2025-2026-2:高等数学:1:1-2:aaaa1111' },
  // source=import 但没有 externalId（历史 / 手工导入）：bySource 归 import，
  // 但它没有 timetable: 前缀，所以 source:'timetable' 不删它 —— 只有 scope:'all' / ids 能清
  { id: 't2', title: '大物', date: '2026-03-07', source: 'import' },
  // source=manual 但带 timetable: 前缀 → 按"前缀优先"判据算课表导入（不看 source）
  { id: 't3', title: '线代', date: '2026-03-08', source: 'manual', externalId: 'timetable:2025-2026-2:线性代数:2:3-4:bbbb2222' },
  // 学堂同步：source 也是 import，但 externalId 是 lms: —— 不能算进课表范围
  { id: 'l1', title: '学堂作业', date: '2026-03-09', source: 'import', externalId: 'lms:homework:1001' },
  // source=lms 且带 lms: 前缀（真实数据里 source 也是 import，这里钉住前缀判据）
  { id: 'l2', title: '学堂直播', date: '2026-03-10', source: 'lms', externalId: 'lms:live:1002' },
];

const ALL_IDS = SCHEDULES.map((item) => item.id);
/** 课表范围只认 timetable: 前缀：t1 正常、t3 是"source=manual 但前缀是课表"。 */
const TIMETABLE_IDS = ['t1', 't3'];
/** 学堂范围只认 lms: 前缀：l1 的 source=import、l2 的 source=lms，都命中。 */
const LMS_IDS = ['l1', 'l2'];
/** source:'manual' = 非导入（manual / command / ai 都算）。 */
const MANUAL_IDS = ['m1', 'm2', 'm3', 'c1', 'a1'];
/** bySource 新形状：manual / command / ai 分开计数。 */
const ALL_BY_SOURCE = { manual: 3, command: 1, ai: 1, import: 3, lms: 2 };
const TIMETABLE_BY_SOURCE = { manual: 0, command: 0, ai: 0, import: 2, lms: 0 };

async function startApp({ ai } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-bulk-'));
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
  return { app, info, call, dataDir };
}

/** 落 10 条日程 + 事件 / 待办 / 笔记各几条（用来断言"没被误伤"）。 */
async function seed(app) {
  for (const item of SCHEDULES) {
    await app.store.schedules.insert({
      ...item,
      startTime: '09:00',
      endTime: '10:00',
      category: 'other',
      priority: 1,
      reminders: [],
      repeat: { type: 'none', interval: 1, weekdays: [], until: { mode: 'never' } },
    });
  }
  await app.store.events.insert({ title: '期中考试', startDate: '2026-03-15', category: 'exam' });
  await app.store.events.insert({ title: '校运会', startDate: '2026-03-20', endDate: '2026-03-21', category: 'other' });
  await app.store.todos.insert({ title: '交实验报告', deadline: '2026-03-12', estimatedHours: 2, completed: false });
  await app.store.todos.insert({ title: '背单词', deadline: '2026-03-13', estimatedHours: 1, completed: true });
  await app.store.notes.insert({ title: '课堂笔记', content: '傅里叶变换' });
  await app.store.notes.insert({ title: '读书笔记', content: '线性代数' });
}

const idsOf = async (call) => (await call('GET', '/schedules')).body.items.map((item) => item.id).sort();

/** 把回收站文件读出来（断言上限与落盘形状）。 */
const readTrashFile = async (dataDir) =>
  JSON.parse(await readFile(path.join(dataDir, 'schedules-trash.json'), 'utf8'));

/* ================================================================ 1. 预览 / 安全阀 */

test('批量删除：默认 dryRun 只预览不删（记录还在、回收站为空、样例最多 8 条）', async () => {
  const { app, call } = await startApp();
  try {
    await seed(app);
    const preview = await call('POST', '/schedules/bulk-delete', { scope: 'all' });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.dryRun, true);
    assert.equal(preview.body.scope, 'all');
    assert.equal(preview.body.count, 10);
    assert.equal(preview.body.requiresConfirm, true);
    assert.equal(preview.body.samples.length, 8, 'samples 最多 8 条');
    assert.deepEqual(preview.body.samples[0], {
      id: 'm1',
      title: '手建一',
      date: '2026-03-01',
      startTime: '09:00',
      source: 'manual',
    });
    // 默认只预览：记录一条不少，回收站也没被写脏
    assert.equal((await idsOf(call)).length, 10);
    assert.deepEqual((await call('GET', '/schedules/trash')).body.items, []);
  } finally {
    await app.close();
  }
});

test('批量删除：dryRun:false 没有 confirm → 400 CONFIRM_REQUIRED，并回带预览数字', async () => {
  const { app, call } = await startApp();
  try {
    await seed(app);
    const result = await call('POST', '/schedules/bulk-delete', { scope: 'all', dryRun: false });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'CONFIRM_REQUIRED');
    assert.equal(result.body.error.details.count, 10, '错误里要回带"将删除多少条"');
    assert.equal(result.body.error.details.requiresConfirm, true);
    assert.equal((await idsOf(call)).length, 10, '没确认就一条都不能删');
  } finally {
    await app.close();
  }
});

test("批量删除：scope:'all' 没有 confirmText:'删除' → 400 CONFIRM_TEXT_MISMATCH", async () => {
  const { app, call } = await startApp();
  try {
    await seed(app);
    const result = await call('POST', '/schedules/bulk-delete', { scope: 'all', dryRun: false, confirm: true });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'CONFIRM_TEXT_MISMATCH');
    assert.equal(result.body.error.details.expected, '删除');
    assert.equal(result.body.error.details.count, 10);
    assert.equal((await idsOf(call)).length, 10);
  } finally {
    await app.close();
  }
});

test("批量删除：范围不是 all 时不需要 confirmText（confirm 就够），错的范围 400", async () => {
  const { app, call } = await startApp();
  try {
    await seed(app);
    // 非 all 不带 confirmText：正常执行
    const removed = await call('POST', '/schedules/bulk-delete', {
      scope: 'ids',
      ids: ['m1'],
      dryRun: false,
      confirm: true,
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed, 1);
    // 未声明的 scope 是硬错误，不能静默当成 all
    const bad = await call('POST', '/schedules/bulk-delete', { scope: 'week', dryRun: false, confirm: true });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'BAD_REQUEST');
    assert.match(bad.body.error.message, /scope 不合法/);
  } finally {
    await app.close();
  }
});

/* ================================================================ 2. 四个 scope */

test("scope:'all'：清空全部 schedules，bySource 五桶正确，回收站文件 0600", async () => {
  const { app, call, dataDir } = await startApp();
  try {
    await seed(app);
    const result = await call('POST', '/schedules/bulk-delete', {
      scope: 'all',
      dryRun: false,
      confirm: true,
      confirmText: '删除',
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.removed, 10);
    // manual / command / ai 分开计数；timetable: 前缀归 import，lms: 前缀归 lms
    assert.deepEqual(result.body.bySource, ALL_BY_SOURCE);
    assert.match(result.body.trashId, /^trash-/);
    assert.equal((await idsOf(call)).length, 0);
    assert.equal((await call('GET', '/schedules/stats')).body.total, 0);

    const trash = await call('GET', '/schedules/trash');
    assert.equal(trash.body.count, 1);
    assert.equal(trash.body.items[0].count, 10);
    assert.equal(trash.body.items[0].scope, 'all');
    assert.deepEqual(trash.body.items[0].bySource, ALL_BY_SOURCE);
    assert.equal(trash.body.items[0].items, undefined, '回收站概况不能回记录正文');

    const fileStat = await stat(path.join(dataDir, 'schedules-trash.json'));
    assert.equal(fileStat.mode & 0o777, 0o600, '回收站文件必须是 0600');
    const file = await readTrashFile(dataDir);
    assert.equal(file.batches.length, 1);
    assert.equal(file.batches[0].items.length, 10, '整条记录都要存进去，恢复才能原样放回');
  } finally {
    await app.close();
  }
});

test("scope:'range'：只删 date 落在 [from,to] 内的（含两端）", async () => {
  const { app, call } = await startApp();
  try {
    await seed(app);
    const preview = await call('POST', '/schedules/bulk-delete', {
      scope: 'range',
      from: '2026-03-02',
      to: '2026-03-04',
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.count, 3);
    assert.deepEqual(preview.body.samples.map((item) => item.id), ['m2', 'm3', 'c1']);

    const result = await call('POST', '/schedules/bulk-delete', {
      scope: 'range',
      from: '2026-03-02',
      to: '2026-03-04',
      dryRun: false,
      confirm: true,
    });
    assert.equal(result.body.removed, 3);
    const left = await idsOf(call);
    assert.deepEqual(left, ['a1', 'l1', 'l2', 'm1', 't1', 't2', 't3']);
    // 区间校验：结束早于开始 / 缺日期都要 400，不能"猜一个区间"删掉
    const reversed = await call('POST', '/schedules/bulk-delete', { scope: 'range', from: '2026-03-05', to: '2026-03-01' });
    assert.equal(reversed.status, 400);
    const missing = await call('POST', '/schedules/bulk-delete', { scope: 'range' });
    assert.equal(missing.status, 400);
  } finally {
    await app.close();
  }
});

test("scope:'source'（timetable）：只删 timetable: 前缀，不碰 lms 与手动", async () => {
  const { app, call } = await startApp();
  try {
    await seed(app);
    const preview = await call('POST', '/schedules/bulk-delete', { scope: 'source', source: 'timetable' });
    assert.equal(preview.body.count, 2);
    assert.equal(preview.body.source, 'timetable');
    assert.deepEqual(preview.body.samples.map((item) => item.id), TIMETABLE_IDS);
    assert.deepEqual(preview.body.bySource, TIMETABLE_BY_SOURCE, '课表导入在 bySource 里归 import 桶');

    // 旧别名 import 等价于 timetable：同样只看前缀，不再按 source=import 误伤学堂记录
    const alias = await call('POST', '/schedules/bulk-delete', { scope: 'source', source: 'import' });
    assert.equal(alias.body.count, 2);
    assert.equal(alias.body.source, 'timetable', '别名要归一化成 timetable 回显');

    const result = await call('POST', '/schedules/bulk-delete', {
      scope: 'source',
      source: 'timetable',
      dryRun: false,
      confirm: true,
    });
    assert.equal(result.body.removed, 2);
    assert.deepEqual(result.body.bySource, TIMETABLE_BY_SOURCE);
    const left = await idsOf(call);
    assert.deepEqual(left, ['a1', 'c1', 'l1', 'l2', 'm1', 'm2', 'm3', 't2']);
    // lms 前缀与手动记录一条都不能少；t2（source=import 但没有前缀）也不该被课表范围删掉
    for (const id of ['l1', 'l2', 'm1', 'c1', 'a1', 't2']) assert.ok(left.includes(id), `${id} 不应被课表范围删除`);
  } finally {
    await app.close();
  }
});

test("scope:'source'（lms）：只删 lms: 前缀，不碰 timetable 与手动", async () => {
  const { app, call } = await startApp();
  try {
    await seed(app);
    const preview = await call('POST', '/schedules/bulk-delete', { scope: 'source', source: 'lms' });
    assert.equal(preview.body.count, 2);
    assert.deepEqual(preview.body.samples.map((item) => item.id), LMS_IDS);
    assert.deepEqual(preview.body.bySource, { manual: 0, command: 0, ai: 0, import: 0, lms: 2 });

    const result = await call('POST', '/schedules/bulk-delete', {
      scope: 'source',
      source: 'lms',
      dryRun: false,
      confirm: true,
    });
    assert.equal(result.body.removed, 2);
    const left = await idsOf(call);
    assert.deepEqual(left, ['a1', 'c1', 'm1', 'm2', 'm3', 't1', 't2', 't3']);
    // 课表前缀与手动记录一条都不能少
    for (const id of ['t1', 't2', 't3', 'm1', 'c1', 'a1']) assert.ok(left.includes(id), `${id} 不应被学堂范围删除`);
  } finally {
    await app.close();
  }
});

test("scope:'source'（manual）：只删自己建的（manual/command/ai），导入与学堂同步留下", async () => {
  const { app, call } = await startApp();
  try {
    await seed(app);
    const preview = await call('POST', '/schedules/bulk-delete', { scope: 'source', source: 'manual' });
    assert.equal(preview.body.count, 5);
    assert.deepEqual(preview.body.samples.map((item) => item.id), MANUAL_IDS);
    const result = await call('POST', '/schedules/bulk-delete', {
      scope: 'source',
      source: 'manual',
      dryRun: false,
      confirm: true,
    });
    assert.equal(result.body.removed, 5);
    // 过滤仍是"非导入"（三类都删），但 bySource 把 manual / command / ai 分开报
    assert.deepEqual(result.body.bySource, { manual: 3, command: 1, ai: 1, import: 0, lms: 0 });
    assert.deepEqual(await idsOf(call), ['l1', 'l2', 't1', 't2', 't3']);
    // source 写错 / 没写都是 400：不能把未知来源当成 manual 删掉用户数据
    const bad = await call('POST', '/schedules/bulk-delete', { scope: 'source', source: 'imported' });
    assert.equal(bad.status, 400);
  } finally {
    await app.close();
  }
});

test("scope:'ids'：精确删除、重复 id 去重、未知 id 忽略", async () => {
  const { app, call } = await startApp();
  try {
    await seed(app);
    const preview = await call('POST', '/schedules/bulk-delete', {
      scope: 'ids',
      ids: ['m1', 't1', 'm1', 'not-exist'],
    });
    assert.equal(preview.body.count, 2, '重复 id 只算一条，未知 id 不算命中');
    const result = await call('POST', '/schedules/bulk-delete', {
      scope: 'ids',
      ids: ['m1', 't1', 'm1', 'not-exist'],
      dryRun: false,
      confirm: true,
    });
    assert.equal(result.body.removed, 2);
    const left = await idsOf(call);
    assert.equal(left.length, 8);
    assert.ok(!left.includes('m1') && !left.includes('t1'));
    assert.ok(left.includes('m2') && left.includes('t2'));
    const empty = await call('POST', '/schedules/bulk-delete', { scope: 'ids', ids: [] });
    assert.equal(empty.status, 400);
  } finally {
    await app.close();
  }
});

/* ================================================================ 3. 不误伤别的集合 */

test("清空全部日程：events / todos / notes 条数与内容完全不变", async () => {
  const { app, call } = await startApp();
  try {
    await seed(app);
    const eventsBefore = (await call('GET', '/events')).body.items;
    const todosBefore = (await call('GET', '/todos')).body.items;
    const notesBefore = app.store.notes.all();
    assert.equal(eventsBefore.length, 2);
    assert.equal(todosBefore.length, 2);
    assert.equal(notesBefore.length, 2);

    await call('POST', '/schedules/bulk-delete', {
      scope: 'all',
      dryRun: false,
      confirm: true,
      confirmText: '删除',
    });

    assert.equal((await call('GET', '/schedules')).body.items.length, 0, '日程清空');
    const eventsAfter = (await call('GET', '/events')).body.items;
    const todosAfter = (await call('GET', '/todos')).body.items;
    const notesAfter = app.store.notes.all();
    assert.equal(eventsAfter.length, 2, 'events 一条都不能少');
    assert.equal(todosAfter.length, 2, 'todos 一条都不能少');
    assert.equal(notesAfter.length, 2, 'notes 一条都不能少');
    assert.deepEqual(eventsAfter.map((item) => item.title).sort(), ['期中考试', '校运会']);
    assert.deepEqual(todosAfter.map((item) => item.title).sort(), ['交实验报告', '背单词']);
    assert.deepEqual(notesAfter.map((item) => item.title).sort(), ['读书笔记', '课堂笔记']);
  } finally {
    await app.close();
  }
});

/* ================================================================ 4. 回收站 */

test('回收站：删除后可恢复（条数 / 内容 / id 一致），同 id 已存在则跳过', async () => {
  const { app, call } = await startApp();
  try {
    await seed(app);
    const before = (await call('GET', '/schedules')).body.items;
    const removed = await call('POST', '/schedules/bulk-delete', {
      scope: 'all',
      dryRun: false,
      confirm: true,
      confirmText: '删除',
    });
    const restored = await call('POST', '/schedules/trash/restore', { trashId: removed.body.trashId });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.restored, 10);
    assert.equal(restored.body.skipped, 0);
    const after = (await call('GET', '/schedules')).body.items;
    const pick = (item) => ({
      id: item.id,
      title: item.title,
      date: item.date,
      startTime: item.startTime,
      source: item.source,
      externalId: item.externalId ?? null,
    });
    assert.deepEqual(after.map(pick).sort((a, b) => a.id.localeCompare(b.id)), before.map(pick).sort((a, b) => a.id.localeCompare(b.id)));
    assert.deepEqual((await call('GET', '/schedules/trash')).body.items, [], '恢复过的批次要从回收站移除');

    // 再删一次，然后模拟"删除后又被同步回灌了一条同 id 的记录"：恢复时必须跳过而不是覆盖
    const second = await call('POST', '/schedules/bulk-delete', {
      scope: 'all',
      dryRun: false,
      confirm: true,
      confirmText: '删除',
    });
    await app.store.schedules.insert({
      ...before.find((item) => item.id === 'm1'),
      title: '同步回来的新标题',
    });
    const partial = await call('POST', '/schedules/trash/restore', { trashId: second.body.trashId });
    assert.equal(partial.body.restored, 9);
    assert.equal(partial.body.skipped, 1);
    const list = (await call('GET', '/schedules')).body.items;
    assert.equal(list.length, 10);
    assert.equal(list.find((item) => item.id === 'm1').title, '同步回来的新标题', '同 id 已存在时不覆盖现有记录');

    // 清空回收站也要 confirm（破坏性动作同一套规矩）
    await call('POST', '/schedules/bulk-delete', { scope: 'ids', ids: ['m2'], dryRun: false, confirm: true });
    const noConfirm = await call('POST', '/schedules/trash/clear', {});
    assert.equal(noConfirm.status, 400);
    assert.equal(noConfirm.body.error.code, 'CONFIRM_REQUIRED');
    const cleared = await call('POST', '/schedules/trash/clear', { confirm: true });
    assert.equal(cleared.body.cleared, 1);
    assert.deepEqual((await call('GET', '/schedules/trash')).body.items, []);
  } finally {
    await app.close();
  }
});

test('回收站上限：连删 60 批只保留最近 50 批（最旧的丢弃）', async () => {
  const { app, call, dataDir } = await startApp();
  try {
    for (let i = 1; i <= 60; i += 1) {
      await app.store.schedules.insert({ id: `x${i}`, title: `第 ${i} 条`, date: '2026-04-01', startTime: '09:00', source: 'manual' });
      const result = await call('POST', '/schedules/bulk-delete', {
        scope: 'ids',
        ids: [`x${i}`],
        dryRun: false,
        confirm: true,
      });
      assert.equal(result.body.removed, 1);
    }
    const trash = await call('GET', '/schedules/trash');
    assert.equal(trash.body.count, 50, '批数上限 50');
    assert.equal(trash.body.total, 50);
    const file = await readTrashFile(dataDir);
    assert.equal(file.batches.length, 50);
    assert.equal(file.batches[0].items[0].id, 'x60', '最新一批在最前（撤销指向它）');
    assert.equal(file.batches.at(-1).items[0].id, 'x11', '最旧的 10 批被丢掉');
    assert.equal((await call('GET', '/schedules')).body.items.length, 0);
  } finally {
    await app.close();
  }
});

test('回收站上限：单批记录总量超过 500 时按最旧丢弃（最多 500 条）', async () => {
  const { app, call, dataDir } = await startApp();
  try {
    const stamp = (n) => new Date(2026, 0, 1, 0, 0, n).toISOString();
    for (let batch = 1; batch <= 12; batch += 1) {
      const ids = [];
      // 直接写 Collection 的内存表再 persist 一次：600 条逐条 insert 会做 600 次全量落盘，测试没必要那么慢
      for (let i = 0; i < 50; i += 1) {
        const id = `r${batch}-${i}`;
        ids.push(id);
        app.store.schedules.records.set(id, {
          id,
          title: `批量 ${batch}-${i}`,
          date: '2026-04-02',
          startTime: '09:00',
          source: 'manual',
          createdAt: stamp(batch * 50 + i),
          updatedAt: stamp(batch * 50 + i),
        });
      }
      await app.store.schedules.persist();
      const result = await call('POST', '/schedules/bulk-delete', {
        scope: 'ids',
        ids,
        dryRun: false,
        confirm: true,
      });
      assert.equal(result.body.removed, 50);
    }
    const trash = await call('GET', '/schedules/trash');
    assert.equal(trash.body.total, 500, '记录总量上限 500');
    assert.equal(trash.body.count, 10, '12 批 × 50 条 → 丢最旧的 2 批，剩 10 批');
    const file = await readTrashFile(dataDir);
    assert.equal(file.batches.length, 10);
    assert.equal(file.batches[0].items[0].id, 'r12-0');
  } finally {
    await app.close();
  }
});

/* ================================================================ 5. 指令层 */

test("指令层：dryRun 返回 planned:'bulk' + count/samples，确认后走服务层真删", async () => {
  const { app, call } = await startApp();
  try {
    await seed(app);
    const draft = {
      ok: true,
      action: 'delete',
      target: 'schedule',
      filters: { scope: 'all' },
      explain: '清空全部日程',
    };
    const preview = await call('POST', '/commands/execute', { draft, dryRun: true });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.dryRun, true);
    assert.equal(preview.body.planned, 'bulk');
    assert.equal(preview.body.count, 10);
    assert.equal(preview.body.samples.length, 8);
    assert.match(preview.body.explain, /将删除 10 条日程（范围：全部）/);
    assert.ok(preview.body.warnings.some((text) => /这会清空全部日程/.test(text)), '全部范围必须先提示清空');
    assert.equal((await idsOf(call)).length, 10, 'dryRun 不能删');

    const result = await call('POST', '/commands/execute', { draft });
    assert.equal(result.status, 200);
    assert.equal(result.body.removed, 10);
    assert.match(result.body.trashId, /^trash-/);
    assert.deepEqual(result.body.bySource, ALL_BY_SOURCE);
    assert.match(result.body.explain, /已删除 10 条日程/);
    assert.ok(result.body.warnings.some((text) => /这会清空全部日程/.test(text)));
    assert.equal((await idsOf(call)).length, 0);
  } finally {
    await app.close();
  }
});

test('指令层：range / source 的 filters 也走批量删除（不再逐条 locate）', async () => {
  const { app, call } = await startApp();
  try {
    await seed(app);
    const range = await call('POST', '/commands/execute', {
      draft: {
        ok: true,
        action: 'delete',
        target: 'schedule',
        filters: { scope: 'range', from: '2026-03-02', to: '2026-03-04' },
      },
      dryRun: true,
    });
    assert.equal(range.body.count, 3);
    assert.match(range.body.explain, /时间段 2026-03-02 至 2026-03-04/);
    const timetable = await call('POST', '/commands/execute', {
      draft: { ok: true, action: 'delete', target: 'schedule', filters: { scope: 'source', source: 'timetable' } },
      dryRun: true,
    });
    assert.equal(timetable.body.count, 2);
    assert.match(timetable.body.explain, /仅课表导入/);
    const lms = await call('POST', '/commands/execute', {
      draft: { ok: true, action: 'delete', target: 'schedule', filters: { scope: 'source', source: 'lms' } },
      dryRun: true,
    });
    assert.equal(lms.body.count, 2);
    assert.match(lms.body.explain, /仅学堂同步/);
    // 空库执行 scope:'all' 是"没东西可删"，不是 500/404
    await call('POST', '/commands/execute', {
      draft: { ok: true, action: 'delete', target: 'schedule', filters: { scope: 'ids', ids: ALL_IDS } },
    });
    const empty = await call('POST', '/commands/execute', {
      draft: { ok: true, action: 'delete', target: 'schedule', filters: { scope: 'all' } },
    });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.removed, 0);
    assert.match(empty.body.explain, /没有符合条件的日程/);
  } finally {
    await app.close();
  }
});

/* ================================================================ 6. AI 真链路（mock 上游） */

const fenced = (draft) => `\`\`\`command\n${JSON.stringify(draft)}\n\`\`\``;
const clearAllDraft = {
  ok: true,
  action: 'delete',
  target: 'schedule',
  filters: { scope: 'all' },
  explain: '清空全部日程（10 条）',
};

test("AI：说「删除所有日程」只产出**一条** scope:'all' 草稿，preview 回带真实条数与清空警告", async () => {
  const reply = `好的，这会清空全部日程（10 条），删除后可在日程页的「回收站」撤销。\n\n${fenced(clearAllDraft)}`;
  const mock = await startMockAi({ apiKey: KEY, reply });
  const { app, call } = await startApp({ ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    await seed(app);
    const chat = await call('POST', '/ai/chat', { text: '说错了，是删除所有日程', permission: 'manual' });
    assert.equal(chat.status, 200, JSON.stringify(chat.body).slice(0, 400));
    assert.equal(chat.body.drafts.length, 1, '按范围删除是**一个动作一条草稿**，不能拆成 N 条');
    const entry = chat.body.drafts[0];
    assert.equal(entry.draft.action, 'delete');
    assert.equal(entry.draft.target, 'schedule');
    assert.deepEqual(entry.draft.filters, { scope: 'all' });
    assert.equal(entry.preview.planned, 'bulk');
    assert.equal(entry.preview.count, 10);
    assert.ok(entry.preview.warnings.some((text) => /这会清空全部日程/.test(text)), 'preview.warnings 必须含清空提示');
    // 确认卡渲染的是 draft.warnings（外壳不读 preview.warnings）→ 草稿本身也要带
    assert.ok(entry.draft.warnings.some((text) => /这会清空全部日程/.test(text)), '确认卡上的草稿本身要带清空警告');
    assert.equal((await idsOf(call)).length, 10, 'manual 档只出确认卡，确认前不落库');

    // 系统提示词里写明了"按范围删是一个动作"，模型才不会再回答"没有清空这个动作"
    const system = String(mock.state.bodies[0].messages[0].content ?? '');
    assert.match(system, /【按范围删除日程/);
    assert.match(system, /拆成一条条逐条确认/);
    assert.match(system, /filters\.scope/);

    // 用户点确认 → 真正清空；回执 removed>0
    const executed = await call('POST', '/commands/execute', { draft: entry.draft });
    assert.equal(executed.status, 200);
    assert.equal(executed.body.removed, 10);
    assert.ok(executed.body.removed > 0);
    assert.equal(
      executed.body.warnings.filter((text) => /这会清空全部日程/.test(text)).length,
      1,
      '草稿回传后再执行，清空警告不能重复',
    );
    assert.equal((await idsOf(call)).length, 0);
  } finally {
    await app.close();
    await mock.close();
  }
});

test("AI auto 档：同一句话直接执行那一条草稿，回执报出 removed 与清空警告", async () => {
  const replies = [
    `这会清空全部日程（10 条），删除后可在「回收站」撤销。\n\n${fenced(clearAllDraft)}`,
    '已经清空 10 条日程，可在日程页的「回收站」撤销。',
  ];
  const mock = await startMockAi({ apiKey: KEY, replies });
  const { app, call } = await startApp({ ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    await seed(app);
    const chat = await call('POST', '/ai/chat', { text: '删除所有日程', permission: 'auto' });
    assert.equal(chat.status, 200, JSON.stringify(chat.body).slice(0, 400));
    assert.equal(chat.body.executed.length, 1, '只执行一条批量删除（不能逐条执行 10 次）');
    assert.equal(chat.body.executed[0].result.removed, 10);
    assert.ok(chat.body.executed[0].result.removed > 0);
    assert.ok(
      chat.body.executed[0].result.warnings.some((text) => /这会清空全部日程/.test(text)),
      'auto 档回执里必须有清空提示',
    );
    assert.deepEqual(chat.body.drafts, [], 'auto 档执行完不该再留确认卡');
    assert.equal((await idsOf(call)).length, 0, '真清空');
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ================================================================ 7. 渲染层 */

test('渲染层：日程工具栏有「批量删除」入口，弹层有五个范围 / 预览 / 回收站撤销', async () => {
  const source = await readFile(path.join(HERE, '../src/renderer/views/calendar.js'), 'utf8');
  for (const text of ['批量删除', '全部日程', '某时间段', '仅课表导入的课程', '仅学堂同步的', '仅手动创建的', '预览将删除的日程', '撤销上次删除', '回收站']) {
    assert.ok(source.includes(text), `calendar.js 缺少入口文案：${text}`);
  }
  assert.match(source, /\/schedules\/bulk-delete/);
  assert.match(source, /\/schedules\/trash\/restore/);

  const requests = [];
  const api = async (url, options = {}) => {
    requests.push({ url, body: options.body });
    if (url.startsWith('/categories')) return { items: [] };
    if (url.startsWith('/calendar?')) return { days: [] };
    if (url.startsWith('/meta/lunar')) return { days: {} };
    if (url === '/schedules/trash') {
      return { items: [{ id: 'trash-1', at: '2026-10-18T00:00:00.000Z', count: 4, bySource: { manual: 4, import: 0, lms: 0 }, scope: 'all' }], count: 1, total: 4 };
    }
    if (url === '/schedules/bulk-delete') {
      const body = options.body ?? {};
      if (body.dryRun) {
        return {
          dryRun: true,
          scope: body.scope,
          count: 2,
          samples: [{ id: 's1', title: '项目周会', date: '2026-10-12', startTime: '15:00', source: 'manual' }],
          bySource: { manual: 2, import: 0, lms: 0 },
          requiresConfirm: true,
        };
      }
      return { dryRun: false, removed: 2, trashId: 'trash-2', bySource: { manual: 2, import: 0, lms: 0 } };
    }
    if (url === '/schedules/trash/restore') return { restored: 4, skipped: 0, trashId: options.body.trashId };
    return {};
  };
  const { context, PC, render } = bootRenderer({ api, state: { calendar: { mode: 'month', anchor: '2026-10-12', categories: {} }, todo: { filter: 'all' }, panelCollapsed: false } });
  const toasts = [];
  PC.toast = (message) => toasts.push(message);
  const mount = await render('calendar', { mode: 'month' });

  const bulkBtn = mount.querySelectorAll('button').find((button) => button.textContent === '批量删除');
  assert.ok(bulkBtn, '工具栏必须有「批量删除」按钮');
  bulkBtn.listeners.click[0]();

  await new Promise((resolve) => setTimeout(resolve, 15));
  const modal = context.document.body.querySelector('.bulk-modal');
  assert.ok(modal, '点按钮应打开批量删除弹层');
  assert.deepEqual(
    modal.querySelectorAll('.bulk-scope-label').map((node) => node.textContent),
    ['全部日程', '某时间段', '仅课表导入的课程', '仅学堂同步的', '仅手动创建的'],
  );
  assert.ok(modal.querySelector('.bulk-undo'), '弹层里要有「撤销上次删除」按钮');
  assert.match(modal.querySelector('.bulk-undo').textContent, /撤销上次删除/);
  assert.equal(modal.querySelector('.bulk-undo').disabled, false, '回收站有记录时撤销可用');

  // 预览 → 显示真实条数与样例
  modal.querySelector('.bulk-preview-btn').listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.match(modal.querySelector('.bulk-count').textContent, /将删除 2 条/);
  assert.match(modal.querySelector('.bulk-preview').textContent, /项目周会/);
  assert.equal(modal.querySelector('.bulk-confirm').disabled, false, '预览过且非全部范围 → 可确认');

  // 确认删除：confirm:true 且 toast 指向回收站
  modal.querySelector('.bulk-confirm').listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 15));
  const del = requests.filter((item) => item.url === '/schedules/bulk-delete' && item.body?.dryRun === false);
  assert.equal(del.length, 1);
  assert.equal(del[0].body.confirm, true);
  assert.equal(del[0].body.confirmText, undefined, '非全部范围不需要中文确认词');
  assert.ok(toasts.some((message) => /已删除 2 条/.test(message) && /回收站/.test(message)));

  // 撤销上次删除：调 restore
  modal.querySelector('.bulk-undo').listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(requests.some((item) => item.url === '/schedules/trash/restore'), '撤销要走回收站恢复接口');
});

test('渲染层：全部范围必须勾选「我知道这会清空全部日程」，确认请求带 confirmText「删除」', async () => {
  const requests = [];
  const api = async (url, options = {}) => {
    requests.push({ url, body: options.body });
    if (url.startsWith('/categories')) return { items: [] };
    if (url.startsWith('/calendar?')) return { days: [] };
    if (url.startsWith('/meta/lunar')) return { days: {} };
    if (url === '/schedules/trash') return { items: [], count: 0, total: 0 };
    if (url === '/schedules/bulk-delete') {
      if (options.body?.dryRun) {
        return {
          dryRun: true,
          scope: 'all',
          count: 6,
          samples: [{ id: 's1', title: '高数', date: '2026-10-12', startTime: '08:00', source: 'import' }],
          bySource: { manual: 2, import: 4, lms: 0 },
          requiresConfirm: true,
        };
      }
      return { dryRun: false, removed: 6, trashId: 'trash-3', bySource: { manual: 2, import: 4, lms: 0 } };
    }
    return {};
  };
  const { context, PC, render } = bootRenderer({ api, state: { calendar: { mode: 'month', anchor: '2026-10-12', categories: {} }, todo: { filter: 'all' }, panelCollapsed: false } });
  const toasts = [];
  PC.toast = (message) => toasts.push(message);
  const mount = await render('calendar', { mode: 'month' });
  mount.querySelectorAll('button').find((button) => button.textContent === '批量删除').listeners.click[0]();
  const modal = context.document.body.querySelector('.bulk-modal');

  // 切到「全部日程」：出现红线提示与勾选框
  const allRadio = modal.querySelectorAll('.bulk-radio').find((radio) => radio.value === 'all');
  allRadio.listeners.change[0]();
  assert.match(modal.querySelector('.bulk-all-warn').textContent, /我知道这会清空全部日程/);

  modal.querySelector('.bulk-preview-btn').listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 15));
  const confirm = modal.querySelector('.bulk-confirm');
  assert.equal(confirm.disabled, true, '全部范围没勾选前，红按钮必须禁用');
  const allCheck = modal.querySelector('.bulk-all-check');
  allCheck.checked = true;
  allCheck.listeners.change[0]();
  assert.equal(confirm.disabled, false, '勾选后才能点确认');

  confirm.listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 15));
  const del = requests.filter((item) => item.url === '/schedules/bulk-delete' && item.body?.dryRun === false);
  assert.equal(del.length, 1);
  assert.equal(del[0].body.confirmText, '删除', '全部范围必须带中文确认词');
  assert.equal(del[0].body.scope, 'all');
  assert.ok(toasts.some((message) => /已删除 6 条/.test(message)));
});
