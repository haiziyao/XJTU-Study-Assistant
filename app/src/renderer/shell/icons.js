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
    gear: '<circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.06A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.06A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.09A1.7 1.7 0 0 0 10.12 3V3a2 2 0 1 1 4 0v.06A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.06A1.7 1.7 0 0 0 19.4 15z"/>',
    trash:
      '<path d="M4 7h16"/><path d="M9.5 7V4.8h5V7"/><path d="M6.4 7l.9 12.2A1.6 1.6 0 0 0 8.9 20.7h6.2a1.6 1.6 0 0 0 1.6-1.5L17.6 7"/><path d="M10.3 11v6M13.7 11v6"/>',
    chevronRight: '<path d="M9.5 5.5l7 6.5-7 6.5"/>',
    grid: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9.5h18M9 9.5v10M15 9.5v10"/>',
    // 日视图时间轴上的小图标（与左栏同一套线条风格）
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.6V12l3.1 1.8"/>',
    pin: '<path d="M12 21s6.2-5.4 6.2-10.2A6.2 6.2 0 0 0 5.8 10.8C5.8 15.6 12 21 12 21z"/><circle cx="12" cy="10.6" r="2.3"/>',
    repeat: '<path d="M4.5 9.5A4.5 4.5 0 0 1 9 5h8"/><path d="M14.6 2.8L17.4 5l-2.8 2.2"/><path d="M19.5 14.5A4.5 4.5 0 0 1 15 19H7"/><path d="M9.4 21.2L6.6 19l2.8-2.2"/>',
  };

  /** 已知 emoji / 字符 -> 图标名（视图登记的 icon 字段目前是这些）。 */
  const ALIAS = {
    '🗓': 'calendar',
    '☑': 'checkSquare',
    '🎓': 'cap',
    '📈': 'chart',
    '📝': 'note',
    '📷': 'camera',
    '▶': 'play',
    '✉': 'mail',
    '⚙': 'gear',
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
