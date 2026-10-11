/**
 * 日历与待办模块的行为测试。
 *
 * 覆盖四件事（都是「对话/AI 能不能真的加待办」这条链路上的坑）：
 *   1. 「待办」是独立集合 `Todo`，只走 `/todos` —— 待办视图只读它，
 *      判成 schedule / event 会让用户说了「加待办」却在待办列表里看不到；
 *   2. 单日无时刻 = 待办，有具体时刻 = 日程（必须给 startTime），跨天区间 = 日历事件；
 *   3. 「完成」只对待办有意义：日程与日历事件都没有完成态，对它们标完成必须 400；
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

test('「待办」类措辞解析为待办集合（target todo），而不是日程或事件', () => {
  for (const text of ['添加待办 明天 交实验报告', '明天 交作业', '任务 明天 提交报名材料']) {
    const draft = parser.parse(text);
    assert.equal(draft.target, 'todo', `「${text}」应判到待办`);
    assert.equal(draft.fields.deadline, '2025-10-16');
    assert.equal(draft.fields.allDay, undefined, '待办没有 allDay');
    assert.equal(draft.fields.status, undefined, '待办没有 status');
  }
});

test('「完成」是待办的动作：只定位待办，不碰时段日程', () => {
  const draft = parser.parse('完成今天的英语听力');
  assert.equal(draft.action, 'complete');
  assert.equal(draft.target, 'todo');
  assert.equal(draft.filters.from, '2025-10-15');
  assert.equal(draft.filters.keyword, '英语听力');
  // 默认只找未完成的待办（日程没有完成态，也不需要这个条件）
  assert.equal(draft.filters.completed, false);
  assert.equal(parser.parse('查询今天的待办').target, 'todo');
  assert.equal(parser.parse('查询今天未完成的待办').filters.completed, false);
});

test('单日且没有时刻的表达一律算待办：「明天 交实验报告」也是待办', () => {
  for (const text of ['明天 交实验报告', '后天 体检', '添加 2025-10-20 交材料']) {
    const draft = parser.parse(text);
    assert.equal(draft.target, 'todo', `「${text}」应判到待办`);
    assert.ok(draft.fields.deadline, '待办必须落到 deadline');
    assert.equal(draft.fields.startTime, undefined, '待办没有时刻');
  }
});

test('明确说了「日程」但没给时刻：补默认时段，绝不退化成待办', () => {
  const draft = parser.parse('添加日程 明天 开会');
  assert.equal(draft.target, 'schedule');
  assert.equal(draft.fields.startTime, '09:00');
  assert.equal(draft.fields.endTime, '10:00');
  assert.equal(draft.fields.allDay, undefined, '日程模型里已经没有 allDay');
  assert.equal(draft.fields.status, undefined, '日程没有完成态');
  assert.ok(draft.warnings.some((text) => text.includes('09:00-10:00')));
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

test('待办字段：工时、优先级、标签都能解析出来', () => {
  const draft = parser.parse('添加待办 2025-10-20 交实验报告 预计2小时 重要 #物理');
  assert.equal(draft.target, 'todo');
  assert.equal(draft.fields.deadline, '2025-10-20');
  assert.equal(draft.fields.estimatedHours, 2);
  assert.equal(draft.fields.priority, 2);
  assert.deepEqual(draft.fields.tags, ['物理']);
  assert.equal(draft.fields.title, '交实验报告');
});

test('顺延指令解析为 rollover/todo', () => {
  const draft = parser.parse('顺延未完成的待办到本周');
  assert.equal(draft.action, 'rollover');
  assert.equal(draft.target, 'todo');
  assert.equal(draft.filters.weekStart, '2025-10-13');
});

// ---------------------------------------------------------------- 端到端

test('一句话加待办：落进 todos，待办视图的查询能查到', async () => {
  const { app, call } = await startApp();
  try {
    const created = await call('POST', '/commands/run', { text: '添加待办 今天 交实验报告' });
    assert.equal(created.status, 200);
    assert.equal(created.body.target, 'todo');
    assert.equal(created.body.item.deadline, todayKey());
    assert.equal(created.body.item.completed, false);
    assert.equal(created.body.item.title, '交实验报告');

    // 待办视图（views/calendar.js）用的就是这个查询
    const pending = await call('GET', '/todos?completed=false');
    assert.equal(pending.status, 200);
    assert.equal(pending.body.items.length, 1);
    assert.equal(pending.body.items[0].title, '交实验报告');
    assert.equal(pending.body.stats.pending, 1);

    // 日程与事件集合里都不应该多出这条待办
    assert.equal((await call('GET', '/schedules')).body.items.length, 0);
    assert.equal((await call('GET', '/events')).body.items.length, 0);
  } finally {
    await app.close();
  }
});

test('一句话完成待办：completed 变 true 并写入 completedAt', async () => {
  const { app, call } = await startApp();
  try {
    await call('POST', '/commands/run', { text: '添加待办 今天 交实验报告' });
    const done = await call('POST', '/commands/run', { text: '完成今天的交实验报告' });
    assert.equal(done.status, 200);
    assert.equal(done.body.target, 'todo');
    assert.equal(done.body.items.length, 1);
    assert.equal(done.body.items[0].completed, true);
    assert.ok(done.body.items[0].completedAt, '完成时要写 completedAt');

    assert.equal((await call('GET', '/todos?completed=false')).body.items.length, 0);
    const finished = await call('GET', '/todos?completed=true');
    assert.equal(finished.body.items.length, 1);

    // 取消完成：completedAt 清成 null（不是留着旧时间戳）
    const undone = await call('POST', `/todos/${done.body.items[0].id}/completed`, { completed: false });
    assert.equal(undone.body.item.completed, false);
    assert.equal(undone.body.item.completedAt, null);
  } finally {
    await app.close();
  }
});

test('待办与日程是两件事：集合分开、日程没有完成态', async () => {
  const { app, call } = await startApp();
  try {
    await call('POST', '/commands/run', { text: '添加待办 今天 交实验报告' });
    const meeting = await call('POST', '/commands/run', { text: '添加日程 今天 15:00-16:00 项目周会' });
    assert.equal(meeting.body.item.startTime, '15:00');
    assert.equal(meeting.body.item.allDay, undefined);
    assert.equal(meeting.body.item.status, undefined);
    const meetingId = meeting.body.item.id;

    // ① 待办列表里只有待办，会议不会混进来
    const todos = await call('GET', '/todos');
    assert.equal(todos.body.items.length, 1);
    assert.equal(todos.body.items[0].title, '交实验报告');

    // ② 日程列表里只有时段日程
    const timed = await call('GET', '/schedules');
    assert.equal(timed.body.items.length, 1);
    assert.equal(timed.body.items[0].title, '项目周会');

    // ③ 旧的「改状态」接口已删除
    assert.equal((await call('POST', `/schedules/${meetingId}/status`, { status: 'done' })).status, 404);
    assert.equal((await call('POST', '/schedules/rollover', {})).status, 404);

    // ④ 想通过 PATCH 给日程塞 status/allDay 也会被拒，且说明理由
    const badStatus = await call('PATCH', `/schedules/${meetingId}`, { status: 'done' });
    assert.equal(badStatus.status, 400);
    assert.match(badStatus.body.error.message, /没有完成态/);
    const badAllDay = await call('PATCH', `/schedules/${meetingId}`, { allDay: true });
    assert.equal(badAllDay.status, 400);
    assert.match(badAllDay.body.error.message, /todos/);

    // ⑤ 用 /schedules 建「只有日期」的条目会被指向 /todos
    const badCreate = await call('POST', '/schedules', { title: '交实验报告', date: todayKey() });
    assert.equal(badCreate.status, 400);
    assert.match(badCreate.body.error.message, /todos/);
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

// ---------------------------------------------------------------- 待办：过滤 / 排序 / 顺延 / 聚合

test('待办过滤：overdue、completed、priority、keyword；upcoming 按截止日升序', async () => {
  const { app, call } = await startApp();
  try {
    await call('POST', '/todos', { title: '过期的作业', deadline: '2020-01-01', priority: 2 });
    await call('POST', '/todos', { title: '今天的作业', deadline: todayKey(), priority: 1 });
    await call('POST', '/todos', { title: '以后的作业', deadline: '2099-01-01' });
    const done = await call('POST', '/todos', { title: '做完的作业', deadline: '2099-01-02' });
    await call('POST', `/todos/${done.body.item.id}/completed`, { completed: true });

    const overdue = await call('GET', '/todos?overdue=1');
    assert.equal(overdue.body.items.length, 1);
    assert.equal(overdue.body.items[0].title, '过期的作业');
    assert.equal(overdue.body.items[0].isOverdue, true);

    assert.equal((await call('GET', '/todos?completed=false')).body.items.length, 3);
    assert.equal((await call('GET', '/todos?completed=true')).body.items.length, 1);
    assert.equal((await call('GET', '/todos?priority=2')).body.items.length, 1);
    assert.equal((await call('GET', '/todos?keyword=今天')).body.items.length, 1);

    const upcoming = await call('GET', '/todos/upcoming');
    assert.equal(upcoming.body.items.length, 3, 'upcoming 只含未完成');
    const deadlines = upcoming.body.items.map((item) => item.deadline);
    assert.deepEqual(deadlines, [...deadlines].sort(), 'upcoming 必须按截止日升序');

    const stats = (await call('GET', '/todos')).body.stats;
    assert.equal(stats.total, 4);
    assert.equal(stats.completed, 1);
    assert.equal(stats.overdue, 1);
    assert.equal(stats.completionRate, 25);

    // 派生字段（复杂度阈值照 PotatoCalendar）
    const heavy = await call('POST', '/todos', { title: '毕业论文', deadline: '2099-06-01', estimatedHours: 20 });
    assert.equal(heavy.body.item.complexity, 'heavy');
    assert.equal(heavy.body.item.complexityLabel, '繁琐');
  } finally {
    await app.close();
  }
});

test('顺延未完成待办：截止日平移到目标周的同一星期几，且落点绝不早于今天', async () => {
  const { app, call } = await startApp();
  try {
    // ① 缺省本周一：逾期待办不能落到过去（否则「顺延到本周」挪完还是逾期，等于没顺延）
    const created = await call('POST', '/todos', { title: '上周没写完的作业', deadline: '2020-01-06' });
    const rolled = await call('POST', '/todos/rollover', {});
    assert.equal(rolled.body.moved, 1);
    assert.ok(
      rolled.body.items[0].to >= todayKey(),
      `顺延落点 ${rolled.body.items[0].to} 不得早于今天 ${todayKey()}`,
    );

    // 同一条记录（id 不变）被平移；来源记在 rolledFrom；完成态不变
    const after = await call('GET', `/todos/${created.body.item.id}`);
    assert.equal(after.body.item.deadline, rolled.body.items[0].to);
    assert.deepEqual(after.body.item.rolledFrom, { deadline: '2020-01-06' });
    assert.equal(after.body.item.completed, false, '顺延不改完成态');

    // ② 显式给未来某一周的周一：落到那一周的同一星期几（原截止日就是周一）
    const targetWeek = mondayKey(1);
    const second = await call('POST', '/todos', { title: '三周前的作业', deadline: mondayKey(-3) });
    const rolled2 = await call('POST', '/todos/rollover', { weekStart: targetWeek });
    const moved = rolled2.body.items.find((item) => item.id === second.body.item.id);
    assert.equal(moved.to, targetWeek, '原截止日是周一 -> 落到目标周的周一');

    // ③ 已完成的待办不参与顺延
    const done = await call('POST', '/todos', { title: '已完成的老作业', deadline: '2020-01-02', completed: true });
    const third = await call('POST', '/todos/rollover', { weekStart: mondayKey(2) });
    assert.ok(!third.body.items.some((item) => item.id === done.body.item.id), '已完成的待办不该被顺延');
    assert.equal((await call('GET', `/todos/${done.body.item.id}`)).body.item.deadline, '2020-01-02');
  } finally {
    await app.close();
  }
});

test('「完成 X」当 X 是日程/事件时报「没有完成态」，只有真的不存在才 404', async () => {
  const { app, call } = await startApp();
  try {
    await call('POST', '/schedules', {
      title: '数据结构课',
      date: todayKey(),
      startTime: '08:00',
      endTime: '09:40',
      category: 'class',
    });
    const onSchedule = await call('POST', '/commands/run', { text: '完成数据结构课' });
    assert.equal(onSchedule.status, 400, '对日程执行完成必须 400，而不是 404');
    assert.match(onSchedule.body.error.message, /没有完成态/);
    assert.equal(onSchedule.body.error.details?.field, 'target');

    await call('POST', '/events', { title: '期中考试', startDate: todayKey(), endDate: todayKey(), category: 'exam' });
    const onEvent = await call('POST', '/commands/run', { text: '完成期中考试' });
    assert.equal(onEvent.status, 400);
    assert.match(onEvent.body.error.message, /没有完成态/);

    const missing = await call('POST', '/commands/run', { text: '完成不存在的待办事项' });
    assert.equal(missing.status, 404, '两个集合都没有命中才是 404');
  } finally {
    await app.close();
  }
});

test('/calendar 聚合：每天的桶含 todos，顶部 stats 含待办统计', async () => {
  const { app, call } = await startApp();
  try {
    await call('POST', '/todos', { title: '今天要交的报告', deadline: todayKey() });
    await call('POST', '/todos', { title: '明天要交的作业', deadline: addDays(todayKey(), 1) });
    await call('POST', '/schedules', { title: '项目周会', date: todayKey(), startTime: '15:00', endTime: '16:00' });
    await call('POST', '/events', { title: '期中考试', startDate: todayKey(), endDate: todayKey(), category: 'exam' });

    const calendar = await call('GET', `/calendar?from=${todayKey()}&to=${addDays(todayKey(), 1)}`);
    assert.equal(calendar.status, 200);
    const today = calendar.body.days[0];
    assert.equal(today.todos.length, 1);
    assert.equal(today.todos[0].title, '今天要交的报告');
    assert.equal(today.schedules.length, 1);
    assert.equal(today.events.length, 1);
    assert.equal(today.stats.todos, 1);
    assert.equal(today.stats.schedules, 1);
    assert.equal(calendar.body.days[1].todos.length, 1);
    assert.equal(calendar.body.stats.todos.total, 2);
    assert.equal(calendar.body.stats.schedules.total, 1);
  } finally {
    await app.close();
  }
});

test('历史遗留的日期锚点（allDay 的 schedules 行）会被迁成待办，且不会出现在日程里', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-calendar-migrate-'));
  // 先手工造一份「旧版本写下的」数据：schedules 里塞一条 source=import 的 allDay 行
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    path.join(dataDir, 'schedules.json'),
    JSON.stringify({
      schemaVersion: 1,
      items: [
        {
          id: 'legacy-1',
          title: '[数据结构] 第一次作业：链表',
          date: '2026-10-14',
          allDay: true,
          status: 'done',
          source: 'import',
          externalId: 'lms:activity:5001',
          priority: 1,
          tags: ['思源学堂', '作业'],
          description: '课程：数据结构',
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    }),
  );
  const app = await createServer({ dataDir, version: '0.1.0-test' });
  const info = await app.listen({ port: 0 });
  const call = async (method, route) => {
    const response = await fetch(`${info.baseUrl}${route}`);
    return { status: response.status, body: await response.json() };
  };
  try {
    // 迁移后：待办里有它（completed 沿用旧 status），日程里没有
    const todos = await call('GET', '/todos');
    assert.equal(todos.body.items.length, 1);
    assert.equal(todos.body.items[0].deadline, '2026-10-14');
    assert.equal(todos.body.items[0].completed, true);
    assert.equal(todos.body.items[0].externalId, 'lms:activity:5001');
    assert.equal((await call('GET', '/schedules')).body.items.length, 0);
    // 数据没有丢：/calendar 也不会把它算成日程
    const calendar = await call('GET', '/calendar?from=2026-10-14&to=2026-10-14');
    assert.equal(calendar.body.days[0].schedules.length, 0);
    assert.equal(calendar.body.days[0].todos.length, 1);
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
    assert.equal(mine.length, 19, `日历工具 19 个，实际 ${mine.length}`);

    const names = mine.map((tool) => tool.name);
    for (const expected of [
      'calendar_todo_list',
      'calendar_todo_create',
      'calendar_todo_update',
      'calendar_todo_complete',
      'calendar_todo_delete',
      'calendar_todo_rollover',
      'calendar_todo_upcoming',
      'calendar_schedule_create',
      'calendar_schedule_list',
      'calendar_schedule_delete',
      'calendar_event_create',
      'calendar_event_list',
      'calendar_command_parse',
      'calendar_command_run',
    ]) {
      assert.ok(names.includes(expected), `缺少工具 ${expected}`);
    }
    assert.ok(!names.includes('calendar_schedule_complete'), '日程没有完成态，不该再有 schedule_complete');
    assert.ok(!names.includes('calendar_schedule_rollover'), '顺延只属于待办');

    for (const tool of mine) {
      assert.equal(typeof tool.description, 'string');
      assert.ok(typeof tool.path === 'string' && tool.path.startsWith('/'));
      assert.ok(['GET', 'POST', 'PATCH', 'DELETE'].includes(tool.method));
      assert.equal(typeof tool.mutates, 'boolean');
      assert.equal(tool.requiresAuth, false, '日历是本地数据，不应要求登录');
      assert.ok(tool.params && typeof tool.params === 'object');
    }

    // 写操作必须如实标 mutates，Agent 才知道要先确认
    for (const name of ['calendar_todo_create', 'calendar_todo_complete', 'calendar_schedule_create', 'calendar_event_create', 'calendar_schedule_delete']) {
      assert.equal(mine.find((tool) => tool.name === name).mutates, true, `${name} 应标记为写操作`);
    }
    assert.equal(mine.find((tool) => tool.name === 'calendar_todo_list').mutates, false);

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

  // 2) 三集合的判别必须在文档里写死 —— 写错集合是 AI 最容易犯的错
  assert.ok(doc.includes('待办是独立集合 `Todo`'), '接口文档必须写明「待办是独立集合 Todo」');
  assert.ok(doc.includes('待办列表只读 `/todos`'), '接口文档必须写明待办列表只读 /todos');
  assert.ok(doc.includes('不要用 `/schedules` 建待办'), '接口文档必须警告不要用 /schedules 建待办');

  // 3) 两个高危写法都要有正确/错误对照 + 报错原文
  assert.ok(doc.includes('日程必须有 `startTime`'), '接口文档必须写明日程必须有 startTime');
  assert.ok(doc.includes('字段 startTime 必填'), '接口文档必须给出缺 startTime 的报错原文');

  // 4) 完成态只属于待办；写库要标 source
  assert.ok(doc.includes('/todos/{id}/completed'), '接口文档必须给出完成待办的接口');
  assert.ok(doc.includes('「完成」只属于待办'), '接口文档必须写明完成只属于待办');
  assert.ok(doc.includes('"source": "ai"'), '接口文档必须提醒模型写库时标 source=ai');
});

/** 相对今天偏移 N 周的周一（N 可为负；周一为一周之始）。 */
function mondayKey(offsetWeeks = 0) {
  const [y, m, d] = todayKey().split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const iso = date.getDay() === 0 ? 7 : date.getDay();
  date.setDate(date.getDate() + (1 - iso) + offsetWeeks * 7);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 本地日期加减（与 PCUtil.addDays 等价，测试里自己算，避免依赖前端代码）。 */
function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d + n);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
