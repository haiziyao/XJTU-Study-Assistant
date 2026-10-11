/**
 * 日程服务（时段粒度：某一天的具体起止时刻，可带提醒与预估时长）。
 *
 * 对应 PotatoCalendar 中 events.json（时段块）与 todos.json（日期锚点 + 预估时长 + 优先级）的合体：
 * - 有 startTime/endTime 时是时段块，用于日/周视图网格；
 * - allDay=true 时退化为「日期锚点」，等价于原来的待办（deadline）。
 */

import { HttpError } from '../../core/http/router.js';
import { addDays, clockToMinutes, todayKey, weekRange } from '../../shared/time.js';
import { SCHEDULE_CATEGORIES, SCHEDULE_STATUS } from '../../shared/constants.js';
import { expandDates, isoWeekday } from './recurrence.js';
import { enumValue, intValue, optionalText, pickDefined, requireTitle, stringArray } from '../../core/validate.js';
import { complexityOf, normalizeReminders, normalizeRepeat, optionalClock, requireClock, requireDate } from './schema.js';
import { normalizeAliases } from './compat.js';

const EDITABLE = [
  'title',
  'description',
  'category',
  'date',
  'startTime',
  'endTime',
  'allDay',
  'status',
  'priority',
  'estimatedMinutes',
  'location',
  'tags',
  'reminders',
  'repeat',
  'eventId',
  'source',
  'externalId',
  'rolledFrom',
  'rolledTo',
  'completedAt',
];

function normalize(rawInput, { partial = false } = {}) {
  // 兼容 dschat 2 风格入参（snake_case、扁平 repeat、宽松日期、completed 布尔）
  const input = normalizeAliases(rawInput);
  const data = {};
  if (input.title !== undefined) data.title = requireTitle(input.title);
  else if (!partial) data.title = requireTitle(undefined);

  if (input.date !== undefined) data.date = requireDate(input.date, 'date');
  else if (!partial) data.date = requireDate(undefined, 'date');

  const allDay = input.allDay !== undefined ? Boolean(input.allDay) : partial ? undefined : false;
  if (allDay !== undefined) data.allDay = allDay;

  if (input.startTime !== undefined) data.startTime = optionalClock(input.startTime, 'startTime');
  else if (!partial && !allDay) data.startTime = requireClock(input.startTime, 'startTime');

  if (input.endTime !== undefined) data.endTime = optionalClock(input.endTime, 'endTime');

  const start = data.startTime;
  const end = data.endTime;
  if (start && end && clockToMinutes(end) < clockToMinutes(start)) {
    throw HttpError.badRequest('字段 endTime 不合法：不能早于 startTime（跨零点请拆成两条）', { field: 'endTime' });
  }

  if (input.description !== undefined) data.description = optionalText(input.description, 'description') ?? '';
  if (input.location !== undefined) data.location = optionalText(input.location, 'location', 120) ?? '';
  if (input.category !== undefined) {
    data.category = enumValue(input.category, SCHEDULE_CATEGORIES, 'category', { optional: true, fallback: 'other' });
  } else if (!partial) data.category = 'other';

  if (input.status !== undefined) {
    data.status = enumValue(input.status, SCHEDULE_STATUS, 'status', { optional: true, fallback: 'pending' });
  } else if (!partial) data.status = 'pending';

  if (input.priority !== undefined) {
    data.priority = intValue(input.priority, 'priority', { min: 0, max: 2, optional: true, fallback: 1 });
  } else if (!partial) data.priority = 1;

  if (input.estimatedMinutes !== undefined) {
    data.estimatedMinutes = intValue(input.estimatedMinutes, 'estimatedMinutes', {
      min: 0,
      max: 60 * 24 * 30,
      optional: true,
      fallback: undefined,
    });
  }
  if (input.tags !== undefined) data.tags = stringArray(input.tags, 'tags') ?? [];
  if (input.reminders !== undefined) data.reminders = normalizeReminders(input.reminders);
  else if (!partial) data.reminders = [];
  if (input.repeat !== undefined) data.repeat = normalizeRepeat(input.repeat);
  else if (!partial) data.repeat = normalizeRepeat(undefined);
  if (input.eventId !== undefined) data.eventId = input.eventId === null ? null : String(input.eventId);
  if (input.source !== undefined) {
    data.source = enumValue(input.source, ['manual', 'command', 'ai', 'import'], 'source', { optional: true, fallback: 'manual' });
  } else if (!partial) data.source = 'manual';
  // 外部系统（思源学堂等）的记录标识，用于重复同步时的幂等更新
  if (input.externalId !== undefined) data.externalId = input.externalId === null ? null : String(input.externalId);
  if (input.rolledFrom !== undefined) data.rolledFrom = input.rolledFrom;
  if (input.rolledTo !== undefined) data.rolledTo = input.rolledTo;
  if (input.completedAt !== undefined) data.completedAt = input.completedAt;

  if (data.allDay) {
    data.startTime = undefined;
    data.endTime = undefined;
  }
  return data;
}

