/**
 * 成长视图（views/growth.js）渲染层结构测试。
 *
 * 用 `test/helpers/renderer-dom.js` 的 DOM 桩真实跑一遍 render()，重点钉住：
 *   1. 注册信息（id / label / icon / order）与四个分段；
 *   2. 今日状态表单提交时，`PC.api` 收到 `POST /growth/state` 与正确的 body；
 *   3. 后端模块未装配（`/growth/state` 404）时显示「成长模块未启用」，不白屏、不抛错；
 *   4. 窄屏 class + CSS 断点 + 44px 点击目标确实存在。
 *
 * 不启动真实后端：growth 模块由并行任务提供，这个文件只验证前端契约。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootRenderer } from './helpers/renderer-dom.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GROWTH_JS = path.join(HERE, '../src/renderer/views/growth.js');
const GROWTH_CSS = path.join(HERE, '../src/renderer/views/growth.css');

const DATE = '2026-10-26';
const CHARACTER = {
  name: 'Operator',
  level: 3,
  totalXp: 520,
  xpIntoLevel: 120,
  xpForNext: 220,
  progress: 120 / 220,
  attrs: { focus: 12, wisdom: 8, vitality: 5, discipline: 9, resilience: 3 },
  streak: 2,
  bestStreak: 5,
  counters: { tasksDone: 18, perfectDays: 2 },
};

function day(overrides = {}) {
  return {
    ok: true,
    date: DATE,
    state: null,
    plan: null,
    tasks: [],
    stats: { done: 0, total: 0, minutesDone: 0, xpDone: 0 },
    character: { streak: 2 },
    xpGained: 0,
    ...overrides,
  };
}

function weekly(overrides = {}) {
  return {
    ok: true,
    from: '2026-10-20',
    to: DATE,
    days: 7,
    points: [],
    totals: {
      planned: 0,
      done: 0,
      minutes: 0,
      xp: 0,
      activeDays: 0,
      stateDays: 0,
      avgScore: null,
    },
    byKind: {},
    modeMix: { push: 0, steady: 0, recover: 0 },
    streak: 2,
    verdict: '这一周还没有任何记录。先录入一次状态，其它都会跟着动起来。',
    insights: [],
    ...overrides,
  };
}

/** 一个够页面首屏跑完的伪后端；`api.calls` 记录每次请求的 url/options。 */
function makeApi({ today = null } = {}) {
  const calls = [];
  const api = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    calls.push({ url, options, method });
    if (url === '/growth/state' && method === 'GET') return { ok: true, date: DATE, entry: null };
    if (url === '/growth/state' && method === 'POST') {
      return {
        ok: true,
        entry: { date: DATE, score: 66, mode: 'steady', capacity: 218 },
      };
    }
    if (url === '/growth/today') return today ?? day();
    if (url === '/growth/tasks/overdue') return { ok: true, tasks: [] };
    if (url === '/growth/tasks') return { ok: true, tasks: [] };
    if (url === '/growth/character') return { ok: true, character: CHARACTER, streakLabel: '今天还在线上' };
    if (url === '/growth/character/achievements') return { ok: true, achievements: [] };
    if (url === '/growth/system/status') {
      return {
        ok: true,
        session: { id: 'sess-12345678', startedAt: `${DATE}T09:00:00.000Z`, trigger: 'ui' },
        dataCounts: { tasks: 0, states: 0, plans: 0, logs: 0, sessions: 1 },
        dataDir: '/tmp/potato',
      };
    }
    if (url === '/growth/system/boot') {
      return { ok: true, session: { id: 'sess-12345678', startedAt: `${DATE}T09:00:00.000Z` } };
    }
    if (url.startsWith('/growth/logs')) return { ok: true, logs: [] };
    if (url === '/growth/archives') return { ok: true, archives: [] };
    if (url === '/growth/plan/generate') {
      return { ok: true, tasks: [], plan: { usedMinutes: 0, budget: 218 } };
    }
    if (url === '/growth/ai/status') {
      return { ok: true, enabled: false, baseUrl: 'http://127.0.0.1:11434/v1', model: '', hasKey: false, isLocal: true };
    }
    if (url === '/growth/ai/briefing' || url === '/growth/ai/review') {
      return { ok: true, source: 'local', text: '本地规则简报' };
    }
    if (url === '/growth/journal/trend?days=14') return { ok: true, points: [] };
    if (url === '/growth/journal/weekly') return weekly();
    if (url === '/growth/templates') {
      return { ok: true, builtin: [], custom: [], builtinCount: 0, customCount: 0, activeCount: 0 };
    }
    if (url === '/growth/settings') {
      return {
        ok: true,
        settings: {
          reminders: { enabled: true, stateHour: 10, closeHour: 21, deepDays: 3 },
          tasks: { carryOver: 'off' },
          data: { selfCheck: true },
        },
        carryOverModes: { off: '保持逾期', auto: '自动顺延到今天' },
      };
    }
    if (url === '/growth/maintenance') return { ok: true, report: { at: `${DATE}T10:00:00.000Z`, totalFixed: 0, fixed: {} } };
    if (url === '/growth/maintenance/check') return { ok: true, report: { at: `${DATE}T10:00:00.000Z`, totalFixed: 0, fixed: {} } };
    if (url === '/growth/system/snapshot') return { ok: true, file: '2026-10-26-sess.json' };
    return { ok: true };
  };
  api.calls = calls;
  return api;
}

