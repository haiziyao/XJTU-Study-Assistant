/**
 * 学分绩 / 绩点换算的纯函数测试。
 *
 * 这些是最容易"算错了但没人发现"的地方 —— 学分绩是学生真正在意、会拿去核对数字的东西，
 * 所以口径必须钉死：
 *   - 加权是**按学分**，不是按门数（简单平均是错的）；
 *   - 分母只算「有该项数据」的学分（拿不到的课不能拉低平均）；
 *   - 教务直接给的 `XFJD` 优先，换算表只兜底，且要标出来源；
 *   - 没有可计算项时返回 `null` 而不是 `0`（0 分和"算不出来"是两回事）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { GPA_TABLE, GPA_SOURCE } from '../src/modules/academic/config.js';
import {
  compareGpa,
  computeStats,
  gradePointOf,
  isIncluded,
  isValid,
  round,
  scoreToGradePoint,
  toNumber,
} from '../src/modules/academic/gpa.js';

/* ------------------------------------------------------------------ 基础工具 */

test('gpa：toNumber 对空值与非数字文本都返回 null', () => {
  assert.equal(toNumber(90), 90);
  assert.equal(toNumber('90'), 90);
  assert.equal(toNumber(' 87.5 '), 87.5);
  assert.equal(toNumber(0), 0);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('  '), null);
  assert.equal(toNumber(null), null);
  assert.equal(toNumber(undefined), null);
  assert.equal(toNumber('优秀'), null, '等级制文本不该被当成数字');
  assert.equal(toNumber(Number.NaN), null);
  assert.equal(toNumber(Number.POSITIVE_INFINITY), null);
});

test('gpa：round 抹掉浮点尾差但保留精度', () => {
  assert.equal(round(0.1 + 0.2, 4), 0.3);
  assert.equal(round(3.7999999999, 4), 3.8);
  assert.equal(round(3.14159, 2), 3.14);
  assert.equal(round(Number.NaN), null);
});

/* ------------------------------------------------------------------ 换算表 */

test('gpa：官方 4.3 制换算表的每一档都对', () => {
  const cases = [
    [100, 4.3],
    [95, 4.3],
    [94, 4.0],
    [90, 4.0],
    [89, 3.7],
    [85, 3.7],
    [84, 3.3],
    [82, 3.3],
    [81, 3.0],
    [78, 3.0],
    [77, 2.7],
    [75, 2.7],
    [74, 2.3],
    [72, 2.3],
    [71, 2.0],
    [68, 2.0],
    [67, 1.5],
    [64, 1.5],
    [63, 1.0],
    [60, 1.0],
    [59, 0],
    [0, 0],
  ];
  for (const [score, expected] of cases) {
    assert.equal(scoreToGradePoint(score), expected, `${score} 分应为 ${expected}`);
  }
});

test('gpa：换算表在 95 处取 4.3（用户给的区间在 95 重叠，按降序取首个命中）', () => {
  assert.equal(scoreToGradePoint(95), 4.3);
  assert.equal(scoreToGradePoint(94.9), 4.0);
});

test('gpa：与教务返回的真实 XFJD 对得上（回归锚点）', () => {
  // 实测：教务对期末 9x 分给 4、对 8x 分给 3.3，与官方表一致。
  // 这里用同档位的分数做回归，确保以后改表不会把这两个档位改坏。
  assert.equal(scoreToGradePoint(92), 4.0);
  assert.equal(scoreToGradePoint(83), 3.3);
});

test('gpa：无法判定的分数返回 null', () => {
  assert.equal(scoreToGradePoint(null), null);
  assert.equal(scoreToGradePoint(''), null);
  assert.equal(scoreToGradePoint('优秀'), null);
});

/* ------------------------------------------------------------------ 绩点来源 */

test('gpa：优先用教务给的 XFJD，缺失才回退到换算表，并如实标注来源', () => {
  // 学校给了绩点：即使分数换算出来不一样，也以学校为准
  assert.deepEqual(gradePointOf({ gradePoint: 3.9, score: 84 }), { point: 3.9, source: GPA_SOURCE.school });
  // 学校没给：用分数换算
  assert.deepEqual(gradePointOf({ gradePoint: null, score: 84 }), { point: 3.3, source: GPA_SOURCE.table });
  // 两者都没有：算不出来
  assert.deepEqual(gradePointOf({ gradePoint: null, score: null }), { point: null, source: null });
});

