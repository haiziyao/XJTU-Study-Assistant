/**
 * 手机端组件库（window.PCMobileUI）。
 *
 * 所有手机页面只用这里的组件拼装；外观全部在 mobile/mobile.css，用法与规范见
 * app/docs/手机端设计规范.md。新增组件先写进这里和规范文档，再在页面里用。
 *
 * 约定：
 *   - 组件返回 DOM 节点，或带 close() 的控制对象；不返回 HTML 字符串。
 *   - CSP 禁内联样式：外观只靠类名，状态用 class / data-* / aria-*；
 *     需要连续数值（拖拽位移）时只写 CSS 变量（CSSOM 赋值不受 CSP 限制）。
 *   - 文本一律 textContent；只有本文件内置的图标常量走 innerHTML。
 *   - 浮层（sheet / actionSheet / alert）通过 setLayerHost() 接入外壳的返回栈，
 *     安卓返回键、浏览器后退都能关掉它们。
 */
window.PCMobileUI = (function () {
  'use strict';

  /* ------------------------------------------------------------ 图标 */

  /** 24 视窗、1.8 线宽的线性图标。模块图标仍用 shell/icons.js（PCIcons），这里只放手机外壳自己的。 */
  const ICONS = {
    back: '<path d="M15 4.5L7.5 12l7.5 7.5"/>',
    chevron: '<path d="M9.5 5.5L16 12l-6.5 6.5"/>',
    chevronLeft: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
    chevronDown: '<path d="M5.5 9.5L12 16l6.5-6.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
    more: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',
    today: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.8v2.1M12 19.1v2.1M4.6 4.6l1.5 1.5M17.9 17.9l1.5 1.5M2.8 12h2.1M19.1 12h2.1M4.6 19.4l1.5-1.5M17.9 6.1l1.5-1.5"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3.2"/><path d="M3.5 9.8h17M8 3v4M16 3v4"/><path d="M7.5 13.5h2M11 13.5h2M14.5 13.5h2M7.5 17h2M11 17h2"/>',
    sparkle: '<path d="M11 3.5l1.8 4.9 4.9 1.8-4.9 1.8L11 16.9l-1.8-4.9-4.9-1.8 4.9-1.8z"/><path d="M18 14.5l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z"/>',
    note: '<path d="M6.8 3.5h7.4l4.8 4.8v11.4a1.8 1.8 0 0 1-1.8 1.8H6.8A1.8 1.8 0 0 1 5 19.7V5.3a1.8 1.8 0 0 1 1.8-1.8z"/><path d="M14 3.5v5h5M8.5 12.5h7M8.5 16h5"/>',
    person: '<circle cx="12" cy="8.3" r="3.8"/><path d="M4.6 20.5c1.2-3.6 4-5.6 7.4-5.6s6.2 2 7.4 5.6"/>',
    send: '<path d="M12 19V5.5M6 11.5l6-6 6 6"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
    history: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4.5v3.8h3.8"/><path d="M12 8v4.3l2.8 1.7"/>',
    compose: '<path d="M12.5 4.5H6.3a1.8 1.8 0 0 0-1.8 1.8v11.4a1.8 1.8 0 0 0 1.8 1.8h11.4a1.8 1.8 0 0 0 1.8-1.8v-6.2"/><path d="M17.6 3.6a1.9 1.9 0 0 1 2.8 2.8L12.3 14.5l-3.6.8.8-3.6z"/>',
    edit: '<path d="M4.5 19.5h3.8L19 8.8a2.7 2.7 0 0 0-3.8-3.8L4.5 15.7z"/><path d="M13.8 6.4l3.8 3.8"/>',
    star: '<path d="M12 3.8l2.5 5.2 5.6.8-4 3.9 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4-3.9 5.6-.8z"/>',
    trash: '<path d="M4.5 7h15M9.5 7V4.8h5V7"/><path d="M6.5 7l.9 12.3a1.6 1.6 0 0 0 1.6 1.4h6a1.6 1.6 0 0 0 1.6-1.4L17.5 7"/>',
    circle: '<circle cx="12" cy="12" r="8.5"/>',
    checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12.3l2.7 2.7L16 9.6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
    moon: '<path d="M19.5 14.6A7.8 7.8 0 0 1 9.4 4.5a7.8 7.8 0 1 0 10.1 10.1z"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.1"/>',
    sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>',
    pin: '<path d="M12 21s6.2-5.4 6.2-10.2A6.2 6.2 0 0 0 5.8 10.8C5.8 15.6 12 21 12 21z"/><circle cx="12" cy="10.6" r="2.3"/>',
    flag: '<path d="M5.5 21V4.5M5.5 4.5h11l-2 4 2 4h-11"/>',
    list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.8" cy="6.5" r="1"/><circle cx="4.8" cy="12" r="1"/><circle cx="4.8" cy="17.5" r="1"/>',
    grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>',
    paperclip: '<path d="M19 11.5l-7.1 7.1a4.6 4.6 0 0 1-6.5-6.5l7.4-7.4a3 3 0 0 1 4.3 4.3l-7.3 7.3a1.5 1.5 0 0 1-2.1-2.1l6.6-6.6"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5s1.1-6.1 3.4-8.5z"/>',
    pulse: '<path d="M3 12h4l2.2-5 4.6 10 2.2-5h5"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
    external: '<path d="M14 4.5h5.5V10M19.5 4.5L11 13"/><path d="M18 14v4.2a1.8 1.8 0 0 1-1.8 1.8H5.8A1.8 1.8 0 0 1 4 18.2V7.8A1.8 1.8 0 0 1 5.8 6H10"/>',
  };

  function svg(name, size) {
    const body = ICONS[name];
    if (body) {
      return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
    }
    // 模块登记的图标（emoji / 名字）交给外壳图标表，认不出就返回空串
    return window.PCIcons?.svg?.(name, size) ?? '';
  }

  /** 图标节点。认不出的名字回退成文本（emoji 也能显示）。 */
  function icon(name, { size = 22, className = '' } = {}) {
    const node = document.createElement('span');
    node.className = cls('m-icon', className);
    node.setAttribute('aria-hidden', 'true');
    const markup = svg(name, size);
    if (markup) node.innerHTML = markup;
    else node.textContent = String(name ?? '');
    return node;
  }

  /* ------------------------------------------------------------ 基础 */

  function cls(...names) {
    return names.filter(Boolean).join(' ');
  }

  function append(parent, children) {
    for (const child of [children].flat(Infinity)) {
      if (child === null || child === undefined || child === false || child === '') continue;
      parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return parent;
  }

  /**
   * 建节点：`h('div', { class, text, on: { click }, dataset, hidden, ...attrs }, ...children)`。
   * 布尔属性（hidden / disabled / checked）直接写到 DOM 属性上，其余走 setAttribute。
   */
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'on') for (const [type, handler] of Object.entries(value)) node.addEventListener(type, handler);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (typeof value === 'boolean') node[key] = value;
      else node.setAttribute(key, String(value));
    }
    return append(node, children);
  }

  /* ------------------------------------------------------------ 按钮 */

  /**
   * 文字按钮。variant：filled（主操作）/ tinted（次要）/ plain（纯文字）/ destructive。
   * size：md（44px）/ lg（50px，页面底部的主按钮）/ sm（32px，行内）。
   */
  function button({ label, icon: iconName, variant = 'tinted', size = 'md', block = false, onClick, disabled, ariaLabel, className } = {}) {
    const node = h('button', {
      type: 'button',
      class: cls('m-btn', `m-btn--${variant}`, `m-btn--${size}`, block && 'm-btn--block', className),
      disabled: Boolean(disabled),
      'aria-label': ariaLabel,
    });
    if (iconName) node.append(icon(iconName, { size: size === 'sm' ? 16 : 19 }));
    if (label) node.append(h('span', { text: label }));
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }

  /** 只有图标的按钮（导航栏、工具条）。label 必填：它是读屏软件读出来的名字。 */
  function iconButton({ icon: iconName, label, onClick, className, size = 22, disabled } = {}) {
    const node = h('button', { type: 'button', class: cls('m-icon-btn', className), 'aria-label': label, title: label, disabled: Boolean(disabled) });
    node.append(icon(iconName, { size }));
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }

  /** 导航栏右侧的文字操作（"完成""今天"）。 */
  function navButton({ label, onClick, strong = false, disabled } = {}) {
    return h('button', { type: 'button', class: cls('m-nav-btn', strong && 'is-strong'), text: label, disabled: Boolean(disabled), on: onClick ? { click: onClick } : undefined });
  }

  /* ------------------------------------------------------------ 列表 */

  /** 圆角色块图标（设置列表左侧那种）。tone：blue / green / orange / red / purple / teal / indigo / pink / gray。 */
  function iconBadge(name, tone = 'blue') {
    const node = h('span', { class: cls('m-badge-icon', `m-tone-${tone}`), 'aria-hidden': 'true' });
    node.append(icon(name, { size: 18 }));
    return node;
  }

  /**
   * 分组列表。header 可以是字符串，或 `{ title, action: { label, onClick } }`。
   * inset：分隔线从哪里开始 —— 'text'（默认，16px）/ 'icon'（左侧有色块图标时）/ 'wide'（左侧有时间列等）。
   */
  function section({ header, footer, children = [], className, inset = 'text', plain = false } = {}) {
    const wrap = h('section', { class: cls('m-section', className) });
    if (header) {
      const title = typeof header === 'string' ? header : header.title;
      const head = h('div', { class: 'm-section-header' }, h('h2', { text: title }));
      if (header.action) head.append(h('button', { type: 'button', class: 'm-section-action', text: header.action.label, on: { click: header.action.onClick } }));
      wrap.append(head);
    }
    const list = h('div', { class: cls(plain ? 'm-plain' : 'm-list', `m-list--inset-${inset}`), role: 'list' });
    append(list, children);
    wrap.append(list);
    if (footer) wrap.append(h('p', { class: 'm-section-footer', text: footer }));
    wrap.list = list;
    return wrap;
  }

  /**
   * 列表单元。可点的单元是 <button>；带开关等交互附件时不要传 onClick（按钮里不能套控件）。
   *   icon / tone   左侧色块图标；leading 任意左侧节点（时间列、勾选圈）
   *   title / subtitle / meta   主标题、副标题（lines 控制最多几行）、第三行小字或节点
   *   value         右侧灰字；accessory 右侧节点；chevron 默认"可点且无附件时显示"
   *   destructive   红色居中（"删除""退出登录"）
   */
  function cell({ icon: iconName, tone, leading, title, subtitle, lines = 1, meta, value, accessory, chevron, onClick, destructive, className, ariaLabel } = {}) {
    const clickable = typeof onClick === 'function';
    const row = h(clickable ? 'button' : 'div', {
      type: clickable ? 'button' : undefined,
      role: clickable ? undefined : 'listitem',
      class: cls('m-cell', clickable && 'm-cell--action', destructive && 'm-cell--destructive', className),
      'aria-label': ariaLabel,
    });
    if (leading) row.append(h('span', { class: 'm-cell-leading' }, leading));
    else if (iconName) row.append(iconBadge(iconName, tone));
    const body = h('span', { class: 'm-cell-body' }, h('span', { class: 'm-cell-title', text: title }));
    if (subtitle) body.append(h('span', { class: cls('m-cell-subtitle', lines > 1 && `m-lines-${Math.min(3, lines)}`), text: subtitle }));
    if (meta) body.append(meta instanceof Node ? meta : h('span', { class: 'm-cell-meta', text: meta }));
    row.append(body);
    if (value !== undefined && value !== null && value !== '') row.append(h('span', { class: 'm-cell-value', text: value }));
    if (accessory) row.append(h('span', { class: 'm-cell-accessory' }, accessory));
    if (chevron ?? (clickable && !accessory && !destructive)) row.append(icon('chevron', { size: 16, className: 'm-cell-chevron' }));
    if (clickable) row.addEventListener('click', onClick);
    return row;
  }

  /** 小标签。tone 同 iconBadge，另有 neutral（默认）。 */
  function tag(text, tone = 'neutral') {
    return h('span', { class: cls('m-tag', `m-tag--${tone}`), text });
  }

  /* ------------------------------------------------------------ 控件 */

  /** 开关（原生 checkbox + role=switch，键盘与读屏都可用）。 */
  function toggle({ checked = false, onChange, label } = {}) {
    const input = h('input', { type: 'checkbox', role: 'switch', class: 'm-switch', 'aria-label': label });
    input.checked = Boolean(checked);
    input.addEventListener('change', () => onChange?.(input.checked));
    return input;
  }

  /** 分段控件。返回节点带 setValue(v)。 */
  function segmented({ items, value, onChange, label, className, size = 'md' } = {}) {
    const wrap = h('div', { class: cls('m-segmented', `m-segmented--${size}`, className), role: 'radiogroup', 'aria-label': label });
    const buttons = items.map((item) => {
      const node = h('button', { type: 'button', role: 'radio', class: 'm-segment', dataset: { value: item.value }, text: item.label });
      node.addEventListener('click', () => {
        if (value === item.value) return;
        value = item.value;
        paint();
        onChange?.(value);
      });
      return node;
    });
    const paint = () => {
      for (const node of buttons) {
        const on = node.dataset.value === String(value);
        node.classList.toggle('is-active', on);
        node.setAttribute('aria-checked', String(on));
      }
    };
    wrap.append(...buttons);
    paint();
    wrap.setValue = (next) => {
      value = next;
      paint();
    };
    return wrap;
  }

  /** 单选胶囊（快捷日期这类"几个常用值 + 自定义"）。 */
  function choiceChips({ items, value, onChange, label } = {}) {
    const wrap = h('div', { class: 'm-chips', role: 'radiogroup', 'aria-label': label });
    const paint = () => {
      for (const node of wrap.children) {
        const on = node.dataset.value === String(value);
        node.classList.toggle('is-active', on);
        node.setAttribute('aria-checked', String(on));
      }
    };
    for (const item of items) {
      wrap.append(
        h('button', {
          type: 'button',
          role: 'radio',
          class: 'm-chip',
          dataset: { value: item.value },
          text: item.label,
          on: {
            click: () => {
              value = item.value;
              paint();
              onChange?.(value);
            },
          },
        }),
      );
    }
    paint();
    wrap.setValue = (next) => {
      value = next;
      paint();
    };
    return wrap;
  }

  /** 搜索框。onInput 带 220ms 防抖，参数是去掉首尾空白的值。 */
  function searchField({ placeholder = '搜索', value = '', onInput } = {}) {
    const wrap = h('label', { class: 'm-search' });
    const input = h('input', { type: 'search', placeholder, 'aria-label': placeholder, enterkeyhint: 'search', autocomplete: 'off' });
    input.value = value;
    const clear = iconButton({ icon: 'close', label: '清除搜索', size: 14, className: 'm-search-clear' });
    clear.hidden = !value;
    let timer = null;
    const emit = () => onInput?.(input.value.trim());
    input.addEventListener('input', () => {
      clear.hidden = !input.value;
      clearTimeout(timer);
      timer = setTimeout(emit, 220);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') input.blur();
    });
    clear.addEventListener('click', (event) => {
      event.preventDefault();
      input.value = '';
      clear.hidden = true;
      emit();
      input.focus();
    });
    wrap.append(icon('search', { size: 17, className: 'm-search-icon' }), input, clear);
    wrap.input = input;
    return wrap;
  }

  /**
   * 表单行（放在 section 里）。type 支持 text / date / time / textarea。
   * 返回行节点，`.input` 是里面的输入控件。
   */
  function field({ label, value = '', placeholder = '', type = 'text', maxlength, autofocus = false, enterkeyhint } = {}) {
    const control =
      type === 'textarea'
        ? h('textarea', { rows: 3, placeholder, maxlength, 'aria-label': label || placeholder })
        : h('input', { type, placeholder, maxlength, enterkeyhint, 'aria-label': label || placeholder, autocomplete: 'off' });
    control.value = value ?? '';
    if (autofocus) control.dataset.autofocus = 'true';
    const row = h('label', { class: cls('m-field', type === 'textarea' && 'm-field--multiline', !label && 'm-field--bare') });
    if (label) row.append(h('span', { class: 'm-field-label', text: label }));
    row.append(control);
    row.input = control;
    return row;
  }

  /* ------------------------------------------------------------ 状态 */

  function emptyState({ icon: iconName = 'info', title, message, action } = {}) {
    const wrap = h('div', { class: 'm-empty' });
    wrap.append(h('span', { class: 'm-empty-icon' }, icon(iconName, { size: 30 })));
    if (title) wrap.append(h('p', { class: 'm-empty-title', text: title }));
    if (message) wrap.append(h('p', { class: 'm-empty-message', text: message }));
    if (action) wrap.append(button({ variant: 'tinted', size: 'md', ...action }));
    return wrap;
  }

  function errorState({ message, onRetry } = {}) {
    return emptyState({
      icon: 'info',
      title: '没能加载',
      message,
      action: onRetry ? { label: '重试', onClick: onRetry } : null,
    });
  }

  /** 加载骨架：rows 行灰条，形状接近真实列表，避免内容出现时整页跳动。 */
  function skeleton(rows = 4) {
    const list = h('div', { class: 'm-list m-skeleton', 'aria-busy': 'true', 'aria-label': '正在加载' });
    for (let i = 0; i < rows; i++) {
      list.append(h('div', { class: 'm-skeleton-row' }, h('span', { class: 'm-skeleton-bar' }), h('span', { class: 'm-skeleton-bar is-short' })));
    }
    return h('section', { class: 'm-section' }, list);
  }

  function spinner() {
    return h('span', { class: 'm-spinner', role: 'progressbar', 'aria-label': '正在加载' });
  }

  /* ------------------------------------------------------------ 浮层 */

  /**
   * 浮层宿主：外壳在 start() 时注入 `{ push(entry), close(entry) → Promise }`，
   * 让浮层进入返回栈。没有宿主（单测、外壳没起来）时浮层直接开关。
   */
  let layerHost = null;
  function setLayerHost(host) {
    layerHost = host;
  }
  function overlayRoot() {
    return document.getElementById('m-overlays') ?? document.body;
  }

  /**
   * 浮层的公共生命周期：挂载 → 下一帧加 is-open（触发过渡）→ 关闭时去掉 is-open，过渡结束后移除。
   * close() 返回 Promise：浮层真正关掉（返回栈也已出栈）之后才 resolve ——
   * 在浮层的按钮里继续打开下一个页面 / 浮层，必须先 await 它，否则两次历史操作会互相踩。
   */
  function mountLayer(nodes, { onClose, focus } = {}) {
    const root = overlayRoot();
    const previous = document.activeElement;
    let closed = false;
    for (const node of nodes) root.append(node);
    requestAnimationFrame(() => {
      for (const node of nodes) node.classList.add('is-open');
      focus?.focus?.({ preventScroll: true });
    });
    const destroy = () => {
      if (closed) return;
      closed = true;
      for (const node of nodes) node.classList.remove('is-open');
      setTimeout(() => {
        for (const node of nodes) node.remove();
      }, 320);
      onClose?.();
      if (previous?.isConnected) previous.focus?.({ preventScroll: true });
    };
    const entry = { close: destroy };
    layerHost?.push(entry);
    return {
      get closed() {
        return closed;
      },
      close() {
        if (closed) return Promise.resolve();
        return layerHost ? layerHost.close(entry) : Promise.resolve(destroy());
      },
    };
  }

  /**
   * 底部弹层（表单、筛选、详情）。
   *   title     顶部标题；cancelLabel 左侧取消；primary `{ label, onClick, disabled }` 右侧主操作
   *   content   节点或节点数组；large 时撑到接近全屏（长表单）
   * 下拉顶部区域可以关闭。返回 `{ body, close(), setPrimaryDisabled(bool) }`。
   */
  function sheet({ title = '', content, cancelLabel = '取消', primary, large = false, onClose } = {}) {
    const mask = h('div', { class: 'm-sheet-mask' });
    const panel = h('div', { class: cls('m-sheet', large && 'm-sheet--large'), role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '弹层' });
    const grab = h('div', { class: 'm-sheet-grabber', 'aria-hidden': 'true' });
    const cancel = navButton({ label: cancelLabel });
    const primaryButton = primary ? navButton({ label: primary.label, strong: true, disabled: primary.disabled }) : h('span', { class: 'm-nav-btn-placeholder' });
    const head = h('header', { class: 'm-sheet-head' }, cancel, h('h2', { class: 'm-sheet-title', text: title }), primaryButton);
    const body = h('div', { class: 'm-sheet-body' });
    append(body, content);
    panel.append(grab, head, body);

    const layer = mountLayer([mask, panel], {
      onClose,
      focus: body.querySelector('[data-autofocus="true"]') ?? cancel,
    });
    const control = {
      body,
      close: () => layer.close(),
      setPrimaryDisabled(disabled) {
        if (primary) primaryButton.disabled = Boolean(disabled);
      },
    };
    mask.addEventListener('click', control.close);
    cancel.addEventListener('click', control.close);
    if (primary) primaryButton.addEventListener('click', () => primary.onClick?.(control));
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') control.close();
    });

    // 下拉关闭：只在抓手和标题栏上响应，内容区留给滚动
    let startY = null;
    let delta = 0;
    const onDown = (event) => {
      if (event.target.closest('button')) return;
      startY = event.clientY;
      delta = 0;
      panel.classList.add('is-dragging');
      head.setPointerCapture?.(event.pointerId);
    };
    const onMove = (event) => {
      if (startY === null) return;
      delta = Math.max(0, event.clientY - startY);
      panel.style.setProperty('--m-drag', `${delta}px`);
    };
    const onUp = () => {
      if (startY === null) return;
      startY = null;
      panel.classList.remove('is-dragging');
      panel.style.setProperty('--m-drag', '0px');
      if (delta > 90) control.close();
    };
    for (const node of [grab, head]) {
      node.addEventListener('pointerdown', onDown);
      node.addEventListener('pointermove', onMove);
      node.addEventListener('pointerup', onUp);
      node.addEventListener('pointercancel', onUp);
    }
    return control;
  }

  /**
   * 操作菜单（底部弹出的一组选项 + 单独的取消）。
   * actions：`[{ label, icon, destructive, disabled }]`。
   * 返回 Promise：选中项的下标；取消或关闭为 -1。浮层已完全关闭后才 resolve。
   */
  function actionSheet({ title, message, actions = [], cancelLabel = '取消' } = {}) {
    return new Promise((resolve) => {
      let choice = -1;
      const mask = h('div', { class: 'm-sheet-mask' });
      const panel = h('div', { class: 'm-action-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '操作' });
      const group = h('div', { class: 'm-action-group' });
      if (title || message) {
        const head = h('div', { class: 'm-action-head' });
        if (title) head.append(h('p', { class: 'm-action-title', text: title }));
        if (message) head.append(h('p', { class: 'm-action-message', text: message }));
        group.append(head);
      }
      const buttons = actions.map((action, index) => {
        const node = h('button', { type: 'button', class: cls('m-action', action.destructive && 'is-destructive'), disabled: Boolean(action.disabled) });
        if (action.icon) node.append(icon(action.icon, { size: 20 }));
        node.append(h('span', { text: action.label }));
        node.addEventListener('click', () => {
          choice = index;
          layer.close();
        });
        return node;
      });
      group.append(...buttons);
      const cancel = h('button', { type: 'button', class: 'm-action m-action--cancel', text: cancelLabel });
      panel.append(group, cancel);
      const layer = mountLayer([mask, panel], { onClose: () => resolve(choice), focus: buttons[0] ?? cancel });
      cancel.addEventListener('click', () => layer.close());
      mask.addEventListener('click', () => layer.close());
      panel.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') layer.close();
      });
    });
  }

  /**
   * 居中确认框。返回 Promise<boolean>。
   * 只用于"不可撤销 / 会丢数据"的确认；普通选择用 actionSheet。
   */
  function confirm({ title, message, confirmLabel = '确定', cancelLabel = '取消', destructive = false } = {}) {
    return new Promise((resolve) => {
      let result = false;
      const mask = h('div', { class: 'm-alert-mask' });
      const box = h('div', { class: 'm-alert', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title });
      const ok = h('button', { type: 'button', class: cls('m-alert-btn', 'is-strong', destructive && 'is-destructive'), text: confirmLabel });
      const no = h('button', { type: 'button', class: 'm-alert-btn', text: cancelLabel });
      box.append(
        h('div', { class: 'm-alert-content' }, h('h2', { class: 'm-alert-title', text: title }), message ? h('p', { class: 'm-alert-message', text: message }) : null),
        h('div', { class: 'm-alert-actions' }, no, ok),
      );
      const layer = mountLayer([mask, box], { onClose: () => resolve(result), focus: no });
      ok.addEventListener('click', () => {
        result = true;
        layer.close();
      });
      no.addEventListener('click', () => layer.close());
      box.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') layer.close();
      });
    });
  }

  /* ------------------------------------------------------------ 手势 */

  let openSwipe = null;

  /**
   * 左滑操作（完成、删除）。actions：`[{ label, icon, tone, onSelect }]`，从右往左排。
   * 纵向滚动交给浏览器（touch-action: pan-y），只在确认是横向拖动后才接管。
   * 左滑操作只是捷径：同样的功能必须在详情页或菜单里也能做到（读屏和键盘用户用不了手势）。
   */
  function swipeable(row, actions = []) {
    const wrap = h('div', { class: 'm-swipe' });
    const tray = h('div', { class: 'm-swipe-actions', 'aria-hidden': 'true' });
    const front = h('div', { class: 'm-swipe-front' }, row);
    const width = () => actions.length * 78;
    const set = (x) => front.style.setProperty('--m-swipe-x', `${x}px`);
    const control = {
      close() {
        wrap.classList.remove('is-open');
        set(0);
        if (openSwipe === control) openSwipe = null;
      },
      open() {
        wrap.classList.add('is-open');
        set(-width());
        openSwipe = control;
      },
    };
    for (const action of actions) {
      const node = h('button', { type: 'button', tabindex: '-1', class: cls('m-swipe-action', `m-tone-${action.tone ?? 'gray'}`) });
      if (action.icon) node.append(icon(action.icon, { size: 20 }));
      node.append(h('span', { text: action.label }));
      node.addEventListener('click', (event) => {
        event.stopPropagation();
        control.close();
        action.onSelect?.();
      });
      tray.append(node);
    }
    wrap.append(tray, front);

    let pointer = null;
    let startX = 0;
    let startY = 0;
    let base = 0;
    let dx = 0;
    let axis = null;
    let suppressClick = false;
    const swallowNextClick = () => {
      suppressClick = true;
      setTimeout(() => {
        suppressClick = false;
      }, 0);
    };
    front.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (openSwipe && openSwipe !== control) openSwipe.close();
      pointer = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      base = wrap.classList.contains('is-open') ? -width() : 0;
      dx = 0;
      axis = null;
    });
    front.addEventListener('pointermove', (event) => {
      if (pointer !== event.pointerId) return;
      const mx = event.clientX - startX;
      const my = event.clientY - startY;
      if (!axis) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
        if (axis === 'x') {
          front.setPointerCapture?.(event.pointerId);
          wrap.classList.add('is-dragging');
        }
      }
      if (axis !== 'x') return;
      dx = mx;
      set(Math.min(0, Math.max(-width() - 36, base + mx)));
    });
    const finish = (event, cancelled) => {
      if (pointer !== event.pointerId) return;
      pointer = null;
      wrap.classList.remove('is-dragging');
      if (axis === 'x') {
        swallowNextClick();
        if (!cancelled && base + dx < -width() / 2) control.open();
        else control.close();
      } else if (!axis && base !== 0) {
        // 已展开时点一下行本身 = 收起，而不是打开详情
        swallowNextClick();
        control.close();
      }
      axis = null;
    };
    front.addEventListener('pointerup', (event) => finish(event, false));
    front.addEventListener('pointercancel', (event) => finish(event, true));
    front.addEventListener(
      'click',
      (event) => {
        if (!suppressClick) return;
        event.preventDefault();
        event.stopPropagation();
      },
      true,
    );
    return wrap;
  }

  /**
   * 下拉刷新：只在滚动到顶时响应。指示器浮在内容上方（不推内容），
   * 这样 iOS 自带的回弹和安卓的无回弹都不会和它打架。
   */
  function pullToRefresh(scroller, host, onRefresh) {
    const indicator = h('div', { class: 'm-ptr', 'aria-hidden': 'true' }, h('span', { class: 'm-ptr-ring' }));
    host.append(indicator);
    let startY = null;
    let pull = 0;
    let busy = false;
    const set = (px) => {
      indicator.style.setProperty('--m-pull', `${px}px`);
      indicator.classList.toggle('is-visible', px > 4);
      indicator.classList.toggle('is-armed', px >= 64);
    };
    scroller.addEventListener(
      'touchstart',
      (event) => {
        startY = !busy && scroller.scrollTop <= 0 && event.touches.length === 1 ? event.touches[0].clientY : null;
        pull = 0;
      },
      { passive: true },
    );
    scroller.addEventListener(
      'touchmove',
      (event) => {
        if (startY === null) return;
        const dy = event.touches[0].clientY - startY;
        pull = dy > 0 && scroller.scrollTop <= 0 ? Math.min(96, dy * 0.5) : 0;
        set(pull);
      },
      { passive: true },
    );
    scroller.addEventListener('touchend', async () => {
      if (startY === null) return;
      startY = null;
      if (pull < 64) return set(0);
      busy = true;
      set(56);
      indicator.classList.add('is-loading');
      try {
        await onRefresh();
      } finally {
        busy = false;
        indicator.classList.remove('is-loading');
        set(0);
      }
    });
  }

  /** 横向轻扫（切周 / 切月）。纵向滚动不受影响。 */
  function onSwipeX(node, { onLeft, onRight, threshold = 48 } = {}) {
    let start = null;
    node.addEventListener('pointerdown', (event) => {
      start = { x: event.clientX, y: event.clientY, id: event.pointerId };
    });
    node.addEventListener('pointerup', (event) => {
      if (!start || start.id !== event.pointerId) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      start = null;
      if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (dx < 0) onLeft?.();
      else onRight?.();
    });
    node.addEventListener('pointercancel', () => {
      start = null;
    });
  }

  return {
    ICONS,
    h,
    cls,
    append,
    icon,
    iconBadge,
    button,
    iconButton,
    navButton,
    section,
    cell,
    tag,
    toggle,
    segmented,
    choiceChips,
    searchField,
    field,
    emptyState,
    errorState,
    skeleton,
    spinner,
    setLayerHost,
    sheet,
    actionSheet,
    confirm,
    swipeable,
    pullToRefresh,
    onSwipeX,
  };
})();
