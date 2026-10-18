/**
 * 学期编号、周次位图、周次 ↔ 日期换算。
 *
 * 为什么需要这些：
 * `wdkb` 课表接口只告诉客户端「第几周、星期几、第几节」，**不给学期起始日、也不给总周数**。
 * - 起始日：`cxjcs.do` 有时能给 `XQKSRQ`，但历史学期基本为空 —— 拿不到时按校历惯例推断；
 * - 总周数：学校没有接口，按 18 周（普通学期）/ 8 周（小学期）硬编码，课表里实际最大周次更小时以实际为准。
 *
 * 学期编号形如 `2025-2026-1` / `2026-2027-2` / `2026-2027-3`（`-3` 是小学期）。
 */

import { isDateKey, toDateKey } from '../../shared/time.js';

/** 普通学期默认总周数。 */
export const DEFAULT_TERM_WEEKS = 18;
/** 小学期默认总周数。 */
export const SHORT_TERM_WEEKS = 8;

/**
 * 周次位图的长度上限。
 *
 * `SKZC` 每位代表一周（`"111111110000000000"`）。18 周学期是 18 位、小学期 8 位，
 * 这里给到 60 是防异常数据（例如上游把多个学期的位图拼在一起）——
 * 解析时超出部分直接忽略，而不是产出一个「第 200 周」的日程。
 */
export const MAX_WEEKS = 60;

const TERM_STRING_RE = /^(\d{4})-(\d{4})-([123])$/;
const WEEKDAY_CN = Object.freeze([null, '周一', '周二', '周三', '周四', '周五', '周六', '周日']);
const pad2 = (n) => String(n).padStart(2, '0');

/** 学期编号不合法。路由层翻译成 HTTP 400。 */
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
  if (!Number.isInteger(year) || ![1, 2, 3].includes(idx)) {
    throw new TermFormatError(`无法拼出学期编号：${JSON.stringify({ startYear, index })}`);
  }
  return `${year}-${year + 1}-${idx}`;
}

/** 是不是合法学期编号（不抛错的版本）。 */
export function isTermString(value) {
  try {
    parseTerm(value);
    return true;
  } catch {
    return false;
  }
}

/** 该学期的总周数：标准学期 18 周、小学期 8 周；允许调用方覆盖。 */
export function termLength(termOrParts, { normalWeeks = DEFAULT_TERM_WEEKS, shortWeeks = SHORT_TERM_WEEKS } = {}) {
  const parts = typeof termOrParts === 'string' ? parseTerm(termOrParts) : termOrParts;
  if (!parts || typeof parts.isShort !== 'boolean') throw new TermFormatError('termLength 需要学期编号或 parseTerm() 的结果');
  return parts.isShort ? shortWeeks : normalWeeks;
}

/** ISO 星期：1=周一 … 7=周日（与学校接口的 `SKXQ` 一致）。 */
export function isoWeekday(dateKey) {
  const key = requireDateKey(dateKey, 'dateKey');
  const [y, m, d] = key.split('-').map(Number);
  const day = new Date(y, m - 1, d).getDay();
  return day === 0 ? 7 : day;
}

/**
 * 第 N 周星期 dayOfWeek 的日期（dayOfWeek：1=周一 … 7=周日）。
 * `termStart` 必须是第一周周一（`validateTermStart` 会校验）。
 */
export function weekToDate(termStart, week, dayOfWeek = 1) {
  const start = requireDateKey(termStart, 'termStart');
  const weekNumber = Number(week);
  const weekday = Number(dayOfWeek);
  if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > MAX_WEEKS) {
    throw new Error(`周次必须是 1~${MAX_WEEKS} 之间的整数，收到：${JSON.stringify(week)}`);
  }
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) throw new Error(`星期必须是 1~7（1=周一），收到：${JSON.stringify(dayOfWeek)}`);
  return addDaysKey(start, (weekNumber - 1) * 7 + (weekday - 1));
}

/** 日期键加减天数。 */
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

/** 该月第一个周一。 */
export function firstMondayOfMonth(year, month) {
  const first = `${year}-${pad2(month)}-01`;
  const weekday = isoWeekday(first);
  return addDaysKey(first, -(weekday - 1));
}

/** 该月里离 1 号最近的周一（周一~周四取本周一、周五~周日取下周一）。 */
export function nearestMondayOfMonth(year, month) {
  const first = `${year}-${pad2(month)}-01`;
  const weekday = isoWeekday(first);
  return weekday <= 4 ? addDaysKey(first, -(weekday - 1)) : addDaysKey(first, 8 - weekday);
}

/**
 * 猜一个学期的第一周周一（`cxjcs.do` 拿不到时的兜底）：
 * - 第 1 学期（秋季）：当年 9 月的第一个周一；
 * - 第 2 学期（春季）：次年 3 月里离 3/1 最近的周一；
 * - 第 3 学期（小学期）：次年 7 月里离 7/1 最近的周一。
 *
 * 猜出来的值只作为兜底，返回值里带 `source: 'guess'`；预览响应会如实标注来源。
 */
