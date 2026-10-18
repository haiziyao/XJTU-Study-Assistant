/**
 * 课表导入服务：登录态 → 学期 → 拉课表 → 合并 → 预览 → 写入 / 删除日程。
 *
 * 与 `academic` 模块保持同一套约定（用户与 AI 只需要学一套）：
 *
 * 1. **不自己写登录**。账号密码、CAS、MFA 都在 `auth` 模块（order=5）；
 *    本模块只 `registerSite({id:'timetable', …})`，业务请求前 `auth.ensure('timetable')`。
 *    jar / http 都直接用共享的那一份 —— 这就是「在设置里登录一次，课表也能用」的原因。
 *
 * 2. **未登录就是未登录**。`wdkb` 未登录会 302 到 CAS 登录页；这里必须抛
 *    401 `NOT_LOGGED_IN`，**不能**当成「这学期没有课」返回空列表。
 *
 * 3. **幂等**。每条日程的 `externalId` 由学校给的事实确定性算出
 *    （见 to-calendar.js 的说明），重复导入只更新、不新增；日程条数不变。
 *
 * 4. **只动自己写的东西**。删除只处理 `source === 'import'` **且**
 *    `externalId` 以 `timetable:` 开头的记录；用户手建 / 手改的日程一条都不碰。
 *
 * 5. **本地可看的不用登录**。`status` / `imported` / `remove` 只读本地库，
 *    不调上游 —— 用户就算登录过期了，也应该能删掉之前导入的课表。
 */

import { EhallApi, TIMETABLE_ERROR, TimetableError } from './api.js';
import { candidateTerms, resolveTimetableConfig, termLabel } from './config.js';
import { groupCourses, mergeRows } from './merge.js';
import { MAX_WEEKS, TermFormatError, guessTermStart, parseTerm, termLength, validateTermStart } from './term.js';
import {
  buildEventsForCourse,
  decorateCourse,
  groupImportedSchedules,
  isTimetableExternalId,
  parseExternalId,
} from './to-calendar.js';

export class TimetableService {
  /**
   * @param {object} options
   * @param {object} options.auth **共享认证服务**（`services.auth`，order=5）。
   * @param {object} options.store JsonStore
   * @param {object} options.services 全局服务表（写日程必须走 `services.schedules`）
   */
  constructor({ store, services, broadcast = () => {}, config = {}, dataDir, auth } = {}) {
    if (!auth) {
      throw new Error('timetable 模块需要 auth 模块（order=5）：请确认它先装配，见 src/modules/auth/module.js');
    }
    this.store = store;
    this.services = services ?? {};
    this.broadcast = broadcast;
    this.dataDir = dataDir ?? '.';
    this.config = resolveTimetableConfig(config ?? {});

    /** 共享认证：jar/http 都从它来（CAS 票据进的是同一个罐子）。 */
    this.auth = auth;
    this.jar = auth.jar;
    this.http = auth.http;
    this.api = new EhallApi({ http: this.http, config: this.config });

    this.state = {
      /** 最近一次成功拿到的当前学期（避免 status 每次都打学校服务器）。 */
      currentTerm: null,
    };
    /** 学期起始日缓存：`term -> {startDate, source, fetchedAt}`。 */
    this.termStarts = new Map();
    /** 课表行缓存：`term -> {rows, fetchedAt}`，让「预览 → 导入」只拉一次。 */
    this.rowsCache = new Map();
    this.restored = false;

    /**
     * 订阅全局认证：登出 / 本站点掉线时清掉学期与课表缓存。
     *
     * 为什么要清：换了账号还拿着上一个账号的学期号去请求，轻则多一次无效往返，
     * 重则把「当前学期」显示成别人的。票据本身归 auth 管，这里只清自己的派生缓存。
     */
    this.auth.onChange?.((event) => {
      if (event.type === 'logout' || (event.type === 'site-lost' && event.siteId === 'timetable')) {
        this.api.reset();
        this.state.currentTerm = null;
        this.rowsCache.clear();
      }
    });
  }

