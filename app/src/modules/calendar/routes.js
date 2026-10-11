/**
 * 日历模块的全部 REST 路由。
 *
 * 前缀约定 `/api/v1`，资源路径直接挂在根下（`/events`、`/schedules`、`/calendar`…）
 * 而不是 `/api/v1/calendar/events` —— 这是历史兼容选择：接口文档与前端都已按这个形状固化。
 * 新模块请使用 `/api/v1/<模块id>/...`（例如思源学堂的 `/api/v1/lms/...`）。
 */

import { HttpError } from '../../core/http/router.js';
import { addDays } from '../../shared/time.js';
import { buildIcs } from './ics-service.js';
import { COMMAND_GRAMMAR } from './parser.js';
import { MARKUP_GRAMMAR, parseMarkup } from './markup-parser.js';
import { fromDschatEvent, toDschatEvent } from './compat.js';

const MAX_AGGREGATE_DAYS = 400;

/**
 * @param {object} router core/http/router.js 的实例
 * @param {object} ctx
 * @param {object} ctx.services   全局服务表（需含 events / schedules）
 * @param {string} [ctx.apiPrefix='/api/v1']
 */
export function registerCalendarRoutes(router, { services, apiPrefix = '/api/v1' }) {
  const P = apiPrefix;
  const { events, schedules } = services;

  // ---------------------------------------------------------------- 日历事件
  router.get(`${P}/events`, ({ query }) => ({
    items: events.list({
      from: query.from,
      to: query.to,
      category: query.category,
      keyword: query.keyword,
      limit: query.limit,
    }),
  }));

  router.get(`${P}/events/range`, ({ query }) => ({
    from: query.from,
    to: query.to,
    items: events.range({
      from: query.from,
      to: query.to,
      category: query.category,
      keyword: query.keyword,
      limit: query.limit,
    }),
  }));

  router.post(`${P}/events`, async ({ body }) => {
    const item = await events.create(body ?? {});
    return { __status: 201, item };
  });

  router.get(`${P}/events/:id`, ({ params }) => ({ item: events.get(params.id) }));

  router.patch(`${P}/events/:id`, async ({ params, body }) => ({
    item: await events.update(params.id, body ?? {}),
  }));

  router.delete(`${P}/events/:id`, async ({ params }) => events.remove(params.id));

  // ---------------------------------------------------------------- 日程
  router.get(`${P}/schedules`, ({ query }) => {
    const items = schedules.list({
      date: query.date,
      from: query.from,
      to: query.to,
      status: query.status,
      category: query.category,
      priority: query.priority,
      keyword: query.keyword,
      limit: query.limit,
    });
    return { items, stats: schedules.stats({ from: query.from, to: query.to }) };
  });

  router.get(`${P}/schedules/range`, ({ query }) => ({
    from: query.from,
    to: query.to,
    items: schedules.range({
      from: query.from,
      to: query.to,
      status: query.status,
      category: query.category,
      keyword: query.keyword,
    }),
  }));

  router.get(`${P}/schedules/agenda`, ({ query }) => schedules.agenda({ date: query.date }));

  router.get(`${P}/schedules/stats`, ({ query }) => schedules.stats({ from: query.from, to: query.to }));

  router.post(`${P}/schedules/rollover`, async ({ body }) => {
    const result = await schedules.rollover(body ?? {});
    return { __status: 201, ...result };
  });

  router.post(`${P}/schedules`, async ({ body }) => {
    const item = await schedules.create(body ?? {});
    return { __status: 201, item, conflicts: schedules.conflictsFor(item) };
  });

  router.get(`${P}/schedules/:id`, ({ params }) => ({ item: schedules.get(params.id) }));

  router.patch(`${P}/schedules/:id`, async ({ params, body }) => {
    const item = await schedules.update(params.id, body ?? {});
    return { item, conflicts: schedules.conflictsFor(item) };
  });

  router.post(`${P}/schedules/:id/status`, async ({ params, body }) => {
    if (!body?.status) throw HttpError.badRequest('status 为必填');
    return { item: await schedules.setStatus(params.id, body.status) };
  });

  router.delete(`${P}/schedules/:id`, async ({ params }) => schedules.remove(params.id));

  // ---------------------------------------------------------------- 聚合视图
  router.get(`${P}/calendar`, ({ query }) => {
    const from = query.from;
    const to = query.to;
    if (!from || !to) throw HttpError.badRequest('from 与 to 为必填（YYYY-MM-DD）');
    if (to < from) throw HttpError.badRequest('to 不能早于 from');
    const days = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
    if (days > MAX_AGGREGATE_DAYS) {
      throw HttpError.badRequest(`查询区间过大（${days} 天），上限 ${MAX_AGGREGATE_DAYS} 天`);
    }
    const eventBuckets = events.groupByDate({ from, to });
    const scheduleOccurrences = schedules.range({ from, to });
    const scheduleBuckets = new Map();
    for (const occurrence of scheduleOccurrences) {
      if (!scheduleBuckets.has(occurrence.occurrenceDate)) scheduleBuckets.set(occurrence.occurrenceDate, []);
      scheduleBuckets.get(occurrence.occurrenceDate).push(occurrence);
    }
    const result = [];
    for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) {
      const dayEvents = eventBuckets.get(cursor) ?? [];
      const daySchedules = scheduleBuckets.get(cursor) ?? [];
      result.push({
        date: cursor,
        events: dayEvents,
        schedules: daySchedules,
        stats: {
          events: dayEvents.length,
          schedules: daySchedules.length,
          done: daySchedules.filter((item) => item.status === 'done').length,
        },
      });
    }
    return {
      from,
      to,
      view: query.view ?? 'month',
      days: result,
      stats: schedules.stats({ from, to }),
    };
  });

  // ---------------------------------------------------------------- 指令语法与 dschat 标记行
  /** 指令语法速查（描述的是本模块的解析规则，因此属于本模块）。 */
  router.get(`${P}/commands/grammar`, () => ({ ...COMMAND_GRAMMAR, dschatMarkup: MARKUP_GRAMMAR }));

  /** dschat 2 兼容：解析中文标记行（`[新增日程] 标题 | 日期 | …`）并逐条执行。 */
  router.post(`${P}/commands/markup`, async ({ body }) => {
    if (!body?.text) throw HttpError.badRequest('text 为必填');
    return services.commands.runBatch(body.text, parseMarkup, { dryRun: Boolean(body.dryRun) });
  });

  // ---------------------------------------------------------------- 导出（ICS）
  router.get(`${P}/ics`, ({ query, req }) => {
    const eventItems = events.list({ from: query.from, to: query.to });
    const scheduleItems = schedules.list({ from: query.from, to: query.to, includeRolled: false });
    const host = req.headers.host ?? '127.0.0.1';
    return {
      __raw: {
        contentType: 'text/calendar; charset=utf-8',
        headers: { 'Content-Disposition': `inline; filename="potato-calendar-${host}.ics"` },
        body: buildIcs({ events: eventItems, schedules: scheduleItems, calendarName: query.name ?? 'Potato Calendar' }),
      },
    };
  });

  // ---------------------------------------------------------------- dschat 2 兼容接口
  router.get(`${P}/compat/dschat/events`, ({ query }) => ({
    events: schedules.list({ from: query.start, to: query.end, includeRolled: false }).map(toDschatEvent),
  }));

  router.post(`${P}/compat/dschat/events`, async ({ body }) => {
    const { target, fields } = fromDschatEvent(body ?? {});
    const item = target === 'event' ? await events.create(fields) : await schedules.create(fields);
    return { __status: 201, id: item.id, target, item };
  });

  /** dschat 2 的按标题批量删除（精确匹配）。 */
  router.post(`${P}/compat/dschat/events/delete`, async ({ body }) => {
    if (!body?.title) throw HttpError.badRequest('title 为必填');
    const matches = schedules
      .list({ keyword: body.title, includeRolled: false })
      .filter((item) => item.title === body.title);
    await services.store.schedules.removeMany(matches.map((item) => item.id));
    return { deleted: matches.length };
  });

  router.patch(`${P}/compat/dschat/events/:id`, async ({ params, body }) => {
    const payload = { ...(body ?? {}) };
    delete payload.id;
    const item = await schedules.update(params.id, payload);
    return { item: toDschatEvent(item) };
  });

  router.delete(`${P}/compat/dschat/events/:id`, ({ params }) => schedules.remove(params.id));
}
