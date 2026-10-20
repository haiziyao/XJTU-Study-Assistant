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
  assert.doesNotMatch(mount.textContent, /08:00–09:40 高等数学 · A101/, '列表卡片只显示标题和状态标签');
  const card = mount.querySelector('.notes-card');
  card.listeners.contextmenu[0]({ preventDefault() {}, stopPropagation() {}, clientX: 30, clientY: 40 });
  assert.match(app.context.document.body.querySelector('.notes-card-menu').textContent, /08:00–09:40 高等数学 · A101/, '完整关联信息保留在右击菜单');
  app.context.document.body.querySelector('.notes-card-menu').remove();
  assert.equal(markdownReads, 0, '正文只能在用户单击笔记后按需读取');
  card.listeners.click[0](); await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(markdownReads, 1);
  const preview = mount.querySelector('.notes-detail-preview');
  assert.match(preview.innerHTML, /<strong>洛必达法则<\/strong>/);
  assert.doesNotMatch(JSON.stringify(summary()), /洛必达法则/, '正文不进入 NoteSummary');
});

test('笔记工具栏隐藏手动上传、今日笔记和模板新建入口，并启用点击动效', async () => {
  const app = bootRenderer({ api, state: { calendar: { mode: 'month', anchor: '2026-10-11' }, todo: { filter: 'all' } } });
  const mount = await app.render('notes');
  const notes = app.PCModules.getService('notes');
  await notes.connectProvider({
    capabilities: () => ({ upload: true, view: true }),
    listNotes: () => [],
    uploadNotes: async () => summary({ id: 'import-1', source: 'import' }),
    daily: async () => summary({ id: 'daily-1' }),
    templates: async () => [],
  });

  const labels = mount.querySelectorAll('button').map((button) => button.textContent);
  assert.equal(labels.includes('手动上传'), false);
  assert.equal(labels.includes('今日笔记'), false);
  assert.equal(labels.includes('从模板新建'), false);
  assert.equal(labels.includes('随手拍'), true);
  assert.equal(labels.includes('专注模式'), true);
  assert.ok(mount.listeners.pointerdown?.length, '笔记根节点应绑定统一点击动效');
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
  mount.querySelector('.notes-card').listeners.click[0](); await new Promise((resolve) => setTimeout(resolve, 5));
  const viewer = mount.querySelector('.notes-detail-preview');
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

test('右击笔记卡片可查看并保存属性，正文编辑器不再承担属性管理', async () => {
  const app = bootRenderer({ api, state: { calendar: { mode: 'month', anchor: '2026-10-11' }, todo: { filter: 'all' } } });
  const mount = await app.render('notes');
  const notes = app.PCModules.getService('notes');
  let patch; let opens = 0;
  const original = summary({
    folder: '数学/高数', aliases: ['微积分'], favorite: false,
    properties: { course: '高等数学', chapter: '第一章', type: '课堂笔记', status: '学习中', custom: '必须保留' },
  });
  await notes.connectProvider({
    capabilities: () => ({ edit: true, manage: true }),
    listNotes: () => [original],
    openNote: () => { opens += 1; }, deleteNote: async () => ({}),
    updateNote: async (id, input) => { patch = input; return { ...original, ...input, updatedAt: '2026-10-14T06:00:00.000Z' }; },
  });

  const card = mount.querySelector('.notes-card');
  await card.listeners.dblclick[0](); assert.equal(opens, 1, '双击笔记卡片应直接打开编辑器');
  let prevented = false;
  card.listeners.contextmenu[0]({ preventDefault() { prevented = true; }, stopPropagation() {}, clientX: 100, clientY: 100 });
  assert.equal(prevented, true);
  const menuText = app.context.document.body.querySelector('.notes-card-menu').textContent;
  assert.match(menuText, /编辑笔记/); assert.match(menuText, /收藏/); assert.match(menuText, /移至回收站/); assert.match(menuText, /目录/); assert.match(menuText, /创建/);
  assert.doesNotMatch(menuText, /查看完整笔记/, '右侧已经提供正文预览，右键菜单不应保留重复入口');
  const propertiesAction = app.context.document.body.querySelectorAll('button').find((button) => button.textContent === '查看或修改属性');
  assert.ok(propertiesAction, '右键菜单应提供属性入口'); await propertiesAction.listeners.click[0]();
  assert.match(app.context.document.body.textContent, /笔记属性 · 高等数学课堂笔记/);
  const folder = app.context.document.body.querySelector('.notes-properties-folder');
  const aliases = app.context.document.body.querySelector('.notes-properties-aliases');
  const studyStatus = app.context.document.body.querySelector('.notes-properties-study-status');
  assert.equal(folder.value, '数学/高数'); assert.equal(aliases.value, '微积分'); assert.match(studyStatus.textContent, /学习中/);
  folder.value = '数学/期末复习'; aliases.value = '高数，微积分'; studyStatus.value = '待复习';
  app.context.document.body.querySelector('.notes-properties-favorite').checked = true;
  await app.context.document.body.querySelector('.notes-properties-save').listeners.click[0]();
  assert.equal(patch.folder, '数学/期末复习');
  assert.deepEqual(Array.from(patch.aliases), ['高数', '微积分']);
  assert.equal(patch.favorite, true); assert.equal(patch.properties.status, '待复习');
  assert.equal(patch.properties.custom, '必须保留', '界面不认识的自定义属性不能被覆盖掉');
  assert.equal(patch.expectedUpdatedAt, NOW);
  const updatedCard = mount.querySelector('.notes-card');
  updatedCard.listeners.contextmenu[0]({ preventDefault() {}, stopPropagation() {}, clientX: 100, clientY: 100 });
  assert.match(app.context.document.body.querySelector('.notes-card-menu').textContent, /数学\/期末复习/, '精简列表后目录应保留在右击菜单');
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
  const mount = await app.render('notes'); const notes = app.PCModules.getService('notes'); let opens = 0; let graphFilters;
  await notes.connectProvider({
    capabilities: () => ({}), listNotes: () => [summary(), summary({ id: 'note-2', title: '线性代数' }), summary({ id: 'note-3', title: '概率论' }), summary({ id: 'note-4', title: '大学物理' }), summary({ id: 'note-5', title: '未连接笔记' })],
    graph: async (filters) => { graphFilters = filters; return { nodes: [{ id: 'note-1', title: '高等数学', favorite: true }, { id: 'note-2', title: '线性代数' }, { id: 'note-3', title: '概率论' }, { id: 'note-4', title: '大学物理' }, { id: 'note-5', title: '未连接笔记' }], edges: [{ source: 'note-1', target: 'note-2' }, { source: 'note-2', target: 'note-3' }, { source: 'note-1', target: 'note-4' }] }; },
    openNote() { opens += 1; }, createCanvas: async () => ({}),
  });
  const graphTab = mount.querySelectorAll('button').find((button) => button.textContent === '知识图谱'); await graphTab.listeners.click[0](); await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(Object.keys(graphFilters), [], '知识图谱首次打开应默认请求全部笔记，而不是限制为当前笔记两层');
  const stage = mount.querySelector('.notes-graph-stage'); const satellite = mount.querySelector('.notes-graph-node');
  assert.equal(stage.querySelector('.notes-graph-orbits'), null, '背景不得显示虚线同心轨道'); assert.match(stage.textContent, /滚轮缩放/); assert.equal(stage.querySelector('.notes-graph-planet'), null, '中心不得再显示实体星球');
  const graphNodes = mount.querySelectorAll('.notes-graph-node'); assert.equal(graphNodes.filter((node) => node.dataset.motion === 'core').length, 1); assert.equal(graphNodes.filter((node) => node.dataset.motion === 'orbit').length, 3, '与核心连通的标签应作为卫星环绕'); const driftingNode = graphNodes.find((node) => node.dataset.motion === 'drift'); assert.ok(driftingNode, '与核心不连通的标签应留在星系内漂浮而不参与环绕'); const driftingX = Number(/translate\(([-\d.]+)/.exec(driftingNode.getAttribute('transform'))?.[1]); assert.ok(driftingX > 80 && driftingX < 820, '未连接标签不应被放到整张图边缘');
  assert.doesNotMatch(mount.querySelector('.notes-graph-controls').textContent, /标签圆形大小/, '全局面板不应再放置节点大小'); assert.match(mount.querySelector('.notes-graph-controls').textContent, /连线长度/); assert.match(mount.querySelector('.notes-graph-legend').textContent, /同层同色/);
  const levelOneNodes = mount.querySelectorAll('.notes-graph-node').filter((node) => node.dataset.level === '1'); assert.equal(levelOneNodes.length, 2); const levelOneFills = levelOneNodes.map((node) => node.querySelectorAll('circle').find((circle) => circle.className === '').style.getPropertyValue('fill')); assert.equal(levelOneFills[0], levelOneFills[1], '同一关系层级默认必须使用相同颜色');
  let contextPrevented = false; satellite.listeners.contextmenu[0]({ clientX: 120, clientY: 100, preventDefault() { contextPrevented = true; }, stopPropagation() {} }); assert.equal(contextPrevented, true); const graphMenu = stage.querySelector('.notes-graph-menu'); assert.match(graphMenu.textContent, /标签圆形大小/); assert.match(graphMenu.textContent, /应用到第 0 层全部标签/); assert.match(graphMenu.textContent, /查看或修改笔记属性/);
  const circle = satellite.querySelectorAll('circle').find((item) => item.className === ''); const initialRadius = Number(circle.getAttribute('r')); const nodeSize = graphMenu.querySelector('.notes-graph-node-size'); nodeSize.value = '1.8'; nodeSize.listeners.input[0](); assert.ok(Number(circle.getAttribute('r')) > initialRadius, '右键菜单应能单独修改节点大小'); const nodeColor = graphMenu.querySelector('.notes-graph-node-color'); nodeColor.value = '#ff3366'; nodeColor.listeners.input[0](); assert.equal(circle.style.getPropertyValue('fill'), '#ff3366', '右键菜单应能单独修改节点颜色');
  levelOneNodes[0].listeners.contextmenu[0]({ clientX: 180, clientY: 120, preventDefault() {}, stopPropagation() {} }); const levelMenu = stage.querySelector('.notes-graph-menu'); const levelColor = levelMenu.querySelector('.notes-graph-node-color'); levelColor.value = '#12aabb'; levelColor.listeners.input[0](); const applyLevel = levelMenu.querySelectorAll('button').find((button) => /应用到第 1 层/.test(button.textContent)); applyLevel.listeners.click[0](); const updatedLevelFills = levelOneNodes.map((node) => node.querySelectorAll('circle').find((item) => item.className === '').style.getPropertyValue('fill')); assert.deepEqual(updatedLevelFills, ['#12aabb', '#12aabb'], '自定义层级颜色后同层所有标签必须一起更新');
  let nativeDragPrevented = false; stage.listeners.dragstart[0]({ preventDefault() { nativeDragPrevented = true; } }); assert.equal(nativeDragPrevented, true, '应禁止浏览器原生拖拽以避免禁用光标和文字残影');
  const beforeZoom = satellite.getAttribute('transform'); stage.listeners.wheel[0]({ deltaY: -100, preventDefault() {}, target: stage }); assert.notEqual(satellite.getAttribute('transform'), beforeZoom);
  const rotatingNode = graphNodes.find((node) => node.dataset.motion === 'orbit'); const beforeRotate = rotatingNode.getAttribute('transform'); stage.listeners.pointerdown[0]({ button: 0, clientX: 10, clientY: 10, pointerId: 1, target: stage, preventDefault() {} }); assert.equal(stage.classList.contains('is-rotating'), true); stage.listeners.pointermove[0]({ clientX: 420, clientY: 35, pointerId: 1, preventDefault() {} }); stage.listeners.pointerup[0]({ pointerId: 1 }); assert.equal(stage.classList.contains('is-rotating'), false); assert.notEqual(rotatingNode.getAttribute('transform'), beforeRotate); assert.equal(opens, 0, '旋转知识星球时不得误开笔记');
  const translateX = (value) => Number(/translate\(([-\d.]+)/.exec(value)?.[1]); const beforeDrag = satellite.getAttribute('transform'); const beforeDragX = translateX(beforeDrag); const orbitNode = graphNodes.find((node) => node.dataset.motion === 'orbit'); const orbitBeforeCoreDrag = orbitNode.getAttribute('transform'); satellite.listeners.pointerdown[0]({ button: 0, clientX: 100, clientY: 100, pointerId: 2, preventDefault() {}, stopPropagation() {} }); satellite.listeners.pointermove[0]({ clientX: 135, clientY: 120, pointerId: 2, preventDefault() {} }); const orbitDuringCoreDrag = orbitNode.getAttribute('transform'); satellite.listeners.pointerup[0]({ pointerId: 2 }); const afterDrag = satellite.getAttribute('transform'); assert.notEqual(afterDrag, beforeDrag); assert.ok(translateX(afterDrag) > beforeDragX, '即使图谱已转到背面，鼠标向右拖动时节点在屏幕上也必须向右移动'); assert.ok(Math.abs(translateX(orbitDuringCoreDrag) - translateX(orbitBeforeCoreDrag)) < 1, '拖动核心天体时不得把整个卫星群刚性平移，卫星只允许保留自然漂移并由连线弹性重新排布'); assert.equal(opens, 0, '拖动核心天体时不得误开笔记');
  satellite.listeners.keydown[0]({ key: 'Enter' }); await new Promise((resolve) => setTimeout(resolve, 1)); assert.equal(opens, 0, '轻触只应显示原位预览，不得直接跳转'); assert.ok(stage.querySelector('.notes-graph-preview'));
  const edit = stage.querySelectorAll('button').find((button) => button.textContent === '修改笔记'); await edit.listeners.click[0](); assert.equal(opens, 1, '只有点击修改笔记按钮才进入笔记页面');
  const dimension = mount.querySelector('.notes-graph-dimension'); assert.match(dimension.textContent, /三维星系/); assert.match(dimension.textContent, /二维海洋/); dimension.value = '2d'; dimension.listeners.change[0](); await new Promise((resolve) => setTimeout(resolve, 5));
  const ocean = mount.querySelector('.notes-graph-stage'); assert.equal(ocean.classList.contains('is-ocean'), true); assert.doesNotMatch(ocean.textContent, /正在生成知识图谱/, '复用已生成图谱时必须清除加载占位'); assert.match(ocean.textContent, /核心居中/); assert.match(ocean.textContent, /暂停漂流/); const oceanCore = ocean.querySelector('.notes-graph-node'); assert.match(oceanCore.getAttribute('transform'), /translate\(450\.00 280\.00\)/, '二维海洋中连接最核心的标签首次打开应位于中央'); ocean.listeners.pointerdown[0]({ button: 0, clientX: 20, clientY: 20, pointerId: 9, target: ocean, preventDefault() {} }); assert.equal(ocean.classList.contains('is-rotating'), false, '二维模式不得旋转场景');
  const coreBeforeDrag = translateX(oceanCore.getAttribute('transform')); oceanCore.listeners.pointerdown[0]({ button: 0, clientX: 100, clientY: 100, pointerId: 10, preventDefault() {}, stopPropagation() {} }); oceanCore.listeners.pointermove[0]({ clientX: 128, clientY: 112, pointerId: 10, preventDefault() {} }); oceanCore.listeners.pointerup[0]({ pointerId: 10 }); assert.ok(translateX(oceanCore.getAttribute('transform')) > coreBeforeDrag, '二维海洋的核心标签也必须可以自由拖动');
  const backToGalaxy = mount.querySelector('.notes-graph-dimension'); backToGalaxy.value = '3d'; backToGalaxy.listeners.change[0](); await new Promise((resolve) => setTimeout(resolve, 5)); assert.doesNotMatch(mount.querySelector('.notes-graph-stage').textContent, /正在生成知识图谱/, '切回三维星系也不得残留加载占位');
});

test('Canvas 曲线随拖动实时更新，连线与卡片均可右键管理并安全删除', async () => {
  const app = bootRenderer({ api, state: { calendar: { mode: 'month', anchor: '2026-10-11' }, todo: { filter: 'all' } } });
  const mount = await app.render('notes'); const notes = app.PCModules.getService('notes');
  let canvas = { id: 'canvas-1', name: '测试画布', nodes: [{ id: 'n1', type: 'file', noteId: 'note-1', x: 20, y: 20 }, { id: 'n2', type: 'file', noteId: 'note-2', x: 240, y: 20 }], edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }] };
  let noteDeletes = 0; let noteOpens = 0;
  await notes.connectProvider({
    capabilities: () => ({}), listNotes: () => [summary(), summary({ id: 'note-2', title: '线性代数' })],
    listCanvases: async () => [canvas], updateCanvas: async (id, patch) => { canvas = { ...canvas, ...patch }; return canvas; },
    createCanvas: async () => canvas, deleteCanvas: async () => ({ deleted: true }), deleteNote: async () => { noteDeletes += 1; }, openNote() { noteOpens += 1; },
  });
  const canvasTab = mount.querySelectorAll('button').find((button) => button.textContent === 'Canvas'); await canvasTab.listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));
  let card = mount.querySelector('.notes-canvas-node');
  card.listeners.click[0]({ target: card });
  assert.equal(mount.querySelector('.notes-canvas-preview'), null, '单击和拖动结束后不应弹出笔记内容预览');
  card.listeners.dblclick[0]({ stopPropagation() {} }); assert.equal(noteOpens, 1, '双击笔记卡片应直接打开笔记');
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
  const menuBeforeZoom = mount.querySelector('.notes-canvas-menu'); const board = mount.querySelector('.notes-canvas-board'); board.listeners.wheel[0]({ deltaY: -100, clientX: 160, clientY: 120, preventDefault() {} });
  assert.equal(mount.querySelector('.notes-canvas-menu'), menuBeforeZoom, '滚轮缩放重绘画布时标签属性菜单不应消失');
  const green = mount.querySelectorAll('button').find((button) => button.title === 'green'); await green.listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(canvas.nodes.find((node) => node.id === 'n1').color, 'green');
  card = mount.querySelector('.notes-canvas-node'); card.listeners.contextmenu[0]({ preventDefault() {}, stopPropagation() {}, clientX: 100, clientY: 100 });
  assert.equal(mount.querySelectorAll('button').some((button) => button.textContent === '置于顶层' || button.textContent === '置于底层'), false);
  const remove = mount.querySelectorAll('button').find((button) => button.textContent === '删除节点或分支'); await remove.listeners.click[0]({ stopPropagation() {} });
  const confirmRemove = app.context.document.body.querySelectorAll('button').find((button) => button.textContent === '删除节点'); await confirmRemove.listeners.click[0]();
  assert.deepEqual(canvas.nodes.map((node) => node.id), ['n2']);
  assert.equal(canvas.edges.length, 0, '删除节点后不能保留悬空连线');
  assert.equal(noteDeletes, 0, '删除画布卡片不得删除原始笔记');
});

