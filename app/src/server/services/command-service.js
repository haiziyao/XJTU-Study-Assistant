/**
 * 指令服务：把「指令对象」落到具体业务服务上，并记录指令日志。
 *
 * 指令对象既可以来自本地规则解析器（CommandParser），也可以来自未来的 AI provider，
 * 两者结构一致，因此这里不需要关心来源。
 */

import { HttpError } from '../../core/http/router.js';
import { describeRepeat } from './recurrence.js';
import { parseMarkup } from '../parser/markup-parser.js';

export class CommandService {
  constructor({ parser, eventService, scheduleService, store, aiBridge }) {
    this.parser = parser;
    this.eventService = eventService;
    this.scheduleService = scheduleService;
    this.store = store;
    this.aiBridge = aiBridge;
  }

  /** 仅解析，不写库。 */
  parse(text, options = {}) {
    const draft = this.parser.parse(text, options);
    if (!draft.ok) throw new HttpError(422, 'PARSE_FAILED', draft.warnings?.[0] ?? '无法解析该指令', draft);
    return draft;
  }

  /** 解析并执行。 */
  async run(text, options = {}) {
    const draft = this.parse(text, options);
    const result = await this.execute(draft, options);
    return { draft, ...result };
  }

  /**
   * 解析 dschat 2 风格的中文标记行并逐条执行（伪工具调用入口）。
   * 单条失败不影响其它条目，结果按行返回，便于前端逐条反馈。
   */
  async runMarkup(text, options = {}) {
    const { drafts, unparsed } = parseMarkup(text);
    const results = [];
    for (const draft of drafts) {
      if (!draft.ok) {
        results.push({ draft, ok: false, error: { code: 'PARSE_FAILED', message: draft.warnings?.[0] ?? '标记行不完整' } });
        continue;
      }
      try {
        results.push({ draft, ...(await this.execute(draft, options)) });
      } catch (error) {
        results.push({ draft, ok: false, error: { code: error.code ?? 'INTERNAL', message: error.message } });
      }
    }
    return {
      drafts,
      results,
      unparsed,
      succeeded: results.filter((item) => item.ok !== false).length,
      failed: results.filter((item) => item.ok === false).length,
    };
  }

  /**
   * 执行指令对象。
   * @param {object} draft 指令对象（来自解析器或 AI）
   * @param {object} [options]
   * @param {boolean} [options.dryRun] 只返回将执行的动作，不写库
   */
  async execute(draft, options = {}) {
    if (!draft?.ok) throw HttpError.badRequest('指令对象无效（ok !== true）');
    const { action, target } = draft;
    if (!['event', 'schedule'].includes(target)) throw HttpError.badRequest(`不支持的 target: ${target}`);

    let result;
    switch (action) {
      case 'create':
        result = await this.#create(draft, options);
        break;
      case 'query':
        result = this.#query(draft);
        break;
      case 'update':
        result = await this.#update(draft, options);
        break;
      case 'delete':
        result = await this.#delete(draft, options);
        break;
      case 'complete':
        result = await this.#complete(draft, options);
        break;
      case 'rollover':
        result = await this.#rollover(draft, options);
        break;
      default:
        throw HttpError.badRequest(`不支持的 action: ${action}`);
    }

    const payload = {
      ok: true,
      action,
      target,
      explain: draft.explain ?? null,
      confidence: draft.confidence ?? null,
      warnings: draft.warnings ?? [],
      ...result,
    };
    if (!options.dryRun) await this.#log(draft, payload);
    return payload;
  }

