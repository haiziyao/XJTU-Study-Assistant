/**
 * 「AI 能控制番茄钟」的端到端测试：真起后端、假时钟、零真实外网。
 *
 * 盯住的是用户真机上那句「帮我重开一下番茄钟，一轮后我去吃饭」：
 *   - 命令层 create / update / delete 真的能开始、重开、暂停、继续、跳过、停止、换待办；
 *   - 重开**先记账再开新一轮**（旧阶段的实际秒数不能凭空消失）；
 *   - 未开始时 pause/resume/skip 必须 400（不能假装暂停成功），idle 的 stop 是成功 no-op；
 *   - AI 链路：auto 档真的落库、manual 档只出确认卡不落库；
 *   - 提示词写清能做什么，并且不再出现"没有按钮 / 没有写入口"这类过时说法。
 *
 * 假时钟通过 `createServer({ pomodoro: { now } })` 注入：45 分钟 / 暂停 / 跳过都能在毫秒内
 * 走完，不靠 sleep；AI 上游用本地 mock（test/helpers/ai-mock.js），不碰外网。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { startMockAi } from './helpers/ai-mock.js';
import pomodoroModule from '../src/modules/pomodoro/module.js';

const KEY = 'sk-test-pomodoro-ai-control';
/** 本地时间基准：早上 8 点，避免测试跑在午夜附近时 endsAt 的 HH:MM 断言抖动。 */
const START = new Date(2026, 4, 6, 8, 0, 0).getTime();

