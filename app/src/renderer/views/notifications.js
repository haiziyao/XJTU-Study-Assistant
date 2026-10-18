/**
 * 「通知」视图：本地已同步的校内通知。
 *
 * 定位：**这是"我收到了什么"的面板，不是搜索引擎**。所以：
 *   · 默认只读本地（打开很快、离线也看得到）；
 *   · 「同步」是**显式动作**，会联网、会写库，并且会按保留期清理超期条目；
 *   · 每行可以**固定**——固定的条目不会被保留期清理。
 *
 * 三件在界面上必须说清、否则用户会误会的事：
 *   1. **发布日期 ≠ 我发现它的时间**。校方的 `publishedAt` 经常空或只到月份，
 *      而"新"是按 `firstSeenAt` 算的。所以两个时间都显示，并且标出各自的含义。
 *   2. **保留期会真的删数据**。面板上要写明当前保留多少天、同步时清了几条。
 *   3. **某个站点抓失败 ≠ 那个站没有通知**。同步结果里逐站显示，失败的原样亮出来。
 */

(() => {
  'use strict';

  const ui = {
    mount: null,
    items: [],
    stats: null,
    sources: [],
    settings: null,
    /** 筛选：站点 / 只看未读 / 只看固定。改这些**只重画面板**，不重新请求。 */
    filters: { siteId: '', unreadOnly: false, pinned: false },
    loading: false,
    syncing: false,
    error: null,
    /** 上一次同步的逐站结果（含失败原因），同步后显示。 */
    lastSync: null,
    /** 正在忙碌的条目 id（标记已读 / 固定时禁用按钮，避免连点）。 */
    busy: new Set(),
  };

  function mk(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /** 时间展示：只到分钟，`T` 换空格。日期串按字面量切，避免时区把它串到前一天。 */
  function fmt(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (match) {
      const [, y, m, d, hh, mm] = match;
      // 只有年月（校方常见）时如实说"某月"，不补日子
      if (!d) return `${y}-${m}`;
      return hh ? `${y}-${m}-${d} ${hh}:${mm}` : `${y}-${m}-${d}`;
    }
    return text;
  }

  /** 校方的发布日期可能只到月（`2026-09`），此时不能当完整日期展示。 */
  function fmtPublished(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    if (/^\d{4}-\d{2}$/.test(text)) return `${text}（只到月份）`;
    return fmt(text);
  }

  /* ---------------------------------------------------------------- 数据 */

  async function load() {
    ui.loading = true;
    ui.error = null;
    paint();
    try {
      const [list, status, sources] = await Promise.all([
        PC.api('/notifications?limit=50'),
        PC.api('/notifications/status'),
        PC.api('/notifications/sources'),
      ]);
      ui.items = list.items ?? [];
      ui.stats = status.stats ?? null;
      ui.settings = status.settings ?? null;
      ui.sources = sources.items ?? [];
    } catch (error) {
      ui.error = error?.message ?? String(error);
    } finally {
      ui.loading = false;
      paint();
    }
  }

  async function sync() {
    if (ui.syncing) return;
    ui.syncing = true;
    ui.error = null;
    paint();
    try {
      const result = await PC.api('/notifications/sync', { method: 'POST', body: {} });
      ui.lastSync = result;
      PC.toast?.(
        `同步完成：新增 ${result.inserted} 条`
          + (result.pruned ? `，按保留期清理 ${result.pruned} 条` : ''),
      );
      await load();
    } catch (error) {
      ui.error = error?.message ?? String(error);
    } finally {
      ui.syncing = false;
      paint();
    }
  }

  async function patchItem(id, action) {
    if (ui.busy.has(id)) return;
    ui.busy.add(id);
    paint();
    try {
      if (action === 'read') await PC.api('/notifications/read', { method: 'POST', body: { ids: [id] } });
      if (action === 'pin') await PC.api('/notifications/pin', { method: 'POST', body: { ids: [id], pinned: true } });
      if (action === 'unpin') {
        await PC.api('/notifications/pin', { method: 'POST', body: { ids: [id], pinned: false } });
      }
      await load();
    } catch (error) {
      ui.error = error?.message ?? String(error);
    } finally {
      ui.busy.delete(id);
      paint();
    }
  }

  async function markAllRead() {
    try {
      await PC.api('/notifications/read', { method: 'POST', body: { all: true } });
      await load();
    } catch (error) {
      ui.error = error?.message ?? String(error);
      paint();
    }
  }

  /* ---------------------------------------------------------------- 渲染 */

  /** 按当前筛选条件过滤（纯本地，不发请求）。 */
  function visible() {
    return ui.items.filter((item) => {
      if (ui.filters.siteId && item.siteId !== ui.filters.siteId) return false;
      if (ui.filters.unreadOnly && item.read) return false;
      if (ui.filters.pinned && !item.pinned) return false;
      return true;
    });
  }

  function toolbar() {
    const bar = mk('div', 'toolbar');

    const siteWrap = mk('label', 'toolbar-field');
    siteWrap.append(mk('span', 'toolbar-label', '站点'));
    const select = mk('select', 'notif-site');
    const all = mk('option', null, '全部站点');
    all.value = '';
    select.appendChild(all);
    for (const source of ui.sources) {
      // 只列启用的 + 已有关注数据的，不把 19 个站全铺出来
      if (!source.enabled && !ui.items.some((item) => item.siteId === source.id)) continue;
      const option = mk('option', null, source.label);
      option.value = source.id;
      select.appendChild(option);
    }
    select.value = ui.filters.siteId;
    select.addEventListener('change', () => {
      ui.filters.siteId = select.value;
      paint();
    });
    siteWrap.appendChild(select);

    const unread = mk('label', 'check-field');
    const unreadBox = mk('input', 'notif-unread');
    unreadBox.type = 'checkbox';
    unreadBox.checked = ui.filters.unreadOnly;
    unreadBox.addEventListener('change', () => {
      ui.filters.unreadOnly = unreadBox.checked;
      paint();
    });
    unread.append(unreadBox, mk('span', null, '只看未读'));

    const pinned = mk('label', 'check-field');
    const pinnedBox = mk('input', 'notif-pinned');
    pinnedBox.type = 'checkbox';
    pinnedBox.checked = ui.filters.pinned;
    pinnedBox.addEventListener('change', () => {
      ui.filters.pinned = pinnedBox.checked;
      paint();
    });
    pinned.append(pinnedBox, mk('span', null, '只看固定'));

    const syncBtn = mk('button', 'primary-btn notif-sync', ui.syncing ? '同步中…' : '同步最新');
    syncBtn.type = 'button';
    syncBtn.disabled = ui.syncing;
    syncBtn.title = '去校方站点抓一遍最新通知；会按保留期清理超期条目（固定的不删）';
    syncBtn.addEventListener('click', () => void sync());

    const readAll = mk('button', 'ghost-btn notif-read-all', '全部已读');
    readAll.type = 'button';
    readAll.disabled = !(ui.stats?.unread > 0);
    readAll.addEventListener('click', () => void markAllRead());

    bar.append(siteWrap, unread, pinned, mk('span', 'spacer'), readAll, syncBtn);
    return bar;
  }

  function summary() {
    const stats = ui.stats;
    if (!stats) return null;
    const row = mk('div', 'notif-summary');
    const parts = [
      `共 ${stats.total} 条`,
      `未读 ${stats.unread}`,
      `固定 ${stats.pinned}`,
      stats.lastSyncAt ? `上次同步 ${fmt(stats.lastSyncAt)}` : '还没同步过',
      stats.retentionDays > 0
        ? `保留最近 ${stats.retentionDays} 天（固定的不限）`
        : '保留期：永久',
    ];
    for (const text of parts) row.appendChild(mk('span', 'notif-chip', text));
    return row;
  }

  function row(item) {
    const line = mk('div', 'notif-row');
    if (!item.read) line.classList.add('is-unread');
    if (item.pinned) line.classList.add('is-pinned');

    // 标题：点开原文。用 <a target=_blank rel=noopener>，不在页面里内嵌外来页面。
    const main = mk('div', 'notif-main');
    const link = mk('a', 'notif-title', item.title || '(无标题)');
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    main.appendChild(link);

    const meta = mk('div', 'notif-meta');
    meta.appendChild(mk('span', 'notif-site', item.siteLabel ?? item.siteId ?? ''));
    if (item.publishedAt) {
      // ★ 两个时间含义不同，标清楚：发布日期是校方给的，发现时间是本地第一次看到
      meta.appendChild(mk('span', 'notif-date', `发布 ${fmtPublished(item.publishedAt)}`));
    } else {
      meta.appendChild(mk('span', 'notif-date notif-date-missing', '校方未给发布日期'));
    }
    if (item.firstSeenAt) meta.appendChild(mk('span', 'notif-seen', `发现 ${fmt(item.firstSeenAt)}`));
    if (item.pinned) meta.appendChild(mk('span', 'notif-flag', '📌 已固定'));
    main.appendChild(meta);

    const actions = mk('div', 'notif-actions');
    const togglePin = mk('button', 'ghost-btn notif-pin', item.pinned ? '取消固定' : '📌 固定');
    togglePin.type = 'button';
    togglePin.disabled = ui.busy.has(item.id);
    togglePin.title = item.pinned ? '取消固定后，它会重新纳入保留期清理' : '固定后不会因保留期被清理';
    togglePin.addEventListener('click', () => void patchItem(item.id, item.pinned ? 'unpin' : 'pin'));
    actions.appendChild(togglePin);

    if (!item.read) {
      const readBtn = mk('button', 'ghost-btn notif-mark-read', '标记已读');
      readBtn.type = 'button';
      readBtn.disabled = ui.busy.has(item.id);
      readBtn.addEventListener('click', () => void patchItem(item.id, 'read'));
      actions.appendChild(readBtn);
    }

    line.append(main, actions);
    return line;
  }

  /** 上次同步的逐站结果 —— 失败的必须亮出来，否则用户会以为"那个站没有新通知"。 */
  function syncReport() {
    const result = ui.lastSync;
    if (!result?.perSite?.length) return null;
    const box = mk('div', 'notif-report');
    box.appendChild(mk('div', 'notif-report-title', '上次同步逐站结果'));
    for (const site of result.perSite) {
      const line = mk('div', site.error ? 'notif-report-row is-error' : 'notif-report-row');
      line.appendChild(mk('span', 'notif-report-site', site.label ?? site.siteId));
      line.appendChild(
        mk('span', 'notif-report-text', site.error ? `没抓成：${site.error}` : `新增 ${site.count} 条`),
      );
      box.appendChild(line);
    }
    return box;
  }

  function emptyState() {
    const box = mk('div', 'notif-empty');
    if (ui.stats?.total === 0) {
      box.appendChild(mk('div', null, '本地还没有通知。'));
      box.appendChild(mk('div', 'notif-hint', '点右上角「同步最新」去校方站点抓一次（会联网）。'));
    } else {
      box.appendChild(mk('div', null, '当前筛选条件下没有通知。'));
      box.appendChild(mk('div', 'notif-hint', '试试取消「只看未读 / 只看固定」，或换一个站点。'));
    }
    return box;
  }

  function paint() {
    const mount = ui.mount;
    if (!mount) return;
    mount.replaceChildren();

    const wrap = mk('div', 'view-content notif-view');
    wrap.appendChild(toolbar());

    const head = mk('div', 'notif-head');
    head.appendChild(mk('h2', 'notif-title-lg', '校内通知'));
    head.appendChild(
      mk('div', 'notif-hint', '本地已同步的通知。「同步」会联网抓取，并按保留期清理超期条目（📌 固定的不清理）。'),
    );
    wrap.appendChild(head);

    const stats = summary();
    if (stats) wrap.appendChild(stats);

    if (ui.error) wrap.appendChild(mk('div', 'error-banner', `出错了：${ui.error}`));
    if (ui.syncing) wrap.appendChild(mk('div', 'notif-hint', '正在抓取校方站点…（首次会慢几秒）'));

    const list = mk('div', 'notif-list');
    const rows = visible();
    if (!rows.length) list.appendChild(emptyState());
    else for (const item of rows) list.appendChild(row(item));
    wrap.appendChild(list);

    const report = syncReport();
    if (report) wrap.appendChild(report);

    mount.appendChild(wrap);
  }

  /* ---------------------------------------------------------------- 注册 */

  const notificationsView = {
    title: '通知',
    render(ctx) {
      ui.mount = ctx.mount;
      paint();
      void load();
    },
  };

  window.PCModules.register({
    id: 'notifications',
    label: '通知',
    icon: '📣',
    // 排在思源学堂(30)之后、学业(40)之前：都属于"我在学校收到了什么"这一类
    order: 35,
    title: notificationsView.title,
    render: (ctx) => notificationsView.render(ctx),
  });

  // 测试缝：只暴露既有函数，不加任何"测试专用逻辑"
  window.__PC_NOTIF_TEST__ = { ui, paint, visible, load, sync, fmt, fmtPublished };
})();
