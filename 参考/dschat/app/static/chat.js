// DeepSeek Chat 前端逻辑

const $ = (id) => document.getElementById(id);

let currentConvId = null;
let busy = false;
let controller = null;
let requestId = null;
let pendingImages = [];   // 待发送的图片 data URL 列表
let pendingFiles = [];    // 待发送的非图片附件列表 {name,size,kind,content}
let webSearch = false;    // 是否启用联网搜索
let currentAgentId = '';  // 当前选中的智能体 id (空 = 通用助手)
let agentsCache = [];     // 智能体列表缓存
let showMood = true;      // 是否显示情绪指示器 (由设置控制)

// 余额相关
let balanceCurrency = '';
let balanceCollapsed = false;
let balanceMode = 'floating';      // floating / fixed
let balanceCharacter = '';         // 固定模式角色名
let balanceWarnThreshold = 25.0;   // 余额低于此变黄
let balanceDangerThreshold = 10.0; // 余额低于此变红
let balanceAmount = null;          // 当前余额数值
let decorationsCache = [];         // 角色装饰图缓存
let currentDecoration = null;      // 当前选中的角色装饰图对象

const chatInner = $('chat-inner');
const chatBox = $('chat');
const input = $('input');
const convList = $('conv-list');

// ---------------------------------------------------------------- 工具
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function scrollBottom() { chatBox.scrollTop = chatBox.scrollHeight; }

// 日期规范化: 把各种日期写法统一成 YYYY-MM-DD, 失败返回 null
function normalizeDateStr(s) {
  if (!s) return null;
  s = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  let m = s.match(/^(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})日?$/);
  if (m) {
    return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  }
  m = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  if (m) {
    return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  }
  return null;
}

// POST JSON 并检查响应, 返回是否成功
async function postJson(url, body) {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return resp.ok;
  } catch (e) {
    return false;
  }
}

// 重复规则解析: 兼容 "每周" / "每2周" / "每天" / "每3天" / "每月" / "每年" / "无" 等
function parseRepeat(raw) {
  const s = (raw || '').trim();
  if (!s || s === '无' || s === '无重复' || s === '不重复' || s === 'none') {
    return { repeat: 'none', interval: 1 };
  }
  const freqMap = { '周': 'weekly', '星期': 'weekly', '天': 'daily', '日': 'daily', '月': 'monthly', '年': 'yearly' };
  // 中文组合: 每2周 / 每3天 / 每4月 / 每5年
  let m = s.match(/^每\s*(\d+)\s*(周|星期|天|日|月|年)$/);
  if (m) {
    return { repeat: freqMap[m[2]], interval: parseInt(m[1], 10) || 1 };
  }
  // 单字: 周 / 天 / 日 / 月 / 年
  m = s.match(/^(周|星期|天|日|月|年)$/);
  if (m) {
    return { repeat: freqMap[m[1]], interval: 1 };
  }
  // 中文词: 每周 / 每天 / 每日 / 每月 / 每年
  const cn = { '每周': ['weekly', 1], '每天': ['daily', 1], '每日': ['daily', 1], '每月': ['monthly', 1], '每年': ['yearly', 1] };
  if (cn[s]) return { repeat: cn[s][0], interval: cn[s][1] };
  // 英文
  const eng = { 'weekly': 'weekly', 'daily': 'daily', 'monthly': 'monthly', 'yearly': 'yearly' };
  if (eng[s.toLowerCase()]) return { repeat: eng[s.toLowerCase()], interval: 1 };
  return { repeat: 'none', interval: 1 };
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderMarkdown(el, text) {
  el.classList.remove('streaming');
  // 用占位符保护公式, 再整体 markdown 解析, 最后还原 —— 保证行内公式留在段落内不换行。
  // 支持 $...$, $$...$$, \(...\), \[...\]
  const source = String(text || '');
  const mathTokens = [];
  const PREFIX = 'ZzQqMm';

  const protectedText = source.replace(
    /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\$[^$\n]+?\$|\\\([\s\S]+?\\\))/g,
    (match) => {
      mathTokens.push(match);
      return `${PREFIX}${mathTokens.length - 1}MmQqZz`;
    }
  );

  let html = marked.parse(protectedText);
  // 还原公式
  html = html.replace(new RegExp(`${PREFIX}(\\d+)MmQqZz`, 'g'), (m, idx) => {
    return escapeHtml(mathTokens[parseInt(idx, 10)] || '');
  });

  el.innerHTML = html;
  convertSvgBlocks(el);
  el.querySelectorAll('pre code').forEach((b) => {
    try { hljs.highlightElement(b); } catch (e) {}
  });
  if (window.MathJax && MathJax.typesetPromise) {
    MathJax.typesetPromise([el]).catch(() => {});
  }
}

// 清理 SVG 中的危险内容 (脚本/事件/外部对象), 仅保留安全标签
function sanitizeSvg(src) {
  return (src || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?<\/embed>/gi, '')
    .replace(/on\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '');
}

// 将 SVG 源码包装为可显示的内联图表容器
function renderSvgDiagram(src) {
  let svg = sanitizeSvg(src).trim();
  if (!svg.toLowerCase().startsWith('<svg')) {
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">' + svg + '</svg>';
  }
  return '<div class="diagram">' + svg + '</div>';
}

// 把 ```svg 代码块转换为内联 SVG 图表
function convertSvgBlocks(root) {
  root.querySelectorAll('pre code').forEach((code) => {
    if (!(code.className || '').includes('language-svg')) return;
    const pre = code.parentElement;
    const src = code.textContent || '';
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderSvgDiagram(src);
    const diagram = wrapper.firstElementChild;
    if (pre && pre.parentElement && diagram) {
      pre.replaceWith(diagram);
    }
  });
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  if (resp.status === 401) {
    location.href = '/login';
    throw new Error('未登录');
  }
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return resp.json();
}

// ---------------------------------------------------------------- 智能体
async function loadAgents() {
  const data = await api('GET', '/api/agents');
  agentsCache = data.agents || [];
  renderAgentSelector();
  renderAgentDropdown();
}

function renderAgentSelector() {
  if (!currentAgentId) {
    $('agent-avatar').textContent = '🤖';
    $('agent-name').textContent = '通用助手';
    $('mood-tag').style.display = 'none';
    return;
  }
  const a = agentsCache.find((x) => x.id === currentAgentId);
  if (a) {
    $('agent-avatar').textContent = a.avatar || '🤖';
    $('agent-name').textContent = a.name || '未命名';
    if (a.mood_label) {
      updateMoodIndicator(a.mood_label);
    } else {
      $('mood-tag').style.display = 'none';
    }
  } else {
    $('agent-avatar').textContent = '🤖';
    $('agent-name').textContent = '通用助手';
    $('mood-tag').style.display = 'none';
  }
}

