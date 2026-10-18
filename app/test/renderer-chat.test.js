/**
 * 渲染层行为测试：**消息排队 / 对话中停止 / 过程清单（AI 的 todolist）**。
 *
 * 为什么单开一个文件而不是往 renderer.test.js 里塞：那一个管的是"能不能加载起来"
 * （路径、语法、注册表），这里管的是**行为**——同一份 `shell/app.js` 被喂进一个
 * 极简 DOM 与可控的 fetch，然后断言"按了发送之后界面上到底发生了什么"。
 * 排队顺序、停止按钮的出现/消失、清单从 pending 到收起，这三件事都只能这样做才测得出来。
 *
 * 极简 DOM 的边界（写清楚，免得后来者以为它能当 jsdom 用）：
 *   - 支持 createElement / appendChild / append / insertBefore / remove / replaceChildren、
 *     className+classList、textContent、innerHTML（只做去标签的近似）、渐进式 querySelector；
 *   - 不支持布局、CSS、事件冒泡。点击靠 `dispatch('click')` 直接调处理器。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';

/* ============================================================ 极简 DOM */

/** 造一个"能断言"的最小 DOM：元素带 children / parentNode / classList / textContent。 */
function makeMiniDom() {
  const byId = new Map();

  const isElement = (node) => Boolean(node && node.tagName);

  /** 只认单选择器（`.cls` / `#id` / `tag`）与它们的逗号组合 —— 测试够用，不做完整选择器引擎。 */
  function matches(node, selector) {
    return String(selector)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .some((part) => {
        if (part.startsWith('.')) return node.classList.contains(part.slice(1));
        if (part.startsWith('#')) return node.id === part.slice(1);
        return node.tagName === part.toUpperCase();
      });
  }

  function descendants(node, out = []) {
    for (const child of node.childNodes) {
      if (!isElement(child)) continue;
      out.push(child);
      descendants(child, out);
    }
    return out;
  }

  /**
   * 从原父节点上摘掉。**真实 DOM 的 appendChild / insertBefore 都是"移动"**：
   * 不先摘，`keepBodyLast`（把正文气泡挪到最后）会往同一个父节点里塞第二份引用
   * —— 测试里就表现为"凭空多出一个气泡、标记数也翻倍"（这个坑真踩过）。
   */
  function detach(child) {
    const parent = child.parentNode;
    if (!parent) return;
    const index = parent.childNodes.indexOf(child);
    if (index >= 0) parent.childNodes.splice(index, 1);
    child.parentNode = null;
  }

  function textNode(value, parent) {
    return { tagName: '', childNodes: [], parentNode: parent, textContent: String(value) };
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
      placeholder: '',
      src: '',
      alt: '',
      rows: 0,
      checked: false,
      hidden: false,
      disabled: false,
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      dataset: {},
      style: {},
      _listeners: {},
      _attrs: {},
      _innerHTML: '',
      _innerText: undefined,

      get children() {
        return node.childNodes.filter(isElement);
      },
      get firstChild() {
        return node.childNodes[0] ?? null;
      },
      get textContent() {
        if (node._innerText !== undefined) return node._innerText;
        return node.childNodes.map((child) => child.textContent).join('');
      },
      set textContent(value) {
        for (const child of node.childNodes) child.parentNode = null;
        node.childNodes = [];
        node._innerText = undefined;
        if (value === undefined || value === null || String(value) === '') return;
        node.childNodes.push(textNode(value, node));
      },
      get innerHTML() {
        return node._innerHTML;
      },
      set innerHTML(value) {
        node._innerHTML = String(value ?? '');
        node.childNodes = [];
        // 去标签的近似：断言的是"屏幕上有这几个字"，不是布局
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
        detach(child);
        child.parentNode = node;
        node.childNodes.push(child);
        if (child.id) byId.set(child.id, child);
        return child;
      },
      append(...nodes) {
        for (const child of nodes) node.appendChild(child);
      },
      insertBefore(child, reference) {
        if (!reference) return node.appendChild(child);
        const index = node.childNodes.indexOf(reference);
        if (index < 0) return node.appendChild(child);
        detach(child);
        child.parentNode = node;
        // 先摘掉再插：参考节点可能因为摘除而挪了位置，重新取一次下标
        node.childNodes.splice(node.childNodes.indexOf(reference), 0, child);
        if (child.id) byId.set(child.id, child);
        return child;
      },
      replaceChildren(...nodes) {
        for (const child of node.childNodes) child.parentNode = null;
        node.childNodes = [];
        node.append(...nodes);
      },
      remove() {
        if (!node.parentNode) return;
        const index = node.parentNode.childNodes.indexOf(node);
        if (index >= 0) node.parentNode.childNodes.splice(index, 1);
        node.parentNode = null;
      },
      setAttribute(name, value) {
        node._attrs[name] = String(value);
        if (name === 'id') {
          node.id = String(value);
          byId.set(node.id, node);
        }
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
        for (const handler of node._listeners[type] ?? []) {
          handler({ preventDefault() {}, stopPropagation() {}, target: node, ...event });
        }
      },
      click() {
        node.dispatch('click');
      },
      focus() {},
      blur() {},
      querySelector(selector) {
        return descendants(node).find((child) => matches(child, selector)) ?? null;
      },
      querySelectorAll(selector) {
        return descendants(node).filter((child) => matches(child, selector));
      },
    };
    return node;
  }

  const document = {
    // 保持 'loading'：外壳的 boot() 不该在这些测试里跑起来（dom 由测试自己挂，见 attachDom）
    readyState: 'loading',
    documentElement: { style: { setProperty() {} } },
    createElement,
    getElementById: (id) => byId.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };

  return { document, createElement };
}