async function startApp({ startMs = START, ai } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-pomo-ai-control-'));
  const clock = { now: startMs };
  const app = await createServer({
    dataDir,
    ...(ai ? { ai } : {}),
    // tickMs 调到极大：所有到点结算都靠显式 GET /status / 命令触发，测试结果不受定时器抖动影响
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
  /** 发一条 pomodoro 指令草稿（等价于 AI / 本地规则交给命令层执行的那份对象）。 */
  const command = (action, fields, { dryRun = false } = {}) =>
    call('POST', '/commands/execute', {
      draft: { ok: true, action, target: 'pomodoro', fields },
      ...(dryRun ? { dryRun: true } : {}),
    });
  const advance = (seconds) => {
    clock.now += seconds * 1000;
  };
  const createTodo = async (title) => {
    const result = await call('POST', '/todos', { title, deadline: '2026-05-20' });
    assert.equal(result.status, 201, JSON.stringify(result.body).slice(0, 300));
    return result.body.item;
  };
  return { app, info, call, command, clock, advance, createTodo, dataDir };
}

/** 模型输出一个 ```command 草稿块。 */
const fenced = (draft) => `\`\`\`command\n${JSON.stringify(draft)}\n\`\`\``;

const restartDraft = {
  ok: true,
  action: 'create',
  target: 'pomodoro',
  fields: { studyMin: 1 },
  explain: '重开一个 1 分钟的番茄钟（确认后立刻开始计时）',
};

test('create 在 idle：直接进入 study，remainingSec = studyMin * 60，回执带 phase/endsAt/taskTitle/round', async () => {
  const ctx = await startApp();
  try {
    const created = await ctx.command('create', { studyMin: 45 });
    assert.equal(created.status, 200, JSON.stringify(created.body).slice(0, 300));
    assert.equal(created.body.phase, 'study');
    assert.equal(created.body.running, true);
    assert.equal(created.body.remainingSec, 45 * 60);
    assert.equal(created.body.round, 0);
    assert.equal(created.body.taskTitle, null);
    assert.ok(created.body.endsAt, '回执里要有 endsAt');
    assert.equal(created.body.endsAt, new Date(ctx.clock.now + 45 * 60 * 1000).toISOString());
    assert.match(created.body.explain, /已开始 45 分钟专注/);
    assert.match(created.body.explain, /约 08:45 结束/);

    // 权威状态（不是只看回执）：GET /pomodoro/status 也已经是 study
    const status = await ctx.call('GET', '/pomodoro/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.phase, 'study');
    assert.equal(status.body.remainingSec, 45 * 60);
    assert.equal(status.body.totalSec, 45 * 60);
  } finally {
    await ctx.app.close();
  }
});

test('正在跑时 create = 重开：旧阶段先按实际时长记账，再开新一轮；关联待办沿用', async () => {
  const ctx = await startApp();
  try {
    const todo = await ctx.createTodo('高等数学');
    const first = await ctx.command('create', { taskId: todo.id, studyMin: 1 });
    assert.equal(first.status, 200);
    assert.equal(first.body.taskId, todo.id);

    ctx.advance(10);
    // 10 秒后重开（没有重新指定 taskId：应该沿用当前关联的待办）
    const restarted = await ctx.command('create', { studyMin: 2 });
    assert.equal(restarted.status, 200, JSON.stringify(restarted.body).slice(0, 300));
    assert.equal(restarted.body.phase, 'study');
    assert.equal(restarted.body.remainingSec, 2 * 60);
    assert.equal(restarted.body.taskTitle, '高等数学');
    assert.equal(restarted.body.endsAt, new Date(ctx.clock.now + 2 * 60 * 1000).toISOString());
    assert.match(restarted.body.explain, /已重开 2 分钟专注/);
    assert.match(restarted.body.explain, /上一段已按实际时长记入账本/);

    // 账本多了一条：旧阶段的实际 10 秒，completed:false（重开不是完整番茄）
    const sessions = await ctx.call('GET', '/pomodoro/sessions');
    assert.equal(sessions.body.count, 1, '重开必须先给旧阶段记账，再开始新的');
    assert.equal(sessions.body.items[0].kind, 'study');
    assert.equal(sessions.body.items[0].actualSec, 10);
    assert.equal(sessions.body.items[0].completed, false);
    assert.equal(sessions.body.items[0].taskTitle, '高等数学');

    // 新阶段从 0 开始计：round 归零，剩余是新的 2 分钟
    const status = await ctx.call('GET', '/pomodoro/status');
    assert.equal(status.body.phase, 'study');
    assert.equal(status.body.remainingSec, 2 * 60);
    assert.equal(status.body.round, 0);
  } finally {
    await ctx.app.close();
  }
});

test('create 的待办/分钟数校验发生在 stop 之前：参数不合法时不会把正在跑的番茄停掉', async () => {
  const ctx = await startApp();
  try {
    await ctx.command('create', { studyMin: 1 });
    ctx.advance(10);
    const before = await ctx.call('GET', '/pomodoro/status');

    const badTask = await ctx.command('create', { taskId: 'no-such-task', studyMin: 1 });
    assert.equal(badTask.status, 400);
    assert.equal(badTask.body.error.details.code, 'TASK_NOT_FOUND');

    const badMinutes = await ctx.command('create', { studyMin: 0 });
    assert.equal(badMinutes.status, 400);

    const after = await ctx.call('GET', '/pomodoro/status');
    assert.equal(after.body.phase, 'study', '校验失败不能把当前番茄停掉');
    assert.equal(after.body.endsAt, before.body.endsAt);
    assert.equal(after.body.remainingSec, before.body.remainingSec);
    const sessions = await ctx.call('GET', '/pomodoro/sessions');
    assert.equal(sessions.body.count, 0, '没有重开，就不该多出账本记录');
  } finally {
    await ctx.app.close();
  }
});

test('update 控制：pause 停表、resume 重算 endsAt、skip 记账进下一阶段、stop 回 idle', async () => {
  const ctx = await startApp();
  try {
    await ctx.command('create', { studyMin: 1, breakMin: 1 });
    ctx.advance(20);

    const paused = await ctx.command('update', { op: 'pause' });
    assert.equal(paused.status, 200, JSON.stringify(paused.body).slice(0, 300));
    assert.equal(paused.body.op, 'pause');
    assert.equal(paused.body.phase, 'study');
    assert.equal(paused.body.running, false);
    assert.equal(paused.body.remainingSec, 40);
    assert.match(paused.body.explain, /已暂停专注/);

    // 暂停期间时间流逝，剩余时间不减少（endsAt 已经清掉）
    ctx.advance(30);
    assert.equal((await ctx.call('GET', '/pomodoro/status')).body.remainingSec, 40);

    const resumed = await ctx.command('update', { op: 'resume' });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.running, true);
    assert.equal(resumed.body.remainingSec, 40);
    assert.equal(resumed.body.endsAt, new Date(ctx.clock.now + 40 * 1000).toISOString(), '继续后从此刻重算 endsAt');

    ctx.advance(10);
    const skipped = await ctx.command('update', { op: 'skip' });
    assert.equal(skipped.status, 200);
    assert.equal(skipped.body.phase, 'break', '跳过专注后进入休息');
    assert.match(skipped.body.explain, /已跳过本轮专注/);

    const afterSkip = await ctx.call('GET', '/pomodoro/sessions');
    assert.equal(afterSkip.body.count, 1);
    assert.equal(afterSkip.body.items[0].kind, 'study');
    assert.equal(afterSkip.body.items[0].actualSec, 30, '跳过的专注按实际 20+10 秒记账');
    assert.equal(afterSkip.body.items[0].completed, false);

    const stopped = await ctx.command('update', { op: 'stop' });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.phase, 'idle');
    assert.equal(stopped.body.running, false);
    assert.equal(stopped.body.remainingSec, 45 * 60, 'idle 时 remainingSec 下一次专注的总时长（回落到设置）');
    assert.match(stopped.body.explain, /已停止本轮休息/);

    const afterStop = await ctx.call('GET', '/pomodoro/sessions');
    assert.equal(afterStop.body.count, 2, '跳过的休息也按实际时长（0 秒）记一条');
    assert.equal((await ctx.call('GET', '/pomodoro/status')).body.phase, 'idle');
  } finally {
    await ctx.app.close();
  }
});

test('未开始时 pause/resume/skip → 400 且带当前状态；idle 的 stop 是成功 no-op；非法 op/多余字段 400', async () => {
  const ctx = await startApp();
  try {
    for (const op of ['pause', 'resume', 'skip']) {
      const result = await ctx.command('update', { op });
      assert.equal(result.status, 400, `${op} 在 idle 必须 400`);
      assert.match(result.body.error.message, /idle/, `${op} 的错误要说清当前是 idle`);
      assert.equal(result.body.error.details.phase, 'idle');
    }

    const stopped = await ctx.command('update', { op: 'stop' });
    assert.equal(stopped.status, 200, 'idle 时停止是成功（目标状态已满足）');
    assert.equal(stopped.body.already, 'idle');
    assert.equal(stopped.body.phase, 'idle');
    assert.match(stopped.body.explain, /空操作|无需停止/);
    assert.equal((await ctx.call('GET', '/pomodoro/sessions')).body.count, 0, 'no-op 不写账本');

    const badOp = await ctx.command('update', { op: 'restart' });
    assert.equal(badOp.status, 400);
    assert.match(badOp.body.error.message, /字段 op 不合法/);
    assert.deepEqual(badOp.body.error.details.allowed, ['pause', 'resume', 'skip', 'stop', 'setTask']);

    const extraField = await ctx.command('update', { op: 'pause', taskId: null });
    assert.equal(extraField.status, 400, 'pause 不接受 taskId：模型想换任务就该用 setTask');
    assert.match(extraField.body.error.message, /不接受字段/);
  } finally {
    await ctx.app.close();
  }
});

test('setTask：不存在的待办 400（说清），存在的待办真的切过去', async () => {
  const ctx = await startApp();
  try {
    const bad = await ctx.command('update', { op: 'setTask', taskId: 'no-such-task' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.details.code, 'TASK_NOT_FOUND');
    assert.match(bad.body.error.message, /不存在/);

    const missing = await ctx.command('update', { op: 'setTask' });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error.message, /setTask 需要 fields.taskId/);

    const todo = await ctx.createTodo('线性代数');
    const switched = await ctx.command('update', { op: 'setTask', taskId: todo.id });
    assert.equal(switched.status, 200);
    assert.equal(switched.body.taskId, todo.id);
    assert.equal(switched.body.taskTitle, '线性代数');
    assert.match(switched.body.explain, /线性代数/);

    const cleared = await ctx.command('update', { op: 'setTask', taskId: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.taskId, null);
    assert.match(cleared.body.explain, /解除关联/);

    // delete 复用 stop：先开起来，再 delete（不应另造第二套语义）
    await ctx.command('create', { studyMin: 1 });
    ctx.advance(5);
    const deleted = await ctx.command('delete', {});
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.phase, 'idle');
    const sessions = await ctx.call('GET', '/pomodoro/sessions');
    assert.equal(sessions.body.count, 1);
    assert.equal(sessions.body.items[0].actualSec, 5);
  } finally {
    await ctx.app.close();
  }
});

test('真实链路 auto 档：说"帮我重开番茄钟" → executed 1 条，GET /pomodoro/status 变 study', async () => {
  const mock = await startMockAi({
    apiKey: KEY,
    replies: [`好，重开。\n${fenced(restartDraft)}`, '已经重开了，1 分钟后这一轮结束。'],
  });
  const ctx = await startApp({ ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    // 先让番茄钟真的在跑，并且已经专注了 10 秒
    const first = await ctx.command('create', { studyMin: 1 });
    assert.equal(first.status, 200);
    ctx.advance(10);
    const before = await ctx.call('GET', '/pomodoro/status');
    assert.equal(before.body.phase, 'study');
    const beforeEndsAt = before.body.endsAt;

    const chat = await ctx.call('POST', '/ai/chat', {
      text: '帮我重开一下番茄钟，一轮后我去吃饭',
      permission: 'auto',
    });
    assert.equal(chat.status, 200, JSON.stringify(chat.body).slice(0, 400));
    assert.equal(chat.body.executed.length, 1, 'auto 档应真的执行唯一那条写草稿');
    assert.equal(chat.body.executed[0].draft.target, 'pomodoro');
    assert.equal(chat.body.executed[0].draft.action, 'create');
    assert.equal(chat.body.executed[0].result.phase, 'study');
    assert.match(chat.body.executed[0].result.explain, /已重开 1 分钟专注/);
    assert.deepEqual(chat.body.drafts, [], '自动执行的草稿不应再留确认卡');
    assert.equal(mock.state.bodies.length, 2, '执行结果要回灌一轮，模型才能说出真的做了什么');

    // 系统提示词里已经写明"可以控制番茄钟"（不再说只能读）
    const systemText = String(
      (mock.state.bodies[0]?.messages ?? []).filter((message) => message.role === 'system').map((message) => message.content).join('\n'),
    );
    assert.match(systemText, /开始\/重开/);
    assert.match(systemText, /暂停/);

    const status = await ctx.call('GET', '/pomodoro/status');
    assert.equal(status.body.phase, 'study');
    assert.notEqual(status.body.endsAt, beforeEndsAt, '重开后是新的一轮，endsAt 必然更新');
    assert.equal(status.body.remainingSec, 60, '新的 1 分钟从头开始');
    const sessions = await ctx.call('GET', '/pomodoro/sessions');
    assert.equal(sessions.body.count, 1, '重开先把旧的 10 秒记进账本');
    assert.equal(sessions.body.items[0].actualSec, 10);
  } finally {
    await ctx.app.close();
    await mock.close();
  }
});

test('真实链路 manual 档："帮我重开番茄钟" 只出确认卡，不落库、不停表', async () => {
  const mock = await startMockAi({
    apiKey: KEY,
    replies: [`要我重开吗？\n${fenced(restartDraft)}`, '（manual 档不该有第二轮）'],
  });
  const ctx = await startApp({ ai: { apiKey: KEY, baseUrl: mock.baseUrl } });
  try {
    await ctx.command('create', { studyMin: 1 });
    ctx.advance(10);
    const before = await ctx.call('GET', '/pomodoro/status');
    assert.equal(before.body.remainingSec, 50);

    const chat = await ctx.call('POST', '/ai/chat', {
      text: '帮我重开一下番茄钟，一轮后我去吃饭',
      permission: 'manual',
    });
    assert.equal(chat.status, 200, JSON.stringify(chat.body).slice(0, 400));
    assert.deepEqual(chat.body.executed, [], 'manual 档一条都不自动执行');
    assert.equal(chat.body.drafts.length, 1, '要留给用户一张确认卡');

    const card = chat.body.drafts[0];
    assert.equal(card.draft.action, 'create');
    assert.equal(card.draft.target, 'pomodoro');
    assert.equal(card.error, null, '预校验应通过');
    assert.equal(card.preview.phase, 'study');
    assert.equal(card.preview.restarted, true, '预览也要体现这是重开');
    assert.match(card.preview.explain, /点确认后立刻开始计时/);
    assert.equal(mock.state.bodies.length, 1, 'manual 档不执行写操作，不需要多回灌一轮');

    // 没点确认 → 计时状态和账本都不变
    const after = await ctx.call('GET', '/pomodoro/status');
    assert.equal(after.body.phase, 'study');
    assert.equal(after.body.endsAt, before.body.endsAt);
    assert.equal(after.body.remainingSec, 50);
    assert.equal((await ctx.call('GET', '/pomodoro/sessions')).body.count, 0);
  } finally {
    await ctx.app.close();
    await mock.close();
  }
});

test('提示词/工具清单：写清开始/暂停/继续与两个草稿示例，不再出现"没有按钮/没有写入口"', () => {
  const prompt = String(pomodoroModule.aiPrompt ?? '');
  assert.match(prompt, /开始\/重开/, '要说清能开始/重开');
  assert.match(prompt, /暂停/);
  assert.match(prompt, /继续/);
  assert.match(prompt, /跳过/);
  assert.match(prompt, /停止/);
  assert.match(prompt, /换关联待办/);
  // 两个草稿示例：开始 45 分钟 / 暂停
  assert.match(prompt, /"action":"create"/);
  assert.match(prompt, /"studyMin":45/);
  assert.match(prompt, /"action":"update"/);
  assert.match(prompt, /"op":"pause"/);
  // 读的口径照旧
  assert.match(prompt, /today \/ week \/ all/);
  assert.match(prompt, /近 7 天/);
  // 过时说法必须消失
  assert.doesNotMatch(prompt, /没有(按钮|写入口|写能力|写通道)/);
  assert.doesNotMatch(prompt, /只能(读|查询)/);
  assert.doesNotMatch(prompt, /写不了|不能(启动|暂停|控制)/);

  const tools = pomodoroModule.aiTools ?? [];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get('pomodoro_status')?.mutates, false, '状态查询仍然只读');
  for (const name of ['pomodoro_start', 'pomodoro_pause', 'pomodoro_resume', 'pomodoro_skip', 'pomodoro_stop', 'pomodoro_set_task']) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} 应该出现在 aiTools 里`);
    assert.equal(tool.mutates, true, `${name} 是写工具`);
    assert.equal(tool.implemented, true);
    assert.equal(tool.path.startsWith('/pomodoro/'), true);
  }
  assert.doesNotMatch(byName.get('pomodoro_status')?.description ?? '', /不能(启动|暂停)/);
});

test('dryRun：手动确认卡的预校验不落库、不停当前番茄（重开预览只算不执行）', async () => {
  const ctx = await startApp();
  try {
    await ctx.command('create', { studyMin: 1 });
    ctx.advance(10);
    const before = await ctx.call('GET', '/pomodoro/status');

    const preview = await ctx.command('create', { studyMin: 2 }, { dryRun: true });
    assert.equal(preview.status, 200, JSON.stringify(preview.body).slice(0, 300));
    assert.equal(preview.body.dryRun, true);
    assert.equal(preview.body.restarted, true);
    assert.equal(preview.body.phase, 'study');
    assert.equal(preview.body.remainingSec, 2 * 60);
    assert.equal(preview.body.planned.action, 'create');

    const after = await ctx.call('GET', '/pomodoro/status');
    assert.equal(after.body.endsAt, before.body.endsAt, '预览不能改正在跑的 endsAt');
    assert.equal(after.body.remainingSec, before.body.remainingSec);
    assert.equal((await ctx.call('GET', '/pomodoro/sessions')).body.count, 0, '预览不写账本');

    // 控制类 dryRun 走的是同一套状态校验：idle 暂停在预览阶段就要 400
    const idleCtx = await startApp();
    try {
      const bad = await idleCtx.command('update', { op: 'pause' }, { dryRun: true });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error.details.phase, 'idle');
    } finally {
      await idleCtx.app.close();
    }
  } finally {
    await ctx.app.close();
  }
});
