/**
 * 西交大作息时间表（11 节，分块：上午 1-4、下午 5-8、晚上 9-11）。
 *
 * 为什么单独一个文件、还要写死数据：
 * 课表接口只给「第几节到第几节」（KSJC/JSJC），**不给具体时刻**，时刻是学校的作息制度，
 * 只能硬编码。数据逐值抄自 `docs/课表接入调研.md` 第 2 节（另一路调研已核对过校历与教务公告）。
 *
 * 为什么分冬/夏两套并且必须按日期选表：
 * 5 月起至 9 月为夏季作息（`month ∈ {5..9}`），第 1-4 节两套完全相同，第 5 节起整体后移 30 分钟。
 * 秋季学期（9 月开学）的下午课会横跨 9 月与 10 月 —— 9 月还是夏季作息、10 月已经切成冬季作息，
 * 所以**绝不能整学期用一套表**，必须在展开每一条日程时按那一天的日期现选。
 *
 * 越界节次一律抛错而不是返回 undefined：
 * 上游一旦改了节次编码（比如出现第 12 节），静默产出 `undefined` 会变成「日程没有时间」
 * 这种更难排查的问题；宁可让这条数据带着明确错误暴露出来。
 */

/** 上午：两套作息完全一致。 */
const MORNING = Object.freeze([
  Object.freeze({ period: 1, startTime: '08:00', endTime: '08:50' }),
  Object.freeze({ period: 2, startTime: '09:00', endTime: '09:50' }),
  Object.freeze({ period: 3, startTime: '10:10', endTime: '11:00' }),
  Object.freeze({ period: 4, startTime: '11:10', endTime: '12:00' }),
]);

/** 冬季（10 月 ~ 次年 4 月）：第 5-11 节。 */
const WINTER_AFTERNOON = Object.freeze([
  Object.freeze({ period: 5, startTime: '14:00', endTime: '14:50' }),
  Object.freeze({ period: 6, startTime: '15:00', endTime: '15:50' }),
  Object.freeze({ period: 7, startTime: '16:10', endTime: '17:00' }),
  Object.freeze({ period: 8, startTime: '17:10', endTime: '18:00' }),
  Object.freeze({ period: 9, startTime: '19:10', endTime: '20:00' }),
  Object.freeze({ period: 10, startTime: '20:10', endTime: '21:00' }),
  Object.freeze({ period: 11, startTime: '21:10', endTime: '22:00' }),
]);

/** 夏季（5 月 ~ 9 月）：与冬季的差别只有第 5 节起整体 +30 分钟。 */
const SUMMER_AFTERNOON = Object.freeze([
  Object.freeze({ period: 5, startTime: '14:30', endTime: '15:20' }),
  Object.freeze({ period: 6, startTime: '15:30', endTime: '16:20' }),
  Object.freeze({ period: 7, startTime: '16:40', endTime: '17:30' }),
  Object.freeze({ period: 8, startTime: '17:40', endTime: '18:30' }),
  Object.freeze({ period: 9, startTime: '19:40', endTime: '20:30' }),
  Object.freeze({ period: 10, startTime: '20:40', endTime: '21:30' }),
  Object.freeze({ period: 11, startTime: '21:40', endTime: '22:30' }),
]);

/** 一学年共 11 节（1-4 上午、5-8 下午、9-11 晚上）。 */
export const TOTAL_PERIODS = 11;

export const WINTER_PERIODS = Object.freeze([...MORNING, ...WINTER_AFTERNOON]);
export const SUMMER_PERIODS = Object.freeze([...MORNING, ...SUMMER_AFTERNOON]);

/** 夏季作息的月份（含端点）：5 月 ~ 9 月。 */
export const SUMMER_MONTHS = Object.freeze([5, 6, 7, 8, 9]);

/** 作息标识，出现在接口返回值里，前端据此提示「夏季作息」。 */
export const SEASON_LABEL = Object.freeze({ summer: '夏季作息', winter: '冬季作息' });

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function assertDateKey(dateKey) {
  const matched = typeof dateKey === 'string' ? DATE_KEY_RE.exec(dateKey) : null;
  if (!matched) {
    throw new Error(`日期必须是 YYYY-MM-DD 格式，收到：${JSON.stringify(dateKey)}`);
  }
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`日期不是合法日期：${dateKey}`);
  }
  return { month, day };
}

/** 该日期用哪一套作息：`'summer'` 或 `'winter'`。 */
export function seasonOfDate(dateKey) {
  const { month } = assertDateKey(dateKey);
  return SUMMER_MONTHS.includes(month) ? 'summer' : 'winter';
}

/** 该日期是否夏季作息。 */
export function isSummerTime(dateKey) {
  return seasonOfDate(dateKey) === 'summer';
}

/** 该日期对应的整套作息表（只读）。 */
export function periodsOfDate(dateKey) {
  return isSummerTime(dateKey) ? SUMMER_PERIODS : WINTER_PERIODS;
}

/** 取单节次（越界抛错）。 */
export function getPeriodTime(period, dateKey) {
  const index = Number(period);
  if (!Number.isInteger(index) || index < 1 || index > TOTAL_PERIODS) {
    throw new Error(`节次必须是 1~${TOTAL_PERIODS} 之间的整数，收到：${JSON.stringify(period)}`);
  }
  return periodsOfDate(dateKey)[index - 1];
}

/**
 * 连堂课取「首节开始 → 末节结束」；按日期自动选冬/夏表。
 *
 * @param {number|string} startPeriod 起始节次（1~11）
 * @param {number|string} endPeriod   结束节次（1~11，且不早于起始节）
 * @param {string} dateKey 该次课的日期（`YYYY-MM-DD`），用于判定冬/夏作息
 * @returns {{startTime:string,endTime:string,season:'summer'|'winter',startPeriod:number,endPeriod:number}}
 */
export function getClassTime(startPeriod, endPeriod, dateKey) {
  const start = Number(startPeriod);
  const end = Number(endPeriod);
  const startInfo = getPeriodTime(start, dateKey);
  const endInfo = getPeriodTime(end, dateKey);
  if (end < start) {
    throw new Error(`结束节次（${end}）不能早于起始节次（${start}）`);
  }
  const season = seasonOfDate(dateKey);
  return {
    startTime: startInfo.startTime,
    endTime: endInfo.endTime,
    season,
    startPeriod: start,
    endPeriod: end,
  };
}

/** 节次所在的时间块，用于界面分组（上午 / 下午 / 晚上）。 */
export function blockOfPeriod(period) {
  const index = Number(period);
  if (index >= 1 && index <= 4) return 'morning';
  if (index >= 5 && index <= 8) return 'afternoon';
  if (index >= 9 && index <= TOTAL_PERIODS) return 'evening';
  throw new Error(`节次必须是 1~${TOTAL_PERIODS} 之间的整数，收到：${JSON.stringify(period)}`);
}
