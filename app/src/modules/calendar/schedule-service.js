/**
 * 日程服务（**时段**粒度：某一天的具体起止时刻）。
 *
 * 领域边界（2026-10 重做后）：
 * - **日程 = 时段**：`date` + `startTime`(+`endTime`)，用于上课、开会、自习；
 *   `startTime` 必填，**没有完成态**（「完成一场会议」没有意义）。
 * - 待办 = {@link TodoService}：只有截止日，有 `completed`。
 * - 日历事件 = {@link EventService}：日期/日期区间，也没有完成态。
 *
 * 历史包袱清理：旧模型把「待办」塞进本集合（`allDay` + `status` + 克隆式顺延）冒充，
 * 于是 `allDay=true` 的日程同时是待办、日程还能被标记 `done`。现在三件事各归其位，
 * 本文件里不再出现 `allDay` / `status` / `rollover` / `setStatus`。
 *
 * 唯一一处对历史数据的例外是 `list()` 里的**防御性过滤**：早期版本写入的
 * 日期锚点行（`allDay: true`）既不是日程也不该被统计，直接跳过；
 * 正式迁移见 module.js 的 `migrateLegacyAnchors()`（启动时把这类行转成待办）。
 */

import { HttpError } from '../../core/http/router.js';
import { clockToMinutes, todayKey } from '../../shared/time.js';
import { SCHEDULE_CATEGORIES } from '../../shared/constants.js';
import { expandDates } from './recurrence.js';
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
  'priority',
  'estimatedMinutes',
  'location',
  'tags',
  'reminders',
  'repeat',
  'eventId',
  'source',
  'externalId',
];

/**
 * 早期版本用 `allDay: true` 表示「日期锚点 = 待办」。这类行不是日程：
 * 既不能参与时段统计，也不该出现在任何日历视图里。启动时会迁移成待办，
 * 这里再挡一道，保证迁移前 / 迁移失败的库也不会算错。
 */
function isLegacyAnchor(item) {
  return item?.allDay === true;
}

function normalize(rawInput, { partial = false } = {}) {
  // 兼容 dschat 2 风格入参（snake_case、扁平 repeat、宽松日期/时刻）
  const input = normalizeAliases(rawInput);
  const data = {};

  if (input.title !== undefined) data.title = requireTitle(input.title);
  else if (!partial) data.title = requireTitle(undefined);

  if (input.date !== undefined) data.date = requireDate(input.date, 'date');
  else if (!partial) data.date = requireDate(undefined, 'date');

  // startTime 是日程的存在条件：新建必填，更新时若被显式清空也要报错
  if (input.startTime !== undefined) data.startTime = requireClock(input.startTime, 'startTime');
  else if (!partial) data.startTime = requireClock(undefined, 'startTime');

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

  /**
   * 时段日程查询。支持 `date` / `from` / `to` / `category` / `priority` / `keyword` / `limit`。
   *
   * 只会返回「有 startTime」的记录：没有起始时刻的历史遗留条目（早期版本写入的
   * 日期锚点）不是日程，日历视图与统计都不该看见它们。
   */
  list({ date, from, to, category, keyword, priority, limit } = {}) {
    // 早期版本的日期锚点行（allDay: true）不是日程：既不返回，也不进统计
    let items = this.collection.all().filter((item) => !isLegacyAnchor(item) && Boolean(item.startTime));
    if (date) items = items.filter((item) => item.date === date);
    if (from) items = items.filter((item) => item.date >= from);
    if (to) items = items.filter((item) => item.date <= to);
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
    items.sort((a, b) =>
      a.date === b.date
        ? String(a.startTime ?? '').localeCompare(String(b.startTime ?? ''))
        : a.date.localeCompare(b.date),
    );
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
    for (const item of this.list(filters)) {
      const dates = expandDates({ anchorKey: item.date, repeat: item.repeat, from, to });
      for (const date of dates) {
        occurrences.push({
          id: `${item.id}:${date}`,
          scheduleId: item.id,
          occurrenceDate: date,
          title: item.title,
          category: item.category,
          priority: item.priority,
          startTime: item.startTime,
          endTime: item.endTime,
          estimatedMinutes: item.estimatedMinutes,
          complexity: complexityOf(item.estimatedMinutes),
          location: item.location,
          isRepeatInstance: date !== item.date,
        });
      }
    }
    occurrences.sort((a, b) =>
      a.occurrenceDate === b.occurrenceDate
        ? String(a.startTime ?? '').localeCompare(String(b.startTime ?? ''))
        : a.occurrenceDate.localeCompare(b.occurrenceDate),
    );
    return occurrences;
  }

  /** 某日：时段日程 + 当天截止的待办。 */
  agenda({ date } = {}) {
    const day = date ? requireDate(date, 'date') : todayKey();
    const schedules = this.range({ from: day, to: day });
    const todos = this.store.todos ? this.store.todos.all().filter((item) => item.deadline === day) : [];
    return {
      date: day,
      schedules,
      todos,
      stats: {
        schedules: schedules.length,
        todos: todos.length,
        plannedMinutes: schedules.reduce((sum, item) => sum + (item.estimatedMinutes ?? durationOf(item)), 0),
      },
    };
  }

  /** 与其他日程的时间冲突（同日、时段相交）。仅提示，不阻断写入。 */
  conflictsFor(candidate) {
    if (!candidate?.date || !candidate.startTime) return [];
    const sameDay = this.range({ from: candidate.date, to: candidate.date }).filter(
      (occurrence) => occurrence.scheduleId !== candidate.id,
    );
    const start = clockToMinutes(candidate.startTime);
    const end = candidate.endTime ? clockToMinutes(candidate.endTime) : start + 60;
    return sameDay.filter((item) => {
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

  /** 区间统计：只统计时段日程（完成率属于待办，见 `/todos` 的 `stats`）。 */
  stats({ from, to } = {}) {
    // list() 已经排除了历史日期锚点行，所以这里天然只统计时段日程
    const items = this.list({ from, to });
    const minutes = items.reduce((sum, item) => sum + (item.estimatedMinutes ?? durationOf(item)), 0);
    return {
      from,
      to,
      total: items.length,
      plannedMinutes: minutes,
      plannedHours: Number((minutes / 60).toFixed(1)),
    };
  }
}

function durationOf(item) {
  if (!item.startTime || !item.endTime) return 0;
  return Math.max(0, clockToMinutes(item.endTime) - clockToMinutes(item.startTime));
}

export { complexityOf };
