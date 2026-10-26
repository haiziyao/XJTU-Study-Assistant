/**
 * 成长模块 · 接口冒烟（搬自 Brain Online test/api.test.js）。
 *
 * 覆盖：模块发现、完整主线（录状态 → 生成表单 → 打卡 → 角色成长）、
 * 没有状态时的 400、重复生成/force 重排保留已完成项、未知接口 404、
 * 关机存档、AI 降级、趋势的 null、逾期扫描。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';

const STATE = { sleepHours: 7, sleepQuality: 4, energy: 4, mood: 4, stress: 2, focus: 4, body: 4 };

async function startApp() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-growth-api-'));
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
  const callRoot = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const close = async () => {
    await call('POST', '/system/shutdown', { reason: 'test-cleanup' }).catch(() => {});
    await app.close();
    await app.services.growth?.closing?.catch?.(() => {});
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  };
  return { app, info, call, callRoot, close, dataDir };
}

test('模块发现与健康检查：growth 出现在 /modules，集合已注册', async () => {
  const ctx = await startApp();
  try {
    const listed = await ctx.callRoot('GET', '/modules');
    const growth = listed.body.items.find((item) => item.id === 'growth');
    assert.ok(growth, 'growth 模块要被自动发现');
    assert.equal(growth.title, '成长');
    assert.equal(growth.order, 50, 'memory 45 之后、knowledge 70 之前');
    for (const name of [
      'growthStates',
      'growthPlans',
      'growthTasks',
      'growthSessions',
      'growthLogs',
      'growthRpg',
      'growthTemplates',
      'growthSettings',
    ]) {
      assert.ok(growth.collections.includes(name), `缺少集合 ${name}`);
    }
    for (const hook of ['createServices', 'registerRoutes', 'restore', 'start', 'stop']) {
      assert.ok(growth.hooks.includes(hook), `缺少钩子 ${hook}`);
    }

    const health = await ctx.callRoot('GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');
    assert.equal(health.body.counts.growthStates, 0);
    assert.ok(health.body.counts.growthSessions >= 1, '开机后至少一条会话');
  } finally {
    await ctx.close();
  }
});

test('完整主线：录状态 → 生成表单 → 打卡 → 角色成长', async () => {
  const ctx = await startApp();
  try {
    const state = await ctx.call('POST', '/state', STATE);
    assert.equal(state.status, 200);
    assert.equal(state.body.entry.date, '2026-10-26');
    assert.ok(state.body.entry.score > 0);
    assert.ok(['push', 'steady', 'recover'].includes(state.body.entry.mode));

    const plan = await ctx.call('POST', '/plan/generate', {});
    assert.equal(plan.status, 200);
    assert.ok(plan.body.tasks.length >= 3);
    assert.equal(plan.body.plan.date, '2026-10-26');
    assert.ok(plan.body.plan.rationale.length >= 2);

    const task = plan.body.tasks[0];
    const done = await ctx.call('PATCH', `/tasks/${task.id}`, { status: 'done' });
    assert.equal(done.status, 200);
    assert.ok(done.body.award.xp > 0);

    const character = await ctx.call('GET', '/character');
    assert.ok(character.body.character.level >= 1);
    assert.ok(character.body.character.totalXp > 0);
    assert.equal(character.body.character.streak, 1);

    const today = await ctx.call('GET', '/today');
    assert.equal(today.body.stats.done, 1);
    assert.ok(today.body.xpGained > 0);
  } finally {
    await ctx.close();
  }
});

test('没有状态时生成表单会被挡住，并说明原因', async () => {
  const ctx = await startApp();
  try {
    const plan = await ctx.call('POST', '/plan/generate', {});
    assert.equal(plan.status, 400);
    assert.equal(plan.body.error.code, 'STATE_REQUIRED');
    assert.match(plan.body.error.message, /状态/);
  } finally {
    await ctx.close();
  }
});

test('重复生成不会重复建任务；force 重排保留已完成项', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/state', STATE);
    const first = await ctx.call('POST', '/plan/generate', {});
    const again = await ctx.call('POST', '/plan/generate', {});
    assert.equal(again.body.created, false);
    assert.equal(again.body.tasks.length, first.body.tasks.length);

    const doneTask = first.body.tasks[0];
    await ctx.call('PATCH', `/tasks/${doneTask.id}`, { status: 'done' });

    const forced = await ctx.call('POST', '/plan/generate', { force: true });
    assert.equal(forced.body.created, true);
    const stillThere = forced.body.tasks.find((task) => task.id === doneTask.id);
    assert.ok(stillThere, '已完成的任务不能被重排抹掉');
    assert.equal(stillThere.status, 'done');
  } finally {
    await ctx.close();
  }
});

test('录入非法状态返回 400 与可读的中文原因', async () => {
  const ctx = await startApp();
  try {
    const bad = await ctx.call('POST', '/state', { ...STATE, energy: 9 });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /精力/);
  } finally {
    await ctx.close();
  }
});

test('未知接口返回 404（JSON，不是 HTML）', async () => {
  const ctx = await startApp();
  try {
    const missing = await ctx.call('GET', '/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'NOT_FOUND');
    assert.match(missing.body.error.message, /nope/);
  } finally {
    await ctx.close();
  }
});

test('关机接口会写存档文件，并把会话标记为已结束', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/state', STATE);
    await ctx.call('POST', '/plan/generate', {});

    const shutdown = await ctx.call('POST', '/system/shutdown', { reason: 'test' });
    assert.equal(shutdown.status, 200);
    assert.equal(shutdown.body.archived, true);

    const file = path.join(ctx.dataDir, 'archive', shutdown.body.file);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(raw.date, '2026-10-26');
    assert.ok(raw.day.plan);
    assert.ok(raw.day.tasks.length > 0);
    assert.equal(raw.reason, 'test');

    const status = await ctx.call('GET', '/system/status');
    assert.equal(status.body.session, null);
  } finally {
    await ctx.close();
  }
});

test('AI 不通时简报与复盘降级为本地规则，不报错', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/state', STATE);
    await ctx.call('POST', '/plan/generate', {});
    // 指向一个必定拒绝连接的端口：不依赖本机是否恰好跑着 Ollama，也不访问外网
    await ctx.call('POST', '/ai/config', { baseUrl: 'http://127.0.0.1:1/v1', model: 'none' });

    const briefing = await ctx.call('POST', '/ai/briefing', {});
    assert.equal(briefing.status, 200);
    assert.equal(briefing.body.ok, true);
    assert.equal(briefing.body.source, 'local');
    assert.ok(briefing.body.text.length > 10);

    const review = await ctx.call('POST', '/ai/review', {});
    assert.equal(review.status, 200);
    assert.equal(review.body.source, 'local');
  } finally {
    await ctx.close();
  }
});

test('趋势接口：没数据的日期给 null 而不是 0', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/state', STATE);
    const trend = await ctx.call('GET', '/journal/trend?days=7');
    assert.equal(trend.status, 200);
    assert.equal(trend.body.points.length, 7);
    const today = trend.body.points.at(-1);
    assert.equal(today.date, '2026-10-26');
    assert.ok(today.hasState);
    const empty = trend.body.points.filter((point) => !point.hasState);
    assert.ok(empty.length >= 1);
    assert.ok(empty.every((point) => point.score === null));
  } finally {
    await ctx.close();
  }
});

test('逾期扫描会产出提醒事件', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/tasks', { title: '昨天的报告', date: '2026-10-24', estimateMin: 30 });
    const scan = await ctx.call('POST', '/reminders/scan', {});
    assert.equal(scan.status, 200);
    assert.ok(scan.body.result.overdue >= 1);
    const reminders = await ctx.call('GET', '/reminders');
    assert.equal(reminders.body.overdue.length, 1);
  } finally {
    await ctx.close();
  }
});
