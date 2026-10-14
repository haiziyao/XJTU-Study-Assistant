/**
 * 「设置 → 账号登录」模块的测试。
 *
 * **零真实外网**：全部上游请求打到本文件里用 `node:http` 起的**假 auth 服务器**，
 * 它复刻 server 分支 `src/www/server.js` 的 `/auth/**` 契约（状态码、错误码、
 * `Set-Cookie: potato_session=…; HttpOnly; SameSite=Lax; Max-Age=2592000`），
 * 也复刻它"**不发 CORS 头**"这一点 —— 正因如此桌面端才必须走后端桥。
 *
 * 覆盖的关键点（每条都对应一个容易出错的假设）：
 *   - 令牌是 `HttpOnly` Cookie，**不在响应体里** —— 桥必须从 Set-Cookie 里取；
 *   - `GET /account` 绝不回传 token（用 JSON.stringify 断言不含明文）；
 *   - `data/account.json` 权限必须是 0600（凭据文件）；
 *   - 上游错误码 -> 中文人话（401/403/409/429/连不上）；
 *   - 服务器不可达时 `probe` 是 `reachable:false` 而不是 500；
 *   - 退出登录在服务器不可达时也要清掉本地文件。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { AccountService, ERROR_MESSAGES, SESSION_COOKIE, UNREACHABLE_MESSAGE } from '../src/modules/account/service.js';
import { bootRenderer } from './helpers/renderer-dom.js';

/** 假 auth 服务器认的令牌（写在 Set-Cookie 里，用来断言它没有泄漏到页面上）。 */
const TOKEN = 'tok_5f3a91c2d4e607b8a1c3';

/** 一个假账号库：`username -> {password, role, id}`。 */
const ACCOUNTS = {
  alice: { id: 'u-alice', password: 'correct-horse-battery', role: 'admin' },
  bob: { id: 'u-bob', password: 'hunter2hunter2', role: 'member' },
};
/** 一次性邀请码：用过就从集合里删掉，复刻服务端的语义。 */
const INVITES = new Set(['INVITE-OK-1']);

/**
 * 起一个假 auth 服务器。
 *
 * @param {object} [options]
 * @param {boolean} [options.cors] 是否发 CORS 头（默认 **不发**，与真实服务端版一致）
 * @param {boolean} [options.tokenInBody] 把令牌同时放进响应体（真实服务端**不这么做**，
 *   用来验证桥的兼容分支；默认 false 才符合契约）
 * @param {number}  [options.rateLimitAfter] 密码连错几次后开始 429（默认 5，与契约一致）
 */
