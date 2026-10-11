/**
 * 农历换算测试（`shared/lunar.js`）。
 *
 * 这组日期是**权威向量**，用来把算法焊死：
 * 参考实现（PotatoCalendar 的 utils/lunar.py）把闰月读错了位 —— 闰月月份在**低 4 位**
 * `info & 0xf`（不是 `(info >> 16) & 0xf`）、闰月天数在 **bit 16** `info & 0x10000`
 * （不是 `info & 0x10000` 之外的读法），导致约 99.7% 的日期偏差。
 * 数据表本身是对的，所以这里沿用旧表、只按标准编码读。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_LUNAR_SPAN_DAYS,
  festivalsOf,
  lunarDay,
  lunarRange,
  lunarText,
  solarToLunar,
  spanDays,
} from '../src/shared/lunar.js';

/** `正月初一` / `闰六月初一` 这种可读写法，便于和向量逐字对照。 */
function text(dateKey) {
  const lunar = solarToLunar(dateKey);
  if (!lunar) return 'undefined';
  return `${lunar.isLeapMonth ? '闰' : ''}${lunar.month}${lunar.day}`;
}

test('春节（正月初一）：1900-2100 抽查 14 年', () => {
  const springFestivals = {
    '1970-02-06': '正月初一',
    '1990-01-27': '正月初一',
    '2000-02-05': '正月初一',
    '2010-02-14': '正月初一',
    '2020-01-25': '正月初一',
    '2021-02-12': '正月初一',
    '2022-02-01': '正月初一',
    '2023-01-22': '正月初一',
    '2024-02-10': '正月初一',
    '2025-01-29': '正月初一',
    '2026-02-17': '正月初一',
    '2027-02-06': '正月初一',
    '2028-01-26': '正月初一',
    '2030-02-03': '正月初一',
  };
  for (const [dateKey, expected] of Object.entries(springFestivals)) {
    assert.equal(text(dateKey), expected, `${dateKey} 应是 ${expected}`);
    assert.deepEqual(festivalsOf(dateKey), ['春节'], `${dateKey} 应是春节`);
  }
});

test('闰月：2017/2020/2023/2025 的闰月初一（旧实现全错在这里）', () => {
  const leapMonths = {
    '2017-07-23': '闰六月初一',
    '2020-05-23': '闰四月初一',
    '2023-03-22': '闰二月初一',
    '2025-07-25': '闰六月初一',
  };
  for (const [dateKey, expected] of Object.entries(leapMonths)) {
    assert.equal(text(dateKey), expected, `${dateKey} 应是 ${expected}`);
    const lunar = solarToLunar(dateKey);
    assert.equal(lunar.isLeapMonth, true, `${dateKey} 的 isLeapMonth 应为 true`);
    // `month` 字段**不带**闰字，闰由 isLeapMonth 表达（与框架契约一致）
    assert.ok(!lunar.month.includes('闰'), `month 字段不应含「闰」：${lunar.month}`);
    assert.equal(lunar.dayNumber, 1);
  }
});

test('基准与边界：1900-01-31 是正月初一，2100-12-31 不抛错', () => {
  const base = solarToLunar('1900-01-31');
  assert.equal(`${base.month}${base.day}`, '正月初一');
  assert.equal(base.year, '庚子');
  assert.equal(base.zodiac, '鼠');

  const edge = solarToLunar('2100-12-31');
  assert.ok(edge, '2100-12-31 必须有结果（表覆盖到 2100）');
  assert.equal(edge.month, '腊月');
  assert.equal(edge.day, '初一');
  assert.equal(lunarText(edge), '庚申年腊月初一');
  // 表覆盖之外返回 undefined（而不是抛错）
  assert.equal(solarToLunar('1900-01-30'), undefined);
  assert.equal(solarToLunar('1899-12-31'), undefined);
  assert.equal(solarToLunar('不是日期'), undefined);
});

test('干支 / 生肖 / 月日名：2026-10-12 = 丙午年（马）九月初三', () => {
  const lunar = solarToLunar('2026-10-12');
  assert.deepEqual(lunar, {
    year: '丙午',
    zodiac: '马',
    month: '九月',
    day: '初三',
    isLeapMonth: false,
    monthNumber: 9,
    dayNumber: 3,
  });
  assert.equal(lunarText(lunar), '丙午年九月初三');
  // 闰月时文本要带「闰」
  assert.equal(lunarText(solarToLunar('2023-03-22')), '癸卯年闰二月初一');
});

