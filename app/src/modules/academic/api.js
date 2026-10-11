/**
 * 教务成绩接口客户端。
 *
 * 复用思源学堂那套已经跑通的 `HttpClient`（手动跟随重定向 + Cookie 罐），
 * 因为这里的坑完全一样：CAS 的每一跳都会 `Set-Cookie`，用 Node 自带的自动重定向会丢票据。
 *
 * ★ 本文件最要紧的一件事：**四步握手**。
 *   只带 cookie 直接 POST `xscjcx.do` 会**稳定 403** —— 这不是"路径错"也不是"没权限"，
 *   而是少了刷新 `_WEU` 防伪 token 的支撑调用。实测细节见 docs/教务成绩接口调研.md。
 *   排查这条花了很久（40 余次请求、8 个假设全部排除），所以这里写死顺序并在错误信息里点明。
 */

import { absolute, APP_ID_PATTERN, DISPLAY_FIELDS, GRADE_ROWS_PATH, displayKey, SUCCESS_CODE, VALID_FLAG } from './config.js';
import { gradePointOf, toNumber } from './gpa.js';

/** 学业模块的错误码，供路由层翻译成 HTTP 状态与用户可读文案。 */
export const ACADEMIC_ERROR = {
  /** 没登录 / 会话过期（401，或被 302 踢回 CAS）。 */
  NOT_LOGGED_IN: 'ACADEMIC_NOT_LOGGED_IN',
  /** 403 —— 十有八九是握手没做或失效。 */
  HANDSHAKE_FAILED: 'ACADEMIC_HANDSHAKE_FAILED',
  /** 响应不是 JSON、或结构里找不到 rows —— 上游改版了。 */
  INTERFACE_CHANGED: 'ACADEMIC_INTERFACE_CHANGED',
  /** 响应是 JSON 但 `code !== '0'`。 */
  BUSINESS_ERROR: 'ACADEMIC_BUSINESS_ERROR',
  /** 网络层失败。 */
  NETWORK: 'ACADEMIC_NETWORK',
};

export class AcademicError extends Error {
  constructor(message, { code = ACADEMIC_ERROR.NETWORK, status = 0, url = '', details = null } = {}) {
    super(message);
    this.name = 'AcademicError';
    this.code = code;
    this.status = status;
    this.url = url;
    this.details = details;
  }
}

const trimmed = (value) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  // 教务用空串 / "null" / "-" 之类表示"没有"，统一收敛成 null
  return text === '' || text === 'null' || text === '-' ? null : text;
};

/**
 * 把一行教务成绩归一化成内部记录。
 *
 * 字段名全部走 `config.fields`，所以上游改名时只改 config。
 * 幂等键优先 `WID`，退化到「课程号 + 学期」。
 */
export function normalizeGrade(raw = {}, config) {
  const F = config.fields;
  const pick = (key) => raw[F[key]];
  const display = (key) => {
    const rawKey = DISPLAY_FIELDS[key];
    return rawKey ? trimmed(raw[displayKey(rawKey)]) : null;
  };

  const externalId = trimmed(pick('externalId'));
  const courseCode = trimmed(pick('courseCode'));
  const term = trimmed(pick('term'));
  const classId = trimmed(pick('classId'));

  const grade = {
    /**
     * 幂等键：教务的 WID；没有就用「课程号@学期@教学班」拼一个稳定的。
     * 两者都拿不到时为 null，同步层会退化成"每次都新增"，并在结果里提示。
     */
    externalId: externalId ?? ([courseCode, term, classId].filter(Boolean).join('@') || null),
    courseName: trimmed(pick('courseName')) ?? '',
    courseCode,
    credit: toNumber(pick('credit')),
    score: toNumber(pick('score')),
    gradePoint: toNumber(pick('gradePoint')),
    term,
    termLabel: display('term') ?? term,
    nature: trimmed(pick('nature')),
    natureLabel: display('nature'),
    category: trimmed(pick('category')),
    categoryLabel: display('category'),
    examType: trimmed(pick('examType')),
    examTypeLabel: display('examType'),
    hours: toNumber(pick('hours')),
    /** 期末/期中/平时 —— 数值优先，拿不到就留文本（等级制会走这里） */
    finalScore: toNumber(pick('finalScore')),
    finalScoreText: display('finalScore') ?? trimmed(pick('finalScore')),
    midScore: toNumber(pick('midScore')),
    usualScore: toNumber(pick('usualScore')),
    levelGrade: trimmed(pick('levelGrade')),
    valid: trimmed(pick('valid')) ?? VALID_FLAG,
    passed: trimmed(pick('passed')),
    passedLabel: display('passed'),
    /** 教务这一行是否有效成绩 */
    active: String(trimmed(pick('valid')) ?? VALID_FLAG) === VALID_FLAG,
  };

  // 总评拿不到数值时，退而用期末成绩的文本（等级制课程会这样），并标出来源由界面提示
  if (grade.score === null && grade.finalScore !== null) grade.score = grade.finalScore;
  if (!grade.courseName && !grade.courseCode) return null;

  const { source } = gradePointOf(grade, config.gpaTable);
  grade.gradePointSource = source;
  return grade;
}

