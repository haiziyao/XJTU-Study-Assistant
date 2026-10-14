/**
 * 左栏布局的**纯逻辑**（classic script，无构建步骤，不碰 document）。
 *
 * 为什么单独成一个文件、为什么一行 DOM 都不碰
 * ------------------------------------------
 * 左栏自定义里有三件事要判断：**排序怎么合并**、**拖动落在哪**、**点一下之后面板该怎样**。
 * 这三件事全都只跟数字和数组有关，一旦写进事件回调里就再也测不了了 ——
 * 而测试环境（test/renderer-chat.test.js 的 mini-DOM）**没有真实布局、没有
 * getBoundingClientRect、没有指针事件**，靠 DOM 测拖动是测不出来的。
 *
 * 所以这里只做"给输入、出输出"的纯函数，外壳（shell/app.js）与弹窗
 * （shell/sidebar-customize.js）负责取坐标、套类名、调它们。这与仓库既有的
 * `modules/sync/merge.js`（纯逻辑）+ `modules/sync/service.js`（搬运）是同一套分法。
 *
 * 三条不变式（改动这块时别破坏）
 * -----------------------------
 * 1. `slot: 'bottom'` 的项**永远**在 bottom 区，不进 main/more，用户拖不动它。
 * 2. 注册表里新增、而存下来的布局没提到的 id → **追加到 main**（新功能默认可见）。
 * 3. 高亮 = `(面板展开) && view === id`；收起面板**不清空 view**，所以再展开还是同一个功能。
 */

