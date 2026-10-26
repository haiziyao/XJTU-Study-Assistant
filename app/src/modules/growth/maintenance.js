/**
 * 数据自检：启动时（或手动触发）检查那些"不会报错但会让人糊涂"的不一致。
 *
 * 为什么需要它：这套数据是可读 JSON，用户可以手改、可以跨版本升级、可以恢复备份。
 * 一旦出现悬空的 planId 或对不上的计数，界面不会崩，但数字会开始说谎。
 *
 * 三条原则：
 * 1. **幂等**：跑多少次结果一样；
 * 2. **不删数据**：只做"解绑 / 重算"，绝不删除记录；
 * 3. **留痕**：修了什么写进日志与返回报告，让用户能看见。
 */

import { iso } from './time.js';
import { collection, doc } from './store-utils.js';
import { readiness, capacityMinutes, modeOf } from './state.js';

export function createMaintenanceService({ store, clock, services }) {
  let lastReport = null;

  async function check({ repair = true } = {}) {
    const startedAt = iso(clock.now());
    const fixed = {};
    const plans = await collection(store, 'growthPlans').all();
    const tasksCol = collection(store, 'growthTasks');
    const tasks = await tasksCol.all();
    const planById = new Map(plans.map((plan) => [plan.id, plan]));

    // 1) 任务指向了不存在的计划 → 解绑（不删任务本身）
    const dangling = tasks.filter((task) => task.planId && !planById.has(task.planId));
    if (repair) {
      for (const task of dangling) await tasksCol.patch(task.id, { planId: null });
    }
    fixed.detachedTasks = dangling.length;

    // 2) 计划的 taskIds 与实际任务对不上 → 按日期重算
    let taskIdsFixed = 0;
    const tasksByDate = new Map();
    for (const task of tasks) {
      if (!tasksByDate.has(task.date)) tasksByDate.set(task.date, []);
      tasksByDate.get(task.date).push(task.id);
    }
    for (const plan of plans) {
      const actual = tasksByDate.get(plan.date) ?? [];
      const current = plan.taskIds ?? [];
      const same = actual.length === current.length && actual.every((id) => current.includes(id));
      if (same) continue;
      if (repair) await collection(store, 'growthPlans').patch(plan.id, { taskIds: actual });
      taskIdsFixed += 1;
    }
    fixed.planTaskIds = taskIdsFixed;

    // 3) 角色的"累计完成条数"与真实任务数不一致 → 重算
    const characterDoc = doc(store, 'growthRpg', {});
    const character = await characterDoc.read();
    const doneCount = tasks.filter((task) => task.status === 'done').length;
    const before = character.counters?.tasksDone ?? 0;
    if (before !== doneCount) {
      if (repair) await characterDoc.update({ counters: { ...(character.counters ?? {}), tasksDone: doneCount } });
      fixed.characterCounters = { before, after: doneCount };
    } else {
      fixed.characterCounters = 0;
    }

    // 4) 状态记录里的派生字段（分数/预算/模式）与当前公式不一致 → 重算
    const statesCol = collection(store, 'growthStates');
    const states = await statesCol.all();
    let recomputed = 0;
    for (const entry of states) {
      const score = readiness(entry);
      const capacity = capacityMinutes(score);
      const mode = modeOf(score).key;
      const drift =
        Math.abs(Number(entry.score ?? -1) - score) > 0.05 || entry.capacity !== capacity || entry.mode !== mode;
      if (!drift) continue;
      if (repair) await statesCol.patch(entry.id, { score, capacity, mode });
      recomputed += 1;
    }
    fixed.statesRecomputed = recomputed;

    // 5) 进行中但没有结束时间的旧会话（除了当前这条） → 补记
    const sessionsCol = collection(store, 'growthSessions');
    const sessions = await sessionsCol.all();
    const open = sessions.filter((session) => !session.endedAt);
    const currentId = services?.session?.currentSession?.id ?? null;
    const stale = open.filter((session) => session.id !== currentId);
    if (repair && stale.length) {
      for (const session of stale) {
        await sessionsCol.patch(session.id, { endedAt: iso(clock.now()), closedBy: 'self-check' });
      }
    }
    fixed.sessionsClosed = stale.length;

    const report = {
      at: startedAt,
      ok: true,
      repair,
      fixed,
      totalFixed: Object.values(fixed).reduce((sum, value) => {
        if (typeof value === 'number') return sum + value;
        if (value && typeof value === 'object') return sum + 1;
        return sum;
      }, 0),
      checked: {
        plans: plans.length,
        tasks: tasks.length,
        states: states.length,
        sessions: sessions.length,
        openSessions: open.length,
      },
    };
    lastReport = report;
    return report;
  }

  return {
    check,
    get last() {
      return lastReport;
    },
  };
}
