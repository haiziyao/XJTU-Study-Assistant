/**
 * 成长模块 · 端到端功能（搬自 Brain Online test/features.test.js，25 个用例）。
 *
 * 覆盖：压力方向解读、手动任务进入“今日”、周报/周洞察/Markdown 导出、跨天事件、
 * 改期、逾期升级提醒、自定义模板、备份/恢复、日期校验、本地简报与错误码。
 * 纯规则部分直接测纯函数；带状态的部分全部走真实 HTTP。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { weekVerdict, weekInsights, dayToMarkdown } from '../src/modules/growth/journal.js';
import { createReminderEngine } from '../src/modules/growth/reminders.js';
import { normalizeSettings } from '../src/modules/growth/settings.js';
import { interpret, normalizeEntry } from '../src/modules/growth/state.js';

const STATE = { sleepHours: 7, sleepQuality: 4, energy: 4, mood: 4, stress: 2, focus: 4, body: 4 };

async function startApp() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-growth-feat-'));
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
  const callRaw = async (method, route) => {
    const response = await fetch(`${info.baseUrl}/growth${route}`, { method });
    return { status: response.status, text: await response.text(), headers: response.headers };
  };
  const close = async () => {
    await call('POST', '/system/shutdown', { reason: 'test-cleanup' }).catch(() => {});
    await app.close();
    await app.services.growth?.closing?.catch?.(() => {});
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  };
  return { app, info, call, callRaw, close, dataDir };
}

/* ---------------- 状态解读：压力方向 ---------------- */

test('解读不把"压力低"当成最短板', () => {
  const entry = normalizeEntry(
    { ...STATE, energy: 4, mood: 4, focus: 4, body: 4, stress: 1 },
    { now: new Date(2026, 9, 26) },
  );
  const lines = interpret(entry, entry.score).join('');
  assert.ok(!/最短板是压力/.test(lines), lines);
  assert.ok(!/最短板是压力（1\/5）/.test(lines), lines);
});

test('压力爆表时会被点成短板，并给"排松一点"的建议', () => {
  const entry = normalizeEntry(
    { ...STATE, stress: 5, energy: 5, mood: 5, focus: 5, body: 5 },
    { now: new Date(2026, 9, 26) },
  );
  const lines = interpret(entry, entry.score).join(' ');
  assert.match(lines, /压力/);
  assert.match(lines, /短板|排松/);
});

/* ---------------- 手动任务要进"今日" ---------------- */

test('手动加的任务会挂到当天计划，出现在今日现场里', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/state', STATE);
    await ctx.call('POST', '/plan/generate', {});

    const added = await ctx.call('POST', '/tasks', { title: '临时加的会', estimateMin: 15, kind: 'life' });
    assert.equal(added.status, 200);
    assert.ok(added.body.task.planId, '应该已经挂到当天计划上');

    const today = await ctx.call('GET', '/today');
    assert.ok(today.body.tasks.some((task) => task.id === added.body.task.id), '今日列表里必须能看到它');
    assert.equal(today.body.stats.total, today.body.tasks.length);
  } finally {
    await ctx.close();
  }
});

test('没有计划时手动加任务也不报错，只是不挂计划', async () => {
  const ctx = await startApp();
  try {
    const added = await ctx.call('POST', '/tasks', { title: '先记一笔' });
    assert.equal(added.status, 200);
    assert.equal(added.body.task.planId, null);
    const today = await ctx.call('GET', '/today');
    assert.equal(today.body.tasks.length, 1);
  } finally {
    await ctx.close();
  }
});

/* ---------------- 周报 ---------------- */

