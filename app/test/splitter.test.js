/**
 * 中/右栏分界线的渲染层测试。
 *
 * 外壳是 classic script 的 IIFE，`boot()` 需要一套真实的 index.html DOM 才跑得起来；
 * 所以这里用仓库现有的 DOM 桩（helpers/renderer-dom.js）求值外壳脚本，再直接驱动
 * `window.__PC_SPLITTER__` 暴露的**产品代码本身**（不是为测试另写一套逻辑）。
 *
 * 覆盖：
 *   - 首次运行的宽度仍是 CSS 默认的 128 / 592 / 780（不写任何内联宽度）；
 *   - 拖拽改变右栏宽度、中栏自动让位，并在 380 / 中栏 360 处夹紧；
 *   - 双击恢复默认；
 *   - 键盘 ←/→/Home/End；
 *   - 持久化（本地 + 后端）与"下次启动"（重建 DOM）读回；非法值夹紧；
 *   - ≤900px：CSS 隐藏 + JS 不生效。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { bootRenderer } from './helpers/renderer-dom.js';

const shellCss = readFileSync(new URL('../src/renderer/shell/shell.css', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');

/** localStorage 桩：外壳里的 readStored/writeStored 就是读 window.localStorage。 */
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

/** 与 CSS 默认公式一致：min(56%, 780px)。 */
const cssDefaultPanel = (width) => Math.min(width * 0.56, 780);

/**
 * 建一套假 DOM + 分界线实例。
 *
 * @param {object} [options]
 * @param {number} [options.width] 视口宽度
 * @param {number} [options.sidebar] 左栏宽度（1500px 下 CSS 算出来是 128）
 * @param {string|null} [options.stored] 预置的 localStorage['potato.split']
 * @param {boolean} [options.active] 是否宽屏可拖（默认 true）
 * @param {boolean} [options.useDefaultActive] 用外壳自己的 matchMedia 判定（测窄屏默认行为）
 */
function setup(options = {}) {
  const {
    width = 1500,
    sidebar = 128,
    stored = null,
    active = true,
    useDefaultActive = false,
    // true = matchMedia 跟着 setViewport 变（测窗口跨过 900px 断点）
    autoActive = false,
  } = options;
  const { window, El } = bootRenderer({ api: async () => ({ ok: true }) });
  const splitterApi = window.__PC_SPLITTER__;
  assert.ok(splitterApi, '外壳应挂载 window.__PC_SPLITTER__ 测试缝');

  const storage = makeStorage(stored == null ? {} : { 'potato.split': stored });
  window.localStorage = storage;
  window.innerWidth = width;
  // 视口/左栏允许在用例里改，用来驱动 handleResize（真实环境由 window 提供）
  let viewport = width;
  let sidebarWidth = sidebar;
  // 默认 isActive 读 matchMedia；显式 active 的用例不依赖它
  window.matchMedia = (query) => ({ media: query, matches: autoActive ? !(viewport > 900) : !active });

  const app = new El('div');
  app.className = 'app';
  const chat = new El('section');
  chat.className = 'chat';
  const panel = new El('section');
  panel.className = 'panel';
  // 面板的初始实测宽度：模拟浏览器布局（桩里的 getBoundingClientRect 固定是 500）
  let initialPanel = cssDefaultPanel(width);
  app.append(chat, panel);

  const saves = [];
  const splitter = new El('div');
  const instance = splitterApi.create({
    app,
    panel,
    splitter,
    body: window.document.body,
    viewportWidth: () => viewport,
    sidebarWidth: () => sidebarWidth,
    panelWidth: () => initialPanel,
    // undefined 时 create() 自己走 isSplitterActive()
    isActive: useDefaultActive ? undefined : () => active,
    persist: (ratio) => {
      saves.push(ratio);
    },
  });

  return {
    window,
    El,
    splitterApi,
    storage,
    app,
    chat,
    panel,
    splitter,
    instance,
    saves,
    /** 中栏宽度 = 视口 - 左栏 - 右栏（grid 的 1fr 自动让位）。 */
    chatWidth: () => viewport - sidebarWidth - instance.panelWidth,
    setInitialPanelWidth: (value) => {
      initialPanel = value;
    },
    /** 模拟窗口缩放（真实环境里由 window resize 事件触发 handleResize）。 */
    setViewport: (nextWidth, nextSidebar = sidebarWidth) => {
      viewport = nextWidth;
      sidebarWidth = nextSidebar;
      window.innerWidth = nextWidth;
    },
  };
}