test('成长视图已注册：左栏标签「成长」、order 50、图标命中图标表', async () => {
  const booted = bootRenderer({ api: makeApi(), state: {} });
  const view = booted.PCModules.get('growth');
  assert.ok(view, 'PCModules 应登记 growth');
  assert.equal(view.label, '成长');
  assert.equal(view.title, '成长');
  assert.equal(view.order, 50);
  assert.equal(booted.PCModules.list().filter((item) => item.id === 'growth').length, 1);
  // 图标表里能命中，左栏不会退化成一个裸 emoji / 文本。
  assert.match(String(booted.window.PCIcons?.svg?.(view.icon, 20)), /^<svg /);
});

test('渲染出今日 / 角色 / 周报 / 设置四段与关键按钮', async () => {
  const booted = bootRenderer({ api: makeApi(), state: {} });
  const mount = await booted.render('growth', { wait: 50 });

  const root = mount.querySelector('.growth-view');
  assert.ok(root, '内容应挂在 .view-content.growth-view');
  const tabs = mount.querySelectorAll('.growth-tab').map((node) => node.textContent);
  assert.deepEqual(tabs, ['今日', '角色', '周报', '设置']);
  assert.equal(mount.querySelector('.growth-tab.is-active').textContent, '今日');

  const labels = mount.querySelectorAll('button').map((node) => node.textContent);
  for (const expected of ['刷新', '保存状态', '立即存档', '结束会话']) {
    assert.ok(labels.includes(expected), `应渲染「${expected}」按钮，实际：${labels.join(' / ')}`);
  }
  assert.ok(mount.querySelector('.growth-state-form'), '今日状态表单应存在');
  assert.ok(mount.querySelector('.growth-tabs'), '分段切换应存在');
  assert.equal(mount.querySelectorAll('.growth-range').length, 7, '六个维度 + 睡眠时长');
  assert.ok(mount.querySelector('.growth-task-manager'), '任务管理（手动添加 / 逾期 / 全部）应在今日页内');
  assert.ok(mount.querySelector('.growth-archive-list') || mount.textContent.includes('还没有存档'), '存档区应在今日页内');
});

test('★ 状态提交：PC.api 收到 POST /growth/state 与完整的六维 + 睡眠 + 备注', async () => {
  const api = makeApi();
  const booted = bootRenderer({ api, state: {} });
  const mount = await booted.render('growth', { wait: 50 });
  const form = mount.querySelector('.growth-state-form');
  assert.ok(form, '应能拿到状态表单');
  const fields = form._fields;
  assert.ok(fields, '表单应保留字段引用（DOM 桩没有 form.elements）');

  fields.sleepHours.value = '7';
  fields.sleepQuality.value = '4';
  fields.energy.value = '4';
  fields.mood.value = '3';
  fields.stress.value = '2';
  fields.focus.value = '5';
  fields.body.value = '4';
  fields.note.value = '测试备注';

  const handler = form.listeners.submit?.[0];
  assert.equal(typeof handler, 'function', '表单应有 submit 监听器');
  await handler({ preventDefault() {} });

  const call = api.calls.find((item) => item.url === '/growth/state' && item.method === 'POST');
  assert.ok(call, '应发出 POST /growth/state');
  assert.deepEqual(
    { ...call.options.body },
    {
      sleepHours: 7,
      sleepQuality: 4,
      energy: 4,
      mood: 3,
      stress: 2,
      focus: 5,
      body: 4,
      note: '测试备注',
    },
  );
  // 与源项目一致：还没有任务表单时顺手生成一份。
  assert.ok(
    api.calls.some((item) => item.url === '/growth/plan/generate' && item.method === 'POST'),
    '录入状态后应顺手排一次今日任务',
  );
});

test('★ 后端未就绪（/growth/state 404）：显示「成长模块未启用」，不抛错', async () => {
  const api = async (url) => {
    const error = new Error('成长模块未启用');
    error.status = 404;
    error.payload = { ok: false, error: { code: 'NOT_FOUND', message: `找不到 ${url}` } };
    throw error;
  };
  const booted = bootRenderer({ api, state: {} });
  let mount;
  await assert.doesNotReject(async () => {
    mount = await booted.render('growth', { wait: 50 });
  }, '404 不应把异常抛出渲染层');
  assert.match(mount.textContent, /成长模块未启用/);
  assert.ok(mount.querySelector('.growth-disabled'), '应显示未启用卡片');
  assert.ok(mount.querySelector('.growth-disabled').textContent.includes('404'));
  assert.ok(booted.calls.includes('GET /growth/state'), '应先用 /growth/state 探活');
});