async function startFakeAuth({ cors = false, tokenInBody = false, rateLimitAfter = 5 } = {}) {
  const state = { requests: [], badPasswordCount: 0 };
  const accounts = new Map(Object.entries(ACCOUNTS).map(([name, info]) => [name, { ...info }]));
  const invites = new Set(INVITES);

  const send = (res, status, payload, headers = {}) => {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      ...(cors ? { 'Access-Control-Allow-Origin': '*' } : {}),
      ...headers,
    });
    res.end(body);
  };

  const fail = (res, status, code, message) => send(res, status, { ok: false, error: { code, message } });

  /** 契约里的会话 Cookie：HttpOnly + SameSite=Lax + Max-Age=2592000（30 天）。 */
  const sessionCookie = `${SESSION_COOKIE}=${TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        return fail(res, 400, 'BAD_REQUEST', '请求体不是合法 JSON');
      }
    }
    state.requests.push({ method: req.method, url: req.url, headers: req.headers, body });

    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/auth/config') {
      return send(res, 200, {
        serverName: '智学公开服务端',
        version: '0.3.0',
        registration: 'invite',
        firstUserBecomesAdmin: true,
        features: { lms: false },
      });
    }

    if (req.method === 'POST' && url.pathname === '/auth/login') {
      if (state.badPasswordCount >= rateLimitAfter) {
        return fail(res, 429, 'RATE_LIMITED', '密码连续错误 5 次，已锁定 60 秒');
      }
      const account = accounts.get(String(body.username ?? '').trim());
      if (!account || account.password !== body.password) {
        state.badPasswordCount += 1;
        return fail(res, 401, 'BAD_CREDENTIALS', '用户名或密码不对');
      }
      state.badPasswordCount = 0;
      const user = { id: account.id, username: String(body.username).trim(), role: account.role };
      return send(res, 200, { ok: true, user, ...(tokenInBody ? { token: TOKEN } : {}) }, { 'Set-Cookie': sessionCookie });
    }

    if (req.method === 'POST' && url.pathname === '/auth/register') {
      const username = String(body.username ?? '').trim();
      const code = String(body.inviteCode ?? '').trim();
      if (accounts.has(username)) return fail(res, 409, 'USER_EXISTS', `用户名「${username}」已被占用`);
      if (!invites.has(code)) return fail(res, 403, 'INVITE_INVALID', '邀请码无效');
      invites.delete(code);
      accounts.set(username, { id: `u-${username}`, password: body.password, role: 'member' });
      const user = { id: `u-${username}`, username, role: 'member' };
      return send(res, 201, { ok: true, user, ...(tokenInBody ? { token: TOKEN } : {}) }, { 'Set-Cookie': sessionCookie });
    }

    if (req.method === 'POST' && url.pathname === '/auth/logout') {
      // 幂等：没带令牌也回 200（契约如此）
      return send(res, 200, { ok: true }, { 'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
    }

    if (req.method === 'GET' && url.pathname === '/auth/me') {
      const token = req.headers['x-potato-token'] ?? (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (token !== TOKEN) return fail(res, 401, 'UNAUTHORIZED', '需要先登录');
      return send(res, 200, { ok: true, user: { id: 'u-alice', username: 'alice', role: 'admin' } });
    }

    return fail(res, 404, 'NOT_FOUND', `未找到账号接口 ${req.method} ${url.pathname}`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    state,
    /** 关掉服务器：用来测"连不上"（端口随即无人监听）。 */
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * 轮询等待一个条件成立（渲染层是异步重画的，睡固定毫秒数在慢机器上会假红）。
 * @param {() => boolean} predicate
 * @param {{timeoutMs?: number, stepMs?: number}} [options]
 */
async function waitFor(predicate, { timeoutMs = 2000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}

/** 起一套「桌面端后端」，返回 `call(method, route, body)`。 */
async function startApp({ account } = {}) {  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-account-'));
  const app = await createServer({ dataDir, account });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, call, dataDir, accountFile: path.join(dataDir, 'account.json') };
}

/** 读凭据文件（不存在时返回 null）。 */
async function readAccountFile(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/* ================================================================ 登录 */

test('账号：登录成功后把会话写进 account.json（0600），GET /account 不回传 token', async () => {
  const auth = await startFakeAuth();
  const { app, call, accountFile } = await startApp();
  try {
    // 登录前是"未登录"，但仍给出默认服务器地址，方便面板预填
    const before = await call('GET', '/account');
    assert.equal(before.status, 200);
    assert.equal(before.body.connected, false);
    assert.equal(before.body.user, null);
    assert.equal(before.body.serverUrl, 'http://localhost:8866');

    const logged = await call('POST', '/account/login', {
      serverUrl: auth.origin,
      username: 'alice',
      password: 'correct-horse-battery',
    });
    assert.equal(logged.status, 200);
    assert.equal(logged.body.ok, true);
    assert.equal(logged.body.user.username, 'alice');
    assert.equal(logged.body.serverUrl, auth.origin);
    // 令牌是 HttpOnly Cookie，桥取到之后**只留在后端**：登录响应里也不该有
    assert.equal(JSON.stringify(logged.body).includes(TOKEN), false, '登录响应里不该出现令牌');

    // 落盘的凭据文件：权限 0600
    const stats = await stat(accountFile);
    assert.equal(stats.mode & 0o777, 0o600, 'account.json 必须是 0600');

    const saved = await readAccountFile(accountFile);
    assert.equal(saved.serverUrl, auth.origin);
    assert.equal(saved.token, TOKEN, '令牌来自 Set-Cookie（服务端不在响应体里给令牌）');
    assert.equal(saved.user.username, 'alice');
    assert.ok(saved.loginAt, '要记下登录时间');

    const after = await call('GET', '/account');
    assert.equal(after.status, 200);
    assert.equal(after.body.connected, true);
    assert.equal(after.body.serverUrl, auth.origin);
    assert.equal(after.body.user.username, 'alice');
    assert.equal(after.body.user.role, 'admin');
    assert.ok(after.body.loginAt);

    // **绝不返回 token**：整个响应体里不许出现令牌明文
    const serialized = JSON.stringify(after.body);
    assert.equal(serialized.includes(TOKEN), false, 'GET /account 的响应里出现了令牌');
    assert.equal('token' in after.body, false, 'GET /account 不该有 token 字段');
  } finally {
    await app.close();
    await auth.close();
  }
});

test('账号：重启后仍记得登录态（token 从文件读回，仍然不外泄）', async () => {
  const auth = await startFakeAuth();
  const first = await startApp();
  try {
    await first.call('POST', '/account/login', { serverUrl: auth.origin, username: 'bob', password: 'hunter2hunter2' });
    const dataDir = first.dataDir;
    await first.app.close();

    const second = await createServer({ dataDir });
    const info = await second.listen({ port: 0 });
    try {
      const response = await fetch(`${info.baseUrl}/account`);
      const payload = await response.json();
      assert.equal(payload.connected, true);
      assert.equal(payload.user.username, 'bob');
      assert.equal(JSON.stringify(payload).includes(TOKEN), false);
    } finally {
      await second.close();
    }
  } finally {
    await first.app.close().catch(() => {});
    await auth.close();
  }
});

test('账号：服务器地址容错（缺协议补 http、多余斜杠与子路径被去掉）', async () => {
  const auth = await startFakeAuth();
  const { app, call, accountFile } = await startApp();
  try {
    const bare = auth.origin.replace(/^http:\/\//, '');
    const logged = await call('POST', '/account/login', {
      // 用户从浏览器地址栏复制时常见的样子：没协议 + 结尾斜杠 + 顺手带上了路径
      serverUrl: `${bare}/auth/login/`,
      username: 'alice',
      password: 'correct-horse-battery',
    });
    assert.equal(logged.status, 200);
    assert.equal(logged.body.serverUrl, auth.origin, '只保留 origin，不留子路径与尾斜杠');
    assert.equal((await readAccountFile(accountFile)).serverUrl, auth.origin);
  } finally {
    await app.close();
    await auth.close();
  }
});

/* ================================================================ 错误映射 */

test('账号：密码错 -> 401 中文人话，且本地不落盘', async () => {
  const auth = await startFakeAuth();
  const { app, call, accountFile } = await startApp();
  try {
    const response = await call('POST', '/account/login', { serverUrl: auth.origin, username: 'alice', password: 'wrong-password' });
    assert.equal(response.status, 401);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error.code, 'BAD_CREDENTIALS');
    assert.equal(response.body.error.message, '用户名或密码不对');
    // 上游原文不许整段透传
    assert.equal(JSON.stringify(response.body).includes('用户名或密码不对。'), false);
    assert.equal(await readAccountFile(accountFile), null, '登录失败不该留下 account.json');
  } finally {
    await app.close();
    await auth.close();
  }
});

test('账号：连错 5 次 -> 429，映射成"等 60 秒再试"', async () => {
  const auth = await startFakeAuth();
  const { app, call, accountFile } = await startApp();
  try {
    for (let i = 0; i < 5; i += 1) {
      const attempt = await call('POST', '/account/login', { serverUrl: auth.origin, username: 'alice', password: `wrong-${i}` });
      assert.equal(attempt.status, 401);
    }
    const limited = await call('POST', '/account/login', { serverUrl: auth.origin, username: 'alice', password: 'wrong-again' });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'RATE_LIMITED');
    assert.equal(limited.body.error.message, '失败次数太多，请等 60 秒再试');
    assert.equal(await readAccountFile(accountFile), null);
  } finally {
    await app.close();
    await auth.close();
  }
});

test('账号：邀请码无效 -> 403 人话；用户名重复 -> 409 人话；都不落盘', async () => {
  const auth = await startFakeAuth();
  const { app, call, accountFile } = await startApp();
  try {
    const badInvite = await call('POST', '/account/register', {
      serverUrl: auth.origin,
      username: 'newbie',
      password: 'a-good-password',
      inviteCode: 'NOPE-NOPE',
    });
    assert.equal(badInvite.status, 403);
    assert.equal(badInvite.body.error.code, 'INVITE_INVALID');
    assert.equal(badInvite.body.error.message, '邀请码无效或已被使用');
    assert.equal(await readAccountFile(accountFile), null);

    // 空邀请码在本地就拦住，不用白跑一趟服务器
    const noInvite = await call('POST', '/account/register', {
      serverUrl: auth.origin,
      username: 'newbie',
      password: 'a-good-password',
      inviteCode: '',
    });
    assert.equal(noInvite.status, 403);
    assert.equal(noInvite.body.error.message, '邀请码无效或已被使用');

    const duplicated = await call('POST', '/account/register', {
      serverUrl: auth.origin,
      username: 'alice',
      password: 'a-good-password',
      inviteCode: 'INVITE-OK-1',
    });
    assert.equal(duplicated.status, 409);
    assert.equal(duplicated.body.error.code, 'USER_EXISTS');
    assert.equal(duplicated.body.error.message, '这个用户名已经被注册了');
    assert.equal(await readAccountFile(accountFile), null, '注册失败不该留下 account.json');
  } finally {
    await app.close();
    await auth.close();
  }
});

test('账号：注册成功 -> 201 直接进入已登录', async () => {
  const auth = await startFakeAuth();
  const { app, call, accountFile } = await startApp();
  try {
    const response = await call('POST', '/account/register', {
      serverUrl: auth.origin,
      username: 'carol',
      password: 'a-good-password',
      inviteCode: 'INVITE-OK-1',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.user.username, 'carol');

    const saved = await readAccountFile(accountFile);
    assert.equal(saved.token, TOKEN);
    assert.equal(saved.user.username, 'carol');
    assert.equal((await stat(accountFile)).mode & 0o777, 0o600);

    const status = await call('GET', '/account');
    assert.equal(status.body.connected, true);
  } finally {
    await app.close();
    await auth.close();
  }
});

test('账号：连不上服务器 -> 502 人话（不是 500），本地不落盘', async () => {
  const auth = await startFakeAuth();
  const origin = auth.origin;
  // 先关掉服务器：端口随即无人监听（拿到端口再关，保证这个地址确实是"连不上"）
  await auth.close();

  const { app, call, accountFile } = await startApp();
  try {
    const response = await call('POST', '/account/login', { serverUrl: origin, username: 'alice', password: 'correct-horse-battery' });
    assert.equal(response.status, 502, '连不上是网关语义，不该是 500');
    assert.equal(response.body.error.message, '连不上这个服务器（检查地址，或对方没在跑）');
    assert.equal(await readAccountFile(accountFile), null);
  } finally {
    await app.close();
  }
});

test('账号：地址写错（不是 URL）-> 400 人话，不抛 500', async () => {
  const { app, call } = await startApp();
  try {
    const response = await call('POST', '/account/login', { serverUrl: 'http://[不是地址', username: 'alice', password: 'x' });
    assert.equal(response.status, 400);
    assert.match(response.body.error.message, /地址/);
  } finally {
    await app.close();
  }
});

test('账号：用户名或密码为空在本地就拦住', async () => {
  const { app, call } = await startApp();
  try {
    const response = await call('POST', '/account/login', { serverUrl: 'http://localhost:8866', username: '', password: '' });
    assert.equal(response.status, 400);
    assert.match(response.body.error.message, /用户名和密码/);
  } finally {
    await app.close();
  }
});

/* ================================================================ probe */

test('账号：probe 在服务器可达时报出服务名/版本/特性，LMS 明确不可用', async () => {
  const auth = await startFakeAuth();
  const { app, call } = await startApp();
  try {
    const response = await call('GET', `/account/probe?serverUrl=${encodeURIComponent(auth.origin)}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.reachable, true);
    assert.equal(response.body.serverName, '智学公开服务端');
    assert.equal(response.body.version, '0.3.0');
    assert.equal(response.body.features.lms, false);
    assert.equal(response.body.firstUserBecomesAdmin, true);
  } finally {
    await app.close();
    await auth.close();
  }
});

