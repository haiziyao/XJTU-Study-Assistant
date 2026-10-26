/**
 * 角色成长层：把"今天做了事"翻译成一件看得见的事。
 *
 * 设计上刻意避开两种俗套：
 * - 不做"金币/商店"，那会把自我管理变成另一种消费；
 * - 不做扣血惩罚 —— 逾期只提醒，不惩罚。惩罚机制在长期使用里只会让人关掉程序。
 *
 * 五个属性各自对应一类行为，等级只由**累计有效投入**决定，
 * 所以不存在"刷分"空间：一次完成只加一次，撤销会扣回。
 */

import { addDays, dateKey } from './time.js';
import { badRequest } from './errors.js';
import { collection, doc } from './store-utils.js';

export const ATTR_BY_KIND = {
  focus: 'focus',
  mind: 'wisdom',
  body: 'vitality',
  life: 'discipline',
  recover: 'resilience',
};

export const ATTR_LABELS = {
  focus: '专注',
  wisdom: '认知',
  vitality: '体魄',
  discipline: '秩序',
  resilience: '韧性',
};

export const MAX_LEVEL = 99;

/** 从 level 升到 level+1 需要的经验：100、160、220…（每级 +60）。 */
export function xpForNextLevel(level) {
  return 100 + (Math.max(1, level) - 1) * 60;
}

/** 达到某等级所需的累计经验。 */
export function totalXpForLevel(level) {
  const l = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
  return (l - 1) * 100 + 30 * (l - 1) * (l - 2);
}

/** 累计经验 → { level, xpIntoLevel, xpForNext, progress }。 */
export function levelFromTotalXp(totalXp) {
  let total = Math.max(0, Math.floor(Number(totalXp) || 0));
  let level = 1;
  while (level < MAX_LEVEL && total >= totalXpForLevel(level + 1)) level += 1;
  const floorXp = totalXpForLevel(level);
  const next = level >= MAX_LEVEL ? null : xpForNextLevel(level);
  const into = total - floorXp;
  return {
    level,
    totalXp: total,
    xpIntoLevel: into,
    xpForNext: next,
    progress: next ? Math.min(1, into / next) : 1,
  };
}

/**
 * 连击：从今天（或昨天）往前数，连续有完成记录的天数。
 * 今天还没打卡不算断 —— 一天过完才算。
 */
