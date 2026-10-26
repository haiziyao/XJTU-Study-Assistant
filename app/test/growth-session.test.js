/**
 * 成长模块 · 会话与存档（搬自 Brain Online test/session.test.js）。
 *
 * 会话不是“装饰”：开机补记上次没关干净的会话、关机写当天现场，都是数据安全的一部分。
 * 存档目录在成长模块里叫 `archive/`（与其它模块隔离），文件名格式保持源项目一致。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';

const STATE = { sleepHours: 7, sleepQuality: 4, energy: 4, mood: 4, stress: 2, focus: 4, body: 4 };

async function startApp({ dataDir } = {}) {
  const dir = dataDir ?? (await mkdtemp(path.join(tmpdir(), 'potato-growth-session-')));
  const app = await createServer({
    dataDir: dir,
    onlyModules: ['growth'],
    growth: { now: () => new Date(2026, 9, 26, 9, 0, 0) },
  });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}/growth${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const close = async () => {
    await call('POST', '/system/shutdown', { reason: 'test-cleanup' }).catch(() => {});
    await app.close();
    await app.services.growth?.closing?.catch?.(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  };
  return { app, call, close, dataDir: dir };
}

test('开机：启动即开会话并记录 boot 日志，重复 boot 是幂等的', async () => {
  const ctx = await startApp();
  try {
    const status = await ctx.call('GET', '/system/status');
    assert.ok(status.body.session?.id);
    assert.equal(status.body.sessionCount, 1);

    const logs = await ctx.call('GET', '/logs?limit=10');
    assert.ok(logs.body.logs.some((log) => log.type === 'boot'));

    const again = await ctx.call('POST', '/system/boot', { trigger: 'test' });
    assert.equal(again.body.resumed, true);
    assert.equal(again.body.session.id, status.body.session.id);
  } finally {
    await ctx.close();
  }
});

test('重复 boot 不会开第二条会话', async () => {
  const ctx = await startApp();
  try {
    const first = await ctx.call('GET', '/system/status');
    await ctx.call('POST', '/system/boot', { trigger: 'test' });
    await ctx.call('POST', '/system/boot', { trigger: 'test' });
    const second = await ctx.call('GET', '/system/status');
    assert.equal(second.body.sessionCount, 1);
    assert.equal(second.body.session.id, first.body.session.id);
  } finally {
    await ctx.close();
  }
});

test('关机：关闭会话并写出包含当天现场的存档文件', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/state', STATE);
    await ctx.call('POST', '/plan/generate', {});
    const result = await ctx.call('POST', '/system/shutdown', { reason: 'test-shutdown' });
    assert.equal(result.body.ok, true);
    assert.equal(result.body.archived, true);
    assert.ok(result.body.file.endsWith('.json'));

    const raw = JSON.parse(await readFile(path.join(ctx.dataDir, 'archive', result.body.file), 'utf8'));
    assert.equal(raw.reason, 'test-shutdown');
    assert.equal(raw.date, '2026-10-26');
    assert.ok(raw.day.state.score > 0);
    assert.ok(raw.day.tasks.length > 0);
    assert.ok(raw.logs.length >= 2, '存档里要带本次会话的日志');
    assert.ok(raw.character, '存档里要带角色档案');
    assert.equal(raw.character.name, 'Operator');
  } finally {
    await ctx.close();
  }
});

test('关机后存档列表可读，且带条数摘要', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/system/shutdown', { reason: 'test' });
    const archives = await ctx.call('GET', '/archives');
    assert.equal(archives.body.archives.length, 1);
    assert.equal(archives.body.archives[0].reason, 'test');
    assert.equal(archives.body.archives[0].counts.tasks, 0);

    const one = await ctx.call('GET', `/archives/${archives.body.archives[0].file}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.archive.reason, 'test');
  } finally {
    await ctx.close();
  }
});

test('上次没关干净（断电）：开机时补记成 recovered，并补写存档', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-growth-recover-'));
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(dataDir, 'growth-sessions.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        items: [
          {
            id: 'stale-session',
            startedAt: '2026-10-25T20:00:00+08:00',
            endedAt: null,
            closedBy: null,
            trigger: 'startup',
            createdAt: '2026-10-25T20:00:00.000+08:00',
            updatedAt: '2026-10-25T20:00:00.000+08:00',
          },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const ctx = await startApp({ dataDir });
  try {
    const sessions = await ctx.call('GET', '/sessions?limit=10');
    const closed = sessions.body.sessions.find((item) => item.id === 'stale-session');
    assert.ok(closed.endedAt, '未关闭的会话必须被补上结束时间');
    assert.equal(closed.closedBy, 'recovered');

    const archives = await ctx.call('GET', '/archives');
    assert.ok(archives.body.archives.some((item) => item.reason === 'recovered'));
  } finally {
    await ctx.close();
  }
});

test('手动存档不结束会话', async () => {
  const ctx = await startApp();
  try {
    const result = await ctx.call('POST', '/system/snapshot');
    assert.equal(result.body.ok, true);
    assert.ok(result.body.file.endsWith('.json'));
    const status = await ctx.call('GET', '/system/status');
    assert.ok(status.body.session, '会话应仍然开着');
    const archives = await ctx.call('GET', '/archives');
    assert.ok(archives.body.archives.some((item) => item.reason === 'manual'));
  } finally {
    await ctx.close();
  }
});

test('没有会话时关机是安全的空操作', async () => {
  const ctx = await startApp();
  try {
    const first = await ctx.call('POST', '/system/shutdown', { reason: 'test' });
    assert.equal(first.body.archived, true);
    const second = await ctx.call('POST', '/system/shutdown', { reason: 'test' });
    assert.equal(second.body.ok, true);
    assert.equal(second.body.archived, false);
    assert.equal(second.body.reason, 'no-open-session');
  } finally {
    await ctx.close();
  }
});

test('日志有上限：超过 5000 条会裁掉最旧的（这里先验证计数不丢）', async () => {
  const ctx = await startApp();
  try {
    for (let i = 0; i < 300; i++) await ctx.app.services.growth.session.log('system', `批量日志 ${i}`);
    const count = ctx.app.store.growthLogs.all().length;
    assert.equal(count, 301, '300 条 + 1 条 boot');
    const logs = await ctx.call('GET', '/logs?limit=500');
    assert.equal(logs.body.logs.length, 301);
    assert.ok(logs.body.logs[0].message.includes('批量日志 299'), '最新的在最前面');
  } finally {
    await ctx.close();
  }
});