test('账号：probe 在服务器不可达时 reachable:false（不抛错）', async () => {
  const auth = await startFakeAuth();
  const origin = auth.origin;
  await auth.close();

  const { app, call } = await startApp();
  try {
    const response = await call('GET', `/account/probe?serverUrl=${encodeURIComponent(origin)}`);
    assert.equal(response.status, 200, 'probe 是"帮用户试地址"，连不上也算正常回答');
    assert.equal(response.body.ok, true);
    assert.equal(response.body.reachable, false);
    assert.equal(response.body.serverName, null);
    assert.equal(response.body.error, '连不上这个服务器（检查地址，或对方没在跑）');
  } finally {
    await app.close();
  }
});

test('账号：probe 遇到不是本程序的服务器（回 404）也是 reachable:false，并说清原因', async () => {
  const { app, call } = await startApp();
  try {
    // 本机后端自己就是个"不是智学服务端的 HTTP 服务"：/auth/config 会 404
    const response = await call('GET', `/account/probe?serverUrl=${encodeURIComponent('http://127.0.0.1:8866')}`);
    // 8866 上可能真有服务端在跑，也可能没有 —— 两种都必须 reachable 字段存在且不抛错
    assert.equal(response.status, 200);
    assert.equal(typeof response.body.reachable, 'boolean');
  } finally {
    await app.close();
  }
});

