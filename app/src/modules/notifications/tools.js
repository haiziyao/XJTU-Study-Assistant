/**
 * 通知模块的「工具清单」：给**外部 AI Agent**（走 HTTP 的那种）看的接口契约。
 *
 * 与 `module.js` 的 `aiPrompt` 分工一致：`aiPrompt` 给对话模型看（它用 `target:"notification"`
 * 的草稿取数），这里给工具调用型 Agent 看。两边参数形状必须一致，否则模型按 A 学会的写法在 B 上会失败。
 *
 * 四件里只有 `notification_sync` 会联网且会写库（还把超期条目清理掉）；
 * 其余三个都是本地读写，可以放心重试。这个区分必须写给 Agent 看 ——
 * 它若把 sync 当"查询"反复调，会在用户不知情时反复打校方站点、并按保留期删数据。
 */

export const NOTIFICATION_TOOLS = [
  {
    name: 'notification_list',
    description:
      '查询本地已同步的校内通知（教务处 / 研究生院 / 学校门户 / 新闻网，以及用户自定义的站点）。' +
      '只读、不联网、不改状态。每条带 title/url/siteLabel/publishedAt/firstSeenAt/read/pinned。' +
      '★ 两个时间字段含义不同：publishedAt 是校方给的发布日期（**可能为空或只到月份**，不要补具体日子）；' +
      'firstSeenAt 是本地第一次发现它的时间，判断"是不是新的"要用它。' +
      '引用时每条都要带 url；本地没有的如实说没有，不要编造通知。' +
      'summary.lastSyncAt 说明这份数据有多新 —— 如果很久没同步，回答时要说明"这是上次同步时的结果"。',
    method: 'GET',
    path: '/notifications',
    requiresAuth: false,
    mutates: false,
    implemented: true,
    params: {
      siteId: 'string?',
      q: 'string?',
      unread: 'boolean?',
      pinned: 'boolean?',
      since: 'string?',
      limit: 'number?',
      offset: 'number?',
    },
    returns: { total: 'number', count: 'number', items: 'Notification[]', filters: 'object' },
  },
  {
    name: 'notification_sync',
    description:
      '★ 会联网、会写库、并会按保留期删除超期条目（固定的不删）。' +
      '去校方站点抓一遍最新通知，按 URL 去重后并入本地：新条目记为未读，已存在的只刷新"最近一次看到"。' +
      '调用前应先征得用户同意；不要把它当查询反复调用。' +
      '返回 perSite 里逐站写着抓到了几条、哪一页失败以及原因 —— 有 error 时不能把那个站说成"没有新通知"。',
    method: 'POST',
    path: '/notifications/sync',
    requiresAuth: false,
    mutates: true,
    implemented: true,
    params: { siteIds: 'string[]?', limitPerSite: 'number?', dryRun: 'boolean?' },
    returns: { inserted: 'number', refreshed: 'number', pruned: 'number', perSite: 'SiteReport[]', total: 'number' },
  },
  {
    name: 'notification_read',
    description:
      '把通知标记为已读。只改本地状态、不联网、不删数据。可以给一组 id，也可以 all:true 全标（可按 siteId 限定范围）。',
    method: 'POST',
    path: '/notifications/read',
    requiresAuth: false,
    mutates: true,
    implemented: true,
    params: { ids: 'string[]?', all: 'boolean?', siteId: 'string?' },
    returns: { updated: 'number', ids: 'string[]' },
  },
  {
    name: 'notification_pin',
    description:
      '固定 / 取消固定某条通知。★ 固定的条目**不会被保留期清理**，适合"要照着办事、暂时不能丢"的通知。' +
      '只改本地状态、不联网。',
    method: 'POST',
    path: '/notifications/pin',
    requiresAuth: false,
    mutates: true,
    implemented: true,
    params: { ids: 'string[]', pinned: 'boolean?' },
    returns: { updated: 'number', pinned: 'boolean', ids: 'string[]' },
  },
];