function updateMoodIndicator(label) {
  const el = $('mood-tag');
  if (!showMood || !label) {
    el.style.display = 'none';
    return;
  }
  el.textContent = label;
  el.style.display = '';
}

function renderAgentDropdown() {
  const dd = $('agent-dropdown');
  dd.innerHTML = '';

  // 通用助手选项
  const def = document.createElement('div');
  def.className = 'agent-option';
  def.innerHTML = '<span class="a-avatar">🤖</span><span class="a-name">通用助手</span>';
  def.addEventListener('click', () => selectAgent(''));
  dd.appendChild(def);

  agentsCache.forEach((a) => {
    const opt = document.createElement('div');
    opt.className = 'agent-option';
    const av = document.createElement('span');
    av.className = 'a-avatar';
    av.textContent = a.avatar || '🤖';
    const nm = document.createElement('span');
    nm.className = 'a-name';
    nm.textContent = a.name || '未命名';
    const edit = document.createElement('span');
    edit.className = 'a-edit';
    edit.textContent = '✎';
    edit.title = '编辑';
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      openAgentModal(a);
    });
    opt.appendChild(av);
    opt.appendChild(nm);
    opt.appendChild(edit);
    opt.addEventListener('click', () => selectAgent(a.id));
    dd.appendChild(opt);
  });

  // 新建智能体
  const add = document.createElement('div');
  add.className = 'agent-new';
  add.textContent = '＋ 新建智能体';
  add.addEventListener('click', () => openAgentModal(null));
  dd.appendChild(add);
}

async function selectAgent(agentId) {
  currentAgentId = agentId;
  $('agent-dropdown').style.display = 'none';
  renderAgentSelector();
  // 点击角色时重新获取余额
  fetchBalance();
  // 切换到该智能体下的对话
  currentConvId = null;
  chatInner.innerHTML = '';
  await loadConversations();
  closeSidebar();
}

function toggleAgentDropdown() {
  const dd = $('agent-dropdown');
  dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
}

function openAgentModal(agent) {
  $('agent-modal-title').textContent = agent ? '编辑智能体' : '新建智能体';
  $('agent-form-name').value = agent ? (agent.name || '') : '';
  $('agent-form-avatar').value = agent ? (agent.avatar || '🤖') : '🤖';
  $('agent-form-persona').value = agent ? (agent.persona || '') : '';
  $('agent-form-context').value = agent ? (agent.max_context || '') : '';
  // 情绪系数 (默认 0.5, 保留两位小数)
  $('agent-form-intensity').value = agent
    ? fmtCoefficient(agent.mood_intensity)
    : '0.5';
  $('agent-form-reactivity').value = agent
    ? fmtCoefficient(agent.mood_reactivity)
    : '0.5';
  $('agent-modal').style.display = 'flex';
  $('agent-modal').dataset.id = agent ? agent.id : '';
}

function fmtCoefficient(v) {
  if (v === undefined || v === null || v === '') return '0.5';
  const n = parseFloat(v);
  if (isNaN(n)) return '0.5';
  return n.toFixed(2);
}

function parseCoefficient(str) {
  if (str === undefined || str === null || str.trim() === '') return 0.5;
  let n = parseFloat(str);
  if (isNaN(n)) return 0.5;
  n = Math.max(0, Math.min(1, n));
  return Math.round(n * 100) / 100; // 保留两位小数
}

function closeAgentModal() {
  $('agent-modal').style.display = 'none';
}

async function saveAgent() {
  const id = $('agent-modal').dataset.id || '';
  const body = {
    name: $('agent-form-name').value.trim() || '未命名智能体',
    avatar: $('agent-form-avatar').value.trim() || '🤖',
    persona: $('agent-form-persona').value.trim(),
    max_context: parseInt($('agent-form-context').value, 10) || 0,
    mood_intensity: parseCoefficient($('agent-form-intensity').value),
    mood_reactivity: parseCoefficient($('agent-form-reactivity').value),
  };
  if (id) {
    await api('PATCH', '/api/agents/' + id, body);
  } else {
    const created = await api('POST', '/api/agents', body);
    currentAgentId = created.id;
  }
  closeAgentModal();
  await loadAgents();
  renderAgentSelector();
}

// ---------------------------------------------------------------- 侧边栏
// ---------------------------------------------------------------- 会话列表缓存
const CONV_CACHE_KEY = 'dschat_conv_cache';

function convCacheKey() {
  return CONV_CACHE_KEY + '_' + (currentAgentId || 'default');
}

function saveConvCache(convs) {
  try {
    localStorage.setItem(convCacheKey(), JSON.stringify(convs));
  } catch (e) {}
}

function loadConvCache() {
  try {
    const raw = localStorage.getItem(convCacheKey());
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

async function loadConversations() {
  // 1) 先从缓存渲染侧边栏 (秒开)
  const cached = loadConvCache();
  if (cached && cached.length) {
    renderConvList(cached);
  } else {
    convList.innerHTML = '<div class="loading-hint">正在加载对话…</div>';
  }

  // 2) 后台拉取最新列表
  let convs = null;
  try {
    const url = '/api/conversations?agent_id=' + encodeURIComponent(currentAgentId || '');
    const data = await api('GET', url);
    convs = data.conversations || [];
  } catch (e) {
    convs = cached; // 网络失败, 用缓存
  }

  if (!convs || convs.length === 0) {
    // 无会话: 自动创建空会话
    try {
      const created = await api('POST', '/api/conversations', { agent_id: currentAgentId });
      currentConvId = created.id;
      convs = [{ id: created.id, title: '', message_count: 0, preview: '' }];
    } catch (e) {
      convs = cached || [];
    }
  } else if (!currentConvId || !convs.some((c) => c.id === currentConvId)) {
    currentConvId = convs[0].id;
    loadConversationMessages(currentConvId);
  }

  saveConvCache(convs);
  renderConvList(convs);
}

function renderConvList(convs) {
  convList.innerHTML = '';
  convs.forEach((c) => {
    const item = document.createElement('div');
    item.className = 'conv-item' + (c.id === currentConvId ? ' active' : '');
    item.dataset.id = c.id;

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = c.title || '新对话';
    item.appendChild(title);

    if (c.preview) {
      const prev = document.createElement('div');
      prev.className = 'preview';
      prev.textContent = c.preview;
      item.appendChild(prev);
    }

    const del = document.createElement('button');
    del.className = 'icon del';
    del.textContent = '✕';
    del.title = '删除对话';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('确定删除该对话？')) return;
      await api('DELETE', '/api/conversations/' + c.id);
      if (currentConvId === c.id) {
        currentConvId = null;
        chatInner.innerHTML = '';
      }
      loadConversations();
    });
    item.appendChild(del);

    const rename = document.createElement('button');
    rename.className = 'icon rename';
    rename.textContent = '✎';
    rename.title = '重命名对话';
    rename.addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = prompt('输入新名称：', c.title || '');
      if (name === null) return;
      await api('PATCH', '/api/conversations/' + c.id, { title: name });
      loadConversations();
    });
    item.appendChild(rename);

    item.addEventListener('click', () => selectConversation(c.id));
    convList.appendChild(item);
  });
}

