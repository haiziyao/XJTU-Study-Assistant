/**
 * 前后端共用的纯函数工具（日期、颜色、转义、格式化）。
 *
 * 这是 classic script，向全局暴露 `window.PCUtil`；不依赖任何 DOM 与 PC 状态，
 * 因此各视图、外壳都可以直接使用。
 */

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
