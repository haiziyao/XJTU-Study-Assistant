/**
 * 测试窗口渲染层（无框架、无构建步骤）。
 *
 * 只做四件事，用于验证后端接口：
 * 1. 指令解析 -> 展示 draft，再执行 -> 展示结果；
 * 2. 拉取今日日程列表；
 * 3. 通过 WebSocket 接收提醒 / 数据变更并刷新；
 * 4. 一键「顺延未完成到本周」。
 */

const state = { apiBase: null, wsUrl: null, socket: null };

const el = (id) => document.getElementById(id);
const output = el('output');
const statusEl = el('status');
const agendaEl = el('agenda');
const todayLabel = el('today-label');

const EXAMPLES = [
  '添加日程 明天 15:00-16:00 项目周会 提前10分钟提醒',
  '添加日程 每周一 9点半 英语晨读',
  '添加日历事件 2025-10-20 到 2025-10-22 期中考试 重要',
  '查询本周日程',
  '完成今天的学习',
];

function show(value) {
  output.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function toast(text) {
  const node = el('toast');
  node.textContent = text;
  node.classList.add('show');
  setTimeout(() => node.classList.remove('show'), 3200);
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
    throw error;
  }
  return payload;
}

function todayKey() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function loadAgenda() {
  const date = todayKey();
  todayLabel.textContent = date;
  try {
    const { allDay, timed, stats } = await api(`/schedules/agenda?date=${date}`);
    const items = [...allDay, ...timed];
    if (!items.length) {
      agendaEl.innerHTML = '<div class="empty">今天还没有日程，试试上面的指令添加一条。</div>';
      return;
    }
    agendaEl.innerHTML = items
      .map(
        (item) => `
        <div class="item priority-${item.priority}${item.status === 'done' ? ' done' : ''}${item.allDay ? ' all-day' : ''}">
          <span class="time">${item.allDay ? '全天' : `${item.startTime ?? ''}${item.endTime ? `-${item.endTime}` : ''}`}</span>
          <span class="title">${escapeHtml(item.title)}</span>
          <span class="meta">${item.category}${item.complexity ? ` · ${item.complexity}` : ''}${item.status !== 'pending' ? ` · ${item.status}` : ''}</span>
        </div>`,
      )
      .join('');
    if (stats) todayLabel.textContent = `${date} · 完成 ${stats.done}/${stats.total}`;
  } catch (error) {
    agendaEl.innerHTML = `<div class="empty">加载失败：${escapeHtml(error.message)}</div>`;
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

async function parseCommand() {
  const text = el('command').value.trim();
  if (!text) return;
  try {
    const { draft } = await api('/commands/parse', { method: 'POST', body: { text } });
    show(draft);
  } catch (error) {
    show(error.payload ?? error.message);
  }
}

async function runCommand() {
  const text = el('command').value.trim();
  if (!text) return;
  try {
    const result = await api('/commands/run', { method: 'POST', body: { text } });
    show(result);
    toast(result.explain ?? '已执行');
    await loadAgenda();
  } catch (error) {
    show(error.payload ?? error.message);
  }
}

async function rollover() {
  try {
    const result = await api('/schedules/rollover', { method: 'POST', body: {} });
    show(result);
    toast(`已顺延 ${result.moved} 条未完成日程`);
    await loadAgenda();
  } catch (error) {
    show(error.payload ?? error.message);
  }
}

function connectSocket() {
  if (!state.wsUrl) return;
  const socket = new WebSocket(state.wsUrl);
  state.socket = socket;
  socket.onopen = () => {
    statusEl.textContent = `已连接 ${state.apiBase}`;
    statusEl.className = 'status ok';
  };
  socket.onclose = () => {
    statusEl.textContent = '连接已断开，3 秒后重连…';
    statusEl.className = 'status error';
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
      toast(`提醒：${message.payload.startTime ?? '全天'} ${message.payload.title}`);
      return;
    }
    if (message.type === 'data_changed') loadAgenda();
  };
}

async function boot() {
  EXAMPLES.forEach((example) => {
    const button = document.createElement('button');
    button.textContent = example;
    button.addEventListener('click', () => {
      el('command').value = example;
      parseCommand();
    });
    el('examples').appendChild(button);
  });

  el('parse').addEventListener('click', parseCommand);
  el('run').addEventListener('click', runCommand);
  el('refresh').addEventListener('click', loadAgenda);
  el('rollover').addEventListener('click', rollover);
  el('command').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') runCommand();
  });

  const info = await resolveInfo();
  state.apiBase = info.baseUrl;
  state.wsUrl = info.wsUrl;
  document.documentElement.style.setProperty('--blue', info.theme?.accent?.blue ?? '#6c8cff');
  if (!state.apiBase) {
    statusEl.textContent = '后端未启动';
    statusEl.className = 'status error';
    return;
  }
  connectSocket();
  await loadAgenda();
}

/**
 * 获取后端地址。
 * - Electron 中由 preload 通过 IPC 返回实际端口；
 * - 页面由后端自己托管时（`/app`），直接使用同源地址；
 * - 其它情况（如 file:// 打开）回退到默认地址，可用
 *   `?api=http://127.0.0.1:3211/api/v1&ws=ws://127.0.0.1:3211/ws` 覆盖。
 */
async function resolveInfo() {
  if (window.potatoCalendar?.getInfo) return window.potatoCalendar.getInfo();
  const params = new URLSearchParams(location.search);
  const sameOrigin = location.protocol.startsWith('http') && location.pathname.startsWith('/app');
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    baseUrl: params.get('api') ?? (sameOrigin ? `${location.origin}/api/v1` : 'http://127.0.0.1:3210/api/v1'),
    wsUrl: params.get('ws') ?? (sameOrigin ? `${wsProtocol}//${location.host}/ws` : 'ws://127.0.0.1:3210/ws'),
    theme: null,
  };
}

boot();
