/**
 * 日历与待办模块的行为测试。
 *
 * 覆盖四件事（都是「对话/AI 能不能真的加待办」这条链路上的坑）：
 *   1. 「待办」类措辞必须落在 schedules 集合 —— 待办视图只读 /schedules，
 *      判成 events 会让用户说了「加待办」却在待办列表里看不到；
 *   2. 单日无时刻 = 待办，跨天区间 = 日历事件；
 *   3. 「完成」只对待办有意义（时段日程与日历事件都没有完成态），且待办列表只含 allDay 条目；
 *   4. 日历模块要声明 aiTools，且接口文档与工具清单保持一致 ——
 *      AI 是照着文档调接口的，文档漂了它就会写错集合。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { CommandParser } from '../src/modules/calendar/parser.js';

/** 固定为 2025-10-15（周三）10:00，避免测试依赖真实日期。 */
const FIXED = new Date(2025, 9, 15, 10, 0, 0);
const parser = new CommandParser({ now: () => FIXED });

/** 服务端用的是服务器本地日期，测试里同样算本地日期。 */
function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

async function startApp() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-calendar-todo-'));
  const app = await createServer({ dataDir, version: '0.1.0-test' });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json();
    return { status: response.status, body: payload };
  };
  return { app, call };
}

// ---------------------------------------------------------------- 解析层

test('「待办」类措辞解析为全天日程，而不是日历事件', () => {
  for (const text of ['添加待办 明天 交实验报告', '明天 交作业', '任务 明天 提交报名材料']) {
    const draft = parser.parse(text);
    assert.equal(draft.target, 'schedule', `「${text}」应判到日程`);
    assert.equal(draft.fields.allDay, true, `「${text}」没有时刻应按全天`);
    assert.equal(draft.fields.status, 'pending');
    assert.equal(draft.fields.date, '2025-10-16');
  }
});

test('「完成」是待办的动作：只定位待办，不碰时段日程', () => {
  const draft = parser.parse('完成今天的英语听力');
  assert.equal(draft.action, 'complete');
  assert.equal(draft.target, 'schedule');
  assert.equal(draft.filters.from, '2025-10-15');
  assert.equal(draft.filters.keyword, '英语听力');
  // 待办 = allDay，条件里必须带上，否则同一天的「开会」也会被算成候选
  assert.equal(draft.filters.allDay, true);
  assert.equal(parser.parse('查询今天的待办').filters.allDay, true);
});

test('单日且没有时刻的表达一律算待办：「明天 交实验报告」也是待办', () => {
  for (const text of ['明天 交实验报告', '后天 体检', '添加 2025-10-20 交材料']) {
    const draft = parser.parse(text);
    assert.equal(draft.target, 'schedule', `「${text}」应判到日程/待办`);
    assert.equal(draft.fields.allDay, true);
    assert.equal(draft.fields.status, 'pending');
  }
});

test('跨天的日期区间仍算日历事件（不能被待办规则吃掉）', () => {
  const draft = parser.parse('添加 2025-10-20 到 2025-10-22 期中考试');
  assert.equal(draft.target, 'event');
  assert.equal(draft.fields.startDate, '2025-10-20');
  assert.equal(draft.fields.endDate, '2025-10-22');
  // 区间配「假期」这类措辞同样走事件
  assert.equal(parser.parse('2026-01-20 到 2026-02-20 寒假').target, 'event');
});

test('明确写了「日历事件 / 假期」时仍然判到事件，不被待办规则抢走', () => {
  const holiday = parser.parse('添加日历事件 10月1日 国庆假期');
  assert.equal(holiday.target, 'event');
  const exam = parser.parse('添加日历事件 2025-10-20 到 2025-10-22 期中考试');
  assert.equal(exam.target, 'event');
  assert.equal(exam.fields.endDate, '2025-10-22');
});

test('查询待办产出未完成过滤条件', () => {
  const draft = parser.parse('查询今天的待办');
  assert.equal(draft.action, 'query');
  assert.equal(draft.target, 'schedule');
  assert.equal(draft.filters.status, 'pending');
});

// ---------------------------------------------------------------- 端到端

test('一句话加待办：落进 schedules，待办视图的查询能查到', async () => {
  const { app, call } = await startApp();
  try {
    const created = await call('POST', '/commands/run', { text: '添加待办 今天 交实验报告' });
    assert.equal(created.status, 200);
    assert.equal(created.body.target, 'schedule');
    assert.equal(created.body.item.allDay, true);
    assert.equal(created.body.item.status, 'pending');
    assert.equal(created.body.item.title, '交实验报告');

    // 待办视图（views/calendar.js）用的就是这个查询
    const pending = await call('GET', '/schedules?status=pending&limit=300');
    assert.equal(pending.status, 200);
    assert.equal(pending.body.items.length, 1);
    assert.equal(pending.body.items[0].title, '交实验报告');
    assert.equal(pending.body.items[0].date, todayKey());

    // 事件集合里不应该多出这条「待办」
    const events = await call('GET', '/events');
    assert.equal(events.body.items.length, 0);
  } finally {
    await app.close();
  }
});

test('一句话完成待办：状态流转为 done', async () => {
  const { app, call } = await startApp();
  try {
    await call('POST', '/commands/run', { text: '添加待办 今天 交实验报告' });
    const done = await call('POST', '/commands/run', { text: '完成今天的交实验报告' });
    assert.equal(done.status, 200);
    assert.equal(done.body.target, 'schedule');
    assert.equal(done.body.items.length, 1);
    assert.equal(done.body.items[0].status, 'done');

    const remaining = await call('GET', '/schedules?allDay=1&status=pending');
    assert.equal(remaining.body.items.length, 0);
    const finished = await call('GET', '/schedules?allDay=1&status=done');
    assert.equal(finished.body.items.length, 1);
  } finally {
    await app.close();
  }
});

