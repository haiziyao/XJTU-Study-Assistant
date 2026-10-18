/**
 * 更改日志（audit log）：记录**所有人**对数据的改动，包括用户、AI 与系统。
 *
 * 为什么单独一个模块、而不是复用框架的指令日志
 * ------------------------------------------------
 * `commandLogs` 只记录“经过指令系统”的对话/指令，用户在界面上点出来的改动
 * （建待办、改笔记、删记忆…）完全不经过它。用户问“这一页是干啥的”时，
 * 真正的答案应该是“谁在什么时候改了什么”，所以这里重新做一份**按实体**的日志。
 *
 * 为什么 AI 与用户分开记
 * ----------------------
 * 用户最常问的两句话是“你之前改过什么”与“我什么时候删的”。只有 `actor`
 * 分得清，这两句话才答得出来；混在一起时，AI 会把自己的写入说成用户的，
 * 用户也会误以为某条数据是自己删的。actor 的取值固定为 user / ai / system。
 *
 * 为什么 before/after 只存关键字段
 * --------------------------------
 * 日志天生比业务数据“多一份”，如果把整条笔记（正文上限 20 万字、还带图片 dataURL）
 * 或整条待办都抄进日志，日志会比数据本身还大，5000 条上限也撑不了几天。
 * 只留 title/date/deadline/completed 这类“能看懂这次改了什么”的字段，
 * 既能回答“改成了什么”，又把单条记录控制在几百字节。
 *
 * 为什么日志失败不能影响业务
 * --------------------------
 * 日志是**旁路**：用户点“保存”时，真正要成功的是那条数据。审计写盘失败
 * （磁盘满、权限、JSON 损坏）如果往外抛，就会让一次本来成功的业务操作变成 500，
 * 甚至让“删了但日志没记上”的数据被误认为没删。所以 `record()` 永不抛错，
 * 写盘失败只进 console，下个 200ms 周期再试。
 *
 * 为什么不用 JsonStore
 * --------------------
 * JsonStore 的集合是 `{schemaVersion, items}` 包装、文件权限 0644；本模块要求
 * `data/audit-log.json` 是**裸 JSON 数组**且 0600（日志里可能有账号/操作轨迹）。
 * 自己实现这 100 行存储，比把 JsonStore 改成两套语义更小、更清楚。
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** 日志文件名（`ctx.dataDir` 下）。 */
export const AUDIT_FILE = 'audit-log.json';
/** 最多保留的条数：超出丢最旧。5000 条 ≈ 单机数月的界面操作量。 */
export const MAX_ENTRIES = 5000;
/** 列表默认/最大条数。 */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;
/** 批量落盘的合并窗口：界面连续操作时把多条合成一次写盘。 */
export const FLUSH_MS = 200;

export const ACTORS = Object.freeze(['user', 'ai', 'system']);
export const SOURCES = Object.freeze(['ui', 'api', 'chat', 'sync', 'lms']);

/**
 * before/after 里允许留下的字段。
 *
 * 这是一份**白名单**而不是黑名单：新增业务字段时忘了加，代价只是日志少一个字段；
 * 反过来（黑名单）一旦漏掉 `body` / `attachments` / `dataUrl`，一条日志就可能上兆。
 */
export const SNAPSHOT_FIELDS = Object.freeze([
  'title',
  'date',
  'deadline',
  'completed',
  'completedAt',
  'startTime',
  'endTime',
  'startDate',
  'endDate',
  'priority',
  'category',
  'parentId',
  'status',
  'scope',
  'kind',
  'text',
  'description',
  'folder',
  'tags',
  'estimatedHours',
  'estimatedMinutes',
  'location',
  'url',
  'method',
  'model',
  'provider',
  'enabled',
  'theme',
  'value',
  'key',
  'label',
  'source',
  'count',
]);

/** 敏感字段名：命中就**只写 `***`**，绝不落原值。 */
const SENSITIVE_KEY_RE =
  /(pass(word|wd)?|pwd|secret|token|cookie|authorization|api[-_]?key|private[-_]?key|credential|session[-_]?id)/i;