/* ============================================================ 沙箱与装载 */

/** 起真实后端并取回 index.html 引用的全部脚本（与 renderer.test.js 同一口径）。 */
async function loadScripts() {
  const app = await createServer({ dataDir: await mkdtemp(path.join(tmpdir(), 'potato-chat-render-')) });
  const info = await app.listen({ port: 0 });
  const origin = info.baseUrl.replace(/\/api\/v1$/, '');
  const html = await (await fetch(`${origin}/app/`)).text();
  const assets = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const scripts = [];
  for (const asset of assets) {
    const response = await fetch(`${origin}/app/${asset}`);
    scripts.push({ asset, text: await response.text() });
  }
  return { app, html, origin, scripts };
}

function makeSandbox(origin, dom) {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    URLSearchParams,
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
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
    WebSocket: function WebSocket() {
      this.close = () => {};
    },
    location: { protocol: 'http:', host: '127.0.0.1:3210', hostname: '127.0.0.1', pathname: '/app/', search: '', origin },
    document: dom.document,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return vm.createContext(sandbox);
}

/** 装载全部渲染层脚本，并把对话运行时的测试缝接上一个可控的 fetch。 */
async function bootChat() {
  const { app, html, origin, scripts } = await loadScripts();
  const dom = makeMiniDom();
  const context = makeSandbox(origin, dom);
  vm.runInContext(scripts.map((s) => s.text).join('\n;\n'), context, { filename: 'renderer-bundle.js' });

  const chat = context.window.__PC_CHAT_TEST__;
  const refs = {
    chatLog: dom.createElement('div'),
    chatQueue: dom.createElement('div'),
    chatSend: dom.createElement('button'),
    chatStop: dom.createElement('button'),
    toast: dom.createElement('div'),
    chatAttachments: dom.createElement('div'),
    chatControls: dom.createElement('div'),
    chatInput: dom.createElement('textarea'),
    chatAttach: dom.createElement('button'),
    chatFiles: dom.createElement('input'),
    panelToggle: dom.createElement('button'),
  };
  chat.attachDom(refs);
  // 把输入区真的接上：停止按钮的点击处理器就在 wireChat 里注册
  chat.wireChat();

  /** 每个请求都挂起，由测试自己决定什么时候回、回什么（排队与停止都要这种控制权）。 */
  const calls = [];
  context.fetch = (url, options = {}) =>
    new Promise((resolve) => {
      calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null, resolve });
    });

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const respond = (index, payload) => calls[index].resolve({ ok: true, status: 200, json: async () => payload });
  const reject = (index, payload, status = 500) =>
    calls[index].resolve({ ok: false, status, json: async () => payload });

  return { app, html, scripts, dom, context, chat, refs, calls, tick, respond, reject };
}

