/**
 * dryRun 预览也要算「时段冲突」。
 *
 * 跨功能测试（S4）实测出的缺陷：`conflicts` 只有**真写**那条路才产生
 * （`commands.create` 落库后才调 `schedules.conflictsFor`），于是：
 *   - dryRun 的响应里没有冲突 → 确认卡干干净净 → 用户点了"确认"才知道撞了；
 *   - auto 档更糟：模型也拿不到冲突（它只看得到自己说过的话），正文只会说"给你加上了"。
 *
 * 修法是让预览调**同一个** `schedules.conflictsFor`，而不是另写一套判断。
 * 这里盯住的正是这件事，包括最容易漂移的几处：跨天、重复日程展开后的实例、
 * 以及"紧邻但不重叠"（11:00 结束 vs 11:00 开始）不该被误报。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';

const DAY = '2026-10-13';

async function startApp() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-calendar-conflict-'));
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
  return { app, call };
}

/** 模型/AI 侧会发出的那种日程写入草稿。 */
const scheduleDraft = (fields) => ({ ok: true, action: 'create', target: 'schedule', fields });

test('dryRun 预览：与已有日程重叠时给出 conflicts（含 id 与两端时刻），且不写库', async () => {
  const { app, call } = await startApp();
  try {
    const existing = await call('POST', '/schedules', {
      title: '材料力学',
      date: DAY,
      startTime: '10:00',
      endTime: '11:00',
      location: '教2楼-西203',
    });
    assert.equal(existing.status, 201);

    const preview = await call('POST', '/commands/execute', {
      draft: scheduleDraft({ title: '小组会', date: DAY, startTime: '10:30', endTime: '11:30' }),
      dryRun: true,
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.dryRun, true);
    assert.equal(preview.body.validated.title, '小组会', '预览照旧要跑真实字段校验');

    // 这就是确认卡能提前显示"与 1 条日程时间重叠"的依据
    assert.equal(preview.body.conflicts?.length, 1, `dryRun 必须报出重叠：${JSON.stringify(preview.body)}`);
    const [hit] = preview.body.conflicts;
    // id 是"日程 + 发生日"的复合 id（重复日程会有多个实例），scheduleId 才是记录本身的 id
    assert.equal(hit.id, `${existing.body.item.id}:${DAY}`);
    assert.equal(hit.scheduleId, existing.body.item.id, '冲突要能指认到具体是哪条日程');
    assert.equal(hit.title, '材料力学');
    assert.equal(hit.occurrenceDate, DAY, '冲突发生的那一天');
    assert.equal(hit.startTime, '10:00');
    assert.equal(hit.endTime, '11:00');

    // 预览就是预览：库里仍然只有那一条
    const after = await call('GET', '/schedules');
    assert.equal(after.body.items.length, 1, 'dryRun 绝不能写库');
  } finally {
    await app.close();
  }
});

test('dryRun 预览：不重叠时 conflicts 是空数组（"查了没撞"与"没查"要能区分）', async () => {
  const { app, call } = await startApp();
  try {
    await call('POST', '/schedules', { title: '材料力学', date: DAY, startTime: '10:00', endTime: '11:00' });

    const later = await call('POST', '/commands/execute', {
      draft: scheduleDraft({ title: '下午的实验', date: DAY, startTime: '14:00', endTime: '16:00' }),
      dryRun: true,
    });
    assert.deepEqual(later.body.conflicts, [], '同一天但不重叠 → 空数组');

    // 紧邻不算重叠：11:00 结束 vs 11:00 开始。写成 `<=` 就会把正常的一天报成撞车。
    const touching = await call('POST', '/commands/execute', {
      draft: scheduleDraft({ title: '接在后面的讨论', date: DAY, startTime: '11:00', endTime: '12:00' }),
      dryRun: true,
    });
    assert.deepEqual(touching.body.conflicts, [], '首尾相接（11:00 接 11:00）不是重叠');

    // 换一天也不该报
    const otherDay = await call('POST', '/commands/execute', {
      draft: scheduleDraft({ title: '同样的时段、别的日子', date: '2026-10-14', startTime: '10:30', endTime: '11:30' }),
      dryRun: true,
    });
    assert.deepEqual(otherDay.body.conflicts, []);
  } finally {
    await app.close();
  }
});

test('dryRun 与真写共用一套冲突判断：重复日程展开后的实例同样算重叠', async () => {
  const { app, call } = await startApp();
  try {
    // 2030-01-07 是周一，每周一 09:00-09:30 重复
    const repeated = await call('POST', '/schedules', {
      title: '英语晨读',
      date: '2030-01-07',
      startTime: '09:00',
      endTime: '09:30',
      repeat: { type: 'weekly', interval: 1, weekdays: [1] },
    });
    assert.equal(repeated.status, 201);

    // 下一周的周一（锚点之外的实例）撞上它：预览必须看得见
    const preview = await call('POST', '/commands/execute', {
      draft: scheduleDraft({ title: '撞车会议', date: '2030-01-14', startTime: '09:15', endTime: '09:45' }),
      dryRun: true,
    });
    assert.equal(preview.body.conflicts?.length, 1, `重复日程的实例也要算：${JSON.stringify(preview.body)}`);
    assert.equal(preview.body.conflicts[0].scheduleId, repeated.body.item.id);
    assert.equal(preview.body.conflicts[0].occurrenceDate, '2030-01-14');

    // 真写报的冲突与预览**完全一致**（同一份口径，不是两套实现）
    const written = await call('POST', '/commands/execute', {
      draft: scheduleDraft({ title: '撞车会议', date: '2030-01-14', startTime: '09:15', endTime: '09:45' }),
    });
    assert.equal(written.status, 200);
    assert.deepEqual(
      written.body.conflicts.map((item) => item.id),
      preview.body.conflicts.map((item) => item.id),
      '预览与真写的冲突判断不能漂移',
    );
  } finally {
    await app.close();
  }
});

test('规则解析那条路（/commands/run dryRun）一样带 conflicts；待办/事件不造这个字段', async () => {
  const { app, call } = await startApp();
  try {
    await call('POST', '/schedules', { title: '项目周会', date: '2030-03-01', startTime: '09:00', endTime: '10:00' });

    const preview = await call('POST', '/commands/run', {
      text: '添加日程 2030-03-01 09:30-10:30 复盘会',
      dryRun: true,
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.dryRun, true);
    assert.equal(preview.body.conflicts?.length, 1, `本地规则走的也是同一条处理器：${JSON.stringify(preview.body)}`);
    assert.equal(preview.body.conflicts[0].title, '项目周会');

    // 待办与日历事件没有时段，真写时也不报冲突 —— 预览不该凭空造一个空字段出来
    const todo = await call('POST', '/commands/execute', {
      draft: { ok: true, action: 'create', target: 'todo', fields: { title: '交实验报告', deadline: DAY } },
      dryRun: true,
    });
    assert.equal(todo.body.dryRun, true);
    assert.equal(todo.body.conflicts, undefined);

    const event = await call('POST', '/commands/execute', {
      draft: { ok: true, action: 'create', target: 'event', fields: { title: '期中考试', startDate: DAY } },
      dryRun: true,
    });
    assert.equal(event.body.dryRun, true);
    assert.equal(event.body.conflicts, undefined);
  } finally {
    await app.close();
  }
});
