/**
 * AI 定时唤醒：把「时间 + 提示词」变成一次到点触发的对话。
 *
 * 用户口径只有一种任务：**通用定时任务**（例：每周一 08:00，提醒我预习周四的实验），
 * 不是什么"日程提醒"的变体 —— 所以这里只有 `at`（什么时候）+ `prompt`（说什么）。
 *
 * 为什么调度内核要写成"不依赖真实定时器"：
 * - 到点判定（`dueTasks`）与"下一次是什么时候"（`computeNextRun`）都是纯计算，
 *   测试可以直接喂任意 `now`，不用等一分钟、也不需要假时钟库；
 * - 真正的定时器只是「每分钟来问一次」的驱动，`start()` / `stop()` 由模块钩子调用；
 *   `unref()` + `stop()` 双保险，测试里反复装配模块也不会留下悬挂定时器把 `node --test` 挂住。
 *
 * 与聊天层的边界（**重要**）：
 * 本文件只负责「什么时候该响、响了没有、下次什么时候响」，**不自己发起模型调用**。
 * 真正的调用由外部通过 `setRunner(fn)` 注入（接线点在 chat-service 一侧，跑一次
 * `ai.send({ text: task.prompt, conversationId: task.conversationId })` 即可：消息落库、
 * 会话 messageCount/lastMessageAt、token 用量统计、`ai_message` 广播全都顺带就有了）。
 * 这样调度内核可以独立测试，也不会把多轮循环那套敏感逻辑复制第二份。
 *
 * 没注入 runner 时到点**只记录、不执行、不推进**（见 `tick`）：既不抛异常拖垮后端，
 * 也保证"接线之后这一次仍然会跑"，而不是被一个空跑悄悄吃掉。
 *
 * 时间口径：`HH:MM` 与 ISO 都按**本地时区**解释（和 `shared/time.js` 一致）；
 * 落库的 `nextRunAt` / `lastRunAt` 是 `Date#toISOString()`（UTC 带 Z），便于字符串比较与排序。
 */

import { HttpError } from '../../core/http/router.js';
import { isClock } from '../../shared/time.js';

/** 一次提示词最多多少字（超了 400，不静默截断：用户写的东西不能被悄悄改短）。 */
export const SCHEDULE_PROMPT_MAX = 2000;
/** 任务名上限（只用于列表展示，空了就从提示词开头取）。 */
export const SCHEDULE_LABEL_MAX = 120;
/** 会话 id 是 UUID，给个宽松上限挡住明显的脏数据。 */
const CONVERSATION_ID_MAX = 200;
/** 支持的三类重复：每天 / 每周（指定星期几）/ 只响一次。 */
export const SCHEDULE_REPEATS = Object.freeze(['daily', 'weekly', 'once']);
/** 未注入 runner 时的固定说法（测试与前端都按它判断"还没接线"）。 */
export const NO_RUNNER_MESSAGE = '调度执行器尚未接线（setRunner）';
/** 默认每分钟检查一次（需求："最多每分钟检查一次"）。 */
export const DEFAULT_CHECK_INTERVAL_MS = 60_000;
/**
 * 错过多久就不再补跑。
 *
 * 笔记本合盖一夜再打开时，08:00 那条提醒不该在 15:00 突然炸出来（用户已经不需要它了），
 * 所以超过这个窗口的到点任务只把 `nextRunAt` 推到未来并记一条说明；窗口内的（比如后端刚重启）
 * 照常补跑一次。
 */
export const DEFAULT_CATCH_UP_MS = 10 * 60_000;

/** 可写字段白名单：接口不能往里塞任意键。 */
export const SCHEDULE_FIELDS = Object.freeze([
  'label',
  'prompt',
  'at',
  'repeat',
  'weekdays',
  'enabled',
  'conversationId',
  'search',
]);

/**
 * 定时任务到点时的联网档位（与前端输入框下面那个地球图标同一套取值）。
 *
 * 为什么任务自己带一个而不是沿用界面上当前的选择：到点的时候用户多半不在，
 * "现在界面上选的是什么"跟这条任务该不该联网毫无关系。默认 `off` ——
 * 后台悄悄联网不符合这个程序一贯的显式风格；要"每天帮我搜最新通知"的任务
 * 就显式选 `web` / `campus`，用户知道自己在授权什么。
 */
