/**
 * 番茄钟的**纯状态机**（不读文件、不碰网络、不广播，所有时间来自注入的 `now`）。
 *
 * 为什么把状态机单独拆出来：
 * - 到点切换、暂停、跳过、睡过头补账这些逻辑都是**时间的函数**，用真实时钟测只能靠
 *   `setTimeout` 等一分钟，既慢又不稳；注入 `now` 之后，同一段代码可以在几毫秒内
 *   走完「45 分钟专注 → 15 分钟休息 → 再专注」。
 * - 服务层只负责「读库 / 写账本 / 广播」，状态迁移一条都不许复制到别处 ——
 *   两套迁移逻辑迟早会出现「界面上已经休息了、账本里还在专注」的分裂。
 *
 * 对时机制（为什么不「每秒 +1」）
 * ----------------------------
 * 定时器每秒累加会把「进程被挂起 / 电脑睡眠 / 浏览器节流」全部算丢：醒来以后
 * 计时器只会少走几秒，而真实世界已经过去两小时。这里只存 `endsAt`（绝对时刻），
 * 剩余时间**永远现算** `endsAt - now`。`tick()` 只负责"到点了吗"，即使它 10 分钟
 * 才被调度一次，补账也会按 `endsAt` 链式推进（见 `reconcileState`），一分钟都不会丢。
 */

import { HttpError } from '../../core/http/router.js';

/** 默认配置。`longBreakEvery: 0` = 关闭长休息（本版 UI 不暴露，但状态机支持）。 */
export const DEFAULT_CONFIG = Object.freeze({
  studyMin: 45,
  breakMin: 15,
  autoStartNext: true,
  sound: true,
  longBreakEvery: 0,
  longBreakMin: 30,
});

export const PHASES = Object.freeze(['idle', 'study', 'break']);

/** 一轮最多补多少个阶段：防御性上限，正常睡眠几小时只会有个位数阶段。 */
export const MAX_RECONCILE_STEPS = 10000;

/** 分钟数 -> 秒。允许小数分钟（最小 0.05 = 3 秒），纯粹是为了接口联调与测试能快速到点。 */
export function minutesToSec(value) {
  return Math.max(1, Math.round(Number(value) * 60));
}

function minutesValue(value, field, { min = 0.05, max = 240 } = {}) {
  if (value === undefined || value === null || value === '') {
    throw HttpError.badRequest(`字段 ${field} 必填`, { field });
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw HttpError.badRequest(`字段 ${field} 不合法：必须是分钟数`, { field });
  }
  if (num < min || num > max) {
    throw HttpError.badRequest(`字段 ${field} 不合法：取值范围 ${min}~${max} 分钟`, { field, value: num });
  }
  return Number(num.toFixed(3));
}

function booleanValue(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  throw HttpError.badRequest(`字段 ${field} 不合法：必须是布尔值`, { field });
}

function intValue(value, field, { min, max, fallback }) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  if (!Number.isInteger(num) || num < min || num > max) {
    throw HttpError.badRequest(`字段 ${field} 不合法：必须是 ${min}~${max} 的整数`, { field, value });
  }
  return num;
}

/**
 * 配置归一化。只覆盖传进来的键，其余保持原值 —— PATCH 语义，前端只改一项时
 * 不会把别的设置悄悄重置成默认值。
 *
 * @param {object} [patch]
 * @param {object} [base=DEFAULT_CONFIG]
 */
export function normalizeConfig(patch = {}, base = DEFAULT_CONFIG) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw HttpError.badRequest('config 必须是对象');
  }
  const next = { ...base };
  if (patch.studyMin !== undefined) next.studyMin = minutesValue(patch.studyMin, 'studyMin');
  if (patch.breakMin !== undefined) next.breakMin = minutesValue(patch.breakMin, 'breakMin');
  if (patch.autoStartNext !== undefined) {
    next.autoStartNext = booleanValue(patch.autoStartNext, 'autoStartNext', next.autoStartNext);
  }
  if (patch.sound !== undefined) next.sound = booleanValue(patch.sound, 'sound', next.sound);
  if (patch.longBreakEvery !== undefined) {
    next.longBreakEvery = intValue(patch.longBreakEvery, 'longBreakEvery', { min: 0, max: 24, fallback: 0 });
  }
  if (patch.longBreakMin !== undefined) next.longBreakMin = minutesValue(patch.longBreakMin, 'longBreakMin');
  return next;
}

