/**
 * 思源学堂 → 日历的同步规划（纯函数，方便单测）。
 *
 * 映射规则（有意保守，宁可少导入也不要制造噪音）：
 *
 * | 思源学堂数据        | 落到日历的东西                                   |
 * |---------------------|--------------------------------------------------|
 * | 作业 homework       | 日程：有起止时刻→时段块；只有截止日→全天待办      |
 * | 直播 lecture_live   | 日程：时段块（category=class）                    |
 * | 回放 lesson         | 默认不导入（历史视频，可选项）                    |
 * | 资料 material       | 不导入（没有时间语义）                            |
 * | 课程 course         | 默认不写日历；可选项：整学期区间做成一条日历事件  |
 *
 * 幂等：每条记录都带 `externalId = lms:<类型>:<活动ID>`，
 * 重复同步只会「更新」而不会「新增」，学生自己改过的状态/提醒不会被覆盖。
 */

import { ACTIVITY_TYPE_LABEL, DEFAULT_SYNC_TYPES } from './config.js';
import { daysBetween, parseLmsTime } from './time.js';

const SYNC_TAG = '思源学堂';
const MAX_TITLE = 120;

/** 生成外部唯一键。 */
export function externalIdFor(activityId) {
  return `lms:activity:${activityId}`;
}

export const COURSE_EVENT_EXTERNAL_ID = 'lms:course-range';

function clip(text, max = MAX_TITLE) {
  const value = String(text ?? '').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function priorityForDeadline(today, deadlineDate) {
  const days = daysBetween(today, deadlineDate);
  if (days <= 1) return 2;
  if (days <= 3) return 1;
  return 0;
}

/**
 * 清洗活动标题。
 *
 * 实测学校返回的活动标题长这样：
 *   直播：`2026-09-14-材料力学`
 *   回放：`材料力学 教2楼-西203 2026-09-14 08:00:00-08:50:00`
 * 直接拿去当日程标题会又长又重复，所以这里去掉日期前缀，
 * 并把回放标题里的教室抠出来放进 `location`（日历里上课地点很有用）。
 */
export function refineActivityTitle(rawTitle, courseName) {
  let text = String(rawTitle ?? '').trim();
  text = text.replace(/^\d{4}[-/]\d{1,2}[-/]\d{1,2}[-_\s]*/, '').trim();
  let location = null;
  if (courseName && text.startsWith(courseName)) {
    const rest = text.slice(courseName.length).trim();
    const match = rest.match(/^(.+?)\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}/);
    if (match) {
      location = match[1].trim() || null;
      text = courseName;
    } else if (!rest) {
      text = courseName;
    }
  }
  return { title: text || courseName || '', location };
}

/** 标题里已经有课程名就不再重复加前缀。 */
function composeTitle(title, courseName) {
  if (!courseName) return title;
  if (!title) return courseName;
  return title.includes(courseName) ? title : `[${courseName}] ${title}`;
}

function courseMapOf(courses) {
  const map = new Map();
  for (const course of courses ?? []) map.set(Number(course.id), course);
  return map;
}

function describe({ course, activity, deadlineText, type }) {
  const lines = [];
  if (course?.name) lines.push(`课程：${course.name}`);
  if (course?.instructors?.length) lines.push(`教师：${course.instructors.map((item) => item.name).filter(Boolean).join('、')}`);
  lines.push(`类型：${ACTIVITY_TYPE_LABEL[type] ?? type}`);
  if (deadlineText) lines.push(`截止：${deadlineText}`);
  lines.push(`来源：思源学堂（活动 ID ${activity.id}）`);
  return lines.join('\n');
}

/** 比较新旧记录，找出真正发生变化的字段。 */
function diff(existing, payload) {
  const changed = [];
  for (const field of [
    'title',
    'description',
    'category',
    'date',
    'startTime',
    'endTime',
    'allDay',
    'priority',
    'status',
    'startDate',
    'endDate',
  ]) {
    if (payload[field] === undefined) continue;
    const before = existing[field] ?? (field === 'allDay' ? false : null);
    const after = payload[field] ?? (field === 'allDay' ? false : null);
    if (String(before) !== String(after)) changed.push(field);
  }
  const beforeTags = (existing.tags ?? []).join('|');
  const afterTags = (payload.tags ?? []).join('|');
  if (beforeTags !== afterTags) changed.push('tags');
  return changed;
}

