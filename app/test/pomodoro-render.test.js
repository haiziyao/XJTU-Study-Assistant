/**
 * 番茄钟渲染层结构测试：真实跑一遍 `views/pomodoro.js` 的 render()。
 *
 * 重点不是"页面能画出来"，而是几个**改坏了用户会立刻看出来**的数字/状态：
 *   - 大圆环的 `stroke-dashoffset` 必须等于 `C × (1 - remainingSec/totalSec)`；
 *   - 暂停态按钮必须是「继续」，空闲态必须是「开始专注」；
 *   - 关联待办的选择器要列出未完成待办、带父级路径与已投入时长；
 *   - 今日统计与近 7 天图表来自服务端 /status，不在前端另算一套。
 *
 * 用 `test/helpers/renderer-dom.js` 的真实渲染桩（与待办/日历视图测试同一套）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootRenderer } from './helpers/renderer-dom.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POMODORO_JS = path.join(HERE, '../src/renderer/views/pomodoro.js');
const RING_C = 2 * Math.PI * 96;

const CONFIG = { studyMin: 45, breakMin: 15, autoStartNext: true, sound: true, longBreakEvery: 0, longBreakMin: 30 };

function todo(id, title, extra = {}) {
  return {
    id,
    title,
    deadline: '2099-12-20',
    estimatedHours: 1,
    priority: 0,
    completed: false,
    completedAt: null,
    description: '',
    tags: [],
    category: '',
    parentId: null,
    childCount: 0,
    childDoneCount: 0,
    hasChildren: false,
    spentSelfSec: 0,
    spentSec: 0,
    isOverdue: false,
    isToday: false,
    daysRemaining: 100,
    complexity: 'simple',
    complexityLabel: '简单',
    ...extra,
  };
}

function status(overrides = {}) {
  return {
    phase: 'study',
    running: false,
    remainingSec: 1350,
    totalSec: 2700,
    round: 2,
    taskId: 'g1',
    taskTitle: '看例题',
    startedAt: '2026-05-06T00:00:00.000Z',
    endsAt: null,
    today: { studySec: 5400, breakSec: 900, sessions: 6 },
    week: { studySec: 9000, sessions: 10 },
    daily: [
      { day: '2026-04-30', studySec: 0, sessions: 0 },
      { day: '2026-05-01', studySec: 600, sessions: 1 },
      { day: '2026-05-02', studySec: 1800, sessions: 2 },
      { day: '2026-05-03', studySec: 900, sessions: 1 },
      { day: '2026-05-04', studySec: 0, sessions: 0 },
      { day: '2026-05-05', studySec: 2700, sessions: 3 },
      { day: '2026-05-06', studySec: 5400, sessions: 6 },
    ],
    config: CONFIG,
    ...overrides,
  };
}

function makeApi({ current = status(), todos = [] } = {}) {
  const calls = [];
  const api = async (url, options = {}) => {
    calls.push(`${options.method ?? 'GET'} ${url}`);
    if (url === '/pomodoro/status') return current;
    if (url.startsWith('/todos?completed=false')) {
      return {
        items: todos,
        count: todos.length,
        totalCount: todos.length,
        stats: { total: todos.length, completed: 0, pending: todos.length, overdue: 0, completionRate: 0, plannedHours: 1 },
      };
    }
    if (url.startsWith('/pomodoro/')) return { ...current, status: current };
    return {};
  };
  api.calls = calls;
  return api;
}

const tree = [
  todo('p1', '期末复习', { childCount: 1, childDoneCount: 0, hasChildren: true, spentSec: 1200 }),
  todo('c1', '第一章', { parentId: 'p1', spentSec: 600 }),
  todo('g1', '看例题', { parentId: 'c1', spentSec: 60, spentSelfSec: 60 }),
  todo('p2', '交实验报告', { spentSec: 0 }),
];

test('渲染：圆环偏移 = C × (1 - remaining/total)，时间/阶段/番茄数与状态一致', async () => {
  const api = makeApi({ todos: tree });
  const booted = bootRenderer({ api, state: {} });
  try {
    assert.equal(booted.PCModules.get('pomodoro').order, 21);
    const mount = await booted.render('pomodoro', { wait: 40 });
    assert.equal(mount.querySelector('.pm-time').textContent, '22:30');
    assert.equal(mount.querySelector('.pm-phase').textContent, '专注');
    assert.equal(mount.querySelector('.pm-tomatoes').textContent, '🍅 × 2');

    const ring = mount.querySelector('.pm-ring-fg');
    assert.ok(Math.abs(Number(ring.getAttribute('stroke-dasharray')) - RING_C) < 0.01);
    assert.equal(
      Number(ring.getAttribute('stroke-dashoffset')),
      Number((RING_C * (1 - 1350 / 2700)).toFixed(2)),
      '圆环必须直接由 remainingSec/totalSec 计算，不能另拍一个百分比',
    );

    const primary = mount.querySelector('.pm-primary');
    assert.equal(primary.textContent, '继续', '暂停态按钮是「继续」');
    assert.equal(mount.querySelectorAll('.pm-btn').find((item) => item.textContent === '跳过').disabled, false);
    assert.equal(mount.querySelectorAll('.pm-btn').find((item) => item.textContent === '重置').disabled, false);
  } finally {
    booted.PCModules.getService('pomodoro').dispose();
  }
});

test('渲染：关联待办只列未完成项，带父级路径与已投入时长；当前任务被选中', async () => {
  const api = makeApi({ todos: tree });
  const booted = bootRenderer({ api, state: {} });
  try {
    const mount = await booted.render('pomodoro', { wait: 40 });
    const select = mount.querySelector('.pm-select');
    assert.equal(select.value, 'g1', '当前关联任务要选中');
    const options = select.children.map((item) => item.textContent);
    assert.deepEqual(options, [
      '不关联待办',
      '期末复习（已投入 20 分钟）',
      '期末复习 / 第一章（已投入 10 分钟）',
      '期末复习 / 第一章 / 看例题（已投入 1 分钟）',
      '交实验报告（尚未投入）',
    ]);
  } finally {
    booted.PCModules.getService('pomodoro').dispose();
  }
});

test('渲染：今日统计与近 7 天柱状图来自 /status；窄屏规则写在 CSS 里且无 inline style', async () => {
  const api = makeApi({ todos: tree });
  const booted = bootRenderer({ api, state: {} });
  try {
    const mount = await booted.render('pomodoro', { wait: 40 });
    const stats = mount.querySelectorAll('.pm-stat-value').map((item) => item.textContent);
    assert.deepEqual(stats, ['90 分钟', '6 个', '15 分钟']);
    assert.equal(mount.querySelector('.pm-chart').getAttribute('class'), 'pm-chart');
    assert.equal(mount.querySelectorAll('.pm-chart-bar').length, 5, '有 5 天专注 >0');
    assert.equal(mount.querySelectorAll('.pm-chart-day').length, 7);

    // 手机：≤900px 单列 + 按钮 ≥44px 的规则必须在样式表里（CSP 禁 inline style）
    const css = readFileSync(path.join(HERE, '../src/renderer/views/pomodoro.css'), 'utf8');
    assert.match(css, /@media \(max-width: 900px\)/);
    assert.match(css, /min-height:\s*44px/);
    assert.doesNotMatch(readFileSync(POMODORO_JS, 'utf8'), /\.style\./);
    assert.doesNotMatch(readFileSync(POMODORO_JS, 'utf8'), /style="/);
  } finally {
    booted.PCModules.getService('pomodoro').dispose();
  }
});

test('渲染：空闲态显示「开始专注」，跳过/重置不可点；点开始会 POST /pomodoro/start', async () => {
  const api = makeApi({ current: status({ phase: 'idle', running: false, remainingSec: 2700, totalSec: 2700, round: 0, taskId: null, taskTitle: null }), todos: tree });
  const booted = bootRenderer({ api, state: {} });
  try {
    const mount = await booted.render('pomodoro', { wait: 40 });
    const primary = mount.querySelector('.pm-primary');
    assert.equal(primary.textContent, '开始专注');
    assert.equal(mount.querySelectorAll('.pm-btn').find((item) => item.textContent === '跳过').disabled, true);
    assert.equal(mount.querySelectorAll('.pm-btn').find((item) => item.textContent === '重置').disabled, true);

    primary.listeners.click[0]();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(api.calls.includes('POST /pomodoro/start'), `期望点击后开始计时，实际调用：${api.calls.join(', ')}`);
  } finally {
    booted.PCModules.getService('pomodoro').dispose();
  }
});
