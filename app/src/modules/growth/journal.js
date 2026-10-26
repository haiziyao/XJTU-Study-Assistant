/**
 * 日志/日记模块：把散在各处的数据聚成"一天的现场"，以及"一周的账"。
 *
 * 页面上的「今日」「趋势」「周报」「导出」都走这里，保证只有一套口径：
 * 完成率、投入分钟、经验值都从同一份快照算出来。
 */

import { addDays, dateKey, isValidDateKey, lastDays, iso } from './time.js';
import { badRequest } from './errors.js';
import { collection } from './store-utils.js';
import { computeStreak, streakLabel } from './rpg.js';
import { KINDS } from './catalog.js';

const MODE_LABEL = { push: '推进', steady: '稳态', recover: '修复' };

function assertDate(value, label) {
  if (!isValidDateKey(value)) throw badRequest('INVALID_DATE', `${label}必须是真实存在的 YYYY-MM-DD 日期`);
  return String(value);
}

function dayPoint(date, entry, dayTasks) {
  const done = dayTasks.filter((task) => task.status === 'done');
  return {
    date,
    hasState: Boolean(entry),
    score: entry?.score ?? null,
    mode: entry?.mode ?? null,
    sleepHours: entry?.sleepHours ?? null,
    total: dayTasks.length,
    done: done.length,
    minutes: done.reduce((sum, task) => sum + (task.estimateMin ?? 0), 0),
    xp: done.reduce((sum, task) => sum + (task.xp ?? 0), 0),
  };
}

const rateOf = (rows) => {
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const done = rows.reduce((sum, row) => sum + row.done, 0);
  return { total, done, rate: total ? done / total : 0 };
};

/**
 * 一周的"可执行洞察"（纯规则）。
 *
 * 只讲这周数据里真的能看见的关系，不做因果断言：说"低状态日完成率更低"，
 * 不说"因为状态差所以做不完"。规则不满足就一条都不给 —— 空白好过编故事。
 */
export function weekInsights(points, byKind = {}) {
  const out = [];
  const withData = points.filter((point) => point.hasState && point.total > 0);

  if (withData.length >= 3) {
    const low = withData.filter((point) => point.score < 55);
    const high = withData.filter((point) => point.score >= 55);
    if (low.length && high.length) {
      const rl = rateOf(low).rate;
      const rh = rateOf(high).rate;
      if (rh - rl >= 0.15) {
        out.push(
          `低状态日完成率 ${Math.round(rl * 100)}%，状态好的日子 ${Math.round(rh * 100)}% —— 表单确实在跟着电量走，这套排法可以继续用。`,
        );
      } else if (rl - rh >= 0.15) {
        out.push(
          `低状态日完成率（${Math.round(rl * 100)}%）反而高于状态好的日子（${Math.round(rh * 100)}%）—— 可能是好状态那几天任务排太满，试试给自己留一小时空白。`,
        );
      }
    }

    const sleeping = withData.filter((point) => point.sleepHours != null);
    const short = sleeping.filter((point) => point.sleepHours < 6.5);
    const normal = sleeping.filter((point) => point.sleepHours >= 7);
    if (short.length >= 2 && normal.length >= 1) {
      const rs = rateOf(short).rate;
      const rn = rateOf(normal).rate;
      if (rn - rs >= 0.15) {
        out.push(
          `睡不足 6.5 小时的那 ${short.length} 天，完成率 ${Math.round(rs * 100)}%；睡够 7 小时以上是 ${Math.round(rn * 100)}%。睡眠是这个系统里最便宜的一档增益。`,
        );
      }
    }
  }

  const kinds = Object.entries(byKind).filter(([, bucket]) => bucket.planned >= 2);
  if (kinds.length >= 2) {
    const ranked = kinds
      .map(([kind, bucket]) => ({ kind, rate: bucket.done / bucket.planned, label: KINDS[kind]?.label ?? kind }))
      .sort((a, b) => b.rate - a.rate);
    const best = ranked[0];
    const worst = ranked[ranked.length - 1];
    if (best.rate - worst.rate >= 0.3) {
      out.push(
        `「${best.label}」类完成率 ${Math.round(best.rate * 100)}%，「${worst.label}」类只有 ${Math.round(worst.rate * 100)}% —— 下周把时间往前者挪一点。`,
      );
    }
  }

  const scores = points.filter((point) => point.hasState).map((point) => point.score);
  if (scores.length >= 6) {
    const head = scores.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
    const tail = scores.slice(-3).reduce((a, b) => a + b, 0) / 3;
    if (tail - head >= 8) out.push(`就绪度从周初平均 ${Math.round(head)} 回到 ${Math.round(tail)}，这周是在回血的，别在这时候加码。`);
    else if (head - tail >= 8) out.push(`就绪度从周初平均 ${Math.round(head)} 掉到 ${Math.round(tail)}，先查睡眠与压力，再谈任务量。`);
  }

  return out.slice(0, 3);
}

