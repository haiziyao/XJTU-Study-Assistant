import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { parseWikiLinks } from '../src/modules/notes/service.js';

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

test('模板、每日笔记、数据库视图和 Canvas 均可持久化', async () => {
  const { app, call } = await fixture();
  try {
    const templates = await call('GET', '/note-templates');
    assert.ok(templates.body.items.some((item) => item.id === 'builtin-mistake'));
    const daily1 = await call('POST', '/notes/daily', { date: '2026-10-12' });
    const daily2 = await call('POST', '/notes/daily', { date: '2026-10-12' });
    assert.equal(daily1.body.summary.id, daily2.body.summary.id);
    const view = await call('POST', '/note-views', { name: '待复习', layout: 'kanban', filters: { status: '待复习' }, groupBy: 'status' });
    assert.equal(view.status, 201); assert.equal(view.body.item.layout, 'kanban');
    const canvas = await call('POST', '/note-canvases', { name: '复习图', nodes: [{ id: 'n1', type: 'file', noteId: daily1.body.summary.id, x: 10, y: 20 }], edges: [] });
    assert.equal(canvas.status, 201);
    const stored = await call('GET', `/note-canvases/${canvas.body.item.id}`);
    assert.equal(stored.body.item.nodes[0].noteId, daily1.body.summary.id);
    const aiDesign = await call('POST', `/note-canvases/${canvas.body.item.id}/ai-design`, { nodeId: 'n1' });
    assert.equal(aiDesign.status, 501); assert.equal(aiDesign.body.error.code, 'AI_UNAVAILABLE');
  } finally { await app.close(); }
});
