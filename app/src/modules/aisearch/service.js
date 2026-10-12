/**
 * 统一检索服务：**一次查询、三路并发、统一标注来源**（校规语料 + 我的笔记 + 长期记忆）。
 *
 * ## 为什么需要它
 *
 * 三路本来各自能查（`target: knowledge` / `note` / `memory`），但模型要么漏一路
 * （只查校规就回答"转专业要什么条件"，完全没看用户自己记过什么），要么发三次查询 ——
 * 而 `chat-service` 每轮最多自动执行 3 条只读查询、整个对话最多 5 轮，
 * 三次查询就把一轮的额度烧光了，后面需要"再查一步"时已经没得查。
 * 所以这里提供一个 `target: "search"`：一条查询草稿换三路结果，合并去重后统一回灌。
 *
 * ## 三路的耦合面（刻意缩到最小）
 *
 * 只调三个**公开只读方法**，不碰任何集合、不 import 别人的内部文件：
 *   - `services.knowledge.search({ q, limit })` + `.stats()`  （知识库模块的检索口径与可用性）
 *   - `services.notes.all()`                                  （未删除的笔记，回收站里的不参与检索）
 *   - `services.memory.list({ status, limit })`               （记忆的列表口径，含 status 过滤）
 * 它们各自坏掉时本模块一律**降级而不失败**（见下）。
 *
 * ## 降级（硬要求）
 *
 * `Promise.allSettled` + 每路自己 try/catch：**任何一路挂掉都不许让整体失败**。
 * 失败写进 `sources[].error` 与 `notes[]`，另外两路的结果照常返回 ——
 * "校规那一路没查成"和"校规里没有这条规定"是两件事，模型必须能分辨，
 * 否则它会拿半份数据给出一个像模像样的错答案（用户会照着办）。
 *
 * ## 关于"并发"
 *
 * 三路都是**本地同步读取**（没有网络 I/O），所以这里买到的其实主要是**失败隔离**，
 * 并发只是顺带。仍然写成 `async + Promise.allSettled`，是因为结构本身是对的：
 * 三路互不依赖，将来某一路变成异步（比如语料挪到远端、笔记走索引）不必改调用方。
 * 三路都**不写任何数据、不广播、不共享可变状态**，所以并发是安全的。
 */

import { HttpError } from '../../core/http/router.js';
import {
  buildWindow,
  dedupeKeyOf,
  expandQuery,
  normalizeScore,
  rankAndMerge,
  roundRaw,
  scoreText,
} from './scoring.js';

/** `scope` 的合法取值：三路合起来，或只查其中一路。 */
export const SCOPES = Object.freeze(['all', 'knowledge', 'note', 'memory']);

/** 固定的来源顺序：`sources[]` 与"三路"的措辞都按它来，界面不必自己排序。 */
export const SOURCE_ORDER = Object.freeze(['knowledge', 'note', 'memory']);

/** 给人看的来源名（`sources[].label` / `notes[]` 都用它，只有一处定义）。 */
export const SOURCE_LABEL = Object.freeze({
  knowledge: '校规语料',
  note: '你的笔记',
  memory: '长期记忆',
});

/** 合并后的总条数：默认 10（≈ 每路 4 条候选），上限 20（再多会把对话上下文挤掉）。 */
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;

/** 每路取几条：默认 `ceil(limit / 3)`，上限 5 —— 三路各 5 条已经是 15 条候选，够合并排序用了。 */
const MAX_PER_SOURCE = 5;

/** 片段长度：与知识库模块同口径（240 字 ≈ 一段话，够模型引用又不淹掉对话）。 */
const SNIPPET_CHARS = 240;

/** 记忆一次最多取多少条来打分：与记忆模块的 `MAX_LIST_LIMIT` 同口径（§10.9：量级 <500 条）。 */
const MEMORY_SCAN_LIMIT = 500;

/** 记忆默认只看 `active`：把 superseded / rejected 的旧结论摆到用户面前，比"这次没想起来"危险得多。 */
const DEFAULT_MEMORY_STATUS = 'active';

/** `memoryStatus` 的宽松校验：只认 `active` 或 `active,archived` 这类小写逗号串，脏值一律 400。 */
const MEMORY_STATUS_RE = /^[a-z]+(,[a-z]+)*$/;