/** 文本里的 `password=xxx` / `Bearer xxx` / `sk-...` 也要打码（summary/title 可能被人塞了凭据）。 */
const INLINE_SECRET_RE =
  /(password|passwd|pwd|passcode|token|secret|cookie|authorization|api[-_]?key|private[-_]?key|credential|session(?:[-_]?id)?|密码|口令|令牌|密钥|凭证)(["']?\s*(?:[:=：]|是|为)\s*)(["']?)[^\s,;，；"']+/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
/** OpenAI 兼容端点的密钥都长 `sk-...`；即使调用方没写字段名也不能把它落盘。 */
const SK_KEY_RE = /\bsk-[A-Za-z0-9_-]{8,}\b/gi;

const SNAPSHOT_TEXT_MAX = 300;
const SNAPSHOT_JSON_MAX = 600;
const SNAPSHOT_ARRAY_MAX = 20;

/** 文本打码（只处理明确的“字段名 + 值”形状，避免把普通中文误伤）。 */
export function redactText(value) {
  return String(value ?? '')
    .replace(INLINE_SECRET_RE, (_whole, name, sep, quote) => `${name}${sep}${quote}***`)
    .replace(BEARER_RE, 'Bearer ***')
    .replace(SK_KEY_RE, '***');
}

/**
 * 递归打码（不修改入参）。对象里任何敏感键都变成 `"***"`。
 * 深度与循环引用都做了兜底：日志入口宁可截断，也不能因为一条奇怪的对象抛错。
 */
export function maskSensitive(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => maskSensitive(item, depth + 1, seen));
  }
  if (!value || typeof value !== 'object') return value;
  if (depth > 8) return '[truncated]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_RE.test(key)
      ? item === undefined || item === null || item === ''
        ? item
        : '***'
      : maskSensitive(item, depth + 1, seen);
  }
  seen.delete(value);
  return out;
}

