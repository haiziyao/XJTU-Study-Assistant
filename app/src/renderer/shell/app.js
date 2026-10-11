/**
 * 应用外壳（classic script，无框架、无构建步骤）。
 *
 * 布局：左侧功能栏（约 10% 宽） / 中间对话面板 / 右侧功能视图。
 *  - 左侧功能栏**由视图注册表生成**（各 views/<id>.js 自行登记，见 kit/registry.js），
 *    本文件不认识任何具体功能，新增功能不需要改这里；
 *  - 中间对话面板调用 /commands/* 的本地规则解析（AI 未接入，接口已预留）；
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
    '顺延未完成的日程到本周',
  ];

  const FIELD_LABEL = {
    title: '标题',
    date: '日期',
    startTime: '开始',
    endTime: '结束',
    allDay: '全天',
    category: '分类',
    priority: '优先级',
    estimatedMinutes: '预计时长',
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

  const state = {
    apiBase: null,
    wsUrl: null,
    socket: null,
    info: null,
    ai: { available: false, provider: null, contractVersion: null },
    health: null,
    view: 'calendar',
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
    renderPanel();
  }

  function renderPanel() {
    const view = Modules.get(state.view) ?? Modules.list()[0];
    if (!view) {
      dom.panelTitle.textContent = '无可用视图';
      dom.panelBody.innerHTML = '';
      return;
    }
    state.view = view.id;
    dom.panelTitle.textContent = view.title;
    view.render({ mount: dom.panelBody, api, state, toast, refresh });
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

  function bubble(role, text) {
    const node = mk('div', `bubble ${role}`);
    node.appendChild(mk('div', 'bubble-text', text));
    return push(node);
  }

  function systemNote(text, kind = '') {
    return push(mk('div', `chat-note ${kind}`.trim(), text));
  }

  function welcome() {
    const card = mk('div', 'bubble bot');
    card.appendChild(
      mk(
        'div',
        'bubble-text',
        '你好，这是日历与待办模块的测试界面。AI 尚未接入，中间的对话由本地规则解析器完成（接口已按 AI 契约预留，接入模型后行为不变）。可以直接这样说：',
      ),
    );
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
    if (Object.keys(fields).length) box.appendChild(fieldRows(fields));

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
        resultCard(result);
        refresh();
      } catch (error) {
        actions.replaceChildren(mk('span', 'cc-note fail', '执行失败'));
        errorCard(error);
      }
    });
  }

  function resultCard(result) {
    const card = mk('div', 'bubble bot has-card');
    const box = mk('div', 'chat-card ok');
    box.appendChild(mk('div', 'cc-title', result.explain ?? `${actionText(result)}完成`));
    if (result.dryRun) box.appendChild(mk('div', 'cc-explain', '（试运行，未写入数据）'));
    if (Array.isArray(result.affected) && result.affected.length) {
      const list = mk('div', 'cc-list');
      for (const item of result.affected.slice(0, 10)) {
        list.appendChild(mk('div', 'cc-list-row', `${item.date ?? ''} ${item.title ?? item.id ?? ''}`.trim()));
      }
      if (result.affected.length > 10) list.appendChild(mk('div', 'cc-list-row', `…还有 ${result.affected.length - 10} 条`));
      box.appendChild(list);
    }
    if (result.conflicts?.length) {
      box.appendChild(mk('div', 'cc-warning', `提示：与 ${result.conflicts.length} 条日程时间重叠`));
    }
    if (result.ambiguous) box.appendChild(mk('div', 'cc-warning', '匹配到多条记录，已全部处理，请确认是否符合预期'));
    card.appendChild(box);
    push(card);
  }

  function queryCard(result) {
    const card = mk('div', 'bubble bot has-card');
    const box = mk('div', 'chat-card');
    box.appendChild(mk('div', 'cc-title', result.explain ?? `共 ${result.count ?? 0} 条`));
    const items = result.items ?? [];
    if (!items.length) {
      box.appendChild(mk('div', 'cc-explain', '没有符合条件的记录。'));
    } else {
      const list = mk('div', 'cc-list');
      for (const item of items.slice(0, 12)) {
        const when = item.date ?? item.startDate ?? '';
        const time = item.allDay || !item.startTime ? '' : ` ${item.startTime}${item.endTime ? `–${item.endTime}` : ''}`;
        const row = mk('div', 'cc-list-row');
        row.append(mk('span', 'cc-list-time', `${when}${time}`), mk('span', null, item.title));
        list.appendChild(row);
      }
      if (items.length > 12) list.appendChild(mk('div', 'cc-list-row', `…还有 ${items.length - 12} 条`));
      box.appendChild(list);
    }
    const actions = mk('div', 'cc-actions');
    const jump = mk('button', 'ghost-btn', '在右侧查看');
    jump.type = 'button';
    jump.addEventListener('click', () => {
      state.view = 'calendar';
      state.calendar.mode = 'day';
      state.calendar.anchor = items[0]?.date ?? items[0]?.startDate ?? U.todayKey();
      selectView('calendar');
    });
    if (items.length) actions.appendChild(jump);
    box.appendChild(actions);
    card.appendChild(box);
    push(card);
  }

  function errorCard(error) {
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

  async function send(text) {
    const content = String(text ?? '').trim();
    if (!content) return;
    bubble('user', content);
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

  function wireChat() {
    const input = dom.chatInput;
    const submit = () => {
      const text = input.value;
      input.value = '';
      autoGrow();
      send(text);
    };
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
      input.style.height = `${Math.min(140, input.scrollHeight)}px`;
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
      const [health, caps] = await Promise.all([api('/health'), api('/ai/capabilities')]);
      state.health = health;
      state.ai = {
        available: Boolean(caps.available),
        provider: caps.provider ?? null,
        contractVersion: caps.contractVersion ?? null,
      };
      setStatus(
        `已连接 · 事件 ${health.counts?.events ?? 0} · 日程 ${health.counts?.schedules ?? 0}`,
        'ok',
      );
      dom.aiBadge.textContent = state.ai.available ? `AI：${state.ai.provider}` : 'AI 未接入（规则解析）';
      dom.aiBadge.classList.toggle('on', state.ai.available);
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
      if (message.type === 'data_changed') {
        clearTimeout(connectSocket._timer);
        connectSocket._timer = setTimeout(() => {
          refresh();
          loadMeta();
        }, 150);
      }
    };
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
      dot: document.getElementById('dot'),
      toast: document.getElementById('toast'),
    };

    // openEditor 由日历模块通过 PCModules.service('editor', ...) 提供；其它视图经 PC.openEditor 复用，
    // 不需要互相 import。
    window.PC = { state, api, refresh, toast, openEditor: Modules.getService('editor') };

    buildNav();
    wireChat();

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
