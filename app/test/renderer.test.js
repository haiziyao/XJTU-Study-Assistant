/**
 * 渲染层结构与加载测试。
 *
 * 前端是「无构建步骤的 classic script + 视图注册表」，没有编译器帮你查错，
 * 因此这里用两招兜住拆分/新增视图时最容易踩的坑：
 *   1. 起真实后端，把 index.html 引用的每个 css/js 都取一遍（路径写错立刻暴露）；
 *   2. 用一个极简 DOM 桩把全部脚本按 index.html 的顺序求值一次，
 *      捕获语法错误与顶层引用错误（浏览器里会表现为「整页白屏」）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { ACTIVITY_TYPE_LABEL } from '../src/modules/lms/config.js';

/** 起服务，并取回 index.html 与它引用的全部资源。 */
async function loadRenderer() {
  const app = await createServer({ dataDir: await mkdtemp(path.join(tmpdir(), 'potato-renderer-')) });
  const info = await app.listen({ port: 0 });
  const origin = info.baseUrl.replace(/\/api\/v1$/, '');

  const html = await (await fetch(`${origin}/app/`)).text();
  const assets = [
    ...[...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]),
  ];

  const scripts = [];
  const styles = [];
  for (const asset of assets) {
    const response = await fetch(`${origin}/app/${asset}`);
    const record = { asset, status: response.status, type: response.headers.get('content-type') ?? '', text: await response.text() };
    (asset.endsWith('.css') ? styles : scripts).push(record);
  }

  return { app, origin, html, assets, scripts, styles };
}

