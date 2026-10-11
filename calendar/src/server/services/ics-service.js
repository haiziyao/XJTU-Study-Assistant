/**
 * iCalendar（RFC 5545）导出。
 *
 * 对齐 dschat 2 的 ICS 能力（其 UID 形如 `<id>@dschat`），差异说明：
 * - 全天事项的 DTEND 使用**次日**（RFC 5545 中 DTEND 为开区间），dschat 2 用的是同一天；
 * - 重复规则完整导出 RRULE（含 INTERVAL / BYDAY / UNTIL / COUNT），dschat 2 只支持 FREQ+INTERVAL+UNTIL；
 * - 时间输出为**浮动本地时间**（无 Z、无 TZID），与 dschat 2 一致。
 */

const pad2 = (n) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` -> `YYYYMMDD` */
function dateKeyToIcs(key) {
  return key.replace(/-/g, '');
}

/** `YYYY-MM-DD` + `HH:mm` -> `YYYYMMDDTHHmmss`（浮动时间） */
function dateTimeToIcs(dateKey, clock) {
  return `${dateKeyToIcs(dateKey)}T${(clock ?? '00:00').replace(':', '')}00`;
}

/** Date -> UTC 基本格式 `YYYYMMDDTHHmmssZ` */
function utcStamp(date = new Date()) {
  return (
    `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}` +
    `T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`
  );
}

/** ICS 文本转义。 */
function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

const BYDAY = ['', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/** 本模块 repeat -> RRULE 值。 */
export function toRrule(repeat) {
  if (!repeat || repeat.type === 'none') return undefined;
  const interval = Math.max(1, repeat.interval ?? 1);
  const parts = [];
  switch (repeat.type) {
    case 'daily':
      parts.push('FREQ=DAILY');
      break;
    case 'weekly':
      parts.push('FREQ=WEEKLY');
      if (repeat.weekdays?.length) parts.push(`BYDAY=${repeat.weekdays.map((d) => BYDAY[d]).join(',')}`);
      break;
    case 'monthly':
      parts.push('FREQ=MONTHLY');
      break;
    case 'yearly':
      parts.push('FREQ=YEARLY');
      break;
    case 'weekday':
      parts.push('FREQ=WEEKLY', 'BYDAY=MO,TU,WE,TH,FR');
      break;
    default:
      return undefined;
  }
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (repeat.until?.mode === 'date' && repeat.until.date) {
    parts.push(`UNTIL=${dateKeyToIcs(repeat.until.date)}T235959Z`);
  } else if (repeat.until?.mode === 'count' && repeat.until.count) {
    parts.push(`COUNT=${repeat.until.count}`);
  }
  return parts.join(';');
}

function veventFromSchedule(item, stamp) {
  const lines = ['BEGIN:VEVENT', `UID:${item.id}@potato-calendar`, `DTSTAMP:${stamp}`];
  if (item.allDay || !item.startTime) {
    lines.push(`DTSTART;VALUE=DATE:${dateKeyToIcs(item.date)}`);
    lines.push(`DTEND;VALUE=DATE:${dateKeyToIcs(addOneDay(item.date))}`);
  } else {
    lines.push(`DTSTART:${dateTimeToIcs(item.date, item.startTime)}`);
    lines.push(`DTEND:${dateTimeToIcs(item.date, item.endTime ?? item.startTime)}`);
  }
  lines.push(`SUMMARY:${escapeText(item.title)}`);
  if (item.description) lines.push(`DESCRIPTION:${escapeText(item.description)}`);
  if (item.location) lines.push(`LOCATION:${escapeText(item.location)}`);
  lines.push(`CATEGORIES:${escapeText(item.category ?? 'other')}`);
  lines.push(`STATUS:${item.status === 'done' ? 'COMPLETED' : item.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`);
  const rrule = toRrule(item.repeat);
  if (rrule) lines.push(`RRULE:${rrule}`);
  lines.push('END:VEVENT');
  return lines;
}

function veventFromEvent(item, stamp) {
  const lines = ['BEGIN:VEVENT', `UID:${item.id}@potato-calendar`, `DTSTAMP:${stamp}`];
  lines.push(`DTSTART;VALUE=DATE:${dateKeyToIcs(item.startDate)}`);
  lines.push(`DTEND;VALUE=DATE:${dateKeyToIcs(addOneDay(item.endDate ?? item.startDate))}`);
  lines.push(`SUMMARY:${escapeText(item.title)}`);
  if (item.description) lines.push(`DESCRIPTION:${escapeText(item.description)}`);
  lines.push(`CATEGORIES:${escapeText(item.category ?? 'other')}`);
  const rrule = toRrule(item.repeat);
  if (rrule) lines.push(`RRULE:${rrule}`);
  lines.push('END:VEVENT');
  return lines;
}

function addOneDay(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d + 1);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/**
 * 生成整份日历。
 * @param {object} params
 * @param {object[]} params.events   原始日历事件
 * @param {object[]} params.schedules 原始日程
 * @param {string} [params.calendarName]
 * @param {Date} [params.now]
 */
export function buildIcs({ events = [], schedules = [], calendarName = 'Potato Calendar', now = new Date() }) {
  const stamp = utcStamp(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Potato Calendar//Calendar+Schedule//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];
  for (const item of events) lines.push(...veventFromEvent(item, stamp));
  for (const item of schedules) {
    if (item.status === 'cancelled') continue;
    lines.push(...veventFromSchedule(item, stamp));
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
