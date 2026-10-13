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

test('三维知识星系支持旋转、缩放、节点拖动与原位预览，并在拖动后防止误开笔记', async () => {
  const app = bootRenderer({ api, state: { calendar: { mode: 'month', anchor: '2026-10-11' }, todo: { filter: 'all' } } });
  const mount = await app.render('notes'); const notes = app.PCModules.getService('notes'); let opens = 0;
  await notes.connectProvider({
    capabilities: () => ({}), listNotes: () => [summary(), summary({ id: 'note-2', title: '线性代数' }), summary({ id: 'note-3', title: '概率论' })],
    graph: async () => ({ nodes: [{ id: 'note-1', title: '高等数学', favorite: true }, { id: 'note-2', title: '线性代数' }, { id: 'note-3', title: '概率论' }], edges: [{ source: 'note-1', target: 'note-2' }, { source: 'note-2', target: 'note-3' }] }),
    openNote() { opens += 1; }, createCanvas: async () => ({}),
  });
  const graphTab = mount.querySelectorAll('button').find((button) => button.textContent === '知识图谱'); await graphTab.listeners.click[0](); await new Promise((resolve) => setTimeout(resolve, 20));
  const stage = mount.querySelector('.notes-graph-stage'); const satellite = mount.querySelector('.notes-graph-node');
  assert.equal(stage.querySelector('.notes-graph-orbits'), null, '背景不得显示虚线同心轨道'); assert.match(stage.textContent, /滚轮缩放/); assert.equal(stage.querySelector('.notes-graph-planet'), null, '中心不得再显示实体星球');
  assert.match(mount.querySelector('.notes-graph-controls').textContent, /标签圆形大小/); assert.match(mount.querySelector('.notes-graph-controls').textContent, /连线长度/); assert.match(mount.querySelector('.notes-graph-legend').textContent, /关系层级/);
  let nativeDragPrevented = false; stage.listeners.dragstart[0]({ preventDefault() { nativeDragPrevented = true; } }); assert.equal(nativeDragPrevented, true, '应禁止浏览器原生拖拽以避免禁用光标和文字残影');
  const beforeZoom = satellite.getAttribute('transform'); stage.listeners.wheel[0]({ deltaY: -100, preventDefault() {}, target: stage }); assert.notEqual(satellite.getAttribute('transform'), beforeZoom);
  const beforeRotate = satellite.getAttribute('transform'); stage.listeners.pointerdown[0]({ button: 0, clientX: 10, clientY: 10, pointerId: 1, target: stage, preventDefault() {} }); assert.equal(stage.classList.contains('is-rotating'), true); stage.listeners.pointermove[0]({ clientX: 420, clientY: 35, pointerId: 1, preventDefault() {} }); stage.listeners.pointerup[0]({ pointerId: 1 }); assert.equal(stage.classList.contains('is-rotating'), false); assert.notEqual(satellite.getAttribute('transform'), beforeRotate); assert.equal(opens, 0, '旋转知识星球时不得误开笔记');
  const translateX = (value) => Number(/translate\(([-\d.]+)/.exec(value)?.[1]); const beforeDrag = satellite.getAttribute('transform'); const beforeDragX = translateX(beforeDrag); satellite.listeners.pointerdown[0]({ button: 0, clientX: 100, clientY: 100, pointerId: 2, preventDefault() {}, stopPropagation() {} }); satellite.listeners.pointermove[0]({ clientX: 135, clientY: 120, pointerId: 2, preventDefault() {} }); satellite.listeners.pointerup[0]({ pointerId: 2 }); const afterDrag = satellite.getAttribute('transform'); assert.notEqual(afterDrag, beforeDrag); assert.ok(translateX(afterDrag) > beforeDragX, '即使图谱已转到背面，鼠标向右拖动时节点在屏幕上也必须向右移动'); assert.equal(opens, 0, '拖动卫星时不得误开笔记');
  satellite.listeners.keydown[0]({ key: 'Enter' }); await new Promise((resolve) => setTimeout(resolve, 1)); assert.equal(opens, 0, '轻触只应显示原位预览，不得直接跳转'); assert.ok(stage.querySelector('.notes-graph-preview'));
  const edit = stage.querySelectorAll('button').find((button) => button.textContent === '修改笔记'); await edit.listeners.click[0](); assert.equal(opens, 1, '只有点击修改笔记按钮才进入笔记页面');
});

test('Canvas 曲线随拖动实时更新，连线与卡片均可右键管理并安全删除', async () => {
  const app = bootRenderer({ api, state: { calendar: { mode: 'month', anchor: '2026-10-11' }, todo: { filter: 'all' } } });
  const mount = await app.render('notes'); const notes = app.PCModules.getService('notes');
  let canvas = { id: 'canvas-1', name: '测试画布', nodes: [{ id: 'n1', type: 'file', noteId: 'note-1', x: 20, y: 20 }, { id: 'n2', type: 'file', noteId: 'note-2', x: 240, y: 20 }], edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }] };
  let noteDeletes = 0;
  await notes.connectProvider({
    capabilities: () => ({}), listNotes: () => [summary(), summary({ id: 'note-2', title: '线性代数' })],
    listCanvases: async () => [canvas], updateCanvas: async (id, patch) => { canvas = { ...canvas, ...patch }; return canvas; },
    createCanvas: async () => canvas, deleteCanvas: async () => ({ deleted: true }), deleteNote: async () => { noteDeletes += 1; }, openNote() {},
  });
  const canvasTab = mount.querySelectorAll('button').find((button) => button.textContent === 'Canvas'); await canvasTab.listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));
  let card = mount.querySelector('.notes-canvas-node');
  const path = mount.querySelector('.notes-canvas-edge'); const oldCurve = path.getAttribute('d');
  card.listeners.pointerdown[0]({ button: 0, clientX: 20, clientY: 20, pointerId: 1 });
  card.listeners.pointermove[0]({ clientX: 100, clientY: 80, pointerId: 1 });
  assert.notEqual(path.getAttribute('d'), oldCurve, '拖动过程中曲线应实时跟随卡片');
  await card.listeners.pointerup[0]({ pointerId: 1 });
  let hit = mount.querySelector('.notes-canvas-edge-hit');
  hit.listeners.contextmenu[0]({ preventDefault() {}, stopPropagation() {}, clientX: 150, clientY: 90 });
  const elbow = mount.querySelectorAll('button').find((button) => button.textContent === '折线'); await elbow.listeners.click[0]();
  assert.equal(canvas.edges[0].lineType, 'elbow');
  hit = mount.querySelector('.notes-canvas-edge-hit'); hit.listeners.contextmenu[0]({ preventDefault() {}, stopPropagation() {}, clientX: 150, clientY: 90 });
  app.context.confirm = () => true;
  const removeEdge = mount.querySelectorAll('button').find((button) => button.textContent === '删除连接线'); await removeEdge.listeners.click[0]();
  assert.equal(canvas.edges.length, 0, '删除连接线不得删除两端卡片'); assert.equal(canvas.nodes.length, 2);
  card.listeners.contextmenu[0]({ preventDefault() {}, stopPropagation() {}, clientX: 100, clientY: 100 });
  const green = mount.querySelectorAll('button').find((button) => button.title === 'green'); await green.listeners.click[0]();
  assert.equal(canvas.nodes[0].color, 'green');
  card = mount.querySelector('.notes-canvas-node'); card.listeners.contextmenu[0]({ preventDefault() {}, stopPropagation() {}, clientX: 100, clientY: 100 });
  assert.equal(mount.querySelectorAll('button').some((button) => button.textContent === '置于顶层' || button.textContent === '置于底层'), false);
  const remove = mount.querySelectorAll('button').find((button) => button.textContent === '删除卡片'); await remove.listeners.click[0]({ stopPropagation() {} });
  assert.deepEqual(canvas.nodes.map((node) => node.id), ['n2']);
  assert.equal(canvas.edges.length, 0, '删除节点后不能保留悬空连线');
  assert.equal(noteDeletes, 0, '删除画布卡片不得删除原始笔记');
});