test('周报：汇总七天的完成率、投入、模式分布与配比', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/state', STATE);
    const plan = await ctx.call('POST', '/plan/generate', {});
    const [first, second] = plan.body.tasks;
    await ctx.call('PATCH', `/tasks/${first.id}`, { status: 'done' });
    await ctx.call('PATCH', `/tasks/${second.id}`, { status: 'skipped' });

    const week = await ctx.call('GET', '/journal/weekly');
    assert.equal(week.status, 200);
    assert.equal(week.body.days, 7);
    assert.equal(week.body.to, '2026-10-26');
    assert.equal(week.body.from, '2026-10-20');
    assert.equal(week.body.points.length, 7);
    assert.equal(week.body.totals.done, 1);
    assert.equal(week.body.totals.skipped, 1);
    assert.equal(week.body.totals.activeDays, 1);
    assert.equal(week.body.totals.stateDays, 1);
    assert.ok(week.body.totals.minutes > 0);
    assert.ok(week.body.totals.xp > 0);
    assert.ok(week.body.modeMix.push >= 1);
    assert.ok(week.body.verdict.length > 5);
    assert.ok(week.body.streak >= 1);
    const focus = week.body.byKind.focus;
    assert.ok(focus && focus.planned >= 2);
  } finally {
    await ctx.close();
  }
});

test('周报结论：空数据、低完成率、修复日过多各有不同说法', () => {
  assert.match(weekVerdict({ totals: { planned: 0, activeDays: 0 }, modeMix: {} }), /还没有任何记录/);

  const lowRate = weekVerdict({
    totals: { planned: 10, done: 2, activeDays: 5, avgScore: 60 },
    modeMix: { push: 1, steady: 4, recover: 0 },
  });
  assert.match(lowRate, /完成率偏低|砍三分之一/);

  const lazyWeek = weekVerdict({ totals: { planned: 9, done: 3, activeDays: 2, avgScore: 55 }, modeMix: {} });
  assert.match(lazyWeek, /只动了 2 天/);

  const recoverHeavy = weekVerdict({
    totals: { planned: 20, done: 14, activeDays: 6, avgScore: 40 },
    modeMix: { push: 0, steady: 3, recover: 4 },
  });
  assert.match(recoverHeavy, /修复模式|漏电/);
});

/* ---------------- Markdown 导出 ---------------- */

test('一天的 Markdown 有状态、任务清单与角色信息', () => {
  const markdown = dayToMarkdown({
    date: '2026-10-26',
    state: {
      score: 82,
      mode: 'push',
      capacity: 257,
      sleepHours: 7,
      sleepQuality: 4,
      energy: 4,
      mood: 4,
      stress: 2,
      focus: 4,
      body: 4,
      note: '开会',
    },
    plan: { rationale: ['就绪度 82 分 → push 模式'] },
    tasks: [
      { title: '深度工作块', detail: '关掉通知', kind: 'focus', estimateMin: 90, difficulty: 4, status: 'done', xp: 55 },
      { title: '拉伸 10 分钟', detail: '', kind: 'body', estimateMin: 10, difficulty: 1, status: 'todo', xp: 11 },
    ],
    stats: { minutesDone: 90, xpDone: 55 },
    character: {
      level: 2,
      totalXp: 260,
      streak: 3,
      bestStreak: 5,
      attrs: { focus: 4, wisdom: 2, vitality: 1, discipline: 1, resilience: 0 },
      achievements: [{ name: '首次落笔' }],
    },
    logs: [{ at: '2026-10-26T09:12:00+08:00', type: 'task', message: '任务「深度工作块」→ done' }],
  });
  assert.match(markdown, /^# Brain Online · 2026-10-26/);
  assert.match(markdown, /就绪度：\*\*82\/100\*\*/);
  assert.match(markdown, /- \[x\] 深度工作块/);
  assert.match(markdown, /- \[ \] 拉伸 10 分钟/);
  assert.match(markdown, /为什么这么排/);
  assert.match(markdown, /Lv\.2 · 累计 260 XP/);
  assert.match(markdown, /首次落笔/);
});

test('导出接口直接返回 Markdown 文件（不是 JSON 包装）', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/state', STATE);
    const plan = await ctx.call('POST', '/plan/generate', {});
    await ctx.call('PATCH', `/tasks/${plan.body.tasks[0].id}`, { status: 'done' });

    const res = await ctx.callRaw('GET', '/journal/export');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/markdown/);
    const disposition = res.headers.get('content-disposition');
    assert.match(disposition, /attachment; filename="brain-online-2026-10-26\.md"/);
    assert.match(res.text, /# Brain Online · 2026-10-26/);
    assert.match(res.text, /## 任务（完成 1\//);
  } finally {
    await ctx.close();
  }
});

