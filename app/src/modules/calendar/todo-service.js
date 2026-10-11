/**
 * 待办服务（Todo）。
 *
 * 领域模型（对齐 PotatoCalendar 的 `TodoItem`）：
 * - **待办是独立实体**：`deadline`（截止日）+ 预估工时 + 优先级 + 完成态；
 * - **日程是时段**：有起止时刻，没有完成态；
 * - **日历事件是日期/区间粒度**：假期、考试周、纪念日，也没有完成态。
 *
 * 与旧实现的区别：待办不再用 `Schedule` 的 `allDay` + `status` 冒充。旧模型里
 * 「完成」这种语义被硬塞进日程，导致「完成一场会议」这种无意义操作；现在
 * `completed` 只存在于本服务，日程与事件都没有完成态。
 *
 * 派生字段（`isOverdue` / `isToday` / `daysRemaining` / `complexity` / `complexityLabel`）
 * 只出现在响应里，不落库：它们随「今天」变化，存下来必然过期。
 */

import { HttpError } from '../../core/http/router.js';
import { addDays, todayKey } from '../../shared/time.js';
import { enumValue, intValue, optionalText, pickDefined, requireTitle, stringArray } from '../../core/validate.js';
import { complexityOfHours, numberValue, requireDate } from './schema.js';
import { isoWeekday } from './recurrence.js';

/** 复杂度中文标签（阈值见 schema.complexityOfHours，与 PotatoCalendar 一致）。 */
export const COMPLEXITY_LABEL = { simple: '简单', normal: '一般', complex: '复杂', heavy: '繁琐' };

const SOURCES = ['manual', 'command', 'ai', 'import'];
/** 预估工时上限（30 天 × 24 小时），足够表达任何学习任务，同时挡住脏数据。 */
const MAX_ESTIMATED_HOURS = 24 * 30;
/** 可写字段白名单：更新时用「当前记录 + patch」重建，避免未知字段落库。 */
const EDITABLE = [
  'title',
  'deadline',
  'estimatedHours',
  'priority',
  'completed',
  'completedAt',
  'description',
  'tags',
  'source',
  'externalId',
  'rolledFrom',
];

/**
 * 入参别名归一化。
 *
 * 刻意**不复用** compat.js 的 `normalizeAliases`：那张表属于 dschat 2 的单日事件形状，
 * 它把 `deadline` 映射成 `date`、把布尔的 `completed` 映射成 `status`，
 * 对「待办」来说两者都是错的方向（待办的截止日就写作 `deadline`，完成态就是布尔）。
 */
function normalizeInput(rawInput = {}) {
  const out = {};
  for (const [key, value] of Object.entries(rawInput)) {
    const mapped =
      key === 'due_date' || key === 'dueDate' || key === 'date'
        ? 'deadline'
        : key === 'estimated_hours' || key === 'hours'
          ? 'estimatedHours'
          : key === 'done'
            ? 'completed'
            : key === 'notes' || key === 'note'
              ? 'description'
              : key;
    out[mapped] = value;
  }
  return out;
}

/** 布尔字段：接受 true/false 与 'true'/'false'/'1'/'0'（HTTP query 里都是字符串）。 */
function booleanValue(value, field, { optional = true, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return fallback;
    throw HttpError.badRequest(`字段 ${field} 必填`, { field });
  }
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  throw HttpError.badRequest(`字段 ${field} 不合法：必须是布尔值`, { field });
}

function normalize(rawInput, { partial = false } = {}) {
  const input = normalizeInput(rawInput);
  const data = {};

  if (input.title !== undefined) data.title = requireTitle(input.title);
  else if (!partial) data.title = requireTitle(undefined);

  if (input.deadline !== undefined) data.deadline = requireDate(input.deadline, 'deadline');
  else if (!partial) data.deadline = requireDate(undefined, 'deadline');

  if (input.estimatedHours !== undefined) {
    data.estimatedHours = numberValue(input.estimatedHours, 'estimatedHours', {
      min: 0,
      max: MAX_ESTIMATED_HOURS,
      optional: true,
      fallback: 1,
    });
  } else if (!partial) data.estimatedHours = 1;

  if (input.priority !== undefined) {
    data.priority = intValue(input.priority, 'priority', { min: 0, max: 2, optional: true, fallback: 0 });
  } else if (!partial) data.priority = 0;

  if (input.completed !== undefined) data.completed = booleanValue(input.completed, 'completed');
  else if (!partial) data.completed = false;
  // completedAt 允许 null（显式「没有完成时间」），因此这里不能只判断 undefined
  if (input.completedAt === null) data.completedAt = null;

  if (input.description !== undefined) data.description = optionalText(input.description, 'description') ?? '';
  if (input.tags !== undefined) data.tags = stringArray(input.tags, 'tags') ?? [];
  else if (!partial) data.tags = [];

  if (input.source !== undefined) {
    data.source = enumValue(input.source, SOURCES, 'source', { optional: true, fallback: 'manual' });
  } else if (!partial) data.source = 'manual';

  if (input.externalId !== undefined) data.externalId = input.externalId === null ? null : String(input.externalId);
  // completedAt 由服务在「完成态变化」时统一维护，但更新时必须能原样带过（否则改标题会刷新完成时间）
  if (input.completedAt !== undefined) data.completedAt = input.completedAt;
  if (input.rolledFrom !== undefined) data.rolledFrom = input.rolledFrom;

  return data;
}

