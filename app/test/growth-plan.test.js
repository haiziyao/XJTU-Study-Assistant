/**
 * 成长模块 · 动态任务表单生成器（纯函数测试，搬自 Brain Online test/plan.test.js）。
 *
 * 生成器是整个模块最值得单测的一层：预算硬约束、最低配比、同类上限、可复现性
 * 都不能靠“界面看起来还行”来保证。随机只用于同分打散，种子来自输入本身。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { generatePlan, hashSeed, mulberry32, REQUIREMENTS } from '../src/modules/growth/generator.js';
import { CATALOG } from '../src/modules/growth/catalog.js';

test('种子哈希稳定，随机数可复现', () => {
  assert.equal(hashSeed('2026-10-26:78:247:push'), hashSeed('2026-10-26:78:247:push'));
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
});

test('预算硬约束：任何就绪度下，任务总时长都不超过可投入分钟数', () => {
  for (let score = 0; score <= 100; score += 5) {
    for (const capacity of [60, 96, 150, 240, 300]) {
      const plan = generatePlan({
        date: '2026-10-26',
        score,
        capacity,
        mode: score >= 70 ? 'push' : score >= 45 ? 'steady' : 'recover',
      });
      const total = plan.tasks.reduce((sum, task) => sum + task.estimateMin, 0);
      assert.ok(total <= capacity, `score=${score} capacity=${capacity} → ${total}`);
      assert.equal(plan.usedMinutes, total);
    }
  }
});

test('可复现：同样的输入生成同样的表单', () => {
  const args = { date: '2026-10-26', score: 78, capacity: 247, mode: 'push' };
  const first = generatePlan(args);
  const second = generatePlan(args);
  assert.deepEqual(
    first.tasks.map((task) => task.templateId),
    second.tasks.map((task) => task.templateId),
  );
});

test('修复日：必须有恢复项与身体项，且不排长任务', () => {
  const plan = generatePlan({ date: '2026-10-26', score: 25, capacity: 120, mode: 'recover' });
  const kinds = plan.tasks.map((task) => task.kind);
  assert.ok(kinds.filter((kind) => kind === 'recover').length >= 2);
  assert.ok(kinds.includes('body'));
  assert.ok(plan.tasks.every((task) => task.estimateMin <= 45), '修复日不该出现 90 分钟长任务');
});

test('推进日：必须有两条以上深度任务', () => {
  const plan = generatePlan({ date: '2026-10-26', score: 88, capacity: 271, mode: 'push' });
  assert.ok(plan.tasks.filter((task) => task.kind === 'focus').length >= 2);
});

test('稳态日：深度/认知/身体各至少一条', () => {
  const plan = generatePlan({ date: '2026-10-26', score: 55, capacity: 192, mode: 'steady' });
  const kinds = new Set(plan.tasks.map((task) => task.kind));
  for (const kind of Object.keys(REQUIREMENTS.steady)) assert.ok(kinds.has(kind), `缺少 ${kind}`);
});

test('同类任务有上限，避免一份表单变成同一条建议说五遍', () => {
  for (const [mode, score] of [
    ['recover', 20],
    ['steady', 55],
    ['push', 85],
  ]) {
    const plan = generatePlan({ date: '2026-10-26', score, capacity: 300, mode });
    const counts = plan.tasks.reduce((acc, task) => {
      acc[task.kind] = (acc[task.kind] ?? 0) + 1;
      return acc;
    }, {});
    assert.ok(counts.recover == null || counts.recover <= 3, JSON.stringify(counts));
    assert.ok(counts.focus == null || counts.focus <= 3, JSON.stringify(counts));
  }
});

test('条数不超过 6，且预算极小时也会给至少一条任务', () => {
  const normal = generatePlan({ date: '2026-10-26', score: 90, capacity: 300, mode: 'push' });
  assert.ok(normal.tasks.length <= 6);
  assert.ok(normal.tasks.length >= 3);

  const tight = generatePlan({ date: '2026-10-26', score: 0, capacity: 15, mode: 'recover' });
  assert.ok(tight.tasks.length >= 1);
  assert.ok(tight.tasks[0].estimateMin <= 15);
});

test('最近做过的任务会被压低权重（不是完全排除）', () => {
  const fresh = generatePlan({ date: '2026-10-26', score: 78, capacity: 247, mode: 'push' });
  const repeat = generatePlan({
    date: '2026-10-26',
    score: 78,
    capacity: 247,
    mode: 'push',
    recentTitles: fresh.tasks.map((task) => task.title),
  });
  const overlap = repeat.tasks.filter((task) => fresh.tasks.some((other) => other.title === task.title));
  assert.ok(overlap.length < fresh.tasks.length, '连续两天不该完全一样');
});

test('每条任务都带槽位、优先级与难度，供页面直接渲染', () => {
  const plan = generatePlan({ date: '2026-10-26', score: 70, capacity: 228, mode: 'push' });
  for (const task of plan.tasks) {
    assert.ok(['上午', '下午', '晚上'].includes(task.slot));
    assert.ok([1, 2, 3].includes(task.priority));
    assert.ok(task.difficulty >= 1 && task.difficulty <= 5);
    assert.ok(task.estimateMin > 0);
    assert.ok(CATALOG.some((item) => item.id === task.templateId));
  }
  assert.ok(plan.rationale.length >= 2);
  assert.equal(plan.rationale[0].includes('就绪度'), true);
});