/** 一条正常的 /ai/chat 回话（正文 + 空卡片），用来把一轮"跑完"。 */
const ANSWER = (content = '答完了', extra = {}) => ({
  ok: true,
  conversation: { id: 'c1' },
  assistant: { content },
  drafts: [],
  queried: [],
  executed: [],
  ...extra,
});

/* ============================================================ 1) 消息排队 */

test('排队：一轮没答完时再发送不打断它，先入队、等回合结束后按顺序自动发出', async () => {
  const { app, dom, context, chat, refs, calls, tick, respond } = await bootChat();
  try {
    chat.state.ai.available = true;
    chat.state.conversationId = 'c1';

    // ① 第一条：立刻发出（/ai/chat 挂着不返回 = 一轮正在进行）
    void chat.send('第一条');
    await tick();
    assert.equal(calls.length, 1, '第一条应当立刻发出');
    assert.equal(calls[0].body.text, '第一条');
    assert.ok(chat.state.round, '发出一轮后要有运行态（排队与否全靠它）');
    assert.equal(refs.chatSend.hidden, true, '回合进行中：发送按钮让位给停止按钮');
    assert.equal(refs.chatStop.hidden, false, '回合进行中：停止按钮出现');

    // ② 回合进行中再发两条：**不打断当前回合**，进队列
    void chat.send('第二条');
    void chat.send('第三条：这是一条明显超过二十个字的长消息，用来验证 chip 的截断');
    assert.equal(calls.length, 1, '排队中的消息不该立刻打请求（否则服务端会挂着，界面说不清谁在跑）');
    assert.deepEqual(
      // Array.from：vm 里造出来的数组原型属于另一个 realm，先归一到宿主 realm 再比
      Array.from(chat.queueItems(), (item) => item.text.slice(0, 3)),
      ['第二条', '第三条'],
      '队列按到达顺序',
    );
    assert.equal(chat.queueItems()[0].seq, 1, '入队序号从 1 开始');
    assert.equal(refs.chatQueue.hidden, false, '排队条要显示出来');
    assert.match(refs.chatQueue.textContent, /2 条排队中/, '两条时显示总数');
    assert.match(refs.chatQueue.textContent, /第二条/, 'chip 上有消息文本');
    // 用户气泡要等**真正发出**才落：此刻聊天记录里不该有"第二条"
    assert.doesNotMatch(refs.chatLog.textContent, /第二条/, '排队中的消息还不能出现在对话里');

    // ③ 第一轮答完 → 队首自动发出，第二条的请求这才出现
    respond(0, ANSWER('答一'));
    await tick();
    await tick();
    assert.equal(calls.length, 2, '回合结束后应当自动发出队首');
    assert.equal(calls[1].body.text, '第二条', '先发队首（先进先出）');
    assert.match(refs.chatLog.textContent, /第二条/, '这一刻它才作为用户消息出现在对话里');
    assert.deepEqual(
      Array.from(chat.queueItems(), (item) => item.seq),
      [2],
      '已发出的那条离开队列，剩下的序号不变（chip 不该自己换号）',
    );
    assert.equal(refs.chatQueue.textContent.includes('2 条排队中'), false, '只剩一条时不再显示总数');

    // ④ 第二轮答完 → 最后一条发出，队列空、排队条消失
    respond(1, ANSWER('答二'));
    await tick();
    await tick();
    assert.equal(calls.length, 3);
    assert.equal(calls[2].body.text.startsWith('第三条'), true, '依次发完');
    assert.equal(chat.queueItems().length, 0, '队列空了');
    assert.equal(refs.chatQueue.hidden, true, '队列空 → 排队条消失');

    respond(2, ANSWER('答三'));
    await tick();
    await tick();
    assert.equal(chat.state.round, null, '全部发完后台面回到空闲');
  } finally {
    await app.close();
  }
});

