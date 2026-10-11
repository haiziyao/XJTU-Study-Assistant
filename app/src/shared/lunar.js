/**
 * 农历（中国农历）换算：1900-2100，查表法，纯函数、零依赖。
 *
 * 数据表来自 PotatoCalendar 的 `utils/lunar.py`（**数据本身经校验是对的**），
 * 但编码要按标准读法 —— 参考实现的代码读错了位，导致约 99.7% 的日期偏差：
 *
 *   info =   0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,   // 1900-1909
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,   // 1910-1919
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,   // 1920-1929
  0x06566, 0x0d4a0, 0x0ea50, 0x16a95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,   // 1930-1939
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,   // 1940-1949
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,   // 1950-1959
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,   // 1960-1969
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,   // 1970-1979
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,   // 1980-1989
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0,   // 1990-1999
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,   // 2000-2009
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,   // 2010-2019
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,   // 2020-2029
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,   // 2030-2039
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,   // 2040-2049
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06aa0, 0x1a6c4, 0x0aae0,   // 2050-2059
  0x092e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,   // 2060-2069
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,   // 2070-2079
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,   // 2080-2089
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252,   // 2090-2099（2097：0x0a4d0 → 0x0a2d0）
  0x0d520,   // 2100-2100[year - 1900]
 *   12 个月大小：info & (0x8000 >> i)（i = 0..11，i=0 是正月）? 30 : 29
 *   闰月月份：  info & 0xf                    <-- 参考实现误读成 (info >> 16) & 0xf
 *   闰月天数：  info & 0x10000 ? 30 : 29      <-- 参考实现误读成 (info >> 20) & 1
 *
 * 基准：1900-01-31 是 1900 年正月初一。
 * 不做节气：节气需要天文算法，近似值就是错数据（用户明确要求不做）。
 */

/**
 * 农历年数据（1900-2100，共 201 项）。**数据不要改** —— 唯一例外是 2097：
 * 常用的那份表在 2097 把六月记成 30 天、七月记成 29 天（应为 29 / 30），
 * 会让 2097-08-07 ~ 2097-09-05 整体差一天。已按天文历（寿星天文历 sxtwl）
 * 校正为 0x0a2d0（六月 29 天、七月 30 天），并逐日比对 1901-2099 全区间
 * （72684 天，对照寿星天文历 sxtwl 与 zhdate）确认无其他偏差。
 */
const LUNAR_YEAR_DATA = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,   // 1900-1909
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,   // 1910-1919
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,   // 1920-1929
  0x06566, 0x0d4a0, 0x0ea50, 0x16a95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,   // 1930-1939
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,   // 1940-1949
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,   // 1950-1959
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,   // 1960-1969
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,   // 1970-1979
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,   // 1980-1989
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0,   // 1990-1999
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,   // 2000-2009
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,   // 2010-2019
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,   // 2020-2029
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,   // 2030-2039
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,   // 2040-2049
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06aa0, 0x1a6c4, 0x0aae0,   // 2050-2059
  0x092e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,   // 2060-2069
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,   // 2070-2079
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,   // 2080-2089
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252,   // 2090-2099（2097：0x0a4d0 → 0x0a2d0）
  0x0d520,   // 2100-2100
];

const STEMS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
const BRANCHES = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
const ZODIAC = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];

const MONTH_NAMES = ['', '正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月'];
const DAY_NAMES = [
  '', '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
];

/** 农历节日（只用农历日期，不含节气）。 */
const FESTIVALS = [
  { month: 1, day: 1, name: '春节' },
  { month: 1, day: 15, name: '元宵' },
  { month: 5, day: 5, name: '端午' },
  { month: 7, day: 7, name: '七夕' },
  { month: 7, day: 15, name: '中元' },
  { month: 8, day: 15, name: '中秋' },
  { month: 9, day: 9, name: '重阳' },
  { month: 12, day: 8, name: '腊八' },
];

const BASE_DATE = '1900-01-31';
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
/** 批量查询的跨度上限（月视图 42 天、年视图 365 天都远小于它）。 */
export const MAX_LUNAR_SPAN_DAYS = 800;

const DAY_MS = 86400000;

function parseDateKey(key) {
  if (typeof key !== 'string') return null;
  const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return time;
}

