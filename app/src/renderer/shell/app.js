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
    /** 正在流式接收的那条回复：`{ messageId, text, node, done }`，供 WebSocket 增量更新。 */
    streaming: null,
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
     * 目前只是**状态位**：后端只把它写进提示词，检索通道还没接入（模型会如实说明），
     * 界面上如实标出来，免得用户以为真的搜了网。也要持久化 —— 选"校内网"的人不会每次重开都重选。
     */
    search: 'off',
    /** 待发送的附件（只活在内存里；发送后只在消息上留元信息）。 */
    attachments: [],
    /** 模型选择器缓存的列表。 */
    models: null,
    health: null,
    view: new URLSearchParams(location.search).get('view') ?? 'calendar',
    panelCollapsed: false,
    calendar: { mode: 'month', anchor: U.todayKey() },
    todo: { filter: 'all' },
  };

  /** DOM 引用缓存：在 boot() 里一次性填充（因此必须是 let，不能是 const）。 */
  let dom = {};

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
    button.addEventListener('click', () => selectView(item.id));
    return button;
  }

  function buildNav() {
    for (const item of Modules.list()) {
      const host = item.slot === 'bottom' ? dom.navBottom : dom.nav;
      host.appendChild(navButton(item));
    }
  }

  function selectView(view) {
    state.view = view;
    for (const button of document.querySelectorAll('.nav-item')) {
      button.classList.toggle('active', button.dataset.view === view);
    }
    // 主动切视图要回到顶部：新视图是"新的一页"，沿用上一个视图的滚动位置会停在半空中。
    // 这与「重画保住位置」是两回事，所以走参数而不是复制一份 renderPanel。
    renderPanel({ keepScroll: false });
  }

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

  function togglePanel() {
    state.panelCollapsed = !state.panelCollapsed;
    document.body.classList.toggle('panel-collapsed', state.panelCollapsed);
    dom.panelToggle.textContent = state.panelCollapsed ? '⟨' : '⟩';
    dom.panelToggle.title = state.panelCollapsed ? '展开右侧视图' : '收起右侧视图';
    if (state.panelCollapsed && state.view === 'calendar' && state.calendar.mode === 'week') {
      state.calendar.mode = 'month';
      toast('周视图需要展开右侧视图，已切回月视图');
    }
    renderPanel();
  }

  /* ------------------------------------------------------------ 对话面板 */

  function push(node) {
    dom.chatLog.appendChild(node);
    dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
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

  /** 影响对象的列表（写入结果 / 查询结果共用一种行样式）。 */
  function itemList(items, { limit = 12 } = {}) {
    const list = mk('div', 'cc-list');
    for (const item of items.slice(0, limit)) {
      const row = mk('div', 'cc-list-row');
      if (isGrade(item)) {
        // 成绩项没有日期也没有 title：以前这里只显示一个 uuid，等于没显示。
        // 左边那栏改放学期（成绩的"时间维度"就是学期），右边是课程 + 学分/成绩/绩点。
        row.append(mk('span', 'cc-list-time', gradeTerm(item)), gradeText(item));
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
    const kind = ['schedule', 'todo', 'event'].includes(result.target) ? result.target : 'write';
    const summary = result.explain ?? `共 ${result.count ?? items.length} 条`;

    const details = [];
    if (!items.length) details.push(mk('div', 'cc-explain', '没有符合条件的记录。'));
    else {
      details.push(itemList(items));
      const actions = mk('div', 'cc-actions');
      const toAcademic = result.target === 'grade';
      // 成绩在**学业**视图里（成绩单 / 学分绩），不在日历上：跳日历只会看到一片空白
      const jump = mk('button', 'ghost-btn', toAcademic ? '在右侧看学业' : '在右侧查看');
      jump.type = 'button';
      jump.addEventListener('click', () => {
        if (toAcademic && typeof window.PC?.openView === 'function') {
          window.PC.openView('academic');
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
    const files = state.attachments;
    if (!content && !files.length) return;
    if (files.length && !state.ai.available) {
      toast('附件要配了 AI 才能解析，先去掉或去「设置 → AI 接入」填密钥');
      return;
    }
    bubble('user', content, files);
    // 附件所有权已经交给这条消息，清空待发区（避免下一条又带一遍）
    state.attachments = [];
    renderAttachments();
    if (state.ai.available) return runAiChat(content, files);
    return runLocalRules(content);
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
   */
  async function runAiChat(content, files = []) {
    const card = bubble('bot', '');
    const textEl = card.querySelector('.bubble-text');
    textEl.textContent = '正在思考…';   // 尚未有内容时先给占位，第一块增量到达就被覆盖
    const streaming = { messageId: null, text: '', node: textEl, done: false };
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
          // 联网通道（off / web / campus）：目前后端只拿它写提示词，让模型如实说明没接入检索，
          // 但请求体先按最终形状带上，通道接进来时前端不用再改一次
          search: state.search,
        },
      });
      state.conversationId = result.conversation?.id ?? state.conversationId;
      streaming.done = true;
      textEl.classList.remove('streaming');
      setBubbleText(textEl, result.assistant?.content || '（模型没有返回内容）');
      // 思维链兜底：流式没收到（或只收到一半）就用落库的那份
      const reasoning = String(result.assistant?.reasoning ?? '').trim();
      if (reasoning && (!state.reasoningNode || state.reasoningNode.text.length < reasoning.length)) {
        if (!state.reasoningNode) state.reasoningNode = ensureReasoningCard();
        state.reasoningNode.text = reasoning;
        state.reasoningNode.body.textContent = reasoning;
      }
      if (state.reasoningNode) {
        if (card.parentNode) dom.chatLog.insertBefore(state.reasoningNode.card, card);
        state.reasoningNode = null;
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
      const drafts = result.drafts ?? [];
      for (const entry of drafts) renderAiDraft(entry);
      void refreshUsageBadge();
      if (!drafts.length && !queried.length && !(result.executed ?? []).length) {
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
      if (details.conversationId) state.conversationId = details.conversationId;
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
    dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
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
   * `hint` 里把「校内 / 校外」的区别说清楚：这两个通道走的是完全不同的入口（要不要登录、
   * 能拿到什么），用户在菜单里就该看到，而不是选完再猜。
   */
  const SEARCH_OPTIONS = [
    { value: 'off', label: '不联网', hint: '只用本地数据与模型已有知识' },
    { value: 'web', label: '从校外网搜索', hint: '走公网检索（检索通道还没接入）' },
    { value: 'campus', label: '从校内网搜索', hint: '走校内网络入口（检索通道还没接入）' },
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
        hint: '检索通道还没接入：选中的通道会写进提示词，模型会如实说明它没有真的搜网',
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
   * 「联网搜索」按钮的 title：**如实**写明当前通道与「检索还没接入」，别让人以为真的搜了网。
   *
   * @param {string} [value] 当前通道；默认取 `state.search`（菜单选中那一刻要传刚选的值，见 renderControls）
   */
  function searchTitle(value = state.search) {
    const found = SEARCH_OPTIONS.find((item) => item.value === value) ?? SEARCH_OPTIONS[0];
    const suffix =
      value === 'off' ? '只用本地数据与模型已有知识' : `${found.label}（检索通道还没接入，模型会如实说明）`;
    return `联网搜索：${suffix}`;
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

  function wireChat() {
    const input = dom.chatInput;
    const submit = () => {
      const text = input.value;
      input.value = '';
      autoGrow();
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
    // 点空白处收起所有向上展开的菜单
    document.addEventListener('click', () => {
      for (const node of document.querySelectorAll('.compose-select.open')) node.classList.remove('open');
    });
    dom.chatSend.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    });
    input.addEventListener('input', autoGrow);
    function autoGrow() {
      input.style.height = 'auto';
      // 上限与 shell.css 的 max-height 保持一致；下限靠 CSS 的 min-height（58px）兜
      input.style.height = `${Math.min(180, input.scrollHeight)}px`;
    }
    dom.panelToggle.addEventListener('click', togglePanel);
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
      // `ai_message` 是定稿广播：当前窗口的正文由 /ai/chat 的响应负责（见 runAiChat），
      // 这里刻意不重复渲染，否则同一段回复会被画两遍。
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
    };
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

    // 思维链走单独一条通道：进「思考过程」卡，不跟正文混在一起
    if (payload.channel === 'reasoning') {
      if (!state.reasoningNode) state.reasoningNode = ensureReasoningCard();
      state.reasoningNode.text += payload.delta ?? '';
      state.reasoningNode.body.textContent = state.reasoningNode.text;
      // 思考卡始终排在正文气泡之前（"正文永远在最底下"那条规则）
      if (streaming.node.parentNode?.parentNode === dom.chatLog) {
        dom.chatLog.insertBefore(state.reasoningNode.card, streaming.node.parentNode);
      }
      dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
      return;
    }

    if (payload.reset === true) streaming.text = '';
    // 以 payload.text 为准（本轮累积正文）；老端点只给 delta 时才退回累加
    streaming.text = typeof payload.text === 'string' ? payload.text : streaming.text + (payload.delta ?? '');
    streaming.node.classList.add('streaming');
    setBubbleText(streaming.node, streaming.text);
    dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
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
      panelTitle: document.getElementById('panel-title'),
      panelBody: document.getElementById('panel-body'),
      panelToggle: document.getElementById('panel-toggle'),
      chatLog: document.getElementById('chat-log'),
      chatInput: document.getElementById('chat-input'),
      chatSend: document.getElementById('chat-send'),
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

    buildNav();
    wireChat();
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

    dom.chatInput.focus();
    await loadMeta();
    welcome();
    selectView(state.view);
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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