test('Canvas 可从全部笔记中选择添加，并在确认后应用 AI 美化建议', async () => {
  const app = bootRenderer({ api, state: { calendar: { mode: 'month', anchor: '2026-10-11' }, todo: { filter: 'all' } } });
  const mount = await app.render('notes'); const notes = app.PCModules.getService('notes');
  const allNotes = [summary(), summary({ id: 'note-2', title: '线性代数' }), summary({ id: 'note-3', title: '概率论', folder: '数学' })];
  let canvas = { id: 'canvas-2', name: 'AI 画布', nodes: [{ id: 'n1', type: 'file', noteId: 'note-1', x: 20, y: 20 }], edges: [] };
  await notes.connectProvider({
    capabilities: () => ({}), listNotes: () => allNotes, listCanvases: async () => [canvas], updateCanvas: async (id, patch) => { canvas = { ...canvas, ...patch }; return canvas; }, createCanvas: async () => canvas, deleteCanvas: async () => ({}), openNote() {},
    suggestCanvasDesign: async () => ({ model: 'test-ai', suggestion: { shape: 'hexagon', color: 'purple', lineType: 'elbow', lineStyle: 'dashed', lineColor: 'green', lineWidth: 3.5, arrow: 'both', advice: '把核心概念放在中央。' } }),
  });
  const canvasTab = mount.querySelectorAll('button').find((button) => button.textContent === 'Canvas'); await canvasTab.listeners.click[0](); await new Promise((resolve) => setTimeout(resolve, 20));
  const add = mount.querySelectorAll('button').find((button) => button.textContent === '添加笔记'); await add.listeners.click[0](); await new Promise((resolve) => setTimeout(resolve, 5));
  const probability = app.context.document.body.querySelectorAll('button').find((button) => button.textContent.includes('概率论')); await probability.listeners.click[0]();
  assert.equal(canvas.nodes.some((node) => node.noteId === 'note-3'), true, '选择器应能添加非当前笔记');
  const card = mount.querySelector('.notes-canvas-node'); card.listeners.contextmenu[0]({ preventDefault() {}, stopPropagation() {}, clientX: 80, clientY: 80 });
  const aiAction = mount.querySelectorAll('button').find((button) => button.textContent === 'AI 美化与画布建议'); await aiAction.listeners.click[0]({ stopPropagation() {} }); await new Promise((resolve) => setTimeout(resolve, 5));
  assert.match(app.context.document.body.textContent, /把核心概念放在中央/);
  const apply = app.context.document.body.querySelectorAll('button').find((button) => button.textContent === '应用此方案'); await apply.listeners.click[0]();
  assert.equal(canvas.nodes[0].shape, 'hexagon'); assert.equal(canvas.nodes[0].color, 'purple');
});
