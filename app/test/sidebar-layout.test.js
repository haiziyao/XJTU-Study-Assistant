/**
 * 左栏布局纯逻辑单测（`shell/sidebar-layout.js`）。
 *
 * 这个文件是 classic script、且刻意**一行 DOM 都不碰**（判断全是"给输入、出输出"），
 * 所以这里不搭 DOM 桩，直接在一个只带 `window` 的 vm 上下文里求值 —— 与
 * `richtext.test.js` 同一套做法。拖动落点本来就是几何计算，靠 DOM 反而测不出来
 * （测试环境的 mini-DOM 没有真实布局，也没有 getBoundingClientRect）。
 *
 * 重点覆盖四类"错了用户会直接看出来"的情况：
 *   1. **默认布局必须等于加这个功能之前的样子** —— 否则一上线就把别人的入口藏了；
 *   2. **新增功能默认可见** —— 更新完发现少一个入口，且没有任何提示，是最难查的一类；
 *   3. **点击状态机**：收起时不许重画、收起不许清空 view（再展开要回到同一个功能）；
 *   4. **拖动落点**：上半/下半插入位置不同、落在区外什么都不做。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const SOURCE = await readFile(new URL('../src/renderer/shell/sidebar-layout.js', import.meta.url), 'utf8');

function load() {
  const sandbox = { window: {}, console };
  sandbox.globalThis = sandbox;
  vm.runInContext(SOURCE, vm.createContext(sandbox), { filename: 'sidebar-layout.js' });
  return sandbox.window.PCSidebarLayout;
}

const L = load();

/** 注册表样本：与真实注册表同形状、同顺序（见 test/renderer.test.js 的顺序断言）。 */
const VIEWS = [
  { id: 'chat', slot: 'main' },
  { id: 'calendar', slot: 'main' },
  { id: 'todo', slot: 'main' },
  { id: 'lms', slot: 'main' },
  { id: 'academic', slot: 'main' },
  { id: 'notes', slot: 'main' },
  { id: 'review', slot: 'main' },
  { id: 'transfer', slot: 'main' },
  { id: 'message', slot: 'main' },
  { id: 'settings', slot: 'bottom' },
];

const ids = (list) => Array.from(list);

/**
 * 把 `dropTarget()` 的返回值抄进**宿主 realm** 的普通对象。
 *
 * vm 里造出来的对象原型属于另一个 realm，`assert.deepEqual` 会判
 * "结构相同但不是同一个引用" —— 断言前必须归一一下（数组那边用 `Array.from`，同理）。
 */
const target = (value) => (value === null || value === undefined ? null : { zone: value.zone, index: value.index });

/* ------------------------------------------------------------ 默认与解析 */

test('默认布局 = 注册表顺序、全部常驻、没有一个收进「更多」', () => {
  const layout = L.resolve(null, VIEWS);
  // ★ 这条是"首次运行与加功能之前逐像素一致"的保证
  assert.deepEqual(ids(layout.main), ['chat', 'calendar', 'todo', 'lms', 'academic', 'notes', 'review', 'transfer', 'message']);
  assert.deepEqual(ids(layout.more), []);
  assert.deepEqual(ids(layout.bottom), ['settings']);
});

test('bottom 项永远只进 bottom，不进 main/more', () => {
  const layout = L.resolve(null, VIEWS);
  assert.ok(!ids(layout.main).includes('settings'));
  assert.ok(!ids(layout.more).includes('settings'));
  // 就算存盘数据硬把它写进 main，也要被丢掉
  const forced = L.resolve({ main: ['settings', 'chat'], more: [] }, VIEWS);
  assert.ok(!ids(forced.main).includes('settings'), 'bottom 项不该被拖进常驻区');
  assert.deepEqual(ids(forced.bottom), ['settings']);
});

