/**
 * 分类服务（Category）：日程与日历事件各自一套可编辑的分类。
 *
 * 背景：分类原先硬编码在 `shared/constants.js`（后端）与 `kit/labels.js`（渲染层）里，
 * 用户既不能改名字也不能改颜色。现在分类是**数据**，而且是**两个集合**：
 *
 *   scheduleCategories → data/schedule-categories.json  （日程分类）
 *   eventCategories    → data/event-categories.json     （日历事件分类）
 *
 * 为什么拆两张表：两个 kind 本来就各管各的，而它们**共用** `study` / `exam` / `other`
 * 这些名字。合在一张表里（集合以 id 为唯一键）记录 id 就不再是「写进日程的那个值」了，
 * 得引入 key/value 两层间接。拆开之后：
 *
 *   记录的 `id` **就是**写进日程/事件的 `category` 值。
 *
 * 内置 id 与旧常量完全一致（schedule: class/study/meeting/exam/activity/other，
 * event: study/exam/holiday/anniversary/deadline/other），所以思源学堂同步、
 * dschat 兼容层、ICS、以及历史数据里的 `category` 全都不受影响。
 *
 * 两条不变式：
 * 1. `other` 是 `locked`（不可删除），其余内置项可以改名/改色；
 * 2. 删分类不丢数据：在用记录改成同 kind 的 `other`，并返回 `reassigned` 条数。
 *
 * 校验语义（重要）：各服务写库时用 `resolve(kind, id)` —— id 存在就用它，
 * 没传或不存在则**静默兜底到 `other`**。分类写错不该让用户的日程写不进去
 * （dschat 兼容层的 `category` 是自由文本，必须容错）。
 */

import { HttpError } from '../../core/http/router.js';
import { normalizeColor } from './schema.js';

const KINDS = ['schedule', 'event'];
const MAX_LABEL = 12;
const ORDER_STEP = 10;

/** kind -> store 上的集合名。 */
const COLLECTIONS = { schedule: 'scheduleCategories', event: 'eventCategories' };
/** kind -> 记录落在哪个业务集合（统计 inUse / 删除时改派用）。 */
const RECORDS = { schedule: 'schedules', event: 'events' };

/**
 * 内置分类（首次启动播种：**两个集合各自为空时**才写）。
 * id 必须与 `shared/constants.js` 的旧常量完全一致。颜色取自设计令牌。
 */
export const DEFAULT_CATEGORIES = {
  schedule: [
    { id: 'class', label: '上课', color: '#6c8cff', order: 10 },
    { id: 'study', label: '学习', color: '#5cdb8b', order: 20 },
    { id: 'meeting', label: '会议', color: '#c792ea', order: 30 },
    { id: 'exam', label: '考试', color: '#ff6b7a', order: 40 },
    { id: 'activity', label: '活动', color: '#ffb86c', order: 50 },
    { id: 'other', label: '其它', color: '#83838f', order: 60, locked: true },
  ],
  event: [
    { id: 'study', label: '学习', color: '#5cdb8b', order: 10 },
    { id: 'exam', label: '考试', color: '#ff6b7a', order: 20 },
    { id: 'holiday', label: '假期', color: '#ffb86c', order: 30 },
    { id: 'anniversary', label: '纪念日', color: '#c792ea', order: 40 },
    { id: 'deadline', label: '截止', color: '#ff6b7a', order: 50 },
    { id: 'other', label: '其它', color: '#83838f', order: 60, locked: true },
  ],
};

/** 分类名：必填、去空白、≤12 字。 */
function requireLabel(value, field = 'label') {
  if (typeof value !== 'string' || !value.trim()) {
    throw HttpError.badRequest(`字段 ${field} 必填且不能为空`, { field });
  }
  const label = value.trim();
  if (label.length > MAX_LABEL) {
    throw HttpError.badRequest(`字段 ${field} 长度不能超过 ${MAX_LABEL}`, { field });
  }
  return label;
}

