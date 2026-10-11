/**
 * 日历模块的前端：日历（月/周/日）与待办两个视图，以及共用的数据访问与新建/编辑弹层。
 *
 * 「日历」与「待办」同属一个后端模块（modules/calendar），所以放在同一个文件里，
 * 共用的辅助函数留在闭包内，不会污染全局。
 *
 * 新增前端功能请照 `views/lms.js` 的写法另建文件，不要往这里加。
 */

(function () {
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

/**
 * 日视图：顶部大日期 + 全天行 + 按小时的时间轴（苹果日历那种版式）。
 *
 * 结构见 calendar.css 的「日视图」段落：
 *   .day-view > .day-hero / .day-allday / .day-timeline(.day-hours + .day-canvas > .day-block｜.day-now)
 *
 * 滚动归属：外壳里真正滚动的是 .view-content（.panel-body 是 overflow:hidden），
 * 所以这里不自己开滚动条，只把时间轴按内容高度撑开，靠 position: sticky 让
 * .day-hero / .day-allday 吸顶——避免出现双滚动条。
 */

/** 时间轴小时高度的兜底值（正常从 CSS 的 --day-hour-height 读，见 readHourHeight）。 */
const DAY_HOUR_HEIGHT = 56;
/** 没有日程时，自动滚动到的时间（分钟）：07:00。 */
const DAY_FIRST_MINUTE = 7 * 60;

/** 农历能力探测：null = 未知，false = 本机没有（不再请求），true = 可用（文案按日期缓存）。 */
let lunarSupported = null;
const lunarText = new Map();

function renderDay(host, anchor) {
  const loading = mk('div', 'loading', '加载中…');
  host.appendChild(loading);

  fetchCalendar(anchor, anchor)
    .then((byDate) => {
      loading.remove();
      const day = byDate.get(anchor) ?? { events: [], schedules: [], stats: {} };
      const timed = day.schedules.filter((item) => !item.allDay && item.startTime);
      const allDayItems = [
        ...day.events.map((item) => ({ kind: 'event', ...item })),
        ...day.schedules.filter((item) => item.allDay).map((item) => ({ kind: 'schedule', ...item })),
      ];

      const wrap = mk('div', 'day-view');
      const hero = dayHero(anchor);
      const allDay = dayAllDay(allDayItems);
      const timeline = mk('div', 'day-timeline');
      wrap.append(hero, allDay, timeline);

      // 先入文档：这样才读得到 CSS 变量、量得出吸顶高度（detached 元素量不到）
      host.appendChild(wrap);
      loadLunar(anchor, hero);

      const hourHeight = readHourHeight(timeline);
      timeline.appendChild(dayHours());
      const canvas = mk('div', 'day-canvas');
      // 重叠分列复用周视图的贪心分配（不改它的对外行为）
      for (const block of layoutBlocks(timed)) canvas.appendChild(dayBlock(block, hourHeight));
      if (anchor === PCUtil.todayKey()) canvas.appendChild(dayNowMark(hourHeight));
      timeline.appendChild(canvas);

      const sticky = hero.offsetHeight + allDay.offsetHeight;
      if (hero.offsetHeight) wrap.style.setProperty('--day-hero-h', `${hero.offsetHeight}px`);
      // 让「最早日程前一小时」落在可视区顶部；没有日程就回到 07:00（不强制滚到最顶）
      const rect = timeline.getBoundingClientRect();
      const viewport = host.getBoundingClientRect();
      const timelineTop = rect.top - viewport.top + host.scrollTop;
      const target = timed.length
        ? Math.max(0, Math.min(...timed.map((item) => PCUtil.minutes(item.startTime))) - 60)
        : DAY_FIRST_MINUTE;
      host.scrollTop = Math.max(0, timelineTop + (target / 60) * hourHeight - sticky);
    })
    .catch((error) => loading.replaceWith(errorBox(error)));
}

/** 时间轴小时高度：优先取 CSS 变量，取不到时回退（浏览器外/桩环境也不会炸）。 */
function readHourHeight(timeline) {
  if (typeof getComputedStyle !== 'function') return DAY_HOUR_HEIGHT;
  const value = parseFloat(getComputedStyle(timeline).getPropertyValue('--day-hour-height'));
  return Number.isFinite(value) && value > 0 ? value : DAY_HOUR_HEIGHT;
}

/* ---------------------------------------------------------------- 日视图：顶部 */

function dayHero(anchor) {
  const date = PCUtil.toDate(anchor);
  const hero = mk('div', 'day-hero');
  hero.appendChild(
    mk('div', 'day-hero-date', `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`),
  );

  const sub = mk('div', 'day-hero-sub');
  sub.appendChild(mk('span', null, `星期${PCUtil.WEEK_CN[PCUtil.isoWeekday(anchor) - 1]}`));
  hero.appendChild(sub);
  return hero;
}

/** 农历：有才显示，501/失败静默隐藏并记住本机没有这个能力（不再重复请求）。 */
function loadLunar(anchor, hero) {
  const sub = hero.querySelector('.day-hero-sub');
  if (!sub || lunarSupported === false) return;
  const show = (text) => {
    if (!text || sub.querySelector('.day-hero-lunar')) return;
    sub.appendChild(mk('span', 'day-hero-lunar', text));
    // 农历文字可能把顶栏撑高几像素，重新量一次吸顶偏移，避免全天行被压住
    const wrap = hero.parentNode;
    if (wrap?.style?.setProperty && hero.offsetHeight) {
      wrap.style.setProperty('--day-hero-h', `${hero.offsetHeight}px`);
    }
  };
  if (lunarText.has(anchor)) {
    show(lunarText.get(anchor));
    return;
  }
  PC.api(`/meta/lunar?date=${anchor}`)
    .then((payload) => {
      lunarSupported = true;
      const text = lunarLabel(payload);
      lunarText.set(anchor, text);
      show(text);
    })
    .catch(() => {
      lunarSupported = false;
    });
}

/** 从 /meta/lunar 的契约响应里取一行可读文案（契约见 core/routes.js）。 */
function lunarLabel(payload) {
  const lunar = payload?.lunar ?? payload?.data?.lunar;
  if (typeof lunar === 'string') return lunar;
  if (lunar && typeof lunar === 'object') {
    const text = `${lunar.year ? `${lunar.year}年` : ''}${lunar.month ?? ''}${lunar.day ?? ''}`;
    if (text) return text;
  }
  return typeof payload?.text === 'string' ? payload.text : '';
}

/* ---------------------------------------------------------------- 日视图：全天 */

function dayAllDay(items) {
  const row = mk('div', 'day-allday');
  row.appendChild(mk('div', 'day-allday-label', '全天'));
  const list = mk('div', 'day-allday-items');
  for (const item of items) {
    const chip = mk('div', `day-allday-item cat-${item.category ?? 'other'}`, item.title);
    if (item.status === 'done') chip.classList.add('done');
    if (item.status === 'cancelled') chip.classList.add('cancelled');
    chip.title = item.title;
    chip.addEventListener('click', () => {
      if (item.kind === 'event') openEditor({ target: 'event', id: item.eventId });
      else openEditor({ target: 'schedule', id: item.scheduleId });
    });
    list.appendChild(chip);
  }
  // 即使一条都没有也保留这一行，和苹果日历一样固定有「全天」
  row.appendChild(list);
  return row;
}

/* ------------------------------------------------------------ 日视图：时间轴 */

function dayHours() {
  const hours = mk('div', 'day-hours');
  for (let hour = 0; hour < 24; hour += 1) {
    const line = mk('div', 'day-hour');
    line.appendChild(mk('span', 'day-hour-label', `${PCUtil.pad2(hour)}:00`));
    hours.appendChild(line);
  }
  return hours;
}

function dayBlock(block, hourHeight) {
  const node = mk('div', `day-block cat-${block.category ?? 'other'}`);
  if (block.status === 'done') node.classList.add('done');
  if (block.status === 'cancelled') node.classList.add('cancelled');

  node.style.top = `${(block.start / 60) * hourHeight}px`;
  node.style.height = `${Math.max(28, ((block.end - block.start) / 60) * hourHeight)}px`;
  if (block.cols > 1) {
    node.style.left = `calc(${(block.col / block.cols) * 100}% + 2px)`;
    node.style.width = `calc(${100 / block.cols}% - 4px)`;
  } else {
    node.style.left = '2px';
    node.style.right = '2px';
  }

  node.appendChild(mk('div', 'day-block-bar'));
  node.appendChild(mk('div', 'day-block-title', block.title));

  if (block.location) {
    const loc = mk('div', 'day-block-loc');
    appendMiniIcon(loc, 'pin');
    loc.appendChild(mk('span', null, block.location));
    node.appendChild(loc);
  }

  const time = mk('div', 'day-block-time');
  appendMiniIcon(time, 'clock');
  time.appendChild(mk('span', null, `${block.startTime}–${block.endTime ?? ''}`));
  node.appendChild(time);

  if (block.isRepeatInstance || (block.repeat?.type && block.repeat.type !== 'none')) {
    const repeat = mk('div', 'day-block-repeat');
    repeat.title = '重复日程';
    appendMiniIcon(repeat, 'repeat');
    node.appendChild(repeat);
  }

  node.title = `${block.startTime}–${block.endTime ?? ''}${block.location ? ` · ${block.location}` : ''} ${block.title}`;
  node.addEventListener('click', () => openEditor({ target: 'schedule', id: block.scheduleId }));
  return node;
}

/** 今天才画的红线：按当前真实时刻定位。 */
function dayNowMark(hourHeight) {
  const now = new Date();
  const mark = mk('div', 'day-now');
  mark.style.top = `${((now.getHours() * 60 + now.getMinutes()) / 60) * hourHeight}px`;
  mark.title = `现在 ${PCUtil.pad2(now.getHours())}:${PCUtil.pad2(now.getMinutes())}`;
  return mark;
}

/** 块内小图标：复用外壳的图标表（内联 SVG），没有图标表时就不放图标。 */
function appendMiniIcon(container, name, size = 12) {
  const svg = window.PCIcons?.svg?.(name, size);
  if (!svg) return null;
  const icon = mk('span', 'day-icon');
  icon.innerHTML = svg;
  container.appendChild(icon);
  return icon;
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

  // 待办 = 只有日期的条目（allDay=1）。带起止时刻的日程（开会、上课）属于日历，不属于待办列表，
  // 所以这里恒定带上 allDay=1 —— 待办与日程是两件事，别混在一张表里。
  const TODO_SCOPE = 'allDay=1';
  let query = `/schedules?${TODO_SCOPE}&status=pending&limit=300`;
  if (state.todo.filter === 'today') query = `/schedules?${TODO_SCOPE}&date=${today}`;
  else if (state.todo.filter === 'week') query = `/schedules?${TODO_SCOPE}&from=${weekStart}&to=${weekEnd}`;
  else if (state.todo.filter === 'done') query = `/schedules?${TODO_SCOPE}&status=done&limit=100`;

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

/* ------------------------------------------------------------------ 登记到外壳 */

window.PCModules.register({
  id: 'calendar',
  label: '日历',
  icon: '🗓',
  order: 10,
  title: calendarView.title,
  render: (ctx) => calendarView.render(ctx),
});

window.PCModules.register({
  id: 'todo',
  label: '待办',
  icon: '☑',
  order: 20,
  title: todoView.title,
  render: (ctx) => todoView.render(ctx),
});

/** 对外提供的新建/编辑弹层：其它视图用 PCModules.getService('editor') 取用，不必互相引用。 */
window.PCModules.service('editor', openEditor);
})();
