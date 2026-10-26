/**
 * 成长模块 · 六维状态评分（纯函数测试，搬自 Brain Online test/state.test.js）。
 *
 * 这一层是整个模块的入口：任务表单的难度 / 条数 / 类型都由它推导，
 * 所以公式必须是确定性的。逐值断言而不是“大概在区间里”，是为了让任何人
 * 改动权重时都能立刻看到哪一档读数变了。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readiness,
  sleepFactor,
  capacityMinutes,
  modeOf,
  normalizeEntry,
  interpret,
  MODES,
} from '../src/modules/growth/state.js';

const BASE = { sleepHours: 7.5, sleepQuality: 4, energy: 4, mood: 4, stress: 2, focus: 4, body: 4 };

test('睡眠 7.5 小时满分，超过 9.5 小时开始扣分，0 小时是 0', () => {
  assert.equal(sleepFactor(7.5), 1);
  assert.equal(sleepFactor(0), 0);
  assert.ok(sleepFactor(9) > 0.99);
  assert.ok(sleepFactor(12) < 1);
  assert.ok(sleepFactor(12) >= 0.6);
});

test('就绪度落在 0–100，且整组 1 分 = 0 分、整组 5 分 = 100', () => {
  const worst = readiness({ sleepHours: 0, sleepQuality: 1, energy: 1, mood: 1, stress: 5, focus: 1, body: 1 });
  const best = readiness({ sleepHours: 7.5, sleepQuality: 5, energy: 5, mood: 5, stress: 1, focus: 5, body: 5 });
  assert.equal(worst, 0);
  assert.equal(best, 100);
  for (const score of [worst, best]) {
    assert.ok(score >= 0 && score <= 100);
  }
});

test('单调性：精力、情绪、身体越高分越高', () => {
  const low = readiness({ ...BASE, energy: 2 });
  const high = readiness({ ...BASE, energy: 5 });
  assert.ok(high > low);

  assert.ok(readiness({ ...BASE, mood: 5 }) > readiness({ ...BASE, mood: 2 }));
  assert.ok(readiness({ ...BASE, body: 5 }) > readiness({ ...BASE, body: 2 }));
});

test('压力是反向指标：压力 5 比压力 1 分数更低', () => {
  const relaxed = readiness({ ...BASE, stress: 1 });
  const tense = readiness({ ...BASE, stress: 5 });
  assert.ok(relaxed > tense);
});

test('专注度作为乘数生效：同样精力下专注高者分更高', () => {
  assert.ok(readiness({ ...BASE, focus: 5 }) > readiness({ ...BASE, focus: 1 }));
});

test('模式阈值：70 以上推进、45–70 稳态、45 以下修复', () => {
  assert.equal(modeOf(70).key, 'push');
  assert.equal(modeOf(69.9).key, 'steady');
  assert.equal(modeOf(45).key, 'steady');
  assert.equal(modeOf(44.9).key, 'recover');
  assert.equal(modeOf(0).key, 'recover');
  assert.equal(MODES.push.label, '推进');
});

test('可投入分钟数随就绪度单调上升，且落在 60–300', () => {
  let previous = -1;
  for (let score = 0; score <= 100; score += 5) {
    const minutes = capacityMinutes(score);
    assert.ok(minutes >= 60 && minutes <= 300, `${score} → ${minutes}`);
    assert.ok(minutes > previous);
    previous = minutes;
  }
});

test('录入校验：缺字段/越界/非法日期都要被拒', () => {
  assert.throws(() => normalizeEntry({ ...BASE, energy: 6 }), /精力/);
  assert.throws(() => normalizeEntry({ ...BASE, sleepHours: 20 }), /睡眠时长/);
  assert.throws(() => normalizeEntry({ ...BASE, date: '2026/10/26' }), /YYYY-MM-DD/);
  assert.throws(() => normalizeEntry({ ...BASE, energy: 2.5 }), /整数/);
});

test('录入会顺带算出 score / capacity / mode', () => {
  const entry = normalizeEntry(BASE, { now: new Date(2026, 9, 26, 9, 0, 0) });
  assert.equal(entry.date, '2026-10-26');
  assert.equal(typeof entry.score, 'number');
  assert.ok(entry.capacity >= 60);
  assert.ok(['push', 'steady', 'recover'].includes(entry.mode));
});

test('解读会指出最短板', () => {
  const entry = normalizeEntry({ ...BASE, energy: 1 }, { now: new Date(2026, 9, 26) });
  const lines = interpret(entry, entry.score);
  assert.ok(lines.some((line) => line.includes('最短板')));
});
