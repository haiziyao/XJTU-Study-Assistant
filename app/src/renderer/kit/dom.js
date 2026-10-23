/**
 * DOM 小工具与通用视图片段。
 *
 * 这些是各视图共用的积木（建节点、表单字段、图标按钮、错误/空态、占位页），
 * 全部是全局函数，视图文件直接调用即可。
 */

function mk(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function option(value, label, selected) {
  const node = mk('option', null, label);
  node.value = value;
  if (selected) node.selected = true;
  return node;
}

function field(labelText, control, hint) {
  const wrap = mk('div', 'field');
  wrap.appendChild(mk('span', 'field-label', labelText));
  wrap.appendChild(control);
  if (hint) wrap.appendChild(mk('span', 'field-hint', hint));
  return wrap;
}

function iconBtn(label, glyph, onClick, extraClass = '') {
  const node = mk('button', `icon-btn ${extraClass}`.trim(), glyph);
  node.type = 'button';
  node.title = label;
  node.setAttribute('aria-label', label);
  node.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick(event);
  });
  return node;
}

/**
 * 窄屏工具栏的**图标行**：一排图标，点哪个就展开哪一组设置。
 *
 * 用法（待办 / 笔记这类"分组很多"的工具条）：
 *   bar.append(toolbarTools(bar, [['filter','filter','筛选'], …]), seg, showDone, row2)
 * 分组本身留在原地，CSS 按 `bar.dataset.open` 决定显示哪一组（见 shell.css 第 7 节）。
 *
 * 为什么不把分组"搬进弹层"：`.toolbar` 在桌面端要把这些分组平铺成两行，
 * 包一层就得用 `display: contents` 绕回去，等于平白多一层结构、多一处会和桌面打架的地方。
 * 只加一行图标、其余 DOM 一个字节不动，是唯一"窄屏变脸、桌面零风险"的做法。
 *
 * 交互：点同一个图标 = 收起，点另一个 = 换一组。不再单独放关闭键 ——
 * 手机上一排图标里再塞一个"×"反而更挤。
 *
 * @param {HTMLElement} bar   工具条根节点（`data-open` 写在它身上）
 * @param {Array<[string, string, string]>} items  `[面板名, 图标名, 无障碍标签]`
 */
function toolbarTools(bar, items) {
  const tools = mk('div', 'toolbar-tools');
  for (const [panel, icon, label] of items) {
    const button = mk('button', 'toolbar-tool');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.dataset.panel = panel;
    button.innerHTML = window.PCIcons.svg(icon, 18);
    button.addEventListener('click', () => {
      const next = bar.dataset.open === panel ? '' : panel;
      if (next) bar.dataset.open = next;
      else delete bar.dataset.open;
      for (const other of tools.children) {
        other.classList.toggle('active', other.dataset.panel === next);
      }
    });
    tools.appendChild(button);
  }
  return tools;
}

function errorBox(error) {
  const box = mk('div', 'error-box');
  box.appendChild(mk('div', 'eb-title', '加载失败'));
  box.appendChild(mk('div', 'eb-msg', error?.message ?? '未知错误'));
  const hint = error?.payload?.error?.details?.hint;
  if (hint) box.appendChild(mk('div', 'eb-hint', hint));
  return box;
}

function emptyBox(text) {
  return mk('div', 'empty-box', text);
}

function statPill(label, value) {
  const node = mk('div', 'stat-pill');
  node.appendChild(mk('span', 'sp-value', value));
  node.appendChild(mk('span', 'sp-label', label));
  return node;
}

/* ---------------------------------------------------------------- 占位视图 */

function placeholderView(title, desc, bullets) {
  return {
    title,
    render(ctx) {
      ctx.mount.innerHTML = '';
      const box = mk('div', 'placeholder');
      box.append(mk('div', 'ph-icon', '🚧'), mk('h3', null, `${title} · 预留`), mk('p', 'ph-desc', desc));
      const list = mk('ul', 'ph-list');
      for (const text of bullets) list.appendChild(mk('li', null, text));
      box.appendChild(list);
      ctx.mount.appendChild(box);
    },
  };
}
