/**
 * 分类（Category）行为测试。
 *
 * 覆盖：
 *   1. 首次启动播种内置的 6+6 个分类（id 与旧常量一致），`other` 锁定；
 *   2. 增删改与校验（label 必填/≤12、color 必须 #RRGGBB）；
 *   3. **删分类不丢数据**：在用记录改成 other 并返回 reassigned；
 *   4. 写库时分类走注册表：自定义 id 能用、未知 id 静默兜底到 other（不 400）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';

async function startApp() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-category-'));
  const app = await createServer({ dataDir, version: '0.1.0-test' });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json();
    return { status: response.status, body: payload };
  };
  return { app, call };
}

const BUILTIN_SCHEDULE = ['class', 'study', 'meeting', 'exam', 'activity', 'other'];
const BUILTIN_EVENT = ['study', 'exam', 'holiday', 'anniversary', 'deadline', 'other'];

test('首次启动播种 6+6 个内置分类，id 与旧常量一致，other 锁定且在最后', async () => {
  const { app, call } = await startApp();
  try {
    const all = await call('GET', '/categories');
    assert.equal(all.status, 200);
    assert.equal(all.body.items.length, 12);
    // 两个集合各 6 条；**记录的 id 就是写进日程/事件的那个值**，没有 key/value 两层
    assert.deepEqual(
      all.body.items.filter((item) => item.kind === 'schedule').map((item) => item.id),
      BUILTIN_SCHEDULE,
    );
    assert.deepEqual(
      all.body.items.filter((item) => item.kind === 'event').map((item) => item.id),
      BUILTIN_EVENT,
    );
    for (const item of all.body.items) {
      assert.deepEqual(Object.keys(item).sort(), ['builtin', 'color', 'id', 'inUse', 'kind', 'label', 'locked', 'order']);
    }
    for (const item of all.body.items) {
      assert.equal(item.builtin, true);
      assert.match(item.color, /^#[0-9a-f]{6}$/);
      assert.equal(typeof item.order, 'number');
      assert.equal(item.inUse, 0);
    }
    const scheduleOther = all.body.items.find((item) => item.kind === 'schedule' && item.id === 'other');
    assert.equal(scheduleOther.locked, true);
    assert.equal(
      scheduleOther.order > all.body.items.filter((i) => i.kind === 'schedule' && i.id !== 'other').at(-1).order,
      true,
    );
    // 按 kind 过滤
    assert.equal((await call('GET', '/categories?kind=event')).body.items.length, 6);
    assert.equal((await call('GET', '/categories?kind=nope')).status, 400);
  } finally {
    await app.close();
  }
});

test('分类 CRUD：新建 / 改名 / 改色 / 校验失败', async () => {
  const { app, call } = await startApp();
  try {
    const created = await call('POST', '/categories', { kind: 'schedule', label: '实验', color: '#00C2A8' });
    assert.equal(created.status, 201);
    assert.equal(created.body.item.label, '实验');
    assert.equal(created.body.item.color, '#00c2a8', '颜色统一成小写 6 位');
    assert.equal(created.body.item.builtin, false);
    assert.equal(created.body.item.locked, false);
    const id = created.body.item.id;

    const renamed = await call('PATCH', `/categories/${id}?kind=schedule`, { label: ' 实验课 ' });
    assert.equal(renamed.body.item.label, '实验课', '去空白');
    const recolored = await call('PATCH', `/categories/${id}?kind=schedule`, { color: '#ABC' });
    assert.equal(recolored.body.item.color, '#aabbcc', '#RGB 短写会展开');

    // 校验
    assert.equal((await call('POST', '/categories', { kind: 'schedule', color: '#123456' })).status, 400, 'label 必填');
    assert.equal((await call('POST', '/categories', { kind: 'schedule', label: '一二三四五六七八九十十一十二十三', color: '#123456' })).status, 400, 'label ≤12');
    assert.equal((await call('POST', '/categories', { kind: 'schedule', label: '颜色错', color: 'red' })).status, 400, 'color 必须 #RRGGBB');
    assert.equal((await call('POST', '/categories', { kind: 'schedule', label: '缺颜色' })).status, 400);
    assert.equal((await call('POST', '/categories', { kind: 'nope', label: 'x', color: '#123456' })).status, 400);
    assert.equal((await call('PATCH', `/categories/${id}?kind=schedule`, { color: '#12' })).status, 400);
    assert.equal((await call('PATCH', '/categories/不存在?kind=schedule', { label: 'x' })).status, 404);

    // 删除
    const removed = await call('DELETE', `/categories/${id}?kind=schedule`);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.deleted, true);
    assert.equal(removed.body.reassigned, 0);
    assert.equal((await call('GET', `/categories/${id}?kind=schedule`)).status, 404);
  } finally {
    await app.close();
  }
});

test('删除在用分类：记录改成 other，返回 reassigned 条数，数据不丢', async () => {
  const { app, call } = await startApp();
  try {
    await call('POST', '/categories', { kind: 'schedule', label: '实验', color: '#00c2a8' });
    const list = await call('GET', '/categories?kind=schedule');
    const custom = list.body.items.find((item) => item.label === '实验');

    await call('POST', '/schedules', { title: '第一节课', date: '2030-01-07', startTime: '08:00', category: custom.id });
    await call('POST', '/schedules', { title: '第二节课', date: '2030-01-07', startTime: '10:00', category: custom.id });
    await call('POST', '/events', { title: '别的事件', startDate: '2030-01-07', category: 'exam' });

    const withUse = await call('GET', '/categories?kind=schedule');
    assert.equal(withUse.body.items.find((item) => item.id === custom.id).inUse, 2, 'inUse 反映在用条数');

    const removed = await call('DELETE', `/categories/${custom.id}?kind=schedule`);
    assert.equal(removed.body.deleted, true);
    assert.equal(removed.body.reassigned, 2);

    // 记录没被删，只是变成 other
    const schedules = await call('GET', '/schedules?date=2030-01-07');
    assert.equal(schedules.body.items.length, 2);
    assert.ok(schedules.body.items.every((item) => item.category === 'other'));
    // 事件不受影响
    assert.equal((await call('GET', '/events')).body.items[0].category, 'exam');

    // 兜底分类不能删
    const other = (await call('GET', '/categories?kind=schedule')).body.items.find((item) => item.id === 'other');
    const rejected = await call('DELETE', `/categories/${other.id}?kind=schedule`);
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error.message, /不能删除/);
    // 但可以改名/改色
    const renamed = await call('PATCH', `/categories/${other.id}?kind=schedule`, { label: '未分类', color: '#999999' });
    assert.equal(renamed.body.item.label, '未分类');
    assert.equal(renamed.body.item.color, '#999999');
  } finally {
    await app.close();
  }
});

test('写库时分类走注册表：自定义 id 能读回，未知 id 静默兜底到 other', async () => {
  const { app, call } = await startApp();
  try {
    const created = await call('POST', '/categories', { kind: 'event', label: '竞赛', color: '#ff9f0a' });
    const id = created.body.item.id;

    // ① 自定义分类
    const event = await call('POST', '/events', { title: '数模竞赛', startDate: '2030-02-01', category: id });
    assert.equal(event.status, 201);
    assert.equal(event.body.item.category, id);
    assert.equal((await call('GET', `/events/${event.body.item.id}`)).body.item.category, id);

    // ② 未知分类 / 自由文本（dschat 兼容层）不报错，落到 other
    const loose = await call('POST', '/events', { title: '自由文本分类', startDate: '2030-02-02', category: '随便写的' });
    assert.equal(loose.status, 201);
    assert.equal(loose.body.item.category, 'other');

    // ③ 不传分类也是 other
    const plain = await call('POST', '/schedules', { title: '没写分类', date: '2030-02-03', startTime: '09:00' });
    assert.equal(plain.body.item.category, 'other');

    // ④ 显式传 other
    const explicit = await call('POST', '/schedules', { title: '显式其它', date: '2030-02-03', startTime: '11:00', category: 'other' });
    assert.equal(explicit.body.item.category, 'other');
  } finally {
    await app.close();
  }
});

test('内置分类改名后，新写入的记录仍然用同一个 id（思源学堂同步依赖它）', async () => {
  const { app, call } = await startApp();
  try {
    const renamed = await call('PATCH', '/categories/class?kind=schedule', { label: '课程', color: '#6c8cff' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.item.id, 'class');
    const item = await call('POST', '/schedules', { title: '数据结构', date: '2030-03-01', startTime: '08:00', category: 'class' });
    assert.equal(item.body.item.category, 'class', '内置 id 不会因为改名而变化');
    assert.equal((await call('GET', '/categories?kind=schedule')).body.items.find((i) => i.id === 'class').label, '课程');
    // 同名 id 在两个集合里都存在时，不带 kind 的 id 路由会要求说清楚
    assert.equal((await call('PATCH', '/categories/study', { label: 'x' })).status, 400);
  } finally {
    await app.close();
  }
});