test('排队：上一轮**出错**或**被停止**之后，队首照样接着发（不是只有答完才接力）', async () => {
  const { app, chat, refs, calls, tick, respond, reject } = await bootChat();
  try {
    chat.state.ai.available = true;
    chat.state.conversationId = 'c1';

    // ① 出错：一轮挂了也要把队列里的下一条发出去，否则用户的消息会永远卡在队列里
    void chat.send('甲');
    await tick();
    void chat.send('乙');
    assert.equal(chat.queueItems().length, 1);
    reject(0, { ok: false, error: { code: 'INTERNAL', message: '上游挂了' } }, 500);
    await tick();
    await tick();
    assert.match(refs.chatLog.textContent, /没能完成/, '失败要有失败卡（不是静默）');
    assert.equal(calls.length, 2, '出错之后队首照发');
    assert.equal(calls[1].body.text, '乙');

    // ② 被停止：停止只作用于"正在跑的那一轮"，排队的下一条继续
    void chat.send('丁');
    assert.equal(chat.queueItems().length, 1);
    refs.chatStop.dispatch('click');
    await tick();
    assert.match(calls[2].url, /\/ai\/chat\/stop$/);
    respond(2, { ok: true, stopped: true, conversationId: 'c1', messageId: null });
    // 契约：messageId 可能是 null（回合已登记、占位消息还没落库）→ 按"当前会话这一轮已停止"处理
    chat.handlePush({ type: 'chat_stopped', payload: { conversationId: 'c1', messageId: null } });
    assert.ok(chat.state.round, 'WS 到达时那条 HTTP 还没返回：运行态还在，队列要等它真的收尾');
    assert.match(refs.chatLog.textContent, /已停止/, 'null messageId 也要落下「已停止」标记');
    respond(1, {
      ok: true,
      stopped: true,
      conversation: { id: 'c1' },
      assistant: { content: '半截', status: 'stopped' },
      drafts: [],
      queried: [],
      executed: [],
    });
    await tick();
    await tick();
    assert.equal(calls.length, 4, '停止收尾之后，队列里的下一条要发出去');
    assert.equal(calls[3].body.text, '丁');
    assert.equal(chat.queueItems().length, 0, '队列随后清空');
  } finally {
    await app.close();
  }
});

test('排队条：chip = 入队序号 + 前 20 字（可取消），多条显示总数；切换会话清空并给系统提示', async () => {
  const { app, dom, chat, refs } = await bootChat();
  try {
    // 直接测渲染：chip 的内容与取消回调
    const host = dom.createElement('div');
    const cancelled = [];
    const long = '这是一条明显超过二十个字的长消息，用来验证 chip 的截断行为是否正确';
    chat.renderQueueBar(
      host,
      [
        { id: 'q1', seq: 1, text: '短消息' },
        { id: 'q2', seq: 2, text: long },
      ],
      (id) => cancelled.push(id),
    );
    assert.equal(host.hidden, false);
    assert.match(host.textContent, /2 条排队中/, '多条时给总数');
    const chips = host.querySelectorAll('.queue-chip');
    assert.equal(chips.length, 2);
    assert.equal(chips[0].querySelector('.queue-chip-seq').textContent, '1', 'chip 上有入队序号');
    assert.equal(chips[0].querySelector('.queue-chip-text').textContent, '短消息');
    assert.equal(
      chips[1].querySelector('.queue-chip-text').textContent,
      `${long.slice(0, 20)}…`,
      '长消息截到前 20 字 + 省略号',
    );
    chips[1].querySelector('.queue-chip-x').dispatch('click');
    assert.deepEqual(cancelled, ['q2'], '× 只取消这一条（id 对得上）');

    // 切换会话：队列属于上一个会话，必须清空并说一句
    chat.enqueueMessage({ text: '甲' });
    chat.enqueueMessage({ text: '乙' });
    assert.equal(chat.queueItems().length, 2);
    refs.chatLog.textContent = '';
    chat.clearChatLog();
    assert.equal(chat.queueItems().length, 0, '切换会话要清空队列（内存态，不落盘）');
    assert.equal(refs.chatQueue.hidden, true, '队列清空后排队条消失');
    assert.match(refs.chatLog.textContent, /切换会话，已清空 2 条排队消息/, '要说清那两条去哪了');
  } finally {
    await app.close();
  }
});

/* ============================================================ 2) 对话中停止 */

