/**
 * 成长模块的时间工具：全部按**本机本地时区**切日。
 *
 * 为什么不直接用 `shared/time.js`：
 * 源项目（Brain Online）的会话存档、任务截止时刻、周报都依赖「带时区偏移的 ISO 字符串」
 * 与「本地日期键」，而 `shared/time.js` 只提供日期键与 `HH:mm`，没有 `iso()` / `lastDays()`
 * 这些语义。这里保留源项目那份实现（连同注释里的理由），避免两边口径漂移。
 *
 * 为什么不跟 UTC 走：这个模块的使用场景是"今天状态怎么样、今天要做什么"，
 * 用户说的"今天"永远是本机墙上的日期。用 UTC 切日会让 GMT+8 的用户在早上 8 点前
 * 录入的数据算到前一天，日记与连击都会错位。
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO 字符串（带本地时区偏移，人类可读、可排序）。 */
export function iso(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

/** 本地日期键 `YYYY-MM-DD`。 */
export function dateKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 日期键 → 本地零点。 */
export function startOfDay(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

/** 日期键 → 当天 23:59:59.999。 */
export function endOfDay(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999);
}

/** 日期键平移 n 天（可为负）。 */
export function addDays(key, n) {
  const d = startOfDay(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

/** 两个日期键相差的天数（a - b）。 */
export function diffDays(a, b) {
  return Math.round((startOfDay(a) - startOfDay(b)) / DAY_MS);
}

/**
 * 日期键是否**真的存在**（不只是长得像）。
 * 只做正则会把 2026-13-99、2026-02-30 放过去 —— 那种值一路带进 Map 与比较里，
 * 得到的是一堆"没有报错但不对"的数据。
 */
export function isValidDateKey(value) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  if (m < 1 || m > 12) return false;
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/** 最近 n 天的日期键，从早到晚（含今天）。 */
export function lastDays(n, now = new Date()) {
  const today = dateKey(now);
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(today, -i));
  return out;
}

/**
 * 可注入的时钟。测试里换成固定时间，业务代码永远不用直接 new Date()。
 *
 * `createServer({ growth: { now: () => new Date(...) } })` 是给测试注入假时钟的入口：
 * 98 个源用例里有大量「今天 = 2026-10-26」「明天 = 2026-10-27」的断言，
 * 不注入时钟就只能在 2026 年某一天跑绿。
 */
export function fixedClock(value) {
  const t = value instanceof Date ? value : new Date(value);
  return { now: () => new Date(t) };
}

export function systemClock() {
  return { now: () => new Date() };
}

/**
 * 从模块 options 解析时钟。接受四种写法（与 pomodoro 模块同款）：
 *   - `now: () => Date|string|number`
 *   - `now: Date`
 *   - `now: string|number`
 *   - `clock: { now() }`
 * 都没有就用系统时钟 —— 生产路径不依赖任何注入。
 */
export function resolveClock(options = {}) {
  if (options?.clock && typeof options.clock.now === 'function') {
    return { now: () => new Date(options.clock.now()) };
  }
  const source = options?.now;
  if (typeof source === 'function') return { now: () => new Date(source()) };
  if (source instanceof Date) return { now: () => new Date(source) };
  if (source) {
    const parsed = new Date(source);
    if (!Number.isNaN(parsed.getTime())) return { now: () => new Date(parsed) };
  }
  return systemClock();
}