test('导出区间最多 31 天，文件名带两端日期', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/state', STATE);
    const res = await ctx.callRaw('GET', '/journal/export?from=2026-10-20&to=2026-10-26');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /brain-online-2026-10-20_2026-10-26\.md/);
    assert.equal(res.headers.get('x-export-days'), '7');
    assert.equal(res.text.match(/# Brain Online/g).length, 7);

    const big = await ctx.callRaw('GET', '/journal/export?from=2026-01-01&to=2026-12-31');
    assert.equal(big.headers.get('x-export-days'), '31');
  } finally {
    await ctx.close();
  }
});

/* ---------------- 跨天 ---------------- */

test('跨天：常驻进程会发出 day 事件并记一条日志', async () => {
  const events = [];
  const logs = [];
  let current = new Date('2026-10-26T23:50:00');
  const clock = { now: () => new Date(current) };
  const reminders = createReminderEngine({
    clock,
    bus: { emit: (type, payload) => events.push({ type, payload }) },
    services: {
      settings: { read: async () => normalizeSettings({}) },
      tasks: { overdue: async () => [], list: async () => [] },
      state: { get: async () => ({ date: '2026-10-26' }) },
      session: { log: async (type, message) => logs.push({ type, message }) },
    },
  });

  await reminders.tick();
  assert.equal(events.filter((event) => event.type === 'day').length, 0);

  current = new Date('2026-10-27T00:05:00');
  const result = await reminders.tick();
  const dayEvents = events.filter((event) => event.type === 'day');
  assert.equal(dayEvents.length, 1);
  assert.equal(dayEvents[0].payload.date, '2026-10-27');
  assert.equal(dayEvents[0].payload.previous, '2026-10-26');
  assert.ok(result.events.includes('day'));
  assert.ok(logs.some((entry) => entry.message.includes('跨天')));
});

/* ---------------- 改期 ---------------- */

test('逾期任务可以改期到明天，并记住原日期与改期次数', async () => {
  const ctx = await startApp();
  try {
    const added = await ctx.call('POST', '/tasks', { title: '昨天的事', date: '2026-10-24' });
    const res = await ctx.call('POST', `/tasks/${added.body.task.id}/postpone`, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.task.date, '2026-10-27', '默认改到明天（今天是 10-26）');
    assert.equal(res.body.task.postponedFrom, '2026-10-24');
    assert.equal(res.body.task.postponedCount, 1);
    assert.match(res.body.task.dueAt, /2026-10-27.*23:59:59/);

    const overdue = await ctx.call('GET', '/tasks/overdue');
    assert.equal(overdue.body.tasks.length, 0, '改期后不该再算逾期');
  } finally {
    await ctx.close();
  }
});

test('改期校验：不能改到过去，已完成的任务不能改期', async () => {
  const ctx = await startApp();
  try {
    const added = await ctx.call('POST', '/tasks', { title: '拖着的', date: '2026-10-24' });
    const id = added.body.task.id;

    const past = await ctx.call('POST', `/tasks/${id}/postpone`, { to: '2026-10-01' });
    assert.equal(past.status, 400);
    assert.match(past.body.error.message, /过去/);

    const bad = await ctx.call('POST', `/tasks/${id}/postpone`, { to: '2026/10/27' });
    assert.equal(bad.status, 400);

    await ctx.call('PATCH', `/tasks/${id}`, { status: 'done' });
    const done = await ctx.call('POST', `/tasks/${id}/postpone`, {});
    assert.equal(done.status, 400);
    assert.equal(done.body.error.code, 'INVALID_STATUS');
  } finally {
    await ctx.close();
  }
});