export function guessTermStart(termOrParts) {
  const parts = typeof termOrParts === 'string' ? parseTerm(termOrParts) : termOrParts;
  if (!parts) throw new TermFormatError('guessTermStart 需要学期编号或 parseTerm() 的结果');
  const year = parts.startYear;
  if (parts.index === 1) return firstMondayOfMonth(year, 9);
  if (parts.index === 2) return nearestMondayOfMonth(year + 1, 3);
  return nearestMondayOfMonth(year + 1, 7);
}

/**
 * 校验「学期起始日」是否可用：
 * 1. 必须是周一（不是周一说明数据不对，或者学校给的不是第一周周一）；
 * 2. 展开后的学期区间不能夸张地超出该学年（防止把 2000 年的日期当成本学期）。
 *
 * @returns {{ok:boolean, reason?:string, endDate?:string, totalWeeks?:number}}
 */
export function validateTermStart(term, termStart, options) {
  const parts = typeof term === 'string' ? parseTerm(term) : term;
  let end;
  try {
    const start = requireDateKey(termStart, 'startDate');
    end = addDaysKey(start, termLength(parts, options) * 7 - 1);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  if (isoWeekday(termStart) !== 1) {
    return { ok: false, reason: `学期起始日必须是周一，${termStart} 是${WEEKDAY_CN[isoWeekday(termStart)]}`, startDate: termStart };
  }
  // 学年区间留出「9 月第一个周一落在 8 月底」「小学期 9 月上旬才结束」的余量。
  const lower = `${parts.startYear}-08-01`;
  const upper = `${parts.startYear + 1}-09-15`;
  if (termStart < lower || end > upper) {
    return { ok: false, reason: `按 ${termStart} 展开的学期区间（${termStart} ~ ${end}）超出了学年区间（${lower} ~ ${upper}）`, startDate: termStart, endDate: end };
  }
  return { ok: true, startDate: termStart, endDate: end, totalWeeks: termLength(parts, options) };
}

/* ------------------------------------------------------------------ 周次位图 */

/**
 * `SKZC` 位图 → 周次数组。
 *
 * 位图第 0 位 = 第 1 周，只有 `'1'` 算上课；其余字符（含空格、`0`）一律当「不上课」，
 * 避免上游掺进来的脏字符把整条数据搞坏。超过 `MAX_WEEKS` 的位直接忽略。
 *
 * @example bitmapToWeeks('111111110000000000') // [1,2,3,4,5,6,7,8]
 */
export function bitmapToWeeks(skzc) {
  if (skzc === undefined || skzc === null) return [];
  const text = String(skzc).trim();
  if (!text) return [];
  const weeks = [];
  const length = Math.min(text.length, MAX_WEEKS);
  for (let index = 0; index < length; index += 1) {
    if (text[index] === '1') weeks.push(index + 1);
  }
  return weeks;
}

/**
 * 周次数组 → 连续段。**这是「周次跨段要拆多条日程」的根因所在**：
 * 日程的 `repeat.until` 只能表达「从起始周到某周为止」的连续区间，
 * 表达不了 `{1-8, 10-16}` 这种中间空一周的集合；所以每一段必须写成独立的一条日程。
 *
 * @example weeksToRuns([1,2,3,4,7,8]) // [{start:1,end:4},{start:7,end:8}]
 */
export function weeksToRuns(weeks) {
  const list = [...new Set((weeks ?? []).map(Number))]
    .filter((week) => Number.isInteger(week) && week >= 1 && week <= MAX_WEEKS)
    .sort((a, b) => a - b);
  const runs = [];
  for (const week of list) {
    const last = runs[runs.length - 1];
    if (last && week === last.end + 1) last.end = week;
    else runs.push({ start: week, end: week });
  }
  return runs;
}

/** 周次集合的边界：`{min, max}`；空集合返回 `{min:null,max:null}`。 */
export function weeksBounds(weeks) {
  const list = [...new Set((weeks ?? []).map(Number))]
    .filter((week) => Number.isInteger(week) && week >= 1 && week <= MAX_WEEKS)
    .sort((a, b) => a - b);
  return { min: list[0] ?? null, max: list[list.length - 1] ?? null };
}

/** 把周次截断到 ≤ untilWeek（`untilWeek` 为空 = 不截断）。 */
export function clampWeeks(weeks, untilWeek) {
  if (untilWeek === undefined || untilWeek === null || untilWeek === '') return [...(weeks ?? [])];
  const limit = Number(untilWeek);
  return (weeks ?? []).filter((week) => Number(week) <= limit);
}

/** 人类可读的周次描述，例如 `[1,2,3,7]` → `"第1-3,7周"`。 */
export function describeWeeks(weeks) {
  const runs = weeksToRuns(weeks);
  if (!runs.length) return '无';
  return `第${runs.map((run) => (run.start === run.end ? `${run.start}` : `${run.start}-${run.end}`)).join(',')}周`;
}

function requireDateKey(value, field) {
  if (!isDateKey(value)) throw new Error(`${field} 必须是 YYYY-MM-DD 格式的合法日期，收到：${JSON.stringify(value)}`);
  return value;
}