/* ================================================================ logout */

test('账号：退出登录清掉本地文件；服务器不可达时也照清不误', async () => {
  const auth = await startFakeAuth();
  const { app, call, accountFile } = await startApp();
  try {
    await call('POST', '/account/login', { serverUrl: auth.origin, username: 'alice', password: 'correct-horse-battery' });
    assert.ok(await readAccountFile(accountFile));

    const out = await call('POST', '/account/logout', {});
    assert.equal(out.status, 200);
    assert.equal(out.body.ok, true);
    assert.equal(out.body.remote, true, '服务器可达时应当真的通知到');
    assert.equal(await readAccountFile(accountFile), null, '退出后本地文件必须消失');
    assert.equal((await call('GET', '/account')).body.connected, false);

    // 关键：服务器已经连不上时，退出仍然要成功且清掉本地（否则用户只能手工删文件）
    await call('POST', '/account/login', { serverUrl: auth.origin, username: 'alice', password: 'correct-horse-battery' });
    assert.ok(await readAccountFile(accountFile));
    await auth.close();

    const offline = await call('POST', '/account/logout', {});
    assert.equal(offline.status, 200);
    assert.equal(offline.body.ok, true);
    assert.equal(offline.body.remote, false, '通知不到服务器也要如实说明');
    assert.equal(await readAccountFile(accountFile), null, '连不上服务器时也必须清掉本地凭据');
    assert.equal((await call('GET', '/account')).body.connected, false);
  } finally {
    await app.close();
    await auth.close().catch(() => {});
  }
});

