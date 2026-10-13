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
 * 入参里**允许出现**的字段名（canonical 名，别名先过 `mapFieldName`）。
 *
 * - `estimatedMinutes` 不落库（会被换算成 `estimatedHours`），但必须在这里：它是**日程**的字段，
 *   而提示词、前端、模型都容易顺手把它写进待办（真机缺陷 S3 就是这么来的）。
 * - `id` 允许出现但**被忽略**：模型给 update 草稿时常把 id 一并塞进 `fields`，
 *   拿它定位可以，写进数据不行（那是另一条记录的主键，落进文件就是脏数据）。
 */
const KNOWN_FIELDS = new Set([...EDITABLE, 'estimatedMinutes', 'id']);

/** 报错时摆在最前面的字段清单（人/模型照着改一次就能对）。 */
const KNOWN_FIELD_LIST =
  'title / deadline / estimatedHours（小时，可小数；也收 estimatedMinutes，整数分钟） / priority / completed / description / tags';

/**
 * 单个别名的归一化（不认识的键原样返回）。
 * `normalizeInput`（取值）与 `assertKnownFields`（判断认不认识）共用这一张表：
 * 各写一份的话，迟早出现"别名能转换、却被未知字段检查拦下"这种自相矛盾。
 */
function mapFieldName(key) {
  if (key === 'due_date' || key === 'dueDate' || key === 'date') return 'deadline';
  if (key === 'estimated_hours' || key === 'hours') return 'estimatedHours';
  if (key === 'done') return 'completed';
  if (key === 'notes' || key === 'note') return 'description';
  return key;
}

/**
 * 入参别名归一化。
 *
 * 刻意**不复用** compat.js 的 `normalizeAliases`：那张表属于 dschat 2 的单日事件形状，
 * 它把 `deadline` 映射成 `date`、把布尔的 `completed` 映射成 `status`，
 * 对「待办」来说两者都是错的方向（待办的截止日就写作 `deadline`，完成态就是布尔）。
 */
function normalizeInput(rawInput = {}) {
  const out = {};
  for (const [key, value] of Object.entries(rawInput)) out[mapFieldName(key)] = value;
  return out;
}

/** Levenshtein 距离（字段名都很短，这一小段足够，不值得引依赖）。 */
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(prev[j] + 1, current[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = current;
  }
  return prev[b.length];
}

/**
 * 语义分组：整个词都写错（不是拼错一两个字母）时，靠这层猜"他大概想说什么"。
 * 例：`due` → deadline、`status` → completed、`category`/`type` → tags。
 */
const FIELD_GROUPS = [
  { match: /(minut|hour|dur|time|estimat|length)/i, suggest: ['estimatedHours', 'estimatedMinutes'] },
  { match: /(dead|due|date|day|when)/i, suggest: ['deadline'] },
  { match: /(titl|name|task|content|text)/i, suggest: ['title'] },
  { match: /(desc|note|remark|memo|detail|comment|备注|说明)/i, suggest: ['description'] },
  { match: /(done|finish|complete|status|check|state|完成)/i, suggest: ['completed'] },
  { match: /(prior|level|urgent|import|rank|优先)/i, suggest: ['priority'] },
  { match: /(tag|kind|type|categor|group|label|标签)/i, suggest: ['tags'] },
  { match: /(source|origin|origi|from)/i, suggest: ['source'] },
];

/**
 * 明明属于**日程**（或历史遗留）的字段被写到待办上时，给一句更具体的解释。
 * 这类错误光说"不认识"没用：调用方要知道"那我该用哪个 target / 哪个字段"。
 */
const FOREIGN_HINTS = {
  startTime: '待办只有截止日、没有时刻：要记"几点到几点"请用 target: "schedule"',
  endTime: '待办没有结束时刻：要记起止时间请用 target: "schedule"',
  location: '待办没有地点：要记地点请用 target: "schedule"（或写进 description）',
  category: '待办没有分类（分类属于日程）：待办可以放进 tags',
  reminders: '待办没有提醒：提醒属于日程（target: "schedule"）',
  repeat: '待办不支持重复：重复规则属于日程（target: "schedule"）',
  status: '待办的完成态字段是 completed（布尔），没有 status',
  allDay: '待办本来就是"某天之前要打勾的事"，没有 allDay',
  completed_at: '完成时间由系统维护（completedAt），不需要传',
};