window.PCSidebarLayout = (function () {
  'use strict';

  /** localStorage 键名。与 `potato.theme` / `potato.permission` 同一套命名。 */
  const STORAGE_KEY = 'potato.sidebar';

  /** 存盘格式的版本号：将来形状变了就靠它识别"这是旧数据"。 */
  const VERSION = 1;

  /**
   * 把某个 id 从布局里彻底摘掉（两区都查）。
   * 内部工具，`move()` 与 `resolve()` 共用。
   */
  function without(layout, id) {
    return {
      main: layout.main.filter((item) => item !== id),
      more: layout.more.filter((item) => item !== id),
    };
  }

  /**
   * 解析存下来的字符串；任何异常都返回 `null`（调用方据此回落到默认布局）。
   *
   * 为什么坏数据要退化成 null 而不是尽量抢救：这是用户的一项显示偏好，
   * 读不出来就用默认排法，没有任何东西会丢。硬要"尽量解析"只会把半截数据
   * 当成用户的真实意图，反而更难解释。
   */
  function parse(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    // 版本不认识 = 不猜它的语义，直接用默认布局
    if (Number(data.v) !== VERSION) return null;
    if (!Array.isArray(data.main) || !Array.isArray(data.more)) return null;
    return {
      main: data.main.filter((id) => typeof id === 'string' && id),
      more: data.more.filter((id) => typeof id === 'string' && id),
    };
  }

  /** 序列化（写盘时用）。 */
  function stringify(layout) {
    return JSON.stringify({
      v: VERSION,
      main: [...(layout?.main ?? [])],
      more: [...(layout?.more ?? [])],
    });
  }

  /**
   * 默认布局：注册表顺序，全部常驻、没有一个收进「更多」。
   *
   * 这样**首次运行与加这个功能之前逐像素一致** —— 特性是用户主动加入的，
   * 不该一上线就把别人的常用入口藏起来。
   */
  function defaults(views) {
    return {
      main: views.filter((view) => (view.slot ?? 'main') !== 'bottom').map((view) => view.id),
      more: [],
    };
  }

  /**
   * 把「存下来的布局」与「当前注册表」合并成可渲染的三区布局。
   *
   * @param {{main: string[], more: string[]}|null} stored 存下来的（可来自 `parse()`）
   * @param {Array<{id: string, slot?: string}>} views 当前注册表（`PCModules.list()` 的顺序）
   * @returns {{main: string[], more: string[], bottom: string[]}}
   */
  function resolve(stored, views) {
    const list = Array.isArray(views) ? views : [];
    const bottom = list.filter((view) => (view.slot ?? 'main') === 'bottom').map((view) => view.id);
    // bottom 项不参与可拖动布局，先把它们从"合法 id"里排掉
    const movable = new Set(
      list.filter((view) => (view.slot ?? 'main') !== 'bottom').map((view) => view.id),
    );

    if (!stored) {
      const base = defaults(list);
      return { main: base.main, more: base.more, bottom };
    }

    const seen = new Set();
    const pick = (ids) => {
      const out = [];
      for (const id of Array.isArray(ids) ? ids : []) {
        // 已删除的功能、bottom 项、重复项 —— 三种都丢弃
        if (!movable.has(id) || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
      return out;
    };

    // main 先挑：同一个 id 两区都有时以 main 为准（去重靠 seen 的先后）
    const main = pick(stored.main);
    const more = pick(stored.more);
    // ★ 注册表里有、两个列表都没提到的 = **本次更新新增的功能** → 追加到 main 末尾。
    // 反过来（塞进 more）会让用户"更新完发现少了个入口"，且没有任何提示。
    for (const id of movable) if (!seen.has(id)) main.push(id);

    return { main, more, bottom };
  }

  /**
   * 把 `id` 移到 `zone` 区的第 `index` 个位置，返回**新的** layout（不改原对象）。
   *
   * @param {{main: string[], more: string[]}} layout
   * @param {string} id
   * @param {'main'|'more'} zone
   * @param {number} [index] 目标下标；越界会夹到合法范围，不传则追加到末尾
   */
  function move(layout, id, zone, index) {
    const target = zone === 'more' ? 'more' : 'main';
    const base = without({ main: [...(layout?.main ?? [])], more: [...(layout?.more ?? [])] }, id);
    const list = base[target];
    const at = Number.isFinite(index) ? Math.max(0, Math.min(Math.trunc(index), list.length)) : list.length;
    list.splice(at, 0, id);
    return base;
  }

  /**
   * 拖动落点判定：给指针的 Y 坐标与两个区的几何，算出该插到哪个区、哪个下标。
   *
   * 输入全是普通数字（rect 用 `{top, bottom}`），所以不需要真实布局就能测。
   *
   * @param {{pointerY: number, zones: Array<{name: 'main'|'more', rect: {top:number,bottom:number}, rows: Array<{id: string, rect: {top:number,bottom:number}}>}>}} input
   * @returns {{zone: 'main'|'more', index: number}|null} 落在两区之外时返回 null（调用方什么都不做）
   */
  function dropTarget({ pointerY, zones } = {}) {
    const y = Number(pointerY);
    if (!Number.isFinite(y)) return null;
    for (const zone of Array.isArray(zones) ? zones : []) {
      const rect = zone?.rect;
      if (!rect) continue;
      // 用闭区间：正好落在分区边界上时算命中，不要让指针"卡在缝里"什么都不发生
      if (y < rect.top || y > rect.bottom) continue;
      const rows = Array.isArray(zone.rows) ? zone.rows : [];
      let index = rows.length;
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        const middle = (row.rect.top + row.rect.bottom) / 2;
        // 落在某行的上半 → 插到它前面；下半 → 插到它后面
        if (y < middle) {
          index = i;
          break;
        }
      }
      return { zone: zone.name === 'more' ? 'more' : 'main', index };
    }
    return null;
  }

  /**
   * 点了左栏某一项之后，桌面端的面板该怎么变。
   *
   * 这是"再点一次收起"的全部语义，也是**唯一**能保证
   * 「高亮状态」与「面板显隐」不分家的地方 —— 两件事由同一个返回值决定。
   *
   *   · 点的是**已高亮**的那一项 → 收起面板，`render: false`（内容留在 DOM 里，不白重画一次）
   *   · 其余情况（点别的项 / 面板已收起）→ 切到被点的项并展开，`render: true`
   *
   * `view` 在收起时**原样保留**，所以再展开还是同一个功能（要求 10）。
   */
  function resolveNavClick({ collapsed, view, clicked } = {}) {
    if (!collapsed && clicked === view) {
      return { view, collapsed: true, render: false };
    }
    return { view: clicked, collapsed: false, render: true };
  }

  /**
   * 某一项现在该不该高亮。
   *
   * 宽屏与窄屏是**同一条规则的两个分支**（"当前可见的那一屏里，这一项是不是正在显示的那个"）：
   *   - 窄屏：正在看功能页，且就是它；
   *   - 宽屏：面板没收起，且就是它。
   * 写在一处是为了让"高亮 ⇔ 面板可见"这条不变式只有一份实现 ——
   * 以前宽屏与窄屏各写一个循环，任何一处漏改就会出现"高亮在日历、面板还是待办"。
   */
  function isNavActive({ mobile, screen, collapsed, view, id } = {}) {
    if (mobile) return screen === 'panel' && view === id;
    return !collapsed && view === id;
  }

  return {
    STORAGE_KEY,
    VERSION,
    parse,
    stringify,
    defaults,
    resolve,
    move,
    dropTarget,
    resolveNavClick,
    isNavActive,
  };
})();
