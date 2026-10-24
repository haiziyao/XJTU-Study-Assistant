/** Standalone Markdown editing; note bodies stay in memory until explicitly saved. */
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const AUTOSAVE_DELAY = 5 * 60 * 1000;
  const enhancedUi = Boolean(document.body);
  const apiBase = (params.get('api') || (location.protocol.startsWith('http') ? `${location.origin}/api/v1` : 'http://127.0.0.1:3210/api/v1')).replace(/\/$/, '');
  const title = document.getElementById('note-title');
  const body = document.getElementById('note-body');
  const preview = document.getElementById('note-preview');
  const saveButton = document.getElementById('save-note');
  const status = document.getElementById('save-status');
  const errorBox = document.getElementById('editor-error');
  const back = document.getElementById('back-to-notes');
  const leaveDialog = document.getElementById('leave-dialog');
  const highlight = document.getElementById('note-highlight');
  const lineNumbers = document.getElementById('note-line-numbers');
  const undoButton = document.getElementById('undo-note');
  const redoButton = document.getElementById('redo-note');
  const editor = document.getElementById('note-editor');
  const suggestions = document.getElementById('wiki-suggestions');
  const outline = document.getElementById('note-outline');
  const linksPanel = document.getElementById('note-links');
  const versionsPanel = document.getElementById('note-versions');
  const attachmentPreview = document.getElementById('note-attachment-preview');
  let id = params.get('id');
  let updatedAt = null;
  let loaded = !id;
  let saving = false;
  let leaving = false;
  let hasAttachments = false;
  let saved = '';
  let previewTimer;
  let autosaveTimer;
  let noteIndex = [];
  let past = [];
  let future = [];
  let previousBody = { text: body.value, start: 0, end: 0 };
  const attachmentHref = (file) => file?.dataUrl || (file?.url ? `${apiBase}${file.url}` : '#');
  const snapshot = () => JSON.stringify({ title: title.value, body: body.value });
  const dirty = () => snapshot() !== saved;

  function cancelAutosave() {
    if (autosaveTimer === undefined || autosaveTimer === null) return;
    clearTimeout(autosaveTimer); autosaveTimer = undefined;
  }

  function scheduleAutosave() {
    if (!enhancedUi || !loaded || !dirty() || saving || autosaveTimer !== undefined) return;
    autosaveTimer = setTimeout(() => { autosaveTimer = undefined; if (dirty()) save('autosave'); }, AUTOSAVE_DELAY);
  }

  // Keep explicit API routing and the active note when returning to the workspace.
  function updateReturnUrl() {
    const returnUrl = new URL(location.protocol === 'file:' ? '../../index.html' : '../../', location.href);
    returnUrl.searchParams.set('view', 'notes');
    if (id) returnUrl.searchParams.set('note', id);
    if (params.has('api')) returnUrl.searchParams.set('api', apiBase);
    back.href = returnUrl.href;
  }
  updateReturnUrl();

  function setStatus(text, state = '') { status.textContent = text; status.dataset.state = state; }
  function showError(message = '') { errorBox.textContent = message; errorBox.hidden = !message; }
  function setView(view) {
    editor.dataset.view = view;
    document.querySelectorAll('button[data-view]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
  }
  function renderAttachmentPreviews(files = []) {
    attachmentPreview.innerHTML = ''; attachmentPreview.hidden = !files.length;
    for (const file of files) {
      if ((file.type || '').startsWith('image/')) {
        const image = document.createElement('img'); image.src = attachmentHref(file); image.alt = file.name; attachmentPreview.appendChild(image);
      } else if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')) {
        const object = document.createElement('object'); object.data = attachmentHref(file); object.type = 'application/pdf'; object.setAttribute('aria-label', `PDF 预览：${file.name}`); attachmentPreview.appendChild(object);
      } else if (/\.(doc|ppt)$/i.test(file.name || '')) {
        const hint = document.createElement('p'); hint.textContent = '旧版 Office 文件无法在网页中提取正文，请使用上方“下载/打开”查看原文件。'; attachmentPreview.appendChild(hint);
      }
    }
  }
  function syncSource() {
    highlight.scrollTop = body.scrollTop;
    highlight.scrollLeft = body.scrollLeft;
    lineNumbers.style.transform = `translateY(${-body.scrollTop}px)`;
  }
  function renderSource() {
    const escape = window.PCRichText.escapeHtml;
    highlight.innerHTML = body.value.split('\n').map((line) => {
      const text = escape(line);
      if (/^\s*#{1,6}\s/.test(line)) return `<span class="note-token-heading">${text}</span>`;
      if (/^\s*(>|\|)/.test(line)) return `<span class="note-token-quote">${text}</span>`;
      return text.replace(/(\*\*.*?\*\*|`[^`]*`|~~.*?~~)/g, '<span class="note-token-mark">$1</span>');
    }).join('\n') + '\n';
    lineNumbers.textContent = body.value.split('\n').map((unused, index) => index + 1).join('\n');
    syncSource();
  }
  function updateHistory() { undoButton.disabled = !past.length || !loaded; redoButton.disabled = !future.length || !loaded; }
  function captureSelection() { previousBody.start = body.selectionStart || 0; previousBody.end = body.selectionEnd || 0; }
  function resetHistory() { past = []; future = []; previousBody = { text: body.value, start: 0, end: 0 }; updateHistory(); }
  function rememberEdit() {
    if (body.value === previousBody.text) return;
    past.push(previousBody); future = [];
    let size = past.reduce((total, entry) => total + entry.text.length, 0);
    while (past.length > 30 || (size > 1000000 && past.length > 1)) size -= past.shift().text.length;
    previousBody = { text: body.value, start: body.selectionStart || 0, end: body.selectionEnd || 0 };
    updateHistory();
  }
  function restoreEdit(from, to) {
    if (!loaded || !from.length) return;
    to.push({ text: body.value, start: body.selectionStart || 0, end: body.selectionEnd || 0 });
    const entry = from.pop(); body.value = entry.text;
    body.focus(); body.setSelectionRange(entry.start, entry.end);
    previousBody = { ...entry }; updateHistory(); changed(false);
  }
  function renderPreview() {
    renderSource();
    if (!body.value.trim()) {
      preview.innerHTML = '';
      const hint = document.createElement('p'); hint.className = 'note-editor-empty';
      hint.textContent = '从左侧开始书写，预览会在这里实时呈现。'; preview.appendChild(hint);
    } else {
      window.PCRichText.render(preview, body.value);
      preview.querySelectorAll?.('.rt-wikilink').forEach((link) => link.addEventListener('click', () => {
        const target = noteIndex.find((item) => [item.title, ...(item.aliases || [])].some((name) => name.toLowerCase() === link.dataset.noteTitle.toLowerCase()));
        if (target) { const url = new URL(location.href); url.searchParams.set('id', target.id); location.href = url.href; }
      }));
    }
    document.getElementById('word-count').textContent = `${body.value.length.toLocaleString()} 字符 · ${body.value.split('\n').length} 行`;
    renderOutline();
    document.title = `${title.value.trim() || '未命名笔记'}${dirty() ? ' *' : ''} · 智学笔记`;
  }
  function changed(record = true) {
    if (record) rememberEdit();
    renderSource();
    if (!saving) setStatus(dirty() ? '有未保存的更改 · 每 5 分钟自动保存' : id ? '所有更改已保存' : '新笔记 · 尚未保存', dirty() ? 'dirty' : id ? 'saved' : '');
    clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 100);
    if (dirty()) scheduleAutosave(); else cancelAutosave();
    renderWikiSuggestions();
  }
  async function request(path, options = {}) {
    const response = await fetch(`${apiBase}${path}`, {
      ...options, headers: { 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) throw new Error(payload.error?.message || `请求失败（${response.status}）`);
    return payload;
  }
  async function save(reason = 'manual') {
    if (saving || !loaded) return false;
    if (body.value.length > 200000) { showError('正文最多支持 200,000 字符，请精简后再保存。'); return false; }
    const submitted = snapshot();
    const fields = {
      title: title.value.trim() || '未命名笔记', body: body.value,
      format: 'markdown',
      versionReason: reason,
    };
    if (!id) fields.status = 'draft';
    if (id) fields.expectedUpdatedAt = updatedAt;
    let succeeded = false;
    cancelAutosave();
    saving = true; saveButton.disabled = true; showError(); setStatus('正在保存…');
    try {
      const result = await request(id ? `/notes/${encodeURIComponent(id)}` : '/notes', { method: id ? 'PATCH' : 'POST', body: fields });
      id = result.summary.id; updatedAt = result.summary.updatedAt;
      updateReturnUrl();
      succeeded = true;
      const url = new URL(location.href); url.searchParams.set('id', id); history.replaceState(null, '', url.href);
      // Edits typed during a slow request remain dirty; only the submitted snapshot was saved.
      if (snapshot() === submitted) {
        title.value = fields.title; saved = snapshot();
      } else saved = submitted;
      setStatus(dirty() ? '有未保存的更改' : '所有更改已保存', dirty() ? 'dirty' : 'saved');
      renderPreview();
      if (enhancedUi) await refreshRelations();
      return !dirty();
    } catch (error) { showError(`保存失败：${error.message}`); setStatus('保存失败，正文仍在当前页面', 'error'); return false; }
    finally {
      saving = false; saveButton.disabled = false;
      if (enhancedUi && succeeded && dirty()) scheduleAutosave();
    }
  }
  saveButton.addEventListener('click', () => save('manual'));
  for (const input of [title, body]) input.addEventListener('input', () => changed(input === body));
  body.addEventListener('beforeinput', captureSelection);
  body.addEventListener('scroll', syncSource);
  undoButton.addEventListener('click', () => restoreEdit(past, future));
  redoButton.addEventListener('click', () => restoreEdit(future, past));
  document.querySelectorAll('button[data-view]').forEach((button) => button.addEventListener('click', () => {
    setView(button.dataset.view);
    if (button.dataset.view === 'read') renderPreview();
  }));
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save('manual'); }
  });
  body.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.isComposing) {
      const key = event.key.toLowerCase();
      if (key === 'z' || key === 'y') {
        event.preventDefault();
        if (key === 'y' || event.shiftKey) restoreEdit(future, past); else restoreEdit(past, future);
        return;
      }
    }
    if (event.key !== 'Tab') return;
    captureSelection();
    event.preventDefault(); body.setRangeText('  ', body.selectionStart, body.selectionEnd, 'end'); changed();
  });
  document.querySelectorAll('[data-format]').forEach((button) => button.addEventListener('click', () => {
    if (!loaded) return;
    captureSelection();
    const start = body.selectionStart; const end = body.selectionEnd;
    const selected = body.value.slice(start, end);
    const formats = {
      heading: ['## ', '', '标题'], bold: ['**', '**', '粗体文字'], italic: ['*', '*', '斜体文字'], underline: ['{u}', '{/u}', '下划线文字'],
      list: ['- ', '', '列表项'], quote: ['> ', '', '引用内容'], code: ['```\n', '\n```', '代码'],
      link: ['[', '](https://example.com)', '链接文字'], wiki: ['[[', ']]', '关联笔记'],
      strike: ['~~', '~~', '文字'], table: ['| 列一 | 列二 |\n| --- | --- |\n| ', ' | 内容 |\n', '内容'],
    };
    const [before, after, sample] = formats[button.dataset.format];
    const lineFormat = ['heading', 'list', 'quote', 'code', 'table'].includes(button.dataset.format);
    const newline = lineFormat && start > 0 && body.value[start - 1] !== '\n' ? '\n' : '';
    body.setRangeText(`${newline}${before}${selected || sample}${after}`, start, end, 'end');
    body.focus(); body.setSelectionRange(start + newline.length + before.length, start + newline.length + before.length + (selected || sample).length);
    changed();
  }));
  function applyRichToken(before, after, sample = '文字') {
    if (!loaded) return;
    captureSelection(); const start = body.selectionStart; const end = body.selectionEnd; const selected = body.value.slice(start, end) || sample;
    body.setRangeText(`${before}${selected}${after}`, start, end, 'end'); body.focus(); body.setSelectionRange(start + before.length, start + before.length + selected.length); changed();
  }
  document.getElementById('note-font-family')?.addEventListener('change', (event) => applyRichToken(`{font:${event.target.value}}`, '{/font}'));
  document.getElementById('note-font-size')?.addEventListener('change', (event) => applyRichToken(`{size:${event.target.value}}`, '{/size}'));
  document.getElementById('note-font-color')?.addEventListener('change', (event) => applyRichToken(`{color:${event.target.value}}`, '{/color}'));
  document.querySelectorAll('[data-align]').forEach((button) => button.addEventListener('click', () => {
    if (!loaded) return;
    captureSelection(); const start = body.selectionStart; const end = body.selectionEnd; const selected = body.value.slice(start, end) || '段落内容';
    const prefix = start > 0 && body.value[start - 1] !== '\n' ? '\n' : '';
    body.setRangeText(`${prefix}{align:${button.dataset.align}}${selected}`, start, end, 'end'); body.focus(); changed();
  }));
  let syncing = false;
  for (const [source, target] of [[body, preview], [preview, body]]) source.addEventListener('scroll', () => {
    if (syncing || !document.getElementById('sync-scroll').checked) return;
    const sourceRange = source.scrollHeight - source.clientHeight;
    const targetRange = target.scrollHeight - target.clientHeight;
    if (sourceRange <= 0 || targetRange <= 0) return;
    const next = source.scrollTop / sourceRange * targetRange;
    if (Math.abs(target.scrollTop - next) < 1) return;
    syncing = true; target.scrollTop = next;
    requestAnimationFrame(() => { syncing = false; });
  });
  window.addEventListener('beforeunload', (event) => {
    if (leaving || (!dirty() && !saving)) return;
    event.preventDefault(); event.returnValue = '';
  });
  back.addEventListener('click', (event) => {
    if (!dirty() && !saving) return;
    event.preventDefault(); leaveDialog.showModal();
  });
  function leave() { leaving = true; location.href = back.href; }
  document.getElementById('leave-cancel').addEventListener('click', () => leaveDialog.close());
  document.getElementById('leave-discard').addEventListener('click', leave);
  document.getElementById('leave-save').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const success = await save('manual');
    button.disabled = false;
    leaveDialog.close();
    if (success) leave();
  });
  saved = snapshot(); resetHistory(); renderPreview();
  async function load() {
    if (!id) { title.focus(); return; }
    saveButton.disabled = true; title.disabled = body.disabled = true; setStatus('正在读取笔记…');
    try {
      const { note } = await request(`/notes/${encodeURIComponent(id)}`);
      title.value = note.title; body.value = note.body || '';
      updatedAt = note.updatedAt; saved = snapshot(); loaded = true;
      resetHistory();
      hasAttachments = Boolean(note.attachments?.length);
      const attachments = document.getElementById('note-attachments');
      if (note.attachments?.length) {
        attachments.hidden = false; attachments.textContent = '';
        const label = document.createElement('span'); label.textContent = '原始附件：'; attachments.appendChild(label);
        for (const file of note.attachments) {
          const link = document.createElement('a'); link.href = attachmentHref(file); link.download = file.name; link.rel = 'noopener'; link.textContent = `下载/打开 ${file.name}`;
          attachments.appendChild(link);
        }
      }
      renderAttachmentPreviews(note.attachments ?? []);
      const hasFilePreview = (note.attachments ?? []).some((file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '') || (file.type || '').startsWith('image/'));
      const fileView = document.getElementById('note-file-view');
      if (fileView) fileView.hidden = !hasFilePreview;
      if (hasFilePreview) setView('file');
      else if (note.source === 'import' && hasAttachments) setView('read');
      setStatus('所有更改已保存', 'saved'); renderPreview();
      if (enhancedUi) await refreshRelations();
      title.disabled = body.disabled = false; saveButton.disabled = false;
    } catch (error) {
      showError(`读取失败：${error.message}。请返回笔记列表后重新打开。`); setStatus('读取失败', 'error');
    }
  }

  function renderOutline() {
    outline.innerHTML = '';
    for (const match of body.value.matchAll(/^(#{1,3})\s+(.+)$/gm)) {
      const button = document.createElement('button'); button.type = 'button'; button.className = `note-outline-level-${match[1].length}`; button.textContent = match[2];
      button.addEventListener('click', () => { body.focus(); body.setSelectionRange(match.index, match.index); }); outline.appendChild(button);
    }
    if (!outline.children.length) outline.textContent = '正文中还没有标题';
  }

  function renderWikiSuggestions() {
    const before = body.value.slice(0, body.selectionStart);
    const match = before.match(/\[\[([^\]]*)$/);
    if (!match) { suggestions.hidden = true; return; }
    const needle = match[1].toLowerCase();
    const choices = noteIndex.filter((item) => item.id !== id && [item.title, ...(item.aliases || [])].some((name) => name.toLowerCase().includes(needle))).slice(0, 8);
    suggestions.innerHTML = '';
    for (const item of choices) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = `${item.title}${item.folder ? ` · ${item.folder}` : ''}`;
      button.addEventListener('click', () => {
        const start = body.selectionStart - match[0].length; body.setRangeText(`[[${item.title}]]`, start, body.selectionStart, 'end'); suggestions.hidden = true; body.focus(); changed();
      }); suggestions.appendChild(button);
    }
    suggestions.hidden = !choices.length;
  }

  async function refreshRelations() {
    if (!id) return;
    try {
      const [linkData, versionData] = await Promise.all([request(`/notes/${encodeURIComponent(id)}/links`), request(`/notes/${encodeURIComponent(id)}/versions`)]);
      linksPanel.innerHTML = '';
      const groups = [['引用', linkData.outgoing], ['反向链接', linkData.backlinks], ['未链接提及', linkData.unlinked]];
      for (const [label, items] of groups) {
        const heading = document.createElement('strong'); heading.textContent = `${label} · ${items.length}`; linksPanel.appendChild(heading);
        for (const item of items.slice(0, 12)) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = item.title || item.target;
          if (item.targetId || item.id) button.addEventListener('click', () => { const url = new URL(location.href); url.searchParams.set('id', item.targetId || item.id); location.href = url.href; });
          linksPanel.appendChild(button);
        }
      }
      versionsPanel.innerHTML = '';
      for (const version of versionData.items.slice(0, 12)) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = `${new Date(version.createdAt).toLocaleString()} · ${version.reason}`;
        button.addEventListener('click', async () => { if (!confirm('恢复这个历史版本？当前版本会先自动备份。')) return; await request(`/notes/${encodeURIComponent(id)}/versions/${encodeURIComponent(version.id)}/restore`, { method: 'POST', body: {} }); location.reload(); });
        versionsPanel.appendChild(button);
      }
      if (!versionData.items.length) versionsPanel.textContent = '还没有历史快照';
    } catch (error) { linksPanel.textContent = `关联读取失败：${error.message}`; }
  }

  if (enhancedUi) request('/notes?limit=500').then((result) => { noteIndex = result.items || []; }).catch(() => {});
  load();
})();