export const SCHEDULE_SEARCH_MODES = Object.freeze(['off', 'web', 'campus']);

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const pad2 = (n) => String(n).padStart(2, '0');

/** `Date` -> 本地 `HH:MM`。 */
function clockOf(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 某一天的 `HH:MM`（本地零点由构造器处理，跨月 / 跨年 / 闰日都不用自己算）。 */
function clockOn(date, clock) {
  const [hour, minute] = clock.split(':').map(Number);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
}

/** 加减天数，保留时分秒（本地日历运算，自动处理月末与闰日）。 */
function shiftDays(date, days) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * ISO 口径的星期：1=周一 … 7=周日。
 *
 * 用它而不是 `Date#getDay()`（0=周日）：需求里的 `weekdays` 是 1–7，
 * 两套编号混用一定会有人写错，所以对外只暴露这一套。
 */
export function isoWeekday(date) {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

/**
 * 解析 `at`：`HH:MM`（每天/每周重复的时刻）或 ISO 时间点（`2026-03-05T08:00`、带时区的 ISO）。
 *
 * @returns {{ clock: string, absolute: Date|null }|null} 不合法返回 null（由调用方决定是 400 还是跳过）
 */
export function parseAt(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (isClock(text)) return { clock: text, absolute: null };
  // ISO 时间点：只认「带日期 + 时分」的完整写法，避免把 '08:00:00' 之类半截输入当成合法值
  if (ISO_DATETIME_RE.test(text)) {
    const absolute = new Date(text);
    if (!Number.isNaN(absolute.getTime())) return { clock: clockOf(absolute), absolute };
  }
  return null;
}

/** 星期列表归一：去重 + 升序；非法值抛 400（不静默丢弃，否则用户以为设上了）。 */
function readWeekdays(value) {
  if (!Array.isArray(value)) {
    throw HttpError.badRequest('weekdays 必须是数组（1=周一 … 7=周日）', { field: 'weekdays' });
  }
  const days = new Set();
  for (const item of value) {
    const day = typeof item === 'number' ? item : Number(item);
    if (!Number.isInteger(day) || day < 1 || day > 7) {
      throw HttpError.badRequest(`weekdays 只能是 1~7 的整数（1=周一 … 7=周日），收到 ${JSON.stringify(item)}`, {
        field: 'weekdays',
      });
    }
    days.add(day);
  }
  return [...days].sort((a, b) => a - b);
}

/** 只读归一（不抛异常）：给纯函数用，脏数据当"没有"处理。 */
function safeWeekdays(value) {
  if (!Array.isArray(value)) return [];
  const days = new Set();
  for (const item of value) {
    const day = Number(item);
    if (Number.isInteger(day) && day >= 1 && day <= 7) days.add(day);
  }
  return [...days].sort((a, b) => a - b);
}

/** 重复类型归一：不认识的一律按 daily（纯函数里不抛异常）。 */
function safeRepeat(value) {
  return SCHEDULE_REPEATS.includes(value) ? value : 'daily';
}

/**
 * 下一次该在什么时候响（**纯函数**）。
 *
 * 幂等的关键：只看 `at` / `repeat` / `weekdays` 和 `now`，**不看** `nextRunAt` / `lastRunAt` ——
 * 同一个 `now` 反复调用结果完全一样，所以"同一分钟里被问两次"不会算出两个不同的下一次。
 * 候选时刻一律要求**严格晚于** `now`（不是 `>=`）：正好卡在 08:00:00.000 时算明天，
 * 这样 `markRun` 之后同一时刻再问就必然不再到点。
 *
 * @param {object} task 任务记录（至少要有 at / repeat / weekdays）
 * @param {Date} [now] 参照时刻
 * @returns {string|null} 下一次的 ISO 时间；不可能再有下一次时返回 null（once 已过期、weekly 没给星期）
 */
export function computeNextRun(task, now = new Date()) {
  const at = parseAt(task?.at);
  if (!at || !(now instanceof Date) || Number.isNaN(now.getTime())) return null;
  const repeat = safeRepeat(task?.repeat);

  if (repeat === 'once') {
    // 绝对时间点：过了就是"没有下一次"（创建时会被 400 挡掉，见 assertFutureOnce）
    if (at.absolute) return at.absolute.getTime() > now.getTime() ? at.absolute.toISOString() : null;
    // 只给了 HH:MM：按闹钟直觉 —— 今天这个点还没到就是今天，过了就是明天
    const today = clockOn(now, at.clock);
    if (today.getTime() > now.getTime()) return today.toISOString();
    return clockOn(shiftDays(now, 1), at.clock).toISOString();
  }

  if (repeat === 'weekly') {
    const days = safeWeekdays(task?.weekdays);
    if (!days.length) return null;
    // 从今天起最多找 8 天：今天这个点没过就算今天，过了就顺延到下一个命中的星期
    for (let offset = 0; offset <= 7; offset += 1) {
      const day = shiftDays(now, offset);
      if (!days.includes(isoWeekday(day))) continue;
      const candidate = clockOn(day, at.clock);
      if (candidate.getTime() > now.getTime()) return candidate.toISOString();
    }
    return null; // 理论上到不了（7 天内必有命中），留作兜底
  }

  // daily
  const today = clockOn(now, at.clock);
  if (today.getTime() > now.getTime()) return today.toISOString();
  return clockOn(shiftDays(now, 1), at.clock).toISOString();
}

/**
 * 校验并归一「要写入的字段」。
 *
 * 分成 create / patch 两种模式：patch 只处理**出现的**字段（没出现的保持原值），
 * 但 repeat 与 weekdays 的**组合**必须拿"改完之后的样子"来判（所以这里收 base）。
 */
function readFields(body, { partial, base = {} } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw HttpError.badRequest('请求体必须是 JSON 对象');
  }
  const keys = Object.keys(body);
  const unknown = keys.filter((key) => !SCHEDULE_FIELDS.includes(key));
  if (unknown.length) {
    throw HttpError.badRequest(`不认识的字段：${unknown.join('、')}`, { fields: unknown });
  }
  if (partial && !keys.length) throw HttpError.badRequest('至少要提供一个要修改的字段');
  if (!partial && !('prompt' in body)) throw HttpError.badRequest('缺少 prompt（要发给 AI 的提示词）', { field: 'prompt' });
  if (!partial && !('at' in body)) throw HttpError.badRequest('缺少 at（HH:MM 或 ISO 时间）', { field: 'at' });

  const fields = {};

  if ('prompt' in body) {
    if (typeof body.prompt !== 'string') throw HttpError.badRequest('prompt 必须是字符串', { field: 'prompt' });
    const prompt = body.prompt.trim();
    if (!prompt) throw HttpError.badRequest('prompt 不能为空', { field: 'prompt' });
    if (prompt.length > SCHEDULE_PROMPT_MAX) {
      throw HttpError.badRequest(`prompt 最长 ${SCHEDULE_PROMPT_MAX} 字，收到 ${prompt.length} 字`, {
        field: 'prompt',
        max: SCHEDULE_PROMPT_MAX,
      });
    }
    fields.prompt = prompt;
  }

  if ('at' in body) {
    const at = parseAt(body.at);
    if (!at) {
      throw HttpError.badRequest('at 必须是 HH:MM（如 08:00）或 ISO 时间（如 2026-03-05T08:00）', { field: 'at' });
    }
    fields.at = typeof body.at === 'string' ? body.at.trim() : body.at;
  }

  if ('repeat' in body) {
    if (!SCHEDULE_REPEATS.includes(body.repeat)) {
      throw HttpError.badRequest(`repeat 只能是 ${SCHEDULE_REPEATS.join(' / ')}`, {
        field: 'repeat',
        allowed: [...SCHEDULE_REPEATS],
      });
    }
    fields.repeat = body.repeat;
  } else if (!partial) {
    // 没写 repeat 时按 at 的形状猜：给了绝对时间点 = 一次性闹钟，只给 HH:MM = 每天
    fields.repeat = parseAt(body.at)?.absolute ? 'once' : 'daily';
  }

  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') throw HttpError.badRequest('enabled 必须是布尔值', { field: 'enabled' });
    fields.enabled = body.enabled;
  }

  if ('search' in body) {
    if (!SCHEDULE_SEARCH_MODES.includes(body.search)) {
      throw HttpError.badRequest(`search 只能是 ${SCHEDULE_SEARCH_MODES.join(' / ')}`, {
        field: 'search',
        allowed: [...SCHEDULE_SEARCH_MODES],
      });
    }
    fields.search = body.search;
  }

  // weekdays 与 repeat 必须一起判：weekly 缺星期几 = 永远不会响的任务，宁可 400
  if ('weekdays' in body || 'repeat' in body) {
    const repeat = fields.repeat ?? base.repeat ?? 'daily';
    if (repeat === 'weekly') {
      const source = 'weekdays' in body ? body.weekdays : base.weekdays;
      if (!Array.isArray(source) || !source.length) {
        throw HttpError.badRequest('weekly 任务必须给 weekdays（1=周一 … 7=周日）', { field: 'weekdays' });
      }
      fields.weekdays = readWeekdays(source);
    } else {
      // 不是 weekly 就清空：留着只会让数据自相矛盾（"每天"却带着星期几）
      fields.weekdays = [];
    }
  }

  if ('label' in body) {
    if (body.label === null || body.label === undefined) {
      fields.label = '';
    } else if (typeof body.label !== 'string') {
      throw HttpError.badRequest('label 必须是字符串', { field: 'label' });
    } else {
      const label = body.label.trim();
      if (label.length > SCHEDULE_LABEL_MAX) {
        throw HttpError.badRequest(`label 最长 ${SCHEDULE_LABEL_MAX} 字`, { field: 'label', max: SCHEDULE_LABEL_MAX });
      }
      fields.label = label;
    }
  }

  if ('conversationId' in body) {
    if (body.conversationId === null || body.conversationId === undefined || body.conversationId === '') {
      fields.conversationId = null;
    } else if (typeof body.conversationId !== 'string') {
      throw HttpError.badRequest('conversationId 必须是字符串', { field: 'conversationId' });
    } else if (body.conversationId.trim().length > CONVERSATION_ID_MAX) {
      throw HttpError.badRequest('conversationId 过长', { field: 'conversationId' });
    } else {
      fields.conversationId = body.conversationId.trim();
    }
  }

  return fields;
}

