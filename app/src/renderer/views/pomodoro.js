/**
 * 番茄钟视图（左栏「番茄钟」，order 21）。
 *
 * 与其它视图的三条共同约定：
 *   1. 内容放进 `.view-content`（`.panel-body` 不滚动、没有内边距）；
 *   2. 所有文本走 textContent，**不写 inline style**（CSP 的 `style-src 'self'` 会拦）；
 *      SVG 的圆环/柱子用**属性**（`stroke-dashoffset`、`x/y/height`）表达，不碰 `style`；
 *   3. 请求失败只落在页面内的错误条 + `PC.toast`，不 `alert()`。
 *
 * 服务端是唯一权威：本文件不自己"数秒"改状态。GET /status 给出 `endsAt` 后，本地每秒
 * 只做一次 `endsAt - now` 的**纯渲染**；每秒发请求既浪费也会让手机端烧电。
 *
 * 提醒有两条来源（互相兜底）：
 *   - 后端在阶段结束时广播 `{type:'pomodoro', payload:{kind:'phase-end',…}}`；
 *   - 本地倒计时归零（WS 断了、页面刚醒来时）→ 先响铃提示，再 GET 一次让服务端补账。
 * 两条路都可能同时发生，所以用 `lastAlertAt` 做 1.5 秒去重。
 */

