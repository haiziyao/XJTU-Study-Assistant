/**
 * `jwapp/sys/wdkb` 课表接口封装（唯一数据来源）。
 *
 * 已用真实站点验证过的事实（2026-01，旧实现分支 b6c569c）：
 *
 * | 用途     | 路径                                        | 参数                         | 取值位置                     |
 * | ---      | ---                                         | ---                          | ---                          |
 * | 课表     | `/jwapp/sys/wdkb/modules/xskcb/xskcb.do`    | `XNXQDM=<学期>`              | `datas.xskcb.rows[]`         |
 * | 当前学期 | `/jwapp/sys/wdkb/modules/jshkcb/dqxnxq.do`  | 无                           | `datas.dqxnxq.rows[0].DM`    |
 * | 起始日   | `/jwapp/sys/wdkb/modules/jshkcb/cxjcs.do`   | `XN=<学年>`、`XQ=<学期序号>` | `datas.cxjcs.rows[0].XQKSRQ` |
 *
 * 三个接口都是 `POST` + `application/x-www-form-urlencoded`，外壳统一
 * `{ code: "0", datas: {...} }` —— **`code` 是字符串 `"0"`，不是数字 0**。
 *
 * 未登录时所有 jwapp 接口都会 302 到
 * `https://ehall.xjtu.edu.cn/amp-auth-adapter/login?service=<原 URL>`，
 * 再往下跳 `login.xjtu.edu.cn` 的 CAS。这里把它识别为 **401 NOT_LOGGED_IN**，
 * 绝不静默当成「这个学期没有课」—— 那会让用户以为课表被清空了。
 *
 * 错误只带「路径 + 状态码 + 上游 code」，**不把上游 HTML 原样透给前端**：
 * 一方面页面会把 HTML 当纯文本显示成一屏乱码，另一方面登录页 HTML 里可能带票据类内容。
 */

import { parseTerm } from './term.js';

/** 本模块的结构化错误码（路由层据此翻成 HTTP 状态码）。 */
export const TIMETABLE_ERROR = Object.freeze({
  /** 未登录 / 登录票据失效 → 401，前端引导去「设置 → 统一身份认证」。 */
  NOT_LOGGED_IN: 'NOT_LOGGED_IN',
  /** 上游接口异常（302 之外的失败、500、非 JSON、code!=="0"、结构变化）→ 502。 */
  EHALL_ERROR: 'EHALL_ERROR',
  /** 本模块自己的入参错误（例如删除时既没给 courseIds 也没给 all）→ 400。 */
  BAD_REQUEST: 'BAD_REQUEST',
});

