/**
 * jwapp（移动教务 / 一站式服务大厅）课表接口封装。
 *
 * 已用真实站点验证过的事实（2026 年 1 月）：
 *
 * | 用途     | 路径                                              | 参数                          | 取值位置                              |
 * | ---      | ---                                               | ---                           | ---                                   |
 * | 课表     | `/jwapp/sys/wdkb/modules/xskcb/xskcb.do`          | `XNXQDM=<学期>`               | `datas.xskcb.rows[]`                  |
 * | 当前学期 | `/jwapp/sys/wdkb/modules/jshkcb/dqxnxq.do`        | 无                            | `datas.dqxnxq.rows[0].DM`             |
 * | 起始日   | `/jwapp/sys/wdkb/modules/jshkcb/cxjcs.do`         | `XN=<学年>`、`XQ=<学期序号>`  | `datas.cxjcs.rows[0].XQKSRQ`          |
 *
 * 三个接口都是 `POST` + `application/x-www-form-urlencoded`，响应外壳统一是
 * `{ code: "0", datas: {...} }` —— **`code` 是字符串 `"0"`，不是数字 0**，这是最容易踩的坑。
 *
 * 未登录时所有 jwapp 接口都会 302 到
 * `https://ehall.xjtu.edu.cn/amp-auth-adapter/login?service=<原 URL 的 urlencode>`，
 * 再往下跳 `login.xjtu.edu.cn` 的 CAS。因此**不需要单独记「登录入口」**：
 * 直接拿业务 URL 交给 `CasAuth.begin()` 让它自己跟跳转最省事（见 service.js）。
 *
 * 入口页里的 `gid_` 只是门户 iframe 的参数，接口不需要它 —— 实现接受但忽略。
 */

import { HttpError } from '../lms/http-client.js';
import { parseTerm } from './term.js';

/** 接口路径常量。上游改路径时只动这里。 */
export const EHALL_PATHS = Object.freeze({
  timetable: '/jwapp/sys/wdkb/modules/xskcb/xskcb.do',
  currentTerm: '/jwapp/sys/wdkb/modules/jshkcb/dqxnxq.do',
  termStart: '/jwapp/sys/wdkb/modules/jshkcb/cxjcs.do',
});

/** 业务错误（`code !== "0"` 或缺少 `datas`）。 */
export class EhallError extends Error {
  constructor(message, { code = null, url = '', payload = null } = {}) {
    super(message);
    this.name = 'EhallError';
    this.code = code;
    this.url = url;
    this.payload = payload;
  }
}

const str = (value) => (value === undefined || value === null ? null : String(value).trim() || null);

/** `"2026-09-14 00:00:00"` / `"2026-09-14T00:00:00"` / `"2026/09/14"` → `"2026-09-14"`。 */
export function parseEhallDate(value) {
  const text = str(value);
  if (!text) return null;
  const matched = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!matched) return null;
  const [, y, m, d] = matched;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/**
 * 把一行课表原始数据归一化。
 *
 * 字段名大小写敏感，就是上游那套拼音缩写：
 * `KCM` 课程名、`SKJS` 教师、`JASMC` 教室、`SKXQ` 星期（1=周一）、
 * `KSJC` 起始节次、`JSJC` 结束节次、`SKZC` 周次位图、`XNXQDM` 学期。
 * **没有课程代码 / 学分 / 教学班**，所以这里不臆造字段。
 */
export function normalizeTimetableRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const courseName = str(raw.KCM);
  if (!courseName) return null;
  return {
    courseName,
    teacher: str(raw.SKJS),
    location: str(raw.JASMC),
    weekDay: toInt(raw.SKXQ),
    startPeriod: toInt(raw.KSJC),
    endPeriod: toInt(raw.JSJC),
    weeksBitmap: str(raw.SKZC),
    term: str(raw.XNXQDM),
  };
}

function toInt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

export class EhallApi {
  /**
   * @param {object} options
   * @param {import('../lms/http-client.js').HttpClient} options.http
   * @param {object} options.config 见 config.js（`baseUrl` 即 ehall 站点）
   */
  constructor({ http, config }) {
    this.http = http;
    this.config = config;
    this.baseUrl = String(config.baseUrl).replace(/\/+$/, '');
    this.cachedCurrentTerm = null;
  }