test('gpa：XFJD 为 0 是有效值，不能被当成「缺失」', () => {
  assert.deepEqual(gradePointOf({ gradePoint: 0, score: 90 }), { point: 0, source: GPA_SOURCE.school });
});

/* ------------------------------------------------------------------ 有效性 / 纳入 */

test('gpa：SFYX 判定 —— 只有 "1" 有效，缺字段按有效处理', () => {
  assert.equal(isValid({ valid: '1' }), true);
  assert.equal(isValid({ valid: '0' }), false);
  assert.equal(isValid({ valid: undefined }), true, '旧数据没有该字段时不应被误伤');
  assert.equal(isValid({ valid: null }), true);
});

test('gpa：included 默认为 true，只有显式 false 才排除', () => {
  assert.equal(isIncluded({}), true);
  assert.equal(isIncluded({ included: undefined }), true);
  assert.equal(isIncluded({ included: false }), false);
});

/* ------------------------------------------------------------------ 统计口径 */

/** 构造一条归一化记录。 */
const rec = (over = {}) => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  courseName: '课程',
  credit: 3,
  score: 90,
  gradePoint: null,
  valid: '1',
  included: true,
  term: '2025-2026-1',
  ...over,
});

test('gpa：空输入返回 null 而不是 0', () => {
  const stats = computeStats([]);
  assert.equal(stats.gpa, null);
  assert.equal(stats.weightedAverage, null);
  assert.equal(stats.includedCount, 0);
  assert.equal(stats.totalCredits, 0);
  assert.deepEqual(stats.warnings, []);
});

test('gpa：按学分加权，而不是按门数简单平均', () => {
  // 4 学分拿 4.0，1 学分拿 1.0
  //   按学分：(4×4.0 + 1×1.0) / 5 = 3.4
  //   按门数：(4.0 + 1.0) / 2     = 2.5   ← 错的
  const stats = computeStats([
    rec({ credit: 4, gradePoint: 4.0 }),
    rec({ credit: 1, gradePoint: 1.0 }),
  ]);
  assert.equal(stats.gpa, 3.4);
  assert.equal(stats.gpaCredits, 5);
});

test('gpa：学分绩用 XFJD，加权平均分用总评，两条口径互不干扰', () => {
  const stats = computeStats([
    rec({ credit: 3, gradePoint: 4.0, score: 92 }),
    rec({ credit: 2, gradePoint: 3.0, score: 78 }),
  ]);
  // 学分绩：(3×4 + 2×3) / 5 = 3.6
  assert.equal(stats.gpa, 3.6);
  // 加权平均分：(3×92 + 2×78) / 5 = 86.4
  assert.equal(stats.weightedAverage, 86.4);
});

test('gpa：被排除的课不计入，且单独报数', () => {
  const stats = computeStats([
    rec({ credit: 3, gradePoint: 4.0 }),
    rec({ credit: 3, gradePoint: 1.0, included: false }),
  ]);
  assert.equal(stats.gpa, 4.0, '被排除的课不该拉低学分绩');
  assert.equal(stats.skippedCount, 1);
  assert.equal(stats.totalCredits, 3, '总学分也不含被排除的');
});

test('gpa：无效成绩（SFYX=0）不计入', () => {
  const stats = computeStats([
    rec({ credit: 3, gradePoint: 4.0 }),
    rec({ credit: 3, gradePoint: 0, valid: '0' }),
  ]);
  assert.equal(stats.gpa, 4.0);
  assert.equal(stats.validCount, 1);
});

test('gpa：拿不到绩点的课进不了分子分母，但必须被报出来', () => {
  const stats = computeStats([
    rec({ credit: 3, gradePoint: 4.0 }),
    rec({ credit: 3, gradePoint: null, score: null, courseName: '等级制课' }),
  ]);
  assert.equal(stats.gpa, 4.0, '有绩点的那门应保持 4.0，不被无绩点的课拉低');
  assert.equal(stats.gpaCredits, 3, '无绩点的课不计入分母');
  assert.equal(stats.unmapped.length, 1);
  assert.equal(stats.unmapped[0].courseName, '等级制课');
  assert.ok(stats.warnings.some((w) => w.includes('没有绩点')), '应有明确提示');
});

