/**
 * 日历模块的全部 REST 路由。
 *
 * 前缀约定 `/api/v1`，资源路径直接挂在根下（`/events`、`/schedules`、`/todos`、`/calendar`…）
 * 而不是 `/api/v1/calendar/events` —— 这是历史兼容选择：接口文档与前端都已按这个形状固化。
 * 新模块请使用 `/api/v1/<模块id>/...`（例如思源学堂的 `/api/v1/lms/...`）。
 *
 * 领域边界（对外契约，2026-10 重做）：
 * - `/todos`    待办：只有截止日 + 完成态。**不读 schedules 集合**，两边彻底解耦。
 * - `/schedules` 日程：必须是时段（`startTime` 必填）。`allDay` / `status` 一律 400。
 * - `/events`   日历事件：日期 / 日期区间，没有完成态。
 *
 * 历史兜底：早期版本把「待办」写成 schedules 里的日期锚点（`allDay: true`）。这类行
 * 启动时会被 module.js 迁移成待办；万一没迁成，`/calendar` 仍把它们放进 `imported`
 * 桶只读展示（不计入任何统计），保证数据不会「还在库里但界面看不见」。
 */

import { HttpError } from '../../core/http/router.js';
import { addDays } from '../../shared/time.js';
import { buildIcs } from './ics-service.js';
import { COMMAND_GRAMMAR } from './parser.js';
import { MARKUP_GRAMMAR, parseMarkup } from './markup-parser.js';
import { fromDschatEvent, normalizeAliases, toDschatEvent } from './compat.js';
import { isTodoInputField } from './todo-service.js';

const MAX_AGGREGATE_DAYS = 400;

/** 只留待办认得的键（给 dschat 兼容层用，理由见 compat PATCH 路由里的注释）。 */
function pickTodoFields(payload) {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => isTodoInputField(key)));
}

/** query 里的布尔：`1` / `true` / `yes` 都算真。 */
function isTruthy(value) {
  return value === true || value === '1' || value === 'true' || value === 'yes';
}

/**
 * 对外禁止的旧字段：日程没有「全天/待办」语义，也没有完成态。
 * 注意要先过一遍别名归一化：dschat 风格的 `start_time` / `all_day` 也必须按同一套规则拦住。
 */
function assertSchedulePayload(body, { requireStartTime }) {
  if (!body || typeof body !== 'object') return;
  const input = normalizeAliases(body);
  if (input.allDay !== undefined && isTruthy(input.allDay)) {
    throw HttpError.badRequest(
      '日程必须是时段（需要 startTime）；只有日期、没有时刻的条目请用待办 POST /todos',
      { field: 'allDay' },
    );
  }
  if (input.status !== undefined) {
    throw HttpError.badRequest(
      '日程没有完成态（status 已废弃）：「完成」只属于待办，请用 POST /todos/:id/completed',
      { field: 'status' },
    );
  }
  if (requireStartTime && (input.startTime === undefined || input.startTime === null || input.startTime === '')) {
    throw HttpError.badRequest('字段 startTime 必填：日程必须是时段；只有日期的条目请用待办 POST /todos', {
      field: 'startTime',
    });
  }
}

/**
 * @param {object} router core/http/router.js 的实例
 * @param {object} ctx
 * @param {object} ctx.services   全局服务表（需含 events / schedules / todos）
 * @param {string} [ctx.apiPrefix='/api/v1']
 */
