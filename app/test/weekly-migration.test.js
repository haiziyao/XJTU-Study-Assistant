/**
 * 「拆除复习系统、保留学习周报」的**结构化回归测试**。
 *
 * 这次改动删掉了两个后端模块、两个前端文件、两个数据集合与两个可传集合。删除类改动
 * 最容易在"某个目录还引用着它"的地方留下 404 / `undefined`，而单元测试按模块跑时看不出来。
 * 这里用一个**真后端**从四个对外入口验证"确实删干净了"：
 *
 *   1. `GET /modules`            —— 后端模块表里没有 cards / goals；
 *   2. `GET /transfer/catalog`   —— 可传集合里没有 cards / goals；
 *   3. `GET /sync/status`        —— 同步集合里没有 cards / goals；
 *   4. `GET /ai/capabilities`    —— 给 Agent 的工具里没有卡片 / 目标相关能力；
 *   5. 直接请求 `/cards` / `/goals` → 404（路由确实没注册，不是被藏起来）。
 *
 * 学习周报的统计口径另见 `weekly.test.js`；待办页里的入口与面板见
 * `calendar-todo-render.test.js`。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';

async function startApp() {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'potato-migration-'));
  const app = await createServer({ dataDir });
  const info = await app.listen({ port: 0 });
  const call = async (method, route) => {
    const response = await fetch(`${info.baseUrl}${route}`, { method, headers: { 'Content-Type': 'application/json' } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return {
    app,
    call,
    async close() {
      await app.close();
      await fs.promises.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    },
  };
}

const GONE = ['cards', 'goals'];

test('拆除复习系统：模块 / 可传集合 / 同步集合 / AI 工具里都不再有卡片与目标', async () => {
  const ctx = await startApp();
  try {
    // ① 后端模块表
    const modules = await ctx.call('GET', '/modules');
    const ids = (modules.body.items ?? []).map((item) => item.id);
    assert.ok(ids.includes('weekly'), '学习周报模块必须还在');
    for (const gone of GONE) assert.equal(ids.includes(gone), false, `${gone} 模块必须整体移除`);

    // ② 局域网直传的可传集合（成绩仍在「不传」清单里，不属于可传集合）
    const catalog = await ctx.call('GET', '/transfer/catalog');
    const names = (catalog.body.catalog ?? []).map((item) => item.name);
    for (const gone of GONE) assert.equal(names.includes(gone), false, `传输目录里不该再有 ${gone}`);
    assert.deepEqual(
      [...names].sort(),
      ['conversations', 'events', 'grades', 'memories', 'messages', 'notes', 'schedules', 'todos'].sort(),
      '可传集合应只剩对话/消息/记忆/笔记/待办/日程/事件 + 成绩（不传项）',
    );

    // ③ 多端同步的集合（在 /sync/status 的 collections 里）
    const status = await ctx.call('GET', '/sync/status');
    const synced = Object.keys(status.body.collections ?? {});
    for (const gone of GONE) assert.equal(synced.includes(gone), false, `同步集合里不该再有 ${gone}`);
    assert.ok(synced.includes('notes') && synced.includes('todos'), '笔记与待办应当照常同步');

    // ④ AI 工具清单：没有卡片 / 目标模块，也没有它们的工具
    const caps = await ctx.call('GET', '/ai/capabilities');
    const toolModules = new Set((caps.body.aiTools ?? []).map((tool) => tool.module));
    const toolNames = (caps.body.aiTools ?? []).map((tool) => tool.name);
    for (const gone of GONE) {
      assert.equal(toolModules.has(gone), false, `AI 工具里不该再有 ${gone} 模块`);
      assert.equal(toolNames.some((name) => name.startsWith(`${gone}_`)), false, `不该再有 ${gone}_* 工具`);
    }
    assert.ok(toolNames.includes('weekly_report_get') && toolNames.includes('weekly_report_generate'), '周报工具必须保留');

    // ⑤ 路由确实没注册：不是 403 / 500，而是干净的 404
    for (const gone of GONE) {
      const response = await ctx.call('GET', `/${gone}`);
      assert.equal(response.status, 404, `/${gone} 必须 404（路由与模块一起移除）`);
    }
  } finally {
    await ctx.close();
  }
});
