/**
 * 外壳图标表（classic script，无构建步骤）。
 *
 * 左栏图标由各视图在 `PCModules.register({ icon })` 里给出。为了不改动别人的视图文件，
 * 这里在**外壳侧**做一次「名字 / emoji → 内联 SVG」的映射：
 *   - 命中已知名字或已知 emoji：渲染与老版一致的内联 SVG（24 视窗、currentColor 描边）；
 *   - 未命中：原样回退成文本（例如将来某个视图用别的字符当图标，行为不变）。
 *
 * 规格与老版 `PCUtil.icons` 保持一致：`fill="none"` / `stroke="currentColor"` /
 * `stroke-width="1.7"` / 圆头圆角 / `aria-hidden="true"`，颜色继承按钮文字色。
 */

window.PCIcons = (function () {
  'use strict';

  /** name -> <path> 等图元（24 视窗，见老版 views.js 的 PCUtil.icons）。 */
  const ICONS = {
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    checkSquare: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 12.2l2.6 2.6L16 9.4"/>',
    cap: '<path d="M2.5 9.2L12 5l9.5 4.2L12 13.4z"/><path d="M6.5 11.6v4.2c0 1.1 2.5 2.2 5.5 2.2s5.5-1.1 5.5-2.2v-4.2"/>',
    chart: '<path d="M3.5 20.5h17"/><path d="M4 16.5l4.8-5.2 3.6 3.2L20 6.5"/><path d="M20 11V6.5h-4.5"/>',
    note:
      '<rect x="5" y="3.5" width="14" height="17" rx="2"/><path d="M9 3.5v17"/><path d="M12.4 8.2h4M12.4 12h4"/>',
    camera:
      '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.6l1.2-2h7.4l1.2 2h1.6A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/><circle cx="12" cy="12.4" r="3.4"/>',
    play: '<circle cx="12" cy="12" r="9"/><path d="M10 8.6l5.4 3.4-5.4 3.4z"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 7.1l8.5 6 8.5-6"/>',
    // 喇叭（通知）：一支斜握的扩音器 + 两道声波。纯线条，不填色，与其余图标同一视觉重量
    megaphone:
      '<path d="M4 10.5v3a1.5 1.5 0 0 0 1.5 1.5H8l7 4V5.5l-7 4H5.5A1.5 1.5 0 0 0 4 10.5z"/><path d="M18 9.2a4 4 0 0 1 0 5.6"/><path d="M20.2 7a7.4 7.4 0 0 1 0 10"/>',
    gear: '<circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.06A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.06A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.09A1.7 1.7 0 0 0 10.12 3V3a2 2 0 1 1 4 0v.06A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.06A1.7 1.7 0 0 0 19.4 15z"/>',
    trash:
      '<path d="M4 7h16"/><path d="M9.5 7V4.8h5V7"/><path d="M6.4 7l.9 12.2A1.6 1.6 0 0 0 8.9 20.7h6.2a1.6 1.6 0 0 0 1.6-1.5L17.6 7"/><path d="M10.3 11v6M13.7 11v6"/>',
    chevronRight: '<path d="M9.5 5.5l7 6.5-7 6.5"/>',
    grid: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9.5h18M9 9.5v10M15 9.5v10"/>',
    // 日视图时间轴上的小图标（与左栏同一套线条风格）
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.6V12l3.1 1.8"/>',
    pin: '<path d="M12 21s6.2-5.4 6.2-10.2A6.2 6.2 0 0 0 5.8 10.8C5.8 15.6 12 21 12 21z"/><circle cx="12" cy="10.6" r="2.3"/>',
    repeat: '<path d="M4.5 9.5A4.5 4.5 0 0 1 9 5h8"/><path d="M14.6 2.8L17.4 5l-2.8 2.2"/><path d="M19.5 14.5A4.5 4.5 0 0 1 15 19H7"/><path d="M9.4 21.2L6.6 19l2.8-2.2"/>',
    // 画笔（对话输入框下面的「绘图」开关）：斜握的笔杆 + 收尖的笔头，纯线条不填色
    brush:
      '<path d="M20.1 3.9a2.05 2.05 0 0 1 0 2.9l-7.5 7.5-2.9-2.9 7.5-7.5a2.05 2.05 0 0 1 2.9 0z"/><path d="M9.5 11.6l2.9 2.9-1.7 1.7a3.5 3.5 0 0 1-2.5 1l-2.4.1.1-2.4c.05-.95.42-1.85 1.06-2.5z"/>',
    // 盾牌 + 对勾（「权限」）：审批 / 放行的意思
    shield:
      '<path d="M12 3.2l7 2.6v5.4c0 4.2-2.8 7.6-7 9.6-4.2-2-7-5.4-7-9.6V5.8z"/><path d="M9.2 12.1l2 2 3.6-3.9"/>',
    // 三根柱子（「用量」）
    bars: '<path d="M4.5 20.5h15"/><path d="M7 20.5V12M12 20.5V5.5M17 20.5v-6"/>',
    // 地球（「联网搜索」）：一圈经线 + 赤道
    globe:
      '<circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2"/><path d="M12 3.4c2.3 2.4 3.5 5.4 3.5 8.6S14.3 18.2 12 20.6c-2.3-2.4-3.5-5.4-3.5-8.6S9.7 5.8 12 3.4z"/>',
    // 说话气泡（「对话」页）：气泡 + 两条内容线，与「消息」的信封区分开
    chat:
      '<path d="M20.5 12.4c0 3.9-3.8 7-8.5 7-1 0-1.96-.15-2.86-.42L4.6 20.6l1.3-3.5A6.7 6.7 0 0 1 3.5 12.4c0-3.9 3.8-7 8.5-7s8.5 3.1 8.5 7z"/><path d="M8.4 11.4h7.2M8.4 14.3h4.4"/>',
    // 一进一出两支箭头（「传输」页）：局域网直传是双向的，两条箭头比"云"更能说明"不过服务器"
    transfer:
      '<path d="M3.6 8.6h14.2"/><path d="M15 5.6l3 3-3 3"/><path d="M20.4 15.4H6.2"/><path d="M9 12.4l-3 3 3 3"/>',
    // 三个点（左栏「更多」）：收起来的入口都从这里展开。用点而不是箭头/加号 ——
    // 它在各家 UI 里已经固定表示"还有一些同级入口"，不需要用户学。
    more: '<circle cx="5.6" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18.4" cy="12" r="1.5"/>',
    // 番茄钟（左栏入口）：表盘 + 顶部按钮，比"一个番茄"更像计时器，也更符合其它图标的线条风格
    timer:
      '<circle cx="12" cy="13.2" r="7.4"/><path d="M12 9.6v3.9l2.6 1.6"/><path d="M9.4 3.6h5.2"/><path d="M12 3.6v2.2"/><path d="M18.4 6.2l1.4 1.4"/>',
  };

  /** 已知 emoji / 字符 -> 图标名（视图登记的 icon 字段目前是这些）。 */
  const ALIAS = {
    '🗓': 'calendar',
    '☑': 'checkSquare',
    '🎓': 'cap',
    // 「通知」视图：喇叭。语义上比 mail 更贴切（通知是"广播给你"），
    // 也避免与消息/邮件类的入口撞同一个图标。
    '📣': 'megaphone',
    '📈': 'chart',
    '📝': 'note',
    '📷': 'camera',
    '▶': 'play',
    '✉': 'mail',
    '⚙': 'gear',
    '💬': 'chat',
    '📡': 'transfer',
    // 番茄钟：左栏用 🍅 这个 emoji 登记，外壳把它换成与其它导航一致的线条图标
    '🍅': 'timer',
    // 左栏「更多」：外壳自己登记，不属于任何视图
    '⋯': 'more',
    '…': 'more',
  };

  /** 解析图标名：已知名字直接返回，已知 emoji 映射后返回，其余 null。 */
  function nameOf(value) {
    const key = String(value ?? '').trim();
    if (!key) return null;
    if (Object.prototype.hasOwnProperty.call(ICONS, key)) return key;
    return ALIAS[key] ?? null;
  }

  /**
   * 生成内联 SVG 字符串；装饰性图标，统一 aria-hidden。
   * 返回 '' 表示没有对应图标，调用方应回退成文本。
   */
  function svg(value, size = 20) {
    const name = nameOf(value);
    if (!name) return '';
    const px = Number(size) > 0 ? Number(size) : 20;
    return (
      `<svg viewBox="0 0 24 24" width="${px}" height="${px}" fill="none" stroke="currentColor" ` +
      `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`
    );
  }

  return { ICONS, ALIAS, nameOf, svg };
})();
