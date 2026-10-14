/**
 * 服务端版：**宿主与代理**的集成测试。
 *
 * 要证明的四件事（每件都必须真起宿主、真走 HTTP/WebSocket）：
 *   1. 未登录**什么都不给**：`/api/**`、`/ws` 一律 401，`/app/**` 回登录页；
 *      登录页上该讲的都讲了（"邀请码"、"思源学堂为什么不可用"）；
 *   2. 登录后 `/api/v1/health` 200 —— 这证明代理**真的通到该账号自己的后端实例**，
 *      而不是宿主自己编了一个 200；
 *   3. **A 用户看不到 B 用户的数据**：两人各写一条笔记，各自只见自己那条
 *      （HTTP 与 WebSocket 两条路径都要成立：广播也不能串台）；
 *   4. 服务端版**禁用**的东西是真禁用：LMS 有明确的 403 与原因，`transfer` 模块不加载，
 *      静态托管的路径穿越被挡在门外。
 *
 * 端口全随机、数据目录一律临时目录：开发机上 8866 与 `app/data-www` 都可能是真环境。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { register, rawUpgrade, startWww } from './helpers/www-client.js';
import { connectWs } from './helpers/ws-client.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 造一条笔记（走代理 → 落到该账号自己的数据目录）。 */
const createNote = (app, cookie, title) =>
  app.call('/api/v1/notes', { method: 'POST', headers: { cookie }, body: { title, body: `${title} 的正文` } });

const listNotes = async (app, cookie) => {
  const res = await app.call('/api/v1/notes', { headers: { cookie } });
  return res.json?.items ?? [];
};

test('服务端版：未登录时 /api/** 401、/ws 401、/app/** 回登录页，登录页讲清"邀请码"与禁用的能力', async () => {
  const app = await startWww();
  try {
    // 1) 接口：401 且是 JSON（不是重定向、也不是空 200）
    for (const path of ['/api/v1/health', '/api/v1/notes', '/api/v1/schedules', '/api/v1/modules']) {
      const res = await app.call(path);
      assert.equal(res.status, 401, `${path} 未登录必须 401`);
      assert.equal(res.json.error.code, 'UNAUTHORIZED');
    }

    // 2) WebSocket 升级：401（手写握手，看得到状态码）；普通 GET /ws 也回 401 + 可读 JSON
    const upgrade = await rawUpgrade(app.port, '/ws');
    assert.equal(upgrade.status, 401);
    const wsHttp = await app.call('/ws');
    assert.equal(wsHttp.status, 401);
    assert.equal(wsHttp.json.error.code, 'UNAUTHORIZED');

    // 3) 页面：未登录给的是**公开介绍/登录页**，不是应用外壳
    const home = await app.call('/');
    assert.equal(home.status, 200);
    assert.match(home.headers['content-type'], /text\/html/);
    assert.match(home.text, /AI 智学/);
    assert.match(home.text, /邀请码/, '登录页必须说清楚"注册要邀请码"');
    assert.match(home.text, /思源学堂/, '登录页必须写清楚 LMS 为什么在服务端版不可用');
    assert.equal(home.text.includes('chat-log'), false, '未登录的页面不能是应用外壳');
    // CSP 友好：没有内联脚本与内联样式
    assert.equal(/<script(?![^>]*\ssrc=)/i.test(home.text), false, '页面里不能有内联脚本');
    assert.equal(/<style/i.test(home.text), false, '页面里不能有内联样式');
    assert.match(String(home.headers['content-security-policy']), /default-src 'none'/);

    // 4) 应用页面：未登录 → 302 回登录页，绝不吐渲染层
    const appPage = await app.call('/app/');
    assert.equal(appPage.status, 302);
    assert.equal(appPage.headers.location, '/');
    const asset = await app.call('/app/kit/theme.js');
    assert.equal(asset.status, 302);

    // 5) 未知路径 → 404 JSON
    const nowhere = await app.call('/nope');
    assert.equal(nowhere.status, 404);
  } finally {
    await app.close();
  }
});

