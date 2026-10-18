/**
 * 番茄钟端到端测试：**真起后端、假时钟注入、零真实外网**。
 *
 * 假时钟通过 `createServer({ pomodoro: { now: () => fakeNow } })` 注入 ——
 * 这样「专注 45 分钟」「睡过头跨 3 个阶段」都可以在毫秒内走完，不靠 sleep。
 *
 * 盯住四件用户真的会在意的事：
 *   1. 专注秒数记到待办自己 + **所有祖先**，已完成/无关的待办不变；
 *   2. 会话账本的 completed / actualSec / day 口径正确，且只保留最近 2000 条；
 *   3. 六个 POST 的正常与 400/409 错误分支；
 *   4. 阶段结束时 WS 只广播一次 `pomodoro` 事件（桌面端与手机靠它提醒）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { todayKey } from '../src/shared/time.js';
import { connectWs } from './helpers/ws-client.js';

/** 本地时间基准：早上 8 点，避免测试跑在午夜附近时 day 归属抖动。 */
const START = new Date(2026, 4, 6, 8, 0, 0).getTime();

async function startPomodoro({ dataDir, startMs = START } = {}) {
  const dir = dataDir ?? (await mkdtemp(path.join(tmpdir(), 'potato-pomodoro-')));
  const clock = { now: startMs };
  const app = await createServer({
    dataDir: dir,
    pomodoro: { now: () => new Date(clock.now), tickMs: 999999 },
  });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const advance = (seconds) => {
    clock.now += seconds * 1000;
  };
  const createTodo = async (fields) => {
    const result = await call('POST', '/todos', { deadline: '2026-05-20', ...fields });
    assert.equal(result.status, 201, JSON.stringify(result.body).slice(0, 300));
    return result.body.item;
  };
  const getTodo = async (id) => (await call('GET', `/todos/${id}`)).body.item;
  return { app, info, call, clock, advance, createTodo, getTodo, dataDir: dir };
}

test('时间归属：专注 60 秒 → 待办自己 +60，全部祖先的 spentSec 都 +60，无关/已完成不变', async () => {
  const ctx = await startPomodoro();
  try {
    const listed = await ctx.call('GET', '/modules');
    const descriptor = listed.body.items.find((item) => item.id === 'pomodoro');
    assert.ok(descriptor, 'pomodoro 模块要出现在 /modules 里');
    assert.equal(descriptor.order, 22, 'order 22（紧挨 calendar 10 之后，早于 weekly/sync/ai）');
    assert.ok(descriptor.collections.includes('pomodoroSessions'));
    assert.equal(ctx.app.store.pomodoroSessions.filePath.endsWith('pomodoro-sessions.json'), true);

    const root = await ctx.createTodo({ title: '期末复习' });
    const child = await ctx.createTodo({ title: '第一章', parentId: root.id });
    const grand = await ctx.createTodo({ title: '看例题', parentId: child.id });
    const unrelated = await ctx.createTodo({ title: '交实验报告' });
    const done = await ctx.createTodo({ title: '已经做完的事', completed: true });
    assert.equal(grand.spentSelfSec, 0, '新建待办默认 0');
    assert.equal(grand.spentSec, 0);

    const readonly = await ctx.call('PATCH', `/todos/${grand.id}`, { spentSelfSec: 999 });
    assert.equal(readonly.status, 400, 'spentSelfSec 只读，客户端不能直接改');
    assert.equal(readonly.body.error.details.code, 'READONLY_FIELD');

    const started = await ctx.call('POST', '/pomodoro/start', { taskId: grand.id, studyMin: 1, breakMin: 1 });
    assert.equal(started.status, 200, JSON.stringify(started.body).slice(0, 300));
    assert.equal(started.body.status.phase, 'study');
    assert.equal(started.body.status.taskId, grand.id);

    // 专注 20 秒后查 status：**还没结束**，但待办上应该已经能看到这 20 秒
    ctx.advance(20);
    const mid = await ctx.call('GET', '/pomodoro/status');
    assert.equal(mid.body.phase, 'study', '20 秒还没到 1 分钟，阶段不应切换');
    assert.equal(mid.body.today.studySec, 20, '进行中的阶段也要算进今日统计（账本还没记，但时间已经发生）');
    assert.equal((await ctx.getTodo(grand.id)).spentSelfSec, 20, '专注期间实时累计，不等阶段结束');
    assert.equal((await ctx.getTodo(root.id)).spentSec, 20, '祖先的派生值也要实时看到');

    // 再专注 40 秒（合计 60）后查 status：服务端对账 → 记 study 会话 → 自动进入休息
    ctx.advance(40);
    const status = await ctx.call('GET', '/pomodoro/status');
    assert.equal(status.body.phase, 'break');
    assert.equal(status.body.round, 1);

    const grandAfter = await ctx.getTodo(grand.id);
    const childAfter = await ctx.getTodo(child.id);
    const rootAfter = await ctx.getTodo(root.id);
    assert.equal(grandAfter.spentSelfSec, 60, '只把秒数写进当前待办自己');
    assert.equal(grandAfter.spentSec, 60);
    assert.equal(childAfter.spentSelfSec, 0, '祖先不直接写 spentSelfSec');
    assert.equal(childAfter.spentSec, 60, '父级派生值要包含子任务');
    assert.equal(rootAfter.spentSelfSec, 0);
    assert.equal(rootAfter.spentSec, 60, '祖父级也要包含孙辈（参考实现只加一层，这里刻意修正）');

    const unrelatedAfter = await ctx.getTodo(unrelated.id);
    assert.equal(unrelatedAfter.spentSelfSec, 0);
    assert.equal(unrelatedAfter.spentSec, 0);

    // 已完成待办即使被关联也不再累计
    await ctx.call('POST', '/pomodoro/stop');
    const doneStart = await ctx.call('POST', '/pomodoro/start', { taskId: done.id, studyMin: 1 });
    assert.equal(doneStart.status, 200);
    ctx.advance(60);
    await ctx.call('GET', '/pomodoro/status');
    const doneAfter = await ctx.getTodo(done.id);
    assert.equal(doneAfter.spentSelfSec, 0, '已完成的任务不再累计专注时长');
    assert.equal(doneAfter.spentSec, 0);
  } finally {
    await ctx.app.close();
  }
});

