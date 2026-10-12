/**
 * 局域网直传的集成测试（契约 §八）。
 *
 * 测试原则：
 *   1. **真起两个后端实例**（各自临时 dataDir、各自独立的传输端口），A 当接收方、B 当发送方，
 *      走真实的 HTTP + 真实的分片 + 真实的模块写入 —— 只有"两台机器"是模拟的；
 *   2. **端口不用 8886**：开发机上很可能正跑着一个实例（或另一个测试），
 *      抢端口会让测试随机失败；端口可配置正是为了这个（`transfer.port`）；
 *   3. **不发真 UDP 广播**：发现通道用注入的假 socket / 假 send 测解析与状态机
 *      （`createDiscovery` 支持注入），绝不往局域网里打真包；
 *   4. 合并策略逐条对应 §8.1 的表，一条一个断言，出问题时能立刻知道是哪条规则坏了。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { createServer } from '../src/server/index.js';
import { createDiscovery } from '../src/modules/transfer/discovery.js';
import { CHUNK_BYTES, buildChunks, parseDiscoveryMessage } from '../src/modules/transfer/protocol.js';

/* ---------------------------------------------------------------- 测试脚手架 */

/** 取一个空闲端口（bind 0 拿系统分配的，随即释放）。 */
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** 起一个后端实例：主服务用随机端口，传输用指定端口，**关掉 UDP 发现**（不发真广播）。 */
async function startNode({ port, name, transfer = {} }) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-transfer-'));
  const app = await createServer({
    dataDir,
    transfer: { port, discovery: false, deviceName: name, ...transfer },
  });
  const info = await app.listen({ port: 0 });
  await app.services.transfer.ready();
  return { app, dataDir, info };
}