/** 新会话的初始状态。`round` 在**开始新一轮**时归零（它数的是这一轮完成几个番茄）。 */
export function createIdleState(config = DEFAULT_CONFIG) {
  const normalized = normalizeConfig(config);
  return {
    phase: 'idle',
    running: false,
    startedAt: null,
    endsAt: null,
    remainingSecWhenPaused: 0,
    round: 0,
    taskId: null,
    config: normalized,
    /** 当前阶段计划时长（秒）。不放进 /status（用 totalSec 表达），但暂停/跳过要它算已用时长。 */
    plannedSec: minutesToSec(normalized.studyMin),
    /**
     * 本阶段已经**记到待办**的秒数（内部字段，不出现在 /status）。
     * 专注期间每秒都要给待办加时间；靠它算"这一秒是否已经记过"，避免每个 tick 重复累计。
     * 阶段切换时归零；暂停/换任务前会先结算到当前秒。
     */
    creditedSec: 0,
    /** start 时显式传的时长只影响本轮，不改用户持久化的 config。 */
    overrides: { studySec: null, breakSec: null },
  };
}

/** 把外部状态（磁盘/测试）收敛成合法形状：坏字段回默认值，但绝不抛异常拖垮启动。 */
export function normalizeState(raw) {
  const base = createIdleState();
  if (!raw || typeof raw !== 'object') return base;
  let config;
  try {
    config = normalizeConfig(raw.config ?? {}, DEFAULT_CONFIG);
  } catch {
    config = { ...DEFAULT_CONFIG };
  }
  const phase = PHASES.includes(raw.phase) && raw.phase !== 'idle' ? raw.phase : 'idle';
  const state = {
    ...base,
    config,
    phase,
    running: phase !== 'idle' && raw.running === true,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
    endsAt: typeof raw.endsAt === 'string' && Number.isFinite(Date.parse(raw.endsAt)) ? raw.endsAt : null,
    remainingSecWhenPaused: Math.max(0, Math.round(Number(raw.remainingSecWhenPaused) || 0)),
    round: Math.max(0, Math.round(Number(raw.round) || 0)),
    taskId: typeof raw.taskId === 'string' && raw.taskId.trim() ? raw.taskId.trim() : null,
    plannedSec: Math.max(1, Math.round(Number(raw.plannedSec) || 0)) || minutesToSec(config.studyMin),
    creditedSec: Math.max(0, Math.round(Number(raw.creditedSec) || 0)),
    overrides: {
      studySec: Number.isFinite(raw.overrides?.studySec) ? Math.max(1, Math.round(raw.overrides.studySec)) : null,
      breakSec: Number.isFinite(raw.overrides?.breakSec) ? Math.max(1, Math.round(raw.overrides.breakSec)) : null,
    },
  };
  // 运行中却没有 endsAt = 数据坏了。宁可回到暂停（用户点继续就能接着走），也不要假装在跑。
  if (state.running && !state.endsAt) {
    state.running = false;
    state.remainingSecWhenPaused = state.plannedSec;
  }
  if (!state.running) state.endsAt = null;
  return state;
}

/** 本轮专注时长（秒）：start 的显式 override 优先，其次 config。 */
export function studyDurationSec(state) {
  return state.overrides?.studySec ?? minutesToSec(state.config.studyMin);
}

/**
 * 下一次休息时长：`longBreakEvery > 0` 且完成数整除它时用长休息。
 * 长休息目前只有配置入口（UI 不暴露），但状态机先做对，后面加开关不用改协议。
 */
export function breakDurationSec(state, round = state.round) {
  if (state.overrides?.breakSec) return state.overrides.breakSec;
  const every = state.config.longBreakEvery ?? 0;
  if (every > 0 && round > 0 && round % every === 0) return minutesToSec(state.config.longBreakMin);
  return minutesToSec(state.config.breakMin);
}

const iso = (ms) => new Date(ms).toISOString();
const msOf = (value) => (Number.isFinite(Date.parse(String(value ?? ''))) ? Date.parse(value) : null);

/** 当前阶段总时长（秒）。idle 时给"下一次专注会有多长"，让界面圆环有分母。 */
export function totalSeconds(state) {
  if (state.phase === 'idle') return minutesToSec(state.config.studyMin);
  return Math.max(1, state.plannedSec);
}

/** 暂停时/空闲时的剩余秒数；运行中不用它（见 remainingSeconds）。 */
function pausedRemaining(state) {
  if (state.phase === 'idle') return totalSeconds(state);
  return Math.max(0, Math.min(totalSeconds(state), Math.round(state.remainingSecWhenPaused)));
}

/**
 * 剩余秒数 —— **永远由 endsAt 现算**。
 * 向上取整：剩 0.2 秒时显示 00:01 而不是 00:00（最后那一秒不该提前跳零）。
 */
