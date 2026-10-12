/** 笔记系统挂载层：只保存摘要，正文、图片、OCR 与附件归 AI 智学主程序。 */
(function () {
  'use strict';

  const CACHE_PREFIX = 'ai-study.notes.summary.v1.';
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
    graphScope: 'local',
    graphData: null,
    canvases: [],
    canvasId: null,
    canvasSelected: new Set(),
  };

  const localStore = () => { try { return window.localStorage ?? null; } catch { return null; } };
  const today = () => window.PCUtil?.todayKey?.() ?? new Date().toISOString().slice(0, 10);
  const cacheKey = () => state.namespace ? `${CACHE_PREFIX}${encodeURIComponent(state.namespace)}` : null;

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
      card.addEventListener('click', () => { state.selected = item.id; render(); });
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

  function renderDetail(host, item) {
    const detail = mk('div', 'notes-detail');
    if (!item) { detail.appendChild(emptyBox('选择一条笔记查看挂载信息。正文由 AI 智学主程序打开。')); host.appendChild(detail); return; }
    const head = mk('div', 'notes-detail-head'); head.append(mk('div', 'notes-detail-title', item.title), pill(item)); detail.appendChild(head);
    if (item.previewText) detail.appendChild(mk('p', 'notes-preview', item.previewText));
    const facts = mk('div', 'notes-facts');
    for (const [label, value] of [['目录', item.folder || '未分类'], ['课程', item.properties?.course || '—'], ['类型', item.properties?.type || '普通笔记'], ['来源', SOURCE[item.source]], ['关联', anchorText(item)], ['知识链接', `${item.links?.length || 0} 条`], ['图片', `${item.mediaCount} 张`], ['创建', formatTime(item.createdAt)], ['更新', formatTime(item.updatedAt)]]) {
      const row = mk('div', 'kv'); row.append(mk('span', 'kv-key', label), mk('span', 'kv-val', value)); facts.appendChild(row);
    }
    detail.appendChild(facts);
    const actions = mk('div', 'notes-actions');
    const openButton = mk('button', 'primary-btn', state.caps.edit ? '编辑笔记' : '在 AI 智学中打开'); openButton.type = 'button'; openButton.disabled = !state.provider?.openNote || state.offline;
    openButton.addEventListener('click', () => open(item.id).catch((error) => state.ctx?.toast?.(`打开失败：${error.message}`))); actions.appendChild(openButton);
    if ((state.caps.view && state.provider?.readNote) || (state.caps.markdown && state.provider?.renderMarkdown)) { const button = mk('button', 'ghost-btn', '查看笔记'); button.type = 'button'; button.disabled = state.offline; button.addEventListener('click', () => openNoteViewer(item, button)); actions.appendChild(button); }
    if (state.caps.export && state.provider?.exportNote) { const button = mk('button', 'ghost-btn', '导出'); button.type = 'button'; button.addEventListener('click', () => state.provider.exportNote(item.id, 'markdown')); actions.appendChild(button); }
    if (state.provider?.updateNote) {
      const favorite = mk('button', 'ghost-btn', item.favorite ? '取消收藏' : '收藏'); favorite.type = 'button';
      favorite.addEventListener('click', async () => { const next = await state.provider.updateNote(item.id, { favorite: !item.favorite, expectedUpdatedAt: item.updatedAt }); merge(next); render(); }); actions.appendChild(favorite);
    }
    if (state.provider?.deleteNote) {
      const remove = mk('button', 'ghost-btn danger', '移到回收站'); remove.type = 'button';
      remove.addEventListener('click', async () => { if (!confirm(`将“${item.title}”移到回收站？`)) return; await state.provider.deleteNote(item.id); state.items = state.items.filter((one) => one.id !== item.id); state.selected = state.items[0]?.id ?? null; saveCache(); render(); }); actions.appendChild(remove);
    }
    if (item.status === 'failed' && state.provider?.retryProcessing) { const button = mk('button', 'ghost-btn', '重新识别'); button.type = 'button'; button.addEventListener('click', async () => { await state.provider.retryProcessing(item.id); merge({ ...item, status: 'processing' }); render(); }); actions.appendChild(button); }
    detail.append(actions, mk('div', 'notes-boundary', '正文按需读取；编辑器支持 Markdown、属性、双向链接、历史版本与自动保存。'));
    host.appendChild(detail);
  }

  function modal(title, trigger) {
    const mask = mk('div', 'modal-mask'); const box = mk('div', 'modal notes-modal'); const head = mk('div', 'modal-head');
    const body = mk('div', 'modal-body'); const foot = mk('div', 'modal-foot');
    const close = () => { mask.remove(); trigger?.focus?.(); };
    head.append(mk('div', 'modal-title', title), iconBtn('关闭', '×', close)); box.append(head, body, foot); mask.appendChild(box); document.body.appendChild(mask); mask._close = close; return mask;
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
    const canvasButton = mk('button', 'ghost-btn', '将图谱放入 Canvas'); canvasButton.type = 'button'; canvasButton.disabled = !state.graphData?.nodes?.length;
    canvasButton.addEventListener('click', async () => {
      const nodes = state.graphData.nodes.map((node, index) => ({ id: `n-${node.id}`, type: 'file', noteId: node.id, x: 80 + index % 4 * 190, y: 70 + Math.floor(index / 4) * 130, width: 160, height: 84 }));
      const edges = state.graphData.edges.map((edge, index) => ({ id: `e-${index}`, fromNode: `n-${edge.source}`, toNode: `n-${edge.target}` }));
      const item = await state.provider.createCanvas({ name: `知识图谱 ${today()}`, nodes, edges }); state.canvasId = item.id; state.mode = 'canvas'; render();
    });
    controls.append(scope, canvasButton); shell.appendChild(controls);
    const stage = mk('div', 'notes-graph-stage'); stage.appendChild(mk('div', 'loading', '正在生成知识图谱…')); shell.appendChild(stage); host.appendChild(shell);
    if (state.graphData) return drawGraph(stage, state.graphData);
    const filters = state.graphScope === 'local' && state.selected ? { id: state.selected, depth: 2 } : {};
    state.provider.graph(filters).then((data) => { if (state.mode !== 'graph') return; state.graphData = data; stage.innerHTML = ''; drawGraph(stage, data); canvasButton.disabled = !data.nodes.length; }).catch((error) => { stage.innerHTML = ''; stage.appendChild(errorBox(`图谱读取失败：${error.message}`)); });
  }

  function drawGraph(stage, data) {
    if (!data.nodes.length) return stage.appendChild(emptyBox('还没有知识链接。在正文中输入 [[另一篇笔记]] 后，关系会显示在这里。'));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 900 560'); svg.setAttribute('class', 'notes-graph-svg');
    const points = new Map(); const centerX = 450; const centerY = 280; const radius = Math.min(220, 80 + data.nodes.length * 12);
    data.nodes.forEach((node, index) => { const angle = index / data.nodes.length * Math.PI * 2 - Math.PI / 2; points.set(node.id, { x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius }); });
    for (const edge of data.edges) { const from = points.get(edge.source); const to = points.get(edge.target); const line = document.createElementNS(svg.namespaceURI, 'line'); for (const [key, value] of Object.entries({ x1: from.x, y1: from.y, x2: to.x, y2: to.y })) line.setAttribute(key, value); line.setAttribute('class', 'notes-graph-edge'); svg.appendChild(line); }
    for (const node of data.nodes) {
      const point = points.get(node.id); const group = document.createElementNS(svg.namespaceURI, 'g'); group.setAttribute('class', `notes-graph-node${node.id === state.selected ? ' active' : ''}`); group.setAttribute('transform', `translate(${point.x} ${point.y})`); group.setAttribute('tabindex', '0');
      const circle = document.createElementNS(svg.namespaceURI, 'circle'); circle.setAttribute('r', node.favorite ? 25 : 20); const text = document.createElementNS(svg.namespaceURI, 'text'); text.setAttribute('y', '38'); text.setAttribute('text-anchor', 'middle'); text.textContent = node.title.slice(0, 18); group.append(circle, text);
      const openNode = () => { state.selected = node.id; state.provider.openNote(node.id); }; group.addEventListener('click', openNode); group.addEventListener('keydown', (event) => { if (event.key === 'Enter') openNode(); }); svg.appendChild(group);
    }
    stage.appendChild(svg);
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
    const shell = mk('div', 'notes-special notes-canvas-view'); const controls = mk('div', 'notes-special-controls'); const select = mk('select'); const create = mk('button', 'ghost-btn', '+ 新建画布'); const add = mk('button', 'ghost-btn', '添加当前笔记'); const addText = mk('button', 'ghost-btn', '文本卡片'); const addGroup = mk('button', 'ghost-btn', '分组'); const connect = mk('button', 'ghost-btn', '连接选中节点');
    controls.append(select, create, add, addText, addGroup, connect); shell.appendChild(controls); const board = mk('div', 'notes-canvas-board'); shell.appendChild(board); host.appendChild(shell);
    const paint = (canvas) => {
      board.innerHTML = ''; if (!canvas) return board.appendChild(emptyBox('新建一个 Canvas，把笔记拖到二维空间中整理思路。'));
      const noteMap = new Map(state.items.map((item) => [item.id, item]));
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'notes-canvas-lines'); const nodesById = new Map((canvas.nodes || []).map((node) => [node.id, node]));
      for (const edge of canvas.edges || []) { const from = nodesById.get(edge.fromNode); const to = nodesById.get(edge.toNode); if (!from || !to) continue; const line = document.createElementNS(svg.namespaceURI, 'line'); line.setAttribute('x1', (from.x || 20) + (from.width || 170) / 2); line.setAttribute('y1', (from.y || 20) + 34); line.setAttribute('x2', (to.x || 20) + (to.width || 170) / 2); line.setAttribute('y2', (to.y || 20) + 34); svg.appendChild(line); } board.appendChild(svg);
      for (const node of canvas.nodes || []) { const card = mk('div', `notes-canvas-node notes-canvas-${node.type || 'text'}${state.canvasSelected.has(node.id) ? ' selected' : ''}`); card.style.left = `${node.x || 20}px`; card.style.top = `${node.y || 20}px`; card.style.width = `${node.width || (node.type === 'group' ? 360 : 170)}px`; card.style.height = `${node.height || (node.type === 'group' ? 220 : 84)}px`; card.textContent = node.type === 'file' ? noteMap.get(node.noteId)?.title || '缺失笔记' : node.text || (node.type === 'group' ? '分组' : '文本卡片'); card.tabIndex = 0; if (node.type === 'file') card.addEventListener('dblclick', () => state.provider.openNote(node.noteId)); card.addEventListener('click', () => { if (state.canvasSelected.has(node.id)) state.canvasSelected.delete(node.id); else state.canvasSelected.add(node.id); paint(canvas); }); let drag = null; card.addEventListener('pointerdown', (event) => { drag = { x: event.clientX, y: event.clientY, left: node.x || 20, top: node.y || 20 }; card.setPointerCapture?.(event.pointerId); }); card.addEventListener('pointermove', (event) => { if (!drag) return; node.x = drag.left + event.clientX - drag.x; node.y = drag.top + event.clientY - drag.y; card.style.left = `${node.x}px`; card.style.top = `${node.y}px`; }); card.addEventListener('pointerup', () => { if (!drag) return; drag = null; state.provider.updateCanvas(canvas.id, { nodes: canvas.nodes }).then(() => paint(canvas)); }); board.appendChild(card); }
    };
    state.provider.listCanvases().then((items) => { state.canvases = items; state.canvasId ||= items[0]?.id ?? null; select.innerHTML = ''; select.appendChild(option('', items.length ? '选择画布' : '暂无画布')); items.forEach((item) => select.appendChild(option(item.id, item.name, item.id === state.canvasId))); paint(items.find((item) => item.id === state.canvasId)); });
    select.addEventListener('change', () => { state.canvasId = select.value; paint(state.canvases.find((item) => item.id === state.canvasId)); });
    create.type = add.type = 'button'; create.addEventListener('click', async () => { const item = await state.provider.createCanvas({ name: `新画布 ${state.canvases.length + 1}`, nodes: [], edges: [] }); state.canvasId = item.id; render(); });
    add.disabled = !state.selected; add.addEventListener('click', async () => { let canvas = state.canvases.find((item) => item.id === state.canvasId); if (!canvas) canvas = await state.provider.createCanvas({ name: '知识画布', nodes: [], edges: [] }); const nodes = [...(canvas.nodes || []), { id: `n-${Date.now()}`, type: 'file', noteId: state.selected, x: 40 + (canvas.nodes?.length || 0) * 24, y: 50 + (canvas.nodes?.length || 0) * 18, width: 170, height: 84 }]; await state.provider.updateCanvas(canvas.id, { nodes }); state.canvasId = canvas.id; render(); });
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
