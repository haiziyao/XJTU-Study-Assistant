/**
 * AI 定时唤醒（时间 + 提示词）的测试。
 *
 * 分三层，故意的：
 *   1. **纯函数**：`computeNextRun` 直接喂固定的 `now`，把"今天这个点已经过了 / 跨天 / 跨周 /
 *      月末 / 闰日 / once 过期"这些最容易写错的边界一次覆盖，不用等真实时间过去；
 *   2. **调度内核**：`dueTasks` / `markRun` / `tick` 用服务实例直接调（真实存储、真实广播，
 *      但不依赖真实定时器），验证幂等性与"错过太久不补跑"；
 *   3. **HTTP**：CRUD、校验（时间格式 / prompt 超长 / 未知 id）、以及注入 runner 之后
 *      「到点会调用它」和「没注入 runner 也不抛异常」。
 *
 * 之所以强调幂等：定时器每分钟都会问一次"到点了吗"。如果判定不是幂等的，同一次计划就会被
 * 重复执行 —— 用户会收到两条一模一样的提醒，而 token 也真的花了两遍。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { computeNextRun, parseAt, isoWeekday, NO_RUNNER_MESSAGE } from '../src/modules/ai/schedule.js';

/** 本地时间 -> ISO（测试里一律按本地时区写期望值，跟实现口径一致）。 */
const iso = (y, m, d, hh, mm, ss = 0) => new Date(y, m - 1, d, hh, mm, ss, 0).toISOString();

async function startApp(options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-ai-sched-'));
  const app = await createServer({ dataDir, ...options });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
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
    return { status: response.status, body: parsed };
  };
  return { app, info, call, scheduler: app.services.aiScheduler };
}

/* ================================================================== 1. 纯函数 */

test('定时：daily —— 今天这个点没过就是今天，过了就是明天，正好卡点算明天', () => {
  assert.equal(computeNextRun({ at: '08:00', repeat: 'daily' }, new Date(2026, 2, 2, 7, 30)), iso(2026, 3, 2, 8, 0));
  assert.equal(computeNextRun({ at: '08:00', repeat: 'daily' }, new Date(2026, 2, 2, 8, 30)), iso(2026, 3, 3, 8, 0));
  // 严格晚于 now：正好 08:00:00.000 时算明天，否则 markRun 之后同一时刻还会被判成"到点"
  assert.equal(computeNextRun({ at: '08:00', repeat: 'daily' }, new Date(2026, 2, 2, 8, 0, 0)), iso(2026, 3, 3, 8, 0));
  assert.equal(computeNextRun({ at: '23:59', repeat: 'daily' }, new Date(2026, 2, 2, 23, 58)), iso(2026, 3, 2, 23, 59));
});

test('定时：跨天 / 跨月 / 跨年（常规月末与闰日都按本地日历走）', () => {
  // 1/31 23:59:30 -> 次日 00:30（跨月）
  assert.equal(computeNextRun({ at: '00:30', repeat: 'daily' }, new Date(2026, 0, 31, 23, 59, 30)), iso(2026, 2, 1, 0, 30));
  // 平年 2/28 之后是 3/1
  assert.equal(computeNextRun({ at: '08:00', repeat: 'daily' }, new Date(2026, 1, 28, 9, 0)), iso(2026, 3, 1, 8, 0));
  // 闰年 2/28 之后是 2/29（不是 3/1）
  assert.equal(computeNextRun({ at: '08:00', repeat: 'daily' }, new Date(2028, 1, 28, 9, 0)), iso(2028, 2, 29, 8, 0));
  // 闰日之后是 3/1
  assert.equal(computeNextRun({ at: '08:00', repeat: 'daily' }, new Date(2028, 1, 29, 9, 0)), iso(2028, 3, 1, 8, 0));
  // 12/31 -> 次年 1/1（跨年）
  assert.equal(computeNextRun({ at: '07:15', repeat: 'daily' }, new Date(2026, 11, 31, 23, 0)), iso(2027, 1, 1, 7, 15));
});

