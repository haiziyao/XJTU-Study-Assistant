/**
 * 番茄钟状态机的纯函数测试（注入假时钟，**不等待真实时间**）。
 *
 * 覆盖工单里最容易错的三类时间边界：
 *   1. start → pause → resume → skip → stop 的 remainingSec / round；
 *   2. 到点自动切换（study → break，round +1）；
 *   3. 睡过头连跨多个阶段（45 → 15 → 45 → 15 的链式补账）。
 *
 * 这些用例不碰文件、不碰 HTTP，失败时能立刻定位到 state.js 的哪一个迁移。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createIdleState,
  coreStatus,
  finishPhase,
  pauseState,
  reconcileState,
  remainingSeconds,
  resumeState,
  startState,
  stopState,
  updateConfigState,
} from '../src/modules/pomodoro/state.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const at = (seconds) => new Date(T0 + seconds * 1000);

test('状态机：start → pause → resume → skip → stop 的剩余时间与番茄数', () => {
  let state = createIdleState();
  assert.equal(coreStatus(state, at(0)).remainingSec, 45 * 60);
  assert.equal(state.phase, 'idle');

  state = startState(state, { now: at(0) });
  assert.equal(state.phase, 'study');
  assert.equal(state.running, true);
  assert.equal(remainingSeconds(state, at(0)), 45 * 60);
  assert.equal(state.round, 0);

  state = pauseState(state, { now: at(600) });
  assert.equal(state.running, false);
  assert.equal(state.endsAt, null);
  assert.equal(remainingSeconds(state, at(600)), 35 * 60, '暂停后剩余时间冻结（已专注 10 分钟）');

  // 暂停期间过去了 50 分钟：继续之后不能把这 50 分钟算进专注
  state = resumeState(state, { now: at(3600) });
  assert.equal(state.running, true);
  assert.equal(remainingSeconds(state, at(3600)), 35 * 60, '继续后从暂停时剩余的 35 分钟接着走');
  assert.equal(Date.parse(state.endsAt), T0 + (3600 + 35 * 60) * 1000);

  // 继续 60 秒后跳过：实际专注 10 + 1 = 11 分钟，但**不算完整番茄**
  const skipped = finishPhase(state, { now: at(3660), completed: false });
  assert.equal(skipped.session.kind, 'study');
  assert.equal(skipped.session.completed, false);
  assert.equal(skipped.session.actualSec, 11 * 60);
  assert.equal(skipped.state.phase, 'break');
  assert.equal(skipped.state.round, 0, '跳过不是完整番茄');
  assert.equal(remainingSeconds(skipped.state, at(3660)), 15 * 60);

  const stopped = stopState(skipped.state, { now: at(3670) });
  assert.equal(stopped.session.kind, 'break');
  assert.equal(stopped.session.completed, false);
  assert.equal(stopped.session.actualSec, 10);
  assert.equal(stopped.state.phase, 'idle');
  assert.equal(stopped.state.running, false);
  assert.equal(stopped.state.round, 0);
  assert.equal(coreStatus(stopped.state, at(3670)).remainingSec, 45 * 60, '回到 idle 后显示下一次专注的初始值');
});

test('状态机：到点自动切换（study → break，round +1）', () => {
  let state = startState(createIdleState(), { now: at(0), studyMin: 45, breakMin: 15 });
  const result = reconcileState(state, at(45 * 60));
  state = result.state;
  assert.equal(result.ended.length, 1);
  assert.equal(result.ended[0].kind, 'study');
  assert.equal(result.ended[0].completed, true);
  assert.equal(result.ended[0].actualSec, 45 * 60);
  assert.equal(state.phase, 'break');
  assert.equal(state.running, true);
  assert.equal(state.round, 1);
  assert.equal(remainingSeconds(state, at(45 * 60)), 15 * 60);
});

test('状态机：睡过头 110 分钟 → 连跨 3 个阶段（专注/休息/专注），一分钟不丢', () => {
  let state = startState(createIdleState(), { now: at(0), studyMin: 45, breakMin: 15 });
  const result = reconcileState(state, at(110 * 60));
  state = result.state;

  assert.equal(result.ended.length, 3, '45 分专注 → 15 分休息 → 45 分专注 都该按原定 endsAt 结算');
  assert.deepEqual(
    result.ended.map((item) => [item.kind, item.completed, item.actualSec]),
    [
      ['study', true, 45 * 60],
      ['break', true, 15 * 60],
      ['study', true, 45 * 60],
    ],
  );
  assert.equal(result.ended[0].endedAt, at(45 * 60).toISOString(), '补记的结束时刻是原定 endsAt，不是醒来时刻');
  assert.equal(result.ended[1].startedAt, at(45 * 60).toISOString(), '下一阶段从上一阶段的 endsAt 开始');
  assert.equal(state.phase, 'break');
  assert.equal(state.round, 2);
  // 110 分钟时第三次专注在 105 分钟结束，休息已经走了 5 分钟
  assert.equal(remainingSeconds(state, at(110 * 60)), 10 * 60);
});

test('状态机：longBreakEvery 打开时长休息生效（默认 0 = 关闭）', () => {
  let state = createIdleState({ studyMin: 1, breakMin: 1, longBreakEvery: 2, longBreakMin: 20 });
  state = startState(state, { now: at(0) });
  state = reconcileState(state, at(60)).state; // 第 1 个番茄 -> 普通休息 1 分钟
  assert.equal(remainingSeconds(state, at(60)), 60);
  state = reconcileState(state, at(120)).state; // 休息结束 -> 第 2 个专注
  state = reconcileState(state, at(180)).state; // 第 2 个番茄 -> 长休息 20 分钟
  assert.equal(state.round, 2);
  assert.equal(remainingSeconds(state, at(180)), 20 * 60, '每 2 个番茄后使用 longBreakMin');
});

test('状态机：autoStartNext=false 时到点只停在下一阶段的暂停态', () => {
  let state = startState(createIdleState(), { now: at(0), studyMin: 1, breakMin: 1 });
  state = updateConfigState(state, { autoStartNext: false });
  const result = reconcileState(state, at(60));
  state = result.state;
  assert.equal(result.ended.length, 1);
  assert.equal(state.phase, 'break');
  assert.equal(state.running, false);
  assert.equal(remainingSeconds(state, at(600)), 60, '暂停态不随真实时间流逝');
});

test('状态机：未开始就 pause / resume 是 400；已在跑再 start 是 409 并带当前状态', () => {
  const idle = createIdleState();
  assert.throws(() => pauseState(idle, { now: at(0) }), (error) => error.status === 400 && /idle/.test(error.message));
  assert.throws(() => resumeState(idle, { now: at(0) }), (error) => error.status === 400 && /idle/.test(error.message));

  const running = startState(idle, { now: at(0) });
  assert.throws(
    () => startState(running, { now: at(1) }),
    (error) => error.status === 409 && error.details.status.phase === 'study' && error.details.status.running === true,
  );
});