test('待办与日程是两件事：待办列表不含带时刻的日程，日程也不能被完成', async () => {
  const { app, call } = await startApp();
  try {
    // 同一天：一条待办 + 一条带时刻的日程
    await call('POST', '/commands/run', { text: '添加待办 今天 交实验报告' });
    const meeting = await call('POST', '/commands/run', { text: '添加日程 今天 15:00-16:00 项目周会' });
    assert.equal(meeting.body.item.allDay, false);
    const meetingId = meeting.body.item.id;

    // ① 待办列表（allDay=1）里只有待办，会议不会混进来
    const todos = await call('GET', '/schedules?allDay=1&status=pending&limit=300');
    assert.equal(todos.body.items.length, 1);
    assert.equal(todos.body.items[0].title, '交实验报告');

    // ② 只取时段日程时，那条会议在
    const timed = await call('GET', '/schedules?allDay=0');
    assert.equal(timed.body.items.length, 1);
    assert.equal(timed.body.items[0].title, '项目周会');

    // ③ 直接点名一条时段日程去「完成」→ 400，且状态没被改
    const rejected = await call('POST', `/schedules/${meetingId}/status`, { status: 'done' });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error.message, /没有完成态/);
    const after = await call('GET', `/schedules/${meetingId}`);
    assert.equal(after.body.item.status, 'pending');

    // ④ 但「取消」对日程是成立的（取消一场会议是合理操作）
    const cancelled = await call('POST', `/schedules/${meetingId}/status`, { status: 'cancelled' });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.item.status, 'cancelled');
  } finally {
    await app.close();
  }
});

test('「完成」打在日历事件上是明确的报错，而不是静默改错东西', async () => {
  const { app, call } = await startApp();
  try {
    await call('POST', '/commands/run', { text: '添加日历事件 今天 期中考试' });
    const result = await call('POST', '/commands/execute', {
      draft: { ok: true, action: 'complete', target: 'event', filters: { from: todayKey(), to: todayKey() } },
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error.message, /没有完成态/);
    // 事件本身没被改动
    const events = await call('GET', '/events');
    assert.equal(events.body.items.length, 1);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------- AI 能力清单

test('日历模块声明了 aiTools，且被 /ai/capabilities 聚合', async () => {
  const { app, call } = await startApp();
  try {
    const { status, body } = await call('GET', '/ai/capabilities');
    assert.equal(status, 200);

    const mine = body.aiTools.filter((tool) => tool.module === 'calendar');
    assert.ok(mine.length >= 8, `日历工具至少 8 个，实际 ${mine.length}`);

    const names = mine.map((tool) => tool.name);
    for (const expected of [
      'calendar_schedule_create',
      'calendar_schedule_complete',
      'calendar_schedule_list',
      'calendar_schedule_delete',
      'calendar_event_create',
      'calendar_event_list',
      'calendar_command_parse',
      'calendar_command_run',
    ]) {
      assert.ok(names.includes(expected), `缺少工具 ${expected}`);
    }

    for (const tool of mine) {
      assert.equal(typeof tool.description, 'string');
      assert.ok(typeof tool.path === 'string' && tool.path.startsWith('/'));
      assert.ok(['GET', 'POST', 'PATCH', 'DELETE'].includes(tool.method));
      assert.equal(typeof tool.mutates, 'boolean');
      assert.equal(tool.requiresAuth, false, '日历是本地数据，不应要求登录');
      assert.ok(tool.params && typeof tool.params === 'object');
    }

    // 写操作必须如实标 mutates，Agent 才知道要先确认
    for (const name of ['calendar_schedule_create', 'calendar_event_create', 'calendar_schedule_delete']) {
      assert.equal(mine.find((tool) => tool.name === name).mutates, true, `${name} 应标记为写操作`);
    }
    assert.equal(mine.find((tool) => tool.name === 'calendar_schedule_list').mutates, false);

    // 思源学堂的工具仍在，聚合没有互相覆盖
    assert.ok(body.aiTools.some((tool) => tool.module === 'lms'));
  } finally {
    await app.close();
  }
});

test('接口文档与 aiTools 一致：AI 照文档就能调对路径与集合', async () => {
  const doc = await readFile(new URL('../docs/接口文档.md', import.meta.url), 'utf8');
  const { CALENDAR_TOOL_SPECS } = await import('../src/modules/calendar/tools.js');

  // 1) 工具清单里的每个 path 都要在文档里出现，否则模型按工具清单拼出来的调用没有文档依据
  for (const tool of CALENDAR_TOOL_SPECS) {
    assert.ok(doc.includes(tool.path), `接口文档缺少 ${tool.name} 的路径 ${tool.path}`);
  }

  // 2) 「待办是 Schedule + allDay」这条判别必须在文档里写死 —— 写错集合是 AI 最容易犯的错
  assert.ok(doc.includes('待办 = `Schedule` + `allDay: true`'), '接口文档必须写明「待办 = Schedule + allDay: true」');
  assert.ok(doc.includes('待办列表只读 `/schedules`'), '接口文档必须写明待办列表只读 /schedules');

  // 3) 两个高危写法都要有正确/错误对照
  assert.ok(doc.includes('不要用 `/events` 建待办'), '接口文档必须警告不要用 /events 建待办');
  assert.ok(doc.includes('非全天必须给 `startTime`'), '接口文档必须写明非全天必须给 startTime');

  // 4) 状态流转与 source 约定
  assert.ok(doc.includes('/schedules/{id}/status'), '接口文档必须给出完成待办的接口');
  assert.ok(doc.includes('"source": "ai"'), '接口文档必须提醒模型写库时标 source=ai');
});