/** 只出现在响应里的派生字段。 */
function decorate(item, today) {
  const hours = item.estimatedHours ?? 1;
  const complexity = complexityOfHours(hours);
  return {
    ...item,
    // 取消完成时显式落 null（集合层会把 undefined 当「不修改」）
    completedAt: item.completedAt ?? null,
    isOverdue: !item.completed && item.deadline < today,
    isToday: item.deadline === today,
    daysRemaining: Math.round((new Date(item.deadline) - new Date(today)) / 86400000),
    complexity,
    complexityLabel: COMPLEXITY_LABEL[complexity] ?? '',
  };
}

export class TodoService {
  constructor({ store, broadcast = () => {} }) {
    this.store = store;
    this.broadcast = broadcast;
  }

  get collection() {
    return this.store.todos;
  }

  /**
   * 待办列表。
   *
   * @param {object} [filters]
   * @param {string} [filters.date]       截止日 = 该日
   * @param {string} [filters.from]       截止日 >= from
   * @param {string} [filters.to]         截止日 <= to
   * @param {boolean|string} [filters.completed] 完成态精确过滤
   * @param {number|string} [filters.priority]   优先级精确过滤
   * @param {boolean|string} [filters.overdue]   true = 未完成且 deadline < 今天
   * @param {string} [filters.keyword]    标题 / 备注 / 标签模糊匹配
   * @param {number|string} [filters.limit]
   */
  list({ date, from, to, completed, priority, overdue, keyword, limit } = {}) {
    const today = todayKey();
    let items = this.collection.all();

    if (date) items = items.filter((item) => item.deadline === date);
    if (from) items = items.filter((item) => item.deadline >= from);
    if (to) items = items.filter((item) => item.deadline <= to);
    if (completed !== undefined && completed !== null && completed !== '') {
      const wanted = booleanValue(completed, 'completed');
      items = items.filter((item) => Boolean(item.completed) === wanted);
    }
    if (priority !== undefined && priority !== null && priority !== '') {
      items = items.filter((item) => item.priority === Number(priority));
    }
    if (booleanValue(overdue, 'overdue', { optional: true, fallback: false })) {
      items = items.filter((item) => !item.completed && item.deadline < today);
    }
    if (keyword) {
      const kw = String(keyword).toLowerCase();
      items = items.filter(
        (item) =>
          item.title.toLowerCase().includes(kw) ||
          (item.description ?? '').toLowerCase().includes(kw) ||
          (item.tags ?? []).some((tag) => tag.toLowerCase().includes(kw)),
      );
    }

    items.sort((a, b) => {
      if (a.deadline !== b.deadline) return a.deadline.localeCompare(b.deadline);
      if (Boolean(a.completed) !== Boolean(b.completed)) return a.completed ? 1 : -1;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.title.localeCompare(b.title);
    });

    const decorated = items.map((item) => decorate(item, today));
    // 不传 limit 就不截断（与旧 /schedules 行为一致）；日历聚合拿全量自己分桶
    const capped = Number(limit);
    return limit !== undefined && limit !== '' && Number.isFinite(capped) && capped > 0
      ? decorated.slice(0, capped)
      : decorated;
  }

  /**
   * 未完成待办，按截止日升序（等价 PotatoCalendar 的 `get_upcoming`）。
   * 首页/日视图右侧面板用它回答「接下来要做什么」。
   */
  upcoming({ limit } = {}) {
    const items = this.list({ completed: false });
    // 缺省 50 条；显式传 limit=0（或负数）表示「不限制」
    const capped = limit === undefined || limit === '' ? 50 : Number(limit);
    return Number.isFinite(capped) && capped > 0 ? items.slice(0, capped) : items;
  }

  /** 统计：以「过滤后的集合」为准（不受 limit 影响），口径见 docs/接口文档.md。 */
  stats(items) {
    const total = items.length;
    const completed = items.filter((item) => item.completed).length;
    const pending = total - completed;
    const overdue = items.filter((item) => item.isOverdue).length;
    const plannedHours = Number(items.reduce((sum, item) => sum + (item.estimatedHours ?? 1), 0).toFixed(1));
    return {
      total,
      completed,
      pending,
      overdue,
      completionRate: total ? Number(((completed / total) * 100).toFixed(1)) : 0,
      plannedHours,
    };
  }