test('服务端版：登录后 /api/v1/health 200 —— 代理确实通到该账号自己的后端实例', async () => {
  const app = await startWww();
  try {
    const alice = await register(app, { username: 'alice' });
    const health = await app.call('/api/v1/health', { headers: { cookie: alice.cookie } });
    assert.equal(health.status, 200);
    assert.equal(health.json.status, 'ok');
    assert.equal(typeof health.json.counts, 'object', '这是该实例自己的数据统计');
    assert.equal(health.json.websocket.path, '/ws');

    // 会话令牌直接当 Bearer 用也能走代理（手机客户端不必处理 Cookie）
    const viaBearer = await app.call('/api/v1/health', { headers: { authorization: `Bearer ${alice.token}` } });
    assert.equal(viaBearer.status, 200);

    // 后端实例只监听 127.0.0.1 的随机端口，且端口不是宿主的端口
    const instances = app.www.backends.status();
    assert.equal(instances.length, 1);
    assert.notEqual(instances[0].port, app.port);
    assert.equal(instances[0].userId, alice.user.id);
  } finally {
    await app.close();
  }
});

test('服务端版：A 用户看不到 B 用户的数据（HTTP 侧，两个账号 = 两个数据目录）', async () => {
  const app = await startWww();
  try {
    const alice = await register(app, { username: 'alice' });
    const invite = await app.call('/auth/invites', { method: 'POST', headers: { cookie: alice.cookie } });
    const bob = await register(app, { username: 'bob', inviteCode: invite.json.invite.code });
    assert.equal(bob.status, 201);

    const aliceNote = await createNote(app, alice.cookie, 'Alice 的笔记');
    assert.equal(aliceNote.status, 201);
    const bobNote = await createNote(app, bob.cookie, 'Bob 的笔记');
    assert.equal(bobNote.status, 201);

    const aliceSees = await listNotes(app, alice.cookie);
    const bobSees = await listNotes(app, bob.cookie);
    assert.equal(aliceSees.length, 1, `Alice 应当只看到自己那条，实际 ${aliceSees.length} 条`);
    assert.equal(bobSees.length, 1, `Bob 应当只看到自己那条，实际 ${bobSees.length} 条`);
    assert.equal(aliceSees[0].title, 'Alice 的笔记');
    assert.equal(bobSees[0].title, 'Bob 的笔记');
    assert.notEqual(aliceSees[0].id, bobSees[0].id);

    // 连 id 也跨不过去：拿对方的 id 直接读 → 404
    const cross = await app.call(`/api/v1/notes/${bobSees[0].id}`, { headers: { cookie: alice.cookie } });
    assert.equal(cross.status, 404);

    // 两个实例、两个数据目录
    const instances = app.www.backends.status();
    assert.equal(instances.length, 2);
    assert.notEqual(instances[0].port, instances[1].port);

    // alice 的删除只影响 alice 自己
    await app.call(`/api/v1/notes/${aliceSees[0].id}`, { method: 'DELETE', headers: { cookie: alice.cookie } });
    assert.equal((await listNotes(app, alice.cookie)).length, 0);
    assert.equal((await listNotes(app, bob.cookie)).length, 1, 'Alice 的操作绝不能动到 Bob 的数据');
  } finally {
    await app.close();
  }
});

test('服务端版：登录后 /app/ 是应用页面，静态资源按登录态放行', async () => {
  const app = await startWww();
  try {
    const alice = await register(app, { username: 'alice' });
    const page = await app.call('/app/', { headers: { cookie: alice.cookie } });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.text, /id="chat-log"/, '登录后拿到的应当是渲染层应用页面');
    // 渲染层的 CSP 在页面自己的 meta 里（宿主不改渲染层的任何字节）
    assert.match(page.text, /Content-Security-Policy/);

    const asset = await app.call('/app/kit/theme.js', { headers: { cookie: alice.cookie } });
    assert.equal(asset.status, 200);
    assert.match(asset.headers['content-type'], /javascript/);

    // 裸 /app 必须 302 到 /app/：页面里的资源是相对路径，少了结尾斜杠会全部 404
    const bare = await app.call('/app', { headers: { cookie: alice.cookie } });
    assert.equal(bare.status, 302);
    assert.equal(bare.headers.location, '/app/');

    // 已登录时访问 / → 进应用页面
    const home = await app.call('/', { headers: { cookie: alice.cookie } });
    assert.equal(home.status, 302);
    assert.equal(home.headers.location, '/app/');

    // 登录页自己的资源是公开的（否则未登录的人看不到表单样式）
    for (const path of ['/login/login.css', '/login/login.js', '/login/index.html']) {
      const res = await app.call(path);
      assert.equal(res.status, 200, `${path} 应当公开可读`);
    }
  } finally {
    await app.close();
  }
});

