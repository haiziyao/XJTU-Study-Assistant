import test from 'node:test';
import assert from 'node:assert/strict';

import { bootRenderer } from './helpers/renderer-dom.js';

const NOW = '2026-10-11T08:30:00.000Z';

function summary(overrides = {}) {
  return {
    id: 'note-1',
    title: '高等数学课堂笔记',
    source: 'manual',
    status: 'ready',
    anchor: { type: 'schedule', scheduleId: 'schedule-1', occurrenceDate: '2026-10-11' },
    tags: ['高数'],
    mediaCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function api(url) {
  if (url.startsWith('/calendar?')) return Promise.resolve({ days: [{ date: '2026-10-11', schedules: [{ id: 'schedule-1', title: '高等数学', startTime: '08:00', endTime: '09:40', location: 'A101' }] }] });
  return Promise.resolve({});
}

test('内置主程序 Provider 自动连接，笔记页不再停留在等待状态', async () => {
  const localApi = (url) => url.startsWith('/notes') ? Promise.resolve({ items: [] }) : api(url);
  const app = bootRenderer({ api: localApi, state: { calendar: { mode: 'month', anchor: '2026-10-11' }, todo: { filter: 'all' } } });
  const mount = await app.render('notes', { wait: 30 });
  assert.match(mount.textContent, /主程序已连接/);
  assert.doesNotMatch(mount.textContent, /等待主程序/);
});

test('笔记 Provider 与新富文本模块结合：摘要关联日程，正文只按需预览', async () => {
  const app = bootRenderer({ api, state: { calendar: { mode: 'month', anchor: '2026-10-11' }, todo: { filter: 'all' } } });
  const mount = await app.render('notes');
  const notes = app.PCModules.getService('notes');
  let markdownReads = 0;
  await notes.connectProvider({
    cacheNamespace: 'notes-test',
    capabilities: () => ({ markdown: true }),
    listNotes: () => [summary({ previewText: '只在内存展示的摘要' })],
    openNote() {},
    renderMarkdown: async () => { markdownReads += 1; return '# 重点\n\n**洛必达法则**'; },
  });

  assert.match(mount.textContent, /高等数学课堂笔记/);
  assert.match(mount.textContent, /08:00–09:40 高等数学 · A101/);
  const previewButton = mount.querySelectorAll('button').find((button) => button.textContent === '查看笔记');
  assert.ok(previewButton, 'Provider 声明能力后应出现查看笔记入口');
  await previewButton.listeners.click[0]();
  assert.equal(markdownReads, 1);
  const preview = app.context.document.body.querySelector('.notes-note-viewer');
  assert.match(preview.innerHTML, /<strong>洛必达法则<\/strong>/);
  assert.doesNotMatch(JSON.stringify(summary()), /洛必达法则/, '正文不进入 NoteSummary');
});

test('手动上传把 File 直接交给 Provider，返回摘要后可立即查看', async () => {
  const app = bootRenderer({ api, state: { calendar: { mode: 'month', anchor: '2026-10-11' }, todo: { filter: 'all' } } });
  const mount = await app.render('notes');
  const notes = app.PCModules.getService('notes');
  const received = [];
  await notes.connectProvider({
    capabilities: () => ({ upload: true, view: true }),
    listNotes: () => [],
    uploadNotes: async (files, input) => {
      received.push({ files, input });
      return summary({ id: 'import-1', title: input.title || files[0].name, source: 'import', anchor: input.anchor });
    },
    readNote: async () => ({ format: 'markdown', text: '## 上传成功\n\n正文由主程序读取。' }),
  });

  const uploadButton = mount.querySelectorAll('button').find((button) => button.textContent === '手动上传');
  assert.ok(uploadButton && !uploadButton.disabled);
  uploadButton.listeners.click[0]();
  const fileInput = app.context.document.body.querySelector('.notes-file-input');
  const titleInput = app.context.document.body.querySelector('.notes-title-input');
  const fakeFile = { name: '课堂记录.md', size: 1024, type: 'text/markdown', privateBody: '不应进入摘要' };
  fileInput.files = [fakeFile]; titleInput.value = '导入的课堂记录';
  fileInput.listeners.change[0]();
  const submit = app.context.document.body.querySelectorAll('button').find((button) => button.textContent === '上传并查看');
  await submit.listeners.click[0]();

  assert.equal(received.length, 1);
  assert.equal(received[0].files[0], fakeFile, '文件对象应原样交给 Provider');
  assert.equal(received[0].input.title, '导入的课堂记录');
  assert.match(mount.textContent, /导入的课堂记录/);
  assert.match(app.context.document.body.querySelector('.notes-note-viewer').innerHTML, /上传成功/);
  assert.doesNotMatch(JSON.stringify(notes.ingestSnapshot(summary({ id: 'safe' }))), /privateBody/);
});

test('笔记页只保留一个可用的随手拍入口，并把图片交给 Provider', async () => {
  const app = bootRenderer({ api, state: { calendar: { mode: 'month', anchor: '2026-10-11' }, todo: { filter: 'all' } } });
  const mount = await app.render('notes'); const notes = app.PCModules.getService('notes'); let captured;
  await notes.connectProvider({
    capabilities: () => ({ capture: true, view: true }), listNotes: () => [],
    startCapture: async (input) => { captured = input; return summary({ id: 'shot-1', title: input.title || '随手拍', source: 'snapshot', status: 'unorganized', mediaCount: 1, anchor: null }); },
    readNote: async () => ({ format: 'markdown', text: '图片笔记', attachments: [] }),
  });
  const buttons = mount.querySelectorAll('button').filter((button) => button.textContent === '随手拍');
  assert.equal(buttons.length, 1); assert.equal(buttons[0].disabled, false);
  buttons[0].listeners.click[0]();
  const input = app.context.document.body.querySelector('.notes-file-input'); input.files = [{ name: 'camera.jpg', type: 'image/jpeg', size: 100 }]; input.listeners.change[0]();
  app.context.document.body.querySelector('.notes-title-input').value = '黑板内容';
  const save = app.context.document.body.querySelectorAll('button').find((button) => button.textContent === '保存到笔记'); await save.listeners.click[0]();
  assert.equal(captured.files[0].name, 'camera.jpg'); assert.equal(captured.title, '黑板内容');
  assert.match(mount.textContent, /黑板内容/);
});

test('上传限制在调用 Provider 前生效，查看纯文本不会注入 HTML', async () => {
  const app = bootRenderer({ api, state: { calendar: { mode: 'month', anchor: '2026-10-11' }, todo: { filter: 'all' } } });
  const mount = await app.render('notes');
  const notes = app.PCModules.getService('notes');
  let uploads = 0;
  await notes.connectProvider({
    capabilities: () => ({ upload: true, view: true }),
    listNotes: () => [summary()],
    uploadNotes: () => { uploads += 1; return summary(); },
    readNote: () => ({ format: 'text', text: '<img src=x onerror=alert(1)>' }),
  });
  await assert.rejects(() => notes.upload([{ name: 'too-large.pdf', size: 6 * 1024 * 1024 + 1 }]), /超过 6 MB/);
  assert.equal(uploads, 0);
  const result = await notes.read('note-1');
  assert.equal(result.format, 'text'); assert.equal(result.text, '<img src=x onerror=alert(1)>');
  const viewButton = mount.querySelectorAll('button').find((button) => button.textContent === '查看笔记');
  await viewButton.listeners.click[0]();
  const viewer = app.context.document.body.querySelector('.notes-note-viewer');
  assert.equal(viewer.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(viewer.innerHTML, '', '纯文本不得进入 innerHTML');
});

test('AI 读取挂载点按能力开放，只返回白名单字段且限制上下文规模', async () => {
  const app = bootRenderer({ api, state: { calendar: { mode: 'month', anchor: '2026-10-11' }, todo: { filter: 'all' } } });
  await app.render('notes');
  const notes = app.PCModules.getService('notes');
  let request;
  await notes.connectProvider({
    capabilities: () => ({ aiRead: true }),
    listNotes: () => [],
    readNotesForAI: async (input) => {
      request = input;
      return [{ ...summary(), content: '供 AI 使用的正文', filePath: 'C:/private/note.md', token: 'secret' }];
    },
  });
  const result = await notes.readForAI({ ids: ['note-1', 'note-1'], query: '  极限  ', limit: 99 });
  assert.equal(request.ids.length, 1);
  assert.equal(request.query, '极限');
  assert.equal(request.limit, 20);
  assert.equal(result[0].text, '供 AI 使用的正文');
  assert.equal('filePath' in result[0], false);
  assert.equal('token' in result[0], false);
  assert.equal('content' in result[0], false);
});

test('Provider 未授权时 AI 不能读取笔记', async () => {
  const app = bootRenderer({ api, state: { calendar: { mode: 'month', anchor: '2026-10-11' }, todo: { filter: 'all' } } });
  await app.render('notes');
  const notes = app.PCModules.getService('notes');
  await notes.connectProvider({ capabilities: () => ({}), listNotes: () => [] });
  await assert.rejects(() => notes.readForAI({ ids: ['note-1'] }), /尚未提供 AI 读取笔记能力/);
});

test('随手拍挂载点按 ID 幂等更新，并拒绝图片或 OCR 载荷', async () => {
  const app = bootRenderer({ api, state: { calendar: { mode: 'month', anchor: '2026-10-11' }, todo: { filter: 'all' } } });
  const mount = await app.render('notes');
  const notes = app.PCModules.getService('notes');
  await notes.connectProvider({ capabilities: () => ({}), listNotes: () => [] });

  notes.ingestSnapshot(summary({ title: '第一次投递', source: 'snapshot', anchor: null }));
  notes.ingestSnapshot(summary({ title: '更新后的摘要', source: 'snapshot', anchor: null }));
  assert.equal(mount.querySelectorAll('.notes-card').length, 1);
  assert.match(mount.textContent, /更新后的摘要/);
  assert.throws(() => notes.ingestSnapshot({ ...summary(), images: ['data:image/png;base64,xx'] }), /只接受笔记摘要/);
  assert.throws(() => notes.ingestSnapshot({ ...summary(), ocrText: '敏感识别内容' }), /只接受笔记摘要/);
  assert.throws(() => notes.ingestSnapshot({ ...summary(), files: [{ name: 'note.md' }] }), /只接受笔记摘要/);
});

test('替换 Provider 会取消旧订阅', async () => {
  const app = bootRenderer({ api, state: { calendar: { mode: 'month', anchor: '2026-10-11' }, todo: { filter: 'all' } } });
  await app.render('notes');
  const notes = app.PCModules.getService('notes');
  let cancelled = 0;
  await notes.connectProvider({ capabilities: () => ({}), listNotes: () => [], subscribe: () => () => { cancelled += 1; } });
  await notes.connectProvider({ capabilities: () => ({}), listNotes: () => [] });
  assert.equal(cancelled, 1);
});