test('定时：weekly —— 今天命中且没过就是今天，过了就顺延；跨周也对', () => {
  // 2026-03-02 是周一
  assert.equal(isoWeekday(new Date(2026, 2, 2, 12, 0)), 1);
  assert.equal(isoWeekday(new Date(2026, 2, 8, 12, 0)), 7);

  const monday = { at: '08:00', repeat: 'weekly', weekdays: [1] };
  assert.equal(computeNextRun(monday, new Date(2026, 2, 2, 7, 0)), iso(2026, 3, 2, 8, 0));
  // 周一 09:00 已经过了 08:00 -> 下周一（跨周，整整 7 天）
  assert.equal(computeNextRun(monday, new Date(2026, 2, 2, 9, 0)), iso(2026, 3, 9, 8, 0));
  // 多天：周一 09:00 之后的下一次是周四
  assert.equal(computeNextRun({ at: '08:00', repeat: 'weekly', weekdays: [1, 4] }, new Date(2026, 2, 2, 9, 0)), iso(2026, 3, 5, 8, 0));
  // 周四当天没过就是周四；过了就是下周一（跨周回绕）
  const mixed = { at: '08:00', repeat: 'weekly', weekdays: [1, 4] };
  assert.equal(computeNextRun(mixed, new Date(2026, 2, 5, 7, 0)), iso(2026, 3, 5, 8, 0));
  assert.equal(computeNextRun(mixed, new Date(2026, 2, 5, 9, 0)), iso(2026, 3, 9, 8, 0));
  // 只有周日
  assert.equal(computeNextRun({ at: '08:00', repeat: 'weekly', weekdays: [7] }, new Date(2026, 2, 2, 7, 0)), iso(2026, 3, 8, 8, 0));
  // 星期乱序 / 重复会先归一，不影响结果
  assert.equal(
    computeNextRun({ at: '08:00', repeat: 'weekly', weekdays: [4, 1, 4] }, new Date(2026, 2, 2, 9, 0)),
    iso(2026, 3, 5, 8, 0),
  );
  // weekly 没给星期几 = 永远不会响：返回 null（接口层会 400 挡掉，纯函数这里不抛）
  assert.equal(computeNextRun({ at: '08:00', repeat: 'weekly', weekdays: [] }, new Date(2026, 2, 2, 7, 0)), null);
});

test('定时：once —— 绝对时间点过了就是 null；只给 HH:MM 时按"闹钟"直觉顺延到明天', () => {
  const now = new Date(2026, 2, 2, 7, 30);
  assert.equal(computeNextRun({ at: '2026-03-05T14:30', repeat: 'once' }, now), iso(2026, 3, 5, 14, 30));
  assert.equal(computeNextRun({ at: '2026-03-01T14:30', repeat: 'once' }, now), null);
  assert.equal(computeNextRun({ at: '08:00', repeat: 'once' }, now), iso(2026, 3, 2, 8, 0));
  assert.equal(computeNextRun({ at: '08:00', repeat: 'once' }, new Date(2026, 2, 2, 9, 0)), iso(2026, 3, 3, 8, 0));
  // 带时区偏移的 ISO 也认（按那一刻的本地时刻取时间）
  assert.equal(parseAt('2026-03-05T14:30:00+08:00')?.absolute instanceof Date, true);
});

test('定时：纯函数的确定性与容错 —— 同一个 now 结果一样，脏输入返回 null 而不是抛异常', () => {
  const task = { at: '08:00', repeat: 'daily', weekdays: [] };
  const now = new Date(2026, 2, 2, 7, 30);
  const first = computeNextRun(task, now);
  assert.equal(computeNextRun(task, now), first, '同一 (task, now) 必须给出同一个结果（幂等的前提）');
  // 结果只看 at/repeat/weekdays 与 now，**不看** nextRunAt/lastRunAt：
  // 否则"重复调用"会互相影响，到点判定就不再幂等
  assert.equal(computeNextRun({ ...task, nextRunAt: iso(2020, 1, 1, 0, 0) }, now), first);
  assert.equal(computeNextRun({ ...task, lastRunAt: iso(2026, 3, 2, 7, 40) }, now), first);

  for (const bad of [null, {}, { at: null }, { at: '25:00' }, { at: '8:00' }, { at: '08:00:00' }, { at: 'tomorrow' }]) {
    assert.equal(computeNextRun(bad, now), null, `非法输入应返回 null：${JSON.stringify(bad)}`);
  }
  assert.equal(computeNextRun({ at: '08:00', repeat: 'daily' }, new Date('nope')), null);
  // 不认识的 repeat 按 daily 处理（纯函数不抛）
  assert.equal(computeNextRun({ at: '08:00', repeat: 'monthly' }, now), iso(2026, 3, 2, 8, 0));
});

