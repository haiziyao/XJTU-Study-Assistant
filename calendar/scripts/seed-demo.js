#!/usr/bin/env node
/**
 * 演示数据填充脚本（可选）。
 *
 * 用途：让「日历 / 待办」的各种视图有内容可看，方便评审界面效果。
 * 所有演示记录都带 `tags: ["demo"]`，可用 `--clear` 一键清除，不影响手动添加的数据。
 *
 * 用法：
 *   node scripts/seed-demo.js          # 写入演示数据（日期相对“今天”生成）
 *   node scripts/seed-demo.js --clear  # 删除所有 tags 含 demo 的记录
 */

import { createServer } from '../src/server/index.js';

const DATA_DIR = process.env.DATA_DIR ?? undefined;

function pad(n) {
  return String(n).padStart(2, '0');
}
function key(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function shift(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return key(date);
}
function mondayOfThisWeek() {
  const date = new Date();
  const weekday = date.getDay() === 0 ? 7 : date.getDay();
  date.setDate(date.getDate() - (weekday - 1));
  return key(date);
}

const DEMO_TAG = 'demo';

function demoEvents() {
  return [
    { title: '期中考试周', category: 'exam', startDate: shift(8), endDate: shift(12), description: '第 9 教学周，共 5 天' },
    { title: '高数作业截止', category: 'deadline', startDate: shift(2), endDate: shift(2) },
    { title: '社团招新', category: 'other', startDate: shift(1), endDate: shift(1) },
    { title: '校运动会', category: 'other', startDate: shift(5), endDate: shift(6) },
  ];
}

function demoSchedules() {
  const monday = mondayOfThisWeek();
  /** 每周固定课程：anchor 取本周一，weekdays 指定 ISO 星期（1=周一 … 7=周日）。 */
  const weekly = (weekday, title, startTime, endTime, location) => ({
    title,
    date: monday,
    startTime,
    endTime,
    category: 'class',
    location,
    repeat: { type: 'weekly', interval: 1, weekdays: [weekday], until: { mode: 'never' } },
  });

  return [
    // 每周固定课程（重复日程）
    weekly(1, '高等数学', '08:00', '09:40', '主楼 A203'),
    weekly(3, '大学英语', '10:00', '11:40', '外语楼 305'),
    weekly(5, '数据结构', '14:00', '15:40', '计算中心 412'),
    // 今天
    { title: '自习 · 线代复习', date: shift(0), startTime: '09:00', endTime: '10:30', category: 'study', priority: 1, estimatedMinutes: 90 },
    { title: '小组讨论：课程设计', date: shift(0), startTime: '14:00', endTime: '15:00', category: 'meeting', status: 'done', estimatedMinutes: 60 },
    { title: '整理错题本', date: shift(0), allDay: true, category: 'study', priority: 1, estimatedMinutes: 45 },
    // 明天
    { title: '英语晨读', date: shift(1), startTime: '09:30', endTime: '10:00', category: 'study', estimatedMinutes: 30 },
    { title: '项目周会', date: shift(1), startTime: '15:00', endTime: '16:00', category: 'meeting', reminders: [{ offsetMinutes: 10 }] },
    // 逾期未完成（用于演示「逾期」筛选与顺延）
    { title: '提交物理实验报告', date: shift(-2), startTime: '20:00', endTime: '21:00', category: 'study', priority: 2, estimatedMinutes: 60 },
    // 未来待办
    { title: '预习离散数学第 4 章', date: shift(3), allDay: true, category: 'study', estimatedMinutes: 60 },
    { title: '背 50 个单词', date: shift(4), allDay: true, category: 'study', priority: 1, estimatedMinutes: 30 },
    { title: '准备期中考试复习计划', date: shift(6), startTime: '19:00', endTime: '20:00', category: 'study', priority: 2, estimatedMinutes: 60 },
  ];
}

const app = await createServer({ dataDir: DATA_DIR });
const { store, events, schedules } = app.services;
const clear = process.argv.includes('--clear');

if (clear) {
  const demoEvents = store.events.all().filter((item) => (item.tags ?? []).includes(DEMO_TAG));
  const demoSchedules = store.schedules.all().filter((item) => (item.tags ?? []).includes(DEMO_TAG));
  await store.events.removeMany(demoEvents.map((item) => item.id));
  await store.schedules.removeMany(demoSchedules.map((item) => item.id));
  console.log(`[seed-demo] 已清除演示数据：事件 ${demoEvents.length} 条，日程 ${demoSchedules.length} 条`);
} else {
  let created = 0;
  for (const item of demoEvents()) {
    await events.create({ ...item, allDay: true, tags: [DEMO_TAG] });
    created += 1;
  }
  for (const item of demoSchedules()) {
    await schedules.create({ ...item, tags: [DEMO_TAG] });
    created += 1;
  }
  console.log(`[seed-demo] 已写入 ${created} 条演示数据（数据目录 ${app.dataDir}）`);
  console.log('[seed-demo] 清除方式：node scripts/seed-demo.js --clear');
}

console.log(`[seed-demo] 数据文件位于 ${app.dataDir}`);
process.exit(0);
