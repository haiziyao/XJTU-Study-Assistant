/**
 * 课表导入页的渲染测试：用 DOM 桩真实跑一遍 `render()`，再断言节点结构。
 *
 * 重点不是像素，而是几条用户会直接看到的规则：
 * - 三段式标题齐全（登录与学期 / 预览与选择 / 已导入），三件事确实在同一页；
 * - 每门课一个**默认勾选**的勾选框；
 * - 「导入到第几周」改动后，「将写入 N 条日程」实时变化；
 * - 删除走对应接口（按课程 / all），并且按钮文案能被找到；
 * - 未登录时只给「请先在 设置 → 统一身份认证 登录」的指引，不出现选课列表。
 *
 * 同时检查 CSP 约束：页面源码里不能出现 inline style，CSS 在 ≤900px 有单列与 44px 按钮规则。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootRenderer } from './helpers/renderer-dom.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEW = path.resolve(HERE, '../src/renderer/views/timetable.js');
const CSS = path.resolve(HERE, '../src/renderer/views/timetable.css');

const TERM = '2026-2027-1';

/** 两门课：高等数学 1 条、程序设计 2 条 → 默认「将写入 3 条日程」 */
function previewPayload() {
  return {
    term: TERM,
    termLabel: '2026-2027 学年 · 第 1 学期',
    termStart: '2026-09-07',
    startSource: 'ehall',
    totalWeeks: 18,
    maxWeek: 18,
    count: 2,
    courses: [
      {
        id: 'ttc-math',
        name: '高等数学',
        teacher: '张老师',
        location: '主A-101',
        weekDays: [1],
        periodRange: [1, 4],
        weeks: { list: [1, 2, 3, 4, 5, 6, 7, 8], runs: [{ start: 1, end: 8 }], min: 1, max: 8 },
        slots: [{ weekDay: 1, startPeriod: 1, endPeriod: 4, weeks: [1, 2, 3, 4, 5, 6, 7, 8] }],
        eventCount: 1,
        schedulePreviews: [
          { weekDay: 1, startTime: '08:00', endTime: '11:00', weeks: { start: 1, end: 8 }, date: '2026-09-07' },
        ],
      },
      {
        id: 'ttc-code',
        name: '程序设计',
        teacher: '赵老师',
        location: '计B-202',
        weekDays: [3],
        periodRange: [1, 2],
        weeks: {
          list: [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16],
          runs: [
            { start: 1, end: 8 },
            { start: 10, end: 16 },
          ],
          min: 1,
          max: 16,
        },
        slots: [{ weekDay: 3, startPeriod: 1, endPeriod: 2, weeks: [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16] }],
        eventCount: 2,
        schedulePreviews: [
          { weekDay: 3, startTime: '08:00', endTime: '09:50', weeks: { start: 1, end: 8 }, date: '2026-09-09' },
          { weekDay: 3, startTime: '08:00', endTime: '09:50', weeks: { start: 10, end: 16 }, date: '2026-11-11' },
        ],
      },
    ],
  };
}

/**
 * 作息切换夹具：材料力学周一 5-6 节 1-16 周，后端按 10/1 切成两段。
 * `seasonSplit` 是 `decorateCourse` 真实会返回的形状（见 timetable.test.js）。
 */
function seasonSplitPreviewPayload() {
  const weeks = Array.from({ length: 16 }, (_, index) => index + 1);
  return {
    term: TERM,
    termLabel: '2026-2027 学年 · 第 1 学期',
    termStart: '2026-09-14',
    startSource: 'ehall',
    totalWeeks: 18,
    maxWeek: 18,
    count: 1,
    courses: [
      {
        id: 'ttc-mech',
        name: '材料力学',
        teacher: '吴老师',
        location: '主D-101',
        weekDays: [1],
        periodRange: [5, 6],
        weeks: { list: weeks, runs: [{ start: 1, end: 16 }], min: 1, max: 16 },
        slots: [{ weekDay: 1, startPeriod: 5, endPeriod: 6, weeks }],
        eventCount: 2,
        schedulePreviews: [
          { weekDay: 1, startTime: '14:30', endTime: '16:20', weeks: { start: 1, end: 3 }, date: '2026-09-14', season: 'summer', periodRange: [5, 6] },
          { weekDay: 1, startTime: '14:00', endTime: '15:50', weeks: { start: 4, end: 16 }, date: '2026-10-05', season: 'winter', periodRange: [5, 6] },
        ],
        seasonSplit: {
          runs: 1,
          segments: 2,
          extraEvents: 1,
          groups: [
            {
              weekDay: 1,
              periodRange: [5, 6],
              parts: [
                { weeks: { start: 1, end: 3 }, season: 'summer', date: '2026-09-14', startTime: '14:30', endTime: '16:20' },
                { weeks: { start: 4, end: 16 }, season: 'winter', date: '2026-10-05', startTime: '14:00', endTime: '15:50' },
              ],
            },
          ],
        },
      },
    ],
  };
}

