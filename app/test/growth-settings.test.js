/**
 * 成长模块 · 设置、提醒、数据自检（搬自 Brain Online test/settings.test.js）。
 *
 * 设置的价值在于“把写死的策略变成可配置项”，而提醒/顺延/自检都依赖它。
 * 这里既测纯函数校验，也测提醒引擎在假时钟下的行为（不 sleep、不靠真实时间）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { JsonStore } from '../src/core/store/json-store.js';
import { GROWTH_COLLECTIONS } from '../src/modules/growth/module.js';
import { normalizeSettings, DEFAULTS, createSettingsService } from '../src/modules/growth/settings.js';
import { createReminderEngine } from '../src/modules/growth/reminders.js';
import { fixedClock, dateKey } from '../src/modules/growth/time.js';
import { doc } from '../src/modules/growth/store-utils.js';

const STATE = { sleepHours: 7, sleepQuality: 4, energy: 4, mood: 4, stress: 2, focus: 4, body: 4 };

async function startApp() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-growth-settings-'));
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
    return { status: response.status, body: await response.json() };
  };
  const close = async () => {
    await call('POST', '/system/shutdown', { reason: 'test-cleanup' }).catch(() => {});
    await app.close();
    await app.services.growth?.closing?.catch?.(() => {});
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  };
  return { app, call, close, dataDir };
}

/* ---------------- 设置 ---------------- */

test('设置默认值：10 点提醒状态、21 点收尾、3 天升级、不顺延', () => {
  const settings = normalizeSettings({});
  assert.deepEqual(settings, DEFAULTS);
  assert.equal(settings.reminders.enabled, true);
  assert.equal(settings.tasks.carryOver, 'off');
  assert.equal(settings.data.selfCheck, true);
});

test('设置校验：时间越界、收尾早于状态、未知跨天策略都要拒绝', () => {
  assert.throws(() => normalizeSettings({ reminders: { stateHour: 24 } }), /0–23/);
  assert.throws(() => normalizeSettings({ reminders: { closeHour: 9, stateHour: 10 } }), /晚于/);
  assert.throws(() => normalizeSettings({ tasks: { carryOver: 'tomorrow' } }), /跨天策略/);
  assert.throws(() => normalizeSettings({ reminders: { deepDays: 0 } }), /1–30/);
});

