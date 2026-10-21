/**
 * 手机端的笔记：列表 / 阅读 / 编辑三层，全部长在手机外壳里。
 *
 * 桌面版是「筛选工具栏 + 列表 + 详情 + 图谱 / 画布」的多面板布局，塞进手机一列后
 * 每一块都只剩半屏。这里按手机的使用顺序重排：先看列表，点开读，再进编辑；
 * 正文仍由 `PCRichText` 渲染，保存仍走 `PATCH /notes/:id`，数据层没有第二份。
 *
 * 返回时先问一句，未保存的正文不会因为一次误触消失；保存带 `expectedUpdatedAt`，
 * 别的页面先改过就提示冲突。阅读与编辑都在外壳页面栈里，返回键回到笔记而不是主页。
 */
(function () {
  'use strict';

  const root = document.documentElement;
  if (!root?.classList?.contains?.('m-app')) return;

  const UI = window.PCMobileUI;
  const Logic = window.PCMobileLogic;
  if (!UI || !Logic) return;

  const { h, iconButton, cell, section, tag, emptyState, skeleton, button, navButton, field, segmented, searchField } = UI;

  const api = (path, options) => window.PC.api(path, options);
  const shell = () => window.PCMobileShell;

  const state = { host: null, chrome: null, items: [], query: '', loading: true, error: null, requestId: 0 };

  // 列表摘要只留可读文字：去掉标题井号、引用/列表符号、强调与行内代码标记。
  function plain(text) {
    return String(text ?? '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
      .replace(/`{1,3}/g, '')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/~~(.*?)~~/g, '$1');
  }

  function clean(text, max = 70) {
    const value = plain(text).replace(/\s+/g, ' ').trim();
    if (!value) return '';
    return value.length > max ? `${value.slice(0, max)}…` : value;
  }

  function noteSubtitle(item) {
    const preview = clean(item.previewText, 62);
    if (preview) return preview;
    if (Number(item.mediaCount) > 0) return `${item.mediaCount} 张图片`;
    return '空白笔记';
  }

  async function loadList() {
    const id = ++state.requestId;
    state.loading = true;
    state.error = null;
    paintList();
    try {
      const query = state.query ? `&query=${encodeURIComponent(state.query)}` : '';
      const res = await api(`/notes?limit=200${query}`);
      if (id !== state.requestId) return;
      state.items = Array.isArray(res?.items) ? res.items : [];
    } catch (error) {
      if (id !== state.requestId) return;
      state.error = error?.message ?? '加载失败';
    } finally {
      if (id === state.requestId) {
        state.loading = false;
        paintList();
      }
    }
  }

  function paintList() {
    const host = state.host;
    if (!host) return;

    state.chrome?.setAppbar?.({
      title: '笔记',
      right: iconButton({ icon: 'plus', label: '新建笔记', onClick: () => openEditor(null) }),
    });

    host.replaceChildren();
    host.append(
      searchField({
        placeholder: '搜索标题或正文',
        value: state.query,
        onInput: (value) => {
          if (value === state.query) return;
          state.query = value;
          loadList();
        },
      }),
    );

    if (state.loading) {
      host.append(skeleton(5));
      return;
    }
    if (state.error) {
      host.append(UI.errorState({ message: state.error, onRetry: () => loadList() }));
      return;
    }
    if (!state.items.length) {
      host.append(
        emptyState({
          icon: 'note',
          title: state.query ? '没有匹配的笔记' : '还没有笔记',
          message: state.query ? '换个关键词试试。' : '把想法、课堂记录和截图都放进来。',
          action: state.query ? null : { label: '新建笔记', onClick: () => openEditor(null) },
        }),
      );
      return;
    }

    const list = section({ header: `${state.items.length} 篇笔记` });
    for (const item of state.items) {
      const meta =
        Array.isArray(item.tags) && item.tags.length
          ? h('span', { class: 'm-cell-meta m-note-tags' }, ...item.tags.slice(0, 3).map((name) => tag(name, 'blue')))
          : null;
      list.list.append(
        cell({
          title: item.title || '未命名笔记',
          subtitle: noteSubtitle(item),
          meta,
          value: Logic.relativeTime(item.updatedAt),
          onClick: () => openNote(item.id),
        }),
      );
    }
    host.append(list);
  }

  function openNote(id) {
    return shell()?.pushPage?.({ title: '笔记', render: (page) => renderDetail(page, id) });
  }

  function metaLine(note) {
    const parts = [Logic.relativeTime(note.updatedAt)];
    if (note.folder) parts.push(note.folder);
    if (note.format === 'text') parts.push('纯文本');
    return parts.filter(Boolean).join(' · ');
  }

  async function renderDetail(page, id) {
    page.append(skeleton(5));
    let note = null;
    try {
      note = (await api(`/notes/${encodeURIComponent(id)}`)).note;
    } catch (error) {
      page.replaceChildren(UI.errorState({ message: error?.message ?? '读取失败', onRetry: () => renderDetail(page, id) }));
      return;
    }
    if (!page.isConnected) return;

    shell()?.setAppbar?.({
      title: note.title || '笔记',
      back: true,
      right: iconButton({ icon: 'edit', label: '编辑笔记', onClick: () => openEditor(note.id) }),
    });

    const head = h(
      'header',
      { class: 'm-note-head' },
      h('h1', { class: 'm-note-title', text: note.title || '未命名笔记' }),
      h('p', { class: 'm-note-meta', text: metaLine(note) }),
      Array.isArray(note.tags) && note.tags.length
        ? h('div', { class: 'm-note-tagrow' }, ...note.tags.map((name) => tag(name, 'blue')))
        : null,
    );

    const body = h('article', { class: 'm-note-body' });
    const text = String(note.body ?? '');
    if (!text.trim()) {
      body.append(h('p', { class: 'm-note-empty', text: '这篇笔记还是空的。' }));
    } else if (note.format === 'markdown' && window.PCRichText?.render) {
      try {
        window.PCRichText.render(body, text);
      } catch {
        body.textContent = text;
      }
    } else {
      body.textContent = text;
    }

    const actions = h(
      'div',
      { class: 'm-note-actions' },
      button({ label: '编辑', icon: 'edit', variant: 'tinted', block: true, onClick: () => openEditor(note.id) }),
      button({
        label: '删除',
        icon: 'trash',
        variant: 'destructive',
        block: true,
        onClick: async () => {
          const ok = await UI.confirm({ title: '删除笔记', message: note.title || '未命名笔记', confirmLabel: '删除', destructive: true });
          if (!ok) return;
          try {
            await api(`/notes/${encodeURIComponent(note.id)}`, { method: 'DELETE' });
            window.PC.toast?.('已移到回收站');
            shell()?.popPage?.({ force: true });
            loadList();
          } catch (error) {
            window.PC.toast?.(error?.message ?? '删除失败');
          }
        },
      }),
    );

    page.replaceChildren(head, body, actions);
  }

  function openEditor(id) {
    const detailEntry = shell()?.currentPage?.() ?? null;
    const guard = { check: () => true };
    return shell()?.pushPage?.({
      title: id ? '编辑笔记' : '新建笔记',
      beforePop: () => guard.check(),
      render: (page) => renderEditor(page, id, detailEntry, guard),
    });
  }

  async function renderEditor(page, id, detailEntry, guard) {
    page.append(skeleton(4));
    let note = { id: null, title: '', body: '', tags: [], format: 'markdown', updatedAt: null };
    if (id) {
      try {
        note = (await api(`/notes/${encodeURIComponent(id)}`)).note;
      } catch (error) {
        page.replaceChildren(UI.errorState({ message: error?.message ?? '读取失败', onRetry: () => renderEditor(page, id, detailEntry, guard) }));
        return;
      }
      if (!page.isConnected) return;
    }

    const snapshot = {
      title: note.title ?? '',
      body: note.body ?? '',
      tags: Array.isArray(note.tags) ? note.tags.join('，') : '',
      updatedAt: note.updatedAt ?? null,
    };

    const titleField = field({ label: '', placeholder: '标题', value: snapshot.title, autofocus: !id });
    titleField.classList.add('m-note-editor-title');
    const tagsField = field({ label: '标签', placeholder: '用逗号分隔', value: snapshot.tags });
    const bodyInput = h('textarea', {
      class: 'm-note-editor-body',
      placeholder: '写点什么… 支持 Markdown 与 $LaTeX$',
      'aria-label': '笔记正文',
      spellcheck: 'false',
    });
    bodyInput.value = snapshot.body;

    const preview = h('article', { class: 'm-note-body m-note-editor-preview' });
    preview.hidden = true;

    const dirty = () =>
      titleField.input.value !== snapshot.title ||
      bodyInput.value !== snapshot.body ||
      tagsField.input.value !== snapshot.tags;

    let saving = false;
    const saveButton = navButton({ label: '保存', strong: true, onClick: () => save() });

    async function save() {
      if (saving) return;
      saving = true;
      saveButton.disabled = true;
      saveButton.textContent = '保存中…';
      const title = titleField.input.value.trim() || '未命名笔记';
      const body = bodyInput.value;
      const tags = tagsField.input.value
        .split(/[,，、\s]+/)
        .map((item) => item.trim())
        .filter(Boolean);
      try {
        if (note.id) {
          await api(`/notes/${encodeURIComponent(note.id)}`, {
            method: 'PATCH',
            body: { title, body, tags, expectedUpdatedAt: snapshot.updatedAt },
          });
          snapshot.title = title;
          snapshot.body = body;
          snapshot.tags = tags.join('，');
          window.PC.toast?.('已保存');
          if (detailEntry) detailEntry.render = (node) => renderDetail(node, note.id);
          shell()?.popPage?.({ force: true });
        } else {
          const created = await api('/notes', { method: 'POST', body: { title, body, tags, source: 'manual', status: 'draft' } });
          const createdId = created?.summary?.id;
          snapshot.title = title;
          snapshot.body = body;
          snapshot.tags = tags.join('，');
          window.PC.toast?.('已创建');
          const entry = shell()?.currentPage?.();
          if (entry && createdId) {
            entry.title = '笔记';
            entry.render = (node) => renderDetail(node, createdId);
            shell()?.rerender?.();
          }
        }
      } catch (error) {
        window.PC.toast?.(error?.message ?? '保存失败');
      } finally {
        saving = false;
        saveButton.disabled = false;
        saveButton.textContent = '保存';
      }
    }

    shell()?.setAppbar?.({ title: id ? '编辑笔记' : '新建笔记', back: true, right: saveButton });

    guard.check = () => {
      if (!dirty()) return true;
      // 同步返回值必须是「没退」，确认框是异步的：用户点「放弃」后再强制退一层。
      UI.confirm({
        title: '放弃修改？',
        message: '这篇笔记还有未保存的改动。',
        confirmLabel: '放弃',
        cancelLabel: '继续编辑',
        destructive: true,
      }).then((ok) => {
        if (ok) shell()?.popPage?.({ force: true });
      });
      return false;
    };

    const toggle = segmented({
      items: [
        { value: 'edit', label: '编辑' },
        { value: 'preview', label: '预览' },
      ],
      value: 'edit',
      label: '编辑或预览',
      onChange: (value) => {
        const previewing = value === 'preview';
        bodyInput.hidden = previewing;
        preview.hidden = !previewing;
        if (previewing) {
          preview.replaceChildren();
          if (window.PCRichText?.render) window.PCRichText.render(preview, bodyInput.value || '（空白笔记）');
          else preview.textContent = bodyInput.value;
        }
      },
    });

    page.replaceChildren(
      h(
        'div',
        { class: 'm-note-editor' },
        h('div', { class: 'm-note-editor-fields' }, titleField, tagsField),
        h('div', { class: 'm-note-editor-tools' }, toggle),
        bodyInput,
        preview,
      ),
    );

    if (!id) titleField.input.focus();
  }

  function mount(host, chrome) {
    state.host = host;
    state.chrome = chrome ?? null;
    state.query = '';
    state.items = [];
    state.loading = true;
    paintList();
    loadList();
  }

  // `plain` 也给主页的「最近笔记」摘要复用，避免两处各写一套 Markdown 清洗。
  window.PCMobileNotes = { mount, openNote, openEditor, plain };
})();
