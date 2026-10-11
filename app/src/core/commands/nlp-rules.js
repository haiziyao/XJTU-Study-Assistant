/**
 * 指令解析基础能力：中文数字、日期短语、时刻、时间区间、重复规则、提醒。
 *
 * 全部为纯函数，便于单测；解析失败时返回 undefined，由调用方决定降级策略。
 */

import {
  addDays,
  clockToMinutes,
  combine,
  isClock,
  isDateKey,
  minutesToClock,
  minutesToClock as toClock,
  todayKey,
  weekdayOf,
  weekRange,
} from '../../shared/time.js';

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 中文数字 -> 阿拉伯数字，支持 一 / 十 / 十一 / 二十 / 二十三 / 半小时。 */
export function cnToNumber(text) {
  if (text === undefined || text === null) return undefined;
  const value = String(text).trim();
  if (/^\d+$/.test(value)) return Number(value);
  if (value === '半') return 0.5;
  if (!/^[零〇一二两三四五六七八九十]+$/.test(value)) return undefined;
  if (value.length === 1) return CN_DIGITS[value];
  const tenIndex = value.indexOf('十');
  if (tenIndex === -1) {
    return [...value].reduce((acc, ch) => acc * 10 + CN_DIGITS[ch], 0);
  }
  const tens = tenIndex === 0 ? 1 : CN_DIGITS[value.slice(0, tenIndex)];
  const onesPart = value.slice(tenIndex + 1);
  const ones = onesPart ? CN_DIGITS[onesPart] : 0;
  return tens * 10 + (ones ?? 0);
}

const WEEKDAY_CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

/**
 * 解析日期短语。
 * 支持：今天/明天/后天/大后天/昨天/前天、本周X/下周X/上周X/周X/星期X/礼拜X、周末、
 *      2025-10-20、2025年10月20日、10月20日、10/20。
 * @returns {{dateKey: string, matched: string, explicitYear?: boolean}|undefined}
 */
