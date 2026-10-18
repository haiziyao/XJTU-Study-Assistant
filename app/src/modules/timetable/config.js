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
 *
 * ★ 与学业模块同一个坑：**光有 CAS 票据还不够**。jwapp 的每个应用
 *   （成绩 `cjcx`、课表 `wdkb` …）都要先做一次**应用授权握手**，否则业务接口稳定 403
 *   （实测 2026-10：会话有效时 `GET/POST xskcb.do` 都是 403 `text/html`，走完
 *   `getAppConfig` + `appInit` 后立刻变成 `200 application/json`）。
 *   握手的 appId 与路径按应用不同，所以全部配置化在本文件。
 */

import { LMS_DEFAULTS } from '../lms/config.js';

/** 一站式服务大厅基址。 */
export const EHALL_BASE = 'https://ehall.xjtu.edu.cn';

/** 课表应用名（也出现在 Referer 与 `getAppConfig/wdkb-<appId>.do` 里）。 */
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
 * 课表应用的 jwapp 配置。
 *
 * 两个用途：
 * 1. `indexPath` 是**登录判定 + 握手第 1 步**共用的 HTML 应用页；
 * 2. `appConfigPath` / `appInitPath` 是握手第 2、3 步。
 *
 * 为什么 appId 默认留空、必须从应用页里取：
 * appId 是门户分配给应用的数字 ID，会随应用重建而变化（成绩应用的调研文档里就记录过
 * appId 变更）。应用页里的 `window._JW_INIT_CONFIG` 是**唯一权威来源**；写死一个旧值，
 * 一旦上游变了就会表现为"握手成功但业务仍 403"，比直接报"取不到 appId"更难排查。
 * 需要强制指定时用环境变量 `PC_TT_APP_ID`（或在 createServer 的 timetable.app.id 里给）。
 */
export const APP = Object.freeze({
  /** 应用名，用于拼 `getAppConfig` 的 `<appName>-<appId>.do`。 */
  name: APP_NAME,
  /** 应用页（HTML，未登录 302 到 CAS；登录后含 `window._JW_INIT_CONFIG`）。 */
  indexPath: '/jwapp/sys/wdkb/*default/index.do',
  /** 应用 ID 兜底：null = 只信应用页（见上面的说明）。 */
  id: null,
  /** 第 2 步：把本账号对该应用的授权登记进 jwapp 会话。 */
  appConfigPath: (appName = APP_NAME, appId = '') => `/jwapp/sys/funauthapp/api/getAppConfig/${appName}-${appId}.do`,
  /** 第 3 步：应用初始化（`{SFQY:'1', APP:<appId>}`），顺带刷新 `_WEU` 防伪 token。 */
  appInitPath: '/jwapp/sys/jwpubapp/modules/bb/cxjwggbbdqx.do',
});

/** 从应用页 HTML 的 `_JW_INIT_CONFIG` 里取 appId：`"appId":"4770397878132218"`。 */
export const APP_ID_PATTERN = /"appId"\s*:\s*"(\d+)"/;

/**
 * 登录入口：**wdkb 的 HTML 应用页**，不是课表 JSON 接口。
 *
 * 这是本次修复的关键之一。`CasAuth.begin()` 判断"登录了没有"的方式很朴素：
 * 打开这个地址，**没有 `execution` 令牌、也不在 `/cas/login`** 就当业务页（READY）。
 * 而 `xskcb.do` 是 POST-only 的 JSON 接口：用 GET 打它，jwapp 返回的是
 * **403 的 HTML 错误页**（没有 execution、URL 也不是 CAS）——`begin()` 于是误判成 READY，
 * 站点被标记 ready 并写下 `lastOkAt`；直到真正的业务 POST 拿到 403 才被打回，
 * 用户看到的就是"课表登录态已失效"。
 *
 * 换成 HTML 应用页后两种状态泾渭分明：
 * - 未登录（无 TGC）→ 302 → `amp-auth-adapter/login` → CAS 登录表单（带 execution）；
 * - 已登录 → 200 `text/html`（`_JW_INIT_CONFIG` 就在里面）。
 *
 * 也不能指向门户页 `new/index.html`：那是静态 SPA 外壳，未登录也 200。
 */
export const LOGIN_URL = `${EHALL_BASE}${APP.indexPath}`;

/** 线上默认值。 */
export const TIMETABLE_DEFAULTS = Object.freeze({
  /** ehall 站点。 */
  baseUrl: EHALL_BASE,
  /** 统一身份认证站点：与思源学堂 / 教务共用同一套 CAS（共享 Cookie 罐即可 SSO）。 */
  casOrigin: LMS_DEFAULTS.casOrigin,
  /** 登录入口（HTML 应用页，见 LOGIN_URL 的说明）。 */
  loginUrl: LOGIN_URL,
  /** jwapp 应用配置（appId / 三条握手路径）。 */
  app: APP,
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
 * 环境变量：PC_TT_BASE_URL / PC_TT_CAS_ORIGIN / PC_TT_LOGIN_URL / PC_TT_TIMEOUT_MS / PC_TT_APP_ID
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
  // 应用配置整体合并（测试 / 上游改版都可能只覆盖其中一两项）。
  const appOverride = isPlainObject(source.app) ? source.app : {};
  config.app = { ...APP, ...appOverride };
  if (!appOverride.id && env.PC_TT_APP_ID) config.app.id = String(env.PC_TT_APP_ID).trim() || null;
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
