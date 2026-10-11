/**
 * 西交大课表服务：把「登录 → 取学期 → 拉课表 → 预览 → 写入日历」串起来。
 *
 * 设计要点（与 `src/server/lms/service.js` 保持一致，方便用户和 AI 只学一套交互）：
 * - 直接复用思源学堂那套 `HttpClient` + `CasAuth`：ehall 的登录同样是
 *   `业务 URL → 302 amp-auth-adapter/login?service=… → login.xjtu.edu.cn/cas/login`，
 *   `CasAuth.begin(loginUrl)` 本来就支持任意入口 URL，不需要再写一套认证；
 * - 会话只保留在内存 + `data/timetable-session.json`（0600，7 天失效），**不保存密码**；
 * - 起始日当**用户资产**：`data/timetable-terms.json` 落盘，`source` 标 `ehall` / `guess` / `manual`，
 *   手改过（`manual`）的永不被自动值覆盖（见 `docs/课表接入调研.md` 第 4 节）；
 * - 课表原始行落 `data/timetable-cache.json`，离线和重复预览都不再打学校服务器；
 * - 同步「先预览后应用」，逐周展开，幂等靠 `externalId = tt:<term>:<hash8>:<week>`；
 * - 只动 `externalId` 以 `tt:` 开头的记录，**绝不删除用户手改的日程**。
 */

import path from 'node:path';

import { HttpError } from '../http/router.js';
import { todayKey } from '../../shared/time.js';
import { AUTH_STATUS, CasAuth, generateVisitorId } from '../lms/cas-auth.js';
import { CookieJar, HttpClient } from '../lms/http-client.js';
import { JsonFile } from '../lms/secret-store.js';
import { EhallApi, EhallError } from './api.js';
import { candidateTerms, resolveTimetableConfig, termLabel } from './config.js';
import { DEFAULT_TERM_WEEKS, TermFormatError, guessTermStart, parseTerm, termLength, termRange, validateTermStart } from './term.js';
import { bitmapToWeeks, describeWeeks, WeekParseError } from './weeks.js';
import { buildTimetablePlan, isTimetableExternalId } from './to-calendar.js';

/** 会话文件最多认多久（超过则忽略，强制重新登录）。 */
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 每学期最多保留多少条课表原始行（防止异常数据把缓存文件撑爆）。 */
const MAX_CACHED_ROWS = 2000;

export class TimetableService {
  constructor({ store, services, broadcast = () => {}, config = resolveTimetableConfig(), dataDir, visitorId } = {}) {
    this.store = store;
    this.services = services ?? {};
    this.broadcast = broadcast;
    this.config = resolveTimetableConfig(config ?? {});
    this.dataDir = dataDir ?? store?.dataDir ?? '.';

    this.jar = new CookieJar();
    this.http = new HttpClient({ userAgent: this.config.userAgent, timeoutMs: this.config.timeoutMs, jar: this.jar });
    this.auth = new CasAuth({ http: this.http, config: this.config, visitorId: visitorId ?? generateVisitorId() });
    this.api = new EhallApi({ http: this.http, config: this.config });

    this.sessionFile = new JsonFile(path.join(this.dataDir, 'timetable-session.json'));
    this.termsFile = new JsonFile(path.join(this.dataDir, 'timetable-terms.json'), { mode: 0o644 });
    this.cacheFile = new JsonFile(path.join(this.dataDir, 'timetable-cache.json'), { mode: 0o644 });

    /** 学期起始日缓存（内存镜像，落盘见 termsFile）。 */
    this.terms = {};
    /** 课表原始行缓存：`{ "<term>": { rows, fetchedAt } }`。 */
    this.cache = {};
    this.verified = false;
    this.restored = false;
    /** 最近一次预览的计划，apply 优先按 keys 从中取值，保证「所见即所写」。 */
    this.lastPlan = null;
    this.state = {
      status: 'anonymous',
      user: null,
      mfa: null,
      error: null,
      currentTerm: null,
      lastTermsAt: null,
      lastTimetableAt: null,
      lastSyncAt: null,
    };
  }

