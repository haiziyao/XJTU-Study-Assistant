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

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { HttpError } from '../../core/http/router.js';
import { clockToMinutes, todayKey } from '../../shared/time.js';
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

/* ---------------------------------------------------------------- 批量删除 */

/**
 * 批量删除的作用域。四个值对应界面上四个选项，也对应 AI 草稿里的 `filters.scope`。
 *
 * 为什么不让调用方直接传一条任意谓词：这条链路是「不可逆操作」，范围必须是**有限枚举**，
 * 才能把"预览 = 真正删除"的口径钉死在同一处（`#resolveBulkMatches`）。否则前端预览一套、
 * 服务端删除另一套，用户看到 3 条、实际删了 30 条。
 */
const BULK_SCOPES = ['all', 'range', 'source', 'ids'];
/** `scope:'source'` 允许的来源。manual 的口径见 `isManualSchedule`。 */
const BULK_SOURCES = ['manual', 'import', 'lms'];
/** 预览里最多回几条样例：够用户认出"删的是哪一批"，又不会让弹窗变成第二个列表。 */
const PREVIEW_SAMPLES = 8;
/** 回收站文件：与其它集合同目录（生产环境就是 app/data），不额外引入存储层。 */
const TRASH_FILE = 'schedules-trash.json';
/**
 * 回收站上限。为什么要有：删除是批量动作，用户连续点几次就可能把整库搬进回收站；
 * 没有上限时一个 JSON 文件会无限涨（还要整份读进内存）。50 批 / 500 条足够覆盖
 * "手滑了，撤一下"的真实场景，再老的记录按最旧优先丢弃。
 */
const TRASH_MAX_BATCHES = 50;
const TRASH_MAX_RECORDS = 500;

/** 课表导入的判据（与 timetable 模块写入的形状一致）。 */
function isImportedSchedule(item) {
  // 历史数据里 source 可能缺失，但 externalId 前缀是更可靠的凭证；两个条件任一成立即算导入。
  return item?.source === 'import' || String(item?.externalId ?? '').startsWith('timetable:');
}

/** 思源学堂同步写入的日程：source 也是 import，靠 externalId 前缀区分（见 lms/sync.js）。 */
function isLmsSchedule(item) {
  return item?.source === 'lms' || String(item?.externalId ?? '').startsWith('lms:');
}

/**
 * 「仅手动创建的」口径 = **不是导入来的**（manual / command / ai）。
 *
 * 为什么不只认 `source === 'manual'`：用户通过指令或 AI 建的日程 source 是 command / ai，
 * 在用户眼里同样是"我自己建的"。只认 manual 会让"清掉导入的、留下我自己的"这个动作漏掉
 * AI 建的那批 —— 比多留几条更糟：用户会以为已经清干净了。
 */
function isManualSchedule(item) {
  return !isImportedSchedule(item) && !isLmsSchedule(item);
}

/** 回收站与回执的三分类（与 scope:'source' 的三个选项一一对应）。 */
function sourceBucketOf(item) {
  if (isLmsSchedule(item)) return 'lms';
  if (isImportedSchedule(item)) return 'import';
  return 'manual';
}

function countBySource(items) {
  const out = { manual: 0, import: 0, lms: 0 };
  for (const item of items) out[sourceBucketOf(item)] += 1;
  return out;
}

/** 预览样例按时间排序，用户一眼能看出删的是哪几天。 */
function sortForPreview(items) {
  return [...items].sort((a, b) =>
    a.date === b.date ? String(a.startTime ?? '').localeCompare(String(b.startTime ?? '')) : String(a.date).localeCompare(String(b.date)),
  );
}

const SAMPLE_FIELDS = (item) => ({
  id: item.id,
  title: item.title,
  date: item.date,
  startTime: item.startTime ?? null,
  source: item.source ?? 'manual',
});