test('停止：发送按钮变停止按钮（方块图标），点击打 /ai/chat/stop，收到 chat_stopped 后收尾并标「已停止」', async () => {
  const { app, dom, scripts, chat, refs, calls, tick, respond } = await bootChat();
  try {
    // 按钮本体的契约在 index.html 里：方形图标 + title/aria-label = 停止本轮
    const { app: app2, html } = { app, html: null };
    void app2;
    const indexHtml = await readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
    const stopTag = indexHtml.match(/<button[^>]*id="chat-stop"[\s\S]*?<\/button>/);
    assert.ok(stopTag, 'index.html 要有 #chat-stop 按钮');
    assert.match(stopTag[0], /title="停止本轮"/, 'title 必须是「停止本轮」');
    assert.match(stopTag[0], /aria-label="停止本轮"/, 'aria-label 必须是「停止本轮」');
    assert.match(stopTag[0], /<rect /, '图标是方块（方形 = 停止，且不依赖字体里的 ⏹）');
    // 排队条在输入区上方
    assert.match(indexHtml, /id="chat-queue"[\s\S]*?class="chat-compose"/, '排队条要挂在输入区上方');
    assert.match(scripts.map((s) => s.text).join('\n'), /'\/ai\/chat\/stop'/);

    chat.state.ai.available = true;
    chat.state.conversationId = 'c1';
    void chat.send('帮我查一下缓考怎么申请');
    await tick();

    // 乐观显示：发出消息后立刻能停
    assert.equal(refs.chatStop.hidden, false, '发出消息后就要能停（不等第一片增量）');
    assert.equal(refs.chatSend.hidden, true);

    // 收到 ai_delta 仍然显示
    chat.handlePush({
      type: 'ai_delta',
      payload: { conversationId: 'c1', messageId: 'm1', text: '我查一下……' },
    });
    assert.equal(refs.chatStop.hidden, false, '流式进行中停止按钮保持显示');
    assert.match(refs.chatLog.textContent, /我查一下/, '增量正文进了气泡');

    // 点击停止 → POST /ai/chat/stop
    refs.chatStop.dispatch('click');
    await tick();
    assert.equal(calls.length, 2, '停止是一次独立的请求');
    assert.match(calls[1].url, /\/ai\/chat\/stop$/);
    assert.equal(calls[1].body.conversationId, 'c1');
    respond(1, { ok: true, stopped: true, conversationId: 'c1', messageId: 'm1' });

    // 服务端广播 chat_stopped：界面立刻收尾（不等那条还挂着的 HTTP）
    chat.handlePush({ type: 'chat_stopped', payload: { conversationId: 'c1', messageId: 'm1' } });
    assert.equal(refs.chatStop.hidden, true, '停止后按钮收起');
    assert.equal(refs.chatSend.hidden, false, '发送按钮回来');
    assert.match(refs.chatLog.textContent, /已停止/, '气泡下方要有「已停止」小标记');
    assert.match(refs.chatLog.textContent, /我查一下/, '停止前的正文要留着（服务端也把那半段落了库）');
    const stopNotes = refs.chatLog.querySelectorAll('.bubble-stop');
    assert.equal(stopNotes.length, 1, '「已停止」只能有一个');
    assert.equal(stopNotes[0].className.includes('fail'), false, '「已停止」不能用错误样式');

    // /ai/chat 的响应回来（被停止的那一轮，带着停止前落库的正文）
    respond(0, {
      ok: true,
      stopped: true,
      conversation: { id: 'c1' },
      assistant: { content: '我查一下……', status: 'stopped' },
      drafts: [{ draft: { action: 'create', target: 'schedule', fields: { title: '项目周会' } }, preview: {} }],
      queried: [],
      executed: [],
    });
    await tick();
    await tick();
    assert.equal(refs.chatLog.querySelectorAll('.bubble-stop').length, 1, '响应回来也不能再补一个标记');
    assert.doesNotMatch(refs.chatLog.textContent, /准备执行/, '被停止的一轮不再补画草稿确认卡（说了别弄了）');
    assert.equal(chat.state.round, null, '这一轮真的结束了');
  } finally {
    await app.close();
  }
});

test('停止：当前没有在跑的回合（stopped:false / idle）不是错误，只提示一句', async () => {
  const { app, chat, refs, calls, tick, respond } = await bootChat();
  try {
    chat.state.ai.available = true;
    chat.state.conversationId = 'c1';
    void chat.stopRound();
    await tick();
    respond(0, { ok: true, stopped: false, reason: 'idle' });
    await tick();
    assert.equal(calls[0].body.conversationId, 'c1');
    assert.match(refs.toast.textContent, /当前没有正在进行的回合/, '空闲时给一句轻提示');
    assert.doesNotMatch(refs.chatLog.textContent, /没能完成/, '空闲不是失败，不能弹错误卡');
  } finally {
    await app.close();
  }
});