  // ------------------------------------------------------------------ 对外状态

  status() {
    const schedules = this.#syncedSchedules();
    const cachedTerms = Object.keys(this.cache);
    return {
      status: this.state.status,
      user: this.state.user,
      mfa: this.state.mfa,
      captchaRequired: Boolean(this.auth?.captchaRequired),
      error: this.state.error,
      baseUrl: this.config.baseUrl,
      loginUrl: this.config.loginUrl,
      currentTerm: this.state.currentTerm,
      terms: {
        known: Object.keys(this.terms).length,
        manual: Object.values(this.terms).filter((item) => item.source === 'manual').length,
      },
      cache: {
        terms: cachedTerms,
        rows: cachedTerms.reduce((sum, term) => sum + (this.cache[term]?.rows?.length ?? 0), 0),
        lastTimetableAt: this.state.lastTimetableAt,
      },
      synced: { schedules: schedules.length },
      lastSyncAt: this.state.lastSyncAt,
    };
  }

  // ------------------------------------------------------------------ 登录

  /** 进程启动时调用：恢复上次的会话与本地缓存。 */
  async restore() {
    if (this.restored) return this.status();
    this.restored = true;

    const savedTerms = (await this.termsFile.read()) ?? {};
    if (savedTerms.terms && typeof savedTerms.terms === 'object') {
      this.terms = savedTerms.terms;
      this.state.lastTermsAt = savedTerms.lastTermsAt ?? null;
    }
    const savedCache = (await this.cacheFile.read()) ?? {};
    if (savedCache.terms && typeof savedCache.terms === 'object') {
      this.cache = savedCache.terms;
      this.state.lastTimetableAt = savedCache.lastTimetableAt ?? null;
    }

    const saved = await this.sessionFile.read();
    if (!saved?.cookies?.length) return this.status();
    const savedAt = Date.parse(saved.savedAt ?? '');
    if (Number.isFinite(savedAt) && Date.now() - savedAt > SESSION_MAX_AGE_MS) {
      await this.sessionFile.remove();
      return this.status();
    }
    this.jar = CookieJar.fromJSON(saved.cookies);
    this.http.jar = this.jar;
    this.state.user = saved.user ?? null;
    this.state.currentTerm = saved.currentTerm ?? null;
    // 先乐观地认为已登录，真正失效会在第一次业务请求时被发现并清理
    this.state.status = 'ready';
    this.state.error = null;
    return this.status();
  }

  async login({ username, password, captcha, trustAgent = true } = {}) {
    this.state.error = null;
    try {
      if (!this.auth.postUrl && !this.auth.hasLogin) {
        const started = await this.auth.begin(this.config.loginUrl);
        if (started === AUTH_STATUS.READY) return this.#finishLogin();
      }
      const result = await this.auth.login({ username, password, captcha, trustAgent });
      return this.#handleAuthResult(result);
    } catch (error) {
      throw this.#translate(error, '登录教务系统失败');
    }
  }

  async sendMfaCode() {
    try {
      const result = await this.auth.sendMfaCode();
      this.state.status = 'need_mfa';
      this.state.mfa = { ...(this.state.mfa ?? {}), flow: 'mfa', required: true, phoneMasked: result.phoneMasked, sent: true };
      return { phone: result.phone, phoneMasked: result.phoneMasked, status: this.status() };
    } catch (error) {
      throw this.#translate(error, '发送验证码失败');
    }
  }

  async verifyMfaCode(code) {
    try {
      await this.auth.verifyMfaCode(code);
      const result = await this.auth.login({});
      return this.#handleAuthResult(result);
    } catch (error) {
      throw this.#translate(error, '验证码校验失败');
    }
  }

  async captcha() {
    try {
      return await this.auth.fetchCaptcha();
    } catch (error) {
      throw this.#translate(error, '获取验证码失败');
    }
  }

  async logout() {
    await this.#clearSession();
    return this.status();
  }

  // ------------------------------------------------------------------ 学期

