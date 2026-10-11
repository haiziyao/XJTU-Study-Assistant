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