/** 可选文本：空串一律当"没传"（`?course=` 不该把结果过滤成空）。 */
const optionalText = (value) => (typeof value === 'string' ? value.trim() : '');

/** 必填文本：缺失、非字符串、全空白都算"没给"（`?q=%20%20` 是空白，不是关键词）。 */
function requireQuery(value) {
  const text = optionalText(value);
  if (!text) {
    throw HttpError.badRequest('字段 q 必填：统一检索需要一个关键词（如 q=转专业）', { field: 'q' });
  }
  return text;
}

/** `scope`：缺省 all；非法值 400 并把合法取值列出来（静默回落会让调用方以为筛选生效了）。 */
export function parseScope(value) {
  const text = optionalText(value) || 'all';
  if (!SCOPES.includes(text)) {
    throw HttpError.badRequest(`字段 scope 不合法：取值必须是 ${SCOPES.join(' / ')} 之一`, {
      field: 'scope',
      allowed: [...SCOPES],
    });
  }
  return text;
}

/**
 * 可选整数：**给了就必须合法**（`limit=abc` 静默变默认值会让前端以为"一共就这么多"）。
 * 规则只写一份 —— HTTP 路由、只读指令、直接调用服务层走的是同一个函数。
 */
function optionalInt(value, { field, fallback, min, max }) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  if (!Number.isInteger(num) || num < min || num > max) {
    throw HttpError.badRequest(`字段 ${field} 不合法：必须是 ${min}~${max} 的整数`, { field });
  }
  return num;
}

/** `noteIds`：接受数组或逗号分隔的字符串（`?noteIds=a,b` 与 filters 里的数组都要能用）。 */
function parseNoteIds(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
}

/** 异常 → 一句能直接写进 `sources[].error` 的话（带错误码，排查时知道是哪一类坏）。 */
function describeError(error) {
  const code = error?.code ?? error?.name ?? 'ERROR';
  const message = error?.message ?? String(error);
  return `${code}: ${message}`;
}

/** 记忆的"标题"取首句（到第一个句末标点为止，最长 60 字），找不到句末标点就整句截断。 */
function firstSentence(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const match = /^[\s\S]*?[。！？；!?;\n]/.exec(flat);
  const sentence = (match ? match[0] : flat).trim();
  return sentence.length > 60 ? `${sentence.slice(0, 60)}…` : sentence;
}

export class AiSearchService {
  /**
   * @param {object} deps
   * @param {object} [deps.knowledge] 知识库服务（order=70，必须已装配）
   * @param {object} [deps.notes]     笔记服务（order=40）
   * @param {object} [deps.memory]    记忆服务（order=45）
   * @param {Function} [deps.log]     框架 logger（`log(level, message)`）；不传就不记日志
   */
  constructor({ knowledge, notes, memory, log } = {}) {
    this.knowledge = knowledge ?? null;
    this.notes = notes ?? null;
    this.memory = memory ?? null;
    this.log = typeof log === 'function' ? log : () => {};
  }

  /* ------------------------------------------------------------ 对外：检索 */

