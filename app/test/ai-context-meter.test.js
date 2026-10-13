/**
 * 「上下文圆环 + 明细弹层」的渲染层测试。
 *
 * 前端是 classic script（无构建、无框架），外壳 `boot()` 需要真实 DOM 才跑得起来，
 * 所以这里分两层测：
 *   1. **纯计算**：`window.PCContextMeter` 是与界面同一份实现（圆环上的百分比、K/M 紧凑写法、
 *      三档阈值、`stroke-dashoffset` 都在里面），直接喂假数据断言数字；
 *   2. **源码级**：颜色/布局必须落在 `shell.css`（CSP 禁内联样式），以及设置页那个
 *      「上下文上限」输入真的渲染出来了（用现有 DOM 桩跑一遍设置区块的 render）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { bootRenderer } from './helpers/renderer-dom.js';

const shellCss = readFileSync(new URL('../src/renderer/shell/shell.css', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/renderer/shell/app.js', import.meta.url), 'utf8');

/** 一份 `/ai/context` 的真实返回形状。 */
function payload(overrides = {}) {
  return {
    ok: true,
    conversationId: 'c1',
    limit: 1_000_000,
    used: 207_300,
    percent: 20.7,
    source: 'prompt_tokens',
    usedAt: '2026-10-12T02:00:00.000Z',
    messages: 24,
    windowMessages: 24,
    windowTurns: 12,
    summaryChars: 0,
    summaryCovered: 0,
    breakdown: { system: 1_500, tools: 5_300, history: 135_000, summary: 0, injection: null },
    breakdownSource: 'estimate',
    breakdownTotal: 141_800,
    configured: true,
    ...overrides,
  };
}

function meterOf() {
  const { window } = bootRenderer({ api: async () => ({ ok: true }) });
  assert.ok(window.PCContextMeter, '外壳应把 PCContextMeter 挂到 window（渲染层没有模块系统）');
  return window.PCContextMeter;
}

test('上下文圆环：百分比与上限一致（改上限百分比跟着变）', () => {
  const meter = meterOf();
  const view = meter.describe(payload());
  assert.equal(view.percent, 20.7);
  assert.equal(view.percentText, '20.7%');
  assert.equal(view.usedText, '207,300', '数字要千分位');
  assert.equal(view.limitText, '1,000,000');
  assert.equal(view.total, '~207.3K / 1M', '头部是紧凑写法');
  assert.equal(view.level, 'ok', '20.7% 属于常规档');

  // 同一个 used，分母改小 → 百分比与档位一起变（圆环画多长由 percent 决定）
  const half = meter.describe(payload({ limit: 500_000 }));
  assert.equal(half.percent, 41.5);
  assert.equal(meter.describe(payload({ limit: 300_000 })).percent, 69.1);
  assert.equal(meter.describe(payload({ limit: 200_000 })).level, 'hot');
  assert.equal(meter.describe(payload({ limit: 200_000 })).percentText, '103.6%', '超过上限就如实超 100%');
});

test('上下文圆环：三档阈值与来源标注', () => {
  const meter = meterOf();
  const at = (used) => meter.describe(payload({ used })).level;
  assert.equal(at(599_000), 'ok');
  assert.equal(at(600_000), 'warn');
  assert.equal(at(850_000), 'warn');
  assert.equal(at(851_000), 'hot');

  const estimated = meter.describe(payload({ source: 'estimate', usedAt: null }));
  assert.equal(estimated.sourceLabel, '字符估算');
  assert.match(estimated.sourceNote, /估算/);
  const real = meter.describe(payload());
  assert.equal(real.sourceLabel, '真实请求');
  assert.match(real.sourceNote, /最近一次真实请求/, '必须说清总计来自真实请求、分类是估算');
});

test('上下文圆环：token 紧凑写法与千分位', () => {
  const meter = meterOf();
  assert.equal(meter.compact(999), '999');
  assert.equal(meter.compact(1_000), '1K', '整单位不补 .0');
  assert.equal(meter.compact(1_500), '1.5K');
  assert.equal(meter.compact(12_345), '12.3K');
  assert.equal(meter.compact(135_000), '135K');
  assert.equal(meter.compact(1_000_000), '1M');
  assert.equal(meter.compact(1_234_567), '1.2M');
  assert.equal(meter.group(1_000_000), '1,000,000');
  // 波浪号只加在"圆整过"的读数上（`~` 表示这个数被圆整了）
  assert.equal(meter.tokens(11), '11');
  assert.equal(meter.tokens(207_300), '~207.3K');
  assert.equal(meter.tokens(1_000_000, { exact: true }), '1M', '配置值（上限）不带波浪号');
});

