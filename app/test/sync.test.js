/**
 * 「多端同步」的集成测试。
 *
 * 测试原则（与 transfer.test.js 同一套）：
 *   1. **零真实外网**：全部请求打在本文件起来的实例上 —— 真实后端当"服务器"
 *      （跑的是同一套模块，同步路由就在里面），另有 `node:http` 起的**假同步服务器**
 *      用来断言"推出去的 body 里到底有什么"以及 401/畸形响应这些真实后端不配合的场景；
 *   2. **真数据、真链路**：设备 A/B 是各自临时 dataDir 的真实后端实例，
 *      账号文件（`data/account.json`，0600）指向"服务器"，`/sync/run` 走真实 HTTP + Bearer；
 *   3. **端口全随机**：8886 上很可能正跑着开发实例，抢端口会让测试随机红
 *      （transfer 模块用 `transfer.port` 换成随机端口，并关掉 UDP 广播）；
 *   4. 每个用例一条口径，失败时能立刻看出坏的是哪一条。
 *
 * 覆盖的口径（逐条对应工单）：
 *   - A 加笔记 → push → B pull 能看到；
 *   - 同 id 不同内容 → 两条都留，且 renamed/conflicts/duplicates 有记录；
 *   - 不同 id 同名 → 进 duplicates；
 *   - 重复同步幂等（第二次 pushed=0、skipped>0、条数不变）；
 *   - 删除同步：notes 软删除会传播；不支持的集合在报告里如实标注；
 *   - 远端不可达 / 401 / 畸形响应 → 本地数据**逐字节零改动**；
 *   - ai-config 默认不同步；勾上之后才进 push/pull（含 key）；
 *     `academic-*` / `lms-*` / `ai-usage` **永远不在** push body 里；
 *   - 敏感数据（AI key / 学堂凭据）默认关闭、只能逐台开启、未开启的设备 pull 到也不落盘；
 *   - `data/sync-state.json` 权限 0600、deviceId 稳定；run 的返回里搜不到会话令牌。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { createServer } from '../src/server/index.js';
import { STATE_FILE } from '../src/modules/sync/service.js';

/** 假服务器认的令牌：断言它绝不出现在任何返回/日志里。 */
const TOKEN = 'tok_sync_5f3a91c2d4e607b8a1c3';

/* ---------------------------------------------------------------- 脚手架 */

/** 取一个空闲端口（bind 0 拿系统分配的，随即释放）。 */
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * 起一个真实后端实例（"设备"与"服务器"都用它）。
 *
 * `sync.autoRun` 默认关：自动同步由专门的用例显式验，别让它在别的用例里抢跑。
 * `account.defaultServerUrl` 可以在需要"没有服务器地址"的场景里设成空串。
 */
async function startNode(name, { dataDir = null, sync = {}, account = null } = {}) {
  const dir = dataDir ?? (await mkdtemp(path.join(tmpdir(), 'potato-sync-')));
  const app = await createServer({
    dataDir: dir,
    sync: { deviceName: name, autoRun: false, ...sync },
    ...(account ? { account } : {}),
    // 8886 只允许一个进程占用：给每个实例一个随机端口，并且不发 UDP 广播
    transfer: { discovery: false, port: await freePort() },
  });
  const info = await app.listen({ port: 0 });
  return { app, dataDir: dir, url: `http://127.0.0.1:${info.port}`, name };
}

/** 让一个设备"登录"到某台服务器：写 `data/account.json`（0600）并让 account 服务读回。 */
async function connect(client, serverUrl, token = TOKEN) {
  const file = path.join(client.dataDir, 'account.json');
  await writeFile(file, JSON.stringify({ serverUrl, token, user: { username: 'alice', role: 'admin' }, loginAt: new Date().toISOString() }), { mode: 0o600 });
  await chmod(file, 0o600);
  await client.app.services.account.load();
}

/** 关掉一批实例并删掉数据目录。 */
async function teardown(nodes) {
  for (const node of nodes) await node?.app?.close().catch(() => {});
  for (const node of nodes) if (node?.dataDir) await rm(node.dataDir, { recursive: true, force: true }).catch(() => {});
}

/** 一个「服务器 + 两台设备」的小集群，跑完自动收摊。 */
async function withCluster(run) {
  const S = await startNode('服务器 S');
  const A = await startNode('A 机');
  const B = await startNode('B 机');
  await connect(A, S.url);
  await connect(B, S.url);
  try {
    return await run({ S, A, B });
  } finally {
    await teardown([A, B, S]);
  }
}

/**
 * 假同步服务器（`node:http`）：记录每个请求的 body，按脚本回 push/pull 响应。
 *
 * 为什么需要它：真后端不配合"故意 401"、"故意返回畸形响应"、"我要看看推上来的 body 里
 * 到底有没有 academic-* 这些名字"这三件事；而这三件事恰恰是最容易出错的边界。
 */
