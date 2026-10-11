/**
 * 学期编号解析、起始日推断、周次 ↔ 日期换算。
 *
 * 为什么需要这些：
 * jwapp 课表接口只给「这是第几周、星期几」，**不给学期起始日，也不给总周数**
 * （`cxjcs.do` 有时能拿到 `XQKSRQ`，但历史学期基本拿不到；`one2020` 电子校历已废弃）。
 * 所以「周次 → 具体日期」这一步必须靠本地推断 + 缓存 + 允许手改，
 * 见 `docs/课表接入调研.md` 第 4 节：**起始日要当用户资产来管理**。
 *
 * 学期编号形如 `2025-2026-1` / `2026-2027-2` / `2026-2027-3`（`-3` 是小学期）。
 */

import { isDateKey, toDateKey } from '../../shared/time.js';

/** 普通学期（第 1/2 学期）的默认总周数：学校没有接口，只能硬编码。 */
export const DEFAULT_TERM_WEEKS = 18;
/** 小学期（第 3 学期）的默认总周数。 */
export const SHORT_TERM_WEEKS = 8;

const TERM_INDEXES = Object.freeze([1, 2, 3]);
const TERM_STRING_RE = /^(\d{4})-(\d{4})-([123])$/;
const WEEKDAY_CN = Object.freeze([null, '周一', '周二', '周三', '周四', '周五', '周六', '周日']);
const pad2 = (n) => String(n).padStart(2, '0');

/** 学期编号不合法。上层翻译成 HTTP 400。 */
export class TermFormatError extends Error {
  constructor(message, { term = null } = {}) {
    super(message);
    this.name = 'TermFormatError';
    this.code = 'TERM_FORMAT_INVALID';
    this.term = term;
  }
}

/**
 * 解析学期编号。
 * @param {string} term 例如 `2025-2026-1`
 * @returns {{term:string, academicYear:string, index:number, isShort:boolean, startYear:number}}
 */
export function parseTerm(term) {
  if (typeof term !== 'string') throw new TermFormatError(`学期编号必须是字符串，收到 ${typeof term}`, { term });
  const text = term.trim();
  const matched = TERM_STRING_RE.exec(text);
  if (!matched) {
    throw new TermFormatError(`学期编号格式不正确（应形如 2025-2026-1，-3 为小学期）：${JSON.stringify(term)}`, { term });
  }
  const startYear = Number(matched[1]);
  const endYear = Number(matched[2]);
  if (endYear !== startYear + 1) {
    throw new TermFormatError(`学期编号的学年不连续（应为 <年>-<年+1>-<学期>）：${text}`, { term: text });
  }
  const index = Number(matched[3]);
  return { term: text, academicYear: `${matched[1]}-${matched[2]}`, index, isShort: index === 3, startYear };
}

/** 学期对象 → 学期编号字符串。 */
export function formatTerm({ startYear, index }) {
  const year = Number(startYear);
  const idx = Number(index);
  if (!Number.isInteger(year) || !TERM_INDEXES.includes(idx)) {
    throw new TermFormatError(`无法拼出学期编号：${JSON.stringify({ startYear, index })}`);
  }
  return `${year}-${year + 1}-${idx}`;
}

/** 判断字符串是不是一个合法的学期编号（不抛错的版本）。 */
export function isTermString(value) {
  try {
    parseTerm(value);
    return true;
  } catch {
    return false;
  }
}

/** 该学期的总周数：标准学期 18 周，小学期 8 周。允许调用方覆盖（`config.totalWeeks`）。 */
export function termLength(termOrParts, { normalWeeks = DEFAULT_TERM_WEEKS, shortWeeks = SHORT_TERM_WEEKS } = {}) {
  const parts = typeof termOrParts === 'string' ? parseTerm(termOrParts) : termOrParts;
  if (!parts || typeof parts.isShort !== 'boolean') throw new TermFormatError('termLength 需要学期编号或 parseTerm() 的结果');
  return parts.isShort ? shortWeeks : normalWeeks;
}

/** 该学期最后一周的结束日（含）。 */
export function termEndDate(termStart, termOrParts, options) {
  const start = requireDateKey(termStart, 'termStart');
  const weeks = termLength(termOrParts, options);
  return addDaysKey(start, weeks * 7 - 1);
}

/** 该学期的日期区间（`start` 为第一周周一，`end` 为最后一周周日）。 */
export function termRange(termStart, termOrParts, options) {
  const start = requireDateKey(termStart, 'termStart');
  return { start, end: termEndDate(start, termOrParts, options) };
}

/** 把任意日期归一到所在周的周一。 */
export function normalizeToMonday(dateKey) {
  const key = requireDateKey(dateKey, 'dateKey');
  const weekday = isoWeekday(key); // 1=周一 .. 7=周日
  return addDaysKey(key, -(weekday - 1));
}

/** ISO 星期：1=周一 .. 7=周日（与学校接口的 `SKXQ` 一致）。 */
export function isoWeekday(dateKey) {
  const key = requireDateKey(dateKey, 'dateKey');
  const [y, m, d] = key.split('-').map(Number);
  const day = new Date(y, m - 1, d).getDay(); // 0=周日
  return day === 0 ? 7 : day;
}

