import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { El } from './helpers/renderer-dom.js';

const script = readFileSync(new URL('../src/renderer/views/notes/editor.js', import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));
function setup(fetchImpl, id = '') {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, new El(id === 'note-body' ? 'textarea' : 'div'));
    if (id === 'note-body') nodes.get(id).setSelectionRange = function (start, end) { this.selectionStart = start; this.selectionEnd = end; };
    if (id === 'leave-dialog') {
      nodes.get(id).showModal = function () { this.open = true; };
      nodes.get(id).close = function () { this.open = false; };
    }
    return nodes.get(id);
  };
  const events = {};
  const context = {
    URL, URLSearchParams, console,
    location: { href: `http://127.0.0.1:3210/app/views/notes/editor.html${id ? `?id=${id}` : ''}`, search: id ? `?id=${id}` : '', origin: 'http://127.0.0.1:3210', protocol: 'http:' },
    document: { title: '', getElementById: get, createElement: (tag) => new El(tag), querySelectorAll: () => [], addEventListener: (name, handler) => { events[name] = handler; } },
    fetch: fetchImpl,
    setTimeout(handler) { handler(); return 0; }, clearTimeout() {}, requestAnimationFrame(handler) { handler(); },
    history: { replaceState(state, unused, href) { context.location.href = href; } },
    addEventListener: (name, handler) => { events[name] = handler; },
    PCRichText: { render(node, text) { node.textContent = text; }, escapeHtml(text) { return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]); } },
  };
  context.window = context;
  vm.runInNewContext(script, context);
  return { get, context, events, input(id, text) { get(id).value = text; get(id).listeners.input[0](); }, save: () => get('save-note').listeners.click[0]() };
}
const ok = (payload) => ({ ok: true, json: async () => payload });

test('源码配色转义 HTML，撤销与重做保持正文和保存状态一致', async () => {
  const app = setup(async () => ok({ summary: { id: 'note-1', updatedAt: 'version-1' } }));
  app.input('note-body', '# 标题\n<script>alert(1)</script>');
  assert.equal(app.get('note-highlight').innerHTML.includes('<script>'), false);
  assert.match(app.get('note-highlight').innerHTML, /&lt;script&gt;/);
  assert.equal(app.get('note-line-numbers').textContent, '1\n2');
  await app.save();
  app.input('note-body', '# 新内容');
  app.get('undo-note').listeners.click[0]();
  assert.equal(app.get('note-body').value, '# 标题\n<script>alert(1)</script>');
  assert.equal(app.get('save-status').dataset.state, 'saved');
  app.get('redo-note').listeners.click[0]();
  assert.equal(app.get('note-body').value, '# 新内容');
  assert.equal(app.get('save-status').dataset.state, 'dirty');
  app.get('undo-note').listeners.click[0]();
  app.input('note-body', '# 另一个修改');
  assert.equal(app.get('redo-note').disabled, true, '撤销后输入应清空重做记录');
});

test('编辑页首次保存创建笔记，再次保存更新同一 ID，刷新可读取正文', async () => {
  const calls = [];
  const app = setup(async (url, options) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body) });
    return ok({ summary: { id: 'note-1', updatedAt: `version-${calls.length}` } });
  });
  app.input('note-title', '学习笔记'); app.input('note-body', '# 初稿');
  await app.save();
  assert.equal(calls[0].method, 'POST'); assert.equal(calls[0].body.body, '# 初稿');
  assert.equal(new URL(app.context.location.href).searchParams.get('id'), 'note-1');
  app.input('note-body', '## 修改后的正文');
  await app.save();
  assert.equal(calls[1].method, 'PATCH'); assert.ok(calls[1].url.endsWith('/notes/note-1'));
  assert.equal(calls[1].body.expectedUpdatedAt, 'version-1');
  assert.equal(app.get('save-status').dataset.state, 'saved');

  const reopened = setup(async () => ok({ note: { title: '学习笔记', body: '## 修改后的正文', tags: ['复习'], updatedAt: 'version-2', attachments: [] } }), 'note-1');
  await flush();
  assert.equal(reopened.get('note-body').value, '## 修改后的正文');
  assert.equal(reopened.get('note-tags').value, '复习');
  assert.equal(reopened.get('save-note').disabled, false);

  let attachmentUpdate;
  const attachmentOnly = setup(async (url, options) => {
    if (!options.method) return ok({ note: { title: '课件', body: '', tags: [], updatedAt: 'version-1', attachments: [{ name: '课件.pdf' }] } });
    attachmentUpdate = JSON.parse(options.body);
    return ok({ summary: { id: 'note-file', updatedAt: 'version-2' } });
  }, 'note-file');
  await flush(); attachmentOnly.input('note-title', '课件说明'); await attachmentOnly.save();
  assert.equal(attachmentUpdate.status, 'ready', '只有附件的已整理笔记不能因编辑标题而退回草稿');
});

