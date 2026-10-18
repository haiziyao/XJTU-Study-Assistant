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

    // 左栏上部：对话 / 日历 / 待办 / 番茄钟 / 课表导入 / 思源学堂 / 学业 / 笔记系统 / 传输 / 日志；随手拍已并入笔记系统
    // 「学业」原先是 `study` 占位页，已由 views/academic.js 以 id `academic` 正式实现
    // 「对话」（id `chat`，order 1）是 AI 中枢：对话管理 / 记忆管理 / 知识库管理 / 定时唤醒，
    // 刻意排在日历之前 —— AI 是这个程序的主入口，管理它的入口不该埋在设置里
    // 注意「网课」没有独立入口：直播 + 回放归到思源学堂视图里，左栏再出现 course 就是回归
    // 「传输」（order 66）排在「笔记系统」之后、「日志」之前：它属于"学习工作流"，不是系统级功能
    // 「课表导入」（order 23）在待办(20)之后、学堂(30)之前，是本次新增的独立页面。
    // 学习周报不再占左栏入口：它是「待办」页里的一个面板（views/weekly-panel.js），
    // 因此这里**不该**再出现周报入口（学习周报是待办页里的面板）。
    assert.deepEqual(main, ['chat', 'calendar', 'todo', 'pomodoro', 'timetable', 'lms', 'academic', 'notes', 'transfer', 'message']);
    // id 保持 `message` 是为了不破坏用户已存盘的左栏布局；展示名已改为「日志」。
    assert.equal(modules.get('message').label, '日志');
    assert.equal(modules.get('message').icon, 'clock');
    assert.equal(modules.get('message').title, '日志');
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