/** A（接收方）/ B（发送方）一对实例，跑完自动收摊。 */
async function withPair(run, options = {}) {
  const aPort = await freePort();
  const bPort = await freePort();
  const A = await startNode({ port: aPort, name: 'A 机', transfer: options.a ?? {} });
  const B = await startNode({ port: bPort, name: 'B 机', transfer: options.b ?? {} });
  const context = {
    A,
    B,
    aPort,
    bPort,
    /** 直接打设备服务器的 HTTP（8886 上的协议面）。 */
    device: (port, method, route, { body, token } = {}) =>
      fetch(`http://127.0.0.1:${port}${route}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Potato-Transfer-Token': token } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) })),
    /** 从 B 发给 A（配对码取 A 当前显示的）。 */
    send: (collections, extra = {}) =>
      B.app.services.transfer.sendTo({ host: '127.0.0.1', port: aPort, code: A.app.services.transfer.codeInfo().code, collections, ...extra }),
  };
  try {
    await run(context);
  } finally {
    // 先停传输服务器（端口要释放），再关主服务，最后删数据目录
    await A.app.services.transfer.stop().catch(() => {});
    await B.app.services.transfer.stop().catch(() => {});
    await A.app.close().catch(() => {});
    await B.app.close().catch(() => {});
    await rm(A.dataDir, { recursive: true, force: true }).catch(() => {});
    await rm(B.dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ================================================================ 1) GET /info */

test('传输：GET /info 免配对可访问，且不泄漏配对码/token', async () => {
  await withPair(async ({ A, device, aPort }) => {
    const { status, body } = await device(aPort, 'GET', '/info');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.app, 'potato-transfer');
    assert.equal(body.schema, 1, '协议版本必须是 1');
    assert.equal(body.device.name, 'A 机');
    assert.equal(body.port, aPort, '报出的端口要能被对方拿去回连');
    assert.equal(body.accepting, true);
    // 免配对的接口绝不能把"进门的东西"一起说出来
    assert.equal(body.code, undefined, '/info 不能带配对码');
    assert.equal(body.token, undefined, '/info 不能带 token');
    assert.equal(body.device.id, A.app.services.transfer.device.id);
  });
});

/* ================================================================ 2) 配对 */

test('传输：配对码错 5 次锁定，锁定期内正确码也拒绝，解锁后可换 token', async () => {
  // 锁定时间压到 200ms：验证的是状态机，不是真的等 60 秒
  await withPair(
    async ({ A, device, aPort }) => {
      const code = A.app.services.transfer.codeInfo().code;
      assert.match(code, /^\d{6}$/, '配对码是 6 位数字');

      // ① 错码：401 + 剩余次数递减（前端要靠这个提示"还能试几次"）
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const { status, body } = await device(aPort, 'POST', '/pair', { body: { code: '000000' === code ? '111111' : '000000', device: { id: 'peer-x', name: 'X' } } });
        assert.equal(status, 401, `第 ${attempt} 次错码应为 401`);
        assert.equal(body.error.code, 'UNAUTHORIZED');
        assert.equal(body.error.details.attemptsLeft, 5 - attempt);
      }
      assert.equal(A.app.services.transfer.codeAttempts, 4, '失败计数要真的递增');

      // ② 第 5 次错码 → 锁定（429）
      const locked = await device(aPort, 'POST', '/pair', { body: { code: '999999' === code ? '111111' : '999999', device: { id: 'peer-x', name: 'X' } } });
      assert.equal(locked.status, 429);
      assert.equal(locked.body.error.code, 'RATE_LIMITED');
      assert.equal(locked.body.error.details.locked, true);

      // ③ 锁定期内即使码是对的也拒绝
      const during = await device(aPort, 'POST', '/pair', { body: { code, device: { id: 'peer-x', name: 'X' } } });
      assert.equal(during.status, 429, '锁定期间正确码也必须拒绝');

      // ④ 解锁后正确码 → token（30 分钟有效）
      await sleep(250);
      const ok = await device(aPort, 'POST', '/pair', { body: { code, device: { id: 'peer-x', name: 'X' } } });
      assert.equal(ok.status, 200);
      assert.match(ok.body.token, /^[0-9a-f]{48}$/);
      const ttl = Date.parse(ok.body.expiresAt) - Date.now();
      assert.ok(ttl > 29 * 60 * 1000 && ttl <= 30 * 60 * 1000, 'token 应接近 30 分钟有效');
      assert.equal(A.app.services.transfer.codeAttempts, 0, '配对成功后失败计数归零');
      assert.equal(ok.body.device.name, 'A 机');
    },
    { a: { lockoutMs: 200 } },
  );
});

test('传输：/transfer 与 /progress 必须带有效 token（错/过期/缺失都是 401）', async () => {
  await withPair(
    async ({ device, aPort, A }) => {
      const bundle = { bundleId: 'b-1', schema: 1, from: { id: 'peer-x', name: 'X' }, collections: { notes: [] } };

      const missing = await device(aPort, 'POST', '/transfer', { body: bundle });
      assert.equal(missing.status, 401, '不带 token 不能传');
      const wrong = await device(aPort, 'POST', '/transfer', { body: bundle, token: 'deadbeef' });
      assert.equal(wrong.status, 401, 'token 不对不能传');

      // 过期 token：签发后把时钟推过 TTL（tokenTtlMs 压到 100ms 的实例）
      const code = A.app.services.transfer.codeInfo().code;
      const paired = await device(aPort, 'POST', '/pair', { body: { code, device: { id: 'peer-x', name: 'X' } } });
      assert.equal(paired.status, 200);
      await sleep(150);
      const expired = await device(aPort, 'POST', '/transfer', { body: bundle, token: paired.body.token });
      assert.equal(expired.status, 401);
      assert.match(expired.body.error.message, /过期/);

      const progress = await device(aPort, 'GET', '/progress');
      assert.equal(progress.status, 401, '/progress 同样要 token');
    },
    { a: { tokenTtlMs: 100 } },
  );
});

/* ================================================================ 3) 小 bundle + 幂等 */

test('传输：1 条笔记 + 1 条记忆 + 1 条待办真的落到接收方；重放同一份数据不重复写入', async () => {
  await withPair(async ({ A, B, send }) => {
    const note = await B.app.services.notes.create({ title: '操作系统复习', body: '# 第三章\n死锁的四个必要条件' });
    const memory = await B.app.services.memory.create({ scope: 'global', kind: 'preference', key: 'study_time', text: '我习惯晚上 19:00 之后安排学习任务' });
    const todo = await B.app.services.todos.create({ title: '交数据结构作业', deadline: '2026-10-20', estimatedHours: 3, priority: 2 });

    const first = await send(['notes', 'memories', 'todos']);
    assert.equal(first.sent, 3, '三条都该是新增');
    assert.equal(first.skipped, 0);
    assert.equal(first.renamed, 0);
    assert.equal(first.errors, 0);
    assert.equal(first.batches.total, 1, '三条小记录一批就够');

    // 用各模块**自己的读接口**验证数据真的进去了（不是看传输结果自说自话）
    const notes = A.app.services.notes.list();
    assert.equal(notes.length, 1);
    assert.equal(notes[0].title, '操作系统复习');
    assert.equal(A.app.services.notes.get(notes[0].id).body, '# 第三章\n死锁的四个必要条件');

    const memories = A.app.services.memory.list({ limit: 50 }).items;
    assert.equal(memories.length, 1);
    assert.equal(memories[0].key, 'study_time', '没有冲突时 key 原样保留');

    const todos = A.app.services.todos.list();
    assert.equal(todos.length, 1);
    assert.equal(todos[0].title, '交数据结构作业');
    assert.equal(todos[0].deadline, '2026-10-20');

    // ② 重放：用户再点一次发送（新的 bundleId，同样的内容）→ 靠内容指纹全部跳过
    const replay = await send(['notes', 'memories', 'todos']);
    assert.equal(replay.sent, 0, '重放不能再写入');
    assert.equal(replay.skipped, 3, '三条都应按"同 id 同内容"跳过');
    assert.equal(A.app.services.notes.list().length, 1);
    assert.equal(A.app.services.todos.list().length, 1);
    assert.equal(A.app.services.memory.list({ limit: 50 }).items.length, 1);

    // 日志：接收方能看到"谁在什么时候传了什么、成功几条"
    const log = A.app.services.transfer.logs({ limit: 5 });
    assert.equal(log.length, 2, '两轮传输各一条接收日志');
    assert.equal(log[0].direction, 'in');
    assert.equal(log[0].peer.name, 'B 机');
    assert.equal(log[0].summary.skipped, 3);
    assert.equal(log[1].summary.added, 3);
    assert.equal(B.app.services.transfer.logs({ limit: 5 })[0].direction, 'out');

    // 发送侧的结果里也能看到每一条的去向
    assert.equal(first.items[0].origin, 'B 机');
    assert.ok(first.items.every((item) => item.action === 'added'));
    assert.ok(note.id && memory.item.id && todo.id);
  });
});

/* ================================================================ 4) 同 id 不同内容 */

test('传输：同 id 不同内容 → 两条都留，新来的带 -from-<短id> 后缀与 origin', async () => {
  await withPair(async ({ A, B, send }) => {
    const created = await B.app.services.notes.create({ title: '实验报告', body: '第一版：只写了目的' });
    const noteId = created.id;

    const first = await send(['notes']);
    assert.equal(first.sent, 1);
    const receivedId = first.items[0].localId;
    assert.equal(first.items[0].action, 'added');
    assert.equal(first.items[0].alias, null, '第一次收下不需要别名');

    // 发送方把同一条笔记改了（同一个 id、不同内容）
    await B.app.services.notes.update(noteId, { body: '第二版：补上了数据与结论' });

    const second = await send(['notes']);
    assert.equal(second.renamed, 1, '同 id 不同内容应计为 renamed');
    assert.equal(second.sent, 0, '不能再"新增"一条同名记录');
    const item = second.items.find((one) => one.collection === 'notes');
    const shortId = B.app.services.transfer.device.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 6);
    assert.equal(item.alias, `${noteId}-from-${shortId}`, '新来的那条要有 -from-<设备短id> 后缀');
    assert.equal(item.origin, 'B 机', '要记下它来自哪台设备');
    assert.notEqual(item.localId, receivedId, '两条是不同的本地记录');

    // 两条都在（第一版没被覆盖）
    const notes = A.app.services.notes.list();
    assert.equal(notes.length, 2);
    const bodies = notes.map((one) => A.app.services.notes.get(one.id).body).sort();
    assert.deepEqual(bodies, ['第一版：只写了目的', '第二版：补上了数据与结论']);

    // 账本里"远端 id ↔ 本地 id"两条映射都在，重放第二版仍然幂等
    const ledger = A.app.services.transfer.ledger.get(`${B.app.services.transfer.device.id}|notes|${noteId}`);
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0].localId, receivedId);
    assert.equal(ledger[1].alias, `${noteId}-from-${shortId}`);
    // 发送方现在手里只有最新版那一条：重放时它必须被认出来（不能再多一条）
    const third = await send(['notes']);
    assert.equal(third.sent, 0);
    assert.equal(third.skipped, 1, '最新版内容已经收过 → 跳过');
    assert.equal(A.app.services.notes.list().length, 2);
  });
});

/* ================================================================ 5) 不同 id 同名 */

test('传输：不同 id 同名 → 两条都留，并进「疑似重复」清单（可由用户删除本机这条）', async () => {
  await withPair(async ({ A, B, send }) => {
    // 两台设备上各有一条同名但不同 id 的笔记（典型场景：两边都手敲过一遍）
    await A.app.services.notes.create({ title: '线性代数笔记', body: '本机版本：矩阵的秩' });
    await B.app.services.notes.create({ title: '线性代数笔记', body: '另一台版本：秩与解空间' });

    const result = await send(['notes']);
    assert.equal(result.sent, 1, '同名不是"同一条"，照样收下');
    assert.equal(result.duplicates.length, 1, '要进疑似重复清单');
    const suspect = result.duplicates[0];
    assert.equal(suspect.kind, 'duplicate');
    assert.equal(suspect.collection, 'notes');
    assert.equal(suspect.origin.name, 'B 机');
    assert.ok(suspect.existingId, '清单里要能指回本机原来那条');

    // 两条都在
    assert.equal(A.app.services.notes.list().length, 2);
    // 接收方页面上能看到这条待处理
    const pending = A.app.services.transfer.status().suspects;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, suspect.id);

    // 用户选「删除本机这条」→ 走笔记模块自己的删除入口
    const resolved = await A.app.services.transfer.resolveSuspect({ id: suspect.id, action: 'delete' });
    assert.equal(resolved.deleted, true);
    assert.equal(A.app.services.notes.list().length, 1, '删掉的是刚收下的那条');
    assert.equal(A.app.services.transfer.status().suspects.length, 0);
  });
});

test('传输：疑似重复选「保留」→ 两条都留，只是从清单里划掉', async () => {
  await withPair(async ({ A, B, send }) => {
    await A.app.services.notes.create({ title: '重名笔记', body: 'A 版' });
    await B.app.services.notes.create({ title: '重名笔记', body: 'B 版' });
    const result = await send(['notes']);
    const suspect = result.duplicates[0];
    const resolved = await A.app.services.transfer.resolveSuspect({ id: suspect.id, action: 'keep' });
    assert.equal(resolved.deleted, false);
    assert.equal(A.app.services.notes.list().length, 2);
    assert.equal(A.app.services.transfer.status().suspects.length, 0);
  });
});

/* ================================================================ 6) 记忆 scope+key 冲突 */

test('传输：记忆 scope+key 冲突 → 两条并存且不自动 supersede', async () => {
  await withPair(async ({ A, B, send }) => {
    const local = await A.app.services.memory.create({ scope: 'global', kind: 'preference', key: 'study_time', text: '我习惯晚上学习' });
    await B.app.services.memory.create({ scope: 'global', kind: 'preference', key: 'study_time', text: '我习惯早上学习' });

    const result = await send(['memories']);
    assert.equal(result.conflicts, 1, '冲突要单独计数（它不是失败）');
    assert.equal(result.sent, 0, '冲突的这条不算"新增成功"，它在等用户决定');

    const items = A.app.services.memory.list({ limit: 50 }).items;
    assert.equal(items.length, 2, '两条都要在');
    // 没有自动取代：本机原来那条必须还是 active，没有任何一条被标成 superseded
    assert.equal(items.filter((one) => one.status === 'superseded').length, 0, '不许自动 supersede');
    const original = items.find((one) => one.id === local.item.id);
    assert.equal(original.status, 'active');
    assert.equal(original.text, '我习惯晚上学习');
    assert.equal(original.supersededBy, null);

    // 并存的那条带 -from-<短id> 后缀的 key，并进了冲突清单让用户选
    const incoming = items.find((one) => one.id !== local.item.id);
    const shortId = B.app.services.transfer.device.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 6);
    // key 的语法由记忆模块定（小写字母/数字/下划线），所以并存条用 `_from_` 而不是 id 后缀那种 `-from-`
    assert.equal(incoming.key, `study_time_from_${shortId}`);
    assert.equal(incoming.text, '我习惯早上学习');
    assert.equal(incoming.status, 'active');

    const conflict = A.app.services.transfer.status().suspects.find((one) => one.kind === 'memory-conflict');
    assert.ok(conflict, '冲突要进清单');
    assert.equal(conflict.existingId, local.item.id);
    assert.equal(conflict.localId, incoming.id);

    // 再传一次：内容已存在 → 跳过（不会每次同步都多一条）
    const again = await send(['memories']);
    assert.equal(again.skipped, 1);
    const after = A.app.services.memory.list({ limit: 50 }).items;
    assert.equal(after.length, 2);
  });
});

/* ================================================================ 7) 没有写入口的集合 */

test('传输：接收侧没有写入口的集合（对话/消息）如实跳过，绝不直接改别人的文件', async () => {
  await withPair(async ({ A, B, send }) => {
    // 制造一条真实存在的对话（对话只在发送侧存在 —— 接收侧没有写入口，见 catalog.js）
    await B.app.services.ai.createConversation('关于期末复习的对话');
    await B.app.store.aiMessages.insert({ id: 'msg-1', conversationId: 'c-1', role: 'user', content: '期末考试什么时候？' });

    const result = await send(['conversations', 'messages']);
    const skipped = result.items.filter((one) => one.action === 'skipped');
    assert.equal(skipped.length, result.items.length);
    assert.ok(skipped.every((one) => /写入口|入口|跳过/.test(one.reason)), '跳过必须给出原因');
    assert.equal(result.sent, 0);
    // 接收方的对话集合一条都没多（说明我们没有绕过服务去写文件）
    assert.equal(A.app.services.store.aiConversations.all().length, 0);
    assert.equal(A.app.services.store.aiMessages.all().length, 0);
  });
});

/* ================================================================ 8) 分片 */

test('传输：单条 >2MB 的笔记正文单独成批并如实回报截断；多条大笔记合计 >2MB 时完整无损', async () => {
  await withPair(async ({ A, B, send }) => {
    // ① 超大单条：直接写集合（笔记模块的 create 上限 20 万字，造不出 2MB 的正文）
    const huge = 'x'.repeat(2 * 1024 * 1024 + 1024);
    await B.app.store.notes.insert({ id: 'note-huge', title: '超大笔记', body: huge, tags: [], attachments: [], format: 'markdown', source: 'manual', status: 'ready' });

    // ② 12 条 20 万字的笔记：合计约 2.4MB，用来证明"分片本身无损"
    const bodies = [];
    for (let index = 0; index < 12; index += 1) {
      const body = `${index}`.padEnd(200_000, '字');
      bodies.push(body);
      await B.app.services.notes.create({ title: `大笔记 ${index}`, body });
    }

    const result = await send(['notes']);
    assert.ok(result.batches.total >= 3, `2.4MB 内容应分成多批（实际 ${result.batches.total} 批）`);
    assert.equal(result.batches.oversized, 1, '超标的单条独占一批并标记');
    assert.ok(result.batches.bytes > 4 * 1024 * 1024, '总字节数应超过 4MB');

    // 完整无损：12 条 20 万字的笔记正文一字不差
    for (const body of bodies) {
      const found = A.app.services.notes.list().find((one) => A.app.services.notes.get(one.id).body === body);
      assert.ok(found, '每条大笔记都该完整到达');
    }

    // 超大那条：笔记模块按自己的 20 万字上限截断，**如实报进结果**（不静默）
    const item = result.items.find((one) => one.remoteId === 'note-huge');
    assert.equal(item.action, 'added');
    assert.equal(item.truncated.wanted, huge.length);
    assert.equal(item.truncated.got, 200_000);
    assert.match(item.note, /截断/);
    // 而且确实落库了（不是丢掉），只是短了
    const saved = A.app.services.notes.list().find((one) => one.title === '超大笔记');
    assert.ok(saved);
    assert.equal(A.app.services.notes.get(saved.id).body.length, 200_000);
  });
});

test('传输：分片装箱每批不超过 2MB（纯函数，超大单条例外）', () => {
  const base = { bundleId: 'b', schema: 1, from: { id: 'x' }, createdAt: '2026-01-01T00:00:00.000Z' };
  const entries = [];
  for (let index = 0; index < 30; index += 1) entries.push({ collection: 'notes', item: { id: `n${index}`, title: `t${index}`, body: 'y'.repeat(200_000) } });
  const chunks = buildChunks(base, entries, CHUNK_BYTES);
  assert.ok(chunks.length > 1, '应切成多批');
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.count, 0), 30, '一条都不能丢');
  assert.ok(chunks.every((chunk) => chunk.bytes <= CHUNK_BYTES), '每批都必须 ≤ 2MB');

  // 单条超标：独占一批并标记 oversized（否则它永远排不进任何一批）
  const giant = buildChunks(base, [{ collection: 'notes', item: { id: 'big', body: 'z'.repeat(3 * 1024 * 1024) } }], CHUNK_BYTES);
  assert.equal(giant.length, 1);
  assert.equal(giant[0].oversized, true);
});

/* ================================================================ 9) 接收开关 / 协议校验 */

test('传输：关掉「允许接收」后对方连不上；协议版本不一致直接 400', async () => {
  await withPair(async ({ A, B, device, aPort, send }) => {
    A.app.services.transfer.updateSettings({ accepting: false });
    await assert.rejects(() => send(['notes']), (error) => error.status === 409 && /允许接收/.test(error.message));

    const info = await device(aPort, 'GET', '/info');
    assert.equal(info.body.accepting, false, '/info 要如实说"我现在不收"');

    // 关掉接收后旧 token 也一并作废，不能"关了还能传"
    A.app.services.transfer.updateSettings({ accepting: true });
    const code = A.app.services.transfer.codeInfo().code;
    const paired = await device(aPort, 'POST', '/pair', { body: { code, device: { id: 'peer-x', name: 'X' } } });
    assert.equal(paired.status, 200);
    A.app.services.transfer.updateSettings({ accepting: false });
    const blocked = await device(aPort, 'POST', '/transfer', { body: { bundleId: 'b', schema: 1, from: { id: 'peer-x', name: 'X' }, collections: {} }, token: paired.body.token });
    assert.equal(blocked.status, 403);
    A.app.services.transfer.updateSettings({ accepting: true });

    // 协议版本不一致：宁可断在这一步，也不要按错误的结构解析对方的数据（重新配对拿新 token）
    const again = await device(aPort, 'POST', '/pair', { body: { code: A.app.services.transfer.codeInfo().code, device: { id: 'peer-x', name: 'X' } } });
    assert.equal(again.status, 200);
    const badSchema = await device(aPort, 'POST', '/transfer', { body: { bundleId: 'b', schema: 99, from: { id: 'peer-x', name: 'X' }, collections: {} }, token: again.body.token });
    assert.equal(badSchema.status, 400);
    assert.equal(badSchema.body.error.details.expected, 1);

    // 没见过的路径 → 404（设备服务器只有协议里的 4 条路由）
    const notFound = await device(aPort, 'GET', '/api/v1/notes');
    assert.equal(notFound.status, 404);
    void B;
  });
});

/* ================================================================ 10) 端口与定时器 */

test('传输：stop() 之后端口释放、句柄清零、没有悬挂定时器（测试进程能自然退出）', async () => {
  const aPort = await freePort();
  const A = await startNode({ port: aPort, name: 'A 机' });
  try {
    const transfer = A.app.services.transfer;
    assert.equal(transfer.status().listening, true);
    assert.equal((await transfer.ready()).port, aPort);
    // 开着「可被发现」跑一遍：广播定时器也要能被 stop 清掉
    await transfer.updateSettings({ discoverable: true });
    assert.equal(transfer.handles().http, true);
    assert.equal(transfer.handles().broadcasting, true);

    const started = Date.now();
    await transfer.stop();
    assert.ok(Date.now() - started < 2000, 'stop() 必须自己返回，不能等某个连接超时');

    // ① 句柄清零：HTTP server / 监听态 / UDP socket / 待写标记都该为假
    assert.deepEqual(transfer.handles(), { http: false, listening: false, udp: false, broadcasting: false, pendingWrite: false });
    assert.equal(transfer.status().listening, false);

    // ② 端口真的释放了：resolve 之后**立刻** bind 同一个端口必须成功
    //   （否则测试进程/下一次启动会踩到自己；这也是"npm test 挂住"那类问题的根因）
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(aPort, '127.0.0.1', resolve);
    });
    await new Promise((resolve) => probe.close(resolve));

    // ③ stop() 之后立刻删 dataDir 必须成功：不许再有迟到的写入
    await rm(A.dataDir, { recursive: true });
    await sleep(300);
    assert.equal(existsSync(A.dataDir), false);

    // ④ 停两次都安全（框架 close 与测试可能各调一次），并发调用返回同一个 Promise
    const [one, two] = [transfer.stop(), transfer.stop()];
    assert.equal(one, two, '重复 stop 应复用同一个 Promise');
    await Promise.all([one, two]);
  } finally {
    await A.app.close().catch(() => {});
    await rm(A.dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

/* ================================================================ 11) UDP 发现（不真发包） */

test('传输：UDP 发现只测解析与状态机（注入假 socket，绝不真广播）', async () => {
  // ① 报文解析：只认协议里的两种 t、v=1、带 id 的报文
  assert.equal(parseDiscoveryMessage('not json'), null);
  assert.equal(parseDiscoveryMessage('{"t":"potato.find","v":2,"id":"x"}'), null, '版本不对要丢掉');
  assert.equal(parseDiscoveryMessage('{"t":"other","v":1,"id":"x"}'), null, '别人的广播要丢掉');
  assert.equal(parseDiscoveryMessage('{"t":"potato.find","v":1}'), null, '没有 id 要丢掉');
  const parsed = parseDiscoveryMessage('{"t":"potato.here","v":1,"id":"b-1","name":"B 机","platform":"darwin","port":8886,"accepting":true}', '192.168.1.9');
  assert.deepEqual(
    { id: parsed.id, name: parsed.name, platform: parsed.platform, port: parsed.port, accepting: parsed.accepting, host: parsed.host },
    { id: 'b-1', name: 'B 机', platform: 'darwin', port: 8886, accepting: true, host: '192.168.1.9' },
  );
  // find 报文里没有 accepting：必须解析成 null（"未知"），不能瞎猜成"可以收"
  assert.equal(parseDiscoveryMessage('{"t":"potato.find","v":1,"id":"c-1","name":"C"}').accepting, null);

  // ② 状态机：注入假 socket 与假 send，一个真包都不发
  const sent = [];
  let socketListeners = {};
  const fakeSocket = {
    on(event, handler) {
      socketListeners[event] = handler;
      return this;
    },
    bind() {
      return this;
    },
    setBroadcast() {},
    send() {},
    close() {
      this.closed = true;
    },
  };
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const discovery = createDiscovery({
    port: 8886,
    info: () => ({ id: 'a-1', name: 'A 机', platform: 'darwin', port: 8886, accepting: true }),
    createSocket: () => fakeSocket,
    send: (socket, packet, target) => sent.push({ packet: JSON.parse(String(packet)), target }),
    now: () => clock,
  });

  discovery.start();
  assert.equal(socketListeners.message instanceof Function, true, '要真的挂上 message 监听');

  // 关着「可被发现」时：只看得到别人，不回包（隐身但仍然能主动传数据）
  socketListeners.message(Buffer.from('{"t":"potato.find","v":1,"id":"b-1","name":"B 机","port":8886}'), { address: '192.168.1.9' });
  assert.equal(sent.length, 0, '未开启可被发现时不许回包');
  assert.equal(discovery.list().length, 1);
  assert.equal(discovery.list()[0].host, '192.168.1.9');
  assert.equal(discovery.list()[0].accepting, null);

  // 打开开关：立刻广播一轮，并且收到 find 要回 here
  discovery.setEnabled(true);
  assert.equal(sent.length, 1, '打开开关要立刻广播一次（用户不该等 5 秒）');
  assert.equal(sent[0].packet.t, 'potato.find');
  assert.equal(sent[0].target.address, '255.255.255.255');
  socketListeners.message(Buffer.from('{"t":"potato.find","v":1,"id":"c-1","name":"C 机","port":8886}'), { address: '192.168.1.10' });
  const here = sent.find((one) => one.packet.t === 'potato.here');
  assert.ok(here, '愿意被发现时要回 here');
  assert.equal(here.packet.accepting, true);
  assert.equal(here.target.address, '192.168.1.10', 'here 是单播回给对方');

  // 自己的广播回环回来要丢掉
  const before = discovery.list().length;
  socketListeners.message(Buffer.from('{"t":"potato.find","v":1,"id":"a-1","name":"A 机","port":8886}'), { address: '127.0.0.1' });
  assert.equal(discovery.list().length, before, '不能把自己当同伴');

  // 超时清理：15 秒（3 个广播周期）没消息就算离线；手工添加的不过期
  clock += 16_000;
  discovery.tick();
  assert.equal(discovery.list().length, 0, '广播来的同伴超时要清掉');
  discovery.remember({ id: 'm-1', name: '手工设备', port: 8886 }, '10.0.0.5', 'manual');
  clock += 60_000;
  discovery.tick();
  assert.equal(discovery.list().length, 1, '手工添加的同伴不过期');
  assert.equal(discovery.list()[0].via, 'manual');

  discovery.setEnabled(false);
  const countAfterDisable = sent.length;
  clock += 10_000;
  discovery.tick();
  assert.equal(sent.length, countAfterDisable, '关掉开关后不再广播');

  discovery.stop();
  assert.equal(fakeSocket.closed, true, 'stop() 要关掉 UDP socket');
});

test('传输：手工添加 IP:8886 会先探 /info（端口写错当场报错）', async () => {
  await withPair(async ({ A, B, bPort }) => {
    const peer = await A.app.services.transfer.addManualPeer({ host: '127.0.0.1', port: bPort });
    assert.equal(peer.name, 'B 机');
    assert.equal(peer.via, 'manual');
    assert.equal(peer.port, bPort);
    assert.equal(A.app.services.transfer.peers().length, 1);

    // 没人监听的端口 → 必须报"连不上"，而不是傻等（这里用一个刚释放的空闲端口）
    const deadPort = await freePort();
    await assert.rejects(() => A.app.services.transfer.addManualPeer({ host: '127.0.0.1', port: deadPort }), /连不上/);
    await assert.rejects(() => A.app.services.transfer.addManualPeer({ host: '127.0.0.1', port: A.app.services.transfer.port }), /本机/);
    void B;
  });
});

/* ================================================================ 12) 控制面路由 */

test('传输：本机控制面路由（/api/v1/transfer）能拿到状态、目录与日志', async () => {
  await withPair(async ({ A, B, send }) => {
    const api = async (route, options) => {
      const response = await fetch(`http://127.0.0.1:${A.info.port}/api/v1${route}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
        body: options?.body ? JSON.stringify(options.body) : undefined,
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    void B;

    const status = await api('/transfer/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.ok, true);
    assert.equal(status.body.device.name, 'A 机');
    assert.match(status.body.code.code, /^\d{6}$/, '页面上要能看到配对码');
    assert.equal(status.body.listening, true);

    const catalog = await api('/transfer/catalog');
    const names = catalog.body.catalog.map((one) => one.name);
    for (const expected of ['conversations', 'messages', 'memories', 'notes', 'todos', 'schedules', 'events', 'cards', 'goals', 'grades']) {
      assert.ok(names.includes(expected), `目录里应有 ${expected}`);
    }
    const grades = catalog.body.catalog.find((one) => one.name === 'grades');
    assert.equal(grades.sendable, false, '成绩默认不传');
    assert.match(grades.reason, /隐私/);
    assert.equal(catalog.body.catalog.find((one) => one.name === 'conversations').importable, false, '对话接收侧没有写入口');

    const swapped = await api('/transfer/code', { method: 'POST' });
    assert.notEqual(swapped.body.code.code, status.body.code.code, '「换一个」要真的换');

    const settings = await api('/transfer/settings', { method: 'POST', body: { deviceName: '书房电脑' } });
    assert.equal(settings.body.device.name, '书房电脑');

    await A.app.services.notes.create({ title: '待传笔记', body: '内容' });
    const sent = await api('/transfer/send', { method: 'POST', body: { host: '127.0.0.1', port: 1, code: '000000', collections: ['notes'] } });
    assert.equal(sent.status, 502, '连不上对方要给明确的 502（而不是 500）');

    const log = await api('/transfer/log?limit=5');
    assert.ok(Array.isArray(log.body.items));
  });
});

