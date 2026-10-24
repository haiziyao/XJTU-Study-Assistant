/**
 * 西交大作息时间表（11 节：上午 1-4、下午 5-8、晚上 9-11）。
 *
 * 官方来源：https://jwc.xjtu.edu.cn/xxfw/zxsj.htm
 * **每学年两套作息，切换日是 5 月 1 日与 10 月 1 日**：
 * - 夏、秋季（5/1 起）：第 5 节 14:30 开始，第 5 节起整体 +30 分钟；
 * - 冬、春季（10/1 起）：第 5 节 14:00 开始；
 * - 第 1-4 节两套完全相同；第 5 节起（含 9、10 节的晚上课）相差 30 分钟。
 *
 * 为什么必须硬编码：`wdkb` 的课表接口只给「第几节到第几节」（`KSJC` / `JSJC`），
 * **不给具体时刻** —— 时刻属于学校作息制度，没有接口可查。
 * 本表第 1-10 节与官网作息时间表逐值一致（有回归测试按官方表逐值断言）。
 *
 * 为什么分冬 / 夏两套、并且按**日期**选表：
 * 秋季学期 9 月开学，第 1-4 周的下午课在 9 月（夏季）、第 5 周起进 10 月（冬季），
 * 所以整学期用一套表一定会在某一边错半小时。`getClassTime()` 因此要求传入具体日期。
 *
 * 为什么 to-calendar.js 还要**按周切段**：
 * 日程的 `repeat` 只能有**一个**固定 startTime。一个「周次连续段」写一条日程时，
 * 跨 5/1 或 10/1 的下午课必然有一半日期错半小时。所以那边会先沿作息切换日把这种段
 * 切成两个（必要时多个）连续周次段，每段用自己的作息；上午课（1-4 节）两套相同，不切。
 * 切分规则与「周内切换按周一判定」的误差见 to-calendar.js 顶部说明。
 *
 * ⚠️ 第 11 节（冬季 21:10、夏季 21:40）**官方表未列**：官网作息表只列到第 10 节
 * （之后是就寝 22:30 / 22:00、熄灯 23:00 / 22:30）。这里保留旧实现（2026-01 真机核对）
 * 的第 11 节作为**兜底**：上游若真出现 11 节，宁可给一个近似时刻照常导入，
 * 也不要因为「表里没有」丢掉整条课。
 *
 * 越界节次一律抛错而不是返回 undefined：上游一旦出现第 12 节，
 * 静默产出「没有时间的日程」比直接报错更难排查。
 */

/** 上午：冬夏两套完全一致。 */
const MORNING = Object.freeze([
  Object.freeze({ period: 1, startTime: '08:00', endTime: '08:50' }),
  Object.freeze({ period: 2, startTime: '09:00', endTime: '09:50' }),
  Object.freeze({ period: 3, startTime: '10:10', endTime: '11:00' }),
  Object.freeze({ period: 4, startTime: '11:10', endTime: '12:00' }),
]);

/** 冬季（10 月 ~ 次年 4 月）：第 5-11 节（第 11 节为官方表未列的兜底，见文件头）。 */
const WINTER_AFTERNOON = Object.freeze([
  Object.freeze({ period: 5, startTime: '14:00', endTime: '14:50' }),
  Object.freeze({ period: 6, startTime: '15:00', endTime: '15:50' }),
  Object.freeze({ period: 7, startTime: '16:10', endTime: '17:00' }),
  Object.freeze({ period: 8, startTime: '17:10', endTime: '18:00' }),
  Object.freeze({ period: 9, startTime: '19:10', endTime: '20:00' }),
  Object.freeze({ period: 10, startTime: '20:10', endTime: '21:00' }),
  Object.freeze({ period: 11, startTime: '21:10', endTime: '22:00' }),
]);

/** 夏季（5 月 ~ 9 月）：与冬季只差「第 5 节起整体 +30 分钟」（第 11 节同为兜底）。 */
const SUMMER_AFTERNOON = Object.freeze([
  Object.freeze({ period: 5, startTime: '14:30', endTime: '15:20' }),
  Object.freeze({ period: 6, startTime: '15:30', endTime: '16:20' }),
  Object.freeze({ period: 7, startTime: '16:40', endTime: '17:30' }),
  Object.freeze({ period: 8, startTime: '17:40', endTime: '18:30' }),
  Object.freeze({ period: 9, startTime: '19:40', endTime: '20:30' }),
  Object.freeze({ period: 10, startTime: '20:40', endTime: '21:30' }),
  Object.freeze({ period: 11, startTime: '21:40', endTime: '22:30' }),
]);

/** 一学年共 11 节。 */
export const TOTAL_PERIODS = 11;

