import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';

async function startApp() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-notes-'));
  const app = await createServer({ dataDir });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, call };
}

test('主程序持有笔记正文，列表只返回摘要，详情按需读取', async () => {
  const { app, call } = await startApp();
  try {
    const created = await call('POST', '/notes', {
      title: '极限复习', body: '# 洛必达法则\n这是正文', tags: ['高数'], source: 'import',
      anchor: { type: 'date', date: '2026-10-11' }, format: 'markdown',
    });
    assert.equal(created.status, 201);
    const id = created.body.summary.id;
    assert.equal(created.body.summary.body, undefined);

    const listed = await call('GET', '/notes?query=洛必达');
    assert.equal(listed.body.items.length, 1);
    assert.equal(listed.body.items[0].body, undefined);
    assert.match(listed.body.items[0].previewText, /洛必达法则/);

    const detail = await call('GET', `/notes/${id}`);
    assert.match(detail.body.note.body, /这是正文/);
  } finally {
    await app.close();
  }
});

test('AI 只能通过只读 note/query 获取经过截断的笔记内容', async () => {
  const { app, call } = await startApp();
  try {
    const created = await call('POST', '/notes', { title: '线性代数', body: '矩阵与特征值', source: 'manual' });
    const id = created.body.summary.id;
    const queried = await call('POST', '/commands/execute', {
      draft: { ok: true, action: 'query', target: 'note', filters: { query: '特征值', limit: 5 } },
    });
    assert.equal(queried.status, 200);
    assert.equal(queried.body.count, 1);
    assert.equal(queried.body.items[0].id, id);
    assert.match(queried.body.items[0].text, /矩阵与特征值/);

    const context = await call('POST', '/notes/ai-context', { ids: [id], limit: 1 });
    assert.equal(context.body.items.length, 1);
    assert.equal(context.body.items[0].title, '线性代数');
    const capabilities = await call('GET', '/ai/capabilities');
    assert.ok(capabilities.body.aiTools.some((tool) => tool.name === 'notes_query' && tool.module === 'notes'));
  } finally {
    await app.close();
  }
});

test('编辑笔记可持久保存，保留附件、来源及日历关联；旧版本和过长正文拒绝覆盖', async () => {
  const { app, call } = await startApp();
  try {
    const created = await call('POST', '/notes', {
      title: '原笔记', body: '# 原文', source: 'import', tags: ['原标签'],
      anchor: { type: 'date', date: '2026-10-12' },
      attachments: [{ name: '原附件.txt', type: 'text/plain', size: 1, dataUrl: 'data:text/plain;base64,YQ==' }],
    });
    const id = created.body.summary.id;
    const original = (await call('GET', `/notes/${id}`)).body.note;
    const edited = await call('PATCH', `/notes/${id}`, {
      title: '新标题', body: '## 新正文\n\n**重点**', tags: ['新标签'], format: 'markdown', status: 'ready',
      expectedUpdatedAt: original.updatedAt, attachments: [], source: 'manual', anchor: null,
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.summary.body, undefined, '更新响应仍只返回摘要');
    const stored = (await call('GET', `/notes/${id}`)).body.note;
    assert.equal(stored.title, '新标题'); assert.match(stored.body, /新正文/);
    assert.deepEqual(stored.tags, ['新标签']);
    assert.deepEqual(stored.attachments, original.attachments);
    assert.deepEqual(stored.anchor, original.anchor);
    assert.equal(stored.source, 'import'); assert.equal(stored.createdAt, original.createdAt);
    assert.equal((await call('GET', '/notes?query=重点')).body.items.length, 1);
    assert.equal((await call('POST', '/notes/ai-context', { ids: [id] })).body.items[0].text, stored.body);
    const stale = await call('PATCH', `/notes/${id}`, { body: '不能覆盖', expectedUpdatedAt: original.updatedAt });
    assert.equal(stale.status, 409);
    const oversized = await call('PATCH', `/notes/${id}`, { body: 'a'.repeat(200001) });
    assert.equal(oversized.status, 400);
    assert.equal((await call('GET', `/notes/${id}`)).body.note.body, stored.body);
    assert.equal((await call('PATCH', '/notes/nonexistent', { body: 'x' })).status, 404);
    const persisted = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(app.dataDir, 'notes.json'), 'utf8'));
    assert.ok(JSON.stringify(persisted).includes('新正文'));
  } finally { await app.close(); }
});