test('上下文圆环：stroke-dasharray / stroke-dashoffset 随百分比变化', () => {
  const meter = meterOf();
  const empty = meter.ringDash(0);
  assert.equal(empty.dasharray, '81.68', '2πr（r=13）');
  assert.equal(empty.dashoffset, '81.68', '0% 时整圈留白');
  assert.equal(meter.ringDash(100).dashoffset, '0.00', '100% 时画满');
  assert.equal(meter.ringDash(25).dashoffset, '61.26');
  assert.equal(meter.ringDash(300).dashoffset, '0.00', '超过 100% 也只画满一圈');

  const svg = meter.ringSvg(20.7);
  assert.match(svg, /stroke-dasharray="81\.68"/);
  assert.match(svg, /stroke-dashoffset="64\.77"/);
  assert.doesNotMatch(svg, /style=/, 'CSP 禁内联样式：几何必须走 SVG 表现属性');
});

test('上下文圆环：堆叠条彩色总长 = used/limit，段内按分类占比分', () => {
  const meter = meterOf();
  const view = meter.describe(payload({ used: 141_800, limit: 1_000_000 }));
  // 摘要为 0 → 不摆那一行（不该出现一个恒为 0 的分类）
  assert.deepEqual(
    view.segments.map((item) => item.key),
    ['system', 'tools', 'history'],
  );
  assert.equal(view.segments[0].text, '~1.5K');
  assert.equal(view.segments[2].text, '~135K');
  const sum = view.segments.reduce((total, item) => total + item.width, 0);
  assert.ok(Math.abs(sum - 14.18) < 0.01, `彩色总长应等于 used/limit（实际 ${sum}）`);
  // 同一份数据换个上限：彩色总长跟着百分比走，但段间比例不变
  const small = meter.describe(payload({ used: 141_800, limit: 200_000 }));
  const smallSum = small.segments.reduce((total, item) => total + item.width, 0);
  assert.ok(Math.abs(smallSum - 70.9) < 0.01, `实际 ${smallSum}`);
  assert.ok(Math.abs(small.segments[2].width / smallSum - view.segments[2].width / sum) < 0.001);

  // 压缩过的会话：摘要 > 0 时多出一行
  const withSummary = meter.describe(payload({ breakdown: { system: 100, tools: 200, history: 300, summary: 572 } }));
  assert.deepEqual(
    withSummary.segments.map((item) => item.key),
    ['system', 'tools', 'history', 'summary'],
  );
  assert.equal(withSummary.segments[3].text, '572');
});

test('/com 判定：大小写不敏感、/compact 等价、前缀不算命中', () => {
  const meter = meterOf();
  for (const text of ['/com', '/COM', '/Com', '/compact', '/Compact', '  /com  ', '/com 保留最近20条']) {
    assert.equal(meter.isCompactCommand(text), true, `${text} 应命中`);
  }
  for (const text of ['/comment', '/comx', 'com', '请用 /com 压一下', '', '/compact2']) {
    assert.equal(meter.isCompactCommand(text), false, `${text} 不该命中`);
  }
});

test('圆环的颜色与布局在 shell.css 里（不是内联样式），三档各有类名', () => {
  assert.match(shellCss, /\.context-ring-btn\s*\{[^}]*--ctx-color:\s*var\(--blue\)/s);
  assert.match(shellCss, /\.context-ring-btn\.lvl-warn\s*\{[^}]*--ctx-color:\s*var\(--orange\)/s);
  assert.match(shellCss, /\.context-ring-btn\.lvl-hot\s*\{[^}]*--ctx-color:\s*var\(--red\)/s);
  assert.match(shellCss, /\.ctx-ring-svg\s+\.ring-bar\s*\{[^}]*stroke:\s*var\(--ctx-color\)/s);
  // 段宽走 CSS 变量（CSP 禁内联 style 属性；CSSOM 写变量是允许的）
  assert.match(shellCss, /\.ctx-seg\s*\{[^}]*width:\s*var\(--ctx-w/s);
  assert.doesNotMatch(appSource, /style="[^"]*stroke-dashoffset/, 'app.js 不能拼内联样式');
});

test('设置页：上下文上限默认 1,000,000，并说明它只当分母', async () => {
  const { window, PC, El } = bootRenderer({ api: async () => ({ ok: true }) });
  PC.api = async (url) => {
    if (url.startsWith('/ai/config')) {
      return { ok: true, config: { contextWindow: 1_000_000, searchEnabled: true, searchProvider: 'auto', searchMaxPages: 8 } };
    }
    return { ok: true };
  };
  const section = window.PCModules.settingsSections().find((item) => item.id === 'chat.settings');
  assert.ok(section, '「对话设置」区块应该注册着');

  const host = new El('div');
  section.render(host);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const input = host.querySelector('.cs-context-window');
  assert.ok(input, '要有「上下文上限」的数字输入');
  assert.equal(input.type, 'number');
  assert.equal(input.value, '1000000', '默认 1,000,000');
  assert.equal(input.min, '8000');
  assert.equal(input.max, '2000000');
  const text = host
    .querySelectorAll('.cs-field-hint')
    .map((node) => node.textContent)
    .join('\n');
  assert.match(text, /分母/, '必须写清它是"用量指示"的分母');
  assert.match(text, /不改变窗口截断规则/, '必须写清它不改变截断规则');
});
