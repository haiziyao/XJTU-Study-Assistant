// DeepSeek Chat 日历前端逻辑

const $ = (id) => document.getElementById(id);

let currentYear, currentMonth;   // 0-based month
let currentView = 'month';       // month / week / day
let selectedDate = null;         // 'YYYY-MM-DD'
let weekStart = null;            // 周视图起始日期 'YYYY-MM-DD'
let eventsByDate = {};           // date -> [event]
let todosByDate = {};            // due_date -> [todo]
let allEvents = [];              // 全部日程（含循环，未展开）
let semesters = [];              // 学期规则
let editingEventId = null;

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const isMobile = () => window.innerWidth <= 768;

// ---------------------------------------------------------------- 工具
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  if (resp.status === 401) {
    location.href = '/login';
    throw new Error('未登录');
  }
  if (!resp.ok) {
    let msg = 'HTTP ' + resp.status;
    try { msg = (await resp.json()).error || msg; } catch (e) {}
    throw new Error(msg);
  }
  return resp.json();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayStr() { return fmtDate(new Date()); }
function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }

// ---------------------------------------------------------------- 数据
async function loadMonth() {
  const [evData, tdData, semData] = await Promise.all([
    api('GET', '/api/events'),
    api('GET', '/api/todos'),
    api('GET', '/api/semesters'),
  ]);

  allEvents = evData.events || [];
  semesters = semData.semesters || [];

  todosByDate = {};
  (tdData.todos || []).forEach((t) => {
    if (t.due_date && !t.completed) {
      (todosByDate[t.due_date] = todosByDate[t.due_date] || []).push(t);
    }
  });

  render();
}

// 计算当前视图的可见日期范围
function visibleRange() {
  if (currentView === 'week') {
    const days = getWeekDays();
    return { start: days[0], end: days[6] };
  }
  if (currentView === 'day') {
    const ds = selectedDate || todayStr();
    return { start: ds, end: ds };
  }
  const start = `${currentYear}-${pad(currentMonth + 1)}-01`;
  const end = `${currentYear}-${pad(currentMonth + 1)}-${pad(daysInMonth(currentYear, currentMonth))}`;
  return { start, end };
}

// 展开循环事件到日期范围
function generateOccurrences(e, rangeStart, rangeEnd) {
  const dates = [];
  const interval = Math.max(1, e.repeat_interval || 1);
  const start = parseDate(e.date);
  const rs = parseDate(rangeStart);
  const re = parseDate(rangeEnd);
  const endLimit = e.repeat_end ? parseDate(e.repeat_end) : null;
  let cur = new Date(start);
  let guard = 0;
  while (guard++ < 5000) {
    if (endLimit && cur > endLimit) break;
    if (cur >= rs && cur <= re) dates.push(fmtDate(cur));
    if (cur > re) break;
    if (e.repeat === 'daily') cur.setDate(cur.getDate() + interval);
    else if (e.repeat === 'weekly') cur.setDate(cur.getDate() + 7 * interval);
    else if (e.repeat === 'monthly') cur.setMonth(cur.getMonth() + interval);
    else if (e.repeat === 'yearly') cur.setFullYear(cur.getFullYear() + interval);
    else break;
  }
  return dates;
}

function buildEventsByDate() {
  const { start, end } = visibleRange();
  eventsByDate = {};
  for (const e of allEvents) {
    if (e.repeat && e.repeat !== 'none') {
      generateOccurrences(e, start, end).forEach((d) => {
        (eventsByDate[d] = eventsByDate[d] || []).push({ ...e, date: d, _recurring: true });
      });
    } else {
      if (e.date >= start && e.date <= end) {
        (eventsByDate[e.date] = eventsByDate[e.date] || []).push(e);
      }
    }
  }
}

// 学期周计算：返回 { name, weekNum } 或 null
function weekInfo(dateStr) {
  for (const s of semesters) {
    if (!s.start_date) continue;
    const start = parseDate(s.start_date);
    // 第一周 = start_date 所在的那一周（周一开始）
    const monday = new Date(start);
    const day = monday.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    monday.setDate(monday.getDate() + diff);
    const target = parseDate(dateStr);
    const diffDays = Math.round((target - monday) / 86400000);
    if (diffDays < 0) continue;
    const weekNum = Math.floor(diffDays / 7) + 1;
    if (weekNum > (s.total_weeks || 18)) continue;
    return { name: s.name, weekNum };
  }
  return null;
}


