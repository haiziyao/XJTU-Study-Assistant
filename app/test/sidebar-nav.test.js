/**
 * 左栏点击语义与外壳接线的行为测试。
 *
 * 为什么必须单独测这一层：需求里"点已高亮的项 → 收起；再展开 → 还是同一个功能；
 * 已展开时切换 → 只换内容"这条不变式，**一半在纯逻辑里、一半在外壳的落地动作里**
 * （`state.panelCollapsed` / `body.panel-collapsed` / `.nav-item.active` 三处必须同时变）。
 * `sidebar-layout.test.js` 测的是前者；这里测后者 —— 否则回归时第一个坏掉的就是它，
 * 而靠肉眼看浏览器是发现不了"高亮和面板差了一次点击"的。
 *
 * mini-DOM 是**为本文件现写的小桩**（renderer-chat.test.js 那份是对话专用的，不能共用），
 * 只实现左栏真正用到的那几个 API。没有真实布局，所以拖动路径不在这里测
 * （那部分由 `sidebar-layout.test.js` 的 dropTarget 覆盖）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { makeDom } from './helpers/mini-dom.js';

/* ============================================================ 装载与接线 */

async function bootNav({ mobile = false } = {}) {
  const app = await createServer({ dataDir: await mkdtemp(path.join(tmpdir(), 'potato-nav-')) });
  try {
    return await wire(app, mobile);
  } catch (error) {
    // ★ 装配中途抛错必须把服务器关掉再往外抛：漏一个仍在监听的进程，
    //   后面每个用例都会因为 8886 被占而连带失败，进程还会永远不退出（表现为"卡死"）。
    await app.close();
    throw error;
  }
}

async function wire(app, mobile) {
  const info = await app.listen({ port: 0 });
  const origin = info.baseUrl.replace(/\/api\/v1$/, '');
  const html = await (await fetch(`${origin}/app/`)).text();
  const assets = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const scripts = [];
  for (const asset of assets) scripts.push(await (await fetch(`${origin}/app/${asset}`)).text());

  const dom = makeDom();
  const store = new Map();
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    Date,
    Math,
    JSON,
    Promise,
    Error,
    TypeError,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    Map,
    Set,
    Intl,
    isNaN,
    parseInt,
    parseFloat,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
    WebSocket: function WebSocket() {
      this.close = () => {};
    },
    location: { protocol: 'http:', host: '127.0.0.1:3210', hostname: '127.0.0.1', pathname: '/app/', search: '', hash: '', origin },
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    // 布局模式由测试说了算：窄屏分支与宽屏分支的点击语义不同，两边都要能测
    matchMedia: () => ({ matches: mobile, addEventListener() {}, removeEventListener() {} }),
    document: dom.document,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInContext(scripts.join('\n;\n'), vm.createContext(sandbox), { filename: 'renderer-bundle.js' });

  const nav = sandbox.window.__PC_NAV_TEST__;
  assert.ok(nav, '外壳应挂载 __PC_NAV_TEST__（左栏的测试缝）');

  // 建出真实 index.html 里那几个容器，交给外壳（真实运行时是 boot() 干的）
  const el = (tag, id) => {
    const node = dom.createElement(tag);
    if (id) {
      node.id = id;
      node.setAttribute('id', id);
    }
    return node;
  };
  const refs = {
    nav: el('nav', 'nav'),
    navBottom: el('nav', 'nav-bottom'),
    navMore: el('button', 'nav-more'),
    navMorePop: el('div', 'nav-more-pop'),
    panelTitle: el('h2', 'panel-title'),
    panelBody: el('div', 'panel-body'),
    panelHead: el('div', 'panel-head'),
    panelToggle: el('button', 'panel-toggle'),
  };
  // ★ 挂进文档树：真实 `document.querySelectorAll` 只找**还在页面上**的节点。
  //   不挂的话，`buildNav()` 重排后摘下来的旧按钮仍会被查到，高亮断言就会看到两个 active。
  for (const node of Object.values(refs)) dom.document.body.appendChild(node);

  // 面板内容不参与本文件的断言，而真实视图的 render 需要 `window.PC`（由 boot() 建立，
  // 测试里刻意不跑 boot）。所以把每个视图的 render 换成空实现，**保留 order/slot/label/icon** ——
  // 左栏的排序与图标仍然按真实注册表来。
  const bare = new Map();
  for (const view of Array.from(sandbox.window.PCModules.list())) bare.set(view.id, view);
  for (const view of bare.values()) sandbox.window.PCModules.register({ ...view, render: () => {} });

  nav.attachDom(refs);
  nav.buildNav();

  const buttons = () => refs.nav.children.filter((node) => node.classList.contains('nav-item'));
  const buttonFor = (id) => buttons().find((node) => node.dataset.view === id)
    ?? refs.navBottom.children.find((node) => node.dataset.view === id)
    ?? refs.navMorePop.children.find((node) => node.dataset.view === id);
  const activeIds = () =>
    dom.document
      .querySelectorAll('.nav-item')
      .filter((node) => node.classList.contains('active') && node.dataset.view)
      .map((node) => node.dataset.view);
  const collapsed = () => sandbox.document.body.classList.contains('panel-collapsed');

  return { app, nav, refs, dom, sandbox, store, buttons, buttonFor, activeIds, collapsed };
}

