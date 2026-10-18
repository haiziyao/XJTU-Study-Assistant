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
import { activityExternalId, homeworkTodoPayload, resolveCourseName } from './todos-bridge.js';
import { daysBetween, parseLmsTime } from './time.js';

const SYNC_TAG = '思源学堂';
const MAX_TITLE = 120;

/**
 * 生成外部唯一键。
 *
 * 实现放在 `todos-bridge.js`（那里才是"作业待办"的拥有者），这里转出同名函数保持旧调用方可用：
 * 同步计划与自动待办桥接必须用**同一个**键，否则同一份作业会被建出两条待办。
 */
export function externalIdFor(activityId) {
  return activityExternalId(activityId);
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

/** 各 kind 需要比较的字段（待办比 deadline/completed，事件比 startDate/endDate，日程比时段）。 */
const COMPARE_FIELDS = {
  schedule: ['title', 'description', 'category', 'date', 'startTime', 'endTime', 'priority'],
  event: ['title', 'description', 'category', 'startDate', 'endDate'],
  todo: ['title', 'description', 'deadline', 'priority', 'completed'],
};

/** 比较新旧记录，找出真正发生变化的字段。 */
function diff(existing, payload, kind = 'schedule') {
  const changed = [];
  for (const field of COMPARE_FIELDS[kind] ?? COMPARE_FIELDS.schedule) {
    if (payload[field] === undefined) continue;
    // 待办的 completed 是布尔，缺省要按 false 比，否则「已勾选」会被误判成变化
    const fallback = field === 'completed' ? false : null;
    const before = existing[field] ?? fallback;
    const after = payload[field] ?? fallback;
    if (String(before) !== String(after)) changed.push(field);
  }
  const beforeTags = (existing.tags ?? []).join('|');
  const afterTags = (payload.tags ?? []).join('|');
  if (beforeTags !== afterTags) changed.push('tags');
  return changed;
}

/**
 * 把一条活动转成同步条目；返回 null 表示这条数据不该进日历。
 *
 * kind 归属（2026-10 重做后）：作业有时刻 -> `schedule`，否则 -> `todo`；
 * 直播/回放有时刻 -> `schedule`，没有时刻 -> 全天 `event`（日程必须是时段）。
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
    // 同一天、两端都有具体时刻 -> 时段日程；否则这条作业就是**待办**（只有截止日）。
    // kind 在这里就定下来：被跳过的条目，前端也要知道它本来会进哪个集合。
    const timed = Boolean(start?.time && deadline.time && start.date === deadline.date);
    const kind = timed ? 'schedule' : 'todo';
    if (!deadline) return { ...base, kind, action: 'skip', reason: '作业没有时间信息，无法安排' };
    if (!options.includePast && deadline.date < today) {
      return { ...base, kind, action: 'skip', reason: '已过期（可勾选「包含过期」再同步）' };
    }
    const existing = options.existingByExternalId.get(base.key);
    if (base.submitted && options.skipSubmitted && !existing) {
      return { ...base, kind, action: 'skip', reason: '已提交，未导入' };
    }
    if (!timed) {
      /*
       * 待办：标题 / 描述 / 标签 / externalId 全部走 `todos-bridge.js` 的**同一份构造器**。
       *
       * 为什么必须共用：自动待办桥接会在活动同步后独立 upsert 同一批待办（同一个 externalId）。
       * 两边字段格式若不一致，每次同步就会互相把标题改来改去（写库、广播、界面闪烁），
       * 用户看到的标题还会取决于"最后一次是谁写的"。共用构造器让两条路径产出完全相同的字段，
       * 谁先谁后都不产生差异。
       */
      const todoBase = homeworkTodoPayload(activity, { courseName: resolveCourseName(activity, null) ?? course?.name ?? null });
      if (!todoBase) return { ...base, kind, action: 'skip', reason: '作业没有截止日期，无法建待办' };
      // 待办契约：只有 deadline / priority / completed，没有 category、地点、提醒
      const todoPayload = {
        ...todoBase,
        priority: priorityForDeadline(today, deadline.date),
      };
      if (base.submitted && options.markSubmittedDone) todoPayload.completed = true;
      else if (existing?.completed) todoPayload.completed = existing.completed; // 保留学生自己勾过的状态
      return finalizeItem({ ...base, kind, isTimed: false }, todoPayload, existing);
    }

    const refinedHomework = refineActivityTitle(activity.title, course?.name ?? null);
    const common = {
      title: clip(composeTitle(refinedHomework.title, course?.name ?? null)),
      description: describe({ course, activity, deadlineText: formatDeadline(activity.endTime ?? activity.startTime), type }),
      tags: [SYNC_TAG, '作业', ...(course?.name ? [course.name] : [])],
      source: 'import',
      externalId: base.key,
    };

    const payload = {
      ...common,
      category: 'study',
      date: deadline.date,
      startTime: start.time,
      endTime: deadline.time,
      priority: priorityForDeadline(today, deadline.date),
      reminders: existing?.reminders?.length ? existing.reminders : [{ offsetMinutes: 60, channel: 'app' }],
    };
    return finalizeItem({ ...base, kind, isTimed: true }, payload, existing);
  }

  if (type === 'lecture_live') {
    if (!start && !deadline) return { ...base, action: 'skip', reason: '直播没有时间信息' };
    const date = (start ?? deadline).date;
    if (!options.includePast && date < today) return { ...base, action: 'skip', reason: '已结束（可勾选「包含过期」再同步）' };
    const timed = Boolean(start?.time);
    const existing = options.existingByExternalId.get(base.key);
    const refined = refineActivityTitle(activity.title, course?.name ?? null);
    const common = {
      title: clip(composeTitle(refined.title, course?.name ?? null)),
      description: describe({ course, activity, deadlineText: formatDeadline(activity.startTime), type }),
      tags: [SYNC_TAG, '直播', ...(course?.name ? [course.name] : [])],
      source: 'import',
      externalId: base.key,
    };

    if (!timed) {
      // 没有具体时刻的直播 -> 全天日历事件（日程必须是时段，不能塞进 /schedules）
      return finalizeItem(
        { ...base, kind: 'event', isTimed: false },
        { ...common, category: 'study', startDate: date, endDate: date, allDay: true },
        existing,
      );
    }

    const payload = {
      ...common,
      category: 'class',
      location: refined.location ?? undefined,
      date,
      startTime: start.time,
      priority: 1,
      reminders: existing?.reminders?.length ? existing.reminders : [{ offsetMinutes: 15, channel: 'app' }],
    };
    if (deadline?.time && deadline.date === start.date) payload.endTime = deadline.time;
    return finalizeItem({ ...base, kind: 'schedule', isTimed: true }, payload, existing);
  }

  if (type === 'lesson') {
    // 回放是否导入由调用方传的 types 决定：默认 types 里没有 lesson，因此默认不进来
    if (!start) return { ...base, action: 'skip', reason: '回放没有时间信息' };
    if (!options.includePast && start.date < today) return { ...base, action: 'skip', reason: '已过期' };
    const existing = options.existingByExternalId.get(base.key);
    const refinedReplay = refineActivityTitle(activity.title, course?.name ?? null);
    const common = {
      title: clip(composeTitle(refinedReplay.title, course?.name ?? null)),
      description: describe({ course, activity, deadlineText: formatDeadline(activity.startTime), type }),
      tags: [SYNC_TAG, '回放', ...(course?.name ? [course.name] : [])],
      source: 'import',
      externalId: base.key,
    };

    if (!start.time) {
      return finalizeItem(
        { ...base, kind: 'event', isTimed: false },
        { ...common, category: 'study', startDate: start.date, endDate: start.date, allDay: true },
        existing,
      );
    }

    const payload = {
      ...common,
      category: 'class',
      location: refinedReplay.location ?? undefined,
      date: start.date,
      startTime: start.time,
      priority: 0,
      reminders: existing?.reminders?.length ? existing.reminders : [],
    };
    const end = parseLmsTime(activity.lessonEnd ?? activity.endTime);
    if (end?.time && end.date === start.date) payload.endTime = end.time;
    return finalizeItem({ ...base, kind: 'schedule', isTimed: true }, payload, existing);
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
  const changed = diff(existing, payload, base.kind);
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
export function buildSyncPlan({ courses = [], activities = [], existingSchedules = [], existingEvents = [], existingTodos = [], options = {} }) {
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

  // 三个集合都要纳入幂等查找，否则作业（现在落在待办里）每次同步都会重复创建
  const existingByExternalId = new Map();
  for (const item of existingSchedules) if (item.externalId) existingByExternalId.set(item.externalId, { ...item, __kind: 'schedule' });
  for (const item of existingEvents) if (item.externalId) existingByExternalId.set(item.externalId, { ...item, __kind: 'event' });
  for (const item of existingTodos) if (item.externalId) existingByExternalId.set(item.externalId, { ...item, __kind: 'todo' });

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
      kind: existing.__kind ?? (existing.startDate !== undefined ? 'event' : 'schedule'),
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

  // kind -> 集合：待办进 todos，事件进 events，时段日程进 schedules
  const collectionOf = (kind) => {
    if (kind === 'todo') return services.todos;
    if (kind === 'event') return services.events;
    return services.schedules;
  };

  for (const item of plan.items) {
    if (wanted && !wanted.has(item.key)) continue;
    try {
      if (item.action === 'create') {
        const created = await collectionOf(item.kind).create(item.payload);
        results.created += 1;
        results.results.push({ key: item.key, action: 'create', kind: item.kind, id: created.id, title: created.title });
      } else if (item.action === 'update') {
        const updated = await collectionOf(item.kind).update(item.existingId, item.payload);
        results.updated += 1;
        results.results.push({ key: item.key, action: 'update', kind: item.kind, id: updated?.id ?? item.existingId, changes: item.changes });
      } else if (item.action === 'stale' && pruneStale) {
        await collectionOf(item.kind).remove(item.existingId);
        results.removed += 1;
        results.results.push({ key: item.key, action: 'remove', kind: item.kind, id: item.existingId });
      } else {
        results.skipped += 1;
      }
    } catch (error) {
      results.errors.push({ key: item.key, message: error.message ?? String(error) });
    }
  }
  return results;
}
