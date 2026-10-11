/**
 * 重复规则展开（结构化 recurrence，替代 PotatoCalendar 里“逐日取模”的隐式规则）。
 *
 * 字段约定：
 * - repeat.type: none | daily | weekly | monthly | yearly | weekday
 * - repeat.interval: >=1，例如每两周 -> interval=2
 * - repeat.weekdays: ISO 星期（1=周一 … 7=周日），weekly / weekday 使用
 * - repeat.until: { mode: 'never' | 'date' | 'count', date?: 'YYYY-MM-DD', count?: number }
 *
 * 说明：展开是「查询期内的惰性展开」，不落库实例，因此天然支持后续修改规则。
 */

import { addDays, fromDateKey, toDateKey, weekdayOf } from '../../shared/time.js';

const MAX_EXPAND_DAYS = 366 * 10;

/** ISO 星期：1=周一 … 7=周日。 */
export function isoWeekday(dateKey) {
  const day = weekdayOf(dateKey);
  return day === 0 ? 7 : day;
}

function diffDays(fromKey, toKey) {
  return Math.round((fromDateKey(toKey).getTime() - fromDateKey(fromKey).getTime()) / 86400000);
}

function isLastDayOfMonth(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return d === new Date(y, m, 0).getDate();
}

function monthDiff(fromKey, toKey) {
  const [fy, fm] = fromKey.split('-').map(Number);
  const [ty, tm] = toKey.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

/** 判断某个日期是否命中重复规则（不含 until.count 判断，由展开器计数处理）。 */
export function matchesRepeat(dateKey, anchorKey, repeat) {
  if (!repeat || repeat.type === 'none') return dateKey === anchorKey;
  if (dateKey < anchorKey) return false;
  const interval = Math.max(1, repeat.interval ?? 1);
  const weekdays = repeat.weekdays?.length ? repeat.weekdays : [isoWeekday(anchorKey)];

  switch (repeat.type) {
    case 'daily':
      return diffDays(anchorKey, dateKey) % interval === 0;
    case 'weekly':
      return (
        weekdays.includes(isoWeekday(dateKey)) &&
        Math.floor(diffDays(anchorKey, dateKey) / 7) % interval === 0
      );
    case 'monthly': {
      const sameDay =
        Number(dateKey.slice(8, 10)) === Number(anchorKey.slice(8, 10)) ||
        (isLastDayOfMonth(anchorKey) && isLastDayOfMonth(dateKey));
      return sameDay && monthDiff(anchorKey, dateKey) % interval === 0;
    }
    case 'yearly': {
      const sameMonth = dateKey.slice(5, 7) === anchorKey.slice(5, 7);
      const sameDay =
        dateKey.slice(8, 10) === anchorKey.slice(8, 10) ||
        (isLastDayOfMonth(anchorKey) && isLastDayOfMonth(dateKey));
      return sameMonth && sameDay && Number(dateKey.slice(0, 4)) % interval === Number(anchorKey.slice(0, 4)) % interval;
    }
    case 'weekday':
      return [1, 2, 3, 4, 5].includes(isoWeekday(dateKey));
    default:
      return false;
  }
}

/**
 * 展开某条记录在 [from, to] 区间内命中的日期。
 * @param {object} params
 * @param {string} params.anchorKey 重复锚点日期（首次发生日）
 * @param {string} [params.endKey]  硬性结束日期（事件区间用；重复事件也受其约束）
 * @param {object} [params.repeat]
 * @param {string} [params.from]
 * @param {string} [params.to]
 * @returns {string[]} 命中的日期键（升序）
 */
export function expandDates({ anchorKey, endKey, repeat, from, to }) {
  const rangeStart = from && from > anchorKey ? from : anchorKey;
  const hardEnd = endKey && endKey > anchorKey ? endKey : undefined;
  const rangeEnd = to && hardEnd ? (to < hardEnd ? to : hardEnd) : to ?? hardEnd ?? anchorKey;

  if (rangeEnd < rangeStart) return [];

  const until = repeat?.until;
  if (until?.mode === 'date' && until.date && rangeEnd > until.date) {
    return expandDates({ anchorKey, endKey, repeat: { ...repeat, until: { mode: 'never' } }, from, to: until.date });
  }

  const dates = [];
  let cursor = rangeStart;
  let guard = 0;
  while (cursor <= rangeEnd && guard < MAX_EXPAND_DAYS) {
    if (matchesRepeat(cursor, anchorKey, repeat)) {
      dates.push(cursor);
      if (until?.mode === 'count' && until.count && dates.length >= until.count) break;
    }
    cursor = addDays(cursor, 1);
    guard += 1;
  }

  // 非重复记录：事件区间要整段覆盖，而不是只命中锚点当天
  if (!repeat || repeat.type === 'none') {
    if (!endKey || endKey <= anchorKey) return dates.slice(0, 1);
    const spanned = [];
    let day = rangeStart;
    let spanGuard = 0;
    while (day <= rangeEnd && spanGuard < MAX_EXPAND_DAYS) {
      spanned.push(day);
      day = addDays(day, 1);
      spanGuard += 1;
    }
    return spanned;
  }

  return dates;
}

/** 把 ISO 星期数组渲染成中文描述，用于 explain。 */
export function describeRepeat(repeat) {
  if (!repeat || repeat.type === 'none') return '不重复';
  const names = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const every = repeat.interval > 1 ? `每${repeat.interval}` : '每';
  switch (repeat.type) {
    case 'daily':
      return `${every}天`;
    case 'weekly':
      return `${every}周 ${(repeat.weekdays ?? []).map((d) => names[d]).join('、')}`.trim();
    case 'monthly':
      return `${every}月`;
    case 'yearly':
      return `${every}年`;
    case 'weekday':
      return '每个工作日';
    default:
      return repeat.type;
  }
}

export { toDateKey };
