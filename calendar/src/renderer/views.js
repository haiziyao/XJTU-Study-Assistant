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
  const node = mk('button', `icon-btn ${extraClass}`.trim(), glyph);
  node.type = 'button';
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
    iconBtn('删除', '🗑', () => removeRecord('schedule', item.scheduleId, item.title), 'danger'),
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
  actions.appendChild(iconBtn('删除', '🗑', () => removeRecord('event', item.eventId, item.title), 'danger'));
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
  actions.appendChild(iconBtn('删除', '🗑', () => removeRecord('schedule', item.id, item.title), 'danger'));

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
      box.append(mk('div', 'ph-icon', '🚧'), mk('h3', null, `${title} · 预留`), mk('p', 'ph-desc', desc));
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
  courses: null,
  coursesBusy: false,
  coursesError: null,
  activities: null,
  activitiesBusy: false,
  activitiesError: null,
  activityType: '',
  activityCourseId: '',
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

const LMS_TYPE_TABS = [
  ['', '全部'],
  ['homework', '作业'],
  ['lecture_live', '直播'],
  ['lesson', '回放'],
  ['material', '资料'],
];

const LMS_ACTIVITY_LABEL = {
  homework: '作业',
  lecture_live: '直播',
  lesson: '课程回放',
  material: '资料',
  course: '课程',
};

const LMS_ACTION_LABEL = { create: '新建', update: '更新', skip: '跳过', stale: '失效' };

const lmsView = {
  title: '思源学堂',

  render(ctx) {
    lmsUi.mount = ctx.mount;
    lmsPaint();
  },
};

/* --------------------------------------------------------------- 小工具 */

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
    ...extra,
  };
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

async function lmsLoadCourses(refresh) {
  if (lmsUi.coursesBusy) return;
  lmsUi.coursesBusy = true;
  lmsUi.coursesError = null;
  lmsPaint();
  try {
    lmsUi.courses = await PC.api(`/lms/courses${refresh ? '?refresh=1' : ''}`);
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
    lmsUi.activities = await PC.api(`/lms/activities${refresh ? '?refresh=1' : ''}`);
  } catch (error) {
    lmsUi.activitiesError = error.message;
    lmsUi.activities = { items: [], count: 0, fetchedAt: null };
    lmsCheckAuthLost(error);
  } finally {
    lmsUi.activitiesBusy = false;
    lmsPaint();
  }
}

/** 重画后按需补数据：只有「还没拿过」才自动拉，避免反复请求。 */
function lmsMaybeLoad() {
  if (!lmsUi.status) {
    if (!lmsUi.statusLoading) void lmsLoadStatus();
    return;
  }
  if (lmsUi.status.status !== 'ready') return;
  if (lmsUi.courses === null && !lmsUi.coursesBusy) void lmsLoadCourses(false);
  if (lmsUi.activities === null && !lmsUi.activitiesBusy) void lmsLoadActivities(false);
}

/* --------------------------------------------------------------- 登录 / 验证 */

function lmsOnLoggedIn() {
  lmsUi.loginError = null;
  lmsUi.mfaSent = false;
  lmsUi.mfaPhoneMasked = null;
  lmsUi.mfaError = null;
  lmsUi.courses = null;
  lmsUi.coursesError = null;
  lmsUi.activities = null;
  lmsUi.activitiesError = null;
  lmsUi.preview = null;
  lmsUi.selected = new Set();
  lmsUi.applyResult = null;
  lmsUi.applyError = null;
  lmsUi.autoSyncError = null;
  PC.toast('已登录思源学堂');
  lmsPaint();
}