  /** 进程启动时调用。**不发网络请求**：登录态由 auth 负责恢复，页面打开时再按需拉。 */
  async restore() {
    this.restored = true;
    return { loggedIn: Boolean(this.auth.siteStatus('timetable')?.ready) };
  }

  // ================================================================ 状态

  /**
   * `GET /timetable/status`
   *
   * 已登录时顺手拿一次当前学期（`dqxnxq.do`）—— 学期下拉就是以它为中心前后各 3 个。
   * 拿不到（上游抽风）时如实返回 `error`，但不把「已登录」说成「未登录」。
   */
  async status({ probe = false } = {}) {
    let site = this.auth.siteStatus('timetable');
    let reason = site.reason ?? null;
    // `probe`：页面上的「刷新状态」会带它来。此时**主动重试一次站点认证** ——
    // 共享罐里可能还有 CAS 票据，`ensure()` 能静默把站点救回来；
    // 默认（首页加载）不这么做，否则未登录用户每打开一次页面都要白等一次登录页跳转。
    if (!site.ready && probe) {
      const outcome = await this.auth.ensure('timetable');
      site = this.auth.siteStatus('timetable');
      if (!outcome.ok) reason = outcome.reason ?? reason;
    }
    let loggedIn = Boolean(site.ready);
    let currentTerm = this.state.currentTerm;
    let error = null;

    if (loggedIn && !currentTerm) {
      try {
        await this.#ensureReady();
        currentTerm = await this.#guard(() => this.api.currentTerm());
        parseTerm(currentTerm);
        this.state.currentTerm = currentTerm;
      } catch (failure) {
        const translated = this.#translate(failure);
        if (translated.code === TIMETABLE_ERROR.NOT_LOGGED_IN) {
          this.#onAuthFailure(translated.message);
          loggedIn = false;
          reason = translated.message;
        } else {
          error = translated.message;
        }
      }
    } else if (!loggedIn) {
      reason = reason ?? '尚未登录统一身份认证';
    }

    const terms = currentTerm
      ? candidateTerms(currentTerm, this.config.termNeighbors)
          .reverse()
          .map((value) => ({ value, label: termLabel(value), current: value === currentTerm }))
      : [];
    const groups = groupImportedSchedules(this.#importedSchedules());

    return {
      loggedIn,
      reason: reason ?? null,
      error,
      currentTerm,
      terms,
      imported: {
        count: groups.total,
        courses: groups.courses.map((course) => ({
          id: course.id,
          name: course.name,
          term: course.term,
          count: course.count,
        })),
      },
    };
  }

  // ================================================================ 预览

  /**
   * `GET /timetable/preview?term=`
   *
   * 只读：不写库，也不改任何状态（除了内存缓存）。
   * 返回里 `startSource` 如实标注学期起始日来自 `cxjcs.do`（`ehall`）还是本地推断（`guess`）。
   */
  async preview(term, { refresh = false } = {}) {
    const context = await this.#termContext(term, { refresh });
    const { slots, skipped } = mergeRows(context.rows);
    const courses = groupCourses(slots).map((course) =>
      decorateCourse(course, { term: context.term, termStart: context.termStart }),
    );
    const actualMax = courses.reduce((max, course) => Math.max(max, course.weeks.max ?? 0), 0);
    // 「导入到第几周」的默认值：学期总周数与课表实际最大周次取大者
    // （课表只到 16 周时仍可填 18，导入结果一样；但小学期的 8 周必须能正确显示）。
    const maxWeek = Math.min(MAX_WEEKS, Math.max(context.totalWeeks, actualMax));

    return {
      term: context.term,
      termLabel: termLabel(context.term),
      termStart: context.termStart,
      startSource: context.startSource,
      totalWeeks: context.totalWeeks,
      maxWeek,
      count: courses.length,
      courses,
      skipped,
    };
  }

  // ================================================================ 导入

  /**
   * `POST /timetable/import` body `{term, courseIds:[...], untilWeek?}`
   *
   * - `courseIds` 省略 = 全部课程；显式空数组 = 一门都不导入（不报错）；
   * - `untilWeek` 把周次截断到 ≤ N：截断后没有周次的课程不会写，进 `skipped` 并带原因；
   * - 返回 `{created, updated, skipped, skippedCount, events, removed}`。
   *   `events = created + updated`（这次实际写入/刷新的日程数）；
   *   `removed` 是「这次选中范围内、上游已经不存在的旧日程」被清掉的条数。
   */
  async importCourses({ term, courseIds, untilWeek } = {}) {
    const context = await this.#termContext(term, {});
    const limit = normalizeUntilWeek(untilWeek);
    const { slots, skipped: mergeSkipped } = mergeRows(context.rows);
    const courses = groupCourses(slots);

    const explicit = Array.isArray(courseIds);
    const wanted = explicit ? new Set(courseIds.map(String)) : null;
    const selected = explicit ? courses.filter((course) => wanted.has(course.id)) : courses;

    const skipped = mergeSkipped.map((item) => ({ ...item }));
    const events = [];
    const seen = new Set();
    for (const course of selected) {
      const built = buildEventsForCourse(course, {
        term: context.term,
        termStart: context.termStart,
        untilWeek: limit ?? undefined,
      });
      if (!built.events.length && !built.skipped.length) {
        skipped.push({
          courseId: course.id,
          courseName: course.name,
          reason: `导入到第 ${limit} 周后没有可写入的周次`,
        });
      }
      skipped.push(...built.skipped);
      for (const event of built.events) {
        if (seen.has(event.externalId)) continue;
        seen.add(event.externalId);
        events.push(event);
      }
    }

    const schedules = this.#requireScheduleService();
    const existing = this.#importedSchedules();
    const byExternalId = new Map(existing.map((item) => [item.externalId, item]));

    let created = 0;
    let updated = 0;
    for (const event of events) {
      const current = byExternalId.get(event.externalId);
      if (current) {
        // 即使内容完全一样也走 update：导入是「用学校最新数据刷新」的语义，
        // 第二次导入因此表现为 created:0 / updated>0，而日程条数不变（幂等）。
        await schedules.update(current.id, event.payload);
        updated += 1;
      } else {
        await schedules.create(event.payload);
        created += 1;
      }
    }

    // 清掉「选中范围内、上游已不存在」的旧日程（例如换了周次、或重新导入时调小了 untilWeek）。
    // 只认 timetable: 前缀 + source=import；手建日程永远不在候选里。
    let removed = 0;
    const selectedIds = new Set(selected.map((course) => course.id));
    for (const item of existing) {
      if (seen.has(item.externalId)) continue;
      const parsed = parseExternalId(item.externalId);
      if (!parsed || parsed.term !== context.term) continue;
      // 显式选了课就只在选中的课里清理；省略 courseIds（导入全部）则清理整个学期。
      if (explicit && !selectedIds.has(parsed.courseId)) continue;
      await schedules.remove(item.id);
      removed += 1;
    }

    if (created || updated || removed) {
      this.broadcast({
        type: 'data_changed',
        module: 'timetable',
        payload: { target: 'schedule', action: 'import', term: context.term },
      });
    }

    return {
      term: context.term,
      created,
      updated,
      skipped,
      skippedCount: skipped.length,
      events: created + updated,
      removed,
    };
  }

  // ================================================================ 删除

  /**
   * `POST /timetable/remove` body `{term?, courseIds?, all?}`
   *
   * 本地操作，**不要求登录**（登录过期也应能清理旧数据）。
   * 只删 `source === 'import'` 且 `externalId` 以 `timetable:` 开头的日程。
   */
  async remove({ term, courseIds, all = false } = {}) {
    const parsedTerm = term ? parseTerm(term).term : null;
    if (!all && (!Array.isArray(courseIds) || courseIds.length === 0)) {
      throw new TimetableError('字段 courseIds 不能为空（要删除全部请传 all:true）', {
        code: TIMETABLE_ERROR.BAD_REQUEST,
        status: 400,
      });
    }
    const wanted = all ? null : new Set(courseIds.map(String));
    const schedules = this.#requireScheduleService();
    let removed = 0;

    for (const item of this.#importedSchedules()) {
      const parsed = parseExternalId(item.externalId);
      if (!parsed) continue;
      if (parsedTerm && parsed.term !== parsedTerm) continue;
      if (wanted && !wanted.has(parsed.courseId)) continue;
      await schedules.remove(item.id);
      removed += 1;
    }

    if (removed) {
      this.broadcast({
        type: 'data_changed',
        module: 'timetable',
        payload: { target: 'schedule', action: 'remove', term: parsedTerm },
      });
    }
    return { removed, term: parsedTerm };
  }

  // ================================================================ 已导入

  /** `GET /timetable/imported?term=` —— 只读本地，按课程分组。 */
  async imported(term) {
    const parsedTerm = term ? parseTerm(term).term : null;
    const groups = groupImportedSchedules(this.#importedSchedules(), { term: parsedTerm ?? undefined });
    return {
      term: parsedTerm,
      count: groups.courses.length,
      total: groups.total,
      courses: groups.courses,
    };
  }

  // ================================================================ 内部

  #weekDefaults() {
    return { normalWeeks: this.config.totalWeeks, shortWeeks: this.config.shortTermWeeks };
  }

  #requireScheduleService() {
    const schedules = this.services?.schedules;
    if (!schedules) {
      throw new Error('timetable 需要 calendar 模块（order=10）先装配：写日程必须走 services.schedules');
    }
    return schedules;
  }

