/**
 * `jwapp/sys/wdkb` 课表接口封装（唯一数据来源）。
 *
 * 已用真实站点验证过的事实（2026-01，旧实现分支 b6c569c；2026-10 重新实测）：
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
 * ★ 最难的一个坑（2026-10 真机定位）：**登录有效 ≠ 课表接口可用**。
 *   实测会话完全有效时 `GET/POST xskcb.do` 仍然是 **403 `text/html`**，
 *   因为 jwapp 的每个应用（成绩 `cjcx`、课表 `wdkb`…）都要求先做一次
 *   **应用授权握手**：应用页 → `getAppConfig/<app>-<appId>.do` → `appInit`。
 *   少了这一步时：
 *   - 旧 `loginUrl` 指向 `xskcb.do`（POST-only JSON 接口），GET 它拿到 403 HTML，
 *     而 `CasAuth.begin()` 只认「有 execution 令牌 / 在 /cas/login」才算登录页，
 *     于是把 403 错误页误判成业务页 → 站点被置 ready 并写 `lastOkAt`；
 *   - 真正的业务 POST 再拿 403，旧代码把它当成"登录态失效" → 站点被打回，
 *     用户看到「课表登录态已失效」。三步都是同一个空白造成的假象。
 *   现在 `loginUrl` 改成 HTML 应用页（见 config.js），业务请求前补握手，
 *   并把 403 与"未登录"严格分开：前者 502 `EHALL_HANDSHAKE_FAILED`，后者 401。
 *
 * 错误只带「路径 + 状态码 + 上游 code」，**不把上游 HTML 原样透给前端**：
 * 一方面页面会把 HTML 当纯文本显示成一屏乱码，另一方面登录页 HTML 里可能带票据类内容。
 */

import { APP_ID_PATTERN } from './config.js';
import { parseTerm } from './term.js';