/* ---------------- 周洞察 ---------------- */

test('周洞察：低状态日与短睡眠日完成率明显更低时给结论', () => {
  const points = [
    { date: '2026-10-20', hasState: true, score: 30, sleepHours: 5, total: 6, done: 2 },
    { date: '2026-10-21', hasState: true, score: 35, sleepHours: 5.5, total: 6, done: 1 },
    { date: '2026-10-22', hasState: true, score: 80, sleepHours: 7.5, total: 6, done: 6 },
    { date: '2026-10-23', hasState: true, score: 85, sleepHours: 8, total: 6, done: 5 },
  ];
  const insights = weekInsights(points, {
    focus: { planned: 6, done: 6 },
    recover: { planned: 6, done: 1 },
  });
  assert.ok(insights.some((line) => /低状态日完成率/.test(line)), insights.join(' | '));
  assert.ok(insights.some((line) => /睡不足/.test(line)), insights.join(' | '));
  assert.ok(insights.some((line) => /完成率/.test(line) && /下周把时间往前者挪/.test(line)), insights.join(' | '));
  assert.ok(insights.length <= 3, '最多三条，宁缺毋滥');
});

test('周洞察：数据不足时一条都不给', () => {
  assert.deepEqual(weekInsights([], {}), []);
  assert.deepEqual(weekInsights([{ date: '2026-10-26', hasState: true, score: 90, total: 3, done: 3, sleepHours: 8 }], {}), []);
});

test('周报里带上洞察字段（没有洞察时是空数组）', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/state', STATE);
    await ctx.call('POST', '/plan/generate', {});
    const week = await ctx.call('GET', '/journal/weekly');
    assert.ok(Array.isArray(week.body.insights));
  } finally {
    await ctx.close();
  }
});

/* ---------------- 逾期升级 ---------------- */

test('逾期三天以上只推一次"该做决定了"', async () => {
  const events = [];
  const overdueTask = {
    id: 't-old',
    title: '一直拖着的报告',
    date: '2026-10-20',
    dueAt: '2026-10-20T23:59:59.999+08:00',
    status: 'todo',
  };
  const reminders = createReminderEngine({
    clock: { now: () => new Date('2026-10-26T10:00:00') },
    bus: { emit: (type, payload) => events.push({ type, payload }) },
    services: {
      settings: { read: async () => normalizeSettings({}) },
      tasks: { overdue: async () => [overdueTask], list: async () => [] },
      state: { get: async () => ({ date: '2026-10-26' }) },
      session: { log: async () => {} },
    },
  });

  await reminders.tick();
  await reminders.tick();
  const deep = events.filter((event) => event.type === 'nudge' && event.payload.kind === 'overdue-deep');
  assert.equal(deep.length, 1, '同一件事只提醒一次');
  assert.match(deep[0].payload.message, /逾期 6 天/);
  assert.equal(deep[0].payload.taskId, 't-old');
});

/* ---------------- 自定义任务模板 ---------------- */

test('自定义模板：能加、能停用、能删', async () => {
  const ctx = await startApp();
  try {
    const created = await ctx.call('POST', '/templates', {
      title: '给花浇水',
      kind: 'life',
      estimateMin: 10,
      difficulty: 1,
    });
    assert.equal(created.status, 200);
    assert.match(created.body.template.id, /^custom:/);

    const list = await ctx.call('GET', '/templates');
    assert.equal(list.body.customCount, 1);
    assert.equal(list.body.custom[0].title, '给花浇水');
    assert.equal(list.body.custom[0].enabled, true);
    assert.ok(list.body.builtinCount >= 30);

    const off = await ctx.call('PATCH', `/templates/${encodeURIComponent(created.body.template.id)}`, {
      enabled: false,
    });
    assert.equal(off.status, 200);
    assert.equal(off.body.enabled, false);

    const listAgain = await ctx.call('GET', '/templates');
    assert.equal(listAgain.body.custom[0].enabled, false);

    const removed = await ctx.call('DELETE', `/templates/${encodeURIComponent(created.body.template.id)}`);
    assert.equal(removed.status, 200);
    assert.equal((await ctx.call('GET', '/templates')).body.customCount, 0);
  } finally {
    await ctx.close();
  }
});

