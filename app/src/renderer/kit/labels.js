/**
 * 全局展示标签与枚举（与后端 shared/constants.js 的枚举一一对应）。
 *
 * 放在 kit 而不是某个视图里：日历、待办、消息、设置都要用到分类/状态/优先级的中文名。
 */

const CATEGORY_LABEL = {
  class: '上课',
  study: '学习',
  meeting: '会议',
  exam: '考试',
  activity: '活动',
  holiday: '假期',
  anniversary: '纪念日',
  deadline: '截止',
  other: '其它',
};
const STATUS_LABEL = { pending: '待办', done: '已完成', cancelled: '已取消', rolled: '已顺延' };
const PRIORITY_LABEL = { 0: '低', 1: '普通', 2: '紧急' };
const ACTION_LABEL = {
  create: '新增',
  query: '查询',
  update: '修改',
  delete: '删除',
  complete: '完成',
  rollover: '顺延',
};
// todo 是独立实体，漏了它确认卡与指令日志就会显示成「新增todo」
// grade 来自 academic 模块：不加这一条，查询卡头会显示「查看grade」
const TARGET_LABEL = { todo: '待办', schedule: '日程', event: '日历事件', grade: '成绩' };
const SCHEDULE_CATEGORIES = ['class', 'study', 'meeting', 'exam', 'activity', 'other'];
const EVENT_CATEGORIES = ['study', 'exam', 'holiday', 'anniversary', 'deadline', 'other'];
const REPEAT_TYPES = [
  ['none', '不重复'],
  ['daily', '每天'],
  ['weekly', '每周'],
  ['monthly', '每月'],
  ['yearly', '每年'],
  ['weekday', '每个工作日'],
];
const REMINDER_PRESETS = [
  [null, '不提醒'],
  [0, '准点'],
  [5, '提前 5 分钟'],
  [10, '提前 10 分钟'],
  [15, '提前 15 分钟'],
  [30, '提前 30 分钟'],
  [60, '提前 1 小时'],
  [1440, '提前 1 天'],
];
