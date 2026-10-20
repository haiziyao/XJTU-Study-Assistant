/**
 * 手机外壳的纯逻辑：日期、分组、路由解析。不碰 DOM，单测直接在 vm 里求值
 * （见 test/mobile-shell.test.js）。页面代码只从这里取"算出来的结果"，自己只管摆放。
 */
window.PCMobileLogic = (function () {
  'use strict';

  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const pad = (n) => String(n).padStart(2, '0');

  /* ------------------------------------------------------------ 日期 */

  function keyOf(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  function parseKey(key) {
    const [y, m, d] = String(key).split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }
  function todayKey(now = new Date()) {
    return keyOf(now);
  }
  function addDays(key, n) {
    const date = parseKey(key);
    date.setDate(date.getDate() + n);
    return keyOf(date);
  }
  /** a - b 的天数差（按本地日期，不受夏令时影响）。 */
  function diffDays(a, b) {
    return Math.round((parseKey(a) - parseKey(b)) / 86400000);
  }
  /** 周一为一周第一天（与桌面日历一致）。 */
  function weekStart(key) {
    const day = parseKey(key).getDay();
    return addDays(key, day === 0 ? -6 : 1 - day);
  }
  function weekDays(key) {
    const start = weekStart(key);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }
  /** 月视图固定 6 行 42 格，切月时高度不跳。 */
  function monthMatrix(key) {
    const start = weekStart(`${String(key).slice(0, 7)}-01`);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }
  function addMonths(key, n) {
    const date = parseKey(`${String(key).slice(0, 7)}-01`);
    date.setMonth(date.getMonth() + n);
    return keyOf(date);
  }
  function sameMonth(a, b) {
    return String(a).slice(0, 7) === String(b).slice(0, 7);
  }
  function weekdayLabel(key) {
    return `周${WEEK[parseKey(key).getDay()]}`;
  }
  function weekdayShort(key) {
    return WEEK[parseKey(key).getDay()];
  }
  function monthDay(key) {
    const date = parseKey(key);
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  function monthTitle(key) {
    const date = parseKey(key);
    return `${date.getFullYear()}年${date.getMonth() + 1}月`;
  }
  /** 列表分组标题用："今天" / "明天" / "昨天" / "10月22日 周四"。 */
  function dayTitle(key, today = todayKey()) {
    const diff = diffDays(key, today);
    if (diff === 0) return '今天';
    if (diff === 1) return '明天';
    if (diff === -1) return '昨天';
    return `${monthDay(key)} ${weekdayLabel(key)}`;
  }
  /** 待办截止日的短标签。 */
  function dueLabel(deadline, today = todayKey()) {
    if (!deadline) return '';
    const diff = diffDays(deadline, today);
    if (diff === 0) return '今天';
    if (diff === 1) return '明天';
    if (diff < 0) return `逾期 ${-diff} 天`;
    if (diff < 7) return weekdayLabel(deadline);
    return monthDay(deadline);
  }
  /** 列表右侧的更新时间："刚刚" / "5 分钟前" / "14:20" / "昨天" / "10月3日" / "2025/3/1"。 */
  function relativeTime(iso, now = Date.now()) {
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) return '';
    const seconds = Math.max(0, Math.round((now - time) / 1000));
    if (seconds < 60) return '刚刚';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
    const date = new Date(time);
    const ref = new Date(now);
    if (keyOf(date) === keyOf(ref)) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    if (diffDays(keyOf(ref), keyOf(date)) === 1) return '昨天';
    if (date.getFullYear() === ref.getFullYear()) return monthDay(keyOf(date));
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  }
  function greeting(hour = new Date().getHours()) {
    if (hour < 5) return '夜深了';
    if (hour < 11) return '早上好';
    if (hour < 13) return '中午好';
    if (hour < 18) return '下午好';
    return '晚上好';
  }

  /* ------------------------------------------------------------ 待办 */

  const byDeadline = (a, b) =>
    String(a.deadline ?? '').localeCompare(String(b.deadline ?? '')) || (b.priority ?? 0) - (a.priority ?? 0);

  /**
   * 待办分组：逾期 / 今天 / 以后 / 没有截止日期 / 已完成。空组不返回。
   * 已完成按完成时间倒序，其余按截止日升序、同一天紧急的在前。
   */
  function groupTodos(items, today = todayKey()) {
    const groups = { overdue: [], today: [], upcoming: [], none: [], done: [] };
    for (const item of items ?? []) {
      if (item.completed) groups.done.push(item);
      else if (!item.deadline) groups.none.push(item);
      else if (item.deadline < today) groups.overdue.push(item);
      else if (item.deadline === today) groups.today.push(item);
      else groups.upcoming.push(item);
    }
    groups.overdue.sort(byDeadline);
    groups.today.sort(byDeadline);
    groups.upcoming.sort(byDeadline);
    groups.none.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    groups.done.sort((a, b) => String(b.completedAt ?? '').localeCompare(String(a.completedAt ?? '')));
    return [
      { key: 'overdue', title: '已逾期', items: groups.overdue },
      { key: 'today', title: '今天', items: groups.today },
      { key: 'upcoming', title: '以后', items: groups.upcoming },
      { key: 'none', title: '没有截止日期', items: groups.none },
      { key: 'done', title: '已完成', items: groups.done },
    ].filter((group) => group.items.length);
  }

  /* ------------------------------------------------------------ 日历 */

  /**
   * 把 `/calendar` 聚合接口里的一天摊平成一条时间线：全天事项在前，日程按开始时间，待办殿后。
   * `target` / `id` 直接对应 `PC.openEditor({ target, id })`。
   */
  function dayAgenda(day) {
    const rows = [];
    for (const item of day?.events ?? []) {
      rows.push({ kind: 'event', target: 'event', id: item.eventId ?? item.id, title: item.title, allDay: true, sort: '00:00', category: item.category, location: item.location });
    }
    for (const item of day?.imported ?? []) {
      rows.push({ kind: 'schedule', target: 'schedule', id: item.scheduleId ?? item.id, title: item.title, allDay: true, sort: '00:00', category: item.category, location: item.location });
    }
    for (const item of day?.schedules ?? []) {
      rows.push({
        kind: 'schedule',
        target: 'schedule',
        id: item.scheduleId ?? item.id,
        title: item.title,
        allDay: !item.startTime,
        start: item.startTime ?? '',
        end: item.endTime ?? '',
        sort: item.startTime ?? '00:00',
        category: item.category,
        location: item.location,
      });
    }
    for (const item of day?.todos ?? []) {
      rows.push({ kind: 'todo', target: 'todo', id: item.id, title: item.title, done: Boolean(item.completed), sort: '99:99', priority: item.priority ?? 0 });
    }
    return rows.sort((a, b) => a.sort.localeCompare(b.sort));
  }

  /** 日期格上的"有事"标记：最多三个点，分别代表 日程/全天 · 待办。 */
  function dayMarks(day) {
    if (!day) return [];
    const marks = [];
    if ((day.schedules?.length ?? 0) + (day.imported?.length ?? 0) > 0) marks.push('schedule');
    if ((day.events?.length ?? 0) > 0) marks.push('event');
    if ((day.todos ?? []).some((item) => !item.completed)) marks.push('todo');
    return marks;
  }

  /* ------------------------------------------------------------ 路由 */

  const TABS = ['today', 'calendar', 'ai', 'notes', 'me'];
  /** 老链接（`#calendar`、`?view=notes`）里的模块 id → 手机标签页。 */
  const TAB_OF_MODULE = { chat: 'ai', calendar: 'calendar', notes: 'notes', todo: 'today' };

  /**
   * 从地址解析启动位置。支持三种来源：
   *   `#m/notes`               手机外壳自己写的地址；
   *   `?view=notes&note=<id>`  笔记编辑页"返回"带回来的地址；
   *   `#calendar` / `#lms`      旧版手机布局的地址（分享链接、主屏图标）。
   * 不认识的模块 id 放进"我的"标签下以二级页打开（`module`）。
   */
  function parseRoute(search = '', hash = '', hasModule = () => false) {
    const params = new URLSearchParams(search);
    const raw = decodeURIComponent(String(hash).replace(/^#/, '')).trim();
    const route = { tab: 'today', note: params.get('note') || null, module: null, todos: false };
    const fromModule = (id) => {
      if (!id) return false;
      if (TABS.includes(id)) {
        route.tab = id;
        return true;
      }
      if (id === 'todo') route.todos = true;
      if (TAB_OF_MODULE[id]) {
        route.tab = TAB_OF_MODULE[id];
        return true;
      }
      if (hasModule(id)) {
        route.tab = 'me';
        route.module = id;
        return true;
      }
      return false;
    };
    if (raw.startsWith('m/')) fromModule(raw.slice(2).split('/')[0]);
    else if (!fromModule(params.get('view'))) fromModule(raw);
    if (route.note) route.tab = 'notes';
    return route;
  }

  return {
    TABS,
    TAB_OF_MODULE,
    keyOf,
    parseKey,
    todayKey,
    addDays,
    diffDays,
    weekStart,
    weekDays,
    monthMatrix,
    addMonths,
    sameMonth,
    weekdayLabel,
    weekdayShort,
    monthDay,
    monthTitle,
    dayTitle,
    dueLabel,
    relativeTime,
    greeting,
    groupTodos,
    dayAgenda,
    dayMarks,
    parseRoute,
  };
})();
