/**
 * 日历渲染层结构测试（年视图 / 月视图农历 / 日视图农历）。
 *
 * 用 `test/helpers/renderer-dom.js` 的 DOM 桩真实跑一遍 `render()`，再断言节点结构 ——
 * 比 grep 源码字符串稳（改名/挪位置都还能查出来），又能跑在 node:test 里。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootRenderer } from './helpers/renderer-dom.js';

const TODAY = '2026-10-11';
const ANCHOR = '2026-10-12';

/** 伪后端：只回渲染需要的三张接口，形状与真实后端一致。 */
function makeApi() {
  const calls = [];
  const api = async (url) => {
    calls.push(url);
    if (url.startsWith('/categories')) {
      return {
        items: [
          { id: 'class', kind: 'schedule', label: '上课', color: '#6c8cff', order: 10, builtin: true, locked: false, inUse: 1 },
          { id: 'meeting', kind: 'schedule', label: '会议', color: '#c792ea', order: 30, builtin: true, locked: false, inUse: 1 },
          { id: 'other', kind: 'schedule', label: '其它', color: '#83838f', order: 60, builtin: true, locked: true, inUse: 0 },
          { id: 'exam', kind: 'event', label: '考试', color: '#ff6b7a', order: 20, builtin: true, locked: false, inUse: 0 },
        ],
      };
    }
    if (url.startsWith('/calendar')) {
      const days = [
        {
          date: ANCHOR,
          events: [],
          schedules: [{ scheduleId: 's1', title: '项目周会', category: 'meeting', startTime: '15:00', endTime: '16:00' }],
          todos: [],
          imported: [],
          stats: { events: 0, schedules: 1, todos: 0, todosCompleted: 0, imported: 0 },
        },
      ];
      return { days };
    }
    if (url.startsWith('/meta/lunar?')) {
      // 批量模式：返回区间内每一天（形状与 /meta/lunar?from&to 一致）
      const params = new URLSearchParams(url.split('?')[1]);
      const from = params.get('from');
      const days = {};
      if (from) {
        const start = new Date(`${from}T00:00:00Z`);
        for (let i = 0; i < 42; i += 1) {
          const date = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
          const isFirst = date.endsWith('-01');
          days[date] = {
            lunar: { year: '丙午', zodiac: '马', month: '九月', day: isFirst ? '初一' : '初三', isLeapMonth: false, monthNumber: 10, dayNumber: isFirst ? 1 : 3 },
            festivals: date === '2026-10-18' ? ['重阳'] : [],
            text: '丙午年九月初三',
          };
        }
      }
      return { from, to: params.get('to'), days };
    }
    return {};
  };
  api.calls = calls;
  return api;
}

function state() {
  return {
    calendar: { mode: 'month', anchor: ANCHOR, categories: {} },
    todo: { filter: 'all' },
    panelCollapsed: false,
  };
}

function boot(overrides = {}) {
  const api = overrides.api ?? makeApi();
  const initial = { ...state(), ...(overrides.state ?? {}) };
  return { api, ...bootRenderer({ api, state: initial }) };
}

test('工具栏有「年」分段，点它把 mode 切成 year', async () => {
  const { PC, render } = boot();
  const mount = await render('calendar', { mode: 'month' });
  const labels = mount.querySelectorAll('.seg-btn').map((button) => button.textContent);
  assert.deepEqual(labels, ['月', '周', '日', '年'], '分段应是 月/周/日/年');

  const year = mount.querySelectorAll('.seg-btn').find((button) => button.textContent === '年');
  year.listeners.click[0]();
  assert.equal(PC.state.calendar.mode, 'year');
});

test('年视图：12 个迷你月 + 周标题 + 今天高亮 + 有内容的日期有圆点', async () => {
  const { render } = boot();
  const mount = await render('calendar', { mode: 'year', anchor: '2026-10-12' });

  const months = mount.querySelectorAll('.mini-month');
  assert.equal(months.length, 12, '一年应有 12 个迷你月');
  assert.deepEqual(
    months.map((box) => box.querySelector('.mini-title').textContent),
    Array.from({ length: 12 }, (_, i) => `${i + 1} 月`),
  );
  // 每周 7 个周标题、每月 6×7 = 42 个日格
  assert.equal(months[0].querySelectorAll('.mini-weekday').length, 7);
  const days10 = months[9];
  assert.equal(days10.querySelectorAll('.mini-day').length, 42, '月格固定 6 行 × 7 列');

  // 今天高亮（anchor 是 2026-10-12，today 由 PCUtil.todayKey() 决定 → 用真实今天判断）
  const { PCUtil } = boot();
  const todayKey = PCUtil.todayKey();
  const allDays = mount.querySelectorAll('.mini-day');
  const todayCell = allDays.find((cell) => cell.dataset.date === todayKey);
  if (todayCell) assert.ok(todayCell.className.includes('today'), '今天应有 .today');
  assert.ok(allDays.every((cell) => cell.querySelector('.mini-num')), '每格都要有日数字');

  // 有内容的日期（伪后端只给了 anchor 那天 1 条日程）→ 至少一个圆点
  const withDot = allDays.filter((cell) => cell.querySelector('.mini-dot'));
  assert.equal(withDot.length, 1, '只有有内容的日期才画圆点');
  assert.equal(withDot[0].dataset.date, ANCHOR);

  // 月份标题点了切月视图、日期点了切日视图（监听器挂在 grid 上，用 closest 找 target）
  assert.ok(mount.querySelector('.year-grid').listeners.click?.length, 'year-grid 应有委托点击');
});