/** 列表排序：谁先响谁在前，没有下次的排最后；同刻按创建时间倒序。 */
function compareSchedules(a, b) {
  const at = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Infinity;
  const bt = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Infinity;
  if (at !== bt) return at - bt;
  return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
}

/**
 * 定时任务服务：存储 + 到点判定 + 每分钟一次的驱动。
 *
 * 存储用模块自己声明的集合 `store.aiSchedules`（`ai-schedules.json`），
 * 与 ai 模块其它数据一样走 JsonStore（原子写 + 进程内驻留），不引第三方依赖。
 */
export class AiScheduleService {
  constructor({
    store,
    broadcast,
    now = () => new Date(),
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
    catchUpWindowMs = DEFAULT_CATCH_UP_MS,
    logger = console,
  } = {}) {
    this.store = store;
    this.broadcast = broadcast;
    /** 可注入的时钟：测试里喂固定的"现在"，生产里就是真实时间。 */
    this.now = now;
    this.checkIntervalMs = Math.max(1000, Number(checkIntervalMs) || DEFAULT_CHECK_INTERVAL_MS);
    this.catchUpWindowMs = Math.max(0, Number(catchUpWindowMs) || DEFAULT_CATCH_UP_MS);
    this.logger = logger;
    /** 真正的模型调用由外部注入；未注入时只记录不执行。 */
    this.runner = null;
    this.timer = undefined;
    /** 正在执行的任务：执行慢于一分钟时不让下一次 tick 重复触发。 */
    this.inFlight = new Set();
    /** "没有 runner"的告警每条任务只打一次，免得每分钟刷屏。 */
    this.warnedNoRunner = new Set();
  }

