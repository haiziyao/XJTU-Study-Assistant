/**
 * 成长模块 · 任务生命周期（搬自 Brain Online test/tasks.test.js）。
 *
 * 覆盖：经验公式、生成任务的截止时刻、幂等打卡、撤销扣回、逾期判定、
 * 统计口径与手动任务的校验。全部走真实 HTTP（临时 dataDir、端口 0），
 * 因为“服务层对了但路由包错了”同样会让用户看到错的东西。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { xpForTask } from '../src/modules/growth/tasks.js';

const STATE = { sleepHours: 7, sleepQuality: 4, energy: 4, mood: 4, stress: 2, focus: 4, body: 4 };

async function startApp() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-growth-tasks-'));
  const app = await createServer({
    dataDir,
    onlyModules: ['growth'],
    growth: { now: () => new Date(2026, 9, 26, 9, 0, 0) },
  });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}/growth${route}`, {
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
    return { status: response.status, body: parsed, headers: response.headers };
  };
  const close = async () => {
    await call('POST', '/system/shutdown', { reason: 'test-cleanup' }).catch(() => {});
    await app.close();
    await app.services.growth?.closing?.catch?.(() => {});
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  };
  return { app, call, close };
}

test('经验值公式：难度与时长都影响，深度任务有加成', () => {
  assert.equal(xpForTask({ difficulty: 1, estimateMin: 10, kind: 'life' }), 8 + 2);
  assert.equal(xpForTask({ difficulty: 4, estimateMin: 90, kind: 'focus' }), 32 + 18 + 5);
  assert.ok(
    xpForTask({ difficulty: 5, estimateMin: 60, kind: 'focus' }) > xpForTask({ difficulty: 1, estimateMin: 60, kind: 'life' }),
  );
});

test('生成的任务落到当天，截止时间是当天 23:59', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/state', STATE);
    const plan = await ctx.call('POST', '/plan/generate', {});
    assert.equal(plan.status, 200);
    assert.equal(plan.body.tasks.length >= 3, true);
    for (const task of plan.body.tasks) {
      assert.equal(task.date, '2026-10-26');
      assert.equal(task.status, 'todo');
      assert.ok(task.dueAt.includes('23:59:59'), task.dueAt);
      assert.ok(task.xp > 0);
    }
  } finally {
    await ctx.close();
  }
});

test('打卡：完成会加经验，重复完成不重复加', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/state', STATE);
    const plan = await ctx.call('POST', '/plan/generate', {});
    const task = plan.body.tasks[0];
    const first = await ctx.call('PATCH', `/tasks/${task.id}`, { status: 'done' });
    assert.ok(first.body.award.xp > 0);
    assert.equal(first.body.award.totalXp, first.body.award.xp);

    const again = await ctx.call('PATCH', `/tasks/${task.id}`, { status: 'done' });
    assert.equal(again.body.idempotent, true);
    const character = await ctx.call('GET', '/character');
    assert.equal(character.body.character.totalXp, first.body.award.xp);
  } finally {
    await ctx.close();
  }
});

test('撤销完成会扣回经验，且不会扣成负数', async () => {
  const ctx = await startApp();
  try {
    const created = await ctx.call('POST', '/tasks', { title: '深度工作块', kind: 'focus', difficulty: 4, estimateMin: 30 });
    const id = created.body.task.id;
    await ctx.call('PATCH', `/tasks/${id}`, { status: 'done' });
    const revoked = await ctx.call('PATCH', `/tasks/${id}`, { status: 'todo' });
    assert.ok(revoked.body.award.xp < 0);
    const character = await ctx.call('GET', '/character');
    assert.equal(character.body.character.totalXp, 0);
    assert.equal(character.body.character.attrs.focus, 0);
  } finally {
    await ctx.close();
  }
});

test('逾期：只有"未完成 + 已过截止"才算，完成后不再提醒', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/tasks', { title: '昨天的报告', date: '2026-10-24', estimateMin: 30 });
    const overdue = await ctx.call('GET', '/tasks/overdue');
    assert.equal(overdue.body.count, 1);

    const task = overdue.body.tasks[0];
    await ctx.call('PATCH', `/tasks/${task.id}`, { status: 'done' });
    assert.equal((await ctx.call('GET', '/tasks/overdue')).body.count, 0);
  } finally {
    await ctx.close();
  }
});

test('当天还没到截止时间的不算逾期', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/tasks', { title: '今晚交', date: '2026-10-26' });
    assert.equal((await ctx.call('GET', '/tasks/overdue')).body.count, 0);
  } finally {
    await ctx.close();
  }
});

test('统计：完成/跳过/未做分别计数，投入只算完成的', async () => {
  const ctx = await startApp();
  try {
    const first = await ctx.call('POST', '/tasks', { title: '写实验报告', kind: 'focus', estimateMin: 30 });
    const second = await ctx.call('POST', '/tasks', { title: '整理桌面', kind: 'life', estimateMin: 5 });
    const third = await ctx.call('POST', '/tasks', { title: '待定', kind: 'life', estimateMin: 5 });
    await ctx.call('PATCH', `/tasks/${first.body.task.id}`, { status: 'done' });
    await ctx.call('PATCH', `/tasks/${second.body.task.id}`, { status: 'skipped' });

    const today = await ctx.call('GET', '/today');
    assert.equal(today.body.stats.total, 3);
    assert.equal(today.body.stats.done, 1);
    assert.equal(today.body.stats.skipped, 1);
    assert.equal(today.body.stats.todo, 1);
    assert.equal(today.body.stats.minutesDone, 30);
    assert.ok(today.body.stats.xpDone > 0);
    assert.equal(third.body.task.status, 'todo');
  } finally {
    await ctx.close();
  }
});

test('手动任务：标题必填、长度受限，非法状态被拒', async () => {
  const ctx = await startApp();
  try {
    const empty = await ctx.call('POST', '/tasks', { title: '   ' });
    assert.equal(empty.status, 400);
    assert.match(empty.body.error.message, /标题/);

    const long = await ctx.call('POST', '/tasks', { title: 'x'.repeat(100) });
    assert.equal(long.status, 400);
    assert.match(long.body.error.message, /标题/);

    const missing = await ctx.call('PATCH', '/tasks/nope', { status: 'done' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'TASK_NOT_FOUND');

    const task = await ctx.call('POST', '/tasks', { title: '给导师回邮件', kind: 'life', estimateMin: 15 });
    assert.equal(task.body.task.source, 'manual');

    const bad = await ctx.call('PATCH', `/tasks/${task.body.task.id}`, { status: 'whatever' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /status/);
  } finally {
    await ctx.close();
  }
});