test('首次运行：右栏仍是 CSS 默认 780，中栏 592，且不写内联宽度', () => {
  const { app, instance, splitter, splitterApi } = setup();

  // 1500px：sidebar = clamp(80, 150, 128) = 128；panel = min(840, 780) = 780；chat = 592
  assert.equal(splitterApi.defaultPanelWidth(1500), 780);
  const metrics = splitterApi.splitMetrics(1500, 128);
  assert.equal(metrics.available, 1372);
  assert.equal(metrics.min, 380);
  assert.equal(metrics.max, 1012); // 1372 - 中栏最小 360
  assert.equal(instance.panelWidth, 780, '右栏默认 780');
  assert.equal(1500 - 128 - instance.panelWidth, 592, '中栏默认 592');
  assert.equal(app.style.getPropertyValue('--panel-w'), '', '没存过比例时不能写 --panel-w');
  assert.equal(instance.ratio, null);

  // 无障碍契约：可聚焦的竖分隔条，初始值就是真实宽度
  assert.equal(splitter.getAttribute('role'), 'separator');
  assert.equal(splitter.getAttribute('tabindex'), '0');
  assert.equal(splitter.getAttribute('aria-orientation'), 'vertical');
  assert.equal(splitter.getAttribute('aria-valuenow'), '780');
  assert.equal(splitter.getAttribute('aria-valuemin'), '380');
  assert.equal(splitter.getAttribute('aria-valuemax'), '1012');
});

test('分界线不占网格列：CSS 仍是三列，线是绝对定位覆盖层（默认像素不变的原因）', () => {
  assert.match(
    shellCss,
    /\.app\s*\{[^}]*grid-template-columns:\s*var\(--sidebar-w\)\s+minmax\(300px,\s*1fr\)\s+var\(--panel-w\);/s,
    '三栏网格定义不能被分界线改成 4 列',
  );
  assert.match(shellCss, /\.col-splitter\s*\{[^}]*position:\s*absolute;/s, '分界线必须是覆盖层');
  assert.match(shellCss, /\.col-splitter\s*\{[^}]*right:\s*calc\(var\(--panel-w\)\s*-\s*3px\);/s);
  assert.match(shellCss, /\.col-splitter\s*\{[^}]*cursor:\s*col-resize;/s);
  // 节点由 JS 创建，index.html 不动
  assert.doesNotMatch(indexHtml, /col-splitter/);
});

test('拖拽：右栏变宽、中栏让位，并在 1012 / 380 两端夹紧', () => {
  const { instance, app, saves, storage, chatWidth, window } = setup();
  const body = window.document.body;

  instance.handlePointerDown({ button: 0, pointerId: 1, clientX: 1000 });
  assert.equal(body.classList.contains('resizing'), true, '拖动中 body 应有 resizing 类');
  assert.equal(instance.dragging, true);

  // 指针左移 200px → 右栏 +200 = 980；中栏 = 1500 - 128 - 980 = 392
  instance.handlePointerMove({ pointerId: 1, clientX: 800 });
  assert.equal(instance.panelWidth, 980);
  assert.equal(chatWidth(), 392, '中栏必须自动让位');
  assert.equal(app.style.getPropertyValue('--panel-w'), '980px');

  // 继续拖到最左：上限 = 1372 - 360 = 1012（中栏正好 360）
  instance.handlePointerMove({ pointerId: 1, clientX: 0 });
  assert.equal(instance.panelWidth, 1012, '右栏上限 1012');
  assert.equal(chatWidth(), 360, '中栏被夹在最小 360');
  assert.equal(app.style.getPropertyValue('--panel-w'), '1012px');

  // 反向拖到最右：下限 = 右栏最小 380（中栏 992）
  instance.handlePointerMove({ pointerId: 1, clientX: 3000 });
  assert.equal(instance.panelWidth, 380, '右栏下限 380');
  assert.equal(chatWidth(), 992);

  instance.handlePointerUp({ pointerId: 1, clientX: 3000 });
  assert.equal(body.classList.contains('resizing'), false, '松手后要摘掉 resizing');
  assert.equal(instance.dragging, false);
  // 松手后写本地 + 后端（比例 = 380 / 1372）
  assert.equal(storage.getItem('potato.split'), String(380 / 1372));
  assert.equal(saves.at(-1), 380 / 1372);
  assert.equal(instance.splitter.getAttribute('aria-valuenow'), '380');
});