test('★ 注册表里新增的 id 自动追加到 main 末尾（新功能默认可见）', () => {
  const stored = { main: ['calendar', 'chat'], more: ['transfer'] };
  const grown = [...VIEWS, { id: 'brandnew', slot: 'main' }];
  const layout = L.resolve(stored, grown);
  assert.ok(ids(layout.main).includes('brandnew'), '新增功能必须出现在常驻区');
  assert.equal(ids(layout.main).at(-1), 'brandnew', '追加到末尾，不打乱用户已排好的顺序');
  // 用户自己的排法与归属不受影响
  assert.deepEqual(ids(layout.main).slice(0, 2), ['calendar', 'chat']);
  assert.deepEqual(ids(layout.more), ['transfer']);
});

test('已被删除的 id 会被丢弃', () => {
  const stored = { main: ['chat', 'ghost'], more: ['phantom'] };
  const layout = L.resolve(stored, VIEWS);
  assert.deepEqual(ids(layout.main).slice(0, 1), ['chat']);
  assert.ok(!ids(layout.main).includes('ghost'));
  assert.ok(!ids(layout.more).includes('phantom'));
});

test('同一个 id 两区都有时以 main 为准（去重）', () => {
  const layout = L.resolve({ main: ['calendar'], more: ['calendar', 'transfer'] }, VIEWS);
  assert.ok(ids(layout.main).includes('calendar'));
  assert.ok(!ids(layout.more).includes('calendar'), 'more 里那份要去掉');
  assert.deepEqual(ids(layout.more), ['transfer']);
});

test('坏数据一律退回默认布局（而不是"尽量解析"）', () => {
  for (const bad of [null, undefined, '', '   ', 'not json', '{}', '[]', '{"v":1}', '{"v":99,"main":[],"more":[]}', '{"v":1,"main":"chat","more":[]}']) {
    const parsed = L.parse(bad);
    assert.equal(parsed, null, `${JSON.stringify(bad)} 应解析为 null`);
    const layout = L.resolve(parsed, VIEWS);
    assert.deepEqual(ids(layout.main), ['chat', 'calendar', 'todo', 'lms', 'academic', 'notes', 'review', 'transfer', 'message']);
    assert.deepEqual(ids(layout.more), []);
  }
});

test('parse/stringify 往返一致，且非字符串元素被过滤', () => {
  const layout = { main: ['calendar', 'chat'], more: ['transfer'] };
  const back = L.parse(L.stringify(layout));
  assert.deepEqual(ids(back.main), ['calendar', 'chat']);
  assert.deepEqual(ids(back.more), ['transfer']);

  const dirty = L.parse('{"v":1,"main":["chat",3,null,""],"more":[]}');
  assert.deepEqual(ids(dirty.main), ['chat'], '非字符串/空串要被过滤掉');
});

/* ------------------------------------------------------------------ 移动 */

test('move：区内前移、跨区插入、追加', () => {
  const base = { main: ['a', 'b', 'c'], more: ['x', 'y'] };
  // 区内前移
  assert.deepEqual(ids(L.move(base, 'c', 'main', 0).main), ['c', 'a', 'b']);
  // 跨区：main -> more 的第 1 位
  const crossed = L.move(base, 'a', 'more', 1);
  assert.deepEqual(ids(crossed.main), ['b', 'c']);
  assert.deepEqual(ids(crossed.more), ['x', 'a', 'y']);
  // 不传下标 = 追加到末尾
  assert.deepEqual(ids(L.move(base, 'a', 'more').more), ['x', 'y', 'a']);
  // 不改原对象
  assert.deepEqual(ids(base.main), ['a', 'b', 'c']);
});

test('move：越界下标被夹紧，不会产生空洞', () => {
  const base = { main: ['a', 'b'], more: [] };
  assert.deepEqual(ids(L.move(base, 'a', 'main', 999).main), ['b', 'a']);
  assert.deepEqual(ids(L.move(base, 'a', 'main', -5).main), ['a', 'b']);
  assert.deepEqual(ids(L.move(base, 'a', 'main', 1.7).main), ['b', 'a'], '小数下标取整');
});

test('move 到不认识的区名时落到 main（不静默丢掉这一项）', () => {
  const moved = L.move({ main: ['a'], more: ['b'] }, 'b', 'nonsense', 0);
  assert.deepEqual(ids(moved.main), ['b', 'a']);
  assert.deepEqual(ids(moved.more), []);
});

/* -------------------------------------------------------------- 拖动落点 */

