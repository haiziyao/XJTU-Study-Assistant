/**
 * 应用外壳（classic script，无框架、无构建步骤）。
 *
 * 布局：左侧功能栏（约 10% 宽） / 中间对话面板 / 右侧功能视图。
 *  - 左侧功能栏**由视图注册表生成**（各 views/<id>.js 自行登记，见 kit/registry.js），
 *    本文件不认识任何具体功能，新增功能不需要改这里；
 *  - 中间对话面板：**配了 AI 密钥就走 `/ai/chat`（流式气泡 + 草稿确认卡）**，
 *    没配就退回 `/commands/run` 的本地规则解析 —— 两条路的落库都是 `/commands/execute`，
 *    所以「模型加的」和「规则加的」在落库与审计上没有区别；
 *  - 右侧可收起：收起后中间面板变宽，周视图不可用（宽度不足）。
 *
 * 全局约定：window.PC = { state, api, refresh, toast, openEditor } 供各视图使用。
 */

(function () {
  'use strict';

  const U = window.PCUtil;
  const Modules = window.PCModules;
  /** 左栏布局的纯逻辑（排序合并 / 拖动落点 / 点击状态机），见 shell/sidebar-layout.js。 */
  const SidebarLayout = window.PCSidebarLayout;

  const EXAMPLES = [
    '添加日程 明天 15:00-16:00 项目周会 提前10分钟提醒',
    '添加日程 每周一 9点半 英语晨读',
    '添加日历事件 2025-10-20 到 2025-10-22 期中考试',
    '查询本周日程',
    '完成今天的学习',
    // 「顺延」只对待办成立（日程没有完成态，也没有顺延这回事）
    '顺延未完成的待办到本周',
    // 待办是独立实体，示例里给一条，让用户/AI 一眼看到正确写法
    '添加待办 明天 交实验报告 预计2小时',
  ];

  /**
   * `/com`（等价 `/compact`）：**用户指令**，立刻压缩上下文。
   *
   * 为什么不把它发给模型：这是给程序看的命令，不是给模型看的话。发上去只会污染对话
   * （模型可能学着在回复里也写一句“/com”），而且要花钱；所以命中后**根本不发请求**，
   * 由前端直接调 `POST /ai/conversations/:id/compact`，服务端也只对"摘要提示词"负责。
   * 大小写不敏感；`/com` 后面跟的参数一律忽略（写成 `/compact` 也一样）。
   */
  const COMPACT_COMMAND = /^\/(?:com|compact)(?:\s|$)/i;

  /** 官方支持的图片格式（其余一律当普通文件，别硬塞给上游）。 */
  const VISION_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];

  const FIELD_LABEL = {
    title: '标题',
    date: '日期',
    startTime: '开始',
    endTime: '结束',
    allDay: '全天',
    category: '分类',
    priority: '优先级',
    estimatedMinutes: '预计时长',
    // 待办存的是 estimatedHours（接口收 estimatedMinutes，落库前换算），两个都要有中文名
    estimatedHours: '预计时长',
    deadline: '截止',
    tags: '标签',
    location: '地点',
    description: '备注',
    startDate: '开始日期',
    endDate: '结束日期',
    weekStart: '周一',
    status: '状态',
    completed: '标记完成',
    keyword: '关键词',
    from: '起',
    to: '止',
    id: '记录',
  };
  const REPEAT_LABEL = {
    none: '不重复',
    daily: '每天',
    weekly: '每周',
    monthly: '每月',
    yearly: '每年',
    weekday: '每个工作日',
  };
  /** 确认卡里不展示的内部字段：它们是管线用的，来源已经在置信度那行写了。 */
  const INTERNAL_FIELD_KEYS = new Set(['source', 'externalId', 'createdAt', 'updatedAt', 'completedAt']);

  const state = {
    apiBase: null,
    wsUrl: null,
    socket: null,
    info: null,
    ai: { available: false, provider: null, contractVersion: null, draw: null },
    /** 当前 AI 会话 id；`null` = 下一条消息开新会话（设置页的「新对话」会把它清空）。 */
    conversationId: null,
    /** 正在流式接收的那条回复：`{ messageId, conversationId, text, node, done, stopped }`，供 WebSocket 增量更新。 */
    streaming: null,
    /**
     * **排队中的消息（只在内存里，切换会话即清空）**：`{ id, seq, text, files }`。
     *
     * 为什么需要它：同一会话服务端是**串行**的（后到的请求会一直挂着、轮到它才返回）。
     * 发送时不排队而是直接再发一条，屏幕上会同时出现"上一轮还在写、下一轮已经在转圈"，
     * 而且用户想改主意时已经没有退路（HTTP 已经出去了，撤不回来）。
     * 排在本地则把"什么时候发"留在用户手里：随时点 × 撤掉，且到达服务端的顺序由我们决定。
     */
    queue: [],
    /** 入队序号的计数器：只在清空队列时归零（见 clearQueue）。 */
    queueSeq: 0,
    /**
     * 当前这一轮的运行态：`{ token, ai, conversationId, text }`；`null` = 空闲（下一条可以直接发）。
     * **排队、停止按钮、清单卡的收尾都以它为准** —— 不另设第二套"忙不忙"的判断。
     */
    round: null,
    /**
     * 被"切换会话"作废、但 HTTP 还没回来的旧回合：`{ token, conversationId }`。
     * 它回来时如果用户已经切回那个会话，就把落库后的消息补画一遍（见 finishRound）。
     */
    orphan: null,
    /** 当前这一轮的过程清单卡：`{ messageId, card, setSteps, bubble }`；同一 messageId 只维护一张。 */
    plan: null,
    /**
     * 用户已经点了停止、但还没拿到会话 id（首条消息刚发出、第一片增量还没到）。
     * 此时不能直接报错：先记下意图，delta 一到（它带着 conversationId）立刻补发停止请求。
     */
    stopWanted: false,
    /** 思考强度：none / low / high / max（官方 reasoning_effort 的合法取值）。默认 high（官方默认）。 */
    thinking: 'high',
    /** 正在流式接收的思维链节点（思考模式才有）。 */
    reasoningNode: null,
    /**
     * 写入权限：auto 自动审批 / manual 手动审批 / strict 全部确认。
     * 启动时会从 localStorage 读回（见 readStored），否则每次刷新都悄悄回落到「手动审批」，
     * 用户会以为"范围授权"没生效。
     */
    permission: 'manual',
    /**
     * 联网搜索通道：off 不联网 / web 从校外网搜索 / campus 从校内网搜索。
     *
     * **真的会联网**（见 modules/ai/web-search.js：有 key 走 API，没 key 解析结果页；
     * campus 会收窄到 *.xjtu.edu.cn，探测到校内可达时并走公网）。
     * 档位随每条消息发给后端，由服务端决定这轮要不要出网 —— 关掉时后端会明确告诉模型
     * "联网已关闭"，模型据此如实回答，而不是假装搜过。要持久化：选"校内网"的人不想每次重开重选。
     */
    search: 'off',
    /** 待发送的附件（只活在内存里；发送后只在消息上留元信息）。 */
    attachments: [],
    /** 模型选择器缓存的列表。 */
    models: null,
    health: null,
    /**
     * 当前**视图** id。默认 `'calendar'`。
     *
     * ⚠️ 这个默认值**是桌面端的行为**（打开就显示日历面板），刻意保持原样不动 ——
     * "桌面端一点都不能变"是硬要求，把默认视图换成对话中枢会改掉每天的打开体验。
     *
     * 手机端"打开就能用"= 一进来就是聊天框，那件事**不走这个字段**，而是由
     * `mobileScreen` 表达（见下）：窄屏下「视图」与「当前给哪一屏」是两个正交的概念 ——
     * 窄屏可以"视图=日历、屏幕=聊天"（刚打开时的默认态），宽屏则两者总是一致。
     */
    view: new URLSearchParams(location.search).get('view') ?? 'calendar',
    /**
     * **窄屏（≤760px）当前显示哪一屏**：`'chat'` | `'panel'`。
     *
     * 为什么要有它：宽屏三栏本身就能同时显示"对话 + 功能页"，窄屏一次只能给一屏，
     * 于是需要一个"现在给哪一屏"的开关。它**不是第二套状态源** ——
     *   - 点击导航 → selectView() 同时写 state.view 与这里（hash 也跟着走）；
     *   - 刷新 / 从别处跳回 → 由 `?view=` 或 `location.hash` 还原；
     * 两边始终由 `setMobileScreen()` 这一个函数负责落地，不存在"谁说了算"的问题。
     */
    mobileScreen: null,
    panelCollapsed: false,
    calendar: { mode: 'month', anchor: U.todayKey() },
    todo: { filter: 'all' },
  };

  /** DOM 引用缓存：在 boot() 里一次性填充（因此必须是 let，不能是 const）。 */
  let dom = {};

  /**
   * 当前生效的左栏布局：`{ main: [id…], more: [id…], bottom: [id…] }`。
   * 由 `buildNav()` 从「存下来的偏好」+「注册表」合并出来；「更多」弹层与高亮都读它。
   */
  let navLayout = { main: [], more: [], bottom: [] };

  /**
   * 窄屏断点，与 `shell.css` 里 `@media (max-width: 760px)` **必须一致**。
   *
   * 两边各写一份是无奈之举：CSS 的媒体查询条件 JavaScript 读不到，而"要不要给
   * iOS 自动聚焦"这类行为又必须在 JS 里判断。改断点时两处一起改。
   */
  const MOBILE_QUERY = '(max-width: 760px)';

  /** 当前是不是窄屏（真实的 matchMedia 结果，不缓存：窗口可拖宽、手机可横竖屏切换）。 */
  function isMobile() {
    return window.matchMedia(MOBILE_QUERY).matches;
  }

  /* ------------------------------------------------------------ 基础工具 */

  function mk(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function toast(text) {
    if (!text) return;
    const node = dom.toast;
    node.textContent = text;
    node.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => node.classList.remove('show'), 2800);
  }

  async function api(path, options = {}) {
    const response = await fetch(`${state.apiBase}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload?.error?.message ?? `请求失败 (${response.status})`);
      error.payload = payload;
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function refresh() {
    renderPanel();
  }

  /* ------------------------------------------------------------ 左侧功能栏 */
  // 功能栏完全由视图注册表生成：各 views/<id>.js 自行登记，外壳不认识任何具体功能。

  /**
   * 左栏图标：外壳侧统一把视图登记的「名字 / emoji」映射成内联 SVG（见 shell/icons.js）。
   * 未登记的图标原样回退成文本，保证不认识图标表的视图行为不变。
   */
  function navIcon(icon) {
    const node = mk('span', 'nav-icon');
    const svg = window.PCIcons?.svg?.(icon, 20);
    if (svg) node.innerHTML = svg;
    else node.textContent = String(icon ?? '');
    return node;
  }

  function navButton(item) {
    const button = mk('button', `nav-item${state.view === item.id ? ' active' : ''}`);
    button.type = 'button';
    button.dataset.view = item.id;
    button.append(navIcon(item.icon), mk('span', 'nav-label', item.label));
    button.addEventListener('click', () => onNavClick(item.id));
    return button;
  }

  /**
   * 按用户布局重排左栏。
   *
   * 布局本身（哪些常驻、哪些收进「更多」、什么顺序）由 `PCSidebarLayout.resolve()`
   * 从「存下来的偏好」+「当前注册表」合并出来 —— 这里只负责把结果摆进 DOM。
   * 每次重排都整份重建：条目只有十来个，重建比做差量简单得多，也不会留下旧节点。
   */
  function buildNav() {
    navLayout = SidebarLayout.resolve(parseStoredLayout(), Modules.list());
    dom.nav.replaceChildren();
    dom.navBottom.replaceChildren();
    for (const id of navLayout.main) {
      const view = Modules.get(id);
      if (view) dom.nav.appendChild(navButton(view));
    }
    for (const id of navLayout.bottom) {
      const view = Modules.get(id);
      if (view) dom.navBottom.appendChild(navButton(view));
    }
    // 「更多」只在真有收起项时出现：空的时候留一个点开什么都没有的按钮只会让人困惑
    if (dom.navMore) {
      dom.navMore.hidden = navLayout.more.length === 0;
      if (!dom.navMore.dataset.wired) {
        dom.navMore.dataset.wired = '1';
        dom.navMore.append(navIcon('⋯'), mk('span', 'nav-label', '更多'));
        dom.navMore.addEventListener('click', (event) => {
          event.stopPropagation();
          toggleMorePop();
        });
      }
    }
    if (navLayout.more.length === 0) closeMorePop();
    syncNavActive();
  }

  /** 读存下来的布局（坏数据/读不到都返回 null，`resolve()` 会退回默认）。 */
  function parseStoredLayout() {
    return SidebarLayout.parse(readStored(SidebarLayout.STORAGE_KEY));
  }

  /**
   * 高亮的**唯一出口** —— 宽屏与窄屏、点导航与点收起按钮，全都走这里。
   *
   * 不变式只有一条：`高亮 ⇔ (那一项正在被看见)`。宽屏看的是"面板展开且 view 命中"，
   * 窄屏看的是"当前这一屏是功能页且 view 命中"，两种判断都在
   * `PCSidebarLayout.isNavActive()` 里，这里不再自己算一遍 ——
   * 以前宽屏与窄屏各写一个循环，任何一处漏改就会出现"高亮在日历、面板还是待办"。
   */
  function syncNavActive() {
    for (const button of document.querySelectorAll('.nav-item')) {
      const id = button.dataset.view;
      if (!id) continue; // 「更多」按钮没有 dataset.view，它的高亮单独算
      button.classList.toggle(
        'active',
        SidebarLayout.isNavActive({
          mobile: isMobile(),
          screen: state.mobileScreen,
          collapsed: state.panelCollapsed,
          view: state.view,
          id,
        }),
      );
    }
    // 「更多」自身：宽屏上面板展开、且当前视图正落在收起区里时点亮
    if (dom.navMore) {
      const active = !isMobile() && !state.panelCollapsed && navLayout.more.includes(state.view);
      dom.navMore.classList.toggle('active', active);
    }
  }

  /**
   * 点左栏一项之后该发生什么。
   *
   * 判断全在 `PCSidebarLayout.resolveNavClick()`（纯函数、有单测），这里只执行结果：
   *   · 点的是**已高亮**的那一项 → 收起面板，且**不重画**（内容留在 DOM 里，展开时立刻回来）；
   *   · 其余情况 → 切到被点的项并展开。
   *
   * `state.view` 在收起时**不清空**，所以再展开还是同一个功能。
   */
  function onNavClick(id) {
    closeMorePop();
    if (isMobile()) {
      // 窄屏没有"收起面板"这回事（面板就是当前整屏），语义保持"切到那一屏"
      selectView(id);
      return;
    }
    const next = SidebarLayout.resolveNavClick({
      collapsed: state.panelCollapsed,
      view: state.view,
      clicked: id,
    });
    state.view = next.view;
    if (id !== 'notes') document.body.classList.remove('notes-focus');
    // 显隐一律走 setPanelCollapsed（它负责状态、body 类、按钮外观、高亮四件事）；
    // `render: false` 表示"重画与否由下面按状态机的结论决定"，别让它替我们多画一次。
    setPanelCollapsed(next.collapsed, { render: false });
    // 收起时不重画：内容留在 DOM 里，再展开就是原样（要求 10 与"不要重复动画"）
    if (next.render) renderPanel({ keepScroll: false });
  }

  /** 面板收起按钮的外观：文字方向与 title 一起改，别让它们各说各话。 */
  function syncPanelToggle() {
    if (!dom.panelToggle) return;
    dom.panelToggle.textContent = state.panelCollapsed ? '⟨' : '⟩';
    dom.panelToggle.title = state.panelCollapsed ? '展开右侧视图' : '收起右侧视图';
  }

  /**
   * 面板显隐的唯一出口：状态 → body 类 → 按钮外观 → 导航高亮，一次改完。
   *
   * 为什么必须合成一个函数：这四件事本来就是同一个状态的不同投影，
   * 分散在事件回调里写，漏一处就会出现"面板收起来了、图标还亮着"这种鬼状态。
   */
  function setPanelCollapsed(collapsed, options = {}) {
    if (isMobile()) return; // 窄屏忽略这个状态，否则会出现"聊天列被隐藏、面板又被收起"的死局
    const was = state.panelCollapsed;
    state.panelCollapsed = Boolean(collapsed);
    document.body.classList.toggle('panel-collapsed', state.panelCollapsed);
    syncPanelToggle();
    syncNavActive();
    if (was && !state.panelCollapsed && options.render !== false) renderPanel();
  }

  /* ------------------------------------------------------------ 「更多」弹层 */

  /**
   * 展开/收起「更多」。
   *
   * 每次打开都**重建**列表（而不是建一次改显隐）：收起区的内容会随自定义随时变，
   * 重建能让高亮天然跟着 `state.view` 走，不必再写一套增量更新。
   */
  function toggleMorePop() {
    if (dom.navMorePop && !dom.navMorePop.hidden) {
      closeMorePop();
      return;
    }
    openMorePop();
  }

  function openMorePop() {
    if (!dom.navMorePop || !navLayout.more.length) return;
    dom.navMorePop.replaceChildren();
    for (const id of navLayout.more) {
      const view = Modules.get(id);
      if (view) dom.navMorePop.appendChild(navButton(view));
    }
    dom.navMorePop.hidden = false;
    // 弹层是后建的，高亮要按当前状态补一次
    syncNavActive();
    // 点弹层之外的任何地方都该关掉它。用 capture 阶段：外层的按钮可能在冒泡阶段
    // stopPropagation，等到冒泡就来不及了（会表现为"点别处关不掉"）。
    document.addEventListener('click', onDocumentClickCloseMore, true);
    document.addEventListener('keydown', onMorePopKeydown);
  }

  function closeMorePop() {
    if (!dom.navMorePop || dom.navMorePop.hidden) return;
    dom.navMorePop.hidden = true;
    dom.navMorePop.replaceChildren();
    document.removeEventListener('click', onDocumentClickCloseMore, true);
    document.removeEventListener('keydown', onMorePopKeydown);
  }

  /** 点弹层内部不关（按钮自己的 click 会先切换视图再关），点外面才关。 */
  function onDocumentClickCloseMore(event) {
    if (dom.navMorePop?.contains?.(event.target)) return;
    if (dom.navMore === event.target || dom.navMore?.contains?.(event.target)) return;
    closeMorePop();
  }

  function onMorePopKeydown(event) {
    if (event.key === 'Escape') closeMorePop();
  }

  /**
   * 把左栏布局开放给「设置 → 侧边栏」（`shell/sidebar-customize.js`）。
   *
   * 在**模块作用域**就登记，而不是等 `boot()`：设置页与它的存在与否不该依赖启动时机，
   * 而且测试里 `boot()` 是刻意不跑的（`readyState === 'loading'`），
   * 放在 boot 里就等于这个契约永远没人测。
   * 这里只碰 `navLayout` 与存储；`buildNav()` 要到用户真的改布局时才会用到 `dom`，
   * 那时候早就启动完了。
   */
  function registerSidebarService() {
    Modules.service('sidebar', {
      /** 当前生效的布局快照（只读副本，调用方改它不影响外壳）。 */
      getLayout: () => ({ main: [...navLayout.main], more: [...navLayout.more], bottom: [...navLayout.bottom] }),
      /** 可拖动的那部分（不含 bottom），自定义面板用它渲染行。 */
      getMovable: () => [...navLayout.main, ...navLayout.more],
      /** 存一份新布局并立刻重排左栏。 */
      apply: (next) => {
        writeStored(SidebarLayout.STORAGE_KEY, SidebarLayout.stringify(next));
        buildNav();
      },
      /** 清掉偏好，回到默认布局。 */
      reset: () => {
        writeStored(SidebarLayout.STORAGE_KEY, '');
        buildNav();
      },
      /** 视图的 label/icon：自定义面板要按 id 画出与左栏一致的一行。 */
      describe: (id) => {
        const view = Modules.get(id);
        return view ? { id, label: view.label, icon: view.icon } : null;
      },
    });
  }

  /**
   * 「点导航」这件事在桌面端的处理见下面的 `selectView`（窄屏/宽屏共用同一个入口，
   * 宽屏分支与改动前逐行一致：写 state.view → 换高亮 → 重画面板）。
   */

  /**
   * 重画右侧视图。
   *
   * @param {{ keepScroll?: boolean }} [options] 默认**保住**滚动位置：同一视图的重画
   *   （折叠、拉数据、`data_changed` 广播）不该把用户弹回顶部；切换视图时传 `false`。
   */
  function renderPanel(options = {}) {
    // 保住位置：默认行为。视图内部还会自己保一次（lms / academic 的 paint），
    // 两层都按选择器记账、结果一致，叠在一起是幂等的。
    const keep = options.keepScroll === false ? (fn) => fn() : window.PC?.keepScroll ?? ((fn) => fn());
    keep(() => {
      const view = Modules.get(state.view) ?? Modules.list()[0];
      if (!view) {
        dom.panelTitle.textContent = '无可用视图';
        dom.panelBody.innerHTML = '';
        return;
      }
      state.view = view.id;
      dom.panelTitle.textContent = view.title;
      view.render({ mount: dom.panelBody, api, state, toast, refresh });
    });
  }

  /**
   * 按选择器记下滚动位置，返回一个"还回去"的函数。
   *
   * 为什么按选择器记账：视图重画是 `mount.innerHTML = ''` 整体重建，**旧节点已经不在文档里**，
   * 拿着旧节点写 `scrollTop` 只会改一个孤儿；只有重建后再按选择器查一次，才能拿到新节点。
   * 覆盖两处：右侧视图的滚动容器 `.view-content`，以及中间对话列表 `.chat-log`
   * （重画对话不该把正在看的那条顶走）。元素不存在就跳过 —— 视图结构本来就不保证有这两层。
   */
  function snapshotScroll() {
    // 记的是**选择器 + 位置**，不是节点：视图重画会把旧节点整个丢掉（`mount.innerHTML = ''`），
    // 拿旧节点写 `scrollTop` 只会改一个已经不在文档里的孤儿 —— 表现出来就是"照样弹回顶部"。
    const saved = [];
    for (const selector of ['#panel-body .view-content', '#panel-body .chat-log']) {
      const node = document.querySelector(selector);
      if (node && node.scrollTop) saved.push({ selector, top: node.scrollTop });
    }
    if (!saved.length) return () => {};
    let restored = false;
    const apply = () => {
      for (const item of saved) {
        const node = document.querySelector(item.selector);
        if (node) node.scrollTop = item.top;
      }
    };
    return () => {
      // 嵌套调用（renderPanel 一层、视图自己的 paint 一层）只还原一次就够了，
      // 两层都按选择器查新节点、写的也是同一个值，重复执行只是白干活
      if (restored) return;
      restored = true;
      apply();
      // ⚠️ 新内容刚挂上时可能**还没完成布局**：这时 scrollHeight 仍是 0，写进去的 scrollTop 会被
      // 夹成 0，之后就再也回不来了（实测就是这个原因导致"照样跳回顶部"）。下一帧再写一次即可 ——
      // 用户看不到这一帧的差别，位置却能稳稳留住。
      requestAnimationFrame(apply);
    };
  }

  /** `snapshotScroll()` + `fn()` + 还原，给调用方一行搞定。 */
  function keepScroll(fn) {
    const restore = snapshotScroll();
    try {
      return fn();
    } finally {
      restore();
    }
  }

  /**
   * 面板上的 `⟩/⟨` 按钮：展开/收起。
   *
   * 收起时**不重画** —— 视图内容留在 DOM 里被 CSS 隐藏，再展开就是原样，
   * 既没有多余的加载闪烁，也保证了"和收回之前打开的是同一个功能"。
   * 只有从收起状态**展开**时才重画一次（`setPanelCollapsed` 内部判断 `was`）。
   */
  function togglePanel() {
    // 窄屏没有"收起面板"这回事：面板就是当前那一整屏，收起等于把屏幕变空。
    // 按钮本身已经在 CSS 里隐藏，这里再挡一次 —— 免得将来有人用脚本调它。
    if (isMobile()) return;
    const collapsing = !state.panelCollapsed;
    if (collapsing && state.view === 'calendar' && state.calendar.mode === 'week') {
      state.calendar.mode = 'month';
      toast('周视图需要展开右侧视图，已切回月视图');
    }
    setPanelCollapsed(collapsing);
  }

  /* ------------------------------------------------------ 窄屏（手机）布局 */

  /*
   * 手机端的显隐关系由两个 body 类表达，别无它法：
   *   body.mobile-chat   显示中间那一大屏 = 聊天框（默认）
   *   body.mobile-panel  显示整屏功能页（`.panel` 吃满内容区，聊天列 display:none）
   * 两个类只在 `@media (max-width: 760px)` 里有定义，所以宽屏上加了也没有任何效果，
   * 桌面端的 DOM 与像素都不受影响（这是硬要求）。
   *
   * 为什么改的是 body 类而不是给 `.app` 挂 `data-screen`：
   * 仓库既有约定就是 `body.panel-collapsed` / `body.notes-focus` 这一套，
   * 沿用同一种写法，读代码的人不用在两套切换机制之间来回对照。
   */

  /** 左侧导航里「对话」是第一个栏目；点它 = 回聊天屏。 */
  const CHAT_VIEW = 'chat';

  /* ------------------------------------------------------ 窄屏（手机）状态机 */

  /** 窄屏当前屏的取值（与 `body.mobile-*` 类名一一对应）。 */
  const SCREEN_CHAT = 'chat';
  const SCREEN_PANEL = 'panel';

  /**
   * 是不是"看功能页"的那些视图。
   *
   * 只有一个例外：`chat` 这一项本身在窄屏代表**聊天屏**，不是"对话中枢"功能页 ——
   * 手机上用户点「对话」想要的是那个能打字的聊天框，而不是一张对话管理列表。
   */
  function screenFor(view) {
    return view === CHAT_VIEW ? SCREEN_CHAT : SCREEN_PANEL;
  }

  /**
   * **唯一**落地"现在显示哪一屏"的函数。
   *
   * @param {'chat'|'panel'} screen
   * @param {{ render?: boolean, syncHash?: boolean }} [options]
   *   `render` 默认 true：**只在 `screen === 'panel'` 时有意义** —— 切到/停在功能页时重画一次面板。
   *   `syncHash` 默认 true：把当前屏写进 `location.hash`；还原 hash 时传 false（否则自己触发一次 hashchange）。
   *
   * ⚠️ `screen === 'chat'` 时**一律不重画面板**：聊天列的内容与「右侧视图」无关，
   * 重画只会白拉一次数据、白冒一次错（手机上那一屏根本看不见）。
   * 反过来，只要屏幕是功能页就重画一次 —— 代价由 `snapshotScroll()` 兜住，
   * 换来的是"内容一定是最新的"，比抠掉一次重画划算。
   */
  function setMobileScreen(screen, options = {}) {
    const next = screen === SCREEN_PANEL ? SCREEN_PANEL : SCREEN_CHAT;
    state.mobileScreen = next;
    if (options.syncHash !== false) syncHashForScreen(next);
    applyLayoutMode();
    // 顺序要紧：先挂类（`ensureBackButton` 靠 `mobile-panel` 判断该不该建），
    // 再补返回按钮 —— 否则功能页第一次显示时顶上会少一条退路。
    ensureBackButton();
    if (next !== SCREEN_PANEL || options.render === false) return;
    // 与桌面端"主动切视图要回到顶部"同理：手机上是换了一整屏，沿用上一屏的滚动位置会停在半空。
    renderPanel({ keepScroll: false });
  }

  /** 把当前屏写成 `#chat` / `#<view>`，让刷新和分享链接回到同一屏。 */
  function syncHashForScreen(screen) {
    const id = screen === SCREEN_CHAT ? CHAT_VIEW : state.view;
    const next = `#${encodeURIComponent(id)}`;
    if (location.hash === next) return;
    // replace 而不是赋值：手机上点导航很频繁，赋值会往历史里塞一串栈，
    // 用户按"后退"要按十几次才出得去。这里只需要"刷新时能看到"。
    try {
      location.replace(next);
    } catch {
      /* 某些壳里不允许改地址：退化成不持久化，不影响功能 */
    }
  }

  /** 读 `location.hash` 得到视图 id（`#chat` / `#calendar`；空或非法返回 null）。 */
  function readHashView() {
    const raw = location.hash.replace(/^#/, '').trim();
    return raw ? decodeURIComponent(raw) : null;
  }

  /**
   * 导航到某个视图。这就是"点导航"的全部语义，桌面端与窄屏共用。
   *
   * 为什么把三件事写在一个函数里：状态（state.view）、导航高亮、面板内容，
   * 加上窄屏的"切到哪一屏"与 hash 持久化 —— 它们本来就该同步变化。
   * 分散在事件监听里写，只要漏一处就会出现"高亮在日历、面板还是待办"这种鬼状态。
   *
   * ⚠️ 与 `onNavClick()` 的分工：那个是"用户点了左栏图标"（可能是**收起**面板），
   * 这个是"程序要求切到某个视图"（`PC.openView`、hash、返回按钮），语义是**一定展开**。
   * 高亮不在这里自己算，统一交给 `syncNavActive()`。
   */
  function selectView(view) {
    state.view = view;
    if (view !== 'notes') document.body.classList.remove('notes-focus');
    // 主动切视图 = 一定展开面板（收起态下点「学业」里的跳转按钮，不该跳进一个看不见的面板）
    setPanelCollapsed(false, { render: false });
    syncNavActive();
    // 主动切视图要回到顶部：新视图是"新的一页"，沿用上一个视图的滚动位置会停在半空中。
    // 这与「重画保住位置」是两回事，所以走参数而不是复制一份 renderPanel。
    // ⚠️ 顺序要紧：窄屏要先决定"给不给功能页"，否则点「对话」会白白重画一次面板
    // （手机上那一屏根本看不见，纯浪费）。
    if (!isMobile()) {
      renderPanel({ keepScroll: false });
      return;
    }
    // 窄屏「视图=日历、屏幕=聊天」是合法组合（刚打开就是这样）：这时**不重画**面板 ——
    // 看不见的那一屏不需要内容，重画只会白拉一次数据、白冒一次错。
    // `setMobileScreen` 内部会对"屏幕=功能页"重画，所以这里判断一次就够了。
    setMobileScreen(screenFor(view), { render: state.mobileScreen === SCREEN_PANEL || screenFor(view) === SCREEN_PANEL });
  }

  /**
   * 窄屏的导航入口：`http://<手机>:8886/app/#calendar`。
   *
   * 手机浏览器刷新后 `location.search` 还在，但用户点过导航之后 `state.view` 只活在内存里，
   * 刷新就丢。所以每次切屏都写 hash，刷新时优先读 hash、其次读 `?view=`，都没有才回聊天屏。
   */
  function applyHashView() {
    const id = readHashView();
    const view = id && Modules.has(id) ? id : CHAT_VIEW;
    selectView(view);
  }

  /**
   * 挂上 `body.mobile-*` 类与 `data-screen`，并保证"没有 hash 时至少有 #chat"。
   *
   * `data-screen` 与 body 类是同一次赋值的两个出口：
   *   - CSS 用 `body.mobile-chat` / `body.mobile-panel` 控制哪一栏可见；
   *   - JS 用 `dataset.screen` 判断"当前这一屏是不是功能页"（比读 classList 更好读，
   *     也让截图脚本/DOM 断言有一个稳定属性可查）。
   * 两者由这一个函数同时写，不存在"类挂上了、属性还是旧值"的窗口。
   */
  function applyLayoutMode() {
    const mobile = isMobile();
    const chat = state.mobileScreen === SCREEN_CHAT;
    // 宽屏（含桌面 Electron 窗口被拖宽）一律**不挂** `mobile-*`：
    // 这些类只在窄屏媒体查询里有定义，挂上去不影响宽屏渲染，但会让"当前到底是哪一种布局"
    // 在 DOM 上无法判断。状态如实反映布局，排查问题时不用再猜。
    document.body.classList.toggle('mobile-chat', mobile && chat);
    document.body.classList.toggle('mobile-panel', mobile && !chat);
    if (mobile) document.body.dataset.screen = chat ? SCREEN_CHAT : SCREEN_PANEL;
    else delete document.body.dataset.screen;
    // 导航高亮跟着"当前这一屏"走，而不是只跟着 state.view：
    // 手机上刚打开时是"视图=日历（桌面端的默认值）、屏幕=聊天"，此时**不该**有任何模块被高亮
    // （一旦点亮「日历」，用户会以为已经在看日历了）。窄屏显示功能页时才按 state.view 点亮。
    //
    // 判断本身在 `PCSidebarLayout.isNavActive()`（纯函数、有单测），宽屏与窄屏共用一处 ——
    // 以前这里与 selectView 各写一个循环，两边规则一旦漂移就会出现"高亮与面板对不上"。
    syncNavActive();
    // 窄屏下 hash 是**状态的一部分**（刷新要靠它回到同一屏），所以首屏就补上，
    // 而不是等用户点一次导航才开始记。宽屏不写：地址栏干净，也不给桌面端引入新行为。
    if (mobile && !readHashView()) syncHashForScreen(state.mobileScreen);
  }

  /**
   * 建"← 返回对话"按钮。
   *
   * 为什么手机端**必须**有它：整屏功能页把聊天列盖住了，而手机浏览器没有桌面端那种
   * "另一栏一直可见"的退路；只剩浏览器自己的后退键，可它会连着页面历史一起回退
   * （很可能直接退出应用），并不是"回到聊天"。所以每个功能页顶部都必须有一条明确的退路。
   *
   * 判定用 `body.mobile-panel` 而不是 `matchMedia`：宽屏上永远只有 `mobile-chat`，
   * 于是**桌面端的 DOM 里根本不会出现这个按钮**（"桌面一点都不能变"是硬要求，
   * 不能只靠 CSS 把它藏起来 —— 藏起来的元素仍然占着 DOM，别人一查就露）。
   * 手机上它是先在聊天屏建好、切到功能页才显示的，所以必须有 `mobile-panel` 才建。
   */
  function ensureBackButton() {
    if (dom.panelBack || !document.body.classList.contains('mobile-panel') || !dom.panelHead) return;
    const button = mk('button', 'panel-back', '← 返回对话');
    button.type = 'button';
    button.addEventListener('click', () => selectView(CHAT_VIEW));
    // 追加在标题之后（DOM 顺序不动标题），视觉顺序交给 CSS 的 `order: -1`。
    dom.panelHead.appendChild(button);
    dom.panelBack = button;
  }

  /** 窄屏下 hash 变化 = 用户按了浏览器后退/前进，或手改了地址栏。 */
  function wireMobileLayout() {
    window.addEventListener('hashchange', () => {
      if (!isMobile()) return;
      const id = readHashView();
      if (!id || !Modules.has(id)) return;
      if (id === state.view && state.mobileScreen === screenFor(id)) return;
      // 这里不能复用 selectView：它会再写一次 hash，把用户的后退操作又推回去。
      // 导航高亮交给 setMobileScreen → applyLayoutMode（它按"当前这一屏"算），
      // 不在这里再写一遍 —— 同一件事两处写，迟早会不一致。
      state.view = id;
      setMobileScreen(screenFor(id), { syncHash: false });
    });

    // 手机横竖屏切换、桌面拖窗口跨过断点时调整挂载状态：
    //   - 进入窄屏：state 没变，补一次返回按钮即可（`mobile-*` 类本来就在）；
    //   - 回到宽屏：把 `mobile-*` 类摘掉。宽屏 CSS 虽然不认识这些类，但留着它们会让
    //     DOM 断言（比如"桌面不该有 mobile 状态"）无从判断 —— 状态要如实反映当前布局。
    // state.view / state.mobileScreen **不动**：宽屏有三栏本来就同时显示两者，
    // 拖宽再拖窄时用户应该回到原来那一屏，而不是被重置。
    window.addEventListener('resize', () => {
      // 跨断点时把「更多」弹层收掉：它是按宽屏的左栏位置摆的，窄屏下留在屏幕上会飘在别处。
      closeMorePop();
      if (isMobile()) ensureBackButton();
      else applyLayoutMode();
      // 布局模式变了，高亮规则也跟着变（窄屏看"哪一屏"、宽屏看"面板开不开"），必须重算一次
      syncNavActive();
    });
  }

  /* ------------------------------------------------------------ 对话面板 */

  /**
   * 是否"贴在底部"：距底不足 24px 就算。滚动跟随只能在这个前提下做。
   *
   * 为什么必须有这个判断：流式增量（正文与思考过程）是**每帧**触发的，无条件写
   * `scrollTop = scrollHeight` 等于每一帧都把视图拽回底部 —— 用户往上翻的时候，
   * 手一松就被拉回去，表现出来就是"聊天窗口滚不动"（真机反馈过）。
   * 24px 的容差是给"差一点点到底"留的余量：那种情况用户其实还想看最新内容。
   */
  function isPinnedToBottom(el = dom.chatLog) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }

  /**
   * 跟随到底部（**只在用户本来就在底部时**）。流式增量必须走这个，不要直接写 scrollTop。
   * `el` 可传入（测试用假容器断言判断口径，不必真的启动整个外壳）。
   */
  function followBottom(force = false, el = dom.chatLog) {
    if (force || isPinnedToBottom(el)) el.scrollTop = el.scrollHeight;
  }

  /**
   * 挂到 window 供渲染层测试断言（见 test/renderer.test.js 的滚动用例）：**不是**给视图用的 API。
   * 为什么值得测：流式增量每帧调它，判断写错就会变成"聊天窗口滚不动"（真机 bug，改过一次）。
   */
  window.__PC_SCROLL__ = { followBottom, isPinnedToBottom };

  /**
   * 渲染层测试用的**测试缝**（与 `__PC_SCROLL__` 同一口径：不是给视图用的 API）。
   *
   * 为什么需要它：排队、停止、过程清单这三件事的行为全都长在 `shell/app.js` 内部
   * （classic script 的 IIFE，没有模块导出），不挖一条缝，`npm test` 就只能对源码做
   * 字符串断言 —— 测不出"队列是不是按顺序发出去""停止后按钮有没有变回发送"这类真行为。
   * 这里只暴露**已经存在的函数与状态本身**，不为测试另写一套逻辑（那测的就不是产品代码了）。
   */
  window.__PC_CHAT_TEST__ = {
    state,
    // 测试里没有 boot()：dom 引用由测试自己挂上（真实运行时是 boot() 填的）
    attachDom(refs) {
      dom = { ...dom, ...refs };
      return dom;
    },
    send,
    startRound,
    finishRound,
    stopRound,
    handlePush,
    // 让测试能把「停止」按钮真的接上处理器（wireChat 平时由 boot() 调）
    wireChat,
    paintStopButton,
    paintQueueBar,
    renderQueueBar,
    createPlanCard,
    planSummary,
    planSteps,
    queuePreview,
    enqueueMessage,
    cancelQueued,
    clearQueue,
    clearChatLog,
    queueItems: () => state.queue.map((item) => ({ id: item.id, seq: item.seq, text: item.text })),
  };

  /**
   * 左栏的测试缝（与 `__PC_CHAT_TEST__` 同一口径：暴露**已经存在的函数与状态本身**，
   * 不为测试另写一套逻辑）。
   *
   * 为什么需要它：需求里"点已高亮的项要收起、再展开要回到同一个功能"这条不变式
   * 只有一半在纯逻辑里（`PCSidebarLayout.resolveNavClick`），另一半是外壳把它落到
   * `state.panelCollapsed` / `body.panel-collapsed` / `.nav-item.active` 这三处动作 ——
   * 不挖缝就只能靠肉眼看浏览器，回归时第一个坏掉的就是它。
   */
  window.__PC_NAV_TEST__ = {
    state,
    /** 测试里没有 boot()：dom 引用由测试自己挂上（真实运行时是 boot() 填的）。 */
    attachDom(refs) {
      dom = { ...dom, ...refs };
      return dom;
    },
    buildNav,
    syncNavActive,
    onNavClick,
    selectView,
    setPanelCollapsed,
    togglePanel,
    toggleMorePop,
    openMorePop,
    closeMorePop,
    /** 当前生效的布局（只读快照）。 */
    layout: () => ({ main: [...navLayout.main], more: [...navLayout.more], bottom: [...navLayout.bottom] }),
  };

  function push(node) {
    dom.chatLog.appendChild(node);
    // 新消息/新卡片是用户自己触发的动作，直接跟到底（force），别让上一次的滚动位置把新内容藏起来
    followBottom(true);
    return node;
  }

  /**
   * 气泡。
   * - 用户消息按纯文本渲染（自己敲的字不该被 Markdown 规则改样）；
   * - 机器人消息走富文本（Markdown 子集 + LaTeX 子集 + ```svg 图形）。
   */
  function bubble(role, text, files = []) {
    const node = mk('div', `bubble ${role}`);
    const body = mk('div', 'bubble-text');
    node.appendChild(body);
    if (role === 'user') body.textContent = String(text ?? '');
    else if (text) window.PCRichText?.render(body, text);
    if (files.length) {
      const box = mk('div', 'bubble-files');
      for (const file of files) {
        if (file.type?.startsWith('image/') && file.dataUrl) {
          const img = mk('img');
          img.src = file.dataUrl;
          img.alt = file.name;
          box.appendChild(img);
        } else {
          box.appendChild(mk('span', 'attach-chip', `${file.name}（${formatSize(file.size)}）`));
        }
      }
      node.appendChild(box);
    }
    return push(node);
  }

  function formatSize(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  /** 流式更新：每次增量都重渲染（公式/图形会随内容长出来），半截输入由 richtext 兜住不崩。 */
  function setBubbleText(node, text) {
    if (!node) return;
    if (window.PCRichText) window.PCRichText.render(node, text);
    else node.textContent = String(text ?? '');
  }

  function systemNote(text, kind = '') {
    return push(mk('div', `chat-note ${kind}`.trim(), text));
  }

  function welcome() {
    const card = mk('div', 'bubble bot');
    const intro = state.ai.available
      ? `你好，我是「AI 智学」，由 ${state.ai.provider} 驱动。直接说话就行，我会把安排整理成草稿，你点确认才写进日历。也可以这样说：`
      : '你好，这是日历与待办模块的测试界面。还没配置 AI 密钥，中间的对话由本地规则解析器完成（在「设置 → AI 接入」里填上密钥就换成模型）。可以直接这样说：';
    card.appendChild(mk('div', 'bubble-text', intro));
    const chips = mk('div', 'chips');
    for (const example of EXAMPLES) {
      const chip = mk('button', 'chip-btn', example);
      chip.type = 'button';
      chip.addEventListener('click', () => send(example));
      chips.appendChild(chip);
    }
    card.appendChild(chips);
    push(card);
  }

  /* ------------------------------------------------ 会话：打开历史 / 新建 / 续聊 */

  /**
   * 「对话」页要能**把历史对话打开到左侧聊天框**，所以这里把控制权做成一组函数，
   * 通过 `PCModules.service('chat', ...)` 暴露出去 —— 视图不必知道消息怎么渲染、
   * 更不必去点 DOM。判定标准是：切换会话必须同时改 `state.conversationId`，
   * 否则界面上是 A 会话的内容、下一条消息却写进 B 会话（用户看到"串了"却查不出原因）。
   */
  const CONVERSATION_KEY = 'potato.conversation';
  const DRAFT_KEY = 'potato.draft';

  /** 换会话的唯一入口：内存与 localStorage 一起改，避免两处不同步。 */
  function setConversationId(id) {
    state.conversationId = id || null;
    writeStored(CONVERSATION_KEY, state.conversationId ?? '');
  }

  /**
   * 清空聊天栏（**换会话的唯一出口**：打开历史对话、新建对话都走它）。
   *
   * 除了断掉流式引用（否则迟到的分片会写进新会话的界面），这里还要处理两件"跟着会话走"的东西：
   *   1. **排队**：队列里的消息属于上一个会话，原地留着的话，新会话里会突然冒出上一段对话
   *      没说完的话被发出去（而且是写进旧会话）。清掉并说一句，用户才知道它们去哪了。
   *   2. **正在跑的那一轮**：HTTP 请求取消不了，服务端还在为旧会话跑。把它登记成"孤儿"：
   *      它回来时若用户已经切回旧会话，就补画一次（见 finishRound）。
   */
  function clearChatLog() {
    if (state.round) state.orphan = { token: state.round.token, conversationId: state.round.conversationId ?? null };
    state.round = null;
    state.streaming = null;
    state.reasoningNode = null;
    state.plan = null;
    state.stopWanted = false;
    paintStopButton();
    dom.chatLog.textContent = '';
    const dropped = clearQueue();
    if (dropped) systemNote(`切换会话，已清空 ${dropped} 条排队消息`, 'meta');
  }

  /**
   * 把落库的一条消息画回聊天栏（正文 + **当时的操作痕迹**）。
   *
   * 为什么必须带上操作：用户回到一条旧对话，最想确认的往往不是"我当时说了什么"，
   * 而是"**我让它干了什么**"——"那条待办到底加上了没有""它当时查到的日程是哪几条"。
   * 所以：
   *   - `queried`（当时跑过的只读查询）→ 数据卡片照原样重画：数据是历史事实，点开看明细、跳转都还有效；
   *   - `executed`（当时自动执行掉的写操作）→ 回执卡重画，并在说明里标「历史回执」，
   *     否则用户会以为刚刚又执行了一次；
   *   - `drafts`（当时提议**但没确认**的草稿）→ **不重放按钮**：那次确认的机会早过去了，
   *     给一个能点的"确认"只会让人误以为现在点还来得及；只留一行痕迹说明当时提议了什么。
   * 附件同样只留名字：dataURL 不落库（省空间），给不出缩略图时如实显示名字比给个坏图强。
   */
  function renderHistoryMessage(message) {
    const role = message?.role === 'user' ? 'user' : 'bot';
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    const files = attachments.map((item) => ({ name: item?.name ?? '附件', type: item?.type ?? '', size: item?.size ?? 0 }));

    if (role === 'bot') {
      for (const entry of message?.queried ?? []) {
        if (entry?.result) queryCard(entry.result);
        else if (entry?.error) systemNote(`当时有个查询没成功：${entry.error.message ?? entry.error}`, 'fail');
      }
      for (const item of message?.executed ?? []) {
        if (item?.error) systemNote(`当时有一步没成功：${item.error.message ?? item.error}`, 'fail');
        else if (item?.result) resultCard({ ...item.result, explain: `${item.result.explain ?? '已完成'}（历史回执）` });
      }
      for (const entry of message?.drafts ?? []) {
        const draft = entry?.draft ?? {};
        const what = actionText(draft) || '一条操作';
        const title = draft?.fields?.title ? ` · ${draft.fields.title}` : '';
        systemNote(`当时提议过：${what}${title}（未确认，未写入）`, 'meta');
      }
    }

    const node = bubble(role, message?.content ?? '', files);
    if (message?.createdAt) node.dataset.at = message.createdAt;
    /**
     * 历史回放：被停止的那条消息，服务端落库时带了 `status:"stopped"` + `stoppedAt`
     * （正文是停止前的那半段，见 chat-service 的 `#saveStopped`），所以这里能如实重画那个标记。
     *
     * 至于**过程清单**：落库的 assistant 消息里**没有**步骤字段（服务端只存
     * content/drafts/executed/queried/status/usage/… ），历史回放就画不出来。
     * 按约定"拿不到就跳过、不要编"：这里不重建一张假的清单，清单只在实时那一轮里显示。
     */
    if (role === 'bot' && message?.status === 'stopped') node.appendChild(mk('div', 'bubble-stop', '已停止'));
    return node;
  }

  /** 历史对话的标题：没有标题就按第一条用户消息起头，跟「对话」页的列表口径保持一致。 */
  function conversationTitle(conversation, messages = []) {
    const explicit = String(conversation?.title ?? '').trim();
    if (explicit) return explicit;
    const first = messages.find((item) => item?.role === 'user' && String(item.content ?? '').trim());
    const text = String(first?.content ?? '').trim().replace(/\s+/g, ' ');
    return text ? `${text.slice(0, 24)}${text.length > 24 ? '…' : ''}` : '（空对话）';
  }

  /**
   * 打开一条历史对话：拉详情 → 清空 → 按顺序重画 → 记住 id。
   *
   * @param {string} id
   * @param {{ silent?: boolean }} [options] `silent` 用在启动恢复：失败时不弹失败卡，
   *   而是安静地退回欢迎语（上次那条对话可能已经被用户在「对话」页删掉了，这不算错误）。
   */
  async function openConversation(id, options = {}) {
    if (!id) {
      newConversation();
      return { ok: false, reason: 'no-id' };
    }
    const pending = options.silent ? null : systemNote('正在打开历史对话…', 'pending');
    try {
      const detail = await api(`/ai/conversations/${encodeURIComponent(id)}`);
      const messages = Array.isArray(detail?.messages) ? detail.messages : [];
      clearChatLog();
      setConversationId(detail?.conversation?.id ?? id);
      systemNote(`已打开「${conversationTitle(detail?.conversation, messages)}」 · ${messages.length} 条消息`, 'meta');
      for (const message of messages) renderHistoryMessage(message);
      if (!messages.length) systemNote('这个对话还没有消息，直接说话就行。', 'meta');
      dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
      // 换了会话就必须立刻重画圆环：上一个会话的占用数字留着不动，用户会以为这就是当前会话的
      await refreshContextMeter();
      pending?.remove();
      return { ok: true, count: messages.length };
    } catch (error) {
      pending?.remove();
      if (options.silent) {
        // 对话可能已被删除：把失效的 id 清掉，下次启动不再白试一遍
        setConversationId(null);
        return { ok: false, error };
      }
      errorCard(error);
      throw error;
    }
  }

  /** 新对话：不落库（后端在下一条消息时才建会话），只把界面与 id 归零。 */
  function newConversation() {
    clearChatLog();
    setConversationId(null);
    // 新会话还没有上下文可言：把圆环清成空态（而不是停在上一条会话的数字上）
    contextMeterData = null;
    contextMeterPaint?.(null);
    welcome();
    dom.chatInput?.focus();
    return { ok: true };
  }

  /** 上次的对话：启动时用它续上；没有、或已被删，就回到欢迎语。 */
  async function restoreConversation() {
    const stored = readStored(CONVERSATION_KEY);
    if (!stored) {
      welcome();
      return;
    }
    const result = await openConversation(stored, { silent: true });
    if (!result.ok) welcome();
  }

  /** 草稿：关窗/刷新后输入框里的半截话还在（不然"刚写一半被打断"就得重打）。 */
  function saveDraft(value) {
    clearTimeout(saveDraft._timer);
    saveDraft._timer = setTimeout(() => writeStored(DRAFT_KEY, String(value ?? '')), 250);
  }

  function actionText(draft) {
    const target = TARGET_LABEL[draft.target] ?? draft.target ?? '';
    const action = ACTION_LABEL[draft.action] ?? draft.action ?? '';
    return `${action}${target}`;
  }

  function formatValue(key, value) {
    if (key === 'repeat') {
      if (!value || value.type === 'none') return '不重复';
      const base = REPEAT_LABEL[value.type] ?? value.type;
      const interval = value.interval > 1 ? `每 ${value.interval} 次` : '';
      const weekdays =
        value.type === 'weekly' && value.weekdays?.length
          ? `（${value.weekdays.map((d) => `周${U.WEEK_CN[d - 1]}`).join('、')}）`
          : '';
      const until =
        value.until?.mode === 'date'
          ? `，到 ${value.until.date}`
          : value.until?.mode === 'count'
            ? `，共 ${value.until.count} 次`
            : '';
      return `${interval}${base}${weekdays}${until}`;
    }
    if (key === 'priority') return { 0: '低', 1: '普通', 2: '紧急' }[value] ?? value;
    if (key === 'allDay') return value ? '是' : '否';
    if (key === 'estimatedMinutes') return `${value} 分钟`;
    if (Array.isArray(value)) return value.join('、');
    if (value && typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  function fieldRows(source, filter) {
    const rows = mk('div', 'cc-fields');
    for (const [key, value] of Object.entries(source ?? {})) {
      if (filter && !filter(key)) continue;
      if (value === undefined || value === null || value === '') continue;
      const row = mk('div', 'cc-row');
      row.append(mk('span', 'cc-key', FIELD_LABEL[key] ?? key), mk('span', 'cc-val', formatValue(key, value)));
      rows.appendChild(row);
    }
    return rows;
  }

  /** 写操作预览卡片：确认后才调用 /commands/execute。 */
  function draftCard(preview) {
    const draft = preview.draft ?? preview;
    const card = mk('div', 'bubble bot has-card');

    card.appendChild(mk('div', 'chat-card'));

    const box = card.firstChild;
    box.appendChild(mk('div', 'cc-title', `准备执行：${actionText(draft)}`));
    if (draft.explain) box.appendChild(mk('div', 'cc-explain', draft.explain));

    const fields = draft.fields ?? preview.planned?.fields ?? {};
    // source / externalId / 时间戳是管线里的内部字段，不是用户要确认的内容；
    // 来源已经在下面的置信度行里写了（"来源 rules / ai"），这里再列一遍只是噪音。
    const visible = (key) => !INTERNAL_FIELD_KEYS.has(key);
    if (Object.keys(fields).filter(visible).length) box.appendChild(fieldRows(fields, visible));

    if (draft.filters && Object.keys(draft.filters).length) {
      const filters = mk('div', 'cc-filters');
      filters.appendChild(mk('div', 'cc-sub', '筛选条件'));
      filters.appendChild(fieldRows(draft.filters));
      box.appendChild(filters);
    }

    if (preview.planned?.ids?.length) {
      box.appendChild(mk('div', 'cc-sub', `命中 ${preview.planned.ids.length} 条记录`));
    }

    if (draft.warnings?.length) {
      const warnings = mk('div', 'cc-warnings');
      for (const text of draft.warnings) warnings.appendChild(mk('div', 'cc-warning', text));
      box.appendChild(warnings);
    }

    /**
     * 时段重叠要在**点确认之前**就说。
     *
     * 跨功能实测发现的缺口：冲突只在真写完成后才回执（`resultCard`），而 `dryRun` 预演不返回
     * `conflicts` —— 于是"确认卡上没有任何重叠提示，用户点完才知道撞了"。后端现在会在预演里带上
     * `preview.conflicts`，这里负责把它画出来（模型侧的同一信息由 `ai/chat-service` 回灌给它）。
     */
    const conflicts = preview.conflicts ?? [];
    if (conflicts.length) {
      const box2 = mk('div', 'cc-warnings');
      const lines = conflicts
        .slice(0, 3)
        .map((item) => {
          if (typeof item === 'string') return item;
          // 冲突对象来自日程的"某一天的那一次"，字段是 `occurrenceDate`（不是 `date`）——
          // 取错了日期会渲染成空串（标题与时刻照常，但用户看不出撞的是哪一天）
          const day = item.occurrenceDate ?? item.date ?? '';
          return `${item.title ?? '已有安排'} ${day} ${item.startTime ?? ''}${item.endTime ? `-${item.endTime}` : ''}`.trim();
        });
      box2.appendChild(mk('div', 'cc-warning', `与 ${conflicts.length} 条日程时间重叠：${lines.join('；')}`));
      if (conflicts.length > lines.length) box2.appendChild(mk('div', 'cc-warning', `…另有 ${conflicts.length - lines.length} 条`));
      box.appendChild(box2);
    }

    if (typeof draft.confidence === 'number') {
      box.appendChild(mk('div', 'cc-meta', `置信度 ${(draft.confidence * 100).toFixed(0)}% · 来源 ${draft.provider ?? 'rules'}`));
    }

    const actions = mk('div', 'cc-actions');
    const confirm = mk('button', 'primary-btn', '确认执行');
    confirm.type = 'button';
    const cancel = mk('button', 'ghost-btn', '取消');
    cancel.type = 'button';
    actions.append(confirm, cancel);
    box.appendChild(actions);

    push(card);

    cancel.addEventListener('click', () => {
      actions.replaceChildren(mk('span', 'cc-note', '已取消，未写入任何数据'));
      box.classList.add('cancelled');
    });

    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      confirm.textContent = '执行中…';
      try {
        const result = await api('/commands/execute', { method: 'POST', body: { draft } });
        actions.replaceChildren(mk('span', 'cc-note ok', '已执行'));
        box.classList.add('done');
        // 查询类草稿的结果是**数据行**，不是"执行了哪些写操作" —— 以前一律走 resultCard，
        // 而它只画 affected / conflicts，于是"查到了但界面一片空白"。
        if (result.action === 'query') queryCard(result);
        else resultCard(result);
        refresh();
      } catch (error) {
        actions.replaceChildren(mk('span', 'cc-note fail', '执行失败'));
        errorCard(error);
      }
    });
  }

  /**
   * AI 操作卡：**默认折叠**，点标题栏展开；按作用对象配色。
   *
   * 为什么折叠：一轮对话里"查了什么、改了什么"会堆很多张卡，全展开会把真正的对话挤没。
   * 折叠后一行说清「干了什么 · 影响了几条」，想看细节再点开。
   * 配色（日程橙 / 待办紫 / 事件蓝 / 写入绿）让人不点开也知道这张卡在说哪类东西。
   */
  function opCard({ kind, chip, title, details, defaultOpen = false }) {
    const card = mk('div', 'bubble bot has-card');
    const box = mk('div', `chat-card op-card op-${kind}`);

    const head = mk('button', 'op-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', defaultOpen ? 'true' : 'false');
    head.append(
      mk('span', 'op-chip', chip),
      mk('span', 'op-title', title),
      mk('span', 'op-caret', '›'),
    );

    const body = mk('div', 'op-body');
    for (const node of [].concat(details ?? [])) if (node) body.appendChild(node);

    const toggle = (open) => {
      const next = open ?? !box.classList.contains('open');
      // 展开/收起会改变高度：如果展开前视图正贴着底（也就是正在看最新的正文），
      // 展开后要继续贴着底 —— 否则一点"看明细"，结论就被顶到屏幕外面去了。
      const log = dom.chatLog;
      const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
      box.classList.toggle('open', next);
      head.setAttribute('aria-expanded', next ? 'true' : 'false');
      if (pinned) log.scrollTop = log.scrollHeight;
    };
    head.addEventListener('click', () => toggle());
    if (defaultOpen) box.classList.add('open');

    box.append(head, body);
    card.appendChild(box);
    push(card);
    return { card, box, body, toggle };
  }

  /** 全局标签表（kit/labels.js 的 classic script 全局）；取不到就回落到字段原文。 */
  function targetLabel(target) {
    if (!target) return '';
    try {
      return TARGET_LABEL?.[target] ?? String(target);
    } catch {
      return String(target);
    }
  }

  /** 成绩条目（来自 academic 模块的 target: 'grade'）：靠课程名 + 学分/成绩类字段认出来。 */
  const isGrade = (item) =>
    Boolean(item) && 'courseName' in item && ('credit' in item || 'score' in item || 'gradePoint' in item || 'levelGrade' in item);

  /**
   * 成绩行右边的正文。
   *
   * 字段都能缺（等级制没有分数、有的课没有绩点），所以按需拼、缺了不写，
   * 而不是留一串「undefined」；`included === false` 是"用户手动排除、不计入 GPA"，
   * 不标出来会被误读成算进去了。
   */
  function gradeText(item) {
    const name = item.courseName ?? item.title ?? item.id ?? '';
    const score = item.score ?? item.levelGrade; // 百分制给 score，等级制给 levelGrade（优 / 良 / 中）
    const parts = [
      item.credit === undefined || item.credit === null || item.credit === '' ? '' : `学分 ${item.credit}`,
      score === undefined || score === null || score === '' ? '' : `成绩 ${score}`,
      item.gradePoint === undefined || item.gradePoint === null || item.gradePoint === '' ? '' : `绩点 ${item.gradePoint}`,
      item.included === false ? '未计入' : '',
    ].filter(Boolean);
    const head = String(name);
    return parts.length ? `${head} · ${parts.join(' · ')}` : head;
  }

  /** 成绩的"时间维度"是学期（termLabel 是站点给的显示名，term 是原始编码）。 */
  const gradeTerm = (item) => item.termLabel ?? item.term ?? '';

  /**
   * 知识库条目（来自 knowledge 模块的 target: 'knowledge'）：
   * 政策语料每条都带 `url`（回答要能给用户点回去核对原文），日程/待办/成绩都没有这个字段。
   */
  const isKnowledge = (item) => Boolean(item) && typeof item.url === 'string' && item.url !== '';

  /** snippet 是命中位置前后各约 120 字的片段，超了就在这里截断（卡片行不该被一段正文撑满）。 */
  const SNIPPET_MAX = 120;
  const snippetText = (text) => {
    const value = String(text ?? '').trim();
    return value.length > SNIPPET_MAX ? `${value.slice(0, SNIPPET_MAX)}…` : value;
  };

  /**
   * 打开外部链接：交给系统浏览器。
   *
   * 主进程装了 `setWindowOpenHandler` → `shell.openExternal`（src/main/main.cjs），
   * 所以 `window.open` 在 Electron 里是**真的能打开**的；退化成普通浏览器访问时也一样。
   * 这个能力是联网检索的前提：搜到的链接必须能点回去核对，否则等于让用户相信一段无法验证的话。
   */
  function openExternal(url) {
    if (!url) return;
    window.open(String(url), '_blank', 'noreferrer');
  }

  /**
   * 联网检索结果的一行：标题 + 可点的链接 + 摘要 + 「有没有抓到正文」。
   *
   * 「没抓到正文」必须显式标出来：只有标题和摘要时，模型看到的和用户看到的是同一层信息，
   * 卡片上不写清楚，用户会以为 AI"读过全文"。
   */
  function webRow(item) {
    const row = mk('div', 'cc-list-row cc-web-row');
    const head = mk('div', 'cc-web-head');
    head.appendChild(mk('span', 'cc-web-title', item.title || item.url || '（无标题）'));
    const open = mk('button', 'ghost-btn cc-web-open', '打开');
    open.type = 'button';
    open.addEventListener('click', () => openExternal(item.url));
    head.appendChild(open);
    row.appendChild(head);
    if (item.url) row.appendChild(mk('div', 'cc-web-url', item.url));
    const snippet = snippetText(item.snippet);
    if (snippet) row.appendChild(mk('div', 'cc-web-snippet', snippet));
    row.appendChild(
      mk(
        'div',
        'cc-web-meta',
        item.ok && item.text
          ? `已读正文 ${String(item.text).length} 字`
          : `只有标题与摘要${item.error ? `（${item.error}）` : ''}`,
      ),
    );
    return row;
  }

  /**
   * 知识库结果的一行：标题（主）+ 栏目 · 日期（次）+ 来源 URL + 片段。
   * 链接同样可点（同 openExternal）：政策原文要能当着用户的面核对。
   */
  function knowledgeRow(item) {
    const row = mk('div', 'cc-list-row cc-kb-row');

    const head = mk('div', 'cc-kb-head');
    head.appendChild(mk('span', 'cc-kb-title', item.title ?? item.path ?? '（无标题）'));
    // 栏目来的是中文 label（category），categorySlug 是给过滤用的，不展示给用户
    const meta = [item.category, item.publishedAt].filter(Boolean).join(' · ');
    if (meta) head.appendChild(mk('span', 'cc-kb-meta', meta));
    row.appendChild(head);

    if (item.url) row.appendChild(mk('div', 'cc-kb-url', item.url));
    const snippet = snippetText(item.snippet);
    if (snippet) row.appendChild(mk('div', 'cc-kb-snippet', snippet));
    return row;
  }

  /** 影响对象的列表（写入结果 / 查询结果共用一种行样式）。 */
  const isWebResult = (item) => Boolean(item) && typeof item.url === 'string' && item.url !== '' && 'ok' in item;
  function itemList(items, { limit = 12 } = {}) {
    const list = mk('div', 'cc-list');
    for (const item of items.slice(0, limit)) {
      const row = mk('div', 'cc-list-row');
      if (isGrade(item)) {
        // 成绩项没有日期也没有 title：以前这里只显示一个 uuid，等于没显示。
        // 左边那栏改放学期（成绩的"时间维度"就是学期），右边是课程 + 学分/成绩/绩点。
        row.append(mk('span', 'cc-list-time', gradeTerm(item)), gradeText(item));
      } else if (isWebResult(item)) {
        // 联网检索的条目要四行（标题 + 可点链接 + 摘要 + 有没有读到正文），整行交给 webRow
        list.appendChild(webRow(item));
        continue;
      } else if (isKnowledge(item)) {
        // 知识条目要三行才说得清（标题 / 出处 / 片段），所以整行交给 knowledgeRow 自己排
        list.appendChild(knowledgeRow(item));
        continue;
      } else {
        const when = item.date ?? item.startDate ?? item.deadline ?? '';
        const time = !item.startTime || item.allDay ? '' : ` ${item.startTime}${item.endTime ? `–${item.endTime}` : ''}`;
        row.append(mk('span', 'cc-list-time', `${when}${time}`.trim()), mk('span', null, item.title ?? item.id ?? ''));
      }
      list.appendChild(row);
    }
    if (items.length > limit) list.appendChild(mk('div', 'cc-list-row', `…还有 ${items.length - limit} 条`));
    return list;
  }

  /** 写操作结果（新建 / 修改 / 删除 / 完成 / 顺延）。 */
  function resultCard(result) {
    const affected = Array.isArray(result.affected) ? result.affected : [];
    const details = [];
    if (result.dryRun) details.push(mk('div', 'cc-explain', '（试运行，未写入数据）'));
    if (result.explain) details.push(mk('div', 'cc-explain', result.explain));
    if (affected.length) details.push(itemList(affected, { limit: 10 }));
    if (result.conflicts?.length) details.push(mk('div', 'cc-warning', `提示：与 ${result.conflicts.length} 条日程时间重叠`));
    if (result.ambiguous) details.push(mk('div', 'cc-warning', '匹配到多条记录，已全部处理，请确认是否符合预期'));

    opCard({
      kind: 'write',
      chip: actionText(result),
      title: affected.length ? `${affected.length} 条 · 点开看明细` : '已完成',
      details,
    });
  }

  /** 查询结果（只读）：默认折叠，配色按 target（日程橙 / 待办紫 / 事件蓝）。 */
  function queryCard(result) {
    const items = result.items ?? [];
    // 知识库条目有自己的行样式与去处（.cc-kb-*），但沿用 op-write 的绿色底：
    // 外壳的配色是按"作用对象"分的（日程橙 / 待办紫 / 事件蓝），没有也不该为一个新 target 新造主题色，
    // 复用现成的一档比再塞一个色值进 shell.css 更稳。
    const kind = ['schedule', 'todo', 'event'].includes(result.target) ? result.target : 'write';
    const summary = result.explain ?? `共 ${result.count ?? items.length} 条`;

    const details = [];
    if (!items.length) details.push(mk('div', 'cc-explain', '没有符合条件的记录。'));
    else {
      details.push(itemList(items));
      const actions = mk('div', 'cc-actions');
      const toAcademic = result.target === 'grade';
      // knowledge 没有对应的右侧视图：与其照旧跳日历（那里一条政策都没有，点了等于没反应），
      // 不如把按钮改成「去设置里看知识库」→ 设置页的「知识库」区块里有语料概况、栏目表与自检。
      // 判据与上面 isGrade 的按 target 特判同一路子（条目本身带 url 也算数，防止 target 缺失）。
      const toKnowledge = result.target === 'knowledge' || items.some(isKnowledge);
      // 联网检索没有"右侧页面"可跳：结果本身就是一行行可点的链接（见 webRow），
      // 所以给的是「去对话设置里看检索诊断」——那里能看到用了哪个后端、为什么某条没抓到正文。
      const toWeb = result.target === 'web';
      const jump = mk('button', 'ghost-btn', toAcademic
        ? '在右侧看学业'
        : toWeb
          ? '去看检索诊断'
          : toKnowledge
            ? '去设置里看知识库'
            : '在右侧查看');
      jump.type = 'button';
      jump.addEventListener('click', () => {
        if (toAcademic && typeof window.PC?.openView === 'function') {
          window.PC.openView('academic');
          return;
        }
        if (toWeb) {
          if (typeof window.PC?.openView === 'function') {
            window.PC.openView('settings');
            window.PC?.toast?.('联网检索的开关、密钥与「最大条数」都在「对话设置」里');
            return;
          }
          window.PC?.toast?.('请打开左侧的「设置 → 对话设置」');
          return;
        }
        if (toKnowledge) {
          if (typeof window.PC?.openView === 'function') {
            window.PC.openView('settings');
            return;
          }
          // 外壳版本较旧、没有 openView：退化成文字指引，别让按钮点了没反应（同 academic / lms 的做法）
          window.PC?.toast?.('请打开左侧的「设置」，在「知识库」区块里查看');
          return;
        }
        state.view = 'calendar';
        state.calendar.mode = 'day';
        state.calendar.anchor = items[0]?.date ?? items[0]?.startDate ?? items[0]?.deadline ?? U.todayKey();
        selectView('calendar');
      });
      actions.appendChild(jump);
      details.push(actions);
    }

    opCard({
      kind,
      chip: `查看${targetLabel(result.target) || '记录'}`,
      title: `${summary}${items.length ? ' · 点开看明细' : ''}`,
      details,
    });
  }

  /**
   * 失败卡片。
   * @param {Error} error
   * @param {{ retry?: string }} [options] 传了 `retry` 就多一个「改用本地规则」按钮 ——
   *   AI 挂了不代表这件事做不了，但降级必须是用户按的，不能悄悄发生。
   */
  function errorCard(error, options = {}) {
    const card = mk('div', 'bubble bot has-card');
    const box = mk('div', 'chat-card fail');
    box.appendChild(mk('div', 'cc-title', '没能完成'));
    box.appendChild(mk('div', 'cc-explain', error?.message ?? '未知错误'));
    const details = error?.payload?.error?.details;
    const warnings = details?.warnings;
    if (Array.isArray(warnings) && warnings.length) {
      const list = mk('div', 'cc-warnings');
      for (const text of warnings) list.appendChild(mk('div', 'cc-warning', text));
      box.appendChild(list);
    }
    if (details?.hint) box.appendChild(mk('div', 'cc-explain', details.hint));
    if (details?.field) box.appendChild(mk('div', 'cc-meta', `字段：${details.field}`));
    if (!details && error?.payload?.error?.code) {
      box.appendChild(mk('div', 'cc-meta', `错误码：${error.payload.error.code}`));
    }
    const chips = mk('div', 'chips');
    if (options.retry) {
      const retry = mk('button', 'chip-btn', '改用本地规则解析');
      retry.type = 'button';
      retry.addEventListener('click', () => runLocalRules(options.retry));
      chips.appendChild(retry);
    }
    for (const example of EXAMPLES.slice(0, 3)) {
      const chip = mk('button', 'chip-btn', example);
      chip.type = 'button';
      chip.addEventListener('click', () => send(example));
      chips.appendChild(chip);
    }
    box.appendChild(chips);
    card.appendChild(box);
    push(card);
  }

  /**
   * 发一条消息：**配了密钥走模型，没配走本地规则**。
   *
   * 两条路终点是同一个 `/commands/execute`（确认卡之后），所以落库、指令日志、广播完全一致；
   * 区别只在"谁来理解这句话"。AI 调用失败时**不会偷偷退回规则解析** —— 那会让人以为用了模型，
   * 所以失败卡片上给一个显式的「改用本地规则」按钮。
   */
  async function send(text) {
    const content = String(text ?? '').trim();
    // `/com` 是**用户指令**：命中后改走"压缩"这个动作，**不发给模型**（见 COMPACT_COMMAND 的说明）。
    // 放在最前面是为了"一个字都不落库"：它不该在对话流里留下一条用户消息。
    if (ContextMeter.isCompactCommand(content)) return compactContext();
    const files = state.attachments;
    if (!content && !files.length) return;
    if (files.length && !state.ai.available) {
      toast('附件要配了 AI 才能解析，先去掉或去「设置 → AI 接入」填密钥');
      return;
    }
    // 附件所有权已经交给这条消息：**无论立刻发还是排队**，都先把待发区清掉（避免下一条又带一遍）
    state.attachments = [];
    renderAttachments();
    /**
     * 一轮还没跑完：**不打断它**，把这条放进队列。
     *
     * 为什么不直接再发一个请求：同一会话服务端本来就串行，第二条 HTTP 会一直挂着不返回，
     * 屏幕上于是同时出现"上一轮还在写 + 下一轮在转圈"（到底哪个在跑？），
     * 而且请求一旦发出去就撤不回来了 —— 排队则把"什么时候发"留在用户手里（chip 上的 ×）。
     * 用户气泡也要等**真正发出**时才落，否则界面上会出现"说过了"但队列里还等着的一份。
     */
    if (state.round) {
      enqueueMessage({ text: content, files });
      return null;
    }
    return startRound({ text: content, files });
  }

  /**
   * 开一轮：落用户气泡 → 交给模型或本地规则 → 无论怎么结束都走 `finishRound`（接力队列）。
   *
   * `state.round` 是"当前这一轮"的唯一标志：排队要不要排、停止按钮亮不亮、
   * 队列什么时候接力，全都看它。`token` 用来识别"这还是不是我开的那一轮"
   * —— 切换会话会把旧回合作废（见 clearChatLog），而那条 HTTP 请求取消不了。
   */
  async function startRound(item) {
    const token = {};
    state.round = { token, ai: Boolean(state.ai.available), conversationId: state.conversationId ?? null, text: item.text };
    paintStopButton();
    bubble('user', item.text, item.files ?? []);
    try {
      if (state.ai.available) await runAiChat(item.text, item.files ?? [], state.round);
      else await runLocalRules(item.text);
    } finally {
      finishRound(token);
    }
  }

  /**
   * 收一轮：清掉运行态（停止按钮随之收起），队列非空就把**队首**接着发出去。
   *
   * 为什么在这里发下一条，而不是在 `chat_stopped` 那个广播里发：服务端收到停止后还要把
   * `status:"stopped"` 的那条消息落库，紧接着发的下一条只会排在它后面干等；
   * 而 `/ai/chat` 的响应回来时，这一轮才真的结束（顺序与到达顺序都不变）。
   */
  function finishRound(token) {
    if (state.round?.token !== token) {
      /**
       * 被"切换会话"作废的旧回合回来了。用户可能已经切回那个会话 —— 他看到的会是
       * "话说到一半"的旧界面，所以补画一次；还在别的会话就不打扰（那条消息下次打开自然会看到）。
       */
      const orphan = state.orphan;
      if (orphan?.token === token) {
        state.orphan = null;
        /**
         * 只在**当前这个会话没有别的回合在跑**时才补画：补画走的是 openConversation，
         * 它会清空聊天栏 —— 如果此刻用户又在这个会话里问了一句（新回合正在流式输出），
         * 这一下会把新回合的气泡和停止按钮一起抹掉，比"少画一条旧消息"严重得多。
         */
        if (orphan.conversationId && orphan.conversationId === state.conversationId && !state.round) {
          void openConversation(orphan.conversationId, { silent: true });
        }
      }
      return;
    }
    state.round = null;
    state.plan = null;
    state.stopWanted = false;
    paintStopButton();
    const next = state.queue.shift();
    paintQueueBar();
    // 依次发完：用户在中途点了停止也只停"正在跑的那一轮"，队列里的照发（B 的契约）
    if (next) void startRound(next);
  }

  /** 本地规则解析（原路径，AI 不可用时的降级）。 */
  async function runLocalRules(content) {
    const pending = systemNote('正在解析…', 'pending');
    try {
      const preview = await api('/commands/run', { method: 'POST', body: { text: content, dryRun: true } });
      pending.remove();
      if (preview.action === 'query') queryCard(preview);
      else draftCard(preview);
    } catch (error) {
      pending.remove();
      errorCard(error);
    }
  }

  /**
   * AI 对话：先落一个空气泡，增量到达时往里追加（WebSocket `ai_delta`），
   * HTTP 返回后以最终文本定稿，再渲染草稿确认卡。
   *
   * `round` 是开这一轮时登记的运行态（见 startRound）：只在它**仍是当前这一轮**时，
   * 才允许把服务端回话里的会话 id 写回界面 —— 用户中途换了会话的话，
   * 这条迟到的响应会把界面硬拽回旧会话（"我明明点开了另一条对话，它自己跳回去了"）。
   */
  async function runAiChat(content, files = [], round = state.round) {
    const card = bubble('bot', '');
    const textEl = card.querySelector('.bubble-text');
    textEl.textContent = '正在思考…';   // 尚未有内容时先给占位，第一块增量到达就被覆盖
    // conversationId 也记在流式对象里：停止按钮要拿它去 POST /ai/chat/stop，
    // 而"首条消息刚发出"的那一刻 state.conversationId 还是 null（id 只在广播/响应里给）
    const streaming = {
      messageId: null,
      conversationId: state.conversationId ?? null,
      text: '',
      node: textEl,
      done: false,
      stopped: false,
    };
    state.streaming = streaming;
    try {
      const result = await api('/ai/chat', {
        method: 'POST',
        body: {
          text: content,
          conversationId: state.conversationId ?? undefined,
          stream: true,
          context: { view: state.view },
          attachments: files.map((file) => ({
            name: file.name,
            type: file.type,
            size: file.size,
            dataUrl: file.dataUrl,
            text: file.text,
          })),
          thinking: state.thinking,
          permission: state.permission,
          // 联网通道（off / web / campus）：后端据此决定这轮要不要真的出网并读取网页
          search: state.search,
        },
      });
      const current = !round || state.round?.token === round.token;
      if (current) {
        setConversationId(result.conversation?.id ?? state.conversationId);
        if (result.conversation?.id) round.conversationId = result.conversation.id;
      }
      streaming.done = true;
      textEl.classList.remove('streaming');
      /**
       * 被停止的这一轮：服务端返回 `stopped:true` + **停止前那半段正文**（不是错误）。
       * 正文取"屏幕上已经有的"和"落库的那份"里更长的那个 —— 停止瞬间可能还有一片增量在飞，
       * 用短的那份会把用户已经看到的字**吞掉**（他会以为停止把内容弄丢了）。
       * 另外：停止是用户自己的决定，这一轮**不再补画草稿确认卡**（"别弄了"之后又冒出一个
       * 待确认的写操作，等于没停）；已经自动执行掉的写操作仍然照常回执（那是真改了数据）。
       */
      const stoppedRound = result.stopped === true || result.assistant?.status === 'stopped';
      const saved = String(result.assistant?.content ?? '');
      if (stoppedRound) markStoppedBubble();
      setBubbleText(textEl, (stoppedRound && streaming.text.length > saved.length ? streaming.text : saved) || '（模型没有返回内容）');
      // 思维链兜底：流式没收到（或只收到一半）就用落库的那份
      const reasoning = String(result.assistant?.reasoning ?? '').trim();
      if (reasoning && (!state.reasoningNode || state.reasoningNode.text.length < reasoning.length)) {
        if (!state.reasoningNode) state.reasoningNode = ensureReasoningCard();
        state.reasoningNode.text = reasoning;
        state.reasoningNode.body.textContent = reasoning;
      }
      if (state.reasoningNode) {
        /**
         * 思考卡要排在**清单卡之前**（顺序固定为「思考 → 清单 → 正文」）：
         * 清单卡是先插进去的（见 handlePlan），所以这里以它为锚点，而不是直接插到正文前面
         * —— 否则后到的思考链会把"它做了哪几步"挤到上面去。
         */
        const anchor = state.plan?.bubble === card ? state.plan.card : card;
        if (card.parentNode) dom.chatLog.insertBefore(state.reasoningNode.card, anchor);
        state.reasoningNode = null;
      }
      /**
       * 检索轮数到上限：必须说出来。
       *
       * 实测过：问"缓考怎么申请"时模型连着查了 6 次，第 5 轮被上限截断，
       * 界面上只留下一句"我再把原文读一遍…"—— 用户以为它没答完，其实它是**被系统掐断的**。
       * 说清楚之后，用户知道"再问一句就能接着查"，而不是以为助手敷衍。
       */
      if (result.roundLimit) {
        systemNote('这次的多轮检索到上限了（模型还想接着查）—— 再问一句「继续」就能接着往下查', 'meta');
      }
      // 长对话被压缩过：说一句。用户有权知道"较早的内容只剩摘要"，
      // 否则某天发现助手忘了开头说过的话，只会以为它不靠谱
      if (result.compacted?.active && result.compacted?.covered) {
        systemNote(`较早的 ${result.compacted.covered} 条对话已压缩成摘要（约 ${result.compacted.chars} 字）继续带着`, 'meta');
      }
      // 只读查询由后端自动执行了：把数据原样列出来（模型的话可能概括得太粗，用户要看的是具体条目）
      for (const text of result.warnings ?? []) systemNote(text, 'fail');
      const queried = result.queried ?? [];
      for (const entry of queried) {
        if (entry.result) queryCard(entry.result);
        else if (entry.error) systemNote(`查询没成功：${entry.error.message}`, 'fail');
      }
      // 「自动审批」：写操作已经在服务端执行掉了，这里给回执（用户仍然看得见做了什么）
      for (const item of result.executed ?? []) {
        if (item.error) systemNote(`自动执行失败：${item.error.message}`, 'fail');
        else resultCard({ ...item.result, explain: `${item.result.explain ?? '已自动执行'}（自动审批）` });
      }
      // 被停止的那一轮不补画草稿确认卡：用户刚说"别弄了"，再给他一个待确认的写操作等于没停
      const drafts = stoppedRound ? [] : (result.drafts ?? []);
      for (const entry of drafts) renderAiDraft(entry);
      // 这一轮刚产生真实 usage：圆环的 used 优先取它，所以必须跟着回复一起刷新
      // （与「用量」共用同一个时机，不另起定时器）
      void refreshUsageBadge();
      void refreshContextMeter();
      if (stoppedRound) {
        // 说清"停在哪里"：被停止不是答完，气泡里只有到这里为止的那一段
        systemNote('已停止这一轮：上面是停止前生成的内容', 'meta');
      } else if (!drafts.length && !queried.length && !(result.executed ?? []).length) {
        systemNote(`${state.ai.provider ?? 'AI'} · 只是聊天，没有产生任何写入`, 'meta');
      }
      keepBodyLast(card);
    } catch (error) {
      streaming.done = true;
      textEl.classList.remove('streaming');
      // 失败时后端已经把部分内容落库了：气泡里保留收到的那部分，不假装什么都没发生
      if (!streaming.text) card.remove();
      else setBubbleText(textEl, streaming.text);
      if (state.reasoningNode) {
        state.reasoningNode.card.querySelector('.op-title').textContent = '（这次没成功）';
        state.reasoningNode = null;
      }
      const details = error?.payload?.error?.details ?? {};
      if (details.conversationId) setConversationId(details.conversationId);
      errorCard(error, { retry: content });
      keepBodyLast(card);
    } finally {
      if (state.streaming === streaming) state.streaming = null;
    }
  }

  /**
   * 把正文气泡挪到这一轮的最后。
   *
   * 一轮回复里会先冒出操作卡（查看日程 / 新建待办的确认卡），如果正文停在最上面，
   * 卡片一多、一展开就把**结论挤到屏幕外**去了 —— 而人最想第一眼看到的是结论。
   * 所以顺序固定为「操作卡在上，正文在下」：结论永远在最后，且滚到底就能看见。
   */
  function keepBodyLast(card) {
    if (!card || !card.parentNode) return;
    dom.chatLog.appendChild(card);
    followBottom();
  }

  /**
   * 把一条模型草稿渲染成确认卡。
   * - 通过校验的：复用本地规则那张卡（`entry.draft.fields` 是模型原样给的字段）；
   * - 没通过的：只显示问题，**不给确认按钮** —— 点了也会 400，不如直接说清楚哪里不对。
   */
  function renderAiDraft(entry) {
    const draft = { ...(entry.draft ?? {}), provider: 'ai' };
    if (!entry.error) {
      draftCard({ ...(entry.preview ?? {}), draft });
      return;
    }
    const card = mk('div', 'bubble bot has-card');
    const box = mk('div', 'chat-card fail');
    box.appendChild(mk('div', 'cc-title', '这条草稿没过校验，没有执行'));
    box.appendChild(mk('div', 'cc-explain', entry.error.message ?? '未知问题'));
    if (entry.error.details?.field) box.appendChild(mk('div', 'cc-meta', `字段：${entry.error.details.field}`));
    const fields = draft.fields ?? {};
    if (Object.keys(fields).length) box.appendChild(fieldRows(fields));
    box.appendChild(mk('div', 'cc-note', '换个说法再试一次。'));
    card.appendChild(box);
    push(card);
  }

  /* ============================================================ 排队 / 停止 / 过程清单
   *
   * 这三件事共用同一个事实：**"当前这一轮到底跑完没有"**（`state.round`）。
   * 拆成三套判断（"在流式吗" / "按钮亮着吗" / "清单还转圈吗"）迟早会互相打架，
   * 表现成"上一轮明明结束了，下一条却还在排队"这类没法复现的怪状态。
   */

  /** chip 上显示几个字：够认出是哪一条就行，再多会把排队条撑爆（手机上尤其明显）。 */
  const QUEUE_PREVIEW = 20;
  /** 排队上限：内存态，但也得有个顶 —— 无上限等于把"AI 已经跟不上了"这件事藏起来。 */
  const QUEUE_LIMIT = 20;

  /**
   * chip 上的那句话：**前 20 字 + 入队序号**（序号是"第几条排队的"，取消后不重排，
   * 否则 chip 会自己换位置，用户刚看清是哪条、一转眼号就变了）。
   * 只有附件没有文字时如实说附件数量 —— 空白 chip 等于没给任何线索。
   */
  function queuePreview(item) {
    const text = String(item?.text ?? '').replace(/\s+/g, ' ').trim();
    const files = item?.files?.length ?? 0;
    if (!text) return files ? `（${files} 个附件）` : '（空消息）';
    return `${text.slice(0, QUEUE_PREVIEW)}${text.length > QUEUE_PREVIEW ? '…' : ''}`;
  }

  /**
   * 渲染排队条。`host` / `items` / `onCancel` 都可以传进来 —— 渲染层测试不必启动整个外壳
   * （与 `__PC_SCROLL__` 同一口径：这是给测试用的缝，不是给视图用的 API）。
   */
  function renderQueueBar(host, items = [], onCancel = null) {
    if (!host) return;
    host.textContent = '';
    if (!items.length) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    // 多条时给一句总数：光数 chip 数不清"到底还排着几条"（尤其换行之后）
    if (items.length > 1) host.appendChild(mk('span', 'queue-count', `${items.length} 条排队中`));
    const chips = mk('div', 'queue-chips');
    for (const item of items) {
      const chip = mk('div', 'queue-chip');
      chip.appendChild(mk('span', 'queue-chip-seq', String(item.seq ?? '')));
      const text = mk('span', 'queue-chip-text', queuePreview(item));
      // chip 只显示前 20 字，鼠标停一下能看到完整原文；不做"编辑队列里的消息"（见 README 的取舍）
      text.title = String(item.text ?? '');
      chip.appendChild(text);
      const cancel = mk('button', 'queue-chip-x', '×');
      cancel.type = 'button';
      cancel.title = '取消这条排队消息';
      cancel.setAttribute('aria-label', `取消排队：${queuePreview(item)}`);
      // 取消只丢这一条，**不碰正在跑的那一轮** —— 排队条里没有"停止"这个动作
      cancel.addEventListener('click', () => (onCancel ?? cancelQueued)(item.id));
      chip.appendChild(cancel);
      chips.appendChild(chip);
    }
    host.appendChild(chips);
  }

  function paintQueueBar() {
    renderQueueBar(dom.chatQueue, state.queue, cancelQueued);
  }

  function enqueueMessage({ text, files = [] }) {
    if (state.queue.length >= QUEUE_LIMIT) {
      toast(`排队最多 ${QUEUE_LIMIT} 条：先等它答完，或点掉几条再说`);
      return null;
    }
    state.queueSeq += 1;
    const item = { id: `q${state.queueSeq}`, seq: state.queueSeq, text, files };
    state.queue.push(item);
    paintQueueBar();
    return item;
  }

  function cancelQueued(id) {
    const index = state.queue.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const [removed] = state.queue.splice(index, 1);
    paintQueueBar();
    toast(`已取消排队：${queuePreview(removed)}`);
    return true;
  }

  /** 清空队列并**返回清掉几条**（切换会话要据此说一句，见 clearChatLog）。 */
  function clearQueue() {
    const dropped = state.queue.length;
    state.queue = [];
    state.queueSeq = 0;
    paintQueueBar();
    return dropped;
  }

  /* ------------------------------------------------------------ 停止本轮 */

  /**
   * 发送按钮 ↔ 停止按钮：**同一个位置，按"当前有没有一轮在跑"顶替**。
   *
   * 只按 `state.round` 画，三个隐藏时机（`/ai/chat` 响应、`ai_message`、`chat_stopped`）
   * 各自把状态清掉就行 —— 四处各写一遍 DOM 操作，漏一处就是"按钮永远停在那儿"。
   * 只对 AI 回合显示：没配密钥时走的是本地规则解析（毫秒级），给它一个"停止"是假按钮。
   */
  function paintStopButton() {
    const active = Boolean(state.round?.ai);
    if (dom.chatStop) {
      dom.chatStop.hidden = !active;
      dom.chatStop.disabled = !active || state.stopWanted;
      dom.chatStop.classList.toggle('pending', active && state.stopWanted);
    }
    if (dom.chatSend) dom.chatSend.hidden = active;
  }

  /**
   * 停止本轮：`POST /ai/chat/stop`。
   *
   * **"当前没有在跑的回合"不是错误**：服务端这时返回 `{ok:true, stopped:false, reason:'idle'}`，
   * 界面顶多提示一句「当前没有正在进行的回合」。用户连点两下停止、或者消息刚好答完，
   * 都不该看到一张红色失败卡 —— 那会让人以为"停止"这个功能坏了。
   */
  async function stopRound() {
    const conversationId = state.streaming?.conversationId ?? state.round?.conversationId ?? state.conversationId ?? null;
    if (!conversationId) {
      /**
       * 极窄窗口：回合已经在服务端登记，但我们还没从任何一条广播/响应里拿到会话 id
       * （一轮的第一条消息刚发出时就是这样）。这里不能静默失败，也不能瞎编一个 id：
       * 记下"想停"，等 `ai_delta` 到达（它带着 conversationId）立刻补发。
       */
      state.stopWanted = true;
      paintStopButton();
      return { ok: false, reason: 'no_conversation_yet' };
    }
    state.stopWanted = false;
    paintStopButton();
    try {
      const result = await api('/ai/chat/stop', { method: 'POST', body: { conversationId } });
      if (result?.stopped === false) toast('当前没有正在进行的回合');
      /**
       * 真打断了也**不在这里收尾**：服务端马上会广播 `chat_stopped`、并把这条消息落成
       * `status:"stopped"`（保留停止前那半段正文）。界面等那两个信号再收
       * —— 自己提前收的话，会出现"按钮已经变回发送、正文还在往外冒"。
       */
      return result;
    } catch (error) {
      state.stopWanted = false;
      paintStopButton();
      toast(`停止没能发出去：${error.message}`);
      return { ok: false, error };
    }
  }

  /**
   * 把"被停止"画在气泡上：**中性样式的小标记「已停止」**，不是错误卡、不用红色。
   * 停止是用户自己的决定，不是程序出事；而且服务端把那半段正文原样留着（见 chat-service 的
   * `#saveStopped`），界面要继续显示它 —— 抹掉的话用户会觉得"我明明看到它写了半段，一按停止连话都没了"。
   */
  function markStoppedBubble() {
    const streaming = state.streaming;
    if (!streaming) return null;
    streaming.done = true;
    streaming.stopped = true;
    streaming.node?.classList?.remove('streaming');
    const bubbleEl = streaming.node?.parentNode ?? null;
    // 幂等：`chat_stopped` 与 `/ai/chat` 的响应都会走到这里，标记只能有一个
    if (bubbleEl && !bubbleEl.querySelector?.('.bubble-stop')) {
      bubbleEl.appendChild(mk('div', 'bubble-stop', '已停止'));
      followBottom();
    }
    return bubbleEl;
  }

  /**
   * "这一轮在界面上结束了"：收掉停止按钮、让流式气泡不再接收迟到的分片。
   *
   * 契约里的三个隐藏时机（`/ai/chat` 响应、`ai_message`、`chat_stopped`）都走这一个函数。
   * 为什么广播一到就先收：它比 HTTP 响应早几十毫秒，按钮在这段时间里还亮着，
   * 用户会再点一次 —— 那一下打在已经收尾的回合上，只能得到 idle，看起来就是"停止不管用"。
   */
  function endRoundUI(payload = {}) {
    const streaming = state.streaming;
    const messageId = payload?.message?.id ?? payload?.messageId ?? null;
    /**
     * 定时任务往**当前会话**里写回复时也会广播 `ai_message`：那不是用户这一轮，
     * 不能让它把用户的流式气泡和停止按钮一起收掉（messageId 不同就是别人那一轮）。
     */
    if (streaming?.messageId && messageId && messageId !== streaming.messageId) return false;
    if (streaming) {
      streaming.done = true;
      streaming.node?.classList?.remove('streaming');
    }
    state.stopWanted = false;
    /**
     * 这里**不**清 `state.plan`：清单卡还要留作"思考卡插在谁前面"的锚点
     * （`/ai/chat` 的响应可能比这条广播晚几十毫秒到，那时代码还要按「思考 → 清单 → 正文」排版）。
     * 真正的清理在 `finishRound`（这一轮真的结束）和 `clearChatLog`（换会话）里。
     */
    if (dom.chatStop) {
      dom.chatStop.hidden = true;
      dom.chatStop.disabled = true;
      dom.chatStop.classList.remove('pending');
    }
    if (dom.chatSend) dom.chatSend.hidden = false;
    return true;
  }

  /** WS `chat_stopped`：停止这一刻的收尾（`messageId` 可能是 null，见下面的判断）。 */
  function handleChatStopped(payload = {}) {
    // 别的会话的停止与我无关；**是不是这一轮**用 messageId 判（可能为 null，那就当"就是这一轮"）
    if (payload.conversationId && state.conversationId && payload.conversationId !== state.conversationId) return;
    if (state.streaming?.messageId && payload.messageId && payload.messageId !== state.streaming.messageId) return;
    markStoppedBubble();
    endRoundUI();
    // 队列**不在这里发下一条**：服务端此刻还在把 stopped 那条消息落库，
    // 早发只会让下一条排在它后面干等；统一交给 /ai/chat 的响应收尾（见 finishRound）。
  }

  /* ------------------------------------------------------------ 过程清单（AI 的 todolist） */

  /** 步骤状态 → 图标与无障碍文案（○ 待处理 / ◐ 进行中 / ✓ 已完成 / ✕ 失败）。 */
  const PLAN_ICON = { pending: '○', running: '◐', done: '✓', failed: '✕' };
  const PLAN_STATUS_TEXT = { pending: '待处理', running: '进行中', done: '已完成', failed: '失败' };
  const PLAN_TERMINAL = new Set(['done', 'failed']);

  /** 服务端的 steps 是**全量快照**：这里整体归一化后重画，不做增量合并（少一类"漏一条就画错"的 bug）。 */
  function planSteps(steps) {
    return (Array.isArray(steps) ? steps : [])
      .filter((step) => step && typeof step === 'object')
      .map((step, index) => ({
        id: String(step.id ?? index),
        label: String(step.label ?? '').trim() || '（未命名步骤）',
        status: PLAN_ICON[step.status] ? step.status : 'pending',
      }));
  }

  /** 收起后的那一行字：还在跑就说"正在做什么"，跑完了说"已完成 N 步"。 */
  function planSummary(steps) {
    const total = steps.length;
    const done = steps.filter((step) => step.status === 'done').length;
    const failed = steps.filter((step) => step.status === 'failed').length;
    const running = steps.find((step) => step.status === 'running');
    if (running) return `正在做：${running.label}`;
    // 一步都没成（比如刚开跑就被停止）：别写"已完成 0 步"，那读起来像在敷衍
    if (failed) return done ? `已完成 ${done} 步 · ${failed} 步失败` : `${failed} 步失败`;
    if (total && done === total) return `已完成 ${total} 步`;
    return `共 ${total} 步`;
  }

  /**
   * 一张清单卡：标题行（可点）+ 明细。
   *
   * 为什么全部结束就**收成一行**：一轮跑完会留下五六行步骤，历史消息一多，屏幕上全是清单，
   * 用户真正想看的正文反而要滚半天。明细没有被删掉，点一下标题就回来 —— 收起只是默认姿态。
   * 而"用户手动开/关过"之后就**不再自动**改：他刚点收起、下一份快照又弹开，会以为点不动。
   */
  function createPlanCard(initial = []) {
    const card = mk('div', 'bubble bot has-card');
    const box = mk('div', 'chat-card op-card plan-card');
    const head = mk('button', 'op-head');
    head.type = 'button';
    const title = mk('span', 'op-title', '步骤');
    head.append(mk('span', 'op-chip', '步骤'), title, mk('span', 'op-caret', '›'));
    const body = mk('div', 'op-body');
    box.append(head, body);
    card.appendChild(box);

    let manual = null;
    let current = [];

    const applyOpen = (open) => {
      box.classList.toggle('open', open);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    const setSteps = (steps) => {
      current = planSteps(steps);
      const terminal = current.length > 0 && current.every((step) => PLAN_TERMINAL.has(step.status));
      applyOpen(manual ?? !terminal);
      title.textContent = planSummary(current);
      // 整体重画：全量快照进来就把每一行按最新状态重写（running → done 都靠这一次）
      body.textContent = '';
      for (const step of current) {
        const row = mk('div', `plan-step ${step.status}`);
        const icon = mk('span', 'plan-step-icon', PLAN_ICON[step.status]);
        icon.title = PLAN_STATUS_TEXT[step.status];
        row.append(icon, mk('span', 'plan-step-label', step.label));
        body.appendChild(row);
      }
    };
    head.addEventListener('click', () => {
      const open = !box.classList.contains('open');
      manual = open;
      applyOpen(open);
    });
    setSteps(initial);
    return { card, setSteps, isOpen: () => box.classList.contains('open'), summary: () => planSummary(current) };
  }

  /**
   * WS `plan`：把这一轮的过程清单画进**当前正在接收的那条 assistant 消息**里。
   *
   * 位置固定在「思考卡之后、正文之前」：正文永远在最底下（`keepBodyLast` 那条规则），
   * 清单是"它做了哪几步"，属于过程，不该把结论顶到屏幕外。
   * 同一 `messageId` 只维护**一张**卡：服务端每次都是全量快照，整体重画即可。
   */
  function handlePlan(payload = {}) {
    const steps = planSteps(payload.steps);
    // 纯聊天不会有 plan（服务端契约）；空快照也不建卡，否则先冒出一个空壳再等它填
    if (!steps.length) return;
    if (payload.conversationId && state.conversationId && payload.conversationId !== state.conversationId) return;
    const streaming = state.streaming;
    if (!streaming) return; // 没有正在接收的气泡：这份清单没有地方挂（别的会话 / 定时任务那一轮）
    // 同一个会话里可能同时有别人那一轮的清单（定时任务），messageId 不同就不是我们的
    if (streaming.messageId && payload.messageId && payload.messageId !== streaming.messageId) return;
    streaming.messageId = streaming.messageId ?? payload.messageId ?? null;
    streaming.conversationId = payload.conversationId ?? streaming.conversationId ?? null;
    if (state.plan && state.plan.messageId === streaming.messageId) {
      state.plan.setSteps(steps);
    } else {
      const created = createPlanCard(steps);
      const bubbleEl = streaming.node?.parentNode ?? null;
      state.plan = { messageId: streaming.messageId, bubble: bubbleEl, ...created };
      if (bubbleEl?.parentNode) dom.chatLog.insertBefore(created.card, bubbleEl);
    }
    followBottom();
  }

  /* ------------------------------------------------------------ 输入区扩展 */

  /** 待发送附件：小卡片列表（图片给缩略图，其它给文件名与大小）。 */
  function renderAttachments() {
    const host = dom.chatAttachments;
    if (!host) return;
    host.replaceChildren();
    host.hidden = state.attachments.length === 0;
    state.attachments.forEach((file, index) => {
      const chip = mk('span', 'attach-chip');
      if (file.type?.startsWith('image/') && file.dataUrl) {
        const img = mk('img');
        img.src = file.dataUrl;
        img.alt = file.name;
        chip.appendChild(img);
      } else {
        chip.appendChild(mk('span', 'attach-kind', file.type?.startsWith('image/') ? '🖼' : '📄'));
      }
      chip.append(
        mk('span', 'attach-name', file.name),
        mk('span', 'attach-size', formatSize(file.size)),
      );
      const remove = mk('button', 'attach-del', '×');
      remove.type = 'button';
      remove.title = '移除';
      remove.addEventListener('click', () => {
        state.attachments.splice(index, 1);
        renderAttachments();
      });
      chip.appendChild(remove);
      host.appendChild(chip);
    });
  }

  /** 读一个文件：图片/文本读成 dataURL/文本，其它只留元信息（给模型知道有这么个文件）。 */
  function readFile(file) {
    return new Promise((resolve) => {
      const base = { name: file.name, type: file.type, size: file.size, dataUrl: '', text: '' };
      const isImage = file.type.startsWith('image/');
      const isText = /^text\//.test(file.type) || /\.(txt|md|markdown|csv|json|ya?ml|log|ini|tex)$/i.test(file.name);
      if (!isImage && !isText) return resolve(base);
      if (isImage && file.size > 4 * 1024 * 1024) {
        toast(`${file.name} 超过 4MB，图片先不放了`);
        return resolve({ ...base, type: file.type });
      }
      const reader = new FileReader();
      reader.onerror = () => resolve(base);
      reader.onload = () =>
        resolve(isImage ? { ...base, dataUrl: String(reader.result ?? '') } : { ...base, text: String(reader.result ?? '') });
      if (isImage) reader.readAsDataURL(file);
      else reader.readAsText(file);
      return undefined;
    });
  }

  async function addFiles(list) {
    const picked = [...(list ?? [])].slice(0, 8);
    for (const file of picked) {
      if (state.attachments.length >= 8) {
        toast('最多 8 个附件');
        break;
      }
      const record = await readFile(file);
      // 官方只认 JPEG/PNG/GIF/WebP（按内容判断），其它格式上游会 400 —— 提前说清楚
      if (record.type.startsWith('image/') && !VISION_IMAGE_TYPES.includes(record.type)) {
        toast(`${record.name} 的图片格式不支持（只认 PNG/JPEG/GIF/WebP），已作为普通文件附上`);
      }
      state.attachments.push(record);
    }
    renderAttachments();
  }

  /**
   * 通用「向上展开」选择器。
   *
   * 菜单用绝对定位挂在按钮上方（CSS 的 `bottom: 100%`），**不参与布局** ——
   * 所以展开时输入框那一行不会跟着往上跳（这是明确要求）。
   *
   * 文字 chip（思考模式）与图标按钮（联网 / 权限 / 用量）共用这一份实现：
   * ✓ 勾选、`hint` 脚注、点外部关闭这些行为只写一遍，不会两套菜单各长一样。
   *
   * @param {{ prefix?: string, value: string, options: Array, hint?: string, onChange?: Function,
   *           icon?: string, control?: string, className?: string, title?: (label: string, value: string) => string,
   *           buttonTitle?: string, buttonContent?: (button: HTMLButtonElement) => void }} config
   *   - `prefix`：文字 chip 的前缀（如「思考模式」）；给 `icon` 时不要传，按钮里只有图标；
   *   - `icon`：画成图标按钮（`compose-icon-btn`），与文字 chip 共用菜单；
   *   - `control`：给图标按钮打 `data-control` 标记，供 `paintControlStates()` 认按钮（不按下标取）；
   *   - `className`：追加到 `.compose-select` 上的类（右组用 `align-right` 让菜单靠右，别顶出面板）；
   *   - `title(label, value)`：每次选中后重算 `title` / `aria-label`。图标按钮必须给 ——
   *     图标本身说不出当前档位，这行提示是用户唯一能看到的说明；
   *   - `buttonContent(button)`：调用方自己往按钮里塞节点（比如用量那个随请求更新的数字）。
   */
  function composeSelect({
    prefix,
    value,
    options,
    hint,
    onChange,
    icon,
    control,
    className,
    title,
    buttonTitle,
    buttonContent,
  }) {
    const wrap = mk('div', `compose-select${className ? ` ${className}` : ''}`);
    const button = mk('button', icon ? 'compose-icon-btn' : '');
    button.type = 'button';
    if (control) button.dataset.control = control;
    let current = null;
    if (icon) {
      // 图标只是装饰（PCIcons 生成的 svg 自带 aria-hidden），名字由 title / aria-label 给
      button.appendChild(composeIcon(icon));
    } else {
      current = mk('span', 'cs-value');
      button.append(mk('span', 'cs-label', prefix), current, mk('span', 'cs-caret', '▴'));
    }
    buttonContent?.(button);

    const menu = mk('div', 'compose-menu');
    const paint = () => {
      const found = options.find((item) => item.value === value) ?? options[0];
      if (current) current.textContent = found.label;
      // 当前项**只靠这一处标出**：整行蓝色 + 淡蓝底（见 shell.css 的 .compose-menu button.active）。
      // 以前还在行首放一个 ✓，结果是"空勾"那一行高度为 0、选中那一行是个 19px 的字，
      // 行高在选中项上被撑出细微差别，看起来就是勾和高光没对齐 —— 索性去掉勾，只留高光。
      for (const node of menu.querySelectorAll('button')) node.classList.toggle('active', node.dataset.value === value);
      const text = title ? title(found.label, value) : buttonTitle;
      if (text) {
        button.title = text;
        button.setAttribute('aria-label', text);
      }
    };

    for (const option of options) {
      const item = mk('button');
      item.type = 'button';
      item.dataset.value = option.value;
      item.append(mk('span', null, option.label));
      if (option.hint) item.title = option.hint;
      item.addEventListener('click', () => {
        value = option.value;
        paint();
        close();
        onChange?.(option.value);
      });
      menu.appendChild(item);
    }
    if (hint) menu.appendChild(mk('div', 'cm-hint', hint));

    const close = () => wrap.classList.remove('open');
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const open = wrap.classList.contains('open');
      for (const other of document.querySelectorAll('.compose-select.open')) other.classList.remove('open');
      wrap.classList.toggle('open', !open);
    });
    wrap.append(button, menu);
    menu.addEventListener('click', (event) => event.stopPropagation());
    paint();
    return wrap;
  }

  // 官方 reasoning_effort 只有 none / low / high / max（medium 只是别名，会映射成 high，
  // 所以这里不摆"中"—— 界面写"中"、上游按"高"算，那种对不上号的档位不如不给）
  const THINKING_OPTIONS = [
    { value: 'none', label: '无', hint: '关闭思考模式：最快最省（必须显式传 none，官方默认是开的）' },
    { value: 'low', label: '低' },
    { value: 'high', label: '高', hint: '官方默认档' },
    { value: 'max', label: '最高', hint: '想得最久，也最贵' },
  ];
  const PERMISSION_OPTIONS = [
    { value: 'auto', label: '自动审批', hint: '写操作直接执行 —— 风险自负' },
    { value: 'manual', label: '手动审批', hint: '只读查询自动跑，写操作点确认' },
    { value: 'strict', label: '全部确认', hint: '连查询也要点确认' },
  ];
  /** 权限菜单的脚注（底部提示的兜底文案也用它，别写第二份）。 */
  const PERMISSION_HINT = '「自动审批」会替你点确认，只建议在能撤得回来的场合用';

  /**
   * 联网搜索的三个选项。
   *
   * `hint` 里把「校内 / 校外」的区别说清楚：这两个通道走的是完全不同的入口、能拿到的东西也不一样，
   * 用户在菜单里就该看到，而不是选完再猜。**它们都是真的会出网**（见 modules/ai/web-search.js）：
   * 校外 = 全网检索；校内 = 优先在校内站点自己的搜索里找，再并走公网。
   *
   * 这里不再写"检索通道还没接入"——那句话在联网做实之后就成了误导（用户会以为选了也没用）。
   */
  const SEARCH_OPTIONS = [
    { value: 'off', label: '不联网', hint: '只用本地数据与模型已有知识' },
    { value: 'web', label: '从校外网搜索', hint: '全网检索：搜到的网页会抓正文，回答要带出处链接' },
    { value: 'campus', label: '从校内网搜索', hint: '先查校内站点（教务/图书馆/学院/书院），再并走公网' },
  ];

  /* ------------------------------------------------------------ 本地小状态 */

  /**
   * 读回持久化的小状态（权限档位 / 联网通道）。
   *
   * 以前权限只活在内存里，刷新就回「手动审批」—— 用户会以为自己的选择没生效。
   * 对 localStorage 全程兜底：隐私模式、配额满都可能抛异常，不能让它把启动带崩。
   */
  function readStored(key) {
    try {
      return window.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  function writeStored(key, value) {
    try {
      window.localStorage?.setItem(key, value);
    } catch {
      /* 存不了就算了：本次会话内的行为不受影响 */
    }
  }

  /** 绘图开关的语义：只有明确 `false` 才算关（老配置里没这个字段 = 新版默认开），与后端 `drawMode !== false` 对齐。 */
  const drawOn = () => state.ai.draw !== false;

  /**
   * 输入框下面那一行：**左** = 联网搜索 + 思考模式（这一轮"怎么干活"），
   * **右** = 权限 / 用量 / 绘图三个图标按钮。
   *
   * 右组用 `.spacer`（`margin-left: auto`）推开；菜单一律向上绝对定位，展开不会顶动这一行。
   */
  function renderControls() {
    const host = dom.chatControls;
    if (!host) return;
    host.replaceChildren(
      composeSelect({
        icon: 'globe',
        control: 'search',
        value: state.search,
        options: SEARCH_OPTIONS,
        hint: '选中的通道会随每条消息发给后端，由它决定这轮要不要真的出网；关掉时模型会如实说明没联网',
        // title 用「刚选中的值」而不是 state.search：composeSelect 的 paint() 在 onChange 之前跑，
        // 读全局状态会慢一拍（选完 title 还写着上一个通道）
        title: (label, value) => searchTitle(value),
        onChange: (value) => {
          state.search = value;
          // 持久化：选了「校内网」的人不会每次重开都重选一遍
          writeStored('potato.search', value);
          // 图标颜色就是状态：不重画的话，选完菜单颜色还停在旧通道
          paintControlStates();
          toast(`联网搜索：${SEARCH_OPTIONS.find((item) => item.value === value)?.label ?? value}`);
        },
      }),
      composeSelect({
        prefix: '思考模式',
        value: state.thinking,
        options: THINKING_OPTIONS,
        hint: '映射到上游的 reasoning_effort；不认这个字段的端点会忽略它',
        onChange: (value) => {
          state.thinking = value;
        },
      }),
      mk('span', 'spacer'),
      composeSelect({
        icon: 'shield',
        control: 'permission',
        className: 'align-right',
        value: state.permission,
        options: PERMISSION_OPTIONS,
        hint: PERMISSION_HINT,
        title: (label) => `权限：${label}`,
        onChange: (value) => {
          state.permission = value;
          // 持久化：这是"这一轮允许模型做到哪一步"的授权，刷新就丢最容易出事
          writeStored('potato.permission', value);
          // 图标颜色就是状态：只有「自动审批」是蓝的
          paintControlStates();
        },
      }),
      // 圆环在「用量」左边：左=这一刻上下文有多满，右=累计花了多少，两个数字挨着才好一起读
      contextMeter(),
      usageSelect(),
      drawToggle(),
    );
    paintControlStates();
  }

  /**
   * 按 `data-control` 重画各图标按钮的 `on` 类（蓝 = 开着：联网 / 自动审批 / 绘图）。
   *
   * 用标记查找而不是按下标取：按钮的个数和顺序以后还会变，按下标一旦错位，
   * 表现是"点 A 亮了 B"这种最难查的毛病。用量按钮不在这里 —— 它没有开关态。
   */
  function paintControlStates() {
    const host = dom.chatControls;
    if (!host) return;
    const pick = (name) => host.querySelector(`.compose-icon-btn[data-control="${name}"]`);
    pick('search')?.classList.toggle('on', state.search !== 'off');
    pick('permission')?.classList.toggle('on', state.permission === 'auto');
    pick('draw')?.classList.toggle('on', drawOn());
  }

  /**
   * 「联网搜索」按钮的 title：如实写明当前通道（**它是真的会出网的**，别再写成"还没接入"）。
   *
   * @param {string} [value] 当前通道；默认取 `state.search`（菜单选中那一刻要传刚选的值，见 renderControls）
   */
  function searchTitle(value = state.search) {
    const found = SEARCH_OPTIONS.find((item) => item.value === value) ?? SEARCH_OPTIONS[0];
    return `联网搜索：${found.label} · ${found.hint}`;
  }

  /**
   * 「绘图」开关（蓝色 = 开 / 灰色 = 关）。
   *
   * 它**不是菜单**，所以没有 `.compose-menu`：点一下就把全局 `drawMode` 写回 `/ai/config`，
   * 成功后才改本地状态并重画 —— 与设置页那个勾选框共用后端同一份配置，两边不会打架。
   */
  function drawToggle() {
    const wrap = mk('div', 'compose-select');
    const button = mk('button', 'compose-icon-btn');
    button.type = 'button';
    button.dataset.control = 'draw';
    button.classList.toggle('on', drawOn());
    const paintTitle = () => {
      const text = drawOn()
        ? '绘图：已开启（模型可以输出 ```svg 图）；点一下关掉'
        : '绘图：已关闭；点一下开启（关着时说「画个图」仍可临时触发）';
      button.title = text;
      button.setAttribute('aria-label', text);
    };
    paintTitle();
    button.appendChild(composeIcon('brush'));
    button.addEventListener('click', async () => {
      const next = !drawOn();
      button.disabled = true;
      try {
        const result = await api('/ai/config', { method: 'POST', body: { drawMode: next } });
        // 以后端返回的配置为准（设置页可能同时改过）；响应里没带就退回我们的期望值
        state.ai.draw = result.config?.drawMode ?? next;
        paintTitle();
        renderControls(); // 重画整行：着色与 title 都由 state 推导，手改类名容易漏
        toast(state.ai.draw === false ? '绘图已关闭' : '绘图已开启');
      } catch (error) {
        toast(`改绘图开关失败：${error.message}`);
      }
    });
    wrap.appendChild(button);
    return wrap;
  }

  /** 千分位（数字很长时可读性差别很大）。 */
  const groupDigits = (value) => Number(value || 0).toLocaleString('en-US');

  /* ------------------------------------------------ 上下文占用：圆环 + 明细弹层
   *
   * 数据来自 `GET /ai/context?conversationId=`：`used` **优先是最近一次真实请求的 `prompt_tokens`**
   * （准确、免费），没有真实请求时才退化成按字符估算，并由服务端标 `source: "estimate"`。
   * 这里只做三件事：算百分比 / 画圆环 / 排版明细弹层。
   *
   * 为什么把这几段纯计算抽成一个对象并挂到 window：渲染层是一堆 classic script + IIFE，
   * 没有模块系统；而这些数字正是用户直接读的（千分位、K/M 紧凑写法、百分比、圆环弧长、
   * 三档配色阈值），最容易被后续改动改坏。挂出来之后测试断言的是**同一份实现**，
   * 而不是在测试里再抄一遍公式（抄的那份照样会漂移）。
   */
  const CONTEXT_CATEGORY_LABEL = { system: '系统提示词', tools: '工具定义', history: '对话消息', summary: '摘要' };
  /** 圆环半径（viewBox 32 的正中间留一圈）：周长就是 stroke-dasharray 的满值。 */
  const RING_RADIUS = 13;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

  /** 占用档位：<60 常规（蓝）、60–85 提醒（橙）、>85 警示（红）——颜色由 shell.css 给。 */
  function meterLevel(percent) {
    const value = Number(percent) || 0;
    if (value > 85) return 'hot';
    if (value >= 60) return 'warn';
    return 'ok';
  }

  /** 圆环几何：dasharray = 整圈，dashoffset = 留白的那一段（0% 整圈空、100% 画满）。 */
  function ringDashOf(percent) {
    const clamped = Math.min(100, Math.max(0, Number(percent) || 0));
    return {
      circumference: RING_CIRCUMFERENCE,
      dasharray: RING_CIRCUMFERENCE.toFixed(2),
      dashoffset: (RING_CIRCUMFERENCE * (1 - clamped / 100)).toFixed(2),
    };
  }

  /**
   * token 的紧凑写法：1234 → `1.2K`、135000 → `135K`、1234567 → `1.2M`、999 → `999`。
   *
   * 两条小规矩：不到 1000 就原样给整数（加个 `1.0K` 反而更难读）；
   * **正好是整单位时不补 `.0`**（1_000_000 → `1M`）—— 分母通常就是这种整数，`.0` 只是噪声。
   */
  function compactTokens(value) {
    const number = Math.max(0, Number(value) || 0);
    const scale = (divisor, suffix) => {
      const scaled = number / divisor;
      return `${Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(1)}${suffix}`;
    };
    if (number >= 1_000_000) return scale(1_000_000, 'M');
    if (number >= 1_000) return scale(1_000, 'K');
    return String(Math.round(number));
  }

  /**
   * 界面上的 token 读数。
   *
   * `~` 表示"这是圆整/估算出来的量级"，所以：
   *   - 用量与各分类（`~207.3K` / `~1.5K`）带它；
   *   - **用户自己配置的精确值**（上限）不带（`1M`）—— 写成 `~1M` 会让人以为上限也是估的，
   *     而参照图要表达的是"读数 / 配置"这一对比；
   *   - 不到 1000 的小数字原样给（`11`、`572`），加波浪号没有意义。
   */
  function displayTokens(value, { exact = false } = {}) {
    const number = Math.max(0, Number(value) || 0);
    const text = compactTokens(number);
    return exact || number < 1000 ? text : `~${text}`;
  }

  const ContextMeter = {
    group: groupDigits,
    /** 紧凑写法（不带波浪号） */
    compact: compactTokens,
    /** 界面上显示的读数（圆整过的带 `~`） */
    tokens: displayTokens,

    /**
     * `/com` / `/compact` 判定（大小写不敏感；后面跟参数也算命中）。
     * `send()` 用它决定"这条不发模型"，渲染层测试也断言它（同一个正则，两处不会漂移）。
     */
    isCompactCommand(text) {
      return COMPACT_COMMAND.test(String(text ?? '').trim());
    },

    compact: compactTokens,
    level: meterLevel,
    ringDash: ringDashOf,

    /** 百分比文案：一位小数（与服务端 percent 的口径一致）。 */
    percentText(percent) {
      return `${(Number(percent) || 0).toFixed(1)}%`;
    },

    /**
     * 圆环的 SVG 标记串（用 innerHTML 挂上去，与 composeIcon 同一套做法）。
     *
     * dasharray / dashoffset 写成 **SVG 表现属性**而不是 `style=`：本程序 CSP 是 `style-src 'self'`，
     * 内联样式会被浏览器直接拦掉（同一个坑见 prompt.js 里给模型的绘图规范）。
     */
    ringSvg(percent) {
      const dash = ringDashOf(percent);
      return (
        '<svg class="ctx-ring-svg" viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">' +
        `<circle class="ring-track" cx="16" cy="16" r="${RING_RADIUS}"></circle>` +
        `<circle class="ring-bar" cx="16" cy="16" r="${RING_RADIUS}"` +
        ` stroke-dasharray="${dash.dasharray}" stroke-dashoffset="${dash.dashoffset}"></circle>` +
        '</svg>'
      );
    },

    /**
     * 把服务端那份 `/ai/context` 变成界面直接可用的视图模型（纯函数，测试直接喂假数据断言）。
     *
     * 堆叠条的两条口径（别把它们混起来）：
     *   - **彩色部分的总长** = `used / limit`，也就是"占了多少窗口"这个事实；
     *   - 段与段之间按**分类占比**再分（分类是估算，真实 usage 不给分类），
     *     所以彩色总长用的是真实总量、细分用的是估算比例 —— 弹层底部那行小字必须说清这件事。
     */
    describe(data) {
      const limit = Number(data?.limit) > 0 ? Number(data.limit) : 0;
      const used = Math.max(0, Number(data?.used) || 0);
      const percent = limit > 0 ? Number(((used / limit) * 100).toFixed(1)) : 0;
      const breakdown = data?.breakdown ?? {};
      const rows = Object.keys(CONTEXT_CATEGORY_LABEL)
        .map((key) => ({ key, label: CONTEXT_CATEGORY_LABEL[key], tokens: Math.max(0, Number(breakdown[key]) || 0) }))
        // 摘要为 0 就不摆这一行（没有压缩过的会话不该出现一行恒为 0 的"摘要"）
        .filter((row) => row.key !== 'summary' || row.tokens > 0);
      const total = rows.reduce((sum, row) => sum + row.tokens, 0);
      const fill = limit > 0 ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0;
      const source = data?.source === 'prompt_tokens' ? 'prompt_tokens' : 'estimate';
      return {
        ready: Boolean(data),
        limit,
        used,
        percent,
        percentText: `${percent.toFixed(1)}%`,
        level: meterLevel(percent),
        usedText: groupDigits(used),
        limitText: groupDigits(limit),
        /** 头部右侧：`~207.3K / 1M` */
        total: `${displayTokens(used)} / ${displayTokens(limit, { exact: true })}`,
        source,
        sourceLabel: source === 'prompt_tokens' ? '真实请求' : '字符估算',
        /** 弹层底部那行小字：说清哪些数字是估的，别把估算伪装成总量 */
        sourceNote:
          source === 'prompt_tokens'
            ? '分类为按字符估算，总计来自最近一次真实请求的 prompt_tokens'
            : '分类与总计都是按字符估算（这个会话还没发出过真实请求）',
        messages: Number(data?.messages) || 0,
        windowMessages: Number(data?.windowMessages) || 0,
        windowTurns: Number(data?.windowTurns) || 0,
        summaryChars: Number(data?.summaryChars) || 0,
        summaryCovered: Number(data?.summaryCovered) || 0,
        segments: rows.map((row) => ({
          ...row,
          // 段的宽度 = 彩色总长 × 该分类在估算总量里的占比（见上面的两条口径）
          width: total > 0 ? (fill * row.tokens) / total : 0,
          text: displayTokens(row.tokens),
        })),
      };
    },
  };
  // 挂到 window 供渲染层测试断言（见 test/ai-context-meter.test.js）：**不是**给视图用的 API，
  // 视图要显示占用请用 PC.service('chat').compact 那一侧的动作。
  window.PCContextMeter = ContextMeter;

  /**
   * 「用量」：累计 token 与**缓存命中率**。
   *
   * 命中率按输入侧算：`prompt_cache_hit_tokens / (hit + miss)` —— 与官方 usage 字段一致。
   * 数字来自 `/ai/usage?conversationId=`（服务端对已落库的 usage 求和），点开时才去取。
   *
   * 按钮**只有图标**（三根柱子）：右侧要挤三个按钮，每个都带文字会把左边的思考模式挤没。
   * 取数 / 渲染 / 静默刷新全部照旧，数字挪进 title 与菜单第一行。
   */
  function usageSelect() {
    const wrap = mk('div', 'compose-select align-right');
    const button = mk('button', 'compose-icon-btn');
    button.type = 'button';
    // 图标本身说不出数字，所以把口径写进 title：既报当前值，也说明点开能看到什么
    const paintTitle = (data) => {
      const text = `用量：${formatUsageValue(data)}（点开看 Token 明细，累计 ${groupDigits(data?.tokens?.total)} tok）`;
      button.title = text;
      button.setAttribute('aria-label', text);
    };
    paintTitle(state.usage);
    // cs-value 仍在（hidden）：refreshUsageBadge() 的静默刷新按它定位，别改坏它
    const value = mk('span', 'cs-value');
    value.hidden = true;
    value.textContent = formatUsageValue(state.usage);
    button.append(value, composeIcon('bars'));

    const menu = mk('div', 'compose-menu usage-menu');
    wrap.append(button, menu);
    menu.addEventListener('click', (event) => event.stopPropagation());

    const row = (label, value, cls = '') => {
      const line = mk('div', `usage-row ${cls}`.trim());
      line.append(mk('span', 'usage-key', label), mk('span', 'usage-val', value));
      return line;
    };

    const paint = (data) => {
      menu.replaceChildren();
      const tokens = data?.tokens ?? {};
      const rate = data?.cacheHitRate;
      menu.appendChild(row('Token 用量', `${groupDigits(tokens.total)} tok`, 'usage-total'));
      menu.appendChild(row('缓存命中', rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(1)}%`));
      menu.appendChild(row('未缓存输入', `${groupDigits(tokens.uncached)} tok`));
      menu.appendChild(row('缓存读取', `${groupDigits(tokens.cached)} tok`));
      menu.appendChild(row('输出', `${groupDigits(tokens.output)} tok`));
      if (tokens.reasoning) menu.appendChild(row('　其中思考', `${groupDigits(tokens.reasoning)} tok`));
      menu.appendChild(row('本轮会话回复数', `${data?.replies ?? 0}`));
      menu.appendChild(
        mk('div', 'cm-hint', tokens.total ? '命中率 = 缓存读取 ÷（缓存读取 + 未缓存输入）' : '还没有产生用量：聊一句就有数据了'),
      );
      value.textContent = formatUsageValue(data);
      paintTitle(data);
    };

    const load = async () => {
      menu.replaceChildren(mk('div', 'cm-hint', '读取中…'));
      try {
        const query = state.conversationId ? `?conversationId=${encodeURIComponent(state.conversationId)}` : '';
        const data = await api(`/ai/usage${query}`);
        state.usage = data;
        paint(data);
      } catch (error) {
        menu.replaceChildren(mk('div', 'cm-hint', `拿不到用量：${error.message}`));
      }
    };

    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const open = wrap.classList.contains('open');
      for (const other of document.querySelectorAll('.compose-select.open')) other.classList.remove('open');
      if (open) return;
      wrap.classList.add('open');
      await load();
    });
    return wrap;
  }

  /**
   * 「上下文」圆环（在用量按钮左边）+ 点开的明细弹层。
   *
   * 为什么要有它：窗口截断一直按 `historyTurns` 条数 + 滚动摘要走，界面上**看不出**"现在这轮
   * 装了多少、还剩多少余地"。用户于是只有两种状态：不知道，或者某天突然发现"它把开头忘了"。
   * 圆环把这件事变成一眼可见，并且给了主动压缩的入口（弹层里那个按钮 = `/com`）。
   *
   * 交互（照仓库里既有的 `.compose-select` + `.compose-menu` 写法）：
   *   - 点圆环 → 打开弹层（**不再**直接压缩：压缩是花钱的动作，必须先看到明细再决定）；
   *   - 点别处 / Esc → 收起；按钮是 `<button>`，`aria-expanded` 跟着真实开合状态走。
   */
  function contextMeter() {
    const wrap = mk('div', 'compose-select align-right context-meter');
    const button = mk('button', 'context-ring-btn');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    const ringBox = mk('span', 'ctx-ring');
    const percentLabel = mk('span', 'ctx-pct');
    button.append(ringBox, percentLabel);

    const menu = mk('div', 'compose-menu context-menu');
    wrap.append(button, menu);
    menu.addEventListener('click', (event) => event.stopPropagation());

    /** 画圆环。`view` 为 null 表示"还没有会话"，此时显示空态而不是 0%。 */
    const paintRing = (view) => {
      ringBox.innerHTML = view ? ContextMeter.ringSvg(view.percent) : '';
      percentLabel.textContent = view ? view.percentText : '—';
      for (const name of ['ok', 'warn', 'hot']) button.classList.toggle(`lvl-${name}`, view?.level === name);
      const text = view
        ? `上下文已用 ${view.usedText} / 上限 ${view.limitText} token（来源：${view.sourceLabel}）` +
          '；点开看分类明细，可在弹层里压缩（= 输入 /com）'
        : '上下文占用：还没有会话（先聊一句）；点开看说明';
      button.title = text;
      button.setAttribute('aria-label', text);
    };

    /** 画弹层：上下文明细（堆叠条 + 分类行 + 压缩按钮）。 */
    const paintMenu = (data) => {
      if (data?.loading) {
        menu.replaceChildren(mk('div', 'cm-hint', '读取中…'));
        return;
      }
      if (data?.error) {
        menu.replaceChildren(mk('div', 'cm-hint', `拿不到上下文占用：${data.error.message ?? data.error}`));
        return;
      }
      const view = data ? ContextMeter.describe(data) : null;
      if (!view) {
        menu.replaceChildren(mk('div', 'cm-hint', '还没有会话：先聊一句，圆环就会开始统计。'));
        return;
      }

      const head = mk('div', 'ctx-head');
      head.append(mk('span', 'ctx-head-title', `上下文已用 ${view.percentText}`), mk('span', 'ctx-head-total', view.total));

      // 堆叠条：总长 = used/limit，段内按分类占比分；底色就是"还没用到的部分"
      const bar = mk('div', 'ctx-bar');
      for (const segment of view.segments) {
        const node = mk('span', `ctx-seg ctx-seg-${segment.key}`);
        node.title = `${segment.label} ${segment.text}`;
        // 宽度走 CSS 变量（CSP 禁内联 style 属性；CSSOM 写自定义属性是允许的，主题也是这么改的）
        node.style.setProperty('--ctx-w', `${segment.width.toFixed(2)}%`);
        bar.appendChild(node);
      }

      const legend = mk('div', 'ctx-legend');
      for (const segment of view.segments) {
        const row = mk('div', 'ctx-legend-row');
        row.append(
          mk('span', `ctx-dot ctx-seg-${segment.key}`),
          mk('span', 'ctx-legend-label', segment.label),
          mk('span', 'ctx-legend-value', segment.text),
        );
        legend.appendChild(row);
      }

      const compactBtn = mk('button', 'ctx-compact-btn', '压缩上下文（/com）');
      compactBtn.type = 'button';
      compactBtn.title = `把窗口外较早的对话压成摘要（保留最近 ${view.windowTurns} 轮不动）`;
      compactBtn.addEventListener('click', () => {
        closeComposeMenu(wrap);
        void compactContext();
      });

      menu.replaceChildren(head, bar, legend, compactBtn, mk('div', 'cm-hint', view.sourceNote));
    };

    // 装到外面：`refreshContextMeter()` 要用它重画（整行会被 renderControls 重建，所以要每次更新引用）
    contextMeterPaint = (data) => {
      if (data && !data.loading && !data.error) contextMeterData = data;
      // 读取中/出错时圆环保留上一次的数字（别闪成 0%），原因在弹层里说
      paintRing(contextMeterData ? ContextMeter.describe(contextMeterData) : null);
      paintMenu(data ?? contextMeterData);
    };
    paintRing(contextMeterData ? ContextMeter.describe(contextMeterData) : null);

    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const open = wrap.classList.contains('open');
      for (const node of document.querySelectorAll('.compose-select.open')) closeComposeMenu(node);
      if (open) return;
      wrap.classList.add('open');
      button.setAttribute('aria-expanded', 'true');
      await refreshContextMeter({ open: true });
    });
    // 重建后如果弹层本来是开着的（例如刚点了绘图开关），把内容补上
    if (wrap.classList.contains('open')) void refreshContextMeter({ open: true });
    return wrap;
  }

  /** 图标的统一挂法：取不到图标就留空，按钮仍然可用（与 navIcon() 的回退思路一致）。 */
  function composeIcon(name) {
    const box = mk('span', 'ci-icon');
    // 19px：这一行没有外框了，图标太小会显得整排控件"缩"在一起（原来是 14px）
    box.innerHTML = window.PCIcons?.svg?.(name, 19) ?? '';
    return box;
  }

  /** 按钮上显示什么：有命中率就显示命中率，否则显示总 token。 */
  function formatUsageValue(data) {
    if (!data) return '—';
    const rate = data.cacheHitRate;
    if (rate !== null && rate !== undefined) return `${(rate * 100).toFixed(1)}%`;
    return `${groupDigits(data.tokens?.total)} tok`;
  }

  /**
   * 圆环最近一次拿到的 `/ai/context` 结果，以及"重画它"的那个函数。
   *
   * 为什么放在外面：`renderControls()` 会整行重建（点一下绘图开关就重建一次），
   * 重建后圆环必须**立刻**用上一次的结果画出来（否则会闪一下空态）；而每次重建这个函数本身也会换新。
   */
  let contextMeterData = null;
  let contextMeterPaint = null;

  /**
   * 收起一个向上展开的弹层，并把 `<button>` 上的 `aria-expanded` 同步成 false。
   *
   * 为什么单独抽出来：收起的路径有三条（点自己、点别处、Esc），而 `aria-expanded` 只要漏掉一条
   * 就会开始说谎 —— 屏幕阅读器会一直以为弹层开着。
   */
  function closeComposeMenu(node) {
    node?.classList.remove('open');
    node?.querySelector('.context-ring-btn')?.setAttribute('aria-expanded', 'false');
  }

  /**
   * 取一次 `/ai/context` 并重画圆环（弹层开着时连弹层一起重画）。
   *
   * 三种情形分开对待，别混在一起：
   *   - 没有会话 → 空态（"还没有会话"），不要显示 0%（那会让人以为"上下文是空的"）；
   *   - 静默刷新（每次回复结束后）失败 → 保留上一次的数字，不打扰用户；
   *   - 用户主动点开时失败 → 在弹层里说明原因（他正等着看数字）。
   */
  async function refreshContextMeter({ open = false } = {}) {
    if (!contextMeterPaint || !state.apiBase) return null;
    if (!state.conversationId) {
      contextMeterData = null;
      contextMeterPaint(null);
      return null;
    }
    if (open) contextMeterPaint({ loading: true });
    try {
      const data = await api(`/ai/context?conversationId=${encodeURIComponent(state.conversationId)}`);
      contextMeterPaint(data);
      return data;
    } catch (error) {
      contextMeterPaint(open ? { error } : null);
      return null;
    }
  }

  /**
   * 「压缩上下文」——`/com` 指令与圆环弹层里那个按钮**共用这一个动作**。
   *
   * 它改的是"上下文里装了什么"，所以做完必须刷新三处：圆环、累计用量、以及（若开着的）弹层数字。
   * 界面里那条系统提示条说的都是**服务端返回的事实**（压了几条、摘要多少字、覆盖到第几条），
   * 不自己编一句"已优化上下文"这种没有信息量的话。
   */
  async function compactContext() {
    const conversationId = state.conversationId;
    if (!conversationId) {
      systemNote('还没有对话可以压缩：先聊一句，或打开一条历史对话。', 'meta');
      return { ok: false, reason: 'no_conversation' };
    }
    const pending = systemNote('正在压缩上下文…', 'pending');
    let result = null;
    try {
      result = await api(`/ai/conversations/${encodeURIComponent(conversationId)}/compact`, { method: 'POST' });
      pending.remove();
      if (result.compacted) {
        systemNote(
          `已压缩上下文：把较早的 ${result.summarized} 条消息压成 ${result.summaryChars} 字摘要（覆盖到第 ${result.covered} 条）`,
          'meta',
        );
      } else if (result.reason === 'empty_summary') {
        systemNote(`压缩没有拿到可用的摘要内容：${result.detail ?? '模型这次没有返回内容'}（上下文保持原样）`, 'fail');
      } else {
        systemNote(
          `没有可压缩的部分：当前只有 ${result.messages} 条消息，窗口内还放得下` +
            `（窗口保留最近 ${result.windowTurns} 轮，待压 ${result.pending ?? 0} 条 / 阈值 ${result.minMessages ?? 6} 条）`,
          'meta',
        );
      }
    } catch (error) {
      pending.remove();
      // 501 = 没配置密钥（AI_UNAVAILABLE）：这不是"压缩失败"，而是这条功能还没启用，措辞要分开
      if (error?.status === 501 || error?.payload?.error?.code === 'AI_UNAVAILABLE') {
        systemNote('未配置密钥，无法压缩：去「设置 → AI 接入」填上 API Key 再来。', 'fail');
      } else {
        systemNote(`压缩失败：${error?.message ?? error}`, 'fail');
      }
      return { ok: false, error };
    } finally {
      // 圆环与累计用量都要立刻反映压缩后的状态（弹层开着时 refreshContextMeter 会一起重画）
      await refreshContextMeter();
      void refreshUsageBadge();
    }
    return result;
  }

  /** 静默刷新「用量」上的数字（不展开菜单）；失败就算了，点开时会重新取。 */
  async function refreshUsageBadge() {
    const wrap = document.querySelector('.chat-controls .usage-menu')?.parentNode;
    const value = wrap?.querySelector('.cs-value');
    if (!value) return;
    try {
      const query = state.conversationId ? `?conversationId=${encodeURIComponent(state.conversationId)}` : '';
      const data = await api(`/ai/usage${query}`);
      state.usage = data;
      value.textContent = formatUsageValue(data);
    } catch {
      /* 忽略 */
    }
  }

  /** 顶栏徽标：显示具体模型名，点开选模型（列表来自 GET /ai/models）。 */
  function wireModelPicker() {
    const badge = dom.aiBadge;
    if (!badge) return;
    const wrap = mk('div', 'compose-select');
    const menu = mk('div', 'compose-menu');
    wrap.appendChild(menu);
    // 菜单挂在 chat-head 上，定位仍由 .compose-select 负责（右对齐）
    badge.parentNode.insertBefore(wrap, badge.nextSibling);
    wrap.insertBefore(badge, menu);

    const paint = () => {
      const models = state.models?.models ?? [];
      menu.replaceChildren();
      if (!models.length) {
        menu.appendChild(mk('div', 'cm-hint', state.models?.reason ? `拿不到模型列表：${state.models.reason}` : '还没有模型列表'));
      }
      for (const model of models) {
        const item = mk('button');
        item.type = 'button';
        item.dataset.value = model.id;
        const active = model.id === state.models?.current;
        // 与输入区那几个下拉一致：**不放 ✓**，当前模型靠 `.active` 的蓝色高光标出
        // （✓ 那一行会因为"有字/没字"撑出高度差，看起来就是勾和高光错位）
        item.append(
          mk('span', 'cm-model', model.id),
          model.source === 'builtin' ? mk('span', 'cm-tag', '候选') : null,
        );
        if (active) item.classList.add('active');
        item.addEventListener('click', async () => {
          wrap.classList.remove('open');
          try {
            await api('/ai/config', { method: 'POST', body: { model: model.id } });
            toast(`已切换到 ${model.id}`);
            await loadMeta();
            state.models = await api('/ai/models');
            paint();
          } catch (error) {
            toast(`切换失败：${error.message}`);
          }
        });
        menu.appendChild(item);
      }
      menu.appendChild(mk('div', 'cm-hint', '列表来自上游 GET /models；拿不到时给内置候选'));
    };

    badge.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!state.ai.available) {
        toast('先到「设置 → AI 接入」填 API Key');
        return;
      }
      const open = wrap.classList.contains('open');
      for (const other of document.querySelectorAll('.compose-select.open')) other.classList.remove('open');
      if (open) return;
      wrap.classList.add('open');
      if (!state.models) {
        menu.replaceChildren(mk('div', 'cm-hint', '正在取模型列表…'));
        try {
          state.models = await api('/ai/models');
        } catch (error) {
          state.models = { models: [], reason: error.message };
        }
      }
      paint();
    });
  }

  /**
   * 输入框自增高：上限与 shell.css 的 `max-height` 一致（桌面 180px），下限靠 CSS 的 min-height 兜。
   *
   * 窄屏用 28vh 而不是 180px：竖屏手机上 180px 已经接近半屏，一输入就把聊天记录全挤没了；
   * 但也不能太小（键盘弹起后可见区域只剩一半）。下限 108px 与 shell.css 里
   * `.chat-compose textarea { min-height }` **必须一致** —— 这里只是镜像，不是第二个来源。
   * 注意 `element.style.height` 这里是**行内样式**，但它是 CSP `style-src 'self'` 允许的
   * 属性赋值（被拦的是 `<style>`/`style="..."` 属性与 `eval`），且这段代码本来就存在。
   */
  function autoGrowInput() {
    const input = dom.chatInput;
    if (!input) return;
    const max = isMobile() ? Math.max(108, Math.round(window.innerHeight * 0.28)) : 180;
    input.style.height = 'auto';
    input.style.height = `${Math.min(max, input.scrollHeight)}px`;
  }

  function wireChat() {
    const input = dom.chatInput;
    const submit = () => {
      const text = input.value;
      input.value = '';
      autoGrowInput();
      writeStored(DRAFT_KEY, ''); // 已经发出去了，草稿立刻清掉（不然重开又冒出这段话）
      send(text);
    };
    // 「+」→ 系统文件选择器；选完读进内存（图片给 dataURL，文本读正文）
    dom.chatAttach.addEventListener('click', () => {
      // 看图只有 deepseek-flash 支持（官方「图像理解」文档），提前提醒而不是等上游 400
      const model = state.ai.model ?? '';
      dom.chatFiles.accept = 'image/png,image/jpeg,image/gif,image/webp,.txt,.md,.csv,.json,.yaml,.yml,.log,.tex,.pdf';
      dom.chatFiles.click();
      if (model && !/flash/i.test(model)) {
        toast(`${model} 不支持图片输入，要发图请先在顶栏切到 deepseek-flash`);
      }
    });
    dom.chatFiles.addEventListener('change', async () => {
      await addFiles(dom.chatFiles.files);
      dom.chatFiles.value = ''; // 允许再次选同一个文件
    });
    // 点空白处收起所有向上展开的菜单（圆环那个弹层也走这条，只是多了 aria 同步）
    document.addEventListener('click', () => {
      for (const node of document.querySelectorAll('.compose-select.open')) closeComposeMenu(node);
    });
    /**
     * Esc 收起圆环弹层并把焦点还给按钮（键盘可达性）。
     *
     * 监听器**只在这里注册一次**：`renderControls()` 会反复重建那一行控件，如果在 contextMeter()
     * 里注册，点几次绘图开关就会攒下一堆指向已卸载节点的僵尸监听。
     */
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const meter = document.querySelector('.chat-controls .context-meter.open');
      if (!meter) return;
      closeComposeMenu(meter);
      meter.querySelector('.context-ring-btn')?.focus();
    });
    dom.chatSend.addEventListener('click', submit);
    /**
     * 回车发送 —— 但**中文/日文输入法组合期间的回车绝不能发送**。
     *
     * 真机 bug（用户报的）：用输入法打字时按回车是"确认候选词"，结果消息被直接发出去，
     * 半截话带着拼音就上屏了。两道判断缺一不可：
     *   1. `event.isComposing`：标准属性，组合期间为 true；
     *   2. `event.keyCode === 229`：Chrome/Safari 在组合期间给 keydown 的哨兵值，
     *      有些输入法（尤其是 macOS 上某些第三方输入法）只给这个、不给 isComposing；
     *   3. **再加一个时间窗**：Safari 会在 `compositionend` 之前就把 isComposing 置回 false，
     *      于是"确认候选词"那一下仍会被当成普通回车 —— 记下组合结束的时刻，
     *      其后 80ms 内的回车一律按"还在输入"处理（人不可能在 80ms 内打完候选再敲回车）。
     */
    let composingUntil = 0;
    input.addEventListener('compositionstart', () => {
      composingUntil = Number.POSITIVE_INFINITY;
    });
    input.addEventListener('compositionend', () => {
      composingUntil = Date.now() + 80;
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const composing = event.isComposing === true || event.keyCode === 229 || Date.now() < composingUntil;
      if (composing) return;
      if (event.shiftKey) return; // Shift+回车 = 换行
      event.preventDefault();
      submit();
    });
    input.addEventListener('input', () => {
      autoGrowInput();
      saveDraft(input.value);
    });
    // 「停止本轮」：只发停止请求，界面收尾交给 `chat_stopped` 与 /ai/chat 的响应（见 stopRound）
    dom.chatStop?.addEventListener('click', () => void stopRound());
    dom.panelToggle.addEventListener('click', togglePanel);
    // 首帧：按钮与排队条都回默认态（显示发送、排队条隐藏）—— 免得重画顺序变了一次就留下残影
    paintStopButton();
    paintQueueBar();
  }

  /* ------------------------------------------------------------ 状态与推送 */

  function setStatus(text, kind = '') {
    dom.status.textContent = text;
    dom.status.className = `status-pill ${kind}`.trim();
  }

  async function loadMeta() {
    try {
      const [health, caps, aiStatus] = await Promise.all([
        api('/health'),
        api('/ai/capabilities'),
        // 顶栏要显示**具体模型名**，这个只有 /ai/status 有；失败也不该拖垮整个 loadMeta
        api('/ai/status').catch(() => null),
      ]);
      state.health = health;
      state.ai = {
        available: Boolean(caps.available),
        provider: caps.provider ?? null,
        contractVersion: caps.contractVersion ?? null,
        model: aiStatus?.config?.model ?? null,
        // 绘图全局开关（设置页也能改）：只有明确 false 才算关，配置里没这个字段=默认开。
        // 放这里是为了让「设置页改完 → 对话行上的画笔跟着变」，而不是两处各记一份状态。
        draw: aiStatus?.config?.drawMode !== false,
      };
      setStatus(
        `已连接 · 事件 ${health.counts?.events ?? 0} · 日程 ${health.counts?.schedules ?? 0}`,
        'ok',
      );
      // 模型可能刚被改过（设置页或选择器），列表缓存要跟着失效
      if (state.models && state.models.current !== state.ai.model) state.models = null;
      // 显示**具体模型名**而不是 provider 名（provider 只是"哪家服务"）
      const model = state.models?.current ?? state.ai.model ?? null;
      dom.aiBadge.textContent = state.ai.available ? `AI：${model ?? state.ai.provider}` : 'AI 未接入（规则解析）';
      dom.aiBadge.classList.toggle('badge-btn', true);
      dom.aiBadge.classList.toggle('on', state.ai.available);
      // 绘图开关的状态来自后端，刚才那次请求可能把它刷新了：重画这一行，免得按钮颜色说谎
      paintControlStates();
    } catch (error) {
      setStatus(`后端不可用：${error.message}`, 'error');
    }
  }

  function connectSocket() {
    if (!state.wsUrl) return;
    let socket;
    try {
      socket = new WebSocket(state.wsUrl);
    } catch {
      return;
    }
    state.socket = socket;
    socket.onopen = () => {
      dom.dot.classList.add('on');
    };
    socket.onclose = () => {
      dom.dot.classList.remove('on');
      setTimeout(connectSocket, 3000);
    };
    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      handlePush(message);
    };
  }

  /**
   * 一条推送消息 → 界面动作。**所有事件分支都在这里**（连接状态除外）：
   * 抽成独立函数是为了让渲染层测试能直接喂一条消息进来断言界面变化，
   * 而不必真的起一个 WebSocket（与 `__PC_SCROLL__` 同一口径）。
   */
  function handlePush(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'reminder') {
      const { title, startTime, allDay } = message.payload ?? {};
      systemNote(`提醒：${allDay ? '全天' : startTime ?? ''} ${title}`, 'reminder');
      toast(`提醒：${title}`);
      return;
    }
    if (message.type === 'ai_delta') {
      appendAiDelta(message.payload);
      return;
    }
    // 过程清单：**全量快照**，整体重画一张卡（见 handlePlan）
    if (message.type === 'plan') {
      handlePlan(message.payload);
      return;
    }
    // 停止：被中断的那条消息马上会以 status:"stopped" 落库，界面先把这一轮收干净
    if (message.type === 'chat_stopped') {
      handleChatStopped(message.payload);
      return;
    }
    // `ai_message` 是定稿广播：当前窗口的正文由 /ai/chat 的响应负责（见 runAiChat），
    // 这里刻意不重复渲染，否则同一段回复会被画两遍。但**停止按钮要在这里就收**
    // —— 广播比 HTTP 响应早几十毫秒，这段时间里按钮还亮着，用户会以为"停止没生效"再点一次。
    if (message.type === 'ai_message') {
      if (message.payload?.conversationId === state.conversationId) endRoundUI(message.payload);
      return;
    }
    if (message.type === 'data_changed') {
      // AI 配置（换模型 / 开关绘图 / 改密钥）和右侧那些业务视图**没有任何关系**：
      // 以前它照样走 refresh()，于是每点一次画笔，右边栏就整体重建一次 —— 看起来就是"闪一下"。
      // 这一路只需要刷新徽标与模型列表（loadMeta 里也会重画输入区那几个开关的状态）。
      const configOnly = message.module === 'ai' && message.payload?.target === 'ai_config';
      clearTimeout(connectSocket._timer);
      connectSocket._timer = setTimeout(() => {
        if (!configOnly) refresh();
        loadMeta();
      }, 150);
    }
  }

  /**
   * 流式增量：只认当前这条回复，且定稿后到达的迟到分片直接丢掉（否则会盖掉最终文本）。
   *
   * 后端一轮 `send` 最多跑 5 轮上游调用（模型可以"先查一次 → 再查一次 → 写 → 回话"），
   * 所以正文分片有两种语义：
   *  - `payload.reset === true`（新一轮开始）：先把气泡**清空**再写 —— 上一轮那句"我查一下…"
   *    是过程稿，留着会让用户以为它还在查；
   *  - 否则：`payload.text` 就是**本轮**已累积的正文，直接覆盖，不再自己拼 delta。
   *    后端只在轮内累积、不跨轮拼接，前端再累加一次就会把同一句话写两遍。
   */
  function appendAiDelta(payload = {}) {
    const streaming = state.streaming;
    if (!streaming || streaming.done) return;
    if (streaming.messageId && payload.messageId && payload.messageId !== streaming.messageId) return;
    streaming.messageId = streaming.messageId ?? payload.messageId ?? null;
    /**
     * 增量里带着 `conversationId` —— 这是"首条消息"那条路上界面第一次知道会话 id 的时刻，
     * 所以两件事都在这里补：
     *   1. 停止按钮要用它（见 stopRound）：用户在这之前就点了停止的话，此刻立刻补发；
     *   2. 回合运行态也记一份，切换会话时"孤儿回合"才知道自己属于哪个会话。
     */
    if (payload.conversationId) {
      streaming.conversationId = payload.conversationId;
      if (state.round) state.round.conversationId = payload.conversationId;
      if (state.stopWanted) void stopRound();
      else paintStopButton();
    }

    // 思维链走单独一条通道：进「思考过程」卡，不跟正文混在一起
    if (payload.channel === 'reasoning') {
      if (!state.reasoningNode) state.reasoningNode = ensureReasoningCard();
      state.reasoningNode.text += payload.delta ?? '';
      state.reasoningNode.body.textContent = state.reasoningNode.text;
      // 思考卡始终排在正文气泡之前（"正文永远在最底下"那条规则），清单卡在它之后
      const anchor = state.plan?.bubble === streaming.node.parentNode ? state.plan.card : streaming.node.parentNode;
      if (streaming.node.parentNode?.parentNode === dom.chatLog) {
        dom.chatLog.insertBefore(state.reasoningNode.card, anchor);
      }
      // **每帧都会走到这里**：必须条件跟随，否则用户往上翻时会被一直拽回底部（"滚不动"）
      followBottom();
      return;
    }

    if (payload.reset === true) streaming.text = '';
    // 以 payload.text 为准（本轮累积正文）；老端点只给 delta 时才退回累加
    streaming.text = typeof payload.text === 'string' ? payload.text : streaming.text + (payload.delta ?? '');
    streaming.node.classList.add('streaming');
    setBubbleText(streaming.node, streaming.text);
    // 同上：正文也是逐帧增长的，无条件跟随会让"正在滚"的用户被反复拉回底部
    followBottom();
  }

  /**
   * 「思考过程」卡：默认折叠，内容随流式增量长出来。
   * 官方把思维链放在 `reasoning_content`（与 content 同级）——不给用户看就等于白花钱算了，
   * 但直接铺在正文里又会喧宾夺主，所以折叠起来。
   */
  function ensureReasoningCard() {
    const card = mk('div', 'bubble bot has-card');
    const box = mk('div', 'chat-card op-card op-think');
    const head = mk('button', 'op-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');
    head.append(mk('span', 'op-chip', '思考过程'), mk('span', 'op-title', '点一下展开'), mk('span', 'op-caret', '›'));
    const body = mk('div', 'op-body');
    const text = mk('div', 'think-text');
    body.appendChild(text);
    box.append(head, body);
    card.appendChild(box);

    const pinned = dom.chatLog.scrollHeight - dom.chatLog.scrollTop - dom.chatLog.clientHeight < 24;
    dom.chatLog.appendChild(card);
    head.addEventListener('click', () => {
      const next = !box.classList.contains('open');
      box.classList.toggle('open', next);
      head.setAttribute('aria-expanded', next ? 'true' : 'false');
      // 展开/收起改变高度：原本贴底就继续贴底，免得把正文顶出屏幕
      if (pinned) dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
    });
    if (pinned) dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
    return { card, body: text, text: '' };
  }

  /* ------------------------------------------------------------ 启动 */

  async function resolveInfo() {
    if (window.potatoCalendar?.getInfo) {
      const info = await window.potatoCalendar.getInfo();
      return { ...info, platform: window.potatoCalendar.platform ?? info.platform };
    }
    const params = new URLSearchParams(location.search);
    const sameOrigin = location.protocol.startsWith('http') && location.pathname.startsWith('/app');
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return {
      baseUrl: params.get('api') ?? (sameOrigin ? `${location.origin}/api/v1` : 'http://127.0.0.1:3210/api/v1'),
      wsUrl: params.get('ws') ?? (sameOrigin ? `${wsProtocol}//${location.host}/ws` : 'ws://127.0.0.1:3210/ws'),
      dataDir: null,
      appVersion: null,
      platform: null,
      theme: null,
    };
  }

  async function boot() {
    dom = {
      nav: document.getElementById('nav'),
      navBottom: document.getElementById('nav-bottom'),
      navMore: document.getElementById('nav-more'),
      navMorePop: document.getElementById('nav-more-pop'),
      panelTitle: document.getElementById('panel-title'),
      panelBody: document.getElementById('panel-body'),
      panelHead: document.querySelector('.panel-head'),
      panelToggle: document.getElementById('panel-toggle'),
      chatLog: document.getElementById('chat-log'),
      chatInput: document.getElementById('chat-input'),
      chatSend: document.getElementById('chat-send'),
      chatStop: document.getElementById('chat-stop'),
      chatQueue: document.getElementById('chat-queue'),
      status: document.getElementById('status'),
      aiBadge: document.getElementById('ai-badge'),
      chatAttach: document.getElementById('chat-attach'),
      chatFiles: document.getElementById('chat-files'),
      chatAttachments: document.getElementById('chat-attachments'),
      chatControls: document.getElementById('chat-controls'),
      dot: document.getElementById('dot'),
      toast: document.getElementById('toast'),
    };

    // openEditor 由日历模块通过 PCModules.service('editor', ...) 提供；其它视图经 PC.openEditor 复用，
    // 不需要互相 import。refreshAi 供设置页在改完 AI 配置后立刻刷新徽标与状态（WS 也会推，但别赌通道）。
    //
    // openView 让模块能**引导用户去另一个视图**，而不必自己实现跳转或去点 DOM。
    // 目前只有一个用处：学堂/学业这些需要登录的页面，在未登录时给一个「去设置里登录」的按钮。
    // 它是 selectView 的直接暴露，没有额外语义 —— 纯函数引用，不引入模块间耦合。
    //
    // snapshotScroll / keepScroll 给各视图的 paint() 用：视图整体重建 DOM 后自己把滚动位置
    // 还回去（lms / academic 已经在调 PC.snapshotScroll），外壳的 renderPanel 复用同一对。
    window.PC = {
      state,
      api,
      refresh,
      refreshAi: loadMeta,
      toast,
      openEditor: Modules.getService('editor'),
      openView: selectView,
      snapshotScroll,
      keepScroll,
    };

    // 「对话」页（views/chat-hub.js）靠它把历史对话打开到左边的聊天框。
    // 只给这五个动作、不给 state：视图直接改 state.conversationId 会绕过持久化，
    // 表现成"点了历史对话、界面也换了，下一条消息却进了旧会话"。
    Modules.service('chat', {
      openConversation,
      newConversation,
      currentId: () => state.conversationId,
      sendMessage: (text) => send(text),
      showWelcome: () => welcome(),
    });

    // 左栏布局给「设置 → 侧边栏」用（shell/sidebar-customize.js）。
    // 见文件末尾的 registerSidebarService()：它在**加载时**就登记，不依赖这里。

    buildNav();
    wireChat();
    // 窄屏布局要在**画面板之前**定好"这一屏给谁"：先挂上 body.mobile-* 类，
    // 后面 selectView() 才知道该走"回聊天"还是"切功能页"（否则会先白画一次没人看得见的面板）。
    wireMobileLayout();
    // 初始"给哪一屏"在这里一次算好，不走 selectView：
    //   有 hash（刷新 / 分享链接）→ 跟着 hash 走；
    //   没有 hash → **聊天屏**（手机打开就能说话），但 `state.view` 仍是桌面端那个默认值
    //   （日历）—— 于是导航高亮必须是"没有模块被点亮"（见 applyLayoutMode）。
    // 这里先只挂类、不画面板：内容等下面 restoreConversation() 之后再画，
    // 免得首帧白画一次用户在手机上根本看不见的面板。
    const bootHash = readHashView();
    state.mobileScreen = bootHash && Modules.has(bootHash) ? screenFor(bootHash) : SCREEN_CHAT;
    applyLayoutMode();
    // 按位置写清楚：默认那一屏（聊天）不该在地址栏留下痕迹，
    // 否则用户从 3210 打开手机上会是 http://…:8886/app/#calendar（hash 还在，但看的是聊天）。
    if (!bootHash) {
      try {
        location.replace('#' + CHAT_VIEW);
      } catch {
        /* 某些壳不允许改地址：退化成不持久化 */
      }
    }
    // 先把持久化的档位读回来再画控件与提示 —— 否则首帧画的是默认值，
    // 用户会看到「手动审批」闪一下再跳成自己上次选的档位。
    const storedPermission = readStored('potato.permission');
    if (PERMISSION_OPTIONS.some((item) => item.value === storedPermission)) state.permission = storedPermission;
    const storedSearch = readStored('potato.search');
    if (SEARCH_OPTIONS.some((item) => item.value === storedSearch)) state.search = storedSearch;
    renderControls();
    renderAttachments();
    wireModelPicker();

    const info = await resolveInfo();
    state.info = info;
    state.apiBase = info.baseUrl;
    state.wsUrl = info.wsUrl;
    applyTheme(info.theme);

    if (!state.apiBase) {
      setStatus('后端未启动', 'error');
      systemNote('无法连接后端：请先用 npm run start:server 或 npm run dev:app:macos 启动。', 'fail');
      return;
    }

    // 桌面端自动聚焦输入框（打开就能打字）；手机上**不要**：
    // iOS Safari 的自动聚焦会立刻弹出软键盘，把首屏顶掉一半，用户还没看清页面就先看到键盘。
    if (!isMobile()) dom.chatInput.focus();
    await loadMeta();
    // 关窗/刷新后续聊：还原上次那条对话与没发出去的草稿（对话已经被删了就安静退回欢迎语）
    const storedDraft = readStored(DRAFT_KEY);
    if (storedDraft) {
      dom.chatInput.value = storedDraft;
      autoGrowInput();
    }
    await restoreConversation();
    // 手机刷新后要停在同一屏：hash 优先（用户点过导航才会写），其次 `?view=`（外部链接），
    // 都没有就停在启动时定好的聊天屏 —— 这时**什么都不用做**：
    // 上面 applyLayoutMode() 已经把这一屏挂好了，再走一次 selectView(state.view) 反而会
    // 因为 `state.view` 是桌面端默认值（日历）而把面板白画一遍，还把导航高亮错点到「日历」上。
    // 桌面端没有 hash 时行为与改动前逐行一致（selectView(state.view)）。
    const bootQueryView = new URLSearchParams(location.search).get('view');
    if (isMobile() && bootHash) applyHashView();
    else if (isMobile() && bootQueryView) selectView(state.view);
    else if (!isMobile()) selectView(state.view);
    connectSocket();
  }

  /** 主题令牌（/meta/theme 或 Electron IPC 提供）覆盖到 CSS 变量。 */
  function applyTheme(theme) {
    if (!theme) return;
    const root = document.documentElement;
    const map = {
      '--bg-base': theme.background?.base,
      '--bg-surface': theme.background?.surface,
      '--bg-elevated': theme.background?.elevated,
      '--bg-hover': theme.background?.hover,
      '--fg': theme.text?.primary,
      '--fg-2': theme.text?.secondary,
      '--fg-3': theme.text?.muted,
      '--blue': theme.accent?.blue,
      '--red': theme.accent?.red,
      '--green': theme.accent?.green,
      '--orange': theme.accent?.orange,
      '--purple': theme.accent?.purple,
    };
    for (const [key, value] of Object.entries(map)) {
      if (value) root.style.setProperty(key, value);
    }
  }

  function start() {
    boot().catch((error) => {
      // 启动期异常必须在控制台留痕：界面可能还没建好，只靠页面提示会很难排查
      console.error('[app] 启动失败', error);
      try {
        systemNote(`启动失败：${error.message}`, 'fail');
      } catch {
        /* DOM 尚未就绪时忽略 */
      }
    });
  }

  // ★ 在**加载时**就登记，而不是等 boot()：
  //   设置页「侧边栏」那块可能先于一次完整启动被渲染，而且测试里 boot() 是刻意不跑的
  //   （`document.readyState` 一直是 'loading'）—— 放进 boot 就等于这份契约永远没人测。
  registerSidebarService();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
