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
