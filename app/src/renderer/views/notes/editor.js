/** Standalone Markdown editing; note bodies stay in memory until explicitly saved. */
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const apiBase = (params.get('api') || (location.protocol.startsWith('http') ? `${location.origin}/api/v1` : 'http://127.0.0.1:3210/api/v1')).replace(/\/$/, '');
  const title = document.getElementById('note-title');
  const tags = document.getElementById('note-tags');
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
  const properties = document.getElementById('note-properties');
  let id = params.get('id');
  let updatedAt = null;
  let loaded = !id;
  let saving = false;
  let leaving = false;
  let hasAttachments = false;
  let saved = '';
  let previewTimer;
  let past = [];
  let future = [];
  let previousBody = { text: body.value, start: 0, end: 0 };
  const snapshot = () => JSON.stringify({ title: title.value, tags: tags.value, body: body.value });
  const dirty = () => snapshot() !== saved;

  // Keep explicit API routing when the editor is opened from an Electron/file page.
  const returnUrl = new URL(location.protocol === 'file:' ? '../../index.html' : '../../', location.href);
  returnUrl.searchParams.set('view', 'notes');
  if (params.has('api')) returnUrl.searchParams.set('api', apiBase);
  back.href = returnUrl.href;

  function setStatus(text, state = '') { status.textContent = text; status.dataset.state = state; }
  function showError(message = '') { errorBox.textContent = message; errorBox.hidden = !message; }
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
    } else window.PCRichText.render(preview, body.value);
    document.getElementById('word-count').textContent = `${body.value.length.toLocaleString()} 字符 · ${body.value.split('\n').length} 行`;
    document.title = `${title.value.trim() || '未命名笔记'}${dirty() ? ' *' : ''} · 智学笔记`;
  }
  function changed(record = true) {
    if (record) rememberEdit();
    renderSource();
    if (!saving) setStatus(dirty() ? '有未保存的更改' : id ? '所有更改已保存' : '新笔记 · 尚未保存', dirty() ? 'dirty' : id ? 'saved' : '');
    clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 100);
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
  async function save() {
    if (saving || !loaded) return false;
    if (body.value.length > 200000) { showError('正文最多支持 200,000 字符，请精简后再保存。'); return false; }
    const submitted = snapshot();
    const fields = {
      title: title.value.trim() || '未命名笔记', body: body.value,
      tags: tags.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean).slice(0, 12),
      format: 'markdown', status: body.value.trim() || hasAttachments ? 'ready' : 'draft',
    };
    if (id) fields.expectedUpdatedAt = updatedAt;
    saving = true; saveButton.disabled = true; showError(); setStatus('正在保存…');
    try {
      const result = await request(id ? `/notes/${encodeURIComponent(id)}` : '/notes', { method: id ? 'PATCH' : 'POST', body: fields });
      id = result.summary.id; updatedAt = result.summary.updatedAt;
      const url = new URL(location.href); url.searchParams.set('id', id); history.replaceState(null, '', url.href);
      // Edits typed during a slow request remain dirty; only the submitted snapshot was saved.
      if (snapshot() === submitted) {
        title.value = fields.title; tags.value = fields.tags.join('，'); saved = snapshot();
      } else saved = submitted;
      setStatus(dirty() ? '有未保存的更改' : '所有更改已保存', dirty() ? 'dirty' : 'saved');
      renderPreview();
      return !dirty();
    } catch (error) { showError(`保存失败：${error.message}`); setStatus('保存失败，正文仍在当前页面', 'error'); return false; }
    finally { saving = false; saveButton.disabled = false; }
  }
  saveButton.addEventListener('click', save);
  for (const input of [title, tags, body]) input.addEventListener('input', () => changed());
  body.addEventListener('beforeinput', captureSelection);
  body.addEventListener('scroll', syncSource);
  undoButton.addEventListener('click', () => restoreEdit(past, future));
  redoButton.addEventListener('click', () => restoreEdit(future, past));
  document.querySelectorAll('button[data-view]').forEach((button) => button.addEventListener('click', () => {
    editor.dataset.view = button.dataset.view;
    document.querySelectorAll('button[data-view]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
    if (button.dataset.view === 'read') renderPreview();
  }));
  document.addEventListener('click', (event) => {
    if (properties.open && !properties.contains(event.target)) properties.open = false;
  });
  properties.addEventListener('keydown', (event) => { if (event.key === 'Escape') { properties.open = false; properties.querySelector('summary')?.focus(); } });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
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
      heading: ['## ', '', '标题'], bold: ['**', '**', '粗体文字'], italic: ['*', '*', '斜体文字'],
      list: ['- ', '', '列表项'], quote: ['> ', '', '引用内容'], code: ['```\n', '\n```', '代码'],
      link: ['[', '](https://example.com)', '链接文字'],
      strike: ['~~', '~~', '文字'], table: ['| 列一 | 列二 |\n| --- | --- |\n| ', ' | 内容 |\n', '内容'],
    };
    const [before, after, sample] = formats[button.dataset.format];
    const lineFormat = ['heading', 'list', 'quote', 'code', 'table'].includes(button.dataset.format);
    const newline = lineFormat && start > 0 && body.value[start - 1] !== '\n' ? '\n' : '';
    body.setRangeText(`${newline}${before}${selected || sample}${after}`, start, end, 'end');
    body.focus(); body.setSelectionRange(start + newline.length + before.length, start + newline.length + before.length + (selected || sample).length);
    changed();
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
    const success = await save();
    button.disabled = false;
    leaveDialog.close();
    if (success) leave();
  });
  saved = snapshot(); resetHistory(); renderPreview();
  async function load() {
    if (!id) { title.focus(); return; }
    saveButton.disabled = true; title.disabled = tags.disabled = body.disabled = true; setStatus('正在读取笔记…');
    try {
      const { note } = await request(`/notes/${encodeURIComponent(id)}`);
      title.value = note.title; tags.value = (note.tags || []).join('，'); body.value = note.body || '';
      updatedAt = note.updatedAt; saved = snapshot(); loaded = true;
      resetHistory();
      hasAttachments = Boolean(note.attachments?.length);
      const attachments = document.getElementById('note-attachments');
      if (note.attachments?.length) {
        attachments.hidden = false; attachments.textContent = `已保留附件：${note.attachments.map((file) => file.name).join('、')}`;
      }
      setStatus('所有更改已保存', 'saved'); renderPreview();
      title.disabled = tags.disabled = body.disabled = false; saveButton.disabled = false;
    } catch (error) {
      showError(`读取失败：${error.message}。请返回笔记列表后重新打开。`); setStatus('读取失败', 'error');
    }
  }
  load();
})();