async function startFakeSyncServer({ pushStatus = 200, pushBody = null, pullStatus = 200, pullBody = null } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      requests.push({ method: req.method, url: req.url, body, raw, headers: req.headers });
      const isPush = String(req.url).includes('/push');
      const status = isPush ? pushStatus : pullStatus;
      const payload =
        (isPush ? pushBody : pullBody) ??
        (isPush
          ? {
              ok: true,
              accepted: 0,
              skipped: Object.values(body?.collections ?? {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0),
              updated: 0,
              renamed: 0,
              deleted: 0,
              errors: 0,
              groups: {},
              duplicates: [],
              conflicts: [],
              serverTime: new Date().toISOString(),
              serverDeviceId: 'fake-server-device',
            }
          : {
              ok: true,
              serverTime: new Date().toISOString(),
              nextSince: new Date().toISOString(),
              collections: {},
              deleted: {},
              serverDeviceId: 'fake-server-device',
            });
      const text = JSON.stringify(status === 200 ? payload : { ok: false, error: { code: 'UNAUTHORIZED', message: '需要先登录' } });
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(text);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    pushes: () => requests.filter((item) => item.url.includes('/push')),
    pulls: () => requests.filter((item) => item.url.includes('/pull')),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

/** 设备数据目录里"业务数据文件"的逐字节快照（同步状态/账本/账号文件不算业务数据）。 */
async function snapshotCollections(dataDir) {
  const out = {};
  for (const name of await readdir(dataDir)) {
    if (!name.endsWith('.json')) continue;
    if (name.startsWith('sync-') || name === 'account.json') continue;
    out[name] = await readFile(path.join(dataDir, name), 'utf8');
  }
  return out;
}

/** 往设备里放一份"学堂已登录"的凭据文件（形状与 auth 模块写的完全一致）。 */
async function seedLmsSession(node, value = 'tgc-from-A') {
  const file = path.join(node.dataDir, 'auth-session.json');
  await writeFile(
    file,
    JSON.stringify(
      { savedAt: new Date().toISOString(), cookies: [{ name: 'TGC', value, domain: 'login.xjtu.edu.cn', path: '/', secure: false, expiresAt: null }], sites: {} },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await chmod(file, 0o600);
  await node.app.services.auth.restore();
}

const noteTitles = (node) => node.app.store.notes.all().map((item) => item.title).sort();
const bodies = (node) => node.app.store.notes.all().map((item) => item.body).sort();

/* ================================================================ 1) 基本链路 */

test('同步：A 加笔记 → push → B pull 就能看到（同一个 id，同一份内容）', async () => {
  await withCluster(async ({ S, A, B }) => {
    const created = await A.app.services.notes.create({ title: '同步测试笔记', body: '来自 A 机' });

    const reportA = await A.app.services.sync.run({});
    assert.equal(reportA.ok, true, JSON.stringify(reportA.error));
    assert.equal(reportA.pushed, 1, 'A 应该把这条笔记推上去');
    assert.deepEqual(
      S.app.store.notes.all().map((item) => item.id),
      [created.id],
      '服务器上必须有，而且 id 与来源一致（同步保留 id）',
    );

    const reportB = await B.app.services.sync.run({});
    assert.equal(reportB.ok, true, JSON.stringify(reportB.error));
    assert.equal(reportB.pulled, 1, 'B 应该拉到一条新记录');
    const inB = B.app.store.notes.get(created.id);
    assert.ok(inB, 'B 必须能看到 A 建的笔记');
    assert.equal(inB.title, '同步测试笔记');
    assert.equal(inB.body, '来自 A 机');
  });
});

test('同步：一次 run 既是"发布"也是"接收"（本机没有的东西也会被拉回来）', async () => {
  await withCluster(async ({ A, B }) => {
    await A.app.services.notes.create({ title: 'A 的笔记' });
    await B.app.services.notes.create({ title: 'B 的笔记' });
    await A.app.services.sync.run({});
    const reportB = await B.app.services.sync.run({});
    assert.equal(reportB.pushed, 1);
    assert.equal(reportB.pulled, 1);
    const reportA = await A.app.services.sync.run({});
    assert.equal(reportA.pulled, 1, 'B 那条应该被 A 拉回来');
    assert.deepEqual(noteTitles(A), ['A 的笔记', 'B 的笔记']);
    assert.deepEqual(noteTitles(B), ['A 的笔记', 'B 的笔记']);
  });
});

/* ================================================================ 2) 冲突：两条都留 */

test('同步：两边改同一条（同 id 不同内容）→ 两条都在，renamed/conflicts/duplicates 都有记录', async () => {
  await withCluster(async ({ S, A, B }) => {
    const note = await A.app.services.notes.create({ title: '会被两边改的笔记', body: '原始内容' });
    await A.app.services.sync.run({});
    await B.app.services.sync.run({});
    assert.equal(B.app.store.notes.get(note.id).body, '原始内容');

    // 两边各改各的（"谁后写谁赢"一定会吞掉一方的那个场景）
    await A.app.services.notes.update(note.id, { body: 'A 改成这样' });
    await B.app.services.notes.update(note.id, { body: 'B 改成那样' });

    const reportA = await A.app.services.sync.run({});
    assert.equal(reportA.ok, true, JSON.stringify(reportA.error));
    assert.equal(reportA.updated, 1, 'A 是这条记录的"当前版本"，它自己的改动应当被就地采纳');

    const reportB = await B.app.services.sync.run({});
    assert.equal(reportB.ok, true, JSON.stringify(reportB.error));
    assert.ok(reportB.renamed >= 1, `冲突必须产生"重命名"（两条都留），实际 ${reportB.renamed}`);
    assert.ok(reportB.conflicts.length >= 1, '冲突清单里必须有记录');
    assert.ok(reportB.duplicates.length >= 1, '冲突分出来的副本应进"疑似重复"清单');
    const conflict = reportB.conflicts[0];
    assert.equal(conflict.collection, 'notes');
    assert.equal(conflict.id, note.id);
    assert.notEqual(conflict.variantId, note.id, '冲突副本必须换一个 id，否则两条没法共存');
    assert.equal(conflict.reason, 'same-id-different-content');
    assert.ok(conflict.origin?.name, '冲突要记 origin（哪台设备来的）');

    await A.app.services.sync.run({});
    assert.deepEqual(bodies(A), ['A 改成这样', 'B 改成那样'], 'A 上两条都在');
    assert.deepEqual(bodies(B), ['A 改成这样', 'B 改成那样'], 'B 上两条都在');
    assert.deepEqual(bodies(S), ['A 改成这样', 'B 改成那样'], '服务器上两条都在');
    assert.equal(A.app.store.notes.all().length, 2, '不该产生"同一份内容存两遍"的垃圾');
    assert.equal(B.app.store.notes.all().length, 2);
  });
});

test('同步：不同 id 但同名 → 两条都留 + 进「疑似重复」清单', async () => {
  await withCluster(async ({ A, B }) => {
    const mine = await A.app.services.notes.create({ title: '高等数学笔记', body: 'A 写的' });
    const theirs = await B.app.services.notes.create({ title: '高等数学笔记', body: 'B 写的' });

    const reportA = await A.app.services.sync.run({});
    assert.equal(reportA.ok, true, JSON.stringify(reportA.error));
    const reportB = await B.app.services.sync.run({});
    assert.equal(reportB.ok, true, JSON.stringify(reportB.error));
    // A 再跑一轮：B 那条推上去之后，A 才拉得到它（一次 run = 先推后拉）
    const reportA2 = await A.app.services.sync.run({});
    assert.equal(reportA2.ok, true, JSON.stringify(reportA2.error));

    assert.equal(A.app.store.notes.all().length, 2, 'A 上两条都在');
    assert.equal(B.app.store.notes.all().length, 2, 'B 上两条都在');
    assert.ok(A.app.store.notes.get(mine.id) && A.app.store.notes.get(theirs.id));
    assert.ok(B.app.store.notes.get(mine.id) && B.app.store.notes.get(theirs.id));

    const duplicates = [...reportA.duplicates, ...reportB.duplicates, ...reportA2.duplicates];
    assert.ok(duplicates.length >= 1, '至少要有一条"疑似重复"');
    assert.equal(duplicates[0].collection, 'notes');
    assert.equal(duplicates[0].reason, 'same-name-different-id');
    assert.equal(duplicates[0].title, '高等数学笔记');
    assert.ok([mine.id, theirs.id].includes(duplicates[0].id));
  });
});

/* ================================================================ 3) 幂等 */

test('同步：连跑两次幂等（第二次 pushed=0、skipped>0，条数完全不变）', async () => {
  await withCluster(async ({ S, A, B }) => {
    for (let index = 1; index <= 4; index += 1) await A.app.services.notes.create({ title: `笔记 ${index}`, body: `正文 ${index}` });

    const first = await A.app.services.sync.run({});
    assert.equal(first.pushed, 4);
    const serverCount = S.app.store.notes.all().length;

    const second = await A.app.services.sync.run({});
    assert.equal(second.pushed, 0, '第二次不该再"新增"任何东西');
    assert.ok(second.skipped > 0, '第二次应该全是"跳过"（按内容指纹判等）');
    assert.equal(second.renamed, 0);
    assert.equal(second.duplicates.length, 0, '幂等重放不该产生"疑似重复"');
    assert.equal(A.app.store.notes.all().length, 4, 'A 的条数不能变');
    assert.equal(S.app.store.notes.all().length, serverCount, '服务器的条数也不能变');

    const bFirst = await B.app.services.sync.run({});
    const bSecond = await B.app.services.sync.run({});
    assert.equal(bFirst.pulled, 4);
    assert.equal(bSecond.pulled, 0);
    assert.equal(B.app.store.notes.all().length, 4, 'B 的条数也不能变');
  });
});

/* ================================================================ 4) 删除同步 */

test('同步：笔记软删除会同步到另一侧（另一侧列表里消失、进回收站）', async () => {
  await withCluster(async ({ A, B }) => {
    const note = await A.app.services.notes.create({ title: '要删掉的笔记', body: 'x' });
    await A.app.services.sync.run({});
    await B.app.services.sync.run({});
    assert.equal(B.app.services.notes.all().length, 1, 'B 先看到它');

    await A.app.services.notes.remove(note.id); // 软删除：notes 模块自己的删除语义
    const reportA = await A.app.services.sync.run({});
    assert.equal(reportA.ok, true, JSON.stringify(reportA.error));

    const reportB = await B.app.services.sync.run({});
    assert.equal(reportB.ok, true, JSON.stringify(reportB.error));
    assert.equal(B.app.services.notes.all().length, 0, 'B 的列表里它应该消失了');
    const recycled = B.app.services.notes.all({ deleted: true });
    assert.equal(recycled.length, 1, 'B 的回收站里应该能看到它');
    assert.equal(recycled[0].id, note.id);
    assert.ok(recycled[0].deletedAt, 'deletedAt（软删除标记）必须跟着记录一起同步');
  });
});

test('同步：不支持删除同步的集合在报告里如实标注（不会被同步删掉，也不会假装删掉了）', async () => {
  await withCluster(async ({ A, B }) => {
    const todo = await A.app.services.todos.create({ title: '硬删除的待办', deadline: '2026-12-31' });
    await A.app.services.sync.run({});
    await B.app.services.sync.run({});
    assert.ok(B.app.store.todos.get(todo.id), 'B 先看到这条待办');

    await A.app.services.todos.remove(todo.id); // 待办没有回收站：硬删除，口径明确不传播
    const reportA = await A.app.services.sync.run({});
    assert.equal(reportA.deleteSync.todos, 'none', '报告里必须如实标注该集合不支持删除同步');
    assert.equal(reportA.deleteSync.notes, 'soft');
    const reportB = await B.app.services.sync.run({});
    assert.ok(B.app.store.todos.get(todo.id), '不支持删除同步 → B 上那条不会消失（如实行为，不是 bug）');
    assert.equal(reportB.deleteSync.todos, 'none');
  });
});

test('同步：显式 deleted 清单对软删除集合生效，对硬删除集合如实拒绝', async () => {
  await withCluster(async ({ A, B }) => {
    const keep = await A.app.services.notes.create({ title: '保留' });
    const drop = await A.app.services.notes.create({ title: '删掉' });
    const todo = await A.app.services.todos.create({ title: '待办', deadline: '2026-12-31' });
    await A.app.services.sync.run({});
    await B.app.services.sync.run({});
    assert.equal(B.app.store.notes.all().length, 2);

    // 手工造一份"墓碑清单"（桌面端自己不产生墓碑，但接口是冻结的：手机端可能有）
    const result = await B.app.services.sync.applyPush({
      deviceId: 'phone-1',
      deviceName: '手机',
      collections: {},
      deleted: { notes: [drop.id], todos: [todo.id] },
    });
    assert.equal(result.deleted, 1, 'notes 的显式删除应当执行（走 notes 模块自己的软删除入口）');
    assert.ok(!B.app.services.notes.all().some((item) => item.id === drop.id), '被删的笔记从（笔记服务的）列表消失');
    assert.ok(B.app.services.notes.all({ deleted: true }).some((item) => item.id === drop.id), '它进的是回收站');
    assert.ok(B.app.store.notes.get(keep.id), '另一条不受影响');
    assert.equal(result.unsupportedDeletes.length, 1, 'todos 的删除必须如实拒绝并说明原因');
    assert.equal(result.unsupportedDeletes[0].collection, 'todos');
    assert.match(result.unsupportedDeletes[0].reason, /不支持删除同步/);
    assert.ok(B.app.store.todos.get(todo.id), 'todos 那条还在（没有被悄悄删掉）');
  });
});

/* ================================================================ 5) 失败：本地零改动 */

test('同步：远端不可达 → 报告写原因，本地业务数据逐字节零改动', async () => {
  const server = await startNode('临时服务器');
  const client = await startNode('客户端');
  const deadPort = await freePort(); // 分配后立刻释放：这个端口上什么都没有
  try {
    await client.app.services.notes.create({ title: '本地笔记', body: '不该被碰' });
    await connect(client, `http://127.0.0.1:${deadPort}`);
    const before = await snapshotCollections(client.dataDir);

    const report = await client.app.services.sync.run({});
    assert.equal(report.ok, false);
    assert.equal(report.error.code, 'SERVER_UNREACHABLE');
    assert.match(report.error.message, /连不上这个服务器/);
    assert.equal(report.pushed, 0);
    assert.equal(report.pulled, 0);

    assert.deepEqual(await snapshotCollections(client.dataDir), before, '远端不可达时本地业务数据必须逐字节不变');
    const state = JSON.parse(await readFile(path.join(client.dataDir, STATE_FILE), 'utf8'));
    assert.equal(state.lastError.code, 'SERVER_UNREACHABLE', 'lastError 记在状态文件里（面板要显示）');
  } finally {
    await teardown([client, server]);
  }
});

test('同步：401（令牌过期）→ 报告提示重新登录，本地业务数据逐字节零改动', async () => {
  const fake = await startFakeSyncServer({ pushStatus: 401, pullStatus: 401 });
  const client = await startNode('客户端');
  try {
    await client.app.services.notes.create({ title: '本地笔记' });
    await connect(client, fake.url, 'expired-token');
    const before = await snapshotCollections(client.dataDir);

    const report = await client.app.services.sync.run({});
    assert.equal(report.ok, false);
    assert.equal(report.error.code, 'TOKEN_EXPIRED');
    assert.match(report.error.message, /重新登录/);
    assert.deepEqual(await snapshotCollections(client.dataDir), before, '401 时本地业务数据必须逐字节不变');
    assert.ok(!JSON.stringify(report).includes('expired-token'), '报告里不能出现会话令牌');
  } finally {
    await teardown([client]);
    await fake.close();
  }
});

test('同步：服务器返回畸形数据 → 先校验再合并，本地零改动', async () => {
  const fake = await startFakeSyncServer({
    pullBody: { ok: true, serverTime: new Date().toISOString(), collections: { notes: [{ title: '没有 id 的记录' }] } },
  });
  const client = await startNode('客户端');
  try {
    await client.app.services.notes.create({ title: '本地笔记' });
    await connect(client, fake.url);
    const before = await snapshotCollections(client.dataDir);

    const report = await client.app.services.sync.run({});
    assert.equal(report.ok, false);
    assert.equal(report.error.code, 'BAD_RESPONSE');
    assert.match(report.error.message, /缺 id/);
    assert.deepEqual(await snapshotCollections(client.dataDir), before, '畸形响应绝不能落盘');
  } finally {
    await teardown([client]);
    await fake.close();
  }
});

test('同步：没登录 / 没服务器地址 → 直接如实回报，一个请求都不发', async () => {
  const fake = await startFakeSyncServer();
  // ① 有地址但没登录：账号模块的默认地址指向假服务器，但本地没有任何登录态
  const solo = await startNode('没登录的设备', { account: { defaultServerUrl: fake.url } });
  // ② 连地址都没有（服务端版每用户实例就是这种情形）
  const off = await startNode('没有服务器地址的设备', { account: { defaultServerUrl: '' } });
  try {
    const noAccount = await solo.app.services.sync.run({});
    assert.equal(noAccount.skipped, true);
    assert.equal(noAccount.reason, 'no_account');
    assert.equal(noAccount.error.code, 'NOT_LOGGED_IN');

    // ② 连地址都没有（服务端版每用户实例就是这种情形）：本机自己同步自己没有意义
    const noServer = await off.app.services.sync.run({});
    assert.equal(noServer.skipped, true);
    assert.equal(noServer.reason, 'no_server');
    assert.equal(fake.requests.length, 0, '这两种情况下都不该发出任何请求');
  } finally {
    await teardown([solo, off]);
    await fake.close();
  }
});

/* ================================================================ 6) 同步范围 */

test('同步：push body 里只有同步范围内的集合 —— academic-* / lms-* / ai-usage 一个都不出现', async () => {
  const fake = await startFakeSyncServer();
  const client = await startNode('客户端');
  try {
    await connect(client, fake.url);
    // 造点"绝不参与同步"的数据：成绩、学堂课程/活动、用量账本
    await client.app.store.academicGrades.insert({ externalId: 'WID-1', course: '高等数学', score: 92, term: '2024-2025-1' });
    await client.app.store.lmsCourses.insert({ courseId: 'C-1', name: '材料力学' });
    await client.app.store.lmsActivities.insert({ activityId: 'A-1', title: '作业 1' });
    await client.app.store.aiUsage.insert({ date: '2026-10-14', kind: 'chat', calls: 3 });
    await client.app.services.notes.create({ title: '这条要同步' });

    const report = await client.app.services.sync.run({});
    assert.equal(report.ok, true, JSON.stringify(report.error));
    assert.equal(fake.pushes().length, 1, '数据量很小，应该只有一批');

    const raw = fake.pushes()[0].raw;
    for (const forbidden of ['academicGrades', 'academic-grades', 'lmsCourses', 'lms-courses', 'lmsActivities', 'lms-activities', 'aiUsage', 'ai-usage', 'ai-files', 'commandLogs', 'command-logs']) {
      assert.ok(!raw.includes(forbidden), `push body 里不该出现 ${forbidden}`);
    }
    assert.ok(!raw.includes('WID-1'), '成绩记录不能被推出去');
    assert.ok(!raw.includes('材料力学'), '学堂数据不能被推出去');
    assert.ok(raw.includes('这条要同步'), '笔记必须在 push body 里');
    assert.ok(!raw.includes('ai-config'), 'ai-config 默认不同步');
    assert.ok(!raw.includes('lms-credentials'), '学堂凭据默认不同步');
    assert.ok(!raw.includes('auth-session.json'));
    assert.ok(!raw.includes('account.json'), '账号文件（含令牌）永远不参与同步');
    assert.ok(!raw.includes(TOKEN), '令牌绝不出现在 push body 里（它只在 Authorization 头）');
  } finally {
    await teardown([client]);
    await fake.close();
  }
});

test('同步：AI 配置（含 key）默认不同步；勾上之后才进 push，另一侧勾上后才收下', async () => {
  await withCluster(async ({ S, A, B }) => {
    await A.app.services.ai.updateConfig({ apiKey: 'sk-local-abcdef', model: 'deepseek-v4-pro' });

    // ① 默认关闭：服务器上不会出现 AI 配置
    const off = await A.app.services.sync.run({});
    assert.equal(off.ok, true, JSON.stringify(off.error));
    assert.equal(S.app.services.ai.config.get().apiKey ?? '', '', '默认不同步 → 服务器上不该有 key');

    // ② A 打开开关（走真实 HTTP 路由）
    const response = await fetch(`${A.url}/api/v1/sync/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ syncSecrets: { aiConfig: true }, hostname: '127.0.0.1' }),
    });
    const saved = await response.json();
    assert.equal(response.status, 200);
    assert.equal(saved.syncSecrets.aiConfig, true);
    assert.equal(saved.syncSecrets.lms, false, '改一项不该动另一项');

    const on = await A.app.services.sync.run({});
    assert.equal(on.ok, true, JSON.stringify(on.error));
    assert.equal(S.app.services.ai.config.get().apiKey, 'sk-local-abcdef', '勾上之后 key 才会存在服务器上');

    // ③ B 没勾：拉到了也不许写进本机
    const bOff = await B.app.services.sync.run({});
    assert.equal(bOff.ok, true, JSON.stringify(bOff.error));
    assert.deepEqual(bOff.skippedSecrets, ['ai-config'], '报告要如实写出跳过了什么');
    assert.equal(B.app.services.ai.config.get().apiKey ?? '', '', '没勾的设备不许被写入 key');
    assert.equal(await stat(path.join(B.dataDir, 'ai-config.json')).then(() => true, () => false), false, '配置文件都不该被创建');

    // ④ B 勾上：key 才会跟过来
    await B.app.services.sync.updateSettings({ syncSecrets: { aiConfig: true }, hostname: '10.0.0.9' });
    const bOn = await B.app.services.sync.run({});
    assert.equal(bOn.ok, true, JSON.stringify(bOn.error));
    assert.deepEqual(bOn.skippedSecrets, []);
    assert.equal(B.app.services.ai.config.get().apiKey, 'sk-local-abcdef');
    assert.equal(B.app.services.ai.config.get().model, 'deepseek-v4-pro');
    const info = await stat(path.join(B.dataDir, 'ai-config.json'));
    // Windows 的 stat().mode 只反映只读位：0600 与 0666 都是 0o666（README「已知限制」）
    if (process.platform !== 'win32') {
          assert.equal(info.mode & 0o777, 0o600, '密钥文件必须 0600');
    }
  });
});

test('同步：只勾 lms 时不带 ai-config；勾上 lms 后学堂凭据才进 push', async () => {
  const fake = await startFakeSyncServer();
  const client = await startNode('客户端');
  try {
    await connect(client, fake.url);
    await client.app.services.ai.updateConfig({ apiKey: 'sk-should-not-travel' });
    await seedLmsSession(client, 'tgc-secret-value');

    await client.app.services.sync.updateSettings({ syncSecrets: { lms: true }, hostname: '192.168.1.20' });
    const report = await client.app.services.sync.run({});
    assert.equal(report.ok, true, JSON.stringify(report.error));
    const raw = fake.pushes().at(-1).raw;
    assert.ok(!raw.includes('ai-config'), '只勾了 lms，ai-config 不该出现');
    assert.ok(!raw.includes('sk-should-not-travel'), 'AI key 不该出现');
    assert.ok(raw.includes('lms-credentials'), '勾了 lms，凭据必须在');
    assert.ok(raw.includes('tgc-secret-value'), '凭据内容必须跟着走（这就是这个开关的作用）');
  } finally {
    await teardown([client]);
    await fake.close();
  }
});

test('同步：没勾开关的设备，即使服务器上有敏感数据也不落本机（逐字节不变）+ 报告 skippedSecrets', async () => {
  const fake = await startFakeSyncServer({
    pullBody: {
      ok: true,
      serverTime: new Date().toISOString(),
      nextSince: new Date().toISOString(),
      serverDeviceId: 'fake-server-device',
      collections: {
        'ai-config': [{ id: 'ai-config', apiKey: 'sk-remote-9999', model: 'deepseek-v4-pro', __fileExists: true }],
        'lms-credentials': [{ id: 'lms-credentials', savedAt: new Date().toISOString(), cookies: [{ name: 'TGC', value: 'remote-tgc', domain: 'login.xjtu.edu.cn', path: '/' }] }],
      },
    },
  });
  const client = await startNode('客户端');
  try {
    await connect(client, fake.url);
    const before = await snapshotCollections(client.dataDir);
    const hadConfig = await stat(path.join(client.dataDir, 'ai-config.json')).then(() => true, () => false);

    const report = await client.app.services.sync.run({});
    assert.equal(report.ok, true, JSON.stringify(report.error));
    assert.deepEqual([...report.skippedSecrets].sort(), ['ai-config', 'lms-credentials'], '报告必须如实写出跳过了哪些敏感集合');
    assert.equal(client.app.services.ai.config.get().apiKey ?? '', '', '本机密钥必须还是空的');
    assert.deepEqual(await snapshotCollections(client.dataDir), before, '本地业务数据逐字节不变');
    assert.equal(await stat(path.join(client.dataDir, 'ai-config.json')).then(() => true, () => false), hadConfig, 'ai-config.json 的"有/无"都不该变');
    assert.equal(await stat(path.join(client.dataDir, 'auth-session.json')).then(() => true, () => false), false, '凭据文件不该被创建');
  } finally {
    await teardown([client]);
    await fake.close();
  }
});

test('同步：网页版不许打开敏感开关（403），未知环境按原生处理并如实标注', async () => {
  const client = await startNode('客户端');
  try {
    const web = await client.app.services.sync
      .updateSettings({ syncSecrets: { aiConfig: true }, hostname: 'study.example.com', authConfigReachable: true })
      .then(() => null, (error) => error);
    assert.ok(web, '网页版必须被拒绝');
    assert.equal(web.status, 403);
    assert.equal(web.code, 'SECRETS_NOT_ALLOWED_HERE');
    assert.match(web.message, /网页版不提供敏感数据同步/);
    assert.equal(client.app.services.sync.settings({ hostname: 'study.example.com', authConfigReachable: true }).syncSecrets.aiConfig, false, '被拒绝之后开关仍是 false');

    // 拿不到探测结果（unknown）：按原生处理，允许开，但结论如实标成 unknown
    const unknown = await client.app.services.sync.settings({ hostname: 'study.example.com', authConfigReachable: null });
    assert.equal(unknown.runtime.kind, 'unknown');
    assert.equal(unknown.canSyncSecrets, true);
  } finally {
    await teardown([client]);
  }
});

/* ================================================================ 7) 设备身份 / 状态文件 */

test('同步：data/sync-state.json 权限 0600，deviceId 稳定、deviceName 默认取主机名', async () => {
  const node = await startNode('设备名给定');
  const fresh = await startNode('');
  try {
    const file = path.join(node.dataDir, STATE_FILE);
    const info = await stat(file);
    // Windows 的 stat().mode 只反映只读位：0600 与 0666 都是 0o666（README「已知限制」）
    if (process.platform !== 'win32') {
          assert.equal(info.mode & 0o777, 0o600, '设备身份与开关是私有文件（0600）');
    }

    const first = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(first.deviceId, '必须有 deviceId');
    assert.deepEqual(first.syncSecrets, { aiConfig: false, lms: false }, '两项默认都是 false');
    assert.equal(first.deviceName, '设备名给定');

    const second = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(second.deviceId, first.deviceId, 'deviceId 必须稳定（第二次读取不变）');

    // 重启一次（同一个数据目录）：deviceId 还是它
    const restarted = await startNode('重启后的设备', { dataDir: node.dataDir });
    try {
      assert.equal(restarted.app.services.sync.state.deviceId, first.deviceId, '重启后 deviceId 不变');
      assert.equal(JSON.parse(await readFile(file, 'utf8')).deviceId, first.deviceId);
    } finally {
      await restarted.app.close();
    }

    // 没有显式设备名时用 os.hostname()，绝不空着
    assert.ok(fresh.app.services.sync.state.deviceName.length > 0);
    const ledger = await stat(path.join(node.dataDir, 'sync-ledger.json'));
    // Windows 的 stat().mode 只反映只读位：0600 与 0666 都是 0o666（README「已知限制」）
    if (process.platform !== 'win32') {
          assert.equal(ledger.mode & 0o777, 0o600, '幂等账本同样是私有文件（0600）');
    }
  } finally {
    await teardown([node, fresh]);
  }
});

/* ================================================================ 8) 路由契约 */

test('同步：GET /sync/status 返回冻结字段，且不含令牌', async () => {
  const node = await startNode('设备');
  const server = await startNode('服务器');
  try {
    await node.app.services.notes.create({ title: '一条笔记' });
    await connect(node, server.url);
    const response = await fetch(`${node.url}/api/v1/sync/status?hostname=127.0.0.1&authConfig=0`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.ok(body.deviceId);
    assert.equal(body.deviceName, '设备');
    assert.equal(body.lastPullAt, null);
    assert.equal(body.lastPushAt, null);
    assert.equal(body.lastError, null);
    assert.equal(body.collections.notes.count, 1);
    assert.ok(body.collections.notes.maxUpdatedAt, '要有 maxUpdatedAt');
    assert.equal(body.runtime.kind, 'native');
    assert.ok(!JSON.stringify(body).includes(TOKEN), 'status 里不能出现令牌');

    const settings = await (await fetch(`${node.url}/api/v1/sync/settings?hostname=127.0.0.1`)).json();
    assert.deepEqual(settings.syncSecrets, { aiConfig: false, lms: false });
    assert.equal(settings.deviceId, body.deviceId);
  } finally {
    await teardown([node, server]);
  }
});

test('同步：push/pull 契约字段齐全（手机端照这两个接口写就够了）', async () => {
  const node = await startNode('设备');
  try {
    await node.app.services.notes.create({ title: '契约笔记' });
    // 手机端第一条：服务器上还没有这个 id → 新增
    const pushBody = {
      deviceId: 'phone-9',
      deviceName: '手机',
      collections: { notes: [{ id: 'phone-note-1', title: '手机上写的', body: '正文', tags: [] }] },
      deleted: {},
    };
    const pushOnce = () =>
      fetch(`${node.url}/api/v1/sync/push`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pushBody) }).then((response) => response.json());
    const push = await pushOnce();
    assert.equal(push.accepted, 1);
    // 同一条再推一次：幂等（accepted=0 / skipped=1）
    const replay = await pushOnce();
    assert.equal(replay.accepted, 0);
    assert.equal(replay.skipped, 1);
    assert.equal(node.app.store.notes.all().length, 2, '重放不该多出一条');
    for (const key of ['accepted', 'skipped', 'renamed', 'groups', 'duplicates', 'conflicts', 'serverTime']) {
      assert.ok(key in push, `push 响应必须有 ${key}`);
    }

    const pull = await (
      await fetch(`${node.url}/api/v1/sync/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'phone-9', since: null }),
      })
    ).json();
    for (const key of ['serverTime', 'collections', 'deleted']) assert.ok(key in pull, `pull 响应必须有 ${key}`);
    assert.equal(pull.collections.notes.length, 2, '本机原有 1 条 + 手机推上来 1 条');
    assert.deepEqual(pull.deleted, {});

    // 增量：since 取刚才的 nextSince，之后的没有新记录就不该再回一遍
    const empty = await (
      await fetch(`${node.url}/api/v1/sync/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'phone-9', since: pull.nextSince }),
      })
    ).json();
    assert.equal((empty.collections.notes ?? []).length, 0, 'since 之后没有新记录时不该再回一遍');
  } finally {
    await teardown([node]);
  }
});

test('同步：run 的报告字段齐全（面板就照这个显示），且不含令牌', async () => {
  const fake = await startFakeSyncServer();
  const client = await startNode('客户端');
  try {
    await connect(client, fake.url);
    const report = await client.app.services.sync.run({ hostname: '127.0.0.1' });
    for (const key of ['pushed', 'pulled', 'skipped', 'renamed', 'duplicates', 'conflicts', 'durationMs', 'at']) {
      assert.ok(key in report, `run 报告必须有 ${key}`);
    }
    assert.equal(typeof report.durationMs, 'number');
    assert.ok(!Number.isNaN(Date.parse(report.at)));
    assert.equal(report.runtime.kind, 'native');
    assert.ok(!JSON.stringify(report).includes(TOKEN), '报告里不能出现会话令牌');
  } finally {
    await teardown([client]);
    await fake.close();
  }
});

/* ================================================================ 9) 启动自动同步 */

test('同步：启动后自动同步一次（后台跑、失败静默），数据会出现在服务器上', async () => {
  const S = await startNode('服务器 S');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-sync-auto-'));
  let node = null;
  try {
    // 先用同一个数据目录起一次（不自动同步）：写账号 + 建一条笔记，模拟"上次用过的设备"
    const seed = await startNode('种子', { dataDir });
    await connect(seed, S.url);
    await seed.app.services.notes.create({ title: '启动前的笔记' });
    await seed.app.close();

    node = await startNode('自动同步的设备', { dataDir, sync: { autoRun: true } });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && S.app.store.notes.all().length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(S.app.store.notes.all().length, 1, '启动后应当自动同步一次（数据出现在服务器上）');
    assert.ok(node.app.services.sync.state.lastPushAt, '自动同步成功后要记 lastPushAt');
  } finally {
    await teardown([...(node ? [node] : []), S]);
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('同步：没登录时启动自动同步是静默的（不抛错、不写 lastError）', async () => {
  const node = await startNode('没登录的设备', { sync: { autoRun: true } });
  try {
    await node.app.services.sync.start();
    const state = JSON.parse(await readFile(path.join(node.dataDir, STATE_FILE), 'utf8'));
    assert.equal(state.lastError, null, '没登录不算错误，不该写 lastError');
    assert.equal(state.lastPushAt, null);
  } finally {
    await teardown([node]);
  }
});