function normalize(rawInput, { partial = false, categories = null } = {}) {
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
  // 分类来自可编辑的注册表：id 存在就用它，没传/不存在则静默兜底到 other
  // （分类写错不该让用户的日程写不进去；dschat 兼容层的 category 是自由文本）
  if (input.category !== undefined) {
    data.category = categories ? categories.resolve('schedule', input.category) : 'other';
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
  /**
   * 回收站的内存副本（懒加载）+ 串行写队列。
   *
   * 为什么串行：批量删除与撤销都可能被连点，两个 `read-modify-write` 交错会把回收站文件
   * 写成"少了一批"的状态 —— 而那一批已经真的从 schedules 删掉了，等于数据永久丢失。
   */
  #trash = [];
  #trashLoaded = false;
  #trashChain = Promise.resolve();

  constructor({ store, broadcast = () => {}, categories = null, trashFile = null }) {
    this.store = store;
    this.broadcast = broadcast;
    /** 分类注册表（可编辑）；缺省时一律落到 other。 */
    this.categories = categories;
    /**
     * 回收站落在数据目录里（生产 = app/data/schedules-trash.json）。
     * 不在 module.js 里声明成集合：它不是业务集合，没有 id 语义、也不该被同步模块搬走。
     */
    this.trashFile = trashFile ?? (store?.dataDir ? path.join(store.dataDir, TRASH_FILE) : null);
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

  /**
   * 与其他日程的时间冲突（同日、时段相交）。仅提示，不阻断写入。
   *
   * **一处判断，两处使用**：真写（`commands.create` 落库后）与 dryRun 预览（确认卡要提前报出重叠）
   * 都调这一个方法。不要在任一侧另写一套"什么算重叠"——预览说不撞、落库说撞，比不提示更糟。
   * `candidate` 可以是一条已落库的记录（带 id，用来排除自己），也可以是 `preview()` 的归一化结果
   * （没有 id，等于"这条新建的还不存在"，同日的都算潜在冲突）。
   */
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
    const data = normalize(input, { categories: this.categories });
    const created = await this.collection.insert(data);
    this.broadcast({ type: 'data_changed', payload: { target: 'schedule', action: 'create', id: created.id } });
    return created;
  }

  /**
   * 只校验、不落库：与 `create` **完全同一条**归一化路径。
   *
   * 存在的理由：`/commands/execute { dryRun: true }` 的确认卡必须能提前报出
   * 「缺 startTime」这类错误。以前 dryRun 只是把字段原样回显，于是错误要等用户
   * 点了确认才冒出来 —— 对 AI 草稿来说这一步是唯一的安全网。
   */
  preview(input) {
    return normalize(input, { categories: this.categories });
  }

  async update(id, patch) {
    const current = this.get(id);
    const merged = { ...pickDefined(current, EDITABLE), ...patch };
    const data = normalize(merged, { partial: false, categories: this.categories });
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

  /* ================================================================ 批量删除 */

  /**
   * 按范围批量删除（先预览、再确认、可撤销）。
   *
   * 三个安全阀，缺一不可：
   *   1. **默认 dryRun**：不传 `dryRun:false` 就只算数量、不落库。批量删除是不可逆动作，
   *      默认值必须是"不删"——调用方忘了传参数时，用户最多看到一次预览，而不是丢一个日程库。
   *   2. **dryRun:false 必须 confirm:true**：把"预览"与"执行"拆成两次显式请求，
   *      防止一次误触发（前端循环、curl 手滑）直接清库。
   *   3. **scope:'all' 还要 confirmText:'删除'**：`confirm:true` 是程序传的，
   *      而中文确认词必须是"知道自己在清空"的人才会写。少一个都 400。
   *
   * 删除顺序是**先写回收站再删库**：写盘失败就完全不删（记录还在）；反过来先删再写，
   * 一旦写盘失败记录就永久没了。回收站里存整条记录（不是 id），因为恢复要原样放回。
   *
   * 只操作 `schedules` 集合。events / todos / notes 各有自己的生命周期，
   * 「清空日程」不该顺手清掉日历事件或待办 —— 那两件事的用户预期完全不同（见 routes.js 的领域说明）。
   */
  async bulkDelete(input = {}) {
    const scope = String(input?.scope ?? '').trim();
    if (!BULK_SCOPES.includes(scope)) {
      throw HttpError.badRequest(`scope 不合法：只能是 ${BULK_SCOPES.join(' / ')}`, { field: 'scope' });
    }
    const filters = this.#bulkFilters(input, scope);
    const matches = this.#resolveBulkMatches(scope, filters);
    const bySource = countBySource(matches);
    const preview = {
      scope,
      count: matches.length,
      samples: matches.slice(0, PREVIEW_SAMPLES).map(SAMPLE_FIELDS),
      bySource,
      requiresConfirm: true,
      ...(scope === 'range' ? { from: filters.from, to: filters.to } : {}),
      ...(scope === 'source' ? { source: filters.source } : {}),
    };

    /**
     * 只有显式 `dryRun: false` 才执行。字符串 `"false"` / `0` 一律当作"没说要删"：
     * 这个默认值只能往安全方向失败。
     */
    const dryRun = input?.dryRun !== false;
    if (dryRun) return { dryRun: true, ...preview };

    if (input?.confirm !== true) {
      // 回带预览数字：调用方（尤其是 AI/前端）能直接拿它去画确认卡或追问，不用再查一次
      throw new HttpError(400, 'CONFIRM_REQUIRED', `批量删除需要 confirm: true（当前将删除 ${matches.length} 条日程）`, {
        scope,
        count: matches.length,
        requiresConfirm: true,
        samples: preview.samples,
      });
    }
    if (scope === 'all' && String(input?.confirmText ?? '').trim() !== '删除') {
      throw new HttpError(
        400,
        'CONFIRM_TEXT_MISMATCH',
        '删除全部日程需要 confirmText: "删除"（中文确认词，防止误触发清空）',
        { scope, count: matches.length, expected: '删除' },
      );
    }

    if (!matches.length) {
      // 空库不写空批次：回收站里留一条"删了 0 条"的记录只会让「撤销上次删除」按钮指向空气
      return { dryRun: false, scope, removed: 0, trashId: null, bySource, count: 0 };
    }

    return this.#runTrash(async () => {
      const batch = await this.#pushTrash({ scope, ...filters, items: matches });
      const removed = await this.collection.removeMany(matches.map((item) => item.id));
      this.broadcast({ type: 'data_changed', payload: { target: 'schedule', action: 'bulk-delete', scope, removed } });
      return { dryRun: false, scope, removed, trashId: batch.id, bySource, count: matches.length };
    });
  }

  /** 校验并归一化 scope 的附加条件（range 的 from/to、source、ids）。 */
  #bulkFilters(input, scope) {
    const filters = {};
    if (scope === 'range') {
      filters.from = requireDate(input?.from, 'from');
      filters.to = requireDate(input?.to, 'to');
      if (filters.to < filters.from) throw HttpError.badRequest('to 不能早于 from（区间含两端）', { field: 'to' });
    }
    if (scope === 'source') {
      const source = String(input?.source ?? '').trim();
      if (!BULK_SOURCES.includes(source)) {
        throw HttpError.badRequest(`source 不合法：只能是 ${BULK_SOURCES.join(' / ')}`, { field: 'source' });
      }
      filters.source = source;
    }
    if (scope === 'ids') {
      const raw = Array.isArray(input?.ids) ? input.ids : [];
      // 去重 + 丢空值：调用方传重复 id 时不能让 removed 数虚高
      filters.ids = [...new Set(raw.map((id) => String(id ?? '').trim()).filter(Boolean))];
      if (!filters.ids.length) throw HttpError.badRequest('ids 不能为空', { field: 'ids' });
    }
    return filters;
  }

  /** 唯一的"什么算命中"实现：预览与真删都走这里，两边不可能漂移。 */
  #resolveBulkMatches(scope, filters) {
    const all = this.collection.all();
    if (scope === 'all') return sortForPreview(all);
    if (scope === 'range') {
      return sortForPreview(all.filter((item) => item.date >= filters.from && item.date <= filters.to));
    }
    if (scope === 'source') {
      const predicate =
        filters.source === 'import' ? isImportedSchedule : filters.source === 'lms' ? isLmsSchedule : isManualSchedule;
      return sortForPreview(all.filter(predicate));
    }
    const wanted = new Set(filters.ids);
    return sortForPreview(all.filter((item) => wanted.has(item.id)));
  }

  /* ================================================================ 回收站 */

  /**
   * 回收站概况。**不含记录正文**：接口只服务"有没有可撤销的批次、几条"，
   * 把整条记录吐给前端既浪费带宽，也等于给「删除」开了一个绕过权限的读后门。
   */
  async trashList() {
    await this.#runTrash(() => this.#ensureTrash());
    const items = this.#trash.map((batch) => ({
      id: batch.id,
      at: batch.at,
      count: batch.count,
      bySource: batch.bySource,
      scope: batch.scope,
    }));
    return {
      items,
      count: items.length,
      total: this.#trash.reduce((sum, batch) => sum + (batch.items?.length ?? 0), 0),
    };
  }

  /**
   * 恢复一批。同 id 已存在时**跳过并计数**，不覆盖现有记录：
   * 用户可能删完之后又手动建了一条同 id 的（同步回灌、导入重放），覆盖它就是拿旧数据打新数据。
   */
  async restoreTrash(trashId) {
    const id = String(trashId ?? '').trim();
    if (!id) throw HttpError.badRequest('trashId 为必填');
    return this.#runTrash(async () => {
      await this.#ensureTrash();
      const index = this.#trash.findIndex((batch) => batch.id === id);
      if (index === -1) throw HttpError.notFound(`回收站里没有这一批：${id}`);
      const batch = this.#trash[index];
      let restored = 0;
      let skipped = 0;
      const now = new Date().toISOString();
      for (const item of batch.items) {
        if (!item?.id || this.collection.get(item.id)) {
          skipped += 1;
          continue;
        }
        /**
         * 不走 `collection.insert` 的原因有两个：
         *   1. insert 会把 createdAt / updatedAt 重置成"现在"，而恢复的语义是"当它没被删过"
         *      —— 时间戳变了，列表排序与「创建时间」都会跟着变；
         *   2. insert 每条都全量落盘一次，恢复 500 条就是 500 次写文件。
         * 这里整条放回内存表，循环结束后统一 persist 一次（Collection 的公开字段/方法，不改 core）。
         */
        this.collection.records.set(item.id, {
          ...item,
          createdAt: item.createdAt ?? now,
          updatedAt: item.updatedAt ?? now,
        });
        restored += 1;
      }
      if (restored) await this.collection.persist();
      // 恢复过的批次从回收站移除：留着的话「撤销上次删除」会反复指向同一批
      this.#trash.splice(index, 1);
      await this.#persistTrash();
      if (restored) {
        this.broadcast({ type: 'data_changed', payload: { target: 'schedule', action: 'restore', restored } });
      }
      return { restored, skipped, trashId: id };
    });
  }

  /** 清空回收站（可选能力；同样要 confirm:true，理由与批量删除一致）。 */
  async clearTrash(input = {}) {
    return this.#runTrash(async () => {
      await this.#ensureTrash();
      const batches = this.#trash.length;
      if (!batches) return { cleared: 0, records: 0 };
      if (input?.confirm !== true) {
        throw new HttpError(400, 'CONFIRM_REQUIRED', '清空回收站需要 confirm: true', { batches });
      }
      const records = this.#trash.reduce((sum, batch) => sum + (batch.items?.length ?? 0), 0);
      this.#trash = [];
      await this.#persistTrash();
      return { cleared: batches, records };
    });
  }

  /** 回收站写操作串行化（见 #trashChain 的注释）。 */
  #runTrash(task) {
    const run = this.#trashChain.then(task);
    // 队列本身不能断：上一个任务失败只影响它自己的调用方，后续写入仍要能继续
    this.#trashChain = run.catch(() => {});
    return run;
  }

  async #ensureTrash() {
    if (this.#trashLoaded) return;
    if (!this.trashFile) {
      this.#trashLoaded = true;
      return;
    }
    try {
      const raw = await fs.readFile(this.trashFile, 'utf8');
      const parsed = JSON.parse(raw);
      const batches = Array.isArray(parsed) ? parsed : parsed?.batches ?? [];
      this.#trash = batches.filter((batch) => batch && typeof batch === 'object' && Array.isArray(batch.items));
      // 手工编辑过的旧文件可能超上限：加载时先收敛，别等下一次删除才变干净
      this.#trimTrash();
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // 损坏文件先备份再当空回收站：绝不静默覆盖（里面可能是用户唯一能撤销的数据）
        const backup = `${this.trashFile}.corrupt-${Date.now()}`;
        await fs.rename(this.trashFile, backup).catch(() => {});
        console.error(`[calendar] 回收站文件解析失败（${error.message}），已备份到 ${backup}`);
      }
      this.#trash = [];
    }
    this.#trashLoaded = true;
  }

  /** 追加一批到回收站（最新在前），裁剪到上限后落盘。调用方必须已在 #runTrash 里。 */
  async #pushTrash({ scope, from, to, source, items }) {
    await this.#ensureTrash();
    const batch = {
      // 时间戳 + 随机后缀：连点两次也可能落在同一毫秒，只靠时间戳会撞 id
      id: `trash-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      at: new Date().toISOString(),
      scope,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(source ? { source } : {}),
      count: items.length,
      bySource: countBySource(items),
      // 整条记录（不是 id）：恢复时要原样放回，缺字段就不是同一条日程了
      items,
    };
    this.#trash.unshift(batch);
    this.#trimTrash();
    await this.#persistTrash();
    return batch;
  }

  /** 上限裁剪：先裁批数，再按最旧优先裁记录数（最新一批无论如何保留）。 */
  #trimTrash() {
    while (this.#trash.length > TRASH_MAX_BATCHES) this.#trash.pop();
    let total = this.#trash.reduce((sum, batch) => sum + (batch.items?.length ?? 0), 0);
    while (total > TRASH_MAX_RECORDS && this.#trash.length > 1) {
      const dropped = this.#trash.pop();
      total -= dropped?.items?.length ?? 0;
    }
  }

  /** 原子写 + 0600：回收站里是用户的完整日程（可能有地点、备注），不给同机其它账号读。 */
  async #persistTrash() {
    if (!this.trashFile) return;
    await fs.mkdir(path.dirname(this.trashFile), { recursive: true });
    const payload = `${JSON.stringify({ schemaVersion: 1, batches: this.#trash }, null, 2)}\n`;
    const tmp = `${this.trashFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    // 已有 tmp（上次崩溃残留）时 writeFile 的 mode 不生效，显式 chmod 一次
    await fs.chmod(tmp, 0o600).catch(() => {});
    await fs.rename(tmp, this.trashFile);
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