function requireKind(value) {
  if (!KINDS.includes(value)) {
    throw HttpError.badRequest(`字段 kind 必须是 ${KINDS.join(' / ')} 之一`, { field: 'kind' });
  }
  return value;
}

export class CategoryService {
  constructor({ store, broadcast = () => {} }) {
    this.store = store;
    this.broadcast = broadcast;
  }

  collectionOf(kind) {
    return this.store[COLLECTIONS[requireKind(kind)]];
  }

  /** 首次启动播种：每个集合各自为空时才写，用户改过的一个都不覆盖。 */
  async ensureDefaults() {
    let seeded = 0;
    for (const kind of KINDS) {
      const collection = this.collectionOf(kind);
      if (collection.all().length) continue;
      for (const item of DEFAULT_CATEGORIES[kind]) {
        await collection.insert({ ...item, builtin: true, locked: Boolean(item.locked) });
        seeded += 1;
      }
    }
    return { seeded };
  }

  /** 对外形状：补上由集合推出的 `kind` 与只读的 `inUse`。 */
  view(kind, item) {
    return {
      id: item.id,
      kind,
      label: item.label,
      color: item.color,
      order: item.order,
      builtin: Boolean(item.builtin),
      locked: Boolean(item.locked),
      inUse: this.countInUse(kind, item.id),
    };
  }

