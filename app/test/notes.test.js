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
  const previewButton = mount.querySelectorAll('button').find((button) => button.textContent === 'Markdown 预览');
  assert.ok(previewButton, 'Provider 声明能力后应出现 Markdown 预览入口');
  await previewButton.listeners.click[0]();
  assert.equal(markdownReads, 1);
  const preview = app.context.document.body.querySelector('.notes-markdown-preview');
  assert.match(preview.innerHTML, /<strong>洛必达法则<\/strong>/);
  assert.doesNotMatch(JSON.stringify(summary()), /洛必达法则/, '正文不进入 NoteSummary');
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
