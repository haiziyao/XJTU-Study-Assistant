/**
 * 统一检索的 HTTP 路由。
 *
 * 路径刻意**不带模块 id**（`/api/v1/search`，而不是 `/api/v1/aisearch/search`）：
 * 这个模块不是"又一个数据域"，而是三个已有域的**检索入口**（校规 / 笔记 / 记忆）。
 * 界面把它当成"全局搜索框"用，`/search` 是它该有的名字。
 *
 * 这一层刻意很薄：校验、打分、去重、降级都在 `AiSearchService` 里。
 * 路由只做一件事 —— 把查询串原样交给服务层（**包括校验**），因为同一套规则还要服务
 * 只读指令那条入口（commands.js）。规则写两份，迟早有一份先过期。
 *
 * 两条接口：
 *   GET /search?q=&scope=&limit=&perSource=&course=&noteIds=&memoryStatus=
 *   GET /search/sources                       三路各自是否可用 / 多少条（界面与自检用）
 */

/**
 * @param {object} router    createRouter() 的实例（core/http/router.js）
 * @param {object} ctx       `search` 是 AiSearchService，`apiPrefix` 由 server 注入（形如 /api/v1）
 */
export function registerSearchRoutes(router, { search, apiPrefix = '/api/v1' }) {
  // 与 memory / notes 的 `if (!xxx) return;` 同一习惯：服务没装配好时宁可不注册，
  // 也不要让每个请求在运行期炸一个 "Cannot read properties of undefined"
  if (!search) return;

  const P = `${apiPrefix}/search`;

  // 注册顺序与匹配无关（router 的模式是锚定的 `^...$`，`/search` 不会吃掉 `/search/sources`），
  // 但把更具体的路径写在前面，读代码的人不用去验证这一点
  router.get(`${P}/sources`, ({ query }) => search.sources({ memoryStatus: query.memoryStatus }));

  /**
   * 三路统一检索。**任何一路坏掉都返回 200**：失败写在 `sources[].error` 里，
   * 另外两路照常返回（"没查成"与"没有"必须能分辨，见 service.js 的降级一节）。
   * 只有**参数本身不合法**（缺 q、未知 scope、limit 越界）才 400。
   */
  router.get(P, ({ query }) =>
    search.search({
      q: query.q,
      scope: query.scope,
      limit: query.limit,
      perSource: query.perSource,
      course: query.course,
      noteIds: query.noteIds,
      memoryStatus: query.memoryStatus,
    }),
  );
}
