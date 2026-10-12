/**
 * 规划中的功能页（占位登记）。
 *
 * 这些功能尚未实现，但左栏先保留入口，让整体导航从第一天起就是完整形态。
 *
 * 当前没有占位页；随手拍已合并进笔记系统。
 * 已经落地、不再占位的：「学业」由 `views/academic.js` 实现（id `academic`，order 40）、
 * 「笔记系统」由 `views/notes/notes.js` 实现（id `notes`，order 50）。
 * 「网课」不再是独立入口 —— 直播与回放本来就来自思源学堂，已并入 `views/lms.js` 的「网课」页签。
 *
 * **实现某个功能时**：
 *   1. 新建 `src/renderer/views/<id>.js`，用 PCModules.register 登记同名 id；
 *   2. 在 index.html 里加一行 `<script src="views/<id>.js"></script>`（放在本文件之后）；
 *   3. 把下面 PLANNED 里对应的一项删掉。
 *
 * 注册表是「后注册覆盖先注册」，所以顺序错了也不会坏，只是会同时存在一个没人用的占位。
 */

(function () {
  const PLANNED = [];

  for (const item of PLANNED) {
    const view = placeholderView(item.label, item.desc, item.bullets);
    window.PCModules.register({
      id: item.id,
      label: item.label,
      icon: item.icon,
      order: item.order,
      title: item.label,
      render: (ctx) => view.render(ctx),
    });
  }
})();
