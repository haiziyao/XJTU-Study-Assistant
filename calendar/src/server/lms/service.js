/**
 * 思源学堂服务：把「登录 → 拉课程 → 拉活动 → 同步到日历」串起来。
 *
 * 设计要点：
 * - 会话只保留在内存 + `data/lms-session.json`（0600），进程重启后免登录；
 * - 课程/活动落本地缓存（JsonStore），离线也能看，重新同步不会重复建日程；
 * - 同步是「先预览后应用」：预览只读、纯计算，应用才写数据；
 * - 所有面向 HTTP 的失败都翻译成带状态码的 HttpError，路由层不再判断。
 */

import path from 'node:path';

import { HttpError } from '../http/router.js';
import { todayKey } from '../../shared/time.js';
import { AUTH_STATUS, CasAuth, generateVisitorId } from './cas-auth.js';
import { DEFAULT_SYNC_TYPES, resolveLmsConfig } from './config.js';
import { CookieJar, HttpClient } from './http-client.js';
import { JsonFile } from './secret-store.js';
import { LmsApi } from './api.js';
import { applySyncPlan, buildSyncPlan } from './sync.js';
import { parseLmsDate } from './time.js';

/** 会话文件最多认多久（超过则忽略，强制重新登录）。 */
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** 活动缓存的新鲜度：预览时若超过这个时间就顺手刷新一次。 */
const ACTIVITY_TTL_MS = 10 * 60 * 1000;
/** 单次预览最多补拉多少条作业详情（详情接口一个活动一次请求）。 */
const MAX_DETAIL_FETCH = 40;

const courseRecordId = (courseId) => `lms:course:${courseId}`;
const activityRecordId = (activityId) => `lms:activity:${activityId}`;

export class LmsService {
  constructor({ store, services, broadcast = () => {}, config = resolveLmsConfig(), dataDir, visitorId } = {}) {
    this.store = store;
    this.broadcast = broadcast;
    this.config = resolveLmsConfig(config ?? {});
    this.dataDir = dataDir ?? store?.dataDir ?? '.';
    this.services = services ?? {};
    this.jar = new CookieJar();
    this.http = new HttpClient({ userAgent: config.userAgent, timeoutMs: config.timeoutMs, jar: this.jar });
    this.auth = new CasAuth({ http: this.http, config, visitorId: visitorId ?? generateVisitorId() });
    this.api = new LmsApi({ http: this.http, config });
    this.sessionFile = new JsonFile(path.join(this.dataDir, 'lms-session.json'));
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
    return {
      status: this.state.status,
      user: this.state.user,
      mfa: this.state.mfa,
      captchaRequired: Boolean(this.auth?.captchaRequired),
      error: this.state.error,
      baseUrl: this.config.baseUrl,
      cache: {
        courses: courses.length,
        activities: activities.length,
        lastCoursesAt: this.state.lastCoursesAt,
        lastActivitiesAt: this.state.lastActivitiesAt,
      },
      synced: { schedules: schedules.length, events: events.length },
      lastSyncAt: this.state.lastSyncAt,
      autoSync: {
        enabled: this.state.autoSync,
        intervalHours: this.state.autoSyncIntervalHours,
        lastRunAt: this.state.lastAutoSyncAt,
      },
    };
  }

  // ---------------------------------------------------------------- 登录相关

