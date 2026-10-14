/**
 * 同步模块的路由（挂在 `${API_PREFIX}/sync`，即页面看到的 `/api/v1/sync`）。
 *
 * 冻结接口（前端 / 手机端 / 服务端**都照这个写**，不要再发明第二套）：
 *
 *   GET  /sync/status    → {deviceId, deviceName, lastPullAt, lastPushAt, lastError,
 *                           collections: {<name>: {count, maxUpdatedAt}}}
 *                          补充：cursor / syncSecrets / runtime / account / deleteSync
 *   POST /sync/pull      `{deviceId, since}` → `{serverTime, collections: {<name>: [items]},
 *                           deleted: {<name>: [ids]}}`（补充：nextSince / truncated / errors）
 *   POST /sync/push      `{deviceId, deviceName, collections, deleted}` →
 *                        `{accepted, skipped, renamed, groups: {<name>: {...}},
 *                          duplicates: [...], conflicts: [...], serverTime}`
 *   POST /sync/run       `{serverUrl?}` → **一站式**：读本地 → push → pull → 就地合并，
 *                        返回人话报告 `{pushed, pulled, skipped, renamed, duplicates,
 *                        conflicts, durationMs, at}`（桌面端面板就调这一条）
 *   GET  /sync/settings  → `{deviceId, deviceName, syncSecrets: {aiConfig, lms}}`
 *   POST /sync/settings  `{syncSecrets: {aiConfig, lms}}` → 200 回同样结构
 *
 * 为什么 `pull`/`push` 用 POST 而不是 GET：
 *   - push 的 body 是数据本身（可能几百 KB 到几 MB，分片前单批 ≤ 2 MB），GET 放不下；
 *   - pull 要带 `since` 游标，而且服务端要记"谁在什么时候拉的"（`lastServedAt`），
 *     GET 的语义是"可缓存、无副作用"，与它不符。
 *
 * 为什么没有鉴权：本模块跑在**本机后端**（只监听 127.0.0.1，桌面端）或**该账号自己的实例**
 * （服务端版：公网只能经 8866 宿主的登录态反代进来，见 `src/www/proxy.js`）。
 * 鉴权发生在更外层，模块里再做一层是重复且容易写错。**会话令牌不经过这里**。
 */

/** 把 query 里的运行环境事实解析出来（渲染层上报，判定逻辑只在 runtime.js 一处）。 */
function runtimeFacts(query = {}) {
  const hostname = typeof query.hostname === 'string' ? query.hostname : '';
  // `authConfig=1|0` 或者不传（= 渲染层没验成功 → null → unknown）
  const raw = query.authConfig ?? query.authConfigReachable;
  const authConfigReachable = raw === undefined || raw === '' ? null : String(raw) === '1' || String(raw) === 'true';
  return { hostname, authConfigReachable };
}

export function registerSyncRoutes(router, { own, apiPrefix }) {
  const sync = own.sync;
  const P = `${apiPrefix}/sync`;

  /** 状态（冻结字段 + 面板要用的补充）。 */
  router.get(`${P}/status`, ({ query }) => sync.status(runtimeFacts(query)));

  /** 敏感数据开关（默认两项都 false）。 */
  router.get(`${P}/settings`, ({ query }) => sync.settings(runtimeFacts(query)));
  router.post(`${P}/settings`, ({ body, query }) =>
    sync.updateSettings({ ...(body ?? {}), ...runtimeFacts({ ...query, ...(body ?? {}) }) }));

  /** 服务端侧：另一台设备把数据推上来。 */
  router.post(`${P}/push`, ({ body }) => sync.applyPush(body ?? {}));

  /** 服务端侧：另一台设备拉增量。 */
  router.post(`${P}/pull`, ({ body }) => sync.collectChanges(body ?? {}));

  /**
   * 桌面端侧：一站式同步。
   * `serverUrl` 可以为空 —— 空就是"本机自己同步自己"，直接回 `{skipped:true, reason:'no_server'}`，
   * 一个请求都不发（这是明确约定，不是错误）。
   */
  router.post(`${P}/run`, ({ body }) => {
    const facts = runtimeFacts({ ...(body ?? {}) });
    return sync.run({ serverUrl: body?.serverUrl, ...facts });
  });
}