/**
 * 把一条活动转成同步条目；返回 null 表示这条数据不该进日历。
 * @returns {object|null}
 */
export function activityToItem(activity, { course, today, options }) {
  const type = activity.type;
  const deadline = parseLmsTime(activity.endTime) ?? parseLmsTime(activity.startTime);
  const start = parseLmsTime(activity.startTime);
  const base = {
    key: externalIdFor(activity.id),
    activityId: activity.id,
    courseId: activity.courseId,
    courseName: course?.name ?? null,
    type,
    typeLabel: ACTIVITY_TYPE_LABEL[type] ?? type,
    title: activity.title,
    startTime: activity.startTime,
    endTime: activity.endTime,
    submitted: (activity.userSubmitCount ?? 0) > 0,
  };

  if (type === 'homework') {
    if (!deadline) return { ...base, action: 'skip', reason: '作业没有时间信息，无法安排' };
    if (!options.includePast && deadline.date < today) {
      return { ...base, action: 'skip', reason: '已过期（可勾选「包含过期」再同步）' };
    }
    // 同一天、两端都有具体时刻 -> 时段块；否则按「截止日的待办」处理
    const timed = Boolean(start?.time && deadline.time && start.date === deadline.date);
    const allDay = !timed;
    const existing = options.existingByExternalId.get(base.key);
    const status = base.submitted && options.markSubmittedDone ? 'done' : existing?.status ?? 'pending';
    if (base.submitted && options.skipSubmitted && !existing) {
      return { ...base, action: 'skip', reason: '已提交，未导入' };
    }
    const refinedHomework = refineActivityTitle(activity.title, course?.name ?? null);
    const payload = {
      title: clip(composeTitle(refinedHomework.title, course?.name ?? null)),
      description: describe({ course, activity, deadlineText: formatDeadline(activity.endTime ?? activity.startTime), type }),
      category: 'study',
      date: deadline.date,
      allDay,
      status,
      priority: priorityForDeadline(today, deadline.date),
      tags: [SYNC_TAG, '作业', ...(course?.name ? [course.name] : [])],
      reminders: existing?.reminders?.length ? existing.reminders : [{ offsetMinutes: timed ? 60 : 0, channel: 'app' }],
      source: 'import',
      externalId: base.key,
    };
    if (timed) {
      payload.startTime = start.time;
      payload.endTime = deadline.time;
    }
    return finalizeItem({ ...base, kind: 'schedule', isTimed: timed }, payload, existing);
  }

  if (type === 'lecture_live') {
    if (!start && !deadline) return { ...base, action: 'skip', reason: '直播没有时间信息' };
    const date = (start ?? deadline).date;
    if (!options.includePast && date < today) return { ...base, action: 'skip', reason: '已结束（可勾选「包含过期」再同步）' };
    const timed = Boolean(start?.time);
    const existing = options.existingByExternalId.get(base.key);
    const refined = refineActivityTitle(activity.title, course?.name ?? null);
    const payload = {
      title: clip(composeTitle(refined.title, course?.name ?? null)),
      description: describe({ course, activity, deadlineText: formatDeadline(activity.startTime), type }),
      category: 'class',
      location: refined.location ?? undefined,
      date,
      allDay: !timed,
      status: existing?.status ?? 'pending',
      priority: timed ? 1 : 0,
      tags: [SYNC_TAG, '直播', ...(course?.name ? [course.name] : [])],
      reminders: existing?.reminders?.length ? existing.reminders : [{ offsetMinutes: 15, channel: 'app' }],
      source: 'import',
      externalId: base.key,
    };
    if (timed) {
      payload.startTime = start.time;
      if (deadline?.time && deadline.date === start.date) payload.endTime = deadline.time;
    }
    return finalizeItem({ ...base, kind: 'schedule', isTimed: timed }, payload, existing);
  }

  if (type === 'lesson') {
    // 回放是否导入由调用方传的 types 决定：默认 types 里没有 lesson，因此默认不进来
    if (!start) return { ...base, action: 'skip', reason: '回放没有时间信息' };
    if (!options.includePast && start.date < today) return { ...base, action: 'skip', reason: '已过期' };
    const existing = options.existingByExternalId.get(base.key);
    const refinedReplay = refineActivityTitle(activity.title, course?.name ?? null);
    const payload = {
      title: clip(composeTitle(refinedReplay.title, course?.name ?? null)),
      description: describe({ course, activity, deadlineText: formatDeadline(activity.startTime), type }),
      category: 'class',
      location: refinedReplay.location ?? undefined,
      date: start.date,
      allDay: !start.time,
      status: existing?.status ?? 'pending',
      priority: 0,
      tags: [SYNC_TAG, '回放', ...(course?.name ? [course.name] : [])],
      reminders: existing?.reminders?.length ? existing.reminders : [],
      source: 'import',
      externalId: base.key,
    };
    if (start.time) {
      payload.startTime = start.time;
      const end = parseLmsTime(activity.lessonEnd ?? activity.endTime);
      if (end?.time && end.date === start.date) payload.endTime = end.time;
    }
    return finalizeItem({ ...base, kind: 'schedule', isTimed: Boolean(start.time) }, payload, existing);
  }

  return { ...base, action: 'skip', reason: `${ACTIVITY_TYPE_LABEL[type] ?? type}不参与同步` };
}