test('只留一条自定义模板时，生成的任务表单就只有这一条', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/templates', { title: '给花浇水', kind: 'life', estimateMin: 10, difficulty: 1 });

    const list = await ctx.call('GET', '/templates');
    for (const item of list.body.builtin) {
      await ctx.call('PATCH', `/templates/${item.id}`, { enabled: false });
    }
    const after = await ctx.call('GET', '/templates');
    assert.equal(after.body.activeCount, 1);

    await ctx.call('POST', '/state', STATE);
    const plan = await ctx.call('POST', '/plan/generate', {});
    assert.equal(plan.body.tasks.length, 1);
    assert.equal(plan.body.tasks[0].title, '给花浇水');
    assert.equal(plan.body.tasks[0].kind, 'life');

    await ctx.call('POST', '/templates/enable-all', {});
    assert.ok((await ctx.call('GET', '/templates')).body.activeCount >= 30);
  } finally {
    await ctx.close();
  }
});

test('模板校验：重名、类型非法、标题过长、时长越界都要拒绝；内置模板不能删', async () => {
  const ctx = await startApp();
  try {
    const first = await ctx.call('POST', '/templates', {
      title: '泡一杯茶',
      kind: 'life',
      estimateMin: 10,
      difficulty: 1,
    });
    assert.equal(first.status, 200);

    const dup = await ctx.call('POST', '/templates', { title: '泡一杯茶', kind: 'life' });
    assert.equal(dup.status, 400);
    assert.equal(dup.body.error.code, 'DUPLICATE_TITLE');

    const builtinDup = await ctx.call('POST', '/templates', { title: '读 20 页书' });
    assert.equal(builtinDup.status, 400);

    const badKind = await ctx.call('POST', '/templates', { title: '飞', kind: 'magic' });
    assert.equal(badKind.status, 400);

    const longTitle = await ctx.call('POST', '/templates', { title: 'x'.repeat(41) });
    assert.equal(longTitle.status, 400);

    const badMinutes = await ctx.call('POST', '/templates', { title: '太长', estimateMin: 999 });
    assert.equal(badMinutes.status, 400);

    const delBuiltin = await ctx.call('DELETE', '/templates/focus-deep-90');
    assert.equal(delBuiltin.status, 404);
  } finally {
    await ctx.close();
  }
});

/* ---------------- 备份 / 恢复 ---------------- */

test('备份：导出整库 JSON，默认不含 AI Key', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/state', STATE);
    await ctx.call('POST', '/plan/generate', {});

    const res = await ctx.callRaw('GET', '/backup');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /brain-online-backup-2026-10-26\.json/);
    const bundle = JSON.parse(res.text);
    assert.equal(bundle.app, 'brain-online');
    assert.equal(bundle.format, 1);
    assert.ok(bundle.counts.states >= 1);
    assert.ok(bundle.counts.tasks >= 3);
    assert.ok(bundle.docs.character);
    assert.equal(bundle.docs['ai-config'].apiKey, '');

    const withSecrets = await ctx.callRaw('GET', '/backup?secrets=1');
    assert.equal(withSecrets.status, 200);
  } finally {
    await ctx.close();
  }
});