test('gpa：只有总评没有绩点的课，能用换算表救回来并标来源', () => {
  const stats = computeStats([rec({ credit: 3, gradePoint: null, score: 66 })]);
  assert.equal(stats.gpa, 1.5, '66 分 → 1.5');
  assert.equal(stats.unmapped.length, 0);
});

test('gpa：学分缺失或为 0 的课单独报出，不参与加权', () => {
  const stats = computeStats([
    rec({ credit: 3, gradePoint: 4.0 }),
    rec({ credit: 0, gradePoint: 4.3, courseName: '零学分讲座' }),
    rec({ credit: null, gradePoint: 4.3, courseName: '无学分' }),
  ]);
  assert.equal(stats.gpa, 4.0);
  assert.equal(stats.zeroCredit.length, 2);
  assert.ok(stats.warnings.some((w) => w.includes('学分')));
});

test('gpa：按学期细分，结果按学期代码排序', () => {
  const stats = computeStats([
    rec({ term: '2025-2026-2', termLabel: '大二下', credit: 2, gradePoint: 3.0 }),
    rec({ term: '2024-2025-1', termLabel: '大二上', credit: 4, gradePoint: 4.0 }),
    rec({ term: '2024-2025-1', termLabel: '大二上', credit: 1, gradePoint: 2.0 }),
  ]);
  assert.deepEqual(
    stats.terms.map((t) => t.term),
    ['2024-2025-1', '2025-2026-2'],
  );
  const first = stats.terms[0];
  assert.equal(first.courses, 2);
  assert.equal(first.credits, 5);
  // (4×4.0 + 1×2.0) / 5 = 3.6
  assert.equal(first.gpa, 3.6);
  assert.equal(stats.terms[1].gpa, 3.0);
});

test('gpa：本学期 4.0 但整体被历史拉低 —— 学期细分能如实反映', () => {
  const stats = computeStats([
    rec({ term: '2023-2024-1', credit: 10, gradePoint: 2.0 }),
    rec({ term: '2025-2026-1', credit: 10, gradePoint: 4.0 }),
  ]);
  assert.equal(stats.gpa, 3.0, '整体 3.0');
  assert.equal(stats.terms.find((t) => t.term === '2025-2026-1').gpa, 4.0, '本学期仍是 4.0');
});

test('gpa：同一门课重复出现（重修）按记录各自计入 —— 去重是同步层的责任', () => {
  const stats = computeStats([
    rec({ credit: 3, gradePoint: 1.0, courseName: '高数' }),
    rec({ credit: 3, gradePoint: 4.0, courseName: '高数' }),
  ]);
  assert.equal(stats.gpa, 2.5, '(1+4)/2');
  assert.equal(stats.totalCredits, 6);
});

test('gpa：脏数据不会让统计炸掉', () => {
  const stats = computeStats([null, undefined, 'x', 42, rec({ credit: 3, gradePoint: 4.0 })]);
  assert.equal(stats.gpa, 4.0, '只有那条合法记录参与计算');
});

test('gpa：默认表就是官方表（改表要显式传入）', () => {
  assert.deepEqual(GPA_TABLE[0], { min: 95, point: 4.3 });
  assert.equal(GPA_TABLE.at(-1).point, 0);
  const custom = computeStats([rec({ credit: 1, gradePoint: null, score: 90 })], { table: [{ min: 0, point: 9 }] });
  assert.equal(custom.gpa, 9, '传入自定义表时应生效');
});

/* ------------------------------------------------------------------ 变化对比 */

test('gpa：同步前后的变化对比', () => {
  assert.deepEqual(compareGpa(3.5, 3.6), { before: 3.5, after: 3.6, delta: 0.1, improved: true });
  assert.equal(compareGpa(3.6, 3.5).improved, false);
  assert.equal(compareGpa(3.5, 3.5).improved, null, '持平不算进步也不算退步');
  assert.equal(compareGpa(null, 3.5).delta, null, '首次同步没有可比对象');
});
