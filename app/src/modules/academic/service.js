/**
 * 学业模块的服务层：登录、同步、纳入开关、统计。
 *
 * 三条不可动摇的规则（都写在这里，因为它们是这个模块"能不能被信任"的关键）：
 *
 * 1. **同步不覆盖用户意志**。`included` / `includedAt` / `includedBy` 只由用户操作改写，
 *    同步时即使记录被更新也一律原样保留 —— 否则每次同步都会把用户手工排除的课又勾回来。
 *
 * 2. **同步是幂等的**。以 `externalId`（教务的 WID）为键 upsert，重复同步只更新易变字段，
 *    不产生重复记录，也不改动 `id`。
 *
 * 3. **不删除本地记录**。上游某次没返回的记录标 `stale: true` 而不是删掉 ——
 *    教务偶尔会因为选课/成绩撤消而少返回几行，直接删会让用户的勾选记录凭空消失。
 */

import path from 'node:path';

import { CookieJar, HttpClient } from '../lms/http-client.js';
import { AUTH_STATUS, CasAuth, generateVisitorId } from '../lms/cas-auth.js';
import { JsonFile } from '../lms/secret-store.js';
import { AcademicApi, AcademicError, ACADEMIC_ERROR } from './api.js';
import { resolveAcademicConfig } from './config.js';
import { computeStats, gradePointOf } from './gpa.js';

/** 同步结果的计数口径。 */
const emptyCounts = () => ({ inserted: 0, updated: 0, unchanged: 0, stale: 0, skipped: 0 });

export class AcademicService {
  constructor({ store, services, broadcast = () => {}, config = {}, dataDir, visitorId } = {}) {
    this.store = store;
    this.broadcast = broadcast;
    this.dataDir = dataDir ?? '.';
    this.services = services ?? {};
    this.config = resolveAcademicConfig(config ?? {});

    this.jar = new CookieJar();
    this.http = new HttpClient({
      userAgent: this.config.userAgent,
      timeoutMs: this.config.timeoutMs,
      jar: this.jar,
    });
    this.auth = new CasAuth({ http: this.http, config: this.config, visitorId: visitorId ?? generateVisitorId() });
    this.api = new AcademicApi({ http: this.http, config: this.config });

    /** 会话票据是凭据 → 单独文件 + 0600。 */
    this.sessionFile = new JsonFile(path.join(this.dataDir, 'academic-session.json'));
    /** 同步元信息是普通业务数据 → 0644。 */
    this.metaFile = new JsonFile(path.join(this.dataDir, 'academic-meta.json'), { mode: 0o644 });

    this.state = {
      status: 'anonymous',
      mfa: null,
      error: null,
      lastSyncAt: null,
      lastSyncCounts: emptyCounts(),
      lastError: null,
    };
    this.syncing = false;
    this.restored = false;
  }

  // ---------------------------------------------------------------- 状态

  /** 给 `/academic/status` 与界面用。 */
  status() {
    const grades = this.store.academicGrades.all();
    const active = grades.filter((item) => item.active !== false);
    const stats = computeStats(active, { table: this.config.gpaTable });
    return {
      status: this.state.status,
      loggedIn: this.state.status === 'ready',
      mfa: this.state.mfa,
      captchaRequired: Boolean(this.auth?.captchaRequired),
      error: this.state.error,
      /** 握手诊断：403 时用户/开发者最需要看的就是这里 */
      handshake: this.api.handshake,
      grades: {
        total: grades.length,
        active: active.length,
        stale: grades.filter((item) => item.stale === true).length,
        excluded: grades.filter((item) => item.included === false).length,
        terms: [...new Set(active.map((item) => item.term).filter(Boolean))].sort(),
      },
      gpa: stats.gpa,
      weightedAverage: stats.weightedAverage,
      totalCredits: stats.totalCredits,
      warnings: stats.warnings,
      lastSyncAt: this.state.lastSyncAt,
      lastSyncCounts: this.state.lastSyncCounts,
      lastError: this.state.lastError,
    };
  }

  // ---------------------------------------------------------------- 登录

  /** 进程启动时调用：恢复上次会话。失败不抛，退化成未登录。 */
  async restore() {
    this.restored = true;
    const saved = await this.sessionFile.read();
    const meta = await this.metaFile.read();
    if (meta) {
      this.state.lastSyncAt = meta.lastSyncAt ?? null;
      this.state.lastSyncCounts = meta.lastSyncCounts ?? emptyCounts();
    }
    if (!saved?.cookies?.length) return false;
    try {
      this.jar = CookieJar.fromJSON(saved.cookies);
      this.http.jar = this.jar;
      this.auth.hasLogin = true;
      this.state.status = 'ready';
      // 会话可能是过期的，标记成"待验证"：真正发请求时若 401 再清掉
      return true;
    } catch {
      await this.#clearSession();
      return false;
    }
  }