function formatDeadline(value) {
  const parsed = parseLmsTime(value);
  if (!parsed) return null;
  return parsed.time ? `${parsed.date} ${parsed.time}` : parsed.date;
}

function finalizeItem(base, payload, existing) {
  if (!existing) {
    return { ...base, action: 'create', payload };
  }
  const changed = diff(existing, payload);
  if (!changed.length) {
    return { ...base, action: 'skip', reason: '已是最新', existingId: existing.id, payload };
  }
  return { ...base, action: 'update', existingId: existing.id, changes: changed, payload };
}

/**
 * 生成同步计划。
 *
 * @param {object} input
 * @param {object[]} input.courses    归一化课程
 * @param {object[]} input.activities 归一化活动（可只带简要字段）
 * @param {object[]} input.existingSchedules 现有日程（用于幂等判断）
 * @param {object[]} input.existingEvents    现有日历事件
 * @param {object}   [input.options]
 * @returns {{items:object[], summary:object}}
 */
export function buildSyncPlan({ courses = [], activities = [], existingSchedules = [], existingEvents = [], options = {} }) {
  const today = options.today;
  if (!today) throw new Error('buildSyncPlan 需要 options.today（YYYY-MM-DD）');
  const resolved = {
    types: DEFAULT_SYNC_TYPES,
    includePast: false,
    includeLesson: false,
    includeCourseRange: false,
    skipSubmitted: true,
    markSubmittedDone: true,
    pruneStale: false,
    courseIds: null,
    ...options,
  };

  const existingByExternalId = new Map();
  for (const item of [...existingSchedules, ...existingEvents]) {
    if (item.externalId) existingByExternalId.set(item.externalId, item);
  }

  const courseById = courseMapOf(courses);
  const items = [];
  const seenKeys = new Set();

  for (const activity of activities) {
    if (resolved.courseIds?.length && !resolved.courseIds.includes(Number(activity.courseId))) continue;
    if (!resolved.types.includes(activity.type)) continue;
    const item = activityToItem(activity, {
      course: courseById.get(Number(activity.courseId)) ?? null,
      today,
      options: { ...resolved, existingByExternalId },
    });
    if (!item) continue;
    if (seenKeys.has(item.key)) continue;
    seenKeys.add(item.key);
    items.push(normalizeItem(item));
  }

  // 可选：整学期课程区间做成一条日历事件（会在月视图每天都出现，默认关闭）
  if (resolved.includeCourseRange) {
    for (const course of courses) {
      if (resolved.courseIds?.length && !resolved.courseIds.includes(Number(course.id))) continue;
      if (!course.startDate || !course.endDate) continue;
      const key = `${COURSE_EVENT_EXTERNAL_ID}:${course.id}`;
      const payload = {
        title: clip(`课程：${course.name}`),
        description: [
          course.instructors?.length ? `教师：${course.instructors.map((i) => i.name).join('、')}` : null,
          course.credit ? `学分：${course.credit}` : null,
          `学期区间：${course.startDate} ~ ${course.endDate}`,
        ]
          .filter(Boolean)
          .join('\n'),
        category: 'study',
        startDate: course.startDate,
        endDate: course.endDate,
        allDay: true,
        tags: [SYNC_TAG, '课程', course.name],
        source: 'import',
        externalId: key,
      };
      const existing = existingByExternalId.get(key);
      const item = finalizeItem(
        { key, kind: 'event', courseId: course.id, courseName: course.name, type: 'course', typeLabel: '课程', title: course.name },
        payload,
        existing,
      );
      seenKeys.add(key);
      items.push(normalizeItem(item));
    }
  }

  /** 补齐前端需要的字段：kind 一定有值，payload 在没有内容时是 null 而不是 undefined。 */
  function normalizeItem(item) {
    const normalized = { kind: 'schedule', ...item };
    if (normalized.payload === undefined) normalized.payload = null;
    return normalized;
  }

  // 已经同步过、但思源学堂那边已经查不到的活动
  for (const [externalId, existing] of existingByExternalId) {
    if (!externalId.startsWith('lms:')) continue;
    if (seenKeys.has(externalId)) continue;
    if (externalId.startsWith(COURSE_EVENT_EXTERNAL_ID) && !resolved.includeCourseRange) continue;
    items.push({
      key: externalId,
      kind: existing.startDate !== undefined ? 'event' : 'schedule',
      action: 'stale',
      existingId: existing.id,
      title: existing.title,
      reason: '思源学堂已查不到这条活动',
      payload: null,
    });
  }

  const summary = { create: 0, update: 0, skip: 0, stale: 0, total: items.length };
  for (const item of items) summary[item.action] = (summary[item.action] ?? 0) + 1;
  return { items, summary };
}