test('服务端版：路径穿越被挡住（编码过的 .. 也一样）', async () => {
  const app = await startWww();
  try {
    const alice = await register(app, { username: 'alice' });
    const attacks = [
      '/app/..%2f..%2fpackage.json',
      '/app/%2e%2e%2fpackage.json',
      '/app/..%2f..%2f..%2fetc%2fpasswd',
      '/login/..%2f..%2fpackage.json',
      '/app/..%2fdata-www%2fusers.json',
    ];
    for (const path of attacks) {
      const res = await app.call(path, { headers: { cookie: alice.cookie } });
      assert.ok(res.status === 400 || res.status === 404, `${path} 不该被放行，实际 ${res.status}`);
      assert.equal(res.text.includes('"name": "xjtu-study-assistant"'), false);
    }
    // 直接读账号库更是不行（这个文件在 data-www，不在任何托管根目录里）
    const users = await app.call('/users.json');
    assert.equal(users.status, 404);
  } finally {
    await app.close();
  }
});

test('服务端版：思源学堂（LMS）明确禁用 —— 403 + 原因，且模块根本没被加载', async () => {
  const app = await startWww();
  try {
    const alice = await register(app, { username: 'alice' });

    for (const path of ['/api/v1/lms/status', '/api/v1/lms/courses', '/api/v1/lms/sync/apply']) {
      const res = await app.call(path, { method: path.endsWith('apply') ? 'POST' : 'GET', headers: { cookie: alice.cookie }, body: {} });
      assert.equal(res.status, 403, `${path} 在服务端版必须不可用`);
      assert.equal(res.json.error.code, 'LMS_DISABLED');
      assert.match(res.json.error.message, /思源学堂/);
      assert.match(res.json.error.message, /本地客户端/, '必须给出原因与替代方案，而不是一句"不支持"');
    }

    // 未登录时仍然先回 401（不泄露"这台服务器禁用了什么"之外的任何东西）
    const anon = await app.call('/api/v1/lms/status');
    assert.equal(anon.status, 401);

    // 模块表里没有 lms，也没有 transfer（服务端版不起 8886、不做局域网直传）
    const modules = await app.call('/api/v1/modules', { headers: { cookie: alice.cookie } });
    assert.equal(modules.status, 200);
    const ids = modules.json.items.map((item) => item.id);
    assert.equal(ids.includes('lms'), false, `服务端版不该加载 lms，实际模块：${ids.join('、')}`);
    assert.equal(ids.includes('transfer'), false, `服务端版不该加载 transfer，实际模块：${ids.join('、')}`);
    // 其它模块照常可用（证明只砍了这两块，没有把服务端版砍成空壳）
    for (const id of ['calendar', 'notes', 'cards', 'goals', 'ai']) {
      assert.ok(ids.includes(id), `模块 ${id} 应当仍然可用`);
    }
  } finally {
    await app.close();
  }
});