  /** 进程启动时调用：恢复上次的会话。 */
  async restore() {
    if (this.restored) return this.status();
    this.restored = true;
    const saved = await this.sessionFile.read();
    const meta = (await this.metaFile.read()) ?? {};
    this.state.lastCoursesAt = meta.lastCoursesAt ?? null;
    this.state.lastActivitiesAt = meta.lastActivitiesAt ?? null;
    this.state.lastSyncAt = meta.lastSyncAt ?? null;
    this.state.autoSync = Boolean(meta.autoSync);
    this.state.autoSyncIntervalHours = Number(meta.autoSyncIntervalHours) > 0 ? Number(meta.autoSyncIntervalHours) : 6;
    this.state.lastAutoSyncAt = meta.lastAutoSyncAt ?? null;
    if (!saved?.cookies?.length) return this.status();
    const savedAt = Date.parse(saved.savedAt ?? '');
    if (Number.isFinite(savedAt) && Date.now() - savedAt > SESSION_MAX_AGE_MS) {
      await this.sessionFile.remove();
      return this.status();
    }
    this.jar = CookieJar.fromJSON(saved.cookies);
    this.http.jar = this.jar;
    this.state.user = saved.user ?? null;
    // 先乐观地认为已登录，真正的失效会在第一次业务请求时被发现并清理
    this.state.status = 'ready';
    this.state.error = null;
    return this.status();
  }

  async login({ username, password, captcha, trustAgent = true } = {}) {
    this.state.error = null;
    try {
      if (!this.auth.postUrl && !this.auth.hasLogin) {
        const started = await this.auth.begin();
        if (started === AUTH_STATUS.READY) return this.#finishLogin();
      }
      const result = await this.auth.login({ username, password, captcha, trustAgent });
      return this.#handleAuthResult(result);
    } catch (error) {
      throw this.#translate(error, '登录思源学堂失败');
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
    let items = this.store.lmsActivities
      .all()
      .map((record) => activityView(record))
      .filter((item) => (courseIds?.length ? courseIds.map(Number).includes(Number(item.courseId)) : true))
      .filter((item) => (type ? item.type === type : true));
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
      this.state.user = await this.api.userInfo({ refresh: true });
    } catch (error) {
      // 登录票据已经拿到，用户信息只是展示用，拿不到不算失败
      this.state.user = this.state.user ?? { name: '', userNo: '' };
    }
    await this.#persistSession();
    return this.status();
  }

  async #persistSession() {
    await this.sessionFile.write({
      savedAt: new Date().toISOString(),
      user: this.state.user,
      cookies: this.jar.toJSON(),
    });
  }

  async #persistMeta() {
    await this.metaFile.write({
      lastCoursesAt: this.state.lastCoursesAt,
      lastActivitiesAt: this.state.lastActivitiesAt,
      lastSyncAt: this.state.lastSyncAt,
      autoSync: this.state.autoSync,
      autoSyncIntervalHours: this.state.autoSyncIntervalHours,
      lastAutoSyncAt: this.state.lastAutoSyncAt,
    });
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
    await this.sessionFile.remove();
  }

  /** 业务请求前确保有可用登录态，失效时清掉本地票据并提示重新登录。 */
  async #ensureReady() {
    if (this.verified || this.auth.hasLogin) {
      this.verified = this.verified || this.auth.hasLogin;
      if (this.state.status !== 'ready') this.state.status = 'ready';
      return;
    }
    if (this.restored && this.jar.toJSON().length) {
      try {
        this.state.user = await this.api.userInfo({ refresh: true });
        this.auth.hasLogin = true;
        this.verified = true;
        this.state.status = 'ready';
        return;
      } catch {
        await this.#clearSession();
        throw HttpError.unauthorized('思源学堂登录态已失效，请重新登录');
      }
    }
    throw HttpError.unauthorized('请先登录思源学堂');
  }

  /** 上游异常统一翻译：保留 HttpError，其余包装成 502。 */
  #translate(error, prefix) {
    if (error instanceof HttpError) return error;
    const message = error?.message ?? String(error);
    if (/登录态已失效|请先登录/.test(message)) return HttpError.unauthorized(message);
    // 验证码这类「用户输入问题」按 400 返回，更贴近 HTTP 语义（原来统一被包成 502）
    if (/验证码不正确|验证码不能为空|请先发送验证码/.test(message)) return HttpError.badRequest(message);
    return HttpError.upstream(`${prefix}：${message}`);
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