test('左栏自定义：纯逻辑与外壳服务都挂上了（设置卡片靠它们工作）', async () => {
  const { app, origin, scripts } = await loadRenderer();
  try {
    const context = makeSandbox(origin);
    vm.runInContext(scripts.map((s) => s.text).join('\n;\n'), context, { filename: 'renderer-bundle.js' });

    // 1) 纯逻辑：判断全在这里，外壳与弹窗只调它。缺一个函数 = 左栏直接坏掉。
    const layout = context.window.PCSidebarLayout;
    assert.ok(layout, '应挂载 window.PCSidebarLayout');
    for (const name of ['parse', 'stringify', 'defaults', 'resolve', 'move', 'dropTarget', 'resolveNavClick', 'isNavActive']) {
      assert.equal(typeof layout[name], 'function', `PCSidebarLayout.${name} 应是函数`);
    }
    assert.equal(layout.STORAGE_KEY, 'potato.sidebar');

    // 2) 默认布局必须等于"加这个功能之前的样子"：全部常驻、没有一个收进「更多」。
    //    这是"首次运行零变化"的保证 —— 一上线就把别人的入口藏起来是不可接受的。
    const views = Array.from(context.window.PCModules.list());
    const resolved = layout.resolve(null, views);
    assert.deepEqual(Array.from(resolved.more), [], '默认不该有任何一项被收进「更多」');
    assert.deepEqual(
      Array.from(resolved.main),
      views.filter((v) => (v.slot ?? 'main') !== 'bottom').map((v) => v.id),
      '默认顺序应等于注册表顺序',
    );

    // 3) 外壳服务：设置卡片与弹窗只通过这些动作改左栏，不碰 state
    const sidebar = context.window.PCModules.getService('sidebar');
    assert.ok(sidebar, "应登记 'sidebar' 服务");
    for (const name of ['getLayout', 'getMovable', 'apply', 'reset', 'describe']) {
      assert.equal(typeof sidebar[name], 'function', `sidebar.${name} 应是函数`);
    }
    // describe 要能按 id 画出与左栏一致的一行
    const described = sidebar.describe('settings');
    assert.equal(described.id, 'settings');
    assert.ok(described.label, 'describe 应给出 label');
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


/**
 * 结构性契约：**视图必须自己创建 `.view-content` 滚动容器**。
 *
 * 外壳的 `.panel-body` 是 `overflow: hidden` 的 flex 容器（见 shell.css），真正滚动的是视图挂进去的
 * `.view-content`（`flex:1; min-height:0; overflow:auto`）。忘了它就表现为"内容一多就被裁掉、
 * 而且滚不动"，`PC.snapshotScroll()` 也会一起失效 —— 这个 bug 真的上过线
 * （用户原话：「神人没给对话页面加滚动」）。这里只盯**标签页式的三个中枢页**：
 * 日历/学堂/学业有各自的滚动与吸顶逻辑，笔记系统是独立工作区布局，都不在这个契约范围内。
 */
test('视图契约：标签页式中枢页（对话/传输）各自创建 .view-content 滚动容器', async () => {
  const views = ['chat-hub.js', 'transfer.js'];
  for (const file of views) {
    const source = await readFile(new URL(`../src/renderer/views/${file}`, import.meta.url), 'utf8');
    assert.match(source, /mk\('div', 'view-content'\)/, `${file} 要自己建 .view-content（否则 .panel-body 把它裁掉且不能滚）`);
  }
});


/**
 * 滚动跟随：**只在用户本来就贴底时才跟随**。
 *
 * 真机 bug：流式增量（正文与"思考过程"）是每帧触发的，之前那两处无条件写
 * `scrollTop = scrollHeight` —— 用户往上翻的时候每一帧都被拽回底部，表现出来就是
 * "发送消息后聊天窗口不能顺利滚动"。这条测试锁住修好后的语义：
 *   贴底（距底 < 24px）→ 跟随；往上翻了 → 一动不动。
 */
test('聊天滚动：贴底时跟随最新内容，用户往上翻后不再被拽回底部', async () => {
  const { app, origin, scripts } = await loadRenderer();
  try {
    const context = makeSandbox(origin);
    vm.runInContext(scripts.map((s) => s.text).join('\n;\n'), context, { filename: 'renderer-bundle.js' });
    const helpers = context.window.__PC_SCROLL__;
    assert.ok(helpers, '渲染层要暴露 __PC_SCROLL__ 供测试断言');
    // 用一个"假滚动容器"断言判断口径：不必启动整个外壳（真实布局尺寸在 jsdom/vm 里拿不到）
    const log = { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 };

    // ① 用户往上翻了：距底 800px，跟随必须"不动"
    log.scrollTop = 0;
    assert.equal(helpers.isPinnedToBottom(log), false, '距底 800px 不算贴底');
    helpers.followBottom(false, log);
    assert.equal(log.scrollTop, 0, '用户往上翻之后，流式增量不许把视图拽回底部');

    // ② 用户滚回底部附近（距底 10px）：应当继续跟随
    log.scrollTop = 790;
    assert.equal(helpers.isPinnedToBottom(log), true, '距底 10px 算贴底');
    helpers.followBottom(false, log);
    assert.equal(log.scrollTop, 1000, '贴底时应当跟到最新内容');

    // ③ force：新消息/新卡片是用户自己的动作，无论在哪都跟到底
    log.scrollTop = 0;
    helpers.followBottom(true, log);
    assert.equal(log.scrollTop, 1000, 'force 用于"刚发了消息"这类必须看到最新内容的情况');
  } finally {
    await app.close();
  }
});


/**
 * 输入法组合期间的回车**不能发送**（用户报的 bug：打字时按回车确认候选词，消息被直接发出去）。
 * 三个判断缺一不可：`isComposing`、`keyCode === 229`、以及 compositionend 之后的时间窗
 * （Safari 会在组合结束前就把 isComposing 置回 false）。这里做源码级契约断言：
 * 任何一处被删掉，实机就会又开始误发。
 */
test('输入区：回车发送必须避开输入法组合（isComposing / keyCode 229 / 组合结束时间窗）', async () => {
  const source = await readFile(new URL('../src/renderer/shell/app.js', import.meta.url), 'utf8');
  assert.match(source, /compositionstart/, '要监听 compositionstart');
  assert.match(source, /compositionend/, '要监听 compositionend');
  assert.match(source, /event\.isComposing === true/, '要判 event.isComposing');
  assert.match(source, /event\.keyCode === 229/, '要判 keyCode === 229（部分输入法只给这个）');
  assert.match(source, /Date\.now\(\) < composingUntil/, '要有组合结束后的时间窗（Safari 的 isComposing 复位更早）');
  assert.match(source, /if \(event\.shiftKey\) return;/, 'Shift+回车仍是换行');
});