/* ================================================================== 用例 */

test('左栏按注册表顺序渲染，默认没有「更多」，高亮与面板一致', async () => {
  const ctx = await bootNav();
  try {
    const ids = ctx.buttons().map((node) => node.dataset.view);
    assert.deepEqual(
      Array.from(ids),
      ['chat', 'calendar', 'todo', 'pomodoro', 'timetable', 'lms', 'notifications', 'academic', 'notes', 'transfer', 'message'],
      '默认顺序应等于注册表顺序',
    );
    assert.equal(ctx.refs.navMore.hidden, true, '★ 默认不该出现「更多」（首次运行零变化）');
    // 左栏第 8 项原来的「消息」已改名为「日志」（id 保持 message，用户已存盘的布局不会失效）
    assert.equal(ctx.sandbox.window.PCModules.get('message').label, '日志');
    assert.match(ctx.buttonFor('message').textContent, /日志/);
    assert.doesNotMatch(ctx.buttonFor('message').textContent, /消息/);
    assert.deepEqual(Array.from(ctx.refs.navBottom.children.map((n) => n.dataset.view)), ['settings']);
    // 启动时 view = calendar、面板展开 → 日历高亮
    assert.deepEqual(Array.from(ctx.activeIds()), ['calendar']);
    assert.equal(ctx.collapsed(), false);
  } finally {
    await ctx.app.close();
  }
});

test('★ 点已高亮的项 → 收起面板且高亮消失；再展开回到同一个功能', async () => {
  const ctx = await bootNav();
  try {
    // 起点：日历高亮、面板展开
    assert.deepEqual(Array.from(ctx.activeIds()), ['calendar']);

    // 点「日历」自己 = 收起
    ctx.buttonFor('calendar').click();
    assert.equal(ctx.collapsed(), true, '★ 面板应收起');
    assert.deepEqual(Array.from(ctx.activeIds()), [], '★ 高亮应消失（不变式：高亮 ⇔ 面板可见）');
    assert.equal(ctx.nav.state.view, 'calendar', '★ 收起不清空 view');

    // 面板上的 ⟩/⟨ 按钮 = 展开
    ctx.nav.togglePanel();
    assert.equal(ctx.collapsed(), false);
    assert.deepEqual(Array.from(ctx.activeIds()), ['calendar'], '★ 展开后还是日历，不是别的功能');
  } finally {
    await ctx.app.close();
  }
});

test('★ 已展开时点别的项 → 只换内容，面板保持展开', async () => {
  const ctx = await bootNav();
  try {
    ctx.buttonFor('todo').click();
    assert.equal(ctx.collapsed(), false, '★ 已展开时切换不该把面板收起来');
    assert.deepEqual(Array.from(ctx.activeIds()), ['todo']);
    assert.equal(ctx.nav.state.view, 'todo');

    ctx.buttonFor('lms').click();
    assert.equal(ctx.collapsed(), false);
    assert.deepEqual(Array.from(ctx.activeIds()), ['lms']);
  } finally {
    await ctx.app.close();
  }
});

test('收起状态下点另一项 → 直接展开到那一项', async () => {
  const ctx = await bootNav();
  try {
    ctx.buttonFor('calendar').click(); // 先收起
    assert.equal(ctx.collapsed(), true);
    ctx.buttonFor('notes').click();
    assert.equal(ctx.collapsed(), false, '应当展开');
    assert.deepEqual(Array.from(ctx.activeIds()), ['notes']);
  } finally {
    await ctx.app.close();
  }
});

test('收起 → 展开 → 收起：反复切换不残留高亮', async () => {
  const ctx = await bootNav();
  try {
    for (let i = 0; i < 3; i += 1) {
      ctx.buttonFor('transfer').click();
      assert.equal(ctx.collapsed(), false);
      assert.deepEqual(Array.from(ctx.activeIds()), ['transfer'], `第 ${i + 1} 轮展开`);
      ctx.buttonFor('transfer').click();
      assert.equal(ctx.collapsed(), true);
      assert.deepEqual(Array.from(ctx.activeIds()), [], `第 ${i + 1} 轮收起`);
    }
  } finally {
    await ctx.app.close();
  }
});

