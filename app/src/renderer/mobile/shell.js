/**
 * 手机外壳（`html.m-app` 下接管界面）。
 *
 * 结构：导航栏 + 内容区 + 底部标签栏（今天 / 日历 / AI / 笔记 / 我的）。
 * 只接管**手机**；桌面端根本不加载这段（`detect.js` 没给 html 挂 `m-app` 时直接 return）。
 *
 * 取舍：文档《手机端界面改进方案》说最终要逐页用新组件重建，但那是 5 个阶段的事。
 * 这一版先把**外壳 + 今天 + 我的**做成新的，日历 / 笔记 / 其余模块沿用现有视图，
 * 挂进「通用二级页面」容器（`renderViewInto`）——功能一个都不少，视觉逐页替换。
 *
 * 复用现有视图的做法来自 shell/app.js 的 `renderPanel()`：
 *   view.render({ mount, api, state, toast, refresh })
 * 视图自己会 `mount.innerHTML = ''`，所以传自己的容器即可；`refresh` 也指向自己这份，
 * 否则视图里的"保存后刷新"会去重画那份已经被隐藏的桌面面板。
 */
(function () {
  'use strict';

  // 桌面端根本没有 `m-app`，这一层完全不加载。
  // 这里**必须**防住 `document.documentElement` 不存在的情况：渲染层单测把 index.html 里的
  // 脚本按顺序拼成一个 bundle 在 vm 里跑，那个桩环境没有 documentElement ——
  // 少一个 `?.` 就会抛 "Cannot read properties of undefined (reading 'classList')"，
  // 把整个 bundle 的加载打断，连累所有渲染层用例（实测 calendar-render / notes 整文件 0 通过）。
  const root = document.documentElement;
  if (!root?.classList?.contains?.('m-app')) return;

  /**
   * 外壳启动。
   *
   * **必须等 `window.PC` 就绪**：它在 `shell/app.js` 的 `boot()` 里赋值，而那段跑在
   * `DOMContentLoaded`；本文件是解析期执行的，早于它 —— 直接判断 `window.PC` 会永远为假，
   * 表现就是「html 挂上了 m-app（桌面三栏隐藏了）但外壳没建出来」→ 一片空白。
   *
   * 所以改成"就绪即启动，否则每 50ms 重试，最多 10 秒"。重试不影响别的东西：
   * 没就绪时它什么都不做。
   */
  let started = false;

  function start() {
    if (started) return true;
    const UI = window.PCMobileUI;
    const Logic = window.PCMobileLogic;
    if (!UI || !Logic || !window.PC) return false;
    started = true;

  const { h, icon, cell, section, tag, button, iconButton, iconBadge, emptyState, skeleton, segmented, toggle, setLayerHost, searchField } = UI;

  /* ------------------------------------------------------------ 状态 */

  const TABS = [
    { id: 'today', label: '今天', icon: 'today' },
    { id: 'calendar', label: '日历', icon: 'calendar' },
    { id: 'ai', label: 'AI', icon: 'sparkle' },
    { id: 'notes', label: '笔记', icon: 'note' },
    { id: 'me', label: '我的', icon: 'person' },
  ];

  const state = {
    tab: 'today',
    stack: [],
    viewCache: new Map(),
  };

  /* ------------------------------------------------------------ 骨架 */

  const overlays = h('div', { id: 'm-overlays' });
  document.body.append(overlays);

  const appbarSide = h('div', { class: 'm-appbar-side' });
  const appbarTitle = h('h1', { class: 'm-appbar-title', text: '' });
  const appbarRight = h('div', { class: 'm-appbar-side m-appbar-side--right' });
  const appbar = h('header', { class: 'm-appbar' }, appbarSide, appbarTitle, appbarRight);

  const scroller = h('main', { class: 'm-scroll', id: 'm-scroll' });
  const tabbar = h('nav', { class: 'm-tabbar', role: 'tablist', 'aria-label': '主导航' });
  const shell = h('div', { class: 'm-shell' }, appbar, scroller, tabbar);
  document.body.append(shell);

  // 浮层进返回栈：安卓返回键 / 浏览器后退都能关掉 sheet
  setLayerHost({
    push(entry) {
      history.pushState({ m: 'layer' }, '');
      state.layer = entry;
    },
    close(entry) {
      return new Promise((resolve) => {
        if (state.layer === entry) state.layer = null;
        if (history.state?.m === 'layer') history.back();
        entry?.close?.();
        resolve();
      });
    },
  });

  /* ------------------------------------------------------------ 工具 */

  function today() {
    return Logic.todayKey();
  }

  async function fetchApi(path, options) {
    return window.PC.api(path, options);
  }

  function clearAppbar() {
    appbarSide.replaceChildren();
    appbarRight.replaceChildren();
    appbarTitle.textContent = '';
  }

  function setAppbar({ title = '', back = false, right = null, left = null } = {}) {
    clearAppbar();
    appbarTitle.textContent = title;
    if (back) {
      appbarSide.append(iconButton({ icon: 'back', label: '返回', onClick: () => popPage() }));
    } else if (left) {
      appbarSide.append(left);
    }
    if (right) appbarRight.append(right);
  }

  /* ------------------------------------------------------------ 页面栈 */

  /**
   * 打开二级页面（模块视图、详情）。
   * 二级页面隐藏标签栏：手机上"进到下一层"就不该还能横跳。
   */
  function pushPage({ title, render, right }) {
    state.stack.push({ title, render, right });
    renderStack();
  }

  function popPage() {
    if (!state.stack.length) return;
    state.stack.pop();
    renderStack();
  }

  function renderStack() {
    const top = state.stack[state.stack.length - 1];
    document.documentElement.dataset.stack = top ? '1' : '0';
    if (!top) {
      renderTab();
      return;
    }
    setAppbar({ title: top.title, back: true, right: top.right ?? null });
    scroller.replaceChildren();
    const page = h('div', { class: 'm-page' });
    scroller.append(page);
    top.render(page);
    scroller.scrollTop = 0;
  }

  /**
   * 把现有视图挂进一个容器。
   * `refresh` 指向自己这份：视图内部"保存后刷新"不会去重画那份隐藏的桌面面板。
   */
  function renderViewInto(host, viewId) {
    const view = window.PCModules?.get?.(viewId);
    if (!view) {
      host.append(emptyState({ icon: 'info', title: '这个功能还没有手机版', message: `找不到视图 ${viewId}` }));
      return;
    }
    const ctx = {
      mount: host,
      api: window.PC.api,
      state: window.PC.state,
      toast: window.PC.toast,
      refresh: () => {
        window.PC.state.view = view.id;
        view.render(ctx);
      },
    };
    window.PC.state.view = view.id;
    try {
      view.render(ctx);
    } catch (error) {
      host.replaceChildren(emptyState({ icon: 'info', title: '没能打开', message: error?.message ?? String(error) }));
    }
  }

  /* ------------------------------------------------------------ 今天 */

  async function renderToday(host) {
    const key = today();
    host.append(
      h(
        'div',
        { class: 'm-today-hero' },
        h('p', { class: 'm-today-greeting', text: Logic.greeting() }),
        h('p', { class: 'm-today-date', text: `${Logic.monthTitle(key)} · ${Logic.weekdayLabel(key)}` }),
      ),
    );

    const agenda = h('div');
    const todos = h('div');
    host.append(agenda, todos);
    agenda.append(skeleton(2));
    todos.append(skeleton(3));

    const [cal, upcoming] = await Promise.all([
      fetchApi(`/calendar?from=${key}&to=${key}`).catch(() => null),
      fetchApi('/todos/upcoming?limit=6').catch(() => null),
    ]);

    // ---- 今日日程
    agenda.replaceChildren();
    const day = cal?.days?.[0];
    const items = [...(day?.schedules ?? []), ...(day?.events ?? [])].sort((a, b) =>
      String(a.startTime ?? a.time ?? '').localeCompare(String(b.startTime ?? b.time ?? '')),
    );
    if (!items.length) {
      agenda.append(section({ header: '今日日程', children: [emptyState({ icon: 'calendar', title: '今天没有安排', message: '在日历里新建，或让 AI 帮你排。' })] }));
    } else {
      const list = section({ header: `今日日程 · ${items.length}`, inset: 'wide' });
      for (const item of items) {
        const start = String(item.startTime ?? item.time ?? '').slice(0, 5);
        const end = String(item.endTime ?? '').slice(0, 5);
        list.list.append(
          cell({
            leading: h('span', { class: 'm-agenda-time', text: start || '全天' }),
            title: item.title ?? '未命名',
            subtitle: [end ? `${start}–${end}` : '', item.location ?? ''].filter(Boolean).join(' · '),
            value: item.courseName ?? '',
          }),
        );
      }
      agenda.append(list);
    }

    // ---- 待办
    todos.replaceChildren();
    const rows = upcoming?.items ?? [];
    if (!rows.length) {
      todos.append(section({ header: '待办', children: [emptyState({ icon: 'checkCircle', title: '没有待办', message: '所有事情都清空了。' })] }));
    } else {
      const list = section({
        header: { title: '待办', action: { label: '全部', onClick: () => openModule('todo', '待办') } },
      });
      for (const item of rows) {
        const due = Logic.dueLabel(item.deadline);
        const row = cell({
          leading: iconButton({
            icon: item.completed ? 'checkCircle' : 'circle',
            label: item.completed ? '标记为未完成' : '标记为完成',
            onClick: async (event) => {
              event.stopPropagation();
              await fetchApi(`/todos/${item.id}/completed`, { method: 'POST', body: { completed: !item.completed } });
              window.PC.toast(item.completed ? '已取消完成' : '已完成');
              renderTab({ silent: true });
            },
          }),
          title: item.title,
          subtitle: [due, item.category ?? ''].filter(Boolean).join(' · '),
          meta: item.priority && item.priority !== 'normal' ? tag(item.priority, item.priority === 'high' ? 'red' : 'blue') : null,
          chevron: false,
        });
        list.list.append(UI.swipeable(row, [
          {
            label: item.completed ? '取消' : '完成',
            icon: 'check',
            tone: 'green',
            onSelect: async () => {
              await fetchApi(`/todos/${item.id}/completed`, { method: 'POST', body: { completed: !item.completed } });
              renderTab({ silent: true });
            },
          },
        ]));
      }
      todos.append(list);
    }
  }

  /* ------------------------------------------------------------ 我的 */

  /** 用户名：网页版要问宿主要（`/auth/me`），桌面端没有这个接口就退回本地状态。 */
  const meCache = { asked: false, username: '' };

  async function loadUsername() {
    if (!meCache.asked) {
      meCache.asked = true;
      try {
        const res = await fetch('/auth/me', { credentials: 'same-origin', headers: { accept: 'application/json' } });
        if (res.ok) meCache.username = (await res.json())?.user?.username ?? '';
      } catch {
        // 桌面端（8886 那套）没有 /auth/me：静默退回本地账号
      }
    }
    return meCache.username || window.PC.state.user?.username || '';
  }

  function renderMe(host) {
    const mode = window.PCTheme?.getMode?.() ?? 'light';

    const appearance = section({ header: '外观' });
    appearance.list.append(
      cell({
        title: '主题',
        // 不再同时给 value：右边已经是分段控件，再写一遍"白天"是重复信息
        accessory: segmented({
          size: 'sm',
          items: [
            { value: 'light', label: '白天' },
            { value: 'dark', label: '夜间' },
          ],
          value: mode,
          onChange: (value) => window.PCTheme?.setMode?.(value),
        }),
        chevron: false,
      }),
    );

    const account = section({ header: '账号', footer: '账号只在本服务器有效，和学校统一身份认证是两回事。' });
    account.list.append(
      // 标题先占位，等 `/auth/me` 回来再改文字（不阻塞首屏）
      cell({ leading: iconBadge('person', 'blue'), title: '正在读取…', subtitle: '本服务器账号', chevron: false }),
      cell({ icon: 'globe', tone: 'green', title: '服务器', value: location.host, chevron: false }),
    );
    const nameNode = account.list.querySelector('.m-cell-title');
    loadUsername().then((name) => {
      if (nameNode?.isConnected) nameNode.textContent = name || '本机账号';
    });

    const entries = section({ header: '功能' });
    const modules = window.PCModules?.list?.() ?? [];
    const skip = new Set(['calendar', 'notes', 'chat']); // 前两个是标签页，chat 就是 AI 标签
    for (const view of modules) {
      if (skip.has(view.id)) continue;
      entries.list.append(
        cell({
          icon: view.icon || 'grid',
          tone: 'purple',
          title: view.title ?? view.id,
          onClick: () => openModule(view.id, view.title ?? view.id),
        }),
      );
    }

    const about = section({ header: '关于' });
    about.list.append(
      cell({
        title: '诊断',
        subtitle: '连接状态、接口版本',
        onClick: () =>
          pushPage({
            title: '诊断',
            render: (page) => renderViewInto(page, 'settings'),
          }),
      }),
      cell({ title: '版本', value: '手机外壳 v1' }),
    );

    host.append(appearance, account, entries, about);
  }

  /* ------------------------------------------------------------ 模块页 */

  function openModule(viewId, title) {
    pushPage({
      title: title ?? viewId,
      render: (page) => {
        // 待办有重建过的手机页（iOS 提醒事项形态），优先用它；
        // 其余模块暂时挂现有视图（文档里"未重建前用通用二级页面容器承载"）。
        if (viewId === 'todo' && window.PCMobilePages?.todos) {
          window.PCMobilePages.todos(page, { setAppbar });
          return;
        }
        const wrap = h('div', { class: 'm-view-host' });
        page.append(wrap);
        renderViewInto(wrap, viewId);
      },
    });
  }

  /* ------------------------------------------------------------ 标签 */

  let tabButtons = new Map();

  function buildTabbar() {
    for (const item of TABS) {
      const node = h(
        'button',
        { type: 'button', role: 'tab', class: 'm-tab', dataset: { tab: item.id }, 'aria-label': item.label },
        icon(item.icon, { size: 24 }),
        h('span', { class: 'm-tab-label', text: item.label }),
      );
      node.addEventListener('click', () => go(item.id));
      tabButtons.set(item.id, node);
      tabbar.append(node);
    }
  }

  function paintTabs() {
    for (const [id, node] of tabButtons) {
      const on = id === state.tab;
      node.classList.toggle('is-active', on);
      node.setAttribute('aria-selected', String(on));
    }
  }

  /** 切标签。二级页面栈会被清空（回一级）。 */
  function go(tabId, { push = true } = {}) {
    if (!TABS.some((t) => t.id === tabId)) return;
    state.tab = tabId;
    state.stack.length = 0;
    document.documentElement.dataset.tab = tabId;
    paintTabs();
    if (push && history.state?.m !== 'tab') history.pushState({ m: 'tab', tab: tabId }, '', `#${tabId}`);
    renderTab();
  }

  function renderTab({ silent = false } = {}) {
    const tab = state.tab;
    document.documentElement.dataset.stack = '0';

    // AI 标签：交回桌面那套对话列（它自己就是完整的一屏），不重复造一份输入区
    if (tab === 'ai') {
      scroller.replaceChildren();
      clearAppbar();
      window.PC.openView?.('chat');
      window.PC.state.view = 'chat';
      return;
    }

    if (tab === 'calendar' || tab === 'notes') {
      setAppbar({ title: tab === 'calendar' ? '日历' : '笔记' });
      scroller.replaceChildren();
      const page = h('div', { class: 'm-page m-scroll--flush' });
      scroller.append(page);
      // 日历已经按 iOS 系统日历重建；笔记与其余模块仍是挂现有视图
      if (tab === 'calendar' && window.PCMobilePages?.calendar) {
        window.PCMobilePages.calendar(page, { setAppbar });
      } else {
        renderViewInto(page, tab);
      }
      if (!silent) scroller.scrollTop = 0;
      return;
    }

    if (tab === 'today') {
      setAppbar({ title: '今天' });
      scroller.replaceChildren();
      const page = h('div', { class: 'm-page' });
      scroller.append(page);
      renderToday(page).catch((error) => {
        page.replaceChildren(UI.errorState({ message: error?.message, onRetry: () => renderTab() }));
      });
      if (!silent) scroller.scrollTop = 0;
      return;
    }

    setAppbar({ title: '我的' });
    scroller.replaceChildren();
    const page = h('div', { class: 'm-page' });
    scroller.append(page);
    renderMe(page);
    if (!silent) scroller.scrollTop = 0;
  }

  /* ------------------------------------------------------------ 返回栈 */

  window.addEventListener('popstate', () => {
    if (state.layer) {
      const entry = state.layer;
      state.layer = null;
      entry.close?.();
      return;
    }
    if (state.stack.length) {
      popPage();
      return;
    }
    const tab = history.state?.tab;
    if (tab && tab !== state.tab) go(tab, { push: false });
  });

  // 滚动到一定程度给导航栏加分隔线（大标题收起时才有边界感）
  scroller.addEventListener('scroll', () => {
    appbar.classList.toggle('is-scrolled', scroller.scrollTop > 4);
  }, { passive: true });

  /* ------------------------------------------------------------ 启动 */

  buildTabbar();
  // 初始落点：**「今天」是手机首页**。
  // 注意不能直接用 `parseRoute()` 的结果：桌面外壳启动时会把 hash 写成 `#chat`，
  // 而 `#chat` 在手机侧映射到「AI」标签 —— 于是每次冷启动都停在对话页。
  // 只有用户明确指定了其它位置（`#calendar` / `#notes` / `?view=…`）才跟着走。
  const rawHash = decodeURIComponent(String(location.hash || '').replace(/^#/, '')).trim();
  const route = Logic.parseRoute(location.search, location.hash, (id) => Boolean(window.PCModules?.get?.(id)));
  const initial = !rawHash || rawHash === 'chat' ? 'today' : (route.tab ?? 'today');
  go(initial, { push: false });

  // 桌面外壳切视图时同步高亮（用户可能在 AI 标签里点了别处）
  const originalOpenView = window.PC.openView;
  if (typeof originalOpenView === 'function') {
    window.PC.openView = function patched(viewId) {
      const mapped = Logic.TAB_OF_MODULE?.[viewId];
      if (mapped && mapped !== state.tab) go(mapped, { push: false });
      return originalOpenView.call(window.PC, viewId);
    };
  }

    return true;
  }

  /* ---------------------------------------------------------- 接上外壳 */

  let tries = 0;
  const kick = () => {
    if (start()) return;
    if (tries++ > 200) return; // 10 秒还没就绪就放弃（正常情况下几十毫秒）
    setTimeout(kick, 50);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', kick, { once: true });
  } else {
    kick();
  }
})();