test('设置能落盘、能读回，缺字段自动补默认值', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-growth-settings-store-'));
  try {
    const store = await new JsonStore({ dataDir, collections: GROWTH_COLLECTIONS }).init();
    const settings = createSettingsService({ store, clock: fixedClock('2026-10-26T09:00:00') });

    const updated = await settings.update({ reminders: { stateHour: 8, closeHour: 22 } });
    assert.equal(updated.reminders.stateHour, 8);
    assert.equal(updated.reminders.closeHour, 22);
    assert.equal(updated.reminders.deepDays, 3, '没给的字段沿用默认');

    const reopened = createSettingsService({
      store: await new JsonStore({ dataDir, collections: GROWTH_COLLECTIONS }).init(),
      clock: fixedClock('2026-10-26T09:00:00'),
    });
    const read = await reopened.read();
    assert.equal(read.reminders.stateHour, 8);
    assert.equal(read.tasks.carryOver, 'off');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('接口：读写设置，非法值返回 400', async () => {
  const ctx = await startApp();
  try {
    const initial = await ctx.call('GET', '/settings');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.settings.reminders.stateHour, 10);
    assert.ok(initial.body.carryOverModes.off);

    const patched = await ctx.call('PATCH', '/settings', { reminders: { stateHour: 7 } });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.settings.reminders.stateHour, 7);

    const bad = await ctx.call('PATCH', '/settings', { reminders: { closeHour: 3 } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'INVALID_FIELD');
  } finally {
    await ctx.close();
  }
});

/* ---------------- 提醒读设置 ---------------- */

function reminderHarness({ now, settings, tasks = [] }) {
  const events = [];
  const clock = { now: () => new Date(now) };
  const reminders = createReminderEngine({
    clock,
    bus: { emit: (type, payload) => events.push({ type, payload }) },
    services: {
      settings: { read: async () => normalizeSettings(settings) },
      tasks: {
        overdue: async () => tasks.filter((task) => task.status === 'todo' && task.date < dateKey(new Date(now))),
        list: async () => tasks,
        postpone: async (id, { to }) => {
          const task = tasks.find((item) => item.id === id);
          task.date = to;
          return task;
        },
      },
      state: { get: async () => null },
      session: { log: async () => {} },
    },
  });
  return { reminders, events, tasks };
}

test('提醒时间可配：09:00 不提醒，11:00 才提醒状态', async () => {
  const at9 = reminderHarness({ now: '2026-10-26T09:00:00', settings: { reminders: { stateHour: 10 } } });
  await at9.reminders.tick();
  assert.equal(at9.events.filter((event) => event.payload.kind === 'state').length, 0);

  const at11 = reminderHarness({ now: '2026-10-26T11:00:00', settings: { reminders: { stateHour: 10 } } });
  await at11.reminders.tick();
  assert.equal(at11.events.filter((event) => event.payload.kind === 'state').length, 1);

  const late = reminderHarness({ now: '2026-10-26T11:00:00', settings: { reminders: { stateHour: 20 } } });
  await late.reminders.tick();
  assert.equal(late.events.filter((event) => event.payload.kind === 'state').length, 0, '改成 20 点后 11 点不该提醒');
});

test('收尾提醒时间可配', async () => {
  const tasks = [{ id: 't1', title: '没做完的', date: '2026-10-26', status: 'todo' }];
  const at19 = reminderHarness({ now: '2026-10-26T19:00:00', settings: { reminders: { closeHour: 21 } }, tasks });
  await at19.reminders.tick();
  assert.equal(at19.events.filter((event) => event.payload.kind === 'close').length, 0);

  const at22 = reminderHarness({
    now: '2026-10-26T22:00:00',
    settings: { reminders: { closeHour: 21 } },
    tasks: [{ ...tasks[0] }],
  });
  await at22.reminders.tick();
  assert.equal(at22.events.filter((event) => event.payload.kind === 'close').length, 1);

  const custom = reminderHarness({
    now: '2026-10-26T19:00:00',
    settings: { reminders: { closeHour: 19 } },
    tasks: [{ ...tasks[0] }],
  });
  await custom.reminders.tick();
  assert.equal(custom.events.filter((event) => event.payload.kind === 'close').length, 1, '改成 19 点后 19 点就该提醒');
});

test('总开关关掉后不再推送任何提示', async () => {
  const tasks = [{ id: 't1', title: '拖着的', date: '2026-10-20', status: 'todo' }];
  const harness = reminderHarness({ now: '2026-10-26T22:00:00', settings: { reminders: { enabled: false } }, tasks });
  const result = await harness.reminders.tick();
  assert.equal(harness.events.length, 0);
  assert.equal(result.muted, true);
});

test('跨天顺延：auto 会把未完成任务挪到今天，off 保持不动', async () => {
  const build = ({ carryOver, tasks, start }) => {
    const mutable = { current: new Date(start) };
    const events = [];
    const reminders = createReminderEngine({
      clock: { now: () => new Date(mutable.current) },
      bus: { emit: (type, payload) => events.push({ type, payload }) },
      services: {
        settings: { read: async () => normalizeSettings({ tasks: { carryOver } }) },
        tasks: {
          overdue: async () => [],
          list: async () => tasks,
          postpone: async (id, { to }) => {
            const task = tasks.find((item) => item.id === id);
            if (!task) throw new Error(`不该顺延 ${id}`);
            task.date = to;
            return task;
          },
        },
        state: { get: async () => ({}) },
        session: { log: async () => {} },
      },
    });
    return { reminders, events, mutable };
  };

  const tasks = [
    { id: 'a', title: '昨天没做完', date: '2026-10-24', status: 'todo' },
    { id: 'b', title: '今天做了一半', date: '2026-10-25', status: 'todo' },
    { id: 'c', title: '已完成的', date: '2026-10-24', status: 'done' },
  ];
  const { reminders, events, mutable } = build({ carryOver: 'auto', tasks, start: '2026-10-25T23:00:00' });
  await reminders.tick();
  mutable.current = new Date('2026-10-26T00:10:00');
  await reminders.tick();

  const dayEvent = events.find((event) => event.type === 'day');
  assert.equal(dayEvent.payload.carried, 2, '两条未完成的任务被顺延');
  assert.equal(tasks.find((task) => task.id === 'a').date, '2026-10-26');
  assert.equal(tasks.find((task) => task.id === 'b').date, '2026-10-26');
  assert.equal(tasks.find((task) => task.id === 'c').date, '2026-10-24', '已完成的不动');

  // off：一条都不挪，而且不该调用 postpone
  const offTasks = [{ id: 'x', title: '旧的', date: '2026-10-24', status: 'todo' }];
  const off = build({ carryOver: 'off', tasks: offTasks, start: '2026-10-25T23:00:00' });
  await off.reminders.tick();
  off.mutable.current = new Date('2026-10-26T00:10:00');
  await off.reminders.tick();
  assert.equal(offTasks[0].date, '2026-10-24', 'off 模式下任务保持原日期');
  assert.equal(off.events.find((event) => event.type === 'day').payload.carried, 0);
});

test('逾期升级天数可配', async () => {
  const tasks = [{ id: 't1', title: '挂了两天', date: '2026-10-24', status: 'todo' }];
  const early = reminderHarness({
    now: '2026-10-26T10:00:00',
    settings: { reminders: { deepDays: 2 } },
    tasks: [{ ...tasks[0] }],
  });
  await early.reminders.tick();
  assert.equal(early.events.filter((event) => event.payload.kind === 'overdue-deep').length, 1);

  const late = reminderHarness({
    now: '2026-10-26T10:00:00',
    settings: { reminders: { deepDays: 5 } },
    tasks: [{ ...tasks[0] }],
  });
  await late.reminders.tick();
  assert.equal(late.events.filter((event) => event.payload.kind === 'overdue-deep').length, 0);
});

/* ---------------- 数据自检 ---------------- */

test('自检：解绑悬空 planId、重算计划 taskIds 与角色计数，且幂等', async () => {
  const ctx = await startApp();
  try {
    const plan = await ctx.app.store.growthPlans.insert({ date: '2026-10-26', taskIds: [] });
    const okTask = await ctx.app.store.growthTasks.insert({
      date: '2026-10-26',
      planId: plan.id,
      title: '正常任务',
      status: 'done',
      xp: 10,
    });
    await ctx.app.store.growthTasks.insert({
      date: '2026-10-26',
      planId: 'gone-plan',
      title: '悬空任务',
      status: 'todo',
    });
    await doc(ctx.app.store, 'growthRpg', {}).set({ name: 'Operator', totalXp: 10, counters: { tasksDone: 7 } });

    const first = await ctx.call('POST', '/maintenance/check', { repair: true });
    assert.equal(first.body.report.fixed.detachedTasks, 1);
    assert.equal(first.body.report.fixed.planTaskIds, 1);
    assert.deepEqual(first.body.report.fixed.characterCounters, { before: 7, after: 1 });

    const repairedPlan = await ctx.app.store.growthPlans.get(plan.id);
    assert.equal(repairedPlan.taskIds.length, 2, '按日期重算，包含全部当天任务');
    const dangling = await ctx.app.store.growthTasks.find((task) => task.title === '悬空任务');
    assert.equal(dangling[0].planId, null);
    const character = await doc(ctx.app.store, 'growthRpg', {}).read();
    assert.equal(character.counters.tasksDone, 1);

    const second = await ctx.call('POST', '/maintenance/check', { repair: true });
    assert.equal(second.body.report.totalFixed, 0, '第二次跑不该再有修复');
    assert.equal((await ctx.app.store.growthTasks.get(okTask.id)).status, 'done', '自检不动任务状态');
  } finally {
    await ctx.close();
  }
});

test('自检：修复旧公式算歪的状态派生字段', async () => {
  const ctx = await startApp();
  try {
    await ctx.app.store.growthStates.insert({
      date: '2026-10-20',
      sleepHours: 7,
      sleepQuality: 4,
      energy: 4,
      mood: 4,
      stress: 2,
      focus: 4,
      body: 4,
      score: 3,
      capacity: 1,
      mode: 'nope',
    });

    const report = await ctx.call('POST', '/maintenance/check', { repair: true });
    assert.equal(report.body.report.fixed.statesRecomputed, 1);

    const entry = (await ctx.call('GET', '/state?date=2026-10-20')).body.entry;
    assert.ok(entry.score > 70);
    assert.ok(['push', 'steady', 'recover'].includes(entry.mode));
    assert.equal(entry.capacity, Math.round(60 + 2.4 * entry.score));
  } finally {
    await ctx.close();
  }
});

test('接口：自检可手动触发并返回报告（启动时也跑过一次）', async () => {
  const ctx = await startApp();
  try {
    const initial = await ctx.call('GET', '/maintenance');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.report.ok, true);
    assert.ok(initial.body.report.checked, '启动自检的报告已在内存里');

    const run = await ctx.call('POST', '/maintenance/check', {});
    assert.equal(run.status, 200);
    assert.equal(run.body.report.totalFixed, 0, '干净数据不该有修复项');
  } finally {
    await ctx.close();
  }
});