  /** 本地库里归本模块管的日程。 */
  #importedSchedules() {
    const schedules = this.store?.schedules;
    if (!schedules) return [];
    return schedules
      .all()
      .filter((item) => item.source === 'import' && isTimetableExternalId(item.externalId));
  }

  /** 业务请求前确认登录态；失败抛 401 并把共享认证里本站点打回「待验证」。 */
  async #ensureReady() {
    const site = this.auth.siteStatus('timetable');
    if (site.ready) return;
    const outcome = await this.auth.ensure('timetable');
    if (outcome.ok) return;
    const reason = outcome.reason ?? '需要登录统一身份认证';
    this.#onAuthFailure(reason);
    throw new TimetableError(`尚未登录统一身份认证：${reason}`, {
      code: TIMETABLE_ERROR.NOT_LOGGED_IN,
      status: 401,
      details: { reason },
    });
  }

  /**
   * 打回未登录：**不动共享票据**（那是全程序共用的，清掉会连带把学堂踢下线），
   * 只让 auth 下次重新验证本站点（SSO 有机会静默救回）。
   */
  #onAuthFailure(reason = null) {
    this.api.reset();
    this.state.currentTerm = null;
    this.rowsCache.clear();
    this.auth.invalidate('timetable', reason);
  }

  /** 当前学期（带内存缓存）。 */
  async #currentTerm({ refresh = false } = {}) {
    await this.#ensureReady();
    if (this.state.currentTerm && !refresh) return this.state.currentTerm;
    const term = await this.#guard(() => this.api.currentTerm({ refresh }));
    // 上游返回形如 "2026-2027-1" 的学期编号；脏数据要尽早变成 400，不能带着它去算日期。
    try {
      parseTerm(term);
    } catch (error) {
      throw this.#translate(error);
    }
    this.state.currentTerm = term;
    return term;
  }

  /** term / rows / termStart 三件套（预览与导入共用，保证两次看到的是同一份数据）。 */
  async #termContext(term, { refresh = false } = {}) {
    await this.#ensureReady();
    const parts = parseTerm(term ?? (await this.#currentTerm({ refresh })));
    this.state.currentTerm = parts.term;
    const rows = await this.#guard(() => this.#rows(parts.term, { refresh }));
    const start = await this.#guard(() => this.#termStart(parts.term, { refresh }));
    return {
      term: parts.term,
      rows,
      termStart: start.startDate,
      startSource: start.source,
      totalWeeks: termLength(parts, this.#weekDefaults()),
    };
  }

  /** 课表行：短缓存（默认 60 秒）。「刷新课表」传 refresh:true 绕过。 */
  async #rows(term, { refresh = false } = {}) {
    const cached = this.rowsCache.get(term);
    if (!refresh && cached && Date.now() - cached.fetchedAt < this.config.rowsCacheTtlMs) return cached.rows;
    const rows = await this.api.timetableRows(term);
    this.rowsCache.set(term, { rows, fetchedAt: Date.now() });
    return rows;
  }

  /**
   * 学期起始日：先问 `cxjcs.do`，拿不到（历史学期通常为空）或校验不过就本地推断。
   *
   * 为什么必须校验：起始日是所有「第 N 周 → 日期」换算的地基，
   * 上游给一个非周一的日期或明显越界的年份，会把整学期日程排到错误的日子上。
   */
  async #termStart(term, { refresh = false } = {}) {
    const cached = this.termStarts.get(term);
    if (!refresh && cached) return cached;
    const remote = await this.api.termStartDate(term);
    let startDate = remote?.startDate ?? null;
    let source = 'ehall';
    let checked = startDate ? validateTermStart(term, startDate, this.#weekDefaults()) : { ok: false };
    if (!checked.ok) {
      startDate = guessTermStart(term);
      source = 'guess';
      checked = validateTermStart(term, startDate, this.#weekDefaults());
      if (!checked.ok) {
        throw new TimetableError(`无法确定 ${term} 的学期起始日：${checked.reason}`, {
          details: { path: this.config.paths.termStart, term },
        });
      }
    }
    const record = { startDate, source, fetchedAt: Date.now() };
    this.termStarts.set(term, record);
    return record;
  }

  /** 统一翻译成本模块的结构化错误（路由再翻成 HTTP）。 */
  #translate(error) {
    if (error instanceof TimetableError) return error;
    if (error instanceof TermFormatError) {
      return new TimetableError(error.message, { code: TIMETABLE_ERROR.BAD_REQUEST, status: 400 });
    }
    const message = error?.message ?? String(error);
    if (/登录态已失效|尚未登录|请先登录|未登录/.test(message)) {
      return new TimetableError(message, { code: TIMETABLE_ERROR.NOT_LOGGED_IN, status: 401 });
    }
    return new TimetableError(`${message}`, { code: TIMETABLE_ERROR.EHALL_ERROR, details: { cause: error?.name ?? 'Error' } });
  }

  async #guard(factory) {
    try {
      return await factory();
    } catch (error) {
      const translated = this.#translate(error);
      // 票据在 auth 眼里还是「就绪」、但上游已经 302 回登录页：这里顺手把它打回待验证，
      // 否则之后每次业务请求都要先失败一次（status 也会一直显示"已登录"）。
      if (translated.code === TIMETABLE_ERROR.NOT_LOGGED_IN) this.#onAuthFailure(translated.message);
      throw translated;
    }
  }
}

/** `untilWeek` 归一化：空 = 不截断；否则必须是 1~MAX_WEEKS 的整数。 */
function normalizeUntilWeek(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_WEEKS) {
    throw new TimetableError(`字段 untilWeek 必须是 1~${MAX_WEEKS} 之间的整数`, {
      code: TIMETABLE_ERROR.BAD_REQUEST,
      status: 400,
    });
  }
  return number;
}