// ---------------------------------------------------------------- 渲染
function render() {
  buildEventsByDate();
  if (currentView === 'week') {
    renderWeek();
  } else if (currentView === 'day') {
    renderDay();
  } else {
    renderMonth();
  }
}

function monthTitle() {
  return `${currentYear}年${currentMonth + 1}月`;
}

function renderMonth() {
  $('month-label').textContent = monthTitle();
  renderHeaderRow(WEEKDAYS);

  const daysEl = $('calendar-days');
  daysEl.innerHTML = '';
  daysEl.className = 'calendar-days month';

  const first = new Date(currentYear, currentMonth, 1);
  const startWeekday = first.getDay(); // 0=周日
  const total = daysInMonth(currentYear, currentMonth);

  // 前置空位
  for (let i = 0; i < startWeekday; i++) {
    const empty = document.createElement('div');
    empty.className = 'cal-day empty';
    daysEl.appendChild(empty);
  }

  const today = todayStr();
  for (let d = 1; d <= total; d++) {
    const dateStr = `${currentYear}-${pad(currentMonth + 1)}-${pad(d)}`;
    daysEl.appendChild(renderDayCell(dateStr, d, today));
  }

  renderDayPanel();
}

function renderDayCell(dateStr, num, today) {
  const cell = document.createElement('div');
  cell.className = 'cal-day' + (dateStr === today ? ' today' : '');
  if (dateStr === selectedDate) cell.classList.add('selected');

  const numEl = document.createElement('div');
  numEl.className = 'cal-day-num';
  numEl.textContent = num;
  cell.appendChild(numEl);

  // 学期周标记 (第几周 周几)
  const wk = weekInfo(dateStr);
  if (wk) {
    const wb = document.createElement('div');
    wb.className = 'cal-badge week';
    const wd = parseDate(dateStr).getDay();
    wb.textContent = `${wk.weekNum}周·周${WEEKDAYS[wd]}`;
    cell.appendChild(wb);
  }

  // 日程标记
  const evs = eventsByDate[dateStr] || [];
  const tds = todosByDate[dateStr] || [];
  const totalBadges = evs.length + tds.length;
  evs.slice(0, 3).forEach((e) => {
    const b = document.createElement('div');
    b.className = 'cal-badge event';
    b.textContent = (e.all_day ? '' : (e.start_time ? e.start_time + ' ' : '')) + e.title;
    cell.appendChild(b);
  });
  tds.slice(0, Math.max(0, 3 - evs.slice(0, 3).length)).forEach((t) => {
    const b = document.createElement('div');
    b.className = 'cal-badge todo';
    b.textContent = '✓ ' + t.title;
    cell.appendChild(b);
  });
  if (totalBadges > 3) {
    const more = document.createElement('div');
    more.className = 'cal-badge more';
    more.textContent = `+${totalBadges - 3}`;
    cell.appendChild(more);
  }

  cell.addEventListener('click', () => { selectedDate = dateStr; render(); });
  return cell;
}

function renderHeaderRow(labels) {
  const hdr = $('calendar-header-row');
  hdr.innerHTML = '';
  labels.forEach((l) => {
    const s = document.createElement('span');
    s.textContent = l;
    hdr.appendChild(s);
  });
}

function getWeekDays() {
  const base = parseDate(weekStart || todayStr());
  const start = new Date(base);
  start.setDate(start.getDate() - start.getDay()); // 回到周日
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(fmtDate(d));
  }
  return days;
}

