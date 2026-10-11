/**
 * 思源学堂服务：把「登录 → 拉课程 → 拉活动 → 同步到日历」串起来。
 *
 * 设计要点：
 * - **登录与会话票据交给全局认证模块**（`services.auth`，order=5）：
 *   学堂与教务用的是同一个学校账号，共享 Cookie 罐才能单点登录。
 *   本模块不再自建 jar/http/CasAuth，也不再写 lms-session.json；
 * - 课程/活动落本地缓存（JsonStore），离线也能看，重新同步不会重复建日程；
 * - 同步是「先预览后应用」：预览只读、纯计算，应用才写数据；
 * - 所有面向 HTTP 的失败都翻译成带状态码的 HttpError，路由层不再判断。
 */

import path from 'node:path';

import { HttpError } from '../../core/http/router.js';
import { todayKey } from '../../shared/time.js';
import { AUTH_STATUS } from './cas-auth.js';
import { DEFAULT_SYNC_TYPES, activityTypesOf, resolveLmsConfig } from './config.js';
import { JsonFile } from './secret-store.js';
import { LmsApi } from './api.js';
import { applySyncPlan, buildSyncPlan } from './sync.js';
import { parseLmsDate } from './time.js';

/** 活动缓存的新鲜度：预览时若超过这个时间就顺手刷新一次。 */
const ACTIVITY_TTL_MS = 10 * 60 * 1000;
/** 单次预览最多补拉多少条作业详情（详情接口一个活动一次请求）。 */
const MAX_DETAIL_FETCH = 40;

const courseRecordId = (courseId) => `lms:course:${courseId}`;
const activityRecordId = (activityId) => `lms:activity:${activityId}`;

export class LmsService {
  /**
   * @param {object} options
   * @param {object} options.auth **共享的全局认证服务**（`services.auth`，order=5）。
   *   必需：思源学堂与教务用的是同一个学校账号，登录已经收敛到 `auth` 模块。
   *   缺它会在装配期就报错（见 module.js），而不是运行到一半才发现。
   */
  constructor({ store, services, broadcast = () => {}, config = resolveLmsConfig(), dataDir, auth } = {}) {
    if (!auth) {
      // 装配期就炸，而不是等到用户点登录才报错。
      // 这条分支只在"单独加载 lms 而没加载 auth"时触发（比如 onlyModules），
      // 正常装配下 auth 的 order=5 一定先于本模块。
      throw new Error('lms 模块需要 auth 模块（order=5）：请确保它被一起装配（见 src/modules/auth/module.js）');
    }
    this.store = store;
    this.broadcast = broadcast;
    this.config = resolveLmsConfig(config ?? {});
    this.dataDir = dataDir ?? store?.dataDir ?? '.';
    this.services = services ?? {};
    /**
     * 共享认证。**HTTP 客户端与 Cookie 罐都从它来** ——
     * 这正是单点登录成立的原因：罐子里有 CAS 的 TGC，学堂与教务才能互相免密。
     * 本模块不再自建 jar/http/CasAuth，也不再自己读写会话文件。
     */
    this.sharedAuth = auth;
    this.jar = auth.jar;
    this.http = auth.http;
    this.api = new LmsApi({ http: this.http, config: this.config });
    /** 同步元信息是普通业务数据 → 0644。会话票据由 auth 模块管，不再有 lms-session.json。 */
    this.metaFile = new JsonFile(path.join(this.dataDir, 'lms-meta.json'), { mode: 0o644 });
    this.verified = false;
    this.restored = false;
    this.state = {
      status: 'anonymous',
      user: null,
      mfa: null,
      error: null,
      lastCoursesAt: null,
      lastActivitiesAt: null,
      lastSyncAt: null,
      autoSync: false,
      autoSyncIntervalHours: 6,
      lastAutoSyncAt: null,
    };
    this.autoSyncTimer = undefined;
  }

  // ---------------------------------------------------------------- 对外状态