  async #create(draft, options) {
    const fields = { ...(draft.fields ?? {}), source: draft.fields?.source ?? 'command' };
    if (options.dryRun) return { dryRun: true, planned: { action: 'create', target: draft.target, fields } };
    if (draft.target === 'schedule') {
      const item = await this.scheduleService.create(fields);
      const conflicts = this.scheduleService.conflictsFor(item);
      return { item, conflicts, affected: [{ id: item.id, title: item.title, date: item.date }] };
    }
    const item = await this.eventService.create(fields);
    return { item, affected: [{ id: item.id, title: item.title, date: item.startDate }] };
  }

  #query(draft) {
    const filters = draft.filters ?? {};
    if (draft.target === 'schedule') {
      const items = this.scheduleService.list({
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
    const items = this.eventService.list({ from: filters.from, to: filters.to, keyword: filters.keyword });
    return {
      filters,
      items,
      count: items.length,
      explain: draft.explain ?? `共 ${items.length} 个日历事件`,
    };
  }

  /** 按 filters 定位待操作记录；id 优先。 */
  #locate(draft) {
    const filters = draft.filters ?? {};
    if (draft.target === 'schedule') {
      if (filters.id) return [this.scheduleService.get(filters.id)];
      return this.scheduleService.list({
        from: filters.from,
        to: filters.to,
        // 只有「完成」才默认限定未完成项；删除/修改应能命中任意状态
        status: filters.status ?? (draft.action === 'complete' ? 'pending' : undefined),
        keyword: filters.keyword,
        includeRolled: false,
      });
    }
    if (filters.id) return [this.eventService.get(filters.id)];
    return this.eventService.list({ from: filters.from, to: filters.to, keyword: filters.keyword });
  }

  async #update(draft, options) {
    const matches = this.#locate(draft);
    if (!matches.length) throw HttpError.notFound('没有找到符合条件的记录');
    const fields = draft.fields ?? {};
    if (options.dryRun) {
      return { dryRun: true, planned: { action: 'update', target: draft.target, ids: matches.map((m) => m.id), fields } };
    }
    const updated = [];
    for (const match of matches) {
      if (draft.target === 'schedule') updated.push(await this.scheduleService.update(match.id, fields));
      else updated.push(await this.eventService.update(match.id, fields));
    }
    return {
      items: updated,
      affected: updated.map((item) => ({ id: item.id, title: item.title })),
      ambiguous: matches.length > 1,
      explain: `已修改 ${updated.length} 条${describeTarget(draft.target)}`,
    };
  }

  async #delete(draft, options) {
    const matches = this.#locate(draft);
    if (!matches.length) throw HttpError.notFound('没有找到符合条件的记录');
    if (options.dryRun) {
      return { dryRun: true, planned: { action: 'delete', target: draft.target, ids: matches.map((m) => m.id) } };
    }
    const ids = matches.map((item) => item.id);
    if (draft.target === 'schedule') await this.store.schedules.removeMany(ids);
    else await this.store.events.removeMany(ids);
    return {
      affected: matches.map((item) => ({ id: item.id, title: item.title })),
      deleted: ids.length,
      ambiguous: matches.length > 1,
      explain: `已删除 ${ids.length} 条${describeTarget(draft.target)}`,
    };
  }

  async #complete(draft, options) {
    if (draft.target === 'event') throw HttpError.badRequest('日历事件不支持「完成」操作，请对日程使用');
    const matches = this.#locate(draft);
    if (!matches.length) throw HttpError.notFound('没有找到符合条件的日程');
    if (options.dryRun) {
      return { dryRun: true, planned: { action: 'complete', ids: matches.map((m) => m.id) } };
    }
    const updated = [];
    for (const match of matches) updated.push(await this.scheduleService.setStatus(match.id, 'done'));
    return {
      items: updated,
      affected: updated.map((item) => ({ id: item.id, title: item.title })),
      explain: `已完成 ${updated.length} 条日程`,
    };
  }

  async #rollover(draft, options) {
    const weekStart = draft.fields?.weekStart ?? draft.filters?.weekStart;
    if (options.dryRun) return { dryRun: true, planned: { action: 'rollover', weekStart } };
    const result = await this.scheduleService.rollover({ weekStart });
    return { ...result, affected: result.items.map((item) => ({ id: item.to, title: item.title, date: item.toDate })) };
  }

  async #log(draft, payload) {
    try {
      await this.store.commandLogs.insert({
        text: draft.raw ?? '',
        action: draft.action,
        target: draft.target,
        confidence: draft.confidence ?? null,
        ok: payload.ok !== false,
        affectedCount: payload.affected?.length ?? payload.count ?? 0,
        source: draft.provider ?? 'rules',
      });
    } catch (error) {
      console.error('[command] 写入指令日志失败:', error.message);
    }
  }
}

function summarize(statuses) {
  const counts = {};
  for (const status of statuses) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

function describeTarget(target) {
  return target === 'schedule' ? '日程' : '日历事件';
}

export { describeRepeat };