(function () {
  'use strict';

  /** 圆环半径 / 周长：与 HTML 里的 r 保持一致；`stroke-dashoffset = C × (1 - 剩余/总时长)`。 */
  const RING_R = 96;
  const RING_C = 2 * Math.PI * RING_R;

  const PHASE_LABEL = { idle: '准备开始', study: '专注', break: '休息' };

  const ui = {
    mount: null,
    status: null,
    todos: [],
    error: null,
    loading: true,
    busy: null,
    requestId: 0,
    ticker: null,
    completedAtZero: null,
    socket: null,
    lastAlertAt: 0,
    audio: null,
    refs: {},
  };

  /* ------------------------------------------------------------ 基础件 */

  function mk(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function button(label, className, onClick) {
    const node = mk('button', className, label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function svgEl(tag, attrs = {}) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    return node;
  }

  function clamp01(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.min(1, Math.max(0, num));
  }

  /** 圆环偏移量（把"剩余比例"换成 dashoffset）。抽成纯函数，测试可直接断言。 */
  function ringOffset(remainingSec, totalSec) {
    const ratio = totalSec > 0 ? clamp01(remainingSec / totalSec) : 0;
    return Number((RING_C * (1 - ratio)).toFixed(2));
  }

  function fmtClock(seconds) {
    const safe = Math.max(0, Math.round(Number(seconds) || 0));
    const mm = Math.floor(safe / 60);
    const ss = safe % 60;
    return `${PCUtil.pad2(mm)}:${PCUtil.pad2(ss)}`;
  }

  function fmtSpent(seconds) {
    const sec = Math.max(0, Number(seconds) || 0);
    if (sec < 60) return '未投入';
    if (sec < 3600) return `${Math.round(sec / 60)} 分钟`;
    return `${(sec / 3600).toFixed(1)} 小时`;
  }

  function fmtDay(day) {
    return String(day ?? '').slice(5) || '—';
  }

  /** 当前剩余秒数：运行中由 `endsAt` 现算，暂停/空闲用服务端的 remainingSec。 */
  function remainingOf(status) {
    if (!status) return 0;
    if (status.running && status.endsAt) {
      const ends = Date.parse(status.endsAt);
      if (Number.isFinite(ends)) return Math.max(0, Math.ceil((ends - Date.now()) / 1000));
    }
    return Math.max(0, Math.round(Number(status.remainingSec) || 0));
  }

  /* ------------------------------------------------------------ 提示音 / 通知 */

  /** 在用户点击按钮的手势里创建/恢复音频上下文，到点响铃才不会被浏览器策略拦住。 */
  function prepareAudio() {
    if (ui.status?.config?.sound === false) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
      if (!ui.audio) ui.audio = new Ctx();
      if (ui.audio.state === 'suspended' && typeof ui.audio.resume === 'function') ui.audio.resume().catch(() => {});
    } catch {
      /* 没有音频设备：到点还有 toast */
    }
  }

  /**
   * Web Audio 合成提示音（不引音频文件：零依赖、离线可用、不受 CSP 的 media-src 影响）。
   * `sound:false` 时完全跳过（连音频上下文都不创建，不是"创建了但静音"）。
   */
  function playChime() {
    if (ui.status?.config?.sound === false) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
      if (!ui.audio) ui.audio = new Ctx();
      const ctx = ui.audio;
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume().catch(() => {});
      const now = ctx.currentTime;
      // 两声短音（C5 → E5）：比一声长音更像"提示"，也不会盖住正在播的音乐太久
      [0, 0.18].forEach((offset, index) => {
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(index === 0 ? 523.25 : 659.25, now + offset);
        gain.gain.setValueAtTime(0.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.18, now + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.16);
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start(now + offset);
        oscillator.stop(now + offset + 0.18);
      });
    } catch {
      /* 没有音频设备 / 被浏览器策略拦住：提醒还有 toast，不因为铃声失败而报错 */
    }
  }

  /** 页面不可见时的系统通知：**已经授权才用**，绝不在后台弹权限框打扰用户。 */
  function systemNotify(title, body) {
    if (typeof document !== 'undefined' && document.hidden !== true) return;
    if (typeof window.Notification !== 'function') return;
    try {
      if (window.Notification.permission !== 'granted') return;
      // eslint-disable-next-line no-new
      new window.Notification(title, { body, tag: 'potato-pomodoro' });
    } catch {
      /* 部分浏览器在非安全上下文会抛错：忽略即可 */
    }
  }

  function notifyPhaseEnd(payload) {
    if (!payload) return;
    const now = Date.now();
    // WS 与本地归零可能同时到达：1.5 秒内只提醒一次
    if (now - ui.lastAlertAt < 1500) {
      loadAll({ quiet: true });
      return;
    }
    ui.lastAlertAt = now;
    const finishedStudy = payload.phase === 'study';
    const title = finishedStudy ? '专注结束，休息一下' : '休息结束，开始下一轮';
    const roundText = Number(payload.round) > 0 ? `第 ${payload.round} 个番茄` : '本轮还没有完整番茄';
    const body = `${title} · ${roundText}`;
    window.PC?.toast?.(body);
    playChime();
    systemNotify('番茄钟', body);
    // 让服务端补账并拿新阶段；WS 只是通知，状态仍以 GET 为准
    loadAll({ quiet: true });
  }

  /** 本地倒计时归零：即使 WS 断了也要提醒，同时请服务端结算。 */
  function onLocalZero() {
    const status = ui.status;
    if (!status || !status.running) return;
    const key = `${status.phase}:${status.endsAt ?? ''}`;
    if (ui.completedAtZero === key) return;
    ui.completedAtZero = key;
    const now = Date.now();
    if (now - ui.lastAlertAt >= 1500) {
      ui.lastAlertAt = now;
      const title = status.phase === 'study' ? '专注时间到，准备休息' : '休息结束，准备下一轮';
      window.PC?.toast?.(title);
      playChime();
      systemNotify('番茄钟', title);
    }
    loadAll({ quiet: true });
  }

  /* ------------------------------------------------------------ WebSocket */

  function onSocketMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message?.type === 'pomodoro' && message.payload?.kind === 'phase-end') {
      notifyPhaseEnd(message.payload);
    }
  }

  /**
   * 复用外壳已有的 WS 连接，而不是自己再开一条：
   * 外壳把连接挂在 `PC.state.socket` 上，`addEventListener('message')` 可以**追加**
   * 监听器（不会顶掉它自己的 `onmessage`）。外壳重连后会换新对象，所以每秒 tick 里
   * 调一次本函数，发现换了就重新挂。
   */
  function attachSocket() {
    const socket = window.PC?.state?.socket;
    if (!socket || socket === ui.socket || typeof socket.addEventListener !== 'function') return;
    ui.socket = socket;
    socket.addEventListener('message', onSocketMessage);
  }

  /* ------------------------------------------------------------ 数据 */

  async function loadAll({ quiet = false } = {}) {
    const api = window.PC?.api;
    if (!api) return;
    const id = ++ui.requestId;
    attachSocket();
    if (!quiet) {
      ui.loading = true;
      if (!ui.status) paint();
    }
    const [statusResult, todoResult] = await Promise.allSettled([
      api('/pomodoro/status'),
      api('/todos?completed=false'),
    ]);
    if (id !== ui.requestId) return;
    if (statusResult.status === 'fulfilled') {
      ui.status = statusResult.value;
      ui.error = null;
    } else {
      ui.error = statusResult.reason?.message ?? String(statusResult.reason);
    }
    if (todoResult.status === 'fulfilled') {
      ui.todos = Array.isArray(todoResult.value?.items) ? todoResult.value.items : [];
    } else if (!ui.todos.length) {
      ui.todos = [];
    }
    ui.loading = false;
    paint();
  }

  function applyStatus(status) {
    if (!status) return;
    ui.status = status;
    ui.error = null;
    ui.completedAtZero = null;
    paint();
  }

  async function doAction(name, body, message) {
    if (ui.busy) return;
    ui.busy = name;
    paint();
    try {
      const result = await window.PC.api(`/pomodoro/${name}`, { method: 'POST', body: body ?? {} });
      applyStatus(result?.status ?? result);
      if (message) window.PC.toast?.(message);
      // 起止会改变「未完成待办」的候选（完成态/投入时长），顺手刷新一次
      loadAll({ quiet: true });
    } catch (error) {
      ui.error = error?.message ?? String(error);
      window.PC.toast?.(ui.error);
      paint();
    } finally {
      ui.busy = null;
      paint();
    }
  }

  /* ------------------------------------------------------------ 渲染 */

  function taskMap() {
    const map = new Map();
    for (const item of ui.todos) map.set(item.id, item);
    // 当前关联的待办可能已经完成（不在未完成列表里）：补进 map，选择器才不会显示成空
    if (ui.status?.taskId && ui.status.taskTitle && !map.has(ui.status.taskId)) {
      map.set(ui.status.taskId, { id: ui.status.taskId, title: ui.status.taskTitle, parentId: null, completed: true, spentSec: 0 });
    }
    return map;
  }

  /** 带父级路径的显示名：`期末复习 / 第一章 / 看例题`。 */
  function taskPath(item, map, seen = new Set()) {
    if (!item) return '';
    if (!item.parentId || seen.has(item.id)) return item.title;
    seen.add(item.id);
    const parent = map.get(item.parentId);
    return parent ? `${taskPath(parent, map, seen)} / ${item.title}` : item.title;
  }

  function paint() {
    const mount = ui.mount;
    if (!mount) return;
    mount.innerHTML = '';
    const content = mk('div', 'view-content pm-view');
    mount.appendChild(content);
    ui.refs = {};

    if (ui.loading && !ui.status) {
      content.appendChild(mk('div', 'pm-loading', '正在读取番茄钟…'));
      return;
    }
    if (!ui.status) {
      content.appendChild(mk('div', 'pm-error', ui.error ?? '番茄钟暂时不可用'));
      content.appendChild(button('重试', 'pm-btn', () => loadAll()));
      return;
    }

    content.appendChild(header());
    if (ui.error) content.appendChild(mk('div', 'pm-error', ui.error));
    content.appendChild(hero());
    content.appendChild(actions());
    content.appendChild(taskCard());
    content.appendChild(todayCard());
    content.appendChild(chartCard());
    content.appendChild(settingsCard());
    updateClock();
    updateButtons();
  }

  function header() {
    const head = mk('div', 'pm-head');
    head.appendChild(mk('h2', 'pm-title', '番茄钟'));
    head.appendChild(
      mk('p', 'pm-sub', '专注与休息到点自动切换；专注秒数会记到关联待办（含它的所有父任务）。刷新页面不会丢计时。'),
    );
    return head;
  }

  function hero() {
    const status = ui.status;
    const wrap = mk('section', `pm-hero pm-phase-${status.phase}`);
    const ringWrap = mk('div', 'pm-ring-wrap');

    const svg = svgEl('svg', {
      class: 'pm-ring',
      viewBox: '0 0 220 220',
      width: '220',
      height: '220',
      role: 'img',
      'aria-label': '番茄钟剩余时间圆环',
    });
    svg.appendChild(svgEl('circle', { class: 'pm-ring-bg', cx: 110, cy: 110, r: RING_R }));
    const fg = svgEl('circle', {
      class: 'pm-ring-fg',
      cx: 110,
      cy: 110,
      r: RING_R,
      'stroke-dasharray': RING_C,
      'stroke-dashoffset': ringOffset(remainingOf(status), status.totalSec),
    });
    svg.appendChild(fg);
    ui.refs.ring = fg;
    ringWrap.appendChild(svg);

    const overlay = mk('div', 'pm-clock');
    ui.refs.time = mk('div', 'pm-time', fmtClock(remainingOf(status)));
    ui.refs.phase = mk('div', 'pm-phase', PHASE_LABEL[status.phase] ?? status.phase);
    ui.refs.round = mk('div', 'pm-tomatoes', `🍅 × ${status.round ?? 0}`);
    overlay.append(ui.refs.time, ui.refs.phase, ui.refs.round);
    ringWrap.appendChild(overlay);
    wrap.appendChild(ringWrap);

    ui.refs.task = mk(
      'div',
      'pm-current-task',
      status.taskTitle
        ? `当前关联：${status.taskTitle}`
        : status.phase === 'idle'
          ? '还没有关联待办（开始前可在下面选一个）'
          : '这次专注没有关联待办',
    );
    wrap.appendChild(ui.refs.task);

    const note = mk(
      'div',
      'pm-ring-note',
      status.running
        ? `预计 ${fmtClock(remainingOf(status))} 后结束${status.config?.autoStartNext ? '，随后自动进入下一阶段' : '（不会自动开始下一阶段）'}`
        : status.phase === 'idle'
          ? `下一次专注 ${status.config?.studyMin ?? 45} 分钟，休息 ${status.config?.breakMin ?? 15} 分钟`
          : '已暂停，点「继续」接着计时',
    );
    wrap.appendChild(note);
    return wrap;
  }

  function actions() {
    const status = ui.status;
    const row = mk('div', 'pm-actions');
    const busy = Boolean(ui.busy);

    const primaryLabel = status.running ? '暂停' : status.phase === 'idle' ? '开始专注' : '继续';
    const primary = button(primaryLabel, 'pm-btn pm-primary', () => {
      if (ui.busy) return;
      prepareAudio();
      if (status.running) doAction('pause', {}, '已暂停');
      else if (status.phase === 'idle') doAction('start', { taskId: status.taskId ?? null }, '开始专注');
      else doAction('resume', {}, '继续');
    });
    primary.disabled = busy;
    ui.refs.primary = primary;

    const skip = button('跳过', 'pm-btn', () => doAction('skip', {}, '已跳过当前阶段'));
    skip.disabled = busy || status.phase === 'idle';
    ui.refs.skip = skip;

    const reset = button('重置', 'pm-btn pm-danger', () => doAction('stop', {}, '已结束本次番茄钟'));
    reset.disabled = busy || status.phase === 'idle';
    ui.refs.reset = reset;

    row.append(primary, skip, reset);
    return row;
  }

  function taskCard() {
    const card = mk('section', 'pm-card');
    card.appendChild(mk('h3', 'pm-card-title', '关联待办'));
    const map = taskMap();
    const status = ui.status;
    const row = mk('div', 'pm-task-row');

    const select = mk('select', 'pm-select');
    select.setAttribute('aria-label', '关联一个未完成待办');
    const none = mk('option', null, '不关联待办');
    none.value = '';
    select.appendChild(none);

    for (const item of ui.todos) {
      if (item.completed) continue;
      const spent = fmtSpent(item.spentSec ?? item.spentSelfSec ?? 0);
      const spentText = spent === '未投入' ? '尚未投入' : `已投入 ${spent}`;
      const option = mk('option', null, `${taskPath(item, map)}（${spentText}）`);
      option.value = item.id;
      select.appendChild(option);
    }
    // 当前关联的任务若不在未完成列表（已完成/刚被删除），仍然显示出来并标注，避免选择器"凭空清空"
    if (status.taskId && !ui.todos.some((item) => item.id === status.taskId && !item.completed)) {
      const option = mk('option', null, `${status.taskTitle ?? status.taskId}（已完成或不可用）`);
      option.value = status.taskId;
      select.appendChild(option);
    }
    select.value = status.taskId ?? '';
    select.addEventListener('change', () => {
      const taskId = select.value || null;
      doAction('setTask', { taskId }, taskId ? '已切换关联待办' : '已取消关联待办');
    });
    select.disabled = Boolean(ui.busy);
    ui.refs.select = select;

    const hint = mk(
      'div',
      'pm-hint',
      '只列未完成待办。专注时长会记到这条待办自己，并汇总到它的所有父任务；已完成的任务不再累计。',
    );
    row.appendChild(select);
    card.append(row, hint);
    return card;
  }

  function statCard(label, value, hint) {
    const box = mk('div', 'pm-stat');
    box.appendChild(mk('div', 'pm-stat-label', label));
    box.appendChild(mk('div', 'pm-stat-value', value));
    if (hint) box.appendChild(mk('div', 'pm-stat-hint', hint));
    return box;
  }

  function todayCard() {
    const today = ui.status.today ?? { studySec: 0, breakSec: 0, sessions: 0 };
    const card = mk('section', 'pm-card');
    card.appendChild(mk('h3', 'pm-card-title', '今日'));
    const stats = mk('div', 'pm-stats');
    const studyMin = Math.round((Number(today.studySec) || 0) / 60);
    const breakMin = Math.round((Number(today.breakSec) || 0) / 60);
    stats.appendChild(statCard('专注', `${studyMin} 分钟`, `${today.studySec ?? 0} 秒`));
    stats.appendChild(statCard('番茄', `${today.sessions ?? 0} 个`, '含跳过/停止的部分时长'));
    stats.appendChild(statCard('休息', `${breakMin} 分钟`, `${today.breakSec ?? 0} 秒`));
    card.appendChild(stats);
    return card;
  }

  function chartCard() {
    const daily = Array.isArray(ui.status.daily) ? ui.status.daily : [];
    const card = mk('section', 'pm-card');
    card.appendChild(mk('h3', 'pm-card-title', '近 7 天专注'));
    card.appendChild(barChart(daily));
    return card;
  }

  /**
   * 纯 SVG 柱状图（不引图表库、不用 inline style）。
   * 柱子的高度用 `<rect height>` 表达，颜色/圆角在 CSS 里 —— 这样 CSP 不会拦，
   * 手机上也只是一张 100% 宽的矢量图，不会横向溢出。
   */
  function barChart(daily) {
    const width = 320;
    const height = 118;
    const plotTop = 10;
    const plotBottom = 92;
    const plotHeight = plotBottom - plotTop;
    const slot = width / Math.max(1, daily.length);
    const barWidth = Math.min(24, slot * 0.52);
    const max = Math.max(1, ...daily.map((item) => Number(item.studySec) || 0));

    const svg = svgEl('svg', {
      class: 'pm-chart',
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': '近 7 天每天专注秒数的柱状图',
    });
    svg.appendChild(svgEl('line', { class: 'pm-chart-axis', x1: 6, y1: plotBottom, x2: width - 6, y2: plotBottom }));

    daily.forEach((item, index) => {
      const value = Math.max(0, Number(item.studySec) || 0);
      const barHeight = value > 0 ? Math.max(2, Math.round((value / max) * plotHeight)) : 0;
      const x = Math.round(index * slot + (slot - barWidth) / 2);
      const y = plotBottom - barHeight;
      if (barHeight > 0) {
        svg.appendChild(
          svgEl('rect', {
            class: 'pm-chart-bar',
            x,
            y,
            width: Math.round(barWidth),
            height: barHeight,
            rx: 3,
          }),
        );
        if (value >= 60) {
          const label = svgEl('text', {
            class: 'pm-chart-value',
            x: Math.round(x + barWidth / 2),
            y: Math.max(9, y - 3),
            'text-anchor': 'middle',
          });
          label.textContent = `${Math.round(value / 60)}m`;
          svg.appendChild(label);
        }
      }
      const dayLabel = svgEl('text', {
        class: 'pm-chart-day',
        x: Math.round(x + barWidth / 2),
        y: 108,
        'text-anchor': 'middle',
      });
      dayLabel.textContent = fmtDay(item.day);
      svg.appendChild(dayLabel);
    });
    return svg;
  }

  function settingsCard() {
    const config = ui.status.config ?? {};
    const card = mk('section', 'pm-card pm-settings');
    card.appendChild(mk('h3', 'pm-card-title', '设置'));
    const grid = mk('div', 'pm-settings-grid');

    const study = numberField('专注（分钟）', config.studyMin, 1, 240);
    const rest = numberField('休息（分钟）', config.breakMin, 1, 240);
    grid.append(study.wrap, rest.wrap);

    const auto = checkField('自动进入下一阶段', config.autoStartNext !== false);
    const sound = checkField('提示音', config.sound !== false);
    grid.append(auto.wrap, sound.wrap);

    const save = button('保存设置', 'pm-btn pm-primary', () => {
      const studyMin = Number(study.input.value);
      const breakMin = Number(rest.input.value);
      if (!Number.isFinite(studyMin) || studyMin < 1 || studyMin > 240 || !Number.isFinite(breakMin) || breakMin < 1 || breakMin > 240) {
        window.PC.toast?.('专注/休息分钟数必须在 1~240 之间');
        return;
      }
      doAction(
        'config',
        { studyMin, breakMin, autoStartNext: auto.input.checked, sound: sound.input.checked },
        '设置已保存（当前阶段时长不变）',
      );
    });
    save.disabled = Boolean(ui.busy);
    card.append(grid, save);
    const hint = mk('div', 'pm-hint', '修改只影响之后的阶段；正在倒计时的阶段不会被重置。');
    card.appendChild(hint);
    return card;
  }

  function numberField(label, value, min, max) {
    const wrap = mk('label', 'pm-field');
    wrap.appendChild(mk('span', 'pm-field-label', label));
    const input = mk('input', 'pm-input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.value = String(value ?? '');
    wrap.appendChild(input);
    return { wrap, input };
  }

  function checkField(label, checked) {
    const wrap = mk('label', 'pm-field pm-check');
    const input = mk('input', 'pm-checkbox');
    input.type = 'checkbox';
    input.checked = Boolean(checked);
    wrap.append(input, mk('span', 'pm-field-label', label));
    return { wrap, input };
  }

  /** 每秒只更新数字/圆环/按钮文案，不重建 DOM（否则用户正在操作的下拉框会被打断）。 */
  function updateClock() {
    const status = ui.status;
    if (!status || !ui.refs.time) return;
    const remaining = remainingOf(status);
    ui.refs.time.textContent = fmtClock(remaining);
    ui.refs.phase.textContent = PHASE_LABEL[status.phase] ?? status.phase;
    ui.refs.round.textContent = `🍅 × ${status.round ?? 0}`;
    if (ui.refs.ring) {
      ui.refs.ring.setAttribute('stroke-dashoffset', ringOffset(remaining, status.totalSec));
    }
    if (ui.refs.task) {
      const text = status.taskTitle
        ? `当前关联：${status.taskTitle}`
        : status.phase === 'idle'
          ? '还没有关联待办（开始前可在下面选一个）'
          : '这次专注没有关联待办';
      ui.refs.task.textContent = text;
    }
  }

  function updateButtons() {
    const status = ui.status;
    if (!status) return;
    const busy = Boolean(ui.busy);
    if (ui.refs.primary) {
      ui.refs.primary.textContent = status.running ? '暂停' : status.phase === 'idle' ? '开始专注' : '继续';
      ui.refs.primary.disabled = busy;
    }
    if (ui.refs.skip) ui.refs.skip.disabled = busy || status.phase === 'idle';
    if (ui.refs.reset) ui.refs.reset.disabled = busy || status.phase === 'idle';
  }

  /* ------------------------------------------------------------ 生命周期 */

  function tick() {
    attachSocket();
    if (!ui.status) return;
    updateClock();
    if (ui.status.running && remainingOf(ui.status) <= 0) onLocalZero();
  }

  function stopTicker() {
    if (ui.ticker && typeof clearInterval === 'function') clearInterval(ui.ticker);
    ui.ticker = null;
  }

  function render({ mount }) {
    ui.mount = mount;
    stopTicker();
    // 先把旧状态画出来（切回本页时不闪空白），再拉最新状态
    paint();
    if (typeof setInterval === 'function') {
      ui.ticker = setInterval(tick, 1000);
      ui.ticker.unref?.();
    }
    loadAll({ quiet: Boolean(ui.status) });
  }

  window.PCModules.register({
    id: 'pomodoro',
    label: '番茄钟',
    icon: '🍅',
    order: 21,
    title: '番茄钟',
    render,
  });

  // 测试/维护用的服务：显式停掉 1 秒 ticker，避免 node:test 里的 interval 拖住进程。
  window.PCModules.service('pomodoro', {
    refresh: () => loadAll(),
    dispose: stopTicker,
    ringOffset,
  });

  /**
   * 全局挂一个很轻的 watcher：即使用户停在别的页面（番茄钟视图没有 render），
   * 阶段结束的 WS 事件也要能弹提醒。它只检查"外壳的 socket 换了没有"，不发请求。
   * `unref` 让 node:test 里这个 interval 不拖住进程。
   */
  if (typeof setInterval === 'function') {
    const socketWatcher = setInterval(() => {
      if (window.PC?.state?.socket) attachSocket();
    }, 2000);
    socketWatcher.unref?.();
  }
})();