test('会话中切换任务：切换前的秒数留在旧任务，切换后的秒数记到新任务', async () => {
  const ctx = await startPomodoro();
  try {
    const first = await ctx.createTodo({ title: '先做的任务' });
    const second = await ctx.createTodo({ title: '后做的任务' });
    await ctx.call('POST', '/pomodoro/start', { taskId: first.id, studyMin: 1 });
    ctx.advance(20);
    await ctx.call('GET', '/pomodoro/status');
    assert.equal((await ctx.getTodo(first.id)).spentSelfSec, 20);

    await ctx.call('POST', '/pomodoro/setTask', { taskId: second.id });
    ctx.advance(20);
    await ctx.call('GET', '/pomodoro/status');
    assert.equal((await ctx.getTodo(first.id)).spentSelfSec, 20, '切换前的 20 秒不能被新任务抢走');
    assert.equal((await ctx.getTodo(second.id)).spentSelfSec, 20, '切换后的 20 秒记到新任务');
    assert.equal((await ctx.call('GET', '/pomodoro/status')).body.taskId, second.id);
  } finally {
    await ctx.app.close();
  }
});

test('关联待办被删除：状态里清掉 taskId，GET /status 不崩', async () => {
  const ctx = await startPomodoro();
  try {
    const task = await ctx.createTodo({ title: '会被删掉的任务' });
    await ctx.call('POST', '/pomodoro/start', { taskId: task.id, studyMin: 1 });
    ctx.advance(5);
    const removed = await ctx.call('DELETE', `/todos/${task.id}`);
    assert.equal(removed.status, 200);

    const status = await ctx.call('GET', '/pomodoro/status');
    assert.equal(status.status, 200, '定时器/对账不能因为任务被删而崩');
    assert.equal(status.body.taskId, null, '状态里要如实清掉已删除的 taskId');
    assert.equal(status.body.taskTitle, null);
    assert.equal(status.body.phase, 'study', '任务删了，计时本身继续（用户还可以停止或换任务）');
  } finally {
    await ctx.app.close();
  }
});

test('会话账本：study→break 记 completed:true；skip 记 false；stop 记部分时长', async () => {
  const ctx = await startPomodoro();
  try {
    await ctx.call('POST', '/pomodoro/start', { studyMin: 1, breakMin: 1 });
    ctx.advance(10);
    const skipped = await ctx.call('POST', '/pomodoro/skip');
    assert.equal(skipped.status, 200);
    assert.equal(skipped.body.status.phase, 'break');

    // 跳过休息：break 也记一条部分时长（0 秒也算一次阶段结束）
    ctx.advance(1);
    await ctx.call('POST', '/pomodoro/skip');
    ctx.advance(59);
    await ctx.call('GET', '/pomodoro/status');
    ctx.advance(5);
    await ctx.call('POST', '/pomodoro/stop');

    const sessions = await ctx.call('GET', '/pomodoro/sessions');
    assert.equal(sessions.status, 200);
    assert.equal(sessions.body.count, 4, JSON.stringify(sessions.body.items));
    const byKind = sessions.body.items.map((item) => [item.kind, item.completed, item.actualSec]);
    assert.deepEqual(byKind, [
      ['break', false, 4],
      ['study', true, 60],
      ['break', false, 1],
      ['study', false, 10],
    ], '按结束时间倒序：stop 的休息、完整专注、跳过的休息、跳过的专注');

    const first = sessions.body.items[0];
    assert.equal(first.day, todayKey(new Date(ctx.clock.now)), 'day 是本地日期键');
    assert.ok(first.id);
    assert.equal(first.taskTitle, null, '没有关联待办时 taskTitle 是 null');
  } finally {
    await ctx.app.close();
  }
});