test('恢复：整库回滚，且恢复前自动留档', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/state', STATE);
    await ctx.call('POST', '/plan/generate', {});
    const before = JSON.parse((await ctx.callRaw('GET', '/backup')).text);
    const taskCount = before.counts.tasks;

    // 把一个"空任务"的备份推回去
    const emptied = { ...before, collections: { ...before.collections, tasks: [], plans: [] } };
    const restored = await ctx.call('POST', '/restore', emptied);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.counts.tasks, 0);
    assert.match(restored.body.snapshotFile, /^pre-restore-\d+\.json$/);

    const today = await ctx.call('GET', '/today');
    assert.equal(today.body.tasks.length, 0);

    // 再用原始备份恢复回来
    const back = await ctx.call('POST', '/restore', before);
    assert.equal(back.status, 200);
    assert.equal(back.body.counts.tasks, taskCount);
    const today2 = await ctx.call('GET', '/today');
    assert.equal(today2.body.tasks.length, taskCount);

    // 留档文件真的落在 archive/ 里
    const archives = await readdir(path.join(ctx.dataDir, 'archive'));
    assert.ok(archives.some((name) => name.startsWith('pre-restore-')));
  } finally {
    await ctx.close();
  }
});

test('恢复：不认识的格式被拒绝，不会动到现有数据', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/state', STATE);

    const bogus = await ctx.call('POST', '/restore', { hello: 'world' });
    assert.equal(bogus.status, 400);
    assert.equal(bogus.body.error.code, 'INVALID_BACKUP');

    const notArray = await ctx.call('POST', '/restore', {
      app: 'brain-online',
      format: 1,
      collections: { states: 'nope' },
    });
    assert.equal(notArray.status, 400);

    const tooNew = await ctx.call('POST', '/restore', {
      app: 'brain-online',
      format: 99,
      collections: {},
    });
    assert.equal(tooNew.status, 400);
    assert.equal(tooNew.body.error.code, 'BACKUP_TOO_NEW');

    const today = await ctx.call('GET', '/today');
    assert.ok(today.body.state, '失败的重试不能破坏已有数据');
  } finally {
    await ctx.close();
  }
});

test('日期参数非法时返回 400', async () => {
  const ctx = await startApp();
  try {
    const weekly = await ctx.call('GET', '/journal/weekly?end=2026-13-99');
    assert.equal(weekly.status, 400);
    assert.equal(weekly.body.error.code, 'INVALID_DATE');

    const reversed = await ctx.callRaw('GET', '/journal/export?from=2026-10-26&to=2026-10-20');
    assert.equal(reversed.status, 400);

    const onlyFrom = await ctx.callRaw('GET', '/journal/export?from=2026-10-20');
    assert.equal(onlyFrom.status, 400);

    const badDate = await ctx.callRaw('GET', '/journal/export?date=10/26/2026');
    assert.equal(badDate.status, 400);
  } finally {
    await ctx.close();
  }
});

test('本地简报会提到逾期与本周洞察', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/state', STATE);
    await ctx.call('POST', '/ai/config', { baseUrl: 'http://127.0.0.1:1/v1', model: 'none' });
    await ctx.call('POST', '/tasks', { title: '拖了三天的报告', date: '2026-10-21' });

    const briefing = await ctx.call('POST', '/ai/briefing', {});
    assert.equal(briefing.status, 200);
    assert.equal(briefing.body.source, 'local');
    assert.match(briefing.body.text, /逾期/);
    assert.match(briefing.body.text, /报告/);
  } finally {
    await ctx.close();
  }
});

/* ---------------- 错误码 ---------------- */

test('参数错误返回 400 而不是 500', async () => {
  const ctx = await startApp();
  try {
    const badName = await ctx.call('PATCH', '/character', { name: '   ' });
    assert.equal(badName.status, 400);
    assert.equal(badName.body.error.code, 'INVALID_FIELD');

    const badUrl = await ctx.call('POST', '/ai/config', { baseUrl: 'ftp://x' });
    assert.equal(badUrl.status, 400);
    assert.equal(badUrl.body.error.code, 'INVALID_FIELD');
  } finally {
    await ctx.close();
  }
});