test('双击恢复默认：删内联宽度、清本地、后端写 null', () => {
  const { instance, app, saves, storage } = setup();

  instance.handlePointerDown({ button: 0, pointerId: 1, clientX: 1000 });
  instance.handlePointerMove({ pointerId: 1, clientX: 850 });
  instance.handlePointerUp({ pointerId: 1, clientX: 850 });
  assert.equal(instance.panelWidth, 930);
  assert.notEqual(app.style.getPropertyValue('--panel-w'), '');

  instance.handleDoubleClick({});
  assert.equal(instance.panelWidth, 780, '双击回到 CSS 默认 780');
  assert.equal(1500 - 128 - instance.panelWidth, 592);
  assert.equal(app.style.getPropertyValue('--panel-w'), '', '默认宽度交回 CSS 公式');
  assert.equal(storage.getItem('potato.split'), '');
  assert.equal(saves.at(-1), null, '后端用 value:null 删除这份偏好');
  assert.equal(instance.ratio, null);
});

test('键盘：←/→ 每次 24px，Home/End 到最小/最大，并持久化', () => {
  const { instance, saves } = setup();

  const press = (key) => {
    let prevented = false;
    instance.handleKeyDown({
      key,
      preventDefault() {
        prevented = true;
      },
    });
    return prevented;
  };

  assert.equal(press('ArrowRight'), true, '方向键要 preventDefault（否则页面会横向滚动）');
  assert.equal(instance.panelWidth, 756, '→ 把分界线往右推 24px → 右栏变窄');
  assert.equal(press('ArrowLeft'), true);
  assert.equal(instance.panelWidth, 780);
  assert.equal(press('Home'), true);
  assert.equal(instance.panelWidth, 380, 'Home = 右栏最小');
  assert.equal(instance.splitter.getAttribute('aria-valuenow'), '380');
  assert.equal(press('End'), true);
  assert.equal(instance.panelWidth, 1012, 'End = 右栏最大');
  assert.equal(instance.splitter.getAttribute('aria-valuenow'), '1012');
  assert.equal(press('PageUp'), false, '无关按键不处理');

  // 键盘调整也必须能跨重启：最后一次 End 的比例 = 1012 / 1372
  assert.equal(saves.at(-1), 1012 / 1372);
  assert.equal(instance.ratio, 1012 / 1372);
});

test('持久化：拖出来的比例能在重建 DOM 后读回；非法值按窗口夹紧', () => {
  const first = setup();
  first.instance.handlePointerDown({ button: 0, pointerId: 1, clientX: 1000 });
  first.instance.handlePointerMove({ pointerId: 1, clientX: 800 });
  first.instance.handlePointerUp({ pointerId: 1, clientX: 800 });
  const stored = first.storage.getItem('potato.split');
  assert.equal(stored, String(980 / 1372));

  // 「下次启动」：新的 DOM 桩 + 同一份 localStorage
  const second = setup({ stored });
  assert.equal(second.instance.panelWidth, 980, '重建 DOM 后仍是 980');
  assert.equal(second.app.style.getPropertyValue('--panel-w'), '980px');

  // 合法但超出当前窗口能力：0.99 * 1372 = 1358 → 夹到 1012
  const tooWide = setup({ stored: '0.99' });
  assert.equal(tooWide.instance.panelWidth, 1012);
  assert.equal(tooWide.app.style.getPropertyValue('--panel-w'), '1012px');

  // 0.01 * 1372 = 13.7 → 夹到 380
  const tooNarrow = setup({ stored: '0.01' });
  assert.equal(tooNarrow.instance.panelWidth, 380);
  assert.equal(tooNarrow.app.style.getPropertyValue('--panel-w'), '380px');

  // 完全不是数字：视为没存过，保持 CSS 默认，不写样式
  const junk = setup({ stored: 'not-a-ratio' });
  assert.equal(junk.instance.panelWidth, 780);
  assert.equal(junk.app.style.getPropertyValue('--panel-w'), '');

  // 对象形状（未来扩展）也能读
  assert.equal(setup({ stored: '{"ratio":0.5}' }).instance.panelWidth, 686); // 0.5 * 1372
});