export function computeStreak(doneDates, today = dateKey()) {
  const set = doneDates instanceof Set ? doneDates : new Set(doneDates);
  let cursor = set.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (set.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/** 连击的"用词"：让页面上的数字有语气，不至于冷冰冰。 */
export function streakLabel(streak) {
  if (streak >= 30) return '一个月的连续性，这已经变成身份了';
  if (streak >= 14) return '两周没断，进入复利区间';
  if (streak >= 7) return '一周不断，习惯开始成形';
  if (streak >= 3) return '三天不断，先保住这条线';
  if (streak >= 1) return '今天还在线上';
  return '还没开始，从最小的一条任务起';
}

export const ACHIEVEMENTS = [
  { id: 'first-blood', name: '首次落笔', desc: '完成第一条任务', test: (s) => s.counters.tasksDone >= 1 },
  { id: 'ten-tasks', name: '十事成', desc: '累计完成 10 条任务', test: (s) => s.counters.tasksDone >= 10 },
  { id: 'fifty-tasks', name: '五十事成', desc: '累计完成 50 条任务', test: (s) => s.counters.tasksDone >= 50 },
  { id: 'streak-3', name: '三日不断', desc: '连续 3 天有产出', test: (s) => s.streak >= 3 },
  { id: 'streak-7', name: '一周不断', desc: '连续 7 天有产出', test: (s) => s.streak >= 7 },
  { id: 'streak-30', name: '一月不断', desc: '连续 30 天有产出', test: (s) => s.streak >= 30 },
  { id: 'perfect-day', name: '全清', desc: '一天之内的任务全部完成', test: (s) => s.dayStats.total > 0 && s.dayStats.done === s.dayStats.total },
  { id: 'recover-hero', name: '修复日', desc: '低状态日（修复模式）仍完成 3 条以上', test: (s) => s.mode === 'recover' && s.dayStats.done >= 3 },
  { id: 'level-5', name: 'Lv.5 成形', desc: '角色升到 5 级', test: (s) => s.level >= 5 },
  { id: 'level-10', name: 'Lv.10 稳定', desc: '角色升到 10 级', test: (s) => s.level >= 10 },
  { id: 'observe-7', name: '七日观察', desc: '连续 7 天录入了状态', test: (s) => s.stateStreak >= 7 },
];

export const DEFAULT_CHARACTER = {
  name: 'Operator',
  level: 1,
  totalXp: 0,
  attrs: { focus: 0, wisdom: 0, vitality: 0, discipline: 0, resilience: 0 },
  streak: 0,
  bestStreak: 0,
  lastActiveDate: null,
  achievements: [],
  counters: { tasksDone: 0, perfectDays: 0, recoverDays: 0 },
};

function consecutiveStateDays(states, today) {
  const set = new Set(states.map((item) => item.date));
  let cursor = set.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (set.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

export function createRpgService({ store, clock }) {
  const character = doc(store, 'growthRpg', DEFAULT_CHARACTER);

  async function snapshot(extra = {}) {
    const current = await character.read();
    const derived = levelFromTotalXp(current.totalXp);
    return { ...current, ...derived, ...extra };
  }

  return {
    async read() {
      return snapshot({ streakLabel: streakLabel((await character.read()).streak) });
    },

    async rename(name) {
      const clean = String(name ?? '').trim().slice(0, 24);
      if (!clean) throw badRequest('INVALID_FIELD', '角色名不能为空');
      const next = await character.update({ name: clean });
      return snapshot({ ...next });
    },

    /** 完成一条任务 → 加经验、加属性、刷新连击、检查成就。 */
    async award(task) {
      const current = await character.read();
      const before = levelFromTotalXp(current.totalXp);
      const gained = Math.max(0, Number(task.xp) || 0);
      const attrKey = ATTR_BY_KIND[task.kind] ?? 'discipline';
      const attrGain = 1 + (Number(task.difficulty) >= 4 ? 1 : 0);

      const attrs = { ...current.attrs, [attrKey]: (current.attrs?.[attrKey] ?? 0) + attrGain };
      const totalXp = current.totalXp + gained;
      const after = levelFromTotalXp(totalXp);

      const doneDates = await this.tasks.completedDates();
      const streak = computeStreak(doneDates, dateKey(clock.now()));

      const dayStats = await this.tasks.stats(task.date);
      const states = await collection(store, 'growthStates').all();
      const stateEntry = states.find((item) => item.date === task.date);
      const stateStreak = consecutiveStateDays(states, dateKey(clock.now()));

      const unlocked = new Set((current.achievements ?? []).map((item) => item.id));
      const newAchievements = [];
      const ctxSnapshot = {
        counters: {
          ...current.counters,
          tasksDone: (current.counters?.tasksDone ?? 0) + 1,
          perfectDays:
            (current.counters?.perfectDays ?? 0) + (dayStats.done === dayStats.total && dayStats.total > 0 ? 1 : 0),
          recoverDays: (current.counters?.recoverDays ?? 0) + (stateEntry?.mode === 'recover' ? 1 : 0),
        },
        streak,
        level: after.level,
        dayStats,
        stateStreak,
        mode: stateEntry?.mode ?? 'steady',
      };
      for (const achievement of ACHIEVEMENTS) {
        if (unlocked.has(achievement.id)) continue;
        if (achievement.test(ctxSnapshot)) {
          unlocked.add(achievement.id);
          newAchievements.push({ id: achievement.id, name: achievement.name, desc: achievement.desc, at: clock.now().toISOString() });
        }
      }

      const next = {
        ...current,
        level: after.level,
        totalXp,
        attrs,
        streak,
        bestStreak: Math.max(current.bestStreak ?? 0, streak),
        lastActiveDate: task.date,
        counters: ctxSnapshot.counters,
        achievements: [...(current.achievements ?? []), ...newAchievements],
      };
      await character.set(next);

      return {
        xp: gained,
        attr: attrKey,
        attrGain,
        level: after.level,
        leveledUp: after.level > before.level,
        prevLevel: before.level,
        totalXp,
        streak,
        newAchievements,
      };
    },

    /** 撤销完成 → 扣回经验与属性（不允许扣成负数）。 */
    async revoke(task) {
      const current = await character.read();
      const gained = Math.max(0, Number(task.xp) || 0);
      const attrKey = ATTR_BY_KIND[task.kind] ?? 'discipline';
      // 与 award 用同一个公式，否则难度 4 的任务会留下 1 点属性残值
      const attrLoss = 1 + (Number(task.difficulty) >= 4 ? 1 : 0);
      const totalXp = Math.max(0, current.totalXp - gained);
      const after = levelFromTotalXp(totalXp);
      const attrs = {
        ...current.attrs,
        [attrKey]: Math.max(0, (current.attrs?.[attrKey] ?? 0) - attrLoss),
      };
      const doneDates = await this.tasks.completedDates();
      const streak = computeStreak(doneDates, dateKey(clock.now()));
      await character.set({
        ...current,
        level: after.level,
        totalXp,
        attrs,
        streak,
        counters: {
          ...current.counters,
          tasksDone: Math.max(0, (current.counters?.tasksDone ?? 0) - 1),
        },
      });
      return { revoked: true, xp: -gained, level: after.level, streak };
    },

    async achievements() {
      const current = await character.read();
      const unlocked = new Set((current.achievements ?? []).map((item) => item.id));
      return ACHIEVEMENTS.map((achievement) => ({
        id: achievement.id,
        name: achievement.name,
        desc: achievement.desc,
        unlocked: unlocked.has(achievement.id),
        at: (current.achievements ?? []).find((item) => item.id === achievement.id)?.at ?? null,
      }));
    },
  };
}
