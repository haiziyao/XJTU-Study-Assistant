/**
 * 账号模块的路由。
 *
 * 五条路由，全部挂在 `${API_PREFIX}/account`（= 浏览器看到的 `/api/v1/account`；
 * 渲染层用 `PC.api('/account')` 调用，前缀由外壳补齐）：
 *
 *   POST /account/login     `{serverUrl, username, password}` -> 后端代登录，成功后落盘
 *   POST /account/register  `{serverUrl, username, password, inviteCode}` -> 代注册（成功即登录）
 *   GET  /account           `{connected, serverUrl, user, loginAt}` —— **不含 token**
 *   GET  /account/probe     `?serverUrl=` -> `{reachable, serverName, version, features}`
 *   POST /account/logout    尽力通知服务器，本地一定清掉
 *
 * 为什么这几个动作必须走"后端代做"而不是渲染层直接 fetch 服务器：见 service.js 顶部
 * 的长注释（跨域 + HttpOnly 令牌不该进页面）。
 *
 * 错误全部用 `HttpError`：状态码沿用上游语义（401 密码错 / 403 邀请码 / 409 重名 /
 * 429 限流 / 502 连不上），message 一律是中文人话（映射表在 service.js 的 ERROR_MESSAGES）。
 */

/**
 * 注册路由。
 * @param {object} router 框架路由器（见 core/http/router.js）
 * @param {object} ctx
 * @param {{ account?: import('./service.js').AccountService }} ctx.own
 * @param {string} [ctx.apiPrefix] 接口前缀（默认 `/api/v1`，与框架其它模块一致）
 */
export function registerAccountRoutes(router, ctx = {}) {
  const service = ctx.own?.account;
  if (!service) throw new Error('账号模块没有初始化服务（module.js 的 createServices 没跑？）');
  const P = `${ctx.apiPrefix ?? '/api/v1'}/account`;

  // 登录：把 {serverUrl, username, password} 转给服务器，成功即保存会话
  router.post(`${P}/login`, async ({ body }) => {
    const result = await service.login(body ?? {});
    return { ok: true, user: result.user, serverUrl: result.serverUrl };
  });

  // 注册：语义同上，多一个邀请码
  router.post(`${P}/register`, async ({ body }) => {
    const result = await service.register(body ?? {});
    return { ok: true, user: result.user, serverUrl: result.serverUrl };
  });

  // 当前登录态。**绝不回传 token**：凭据只留在后端，页面上没有它的必要。
  router.get(P, async () => {
    const status = service.status();
    return {
      connected: status.connected,
      serverUrl: status.serverUrl,
      user: status.user,
      loginAt: status.loginAt,
    };
  });

  // 探测服务器：面板用它显示"服务器可达 / 版本 / LMS 是否可用"。
  // 地址不通或写错都返回 reachable:false（**不抛错**）——它本来就是给用户试地址用的。
  router.get(`${P}/probe`, async ({ query }) => service.probe({ serverUrl: query?.serverUrl }));

  // 退出登录：即使服务器连不上也要成功（本地一定清掉）
  router.post(`${P}/logout`, async () => service.logout());
}