/**
 * 执行同步计划。只处理 keys 里给出的条目（默认全部）。
 * @returns {Promise<{created:number,updated:number,removed:number,skipped:number,results:object[],errors:object[]}>}
 */
export async function applySyncPlan({ services, plan, keys = null, pruneStale = false }) {
  const wanted = keys ? new Set(keys) : null;
  const results = { created: 0, updated: 0, removed: 0, skipped: 0, results: [], errors: [] };

  for (const item of plan.items) {
    if (wanted && !wanted.has(item.key)) continue;
    try {
      if (item.action === 'create') {
        const created = item.kind === 'event' ? await services.events.create(item.payload) : await services.schedules.create(item.payload);
        results.created += 1;
        results.results.push({ key: item.key, action: 'create', id: created.id, title: created.title });
      } else if (item.action === 'update') {
        const updated =
          item.kind === 'event'
            ? await services.events.update(item.existingId, item.payload)
            : await services.schedules.update(item.existingId, item.payload);
        results.updated += 1;
        results.results.push({ key: item.key, action: 'update', id: updated?.id ?? item.existingId, changes: item.changes });
      } else if (item.action === 'stale' && pruneStale) {
        if (item.kind === 'event') await services.events.remove(item.existingId);
        else await services.schedules.remove(item.existingId);
        results.removed += 1;
        results.results.push({ key: item.key, action: 'remove', id: item.existingId });
      } else {
        results.skipped += 1;
      }
    } catch (error) {
      results.errors.push({ key: item.key, message: error.message ?? String(error) });
    }
  }
  return results;
}