test('Canvas 父子线可设置外观，保存后保留样式并同步同类子主题配色', async () => {
  const app = bootRenderer({ api }); const mount = await app.render('notes');
  let canvas = { id: 'edge-settings', name: '连线设置', nodes: [
    { id: 'root', type: 'text', text: '中心', x: 20, y: 100 },
    { id: 'a', type: 'text', text: '同类一', parentId: 'root', color: 'blue', x: 320, y: 20 },
    { id: 'b', type: 'text', text: '同类二', parentId: 'root', color: 'blue', x: 320, y: 180 },
  ], edges: [{ id: 'old', kind: 'hierarchy', fromNode: 'root', toNode: 'a', lineColor: 'purple' }] };
  await app.PCModules.getService('notes').connectProvider({
    capabilities: () => ({}), listNotes: () => [], listCanvases: async () => [canvas],
    updateCanvas: async (id, patch) => { Object.assign(canvas, patch); return canvas; }, openNote() {},
  });
  await mount.querySelectorAll('button').find((button) => button.textContent === 'Canvas').listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(canvas.edges.every((edge) => edge.lineColor === 'blue'), true, '旧的不一致连线应自动跟随同类子主题');
  const openMenu = () => mount.querySelector('.notes-canvas-edge-hit').listeners.contextmenu[0]({ preventDefault() {}, stopPropagation() {}, clientX: 100, clientY: 100 });
  const choose = async (label) => { openMenu(); await mount.querySelector('.notes-canvas-edge-menu').querySelectorAll('button').find((button) => button.textContent === label).listeners.click[0](); };
  await choose('折线'); await choose('虚线'); await choose('粗');
  assert.equal(canvas.edges[0].lineType, 'elbow'); assert.equal(canvas.edges[0].lineStyle, 'dashed'); assert.equal(canvas.edges[0].lineWidth, 5);
  openMenu(); await mount.querySelector('.notes-canvas-edge-menu').querySelectorAll('button').find((button) => button.title === 'green').listeners.click[0]();
  assert.equal(canvas.edges.every((edge) => edge.lineColor === 'green'), true, '手动颜色应同步到相同父级、同类子主题连线');
  const root = mount.querySelectorAll('.notes-canvas-node').find((node) => node.dataset.nodeId === 'root');
  await root.querySelector('.notes-canvas-child-add').listeners.click[0]({ stopPropagation() {} });
  assert.equal(canvas.edges.every((edge) => edge.lineColor === 'green'), true, '新增同类子主题应继承该组手动颜色');
  await choose('恢复自动配色（跟随子主题）');
  assert.equal(canvas.edges.every((edge) => edge.lineColor === 'blue'), true);
  assert.equal(canvas.edges[0].lineStyle, 'dashed', '恢复自动颜色不应重置线型');
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
  const probability = app.context.document.body.querySelectorAll('button').find((button) => button.textContent.includes('概率论')); const algebra = app.context.document.body.querySelectorAll('button').find((button) => button.textContent.includes('线性代数')); probability.listeners.click[0]();
  assert.equal(app.context.document.body.querySelectorAll('button').find((button) => button.textContent.includes('概率论')), probability, '勾选笔记时不应重建列表或改变卡片尺寸'); assert.equal(probability.classList.contains('selected'), true);
  algebra.listeners.click[0]();
  assert.equal(canvas.nodes.some((node) => node.noteId === 'note-3'), false, '勾选时不应逐篇关闭弹窗并立即写入画布');
  const addBatch = app.context.document.body.querySelectorAll('button').find((button) => button.textContent === '添加 2 篇笔记'); await addBatch.listeners.click[0]();
  assert.equal(canvas.nodes.some((node) => node.noteId === 'note-2'), true); assert.equal(canvas.nodes.some((node) => node.noteId === 'note-3'), true, '选择器应一次批量添加多篇笔记');
  const card = mount.querySelector('.notes-canvas-node'); card.listeners.contextmenu[0]({ preventDefault() {}, stopPropagation() {}, clientX: 80, clientY: 80 });
  assert.equal(mount.querySelectorAll('button').some((button) => button.textContent === '打开原笔记'), false, '右键菜单不再重复提供打开原笔记');
  const aiAction = mount.querySelectorAll('button').find((button) => button.textContent === '✦ AI 助手'); await aiAction.listeners.click[0]({ stopPropagation() {} });
  const aiChoices = app.context.document.body.querySelectorAll('.notes-canvas-ai-choice'); assert.equal(aiChoices.length, 2, 'AI 功能应合并在一个双选项入口中'); await aiChoices[1].listeners.click[0](); await new Promise((resolve) => setTimeout(resolve, 5));
  assert.match(app.context.document.body.textContent, /把核心概念放在中央/);
  const apply = app.context.document.body.querySelectorAll('button').find((button) => button.textContent === '应用此方案'); await apply.listeners.click[0]();
  assert.equal(canvas.nodes[0].shape, 'hexagon'); assert.equal(canvas.nodes[0].color, 'purple');
});

