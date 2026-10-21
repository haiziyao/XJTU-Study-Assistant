import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { parseWikiLinks } from '../src/modules/notes/service.js';
import { extractPdfMarkdown } from '../src/modules/notes/docx.js';

test('PDF 自定义字体编码与损坏文本不会被当成可读正文', () => {
  const extract = (source) => extractPdfMarkdown({ name: '课程.pdf', type: 'application/pdf', dataUrl: `data:application/pdf;base64,${Buffer.from(source, 'latin1').toString('base64')}` });
  assert.equal(extract('%PDF-1.4\n1 0 obj << /Subtype /Type0 /Encoding /Identity-H >> endobj\n2 0 obj <<>>stream\nBT (wrong glyph ids) Tj ET\nendstream\nendobj'), '');
  assert.equal(extract('%PDF-1.4\n1 0 obj <<>>stream\nBT (\x80\x81\x82garbled) Tj ET\nendstream\nendobj'), '');
});

function storedZip(name, content) {
  const fileName = Buffer.from(name); const data = Buffer.from(content);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(fileName.length, 28);
  const directoryOffset = local.length + fileName.length + data.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(central.length + fileName.length, 12); eocd.writeUInt32LE(directoryOffset, 16);
  return Buffer.concat([local, fileName, data, central, fileName, eocd]);
}

async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-obsidian-'));
  const app = await createServer({ dataDir });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { app, call };
}

test('Wiki 链接支持标题、章节和显示文字', () => {
  assert.deepEqual(parseWikiLinks('[[极限]] [[极限#定义|核心定义]] [[线性代数|矩阵课]]'), [
    { target: '极限', heading: null, alias: null },
    { target: '极限', heading: '定义', alias: '核心定义' },
    { target: '线性代数', heading: null, alias: '矩阵课' },
  ]);
});