/** 一周的结论（纯规则，不依赖模型；宁可少说，不说空话）。 */
export function weekVerdict(summary) {
  const { totals, modeMix } = summary;
  if (!totals.planned && !totals.activeDays) return '这一周还没有任何记录。先录入一次状态，其它都会跟着动起来。';

  const lines = [];
  const rate = totals.planned ? Math.round((totals.done / totals.planned) * 100) : 0;
  const avgScore = totals.avgScore == null ? null : Math.round(totals.avgScore);

  if (totals.activeDays <= 2) {
    lines.push(`这周只动了 ${totals.activeDays} 天。先别谈优化，把"每天开机先录状态"变成条件反射。`);
  } else if (rate >= 80 && (avgScore ?? 0) >= 60) {
    lines.push('完成率与状态都在线：这时候最该警惕的是排太满，留一点余量给意外。');
  } else if (rate < 45) {
    lines.push('完成率偏低。要么任务排多了，要么状态读数没被当真 —— 下周把每日条数砍三分之一试试。');
  } else {
    lines.push(`完成率 ${rate}%，属于正常范围：不用加码，保住连续性比冲量有用。`);
  }

  if ((modeMix.recover ?? 0) >= 3) {
    lines.push(`这周有 ${modeMix.recover} 天处于修复模式，说明底子在漏电：优先补睡眠与身体项，而不是逼自己更努力。`);
  }
  if (avgScore != null) lines.push(`平均就绪度 ${avgScore}。`);
  return lines.join('');
}

