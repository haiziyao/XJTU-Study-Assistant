/**
 * 框架级路由。
 *
 * 归属原则：**与具体业务无关的接口放这里，业务接口放各模块的 routes.js**。
 * 这里的接口在新增功能时都不需要改动。
 *
 * 注意 `/commands/grammar` 与 `/commands/markup` 不在这里 —— 前者描述的是日历模块的
 * 指令语法，后者解析的是 dschat 标记行，都属于日历业务，因此由 modules/calendar 注册。
 */

import { AI_CONTRACT_VERSION } from './ai/ai-bridge.js';
import { HttpError } from './http/router.js';
import { registerStaticRoutes } from './http/static.js';
import { API_PREFIX, WS_PATH } from '../shared/constants.js';
import { MAX_LUNAR_SPAN_DAYS, lunarDay, lunarRange, spanDays } from '../shared/lunar.js';
import { THEME } from '../shared/theme.js';

/**
 * @param {object} router core/http/router.js 的实例
 * @param {object} ctx
 * @param {object} ctx.services        全局服务表
 * @param {object} ctx.aiBridge        AI provider 桥
 * @param {object} [ctx.hub]           WebSocketHub（用于 health 报告连接数）
 * @param {object[]} [ctx.modules]     已装配的模块描述符
 * @param {Function} [ctx.describeModules] 模块摘要函数
 * @param {string} [ctx.version]
 * @param {string} [ctx.apiPrefix]
 * @param {string} [ctx.staticDir]     渲染层目录（不传则不注册静态路由）
 * @param {string} [ctx.staticPrefix]
 */
export function registerCoreRoutes(router, ctx) {
  const {
    services,
    aiBridge,
    hub,
    modules = [],
    describeModules = () => [],
    version = '0.1.0',
    apiPrefix = API_PREFIX,
    staticDir,
    staticPrefix = '/app',
  } = ctx;

  const { store } = services;

  // ---------------------------------------------------------------- 元信息
  router.get(apiPrefix, () => ({
    name: 'xjtu-study-assistant',
    version,
    description: 'AI 智学程序后端（框架 + 可插拔功能模块）',
    modules: describeModules(),
    endpoints: router.list().filter((line) => line.includes(apiPrefix)),
    websocket: WS_PATH,
  }));

  router.get(`${apiPrefix}/health`, () => ({
    status: 'ok',
    time: new Date().toISOString(),
    // 各集合条数按模块声明自动汇总：新增模块不必回来改这个接口
    counts: Object.fromEntries(store.collectionNames.map((name) => [name, store[name].all().length])),
    // clients > 0 说明有前端（测试窗口 / 浏览器页面）已连上推送通道
    websocket: { path: WS_PATH, clients: hub?.size ?? 0 },
    ai: { available: aiBridge.available, provider: aiBridge.provider?.name ?? null },
  }));

  /** 模块自描述：前端与主程序可据此探测后端提供了哪些功能。 */
  router.get(`${apiPrefix}/modules`, () => ({ items: describeModules() }));

  router.get(`${apiPrefix}/meta/theme`, () => ({ theme: THEME }));

  /**
   * 农历（框架级：与业务无关，日期换算能力）。
   *
   * 契约与当年预留的一致（`date` -> `{ date, lunar, festivals, text }`），并补了一个
   * **批量模式**：月视图要一次拿 42 天、年视图 365 天，逐日请求不现实。
   *
   * 实现见 `shared/lunar.js`：数据表沿用旧表（表是对的），但闰月的读法按标准编码修正
   * （闰月月份取低 4 位、闰月天数取 bit 16），旧的读法有约 99.7% 偏差。
   */
  const isValidDateKey = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Boolean(lunarDay(value));

  router.get(`${apiPrefix}/meta/lunar`, ({ query }) => {
    if (query.from || query.to) {
      if (!query.from || !query.to) {
        throw HttpError.badRequest('批量查询需要同时提供 from 与 to（YYYY-MM-DD）', { field: query.from ? 'to' : 'from' });
      }
      if (!isValidDateKey(query.from) || !isValidDateKey(query.to)) {
        throw HttpError.badRequest('from / to 必须是合法的 YYYY-MM-DD（农历数据覆盖 1900-01-31 起）');
      }
      const span = spanDays(query.from, query.to);
      if (span < 0) throw HttpError.badRequest('to 不能早于 from', { field: 'to' });
      if (span > MAX_LUNAR_SPAN_DAYS) {
        throw HttpError.badRequest(`区间跨度过大：最多 ${MAX_LUNAR_SPAN_DAYS} 天（收到 ${span} 天）`, { field: 'to' });
      }
      return { from: query.from, to: query.to, days: lunarRange(query.from, query.to) };
    }

    if (!query.date) throw HttpError.badRequest('date 为必填（YYYY-MM-DD），或改用 from+to 批量查询');
    if (!isValidDateKey(query.date)) throw HttpError.badRequest('date 必须是合法的 YYYY-MM-DD（农历数据覆盖 1900-01-31 起）');
    const item = lunarDay(query.date);
    return { date: item.date, lunar: item.lunar, festivals: item.festivals, text: item.text };
  });

  // ---------------------------------------------------------------- 指令（通用入口）
  // 解析器与落库逻辑由 services.commands 提供；各模块通过 registerHandler 扩展自己支持的 target。
  router.get(`${apiPrefix}/commands/logs`, ({ query }) => ({
    items: store.commandLogs
      .all()
      .slice(-Number(query.limit ?? 50))
      .reverse(),
  }));

  router.post(`${apiPrefix}/commands/parse`, ({ body }) => {
    if (!body?.text) throw HttpError.badRequest('text 为必填');
    return { draft: services.commands.parse(body.text) };
  });

  router.post(`${apiPrefix}/commands/execute`, async ({ body }) => {
    if (!body?.text && !body?.draft) throw HttpError.badRequest('text 或 draft 至少提供一个');
    const draft = body.draft ?? services.commands.parse(body.text);
    return services.commands.execute(draft, { dryRun: Boolean(body.dryRun) });
  });

  router.post(`${apiPrefix}/commands/run`, async ({ body }) => {
    if (!body?.text) throw HttpError.badRequest('text 为必填');
    return services.commands.run(body.text, { dryRun: Boolean(body.dryRun) });
  });

  // ---------------------------------------------------------------- AI 接入（占位）
  router.get(`${apiPrefix}/ai/capabilities`, () => ({
    contractVersion: AI_CONTRACT_VERSION,
    ...aiBridge.capabilities(),
    // 各模块声明的工具清单统一聚合（如思源学堂的登录/同步工具），
    // AI Agent 只需按 name + params 调用，不必了解各模块的登录细节。
    aiTools: modules.flatMap((mod) => (mod.aiTools ?? []).map((tool) => ({ ...tool, module: mod.id }))),
  }));

  router.post(`${apiPrefix}/ai/nl2command`, async ({ body }) => {
    if (!body?.text) throw HttpError.badRequest('text 为必填');
    const draft = await aiBridge.nlToCommand({
      text: body.text,
      context: body.context,
      fallback: body.fallback,
    });
    return { draft };
  });

  // ---------------------------------------------------------------- 测试页面（浏览器直开）
  // Electron 不可用时（二进制下载失败 / 运行时崩溃），可用浏览器直接打开联调页面。
  if (staticDir) registerStaticRoutes(router, { root: staticDir, prefix: staticPrefix });
}