async function selectConversation(id) {
  if (busy) return;
  currentConvId = id;
  document.querySelectorAll('.conv-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.id === id);
  });
  closeSidebar();
  await loadConversationMessages(id);
}

// 懒加载会话历史消息: 先显示占位, 再异步填充
async function loadConversationMessages(id) {
  chatInner.innerHTML = '<div class="loading-hint">正在加载对话…</div>';
  try {
    const conv = await api('GET', '/api/conversations/' + id);
    // 防止用户已切换到别的会话
    if (currentConvId !== id) return;
    renderMessages(conv.messages || []);
  } catch (e) {
    if (currentConvId === id) {
      chatInner.innerHTML = '<div class="loading-hint">加载失败，请重试</div>';
    }
  }
}

// ---------------------------------------------------------------- 渲染消息
async function renderMessages(messages) {
  chatInner.innerHTML = '';
  // 找到最后一条 assistant 消息的 id (只有它需要显示"重试"按钮)
  let lastAssistantId = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { lastAssistantId = messages[i].id; break; }
  }
  for (const m of messages) {
    if (m.role === 'user') renderUserMessage(m);
    else await renderAssistantMessage(m, false, m.id === lastAssistantId);
  }
  scrollBottom();
}

function renderUserMessage(m) {
  const wrap = document.createElement('div');
  wrap.className = 'msg user';
  if (m.id) wrap.dataset.messageId = m.id;

  const role = document.createElement('div');
  role.className = 'role';
  role.textContent = '你';
  if (m.created_at) {
    const t = document.createElement('span');
    t.className = 'time';
    t.textContent = formatTime(m.created_at);
    role.appendChild(t);
  }
  if (m.id) {
    const editBtn = document.createElement('button');
    editBtn.className = 'edit-msg-btn';
    editBtn.textContent = '✎ 编辑';
    editBtn.title = '编辑此消息并重新生成';
    editBtn.addEventListener('click', () => enterEditUserMessage(wrap, m));
    role.appendChild(editBtn);
  }
  wrap.appendChild(role);

  if (m.images && m.images.length) {
    const imgWrap = document.createElement('div');
    imgWrap.className = 'img-wrap';
    m.images.forEach((fn) => {
      const img = document.createElement('img');
      // data URL 直接显示, 否则走图片接口; loading=lazy 延迟加载, 减少首屏等待
      img.loading = 'lazy';
      img.src = fn.startsWith('data:') ? fn : '/api/images/' + encodeURIComponent(fn);
      imgWrap.appendChild(img);
    });
    wrap.appendChild(imgWrap);
  }

  if (m.content) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = m.content;
    wrap.appendChild(bubble);
  }

  chatInner.appendChild(wrap);
}

function renderAssistantMessage(m, streaming, isLast) {
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';

  const role = document.createElement('div');
  role.className = 'role';
  const a = agentsCache.find((x) => x.id === currentAgentId);
  role.textContent = a ? (a.name || 'DeepSeek') : 'DeepSeek';
  if (m.created_at) {
    const t = document.createElement('span');
    t.className = 'time';
    t.textContent = formatTime(m.created_at);
    role.appendChild(t);
  }
  wrap.appendChild(role);

  if (m.reasoning) {
    const rw = document.createElement('div');
    rw.className = 'reasoning';
    const rl = document.createElement('div');
    rl.className = 'rl';
    rl.textContent = '💭 思考过程';
    rl.onclick = () => rw.classList.toggle('open');
    const rb = document.createElement('div');
    rb.className = 'rbody';
    rb.textContent = m.reasoning;
    rw.appendChild(rl);
    rw.appendChild(rb);
    wrap.appendChild(rw);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  let todoRes = { added: [], deleted: [] };
  let eventRes = { added: [], deleted: [] };
  let semRes = { added: [], deleted: [] };

  if (streaming) {
    bubble.classList.add('streaming');
    bubble.textContent = '';
  } else {
    // 历史消息: 剥离标记行 (只解析不重复执行), 并重建折叠条目
    let content = m.content || '';
    todoRes = parseTodoCommands(content);
    content = todoRes.text;
    eventRes = parseEventCommands(content);
    content = eventRes.text;
    semRes = parseSemesterCommands(content);
    content = semRes.text;
    renderMarkdown(bubble, content);
  }
  wrap.appendChild(bubble);

  if (!streaming) {
    if (todoRes.added.length) addTodoNote(wrap, todoRes.added);
    if (eventRes.added.length) addEventNote(wrap, eventRes.added);
    if (semRes.added.length) addSemesterNote(wrap, semRes.added);
    const allDeleted = [
      ...todoRes.deleted.map((t) => '待办: ' + t),
      ...eventRes.deleted.map((t) => '日程: ' + t),
      ...semRes.deleted.map((t) => '学期: ' + t),
    ];
    if (allDeleted.length) addDeletedNote(wrap, allDeleted);
    addAssistantActions(wrap, bubble, !!isLast);
  }

  chatInner.appendChild(wrap);
  scrollBottom();
  return { wrap, bubble };
}

// ---------------------------------------------------------------- 发送
function newRequestId() {
  return 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2);
}

async function send() {
  if (busy) return;
  const text = input.value.trim();
  const hasFiles = pendingFiles.length > 0;
  if (!text && pendingImages.length === 0 && !hasFiles) return;

  // 文本类附件内容拼入消息; 无法解析的文件仅附带名称提示
  const fileParts = pendingFiles.map((f) => {
    if (f.kind === 'text') return `[附件文件: ${f.name}]\n${f.content}`;
    return `[附件文件: ${f.name}（无法解析内容，已跳过）]`;
  });
  const finalText = fileParts.length ? (text ? text + '\n\n' : '') + fileParts.join('\n\n') : text;

  // 渲染用户消息 (带图片/附件即时显示, 附带当前时间)
  renderUserMessage({ role: 'user', content: finalText, images: pendingImages.slice(), created_at: Date.now() / 1000 });

  const images = pendingImages.slice();
  input.value = '';
  clearPreviews();

  requestId = newRequestId();
  const am = renderAssistantMessage({ role: 'assistant', content: '' }, true);
  await requestChat('/api/chat', {
    conversation_id: currentConvId, text: finalText, images, request_id: requestId, web_search: webSearch
  }, am);
}

