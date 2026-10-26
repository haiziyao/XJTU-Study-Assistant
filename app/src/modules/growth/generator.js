/**
 * 动态任务表单生成器（纯函数，可单测）。
 *
 * 输入：就绪度、可投入分钟数、模式、日期、最近几天做过的任务名。
 * 输出：一份当天的任务清单 + 一份"为什么这么排"的理由。
 *
 * 三条硬规则：
 *   1. **预算硬约束**：所有任务预估时长之和不得超过当天可投入分钟数；
 *   2. **覆盖优先**：先保证最低配比（如修复日必须有恢复项和身体项），再谈分数；
 *   3. **可复现**：同一个 (日期, 就绪度, 预算) 永远生成同一份表单 ——
 *      随机只用于"同分打散"，种子来自输入本身，不用 Math.random()。
 */

import { CATALOG, KINDS } from './catalog.js';

export const TARGET_DIFFICULTY = { push: 4, steady: 3, recover: 2 };

/** 每种模式的最低配比。数字是"至少几条"。 */
export const REQUIREMENTS = {
  push: { focus: 2, mind: 1, body: 1 },
  steady: { focus: 1, mind: 1, body: 1 },
  recover: { recover: 2, body: 1 },
};

const KIND_WEIGHT = {
  push: { focus: 1.7, mind: 1.15, body: 1.1, life: 0.9, recover: 0.55 },
  steady: { focus: 1.2, mind: 1.1, body: 1.1, life: 1.0, recover: 1.0 },
  recover: { focus: 0.45, mind: 0.8, body: 1.25, life: 0.85, recover: 1.9 },
};

/**
 * 同类任务的条数上限。
 * 没有上限的后果是实测过的：修复日会排成 5 条恢复项，"什么都不做 15 分钟"
 * 和 "慢走不看手机" 挤在一起 —— 看着很多，其实是一条建议说了五遍。
 */
const MAX_PER_KIND = { focus: 3, mind: 2, body: 2, life: 2, recover: 3 };

