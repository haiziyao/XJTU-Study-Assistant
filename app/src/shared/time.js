/**
 * 纯日期 / 时间工具（无第三方依赖，全部按本地时区计算）。
 *
 * 约定：
 * - 日期键统一为 `YYYY-MM-DD` 字符串（本地时区）。
 * - 时刻统一为 `HH:mm` 字符串。
 * - 对外返回的时间戳为带本地时区偏移的 ISO 8601 字符串，如 `2025-10-20T15:00:00+08:00`。
 */

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const pad2 = (n) => String(n).padStart(2, '0');

/** 是否为合法的 `YYYY-MM-DD`。 */
export function isDateKey(value) {
  if (typeof value !== 'string' || !DATE_KEY_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** 是否为合法的 `HH:mm`。 */
export function isClock(value) {
  return typeof value === 'string' && CLOCK_RE.test(value);
}

/** Date -> `YYYY-MM-DD`（本地）。 */
export function toDateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** `YYYY-MM-DD` -> 本地零点的 Date。 */
export function fromDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** 今天的日期键。 */
export function todayKey(now = new Date()) {
  return toDateKey(now);
}

/** 日期键加减天数。 */
export function addDays(key, days) {
  const dt = fromDateKey(key);
  dt.setDate(dt.getDate() + days);
  return toDateKey(dt);
}

/** 日期键加减月数（自动处理月末溢出）。 */
export function addMonths(key, months) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1 + months, 1);
  const lastDay = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
  dt.setDate(Math.min(d, lastDay));
  return toDateKey(dt);
}

/** 日期键加减年数。 */
export function addYears(key, years) {
  return addMonths(key, years * 12);
}

/** 星期几，0=周日 … 6=周六。 */
export function weekdayOf(key) {
  return fromDateKey(key).getDay();
}

/** 以 `weekStartsOn`（0=周日，1=周一）为一周起点，取所在周的起止日期键。 */
export function weekRange(key, weekStartsOn = 1) {
  const offset = (weekdayOf(key) - weekStartsOn + 7) % 7;
  const start = addDays(key, -offset);
  return { start, end: addDays(start, 6) };
}

/** 所在月的起止日期键。 */
export function monthRange(key) {
  const [y, m] = key.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return { start: `${y}-${pad2(m)}-01`, end: `${y}-${pad2(m)}-${pad2(lastDay)}` };
}

/** 所在年的起止日期键。 */
export function yearRange(key) {
  const y = key.slice(0, 4);
  return { start: `${y}-01-01`, end: `${y}-12-31` };
}

/** `HH:mm` -> 从 00:00 起的分钟数。 */
export function clockToMinutes(clock) {
  const [h, m] = clock.split(':').map(Number);
  return h * 60 + m;
}

/** 从 00:00 起的分钟数 -> `HH:mm`。 */
export function minutesToClock(minutes) {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(normalized / 60))}:${pad2(normalized % 60)}`;
}

/** 计算带本地时区偏移的 ISO 8601 字符串。 */
export function toLocalISO(date) {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

/** 日期键 + 时刻 -> 本地 Date。 */
export function combine(dateKey, clock) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const [hh, mm] = clock.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

/** 日期键 + 时刻 -> 带偏移的 ISO 字符串。 */
export function combineToISO(dateKey, clock) {
  return toLocalISO(combine(dateKey, clock));
}

/** 当前时刻的带偏移 ISO 字符串。 */
export function nowISO(now = new Date()) {
  return toLocalISO(now);
}

/** 两个时刻相差的分钟数（to - from）。 */
export function minutesBetween(fromISO, toISO) {
  return Math.round((new Date(toISO).getTime() - new Date(fromISO).getTime()) / 60000);
}

/** 判断两个闭区间日期是否相交。 */
export function rangeOverlaps(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

/** 判断日期键是否落在闭区间内。 */
export function dateInRange(key, start, end) {
  return key >= start && key <= end;
}

/** 人类可读的日期描述，例如 `2025-10-20 周一`。 */
export function describeDate(key) {
  return `${key} ${WEEKDAY_NAMES[weekdayOf(key)]}`;
}
