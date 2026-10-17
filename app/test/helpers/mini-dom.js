/**
 * 极简 DOM 桩（测试用）。
 *
 * 为什么单独抽出来：`renderer-chat.test.js` 里那份是**对话专用**的（挂在它的闭包里、
 * 只实现对话用到的那几个 API），而左栏的测试需要的是另一组：
 * `document.body` 的类、`document.querySelectorAll('.nav-item')`、`dataset`、`click()`。
 * 与其在第二个测试文件里再抄一份 200 行，不如把左栏这份放在这里共用
 * （scratch/ 里的一次性诊断脚本也直接 import 它）。
 *
 * 只实现左栏真正用到的 API。**没有真实布局**：`getBoundingClientRect` 缺席，
 * 所以拖动的几何判定不在这里测 —— 那部分由 `sidebar-layout.test.js` 的 `dropTarget` 覆盖。
 */

export function makeDom() {
  /** 所有建出来的元素，供 `document.getElementById` / `querySelectorAll` 用。 */
  const all = [];

  const isElement = (node) => Boolean(node && node.tagName);

  function descendants(node, out = []) {
    for (const child of node.childNodes) {
      if (!isElement(child)) continue;
      out.push(child);
      descendants(child, out);
    }
    return out;
  }

  /** 只支持 `.a` / `.a.b` / `[data-x]` 这几种选择器（左栏代码只用到这几种）。 */
  function matches(node, selector) {
    const text = String(selector).trim();
    if (text.startsWith('.')) {
      return text
        .slice(1)
        .split('.')
        .every((cls) => node.classList.contains(cls));
    }
    const attr = /^\[([\w-]+)\]$/.exec(text);
    if (attr) return node._attrs[attr[1]] !== undefined;
    return false;
  }

  function createElement(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      childNodes: [],
      parentNode: null,
      className: '',
      id: '',
      title: '',
      type: '',
      value: '',
      hidden: false,
      dataset: {},
      style: {},
      _attrs: {},
      _listeners: {},
      _innerText: undefined,
      _innerHTML: '',

      get children() {
        return node.childNodes.filter(isElement);
      },
      get textContent() {
        if (node._innerText !== undefined) return node._innerText;
        return node.childNodes.map((child) => child.textContent).join('');
      },
      set textContent(value) {
        node.childNodes = [];
        node._innerText = value === undefined || value === null ? '' : String(value);
      },
      get innerHTML() {
        return node._innerHTML;
      },
      set innerHTML(value) {
        node._innerHTML = String(value ?? '');
        node.childNodes = [];
        node._innerText = node._innerHTML.replace(/<[^>]*>/g, '');
      },

      get classList() {
        const list = () => node.className.split(/\s+/).filter(Boolean);
        return {
          contains: (cls) => list().includes(cls),
          add: (cls) => {
            if (!list().includes(cls)) node.className = [...list(), cls].join(' ');
          },
          remove: (cls) => {
            node.className = list().filter((item) => item !== cls).join(' ');
          },
          toggle: (cls, force) => {
            const next = force === undefined ? !list().includes(cls) : Boolean(force);
            if (next) node.classList.add(cls);
            else node.classList.remove(cls);
            return next;
          },
        };
      },

      appendChild(child) {
        if (!child) return child;
        child.parentNode?.removeChild?.(child);
        child.parentNode = node;
        node.childNodes.push(child);
        return child;
      },
      append(...nodes) {
        for (const child of nodes) node.appendChild(child);
      },
      replaceChildren(...nodes) {
        for (const child of node.childNodes) child.parentNode = null;
        node.childNodes = [];
        node.append(...nodes);
      },
      removeChild(child) {
        const index = node.childNodes.indexOf(child);
        if (index >= 0) node.childNodes.splice(index, 1);
        child.parentNode = null;
        return child;
      },
      remove() {
        node.parentNode?.removeChild?.(node);
      },
      contains(child) {
        return descendants(node).includes(child);
      },
      setAttribute(name, value) {
        node._attrs[name] = String(value);
        if (name === 'id') node.id = String(value);
        if (name === 'hidden') node.hidden = true;
        if (name === 'aria-label') node.ariaLabel = String(value);
      },
      getAttribute(name) {
        if (name === 'aria-label') return node.ariaLabel ?? null;
        return node._attrs[name] ?? null;
      },
      addEventListener(type, handler) {
        (node._listeners[type] ??= []).push(handler);
      },
      removeEventListener(type, handler) {
        node._listeners[type] = (node._listeners[type] ?? []).filter((item) => item !== handler);
      },
      /** 测试专用：直接触发某个事件（不做冒泡）。 */
      dispatch(type, event = {}) {
        for (const handler of [...(node._listeners[type] ?? [])]) {
          handler({ preventDefault() {}, stopPropagation() {}, target: node, ...event });
        }
      },
      click() {
        node.dispatch('click');
      },
      focus() {},
      querySelector(selector) {
        return descendants(node).find((child) => matches(child, selector)) ?? null;
      },
      querySelectorAll(selector) {
        return descendants(node).filter((child) => matches(child, selector));
      },
    };
    all.push(node);
    return node;
  }

  const body = createElement('body');
  const documentElement = createElement('html');
  documentElement.appendChild(body);

  /**
   * 查询**只走文档树**（与真实 DOM 一致）。
   *
   * 这一点必须对：外壳重排左栏是 `dom.nav.replaceChildren()` —— 旧按钮被摘下来但对象还在，
   * 如果按"所有建过的节点"去查，那些**已经不在页面上**的旧按钮仍会被算进 `.nav-item`，
   * 高亮断言就会看到两个 active（一个在树上、一个已经摘掉），测出来的东西和用户看到的不是一回事。
   */
  const inTree = () => descendants(documentElement);

  const document = {
    // 保持 'loading'：外壳的 boot() 不该在这些测试里跑起来（dom 由测试自己挂）
    readyState: 'loading',
    body,
    documentElement,
    createElement,
    getElementById: (id) => inTree().find((node) => node.id === id) ?? null,
    querySelector: (selector) => inTree().find((node) => matches(node, selector)) ?? null,
    querySelectorAll: (selector) => inTree().filter((node) => matches(node, selector)),
    addEventListener() {},
    removeEventListener() {},
  };

  return { document, createElement, body, all };
}
