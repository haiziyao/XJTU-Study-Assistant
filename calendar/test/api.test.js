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
    assert.deepEqual(body.counts, { events: 0, schedules: 0, commandLogs: 0 });
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
    assert.equal(created.body.item.status, 'pending');
    assert.equal(created.body.item.source, 'command');
    const id = created.body.item.id;

    const queried = await call('POST', '/commands/execute', {
      text: '查询 2030-01-02 的日程',
    });
    assert.equal(queried.body.count, 1);

    const completed = await call('POST', '/commands/run', { text: '完成 2030-01-02 项目周会' });
    assert.equal(completed.body.items[0].status, 'done');
    assert.ok(completed.body.items[0].completedAt);

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

test('顺延未完成日程：原记录标记 rolled 并保留双向引用', async () => {
  const { app, call } = await startApp();
  try {
    const created = await call('POST', '/schedules', {
      title: '上周没写完的作业',
      date: '2020-01-06',
      startTime: '10:00',
      endTime: '11:00',
    });
    const rolled = await call('POST', '/schedules/rollover', { weekStart: '2020-01-13' });
    assert.equal(rolled.body.moved, 1);
    assert.equal(rolled.body.items[0].toDate, '2020-01-13');

    const original = await call('GET', `/schedules/${created.body.item.id}`);
    assert.equal(original.body.item.status, 'rolled');
    assert.equal(original.body.item.rolledTo.date, '2020-01-13');

    const clone = await call('GET', `/schedules/${original.body.item.rolledTo.id}`);
    assert.equal(clone.body.item.status, 'pending');
    assert.equal(clone.body.item.rolledFrom.id, created.body.item.id);
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
