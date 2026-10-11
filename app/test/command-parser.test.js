/**
 * 指令解析器单元测试（用固定“当前时间”，保证结果稳定）。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandParser } from '../src/modules/calendar/parser.js';

/** 固定为 2025-10-15（周三）10:00。 */
const FIXED = new Date(2025, 9, 15, 10, 0, 0);
const parser = new CommandParser({ now: () => FIXED });

test('解析“添加日程 明天 15:00-16:00 项目周会 提前10分钟提醒”', () => {
  const draft = parser.parse('添加日程 明天 15:00-16:00 项目周会 提前10分钟提醒');
  assert.equal(draft.ok, true);
  assert.equal(draft.action, 'create');
  assert.equal(draft.target, 'schedule');
  assert.equal(draft.fields.date, '2025-10-16');
  assert.equal(draft.fields.startTime, '15:00');
  assert.equal(draft.fields.endTime, '16:00');
  assert.equal(draft.fields.title, '项目周会');
  assert.deepEqual(draft.fields.reminders[0].offsetMinutes, 10);
  assert.ok(draft.confidence > 0.8);
});

test('中文时刻“每周一 9点半”解析为重复日程', () => {
  const draft = parser.parse('添加日程 每周一 9点半 英语晨读');
  assert.equal(draft.target, 'schedule');
  assert.equal(draft.fields.startTime, '09:30');
  assert.equal(draft.fields.repeat.type, 'weekly');
  assert.deepEqual(draft.fields.repeat.weekdays, [1]);
  assert.equal(draft.fields.title, '英语晨读');
});

test('日历事件支持日期区间与优先级', () => {
  const draft = parser.parse('添加日历事件 2025-10-20 到 2025-10-22 期中考试 重要');
  assert.equal(draft.target, 'event');
  assert.equal(draft.fields.startDate, '2025-10-20');
  assert.equal(draft.fields.endDate, '2025-10-22');
  assert.equal(draft.fields.category, 'exam');
  assert.equal(draft.fields.priority, 2);
  assert.equal(draft.fields.title, '期中考试');
});

test('明确说了「日程」但没给时刻：补默认时段并给出警告', () => {
  const draft = parser.parse('添加日程 后天 交实验报告');
  assert.equal(draft.target, 'schedule');
  assert.equal(draft.fields.date, '2025-10-17');
  assert.equal(draft.fields.startTime, '09:00');
  assert.equal(draft.fields.endTime, '10:00');
  assert.equal(draft.fields.allDay, undefined);
  assert.equal(draft.fields.status, undefined);
  assert.ok(draft.warnings.some((text) => text.includes('09:00-10:00')));
});

test('单日无时刻、也没说「日程」的：判成待办（deadline + 默认低优先级）', () => {
  const draft = parser.parse('后天 交实验报告');
  assert.equal(draft.target, 'todo');
  assert.equal(draft.fields.deadline, '2025-10-17');
  assert.equal(draft.fields.startTime, undefined);
  assert.equal(draft.fields.priority, 0);
  assert.equal(draft.fields.estimatedHours, undefined);
});

test('下午时间自动加 12 小时', () => {
  const draft = parser.parse('添加日程 明天下午3点到4点半 小组讨论');
  assert.equal(draft.fields.startTime, '15:00');
  assert.equal(draft.fields.endTime, '16:30');
});

test('查询指令产出时间范围过滤条件（待办用 completed，日程没有状态）', () => {
  const todo = parser.parse('查询本周未完成的待办');
  assert.equal(todo.action, 'query');
  assert.equal(todo.target, 'todo');
  assert.equal(todo.filters.from, '2025-10-13');
  assert.equal(todo.filters.to, '2025-10-19');
  assert.equal(todo.filters.completed, false);
  assert.equal(todo.filters.status, undefined);

  const schedule = parser.parse('查询本周的日程');
  assert.equal(schedule.target, 'schedule');
  assert.equal(schedule.filters.from, '2025-10-13');
  assert.equal(schedule.filters.status, undefined, '日程没有状态，不能再产出 status 过滤');
});

test('顺延不产出关键词；「未完成」这类状态词也不会污染 keyword', () => {
  const rollover = parser.parse('顺延未完成的待办到本周');
  assert.equal(rollover.action, 'rollover');
  assert.equal(rollover.filters.weekStart, '2025-10-13');
  assert.equal(rollover.filters.keyword, undefined, '顺延不接受关键词');
  assert.ok(!/关键词/.test(rollover.explain ?? ''), `explain 不该出现关键词：${rollover.explain}`);

  const query = parser.parse('查询未完成的待办');
  assert.equal(query.filters.completed, false);
  assert.equal(query.filters.keyword, undefined, '「未完成」是过滤条件，不是关键词');
});

test('完成指令按日期+关键词定位', () => {
  const draft = parser.parse('完成今天的英语听力');
  assert.equal(draft.action, 'complete');
  assert.equal(draft.filters.from, '2025-10-15');
  assert.equal(draft.filters.keyword, '英语听力');
});

test('“一周后”类模糊表达降级为今天并给出警告', () => {
  const draft = parser.parse('添加日程 复习高数');
  assert.equal(draft.ok, true);
  assert.ok(draft.warnings.length >= 1);
  assert.ok(draft.confidence < 0.8);
});

test('裸「周X / 周末」指向未来；显式「本周X」保持原样', () => {
  // 2026-10-11 是周日：本周一~周六全都已经过去
  const sunday = new CommandParser({ now: () => new Date(2026, 9, 11, 10, 0, 0) });

  assert.equal(sunday.parse('周三交作业').fields.deadline, '2026-10-14');
  assert.equal(sunday.parse('周一开组会').fields.deadline, '2026-10-12');
  assert.equal(sunday.parse('周五交作业').fields.deadline, '2026-10-16');
  // 显式说了「本周三」，落到过去是用户自己的选择，保持原样
  assert.equal(sunday.parse('本周三交作业').fields.deadline, '2026-10-07');
  // 今天就是周日：今天仍在周末里
  assert.equal(sunday.parse('周末写作业').fields.deadline, '2026-10-11');
  // 今天正好是那一天 -> 保留今天
  assert.equal(sunday.parse('周日休息').fields.deadline, '2026-10-11');
  // 有具体时刻的日程同样不能落到过去
  assert.equal(sunday.parse('周三下午三点开组会').fields.date, '2026-10-14');
  assert.equal(sunday.parse('周六上午十点考试').fields.date, '2026-10-17');
});

test('重复日程的锚点直接落在未来（不再依赖 nextOccurrence 兜底）', () => {
  // FIXED 是 2025-10-15（周三）：裸「每周一」应锚到下一个周一
  assert.equal(parser.parse('添加日程 每周一 9点半 站会').fields.date, '2025-10-20');
  // 本周五还没到 -> 保持本周五
  assert.equal(parser.parse('添加日程 每周五 9点半 站会').fields.date, '2025-10-17');
});

test('空指令返回 ok=false', () => {
  const draft = parser.parse('   ');
  assert.equal(draft.ok, false);
});