  /**
   * 分类列表（按 order 升序，`other` 因 order 最大天然在最后）。
   * 不传 kind 时返回两个集合的并集。
   */
  list({ kind } = {}) {
    const kinds = kind ? [requireKind(kind)] : KINDS;
    const out = [];
    for (const one of kinds) {
      const items = this.collectionOf(one).all();
      items.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || String(a.label).localeCompare(String(b.label)));
      out.push(...items.map((item) => this.view(one, item)));
    }
    return out;
  }

  /** 该分类下有多少条记录在用（含历史遗留行）。 */
  countInUse(kind, id) {
    return this.store[RECORDS[kind]].all().filter((record) => (record.category ?? 'other') === id).length;
  }

  /**
   * 写库时的分类归一化：id 存在就用它（**写进记录的就是分类 id 本身**），
   * 没传 / 不存在则兜底到 `other`（不抛错）。同步方法：读内存集合。
   */
  resolve(kind, id) {
    if (id === undefined || id === null || id === '') return 'other';
    const wanted = String(id);
    return this.collectionOf(kind).get(wanted) ? wanted : 'other';
  }

  /** 某个 kind 的全部合法 id（= 可写进记录的值）。 */
  idsOf(kind) {
    return this.collectionOf(kind)
      .all()
      .map((item) => item.id);
  }

  /**
   * 按 id 找分类。两个集合共用 `study` / `exam` / `other` 这些内置 id，
   * 因此**带 kind 才无歧义**；不带 kind 时若两边都存在，直接报错让调用方说清楚。
   */
  locate(id, kind) {
    if (kind) {
      const resolved = requireKind(kind);
      const item = this.collectionOf(resolved).get(id);
      if (!item) throw HttpError.notFound(`分类不存在: ${id}`);
      return { kind: resolved, item };
    }
    const hits = KINDS.filter((one) => this.collectionOf(one).get(id));
    if (!hits.length) throw HttpError.notFound(`分类不存在: ${id}`);
    if (hits.length > 1) {
      throw HttpError.badRequest(`分类 id ${id} 在日程与事件里都存在，请带 kind 参数指定其一`, { field: 'kind' });
    }
    return { kind: hits[0], item: this.collectionOf(hits[0]).get(id) };
  }

  get(id, kind) {
    const found = this.locate(id, kind);
    return this.view(found.kind, found.item);
  }

  /**
   * 校验并归一「新建分类」的输入，但**不写库**。
   *
   * 为什么单独拆出来：AI 草稿的 dryRun 预览必须跑与真写**完全同一套**校验，
   * 否则确认卡上看着没问题、用户点确认才 400。复制一份 label/color/order 规则
   * 迟早会漂移，所以 create() 也复用本方法。REST 路由的行为不受影响。
   */
  prepareCreate(input = {}) {
    const kind = requireKind(input.kind);
    const label = requireLabel(input.label);
    const color = normalizeColor(input.color, 'color');
    if (!color) throw HttpError.badRequest('字段 color 必填且必须是 #RRGGBB 形式的颜色', { field: 'color' });

    const collection = this.collectionOf(kind);
    const sameKind = collection.all();
    const order =
      input.order !== undefined && input.order !== null && input.order !== ''
        ? Number(input.order)
        : Math.max(0, ...sameKind.filter((item) => !item.locked).map((item) => item.order ?? 0)) + ORDER_STEP;

    return {
      kind,
      data: { label, color, order: Number.isFinite(order) ? order : 100, builtin: false, locked: false },
    };
  }

  async create(input = {}) {
    const { kind, data } = this.prepareCreate(input);
    const created = await this.collectionOf(kind).insert(data);
    this.broadcast({ type: 'data_changed', payload: { target: 'category', action: 'create', kind, id: created.id } });
    return this.view(kind, created);
  }

  /**
   * 校验并归一「修改分类」的 patch，但**不写库**（同样给 AI 的 dryRun 预览用）。
   * 返回 `kind` 与归一后的 `data`；`update()` 复用同一份判断。
   */
  prepareUpdate(id, patch = {}, { kind } = {}) {
    const found = this.locate(id, kind);
    const data = {};
    if (patch.kind !== undefined && patch.kind !== found.kind) {
      throw HttpError.badRequest('字段 kind 不可修改（分类属于日程或事件其一）', { field: 'kind' });
    }
    if (patch.label !== undefined) data.label = requireLabel(patch.label);
    if (patch.color !== undefined) {
      const color = normalizeColor(patch.color, 'color');
      if (!color) throw HttpError.badRequest('字段 color 必须是 #RRGGBB 形式的颜色', { field: 'color' });
      data.color = color;
    }
    if (patch.order !== undefined && patch.order !== null && patch.order !== '') {
      const order = Number(patch.order);
      if (!Number.isFinite(order)) throw HttpError.badRequest('字段 order 必须是数字', { field: 'order' });
      data.order = order;
    }
    return { kind: found.kind, item: found.item, data };
  }

  async update(id, patch = {}, { kind } = {}) {
    const prepared = this.prepareUpdate(id, patch, { kind });
    const updated = await this.collectionOf(prepared.kind).update(id, prepared.data);
    this.broadcast({ type: 'data_changed', payload: { target: 'category', action: 'update', kind: prepared.kind, id } });
    return this.view(prepared.kind, updated);
  }

  /**
   * 删除分类：**不丢数据** —— 把在用记录改成同 kind 的 `other`，返回 reassigned 条数。
   * `locked`（内置的 `other`）不可删除。
   */
  async remove(id, { kind } = {}) {
    const found = this.locate(id, kind);
    if (found.item.locked) {
      throw HttpError.badRequest(`「${found.item.label}」是兜底分类，不能删除（可以改名或改色）`, { field: 'id' });
    }
    const records = this.store[RECORDS[found.kind]];
    const affected = records.all().filter((record) => (record.category ?? 'other') === id);
    for (const record of affected) {
      await records.update(record.id, { category: 'other' });
    }
    await this.collectionOf(found.kind).remove(id);
    this.broadcast({
      type: 'data_changed',
      payload: { target: 'category', action: 'delete', kind: found.kind, id, reassigned: affected.length },
    });
    if (affected.length) {
      this.broadcast({
        type: 'data_changed',
        payload: { target: found.kind, action: 'reassign', count: affected.length },
      });
    }
    return { deleted: true, reassigned: affected.length };
  }
}
