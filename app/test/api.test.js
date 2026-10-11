/**
 * 接口冒烟测试：真实起服务、真实写临时数据文件、走 HTTP。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';

/** 服务端用的是服务器本地日期，测试里同样算本地日期。 */
function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

async function startApp() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-calendar-'));
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
  return { app, info, call, dataDir };
}

test('健康检查返回数据量统计', async () => {
  const { app, call } = await startApp();
  try {
    const { status, body } = await call('GET', '/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'ok');
    // counts 由各模块声明的集合自动汇总（不再由路由硬编码），因此这里按集合名逐个核对
    for (const name of ['events', 'schedules', 'commandLogs', 'lmsCourses', 'lmsActivities']) {
      assert.equal(body.counts[name], 0, `集合 ${name} 初始应为空`);
    }
  } finally {
    await app.close();
  }
});

test('指令 run：创建 -> 查询 -> 完成 -> 删除 全链路', async () => {
  const { app, call } = await startApp();
  try {
    const created = await call('POST', '/commands/run', {
      text: '添加日程 2030-01-02 15:00-16:00 项目周会 提前10分钟提醒',
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.item.date, '2030-01-02');
    assert.equal(created.body.item.startTime, '15:00');
    assert.equal(created.body.item.status, undefined, '日程没有完成态');
    assert.equal(created.body.item.source, 'command');
    const id = created.body.item.id;

    const queried = await call('POST', '/commands/execute', {
      text: '查询 2030-01-02 的日程',
    });
    assert.equal(queried.body.count, 1);

    // 「完成」是待办的动作，不是时段日程的：先建一条待办再完成它
    const todo = await call('POST', '/commands/run', { text: '添加待办 2030-01-02 交材料' });
    assert.equal(todo.body.target, 'todo');
    assert.equal(todo.body.item.deadline, '2030-01-02');
    const completed = await call('POST', '/commands/run', { text: '完成 2030-01-02 交材料' });
    assert.equal(completed.body.items[0].completed, true);
    assert.ok(completed.body.items[0].completedAt);

    // 时段日程（有起止时刻）没有完成态：直接点名它也会被拒
    const rejected = await call('POST', '/commands/run', { text: '完成 2030-01-02 项目周会' });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error.message, /没有完成态/);
    const untouched = await call('GET', `/schedules/${id}`);
    assert.equal(untouched.body.item.startTime, '15:00', '被拒之后日程本身没有被动过');
    assert.equal(untouched.body.item.title, '项目周会');

    const removed = await call('POST', '/commands/run', { text: '删除 2030-01-02 项目周会' });
    assert.equal(removed.body.deleted, 1);

    const after = await call('GET', `/schedules/${id}`);
    assert.equal(after.status, 404);
  } finally {
    await app.close();
  }
});

test('dryRun 只预览不写库', async () => {
  const { app, call } = await startApp();
  try {
    const preview = await call('POST', '/commands/run', {
      text: '添加日程 2030-03-01 09:00 早读',
      dryRun: true,
    });
    assert.equal(preview.body.dryRun, true);
    assert.equal(preview.body.planned.fields.title, '早读');
    const list = await call('GET', '/schedules');
    assert.equal(list.body.items.length, 0);
  } finally {
    await app.close();
  }
});

test('重复日程在区间查询中展开，并记录冲突提示', async () => {
  const { app, call } = await startApp();
  try {
    await call('POST', '/schedules', {
      title: '英语晨读',
      date: '2030-01-07',
      startTime: '09:00',
      endTime: '09:30',
      category: 'study',
      repeat: { type: 'weekly', interval: 1, weekdays: [1] },
    });
    const conflict = await call('POST', '/schedules', {
      title: '撞车会议',
      date: '2030-01-14',
      startTime: '09:15',
      endTime: '09:45',
    });
    assert.equal(conflict.body.conflicts.length, 1);
    assert.equal(conflict.body.conflicts[0].title, '英语晨读');

    const range = await call('GET', '/schedules/range?from=2030-01-01&to=2030-01-31');
    assert.equal(range.body.items.length, 5); // 1/7、14、21、28 + 撞车那条

    const calendar = await call('GET', '/calendar?from=2030-01-07&to=2030-01-07');
    assert.equal(calendar.body.days.length, 1);
    assert.equal(calendar.body.days[0].schedules.length, 1);
  } finally {
    await app.close();
  }
});

test('顺延未完成待办：截止日平移 + rolledFrom 记来源（不克隆、不改完成态）', async () => {
  const { app, call } = await startApp();
  try {
    const created = await call('POST', '/todos', { title: '上周没写完的作业', deadline: '2020-01-06' });
    const rolled = await call('POST', '/todos/rollover', { weekStart: '2020-01-13' });
    assert.equal(rolled.body.moved, 1);
    assert.equal(rolled.body.items[0].from, '2020-01-06');
    // 显式给了一个**过去**的周一时，落点被夹到今天（顺延不能把人挪回过去）
    assert.equal(rolled.body.items[0].to, todayKey());

    // 同一条记录（id 不变）被平移，来源记在 rolledFrom
    const after = await call('GET', `/todos/${created.body.item.id}`);
    assert.equal(after.body.item.id, created.body.item.id);
    assert.equal(after.body.item.deadline, todayKey());
    assert.deepEqual(after.body.item.rolledFrom, { deadline: '2020-01-06' });
    assert.equal(after.body.item.completed, false);

    // 日程没有顺延这回事：接口已删除
    assert.equal((await call('POST', '/schedules/rollover', { weekStart: '2020-01-13' })).status, 404);
  } finally {
    await app.close();
  }
});

test('参数校验失败返回 400 且带字段名', async () => {
  const { app, call } = await startApp();
  try {
    const bad = await call('POST', '/schedules', { title: '', date: '2030-13-99' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.ok, false);
    assert.ok(bad.body.error.details.field);

    const badRange = await call('GET', '/calendar?from=2030-01-02&to=2030-01-01');
    assert.equal(badRange.status, 400);
  } finally {
    await app.close();
  }
});

test('AI 接口未接入时返回 501，声明 fallback 时降级到本地规则', async () => {
  const { app, call } = await startApp();
  try {
    const unavailable = await call('POST', '/ai/nl2command', { text: '明天下午三点开会' });
    assert.equal(unavailable.status, 501);
    assert.equal(unavailable.body.error.code, 'AI_UNAVAILABLE');
    assert.ok(unavailable.body.error.details.expectedResponse);

    const capabilities = await call('GET', '/ai/capabilities');
    assert.equal(capabilities.body.available, false);
    assert.ok(capabilities.body.features.every((feature) => typeof feature.enabled === 'boolean'));

    const fallback = await call('POST', '/ai/nl2command', { text: '明天下午三点开会', fallback: 'rules' });
    assert.equal(fallback.status, 200);
    assert.equal(fallback.body.draft.provider, 'rules');
    assert.equal(fallback.body.draft.fields.startTime, '15:00');
  } finally {
    await app.close();
  }
});

test('数据落盘到 JSON 文件，重启后仍可读', async () => {
  const { app, call, dataDir } = await startApp();
  const created = await call('POST', '/events', {
    title: '国庆假期',
    startDate: '2030-10-01',
    endDate: '2030-10-07',
    category: 'holiday',
  });
  assert.equal(created.status, 201);
  await app.close();

  const restarted = await createServer({ dataDir });
  const info = await restarted.listen({ port: 0 });
  const response = await fetch(`${info.baseUrl}/events`);
  const payload = await response.json();
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].title, '国庆假期');
  await restarted.close();
});