test('Canvas 统一自由节点与层级关系，兼容旧导图并提供快捷键帮助', async () => {
  const app = bootRenderer({ api, state: { calendar: { mode: 'month', anchor: '2026-10-11' }, todo: { filter: 'all' } } });
  const mount = await app.render('notes'); const notes = app.PCModules.getService('notes');
  let canvas = { id: 'canvas-mixed', name: '混合知识画布', nodes: [
    { id: 'free-1', type: 'text', text: '原有自由卡片', x: 30, y: 30 },
    { id: 'legacy-root', type: 'mind', text: '旧中心主题', role: 'root', mindMapId: 'mind-old', x: 260, y: 70 },
    { id: 'legacy-child', type: 'mind', text: '旧子主题', mindMapId: 'mind-old', mindLevel: 1, parentId: 'legacy-root', x: 510, y: 70 },
  ], edges: [{ id: 'legacy-edge', fromNode: 'legacy-root', toNode: 'legacy-child', mindmap: true }] };
  await notes.connectProvider({
    capabilities: () => ({}), listNotes: () => [summary()], listCanvases: async () => [canvas],
    updateCanvas: async (id, patch) => { Object.assign(canvas, patch); return canvas; }, createCanvas: async () => canvas, deleteCanvas: async () => ({}), openNote() {},
  });
  assert.equal(mount.querySelectorAll('button').some((button) => button.textContent === '数据库视图'), false);
  const canvasTab = mount.querySelectorAll('button').find((button) => button.textContent === 'Canvas'); await canvasTab.listeners.click[0](); await new Promise((resolve) => setTimeout(resolve, 20));
  const modeToolbar = mount.querySelector('.notes-toolbar');
  assert.equal(modeToolbar.classList.contains('notes-toolbar-canvas-compact'), true, 'Canvas 模式应使用紧凑的顶部导航');
  assert.equal(modeToolbar.querySelector('.notes-filter-row'), null, 'Canvas 模式不应占用空间显示笔记搜索与排序');
  assert.equal(modeToolbar.querySelector('.seg'), null, 'Canvas 模式不应显示笔记状态筛选');
  assert.equal(mount.querySelectorAll('button').some((button) => button.textContent.includes('插入思维导图')), false, '旧独立导图入口必须移除');
  const toolbar = mount.querySelector('.notes-canvas-toolbar'); const toolbarToggle = mount.querySelector('.notes-canvas-toolbar-toggle');
  assert.equal(toolbar.querySelectorAll('.notes-canvas-toolbar-group').length, 4, '展开工具栏应按画布、添加、结构、导出与帮助分组');
  assert.equal(toolbar.querySelectorAll('button').some((button) => button.textContent === '连接节点'), false, '重复的连接节点按钮应从工具栏移除');
  assert.match(toolbarToggle.textContent, /收起工具栏/); toolbarToggle.listeners.click[0]();
  assert.equal(toolbar.classList.contains('is-collapsed'), true); assert.equal(mount.querySelector('.notes-canvas-hint').hidden, true);
  assert.match(toolbarToggle.textContent, /展开工具栏/); toolbarToggle.listeners.click[0](); assert.equal(toolbar.classList.contains('is-collapsed'), false);
  assert.equal(canvas.nodes.find((node) => node.id === 'legacy-root').type, 'text');
  assert.equal(canvas.nodes.some((node) => 'mindMapId' in node || 'mindLevel' in node || 'role' in node), false);
  assert.equal(canvas.edges.find((edge) => edge.id === 'legacy-edge').kind, 'hierarchy');
  const board = mount.querySelector('.notes-canvas-board');
  board.listeners.dblclick[0]({ target: board, clientX: 160, clientY: 240 }); await new Promise((resolve) => setTimeout(resolve, 10));
  const root = canvas.nodes.find((node) => node.text === '新主题' && !node.parentId); assert.ok(root, '双击空白应创建根主题');
  const rootCard = mount.querySelectorAll('.notes-canvas-node').find((node) => node.dataset.nodeId === root.id);
  let selectedTitle = null;
  app.context.document.createRange = () => ({ selectNodeContents(node) { selectedTitle = node; } });
  app.context.window.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
  rootCard.listeners.dblclick[0]({ stopPropagation() {} });
  assert.equal(selectedTitle, rootCard.querySelector('.notes-canvas-node-content'), '双击标签编辑时应默认全选完整标题');
  await rootCard.querySelector('.notes-canvas-child-add').listeners.click[0]({ stopPropagation() {} }); await new Promise((resolve) => setTimeout(resolve, 10));
  const child = canvas.nodes.find((node) => node.parentId === root.id); assert.ok(child, '节点旁加号应创建子主题');
  assert.equal(child.shape, root.shape, '新子主题应继承父主题边框形状');
  assert.ok(canvas.edges.some((edge) => edge.fromNode === root.id && edge.toNode === child.id && edge.kind === 'hierarchy'));
  assert.ok(Number(child.x) > Number(root.x), '新子主题只设置右侧初始位置，不重排已有节点');
  assert.equal(Number(child.x), Number(root.x) + Number(root.width) + 48, '第一个子主题应位于父主题正右方');
  assert.equal(Number(child.y), Number(root.y), '第一个子主题应与父主题水平对齐');
  const refreshedRootCard = mount.querySelectorAll('.notes-canvas-node').find((node) => node.dataset.nodeId === root.id);
  await refreshedRootCard.querySelector('.notes-canvas-child-add').listeners.click[0]({ stopPropagation() {} }); await new Promise((resolve) => setTimeout(resolve, 10));
  const sameLevelChildren = canvas.nodes.filter((node) => node.parentId === root.id);
  assert.equal(sameLevelChildren.length, 2); assert.equal(sameLevelChildren[0].color, sameLevelChildren[1].color, '同一层级新建的子主题应默认使用相同颜色');
  const layoutSelect = toolbar.querySelectorAll('select')[1]; const tidyButton = toolbar.querySelectorAll('button').find((button) => button.textContent === '整理结构');
  const applyLayout = async (mode) => { layoutSelect.value = mode; tidyButton.listeners.click[0](); const apply = app.context.document.body.querySelectorAll('button').findLast((button) => button.textContent === '应用排列'); await apply.listeners.click[0](); await new Promise((resolve) => setTimeout(resolve, 10)); };
  mount.querySelectorAll('.notes-canvas-node').find((node) => node.dataset.nodeId === root.id).listeners.click[0]({ target: mount.querySelectorAll('.notes-canvas-node').find((node) => node.dataset.nodeId === root.id) });
  await applyLayout('right');
  const rightChildren = canvas.nodes.filter((node) => node.parentId === root.id).sort((a, b) => a.y - b.y);
  assert.ok(rightChildren.every((node) => node.x >= root.x + root.width + 138), '向右展开应为父子标签保留清晰的连线通道');
  assert.ok(rightChildren[1].y - rightChildren[0].y >= rightChildren[0].height + 47, '向右展开的同级标签不能贴在一起');
  await applyLayout('balanced');
  const balancedChildren = canvas.nodes.filter((node) => node.parentId === root.id);
  assert.ok(balancedChildren.some((node) => node.x + node.width < root.x) && balancedChildren.some((node) => node.x > root.x + root.width), '左右平衡应根据分支占位把节点分配到根节点两侧');
  await applyLayout('tree');
  const treeChildren = canvas.nodes.filter((node) => node.parentId === root.id).sort((a, b) => a.x - b.x);
  assert.ok(treeChildren.every((node) => node.y >= root.y + root.height + 126), '树状排列应留出足够的上下层间距');
  assert.ok(treeChildren[1].x - treeChildren[0].x >= treeChildren[0].width + 71, '树状排列的同级标签不能横向粘连');
  const collapseButton = mount.querySelectorAll('.notes-canvas-node').find((node) => node.dataset.nodeId === root.id).querySelector('.notes-canvas-collapse');
  let collapsePointerStopped = false; collapseButton.listeners.pointerdown[0]({ stopPropagation() { collapsePointerStopped = true; } });
  assert.equal(collapsePointerStopped, true, '减号热区按下时不应触发节点拖动'); assert.ok(collapseButton.querySelector('.notes-canvas-collapse-glyph'), '减号图形应置于独立的大热区中');
  await collapseButton.listeners.click[0]({ preventDefault() {}, stopPropagation() {} });
  assert.equal(mount.querySelectorAll('.notes-canvas-node').some((node) => sameLevelChildren.some((childNode) => childNode.id === node.dataset.nodeId)), false, '点击减号应立即折叠子主题');
  const expandButton = mount.querySelectorAll('.notes-canvas-node').find((node) => node.dataset.nodeId === root.id).querySelector('.notes-canvas-collapse');
  await expandButton.listeners.click[0]({ preventDefault() {}, stopPropagation() {} });
  assert.equal(mount.querySelectorAll('.notes-canvas-node').some((node) => sameLevelChildren.some((childNode) => childNode.id === node.dataset.nodeId)), true, '点击扩展热区应恢复子主题');
  const hierarchyPath = mount.querySelector('.notes-canvas-edge.hierarchy').getAttribute('d');
  const coordinates = hierarchyPath.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const [startX, startY, control1X, control1Y, control2X, control2Y, endX, endY] = coordinates;
  const mostlyVertical = Math.abs(endY - startY) > Math.abs(endX - startX);
  assert.ok(mostlyVertical ? (control1Y - startY) * (endY - startY) >= 0 && (endY - control2Y) * (endY - startY) >= 0 : (control1X - startX) * (endX - startX) >= 0 && (endX - control2X) * (endX - startX) >= 0, '父子曲线控制点应顺着排列方向延伸，不能反向形成回环');
  const exportSelect = toolbar.querySelectorAll('select')[2]; assert.equal(exportSelect.value, 'markdown', '默认导出格式应为 Markdown');
  assert.equal(exportSelect.querySelectorAll('option')[0].textContent, 'Markdown', 'Markdown 后不应重复显示扩展名');
  const canvasFocus = toolbar.querySelector('.notes-canvas-focus'); assert.ok(canvasFocus, 'Canvas 工具栏应恢复专注模式入口');
  assert.equal(canvasFocus.textContent, '专注模式'); assert.equal(canvasFocus.parentNode, toolbar, '专注模式应独立于导出与帮助分组');
  assert.equal(toolbar.querySelector('.notes-canvas-toolbar-group-output').querySelector('.notes-canvas-focus'), null, '导出分组内不应再包含专注模式');
  const adjustedRootCard = mount.querySelectorAll('.notes-canvas-node').find((node) => node.dataset.nodeId === root.id);
  adjustedRootCard.listeners.pointerdown[0]({ button: 0, target: adjustedRootCard, clientX: 200, clientY: 200, pointerId: 20 });
  adjustedRootCard.listeners.pointermove[0]({ target: adjustedRootCard, clientX: 260, clientY: 235, pointerId: 20 });
  await adjustedRootCard.listeners.pointerup[0]({ pointerId: 20 });
  const movedRootX = Number.parseFloat(adjustedRootCard.style.left); const movedRootY = Number.parseFloat(adjustedRootCard.style.top);
  for (let index = 0; index < 5; index += 1) board.listeners.wheel[0]({ deltaY: 100, clientX: 200, clientY: 180, preventDefault() {} });
  assert.ok(Math.abs(canvas.viewport.zoom - .5) < .001, '测试应先把画布缩到最小比例'); const cardBeforePan = mount.querySelectorAll('.notes-canvas-node').find((node) => node.dataset.nodeId === root.id); const visualXBeforePan = Number.parseFloat(cardBeforePan.style.left); const visualYBeforePan = Number.parseFloat(cardBeforePan.style.top); const panStartX = canvas.viewport.x; const panStartY = canvas.viewport.y;
  board.listeners.pointerdown[0]({ button: 0, target: board, clientX: 100, clientY: 100, pointerId: 21, preventDefault() {} });
  board.listeners.pointermove[0]({ target: board, clientX: 75, clientY: 80, pointerId: 21 });
  assert.equal(canvas.viewport.x, panStartX - 25, '缩小后拖动画布仍应更新水平视口偏移'); assert.equal(canvas.viewport.y, panStartY - 20, '缩小后拖动画布仍应更新垂直视口偏移');
  assert.equal(Number.parseFloat(cardBeforePan.style.left), visualXBeforePan - 25); assert.equal(Number.parseFloat(cardBeforePan.style.top), visualYBeforePan - 20);
  board.listeners.pointerup[0]({ target: board, pointerId: 21 });
  const savedRootX = root.x; const savedRootY = root.y; const beforeZoom = canvas.viewport.zoom; const beforeOffsetX = canvas.viewport.x; const beforeOffsetY = canvas.viewport.y; const contentAtPointerX = (200 - beforeOffsetX) / beforeZoom; const contentAtPointerY = (180 - beforeOffsetY) / beforeZoom;
  const canvasWidthBefore = Number.parseFloat(board.querySelector('.notes-canvas-lines').style.width); board.listeners.wheel[0]({ deltaY: -100, clientX: 200, clientY: 180, preventDefault() {} });
  const canvasWidthAfter = Number.parseFloat(board.querySelector('.notes-canvas-lines').style.width); assert.ok(canvasWidthAfter > canvasWidthBefore, '普通滚轮应直接缩放画布');
  const zoomedRootCard = mount.querySelectorAll('.notes-canvas-node').find((node) => node.dataset.nodeId === root.id);
  assert.equal(root.x, savedRootX); assert.equal(root.y, savedRootY, '缩放不能重置用户调整后的节点坐标');
  assert.ok(Math.abs((200 - canvas.viewport.x) / canvas.viewport.zoom - contentAtPointerX) < .01, '缩放前后鼠标指向的横向内容位置应保持不变');
  assert.ok(Math.abs((180 - canvas.viewport.y) / canvas.viewport.zoom - contentAtPointerY) < .01, '缩放前后鼠标指向的纵向内容位置应保持不变');
  assert.ok(Number.isFinite(Number.parseFloat(zoomedRootCard.style.left)) && Number.isFinite(Number.parseFloat(zoomedRootCard.style.top)));
  const childCard = mount.querySelectorAll('.notes-canvas-node').find((node) => node.dataset.nodeId === child.id);
  await childCard.listeners.keydown[0]({ key: 'Backspace', preventDefault() {}, stopPropagation() {} }); await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(canvas.nodes.some((node) => node.id === child.id), false, 'Backspace 应直接删除选中节点');
  const help = mount.querySelector('.notes-canvas-help-button'); await help.listeners.click[0]();
  assert.match(app.context.document.body.textContent, /Shift \+ Tab/); assert.match(app.context.document.body.textContent, /拖动连接点/);
  assert.match(mount.querySelector('.notes-canvas-hint').textContent, /所有卡片均可自由拖动/);
  canvasFocus.listeners.click[0](); await new Promise((resolve) => setTimeout(resolve, 20)); const focusToolbar = mount.querySelector('.notes-canvas-toolbar'); assert.equal(focusToolbar.classList.contains('is-focus-mode'), true, '专注模式应启用单行紧凑工具栏布局');
});