  /** 当前学期编号（`dqxnxq.do`）。结果在内存里，`refresh: true` 会重新问学校。 */
  async currentTerm({ refresh = false } = {}) {
    await this.#ensureReady();
    if (this.state.currentTerm && !refresh) return this.state.currentTerm;
    const term = await this.#guard(() => this.api.currentTerm({ refresh }), '获取当前学期失败');
    parseTerm(term); // 上游给了脏数据就尽早报错
    this.state.currentTerm = term;
    await this.#persistSession();
    return term;
  }

  /**
   * 学期列表：以当前学期为中心，前后各取若干学期，逐个尝试 `cxjcs.do` 取起始日。
   * 取不到的用 `guessTermStart()` 兜底并标记 `source: 'guess'`；`manual` 的永不被覆盖。
   */
  async listTerms({ refresh = false } = {}) {
    await this.#ensureReady();
    if (refresh || !this.state.currentTerm) {
      const term = await this.#guard(() => this.api.currentTerm({ refresh: true }), '获取当前学期失败');
      parseTerm(term);
      this.state.currentTerm = term;
    }
    const candidates = candidateTerms(this.state.currentTerm, this.config.termNeighbors);
    await this.#fetchTermStarts(candidates, { refresh });
    const items = candidates.map((term) => this.#termView(term)).filter(Boolean);
    items.sort((a, b) => b.term.localeCompare(a.term));
    return {
      items,
      count: items.length,
      currentTerm: this.state.currentTerm,
      fetchedAt: this.state.lastTermsAt,
      totalWeeks: this.config.totalWeeks,
      shortTermWeeks: this.config.shortTermWeeks,
    };
  }

  /** 手工指定某学期的第一周周一（来源标 `manual`，此后永不被自动值覆盖）。 */
  async setTermStart(term, startDate) {
    await this.#ensureReady();
    const parts = parseTerm(term);
    const checked = validateTermStart(parts, startDate, this.#weekDefaults());
    if (!checked.ok) throw HttpError.badRequest(`学期起始日不合法：${checked.reason}`, { field: 'startDate', term: parts.term });
    const next = { ...this.terms, [parts.term]: { startDate: checked.startDate, source: 'manual', fetchedAt: new Date().toISOString() } };
    this.terms = next;
    await this.#persistTerms();
    return { term: parts.term, ...this.#termView(parts.term) };
  }

  /** 确保某学期有已知的起始日（供预览/应用使用）。 */
  async ensureTermStart(term, { refresh = false } = {}) {
    const parts = parseTerm(term);
    const existing = this.terms[parts.term];
    const fresh = existing?.fetchedAt ? Date.now() - Date.parse(existing.fetchedAt) < this.config.startDateTtlMs : false;
    // manual 是用户资产：既不再问学校，也不会被覆盖
    if (existing?.source === 'manual') return this.#termView(parts.term);
    if (existing?.startDate && fresh && !refresh) return this.#termView(parts.term);
    await this.#fetchTermStarts([parts.term], { refresh: true });
    return this.#termView(parts.term);
  }

  // ------------------------------------------------------------------ 课表缓存

  /** 拉取某学期的课表并落缓存。 */
  async refreshTimetable(term, { refresh = true } = {}) {
    await this.#ensureReady();
    const parts = parseTerm(term ?? (await this.currentTerm()));
    const rows = await this.#guard(() => this.api.timetableRows(parts.term), `拉取 ${parts.term} 课表失败`);
    const now = new Date().toISOString();
    const trimmed = rows.slice(0, MAX_CACHED_ROWS);
    this.cache = { ...this.cache, [parts.term]: { rows: trimmed, fetchedAt: now, truncated: rows.length > trimmed.length } };
    this.state.lastTimetableAt = now;
    await this.#persistCache();
    return this.view(parts.term, { refresh: false });
  }

  /** 课表缓存视图（不去重，逐行给出）。 */
  view(term, { refresh = false } = {}) {
    const key = term ?? this.state.currentTerm;
    const entry = key ? this.cache[key] : null;
    const rows = entry?.rows ?? [];
    return {
      term: key,
      termLabel: key ? termLabel(key) : null,
      rows: rows.map((row) => rowView(row)),
      count: rows.length,
      fetchedAt: entry?.fetchedAt ?? null,
      cached: Boolean(entry) && !refresh,
      truncated: Boolean(entry?.truncated),
      loggedIn: this.state.status === 'ready',
    };
  }

  /** 去重后的课程列表（「课表」界面上要看的是课，不是行）。 */
  async courses(term, { refresh = false } = {}) {
    await this.#ensureReady();
    const key = term ?? (await this.currentTerm());
    parseTerm(key);
    if (refresh || !this.cache[key]) await this.refreshTimetable(key);

    const grouped = new Map();
    for (const row of this.cache[key]?.rows ?? []) {
      const id = `${row.courseName}|${row.teacher ?? ''}`;
      const group = grouped.get(id) ?? {
        courseName: row.courseName,
        teacher: row.teacher ?? null,
        locations: new Set(),
        slots: new Map(),
        weeks: new Set(),
      };
      if (row.location) group.locations.add(row.location);
      const slotKey = `${row.weekDay}-${row.startPeriod}-${row.endPeriod}`;
      group.slots.set(slotKey, { weekDay: row.weekDay, startPeriod: row.startPeriod, endPeriod: row.endPeriod });
      for (const week of bitmapToWeeks(row.weeksBitmap)) group.weeks.add(week);
      grouped.set(id, group);
    }

    const startInfo = await this.ensureTermStart(key);
    const items = [...grouped.values()].map((group) => {
      const weeks = [...group.weeks].sort((a, b) => a - b);
      return {
        courseName: group.courseName,
        teacher: group.teacher,
        locations: [...group.locations],
        slots: [...group.slots.values()].sort((a, b) => a.weekDay - b.weekDay || a.startPeriod - b.startPeriod),
        weeks,
        weekCount: weeks.length,
        weeksText: describeWeeks(weeks),
      };
    });
    return {
      term: key,
      termLabel: termLabel(key),
      termStart: startInfo?.startDate ?? null,
      startDateSource: startInfo?.source ?? null,
      items,
      count: items.length,
      fetchedAt: this.cache[key]?.fetchedAt ?? null,
      loggedIn: this.state.status === 'ready',
    };
  }

  // ------------------------------------------------------------------ 预览 / 应用

  /** 生成同步预览（只读）。 */
  async preview(options = {}) {
    await this.#ensureReady();
    const resolved = this.#resolveOptions(options);
    const { term, termStart, rows } = await this.#prepare(resolved);
    const plan = buildTimetablePlan({
      rows,
      term,
      termStart,
      today: resolved.today,
      existingSchedules: this.#syncedSchedules(),
      options: { includePast: resolved.includePast, compact: resolved.compact, totalWeeks: resolved.totalWeeks },
    });
    this.lastPlan = plan;
    return {
      term,
      termLabel: termLabel(term),
      termStart,
      startDateSource: this.terms[term]?.source ?? null,
      totalWeeks: resolved.totalWeeks,
      options: { ...resolved, keys: undefined },
      summary: plan.summary,
      items: plan.items,
      skipped: plan.skipped,
    };
  }

  /** 执行同步：只写 create / update，`stale` 仅在 `pruneStale: true` 时删除。 */
  async apply(options = {}) {
    await this.#ensureReady();
    const resolved = this.#resolveOptions(options);
    const plan = await this.#planFor(resolved);
    const wanted = resolved.keys?.length ? new Set(resolved.keys) : null;

    const result = { created: 0, updated: 0, removed: 0, skipped: 0, results: [], errors: [] };
    for (const item of plan.items) {
      if (wanted && !wanted.has(item.key)) continue;
      try {
        if (item.action === 'create') {
          const created = await this.services.schedules.create(item.payload);
          result.created += 1;
          result.results.push({ key: item.key, action: 'create', id: created.id, title: created.title, date: created.date });
        } else if (item.action === 'update') {
          const updated = await this.services.schedules.update(item.existingId, item.payload);
          result.updated += 1;
          result.results.push({ key: item.key, action: 'update', id: updated?.id ?? item.existingId, changes: item.changes });
        } else if (item.action === 'stale' && resolved.pruneStale) {
          await this.services.schedules.remove(item.existingId);
          result.removed += 1;
          result.results.push({ key: item.key, action: 'remove', id: item.existingId });
        } else {
          result.skipped += 1;
        }
      } catch (error) {
        // 单条失败不打断整批
        result.errors.push({ key: item.key, message: error.message ?? String(error) });
      }
    }

    this.state.lastSyncAt = new Date().toISOString();
    this.broadcast({ type: 'data_changed', payload: { target: 'timetable', action: 'sync', term: resolved.term, ...result, lastSyncAt: this.state.lastSyncAt } });
    return { term: resolved.term, summary: plan.summary, lastSyncAt: this.state.lastSyncAt, ...result };
  }

  // ------------------------------------------------------------------ 内部实现

  #weekDefaults() {
    return { normalWeeks: this.config.totalWeeks, shortWeeks: this.config.shortTermWeeks };
  }

  #resolveOptions(options = {}) {
    return {
      term: options.term ? String(options.term) : null,
      includePast: Boolean(options.includePast),
      compact: Boolean(options.compact),
      pruneStale: Boolean(options.pruneStale),
      refresh: Boolean(options.refresh),
      keys: options.keys?.length ? options.keys.map(String) : null,
      today: typeof options.today === 'string' && options.today ? options.today : todayKey(),
      totalWeeks: undefined, // 由 #prepare 按学期定
    };
  }

  /** 解析出这次同步要用的 term / termStart / rows（必要时打学校服务器）。 */
  async #prepare(resolved) {
    const term = resolved.term ?? (await this.currentTerm());
    const parts = parseTerm(term);
    resolved.term = parts.term;
    resolved.totalWeeks = termLength(parts, this.#weekDefaults());
    if (resolved.refresh || !this.cache[parts.term]) {
      await this.refreshTimetable(parts.term, { refresh: resolved.refresh });
    }
    const startInfo = await this.ensureTermStart(parts.term, { refresh: resolved.refresh });
    if (!startInfo?.startDate) {
      throw HttpError.upstream(
        `${parts.term} 的学期起始日未知：教务接口取不到，自动推断也被校验拦下，请先用 POST /tt/terms/${parts.term} 手工指定`,
      );
    }
    return { term: parts.term, termStart: startInfo.startDate, rows: this.cache[parts.term]?.rows ?? [] };
  }

  /**
   * apply 用的计划：优先复用「预览时那份」的条目形状（用户勾选的 key 一定对得上），
   * 否则重新算一遍。两种情况都只影响本次写入，不会留下状态。
   */
  async #planFor(resolved) {
    if (this.lastPlan && this.lastPlan.term === resolved.term && resolved.includePast === false && this.#keysMatchLastPlan(resolved.keys)) {
      return this.#filterLastPlan(resolved);
    }
    const { term, termStart, rows } = await this.#prepare(resolved);
    return buildTimetablePlan({
      rows,
      term,
      termStart,
      today: resolved.today,
      existingSchedules: this.#syncedSchedules(),
      options: { includePast: resolved.includePast, compact: resolved.compact, totalWeeks: resolved.totalWeeks },
    });
  }