// 统一的流式生成请求 (chat / retry / edit 共用)
async function requestChat(url, body, am) {
  let reasoningWrap = null, reasoningBody = null;
  let searchNote = null;
  let fullContent = '', fullReasoning = '';

  // 流式渲染节流: 每个动画帧最多刷新一次 DOM, 避免思考过程长时页面卡顿
  let rafPending = false, contentDirty = false, reasoningDirty = false;
  const flushStream = () => {
    rafPending = false;
    if (reasoningDirty) {
      reasoningDirty = false;
      if (reasoningBody) reasoningBody.textContent = fullReasoning;
    }
    if (contentDirty) {
      contentDirty = false;
      am.bubble.textContent = fullContent;
    }
    scrollBottom();
  };
  const scheduleFlush = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(flushStream);
  };

  busy = true;
  $('send').disabled = true;
  $('stop').style.display = '';
  controller = new AbortController();

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (resp.status === 401) {
      location.href = '/login';
      return;
    }
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error('HTTP ' + resp.status + ' ' + t.slice(0, 200));
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const handle = (data) => {
      if (data.type === 'conversation_id') {
        if (data.text) currentConvId = data.text;
        return;
      }
      if (data.type === 'search') {
        if (!searchNote) {
          searchNote = document.createElement('div');
          searchNote.className = 'search-note';
          am.wrap.insertBefore(searchNote, am.bubble);
        }
        searchNote.textContent = '🌐 ' + data.text;
        return;
      }
      if (data.type === 'reasoning') {
        fullReasoning += data.text;
        if (!reasoningWrap) {
          reasoningWrap = document.createElement('div');
          reasoningWrap.className = 'reasoning';
          const rl = document.createElement('div');
          rl.className = 'rl';
          rl.textContent = '💭 思考过程';
          rl.onclick = () => reasoningWrap.classList.toggle('open');
          reasoningBody = document.createElement('div');
          reasoningBody.className = 'rbody';
          reasoningWrap.appendChild(rl);
          reasoningWrap.appendChild(reasoningBody);
          am.wrap.insertBefore(reasoningWrap, am.bubble);
        }
        reasoningDirty = true;
      } else if (data.type === 'content') {
        fullContent += data.text;
        contentDirty = true;
      } else if (data.type === 'error') {
        am.bubble.classList.remove('streaming');
        am.bubble.innerHTML = '<span class="err">[错误] ' + escapeHtml(data.text) + '</span>';
      } else if (data.type === 'mood') {
        updateMoodIndicator(data.text);
      }
      scheduleFlush();
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        try { handle(JSON.parse(s.slice(5).trim())); } catch (e) {}
      }
    }

    if (fullContent) {
      const todoRes = await extractTodoAdditions(fullContent);
      fullContent = todoRes.text;
      const eventRes = await extractEventAdditions(fullContent);
      fullContent = eventRes.text;
      const semRes = await extractSemesterOperations(fullContent);
      fullContent = semRes.text;
      renderMarkdown(am.bubble, fullContent);
      if (todoRes.added.length) addTodoNote(am.wrap, todoRes.added);
      if (eventRes.added.length) addEventNote(am.wrap, eventRes.added);
      if (semRes.added.length) addSemesterNote(am.wrap, semRes.added);
      const allDeleted = [
        ...todoRes.deleted.map((t) => '待办: ' + t),
        ...eventRes.deleted.map((t) => '日程: ' + t),
        ...semRes.deleted.map((t) => '学期: ' + t),
      ];
      if (allDeleted.length) addDeletedNote(am.wrap, allDeleted);
    } else if (!am.bubble.querySelector('.err')) {
      am.bubble.classList.remove('streaming');
      am.bubble.textContent = '（无回复内容）';
    }
    addAssistantActions(am.wrap, am.bubble, true);
    loadConversations(); // 刷新标题与排序
  } catch (e) {
    if (e.name !== 'AbortError') {
      am.bubble.classList.remove('streaming');
      am.bubble.innerHTML = '<span class="err">[错误] ' + escapeHtml(String(e)) + '</span>';
      addAssistantActions(am.wrap, am.bubble, true);
    }
  } finally {
    busy = false;
    $('send').disabled = false;
    $('stop').style.display = 'none';
    controller = null;
    scrollBottom();
  }
}

// ---------------------------------------------------------------- 操作栏 (复制/重试)
function addAssistantActions(wrap, bubble, isLast) {
  if (wrap.querySelector('.msg-actions')) return;
  const actions = document.createElement('div');
  actions.className = 'msg-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'action-btn';
  copyBtn.textContent = '⧉ 复制';
  copyBtn.title = '复制回答';
  copyBtn.addEventListener('click', () => copyAssistant(copyBtn, bubble));
  actions.appendChild(copyBtn);

  if (isLast) {
    const retryBtn = document.createElement('button');
    retryBtn.className = 'action-btn';
    retryBtn.textContent = '↻ 重试';
    retryBtn.title = '重新生成这条回答';
    retryBtn.addEventListener('click', retryLast);
    actions.appendChild(retryBtn);
  }

  wrap.appendChild(actions);
}

// ---------------------------------------------------------------- AI 命令解析 (纯解析, 不执行请求)
function parseTodoCommands(text) {
  const lines = text.split('\n');
  const cleaned = [];
  const addedRaw = [];
  const deletedRaw = [];
  for (const line of lines) {
    const mAdd = line.match(/^\s*\[新增待办\]\s*(.+)\s*$/);
    const mDel = line.match(/^\s*\[删除待办\]\s*(.+)\s*$/);
    if (mAdd) addedRaw.push(mAdd[1].trim());
    else if (mDel) deletedRaw.push(mDel[1].trim());
    else cleaned.push(line);
  }
  const pmap = { '高': 'high', 'high': 'high', 'h': 'high', '中': 'medium', 'medium': 'medium', 'm': 'medium', '低': 'low', 'low': 'low', 'l': 'low' };
  const added = [];
  for (const raw of addedRaw) {
    const parts = raw.split('|').map((s) => s.trim());
    const title = parts[0];
    if (!title) continue;
    const p = (parts[1] || '').toLowerCase();
    const due = parts[2] || '';
    const category = (parts[3] || '').replace(/^科目[:：]?/, '').trim();
    const priority = pmap[p] || 'medium';
    const dueDate = (due === '无' || !due) ? null : normalizeDateStr(due);
    added.push({ title, priority, due_date: dueDate, category: category === '无' ? '' : category });
  }
  return { text: cleaned.join('\n'), added, deleted: deletedRaw };
}

