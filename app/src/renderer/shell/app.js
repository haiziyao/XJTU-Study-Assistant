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
    ai: { available: false, provider: null, contractVersion: null },
    /** 当前 AI 会话 id；`null` = 下一条消息开新会话（设置页的「新对话」会把它清空）。 */
    conversationId: null,
    /** 正在流式接收的那条回复：`{ messageId, text, node, done }`，供 WebSocket 增量更新。 */
    streaming: null,
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

  /**
   * 气泡。
   * - 用户消息按纯文本渲染（自己敲的字不该被 Markdown 规则改样）；
   * - 机器人消息走富文本（Markdown 子集 + LaTeX 子集 + ```svg 图形）。
   */
  function bubble(role, text) {
    const node = mk('div', `bubble ${role}`);
    const body = mk('div', 'bubble-text');
    node.appendChild(body);
    if (role === 'user') body.textContent = String(text ?? '');
    else if (text) window.PCRichText?.render(body, text);
    return push(node);
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

  /** 影响对象的列表（写入结果 / 查询结果共用一种行样式）。 */
  function itemList(items, { limit = 12 } = {}) {
    const list = mk('div', 'cc-list');
    for (const item of items.slice(0, limit)) {
      const when = item.date ?? item.startDate ?? item.deadline ?? '';
      const time = !item.startTime || item.allDay ? '' : ` ${item.startTime}${item.endTime ? `–${item.endTime}` : ''}`;
      const row = mk('div', 'cc-list-row');
      row.append(mk('span', 'cc-list-time', `${when}${time}`.trim()), mk('span', null, item.title ?? item.id ?? ''));
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
      const jump = mk('button', 'ghost-btn', '在右侧查看');
      jump.type = 'button';
      jump.addEventListener('click', () => {
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
      chip: `查看${TARGET_LABEL[result.target] ?? result.target ?? '记录'}`,
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
    if (!content) return;
    bubble('user', content);
    if (state.ai.available) return runAiChat(content);
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
  async function runAiChat(content) {
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
        },
      });
      state.conversationId = result.conversation?.id ?? state.conversationId;
      streaming.done = true;
      textEl.classList.remove('streaming');
      setBubbleText(textEl, result.assistant?.content || '（模型没有返回内容）');
      // 只读查询由后端自动执行了：把数据原样列出来（模型的话可能概括得太粗，用户要看的是具体条目）
      const queried = result.queried ?? [];
      for (const entry of queried) {
        if (entry.result) queryCard(entry.result);
        else if (entry.error) systemNote(`查询没成功：${entry.error.message}`, 'fail');
      }
      const drafts = result.drafts ?? [];
      for (const entry of drafts) renderAiDraft(entry);
      if (!drafts.length && !queried.length) {
        systemNote(`${state.ai.provider ?? 'AI'} · 只是聊天，没有产生任何写入`, 'meta');
      }
      keepBodyLast(card);
    } catch (error) {
      streaming.done = true;
      textEl.classList.remove('streaming');
      // 失败时后端已经把部分内容落库了：气泡里保留收到的那部分，不假装什么都没发生
      if (!streaming.text) card.remove();
      else setBubbleText(textEl, streaming.text);
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
      // 底部提示跟着 AI 状态走：否则配置好密钥后，界面还在说"当前由本地规则解析"
      const hint = document.querySelector('.chat-hint');
      if (hint) {
        hint.textContent = state.ai.available
          ? `Enter 发送 · Shift + Enter 换行 · 由 ${state.ai.provider} 驱动，回复里的安排要点确认才落库`
          : 'Enter 发送 · Shift + Enter 换行 · 当前由本地规则解析（在「设置 → AI 接入」里填密钥即可换成模型）';
      }
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
        clearTimeout(connectSocket._timer);
        connectSocket._timer = setTimeout(() => {
          refresh();
          loadMeta();
        }, 150);
      }
    };
  }

  /** 流式增量：只认当前这条回复，且定稿后到达的迟到分片直接丢掉（否则会盖掉最终文本）。 */
  function appendAiDelta(payload = {}) {
    const streaming = state.streaming;
    if (!streaming || streaming.done) return;
    if (streaming.messageId && payload.messageId && payload.messageId !== streaming.messageId) return;
    streaming.messageId = streaming.messageId ?? payload.messageId ?? null;
    streaming.text += payload.delta ?? '';
    streaming.node.classList.add('streaming');
    setBubbleText(streaming.node, streaming.text);
    dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
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
    // 不需要互相 import。refreshAi 供设置页在改完 AI 配置后立刻刷新徽标与状态（WS 也会推，但别赌通道）。
    window.PC = { state, api, refresh, refreshAi: loadMeta, toast, openEditor: Modules.getService('editor') };

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
