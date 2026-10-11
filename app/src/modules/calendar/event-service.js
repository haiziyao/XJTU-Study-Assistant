/**
 * 日历事件服务（日期粒度：全天或跨天区间）。
 *
 * 与 PotatoCalendar 的 events.json 对应，但做了三处修正：
 * 1. 字段结构化：`event_date/start_time/end_time/repeat_days` -> `startDate/endDate/repeat{...}`；
 * 2. 重复规则支持结束条件（date / count），可表达「今年的每周一」；
 * 3. id 统一为 UUID，写入原子化，不再按时间戳前缀区分类型。
 */

import { HttpError } from '../../core/http/router.js';
import { rangeOverlaps } from '../../shared/time.js';
import { expandDates } from './recurrence.js';
import { enumValue, optionalText, pickDefined, requireTitle, stringArray } from '../../core/validate.js';
import { normalizeRepeat, optionalDate, requireDate } from './schema.js';
import { normalizeAliases } from './compat.js';

const EDITABLE = [
  'title',
  'description',
  'category',
  'startDate',
  'endDate',
  'allDay',
  'color',
  'tags',
  'repeat',
  'source',
  'externalId',
];

function normalize(rawInput, { partial = false, categories = null } = {}) {
  // 兼容 dschat 2 风格入参（snake_case、扁平 repeat、宽松日期）
  const input = normalizeAliases(rawInput);
  const data = {};
  if (input.title !== undefined) data.title = requireTitle(input.title);
  else if (!partial) data.title = requireTitle(undefined);

  if (input.startDate !== undefined) data.startDate = requireDate(input.startDate, 'startDate');
  else if (!partial) data.startDate = requireDate(undefined, 'startDate');

  if (input.endDate !== undefined) data.endDate = optionalDate(input.endDate, 'endDate');
  if (input.description !== undefined) data.description = optionalText(input.description, 'description') ?? '';
  // 分类来自可编辑的注册表：id 存在就用它，没传/不存在则静默兜底到 other
  if (input.category !== undefined) {
    data.category = categories ? categories.resolve('event', input.category) : 'other';
  } else if (!partial) data.category = 'other';
  if (input.allDay !== undefined) data.allDay = Boolean(input.allDay);
  else if (!partial) data.allDay = true;
  if (input.color !== undefined) data.color = optionalText(input.color, 'color', 32);
  if (input.tags !== undefined) data.tags = stringArray(input.tags, 'tags') ?? [];
  if (input.repeat !== undefined) data.repeat = normalizeRepeat(input.repeat);
  else if (!partial) data.repeat = normalizeRepeat(undefined);
  if (input.source !== undefined) data.source = enumValue(input.source, ['manual', 'command', 'ai', 'import'], 'source', {
    optional: true,
    fallback: 'manual',
  });
  else if (!partial) data.source = 'manual';
  if (input.externalId !== undefined) data.externalId = optionalText(input.externalId, 'externalId', 128);

  if (data.startDate && data.endDate && data.endDate < data.startDate) {
    throw HttpError.badRequest('字段 endDate 不合法：不能早于 startDate', { field: 'endDate' });
  }
  return data;
}

export class EventService {
  constructor({ store, broadcast = () => {}, categories = null }) {
    this.store = store;
    this.broadcast = broadcast;
    /** 分类注册表（可编辑）；缺省时一律落到 other。 */
    this.categories = categories;
  }

  get collection() {
    return this.store.events;
  }

  /** 原始记录查询（按 startDate 升序）。 */
  list({ from, to, category, keyword, limit } = {}) {
    let items = this.collection.all();
    if (from) items = items.filter((item) => item.endDate >= from);
    if (to) items = items.filter((item) => item.startDate <= to);
    if (category) items = items.filter((item) => item.category === category);
    if (keyword) {
      const kw = String(keyword).toLowerCase();
      items = items.filter(
        (item) =>
          item.title.toLowerCase().includes(kw) ||
          (item.description ?? '').toLowerCase().includes(kw) ||
          (item.tags ?? []).some((tag) => tag.toLowerCase().includes(kw)),
      );
    }
    items.sort((a, b) => (a.startDate === b.startDate ? a.title.localeCompare(b.title) : a.startDate.localeCompare(b.startDate)));
    if (limit) items = items.slice(0, Number(limit));
    return items;
  }

  get(id) {
    const item = this.collection.get(id);
    if (!item) throw HttpError.notFound(`日历事件不存在: ${id}`);
    return item;
  }

  /**
   * 查询区间内的展开结果（每个月历格子要用的数据）。
   * 非重复事件按区间铺满每一天，重复事件按规则命中。
   */
  range({ from, to, category, keyword, limit } = {}) {
    if (!from || !to) throw HttpError.badRequest('from 与 to 为必填（YYYY-MM-DD）');
    if (to < from) throw HttpError.badRequest('to 不能早于 from');
    const occurrences = [];
    for (const item of this.list({ category, keyword })) {
      if (!rangeOverlaps(item.startDate, item.endDate, from, to) && (!item.repeat || item.repeat.type === 'none')) continue;
      const dates = expandDates({
        anchorKey: item.startDate,
        endKey: item.endDate,
        repeat: item.repeat,
        from,
        to,
      });
      for (const date of dates) {
        occurrences.push({
          id: `${item.id}:${date}`,
          eventId: item.id,
          occurrenceDate: date,
          title: item.title,
          category: item.category,
          color: item.color,
          allDay: item.allDay,
          isRepeatInstance: date !== item.startDate,
          repeat: item.repeat,
          tags: item.tags ?? [],
        });
      }
    }
    occurrences.sort((a, b) =>
      a.occurrenceDate === b.occurrenceDate ? a.title.localeCompare(b.title) : a.occurrenceDate.localeCompare(b.occurrenceDate),
    );
    return limit ? occurrences.slice(0, Number(limit)) : occurrences;
  }

  async create(input) {
    const data = normalize(input, { categories: this.categories });
    if (!data.endDate) data.endDate = data.startDate;
    const created = await this.collection.insert(data);
    this.broadcast({ type: 'data_changed', payload: { target: 'event', action: 'create', id: created.id } });
    return created;
  }

  /** 只校验、不落库（与 create 同一条归一化路径），供 dryRun 预览与 AI 草稿预校验。 */
  preview(input) {
    const data = normalize(input, { categories: this.categories });
    if (!data.endDate) data.endDate = data.startDate;
    return data;
  }

  async update(id, patch) {
    const current = this.get(id);
    const data = normalize({ ...pickDefined(current, EDITABLE), ...patch }, { partial: false, categories: this.categories });
    if (!data.endDate) data.endDate = data.startDate;
    const updated = await this.collection.update(id, data);
    this.broadcast({ type: 'data_changed', payload: { target: 'event', action: 'update', id } });
    return updated;
  }

  async remove(id) {
    this.get(id);
    await this.collection.remove(id);
    this.broadcast({ type: 'data_changed', payload: { target: 'event', action: 'delete', id } });
    return { id, deleted: true };
  }

  /** 供 /calendar 聚合接口使用：按日期分桶。 */
  groupByDate(range, filters = {}) {
    const buckets = new Map();
    for (const occurrence of this.range({ ...range, ...filters })) {
      if (!buckets.has(occurrence.occurrenceDate)) buckets.set(occurrence.occurrenceDate, []);
      buckets.get(occurrence.occurrenceDate).push(occurrence);
    }
    return buckets;
  }
}