function renderWeek() {
  const days = getWeekDays();
  const b0 = parseDate(days[0]);
  const b6 = parseDate(days[6]);
  const wk = weekInfo(days[1]); // 周一判断第几周
  $('month-label').textContent =
    `${b0.getFullYear()}年${b0.getMonth() + 1}月${b0.getDate()}日 - ${b6.getMonth() + 1}月${b6.getDate()}日` +
    (wk ? ` · ${wk.name} 第${wk.weekNum}周` : '');

  renderHeaderRow(days.map((ds) => {
    const d = parseDate(ds);
    return WEEKDAYS[d.getDay()] + ' ' + d.getDate();
  }));

  const daysEl = $('calendar-days');
  daysEl.innerHTML = '';
  daysEl.className = 'calendar-days week';

  const today = todayStr();
  days.forEach((ds) => {
    const col = document.createElement('div');
    col.className = 'week-col' + (ds === today ? ' today' : '');
    if (ds === selectedDate) col.classList.add('selected');

    const evs = eventsByDate[ds] || [];
    const tds = todosByDate[ds] || [];
    evs.sort((a, b) => {
      const ka = a.all_day ? '0' : (a.start_time || '99');
      const kb = b.all_day ? '0' : (b.start_time || '99');
      return ka.localeCompare(kb);
    });
    evs.forEach((e) => {
      const item = document.createElement('div');
      item.className = 'week-event';
      item.textContent = (e.all_day ? '全天 ' : (e.start_time || '') + ' ') + e.title;
      col.appendChild(item);
    });
    tds.forEach((t) => {
      const item = document.createElement('div');
      item.className = 'week-todo';
      item.textContent = '✓ ' + t.title;
      col.appendChild(item);
    });

    col.addEventListener('click', () => { selectedDate = ds; currentView = 'day'; render(); });
    daysEl.appendChild(col);
  });

  renderDayPanel();
}