  /**
   * 三路统一检索。
   *
   * @param {object} options
   * @param {string} options.q            检索词（必填）
   * @param {string} [options.scope]      all / knowledge / note / memory（缺省 all）
   * @param {number} [options.limit]      合并排序后返回多少条（缺省 10，上限 20）
   * @param {number} [options.perSource]  每路先取几条（缺省 ceil(limit/3)，上限 5）
   * @param {string} [options.course]     只看某门课的笔记（`properties.course`）；
   *                                      对记忆而言是"global + course:<课程>"两条 scope 都算相关
   * @param {string[]|string} [options.noteIds] 只在这些笔记 id 里找（界面上"从这几条里搜"）
   * @param {string} [options.memoryStatus] 记忆取哪些状态（缺省 active；逗号分隔可多选）
   * @returns {Promise<object>} 返回契约见本目录 README.md
   */
  async search({ q, scope, limit, perSource, course, noteIds, memoryStatus } = {}) {
    const started = Date.now();
    const query = requireQuery(q);
    const wanted = parseScope(scope);
    const size = optionalInt(limit, { field: 'limit', fallback: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });
    // 每路取 ceil(limit/3)：三路都命中的理想情况下，合并后刚好排在 limit 附近；
    // 某一路没有命中时另外两路也不会因为"名额被占"而缺数据
    const each = optionalInt(perSource, {
      field: 'perSource',
      fallback: Math.min(MAX_PER_SOURCE, Math.max(1, Math.ceil(size / 3))),
      min: 1,
      max: MAX_PER_SOURCE,
    });
    const courseText = optionalText(course);
    const ids = parseNoteIds(noteIds);
    const statusText = optionalText(memoryStatus) || DEFAULT_MEMORY_STATUS;
    if (!MEMORY_STATUS_RE.test(statusText)) {
      throw HttpError.badRequest('字段 memoryStatus 不合法：取值如 active / active,archived', {
        field: 'memoryStatus',
      });
    }

    const queried = SOURCE_ORDER.filter((source) => wanted === 'all' || wanted === source);
    const expanded = expandQuery(query);

    // 三路**并发**发出：一路抛错不影响另外两路（`#fetch` 内部还有一层 try/catch，
    // allSettled 是第二道保险 —— 万一 #fetch 自己写错了，也不能让整个检索失败）
    const settled = await Promise.allSettled(
      SOURCE_ORDER.map((source) =>
        this.#fetch(source, {
          enabled: queried.includes(source),
          query,
          expanded,
          perSource: each,
          course: courseText,
          noteIds: ids,
          memoryStatus: statusText,
        }),
      ),
    );

    const reports = [];
    const candidates = [];
    settled.forEach((result, index) => {
      const source = SOURCE_ORDER[index];
      if (result.status === 'fulfilled') {
        reports.push(result.value.report);
        candidates.push(...result.value.items);
        return;
      }
      // 理论上到不了这里（#fetch 自己兜住了），留作最后一道防线：失败也要有交代
      reports.push({
        source,
        label: SOURCE_LABEL[source],
        queried: queried.includes(source),
        available: false,
        total: null,
        count: 0,
        truncated: false,
        tookMs: 0,
        error: describeError(result.reason),
      });
    });

    // 合并排序 + **跨源去重**（同一篇同时命中校规与笔记时并成一条）
    const merged = rankAndMerge(candidates).slice(0, size);
    const notes = this.#composeNotes({ query, wanted, queried, reports, items: merged, perSource: each });

    return {
      q: query,
      scope: wanted,
      limit: size,
      perSource: each,
      course: courseText || null,
      noteIds: ids,
      count: merged.length,
      items: merged,
      sources: reports,
      notes,
      tookMs: Date.now() - started,
      searchedAt: new Date().toISOString(),
    };
  }

  /* ------------------------------------------------------------ 对外：三路自检 */

  /**
   * 三路各自是否可用、一共有多少条（`GET /search/sources`）。
   *
   * 为什么单独一个接口：界面要显示"校规 148 篇 / 笔记 3 条 / 记忆 2 条"，
   * 排查时第一句话也是"三路都活着吗"。与 `search()` 一样用 allSettled：
   * 某一路探测失败只让它自己那条 error 非空，不影响另外两路。
   */
  async sources({ memoryStatus } = {}) {
    const statusText = optionalText(memoryStatus) || DEFAULT_MEMORY_STATUS;
    const settled = await Promise.allSettled(
      SOURCE_ORDER.map((source) => this.#probe(source, { memoryStatus: statusText })),
    );
    const items = settled.map((result, index) => {
      const source = SOURCE_ORDER[index];
      // `#probe` 与 `#collect` 统一返回 `{ report, items }`（`search()` 那边要的是 items），
      // 这里只要报告本身：`source` / `label` 由探测报告补齐，保证每条都带齐这两个字段
      if (result.status === 'fulfilled') return { source, label: SOURCE_LABEL[source], ...result.value.report };
      return {
        source,
        label: SOURCE_LABEL[source],
        available: false,
        total: null,
        error: describeError(result.reason),
      };
    });
    const alive = items.filter((item) => item.available);
    const failed = items.filter((item) => !item.available);
    return {
      count: items.length,
      items,
      // 一句话口径，前端直接显示；某一路不可用时把原因一并说出来，别只给个灰点
      notes: [
        `三路可检索：${alive.map((item) => `${item.label} ${item.total ?? 0} 条`).join(' / ') || '无'}。`,
        ...failed.map((item) => `${item.label}不可用：${item.error ?? '原因未知'}`),
      ],
    };
  }

  /* ------------------------------------------------------------ 内部：三路取数 */

  /**
   * 取一路的数据。**永不抛**：任何异常都变成报告里的 `error`。
   *
   * @returns {Promise<{ report: object, items: object[] }>}
   */
  async #fetch(source, options) {
    const started = Date.now();
    const base = {
      source,
      label: SOURCE_LABEL[source],
      queried: options.enabled,
      available: false,
      total: null,
      count: 0,
      truncated: false,
      error: null,
    };
    try {
      // 没被 scope 选中的路：只探一次"可用吗 / 有多少条"（不检索），
      // 这样 scoped 查询的返回里依然能看到另外两路的规模，界面不必再发一次请求
      const outcome = options.enabled ? await this.#collect(source, options) : await this.#probe(source, options);
      return {
        report: { ...base, ...outcome.report, count: outcome.items.length, tookMs: Date.now() - started },
        items: outcome.items,
      };
    } catch (error) {
      this.log('warn', `[aisearch] ${source} 这一路检索失败：${error?.message ?? error}`);
      return {
        report: { ...base, available: false, error: describeError(error), tookMs: Date.now() - started },
        items: [],
      };
    }
  }

  /** 某一路的依赖服务没装配时的报告（不抛：整体检索照常返回另外两路）。 */
  #missing(source) {
    return {
      available: false,
      total: 0,
      error: `${SOURCE_LABEL[source]}模块未装配（aisearch 的 order 必须大于它的 order）`,
    };
  }

  /** 只探可用性与总条数（不检索）。**scope 没选中的路**与 `/search/sources` 走这里。 */
  async #probe(source, options = {}) {
    if (source === 'knowledge') return { report: this.#probeKnowledge(), items: [] };
    if (source === 'note') return { report: this.#probeNote(), items: [] };
    return { report: this.#probeMemory(options), items: [] };
  }

  /** 按来源分发到三个采集器（每个采集器返回 `{ report, items }`）。 */
  async #collect(source, options) {
    if (source === 'knowledge') return this.#collectKnowledge(options);
    if (source === 'note') return this.#collectNote(options);
    return this.#collectMemory(options);
  }

  /* ------------------------------------------------------------ 知识库这一路 */

  #probeKnowledge() {
    if (!this.knowledge) return this.#missing('knowledge');
    const stats = this.knowledge.stats();
    return {
      available: stats.available !== false,
      // 语料缺失时 stats.counts.documents 为 0（restore 失败会清空栏目），如实报 0 而不是 null
      total: stats.counts?.documents ?? 0,
      error: stats.available === false ? (stats.reason ?? '语料不可用') : null,
      detail: {
        categories: stats.counts?.categories ?? 0,
        chars: stats.counts?.chars ?? 0,
        source: stats.source ?? null,
        generatedAt: stats.generatedAt ?? null,
      },
    };
  }

  /**
   * 知识库：**直接采信 `knowledge.search()` 的分数**（本模块不重算它的打分）。
   * 打分口径的责任在知识库模块那边（接口文档 §14.4），这里只做搬运 + 标注来源。
   */
  #collectKnowledge({ query, perSource }) {
    if (!this.knowledge) return { report: this.#missing('knowledge'), items: [] };
    const probe = this.#probeKnowledge();
    const result = this.knowledge.search({ q: query, limit: perSource, snippetChars: SNIPPET_CHARS });
    const items = (result.items ?? []).map((item) => ({
      source: 'knowledge',
      // 知识条目没有 id：`path` 就是它的身份，也是 `/knowledge/doc?path=` 的入参
      id: item.path ?? item.url ?? item.title,
      title: item.title,
      snippet: item.snippet ?? '',
      ...(item.url ? { url: item.url } : {}),
      ...(item.path ? { path: item.path } : {}),
      score: normalizeScore(item.score),
      sources: ['knowledge'],
      meta: {
        rawScore: roundRaw(item.score),
        category: item.category ?? null,
        categorySlug: item.categorySlug ?? null,
        publishedAt: item.publishedAt ?? null,
        kind: item.kind ?? 'document',
        // 命中的词：模型/界面可用来核对"为什么这条排前面"
        matches: item.matches ?? [],
        merged: [],
        dedupeKey: dedupeKeyOf(item.title),
      },
    }));
    return {
      report: {
        ...probe,
        count: items.length,
        // 知识库自己的 search 只回截断后的条数，拿不到"总共命中多少"（不谎报一个数字）：
        // 取满 perSource 条就说明"可能还有"，这个信号够界面显示"还有更多"
        truncated: items.length >= perSource,
      },
      items,
    };
  }

  /* ------------------------------------------------------------ 笔记这一路 */

  #probeNote() {
    if (!this.notes) return this.#missing('note');
    // `all()` 默认排除回收站：删掉的笔记不该在检索里"还魂"
    return { available: true, total: this.notes.all().length, error: null };
  }

  /**
   * 笔记：标题 + 正文按 `scoreText()` 打分（标题命中 ×8、正文命中 ×1、按正文字数做 log 阻尼）。
   *
   * 为什么不用笔记模块自己的 `queryForAI()`：那是给"按 id / 关键词取正文"用的，
   * 它的关键词要求**全部词都出现**（AND），而且不给分数 —— 拿它当三路之一，
   * "转专业要什么条件"会被当成一整串去匹配，往往一条都命中不了。这里要的是**带分数的召回**。
   */
  #collectNote({ expanded, perSource, course, noteIds }) {
    if (!this.notes) return { report: this.#missing('note'), items: [] };

    const all = this.notes.all();
    const wanted = new Set(noteIds);
    const courseKey = dedupeKeyOf(course);
    const scored = [];
    for (const item of all) {
      if (wanted.size && !wanted.has(String(item.id))) continue;
      // `course` 只看某门课：笔记的课程存在 properties.course 里（接口文档的笔记字段约定）
      if (courseKey && dedupeKeyOf(item.properties?.course ?? '') !== courseKey) continue;
      const { raw } = scoreText({ title: item.title, body: item.body }, expanded);
      if (raw <= 0) continue;
      scored.push({ item, raw });
    }
    // 同分按"最近改过的优先"：用户刚写的东西更可能是他问的那条
    scored.sort((a, b) => b.raw - a.raw || String(b.item.updatedAt ?? '').localeCompare(String(a.item.updatedAt ?? '')));
    const items = scored.slice(0, perSource).map(({ item, raw }) => ({
      source: 'note',
      id: item.id,
      noteId: item.id,
      title: item.title,
      snippet: buildWindow(item.body, expanded.terms, SNIPPET_CHARS),
      score: normalizeScore(raw),
      sources: ['note'],
      meta: {
        rawScore: roundRaw(raw),
        tags: item.tags ?? [],
        folder: item.folder ?? '',
        course: item.properties?.course ?? null,
        updatedAt: item.updatedAt ?? null,
        merged: [],
        dedupeKey: dedupeKeyOf(item.title),
      },
    }));
    return {
      report: {
        available: true,
        // `total` 是这个源的**全部可检索条数**（不是这次命中数）：界面显示"你的笔记 3 条"用它
        total: all.length,
        error: null,
        count: items.length,
        // 过滤后总共命中多少条：界面据此说"还有 N 条没显示"
        matched: scored.length,
        truncated: scored.length > items.length,
      },
      items,
    };
  }

  /* ------------------------------------------------------------ 记忆这一路 */

  #probeMemory({ memoryStatus } = {}) {
    if (!this.memory) return this.#missing('memory');
    const listed = this.memory.list({ status: memoryStatus || DEFAULT_MEMORY_STATUS, limit: MEMORY_SCAN_LIMIT });
    return { available: true, total: listed.count ?? listed.items?.length ?? 0, error: null };
  }

  /**
   * 记忆：`text` 当正文、`key` 当标题（key 是这条记忆的句柄/主题词）。
   *
   * 默认只取 `active`：`superseded` 是已被新结论取代的旧值、`rejected` 是用户明确否掉的
   * （§10.4），把这两类摆进"关于你的事实"里，模型会当成现状说出来 ——
   * 它们仍然可以在管理页查到（`memoryStatus` 参数就是给那种场景留的），只是不参与统一检索。
   *
   * `course` 对记忆的口径：某门课的检索里，"关于用户本人"的全局记忆（scope=global）
   * 与这门课的记忆（scope=course:<课程>）都算相关；别的课的记忆不算。
   */
  #collectMemory({ expanded, perSource, course, memoryStatus }) {
    if (!this.memory) return { report: this.#missing('memory'), items: [] };

    const status = memoryStatus || DEFAULT_MEMORY_STATUS;
    const listed = this.memory.list({ status, limit: MEMORY_SCAN_LIMIT });
    const courseScope = course ? `course:${course}` : null;
    const scored = [];
    for (const item of listed.items ?? []) {
      if (courseScope && !['global', courseScope].includes(item.scope)) continue;
      const { raw } = scoreText({ title: item.key ?? '', body: item.text ?? '' }, expanded);
      if (raw <= 0) continue;
      scored.push({ item, raw });
    }
    scored.sort((a, b) => b.raw - a.raw || String(b.item.updatedAt ?? '').localeCompare(String(a.item.updatedAt ?? '')));
    const items = scored.slice(0, perSource).map(({ item, raw }) => ({
      source: 'memory',
      id: item.id,
      // 记忆没有标题：取首句当标题（列表里要有个能认的名字），全文放 snippet
      title: firstSentence(item.text),
      snippet: buildWindow(item.text, expanded.terms, SNIPPET_CHARS),
      score: normalizeScore(raw),
      sources: ['memory'],
      meta: {
        rawScore: roundRaw(raw),
        kind: item.kind ?? 'fact',
        memoryScope: item.scope ?? 'global',
        key: item.key ?? null,
        status: item.status ?? 'active',
        reviewAt: item.reviewAt ?? null,
        updatedAt: item.updatedAt ?? null,
        merged: [],
        // 记忆不参与跨源去重：它是一句"关于用户本人的话"，不是某篇内容的副本
        dedupeKey: null,
      },
    }));
    return {
      report: {
        available: true,
        total: listed.count ?? listed.items?.length ?? 0,
        error: null,
        count: items.length,
        matched: scored.length,
        truncated: scored.length > items.length,
      },
      items,
    };
  }

  /* ------------------------------------------------------------ 内部：说明文案 */

  /**
   * `notes[]`：把"这次到底发生了什么"讲清楚。
   *
   * 为什么值得单独一段代码：空结果最容易被误读。模型看到 `items: []` 会直接说
   * "校规里没有这条规定"，而真实原因可能是"语料压根没抓过""哪一路被 scope 排除了"。
   * 这类话必须由**检索侧**说明白（只有它知道原因），不能指望模型自己猜。
   */
  #composeNotes({ query, wanted, queried, reports, items, perSource }) {
    const notes = [];
    const live = reports.filter((report) => report.queried && report.available);
    const failed = reports.filter((report) => report.queried && !report.available);
    const width = queried.length === SOURCE_ORDER.length ? '三路' : `${queried.length} 路`;

    if (!items.length) {
      const scopeText = wanted === 'all' ? '' : `（scope=${wanted}）`;
      const where = live.length
        ? `：${live.map((report) => `${report.label} ${report.total ?? 0} 条`).join('、')}里都没有相关内容`
        : '：可检索的来源一条都没查成';
      notes.push(`${width}都没命中「${query}」${scopeText}${where}。换个关键词，或把 scope 放宽到 all。`);
    } else {
      const parts = reports
        .filter((report) => report.queried && report.count)
        .map((report) => `${report.label} ${report.count} 条`);
      notes.push(`${width}命中 ${items.length} 条（合并去重后）：${parts.join(' / ')}。`);
    }

    for (const report of failed) {
      // 失败原因如实写出来：模型据此如实告诉用户，而不是把"没查成"当成"没有"
      notes.push(`${report.label}这一路没查成：${report.error ?? '原因未知'}。`);
    }
    for (const report of live) {
      if (!report.truncated) continue;
      const known = Number.isInteger(report.matched) ? `，共命中 ${report.matched} 条` : '';
      notes.push(`${report.label}按每路 ${perSource} 条截断（返回 ${report.count} 条${known}）：要看更多请提高 limit。`);
    }
    if (wanted !== 'all') {
      const skipped = reports.filter((report) => !report.queried).map((report) => report.label);
      notes.push(
        `scope=${wanted}：这次只查了「${SOURCE_LABEL[wanted]}」，${skipped.join('、')}没有参与检索（sources 里 queried=false）。`,
      );
    }
    for (const item of items) {
      if (item.sources.length < 2) continue;
      const labels = item.sources.map((source) => SOURCE_LABEL[source]).join(' + ');
      notes.push(`「${item.title}」在${labels}里都命中，已合并成一条（sources: ${item.sources.join('+')}）。`);
    }
    return notes;
  }
}