test('接口：六个 POST 的正常与 400/409；GET /status 的 daily 是近 7 天形状', async () => {
  const ctx = await startPomodoro();
  try {
    const idle = await ctx.call('GET', '/pomodoro/status');
    assert.equal(idle.status, 200);
    assert.equal(idle.body.daily.length, 7);
    assert.deepEqual(Object.keys(idle.body.daily[0]).sort(), ['day', 'sessions', 'studySec']);
    assert.equal(idle.body.daily.at(-1).day, todayKey(new Date(ctx.clock.now)), '最后一天是今天');

    const pauseIdle = await ctx.call('POST', '/pomodoro/pause');
    assert.equal(pauseIdle.status, 400);
    assert.match(pauseIdle.body.error.message, /idle/);
    assert.equal(pauseIdle.body.error.details.phase, 'idle');

    const resumeIdle = await ctx.call('POST', '/pomodoro/resume');
    assert.equal(resumeIdle.status, 400);
    assert.match(resumeIdle.body.error.message, /idle/);

    const skipIdle = await ctx.call('POST', '/pomodoro/skip');
    assert.equal(skipIdle.status, 400);

    const stoppedIdle = await ctx.call('POST', '/pomodoro/stop');
    assert.equal(stoppedIdle.status, 200);
    assert.equal(stoppedIdle.body.phase, 'idle');

    const selected = await ctx.createTodo({ title: '先选好再开始' });
    const picked = await ctx.call('POST', '/pomodoro/setTask', { taskId: selected.id });
    assert.equal(picked.status, 200);
    const started = await ctx.call('POST', '/pomodoro/start', { studyMin: 1 });
    assert.equal(started.status, 200);
    assert.equal(started.body.status.phase, 'study');
    assert.equal(started.body.status.taskId, selected.id, 'start 省略 taskId 时沿用之前选好的待办');

    const conflict = await ctx.call('POST', '/pomodoro/start', { studyMin: 1 });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.details.status.phase, 'study', '409 要带当前状态');
    assert.equal(conflict.body.error.details.status.running, true);

    const pauseRunning = await ctx.call('POST', '/pomodoro/pause');
    assert.equal(pauseRunning.status, 200);
    const pauseAgain = await ctx.call('POST', '/pomodoro/pause');
    assert.equal(pauseAgain.status, 400, '已经暂停就不能再暂停');
    const resumePaused = await ctx.call('POST', '/pomodoro/resume');
    assert.equal(resumePaused.status, 200);
    const resumeRunning = await ctx.call('POST', '/pomodoro/resume');
    assert.equal(resumeRunning.status, 400, '已经在跑就不能再继续');

    const badTask = await ctx.call('POST', '/pomodoro/setTask', { taskId: 'no-such-task' });
    assert.equal(badTask.status, 400);
    assert.equal(badTask.body.error.details.code, 'TASK_NOT_FOUND');
    const clearTask = await ctx.call('POST', '/pomodoro/setTask', { taskId: null });
    assert.equal(clearTask.status, 200);
    assert.equal(clearTask.body.status.taskId, null);

    const badConfig = await ctx.call('POST', '/pomodoro/config', { studyMin: 0 });
    assert.equal(badConfig.status, 400);
    const config = await ctx.call('POST', '/pomodoro/config', { studyMin: 2, breakMin: 1, autoStartNext: false, sound: false });
    assert.equal(config.status, 200);
    assert.equal(config.body.status.config.studyMin, 2);
    assert.equal(config.body.status.config.sound, false);

    const badDate = await ctx.call('GET', '/pomodoro/sessions?from=2026-13-01');
    assert.equal(badDate.status, 400);
    const badRange = await ctx.call('GET', '/pomodoro/sessions?from=2026-05-10&to=2026-05-01');
    assert.equal(badRange.status, 400);
  } finally {
    await ctx.app.close();
  }
});