test('窗口缩放：按比例重算；缩到放不下时再次夹紧，放大后回到原比例', () => {
  // 用外壳自己的 matchMedia 判定"现在是不是宽屏"，setViewport 会同步改窗口宽度
  const { instance, app, chatWidth, setViewport } = setup({ useDefaultActive: true, autoActive: true });
  // 拖到 980（比例 980/1372 ≈ 0.7142857）
  instance.handlePointerDown({ button: 0, pointerId: 1, clientX: 1000 });
  instance.handlePointerMove({ pointerId: 1, clientX: 800 });
  instance.handlePointerUp({ pointerId: 1, clientX: 800 });
  assert.equal(instance.panelWidth, 980);

  // 窗口缩到 1100（左栏 110 → 可用 990）：按比例是 707，但中栏会只剩 283 < 360，
  // 所以必须夹到 990 - 360 = 630。比例本身不丢，窗口再放大时仍能恢复。
  setViewport(1100, 110);
  instance.handleResize();
  assert.equal(instance.panelWidth, 630, '缩放后按比例重算并夹紧');
  assert.equal(chatWidth(), 360);
  assert.equal(app.style.getPropertyValue('--panel-w'), '630px');
  assert.equal(instance.ratio, 980 / 1372, '夹紧不改变用户比例');

  // 放大回 1500：同一比例回到 980
  setViewport(1500, 128);
  instance.handleResize();
  assert.equal(instance.panelWidth, 980);
  assert.equal(chatWidth(), 392);

  // 窄到 ≤900：清掉内联宽度，交回 CSS 默认（手机/窄屏不应用固定像素）
  setViewport(800, 80);
  instance.handleResize();
  assert.equal(app.style.getPropertyValue('--panel-w'), '');
});

test('≤900px：CSS 隐藏分界线，JS 拖拽/键盘/双击全部不生效', () => {
  // CSS：900px 断点里明确 display:none（手机布局 760px 以下同样命中）
  assert.match(shellCss, /@media \(max-width:\s*900px\)\s*\{[\s\S]*?\.col-splitter\s*\{\s*display:\s*none;/, '≤900 要隐藏分界线');
  // 面板收起 / 笔记专注时也隐藏（恢复后靠 --panel-w 回到上次比例）
  assert.match(shellCss, /body\.panel-collapsed \.col-splitter,\s*body\.notes-focus \.col-splitter\s*\{\s*display:\s*none;/);

  const mobile = setup({ width: 800, sidebar: 80, active: false, stored: '0.7', useDefaultActive: true });
  assert.equal(mobile.instance.isActive(), false, 'matchMedia 命中 ≤900 时应判定不可拖');
  assert.equal(mobile.app.style.getPropertyValue('--panel-w'), '', '窄屏不能应用持久化宽度');

  const before = mobile.storage.getItem('potato.split');
  const savesBefore = mobile.saves.length;
  mobile.instance.handlePointerDown({ button: 0, pointerId: 1, clientX: 700 });
  mobile.instance.handlePointerMove({ pointerId: 1, clientX: 200 });
  mobile.instance.handlePointerUp({ pointerId: 1, clientX: 200 });
  mobile.instance.handleKeyDown({ key: 'ArrowLeft', preventDefault() {} });
  mobile.instance.handleDoubleClick({});

  assert.equal(mobile.instance.dragging, false, '窄屏不应进入拖动状态');
  assert.equal(mobile.window.document.body.classList.contains('resizing'), false);
  assert.equal(mobile.app.style.getPropertyValue('--panel-w'), '', '窄屏拖拽无效');
  assert.equal(mobile.storage.getItem('potato.split'), before, '窄屏不应改写偏好');
  assert.equal(mobile.saves.length, savesBefore, '窄屏不应写后端');
});

test('挂载：用 JS 在中栏与右栏之间插入 .col-splitter 节点', () => {
  const { window, El } = bootRenderer({ api: async () => ({ ok: true }) });
  const splitterApi = window.__PC_SPLITTER__;
  const storage = makeStorage();
  window.localStorage = storage;
  window.innerWidth = 1500;
  window.matchMedia = (query) => ({ media: query, matches: false });

  const app = new El('div');
  app.className = 'app';
  const chat = new El('section');
  chat.className = 'chat';
  const panel = new El('section');
  panel.className = 'panel';
  app.append(chat, panel);
  const sidebar = new El('aside');
  sidebar.className = 'sidebar';
  sidebar.getBoundingClientRect = () => ({ width: 128, height: 900, top: 0, left: 0, right: 128, bottom: 900 });

  // DOM 桩没有 querySelector/insertBefore，这里按真实选择器补上（只影响测试环境）
  window.document.querySelector = (selector) => {
    if (selector === '.app') return app;
    if (selector === '.panel') return panel;
    if (selector === '.sidebar') return sidebar;
    return null;
  };

  const instance = splitterApi.mount({ panelWidth: () => 780 });
  assert.ok(instance, '挂载应返回实例');
  assert.deepEqual(
    app.children.map((node) => node.className),
    ['chat', 'col-splitter', 'panel'],
    '分界线必须夹在中栏与右栏之间',
  );
  assert.equal(instance.splitter.className, 'col-splitter');
  assert.equal(instance.splitter.getAttribute('role'), 'separator');
  assert.equal(instance.splitter.getAttribute('aria-valuenow'), '780');
});