test('账号：没登录时退出也返回成功（幂等）', async () => {
  const { app, call } = await startApp();
  try {
    const response = await call('POST', '/account/logout', {});
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
  } finally {
    await app.close();
  }
});

/* ================================================================ 令牌载体 */

test('账号：令牌同时通过 Bearer 与 X-Potato-Token 转发（手机端与桌面端同一套契约）', async () => {
  const auth = await startFakeAuth();
  const { app, call } = await startApp();
  try {
    await call('POST', '/account/login', { serverUrl: auth.origin, username: 'alice', password: 'correct-horse-battery' });
    await call('POST', '/account/logout', {});
    const logout = auth.state.requests.filter((item) => item.url === '/auth/logout').at(-1);
    assert.ok(logout, '退出登录应当真的通知到服务器');
    // logout 会带上令牌：这是桥"确实持有会话"的证据
    assert.equal(logout.headers['x-potato-token'], TOKEN);
    assert.equal(logout.headers.authorization, `Bearer ${TOKEN}`);
  } finally {
    await app.close();
    await auth.close();
  }
});

test('账号：服务端把令牌放在响应体里时也能认（兼容分支）', async () => {
  const auth = await startFakeAuth({ tokenInBody: true });
  const { app, call, accountFile } = await startApp();
  try {
    const response = await call('POST', '/account/login', { serverUrl: auth.origin, username: 'alice', password: 'correct-horse-battery' });
    assert.equal(response.status, 200);
    assert.equal((await readAccountFile(accountFile)).token, TOKEN);
  } finally {
    await app.close();
    await auth.close();
  }
});

/* ================================================================ 同源（服务端版） */

test('账号：serverUrl 为空 = 同源，走相对路径而不是拼出一个坏地址', async () => {
  const auth = await startFakeAuth();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-account-same-'));
  // 服务端版的用法：defaultServerUrl 设成空串（页面与 /auth 同源）
  const service = new AccountService({
    dataDir,
    defaultServerUrl: '',
    origin: auth.origin,
    fetchImpl: globalThis.fetch,
  });
  await service.load();
  try {
    // 相对路径 + origin 补全 -> 打到同一台"服务器"上
    const status = await service.probe({});
    assert.equal(status.reachable, true);
    assert.equal(status.serverName, '智学公开服务端');

    const logged = await service.login({ username: 'alice', password: 'correct-horse-battery' });
    assert.equal(logged.ok, true);
    assert.equal(logged.serverUrl, '', '同源模式下 serverUrl 保持空串');
    // 相对路径确实被用上了：请求打到 /auth/login 而不是某个绝对地址
    assert.ok(auth.state.requests.some((item) => item.url === '/auth/login'));
  } finally {
    await auth.close();
  }
});

/* ================================================================ 状态与摘要 */

test('账号：status() 只给面板要的字段，且不含 token', async () => {
  const auth = await startFakeAuth();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-account-status-'));
  const service = new AccountService({ dataDir });
  await service.load();
  try {
    assert.deepEqual(service.status(), { connected: false, serverUrl: 'http://localhost:8866', user: null, loginAt: null });
    await service.login({ serverUrl: auth.origin, username: 'alice', password: 'correct-horse-battery' });
    const status = service.status();
    assert.equal(status.connected, true);
    assert.equal(status.user.username, 'alice');
    assert.equal('token' in status, false);
    assert.equal(JSON.stringify(status).includes(TOKEN), false);
  } finally {
    await auth.close();
  }
});

test('账号：凭据文件损坏时当作未登录启动（不拖垮启动、不静默覆盖）', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-account-broken-'));
  const accountFile = path.join(dataDir, 'account.json');
  await writeFile(accountFile, '{ 这不是 JSON');

  const app = await createServer({ dataDir });
  const info = await app.listen({ port: 0 });
  try {
    const response = await fetch(`${info.baseUrl}/account`);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.connected, false, '文件坏了就当没登录，但服务要照常起来');
    // 原件被备份，没有被直接覆盖 —— 用户还有机会人工找回
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(dataDir);
    assert.ok(files.some((name) => name.startsWith('account.json.corrupt-')), `期望有 .corrupt- 备份，实际：${files.join(',')}`);
  } finally {
    await app.close();
  }
});

