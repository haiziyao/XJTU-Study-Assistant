/**
 * 状态模块：把"今天感觉怎么样"量化成一个可用的读数。
 *
 * 这一层是整个成长模块的**入口**：任务表单的难度、数量、类型都由它推导。
 * 所以这里的公式必须是确定性的纯函数 —— 同一个状态录入，任何时候算出同一个
 * 读数，否则用户会觉得自己在跟一个随机数打交道。
 *
 * 六个维度（全部 1–5，睡眠单独用小时数）：
 *   精力 energy        —— 今天有多少"电"
 *   睡眠 sleep         —— 睡了几小时 + 睡得怎么样
 *   情绪 mood          —— 心情
 *   压力 stress        —— 越高越扣分（反向）
 *   专注 focus         —— 能不能坐得住
 *   身体 body          —— 有没有酸痛/不适
 */

import { badRequest } from './errors.js';
import { dateKey, isValidDateKey } from './time.js';
import { collection } from './store-utils.js';

export const DIMENSIONS = ['energy', 'mood', 'stress', 'focus', 'body'];

export const WEIGHTS = {
  energy: 0.3,
  sleepHours: 0.15,
  sleepQuality: 0.15,
  mood: 0.15,
  stress: 0.15,
  body: 0.1,
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const scale01 = (value) => clamp((Number(value) - 1) / 4, 0, 1);

/** 睡眠时长 → 0–1。7.5 小时满分；超过 9.5 小时缓慢扣分（睡太多也是状态差）。 */
export function sleepFactor(hours) {
  const h = Number(hours);
  if (!Number.isFinite(h)) return 0;
  if (h <= 0) return 0;
  if (h <= 7.5) return clamp(h / 7.5, 0, 1);
  if (h <= 9.5) return 1;
  return clamp(1 - (h - 9.5) * 0.08, 0.6, 1);
}

/**
 * 就绪度 0–100。
 * 压力是反向指标：5 分（压力很大）拿 0 分，1 分（很轻松）拿满分。
 */
export function readiness(entry = {}) {
  const energy = scale01(entry.energy);
  const sleepQuality = scale01(entry.sleepQuality);
  const mood = scale01(entry.mood);
  const stress = 1 - scale01(entry.stress);
  const focus = scale01(entry.focus);
  const body = scale01(entry.body);
  const sleep = sleepFactor(entry.sleepHours);

  const score =
    energy * WEIGHTS.energy +
    sleep * WEIGHTS.sleepHours +
    sleepQuality * WEIGHTS.sleepQuality +
    mood * WEIGHTS.mood +
    stress * WEIGHTS.stress +
    body * WEIGHTS.body;

  // focus 是"能不能干活"的直接指标，额外占一档权重做微调（不与上面抢 100 分，
  // 而是作为 0.9–1.1 的乘数：同样精力下，专注度高的人今天确实更能推进任务）。
  const focusMultiplier = 0.9 + focus * 0.2;
  return Math.round(clamp(score * focusMultiplier, 0, 1) * 1000) / 10;
}

/** 今日可支配的"有效投入分钟数"。60–300 分钟。 */
export function capacityMinutes(score) {
  const s = clamp(Number(score) || 0, 0, 100);
  return Math.round(60 + 2.4 * s);
}

export const MODES = {
  push: { key: 'push', label: '推进', hint: '状态好，可以啃硬骨头：安排深度工作与高难度任务。' },
  steady: { key: 'steady', label: '稳态', hint: '状态中等，按常规节奏推进，难度适中。' },
  recover: { key: 'recover', label: '修复', hint: '状态偏低，今天的目标是"别崩"，以恢复与最小行动为主。' },
};

/** 状态 → 今日模式。阈值写死是为了可解释：70 分以上推进、45 以下修复。 */
export function modeOf(score) {
  const s = Number(score) || 0;
  if (s >= 70) return MODES.push;
  if (s >= 45) return MODES.steady;
  return MODES.recover;
}

/** 状态档位的一句话解读（本地规则，不依赖模型）。 */
export function interpret(entry, score) {
  const mode = modeOf(score);
  const labels = { energy: '精力', mood: '情绪', stress: '压力', focus: '专注', body: '身体' };
  // 压力要反向看：5 分是"压力爆表"，不是"状态很好"，否则最短板会被算反
  const ranked = DIMENSIONS.map((key) => ({
    key,
    raw: Number(entry[key]) || 0,
    severity: key === 'stress' ? 6 - (Number(entry[key]) || 0) : Number(entry[key]) || 0,
  })).sort((a, b) => a.severity - b.severity);
  const weakest = ranked[0];

  const lines = [`就绪度 ${score}/100，今日模式：${mode.label}。`];
  if (Number(entry.stress) >= 4) lines.push('压力偏高，任务里保留恢复项，别把日程排满。');
  if (Number(entry.sleepHours) < 6) lines.push('睡眠不足 6 小时，深度工作的时段尽量放在上午。');
  if (weakest && weakest.severity <= 2) {
    lines.push(
      weakest.key === 'stress'
        ? '压力这一项是短板（越高越耗电），今天优先把日程排松一点。'
        : `最短板是${labels[weakest.key]}（${weakest.raw}/5），先补这一项再谈效率。`,
    );
  }
  if (score >= 70) lines.push('今天适合处理那件一直拖着的重要事。');
  return lines;
}

function intInRange(input, field, label, min, max) {
  const value = Number(input[field]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw badRequest('INVALID_FIELD', `${label}必须是 ${min}–${max} 的整数`);
  }
  return value;
}

/** 校验并规范化一次录入。 */
export function normalizeEntry(input = {}, { now = new Date() } = {}) {
  const date = input.date ? String(input.date) : dateKey(now);
  if (!isValidDateKey(date)) {
    throw badRequest('INVALID_DATE', '日期必须是真实存在的 YYYY-MM-DD');
  }
  const sleepHours = Number(input.sleepHours);
  if (!Number.isFinite(sleepHours) || sleepHours < 0 || sleepHours > 16) {
    throw badRequest('INVALID_FIELD', '睡眠时长必须在 0–16 小时之间');
  }
  const note = input.note == null ? '' : String(input.note).trim();
  if (note.length > 1000) throw badRequest('INVALID_FIELD', '备注最多 1000 字');

  const entry = {
    date,
    sleepHours: Math.round(sleepHours * 10) / 10,
    sleepQuality: intInRange(input, 'sleepQuality', '睡眠质量', 1, 5),
    energy: intInRange(input, 'energy', '精力', 1, 5),
    mood: intInRange(input, 'mood', '情绪', 1, 5),
    stress: intInRange(input, 'stress', '压力', 1, 5),
    focus: intInRange(input, 'focus', '专注', 1, 5),
    body: intInRange(input, 'body', '身体', 1, 5),
    note,
  };
  entry.score = readiness(entry);
  entry.capacity = capacityMinutes(entry.score);
  entry.mode = modeOf(entry.score).key;
  return entry;
}

export function createStateService({ store, clock }) {
  const states = collection(store, 'growthStates');

  return {
    /** 同一天重复提交 = 覆盖（一天一份状态，不做历史版本堆叠）。 */
    async upsert(input) {
      const entry = normalizeEntry(input, { now: clock.now() });
      const existing = await states.one((item) => item.date === entry.date);
      if (existing) return states.patch(existing.id, entry);
      return states.insert(entry);
    },

    async get(date) {
      return states.one((item) => item.date === date);
    },

    async latest() {
      const all = await states.all();
      return all.sort((a, b) => (a.date < b.date ? 1 : -1))[0] ?? null;
    },

    /** 最近 n 天（有录入的日期才出现）。 */
    async recent(days = 7) {
      const all = await states.all();
      const from = new Date(clock.now());
      from.setDate(from.getDate() - (days - 1));
      const fromKey = dateKey(from);
      return all
        .filter((item) => item.date >= fromKey)
        .sort((a, b) => (a.date < b.date ? -1 : 1));
    },

    score: readiness,
    capacity: capacityMinutes,
    mode: modeOf,
    interpret,
  };
}