/** 极简 DOM 桩：够让顶层代码跑完即可（不模拟真实渲染）。 */
function makeSandbox(origin) {
  const el = () => ({
    className: '', textContent: '', innerHTML: '', title: '', type: '', value: '', dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    append() {}, appendChild() {}, addEventListener() {}, setAttribute() {},
    querySelector: () => el(), querySelectorAll: () => [], focus() {},
  });
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, Date, Math, JSON, Promise, Error, TypeError, Number, String, Boolean, Array, Object,
    RegExp, Map, Set, Intl, isNaN, parseInt, parseFloat,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
    WebSocket: function WebSocket() { this.close = () => {}; },
    location: { protocol: 'http:', host: '127.0.0.1:3210', hostname: '127.0.0.1', pathname: '/app/', search: '', origin },
    document: {
      readyState: 'loading',
      documentElement: { style: { setProperty() {} } },
      getElementById: () => el(),
      createElement: () => el(),
      querySelectorAll: () => [],
      addEventListener() {},
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return vm.createContext(sandbox);
}

test('测试页面引用的每个 css/js 都能取到，且 MIME 正确', async () => {
  const { app, assets, scripts, styles } = await loadRenderer();
  try {
    assert.ok(assets.length >= 10, `index.html 应引用多个资源，实际 ${assets.length}`);
    for (const item of scripts) {
      assert.equal(item.status, 200, `${item.asset} 应可访问`);
      assert.match(item.type, /javascript/, `${item.asset} 的 MIME 应为 javascript`);
    }
    for (const item of styles) {
      assert.equal(item.status, 200, `${item.asset} 应可访问`);
      assert.match(item.type, /text\/css/, `${item.asset} 的 MIME 应为 css`);
    }
    // 外壳与视图必须分层：外壳在 shell/ 下，模块视图在 views/ 下
    assert.ok(scripts.some((s) => s.asset.startsWith('shell/')));
    assert.ok(scripts.some((s) => s.asset.startsWith('views/')));
  } finally {
    await app.close();
  }
});

test('前端脚本按 index.html 顺序求值无异常（无语法错误 / 顶层引用错误）', async () => {
  const { app, origin, scripts } = await loadRenderer();
  try {
    const context = makeSandbox(origin);
    // 一次性拼接求值：与浏览器「多个 classic script 共享全局词法作用域」的语义一致
    const bundle = scripts.map(({ asset, text }) => `/* ==== ${asset} ==== */\n${text}`).join('\n;\n');
    vm.runInContext(bundle, context, { filename: 'renderer-bundle.js' });
    assert.ok(context.window.PCModules, '应挂载 window.PCModules');
    assert.ok(context.window.PCUtil, '应挂载 window.PCUtil');
  } finally {
    await app.close();
  }
});

test('视图注册表：顺序、插槽与跨模块服务符合外壳约定', async () => {
  const { app, origin, scripts } = await loadRenderer();
  try {
    const context = makeSandbox(origin);
    vm.runInContext(scripts.map((s) => s.text).join('\n;\n'), context, { filename: 'renderer-bundle.js' });

    const modules = context.window.PCModules;
    // vm 里创建的数组原型属于另一个 realm，断言前用 Array.from 归一到宿主 realm
    const ids = (slot) => Array.from(modules.list()).filter((v) => v.slot === slot).map((v) => v.id);
    const main = ids('main');
    const bottom = ids('bottom');

    // 左栏上部：日历 / 待办 / 思源学堂 / 学业 / 笔记系统 / 随手拍 / 消息
    // 「学业」原先是 `study` 占位页，已由 views/academic.js 以 id `academic` 正式实现
    // 注意「网课」没有独立入口：直播 + 回放归到思源学堂视图里，左栏再出现 course 就是回归
    assert.deepEqual(main, ['calendar', 'todo', 'lms', 'academic', 'notes', 'snapshot', 'message']);
    // 左栏底部固定为设置
    assert.deepEqual(bottom, ['settings']);

    for (const view of modules.list()) {
      assert.equal(typeof view.render, 'function', `视图 ${view.id} 必须有 render`);
      assert.ok(view.label, `视图 ${view.id} 必须有 label`);
      assert.ok(view.title, `视图 ${view.id} 必须有 title`);
    }

    // 左栏图标：登记的 emoji 必须能在外壳图标表里命中，否则会退化成「一个裸 emoji」
    for (const view of modules.list()) {
      const svg = context.window.PCIcons?.svg?.(view.icon, 20);
      assert.match(String(svg), /^<svg /, `视图 ${view.id} 的图标 ${view.icon} 应命中图标表`);
    }

    // 跨模块能力：日历模块提供的编辑弹层，其它视图通过服务取用而不是互相引用
    assert.equal(typeof modules.getService('editor'), 'function', "应登记 'editor' 服务");
  } finally {
    await app.close();
  }
});

test('静态资源不暴露 renderer 目录之外的文件', async () => {
  const { app, origin } = await loadRenderer();
  try {
    for (const probe of ['/app/../package.json', '/app/%2e%2e%2fpackage.json', '/app/../src/server/index.js']) {
      const response = await fetch(`${origin}${probe}`, { redirect: 'manual' });
      assert.notEqual(response.status, 200, `${probe} 不应可读`);
      await response.body?.cancel();
    }
  } finally {
    await app.close();
  }
});

test('思源学堂：活动类型的中文标签，前端与后端两份表必须同步', async () => {
  // 前端是 classic script（模块内的 const 取不到），所以这里直接读源码比对：
  // 后端 config.js 有、前端漏掉的话，真实账号里那些类型会在列表里显示成裸英文
  // —— online_video（在线视频）就这么漏过一次，真机自检抓到的。
  const source = await readFile(new URL('../src/renderer/views/lms.js', import.meta.url), 'utf8');
  const block = source.match(/const LMS_ACTIVITY_LABEL = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'views/lms.js 里应有 LMS_ACTIVITY_LABEL');
  const frontend = new Map([...block[1].matchAll(/^\s*([A-Za-z_]\w*):\s*'([^']*)'/gm)].map((m) => [m[1], m[2]]));
  for (const [type, label] of Object.entries(ACTIVITY_TYPE_LABEL)) {
    assert.equal(frontend.get(type), label, `前端缺 ${type} 的中文标签，会显示成裸英文`);
  }
});