/** 单个快照值的压缩：字符串截断、数组限量、对象转成短 JSON（已打码）。 */
function compactValue(value) {
  if (typeof value === 'string') return redactText(value).slice(0, SNAPSHOT_TEXT_MAX);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    const out = value
      .slice(0, SNAPSHOT_ARRAY_MAX)
      .map((item) => {
        if (typeof item === 'string') return redactText(item).slice(0, 120);
        if (typeof item === 'number' || typeof item === 'boolean' || item === null) return item;
        try {
          return redactText(JSON.stringify(maskSensitive(item))).slice(0, SNAPSHOT_JSON_MAX);
        } catch {
          return undefined;
        }
      })
      .filter((item) => item !== undefined);
    return out.length ? out : undefined;
  }
  if (typeof value === 'object') {
    try {
      return redactText(JSON.stringify(maskSensitive(value))).slice(0, SNAPSHOT_JSON_MAX);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * 只保留关键字段，并把敏感字段打成 `***`。
 * 敏感字段**保留键名但值为 `***`**（而不是直接丢掉）：日志里看得见“这里有个密码字段被保护了”，
 * 比悄悄消失更容易排查，也证明打码逻辑真的跑了。
 */
export function pickSnapshot(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const out = {};
  for (const [rawKey, value] of Object.entries(source)) {
    const key = String(rawKey);
    if (SENSITIVE_KEY_RE.test(key)) {
      if (value !== undefined && value !== null && value !== '') out[key] = '***';
      continue;
    }
    if (!SNAPSHOT_FIELDS.includes(key)) continue;
    const compact = compactValue(value);
    if (compact !== undefined) out[key] = compact;
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanText(value, max) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return redactText(String(value)).trim().slice(0, max);
}

/** 把任意调用方给的 `at` 归一成 ISO；不合法就用当前时间（日志宁可有时间误差也不能没时间）。 */
function resolveAt(value, now) {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
    try {
      return new Date(value).toISOString();
    } catch {
      /* fallthrough */
    }
  }
  return now().toISOString();
}

/**
 * 归一一条日志（导出的目的是测试可以直接验字段）。
 * 未知字段一律丢弃：日志的字段是契约，不允许业务把任意大对象塞进来。
 */
export function normalizeEntry(entry, now = () => new Date()) {
  const raw = entry && typeof entry === 'object' ? entry : {};
  const actor = ACTORS.includes(raw.actor) ? raw.actor : 'user';
  const module = cleanText(raw.module, 40) || 'system';
  const action = cleanText(raw.action, 40) || 'update';
  const target = cleanText(raw.target ?? module, 60) || module;
  const source = SOURCES.includes(raw.source)
    ? raw.source
    : actor === 'ai'
      ? 'chat'
      : actor === 'user'
        ? 'ui'
        : undefined;

  const before = pickSnapshot(raw.before);
  const after = pickSnapshot(raw.after);
  const title = cleanText(raw.title ?? after?.title ?? before?.title, 200);
  const summary = cleanText(raw.summary, 600);
  const targetId = raw.targetId === undefined || raw.targetId === null ? '' : cleanText(raw.targetId, 200);
  const requestId = cleanText(raw.requestId, 100);

  return {
    id: cleanText(raw.id, 80) || randomUUID(),
    at: resolveAt(raw.at, now),
    actor,
    module,
    action,
    target,
    ...(targetId ? { targetId } : {}),
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    ...(source ? { source } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * 日志服务。
 *
 * 写入路径：`record()` 只进内存缓冲 → 200ms 后合并落盘；`flush()` / `stop()` 立即落盘。
 * 读取路径：先 `flush()` 再读，保证“刚写完立刻查”能看到（界面点完刷新不必等 200ms）。
 */
export class AuditService {
  constructor({
    dataDir = '.',
    now = () => new Date(),
    flushMs = FLUSH_MS,
    maxEntries = MAX_ENTRIES,
    logger = console,
  } = {}) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, AUDIT_FILE);
    this.now = typeof now === 'function' ? now : () => new Date();
    this.flushMs = Math.max(0, Number(flushMs) || 0);
    this.maxEntries = Math.max(1, Number(maxEntries) || MAX_ENTRIES);
    this.logger = logger;

    /** 已落盘（或从盘里读出来）的记录，按时间升序；裁剪时丢数组头部。 */
    this.entries = [];
    /** 还没落盘的记录。 */
    this.buffer = [];
    /** 定时器；只有 record() 才会启动。 */
    this.timer = null;
    this.loaded = false;
    this.dirty = false;
  }

  /**
   * 读盘（幂等）。文件损坏时先备份再以空日志启动，绝不静默覆盖。
   *
   * 这里是**同步读**：日志最多 5000 条（约 1 MB），启动时读一次完全可接受；
   * 更重要的是 `stop()` 不需要 Promise —— 装配层的 close() 不 await 模块 stop，
   * 同步读 + 同步写才能保证“刚记录就关窗口”也不丢最后几条。
   */
  load() {
    if (this.loaded) return this;
    try {
      this.#readSync();
    } catch (error) {
      // 读不出来也要让模块继续装配：日志坏了不能拖垮整个后端
      this.logger?.error?.(`[audit] 读取 ${this.filePath} 失败：${error.message}`);
      this.loaded = true;
      this.dirty = true;
    }
    return this;
  }

  #readSync() {
    mkdirSync(this.dataDir, { recursive: true });
    let raw = null;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];
        this.entries = items.filter((item) => item && typeof item === 'object' && typeof item.id === 'string');
        if (this.#trim()) this.dirty = true;
      } catch (error) {
        // 文件损坏：先备份，再以空日志启动。审计可以重来，数据不行。
        const backup = `${this.filePath}.corrupt-${Date.now()}`;
        try {
          renameSync(this.filePath, backup);
        } catch {
          /* 备份失败也继续空启动，至少不覆盖原件（写盘会失败并进 console） */
        }
        this.logger?.error?.(`[audit] ${this.filePath} 解析失败（${error.message}），已备份到 ${backup}`);
        this.entries = [];
        this.dirty = true;
      }
      // 老文件可能是 0644；读的时候顺手收紧
      try {
        chmodSync(this.filePath, 0o600);
      } catch {
        /* 忽略：下次写盘还会再设一次 */
      }
    } else {
      // 首次启动就创建空数组文件：用户能在 data/ 里看到它，测试也有一条稳定路径
      this.dirty = true;
    }

    this.loaded = true;
    this.#persist();
  }

  /**
   * 记录一条。**永不抛错**（理由见文件头）。
   * @returns {object|null} 归一后的记录（正常）或 null（连归一都失败）
   */
  record(entry) {
    try {
      const item = normalizeEntry(entry, this.now);
      this.buffer.push(item);
      this.dirty = true;
      // 触发懒加载；失败已由 load 自己兜底
      void this.load();
      this.#schedule();
      return item;
    } catch (error) {
      this.logger?.error?.(`[audit] 记录失败（已忽略）：${error?.message ?? error}`);
      return null;
    }
  }

  #schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushMs);
    // 日志不该让进程为了它多活 200ms；shutdown 时 stop() 会同步落盘
    this.timer.unref?.();
  }

  /** 立即合并缓冲并写盘。失败只记 console，不抛。 */
  async flush() {
    try {
      await this.load();
      this.#persist();
      return { total: this.entries.length, file: this.filePath };
    } catch (error) {
      this.logger?.error?.(`[audit] 写盘失败（已保留在内存，稍后重试）：${error.message}`);
      return { total: this.entries.length, file: this.filePath, error: error.message };
    }
  }

  /**
   * 停机落盘。
   *
   * 装配层的 `close()` 不 await 模块的 stop（框架约定），所以这里用**同步写**：
   * 返回 Promise 没人等，最后 200ms 的日志会在进程退出时丢掉。一次小文件同步写
   * 换来“关了窗口也不丢日志”，在停机路径上是划算的。
   */
  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // 首次使用就关窗口（还没走过 restore）也要把内存里那几条写下去
    this.load();
    this.#persist();
    return { total: this.entries.length, file: this.filePath };
  }

  #persist() {
    const batch = this.buffer.splice(0);
    if (batch.length) {
      this.entries.push(...batch);
      this.dirty = true;
    }
    if (this.#trim()) this.dirty = true;
    if (!this.dirty) return;

    try {
      mkdirSync(this.dataDir, { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      // 先落临时文件再 rename：进程中断不会留下半截 JSON
      writeFileSync(tmp, `${JSON.stringify(this.entries, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.filePath);
      chmodSync(this.filePath, 0o600);
      this.dirty = false;
    } catch (error) {
      // 写失败不改 dirty：下个周期重试；记录仍在 entries 里，不会丢
      this.logger?.error?.(`[audit] 写入 ${this.filePath} 失败：${error.message}`);
    }
  }

  /** 只保留最新 maxEntries 条（array 头部是最旧的）。 */
  #trim() {
    const overflow = this.entries.length - this.maxEntries;
    if (overflow <= 0) return false;
    this.entries.splice(0, overflow);
    return true;
  }

  /** 过滤后的记录（默认最新在前）。 */
  #filtered({ actor, module, action, since } = {}) {
    const sinceMs = typeof since === 'string' && since.trim() ? Date.parse(since) : Number.NaN;
    return this.entries
      .filter((entry) => {
        if (actor && entry.actor !== actor) return false;
        if (module && entry.module !== module) return false;
        if (action && entry.action !== action) return false;
        if (!Number.isNaN(sinceMs) && Date.parse(entry.at) < sinceMs) return false;
        return true;
      })
      .reverse();
  }

  /**
   * 查询。
   * @param {object} [filters]
   * @param {'user'|'ai'|'system'} [filters.actor]
   * @param {string} [filters.module]
   * @param {string} [filters.action]
   * @param {string} [filters.since] ISO 时刻或日期
   * @param {number} [filters.limit=50] 1~500（超出夹紧）
   * @param {number} [filters.offset=0]
   */
  async list({ actor, module, action, since, limit = DEFAULT_LIMIT, offset = 0 } = {}) {
    await this.flush();
    const size = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(limit) || DEFAULT_LIMIT)));
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    const matched = this.#filtered({ actor, module, action, since });
    return {
      items: matched.slice(start, start + size).map(clone),
      count: Math.min(size, Math.max(0, matched.length - start)),
      total: matched.length,
      limit: size,
      offset: start,
      hasMore: start + size < matched.length,
      filters: {
        actor: actor || null,
        module: module || null,
        action: action || null,
        since: since || null,
        limit: size,
        offset: start,
      },
    };
  }

  /** 按 actor / module / action 计数（给筛选下拉与首页概览用）。 */
  async stats() {
    await this.flush();
    const actors = { user: 0, ai: 0, system: 0 };
    const modules = {};
    const actions = {};
    for (const entry of this.entries) {
      actors[entry.actor] = (actors[entry.actor] ?? 0) + 1;
      modules[entry.module] = (modules[entry.module] ?? 0) + 1;
      actions[entry.action] = (actions[entry.action] ?? 0) + 1;
    }
    return {
      total: this.entries.length,
      actors,
      modules,
      actions,
      firstAt: this.entries[0]?.at ?? null,
      lastAt: this.entries.at(-1)?.at ?? null,
    };
  }
}

/**
 * 给对话模型用的只读查询 target `log`。
 *
 * 它只实现 `query`：**没有 create/update/delete** —— 日志是证据，AI 不能改证据。
 * 模型想“清掉一条日志”时，这里会直接报“不支持 action”，而不是悄悄删掉。
 */
export function createAuditCommands({ audit }) {
  return {
    async query(draft = {}) {
      const filters = draft.filters ?? {};
      const result = await audit.list({
        actor: filters.actor,
        module: filters.module,
        action: filters.action,
        since: filters.since,
        limit: filters.limit,
        offset: filters.offset,
      });
      return {
        filters,
        items: result.items,
        count: result.count,
        total: result.total,
        explain: draft.explain ?? `共 ${result.total} 条更改记录（当前显示 ${result.count} 条）`,
      };
    },
  };
}