  status() {
    const courses = this.store.lmsCourses.all();
    const activities = this.store.lmsActivities.all();
    const schedules = this.store.schedules.all().filter((item) => String(item.externalId ?? '').startsWith('lms:'));
    const events = this.store.events.all().filter((item) => String(item.externalId ?? '').startsWith('lms:'));
    // 作业现在落在待办集合里，统计「已同步」时必须一起数，否则页面上数字会少
    const todos = this.store.todos.all().filter((item) => String(item.externalId ?? '').startsWith('lms:'));
    return {
      status: this.state.status,
      user: this.state.user,
      mfa: this.state.mfa,
      captchaRequired: Boolean(this.sharedAuth?.status?.().captchaRequired),
      error: this.state.error,
      baseUrl: this.config.baseUrl,
      cache: {
        courses: courses.length,
        activities: activities.length,
        lastCoursesAt: this.state.lastCoursesAt,
        lastActivitiesAt: this.state.lastActivitiesAt,
      },
      synced: { schedules: schedules.length, events: events.length, todos: todos.length },
      lastSyncAt: this.state.lastSyncAt,
      autoSync: {
        enabled: this.state.autoSync,
        intervalHours: this.state.autoSyncIntervalHours,
        lastRunAt: this.state.lastAutoSyncAt,
      },
    };
  }

  // ---------------------------------------------------------------- 登录相关

  /**
   * 进程启动时调用：恢复上次状态。
   *
   * **不再读会话文件** —— 票据由 `auth` 模块统一持有（它比本模块先 restore，
   * 所以这里拿到的已经是恢复好的共享罐）。本模块只负责自己的元信息与登录态投影。
   */
  async restore() {
    if (this.restored) return this.status();
    this.restored = true;
    const meta = (await this.metaFile.read()) ?? {};
    this.state.lastCoursesAt = meta.lastCoursesAt ?? null;
    this.state.lastActivitiesAt = meta.lastActivitiesAt ?? null;
    this.state.lastSyncAt = meta.lastSyncAt ?? null;
    this.state.autoSync = Boolean(meta.autoSync);
    this.state.autoSyncIntervalHours = Number(meta.autoSyncIntervalHours) > 0 ? Number(meta.autoSyncIntervalHours) : 6;
    this.state.lastAutoSyncAt = meta.lastAutoSyncAt ?? null;
    // 用户名等展示信息跟着本模块的元信息走（0644 业务数据）。
    // 它**不再**随会话票据走 —— 票据归 auth 管，且票据文件里刻意不放 PII。
    // 存下来是为了重启后界面能立刻显示"谁登录着"，而不必先发一次网络请求。
    this.state.user = meta.user ?? null;

    const site = this.sharedAuth?.siteStatus?.('lms');
    if (site?.ready) {
      // 先乐观地认为已登录，真正的失效会在第一次业务请求时被发现（并走 invalidate 重验）
      this.state.status = 'ready';
      this.verified = true;
    }
    return this.status();
  }

  async login({ username, password, captcha, trustAgent = true } = {}) {
    this.state.error = null;
    try {
      const result = await this.sharedAuth.login({ username, password, captcha, trustAgent, siteId: 'lms' });
      return this.#handleAuthResult(result);
    } catch (error) {
      throw this.#translate(error, '登录思源学堂失败');
    }
  }

  async sendMfaCode() {
    try {
      const result = await this.sharedAuth.sendMfaCode();
      this.state.status = 'need_mfa';
      // 保留原有的 flow（可能是 'sec' 二次认证），只更新"已发送"相关的字段
      this.state.mfa = { ...(this.state.mfa ?? {}), phoneMasked: result.phoneMasked, sent: true };
      return { phone: result.phone, phoneMasked: result.phoneMasked, status: this.status() };
    } catch (error) {
      throw this.#translate(error, '发送验证码失败');
    }
  }

  async verifyMfaCode(code) {
    try {
      const result = await this.sharedAuth.verifyMfaCode(code);
      return this.#handleAuthResult(result);
    } catch (error) {
      throw this.#translate(error, '验证码校验失败');
    }
  }

  async captcha() {
    try {
      return await this.sharedAuth.captcha();
    } catch (error) {
      throw this.#translate(error, '获取验证码失败');
    }
  }

