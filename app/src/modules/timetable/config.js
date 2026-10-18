/**
 * 课表导入模块的配置：**所有与 ehall / jwapp 耦合的地址与默认参数都集中在这里**。
 *
 * 为什么单独一个文件：jwapp 改路径、改参数是常态。把「接口路径 + 默认周数 + 展示用学期名」
 * 收在一处，上游一变只动本文件，api.js / service.js / 页面一行都不用碰。
 *
 * 事实来源：旧实现（分支提交 b6c569c，2026-01 真机实测）与
 * `docs/课表接入调研.md`。三个接口**全部**在 `jwapp/sys/wdkb` 下：
 *
 * | 用途     | 路径                                        | 参数                         | 取值位置                     |
 * | ---      | ---                                         | ---                          | ---                          |
 * | 课表     | `/jwapp/sys/wdkb/modules/xskcb/xskcb.do`    | `XNXQDM=<学期>`              | `datas.xskcb.rows[]`         |
 * | 当前学期 | `/jwapp/sys/wdkb/modules/jshkcb/dqxnxq.do`  | 无                           | `datas.dqxnxq.rows[0].DM`    |
 * | 起始日   | `/jwapp/sys/wdkb/modules/jshkcb/cxjcs.do`   | `XN=<学年>`、`XQ=<学期序号>` | `datas.cxjcs.rows[0].XQKSRQ` |
 *
 * 三个都是 `POST` + `application/x-www-form-urlencoded`，外壳统一
 * `{ code: "0", datas: {...} }` —— **`code` 是字符串 `"0"`**，用 `=== 0` 判断会全部失败。
 */

import { LMS_DEFAULTS } from '../lms/config.js';

/** 一站式服务大厅基址。 */
export const EHALL_BASE = 'https://ehall.xjtu.edu.cn';

/** 课表应用名（也出现在 Referer 里）。 */
export const APP_NAME = 'wdkb';

/** 接口路径表。上游改路径时只动这里（测试可用 `paths` 覆盖）。 */
export const EHALL_PATHS = Object.freeze({
  /** 某学期课表：参数 `XNXQDM`。 */
  timetable: '/jwapp/sys/wdkb/modules/xskcb/xskcb.do',
  /** 当前学期：无参数。 */
  currentTerm: '/jwapp/sys/wdkb/modules/jshkcb/dqxnxq.do',
  /** 学期起始日：参数 `XN`（学年，如 `2026-2027`）与 `XQ`（1/2/3）。 */
  termStart: '/jwapp/sys/wdkb/modules/jshkcb/cxjcs.do',
});

/**
 * 登录入口：**直接用课表接口地址**，让 CAS 状态机自己跟 302。
 *
 * 未登录时这个地址会 302 到
 * `https://ehall.xjtu.edu.cn/amp-auth-adapter/login?service=…`，
 * 再跳 `login.xjtu.edu.cn` 的 CAS。所以不需要单独记一个「登录页 URL」，
 * 也不能指向门户页 `new/index.html`（那是静态 SPA 外壳，未登录也 200，会让认证状态机误判）。
 */
export const LOGIN_URL = `${EHALL_BASE}${EHALL_PATHS.timetable}`;

/** 线上默认值。 */
export const TIMETABLE_DEFAULTS = Object.freeze({
  /** ehall 站点。 */
  baseUrl: EHALL_BASE,
  /** 统一身份认证站点：与思源学堂 / 教务共用同一套 CAS（共享 Cookie 罐即可 SSO）。 */
  casOrigin: LMS_DEFAULTS.casOrigin,
  /** 登录入口（见上面的说明）。 */
  loginUrl: LOGIN_URL,
  /** 单次请求超时：全校同时刷课表时接口偶发很慢，给宽一点。 */
  timeoutMs: 25_000,
  /** 普通学期总周数（学校没有接口，硬编码；课表里实际的周次可能更少）。 */
  totalWeeks: 18,
  /** 小学期（`-3`）总周数。 */
  shortTermWeeks: 8,
  /** 当前学期前后各取几个学期做下拉（「前后各 3 个学期」→ 共 7 项）。 */
  termNeighbors: 3,
  /** 课表原始行缓存时间：一次预览 + 一次导入不会重复打学校服务器。 */
  rowsCacheTtlMs: 60_000,
  /** 单学期最多保留多少行（防御异常数据）。 */
  maxRows: 2000,
});

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * 解析配置。优先级：显式入参 > 环境变量 > 默认值。
 * 环境变量：PC_TT_BASE_URL / PC_TT_CAS_ORIGIN / PC_TT_LOGIN_URL / PC_TT_TIMEOUT_MS
 */