/** 课表模块的结构化错误。 */
export class TimetableError extends Error {
  constructor(message, { code = TIMETABLE_ERROR.EHALL_ERROR, status = 0, details = null } = {}) {
    super(message);
    this.name = 'TimetableError';
    this.code = code;
    this.status = status;
    this.details = details;
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

function toInt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/**
 * 把一行课表原始数据归一化。
 *
 * 字段名**大小写敏感**，就是上游那套拼音缩写：
 * `KCM` 课程名、`SKJS` 教师、`JASMC` 教室、`SKXQ` 星期（1=周一）、
 * `KSJC` 起始节次、`JSJC` 结束节次、`SKZC` 周次位图、`XNXQDM` 学期。
 * 上游没有课程代码 / 学分 / 教学班，所以这里不臆造字段（写测试时也别加 `kcm` 这种小写别名）。
 *
 * @returns {null|{courseName:string, teacher:string|null, location:string|null, weekDay:number|null, startPeriod:number|null, endPeriod:number|null, weeksBitmap:string|null, term:string|null}}
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

/** 去掉 HTML 标签并压缩空白：上游 `msg` 偶尔是一整段 HTML，不能原样塞进错误信息。 */
function safeText(value, limit = 120) {
  if (value === undefined || value === null) return '';
  const text = String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export class EhallApi {
  /**
   * @param {object} options
   * @param {import('../lms/http-client.js').HttpClient} options.http 共享认证模块的 HTTP 客户端
   * @param {object} options.config resolveTimetableConfig() 的结果
   */
  constructor({ http, config }) {
    this.http = http;
    this.config = config;
    this.baseUrl = String(config.baseUrl).replace(/\/+$/, '');
    this.paths = config.paths ?? {};
    this.cachedCurrentTerm = null;
  }

  /** 换账号 / 登录失效后清掉学期缓存。 */
  reset() {
    this.cachedCurrentTerm = null;
  }

  #url(key) {
    return `${this.baseUrl}${this.paths[key]}`;
  }

  /** 当前学期编号，例如 `2026-2027-1`。 */
  async currentTerm({ refresh = false } = {}) {
    if (this.cachedCurrentTerm && !refresh) return this.cachedCurrentTerm;
    const datas = await this.#post('currentTerm', {});
    const row = firstRow(datas, 'dqxnxq');
    const term = str(row?.DM);
    if (!term) {
      throw new TimetableError('教务当前学期接口没有返回 DM 字段（上游结构可能已变更）', {
        details: { path: this.paths.currentTerm },
      });
    }
    parseTerm(term); // 上游给了脏数据就尽早报错
    this.cachedCurrentTerm = term;
    return term;
  }

  /**
   * 某个学期的课表行（已归一化）。
   * 注意：学期里没有课是**正常情况**（返回空数组），不是错误。
   */
  async timetableRows(term) {
    const parts = parseTerm(term);
    const datas = await this.#post('timetable', { XNXQDM: parts.term });
    const rows = pickRows(datas, 'xskcb');
    const maxRows = Number(this.config.maxRows) || 2000;
    return rows.slice(0, maxRows).map(normalizeTimetableRow).filter(Boolean);
  }

  /**
   * 学期起始日（第一周周一）。
   *
   * 取不到时返回 `{startDate:null, reason}`，由上层用 `guessTermStart()` 兜底 ——
   * `cxjcs.do` 对历史学期基本是空的，这属于**预期内**的情况，不该让整页报错。
   * 但**未登录必须继续往上抛**：那不是「没数据」，而是「没权限」，两者不能混。
   */
  async termStartDate(term) {
    const parts = parseTerm(term);
    let datas;
    try {
      datas = await this.#post('termStart', { XN: parts.academicYear, XQ: String(parts.index) });
    } catch (error) {
      if (error instanceof TimetableError && error.code === TIMETABLE_ERROR.NOT_LOGGED_IN) throw error;
      if (error instanceof TimetableError) return { startDate: null, raw: null, reason: error.message };
      throw error;
    }
    const row = firstRow(datas, 'cxjcs');
    const startDate = parseEhallDate(row?.XQKSRQ);
    return { startDate, raw: row?.XQKSRQ ?? null };
  }

  // ------------------------------------------------------------------ 内部

  /**
   * POST 表单并校验外壳。
   * 带 `X-Requested-With: XMLHttpRequest`：jwapp 的部分接口据此返回 JSON 而不是整页 HTML。
   */
  async #post(pathKey, fields) {
    const path = this.paths[pathKey];
    const url = this.#url(pathKey);
    let response;
    try {
      response = await this.http.postForm(url, fields, {
        follow: true,
        headers: {
          Referer: `${this.baseUrl}/jwapp/sys/wdkb/*default/index.do`,
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json, text/plain, */*',
        },
      });
    } catch (error) {
      throw new TimetableError(`请求教务接口 ${path} 失败：${error.message ?? error}`, {
        details: { path, cause: error.name ?? 'Error' },
      });
    }

    // 一路被踢回登录页：会话票据失效（不是业务错误，也不是「没有课」）。
    // 只认「CAS 登录页 / 登录接口」这几种地址 —— 首次登录时 amp-auth-adapter 本来就是跳转链的一环，
    // 成功时最终 URL 已经是业务地址。
    if (isLoginUrl(response.url) || isLoginHtml(response.text)) {
      throw new TimetableError('课表登录态已失效，请先在「设置 → 统一身份认证」重新登录', {
        code: TIMETABLE_ERROR.NOT_LOGGED_IN,
        status: 401,
        details: { path },
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new TimetableError('课表登录态已失效，请先在「设置 → 统一身份认证」重新登录', {
        code: TIMETABLE_ERROR.NOT_LOGGED_IN,
        status: response.status,
        details: { path, status: response.status },
      });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new TimetableError(`教务接口 ${path} 返回 HTTP ${response.status}`, {
        details: { path, status: response.status },
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      throw new TimetableError(`教务接口 ${path} 返回的不是 JSON（可能登录态失效或接口已变更）`, {
        details: { path, status: response.status },
      });
    }

    // ★ code 是字符串 "0"（这里用 String() 兼容数字 0，但绝不接受 "1" / 1）
    const code = parsed?.code;
    if (String(code) !== '0') {
      const upstream = safeText(parsed?.msg ?? parsed?.message ?? '');
      const suffix = upstream ? `：${upstream}` : '';
      throw new TimetableError(`教务接口 ${path} 返回业务错误（code=${JSON.stringify(code)}）${suffix}`, {
        details: { path, code: code ?? null },
      });
    }
    if (!parsed?.datas || typeof parsed.datas !== 'object') {
      throw new TimetableError(`教务接口 ${path} 的响应缺少 datas 字段（上游结构可能已变更）`, {
        details: { path, code: code ?? null },
      });
    }
    return parsed.datas;
  }
}

function isLoginUrl(url) {
  return typeof url === 'string' && /\/cas\/login|login\.xjtu\.edu\.cn|amp-auth-adapter\/login/.test(url);
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