/* ================================================================== 2. 调度内核 */

test('定时：dueTasks 与 markRun —— 到点判定幂等，同一分钟问两次只算一次', async () => {
  const { app, call, scheduler } = await startApp();
  try {
    const created = await call('POST', '/ai/schedules', { prompt: '每天提醒我背单词', at: '08:00', repeat: 'daily' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const task = created.body.schedule;
    assert.equal(task.enabled, true);
    assert.equal(task.lastRunAt, null);
    assert.equal(task.lastError, null);

    const fireAt = new Date(task.nextRunAt);
    // 到点之前不算到点
    assert.deepEqual(scheduler.dueTasks(new Date(fireAt.getTime() - 60_000)), []);
    assert.deepEqual(scheduler.dueTasks(fireAt).map((item) => item.id), [task.id]);

    const marked = await scheduler.markRun(task.id, { ok: true, now: fireAt });
    assert.equal(marked.lastRunAt, fireAt.toISOString());
    assert.equal(marked.lastError, null);
    assert.equal(new Date(marked.nextRunAt).getTime() - fireAt.getTime(), 24 * 60 * 60 * 1000, 'daily 应该推进一天');

    // 幂等：同一时刻、同一分钟（+30s）、以及重复 markRun 都不该再触发
    assert.deepEqual(scheduler.dueTasks(fireAt), []);
    assert.deepEqual(scheduler.dueTasks(new Date(fireAt.getTime() + 30_000)), []);
    await scheduler.markRun(task.id, { ok: true, now: fireAt });
    assert.equal(
      (await call('GET', '/ai/schedules')).body.items[0].nextRunAt,
      marked.nextRunAt,
      '重复 markRun 不能把下一次时间越推越远',
    );

    // 失败记 lastError，成功后清掉
    const failed = await scheduler.markRun(task.id, { ok: false, error: '上游 401', now: new Date(fireAt.getTime() + 86_400_000) });
    assert.equal(failed.lastError, '上游 401');
    const recovered = await scheduler.markRun(task.id, { ok: true, now: new Date(fireAt.getTime() + 2 * 86_400_000) });
    assert.equal(recovered.lastError, null);

    // 未知 id 的 markRun 是 404 语义（路由层直接透传）
    await assert.rejects(() => scheduler.markRun('nope', { ok: true }), (error) => error.status === 404);
  } finally {
    await app.close();
  }
});

test('定时：once 响过就关掉（enabled=false / nextRunAt=null），不会再被扫第二次', async () => {
  const { app, call, scheduler } = await startApp();
  try {
    const future = new Date(Date.now() + 3_600_000);
    const created = await call('POST', '/ai/schedules', {
      prompt: '两小时后提醒我交实验报告',
      at: future.toISOString(),
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const task = created.body.schedule;
    // 只给绝对时间点、没写 repeat -> 默认就是一次性
    assert.equal(task.repeat, 'once');
    assert.equal(task.nextRunAt, future.toISOString());

    const marked = await scheduler.markRun(task.id, { ok: true, now: future });
    assert.equal(marked.enabled, false);
    assert.equal(marked.nextRunAt, null);
    assert.deepEqual(scheduler.dueTasks(new Date(future.getTime() + 60_000)), []);

    // 已经过去的一次性时间点：直接 400，而不是建一个"永远不响"的任务
    const past = await call('POST', '/ai/schedules', { prompt: '昨天的提醒', at: '2020-01-01T08:00' });
    assert.equal(past.status, 400);
    assert.equal(past.body.error.details.field, 'at');
  } finally {
    await app.close();
  }
});

test('定时：到点会调用注入的 runner；runner 抛异常只记 lastError，不炸调度器', async () => {
  const { app, call, scheduler } = await startApp();
  try {
    const okTask = (await call('POST', '/ai/schedules', { prompt: '每周一提醒我预习周四的实验', at: '08:00', repeat: 'weekly', weekdays: [1] })).body.schedule;
    const badTask = (await call('POST', '/ai/schedules', { prompt: '这条会失败', at: '09:00', repeat: 'daily' })).body.schedule;

    const seen = [];
    scheduler.setRunner(async (task, context) => {
      seen.push({ id: task.id, manual: context.manual, prompt: task.prompt, at: context.now.toISOString() });
      if (task.id === badTask.id) throw new Error('上游超时');
      return { ok: true };
    });

    // 把两条都挪到"同一分钟内到点"：真实创建出来的下次时间可能相隔好几天，
    // 而超过 catchUpWindowMs 的任务按设计不补跑（那条规则另有专门用例覆盖）
    const fireAt = new Date(Date.now() + 60_000);
    for (const task of [okTask, badTask]) {
      await app.store.aiSchedules.update(task.id, { nextRunAt: fireAt.toISOString() });
    }

    const executed = await scheduler.tick(new Date(fireAt.getTime() + 1000));
    assert.deepEqual(executed.sort(), [okTask.id, badTask.id].sort());
    assert.equal(seen.length, 2);
    assert.equal(seen.every((item) => item.manual === false), true, '定时触发 manual 必须是 false');
    assert.equal(seen.find((item) => item.id === okTask.id).prompt, '每周一提醒我预习周四的实验');

    // 第二次 tick 不能再触发（幂等）
    assert.deepEqual(await scheduler.tick(new Date(fireAt.getTime() + 30_000)), []);

    const items = (await call('GET', '/ai/schedules')).body.items;
    const okAfter = items.find((item) => item.id === okTask.id);
    const badAfter = items.find((item) => item.id === badTask.id);
    assert.equal(okAfter.lastError, null);
    assert.equal(new Date(okAfter.nextRunAt).getTime() > fireAt.getTime(), true, '成功后计划要推到未来');
    assert.equal(badAfter.lastError, '上游超时');
    assert.equal(new Date(badAfter.nextRunAt).getTime() > fireAt.getTime(), true, '失败也要推进，否则每分钟重试一次');
  } finally {
    await app.close();
  }
});

test('定时：没注入 runner 时到点只记录不执行 —— 不抛异常、也不吃掉这一次', async () => {
  const { app, call, scheduler } = await startApp();
  try {
    const task = (await call('POST', '/ai/schedules', { prompt: '到点但没人接线', at: '08:00', repeat: 'daily' })).body.schedule;
    // 把这次计划挪到"刚刚到点"（正常创建时下次时间总在未来）
    const due = new Date(Date.now() - 5000);
    await app.store.aiSchedules.update(task.id, { nextRunAt: due.toISOString() });

    // AI 模块装配时**已经**把执行器接上了（见 module.js 的 setRunner），
    // 所以这一条要测的"没接线"必须显式摘掉 —— 它验的是内核的降级路径，
    // 不是"生产环境里有没有接线"（那个由下面那条用例负责）。
    scheduler.setRunner(null);
    assert.equal(scheduler.runner, null);
    const executed = await scheduler.tick(new Date());
    assert.deepEqual(executed, [], '没有 runner 就不该有"执行过"的记录');
    // 关键：计划没被推进，接线之后这一次仍然会跑（被空跑悄悄吃掉是最糟的）
    assert.equal((await call('GET', '/ai/schedules')).body.items[0].nextRunAt, due.toISOString());

    // 「现在试一下」在没有 runner 时也要给前端一个可读的结果，而不是 500
    const manual = await call('POST', `/ai/schedules/${task.id}/run`);
    assert.equal(manual.status, 200);
    assert.equal(manual.body.ran, false);
    assert.equal(manual.body.reason, 'no_runner');
    assert.equal(manual.body.error, NO_RUNNER_MESSAGE);
    assert.equal(manual.body.task.lastError, NO_RUNNER_MESSAGE);
    // 什么都没跑，就不能写"上次执行时间"（否则列表会显示"刚刚跑过"，是假信息）
    assert.equal(manual.body.task.lastRunAt, null);
  } finally {
    await app.close();
  }
});

test('定时：AI 模块装配后执行器是接上的 —— 没配密钥时如实记 lastError，不假装跑过', async () => {
  const { app, call, scheduler } = await startApp();
  try {
    assert.equal(typeof scheduler.runner, 'function', 'module.js 应该在装配时 setRunner');
    const task = (await call('POST', '/ai/schedules', { prompt: '到点该唤醒', at: '08:00', repeat: 'daily' })).body.schedule;
    const due = new Date(Date.now() - 5000);
    await app.store.aiSchedules.update(task.id, { nextRunAt: due.toISOString() });

    const executed = await scheduler.tick(new Date());
    assert.deepEqual(executed, [task.id], '到点应该真的执行一次');
    const after = (await call('GET', '/ai/schedules')).body.items[0];
    // 这个测试环境没有配置 AI 密钥：必须把原因写下来，让用户一眼知道"为什么没动静"，
    // 而不是留下一条看起来成功、实际什么都没发生的记录
    assert.match(String(after.lastError ?? ''), /密钥/, `lastError 要说清原因，实际：${after.lastError}`);
    // 计划照常推进：修好配置后明天这个点还会响
    assert.ok(after.nextRunAt && after.nextRunAt !== due.toISOString(), '计划要往后推，不能停在过去');
  } finally {
    await app.close();
  }
});

test('定时：错过太久不补跑（关机一夜后不该在下午突然炸出早上的提醒）', async () => {
  const { app, call, scheduler } = await startApp();
  try {
    const task = (await call('POST', '/ai/schedules', { prompt: '早八提醒', at: '08:00', repeat: 'daily' })).body.schedule;
    const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await app.store.aiSchedules.update(task.id, { nextRunAt: stale.toISOString() });

    let called = 0;
    scheduler.setRunner(async () => {
      called += 1;
      return { ok: true };
    });

    const executed = await scheduler.tick(new Date());
    assert.deepEqual(executed, [], '错过太久不补跑');
    assert.equal(called, 0);
    const after = (await call('GET', '/ai/schedules')).body.items[0];
    assert.equal(new Date(after.nextRunAt).getTime() > Date.now(), true, '计划要推到未来');
    assert.match(after.lastError, /错过/);
  } finally {
    await app.close();
  }
});

test('定时：「现在试一下」在到点前不消耗本次计划，在到点后等于补跑', async () => {
  const { app, call, scheduler } = await startApp();
  try {
    scheduler.setRunner(async () => ({ ok: true }));

    // 1) 计划在未来：手动跑一次只记 lastRunAt，nextRunAt / enabled 原样保留
    const future = (await call('POST', '/ai/schedules', { prompt: '未来的提醒', at: '08:00', repeat: 'daily' })).body.schedule;
    const manual = await call('POST', `/ai/schedules/${future.id}/run`);
    assert.equal(manual.status, 200);
    assert.equal(manual.body.ran, true);
    assert.equal(manual.body.succeeded, true);
    assert.equal(manual.body.task.nextRunAt, future.nextRunAt, '试一下不能把明天的提醒吃掉');
    assert.equal(manual.body.task.enabled, true);
    assert.ok(manual.body.task.lastRunAt);

    // 2) 已经到点：手动跑就等于补跑，顺手把计划推进到未来（否则它会永远停在过去）
    const due = (await call('POST', '/ai/schedules', { prompt: '已经到点的', at: '09:00', repeat: 'daily' })).body.schedule;
    const past = new Date(Date.now() - 60_000).toISOString();
    await app.store.aiSchedules.update(due.id, { nextRunAt: past });
    const late = await call('POST', `/ai/schedules/${due.id}/run`);
    assert.equal(late.body.ran, true);
    assert.equal(new Date(late.body.task.nextRunAt).getTime() > Date.now(), true);
  } finally {
    await app.close();
  }
});

/* ================================================================== 3. HTTP */

test('定时 HTTP：CRUD 全链路 + 改名 / 开关 / 改时间会重算下次时间', async () => {
  const { app, call } = await startApp();
  try {
    assert.deepEqual((await call('GET', '/ai/schedules')).body, { ok: true, count: 0, items: [] });

    const created = await call('POST', '/ai/schedules', {
      prompt: '  每周一 08:00 提醒我预习周四的实验  ',
      at: '08:00',
      repeat: 'weekly',
      weekdays: [1],
      label: '预习提醒',
      conversationId: 'conv-1',
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const task = created.body.schedule;
    assert.equal(task.prompt, '每周一 08:00 提醒我预习周四的实验', '提示词两端空白应去掉');
    assert.equal(task.label, '预习提醒');
    assert.equal(task.repeat, 'weekly');
    assert.deepEqual(task.weekdays, [1]);
    assert.equal(task.conversationId, 'conv-1');
    assert.equal(task.enabled, true);
    assert.equal(task.lastRunAt, null);
    assert.match(task.nextRunAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'nextRunAt 应是 ISO 时间');
    // 落库了（重开一次服务也还在）
    assert.equal((await call('GET', '/ai/schedules')).body.count, 1);

    // 改名 + 关掉
    const renamed = await call('PATCH', `/ai/schedules/${task.id}`, { label: '换了个名字', enabled: false });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.schedule.label, '换了个名字');
    assert.equal(renamed.body.schedule.enabled, false);
    assert.deepEqual(renamed.body.schedule.weekdays, [1], '没传 weekdays 时保持原值');

    // 改时间必须重算 nextRunAt（否则界面显示 21:30、实际还按 08:00 响）
    const moved = await call('PATCH', `/ai/schedules/${task.id}`, { at: '21:30', repeat: 'daily' });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.schedule.repeat, 'daily');
    assert.deepEqual(moved.body.schedule.weekdays, [], '不再是 weekly 就清空星期，免得数据自相矛盾');
    const movedAt = new Date(moved.body.schedule.nextRunAt);
    assert.equal(`${String(movedAt.getHours()).padStart(2, '0')}:${String(movedAt.getMinutes()).padStart(2, '0')}`, '21:30');
    assert.equal(movedAt.getTime() > Date.now(), true);

    // label 省略时从提示词开头取一个，列表不会是空白行
    const noLabel = await call('POST', '/ai/schedules', { prompt: '提醒我交作业', at: '07:00' });
    assert.equal(noLabel.body.schedule.label, '提醒我交作业');
    assert.equal(noLabel.body.schedule.repeat, 'daily', '只给 HH:MM 默认每天');

    // 删除
    const removed = await call('DELETE', `/ai/schedules/${task.id}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.deleted, true);
    assert.equal((await call('GET', '/ai/schedules')).body.count, 1);
  } finally {
    await app.close();
  }
});

test('定时 HTTP：校验 —— 时间格式 / prompt 超长 / 非法枚举 / 未知字段 / 未知 id', async () => {
  const { app, call } = await startApp();
  try {
    const bad = async (body, field) => {
      const result = await call('POST', '/ai/schedules', body);
      assert.equal(result.status, 400, `应 400：${JSON.stringify(body)} -> ${JSON.stringify(result.body)}`);
      if (field) assert.equal(result.body.error.details.field, field);
      return result;
    };

    await bad({ at: '08:00' }, 'prompt'); // 缺 prompt
    await bad({ prompt: 'x' }, 'at'); // 缺 at
    await bad({ prompt: 'x', at: '25:00' }, 'at');
    await bad({ prompt: 'x', at: '8:00' }, 'at');
    await bad({ prompt: 'x', at: '2026/03/05 08:00' }, 'at');
    await bad({ prompt: '', at: '08:00' }, 'prompt');
    await bad({ prompt: 123, at: '08:00' }, 'prompt');
    await bad({ prompt: 'x'.repeat(2001), at: '08:00' }, 'prompt'); // 超长
    await bad({ prompt: 'x', at: '08:00', repeat: 'monthly' }, 'repeat');
    await bad({ prompt: 'x', at: '08:00', repeat: 'weekly' }, 'weekdays'); // weekly 缺星期几
    await bad({ prompt: 'x', at: '08:00', repeat: 'weekly', weekdays: [] }, 'weekdays');
    await bad({ prompt: 'x', at: '08:00', repeat: 'weekly', weekdays: [0] }, 'weekdays');
    await bad({ prompt: 'x', at: '08:00', repeat: 'weekly', weekdays: [8] }, 'weekdays');
    await bad({ prompt: 'x', at: '08:00', repeat: 'weekly', weekdays: '1' }, 'weekdays');
    await bad({ prompt: 'x', at: '08:00', enabled: 'yes' }, 'enabled');
    await bad({ prompt: 'x', at: '08:00', whoops: 1 });
    await bad({ prompt: 'x', at: '08:00', label: 'l'.repeat(121) }, 'label');

    // 2000 字正好可以（边界不能一边倒）
    const ok = await call('POST', '/ai/schedules', { prompt: 'x'.repeat(2000), at: '08:00' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.schedule.prompt.length, 2000);

    // 未知 id：PATCH / DELETE / run 都是 404
    assert.equal((await call('PATCH', '/ai/schedules/nope', { enabled: false })).status, 404);
    assert.equal((await call('DELETE', '/ai/schedules/nope')).status, 404);
    assert.equal((await call('POST', '/ai/schedules/nope/run')).status, 404);
    // PATCH 空体 / 未知字段同样 400
    assert.equal((await call('PATCH', `/ai/schedules/${ok.body.schedule.id}`, {})).status, 400);
    assert.equal((await call('PATCH', `/ai/schedules/${ok.body.schedule.id}`, { promt: 'x' })).status, 400);
    // 一次性任务把时间改到过去 -> 400（而不是变成永远不响）
    assert.equal((await call('PATCH', `/ai/schedules/${ok.body.schedule.id}`, { at: '2020-01-01T08:00', repeat: 'once' })).status, 400);
  } finally {
    await app.close();
  }
});

test('定时 HTTP：注入 runner 后 /run 真的执行，并把任务交给 runner', async () => {
  const { app, call, scheduler } = await startApp();
  try {
    const task = (await call('POST', '/ai/schedules', { prompt: '现在试一下：总结今天的待办', at: '08:00', conversationId: 'conv-9' })).body.schedule;
    const seen = [];
    scheduler.setRunner(async (record, context) => {
      seen.push({ record, context });
      return { ok: true };
    });

    const result = await call('POST', `/ai/schedules/${task.id}/run`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.ran, true);
    assert.equal(result.body.succeeded, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].record.id, task.id);
    assert.equal(seen[0].record.prompt, '现在试一下：总结今天的待办');
    assert.equal(seen[0].record.conversationId, 'conv-9', 'conversationId 要原样交给 runner（结果写进哪个会话）');
    assert.equal(seen[0].context.manual, true);
    assert.ok(seen[0].context.now instanceof Date);

    // runner 返回失败 / 抛异常都要如实反映给前端
    scheduler.setRunner(async () => ({ ok: false, error: '模型没配密钥' }));
    const failed = await call('POST', `/ai/schedules/${task.id}/run`);
    assert.equal(failed.status, 200);
    assert.equal(failed.body.ran, true);
    assert.equal(failed.body.succeeded, false);
    assert.equal(failed.body.error, '模型没配密钥');
    assert.equal(failed.body.task.lastError, '模型没配密钥');

    scheduler.setRunner(async () => {
      throw new Error('上游 502');
    });
    const thrown = await call('POST', `/ai/schedules/${task.id}/run`);
    assert.equal(thrown.status, 200, '执行失败不该变成 HTTP 500');
    assert.equal(thrown.body.succeeded, false);
    assert.equal(thrown.body.task.lastError, '上游 502');

    // setRunner 的类型校验：传错是开发期错误，要立刻炸而不是静默不生效
    assert.throws(() => scheduler.setRunner('not-a-function'), TypeError);
    scheduler.setRunner(null);
    assert.equal(scheduler.runner, null);
  } finally {
    await app.close();
  }
});

test('定时：定时器随模块 start/stop 启停，反复 start 不会叠加，close 后不留悬挂定时器', async () => {
  const { app, scheduler } = await startApp();
  try {
    assert.ok(scheduler.timer, 'listen 之后（模块 start 钩子）应该已经启动');
    const first = scheduler.timer;
    scheduler.start();
    assert.equal(scheduler.timer, first, '反复 start 不能叠加出第二个定时器');
    assert.equal(typeof scheduler.timer.unref, 'function');
  } finally {
    await app.close();
  }
  assert.equal(scheduler.timer, undefined, 'close 之后必须停掉（否则 node --test 退不出去）');

  // 停掉之后再 tick 仍然是安全的（测试与手动调用都会这么干）
  const executed = await scheduler.tick(new Date());
  assert.deepEqual(executed, []);
});
