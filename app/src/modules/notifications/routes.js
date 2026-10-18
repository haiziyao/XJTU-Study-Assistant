/**
 * 通知接口。
 *
 * 分工：
 *   · `GET  /notifications`            纯本地查询，不联网、不写库；
 *   · `GET  /notifications/:id/content` 抓**这一篇**的正文（给"在应用里读"用）；
 *   · `POST /notifications/sync`       **唯一会联网并写库的动作**，结束时按保留期清理；
 *   · `POST /notifications/pin`        写本地状态（固定 = 不被保留期清理）；
 *   · `GET  /notifications/status|sources|settings` 诊断与配置。
 *
 * 刻意**没有"已读/未读"**：这一版只做"收到了什么、能不能固定住"。
 * 已读状态会带来一整套列表语义（全部已读、按未读筛选、未读角标），
 * 而它跟"别漏掉重要通知"这件事关系不大 —— 固定 + 保留期才是。
 */

import { HttpError } from '../../core/http/router.js';

const asBool = (value) => value === true || value === '1' || value === 'true' || value === 'yes';

export function registerNotificationRoutes(router, { notifications, apiPrefix }) {
  const P = `${apiPrefix}/notifications`;

  router.get(P, ({ query }) =>
    notifications.list({
      siteId: query?.siteId,
      q: query?.q,
      pinned: asBool(query?.pinned),
      since: query?.since,
      until: query?.until,
      limit: query?.limit,
      offset: query?.offset,
    }),
  );

  /**
   * 读一条通知的正文。
   *
   * 为什么不让前端直接开浏览器：桌面端把 URL 交给系统会撞上 Windows 的权限提升比对
   * （「Edge 未响应，因为现有实例正在以提升的权限运行」），用户点"是"浏览器就被重启。
   * 由后端抓回来、清洗成文本，在面板里读，Web UI 与桌面端行为一致。
   */
  router.get(`${P}/:id/content`, ({ params }) => notifications.readBody(params.id));

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
