/**
 * 通知接口。
 *
 * 分工：
 *   · `GET  /notifications`          纯本地查询，不联网、不写库；
 *   · `POST /notifications/sync`     **唯一会联网的动作**，并且会在结束时按保留期清理；
 *   · `POST /notifications/read|pin` 写本地状态；
 *   · `GET  /notifications/status|sources|settings` 诊断与配置。
 *
 * 把"联网"单独放成一个 POST，是为了让"查询"这条最常用的路径永远是本地的、快的、
 * 不需要征得同意的 —— 用户在对话里问"最近有什么通知"不该触发一次抓取。
 */

import { HttpError } from '../../core/http/router.js';

const asBool = (value) => value === true || value === '1' || value === 'true' || value === 'yes';

export function registerNotificationRoutes(router, { notifications, apiPrefix }) {
  const P = `${apiPrefix}/notifications`;

  router.get(P, ({ query }) =>
    notifications.list({
      siteId: query?.siteId,
      q: query?.q,
      unreadOnly: asBool(query?.unread),
      pinned: asBool(query?.pinned),
      since: query?.since,
      until: query?.until,
      limit: query?.limit,
      offset: query?.offset,
    }),
  );

  /**
   * 同步一次。会联网，并且**会按保留期删掉超期条目**（固定的不删）。
   * `dryRun: true` 只抓不写 —— 用于"先看看能抓到什么"。
   */
  router.post(`${P}/sync`, ({ body }) =>
    notifications.sync({
      siteIds: body?.siteIds,
      limitPerSite: body?.limitPerSite,
      dryRun: asBool(body?.dryRun),
    }),
  );

  router.post(`${P}/read`, ({ body }) => {
    if (!body?.all && !Array.isArray(body?.ids)) {
      throw HttpError.badRequest('要么给 ids 数组，要么显式 all: true', { field: 'ids' });
    }
    return notifications.markRead({ ids: body?.ids, all: asBool(body?.all), siteId: body?.siteId });
  });

  router.post(`${P}/pin`, ({ body }) => {
    if (!Array.isArray(body?.ids) || !body.ids.length) {
      throw HttpError.badRequest('必须给 ids 数组', { field: 'ids' });
    }
    return notifications.pin({ ids: body.ids, pinned: body?.pinned !== false });
  });

  /** 统计 + 上次同步结果。页面顶部与"为什么没抓到"的诊断都靠它。 */
  router.get(`${P}/status`, () => ({
    stats: notifications.stats(),
    settings: notifications.settings(),
  }));

  /** 可关注的站点（内置 + 自定义），带启用状态与"已知不可用"的原因。 */
  router.get(`${P}/sources`, () => ({ items: notifications.sources() }));

  router.get(`${P}/settings`, () => notifications.settings());

  router.post(`${P}/settings`, ({ body }) => notifications.updateSettings(body ?? {}));
}
