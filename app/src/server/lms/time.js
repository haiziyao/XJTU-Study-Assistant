/**
 * 思源学堂时间字段的解析。
 *
 * 学校接口返回的时间有两种形态：
 * 1. 带时区的 ISO 串：`2026-03-02T08:00:00+08:00` / `...Z`；
 * 2. 不带时区的裸串：`2026-03-02T08:00:00`（服务端按北京时间记录）。
 *
 * 两种都必须按「北京时间墙上时间」落到日历上：学生的课表不会因为
 * 笔记本时区设成了 UTC 就整体平移 8 小时，因此这里显式用 Asia/Shanghai
 * 换算，而不是依赖进程本地时区。
 */

const SHANGHAI = 'Asia/Shanghai';

const DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHANGHAI,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const CLOCK_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: SHANGHAI,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** 是否带时区信息（Z 或 ±HH:MM）。 */
function hasTimezone(value) {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

/**
 * 把思源学堂的时间串解析为 { date: 'YYYY-MM-DD', time: 'HH:mm' }。
 * 无法识别时返回 null（调用方决定是跳过还是退化为日期）。
 */
export function parseLmsTime(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;

  // 裸串：直接截取，不做时区换算（等价于「按北京时间直接读」）
  if (!hasTimezone(text)) {
    const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!match) return null;
    const [, y, m, d, hh, mm] = match;
    const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (hh === undefined) return { date, time: null, iso: null };
    return { date, time: `${String(hh).padStart(2, '0')}:${mm}`, iso: null };
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return {
    date: DATE_FORMAT.format(parsed),
    time: CLOCK_FORMAT.format(parsed),
    iso: parsed.toISOString(),
  };
}

/** 只要日期（`YYYY-MM-DD`），解析失败返回 null。 */
export function parseLmsDate(value) {
  return parseLmsTime(value)?.date ?? null;
}

/** 时刻（`HH:mm`），没有时刻信息时返回 null。 */
export function parseLmsClock(value) {
  return parseLmsTime(value)?.time ?? null;
}

/** `YYYY-MM-DD` 相差天数（b - a）。 */
export function daysBetween(a, b) {
  const toUtc = (key) => {
    const [y, m, d] = String(key).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}