test('服务端版：WebSocket 代理真的接到了该账号的后端（ready + data_changed，且与另一个账号隔离）', async () => {
  const app = await startWww();
  const clients = [];
  try {
    const alice = await register(app, { username: 'alice' });
    const invite = await app.call('/auth/invites', { method: 'POST', headers: { cookie: alice.cookie } });
    const bob = await register(app, { username: 'bob', inviteCode: invite.json.invite.code });

    // 浏览器路径是 Cookie，原生客户端更方便用查询串（宿主只在 /ws 上认 ?token=）
    const aliceWs = await connectWs({ port: app.port, path: `/ws?token=${alice.token}` });
    clients.push(aliceWs);
    assert.equal(aliceWs.messages[0].type, 'ready');

    const bobWs = await connectWs({ port: app.port, path: `/ws?token=${bob.token}` });
    clients.push(bobWs);
    assert.equal(bobWs.messages[0].type, 'ready');

    // 带错令牌的升级必须被拒（不能把匿名连接放进某个人的后端）
    const denied = await rawUpgrade(app.port, '/ws?token=deadbeef');
    assert.equal(denied.status, 401);

    // Alice 写一条日程 → 她的后端广播 data_changed → 经代理送到她的连接上
    const created = await app.call('/api/v1/schedules', {
      method: 'POST',
      headers: { cookie: alice.cookie },
      body: { title: '线性代数', date: '2026-10-20', startTime: '08:00', endTime: '09:40' },
    });
    assert.equal(created.status, 201, created.text);
    const changed = await aliceWs.waitFor((message) => message.type === 'data_changed', 5000);
    assert.equal(changed.payload.target, 'schedule');

    // Bob 的连接上**不能**收到 Alice 的广播（两个后端实例各有各的推送通道）
    await sleep(400);
    assert.equal(
      bobWs.messages.some((message) => message.type === 'data_changed'),
      false,
      `Bob 不该收到 Alice 的广播，实际收到：${JSON.stringify(bobWs.messages)}`,
    );

    // 推送通道是双向的：ping → pong 也要能过代理
    aliceWs.send({ type: 'ping' });
    const pong = await aliceWs.waitFor((message) => message.type === 'pong', 5000);
    assert.ok(pong.payload.ts > 0);
  } finally {
    for (const client of clients) client.close();
    await app.close();
  }
});

test('服务端版：后端实例懒启动 + 复用 + 空闲可回收（回收后再访问会重新拉起）', async () => {
  // idleMs 给 3 秒：既能让"复用"那几步（毫秒级）稳过，又不用在测试里等半分钟
  const app = await startWww({ idleMs: 3000 });
  try {
    const alice = await register(app, { username: 'alice' });
    assert.equal(app.www.backends.status().length, 0, '注册本身不该顺手拉起后端实例（懒启动）');

    await app.call('/api/v1/health', { headers: { cookie: alice.cookie } });
    const firstPort = app.www.backends.status()[0].port;
    for (let i = 0; i < 3; i += 1) await app.call('/api/v1/health', { headers: { cookie: alice.cookie } });
    const instances = app.www.backends.status();
    assert.equal(instances.length, 1, '同一个账号复用同一台实例');
    assert.equal(instances[0].port, firstPort, '复用期间端口不变');

    // 并发的第一批请求只能建出一台（建两台会让同一份数据文件被两个进程同时写）
    const fresh = await startWww({ idleMs: 0 });
    try {
      const carol = await register(fresh, { username: 'carol' });
      await Promise.all(Array.from({ length: 8 }, () => fresh.call('/api/v1/health', { headers: { cookie: carol.cookie } })));
      assert.equal(fresh.www.backends.status().length, 1);
    } finally {
      await fresh.close();
    }

    // 空闲回收：等过阈值后实例应当被关掉（后台回收器或这里的显式 reap 都算数）
    await sleep(3200);
    await app.www.backends.reap();
    assert.equal(app.www.backends.status().length, 0, '空闲超过阈值的实例应当被回收');

    const again = await app.call('/api/v1/health', { headers: { cookie: alice.cookie } });
    assert.equal(again.status, 200, '回收之后再访问必须还能用（否则"回收"就等于"弄坏"）');
    assert.equal(app.www.backends.status().length, 1);
  } finally {
    await app.close();
  }
});

test('服务端版：宿主自己的凭据头不会透传给用户后端（X-Potato-Token / Cookie / Authorization）', async () => {
  const app = await startWww();
  try {
    const alice = await register(app, { username: 'alice' });
    // 正常请求能过（说明凭据在宿主层就被认掉了，不需要下游配合）
    const health = await app.call('/api/v1/health', {
      headers: { cookie: alice.cookie, 'X-Potato-Token': alice.token, authorization: `Bearer ${alice.token}` },
    });
    assert.equal(health.status, 200);

    // 反过来：只带一个假的下游令牌、不带宿主会话 → 401（下游不认这个头，宿主也不放行）
    const fake = await app.call('/api/v1/health', { headers: { 'X-Potato-Token': 'deadbeef' } });
    assert.equal(fake.status, 401);
  } finally {
    await app.close();
  }
});