/* ================================================================ 13) 落盘与重启 */

test('传输：设备标识、日志与幂等账本落盘（重启后设备 id 不变、重放仍幂等）', async () => {
  const aPort = await freePort();
  const bPort = await freePort();
  const aDir = await mkdtemp(path.join(tmpdir(), 'potato-transfer-persist-a-'));
  const bDir = await mkdtemp(path.join(tmpdir(), 'potato-transfer-persist-b-'));
  const boot = async (dataDir, port, name) => {
    const app = await createServer({ dataDir, transfer: { port, discovery: false, deviceName: name } });
    await app.listen({ port: 0 });
    await app.services.transfer.ready();
    return app;
  };

  let A = await boot(aDir, aPort, 'A 机');
  const deviceId = A.services.transfer.device.id;
  const code = A.services.transfer.codeInfo().code;
  const B = await boot(bDir, bPort, 'B 机');
  await B.services.notes.create({ title: '持久化验证', body: '重启后不该重复' });

  const first = await B.services.transfer.sendTo({ host: '127.0.0.1', port: aPort, code, collections: ['notes'] });
  assert.equal(first.sent, 1);

  // 重启接收方（同一个 dataDir）：设备 id / 日志 / 幂等账本都该读回来
  await A.services.transfer.stop();
  await A.close();
  A = await boot(aDir, aPort, 'A 机');
  assert.equal(A.services.transfer.device.id, deviceId, '设备 id 必须稳定（对方的账本按它记）');
  assert.equal(A.services.transfer.logs().length, 1, '重启后日志还在');
  assert.equal(A.services.transfer.status().suspects.length, 0);

  const replay = await B.services.transfer.sendTo({ host: '127.0.0.1', port: aPort, code: A.services.transfer.codeInfo().code, collections: ['notes'] });
  assert.equal(replay.sent, 0, '重启后重放仍然幂等（这就是账本要落盘的原因）');
  assert.equal(replay.skipped, 1);
  assert.equal(A.services.notes.list().length, 1);

  await A.services.transfer.stop();
  await A.close();
  await B.services.transfer.stop();
  await B.close();
  await rm(aDir, { recursive: true, force: true });
  await rm(bDir, { recursive: true, force: true });
});

