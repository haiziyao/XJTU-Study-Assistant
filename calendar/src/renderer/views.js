/**
 * 右侧功能视图层（无框架、无构建步骤，classic script）。
 *
 * 本文件只负责「把后端数据画成界面」，不关心侧边栏与对话面板；
 * 与 app.js 的约定：
 *   - window.PCUtil  纯函数工具（日期、颜色、转义），两个文件共用；
 *   - window.PC      由 app.js 在启动时挂载：{ state, api, refresh, toast }；
 *   - window.PCViews 本文件导出：{ calendar, todo, message, settings, placeholder }。
 *
 * 每个视图对象形如 { title, render(ctx) }，ctx = { mount } 为右侧面板的内容容器。
 */

/* ------------------------------------------------------------------ 工具 */

window.PCUtil = (function () {
  const WEEK_CN = ['一', '二', '三', '四', '五', '六', '日'];
  const pad2 = (n) => String(n).padStart(2, '0');

  function dateKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }
  function todayKey() {
    return dateKey(new Date());
  }
  function toDate(key) {
    const [y, m, d] = String(key).split('-').map(Number);
    return new Date(y, (m ?? 1) - 1, d ?? 1);
  }
  function addDays(key, n) {
    const d = toDate(key);
    d.setDate(d.getDate() + n);
    return dateKey(d);
  }
  function isoWeekday(key) {
    const day = toDate(key).getDay();
    return day === 0 ? 7 : day;
  }
  function startOfWeek(key) {
    return addDays(key, 1 - isoWeekday(key));
  }
  function startOfMonth(key) {
    return `${String(key).slice(0, 7)}-01`;
  }
  function addMonths(key, n) {
    const d = toDate(startOfMonth(key));
    d.setMonth(d.getMonth() + n);
    return dateKey(d);
  }
  function eachDay(from, to) {
    const out = [];
    if (to < from) return out;
    for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) out.push(cursor);
    return out;
  }
  function fmtMD(key) {
    const d = toDate(key);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  function fmtCN(key) {
    return `${fmtMD(key)} 周${WEEK_CN[isoWeekday(key) - 1]}`;
  }
  function fmtYM(key) {
    const d = toDate(key);
    return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
  }
  function weekdayCN(key) {
    return `周${WEEK_CN[isoWeekday(key) - 1]}`;
  }
  function minutes(clock) {
    const [h, m] = String(clock ?? '0:0').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }
  function clock(mins) {
    const safe = Math.max(0, Math.min(24 * 60 - 1, Math.round(mins)));
    return `${pad2(Math.floor(safe / 60))}:${pad2(safe % 60)}`;
  }
  function timeRange(item) {
    if (item.allDay || !item.startTime) return '全天';
    return `${item.startTime}${item.endTime ? `–${item.endTime}` : ''}`;
  }
  function relativeDay(key, today = todayKey()) {
    const diff = Math.round((toDate(key) - toDate(today)) / 86400000);
    if (diff === 0) return '今天';
    if (diff === 1) return '明天';
    if (diff === 2) return '后天';
    if (diff === -1) return '昨天';
    if (diff < 0) return `已逾期 ${-diff} 天`;
    return `${diff} 天后`;
  }
  function escapeHtml(text) {
    return String(text ?? '').replace(
      /[&<>"']/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]),
    );
  }

  /**
   * 内联 SVG 图标表（打磨点：替换彩色 emoji，统一线条风格）。
   * 每个值是若干 <path> / 图元，统一 24 视窗、currentColor 描边，可继承按钮文字色。
   */
  const icons = {
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    checkSquare: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 12.2l2.6 2.6L16 9.4"/>',
    cap: '<path d="M2.5 9.2L12 5l9.5 4.2L12 13.4z"/><path d="M6.5 11.6v4.2c0 1.1 2.5 2.2 5.5 2.2s5.5-1.1 5.5-2.2v-4.2"/>',
    chart: '<path d="M3.5 20.5h17"/><path d="M4 16.5l4.8-5.2 3.6 3.2L20 6.5"/><path d="M20 11V6.5h-4.5"/>',
    camera:
      '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.6l1.2-2h7.4l1.2 2h1.6A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/><circle cx="12" cy="12.4" r="3.4"/>',
    play: '<circle cx="12" cy="12" r="9"/><path d="M10 8.6l5.4 3.4-5.4 3.4z"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 7.1l8.5 6 8.5-6"/>',
    gear: '<circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.06A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.06A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.09A1.7 1.7 0 0 0 10.12 3V3a2 2 0 1 1 4 0v.06A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.06A1.7 1.7 0 0 0 19.4 15z"/>',
    trash:
      '<path d="M4 7h16"/><path d="M9.5 7V4.8h5V7"/><path d="M6.4 7l.9 12.2A1.6 1.6 0 0 0 8.9 20.7h6.2a1.6 1.6 0 0 0 1.6-1.5L17.6 7"/><path d="M10.3 11v6M13.7 11v6"/>',
    chevronRight: '<path d="M9.5 5.5l7 6.5-7 6.5"/>',
    // 课表：三列网格 + 表头（与其余图标同为 24 视窗描边风格）
    grid: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9.5h18M9 9.5v10M15 9.5v10"/>',
  };

  /** 生成内联 SVG 字符串；装饰性图标，统一 aria-hidden。 */
  function icon(name, size = 20) {
    const body = icons[name] ?? icons.calendar;
    const px = Number(size) > 0 ? Number(size) : 20;
    return (
      `<svg viewBox="0 0 24 24" width="${px}" height="${px}" fill="none" stroke="currentColor" ` +
      `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
    );
  }

  return {
    WEEK_CN,
    pad2,
    dateKey,
    todayKey,
    toDate,
    addDays,
    isoWeekday,
    startOfWeek,
    startOfMonth,
    addMonths,
    eachDay,
    fmtMD,
    fmtCN,
    fmtYM,
    weekdayCN,
    minutes,
    clock,
    timeRange,
    relativeDay,
    escapeHtml,
    icons,
    icon,
  };
})();

/* --------------------------------------------------------- 枚举与文案映射 */

const CATEGORY_LABEL = {
  class: '上课',
  study: '学习',
  meeting: '会议',
  exam: '考试',
  activity: '活动',
  holiday: '假期',
  anniversary: '纪念日',
  deadline: '截止',
  other: '其它',
};
const STATUS_LABEL = { pending: '待办', done: '已完成', cancelled: '已取消', rolled: '已顺延' };
const PRIORITY_LABEL = { 0: '低', 1: '普通', 2: '紧急' };
const ACTION_LABEL = {
  create: '新增',
  query: '查询',
  update: '修改',
  delete: '删除',
  complete: '完成',
  rollover: '顺延',
};
const TARGET_LABEL = { schedule: '日程', event: '日历事件' };
const SCHEDULE_CATEGORIES = ['class', 'study', 'meeting', 'exam', 'activity', 'other'];
const EVENT_CATEGORIES = ['study', 'exam', 'holiday', 'anniversary', 'deadline', 'other'];
const REPEAT_TYPES = [
  ['none', '不重复'],
  ['daily', '每天'],
  ['weekly', '每周'],
  ['monthly', '每月'],
  ['yearly', '每年'],
  ['weekday', '每个工作日'],
];
const REMINDER_PRESETS = [
  [null, '不提醒'],
  [0, '准点'],
  [5, '提前 5 分钟'],
  [10, '提前 10 分钟'],
  [15, '提前 15 分钟'],
  [30, '提前 30 分钟'],
  [60, '提前 1 小时'],
  [1440, '提前 1 天'],
];

/* ---------------------------------------------------------------- DOM 小工具 */

function mk(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function option(value, label, selected) {
  const node = mk('option', null, label);
  node.value = value;
  if (selected) node.selected = true;
  return node;
}

function field(labelText, control, hint) {
  const wrap = mk('div', 'field');
  wrap.appendChild(mk('span', 'field-label', labelText));
  wrap.appendChild(control);
  if (hint) wrap.appendChild(mk('span', 'field-hint', hint));
  return wrap;
}

function iconBtn(label, glyph, onClick, extraClass = '') {
  const node = mk('button', `icon-btn ${extraClass}`.trim());
  node.type = 'button';
  // 打磨点：glyph 命中图标表时渲染内联 SVG，否则退回文字符号（尺寸由样式控制）
  if (Object.prototype.hasOwnProperty.call(PCUtil.icons, glyph)) node.innerHTML = PCUtil.icon(glyph, 16);
  else node.textContent = glyph;
  node.title = label;
  node.setAttribute('aria-label', label);
  node.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick(event);
  });
  return node;
}

function errorBox(error) {
  const box = mk('div', 'error-box');
  box.appendChild(mk('div', 'eb-title', '加载失败'));
  box.appendChild(mk('div', 'eb-msg', error?.message ?? '未知错误'));
  const hint = error?.payload?.error?.details?.hint;
  if (hint) box.appendChild(mk('div', 'eb-hint', hint));
  return box;
}

function emptyBox(text) {
  return mk('div', 'empty-box', text);
}

function statPill(label, value) {
  const node = mk('div', 'stat-pill');
  node.appendChild(mk('span', 'sp-value', value));
  node.appendChild(mk('span', 'sp-label', label));
  return node;
}

/* ------------------------------------------------------------------ 数据访问 */

/** 供各视图复用的聚合查询：一次拿到区间内每天的事件与日程。 */
async function fetchCalendar(from, to) {
  const data = await PC.api(`/calendar?from=${from}&to=${to}`);
  return new Map((data.days ?? []).map((day) => [day.date, day]));
}

/** 统一的写操作包装：toast + 刷新右侧视图。 */
async function setScheduleStatus(id, status, label) {
  try {
    await PC.api(`/schedules/${id}/status`, { method: 'POST', body: { status } });
    PC.toast(label);
    PC.refresh();
  } catch (error) {
    PC.toast(error.message);
  }
}

async function removeRecord(target, id, title) {
  const name = target === 'schedule' ? '日程' : '日历事件';
  if (!window.confirm(`确定删除${name}「${title}」？`)) return;
  try {
    await PC.api(`/${target === 'schedule' ? 'schedules' : 'events'}/${id}`, { method: 'DELETE' });
    PC.toast(`已删除「${title}」`);
    PC.refresh();
  } catch (error) {
    PC.toast(error.message);
  }
}

/* ================================================================== 日历视图 */

const calendarView = {
  title: '日历',

  render(ctx) {
    const state = PC.state;
    if (state.calendar.mode === 'week' && state.panelCollapsed) state.calendar.mode = 'month';
    ctx.mount.innerHTML = '';
    ctx.mount.appendChild(calendarToolbar());
    const content = mk('div', 'view-content');
    ctx.mount.appendChild(content);
    const mode = state.calendar.mode;
    if (mode === 'week') renderWeek(content, state.calendar.anchor);
    else if (mode === 'day') renderDay(content, state.calendar.anchor);
    else renderMonth(content, state.calendar.anchor);
  },
};

function calendarToolbar() {
  const state = PC.state;
  const bar = mk('div', 'toolbar');

  const seg = mk('div', 'seg');
  for (const [mode, label] of [['month', '月'], ['week', '周'], ['day', '日']]) {
    const button = mk('button', `seg-btn${state.calendar.mode === mode ? ' active' : ''}`, label);
    button.type = 'button';
    button.dataset.mode = mode;
    if (mode === 'week' && state.panelCollapsed) {
      button.disabled = true;
      button.title = '展开右侧视图后可用';
    }
    button.addEventListener('click', () => {
      if (mode === 'week' && state.panelCollapsed) {
        PC.toast('周视图需要展开右侧视图');
        return;
      }
      state.calendar.mode = mode;
      PC.refresh();
    });
    seg.appendChild(button);
  }

  const nav = mk('div', 'nav-group');
  const step = state.calendar.mode === 'day' ? 1 : state.calendar.mode === 'week' ? 7 : 0;
  const prev = iconBtn('上一页', '‹', () => {
    state.calendar.anchor = step
      ? PCUtil.addDays(state.calendar.anchor, -step)
      : PCUtil.addMonths(state.calendar.anchor, -1);
    PC.refresh();
  });
  const next = iconBtn('下一页', '›', () => {
    state.calendar.anchor = step
      ? PCUtil.addDays(state.calendar.anchor, step)
      : PCUtil.addMonths(state.calendar.anchor, 1);
    PC.refresh();
  });
  const today = mk('button', 'ghost-btn', '今天');
  today.type = 'button';
  today.addEventListener('click', () => {
    state.calendar.anchor = PCUtil.todayKey();
    PC.refresh();
  });
  nav.append(prev, today, next);

  const title = mk('div', 'toolbar-title');
  if (state.calendar.mode === 'month') title.textContent = PCUtil.fmtYM(state.calendar.anchor);
  else if (state.calendar.mode === 'week') {
    const start = PCUtil.startOfWeek(state.calendar.anchor);
    title.textContent = `${PCUtil.fmtMD(start)} – ${PCUtil.fmtMD(PCUtil.addDays(start, 6))}`;
  } else title.textContent = PCUtil.fmtCN(state.calendar.anchor);

  const spacer = mk('div', 'spacer');
  const add = mk('button', 'primary-btn', '+ 新建');
  add.type = 'button';
  add.addEventListener('click', () =>
    openEditor({ target: 'schedule', defaults: { date: state.calendar.anchor } }),
  );

  bar.append(seg, nav, title, spacer, add);
  return bar;
}

/* ------------------------------------------------------------------ 月视图 */

function renderMonth(host, anchor) {
  const gridStart = PCUtil.startOfWeek(PCUtil.startOfMonth(anchor));
  const gridEnd = PCUtil.addDays(gridStart, 41);
  const loading = mk('div', 'loading', '加载中…');
  host.appendChild(loading);

  fetchCalendar(gridStart, gridEnd)
    .then((byDate) => {
      loading.remove();
      const head = mk('div', 'month-head');
      for (const name of PCUtil.WEEK_CN) head.appendChild(mk('div', 'weekday', `周${name}`));

      const grid = mk('div', 'month-grid');
      const today = PCUtil.todayKey();
      for (const date of PCUtil.eachDay(gridStart, gridEnd)) {
        const day = byDate.get(date) ?? { events: [], schedules: [], stats: {} };
        const cell = mk('div', 'cell');
        cell.dataset.date = date;
        if (date === today) cell.classList.add('today');
        if (date.slice(0, 7) !== String(anchor).slice(0, 7)) cell.classList.add('outside');
        if (date === PC.state.calendar.anchor) cell.classList.add('selected');

        const headEl = mk('div', 'cell-head');
        headEl.appendChild(mk('span', 'dnum', PCUtil.toDate(date).getDate()));
        const total = day.events.length + day.schedules.length;
        if (total) headEl.appendChild(mk('span', 'dstat', `${day.stats?.done ?? 0}/${total}`));

        const list = mk('div', 'cell-list');
        const chips = [
          ...day.events.map((item) => ({ kind: 'event', ...item })),
          ...day.schedules.map((item) => ({ kind: 'schedule', ...item })),
        ];
        for (const chip of chips.slice(0, 3)) list.appendChild(chipEl(chip));
        if (chips.length > 3) list.appendChild(mk('div', 'more', `+${chips.length - 3}`));

        const add = mk('button', 'cell-add', '+');
        add.type = 'button';
        add.title = '在这天新建';
        add.dataset.add = date;

        cell.append(headEl, list, add);
        grid.appendChild(cell);
      }

      grid.addEventListener('click', (event) => {
        const addBtn = event.target.closest('.cell-add');
        if (addBtn) {
          openEditor({ target: 'schedule', defaults: { date: addBtn.dataset.add } });
          return;
        }
        const cell = event.target.closest('.cell');
        if (!cell) return;
        PC.state.calendar.anchor = cell.dataset.date;
        PC.state.calendar.mode = 'day';
        PC.refresh();
      });
      grid.addEventListener('dblclick', (event) => {
        const cell = event.target.closest('.cell');
        if (cell) openEditor({ target: 'schedule', defaults: { date: cell.dataset.date } });
      });

      host.append(head, grid);
    })
    .catch((error) => loading.replaceWith(errorBox(error)));
}

function chipEl(chip) {
  const node = mk('div', `chip cat-${chip.category ?? 'other'}`);
  if (chip.kind === 'event') node.classList.add('is-event');
  if (chip.status === 'done') node.classList.add('done');
  if (chip.status === 'cancelled') node.classList.add('cancelled');
  if (!chip.allDay && chip.startTime) node.appendChild(mk('span', 'c-time', chip.startTime));
  node.appendChild(mk('span', 'c-title', chip.title));
  node.title = `${PCUtil.timeRange(chip)} ${chip.title}`;
  return node;
}

/* ------------------------------------------------------------------ 周视图 */

const HOUR_HEIGHT = 48;

function renderWeek(host, anchor) {
  const start = PCUtil.startOfWeek(anchor);
  const end = PCUtil.addDays(start, 6);
  const loading = mk('div', 'loading', '加载中…');
  host.appendChild(loading);

  fetchCalendar(start, end)
    .then((byDate) => {
      loading.remove();
      const days = PCUtil.eachDay(start, end);
      const today = PCUtil.todayKey();

      const head = mk('div', 'week-head');
      head.appendChild(mk('div', 'gutter'));
      for (const date of days) {
        const node = mk('div', 'week-day-head');
        if (date === today) node.classList.add('today');
        node.append(
          mk('span', 'wd-name', PCUtil.weekdayCN(date)),
          mk('span', 'wd-date', `${PCUtil.toDate(date).getMonth() + 1}/${PCUtil.toDate(date).getDate()}`),
        );
        node.addEventListener('click', () => {
          PC.state.calendar.anchor = date;
          PC.state.calendar.mode = 'day';
          PC.refresh();
        });
        head.appendChild(node);
      }

      const allDayRow = mk('div', 'week-allday');
      allDayRow.appendChild(mk('div', 'gutter', '全天'));
      for (const date of days) {
        const day = byDate.get(date) ?? { events: [], schedules: [] };
        const col = mk('div', 'allday-col');
        const allDayItems = [
          ...day.events.map((item) => ({ kind: 'event', ...item })),
          ...day.schedules.filter((item) => item.allDay).map((item) => ({ kind: 'schedule', ...item })),
        ];
        for (const item of allDayItems.slice(0, 4)) {
          const chip = mk('div', `ad-chip cat-${item.category ?? 'other'}`, item.title);
          chip.title = item.title;
          if (item.kind === 'schedule') {
            chip.addEventListener('click', () => openEditor({ target: 'schedule', id: item.scheduleId }));
          }
          col.appendChild(chip);
        }
        if (allDayItems.length > 4) col.appendChild(mk('div', 'more', `+${allDayItems.length - 4}`));
        allDayRow.appendChild(col);
      }

      const scroll = mk('div', 'week-scroll');
      const canvas = mk('div', 'week-canvas');
      const gutter = mk('div', 'hour-gutter');
      for (let hour = 0; hour < 24; hour += 1) {
        const label = mk('div', 'hour-label', `${PCUtil.pad2(hour)}:00`);
        label.style.top = `${hour * HOUR_HEIGHT}px`;
        gutter.appendChild(label);
      }
      canvas.appendChild(gutter);

      for (const date of days) {
        const col = mk('div', 'day-col');
        col.dataset.date = date;
        const day = byDate.get(date) ?? { schedules: [] };
        const timed = day.schedules.filter((item) => !item.allDay && item.startTime);
        for (const block of layoutBlocks(timed)) col.appendChild(blockEl(block));
        col.addEventListener('click', (event) => {
          if (event.target.closest('.block')) return;
          const rect = col.getBoundingClientRect();
          const raw = Math.round((((event.clientY - rect.top) / HOUR_HEIGHT) * 60) / 30) * 30;
          const begin = Math.max(0, Math.min(23 * 60 + 30, raw));
          openEditor({
            target: 'schedule',
            defaults: { date, startTime: PCUtil.clock(begin) },
          });
        });
        canvas.appendChild(col);
      }
      scroll.appendChild(canvas);
      host.append(head, allDayRow, scroll);
      scroll.scrollTop = 7 * HOUR_HEIGHT;
    })
    .catch((error) => loading.replaceWith(errorBox(error)));
}

/** 同一时段的重叠分列：贪心分配列号，再按组内列数算宽度。 */
function layoutBlocks(items) {
  const list = items.map((item) => {
    const begin = PCUtil.minutes(item.startTime);
    return {
      ...item,
      start: begin,
      end: item.endTime ? Math.max(begin + 15, PCUtil.minutes(item.endTime)) : begin + 60,
    };
  });
  list.sort((a, b) => a.start - b.start || a.end - b.end);

  const out = [];
  let group = [];
  let groupEnd = -1;
  const flush = () => {
    if (!group.length) return;
    const colEnds = [];
    for (const item of group) {
      let index = colEnds.findIndex((endMinute) => endMinute <= item.start);
      if (index === -1) {
        colEnds.push(item.end);
        index = colEnds.length - 1;
      } else {
        colEnds[index] = item.end;
      }
      item.col = index;
    }
    for (const item of group) item.cols = colEnds.length;
    out.push(...group);
    group = [];
    groupEnd = -1;
  };
  for (const item of list) {
    if (group.length && item.start >= groupEnd) flush();
    group.push(item);
    groupEnd = Math.max(groupEnd, item.end);
  }
  flush();
  return out;
}

function blockEl(block) {
  const node = mk('div', `block cat-${block.category ?? 'other'}`);
  if (block.status === 'done') node.classList.add('done');
  if (block.status === 'cancelled') node.classList.add('cancelled');
  node.style.top = `${(block.start / 60) * HOUR_HEIGHT}px`;
  node.style.height = `${Math.max(20, ((block.end - block.start) / 60) * HOUR_HEIGHT - 2)}px`;
  if (block.cols > 1) {
    node.style.left = `calc(${(block.col / block.cols) * 100}% + 2px)`;
    node.style.width = `calc(${100 / block.cols}% - 4px)`;
  }
  node.append(mk('span', 'b-title', block.title), mk('span', 'b-time', `${block.startTime}–${block.endTime ?? ''}`));
  node.title = `${block.startTime}–${block.endTime ?? ''} ${block.title}`;
  node.addEventListener('click', (event) => {
    event.stopPropagation();
    openEditor({ target: 'schedule', id: block.scheduleId });
  });
  return node;
}

/* ------------------------------------------------------------------ 日视图 */

function renderDay(host, anchor) {
  const loading = mk('div', 'loading', '加载中…');
  host.appendChild(loading);

  fetchCalendar(anchor, anchor)
    .then((byDate) => {
      loading.remove();
      const day = byDate.get(anchor) ?? { events: [], schedules: [], stats: {} };
      const wrap = mk('div', 'day-view');

      const strip = mk('div', 'day-strip');
      strip.append(
        mk('div', 'day-title', PCUtil.fmtCN(anchor)),
        statPill(day.schedules.length, '日程'),
        statPill(day.stats?.done ?? 0, '已完成'),
        statPill(day.events.length, '事件'),
      );
      const addBtn = mk('button', 'primary-btn', '+ 新建');
      addBtn.type = 'button';
      addBtn.addEventListener('click', () => openEditor({ target: 'schedule', defaults: { date: anchor } }));
      strip.appendChild(addBtn);
      wrap.appendChild(strip);

      const allDayItems = [
        ...day.events.map((item) => ({ kind: 'event', ...item })),
        ...day.schedules.filter((item) => item.allDay).map((item) => ({ kind: 'schedule', ...item })),
      ];
      if (allDayItems.length) {
        wrap.appendChild(mk('div', 'section-title', '全天'));
        const list = mk('div', 'rows');
        for (const item of allDayItems) {
          list.appendChild(
            item.kind === 'event'
              ? eventRow(item)
              : scheduleRow({ ...item, allDay: true }),
          );
        }
        wrap.appendChild(list);
      }

      wrap.appendChild(mk('div', 'section-title', '时间安排'));
      const timed = day.schedules.filter((item) => !item.allDay).sort((a, b) =>
        String(a.startTime ?? '').localeCompare(String(b.startTime ?? '')),
      );
      const rows = mk('div', 'rows');
      if (!timed.length) rows.appendChild(emptyBox('这一天还没有时段安排，点右上角「新建」试试。'));
      for (const item of timed) rows.appendChild(scheduleRow(item));
      wrap.appendChild(rows);

      host.appendChild(wrap);
    })
    .catch((error) => loading.replaceWith(errorBox(error)));
}

function scheduleRow(item) {
  const row = mk('div', `row-item cat-${item.category ?? 'other'}`);
  if (item.status === 'done') row.classList.add('done');
  if (item.status === 'cancelled') row.classList.add('cancelled');

  const time = mk('div', 'ri-time');
  time.append(mk('b', null, item.allDay ? '全天' : item.startTime ?? ''), mk('span', null, item.endTime ?? ''));

  const main = mk('div', 'ri-main');
  main.appendChild(mk('div', 'ri-title', item.title));
  const meta = [
    CATEGORY_LABEL[item.category] ?? item.category,
    item.location,
    item.isRepeatInstance ? '重复' : null,
    item.estimatedMinutes ? `预计 ${item.estimatedMinutes} 分钟` : null,
    item.status !== 'pending' ? STATUS_LABEL[item.status] : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (meta) main.appendChild(mk('div', 'ri-meta', meta));

  const actions = mk('div', 'ri-actions');
  if (item.status !== 'done') {
    actions.appendChild(iconBtn('标记完成', '✓', () => setScheduleStatus(item.scheduleId, 'done', '已完成')));
  } else {
    actions.appendChild(iconBtn('恢复待办', '↺', () => setScheduleStatus(item.scheduleId, 'pending', '已恢复')));
  }
  if (item.status === 'pending') {
    actions.appendChild(iconBtn('取消', '⊘', () => setScheduleStatus(item.scheduleId, 'cancelled', '已取消')));
  }
  actions.appendChild(iconBtn('编辑', '✎', () => openEditor({ target: 'schedule', id: item.scheduleId })));
  actions.appendChild(
    iconBtn('删除', 'trash', () => removeRecord('schedule', item.scheduleId, item.title), 'danger'),
  );

  row.append(time, main, actions);
  return row;
}

function eventRow(item) {
  const row = mk('div', `row-item cat-${item.category ?? 'other'} is-event`);
  const time = mk('div', 'ri-time');
  time.append(mk('b', null, '事件'), mk('span', null, ''));
  const main = mk('div', 'ri-main');
  main.appendChild(mk('div', 'ri-title', item.title));
  main.appendChild(mk('div', 'ri-meta', CATEGORY_LABEL[item.category] ?? item.category));
  const actions = mk('div', 'ri-actions');
  actions.appendChild(iconBtn('编辑', '✎', () => openEditor({ target: 'event', id: item.eventId })));
  actions.appendChild(iconBtn('删除', 'trash', () => removeRecord('event', item.eventId, item.title), 'danger'));
  row.append(time, main, actions);
  return row;
}

/* ================================================================== 待办视图 */

const todoView = {
  title: '待办',

  render(ctx) {
    ctx.mount.innerHTML = '';
    ctx.mount.appendChild(todoToolbar());
    const list = mk('div', 'todo-list');
    ctx.mount.appendChild(list);
    renderTodoList(list);
  },
};

function todoToolbar() {
  const state = PC.state;
  const bar = mk('div', 'toolbar wrap');

  const seg = mk('div', 'seg');
  for (const [key, label] of [
    ['all', '全部'],
    ['today', '今天'],
    ['week', '本周'],
    ['overdue', '逾期'],
    ['done', '已完成'],
  ]) {
    const button = mk('button', `seg-btn${state.todo.filter === key ? ' active' : ''}`, label);
    button.type = 'button';
    button.addEventListener('click', () => {
      state.todo.filter = key;
      PC.refresh();
    });
    seg.appendChild(button);
  }

  const quick = mk('div', 'quick-add');
  const title = mk('input', 'qa-title');
  title.type = 'text';
  title.placeholder = '添加待办，回车即可…';
  const date = mk('input', 'qa-date');
  date.type = 'date';
  date.value = PCUtil.todayKey();
  const time = mk('input', 'qa-time');
  time.type = 'time';
  const add = mk('button', 'primary-btn', '添加');
  add.type = 'button';

  const submit = async () => {
    const text = title.value.trim();
    if (!text) {
      title.focus();
      return;
    }
    const body = { title: text, date: date.value || PCUtil.todayKey(), allDay: !time.value, category: 'study' };
    if (time.value) body.startTime = time.value;
    try {
      await PC.api('/schedules', { method: 'POST', body });
      title.value = '';
      time.value = '';
      PC.toast('已添加待办');
      PC.refresh();
    } catch (error) {
      PC.toast(error.message);
    }
  };
  add.addEventListener('click', submit);
  title.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });
  quick.append(title, date, time, add);

  const rollover = mk('button', 'ghost-btn', '顺延未完成到本周');
  rollover.type = 'button';
  rollover.addEventListener('click', async () => {
    try {
      const result = await PC.api('/schedules/rollover', { method: 'POST', body: {} });
      PC.toast(result.moved ? `已顺延 ${result.moved} 条` : '没有需要顺延的待办');
      PC.refresh();
    } catch (error) {
      PC.toast(error.message);
    }
  });

  const row2 = mk('div', 'toolbar-row');
  row2.append(quick, rollover);
  bar.append(seg, row2);
  return bar;
}

async function renderTodoList(host) {
  const state = PC.state;
  const today = PCUtil.todayKey();
  const weekStart = PCUtil.startOfWeek(today);
  const weekEnd = PCUtil.addDays(weekStart, 6);

  let query = '/schedules?status=pending&limit=300';
  if (state.todo.filter === 'today') query = `/schedules?date=${today}`;
  else if (state.todo.filter === 'week') query = `/schedules?from=${weekStart}&to=${weekEnd}`;
  else if (state.todo.filter === 'done') query = '/schedules?status=done&limit=100';

  host.innerHTML = '';
  host.appendChild(mk('div', 'loading', '加载中…'));

  let payload;
  try {
    payload = await PC.api(query);
  } catch (error) {
    host.innerHTML = '';
    host.appendChild(errorBox(error));
    return;
  }

  let items = (payload.items ?? []).filter((item) => item.status !== 'rolled');
  if (state.todo.filter === 'overdue') items = items.filter((item) => item.date < today);
  if (state.todo.filter === 'done') items = items.filter((item) => item.status === 'done');

  host.innerHTML = '';
  if (!items.length) {
    host.appendChild(emptyBox(todoEmptyText(state.todo.filter)));
    return;
  }

  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.date)) groups.set(item.date, []);
    groups.get(item.date).push(item);
  }
  const dates = [...groups.keys()].sort((a, b) => (state.todo.filter === 'done' ? b.localeCompare(a) : a.localeCompare(b)));

  for (const date of dates) {
    const header = mk('div', 'group-head');
    header.append(
      mk('span', 'gh-date', PCUtil.fmtCN(date)),
      mk('span', `gh-rel${date < today ? ' overdue' : ''}`, PCUtil.relativeDay(date, today)),
      mk('span', 'gh-count', `${groups.get(date).length} 条`),
    );
    host.appendChild(header);

    const rows = mk('div', 'rows');
    const list = groups.get(date).sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return String(a.startTime ?? '').localeCompare(String(b.startTime ?? ''));
    });
    for (const item of list) rows.appendChild(todoRow(item));
    host.appendChild(rows);
  }

  // 底部进度：当前周完成率（进度条数据来自 /schedules/stats）
  try {
    const stats = await PC.api(`/schedules/stats?from=${weekStart}&to=${weekEnd}`);
    const footer = mk('div', 'todo-stats');
    const rate = Math.max(0, Math.min(100, stats.completionRate ?? 0));
    footer.append(
      mk('span', 'ts-text', `本周 ${stats.done}/${stats.total} 项完成 · 计划 ${stats.plannedHours ?? 0} 小时`),
    );
    const bar = mk('div', 'progress');
    const fill = mk('div', 'progress-fill');
    fill.style.width = `${rate}%`;
    bar.appendChild(fill);
    footer.appendChild(bar);
    host.appendChild(footer);
  } catch {
    /* 统计失败不影响列表 */
  }
}

function todoEmptyText(filter) {
  if (filter === 'done') return '还没有已完成的待办。';
  if (filter === 'overdue') return '没有逾期未完成的事项，保持住。';
  if (filter === 'today') return '今天没有待办，可以安排点新任务。';
  if (filter === 'week') return '本周还没有待办。';
  return '还没有待办，用上面的输入框添加一条。';
}

function todoRow(item) {
  const today = PCUtil.todayKey();
  const row = mk('div', `todo-row priority-${item.priority ?? 1}`);
  if (item.status === 'done') row.classList.add('done');
  if (item.status === 'cancelled') row.classList.add('cancelled');

  const check = mk('button', 'check', item.status === 'done' ? '✓' : '');
  check.type = 'button';
  check.title = item.status === 'done' ? '恢复待办' : '标记完成';
  check.addEventListener('click', () =>
    setScheduleStatus(item.id, item.status === 'done' ? 'pending' : 'done', item.status === 'done' ? '已恢复' : '已完成'),
  );

  const main = mk('div', 'tr-main');
  const titleLine = mk('div', 'tr-title');
  titleLine.appendChild(mk('span', null, item.title));
  if (item.priority === 2) titleLine.appendChild(mk('span', 'tag urgent', '紧急'));
  else if (item.priority === 1 && item.date < today && item.status === 'pending') {
    titleLine.appendChild(mk('span', 'tag late', '逾期'));
  }
  main.appendChild(titleLine);

  const meta = [
    item.allDay ? '全天' : item.startTime,
    item.endTime && !item.allDay ? `– ${item.endTime}` : null,
    CATEGORY_LABEL[item.category] ?? item.category,
    item.location,
    item.complexity ? `复杂度 ${item.complexity}` : null,
    item.estimatedMinutes ? `${item.estimatedMinutes} 分钟` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  main.appendChild(mk('div', 'tr-meta', meta));

  const actions = mk('div', 'ri-actions');
  actions.appendChild(iconBtn('编辑', '✎', () => openEditor({ target: 'schedule', id: item.id })));
  actions.appendChild(iconBtn('删除', 'trash', () => removeRecord('schedule', item.id, item.title), 'danger'));

  row.append(check, main, actions);
  return row;
}

/* =============================================================== 消息 / 设置 / 占位 */

const messageView = {
  title: '消息',

  render(ctx) {
    ctx.mount.innerHTML = '';
    const bar = mk('div', 'toolbar');
    bar.append(
      mk('div', 'toolbar-title', '指令记录'),
      mk('div', 'spacer'),
      (() => {
        const button = mk('button', 'ghost-btn', '刷新');
        button.type = 'button';
        button.addEventListener('click', () => PC.refresh());
        return button;
      })(),
    );
    ctx.mount.appendChild(bar);

    const list = mk('div', 'log-list');
    ctx.mount.appendChild(list);
    PC.api('/commands/logs?limit=50')
      .then(({ items }) => {
        if (!items?.length) {
          list.appendChild(emptyBox('还没有指令记录。在中间的对话里发一条试试。'));
          return;
        }
        for (const item of [...items].reverse()) {
          const row = mk('div', `log-row${item.ok === false ? ' failed' : ''}`);
          const head = mk('div', 'lr-head');
          head.append(
            mk('span', 'lr-action', `${ACTION_LABEL[item.action] ?? item.action}${TARGET_LABEL[item.target] ?? ''}`),
            mk('span', 'lr-source', item.source ?? 'rules'),
            mk('span', 'lr-time', item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : ''),
          );
          row.append(head, mk('div', 'lr-text', item.text || '（空）'));
          row.appendChild(
            mk(
              'div',
              'lr-meta',
              `影响 ${item.affectedCount ?? 0} 条${item.confidence !== null && item.confidence !== undefined ? ` · 置信度 ${item.confidence}` : ''}`,
            ),
          );
          list.appendChild(row);
        }
      })
      .catch((error) => list.appendChild(errorBox(error)));
  },
};

const settingsView = {
  title: '设置',

  render(ctx) {
    ctx.mount.innerHTML = '';
    const wrap = mk('div', 'settings');

    const card = (title, rows) => {
      const box = mk('div', 'card');
      box.appendChild(mk('div', 'card-title', title));
      const body = mk('div', 'card-body');
      for (const [label, value] of rows) {
        const line = mk('div', 'kv');
        line.append(mk('span', 'kv-key', label), mk('span', 'kv-val', value ?? '—'));
        body.appendChild(line);
      }
      box.appendChild(body);
      return box;
    };

    const info = PC.state.info ?? {};
    wrap.appendChild(
      card('运行信息', [
        ['接口地址', PC.state.apiBase],
        ['推送通道', PC.state.wsUrl],
        ['数据目录', info.dataDir],
        ['应用版本', info.appVersion],
        ['平台', info.platform],
      ]),
    );

    const ai = PC.state.ai ?? {};
    wrap.appendChild(
      card('AI 接入（本阶段仅保留接口）', [
        ['状态', ai.available ? `已注册 provider：${ai.provider}` : '未接入（请求返回 501）'],
        ['契约版本', ai.contractVersion],
        ['自然语言入口', 'POST /api/v1/ai/nl2command'],
        ['能力探测', 'GET /api/v1/ai/capabilities'],
        ['当前对话', '本地规则解析（fallback: rules）'],
      ]),
    );

    const themeCard = mk('div', 'card');
    themeCard.appendChild(mk('div', 'card-title', '主题色板'));
    const swatches = mk('div', 'swatches');
    for (const name of ['blue', 'green', 'orange', 'red', 'purple']) {
      const dot = mk('span', `swatch sw-${name}`, name);
      swatches.appendChild(dot);
    }
    themeCard.appendChild(swatches);
    const exportBtn = mk('button', 'ghost-btn', '导出 ICS 日历文件');
    exportBtn.type = 'button';
    exportBtn.addEventListener('click', exportIcs);
    themeCard.appendChild(exportBtn);
    wrap.appendChild(themeCard);

    ctx.mount.appendChild(wrap);
  },
};

async function exportIcs() {
  try {
    const response = await fetch(`${PC.state.apiBase}/ics`);
    const text = await response.text();
    const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'potato-calendar.ics';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    PC.toast('已导出 ICS');
  } catch (error) {
    PC.toast(`导出失败：${error.message}`);
  }
}

function placeholderView(title, desc, bullets) {
  return {
    title,
    render(ctx) {
      ctx.mount.innerHTML = '';
      const box = mk('div', 'placeholder');
      // 打磨点：占位图标同样换成内联 SVG（装饰性，aria-hidden 由 PCUtil.icon 补上）
      const phIcon = mk('div', 'ph-icon');
      phIcon.innerHTML = PCUtil.icon('camera', 28);
      box.append(phIcon, mk('h3', null, `${title} · 预留`), mk('p', 'ph-desc', desc));
      const list = mk('ul', 'ph-list');
      for (const text of bullets) list.appendChild(mk('li', null, text));
      box.appendChild(list);
      ctx.mount.appendChild(box);
    },
  };
}

/* ================================================================ 新建 / 编辑弹层 */

function openEditor(options = {}) {
  const state = { target: options.target ?? 'schedule', id: options.id ?? null, defaults: options.defaults ?? {} };
  if (state.id) {
    const path = state.target === 'schedule' ? `/schedules/${state.id}` : `/events/${state.id}`;
    PC.api(path)
      .then(({ item }) => mountEditor(state, item))
      .catch((error) => PC.toast(error.message));
    return;
  }
  mountEditor(state, null);
}

function mountEditor(state, item) {
  const mask = mk('div', 'modal-mask');
  const modal = mk('div', 'modal');
  const isEdit = Boolean(item);

  const head = mk('div', 'modal-head');
  const tabs = mk('div', 'tabs');
  for (const [key, label] of [
    ['schedule', '日程'],
    ['event', '日历事件'],
  ]) {
    const button = mk('button', `tab${state.target === key ? ' active' : ''}`, label);
    button.type = 'button';
    button.disabled = isEdit;
    button.addEventListener('click', () => {
      if (isEdit) return;
      state.target = key;
      close();
      mountEditor(state, null);
    });
    tabs.appendChild(button);
  }
  head.appendChild(tabs);
  const closeBtn = iconBtn('关闭', '✕', close);
  head.appendChild(closeBtn);

  const body = mk('div', 'modal-body');
  body.appendChild(state.target === 'schedule' ? scheduleForm(item, state.defaults) : eventForm(item, state.defaults));
  const error = mk('div', 'modal-error');

  const foot = mk('div', 'modal-foot');
  if (isEdit) {
    const del = mk('button', 'danger-btn ghost', '删除');
    del.type = 'button';
    del.addEventListener('click', async () => {
      close();
      await removeRecord(state.target, state.id, item.title);
    });
    foot.appendChild(del);
  }
  foot.appendChild(mk('div', 'spacer'));
  const cancel = mk('button', 'ghost-btn', '取消');
  cancel.type = 'button';
  cancel.addEventListener('click', close);
  const save = mk('button', 'primary-btn', isEdit ? '保存修改' : '创建');
  save.type = 'button';
  foot.appendChild(cancel);
  foot.appendChild(save);

  modal.append(head, body, error, foot);
  mask.appendChild(modal);
  document.body.appendChild(mask);
  const firstInput = body.querySelector('input, select, textarea');
  if (firstInput) firstInput.focus();

  mask.addEventListener('click', (event) => {
    if (event.target === mask) close();
  });
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);

  function close() {
    document.removeEventListener('keydown', onKey);
    mask.remove();
  }

  save.addEventListener('click', async () => {
    const collect = state.target === 'schedule' ? collectSchedule : collectEvent;
    const payload = collect(body);
    if (!payload.title || !payload.title.trim()) {
      error.textContent = '请填写标题';
      return;
    }
    error.textContent = '';
    try {
      let conflicts = 0;
      if (state.target === 'schedule') {
        if (state.id) {
          await PC.api(`/schedules/${state.id}`, { method: 'PATCH', body: payload });
        } else {
          const result = await PC.api('/schedules', { method: 'POST', body: payload });
          conflicts = result.conflicts?.length ?? 0;
        }
      } else if (state.id) {
        await PC.api(`/events/${state.id}`, { method: 'PATCH', body: payload });
      } else {
        await PC.api('/events', { method: 'POST', body: payload });
      }
      close();
      PC.toast(state.id ? '已保存' : '已创建');
      if (conflicts) PC.toast(`提示：与 ${conflicts} 条日程时间重叠`);
      PC.refresh();
    } catch (err) {
      const detail = err.payload?.error?.details?.field;
      error.textContent = `${err.message}${detail ? `（字段：${detail}）` : ''}`;
    }
  });
}

function scheduleForm(item, defaults) {
  const data = item ?? {
    date: defaults.date ?? PCUtil.todayKey(),
    startTime: defaults.startTime,
    allDay: !defaults.startTime,
    category: 'study',
    priority: 1,
    repeat: { type: 'none', interval: 1, weekdays: [], until: { mode: 'never' } },
  };
  const wrap = mk('div', 'form-grid');

  const title = mk('input', 'in-title');
  title.type = 'text';
  title.value = data.title ?? '';
  title.placeholder = '例如：高数作业 / 项目周会';
  wrap.appendChild(field('标题', title));

  const date = mk('input', 'f-date');
  date.type = 'date';
  date.value = data.date ?? PCUtil.todayKey();
  wrap.appendChild(field('日期', date));

  const allDay = mk('input', 'f-allday');
  allDay.type = 'checkbox';
  allDay.checked = Boolean(data.allDay);
  const allDayWrap = mk('label', 'check-field');
  allDayWrap.append(allDay, mk('span', null, '全天（退化为待办锚点，不占用具体时段）'));
  wrap.appendChild(allDayWrap);

  const start = mk('input', 'f-start');
  start.type = 'time';
  start.value = data.startTime ?? '';
  const end = mk('input', 'f-end');
  end.type = 'time';
  end.value = data.endTime ?? '';
  const timeRow = mk('div', 'inline-2');
  timeRow.append(field('开始', start), field('结束', end));
  wrap.appendChild(timeRow);

  const category = mk('select', 'f-category');
  for (const key of SCHEDULE_CATEGORIES) category.appendChild(option(key, CATEGORY_LABEL[key], (data.category ?? 'other') === key));
  const priority = mk('select', 'f-priority');
  for (const key of [0, 1, 2]) priority.appendChild(option(key, PRIORITY_LABEL[key], Number(data.priority ?? 1) === key));
  const inline1 = mk('div', 'inline-2');
  inline1.append(field('分类', category), field('优先级', priority));
  wrap.appendChild(inline1);

  const estimated = mk('input', 'f-estimated');
  estimated.type = 'number';
  estimated.min = '0';
  estimated.value = data.estimatedMinutes ?? '';
  const location = mk('input', 'f-location');
  location.type = 'text';
  location.value = data.location ?? '';
  const inline2 = mk('div', 'inline-2');
  inline2.append(field('预计时长（分钟）', estimated), field('地点', location));
  wrap.appendChild(inline2);

  wrap.appendChild(repeatBlock(data.repeat));

  const reminder = mk('select', 'f-reminder');
  const currentOffset = data.reminders?.[0]?.offsetMinutes ?? null;
  for (const [value, label] of REMINDER_PRESETS) reminder.appendChild(option(value ?? '', label, currentOffset === value));
  wrap.appendChild(field('提醒', reminder));

  const description = mk('textarea', 'f-desc');
  description.rows = 2;
  description.value = data.description ?? '';
  description.placeholder = '备注（可选）';
  wrap.appendChild(field('备注', description));

  const sync = () => {
    const disabled = allDay.checked;
    start.disabled = disabled;
    end.disabled = disabled;
    timeRow.classList.toggle('muted', disabled);
  };
  allDay.addEventListener('change', sync);
  sync();

  return wrap;
}

function eventForm(item, defaults) {
  const data = item ?? {
    startDate: defaults.date ?? PCUtil.todayKey(),
    endDate: defaults.date ?? PCUtil.todayKey(),
    category: 'other',
    allDay: true,
    repeat: { type: 'none', interval: 1, weekdays: [], until: { mode: 'never' } },
  };
  const wrap = mk('div', 'form-grid');

  const title = mk('input', 'in-title');
  title.type = 'text';
  title.value = data.title ?? '';
  title.placeholder = '例如：期中考试周 / 国庆假期';
  wrap.appendChild(field('标题', title));

  const startDate = mk('input', 'f-start-date');
  startDate.type = 'date';
  startDate.value = data.startDate ?? PCUtil.todayKey();
  const endDate = mk('input', 'f-end-date');
  endDate.type = 'date';
  endDate.value = data.endDate ?? data.startDate ?? PCUtil.todayKey();
  const inline = mk('div', 'inline-2');
  inline.append(field('开始日期', startDate), field('结束日期', endDate));
  wrap.appendChild(inline);

  const category = mk('select', 'f-category');
  for (const key of EVENT_CATEGORIES) category.appendChild(option(key, CATEGORY_LABEL[key], (data.category ?? 'other') === key));
  wrap.appendChild(field('分类', category));

  wrap.appendChild(repeatBlock(data.repeat));

  const description = mk('textarea', 'f-desc');
  description.rows = 2;
  description.value = data.description ?? '';
  description.placeholder = '备注（可选）';
  wrap.appendChild(field('备注', description));

  return wrap;
}

/** 重复规则编辑块：类型 / 间隔 / 星期 / 结束条件。 */
function repeatBlock(repeat) {
  const data = repeat ?? { type: 'none', interval: 1, weekdays: [], until: { mode: 'never' } };
  const box = mk('div', 'repeat-block');

  const type = mk('select', null);
  for (const [key, label] of REPEAT_TYPES) type.appendChild(option(key, label, (data.type ?? 'none') === key));
  const interval = mk('input', null);
  interval.type = 'number';
  interval.min = '1';
  interval.value = data.interval ?? 1;
  const inline = mk('div', 'inline-2');
  inline.append(field('重复', type), field('间隔（每 N 次）', interval));
  box.appendChild(inline);

  const weekdays = mk('div', 'weekday-picker');
  const boxes = [];
  PCUtil.WEEK_CN.forEach((name, index) => {
    const value = index + 1;
    const label = mk('label', 'wd-chip');
    const input = mk('input', null);
    input.type = 'checkbox';
    input.value = value;
    input.checked = (data.weekdays ?? []).includes(value);
    label.append(input, mk('span', null, name));
    weekdays.appendChild(label);
    boxes.push(input);
  });
  const weekdayField = mk('div', 'field');
  weekdayField.append(mk('span', 'field-label', '重复星期（仅「每周」需要）'), weekdays);
  box.appendChild(weekdayField);

  const untilMode = mk('select', null);
  for (const [key, label] of [
    ['never', '永不结束'],
    ['date', '到某天为止'],
    ['count', '重复 N 次'],
  ]) {
    untilMode.appendChild(option(key, label, (data.until?.mode ?? 'never') === key));
  }
  const untilValue = mk('input', null);
  untilValue.type = data.until?.mode === 'count' ? 'number' : 'date';
  untilValue.value = data.until?.mode === 'count' ? data.until?.count ?? 5 : data.until?.date ?? '';
  const untilWrap = mk('div', 'inline-2');
  untilWrap.append(field('结束方式', untilMode), field('结束值', untilValue));
  box.appendChild(untilWrap);

  const sync = () => {
    const isWeekly = type.value === 'weekly';
    weekdayField.classList.toggle('hidden', !isWeekly);
    interval.disabled = type.value === 'none';
    const mode = untilMode.value;
    untilWrap.classList.toggle('muted', mode === 'never');
    untilValue.disabled = mode === 'never';
    untilValue.type = mode === 'count' ? 'number' : 'date';
    if (mode === 'count' && untilValue.type === 'number' && !untilValue.value) untilValue.value = '5';
  };
  type.addEventListener('change', sync);
  untilMode.addEventListener('change', sync);
  sync();

  box._read = () => {
    const mode = untilMode.value;
    const until = { mode };
    if (mode === 'date' && untilValue.value) until.date = untilValue.value;
    if (mode === 'count') until.count = Number(untilValue.value) || 1;
    return {
      type: type.value,
      interval: Number(interval.value) || 1,
      weekdays: type.value === 'weekly' ? boxes.filter((input) => input.checked).map((input) => Number(input.value)) : [],
      until,
    };
  };
  return box;
}

function collectSchedule(body) {
  const allDay = body.querySelector('.f-allday').checked;
  const payload = {
    title: body.querySelector('.in-title').value.trim(),
    date: body.querySelector('.f-date').value,
    allDay,
    category: body.querySelector('.f-category').value,
    priority: Number(body.querySelector('.f-priority').value),
    estimatedMinutes: body.querySelector('.f-estimated').value
      ? Number(body.querySelector('.f-estimated').value)
      : undefined,
    location: body.querySelector('.f-location').value,
    description: body.querySelector('.f-desc').value,
    repeat: body.querySelector('.repeat-block')._read(),
  };
  if (!allDay) {
    payload.startTime = body.querySelector('.f-start').value || undefined;
    payload.endTime = body.querySelector('.f-end').value || undefined;
  }
  const reminder = body.querySelector('.f-reminder').value;
  payload.reminders = reminder === '' ? [] : [{ offsetMinutes: Number(reminder) }];
  return payload;
}

function collectEvent(body) {
  return {
    title: body.querySelector('.in-title').value.trim(),
    startDate: body.querySelector('.f-start-date').value,
    endDate: body.querySelector('.f-end-date').value || undefined,
    category: body.querySelector('.f-category').value,
    allDay: true,
    description: body.querySelector('.f-desc').value,
    repeat: body.querySelector('.repeat-block')._read(),
  };
}

/* ================================================================ 思源学堂 */

/**
 * 视图内的会话态。
 *
 * 刻意不写进 PC.state：学堂的登录态、课程、活动全部由后端持有，
 * 前端只需要记住「最近一次拿到的 status / 课程 / 活动 / 同步预览」这些渲染素材。
 * 所有交互都只改这一份数据，再 lmsPaint() 整体重画，避免 DOM 与数据不一致。
 *
 * 注意：这里不保存密码。登录表单的失败分支全部原地更新（见 lmsLoginCard），
 * 只有登录态真正前进（已登录 / 需要两步验证）时才重画。
 */
const lmsUi = {
  mount: null,
  status: null,
  statusLoading: false,
  statusError: null,
  /**
   * 学期筛选（GET /lms/semesters）。
   *
   * semesterId 用字符串保存：学校侧学期 ID 转成字符串；id 为 null 的课程组用哨兵值 `'none'`。
   * null 表示「还没选」——此时列表请求不带 semesterId，行为与加学期筛选之前一致。
   * 存在视图态里，因此切走再切回来（重新 render）不会丢选择。
   */
  semesters: null,
  semestersBusy: false,
  semestersError: null,
  semesterId: null,
  courses: null,
  coursesBusy: false,
  coursesError: null,
  /** 不带学期筛选的课程已经拉过一次（学期列表为空时的兜底，避免反复请求）。 */
  coursesLoaded: false,
  activities: null,
  activitiesBusy: false,
  activitiesError: null,
  activityType: '',
  activityCourseId: '',
  /** 二级页：null = 课程列表页；否则为当前查看的课程 id。 */
  detailCourseId: null,
  /** 课程详情页的分组（作业 / 直播 / 回放 / 资料 / 全部）。 */
  detailType: '',
  /** 展开的活动 id（手风琴：同一时间只展开一条）。 */
  expandedActivityId: null,
  /** 活动详情缓存：key = 活动 id，避免同一课程内反复请求（GET /lms/activities/:id）。 */
  activityDetails: new Map(),
  activityDetailBusy: new Set(),
  activityDetailError: new Map(),
  /** 工具条状态 pill 的展开态（改为一行详情后不再占整张卡）。 */
  statusOpen: false,
  /** 「同步…」抽屉是否展开（默认收起）。 */
  syncOpen: false,
  /** 只记住学号（方便切走再切回来），明文密码不留在内存里。 */
  username: '',
  loginError: null,
  mfaSent: false,
  mfaPhoneMasked: null,
  mfaError: null,
  /** 同步选项：默认值保持后端默认语义（见 lmsSyncBody 的注释）。 */
  options: {
    includePast: false,
    includeSubmitted: false,
    includeLesson: false,
    includeCourseRange: false,
    pruneStale: false,
  },
  preview: null,
  previewBusy: false,
  previewError: null,
  /** 当前预览的课程范围（null = 整个学期）；详情页「同步本课程」会设成该课程 id。 */
  previewCourseId: null,
  selected: new Set(),
  applyBusy: false,
  applyResult: null,
  applyError: null,
  /** 自动同步设置（POST /lms/settings）的忙碌态与错误。 */
  autoSyncBusy: false,
  autoSyncError: null,
  /** 当前这一次渲染出来的节点，用于不重画的原地更新（勾选 / 计数 / 设置项）。 */
  refs: { syncCount: null, syncButton: null, syncBoxes: [], autoSync: null },
};

const LMS_STATUS_LABEL = {
  anonymous: '未登录',
  need_mfa: '需要两步验证',
  need_captcha: '需要图形验证码',
  ready: '已登录',
  error: '登录异常',
};

const LMS_ACTIVITY_LABEL = {
  homework: '作业',
  lecture_live: '直播',
  lesson: '课程回放',
  material: '资料',
  course: '课程',
};

const LMS_ACTION_LABEL = { create: '新建', update: '更新', skip: '跳过', stale: '失效' };

/**
 * 一级页面「作业」的**类型白名单**（只在前端过滤，不发请求）。
 *
 * 只认后端已经给出中文标签、且确定带提交要求的类型（见 src/server/lms/config.js 的
 * ACTIVITY_TYPE_LABEL）：作业 / 考试 / 问卷。判不出来的类型（page / forum / online_video…）
 * 一律不进来，只在课程详情页的「全部」标签页里出现 —— 宁可少列，也不猜。
 */
const LMS_HOMEWORK_TYPES = new Set(['homework', 'exam', 'questionnaire']);

/** 课程详情页的分组标签（切换只在前端过滤缓存，零请求）。 */
const LMS_DETAIL_TABS = [
  ['', '全部'],
  ['homework', '作业'],
  ['lecture_live', '直播'],
  ['lesson', '回放'],
  ['material', '资料'],
];

const lmsView = {
  title: '思源学堂',

  render(ctx) {
    lmsUi.mount = ctx.mount;
    lmsPaint();
  },
};

/* --------------------------------------------------------------- 小工具 */

/**
 * 活动详情里的 description 是 HTML：先去掉标签取纯文本，再经 PCUtil.escapeHtml 转义。
 * escapeHtml 在 PCUtil 的闭包里，不是全局函数，必须走 PCUtil.escapeHtml。
 */
function lmsPlainText(html) {
  return PCUtil.escapeHtml(
    String(html ?? '')
      .replace(/<(br|\/p|\/div|\/li|\/tr)\s*\/?>/gi, '\n') // 块级标签换成换行，避免文字黏在一起
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}

/** 附件大小：B / KB / MB 友好格式。 */
function lmsFileSize(size) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 这条活动是否算「有提交要求的作业」（只按类型白名单，不猜）。 */
function lmsIsHomework(item) {
  return LMS_HOMEWORK_TYPES.has(item?.type);
}

/** 该课程在当前缓存里的活动条数（零请求：数据已经在 activities 里）。 */
function lmsCourseCounts(courseId) {
  const counts = { homework: 0, lecture_live: 0, lesson: 0, material: 0, other: 0, total: 0 };
  for (const item of lmsUi.activities?.items ?? []) {
    if (String(item.courseId) !== String(courseId)) continue;
    counts.total += 1;
    if (counts[item.type] === undefined) counts.other += 1;
    else counts[item.type] += 1;
  }
  return counts;
}

/** 作业列表：按截止时间升序，没有时间的排在最后。 */
function lmsHomeworkItems() {
  const items = (lmsUi.activities?.items ?? []).filter(lmsIsHomework);
  return [...items].sort((a, b) => {
    const left = a.endTime || a.startTime || '';
    const right = b.endTime || b.startTime || '';
    if (!left && !right) return String(a.title ?? '').localeCompare(String(b.title ?? ''), 'zh-Hans-CN');
    if (!left) return 1;
    if (!right) return -1;
    return left.localeCompare(right);
  });
}

/** 提交状态标签（已提交 / 未提交）。 */
function lmsSubmitTag(item) {
  const submitted = (item.userSubmitCount ?? 0) > 0;
  return mk('span', `tag${submitted ? ' submitted' : ''}`, submitted ? '已提交' : '未提交');
}

/**
 * 时间展示：思源学堂返回的是不带时区的 ISO 串（`2026-10-14T23:59:00`），
 * 直接按字面量切片最稳，避免 `new Date()` 把它当 UTC 而串到前一天。
 * 只保留到分钟，并把 T 换成空格。
 */
function lmsFormatTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const match = text.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
  if (match) return match[2] ? `${match[1]} ${match[2]}` : match[1];
  return lmsFormatStamp(text);
}

/** 后端生成的 `lastSyncAt` / `fetchedAt` 是带 Z 的 ISO，按本地时间展示。 */
function lmsFormatStamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return (
    `${date.getFullYear()}-${PCUtil.pad2(date.getMonth() + 1)}-${PCUtil.pad2(date.getDate())}` +
    ` ${PCUtil.pad2(date.getHours())}:${PCUtil.pad2(date.getMinutes())}`
  );
}

/** 顶部工具条按钮：忙碌态由数据驱动，重画后自动恢复。 */
function lmsActionButton(label, busyLabel, busy, handler) {
  const button = mk('button', 'ghost-btn', busy ? busyLabel : label);
  button.type = 'button';
  button.disabled = Boolean(busy);
  button.addEventListener('click', () => handler());
  return button;
}

function lmsUserText(status) {
  const user = status?.user;
  if (!user) return '未登录';
  const name = user.name || '（未获取到姓名）';
  const no = user.userNo ? `（${user.userNo}）` : '';
  return `${name}${no}${user.department ? ` · ${user.department}` : ''}`;
}

function lmsStatusPill(status) {
  const kind = status === 'ready' ? 'ready' : status === 'error' ? 'error' : status === 'anonymous' ? '' : 'warn';
  return mk('span', `lms-pill ${kind}`.trim(), LMS_STATUS_LABEL[status] ?? status ?? '未知');
}

/**
 * 载入图形验证码。
 *
 * Electron 用 file:// 载入页面时 CSP 的 `img-src 'self' data:` 不放行 http://127.0.0.1，
 * 所以 <img> 一旦加载失败就退回「fetch → data URL」（connect-src 与 img 的 data: 都是放行的）。
 */
function lmsLoadCaptcha(img, note) {
  const url = `${PC.state.apiBase}/lms/captcha?t=${Date.now()}`;
  if (note) note.textContent = '';
  img.onerror = () => {
    img.onerror = null;
    fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`验证码接口返回 ${response.status}`);
        return response.blob();
      })
      .then(
        (blob) =>
          new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('验证码图片解码失败'));
            reader.readAsDataURL(blob);
          }),
      )
      .then((dataUrl) => {
        img.src = String(dataUrl);
      })
      .catch((error) => {
        if (note) note.textContent = `验证码加载失败：${error.message}`;
      });
  };
  img.src = url;
}

/** 同步请求体：界面勾选项 ↔ 后端选项的唯一映射点。 */
function lmsSyncBody(extra) {
  const options = lmsUi.options;
  return {
    // 后端默认只关心作业 + 直播；勾选「导入课程回放」后再把 lesson 加进 types
    types: ['homework', 'lecture_live'].concat(options.includeLesson ? ['lesson'] : []),
    includePast: options.includePast,
    // 后端语义：skipSubmitted=true 表示「已提交的作业不导入」，和界面上的勾选正好相反
    skipSubmitted: !options.includeSubmitted,
    // 后端默认把已提交的作业直接建成「已完成」，保持默认
    markSubmittedDone: true,
    includeCourseRange: options.includeCourseRange,
    pruneStale: options.pruneStale,
    // 学期筛选：没选学期时不传，后端返回全部（等价于旧行为）
    ...(lmsUi.semesterId === null ? {} : { semesterId: lmsUi.semesterId }),
    // 课程范围：详情页「同步本课程」只作用于这一门课
    ...(lmsUi.previewCourseId === null ? {} : { courseIds: [Number(lmsUi.previewCourseId)] }),
    ...extra,
  };
}

/* ------------------------------------------------------------- 学期筛选 */

/** 学期条目 → 请求参数：学校侧 id 转字符串，没有学期信息的课程组用 `'none'`。 */
function lmsSemesterParam(item) {
  return item?.id === null || item?.id === undefined ? 'none' : String(item.id);
}

/** 当前选中的学期条目（未选中时为 undefined）。 */
function lmsCurrentSemester() {
  if (lmsUi.semesterId === null) return undefined;
  return (lmsUi.semesters?.items ?? []).find((item) => lmsSemesterParam(item) === lmsUi.semesterId);
}

/**
 * 下拉项文案：`学期名 · N 门`；`containsToday`（今天确实在该学期区间内）的项后面再跟一个「当前」。
 * 注意 containsToday 与 currentId 不是一回事：后者只是后端的默认推荐值。
 */
function lmsSemesterOptionLabel(item) {
  return `${item.label ?? '未标注学期'} · ${item.courseCount ?? 0} 门`;
}

function lmsSemesterCurrentId(data) {
  const items = data?.items ?? [];
  if (!items.length) return null;
  const recommended = data?.currentId;
  const hit =
    recommended === null || recommended === undefined
      ? items.find((item) => item.id === null || item.id === undefined)
      : items.find((item) => String(item.id) === String(recommended));
  // 后端没给 currentId（或对不上）时退回第一项，保证总有一个有效选择
  return lmsSemesterParam(hit ?? items[0]);
}

/** 学期下拉框：登录前 disabled，登录后拉取 /lms/semesters。 */
function lmsSemesterBar(ready) {
  const bar = mk('div', 'lms-filters lms-semester-bar');

  const label = mk('span', 'lms-semester-label', '学期');
  const select = mk('select', 'lms-semester-select');
  select.title = '按学期筛选课程、活动与同步范围';

  const items = lmsUi.semesters?.items ?? [];
  if (!ready) {
    select.appendChild(option('', '登录后可选', true));
  } else if (lmsUi.semesterId === null) {
    select.appendChild(option('', lmsUi.semestersBusy ? '读取学期…' : '全部学期', true));
  } else if (!items.length) {
    select.appendChild(option(lmsUi.semesterId, lmsUi.semestersBusy ? '读取学期…' : '未标注学期', true));
  } else {
    for (const item of items) {
      const value = lmsSemesterParam(item);
      select.appendChild(option(value, lmsSemesterOptionLabel(item), value === lmsUi.semesterId));
    }
  }
  select.disabled = !ready || lmsUi.semestersBusy || !items.length;
  select.addEventListener('change', () => lmsSelectSemester(select.value));

  bar.append(label, select);
  if (ready && lmsCurrentSemester()?.containsToday) bar.appendChild(mk('span', 'lms-pill ready', '当前'));
  if (lmsUi.semestersBusy) bar.appendChild(mk('span', 'lms-hint', '正在读取学期…'));
  if (lmsUi.semestersError) bar.appendChild(mk('span', 'lms-hint', `学期列表读取失败：${lmsUi.semestersError}`));
  return bar;
}

/* --------------------------------------------------------------- 数据加载 */

/**
 * 业务接口返回 401：学堂登录态已经失效（后端此时已清掉票据），
 * 顺手把状态刷新一次，界面就会退回登录表单，而不是停在一个已经不能用的页面上。
 */
function lmsCheckAuthLost(error) {
  if (error?.status === 401) void lmsLoadStatus();
}

async function lmsLoadStatus({ manual = false } = {}) {
  if (lmsUi.statusLoading) return;
  lmsUi.statusLoading = true;
  lmsUi.statusError = null;
  if (manual) lmsPaint();
  try {
    lmsUi.status = await PC.api('/lms/status');
  } catch (error) {
    lmsUi.statusError = error.message;
  } finally {
    lmsUi.statusLoading = false;
    lmsPaint();
  }
}

/** 课程 / 活动 / 刷新共用的查询串：refresh 与 semesterId 都按需拼。 */
function lmsQuery(parts) {
  const query = [];
  for (const [key, value] of Object.entries(parts)) {
    if (value === undefined || value === null || value === '') continue;
    query.push(`${key}=${encodeURIComponent(value === true ? '1' : String(value))}`);
  }
  return query.length ? `?${query.join('&')}` : '';
}

/**
 * 学期列表：登录后拉一次，默认选中后端给的 currentId（拿不到就选第一项）。
 *
 * 只在「用户还没选过」时才设置默认值——切走视图再切回来会重新拉列表，
 * 若每次都按 currentId 覆盖，用户手动选的学期就会被悄悄改回去。
 * 下拉框自身的 change 处理见 lmsSelectSemester（那里总是采纳用户的选择）。
 */
async function lmsLoadSemesters() {
  if (lmsUi.semestersBusy) return;
  lmsUi.semestersBusy = true;
  lmsUi.semestersError = null;
  lmsPaint();
  try {
    const data = await PC.api('/lms/semesters');
    lmsUi.semesters = data;
    const items = data.items ?? [];
    if (!items.length) {
      // 一门课都没有：没有可筛选的范围，退回「全部」并清掉可能存在的旧选择
      if (lmsUi.semesterId !== null) {
        lmsUi.semesterId = null;
        lmsUi.courses = null;
        lmsUi.activities = null;
      }
    } else if (lmsUi.semesterId === null) {
      // 用户还没选过：用后端推荐的当前学期
      lmsUi.semesterId = lmsSemesterCurrentId(data);
    } else if (!items.some((item) => lmsSemesterParam(item) === lmsUi.semesterId)) {
      // 用户选过的学期在最新列表里已经不存在（学校改过数据）：回退并重新拉该范围的数据
      lmsUi.semesterId = lmsSemesterCurrentId(data);
      lmsUi.courses = null;
      lmsUi.activities = null;
      void lmsLoadCourses(false);
      void lmsLoadActivities(false);
    }
  } catch (error) {
    lmsUi.semestersError = error.message;
    // 置空对象而不是 null：避免每次重画都自动重试，把失败的接口刷爆
    lmsUi.semesters = { items: [], count: 0, currentId: null };
    lmsUi.semesterId = null;
    lmsCheckAuthLost(error);
  } finally {
    lmsUi.semestersBusy = false;
    lmsPaint();
  }
}

/**
 * 切换学期：清掉上一个学期的同步预览与勾选，重置课程筛选，再按新范围重新拉课程与活动。
 * 课程用 refresh=1：后端按学期过滤的是全量拉取结果，否则新学期的缓存会是空的。
 */
function lmsSelectSemester(value) {
  if (value === lmsUi.semesterId) return;
  lmsUi.semesterId = value === '' ? null : String(value);
  lmsUi.activityCourseId = '';
  lmsUi.preview = null;
  lmsUi.selected = new Set();
  lmsUi.applyResult = null;
  lmsUi.applyError = null;
  lmsUi.previewError = null;
  lmsUi.courses = null;
  lmsUi.activities = null;
  // 换了学期：课程详情与展开的活动都不再属于当前范围
  lmsUi.detailCourseId = null;
  lmsUi.detailType = '';
  lmsUi.expandedActivityId = null;
  lmsUi.activityDetails = new Map();
  lmsUi.activityDetailError = new Map();
  void lmsLoadCourses(true);
  void lmsLoadActivities(false);
}

async function lmsLoadCourses(refresh) {
  if (lmsUi.coursesBusy) return;
  lmsUi.coursesBusy = true;
  lmsUi.coursesError = null;
  // 没带学期筛选的这次拉取成功与否都记一笔：学期列表为空时不必反复重试
  if (lmsUi.semesterId === null) lmsUi.coursesLoaded = true;
  lmsPaint();
  try {
    lmsUi.courses = await PC.api(`/lms/courses${lmsQuery({ refresh, semesterId: lmsUi.semesterId })}`);
  } catch (error) {
    lmsUi.coursesError = error.message;
    // 置空对象而不是 null：避免每次重画都自动重试，把失败的接口刷爆
    lmsUi.courses = { items: [], count: 0, fetchedAt: null };
    lmsCheckAuthLost(error);
  } finally {
    lmsUi.coursesBusy = false;
    lmsPaint();
  }
}

async function lmsLoadActivities(refresh) {
  if (lmsUi.activitiesBusy) return;
  lmsUi.activitiesBusy = true;
  lmsUi.activitiesError = null;
  lmsPaint();
  try {
    // 不传 type：后端在 refresh=1 时并不做类型过滤，统一由前端过滤，行为才一致
    lmsUi.activities = await PC.api(`/lms/activities${lmsQuery({ refresh, semesterId: lmsUi.semesterId })}`);
  } catch (error) {
    lmsUi.activitiesError = error.message;
    lmsUi.activities = { items: [], count: 0, fetchedAt: null };
    lmsCheckAuthLost(error);
  } finally {
    lmsUi.activitiesBusy = false;
    lmsPaint();
  }
}

/**
 * 重画后按需补数据：只有「还没拿过」才自动拉，避免反复请求。
 *
 * 顺序很关键：课程 / 活动都要带 semesterId，所以先等学期列表落定，避免先拉一份
 * 「全部学期」的数据、随后又被学期筛选覆盖（那样课程卡会短暂显示超集）。
 * 只有「学期列表为空」（一门课都没有）时才退回不带筛选的全量拉取。
 */
function lmsMaybeLoad() {
  if (!lmsUi.status) {
    if (!lmsUi.statusLoading) void lmsLoadStatus();
    return;
  }
  if (lmsUi.status.status !== 'ready') return;
  if (lmsUi.semesters === null) {
    if (!lmsUi.semestersBusy) void lmsLoadSemesters();
    return;
  }
  if ((lmsUi.semesters.items ?? []).length > 0 && lmsUi.semesterId === null) return; // 等默认学期落定
  if (lmsUi.courses === null && !lmsUi.coursesBusy && !lmsUi.coursesLoaded) void lmsLoadCourses(false);
  if (lmsUi.activities === null && !lmsUi.activitiesBusy) void lmsLoadActivities(false);
}

/* --------------------------------------------------------------- 登录 / 验证 */

function lmsOnLoggedIn() {
  lmsUi.loginError = null;
  lmsUi.mfaSent = false;
  lmsUi.mfaPhoneMasked = null;
  lmsUi.mfaError = null;
  lmsUi.semesters = null;
  lmsUi.semestersError = null;
  lmsUi.semesterId = null;
  lmsUi.courses = null;
  lmsUi.coursesLoaded = false;
  lmsUi.coursesError = null;
  lmsUi.activities = null;
  lmsUi.activitiesError = null;
  lmsUi.preview = null;
  lmsUi.previewCourseId = null;
  lmsUi.selected = new Set();
  lmsUi.applyResult = null;
  lmsUi.applyError = null;
  lmsUi.autoSyncError = null;
  lmsUi.statusOpen = false;
  lmsUi.syncOpen = false;
  lmsUi.detailCourseId = null;
  lmsUi.detailType = '';
  lmsUi.expandedActivityId = null;
  lmsUi.activityDetails = new Map();
  lmsUi.activityDetailBusy = new Set();
  lmsUi.activityDetailError = new Map();
  PC.toast('已登录思源学堂');
  lmsPaint();
}

async function lmsLogout() {
  try {
    const status = await PC.api('/lms/logout', { method: 'POST', body: {} });
    lmsUi.status = status;
    lmsUi.semesters = null;
    lmsUi.semestersError = null;
    lmsUi.semesterId = null;
    lmsUi.courses = null;
    lmsUi.coursesLoaded = false;
    lmsUi.activities = null;
    lmsUi.preview = null;
    lmsUi.previewCourseId = null;
    lmsUi.selected = new Set();
    lmsUi.applyResult = null;
    lmsUi.activityDetails = new Map();
    lmsUi.activityDetailBusy = new Set();
    lmsUi.activityDetailError = new Map();
    lmsUi.detailCourseId = null;
    lmsUi.detailType = '';
    lmsUi.expandedActivityId = null;
    lmsUi.syncOpen = false;
    lmsUi.statusOpen = false;
    lmsUi.loginError = null;
    lmsUi.mfaSent = false;
    lmsUi.mfaPhoneMasked = null;
    lmsUi.mfaError = null;
    lmsUi.autoSyncError = null;
    PC.toast('已退出思源学堂');
  } catch (error) {
    lmsUi.statusError = error.message;
  }
  lmsPaint();
}

/**
 * 保存自动同步设置：两个字段一起传（后端 updateSettings 也支持只传其中一个）。
 * 成功后用返回的 status 刷新状态卡片，失败（400 校验 / 401 未登录）走卡片里的错误条。
 */
async function lmsSaveAutoSync(enabled, intervalHours) {
  lmsUi.autoSyncBusy = true;
  lmsUi.autoSyncError = null;
  const controls = lmsUi.refs.autoSync;
  if (controls) {
    controls.toggle.disabled = true;
    controls.hours.disabled = true;
  }
  try {
    const status = await PC.api('/lms/settings', {
      method: 'POST',
      body: { autoSync: enabled, autoSyncIntervalHours: intervalHours },
    });
    lmsUi.status = status;
    PC.toast(enabled ? `已开启自动同步：每 ${intervalHours} 小时` : '已关闭自动同步');
  } catch (error) {
    lmsUi.autoSyncError = error.message;
    lmsCheckAuthLost(error);
  } finally {
    lmsUi.autoSyncBusy = false;
    lmsPaint();
  }
}

async function lmsSendMfa(button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '发送中…';
  lmsUi.mfaError = null;
  try {
    const result = await PC.api('/lms/mfa/send', { method: 'POST', body: {} });
    if (result.status) lmsUi.status = result.status;
    lmsUi.mfaSent = true;
    lmsUi.mfaPhoneMasked = result.phoneMasked ?? lmsUi.mfaPhoneMasked;
    PC.toast('验证码已发送');
  } catch (error) {
    lmsUi.mfaError = error.message;
  }
  if (button.isConnected) {
    button.disabled = false;
    button.textContent = label;
  }
  lmsPaint();
}

/** 登录卡片：失败分支全部原地更新，保住用户已经输入的密码。 */
function lmsLoginCard() {
  const status = lmsUi.status;
  const card = mk('div', 'card');

  const head = mk('div', 'lms-head');
  head.appendChild(mk('div', 'card-title', status?.status === 'need_captcha' ? '登录（需要图形验证码）' : '登录思源学堂'));
  head.appendChild(mk('div', 'spacer'));
  head.appendChild(mk('span', 'lms-hint', '统一身份认证的学号 / 工号'));
  card.appendChild(head);

  const form = mk('div', 'lms-form');

  const username = mk('input');
  username.type = 'text';
  username.placeholder = '学号 / 用户名';
  username.autocomplete = 'username';
  username.value = lmsUi.username;
  username.addEventListener('input', () => {
    lmsUi.username = username.value;
  });
  form.appendChild(field('学号 / 用户名', username));

  const password = mk('input');
  password.type = 'password';
  password.placeholder = '密码';
  password.autocomplete = 'current-password';
  form.appendChild(field('密码', password));

  const captchaField = mk('div', 'field hidden');
  captchaField.appendChild(mk('span', 'field-label', '图形验证码'));
  const captchaRow = mk('div', 'lms-captcha');
  const captchaInput = mk('input');
  captchaInput.type = 'text';
  captchaInput.placeholder = '验证码';
  captchaInput.autocomplete = 'off';
  const captchaImg = mk('img');
  captchaImg.alt = '图形验证码';
  captchaImg.title = '点击刷新验证码';
  const captchaReload = mk('button', 'ghost-btn', '换一张');
  captchaReload.type = 'button';
  const captchaNote = mk('span', 'lms-hint', '');
  captchaRow.append(captchaInput, captchaImg, captchaReload);
  captchaField.append(captchaRow, captchaNote);
  form.appendChild(captchaField);

  const error = mk('div', 'lms-error');
  const setError = (text) => {
    lmsUi.loginError = text || null;
    error.textContent = text || '';
    error.classList.toggle('hidden', !text);
  };
  form.appendChild(error);

  const actions = mk('div', 'lms-actions');
  const submit = mk('button', 'primary-btn', '登录');
  submit.type = 'button';
  actions.append(submit, mk('span', 'lms-hint', '回车即可提交'));
  form.appendChild(actions);
  card.appendChild(form);

  let captchaOn = Boolean(status?.captchaRequired) || status?.status === 'need_captcha';
  const reloadCaptcha = () => lmsLoadCaptcha(captchaImg, captchaNote);
  const showCaptcha = () => {
    captchaOn = true;
    captchaField.classList.remove('hidden');
    reloadCaptcha();
  };
  captchaReload.addEventListener('click', reloadCaptcha);
  captchaImg.addEventListener('click', reloadCaptcha);
  if (captchaOn) showCaptcha();

  setError(
    status?.status === 'need_captcha'
      ? status.error ?? '请输入图形验证码'
      : status?.status === 'error'
        ? status.error ?? '登录失败'
        : lmsUi.loginError,
  );

  const doSubmit = async () => {
    if (submit.disabled) return;
    const name = username.value.trim();
    const secret = password.value;
    const code = captchaInput.value.trim();
    if (!name) {
      setError('请填写学号 / 用户名');
      username.focus();
      return;
    }
    if (!secret) {
      setError('请填写密码');
      password.focus();
      return;
    }
    if (captchaOn && !code) {
      setError('请填写图形验证码');
      captchaInput.focus();
      return;
    }
    setError(null);
    submit.disabled = true;
    submit.textContent = '登录中…';
    try {
      const next = await PC.api('/lms/login', {
        method: 'POST',
        body: { username: name, password: secret, captcha: captchaOn ? code : undefined },
      });
      lmsUi.status = next;
      if (next.status === 'ready') {
        lmsOnLoggedIn(); // 重画后本卡片会被替换，finally 里不再动 DOM
        return;
      }
      if (next.status === 'need_mfa') {
        lmsUi.mfaSent = Boolean(next.mfa?.sent);
        lmsUi.mfaPhoneMasked = next.mfa?.phoneMasked ?? null;
        lmsUi.mfaError = null;
        lmsPaint();
        return;
      }
      // 连续失败会要求图形验证码：原地把验证码行加出来，密码不用重输
      if (next.captchaRequired && !captchaOn) showCaptcha();
      if (next.status === 'need_captcha') {
        reloadCaptcha();
        captchaInput.value = '';
      }
      setError(next.error ?? '登录失败');
    } catch (err) {
      setError(err.message);
    } finally {
      if (submit.isConnected) {
        submit.disabled = false;
        submit.textContent = '登录';
      }
    }
  };

  submit.addEventListener('click', () => void doSubmit());
  for (const input of [username, password, captchaInput]) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void doSubmit();
      }
    });
  }
  return card;
}

/** 两步验证卡片（短信验证码 / Safety Verify 二次认证共用）。 */
function lmsMfaCard() {
  const status = lmsUi.status;
  const flow = status?.mfa?.flow === 'sec' ? 'sec' : 'mfa';
  const sendLabel = flow === 'sec' ? '发送验证码' : '发送短信验证码';
  const sent = lmsUi.mfaSent || Boolean(status?.mfa?.sent);
  const phone = lmsUi.mfaPhoneMasked ?? status?.mfa?.phoneMasked ?? null;

  const card = mk('div', 'card');
  const head = mk('div', 'lms-head');
  head.append(
    mk('div', 'card-title', '两步验证'),
    mk('div', 'spacer'),
    mk('span', 'lms-pill warn', flow === 'sec' ? '二次认证' : '短信验证'),
  );
  card.appendChild(head);

  const error = mk('div', 'lms-error');
  const setError = (text) => {
    lmsUi.mfaError = text || null;
    error.textContent = text || '';
    error.classList.toggle('hidden', !text);
  };

  if (!sent) {
    card.appendChild(
      mk(
        'div',
        'lms-hint',
        flow === 'sec' ? '学校要求二次认证：先获取验证码，再输入收到的 6 位数字。' : '学校要求短信验证：先获取验证码，再输入收到的 6 位数字。',
      ),
    );
    const actions = mk('div', 'lms-actions');
    const send = mk('button', 'primary-btn', sendLabel);
    send.type = 'button';
    send.addEventListener('click', () => void lmsSendMfa(send));
    actions.appendChild(send);
    card.appendChild(actions);
    setError(lmsUi.mfaError);
    card.appendChild(error);
    return card;
  }

  card.appendChild(mk('div', 'lms-hint', phone ? `验证码已发送至 ${phone}` : '验证码已发送，请查看手机'));
  const form = mk('div', 'lms-form');
  const code = mk('input');
  code.type = 'text';
  code.inputMode = 'numeric';
  code.maxLength = 6;
  code.placeholder = '6 位验证码';
  code.autocomplete = 'one-time-code';
  form.appendChild(field('验证码', code));

  const actions = mk('div', 'lms-actions');
  const verify = mk('button', 'primary-btn', '提交验证码');
  verify.type = 'button';
  const resend = mk('button', 'ghost-btn', '重新发送');
  resend.type = 'button';
  actions.append(verify, resend);
  form.appendChild(actions);
  form.appendChild(error);
  setError(lmsUi.mfaError);
  card.appendChild(form);

  const doVerify = async () => {
    const value = code.value.trim();
    if (!/^\d{6}$/.test(value)) {
      setError('请输入 6 位数字验证码');
      code.focus();
      return;
    }
    setError(null);
    verify.disabled = true;
    verify.textContent = '校验中…';
    try {
      const next = await PC.api('/lms/mfa/verify', { method: 'POST', body: { code: value } });
      lmsUi.status = next;
      if (next.status === 'ready') {
        lmsOnLoggedIn();
        return;
      }
      setError(next.error ?? '验证码校验失败');
    } catch (err) {
      setError(err.message);
    } finally {
      if (verify.isConnected) {
        verify.disabled = false;
        verify.textContent = '提交验证码';
      }
    }
  };
  verify.addEventListener('click', () => void doVerify());
  code.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void doVerify();
    }
  });
  resend.addEventListener('click', () => void lmsSendMfa(resend));
  requestAnimationFrame(() => code.focus());
  return card;
}

/* ================================================================ 课表（教务） */

/**
 * 课表视图的会话态。
 *
 * 与思源学堂（lmsUi）刻意保持两套独立状态：两边的登录票据、缓存、同步计划都由各自的后端
 * 服务持有，前端只是「最近一次拿到的渲染素材」。所有交互只改这一份数据，再 ttPaint() 整体重画。
 *
 * 注意：这里不保存密码；term（学期编号）与 includePast / compact（同步选项）是用户手上的选择，
 * 存在这里以便切走视图再切回来不丢。
 */
const ttUi = {
  mount: null,
  status: null,
  statusLoading: false,
  statusError: null,
  terms: null,
  termsBusy: false,
  termsError: null,
  term: null,
  /** 手改学期起始日的输入值（按 term 暂存，避免重画后被冲掉）。 */
  startInput: '',
  startBusy: false,
  startError: null,
  courses: null,
  coursesBusy: false,
  coursesError: null,
  /** 只记住学号（便于切走再切回来），明文密码不留在内存里。 */
  username: '',
  loginError: null,
  mfaSent: false,
  mfaPhoneMasked: null,
  mfaError: null,
  options: { includePast: false, compact: false },
  preview: null,
  previewBusy: false,
  previewError: null,
  selected: new Set(),
  applyBusy: false,
  applyResult: null,
  applyError: null,
  /** 结果里展示的可折叠明细（applyResult.results 的副本，便于「清空旧预览」时一起清）。 */
  applyDetails: null,
  /** 当前渲染出来的节点，用于不重画的原地更新（勾选 / 计数）。 */
  refs: { syncCount: null, syncButton: null, syncBoxes: [] },
  /** 面板宽度观察器（窄栏时周网格退化成列表）。 */
  observer: null,
  narrow: null,
  /** 课表请求令牌：后来的请求胜出，避免「自动读缓存」吃掉用户手点的「拉取课表」。 */
  loadToken: 0,
};

const TT_STATUS_LABEL = {
  anonymous: '未登录',
  need_mfa: '需要两步验证',
  need_captcha: '需要图形验证码',
  ready: '已登录',
  error: '登录异常',
};

/** 起始日来源：ehall=学校接口，guess=本地推算，manual=手工指定。 */
const TT_SOURCE_LABEL = { ehall: '接口', guess: '推算', manual: '手动' };

const TT_ACTION_LABEL = { create: '新建', update: '更新', skip: '跳过', stale: '失效' };

/** 节气次（1~11）：课表接口只给节次，时刻是学校作息（与后端 periods.js 的分块一致）。 */
const TT_DAY_LABEL = ['一', '二', '三', '四', '五', '六', '日'];
const TT_PERIOD_COUNT = 11;
/** 上午 1-4 / 下午 5-8 / 晚上 9-11，用于网格里给节次分组留白。 */
const TT_PERIOD_BLOCKS = [
  { label: '上午', from: 1, to: 4 },
  { label: '下午', from: 5, to: 8 },
  { label: '晚上', from: 9, to: 11 },
];
/** 自适应断点：面板窄于这个宽度时，周网格退化成按星期分组的列表（避免横向滚动）。 */
const TT_GRID_MIN_WIDTH = 620;

const ttView = {
  title: '课表',

  render(ctx) {
    ttUi.mount = ctx.mount;
    ttPaint();
    // 宽窄切换要跟着面板实际宽度走（首帧 clientWidth 可能是 0，不能只量一次）
    ttObserveWidth(ctx.mount);
  },
};

/**
 * 监听右侧面板宽度：跨过 TT_GRID_MIN_WIDTH 时切换「周网格 ↔ 按星期列表」。
 * 用 ResizeObserver 而不是 window.resize：折叠/展开面板、改窗口宽度都会触发。
 */
function ttObserveWidth(mount) {
  if (!mount || typeof ResizeObserver !== 'function') return;
  if (ttUi.observer) ttUi.observer.disconnect();
  const apply = (width) => {
    if (!(width > 0)) return;
    const narrow = width < TT_GRID_MIN_WIDTH;
    if (narrow === ttUi.narrow) return;
    ttUi.narrow = narrow;
    ttPaint();
  };
  ttUi.observer = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect?.width ?? mount.clientWidth;
    apply(width);
  });
  ttUi.observer.observe(mount);
  apply(mount.clientWidth);
}

/* --------------------------------------------------------------- 小工具 */

/** 学期编号 → 展示名（后端也提供 label，这里是拿不到列表时的兜底）。 */
function ttTermLabel(term) {
  const matched = /^(\d{4})-(\d{4})-([123])$/.exec(String(term ?? ''));
  if (!matched) return String(term ?? '');
  const suffix = matched[3] === '3' ? '小学期' : `第 ${matched[3]} 学期`;
  return `${matched[1]}-${matched[2]} 学年 · ${suffix}`;
}

function ttSourceTag(source) {
  return TT_SOURCE_LABEL[source] ?? (source ? String(source) : '未知');
}

/** 周次数组 → `第1-4,7-10周`（与后端的 describeWeeks 同款文案）。 */
function ttWeeksText(weeks) {
  const list = [...new Set((weeks ?? []).map(Number))].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!list.length) return '周次未知';
  const parts = [];
  let start = list[0];
  let prev = list[0];
  for (let index = 1; index <= list.length; index += 1) {
    const value = list[index];
    if (value === prev + 1) {
      prev = value;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = value;
    prev = value;
  }
  return `第${parts.join(',')}周`;
}

/** 位图 `1111001111` → [1,2,3,4,7,8,9,10]（不依赖后端的位图解析，纯前端兜底）。 */
function ttBitmapWeeks(bitmap) {
  const text = String(bitmap ?? '');
  const out = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '1') out.push(index + 1);
  }
  return out;
}

/** 教师 / 教室的兜底文案。 */
function ttTeacherText(item) {
  return item?.teacher ? String(item.teacher) : '教师未知';
}

function ttLocationText(item) {
  const locations = Array.isArray(item?.locations) ? item.locations.filter(Boolean) : [];
  if (locations.length) return locations.join(' / ');
  return item?.location ? String(item.location) : '教室未知';
}

/** 星期 + 节次：`周三 第5-6节`。 */
function ttSlotText(weekDay, startPeriod, endPeriod) {
  const day = TT_DAY_LABEL[Number(weekDay) - 1] ?? Number(weekDay);
  const range = startPeriod === endPeriod ? `第${startPeriod}节` : `第${startPeriod}-${endPeriod}节`;
  return `周${day} ${range}`;
}

/** 配色按「课程名出现顺序」分配，保证同屏内不同课程不撞色（同名课恒定同色）。 */
function ttColorAssigner() {
  const palette = ['var(--blue)', 'var(--green)', 'var(--purple)', 'var(--orange)', 'var(--red)'];
  const used = new Map();
  return (name) => {
    const key = String(name ?? '');
    if (!used.has(key)) used.set(key, palette[used.size % palette.length]);
    return used.get(key);
  };
}

/** 当前学期条目（含起始日与来源）。 */
function ttCurrentTerm() {
  if (!ttUi.term) return undefined;
  return (ttUi.terms?.items ?? []).find((item) => item.term === ttUi.term);
}

/** 起始日是否可用：缺起始日时不能预览 / 同步（后端也会拒绝）。 */
function ttStartReady() {
  const item = ttCurrentTerm();
  if (!item) return false;
  return Boolean(item.startDate) && !item.validation;
}

/* --------------------------------------------------------------- 数据加载 */

function ttCheckAuthLost(error) {
  if (error?.status === 401) void ttLoadStatus();
}

async function ttLoadStatus({ manual = false } = {}) {
  if (ttUi.statusLoading) return;
  ttUi.statusLoading = true;
  ttUi.statusError = null;
  if (manual) ttPaint();
  try {
    ttUi.status = await PC.api('/tt/status');
    // 后端会在登录后给出当前学期：直接当默认选项，省一次 terms 请求
    if (!ttUi.term && ttUi.status?.currentTerm) ttUi.term = ttUi.status.currentTerm;
  } catch (error) {
    ttUi.statusError = error.message;
  } finally {
    ttUi.statusLoading = false;
    ttPaint();
  }
}

async function ttLoadTerms({ refresh = false } = {}) {
  if (ttUi.termsBusy) return;
  ttUi.termsBusy = true;
  ttUi.termsError = null;
  ttPaint();
  try {
    const data = await PC.api(`/tt/terms${lmsQuery({ refresh })}`);
    ttUi.terms = data;
    const items = data.items ?? [];
    if (!items.length) {
      ttUi.term = null;
    } else if (!ttUi.term || !items.some((item) => item.term === ttUi.term)) {
      ttUi.term = data.currentTerm ?? items[0].term;
    }
    ttUi.startInput = ttCurrentTerm()?.startDate ?? '';
  } catch (error) {
    ttUi.termsError = error.message;
    // 置空对象而不是 null：避免每次重画都自动重试，把失败的接口刷爆
    ttUi.terms = { items: [], count: 0, currentTerm: null };
    ttCheckAuthLost(error);
  } finally {
    ttUi.termsBusy = false;
    ttPaint();
  }
}

/** 手改学期起始日：成功后后端会把 source 标成 manual（此后再也不被自动值覆盖）。 */
async function ttSaveTermStart(value) {
  if (!ttUi.term) return;
  ttUi.startBusy = true;
  ttUi.startError = null;
  ttPaint();
  try {
    await PC.api(`/tt/terms/${encodeURIComponent(ttUi.term)}`, { method: 'POST', body: { startDate: value } });
    PC.toast(`已保存 ${ttUi.term} 的起始日`);
    // 起始日变了，之前那份预览依据的日期全部不再成立
    ttClearPreview();
    await ttLoadTerms({ refresh: true });
    if (ttUi.courses) await ttLoadCourses({ refresh: false });
  } catch (error) {
    ttUi.startError = error.message;
    ttCheckAuthLost(error);
  } finally {
    ttUi.startBusy = false;
    ttPaint();
  }
}

/**
 * 拉取并缓存某学期的课表（POST /tt/refresh?term=）。
 *
 * 用「请求令牌」而不是 coursesBusy 早退：进入视图时会自动读一次缓存（GET /tt/courses），
 * 如果用户在它还没回来时点「拉取课表」，早退会把这次点击吃掉；改成后来的请求胜出。
 */
async function ttRefreshTimetable() {
  if (!ttUi.term) return;
  const token = (ttUi.loadToken += 1);
  ttUi.coursesBusy = true;
  ttUi.coursesError = null;
  ttClearPreview();
  ttPaint();
  try {
    const data = await PC.api(`/tt/refresh${lmsQuery({ term: ttUi.term })}`, { method: 'POST', body: {} });
    if (token !== ttUi.loadToken) return;
    ttUi.courses = data;
    PC.toast(`已拉取 ${data.count ?? 0} 条课表记录`);
  } catch (error) {
    if (token !== ttUi.loadToken) return;
    ttUi.coursesError = error.message;
    ttCheckAuthLost(error);
  } finally {
    if (token === ttUi.loadToken) {
      ttUi.coursesBusy = false;
      ttPaint();
    }
  }
}

/** 读课表（命中缓存时很快）；refresh=true 时后端会重新拉。 */
async function ttLoadCourses({ refresh = false } = {}) {
  if (!ttUi.term) return;
  const token = (ttUi.loadToken += 1);
  ttUi.coursesBusy = true;
  ttUi.coursesError = null;
  ttPaint();
  try {
    const data = await PC.api(`/tt/courses${lmsQuery({ term: ttUi.term, refresh })}`);
    if (token !== ttUi.loadToken) return; // 已被更新的一次请求取代（例如用户直接点了「拉取课表」）
    ttUi.courses = data;
  } catch (error) {
    if (token !== ttUi.loadToken) return;
    ttUi.coursesError = error.message;
    ttUi.courses = { term: ttUi.term, items: [], count: 0, fetchedAt: null };
    ttCheckAuthLost(error);
  } finally {
    if (token === ttUi.loadToken) {
      ttUi.coursesBusy = false;
      ttPaint();
    }
  }
}

/** 切换学期：课程、预览、勾选全部要按新范围重来。 */
function ttSelectTerm(value) {
  if (!value || value === ttUi.term) return;
  ttUi.term = value;
  ttUi.courses = null;
  ttUi.coursesError = null;
  ttUi.startError = null;
  ttUi.startInput = '';
  ttClearPreview();
  void ttLoadCourses({ refresh: false });
}

function ttClearPreview() {
  ttUi.preview = null;
  ttUi.previewError = null;
  ttUi.selected = new Set();
  ttUi.applyResult = null;
  ttUi.applyDetails = null;
  ttUi.applyError = null;
}

/** 重画后按需补数据：只有「还没拿过」才自动拉。 */
function ttMaybeLoad() {
  if (!ttUi.status) {
    if (!ttUi.statusLoading) void ttLoadStatus();
    return;
  }
  if (ttUi.status.status !== 'ready') return;
  if (ttUi.terms === null) {
    if (!ttUi.termsBusy) void ttLoadTerms();
    return;
  }
  if (ttUi.term && ttUi.courses === null && !ttUi.coursesBusy) void ttLoadCourses({ refresh: false });
}

function ttOnLoggedIn() {
  ttUi.loginError = null;
  ttUi.mfaSent = false;
  ttUi.mfaPhoneMasked = null;
  ttUi.mfaError = null;
  ttUi.terms = null;
  ttUi.termsError = null;
  ttUi.term = ttUi.status?.currentTerm ?? null;
  ttUi.courses = null;
  ttUi.coursesError = null;
  ttUi.startError = null;
  ttClearPreview();
  PC.toast('已登录教务系统');
  ttPaint();
}

async function ttLogout() {
  try {
    ttUi.status = await PC.api('/tt/logout', { method: 'POST', body: {} });
    ttUi.terms = null;
    ttUi.termsError = null;
    ttUi.term = null;
    ttUi.courses = null;
    ttUi.startError = null;
    ttClearPreview();
    ttUi.loginError = null;
    ttUi.mfaSent = false;
    ttUi.mfaPhoneMasked = null;
    ttUi.mfaError = null;
    PC.toast('已退出教务系统');
  } catch (error) {
    ttUi.statusError = error.message;
  }
  ttPaint();
}

/* --------------------------------------------------------------- 同步 */

/** 同步请求体：界面勾选项 ↔ 后端选项的唯一映射点。 */
function ttSyncBody(extra) {
  return {
    term: ttUi.term,
    includePast: ttUi.options.includePast,
    compact: ttUi.options.compact,
    ...extra,
  };
}

async function ttPreviewSync() {
  if (ttUi.previewBusy) return;
  ttUi.previewBusy = true;
  ttUi.previewError = null;
  ttUi.applyResult = null;
  ttUi.applyDetails = null;
  ttUi.applyError = null;
  ttPaint();
  try {
    const data = await PC.api('/tt/preview', { method: 'POST', body: ttSyncBody({}) });
    ttUi.preview = data;
    // 默认只勾选会真正写库的条目，跳过 / 失效交给用户自己决定
    ttUi.selected = new Set(
      (data.items ?? []).filter((item) => item.action === 'create' || item.action === 'update').map((item) => item.key),
    );
  } catch (error) {
    ttUi.previewError = error.message;
    ttUi.preview = null;
    ttUi.selected = new Set();
    ttCheckAuthLost(error);
  } finally {
    ttUi.previewBusy = false;
    ttPaint();
  }
}

async function ttApplySync() {
  if (ttUi.applyBusy) return;
  const keys = [...ttUi.selected];
  if (!keys.length) {
    ttUi.applyError = '请先勾选要同步的条目';
    ttPaint();
    return;
  }
  ttUi.applyBusy = true;
  ttUi.applyError = null;
  ttPaint();
  try {
    const result = await PC.api('/tt/apply', { method: 'POST', body: ttSyncBody({ keys }) });
    ttUi.applyResult = result;
    ttUi.applyDetails = Array.isArray(result.results) ? result.results : null;
    // 落库后旧的预览已经过期，清掉避免误点
    ttUi.preview = null;
    ttUi.selected = new Set();
    PC.toast(`同步完成：新建 ${result.created ?? 0} · 更新 ${result.updated ?? 0}`);
    try {
      ttUi.status = await PC.api('/tt/status'); // 刷新已同步条数 / 上次同步时间
    } catch {
      /* 状态刷新失败不影响同步结果展示 */
    }
  } catch (error) {
    ttUi.applyError = error.message;
    ttCheckAuthLost(error);
  } finally {
    ttUi.applyBusy = false;
    ttPaint();
  }
}

/** 同步结果的汇总与错误明细。 */
function ttApplyResultBox(result) {
  const box = mk('div', 'lms-result');
  box.appendChild(mk('div', 'lms-row-title', '同步结果'));
  box.appendChild(
    mk(
      'div',
      'lms-row-meta',
      `新建 ${result.created ?? 0} · 更新 ${result.updated ?? 0} · 删除 ${result.removed ?? 0}` +
        ` · 跳过 ${result.skipped ?? 0} · 失败 ${(result.errors ?? []).length}`,
    ),
  );
  if (result.lastSyncAt) box.appendChild(mk('div', 'lms-row-meta', `最近同步：${lmsFormatStamp(result.lastSyncAt)}`));
  for (const error of (result.errors ?? []).slice(0, 10)) {
    const text = `${error.key ?? ''} ${error.message ?? ''}`.trim();
    if (text) box.appendChild(mk('div', 'lms-error', text));
  }
  return box;
}

/* --------------------------------------------------------------- 登录 / 验证 */

/**
 * 统一身份认证卡片（登录 / 图形验证码）。
 *
 * 与思源学堂用的是同一套 CAS，交互刻意做成一样的：失败分支全部原地更新，保住用户已输入的密码。
 * 通过 opts 里的 api / state / 文案参数复用，避免和 lmsLoginCard 互相耦合。
 */
function ttAuthHelper(opts) {
  const state = opts.state;

  function loadCaptcha(img, note) {
    const url = `${PC.state.apiBase}${opts.captchaPath}?t=${Date.now()}`;
    if (note) note.textContent = '';
    // 与 lms 同样的兜底：Electron 用 file:// 载入时 CSP 不放行 http 图片，退回 fetch → data URL
    img.onerror = () => {
      img.onerror = null;
      fetch(url)
        .then((response) => {
          if (!response.ok) throw new Error(`验证码接口返回 ${response.status}`);
          return response.blob();
        })
        .then(
          (blob) =>
            new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject(new Error('验证码图片解码失败'));
              reader.readAsDataURL(blob);
            }),
        )
        .then((dataUrl) => {
          img.src = String(dataUrl);
        })
        .catch((error) => {
          if (note) note.textContent = `验证码加载失败：${error.message}`;
        });
    };
    img.src = url;
  }

  async function sendMfa(button) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = '发送中…';
    state.mfaError = null;
    try {
      const result = await PC.api(opts.mfaSendPath, { method: 'POST', body: {} });
      if (result.status) state.status = result.status;
      state.mfaSent = true;
      state.mfaPhoneMasked = result.phoneMasked ?? state.mfaPhoneMasked;
      PC.toast('验证码已发送');
    } catch (error) {
      state.mfaError = error.message;
    }
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = label;
    }
    opts.paint();
  }

  function loginCard() {
    const status = state.status;
    const card = mk('div', 'card');

    const head = mk('div', 'lms-head');
    head.appendChild(
      mk('div', 'card-title', status?.status === 'need_captcha' ? `登录（需要图形验证码）` : `登录${opts.title}`),
    );
    head.appendChild(mk('div', 'spacer'));
    head.appendChild(mk('span', 'lms-hint', '统一身份认证的学号 / 工号'));
    card.appendChild(head);

    const form = mk('div', 'lms-form');

    const username = mk('input');
    username.type = 'text';
    username.placeholder = '学号 / 用户名';
    username.autocomplete = 'username';
    username.value = state.username;
    username.addEventListener('input', () => {
      state.username = username.value;
    });
    form.appendChild(field('学号 / 用户名', username));

    const password = mk('input');
    password.type = 'password';
    password.placeholder = '密码';
    password.autocomplete = 'current-password';
    form.appendChild(field('密码', password));

    const captchaField = mk('div', 'field hidden');
    captchaField.appendChild(mk('span', 'field-label', '图形验证码'));
    const captchaRow = mk('div', 'lms-captcha');
    const captchaInput = mk('input');
    captchaInput.type = 'text';
    captchaInput.placeholder = '验证码';
    captchaInput.autocomplete = 'off';
    const captchaImg = mk('img');
    captchaImg.alt = '图形验证码';
    captchaImg.title = '点击刷新验证码';
    const captchaReload = mk('button', 'ghost-btn', '换一张');
    captchaReload.type = 'button';
    const captchaNote = mk('span', 'lms-hint', '');
    captchaRow.append(captchaInput, captchaImg, captchaReload);
    captchaField.append(captchaRow, captchaNote);
    form.appendChild(captchaField);

    const error = mk('div', 'lms-error');
    const setError = (text) => {
      state.loginError = text || null;
      error.textContent = text || '';
      error.classList.toggle('hidden', !text);
    };
    form.appendChild(error);

    const actions = mk('div', 'lms-actions');
    const submit = mk('button', 'primary-btn', '登录');
    submit.type = 'button';
    actions.append(submit, mk('span', 'lms-hint', '回车即可提交'));
    form.appendChild(actions);
    card.appendChild(form);

    let captchaOn = Boolean(status?.captchaRequired) || status?.status === 'need_captcha';
    const reloadCaptcha = () => loadCaptcha(captchaImg, captchaNote);
    const showCaptcha = () => {
      captchaOn = true;
      captchaField.classList.remove('hidden');
      reloadCaptcha();
    };
    captchaReload.addEventListener('click', reloadCaptcha);
    captchaImg.addEventListener('click', reloadCaptcha);
    if (captchaOn) showCaptcha();

    setError(
      status?.status === 'need_captcha'
        ? status.error ?? '请输入图形验证码'
        : status?.status === 'error'
          ? status.error ?? '登录失败'
          : state.loginError,
    );

    const doSubmit = async () => {
      if (submit.disabled) return;
      const name = username.value.trim();
      const secret = password.value;
      const code = captchaInput.value.trim();
      if (!name) {
        setError('请填写学号 / 用户名');
        username.focus();
        return;
      }
      if (!secret) {
        setError('请填写密码');
        password.focus();
        return;
      }
      if (captchaOn && !code) {
        setError('请填写图形验证码');
        captchaInput.focus();
        return;
      }
      setError(null);
      submit.disabled = true;
      submit.textContent = '登录中…';
      try {
        const next = await PC.api(opts.loginPath, {
          method: 'POST',
          body: { username: name, password: secret, captcha: captchaOn ? code : undefined },
        });
        state.status = next;
        if (next.status === 'ready') {
          opts.onLoggedIn(); // 重画后本卡片会被替换，finally 里不再动 DOM
          return;
        }
        if (next.status === 'need_mfa') {
          state.mfaSent = Boolean(next.mfa?.sent);
          state.mfaPhoneMasked = next.mfa?.phoneMasked ?? null;
          state.mfaError = null;
          opts.paint();
          return;
        }
        // 连续失败会要求图形验证码：原地把验证码行加出来，密码不用重输
        if (next.captchaRequired && !captchaOn) showCaptcha();
        if (next.status === 'need_captcha') {
          reloadCaptcha();
          captchaInput.value = '';
        }
        setError(next.error ?? '登录失败');
      } catch (err) {
        setError(err.message);
      } finally {
        if (submit.isConnected) {
          submit.disabled = false;
          submit.textContent = '登录';
        }
      }
    };

    submit.addEventListener('click', () => void doSubmit());
    for (const input of [username, password, captchaInput]) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void doSubmit();
        }
      });
    }
    return card;
  }

  function mfaCard() {
    const status = state.status;
    const flow = status?.mfa?.flow === 'sec' ? 'sec' : 'mfa';
    const sendLabel = flow === 'sec' ? '发送验证码' : '发送短信验证码';
    const sent = state.mfaSent || Boolean(status?.mfa?.sent);
    const phone = state.mfaPhoneMasked ?? status?.mfa?.phoneMasked ?? null;

    const card = mk('div', 'card');
    const head = mk('div', 'lms-head');
    head.append(
      mk('div', 'card-title', '两步验证'),
      mk('div', 'spacer'),
      mk('span', 'lms-pill warn', flow === 'sec' ? '二次认证' : '短信验证'),
    );
    card.appendChild(head);

    const error = mk('div', 'lms-error');
    const setError = (text) => {
      state.mfaError = text || null;
      error.textContent = text || '';
      error.classList.toggle('hidden', !text);
    };

    if (!sent) {
      card.appendChild(
        mk(
          'div',
          'lms-hint',
          flow === 'sec'
            ? '学校要求二次认证：先获取验证码，再输入收到的 6 位数字。'
            : '学校要求短信验证：先获取验证码，再输入收到的 6 位数字。',
        ),
      );
      const actions = mk('div', 'lms-actions');
      const send = mk('button', 'primary-btn', sendLabel);
      send.type = 'button';
      send.addEventListener('click', () => void sendMfa(send));
      actions.appendChild(send);
      card.appendChild(actions);
      setError(state.mfaError);
      card.appendChild(error);
      return card;
    }

    card.appendChild(mk('div', 'lms-hint', phone ? `验证码已发送至 ${phone}` : '验证码已发送，请查看手机'));
    const form = mk('div', 'lms-form');
    const code = mk('input');
    code.type = 'text';
    code.inputMode = 'numeric';
    code.maxLength = 6;
    code.placeholder = '6 位验证码';
    code.autocomplete = 'one-time-code';
    form.appendChild(field('验证码', code));

    const actions = mk('div', 'lms-actions');
    const verify = mk('button', 'primary-btn', '提交验证码');
    verify.type = 'button';
    const resend = mk('button', 'ghost-btn', '重新发送');
    resend.type = 'button';
    actions.append(verify, resend);
    form.appendChild(actions);
    form.appendChild(error);
    setError(state.mfaError);
    card.appendChild(form);

    const doVerify = async () => {
      const value = code.value.trim();
      if (!/^\d{6}$/.test(value)) {
        setError('请输入 6 位数字验证码');
        code.focus();
        return;
      }
      setError(null);
      verify.disabled = true;
      verify.textContent = '校验中…';
      try {
        const next = await PC.api(opts.mfaVerifyPath, { method: 'POST', body: { code: value } });
        state.status = next;
        if (next.status === 'ready') {
          opts.onLoggedIn();
          return;
        }
        setError(next.error ?? '验证码校验失败');
      } catch (err) {
        setError(err.message);
      } finally {
        if (verify.isConnected) {
          verify.disabled = false;
          verify.textContent = '提交验证码';
        }
      }
    };
    verify.addEventListener('click', () => void doVerify());
    code.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void doVerify();
      }
    });
    resend.addEventListener('click', () => void sendMfa(resend));
    requestAnimationFrame(() => code.focus());
    return card;
  }

  return { loginCard, mfaCard };
}

const ttAuth = ttAuthHelper({
  state: ttUi,
  title: '教务（ehall）',
  loginPath: '/tt/login',
  mfaSendPath: '/tt/mfa/send',
  mfaVerifyPath: '/tt/mfa/verify',
  captchaPath: '/tt/captcha',
  paint: () => ttPaint(),
  onLoggedIn: () => ttOnLoggedIn(),
});

/* --------------------------------------------------------------- 卡片 */

function ttStatusPill(status) {
  const kind = status === 'ready' ? 'ready' : status === 'error' ? 'error' : status === 'anonymous' ? '' : 'warn';
  return mk('span', `lms-pill ${kind}`.trim(), TT_STATUS_LABEL[status] ?? status ?? '未知');
}

function ttStatusCard() {
  const card = mk('div', 'card');
  const status = ttUi.status;

  const head = mk('div', 'lms-head');
  head.appendChild(mk('div', 'card-title', '教务状态'));
  head.appendChild(mk('div', 'spacer'));
  if (status) head.appendChild(ttStatusPill(status.status));
  card.appendChild(head);

  const body = mk('div', 'card-body');
  const kv = (key, value) => {
    const row = mk('div', 'kv');
    row.append(mk('span', 'kv-key', key), mk('span', 'kv-val', value ?? '—'));
    body.appendChild(row);
  };
  if (!status) {
    kv('状态', ttUi.statusLoading ? '读取中…' : '未知');
  } else {
    kv('账号', status.user?.name || (status.status === 'ready' ? '已登录（教务不返回姓名）' : '未登录'));
    kv('当前学期', status.currentTerm ? `${status.currentTerm} · ${ttTermLabel(status.currentTerm)}` : '未知');
    kv('学期起始日', `已记录 ${status.terms?.known ?? 0} 个 · 手工指定 ${status.terms?.manual ?? 0} 个`);
    kv('课表缓存', `学期 ${(status.cache?.terms ?? []).length} 个 · 课表行 ${status.cache?.rows ?? 0} 条`);
    kv('缓存时间', status.cache?.lastTimetableAt ? lmsFormatStamp(status.cache.lastTimetableAt) : '尚未拉取');
    kv('已同步', `日程 ${status.synced?.schedules ?? 0} 条`);
    kv('上次同步', status.lastSyncAt ? lmsFormatStamp(status.lastSyncAt) : '尚未同步');
    kv('服务地址', status.baseUrl ?? '—');
    if (status.error) kv('最近错误', status.error);
  }
  card.appendChild(body);

  if (ttUi.statusError) card.appendChild(mk('div', 'lms-error', `状态读取失败：${ttUi.statusError}`));

  if (status && status.status !== 'anonymous') {
    const actions = mk('div', 'lms-actions');
    const out = mk('button', 'ghost-btn', '退出登录');
    out.type = 'button';
    out.addEventListener('click', () => void ttLogout());
    actions.append(mk('div', 'spacer'), out);
    card.appendChild(actions);
  }
  return card;
}

/** 学期下拉 + 起始日展示 / 手改。 */
function ttTermsCard() {
  const card = mk('div', 'card');
  const head = mk('div', 'lms-head');
  head.appendChild(mk('div', 'card-title', '学期'));
  head.appendChild(mk('div', 'spacer'));
  head.appendChild(
    lmsActionButton('刷新学期', '刷新中…', ttUi.termsBusy, () => void ttLoadTerms({ refresh: true })),
  );
  card.appendChild(head);

  const items = ttUi.terms?.items ?? [];
  if (ttUi.terms === null && ttUi.termsBusy) card.appendChild(mk('div', 'loading', '加载中…'));
  if (ttUi.termsError) card.appendChild(mk('div', 'lms-error', `学期列表读取失败：${ttUi.termsError}`));

  const filters = mk('div', 'lms-filters');
  const select = mk('select', 'tt-term-select');
  select.title = '选择学期（课表与同步都按这个学期）';
  if (!items.length) {
    select.appendChild(option('', '暂无学期', true));
    select.disabled = true;
  } else {
    for (const item of items) {
      const date = item.startDate ?? '起始日未知';
      const label = `${item.label ?? ttTermLabel(item.term)} · ${date} · ${ttSourceTag(item.source)}`;
      select.appendChild(option(item.term, label, item.term === ttUi.term));
    }
    select.disabled = ttUi.termsBusy;
    select.addEventListener('change', () => ttSelectTerm(select.value));
  }
  filters.appendChild(select);

  const current = ttCurrentTerm();
  if (current?.source) filters.appendChild(mk('span', `lms-pill ${current.source === 'manual' ? 'ready' : ''}`.trim(), `起始日：${ttSourceTag(current.source)}`));
  if (current?.totalWeeks) filters.appendChild(mk('span', 'lms-hint', `共 ${current.totalWeeks} 周`));
  card.appendChild(filters);

  const missing = Boolean(current) && (!current.startDate || current.validation);
  if (missing) {
    card.appendChild(
      mk('div', 'lms-error', '需要先设置学期起始日才能生成日程：在下面填第一周周一，保存后即可预览与同步。'),
    );
  }
  if (current?.validation && current.startDate) {
    card.appendChild(mk('div', 'lms-hint', `起始日校验提醒：${current.validation}`));
  }

  const editing = mk('div', 'lms-term-start');
  const dateInput = mk('input');
  dateInput.type = 'date';
  dateInput.className = 'tt-term-start-input';
  dateInput.title = '该学期第一周的周一';
  dateInput.value = ttUi.startInput || current?.startDate || '';
  dateInput.disabled = !current || ttUi.startBusy;
  dateInput.addEventListener('change', () => {
    ttUi.startInput = dateInput.value;
  });
  const save = mk('button', 'primary-btn', ttUi.startBusy ? '保存中…' : '保存起始日');
  save.type = 'button';
  save.disabled = !current || ttUi.startBusy || !dateInput.value;
  save.addEventListener('click', () => {
    if (!dateInput.value) {
      ttUi.startError = '请选择起始日';
      ttPaint();
      return;
    }
    void ttSaveTermStart(dateInput.value);
  });
  editing.append(mk('span', 'lms-hint', '第一周周一：'), dateInput, save);
  card.appendChild(editing);

  if (ttUi.startError) card.appendChild(mk('div', 'lms-error', `保存起始日失败：${ttUi.startError}`));
  return card;
}

/** 课程列表 + 周课表网格。 */
function ttCoursesCard() {
  const card = mk('div', 'card');
  const head = mk('div', 'lms-head');
  head.appendChild(mk('div', 'card-title', '课表'));
  if (ttUi.courses?.count) head.appendChild(mk('span', 'lms-hint', `${ttUi.courses.count} 门课`));
  const scope = ttCurrentTerm();
  if (scope) head.appendChild(mk('span', 'lms-hint', `学期：${scope.label ?? ttTermLabel(scope.term)}`));
  head.appendChild(mk('div', 'spacer'));
  head.appendChild(
    lmsActionButton(ttUi.courses ? '重新拉取课表' : '拉取课表', '拉取中…', ttUi.coursesBusy || !ttUi.term, () =>
      void ttRefreshTimetable(),
    ),
  );
  card.appendChild(head);

  if (ttUi.coursesError) card.appendChild(mk('div', 'lms-error', `课表加载失败：${ttUi.coursesError}`));
  if (!ttUi.term) {
    card.appendChild(emptyBox('先选择学期，再拉取课表。'));
    return card;
  }

  const items = ttUi.courses?.items ?? [];
  if (ttUi.courses === null || (ttUi.coursesBusy && !items.length)) {
    card.appendChild(mk('div', 'loading', '加载中…'));
    return card;
  }
  if (!items.length) {
    card.appendChild(emptyBox('这个学期还没有课表缓存，点「拉取课表」从教务系统拉一次。'));
    return card;
  }

  const colorOf = ttColorAssigner();
  const list = mk('div', 'lms-list');
  for (const course of items) list.appendChild(ttCourseRow(course, colorOf(course.courseName)));
  card.appendChild(list);

  card.appendChild(ttWeekgrid(items, colorOf));

  if (ttUi.courses?.fetchedAt) {
    card.appendChild(mk('div', 'lms-hint', `课表更新于 ${lmsFormatStamp(ttUi.courses.fetchedAt)}`));
  }
  return card;
}

function ttCourseRow(course, color) {
  const row = mk('div', 'lms-row');
  const title = mk('div', 'lms-row-title');
  const dot = mk('span', 'tt-color-dot');
  dot.style.background = color;
  title.append(dot, mk('span', null, course.courseName ?? '（未命名课程）'));
  title.appendChild(mk('span', 'lms-pill', ttWeeksText(course.weeks)));
  row.appendChild(title);

  const slots = (course.slots ?? []).map((slot) => ttSlotText(slot.weekDay, slot.startPeriod, slot.endPeriod));
  row.appendChild(
    mk(
      'div',
      'lms-row-meta',
      [ttTeacherText(course), ttLocationText(course), slots.join(' / ')].filter(Boolean).join(' · '),
    ),
  );
  if (course.weeksText) row.appendChild(mk('div', 'lms-row-meta', `周次：${course.weeksText}`));
  return row;
}

/**
 * 周课表网格：周一~周日 × 1~11 节，单元格放课程名 + 教室。
 *
 * 窄栏（面板宽 < TT_GRID_MIN_WIDTH）时退化成按星期分组的列表：宁可少画，也不出横向滚动。
 */
function ttWeekgrid(courses, colorOf) {
  const wrap = mk('div', 'tt-grid-wrap');
  const narrow = ttUi.narrow === true;

  if (narrow) {
    const groups = new Map();
    for (const course of courses) {
      const days = new Set((course.slots ?? []).map((slot) => Number(slot.weekDay)));
      for (const day of days) {
        const list = groups.get(day) ?? [];
        list.push(course);
        groups.set(day, list);
      }
    }
    const list = mk('div', 'tt-grid-list');
    for (const day of [...groups.keys()].sort((a, b) => a - b)) {
      const block = mk('div', 'tt-grid-day');
      block.appendChild(mk('div', 'tt-grid-day-head', `周${TT_DAY_LABEL[day - 1] ?? day}`));
      for (const course of groups.get(day)) {
        const slot = (course.slots ?? [])
          .filter((item) => Number(item.weekDay) === day)
          .map((item) => (item.startPeriod === item.endPeriod ? `第${item.startPeriod}节` : `第${item.startPeriod}-${item.endPeriod}节`))
          .join('、');
        const cell = mk('div', 'tt-cell');
        cell.style.setProperty('--tt-color', colorOf(course.courseName));
        cell.append(
          mk('div', 'tt-cell-name', course.courseName ?? '（未命名课程）'),
          mk('div', 'tt-cell-meta', `${slot} · ${ttLocationText(course)}`),
        );
        block.appendChild(cell);
      }
      list.appendChild(block);
    }
    wrap.appendChild(list);
    return wrap;
  }

  const grid = mk('div', 'tt-grid');
  // 表头：左上角空格 + 周一~周日
  grid.appendChild(mk('div', 'tt-grid-corner'));
  for (const day of TT_DAY_LABEL) grid.appendChild(mk('div', 'tt-grid-head', `周${day}`));
  // 左侧节次栏
  for (const period of Array.from({ length: TT_PERIOD_COUNT }, (_, index) => index + 1)) {
    const block = TT_PERIOD_BLOCKS.find((item) => item.from === period);
    const label = mk('div', 'tt-grid-period', String(period));
    if (block) label.title = `${block.label}（第 ${block.from}-${block.to} 节）`;
    grid.appendChild(label);
  }
  // 课程单元格：同一门课同一时段只占一格
  for (const course of courses) {
    for (const slot of course.slots ?? []) {
      const day = Number(slot.weekDay);
      const from = Number(slot.startPeriod);
      const to = Math.max(from, Number(slot.endPeriod));
      if (!(day >= 1 && day <= 7) || !(from >= 1 && from <= TT_PERIOD_COUNT)) continue;
      const cell = mk('div', 'tt-cell');
      cell.style.gridColumn = String(day + 1);
      cell.style.gridRow = `${from + 1} / ${Math.min(to, TT_PERIOD_COUNT) + 2}`;
      cell.style.setProperty('--tt-color', colorOf(course.courseName));
      cell.title = `${course.courseName ?? ''} · ${ttSlotText(day, from, to)} · ${ttLocationText(course)}`;
      cell.append(
        mk('div', 'tt-cell-name', course.courseName ?? '（未命名课程）'),
        mk('div', 'tt-cell-meta', ttLocationText(course)),
      );
      grid.appendChild(cell);
    }
  }
  wrap.appendChild(grid);
  return wrap;
}

/** 同步卡片：选项 → 预览 → 勾选 → 应用。 */
function ttSyncCard(ready) {
  const card = mk('div', 'card');
  const head = mk('div', 'lms-head');
  head.appendChild(mk('div', 'card-title', '同步到日历'));
  head.appendChild(mk('div', 'spacer'));
  head.appendChild(mk('span', 'lms-hint', '先预览，勾选后再写入'));
  card.appendChild(head);

  card.appendChild(
    mk(
      'div',
      'lms-hint',
      '生成的是逐周日程：每条 = 某一天某一节课（externalId 以 tt: 开头）。重复同步只会更新这些记录，' +
        '不会新增重复项，也不会动你手动添加的日程。',
    ),
  );

  const checks = mk('div', 'lms-checks');
  const optionRow = (key, label, hint) => {
    const wrap = mk('label', 'check-field');
    const input = mk('input');
    input.type = 'checkbox';
    input.checked = Boolean(ttUi.options[key]);
    input.addEventListener('change', () => {
      ttUi.options[key] = input.checked;
    });
    wrap.append(input, mk('span', null, hint ? `${label}（${hint}）` : label));
    checks.appendChild(wrap);
  };
  optionRow('includePast', '包含已过去的周次');
  optionRow('compact', '折叠为重复日程', '可能因作息切换而不折叠');
  card.appendChild(checks);

  const startReady = ttStartReady();
  const blocked = !ready || !ttUi.term || !startReady;

  const actions = mk('div', 'lms-actions');
  const preview = mk('button', 'primary-btn', ttUi.previewBusy ? '预览中…' : '预览同步');
  preview.type = 'button';
  preview.disabled = blocked || ttUi.previewBusy;
  preview.addEventListener('click', () => void ttPreviewSync());
  actions.appendChild(preview);
  if (!ready) actions.appendChild(mk('span', 'lms-hint', '登录后才能预览与同步'));
  else if (!startReady) actions.appendChild(mk('span', 'lms-hint', '需要先设置学期起始日'));
  card.appendChild(actions);

  if (ttUi.previewError) card.appendChild(mk('div', 'lms-error', `预览失败：${ttUi.previewError}`));

  if (ttUi.preview) {
    const summary = ttUi.preview.summary;
    const sum = mk('div', 'lms-summary');
    for (const [key, label] of [
      ['create', '新建'],
      ['update', '更新'],
      ['skip', '跳过'],
      ['stale', '失效'],
    ]) {
      sum.appendChild(statPill(label, summary?.[key] ?? 0));
    }
    sum.appendChild(mk('span', 'lms-hint', `共 ${summary?.total ?? (ttUi.preview.items ?? []).length} 条`));
    if (ttUi.preview.termStart) {
      sum.appendChild(mk('span', 'lms-hint', `起始日 ${ttUi.preview.termStart}（${ttSourceTag(ttUi.preview.startDateSource)}）`));
    }
    card.appendChild(sum);

    const list = mk('div', 'lms-sync-list');
    const items = ttUi.preview.items ?? [];
    if (!items.length) list.appendChild(emptyBox('没有需要同步的条目。'));
    for (const item of items) list.appendChild(ttSyncRow(item));
    card.appendChild(list);

    const foot = mk('div', 'lms-actions');
    const all = mk('button', 'ghost-btn', '全选');
    all.type = 'button';
    const none = mk('button', 'ghost-btn', '全不选');
    none.type = 'button';
    all.addEventListener('click', () => ttSelectAll(true));
    none.addEventListener('click', () => ttSelectAll(false));
    const count = mk('span', 'lms-hint', `已选 ${ttUi.selected.size} 条`);
    const apply = mk('button', 'primary-btn', ttUi.applyBusy ? '同步中…' : `同步选中 ${ttUi.selected.size} 条`);
    apply.type = 'button';
    apply.disabled = ttUi.applyBusy || ttUi.selected.size === 0;
    apply.addEventListener('click', () => void ttApplySync());
    ttUi.refs.syncCount = count;
    ttUi.refs.syncButton = apply;
    foot.append(all, none, mk('div', 'spacer'), count, apply);
    card.appendChild(foot);
  }

  if (ttUi.applyError) card.appendChild(mk('div', 'lms-error', `同步失败：${ttUi.applyError}`));
  if (ttUi.applyResult) card.appendChild(ttApplyResultBox(ttUi.applyResult));
  return card;
}

function ttSyncRow(item) {
  const row = mk('label', 'lms-sync-row');
  const box = mk('input');
  box.type = 'checkbox';
  box.checked = ttUi.selected.has(item.key);
  box.disabled = item.action === 'stale';
  box.addEventListener('change', () => {
    if (box.checked) ttUi.selected.add(item.key);
    else ttUi.selected.delete(item.key);
    ttUpdateSyncFoot();
  });
  ttUi.refs.syncBoxes.push({ input: box, key: item.key });

  const main = mk('div', 'lms-sync-main');
  const title = mk('div', 'lms-row-title');
  title.append(
    mk('span', `lms-badge ${item.action ?? ''}`.trim(), TT_ACTION_LABEL[item.action] ?? item.action ?? '条目'),
    mk('span', null, item.title ?? item.courseName ?? item.key),
  );
  main.appendChild(title);

  const when = [item.date, item.startTime && `${item.startTime}${item.endTime ? `–${item.endTime}` : ''}`]
    .filter(Boolean)
    .join(' ');
  const meta = [item.courseName, ttTeacherText(item), ttLocationText(item), item.week ? `第 ${item.week} 周` : null]
    .filter(Boolean)
    .join(' · ');
  if (meta) main.appendChild(mk('div', 'lms-row-meta', meta));
  if (when) main.appendChild(mk('div', 'lms-row-meta', when));

  const detail = item.action === 'update' && item.changes?.length ? `变更：${item.changes.join('、')}` : item.reason;
  if (detail) main.appendChild(mk('div', 'lms-row-meta', detail));

  row.append(box, main);
  return row;
}

/** 只更新页脚计数与按钮文案，避免整表重画（与 lmsUpdateSyncFoot 同款）。 */
function ttUpdateSyncFoot() {
  const { syncCount, syncButton } = ttUi.refs;
  if (syncCount) syncCount.textContent = `已选 ${ttUi.selected.size} 条`;
  if (syncButton) {
    syncButton.textContent = `同步选中 ${ttUi.selected.size} 条`;
    syncButton.disabled = ttUi.applyBusy || ttUi.selected.size === 0;
  }
}

function ttSelectAll(checked) {
  ttUi.selected = new Set(checked ? (ttUi.preview?.items ?? []).map((item) => item.key) : []);
  for (const { input, key } of ttUi.refs.syncBoxes) input.checked = ttUi.selected.has(key);
  ttUpdateSyncFoot();
}

/** 整体重画：所有文本都经 textContent 写入（等价于 escapeHtml），不使用 innerHTML 拼接。 */
function ttPaint() {
  const mount = ttUi.mount;
  if (!mount) return;
  mount.innerHTML = '';
  ttUi.refs = { syncCount: null, syncButton: null, syncBoxes: [] };

  const bar = mk('div', 'toolbar');
  bar.appendChild(mk('div', 'toolbar-title', '教务课表'));
  bar.appendChild(mk('div', 'spacer'));
  const reload = mk('button', 'ghost-btn', ttUi.statusLoading ? '刷新中…' : '刷新状态');
  reload.type = 'button';
  reload.disabled = ttUi.statusLoading;
  reload.addEventListener('click', () => void ttLoadStatus({ manual: true }));
  bar.appendChild(reload);
  mount.appendChild(bar);

  const content = mk('div', 'view-content');
  mount.appendChild(content);

  const ready = ttUi.status?.status === 'ready';
  content.appendChild(ttStatusCard());
  if (ttUi.status && !ready) content.appendChild(ttUi.status.status === 'need_mfa' ? ttAuth.mfaCard() : ttAuth.loginCard());
  if (ready) {
    content.appendChild(ttTermsCard());
    content.appendChild(ttCoursesCard());
  }
  if (ttUi.status) content.appendChild(ttSyncCard(ready));

  ttMaybeLoad();
}

/* --------------------------------------------------------------- 同步 */

/**
 * 预览同步。
 *
 * @param {object} [opts] { courseId } 指定课程时只预览这门课（详情页的「同步本课程」）。
 * 预览范围记在 lmsUi.previewCourseId，apply 沿用同一范围，保证「所见即所写」。
 */
async function lmsPreviewSync(opts = {}) {
  if (lmsUi.previewBusy) return;
  lmsUi.previewCourseId = opts.courseId === undefined ? null : opts.courseId;
  lmsUi.previewBusy = true;
  lmsUi.previewError = null;
  lmsUi.applyResult = null;
  lmsUi.applyError = null;
  lmsPaint();
  try {
    const data = await PC.api('/lms/sync/preview', { method: 'POST', body: lmsSyncBody({}) });
    lmsUi.preview = data;
    // 默认只勾选会真正写库的条目，跳过/失效交给用户自己决定
    lmsUi.selected = new Set(
      (data.items ?? []).filter((item) => item.action === 'create' || item.action === 'update').map((item) => item.key),
    );
  } catch (error) {
    lmsUi.previewError = error.message;
    lmsUi.preview = null;
    lmsUi.selected = new Set();
    lmsCheckAuthLost(error);
  } finally {
    lmsUi.previewBusy = false;
    lmsPaint();
  }
}

async function lmsApplySync() {
  if (lmsUi.applyBusy) return;
  const keys = [...lmsUi.selected];
  if (!keys.length) {
    lmsUi.applyError = '请先勾选要同步的条目';
    lmsPaint();
    return;
  }
  lmsUi.applyBusy = true;
  lmsUi.applyError = null;
  lmsPaint();
  try {
    const result = await PC.api('/lms/sync/apply', { method: 'POST', body: lmsSyncBody({ keys }) });
    lmsUi.applyResult = result;
    lmsUi.preview = null; // 落库后旧的预览已经过期，清掉避免误点
    lmsUi.selected = new Set();
    PC.toast(`同步完成：新建 ${result.created ?? 0} · 更新 ${result.updated ?? 0}`);
    try {
      lmsUi.status = await PC.api('/lms/status'); // 刷新已同步条数 / 上次同步时间
    } catch {
      /* 状态刷新失败不影响同步结果展示 */
    }
  } catch (error) {
    lmsUi.applyError = error.message;
    lmsCheckAuthLost(error);
  } finally {
    lmsUi.applyBusy = false;
    lmsPaint();
  }
}

function lmsSelectAll(checked) {
  lmsUi.selected = new Set();
  if (checked) for (const item of lmsUi.preview?.items ?? []) lmsUi.selected.add(item.key);
  for (const { input, key } of lmsUi.refs.syncBoxes) input.checked = lmsUi.selected.has(key);
  lmsUpdateSyncFoot();
}

/** 只原地更新「已选 N 条 / 同步选中 N 条」，避免勾选时重画导致列表滚动位置丢失。 */
function lmsUpdateSyncFoot() {
  const count = lmsUi.selected.size;
  const { syncButton, syncCount } = lmsUi.refs;
  if (syncCount && syncCount.isConnected) syncCount.textContent = `已选 ${count} 条`;
  if (syncButton && syncButton.isConnected) {
    syncButton.textContent = lmsUi.applyBusy ? '同步中…' : `同步选中 ${count} 条`;
    syncButton.disabled = lmsUi.applyBusy || count === 0;
  }
}

/** 后端现在保证每条预览条目都带 kind（skip/stale 的 payload 为 null），这里再留一层兜底。 */
function lmsItemKind(item) {
  if (item.kind === 'event') return '日历事件';
  if (item.kind === 'schedule') return '日程';
  if (item.payload?.startDate !== undefined) return '日历事件';
  if (item.payload?.date) return '日程';
  return null;
}

function lmsItemWhen(item) {
  const payload = item.payload;
  if (payload) {
    if (payload.date) {
      const time = payload.allDay ? '全天' : `${payload.startTime ?? ''}${payload.endTime ? `–${payload.endTime}` : ''}`;
      return `${payload.date} ${time}`.trim();
    }
    if (payload.startDate) {
      const same = !payload.endDate || payload.endDate === payload.startDate;
      return `${payload.startDate}${same ? '' : ` ~ ${payload.endDate}`} 全天`;
    }
  }
  const start = lmsFormatTime(item.startTime);
  const end = lmsFormatTime(item.endTime);
  if (start || end) return [start, end].filter(Boolean).join(' → ');
  return '';
}

function lmsSyncRow(item) {
  const row = mk('label', 'lms-sync-row');
  const box = mk('input');
  box.type = 'checkbox';
  box.checked = lmsUi.selected.has(item.key);
  box.addEventListener('change', () => {
    if (box.checked) lmsUi.selected.add(item.key);
    else lmsUi.selected.delete(item.key);
    lmsUpdateSyncFoot();
  });
  lmsUi.refs.syncBoxes.push({ input: box, key: item.key });

  const main = mk('div', 'lms-sync-main');
  const title = mk('div', 'lms-row-title');
  title.append(
    mk('span', `lms-badge ${item.action ?? ''}`.trim(), LMS_ACTION_LABEL[item.action] ?? item.action ?? '条目'),
    mk('span', null, item.title ?? item.key),
  );
  main.appendChild(title);

  const meta = [
    item.courseName,
    item.typeLabel ?? (item.type ? LMS_ACTIVITY_LABEL[item.type] ?? item.type : null),
    lmsItemKind(item),
    item.submitted ? '已提交' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (meta) main.appendChild(mk('div', 'lms-row-meta', meta));

  const when = lmsItemWhen(item);
  if (when) main.appendChild(mk('div', 'lms-row-meta', when));

  const detail = item.action === 'update' && item.changes?.length ? `变更：${item.changes.join('、')}` : item.reason;
  if (detail) main.appendChild(mk('div', 'lms-row-meta', detail));

  row.append(box, main);
  return row;
}

/* --------------------------------------------------------------- 卡片 */

/* ------------------------------------------- 工具条：状态 strip + 同步抽屉 */

/**
 * 顶部状态 strip（替换原来的「账号状态」整张卡）。
 *
 * 一级页面只保留：工具条 → 登录卡 → 课程网格 → 作业列表。
 * 登录状态 / 账号 / 上次同步都收进这个 pill，点开才展开一行详情（退出登录、刷新状态也在里面）。
 */
function lmsStatusStrip() {
  const status = lmsUi.status;
  const strip = mk('div', 'lms-status-strip');

  const pill = mk('button', 'lms-status-toggle');
  pill.type = 'button';
  pill.appendChild(lmsStatusPill(status?.status));
  pill.appendChild(mk('span', 'lms-hint', lmsUi.statusOpen ? '收起' : '详情'));
  pill.setAttribute('aria-expanded', String(Boolean(lmsUi.statusOpen)));
  pill.addEventListener('click', () => {
    lmsUi.statusOpen = !lmsUi.statusOpen;
    const next = lmsUi.statusOpen;
    detail.classList.toggle('hidden', !next);
    pill.lastChild.textContent = next ? '收起' : '详情';
    pill.setAttribute('aria-expanded', String(next));
  });
  strip.appendChild(pill);

  const detail = mk('div', `lms-status-detail${lmsUi.statusOpen ? '' : ' hidden'}`);
  const meta = status
    ? `${lmsUserText(status)} · 上次同步 ${status.lastSyncAt ? lmsFormatStamp(status.lastSyncAt) : '尚未同步'}` +
      ` · 已同步日程 ${status.synced?.schedules ?? 0} 条`
    : lmsUi.statusLoading
      ? '状态读取中…'
      : '状态未知';
  detail.appendChild(mk('span', 'lms-hint', meta));

  const refresh = mk('button', 'ghost-btn', lmsUi.statusLoading ? '刷新中…' : '刷新状态');
  refresh.type = 'button';
  refresh.disabled = lmsUi.statusLoading;
  refresh.addEventListener('click', () => void lmsLoadStatus({ manual: true }));
  detail.appendChild(refresh);

  if (status && status.status !== 'anonymous') {
    const out = mk('button', 'ghost-btn', '退出登录');
    out.type = 'button';
    out.addEventListener('click', () => void lmsLogout());
    detail.appendChild(out);
  }
  if (status && status.status !== 'anonymous') detail.appendChild(lmsSettingsDetails(status));
  if (lmsUi.statusError) detail.appendChild(mk('span', 'lms-error', `状态读取失败：${lmsUi.statusError}`));
  if (status?.error) detail.appendChild(mk('span', 'lms-error', `最近错误：${status.error}`));

  strip.appendChild(detail);
  return strip;
}

/** 自动同步设置：折叠进 status strip 的「设置」，不再占列表页高度。 */
function lmsSettingsDetails(status) {
  const details = mk('details', 'lms-settings');
  details.appendChild(mk('summary', null, '设置（自动同步）'));
  details.appendChild(lmsAutoSyncRow(status));
  return details;
}

/**
 * 自动同步设置行（POST /lms/settings）。
 *
 * 未登录时置灰而不是隐藏：设置本身是持久的，置灰能让用户知道它在哪、为什么不能用。
 * 任何一次改动都把 autoSync 与 autoSyncIntervalHours 一起提交；成功后用返回的 status 刷新。
 */
function lmsAutoSyncRow(status) {
  const autoSync = status?.autoSync ?? {};
  const ready = status?.status === 'ready';
  const disabled = !ready || lmsUi.autoSyncBusy;

  const box = mk('div', 'lms-autosync');
  const toggleLabel = mk('label', 'check-field');
  const toggle = mk('input', 'lms-autosync-toggle');
  toggle.type = 'checkbox';
  toggle.checked = Boolean(autoSync.enabled);
  toggle.disabled = disabled;
  toggleLabel.append(toggle, mk('span', null, '自动同步'));

  const hoursWrap = mk('span', 'lms-hours');
  const hours = mk('input', 'lms-autosync-hours');
  hours.type = 'number';
  hours.min = '1';
  hours.max = '168';
  hours.step = '1';
  hours.title = '自动同步间隔（1~168 小时）';
  hours.value = String(Number(autoSync.intervalHours) > 0 ? Number(autoSync.intervalHours) : 6);
  hours.disabled = disabled;
  hoursWrap.append(hours, mk('span', 'lms-hint', '小时'));

  box.append(
    toggleLabel,
    hoursWrap,
    mk('span', 'lms-hint', `最近自动同步：${autoSync.lastRunAt ? lmsFormatStamp(autoSync.lastRunAt) : '尚未执行'}`),
    mk('span', 'lms-hint', ready ? '改动即时生效 · 默认关闭' : '登录后可用 · 默认关闭'),
  );
  lmsUi.refs.autoSync = { toggle, hours };

  const apply = () => {
    if (disabled) return;
    const raw = Number(hours.value);
    if (!Number.isFinite(raw) || raw < 1 || raw > 168) {
      lmsUi.autoSyncError = '自动同步间隔需为 1~168 小时';
      lmsPaint();
      return;
    }
    void lmsSaveAutoSync(toggle.checked, raw);
  };
  toggle.addEventListener('change', apply);
  hours.addEventListener('change', apply);

  const wrap = mk('div', 'lms-autosync-block');
  wrap.appendChild(box);
  wrap.appendChild(mk('div', 'lms-hint', '自动同步只新建与更新记录，不会删除任何日程（默认关闭）。'));
  if (lmsUi.autoSyncError) wrap.appendChild(mk('div', 'lms-error', `自动同步设置失败：${lmsUi.autoSyncError}`));
  return wrap;
}

/* --------------------------------------------------- 第一层：课程网格 / 作业 */

/** 卡片标题旁的学期范围提示（「全部学期」时不显示，省掉噪音）。 */
function lmsScopeHint() {
  const item = lmsCurrentSemester();
  return item ? mk('span', 'lms-hint', `学期：${item.label ?? '未标注学期'}`) : null;
}

/**
 * 课程网格（第一层）：每张卡 = 课程名 + 课程号 + 教师 + 学分 + 学期 + 教学班 + 活动摘要。
 * 整卡可点，进入课程详情（第二层）。活动摘要是从已缓存的活动里按 courseId 现算的，零额外请求。
 */
function lmsCoursesCard() {
  const card = mk('div', 'card');
  const head = mk('div', 'lms-head');
  head.appendChild(mk('div', 'card-title', '课程'));
  if (lmsUi.courses?.count) head.appendChild(mk('span', 'lms-hint', `${lmsUi.courses.count} 门`));
  const courseScope = lmsScopeHint();
  if (courseScope) head.appendChild(courseScope);
  head.appendChild(mk('div', 'spacer'));
  head.appendChild(lmsActionButton('刷新课程', '刷新中…', lmsUi.coursesBusy, () => void lmsLoadCourses(true)));
  card.appendChild(head);

  if (lmsUi.coursesError) card.appendChild(mk('div', 'lms-error', `课程加载失败：${lmsUi.coursesError}`));
  if (lmsUi.activitiesError) card.appendChild(mk('div', 'lms-error', `活动加载失败：${lmsUi.activitiesError}`));

  const items = lmsUi.courses?.items ?? [];
  if (lmsUi.courses === null || (lmsUi.coursesBusy && !items.length)) {
    card.appendChild(mk('div', 'loading', '加载中…'));
    return card;
  }
  if (!items.length) {
    // 选了学期时的空结果不是「没缓存」，给更准确的文案（见需求：不要显示成加载失败）
    card.appendChild(
      emptyBox(lmsUi.semesterId === null ? '还没有课程缓存，点「刷新课程」从思源学堂拉取。' : '该学期没有课程。'),
    );
    return card;
  }

  const grid = mk('div', 'lms-course-grid');
  for (const course of items) grid.appendChild(lmsCourseCard(course));
  card.appendChild(grid);
  if (lmsUi.courses?.fetchedAt) {
    card.appendChild(mk('div', 'lms-hint', `更新于 ${lmsFormatStamp(lmsUi.courses.fetchedAt)}`));
  }
  return card;
}

function lmsCourseCard(course) {
  const card = mk('button', 'lms-course-card');
  card.type = 'button';
  card.title = `查看 ${course.name ?? '课程'} 详情`;

  const title = mk('div', 'lms-course-title');
  title.appendChild(mk('span', null, course.name ?? '（未命名课程）'));
  card.appendChild(title);

  const teachers = (course.instructors ?? []).map((item) => item?.name).filter(Boolean).join('、');
  const semester = course.semester?.realName || course.semester?.name || course.semester?.label;
  const klass = course.teachingClassName || course.klass;
  for (const text of [
    [course.courseCode ? `课程号 ${course.courseCode}` : null, teachers ? `教师 ${teachers}` : null].filter(Boolean).join(' · '),
    [course.credit ? `${course.credit} 学分` : null, semester ? `学期 ${semester}` : null].filter(Boolean).join(' · '),
    klass ? `教学班 ${klass}` : null,
  ]) {
    if (text) card.appendChild(mk('div', 'lms-course-meta', text));
  }

  const counts = lmsCourseCounts(course.id);
  const summary = mk('div', 'lms-course-counts');
  for (const [key, label] of [
    ['homework', '作业'],
    ['lecture_live', '直播'],
    ['lesson', '回放'],
    ['material', '资料'],
  ]) {
    summary.appendChild(mk('span', 'stat-pill', `${label} ${counts[key]}`));
  }
  card.appendChild(summary);

  card.addEventListener('click', () => lmsOpenCourse(course.id));
  return card;
}

/**
 * 作业卡片（第一层）：聚合本学期全部课程的作业类活动，按截止时间升序。
 *
 * 只在前端按类型白名单过滤（缓存里已经有该学期全部活动），点一行就地展开详情。
 */
function lmsHomeworkCard() {
  const card = mk('div', 'card');
  const head = mk('div', 'lms-head');
  head.appendChild(mk('div', 'card-title', '作业'));
  const items = lmsHomeworkItems();
  head.appendChild(mk('span', 'lms-hint', `${items.length} 条`));
  head.appendChild(mk('div', 'spacer'));
  head.appendChild(lmsActionButton('刷新作业', '刷新中…', lmsUi.activitiesBusy, () => void lmsLoadActivities(true)));
  card.appendChild(head);

  if (lmsUi.activitiesError) card.appendChild(mk('div', 'lms-error', `作业加载失败：${lmsUi.activitiesError}`));

  if (lmsUi.activities === null || (lmsUi.activitiesBusy && !(lmsUi.activities?.items ?? []).length)) {
    card.appendChild(mk('div', 'loading', '加载中…'));
    return card;
  }
  if (!items.length) {
    const any = (lmsUi.activities?.items ?? []).length > 0;
    card.appendChild(
      emptyBox(
        any
          ? '当前学期没有需要提交的作业或测验。'
          : lmsUi.semesterId === null
            ? '还没有活动缓存，点「刷新作业」拉取。'
            : '该学期没有活动。',
      ),
    );
    return card;
  }

  const list = mk('div', 'lms-activity-list');
  for (const item of items) list.appendChild(lmsActivityRow(item, { course: true, submit: true }));
  card.appendChild(list);
  if (lmsUi.activities?.fetchedAt) {
    card.appendChild(mk('div', 'lms-hint', `更新于 ${lmsFormatStamp(lmsUi.activities.fetchedAt)}`));
  }
  return card;
}

/* --------------------------------------------------- 第二层：课程详情页 */

function lmsOpenCourse(courseId) {
  lmsUi.detailCourseId = courseId;
  lmsUi.detailType = '';
  lmsUi.expandedActivityId = null;
  lmsPaint();
}

function lmsBackToCourses() {
  lmsUi.detailCourseId = null;
  lmsUi.expandedActivityId = null;
  lmsPaint();
}

/** 课程详情页当前分组的活动（仍只在前端过滤，切 Tab 零请求）。 */
function lmsDetailItems(courseId) {
  return (lmsUi.activities?.items ?? []).filter(
    (item) =>
      String(item.courseId) === String(courseId) && (!lmsUi.detailType || item.type === lmsUi.detailType),
  );
}

function lmsCourseDetailPage() {
  const courseId = lmsUi.detailCourseId;
  const course = (lmsUi.courses?.items ?? []).find((item) => String(item.id) === String(courseId)) ?? null;
  const wrap = mk('div', 'lms-detail');

  const head = mk('div', 'lms-detail-head');
  const back = mk('button', 'ghost-btn', '← 返回课程');
  back.type = 'button';
  back.addEventListener('click', () => lmsBackToCourses());
  head.appendChild(back);
  head.appendChild(mk('div', 'lms-detail-name', course?.name ?? `课程 ${courseId}`));
  head.appendChild(mk('div', 'spacer'));
  if (course?.courseCode) head.appendChild(mk('span', 'tag', course.courseCode));
  if (course?.compulsory === true) head.appendChild(mk('span', 'tag', '必修'));
  else if (course?.compulsory === false) head.appendChild(mk('span', 'tag', '选修'));
  wrap.appendChild(head);

  wrap.appendChild(lmsCourseInfoCard(course, courseId));
  wrap.appendChild(lmsCourseActivitiesCard(courseId));
  return wrap;
}

/** 课程基础信息卡（沿用 .kv 样式）。 */
function lmsCourseInfoCard(course, courseId) {
  const card = mk('div', 'card');
  const head = mk('div', 'lms-head');
  head.appendChild(mk('div', 'card-title', '基础信息'));
  head.appendChild(mk('div', 'spacer'));
  // 本课程同步入口：只作用于这门课（courseIds）
  const sync = mk('button', 'primary-btn', '同步本课程');
  sync.type = 'button';
  sync.disabled = lmsUi.status?.status !== 'ready';
  sync.addEventListener('click', () => void lmsPreviewSync({ courseId }));
  head.appendChild(sync);
  card.appendChild(head);

  const body = mk('div', 'card-body');
  const kv = (key, value) => {
    const row = mk('div', 'kv');
    row.append(mk('span', 'kv-key', key), mk('span', 'kv-val', value ?? '—'));
    body.appendChild(row);
  };
  const teachers = (course?.instructors ?? []).map((item) => item?.name).filter(Boolean).join('、');
  const semester = course?.semester?.realName || course?.semester?.name || course?.semester?.label;
  const klass = course?.teachingClassName || course?.klass;
  kv('课程名', course?.name ?? '（未命名课程）');
  kv('课程号', course?.courseCode ?? '—');
  kv('教师', teachers || '—');
  kv('学分', course?.credit ? `${course.credit}` : '—');
  // compulsory === null 时不臆造「必修 / 选修」
  if (course?.compulsory === true) kv('类型', '必修');
  else if (course?.compulsory === false) kv('类型', '选修');
  kv('教学班', klass ?? '—');
  kv('学期', semester ?? '—');
  kv('起止日期', course?.startDate || course?.endDate ? `${course?.startDate ?? '?'} ~ ${course?.endDate ?? '?'}` : '—');
  kv('学生数', course?.studentCount ?? course?.studentsCount ?? '—');
  kv('课程 ID', String(courseId));
  card.appendChild(body);

  card.appendChild(
    mk(
      'div',
      'lms-hint',
      '「同步本课程」只新建 / 更新这门课的记录（不会删除，也不会动你手动添加的日程）；' +
        '整学期的同步在工具条的「同步…」里。',
    ),
  );
  return card;
}

/** 课程内的活动列表：作业 / 直播 / 回放 / 资料 / 全部。 */
function lmsCourseActivitiesCard(courseId) {
  const card = mk('div', 'card');
  const items = lmsDetailItems(courseId);

  const head = mk('div', 'lms-head');
  head.appendChild(mk('div', 'card-title', '活动'));
  head.appendChild(mk('span', 'lms-hint', `${items.length} 条`));
  head.appendChild(mk('div', 'spacer'));
  head.appendChild(lmsActionButton('刷新活动', '刷新中…', lmsUi.activitiesBusy, () => void lmsLoadActivities(true)));
  card.appendChild(head);

  const filters = mk('div', 'lms-filters');
  const seg = mk('div', 'seg');
  for (const [value, label] of LMS_DETAIL_TABS) {
    const button = mk('button', `seg-btn${lmsUi.detailType === value ? ' active' : ''}`, label);
    button.type = 'button';
    button.addEventListener('click', () => {
      if (lmsUi.detailType === value) return;
      lmsUi.detailType = value;
      lmsUi.expandedActivityId = null;
      lmsPaint();
    });
    seg.appendChild(button);
  }
  filters.appendChild(seg);
  card.appendChild(filters);

  if (lmsUi.activitiesError) card.appendChild(mk('div', 'lms-error', `活动加载失败：${lmsUi.activitiesError}`));
  if (lmsUi.activities === null || (lmsUi.activitiesBusy && !(lmsUi.activities?.items ?? []).length)) {
    card.appendChild(mk('div', 'loading', '加载中…'));
    return card;
  }
  if (!items.length) {
    const label = LMS_ACTIVITY_LABEL[lmsUi.detailType] ?? '活动';
    card.appendChild(
      emptyBox(
        lmsUi.detailType === 'homework'
          ? '这门课没有作业。'
          : lmsUi.detailType === 'lesson'
            ? '这门课暂无回放。'
            : lmsUi.detailType === 'lecture_live'
              ? '这门课暂无直播。'
              : `这门课暂无${label}。`,
      ),
    );
    return card;
  }

  const list = mk('div', 'lms-activity-list');
  for (const item of items) list.appendChild(lmsActivityRow(item, { expandable: true, type: true }));
  card.appendChild(list);
  return card;
}

/* --------------------------------------------- 活动行：就地展开详情（手风琴） */

/**
 * 活动行。
 *
 * @param {object} item 活动
 * @param {object} [opts] { expandable: 可点开详情；course: 显示课程名；submit: 显示提交状态；type: 显示类型标签 }
 */
function lmsActivityRow(item, opts = {}) {
  const expanded = Boolean(opts.expandable) && String(lmsUi.expandedActivityId) === String(item.id);
  const wrap = mk('div', `lms-activity${expanded ? ' open' : ''}`);
  const head = mk(opts.expandable ? 'button' : 'div', 'lms-activity-head');
  if (opts.expandable) {
    head.type = 'button';
    head.setAttribute('aria-expanded', String(expanded));
  }

  head.appendChild(mk('span', 'lms-activity-title', item.title ?? '（无标题）'));
  if (opts.type !== false) head.appendChild(mk('span', 'tag', LMS_ACTIVITY_LABEL[item.type] ?? item.type ?? '活动'));
  if (opts.submit) head.appendChild(lmsSubmitTag(item));
  if (item.published === false) head.appendChild(mk('span', 'tag late', '未发布'));
  const when = lmsFormatTime(item.endTime || item.startTime);
  if (when) head.appendChild(mk('span', 'lms-activity-time', `截止 ${when}`));
  wrap.appendChild(head);

  if (opts.course && item.courseName) wrap.appendChild(mk('div', 'lms-course-meta', item.courseName));

  if (opts.expandable) {
    head.addEventListener('click', () => lmsToggleActivity(item.id));
    if (expanded) wrap.appendChild(lmsActivityBody(item));
  }
  return wrap;
}

function lmsToggleActivity(activityId) {
  const same = String(lmsUi.expandedActivityId) === String(activityId);
  lmsUi.expandedActivityId = same ? null : activityId; // 手风琴：一次只展开一条
  lmsPaint();
  if (!same) void lmsLoadActivityDetail(activityId);
}

/**
 * 活动详情（GET /lms/activities/:id）：结果缓存在 lmsUi.activityDetails，同一课程内再次展开不重复请求。
 * description 是 HTML：先转纯文本再 escapeHtml，绝不直接塞 innerHTML。
 */
function lmsActivityBody(item) {
  const body = mk('div', 'lms-activity-body');
  const key = String(item.id);
  const busy = lmsUi.activityDetailBusy.has(key);
  const error = lmsUi.activityDetailError.get(key);
  const detail = lmsUi.activityDetails.get(key);

  if (error) body.appendChild(mk('div', 'lms-error', `详情加载失败：${error}`));
  if (busy && !detail) body.appendChild(mk('div', 'loading', '详情加载中…'));

  const source = detail ?? item;
  const time = mk('div', 'lms-row-meta');
  const start = lmsFormatTime(source.startTime);
  const end = lmsFormatTime(source.endTime);
  time.textContent = start || end ? `开始 ${start || '—'} · 截止 ${end || '—'}` : '无时间信息';
  body.appendChild(time);

  if (detail) {
    const text = lmsPlainText(detail.description);
    if (text) {
      const desc = mk('div', 'lms-desc');
      desc.textContent = text;
      body.appendChild(desc);
    }

    const uploads = detail.uploads ?? [];
    if (uploads.length) {
      const box = mk('div', 'lms-uploads');
      box.appendChild(mk('div', 'lms-hint', `附件 ${uploads.length} 个`));
      for (const file of uploads) {
        const size = lmsFileSize(file?.size);
        box.appendChild(mk('div', null, `${file?.name ?? '（未命名附件）'}${size ? ` · ${size}` : ''}`));
      }
      body.appendChild(box);
    }

    const score = mk('div', 'lms-score');
    for (const [label, value] of [
      ['平均分', detail.averageScore],
      ['最高分', detail.highestScore],
      ['最低分', detail.lowestScore],
    ]) {
      if (value !== null && value !== undefined && value !== '') score.appendChild(mk('span', null, `${label} ${value}`));
    }
    if (detail.userSubmitCount !== null && detail.userSubmitCount !== undefined) {
      score.appendChild(mk('span', null, `已提交 ${detail.userSubmitCount} 次`));
    }
    if (score.childNodes.length) body.appendChild(score);
    if (detail.lessonStart || detail.lessonEnd) {
      body.appendChild(
        mk('div', 'lms-row-meta', `回放时间 ${lmsFormatTime(detail.lessonStart) || '—'} ~ ${lmsFormatTime(detail.lessonEnd) || '—'}`),
      );
    }
  }
  return body;
}

async function lmsLoadActivityDetail(activityId) {
  const key = String(activityId);
  if (lmsUi.activityDetails.has(key) || lmsUi.activityDetailBusy.has(key)) return;
  lmsUi.activityDetailBusy.add(key);
  lmsUi.activityDetailError.delete(key);
  lmsPaint();
  try {
    const data = await PC.api(`/lms/activities/${encodeURIComponent(key)}`);
    lmsUi.activityDetails.set(key, data.item ?? data);
  } catch (error) {
    lmsUi.activityDetailError.set(key, error.message);
    lmsCheckAuthLost(error);
  } finally {
    lmsUi.activityDetailBusy.delete(key);
    // 用户可能已经收起 / 切走，只在仍然展开着这一条时重画
    if (String(lmsUi.expandedActivityId) === key) lmsPaint();
  }
}

/* --------------------------------------------------- 同步抽屉（默认收起） */

/** 「同步整个学期…」抽屉：原来的 5 个选项 + 预览 + 勾选 + 应用，只是搬进 details。 */
function lmsSyncDrawer(ready) {
  const details = mk('details', 'lms-drawer');
  if (lmsUi.syncOpen) details.open = true;
  const summary = mk('summary', null, '同步整个学期…');
  details.appendChild(summary);
  details.addEventListener('toggle', () => {
    lmsUi.syncOpen = details.open;
  });
  const body = mk('div', 'lms-drawer-body');
  body.appendChild(lmsSyncCard(ready));
  details.appendChild(body);
  return details;
}

function lmsSyncCard(ready) {
  const card = mk('div', 'lms-sync-body');
  card.appendChild(mk('div', 'lms-hint', '先预览，勾选后再写入；只新建 / 更新 tt: 之外的学堂记录，不会动你手动添加的日程。'));

  const checks = mk('div', 'lms-checks');
  const optionRow = (key, label, hint) => {
    const wrap = mk('label', 'check-field');
    const input = mk('input');
    input.type = 'checkbox';
    input.checked = Boolean(lmsUi.options[key]);
    input.addEventListener('change', () => {
      lmsUi.options[key] = input.checked;
    });
    wrap.append(input, mk('span', null, hint ? `${label}（${hint}）` : label));
    checks.appendChild(wrap);
  };
  optionRow('includePast', '包含过期内容');
  optionRow('includeSubmitted', '包含已提交作业', '默认不导入');
  optionRow('includeLesson', '导入课程回放');
  optionRow('includeCourseRange', '整学期课程做成日历事件', '整段日期内都会显示');
  optionRow('pruneStale', '同步时清理失效记录', '删除学堂已下架的条目');
  card.appendChild(checks);

  const scope = lmsUi.previewCourseId
    ? `（本课程：${(lmsUi.courses?.items ?? []).find((item) => String(item.id) === String(lmsUi.previewCourseId))?.name ?? lmsUi.previewCourseId}）`
    : '';
  const actions = mk('div', 'lms-actions');
  const preview = mk('button', 'primary-btn', lmsUi.previewBusy ? '预览中…' : `预览同步${scope}`);
  preview.type = 'button';
  preview.disabled = !ready || lmsUi.previewBusy;
  preview.addEventListener('click', () => void lmsPreviewSync());
  actions.appendChild(preview);
  if (!ready) actions.appendChild(mk('span', 'lms-hint', '登录后才能预览与同步'));
  card.appendChild(actions);

  if (lmsUi.previewError) card.appendChild(mk('div', 'lms-error', `预览失败：${lmsUi.previewError}`));

  const summary = lmsUi.preview?.summary;
  if (lmsUi.preview) {
    const sum = mk('div', 'lms-summary');
    for (const [key, label] of [
      ['create', '新建'],
      ['update', '更新'],
      ['skip', '跳过'],
      ['stale', '失效'],
    ]) {
      sum.appendChild(statPill(label, summary?.[key] ?? 0));
    }
    sum.appendChild(mk('span', 'lms-hint', `共 ${summary?.total ?? (lmsUi.preview.items ?? []).length} 条`));
    card.appendChild(sum);

    const list = mk('div', 'lms-sync-list');
    const items = lmsUi.preview.items ?? [];
    if (!items.length) list.appendChild(emptyBox('没有需要同步的条目。'));
    for (const item of items) list.appendChild(lmsSyncRow(item));
    card.appendChild(list);

    const foot = mk('div', 'lms-actions');
    const all = mk('button', 'ghost-btn', '全选');
    all.type = 'button';
    const none = mk('button', 'ghost-btn', '全不选');
    none.type = 'button';
    all.addEventListener('click', () => lmsSelectAll(true));
    none.addEventListener('click', () => lmsSelectAll(false));
    const count = mk('span', 'lms-hint', `已选 ${lmsUi.selected.size} 条`);
    const apply = mk('button', 'primary-btn', lmsUi.applyBusy ? '同步中…' : `同步选中 ${lmsUi.selected.size} 条`);
    apply.type = 'button';
    apply.disabled = lmsUi.applyBusy || lmsUi.selected.size === 0;
    apply.addEventListener('click', () => void lmsApplySync());
    lmsUi.refs.syncCount = count;
    lmsUi.refs.syncButton = apply;
    foot.append(all, none, mk('div', 'spacer'), count, apply);
    card.appendChild(foot);
  }

  if (lmsUi.applyError) card.appendChild(mk('div', 'lms-error', `同步失败：${lmsUi.applyError}`));
  if (lmsUi.applyResult) card.appendChild(lmsApplyResultBox(lmsUi.applyResult));
  return card;
}

function lmsApplyResultBox(result) {
  const box = mk('div', 'lms-result');
  box.appendChild(mk('div', 'lms-row-title', '同步结果'));
  box.appendChild(
    mk(
      'div',
      'lms-row-meta',
      `新建 ${result.created ?? 0} · 更新 ${result.updated ?? 0} · 删除 ${result.removed ?? 0}` +
        ` · 跳过 ${result.skipped ?? 0} · 失败 ${(result.errors ?? []).length}`,
    ),
  );
  if (result.lastSyncAt) box.appendChild(mk('div', 'lms-row-meta', `最近同步：${lmsFormatStamp(result.lastSyncAt)}`));
  for (const error of (result.errors ?? []).slice(0, 10)) {
    const text = `${error.key ?? ''} ${error.message ?? ''}`.trim();
    if (text) box.appendChild(mk('div', 'lms-error', text));
  }
  return box;
}

/**
 * 整体重画。
 *
 * 一级页面从上到下只有：工具条（标题 + 学期下拉 + 状态 strip + 同步抽屉）→ 登录卡（未登录时）
 * → 课程网格 → 作业列表。账号状态卡 / 活动卡 / 同步卡都已移走（见需求）。
 */
function lmsPaint() {
  const mount = lmsUi.mount;
  if (!mount) return;
  mount.innerHTML = '';
  lmsUi.refs = { syncCount: null, syncButton: null, syncBoxes: [], autoSync: null };

  const ready = lmsUi.status?.status === 'ready';

  const bar = mk('div', 'toolbar toolbar-wrap');
  bar.appendChild(mk('div', 'toolbar-title', '思源学堂'));
  // 学期筛选：放在工具条行内（登录前 disabled，显示「登录后可选」）
  bar.appendChild(lmsSemesterBar(ready));
  bar.appendChild(lmsStatusStrip());
  if (ready) {
    const syncEntry = mk('button', 'ghost-btn', '同步…');
    syncEntry.type = 'button';
    syncEntry.addEventListener('click', () => {
      lmsUi.syncOpen = !lmsUi.syncOpen;
      lmsPaint();
    });
    bar.appendChild(syncEntry);
  }
  mount.appendChild(bar);

  const content = mk('div', 'view-content');
  mount.appendChild(content);

  if (lmsUi.status && !ready) {
    content.appendChild(lmsUi.status.status === 'need_mfa' ? lmsMfaCard() : lmsLoginCard());
  }
  if (ready) {
    if (lmsUi.detailCourseId !== null) {
      // 详情页的同步入口是「同步本课程」，学期级抽屉不在这里出现
      content.appendChild(lmsCourseDetailPage());
    } else {
      content.appendChild(lmsCoursesCard());
      // 同步抽屉是二级入口，默认收起、排在列表上方
      content.appendChild(lmsSyncDrawer(ready));
      content.appendChild(lmsHomeworkCard());
    }
  }

  lmsMaybeLoad();
}

/* ------------------------------------------------------------------ 导出 */

window.PCViews = {
  calendar: calendarView,
  todo: todoView,
  lms: lmsView,
  timetable: ttView,
  message: messageView,
  settings: settingsView,
  placeholder: placeholderView,
  openEditor,
  CATEGORY_LABEL,
  STATUS_LABEL,
  TARGET_LABEL,
  ACTION_LABEL,
};