function parseEventCommands(text) {
  const lines = text.split('\n');
  const cleaned = [];
  const addedRaw = [];
  const deletedRaw = [];
  for (const line of lines) {
    const mAdd = line.match(/^\s*\[新增日程\]\s*(.+)\s*$/);
    const mDel = line.match(/^\s*\[删除日程\]\s*(.+)\s*$/);
    if (mAdd) addedRaw.push(mAdd[1].trim());
    else if (mDel) deletedRaw.push(mDel[1].trim());
    else cleaned.push(line);
  }
  const rmap = { '每天': 'daily', 'daily': 'daily', '每周': 'weekly', 'weekly': 'weekly', '每月': 'monthly', 'monthly': 'monthly', '每年': 'yearly', 'yearly': 'yearly' };
  const added = [];
  for (const raw of addedRaw) {
    const parts = raw.split('|').map((s) => s.trim());
    const title = parts[0];
    const date = parts[1] || '';
    const start = parts[2] || '';
    const end = parts[3] || '';
    const location = (parts[4] || '').replace(/^地点[:：]?/, '').trim();
    let repeatRaw = parts[5] || '无';
    let repeatEndRaw = parts[6] || '无';
    // 向后兼容旧 8 字段格式: 重复 | 间隔 | 截止
    if (/^\d+$/.test(parts[6] || '')) {
      const oldInterval = parseInt(parts[6], 10);
      if (oldInterval >= 1) {
        // 旧格式里 repeatRaw 是纯频率(如"每周"), 间隔单独给
        const base = parseRepeat(repeatRaw);
        if (base.repeat !== 'none') repeatRaw = `每${oldInterval}${repeatRaw.replace(/^每/, '')}`;
      }
      repeatEndRaw = parts[7] || '无';
    }
    if (!title) continue;
    const normDate = normalizeDateStr(date);
    if (!normDate) continue;
    const allDay = start === '全天' || end === '全天';
    const startTime = (allDay || start === '无' || !start) ? null : start;
    const endTime = (allDay || end === '无' || !end) ? null : end;
    // 重复: 支持"每周"/"每2周"等组合形式 (间隔已含在重复字段里)
    const parsed = parseRepeat(repeatRaw);
    const repeat = parsed.repeat;
    const interval = parsed.interval;
    const repeatEnd = (repeatEndRaw === '无' || !repeatEndRaw) ? null : normalizeDateStr(repeatEndRaw);
    added.push({
      title, date: normDate, start_time: startTime, end_time: endTime, all_day: allDay,
      location: location === '无' ? '' : location,
      repeat, repeat_interval: interval, repeat_end: repeatEnd,
    });
  }
  return { text: cleaned.join('\n'), added, deleted: deletedRaw };
}

function parseSemesterCommands(text) {
  const lines = text.split('\n');
  const cleaned = [];
  const addedRaw = [];
  const deletedRaw = [];
  for (const line of lines) {
    const mAdd = line.match(/^\s*\[新增学期\]\s*(.+)\s*$/);
    const mDel = line.match(/^\s*\[删除学期\]\s*(.+)\s*$/);
    if (mAdd) addedRaw.push(mAdd[1].trim());
    else if (mDel) deletedRaw.push(mDel[1].trim());
    else cleaned.push(line);
  }
  const added = [];
  for (const raw of addedRaw) {
    const parts = raw.split('|').map((s) => s.trim());
    const name = parts[0];
    const startDate = parts[1] || '';
    const weeks = parts[2] || '18';
    if (!name) continue;
    const normStart = normalizeDateStr(startDate);
    if (!normStart) continue;
    const totalWeeks = parseInt(weeks, 10) || 18;
    added.push({ name, start_date: normStart, total_weeks: totalWeeks });
  }
  return { text: cleaned.join('\n'), added, deleted: deletedRaw };
}

// ---------------------------------------------------------------- AI 命令执行 (解析 + 发请求, 仅返回成功项)
async function extractTodoAdditions(text) {
  const r = parseTodoCommands(text);
  const okAdded = [];
  for (const item of r.added) {
    if (await postJson('/api/todos', item)) okAdded.push(item);
  }
  const okDeleted = [];
  for (const title of r.deleted) {
    if (await postJson('/api/todos/delete', { title })) okDeleted.push(title);
  }
  return { text: r.text, added: okAdded, deleted: okDeleted };
}

async function extractEventAdditions(text) {
  const r = parseEventCommands(text);
  const okAdded = [];
  for (const item of r.added) {
    if (await postJson('/api/events', item)) okAdded.push(item);
  }
  const okDeleted = [];
  for (const title of r.deleted) {
    if (await postJson('/api/events/delete', { title })) okDeleted.push(title);
  }
  return { text: r.text, added: okAdded, deleted: okDeleted };
}

async function extractSemesterOperations(text) {
  const r = parseSemesterCommands(text);
  const okAdded = [];
  for (const item of r.added) {
    if (await postJson('/api/semesters', item)) okAdded.push(item);
  }
  const okDeleted = [];
  for (const name of r.deleted) {
    if (await postJson('/api/semesters/delete', { name })) okDeleted.push(name);
  }
  return { text: r.text, added: okAdded, deleted: okDeleted };
}

// ---------------------------------------------------------------- 折叠条目 (待办/日程/学期)
function addCollapsibleNote(wrap, cls, icon, title, lines) {
  const note = document.createElement('div');
  note.className = 'collapsible-note ' + cls;
  const header = document.createElement('div');
  header.className = 'cn-header';
  header.textContent = `${icon} ${title}`;
  header.addEventListener('click', () => note.classList.toggle('open'));
  const body = document.createElement('div');
  body.className = 'cn-body';
  lines.forEach((l) => {
    const line = document.createElement('div');
    line.className = 'cn-line';
    line.textContent = l;
    body.appendChild(line);
  });
  note.appendChild(header);
  note.appendChild(body);
  const bubble = wrap.querySelector('.bubble');
  wrap.insertBefore(note, bubble || null);
}