  get(id) {
    const item = this.collection.get(id);
    if (!item) throw HttpError.notFound(`待办不存在: ${id}`);
    return decorate(item, todayKey());
  }

  /** 供 /calendar 聚合：按截止日分桶（带派生字段，前端直接用）。 */
  groupByDeadline({ from, to } = {}) {
    const buckets = new Map();
    for (const item of this.list({ from, to })) {
      if (!buckets.has(item.deadline)) buckets.set(item.deadline, []);
      buckets.get(item.deadline).push(item);
    }
    return buckets;
  }

  async create(input) {
    const data = normalize(input);
    if (data.completed && !data.completedAt) data.completedAt = new Date().toISOString();
    const created = await this.collection.insert(data);
    this.broadcast({ type: 'data_changed', payload: { target: 'todo', action: 'create', id: created.id } });
    return decorate(created, todayKey());
  }

  /** 只校验、不落库（与 create 同一条归一化路径），供 dryRun 预览与 AI 草稿预校验。 */
  preview(input) {
    const data = normalize(input);
    if (data.completed && !data.completedAt) data.completedAt = new Date().toISOString();
    return data;
  }

  async update(id, patch) {
    const current = this.get(id);
    const merged = { ...pickDefined(current, EDITABLE), ...normalizeInput(patch) };
    const data = normalize(merged, { partial: false });
    // 完成态与 completedAt 必须一起变：勾选时写时间戳，取消勾选时清成 null
    // （必须是 null 而不是 undefined：JSON 集合的合并会把 undefined 当成「不带这个字段」）
    if (data.completed) data.completedAt = data.completedAt ?? new Date().toISOString();
    else data.completedAt = null;
    const updated = await this.collection.update(id, data);
    this.broadcast({ type: 'data_changed', payload: { target: 'todo', action: 'update', id } });
    return decorate(updated, todayKey());
  }

  /** 勾选 / 取消勾选。语义唯一入口，避免各处自己写 completedAt。 */
  async setCompleted(id, completed) {
    const wanted = booleanValue(completed, 'completed', { optional: false });
    return this.update(id, { completed: wanted, completedAt: wanted ? new Date().toISOString() : null });
  }

  async remove(id) {
    this.get(id);
    await this.collection.remove(id);
    this.broadcast({ type: 'data_changed', payload: { target: 'todo', action: 'delete', id } });
    return { id, deleted: true };
  }

  /**
   * 顺延未完成待办：把截止日早于目标周一的未完成待办，挪到目标周的**同一星期几**；
   * 若那个日期已经过去（早于今天），则落到目标周一。
   *
   * 与旧「顺延日程」的关键差异：待办是**同一条记录的截止日平移**，不克隆新记录、
   * 也不会把原记录标记成什么状态（待办只有 completed 一个布尔）。
   * `rolledFrom.deadline` 保留「这次顺延前它原本是哪天到期」，便于追溯。
   *
   * @param {object} [options]
   * @param {string} [options.weekStart] 目标周的周一（缺省 = 本周一）
   */
  async rollover({ weekStart } = {}) {
    const today = todayKey();
    const anchor = weekStart ? requireDate(weekStart, 'weekStart') : addDays(today, 1 - isoWeekday(today));
    if (isoWeekday(anchor) !== 1) {
      throw HttpError.badRequest('字段 weekStart 不合法：必须是周一', { field: 'weekStart' });
    }

    const candidates = this.collection
      .all()
      .filter((item) => !item.completed && item.deadline < anchor)
      .sort((a, b) => a.deadline.localeCompare(b.deadline));
    if (!candidates.length) return { weekStart: anchor, moved: 0, items: [] };

    const moved = [];
    for (const item of candidates) {
      const sameWeekday = addDays(anchor, isoWeekday(item.deadline) - 1);
      // 目标任何分支都不得早于今天：否则「顺延到本周」会把逾期待办挪到本周一（仍是过去），
      // 等于没顺延。同星期几已过 -> 目标周一；目标周一也过了（本周已开始）-> 今天。
      const target = sameWeekday >= today ? sameWeekday : anchor >= today ? anchor : today;
      await this.collection.update(item.id, {
        deadline: target,
        rolledFrom: { deadline: item.deadline },
      });
      moved.push({ id: item.id, title: item.title, from: item.deadline, to: target });
    }
    this.broadcast({ type: 'data_changed', payload: { target: 'todo', action: 'rollover', count: moved.length } });
    return { weekStart: anchor, moved: moved.length, items: moved };
  }
}