test('账号：错误码映射表覆盖契约里冻结的几种', () => {
  assert.equal(ERROR_MESSAGES.BAD_CREDENTIALS, '用户名或密码不对');
  assert.equal(ERROR_MESSAGES.INVITE_INVALID, '邀请码无效或已被使用');
  assert.equal(ERROR_MESSAGES.USER_EXISTS, '这个用户名已经被注册了');
  assert.equal(ERROR_MESSAGES.RATE_LIMITED, '失败次数太多，请等 60 秒再试');
  assert.equal(UNREACHABLE_MESSAGE, '连不上这个服务器（检查地址，或对方没在跑）');
});

test('账号：模块声明了 id/order 且没有给 AI 任何工具或查询入口', async () => {
  const { loadModules } = await import('../src/core/module/registry.js');
  const modules = await loadModules({ only: ['account'] });
  assert.equal(modules.length, 1);
  const mod = modules[0];
  assert.equal(mod.id, 'account');
  assert.equal(mod.order, 88);
  assert.deepEqual(mod.collections, [], '凭据不进 JsonStore（那是 0644 的业务数据）');
  // 账号是用户自己的事：不给模型碰
  assert.equal(mod.aiTools, undefined);
  assert.equal(mod.aiPrompt, undefined);
  assert.equal(mod.aiQueryFields, undefined);
});

test('账号：不是 AI 的工具（/ai/capabilities 里没有 account 的条目）', async () => {
  const { app, call } = await startApp();
  try {
    const capabilities = await call('GET', '/ai/capabilities');
    assert.equal(capabilities.status, 200);
    const tools = capabilities.body.aiTools ?? [];
    assert.equal(tools.some((tool) => tool.module === 'account'), false, '账号模块不该出现在 AI 工具清单里');
  } finally {
    await app.close();
  }
});

/* ================================================================ 渲染层 */

test('账号：渲染层文件能被既有 renderer 测试加载，并登记出「账号登录」设置区块', () => {
  const { PCModules } = bootRenderer({ api: async () => ({ ok: true }) });
  const sections = PCModules.settingsSections();
  const section = sections.find((item) => item.id === 'account.login');
  assert.ok(section, `没有登记账号区块，现有区块：${sections.map((s) => s.id).join(', ')}`);
  assert.equal(section.title, '账号登录');
  assert.equal(typeof section.render, 'function');
  // 区块标题里必须出现"账号"，用户才找得到
  assert.match(section.title, /账号/);
});

test('账号：面板未登录时给出地址/用户名/密码与测试连接，密码框是 password', async () => {
  const { PCModules, El } = bootRenderer({
    state: {},
    api: async (url) => (url === '/account'
      ? { ok: true, connected: false, serverUrl: 'http://localhost:8866', user: null, loginAt: null }
      : { ok: true }),
  });
  const section = PCModules.settingsSections().find((item) => item.id === 'account.login');
  const mount = new El('div');
  section.render(mount);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const inputs = mount.querySelectorAll('input');
  const password = inputs.find((node) => node.type === 'password');
  assert.ok(password, '必须有密码输入框');
  assert.equal(password.autocomplete, 'current-password', '登录密码用 current-password');

  const labels = mount.querySelectorAll('button').map((node) => node.textContent);
  assert.ok(labels.includes('登录'), `缺少登录按钮：${labels.join(', ')}`);
  assert.ok(labels.includes('测试连接'), `缺少测试连接按钮：${labels.join(', ')}`);
  assert.ok(labels.some((text) => /注册/.test(text)), '要有注册入口');

  // 默认地址写在界面上，用户不用猜
  assert.ok(inputs.some((node) => node.value === 'http://localhost:8866'), '服务器地址要预填默认值');
  assert.match(mount.textContent, /服务器地址/);
});

test('账号：展开注册后注册密码框用 new-password', async () => {
  const { PCModules, El } = bootRenderer({
    state: {},
    api: async (url) => (url === '/account'
      ? { ok: true, connected: false, serverUrl: 'http://localhost:8866', user: null, loginAt: null }
      : { ok: true }),
  });
  const section = PCModules.settingsSections().find((item) => item.id === 'account.login');
  const mount = new El('div');
  section.render(mount);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const toggle = mount.querySelectorAll('button').find((node) => /注册/.test(node.textContent) && !/注册并登录/.test(node.textContent));
  toggle.listeners.click[0]();
  const inputs = mount.querySelectorAll('input');
  const passwords = inputs.filter((node) => node.type === 'password');
  assert.ok(
    passwords.some((node) => node.autocomplete === 'new-password'),
    `注册表单要有 new-password 的密码框，实际：${passwords.map((p) => p.autocomplete).join(', ')}`,
  );
  assert.ok(inputs.some((node) => /邀请码/.test(node.placeholder)), '注册表单要有邀请码输入框');
});