export function remainingSeconds(state, now = new Date()) {
  if (state.phase === 'idle') return totalSeconds(state);
  if (!state.running) return pausedRemaining(state);
  const ends = msOf(state.endsAt);
  if (ends === null) return pausedRemaining(state);
  const delta = ends - new Date(now).getTime();
  return Math.max(0, Math.ceil(delta / 1000));
}

/** 当前阶段已经过的秒数（不会超过计划时长）。 */
export function elapsedSeconds(state, now = new Date()) {
  if (state.phase === 'idle') return 0;
  return Math.max(0, Math.min(totalSeconds(state), totalSeconds(state) - remainingSeconds(state, now)));
}

/** 给 /status 的核心字段（taskTitle 与统计由服务层补）。 */
export function coreStatus(state, now = new Date()) {
  const totalSec = totalSeconds(state);
  return {
    phase: state.phase,
    running: state.running,
    remainingSec: remainingSeconds(state, now),
    totalSec,
    round: state.round,
    taskId: state.taskId,
    startedAt: state.startedAt,
    endsAt: state.endsAt,
    config: { ...state.config },
  };
}

function requireActive(state, action) {
  if (state.phase === 'idle') {
    throw HttpError.badRequest(`当前处于 idle（未开始），不能${action}`, {
      phase: state.phase,
      running: state.running,
      hint: '先 POST /pomodoro/start 开始一个番茄',
    });
  }
}

/**
 * 开始一轮：只在 idle 时允许；已在跑返回 409，并把当前状态带回去（调用方据此渲染）。
 *
 * `studyMin` / `breakMin` 只覆盖**本轮**，不改持久化的 config —— 否则用户只是"这次
 * 先来 10 分钟"，却把默认 45 分钟永久改掉了。
 */
export function startState(state, { now = new Date(), taskId = null, studyMin, breakMin } = {}) {
  if (state.phase !== 'idle') {
    const status = coreStatus(state, now);
    throw HttpError.conflict(`已经在${state.phase === 'study' ? '专注' : '休息'}中，先停止当前会话再开始`, {
      // 同时给嵌套与扁平两种形状：`status` 与 GET /status 同形，扁平字段方便
      // 简单客户端直接读 details.phase，不必再解一层
      status,
      phase: status.phase,
      running: status.running,
      remainingSec: status.remainingSec,
    });
  }
  const config = { ...state.config };
  if (studyMin !== undefined) minutesValue(studyMin, 'studyMin');
  if (breakMin !== undefined) minutesValue(breakMin, 'breakMin');
  const overrides = {
    studySec: studyMin === undefined ? null : minutesToSec(studyMin),
    breakSec: breakMin === undefined ? null : minutesToSec(breakMin),
  };
  const plannedSec = overrides.studySec ?? minutesToSec(config.studyMin);
  const nowMs = new Date(now).getTime();
  return {
    ...state,
    config,
    overrides,
    phase: 'study',
    running: true,
    startedAt: iso(nowMs),
    endsAt: iso(nowMs + plannedSec * 1000),
    remainingSecWhenPaused: 0,
    // 新一轮重新数番茄；历史已经写进账本，不靠这个字段保存
    round: 0,
    taskId: typeof taskId === 'string' && taskId.trim() ? taskId.trim() : null,
    plannedSec,
    creditedSec: 0,
  };
}

export function pauseState(state, { now = new Date() } = {}) {
  requireActive(state, '暂停');
  if (!state.running) {
    throw HttpError.badRequest('当前已经是暂停状态，不需要再次暂停', {
      phase: state.phase,
      running: false,
      remainingSec: remainingSeconds(state, now),
    });
  }
  const remaining = remainingSeconds(state, now);
  return {
    ...state,
    running: false,
    endsAt: null,
    remainingSecWhenPaused: remaining,
  };
}

export function resumeState(state, { now = new Date() } = {}) {
  requireActive(state, '继续');
  if (state.running) {
    throw HttpError.badRequest('当前已经在运行，不需要继续', {
      phase: state.phase,
      running: true,
      remainingSec: remainingSeconds(state, now),
    });
  }
  const remaining = pausedRemaining(state);
  const nowMs = new Date(now).getTime();
  return {
    ...state,
    running: true,
    // 开始时刻保留最初那一笔（账本要的是"这次专注从几点开始"），endsAt 从此刻重算
    endsAt: iso(nowMs + remaining * 1000),
    remainingSecWhenPaused: 0,
  };
}

export function setTaskState(state, { taskId = null } = {}) {
  return {
    ...state,
    taskId: typeof taskId === 'string' && taskId.trim() ? taskId.trim() : null,
  };
}

/** 改配置：运行中的**当前阶段时长不变**（否则改一下设置，倒计时会突然跳一下）。 */
export function updateConfigState(state, patch) {
  return { ...state, config: normalizeConfig(patch, state.config) };
}

