/**
 * 「通知」视图：本地已同步的校内通知。
 *
 * 定位：**这是"我收到了什么"的面板，不是搜索引擎**。所以：
 *   · 默认只读本地（打开很快、离线也看得到）；
 *   · 「同步」是**显式动作**，会联网、会写库，并且会按保留期清理超期条目；
 *   · 每行可以**固定**——固定的条目不会被保留期清理。
 *
 * 两个曾经踩过的坑，写在这里免得再犯：
 *
 * 1. **不要把布局类加在 `.view-content` 上。**
 *    外壳的 `.panel-body` 是 `overflow:hidden` 的 flex 容器，**真正滚动的是 `.view-content`**
 *    （`flex:1; min-height:0; overflow:auto`）。把 `.notif-view` 和它塞进同一个元素，
 *    两套 `display:flex` 打架，结果就是"内容一长就滚不动"。所以这里是两层：
 *    外层 `.view-content` 只负责滚动，内层 `.notif-view` 只负责布局。
 *
 * 2. **不要用 `<a target="_blank">` 打开原文。**
 *    Electron 的主进程装了 `setWindowOpenHandler → shell.openExternal`，把 URL 交给系统；
 *    而 Windows 会比对两边的权限等级，于是弹出「Edge 未响应，因为现有实例正在以提升的权限运行」，
 *    用户点"是"浏览器就被重启。所以正文由**后端**抓回来（`GET /notifications/:id/content`），
 *    在面板里读；链接只作为"复制/备用"展示。
 */

