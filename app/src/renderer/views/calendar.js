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

/** 农历按天缓存（日视图单日、月视图 42 天、年视图都不用重复请求）。 */
const lunarDays = new Map();
/** 农历按区间缓存：同一个区间只请求一次。 */
const lunarRanges = new Map();

/**
 * 批量拉农历（月视图 42 天 / 年视图 365 天一次拿完，不能逐日请求）。
 * 失败时静默返回空 —— 没有农历也要能看日历。
 */
function fetchLunar(from, to) {
  const key = `${from}|${to}`;
  if (lunarRanges.has(key)) return lunarRanges.get(key);
  const promise = PC.api(`/meta/lunar?from=${from}&to=${to}`)
    .then((payload) => {
      const days = payload?.days ?? {};
      for (const [date, item] of Object.entries(days)) lunarDays.set(date, item);
      return days;
    })
    .catch(() => ({}));
  lunarRanges.set(key, promise);
  return promise;
}

/** 年视图换年：保留月日，月末溢出（2/29 -> 次年）夹到当月最后一天，别崩。 */
function addYearsKey(key, delta) {
  const date = PCUtil.toDate(key);
  const day = date.getDate();
  const target = new Date(date.getFullYear() + delta, date.getMonth(), 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return PCUtil.dateKey(target);
}

/**
 * 勾选 / 取消勾选待办。
 *
 * 「完成」是**待办独有**的语义：日程（时段）与日历事件都没有完成态，
 * 所以这里只可能是 /todos/:id/completed 一个入口。
 */
async function setTodoCompleted(id, completed) {
  try {
    const result = await PC.api(`/todos/${id}/completed`, { method: 'POST', body: { completed } });
    const cascaded = result?.cascaded ?? { completed: [], reverted: [] };
    // 完成父会连带完成所有后代（服务端级联）：必须把那 N 条说出来，
    // 否则用户只看到父行打勾，不知道子任务也被一起勾掉了。
    if (completed && cascaded.completed?.length) PC.toast(`已完成，并连带完成 ${cascaded.completed.length} 个子任务`);
    else if (!completed && cascaded.reverted?.length) PC.toast(`已恢复待办，并恢复 ${cascaded.reverted.length} 个连带完成的子任务`);
    else PC.toast(completed ? '已完成' : '已恢复待办');
    PC.refresh();
    return result;
  } catch (error) {
    PC.toast(error.message);
    return null;
  }
}

/** 删除一条待办。 */
async function removeTodo(id, title) {
  if (!window.confirm(`确定删除待办「${title}」？`)) return;
  try {
    await PC.api(`/todos/${id}`, { method: 'DELETE' });
    PC.toast(`已删除「${title}」`);
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

/* ---------------------------------------------------------------- 分类注册表 */
/* 分类不再是硬编码枚举：/categories 返回 { id, kind, key?, value, label, color, order, builtin, locked, inUse }。
   - `value` 是写进日程/事件的那个值（内置项是裸 key，如 class/study；自建项是自己的 id）；
   - 颜色用 CSSOM 写 --cat（`.cat-*` 类保留作兜底，CSP 禁止内联 style 属性，setProperty 不受限）。 */

const CATEGORY_GROUPS = { schedule: [], event: [] };
/** 最近一次拉取时间：refresh 很频繁，1 秒内复用缓存，避免每次重画都打一次接口。 */
let categoryFetchedAt = 0;
let categoryPending = null;
/** 数据版本：拿到新数据后自增，用来决定「要不要再刷一次界面」。 */
let categoryVersion = 0;

function categoryGroups() {
  return PC.state?.calendar?.categories ?? CATEGORY_GROUPS;
}

/** 分类写进记录的值就是它的 `id`（两个集合各自一套，所以不存在同名冲突）。 */
function catValue(item) {
  return item?.id;
}

function catOf(kind, value) {
  return (categoryGroups()[kind] ?? []).find((item) => catValue(item) === value);
}

/** 分类显示名：以注册表为准，未知 id 回退到静态表（kit/labels.js）。 */
function catLabel(kind, value) {
  return catOf(kind, value)?.label ?? CATEGORY_LABEL[value] ?? value ?? '其它';
}

/** 把分类色刷到元素上：注册表里有颜色就写 --cat，同时保留 cat-<id> 类做兜底。 */
function applyCategoryColor(node, kind, value) {
  const id = value ?? 'other';
  node.classList.add(`cat-${id}`);
  const color = catOf(kind, id)?.color;
  if (color) node.style.setProperty('--cat', color);
  return node;
}

/**
 * 拉分类注册表。缓存 1 秒；`force` 用于「刚改完分类」这种必须拿最新值的场景。
 * 结果同时写进 PC.state.calendar.categories，供所有视图同步读取。
 */
function ensureCategories({ force = false } = {}) {
  const fresh = categoryFetchedAt && !force && Date.now() - categoryFetchedAt < 1000;
  if (fresh) return Promise.resolve(categoryGroups());
  if (categoryPending && !force) return categoryPending;
  categoryPending = PC.api('/categories')
    .then(({ items }) => {
      const groups = { schedule: [], event: [] };
      for (const item of items ?? []) (groups[item.kind] ??= []).push(item);
      if (PC.state?.calendar) PC.state.calendar.categories = groups;
      categoryFetchedAt = Date.now();
      categoryPending = null;
      categoryVersion += 1;
      return groups;
    })
    .catch((error) => {
      categoryPending = null;
      throw error;
    });
  return categoryPending;
}

/**
 * 视图渲染时调用：先把当前（可能是缓存的）颜色画上去，若这次真的拉到了新数据就再刷一次。
 * 这样首屏不会因为等待接口而空白，颜色到了也会立刻生效（也覆盖了 WS data_changed 后的重拉）。
 */
function syncCategories() {
  const before = categoryVersion;
  ensureCategories()
    .then(() => {
      if (categoryVersion !== before) PC.refresh();
    })
    .catch(() => {
      /* 后端不可用时不阻塞渲染：颜色回退到 .cat-* 兜底 */
    });
}

/* ================================================================== 日历视图 */

const calendarView = {
  title: '日历',

  render(ctx) {
    const state = PC.state;
    syncCategories();
    if (state.calendar.mode === 'week' && state.panelCollapsed) state.calendar.mode = 'month';
    ctx.mount.innerHTML = '';
    ctx.mount.appendChild(calendarToolbar());
    const content = mk('div', 'view-content');
    ctx.mount.appendChild(content);
    const mode = state.calendar.mode;
    if (mode === 'year') renderYear(content, state.calendar.anchor);
    else if (mode === 'week') renderWeek(content, state.calendar.anchor);
    else if (mode === 'day') renderDay(content, state.calendar.anchor);
    else renderMonth(content, state.calendar.anchor);
  },
};

function calendarToolbar() {
  const state = PC.state;
  const bar = mk('div', 'toolbar');

  const seg = mk('div', 'seg');
  for (const [mode, label] of [['month', '月'], ['week', '周'], ['day', '日'], ['year', '年']]) {
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
  const mode = state.calendar.mode;
  const step = mode === 'day' ? 1 : mode === 'week' ? 7 : 0;
  const shift = (delta) => {
    if (mode === 'year') state.calendar.anchor = addYearsKey(state.calendar.anchor, delta);
    else if (step) state.calendar.anchor = PCUtil.addDays(state.calendar.anchor, delta * step);
    else state.calendar.anchor = PCUtil.addMonths(state.calendar.anchor, delta);
    PC.refresh();
  };
  const prev = iconBtn('上一页', '‹', () => shift(-1));
  const next = iconBtn('下一页', '›', () => shift(1));
  const today = mk('button', 'ghost-btn', '今天');
  today.type = 'button';
  today.addEventListener('click', () => {
    state.calendar.anchor = PCUtil.todayKey();
    PC.refresh();
  });
  nav.append(prev, today, next);

  const title = mk('div', 'toolbar-title');
  if (state.calendar.mode === 'year') title.textContent = `${PCUtil.toDate(state.calendar.anchor).getFullYear()} 年`;
  else if (state.calendar.mode === 'month') title.textContent = PCUtil.fmtYM(state.calendar.anchor);
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

/**
 * 月视图格子里的农历小字：
 * 节日当天显示节日名（优先于日名）；初一显示月名（闰月带「闰」）；其余显示日名。
 */
function lunarLineText(info) {
  if (info?.festivals?.length) return info.festivals[0];
  const lunar = info?.lunar;
  if (!lunar) return '';
  if (lunar.dayNumber === 1) return `${lunar.isLeapMonth ? '闰' : ''}${lunar.month ?? ''}`;
  return lunar.day ?? '';
}

/* ------------------------------------------------------------------ 年视图 */

/**
 * 年视图：4 列 × 3 行的迷你月（窄栏时 2 列）。
 * 有内容的日期在数字下加一个小圆点；点月份标题进月视图、点某天进日视图。
 * `/calendar` 失败时仍然把 12 个月骨架画出来（只是没有圆点）。
 */
function renderYear(host, anchor) {
  const year = PCUtil.toDate(anchor).getFullYear();
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const loading = mk('div', 'loading', '加载中…');
  host.appendChild(loading);

  fetchCalendar(from, to)
    .then((byDate) => {
      loading.remove();
      const grid = mk('div', 'year-grid');
      grid.style.setProperty('--year-cols', PC.state.panelCollapsed ? '2' : '4');
      for (let month = 0; month < 12; month += 1) grid.appendChild(miniMonth(year, month, byDate));
      grid.addEventListener('click', (event) => {
        const title = event.target.closest('.mini-title');
        if (title) {
          PC.state.calendar.anchor = title.dataset.month;
          PC.state.calendar.mode = 'month';
          PC.refresh();
          return;
        }
        const day = event.target.closest('.mini-day');
        if (!day) return;
        PC.state.calendar.anchor = day.dataset.date;
        PC.state.calendar.mode = 'day';
        PC.refresh();
      });
      host.appendChild(grid);
    })
    .catch(() => {
      loading.remove();
      // 拉不到数据也要能看：画出没有圆点的 12 个月
      const grid = mk('div', 'year-grid');
      grid.style.setProperty('--year-cols', PC.state.panelCollapsed ? '2' : '4');
      for (let month = 0; month < 12; month += 1) grid.appendChild(miniMonth(year, month, new Map()));
      host.appendChild(grid);
      host.appendChild(mk('div', 'eb-msg', '日历数据加载失败（只显示日期）'));
    });
}

/** 一个迷你月：标题（可点）+ 周标题行 + 6×7 的日数字。 */
function miniMonth(year, month, byDate) {
  const pad = (n) => String(n).padStart(2, '0');
  const box = mk('div', 'mini-month');
  const first = `${year}-${pad(month + 1)}-01`;
  const title = mk('button', 'mini-title', `${month + 1} 月`);
  title.type = 'button';
  title.dataset.month = first;
  title.title = `查看 ${year} 年 ${month + 1} 月`;
  box.appendChild(title);

  const head = mk('div', 'mini-head');
  for (const name of PCUtil.WEEK_CN) head.appendChild(mk('span', 'mini-weekday', name));
  box.appendChild(head);

  const grid = mk('div', 'mini-grid');
  const today = PCUtil.todayKey();
  const lastDay = new Date(year, month + 1, 0).getDate();
  const last = `${year}-${pad(month + 1)}-${pad(lastDay)}`;
  // 固定 6 行 × 7 列：12 个迷你月高度一致，4×3 网格才不会参差
  const start = PCUtil.startOfWeek(first);
  const end = PCUtil.addDays(start, 41);
  for (const date of PCUtil.eachDay(start, end)) {
    const cell = mk('div', 'mini-day');
    cell.dataset.date = date;
    if (date === today) cell.classList.add('today');
    if (date.slice(0, 7) !== first.slice(0, 7)) cell.classList.add('outside');
    if (date === PC.state.calendar.anchor) cell.classList.add('selected');
    cell.appendChild(mk('span', 'mini-num', PCUtil.toDate(date).getDate()));
    const day = byDate.get(date);
    const total = day ? (day.events?.length ?? 0) + (day.schedules?.length ?? 0) + (day.todos?.length ?? 0) : 0;
    if (total) cell.appendChild(mk('span', 'mini-dot'));
    grid.appendChild(cell);
  }
  box.appendChild(grid);
  return box;
}

/* ------------------------------------------------------------------ 月视图 */

function renderMonth(host, anchor) {
  const gridStart = PCUtil.startOfWeek(PCUtil.startOfMonth(anchor));
  const gridEnd = PCUtil.addDays(gridStart, 41);
  const loading = mk('div', 'loading', '加载中…');
  host.appendChild(loading);

  Promise.all([fetchCalendar(gridStart, gridEnd), fetchLunar(gridStart, gridEnd)])
    .then(([byDate]) => {
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

        // 农历小字：节日优先（accent 色），初一显示月名（闰月带「闰」），其余显示日名
        const lunar = lunarDays.get(date);
        const line = lunar ? mk('div', `cell-lunar${lunar.festivals?.length ? ' festival' : ''}`) : null;
        if (lunar) {
          const text = lunarLineText(lunar);
          if (text) {
            line.textContent = text;
            line.title = lunar.text ?? '';
          }
        }

        const dayTodos = day.todos ?? [];
        const headEl = mk('div', 'cell-head');
        headEl.appendChild(mk('span', 'dnum', PCUtil.toDate(date).getDate()));
        const total = day.events.length + day.schedules.length + dayTodos.length;
        if (total) headEl.appendChild(mk('span', 'dstat', `${day.stats?.todosCompleted ?? 0}/${total}`));

        const list = mk('div', 'cell-list');
        const chips = [
          ...day.events.map((item) => ({ kind: 'event', ...item })),
          ...day.schedules.map((item) => ({ kind: 'schedule', ...item })),
        ];
        for (const chip of chips.slice(0, 3)) list.appendChild(chipEl(chip));
        if (chips.length > 3) list.appendChild(mk('div', 'more', `+${chips.length - 3}`));

        // 待办用「小圆点」表达（参考实现的月视图做法）：今天截止=红、其它=蓝，最多 3 个
        const dots = mk('div', 'cell-dots');
        for (const todo of dayTodos.slice(0, 3)) {
          const dot = mk('span', `cell-dot${todo.isToday ? ' today' : ''}${todo.completed ? ' done' : ''}`);
          dot.title = todo.deadline ? `${todo.title}（截止 ${todo.deadline}）` : todo.title;
          dots.appendChild(dot);
        }
        if (dayTodos.length > 3) dots.appendChild(mk('span', 'cell-dot-more', `+${dayTodos.length - 3}`));

        const add = mk('button', 'cell-add', '+');
        add.type = 'button';
        add.title = '在这天新建';
        add.dataset.add = date;

        cell.append(headEl, list, dots, add);
        if (lunar && line) cell.appendChild(line);
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
  const node = applyCategoryColor(mk('div', 'chip'), chip.kind === 'event' ? 'event' : 'schedule', chip.category);
  if (chip.kind === 'event') node.classList.add('is-event');
  if (chip.startTime) node.appendChild(mk('span', 'c-time', chip.startTime));
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
        const day = byDate.get(date) ?? { events: [], schedules: [], todos: [], imported: [] };
        const col = mk('div', 'allday-col');

        // 日期粒度的事件
        for (const event of day.events) {
          const chip = applyCategoryColor(mk('div', 'ad-chip', event.title), 'event', event.category);
          chip.title = event.title;
          col.appendChild(chip);
        }
        // 当天截止的待办
        for (const todo of day.todos ?? []) {
          const chip = mk('div', `week-todo${todo.completed ? ' done' : ''}${todo.isToday ? ' today' : ''}`, todo.title);
          chip.title = `${todo.completed ? '已完成' : '待办'} · 预估 ${todo.estimatedHours ?? 1} 小时`;
          chip.addEventListener('click', () => openEditor({ target: 'todo', id: todo.id }));
          col.appendChild(chip);
        }
        // 历史遗留的导入日期锚点：只读
        for (const item of day.imported ?? []) {
          const chip = mk('div', 'week-todo imported', item.title);
          chip.title = '外部导入的日期锚点（只读）';
          chip.addEventListener('click', () => PC.toast('导入项，暂不支持编辑'));
          col.appendChild(chip);
        }

        const total = col.children.length;
        if (total > 4) {
          while (col.children.length > 4) col.children[col.children.length - 1].remove();
          col.appendChild(mk('div', 'more', `+${total - 4}`));
        }
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
        const timed = day.schedules.filter((item) => item.startTime);
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
  const node = applyCategoryColor(mk('div', 'block'), 'schedule', block.category);
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
/** 自动滚动后，目标小时的标签与吸顶条下沿之间留的间距（px）。 */
const DAY_SCROLL_GAP = 8;

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
      const timed = day.schedules.filter((item) => item.startTime);

      const wrap = mk('div', 'day-view');
      const hero = dayHero(anchor);
      const allDay = dayAllDay({ todos: day.todos ?? [], imported: day.imported ?? [] });
      const timeline = mk('div', 'day-timeline');
      wrap.append(hero, allDay, timeline);

      // 先入文档：这样才读得到 CSS 变量、量得出吸顶高度（detached 元素量不到）
      host.appendChild(wrap);
      loadLunar(anchor, hero);

      const hourHeight = readHourHeight(timeline);
      const hours = dayHours();
      timeline.appendChild(hours);
      const canvas = mk('div', 'day-canvas');
      // 重叠分列复用周视图的贪心分配（不改它的对外行为）
      for (const block of layoutBlocks(timed)) canvas.appendChild(dayBlock(block, hourHeight));
      if (anchor === PCUtil.todayKey()) canvas.appendChild(dayNowMark(hourHeight));
      timeline.appendChild(canvas);

      // 吸顶叠层：先把量到的顶栏高度写回 CSS（--day-hero-h 决定 .day-allday 的 sticky 位置），
      // 再量叠层的视觉下沿。**只按两个元素的高度求和是不够的**：sticky 的定位基准是滚动容器的
      // 内容框（.view-content 的 padding-top 不参与吸顶），叠加后真实遮住的高度会更大，
      // 直接量 .day-allday 的 rect.bottom 才是可靠基准。
      const heroHeight = hero.getBoundingClientRect().height;
      if (heroHeight) wrap.style.setProperty('--day-hero-h', `${heroHeight}px`);
      const occlusionBottom = allDay.getBoundingClientRect().bottom;

      // 目标小时：有日程就取「最早日程开始前一小时」，没有就 07:00（不强制滚到最顶）。
      // 让它的**标签**完整露在吸顶条下沿之下 8px——标签是居中画在整点线上的，
      // 若把整点线对齐到吸顶条下沿，标签就会被吞掉一半。
      // 两个 rect 都在视口坐标里：滚动 Δ 让内容上移 Δ、吸顶条不动，
      // 所以「还要再滚多少」= 标签当前相对吸顶条下沿的位置 − 目标间距。
      const target = timed.length
        ? Math.max(0, Math.min(...timed.map((item) => PCUtil.minutes(item.startTime))) - 60)
        : DAY_FIRST_MINUTE;
      const hourIndex = Math.max(0, Math.min(23, Math.floor(target / 60)));
      const labelNode = hours.children[hourIndex]?.querySelector('.day-hour-label');
      if (labelNode) {
        const delta = labelNode.getBoundingClientRect().top - occlusionBottom - DAY_SCROLL_GAP;
        host.scrollTop = Math.max(0, host.scrollTop + delta);
      }
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
  const show = (info) => {
    if (!info?.text || sub.querySelector('.day-hero-lunar')) return;
    const node = mk('span', 'day-hero-lunar', info.text);
    if (info.festivals?.length) node.appendChild(mk('span', 'day-festival', ` · ${info.festivals.join(' · ')}`));
    sub.appendChild(node);
    // 农历文字可能把顶栏撑高几像素，重新量一次吸顶偏移，避免全天行被压住
    // （与 renderDay 用同一个量法：rect 高度而不是取整的 offsetHeight）
    const wrap = hero.parentNode;
    const height = hero.getBoundingClientRect().height;
    if (wrap?.style?.setProperty && height) {
      wrap.style.setProperty('--day-hero-h', `${height}px`);
    }
  };
  if (lunarText.has(anchor)) {
    show(lunarText.get(anchor));
    return;
  }
  PC.api(`/meta/lunar?date=${anchor}`)
    .then((payload) => {
      lunarSupported = true;
      const info = lunarLabel(payload);
      lunarText.set(anchor, info);
      // 顺手填进按天缓存，月视图/年视图不会为同一天再请求一次
      lunarDays.set(anchor, { lunar: payload?.lunar, festivals: payload?.festivals ?? [], text: info.text });
      show(info);
    })
    .catch(() => {
      lunarSupported = false;
    });
}

/**
 * 从 /meta/lunar 的契约响应里取出可读文案与节日（契约见 core/routes.js）。
 * 闰月加「闰」前缀（`month` 字段本身不带闰字，闰由 `isLeapMonth` 表达）。
 */
function lunarLabel(payload) {
  const lunar = payload?.lunar ?? payload?.data?.lunar;
  let text = '';
  if (typeof lunar === 'string') text = lunar;
  else if (lunar && typeof lunar === 'object') {
    text = `${lunar.year ? `${lunar.year}年` : ''}${lunar.isLeapMonth ? '闰' : ''}${lunar.month ?? ''}${lunar.day ?? ''}`;
  }
  if (!text && typeof payload?.text === 'string') text = payload.text;
  return { text, festivals: payload?.festivals ?? payload?.data?.festivals ?? [] };
}

/* ---------------------------------------------------------------- 日视图：全天 */

/**
 * 日视图的「全天」行 = **当天截止的待办**（可勾选） + 历史遗留的导入项（只读）。
 *
 * 参考实现里这不是「全天事件」，而是右侧 TodoPanel：待办是今天要做完的事，
 * 挂在时间轴上方最自然。导入项没有复选框、灰显，因为它既不是待办也不是日程。
 */
function dayAllDay(day) {
  const row = mk('div', 'day-allday');
  row.appendChild(mk('div', 'day-allday-label', '全天'));
  const list = mk('div', 'day-allday-items');

  for (const todo of day.todos ?? []) {
    const chip = mk('div', `day-allday-item day-allday-todo${todo.completed ? ' done' : ''}`);
    const check = mk('button', 'day-todo-check', todo.completed ? '✓' : '');
    check.type = 'button';
    check.title = todo.completed ? '恢复待办' : '标记完成';
    check.addEventListener('click', (event) => {
      event.stopPropagation();
      setTodoCompleted(todo.id, !todo.completed);
    });
    chip.append(check, mk('span', null, todo.title), mk('span', 'day-allday-hours', `${todo.estimatedHours ?? 1}h`));
    chip.title = `${todo.title} · 截止今天 · ${todo.complexityLabel ?? ''}`;
    chip.addEventListener('click', () => openEditor({ target: 'todo', id: todo.id }));
    list.appendChild(chip);
  }

  for (const item of day.imported ?? []) {
    const chip = mk('div', 'day-allday-item day-allday-imported', item.title);
    chip.appendChild(mk('span', 'tag', '导入'));
    chip.title = '外部导入的日期锚点，只读';
    chip.addEventListener('click', () => PC.toast('导入项，暂不支持编辑'));
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
  const node = applyCategoryColor(mk('div', 'day-block'), 'schedule', block.category);
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
    todoState();
    // 「学习周报」是待办页的子功能（不占左栏入口）：打开时**替换**列表那一块内容，
    // 关掉就回到待办 —— 主列表不会被压扁，也不会让人误以为待办页变成了周报页。
    const weekly = weeklyPanel();
    if (weekly?.isOpen?.()) {
      const host = mk('section', 'todo-weekly-host');
      ctx.mount.appendChild(host);
      weekly.mount?.(host);
      return;
    }
    ctx.mount.appendChild(todoToolbar());
    // 分类筛选条在**列表之上**、与状态分段分开：分类是"看哪一类"，
    // 状态是"看哪种完成度"，两者可以叠加（例如「期末复习」+「未完成」）。
    const categoryBar = mk('div', 'todo-cat-bar');
    ctx.mount.appendChild(categoryBar);
    paintTodoCategoryBar(categoryBar);
    const list = mk('div', 'todo-list');
    ctx.mount.appendChild(list);
    renderTodoList(list);
  },
};

/** 学习周报面板：由 `views/weekly-panel.js` 通过 `PCModules.service('weeklyPanel')` 提供。 */
function weeklyPanel() {
  return window.PCModules?.getService?.('weeklyPanel') ?? null;
}

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
  const hours = mk('input', 'qa-hours');
  hours.type = 'number';
  hours.min = '0';
  hours.step = '0.5';
  hours.placeholder = '工时';
  hours.title = '预估工时（小时，默认 1）';
  const add = mk('button', 'primary-btn', '快速添加');
  add.type = 'button';

  const submit = async () => {
    const text = title.value.trim();
    if (!text) {
      title.focus();
      return;
    }
    // 日期留空就是"没有截止日"：以前这里偷偷填了今天，等于替用户编了个假期限
    const body = { title: text, deadline: date.value || null };
    const parsed = Number(hours.value);
    if (Number.isFinite(parsed) && parsed > 0) body.estimatedHours = parsed;
    // 正在筛某个分类时，快速添加默认就归到这个分类：否则新加的那条会立刻从列表里"消失"
    const activeCategory = todoState().category;
    if (activeCategory !== null) body.category = activeCategory;
    try {
      await PC.api('/todos', { method: 'POST', body });
      title.value = '';
      hours.value = '';
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
  quick.append(title, date, hours, add);

  // 「+ 添加」打开完整编辑器（优先级 / 标签 / 备注）
  const create = mk('button', 'primary-btn', '+ 新建待办');
  create.type = 'button';
  create.addEventListener('click', () => openEditor({ target: 'todo', defaults: {} }));

  const rollover = mk('button', 'ghost-btn', '顺延未完成到本周');
  rollover.type = 'button';
  rollover.addEventListener('click', async () => {
    try {
      const result = await PC.api('/todos/rollover', { method: 'POST', body: {} });
      PC.toast(result.moved ? `已顺延 ${result.moved} 条` : '没有需要顺延的待办');
      PC.refresh();
    } catch (error) {
      PC.toast(error.message);
    }
  });

  // 「学习周报」入口：与筛选 / 快速添加同一条工具条，一眼能找到；点开后替换下面的列表。
  const weekly = weeklyPanel();
  const weeklyBtn = mk('button', 'ghost-btn todo-weekly-btn', '学习周报');
  weeklyBtn.type = 'button';
  weeklyBtn.title = '打开学习周报（这一周的统计与历史，不占左栏入口）';
  weeklyBtn.setAttribute('aria-pressed', weekly?.isOpen?.() ? 'true' : 'false');
  weeklyBtn.addEventListener('click', () => {
    weeklyPanel()?.toggle?.();
    PC.refresh();
  });

  const row2 = mk('div', 'toolbar-row');
  row2.append(quick, create, rollover, weeklyBtn);
  bar.append(seg, row2);
  return bar;
}

/**
 * 待办页自己的视图状态（分类筛选 + 折叠的父任务）。
 *
 * 为什么在这里补默认值而不是改 shell/app.js：`state.todo` 由外壳创建，本视图是它的
 * 唯一使用者；外壳不该知道"待办还有分类筛选"这种领域细节（新增功能不回头改外壳）。
 */
function todoState() {
  const state = PC.state.todo;
  if (state.category === undefined) state.category = null; // null = 全部分类，'' = 未分类
  if (!state.collapsed || typeof state.collapsed !== 'object') state.collapsed = {}; // 默认全部展开
  return state;
}

/**
 * 分类筛选条：全部 / 未分类 / 各分类（带条数）。
 *
 * 计数来自 `GET /todos/categories`（而不是把当前列表自己数一遍）：
 * 只筛了一个分类时，列表里没有别的分类，自己数就永远只能数出当前这一栏。
 * 条数用 `total`（该分类共几条）；`open` 放进 title 里，鼠标悬停能看到还剩几条。
 */
async function paintTodoCategoryBar(bar) {
  const state = todoState();
  let items = [];
  try {
    items = (await PC.api('/todos/categories')).items ?? [];
  } catch {
    // 分类条拉不到不该把整个待办页拖垮：退化成只有「全部 / 未分类」
    items = [];
  }

  const total = items.reduce((sum, item) => sum + (item.total ?? 0), 0);
  const unknown = items.find((item) => item.name === '') ?? { total: 0, open: 0 };

  const scroll = mk('div', 'tcb-scroll');
  const chip = (name, label, count, open) => {
    const active = state.category === name;
    const button = mk('button', `cat-chip${active ? ' active' : ''}`, `${label} ${count}`);
    button.type = 'button';
    button.dataset.category = name ?? '__all__';
    button.title = `${label}：共 ${count} 条${open === undefined ? '' : ` · 未完成 ${open} 条`}`;
    button.addEventListener('click', () => {
      // 再点一次当前分类 = 取消筛选（不用专门做一个"清除"按钮）
      state.category = state.category === name && name !== null ? null : name;
      PC.refresh();
    });
    scroll.appendChild(button);
  };

  chip(null, '全部', total);
  chip('', '未分类', unknown.total ?? 0, unknown.open ?? 0);
  for (const item of items) if (item.name) chip(item.name, item.name, item.total, item.open);

  bar.replaceChildren(mk('span', 'tcb-label', '分类'), scroll);
}

/** 父任务是否被收起（默认展开；只有显式点过收起的才在 collapsed 里）。 */
function todoCollapsed(id) {
  return Boolean(todoState().collapsed[id]);
}

/**
 * 待办列表：数据全部来自 `/todos?tree=1`（待办是独立集合，不再从 schedules 里挑 allDay 行）。
 *
 * 分组顺序：**分类 → 顶层待办 → 子待办（缩进，最多 3 层）**。
 * 以前按截止日分桶；有了父子关系之后再按截止日平铺，子任务会和父任务被拆到不同桶里，
 * 用户看不出"这几步属于同一件事"。截止日仍显示在每行 meta 里，信息没丢。
 */
async function renderTodoList(host) {
  const state = PC.state;
  const todo = todoState();
  const today = PCUtil.todayKey();
  const weekStart = PCUtil.startOfWeek(today);
  const weekEnd = PCUtil.addDays(weekStart, 6);

  const params = new URLSearchParams({ tree: '1', limit: '300' });
  if (todo.filter === 'today') params.set('date', today);
  else if (todo.filter === 'week') {
    params.set('from', weekStart);
    params.set('to', weekEnd);
  } else if (todo.filter === 'overdue') params.set('overdue', '1');
  else if (todo.filter === 'done') {
    params.set('completed', 'true');
    params.set('limit', '100');
  }
  // `category=''` 是"未分类"这个具体的桶，必须原样带上（不能被 URLSearchParams 吞掉）
  if (todo.category !== null && todo.category !== undefined) params.set('category', todo.category);
  const query = `/todos?${params.toString()}`;

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

  const roots = payload.items ?? [];
  const stats = payload.stats ?? {};

  host.innerHTML = '';
  if (!roots.length) {
    host.appendChild(emptyBox(todoEmptyText(state.todo.filter)));
    renderTodoFooter(host, stats);
    return;
  }

  // 分类分组：条数多的在前；并列时未分类沉底（与 /todos/categories 的口径一致）
  const groups = new Map();
  for (const item of roots) {
    const name = item.category ?? '';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  const ordered = [...groups.entries()].sort((a, b) => {
    if (b[1].length !== a[1].length) return b[1].length - a[1].length;
    if (a[0] === '') return 1;
    if (b[0] === '') return -1;
    return a[0].localeCompare(b[0], 'zh-Hans-CN');
  });

  // 子任务总数要把孙辈也算进去（childCount 只算直接子级）
  const countDescendants = (item) => (item.children ?? []).reduce((sum, child) => sum + 1 + countDescendants(child), 0);
  for (const [name, list] of ordered) {
    const header = mk('div', 'group-head');
    const childTotal = list.reduce((sum, item) => sum + countDescendants(item), 0);
    header.append(
      mk('span', 'gh-date', name || '未分类'),
      mk('span', 'gh-count', `${list.length} 条${childTotal ? ` · 含 ${childTotal} 个子任务` : ''}`),
    );
    host.appendChild(header);
    const rows = mk('div', 'rows');
    appendTodoTree(rows, list, 1);
    host.appendChild(rows);
  }

  renderTodoFooter(host, stats);
}

/** 递归渲染一棵待办树（最多 3 层：服务端已保证不会更深）。 */
function appendTodoTree(rows, list, depth) {
  for (const item of list) {
    rows.appendChild(todoRow(item, depth));
    const children = item.children ?? [];
    if (!children.length || todoCollapsed(item.id)) continue;
    appendTodoTree(rows, children, depth + 1);
  }
}

/** 页脚：完成率与计划工时（口径来自 `/todos` 的 stats）。 */
function renderTodoFooter(host, stats) {
  if (!stats.total) return;
  const footer = mk('div', 'todo-stats');
  const rate = Math.max(0, Math.min(100, stats.completionRate ?? 0));
  footer.append(
    mk('span', 'ts-text', `${stats.completed}/${stats.total} 项完成 · 计划 ${stats.plannedHours ?? 0} 小时${stats.overdue ? ` · 逾期 ${stats.overdue}` : ''}`),
  );
  const bar = mk('div', 'progress');
  const fill = mk('div', 'progress-fill');
  fill.style.width = `${rate}%`;
  bar.appendChild(fill);
  footer.appendChild(bar);
  host.appendChild(footer);
}

function todoEmptyText(filter) {
  if (filter === 'done') return '还没有已完成的待办。';
  if (filter === 'overdue') return '没有逾期未完成的事项，保持住。';
  if (filter === 'today') return '今天没有待办，可以安排点新任务。';
  if (filter === 'week') return '本周还没有待办。';
  return '还没有待办，用上面的输入框添加一条。';
}

/** 复杂度色点：simple/normal/complex/heavy -> 绿/蓝/橙/红（沿用设计令牌）。 */
const COMPLEXITY_COLOR = {
  simple: 'var(--green)',
  normal: 'var(--blue)',
  complex: 'var(--orange)',
  heavy: 'var(--red)',
};

/**
 * 一行待办。
 *
 * `depth` 是层级（1 = 顶层，2 = 子，3 = 孙）：缩进只由 class 控制，
 * 不用 inline style（CSP 是 `style-src 'self'`，行内样式会被浏览器拦掉）。
 * 父行多两样东西：展开/收起箭头、`已完成子任务/子任务总数` 进度（如 2/3）。
 */
function todoRow(item, depth = 1) {
  const today = PCUtil.todayKey();
  const row = mk('div', `todo-row priority-${item.priority ?? 0} todo-level-${depth}`);
  if (item.completed) row.classList.add('done');
  if (item.isOverdue) row.classList.add('overdue');
  if (item.isToday) row.classList.add('today');
  if (item.hasChildren) row.classList.add('has-children');
  // 被父任务连带完成的子任务：给一个轻标记，让"我没勾它、它怎么完成了"有答案
  if (item.autoCompletedBy) row.classList.add('auto-done');

  const check = mk('button', 'check', item.completed ? '✓' : '');
  check.type = 'button';
  check.title = item.completed ? '恢复待办' : '标记完成';
  check.addEventListener('click', () => setTodoCompleted(item.id, !item.completed));

  const main = mk('div', 'tr-main');
  const titleLine = mk('div', 'tr-title');

  // 展开 / 收起：默认展开（`collapsed` 里没有它就是展开），只在有子任务时出现
  if (item.hasChildren) {
    const collapsed = todoCollapsed(item.id);
    const toggle = mk('button', 'todo-parent-toggle', collapsed ? '▸' : '▾');
    toggle.type = 'button';
    toggle.title = collapsed ? `展开 ${item.childCount} 个子任务` : '收起子任务';
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.addEventListener('click', () => {
      const state = todoState();
      if (collapsed) delete state.collapsed[item.id];
      else state.collapsed[item.id] = true;
      PC.refresh();
    });
    titleLine.appendChild(toggle);
  }

  titleLine.appendChild(mk('span', null, item.title));
  if (item.hasChildren) {
    titleLine.appendChild(mk('span', 'todo-progress', `${item.childDoneCount}/${item.childCount}`));
  }
  if (item.autoCompletedBy) {
    const tag = mk('span', 'tag auto', '连带完成');
    tag.title = '由父任务完成时连带勾上（取消父的完成会恢复它）';
    titleLine.appendChild(tag);
  }
  if (item.priority === 2) titleLine.appendChild(mk('span', 'tag urgent', '紧急'));
  else if (item.isOverdue) titleLine.appendChild(mk('span', 'tag late', '逾期'));
  main.appendChild(titleLine);

  const meta = mk('div', 'tr-meta');
  const dot = mk('span', 'complexity-dot');
  dot.style.background = COMPLEXITY_COLOR[item.complexity] ?? 'var(--fg-3)';
  meta.append(
    item.deadline
      ? mk('span', null, `截止 ${PCUtil.fmtCN(item.deadline)}`)
      : mk('span', 'todo-no-deadline', '无截止时间'),
    mk('span', null, item.deadline ? ` · ${PCUtil.relativeDay(item.deadline, today)}` : ''),
    mk('span', null, ` · ${item.completed ? '已完成' : '优先级'} `),
    mk('span', 'todo-priority', '★'.repeat(Math.max(1, (item.priority ?? 0) + 1))),
    mk('span', null, ' · '),
    dot,
    mk('span', null, `${item.complexityLabel ?? ''}（${item.estimatedHours ?? 1}h）`),
  );
  main.appendChild(meta);

  const actions = mk('div', 'ri-actions');
  actions.appendChild(iconBtn('编辑', '✎', () => openEditor({ target: 'todo', id: item.id })));
  actions.appendChild(iconBtn('删除', '🗑', () => removeTodo(item.id, item.title), 'danger'));

  row.append(check, main, actions);
  return row;
}

/* ============================================================ 设置页：分类管理 */
/* 通过 PCModules.registerSettingsSection 挂到「设置」视图里（见文件末尾的登记）。 */

/** 新增分类时的预设色板：前 5 个是项目主题色，其余是常用扩展色。 */
const CATEGORY_PALETTE = [
  '#6c8cff',
  '#5cdb8b',
  '#ffb86c',
  '#ff6b7a',
  '#c792ea',
  '#00c2a8',
  '#5e5ce6',
  '#ff8fbd',
  '#b6d94c',
  '#ffb400',
  '#83838f',
  '#4dd0e1',
];

/** 设置页区块：日程分类 + 日历事件分类。 */
function renderCategorySettings(mount) {
  mount.innerHTML = '';
  mount.appendChild(mk('div', 'loading', '加载中…'));
  ensureCategories({ force: true })
    .then((groups) => {
      mount.innerHTML = '';
      mount.appendChild(categoryBlock('schedule', '日程分类', groups.schedule ?? []));
      mount.appendChild(categoryBlock('event', '日历事件分类', groups.event ?? []));
    })
    .catch((error) => {
      mount.innerHTML = '';
      mount.appendChild(mk('div', 'eb-msg', `分类加载失败：${error.message}`));
    });
}

function categoryBlock(kind, title, items) {
  const box = mk('div', 'cat-block');
  box.appendChild(mk('div', 'section-title', title));
  for (const item of items) box.appendChild(categoryRow(item));
  box.appendChild(categoryCreateRow(kind));
  return box;
}

/**
 * 写分类 + 刷新（任何写操作成功后都重新拉一次并整页刷新）。
 * id 路由必须带 `kind`：两个集合共用 study/exam/other 这些内置 id。
 */
async function saveCategory(kind, id, patch, method = 'PATCH') {
  try {
    await PC.api(`/categories/${id}?kind=${kind}`, {
      method,
      body: method === 'DELETE' ? undefined : patch,
    });
    await ensureCategories({ force: true });
    PC.refresh();
    return true;
  } catch (error) {
    PC.toast(error.message);
    return false;
  }
}

function categoryRow(item) {
  const row = mk('div', 'cat-row');
  const dot = mk('span', 'cat-dot');
  dot.style.background = item.color;
  const name = mk('span', 'cat-name', item.label);
  row.append(dot, name, mk('span', 'cat-use', `在用 ${item.inUse} 条`), mk('div', 'spacer'));

  const rename = mk('button', 'ghost-btn', '改名');
  rename.type = 'button';
  // 行内改名：**不用原生 prompt 弹窗**（Electron 渲染进程里 prompt() 会抛 "prompt() is not supported."）
  rename.addEventListener('click', () => {
    if (row.querySelector('.cat-rename-input')) return;
    const input = mk('input', 'cat-rename-input');
    input.type = 'text';
    input.value = item.label;
    input.maxLength = 12;
    name.replaceWith(input);
    input.focus();
    input.select();

    let settled = false;
    const restore = () => input.replaceWith(name);
    const finish = async (save) => {
      if (settled) return;
      settled = true;
      const next = input.value.trim();
      if (!save || !next || next === item.label) {
        restore();
        return;
      }
      if (await saveCategory(item.kind, item.id, { label: next })) PC.toast(`已改名为「${next}」`);
      else restore();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.stopPropagation();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  });

  const color = mk('input', 'cat-color');
  color.type = 'color';
  color.value = item.color;
  color.title = '改颜色';
  color.addEventListener('change', async () => {
    if (await saveCategory(item.kind, item.id, { color: color.value })) PC.toast(`「${item.label}」的颜色已更新`);
    else color.value = item.color;
  });

  row.append(rename, color);

  if (!item.locked) {
    const del = mk('button', 'ghost-btn danger', '删除');
    del.type = 'button';
    del.addEventListener('click', async () => {
      const hint = item.inUse
        ? `「${item.label}」下还有 ${item.inUse} 条记录，删除后这些记录会变成「其它」。确定删除？`
        : `确定删除分类「${item.label}」？`;
      if (!window.confirm(hint)) return;
      try {
        const result = await PC.api(`/categories/${item.id}?kind=${item.kind}`, { method: 'DELETE' });
        await ensureCategories({ force: true });
        PC.toast(`已删除${result.reassigned ? `，${result.reassigned} 条记录改为「其它」` : ''}`);
        PC.refresh();
      } catch (error) {
        PC.toast(error.message);
      }
    });
    row.appendChild(del);
  }
  return row;
}

function categoryCreateRow(kind) {
  const row = mk('div', 'cat-create');
  const input = mk('input', 'cat-input');
  input.type = 'text';
  input.placeholder = '新分类名称（≤12 字）';
  input.maxLength = 12;

  let color = CATEGORY_PALETTE[0];
  const custom = mk('input', 'cat-color');
  custom.type = 'color';
  custom.value = color;
  const swatches = mk('div', 'cat-swatches');
  const buttons = [];
  const mark = () => {
    for (const button of buttons) button.classList.toggle('active', button.dataset.color === color);
  };
  for (const preset of CATEGORY_PALETTE) {
    const swatch = mk('button', 'cat-swatch');
    swatch.type = 'button';
    swatch.dataset.color = preset;
    swatch.style.background = preset;
    swatch.title = preset;
    swatch.addEventListener('click', () => {
      color = preset;
      custom.value = preset;
      mark();
    });
    buttons.push(swatch);
    swatches.appendChild(swatch);
  }
  custom.addEventListener('input', () => {
    color = custom.value;
    mark();
  });
  mark();

  const add = mk('button', 'primary-btn', '添加');
  add.type = 'button';
  add.addEventListener('click', async () => {
    const label = input.value.trim();
    if (!label) {
      input.focus();
      return;
    }
    try {
      await PC.api('/categories', { method: 'POST', body: { kind, label, color } });
      await ensureCategories({ force: true });
      PC.toast(`已添加分类「${label}」`);
      PC.refresh();
    } catch (error) {
      PC.toast(error.message);
    }
  });

  row.append(input, swatches, custom, add);
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

const EDITOR_PATH = { schedule: '/schedules', event: '/events', todo: '/todos' };

function openEditor(options = {}) {
  const state = { target: options.target ?? 'schedule', id: options.id ?? null, defaults: options.defaults ?? {} };
  if (state.id) {
    const path = `${EDITOR_PATH[state.target] ?? '/schedules'}/${state.id}`;
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
    ['todo', '待办'],
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
  const formOf = { todo: todoForm, schedule: scheduleForm, event: eventForm };
  body.appendChild((formOf[state.target] ?? scheduleForm)(item, state.defaults));
  const error = mk('div', 'modal-error');

  const foot = mk('div', 'modal-foot');
  if (isEdit) {
    const del = mk('button', 'danger-btn ghost', '删除');
    del.type = 'button';
    del.addEventListener('click', async () => {
      close();
      if (state.target === 'todo') await removeTodo(state.id, item.title);
      else await removeRecord(state.target, state.id, item.title);
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
    const collectors = { todo: collectTodo, schedule: collectSchedule, event: collectEvent };
    const payload = (collectors[state.target] ?? collectSchedule)(body);
    if (!payload.title || !payload.title.trim()) {
      error.textContent = '请填写标题';
      return;
    }
    error.textContent = '';
    try {
      let conflicts = 0;
      const base = EDITOR_PATH[state.target] ?? '/schedules';
      if (state.target === 'schedule') {
        if (state.id) {
          await PC.api(`${base}/${state.id}`, { method: 'PATCH', body: payload });
        } else {
          const result = await PC.api(base, { method: 'POST', body: payload });
          conflicts = result.conflicts?.length ?? 0;
        }
      } else if (state.id) {
        await PC.api(`${base}/${state.id}`, { method: 'PATCH', body: payload });
      } else {
        await PC.api(base, { method: 'POST', body: payload });
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

  const start = mk('input', 'f-start');
  start.type = 'time';
  start.value = data.startTime ?? '';
  const end = mk('input', 'f-end');
  end.type = 'time';
  end.value = data.endTime ?? '';
  const timeRow = mk('div', 'inline-2');
  timeRow.append(field('开始', start), field('结束', end));
  wrap.appendChild(timeRow);

  const category = categoryPicker('schedule', data.category);
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

  // 日程必须是时段：起止时刻是必填信息，没有「全天」这种形态（只有日期请用待办）
  start.required = true;
  return wrap;
}

/**
 * 分类下拉（自绘，带色点）：像 iOS 日历那样一眼看出每个分类的颜色。
 *
 * 契约：根节点保持 `.f-category` 类，选中值放 `dataset.value`（= 写库用的分类值），
 * 因此 `collectSchedule/collectEvent` 的 `body.querySelector('.f-category').dataset.value` 照常可用。
 * 键盘：Esc 关闭；鼠标：点外面关闭。
 */
function categoryPicker(kind, current) {
  const root = mk('div', 'f-category category-picker');
  root.dataset.value = current ?? 'other';
  const trigger = mk('button', 'cp-trigger');
  trigger.type = 'button';
  const list = mk('div', 'cp-list hidden');
  let open = false;

  const close = () => {
    open = false;
    list.classList.add('hidden');
    document.removeEventListener('pointerdown', onOutside, true);
  };
  const onOutside = (event) => {
    if (!root.contains(event.target)) close();
  };
  const toggle = () => {
    open = !open;
    list.classList.toggle('hidden', !open);
    if (open) document.addEventListener('pointerdown', onOutside, true);
    else document.removeEventListener('pointerdown', onOutside, true);
  };

  const paint = () => {
    const cats = categoryGroups()[kind] ?? [];
    const selected = root.dataset.value;
    const hit = cats.find((item) => catValue(item) === selected);
    const dot = mk('span', 'cp-dot');
    if (hit) dot.style.background = hit.color;
    trigger.replaceChildren(dot, mk('span', 'cp-label', hit?.label ?? CATEGORY_LABEL[selected] ?? selected), mk('span', 'cp-caret', '▾'));

    list.replaceChildren();
    for (const item of cats) {
      const value = catValue(item);
      const option_ = mk('button', `cp-option${value === selected ? ' active' : ''}`);
      option_.type = 'button';
      const optionDot = mk('span', 'cp-dot');
      optionDot.style.background = item.color;
      option_.append(optionDot, mk('span', 'cp-label', item.label), mk('span', 'cp-check', value === selected ? '✓' : ''));
      option_.addEventListener('click', () => {
        root.dataset.value = value;
        close();
        paint();
      });
      list.appendChild(option_);
    }
  };

  trigger.addEventListener('click', toggle);
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) {
      event.stopPropagation(); // 别把弹层一起关掉
      close();
    }
  });
  paint();
  // 首次打开时分类可能还没拉到：拉完再画一遍（自己刷新自己，不需要整页重绘）
  ensureCategories().then(paint).catch(() => {});
  root.append(trigger, list);
  return root;
}

/**
 * 填「父待办」下拉的候选：顶层 + 第二层的待办（新任务挂上去最多成为第 3 层）。
 *
 * 排除自己与自己的后代 —— 服务端也会拦（PARENT_CYCLE），但界面不该先让人选出一个
 * 注定失败的选项。层级用「·」前缀表达缩进，避免在 select 里堆一长串缩进空格。
 */
function loadTodoParentOptions(select, selfId, current) {
  PC.api('/todos?tree=1&limit=300')
    .then((payload) => {
      const blocked = new Set();
      const markBlocked = (node) => {
        blocked.add(node.id);
        for (const child of node.children ?? []) markBlocked(child);
      };
      const heightOf = (node) => {
        const children = node.children ?? [];
        return children.length ? 1 + Math.max(...children.map(heightOf)) : 1;
      };
      let selfHeight = 1;
      const findSelf = (node) => {
        if (node.id === selfId) {
          markBlocked(node);
          selfHeight = heightOf(node); // 自己下面还有几层，决定"还能往上挂多深"
        }
        for (const child of node.children ?? []) findSelf(child);
      };
      for (const root of payload.items ?? []) findSelf(root);

      // 新任务（或叶子）能挂到第 2 层，成为第 3 层；本身带子树的只能挂到更浅的位置，
      // 否则后代会被一起压到第 4 层（服务端也会 400，但界面不该先给一个注定失败的选项）。
      const maxParentDepth = 3 - selfHeight;
      const add = (nodes, depth) => {
        if (depth > maxParentDepth) return;
        for (const node of nodes) {
          if (blocked.has(node.id)) continue; // 自己 / 后代：不能当父
          if (node.id !== current) {
            const prefix = depth > 1 ? `${'· '.repeat(depth - 1)}` : '';
            select.appendChild(option(node.id, `${prefix}${node.title}`, false));
          }
          add(node.children ?? [], depth + 1);
        }
      };
      add(payload.items ?? [], 1);
      select.value = current;
    })
    .catch(() => {
      // 拉不到候选时保留「无 / 当前父级」两项：不阻塞编辑其它字段
    });
}

/**
 * 待办编辑器：标题 / 截止日 / 优先级 / 预估小时 / 备注 / 标签 / 分类 / 父待办。
 * 标签用逗号或空格分隔的普通文本框，不引入额外依赖。
 */
function todoForm(item, defaults) {
  const data = item ?? {
    // 新建时不预填日期：留空就是"没有截止日"（用户明确要求待办可以不设截止日期）
    deadline: defaults.deadline ?? '',
    priority: 0,
    estimatedHours: 1,
    tags: [],
  };
  const wrap = mk('div', 'form-grid');

  const title = mk('input', 'in-title');
  title.type = 'text';
  title.value = data.title ?? '';
  title.placeholder = '例如：交实验报告';
  wrap.appendChild(field('标题', title));

  const deadline = mk('input', 'f-deadline');
  deadline.type = 'date';
  deadline.value = data.deadline ?? '';
  const priority = mk('select', 'f-priority');
  for (const key of [0, 1, 2]) priority.appendChild(option(key, PRIORITY_LABEL[key], Number(data.priority ?? 0) === key));
  const inline1 = mk('div', 'inline-2');
  inline1.append(field('截止日（可不填）', deadline), field('优先级', priority));
  wrap.appendChild(inline1);

  const hours = mk('input', 'f-hours');
  hours.type = 'number';
  hours.min = '0';
  hours.step = '0.5';
  hours.value = data.estimatedHours ?? 1;
  const tags = mk('input', 'f-tags');
  tags.type = 'text';
  tags.value = (data.tags ?? []).join('、');
  tags.placeholder = '标签，用「、」或逗号分隔';
  const inline2 = mk('div', 'inline-2');
  inline2.append(field('预估工时（小时）', hours), field('标签', tags));
  wrap.appendChild(inline2);

  /**
   * 分类：自由输入 + 已有分类的 datalist 建议。
   *
   * 为什么不是下拉：分类是用户自己的词（"期末复习" / "实验室" / "英语六级"），
   * 预设枚举会逼他改词；下拉又没法输入新分类。`<input list>` 两者兼得，
   * 建议列表来自 `GET /todos/categories`，用户照样可以打一个新的。
   */
  const category = mk('input', 'f-todo-category');
  category.type = 'text';
  category.maxLength = 24;
  category.value = data.category ?? '';
  category.placeholder = '例如：期末复习（留空 = 未分类）';
  category.setAttribute('list', 'todo-category-suggestions');
  const datalist = mk('datalist');
  datalist.id = 'todo-category-suggestions';
  PC.api('/todos/categories')
    .then((payload) => {
      for (const row of payload.items ?? []) {
        if (!row.name) continue; // 未分类不需要建议
        const suggest = mk('option');
        suggest.value = row.name;
        datalist.appendChild(suggest);
      }
    })
    .catch(() => {});

  /**
   * 父待办：只列**顶层与第二层**（再深就成第 4 层了，服务端会 400），
   * 并排除自己与自己的后代（否则用户能选出一个环）。
   * 候选项异步补进 select；编辑时先把"当前父级"放进去，避免加载期间保存把父级清空。
   */
  const parent = mk('select', 'f-parent');
  parent.appendChild(option('', '（无：作为顶层待办）', !data.parentId));
  if (data.parentId) parent.appendChild(option(data.parentId, '当前父待办', true));
  loadTodoParentOptions(parent, data.id ?? null, data.parentId ?? '');

  const inline3 = mk('div', 'inline-2');
  inline3.append(field('分类', category), field('父待办', parent));
  wrap.appendChild(inline3);
  wrap.appendChild(datalist);

  const description = mk('textarea', 'f-desc');
  description.rows = 2;
  description.value = data.description ?? '';
  description.placeholder = '备注（可选）';
  wrap.appendChild(field('备注', description));

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

  wrap.appendChild(field('分类', categoryPicker('event', data.category)));

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
  // 日程没有 allDay / status：起止时刻就是它的全部时间信息
  const payload = {
    title: body.querySelector('.in-title').value.trim(),
    date: body.querySelector('.f-date').value,
    category: body.querySelector('.f-category')?.dataset.value,
    priority: Number(body.querySelector('.f-priority').value),
    estimatedMinutes: body.querySelector('.f-estimated').value
      ? Number(body.querySelector('.f-estimated').value)
      : undefined,
    location: body.querySelector('.f-location').value,
    description: body.querySelector('.f-desc').value,
    repeat: body.querySelector('.repeat-block')._read(),
  };
  payload.startTime = body.querySelector('.f-start').value || undefined;
  payload.endTime = body.querySelector('.f-end').value || undefined;
  const reminder = body.querySelector('.f-reminder').value;
  payload.reminders = reminder === '' ? [] : [{ offsetMinutes: Number(reminder) }];
  return payload;
}

function collectTodo(body) {
  const hours = Number(body.querySelector('.f-hours').value);
  return {
    title: body.querySelector('.in-title').value.trim(),
    deadline: body.querySelector('.f-deadline').value,
    priority: Number(body.querySelector('.f-priority').value),
    estimatedHours: Number.isFinite(hours) && hours > 0 ? hours : 1,
    // 分类是自由文本（空串 = 未分类）；parentId 为空表示顶层
    category: body.querySelector('.f-todo-category')?.value.trim() ?? '',
    parentId: body.querySelector('.f-parent')?.value || null,
    tags: body
      .querySelector('.f-tags')
      .value.split(/[、,，\s]+/)
      .map((tag) => tag.trim())
      .filter(Boolean),
    description: body.querySelector('.f-desc').value,
  };
}

function collectEvent(body) {
  return {
    title: body.querySelector('.in-title').value.trim(),
    startDate: body.querySelector('.f-start-date').value,
    endDate: body.querySelector('.f-end-date').value || undefined,
    category: body.querySelector('.f-category')?.dataset.value,
    allDay: true,
    description: body.querySelector('.f-desc').value,
    repeat: body.querySelector('.repeat-block')._read(),
  };
}

/* ------------------------------------------------------------------ 登记到外壳 */

// 往「设置」页挂一块「日程分类」：外壳只按 order 摆位置，UI 完全由本模块提供。
window.PCModules.registerSettingsSection({
  id: 'calendar.categories',
  title: '日程',
  order: 20,
  render: (mount) => renderCategorySettings(mount),
});

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