test('年视图：换年保留月日，2/29 也不会崩（月末溢出夹到当月最后一天）', async () => {
  const { render, PC, PCUtil } = boot();
  const leap = await render('calendar', { mode: 'year', anchor: '2024-02-29' });
  assert.equal(leap.querySelectorAll('.mini-month').length, 12);
  assert.ok(PCUtil.toDate('2024-02-29'), '闰日应可解析');

  const toolbar = leap.querySelector('.toolbar');
  const next = toolbar.querySelectorAll('button').find((button) => button.title === '下一页');
  const prev = toolbar.querySelectorAll('button').find((button) => button.title === '上一页');
  // 图标按钮的监听器会调用 event.stopPropagation()，按真实点击补一个事件对象
  const click = (node) => node.listeners.click[0]({ stopPropagation() {} });
  click(next);
  assert.equal(PC.state.calendar.anchor, '2025-02-28', '月末溢出应夹到当月最后一天');
  click(prev);
  assert.equal(PC.state.calendar.anchor, '2024-02-28', '来回换年也不该崩（2/29 已不存在）');
  assert.equal(PC.state.calendar.mode, 'year');

  // 标题显示年份
  const title = leap.querySelector('.toolbar-title');
  assert.equal(title.textContent, '2024 年');
});

test('年视图：/calendar 失败也能画出 12 个月骨架（只是没有圆点）', async () => {
  const api = async (url) => {
    if (url.startsWith('/categories')) return { items: [] };
    if (url.startsWith('/calendar')) throw new Error('boom');
    return {};
  };
  const { render } = boot({ api });
  const mount = await render('calendar', { mode: 'year', anchor: '2026-10-12' });
  assert.equal(mount.querySelectorAll('.mini-month').length, 12, '失败时仍要有 12 个迷你月');
  assert.equal(mount.querySelectorAll('.mini-dot').length, 0);
  assert.ok(mount.querySelector('.eb-msg'), '应给出失败提示');
});

test('年视图窄栏：--year-cols 变 2（不横向溢出）', async () => {
  const { render } = boot({ state: { panelCollapsed: true } });
  const mount = await render('calendar', { mode: 'year', anchor: '2026-10-12' });
  const grid = mount.querySelector('.year-grid');
  assert.equal(grid.style._store['--year-cols'], '2');
  const wide = await boot().render('calendar', { mode: 'year', anchor: '2026-10-12' });
  assert.equal(wide.querySelector('.year-grid').style._store['--year-cols'], '4');
});

test('月视图：每个格子有农历小字（节日优先、初一显示月名）', async () => {
  const { render, calls } = boot();
  const mount = await render('calendar', { mode: 'month', anchor: '2026-10-12' });

  assert.equal(mount.querySelectorAll('.cell').length, 42);
  const lunarLines = mount.querySelectorAll('.cell-lunar');
  assert.ok(lunarLines.length >= 42, `42 个格子都应有农历行，实际 ${lunarLines.length}`);
  assert.match(calls.join('\n'), /\/meta\/lunar\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/, '应批量请求农历而不是逐日');

  // 初一显示月名，其余显示日名
  const monthNames = lunarLines.filter((line) => line.textContent.endsWith('月'));
  assert.ok(monthNames.length >= 1, '应有初一显示月名');
  assert.ok(lunarLines.some((line) => line.textContent === '初三'), '其余显示日名');

  // 节日优先且带 accent 类
  const festival = lunarLines.find((line) => line.textContent === '重阳');
  assert.ok(festival, '节日当天应显示节日名');
  assert.ok(festival.className.includes('festival'));
});

test('日视图：农历文案带回闰月前缀与节日后缀的挂点', async () => {
  const api = async (url) => {
    if (url.startsWith('/categories')) return { items: [] };
    if (url.startsWith('/calendar')) {
      return { days: [{ date: '2026-02-17', events: [], schedules: [], todos: [], imported: [], stats: {} }] };
    }
    if (url.startsWith('/meta/lunar')) {
      return {
        date: '2026-02-17',
        lunar: { year: '丙午', zodiac: '马', month: '正月', day: '初一', isLeapMonth: false, monthNumber: 1, dayNumber: 1 },
        festivals: ['春节'],
        text: '丙午年正月初一',
      };
    }
    return {};
  };
  const { render } = boot({ api });
  const mount = await render('calendar', { mode: 'day', anchor: '2026-02-17' });
  const label = mount.querySelector('.day-hero-lunar');
  assert.ok(label, '日视图顶部应显示农历');
  assert.equal(label.textContent, '丙午年正月初一 · 春节');
  assert.ok(label.querySelector('.day-festival'), '节日应单独一个 accent 元素');
});