test('停止：还没拿到会话 id 时点了停止，第一片增量到达后立刻补发（不静默丢）', async () => {
  const { app, chat, calls, tick } = await bootChat();
  try {
    chat.state.ai.available = true;
    chat.state.conversationId = null; // 全新对话：id 只在广播/响应里给
    void chat.send('第一条');
    await tick();

    void chat.stopRound();
    await tick();
    assert.equal(calls.length, 1, '还不知道会话 id，先不发停止请求');
    assert.equal(chat.state.stopWanted, true, '要记住"用户想停"，而不是假装没点');

    chat.handlePush({ type: 'ai_delta', payload: { conversationId: 'cNew', messageId: 'm9', text: '开' } });
    await tick();
    await tick();
    assert.equal(calls.length, 2, '增量带来 conversationId → 立刻补发停止');
    assert.equal(calls[1].body.conversationId, 'cNew');
  } finally {
    await app.close();
  }
});

/* ============================================================ 3) 过程清单 */

const PLAN_STEPS = (statuses) =>
  statuses.map((status, index) => ({
    id: `q${index + 1}`,
    label: `查询日程（2026-10-${13 + index}）`,
    status,
    target: 'schedule',
  }));

test('过程清单：全量快照重画同一张卡，跑到 done 后收成一行「已完成 N 步」，点击可再展开', async () => {
  const { app, dom, chat, refs, calls, tick } = await bootChat();
  try {
    chat.state.ai.available = true;
    chat.state.conversationId = 'c1';
    void chat.send('看看我这周有什么安排');
    await tick();
    assert.equal(calls.length, 1);

    // 第一份快照（pending）：清单卡出现，明细在
    chat.handlePush({
      type: 'plan',
      payload: { conversationId: 'c1', messageId: 'm1', steps: PLAN_STEPS(['pending', 'pending']) },
    });
    assert.match(refs.chatLog.textContent, /查询日程（2026-10-13）/, '步骤文案直接显示服务端给的整句');
    assert.match(refs.chatLog.textContent, /○/, 'pending 的图标是 ○');
    // 清单排在正文之前：此刻正文气泡是最后一个，清单卡是倒数第二个
    const order = Array.from(refs.chatLog.children, (node) => node.className.split(' ')[0]);
    assert.deepEqual(order, ['bubble', 'bubble', 'bubble'], '用户气泡 / 清单卡 / 正文气泡');
    assert.ok(refs.chatLog.children[1].querySelector('.plan-card'), '第二块是清单卡');
    assert.ok(refs.chatLog.children[2].querySelector('.bubble-text'), '最后一个是正文气泡');

    // 第二份快照（一个 running）：整体重画，仍只有一张卡
    chat.handlePush({
      type: 'plan',
      payload: { conversationId: 'c1', messageId: 'm1', steps: PLAN_STEPS(['done', 'running']) },
    });
    assert.equal(refs.chatLog.querySelectorAll('.plan-card').length, 1, '同一 messageId 只维护一张卡');
    assert.match(refs.chatLog.textContent, /✓/, 'done 的图标是 ✓');
    assert.match(refs.chatLog.textContent, /◐/, 'running 的图标是 ◐');
    assert.equal(refs.chatLog.querySelector('.plan-card').classList.contains('open'), true, '还在跑：明细展开');

    // 第三份快照（全 done）：收成一行
    chat.handlePush({
      type: 'plan',
      payload: { conversationId: 'c1', messageId: 'm1', steps: PLAN_STEPS(['done', 'done']) },
    });
    const card = refs.chatLog.querySelector('.plan-card');
    assert.equal(refs.chatLog.querySelectorAll('.plan-card').length, 1);
    assert.equal(card.classList.contains('open'), false, '全部结束 → 默认收起（历史消息不该堆满清单）');
    assert.match(card.querySelector('.op-title').textContent, /已完成 2 步/, '收起后是一行「已完成 N 步」');
    assert.match(card.querySelector('.op-body').textContent, /查询日程（2026-10-14）/, '明细还在 DOM 里（只是折叠）');

    // 点标题能展开明细
    card.querySelector('.op-head').dispatch('click');
    assert.equal(card.classList.contains('open'), true, '点击可展开明细');
    card.querySelector('.op-head').dispatch('click');
    assert.equal(card.classList.contains('open'), false, '再点收起');

    // 思考卡插在清单卡之前（顺序：思考 → 清单 → 正文）
    chat.handlePush({
      type: 'ai_delta',
      payload: { conversationId: 'c1', messageId: 'm1', channel: 'reasoning', delta: '先查日程' },
    });
    const blocks = Array.from(refs.chatLog.children);
    const thinkIndex = blocks.findIndex((node) => node.querySelector('.op-think'));
    const planIndex = blocks.findIndex((node) => node.querySelector('.plan-card'));
    const bodyIndex = blocks.findIndex((node) => node.className === 'bubble bot');
    assert.ok(thinkIndex >= 0 && planIndex >= 0, '思考卡与清单卡都要在');
    assert.ok(thinkIndex < planIndex, '思考卡排在清单卡之前');
    assert.ok(planIndex < bodyIndex, '清单卡排在正文之前');
    assert.match(refs.chatLog.textContent, /先查日程/, '思考内容进了思考卡');
  } finally {
    await app.close();
  }
});

