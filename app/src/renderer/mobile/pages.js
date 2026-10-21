/**
 * 手机端的两个新页面：**日历**与**待办**，形态照 iOS 系统日历 / 提醒事项。
 *
 * 数据层不重写：`PCMobileLogic` 已经提供了 `monthMatrix`（固定 6 行 42 格）、
 * `dayMarks`（格子上的小圆点）、`dayAgenda`（把一天摊成时间线）、`groupTodos`
 * （逾期 / 今天 / 以后 / 没有截止日期 / 已完成）。这里只做小程序与 DOM。
 *
 * 接口沿用现有的 `/calendar?from&to` 与 `/todos`，不新增后端。
 * 编辑仍然交给现有编辑器（`PC.openEditor({ target, id })`）—— 重建列表不等于重建表单。
 */
window.PCMobilePages = (function () {
  'use strict';

  const UI = window.PCMobileUI;
  const Logic = window.PCMobileLogic;
  if (!UI || !Logic) return {};

  const { h, icon, cell, section, tag, segmented, iconButton, emptyState, skeleton, button } = UI;

  const WEEK_HEAD = ['一', '二', '三', '四', '五', '六', '日'];

  function api(path, options) {
    return window.PC.api(path, options);
  }

  function openEditor(payload) {
    try {
      window.PC.openEditor?.(payload);
    } catch (error) {
      window.PC.toast?.(error?.message ?? '打不开编辑器');
    }
  }

  /* ============================================================ 日历 */

  const calendar = {
    mode: 'month',
    cursor: Logic.todayKey(),
    selected: Logic.todayKey(),
    days: new Map(),
    host: null,
    chrome: null,
    requestId: 0,
  };

  async function loadCalendarRange(from, to) {
    // 用请求号丢弃过期响应：快速连点 `›` 时，先发的可能后到
    const id = ++calendar.requestId;
    const res = await api(`/calendar?from=${from}&to=${to}`);
    if (id !== calendar.requestId) return;
    for (const day of res?.days ?? []) calendar.days.set(day.date, day);
  }

  /** 当前模式要预取的日期范围。 */
  function rangeOfMode() {
    if (calendar.mode === 'year') return null; // 年视图只画骨架，不拉数据
    if (calendar.mode === 'month') {
      const matrix = Logic.monthMatrix(calendar.cursor);
      return { from: matrix[0], to: matrix[matrix.length - 1] };
    }
    if (calendar.mode === 'week') {
      const days = Logic.weekDays(calendar.selected);
      return { from: days[0], to: days[days.length - 1] };
    }
    return { from: calendar.selected, to: calendar.selected };
  }

  function shift(dir) {
    if (calendar.mode === 'year') calendar.cursor = `${Number(calendar.cursor.slice(0, 4)) + dir}-01-01`;
    else if (calendar.mode === 'month') calendar.cursor = Logic.addMonths(calendar.cursor, dir);
    else {
      calendar.selected = Logic.addDays(calendar.selected, dir * (calendar.mode === 'week' ? 7 : 1));
      calendar.cursor = calendar.selected;
    }
    paintCalendar();
  }

  function calendarTitle() {
    if (calendar.mode === 'year') return `${calendar.cursor.slice(0, 4)}年`;
    if (calendar.mode === 'month') return Logic.monthTitle(calendar.cursor);
    return Logic.dayTitle(calendar.selected);
  }

  function paintCalendarChrome() {
    const setAppbar = calendar.chrome?.setAppbar;
    if (!setAppbar) return;
    const isToday = (calendar.mode === 'month' ? calendar.cursor : calendar.selected) === Logic.todayKey();
    setAppbar({
      title: calendarTitle(),
      left: iconButton({ icon: 'chevronLeft', label: '上一页', onClick: () => shift(-1) }),
      right: h(
        'div',
        { class: 'm-cal-actions' },
        isToday ? null : h('button', { type: 'button', class: 'm-nav-btn', text: '今天', onClick: () => { calendar.cursor = Logic.todayKey(); calendar.selected = Logic.todayKey(); paintCalendar(); } }),
        iconButton({ icon: 'chevron', label: '下一页', onClick: () => shift(1) }),
        iconButton({ icon: 'plus', label: '新建日程', onClick: () => openEditor({ target: 'schedule', defaults: { date: calendar.selected } }) }),
      ),
    });
  }

  function monthGrid() {
    const wrap = h('div', { class: 'm-cal' });
    const head = h('div', { class: 'm-cal-week-head' });
    for (const w of WEEK_HEAD) head.append(h('span', { text: w }));
    wrap.append(head);

    const cells = h('div', { class: 'm-cal-cells' });
    for (const key of Logic.monthMatrix(calendar.cursor)) {
      const day = calendar.days.get(key);
      const inMonth = Logic.sameMonth(key, calendar.cursor);
      const isToday = key === Logic.todayKey();
      const isSelected = key === calendar.selected;
      const cellNode = h('button', {
        type: 'button',
        class: `m-cal-cell${inMonth ? '' : ' is-dim'}${isSelected ? ' is-selected' : ''}`,
        'aria-label': `${Logic.monthDay(key)}日`,
      });
      cellNode.append(
        h('span', { class: `m-cal-daynum${isToday ? ' is-today' : ''}`, text: String(Number(key.slice(-2))) }),
      );
      const marks = Logic.dayMarks(day).slice(0, 3);
      const dots = h('span', { class: 'm-cal-dots' });
      for (const mark of marks) dots.append(h('span', { class: `m-cal-dot is-${mark}` }));
      cellNode.append(dots);
      cellNode.addEventListener('click', () => {
        calendar.selected = key;
        if (!inMonth) calendar.cursor = key;
        paintCalendar();
      });
      cells.append(cellNode);
    }
    wrap.append(cells);
    return wrap;
  }

  function weekStrip() {
    const wrap = h('div', { class: 'm-cal-week' });
    for (const key of Logic.weekDays(calendar.selected)) {
      const isToday = key === Logic.todayKey();
      const isSelected = key === calendar.selected;
      const node = h('button', {
        type: 'button',
        class: `m-cal-weekday${isSelected ? ' is-selected' : ''}`,
      });
      node.append(
        h('span', { class: 'm-cal-weekday-label', text: Logic.weekdayShort(key) }),
        h('span', { class: `m-cal-weekday-num${isToday ? ' is-today' : ''}`, text: String(Number(key.slice(-2))) }),
      );
      node.addEventListener('click', () => {
        calendar.selected = key;
        paintCalendar();
      });
      wrap.append(node);
    }
    return wrap;
  }

  function miniMonth(key) {
    const wrap = h('div', { class: 'm-mini' });
    wrap.append(h('p', { class: 'm-mini-title', text: Logic.monthTitle(key) }));
    const grid = h('div', { class: 'm-mini-grid' });
    for (const w of WEEK_HEAD) grid.append(h('span', { class: 'm-mini-head', text: w }));
    for (const day of Logic.monthMatrix(key)) {
      const inMonth = Logic.sameMonth(day, key);
      grid.append(
        h('span', {
          class: `m-mini-day${inMonth ? '' : ' is-dim'}${day === Logic.todayKey() ? ' is-today' : ''}`,
          text: inMonth ? String(Number(day.slice(-2))) : '',
        }),
      );
    }
    wrap.append(grid);
    wrap.addEventListener('click', () => {
      calendar.mode = 'month';
      calendar.cursor = key;
      calendar.selected = key;
      paintCalendar();
    });
    return wrap;
  }

  /** 一天的日程列表（iOS 月视图下方那一块）。 */
  function dayList(dateKey, { withHour = false } = {}) {
    const rows = Logic.dayAgenda(calendar.days.get(dateKey) ?? {});
    if (!rows.length) {
      return emptyState({ icon: 'calendar', title: '没有日程', message: '点右上角 + 新建，或让 AI 帮你排。' });
    }
    const list = h('div', { class: 'm-list m-list--inset-wide' });
    for (const row of rows) {
      const time = row.allDay ? '全天' : row.start;
      const span = row.end ? `${row.start}–${row.end}` : '';
      const node = cell({
        leading: h('span', { class: 'm-agenda-time', text: time }),
        title: row.title ?? '未命名',
        subtitle: [span, row.location].filter(Boolean).join(' · '),
        className: row.kind === 'todo' ? 'is-todo' : '',
        onClick: () => openEditor({ target: row.target, id: row.id }),
      });
      if (withHour) node.classList.add('m-agenda-row');
      list.append(node);
    }
    return list;
  }

  function paintCalendar() {
    const host = calendar.host;
    if (!host) return;
    paintCalendarChrome();
    host.replaceChildren();

    const seg = segmented({
      items: [
        { value: 'day', label: '日' },
        { value: 'week', label: '周' },
        { value: 'month', label: '月' },
        { value: 'year', label: '年' },
      ],
      value: calendar.mode,
      label: '日历视图',
      onChange: (value) => {
        calendar.mode = value;
        paintCalendar();
      },
    });
    host.append(seg);

    const body = h('div', { class: 'm-cal-body m-page' });
    host.append(body);

    if (calendar.mode === 'month') {
      body.append(monthGrid());
      const head = h('div', { class: 'm-cal-agenda-head' });
      head.append(h('h2', { text: Logic.dayTitle(calendar.selected) }));
      body.append(head);
      body.append(dayList(calendar.selected));
    } else if (calendar.mode === 'week') {
      body.append(weekStrip());
      body.append(dayList(calendar.selected));
    } else if (calendar.mode === 'day') {
      body.append(dayList(calendar.selected, { withHour: true }));
    } else {
      const year = Number(calendar.cursor.slice(0, 4));
      const wrap = h('div', { class: 'm-year' });
      for (let m = 1; m <= 12; m++) wrap.append(miniMonth(`${year}-${String(m).padStart(2, '0')}-01`));
      body.append(wrap);
    }

    const range = rangeOfMode();
    if (!range) return;
    loadCalendarRange(range.from, range.to)
      .then(() => {
        // 数据回来只重画内容，不动分段控件的选中态与滚动位置
        if (calendar.host !== host || !host.isConnected) return;
        const nodes = body.querySelectorAll('.m-cal, .m-cal-week, .m-list, .m-empty, .m-year');
        if (!nodes.length) return;
        paintCalendarBody(body);
      })
      .catch((error) => {
        body.append(UI.errorState({ message: error?.message, onRetry: () => paintCalendar() }));
      });
  }

  /** 只重画"需要数据"的那部分，避免整页闪一下。 */
  function paintCalendarBody(body) {
    body.replaceChildren();
    if (calendar.mode === 'month') {
      body.append(monthGrid());
      body.append(h('div', { class: 'm-cal-agenda-head' }, h('h2', { text: Logic.dayTitle(calendar.selected) })));
      body.append(dayList(calendar.selected));
    } else if (calendar.mode === 'week') {
      body.append(weekStrip());
      body.append(dayList(calendar.selected));
    } else if (calendar.mode === 'day') {
      body.append(dayList(calendar.selected, { withHour: true }));
    } else {
      const year = Number(calendar.cursor.slice(0, 4));
      const wrap = h('div', { class: 'm-year' });
      for (let m = 1; m <= 12; m++) wrap.append(miniMonth(`${year}-${String(m).padStart(2, '0')}-01`));
      body.append(wrap);
    }
  }

  function mountCalendar(host, chrome) {
    calendar.host = host;
    calendar.chrome = chrome ?? null;
    calendar.cursor = Logic.todayKey();
    calendar.selected = Logic.todayKey();
    paintCalendar();
  }

  /* ============================================================ 待办 */

  const todos = { host: null, chrome: null, items: [], loading: true, error: null };

  async function loadTodos() {
    // 同时取未完成与已完成：`/todos` 不带 completed 参数时行为随版本变，
    // 明确要两次再按 id 去重，比猜参数稳。
    const [open, done] = await Promise.all([
      api('/todos').catch(() => ({ items: [] })),
      api('/todos?completed=true').catch(() => ({ items: [] })),
    ]);
    const seen = new Map();
    for (const item of [...(open?.items ?? []), ...(done?.items ?? [])]) seen.set(item.id, item);
    return [...seen.values()];
  }

  function todoRow(item) {
    const done = Boolean(item.completed);
    // ⚠ 不能给 `cell()` 传 onClick 再用 iconButton 当 leading：
    // `cell()` 带 onClick 时渲染成 `<button>`，里面再套一个 button 就是**按钮套按钮**，
    // HTML 不合法，而且点勾选会连带冒泡去打开编辑器。
    // 所以外层用 div（不传 onClick），勾选按钮自己 stopPropagation，行的点击另外绑。
    const check = h(
      'button',
      { type: 'button', class: 'm-icon-btn m-todo-check', 'aria-label': done ? '标记为未完成' : '标记为完成' },
      icon(done ? 'checkCircle' : 'circle', { size: 22 }),
    );
    check.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleTodo(item);
    });

    const row = cell({
      leading: check,
      title: item.title,
      subtitle: [Logic.dueLabel(item.deadline), item.category].filter(Boolean).join(' · '),
      className: done ? 'is-done' : '',
      chevron: false,
    });
    row.addEventListener('click', () => openEditor({ target: 'todo', id: item.id }));

    return UI.swipeable(row, [
      {
        label: done ? '取消完成' : '完成',
        icon: 'check',
        tone: 'green',
        onSelect: () => toggleTodo(item),
      },
      {
        label: '删除',
        icon: 'trash',
        tone: 'red',
        onSelect: async () => {
          const ok = await UI.confirm({ title: '删除待办', message: item.title, confirmLabel: '删除', destructive: true });
          if (!ok) return;
          await api(`/todos/${item.id}`, { method: 'DELETE' });
          window.PC.toast?.('已删除');
          paintTodosWithData();
        },
      },
    ]);
  }

  async function toggleTodo(item) {
    try {
      await api(`/todos/${item.id}/completed`, { method: 'POST', body: { completed: !item.completed } });
      window.PC.toast?.(item.completed ? '已取消完成' : '已完成');
      paintTodos();
    } catch (error) {
      window.PC.toast?.(error?.message ?? '操作失败');
    }
  }

  function paintTodosChrome() {
    todos.chrome?.setAppbar?.({
      title: '待办',
      back: todos.chrome?.back !== false,
      right: iconButton({ icon: 'plus', label: '新建待办', onClick: () => openEditor({ target: 'todo', defaults: {} }) }),
    });
  }

  function paintTodos() {
    const host = todos.host;
    if (!host) return;
    paintTodosChrome();
    host.replaceChildren();

    if (todos.loading) {
      host.append(skeleton(4));
      return;
    }
    if (todos.error) {
      host.append(UI.errorState({ message: todos.error, onRetry: () => loadTodos().then(paintTodos) }));
      return;
    }

    const groups = Logic.groupTodos(todos.items);
    if (!groups.length) {
      host.append(emptyState({ icon: 'checkCircle', title: '没有待办', message: '点右上角 + 新建一条。' }));
      return;
    }

    for (const group of groups) {
      const block = section({ header: group.title, className: `m-todo-group is-${group.key}` });
      for (const item of group.items) block.list.append(todoRow(item));
      host.append(block);
    }
  }

  function paintTodosWithData() {
    todos.loading = true;
    todos.error = null;
    paintTodos();
    loadTodos()
      .then((items) => {
        todos.items = items;
        todos.loading = false;
      })
      .catch((error) => {
        todos.error = error?.message ?? '加载失败';
        todos.loading = false;
      })
      .finally(() => paintTodos());
  }

  function mountTodos(host, chrome) {
    todos.host = host;
    todos.chrome = chrome ?? null;
    paintTodosWithData();
  }

  return { calendar: mountCalendar, todos: mountTodos, repaintTodos: paintTodosWithData };
})();