function renderDay() {
  const ds = selectedDate || todayStr();
  const d = parseDate(ds);
  $('month-label').textContent =
    `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;

  renderHeaderRow([]);

  const daysEl = $('calendar-days');
  daysEl.innerHTML = '';
  daysEl.className = 'calendar-days day';

  const evs = eventsByDate[ds] || [];
  const tds = todosByDate[ds] || [];
  evs.sort((a, b) => {
    const ka = a.all_day ? '0' : (a.start_time || '99');
    const kb = b.all_day ? '0' : (b.start_time || '99');
    return ka.localeCompare(kb);
  });

  evs.forEach((e) => daysEl.appendChild(renderEventItem(e)));
  tds.forEach((t) => {
    const item = document.createElement('div');
    item.className = 'day-todo-item';
    item.innerHTML = `<span class="cal-badge todo">✓ 待办</span> <span>${escapeHtml(t.title)}</span>`;
    daysEl.appendChild(item);
  });
  if (evs.length === 0 && tds.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'day-empty';
    empty.textContent = '当天暂无安排';
    daysEl.appendChild(empty);
  }

  renderDayPanel();
}

function selectDate(dateStr) {
  selectedDate = dateStr;
  render();
}

function renderDayPanel() {
  const panel = $('day-panel');
  // 日视图下隐藏详情面板 (内容已直接展示)
  if (currentView === 'day') {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';

  const titleEl = $('day-panel-title');
  if (!selectedDate) {
    titleEl.textContent = '点击日历中的日期查看详情';
    $('day-events').innerHTML = '';
    $('add-event-btn').style.display = 'none';
    return;
  }
  $('add-event-btn').style.display = '';
  const d = new Date(selectedDate + 'T00:00:00');
  titleEl.textContent = `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]} `;

  const evs = eventsByDate[selectedDate] || [];
  const tds = todosByDate[selectedDate] || [];

  const container = $('day-events');
  container.innerHTML = '';

  if (evs.length === 0 && tds.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'day-empty';
    empty.textContent = '当天暂无安排';
    container.appendChild(empty);
  }

  // 日程
  evs.sort((a, b) => (a.all_day ? 0 : 1) - (b.all_day ? 0 : 1));
  evs.forEach((e) => container.appendChild(renderEventItem(e)));

  // 待办
  tds.forEach((t) => {
    const item = document.createElement('div');
    item.className = 'day-todo-item';
    item.innerHTML = `<span class="cal-badge todo">✓ 待办</span> <span>${escapeHtml(t.title)}</span>`;
    container.appendChild(item);
  });
}

function renderEventItem(e) {
  const item = document.createElement('div');
  item.className = 'day-event-item';

  const timeEl = document.createElement('span');
  timeEl.className = 'day-event-time';
  timeEl.textContent = e.all_day ? '全天' : `${e.start_time || '?'} - ${e.end_time || '?'}`;
  item.appendChild(timeEl);

  const titleEl = document.createElement('span');
  titleEl.className = 'day-event-title';
  titleEl.textContent = e.title;
  item.appendChild(titleEl);

  if (e.location) {
    const locEl = document.createElement('span');
    locEl.className = 'day-event-location';
    locEl.textContent = '📍 ' + e.location;
    item.appendChild(locEl);
  }

  if (e.notes) {
    const noteEl = document.createElement('div');
    noteEl.className = 'day-event-notes';
    noteEl.textContent = e.notes;
    item.appendChild(noteEl);
  }

  const actions = document.createElement('div');
  actions.className = 'day-event-actions';
  const edit = document.createElement('button');
  edit.className = 'icon';
  edit.textContent = '✎';
  edit.title = '编辑';
  edit.addEventListener('click', () => openEdit(e));
  const del = document.createElement('button');
  del.className = 'icon';
  del.textContent = '✕';
  del.title = '删除';
  del.addEventListener('click', () => deleteEvent(e));
  actions.appendChild(edit);
  actions.appendChild(del);
  item.appendChild(actions);

  return item;
}

// ---------------------------------------------------------------- 弹窗
function openCreate() {
  editingEventId = null;
  $('event-modal-title').textContent = '新建日程';
  $('event-title').value = '';
  $('event-date').value = selectedDate || todayStr();
  $('event-all-day').checked = false;
  $('event-start').value = '';
  $('event-end').value = '';
  $('event-location').value = '';
  $('event-notes').value = '';
  $('event-repeat').value = 'none';
  $('event-repeat-interval').value = '1';
  $('event-repeat-end').value = '';
  toggleTimeFields();
  toggleRepeatFields();
  $('event-modal').style.display = 'flex';
  $('event-title').focus();
}

function openEdit(e) {
  editingEventId = e.id;
  $('event-modal-title').textContent = '编辑日程';
  $('event-title').value = e.title || '';
  $('event-date').value = e.date || '';
  $('event-all-day').checked = !!e.all_day;
  $('event-start').value = e.start_time || '';
  $('event-end').value = e.end_time || '';
  $('event-location').value = e.location || '';
  $('event-repeat').value = e.repeat || 'none';
  $('event-repeat-interval').value = e.repeat_interval || 1;
  $('event-repeat-end').value = e.repeat_end || '';
  $('event-notes').value = e.notes || '';
  toggleTimeFields();
  toggleRepeatFields();
  $('event-modal').style.display = 'flex';
}

function closeModal() {
  editingEventId = null;
  $('event-modal').style.display = 'none';
}

function toggleTimeFields() {
  const allDay = $('event-all-day').checked;
  $('event-start').disabled = allDay;
  $('event-end').disabled = allDay;
}

function toggleRepeatFields() {
  const rep = $('event-repeat').value;
  const hasRepeat = rep !== 'none';
  $('event-repeat-interval').disabled = !hasRepeat;
  $('event-repeat-end').disabled = !hasRepeat;
}

async function saveEvent() {
  const title = $('event-title').value.trim();
  if (!title) {
    $('event-title').focus();
    return;
  }
  const date = $('event-date').value;
  if (!date) {
    $('event-date').focus();
    return;
  }
  const allDay = $('event-all-day').checked;
  const body = {
    title,
    date,
    all_day: allDay,
    notes: $('event-notes').value.trim(),
    location: $('event-location').value.trim(),
    repeat: $('event-repeat').value,
    repeat_interval: parseInt($('event-repeat-interval').value, 10) || 1,
    repeat_end: $('event-repeat-end').value || null,
  };
  if (allDay) {
    body.start_time = null;
    body.end_time = null;
  } else {
    body.start_time = $('event-start').value || null;
    body.end_time = $('event-end').value || null;
  }

  if (editingEventId) {
    await api('PATCH', '/api/events/' + editingEventId, body);
  } else {
    await api('POST', '/api/events', body);
  }
  closeModal();
  await loadMonth();
}

async function deleteEvent(e) {
  if (!confirm('确定删除该日程？')) return;
  await api('DELETE', '/api/events/' + e.id);
  await loadMonth();
}

// ---------------------------------------------------------------- 账户
async function loadUser() {
  try {
    const data = await api('GET', '/api/auth/me');
    if (!data.user) location.href = '/login';
  } catch (e) {}
}

async function logout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
  location.href = '/login';
}

// ---------------------------------------------------------------- 视图切换
function setView(view) {
  currentView = view;
  document.querySelectorAll('.view-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  render();
}

// ---------------------------------------------------------------- 初始化
function init() {
  const now = new Date();
  currentYear = now.getFullYear();
  currentMonth = now.getMonth();
  selectedDate = todayStr();
  weekStart = todayStr();

  // 移动端仅月视图
  if (isMobile()) currentView = 'month';

  $('prev-month').addEventListener('click', () => {
    if (currentView === 'month') {
      currentMonth--;
      if (currentMonth < 0) { currentMonth = 11; currentYear--; }
    } else if (currentView === 'week') {
      const base = parseDate(weekStart);
      base.setDate(base.getDate() - 7);
      weekStart = fmtDate(base);
    } else {
      const d = parseDate(selectedDate);
      d.setDate(d.getDate() - 1);
      selectedDate = fmtDate(d);
    }
    loadMonth();
  });
  $('next-month').addEventListener('click', () => {
    if (currentView === 'month') {
      currentMonth++;
      if (currentMonth > 11) { currentMonth = 0; currentYear++; }
    } else if (currentView === 'week') {
      const base = parseDate(weekStart);
      base.setDate(base.getDate() + 7);
      weekStart = fmtDate(base);
    } else {
      const d = parseDate(selectedDate);
      d.setDate(d.getDate() + 1);
      selectedDate = fmtDate(d);
    }
    loadMonth();
  });
  $('today-btn').addEventListener('click', () => {
    const now = new Date();
    currentYear = now.getFullYear();
    currentMonth = now.getMonth();
    selectedDate = todayStr();
    weekStart = todayStr();
    loadMonth();
  });

  document.querySelectorAll('.view-btn').forEach((b) => {
    b.addEventListener('click', () => setView(b.dataset.view));
  });

  $('add-event-btn').addEventListener('click', openCreate);
  $('event-save').addEventListener('click', saveEvent);
  $('event-cancel').addEventListener('click', closeModal);
  $('event-modal-close').addEventListener('click', closeModal);
  $('event-all-day').addEventListener('change', toggleTimeFields);
  $('event-repeat').addEventListener('change', toggleRepeatFields);
  $('event-modal').addEventListener('click', (e) => {
    if (e.target === $('event-modal')) closeModal();
  });

  $('logout').addEventListener('click', logout);

  // ICS 订阅
  loadIcsUrl();
  $('ics-copy').addEventListener('click', copyIcsUrl);

  // 学期
  $('semester-add').addEventListener('click', addSemester);
  loadSemesters();

  loadUser();
  loadMonth();
}

// ---------------------------------------------------------------- ICS
async function loadIcsUrl() {
  try {
    const data = await api('GET', '/api/ics-token');
    if (data.url) {
      $('ics-url').value = data.url;
    }
  } catch (e) {}
}

async function copyIcsUrl() {
  const url = $('ics-url').value;
  const st = $('ics-status');
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    st.textContent = '✅ 已复制';
    st.style.color = '#27ae60';
    setTimeout(() => (st.textContent = ''), 2000);
  } catch (e) {
    st.textContent = '请手动复制上方链接';
    st.style.color = '#c0392b';
  }
}

// ---------------------------------------------------------------- 学期管理
async function loadSemesters() {
  const data = await api('GET', '/api/semesters');
  renderSemesters(data.semesters || []);
}

function renderSemesters(list) {
  const container = $('semester-list');
  container.innerHTML = '';
  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'day-empty';
    empty.textContent = '暂无学期规则';
    container.appendChild(empty);
    return;
  }
  list.forEach((s) => {
    const item = document.createElement('div');
    item.className = 'semester-item';
    const info = document.createElement('span');
    info.className = 'semester-info';
    info.textContent = `${s.name || '未命名'} · 起始 ${s.start_date} · 共 ${s.total_weeks} 周`;
    const del = document.createElement('button');
    del.className = 'icon';
    del.textContent = '✕';
    del.title = '删除';
    del.addEventListener('click', () => deleteSemester(s.id));
    item.appendChild(info);
    item.appendChild(del);
    container.appendChild(item);
  });
}

async function addSemester() {
  const name = $('semester-name').value.trim();
  const startDate = $('semester-start').value;
  const weeks = parseInt($('semester-weeks').value, 10) || 18;
  const st = $('semester-status');
  if (!startDate) {
    st.textContent = '请选择起始日期';
    st.style.color = '#c0392b';
    return;
  }
  await api('POST', '/api/semesters', { name, start_date: startDate, total_weeks: weeks });
  $('semester-name').value = '';
  $('semester-start').value = '';
  $('semester-weeks').value = '';
  st.textContent = '';
  await loadSemesters();
  await loadMonth();
}

async function deleteSemester(id) {
  if (!confirm('确定删除该学期规则？')) return;
  await api('DELETE', '/api/semesters/' + id);
  await loadSemesters();
  await loadMonth();
}

init();