(() => {
  'use strict';

  const ui = {
    mount: null,
    items: [],
    stats: null,
    sources: [],
    settings: null,
    /** 筛选：站点 / 只看固定。改这些**只重画面板**，不重新请求。 */
    filters: { siteId: '', pinned: false },
    loading: false,
    syncing: false,
    error: null,
    /** 上一次同步的逐站结果（含失败原因），同步后显示。 */
    lastSync: null,
    /** 正在忙碌的条目 id（固定时禁用按钮，避免连点）。 */
    busy: new Set(),
    /** 正在阅读的正文：`{ id, title, url, text, busy, error }`。 */
    reader: null,
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
      return hh ? `${y}-${m}-${d} ${hh}:${mm}` : `${y}-${m}-${d}`;
    }
    return text;
  }

  /** 校方的发布日期可能只到月（`2026-09`），此时要说明，而不是当成完整日期。 */
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
        PC.api('/notifications?limit=100'),
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
        `同步完成：新增 ${result.inserted} 条` + (result.pruned ? `，按保留期清理 ${result.pruned} 条` : ''),
      );
      await load();
    } catch (error) {
      ui.error = error?.message ?? String(error);
    } finally {
      ui.syncing = false;
      paint();
    }
  }

  async function togglePin(item) {
    if (ui.busy.has(item.id)) return;
    ui.busy.add(item.id);
    paint();
    try {
      await PC.api('/notifications/pin', {
        method: 'POST',
        body: { ids: [item.id], pinned: !item.pinned },
      });
      await load();
    } catch (error) {
      ui.error = error?.message ?? String(error);
    } finally {
      ui.busy.delete(item.id);
      paint();
    }
  }

  /** 在面板里读正文（走后端抓取，不开浏览器 —— 见文件头第 2 条）。 */
  async function readBody(item) {
    if (ui.reader?.id === item.id && !ui.reader.busy) {
      ui.reader = null;
      paint();
      return;
    }
    ui.reader = { id: item.id, title: item.title, url: item.url, text: '', busy: true, error: null };
    paint();
    try {
      const data = await PC.api(`/notifications/content?id=${encodeURIComponent(item.id)}`);
      ui.reader = { ...ui.reader, text: data.text ?? '', title: data.title || item.title, busy: false };
    } catch (error) {
      ui.reader = { ...ui.reader, busy: false, error: error?.message ?? String(error) };
    }
    paint();
  }

  /* ---------------------------------------------------------------- 渲染 */

  function visible() {
    return ui.items.filter((item) => {
      if (ui.filters.siteId && item.siteId !== ui.filters.siteId) return false;
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

    bar.append(siteWrap, pinned, mk('span', 'spacer'), syncBtn);
    return bar;
  }

  function summary() {
    const stats = ui.stats;
    if (!stats) return null;
    const row = mk('div', 'notif-summary');
    const parts = [
      `共 ${stats.total} 条`,
      `固定 ${stats.pinned}`,
      stats.lastSyncAt ? `上次同步 ${fmt(stats.lastSyncAt)}` : '还没同步过',
      stats.retentionDays > 0 ? `保留最近 ${stats.retentionDays} 天（固定的不限）` : '保留期：永久',
    ];
    for (const text of parts) row.appendChild(mk('span', 'notif-chip', text));
    return row;
  }

  /** 正文面板：在应用里读，不开浏览器。 */
  function readerPanel() {
    const reader = ui.reader;
    if (!reader) return null;
    const box = mk('div', 'notif-reader');
    const head = mk('div', 'notif-reader-head');
    head.append(mk('span', 'notif-reader-title', reader.title || '正文'));
    head.append(mk('span', 'spacer'));
    const close = mk('button', 'ghost-btn', '关闭');
    close.type = 'button';
    close.addEventListener('click', () => {
      ui.reader = null;
      paint();
    });
    head.appendChild(close);
    box.appendChild(head);

    if (reader.busy) box.appendChild(mk('div', 'notif-hint', '正在抓取正文…'));
    else if (reader.error) box.appendChild(mk('div', 'error-banner', `读不到正文：${reader.error}`));
    else box.appendChild(mk('div', 'notif-reader-text', reader.text || '（这一篇没有可提取的正文）'));

    // 原链接作为备用展示（只展示，不自动打开）
    const foot = mk('div', 'notif-reader-foot');
    foot.appendChild(mk('span', 'notif-hint', '原链接（可复制）：'));
    const code = mk('span', 'notif-link', reader.url);
    foot.appendChild(code);
    box.appendChild(foot);
    return box;
  }

  function row(item) {
    const line = mk('div', 'notif-row');
    if (item.pinned) line.classList.add('is-pinned');

    const main = mk('div', 'notif-main');
    const link = mk('a', 'notif-title', item.title || '(无标题)');
    link.href = item.url;
    // 点了在面板里读，而不是把地址交给系统（见文件头第 2 条）
    link.addEventListener('click', (event) => {
      event.preventDefault();
      void readBody(item);
    });
    main.appendChild(link);

    const meta = mk('div', 'notif-meta');
    meta.appendChild(mk('span', 'notif-site', item.siteLabel ?? item.siteId ?? ''));
    if (item.publishedAt) {
      meta.appendChild(mk('span', 'notif-date', `发布 ${fmtPublished(item.publishedAt)}`));
    } else {
      meta.appendChild(mk('span', 'notif-date notif-date-missing', '校方未给发布日期'));
    }
    if (item.firstSeenAt) meta.appendChild(mk('span', 'notif-seen', `发现 ${fmt(item.firstSeenAt)}`));
    if (item.pinned) meta.appendChild(mk('span', 'notif-flag', '📌 已固定'));
    main.appendChild(meta);

    const actions = mk('div', 'notif-actions');
    const pinBtn = mk('button', 'ghost-btn notif-pin', item.pinned ? '取消固定' : '📌 固定');
    pinBtn.type = 'button';
    pinBtn.disabled = ui.busy.has(item.id);
    pinBtn.title = item.pinned ? '取消固定后，它会重新纳入保留期清理' : '固定后不会因保留期被清理';
    pinBtn.addEventListener('click', () => void togglePin(item));
    actions.appendChild(pinBtn);

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
      box.appendChild(mk('div', 'notif-hint', '试试取消「只看固定」，或换一个站点。'));
    }
    return box;
  }

  function paint() {
    const mount = ui.mount;
    if (!mount) return;
    mount.replaceChildren();

    // 外层只管滚动（`.view-content` 自带 flex:1 / min-height:0 / overflow:auto），
    // 内层只管布局 —— 两者绝不能挤在同一个元素上，见文件头第 1 条。
    const content = mk('div', 'view-content');
    const wrap = mk('div', 'notif-view');

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

    const panel = readerPanel();
    if (panel) wrap.appendChild(panel);

    const list = mk('div', 'notif-list');
    const rows = visible();
    if (!rows.length) list.appendChild(emptyState());
    else for (const item of rows) list.appendChild(row(item));
    wrap.appendChild(list);

    const report = syncReport();
    if (report) wrap.appendChild(report);

    content.appendChild(wrap);
    mount.appendChild(content);
  }

  /* ------------------------------------------------------------ 设置分区 */

  /**
   * 「设置 → 通知」：来源勾选、自定义站点、保留期。
   *
   * 全部**改动即时生效**（不设"保存"按钮）：这三个都是"改一下就想要结果"的开关，
   * 攒着等用户点保存只会多一种"我改了但它没生效"的困惑。
   * 失败时把那一条的 error 显示出来，并**回滚本地草稿**（重新拉一遍服务端状态）。
   */
  const settingsUi = {
    mount: null,
    settings: null,
    sources: [],
    busy: false,
    error: null,
    /** 新增自定义站点的输入框内容（只在保存成功前保留）。 */
    draft: { label: '', url: '' },
  };

  async function loadSettings() {
    settingsUi.busy = true;
    settingsUi.error = null;
    settingsPaint();
    try {
      const [settings, sources] = await Promise.all([
        PC.api('/notifications/settings'),
        PC.api('/notifications/sources'),
      ]);
      settingsUi.settings = settings;
      settingsUi.sources = sources.items ?? [];
    } catch (error) {
      settingsUi.error = error?.message ?? String(error);
    } finally {
      settingsUi.busy = false;
      settingsPaint();
    }
  }

  /** 提交一份设置补丁；失败时重新拉服务端状态（把界面拉回真相，免得显示成"已保存"）。 */
  async function saveSettings(patch, { quiet = false } = {}) {
    settingsUi.busy = true;
    settingsUi.error = null;
    settingsPaint();
    try {
      settingsUi.settings = await PC.api('/notifications/settings', { method: 'POST', body: patch });
      if (!quiet) PC.toast?.('已保存');
    } catch (error) {
      settingsUi.error = error?.message ?? String(error);
      await loadSettings();
      return false;
    } finally {
      settingsUi.busy = false;
    }
    settingsPaint();
    return true;
  }

  function settingsCard(title, hintText) {
    const card = mk('div', 'card');
    const head = mk('div', 'card-head');
    head.appendChild(mk('div', 'card-title', title));
    card.appendChild(head);
    const body = mk('div', 'card-body');
    if (hintText) body.appendChild(mk('div', 'notif-hint', hintText));
    card.appendChild(body);
    return { card, body };
  }

  /** 保留期选择。`0` = 永久保留。 */
  function retentionCard() {
    const { card, body } = settingsCard(
      '保留期',
      '同步时会删掉超出保留期的通知，防止一直占着磁盘。📌 固定的条目永不清理。',
    );
    const row = mk('div', 'notif-setting-row');
    const select = mk('select', 'notif-retention');
    const options = [
      [7, '7 天'],
      [30, '30 天'],
      [90, '90 天（默认）'],
      [180, '180 天'],
      [365, '1 年'],
      [0, '永久保留（不清理）'],
    ];
    for (const [value, text] of options) {
      const option = mk('option', null, text);
      option.value = String(value);
      select.appendChild(option);
    }
    select.value = String(settingsUi.settings?.retentionDays ?? 90);
    select.disabled = settingsUi.busy;
    select.addEventListener('change', () => {
      void saveSettings({ retentionDays: Number(select.value) });
    });
    row.append(mk('span', 'notif-setting-label', '保留最近'), select);
    body.appendChild(row);
    return card;
  }

  /** 来源勾选：内置（含"已知不可用"）+ 自定义。 */
  function sourcesCard() {
    const { card, body } = settingsCard(
      '通知来源',
      '勾上就会在「同步最新」时去抓。标记「已知不可用」的站点仍可勾选，但同步时会跳过并说明原因。',
    );
    const enabled = new Set(settingsUi.settings?.enabledSiteIds ?? []);
    const list = mk('div', 'notif-source-list');
    for (const source of settingsUi.sources) {
      const label = mk('label', 'check-field notif-source-item');
      const box = mk('input', `notif-source-${source.custom ? 'custom' : 'builtin'}`);
      box.type = 'checkbox';
      box.checked = enabled.has(source.id);
      box.disabled = settingsUi.busy;
      box.addEventListener('change', () => {
        const next = new Set(settingsUi.settings?.enabledSiteIds ?? []);
        if (box.checked) next.add(source.id);
        else next.delete(source.id);
        void saveSettings({ enabledSiteIds: [...next] }, { quiet: true });
      });
      label.appendChild(box);
      const text = mk('span', 'notif-source-text');
      text.appendChild(mk('span', 'notif-source-name', source.label));
      text.appendChild(mk('span', 'notif-source-host', source.host || ''));
      if (source.custom) text.appendChild(mk('span', 'notif-badge', '自定义'));
      if (!source.working) {
        const badge = mk('span', 'notif-badge notif-badge-warn', '已知不可用');
        if (source.reason) badge.title = source.reason;
        text.appendChild(badge);
      }
      label.appendChild(text);
      list.appendChild(label);
    }
    body.appendChild(list);
    return card;
  }

  /** 自定义站点：列表 + 新增表单。 */
  function customSourcesCard() {
    const { card, body } = settingsCard(
      '自定义站点',
      '填一个**入口页** URL 就行（比如某个学院的首页），同步时会自动从首页找通知栏目页。',
    );

    const current = settingsUi.settings?.customSources ?? [];
    if (current.length) {
      const list = mk('div', 'notif-custom-list');
      for (const site of current) {
        const line = mk('div', 'notif-custom-row');
        line.appendChild(mk('span', 'notif-custom-name', site.label));
        line.appendChild(mk('span', 'notif-custom-url', site.url));
        const del = mk('button', 'ghost-btn notif-custom-remove', '删除');
        del.type = 'button';
        del.disabled = settingsUi.busy;
        del.addEventListener('click', () => {
          const next = current.filter((item) => item.id !== site.id).map((item) => ({ label: item.label, url: item.url }));
          void saveSettings({ customSources: next });
        });
        line.appendChild(del);
        list.appendChild(line);
      }
      body.appendChild(list);
    } else {
      body.appendChild(mk('div', 'notif-hint', '还没有自定义站点。'));
    }

    const form = mk('div', 'notif-custom-form');
    const nameInput = mk('input', 'notif-custom-label-input');
    nameInput.type = 'text';
    nameInput.placeholder = '站点名称，如「能动学院」';
    nameInput.value = settingsUi.draft.label;
    nameInput.disabled = settingsUi.busy;
    nameInput.addEventListener('input', () => {
      settingsUi.draft.label = nameInput.value;
    });

    const urlInput = mk('input', 'notif-custom-url-input');
    urlInput.type = 'text';
    urlInput.placeholder = '入口页 URL，如 https://epe.xjtu.edu.cn/';
    urlInput.value = settingsUi.draft.url;
    urlInput.disabled = settingsUi.busy;
    urlInput.addEventListener('input', () => {
      settingsUi.draft.url = urlInput.value;
    });

    const add = mk('button', 'primary-btn notif-custom-add', '添加');
    add.type = 'button';
    add.disabled = settingsUi.busy;
    add.addEventListener('click', async () => {
      const label = String(settingsUi.draft.label ?? '').trim();
      const url = String(settingsUi.draft.url ?? '').trim();
      if (!label || !url) {
        settingsUi.error = '站点名称和入口页 URL 都要填';
        settingsPaint();
        return;
      }
      const next = [...current.map((item) => ({ label: item.label, url: item.url })), { label, url }];
      const ok = await saveSettings({ customSources: next });
      if (ok) {
        settingsUi.draft = { label: '', url: '' };
        settingsPaint();
      }
    });

    form.append(nameInput, urlInput, add);
    body.appendChild(form);
    body.appendChild(
      mk('div', 'notif-hint', '不能填内网或本机地址（这是安全限制，防止被当成代理去访问内网服务）。'),
    );
    return card;
  }

  function settingsPaint() {
    const mount = settingsUi.mount;
    if (!mount) return;
    mount.replaceChildren();

    const wrap = mk('div', 'notif-settings');
    if (settingsUi.error) wrap.appendChild(mk('div', 'notif-error', `设置没保存成功：${settingsUi.error}`));
    if (settingsUi.busy) wrap.appendChild(mk('div', 'notif-hint', '正在保存…'));

    if (!settingsUi.settings) {
      wrap.appendChild(mk('div', 'notif-hint', '正在读取通知设置…'));
      mount.appendChild(wrap);
      return;
    }

    wrap.append(retentionCard(), sourcesCard(), customSourcesCard());
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

  // 设置分区：排在「对话设置」(61) 之后 —— 它管的是"通知抓什么、留多久"，与对话无直接关系
  window.PCModules.registerSettingsSection({
    id: 'notifications.settings',
    title: '通知',
    order: 62,
    render(mount) {
      settingsUi.mount = mount;
      settingsPaint();
      void loadSettings();
    },
  });

  // 测试缝：只暴露既有函数，不加任何"测试专用逻辑"
  window.__PC_NOTIF_TEST__ = { ui, paint, visible, load, sync, readBody, fmt, fmtPublished, settingsUi, loadSettings };
})();