test('WS：阶段结束时广播一次 pomodoro / phase-end（桌面与手机都靠它提醒）', async () => {
  const ctx = await startPomodoro();
  const ws = await connectWs({ port: ctx.info.port });
  try {
    const started = await ctx.call('POST', '/pomodoro/start', { studyMin: 1, breakMin: 1 });
    assert.equal(started.status, 200);
    ctx.advance(60);
    const status = await ctx.call('GET', '/pomodoro/status');
    assert.equal(status.body.phase, 'break');

    const message = await ws.waitFor((item) => item.type === 'pomodoro', 3000);
    assert.deepEqual(message.payload, {
      kind: 'phase-end',
      phase: 'study',
      next: 'break',
      taskId: null,
      round: 1,
    });
    // 只广播一次：再等一小会儿，数一下 pomodoro 类型的事件
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(ws.messages.filter((item) => item.type === 'pomodoro').length, 1);
  } finally {
    ws.close();
    await ctx.app.close();
  }
});

test('账本上限：2001 条旧记录 + 1 条新会话 → 只留最近 2000 条（丢最旧）', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-pomodoro-cap-'));
  await mkdir(dataDir, { recursive: true });
  const base = Date.UTC(2020, 0, 1);
  const items = Array.from({ length: 2001 }, (_, index) => {
    // 每条 createdAt 唯一：Collection.all() 按它排序，"丢最旧"才是确定的
    const stamp = new Date(base + index * 1000).toISOString();
    return {
      id: `old-${String(index).padStart(4, '0')}`,
      kind: 'study',
      taskId: null,
      taskTitle: null,
      startedAt: stamp,
      endedAt: new Date(base + index * 1000 + 500).toISOString(),
      plannedSec: 30,
      actualSec: 30,
      completed: true,
      day: '2020-01-01',
      createdAt: stamp,
      updatedAt: stamp,
    };
  });
  await writeFile(path.join(dataDir, 'pomodoro-sessions.json'), JSON.stringify({ schemaVersion: 1, items }), 'utf8');

  const ctx = await startPomodoro({ dataDir });
  try {
    assert.equal(ctx.app.store.pomodoroSessions.all().length, 2000, '启动时就把超限的历史裁到 2000');
    await ctx.call('POST', '/pomodoro/start', { studyMin: 1 });
    ctx.advance(60);
    await ctx.call('GET', '/pomodoro/status');
    const remaining = ctx.app.store.pomodoroSessions.all();
    assert.equal(remaining.length, 2000);
    assert.equal(remaining.some((item) => item.id === 'old-0000'), false, '最旧的两条被丢掉');
    assert.equal(remaining.some((item) => item.id === 'old-0001'), false);
    assert.equal(remaining.some((item) => item.id === 'old-2000'), true, '最新的旧记录保留');
    assert.equal(remaining.some((item) => item.kind === 'study' && item.completed === true && item.actualSec === 60), true);
  } finally {
    await ctx.app.close();
  }
});

test('AI 集成：只读查询与开始计时都可用；周报能读到本周专注秒数', async () => {
  const ctx = await startPomodoro();
  try {
    await ctx.call('POST', '/pomodoro/start', { studyMin: 1 });
    ctx.advance(60);
    await ctx.call('GET', '/pomodoro/status');

    const query = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'query', target: 'pomodoro', filters: { range: 'today' } },
    });
    assert.equal(query.status, 200, JSON.stringify(query.body).slice(0, 300));
    assert.equal(query.body.summary.studySec, 60);
    assert.equal(query.body.summary.completedSessions, 1);
    assert.equal(query.body.summary.current.phase, 'break');

    // 写入口已经打开：AI 的命令草稿能真的开始计时（manual 确认后 / auto 直接执行）
    const write = await ctx.call('POST', '/commands/execute', {
      draft: { ok: true, action: 'create', target: 'pomodoro', fields: { studyMin: 1 }, explain: '开始一个 1 分钟的番茄钟' },
    });
    assert.equal(write.status, 200, JSON.stringify(write.body).slice(0, 300));
    assert.equal(write.body.phase, 'study');
    assert.ok(write.body.endsAt);

    const today = todayKey(new Date(ctx.clock.now));
    const weekly = await ctx.call('GET', `/weekly/report?from=${today}&to=${today}`);
    assert.equal(weekly.status, 200);
    assert.ok(weekly.body.stats.pomodoro, '周报 stats 要有 pomodoro 来源');
    assert.equal(weekly.body.stats.pomodoro.studySec, 60);
    assert.equal(weekly.body.stats.pomodoro.completedSessions, 1);
    assert.equal(weekly.body.stats.pomodoro.daily.length, 1, '区间只有今天，按天分布零填充成 1 天');
    assert.equal(weekly.body.stats.pomodoro.daily[0].studySec, 60);

    // 没配 AI 时周报降级为规则小结，但番茄钟的 60 秒要如实写进去（不再说"没有学习时长"）
    const generated = await ctx.call('POST', '/weekly/report/generate', { from: today, to: today });
    assert.equal(generated.status, 200);
    assert.equal(generated.body.fallback, true);
    assert.match(generated.body.report, /专注\s*1\s*分钟/, generated.body.report);
  } finally {
    await ctx.app.close();
  }
});