async function lmsLogout() {
  try {
    const status = await PC.api('/lms/logout', { method: 'POST', body: {} });
    lmsUi.status = status;
    lmsUi.courses = null;
    lmsUi.activities = null;
    lmsUi.preview = null;
    lmsUi.selected = new Set();
    lmsUi.applyResult = null;
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

/* --------------------------------------------------------------- 同步 */

async function lmsPreviewSync() {
  if (lmsUi.previewBusy) return;
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

function lmsStatusCard() {
  const card = mk('div', 'card');
  const status = lmsUi.status;

  const head = mk('div', 'lms-head');
  head.appendChild(mk('div', 'card-title', '账号状态'));
  head.appendChild(mk('div', 'spacer'));
  if (status) head.appendChild(lmsStatusPill(status.status));
  card.appendChild(head);

  const body = mk('div', 'card-body');
  const kv = (key, value) => {
    const row = mk('div', 'kv');
    row.append(mk('span', 'kv-key', key), mk('span', 'kv-val', value ?? '—'));
    body.appendChild(row);
  };

  if (!status) {
    kv('状态', lmsUi.statusLoading ? '读取中…' : '未知');
  } else {
    kv('账号', lmsUserText(status));
    if (status.status === 'need_mfa') {
      kv('验证方式', status.mfa?.flow === 'sec' ? '二次认证（Safety Verify）' : '短信验证码');
      kv('手机号', lmsUi.mfaPhoneMasked ?? status.mfa?.phoneMasked ?? '尚未发送');
    }
    kv('上次同步', status.lastSyncAt ? lmsFormatStamp(status.lastSyncAt) : '尚未同步');
    kv('已同步', `日程 ${status.synced?.schedules ?? 0} 条 · 事件 ${status.synced?.events ?? 0} 条`);
    kv('本地缓存', `课程 ${status.cache?.courses ?? 0} 门 · 活动 ${status.cache?.activities ?? 0} 条`);
    kv(
      '缓存时间',
      `课程 ${status.cache?.lastCoursesAt ? lmsFormatStamp(status.cache.lastCoursesAt) : '—'}` +
        ` · 活动 ${status.cache?.lastActivitiesAt ? lmsFormatStamp(status.cache.lastActivitiesAt) : '—'}`,
    );
    kv('服务地址', status.baseUrl ?? '—');
    if (status.error) kv('最近错误', status.error);
  }
  card.appendChild(body);

  if (lmsUi.statusError) card.appendChild(mk('div', 'lms-error', `状态读取失败：${lmsUi.statusError}`));
  card.appendChild(lmsAutoSyncRow(status));

  if (status && status.status !== 'anonymous') {
    const actions = mk('div', 'lms-actions');
    const out = mk('button', 'ghost-btn', '退出登录');
    out.type = 'button';
    out.addEventListener('click', () => void lmsLogout());
    actions.append(mk('div', 'spacer'), out);
    card.appendChild(actions);
  }
  return card;
}

/**
 * 自动同步设置行（POST /lms/settings）。
 *
 * 未登录时置灰而不是隐藏：设置本身是持久的，置灰能让用户知道它在哪、为什么不能用。
 * 任何一次改动都把 autoSync 与 autoSyncIntervalHours 一起提交；成功后用返回的 status 刷新卡片。
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

function lmsCoursesCard() {
  const card = mk('div', 'card');
  const head = mk('div', 'lms-head');
  head.appendChild(mk('div', 'card-title', '课程'));
  if (lmsUi.courses?.count) head.appendChild(mk('span', 'lms-hint', `${lmsUi.courses.count} 门`));
  head.appendChild(mk('div', 'spacer'));
  head.appendChild(lmsActionButton('刷新课程', '刷新中…', lmsUi.coursesBusy, () => void lmsLoadCourses(true)));
  card.appendChild(head);

  if (lmsUi.coursesError) card.appendChild(mk('div', 'lms-error', `课程加载失败：${lmsUi.coursesError}`));

  const items = lmsUi.courses?.items ?? [];
  if (lmsUi.courses === null || (lmsUi.coursesBusy && !items.length)) {
    card.appendChild(mk('div', 'loading', '加载中…'));
    return card;
  }
  if (!items.length) {
    card.appendChild(emptyBox('还没有课程缓存，点「刷新课程」从思源学堂拉取。'));
    return card;
  }

  const list = mk('div', 'lms-list');
  for (const course of items) list.appendChild(lmsCourseRow(course));
  card.appendChild(list);
  if (lmsUi.courses?.fetchedAt) {
    card.appendChild(mk('div', 'lms-hint', `更新于 ${lmsFormatStamp(lmsUi.courses.fetchedAt)}`));
  }
  return card;
}

function lmsCourseRow(course) {
  const row = mk('div', 'lms-row');
  const title = mk('div', 'lms-row-title');
  title.appendChild(mk('span', null, course.name ?? '（未命名课程）'));
  if (course.courseCode) title.appendChild(mk('span', 'tag', course.courseCode));
  if (course.compulsory) title.appendChild(mk('span', 'tag', '必修'));
  row.appendChild(title);

  const teachers = (course.instructors ?? []).map((item) => item?.name).filter(Boolean).join('、');
  const semester = course.semester?.realName || course.semester?.name;
  const meta1 = [
    teachers ? `教师：${teachers}` : null,
    course.credit ? `学分：${course.credit}` : null,
    semester ? `学期：${semester}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (meta1) row.appendChild(mk('div', 'lms-row-meta', meta1));

  const klass = course.teachingClassName || course.klass;
  const range = course.startDate || course.endDate ? `${course.startDate ?? '?'} ~ ${course.endDate ?? '?'}` : null;
  const meta2 = [klass ? `教学班：${klass}` : null, range].filter(Boolean).join(' · ');
  if (meta2) row.appendChild(mk('div', 'lms-row-meta', meta2));

  return row;
}

/** 活动列表：类型与课程都在前端过滤（后端 refresh 时不做类型过滤）。 */
function lmsVisibleActivities() {
  let items = lmsUi.activities?.items ?? [];
  if (lmsUi.activityType) items = items.filter((item) => item.type === lmsUi.activityType);
  if (lmsUi.activityCourseId) {
    items = items.filter((item) => String(item.courseId) === String(lmsUi.activityCourseId));
  }
  return items;
}

function lmsActivitiesCard() {
  const card = mk('div', 'card');
  const visible = lmsVisibleActivities();

  const head = mk('div', 'lms-head');
  head.appendChild(mk('div', 'card-title', '活动'));
  head.appendChild(mk('span', 'lms-hint', `${visible.length} 条`));
  head.appendChild(mk('div', 'spacer'));
  head.appendChild(lmsActionButton('刷新活动', '刷新中…', lmsUi.activitiesBusy, () => void lmsLoadActivities(true)));
  card.appendChild(head);

  const filters = mk('div', 'lms-filters');
  const seg = mk('div', 'seg');
  for (const [value, label] of LMS_TYPE_TABS) {
    const button = mk('button', `seg-btn${lmsUi.activityType === value ? ' active' : ''}`, label);
    button.type = 'button';
    button.addEventListener('click', () => {
      if (lmsUi.activityType === value) return;
      lmsUi.activityType = value;
      lmsPaint();
    });
    seg.appendChild(button);
  }
  filters.appendChild(seg);

  const select = mk('select');
  select.appendChild(option('', '全部课程', !lmsUi.activityCourseId));
  for (const course of lmsUi.courses?.items ?? []) {
    select.appendChild(
      option(String(course.id), course.name ?? String(course.id), String(course.id) === String(lmsUi.activityCourseId)),
    );
  }
  select.addEventListener('change', () => {
    lmsUi.activityCourseId = select.value;
    lmsPaint();
  });
  filters.appendChild(select);
  card.appendChild(filters);

  if (lmsUi.activitiesError) card.appendChild(mk('div', 'lms-error', `活动加载失败：${lmsUi.activitiesError}`));

  if (lmsUi.activities === null || (lmsUi.activitiesBusy && !(lmsUi.activities?.items ?? []).length)) {
    card.appendChild(mk('div', 'loading', '加载中…'));
    return card;
  }
  if (!visible.length) {
    const any = (lmsUi.activities?.items ?? []).length > 0;
    card.appendChild(emptyBox(any ? '当前筛选条件下没有活动。' : '还没有活动缓存，点「刷新活动」拉取。'));
    return card;
  }

  const list = mk('div', 'lms-list');
  for (const item of visible) list.appendChild(lmsActivityRow(item));
  card.appendChild(list);
  if (lmsUi.activities?.fetchedAt) {
    card.appendChild(mk('div', 'lms-hint', `更新于 ${lmsFormatStamp(lmsUi.activities.fetchedAt)}`));
  }
  return card;
}

function lmsActivityRow(item) {
  const row = mk('div', 'lms-row');
  const title = mk('div', 'lms-row-title');
  title.appendChild(mk('span', null, item.title ?? '（无标题）'));
  title.appendChild(mk('span', 'tag', LMS_ACTIVITY_LABEL[item.type] ?? item.type ?? '活动'));
  if ((item.userSubmitCount ?? 0) > 0) title.appendChild(mk('span', 'tag submitted', '已提交'));
  if (item.published === false) title.appendChild(mk('span', 'tag late', '未发布'));
  row.appendChild(title);

  if (item.courseName) row.appendChild(mk('div', 'lms-row-meta', item.courseName));
  const start = lmsFormatTime(item.startTime);
  const end = lmsFormatTime(item.endTime);
  row.appendChild(
    mk('div', 'lms-row-meta', start || end ? `开始 ${start || '—'} · 结束 ${end || '—'}` : '无时间信息'),
  );
  return row;
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

function lmsSyncCard(ready) {
  const card = mk('div', 'card');
  const head = mk('div', 'lms-head');
  head.appendChild(mk('div', 'card-title', '同步到日历'));
  head.appendChild(mk('div', 'spacer'));
  head.appendChild(mk('span', 'lms-hint', '先预览，勾选后再写入'));
  card.appendChild(head);

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

  const actions = mk('div', 'lms-actions');
  const preview = mk('button', 'primary-btn', lmsUi.previewBusy ? '预览中…' : '预览同步');
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

/** 整体重画：所有文本都经 textContent 写入（等价于 escapeHtml），不使用 innerHTML 拼接。 */
function lmsPaint() {
  const mount = lmsUi.mount;
  if (!mount) return;
  mount.innerHTML = '';
  lmsUi.refs = { syncCount: null, syncButton: null, syncBoxes: [], autoSync: null };

  const bar = mk('div', 'toolbar');
  bar.appendChild(mk('div', 'toolbar-title', '账号与同步'));
  bar.appendChild(mk('div', 'spacer'));
  const reload = mk('button', 'ghost-btn', lmsUi.statusLoading ? '刷新中…' : '刷新状态');
  reload.type = 'button';
  reload.disabled = lmsUi.statusLoading;
  reload.addEventListener('click', () => void lmsLoadStatus({ manual: true }));
  bar.appendChild(reload);
  mount.appendChild(bar);

  const content = mk('div', 'view-content');
  mount.appendChild(content);

  const ready = lmsUi.status?.status === 'ready';
  content.appendChild(lmsStatusCard());
  if (lmsUi.status && !ready) content.appendChild(lmsUi.status.status === 'need_mfa' ? lmsMfaCard() : lmsLoginCard());
  if (ready) {
    content.appendChild(lmsCoursesCard());
    content.appendChild(lmsActivitiesCard());
  }
  if (lmsUi.status) content.appendChild(lmsSyncCard(ready));

  lmsMaybeLoad();
}

/* ------------------------------------------------------------------ 导出 */

window.PCViews = {
  calendar: calendarView,
  todo: todoView,
  lms: lmsView,
  message: messageView,
  settings: settingsView,
  placeholder: placeholderView,
  openEditor,
  CATEGORY_LABEL,
  STATUS_LABEL,
  TARGET_LABEL,
  ACTION_LABEL,
};