/** 稳定哈希 → 32 位种子。 */
export function hashSeed(input) {
  const text = String(input);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32：小而稳的确定性随机。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function templateScore(template, { mode, targetDifficulty, recentTitles, rng }) {
  let score = KIND_WEIGHT[mode][template.kind] ?? 1;
  score *= Math.exp(-0.45 * Math.abs(template.difficulty - targetDifficulty));
  if (template.estimateMin >= 90) {
    score *= mode === 'push' ? 0.95 : mode === 'recover' ? 0.2 : 0.55;
  }
  if (recentTitles.has(template.title)) score *= 0.35;
  score *= 0.85 + 0.3 * rng();
  return score;
}

function orderFor(mode, tasks) {
  const kindRank = { focus: 0, mind: 1, body: 2, life: 3, recover: 4 };
  const sorted = [...tasks];
  if (mode === 'push') {
    sorted.sort((a, b) => b.difficulty - a.difficulty || kindRank[a.kind] - kindRank[b.kind]);
  } else if (mode === 'recover') {
    sorted.sort((a, b) => a.difficulty - b.difficulty || a.estimateMin - b.estimateMin);
  } else {
    sorted.sort((a, b) => kindRank[a.kind] - kindRank[b.kind] || b.difficulty - a.difficulty);
  }
  return sorted;
}

function slotOf(cumulativeRatio) {
  if (cumulativeRatio < 0.35) return '上午';
  if (cumulativeRatio < 0.72) return '下午';
  return '晚上';
}

/**
 * @param {object} input
 * @param {string} input.date        日期键
 * @param {number} input.score       就绪度 0–100
 * @param {number} input.capacity    可投入分钟数
 * @param {'push'|'steady'|'recover'} input.mode
 * @param {string[]} [input.recentTitles] 最近 3 天做过的任务标题
 * @param {number} [input.maxTasks]  最多几条（默认 6）
 * @param {Array}  [input.catalog]   模板库（测试可注入）
 */
export function generatePlan({
  date,
  score,
  capacity,
  mode,
  recentTitles = [],
  maxTasks = 6,
  catalog = CATALOG,
}) {
  const budget = Math.max(15, Math.round(Number(capacity) || 0));
  const targetDifficulty = TARGET_DIFFICULTY[mode] ?? 3;
  const rng = mulberry32(hashSeed(`${date}:${Math.round(score)}:${budget}:${mode}`));
  const recent = new Set(recentTitles.map((title) => String(title)));
  const rationale = [];

  const scored = catalog
    .map((template) => ({
      template,
      score: templateScore(template, { mode, targetDifficulty, recentTitles: recent, rng }),
    }))
    .sort((a, b) => b.score - a.score);

  const picked = [];
  const pickedIds = new Set();
  const pickedTitles = new Set();
  const kindCount = {};
  let used = 0;

  const canFit = (template) =>
    used + template.estimateMin <= budget && (kindCount[template.kind] ?? 0) < (MAX_PER_KIND[template.kind] ?? 2);

  const take = (template) => {
    picked.push(template);
    pickedIds.add(template.id);
    pickedTitles.add(template.title);
    kindCount[template.kind] = (kindCount[template.kind] ?? 0) + 1;
    used += template.estimateMin;
  };

  // 第一轮：满足最低配比（同类只挑分数最高的、且装得下的那条）
  const requirements = REQUIREMENTS[mode] ?? {};
  for (const [kind, need] of Object.entries(requirements)) {
    for (let i = 0; i < need; i++) {
      if (picked.length >= maxTasks) break;
      const candidate = scored.find(
        ({ template }) =>
          template.kind === kind &&
          !pickedIds.has(template.id) &&
          !pickedTitles.has(template.title) &&
          canFit(template),
      );
      if (!candidate) {
        rationale.push(`预算装不下更多的「${KINDS[kind]?.label ?? kind}」项，本次少排一条。`);
        break;
      }
      take(candidate.template);
    }
  }

  // 第二轮：用剩下的预算继续按分数补，直到装不下或到达上限
  for (const { template } of scored) {
    if (picked.length >= maxTasks) break;
    if (pickedIds.has(template.id) || pickedTitles.has(template.title)) continue;
    if (!canFit(template)) continue;
    take(template);
  }

  // 兜底：预算再紧也至少给一条最短的任务，否则"今日任务表单"会是空的
  if (!picked.length) {
    const shortest = [...catalog].sort((a, b) => a.estimateMin - b.estimateMin)[0];
    if (shortest) take(shortest);
  }

  const ordered = orderFor(mode, picked);
  let cumulative = 0;
  const tasks = ordered.map((template, index) => {
    const startRatio = used ? cumulative / used : 0;
    cumulative += template.estimateMin;
    return {
      templateId: template.id,
      title: template.title,
      detail: template.detail,
      kind: template.kind,
      estimateMin: template.estimateMin,
      difficulty: template.difficulty,
      priority: index === 0 ? 1 : template.difficulty >= 4 ? 2 : 3,
      slot: slotOf(startRatio),
    };
  });

  const kindSummary = tasks.reduce((acc, task) => {
    acc[task.kind] = (acc[task.kind] ?? 0) + 1;
    return acc;
  }, {});

  rationale.unshift(
    `就绪度 ${Math.round(score)} 分 → ${mode} 模式，可投入约 ${budget} 分钟，目标难度 ${targetDifficulty}。`,
  );
  rationale.push(
    `本次排 ${tasks.length} 条，合计 ${used} 分钟（预算 ${budget} 分钟），配比：` +
      Object.entries(kindSummary)
        .map(([kind, count]) => `${KINDS[kind]?.label ?? kind}×${count}`)
        .join('、'),
  );
  if (mode === 'recover') rationale.push('低状态日不排长任务：先让身体动起来，再谈产出。');
  if (mode === 'push') rationale.push('状态好：高难度项排在最前面，趁电量足的时候啃硬骨头。');

  return {
    date,
    mode,
    score: Math.round(Number(score) * 10) / 10,
    budget,
    usedMinutes: used,
    tasks,
    rationale,
  };
}