  /**
   * 退出登录。
   *
   * ⚠️ 在单点登录下**"只退出学堂"没有意义**：CAS 的 TGC 还在共享罐里，
   * 下次访问会被静默重新认证 —— 看起来就像"退不掉"。
   * 所以这里执行的是**全局退出**（与设置页那个退出按钮同一个动作），
   * 保证"点了退出就真的退出"这一直觉成立。
   */
  async logout() {
    await this.sharedAuth.logout();
    await this.#resetLocalState();
    return this.status();
  }

  /** 清掉本模块的登录态投影与缓存标记（不动共享票据，那是 auth 的事）。 */
  async #resetLocalState() {
    this.verified = false;
    this.state.status = 'anonymous';
    this.state.user = null;
    this.state.mfa = null;
    this.state.error = null;
  }

  // ---------------------------------------------------------------- 课程 / 活动

  listCourses() {
    const items = this.store.lmsCourses
      .all()
      .map((record) => courseView(record))
      .sort((a, b) => {
        const semester = String(b.semester?.name ?? '').localeCompare(String(a.semester?.name ?? ''));
        if (semester !== 0) return semester;
        return String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh-Hans-CN');
      });
    return { items, count: items.length, fetchedAt: this.state.lastCoursesAt, loggedIn: this.state.status === 'ready' };
  }

  async refreshCourses() {
    await this.#ensureReady();
    const courses = await this.#guard(() => this.api.myCourses(), '拉取课程列表失败');
    const now = new Date().toISOString();
    const keep = new Set();
    for (const course of courses) {
      keep.add(courseRecordId(course.id));
      await this.store.lmsCourses.insert({
        // 注意：id 必须放在展开之后，否则会被 course.id（学校返回的数字 ID）覆盖
        ...course,
        id: courseRecordId(course.id),
        courseId: course.id,
        fetchedAt: now,
      });
    }
    // 学校里已经退掉的课，本地也不再保留（相关的活动缓存一并清掉）
    for (const record of this.store.lmsCourses.all()) {
      if (!keep.has(record.id)) {
        await this.store.lmsCourses.remove(record.id);
        await this.#removeActivitiesOfCourse(record.courseId);
      }
    }
    this.state.lastCoursesAt = now;
    await this.#persistMeta();
    return { ...this.listCourses(), fetchedAt: now };
  }

  listActivities({ courseIds, type } = {}) {
    // type 支持分组名（online = 直播 + 回放 + 在线视频），先归一成类型数组再匹配，见 config.js 的 activityTypesOf
    const types = activityTypesOf(type);
    let items = this.store.lmsActivities
      .all()
      .map((record) => activityView(record))
      .filter((item) => (courseIds?.length ? courseIds.map(Number).includes(Number(item.courseId)) : true))
      .filter((item) => (types ? types.includes(item.type) : true));
    items.sort((a, b) => String(a.endTime ?? a.startTime ?? '').localeCompare(String(b.endTime ?? b.startTime ?? '')));
    return { items, count: items.length, fetchedAt: this.state.lastActivitiesAt, loggedIn: this.state.status === 'ready' };
  }

  /** 拉取指定课程（默认全部）的活动列表并落缓存。 */
  async refreshActivities({ courseIds, force = false } = {}) {
    await this.#ensureReady();
    const all = this.store.lmsCourses.all();
    if (!all.length) await this.refreshCourses();
    const courses = this.store.lmsCourses
      .all()
      .filter((course) => (courseIds?.length ? courseIds.map(Number).includes(Number(course.courseId)) : true));
    if (!courses.length) return { items: [], count: 0, fetchedAt: this.state.lastActivitiesAt, errors: [] };

    const { activities, errors } = await this.#guard(
      () => this.api.activitiesForCourses(courses.map((course) => course.courseId)),
      '拉取课程活动失败',
    );
    const now = new Date().toISOString();
    for (const [courseId, list] of activities) {
      const course = courses.find((item) => Number(item.courseId) === Number(courseId));
      await this.#saveActivities(courseId, list, course?.name ?? null, now, { force });
    }
    this.state.lastActivitiesAt = now;
    await this.#persistMeta();
    return { ...this.listActivities({ courseIds }), errors };
  }

  async activityDetail(activityId) {
    await this.#ensureReady();
    const detail = await this.#guard(() => this.api.activityDetail(activityId), '拉取活动详情失败');
    if (!detail) throw HttpError.notFound(`思源学堂查不到活动 ${activityId}`);
    const record = this.store.lmsActivities.get(activityRecordId(activityId));
    await this.store.lmsActivities.insert({
      ...(record ?? {}),
      ...detail,
      id: activityRecordId(activityId),
      courseId: detail.courseId ?? record?.courseId ?? null,
      courseName: record?.courseName ?? null,
      fetchedAt: record?.fetchedAt ?? null,
      detailFetchedAt: new Date().toISOString(),
    });
    return { item: activityView(this.store.lmsActivities.get(activityRecordId(activityId))) };
  }

  // ---------------------------------------------------------------- 同步

  /**
   * 生成同步预览。
   * @param {object} options 见 sync.js buildSyncPlan
   */
  async preview(options = {}) {
    await this.#ensureReady();
    const resolved = this.#resolveSyncOptions(options);
    const data = await this.#collect(resolved);
    const plan = buildSyncPlan({
      courses: data.courses,
      activities: data.activities,
      existingSchedules: this.store.schedules.all(),
      existingTodos: this.store.todos.all(),
      existingEvents: this.store.events.all(),
      options: resolved,
    });
    this.lastPlan = plan;
    return {
      options: resolved,
      summary: plan.summary,
      items: plan.items,
      courses: data.courses.map((course) => ({ id: course.id, name: course.name, activityCount: data.countByCourse.get(course.id) ?? 0 })),
    };
  }

  /** 应用同步（先按同样的规则重新算一遍计划，再按 keys 落库）。 */
  async apply(options = {}) {
    await this.#ensureReady();
    const resolved = this.#resolveSyncOptions(options);
    const data = await this.#collect(resolved);
    const plan = buildSyncPlan({
      courses: data.courses,
      activities: data.activities,
      existingSchedules: this.store.schedules.all(),
      existingTodos: this.store.todos.all(),
      existingEvents: this.store.events.all(),
      options: resolved,
    });
    const result = await applySyncPlan({
      services: this.services,
      plan,
      keys: resolved.keys,
      pruneStale: resolved.pruneStale,
    });
    this.state.lastSyncAt = new Date().toISOString();
    await this.#persistMeta();
    this.broadcast({ type: 'data_changed', payload: { target: 'lms', action: 'sync', ...result, lastSyncAt: this.state.lastSyncAt } });
    return { ...result, summary: plan.summary, lastSyncAt: this.state.lastSyncAt };
  }

  // ---------------------------------------------------------------- 设置 / 自动同步

  /** 修改同步设置（目前只有自动同步开关与间隔）。 */
  async updateSettings({ autoSync, autoSyncIntervalHours } = {}) {
    if (autoSync !== undefined) this.state.autoSync = Boolean(autoSync);
    if (autoSyncIntervalHours !== undefined) {
      const hours = Number(autoSyncIntervalHours);
      if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 7) {
        throw HttpError.badRequest('autoSyncIntervalHours 必须是 1~168 之间的小时数');
      }
      this.state.autoSyncIntervalHours = hours;
    }
    await this.#persistMeta();
    if (this.state.autoSync) this.startAutoSync();
    else this.stopAutoSync();
    return this.status();
  }

  /**
   * 跑一次自动同步：只做「新建 / 更新」，不会删除任何东西（失效记录只在手动预览里提示）。
   * 未登录、未开启、距上次同步未到间隔时直接跳过。
   */
  async runAutoSyncOnce({ force = false } = {}) {
    if (!this.state.autoSync && !force) return { ran: false, reason: '未开启自动同步' };
    const last = this.state.lastAutoSyncAt ? Date.parse(this.state.lastAutoSyncAt) : 0;
    const intervalMs = this.state.autoSyncIntervalHours * 3600_000;
    if (!force && last && Date.now() - last < intervalMs) {
      return { ran: false, reason: '距上次自动同步未到间隔' };
    }
    try {
      const result = await this.apply({ refresh: true });
      this.state.lastAutoSyncAt = new Date().toISOString();
      await this.#persistMeta();
      // 注意：apply 的结果里也有 skipped（条数），所以「是否真的跑了」用 ran 表达
      return { ran: true, ...result };
    } catch (error) {
      return { ran: false, reason: error.message ?? String(error) };
    }
  }

  /** 启动后台定时器；默认每 30 分钟检查一次是否到点。 */
  startAutoSync({ intervalMs = 30 * 60 * 1000 } = {}) {
    if (this.autoSyncTimer) return this;
    this.autoSyncTimer = setInterval(() => {
      this.runAutoSyncOnce().catch((error) => console.error('[lms] 自动同步失败:', error.message));
    }, intervalMs);
    this.autoSyncTimer.unref?.();
    return this;
  }

  stopAutoSync() {
    if (this.autoSyncTimer) clearInterval(this.autoSyncTimer);
    this.autoSyncTimer = undefined;
    return this;
  }

  // ---------------------------------------------------------------- 内部实现

  #resolveSyncOptions(options = {}) {
    return {
      types: options.types?.length ? options.types : DEFAULT_SYNC_TYPES,
      includePast: Boolean(options.includePast),
      includeCourseRange: Boolean(options.includeCourseRange),
      skipSubmitted: options.skipSubmitted === undefined ? true : Boolean(options.skipSubmitted),
      markSubmittedDone: options.markSubmittedDone === undefined ? true : Boolean(options.markSubmittedDone),
      pruneStale: Boolean(options.pruneStale),
      courseIds: options.courseIds?.length ? options.courseIds.map(Number) : null,
      keys: options.keys?.length ? options.keys : null,
      today: options.today ?? todayKey(),
      maxAgeMs: options.maxAgeMs ?? ACTIVITY_TTL_MS,
      refresh: Boolean(options.refresh),
    };
  }

  /** 收集同步所需的课程 + 活动（必要时刷新缓存、补拉作业详情）。 */
  async #collect(options) {
    let courses = this.store.lmsCourses.all();
    if (!courses.length || options.refresh) {
      await this.refreshCourses();
      courses = this.store.lmsCourses.all();
    }
    if (options.courseIds?.length) courses = courses.filter((course) => options.courseIds.includes(Number(course.courseId)));

    const age = this.state.lastActivitiesAt ? Date.now() - Date.parse(this.state.lastActivitiesAt) : Infinity;
    if (!this.store.lmsActivities.all().length || options.refresh || age > options.maxAgeMs) {
      await this.refreshActivities({ courseIds: options.courseIds ?? undefined });
    }

    const activities = this.store.lmsActivities.all().map(activityView);
    await this.#enrichHomeworkDetails(activities, options);

    const refreshed = this.store.lmsActivities.all().map(activityView);
    const countByCourse = new Map();
    for (const activity of refreshed) {
      countByCourse.set(activity.courseId, (countByCourse.get(activity.courseId) ?? 0) + 1);
    }
    const courseList = courses.map(courseView);
    return { courses: courseList, activities: refreshed, countByCourse };
  }

  /** 作业是否已提交，只有详情接口才知道；按需补拉并写回缓存。 */
  async #enrichHomeworkDetails(activities, options) {
    const targets = activities
      .filter((item) => item.type === 'homework' && !item.detailFetchedAt)
      .filter((item) => {
        if (options.includePast) return true;
        const end = parseLmsDate(item.endTime) ?? parseLmsDate(item.startTime);
        return end === null || end >= options.today;
      })
      .slice(0, MAX_DETAIL_FETCH);
    for (const activity of targets) {
      try {
        const detail = await this.api.activityDetail(activity.activityId ?? activity.id);
        if (!detail) continue;
        const record = this.store.lmsActivities.get(activityRecordId(activity.activityId ?? activity.id));
        await this.store.lmsActivities.insert({
          ...(record ?? {}),
          ...detail,
          id: activityRecordId(activity.activityId ?? activity.id),
          courseId: detail.courseId ?? record?.courseId ?? null,
          courseName: record?.courseName ?? null,
          fetchedAt: record?.fetchedAt ?? null,
          detailFetchedAt: new Date().toISOString(),
        });
      } catch (error) {
        // 详情失败不影响整体预览：只是这类作业不会被标记为「已提交」
        this.state.detailWarning = `部分作业详情获取失败：${error.message}`;
      }
    }
  }

  async #saveActivities(courseId, list, courseName, now, { force = false } = {}) {
    const existing = this.store.lmsActivities.all().filter((item) => Number(item.courseId) === Number(courseId));
    const existingById = new Map(existing.map((item) => [item.activityId ?? item.id, item]));
    const keep = new Set();
    for (const activity of list) {
      const id = activityRecordId(activity.id);
      keep.add(activity.id);
      const previous = existingById.get(activity.id);
      await this.store.lmsActivities.insert({
        // 详情字段（description / userSubmitCount）在列表接口里没有，合并时不能丢
        ...(force ? {} : (previous ?? {})),
        ...activity,
        id,
        activityId: activity.id,
        courseId: Number(courseId),
        courseName,
        fetchedAt: now,
        detailFetchedAt: previous?.detailFetchedAt ?? null,
      });
    }
    for (const item of existing) {
      if (!keep.has(item.activityId ?? item.id)) await this.store.lmsActivities.remove(item.id);
    }
  }

  async #removeActivitiesOfCourse(courseId) {
    for (const item of this.store.lmsActivities.all()) {
      if (Number(item.courseId) === Number(courseId)) await this.store.lmsActivities.remove(item.id);
    }
  }

  /**
   * 把共享认证的登录结果投影成本模块的状态。
   *
   * 注意来源变了：以前是 `CasAuth` 的返回值（`{status, message, mfa}`），
   * 现在是 `AuthService` 的（`{status, error, mfa, sites}`）—— 后者用的是 `error` 而不是 `message`。
   */
  #handleAuthResult(result) {
    switch (result?.status) {
      case AUTH_STATUS.READY:
        return this.#finishLogin();
      case AUTH_STATUS.NEED_MFA:
        this.state.status = 'need_mfa';
        // 默认值在前、共享认证给的值在后：`flow`（'mfa' 短信 / 'sec' 二次认证）必须透传，
        // 界面靠它决定引导哪条流程。
        this.state.mfa = { flow: 'mfa', required: true, phoneMasked: null, sent: false, ...(result.mfa ?? {}) };
        return this.status();
      case AUTH_STATUS.NEED_CAPTCHA:
        this.state.status = 'need_captcha';
        this.state.error = result.error ?? '请输入图形验证码';
        return this.status();
      case AUTH_STATUS.NEED_ACCOUNT_CHOICE:
        this.state.status = 'error';
        this.state.error = '该账号存在多个身份（本科/研究生），请先在浏览器登录一次后再使用';
        return this.status();
      default:
        this.state.status = 'error';
        // AuthService 用 error 字段；CasAuth 时代是 message —— 两个都认，避免漏掉提示
        this.state.error = result?.error ?? result?.message ?? '登录失败';
        return this.status();
    }
  }

  async #finishLogin() {
    this.state.status = 'ready';
    this.state.mfa = null;
    this.state.error = null;
    this.verified = true;
    try {
      this.state.user = await this.api.userInfo({ refresh: true });
    } catch {
      // 登录票据已经拿到，用户信息只是展示用，拿不到不算失败
      this.state.user = this.state.user ?? { name: '', userNo: '' };
    }
    // 会话票据由共享认证统一落盘；本模块把自己那份元信息（含展示用的账号）也存一下
    await this.sharedAuth.persist();
    await this.#persistMeta();
    return this.status();
  }

  async #persistMeta() {
    await this.metaFile.write({
      lastCoursesAt: this.state.lastCoursesAt,
      lastActivitiesAt: this.state.lastActivitiesAt,
      lastSyncAt: this.state.lastSyncAt,
      autoSync: this.state.autoSync,
      autoSyncIntervalHours: this.state.autoSyncIntervalHours,
      lastAutoSyncAt: this.state.lastAutoSyncAt,
      /** 展示用的账号信息 —— 不是凭据，凭据在 auth-session.json（0600）。 */
      user: this.state.user,
    });
  }

  /**
   * 业务请求前确保学堂可用。
   *
   * 职责已经变了：以前本模块自己判断票据、自己清会话；现在只是问共享认证一句
   * 「学堂这个站点能用吗」——SSO 生效时它会静默用 TGC 换回学堂会话，用户无感。
   */
  async #ensureReady() {
    if (this.verified) return;
    const outcome = await this.sharedAuth.ensure('lms');
    if (outcome.ok) {
      this.verified = true;
      if (this.state.status !== 'ready') this.state.status = 'ready';
      if (!this.state.user) {
        try {
          this.state.user = await this.api.userInfo({ refresh: true });
        } catch {
          this.state.user = this.state.user ?? { name: '', userNo: '' };
        }
      }
      return;
    }
    // 站点不可用：只把自己打回待验证，**不动共享票据** ——
    // 那是全程序共用的，清掉会连带把教务也踢下线。
    this.verified = false;
    this.sharedAuth.invalidate('lms', outcome.reason ?? null);
    this.state.status = 'anonymous';
    throw HttpError.unauthorized(`思源学堂登录态已失效，请重新登录（${outcome.reason ?? '需要登录'}）`);
  }

  /**
   * 上游异常统一翻译：保留 HttpError，其余包装成 502。
   *
   * 顺带承担一件重要的事：**业务请求发现票据失效时，要把本模块打回未登录**。
   * 以前这由 `#clearSession()` 顺手做掉；现在票据归共享认证管，如果不显式处理，
   * 就会出现"接口已经 401 了，但 /lms/status 还说 ready"的矛盾状态
   * （`LmsApi` 抛的是 HttpError，所以必须先判登录态失效、再走 HttpError 的早返回）。
   */
  #translate(error, prefix) {
    const message = error?.message ?? String(error);
    if (/登录态已失效|请先登录/.test(message)) {
      this.#onAuthFailure();
      return error instanceof HttpError ? error : HttpError.unauthorized(message);
    }
    if (error instanceof HttpError) return error;
    // 验证码这类「用户输入问题」按 400 返回，更贴近 HTTP 语义（原来统一被包成 502）
    if (/验证码不正确|验证码不能为空|请先发送验证码/.test(message)) return HttpError.badRequest(message);
    return HttpError.upstream(`${prefix}：${message}`);
  }

  /**
   * 把本模块打回未登录，并让共享认证下次重新验证学堂这个站点。
   *
   * **不动共享票据**：那是全程序共用的，清掉会连带把教务踢下线。
   * 重新验证时如果 CAS 的 TGC 还有效，SSO 会静默把学堂会话换回来 —— 用户无感。
   */
  #onAuthFailure() {
    this.verified = false;
    this.state.status = 'anonymous';
    this.sharedAuth.invalidate('lms', '业务请求发现登录态失效');
  }

  #guard(promiseFactory, prefix) {
    return promiseFactory().catch((error) => {
      throw this.#translate(error, prefix);
    });
  }
}

/** 去掉存储层附加的字段，只把业务字段交给前端/同步逻辑。 */
function stripRecordMeta(record) {
  const { createdAt, updatedAt, ...rest } = record ?? {};
  return rest;
}

/**
 * 课程/活动的对外视图。
 *
 * 存储层用 `lms:course:1001` 这种带前缀的字符串当记录主键，
 * 但对外的 `id` 必须是学校接口里的数字 ID —— 前端和同步逻辑都只认数字 ID，
 * 内部的记录主键以 `recordId` 暴露，方便排查问题。
 */
function courseView(record) {
  const rest = stripRecordMeta(record);
  return { ...rest, recordId: rest.id, id: rest.courseId };
}

function activityView(record) {
  const rest = stripRecordMeta(record);
  return { ...rest, recordId: rest.id, id: rest.activityId ?? rest.id };
}
