/**
 * 入参校验与规范化。
 *
 * 原则：
 * - 校验失败一律抛 HttpError.badRequest，并在 details 中给出字段级原因；
 * - 校验成功时返回**规范化后的对象**（补默认值、去空白、统一枚举），业务层不再处理脏值；
 * - 未知字段直接忽略，保证向前兼容（后续版本新增可选字段不会打断旧前端）。
 */

import { HttpError } from '../http/router.js';
import {
  EVENT_CATEGORIES,
  REMINDER_PRESETS,
  REPEAT_TYPES,
  REPEAT_UNTIL_MODES,
  SCHEDULE_CATEGORIES,
  SCHEDULE_STATUS,
} from '../../shared/constants.js';
import { isClock, isDateKey } from '../../shared/time.js';
import { normalizeLooseClock, normalizeLooseDate } from './compat.js';

const MAX_TITLE = 120;
const MAX_TEXT = 2000;

function fail(field, message) {
  throw HttpError.badRequest(`字段 ${field} 不合法：${message}`, { field });
}

export function pickDefined(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

export function requireTitle(value, field = 'title') {
  if (typeof value !== 'string' || !value.trim()) fail(field, '必填且不能为空');
  const title = value.trim();
  if (title.length > MAX_TITLE) fail(field, `长度不能超过 ${MAX_TITLE}`);
  return title;
}

export function optionalText(value, field, max = MAX_TEXT) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') fail(field, '必须是字符串');
  const text = value.trim();
  if (text.length > max) fail(field, `长度不能超过 ${max}`);
  return text;
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

export function enumValue(value, allowed, field, { optional = true, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return fallback;
    fail(field, `必填，可选值：${allowed.join(' / ')}`);
  }
  if (!allowed.includes(value)) fail(field, `取值必须是 ${allowed.join(' / ')} 之一`);
  return value;
}

export function intValue(value, field, { min = 0, max = 100000, optional = true, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return fallback;
    fail(field, '必填');
  }
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num)) fail(field, '必须是整数');
  if (num < min || num > max) fail(field, `取值范围 ${min}~${max}`);
  return num;
}

export function stringArray(value, field, { max = 20 } = {}) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) fail(field, '必须是数组');
  if (value.length > max) fail(field, `最多 ${max} 项`);
  return value.map((item) => String(item).trim()).filter(Boolean);
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

export { EVENT_CATEGORIES, SCHEDULE_CATEGORIES, SCHEDULE_STATUS, REMINDER_PRESETS };
