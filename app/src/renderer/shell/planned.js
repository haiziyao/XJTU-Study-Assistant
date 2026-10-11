/**
 * 规划中的功能页（占位登记）。
 *
 * 这些功能尚未实现，但左栏先保留入口，让整体导航从第一天起就是完整形态。
 *
 * 目前占位：学情 / 随手拍。
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
  const PLANNED = [
    {
      id: 'study',
      label: '学情',
      icon: '📈',
      order: 40,
      desc: '学情分析由 AI 智学主程序汇总，本模块只提供日历与日程的原始数据。',
      bullets: [
        '统计口径：/api/v1/schedules/stats（完成率、计划时长）',
        '已就绪：日程与事件的区间聚合 /api/v1/calendar',
        '待主程序接入：错题、笔记、听课记录等学习行为数据',
      ],
    },
    {
      id: 'snapshot',
      label: '随手拍',
      icon: '📷',
      order: 60,
      desc: '随手拍只负责「拍下来先存着」，识别与整理交给笔记系统与主程序。',
      bullets: [
        '拍摄 / 选图由主程序或系统能力完成，本模块不处理图片二进制',
        '一条随手拍确认后：进「笔记系统」，或用 POST /api/v1/todos、POST /api/v1/events 生成待办 / 日程',
        '落库时间沿用日历统一的日期与时刻语义（YYYY-MM-DD、HH:MM）',
      ],
    },
  ];

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