test('慢保存期间继续输入不会被标成已保存，也不会发起重复创建', async () => {
  let resolve;
  let requests = 0;
  const app = setup(() => { requests += 1; return new Promise((done) => { resolve = done; }); });
  app.input('note-body', '第一次提交');
  const pending = app.save();
  await app.save();
  app.input('note-body', '保存期间继续输入');
  resolve(ok({ summary: { id: 'note-1', updatedAt: 'version-1' } }));
  await pending;
  assert.equal(requests, 1);
  assert.equal(app.get('note-body').value, '保存期间继续输入');
  assert.equal(app.get('save-status').dataset.state, 'dirty');
  let prevented = false;
  app.events.beforeunload({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
});

test('保存失败保留输入和离开提醒；读取失败时不能覆盖旧笔记', async () => {
  const app = setup(async () => { throw new Error('网络中断'); });
  app.input('note-body', '不能丢失的正文');
  await app.save();
  assert.equal(app.get('note-body').value, '不能丢失的正文');
  assert.match(app.get('editor-error').textContent, /网络中断/);
  assert.equal(app.get('save-note').disabled, false);
  let prevented = false;
  app.get('back-to-notes').listeners.click[0]({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(app.get('leave-dialog').open, true);
  app.get('leave-cancel').listeners.click[0]();
  assert.equal(app.get('leave-dialog').open, false);
  assert.equal(app.get('note-body').value, '不能丢失的正文');
  app.get('leave-discard').listeners.click[0]();
  app.events.beforeunload({ preventDefault() { throw new Error('已确认离开，不应再弹第二次提示'); } });

  let requests = 0;
  const missing = setup(async () => { requests += 1; return { ok: false, status: 404, json: async () => ({ error: { message: '笔记不存在' } }) }; }, 'missing');
  await flush(); await missing.save();
  assert.equal(requests, 1, '读取失败后不得发送更新');
  assert.equal(missing.get('save-note').disabled, true);
});

test('保存并返回只在保存成功后离开，异步回调不依赖已失效的事件 currentTarget', async () => {
  const app = setup(async () => ok({ summary: { id: 'note-1', updatedAt: 'version-1' } }));
  app.input('note-body', '# 保存后返回');
  app.get('back-to-notes').listeners.click[0]({ preventDefault() {} });
  const button = app.get('leave-save');
  const event = { currentTarget: button };
  const pending = button.listeners.click[0](event);
  event.currentTarget = null; // Browsers clear this when the dispatch finishes, before an await resumes.
  await pending;
  assert.equal(new URL(app.context.location.href).searchParams.get('view'), 'notes');
  assert.equal(button.disabled, false);
  app.events.beforeunload({ preventDefault() { throw new Error('保存后返回不应提示丢失更改'); } });

  const failed = setup(async () => { throw new Error('断网'); });
  failed.input('note-body', '必须保留');
  await failed.get('leave-save').listeners.click[0]({ currentTarget: failed.get('leave-save') });
  assert.ok(failed.context.location.href.includes('editor.html'));
  assert.equal(failed.get('note-body').value, '必须保留');
});