/* ================================================================ 14) stop() 的写入契约 */

test('传输：close() 之后立刻删 dataDir 不会撞上"还在写文件"，1.5 秒内不再冒出新文件', async () => {
  // 这条测试锁的是模块 stop 钩子的基本契约：**stop() 返回之后不许再碰 dataDir**。
  // 起因：早期版本在 stop() 里无条件写一次状态文件，而框架的 close() 不等模块的 stop
  // （`mod.stop?.(ctx)` 的返回值被丢掉），于是"起后端 → 用完删临时目录"的测试随机报
  // ENOTEMPTY: rmdir（memory 的集成测试一次红了 10 个）。现在只写"有变化"的状态，
  // 并且 stop() 会 await 落盘 + 等写入队列清空。
  const quietPort = await freePort();

  // ① 从没传过东西的实例：dataDir 里不该出现我们写的任何文件
  const quietDir = await mkdtemp(path.join(tmpdir(), 'potato-transfer-quiet-'));
  const quiet = await createServer({ dataDir: quietDir, transfer: { port: quietPort, discovery: false, deviceName: '安静实例' } });
  await quiet.listen({ port: 0 });
  await quiet.services.transfer.ready();
  await quiet.close();
  await rm(quietDir, { recursive: true }); // 故意不给 force / maxRetries：删不掉就是契约破了
  await sleep(1500);
  assert.equal(existsSync(quietDir), false, '关闭 1.5 秒后不该再有目录（说明没有迟到的写入）');

  // ② 传过东西的实例：状态已经落盘，close() 之后立刻删也必须成功
  const aPort = await freePort();
  const bPort = await freePort();
  const aDir = await mkdtemp(path.join(tmpdir(), 'potato-transfer-busy-'));
  const bDir = await mkdtemp(path.join(tmpdir(), 'potato-transfer-busy-b-'));
  const A = await createServer({ dataDir: aDir, transfer: { port: aPort, discovery: false, deviceName: 'A 机' } });
  await A.listen({ port: 0 });
  await A.services.transfer.ready();
  const B = await createServer({ dataDir: bDir, transfer: { port: bPort, discovery: false, deviceName: 'B 机' } });
  await B.listen({ port: 0 });
  await B.services.transfer.ready();

  await B.services.notes.create({ title: '写入契约', body: '这条会让接收方落一次盘' });
  const result = await B.services.transfer.sendTo({ host: '127.0.0.1', port: aPort, code: A.services.transfer.codeInfo().code, collections: ['notes'] });
  assert.equal(result.sent, 1);
  // 状态文件确实写出来了（证明"不写"不是因为功能坏了）
  await A.services.transfer.updateSettings({ accepting: true });
  assert.ok((await readdir(aDir)).includes('transfer-log.json'), '有变化时状态文件必须落盘');

  await B.close();
  await A.close();
  await rm(aDir, { recursive: true });
  await rm(bDir, { recursive: true });
  await sleep(1500);
  assert.equal(existsSync(aDir), false, '关闭 1.5 秒后不该再有目录');
  assert.equal(existsSync(bDir), false, '关闭 1.5 秒后不该再有目录');
});