test('上传 DOCX 会提取标题、段落和表格，同时保留原始附件', async () => {
  const { app, call } = await fixture();
  try {
    const xml = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 极限</w:t></w:r></w:p><w:p><w:r><w:t>函数趋近时研究极限。</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>概念</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>含义</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>极限</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>趋近值</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>';
    const bytes = storedZip('word/document.xml', xml);
    const created = await call('POST', '/notes', { title: '导入课件', source: 'import', attachments: [{ name: '极限.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: bytes.length, dataUrl: `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${bytes.toString('base64')}` }] });
    const note = await call('GET', `/notes/${created.body.summary.id}`);
    assert.match(note.body.note.body, /^# 第一章 极限/m);
    assert.match(note.body.note.body, /函数趋近时研究极限/);
    assert.match(note.body.note.body, /\| 概念 \| 含义 \|/);
    assert.equal(note.body.note.attachments[0].name, '极限.docx');
  } finally { await app.close(); }
});

test('上传 PPTX 按幻灯片提取正文，PDF 尽力提取可搜索文字', async () => {
  const { app, call } = await fixture();
  try {
    const slide = '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><a:t>极限课程</a:t><a:t>第一节：定义</a:t><a:t>第二节：性质</a:t></p:cSld></p:sld>';
    const pptx = storedZip('ppt/slides/slide1.xml', slide);
    const presentation = await call('POST', '/notes', { title: '课程演示', source: 'import', attachments: [{ name: '课程.pptx', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: pptx.length, dataUrl: `data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,${pptx.toString('base64')}` }] });
    const presentationNote = await call('GET', `/notes/${presentation.body.summary.id}`);
    assert.match(presentationNote.body.note.body, /## 幻灯片 1：极限课程/);
    assert.match(presentationNote.body.note.body, /第一节：定义/);

    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<< /Length 30 >>stream\nBT (Searchable PDF text) Tj ET\nendstream\nendobj\n%%EOF', 'latin1');
    const document = await call('POST', '/notes', { title: '可搜索 PDF', source: 'import', attachments: [{ name: 'sample.pdf', type: 'application/pdf', size: pdf.length, dataUrl: `data:application/pdf;base64,${pdf.toString('base64')}` }] });
    const documentNote = await call('GET', `/notes/${document.body.summary.id}`);
    assert.match(documentNote.body.note.body, /Searchable PDF text/);
  } finally { await app.close(); }
});

test('文件流导入不经过 JSON，原文件可下载且彩色批注可保存', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-note-stream-'));
  const server = await createServer({ dataDir }); const info = await server.listen({ port: 0 });
  try {
    const bytes = Buffer.from('# 平板课堂笔记\n\n这是直接导入的正文。', 'utf8');
    const importedResponse = await fetch(`${info.baseUrl}/notes/import?name=${encodeURIComponent('课堂笔记.md')}&type=text%2Fmarkdown`, { method: 'POST', headers: { 'Content-Type': 'text/markdown' }, body: bytes });
    assert.equal(importedResponse.status, 201); const imported = await importedResponse.json();
    const noteResponse = await fetch(`${info.baseUrl}/notes/${imported.summary.id}`); const note = (await noteResponse.json()).note;
    assert.match(note.body, /直接导入的正文/); assert.equal(note.attachments[0].size, bytes.length); assert.match(note.attachments[0].url, /^\/notes\/assets\//);
    const assetResponse = await fetch(`${info.baseUrl}${note.attachments[0].url}`);
    assert.equal(assetResponse.status, 200); assert.deepEqual(Buffer.from(await assetResponse.arrayBuffer()), bytes);
    const patched = await fetch(`${info.baseUrl}/notes/${note.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ annotations: { strokes: [{ color: '#d23f57', width: 4, points: [{ x: 0.1, y: 0.2 }, { x: 0.4, y: 0.5 }] }] } }) });
    assert.equal(patched.status, 200);
    const after = await fetch(`${info.baseUrl}/notes/${note.id}`); const stored = (await after.json()).note;
    assert.equal(stored.annotations.strokes[0].color, '#d23f57'); assert.equal(stored.annotations.strokes[0].points.length, 2);
  } finally { await server.close(); }
});

test('双向链接、重命名和知识图谱保持一致', async () => {
  const { app, call } = await fixture();
  try {
    const target = await call('POST', '/notes', { title: '牛顿定律', body: '# 定义', aliases: ['经典力学'], folder: '物理', properties: { course: '大学物理' } });
    const source = await call('POST', '/notes', { title: '力学习题', body: '复习 [[牛顿定律#定义|三大定律]] 与 [[尚未创建]]' });
    const targetId = target.body.summary.id; const sourceId = source.body.summary.id;
    const links = await call('GET', `/notes/${targetId}/links`);
    assert.equal(links.body.backlinks[0].id, sourceId);
    const graph = await call('GET', `/notes/graph?id=${targetId}&depth=2`);
    assert.equal(graph.body.nodes.length, 2); assert.equal(graph.body.edges.length, 1);
    const before = await call('GET', `/notes/${targetId}`);
    await call('PATCH', `/notes/${targetId}`, { title: '牛顿运动定律', expectedUpdatedAt: before.body.note.updatedAt });
    const rewritten = await call('GET', `/notes/${sourceId}`);
    assert.match(rewritten.body.note.body, /\[\[牛顿运动定律#定义\|三大定律\]\]/);
    assert.match(rewritten.body.note.body, /\[\[尚未创建\]\]/);
  } finally { await app.close(); }
});

test('属性搜索、历史版本、回收站和恢复可用', async () => {
  const { app, call } = await fixture();
  try {
    const created = await call('POST', '/notes', { title: '极限错题', body: '洛必达法则', folder: '高数/第三章', tags: ['考试'], properties: { course: '高等数学', type: '错题', status: '待复习' } });
    const id = created.body.summary.id;
    const original = await call('GET', `/notes/${id}`);
    await call('PATCH', `/notes/${id}`, { body: '新的解法', expectedUpdatedAt: original.body.note.updatedAt, versionReason: 'manual' });
    const versions = await call('GET', `/notes/${id}/versions`);
    assert.equal(versions.body.items.length, 1); assert.equal(versions.body.items[0].snapshot.body, '洛必达法则');
    assert.equal((await call('GET', '/notes?query=course:高等数学%20type:错题%20-线代')).body.items.length, 1);
    await call('DELETE', `/notes/${id}`);
    assert.equal((await call('GET', '/notes')).body.items.length, 0);
    assert.equal((await call('GET', '/notes?deleted=true')).body.items.length, 1);
    await call('POST', `/notes/${id}/restore`, {});
    assert.equal((await call('GET', '/notes')).body.items.length, 1);
  } finally { await app.close(); }
});

test('模板、每日笔记和 Canvas 均可持久化，数据库视图接口已移除', async () => {
  const { app, call } = await fixture();
  try {
    const templates = await call('GET', '/note-templates');
    assert.ok(templates.body.items.some((item) => item.id === 'builtin-mistake'));
    const daily1 = await call('POST', '/notes/daily', { date: '2026-10-12' });
    const daily2 = await call('POST', '/notes/daily', { date: '2026-10-12' });
    assert.equal(daily1.body.summary.id, daily2.body.summary.id);
    const removedView = await call('GET', '/note-views'); assert.equal(removedView.status, 404);
    const canvas = await call('POST', '/note-canvases', { name: '复习图', nodes: [
      { id: 'n1', type: 'mind', role: 'root', mindMapId: 'old-map', text: '复习', x: 10, y: 20 },
      { id: 'n2', type: 'file', noteId: daily1.body.summary.id, parentId: 'n1', x: 240, y: 20 },
    ], edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2', mindmap: true }] });
    assert.equal(canvas.status, 201);
    const stored = await call('GET', `/note-canvases/${canvas.body.item.id}`);
    assert.equal(stored.body.item.schemaVersion, 2); assert.equal(stored.body.item.revision, 0);
    assert.equal(stored.body.item.nodes[0].type, 'text'); assert.equal('mindMapId' in stored.body.item.nodes[0], false);
    assert.equal(stored.body.item.nodes[1].noteId, daily1.body.summary.id);
    assert.equal(stored.body.item.edges[0].kind, 'hierarchy'); assert.equal('mindmap' in stored.body.item.edges[0], false);
    const updated = await call('PATCH', `/note-canvases/${canvas.body.item.id}`, { revision: 0, nodes: stored.body.item.nodes.map((node) => ({ ...node, locked: true })) });
    assert.equal(updated.status, 200); assert.equal(updated.body.item.revision, 1); assert.equal(updated.body.item.nodes.every((node) => node.locked), true);
    const stale = await call('PATCH', `/note-canvases/${canvas.body.item.id}`, { revision: 0, name: '过期修改' }); assert.equal(stale.status, 409);
    const cyclic = await call('PATCH', `/note-canvases/${canvas.body.item.id}`, { revision: 1, nodes: [
      { id: 'n1', type: 'text', parentId: 'n2' }, { id: 'n2', type: 'text', parentId: 'n1' },
    ], edges: [] });
    assert.equal(cyclic.status, 400); assert.match(cyclic.body.error.message, /循环/);
    const tooLarge = await call('PATCH', `/note-canvases/${canvas.body.item.id}`, { revision: 1, nodes: Array.from({ length: 501 }, (_, index) => ({ id: `node-${index}`, type: 'text' })), edges: [] });
    assert.equal(tooLarge.status, 400); assert.match(tooLarge.body.error.message, /最多 500/);
    const aiDesign = await call('POST', `/note-canvases/${canvas.body.item.id}/ai-design`, { nodeId: 'n1' });
    assert.equal(aiDesign.status, 501); assert.equal(aiDesign.body.error.code, 'AI_UNAVAILABLE');
    const aiOutline = await call('POST', `/note-canvases/${canvas.body.item.id}/ai-outline`, { nodeId: 'n1' });
    assert.equal(aiOutline.status, 501); assert.equal(aiOutline.body.error.code, 'AI_UNAVAILABLE');
  } finally { await app.close(); }
});
