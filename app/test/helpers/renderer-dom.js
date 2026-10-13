/**
 * 渲染层结构测试用的极简 DOM 桩（测试专用）。
 *
 * 为什么需要它：前端是「无构建步骤的 classic script」，`views/*.js` 里大量 `mk(...)`
 * 拼装节点。只断言源码字符串太弱（改名/挪位置就失效），而真浏览器又跑不进 node:test。
 * 这个桩支持创建/追加/查询（`.a.b` 复合类选择器）、classList、dataset、CSSOM
 * `setProperty`，所以能真实地跑一遍 render() 再对**节点结构**做断言。
 *
 * 它刻意不模拟布局/事件冒泡（需要时在测试里直接调监听器或读结构）。
 */

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = path.resolve(HERE, '../../src/renderer');

export function makeStyle() {
  const store = {};
  return {
    _store: store,
    setProperty(name, value) {
      store[name] = value;
    },
    getPropertyValue(name) {
      return store[name] ?? '';
    },
    removeProperty(name) {
      delete store[name];
    },
  };
}

/**
 * 选择器匹配：支持类选择器（含 `.a.b` 复合）与标签选择器（`button`、`div.x`）。
 * 渲染层只用这两类，够用且比正则稳。
 */
export function matches(node, selector) {
  const value = String(selector ?? '').trim();
  if (!value) return false;
  const parts = value.split('.').filter(Boolean);
  const own = String(node.className ?? '').split(' ').filter(Boolean);
  // 不以 '.' 开头 -> 第一段是标签名
  if (!value.startsWith('.')) {
    const tag = parts.shift();
    if (tag && String(node.tagName) !== tag.toUpperCase()) return false;
  }
  return parts.every((part) => own.includes(part));
}

export class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.style = makeStyle();
    this.dataset = {};
    this.listeners = {};
    this.attributes = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.type = '';
    this.title = '';
    this.placeholder = '';
    this.maxLength = 0;
    this.href = '';
    this._text = '';
    this._innerHTML = '';
    this._scrollTop = 0;
  }

  set innerHTML(value) {
    this._innerHTML = value;
    if (value === '') this.children = [];
  }
  get innerHTML() {
    return this._innerHTML;
  }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  get textContent() {
    // 与真实 DOM 一致：自身文本 + 全部子节点的文本（顺序拼接）
    return (this._text || '') + this.children.map((child) => child.textContent).join('');
  }
  set scrollTop(value) {
    this._scrollTop = value;
  }
  get scrollTop() {
    return this._scrollTop;
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  get classList() {
    const self = this;
    return {
      add(...names) {
        self.className = [...self.className.split(' ').filter(Boolean), ...names].join(' ');
      },
      remove(...names) {
        self.className = self.className.split(' ').filter((c) => c && !names.includes(c)).join(' ');
      },
      toggle(name, on) {
        if (on === undefined ? !self.className.split(' ').includes(name) : on) this.add(name);
        else this.remove(name);
      },
      contains(name) {
        return self.className.split(' ').includes(name);
      },
    };
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  appendChild(node) {
    this.children.push(node);
    node.parentNode = this;
    return node;
  }
  replaceChildren(...nodes) {
    this.children = [];
    for (const node of nodes) this.appendChild(node);
  }
  remove() {
    const parent = this.parentNode;
    if (parent) parent.children = parent.children.filter((child) => child !== this);
  }
  replaceWith(node) {
    const parent = this.parentNode;
    if (parent) parent.children = parent.children.map((child) => (child === this ? node : child));
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((item) => item !== fn);
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
    if (name === 'class') this.className = value;
    this[name] = value;
  }
  getAttribute(name) {
    return this.attributes[name];
  }
  focus() {}
  select() {}
  closest(selector) {
    let node = this;
    while (node) {
      if (matches(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (matches(child, selector)) return child;
      const deep = child.querySelector(selector);
      if (deep) return deep;
    }
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      if (matches(node, selector)) out.push(node);
      node.children.forEach(walk);
    };
    this.children.forEach(walk);
    return out;
  }
  getBoundingClientRect() {
    const sticky = (top, height) => ({ top, bottom: top + height, height, left: 0, width: 500, right: 500 });
    const classes = this.className.split(' ');
    if (classes.includes('day-hero')) return sticky(112, 58);
    if (classes.includes('day-allday')) return sticky(170, 26);
    if (classes.includes('day-timeline')) return sticky(204, 1344);
    return sticky(0, 0);
  }
  get offsetHeight() {
    return Math.round(this.getBoundingClientRect().height);
  }
}

/** 按 index.html 的顺序读出全部渲染层脚本（与浏览器一致：共享全局词法作用域）。 */
export function rendererScripts() {
  const html = fs.readFileSync(path.join(RENDERER_DIR, 'index.html'), 'utf8');
  return [...html.matchAll(/<script src="([^"]+)"/g)].map((match) => ({
    asset: match[1],
    text: fs.readFileSync(path.join(RENDERER_DIR, match[1]), 'utf8'),
  }));
}

/**
 * 在 DOM 桩里求值全部渲染层脚本，返回可直接驱动视图的上下文。
 * @param {object} options
 * @param {(url: string, options?: object) => Promise<object>} options.api 伪后端
 * @param {object} [options.state] 初始 PC.state
 */
export function bootRenderer({ api, state = {} } = {}) {
  const calls = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    Promise,
    Error,
    TypeError,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    Map,
    Set,
    Intl,
    isNaN,
    parseInt,
    parseFloat,
    URL,
    URLSearchParams,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    location: { protocol: 'http:', host: '127.0.0.1:3210', hostname: '127.0.0.1', pathname: '/app/', search: '', origin: 'http://127.0.0.1:3210' },
    document: {
      // These tests drive module views explicitly; shell boot is covered by renderer.test.js.
      readyState: 'loading',
      body: new El('body'),
      createElement: (tag) => new El(tag),
      createElementNS: (namespaceURI, tag) => { const node = new El(tag); node.namespaceURI = namespaceURI; return node; },
      getElementById: () => new El('div'),
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(
    rendererScripts()
      .map(({ asset, text }) => `/* ==== ${asset} ==== */\n${text}`)
      .join('\n;\n'),
    context,
    { filename: 'renderer-bundle.js' },
  );

  const record = async (url, options = {}) => {
    calls.push(`${options.method ?? 'GET'} ${url}`);
    return api(url, options);
  };
  context.window.PC = {
    state,
    api: record,
    refresh() {},
    toast() {},
    openEditor() {},
  };

  /** 渲染某个视图，返回挂载点（已 await 一轮微任务，便于断言异步渲染结果）。 */
  const render = async (id, { mode, anchor, wait = 15 } = {}) => {
    if (mode && state.calendar) state.calendar.mode = mode;
    if (anchor && state.calendar) state.calendar.anchor = anchor;
    const mount = new El('div');
    context.PCModules.get(id).render({ mount, api: record, state, toast() {}, refresh() {} });
    await new Promise((resolve) => setTimeout(resolve, wait));
    return mount;
  };

  return { context, window: context.window, PC: context.window.PC, PCModules: context.window.PCModules, PCUtil: context.window.PCUtil, calls, render, El };
}