function importedPayload() {
  return {
    term: TERM,
    count: 1,
    total: 2,
    courses: [
      {
        id: 'ttc-code',
        name: '程序设计',
        term: TERM,
        count: 2,
        weekDays: [3],
        periodRange: [1, 2],
        weeks: {
          list: [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16],
          runs: [
            { start: 1, end: 8 },
            { start: 10, end: 16 },
          ],
          min: 1,
          max: 16,
        },
        weeksText: '第1-8,10-16周',
        externalIds: ['timetable:x:1', 'timetable:x:2'],
      },
    ],
  };
}

/**
 * @param {object} overrides 覆盖某个接口的返回（键是路径前缀）
 */
function makeApi(overrides = {}) {
  const calls = [];
  const api = async (url, options = {}) => {
    calls.push({ method: options.method ?? 'GET', url, body: options.body ?? null });
    for (const [prefix, value] of Object.entries(overrides)) {
      if (url.startsWith(prefix)) return typeof value === 'function' ? value(url, options) : value;
    }
    if (url.startsWith('/timetable/status')) {
      return {
        loggedIn: true,
        reason: null,
        currentTerm: TERM,
        terms: [
          { value: '2027-2028-1', label: '2027-2028 学年 · 第 1 学期', current: false },
          { value: TERM, label: '2026-2027 学年 · 第 1 学期', current: true },
          { value: '2025-2026-3', label: '2025-2026 学年 · 小学期', current: false },
        ],
        imported: { count: 2, courses: [{ id: 'ttc-code', name: '程序设计', term: TERM, count: 2 }] },
      };
    }
    if (url.startsWith('/timetable/preview')) return previewPayload();
    if (url.startsWith('/timetable/imported')) return importedPayload();
    if (url.startsWith('/timetable/import')) return { created: 2, updated: 0, removed: 0, events: 2, skipped: [] };
    if (url.startsWith('/timetable/remove')) return { removed: 1 };
    return {};
  };
  return { api, calls };
}

function text(mount) {
  return mount.textContent;
}

function findButton(mount, label) {
  return mount.querySelectorAll('button').find((node) => node.textContent.trim() === label);
}

/* ------------------------------------------------------------------ 已登录页面 */

test('timetable 渲染：三段式 + 每门一个默认勾选的勾选框 + 导入按钮', async () => {
  const { api } = makeApi();
  const ctx = bootRenderer({ api });
  const mount = await ctx.render('timetable', { wait: 40 });

  // 左栏注册（order 23，紧接 calendar 20 / lms 20 之后，academic 40 之前）
  const view = ctx.PCModules.get('timetable');
  assert.ok(view, 'timetable 视图应已注册');
  assert.equal(view.label, '课表导入');
  assert.equal(view.order, 23);

  const page = text(mount);
  assert.match(page, /登录与学期/);
  assert.match(page, /预览与选择/);
  assert.match(page, /已导入/);
  assert.match(page, /导入到第几周/);
  assert.match(page, /开始导入/);
  assert.match(page, /重新导入/);
  assert.match(page, /全部删除/);

  const boxes = mount.querySelectorAll('input.tt-course-check');
  assert.equal(boxes.length, 2, '一门课一个勾选框');
  assert.ok(boxes.every((box) => box.checked), '默认全选');

  const weekInput = mount.querySelector('.tt-week-input');
  assert.equal(weekInput.value, '18', '默认导入到该学期最大周次');

  const count = mount.querySelector('.tt-count');
  assert.equal(count.textContent, '将写入 3 条日程', '1 + 2 条周次段日程');
  assert.doesNotMatch(page, /因作息切换/, '没被切段的课程不该显示切段说明');

  const importButton = findButton(mount, '开始导入');
  assert.ok(importButton, '应有「开始导入」按钮');
  assert.equal(importButton.disabled, false);
});

test('timetable 渲染：作息切换拆段在课程行如实说明（因作息切换拆为 2 条）', async () => {
  const { api } = makeApi({ '/timetable/preview': seasonSplitPreviewPayload() });
  const ctx = bootRenderer({ api });
  const mount = await ctx.render('timetable', { wait: 40 });

  const page = text(mount);
  assert.match(page, /因作息切换拆为 2 条/, '用户要知道多出来的日程不是重复导入');
  assert.match(page, /周一 第5-6节：第1-3周 夏季 14:30起 \/ 第4-16周 冬季 14:00起/);
  assert.equal(mount.querySelector('.tt-count').textContent, '将写入 2 条日程', '切出来的两段都算进条数');
});

test('timetable 渲染：调小「导入到第几周」后条数实时变化', async () => {
  const { api } = makeApi();
  const ctx = bootRenderer({ api });
  const mount = await ctx.render('timetable', { wait: 40 });

  const weekInput = mount.querySelector('.tt-week-input');
  weekInput.value = '8';
  weekInput.listeners.input?.[0]?.();

  const count = mount.querySelector('.tt-count');
  assert.equal(count.textContent, '将写入 2 条日程', '第 10-16 周那一条应被排除');
});