test('账号：登录成功后面板显示已登录、服务器地址与登录时间，并显示"测试连接"结果', async () => {
  let connected = false;
  const user = { id: 'u-alice', username: 'alice', role: 'admin' };
  const { PCModules, El, calls } = bootRenderer({
    state: {},
    api: async (url) => {
      if (url === '/account') {
        return { ok: true, connected, serverUrl: 'http://localhost:8866', user: connected ? user : null, loginAt: connected ? '2026-10-14T02:00:00.000Z' : null };
      }
      if (String(url).startsWith('/account/probe')) {
        return { ok: true, reachable: true, serverName: '智学公开服务端', version: '0.3.0', features: { lms: false }, firstUserBecomesAdmin: true };
      }
      if (url === '/account/login') {
        connected = true;
        return { ok: true, user, serverUrl: 'http://localhost:8866' };
      }
      return { ok: true };
    },
  });
  const section = PCModules.settingsSections().find((item) => item.id === 'account.login');
  const mount = new El('div');
  section.render(mount);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
  await tick();

  // 先点"测试连接"：显示服务器名、版本、以及该服务器上 LMS 不可用
  mount.querySelectorAll('button').find((node) => node.textContent === '测试连接').listeners.click[0]();
  await tick();
  const probeText = mount.textContent;
  assert.match(probeText, /智学公开服务端/);
  assert.match(probeText, /0\.3\.0/);
  assert.match(probeText, /思源学堂不可用/);

  // 再登录：面板要切换到"已登录"三要素
  mount.querySelectorAll('button').find((node) => node.textContent === '登录').listeners.click[0]();
  await tick();
  assert.match(mount.textContent, /已登录：alice（管理员）/);
  assert.match(mount.textContent, /服务器地址/);
  assert.match(mount.textContent, /登录时间/);
  // 诚实说明：登录不做同步
  assert.match(mount.textContent, /登录只解决身份/);
  assert.match(mount.textContent, /不会自动上传或覆盖你的本地数据/);
  assert.ok(calls.some((line) => line === 'POST /account/login'));
});

test('账号：登录失败时把后端的人话显示在面板上', async () => {
  const { PCModules, El } = bootRenderer({
    state: {},
    api: async (url) => {
      if (url === '/account') return { ok: true, connected: false, serverUrl: 'http://localhost:8866', user: null, loginAt: null };
      if (url === '/account/login') {
        const error = new Error('用户名或密码不对');
        error.status = 401;
        throw error;
      }
      return { ok: true };
    },
  });
  const section = PCModules.settingsSections().find((item) => item.id === 'account.login');
  const mount = new El('div');
  section.render(mount);
  await new Promise((resolve) => setTimeout(resolve, 20));

  mount.querySelectorAll('button').find((node) => node.textContent === '登录').listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(mount.textContent, /用户名或密码不对/, '失败原因要显示出来，不能只弹个 toast');
  assert.equal(mount.querySelectorAll('.acct-alert').length >= 1, true, '用错误块显示');
});

test('账号：已登录时提供了「退出登录」，点了要经过一次确认', async () => {
  let connected = true;
  const { PCModules, El, calls } = bootRenderer({
    state: {},
    api: async (url) => {
      if (url === '/account') {
        return { ok: true, connected, serverUrl: 'http://localhost:8866', user: { id: 'u1', username: 'alice', role: 'admin' }, loginAt: '2026-10-14T02:00:00.000Z' };
      }
      if (url === '/account/logout') {
        connected = false;
        return { ok: true };
      }
      return { ok: true };
    },
  });
  const section = PCModules.settingsSections().find((item) => item.id === 'account.login');
  const mount = new El('div');
  section.render(mount);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
  await tick();

  const out = mount.querySelectorAll('button').find((node) => node.textContent === '退出登录');
  assert.ok(out, '已登录时要有退出按钮');
  out.listeners.click[0]();
  // 第一次点击只是确认，不该已经调了接口
  assert.equal(calls.includes('POST /account/logout'), false, '第一步不该直接退出');
  assert.ok(mount.querySelectorAll('button').some((node) => node.textContent === '确认退出登录'));

  mount.querySelectorAll('button').find((node) => node.textContent === '确认退出登录').listeners.click[0]();
  await tick();
  assert.ok(calls.includes('POST /account/logout'), '确认后才真的退出');
  assert.match(mount.textContent, /测试连接/, '退出后回到未登录表单');
});