export function parseDateExpr(text, now = new Date()) {
  const today = todayKey(now);

  const relative = [
    [/大后天/, 3],
    [/后天/, 2],
    [/明天|明日/, 1],
    [/今天|今日|本日/, 0],
    [/昨天|昨日/, -1],
    [/前天/, -2],
  ];
  for (const [re, offset] of relative) {
    const m = text.match(re);
    if (m) return { dateKey: addDays(today, offset), matched: m[0] };
  }

  const full = text.match(/(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*[日号]?/);
  if (full) {
    const key = `${full[1]}-${String(full[2]).padStart(2, '0')}-${String(full[3]).padStart(2, '0')}`;
    if (isDateKey(key)) return { dateKey: key, matched: full[0], explicitYear: true };
  }

  const monthDay = text.match(/(\d{1,2})\s*[月/]\s*(\d{1,2})\s*[日号]?/);
  if (monthDay) {
    const year = Number(today.slice(0, 4));
    const key = `${year}-${String(monthDay[1]).padStart(2, '0')}-${String(monthDay[2]).padStart(2, '0')}`;
    if (isDateKey(key)) return { dateKey: key, matched: monthDay[0] };
  }

  if (/周末/.test(text)) {
    const { start } = weekRange(today, 1);
    return { dateKey: addDays(start, 5), matched: '周末' };
  }

  const week = text.match(/(这|本|下下|下个|下|上)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/);
  if (week) {
    const prefix = week[1] ?? '';
    const target = /[1-7]/.test(week[2]) ? Number(week[2]) % 7 : WEEKDAY_CN[week[2]];
    const { start } = weekRange(today, 1);
    let base = start;
    if (prefix === '下') base = addDays(start, 7);
    else if (prefix === '下个') base = addDays(start, 7);
    else if (prefix === '下下') base = addDays(start, 14);
    else if (prefix === '上') base = addDays(start, -7);
    // 周一为一周起点：start 是周一
    const offset = target === 0 ? 6 : target - 1;
    return { dateKey: addDays(base, offset), matched: week[0].trim() };
  }

  return undefined;
}

const PERIOD_OFFSET = [
  [/凌晨/, 0],
  [/早上|早晨|上午|清晨/, 0],
  [/中午|正午/, 12],
  [/下午|傍晚/, 12],
  [/晚上|夜里|夜晚|晚间/, 12],
];

/**
 * 从文本中解析一个时刻，支持 15:00 / 15点 / 下午3点 / 3点半 / 下午3点30分。
 * @param {string} text
 * @param {object} [options]
 * @param {boolean} [options.allowBare] 是否允许不带时段词的裸时刻
 * @param {string} [options.defaultPeriod] 位于文本之外的时段词（如“下午3点到4点半”里的“下午”）
 */
export function parseClockExpr(text, { allowBare = true, defaultPeriod } = {}) {
  const colon = text.match(/([01]?\d|2[0-3])[:：]([0-5]\d)/);
  if (colon) {
    const hourOffset = /下午|傍晚|晚上|夜里|夜晚|晚间/.test(defaultPeriod ?? '') && Number(colon[1]) < 12 ? 12 : 0;
    const hour = Number(colon[1]) + hourOffset;
    const clock = `${String(hour).padStart(2, '0')}:${colon[2]}`;
    return { clock, matched: colon[0] };
  }

  const pattern = allowBare
    ? /(凌晨|早上|早晨|上午|清晨|中午|正午|下午|傍晚|晚上|夜里|夜晚|晚间)?\s*(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*[点時时]\s*(半|[零〇一二两三四五六七八九十\d]{1,3}\s*分?)?/
    : /(凌晨|早上|早晨|上午|清晨|中午|正午|下午|傍晚|晚上|夜里|夜晚|晚间)\s*(\d{1,2})\s*[点時时]\s*(半|\d{1,3}\s*分?)?/;
  const m = text.match(pattern);
  if (!m) return undefined;

  let hour = cnToNumber(m[2]);
  if (hour === undefined || hour > 24) return undefined;
  let minute = 0;
  const minuteText = (m[3] ?? '').replace(/\s|分/g, '');
  if (minuteText === '半') minute = 30;
  else if (minuteText) {
    const parsed = cnToNumber(minuteText);
    if (parsed === undefined || parsed >= 60) return undefined;
    minute = parsed;
  }

  // 区间写法「下午3点到4点半」中，时段词只出现在区间开头，需要下传给两端
  const period = m[1] ?? defaultPeriod;
  if (period) {
    const offset = PERIOD_OFFSET.find(([re]) => re.test(period))?.[1] ?? 0;
    if (offset === 12 && hour < 12) hour += 12;
    if (offset === 12 && hour === 12 && /凌晨/.test(period)) hour = 0;
    if (/凌晨|清晨/.test(period) && hour === 12) hour = 0;
  }
  if (hour === 24) hour = 0;
  const clock = minutesToClock(hour * 60 + minute);
  return { clock, matched: m[0].trim() };
}

/** 解析时长：一小时 / 1.5小时 / 半小时 / 45分钟 -> 分钟数。 */
export function parseDurationExpr(text) {
  const half = text.match(/半\s*(?:个)?\s*小时/);
  if (half) return { minutes: 30, matched: half[0] };

  const hours = text.match(/(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十]{1,3})\s*(?:个)?\s*小时/);
  if (hours) {
    const value = /^\d/.test(hours[1]) ? Number(hours[1]) : cnToNumber(hours[1]);
    if (value !== undefined) return { minutes: Math.round(value * 60), matched: hours[0] };
  }

  const minutes = text.match(/(\d+|[零〇一二两三四五六七八九十]{1,3})\s*分钟/);
  if (minutes) {
    const value = /^\d+$/.test(minutes[1]) ? Number(minutes[1]) : cnToNumber(minutes[1]);
    if (value !== undefined) return { minutes: value, matched: minutes[0] };
  }

  return undefined;
}

/**
 * 解析时间区间：`15:00-16:00`、`下午3点到4点半`、`9:00~10:00`、`15:00 起 1 小时`。
 * @returns {{startTime: string, endTime?: string, durationMinutes?: number, allDay?: boolean, matched?: string}|undefined}
 */
export function parseTimeRangeExpr(text) {
  if (/(全天|整天|一整天)/.test(text)) {
    return { allDay: true, matched: '全天' };
  }

  const rangeSep = text.match(
    /((?:凌晨|早上|早晨|上午|清晨|中午|正午|下午|傍晚|晚上|夜里|夜晚|晚间)\s*)?(\d{1,2}[:：][0-5]\d|\d{1,2}\s*[点時时]\s*(?:半|\d{1,3}\s*分?)?)\s*(?:-|—|~|～|到|至|–)\s*(\d{1,2}[:：][0-5]\d|\d{1,2}\s*[点時时]\s*(?:半|\d{1,3}\s*分?)?)/,
  );
  if (rangeSep) {
    const defaultPeriod = rangeSep[1]?.trim();
    const start =
      parseClockExpr(rangeSep[2], { allowBare: false, defaultPeriod }) ?? parseClockExpr(rangeSep[2], { defaultPeriod });
    const end =
      parseClockExpr(rangeSep[3], { allowBare: false, defaultPeriod }) ?? parseClockExpr(rangeSep[3], { defaultPeriod });
    if (start && end) {
      return { startTime: start.clock, endTime: end.clock, matched: rangeSep[0].trim() };
    }
  }

  const start = parseClockExpr(text);
  const duration = parseDurationExpr(text);
  if (start) {
    if (duration) {
      return {
        startTime: start.clock,
        endTime: toClock(clockToMinutes(start.clock) + duration.minutes),
        durationMinutes: duration.minutes,
        matched: `${start.matched}${duration.matched}`,
      };
    }
    return { startTime: start.clock, matched: start.matched };
  }
  if (duration) {
    return { durationMinutes: duration.minutes, matched: duration.matched };
  }
  return undefined;
}

/**
 * 解析重复规则：每天/每日、每周X、每周、每月X日、每年、工作日、每两周。
 * 返回与接口字段 repeat 对齐的对象。
 */
export function parseRepeatExpr(text) {
  // 数量可省略：「每周一」= 每 1 周周一；「每两周」= interval 2
  const intervalMatch = text.match(/每\s*([零〇一二两三四五六七八九十\d]{1,3})?\s*(天|日|周|星期|礼拜|月|年)/);
  if (!intervalMatch) return undefined;
  const interval = Math.max(1, cnToNumber(intervalMatch[1]) ?? 1);
  const unit = intervalMatch[2];
  const weekdayMatch = text.match(/(?:周|星期|礼拜)\s*([一二三四五六日天1-7])/);
  let type = 'daily';
  const weekdays = [];
  if (/天|日/.test(unit)) type = 'daily';
  else if (/周|星期|礼拜/.test(unit)) {
    type = 'weekly';
    if (weekdayMatch) {
      const target = /[1-7]/.test(weekdayMatch[1]) ? Number(weekdayMatch[1]) % 7 : WEEKDAY_CN[weekdayMatch[1]];
      weekdays.push(target === 0 ? 7 : target);
    }
  } else if (unit === '月') type = 'monthly';
  else if (unit === '年') type = 'yearly';

  // 用原文切片构造匹配片段，保证「每周一」不会拼成原文中不存在的「每周周一」
  let matched = intervalMatch[0];
  if (type === 'weekly' && weekdayMatch && weekdayMatch.index >= intervalMatch.index) {
    matched = text.slice(intervalMatch.index, weekdayMatch.index + weekdayMatch[0].length);
  }

  return {
    repeat: { type, interval, weekdays, until: { mode: 'never' } },
    matched,
  };
}

/** 解析「工作日」重复。 */
export function parseWeekdayRepeat(text) {
  if (!/工作日|每个工作日|周一到周五/.test(text)) return undefined;
  return {
    repeat: { type: 'weekday', interval: 1, weekdays: [1, 2, 3, 4, 5], until: { mode: 'never' } },
    matched: text.match(/工作日|每个工作日|周一到周五/)[0],
  };
}

/** 解析提醒：提前10分钟 / 提前半小时 / 提醒 / 提前1天。 */
export function parseReminderExpr(text) {
  const m = text.match(/(提前|早)\s*([零〇一二两三四五六七八九十\d]{1,3}|半)\s*(分钟|分|小时|天|日)/);
  if (m) {
    const raw = m[2] === '半' ? 0.5 : cnToNumber(m[2]);
    if (raw === undefined) return undefined;
    const unit = m[3];
    let minutes = raw;
    if (unit === '小时') minutes = raw * 60;
    else if (unit === '天' || unit === '日') minutes = raw * 1440;
    return { offsetMinutes: Math.round(minutes), matched: m[0] };
  }
  if (/提醒/.test(text)) return { offsetMinutes: 0, matched: text.match(/提醒/)[0] };
  return undefined;
}

/** 判断文本中是否出现了明确的时刻信息（用于推断指令作用对象）。 */
export function hasExplicitTime(text) {
  return Boolean(parseTimeRangeExpr(text) && !parseTimeRangeExpr(text)?.allDay);
}

/** 解析「重复规则 + 日期」组合出的具体日期补足逻辑（月/年重复时同步补齐）。 */
export function alignRepeatWithDate(repeat, dateKey) {
  if (!repeat) return repeat;
  const next = { ...repeat, weekdays: [...(repeat.weekdays ?? [])] };
  if (repeat.type === 'weekly' && next.weekdays.length === 0) {
    const wd = weekdayOf(dateKey);
    next.weekdays.push(wd === 0 ? 7 : wd);
  }
  return next;
}

export { combine, isClock, isDateKey };