  /** 当前学期编号，例如 `2026-2027-1`。 */
  async currentTerm({ refresh = false } = {}) {
    if (this.cachedCurrentTerm && !refresh) return this.cachedCurrentTerm;
    const datas = await this.#post(EHALL_PATHS.currentTerm, {});
    const row = firstRow(datas, 'dqxnxq');
    const term = str(row?.DM);
    if (!term) throw new EhallError('当前学期接口没有返回 DM 字段', { url: this.#url(EHALL_PATHS.currentTerm), payload: datas });
    this.cachedCurrentTerm = term;
    return term;
  }

  /**
   * 某个学期的课表行（已归一化）。
   * 注意：学期里没有课是**正常情况**（返回空数组），不是错误。
   */
  async timetableRows(term) {
    const parts = parseTerm(term);
    const datas = await this.#post(EHALL_PATHS.timetable, { XNXQDM: parts.term });
    const rows = pickRows(datas, 'xskcb');
    return rows.map(normalizeTimetableRow).filter(Boolean);
  }

  /**
   * 学期起始日（第一周周一）。取不到时返回 null，由上层用 `guessTermStart()` 兜底。
   * 不在这里抛错：`cxjcs.do` 对历史学期基本是空的，这属于**预期内**的情况。
   */
  async termStartDate(term) {
    const parts = parseTerm(term);
    let datas;
    try {
      datas = await this.#post(EHALL_PATHS.termStart, { XN: parts.academicYear, XQ: String(parts.index) });
    } catch (error) {
      if (error instanceof EhallError) return { startDate: null, reason: error.message };
      throw error;
    }
    const row = firstRow(datas, 'cxjcs');
    const startDate = parseEhallDate(row?.XQKSRQ);
    return { startDate, raw: row?.XQKSRQ ?? null };
  }

  // ------------------------------------------------------------------ 内部

  #url(path) {
    return `${this.baseUrl}${path}`;
  }

  /**
   * POST 表单并校验外壳。
   * 带上 `X-Requested-With: XMLHttpRequest`：jwapp 的部分接口据此返回 JSON 而不是整页 HTML。
   */
  async #post(path, fields) {
    const url = this.#url(path);
    const response = await this.http.postForm(url, fields, {
      follow: true,
      headers: {
        Referer: `${this.baseUrl}/jwapp/sys/wdkb/*default/index.do`,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/plain, */*',
      },
    });

    // 一路被踢回登录页：说明会话票据已经失效（不是业务错误）。
    // 注意只认「CAS 登录页 / 登录接口」这几种地址，不能看到 amp-auth-adapter 就当成失败 ——
    // 第一次登录时它本来就是跳转链中的一环，成功时最终 URL 已经是业务地址。
    if (isLoginUrl(response.url) || isLoginHtml(response.text)) {
      throw new HttpError('课表登录态已失效，请重新登录', { status: 401, url: response.url });
    }
    if (response.status === 401 || response.status === 403) {
      throw new HttpError('课表登录态已失效，请重新登录', { status: response.status, url });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new EhallError(`教务接口 ${path} 返回 HTTP ${response.status}`, { url, payload: response.text.slice(0, 200) });
    }

    let parsed;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      throw new EhallError(`教务接口 ${path} 返回的不是 JSON（可能登录态失效或接口已变更）`, {
        url,
        payload: response.text.slice(0, 200),
      });
    }

    // ★ code 是字符串 "0"
    const code = parsed?.code;
    if (String(code) !== '0') {
      const message = parsed?.msg ?? parsed?.message ?? `code=${JSON.stringify(code)}`;
      throw new EhallError(`教务接口 ${path} 返回业务错误：${message}`, { code, url, payload: parsed });
    }
    if (!parsed?.datas || typeof parsed.datas !== 'object') {
      throw new EhallError(`教务接口 ${path} 的响应缺少 datas 字段`, { code, url, payload: parsed });
    }
    return parsed.datas;
  }
}

function isLoginUrl(url) {
  return typeof url === 'string' && /\/cas\/login|login\.xjtu\.edu\.cn/.test(url);
}

/** 响应体是不是 CAS 登录页（有执行令牌 / 明确的认证表单）。 */
function isLoginHtml(text) {
  if (typeof text !== 'string' || !text) return false;
  return /name=["']execution["']/.test(text) || /\/cas\/login/.test(text) || /id=["']fm1["']/.test(text);
}

/** `datas.<key>.rows` 取数组；结构不对时返回空数组（由调用方决定是否算错）。 */
function pickRows(datas, key) {
  const rows = datas?.[key]?.rows;
  return Array.isArray(rows) ? rows : [];
}

function firstRow(datas, key) {
  return pickRows(datas, key)[0] ?? null;
}
