/**
 * 指令解析器单元测试（用固定“当前时间”，保证结果稳定）。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandParser } from '../src/server/parser/command-parser.js';

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

test('未给时刻的日程按全天处理并给出警告', () => {
  const draft = parser.parse('添加日程 后天 交实验报告');
  assert.equal(draft.fields.date, '2025-10-17');
  assert.equal(draft.fields.allDay, true);
  assert.ok(draft.warnings.includes('未识别到具体时刻，按全天日程处理'));
});

test('下午时间自动加 12 小时', () => {
  const draft = parser.parse('添加日程 明天下午3点到4点半 小组讨论');
  assert.equal(draft.fields.startTime, '15:00');
  assert.equal(draft.fields.endTime, '16:30');
});

test('查询指令产出时间范围过滤条件', () => {
  const draft = parser.parse('查询本周未完成的日程');
  assert.equal(draft.action, 'query');
  assert.equal(draft.filters.from, '2025-10-13');
  assert.equal(draft.filters.to, '2025-10-19');
  assert.equal(draft.filters.status, 'pending');
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

test('空指令返回 ok=false', () => {
  const draft = parser.parse('   ');
  assert.equal(draft.ok, false);
});