export function registerCalendarRoutes(router, { services, apiPrefix = '/api/v1' }) {
  const P = apiPrefix;
  const { events, schedules, todos, categories } = services;

  // ---------------------------------------------------------------- 分类
  // 分类是**数据**（不是枚举常量）：用户能改名/改色/新增，`other` 是兜底且不可删。
  router.get(`${P}/categories`, ({ query }) => ({ items: categories.list({ kind: query.kind }) }));

  router.post(`${P}/categories`, async ({ body }) => {
    const item = await categories.create(body ?? {});
    return { __status: 201, item };
  });

  // 分类 id 在两个 kind 里可能同名（study/exam/other），所以 id 路由接受可选的 `?kind=`
  router.get(`${P}/categories/:id`, ({ params, query }) => ({ item: categories.get(params.id, query.kind) }));

  router.patch(`${P}/categories/:id`, async ({ params, query, body }) => ({
    item: await categories.update(params.id, body ?? {}, { kind: query.kind }),
  }));

  /** 删除不丢数据：在用记录改成同 kind 的 other，响应里给 reassigned 条数。 */
  router.delete(`${P}/categories/:id`, async ({ params, query }) => categories.remove(params.id, { kind: query.kind }));

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

  // ---------------------------------------------------------------- 待办
  // 待办是独立实体：只有截止日 + 完成态，和日程/事件没有任何共享字段。
  // 分类与父子分级是待办**自己的**维度（2026-10）：`category` 是自由文本，
  // `parentId` 指父待办（最多 3 层）。筛选参数见下。
  router.get(`${P}/todos`, ({ query }) => {
    const filters = {
      date: query.date,
      from: query.from,
      to: query.to,
      completed: query.completed,
      priority: query.priority,
      overdue: query.overdue,
      noDeadline: query.noDeadline,
      keyword: query.keyword,
      category: query.category,
      parentId: query.parentId,
      limit: query.limit,
    };
    /**
     * `tree=1`：返回树（顶层数组，每项带 `children`，最多 3 层）。
     * 口径：`count` 是**顶层条数**，`totalCount` 是含子项的记录总数；
     * stats 按**返回的全部记录**算（与 totalCount、与界面上能看到的行数一致）。
     */
    if (isTruthy(query.tree)) {
      const result = todos.tree(filters);
      return {
        items: result.items,
        count: result.count,
        totalCount: result.totalCount,
        stats: todos.stats(result.flat),
        tree: true,
      };
    }
    const items = todos.list(filters);
    // 统计以「过滤后的集合」为准（不受 limit 截断影响）；flat 模式下两个计数一致
    return { items, count: items.length, totalCount: items.length, stats: todos.stats(items) };
  });

  /** 分类清单：`[{ name, total, open }]`，按 total 降序；未分类的 `name` 是空串。 */
  router.get(`${P}/todos/categories`, () => ({ items: todos.categories() }));

  router.get(`${P}/todos/upcoming`, ({ query }) => ({ items: todos.upcoming({ limit: query.limit }) }));

  /** 顺延：未完成且截止日早于目标周一的待办，挪到目标周的同一星期几（已过则落到周一）。 */
  router.post(`${P}/todos/rollover`, async ({ body }) => todos.rollover(body ?? {}));

  router.post(`${P}/todos`, async ({ body }) => {
    const item = await todos.create(body ?? {});
    return { __status: 201, item };
  });

  router.get(`${P}/todos/:id`, ({ params }) => ({ item: todos.get(params.id) }));

  /**
   * 局部更新。响应里的 `cascaded` 是本次操作**连带影响**的待办 id：
   * `{ completed: [...], reverted: [...] }`（前端据此提示"已连带完成 N 个子任务"）。
   * 只有显式传了 completed 才可能非空，理由见 todo-service 的 update()。
   */
  router.patch(`${P}/todos/:id`, async ({ params, body }) => {
    const item = await todos.update(params.id, body ?? {});
    return { item, cascaded: item.cascaded ?? { completed: [], reverted: [] } };
  });

  /** 勾选 / 取消勾选：「完成」唯一入口（同样会级联，形状与 PATCH 一致）。 */
  router.post(`${P}/todos/:id/completed`, async ({ params, body }) => {
    if (body?.completed === undefined) throw HttpError.badRequest('completed 为必填（true 完成 / false 取消完成）');
    const item = await todos.setCompleted(params.id, body.completed);
    return { item, cascaded: item.cascaded ?? { completed: [], reverted: [] } };
  });

  router.delete(`${P}/todos/:id`, async ({ params }) => todos.remove(params.id));

  // ---------------------------------------------------------------- 日程（只读时段）
  router.get(`${P}/schedules`, ({ query }) => {
    const items = schedules.list({
      date: query.date,
      from: query.from,
      to: query.to,
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
      category: query.category,
      keyword: query.keyword,
    }),
  }));

  router.get(`${P}/schedules/agenda`, ({ query }) => schedules.agenda({ date: query.date }));

  router.get(`${P}/schedules/stats`, ({ query }) => schedules.stats({ from: query.from, to: query.to }));

  router.post(`${P}/schedules`, async ({ body }) => {
    assertSchedulePayload(body, { requireStartTime: true });
    const item = await schedules.create(body ?? {});
    return { __status: 201, item, conflicts: schedules.conflictsFor(item) };
  });

  router.get(`${P}/schedules/:id`, ({ params }) => ({ item: schedules.get(params.id) }));

  router.patch(`${P}/schedules/:id`, async ({ params, body }) => {
    assertSchedulePayload(body, { requireStartTime: false });
    const item = await schedules.update(params.id, body ?? {});
    return { item, conflicts: schedules.conflictsFor(item) };
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
    const bucket = (occurrences) => {
      const map = new Map();
      for (const occurrence of occurrences) {
        if (!map.has(occurrence.occurrenceDate)) map.set(occurrence.occurrenceDate, []);
        map.get(occurrence.occurrenceDate).push(occurrence);
      }
      return map;
    };
    const scheduleBuckets = bucket(schedules.range({ from, to }));
    // 兜底：早期版本写入的日期锚点行（allDay: true）既不是日程也不是待办。
    // 正常启动时 module.js 已把它们迁成待办，这里再捞一遍，保证任何旧数据目录都不会「数据还在但看不见」。
    const importedBuckets = new Map();
    for (const item of services.store.schedules.all()) {
      if (item.allDay !== true || item.date < from || item.date > to) continue;
      const list = importedBuckets.get(item.date) ?? [];
      list.push({
        id: `${item.id}:${item.date}`,
        scheduleId: item.id,
        occurrenceDate: item.date,
        title: item.title,
        category: item.category,
        startTime: item.startTime ?? null,
        endTime: item.endTime ?? null,
        location: item.location,
        externalId: item.externalId,
        allDay: true,
        isRepeatInstance: false,
        legacy: true,
      });
      importedBuckets.set(item.date, list);
    }
    const todoBuckets = todos.groupByDeadline({ from, to });

    const result = [];
    for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) {
      const dayEvents = eventBuckets.get(cursor) ?? [];
      const daySchedules = scheduleBuckets.get(cursor) ?? [];
      const dayImported = importedBuckets.get(cursor) ?? [];
      const dayTodos = todoBuckets.get(cursor) ?? [];
      result.push({
        date: cursor,
        events: dayEvents,
        schedules: daySchedules,
        todos: dayTodos,
        imported: dayImported,
        stats: {
          events: dayEvents.length,
          schedules: daySchedules.length,
          todos: dayTodos.length,
          todosCompleted: dayTodos.filter((item) => item.completed).length,
          imported: dayImported.length,
        },
      });
    }
    return {
      from,
      to,
      view: query.view ?? 'month',
      days: result,
      stats: {
        schedules: schedules.stats({ from, to }),
        todos: todos.stats(todos.list({ from, to })),
      },
    };
  });

  // ---------------------------------------------------------------- 指令语法与 dschat 标记行
  /** 指令语法速查（描述的是本模块的解析规则，因此属于本模块）。 */
  router.get(`${P}/commands/grammar`, () => ({ ...COMMAND_GRAMMAR, dschatMarkup: MARKUP_GRAMMAR }));

  /** dschat 2 兼容：解析中文标记行（`[新增待办] 标题 | 日期 | …`）并逐条执行。 */
  router.post(`${P}/commands/markup`, async ({ body }) => {
    if (!body?.text) throw HttpError.badRequest('text 为必填');
    return services.commands.runBatch(body.text, parseMarkup, { dryRun: Boolean(body.dryRun) });
  });

  // ---------------------------------------------------------------- 导出（ICS）
  router.get(`${P}/ics`, ({ query, req }) => {
    const eventItems = events.list({ from: query.from, to: query.to });
    // 只导出时段日程：服务层已经排除没有时刻的历史行，导成 ICS 也没有意义
    const scheduleItems = schedules.list({ from: query.from, to: query.to });
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
  router.get(`${P}/compat/dschat/events`, ({ query }) => {
    // dschat 2 眼里「单日锚点」既可能是时段日程也可能是待办，读的时候两边都带上
    const items = [
      ...schedules.list({ from: query.start, to: query.end }).map(toDschatEvent),
      ...todos.list({ from: query.start, to: query.end }).map(toDschatEvent),
    ].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return { events: items };
  });

  router.post(`${P}/compat/dschat/events`, async ({ body }) => {
    const { target, fields } = fromDschatEvent(body ?? {});
    const item =
      target === 'event' ? await events.create(fields) : target === 'todo' ? await todos.create(fields) : await schedules.create(fields);
    return { __status: 201, id: item.id, target, item };
  });

  /** dschat 2 的按标题批量删除（精确匹配）。 */
  router.post(`${P}/compat/dschat/events/delete`, async ({ body }) => {
    if (!body?.title) throw HttpError.badRequest('title 为必填');
    const scheduleMatches = schedules.list({ keyword: body.title }).filter((item) => item.title === body.title);
    const todoMatches = todos.list({ keyword: body.title }).filter((item) => item.title === body.title);
    await services.store.schedules.removeMany(scheduleMatches.map((item) => item.id));
    // 待办走服务层批量删除：直接 removeMany 集合会把子任务留成悬空 parentId
    const todoResult = await todos.removeMany(todoMatches.map((item) => item.id));
    return { deleted: scheduleMatches.length + todoResult.deleted };
  });

  router.patch(`${P}/compat/dschat/events/:id`, async ({ params, body }) => {
    const payload = { ...(body ?? {}) };
    delete payload.id;
    // 待办侧的未知字段是**硬错误**（见 todo-service 的 assertKnownFields）：写错名字 = 用户的话被丢掉。
    // 但 dschat 的事件形状天生带 `start_time` / `all_day` / `repeat*` 这些"待办没有"的装饰字段
    // （`toDschatEvent` 就是把它们吐出去的，客户端读-改-写会把它们送回来），
    // 所以在**适配层**按目标过滤：这不是把错误藏起来，而是把外来形状翻译成本地形状，
    // 域内接口（/todos、指令、AI 草稿）依然严格报错，一个字都不放过。
    const schedule = services.store.schedules.get(params.id);
    const fields = schedule ? payload : pickTodoFields(payload);
    const item = schedule ? await schedules.update(params.id, fields) : await todos.update(params.id, fields);
    return { item: toDschatEvent(item) };
  });

  router.delete(`${P}/compat/dschat/events/:id`, ({ params }) =>
    services.store.schedules.get(params.id) ? schedules.remove(params.id) : todos.remove(params.id));
}