/** 该月第一个周一。 */
export function firstMondayOfMonth(year, month) {
  const first = `${year}-${pad2(month)}-01`;
  return normalizeToMonday(first);
}

/**
 * 该月里离 1 号最近的周一（周一 ~ 周四取本周一、周五 ~ 周日取下周一）。
 * 学期 2、学期 3 的起始日都用这个规则：它们不像 9 月那样有「开学第一周」的确定说法。
 */
export function nearestMondayOfMonth(year, month) {
  const first = `${year}-${pad2(month)}-01`;
  const weekday = isoWeekday(first);
  if (weekday <= 4) return addDaysKey(first, -(weekday - 1));
  return addDaysKey(first, 8 - weekday);
}

/**
 * 猜一个学期的第一周周一（`cxjcs.do` 拿不到时的兜底）：
 * - 学期 1（秋季）：当年 9 月的第一个周一；
 * - 学期 2（春季）：当年 3 月里离 3/1 最近的周一；
 * - 学期 3（小学期）：当年 7 月里离 7/1 最近的周一。
 *
 * ⚠️ 猜出来的值只作为兜底，返回值里必须标 `source: 'guess'`，并且**永不被自动值覆盖**：
 * 用户手改过的起始日（`source: 'manual'`）优先于任何自动结果。
 */
export function guessTermStart(termOrParts) {
  const parts = typeof termOrParts === 'string' ? parseTerm(termOrParts) : termOrParts;
  if (!parts) throw new TermFormatError('guessTermStart 需要学期编号或 parseTerm() 的结果');
  const year = parts.startYear;
  if (parts.index === 1) return firstMondayOfMonth(year, 9);
  if (parts.index === 2) return nearestMondayOfMonth(year + 1, 3);
  return nearestMondayOfMonth(year + 1, 7);
}

/** 第 N 周星期 dayOfWeek 的日期（dayOfWeek：1=周一 .. 7=周日）。 */
export function weekToDate(termStart, week, dayOfWeek = 1) {
  const start = requireDateKey(termStart, 'termStart');
  const weekNumber = Number(week);
  const weekday = Number(dayOfWeek);
  if (!Number.isInteger(weekNumber) || weekNumber < 1) throw new Error(`周次必须是正整数，收到：${JSON.stringify(week)}`);
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) throw new Error(`星期必须是 1~7（1=周一），收到：${JSON.stringify(dayOfWeek)}`);
  return addDaysKey(start, (weekNumber - 1) * 7 + (weekday - 1));
}

/** `dateKey` 是该学期的第几周（1 起）；不在学期区间内返回 null。 */
export function dateToWeek(termStart, dateKey, { totalWeeks = DEFAULT_TERM_WEEKS } = {}) {
  const start = requireDateKey(termStart, 'termStart');
  const key = requireDateKey(dateKey, 'dateKey');
  const diff = daysBetweenKeys(start, key);
  if (diff < 0) return null;
  const week = Math.floor(diff / 7) + 1;
  if (week > totalWeeks) return null;
  return week;
}

/**
 * 校验一个「学期起始日」是否可用。
 *
 * 两个硬条件（见调研文档第 4 节）：
 * 1. 必须是周一 —— 不是周一说明用户填错了，或者学校给的不是第一周周一；
 * 2. 以它为起点算出来的最后一周周日，不能落到下一个学期的区间里（学年跨度内自洽）。
 *
 * @returns {{ok:boolean, reason?:string, startDate?:string, endDate?:string, totalWeeks?:number}}
 */
export function validateTermStart(term, termStart, options) {
  const parts = typeof term === 'string' ? parseTerm(term) : term;
  let start;
  let end;
  try {
    start = requireDateKey(termStart, 'startDate');
    end = termEndDate(start, parts, options);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  if (isoWeekday(start) !== 1) {
    return { ok: false, reason: `学期起始日必须是周一，${start} 是${WEEKDAY_CN[isoWeekday(start)]}`, startDate: start };
  }
  // 学年区间（留出「9 月第一个周一落在 8 月底」的余量）：
  // 秋季学期最早可能 8 月下旬开学，小学期最晚 9 月上旬才结束。
  const lower = `${parts.startYear}-08-01`;
  const upper = `${parts.startYear + 1}-09-15`;
  if (start < lower || end > upper) {
    return {
      ok: false,
      reason: `按 ${start} 展开的学期区间（${start} ~ ${end}）超出了学年区间（${lower} ~ ${upper}）`,
      startDate: start,
      endDate: end,
    };
  }
  return { ok: true, startDate: start, endDate: end, totalWeeks: termLength(parts, options) };
}

// ------------------------------------------------------------------ 内部小工具

function requireDateKey(value, field) {
  if (!isDateKey(value)) throw new Error(`${field} 必须是 YYYY-MM-DD 格式的合法日期，收到：${JSON.stringify(value)}`);
  return value;
}

/** 日期键加减天数（本模块自用，等价于 shared/time.js 的 addDays，但先做合法性校验）。 */
export function addDaysKey(dateKey, days) {
  const key = requireDateKey(dateKey, 'dateKey');
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + Number(days));
  return toDateKey(date);
}

/** 两个日期键相差的天数（b - a）。 */
export function daysBetweenKeys(a, b) {
  const toUtc = (key) => {
    const [y, m, d] = requireDateKey(key, 'dateKey').split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}
