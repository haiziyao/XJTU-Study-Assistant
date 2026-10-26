/**
 * 每日计划模块：把"状态 + 模板库"变成一份可执行的任务表单。
 *
 * 一条重要口径：**重新生成不会抹掉已完成的事**。
 * force 重排时只清掉这一天里"还没动过的自动生成项"，手动加的、已打卡的、
 * 自己跳过的都留着 —— 否则用户上午打完卡，下午想调一下难度，战果就没了。
 */

import { badRequest } from './errors.js';
import { dateKey, addDays, isValidDateKey, iso } from './time.js';
import { collection } from './store-utils.js';
import { generatePlan } from './generator.js';
import { CATALOG } from './catalog.js';
import { MODES } from './state.js';

export function createPlanService({ store, clock }) {
  const plans = collection(store, 'growthPlans');

  return {
    async get(date) {
      const plan = await plans.one((item) => item.date === date);
      if (!plan) return null;
      // 按日期取，而不是按 planId：手动加的任务同样属于这一天
      const tasks = await collection(store, 'growthTasks').find((task) => task.date === date);
      const stats = await this.tasks.stats(date);
      return { plan, tasks, stats };
    },

    async generate({ date, force = false } = {}) {
      const day = date ? String(date) : dateKey(clock.now());
      if (!isValidDateKey(day)) throw badRequest('INVALID_DATE', '日期必须是真实存在的 YYYY-MM-DD');

      const entry = await this.state.get(day);
      if (!entry) {
        throw badRequest('STATE_REQUIRED', '还没有今天的身体/精神状态记录，先录入状态再生成任务表单', { date: day });
      }

      const existing = await plans.one((item) => item.date === day);
      if (existing && !force) {
        const detail = await this.get(day);
        return { ...detail, created: false };
      }

      if (existing && force) {
        const old = await collection(store, 'growthTasks').find(
          (task) => task.planId === existing.id && task.status === 'todo' && task.source === 'generated',
        );
        for (const task of old) await collection(store, 'growthTasks').remove(task.id);
        await plans.remove(existing.id);
      }

      // 最近三天做过的任务名，用来避免天天排同一条
      const recentTasks = await collection(store, 'growthTasks').find(
        (task) => task.date < day && task.date >= addDays(day, -3),
      );
      const recentTitles = recentTasks.map((task) => task.title);

      const generated = generatePlan({
        date: day,
        score: entry.score,
        capacity: entry.capacity,
        mode: entry.mode,
        recentTitles,
        catalog: (await this.templates?.active?.()) ?? CATALOG,
      });

      const plan = await plans.insert({
        date: day,
        score: entry.score,
        capacity: entry.capacity,
        mode: entry.mode,
        modeLabel: MODES[entry.mode]?.label ?? entry.mode,
        budget: generated.budget,
        usedMinutes: generated.usedMinutes,
        rationale: generated.rationale,
        taskIds: [],
        briefing: null,
        source: 'rules',
        generatedAt: iso(clock.now()),
      });

      const tasks = await this.tasks.createMany({ ...generated, id: plan.id });
      const updated = await plans.patch(plan.id, { taskIds: tasks.map((task) => task.id) });

      // 返回当天的全部任务（含强制重排时保留下来的已完成项），页面直接照这个渲染
      return {
        plan: updated,
        tasks: await this.tasks.list({ date: day }),
        stats: await this.tasks.stats(day),
        created: true,
      };
    },

    /** 手动加任务时把它挂到当天的计划上（没有计划就建一个空壳）。 */
    async attachTask(planId, taskId) {
      const plan = await plans.get(planId);
      if (!plan) return null;
      const taskIds = [...new Set([...(plan.taskIds ?? []), taskId])];
      return plans.patch(planId, { taskIds });
    },

    async list({ from, to } = {}) {
      const all = await plans.all();
      return all
        .filter((plan) => (!from || plan.date >= from) && (!to || plan.date <= to))
        .sort((a, b) => (a.date < b.date ? 1 : -1));
    },
  };
}
