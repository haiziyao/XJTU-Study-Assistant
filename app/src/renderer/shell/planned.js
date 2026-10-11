/**
 * 规划中的功能页（占位登记）。
 *
 * 这些功能尚未实现，但左栏先保留入口，让整体导航从第一天起就是完整形态。
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
      id: 'photo',
      label: '拍题',
      icon: '📷',
      order: 50,
      desc: '拍题与题目识别属于主程序能力，本模块预留入口与数据挂载点。',
      bullets: [
        '建议由主程序做 OCR，识别后通过 /api/v1/commands/parse 生成日程草稿',
        '或直接 POST /api/v1/events 写入「做题计划」类日历事件',
        '本模块不处理图片，避免引入额外依赖',
      ],
    },
    {
      id: 'course',
      label: '网课',
      icon: '▶',
      order: 60,
      desc: '网课播放与进度记录属于主程序能力，本模块提供时间轴对齐。',
      bullets: [
        '课程表：以「日程」形式写入，分类选 class',
        '直播/回放时间可复用提醒能力（reminders.offsetMinutes）',
        '学习时长统计见 /api/v1/schedules/stats',
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