  // ---------------------------------------------------------------- 存储 / CRUD

  #collection() {
    const collection = this.store?.aiSchedules;
    if (!collection) throw new Error('缺少 aiSchedules 集合（应在 ai 模块 module.js 的 collections 里声明）');
    return collection;
  }

  /** 全部任务（`{ ok, count, items }`，与 ai 模块其它列表接口同形）。 */
  list() {
    const items = this.#collection().all().slice().sort(compareSchedules);
    return { ok: true, count: items.length, items };
  }

  /** 单个任务；不存在抛 404（路由直接透传成 HTTP 404）。 */
  get(id) {
    const record = this.#collection().get(id);
    if (!record) throw HttpError.notFound(`定时任务 ${id} 不存在`);
    return record;
  }

  async create(body) {
    const fields = readFields(body, { partial: false });
    const now = this.now();
    const draft = {
      label: fields.label || String(fields.prompt).slice(0, 24),
      prompt: fields.prompt,
      at: fields.at,
      repeat: fields.repeat,
      weekdays: fields.weekdays ?? [],
      enabled: fields.enabled !== false,
      conversationId: fields.conversationId ?? null,
    };
    const nextRunAt = computeNextRun(draft, now);
    if (!nextRunAt) {
      // 一次性任务给了一个已经过去的时间点：建成"永远不响"的任务比报错更糟
      throw HttpError.badRequest('一次性任务的时间点已经过去，请给一个未来的时间', { field: 'at' });
    }
    const record = await this.#collection().insert({
      ...draft,
      lastRunAt: null,
      nextRunAt,
      lastError: null,
    });
    this.#announce('create', record.id);
    return record;
  }

  async update(id, body) {
    const current = this.get(id);
    const fields = readFields(body, { partial: true, base: current });
    const candidate = { ...current, ...fields };
    const now = this.now();
    const timingChanged = ['at', 'repeat', 'weekdays'].some((key) => key in fields);
    const enabling = fields.enabled === true && current.enabled === false;

    const patch = { ...fields };
    if (timingChanged || enabling) {
      // 改了"什么时候响"就必须重算，否则会出现"显示每天 09:00、实际还按老的 08:00 响"
      const nextRunAt = computeNextRun(candidate, now);
      if (!nextRunAt && candidate.enabled !== false) {
        throw HttpError.badRequest('这个时间点已经过去，请先改成一个未来的时间', { field: 'at' });
      }
      patch.nextRunAt = nextRunAt;
      // 重新算过时间就顺手把上次的错误清掉：那是"上一次"的结论，不该跟着新计划显示
      if (timingChanged) patch.lastError = null;
    }

    const updated = await this.#collection().update(id, patch);
    if (!updated) throw HttpError.notFound(`定时任务 ${id} 不存在`);
    this.#announce('update', id);
    return updated;
  }

  async remove(id) {
    const current = this.get(id);
    await this.#collection().remove(current.id);
    this.warnedNoRunner.delete(current.id);
    this.#announce('delete', current.id);
    return { ok: true, deleted: true, id: current.id };
  }

  // ---------------------------------------------------------------- 到点判定

  /**
   * 到点了吗？（**只读**，不写库、不执行）
   *
   * 判据两条，缺一不可：
   *   1. `enabled !== false` 且 `nextRunAt <= now`；
   *   2. 这一次**还没跑过**（`lastRunAt` 不在 `nextRunAt` 之后）。
   * 第 2 条是幂等的兜底：`markRun` 会把 `lastRunAt` 记在本次计划之后、并把 `nextRunAt` 推到未来，
   * 所以"同一分钟里被问两次"第二次必然为空，不会重复触发。
   */
  dueTasks(now = this.now()) {
    const at = now instanceof Date ? now : new Date(now);
    const time = at.getTime();
    if (Number.isNaN(time)) return [];
    return this.list().items.filter((task) => {
      if (task.enabled === false) return false;
      const next = task.nextRunAt ? new Date(task.nextRunAt).getTime() : NaN;
      if (!Number.isFinite(next) || next > time) return false;
      const last = task.lastRunAt ? new Date(task.lastRunAt).getTime() : NaN;
      return !Number.isFinite(last) || last < next;
    });
  }

  /**
   * 记一次执行结果，并把计划推进到下一次。
   *
   * 语义（和 `runNow` 的"试一下"区别开）：
   * - `lastRunAt = now`，成功清空 `lastError`、失败记下原因；
   * - `nextRunAt` 重算（daily / weekly）；
   * - **once 跑完就关掉**（`enabled: false`、`nextRunAt: null`）：一次性任务不管成没成都只响一次，
   *   否则它会因为"时间点已过"永远卡在待触发状态、每天被扫一遍。
   *
   * @param {string} id 任务 id（不存在抛 404）
   * @param {{ ok?: boolean, error?: string|null, now?: Date }} [outcome]
   */
  async markRun(id, { ok = true, error = null, now = this.now() } = {}) {
    const task = this.get(id);
    return this.#record(task, { ok, error, now, advance: true });
  }

  /**
   * 「现在试一下」：立刻跑一次，用于前端按钮。
   *
   * 与到点执行的区别：**到点前**手动跑不消耗本次计划（`nextRunAt` / `enabled` 原样保留），
   * 否则用户点一下"试一下"就会把明天的提醒吃掉；**已经到点**时手动跑就等于补跑，
   * 顺手把计划推进（不然它会一直停在过去，再也不会被 `dueTasks` 选中）。
   */
  async runNow(id, { now = this.now() } = {}) {
    const task = this.get(id);
    const at = now instanceof Date ? now : new Date(now);
    if (typeof this.runner !== 'function') {
      // 没接线不是"崩"，但要如实记下来：前端据此提示"执行器尚未接线"。
      // 注意 `stamp: false`：什么都没执行，就不该写 lastRunAt（否则列表会显示"刚刚跑过"）。
      const updated = await this.#record(task, {
        ok: false,
        error: NO_RUNNER_MESSAGE,
        now: at,
        advance: false,
        stamp: false,
      });
      return { ok: true, ran: false, succeeded: false, reason: 'no_runner', error: NO_RUNNER_MESSAGE, task: updated };
    }
    const next = task.nextRunAt ? new Date(task.nextRunAt).getTime() : NaN;
    const overdue = Number.isFinite(next) && next <= at.getTime();
    const outcome = await this.#execute(task, { now: at, manual: true, advance: overdue });
    return { ok: true, ran: true, succeeded: outcome.ok, error: outcome.error, task: this.get(task.id) };
  }

  // ---------------------------------------------------------------- 定时器

  /** 注入真正的执行器（chat-service 接线用）。传 null 可以摘掉（回到"只记录不执行"）。 */
  setRunner(runner) {
    if (runner !== null && runner !== undefined && typeof runner !== 'function') {
      throw new TypeError('runner 必须是函数或 null');
    }
    this.runner = runner ?? null;
    this.warnedNoRunner.clear();
    return this;
  }

  /** 启动每分钟一次的检查（模块 `start` 钩子调用；重复调用是安全的）。 */
  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.#log(`检查失败：${error?.message ?? error}`));
    }, this.checkIntervalMs);
    // unref：定时器绝不成为"进程为什么还不退出"的原因
    this.timer.unref?.();
    // 立刻查一次：后端重启很可能正好跨过"到点那一分钟"（tick 内部有 catchUpWindowMs 兜住错过太久的）
    this.tick().catch((error) => this.#log(`首次检查失败：${error?.message ?? error}`));
    return this;
  }

  /** 停止定时器（模块 `stop` 钩子调用）。必须干净：`node --test` 不能被悬挂定时器挂住。 */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    return this;
  }

  /**
   * 检查一轮：补算缺失的下次时间 → 找出到点的 → 执行（或跳过）。
   *
   * @returns {Promise<string[]>} 这一轮真正执行了的任务 id
   */
  async tick(now = this.now()) {
    const at = now instanceof Date ? now : new Date(now);
    await this.#repair(at);
    const executed = [];
    for (const task of this.dueTasks(at)) {
      if (this.inFlight.has(task.id)) continue;
      const scheduledAt = new Date(task.nextRunAt).getTime();
      const late = at.getTime() - scheduledAt;
      if (late > this.catchUpWindowMs) {
        // 错过太久（关机一夜 / 休眠）：不补跑，只把计划推到未来，并如实说明这一次没跑
        await this.#shiftForward(task, at, late);
        continue;
      }
      if (typeof this.runner !== 'function') {
        this.#warnNoRunner(task);
        continue;
      }
      await this.#execute(task, { now: at, manual: false, advance: true });
      executed.push(task.id);
    }
    return executed;
  }

  // ---------------------------------------------------------------- 内部

  async #execute(task, { now, manual, advance }) {
    this.inFlight.add(task.id);
    let ok = true;
    let error = null;
    try {
      const outcome = await this.runner(task, { now: new Date(now.getTime()), manual });
      if (outcome === false) {
        ok = false;
        error = '执行器返回失败';
      } else if (outcome && typeof outcome === 'object' && outcome.ok === false) {
        ok = false;
        error = outcome.error ?? '执行器返回失败';
      }
    } catch (cause) {
      // 上游 401 / 超时 / 没配密钥……都从这里进来：记下来就行，绝不让定时器把后端带崩
      ok = false;
      error = cause?.message ?? String(cause);
      this.#log(`任务 ${task.id} 执行失败：${error}`);
    } finally {
      this.inFlight.delete(task.id);
    }
    await this.#record(task, { ok, error, now, advance });
    return { ok, error };
  }

  /**
   * 写结果。
   *
   * - `advance: false`：只记 lastRunAt / lastError，不动计划（"试一下"在到点前用）；
   * - `stamp: false`：连 lastRunAt 都不记（什么都没执行，列表不该显示"刚刚跑过"）。
   */
  async #record(task, { ok, error, now, advance, stamp = true }) {
    const at = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(at.getTime())) throw HttpError.badRequest('now 不是合法时间');
    const patch = {
      lastError: ok ? null : String(error ?? '执行失败').slice(0, 500),
    };
    if (stamp) patch.lastRunAt = at.toISOString();
    if (advance) {
      if (task.repeat === 'once') {
        patch.nextRunAt = null;
        patch.enabled = false;
      } else {
        patch.nextRunAt = computeNextRun(task, at);
      }
    }
    const updated = await this.#collection().update(task.id, patch);
    this.#announce(advance ? 'run' : 'try', task.id, { ok });
    return updated;
  }

  /** 错过太久：把计划推到未来（once 直接关掉），并记下"这一次没跑"。 */
  async #shiftForward(task, now, lateMs) {
    const nextRunAt = task.repeat === 'once' ? null : computeNextRun(task, now);
    const minutes = Math.max(1, Math.round(lateMs / 60_000));
    await this.#collection().update(task.id, {
      nextRunAt,
      ...(nextRunAt ? {} : { enabled: false }),
      lastError: `错过 ${minutes} 分钟，本次未补跑`,
    });
    this.#log(`任务 ${task.id} 晚了 ${minutes} 分钟，已跳过本次`);
    this.#announce('skip', task.id);
  }

  /**
   * 补算缺失的 `nextRunAt`。
   *
   * 老数据、手改过的数据、或历史版本迁移过来的记录可能没有这个字段 —— 没有它任务会**永远沉默**
   * （`dueTasks` 直接把它当"不到点"），这类"看起来在、其实不会响"的任务最难排查，所以每轮补一次。
   */
  async #repair(now) {
    for (const task of this.list().items) {
      if (task.enabled === false) continue;
      const next = task.nextRunAt ? new Date(task.nextRunAt).getTime() : NaN;
      if (Number.isFinite(next)) continue;
      const nextRunAt = computeNextRun(task, now);
      await this.#collection().update(task.id, {
        nextRunAt,
        ...(nextRunAt ? {} : { enabled: false, lastError: '时间点已经过去，无法再计算下一次' }),
      });
    }
  }

  #warnNoRunner(task) {
    if (this.warnedNoRunner.has(task.id)) return;
    this.warnedNoRunner.add(task.id);
    this.#log(`任务 ${task.id} 到点，但没有注入 runner（setRunner），本次只记录不执行`);
  }

  #announce(action, id, extra = {}) {
    // 广播沿用 ai 模块现有机制（`data_changed` + `module: 'ai'`），渲染层照 target 分辨刷新什么
    this.broadcast?.({ type: 'data_changed', module: 'ai', payload: { target: 'ai_schedules', action, id, ...extra } });
  }

  #log(message) {
    this.logger?.log?.(`[ai-schedule] ${message}`);
  }
}
