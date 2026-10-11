/**
 * 所有 REST 路由的注册处。
 *
 * 路由表同时被 `GET /api/v1` 自描述接口引用，便于前端与主程序探测能力。
 */

import { AI_CONTRACT_VERSION } from '../ai/ai-bridge.js';
import { HttpError } from '../http/router.js';
import { COMMAND_GRAMMAR } from '../parser/command-parser.js';
import { MARKUP_GRAMMAR } from '../parser/markup-parser.js';
import { buildIcs } from '../services/ics-service.js';
import { fromDschatEvent, toDschatEvent } from '../services/compat.js';
import { LMS_TOOL_SPECS } from '../lms/tools.js';
import { registerLmsRoutes } from './lms.js';
import { API_PREFIX, WS_PATH } from '../../shared/constants.js';
import { THEME } from '../../shared/theme.js';
import { addDays } from '../../shared/time.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_AGGREGATE_DAYS = 400;

/** 测试页面（渲染层）静态文件映射：只暴露白名单内的文件，避免任意路径读取。 */
const RENDERER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'renderer');
const RENDERER_FILES = {
  // `/app` 与 `/app/` 由下方专门的路由处理（裸路径需要 302 到带斜杠的目录路径）
  '/app/index.html': 'index.html',
  '/app/app.js': 'app.js',
  '/app/views.js': 'views.js',
  '/app/styles.css': 'styles.css',
};
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export function registerRoutes(router, context) {
  const { services, aiBridge, hub, version = '0.1.0' } = context;

  // ---------------------------------------------------------------- 元信息
  router.get(API_PREFIX, () => ({
    name: 'potato-calendar',
    version,
    description: 'AI 智学程序 · 日历与日程模块后端',
    endpoints: router.list().filter((line) => line.includes(API_PREFIX)),
    websocket: '/ws',
  }));

  router.get(`${API_PREFIX}/health`, () => ({
    status: 'ok',
    time: new Date().toISOString(),
    counts: {
      events: services.store.events.all().length,
      schedules: services.store.schedules.all().length,
      commandLogs: services.store.commandLogs.all().length,
    },
    // clients > 0 说明有前端（测试窗口 / 浏览器页面）已连上推送通道
    websocket: { path: WS_PATH, clients: hub?.size ?? 0 },
    ai: { available: aiBridge.available, provider: aiBridge.provider?.name ?? null },
  }));

  router.get(`${API_PREFIX}/meta/theme`, () => ({ theme: THEME }));

  router.get(`${API_PREFIX}/meta/lunar`, ({ query }) => {
    if (!query.date) throw HttpError.badRequest('date 为必填（YYYY-MM-DD）');
    // 契约先定，实现待接：PotatoCalendar 的农历实现经校验有 99.7% 偏差，不可移植。
    throw new HttpError(501, 'NOT_IMPLEMENTED', '农历能力尚未实现', {
      contract: {
        endpoint: `GET ${API_PREFIX}/meta/lunar?date=YYYY-MM-DD`,
        expectedResponse: {
          date: '2025-01-29',
          lunar: { year: '乙巳', zodiac: '蛇', month: '正月', day: '初一', isLeapMonth: false },
          festivals: ['春节'],
        },
        note: '建议接入成熟农历库（如 lunar-javascript），不要沿用旧的查表实现。',
      },
      date: query.date,
    });
  });

  // ---------------------------------------------------------------- 日历事件
  router.get(`${API_PREFIX}/events`, ({ query }) => ({
    items: services.events.list({
      from: query.from,
      to: query.to,
      category: query.category,
      keyword: query.keyword,
      limit: query.limit,
    }),
  }));

  router.get(`${API_PREFIX}/events/range`, ({ query }) => ({
    from: query.from,
    to: query.to,
    items: services.events.range({
      from: query.from,
      to: query.to,
      category: query.category,
      keyword: query.keyword,
      limit: query.limit,
    }),
  }));

  router.post(`${API_PREFIX}/events`, async ({ body }) => {
    const item = await services.events.create(body ?? {});
    return { __status: 201, item };
  });

  router.get(`${API_PREFIX}/events/:id`, ({ params }) => ({ item: services.events.get(params.id) }));

  router.patch(`${API_PREFIX}/events/:id`, async ({ params, body }) => ({
    item: await services.events.update(params.id, body ?? {}),
  }));

  router.delete(`${API_PREFIX}/events/:id`, async ({ params }) => services.events.remove(params.id));

  // ---------------------------------------------------------------- 日程
  router.get(`${API_PREFIX}/schedules`, ({ query }) => {
    const items = services.schedules.list({
      date: query.date,
      from: query.from,
      to: query.to,
      status: query.status,
      category: query.category,
      priority: query.priority,
      keyword: query.keyword,
      limit: query.limit,
    });
    return { items, stats: services.schedules.stats({ from: query.from, to: query.to }) };
  });

  router.get(`${API_PREFIX}/schedules/range`, ({ query }) => ({
    from: query.from,
    to: query.to,
    items: services.schedules.range({
      from: query.from,
      to: query.to,
      status: query.status,
      category: query.category,
      keyword: query.keyword,
    }),
  }));

  router.get(`${API_PREFIX}/schedules/agenda`, ({ query }) => services.schedules.agenda({ date: query.date }));

  router.get(`${API_PREFIX}/schedules/stats`, ({ query }) => services.schedules.stats({ from: query.from, to: query.to }));

  router.post(`${API_PREFIX}/schedules/rollover`, async ({ body }) => {
    const result = await services.schedules.rollover(body ?? {});
    return { __status: 201, ...result };
  });

  router.post(`${API_PREFIX}/schedules`, async ({ body }) => {
    const item = await services.schedules.create(body ?? {});
    return { __status: 201, item, conflicts: services.schedules.conflictsFor(item) };
  });

  router.get(`${API_PREFIX}/schedules/:id`, ({ params }) => ({ item: services.schedules.get(params.id) }));

  router.patch(`${API_PREFIX}/schedules/:id`, async ({ params, body }) => {
    const item = await services.schedules.update(params.id, body ?? {});
    return { item, conflicts: services.schedules.conflictsFor(item) };
  });

  router.post(`${API_PREFIX}/schedules/:id/status`, async ({ params, body }) => {
    if (!body?.status) throw HttpError.badRequest('status 为必填');
    return { item: await services.schedules.setStatus(params.id, body.status) };
  });

  router.delete(`${API_PREFIX}/schedules/:id`, async ({ params }) => services.schedules.remove(params.id));

  // ---------------------------------------------------------------- 聚合视图
  router.get(`${API_PREFIX}/calendar`, ({ query }) => {
    const from = query.from;
    const to = query.to;
    if (!from || !to) throw HttpError.badRequest('from 与 to 为必填（YYYY-MM-DD）');
    if (to < from) throw HttpError.badRequest('to 不能早于 from');
    const days = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
    if (days > MAX_AGGREGATE_DAYS) {
      throw HttpError.badRequest(`查询区间过大（${days} 天），上限 ${MAX_AGGREGATE_DAYS} 天`);
    }
    const eventBuckets = services.events.groupByDate({ from, to });
    const scheduleOccurrences = services.schedules.range({ from, to });
    const scheduleBuckets = new Map();
    for (const occurrence of scheduleOccurrences) {
      if (!scheduleBuckets.has(occurrence.occurrenceDate)) scheduleBuckets.set(occurrence.occurrenceDate, []);
      scheduleBuckets.get(occurrence.occurrenceDate).push(occurrence);
    }
    const result = [];
    for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) {
      const events = eventBuckets.get(cursor) ?? [];
      const schedules = scheduleBuckets.get(cursor) ?? [];
      result.push({
        date: cursor,
        events,
        schedules,
        stats: {
          events: events.length,
          schedules: schedules.length,
          done: schedules.filter((item) => item.status === 'done').length,
        },
      });
    }
    return {
      from,
      to,
      view: query.view ?? 'month',
      days: result,
      stats: services.schedules.stats({ from, to }),
    };
  });

  // ---------------------------------------------------------------- 指令
  router.get(`${API_PREFIX}/commands/grammar`, () => ({ ...COMMAND_GRAMMAR, dschatMarkup: MARKUP_GRAMMAR }));

  router.get(`${API_PREFIX}/commands/logs`, ({ query }) => ({
    items: services.store.commandLogs
      .all()
      .slice(-Number(query.limit ?? 50))
      .reverse(),
  }));

  router.post(`${API_PREFIX}/commands/parse`, ({ body }) => {
    if (!body?.text) throw HttpError.badRequest('text 为必填');
    return { draft: services.commands.parse(body.text) };
  });

  router.post(`${API_PREFIX}/commands/execute`, async ({ body }) => {
    if (!body?.text && !body?.draft) throw HttpError.badRequest('text 或 draft 至少提供一个');
    const draft = body.draft ?? services.commands.parse(body.text);
    return services.commands.execute(draft, { dryRun: Boolean(body.dryRun) });
  });

  router.post(`${API_PREFIX}/commands/run`, async ({ body }) => {
    if (!body?.text) throw HttpError.badRequest('text 为必填');
    return services.commands.run(body.text, { dryRun: Boolean(body.dryRun) });
  });

  /** dschat 2 兼容：解析中文标记行（`[新增日程] 标题 | 日期 | …`）并逐条执行。 */
  router.post(`${API_PREFIX}/commands/markup`, async ({ body }) => {
    if (!body?.text) throw HttpError.badRequest('text 为必填');
    return services.commands.runMarkup(body.text, { dryRun: Boolean(body.dryRun) });
  });

  // ---------------------------------------------------------------- 导出（ICS）
  router.get(`${API_PREFIX}/ics`, ({ query, req }) => {
    const events = services.events.list({ from: query.from, to: query.to });
    const schedules = services.schedules.list({ from: query.from, to: query.to, includeRolled: false });
    const host = req.headers.host ?? '127.0.0.1';
    return {
      __raw: {
        contentType: 'text/calendar; charset=utf-8',
        headers: { 'Content-Disposition': `inline; filename="potato-calendar-${host}.ics"` },
        body: buildIcs({ events, schedules, calendarName: query.name ?? 'Potato Calendar' }),
      },
    };
  });

  // ---------------------------------------------------------------- dschat 2 兼容接口
  router.get(`${API_PREFIX}/compat/dschat/events`, ({ query }) => ({
    events: services.schedules.list({ from: query.start, to: query.end, includeRolled: false }).map(toDschatEvent),
  }));

  router.post(`${API_PREFIX}/compat/dschat/events`, async ({ body }) => {
    const { target, fields } = fromDschatEvent(body ?? {});
    const item = target === 'event' ? await services.events.create(fields) : await services.schedules.create(fields);
    return { __status: 201, id: item.id, target, item };
  });

  /** dschat 2 的按标题批量删除（精确匹配）。 */
  router.post(`${API_PREFIX}/compat/dschat/events/delete`, async ({ body }) => {
    if (!body?.title) throw HttpError.badRequest('title 为必填');
    const matches = services.schedules
      .list({ keyword: body.title, includeRolled: false })
      .filter((item) => item.title === body.title);
    await services.store.schedules.removeMany(matches.map((item) => item.id));
    return { deleted: matches.length };
  });

  router.patch(`${API_PREFIX}/compat/dschat/events/:id`, async ({ params, body }) => {
    const payload = { ...(body ?? {}) };
    delete payload.id;
    const item = await services.schedules.update(params.id, payload);
    return { item: toDschatEvent(item) };
  });

  router.delete(`${API_PREFIX}/compat/dschat/events/:id`, async ({ params }) => services.schedules.remove(params.id));

  // ---------------------------------------------------------------- AI 接入（占位）
  router.get(`${API_PREFIX}/ai/capabilities`, () => ({
    contractVersion: AI_CONTRACT_VERSION,
    ...aiBridge.capabilities(),
    // 思源学堂工具清单：AI Agent 只需按 name + params 调用，不必了解登录细节
    lmsTools: LMS_TOOL_SPECS,
  }));

  // ---------------------------------------------------------------- 思源学堂接入
  registerLmsRoutes(router, { lms: services.lms, apiPrefix: API_PREFIX });

  router.post(`${API_PREFIX}/ai/nl2command`, async ({ body }) => {
    if (!body?.text) throw HttpError.badRequest('text 为必填');
    const draft = await aiBridge.nlToCommand({
      text: body.text,
      context: body.context,
      fallback: body.fallback,
    });
    return { draft };
  });

  // ---------------------------------------------------------------- 测试页面（浏览器直开）
  // Electron 不可用时（例如二进制下载失败或运行时崩溃），可用浏览器直接打开本模块的测试页面联调。
  //
  // 注意：页面内的 styles.css / app.js / views.js 都是**相对路径**。
  // 若直接访问 `/app`（无尾斜杠），浏览器会以 `/` 为基准解析成 `/styles.css`，导致整页无样式、无脚本；
  // 因此裸路径 302 到 `/app/`（Electron 用 file:// 加载本地文件，不受影响）。
  // 路由编译允许可选尾斜杠，所以 `/app` 与 `/app/` 命中同一个模式，这里在处理器内区分。
  const rendererFile = (file) => ({
    __raw: {
      contentType: CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
      body: readFileSync(path.join(RENDERER_DIR, file), 'utf8'),
    },
  });

  router.get('/app', ({ req }) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
    if (pathname === '/app') {
      return {
        __raw: {
          status: 302,
          contentType: 'text/plain; charset=utf-8',
          headers: { Location: '/app/' },
          body: '',
        },
      };
    }
    return rendererFile(RENDERER_FILES['/app/index.html']);
  });

  for (const [pattern, file] of Object.entries(RENDERER_FILES)) {
    router.get(pattern, () => rendererFile(file));
  }

  return router;
}
