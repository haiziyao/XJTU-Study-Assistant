/**
 * `/meta/lunar` 路由测试：形状必须与框架预留的契约一致，并覆盖批量模式与三种错误。
 *
 * 契约（core/routes.js 原先的 501 注释里写着）：
 *   GET /meta/lunar?date=YYYY-MM-DD
 *   -> { ok, date, lunar: { year, zodiac, month, day, isLeapMonth }, festivals: [] }
 * 本轮补的是批量模式（月视图 42 天 / 年视图 365 天一次拿，不能逐日请求）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';

async function startApp() {
  const app = await createServer({ dataDir: await mkdtemp(path.join(tmpdir(), 'potato-lunar-')) });
  const info = await app.listen({ port: 0 });
  const call = async (route) => {
    const response = await fetch(`${info.baseUrl}${route}`);
    return { status: response.status, body: await response.json() };
  };
  return { app, call };
}

test('单日：形状与框架契约一致（含 festivals 与可读 text）', async () => {
  const { app, call } = await startApp();
  try {
    const single = await call('/meta/lunar?date=2026-10-12');
    assert.equal(single.status, 200);
    assert.equal(single.body.ok, true);
    assert.equal(single.body.date, '2026-10-12');
    assert.deepEqual(single.body.lunar, {
      year: '丙午',
      zodiac: '马',
      month: '九月',
      day: '初三',
      isLeapMonth: false,
      monthNumber: 9,
      dayNumber: 3,
    });
    assert.deepEqual(single.body.festivals, []);
    assert.equal(single.body.text, '丙午年九月初三');

    // 春节
    const spring = await call('/meta/lunar?date=2026-02-17');
    assert.deepEqual(spring.body.festivals, ['春节']);
    assert.equal(spring.body.lunar.month, '正月');
    assert.equal(spring.body.lunar.day, '初一');
    assert.equal(spring.body.text, '丙午年正月初一');

    // 闰月：month 不带闰字，isLeapMonth 表达闰
    const leap = await call('/meta/lunar?date=2023-03-22');
    assert.equal(leap.body.lunar.month, '二月');
    assert.equal(leap.body.lunar.isLeapMonth, true);
    assert.equal(leap.body.lunar.day, '初一');
    assert.equal(leap.body.text, '癸卯年闰二月初一');
  } finally {
    await app.close();
  }
});

test('批量：from+to 返回 days 映射（含首尾）', async () => {
  const { app, call } = await startApp();
  try {
    const batch = await call('/meta/lunar?from=2026-02-15&to=2026-02-18');
    assert.equal(batch.status, 200);
    assert.equal(batch.body.ok, true);
    assert.equal(batch.body.from, '2026-02-15');
    assert.equal(batch.body.to, '2026-02-18');
    assert.deepEqual(Object.keys(batch.body.days), ['2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18']);
    for (const item of Object.values(batch.body.days)) {
      assert.deepEqual(Object.keys(item).sort(), ['festivals', 'lunar', 'text']);
    }
    assert.deepEqual(batch.body.days['2026-02-17'].festivals, ['春节']);
    assert.deepEqual(batch.body.days['2026-02-16'].festivals, ['除夕']);
    assert.equal(batch.body.days['2026-02-18'].text, '丙午年正月初二');

    // 一整年（年视图要用的量级）
    const year = await call('/meta/lunar?from=2026-01-01&to=2026-12-31');
    assert.equal(Object.keys(year.body.days).length, 365);
  } finally {
    await app.close();
  }
});

test('错误：缺参 / 非法日期 / 反向区间 / 跨度过大', async () => {
  const { app, call } = await startApp();
  try {
    const missing = await call('/meta/lunar');
    assert.equal(missing.status, 400);
    assert.match(missing.body.error.message, /date 为必填/);

    const bad = await call('/meta/lunar?date=2026-13-40');
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /合法的 YYYY-MM-DD/);

    const half = await call('/meta/lunar?from=2026-01-01');
    assert.equal(half.status, 400);
    assert.match(half.body.error.message, /同时提供 from 与 to/);

    const reversed = await call('/meta/lunar?from=2026-01-02&to=2026-01-01');
    assert.equal(reversed.status, 400);
    assert.match(reversed.body.error.message, /to 不能早于 from/);

    const tooLong = await call('/meta/lunar?from=2020-01-01&to=2029-01-01');
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.body.error.message, /区间跨度过大/);

    // 批量模式下也校验日期合法性
    const badRange = await call('/meta/lunar?from=2026-02-30&to=2026-03-01');
    assert.equal(badRange.status, 400);
  } finally {
    await app.close();
  }
});
