/**
 * 记忆服务：关于**用户本人**的、跨会话可复用的事实（接口文档 §10）。
 *
 * 一条记忆成立的三个条件（§10.1）——跨会话、可复用、**非派生**：
 * 有确切时间位置的进日历三域（事件/日程/待办），能从已有集合算出来的走查询，
 * 这一层只留"下次依然成立、且影响不止一次决策"的结论。
 *
 * 几个刻意的取舍（都对着 §10 的硬规则）：
 *
 * 1. **推断的写入一律走 `propose()`，它一个字都不落盘**（§10.5：`writes: false`）。
 *    写错的待办用户当天就看得见；写错的偏好会静默污染之后**每一次**对话，
 *    而用户根本不知道它存在 —— 所以"模型 → 提议 → 用户确认 → 落库"不能有例外。
 *
 * 2. **覆盖不删除**（§10.3）。同 `scope + key` 写入新值只把旧条转 `superseded` 并留
 *    `supersededBy` 链：用户可能改回来，链上留证比"删了干净"重要。
 *
 * 3. **`rejected` 是负记忆，不是废数据**（§10.4）。它必须能被查出来（`list({ key, scope })`），
 *    否则 AI 会把同一个已经被否掉三次的建议第四次端上来。
 *
 * 4. **`reviewAt` 到期即停止注入**（§10.2「带时效的结论，如『这学期』」）。到期只说明
 *    "该复核了"，不代表内容是错的：所以它照常可检索、可在管理页看到，只是**不再自动进提示词**。
 *    默认注入过期结论的风险，比"这次没想起来"大得多（错记忆的代价见 §10.6）。
 *
 * 5. **`inject()` 的命中文数回报是"发了不等"**：契约 §10.7 要求命中即累加 `useCount`，
 *    而调用方（chat-service）明确要求记忆坏了不能让对话不可用、更不能阻塞这一轮。
 *    所以选择与返回同步完成，落盘在后台跑，失败只记日志。
 */

import { promises as fs } from 'node:fs';

import { HttpError } from '../../core/http/router.js';
import { ERROR_CODES } from '../../shared/constants.js';

/** 正文上限：超过 200 字直接 400（§10.2 的 `text`：1~200 字）。 */
export const MAX_TEXT_CHARS = 200;
/** `key` 的口径：小写字母 / 数字 / 下划线，≤ 40（§10.3）。 */
export const MAX_KEY_CHARS = 40;
// 校验正则从上限推出来：口径只有一处，改 MAX_KEY_CHARS 不会漏掉这里
const KEY_RE = new RegExp(`^[a-z0-9_]{1,${MAX_KEY_CHARS}}$`);
/** `scope` 的三种形态（§10.3）。`course:` 的 id **不做存在性校验**：课程可能还没同步。 */
const SCOPE_RE = /^(global|course:[^\s:]{1,64}|module:[a-z][a-z0-9-]*)$/;
/** 结构化值的体积上限：value 是"便于稳定复用"的辅助字段，不该变成第二个正文。 */
const MAX_VALUE_CHARS = 2000;
const MAX_SOURCE_REF_CHARS = 1000;

export const MEMORY_KINDS = Object.freeze(['fact', 'preference', 'constraint', 'episodic', 'decision']);
export const MEMORY_SOURCES = Object.freeze(['user', 'ai', 'import']);
export const MEMORY_STATUSES = Object.freeze(['active', 'superseded', 'archived', 'rejected']);

/** `kind` 的中文标签：给 explain / 管理页用，别再各写一份。 */
export const KIND_LABEL = Object.freeze({
  fact: '事实',
  preference: '偏好',
  constraint: '限制',
  episodic: '经历',
  decision: '取舍',
});

/**
 * 注入排序的 kind 权重（§10.7）：`constraint 1.0 > preference 0.9 > fact 0.8 > decision 0.6`。
 * `episodic` 权重 0 —— 它在契约里**不注入**（一次性经历只走检索）。
 */
export const KIND_WEIGHT = Object.freeze({
  constraint: 1,
  preference: 0.9,
  fact: 0.8,
  decision: 0.6,
  episodic: 0,
});

/** 注入预算默认值（§10.7：≤ 8 条 / ≤ 600 字），与 chat-service 的 DEFAULT_MEMORY_BUDGET 同口径。 */
export const DEFAULT_BUDGET = Object.freeze({ maxItems: 8, maxChars: 600 });
/** 预算夹紧区间：调用方传错（0 / 负数 / 巨大）时不许把提示词撑爆。 */
const MAX_BUDGET_ITEMS = 50;
const MAX_BUDGET_CHARS = 5000;
/** 新鲜度半衰期：90 天（§10.7）。 */
const HALF_LIFE_DAYS = 90;

/**
 * 列表接口的条数口径：默认 50，上限 500。
 *
 * 上限取 §10.9 给的量级（"记忆量级 <500 条"）—— 管理页要能一次拉完做分组与计数，
 * 超过这个数就该翻页而不是继续放大 limit。
 */
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

/**
 * 敏感信息模式（§10.5）：命中直接 400 + `details.reason = "sensitive_content"`。
 *
 * 顺序即优先级：18 位身份证同时满足 16~19 位数字的"银行卡"，先报身份证更准确。
 * 这些正则刻意**保守**（宁可放过"我的学号是 2023123456"这种普通数字，
 * 也不要把"我习惯晚上 19:00 学习"误判成敏感信息）：误杀的代价是用户再也记不住任何
 * 带数字的偏好，而记忆被拒时用户看得到理由，可以换句话再说一次。
 */