/* ================================================================ 15) 其余可接收集合 */

test('传输：卡片 / 目标 / 日程 / 事件 也能真的收下（逐条走各自模块的服务）', async () => {
  await withPair(async ({ A, B, send }) => {
    await B.app.services.cards.create({ front: 'TCP 三次握手', back: 'SYN / SYN+ACK / ACK', tags: ['网络'], course: '计算机网络' });
    await B.app.services.goals.create({ title: '本学期绩点上 3.8', kind: 'goal', targetDate: '2027-01-15', priority: 1 });
    await B.app.services.schedules.create({ title: '数据结构课', date: '2026-10-20', startTime: '08:00', endTime: '09:40', location: '主楼 A203', category: 'class' });
    await B.app.services.events.create({ title: '期中考试周', startDate: '2026-11-02', endDate: '2026-11-06', category: 'exam' });

    const result = await send(['cards', 'goals', 'schedules', 'events']);
    assert.equal(result.errors, 0, `不该有失败：${JSON.stringify(result.items.filter((one) => one.action === 'failed'))}`);
    assert.equal(result.sent, 4, '四类各一条都要收下');

    // 用各模块自己的读接口验证（不是看传输结果自说自话）
    const card = A.app.services.cards.list().items.find((one) => one.front === 'TCP 三次握手');
    assert.ok(card, '卡片要收下');
    assert.equal(card.back, 'SYN / SYN+ACK / ACK');
    assert.equal(card.reps, 0, '复习进度不跟着传，从零开始');

    const goal = A.app.services.goals.list().items.find((one) => one.title === '本学期绩点上 3.8');
    assert.ok(goal, '目标要收下');
    assert.equal(goal.targetDate, '2027-01-15');

    const schedule = A.app.services.schedules.list({ from: '2026-10-20', to: '2026-10-20' }).find((one) => one.title === '数据结构课');
    assert.ok(schedule, '日程要收下');
    assert.equal(schedule.startTime, '08:00');
    assert.equal(schedule.category, 'class');

    const event = A.app.services.events.list({ from: '2026-11-02', to: '2026-11-06' }).find((one) => one.title === '期中考试周');
    assert.ok(event, '事件要收下');
    assert.equal(event.startDate, '2026-11-02');

    // 再传一次：四类都应跳过（幂等对每个集合都成立，不只是笔记）
    const again = await send(['cards', 'goals', 'schedules', 'events']);
    assert.equal(again.skipped, 4);
    assert.equal(A.app.services.cards.list().items.length, 1);
    assert.equal(A.app.services.goals.list().items.length, 1);
  });
});
