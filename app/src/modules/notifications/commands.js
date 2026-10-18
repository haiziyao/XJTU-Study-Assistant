/**
 * 目标 `notification` 的指令处理器。
 *
 * 四个动作，读写分明：
 *   · `query` 只读 —— `dryRun: true` 执行，不写库、不联网（列表查询是本地过滤）；
 *   · `sync`  联网 + 写库 —— 必须用户确认；
 *   · `read`  写本地状态（标记已读）；
 *   · `pin`   写本地状态（固定，固定后不会被保留期清理）。
 *
 * `query` 的结果里刻意带上 `summary.retention / lastSyncAt / sources`：
 * `#compactQueryResult` 只保留 `filters / count / truncated / explain / items`（外加 `summary`），
 * 而"本地的通知是多久以前同步的、保留期多长"直接决定这个答案可信到什么程度 ——
 * 模型必须知道，否则会把"90 天前同步的旧数据"说成"最新的通知"。
 */

/** 与 module.js 的 `aiQueryLimits.notification` 保持一致。 */
export const AI_QUERY_LIMIT = 20;

export function createNotificationCommands({ notifications }) {
  return {
    /** 只读查询（本地）。 */
    async query(draft) {
      const filters = draft?.filters ?? {};
      const result = notifications.list({
        siteId: filters.siteId ?? filters.site ?? filters.host,
        q: filters.q ?? filters.query ?? filters.keyword,
        unreadOnly: Boolean(filters.unreadOnly ?? filters.unread),
        pinned: Boolean(filters.pinned),
        since: filters.since,
        until: filters.until,
        limit: filters.limit ?? AI_QUERY_LIMIT,
        offset: filters.offset,
      });
      const stats = notifications.stats();

      const explain = result.total
        ? `本地已有 ${stats.total} 条校内通知（未读 ${stats.unread} 条、固定 ${stats.pinned} 条），`
          + `这次按条件命中 ${result.total} 条，下面给出 ${result.count} 条。`
          + (result.filters.unreadOnly ? '（只看未读）' : '')
        : '本地还没有符合条件的通知。'
          + (stats.total ? `本地一共 ${stats.total} 条，可能被筛选条件排除了。` : '还没同步过，先用 sync 拉一次。');

      return {
        filters: result.filters,
        count: result.count,
        items: result.items,
        summary: {
          total: stats.total,
          unread: stats.unread,
          pinned: stats.pinned,
          bySite: stats.bySite,
          lastSyncAt: stats.lastSyncAt,
          retentionDays: stats.retentionDays,
          // 这三个字段是"这份答案有多新"的凭据，必须给模型看到
          freshnessNote: stats.lastSyncAt
            ? `本地数据最后一次同步是 ${stats.lastSyncAt}；之后校方发的通知还没有进来。`
            : '本地数据还从未同步过，里面可能一条都没有。',
          retentionNote:
            stats.retentionDays > 0
              ? `只保留最近 ${stats.retentionDays} 天的通知（按"第一次看到它的时间"算），固定的条目不受限制。`
              : '保留期设为永久，本地不会自动清理。',
        },
        explain,
      };
    },

    /** 拉一次最新（联网 + 写库）。 */
    async sync(draft) {
      const filters = draft?.filters ?? {};
      const result = await notifications.sync({
        siteIds: filters.siteIds ?? (filters.site ? [filters.site] : undefined),
        limitPerSite: filters.limitPerSite,
      });
      const failed = result.perSite.filter((site) => site.error);
      const explain =
        `同步完成：新增 ${result.inserted} 条、刷新 ${result.refreshed} 条`
        + (result.pruned ? `、按保留期清理 ${result.pruned} 条` : '')
        + `。本地共 ${result.total} 条。`
        + (failed.length ? ` 有 ${failed.length} 个站点没抓成：${failed.map((s) => `${s.label}（${s.error}）`).join('；')}。` : '');
      return { count: result.inserted, perSite: result.perSite, summary: result, explain };
    },

    /** 标记已读。 */
    async read(draft) {
      const fields = draft?.fields ?? {};
      const filters = draft?.filters ?? {};
      const result = await notifications.markRead({
        ids: fields.ids ?? filters.ids,
        all: Boolean(fields.all ?? filters.all),
        siteId: fields.siteId ?? filters.site,
      });
      return {
        count: result.updated,
        summary: result,
        explain: result.updated ? `已把 ${result.updated} 条标为已读。` : '没有需要标记的通知。',
      };
    },

    /** 固定 / 取消固定。固定的条目不会被保留期清理。 */
    async pin(draft) {
      const fields = draft?.fields ?? {};
      const result = await notifications.pin({
        ids: fields.ids ?? draft?.filters?.ids,
        pinned: fields.pinned !== false,
      });
      return {
        count: result.updated,
        summary: result,
        explain: result.updated
          ? `已${result.pinned ? '固定' : '取消固定'} ${result.updated} 条。${result.pinned ? '固定的通知不会被保留期清理。' : ''}`
          : '没有找到要操作的通知。',
      };
    },
  };
}