const SENSITIVE_PATTERNS = [
  { reason: 'id_card', re: /(?<!\d)\d{17}[\dXx](?!\d)|(?<!\d)\d{15}(?!\d)/ },
  { reason: 'bank_card', re: /(?<!\d)\d{16,19}(?!\d)/ },
  // 「学号 + 密码」放在通用的 password 之前：两者都命中时，报更具体的那个原因更好排查
  { reason: 'student_id_password', re: /(学号|考生号|准考证号)\D{0,6}\d{6,}\D{0,12}(密码|口令)/ },
  { reason: 'password', re: /(密码|口令|passwd|password|passcode)\s*(是|为|:|：|=)?\s*\S{4,}/i },
  { reason: 'sms_code', re: /(验证码|校验码|动态码|短信码|verification\s*code|otp)\s*(是|为|:|：|=)?\s*\d{4,8}/i },
];

/** 归一化：全角转半角 → 去空白/标点 → 小写（§10.3 的 text 去重口径）。 */
function toHalfWidth(text) {
  return String(text)
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

export function normalizeText(text) {
  return toHalfWidth(text)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 命中敏感模式时返回原因，否则 undefined。 */
export function sensitiveReason(text) {
  const raw = String(text ?? '');
  for (const { reason, re } of SENSITIVE_PATTERNS) if (re.test(raw)) return reason;
  return undefined;
}

/**
 * `key` 的**归一化**（写入路径专用，**永不抛错**）。
 *
 * 为什么不合法就 400（真机缺陷 S5 的教训）：
 * 用户说"记住我周三下午不方便安排学习任务"，模型据实写下 `key: "周三下午不便安排学习"`
 * 是完全自然的反应 —— 而 key 只是**内部去重句柄**，不是用户说的内容。为它的格式把整条记忆
 * 拒掉，用户看到的就是"我说了记住，卡点一按就报错"，真正要记的那件事一个字都没落地。
 * 该不该拒绝的标准是"这条结论该不该被记住"，不是"它的句柄长得对不对"。
 * 所以这里只做**降级**，并把降级结果如实回报给调用方（`keyAdjusted`）。
 *
 * 降级规则（对齐 §10.3 的口径）：
 * - 能用的片段（`[A-Za-z0-9_]`）保留并小写：`Bad_Key` → `bad_key`；
 * - 中文 / 空格 / 标点 / 表情一律丢弃，**不猜拼音**：猜错会得到一个语义不同的键，
 *   下次同键写入就会把两条毫不相干的记忆串成一条（取代链上留的还是错证据）。
 *   宁可真降级成"没有键"—— 无键按 §10.3 的 `scope + 归一化 text` 去重，语义依然正确；
 * - 超过 40 字符截断（截断后再去掉尾部下划线，别留下 `xxx_` 这种半截样子）；
 * - 一个可用片段都没有 → `null`，即"无 key"。
 *
 * 降级**必须写进响应**（`keyAdjusted: {from, to, reason}`）：静默把 key 换成另一个值，
 * 等于下一次写入时在另一条记忆上覆盖，比报错更难查。合法 key 原样返回且**不报** keyAdjusted
 * （调用方据此判断"服务端没动过它"）。
 *
 * @returns {{ key: string|null, keyAdjusted: {from: string|null, to: string|null, reason: string}|null }}
 */
export function normalizeKey(raw) {
  if (raw === undefined || raw === null) return { key: null, keyAdjusted: null };

  // 标量（数字/布尔）可以当字符串用：数字键本来就合法。
  // 对象/数组显然是调用方写错了 —— 降级成"无键"，而不是把它 JSON 化成一个荒唐的键。
  let from;
  if (typeof raw === 'string') from = raw.trim();
  else if (typeof raw === 'number' && Number.isFinite(raw)) from = String(raw);
  else if (typeof raw === 'boolean') from = String(raw);
  else return { key: null, keyAdjusted: { from: null, to: null, reason: 'not_a_text_key' } };

  if (from === '') return { key: null, keyAdjusted: null };
  if (KEY_RE.test(from)) return { key: from, keyAdjusted: null };

  let key = (from.match(/[A-Za-z0-9_]+/g) ?? [])
    .join('_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  let truncated = false;
  if (key.length > MAX_KEY_CHARS) {
    key = key.slice(0, MAX_KEY_CHARS).replace(/_+$/, '');
    truncated = true;
  }
  if (!key) key = null;

  const reasons = [];
  if (key === null) reasons.push('no_usable_chars');
  if (/[^A-Za-z0-9_]/.test(from)) reasons.push('illegal_chars_dropped');
  if (/[A-Z]/.test(from)) reasons.push('uppercase_lowercased');
  if (truncated) reasons.push('too_long_truncated');

  return { key, keyAdjusted: { from, to: key, reason: reasons.join('+') } };
}

/** 路由层复用同一套 scope / key 口径：**查询参数**写错了要 400，而不是静默返回空列表。 */
export const isValidScope = (value) => typeof value === 'string' && SCOPE_RE.test(value);
export const isValidKey = (value) => typeof value === 'string' && KEY_RE.test(value);

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// ---------------------------------------------------------------- 字段校验
// 校验放在服务层（而不是路由层）：路由与指令处理器（commands.js）是两条入口，
// 规则只写一份，才不会出现"从指令进来的记忆绕过了 200 字上限"这种事。

function fail(field, message, extra) {
  throw HttpError.badRequest(`字段 ${field} 不合法：${message}`, { field, ...extra });
}

function requiredText(value, { max = MAX_TEXT_CHARS, field = 'text' } = {}) {
  if (typeof value !== 'string' || !value.trim()) fail(field, '必填且不能为空');
  const text = value.trim();
  // 字数 = JS 字符串长度：与 chat-service 统计 usedChars 的口径一致，两处不能各算一套
  if (text.length > max) fail(field, `长度不能超过 ${max} 字（收到 ${text.length}）`);
  return text;
}

function optionalScope(value, { fallback = 'global' } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !SCOPE_RE.test(value)) {
    fail('scope', '必须是 global / course:<课程 id> / module:<模块 id>');
  }
  return value;
}

function optionalKind(value, { fallback = 'fact' } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!MEMORY_KINDS.includes(value)) fail('kind', `取值必须是 ${MEMORY_KINDS.join(' / ')} 之一`);
  return value;
}

/**
 * `key` 字段：**不合法不再 400，而是降级**（理由见 `normalizeKey`）。
 * 这里只取归一化后的键；要不要把降级告诉调用方由各入口自己决定（它们才拿得到原始的 key）。
 */
function optionalKey(value) {
  return normalizeKey(value).key;
}

function optionalValue(value) {
  if (value === undefined || value === null) return null;
  const type = typeof value;
  const scalar = type === 'string' || type === 'boolean' || (type === 'number' && Number.isFinite(value));
  if (!scalar && !isPlainObject(value) && !Array.isArray(value)) {
    fail('value', '必须是 JSON 值（字符串/数字/布尔/对象/数组/null）');
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail('value', '必须是 JSON 值（字符串/数字/布尔/对象/数组/null）');
  if (encoded.length > MAX_VALUE_CHARS) fail('value', `结构化值过大（上限 ${MAX_VALUE_CHARS} 字符）`);
  return clone(value);
}

function optionalSourceRef(value) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) fail('sourceRef', '必须是对象，如 {"messageId":"m-183"}');
  const encoded = JSON.stringify(value);
  if (encoded.length > MAX_SOURCE_REF_CHARS) fail('sourceRef', `过大（上限 ${MAX_SOURCE_REF_CHARS} 字符）`);
  return clone(value);
}

