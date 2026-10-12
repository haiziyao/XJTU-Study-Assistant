/**
 * 记忆模块的集成测试：真起一个后端（临时 dataDir，端口 0），把 §10.5 的 6 个接口
 * 连同"提议不落库 → 用户确认才落库"这条主链路走一遍。
 *
 * 为什么这些必须在真实后端上测（而不是只测服务层）：
 *   1. **路由契约**：状态码（201 / 200 幂等 / 409 冲突 / 404）、错误码与 `details` 是前端与
 *      Agent 真正看到的东西，服务层对了但路由包错了照样是坏的；
 *   2. **注入通道**：`/ai/context` 是主程序唯一自动读取记忆的入口（§6.4/§10.7），
 *      预算必须在那里也真的生效；
 *   3. **`/ai/capabilities`**：外部 Agent 只能凭这份清单判断"记忆能不能写" ——
 *      两个工具必须是"只读"或"提议"，否则模型会以为它可以绕过用户确认直接写库。
 *
 * 不访问外网：全部请求都打在本地 127.0.0.1 的临时实例上。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';

/** 起一个真实后端（端口 0），返回 `call(method, route, body)` 与临时 dataDir。 */
async function startApp() {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'potato-memory-http-'));
  const app = await createServer({ dataDir });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  };
  return {
    app,
    info,
    call,
    dataDir,
    /** 注入是"发了不等"的（§10.7 命中即回报）：断言 useCount 前先等落盘。 */
    flush: () => app.services.memory.flush(),
    async close() {
      await app.services.memory.flush();
      await app.close();
      await fs.promises.rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** 造一条指定字数的正文（不带句末标点，便于精确控制注入预算）。 */
const textOf = (chars, seed = '甲') => seed.repeat(chars);

// ---------------------------------------------------------------- 模块装配

test('记忆：模块出现在 /modules 里，并声明了集合与路由钩子', async () => {
  const ctx = await startApp();
  try {
    const listed = await ctx.call('GET', '/modules');
    const descriptor = (listed.body.items ?? listed.body.modules ?? []).find((item) => item.id === 'memory');
    assert.ok(descriptor, 'memory 模块要在 /modules 里');
    assert.equal(descriptor.title, '记忆');
    assert.ok(Array.isArray(descriptor.collections), '要声明 memories 集合');
    assert.ok(descriptor.collections.includes('memories'), '集合名必须是 memories（§10.2）');
    assert.ok(ctx.app.store.memories.filePath.endsWith('memories.json'), '落盘文件必须是 memories.json');
    assert.ok(descriptor.hooks.includes('createServices'));
    assert.ok(descriptor.hooks.includes('registerRoutes'));

    // 未实现前 /memories 是 404，装好之后必须至少不再 404
    const list = await ctx.call('GET', '/memories');
    assert.equal(list.status, 200);
    assert.equal(list.body.count, 0);
    assert.deepEqual(list.body.items, []);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- 6 个接口

test('记忆：POST /memories 落库 201，无 key 同文幂等 200 + duplicated', async () => {
  const ctx = await startApp();
  try {
    const created = await ctx.call('POST', '/memories', {
      scope: 'global',
      kind: 'preference',
      key: 'preferred_study_window',
      text: '我习惯晚上 19:00 之后安排学习任务',
      value: { from: '19:00' },
      sourceRef: { messageId: 'm-201' },
    });
    assert.equal(created.status, 201);
    const item = created.body.item;
    assert.equal(item.scope, 'global');
    assert.equal(item.kind, 'preference');
    assert.equal(item.key, 'preferred_study_window');
    assert.deepEqual(item.value, { from: '19:00' });
    assert.equal(item.source, 'user', '§10.5：显式写入的 source 固定 user');
    assert.equal(item.confidence, 1);
    assert.equal(item.status, 'active');
    assert.deepEqual(item.sourceRef, { messageId: 'm-201' });
    assert.equal(item.supersededBy, null);
    assert.equal(item.useCount, 0);
    assert.equal(item.lastUsedAt, null);
    assert.equal(item.reviewAt, null);
    assert.ok(item.createdAt && item.updatedAt, '存储层要补时间戳');

    const list = await ctx.call('GET', '/memories?scope=global&key=preferred_study_window');
    assert.equal(list.body.count, 1);
    assert.equal(list.body.items[0].id, item.id);

    // 无 key 的同文调用 = 幂等（200 + duplicated: true），不新建第二条
    const bare = await ctx.call('POST', '/memories', { text: '我周三下午不方便安排学习任务' });
    assert.equal(bare.status, 201);
    const again = await ctx.call('POST', '/memories', { text: '我周三下午不方便安排学习任务。' });
    assert.equal(again.status, 200, '幂等走 200，不是 201');
    assert.equal(again.body.duplicated, true);
    assert.equal(again.body.item.id, bare.body.item.id);
    assert.equal((await ctx.call('GET', '/memories')).body.count, 2);
  } finally {
    await ctx.close();
  }
});

test('记忆：同 scope+key 冲突 409（带 existing 与 hint），replace 走 superseded 链', async () => {
  const ctx = await startApp();
  try {
    const first = (
      await ctx.call('POST', '/memories', { kind: 'preference', key: 'study_window', text: '我习惯晚上学习' })
    ).body.item;

    const conflict = await ctx.call('POST', '/memories', { kind: 'preference', key: 'study_window', text: '我习惯下午学习' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'CONFLICT');
    assert.equal(conflict.body.error.details.existing.id, first.id);
    assert.match(conflict.body.error.details.hint, /replace/, '要告诉调用方怎么覆盖');

    const replaced = await ctx.call('POST', '/memories', {
      kind: 'preference',
      key: 'study_window',
      text: '我习惯下午学习',
      replace: true,
    });
    assert.equal(replaced.status, 201);
    assert.equal(replaced.body.replaced.id, first.id);

    const all = await ctx.call('GET', '/memories?key=study_window');
    assert.equal(all.body.count, 2, '旧条不删除（保留取代链）');
    const old = all.body.items.find((item) => item.id === first.id);
    assert.equal(old.status, 'superseded');
    assert.equal(old.supersededBy, replaced.body.item.id);
    assert.equal((await ctx.call('GET', '/memories?status=active&key=study_window')).body.count, 1);
  } finally {
    await ctx.close();
  }
});

test('记忆：GET /memories 的过滤与分页参数校验齐全', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/memories', { kind: 'preference', text: '我习惯晚上学习', key: 'night_study' });
    await ctx.call('POST', '/memories', { kind: 'constraint', text: '我周三下午不方便' });
    await ctx.call('POST', '/memories', { kind: 'fact', text: '高数老师是王老师', scope: 'course:39020' });
    await ctx.call('POST', '/memories', { kind: 'episodic', text: '上次数据结构作业拖到最后一天' });

    assert.equal((await ctx.call('GET', '/memories')).body.count, 4, '默认不过滤状态');
    assert.equal((await ctx.call('GET', '/memories?kind=constraint')).body.count, 1);
    assert.equal((await ctx.call('GET', '/memories?scope=course:39020')).body.count, 1);
    assert.equal((await ctx.call('GET', `/memories?q=${encodeURIComponent('周三')}`)).body.count, 1);
    const page = await ctx.call('GET', '/memories?limit=2&offset=1');
    assert.equal(page.body.count, 4, 'count 是过滤后的总数');
    assert.equal(page.body.items.length, 2);
    assert.equal(page.body.filters.offset, 1);
    // 分组计数（管理页的筛选页签用）：**不受 status 过滤影响**
    assert.deepEqual(page.body.counts, { active: 4, superseded: 0, archived: 0, rejected: 0, total: 4 });
    const filtered = await ctx.call('GET', '/memories?status=archived&limit=300');
    assert.equal(filtered.body.count, 0);
    assert.equal(filtered.body.counts.active, 4, '筛某一类时，其它类的条数仍然要报出来');

    // 参数写错要 400 说清是哪个字段，而不是静默返回一份"看起来就是这么多"的列表
    for (const [route, field] of [
      ['/memories?kind=feeling', 'kind'],
      ['/memories?status=done', 'status'],
      ['/memories?scope=课程:1', 'scope'],
      ['/memories?key=我的键', 'key'],
      ['/memories?limit=abc', 'limit'],
      ['/memories?limit=0', 'limit'],
      ['/memories?offset=-1', 'offset'],
    ]) {
      const bad = await ctx.call('GET', route);
      assert.equal(bad.status, 400, `${route} 应该 400`);
      assert.equal(bad.body.error.details.field, field);
    }
    // 管理页一次拉全量用的就是 limit=300（§10.9 的量级 <500 条）
    assert.equal((await ctx.call('GET', '/memories?limit=300')).status, 200);
    assert.equal((await ctx.call('GET', '/memories?limit=500')).status, 200);
    assert.equal((await ctx.call('GET', '/memories?limit=501')).status, 400);
  } finally {
    await ctx.close();
  }
});

test('记忆：写入校验 —— 200 字上限、敏感信息、非法枚举都是 400，未知 id 是 404', async () => {
  const ctx = await startApp();
  try {
    const tooLong = await ctx.call('POST', '/memories', { text: textOf(201) });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error.code, 'BAD_REQUEST');
    assert.equal(tooLong.body.error.details.field, 'text');
    assert.equal((await ctx.call('POST', '/memories', { text: textOf(200) })).status, 201, '200 字应该收下');
    assert.equal((await ctx.call('POST', '/memories', {})).status, 400, 'text 必填');
    assert.equal((await ctx.call('POST', '/memories', 'not-an-object')).status, 400, '请求体必须是对象');

    const secret = await ctx.call('POST', '/memories', { text: '我的教务密码是 abcd1234' });
    assert.equal(secret.status, 400);
    assert.equal(secret.body.error.details.reason, 'sensitive_content', '§10.5：不新增错误码，用 details.reason');

    for (const body of [
      { text: '合法正文', kind: 'feeling' },
      { text: '合法正文', scope: '课程:1' },
      { text: '合法正文', key: '中文键' },
      { text: '合法正文', reviewAt: '下周三' },
    ]) {
      assert.equal((await ctx.call('POST', '/memories', body)).status, 400, `应拒绝：${JSON.stringify(body)}`);
    }

    // 404：路径参数指向不存在的记忆
    for (const [method, route, body] of [
      ['PATCH', '/memories/nope', { text: '改成别的' }],
      ['DELETE', '/memories/nope', undefined],
      ['POST', '/memories/nope/use', undefined],
    ]) {
      const missing = await ctx.call(method, route, body);
      assert.equal(missing.status, 404, `${method} ${route} 应该 404`);
      assert.equal(missing.body.error.code, 'NOT_FOUND');
    }
  } finally {
    await ctx.close();
  }
});

test('记忆：PATCH 能改正字段与状态，rejected 不能恢复为 active', async () => {
  const ctx = await startApp();
  try {
    const item = (
      await ctx.call('POST', '/memories', { kind: 'preference', key: 'night_study', text: '我习惯晚上学习' })
    ).body.item;

    const fixed = await ctx.call('PATCH', `/memories/${item.id}`, {
      text: '我习惯晚上 20:00 之后学习',
      kind: 'fact',
      reviewAt: '2027-01-15',
    });
    assert.equal(fixed.status, 200);
    assert.equal(fixed.body.item.text, '我习惯晚上 20:00 之后学习');
    assert.equal(fixed.body.item.kind, 'fact');
    assert.equal(fixed.body.item.reviewAt, '2027-01-15');
    assert.equal(fixed.body.item.source, 'user', '改正内容不该改写来源');
    assert.equal(fixed.body.item.confidence, 1);

    assert.equal((await ctx.call('PATCH', `/memories/${item.id}`, { status: 'archived' })).body.item.status, 'archived');
    assert.equal((await ctx.call('PATCH', `/memories/${item.id}`, { status: 'active' })).body.item.status, 'active');
    assert.equal((await ctx.call('PATCH', `/memories/${item.id}`, { status: 'rejected' })).body.item.status, 'rejected');
    const revive = await ctx.call('PATCH', `/memories/${item.id}`, { status: 'active' });
    assert.equal(revive.status, 409, '§10.4：rejected 不可逆为 active');
    assert.equal((await ctx.call('PATCH', `/memories/${item.id}`, { reviewAt: null })).body.item.reviewAt, null);
    assert.equal((await ctx.call('PATCH', `/memories/${item.id}`, { text: textOf(201) })).status, 400);
    assert.equal((await ctx.call('PATCH', `/memories/${item.id}`, { text: '我的教务密码是 abcd1234' })).status, 400);

    const removed = await ctx.call('DELETE', `/memories/${item.id}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.deleted, true);
    assert.equal((await ctx.call('GET', `/memories?key=night_study`)).body.count, 0);
  } finally {
    await ctx.close();
  }
});

test('记忆：POST /memories/:id/use 累加命中次数并刷新时间', async () => {
  const ctx = await startApp();
  try {
    const item = (await ctx.call('POST', '/memories', { text: '我习惯晚上学习' })).body.item;
    const used = await ctx.call('POST', `/memories/${item.id}/use`);
    assert.equal(used.status, 200);
    assert.equal(used.body.item.useCount, 1);
    assert.ok(used.body.item.lastUsedAt, '命中要刷新 lastUsedAt（淘汰的唯一依据）');

    const twice = await ctx.call('POST', `/memories/${item.id}/use`, { count: 3 });
    assert.equal(twice.body.item.useCount, 4);
    assert.equal((await ctx.call('POST', `/memories/${item.id}/use`, { count: 0 })).status, 400);
    assert.equal((await ctx.call('POST', `/memories/${item.id}/use`, { count: 1000 })).status, 400);
  } finally {
    await ctx.close();
  }
});

test('记忆：DELETE /memories 清空前先备份成 memories.json.bak-<时间戳>', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/memories', { text: '我习惯晚上学习' });
    await ctx.call('POST', '/memories', { text: '我周三下午不方便' });
    const cleared = await ctx.call('DELETE', '/memories');
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.deleted, 2);
    assert.ok(cleared.body.backup, '要返回备份文件路径');
    const files = await fs.promises.readdir(ctx.dataDir);
    const backup = files.find((name) => /^memories\.json\.bak-/.test(name));
    assert.ok(backup, `备份文件应该落在 dataDir 里，实际：${files.join(', ')}`);
    const parsed = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, backup), 'utf8'));
    assert.equal(parsed.items.length, 2, '备份里要有被删掉的那两条');
    assert.equal((await ctx.call('GET', '/memories')).body.count, 0);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- 提议 → 确认

test('记忆：propose 不落库（writes:false），确认后走 /commands/execute 才是落库那一刻', async () => {
  const ctx = await startApp();
  try {
    const proposed = await ctx.call('POST', '/memories/propose', {
      scope: 'global',
      kind: 'preference',
      key: 'preferred_study_window',
      text: '我习惯晚上 19:00 之后安排学习任务',
      value: { from: '19:00' },
      confidence: 0.72,
    });
    assert.equal(proposed.status, 200);
    assert.equal(proposed.body.writes, false, '这个接口永远不会写库');
    const draft = proposed.body.draft;
    assert.equal(draft.ok, true);
    assert.equal(draft.action, 'create');
    assert.equal(draft.target, 'memory', '草稿要能直接复用 §4.2 的确认卡');
    assert.equal(draft.fields.text, '我习惯晚上 19:00 之后安排学习任务');
    assert.equal(draft.confidence, 0.72);
    assert.ok(draft.explain);
    assert.deepEqual(proposed.body.conflicts, []);
    assert.equal((await ctx.call('GET', '/memories')).body.count, 0, '提议之后库里必须还是空的');

    const executed = await ctx.call('POST', '/commands/execute', { draft });
    assert.equal(executed.status, 200);
    assert.equal(executed.body.item.text, '我习惯晚上 19:00 之后安排学习任务');
    assert.equal(executed.body.item.source, 'ai', '§10.2：模型提议、用户确认 → source: ai');
    assert.equal(executed.body.item.confidence, 0.72);
    assert.equal((await ctx.call('GET', '/memories')).body.count, 1);

    // 已经记过的不再重复提议；被否决过的绝不重提（§10.6）
    const duplicate = await ctx.call('POST', '/memories/propose', {
      kind: 'preference',
      key: 'preferred_study_window',
      text: '我习惯晚上 19:00 之后安排学习任务',
    });
    assert.equal(duplicate.body.draft, null);
    assert.equal(duplicate.body.suppressed, 'duplicate');
    assert.equal(duplicate.body.writes, false);

    const conflicting = await ctx.call('POST', '/memories/propose', {
      kind: 'preference',
      key: 'preferred_study_window',
      text: '我习惯早上学习',
    });
    assert.equal(conflicting.body.draft.target, 'memory');
    assert.equal(conflicting.body.conflicts.length, 1, '冲突要摆给用户看');
    assert.match(conflicting.body.draft.warnings.join(' '), /冲突/);

    const id = executed.body.item.id;
    await ctx.call('PATCH', `/memories/${id}`, { status: 'rejected' });
    const afterReject = await ctx.call('POST', '/memories/propose', {
      kind: 'preference',
      key: 'preferred_study_window',
      text: '我习惯早上学习',
    });
    assert.equal(afterReject.body.draft, null);
    assert.equal(afterReject.body.suppressed, 'rejected');
    assert.equal(afterReject.body.writes, false);

    // 敏感信息在提议这一步就拦住（别等用户点了确认才报错）
    const secret = await ctx.call('POST', '/memories/propose', { text: '我的教务密码是 abcd1234' });
    assert.equal(secret.status, 400);
    assert.equal(secret.body.error.details.reason, 'sensitive_content');
    assert.equal((await ctx.call('POST', '/memories/propose', {})).status, 400);
  } finally {
    await ctx.close();
  }
});

test('记忆：用户明说「记住 …」走本地规则解析器，带时间的句子仍归日历', async () => {
  const ctx = await startApp();
  try {
    const parsed = await ctx.call('POST', '/commands/parse', { text: '记住 我不喜欢早上排任务' });
    assert.equal(parsed.status, 200);
    assert.equal(parsed.body.draft.target, 'memory');
    assert.equal(parsed.body.draft.action, 'create');
    assert.equal(parsed.body.draft.fields.text, '我不喜欢早上排任务');
    assert.equal(parsed.body.draft.fields.kind, 'preference');
    assert.equal(parsed.body.draft.fields.source, 'user');

    const run = await ctx.call('POST', '/commands/run', { text: '记住 我不喜欢早上排任务' });
    assert.equal(run.status, 200);
    assert.equal(run.body.item.source, 'user');
    assert.equal((await ctx.call('GET', '/memories')).body.count, 1);

    // §10.1 第一条铁律：有确切时间位置的内容不许进记忆（否则同一条信息存两处）
    const timed = await ctx.call('POST', '/commands/parse', { text: '记住 明天下午三点开会' });
    assert.equal(timed.body.draft.target, 'schedule', '带时刻的句子应该还是日程');
    assert.equal((await ctx.call('GET', '/memories')).body.count, 1, '不许因此多出一条记忆');

    // dryRun 只预览、不落库（确认卡要在用户点之前就报出错误）
    const dry = await ctx.call('POST', '/commands/execute', {
      dryRun: true,
      draft: { ok: true, action: 'create', target: 'memory', fields: { text: '我习惯中午午休', kind: 'preference' } },
    });
    assert.equal(dry.body.dryRun, true);
    assert.equal(dry.body.validated.text, '我习惯中午午休');
    assert.equal((await ctx.call('GET', '/memories')).body.count, 1);
  } finally {
    await ctx.close();
  }
});

test('记忆：只读查询能被 AI 自动执行（dryRun 不写指令日志、不改数据）', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('POST', '/memories', { kind: 'preference', text: '我习惯晚上学习', key: 'night_study' });
    await ctx.call('POST', '/memories', { kind: 'episodic', text: '上次数据结构作业拖到最后一天' });

    const result = await ctx.app.services.commands.execute(
      { ok: true, action: 'query', target: 'memory', filters: { kind: 'episodic' } },
      { dryRun: true },
    );
    assert.equal(result.ok, true);
    assert.equal(result.target, 'memory');
    assert.equal(result.count, 1);
    assert.equal(result.items[0].kind, 'episodic');
    assert.match(result.explain, /命中 1 条记忆/);
    assert.deepEqual((await ctx.call('GET', '/commands/logs')).body.items, [], 'dryRun 连指令日志都不写');

    // 查不到时给一句能指导下一步的实话（模型据此决定"可以提议"）
    const miss = await ctx.app.services.commands.execute(
      { ok: true, action: 'query', target: 'memory', filters: { key: 'not_there' } },
      { dryRun: true },
    );
    assert.equal(miss.count, 0);
    assert.match(miss.explain, /可以提议/);

    // 定位不到目标时改/删要报错，而不是"猜一条改掉"（§10.6：改错偏好会污染每一次对话）
    await assert.rejects(
      () => ctx.app.services.commands.execute({ ok: true, action: 'delete', target: 'memory', filters: {} }),
      (error) => error.status === 400,
    );
    await assert.rejects(
      () =>
        ctx.app.services.commands.execute({
          ok: true,
          action: 'update',
          target: 'memory',
          filters: { key: 'not_there' },
          fields: { text: '改成别的' },
        }),
      (error) => error.status === 404,
    );
    assert.equal((await ctx.call('GET', '/memories')).body.count, 2, '失败的写操作不该动数据');
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------- AI 能力清单与注入

test('记忆：/ai/capabilities 里两个工具都是"只读"或"提议"（模型不能直接写库）', async () => {
  const ctx = await startApp();
  try {
    const caps = await ctx.call('GET', '/ai/capabilities');
    const tools = (caps.body.aiTools ?? []).filter((tool) => tool.module === 'memory');
    assert.ok(tools.length >= 2, '至少要有查询与提议两个工具');
    const search = tools.find((tool) => tool.name === 'memory_search');
    const propose = tools.find((tool) => tool.name === 'memory_propose');
    assert.ok(search && propose, '要声明 memory_search 与 memory_propose');
    assert.equal(search.method, 'GET');
    assert.equal(search.path, '/memories');
    assert.equal(search.mutates, false, '查询必须标成只读');
    assert.equal(search.implemented, true);
    assert.equal(propose.method, 'POST');
    assert.equal(propose.path, '/memories/propose');
    assert.equal(propose.mutates, false, '提议不落库，所以也是"不改数据"');
    assert.equal(propose.implemented, true);
    assert.match(propose.description, /不落库|writes/);
    assert.equal(tools.some((tool) => tool.mutates === true), false, '不许给模型任何直接写入口');
    for (const tool of tools) assert.equal(tool.requiresAuth, false, '记忆是本机数据，不依赖学校登录');
  } finally {
    await ctx.close();
  }
});

test('记忆：/ai/context 的注入预算真的生效（9 条各 100 字 → 6 条 + truncated）', async () => {
  const ctx = await startApp();
  try {
    // 空库：空预算、不抛异常（"记忆没装配 / 没数据"都不该让对话不可用）
    const empty = await ctx.call('GET', '/ai/context');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.memory.injected, []);
    assert.equal(empty.body.memory.budget.truncated, false);
    assert.equal(empty.body.memory.budget.maxItems, 8, '默认预算 8 条（§10.7）');
    assert.equal(empty.body.memory.budget.maxChars, 600);

    for (let i = 0; i < 9; i += 1) {
      const created = await ctx.call('POST', '/memories', { text: `${i}${textOf(99)}` });
      assert.equal(created.status, 201);
    }

    const context = await ctx.call('GET', '/ai/context');
    const injected = context.body.memory.injected;
    assert.equal(injected.length, 6, '600 / 100 = 6 条');
    assert.equal(context.body.memory.budget.truncated, true, '还有 3 条没进来，要告诉调用方');
    assert.equal(context.body.memory.budget.usedItems, 6);
    assert.ok(context.body.memory.budget.usedChars <= 600, '不许超发');
    for (const item of injected) {
      assert.ok(item.id && item.text && item.kind, '注入项要带 id/kind/text（prompt.js 用 kind 与 text）');
      assert.equal(item.text.length, 100);
    }

    // 注入即命中：§10.7 要求自动累加 useCount（这里是异步回报，flush 后再看）
    await ctx.flush();
    const all = await ctx.call('GET', '/memories?limit=20');
    const hits = all.body.items.reduce((sum, item) => sum + (item.useCount ?? 0), 0);
    assert.equal(hits, 6, '恰好回报了进来的那 6 条');
    assert.ok(all.body.items.some((item) => item.lastUsedAt));

    // 预算可以按请求收紧，但不能超发
    const single = await ctx.call('GET', '/ai/context?maxItems=1');
    assert.equal(single.body.memory.injected.length, 1);
    assert.equal(single.body.memory.budget.truncated, true);
    const tiny = await ctx.call('GET', '/ai/context?maxChars=120');
    const used = tiny.body.memory.injected.reduce((sum, item) => sum + item.text.length, 0);
    assert.ok(used <= 120, `maxChars 必须生效，实际用了 ${used}`);
  } finally {
    await ctx.close();
  }
});

test('记忆：作用域与复核时间决定"能不能被注入"（课程记忆 / 到期结论）', async () => {
  const ctx = await startApp();
  try {
    const global = (await ctx.call('POST', '/memories', { text: '我习惯晚上学习' })).body.item;
    const course = (await ctx.call('POST', '/memories', { text: '这门课老师不点名', scope: 'course:39020' })).body.item;
    const stale = (
      await ctx.call('POST', '/memories', { text: '我这学期选了数据结构', reviewAt: '2020-01-15' })
    ).body.item;

    const bare = await ctx.call('GET', '/ai/context');
    const ids = bare.body.memory.injected.map((item) => item.id);
    assert.deepEqual(ids, [global.id], '没带上下文时只有 global 参与，到期的结论不进注入');

    const scoped = await ctx.call('GET', '/ai/context?courseId=39020');
    const scopedIds = scoped.body.memory.injected.map((item) => item.id);
    assert.ok(scopedIds.includes(course.id));
    assert.ok(!scopedIds.includes(stale.id));

    // 到期不等于失效：检索照常查得到，管理页也能列出待复核的
    assert.equal((await ctx.call('GET', '/memories?dueReview=1')).body.count, 1);
    assert.equal((await ctx.call('GET', '/memories?q=数据结构')).body.count, 1);

    // 用户复核后（把 reviewAt 推到未来）重新参与注入
    await ctx.call('PATCH', `/memories/${stale.id}`, { reviewAt: '2099-01-15' });
    const after = await ctx.call('GET', '/ai/context');
    assert.ok(after.body.memory.injected.map((item) => item.id).includes(stale.id));
    assert.equal((await ctx.call('GET', '/memories?dueReview=1')).body.count, 0);
  } finally {
    await ctx.close();
  }
});
