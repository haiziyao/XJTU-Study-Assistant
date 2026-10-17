/** 笔记系统挂载层：只保存摘要，正文、图片、OCR 与附件归 AI 智学主程序。 */
(function () {
  'use strict';

  const CACHE_PREFIX = 'ai-study.notes.summary.v1.';
  const GRAPH_STYLE_KEY = 'ai-study.notes.graph-style.v1';
  const GRAPH_LEVEL_PALETTE = ['#4776e6', '#2fb779', '#9b66df', '#ed923c', '#e65b65', '#20a7bd', '#d95f9f', '#c99a18', '#6f7fe5', '#3d9b91', '#b86b42', '#7c71b8'];
  const CACHE_TTL = 7 * 86400000;
  const CACHE_LIMIT = 100;
  const IMPORT_ACCEPT = '.md,.markdown,.txt,.html,.htm,.pdf,.doc,.docx,.ppt,.pptx,.png,.jpg,.jpeg,.webp,.gif';
  const MAX_IMPORT_FILES = 8;
  const MAX_IMPORT_FILE_BYTES = 6 * 1024 * 1024;
  const MAX_IMPORT_TOTAL_BYTES = 10 * 1024 * 1024;
  const STATUS = { draft: '草稿', unorganized: '未整理', processing: '整理中', ready: '已整理', failed: '处理失败', archived: '已归档' };
  const SOURCE = { manual: '手动', snapshot: '随手拍', import: '导入' };
  const EMPTY_CAPS = { connected: false, search: false, markdown: false, view: false, edit: false, manage: false, upload: false, aiRead: false, export: false, capture: false, subscriptions: false };
  const FORBIDDEN = /^(body|content|markdown|ocr|ocrText|image|images|imageUrl|file|files|filePath|path|attachment|attachments|blob|base64|data)$/i;
  const requestedSelection = new URLSearchParams(location.search).get('note');
  const state = {
    provider: null,
    caps: { ...EMPTY_CAPS },
    items: [],
    selected: null,
    mount: null,
    ctx: null,
    namespace: null,
    unsubscribe: null,
    loading: false,
    error: null,
    offline: false,
    lastSync: null,
    calendar: new Map(),
    calendarChecked: new Set(),
    filter: 'all',
    query: '',
    tag: '',
    sort: 'updated',
    autoConnecting: false,
    mode: 'notes',
    baseLayout: 'table',
    graphScope: 'global',
    graphDimension: '3d',
    graphData: null,
    graphFrame: null,
    graphPositions: new Map(),
    graphCamera: { yaw: -0.45, pitch: 0.18, zoom: 1, panX: 0, panY: 0 },
    graphSettings: { edgeLength: 135, edgeWidth: 1.4, lineStyle: 'solid', repulsion: 8500, edgeColor: 'blue', motion: 1 },
    graphNodeStyles: new Map(),
    graphLevelColors: new Map(),
    graphStylesLoaded: false,
    canvases: [],
    canvasId: null,
    canvasSelected: new Set(),
  };

  const localStore = () => { try { return window.localStorage ?? null; } catch { return null; } };
  const today = () => window.PCUtil?.todayKey?.() ?? new Date().toISOString().slice(0, 10);
  const cacheKey = () => state.namespace ? `${CACHE_PREFIX}${encodeURIComponent(state.namespace)}` : null;

  function loadGraphStyles() {
    if (state.graphStylesLoaded) return;
    state.graphStylesLoaded = true;
    try {
      const raw = localStore()?.getItem(GRAPH_STYLE_KEY); if (!raw) return;
      const saved = JSON.parse(raw);
      state.graphNodeStyles = new Map(Object.entries(saved.nodes || {}).map(([id, style]) => [id, { size: Number(style?.size) || 1, color: /^#[0-9a-f]{6}$/i.test(style?.color || '') ? style.color : '' }]));
      state.graphLevelColors = new Map(Object.entries(saved.levels || {}).filter(([, color]) => /^#[0-9a-f]{6}$/i.test(color)).map(([level, color]) => [Number(level), color]));
    } catch { /* 损坏的本地外观设置不应阻止图谱打开。 */ }
  }

  function saveGraphStyles() {
    try { localStore()?.setItem(GRAPH_STYLE_KEY, JSON.stringify({ nodes: Object.fromEntries(state.graphNodeStyles), levels: Object.fromEntries(state.graphLevelColors) })); } catch { /* 隐私模式下允许只在本次页面生效。 */ }
  }

  const defaultGraphLevelColor = (level) => GRAPH_LEVEL_PALETTE[Math.abs(Number(level) || 0) % GRAPH_LEVEL_PALETTE.length];

  /** 触屏没有右键：静止长按打开同一套菜单，移动超过 10px 就判定为拖拽。 */
  function wireLongPress(element, handler, delay = 560) {
    let press = null;
    const cancel = () => { if (press?.timer) clearTimeout(press.timer); press = null; };
    element.addEventListener('touchstart', (event) => {
      if (event.touches?.length !== 1) return cancel();
      const touch = event.touches[0];
      const point = { clientX: touch.clientX, clientY: touch.clientY, preventDefault() {}, stopPropagation() {} };
      press = { x: touch.clientX, y: touch.clientY, identifier: touch.identifier };
      press.timer = setTimeout(() => {
        if (!press) return;
        navigator.vibrate?.(18);
        handler(point);
        cancel();
      }, delay);
    }, { passive: true });
    element.addEventListener('touchmove', (event) => {
      if (!press) return;
      const touch = [...(event.touches || [])].find((item) => item.identifier === press.identifier);
      if (!touch || Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > 10) cancel();
    }, { passive: true });
    element.addEventListener('touchend', cancel, { passive: true });
    element.addEventListener('touchcancel', cancel, { passive: true });
  }

  function readFile(file, mode) {
    if (mode === 'text' && typeof file?.text === 'function') return file.text();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`无法读取文件：${file?.name ?? '未知文件'}`));
      reader.onload = () => resolve(String(reader.result ?? ''));
      if (mode === 'text') reader.readAsText(file); else reader.readAsDataURL(file);
    });
  }

  function createLocalProvider(api) {
    const request = (path, options) => api(path, options);
    const queryString = (filters = {}) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== null && value !== '') params.set(key, value);
      const text = params.toString(); return text ? `?${text}` : '';
    };
    const listNotes = async (filters = {}) => (await request(`/notes${queryString(filters)}`)).items ?? [];
    return {
      cacheNamespace: 'builtin-main-program',
      capabilities: () => ({ search: true, markdown: true, view: true, edit: true, manage: true, upload: true, capture: true, aiRead: true }),
      listNotes,
      openNote(id) {
        const currentUrl = location.href || `${location.origin}${location.pathname}`;
        const target = new URL('views/notes/editor.html', currentUrl);
        if (id) target.searchParams.set('id', id);
        const apiBase = window.PC?.state?.apiBase;
        if (apiBase) target.searchParams.set('api', apiBase);
        location.href = target.href;
      },
      searchNotes: (query, filters = {}) => listNotes({ ...filters, query }),
      updateNote: async (id, input) => (await request(`/notes/${encodeURIComponent(id)}`, { method: 'PATCH', body: input })).summary,
      deleteNote: async (id, permanent = false) => request(`/notes/${encodeURIComponent(id)}${permanent ? '?permanent=true' : ''}`, { method: 'DELETE' }),
      restoreNote: async (id) => (await request(`/notes/${encodeURIComponent(id)}/restore`, { method: 'POST', body: {} })).summary,
      listTrash: async () => (await request('/notes?deleted=true&limit=500')).items ?? [],
      graph: async (filters = {}) => request(`/notes/graph${queryString(filters)}`),
      templates: async () => (await request('/note-templates')).items ?? [],
      instantiateTemplate: async (id, input) => (await request(`/note-templates/${encodeURIComponent(id)}/instantiate`, { method: 'POST', body: input })).summary,
      daily: async (date) => (await request('/notes/daily', { method: 'POST', body: { date } })).summary,
      listCanvases: async () => (await request('/note-canvases')).items ?? [],
      createCanvas: async (input) => (await request('/note-canvases', { method: 'POST', body: input })).item,
      updateCanvas: async (id, input) => (await request(`/note-canvases/${encodeURIComponent(id)}`, { method: 'PATCH', body: input })).item,
      deleteCanvas: async (id) => request(`/note-canvases/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      suggestCanvasDesign: async (id, nodeId) => request(`/note-canvases/${encodeURIComponent(id)}/ai-design`, { method: 'POST', body: { nodeId } }),
      listViews: async () => (await request('/note-views')).items ?? [],
      createView: async (input) => (await request('/note-views', { method: 'POST', body: input })).item,
      async createDraft(input) {
        return (await request('/notes', { method: 'POST', body: { ...input, source: 'manual', status: 'draft' } })).summary;
      },
      async uploadNotes(files, input) {
        const out = [];
        for (const file of files) {
          const textFile = /^text\//.test(file.type ?? '') || /\.(md|markdown|txt|html?|csv|json|ya?ml|log|tex)$/i.test(file.name ?? '');
          const body = textFile ? await readFile(file, 'text') : '';
          const attachments = textFile ? [] : [{ name: file.name, type: file.type, size: file.size, dataUrl: await readFile(file, 'data') }];
          const title = input.title && files.length === 1 ? input.title : input.title ? `${input.title} · ${file.name}` : file.name;
          const result = await request('/notes', {
            method: 'POST',
            body: { ...input, title, body, attachments, source: 'import', status: 'ready', format: /\.txt$/i.test(file.name ?? '') ? 'text' : 'markdown' },
          });
          out.push(result.summary);
        }
        return out;
      },
      async startCapture(input = {}) {
        const file = Array.from(input.files ?? [])[0];
        if (!file) throw new Error('请先拍照或选择一张图片');
        const result = await request('/notes', {
          method: 'POST',
          body: {
            title: input.title || `随手拍 ${new Date().toLocaleString()}`, tags: input.tags, anchor: input.anchor,
            source: 'snapshot', status: 'unorganized', body: '', mediaCount: 1,
            attachments: [{ name: file.name || '随手拍.jpg', type: file.type || 'image/jpeg', size: file.size, dataUrl: await readFile(file, 'data') }],
          },
        });
        return result.summary;
      },
      async readNote(id) {
        const note = (await request(`/notes/${encodeURIComponent(id)}`)).note;
        return { format: note.format === 'text' ? 'text' : 'markdown', text: note.body || '（空白笔记）', attachments: note.attachments ?? [] };
      },
      async renderMarkdown(id) { return (await this.readNote(id)).text; },
      async readNotesForAI(input) { return (await request('/notes/ai-context', { method: 'POST', body: input })).items ?? []; },
    };
  }

  function ensureLocalProvider(api) {
    if (state.provider || state.autoConnecting || typeof api !== 'function') return;
    state.autoConnecting = true;
    connectProvider(createLocalProvider(api))
      .catch((error) => { state.error = error; render(); })
      .finally(() => { state.autoConnecting = false; });
  }

  function anchorOf(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(value.date ?? ''))) {
      return { type: 'date', date: String(value.date) };
    }
    if (value.type === 'schedule' && value.scheduleId && /^\d{4}-\d{2}-\d{2}$/.test(String(value.occurrenceDate ?? ''))) {
      return { type: 'schedule', scheduleId: String(value.scheduleId), occurrenceDate: String(value.occurrenceDate) };
    }
    return null;
  }

  function summaryOf(value, persist = false) {
    if (!value || typeof value !== 'object' || !value.id) throw new Error('笔记摘要缺少 id');
    const item = {
      id: String(value.id),
      title: String(value.title ?? '').trim() || '未命名笔记',
      source: ['manual', 'snapshot', 'import'].includes(value.source) ? value.source : 'manual',
      status: ['draft', 'unorganized', 'processing', 'ready', 'failed', 'archived'].includes(value.status) ? value.status : 'draft',
      anchor: anchorOf(value.anchor),
      tags: Array.isArray(value.tags) ? value.tags.map(String).map((v) => v.trim()).filter(Boolean).slice(0, 12) : [],
      folder: String(value.folder ?? '').slice(0, 300),
      aliases: Array.isArray(value.aliases) ? value.aliases.map(String).slice(0, 20) : [],
      properties: value.properties && typeof value.properties === 'object' ? value.properties : {},
      favorite: Boolean(value.favorite),
      links: Array.isArray(value.links) ? value.links.slice(0, 500) : [],
      revision: Math.max(1, Number(value.revision) || 1),
      deletedAt: value.deletedAt ?? null,
      mediaCount: Math.max(0, Number(value.mediaCount) || 0),
      createdAt: String(value.createdAt ?? new Date().toISOString()),
      updatedAt: String(value.updatedAt ?? value.createdAt ?? new Date().toISOString()),
    };
    if (!persist && typeof value.previewText === 'string') item.previewText = value.previewText.slice(0, 400);
    return item;
  }

  function unsafePayload(value, depth = 0) {
    if (!value || depth > 5 || typeof value !== 'object') return false;
    if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
    return Object.entries(value).some(([key, child]) => FORBIDDEN.test(key) || unsafePayload(child, depth + 1));
  }

  function loadCache() {
    const storage = localStore();
    const key = cacheKey();
    if (!storage || !key) return [];
    try {
      const data = JSON.parse(storage.getItem(key) ?? 'null');
      if (!data || data.version !== 1 || Date.now() - Number(data.savedAt) > CACHE_TTL || !Array.isArray(data.items)) {
        storage.removeItem(key);
        return [];
      }
      state.lastSync = data.lastSync ?? null;
      return data.items.slice(0, CACHE_LIMIT).map((item) => summaryOf(item, true));
    } catch {
      storage.removeItem(key);
      return [];
    }
  }

  function saveCache() {
    const storage = localStore();
    const key = cacheKey();
    if (!storage || !key) return;
    const items = [...state.items]
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, CACHE_LIMIT)
      .map((item) => summaryOf(item, true));
    try { storage.setItem(key, JSON.stringify({ version: 1, savedAt: Date.now(), lastSync: state.lastSync, items })); } catch { /* 可丢弃缓存 */ }
  }

  function merge(value) {
    const item = summaryOf(value);
    const index = state.items.findIndex((candidate) => candidate.id === item.id);
    if (index >= 0) state.items.splice(index, 1, item); else state.items.unshift(item);
    state.selected ||= item.id;
    saveCache();
    return item;
  }

  function stopSubscription() {
    try { state.unsubscribe?.(); } catch { /* Provider 自行清理 */ }
    state.unsubscribe = null;
  }

  async function connectProvider(provider) {
    if (!provider || typeof provider.listNotes !== 'function') throw new Error('笔记 Provider 必须实现 listNotes(filters)');
    stopSubscription();
    state.provider = provider;
    state.namespace = typeof provider.cacheNamespace === 'string' && provider.cacheNamespace.trim() ? provider.cacheNamespace.trim() : null;
    state.items = loadCache();
    state.selected = requestedSelection || state.items[0]?.id || null;
    state.caps = { ...EMPTY_CAPS, ...((await provider.capabilities?.()) ?? {}), connected: true };
    state.offline = false;
    if (typeof provider.subscribe === 'function') {
      const unsubscribe = provider.subscribe(onProviderEvent);
      if (typeof unsubscribe === 'function') state.unsubscribe = unsubscribe;
      state.caps.subscriptions = true;
    }
    render();
    await refresh();
    return { connected: true, capabilities: { ...state.caps } };
  }

  function disconnectProvider() {
    stopSubscription();
    state.provider = null;
    state.caps = { ...EMPTY_CAPS };
    state.offline = state.items.length > 0;
    state.items = state.items.map((item) => summaryOf(item, true));
    render();
  }

  async function onProviderEvent(event) {
    if (!event) return;
    if (event.type === 'created' || event.type === 'updated') merge(event.summary);
    if (event.type === 'deleted') {
      state.items = state.items.filter((item) => item.id !== String(event.id));
      if (state.selected === String(event.id)) state.selected = state.items[0]?.id ?? null;
      if (state.mode !== 'trash') saveCache();
    }
    if (event.type === 'processing') {
      const item = state.items.find((candidate) => candidate.id === String(event.id));
      if (item) merge({ ...item, status: event.status, updatedAt: event.updatedAt ?? item.updatedAt });
    }
    if (event.type === 'connection') { state.offline = !event.connected; state.caps.connected = Boolean(event.connected); }
    if (event.type === 'reset') return refresh();
    render();
  }

  async function refreshCalendar() {
    const api = state.ctx?.api ?? window.PC?.api;
    if (typeof api !== 'function') return;
    const dates = [...new Set(state.items.filter((item) => item.anchor?.type === 'schedule').map((item) => item.anchor.occurrenceDate))].sort();
    const groups = [];
    for (const date of dates) {
      const group = groups.at(-1);
      const span = group ? (new Date(`${date}T12:00:00`) - new Date(`${group.from}T12:00:00`)) / 86400000 : 999;
      if (!group || span > 399) groups.push({ from: date, to: date }); else group.to = date;
    }
    await Promise.all(groups.map(async ({ from, to }) => {
      try {
        const data = await api(`/calendar?from=${from}&to=${to}`);
        for (const day of data.days ?? []) {
          for (const schedule of day.schedules ?? []) {
            const id = String(schedule.scheduleId ?? schedule.id ?? '');
            if (id) state.calendar.set(`${id}:${day.date}`, schedule);
          }
        }
        dates.filter((date) => date >= from && date <= to).forEach((date) => state.calendarChecked.add(date));
      } catch { /* 查询失败不误报日程已删除 */ }
    }));
  }

  async function refresh() {
    if (!state.provider) { render(); return; }
    state.loading = true;
    state.error = null;
    render();
    try {
      const filters = { source: state.filter === 'snapshot' ? 'snapshot' : undefined, status: state.filter === 'pending' ? 'processing' : undefined, tag: state.tag || undefined, deleted: state.mode === 'trash' ? 'true' : undefined, limit: state.mode === 'trash' ? 500 : CACHE_LIMIT };
      const result = state.query && state.caps.search && typeof state.provider.searchNotes === 'function'
        ? await state.provider.searchNotes(state.query, filters)
        : await state.provider.listNotes(filters);
      state.items = (Array.isArray(result) ? result : result?.items ?? []).map((item) => summaryOf(item));
      state.selected = state.items.some((item) => item.id === state.selected) ? state.selected : state.items[0]?.id ?? null;
      await refreshCalendar();
      state.lastSync = new Date().toISOString();
      state.offline = false;
      if (state.mode !== 'trash') saveCache();
    } catch (error) {
      state.error = error;
      state.offline = state.items.length > 0;
    } finally {
      state.loading = false;
      render();
    }
  }

  async function open(id) {
    if (!state.provider?.openNote) throw new Error('AI 智学主程序尚未提供打开笔记能力');
    return state.provider.openNote(String(id));
  }

  async function read(id) {
    let result;
    if (state.caps.view && typeof state.provider?.readNote === 'function') result = await state.provider.readNote(String(id));
    else if (state.caps.markdown && typeof state.provider?.renderMarkdown === 'function') result = await state.provider.renderMarkdown(String(id));
    else throw new Error('AI 智学主程序尚未提供查看笔记能力');
    if (typeof result === 'string') return { format: 'markdown', text: result, attachments: [] };
    const text = [result?.text, result?.markdown, result?.content].find((value) => typeof value === 'string') ?? '';
    return { format: result?.format === 'text' ? 'text' : 'markdown', text, attachments: Array.isArray(result?.attachments) ? result.attachments : [] };
  }

  async function upload(files, input = {}) {
    if (!state.provider || state.offline || !state.caps.upload || typeof state.provider.uploadNotes !== 'function') {
      throw new Error('AI 智学主程序尚未提供手动上传能力');
    }
    const list = Array.from(files ?? []);
    if (!list.length) throw new Error('请至少选择一个笔记文件');
    if (list.length > MAX_IMPORT_FILES) throw new Error(`一次最多上传 ${MAX_IMPORT_FILES} 个文件`);
    let total = 0;
    for (const file of list) {
      const size = Math.max(0, Number(file?.size) || 0); total += size;
      if (size > MAX_IMPORT_FILE_BYTES) throw new Error(`“${file?.name ?? '文件'}”超过 6 MB`);
    }
    if (total > MAX_IMPORT_TOTAL_BYTES) throw new Error('本次上传文件总大小超过 10 MB');
    const result = await state.provider.uploadNotes(list, {
      title: String(input.title ?? '').trim(),
      tags: Array.isArray(input.tags) ? input.tags.map(String).map((value) => value.trim()).filter(Boolean) : [],
      anchor: anchorOf(input.anchor),
    });
    const values = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : result?.summary ? [result.summary] : result ? [result] : [];
    if (!values.length) throw new Error('主程序未返回上传后的笔记摘要');
    const items = values.map((value) => merge({ ...value, source: 'import' }));
    state.selected = items[0].id;
    render();
    return items;
  }

  async function readForAI(request = {}) {
    if (!state.provider || state.offline || !state.caps.aiRead || typeof state.provider.readNotesForAI !== 'function') {
      throw new Error('AI 智学主程序尚未提供 AI 读取笔记能力');
    }
    const options = request && typeof request === 'object' ? request : {};
    const ids = [...new Set((Array.isArray(options.ids) ? options.ids : []).map(String).filter(Boolean))].slice(0, 20);
    const query = String(options.query ?? '').trim().slice(0, 200);
    const limit = Math.min(20, Math.max(1, Math.trunc(Number(options.limit) || 10)));
    const result = await state.provider.readNotesForAI({ ids, query, limit });
    const values = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : result ? [result] : [];
    return values.slice(0, limit).filter((value) => value && value.id).map((value) => {
      const text = [value.text, value.markdown, value.content].find((candidate) => typeof candidate === 'string') ?? '';
      return {
        id: String(value.id),
        title: String(value.title ?? '').trim() || '未命名笔记',
        format: value.format === 'text' ? 'text' : 'markdown',
        text: text.slice(0, 200000),
        tags: Array.isArray(value.tags) ? value.tags.map(String).slice(0, 12) : [],
        anchor: anchorOf(value.anchor),
        updatedAt: String(value.updatedAt ?? ''),
      };
    });
  }

  function ingestSnapshot(value) {
    if (unsafePayload(value)) throw new Error('随手拍挂载点只接受笔记摘要，不接受正文、图片或附件数据');
    const item = merge({ ...value, source: 'snapshot' });
    render();
    return item;
  }

  function anchorText(item) {
    const anchor = item.anchor;
    if (!anchor) return '未关联日历';
    if (anchor.type === 'date') return `日期 · ${anchor.date}`;
    const schedule = state.calendar.get(`${anchor.scheduleId}:${anchor.occurrenceDate}`);
    if (schedule) {
      const time = schedule.startTime ? `${schedule.startTime}${schedule.endTime ? `–${schedule.endTime}` : ''}` : '';
      return `${anchor.occurrenceDate} · ${time} ${schedule.title ?? '未命名日程'}${schedule.location ? ` · ${schedule.location}` : ''}`;
    }
    return state.calendarChecked.has(anchor.occurrenceDate) ? `原日程不可用 · ${anchor.occurrenceDate}` : `日程 · ${anchor.occurrenceDate}`;
  }

  function formatTime(value) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return '—';
    const key = window.PCUtil?.dateKey?.(date) ?? String(value).slice(0, 10);
    return `${key} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  function visibleItems() {
    const now = today();
    let items = state.items.filter((item) => {
      const date = item.anchor?.date ?? item.anchor?.occurrenceDate ?? '';
      if (state.filter === 'today' && date !== now) return false;
      if (state.filter === 'pending' && !['draft', 'processing', 'failed'].includes(item.status)) return false;
      if (state.filter === 'snapshot' && item.source !== 'snapshot') return false;
      if (state.filter === 'favorite' && !item.favorite) return false;
      if (state.tag && !item.tags.includes(state.tag)) return false;
      return true;
    });
    return [...items].sort((a, b) => String(b[state.sort === 'created' ? 'createdAt' : 'updatedAt']).localeCompare(String(a[state.sort === 'created' ? 'createdAt' : 'updatedAt'])));
  }

  function pill(item) { return mk('span', `notes-status ${item.status}`, STATUS[item.status] ?? item.status); }

  function renderToolbar(host) {
    const bar = mk('div', 'toolbar wrap notes-toolbar');
    const modes = mk('div', 'notes-mode-tabs');
    for (const [key, label] of [['notes', '笔记'], ['graph', '知识图谱'], ['bases', '数据库视图'], ['canvas', 'Canvas'], ['trash', '回收站']]) {
      const button = mk('button', `notes-mode-tab${state.mode === key ? ' active' : ''}`, label); button.type = 'button';
      button.addEventListener('click', async () => { const leavingTrash = state.mode === 'trash' && key !== 'trash'; state.mode = key; state.graphData = null; if (key === 'notes' || key === 'trash' || leavingTrash) await refresh(); else render(); }); modes.appendChild(button);
    }
    bar.appendChild(modes);
    const first = mk('div', 'toolbar-row');
    const seg = mk('div', 'seg');
    for (const [key, label] of [['all', '全部'], ['today', '今天'], ['pending', '待整理']]) {
      const button = mk('button', `seg-btn${state.filter === key ? ' active' : ''}`, label);
      button.type = 'button';
      button.addEventListener('click', () => { state.filter = key; render(); });
      seg.appendChild(button);
    }
    const connection = mk('span', `notes-connection ${state.provider && !state.offline ? 'on' : state.offline ? 'offline' : ''}`,
      state.provider && !state.offline ? '主程序已连接' : state.offline ? '离线摘要' : '等待主程序');
    const capture = mk('button', 'ghost-btn notes-capture', '随手拍');
    capture.type = 'button';
    capture.disabled = !state.provider || state.offline || !state.caps.capture || !state.provider.startCapture;
    capture.title = capture.disabled ? '拍摄能力待 AI 智学主程序接入' : '拍下内容并保存为笔记';
    capture.addEventListener('click', () => openComposer('snapshot', capture));
    const uploadButton = mk('button', 'ghost-btn notes-upload', '手动上传');
    uploadButton.type = 'button';
    uploadButton.disabled = !state.provider || state.offline || !state.caps.upload || !state.provider.uploadNotes;
    uploadButton.title = uploadButton.disabled ? '上传能力待 AI 智学主程序接入' : '上传文档或图片为笔记';
    uploadButton.addEventListener('click', () => openComposer('import', uploadButton));
    const create = mk('button', 'primary-btn notes-create', '+ 新建笔记');
    create.type = 'button';
    create.disabled = !state.provider || state.offline || !state.provider.createDraft;
    create.addEventListener('click', () => {
      if (state.caps.edit && state.provider?.openNote) state.provider.openNote(null);
      else openComposer('manual', create);
    });
    const daily = mk('button', 'ghost-btn', '今日笔记'); daily.type = 'button'; daily.disabled = !state.provider?.daily;
    daily.addEventListener('click', async () => { try { const item = await state.provider.daily(today()); merge(item); state.provider.openNote(item.id); } catch (error) { state.ctx?.toast?.(`创建失败：${error.message}`); } });
    const template = mk('button', 'ghost-btn', '从模板新建'); template.type = 'button'; template.disabled = !state.provider?.templates;
    template.addEventListener('click', () => openTemplateChooser(template));
    const focus = mk('button', 'ghost-btn', document.body.classList.contains('notes-focus') ? '退出专注' : '专注模式'); focus.type = 'button';
    focus.addEventListener('click', () => { document.body.classList.toggle('notes-focus'); render(); });
    first.append(seg, mk('span', 'spacer'), connection, capture, uploadButton, daily, template, focus, create);

    const second = mk('div', 'toolbar-row notes-filter-row');
    const search = mk('input', 'notes-search');
    search.type = 'search'; search.value = state.query;
    search.placeholder = state.caps.search ? '搜索笔记标题或正文' : '全文检索待 AI 智学接入';
    search.disabled = !state.provider || state.offline || !state.caps.search;
    search.addEventListener('input', () => { state.query = search.value.trim(); clearTimeout(renderToolbar.timer); renderToolbar.timer = setTimeout(refresh, 250); });
    const tags = mk('select', 'notes-tag-filter');
    tags.appendChild(option('', '全部标签', !state.tag));
    [...new Set(state.items.flatMap((item) => item.tags))].sort().forEach((tag) => tags.appendChild(option(tag, tag, tag === state.tag)));
    tags.addEventListener('change', () => { state.tag = tags.value; render(); });
    const sort = mk('select', 'notes-sort');
    [['updated', '最近更新'], ['created', '最近创建']].forEach(([value, label]) => sort.appendChild(option(value, label, value === state.sort)));
    sort.addEventListener('change', () => { state.sort = sort.value; render(); });
    const favorite = mk('button', `ghost-btn${state.filter === 'favorite' ? ' active' : ''}`, '★ 收藏'); favorite.type = 'button';
    favorite.addEventListener('click', () => { state.filter = state.filter === 'favorite' ? 'all' : 'favorite'; render(); });
    second.append(search, tags, sort, favorite);
    bar.append(first, second);
    host.appendChild(bar);
  }

  function renderList(host, items) {
    const list = mk('div', 'notes-list');
    if (state.loading && !items.length) list.appendChild(mk('div', 'loading', '正在读取笔记摘要…'));
    if (state.error) {
      const box = errorBox(state.error);
      const retry = mk('button', 'ghost-btn', '重新加载'); retry.type = 'button'; retry.addEventListener('click', refresh); box.appendChild(retry); list.appendChild(box);
    }
    if (!items.length && !state.loading) list.appendChild(emptyBox(state.provider ? '还没有笔记。可以新建笔记，或拍下内容交给 AI 智学整理。' : 'AI 智学主程序尚未连接。连接后可在这里浏览、创建并关联笔记。'));
    for (const item of items) {
      const card = mk('button', `notes-card${state.selected === item.id ? ' active' : ''}`); card.type = 'button';
      const head = mk('div', 'notes-card-head'); head.append(mk('span', 'notes-card-title', `${item.favorite ? '★ ' : ''}${item.title}`), pill(item));
      card.append(head, mk('div', 'notes-anchor', item.folder ? `${item.folder} · ${anchorText(item)}` : anchorText(item)));
      if (item.tags.length) { const tags = mk('div', 'notes-tags'); item.tags.slice(0, 4).forEach((tag) => tags.appendChild(mk('span', 'tag notes-tag', tag))); card.appendChild(tags); }
      card.appendChild(mk('div', 'notes-meta', `${SOURCE[item.source]} · ${item.mediaCount} 张图片 · ${formatTime(item.updatedAt)}`));
      const selectItem = (loadBody = true) => { state.selected = item.id; for (const node of list.querySelectorAll('.notes-card')) node.classList.toggle('active', node === card); host.querySelector('.notes-detail')?.remove(); renderDetail(host, item, loadBody); };
      card.addEventListener('click', () => selectItem(true));
      card.addEventListener('dblclick', () => open(item.id).catch((error) => state.ctx?.toast?.(`打开失败：${error.message}`)));
      card.addEventListener('contextmenu', (event) => {
        event.preventDefault(); event.stopPropagation?.(); selectItem(false); openNoteContextMenu(event, item, card);
      });
      card.title = '单击预览；双击编辑；右击管理笔记';
      list.appendChild(card);
    }
    host.appendChild(list);
  }

  async function openNoteViewer(item, trigger) {
    const mask = modal(`查看笔记 · ${item.title}`, trigger);
    const body = mask.querySelector('.modal-body');
    const foot = mask.querySelector('.modal-foot');
    const preview = mk('div', 'notes-note-viewer richtext');
    preview.appendChild(mk('div', 'loading', '正在由 AI 智学读取正文…'));
    body.appendChild(preview);
    const close = mk('button', 'ghost-btn', '关闭');
    close.type = 'button'; close.addEventListener('click', mask._close); foot.appendChild(close);
    try {
      const result = await read(item.id);
      preview.innerHTML = '';
      if (result.format === 'markdown' && window.PCRichText?.render) window.PCRichText.render(preview, result.text);
      else preview.textContent = result.text;
      if (result.attachments?.length) {
        const files = mk('div', 'notes-viewer-attachments');
        files.appendChild(mk('strong', '', '原始附件'));
        for (const file of result.attachments) {
          if ((file.type || '').startsWith('image/')) {
            const image = mk('img', 'notes-attachment-image'); image.src = file.dataUrl; image.alt = file.name; files.appendChild(image);
          } else if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')) {
            const object = mk('object', 'notes-attachment-pdf'); object.data = file.dataUrl; object.type = 'application/pdf'; object.setAttribute('aria-label', `PDF 预览：${file.name}`); files.appendChild(object);
          } else if (/\.(doc|ppt)$/i.test(file.name || '')) {
            files.appendChild(mk('p', 'notes-import-warning', '这是旧版 Office 格式，网页暂时不能提取正文，请下载原文件查看。'));
          }
          const link = mk('a', 'ghost-btn', `下载/打开 ${file.name}`);
          link.href = file.dataUrl; link.download = file.name; link.rel = 'noopener';
          files.appendChild(link);
        }
        body.appendChild(files);
      }
    } catch (reason) {
      preview.innerHTML = '';
      preview.appendChild(errorBox(`预览失败：${reason.message}`));
    }
  }

  function renderDetail(host, item, loadBody = false) {
    const detail = mk('div', 'notes-detail');
    if (!item) { detail.appendChild(emptyBox('选择一条笔记查看挂载信息。正文由 AI 智学主程序打开。')); host.appendChild(detail); return; }
    const head = mk('div', 'notes-detail-head'); head.append(mk('div', 'notes-detail-title', item.title), pill(item)); detail.appendChild(head);
    const preview = mk('div', 'notes-detail-preview richtext'); detail.appendChild(preview);
    const canRead = (state.caps.view && state.provider?.readNote) || (state.caps.markdown && state.provider?.renderMarkdown);
    if (!loadBody) preview.appendChild(mk('p', 'notes-preview-placeholder', item.previewText || '单击左侧笔记卡片预览正文；双击直接进入编辑。'));
    else if (!canRead || state.offline) preview.appendChild(mk('p', 'notes-preview-placeholder', item.previewText || '当前无法读取正文，可以双击笔记尝试打开。'));
    else {
      preview.appendChild(mk('div', 'loading', '正在读取笔记内容…'));
      read(item.id).then((result) => { if (!preview.parentNode || state.selected !== item.id) return; preview.innerHTML = ''; if (result.format === 'markdown' && window.PCRichText?.render) window.PCRichText.render(preview, result.text || '（空白笔记）'); else preview.textContent = result.text || '（空白笔记）'; }).catch((error) => { if (!preview.parentNode) return; preview.innerHTML = ''; preview.appendChild(errorBox(`预览失败：${error.message}`)); });
    }
    host.appendChild(detail);
  }

  function openNoteContextMenu(event, item, trigger) {
    document.body.querySelector('.notes-card-menu')?.remove();
    const menu = mk('div', 'notes-card-menu'); menu.setAttribute('role', 'menu');
    const viewportWidth = Number(window.innerWidth) || 1200; const viewportHeight = Number(window.innerHeight) || 800;
    menu.style.left = `${Math.max(8, Math.min(event.clientX || 8, viewportWidth - 308))}px`; menu.style.top = `${Math.max(8, Math.min(event.clientY || 8, viewportHeight - 628))}px`;
    const close = () => menu.remove();
    const action = (label, handler, className = '') => { const button = mk('button', className, label); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.addEventListener('click', async () => { try { await handler(); } catch (error) { state.ctx?.toast?.(`${label}失败：${error.message}`); } }); menu.appendChild(button); return button; };
    menu.append(mk('strong', 'notes-card-menu-title', item.title), mk('span', 'notes-card-menu-subtitle', `${item.folder || '未分类'} · ${STATUS[item.status] || item.status}`));
    action('编辑笔记', () => { close(); return open(item.id); }).disabled = !state.provider?.openNote || state.offline;
    action('查看或修改属性', () => { close(); openNoteProperties(item, trigger); });
    if (state.provider?.updateNote) action(item.favorite ? '取消收藏' : '收藏', async () => { close(); const next = await state.provider.updateNote(item.id, { favorite: !item.favorite, expectedUpdatedAt: item.updatedAt }); merge(next); render(); }).disabled = state.offline;
    if (state.caps.export && state.provider?.exportNote) action('导出 Markdown', () => { close(); return state.provider.exportNote(item.id, 'markdown'); });
    if (item.status === 'failed' && state.provider?.retryProcessing) action('重新识别', async () => { close(); await state.provider.retryProcessing(item.id); merge({ ...item, status: 'processing' }); render(); });
    const facts = mk('div', 'notes-card-menu-facts');
    for (const [label, value] of [['目录', item.folder || '未分类'], ['课程', item.properties?.course || '—'], ['类型', item.properties?.type || '普通笔记'], ['来源', SOURCE[item.source]], ['关联', anchorText(item)], ['知识链接', `${item.links?.length || 0} 条`], ['图片', `${item.mediaCount} 张`], ['创建', formatTime(item.createdAt)], ['更新', formatTime(item.updatedAt)]]) { const row = mk('div'); row.append(mk('span', '', label), mk('strong', '', value)); facts.appendChild(row); }
    menu.appendChild(facts);
    if (state.provider?.deleteNote) action('移至回收站', async () => { if (!confirm(`将“${item.title}”移到回收站？`)) return; close(); await state.provider.deleteNote(item.id); state.items = state.items.filter((one) => one.id !== item.id); state.selected = state.items[0]?.id ?? null; saveCache(); render(); }, 'danger').disabled = state.offline;
    document.body.appendChild(menu);
    const outside = (pointerEvent) => { if (pointerEvent.target?.closest?.('.notes-card-menu')) return; close(); document.removeEventListener?.('pointerdown', outside); };
    setTimeout(() => document.addEventListener?.('pointerdown', outside), 0); menu.querySelector('button')?.focus?.();
  }

  function modal(title, trigger) {
    const mask = mk('div', 'modal-mask'); const box = mk('div', 'modal notes-modal'); const head = mk('div', 'modal-head');
    const body = mk('div', 'modal-body'); const foot = mk('div', 'modal-foot');
    const close = () => { mask.remove(); trigger?.focus?.(); };
    head.append(mk('div', 'modal-title', title), iconBtn('关闭', '×', close)); box.append(head, body, foot); mask.appendChild(box); document.body.appendChild(mask); mask._close = close; return mask;
  }

  /**
   * 笔记属性归列表工作区管理：右击卡片即可查看和修改，不必先进入正文编辑器。
   * `properties` 可能含模板或未来版本写入的自定义键，保存时只覆盖界面负责的学习字段，
   * 其余键原样保留，避免一次属性编辑悄悄丢数据。
   */
  function openNoteProperties(item, trigger) {
    const mask = modal(`笔记属性 · ${item.title}`, trigger);
    const body = mask.querySelector('.modal-body');
    const foot = mask.querySelector('.modal-foot');
    mask.querySelector('.notes-modal')?.classList.add('notes-properties-modal');
    const editable = Boolean(state.provider?.updateNote) && !state.offline;

    const title = mk('input', 'notes-properties-title'); title.value = item.title;
    const tags = mk('input', 'notes-properties-tags'); tags.value = (item.tags || []).join('，'); tags.placeholder = '用逗号分隔';
    const folder = mk('input', 'notes-properties-folder'); folder.value = item.folder || ''; folder.placeholder = '例如：大二上/高等数学';
    const aliases = mk('input', 'notes-properties-aliases'); aliases.value = (item.aliases || []).join('，'); aliases.placeholder = '用逗号分隔';
    const workflow = mk('select', 'notes-properties-workflow');
    for (const [value, label] of Object.entries(STATUS)) workflow.appendChild(option(value, label, value === item.status));
    const course = mk('input', 'notes-properties-course'); course.value = item.properties?.course || '';
    const chapter = mk('input', 'notes-properties-chapter'); chapter.value = item.properties?.chapter || '';
    const type = mk('select', 'notes-properties-type');
    for (const value of ['', '课堂笔记', '错题', '实验报告', '论文阅读', '每日笔记']) type.appendChild(option(value, value || '普通笔记', value === (item.properties?.type || '')));
    const studyStatus = mk('select', 'notes-properties-study-status');
    for (const value of ['', '学习中', '待复习', '已掌握']) studyStatus.appendChild(option(value, value || '未设置', value === (item.properties?.status || '')));
    const mastery = mk('input', 'notes-properties-mastery'); mastery.type = 'number'; mastery.min = '0'; mastery.max = '5'; mastery.placeholder = '0–5'; mastery.value = item.properties?.mastery ?? '';
    const reviewDate = mk('input', 'notes-properties-review-date'); reviewDate.type = 'date'; reviewDate.value = item.properties?.reviewDate || '';
    const favorite = mk('input', 'notes-properties-favorite'); favorite.type = 'checkbox'; favorite.checked = Boolean(item.favorite);
    const favoriteLabel = mk('label', 'check-field notes-properties-favorite-field'); favoriteLabel.append(favorite, mk('span', '', '收藏这篇笔记'));
    const error = mk('div', 'modal-error hidden');
    const grid = mk('div', 'notes-properties-grid');
    grid.append(
      field('标题', title), field('笔记状态', workflow), field('标签', tags), field('目录', folder),
      field('别名', aliases), field('课程', course), field('章节', chapter), field('类型', type),
      field('学习进度', studyStatus), field('掌握程度', mastery), field('复习日期', reviewDate), favoriteLabel,
    );
    body.append(grid, mk('p', 'notes-properties-hint', editable ? '保存后列表、数据库视图和知识图谱会同步更新。' : '当前处于只读或离线状态，仅可查看属性。'), error);
    const inputs = [title, tags, folder, aliases, workflow, course, chapter, type, studyStatus, mastery, reviewDate, favorite];
    inputs.forEach((input) => { input.disabled = !editable; });

    const close = mk('button', 'ghost-btn', editable ? '取消' : '关闭'); close.type = 'button'; close.addEventListener('click', mask._close); foot.appendChild(close);
    if (!editable) return;
    const save = mk('button', 'primary-btn notes-properties-save', '保存属性'); save.type = 'button'; foot.appendChild(save);
    save.addEventListener('click', async () => {
      error.classList.add('hidden');
      const masteryValue = mastery.value === '' ? null : Number(mastery.value);
      if (masteryValue !== null && (!Number.isFinite(masteryValue) || masteryValue < 0 || masteryValue > 5)) {
        error.textContent = '掌握程度只能填写 0–5。'; error.classList.remove('hidden'); mastery.focus(); return;
      }
      save.disabled = close.disabled = true;
      try {
        const updated = await state.provider.updateNote(item.id, {
          title: title.value.trim() || '未命名笔记',
          status: workflow.value,
          tags: tags.value.split(/[,，]/).map((value) => value.trim()).filter(Boolean).slice(0, 24),
          folder: folder.value.trim(),
          aliases: aliases.value.split(/[,，]/).map((value) => value.trim()).filter(Boolean).slice(0, 20),
          favorite: favorite.checked,
          properties: {
            ...(item.properties || {}),
            course: course.value.trim(), chapter: chapter.value.trim(), type: type.value,
            status: studyStatus.value, mastery: masteryValue, reviewDate: reviewDate.value || null,
          },
          expectedUpdatedAt: item.updatedAt,
          versionReason: 'manual',
        });
        merge(updated); mask._close(); render(); state.ctx?.toast?.('笔记属性已保存');
      } catch (reason) {
        error.textContent = `保存失败：${reason.message}`; error.classList.remove('hidden'); save.disabled = close.disabled = false;
      }
    });
    title.focus();
  }

  function openComposer(source, trigger) {
    const capture = source === 'snapshot'; const importing = source === 'import';
    const mask = modal(capture ? '随手拍到笔记' : importing ? '手动上传笔记' : '新建笔记', trigger);
    const body = mask.querySelector('.modal-body'); const foot = mask.querySelector('.modal-foot');
    const title = mk('input', 'notes-title-input'); title.placeholder = '未命名笔记';
    const tags = mk('input', 'notes-tags-input'); tags.placeholder = '标签用逗号分隔';
    const files = mk('input', 'notes-file-input'); files.type = 'file'; files.multiple = !capture; files.accept = capture ? 'image/*' : IMPORT_ACCEPT; if (capture) files.setAttribute('capture', 'environment');
    const fileSummary = mk('div', 'notes-file-summary', capture ? '点击后拍照或从相册选择一张图片。' : '支持 Markdown、文本、PDF、DOCX、PPTX 和常见图片；最多 8 个文件，单个 6 MB。');
    const mode = mk('select', 'notes-anchor-mode'); mode.append(option('none', '不关联日历', true), option('date', '关联某一天'), option('schedule', '关联某条日程'));
    const date = mk('input', 'notes-anchor-date'); date.type = 'date'; date.value = today(); date.disabled = true;
    const schedules = mk('select', 'notes-schedule-select'); schedules.disabled = true; schedules.appendChild(option('', '请先选择日期'));
    const error = mk('div', 'modal-error hidden');
    if (importing || capture) body.append(field(capture ? '拍照或选择图片' : '选择文件', files), fileSummary);
    body.appendChild(field(importing || capture ? '笔记标题（可选）' : '标题', title));
    body.append(field('标签', tags), field('关联方式', mode), field('日期', date), field('日程', schedules), error);
    async function loadSchedules() {
      schedules.disabled = true; schedules.innerHTML = ''; schedules.appendChild(option('', '正在读取日程…'));
      try {
        const data = await state.ctx.api(`/calendar?from=${date.value}&to=${date.value}`); const items = data.days?.[0]?.schedules ?? [];
        schedules.innerHTML = ''; schedules.appendChild(option('', items.length ? '请选择具体日程' : '当天没有日程'));
        items.forEach((item) => schedules.appendChild(option(String(item.scheduleId ?? item.id), `${item.startTime ?? ''}${item.endTime ? `–${item.endTime}` : ''} ${item.title}`.trim())));
        schedules.disabled = !items.length;
      } catch (reason) { schedules.innerHTML = ''; schedules.appendChild(option('', '日历暂不可用')); error.textContent = `日历读取失败：${reason.message}。仍可不关联后继续。`; error.classList.remove('hidden'); }
    }
    mode.addEventListener('change', () => { date.disabled = mode.value === 'none'; if (mode.value === 'schedule') loadSchedules(); else schedules.disabled = true; });
    date.addEventListener('change', () => { if (mode.value === 'schedule') loadSchedules(); });
    const cancel = mk('button', 'ghost-btn', '取消'); cancel.type = 'button'; cancel.addEventListener('click', mask._close);
    const save = mk('button', 'primary-btn', capture ? '保存到笔记' : importing ? '上传并查看' : '创建并打开'); save.type = 'button'; save.disabled = importing || capture; foot.append(cancel, save);
    files.addEventListener('change', () => {
      const selected = Array.from(files.files ?? []); save.disabled = !selected.length;
      fileSummary.textContent = selected.length ? `已选择 ${selected.length} 个文件 · ${selected.map((file) => file.name).join('、')}` : '尚未选择文件';
    });
    save.addEventListener('click', async () => {
      let anchor = null;
      if (mode.value === 'date') anchor = { type: 'date', date: date.value };
      if (mode.value === 'schedule' && schedules.value) anchor = { type: 'schedule', scheduleId: schedules.value, occurrenceDate: date.value };
      save.disabled = cancel.disabled = true; error.classList.add('hidden');
      try {
        const input = { source, anchor, tags: tags.value.split(/[,，]/).map((v) => v.trim()).filter(Boolean), title: title.value.trim() };
        if (importing) {
          const items = await upload(files.files, input); files.value = ''; mask._close();
          if (items[0] && ((state.caps.view && state.provider?.readNote) || (state.caps.markdown && state.provider?.renderMarkdown))) await openNoteViewer(items[0], trigger);
          return;
        }
        if (capture) {
          const picked = Array.from(files.files ?? []); const size = Number(picked[0]?.size) || 0;
          if (!picked.length) throw new Error('请先拍照或选择一张图片');
          if (size > MAX_IMPORT_FILE_BYTES) throw new Error('图片超过 6 MB，请压缩后再试');
          input.files = picked;
        }
        const result = capture ? await state.provider.startCapture(input) : await state.provider.createDraft(input);
        if (!result) return mask._close();
        const item = merge({ ...result, source }); mask._close(); render();
        if (capture && state.provider.readNote) await openNoteViewer(item, trigger); else if (state.provider.openNote) await state.provider.openNote(item.id);
      } catch (reason) { error.textContent = reason.message; error.classList.remove('hidden'); save.disabled = cancel.disabled = false; }
    });
    title.focus();
  }

  async function openTemplateChooser(trigger) {
    const mask = modal('从模板新建笔记', trigger); const body = mask.querySelector('.modal-body'); const foot = mask.querySelector('.modal-foot');
    const select = mk('select'); const title = mk('input'); title.placeholder = '笔记标题'; const course = mk('input'); course.placeholder = '课程（可选）'; const folder = mk('input'); folder.placeholder = '目录（可选）';
    body.append(field('模板', select), field('标题', title), field('课程', course), field('目录', folder));
    const cancel = mk('button', 'ghost-btn', '取消'); cancel.type = 'button'; cancel.addEventListener('click', mask._close);
    const create = mk('button', 'primary-btn', '创建并编辑'); create.type = 'button'; create.disabled = true; foot.append(cancel, create);
    try {
      const templates = await state.provider.templates(); templates.forEach((item) => select.appendChild(option(item.id, item.name))); create.disabled = !templates.length;
    } catch (error) { body.appendChild(errorBox(`模板读取失败：${error.message}`)); }
    create.addEventListener('click', async () => {
      create.disabled = true;
      try { const item = await state.provider.instantiateTemplate(select.value, { title: title.value.trim(), course: course.value.trim(), folder: folder.value.trim(), properties: { course: course.value.trim() } }); merge(item); mask._close(); state.provider.openNote(item.id); }
      catch (error) { body.appendChild(errorBox(`创建失败：${error.message}`)); create.disabled = false; }
    });
  }

  function renderGraph(host) {
    const shell = mk('div', 'notes-special notes-graph-view');
    const controls = mk('div', 'notes-special-controls');
    const scope = mk('select'); [['local', '当前笔记 · 两层'], ['global', '全部笔记']].forEach(([value, label]) => scope.appendChild(option(value, label, value === state.graphScope)));
    scope.addEventListener('change', () => { state.graphScope = scope.value; state.graphData = null; render(); });
    const dimension = mk('select', 'notes-graph-dimension'); [['3d', '三维星系'], ['2d', '二维海洋']].forEach(([value, label]) => dimension.appendChild(option(value, label, value === state.graphDimension)));
    dimension.addEventListener('change', () => { state.graphDimension = dimension.value; state.graphPositions.clear(); state.graphCamera = { yaw: -0.45, pitch: 0.18, zoom: 1 }; render(); });
    const canvasButton = mk('button', 'ghost-btn', '将图谱放入 Canvas'); canvasButton.type = 'button'; canvasButton.disabled = !state.graphData?.nodes?.length;
    canvasButton.addEventListener('click', async () => {
      const nodes = state.graphData.nodes.map((node, index) => ({ id: `n-${node.id}`, type: 'file', noteId: node.id, x: 80 + index % 4 * 190, y: 70 + Math.floor(index / 4) * 130, width: 160, height: 84 }));
      const edges = state.graphData.edges.map((edge, index) => ({ id: `e-${index}`, fromNode: `n-${edge.source}`, toNode: `n-${edge.target}` }));
      const item = await state.provider.createCanvas({ name: `知识图谱 ${today()}`, nodes, edges }); state.canvasId = item.id; state.mode = 'canvas'; render();
    });
    controls.append(scope, dimension, canvasButton); shell.appendChild(controls);
    const layout = mk('div', 'notes-graph-layout'); const stage = mk('div', 'notes-graph-stage'); stage.appendChild(mk('div', 'loading', '正在生成知识图谱…')); layout.appendChild(stage); shell.appendChild(layout); host.appendChild(shell);
    if (state.graphData) { stage.innerHTML = ''; return drawGraph(stage, state.graphData, layout); }
    const filters = state.graphScope === 'local' && state.selected ? { id: state.selected, depth: 2 } : {};
    state.provider.graph(filters).then((data) => { if (state.mode !== 'graph') return; state.graphData = data; stage.innerHTML = ''; drawGraph(stage, data, layout); canvasButton.disabled = !data.nodes.length; }).catch((error) => { stage.innerHTML = ''; stage.appendChild(errorBox(`图谱读取失败：${error.message}`)); });
  }

  function drawGraph(stage, data, layout = stage.parentNode) {
    if (!data.nodes.length) return stage.appendChild(emptyBox('还没有知识链接。在正文中输入 [[另一篇笔记]] 后，关系会显示在这里。'));
    loadGraphStyles();
    const is2d = state.graphDimension === '2d';
    if (state.graphFrame !== null && window.cancelAnimationFrame) { window.cancelAnimationFrame(state.graphFrame); state.graphFrame = null; }
    stage.classList.add('notes-graph-space'); stage.classList.toggle('is-ocean', is2d);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 900 560'); svg.setAttribute('class', 'notes-graph-svg'); svg.setAttribute('aria-label', is2d ? '可漂流缩放的二维知识海洋' : '可旋转缩放的三维知识星系');
    const defs = document.createElementNS(svg.namespaceURI, 'defs'); defs.innerHTML = '<filter id="knowledge-glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'; svg.appendChild(defs);
    const hash = (text) => { let value = 2166136261; for (const char of String(text)) value = Math.imul(value ^ char.charCodeAt(0), 16777619); return value >>> 0; };
    const adjacency = new Map(data.nodes.map((node) => [node.id, new Set()])); for (const edge of data.edges || []) { adjacency.get(edge.source)?.add(edge.target); adjacency.get(edge.target)?.add(edge.source); }
    const mostConnected = [...data.nodes].sort((a, b) => (adjacency.get(b.id)?.size || 0) - (adjacency.get(a.id)?.size || 0))[0].id;
    const root = state.graphScope === 'local' && data.nodes.some((node) => node.id === state.selected) ? state.selected : mostConnected;
    const levels = new Map([[root, 0]]); const queue = [root]; while (queue.length) { const id = queue.shift(); for (const next of adjacency.get(id) || []) if (!levels.has(next)) { levels.set(next, levels.get(id) + 1); queue.push(next); } }
    const orbitingIds = new Set(levels.keys());
    const unlinkedLevel = Math.max(0, ...levels.values()) + 1; for (const node of data.nodes) if (!levels.has(node.id)) levels.set(node.id, unlinkedLevel);
    const stars = document.createElementNS(svg.namespaceURI, 'g'); stars.setAttribute('class', 'notes-graph-stars'); const starEls = []; for (let i = 0; i < 82; i += 1) { const star = document.createElementNS(svg.namespaceURI, 'circle'); const baseX = (i * 137.5 + 31) % 900; const baseY = (i * 83.7 + 19) % 560; star.setAttribute('cx', baseX); star.setAttribute('cy', baseY); star.setAttribute('r', i % 11 === 0 ? 1.25 : 0.65); star.setAttribute('opacity', 0.18 + (i % 5) * 0.1); stars.appendChild(star); starEls.push({ star, baseX, baseY, phase: i * 0.73 }); } svg.appendChild(stars);
    const graphLevels = [...new Set(levels.values())].sort((a, b) => a - b);
    const edgeLayer = document.createElementNS(svg.namespaceURI, 'g'); const edgeEls = []; for (const edge of data.edges || []) { const line = document.createElementNS(svg.namespaceURI, 'line'); line.setAttribute('class', 'notes-graph-edge'); edgeLayer.appendChild(line); edgeEls.push({ edge, line }); } svg.appendChild(edgeLayer);
    const nodeLayer = document.createElementNS(svg.namespaceURI, 'g'); const nodeEls = new Map(); const nodeIds = new Set(data.nodes.map((node) => node.id)); for (const id of [...state.graphPositions.keys()]) if (!nodeIds.has(id)) state.graphPositions.delete(id);
    const velocities = new Map(data.nodes.map((node) => [node.id, { x: 0, y: 0, z: 0 }]));
    const nodeColor = (id, level) => state.graphNodeStyles.get(id)?.color || state.graphLevelColors.get(level) || defaultGraphLevelColor(level);
    data.nodes.forEach((node, index) => {
      const level = levels.get(node.id) || 0; if (!state.graphPositions.has(node.id)) { const seed = hash(node.id); const angle = index * 2.399963229728653 + (seed % 1000) / 1000; const linked = orbitingIds.has(node.id); const shell = linked ? 78 + level * 58 + (seed % 21) : 175 + (seed % 48); const tilt = ((seed % 120) - 60) / 160; state.graphPositions.set(node.id, node.id === root ? { x: 0, y: 0, z: 0 } : { x: Math.cos(angle) * shell, y: is2d ? Math.sin(angle) * shell * 0.72 : Math.sin(angle * 1.37) * shell * (linked ? 0.52 : 0.38) + tilt * 20, z: is2d ? 0 : Math.sin(angle) * shell }); }
      const group = document.createElementNS(svg.namespaceURI, 'g'); group.setAttribute('class', `notes-graph-node notes-graph-level-${level}${node.id === state.selected ? ' active' : ''}`); group.setAttribute('tabindex', '0'); group.setAttribute('role', 'button'); group.setAttribute('aria-label', `预览笔记：${node.title}`); group.dataset.level = String(level); group.dataset.noteId = node.id; group.dataset.motion = node.id === root ? 'core' : orbitingIds.has(node.id) ? 'orbit' : 'drift';
      const degree = adjacency.get(node.id)?.size || 0; const size = 5.5 + Math.min(5, degree * 0.8) + (node.favorite ? 2 : 0); const color = nodeColor(node.id, level); const hit = document.createElementNS(svg.namespaceURI, 'circle'); hit.setAttribute('class', 'notes-graph-node-hit'); const halo = document.createElementNS(svg.namespaceURI, 'circle'); halo.setAttribute('class', 'notes-graph-node-halo'); halo.style.setProperty('fill', color); const circle = document.createElementNS(svg.namespaceURI, 'circle'); circle.setAttribute('r', size); circle.style.setProperty('fill', color); const text = document.createElementNS(svg.namespaceURI, 'text'); text.setAttribute('text-anchor', 'middle'); text.textContent = node.title.slice(0, 14); group.append(hit, halo, circle, text); nodeLayer.appendChild(group); nodeEls.set(node.id, { node, group, hit, halo, circle, text, size, level, phase: (hash(node.id) % 628) / 100 });
    }); svg.appendChild(nodeLayer); stage.appendChild(svg);
    const hint = mk('div', 'notes-graph-hint', is2d ? '二维海洋 · 核心居中 · 标签缓慢漂流 · 拖动标签 · 滚轮缩放' : '核心天体弹性拖动 · 相连标签柔性跟随并环绕 · 未连接标签漂浮 · 拖动空白旋转 · 滚轮缩放'); const hud = mk('div', 'notes-graph-hud'); const pause = mk('button', 'ghost-btn', is2d ? '暂停漂流' : '暂停公转'); const reset = mk('button', 'ghost-btn', '重置视角'); pause.type = reset.type = 'button'; hud.append(pause, reset); stage.append(hint, hud);
    const settings = state.graphSettings; const panel = mk('aside', 'notes-graph-controls'); panel.appendChild(mk('h3', '', '图谱参数'));
    const rangeControl = (label, key, min, max, step) => { const row = mk('label', 'notes-graph-control'); const head = mk('span', '', label); const value = mk('output', '', String(settings[key])); const input = mk('input'); input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = settings[key]; input.addEventListener('input', () => { settings[key] = Number(input.value); value.textContent = input.value; }); head.appendChild(value); row.append(head, input); panel.appendChild(row); };
    rangeControl('连线长度', 'edgeLength', 70, 240, 5); rangeControl('连线粗细', 'edgeWidth', 0.5, 5, 0.1); rangeControl('图谱排斥力', 'repulsion', 1000, 20000, 500); rangeControl(is2d ? '漂流幅度' : '摆动幅度', 'motion', 0, 2, 0.1);
    const selectControl = (label, key, options) => { const row = mk('label', 'notes-graph-control'); row.appendChild(mk('span', '', label)); const input = mk('select'); for (const [value, text] of options) input.appendChild(option(value, text, settings[key] === value)); input.addEventListener('change', () => { settings[key] = input.value; }); row.appendChild(input); panel.appendChild(row); };
    selectControl('连线样式', 'lineStyle', [['solid', '实线'], ['dashed', '虚线'], ['dotted', '点线']]); selectControl('连线颜色', 'edgeColor', [['blue', '蓝色'], ['green', '绿色'], ['purple', '紫色'], ['orange', '橙色'], ['gray', '灰色']]);
    const legend = mk('div', 'notes-graph-legend'); legend.appendChild(mk('strong', '', '关系层级（同层同色）')); for (const level of graphLevels) { const item = mk('label', 'notes-graph-legend-item'); item.dataset.level = String(level); const dot = mk('i'); const text = mk('span', '', level === 0 ? '核心' : `${level} 级关系`); const color = mk('input', 'notes-graph-level-color'); color.type = 'color'; color.value = state.graphLevelColors.get(level) || defaultGraphLevelColor(level); dot.style.setProperty('background', color.value); color.title = `自定义第 ${level} 层颜色`; color.addEventListener('input', () => setLevelColor(level, color.value)); item.append(dot, text, color); legend.appendChild(item); } panel.appendChild(legend); layout.appendChild(panel);
    const camera = state.graphCamera; const center = { x: 450, y: 280 }; let autoAngle = 0; let oceanTime = 0; let paused = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; let sceneDrag = null; let nodeDrag = null; let suppressUntil = 0; let lastTime = null; let preview = null;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value)); const rotatePoint = (point, yaw, pitch) => { const cy = Math.cos(yaw); const sy = Math.sin(yaw); const cp = Math.cos(pitch); const sp = Math.sin(pitch); const x = point.x * cy + point.z * sy; const z1 = -point.x * sy + point.z * cy; return { x, y: point.y * cp - z1 * sp, z: point.y * sp + z1 * cp }; };
    const project = (point, phase = 0, time = 0, id = '') => {
      const sway = Number(settings.motion) * (is2d ? 10 : 7); const isRoot = id === root;
      const oceanX = is2d ? (Math.sin(time * 0.0007 + phase) - Math.sin(phase)) * sway : isRoot ? 0 : Math.sin(time * 0.0007 + phase) * sway;
      const oceanY = is2d ? (Math.cos(time * 0.00055 + phase * 1.4) - Math.cos(phase * 1.4)) * sway * 0.72 : isRoot ? 0 : Math.cos(time * 0.00055 + phase * 1.4) * sway * 0.55;
      let moving = { x: point.x + oceanX, y: point.y + oceanY, z: is2d ? 0 : point.z + (isRoot ? 0 : Math.sin(time * 0.00045 + phase * 0.8) * sway) };
      if (is2d) return { x: center.x + moving.x * camera.zoom, y: center.y + moving.y * camera.zoom, z: 0, scale: camera.zoom };
      if (!isRoot && orbitingIds.has(id)) { const core = state.graphPositions.get(root) || { x: 0, y: 0, z: 0 }; const relative = { x: moving.x - core.x, y: moving.y - core.y, z: moving.z - core.z }; const orbited = rotatePoint(relative, autoAngle, 0); moving = { x: core.x + orbited.x, y: core.y + orbited.y, z: core.z + orbited.z }; }
      const rotated = rotatePoint(moving, camera.yaw, camera.pitch); const perspective = 680 / Math.max(360, 680 - rotated.z); return { x: center.x + rotated.x * perspective * camera.zoom, y: center.y + rotated.y * perspective * camera.zoom, z: rotated.z, scale: perspective * camera.zoom };
    };
    const projected = new Map();
    const simulate = (step) => {
      const entries = [...state.graphPositions.entries()]; for (let i = 0; i < entries.length; i += 1) for (let j = i + 1; j < entries.length; j += 1) { const [aId, a] = entries[i]; const [bId, b] = entries[j]; let dx = a.x - b.x; let dy = a.y - b.y; let dz = a.z - b.z; const dist2 = Math.max(100, dx * dx + dy * dy + dz * dz); const dist = Math.sqrt(dist2); const force = Number(settings.repulsion) / dist2 * 0.055 * step; dx /= dist; dy /= dist; dz /= dist; if (nodeDrag?.id !== aId) { const velocity = velocities.get(aId); velocity.x += dx * force; velocity.y += dy * force; velocity.z += dz * force; } if (nodeDrag?.id !== bId) { const velocity = velocities.get(bId); velocity.x -= dx * force; velocity.y -= dy * force; velocity.z -= dz * force; } }
      for (const edge of data.edges || []) { const a = state.graphPositions.get(edge.source); const b = state.graphPositions.get(edge.target); if (!a || !b) continue; let dx = b.x - a.x; let dy = b.y - a.y; let dz = b.z - a.z; const dist = Math.max(1, Math.hypot(dx, dy, dz)); const elasticBoost = nodeDrag?.id === root && (edge.source === root || edge.target === root) ? 2.2 : 1; const force = (dist - Number(settings.edgeLength)) * 0.0022 * elasticBoost * step; dx /= dist; dy /= dist; dz /= dist; if (nodeDrag?.id !== edge.source) { const velocity = velocities.get(edge.source); velocity.x += dx * force; velocity.y += dy * force; velocity.z += dz * force; } if (nodeDrag?.id !== edge.target) { const velocity = velocities.get(edge.target); velocity.x -= dx * force; velocity.y -= dy * force; velocity.z -= dz * force; } }
      const core = state.graphPositions.get(root) || { x: 0, y: 0, z: 0 };
      for (const [id, point] of entries) {
        if (nodeDrag?.id === id) continue;
        const velocity = velocities.get(id); const level = levels.get(id) || 0; const linked = orbitingIds.has(id); const relativeCore = !is2d && linked && id !== root;
        const origin = relativeCore ? core : { x: 0, y: 0, z: 0 }; const dx = point.x - origin.x; const dy = point.y - origin.y; const dz = is2d ? 0 : point.z - origin.z;
        const radius = Math.max(1, is2d ? Math.hypot(dx, dy) : Math.hypot(dx, dy, dz));
        const target = id === root ? (is2d ? 0 : Math.min(radius, 135)) : !linked ? 195 : 82 + Math.min(level, 6) * 44;
        const strength = id === root ? (is2d ? 0.00028 : 0.00016) : 0.0007; const radial = (radius - target) * strength * step;
        velocity.x -= dx / radius * radial; velocity.y -= dy / radius * radial; if (!is2d) velocity.z -= dz / radius * radial;
        else { velocity.x += Math.sin(oceanTime * 0.00023 + nodeEls.get(id)?.phase) * 0.003 * settings.motion * step; velocity.y += Math.cos(oceanTime * 0.00019 + nodeEls.get(id)?.phase) * 0.002 * settings.motion * step; velocity.z = 0; }
        velocity.x *= 0.9; velocity.y *= 0.9; velocity.z *= 0.9; point.x += velocity.x * step; point.y += velocity.y * step; point.z = is2d ? 0 : point.z + velocity.z * step;
      }
    };
    const update = (time = is2d ? oceanTime : Date.now()) => {
      center.x = 450 + (Number(camera.panX) || 0); center.y = 280 + (Number(camera.panY) || 0);
      projected.clear(); for (const [id, point] of state.graphPositions) projected.set(id, project(point, nodeEls.get(id)?.phase || 0, time, id));
      const edgeColor = { blue: 'var(--blue)', green: 'var(--green)', purple: 'var(--purple)', orange: 'var(--orange)', gray: 'var(--fg-3)' }[settings.edgeColor] || 'var(--blue)'; const dash = { dashed: '9 7', dotted: '2 7' }[settings.lineStyle] || '';
      for (const { edge, line } of edgeEls) { const from = projected.get(edge.source); const to = projected.get(edge.target); if (!from || !to) continue; line.setAttribute('x1', from.x); line.setAttribute('y1', from.y); line.setAttribute('x2', to.x); line.setAttribute('y2', to.y); line.setAttribute('opacity', clamp(0.15 + (Math.min(from.z, to.z) + 280) / 720, 0.12, 0.7)); line.style.setProperty('stroke', edgeColor); line.style.setProperty('stroke-width', String(settings.edgeWidth)); line.setAttribute('stroke-dasharray', dash); }
      for (const [id, item] of nodeEls) { const point = projected.get(id); if (!point) continue; const size = item.size * clamp(Number(state.graphNodeStyles.get(id)?.size) || 1, 0.5, 3); const depth = clamp((point.z + 300) / 600, 0, 1); item.hit.setAttribute('r', size + 15); item.halo.setAttribute('r', size + 6); item.circle.setAttribute('r', size); item.text.setAttribute('y', size + 14); item.group.setAttribute('transform', `translate(${point.x.toFixed(2)} ${point.y.toFixed(2)}) scale(${clamp(point.scale, 0.5, 1.75).toFixed(3)})`); item.group.setAttribute('opacity', (0.42 + depth * 0.58).toFixed(3)); }
      for (const item of starEls) { item.star.setAttribute('cx', item.baseX + Math.sin(time * 0.00032 + item.phase) * 3 * settings.motion); item.star.setAttribute('cy', item.baseY + Math.cos(time * 0.00027 + item.phase) * 2 * settings.motion); }
    };
    const showPreview = async (id, event = {}) => { preview?.remove(); const node = nodeEls.get(id)?.node; if (!node) return; const summary = state.items.find((item) => item.id === id) || { id, title: node.title, tags: [] }; preview = mk('section', 'notes-graph-preview'); const rect = stage.getBoundingClientRect?.() || { left: 0, top: 0, width: 900, height: 560 }; preview.style.left = `${clamp((event.clientX ?? rect.left + rect.width / 2) - rect.left + 12, 12, Math.max(12, (rect.width || 900) - 330))}px`; preview.style.top = `${clamp((event.clientY ?? rect.top + rect.height / 2) - rect.top + 12, 12, Math.max(12, (rect.height || 560) - 250))}px`; const close = mk('button', 'notes-graph-preview-close', '×'); close.type = 'button'; close.addEventListener('click', () => { preview?.remove(); preview = null; }); const head = mk('div', 'notes-graph-preview-head'); head.append(mk('strong', '', node.title), close); const content = mk('div', 'notes-graph-preview-content'); content.appendChild(mk('div', 'loading', '正在读取笔记内容…')); const actions = mk('div', 'notes-graph-preview-actions'); const detail = mk('button', 'ghost-btn', '查看详细笔记'); const edit = mk('button', 'primary-btn', '修改笔记'); detail.type = edit.type = 'button'; detail.addEventListener('click', () => openNoteViewer(summary, detail)); edit.addEventListener('click', () => state.provider.openNote?.(id)); actions.append(detail, edit); preview.append(head, content, actions); stage.appendChild(preview); try { const result = await read(id); content.innerHTML = ''; if (result.format === 'markdown' && window.PCRichText?.render) window.PCRichText.render(content, result.text); else content.textContent = result.text || '（空白笔记）'; } catch (error) { content.innerHTML = ''; content.appendChild(errorBox(`内容读取失败：${error.message}`)); } };
    const applyNodeColors = () => { for (const [id, item] of nodeEls) { const color = nodeColor(id, item.level); item.circle.style.setProperty('fill', color); item.halo.style.setProperty('fill', color); } };
    const setNodeStyle = (id, patch) => { const current = state.graphNodeStyles.get(id) || {}; const next = { ...current, ...patch }; if ((!next.color || next.color === '') && (!next.size || Number(next.size) === 1)) state.graphNodeStyles.delete(id); else state.graphNodeStyles.set(id, next); saveGraphStyles(); applyNodeColors(); update(); };
    const setLevelColor = (level, color = '') => { if (color) state.graphLevelColors.set(level, color); else state.graphLevelColors.delete(level); for (const [id, node] of nodeEls) if (node.level === level) { const style = state.graphNodeStyles.get(id); if (!style?.color) continue; const next = { ...style, color: '' }; if (!next.size || Number(next.size) === 1) state.graphNodeStyles.delete(id); else state.graphNodeStyles.set(id, next); } const resolved = color || defaultGraphLevelColor(level); for (const control of legend.querySelectorAll('.notes-graph-level-color')) if (Number(control.parentNode?.dataset?.level) === level) { control.value = resolved; control.parentNode?.querySelector?.('i')?.style?.setProperty('background', resolved); } saveGraphStyles(); applyNodeColors(); update(); };
    const openNodeMenu = (event, id) => {
      event.preventDefault?.(); event.stopPropagation?.(); stage.querySelector('.notes-graph-menu')?.remove(); preview?.remove(); preview = null;
      const item = nodeEls.get(id); if (!item) return;
      const menu = mk('div', 'notes-graph-menu'); menu.setAttribute('role', 'menu'); const rect = stage.getBoundingClientRect?.() || { left: 0, top: 0, width: 900, height: 560 };
      menu.style.left = `${clamp((event.clientX || rect.left) - rect.left + 8, 8, Math.max(8, (rect.width || 900) - 286))}px`; menu.style.top = `${clamp((event.clientY || rect.top) - rect.top + 8, 8, Math.max(8, (rect.height || 560) - 330))}px`;
      menu.append(mk('strong', 'notes-graph-menu-title', item.node.title), mk('span', 'notes-graph-menu-level', item.level === 0 ? '核心层级' : `第 ${item.level} 层关系`));
      const currentStyle = state.graphNodeStyles.get(id) || {}; const sizeRow = mk('label', 'notes-graph-menu-field'); const sizeHead = mk('span', '', '标签圆形大小'); const sizeValue = mk('output', '', `${Number(currentStyle.size) || 1}×`); const size = mk('input', 'notes-graph-node-size'); size.type = 'range'; size.min = '0.5'; size.max = '3'; size.step = '0.1'; size.value = String(Number(currentStyle.size) || 1); size.addEventListener('input', () => { sizeValue.textContent = `${size.value}×`; setNodeStyle(id, { size: Number(size.value) }); }); sizeHead.appendChild(sizeValue); sizeRow.append(sizeHead, size); menu.appendChild(sizeRow);
      const colorRow = mk('label', 'notes-graph-menu-field notes-graph-menu-color-field'); colorRow.appendChild(mk('span', '', '标签颜色')); const color = mk('input', 'notes-graph-node-color'); color.type = 'color'; color.value = nodeColor(id, item.level); color.addEventListener('input', () => setNodeStyle(id, { color: color.value })); colorRow.appendChild(color); menu.appendChild(colorRow);
      const actions = mk('div', 'notes-graph-menu-actions');
      const follow = mk('button', '', '跟随本层颜色'); follow.type = 'button'; follow.addEventListener('click', () => { setNodeStyle(id, { color: '' }); color.value = nodeColor(id, item.level); });
      const applyLevel = mk('button', '', `应用到第 ${item.level} 层全部标签`); applyLevel.type = 'button'; applyLevel.addEventListener('click', () => setLevelColor(item.level, color.value));
      const resetSize = mk('button', '', '恢复默认大小'); resetSize.type = 'button'; resetSize.addEventListener('click', () => { size.value = '1'; sizeValue.textContent = '1×'; setNodeStyle(id, { size: 1 }); });
      const resetLevel = mk('button', '', '恢复本层默认颜色'); resetLevel.type = 'button'; resetLevel.addEventListener('click', () => { setLevelColor(item.level); color.value = defaultGraphLevelColor(item.level); });
      actions.append(follow, applyLevel, resetSize, resetLevel); menu.appendChild(actions);
      const summary = state.items.find((note) => note.id === id); if (summary) { const properties = mk('button', 'notes-graph-menu-properties', '查看或修改笔记属性'); properties.type = 'button'; properties.addEventListener('click', () => { menu.remove(); openNoteProperties(summary, item.group); }); menu.appendChild(properties); }
      stage.appendChild(menu); size.focus?.();
    };
    const animate = (time) => { if (stage.parentNode && state.mode === 'graph') { const elapsed = lastTime === null ? 1 : Math.min(32, time - lastTime); if (!paused && !sceneDrag && !nodeDrag) { if (is2d) oceanTime += elapsed; else autoAngle += elapsed * 0.000055; } if (!sceneDrag && (!is2d || !paused)) simulate(elapsed / 16); lastTime = time; update(is2d ? oceanTime : time); state.graphFrame = window.requestAnimationFrame(animate); } else state.graphFrame = null; };
    update(is2d ? oceanTime : Date.now()); if (window.requestAnimationFrame) state.graphFrame = window.requestAnimationFrame(animate);
    const pauseText = () => paused ? (is2d ? '继续漂流' : '继续公转') : (is2d ? '暂停漂流' : '暂停公转'); pause.textContent = pauseText(); pause.addEventListener('click', () => { paused = !paused; pause.textContent = pauseText(); lastTime = null; }); reset.addEventListener('click', () => { camera.yaw = -0.45; camera.pitch = 0.18; camera.zoom = 1; camera.panX = 0; camera.panY = 0; autoAngle = 0; oceanTime = 0; lastTime = null; update(is2d ? oceanTime : Date.now()); });
    stage.addEventListener('wheel', (event) => { if (event.target?.closest?.('.notes-graph-preview')) return; event.preventDefault?.(); camera.zoom = clamp(camera.zoom * (event.deltaY > 0 ? 0.9 : 1.1), 0.48, 2.4); update(); }, { passive: false });
    const blocksSceneDrag = (target) => target?.closest?.('.notes-graph-node') || target?.closest?.('.notes-graph-hud') || target?.closest?.('.notes-graph-preview') || target?.closest?.('.notes-graph-menu');
    stage.addEventListener('dragstart', (event) => event.preventDefault?.()); stage.addEventListener('selectstart', (event) => event.preventDefault?.());
    let pinch = null;
    stage.addEventListener('touchstart', (event) => { if (event.touches?.length !== 2) return; const [a, b] = event.touches; pinch = { distance: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)), midX: (a.clientX + b.clientX) / 2, midY: (a.clientY + b.clientY) / 2, zoom: camera.zoom, panX: Number(camera.panX) || 0, panY: Number(camera.panY) || 0 }; sceneDrag = null; stage.classList.remove('is-rotating'); }, { passive: true });
    stage.addEventListener('touchmove', (event) => { if (!pinch || event.touches?.length !== 2) return; const [a, b] = event.touches; const distance = Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)); const midX = (a.clientX + b.clientX) / 2; const midY = (a.clientY + b.clientY) / 2; camera.zoom = clamp(pinch.zoom * distance / pinch.distance, 0.48, 2.4); camera.panX = pinch.panX + midX - pinch.midX; camera.panY = pinch.panY + midY - pinch.midY; event.preventDefault?.(); update(); }, { passive: false });
    const finishTouch = () => { pinch = null; }; stage.addEventListener('touchend', finishTouch, { passive: true }); stage.addEventListener('touchcancel', finishTouch, { passive: true });
    stage.addEventListener('pointerdown', (event) => { const menu = stage.querySelector('.notes-graph-menu'); if (menu && !event.target?.closest?.('.notes-graph-menu')) menu.remove(); if (event.button !== undefined && event.button !== 0) return; if (blocksSceneDrag(event.target) || pinch) return; event.preventDefault?.(); preview?.remove(); preview = null; sceneDrag = { x: event.clientX, y: event.clientY, yaw: camera.yaw, pitch: camera.pitch, panX: Number(camera.panX) || 0, panY: Number(camera.panY) || 0, moved: false, pointerId: event.pointerId }; stage.classList.add(is2d ? 'is-panning' : 'is-rotating'); stage.setPointerCapture?.(event.pointerId); });
    stage.addEventListener('pointermove', (event) => { if (!sceneDrag || pinch || (sceneDrag.pointerId !== undefined && event.pointerId !== undefined && event.pointerId !== sceneDrag.pointerId)) return; event.preventDefault?.(); const dx = event.clientX - sceneDrag.x; const dy = event.clientY - sceneDrag.y; if (Math.hypot(dx, dy) > 5) sceneDrag.moved = true; if (is2d) { camera.panX = sceneDrag.panX + dx; camera.panY = sceneDrag.panY + dy; } else { camera.yaw = sceneDrag.yaw + dx * 0.008; camera.pitch = clamp(sceneDrag.pitch - dy * 0.007, -1.25, 1.25); } update(); });
    const finishSceneDrag = (event = {}) => { if (!sceneDrag || (sceneDrag.pointerId !== undefined && event.pointerId !== undefined && event.pointerId !== sceneDrag.pointerId)) return; if (sceneDrag.moved) suppressUntil = Date.now() + 280; sceneDrag = null; stage.classList.remove('is-rotating'); stage.classList.remove('is-panning'); lastTime = null; }; stage.addEventListener('pointerup', finishSceneDrag); stage.addEventListener('pointercancel', finishSceneDrag); stage.addEventListener('lostpointercapture', finishSceneDrag);
    for (const [id, item] of nodeEls) {
      item.group.addEventListener('keydown', (event) => { if (event.key === 'Enter') showPreview(id); });
      item.group.addEventListener('contextmenu', (event) => openNodeMenu(event, id));
      wireLongPress(item.group, (event) => openNodeMenu(event, id));
      item.group.addEventListener('pointerdown', (event) => { if (event.button !== undefined && event.button !== 0) return; event.preventDefault?.(); event.stopPropagation?.(); preview?.remove(); preview = null; const original = state.graphPositions.get(id); const rect = svg.getBoundingClientRect?.() || { width: 900, height: 560 }; const viewportScale = Math.max(0.01, Math.min((rect.width || 900) / 900, (rect.height || 560) / 560)); nodeDrag = { id, x: event.clientX, y: event.clientY, original: { ...original }, moved: false, event, pointerId: event.pointerId, yaw: camera.yaw + (!is2d && id !== root && orbitingIds.has(id) ? autoAngle : 0), pitch: camera.pitch, projectedScale: Math.max(0.2, projected.get(id)?.scale || camera.zoom), viewportScale }; item.group.classList.add('is-dragging'); item.group.setPointerCapture?.(event.pointerId); });
      item.group.addEventListener('pointermove', (event) => { if (!nodeDrag || nodeDrag.id !== id || (nodeDrag.pointerId !== undefined && event.pointerId !== undefined && event.pointerId !== nodeDrag.pointerId)) return; event.preventDefault?.(); const screenDx = event.clientX - nodeDrag.x; const screenDy = event.clientY - nodeDrag.y; if (Math.hypot(screenDx, screenDy) <= 3) return; nodeDrag.moved = true; const dx = screenDx / nodeDrag.viewportScale / nodeDrag.projectedScale; const dy = screenDy / nodeDrag.viewportScale / nodeDrag.projectedScale; let next; if (is2d) next = { x: nodeDrag.original.x + dx, y: nodeDrag.original.y + dy, z: 0 }; else { const cy = Math.cos(nodeDrag.yaw); const sy = Math.sin(nodeDrag.yaw); const cp = Math.cos(nodeDrag.pitch); const sp = Math.sin(nodeDrag.pitch); const worldDx = dx * cy + dy * sp * sy; const worldDy = dy * cp; const worldDz = dx * sy - dy * sp * cy; next = { x: nodeDrag.original.x + worldDx, y: nodeDrag.original.y + worldDy, z: nodeDrag.original.z + worldDz }; } const limit = !is2d && id === root ? 180 : !orbitingIds.has(id) ? 255 : 330; const radius = Math.hypot(next.x, next.y, next.z); if (radius > limit) { next.x *= limit / radius; next.y *= limit / radius; next.z *= limit / radius; } state.graphPositions.set(id, next); update(is2d ? oceanTime : Date.now()); });
      const finishNodeDrag = (event = {}) => { if (!nodeDrag || nodeDrag.id !== id || (nodeDrag.pointerId !== undefined && event.pointerId !== undefined && event.pointerId !== nodeDrag.pointerId)) return; const wasMoved = nodeDrag.moved; nodeDrag = null; item.group.classList.remove('is-dragging'); lastTime = null; if (wasMoved) suppressUntil = Date.now() + 280; else if (Date.now() >= suppressUntil) showPreview(id, event); }; item.group.addEventListener('pointerup', finishNodeDrag); item.group.addEventListener('lostpointercapture', (event) => { if (nodeDrag?.id === id) finishNodeDrag(event); }); item.group.addEventListener('pointercancel', (event) => finishNodeDrag(event));
    }
  }

  function renderBases(host) {
    const shell = mk('div', 'notes-special notes-bases'); const controls = mk('div', 'notes-special-controls');
    for (const [layout, label] of [['table', '表格'], ['cards', '卡片'], ['kanban', '看板']]) { const button = mk('button', `ghost-btn${state.baseLayout === layout ? ' active' : ''}`, label); button.type = 'button'; button.addEventListener('click', () => { state.baseLayout = layout; render(); }); controls.appendChild(button); }
    for (const [label, query, layout] of [['待复习', 'status:待复习', 'kanban'], ['按课程', '', 'table'], ['最近修改', '', 'cards'], ['错题', 'type:错题', 'kanban']]) {
      const preset = mk('button', 'ghost-btn', label); preset.type = 'button'; preset.addEventListener('click', async () => { state.query = query; state.baseLayout = layout; await refresh(); }); controls.appendChild(preset);
    }
    const saveView = mk('button', 'ghost-btn', '保存当前视图'); saveView.type = 'button'; saveView.addEventListener('click', async () => { const name = prompt('视图名称', '我的笔记视图'); if (!name) return; await state.provider.createView({ name, layout: state.baseLayout, filters: { query: state.query, tag: state.tag }, sort: state.sort }); state.ctx?.toast?.('视图已保存'); }); controls.appendChild(saveView);
    shell.appendChild(controls); const items = visibleItems();
    if (state.baseLayout === 'table') {
      const wrap = mk('div', 'notes-base-table-wrap'); const table = document.createElement('table'); table.className = 'notes-base-table'; table.innerHTML = '<thead><tr><th>标题</th><th>课程</th><th>类型</th><th>状态</th><th>复习日期</th><th>更新</th></tr></thead>'; const tbody = document.createElement('tbody');
      for (const item of items) { const tr = document.createElement('tr'); for (const value of [item.title, item.properties?.course || '—', item.properties?.type || '普通笔记', item.properties?.status || '—', item.properties?.reviewDate || '—', formatTime(item.updatedAt)]) { const td = document.createElement('td'); td.textContent = value; tr.appendChild(td); } tr.addEventListener('click', () => state.provider.openNote(item.id)); tbody.appendChild(tr); } table.appendChild(tbody); wrap.appendChild(table); shell.appendChild(wrap);
    } else if (state.baseLayout === 'cards') {
      const cards = mk('div', 'notes-base-cards'); for (const item of items) { const card = mk('button', 'notes-base-card'); card.type = 'button'; card.append(mk('strong', '', item.title), mk('span', '', item.properties?.course || item.folder || '未分类'), mk('p', '', item.previewText || '空白笔记')); card.addEventListener('click', () => state.provider.openNote(item.id)); cards.appendChild(card); } shell.appendChild(cards);
    } else {
      const board = mk('div', 'notes-kanban'); const groups = new Map(); for (const item of items) { const key = item.properties?.status || '未设置'; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); }
      for (const [name, group] of groups) { const column = mk('section', 'notes-kanban-column'); column.appendChild(mk('h3', '', `${name} · ${group.length}`)); for (const item of group) { const card = mk('button', 'notes-kanban-card', item.title); card.type = 'button'; card.addEventListener('click', () => state.provider.openNote(item.id)); column.appendChild(card); } board.appendChild(column); } shell.appendChild(board);
    }
    host.appendChild(shell);
  }

  function renderCanvas(host) {
    const shell = mk('div', 'notes-special notes-canvas-view'); const controls = mk('div', 'notes-special-controls'); const select = mk('select'); const create = mk('button', 'ghost-btn', '+ 新建画布'); const removeCanvas = mk('button', 'ghost-btn danger', '删除当前画布'); const add = mk('button', 'ghost-btn', '添加笔记'); const addText = mk('button', 'ghost-btn', '文本卡片'); const addGroup = mk('button', 'ghost-btn', '分组'); const connect = mk('button', 'ghost-btn', '连接选中节点');
    controls.append(select, create, removeCanvas, add, addText, addGroup, connect); shell.appendChild(controls); const board = mk('div', 'notes-canvas-board'); shell.appendChild(board); host.appendChild(shell);
    async function persist(canvas, patch) {
      Object.assign(canvas, patch);
      const updated = await state.provider.updateCanvas(canvas.id, patch);
      Object.assign(canvas, updated || {}); paint(canvas); return canvas;
    }
    const localDesign = (canvas, node) => {
      const related = (canvas.edges || []).filter((edge) => edge.fromNode === node.id || edge.toNode === node.id).length;
      return {
        shape: node.type === 'group' ? 'rounded' : related > 2 ? 'pill' : 'rounded', color: node.type === 'file' ? 'blue' : node.type === 'group' ? 'gray' : 'purple',
        lineType: related > 2 ? 'curve' : 'elbow', lineStyle: 'solid', lineColor: 'blue', lineWidth: 2, arrow: 'end',
        advice: related > 3 ? '这张卡片连接较多，建议把它放在画布中央，并把相近主题放入同一分组，减少交叉连线。' : '建议按“核心概念 → 分支主题 → 细节笔记”的方向排列，并为同类卡片使用一致颜色。',
      };
    };
    function showDesignSuggestion(canvas, node) {
      const mask = modal('AI 美化与画布建议'); const body = mask.querySelector('.modal-body'); const foot = mask.querySelector('.modal-foot'); const loading = mk('div', 'notes-canvas-ai-loading', 'AI 正在分析卡片与画布结构…'); body.appendChild(loading);
      const renderSuggestion = (suggestion, source) => {
        body.innerHTML = ''; const preview = mk('div', `notes-canvas-ai-preview notes-canvas-shape-${suggestion.shape} notes-canvas-color-${suggestion.color}`, node.text || '卡片预览');
        body.append(preview, mk('div', 'notes-canvas-ai-source', source), mk('p', 'notes-canvas-ai-advice', suggestion.advice));
        const detail = mk('div', 'notes-canvas-ai-detail', `卡片：${suggestion.shape} / ${suggestion.color}　连线：${suggestion.lineType} / ${suggestion.lineStyle} / ${suggestion.arrow}`); body.appendChild(detail);
        const cancel = mk('button', 'ghost-btn', '暂不应用'); const apply = mk('button', 'primary-btn', '应用此方案'); cancel.type = apply.type = 'button'; cancel.addEventListener('click', () => mask._close()); apply.addEventListener('click', async () => {
          node.shape = suggestion.shape; node.color = suggestion.color;
          for (const edge of canvas.edges || []) if (edge.fromNode === node.id || edge.toNode === node.id) Object.assign(edge, { lineType: suggestion.lineType, lineStyle: suggestion.lineStyle, lineColor: suggestion.lineColor, lineWidth: suggestion.lineWidth, arrow: suggestion.arrow });
          mask._close(); await persist(canvas, { nodes: canvas.nodes, edges: canvas.edges }); state.ctx?.toast?.('AI 美化方案已应用');
        }); foot.append(cancel, apply);
      };
      Promise.resolve(state.provider.suggestCanvasDesign?.(canvas.id, node.id)).then((result) => renderSuggestion(result?.suggestion || localDesign(canvas, node), result?.model ? `AI 建议 · ${result.model}` : '本地智能建议')).catch(() => renderSuggestion(localDesign(canvas, node), 'AI 暂不可用 · 已生成本地智能建议'));
    }
    function contextMenu(event, canvas, node) {
      event.preventDefault(); event.stopPropagation?.(); board.querySelector('.notes-canvas-menu')?.remove();
      state.canvasSelected.clear(); state.canvasSelected.add(node.id);
      const menu = mk('div', 'notes-canvas-menu'); menu.setAttribute('role', 'menu');
      const rect = board.getBoundingClientRect?.() ?? { left: 0, top: 0 };
      menu.style.left = `${Math.max(8, (event.clientX || 0) - rect.left + (board.scrollLeft || 0))}px`;
      menu.style.top = `${Math.max(8, (event.clientY || 0) - rect.top + (board.scrollTop || 0))}px`;
      const close = () => menu.remove();
      const action = (label, callback, className = '') => {
        const button = mk('button', className, label); button.type = 'button'; button.setAttribute('role', 'menuitem');
        button.addEventListener('click', async (clickEvent) => { clickEvent.stopPropagation?.(); close(); await callback(); }); menu.appendChild(button);
      };
      if (node.type === 'file') action('打开原笔记', () => state.provider.openNote(node.noteId));
      action('AI 美化与画布建议', () => showDesignSuggestion(canvas, node), 'ai-action');
      action('编辑卡片标题', async () => { const text = prompt('卡片标题', node.text || (node.type === 'file' ? state.items.find((item) => item.id === node.noteId)?.title : '') || ''); if (text !== null) { node.text = text.trim(); await persist(canvas, { nodes: canvas.nodes }); } });
      action('复制卡片', async () => { const copy = { ...node, id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, x: (node.x || 20) + 32, y: (node.y || 20) + 32 }; await persist(canvas, { nodes: [...(canvas.nodes || []), copy] }); });
      const shapeLabel = mk('div', 'notes-canvas-menu-label', '形状'); menu.appendChild(shapeLabel);
      const shapes = mk('div', 'notes-canvas-menu-options');
      for (const [value, label] of [['rounded', '圆角'], ['square', '方形'], ['pill', '胶囊'], ['hexagon', '六边形']]) {
        const button = mk('button', node.shape === value || (!node.shape && value === 'rounded') ? 'active' : '', label); button.type = 'button'; button.title = label;
        button.addEventListener('click', async () => { close(); node.shape = value; await persist(canvas, { nodes: canvas.nodes }); }); shapes.appendChild(button);
      }
      menu.appendChild(shapes);
      const colorLabel = mk('div', 'notes-canvas-menu-label', '颜色'); menu.appendChild(colorLabel);
      const colors = mk('div', 'notes-canvas-menu-colors');
      for (const value of ['blue', 'green', 'yellow', 'red', 'purple', 'gray']) {
        const button = mk('button', `notes-canvas-color-${value}${node.color === value ? ' active' : ''}`); button.type = 'button'; button.title = value; button.setAttribute('aria-label', `设为${value}`);
        button.addEventListener('click', async () => { close(); node.color = value; await persist(canvas, { nodes: canvas.nodes }); }); colors.appendChild(button);
      }
      menu.appendChild(colors);
      action('删除卡片', async () => {
        if (!confirm('从画布中删除这张卡片？原始笔记不会被删除。')) return;
        const nodes = (canvas.nodes || []).filter((item) => item.id !== node.id);
        const edges = (canvas.edges || []).filter((edge) => edge.fromNode !== node.id && edge.toNode !== node.id);
        state.canvasSelected.delete(node.id); await persist(canvas, { nodes, edges });
      }, 'danger');
      board.appendChild(menu); menu.querySelector('button')?.focus?.();
    }
    function edgeContextMenu(event, canvas, edge) {
      event.preventDefault(); event.stopPropagation?.(); board.querySelector('.notes-canvas-menu')?.remove();
      const menu = mk('div', 'notes-canvas-menu notes-canvas-edge-menu'); menu.setAttribute('role', 'menu'); const rect = board.getBoundingClientRect?.() ?? { left: 0, top: 0 };
      menu.style.left = `${Math.max(8, (event.clientX || 0) - rect.left + (board.scrollLeft || 0))}px`; menu.style.top = `${Math.max(8, (event.clientY || 0) - rect.top + (board.scrollTop || 0))}px`;
      const close = () => menu.remove();
      const choices = (title, key, items, fallback) => {
        menu.appendChild(mk('div', 'notes-canvas-menu-label', title)); const row = mk('div', 'notes-canvas-menu-options');
        for (const [value, label] of items) { const button = mk('button', (edge[key] || fallback) === value ? 'active' : '', label); button.type = 'button'; button.title = label; button.addEventListener('click', async () => { close(); edge[key] = value; await persist(canvas, { edges: canvas.edges }); }); row.appendChild(button); }
        menu.appendChild(row);
      };
      choices('线型', 'lineType', [['curve', '曲线'], ['straight', '直线'], ['elbow', '折线']], 'curve');
      choices('样式', 'lineStyle', [['solid', '实线'], ['dashed', '虚线'], ['dotted', '点线']], 'solid');
      choices('粗细', 'lineWidth', [[2, '细'], [3.5, '中'], [5, '粗']], 2);
      choices('箭头', 'arrow', [['none', '无'], ['end', '单向'], ['both', '双向']], 'end');
      menu.appendChild(mk('div', 'notes-canvas-menu-label', '颜色')); const colors = mk('div', 'notes-canvas-menu-colors');
      for (const value of ['blue', 'green', 'yellow', 'red', 'purple', 'gray']) { const button = mk('button', `notes-canvas-color-${value}${(edge.lineColor || 'blue') === value ? ' active' : ''}`); button.type = 'button'; button.title = value; button.addEventListener('click', async () => { close(); edge.lineColor = value; await persist(canvas, { edges: canvas.edges }); }); colors.appendChild(button); } menu.appendChild(colors);
      const remove = mk('button', 'danger', '删除连接线'); remove.type = 'button'; remove.setAttribute('role', 'menuitem'); remove.addEventListener('click', async () => { close(); if (!confirm('删除这条连接线？卡片和原始笔记都会保留。')) return; await persist(canvas, { edges: (canvas.edges || []).filter((item) => item !== edge) }); }); menu.appendChild(remove);
      board.appendChild(menu); menu.querySelector('button')?.focus?.();
    }
    const paint = (canvas) => {
      board.innerHTML = ''; if (!canvas) return board.appendChild(emptyBox('新建一个 Canvas，把笔记拖到二维空间中整理思路。'));
      const noteMap = new Map(state.items.map((item) => [item.id, item]));
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'notes-canvas-lines'); const nodesById = new Map((canvas.nodes || []).map((node) => [node.id, node])); const edgePaths = [];
      const defs = document.createElementNS(svg.namespaceURI, 'defs'); const marker = document.createElementNS(svg.namespaceURI, 'marker'); const markerId = `canvas-arrow-${String(canvas.id).replace(/[^a-z\d_-]/gi, '')}`; marker.setAttribute('id', markerId); marker.setAttribute('viewBox', '0 0 10 10'); marker.setAttribute('refX', '9'); marker.setAttribute('refY', '5'); marker.setAttribute('markerWidth', '6'); marker.setAttribute('markerHeight', '6'); marker.setAttribute('orient', 'auto-start-reverse'); const arrow = document.createElementNS(svg.namespaceURI, 'path'); arrow.setAttribute('d', 'M 0 1 L 9 5 L 0 9 z'); arrow.setAttribute('class', 'notes-canvas-arrow'); arrow.setAttribute('fill', 'context-stroke'); marker.appendChild(arrow); defs.appendChild(marker); svg.appendChild(defs);
      const dimensions = (node) => ({ x: Number(node.x) || 20, y: Number(node.y) || 20, width: Number(node.width) || (node.type === 'group' ? 360 : 170), height: Number(node.height) || (node.type === 'group' ? 220 : 84) });
      const edgePath = (edge, fromNode, toNode) => {
        const from = dimensions(fromNode); const to = dimensions(toNode); const fc = { x: from.x + from.width / 2, y: from.y + from.height / 2 }; const tc = { x: to.x + to.width / 2, y: to.y + to.height / 2 }; const dx = tc.x - fc.x; const dy = tc.y - fc.y;
        let start; let end; let c1; let c2;
        if (Math.abs(dx) >= Math.abs(dy)) {
          const direction = dx >= 0 ? 1 : -1; start = { x: fc.x + direction * from.width / 2, y: fc.y }; end = { x: tc.x - direction * to.width / 2, y: tc.y }; const bend = Math.max(48, Math.min(180, Math.abs(dx) * 0.45)); c1 = { x: start.x + direction * bend, y: start.y }; c2 = { x: end.x - direction * bend, y: end.y };
        } else {
          const direction = dy >= 0 ? 1 : -1; start = { x: fc.x, y: fc.y + direction * from.height / 2 }; end = { x: tc.x, y: tc.y - direction * to.height / 2 }; const bend = Math.max(48, Math.min(180, Math.abs(dy) * 0.45)); c1 = { x: start.x, y: start.y + direction * bend }; c2 = { x: end.x, y: end.y - direction * bend };
        }
        if (edge.lineType === 'straight') return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
        if (edge.lineType === 'elbow') return Math.abs(dx) >= Math.abs(dy) ? `M ${start.x} ${start.y} L ${(start.x + end.x) / 2} ${start.y} L ${(start.x + end.x) / 2} ${end.y} L ${end.x} ${end.y}` : `M ${start.x} ${start.y} L ${start.x} ${(start.y + end.y) / 2} L ${end.x} ${(start.y + end.y) / 2} L ${end.x} ${end.y}`;
        return `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
      };
      for (const edge of canvas.edges || []) {
        const from = nodesById.get(edge.fromNode); const to = nodesById.get(edge.toNode); if (!from || !to) continue;
        const halo = document.createElementNS(svg.namespaceURI, 'path'); halo.setAttribute('class', 'notes-canvas-edge-halo'); const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('class', 'notes-canvas-edge'); const hit = document.createElementNS(svg.namespaceURI, 'path'); hit.setAttribute('class', 'notes-canvas-edge-hit'); hit.addEventListener('contextmenu', (event) => edgeContextMenu(event, canvas, edge)); wireLongPress(hit, (event) => edgeContextMenu(event, canvas, edge)); edgePaths.push({ edge, from, to, halo, path, hit }); svg.append(halo, path, hit);
      }
      const updateEdges = () => { for (const entry of edgePaths) { const { edge, path } = entry; const d = edgePath(edge, entry.from, entry.to); const color = { blue: 'var(--blue)', green: 'var(--green)', yellow: 'var(--orange)', red: 'var(--red)', purple: 'var(--purple)', gray: 'var(--fg-3)' }[edge.lineColor] || 'var(--blue)'; const dash = { dashed: '10 7', dotted: '2 7' }[edge.lineStyle] || ''; for (const item of [entry.halo, path, entry.hit]) item.setAttribute('d', d); path.style.setProperty('stroke', color); path.style.setProperty('stroke-width', String([2, 3.5, 5].includes(Number(edge.lineWidth)) ? Number(edge.lineWidth) : 2)); path.setAttribute('stroke-dasharray', dash); path.setAttribute('marker-start', edge.arrow === 'both' ? `url(#${markerId})` : ''); path.setAttribute('marker-end', edge.arrow === 'none' ? '' : `url(#${markerId})`); } };
      updateEdges(); board.appendChild(svg);
      for (const node of canvas.nodes || []) {
        const shape = ['rounded', 'square', 'pill', 'hexagon'].includes(node.shape) ? node.shape : 'rounded'; const color = ['blue', 'green', 'yellow', 'red', 'purple', 'gray'].includes(node.color) ? node.color : 'blue';
        const card = mk('div', `notes-canvas-node notes-canvas-${node.type || 'text'} notes-canvas-shape-${shape} notes-canvas-color-${color}${state.canvasSelected.has(node.id) ? ' selected' : ''}`);
        card.style.left = `${node.x || 20}px`; card.style.top = `${node.y || 20}px`; card.style.width = `${node.width || (node.type === 'group' ? 360 : 170)}px`; card.style.height = `${node.height || (node.type === 'group' ? 220 : 84)}px`; card.style.zIndex = String(Number(node.z) || (node.type === 'group' ? 0 : 1));
        card.appendChild(mk('span', 'notes-canvas-node-content', node.text || (node.type === 'file' ? noteMap.get(node.noteId)?.title || '缺失笔记' : node.type === 'group' ? '分组' : '文本卡片'))); card.tabIndex = 0; card.title = '右击管理卡片';
        if (node.type === 'file') card.addEventListener('dblclick', () => state.provider.openNote(node.noteId));
        card.addEventListener('contextmenu', (event) => contextMenu(event, canvas, node));
        wireLongPress(card, (event) => contextMenu(event, canvas, node));
        card.addEventListener('click', () => { if (state.canvasSelected.has(node.id)) state.canvasSelected.delete(node.id); else state.canvasSelected.add(node.id); paint(canvas); });
        let drag = null; card.addEventListener('pointerdown', (event) => { if (event.button === 2) return; drag = { x: event.clientX, y: event.clientY, left: node.x || 20, top: node.y || 20 }; card.setPointerCapture?.(event.pointerId); });
        card.addEventListener('pointermove', (event) => { if (!drag) return; node.x = drag.left + event.clientX - drag.x; node.y = drag.top + event.clientY - drag.y; card.style.left = `${node.x}px`; card.style.top = `${node.y}px`; updateEdges(); });
        card.addEventListener('pointerup', () => { if (!drag) return; drag = null; state.provider.updateCanvas(canvas.id, { nodes: canvas.nodes }).then(() => paint(canvas)); }); board.appendChild(card);
      }
    };
    board.addEventListener('pointerdown', (event) => { const menu = board.querySelector('.notes-canvas-menu'); if (menu && !menu.contains?.(event.target)) menu.remove(); });
    state.provider.listCanvases().then((items) => { state.canvases = items; state.canvasId ||= items[0]?.id ?? null; removeCanvas.disabled = !state.canvasId; select.innerHTML = ''; select.appendChild(option('', items.length ? '选择画布' : '暂无画布')); items.forEach((item) => select.appendChild(option(item.id, item.name, item.id === state.canvasId))); paint(items.find((item) => item.id === state.canvasId)); });
    select.addEventListener('change', () => { state.canvasId = select.value; paint(state.canvases.find((item) => item.id === state.canvasId)); });
    create.type = add.type = 'button'; create.addEventListener('click', async () => { const item = await state.provider.createCanvas({ name: `新画布 ${state.canvases.length + 1}`, nodes: [], edges: [] }); state.canvasId = item.id; render(); });
    removeCanvas.type = 'button'; removeCanvas.disabled = true; removeCanvas.addEventListener('click', async () => { const canvas = state.canvases.find((item) => item.id === state.canvasId); if (!canvas || !confirm(`删除画布“${canvas.name}”？画布中的原始笔记不会被删除。`)) return; await state.provider.deleteCanvas(canvas.id); state.canvases = state.canvases.filter((item) => item.id !== canvas.id); state.canvasId = state.canvases[0]?.id ?? null; state.canvasSelected.clear(); render(); });
    add.addEventListener('click', async () => {
      const mask = modal('添加笔记到画布', add); const body = mask.querySelector('.modal-body'); const search = mk('input', 'notes-canvas-note-search'); search.type = 'search'; search.placeholder = '搜索笔记标题、标签或目录'; const list = mk('div', 'notes-canvas-note-picker'); body.append(search, list);
      let items; try { items = await state.provider.listNotes({ limit: 500 }); } catch { items = state.items; }
      const draw = () => { const query = search.value.trim().toLowerCase(); const canvas = state.canvases.find((item) => item.id === state.canvasId); const existing = new Set((canvas?.nodes || []).filter((node) => node.type === 'file').map((node) => node.noteId)); list.innerHTML = ''; const visible = (items || []).filter((item) => !query || `${item.title} ${(item.tags || []).join(' ')} ${item.folder || ''}`.toLowerCase().includes(query));
        for (const item of visible) { const row = mk('button', 'notes-canvas-note-option'); row.type = 'button'; row.disabled = existing.has(item.id); row.append(mk('strong', '', item.title), mk('span', '', row.disabled ? '已在当前画布中' : `${item.folder || '未分类'}${item.tags?.length ? ` · ${item.tags.join('、')}` : ''}`)); row.addEventListener('click', async () => { let target = state.canvases.find((entry) => entry.id === state.canvasId); if (!target) { target = await state.provider.createCanvas({ name: '知识画布', nodes: [], edges: [] }); state.canvases.push(target); state.canvasId = target.id; } const offset = target.nodes?.length || 0; target.nodes = [...(target.nodes || []), { id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, type: 'file', noteId: item.id, x: 40 + (offset % 6) * 32, y: 50 + (offset % 6) * 24, width: 170, height: 84 }]; await state.provider.updateCanvas(target.id, { nodes: target.nodes }); mask._close(); render(); }); list.appendChild(row); }
        if (!visible.length) list.appendChild(emptyBox('没有找到匹配的笔记。'));
      }; search.addEventListener('input', draw); draw(); search.focus?.();
    });
    addText.addEventListener('click', async () => { const text = prompt('文本卡片内容'); if (!text) return; const canvas = state.canvases.find((item) => item.id === state.canvasId); if (!canvas) return; canvas.nodes = [...(canvas.nodes || []), { id: `n-${Date.now()}`, type: 'text', text, x: 80, y: 80, width: 190, height: 90 }]; await state.provider.updateCanvas(canvas.id, { nodes: canvas.nodes }); paint(canvas); });
    addGroup.addEventListener('click', async () => { const name = prompt('分组名称', '新分组'); if (!name) return; const canvas = state.canvases.find((item) => item.id === state.canvasId); if (!canvas) return; canvas.nodes = [...(canvas.nodes || []), { id: `n-${Date.now()}`, type: 'group', text: name, x: 40, y: 40, width: 360, height: 220 }]; await state.provider.updateCanvas(canvas.id, { nodes: canvas.nodes }); paint(canvas); });
    connect.addEventListener('click', async () => { const canvas = state.canvases.find((item) => item.id === state.canvasId); const selected = [...state.canvasSelected]; if (!canvas || selected.length !== 2) return state.ctx?.toast?.('请先点选两个节点'); canvas.edges = [...(canvas.edges || []), { id: `e-${Date.now()}`, fromNode: selected[0], toNode: selected[1] }]; state.canvasSelected.clear(); await state.provider.updateCanvas(canvas.id, { edges: canvas.edges }); paint(canvas); });
  }

  function renderTrash(host) {
    const shell = mk('div', 'notes-special notes-trash');
    if (!state.items.length) shell.appendChild(emptyBox('回收站为空。删除的笔记会在这里保留，确认后才会永久删除。'));
    for (const item of state.items) { const row = mk('div', 'notes-trash-row'); row.append(mk('div', 'notes-trash-title', item.title), mk('span', 'notes-meta', `删除于 ${formatTime(item.deletedAt)}`)); const restore = mk('button', 'ghost-btn', '恢复'); restore.type = 'button'; restore.addEventListener('click', async () => { await state.provider.restoreNote(item.id); await refresh(); }); const remove = mk('button', 'ghost-btn danger', '永久删除'); remove.type = 'button'; remove.addEventListener('click', async () => { if (!confirm(`永久删除“${item.title}”？此操作不能撤销。`)) return; await state.provider.deleteNote(item.id, true); await refresh(); }); row.append(restore, remove); shell.appendChild(row); }
    host.appendChild(shell);
  }

  function render() {
    if (!state.mount) return;
    if (state.graphFrame !== null && window.cancelAnimationFrame) { window.cancelAnimationFrame(state.graphFrame); state.graphFrame = null; }
    state.mount.innerHTML = ''; renderToolbar(state.mount);
    if (state.mode === 'graph') return renderGraph(state.mount);
    if (state.mode === 'bases') return renderBases(state.mount);
    if (state.mode === 'canvas') return renderCanvas(state.mount);
    if (state.mode === 'trash') return renderTrash(state.mount);
    const workspace = mk('div', 'notes-workspace'); const items = visibleItems(); renderList(workspace, items);
    renderDetail(workspace, items.find((item) => item.id === state.selected) ?? items[0] ?? null); state.mount.appendChild(workspace);
  }

  function renderSettings(mount) {
    mount.innerHTML = '';
    for (const [label, value] of [
      ['连接状态', state.provider && !state.offline ? '已连接' : state.offline ? '离线摘要' : '等待 AI 智学主程序'],
      ['已启用能力', Object.entries(state.caps).filter(([key, enabled]) => key !== 'connected' && enabled).map(([key]) => key).join('、') || '无'],
      ['摘要缓存', `${state.namespace ? state.items.length : 0} 条`], ['最后同步', formatTime(state.lastSync)],
      ['数据边界', '只缓存摘要；正文、图片、OCR 与附件不进入本模块'],
    ]) { const row = mk('div', 'kv'); row.append(mk('span', 'kv-key', label), mk('span', 'kv-val', value)); mount.appendChild(row); }
    const clear = mk('button', 'ghost-btn notes-clear-cache', '清除摘要缓存'); clear.type = 'button'; clear.disabled = !state.namespace;
    clear.addEventListener('click', () => { const store = localStore(); const key = cacheKey(); if (store && key) store.removeItem(key); window.PC?.toast?.('摘要缓存已清除，主程序笔记未受影响'); }); mount.appendChild(clear);
  }

  window.PCModules.service('notes', { connectProvider, disconnectProvider, ingestSnapshot, refresh, upload, read, readForAI, open });
  window.PCModules.registerSettingsSection({ id: 'notes.integration', title: '笔记接入', order: 50, render: renderSettings });
  window.PCModules.register({
    id: 'notes', label: '笔记系统', icon: '📝', order: 50, title: '笔记系统',
    render(ctx) {
      state.mount = ctx.mount; state.ctx = ctx; render();
      if (!state.provider) ensureLocalProvider(ctx.api);
      else if (!state.loading) refresh();
    },
  });

  // 即使用户直接打开“设置”，也主动连接内置主程序，避免笔记接入区长期显示“等待主程序”。
  setTimeout(() => ensureLocalProvider(window.PC?.api), 0);
})();