function optionalConfidence(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 1) fail('confidence', '取值范围 0~1');
  return num;
}

function optionalStatus(value, { fallback } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!MEMORY_STATUSES.includes(value)) fail('status', `取值必须是 ${MEMORY_STATUSES.join(' / ')} 之一`);
  return value;
}

/**
 * `reviewAt`：接受 `YYYY-MM-DD`（按天）或 ISO 8601 时刻；`null` / `''` 表示"不用复核"。
 *
 * 两种粒度都原样保留：日期粒度写成 `2027-01-15`，时刻粒度写成带时区的 ISO。
 * 用严格正则而不是直接 `new Date(value)`：`2026/01/15`、`Jan 15 2027` 这类"V8 恰好能解析"
 * 的写法不该混进数据里 —— 存储层的时间口径已经是 ISO，混着来迟早有人按字符串比较。
 */
const REVIEW_AT_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function optionalReviewAt(value, { field = 'reviewAt' } = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') fail(field, '必须是 YYYY-MM-DD 或 ISO 8601 时刻，或用 null 清空');
  const text = value.trim();
  if (!REVIEW_AT_RE.test(text)) fail(field, '必须是 YYYY-MM-DD 或 ISO 8601 时刻，或用 null 清空');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    // 按 UTC 解析只为"这个日期真实存在吗"（2026-02-30 会被 Date 滚到 3 月）：
    // 用本地时间解析会被时区推到前后一天，把合法的日期误判成非法。
    const parsed = new Date(`${text}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) fail(field, '不是一个真实存在的日期');
    return text;
  }
  if (Number.isNaN(new Date(text).getTime())) fail(field, '不是一个合法的时刻');
  return text;
}

/** `reviewAt` 是否已到期待复核：日期粒度按"那天结束"算，时刻粒度按时刻比。 */
export function isReviewDue(reviewAt, now = new Date()) {
  if (!reviewAt) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(reviewAt)) return now.toISOString().slice(0, 10) > reviewAt;
  return new Date(reviewAt).getTime() <= now.getTime();
}

/** 新鲜度：按 `lastUsedAt ?? updatedAt` 做 90 天半衰期衰减（§10.7）。 */
export function freshnessOf(item, now = new Date()) {
  const anchor = item.lastUsedAt ?? item.updatedAt ?? item.createdAt;
  const at = anchor ? new Date(anchor).getTime() : Number.NaN;
  if (Number.isNaN(at)) return 1;
  const days = Math.max(0, (now.getTime() - at) / 86400000);
  return 0.5 ** (days / HALF_LIFE_DAYS);
}

/** 注入得分：kind 权重 × confidence × 新鲜度（§10.7）。 */
export function scoreOf(item, now = new Date()) {
  const weight = KIND_WEIGHT[item.kind] ?? 0;
  const confidence = Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 1;
  return weight * confidence * freshnessOf(item, now);
}

/**
 * 取"首句"：只认真正的句末标点（。！？；!?; 与换行）。
 * 找不到句末标点就返回整句 —— 宁可告诉调用方"放不下"，也不从中间切断一句话。
 */
export function firstSentence(text) {
  const match = String(text).match(/^[\s\S]*?[。！？；!?;\n]/);
  return match ? match[0].trim() : String(text).trim();
}

/**
 * 记忆服务。
 *
 * 构造收 `{ store, broadcast, now }`：`now` 可注入（测试复核/衰减时不必改系统时钟）。
 */
export class MemoryService {
  constructor({ store, broadcast, now } = {}) {
    this.store = store;
    this.broadcast = broadcast;
    this.now = typeof now === 'function' ? now : () => new Date();
    /** inject() 的后台命中回报：测试与关闭前可以 await flush() 等它们落盘。 */
    this.pending = new Set();
    /** 本服务所有落盘动作的串行队列（理由见 #serialize）。 */
    this.writes = Promise.resolve();
  }

  get collection() {
    return this.store.memories;
  }

  /**
   * 把一次落盘排进串行队列。
   *
   * 为什么需要：`JsonStore.persist()` 用**固定名字**的临时文件（`<文件>.<pid>.tmp`），
   * 而它的排队逻辑只等"调用那一刻的上一个写入"。同一 tick 发起两次写入时，两个 persist
   * 会写到同一个临时文件，先完成的那次 rename 之后，后一次就 rename 到一个不存在的文件
   * （ENOENT，写入丢失）。命中回报天生是后台并发的（两轮对话同时注入同一条记忆），
   * 所以这一层自己排一次队 —— 记忆的写入量很小，串行没有任何代价。
   */
  #serialize(run) {
    const task = this.writes.then(run, run);
    this.writes = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  #nowIso() {
    return this.now().toISOString();
  }

  #changed(action, id, extra = {}) {
    this.broadcast?.({
      type: 'data_changed',
      module: 'memory',
      payload: { module: 'memory', target: 'memory', action, ...(id ? { id } : {}), ...extra },
    });
  }

  // ---------------------------------------------------------------- 读取

  /**
   * 列表 / 检索（§10.5 的 `GET /memories`）。
   *
   * **默认不过滤 `status`**：管理页要看全生命周期（superseded 链、archived、rejected），
   * 「提议前查同 scope+key 是否已被否决」（§10.4）也只有不过滤才查得到。
   */
  list({
    scope,
    kind,
    status,
    key,
    q,
    keyword,
    limit = DEFAULT_LIST_LIMIT,
    offset = 0,
    dueReview = false,
    includeSuperseded,
  } = {}) {
    const needle = normalizeText(q ?? keyword ?? '');
    const statusFilter = status
      ? String(status)
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : includeSuperseded === false
        ? ['active']
        : null;

    const now = this.now();
    /** 唯一的过滤口径：`withStatus: false` 时忽略 status（分组计数用，见下）。 */
    const keep = (item, withStatus = true) => {
      if (scope && item.scope !== scope) return false;
      if (kind && item.kind !== kind) return false;
      if (key && item.key !== key) return false;
      if (withStatus && statusFilter && !statusFilter.includes(item.status)) return false;
      if (dueReview && !isReviewDue(item.reviewAt, now)) return false;
      if (needle) {
        const haystack = normalizeText(`${item.text ?? ''} ${item.key ?? ''} ${item.scope ?? ''} ${JSON.stringify(item.value ?? '')}`);
        if (!haystack.includes(needle)) return false;
      }
      return true;
    };

    const all = this.collection.all();
    const matched = all.filter((item) => keep(item));

    // 最近的改动排前面：管理页与"刚刚记的那条"都按这个找
    matched.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));

    const total = matched.length;
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    const size = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(Number(limit) || DEFAULT_LIST_LIMIT)));

    /**
     * 分组计数：**故意忽略 `status` 过滤**，其余条件照旧。
     *
     * 管理页的筛选页签要在"只看生效中"的时候仍然显示另外三类的条数（否则一点筛选，
     * 其它数字就全归零，看不出还有多少被取代/被否决的）。放服务层算，是为了和
     * `status` 语义只维护一份。
     */
    const counts = Object.fromEntries(MEMORY_STATUSES.map((name) => [name, 0]));
    counts.total = 0;
    for (const item of all) {
      if (!keep(item, false)) continue;
      counts[item.status] = (counts[item.status] ?? 0) + 1;
      counts.total += 1;
    }

    return {
      count: total,
      counts,
      items: matched.slice(start, start + size),
      filters: {
        scope: scope ?? null,
        kind: kind ?? null,
        status: statusFilter ? statusFilter.join(',') : null,
        key: key ?? null,
        q: q ?? keyword ?? null,
        dueReview: Boolean(dueReview),
        limit: size,
        offset: start,
      },
    };
  }

  /** 取一条，不存在一律 404（`PATCH`/`DELETE`/`use` 共用）。 */
  get(id) {
    const item = this.collection.get(String(id ?? ''));
    if (!item) throw HttpError.notFound(`记忆不存在：${id}`);
    return item;
  }

  /** 同 `scope + key` 的当前 `active` 条（覆盖判定、冲突提示、提议查重都用它）。 */
  activeByKey(scope, key) {
    if (!key) return undefined;
    return this.collection.find((item) => item.scope === scope && item.key === key && item.status === 'active')[0];
  }

  /** 同 `scope + 归一化 text` 的 `active` 条（无 key 时的去重口径，§10.3）。 */
  activeByText(scope, text) {
    const needle = normalizeText(text);
    return this.collection.find((item) => item.scope === scope && item.status === 'active' && normalizeText(item.text) === needle)[0];
  }

  // ---------------------------------------------------------------- 写入

  /**
   * 校验 + 归一化写入字段（**不落库**）。
   *
   * 单独抽出来的理由有二：`dryRun` 要能只校验（§2.4）；`propose()` 要能复用同一条校验
   * —— 否则"提议时放行、确认时才 400"会让用户点了一次确认却什么也没发生。
   */
  validate(input = {}, { defaultSource = 'user' } = {}) {
    const source = input.source === undefined || input.source === null || input.source === ''
      ? defaultSource
      : input.source;
    if (!MEMORY_SOURCES.includes(source)) fail('source', `取值必须是 ${MEMORY_SOURCES.join(' / ')} 之一`);

    const text = requiredText(input.text);
    // 敏感信息拦在这里：它是唯一同时覆盖 REST、指令、提议三条入口的地方（§10.5）
    const reason = sensitiveReason(`${text} ${input.value === undefined || input.value === null ? '' : JSON.stringify(input.value)}`);
    if (reason) {
      throw HttpError.badRequest('这条内容包含敏感信息，不能作为长期记忆保存', {
        field: 'text',
        reason: 'sensitive_content',
        pattern: reason,
      });
    }

    const scope = optionalScope(input.scope);
    const kind = optionalKind(input.kind);
    // `key` 不合法时**降级**而不是 400（理由见 normalizeKey）：这里给出的仍是最终要落库的字段。
    // 降级明细由各入口自己取（`#write` / `propose` / 指令处理器）—— 只有它们拿得到调用方原始的 key。
    const key = optionalKey(input.key);
    return {
      scope,
      kind,
      key,
      text,
      value: optionalValue(input.value),
      source,
      sourceRef: optionalSourceRef(input.sourceRef),
      // §10.2：`source: "user"` 的 confidence **恒为 1**（用户自己说的，没有"可能"）。
      // 放在校验层而不是各入口：否则调用方随手传一个 0.3 就会让管理页显示"用户说的，置信度 30%"。
      confidence: source === 'user' ? 1 : optionalConfidence(input.confidence, 0.7),
      reviewAt: optionalReviewAt(input.reviewAt) ?? null,
    };
  }

  /**
   * 显式写入（§10.5 的 `POST /memories`），`source` **固定 `user`**。
   *
   * 请求体里给 `source: "ai"` 也没用：这条路径代表"用户明说记住"，
   * 模型推断的东西只能走 `propose()`（§10.6 的硬规则）。
   *
   * @param {object} input
   * @param {boolean} [input.replace] 带 `true` 时用新值取代同键旧条（旧条转 superseded，不删除）
   * @returns {Promise<{ item: object, duplicated?: boolean, replaced?: object, keyAdjusted?: object }>}
   *   `keyAdjusted` 只在 key 被降级（见 `normalizeKey`）时出现：`{ from, to, reason }`。
   */
  async create(input = {}) {
    return this.#serialize(() =>
      this.#write({ ...input, source: 'user' }, { defaultSource: 'user', replace: Boolean(input.replace) }),
    );
  }

  /**
   * 指令路径的写入（`/commands/execute`，target `memory`）。
   *
   * 与 `create()` 的唯一差别：**尊重 `fields.source`**。用户确认一条 AI 提议时，
   * 落库的必须是 `source: "ai"`（§10.2：模型提议后经确认），而不是被改写成 user。
   *
   * `replace` 默认 **true**：这条路径只会在用户确认过那张草稿卡之后走到
   * （`propose()` 已经把冲突写进 `warnings`/`conflicts` 给用户看过），
   * 到这里再抛一次 409 只会让"我确认了"变成一句报错。要保留旧值就传 `replace: false`。
   */
  async createFromCommand(fields = {}, options = {}) {
    return this.#serialize(() =>
      this.#write(
        { ...fields, source: fields.source ?? 'ai' },
        {
          defaultSource: 'ai',
          replace: fields.replace === undefined ? true : Boolean(fields.replace),
          confidence: options.confidence,
        },
      ),
    );
  }

  /**
   * 真正的写入：去重 → 覆盖链 → 落库 → 广播。
   *
   * 三条规则来自 §10.3：
   * - 有 `key`：同 `scope + key` 已有 `active` 条 → 旧条转 `superseded`（`supersededBy` 指向新条），
   *   **不删**；不带 `replace` 时先 409 让用户选（§10.5 的冲突必须让用户决定）；
   * - 无 `key`：按 `scope + 归一化 text` 去重，完全相同即幂等（返回既有条 + `duplicated: true`）；
   * - 同键**同文**也按幂等处理：这是"重复调了一次接口"，不是"改了主意"，
   *   端一张冲突卡让用户在两个一模一样的东西之间选，只会让人不再信任这个功能。
   */
  async #write(input = {}, { defaultSource = 'user', replace = false, confidence } = {}) {
    const fields = this.validate({ ...input, confidence: confidence ?? input.confidence }, { defaultSource });
    // key 被降级过就必须回报（见 normalizeKey）：调用方要能看出"服务端动过这个键"，
    // 否则它下次还拿原来那个键来查，永远查不到自己刚写下的那条。
    const { keyAdjusted } = normalizeKey(input.key);
    const adjusted = keyAdjusted ? { keyAdjusted } : {};
    const existing = fields.key ? this.activeByKey(fields.scope, fields.key) : this.activeByText(fields.scope, fields.text);

    if (existing && normalizeText(existing.text) === normalizeText(fields.text)) {
      return { item: existing, duplicated: true, ...adjusted };
    }
    if (existing && !replace) {
      throw HttpError.conflict('已存在同键记忆', {
        existing: { id: existing.id, text: existing.text, kind: existing.kind, scope: existing.scope, updatedAt: existing.updatedAt },
        hint: '带 "replace": true 表示用新值取代旧值（旧条转 superseded，不删除）；否则请让用户确认后重试',
      });
    }

    // 取代链：先写新条再改旧条，中间任何一步失败都不会留下"两条 active 同键"
    const created = await this.collection.insert({
      ...fields,
      status: 'active',
      supersededBy: null,
      useCount: 0,
      lastUsedAt: null,
    });
    if (existing) {
      await this.collection.update(existing.id, { status: 'superseded', supersededBy: created.id });
    }
    this.#changed('create', created.id, existing ? { superseded: existing.id } : {});
    return existing
      ? { item: created, replaced: { id: existing.id, text: existing.text }, ...adjusted }
      : { item: created, ...adjusted };
  }

  /**
   * 提议（§10.5 的 `POST /memories/propose`）：**只产出草稿，一个字都不落库**。
   *
   * 返回的 `draft` 形状与 §4.2 的指令对象完全一致（`target: "memory"`），
   * 前端可以直接复用草稿确认卡；用户点确认后走 `/commands/execute` —— 那才是落库的那一刻。
   *
   * 三种"不该再提"的情况在这里就地掐掉（§10.6）：
   * - 同 `scope + key` 已 `rejected` → **绝不重提**（返回 `suppressed: 'rejected'`）；
   * - 同 `scope + key` 已 `active` 且内容等价 → 不提（`suppressed: 'duplicate'`）；
   * - 内容等价但键不同（无 key 路径）→ 同样不提。
   * 已 `active` 但内容不同 → 照常给草稿，并带上 `conflicts` 与 `warnings` 提醒会和谁打架。
   *
   * `key` 不合法时不报错、只降级，并把 `keyAdjusted` 放进返回值**与草稿的 `warnings`**：
   * 确认卡是用户唯一能看见这张草稿的地方，"键被系统改过"必须在那里说得出来
   * （§10.6 的原则：模型不能悄悄替用户决定记成什么样）。
   */
  propose(input = {}) {
    const fields = this.validate({ ...input, source: 'ai' }, { defaultSource: 'ai' });
    const confidence = optionalConfidence(input.confidence, fields.confidence);
    const { keyAdjusted } = normalizeKey(input.key);
    const adjusted = keyAdjusted ? { keyAdjusted } : {};

    const rejected = fields.key
      ? this.collection.find((item) => item.scope === fields.scope && item.key === fields.key && item.status === 'rejected')[0]
      : undefined;
    if (rejected) {
      return {
        draft: null,
        suppressed: 'rejected',
        existing: rejected,
        conflicts: [],
        writes: false,
        explain: '这条建议此前已经被你否决过，不再提议。',
        ...adjusted,
      };
    }

    const existing = fields.key ? this.activeByKey(fields.scope, fields.key) : this.activeByText(fields.scope, fields.text);
    if (existing && normalizeText(existing.text) === normalizeText(fields.text)) {
      return {
        draft: null,
        suppressed: 'duplicate',
        existing,
        conflicts: [],
        writes: false,
        explain: '这条已经记过了，不重复提议。',
        ...adjusted,
      };
    }
    const archived = fields.key
      ? this.collection.find((item) => item.scope === fields.scope && item.key === fields.key && item.status === 'archived')[0]
      : undefined;

    const warnings = [];
    if (existing) warnings.push(`与已有记忆「${existing.text}」冲突`);
    if (archived) warnings.push(`同键记忆「${archived.text}」已被归档，确认后会新建一条 active`);
    if (keyAdjusted) {
      warnings.push(
        keyAdjusted.to
          ? `key 已自动调整为「${keyAdjusted.to}」（原值 ${JSON.stringify(keyAdjusted.from)}：key 只能用小写字母/数字/下划线、≤40 字符）`
          : `原 key ${JSON.stringify(keyAdjusted.from)} 里没有可用字符（只能用 a-z 0-9 _），已按"无 key"处理：改按正文去重`,
      );
    }

    return {
      draft: {
        ok: true,
        raw: input.raw ?? fields.text,
        action: 'create',
        target: 'memory',
        fields: {
          scope: fields.scope,
          kind: fields.kind,
          key: fields.key,
          text: fields.text,
          value: fields.value,
          // source 落在 fields 里（§4.2：fields 与数据模型同名字段一致），
          // 确认后才能真正记成"模型提议"（§10.2 的 source: "ai"）
          source: 'ai',
          sourceRef: fields.sourceRef,
          reviewAt: fields.reviewAt,
        },
        confidence,
        warnings,
        explain: `记下这条${KIND_LABEL[fields.kind] ?? '事实'}：${fields.text}`,
      },
      conflicts: existing ? [existing] : [],
      writes: false,
      ...adjusted,
    };
  }

  /**
   * 改正一条记忆（§10.5 的 `PATCH /memories/:id`）。
   *
   * 状态迁移的合法集合按 §10.4：
   * - `active / archived → active`（archived 可恢复）；
   * - `superseded → active` ❌ 会造出两条同键 active，契约给的恢复方式是"再写一条新的"；
   * - `rejected → active` ❌ 明确"不可逆为 active，只能新建"。
   *
   * `key` 与写入路径同口径：不合法就降级（见 `normalizeKey`），**不 400**。这条不能只改一半 ——
   * 指令路径的 dryRun 预览走的是 `validate()`（已经会降级），真写却 400 的话，
   * 用户点一张"预览说没问题"的确认卡就会失败，正是要修的那种"卡点点不动"。
   * 降级结果由路由 / 指令处理器用 `normalizeKey()` 放进响应（只有它们拿得到原始 patch）。
   */
  async update(id, patch = {}) {
    return this.#serialize(() => this.#applyUpdate(id, patch));
  }

  async #applyUpdate(id, patch) {
    const current = this.get(id);
    const next = {};

    if (patch.text !== undefined) next.text = requiredText(patch.text);
    if (patch.scope !== undefined) next.scope = optionalScope(patch.scope, { fallback: current.scope });
    if (patch.kind !== undefined) next.kind = optionalKind(patch.kind, { fallback: current.kind });
    // key 与写入路径同口径：不合法就降级而不是 400（理由见 normalizeKey）。
    // 这里写进 `next` 的是最终值；"降级明细"由调用方用 normalizeKey(patch.key) 自己取。
    if (patch.key !== undefined) next.key = optionalKey(patch.key);
    if (patch.value !== undefined) next.value = optionalValue(patch.value);
    if (patch.sourceRef !== undefined) next.sourceRef = optionalSourceRef(patch.sourceRef);
    if (patch.confidence !== undefined) {
      next.confidence = optionalConfidence(patch.confidence, current.confidence);
      // `source: "user"` 的记忆恒为 1（§10.2），改它没有意义
      if (current.source === 'user') next.confidence = 1;
    }
    if (patch.reviewAt !== undefined) next.reviewAt = optionalReviewAt(patch.reviewAt);

    const reason = sensitiveReason(`${next.text ?? current.text} ${JSON.stringify(next.value ?? current.value ?? '')}`);
    if (reason) {
      throw HttpError.badRequest('这条内容包含敏感信息，不能作为长期记忆保存', {
        field: 'text',
        reason: 'sensitive_content',
        pattern: reason,
      });
    }

    if (patch.status !== undefined) {
      const status = optionalStatus(patch.status, { fallback: current.status });
      if (status !== current.status) {
        if (status === 'active' && current.status !== 'active') {
          if (current.status === 'rejected') {
            throw HttpError.conflict('被否决的记忆不能恢复为 active（§10.4：不可逆，只能新建一条）', {
              id: current.id,
              status: current.status,
            });
          }
          if (current.status === 'superseded') {
            throw HttpError.conflict('被取代的记忆不能直接恢复为 active（会造出两条同键记忆），请写一条新的', {
              id: current.id,
              status: current.status,
              supersededBy: current.supersededBy,
            });
          }
        }
        next.status = status;
        // 重新激活时把取代指针清掉，否则会留下"active 但指向别人"的矛盾状态
        if (status === 'active') next.supersededBy = null;
      }
    }

    // 改成别的键/正文时，不能撞上另一条 active（同 scope + key 只允许一条 active）
    const nextKey = next.key !== undefined ? next.key : current.key;
    const nextScope = next.scope ?? current.scope;
    if (nextKey && nextKey !== current.key) {
      const clash = this.activeByKey(nextScope, nextKey);
      if (clash && clash.id !== current.id) {
        throw HttpError.conflict('已存在同键记忆', {
          existing: { id: clash.id, text: clash.text, scope: clash.scope },
          hint: '先改掉那条，或给这条换一个 key',
        });
      }
    }

    const updated = await this.collection.update(current.id, next);
    this.#changed('update', current.id);
    return updated;
  }

  /** 删除（§10.5 的 `DELETE /memories/:id`）：不可逆；同 key 允许重新提议。 */
  async remove(id) {
    return this.#serialize(async () => {
      const current = this.get(id);
      await this.collection.remove(current.id);
      this.#changed('delete', current.id);
      return { id: current.id, deleted: true };
    });
  }

  /**
   * 清空（§10.8）：**先备份再删**，沿用存储层对损坏文件的备份习惯。
   * 整体删除不可逆，没有备份的"一键清空"迟早会被点错一次。
   */
  async clear() {
    return this.#serialize(async () => {
      const items = this.collection.all();
      if (!items.length) return { deleted: 0, backup: null };
      const backup = await this.#backup();
      await this.collection.removeMany(items.map((item) => item.id));
      this.#changed('clear', null, { count: items.length });
      return { deleted: items.length, backup };
    });
  }

  /** 备份成 `memories.json.bak-<时间戳>`：与存储层的 `*.corrupt-<时间戳>` 同一套命名习惯。 */
  async #backup() {
    const filePath = this.collection.filePath;
    if (!filePath) return null;
    const stamp = this.#nowIso().replace(/[:.]/g, '-');
    const target = `${filePath}.bak-${stamp}`;
    try {
      await fs.copyFile(filePath, target);
      return target;
    } catch (error) {
      // 备份失败就不清空：宁可让用户先手动备份，也不做一次不可逆的删除
      throw new HttpError(500, ERROR_CODES.INTERNAL, `清空前备份失败：${error.message}`);
    }
  }

  /**
   * 命中回报（§10.5 的 `POST /memories/:id/use`）。
   *
   * 契约要求注入的那批自动累加 `useCount` / 刷新 `lastUsedAt` —— 这是后续淘汰的唯一依据。
   */
  async markUsed(id, { count = 1 } = {}) {
    return this.#serialize(() => this.#applyUse(id, count));
  }

  async #applyUse(id, count = 1) {
    const current = this.get(id);
    const step = Number.isFinite(Number(count)) && Number(count) > 0 ? Math.floor(Number(count)) : 1;
    const updated = await this.collection.update(current.id, {
      useCount: (Number(current.useCount) || 0) + step,
      lastUsedAt: this.#nowIso(),
    });
    return updated;
  }

  // ---------------------------------------------------------------- 注入

  /**
   * 候选筛选：全局恒参与；`course:` / `module:` 只在"当次话题落在它的作用域里"时参与（§10.3）。
   */
  #candidates({ view, module, courseId, includeEpisodic = false, includeDueReview = false } = {}) {
    const now = this.now();
    const active = this.collection.find((item) => item.status === 'active');
    let dueReview = 0;
    const pool = [];
    for (const item of active) {
      if (item.kind === 'episodic' && !includeEpisodic) continue;
      const scope = String(item.scope ?? 'global');
      if (scope.startsWith('course:')) {
        const id = scope.slice('course:'.length);
        if (courseId === undefined || courseId === null || String(courseId) !== id) continue;
      } else if (scope.startsWith('module:')) {
        const id = scope.slice('module:'.length);
        if (module !== id && view !== id) continue;
      } else if (scope !== 'global') {
        continue;
      }
      if (isReviewDue(item.reviewAt, now)) {
        dueReview += 1;
        if (!includeDueReview) continue;
      }
      pool.push({ item, score: scoreOf(item, now) });
    }
    pool.sort((a, b) => b.score - a.score || String(b.item.updatedAt ?? '').localeCompare(String(a.item.updatedAt ?? '')));
    return { pool, dueReview };
  }

  /**
   * 预算挑选（§10.7）：按分数从高到低逐条累计字数，直到条数或字数用满。
   *
   * 放不下时**先试着保留首句**（契约：超了先截 text、保首句），首句也放不下就整条不进
   * —— 这里刻意不从句子中间切断：半句话进提示词会让模型把残句当完整结论用。
   * `truncated: true` 表示"还有记忆没进来，需要时自己检索"。
   */
  #select({ maxItems, maxChars, keepFirstSentence = true, ...scope } = {}) {
    const items = Math.min(MAX_BUDGET_ITEMS, Math.max(1, Math.floor(Number(maxItems) || DEFAULT_BUDGET.maxItems)));
    const chars = Math.min(MAX_BUDGET_CHARS, Math.max(1, Math.floor(Number(maxChars) || DEFAULT_BUDGET.maxChars)));
    const { pool, dueReview } = this.#candidates(scope);

    const picked = [];
    let used = 0;
    let dropped = 0;
    for (const { item, score } of pool) {
      if (picked.length >= items) {
        dropped += 1;
        continue;
      }
      const text = String(item.text ?? '');
      if (used + text.length <= chars) {
        picked.push({ item, score, text, truncated: false });
        used += text.length;
        continue;
      }
      // 剩余预算里能放下完整首句才截断（末尾加 '…' 如实标注是残句），否则整条不进
      const sentence = firstSentence(text);
      const room = chars - used - 1;
      if (keepFirstSentence && sentence.length < text.length && sentence.length <= room && sentence.length > 0) {
        const clipped = `${sentence}…`;
        picked.push({ item, score, text: clipped, truncated: true });
        used += clipped.length;
        continue;
      }
      dropped += 1;
    }

    return {
      picked,
      budget: {
        maxItems: items,
        maxChars: chars,
        usedItems: picked.length,
        usedChars: used,
        candidates: pool.length + dueReview,
        dropped,
        dueReview,
      },
      truncated: dropped > 0 || picked.some((entry) => entry.truncated),
    };
  }

  /** 注入条目的对外形状：只带模型用得上的字段，别把整条记录塞进提示词。 */
  #present({ item, score, text, truncated }) {
    return {
      id: item.id,
      scope: item.scope,
      kind: item.kind,
      key: item.key ?? null,
      text,
      value: item.value ?? null,
      source: item.source,
      confidence: item.confidence,
      reviewAt: item.reviewAt ?? null,
      score: Number(score.toFixed(4)),
      truncated,
    };
  }

  /**
   * 按预算挑出要注入的记忆，**返回数组**。
   *
   * 纯选择：不写库、不回报命中、不抛异常 —— 给需要自己控制"什么时候算命中"的调用方
   * （例如设置页预览"模型现在能看到什么"）。
   *
   * @param {object} [options]
   * @param {number} [options.limit=8]    条数上限
   * @param {number} [options.chars=600]  字符上限（按 `text.length` 计，与 chat-service 同口径）
   * @param {string} [options.view]       当前视图 id（`module:<id>` 作用域的匹配依据之一）
   * @param {string} [options.module]     当前模块 id
   * @param {number|string} [options.courseId] 当次对话涉及的课程 id
   * @param {boolean} [options.keepFirstSentence=true] 放不下时是否允许保留首句
   * @returns {Array<{ id, scope, kind, key, text, value, source, confidence, reviewAt, score, truncated }>}
   */
  contextItems({
    limit = DEFAULT_BUDGET.maxItems,
    chars = DEFAULT_BUDGET.maxChars,
    view,
    module,
    courseId,
    includeEpisodic = false,
    includeDueReview = false,
    keepFirstSentence = true,
  } = {}) {
    const { picked } = this.#select({
      maxItems: limit,
      maxChars: chars,
      view,
      module,
      courseId,
      includeEpisodic,
      includeDueReview,
      keepFirstSentence,
    });
    return picked.map((entry) => this.#present(entry));
  }

  /**
   * 上下文注入入口（**chat-service 已按这个签名调用**，改签名等于改调用方）：
   * `services.memory.inject({ view, module, courseId, maxItems, maxChars })`。
   *
   * - 返回 `{ injected, truncated, budget, dueReview }`；`injected` 每项都带 `text`；
   * - 空记忆 / 没有匹配 / 任何异常都不抛：返回 `{ injected: [], truncated: false }`，
   *   记忆坏了不能让整轮对话不可用；
   * - 命中回报**发了不等**：契约要求累加 `useCount`，但不能让磁盘写在对话路径上阻塞或翻车。
   */
  async inject({ view, module, courseId, maxItems, maxChars, keepFirstSentence = true } = {}) {
    try {
      const { picked, budget, truncated } = this.#select({
        maxItems,
        maxChars,
        view,
        module,
        courseId,
        keepFirstSentence,
      });
      const injected = picked.map((entry) => this.#present(entry));
      if (injected.length) this.#reportHits(injected.map((item) => item.id));
      return { injected, truncated, budget, dueReview: budget.dueReview };
    } catch (error) {
      // 注入失败只降级，不把异常抛回对话路径（chat-service 也做了兜底，这里再兜一层）
      console.error('[memory] 上下文注入失败，已降级为空预算：', error.message);
      return {
        injected: [],
        truncated: false,
        budget: {
          maxItems: Number(maxItems) || DEFAULT_BUDGET.maxItems,
          maxChars: Number(maxChars) || DEFAULT_BUDGET.maxChars,
          usedItems: 0,
          usedChars: 0,
          candidates: 0,
          dropped: 0,
          dueReview: 0,
        },
        dueReview: 0,
        error: error.message,
      };
    }
  }

  /**
   * 后台回报命中：**逐条排进串行队列**，失败只记日志。
   *
   * - 不 await：调用方（chat-service）这一轮不等落盘，记忆坏了也不能影响回答；
   * - 走 `#serialize`：两轮对话同时注入同一条记忆时不会并发写同一个临时文件
   *   （见 `#serialize` 的注释），`flush()` 可以等它们全部落盘（测试 / 关闭前）。
   */
  #reportHits(ids) {
    const tasks = ids.map((id) =>
      this.#serialize(() => this.#applyUse(id, 1)).catch((error) => {
        console.error(`[memory] 命中回报失败 ${id}:`, error.message);
      }),
    );
    const task = Promise.all(tasks);
    this.pending.add(task);
    task.then(() => this.pending.delete(task));
    return task;
  }

  /** 等所有后台回报落盘：测试断言 useCount、以及进程退出前用。 */
  async flush() {
    await Promise.allSettled([...this.pending]);
    await this.writes.catch(() => {});
    return { pending: this.pending.size };
  }
}