function addTodoNote(wrap, todos) {
  const lines = todos.map((t) => {
    let s = `• ${t.title}`;
    const meta = [];
    if (t.category) meta.push(`科目:${t.category}`);
    if (t.priority) meta.push(`优先级:${t.priority === 'high' ? '高' : t.priority === 'low' ? '低' : '中'}`);
    if (t.due_date) meta.push(`截止:${t.due_date}`);
    if (meta.length) s += '（' + meta.join(' · ') + '）';
    return s;
  });
  addCollapsibleNote(wrap, 'todo', '📋', `新增待办 ${todos.length} 项`, lines);
}

function addEventNote(wrap, events) {
  const rlabel = { 'daily': '每天', 'weekly': '每周', 'monthly': '每月', 'yearly': '每年' };
  const lines = events.map((e) => {
    let s = `• ${e.title}`;
    const meta = [];
    if (e.date) meta.push(e.date);
    if (e.all_day) meta.push('全天');
    else if (e.start_time) meta.push(`${e.start_time}${e.end_time ? '-' + e.end_time : ''}`);
    if (e.location) meta.push(`地点:${e.location}`);
    if (e.repeat && e.repeat !== 'none') {
      let r = rlabel[e.repeat] || e.repeat;
      if ((e.repeat_interval || 1) > 1) r += `(每${e.repeat_interval}次)`;
      if (e.repeat_end) r += `至${e.repeat_end}`;
      meta.push('循环:' + r);
    }
    if (meta.length) s += '（' + meta.join(' · ') + '）';
    return s;
  });
  addCollapsibleNote(wrap, 'event', '📅', `新增日程 ${events.length} 项`, lines);
}

function addSemesterNote(wrap, semesters) {
  const lines = semesters.map((s) => {
    return `• ${s.name}（起始 ${s.start_date}，共 ${s.total_weeks} 周）`;
  });
  addCollapsibleNote(wrap, 'semester', '🎓', `新增学期 ${semesters.length} 项`, lines);
}

function addDeletedNote(wrap, items) {
  const lines = items.map((t) => `• ${t}`);
  addCollapsibleNote(wrap, 'deleted', '🗑️', `已删除 ${items.length} 项`, lines);
}

// ---------------------------------------------------------------- 复制
async function copyAssistant(btn, bubble) {
  const text = bubble.innerText || '';
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e2) {}
    ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = '✓ 已复制';
  setTimeout(() => { btn.textContent = old; }, 1200);
}

async function retryLast() {
  if (busy) return;
  const all = chatInner.querySelectorAll('.msg.assistant');
  if (all.length === 0) return;
  all[all.length - 1].remove();
  requestId = newRequestId();
  const am = renderAssistantMessage({ role: 'assistant', content: '' }, true);
  await requestChat('/api/retry', {
    conversation_id: currentConvId, request_id: requestId, web_search: webSearch
  }, am);
}

// ---------------------------------------------------------------- 编辑用户消息
function enterEditUserMessage(wrap, m) {
  if (busy) return;
  const bubble = wrap.querySelector('.bubble');
  if (!bubble) return;

  const ta = document.createElement('textarea');
  ta.className = 'edit-input';
  ta.value = m.content || '';

  const actions = document.createElement('div');
  actions.className = 'edit-actions';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'primary';
  saveBtn.textContent = '保存并重新发送';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', () => {
    bubble.classList.remove('editing');
    bubble.textContent = m.content || '';
  });
  saveBtn.addEventListener('click', () => {
    const newText = ta.value.trim();
    if (!newText) return;
    doEditUserMessage(m.id, newText, wrap);
  });
  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);

  bubble.classList.add('editing');
  bubble.textContent = '';
  bubble.appendChild(ta);
  bubble.appendChild(actions);
  ta.focus();
}

async function doEditUserMessage(messageId, newText, wrap) {
  if (busy) return;
  requestId = newRequestId();

  // 移除该消息之后的所有 DOM
  let next = wrap.nextElementSibling;
  while (next) {
    const tmp = next.nextElementSibling;
    next.remove();
    next = tmp;
  }

  // 更新该用户消息显示
  const bubble = wrap.querySelector('.bubble');
  if (bubble) bubble.textContent = newText;

  const am = renderAssistantMessage({ role: 'assistant', content: '' }, true);
  await requestChat('/api/edit', {
    conversation_id: currentConvId, message_id: messageId, text: newText,
    request_id: requestId, web_search: webSearch
  }, am);
}