test('窄屏 class 与样式断点存在（源码级断言）', async () => {
  const js = readFileSync(GROWTH_JS, 'utf8');
  const css = readFileSync(GROWTH_CSS, 'utf8');

  assert.match(js, /growth-narrow/, 'JS 应按 matchMedia 挂窄屏 class');
  assert.match(css, /@media\s*\(max-width:\s*900px\)/, 'CSS 应有 900px 断点');
  assert.match(css, /min-height:\s*44px/, '窄屏按钮 / 输入应有 44px 点击目标');
  assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\)/, '窄屏应单列');
  assert.doesNotMatch(js, /\sstyle\s*=\s*["']/, 'CSP 禁止 inline style 属性');
  assert.doesNotMatch(js, /<style/i, 'CSP 禁止 <style> 块');
});

test('★ 任务打卡：PATCH /growth/tasks/:id 带 status=done', async () => {
  const task = {
    id: 't1',
    title: '复习第三章',
    detail: '只看例题',
    status: 'todo',
    kind: 'focus',
    estimateMin: 25,
    difficulty: 2,
    xp: 30,
    date: DATE,
  };
  const fixture = day({
    state: { score: 66, mode: 'steady', capacity: 218, sleepHours: 7, energy: 4, mood: 3, stress: 2, focus: 4, body: 4 },
    plan: { usedMinutes: 25, budget: 218, rationale: ['状态中等，先做一条深度任务。'] },
    tasks: [task],
  });
  const api = makeApi({ today: fixture });
  const booted = bootRenderer({ api, state: {} });
  const mount = await booted.render('growth', { wait: 50 });

  const check = mount.querySelectorAll('.growth-task-check')[0];
  assert.ok(check, '任务行应有打卡按钮');
  await check.listeners.click[0]({});
  await new Promise((resolve) => setTimeout(resolve, 60));

  const call = api.calls.find((item) => item.url === '/growth/tasks/t1' && item.method === 'PATCH');
  assert.ok(call, '应发出 PATCH /growth/tasks/t1');
  assert.deepEqual({ ...call.options.body }, { status: 'done' });
});

test('设置保存与 AI 测试连接都走 growth 前缀的接口', async () => {
  const api = makeApi();
  const booted = bootRenderer({ api, state: {} });
  const mount = await booted.render('growth', { wait: 50 });
  const tab = mount.querySelectorAll('.growth-tab').find((node) => node.textContent === '设置');
  await tab.listeners.click[0]({});
  await new Promise((resolve) => setTimeout(resolve, 60));

  const form = mount.querySelector('.growth-settings-form');
  assert.ok(form, '设置页应有提醒与跨天表单');
  const fields = form._fields;
  fields.stateHour.value = '9';
  fields.closeHour.value = '20';
  fields.deepDays.value = '4';
  fields.carryOver.value = 'auto';
  fields.enabled.checked = true;
  fields.selfCheck.checked = false;
  await form.listeners.submit[0]({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 60));

  const save = api.calls.find((item) => item.url === '/growth/settings' && item.method === 'PATCH');
  assert.ok(save, '应发出 PATCH /growth/settings');
  assert.deepEqual(JSON.parse(JSON.stringify(save.options.body)), {
    reminders: { stateHour: 9, closeHour: 20, deepDays: 4, enabled: true },
    tasks: { carryOver: 'auto' },
    data: { selfCheck: false },
  });

  const probe = mount.querySelectorAll('button').find((node) => node.textContent === '测试连通');
  assert.ok(probe, 'AI 卡片应有「测试连通」');
  await probe.listeners.click[0]({});
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(
    api.calls.some((item) => item.url === '/growth/ai/probe' && item.method === 'POST'),
    '应发出 POST /growth/ai/probe',
  );
});

test('切换角色 / 周报 / 设置能渲染各自内容（不抛错）', async () => {
  const booted = bootRenderer({ api: makeApi(), state: {} });
  const mount = await booted.render('growth', { wait: 50 });
  const wait = () => new Promise((resolve) => setTimeout(resolve, 60));
  const clickTab = async (label) => {
    const tab = mount.querySelectorAll('.growth-tab').find((node) => node.textContent === label);
    assert.ok(tab, `应能找到「${label}」分段`);
    await tab.listeners.click[0]({});
    await wait();
  };

  await clickTab('角色');
  assert.ok(mount.querySelector('.growth-character-name'), '角色页应显示角色名');
  assert.equal(mount.querySelector('.growth-character-name').textContent, 'Operator');
  assert.match(mount.textContent, /专注/);
  assert.match(mount.textContent, /成就/);

  await clickTab('周报');
  assert.match(mount.textContent, /近 14 天/);
  assert.match(mount.textContent, /导出今日 \.md/);

  await clickTab('设置');
  for (const section of ['提醒与跨天', 'AI 接入', '任务模板', '备份与恢复']) {
    assert.match(mount.textContent, new RegExp(section), `设置页应有「${section}」`);
  }
});

test('matchMedia 命中窄屏时根节点带 growth-narrow class', async () => {
  const booted = bootRenderer({ api: makeApi(), state: {} });
  booted.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const mount = await booted.render('growth', { wait: 50 });
  assert.equal(mount.querySelector('.growth-view').classList.contains('growth-narrow'), true);
});