/** 「你是不是想用 X」：先给拼写最近的，再用语义分组补一个（最多两个，别把提示塞满）。 */
function suggestFields(name) {
  const lowered = String(name).toLowerCase();
  const near = [...KNOWN_FIELDS]
    .filter((field) => field !== 'id')
    .map((field) => ({ field, distance: editDistance(lowered, field.toLowerCase()) }))
    .filter((entry) => entry.distance <= 2)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 2)
    .map((entry) => entry.field);
  const group = FIELD_GROUPS.find((entry) => entry.match.test(lowered));
  if (!group) return near;
  return [...near, ...group.suggest.filter((field) => !near.includes(field))].slice(0, 2);
}

/**
 * 未知字段**必须报错**，而不是静默丢掉。
 *
 * 为什么（真机缺陷 S3 的教训）：提示词把待办的预估工时写成 `estimatedMinutes`，而服务端只认
 * `estimatedHours` —— 未知键被静默丢弃，用户说"预计两小时"、落库变成默认 1 小时，全程没有任何
 * 报错，用户和模型都以为记对了。**字段名写错 = 用户说的话被丢掉**，这种损失必须当场可见。
 *
 * 只对**写入**生效：读取没有"字段"可写。建议尽量"就近"（拼写距离 + 语义分组），
 * 因为调用方看不到我们的字段清单，报错里直接告诉它该用哪个键，下一轮就能改对；
 * 只说"未知字段 x"，它多半会换个名字继续猜。
 */
function assertKnownFields(rawInput = {}) {
  const unknown = [];
  for (const key of Object.keys(rawInput)) {
    const mapped = mapFieldName(key);
    if (!KNOWN_FIELDS.has(mapped)) unknown.push({ field: key, mapped });
  }
  if (!unknown.length) return;

  const suggestions = unknown.map(({ field, mapped }) => {
    const suggest = suggestFields(mapped);
    const hint = FOREIGN_HINTS[mapped];
    return { field, ...(suggest.length ? { suggest } : {}), ...(hint ? { hint } : {}) };
  });
  const [first] = suggestions;
  // advice 里不带句末标点：hint 与建议两种句式共用同一句收尾，拼出来的错误信息才读得通
  const advice = first.hint ?? (first.suggest?.length ? `你是不是想用 ${first.suggest.join(' / ')}` : '请检查拼写');
  throw HttpError.badRequest(
    `字段 ${first.field} 不是待办认识的字段：${advice}。待办字段：${KNOWN_FIELD_LIST}`,
    {
      field: first.field,
      unknownFields: suggestions.map((item) => item.field),
      suggestions,
    },
  );
}

/**
 * 某个入参键（含别名）是不是待办认得的？
 *
 * 给**兼容层**用（calendar/routes.js 的 dschat PATCH）：那边收到的是 dschat 的事件形状，
 * 里面本来就带 `start_time` / `all_day` / `repeat*` 这些"待办根本没有"的装饰字段。
 * 适配层负责在进入严格校验之前把它们滤掉，否则 dschat 客户端的读-改-写会整条失败。
 * 域内接口（/todos、指令、AI 草稿）不走这里 —— 它们必须**如实报错**，见 assertKnownFields。
 */