  async login({ username, password, captcha, trustAgent = true } = {}) {
    if (!username || !password) {
      throw new AcademicError('需要学号与密码', { code: ACADEMIC_ERROR.NOT_LOGGED_IN, status: 400 });
    }
    // 复用思源学堂那套状态机：同样的 CAS OAuth2 四跳，RSA 加密密码，MFA 与验证码都支持
    const begun = await this.auth.begin(this.config.loginUrl);
    const result = await this.auth.login({ username, password, captcha, trustAgent });
    return this.#handleAuthResult(result, begun);
  }

  async sendMfaCode() {
    const result = await this.auth.sendMfaCode();
    this.state.mfa = { ...(this.state.mfa ?? {}), ...result, sent: true };
    return this.state.mfa;
  }

  async verifyMfaCode(code) {
    const result = await this.auth.verifyMfaCode(code);
    return this.#handleAuthResult(result, 'verify');
  }

  captcha() {
    return this.auth.fetchCaptcha();
  }

  async logout() {
    await this.#clearSession();
    return this.status();
  }

  #handleAuthResult(result, begun) {
    if (result?.status === AUTH_STATUS.READY) {
      this.state.status = 'ready';
      this.state.mfa = null;
      this.state.error = null;
      this.api.reset(); // 换账号必须重做握手
      return this.#finishLogin();
    }
    if (result?.status === AUTH_STATUS.NEED_MFA) {
      this.state.status = 'need_mfa';
      this.state.mfa = { phone: result.phone ?? null, sent: false };
      return { status: this.state.status, mfa: this.state.mfa, begun };
    }
    if (result?.status === AUTH_STATUS.NEED_CAPTCHA) {
      this.state.status = 'need_captcha';
      return { status: this.state.status, captchaRequired: true, begun };
    }
    this.state.status = 'error';
    this.state.error = result?.message ?? '登录失败';
    return { status: this.state.status, error: this.state.error, begun };
  }

  async #finishLogin() {
    await this.#persistSession();
    return this.status();
  }

  async #persistSession() {
    await this.sessionFile.write({
      savedAt: new Date().toISOString(),
      cookies: this.jar.toJSON(),
    });
  }

  async #persistMeta() {
    await this.metaFile.write({
      lastSyncAt: this.state.lastSyncAt,
      lastSyncCounts: this.state.lastSyncCounts,
    });
  }

  async #clearSession() {
    this.jar = new CookieJar();
    this.http.jar = this.jar;
    this.auth.reset();
    this.api.reset();
    this.state.status = 'anonymous';
    this.state.mfa = null;
    this.state.error = null;
    await this.sessionFile.remove();
  }

  /** 业务请求前确认登录态；失败时清票据并抛 401。 */
  async #ensureReady() {
    if (this.state.status === 'ready') return;
    if (this.restored && this.jar.toJSON().length) {
      this.state.status = 'ready';
      return;
    }
    throw new AcademicError('尚未登录教务系统，请先登录', { code: ACADEMIC_ERROR.NOT_LOGGED_IN, status: 401 });
  }

  // ---------------------------------------------------------------- 同步

  /**
   * 拉取并落库。
   *
   * @param {object} [options]
   * @param {boolean} [options.dryRun] 只拉不算（预览用）
   * @returns {Promise<{ ok: boolean, counts: object, stats: object, handshake: object }>}
   */
  async sync({ dryRun = false } = {}) {
    if (this.syncing) {
      throw new AcademicError('同步正在进行中，请稍候', { code: ACADEMIC_ERROR.BUSINESS_ERROR, status: 409 });
    }
    await this.#ensureReady();
    this.syncing = true;
    try {
      const { rows, handshake } = await this.api.fetchGrades();
      const counts = dryRun ? this.#previewCounts(rows) : await this.#upsert(rows);
      const stored = this.store.academicGrades.all().filter((item) => item.active !== false);
      const stats = computeStats(stored, { table: this.config.gpaTable });

      if (!dryRun) {
        this.state.lastSyncAt = new Date().toISOString();
        this.state.lastSyncCounts = counts;
        this.state.lastError = null;
        await this.#persistSession(); // 会话可能已被刷新
        await this.#persistMeta();
        this.broadcast({ type: 'data_changed', module: 'academic', reason: 'sync' });
      }
      return { ok: true, counts, stats, handshake };
    } catch (error) {
      this.state.lastError = { code: error.code ?? 'UNKNOWN', message: error.message, at: new Date().toISOString() };
      // 登录态失效时顺手清掉本地票据，避免下次还拿过期会话去撞
      if (error.code === ACADEMIC_ERROR.NOT_LOGGED_IN) await this.#clearSession();
      throw error;
    } finally {
      this.syncing = false;
    }
  }

  /** 预览：不改库，只算会新增/更新多少。 */
  #previewCounts(rows) {
    const counts = emptyCounts();
    const existing = new Map(this.store.academicGrades.all().map((item) => [item.externalId, item]));
    for (const row of rows) {
      if (!row.externalId) counts.skipped += 1;
      else if (existing.has(row.externalId)) counts.updated += 1;
      else counts.inserted += 1;
    }
    return counts;
  }

  /**
   * 幂等 upsert。
   *
   * ★ 这里**绝不**写 `included` / `includedAt` / `includedBy` —— 见文件头规则 1。
   */
  async #upsert(rows) {
    const counts = emptyCounts();
    const collection = this.store.academicGrades;
    const existing = new Map(collection.all().map((item) => [item.externalId, item]));
    const seen = new Set();
    const now = new Date().toISOString();

    for (const row of rows) {
      if (!row.externalId) {
        counts.skipped += 1;
        continue;
      }
      seen.add(row.externalId);
      // 幂等键之外的一切都算"易变字段"，可以整体覆盖
      const payload = {
        externalId: row.externalId,
        courseName: row.courseName,
        courseCode: row.courseCode,
        credit: row.credit,
        score: row.score,
        gradePoint: row.gradePoint,
        gradePointSource: row.gradePointSource,
        term: row.term,
        termLabel: row.termLabel,
        nature: row.nature,
        natureLabel: row.natureLabel,
        category: row.category,
        categoryLabel: row.categoryLabel,
        examType: row.examType,
        examTypeLabel: row.examTypeLabel,
        hours: row.hours,
        finalScore: row.finalScore,
        finalScoreText: row.finalScoreText,
        midScore: row.midScore,
        usualScore: row.usualScore,
        levelGrade: row.levelGrade,
        valid: row.valid,
        active: row.active,
        passed: row.passed,
        passedLabel: row.passedLabel,
        stale: false,
        syncedAt: now,
      };

      const current = existing.get(row.externalId);
      if (!current) {
        // 新记录：能算出绩点的默认纳入；算不出的默认不纳入（按方案，避免静默污染学分绩），
        // 并在界面上作为"需要留意"提示出来。
        const { point } = gradePointOf(row, this.config.gpaTable);
        await collection.insert({ ...payload, included: point !== null, includedAt: null, includedBy: null });
        counts.inserted += 1;
        continue;
      }

      // ★ 比较时**排除 `syncedAt`** —— 它每次都是新时间戳，算进去的话每条记录都会被判成"变了"，
      //   幂等就成了假的（每次都全量写盘）。它的语义因此是「内容最后一次变化的时间」。
      const changed = Object.keys(payload).some(
        (key) => key !== 'syncedAt' && !shallowEqual(current[key], payload[key]),
      );
      if (changed) {
        await collection.update(current.id, payload);
        counts.updated += 1;
      } else {
        counts.unchanged += 1;
      }
    }

    // 本次没返回的标 stale，不删（见文件头规则 3）
    for (const item of collection.all()) {
      const missing = !seen.has(item.externalId);
      if (missing && item.stale !== true) {
        await collection.update(item.id, { stale: true });
        counts.stale += 1;
      }
    }

    return counts;
  }

  // ---------------------------------------------------------------- 查询与开关

  /**
   * 列出成绩。
   * @param {object} [options]
   * @param {string} [options.term] 按学期过滤
   * @param {boolean} [options.included] 只看纳入/未纳入
   * @param {boolean} [options.includeStale] 是否带上 stale 记录（默认带）
   */
  listGrades({ term, included, includeStale = true, nature } = {}) {
    let list = this.store.academicGrades.all();
    if (!includeStale) list = list.filter((item) => item.stale !== true);
    if (term) list = list.filter((item) => item.term === term);
    if (nature) list = list.filter((item) => item.nature === nature);
    if (included !== undefined) list = list.filter((item) => (item.included !== false) === Boolean(included));
    return list
      .map((item) => ({ ...item, gradePointResolved: gradePointOf(item, this.config.gpaTable).point }))
      .sort(
        (a, b) =>
          String(b.term ?? '').localeCompare(String(a.term ?? '')) ||
          String(a.courseName ?? '').localeCompare(String(b.courseName ?? ''), 'zh-Hans-CN'),
      );
  }

  /** 统计（可带过滤条件）。 */
  stats(options = {}) {
    const list = this.listGrades(options).filter((item) => item.active !== false);
    const stats = computeStats(list, { table: this.config.gpaTable });

    /**
     * 已获得学分：与 `totalCredits`（只算被纳入的）不同，这个数**不随勾选变化** ——
     * 通过了的课就算数（`SFJG === '1'`，缺失时退化为总评 >= 60）。
     * 学生问「我修了多少学分」时想听的是这个，而不是"当前参与学分绩计算的学分"。
     */
    const earnedCredits = round2(
      list
        .filter((item) => {
          if (item.passed !== undefined && item.passed !== null && item.passed !== '') return String(item.passed) === '1';
          return typeof item.score === 'number' && item.score >= 60;
        })
        .reduce((sum, item) => sum + (typeof item.credit === 'number' ? item.credit : 0), 0),
    );

    /**
     * "需要留意"：没被纳入、**且**确实算不出绩点的课 ——
     * 这类课是等级制或成绩形式未识别，用户多半想看到它们。
     * 政策放在服务层，`gpa.js` 保持纯计算。
     */
    const needsAttention = list
      .filter((item) => item.included === false && item.gradePointResolved === null)
      .map((item) => ({
        id: item.id,
        courseName: item.courseName,
        term: item.term,
        termLabel: item.termLabel,
        score: item.score,
        scoreText: item.finalScoreText ?? item.levelGrade ?? null,
      }));
    return { ...stats, earnedCredits, needsAttention };
  }

  /** 单项纳入开关。 */
  async setIncluded(id, included, { by = 'user' } = {}) {
    const current = this.store.academicGrades.get(id);
    if (!current) throw new AcademicError(`成绩记录不存在：${id}`, { code: ACADEMIC_ERROR.BUSINESS_ERROR, status: 404 });
    const updated = await this.store.academicGrades.update(id, {
      included: Boolean(included),
      includedAt: new Date().toISOString(),
      includedBy: by,
    });
    this.broadcast({ type: 'data_changed', module: 'academic', reason: 'toggle' });
    return updated;
  }

  /**
   * 批量纳入/排除。
   *
   * 三种选择方式（可组合，取并集）：显式 `ids`、按 `term`、以及 `only` 里的预设语义。
   * 预设语义是为了让前端不必自己算 id 列表：
   *   - `all`        全部有效成绩
   *   - `failed`     不及格（总评 < 60 或 passed 标记为否）
   *   - `unmapped`   算不出绩点的（等级制等）
   *   - `term`       某一学期
   */
  async setIncludedBulk({ ids = [], term, only, included = true } = {}) {
    const target = new Set(ids);
    if (term) for (const item of this.store.academicGrades.all()) if (item.term === term) target.add(item.id);
    if (only) for (const item of this.#selectByPreset(only)) target.add(item.id);

    let changed = 0;
    const now = new Date().toISOString();
    for (const id of target) {
      const current = this.store.academicGrades.get(id);
      if (!current) continue;
      if ((current.included !== false) === Boolean(included)) continue;
      await this.store.academicGrades.update(id, { included: Boolean(included), includedAt: now, includedBy: 'user' });
      changed += 1;
    }
    if (changed) this.broadcast({ type: 'data_changed', module: 'academic', reason: 'bulk-toggle' });
    return { changed, requested: target.size };
  }

  #selectByPreset(preset) {
    const list = this.store.academicGrades.all();
    switch (preset) {
      case 'all':
        return list;
      case 'failed':
        return list.filter((item) => {
          if (item.passed !== undefined && item.passed !== null && item.passed !== '') return String(item.passed) !== '1';
          return typeof item.score === 'number' && item.score < 60;
        });
      case 'unmapped':
        return list.filter((item) => gradePointOf(item, this.config.gpaTable).point === null);
      case 'stale':
        return list.filter((item) => item.stale === true);
      default:
        return [];
    }
  }

  /** 一键重置为"同步时的默认纳入状态"。 */
  async resetIncluded() {
    let changed = 0;
    const now = new Date().toISOString();
    for (const item of this.store.academicGrades.all()) {
      const { point } = gradePointOf(item, this.config.gpaTable);
      const should = point !== null;
      if ((item.included !== false) === should) continue;
      await this.store.academicGrades.update(item.id, { included: should, includedAt: now, includedBy: 'reset' });
      changed += 1;
    }
    if (changed) this.broadcast({ type: 'data_changed', module: 'academic', reason: 'reset' });
    return { changed };
  }
}

/** 只比较同步会写的那些**标量**字段。 */
function shallowEqual(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
}

/** 保留两位，抹掉浮点尾差。 */
function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}
