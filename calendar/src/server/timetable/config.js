/**
 * 西交大课表导入配置。
 *
 * 与 `src/server/lms/config.js` 同样的三个目的：
 * 1. 单元测试时把地址指向本地 mock，真实网络零依赖；
 * 2. 学校换域名（或要走 WebVPN）时只改这里或传 options；
 * 3. 学期起始日 / 总周数这类「学校不给」的事实集中成可覆盖的默认值。
 */

/** 线上默认值。 */
export const TIMETABLE_DEFAULTS = Object.freeze({
  /** 一站式服务大厅（jwapp 课表就挂在这里）。 */
  baseUrl: 'https://ehall.xjtu.edu.cn',
  /** 统一身份认证站点（与思源学堂共用同一套 CAS 状态机）。 */
  casOrigin: 'https://login.xjtu.edu.cn',
  /** 登录入口：直接拿业务 URL 交给 CAS 状态机，它会自己跟 302 到 amp-auth-adapter → CAS。 */
  loginUrl: 'https://ehall.xjtu.edu.cn/jwapp/sys/wdkb/modules/xskcb/xskcb.do',
  /** 服务端会拒绝脚本默认 UA。 */
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  /** 单次请求超时。课表接口偶尔很慢（全校同时刷），给宽一点。 */
  timeoutMs: 25_000,
  /** 普通学期总周数（没有接口，硬编码）。 */
  totalWeeks: 18,
  /** 小学期（`-3`）总周数。 */
  shortTermWeeks: 8,
  /** 当前学期前后各取几个学期作为候选（用于「选学期」下拉框）。 */
  termNeighbors: 3,
  /** 起始日的自动重取间隔：超过这个时间会再问一次学校（拿不到就还用本地值）。 */
  startDateTtlMs: 24 * 60 * 60 * 1000,
});

/**
 * 解析配置。优先级：显式入参 > 环境变量 > 默认值。
 * 环境变量：PC_TT_BASE_URL / PC_TT_CAS_ORIGIN / PC_TT_LOGIN_URL / PC_TT_TIMEOUT_MS
 */
export function resolveTimetableConfig(overrides = {}, env = process.env) {
  const config = { ...TIMETABLE_DEFAULTS, ...overrides };
  if (!overrides.baseUrl && env.PC_TT_BASE_URL) config.baseUrl = env.PC_TT_BASE_URL;
  if (!overrides.casOrigin && env.PC_TT_CAS_ORIGIN) config.casOrigin = env.PC_TT_CAS_ORIGIN;
  if (!overrides.loginUrl && env.PC_TT_LOGIN_URL) config.loginUrl = env.PC_TT_LOGIN_URL;
  if (!overrides.timeoutMs && env.PC_TT_TIMEOUT_MS) {
    const parsed = Number(env.PC_TT_TIMEOUT_MS);
    if (Number.isFinite(parsed) && parsed > 0) config.timeoutMs = parsed;
  }
  config.baseUrl = String(config.baseUrl).replace(/\/+$/, '');
  config.casOrigin = String(config.casOrigin).replace(/\/+$/, '');
  // 没显式给 loginUrl 时跟着 baseUrl 走：测试指向 mock 时不会漏配一个线上地址
  if (!overrides.loginUrl) {
    config.loginUrl = overrides.baseUrl
      ? `${config.baseUrl}${new URL(TIMETABLE_DEFAULTS.loginUrl).pathname}`
      : config.loginUrl;
  }
  const neighbors = Number(config.termNeighbors);
  config.termNeighbors = Number.isInteger(neighbors) && neighbors >= 0 && neighbors <= 12 ? neighbors : 3;
  for (const key of ['totalWeeks', 'shortTermWeeks', 'startDateTtlMs', 'timeoutMs']) {
    const value = Number(config[key]);
    config[key] = Number.isFinite(value) && value > 0 ? value : TIMETABLE_DEFAULTS[key];
  }
  return config;
}

/**
 * 围绕某个学期，生成候选学期列表。
 *
 * 为什么需要这个：`cxjcs.do` 需要 `XN` + `XQ` 两个参数，学校**没有**「列出所有学期」的接口，
 * 所以只能先拿 `dqxnxq.do` 的当前学期，再前后各取若干学期，逐个尝试取起始日。
 * 顺序固定为「学年升序、同年内 1 → 2 → 3」，与学校的学期编号顺序一致（字符串排序也是这个结果）。
 *
 * @param {string} currentTerm 例如 `2026-2027-1`
 * @param {number} [neighbors=3] 前后各取几个
 * @returns {string[]} 升序的学期编号
 */
export function candidateTerms(currentTerm, neighbors = 3) {
  const matched = typeof currentTerm === 'string' ? /^(\d{4})-\d{4}-([123])$/.exec(currentTerm.trim()) : null;
  if (!matched) return [];
  const startYear = Number(matched[1]);
  const index = Number(matched[2]);
  // 以 9 月为学年起点，把「学年 + 学期序号」压成一个线性序号，方便前后加减
  const linear = startYear * 3 + (index - 1);
  const count = Math.max(0, Number(neighbors) || 0);
  const out = [];
  for (let offset = -count; offset <= count; offset += 1) {
    const value = linear + offset;
    const year = Math.floor(value / 3);
    const idx = (value % 3) + 1;
    if (year < 2000 || year > 2100) continue;
    out.push(`${year}-${year + 1}-${idx}`);
  }
  return [...new Set(out)].sort();
}

/** 一个学期的展示用名字：`2026-2027 学年 · 第 1 学期`。 */
export function termLabel(term) {
  const matched = /^(\d{4})-(\d{4})-([123])$/.exec(String(term ?? ''));
  if (!matched) return String(term ?? '');
  const suffix = matched[3] === '3' ? '小学期' : `第 ${matched[3]} 学期`;
  return `${matched[1]}-${matched[2]} 学年 · ${suffix}`;
}