export class AcademicApi {
  /**
   * @param {object} options
   * @param {import('../lms/http-client.js').HttpClient} options.http
   * @param {object} options.config 见 config.js 的 resolveAcademicConfig()
   */
  constructor({ http, config }) {
    this.http = http;
    this.config = config;
    /** 握手的应用 ID（第一次从应用页里取到后缓存）。 */
    this.appId = config.app.id;
    /** 本次会话是否已完成授权握手。 */
    this.authorized = false;
    /** 最近一次握手的诊断信息，供 /status 展示。 */
    this.handshake = { appId: null, at: null, weuRefreshed: null, steps: [] };
  }

  /** 换账号或重新登录后必须重做握手。 */
  reset() {
    this.authorized = false;
    this.handshake = { appId: null, at: null, weuRefreshed: null, steps: [] };
    return this;
  }

  #referer() {
    return absolute(this.config, this.config.app.indexPath);
  }

  #weu() {
    return this.http.jar.toJSON().find((cookie) => cookie.name === '_WEU')?.value ?? '';
  }

  /** 统一的请求头：Referer 必须指向应用页，否则服务端会拒绝。 */
  #headers() {
    return {
      Referer: this.#referer(),
      Origin: this.config.baseUrl,
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    };
  }

  /** 被踢回 CAS 登录页 = 会话失效。 */
  #assertNotLoginRedirect(response, what) {
    if (/\/cas\/login|login\.xjtu\.edu\.cn/.test(response.url ?? '')) {
      throw new AcademicError(`登录态已失效（${what}被重定向到统一身份认证），请重新登录`, {
        code: ACADEMIC_ERROR.NOT_LOGGED_IN,
        status: 401,
        url: response.url,
      });
    }
  }

  /**
   * 第 1 步：打开成绩应用页，建立 jwapp 子系统会话，并从页面里取 appId。
   * 页面里带 `window._JW_INIT_CONFIG`，其中 `appId` 就是握手要用的值。
   */
  async loadAppPage() {
    let response;
    try {
      response = await this.http.get(this.#referer(), { follow: true });
    } catch (error) {
      throw new AcademicError(`打开成绩应用页失败：${error.message}`, { code: ACADEMIC_ERROR.NETWORK });
    }
    this.#assertNotLoginRedirect(response, '应用页');
    if (response.status !== 200) {
      throw new AcademicError(`成绩应用页返回 HTTP ${response.status}`, {
        code: response.status === 403 ? ACADEMIC_ERROR.HANDSHAKE_FAILED : ACADEMIC_ERROR.INTERFACE_CHANGED,
        status: response.status,
        url: response.url,
      });
    }
    const matched = APP_ID_PATTERN.exec(response.text);
    if (matched?.[1]) this.appId = matched[1];
    return this.appId;
  }

  /**
   * 第 2、3 步：授权握手。
   *
   * 第 2 步 `getAppConfig` 是**关键** —— 它把本账号对该应用的授权登记进会话；
   * 第 3 步 `cxjwggbbdqx` 顺带刷新 `_WEU` 防伪 cookie（实测值会变）。
   * 两步都失败不致命（有些部署只有其中一步），但如果后面仍然 403，错误信息会指向这里。
   */
  async authorize() {
    const appId = await this.loadAppPage();
    const steps = [];
    const before = this.#weu();

    const configPath = typeof this.config.app.appConfigPath === 'function'
      ? this.config.app.appConfigPath(this.config.app.name, appId)
      : `/jwapp/sys/funauthapp/api/getAppConfig/${this.config.app.name}-${appId}.do`;
    try {
      const response = await this.http.get(absolute(this.config, configPath), { follow: true, headers: this.#headers() });
      this.#assertNotLoginRedirect(response, '授权握手');
      steps.push({ step: 'getAppConfig', status: response.status });
    } catch (error) {
      if (error instanceof AcademicError && error.code === ACADEMIC_ERROR.NOT_LOGGED_IN) throw error;
      steps.push({ step: 'getAppConfig', status: 0, error: error.message });
    }

    try {
      const response = await this.http.postForm(
        absolute(this.config, this.config.app.appInitPath),
        { SFQY: '1', APP: appId },
        { follow: true, headers: this.#headers() },
      );
      this.#assertNotLoginRedirect(response, '应用初始化');
      steps.push({ step: 'appInit', status: response.status });
    } catch (error) {
      if (error instanceof AcademicError && error.code === ACADEMIC_ERROR.NOT_LOGGED_IN) throw error;
      steps.push({ step: 'appInit', status: 0, error: error.message });
    }

    const after = this.#weu();
    this.authorized = true;
    this.handshake = { appId, at: new Date().toISOString(), weuRefreshed: before !== after, steps };
    return this.handshake;
  }

  /**
   * 第 4 步：查成绩。
   *
   * 若未握手（或握手已失效）会先补握手；遇到 403 会用**全新握手重试一次** ——
   * 因为 403 在这个接口上几乎只意味着握手过期，直接报错会让用户白跑一趟。
   *
   * @param {object} [options]
   * @param {boolean} [options.forceHandshake] 强制重做握手
   * @returns {Promise<{ rows: object[], raw: object, handshake: object }>}
   */
  async fetchGrades({ forceHandshake = false } = {}) {
    if (forceHandshake || !this.authorized) await this.authorize();
    try {
      return await this.#queryGrades();
    } catch (error) {
      // 403 = 握手过期：重做一次再试，这是唯一值得自动重试的失败
      if (error instanceof AcademicError && error.code === ACADEMIC_ERROR.HANDSHAKE_FAILED) {
        await this.authorize();
        return await this.#queryGrades();
      }
      throw error;
    }
  }

  async #queryGrades() {
    const url = absolute(this.config, this.config.app.gradePath);
    let response;
    try {
      response = await this.http.postForm(url, this.config.gradeBody, { follow: true, headers: this.#headers() });
    } catch (error) {
      throw new AcademicError(`成绩查询请求失败：${error.message}`, { code: ACADEMIC_ERROR.NETWORK, url });
    }

    this.#assertNotLoginRedirect(response, '成绩查询');

    if (response.status === 401) {
      throw new AcademicError('登录态已失效，请重新登录', {
        code: ACADEMIC_ERROR.NOT_LOGGED_IN,
        status: 401,
        url,
      });
    }
    if (response.status === 403) {
      throw new AcademicError(
        '成绩接口返回 403 —— 应用授权握手失败或已过期（这不是路径错误，也不是账号没有权限）',
        { code: ACADEMIC_ERROR.HANDSHAKE_FAILED, status: 403, url, details: this.handshake },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new AcademicError(`成绩接口返回 HTTP ${response.status}`, {
        code: ACADEMIC_ERROR.INTERFACE_CHANGED,
        status: response.status,
        url,
        details: { body: response.text.slice(0, 300) },
      });
    }

    let payload;
    try {
      payload = JSON.parse(response.text);
    } catch {
      throw new AcademicError('成绩接口返回的不是 JSON（可能登录态失效或上游改版）', {
        code: ACADEMIC_ERROR.INTERFACE_CHANGED,
        url,
        details: { body: response.text.slice(0, 300) },
      });
    }

    // 注意：成功码是**字符串** '0'
    if (String(payload?.code ?? '') !== String(this.config.successCode)) {
      throw new AcademicError(`成绩接口返回业务错误 code=${JSON.stringify(payload?.code)}`, {
        code: ACADEMIC_ERROR.BUSINESS_ERROR,
        url,
        details: { code: payload?.code, msg: payload?.msg ?? payload?.message ?? null },
      });
    }

    let node = payload;
    for (const key of GRADE_ROWS_PATH) node = node?.[key];
    if (!Array.isArray(node)) {
      throw new AcademicError(`成绩响应里找不到 ${GRADE_ROWS_PATH.join('.')}（上游结构可能已变）`, {
        code: ACADEMIC_ERROR.INTERFACE_CHANGED,
        url,
        details: { keys: Object.keys(payload?.datas ?? {}) },
      });
    }

    const rows = node.map((raw) => normalizeGrade(raw, this.config)).filter(Boolean);
    return { rows, raw: payload, handshake: this.handshake };
  }
}