/** 造一份几何：两区各若干行，行高 40，区间隔 20。 */
function geometry(mainIds, moreIds) {
  const rows = (list, top) =>
    list.map((id, i) => ({ id, rect: { top: top + i * 40, bottom: top + i * 40 + 40 } }));
  const mainTop = 100;
  const mainBottom = mainTop + mainIds.length * 40;
  const moreTop = mainBottom + 20;
  return {
    zones: [
      { name: 'main', rect: { top: mainTop, bottom: mainBottom }, rows: rows(mainIds, mainTop) },
      { name: 'more', rect: { top: moreTop, bottom: moreTop + moreIds.length * 40 }, rows: rows(moreIds, moreTop) },
    ],
    mainTop,
    moreTop,
  };
}

test('dropTarget：落在某行上半插到它前面，下半插到它后面', () => {
  const g = geometry(['a', 'b', 'c'], ['x']);
  // 第 1 行（a）的上半 → 下标 0
  assert.deepEqual(target(L.dropTarget({ pointerY: g.mainTop + 5, zones: g.zones })), { zone: 'main', index: 0 });
  // 第 1 行（a）的下半 → 下标 1
  assert.deepEqual(target(L.dropTarget({ pointerY: g.mainTop + 35, zones: g.zones })), { zone: 'main', index: 1 });
  // 第 3 行（c）的下半 → 末尾
  assert.deepEqual(target(L.dropTarget({ pointerY: g.mainTop + 115, zones: g.zones })), { zone: 'main', index: 3 });
});

test('dropTarget：能落到下半区（收进「更多」）', () => {
  const g = geometry(['a', 'b'], ['x', 'y']);
  // more 区两行，跨度 0~80：5 落在第 1 行上半，45 落在第 2 行上半，65 落在第 2 行下半（= 追加）
  assert.deepEqual(target(L.dropTarget({ pointerY: g.moreTop + 5, zones: g.zones })), { zone: 'more', index: 0 });
  assert.deepEqual(target(L.dropTarget({ pointerY: g.moreTop + 45, zones: g.zones })), { zone: 'more', index: 1 });
  assert.deepEqual(target(L.dropTarget({ pointerY: g.moreTop + 65, zones: g.zones })), { zone: 'more', index: 2 });
});

test('dropTarget：空区仍然可以接收（下标 0）', () => {
  // 真实的空区是"有高度、没有行"（CSS 给了 min-height），这样才有个地方可以放
  const zones = [
    { name: 'main', rect: { top: 100, bottom: 140 }, rows: [{ id: 'a', rect: { top: 100, bottom: 140 } }] },
    { name: 'more', rect: { top: 160, bottom: 220 }, rows: [] },
  ];
  assert.deepEqual(target(L.dropTarget({ pointerY: 190, zones })), { zone: 'more', index: 0 });
  assert.deepEqual(target(L.dropTarget({ pointerY: 160, zones })), { zone: 'more', index: 0 }, '上边界也算命中');
  // 而"高度为 0 的区"是落不进去的 —— 这正是 CSS 必须给 min-height 的原因
  const flat = [{ name: 'more', rect: { top: 200, bottom: 200 }, rows: [] }];
  assert.deepEqual(target(L.dropTarget({ pointerY: 200, zones: flat })), { zone: 'more', index: 0 }, '退化成一个点仍可命中');
  assert.equal(target(L.dropTarget({ pointerY: 205, zones: flat })), null);
});

test('dropTarget：落在两区之外或坐标非法 → null（调用方什么都不做）', () => {
  const g = geometry(['a'], ['x']);
  assert.equal(target(L.dropTarget({ pointerY: 0, zones: g.zones })), null, '顶部空白');
  assert.equal(target(L.dropTarget({ pointerY: 99999, zones: g.zones })), null, '底部空白');
  assert.equal(target(L.dropTarget({ pointerY: g.mainTop + 200, zones: g.zones })), null, '两区之间的缝');
  assert.equal(target(L.dropTarget({ pointerY: NaN, zones: g.zones })), null);
  assert.equal(target(L.dropTarget({ zones: g.zones })), null);
  assert.equal(target(L.dropTarget({ pointerY: 10, zones: [] })), null);
  assert.equal(target(L.dropTarget()), null);
});