function stop() {
  if (controller) controller.abort();
  // 通知后端真正停止生成
  if (requestId) {
    fetch('/api/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: requestId })
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------- 图片
function clearPreviews() {
  pendingImages = [];
  pendingFiles = [];
  $('preview-imgs').innerHTML = '';
}

function addImage(file) {
  if (!file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    pendingImages.push(dataUrl);

    const wrap = document.createElement('div');
    wrap.className = 'pimg';
    const img = document.createElement('img');
    img.src = dataUrl;
    const rm = document.createElement('span');
    rm.className = 'rm';
    rm.textContent = '✕';
    rm.onclick = () => {
      const idx = pendingImages.indexOf(dataUrl);
      if (idx >= 0) pendingImages.splice(idx, 1);
      wrap.remove();
    };
    wrap.appendChild(img);
    wrap.appendChild(rm);
    $('preview-imgs').appendChild(wrap);
  };
  reader.readAsDataURL(file);
}

// 常见文本类文件扩展名
const TEXT_FILE_EXTS = [
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'py', 'js', 'ts', 'jsx', 'tsx',
  'html', 'htm', 'css', 'xml', 'yml', 'yaml', 'ini', 'toml', 'sh', 'bat', 'log',
  'sql', 'c', 'cpp', 'h', 'hpp', 'java', 'go', 'rs', 'php', 'rb', 'swift', 'kt',
  'r', 'tex', 'vue', 'env', 'conf', 'cfg',
];

function isTextFile(file) {
  if (file.type && (
    file.type.startsWith('text/') ||
    file.type === 'application/json' ||
    file.type === 'application/javascript' ||
    file.type === 'application/xml' ||
    file.type === 'application/x-yaml'
  )) return true;
  const ext = ((file.name || '').split('.').pop() || '').toLowerCase();
  return TEXT_FILE_EXTS.includes(ext);
}

// 文件/图片统一入口: 图片走 addImage, 文本文件读取内容, 其他文件仅提示
function addFile(file) {
  if (!file) return;
  if (file.type && file.type.startsWith('image/')) {
    addImage(file);
    return;
  }
  if (isTextFile(file)) {
    const reader = new FileReader();
    reader.onload = () => {
      let content = String(reader.result || '');
      if (content.length > 20000) content = content.slice(0, 20000) + '\n…（内容过长已截断）';
      const fileObj = { name: file.name, size: file.size, kind: 'text', content };
      pendingFiles.push(fileObj);
      renderFileChip(fileObj);
    };
    reader.readAsText(file);
    return;
  }
  const fileObj = { name: file.name, size: file.size, kind: 'unsupported', content: '' };
  pendingFiles.push(fileObj);
  renderFileChip(fileObj);
}

function renderFileChip(fileObj) {
  const wrap = document.createElement('div');
  wrap.className = 'pfile';
  const name = document.createElement('span');
  name.className = 'pfile-name';
  name.textContent = (fileObj.kind === 'text' ? '📄 ' : '📎 ') + fileObj.name;
  name.title = fileObj.name + ' (' + Math.round((fileObj.size || 0) / 1024) + ' KB)';
  const rm = document.createElement('span');
  rm.className = 'rm';
  rm.textContent = '✕';
  rm.onclick = () => {
    const idx = pendingFiles.indexOf(fileObj);
    if (idx >= 0) pendingFiles.splice(idx, 1);
    wrap.remove();
  };
  wrap.appendChild(name);
  wrap.appendChild(rm);
  $('preview-imgs').appendChild(wrap);
}

// ---------------------------------------------------------------- 初始化
function applyFontConfig(cfg) {
  const fontSize = parseInt(cfg.font_size, 10);
  const mathScale = parseInt(cfg.math_scale, 10);
  if (fontSize && fontSize >= 8 && fontSize <= 48) {
    document.documentElement.style.setProperty('--chat-font-size', fontSize + 'px');
  }
  if (mathScale && mathScale >= 40 && mathScale <= 400) {
    document.documentElement.style.setProperty('--math-scale', mathScale + '%');
  }
}

function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  if (window.innerWidth <= 768) {
    // 移动端: 抽屉式展开/收起
    const open = sidebar.classList.toggle('open');
    toggleSidebarMask(open);
  } else {
    // 桌面端: 折叠
    const collapsed = sidebar.classList.toggle('collapsed');
    try { localStorage.setItem('sidebar_collapsed', collapsed ? '1' : '0'); } catch (e) {}
  }
}

function toggleSidebarMask(show) {
  const mask = document.getElementById('sidebar-mask');
  if (mask) mask.classList.toggle('show', !!show);
}

function closeSidebar() {
  const sidebar = document.querySelector('.sidebar');
  sidebar.classList.remove('open');
  toggleSidebarMask(false);
}

// ---------------------------------------------------------------- 账户
async function loadUser() {
  try {
    const data = await api('GET', '/api/auth/me');
    const u = data.user;
    if (!u) {
      location.href = '/login';
      return;
    }
    const roleText = u.role === 'admin' ? ' · 管理员' : '';
    $('user-tag').textContent = '👤 ' + u.username + roleText;
  } catch (e) {}
}

async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch (e) {}
  location.href = '/login';
}

async function init() {
  try {
    const cfg = await api('GET', '/api/config');
    $('model-tag').textContent = cfg.model || 'deepseek-flash';
    applyFontConfig(cfg);
    showMood = cfg.show_mood !== false;
    if (!showMood) {
      $('mood-tag').style.display = 'none';
    }
    balanceMode = cfg.balance_mode === 'fixed' ? 'fixed' : 'floating';
    balanceCharacter = cfg.balance_character || '';
    balanceWarnThreshold = parseFloat(cfg.balance_warn_threshold);
    balanceDangerThreshold = parseFloat(cfg.balance_danger_threshold);
    if (isNaN(balanceWarnThreshold)) balanceWarnThreshold = 25.0;
    if (isNaN(balanceDangerThreshold)) balanceDangerThreshold = 10.0;
  } catch (e) {}

  // 恢复侧边栏收起状态
  try {
    if (localStorage.getItem('sidebar_collapsed') === '1') {
      document.querySelector('.sidebar').classList.add('collapsed');
    }
  } catch (e) {}

  $('send').addEventListener('click', send);
  $('stop').addEventListener('click', stop);
  $('toggle-sidebar').addEventListener('click', toggleSidebar);
  $('logout').addEventListener('click', logout);
  const sidebarMask = document.getElementById('sidebar-mask');
  if (sidebarMask) sidebarMask.addEventListener('click', closeSidebar);

  // 智能体相关事件
  $('agent-selector').addEventListener('click', toggleAgentDropdown);
  $('agent-form-save').addEventListener('click', saveAgent);
  $('agent-form-cancel').addEventListener('click', closeAgentModal);
  $('agent-modal-close').addEventListener('click', closeAgentModal);
  $('agent-modal').addEventListener('click', (e) => {
    if (e.target === $('agent-modal')) closeAgentModal();
  });
  document.addEventListener('click', (e) => {
    const dd = $('agent-dropdown');
    if (!e.target.closest('.agent-bar') && dd.style.display !== 'none') {
      dd.style.display = 'none';
    }
  });

  $('new-conv').addEventListener('click', async () => {
    if (busy) return;
    const created = await api('POST', '/api/conversations', { agent_id: currentAgentId });
    currentConvId = created.id;
    chatInner.innerHTML = '';
    loadConversations();
    closeSidebar();
  });
  $('attach').addEventListener('click', () => $('file-input').click());
  $('web-search').addEventListener('click', () => {
    webSearch = !webSearch;
    $('web-search').classList.toggle('active', webSearch);
  });
  $('file-input').addEventListener('change', (e) => {
    Array.from(e.target.files).forEach(addFile);
    e.target.value = '';
  });
  // 剪切板图片粘贴
  document.addEventListener('paste', (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    let handled = false;
    for (const item of items) {
      if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) { addImage(file); handled = true; }
      }
    }
    if (handled) e.preventDefault();
  });
  input.addEventListener('keydown', (e) => {
    // 输入法组词过程中 (IME) 不响应, 避免误触发送
    if (e.isComposing || e.keyCode === 229) return;
    // Shift+Enter 发送, Enter 换行
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // 并行加载: 用户信息、智能体、会话列表互不阻塞, 尽早渲染界面
  loadUser();
  loadAgents();
  await loadConversations();
  initBalanceFab();
}

init();

// ---------------------------------------------------------------- 余额显示
function balanceLevel(num) {
  // 返回 'green' / 'yellow' / 'red'
  if (num === null || num === undefined) return 'green';
  if (num < balanceDangerThreshold) return 'red';
  if (num < balanceWarnThreshold) return 'yellow';
  return 'green';
}

function applyBalanceMode() {
  const fab = $('balance-fab');
  const fixed = $('balance-fixed');
  if (balanceMode === 'fixed') {
    fab.style.display = 'none';
    fixed.style.display = '';
  } else {
    fab.style.display = '';
    fixed.style.display = 'none';
  }
}

async function loadDecorations() {
  try {
    const data = await api('GET', '/api/decorations');
    decorationsCache = data.characters || [];
  } catch (e) {
    decorationsCache = [];
  }
  currentDecoration = null;
  if (balanceCharacter && decorationsCache.length) {
    currentDecoration = decorationsCache.find((c) => c.name === balanceCharacter) || null;
  }
  if (!currentDecoration && decorationsCache.length) {
    currentDecoration = decorationsCache[0];
  }
  renderDecoration();
  // 预取互动图到本地缓存 (下次点击即时显示, 不再等待网络)
  cacheInteractImages();
}

function renderDecoration() {
  const img = $('balance-deco-img');
  if (!currentDecoration) {
    img.src = '';
    return;
  }
  const level = balanceAmount === null ? 'green' : balanceLevel(balanceAmount);
  let fname;
  if (level === 'red') fname = currentDecoration.low;
  else if (level === 'yellow') fname = currentDecoration.mid;
  else fname = currentDecoration.high;
  fname = fname || currentDecoration.high || currentDecoration.mid || currentDecoration.low;
  if (fname) {
    img.src = getDecoUrl(fname);
  }
}

let interactionTimer = null;

// ---------------------------------------------------------------- 装饰图缓存
const DECO_CACHE_PREFIX = 'dschat_deco_';

function decoCacheKey(fname) {
  return DECO_CACHE_PREFIX + fname;
}

function getCachedDeco(fname) {
  try {
    return localStorage.getItem(decoCacheKey(fname));
  } catch (e) {
    return null;
  }
}

function getDecoUrl(fname) {
  const cached = getCachedDeco(fname);
  if (cached) return cached;
  return '/api/decorations/' + encodeURIComponent(fname);
}

async function cacheDeco(fname) {
  if (getCachedDeco(fname)) return;
  try {
    const resp = await fetch('/api/decorations/' + encodeURIComponent(fname));
    if (!resp.ok) return;
    const blob = await resp.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    localStorage.setItem(decoCacheKey(fname), dataUrl);
  } catch (e) {
    // 缓存失败静默忽略 (如配额已满)
  }
}

async function cacheInteractImages() {
  if (!currentDecoration || !currentDecoration.interact || !currentDecoration.interact.length) return;
  await Promise.all(currentDecoration.interact.map(cacheDeco));
}

function triggerDecorationInteraction() {
  if (!currentDecoration || !currentDecoration.interact || currentDecoration.interact.length === 0) return;
  const img = $('balance-deco-img');
  const list = currentDecoration.interact;
  const fname = list[Math.floor(Math.random() * list.length)];
  img.src = getDecoUrl(fname);
  if (interactionTimer) clearTimeout(interactionTimer);
  interactionTimer = setTimeout(() => renderDecoration(), 1500);
}

function initBalanceFab() {
  applyBalanceMode();

  const fab = $('balance-fab');

  // 点击: 折叠/展开
  fab.addEventListener('click', () => {
    balanceCollapsed = !balanceCollapsed;
    fab.classList.toggle('collapsed', balanceCollapsed);
    renderBalanceFab();
  });

  // 拖动
  let dragging = false, startX = 0, startY = 0, originX = 0, originY = 0, moved = false;
  fab.addEventListener('mousedown', (e) => {
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = fab.getBoundingClientRect();
    originX = rect.left;
    originY = rect.top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
    let left = originX + dx;
    let top = originY + dy;
    const w = fab.offsetWidth, h = fab.offsetHeight;
    left = Math.max(0, Math.min(window.innerWidth - w, left));
    top = Math.max(0, Math.min(window.innerHeight - h, top));
    fab.style.left = left + 'px';
    fab.style.top = top + 'px';
    fab.style.right = 'auto';
  });

  document.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    const rect = fab.getBoundingClientRect();
    const w = fab.offsetWidth;
    const toLeft = rect.left;
    const toRight = window.innerWidth - (rect.left + w);
    let left;
    if (toLeft <= toRight) {
      left = 0;
    } else {
      left = window.innerWidth - w;
    }
    fab.style.left = left + 'px';
    fab.style.right = 'auto';
    if (moved) {
      balanceCollapsed = true;
      fab.classList.add('collapsed');
      renderBalanceFab();
    }
  });

  // 初始: 默认右上角
  fab.style.left = 'auto';
  fab.style.right = '16px';
  fab.style.top = '60px';

  // 固定模式: 装饰图点击互动
  $('balance-deco-img').addEventListener('click', triggerDecorationInteraction);

  loadDecorations();
  fetchBalance();
  // 每 30 秒刷新一次
  setInterval(fetchBalance, 30000);
}

