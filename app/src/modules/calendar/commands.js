/**
 * 日历模块的对话指令处理器。
 *
 * 由 module.js 注册给 target `event` / `schedule` / `todo`（三者共用同一份实现：
 * 走哪条分支由 `draft.target` 决定）。
 *
 * 处理器契约见 core/commands/command-service.js：
 *   键 = action 名，值 = (draft, options) => object；`options.dryRun` 时只预览不写库。
 *
 * 语义铁律（2026-10 重做）：
 * - **「完成」只属于待办**：日程与日历事件都没有完成态，对它们 complete 一律 400；
 * - **「顺延」也只属于待办**：把未完成的待办截止日平移到目标周，不克隆记录。
 */

import { HttpError } from '../../core/http/router.js';

const TARGET_LABEL = { schedule: '日程', event: '日历事件', todo: '待办' };
const labelOf = (target) => TARGET_LABEL[target] ?? target;

export function createCalendarCommands({ events, schedules, todos, store }) {
  /** 三个 target 各自的集合服务：写库与「只校验」都从这里取，避免出现两套校验。 */
  const targetService = (target) =>
    target === 'todo' ? todos : target === 'schedule' ? schedules : target === 'event' ? events : null;

  /** 按 filters 定位待操作记录；id 优先。三个集合的过滤条件形状一致，但各自独立查询。 */
  function locate(draft) {
    const filters = draft.filters ?? {};
    if (draft.target === 'todo') {
      if (filters.id) return [todos.get(filters.id)];
      return todos.list({
        from: filters.from,
        to: filters.to,
        // 「完成」默认只找未完成的；删除/修改要能命中任意状态
        completed: filters.completed ?? (draft.action === 'complete' ? false : undefined),
        priority: filters.priority,
        keyword: filters.keyword,
      });
    }
    if (draft.target === 'schedule') {
      if (filters.id) return [schedules.get(filters.id)];
      return schedules.list({
        from: filters.from,
        to: filters.to,
        category: filters.category,
        keyword: filters.keyword,
      });
    }
    if (filters.id) return [events.get(filters.id)];
    return events.list({ from: filters.from, to: filters.to, keyword: filters.keyword });
  }

  return {
    async create(draft, options) {
      const fields = { ...(draft.fields ?? {}), source: draft.fields?.source ?? 'command' };
      if (options.dryRun) {
        // 预览必须跑**真实的字段校验**（只是不写库）：否则"缺 startTime"这类错误要等用户
        // 点了确认才冒出来，确认卡就成了摆设 —— 走 AI 的草稿尤其依赖这一步兜住模型的编造字段。
        // `planned` 是原样回显（模型到底给了什么），`validated` 是校验/归一化后的最终字段。
        const validated = targetService(draft.target)?.preview(fields) ?? null;
        return { dryRun: true, planned: { action: 'create', target: draft.target, fields }, validated };
      }
      if (draft.target === 'todo') {
        const item = await todos.create(fields);
        return { item, affected: [{ id: item.id, title: item.title, date: item.deadline }] };
      }
      if (draft.target === 'schedule') {
        const item = await schedules.create(fields);
        const conflicts = schedules.conflictsFor(item);
        return { item, conflicts, affected: [{ id: item.id, title: item.title, date: item.date }] };
      }
      const item = await events.create(fields);
      return { item, affected: [{ id: item.id, title: item.title, date: item.startDate }] };
    },

    query(draft) {
      const filters = draft.filters ?? {};
      if (draft.target === 'todo') {
        const items = todos.list({
          from: filters.from,
          to: filters.to,
          completed: filters.completed,
          priority: filters.priority,
          overdue: filters.overdue,
          keyword: filters.keyword,
        });
        return {
          filters,
          items,
          count: items.length,
          stats: todos.stats(items),
          explain: draft.explain ?? `共 ${items.length} 条待办`,
        };
      }
      if (draft.target === 'schedule') {
        const items = schedules.list({
          from: filters.from,
          to: filters.to,
          category: filters.category,
          keyword: filters.keyword,
        });
        return {
          filters,
          items,
          count: items.length,
          explain: draft.explain ?? `共 ${items.length} 条日程`,
        };
      }
      const items = events.list({ from: filters.from, to: filters.to, keyword: filters.keyword });
      return {
        filters,
        items,
        count: items.length,
        explain: draft.explain ?? `共 ${items.length} 个日历事件`,
      };
    },

    async update(draft, options) {
      const matches = locate(draft);
      if (!matches.length) throw HttpError.notFound(`没有找到符合条件的${labelOf(draft.target)}`);
      const fields = draft.fields ?? {};
      if (options.dryRun) {
        return { dryRun: true, planned: { action: 'update', target: draft.target, ids: matches.map((m) => m.id), fields } };
      }
      const updated = [];
      for (const match of matches) {
        if (draft.target === 'todo') updated.push(await todos.update(match.id, fields));
        else if (draft.target === 'schedule') updated.push(await schedules.update(match.id, fields));
        else updated.push(await events.update(match.id, fields));
      }
      return {
        items: updated,
        affected: updated.map((item) => ({ id: item.id, title: item.title })),
        ambiguous: matches.length > 1,
        explain: `已修改 ${updated.length} 条${labelOf(draft.target)}`,
      };
    },

    async delete(draft, options) {
      const matches = locate(draft);
      if (!matches.length) throw HttpError.notFound(`没有找到符合条件的${labelOf(draft.target)}`);
      if (options.dryRun) {
        return { dryRun: true, planned: { action: 'delete', target: draft.target, ids: matches.map((item) => item.id) } };
      }
      const ids = matches.map((item) => item.id);
      if (draft.target === 'todo') await store.todos.removeMany(ids);
      else if (draft.target === 'schedule') await store.schedules.removeMany(ids);
      else await store.events.removeMany(ids);
      return {
        affected: matches.map((item) => ({ id: item.id, title: item.title })),
        deleted: ids.length,
        ambiguous: matches.length > 1,
        explain: `已删除 ${ids.length} 条${labelOf(draft.target)}`,
      };
    },

    /**
     * 标记完成：**只有待办有完成态**。
     * 对日程 / 日历事件执行「完成」是语义错误，必须明确报错而不是静默改错东西。
     */
    async complete(draft, options) {
      if (draft.target !== 'todo') {
        const label = labelOf(draft.target);
        throw HttpError.badRequest(
          `${label}没有完成态，完成只属于待办：请说「完成 <待办名>」，或先把这条${label}改建成待办`,
          { field: 'target' },
        );
      }
      const matches = locate(draft);
      if (!matches.length) {
        // 用户/AI 说的「完成 X」如果其实是一条日程或日历事件，必须明确回答「没有完成态」，
        // 而不是 404 —— 404 会被理解成「没有这条记录」，接着可能被当成新建。
        const filters = draft.filters ?? {};
        const probe = { from: filters.from, to: filters.to, keyword: filters.keyword };
        const scheduleHit = schedules.list(probe)[0];
        const eventHit = schedules.list(probe).length ? undefined : events.list(probe)[0];
        const hit = scheduleHit ?? eventHit;
        if (hit) {
          const what = scheduleHit ? '日程' : '日历事件';
          const span = scheduleHit ? `（${hit.startTime ?? ''}${hit.endTime ? `-${hit.endTime}` : ''}）` : '';
          throw HttpError.badRequest(
            `「${hit.title}」是${what}${span}，${what}没有完成态：完成只属于待办，请说「完成 <待办名>」`,
            { field: 'target' },
          );
        }
        throw HttpError.notFound('没有找到符合条件的待办');
      }
      if (options.dryRun) {
        return { dryRun: true, planned: { action: 'complete', target: 'todo', ids: matches.map((m) => m.id) } };
      }
      const updated = [];
      for (const match of matches) updated.push(await todos.setCompleted(match.id, true));
      return {
        items: updated,
        affected: updated.map((item) => ({ id: item.id, title: item.title, date: item.deadline })),
        ambiguous: matches.length > 1,
        explain: `已完成 ${updated.length} 条待办`,
      };
    },

    /** 顺延未完成待办到目标周（周一）。同样只对待办成立。 */
    async rollover(draft, options) {
      if (draft.target !== 'todo') {
        throw HttpError.badRequest('顺延只适用于待办：日程与日历事件都是固定日期的安排', { field: 'target' });
      }
      const weekStart = draft.fields?.weekStart ?? draft.filters?.weekStart;
      if (options.dryRun) return { dryRun: true, planned: { action: 'rollover', target: 'todo', weekStart } };
      const result = await todos.rollover({ weekStart });
      return {
        ...result,
        affected: result.items.map((item) => ({ id: item.id, title: item.title, date: item.to, from: item.from })),
        explain: result.moved ? `已顺延 ${result.moved} 条待办到 ${result.weekStart} 那一周` : '没有需要顺延的待办',
      };
    },
  };
}