export function resolveTimetableConfig(overrides = {}, env = process.env) {
  const source = isPlainObject(overrides) ? overrides : {};
  const config = { ...TIMETABLE_DEFAULTS, ...source };
  if (!source.baseUrl && env.PC_TT_BASE_URL) config.baseUrl = env.PC_TT_BASE_URL;
  if (!source.casOrigin && env.PC_TT_CAS_ORIGIN) config.casOrigin = env.PC_TT_CAS_ORIGIN;
  if (!source.loginUrl && env.PC_TT_LOGIN_URL) config.loginUrl = env.PC_TT_LOGIN_URL;
  if (!source.timeoutMs && env.PC_TT_TIMEOUT_MS) {
    const parsed = Number(env.PC_TT_TIMEOUT_MS);
    if (Number.isFinite(parsed) && parsed > 0) config.timeoutMs = parsed;
  }

  config.baseUrl = String(config.baseUrl).replace(/\/+$/, '');
  config.casOrigin = String(config.casOrigin).replace(/\/+$/, '');
  // 没显式给 loginUrl 时跟着 baseUrl 走：测试指向 mock 时不会漏配一个线上地址。
  if (!source.loginUrl) {
    config.loginUrl = source.baseUrl
      ? `${config.baseUrl}${new URL(TIMETABLE_DEFAULTS.loginUrl).pathname}`
      : config.loginUrl;
  }
  // 路径允许整体覆盖（上游改版 / mock 用不同路径时不必改业务代码）。
  config.paths = { ...EHALL_PATHS, ...(isPlainObject(source.paths) ? source.paths : {}) };

  const neighbors = Number(config.termNeighbors);
  config.termNeighbors = Number.isInteger(neighbors) && neighbors >= 0 && neighbors <= 12 ? neighbors : 3;
  for (const key of ['totalWeeks', 'shortTermWeeks', 'rowsCacheTtlMs', 'maxRows']) {
    const value = Number(config[key]);
    config[key] = Number.isFinite(value) && value > 0 ? value : TIMETABLE_DEFAULTS[key];
  }
  return config;
}

/**
 * 围绕某个学期，生成候选学期列表（升序）。
 *
 * 为什么需要：`cxjcs.do` 要 `XN` + `XQ` 两个参数，学校**没有**「列出所有学期」的接口，
 * 所以只能先拿 `dqxnxq.do` 的当前学期，再前后各取若干学期。
 * 用「学年 × 3 + 学期序号」压成线性序号再加减，能正确处理跨学年与第 3 学期（小学期）。
 *
 * @param {string} currentTerm 例如 `2026-2027-1`
 * @param {number} [neighbors=3] 前后各取几个
 * @returns {string[]} 升序学期编号
 */
export function candidateTerms(currentTerm, neighbors = 3) {
  const matched = typeof currentTerm === 'string' ? /^(\d{4})-\d{4}-([123])$/.exec(currentTerm.trim()) : null;
  if (!matched) return [];
  const startYear = Number(matched[1]);
  const index = Number(matched[2]);
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

/** 一个学期的展示名：`2026-2027 学年 · 第 1 学期` / `… · 小学期`。 */
export function termLabel(term) {
  const matched = /^(\d{4})-(\d{4})-([123])$/.exec(String(term ?? ''));
  if (!matched) return String(term ?? '');
  const suffix = matched[3] === '3' ? '小学期' : `第 ${matched[3]} 学期`;
  return `${matched[1]}-${matched[2]} 学年 · ${suffix}`;
}