function renderBalance() {
  renderBalanceFab();
  renderBalanceFixed();
}

function renderBalanceFab() {
  const fab = $('balance-fab');
  const val = $('balance-fab-value');
  fab.classList.remove('warn', 'danger');
  if (balanceAmount !== null) {
    const level = balanceLevel(balanceAmount);
    if (level === 'red') fab.classList.add('danger');
    else if (level === 'yellow') fab.classList.add('warn');
  }
  if (balanceCurrency === '') {
    val.textContent = '--';
    return;
  }
  if (balanceCollapsed) {
    val.textContent = balanceCurrency === 'CNY' ? '¥' : (balanceCurrency || '');
  } else if (balanceAmount !== null) {
    val.textContent = '¥' + balanceAmount.toFixed(2);
  } else {
    val.textContent = '¥--';
  }
}

function renderBalanceFixed() {
  const textEl = $('balance-fixed-text');
  const emojiEl = $('balance-fixed-emoji');
  const level = balanceLevel(balanceAmount);
  if (balanceAmount === null) {
    textEl.textContent = '¥--';
    textEl.className = 'balance-text green';
    emojiEl.textContent = '😊';
    return;
  }
  textEl.textContent = '¥' + balanceAmount.toFixed(2);
  textEl.className = 'balance-text ' + level;
  if (level === 'red') emojiEl.textContent = '😢';
  else if (level === 'yellow') emojiEl.textContent = '😐';
  else emojiEl.textContent = '😊';
  // 装饰图随余额档位切换
  renderDecoration();
}

async function fetchBalance() {
  try {
    const data = await api('GET', '/api/balance');
    if (!data.ok || data.total_balance === null || data.total_balance === undefined) {
      balanceAmount = null;
      balanceCurrency = '';
      renderBalance();
      return;
    }
    balanceAmount = parseFloat(data.total_balance);
    balanceCurrency = data.currency || 'CNY';
    renderBalance();
  } catch (e) {
    // 静默失败, 保持原显示
  }
}