  /**
   * keys 是否指向「上一次预览」里的条目。
   *
   * 这一步解决的坑：预览时如果带了 `includePast: true` / `compact: true`，
   * 而应用时前端只回了 keys（没带同样的开关），重算会少掉一些 key → 用户勾的全都不写。
   * 所以只要 keys 能命中上次预览的条目，就直接按上次的计划写。
   */
  #keysMatchLastPlan(keys) {
    if (!keys?.length || !this.lastPlan) return false;
    const known = this.#lastPlanKeyIndex();
    return keys.every((key) => known.has(key));
  }

  #lastPlanKeyIndex() {
    const index = new Map();
    for (const item of this.lastPlan?.items ?? []) {
      index.set(item.key, item);
      for (const week of item.weeks ?? (item.week ? [item.week] : [])) {
        if (item.baseKey) index.set(`${item.baseKey}:${week}`, item);
      }
    }
    return index;
  }

  #filterLastPlan(resolved) {
    const index = this.#lastPlanKeyIndex();
    const wanted = new Set(resolved.keys);
    const items = [];
    const seen = new Set();
    for (const key of wanted) {
      const item = index.get(key);
      if (!item || seen.has(item.key)) continue;
      seen.add(item.key);
      items.push(item);
    }
    if (!resolved.pruneStale) {
      // 用户没要求清理时，stale 条目不该混进来
      return { items: items.filter((item) => item.action !== 'stale'), summary: this.lastPlan.summary, term: resolved.term };
    }
    return { items, summary: this.lastPlan.summary, term: resolved.term };
  }

  #syncedSchedules() {
    return this.store.schedules.all().filter((item) => isTimetableExternalId(item.externalId));
  }

  /** 逐个学期尝试 `cxjcs.do`，失败/为空就猜；manual 的一律跳过。 */
  async #fetchTermStarts(terms, { refresh = false } = {}) {
    const next = { ...this.terms };
    for (const term of terms) {
      const parts = parseTerm(term);
      const existing = next[parts.term];
      if (existing?.source === 'manual') continue;
      if (existing?.startDate && !refresh) continue;

      let candidate = null; // { startDate, source }
      try {
        const remote = await this.api.termStartDate(parts.term);
        if (remote?.startDate) {
          const checked = validateTermStart(parts, remote.startDate, this.#weekDefaults());
          if (checked.ok) candidate = { startDate: checked.startDate, source: 'ehall' };
          else candidate = null;
        }
      } catch (error) {
        // 历史学期取不到起始日是预期内的事（接口会返回空），网络问题也不该让整个列表失败
        if (!(error instanceof EhallError) && !(error instanceof HttpError)) throw error;
      }

      if (!candidate) {
        const guessed = guessTermStart(parts);
        const checked = validateTermStart(parts, guessed, this.#weekDefaults());
        if (checked.ok) candidate = { startDate: checked.startDate, source: 'guess' };
      }

      if (candidate) {
        next[parts.term] = { startDate: candidate.startDate, source: candidate.source, fetchedAt: new Date().toISOString() };
      }
      // 连猜都不合法：不落库，让 #termView 报出「未知」
    }
    this.terms = next;
    this.state.lastTermsAt = new Date().toISOString();
    await this.#persistTerms();
  }

  #termView(term) {
    const parts = parseTerm(term);
    const record = this.terms[parts.term] ?? null;
    const totalWeeks = termLength(parts, this.#weekDefaults());
    if (!record?.startDate) {
      return { term: parts.term, label: termLabel(parts.term), index: parts.index, isShort: parts.isShort, startDate: null, source: null, fetchedAt: null, totalWeeks, validation: '学期起始日未知，请手工指定' };
    }
    const range = termRange(record.startDate, parts, this.#weekDefaults());
    const checked = validateTermStart(parts, record.startDate, this.#weekDefaults());
    return {
      term: parts.term,
      label: termLabel(parts.term),
      index: parts.index,
      isShort: parts.isShort,
      startDate: record.startDate,
      endDate: range.end,
      source: record.source,
      fetchedAt: record.fetchedAt ?? null,
      totalWeeks,
      validation: checked.ok ? null : checked.reason,
    };
  }

  #handleAuthResult(result) {
    switch (result.status) {
      case AUTH_STATUS.READY:
        return this.#finishLogin();
      case AUTH_STATUS.NEED_MFA:
        this.state.status = 'need_mfa';
        this.state.mfa = result.mfa ?? { flow: 'mfa', required: true, phoneMasked: null, sent: false };
        return this.status();
      case AUTH_STATUS.NEED_CAPTCHA:
        this.state.status = 'need_captcha';
        this.state.error = result.message ?? '请输入图形验证码';
        return this.status();
      case AUTH_STATUS.NEED_ACCOUNT_CHOICE:
        this.state.status = 'error';
        this.state.error = '该账号存在多个身份（本科/研究生），请先在浏览器登录一次后再使用';
        return this.status();
      default:
        this.state.status = 'error';
        this.state.error = result.message ?? '登录失败';
        return this.status();
    }
  }

  async #finishLogin() {
    this.state.status = 'ready';
    this.state.mfa = null;
    this.state.error = null;
    this.verified = true;
    try {
      // 当前学期顺便拿一次：既是「登录确实有效」的验证，也让界面立刻有内容。
      // 注意 jwapp 课表接口**不返回用户信息**，所以 user 就是 null（不臆造「张三」这种字段）。
      this.state.currentTerm = await this.api.currentTerm({ refresh: true });
    } catch {
      // 课表接口暂时抽风不代表登录失败：票据已经拿到就算 ready，业务接口下次会再试
      this.state.error = null;
    }
    await this.#persistSession();
    return this.status();
  }

  /** 业务请求前确保有可用登录态；失效时清掉本地票据并提示重新登录。 */
  async #ensureReady() {
    if (this.verified || this.auth.hasLogin) {
      this.verified = this.verified || this.auth.hasLogin;
      if (this.state.status !== 'ready') this.state.status = 'ready';
      return;
    }
    if (this.restored && this.jar.toJSON().length) {
      try {
        this.state.currentTerm = await this.api.currentTerm({ refresh: true });
        this.auth.hasLogin = true;
        this.verified = true;
        this.state.status = 'ready';
        return;
      } catch (error) {
        await this.#clearSession();
        throw HttpError.unauthorized('课表登录态已失效，请重新登录');
      }
    }
    throw HttpError.unauthorized('请先登录教务系统（统一身份认证）');
  }

  async #persistSession() {
    await this.sessionFile.write({
      savedAt: new Date().toISOString(),
      user: this.state.user,
      currentTerm: this.state.currentTerm,
      cookies: this.jar.toJSON(),
    });
  }

  async #persistTerms() {
    await this.termsFile.write({ lastTermsAt: this.state.lastTermsAt, terms: this.terms });
  }

  async #persistCache() {
    await this.cacheFile.write({ lastTimetableAt: this.state.lastTimetableAt, terms: this.cache });
  }

  async #clearSession() {
    this.jar = new CookieJar();
    this.http.jar = this.jar;
    this.auth.reset();
    this.verified = false;
    this.state.status = 'anonymous';
    this.state.user = null;
    this.state.mfa = null;
    this.state.error = null;
    this.state.currentTerm = null;
    await this.sessionFile.remove();
  }

  /** 上游异常统一翻译；本模块自己的结构化错误保留原样。 */
  #translate(error, prefix) {
    if (error instanceof HttpError) return error;
    if (error instanceof WeekParseError || error instanceof TermFormatError) return HttpError.badRequest(error.message);
    if (error instanceof EhallError) return HttpError.upstream(`${prefix}：${error.message}`);
    const message = error?.message ?? String(error);
    if (/登录态已失效|请先登录/.test(message)) return HttpError.unauthorized(message);
    if (/验证码不正确|验证码不能为空|请先发送验证码/.test(message)) return HttpError.badRequest(message);
    return HttpError.upstream(`${prefix}：${message}`);
  }

  #guard(promiseFactory, prefix) {
    return promiseFactory().catch((error) => {
      throw this.#translate(error, prefix);
    });
  }
}

/** 课表行的对外视图（字段名保持学校原始拼音缩写，便于对照抓包）。 */
function rowView(row) {
  return {
    courseName: row.courseName,
    teacher: row.teacher ?? null,
    location: row.location ?? null,
    weekDay: row.weekDay,
    startPeriod: row.startPeriod,
    endPeriod: row.endPeriod,
    weeksBitmap: row.weeksBitmap ?? null,
    term: row.term ?? null,
  };
}

// 默认总周数对外暴露一下（文档与 tools.js 会引用这个数字）
export { DEFAULT_TERM_WEEKS };