test('timetable 渲染：勾选框取消一门课后条数跟着变', async () => {
  const { api } = makeApi();
  const ctx = bootRenderer({ api });
  const mount = await ctx.render('timetable', { wait: 40 });

  const boxes = mount.querySelectorAll('input.tt-course-check');
  const programming = boxes.find((box) => box.dataset.courseId === 'ttc-code');
  assert.ok(programming, '能找到程序设计的勾选框');
  programming.checked = false;
  programming.listeners.change?.[0]?.();

  assert.equal(mount.querySelector('.tt-count').textContent, '将写入 1 条日程');
});

test('timetable 渲染：开始导入会带上选中课程与周次上限', async () => {
  const { api, calls } = makeApi();
  const ctx = bootRenderer({ api });
  const mount = await ctx.render('timetable', { wait: 40 });

  const button = findButton(mount, '开始导入');
  button.listeners.click?.[0]?.();
  await new Promise((resolve) => setTimeout(resolve, 40));

  const call = calls.find((item) => item.method === 'POST' && item.url === '/timetable/import');
  assert.ok(call, '应调用 /timetable/import');
  assert.equal(call.body.term, TERM);
  assert.deepEqual(call.body.courseIds, ['ttc-math', 'ttc-code']);
  assert.equal(call.body.untilWeek, 18);
});

test('timetable 渲染：删除按钮走 /timetable/remove（按课程 / all）', async () => {
  const { api, calls } = makeApi();
  const ctx = bootRenderer({ api });
  const mount = await ctx.render('timetable', { wait: 40 });

  const remove = findButton(mount, '删除');
  assert.ok(remove, '已导入列表里应有「删除」');
  remove.listeners.click?.[0]?.();
  await new Promise((resolve) => setTimeout(resolve, 40));

  const one = calls.find((item) => item.method === 'POST' && item.url === '/timetable/remove');
  assert.ok(one);
  // 注意：body 对象是在 vm 沙箱里创建的，原型与宿主不同，不能整体 deepEqual；
  // 逐字段比较即可（值本身是一样的）。
  assert.equal(one.body.term, TERM);
  assert.deepEqual([...one.body.courseIds], ['ttc-code']);

  // 重新渲染后再点「全部删除」
  const second = makeApi();
  const ctx2 = bootRenderer({ api: second.api });
  const mount2 = await ctx2.render('timetable', { wait: 40 });
  findButton(mount2, '全部删除').listeners.click?.[0]?.();
  await new Promise((resolve) => setTimeout(resolve, 40));
  const all = second.calls.find((item) => item.method === 'POST' && item.url === '/timetable/remove');
  assert.equal(all.body.term, TERM);
  assert.equal(all.body.all, true);
});

/* ------------------------------------------------------------------ 未登录 */

test('timetable 渲染：未登录只给统一身份认证指引，不出现选课列表', async () => {
  const { api, calls } = makeApi({
    '/timetable/status': {
      loggedIn: false,
      reason: '尚未登录统一身份认证',
      currentTerm: null,
      terms: [],
      imported: { count: 0, courses: [] },
    },
    '/timetable/imported': { term: null, count: 0, total: 0, courses: [] },
  });
  const ctx = bootRenderer({ api });
  const mount = await ctx.render('timetable', { wait: 40 });

  const page = text(mount);
  assert.match(page, /请先在 设置 → 统一身份认证 登录/);
  assert.match(page, /登录与学期/);
  assert.match(page, /已导入/);
  assert.doesNotMatch(page, /预览与选择/, '未登录不该渲染选课区');
  assert.equal(mount.querySelectorAll('input.tt-course-check').length, 0);
  assert.match(page, /还没有导入过课表/);

  // 「刷新状态」要带 probe=1，让后端主动重试一次站点认证（而不是只重画本地状态）
  findButton(mount, '刷新状态').listeners.click?.[0]?.();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(
    calls.some((item) => item.url === '/timetable/status?probe=1'),
    '刷新状态应请求 /timetable/status?probe=1',
  );
});

/* ------------------------------------------------------------------ CSP / 手机端 */

test('timetable 渲染：无 inline style，CSS 有 ≤900px 单列与 44px 按钮规则', async () => {
  const [viewSource, css] = await Promise.all([readFile(VIEW, 'utf8'), readFile(CSS, 'utf8')]);

  assert.doesNotMatch(viewSource, /style\s*=\s*["']/, 'CSP 禁 inline style：视图里不能写 style 属性');
  assert.doesNotMatch(viewSource, /\.style\./, '也不要用 JS 直接写样式属性');
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /min-height: 44px/, '手机端按钮 ≥44px');
  assert.match(css, /grid-template-columns: 1fr/, '手机端单列');
  assert.match(css, /overflow-wrap: anywhere/, '长课程名不能把页面撑出横向滚动');
});
