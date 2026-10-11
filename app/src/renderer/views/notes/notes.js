/** 笔记系统挂载层：只保存摘要，正文、图片、OCR 与附件归 AI 智学主程序。 */
(function () {
  'use strict';

  const CACHE_PREFIX = 'ai-study.notes.summary.v1.';
  const CACHE_TTL = 7 * 86400000;
  const CACHE_LIMIT = 100;
  const STATUS = { draft: '草稿', processing: '整理中', ready: '已整理', failed: '处理失败' };
  const SOURCE = { manual: '手动', snapshot: '随手拍', import: '导入' };
  const EMPTY_CAPS = { connected: false, search: false, markdown: false, export: false, capture: false, subscriptions: false };
  const FORBIDDEN = /^(body|content|markdown|ocr|ocrText|image|images|imageUrl|filePath|path|attachment|attachments|blob|base64|data)$/i;
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
  };

  const localStore = () => { try { return window.localStorage ?? null; } catch { return null; } };
  const today = () => window.PCUtil?.todayKey?.() ?? new Date().toISOString().slice(0, 10);
  const cacheKey = () => state.namespace ? `${CACHE_PREFIX}${encodeURIComponent(state.namespace)}` : null;

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
      status: ['draft', 'processing', 'ready', 'failed'].includes(value.status) ? value.status : 'draft',
      anchor: anchorOf(value.anchor),
      tags: Array.isArray(value.tags) ? value.tags.map(String).map((v) => v.trim()).filter(Boolean).slice(0, 12) : [],
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
    state.selected = state.items[0]?.id ?? null;
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
      saveCache();
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
      const filters = { source: state.filter === 'snapshot' ? 'snapshot' : undefined, status: state.filter === 'pending' ? 'processing' : undefined, tag: state.tag || undefined, limit: CACHE_LIMIT };
      const result = state.query && state.caps.search && typeof state.provider.searchNotes === 'function'
        ? await state.provider.searchNotes(state.query, filters)
        : await state.provider.listNotes(filters);
      state.items = (Array.isArray(result) ? result : result?.items ?? []).map((item) => summaryOf(item));
      state.selected = state.items.some((item) => item.id === state.selected) ? state.selected : state.items[0]?.id ?? null;
      await refreshCalendar();
      state.lastSync = new Date().toISOString();
      state.offline = false;
      saveCache();
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
      if (state.tag && !item.tags.includes(state.tag)) return false;
      return true;
    });
    return [...items].sort((a, b) => String(b[state.sort === 'created' ? 'createdAt' : 'updatedAt']).localeCompare(String(a[state.sort === 'created' ? 'createdAt' : 'updatedAt'])));
  }

  function pill(item) { return mk('span', `notes-status ${item.status}`, STATUS[item.status] ?? item.status); }

  function renderToolbar(host) {
    const bar = mk('div', 'toolbar wrap notes-toolbar');
    const first = mk('div', 'toolbar-row');
    const seg = mk('div', 'seg');
    for (const [key, label] of [['all', '全部'], ['today', '今天'], ['pending', '待整理'], ['snapshot', '随手拍']]) {
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
    const create = mk('button', 'primary-btn notes-create', '+ 新建笔记');
    create.type = 'button';
    create.disabled = !state.provider || state.offline || !state.provider.createDraft;
    create.addEventListener('click', () => openComposer('manual', create));
    first.append(seg, mk('span', 'spacer'), connection, capture, create);

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
    second.append(search, tags, sort);
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
      const head = mk('div', 'notes-card-head'); head.append(mk('span', 'notes-card-title', item.title), pill(item));
      card.append(head, mk('div', 'notes-anchor', anchorText(item)));
      if (item.tags.length) { const tags = mk('div', 'notes-tags'); item.tags.slice(0, 4).forEach((tag) => tags.appendChild(mk('span', 'tag notes-tag', tag))); card.appendChild(tags); }
      card.appendChild(mk('div', 'notes-meta', `${SOURCE[item.source]} · ${item.mediaCount} 张图片 · ${formatTime(item.updatedAt)}`));
      card.addEventListener('click', () => { state.selected = item.id; render(); });
      list.appendChild(card);
    }
    host.appendChild(list);
  }

  async function openMarkdownPreview(item, trigger) {
    const mask = modal(`Markdown 预览 · ${item.title}`, trigger);
    const body = mask.querySelector('.modal-body');
    const foot = mask.querySelector('.modal-foot');
    const preview = mk('div', 'notes-markdown-preview richtext');
    preview.appendChild(mk('div', 'loading', '正在由 AI 智学读取正文…'));
    body.appendChild(preview);
    const close = mk('button', 'ghost-btn', '关闭');
    close.type = 'button'; close.addEventListener('click', mask._close); foot.appendChild(close);
    try {
      const result = await state.provider.renderMarkdown(item.id);
      const text = typeof result === 'string' ? result : result?.text ?? result?.markdown ?? '';
      preview.innerHTML = '';
      if (window.PCRichText?.render) window.PCRichText.render(preview, text);
      else preview.textContent = text;
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
    for (const [label, value] of [['来源', SOURCE[item.source]], ['关联', anchorText(item)], ['图片', `${item.mediaCount} 张`], ['创建', formatTime(item.createdAt)], ['更新', formatTime(item.updatedAt)]]) {
      const row = mk('div', 'kv'); row.append(mk('span', 'kv-key', label), mk('span', 'kv-val', value)); facts.appendChild(row);
    }
    detail.appendChild(facts);
    const actions = mk('div', 'notes-actions');
    const openButton = mk('button', 'primary-btn', '在 AI 智学中打开'); openButton.type = 'button'; openButton.disabled = !state.provider?.openNote || state.offline;
    openButton.addEventListener('click', () => open(item.id).catch((error) => state.ctx?.toast?.(`打开失败：${error.message}`))); actions.appendChild(openButton);
    if (state.caps.markdown && state.provider?.renderMarkdown) { const button = mk('button', 'ghost-btn', 'Markdown 预览'); button.type = 'button'; button.disabled = state.offline; button.addEventListener('click', () => openMarkdownPreview(item, button)); actions.appendChild(button); }
    if (state.caps.export && state.provider?.exportNote) { const button = mk('button', 'ghost-btn', '导出'); button.type = 'button'; button.addEventListener('click', () => state.provider.exportNote(item.id, 'markdown')); actions.appendChild(button); }
    if (item.status === 'failed' && state.provider?.retryProcessing) { const button = mk('button', 'ghost-btn', '重新识别'); button.type = 'button'; button.addEventListener('click', async () => { await state.provider.retryProcessing(item.id); merge({ ...item, status: 'processing' }); render(); }); actions.appendChild(button); }
    detail.append(actions, mk('div', 'notes-boundary', '正文、图片和识别结果由 AI 智学主程序持有，本页面只展示摘要。'));
    host.appendChild(detail);
  }

  function modal(title, trigger) {
    const mask = mk('div', 'modal-mask'); const box = mk('div', 'modal notes-modal'); const head = mk('div', 'modal-head');
    const body = mk('div', 'modal-body'); const foot = mk('div', 'modal-foot');
    const close = () => { mask.remove(); trigger?.focus?.(); };
    head.append(mk('div', 'modal-title', title), iconBtn('关闭', '×', close)); box.append(head, body, foot); mask.appendChild(box); document.body.appendChild(mask); mask._close = close; return mask;
  }

  function openComposer(source, trigger) {
    const capture = source === 'snapshot'; const mask = modal(capture ? '随手拍到笔记' : '新建笔记', trigger);
    const body = mask.querySelector('.modal-body'); const foot = mask.querySelector('.modal-foot');
    const title = mk('input', 'notes-title-input'); title.placeholder = '未命名笔记';
    const tags = mk('input', 'notes-tags-input'); tags.placeholder = '标签用逗号分隔';
    const mode = mk('select', 'notes-anchor-mode'); mode.append(option('none', '不关联日历', true), option('date', '关联某一天'), option('schedule', '关联某条日程'));
    const date = mk('input', 'notes-anchor-date'); date.type = 'date'; date.value = today(); date.disabled = true;
    const schedules = mk('select', 'notes-schedule-select'); schedules.disabled = true; schedules.appendChild(option('', '请先选择日期'));
    const error = mk('div', 'modal-error hidden');
    if (!capture) body.appendChild(field('标题', title));
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
    const save = mk('button', 'primary-btn', capture ? '开始拍摄' : '创建并打开'); save.type = 'button'; foot.append(cancel, save);
    save.addEventListener('click', async () => {
      let anchor = null;
      if (mode.value === 'date') anchor = { type: 'date', date: date.value };
      if (mode.value === 'schedule' && schedules.value) anchor = { type: 'schedule', scheduleId: schedules.value, occurrenceDate: date.value };
      save.disabled = cancel.disabled = true; error.classList.add('hidden');
      try {
        const input = { source, anchor, tags: tags.value.split(/[,，]/).map((v) => v.trim()).filter(Boolean) }; if (!capture) input.title = title.value.trim();
        const result = capture ? await state.provider.startCapture(input) : await state.provider.createDraft(input);
        if (!result) return mask._close();
        const item = merge({ ...result, source }); mask._close(); render(); if (!capture && state.provider.openNote) await state.provider.openNote(item.id);
      } catch (reason) { error.textContent = reason.message; error.classList.remove('hidden'); save.disabled = cancel.disabled = false; }
    });
    title.focus();
  }

  function render() {
    if (!state.mount) return;
    state.mount.innerHTML = ''; renderToolbar(state.mount);
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

  window.PCModules.service('notes', { connectProvider, disconnectProvider, ingestSnapshot, refresh, open });
  window.PCModules.registerSettingsSection({ id: 'notes.integration', title: '笔记接入', order: 50, render: renderSettings });
  window.PCModules.register({
    id: 'notes', label: '笔记系统', icon: '📝', order: 50, title: '笔记系统',
    render(ctx) { state.mount = ctx.mount; state.ctx = ctx; render(); if (state.provider && !state.loading) refresh(); },
  });
})();
