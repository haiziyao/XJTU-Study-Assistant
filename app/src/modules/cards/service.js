/**
 * 复习卡片服务：卡片的增删改查、复习评分推进、从笔记生成、以及到期队列。
 *
 * 边界（与相邻模块的分工）
 * ----------------------
 * - **排期**全部交给 `scheduler.js`（纯函数），本层只负责"把算出来的结果写下去"；
 *   service 里没有任何一处自己算天数 —— 那种代码是两套规则漂移的起点。
 * - **笔记**只读，且只读 `services.notes` 的公开方法（`get` / `list`），不直接摸
 *   `store.notes` 集合。理由：笔记的 `body` 不是原样存的 —— `NoteService` 在读的时候
 *   才会从 docx 附件里抽出正文、过滤回收站、补 `properties`/`tags` 的默认值。
 *   直连集合会绕开这层归一化（表现为"从某些笔记生成不出卡片"，而且笔记模块一改字段
 *   我们这边就静默坏掉）；而"写"笔记是绝不允许的，所以也不需要更重的耦合。
 * - **到期队列**是只读投影：`list({ due: true })` 比 `now`，`dueToday()` 比"今天结束"。
 *   后者是给定时唤醒用的（见方法注释）。
 *
 * 写入串行化
 * ----------
 * `#serialize` 与 memory 模块同源：`JsonStore.persist()` 用固定名字的临时文件
 * （`<文件>.<pid>.tmp`），同一 tick 发起的两次写入会互相 rename（后者 ENOENT，写入丢失）。
 * 记忆模块遇到它是因为命中回报天生并发；这里则是"用户连点两次『记得』"或者前端重试
 * 一次复习请求。复习写入极小，串行没有任何代价，丢一次却是用户白复习了一遍。
 */

import { HttpError } from '../../core/http/router.js';
import { addDays, fromDateKey, toDateKey, todayKey } from '../../shared/time.js';
import { extractCandidates, normalizeFront } from './extract.js';
import {
  MAX_BACK_CHARS,
  MAX_COURSE_CHARS,
  MAX_FRONT_CHARS,
  MAX_NOTE_ID_CHARS,
  normalizeCard,
  optionalTags,
  optionalText,
  parseBool,
  requiredText,
  validateCardFields,
} from './model.js';
import { DEFAULT_EASE, GRADES, computeNext, isDue } from './scheduler.js';

/** 列表口径：默认 50、上限 500（与记忆模块一致，管理页一次能拉完做分组计数）。 */
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
/** 统计的"未来 N 天"：7 天足够回答"这周要复习多少"，再多界面也放不下。 */
export const STATS_DAYS = 7;
/** `dueToday()` 默认取多少张：定时唤醒的提示词塞不下 100 张卡，20 张够它说清今天的分量。 */
export const DEFAULT_DUE_TODAY_LIMIT = 20;
/** 生成：默认扫 5 篇笔记、最多 20 篇；单次最多落 200 张卡（防止一次点错建出几千张）。 */
export const DEFAULT_GENERATE_NOTES = 5;
export const MAX_GENERATE_NOTES = 20;
export const MAX_GENERATE_CARDS = 200;
/** 关键词长度上限：它只是用来在笔记里检索的，不是正文。 */
const MAX_QUERY_CHARS = 200;