test('过程清单：ai_message 广播先到、响应后到，思考卡仍插在清单卡之前（顺序不被打乱）', async () => {
  const { app, chat, refs, calls, tick, respond } = await bootChat();
  try {
    chat.state.ai.available = true;
    chat.state.conversationId = 'c1';
    void chat.send('看看这周有什么安排');
    await tick();
    chat.handlePush({
      type: 'plan',
      payload: { conversationId: 'c1', messageId: 'm1', steps: PLAN_STEPS(['done', 'done']) },
    });
    // 定稿广播（比 /ai/chat 的响应早到）：它只该收停止按钮，不该把清单卡从"当前这一轮"里摘掉
    chat.handlePush({ type: 'ai_message', payload: { conversationId: 'c1', message: { id: 'm1' } } });
    assert.equal(refs.chatStop.hidden, true, 'ai_message 一到就收停止按钮');
    respond(0, ANSWER('答完了', { assistant: { content: '答完了', reasoning: '先看日程，再排优先级' } }));
    await tick();
    await tick();
    const blocks = Array.from(refs.chatLog.children);
    const thinkIndex = blocks.findIndex((node) => node.querySelector('.op-think'));
    const planIndex = blocks.findIndex((node) => node.querySelector('.plan-card'));
    const bodyIndex = blocks.findIndex((node) => node.className === 'bubble bot');
    assert.ok(thinkIndex >= 0 && planIndex >= 0, `思考卡与清单卡都要在（实际顺序 ${blocks.map((n) => n.className).join(' | ')}）`);
    assert.ok(thinkIndex < planIndex, '思考卡排在清单卡之前');
    assert.ok(planIndex < bodyIndex, '清单卡排在正文之前');
    assert.match(refs.chatLog.textContent, /先看日程/, '思维链兜底进了思考卡');
  } finally {
    await app.close();
  }
});

test('过程清单：纯聊天没有 plan，空快照不建卡；别的会话 / 别的 messageId 的清单不画到当前对话里', async () => {
  const { app, chat, refs, calls, tick } = await bootChat();
  try {
    chat.state.ai.available = true;
    chat.state.conversationId = 'c1';
    void chat.send('你好');
    await tick();

    chat.handlePush({ type: 'plan', payload: { conversationId: 'c1', messageId: 'm1', steps: [] } });
    assert.equal(refs.chatLog.querySelectorAll('.plan-card').length, 0, '空快照不建卡');

    chat.handlePush({ type: 'plan', payload: { conversationId: 'c2', messageId: 'm1', steps: PLAN_STEPS(['done']) } });
    assert.equal(refs.chatLog.querySelectorAll('.plan-card').length, 0, '别的会话的清单不画在这里');

    chat.handlePush({ type: 'ai_delta', payload: { conversationId: 'c1', messageId: 'm1', text: '嗯' } });
    chat.handlePush({ type: 'plan', payload: { conversationId: 'c1', messageId: 'm2', steps: PLAN_STEPS(['done']) } });
    assert.equal(refs.chatLog.querySelectorAll('.plan-card').length, 0, '不是这一条消息的清单（别的回合）也不画');
    assert.equal(calls.length, 1, '整个过程没多发请求');
  } finally {
    await app.close();
  }
});