export class ScheduleService {
  constructor({ store, broadcast = () => {} }) {
    this.store = store;
    this.broadcast = broadcast;
  }

  get collection() {
    return this.store.schedules;
  }

  /** 原始记录查询。支持 date（单日）、from/to（闭区间）、status、category、keyword、priority。 */
  list({ date, from, to, status, category, keyword, priority, limit, includeRolled = true } = {}) {
    let items = this.collection.all();
    if (date) items = items.filter((item) => item.date === date);
    if (from) items = items.filter((item) => item.date >= from);
    if (to) items = items.filter((item) => item.date <= to);
    if (status) {
      const wanted = String(status).split(',').map((s) => s.trim());
      items = items.filter((item) => wanted.includes(item.status));
    }
    if (!includeRolled) items = items.filter((item) => item.status !== 'rolled');
    if (category) items = items.filter((item) => item.category === category);
    if (priority !== undefined && priority !== '') items = items.filter((item) => item.priority === Number(priority));
    if (keyword) {
      const kw = String(keyword).toLowerCase();
      items = items.filter(
        (item) =>
          item.title.toLowerCase().includes(kw) ||
          (item.description ?? '').toLowerCase().includes(kw) ||
          (item.location ?? '').toLowerCase().includes(kw) ||
          (item.tags ?? []).some((tag) => tag.toLowerCase().includes(kw)),
      );
    }
    items.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return (a.startTime ?? '').localeCompare(b.startTime ?? '');
    });
    if (limit) items = items.slice(0, Number(limit));
    return items.map((item) => ({ ...item, complexity: complexityOf(item.estimatedMinutes) }));
  }

  get(id) {
    const item = this.collection.get(id);
    if (!item) throw HttpError.notFound(`日程不存在: ${id}`);
    return item;
  }

  /** 展开区间内的每一次日程（重复日程按规则命中）。 */
  range({ from, to, ...filters } = {}) {
    if (!from || !to) throw HttpError.badRequest('from 与 to 为必填（YYYY-MM-DD）');
    if (to < from) throw HttpError.badRequest('to 不能早于 from');
    const occurrences = [];
    for (const item of this.list({ ...filters, includeRolled: false })) {
      const dates = expandDates({ anchorKey: item.date, repeat: item.repeat, from, to });
      for (const date of dates) {
        occurrences.push({
          id: `${item.id}:${date}`,
          scheduleId: item.id,
          occurrenceDate: date,
          title: item.title,
          category: item.category,
          status: item.status,
          priority: item.priority,
          allDay: item.allDay,
          startTime: item.startTime,
          endTime: item.endTime,
          estimatedMinutes: item.estimatedMinutes,
          complexity: complexityOf(item.estimatedMinutes),
          location: item.location,
          isRepeatInstance: date !== item.date,
        });
      }
    }
    occurrences.sort((a, b) => {
      if (a.occurrenceDate !== b.occurrenceDate) return a.occurrenceDate.localeCompare(b.occurrenceDate);
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return (a.startTime ?? '').localeCompare(b.startTime ?? '');
    });
    return occurrences;
  }

  /** 某日视图：全天/时段分桶 + 统计。 */
  agenda({ date, ...filters } = {}) {
    const day = date ? requireDate(date, 'date') : todayKey();
    const occurrences = this.range({ from: day, to: day, ...filters });
    return {
      date: day,
      allDay: occurrences.filter((item) => item.allDay),
      timed: occurrences.filter((item) => !item.allDay),
      stats: summarize(occurrences),
    };
  }

  /**
   * 与其他日程的时间冲突（同日、时段相交、状态为 pending）。
   * 仅提示，不阻断写入。使用 range() 是为了把重复日程在该日的实例也算进来。
   */
  conflictsFor(candidate) {
    if (!candidate?.date) return [];
    const sameDay = this.range({ from: candidate.date, to: candidate.date }).filter(
      (occurrence) => occurrence.scheduleId !== candidate.id && occurrence.status === 'pending',
    );
    if (candidate.allDay || !candidate.startTime) {
      return sameDay.filter((item) => item.allDay);
    }
    const start = clockToMinutes(candidate.startTime);
    const end = candidate.endTime ? clockToMinutes(candidate.endTime) : start + 60;
    return sameDay.filter((item) => {
      if (item.allDay || !item.startTime) return false;
      const otherStart = clockToMinutes(item.startTime);
      const otherEnd = item.endTime ? clockToMinutes(item.endTime) : otherStart + 60;
      return start < otherEnd && otherStart < end;
    });
  }

  async create(input) {
    const data = normalize(input);
    const created = await this.collection.insert(data);
    this.broadcast({ type: 'data_changed', payload: { target: 'schedule', action: 'create', id: created.id } });
    return created;
  }

  async update(id, patch) {
    const current = this.get(id);
    const merged = { ...pickDefined(current, EDITABLE), ...patch };
    const data = normalize(merged, { partial: false });
    if (data.status === 'done' && !data.completedAt) data.completedAt = new Date().toISOString();
    if (data.status && data.status !== 'done') data.completedAt = undefined;
    const updated = await this.collection.update(id, data);
    this.broadcast({ type: 'data_changed', payload: { target: 'schedule', action: 'update', id } });
    return updated;
  }

  async remove(id) {
    this.get(id);
    await this.collection.remove(id);
    this.broadcast({ type: 'data_changed', payload: { target: 'schedule', action: 'delete', id } });
    return { id, deleted: true };
  }

  /** 状态流转：pending -> done / cancelled / rolled。 */
  async setStatus(id, status) {
    const allowed = enumValue(status, SCHEDULE_STATUS, 'status', { optional: false });
    const updated = await this.update(id, { status: allowed });
    return updated;
  }

  /**
   * 顺延未完成日程：把 `before` 之前仍为 pending 的日程搬到目标周的同一天。
   *
   * 与 PotatoCalendar 的差异：原实现是「克隆一条新的 + 把原条目标记为已完成」，
   * 会造成「被顺延 = 已完成」的语义污染；这里改为
   * - 原记录 status = 'rolled' 并写入 rolledTo 指向新记录；
   * - 新记录 rolledFrom 指回原记录，weekStart 以周一为锚（与原设计一致）。
   */
  async rollover({ weekStart, from } = {}) {
    const today = todayKey();
    const anchor = weekStart ? requireDate(weekStart, 'weekStart') : weekRange(today, 1).start;
    if (isoWeekday(anchor) !== 1) {
      throw HttpError.badRequest('字段 weekStart 不合法：必须是周一', { field: 'weekStart' });
    }
    const pending = this.list({ status: 'pending', includeRolled: false }).filter((item) => item.date < (from ?? anchor));
    if (!pending.length) return { weekStart: anchor, moved: 0, items: [] };

    const created = [];
    for (const item of pending) {
      const targetDate = addDays(anchor, isoWeekday(item.date) - 1);
      const clone = await this.collection.insert({
        ...pickDefined(item, EDITABLE.filter((key) => key !== 'rolledFrom' && key !== 'rolledTo' && key !== 'completedAt')),
        id: undefined,
        date: targetDate,
        status: 'pending',
        source: item.source,
        rolledFrom: { id: item.id, date: item.date },
      });
      await this.collection.update(item.id, {
        status: 'rolled',
        rolledTo: { id: clone.id, date: clone.date },
      });
      created.push({ from: item.id, fromDate: item.date, to: clone.id, toDate: clone.date, title: clone.title });
    }
    this.broadcast({ type: 'data_changed', payload: { target: 'schedule', action: 'rollover', count: created.length } });
    return { weekStart: anchor, moved: created.length, items: created };
  }

  /** 区间统计（周/月进度条）。 */
  stats({ from, to } = {}) {
    const items = this.list({ from, to, includeRolled: true });
    const occurrences = this.range({ from: from ?? todayKey(), to: to ?? todayKey() });
    const base = items.length ? items : occurrences;
    const done = base.filter((item) => item.status === 'done').length;
    const rolled = base.filter((item) => item.status === 'rolled').length;
    const cancelled = base.filter((item) => item.status === 'cancelled').length;
    const pending = base.filter((item) => item.status === 'pending').length;
    const total = base.length;
    const minutes = base
      .filter((item) => item.status !== 'cancelled')
      .reduce((sum, item) => sum + (item.estimatedMinutes ?? durationOf(item)), 0);
    return {
      from,
      to,
      total,
      done,
      pending,
      cancelled,
      rolled,
      completionRate: total ? Number(((done / total) * 100).toFixed(1)) : 0,
      plannedMinutes: minutes,
      plannedHours: Number((minutes / 60).toFixed(1)),
    };
  }
}

function durationOf(item) {
  if (!item.startTime || !item.endTime) return 0;
  return Math.max(0, clockToMinutes(item.endTime) - clockToMinutes(item.startTime));
}

function summarize(occurrences) {
  const done = occurrences.filter((item) => item.status === 'done').length;
  return {
    total: occurrences.length,
    done,
    pending: occurrences.filter((item) => item.status === 'pending').length,
    completionRate: occurrences.length ? Number(((done / occurrences.length) * 100).toFixed(1)) : 0,
    plannedMinutes: occurrences.reduce(
      (sum, item) => sum + (item.estimatedMinutes ?? (item.startTime && item.endTime ? clockToMinutes(item.endTime) - clockToMinutes(item.startTime) : 0)),
      0,
    ),
  };
}

export { complexityOf };