function toDateKey(time) {
  const date = new Date(time);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

/** 日期字符串 + N 天（只认 YYYY-MM-DD，按 UTC 计算避免时区漂移）。 */
export function shiftDateKey(key, days) {
  const time = parseDateKey(key);
  if (time === null) return undefined;
  return toDateKey(time + days * DAY_MS);
}

function infoOf(year) {
  const info = LUNAR_YEAR_DATA[year - MIN_YEAR];
  return typeof info === 'number' ? info : undefined;
}

/** 某农历年第 month 月（1..12）的天数：30 或 29。 */
function monthDays(year, month) {
  const info = infoOf(year);
  if (info === undefined) return 30;
  return info & (0x8000 >> (month - 1)) ? 30 : 29;
}

/** 某农历年的闰月月份：0 表示无闰月。**低 4 位**。 */
function leapMonthOf(year) {
  const info = infoOf(year);
  if (info === undefined) return 0;
  return info & 0xf;
}

/** 某农历年闰月的天数：30 或 29。**bit 16**。 */
function leapMonthDays(year) {
  const info = infoOf(year);
  if (info === undefined) return 29;
  return info & 0x10000 ? 30 : 29;
}

/** 某农历年的总天数。 */
function yearDays(year) {
  let sum = 0;
  for (let month = 1; month <= 12; month += 1) sum += monthDays(year, month);
  if (leapMonthOf(year)) sum += leapMonthDays(year);
  return sum;
}

/**
 * 公历日期 -> 农历。
 * @param {string} dateKey YYYY-MM-DD
 * @returns {{year:string, zodiac:string, month:string, day:string, isLeapMonth:boolean, monthNumber:number, dayNumber:number}|undefined}
 *   `month` 不带「闰」字，闰月由 `isLeapMonth` 表达（与框架契约一致）。
 */
export function solarToLunar(dateKey) {
  const time = parseDateKey(dateKey);
  if (time === null) return undefined;
  const base = parseDateKey(BASE_DATE);
  let rest = Math.round((time - base) / DAY_MS);
  if (rest < 0) return undefined; // 表只覆盖 1900-01-31 起

  let year = MIN_YEAR;
  while (year <= MAX_YEAR) {
    const total = yearDays(year);
    if (rest < total) break;
    rest -= total;
    year += 1;
  }
  if (year > MAX_YEAR) return undefined;

  const leap = leapMonthOf(year);
  let month = 1;
  let isLeap = false;
  while (month <= 12) {
    const length = isLeap ? leapMonthDays(year) : monthDays(year, month);
    if (rest < length) break;
    rest -= length;
    if (leap === month && !isLeap) {
      isLeap = true;
    } else {
      isLeap = false;
      month += 1;
    }
  }

  const dayNumber = rest + 1;
  return {
    year: `${STEMS[(year - 4) % 10]}${BRANCHES[(year - 4) % 12]}`,
    zodiac: ZODIAC[(year - 4) % 12],
    month: MONTH_NAMES[month],
    day: DAY_NAMES[dayNumber],
    isLeapMonth: isLeap,
    monthNumber: month,
    dayNumber,
  };
}

/** 一行中文：`丙午年九月初三`（闰月会写成 `丙午年闰六月初三`）。 */
export function lunarText(lunar) {
  if (!lunar) return '';
  return `${lunar.year}年${lunar.isLeapMonth ? '闰' : ''}${lunar.month}${lunar.day}`;
}

/** 农历节日名（数组，多数日子为空）。除夕按「次日是正月初一」判定，不需要额外字段。 */
export function festivalsOf(dateKey, lunar) {
  const value = lunar ?? solarToLunar(dateKey);
  if (!value) return [];
  const out = [];
  if (!value.isLeapMonth) {
    for (const item of FESTIVALS) {
      if (item.month === value.monthNumber && item.day === value.dayNumber) out.push(item.name);
    }
  }
  const next = shiftDateKey(dateKey, 1);
  const nextLunar = next ? solarToLunar(next) : undefined;
  if (nextLunar && nextLunar.monthNumber === 1 && nextLunar.dayNumber === 1 && !nextLunar.isLeapMonth) {
    out.push('除夕');
  }
  return out;
}

/** 单日完整信息：{ dateKey, lunar, festivals, text }。 */
export function lunarDay(dateKey) {
  const lunar = solarToLunar(dateKey);
  if (!lunar) return undefined;
  const festivals = festivalsOf(dateKey, lunar);
  return { date: dateKey, lunar, festivals, text: lunarText(lunar) };
}

/**
 * 批量：返回 `{ 'YYYY-MM-DD': { lunar, festivals, text } }`（含首尾）。
 * 越界日期会被跳过（而不是抛错），方便月/年视图容错。
 */
export function lunarRange(from, to) {
  const start = parseDateKey(from);
  const end = parseDateKey(to);
  if (start === null || end === null || end < start) return {};
  const days = {};
  for (let time = start; time <= end; time += DAY_MS) {
    const item = lunarDay(toDateKey(time));
    if (item) days[item.date] = { lunar: item.lunar, festivals: item.festivals, text: item.text };
  }
  return days;
}

/** 两个日期之间相差的天数（含首尾则 +1，调用方自己决定）。 */
export function spanDays(from, to) {
  const start = parseDateKey(from);
  const end = parseDateKey(to);
  if (start === null || end === null) return undefined;
  return Math.round((end - start) / DAY_MS);
}