/** 一天的 Markdown 日记（导出用，纯函数，可单测）。 */
export function dayToMarkdown({ date, state, plan, tasks, stats, character, logs = [] }) {
  const lines = [];
  lines.push(`# Brain Online · ${date}`);
  lines.push('');

  if (state) {
    lines.push(`- 就绪度：**${state.score}/100**（${MODE_LABEL[state.mode] ?? state.mode}模式），可投入约 ${state.capacity} 分钟`);
    lines.push(
      `- 状态：睡眠 ${state.sleepHours}h · 睡眠质量 ${state.sleepQuality}/5 · 精力 ${state.energy}/5 · 情绪 ${state.mood}/5 · 压力 ${state.stress}/5 · 专注 ${state.focus}/5 · 身体 ${state.body}/5`,
    );
    if (state.note) lines.push(`- 备注：${state.note}`);
  } else {
    lines.push('- 这天没有录入状态。');
  }
  lines.push('');

  const done = tasks.filter((task) => task.status === 'done').length;
  const total = tasks.length;
  lines.push(`## 任务（完成 ${done}/${total}，投入 ${stats?.minutesDone ?? 0} 分钟，获得 ${stats?.xpDone ?? 0} XP）`);
  lines.push('');
  if (!tasks.length) {
    lines.push('_这天没有任务。_');
  } else {
    for (const task of tasks) {
      const mark = task.status === 'done' ? 'x' : ' ';
      const kind = KINDS[task.kind]?.label ?? task.kind;
      const tail = task.status === 'done' ? ` · +${task.xp ?? 0} XP` : task.status === 'skipped' ? ' · 已跳过' : '';
      lines.push(`- [${mark}] ${task.title}（${kind} · ${task.estimateMin} 分钟 · 难度 ${task.difficulty}${tail}）`);
      if (task.detail) lines.push(`  - ${task.detail}`);
    }
  }
  lines.push('');

  if (plan?.rationale?.length) {
    lines.push('## 为什么这么排');
    lines.push('');
    for (const line of plan.rationale) lines.push(`- ${line}`);
    lines.push('');
  }

  if (character) {
    lines.push('## 角色');
    lines.push('');
    lines.push(`- Lv.${character.level} · 累计 ${character.totalXp} XP · 连击 ${character.streak} 天（最佳 ${character.bestStreak}）`);
    const attrs = character.attrs ?? {};
    lines.push(
      `- 属性：专注 ${attrs.focus ?? 0} · 认知 ${attrs.wisdom ?? 0} · 体魄 ${attrs.vitality ?? 0} · 秩序 ${attrs.discipline ?? 0} · 韧性 ${attrs.resilience ?? 0}`,
    );
    if (character.achievements?.length) {
      lines.push(`- 成就：${character.achievements.map((item) => item.name).join('、')}`);
    }
    lines.push('');
  }

  if (logs.length) {
    lines.push('## 日志');
    lines.push('');
    for (const log of logs.slice(-40)) {
      const time = String(log.at ?? '').slice(11, 16);
      lines.push(`- ${time} \`${log.type}\` ${log.message}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('由 Brain Online 生成（数据只在本机）。');
  return lines.join('\n');
}

export function createJournalService({ store, clock }) {
  return {
    async day(date) {
      const day = date ? String(date) : dateKey(clock.now());
      const [state, planDetail, stats, character, logs] = await Promise.all([
        this.state.get(day),
        collection(store, 'growthPlans').one((item) => item.date === day),
        this.tasks.stats(day),
        this.rpg.read(),
        collection(store, 'growthLogs').find((item) => (item.at ?? '').slice(0, 10) === day),
      ]);

      // 按日期取全部任务：手动加的、计划生成的都在这一天里
      const tasks = await collection(store, 'growthTasks').find((task) => task.date === day);
      tasks.sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));

      return {
        date: day,
        state,
        plan: planDetail,
        tasks,
        stats,
        character,
        xpGained: tasks.filter((task) => task.status === 'done').reduce((sum, task) => sum + (task.xp ?? 0), 0),
        logs: logs.slice(-50),
        generatedAt: iso(clock.now()),
      };
    },

    /** 最近 n 天的趋势：每天一条，没有数据的日期给 null 而不是 0。 */
    async trend(days = 14) {
      const keys = lastDays(days, clock.now());
      const [states, tasks] = await Promise.all([
        collection(store, 'growthStates').all(),
        collection(store, 'growthTasks').all(),
      ]);
      const stateByDate = new Map(states.map((item) => [item.date, item]));
      return keys.map((date) => dayPoint(date, stateByDate.get(date), tasks.filter((task) => task.date === date)));
    },

    /** 周报：截止日往前 7 天（含当天）。 */
    async weekly({ end } = {}) {
      const to = end ? assertDate(end, 'end') : dateKey(clock.now());
      const from = addDays(to, -6);
      const [states, tasks] = await Promise.all([
        collection(store, 'growthStates').all(),
        collection(store, 'growthTasks').all(),
      ]);
      const stateByDate = new Map(states.map((item) => [item.date, item]));

      const points = [];
      for (let i = 0; i < 7; i++) {
        const date = addDays(from, i);
        points.push(dayPoint(date, stateByDate.get(date), tasks.filter((task) => task.date === date)));
      }

      const weekTasks = tasks.filter((task) => task.date >= from && task.date <= to);
      const doneTasks = weekTasks.filter((task) => task.status === 'done');
      const scores = points.map((point) => point.score).filter((score) => score != null);

      const byKind = {};
      for (const task of weekTasks) {
        const bucket = (byKind[task.kind] ??= { planned: 0, done: 0, minutes: 0 });
        bucket.planned += 1;
        if (task.status === 'done') {
          bucket.done += 1;
          bucket.minutes += task.estimateMin ?? 0;
        }
      }

      const modeMix = { push: 0, steady: 0, recover: 0 };
      for (const point of points) {
        if (point.hasState && point.mode) modeMix[point.mode] = (modeMix[point.mode] ?? 0) + 1;
      }

      // 连击要用全量历史算，只看本周会把跨周延续的连续天数算短
      const allDoneDates = new Set(tasks.filter((task) => task.status === 'done').map((task) => task.date));
      const summary = {
        from,
        to,
        days: 7,
        points,
        totals: {
          planned: weekTasks.length,
          done: doneTasks.length,
          skipped: weekTasks.filter((task) => task.status === 'skipped').length,
          minutes: doneTasks.reduce((sum, task) => sum + (task.estimateMin ?? 0), 0),
          xp: doneTasks.reduce((sum, task) => sum + (task.xp ?? 0), 0),
          activeDays: points.filter((point) => point.done > 0).length,
          stateDays: points.filter((point) => point.hasState).length,
          avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
        },
        byKind,
        modeMix,
        streak: computeStreak(allDoneDates, to),
      };
      summary.verdict = weekVerdict(summary);
      summary.insights = weekInsights(points, byKind);
      summary.streakLabel = streakLabel(summary.streak);
      return summary;
    },

    /** 导出：一天或一个区间（最多 31 天）的 Markdown。 */
    async exportMarkdown({ date, from, to } = {}) {
      const start = from ? assertDate(from, 'from') : date ? assertDate(date, 'date') : dateKey(clock.now());
      const end = to ? assertDate(to, 'to') : start;
      if (from && !to) throw badRequest('INVALID_DATE', '给了 from 也要给 to');
      if (end < start) throw badRequest('INVALID_DATE', 'to 不能早于 from');
      const days = [];
      let cursor = start;
      let guard = 0;
      while (cursor <= end && guard < 31) {
        days.push(cursor);
        cursor = addDays(cursor, 1);
        guard += 1;
      }
      const sections = [];
      for (const day of days) {
        const detail = await this.day(day);
        sections.push(
          dayToMarkdown({
            date: day,
            state: detail.state,
            plan: detail.plan,
            tasks: detail.tasks,
            stats: detail.stats,
            character: detail.character,
            logs: detail.logs,
          }),
        );
      }
      return {
        from: days[0],
        to: days[days.length - 1],
        days: days.length,
        filename: days.length === 1 ? `brain-online-${days[0]}.md` : `brain-online-${days[0]}_${days[days.length - 1]}.md`,
        markdown: sections.join('\n\n---\n\n'),
      };
    },
  };
}