test('★ 把某项移进「更多」后：左栏不再有它、「更多」出现、点它能打开', async () => {
  const ctx = await bootNav();
  try {
    const sidebar = ctx.sandbox.window.PCModules.getService('sidebar');
    const layout = sidebar.getLayout();
    // 把「传输」收进「更多」（等价于在弹窗里拖到下半区）
    sidebar.apply(ctx.sandbox.window.PCSidebarLayout.move(layout, 'transfer', 'more', 0));

    const ids = ctx.buttons().map((node) => node.dataset.view);
    assert.ok(!ids.includes('transfer'), '★ 收起的项不该再出现在常驻区');
    assert.equal(ctx.refs.navMore.hidden, false, '★ 有收起项时「更多」必须出现');
    assert.deepEqual(Array.from(ctx.nav.layout().more), ['transfer']);

    // 布局落盘了（刷新后还在）
    assert.ok(ctx.store.get('potato.sidebar')?.includes('transfer'), '应写进 localStorage');

    // 点「更多」→ 弹层列出「传输」→ 点它 → 面板切过去
    ctx.nav.toggleMorePop();
    assert.equal(ctx.refs.navMorePop.hidden, false, '弹层应展开');
    const item = ctx.refs.navMorePop.children.find((node) => node.dataset.view === 'transfer');
    assert.ok(item, '弹层里应有「传输」');
    item.click();
    assert.equal(ctx.nav.state.view, 'transfer');
    assert.equal(ctx.collapsed(), false);
    assert.equal(ctx.refs.navMorePop.hidden, true, '点了项之后弹层应关闭');
  } finally {
    await ctx.app.close();
  }
});

test('当前视图被收进「更多」时，高亮转到「更多」按钮上', async () => {
  const ctx = await bootNav();
  try {
    const sidebar = ctx.sandbox.window.PCModules.getService('sidebar');
    // 先切到传输并展开
    ctx.buttonFor('transfer').click();
    assert.deepEqual(Array.from(ctx.activeIds()), ['transfer']);

    // 再把它收进「更多」
    sidebar.apply(ctx.sandbox.window.PCSidebarLayout.move(sidebar.getLayout(), 'transfer', 'more', 0));
    assert.deepEqual(Array.from(ctx.activeIds()), [], '原按钮已经不在常驻区了');
    assert.equal(ctx.refs.navMore.classList.contains('active'), true, '★ 高亮应转移到「更多」上');

    // 面板收起后「更多」也不该亮（不变式仍然成立）
    ctx.nav.setPanelCollapsed(true);
    assert.equal(ctx.refs.navMore.classList.contains('active'), false);
  } finally {
    await ctx.app.close();
  }
});

test('「更多」区空掉后按钮消失；「恢复默认」回到初始排布', async () => {
  const ctx = await bootNav();
  try {
    const sidebar = ctx.sandbox.window.PCModules.getService('sidebar');
    sidebar.apply(ctx.sandbox.window.PCSidebarLayout.move(sidebar.getLayout(), 'message', 'more', 0));
    assert.equal(ctx.refs.navMore.hidden, false);

    sidebar.apply(ctx.sandbox.window.PCSidebarLayout.move(sidebar.getLayout(), 'message', 'main', 8));
    assert.equal(ctx.refs.navMore.hidden, true, '空掉之后按钮要收起来');

    // 恢复默认：坏掉的存储也要能救回来
    ctx.store.set('potato.sidebar', '{ 这不是 json');
    sidebar.reset();
    assert.equal(ctx.refs.navMore.hidden, true);
    assert.deepEqual(
      Array.from(ctx.buttons().map((n) => n.dataset.view)),
      ['chat', 'calendar', 'todo', 'pomodoro', 'timetable', 'lms', 'notifications', 'academic', 'notes', 'transfer', 'message'],
    );
  } finally {
    await ctx.app.close();
  }
});

test('「更多」按钮只有一行标签（曾经出现两行「更多」）', async () => {
  const ctx = await bootNav();
  try {
    const sidebar = ctx.sandbox.window.PCModules.getService('sidebar');
    sidebar.apply(ctx.sandbox.window.PCSidebarLayout.move(sidebar.getLayout(), 'transfer', 'more', 0));

    const texts = (node) => node.childNodes.map((child) => child.textContent).filter((text) => text.trim());
    const labels = texts(ctx.refs.navMore).filter((text) => text.includes('更多'));
    assert.equal(
      labels.length,
      1,
      `★ 「更多」按钮上应当只有一行「更多」，实际 ${labels.length} 行 —— ` +
        'HTML 里的静态文字和 buildNav() 加的 .nav-label 会各占一行',
    );
    // 图标 + 标签两项，与其它导航项结构一致
    assert.equal(ctx.refs.navMore.childNodes.length, 2, '应当是「图标 + 标签」两项');
  } finally {
    await ctx.app.close();
  }
});

test('窄屏：点导航仍是"切到那一屏"，不做收起', async () => {
  const ctx = await bootNav({ mobile: true });
  try {
    ctx.buttonFor('todo').click();
    assert.equal(ctx.collapsed(), false, '窄屏不该出现"收起面板"这个状态');
    assert.equal(ctx.nav.state.view, 'todo');
    // 窄屏切视图 = 切到"功能页"那一屏（由 setMobileScreen 挂 body.mobile-panel）
    assert.equal(ctx.sandbox.document.body.classList.contains('mobile-panel'), true, '应切到功能页那一屏');
    // 再点一次同一项：窄屏语义下仍是"切到那一屏"，不是收起
    ctx.buttonFor('todo').click();
    assert.equal(ctx.collapsed(), false, '★ 窄屏再点同一项不该收起');
    assert.equal(ctx.nav.state.view, 'todo');
  } finally {
    await ctx.app.close();
  }
});