/**
 * 结束当前阶段并进入下一阶段。
 *
 * `completed` 为真表示"按计划走到 endsAt"（自动切换），为假表示用户提前跳过。
 * 只有 study 的**完整**结束才让 `round + 1`；跳过是"我没专注够，但要去休息"，
 * 不能算一个番茄，否则统计会虚高。
 */
export function finishPhase(state, { now = new Date(), completed = true } = {}) {
  requireActive(state, '结束阶段');
  const nowMs = new Date(now).getTime();
  const endedMs = completed ? msOf(state.endsAt) : nowMs;
  if (endedMs === null) {
    throw HttpError.badRequest('当前阶段没有有效的 endsAt，无法结算', { phase: state.phase });
  }
  const actualSec = completed ? totalSeconds(state) : elapsedSeconds(state, new Date(nowMs));
  const session = {
    kind: state.phase,
    taskId: state.taskId,
    startedAt: state.startedAt ?? iso(endedMs - actualSec * 1000),
    endedAt: iso(endedMs),
    plannedSec: totalSeconds(state),
    actualSec,
    completed: Boolean(completed),
    /** 内部字段：本阶段已经记到待办的秒数；服务层只补记差额，不重复加。 */
    creditedSec: Math.max(0, Math.round(Number(state.creditedSec) || 0)),
  };

  const nextRound = state.phase === 'study' && completed ? state.round + 1 : state.round;
  const nextPhase = state.phase === 'study' ? 'break' : 'study';
  const nextPlanned = nextPhase === 'break' ? breakDurationSec(state, nextRound) : studyDurationSec(state);
  const auto = state.config.autoStartNext !== false;
  return {
    session,
    state: {
      ...state,
      phase: nextPhase,
      // 到点后是否自动跑下一段由配置决定；关掉时进入下一阶段但停在暂停态
      running: auto,
      startedAt: iso(endedMs),
      endsAt: auto ? iso(endedMs + nextPlanned * 1000) : null,
      remainingSecWhenPaused: auto ? 0 : nextPlanned,
      plannedSec: nextPlanned,
      creditedSec: 0,
      round: nextRound,
    },
  };
}

/** 停止：记一条**部分时长**会话，回到 idle（round 保留，直到下一次 start 归零）。 */
export function stopState(state, { now = new Date() } = {}) {
  if (state.phase === 'idle') return { session: null, state };
  const nowMs = new Date(now).getTime();
  const actualSec = elapsedSeconds(state, new Date(nowMs));
  const session = {
    kind: state.phase,
    taskId: state.taskId,
    startedAt: state.startedAt ?? iso(nowMs - actualSec * 1000),
    endedAt: iso(nowMs),
    plannedSec: totalSeconds(state),
    actualSec,
    completed: false,
    creditedSec: Math.max(0, Math.round(Number(state.creditedSec) || 0)),
  };
  return {
    session,
    state: {
      ...createIdleState(state.config),
      round: state.round,
      taskId: null,
      overrides: { studySec: null, breakSec: null },
    },
  };
}

/**
 * 补账：从当前阶段开始，只要 `now >= endsAt` 就按计划结束它、进入下一阶段；循环直到
 * 当前阶段还没结束（或配置关闭了自动开始）。返回的 `ended` 按时间顺序排列。
 *
 * 为什么不是"只结算一次"：笔记本合盖两小时再打开，中间可能已经过去
 * 「专注 45 → 休息 15 → 专注 45 → 休息 15」好几个阶段。只补一个会让下一个 endsAt
 * 仍然在过去，下一秒的 tick 又补一个 —— 状态看似在动，账本却晚了好几分钟，
 * 而且 WS 提醒会一条接一条地迟到。一次循环补齐，才是对"睡了多久"的如实回答。
 */
export function reconcileState(state, now = new Date(), { maxSteps = MAX_RECONCILE_STEPS } = {}) {
  let current = state;
  const ended = [];
  let steps = 0;
  while (current.phase !== 'idle' && current.running) {
    const ends = msOf(current.endsAt);
    if (ends === null || ends > new Date(now).getTime()) break;
    if (steps >= maxSteps) {
      // 极端情况（配置改成 3 秒一段 + 睡了一周）：不能死循环。
      // 停在当前阶段并把剩余置 0，由下一次操作/状态查询继续补；至少不会卡死服务。
      current = { ...current, running: false, endsAt: null, remainingSecWhenPaused: 0 };
      break;
    }
    const result = finishPhase(current, { now: new Date(ends), completed: true });
    ended.push(result.session);
    current = result.state;
    steps += 1;
  }
  return { state: current, ended };
}