/**
 * 冬 / 夏作息**开始不同**的第一节：第 5 节。
 * 第 1-4 节两套表逐值相同，所以只含上午节次的课不需要按作息切换日切段（见 to-calendar.js）。
 */
export const FIRST_SEASON_SENSITIVE_PERIOD = 5;

export const WINTER_PERIODS = Object.freeze([...MORNING, ...WINTER_AFTERNOON]);
export const SUMMER_PERIODS = Object.freeze([...MORNING, ...SUMMER_AFTERNOON]);

/** 夏季作息的月份（含端点）：5 月 ~ 9 月。 */
export const SUMMER_MONTHS = Object.freeze([5, 6, 7, 8, 9]);

/** 作息标识，出现在预览里，前端据此提示「夏季作息」。 */
export const SEASON_LABEL = Object.freeze({ summer: '夏季作息', winter: '冬季作息' });

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function assertDateKey(dateKey) {
  const matched = typeof dateKey === 'string' ? DATE_KEY_RE.exec(dateKey) : null;
  if (!matched) throw new Error(`日期必须是 YYYY-MM-DD 格式，收到：${JSON.stringify(dateKey)}`);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error(`日期不是合法日期：${dateKey}`);
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

/** 作息标识 → 整套作息表（只读）。 */
export function periodsOfSeason(season) {
  if (season === 'summer') return SUMMER_PERIODS;
  if (season === 'winter') return WINTER_PERIODS;
  throw new Error(`作息必须是 'summer' 或 'winter'，收到：${JSON.stringify(season)}`);
}

/** 取单节次（越界抛错）。 */
export function getPeriodTime(period, dateKey) {
  const index = Number(period);
  if (!Number.isInteger(index) || index < 1 || index > TOTAL_PERIODS) {
    throw new Error(`节次必须是 1~${TOTAL_PERIODS} 之间的整数，收到：${JSON.stringify(period)}`);
  }
  return periodsOfDate(dateKey)[index - 1];
}

/** 节次是否合法（给合并 / 预览做过滤用）。 */
export function isValidPeriod(period) {
  return Number.isInteger(period) && period >= 1 && period <= TOTAL_PERIODS;
}

/**
 * 连堂课取「首节开始 → 末节结束」；按日期自动选冬 / 夏表。
 *
 * @param {number|string} startPeriod 起始节次（1~11）
 * @param {number|string} endPeriod 结束节次（1~11，且不早于起始节次）
 * @param {string} dateKey 该次课的日期（`YYYY-MM-DD`），用于判定冬 / 夏作息
 */
export function getClassTime(startPeriod, endPeriod, dateKey) {
  const { start, end } = assertPeriodRange(startPeriod, endPeriod);
  const startInfo = getPeriodTime(start, dateKey);
  const endInfo = getPeriodTime(end, dateKey);
  return {
    startTime: startInfo.startTime,
    endTime: endInfo.endTime,
    season: seasonOfDate(dateKey),
    startPeriod: start,
    endPeriod: end,
  };
}

/**
 * 按**作息**（而不是日期）取连堂课时间。
 *
 * 为什么还需要这个入口：to-calendar.js 把周次段沿作息切换日切开后，已经知道
 * 「整段用哪套作息」（按该周周一判定）。此时若再拿「段首那天的日期」反推，
 * 会与判定口径打架：例如该周周一是 9 月 29 日（夏季）、课程排在周日 10 月 5 日
 * （日期看已是冬季），按周判定整周仍属夏季。这里直接按 season 取表，口径只有一处。
 */
export function getClassTimeOfSeason(startPeriod, endPeriod, season) {
  const { start, end } = assertPeriodRange(startPeriod, endPeriod);
  const table = periodsOfSeason(season);
  return {
    startTime: table[start - 1].startTime,
    endTime: table[end - 1].endTime,
    season,
    startPeriod: start,
    endPeriod: end,
  };
}

/** 校验 1~11 节的连堂范围；失败抛错（错误语义见文件头）。 */
function assertPeriodRange(startPeriod, endPeriod) {
  const start = Number(startPeriod);
  const end = Number(endPeriod);
  if (!isValidPeriod(start)) throw new Error(`起始节次必须是 1~${TOTAL_PERIODS} 之间的整数，收到：${JSON.stringify(startPeriod)}`);
  if (!isValidPeriod(end)) throw new Error(`结束节次必须是 1~${TOTAL_PERIODS} 之间的整数，收到：${JSON.stringify(endPeriod)}`);
  if (end < start) throw new Error(`结束节次（${end}）不能早于起始节次（${start}）`);
  return { start, end };
}