test('账号：重画之后表单里仍是用户敲的内容（输入不会被清空）', async () => {
  // 回归测试：面板是「整块重建 DOM」的渲染方式，而 run() 在发请求**之前**会先重画一次
  // （按钮切成"登录中…"）。若重画时不把用户输入还原回去，刚敲的用户名/密码就没了 ——
  // 真机上表现为「刚填完，点登录却提示"用户名和密码都要填"」。
  // 这个 bug 是 Electron 真机验证抓出来的（DOM 桩不清理旧节点的值，所以桩上不暴露）。
  //
  // 这里断言的是**能被桩观察到的那一半**：重画之后，新渲染出来的输入框里
  // 必须仍然是用户敲的值。若 view 不保存/还原表单，新节点就是空的，这条立刻红。
  const sent = [];
  const { PCModules, El } = bootRenderer({
    state: {},
    api: async (url, options = {}) => {
      if (url === '/account') {
        return { ok: true, connected: false, serverUrl: 'http://localhost:8866', user: null, loginAt: null };
      }
      if (url === '/account/login') {
        sent.push(JSON.parse(JSON.stringify(options.body ?? {})));
        return { ok: true, user: { id: 'u1', username: 'alice', role: 'admin' }, serverUrl: 'http://127.0.0.1:8866' };
      }
      return { ok: true };
    },
  });
  const section = PCModules.settingsSections().find((item) => item.id === 'account.login');
  const mount = new El('div');
  section.render(mount);
  await new Promise((resolve) => setTimeout(resolve, 25));

  const findInputs = () => {
    const all = mount.querySelectorAll('input');
    return {
      server: all.find((n) => n.type === 'text' && n.placeholder === 'http://localhost:8866'),
      user: all.find((n) => n.placeholder === '用户名'),
      password: all.find((n) => n.type === 'password'),
    };
  };
  const before = findInputs();
  before.server.value = 'http://127.0.0.1:8866';
  before.user.value = 'alice';
  before.password.value = 'correct-horse-battery';

  mount.querySelectorAll('button').find((node) => node.textContent === '登录').listeners.click[0]();
  await waitFor(() => sent.length > 0);

  assert.equal(sent.length, 1, '登录请求应当发出且只发一次');
  assert.deepEqual(sent[0], {
    serverUrl: 'http://127.0.0.1:8866',
    username: 'alice',
    password: 'correct-horse-battery',
  }, '请求体必须是用户刚敲进去的内容');

  // 关键断言：这一轮重画之后，表单里依然是刚才那三样
  const after = findInputs();
  assert.equal(after.server.value, 'http://127.0.0.1:8866', '重画后服务器地址被清空了');
  assert.equal(after.user.value, 'alice', '重画后用户名被清空了');
  assert.equal(after.password.value, 'correct-horse-battery', '重画后密码被清空了');
});

test('账号：请求进行中按钮禁用并显示进行时文案', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let connected = false;
  const { PCModules, El } = bootRenderer({
    state: {},
    api: async (url) => {
      if (url === '/account') {
        return {
          ok: true,
          connected,
          serverUrl: 'http://localhost:8866',
          user: connected ? { id: 'u1', username: 'alice' } : null,
          loginAt: connected ? '2026-10-14T02:00:00.000Z' : null,
        };
      }
      if (url === '/account/login') {
        await gate;
        connected = true;
        return { ok: true, user: { id: 'u1', username: 'alice' }, serverUrl: 'http://localhost:8866' };
      }
      return { ok: true };
    },
  });
  const section = PCModules.settingsSections().find((item) => item.id === 'account.login');
  const mount = new El('div');
  section.render(mount);
  await new Promise((resolve) => setTimeout(resolve, 20));

  mount.querySelectorAll('button').find((node) => node.textContent === '登录').listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 5));

  const buttons = mount.querySelectorAll('button');
  const busy = buttons.find((node) => node.textContent === '登录中…');
  assert.ok(busy, `进行中要显示"登录中…"，实际按钮：${buttons.map((b) => b.textContent).join(', ')}`);
  assert.equal(busy.disabled, true, '进行中按钮要禁用');
  assert.equal(buttons.filter((node) => node.disabled).length, buttons.length, '进行中所有按钮都禁用，防止重复提交');

  release();
  // 等 run() 走完：请求 -> 重新读状态 -> 重画，是几轮微任务 + 两次伪后端往返。
  // 这里**轮询到出现为止**而不是睡一个固定毫秒数：固定值在慢机器上会假红。
  const settled = await waitFor(() => /已登录：alice/.test(mount.textContent));
  assert.ok(settled, `登录完成后应切到已登录态，实际：${mount.textContent.slice(0, 120)}`);
});