/** 本模块的结构化错误码（路由层据此翻成 HTTP 状态码）。 */
export const TIMETABLE_ERROR = Object.freeze({
  /** 未登录 / 登录票据失效 → 401，前端引导去「设置 → 统一身份认证」。 */
  NOT_LOGGED_IN: 'NOT_LOGGED_IN',
  /**
   * jwapp 应用授权握手失败（登录本身可能完全有效）→ 502。
   * 典型原因：应用页结构变了取不到 appId、`getAppConfig` / `appInit` 失败、
   * 握手后业务接口仍 403。与「未登录」严格分开，否则用户会被反复引导去重新登录。
   */
  EHALL_HANDSHAKE_FAILED: 'EHALL_HANDSHAKE_FAILED',
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
    this.app = config.app ?? {};
    /** 当前学期缓存（换账号 / 失效后清掉）。 */
    this.cachedCurrentTerm = null;

    /** 应用页里取到的 appId（也可以由配置强制指定）。 */
    this.appId = this.app.id ?? null;
    /** 本会话是否已完成授权握手（成功后缓存，同一会话内不重复打）。 */
    this.authorized = false;
    /** 最近一次握手的诊断信息：`{ok, appId, steps:[{step,status,error}]}`（不含票据）。 */
    this.handshake = { ok: false, appId: this.appId, steps: [] };
    /** 并发的业务请求复用同一次握手。 */
    this.handshakeInflight = null;
  }

  /** 换账号 / 登录失效后必须重做握手（缓存全部作废）。 */
  reset() {
    this.cachedCurrentTerm = null;
    this.authorized = false;
    this.handshake = { ok: false, appId: this.appId, steps: [] };
    this.handshakeInflight = null;
    return this;
  }

  /** 给 `/status?probe=1` 的只读诊断（只含步骤与状态，不含 cookie / 票据）。 */
  diagnose() {
    return {
      handshake: {
        ok: Boolean(this.handshake.ok),
        appId: this.handshake.appId ?? this.appId ?? null,
        steps: (this.handshake.steps ?? []).map((step) => ({
          step: step.step,
          status: step.status ?? 0,
          error: step.error ?? null,
        })),
      },
    };
  }

  #url(key) {
    return `${this.baseUrl}${this.paths[key]}`;
  }

  /** 握手第 1 步的地址：wdkb 的 HTML 应用页（也用作登录判定入口）。 */
  #appPageUrl() {
    return `${this.baseUrl}${this.app.indexPath}`;
  }

  /** 握手第 2 步的地址：`getAppConfig/<appName>-<appId>.do`。 */
  #appConfigUrl(appId) {
    const target = this.app.appConfigPath;
    const path = typeof target === 'function' ? target(this.app.name, appId) : String(target ?? '');
    return `${this.baseUrl}${path}`;
  }

  /** 握手第 3 步的地址：应用初始化。 */
  #appInitUrl() {
    return `${this.baseUrl}${this.app.appInitPath}`;
  }

  /**
   * jwapp 请求头：**Referer 必须指向应用页**。
   * 服务端会检查 Referer / X-Requested-With，缺了会被当成浏览器直接访问而拒绝。
   */
  #jsonHeaders() {
    return {
      Referer: this.#appPageUrl(),
      Origin: this.baseUrl,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    };
  }

  /** 被踢回 CAS = 会话失效（不是握手问题）。 */
  #isLoginResponse(response) {
    return isLoginUrl(response?.url) || isLoginHtml(response?.text);
  }

  #loginError(step, extra = {}) {
    return new TimetableError('课表登录态已失效，请先在「设置 → 统一身份认证」重新登录', {
      code: TIMETABLE_ERROR.NOT_LOGGED_IN,
      status: 401,
      details: { step, ...extra },
    });
  }

  /**
   * 记录一次失败的握手并构造错误。
   *
   * `steps` 里保留**已经成功的步骤**和**失败的那一步**（带 status / error），
   * 这样 `/timetable/status?probe=1` 的 `diagnose.handshake.steps` 能直接指出
   * "卡在 appPage / getAppConfig / appInit 的哪一步"，而不是只给一句"失败了"。
   */
  #handshakeError(step, status, message, steps) {
    const recorded = [...steps, { step, status: status ?? 0, error: message ?? null }];
    this.handshake = { ok: false, appId: this.appId ?? null, steps: recorded };
    return new TimetableError(`课表应用授权握手失败（${step}）：${message}`, {
      code: TIMETABLE_ERROR.EHALL_HANDSHAKE_FAILED,
      status: 502,
      details: { step, status: status ?? 0, handshake: this.handshake },
    });
  }

  /**
   * 应用授权握手（四步里的前三步；第四步就是业务接口本身）。
   *
   * 1. `GET <应用页>`：建立 jwapp 子系统会话，并从 `window._JW_INIT_CONFIG` 取 appId；
   * 2. `GET  getAppConfig/<appName>-<appId>.do`：把本账号对该应用的授权登记进会话；
   * 3. `POST appInit {SFQY:'1', APP:<appId>}`：应用初始化（顺带刷新 `_WEU` 防伪 token）。
   *
   * 为什么每个 jwapp 应用要单独握手：授权是**按应用**记在 jwapp 会话里的
   * （同一个 `funauthapp` 能力，不同 appId 不同授权记录）。学业模块握的是成绩应用，
   * 它的授权不会让课表应用通过 —— 所以课表必须用自己的 appId 再走一遍。
   *
   * 返回 `{ok, appId, steps}`；失败时抛结构化错误：
   * - 302 到 CAS / 登录页 → 401 `NOT_LOGGED_IN`；
   * - 其它（应用页结构变了 / getAppConfig / appInit 失败）→ 502 `EHALL_HANDSHAKE_FAILED`。
   */
  async authorize() {
    if (this.handshakeInflight) return this.handshakeInflight;
    this.handshakeInflight = this.#doAuthorize().finally(() => {
      this.handshakeInflight = null;
    });
    return this.handshakeInflight;
  }

  /** 已握手就直接复用；否则现在做一次。 */
  async ensureHandshake() {
    if (this.authorized) return this.handshake;
    return this.authorize();
  }

  async #doAuthorize() {
    /** @type {{step:string,status:number,error:string|null}[]} */
    const steps = [];

    // ---------------------------------------------------------------- 1/3 应用页
    let page;
    try {
      page = await this.http.get(this.#appPageUrl(), {
        follow: true,
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
    } catch (error) {
      throw this.#handshakeError('appPage', 0, `打开课表应用页失败：${error.message ?? error}`, steps);
    }
    if (this.#isLoginResponse(page)) throw this.#loginError('appPage');
    if (page.status !== 200) {
      throw this.#handshakeError('appPage', page.status, `应用页返回 HTTP ${page.status}`, steps);
    }
    const appId = APP_ID_PATTERN.exec(page.text ?? '')?.[1] ?? this.app.id ?? null;
    if (!appId) {
      throw this.#handshakeError(
        'appPage',
        page.status,
        '应用页里没有 appId（window._JW_INIT_CONFIG 结构可能已变更）',
        steps,
      );
    }
    this.appId = appId;
    steps.push({ step: 'appPage', status: page.status, error: null });

    // ---------------------------------------------------------------- 2/3 getAppConfig
    let appConfig;
    try {
      appConfig = await this.http.get(this.#appConfigUrl(appId), { follow: true, headers: this.#jsonHeaders() });
    } catch (error) {
      throw this.#handshakeError('getAppConfig', 0, `请求失败：${error.message ?? error}`, steps);
    }
    if (this.#isLoginResponse(appConfig)) throw this.#loginError('getAppConfig');
    if (appConfig.status < 200 || appConfig.status >= 300) {
      throw this.#handshakeError('getAppConfig', appConfig.status, `返回 HTTP ${appConfig.status}`, steps);
    }
    try {
      JSON.parse(appConfig.text);
    } catch {
      throw this.#handshakeError('getAppConfig', appConfig.status, '返回的不是 JSON', steps);
    }
    steps.push({ step: 'getAppConfig', status: appConfig.status, error: null });

    // ---------------------------------------------------------------- 3/3 appInit
    let init;
    try {
      init = await this.http.postForm(
        this.#appInitUrl(),
        { SFQY: '1', APP: appId },
        { follow: true, headers: this.#jsonHeaders() },
      );
    } catch (error) {
      throw this.#handshakeError('appInit', 0, `请求失败：${error.message ?? error}`, steps);
    }
    if (this.#isLoginResponse(init)) throw this.#loginError('appInit');
    if (init.status < 200 || init.status >= 300) {
      throw this.#handshakeError('appInit', init.status, `返回 HTTP ${init.status}`, steps);
    }
    let payload;
    try {
      payload = JSON.parse(init.text);
    } catch {
      throw this.#handshakeError('appInit', init.status, '返回的不是 JSON', steps);
    }
    if (String(payload?.code) !== '0') {
      throw this.#handshakeError('appInit', init.status, `返回 code=${JSON.stringify(payload?.code)}`, steps);
    }
    steps.push({ step: 'appInit', status: init.status, error: null });

    this.authorized = true;
    this.handshake = { ok: true, appId, steps };
    return this.handshake;
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
   * 但**未登录 / 握手失败必须继续往上抛**：那不是「没数据」，而是「没权限 / 没授权」，
   * 两者不能混（混了就会把"没握手"显示成"起始日推断"）。
   */
  async termStartDate(term) {
    const parts = parseTerm(term);
    let datas;
    try {
      datas = await this.#post('termStart', { XN: parts.academicYear, XQ: String(parts.index) });
    } catch (error) {
      if (
        error instanceof TimetableError &&
        (error.code === TIMETABLE_ERROR.NOT_LOGGED_IN || error.code === TIMETABLE_ERROR.EHALL_HANDSHAKE_FAILED)
      ) {
        throw error;
      }
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
   *
   * 顺序固定：**先握手、再业务**；业务接口返回 403 时视为"应用授权过期"，
   * 用**全新握手**重试一次（CAS 票据一个字节都不动）。第二次仍 403 就报
   * 502 `EHALL_HANDSHAKE_FAILED`，绝不冒充"未登录"——那是两件不同的事。
   */
  async #post(pathKey, fields) {
    await this.ensureHandshake();
    try {
      return await this.#postOnce(pathKey, fields);
    } catch (error) {
      if (!(error instanceof TimetableError) || error.code !== TIMETABLE_ERROR.EHALL_HANDSHAKE_FAILED) throw error;
      this.authorized = false;
      await this.authorize();
      return await this.#postOnce(pathKey, fields);
    }
  }

  async #postOnce(pathKey, fields) {
    const path = this.paths[pathKey];
    const url = this.#url(pathKey);
    let response;
    try {
      response = await this.http.postForm(url, fields, {
        follow: true,
        headers: {
          Referer: this.#appPageUrl(),
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
    if (this.#isLoginResponse(response) || response.status === 401) {
      throw this.#loginError(pathKey, { path, status: response.status });
    }
    // 403 在 jwapp 上**只**意味着应用授权握手没做 / 过期（真机实测：会话有效也 403）。
    // 它必须和"未登录"分开，否则用户会被反复要求重新登录。
    if (response.status === 403) {
      const steps = [
        ...(this.handshake.steps ?? []),
        { step: pathKey, status: 403, error: '业务接口返回 403（应用授权可能已过期）' },
      ];
      this.handshake = { ok: false, appId: this.handshake.appId ?? this.appId ?? null, steps };
      throw new TimetableError(
        `课表应用授权握手失败（业务接口 ${path} 返回 403）：已用全新握手重试一次，仍被拒绝。` +
          '这不是路径错误，也不是账号没有权限。',
        {
          code: TIMETABLE_ERROR.EHALL_HANDSHAKE_FAILED,
          status: 502,
          details: { path, status: 403, handshake: this.handshake },
        },
      );
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