test('农历节日：八节 + 除夕（除夕按「次日是正月初一」判定）', () => {
  const cases = {
    '2026-02-17': ['春节'],
    '2026-03-03': ['元宵'],
    '2026-06-19': ['端午'],
    '2026-08-19': ['七夕'],
    '2026-08-27': ['中元'],
    '2026-09-25': ['中秋'],
    '2026-10-18': ['重阳'],
    '2027-01-15': ['腊八'],
    '2026-02-16': ['除夕'],
  };
  for (const [dateKey, expected] of Object.entries(cases)) {
    assert.deepEqual(festivalsOf(dateKey), expected, `${dateKey} 的节日`);
  }
  // 普通日子没有节日
  assert.deepEqual(festivalsOf('2026-10-12'), []);
  assert.deepEqual(festivalsOf('2026-02-15'), []);
});

test('批量：lunarRange 含首尾、跳过越界日期、区间缓存友好', () => {
  const days = lunarRange('2026-10-11', '2026-10-13');
  assert.deepEqual(Object.keys(days), ['2026-10-11', '2026-10-12', '2026-10-13']);
  assert.equal(days['2026-10-12'].text, '丙午年九月初三');
  assert.deepEqual(days['2026-10-12'].festivals, []);
  assert.equal(days['2026-10-12'].lunar.dayNumber, 3);

  // 春节所在的那一周
  const week = lunarRange('2026-02-15', '2026-02-18');
  assert.deepEqual(week['2026-02-17'].festivals, ['春节']);
  assert.deepEqual(week['2026-02-16'].festivals, ['除夕']);

  // 越界：整个区间都在表外时返回空对象，不抛错
  assert.deepEqual(lunarRange('1899-01-01', '1899-12-31'), {});
  // 反向区间返回空
  assert.deepEqual(lunarRange('2026-10-13', '2026-10-11'), {});

  // 一整年：365 天都能拿到（年视图用）
  const year = lunarRange('2026-01-01', '2026-12-31');
  assert.equal(Object.keys(year).length, 365);
  assert.equal(year['2026-02-17'].festivals[0], '春节');

  assert.equal(spanDays('2026-01-01', '2026-12-31'), 364);
  assert.equal(spanDays('2026-01-02', '2026-01-01'), -1);
  assert.equal(MAX_LUNAR_SPAN_DAYS, 800);
});

test('lunarDay 的形状与 lunarText 一致（供 /meta/lunar 单日模式直接复用）', () => {
  const item = lunarDay('2026-02-17');
  assert.deepEqual(Object.keys(item).sort(), ['date', 'festivals', 'lunar', 'text']);
  assert.equal(item.date, '2026-02-17');
  assert.equal(item.text, '丙午年正月初一');
  assert.deepEqual(item.festivals, ['春节']);
  assert.equal(lunarDay('1899-01-01'), undefined);
});

/**
 * 2097 是常用那份农历表里唯一确定的错处：它把六月记成 30 天、七月记成 29 天
 * （应为 29 / 30），会让 2097-08-07 ~ 2097-09-05 整体差一天。
 * 下面按天文历（寿星天文历 sxtwl）钉死；改表就会红。
 */
test('2097：表里唯一的错处已按天文历校正', () => {
  assert.equal(lunarText(solarToLunar('2097-02-12')), '丁巳年正月初一');
  assert.equal(lunarText(solarToLunar('2097-08-06')), '丁巳年六月廿九');
  assert.equal(lunarText(solarToLunar('2097-08-07')), '丁巳年七月初一');
  assert.equal(lunarText(solarToLunar('2097-09-05')), '丁巳年七月三十');
  assert.equal(lunarText(solarToLunar('2097-09-06')), '丁巳年八月初一');
  // 校正只挪动六/七月之间的分界，整年长度不变 —— 次年春节不受影响
  assert.equal(lunarText(solarToLunar('2098-01-31')), '丁巳年腊月三十');
  assert.equal(lunarText(solarToLunar('2098-02-01')), '戊午年正月初一');
  // 相邻年份没被误改（2091 的 0x0d520 是原表值）
  assert.equal(lunarText(solarToLunar('2091-08-14')), '辛亥年六月三十');
});