/** 本地 `HH:MM`（回执里"今天 20:35 再来一次"用）。 */
function clockOf(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 一句话说清"下次什么时候见"：间隔 0 的当天复习要给具体时刻，否则用户会以为它消失了。 */
function describeNext(intervalDays, dueIso) {
  if (intervalDays < 1) return `今天 ${clockOf(new Date(dueIso))} 再来一次`;
  return `${intervalDays} 天后（${toDateKey(new Date(dueIso))}）`;
}

/** 整数夹紧：调用方传了脏值（字符串、负数、巨大）时收敛到合法区间而不是抛错。 */
function clampInt(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
}

export class CardService {
  /**
   * @param {object} options
   * @param {object} options.store     JsonStore（必须已装配 `cards` 集合）
   * @param {Function} [options.broadcast] WebSocket 广播
   * @param {object} [options.services] 全局服务表（只用到 `notes`，且是惰性读取：
   *                                    测试里可以只装 cards 服务，走生成时才报"缺少 notes"）
   * @param {Function} [options.now]   可注入时钟（复习排期、到期队列要能在测试里复现）
   */
  constructor({ store, broadcast, services, now } = {}) {
    if (!store?.cards) throw new Error('CardService 需要 store.cards 集合（检查 module.js 的 collections 声明）');
    this.store = store;
    this.broadcast = broadcast;
    this.services = services ?? {};
    this.now = typeof now === 'function' ? now : () => new Date();
    /** 本服务所有落盘动作的串行队列（理由见文件头）。 */
    this.writes = Promise.resolve();
  }

  get collection() {
    return this.store.cards;
  }

  #serialize(run) {
    const task = this.writes.then(run, run);
    this.writes = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  #changed(action, id, extra = {}) {
    this.broadcast?.({
      type: 'data_changed',
      module: 'cards',
      payload: { module: 'cards', target: 'card', action, ...(id ? { id } : {}), ...extra },
    });
  }

  /** 全部卡片（归一化后的副本；读取路径零 IO、零写入）。 */
  all() {
    return this.collection.all().map(normalizeCard);
  }

  /** 取一条，不存在一律 404（PATCH / DELETE / review 共用）。 */
  get(id) {
    const raw = this.collection.get(String(id ?? ''));
    if (!raw) throw HttpError.notFound(`卡片不存在：${id}`);
    return normalizeCard(raw);
  }

  /**
   * 按正面文字模糊定位（指令层用：「把熵那张卡删掉」）。
   *
   * 返回**全部**匹配而不是第一条：定位到多条时该报错让用户说清楚，
   * 而不是替他挑一张 —— 删错一张卡是不可逆的。
   */
  findByFront(text, { limit = 10 } = {}) {
    const needle = normalizeFront(text);
    if (!needle) return [];
    return this.all()
      .filter((card) => normalizeFront(card.front).includes(needle))
      .slice(0, limit);
  }

  // ---------------------------------------------------------------- 读取

  /** 单条是否命中筛选条件（`list` 与 `counts` 共用同一口径，避免"数字和列表对不上"）。 */
  #matches(card, filters, now) {
    if (filters.due === true && !isDue(card, now)) return false;
    if (filters.due === false && isDue(card, now)) return false;
    if (filters.suspended === true && !card.suspended) return false;
    if (filters.suspended === false && card.suspended) return false;
    if (filters.course && card.course !== filters.course) return false;
    if (filters.tag && !card.tags.includes(filters.tag)) return false;
    if (filters.noteId && card.noteId !== filters.noteId) return false;
    if (filters.needle) {
      const haystack = `${card.front} ${card.back} ${card.course ?? ''} ${card.tags.join(' ')}`.toLowerCase();
      if (!haystack.includes(filters.needle)) return false;
    }
    return true;
  }

  /**
   * 列表 / 检索（`GET /cards`）。
   *
   * @param {object} [query]
   * @param {boolean} [query.due]       `true` 只看现在到期的（未暂停且 due ≤ now）；`false` 只看还没到期的
   * @param {string}  [query.course]    课程精确匹配
   * @param {string}  [query.tag]       标签精确匹配
   * @param {string}  [query.noteId]    只看某篇笔记生成的
   * @param {boolean} [query.suspended] `true` 只看已暂停；`false` 只看未暂停
   * @param {string}  [query.q]         关键词（正面/答案/课程/标签）
   * @param {number}  [query.limit]
   * @param {number}  [query.offset]
   * @returns {{ count: number, counts: object, items: object[], filters: object }}
   *
   * `counts`（total / due / suspended / todayReviewed）是**界面顶部统计**，
   * 因此刻意**不受筛选影响** —— 否则用户一按"只看数据结构"，其它数字全归零，
   * 就看不出整个库还有多少到期了。`count` 才是筛选后的条数。
   */
  list({ due, course, tag, noteId, suspended, q, limit = DEFAULT_LIST_LIMIT, offset = 0 } = {}) {
    const now = this.now();
    const today = todayKey(now);
    const filters = {
      due: due ?? null,
      course: course ?? null,
      tag: tag ?? null,
      noteId: noteId ?? null,
      suspended: suspended ?? null,
      needle: String(q ?? '').trim().toLowerCase().replace(/\s+/g, ' '),
    };

    const cards = this.all();
    // 统计口径与"筛选后列表"共用 isDue / 同一个今天，避免两处各算一套
    const counts = {
      total: cards.length,
      due: cards.filter((card) => isDue(card, now)).length,
      suspended: cards.filter((card) => card.suspended).length,
      todayReviewed: cards.filter((card) => this.#reviewedToday(card, today)).length,
    };

    const matched = cards.filter((card) => this.#matches(card, filters, now));
    // 到期队列按 due 升序（先复习最该复习的）；管理页按最近改动排（刚改的顶到最前）
    matched.sort((a, b) =>
      due === true ? String(a.due).localeCompare(String(b.due)) : String(b.updatedAt).localeCompare(String(a.updatedAt)),
    );

    const size = clampInt(limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
    const start = clampInt(offset, 0, 0, 100000);

    return {
      count: matched.length,
      counts,
      items: matched.slice(start, start + size),
      filters: {
        due: due ?? null,
        course: course ?? null,
        tag: tag ?? null,
        noteId: noteId ?? null,
        suspended: suspended ?? null,
        q: q ?? null,
        limit: size,
        offset: start,
      },
    };
  }

  #reviewedToday(card, today) {
    if (!card.lastReviewedAt) return false;
    const at = Date.parse(card.lastReviewedAt);
    return Number.isFinite(at) && toDateKey(new Date(at)) === today;
  }

  /**
   * 统计（`GET /cards/stats`）：总数 / 今日到期 / 未来 7 天每天到期数 / 已暂停 / 按课程分组。
   *
   * 两处口径刻意写死在这里，因为它们决定了用户"今天要做多少"的判断：
   * - `byDay[0]`（今天）**包含逾期**：上个月积压的卡片必须在"今天"这一格出现，
   *   否则它们会从七日曲线上彻底消失，用户以为已经清完了；
   * - 所有按天/按课程的统计都**排除已暂停**：暂停就是"别提醒我"，统计还照样提醒没有意义。
   */
  stats() {
    const now = this.now();
    const today = todayKey(now);
    const dayKeys = Array.from({ length: STATS_DAYS }, (_, index) => addDays(today, index));
    const todayStart = fromDateKey(today).getTime();
    const todayEnd = fromDateKey(addDays(today, 1)).getTime() - 1;

    const cards = this.all();
    const active = cards.filter((card) => !card.suspended);

    const byDayCounts = new Map(dayKeys.map((key) => [key, 0]));
    for (const card of active) {
      const at = Date.parse(card.due);
      if (!Number.isFinite(at)) continue;
      const key = toDateKey(new Date(at));
      if (byDayCounts.has(key)) byDayCounts.set(key, byDayCounts.get(key) + 1);
      else if (at < todayStart) byDayCounts.set(today, byDayCounts.get(today) + 1);
    }

    const courseMap = new Map();
    for (const card of cards) {
      const key = card.course ?? '';
      const entry = courseMap.get(key) ?? { course: card.course, total: 0, due: 0 };
      entry.total += 1;
      if (isDue(card, now)) entry.due += 1;
      courseMap.set(key, entry);
    }

    return {
      total: cards.length,
      dueNow: cards.filter((card) => isDue(card, now)).length,
      dueToday: active.filter((card) => Date.parse(card.due) <= todayEnd).length,
      suspended: cards.filter((card) => card.suspended).length,
      reviewedToday: cards.filter((card) => this.#reviewedToday(card, today)).length,
      byDay: dayKeys.map((date) => ({ date, count: byDayCounts.get(date) })),
      // 未分类（course 为 null）保留 null 交给界面渲染成「未分类」，不在这里编一个中文名
      byCourse: [...courseMap.values()].sort(
        (a, b) => b.total - a.total || String(a.course ?? '').localeCompare(String(b.course ?? '')),
      ),
      generatedAt: now.toISOString(),
    };
  }

  /**
   * **今天到期的卡片**（只读，给定时唤醒 / 别的模块用）。
   *
   * 与 `GET /cards?due=1` 的区别（两条都保留，因为它们回答的是不同问题）：
   * - `due=1` 比 `now`：**现在**就能复习的（again 之后 10 分钟冷却的那些不在里面）；
   * - 本方法比"今天结束"：**今天之内**到期，含刚才 `again` 掉、安排在今晚再来的卡。
   *
   * 定时唤醒的场景要的是后者 —— 08:00 唤醒时说"今天没有要复习的"，
   * 而晚上其实还有 12 张卡，这句话就是错的。
   *
   * @returns {object[]} 归一化后的卡片数组（按 due 升序，未暂停），不是信封对象：
   *                     唤醒提示词与调用方多数只要"有哪些卡"，条数用 `.length`
   */
  dueToday({ limit = DEFAULT_DUE_TODAY_LIMIT, course, tag } = {}) {
    const now = this.now();
    const todayEnd = fromDateKey(addDays(todayKey(now), 1)).getTime() - 1;
    const size = clampInt(limit, DEFAULT_DUE_TODAY_LIMIT, 1, MAX_LIST_LIMIT);
    return this.all()
      .filter((card) => {
        if (card.suspended) return false;
        if (course && card.course !== course) return false;
        if (tag && !card.tags.includes(tag)) return false;
        const at = Date.parse(card.due);
        return Number.isFinite(at) && at <= todayEnd;
      })
      .sort((a, b) => String(a.due).localeCompare(String(b.due)))
      .slice(0, size);
  }

  // ---------------------------------------------------------------- 写入

  /** 供指令处理器的 `dryRun` 复用同一套校验（"点确认才发现 400"是体验事故）。 */
  validate(input, options) {
    return validateCardFields(input, options);
  }

  /**
   * 手工建卡（`POST /cards`）。
   *
   * 调度状态一律从零开始：新卡的 `due` 就是"现在"，所以它立刻出现在今天的队列里 ——
   * 用户刚做出来的卡当然要当天就能复习，而不是等到明天。
   */
  async create(input, { defaultSource = 'manual' } = {}) {
    const fields = validateCardFields(input, { defaultSource });
    const card = await this.#insert(fields);
    this.#changed('create', card.id);
    return card;
  }

  /** 内部建卡：`create()` 与 `generate()` 共用，广播由调用方决定（见 generate）。 */
  async #insert(fields) {
    const raw = await this.#serialize(() =>
      this.collection.insert({
        ...fields,
        due: this.now().toISOString(),
        intervalDays: 0,
        ease: DEFAULT_EASE,
        reps: 0,
        lapses: 0,
        lastReviewedAt: null,
        lastGrade: null,
      }),
    );
    return normalizeCard(raw);
  }

  /**
   * 修改（`PATCH /cards/:id`）：只能改正面 / 答案 / 标签 / 课程 / 暂停。
   *
   * 三处刻意的取舍：
   * 1. **不接受调度字段**。`intervalDays` / `due` / `ease` 改一个字段就能让一张卡
   *    永远消失，而界面上看不出来 —— 它们只能由复习评分推进；
   * 2. **不接受的键静默忽略**（前端把整张卡回传是很常见的写法），但整份补丁里
   *    **一个可改字段都没有**时返回 400：那说明客户端拼错了字段名或者想绕过调度，
   *    返回成功会把这两种情况都藏起来；
   * 3. **改暂停状态不动 `due`**。解封一张三个月前暂停的卡，它会立刻以"逾期"出现 ——
   *    这符合直觉（本来就欠着），而"解封时把 due 改成现在"会悄悄抹掉它欠了多久。
   */
  async update(id, patch = {}) {
    const current = this.get(id);
    const next = {};
    if (patch.front !== undefined) next.front = requiredText(patch.front, { field: 'front', max: MAX_FRONT_CHARS });
    if (patch.back !== undefined) next.back = requiredText(patch.back, { field: 'back', max: MAX_BACK_CHARS });
    if (patch.course !== undefined) next.course = optionalText(patch.course, { field: 'course', max: MAX_COURSE_CHARS });
    if (patch.tags !== undefined) next.tags = optionalTags(patch.tags);
    if (patch.suspended !== undefined) next.suspended = parseBool(patch.suspended, { fallback: current.suspended });

    if (!Object.keys(next).length) {
      throw HttpError.badRequest(
        '没有可修改的字段：只能改 front / back / tags / course / suspended（排期由复习评分推进）',
        { field: null, allowed: ['front', 'back', 'tags', 'course', 'suspended'] },
      );
    }

    const raw = await this.#serialize(() => this.collection.update(current.id, next));
    this.#changed('update', current.id);
    return normalizeCard(raw);
  }

  /** 删除（不可逆）。删错的代价只是重建一张，所以不做软删除 —— 多一套状态就多一处会不一致。 */
  async remove(id) {
    const current = this.get(id);
    await this.#serialize(() => this.collection.remove(current.id));
    this.#changed('delete', current.id);
    return { deleted: true, id: current.id };
  }

  /**
   * 记录一次复习（`POST /cards/:id/review`）：**这是唯一推进排期的入口**。
   *
   * 评分必须由调用方显式给出（界面上的四个按钮 / 用户原话），服务层不设默认值：
   * 默认成 `good` 等于替用户宣称"记住了"，之后所有排期都建立在一句没人说过的话上。
   *
   * 暂停的卡片被显式指定 id 时照常记录（用户可能就是想复习它），但**不会自动解除暂停**：
   * 暂停是用户的决定，复习一次不该悄悄推翻它。
   */
  async review(id, grade, { now } = {}) {
    if (!GRADES.includes(grade)) {
      throw HttpError.badRequest(`字段 grade 不合法：取值必须是 ${GRADES.join(' / ')} 之一`, { field: 'grade' });
    }
    const current = this.get(id);
    const at = now ?? this.now();
    const next = computeNext(current, grade, at);
    const raw = await this.#serialize(() => this.collection.update(current.id, next));
    const item = normalizeCard(raw);
    this.#changed('review', item.id, { grade });
    return {
      item,
      // 显式回一个 nextDue：调用方（界面 / 定时唤醒 / 模型）不必自己去 item 里翻
      nextDue: item.due,
      previousDue: current.due,
      scheduled: {
        intervalDays: item.intervalDays,
        ease: item.ease,
        reps: item.reps,
        lapses: item.lapses,
        lastGrade: item.lastGrade,
      },
      // 只描述"下一次什么时候见"；"这次评分是什么档"由调用方（回执 / 指令说明）去讲，
      // 两处各写一遍会拼出「忘了：忘了：…」这种重复
      explain: `下次复习 ${describeNext(item.intervalDays, item.due)}`,
    };
  }

  /**
   * 从笔记生成卡片（`POST /cards/generate`）：规则化抽取，**不调模型**（理由见 extract.js）。
   *
   * 幂等：按 `noteId + 正面` 去重，所以同一篇笔记点两次「生成」不会出现两套卡
   * （`created: 0, skipped: N` 就是"已经生成过了"的诚实回答）。
   * 去重**只在同一篇笔记内**做：两篇不同的笔记里各有一个「熵」是两件真实的事
   * （不同老师、不同定义），合并它们会让用户永久丢掉一份。
   *
   * @param {{ noteId?: string, query?: string, limit?: number }} input
   *        `noteId` 指定一篇；`query` 走笔记模块的关键词检索（支持 `tag:` / `folder:` 语法）
   * @returns {Promise<{ created: number, skipped: number, ignored: number, notes: number, items: object[] }>}
   */
  async generate({ noteId, query, limit } = {}) {
    const notes = this.services?.notes;
    if (!notes) throw HttpError.notImplemented('从笔记生成卡片需要 notes 模块先装配（order=40）');

    const wantedId = optionalText(noteId, { field: 'noteId', max: MAX_NOTE_ID_CHARS });
    const keyword = optionalText(query, { field: 'query', max: MAX_QUERY_CHARS });
    if (!wantedId && !keyword) {
      throw HttpError.badRequest('需要 noteId（指定一篇）或 query（按关键词选笔记）', { field: 'noteId' });
    }
    const size = clampInt(limit, DEFAULT_GENERATE_NOTES, 1, MAX_GENERATE_NOTES);

    // 列表接口只给摘要（没有 body），所以按 id 逐篇取全文 —— 这也是走 notes 服务而不是
    // 直连集合的原因之一：归一化后的 body（含 docx 抽取正文）只有服务层给得出来
    const scanned = wantedId
      ? [notes.get(wantedId)]
      : notes.list({ query: keyword, limit: size }).map((summary) => notes.get(summary.id));

    let created = 0;
    let skipped = 0;
    let ignored = 0;
    const items = [];

    for (const note of scanned) {
      const existing = new Set(
        this.collection.find((card) => card.noteId === note.id).map((card) => normalizeFront(card.front)),
      );
      const { candidates, ignored: rejected } = extractCandidates(note);
      ignored += rejected;

      for (const candidate of candidates) {
        if (created >= MAX_GENERATE_CARDS) break;
        const key = normalizeFront(candidate.front);
        if (existing.has(key)) {
          skipped += 1;
          continue;
        }
        existing.add(key);
        const card = await this.#insert({
          front: candidate.front,
          back: candidate.back,
          noteId: note.id,
          course: optionalText(note.properties?.course, { field: 'course', max: MAX_COURSE_CHARS }),
          tags: optionalTags(note.tags),
          source: 'note',
          suspended: false,
        });
        created += 1;
        // `rule` 不进存储：它是"这张卡由哪条规则抽出来"的说明，只在这次回执里有意义
        items.push({ ...card, rule: candidate.rule });
      }
    }

    // 一次生成可能建出几十张卡，逐张广播会让前端重渲染几十次；一条汇总广播足够，
    // 前端收到后重新拉一次列表即可（payload 带 count 便于提示"新生成 N 张"）
    if (created) this.#changed('generate', undefined, { count: created });
    return { created, skipped, ignored, notes: scanned.length, items };
  }
}
