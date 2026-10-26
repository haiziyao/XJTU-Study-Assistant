/**
 * 任务模块：生成之后的事都归它管 —— 打卡、逾期、统计、跨天结转。
 *
 * 一条任务的 `dueAt` 就是它那天的 23:59:59。逾期不是"失败"，而是第二天
 * 提醒你的依据；系统不会自动删掉没做完的事，只会把它标出来（删数据是最
 * 不可逆的操作，这类决定永远留给用户）。
 *
 * 与源项目的差别只有存储适配：集合对象换成成长模块的 `collection()` 包装，
 * 业务判断（幂等打卡、撤销扣回、改期只允许未完成项）逐字保留。
 */

import { badRequest, notFound } from './errors.js';
import { addDays, dateKey, endOfDay, isValidDateKey, iso } from './time.js';
import { collection } from './store-utils.js';

export const STATUSES = ['todo', 'done', 'skipped'];

export function xpForTask(task) {
  const difficulty = Math.max(1, Math.min(5, Number(task.difficulty) || 1));
  const minutes = Math.max(0, Math.min(240, Number(task.estimateMin) || 0));
  const base = difficulty * 8 + Math.min(20, Math.round(minutes / 5));
  const bonus = task.kind === 'focus' ? 5 : 0;
  return base + bonus;
}

export function createTaskService({ store, clock }) {
  const tasks = collection(store, 'growthTasks');

  return {
    async createMany(plan) {
      const dueAt = iso(endOfDay(plan.date));
      const docs = plan.tasks.map((task) => ({
        date: plan.date,
        planId: plan.id,
        title: task.title,
        detail: task.detail,
        kind: task.kind,
        estimateMin: task.estimateMin,
        difficulty: task.difficulty,
        priority: task.priority,
        slot: task.slot,
        source: task.source ?? 'generated',
        status: 'todo',
        doneAt: null,
        dueAt,
        xp: xpForTask(task),
      }));
      return docs.length ? tasks.insertMany(docs) : [];
    },

    /** 手加一条（比如临时冒出来的事）。 */
    async createManual(input) {
      const title = String(input.title ?? '').trim();
      if (!title) throw badRequest('INVALID_FIELD', '任务标题不能为空');
      if (title.length > 80) throw badRequest('INVALID_FIELD', '标题最多 80 字');
      const date = input.date ? String(input.date) : dateKey(clock.now());
      if (!isValidDateKey(date)) throw badRequest('INVALID_DATE', '日期必须是真实存在的 YYYY-MM-DD');
      const estimateMin = Math.max(5, Math.min(240, Number(input.estimateMin) || 25));
      const difficulty = Math.max(1, Math.min(5, Number(input.difficulty) || 2));
      const kind = ['focus', 'mind', 'body', 'life', 'recover'].includes(input.kind) ? input.kind : 'life';
      const doc = {
        date,
        planId: input.planId ?? null,
        title,
        detail: String(input.detail ?? '').slice(0, 300),
        kind,
        estimateMin,
        difficulty,
        priority: 2,
        slot: input.slot ?? '随时',
        source: 'manual',
        status: 'todo',
        doneAt: null,
        dueAt: iso(endOfDay(date)),
        xp: xpForTask({ difficulty, estimateMin, kind }),
      };
      return tasks.insert(doc);
    },

    async list({ date, status, from, to, includeSkipped = true } = {}) {
      const all = await tasks.all();
      return all
        .filter((task) => {
          if (date && task.date !== date) return false;
          if (status && task.status !== status) return false;
          if (!includeSkipped && task.status === 'skipped') return false;
          if (from && task.date < from) return false;
          if (to && task.date > to) return false;
          return true;
        })
        .sort((a, b) => a.date.localeCompare(b.date) || a.priority - b.priority || a.title.localeCompare(b.title));
    },

    async get(id) {
      return tasks.get(id);
    },

    /** 把一条任务挂到当天的计划上（手动加的任务也要进"今日表单"）。 */
    async attachPlan(id, planId) {
      if (!planId) return tasks.get(id);
      return tasks.patch(id, { planId });
    },

    async remove(id) {
      const removed = await tasks.remove(id);
      if (!removed) throw notFound('TASK_NOT_FOUND', '任务不存在');
      return { ok: true, removed: true };
    },

    /**
     * 打卡。完成时给角色加经验，并广播事件让页面与提醒立刻同步。
     * 重复完成同一条不会重复加经验（幂等）。
     */
    async setStatus(id, status, { note } = {}) {
      if (!STATUSES.includes(status)) {
        throw badRequest('INVALID_STATUS', `status 只能是 ${STATUSES.join(' / ')}`);
      }
      const current = await tasks.get(id);
      if (!current) throw notFound('TASK_NOT_FOUND', '任务不存在');

      const patch = { status };
      if (note !== undefined) patch.note = String(note).slice(0, 300);

      if (status === 'done') {
        if (current.status === 'done') return { task: current, award: null, idempotent: true };
        patch.doneAt = iso(clock.now());
      } else {
        patch.doneAt = null;
      }

      const updated = await tasks.patch(id, patch);

      let award = null;
      if (status === 'done') {
        award = await this.rpg?.award(updated);
      } else if (current.status === 'done') {
        // 撤销完成：把经验扣回去，否则反复勾选可以刷级
        award = await this.rpg?.revoke(updated);
      }
      return { task: updated, award };
    },

    /** 逾期：状态仍是 todo 且截止时间已过。 */
    async overdue(now = clock.now()) {
      const all = await tasks.all();
      const nowMs = now.getTime();
      return all
        .filter((task) => task.status === 'todo' && task.dueAt && new Date(task.dueAt).getTime() < nowMs)
        .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    },

    /**
     * 改期：把一条未完成的任务挪到某天（默认明天）。
     * 这是逾期提醒的"出口"—— 没有出口的提醒只会让人习惯性忽略。
     */
    async postpone(id, { to } = {}) {
      const task = await tasks.get(id);
      if (!task) throw notFound('TASK_NOT_FOUND', '任务不存在');
      if (task.status !== 'todo') throw badRequest('INVALID_STATUS', '只有未完成的任务可以改期');
      const today = dateKey(clock.now());
      const target = to ? String(to) : addDays(today, 1);
      if (!isValidDateKey(target)) throw badRequest('INVALID_DATE', '日期必须是真实存在的 YYYY-MM-DD');
      if (target < today) throw badRequest('INVALID_DATE', '不能改到过去');
      return tasks.patch(id, {
        date: target,
        dueAt: iso(endOfDay(target)),
        postponedFrom: task.postponedFrom ?? task.date,
        postponedCount: (task.postponedCount ?? 0) + 1,
      });
    },

    async stats(date = dateKey(clock.now())) {
      const todays = await this.list({ date });
      const done = todays.filter((task) => task.status === 'done');
      return {
        date,
        total: todays.length,
        done: done.length,
        skipped: todays.filter((task) => task.status === 'skipped').length,
        todo: todays.filter((task) => task.status === 'todo').length,
        minutesDone: done.reduce((sum, task) => sum + (task.estimateMin ?? 0), 0),
        minutesPlanned: todays.reduce((sum, task) => sum + (task.estimateMin ?? 0), 0),
        xpDone: done.reduce((sum, task) => sum + (task.xp ?? 0), 0),
      };
    },

    /** 有完成记录的日期键集合（连击计算要用）。 */
    async completedDates() {
      const all = await tasks.all();
      const set = new Set();
      for (const task of all) {
        if (task.status === 'done' && task.doneAt) set.add(task.date);
      }
      return set;
    },
  };
}
