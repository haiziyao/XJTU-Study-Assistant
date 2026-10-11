/**
 * 日历/日程领域的校验与规范化。
 *
 * 与 core/validate.js 的分工：那边是「必填、长度、枚举、整数」这类与业务无关的原始校验，
 * 这边是日历特有的语义——宽松中文日期归一化、重复规则、提醒档位、复杂度推导。
 */

import { HttpError } from '../../core/http/router.js';
import { enumValue, intValue } from '../../core/validate.js';
import {
  REPEAT_TYPES,
  REPEAT_UNTIL_MODES,
} from '../../shared/constants.js';
import { isClock, isDateKey } from '../../shared/time.js';
import { normalizeLooseClock, normalizeLooseDate } from './compat.js';

function fail(field, message) {
  throw HttpError.badRequest(`字段 ${field} 不合法：${message}`, { field });
}

export function requireDate(value, field) {
  // 宽松输入（2026-9-1 / 2026/09/01 / 2026年9月1日 / 20260901）统一归一化后再校验，
  // 与 dschat 2 的 _parse_date_loose 行为保持一致
  const normalized = normalizeLooseDate(value);
  if (!isDateKey(normalized)) fail(field, '必须是 YYYY-MM-DD 格式的合法日期');
  return normalized;
}

export function requireClock(value, field) {
  const normalized = normalizeLooseClock(value);
  if (!isClock(normalized)) fail(field, '必须是 HH:mm 格式的 24 小时时刻');
  return normalized;
}

export function optionalDate(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  return requireDate(value, field);
}

export function optionalClock(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  return requireClock(value, field);
}

/** 规范化重复规则。 */
export function normalizeRepeat(input, field = 'repeat') {
  if (input === undefined || input === null) return { type: 'none', interval: 1, weekdays: [], until: { mode: 'never' } };
  if (typeof input === 'string') {
    const type = enumValue(input, REPEAT_TYPES, field, { optional: false });
    return { type, interval: 1, weekdays: [], until: { mode: 'never' } };
  }
  if (typeof input !== 'object') fail(field, '必须是对象或字符串');
  const type = enumValue(input.type ?? 'none', REPEAT_TYPES, `${field}.type`, { optional: false });
  const interval = intValue(input.interval ?? 1, `${field}.interval`, { min: 1, max: 365, optional: true, fallback: 1 });
  let weekdays = [];
  if (input.weekdays !== undefined) {
    if (!Array.isArray(input.weekdays)) fail(`${field}.weekdays`, '必须是数组');
    weekdays = [...new Set(input.weekdays.map((d) => intValue(d, `${field}.weekdays[]`, { min: 1, max: 7, optional: false })))];
  }
  const untilInput = input.until ?? {};
  const mode = enumValue(untilInput.mode ?? 'never', REPEAT_UNTIL_MODES, `${field}.until.mode`, { optional: false });
  const until = { mode };
  if (mode === 'date') until.date = requireDate(untilInput.date, `${field}.until.date`);
  if (mode === 'count') until.count = intValue(untilInput.count, `${field}.until.count`, { min: 1, max: 1000, optional: false });
  return { type, interval, weekdays, until };
}

/** 规范化提醒数组。 */
export function normalizeReminders(input, field = 'reminders') {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) fail(field, '必须是数组');
  if (input.length > 5) fail(field, '最多 5 条提醒');
  return input.map((item, index) => {
    const raw = typeof item === 'number' ? { offsetMinutes: item } : item;
    if (!raw || typeof raw !== 'object') fail(`${field}[${index}]`, '必须是对象或分钟数');
    const offsetMinutes = intValue(raw.offsetMinutes, `${field}[${index}].offsetMinutes`, {
      min: 0,
      max: 60 * 24 * 14,
      optional: false,
    });
    const channel = enumValue(raw.channel ?? 'app', ['app', 'system', 'ai'], `${field}[${index}].channel`, {
      optional: true,
      fallback: 'app',
    });
    return { offsetMinutes, channel, sent: raw.sent ?? {} };
  });
}

/** 由预估时长推导复杂度标签（沿用 PotatoCalendar 的阈值）。 */
export function complexityOf(estimatedMinutes) {
  if (!estimatedMinutes && estimatedMinutes !== 0) return undefined;
  if (estimatedMinutes <= 60) return 'simple';
  if (estimatedMinutes <= 180) return 'normal';
  if (estimatedMinutes <= 600) return 'complex';
  return 'heavy';
}

/**
 * 由预估**工时**推导复杂度（待办用的是小时，阈值与 PotatoCalendar 的
 * `get_complexity_info` 完全一致：≤1h 简单 / ≤3h 一般 / ≤10h 复杂 / 其余繁琐）。
 */
export function complexityOfHours(estimatedHours) {
  const hours = Number(estimatedHours);
  if (!Number.isFinite(hours) || hours <= 0) return 'simple';
  if (hours <= 1) return 'simple';
  if (hours <= 3) return 'normal';
  if (hours <= 10) return 'complex';
  return 'heavy';
}

/** 非整数数值校验（工时可以是 1.5 小时，因此不能用 intValue）。 */
export function numberValue(value, field, { min = 0, max = 100000, optional = true, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return fallback;
    throw HttpError.badRequest(`字段 ${field} 必填`, { field });
  }
  const num = Number(value);
  if (!Number.isFinite(num)) fail(field, '必须是数字');
  if (num < min || num > max) fail(field, `取值范围 ${min}~${max}`);
  return num;
}
