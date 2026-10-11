/**
 * 日历模块的对话指令处理器。
 *
 * 由 module.js 注册给 target `event` 与 `schedule`（两个 target 共用同一份实现：
 * 走哪条分支由 `draft.target` 决定，与原 CommandService 里的 switch 行为一致）。
 *
 * 处理器契约见 core/commands/command-service.js：
 *   键 = action 名，值 = (draft, options) => object；`options.dryRun` 时只预览不写库。
 */

import { HttpError } from '../../core/http/router.js';

function summarize(statuses) {
  const counts = {};
  for (const status of statuses) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

const describeTarget = (target) => (target === 'schedule' ? '日程' : '日历事件');

/**
 * @param {object} deps
 * @param {object} deps.events     EventService
 * @param {object} deps.schedules  ScheduleService
 * @param {object} deps.store      JsonStore（删除批量记录时直接操作集合）
 */
export function createCalendarCommands({ events, schedules, store }) {
  /** 按 filters 定位待操作记录；id 优先。 */
  function locate(draft) {
    const filters = draft.filters ?? {};
    if (draft.target === 'schedule') {
      if (filters.id) return [schedules.get(filters.id)];
      return schedules.list({
        from: filters.from,
        to: filters.to,
        // 只有「完成」才默认限定未完成项；删除/修改应能命中任意状态
        status: filters.status ?? (draft.action === 'complete' ? 'pending' : undefined),
        keyword: filters.keyword,
        includeRolled: false,
      });
    }
    if (filters.id) return [events.get(filters.id)];
    return events.list({ from: filters.from, to: filters.to, keyword: filters.keyword });
  }

  return {
    async create(draft, options) {
      const fields = { ...(draft.fields ?? {}), source: draft.fields?.source ?? 'command' };
      if (options.dryRun) return { dryRun: true, planned: { action: 'create', target: draft.target, fields } };
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
      if (draft.target === 'schedule') {
        const items = schedules.list({
          from: filters.from,
          to: filters.to,
          status: filters.status,
          keyword: filters.keyword,
          includeRolled: false,
        });
        return {
          filters,
          items,
          count: items.length,
          summary: summarize(items.map((item) => item.status)),
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
      if (!matches.length) throw HttpError.notFound('没有找到符合条件的记录');
      const fields = draft.fields ?? {};
      if (options.dryRun) {
        return { dryRun: true, planned: { action: 'update', target: draft.target, ids: matches.map((m) => m.id), fields } };
      }
      const updated = [];
      for (const match of matches) {
        if (draft.target === 'schedule') updated.push(await schedules.update(match.id, fields));
        else updated.push(await events.update(match.id, fields));
      }
      return {
        items: updated,
        affected: updated.map((item) => ({ id: item.id, title: item.title })),
        ambiguous: matches.length > 1,
        explain: `已修改 ${updated.length} 条${describeTarget(draft.target)}`,
      };
    },

    async delete(draft, options) {
      const matches = locate(draft);
      if (!matches.length) throw HttpError.notFound('没有找到符合条件的记录');
      if (options.dryRun) {
        return { dryRun: true, planned: { action: 'delete', target: draft.target, ids: matches.map((item) => item.id) } };
      }
      const ids = matches.map((item) => item.id);
      if (draft.target === 'schedule') await store.schedules.removeMany(ids);
      else await store.events.removeMany(ids);
      return {
        affected: matches.map((item) => ({ id: item.id, title: item.title })),
        deleted: ids.length,
        ambiguous: matches.length > 1,
        explain: `已删除 ${ids.length} 条${describeTarget(draft.target)}`,
      };
    },

    async complete(draft, options) {
      if (draft.target === 'event') throw HttpError.badRequest('日历事件不支持「完成」操作，请对日程使用');
      const matches = locate(draft);
      if (!matches.length) throw HttpError.notFound('没有找到符合条件的日程');
      if (options.dryRun) {
        return { dryRun: true, planned: { action: 'complete', ids: matches.map((m) => m.id) } };
      }
      const updated = [];
      for (const match of matches) updated.push(await schedules.setStatus(match.id, 'done'));
      return {
        items: updated,
        affected: updated.map((item) => ({ id: item.id, title: item.title })),
        explain: `已完成 ${updated.length} 条日程`,
      };
    },

    /** 顺延未完成日程到指定周（周一）。 */
    async rollover(draft, options) {
      const weekStart = draft.fields?.weekStart ?? draft.filters?.weekStart;
      if (options.dryRun) return { dryRun: true, planned: { action: 'rollover', weekStart } };
      const result = await schedules.rollover({ weekStart });
      return { ...result, affected: result.items.map((item) => ({ id: item.to, title: item.title, date: item.toDate })) };
    },
  };
}
