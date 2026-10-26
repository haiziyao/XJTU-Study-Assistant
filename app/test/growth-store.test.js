/**
 * 成长模块 · 存储适配（搬自 Brain Online test/store.test.js，并补“存储并发”）。
 *
 * 成长模块没有自己的存储层：集合由 XJTU 的 JsonStore 统一管理（原子写 + 串行队列）。
 * 这里验证模块内的 `collection()` / `doc()` 适配没有破坏这些保证：
 * 落盘能回读、patch 保留 id/createdAt、remove 不留临时文件、单文档默认值、坏文件容错、
 * 并发写入不丢记录；以及模块私有存档文件是 0600。
 *
 * 与源项目的一处刻意差异：业务集合由框架按 0644 落盘（可同步/可读的业务数据），
 * 只有 `data/archive/` 里的快照是 0600（可能含当天日记）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { JsonStore } from '../src/core/store/json-store.js';
import { collection, doc, writeJsonFile } from '../src/modules/growth/store-utils.js';

const COLLECTIONS = [
  { name: 'growthStates', file: 'growth-states.json' },
  { name: 'growthRpg', file: 'growth-rpg.json' },
];

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'potato-growth-store-'));
}

async function openStore(dir) {
  return new JsonStore({ dataDir: dir, collections: COLLECTIONS }).init();
}

test('集合：写入后能被新实例读回来（落盘真的发生了）', async () => {
  const dir = await tempDir();
  try {
    const store = await openStore(dir);
    const items = collection(store, 'growthStates');
    const created = await items.insert({ title: '写周报' });
    assert.ok(created.id);
    assert.ok(created.createdAt);

    const reopened = await openStore(dir);
    const rows = await collection(reopened, 'growthStates').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, '写周报');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('集合：patch 不改变 id 与 createdAt，只更新 updatedAt', async () => {
  const dir = await tempDir();
  try {
    const store = await openStore(dir);
    const items = collection(store, 'growthStates');
    const created = await items.insert({ title: 'a', done: false });
    const patched = await items.patch(created.id, { done: true });
    assert.equal(patched.id, created.id);
    assert.equal(patched.createdAt, created.createdAt);
    assert.equal(patched.done, true);
    assert.ok(patched.updatedAt >= created.updatedAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('集合：remove 之后读不到，且不留下临时文件', async () => {
  const dir = await tempDir();
  try {
    const store = await openStore(dir);
    const items = collection(store, 'growthStates');
    const created = await items.insert({ title: 'a' });
    assert.equal(await items.remove(created.id), true);
    assert.equal(await items.remove(created.id), false);
    assert.equal(await items.count(), 0);
    const files = await readdir(dir);
    assert.ok(!files.some((file) => file.endsWith('.tmp')), files.join(','));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('单文档：默认值 + 局部合并 + 重开仍能读到', async () => {
  const dir = await tempDir();
  try {
    const store = await openStore(dir);
    const character = doc(store, 'growthRpg', { name: 'Operator', attrs: { focus: 0 } });
    const initial = await character.read();
    assert.equal(initial.name, 'Operator');

    await character.merge('attrs', { focus: 3 });
    const reopened = await openStore(dir);
    const rows = await doc(reopened, 'growthRpg', {}).read();
    assert.equal(rows.attrs.focus, 3);
    assert.equal(rows.name, 'Operator', '合并不能丢掉其它字段');
    assert.equal(rows.id, undefined, '存储层附加字段不能泄漏到业务对象');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件权限：成长模块的存档快照是 0600', async () => {
  const dir = await tempDir();
  try {
    const file = path.join(dir, 'archive', '2026-10-26-abc.json');
    await writeJsonFile(file, { hello: 'world' });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { hello: 'world' });
    if (process.platform !== 'win32') {
      const info = await stat(file);
      assert.equal(info.mode & 0o777, 0o600);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('坏文件不该让进程崩：读不出来时先备份原件，再按空集合启动', async () => {
  const dir = await tempDir();
  try {
    await writeFile(path.join(dir, 'growth-states.json'), '');
    const store = await openStore(dir);
    assert.deepEqual(store.growthStates.all(), []);
    const files = await readdir(dir);
    assert.ok(files.some((file) => file.includes('.corrupt-')), files.join(','));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('存储并发：30 条同时写入不丢记录，重开仍是 30 条', async () => {
  const dir = await tempDir();
  try {
    const store = await openStore(dir);
    const items = collection(store, 'growthStates');
    await Promise.all(Array.from({ length: 30 }, (_, index) => items.insert({ title: `并发 ${index}` })));
    assert.equal(await items.count(), 30);

    const reopened = await openStore(dir);
    const rows = await collection(reopened, 'growthStates').all();
    assert.equal(rows.length, 30);
    assert.equal(new Set(rows.map((row) => row.title)).size, 30);
    const files = await readdir(dir);
    assert.ok(!files.some((file) => file.endsWith('.tmp')), files.join(','));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