export function isTodoInputField(key) {
  return KNOWN_FIELDS.has(mapFieldName(String(key)));
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

/**
 * 分钟 → 小时（待办落库只认小时）：保留一位小数（120 → 2、90 → 1.5）。
 * 正数不抹成 0：1 分钟也是要花的时间，落成 0 小时会让"复杂度/计划工时"统计失真。
 */
function minutesToHours(minutes) {
  if (!(minutes > 0)) return 0;
  return Math.max(0.1, Number((minutes / 60).toFixed(1)));
}

function normalize(rawInput, { partial = false } = {}) {
  // 未知字段先拦（理由见 assertKnownFields）：写错的字段名 = 用户说的话被丢掉，
  // 必须当场 400 并给出"你是不是想用 X"，而不是静默忽略后落一个默认值。
  assertKnownFields(rawInput);
  const input = normalizeInput(rawInput);
  const data = {};

  if (input.title !== undefined) data.title = requireTitle(input.title);
  else if (!partial) data.title = requireTitle(undefined);

  if (input.deadline !== undefined) data.deadline = requireDate(input.deadline, 'deadline');
  else if (!partial) data.deadline = requireDate(undefined, 'deadline');

  /**
   * 预估工时：待办的领域字段是 `estimatedHours`（小时，可小数），但 `estimatedMinutes`
   * 是**日程**的字段、也是模型最容易顺手写进来的那个（真机缺陷 S3：提示词里就写着 estimatedMinutes，
   * 服务端只认 estimatedHours，120 分钟被静默丢掉、落库成了默认 1 小时）。
   * 所以两种写法都收：分钟 ÷ 60 保留一位小数。原字段的语义一个字都不改。
   */
  const hasHours = input.estimatedHours !== undefined && input.estimatedHours !== null && input.estimatedHours !== '';
  const hasMinutes = input.estimatedMinutes !== undefined && input.estimatedMinutes !== null && input.estimatedMinutes !== '';
  if (hasHours && hasMinutes) {
    // 同一件事的两种口径给出两个值 = 调用方自己没说清，猜哪个都可能丢数据（原则同 assertKnownFields）
    throw HttpError.badRequest('字段 estimatedHours 与 estimatedMinutes 不能同时传：它们是同一个语义的两种写法，只传一个', {
      field: 'estimatedHours',
      alsoGiven: 'estimatedMinutes',
    });
  }
  if (hasHours) {
    data.estimatedHours = numberValue(input.estimatedHours, 'estimatedHours', {
      min: 0,
      max: MAX_ESTIMATED_HOURS,
      optional: true,
      fallback: 1,
    });
  } else if (hasMinutes) {
    const minutes = intValue(input.estimatedMinutes, 'estimatedMinutes', {
      min: 0,
      max: MAX_ESTIMATED_HOURS * 60,
      optional: false,
    });
    data.estimatedHours = minutesToHours(minutes);
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

  /**
   * 「现有记录 + patch」重建成一份完整字段（**不落库**）。
   *
   * `update()` 与 `previewUpdate()` 共用它：dryRun 预览必须与真写走同一条归一化路径，
   * 否则会出现"预览说没问题、点确认才 400"的卡点 —— 那正是这一版要修的毛病。
   */
  #rebuild(id, patch = {}) {
    const current = this.get(id);
    const incoming = normalizeInput(patch);
    const merged = { ...pickDefined(current, EDITABLE), ...incoming };
    // patch 只给了"分钟"写法时，必须把从库里带过来的 estimatedHours 让位：
    // 两个都在会被当成"调用方同时给了两种口径"而 400，而调用方其实只写了一个。
    if (incoming.estimatedMinutes !== undefined && incoming.estimatedHours === undefined) delete merged.estimatedHours;
    const data = normalize(merged, { partial: false });
    // 完成态与 completedAt 必须一起变：勾选时写时间戳，取消勾选时清成 null
    // （必须是 null 而不是 undefined：JSON 集合的合并会把 undefined 当成「不带这个字段」）
    if (data.completed) data.completedAt = data.completedAt ?? new Date().toISOString();
    else data.completedAt = null;
    return data;
  }

  /** update 的「只校验、不落库」版本：dryRun 的更新预览与真写同口径（含未知字段 400）。 */
  previewUpdate(id, patch) {
    return this.#rebuild(id, patch);
  }

  async update(id, patch) {
    const data = this.#rebuild(id, patch);
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