test('dropTarget：边界上算命中（不让指针卡在缝里）', () => {
  const g = geometry(['a'], ['x']);
  assert.deepEqual(target(L.dropTarget({ pointerY: g.mainTop, zones: g.zones })), { zone: 'main', index: 0 });
  assert.deepEqual(target(L.dropTarget({ pointerY: g.moreTop, zones: g.zones })), { zone: 'more', index: 0 });
});

/* ------------------------------------------------------------ 点击状态机 */

test('★ 点已高亮的项 → 收起且不重画；view 原样保留', () => {
  const next = L.resolveNavClick({ collapsed: false, view: 'calendar', clicked: 'calendar' });
  assert.equal(next.collapsed, true);
  assert.equal(next.render, false, '收起不该白重画一次（内容留在 DOM 里）');
  assert.equal(next.view, 'calendar', '★ 收起不清空 view，再展开要回到同一个功能');
});

test('★ 面板已收起时点同一项 → 展开同一个功能', () => {
  const next = L.resolveNavClick({ collapsed: true, view: 'calendar', clicked: 'calendar' });
  assert.equal(next.collapsed, false);
  assert.equal(next.render, true);
  assert.equal(next.view, 'calendar');
});

test('★ 面板展开时点别的项 → 换内容，面板保持展开', () => {
  const next = L.resolveNavClick({ collapsed: false, view: 'calendar', clicked: 'todo' });
  assert.equal(next.view, 'todo');
  assert.equal(next.collapsed, false, '已展开时切换不该把面板收起来');
  assert.equal(next.render, true);
});

test('面板收起时点别的项 → 直接展开到那一项', () => {
  const next = L.resolveNavClick({ collapsed: true, view: 'calendar', clicked: 'todo' });
  assert.equal(next.view, 'todo');
  assert.equal(next.collapsed, false);
  assert.equal(next.render, true);
});

test('往返：收起 → 用面板按钮展开 → 仍是同一个功能（要求 10）', () => {
  // 从"日历展开"出发，点一次自己 = 收起
  const collapsed = L.resolveNavClick({ collapsed: false, view: 'calendar', clicked: 'calendar' });
  // 面板上的 ⟩/⟨ 按钮 = setPanelCollapsed(false)，不经过 resolveNavClick，view 不变
  assert.equal(collapsed.view, 'calendar');
  const reopened = { view: collapsed.view, collapsed: false };
  assert.equal(reopened.view, 'calendar', '★ 展开后必须还是日历');
});

/* ---------------------------------------------------------------- 高亮 */

test('isNavActive：宽屏 = 面板展开且就是它', () => {
  const base = { mobile: false, screen: 'panel', collapsed: false, view: 'calendar' };
  assert.equal(L.isNavActive({ ...base, id: 'calendar' }), true);
  assert.equal(L.isNavActive({ ...base, id: 'todo' }), false);
  // 收起后同一项不再高亮（要求 8、9）
  assert.equal(L.isNavActive({ ...base, collapsed: true, id: 'calendar' }), false);
});

test('isNavActive：窄屏 = 正在看功能页且就是它（宽屏的 collapsed 不参与）', () => {
  const base = { mobile: true, collapsed: false, view: 'calendar' };
  assert.equal(L.isNavActive({ ...base, screen: 'panel', id: 'calendar' }), true);
  // 手机刚打开是"视图=日历、屏幕=聊天"：不该有高亮
  assert.equal(L.isNavActive({ ...base, screen: 'chat', id: 'calendar' }), false);
  assert.equal(L.isNavActive({ ...base, screen: 'panel', id: 'todo' }), false);
});

test('导出面完整（外壳与弹窗靠这些名字对接）', () => {
  for (const name of ['STORAGE_KEY', 'parse', 'stringify', 'defaults', 'resolve', 'move', 'dropTarget', 'resolveNavClick', 'isNavActive']) {
    assert.ok(L[name] !== undefined, `应导出 ${name}`);
  }
  assert.equal(L.STORAGE_KEY, 'potato.sidebar');
});