/* ============================================================ 4) 设置页 searchRetryMax */

test('设置页：「一次提问最多检索几次」是 1–6 的数字框，保存走 /ai/config 的写入路径', async () => {
  const { app, dom, context } = await bootChat();
  try {
    const section = context.window.PCModules.settingsSections().find((item) => item.id === 'chat.settings');
    assert.ok(section, '要有「对话设置」这一块');
    const sent = [];
    context.window.PC = {
      api: async (url, options = {}) => {
        sent.push({ url, body: options.body ?? null });
        if (!options.body) return { config: { contextWindow: 1000000, searchMaxPages: 8, searchRetryMax: 4 } };
        return { ok: true };
      },
      toast() {},
      refreshAi: async () => {},
    };
    const mount = dom.createElement('div');
    section.render(mount);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const retry = mount.querySelector('.cs-search-retry');
    assert.ok(retry, '要有 .cs-search-retry 输入框');
    assert.equal(retry.type, 'number');
    assert.equal(retry.min, '1', '下限 1');
    assert.equal(retry.max, '6', '上限 6');
    assert.equal(retry.value, '4', '显示服务端当前值');
    assert.match(mount.textContent, /一次提问最多检索几次/);
    assert.match(mount.textContent, /用完就不再发起新检索，模型会按已有结果收尾/, '文案要说清预算用完会怎样');

    // 「一轮最多执行几个操作」：数字框默认 3（服务端没给就用默认值），另有「不限制（0）」复选框
    const maxActions = mount.querySelector('.cs-max-actions');
    assert.ok(maxActions, '要有 .cs-max-actions 输入框');
    assert.equal(maxActions.type, 'number');
    assert.equal(maxActions.min, '1', '有限档下限 1');
    assert.equal(maxActions.max, '50', '有限档上限 50');
    assert.equal(maxActions.value, '3', '默认 3（沿用旧版提示词里的数）');
    assert.match(mount.textContent, /一轮最多执行几个操作/);
    assert.match(mount.textContent, /实际还受多轮上限/, '文案要说清还有别的约束');
    assert.ok(mount.querySelector('#cs-max-actions-unlimited'), '要有「不限制（0）」复选框');

    // 越界要当场拦住（不发请求）
    // 注意：失败一次会触发 paint()，整个区块被重画 —— 之后必须**重新取**输入框和按钮，
    // 拿旧节点赋值等于给一个已经不在页面上的元素填数字（这里第一次写就踩过）
    mount.querySelector('.cs-search-retry').value = '9';
    const before = sent.length;
    const saveBtn = mount.querySelectorAll('button').find((node) => node.textContent === '保存');
    assert.ok(saveBtn, '要能找到保存按钮');
    saveBtn.dispatch('click');
    assert.equal(sent.length, before, '9 超出 1–6，不许发请求');
    assert.match(mount.textContent, /1–6/, '要在界面上说清为什么没保存');

    // 合法值：随 /ai/config 一起写
    mount.querySelector('.cs-search-retry').value = '5';
    mount.querySelectorAll('button').find((node) => node.textContent === '保存').dispatch('click');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const post = sent.filter((item) => item.url === '/ai/config' && item.body).pop();
    assert.ok(post, '保存要打 /ai/config');
    assert.equal(post.body.searchRetryMax, 5, '新字段跟着一起写');
    assert.equal(post.body.searchMaxPages, 8, '原有字段照常一起提交');
    assert.equal(post.body.maxActionsPerTurn, 3, '「一轮最多执行几个操作」默认 3 一起提交');

    // 勾上「不限制」：保存的是 0（服务端语义：0 = 不限制，而不是"一条都不执行"）
    mount.querySelector('#cs-max-actions-unlimited').checked = true;
    mount.querySelector('#cs-max-actions-unlimited').dispatch('change');
    assert.equal(mount.querySelector('.cs-max-actions').disabled, true, '勾选后数字框禁用');
    mount.querySelectorAll('button').find((node) => node.textContent === '保存').dispatch('click');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const unlimitedPost = sent.filter((item) => item.url === '/ai/config' && item.body).pop();
    assert.equal(unlimitedPost.body.maxActionsPerTurn, 0, '「不限制」提交 0');
  } finally {
    await app.close();
  }
});
