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
 *   - 上游错误码 -> 中文人话（401/403/409/429）；
 *   - **地址归一化**：不写协议按主机名补（域名 https / 本机 http）、去尾斜杠、保留子路径前缀；
 *   - **跳转不丢方法**：301/302/307/308 之后必须仍用 POST 且 body 完整（fetch 自己跟会把 POST 变成 GET，
 *     真机上 nginx 的 `http -> https` 就是这么把登录搞坏的）；
 *   - 跳到**别的 host** 一律拒绝（`REDIRECT_REFUSED`），且密码一个字节都没发过去；
 *   - 四种错误分得清：`BAD_SERVER_URL` / `SERVER_UNREACHABLE` / `NOT_POTATO_SERVER` / 上游错误码；
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
import {
  AccountService,
  ERROR_MESSAGES,
  NOT_POTATO_SERVER_MESSAGE,
  SESSION_COOKIE,
  UNREACHABLE_MESSAGE,
  normalizeServerUrl,
} from '../src/modules/account/service.js';
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
 * @param {string}  [options.prefix] 把 `/auth/**` 挂在哪个子路径下（默认根路径）。
 *   用来验证"地址带子路径时保留它作为前缀"（服务端挂在反代子路径后面是合法部署）
 * @param {Array<{status:number, location:string}>} [options.loginRedirects] 头几次
 *   `POST /auth/login` 先按给的状态码 + Location 顶回去（Location 里的 `{self}` 会替换成
 *   本服务器的 origin）。这是为了复刻真机上 nginx 的 `http -> https` 跳转 ——
 *   也是"301 之后到底还是不是 POST"这句断言的证据来源
 * @param {boolean} [options.configHtml] `/auth/config` 回一段 HTML（模拟"这个地址不是智学服务端"）
 * @param {object}  [options.configBody] `/auth/config` 回指定 JSON（测"JSON 里没有 serverName/registration"）
 */
async function startFakeAuth({
  cors = false,
  tokenInBody = false,
  rateLimitAfter = 5,
  prefix = '',
  loginRedirects = [],
  configHtml = false,
  configBody = null,
} = {}) {
  const state = { requests: [], badPasswordCount: 0, redirectsLeft: [...loginRedirects] };
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
    // `raw` 也记下来：断言"跟跳转时 body 完整"必须看原始字符串，光看解析结果不够
    state.requests.push({ method: req.method, url: req.url, headers: req.headers, body, raw });

    const url = new URL(req.url, 'http://127.0.0.1');
    /** 路由挂载点：默认根路径，`prefix` 非空时整组挪到子路径下 */
    const at = (p) => `${prefix}${p}`;

    if (req.method === 'GET' && url.pathname === at('/auth/config')) {
      if (configHtml) {
        // 一个"能打开、但不是智学服务端"的地址：200 + HTML（真实世界里就是别人的首页/门户）
        const html = '<!doctype html><html><head><title>某个站点</title></head><body>欢迎光临</body></html>';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
        res.end(html);
        return;
      }
      if (configBody) return send(res, 200, configBody);
      return send(res, 200, {
        serverName: '智学公开服务端',
        version: '0.3.0',
        registration: 'invite',
        firstUserBecomesAdmin: true,
        features: { lms: false },
      });
    }

    if (req.method === 'POST' && url.pathname === at('/auth/login')) {
      const jump = state.redirectsLeft.shift();
      if (jump) {
        // 仿 nginx：301/302 + 一段 HTML 正文（真机上"登录拿到 HTML"就是这么来的）
        const location = String(jump.location ?? at('/auth/login')).replaceAll('{self}', origin);
        res.writeHead(jump.status, { 'Content-Type': 'text/html; charset=utf-8', Location: location });
        res.end('<html><body>301 Moved Permanently</body></html>');
        return;
      }
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

    if (req.method === 'POST' && url.pathname === at('/auth/register')) {
      const username = String(body.username ?? '').trim();
      const code = String(body.inviteCode ?? '').trim();
      if (accounts.has(username)) return fail(res, 409, 'USER_EXISTS', `用户名「${username}」已被占用`);
      if (!invites.has(code)) return fail(res, 403, 'INVITE_INVALID', '邀请码无效');
      invites.delete(code);
      accounts.set(username, { id: `u-${username}`, password: body.password, role: 'member' });
      const user = { id: `u-${username}`, username, role: 'member' };
      return send(res, 201, { ok: true, user, ...(tokenInBody ? { token: TOKEN } : {}) }, { 'Set-Cookie': sessionCookie });
    }

    if (req.method === 'POST' && url.pathname === at('/auth/logout')) {
      // 幂等：没带令牌也回 200（契约如此）
      return send(res, 200, { ok: true }, { 'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
    }

    if (req.method === 'GET' && url.pathname === at('/auth/me')) {
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
 * 起一个"按你的脚本回话"的假服务器：只负责记录请求，回复完全交给 `handler`。
 *
 * 用途是构造**需要两台服务器**才能验证的场景（"跳转到别的 host 被拒"那一类）：
 * 一台负责给出 301，另一台等着看自己有没有收到密码。
 * 默认 `listen(0)` **不带 host = 双栈监听**，于是 `localhost` / `127.0.0.1` / `[::1]`
 * 三种写法都会落到同一个端口上 —— "有没有泄漏"这句断言才不会被 DNS 解析顺序骗过去。
 *
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} handler
 * @param {{host?: string}} [options] 指定监听地址（默认双栈）
 */
async function startRawServer(handler, { host } = {}) {
  const state = { requests: [] };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    // 必须先把请求体读干再回话：否则带 body 的请求可能让客户端拿到 ECONNRESET
    const raw = Buffer.concat(chunks).toString('utf8');
    state.requests.push({ method: req.method, url: req.url, headers: req.headers, raw });
    handler(req, res);
  });
  await new Promise((resolve) => (host ? server.listen(0, host, resolve) : server.listen(0, resolve)));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    port: server.address().port,
    state,
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

/* ================================================================ 地址归一化 */

test('账号：normalizeServerUrl 是纯函数 —— 补协议/去尾斜杠/保留子路径/非法地址报 BAD_SERVER_URL', () => {
  // 真机踩到的形态全在这张表里：用户可能只敲了域名（不带协议）。
  // 为什么这条必须做成纯函数单测：这里没有任何真实外网，https 的补法根本没法用
  // 本地假服务器（只能是 http）验证 —— 所以补协议这一步必须能脱离网络被断言。
  const table = [
    ['study.xjtuwhy.com', undefined, 'https://study.xjtuwhy.com'],
    ['  study.xjtuwhy.com/  ', undefined, 'https://study.xjtuwhy.com'],
    ['localhost:8866', undefined, 'http://localhost:8866'],
    ['127.0.0.1:8866', undefined, 'http://127.0.0.1:8866'],
    ['[::1]:8866', undefined, 'http://[::1]:8866'],
    ['https://x.com/', undefined, 'https://x.com'],
    ['https://x.com/study/', undefined, 'https://x.com/study'],
    ['example.com', { defaultScheme: 'http' }, 'http://example.com'],
    ['', undefined, ''], // 空串 = 同源哨兵（服务端版），不是错误
  ];
  for (const [input, options, expected] of table) {
    assert.equal(normalizeServerUrl(input, options), expected, `${JSON.stringify(input)} 应当归一化成 ${expected}`);
  }

  for (const bad of ['a b', 'study xjtuwhy.com', 'http://[不是地址', 'ftp://x.com', 'http://user:pw@x.com']) {
    assert.throws(
      () => normalizeServerUrl(bad),
      (error) => {
        assert.equal(error.code, 'BAD_SERVER_URL', `${bad} 应当报 BAD_SERVER_URL`);
        assert.match(error.message, /^服务器地址看起来不对：/);
        assert.match(error.message, /示例：https:\/\/study\.xjtuwhy\.com/, 'message 里必须给出一个能照抄的示例');
        return true;
      },
      `${bad} 应当被拒`,
    );
  }
});

test('账号：不写协议也能登录（纯 IP 默认 http），落盘与回给面板的是归一化后的地址', async () => {
  const auth = await startFakeAuth();
  const { app, call, accountFile } = await startApp();
  try {
    const bare = auth.origin.replace(/^http:\/\//, ''); // 例：127.0.0.1:53421
    const logged = await call('POST', '/account/login', {
      // 用户从浏览器地址栏复制时常见的样子：没协议 + 结尾多一个斜杠
      serverUrl: `${bare}/`,
      username: 'alice',
      password: 'correct-horse-battery',
    });
    assert.equal(logged.status, 200);
    assert.equal(logged.body.serverUrl, auth.origin, '回给面板的是归一化后的地址');
    assert.equal((await readAccountFile(accountFile)).serverUrl, auth.origin, 'account.json 里也是归一化后的地址');

    const status = await call('GET', '/account');
    assert.equal(status.body.serverUrl, auth.origin);
    assert.equal(JSON.stringify(status.body).includes(TOKEN), false, 'GET /account 仍然不含 token');
  } finally {
    await app.close();
    await auth.close();
  }
});

test('账号：地址带子路径时保留它当前缀（服务端挂在反代子路径后面）', async () => {
  const auth = await startFakeAuth({ prefix: '/study' });
  const { app, call } = await startApp();
  try {
    const logged = await call('POST', '/account/login', {
      serverUrl: `${auth.origin}/study`,
      username: 'alice',
      password: 'correct-horse-battery',
    });
    assert.equal(logged.status, 200, '子路径前缀必须被保留，否则请求会打到根路径上 404');
    assert.equal(logged.body.serverUrl, `${auth.origin}/study`);
    assert.deepEqual(auth.state.requests.map((item) => item.url), ['/study/auth/login']);

    const probe = await call('GET', `/account/probe?serverUrl=${encodeURIComponent(`${auth.origin}/study`)}`);
    assert.equal(probe.body.reachable, true);
    assert.ok(auth.state.requests.some((item) => item.url === '/study/auth/config'));
  } finally {
    await app.close();
    await auth.close();
  }
});

/* ================================================================ 跳转（301 不许把 POST 变成 GET） */

// 契约里会出现的四种跳转状态码。**301/302 才是真机上那个坑**（fetch 会把 POST 改写成 GET），
// 307/308 语义上要求原样重发 —— 我们对四种一视同仁：同一方法、同一 body。
for (const status of [301, 302, 307, 308]) {
  test(`账号：服务器回 ${status} 时手动跟跳转，第二跳仍然是 POST 且 body 完整`, async () => {
    const auth = await startFakeAuth({ loginRedirects: [{ status, location: '{self}/auth/login' }] });
    const { app, call, accountFile } = await startApp();
    try {
      const logged = await call('POST', '/account/login', {
        serverUrl: auth.origin,
        username: 'alice',
        password: 'correct-horse-battery',
      });
      assert.equal(logged.status, 200, '跟完跳转后应当正常登录成功');

      const methods = auth.state.requests.map((item) => item.method);
      assert.deepEqual(methods, ['POST', 'POST'], `跳转前后都必须是 POST（fetch 自己跟会把第二跳变成 GET），实际：${methods.join(',')}`);

      const latest = auth.state.requests.at(-1);
      assert.deepEqual(latest.body, { username: 'alice', password: 'correct-horse-battery' }, '第二跳的 body 必须完整');
      assert.match(latest.raw, /correct-horse-battery/, '原始请求体里必须真的带着密码（不是空 body）');
      assert.equal(await readAccountFile(accountFile) !== null, true, '跟完跳转后照常落盘');
    } finally {
      await app.close();
      await auth.close();
    }
  });
}

test('账号：跟完跳转后，account.json 与面板拿到的是**跳转之后的最终地址**', async () => {
  const real = await startFakeAuth();
  // 仿 nginx：老地址（比如 80 端口那一跳）把请求 301 到真正的服务端。
  // 这里用"同一台机器的另一个端口"来模拟 http→https 那一跳 —— 真正要验证的是
  // **跳转后的最终 base 会被记下来**（真机上就是从 http://study.xjtuwhy.com 变成 https://…）。
  const front = await startRawServer((req, res) => {
    res.writeHead(301, { 'Content-Type': 'text/html; charset=utf-8', Location: `${real.origin}${req.url}` });
    res.end('<html><body>301 Moved Permanently</body></html>');
  });
  const { app, call, accountFile } = await startApp();
  try {
    const logged = await call('POST', '/account/login', {
      serverUrl: front.origin.replace(/^http:\/\//, ''), // 用户还少写了协议
      username: 'alice',
      password: 'correct-horse-battery',
    });
    assert.equal(logged.status, 200);
    assert.equal(logged.body.serverUrl, real.origin, '回给面板的是最终地址');
    assert.equal((await readAccountFile(accountFile)).serverUrl, real.origin, 'account.json 里存的也是最终地址');

    const status = await call('GET', '/account');
    assert.equal(status.body.serverUrl, real.origin);
    assert.equal(JSON.stringify(status.body).includes(TOKEN), false, 'GET /account 仍然不含 token');

    const latest = real.state.requests.at(-1);
    assert.equal(latest.method, 'POST');
    assert.deepEqual(latest.body, { username: 'alice', password: 'correct-horse-battery' });
  } finally {
    await app.close();
    await front.close();
    await real.close();
  }
});

test('账号：跳到别的 host 一律拒绝（REDIRECT_REFUSED），密码一个字节都没发过去', async () => {
  // "受害者"服务器：双栈监听，localhost / 127.0.0.1 / [::1] 都能打到它身上。
  // 万一桥真的跟跳转了，无论 DNS 先解析到哪个地址，这里都会记下那一发请求。
  const victim = await startRawServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  const auth = await startFakeAuth({
    // Location 的 hostname（localhost）与请求的 hostname（127.0.0.1）不同 -> 必须拒绝
    loginRedirects: [{ status: 301, location: `http://localhost:${victim.port}/auth/login` }],
  });
  const { app, call, accountFile } = await startApp();
  try {
    const response = await call('POST', '/account/login', {
      serverUrl: auth.origin,
      username: 'alice',
      password: 'correct-horse-battery',
    });
    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, 'REDIRECT_REFUSED');
    assert.match(response.body.error.message, /另一台主机/);
    assert.equal(victim.state.requests.length, 0, '别的 host 一个请求都不该收到（尤其不能收到密码）');
    assert.equal(await readAccountFile(accountFile), null, '被拒的登录不该落盘');
  } finally {
    await app.close();
    await auth.close();
    await victim.close();
  }
});

test('账号：一直跳个不停时最多跟 3 跳就停下（不会无限绕圈）', async () => {
  const loop = await startRawServer((req, res) => {
    res.writeHead(302, { Location: '/auth/login' });
    res.end('again');
  });
  const { app, call } = await startApp();
  try {
    const response = await call('POST', '/account/login', { serverUrl: loop.origin, username: 'alice', password: 'correct-horse-battery' });
    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, 'REDIRECT_REFUSED');
    assert.match(response.body.error.message, /超过 3 次/);
    assert.equal(loop.state.requests.length, 4, '首次 + 3 跳，一共 4 次请求就停手');
  } finally {
    await app.close();
    await loop.close();
  }
});

/* ================================================================ 地址错 / 不是智学服务端 */

test('账号：地址里有空格 -> 400 BAD_SERVER_URL，而且一个请求都不发', async () => {
  const auth = await startFakeAuth();
  const { app, call } = await startApp();
  try {
    const response = await call('POST', '/account/login', {
      serverUrl: `${auth.origin}/a b`,
      username: 'alice',
      password: 'correct-horse-battery',
    });
    assert.equal(response.status, 400, '地址不合法是"用户填错了"，不是"服务器没开"');
    assert.equal(response.body.error.code, 'BAD_SERVER_URL');
    assert.match(response.body.error.message, /服务器地址看起来不对/);
    assert.match(response.body.error.message, /示例：https:\/\/study\.xjtuwhy\.com/);
    assert.equal(auth.state.requests.length, 0, '地址都不合法，不该发任何请求出去');

    // probe 也不发请求，而是把这句话原样带回来给面板
    const probe = await call('GET', `/account/probe?serverUrl=${encodeURIComponent(`${auth.origin}/a b`)}`);
    assert.equal(probe.status, 200);
    assert.equal(probe.body.reachable, false);
    assert.equal(probe.body.errorCode, 'BAD_SERVER_URL');
    assert.match(probe.body.error, /服务器地址看起来不对/);
    assert.equal(auth.state.requests.length, 0);
  } finally {
    await app.close();
    await auth.close();
  }
});

test('账号：/auth/config 回一段 HTML -> NOT_POTATO_SERVER（"能打开但不是智学服务端"）', async () => {
  const auth = await startFakeAuth({ configHtml: true });
  const { app, call } = await startApp();
  try {
    const response = await call('GET', `/account/probe?serverUrl=${encodeURIComponent(auth.origin)}`);
    assert.equal(response.status, 200, 'probe 是"帮用户试地址"，不是智学服务端也算一种正常回答');
    assert.equal(response.body.reachable, false);
    assert.equal(response.body.errorCode, 'NOT_POTATO_SERVER');
    assert.equal(response.body.error, NOT_POTATO_SERVER_MESSAGE);
    assert.match(response.body.error, /不是「AI 智学」的服务端/);
    assert.match(response.body.error, /缺少 \/auth\/config/);
  } finally {
    await app.close();
    await auth.close();
  }
});

test('账号：/auth/config 回 JSON 但没有 serverName/registration -> 也是 NOT_POTATO_SERVER', async () => {
  const auth = await startFakeAuth({ configBody: { ok: true, hello: 'world' } });
  const { app, call } = await startApp();
  try {
    const response = await call('GET', `/account/probe?serverUrl=${encodeURIComponent(auth.origin)}`);
    assert.equal(response.body.reachable, false);
    assert.equal(response.body.errorCode, 'NOT_POTATO_SERVER');
    assert.equal(response.body.error, NOT_POTATO_SERVER_MESSAGE);
  } finally {
    await app.close();
    await auth.close();
  }
});

test('账号：登录时对面回 HTML（地址填到了别的服务）-> NOT_POTATO_SERVER，不落盘', async () => {
  const blog = await startRawServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body>这里是某个站点首页</body></html>');
  });
  const { app, call, accountFile } = await startApp();
  try {
    const response = await call('POST', '/account/login', { serverUrl: blog.origin, username: 'alice', password: 'correct-horse-battery' });
    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, 'NOT_POTATO_SERVER');
    assert.equal(response.body.error.message, NOT_POTATO_SERVER_MESSAGE);
    assert.equal(await readAccountFile(accountFile), null);
  } finally {
    await app.close();
    await blog.close();
  }
});

test('账号：probe 成功时回的是归一化后的地址（面板拿它提示"下次就填这个"）', async () => {
  const auth = await startFakeAuth();
  const { app, call } = await startApp();
  try {
    const bare = `${auth.origin.replace(/^http:\/\//, '')}/`; // 没协议 + 尾斜杠
    const response = await call('GET', `/account/probe?serverUrl=${encodeURIComponent(bare)}`);
    assert.equal(response.body.reachable, true);
    assert.equal(response.body.serverUrl, auth.origin);
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

test('账号：端口没人监听 -> 502 SERVER_UNREACHABLE（不是 500），本地不落盘', async () => {
  const auth = await startFakeAuth();
  const origin = auth.origin;
  // 先关掉服务器：端口随即无人监听（拿到端口再关，保证这个地址确实是"连不上"）
  await auth.close();

  const { app, call, accountFile } = await startApp();
  try {
    const response = await call('POST', '/account/login', { serverUrl: origin, username: 'alice', password: 'correct-horse-battery' });
    assert.equal(response.status, 502, '连不上是网关语义，不该是 500');
    assert.equal(response.body.error.code, 'SERVER_UNREACHABLE');
    assert.equal(response.body.error.message, UNREACHABLE_MESSAGE);
    // message 必须同时点出"地址与端口"和"对方在不在跑"，否则用户不知道该动哪里
    assert.match(response.body.error.message, /检查地址与端口/);
    assert.match(response.body.error.message, /确认对方在跑/);
    assert.equal(await readAccountFile(accountFile), null);
  } finally {
    await app.close();
  }
});

test('账号：地址写错（不是 URL）-> 400 BAD_SERVER_URL，不抛 500', async () => {
  const { app, call } = await startApp();
  try {
    const response = await call('POST', '/account/login', { serverUrl: 'http://[不是地址', username: 'alice', password: 'x' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAD_SERVER_URL');
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

test('账号：probe 在服务器不可达时 reachable:false（不抛错，也不报成"不是智学服务端"）', async () => {
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
    assert.equal(response.body.errorCode, 'SERVER_UNREACHABLE');
    assert.equal(response.body.error, UNREACHABLE_MESSAGE);
  } finally {
    await app.close();
  }
});

test('账号：probe 遇到回 404 的普通 HTTP 服务 -> NOT_POTATO_SERVER（与"连不上"分得清）', async () => {
  // 一个"能打开、但不是智学服务端"的 HTTP 服务：/auth/config 回 404 + HTML
  const otherSite = await startRawServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body>404 Not Found</body></html>');
  });
  const { app, call } = await startApp();
  try {
    const response = await call('GET', `/account/probe?serverUrl=${encodeURIComponent(otherSite.origin)}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.reachable, false);
    assert.equal(response.body.errorCode, 'NOT_POTATO_SERVER');
    assert.equal(response.body.error, NOT_POTATO_SERVER_MESSAGE);
  } finally {
    await app.close();
    await otherSite.close();
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

test('账号：错误码映射表覆盖契约里冻结的几种（外加三种"地址类"人话）', () => {
  assert.equal(ERROR_MESSAGES.BAD_CREDENTIALS, '用户名或密码不对');
  assert.equal(ERROR_MESSAGES.INVITE_INVALID, '邀请码无效或已被使用');
  assert.equal(ERROR_MESSAGES.USER_EXISTS, '这个用户名已经被注册了');
  assert.equal(ERROR_MESSAGES.RATE_LIMITED, '失败次数太多，请等 60 秒再试');
  // 三种"地址类"错误：面板只显示 message，所以这三句必须自己把真因说清楚
  assert.equal(UNREACHABLE_MESSAGE, '连不上这个服务器：检查地址与端口，确认对方在跑');
  assert.equal(NOT_POTATO_SERVER_MESSAGE, '这个地址能打开，但它不是「AI 智学」的服务端（缺少 /auth/config）');
  assert.throws(
    () => normalizeServerUrl('a b'),
    (error) => {
      assert.match(error.message, /^服务器地址看起来不对：/);
      assert.match(error.message, /示例：https:\/\/study\.xjtuwhy\.com/);
      return true;
    },
  );
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
  // placeholder 给的是公网示例，输入框下面还要有一句"哪种地址该写哪种协议"
  const serverInput = inputs.find((node) => node.value === 'http://localhost:8866');
  assert.equal(serverInput.placeholder, 'https://study.xjtuwhy.com', 'placeholder 要写成公网示例地址');
  assert.match(mount.textContent, /国内服务器请填 https:\/\//);
  assert.match(mount.textContent, /本机开发填 http:\/\/localhost:8866/);
});

test('账号：测试连接成功后显示后端归一化后的地址（用户下次照抄）', async () => {
  const { PCModules, El } = bootRenderer({
    state: {},
    api: async (url) => {
      if (url === '/account') return { ok: true, connected: false, serverUrl: 'http://localhost:8866', user: null, loginAt: null };
      if (String(url).startsWith('/account/probe')) {
        // 用户填 `study.xjtuwhy.com/`，后端补成 https 并去掉了尾斜杠
        return { ok: true, reachable: true, serverUrl: 'https://study.xjtuwhy.com', serverName: '智学公开服务端', version: '0.3.0', features: { lms: false } };
      }
      return { ok: true };
    },
  });
  const section = PCModules.settingsSections().find((item) => item.id === 'account.login');
  const mount = new El('div');
  section.render(mount);
  await new Promise((resolve) => setTimeout(resolve, 20));

  mount.querySelectorAll('button').find((node) => node.textContent === '测试连接').listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(mount.textContent, /地址已确认：https:\/\/study\.xjtuwhy\.com/);
});

test('账号：BAD_SERVER_URL 用人话显示（沿用既有错误样式）', async () => {
  const { PCModules, El } = bootRenderer({
    state: {},
    api: async (url) => {
      if (url === '/account') return { ok: true, connected: false, serverUrl: 'http://localhost:8866', user: null, loginAt: null };
      if (url === '/account/login') {
        const error = new Error('服务器地址看起来不对：中间不能有空格（示例：https://study.xjtuwhy.com）');
        error.status = 400;
        error.payload = { ok: false, error: { code: 'BAD_SERVER_URL', message: error.message } };
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
  const alert = mount.querySelectorAll('.acct-alert')[0];
  assert.ok(alert, '要用既有的错误块显示');
  assert.match(alert.textContent, /服务器地址不对/, '标题要说清是地址问题，而不是笼统的"没成功"');
  assert.match(alert.textContent, /示例：https:\/\/study\.xjtuwhy\.com/, 'message 里的示例要原样显示出来');
});

test('账号：测试连接说"不是智学服务端"时，面板原样显示后端那句人话', async () => {
  const { PCModules, El } = bootRenderer({
    state: {},
    api: async (url) => {
      if (url === '/account') return { ok: true, connected: false, serverUrl: 'http://localhost:8866', user: null, loginAt: null };
      if (String(url).startsWith('/account/probe')) {
        return {
          ok: true,
          reachable: false,
          serverUrl: 'https://example.com',
          errorCode: 'NOT_POTATO_SERVER',
          error: '这个地址能打开，但它不是「AI 智学」的服务端（缺少 /auth/config）',
        };
      }
      return { ok: true };
    },
  });
  const section = PCModules.settingsSections().find((item) => item.id === 'account.login');
  const mount = new El('div');
  section.render(mount);
  await new Promise((resolve) => setTimeout(resolve, 20));

  mount.querySelectorAll('button').find((node) => node.textContent === '测试连接').listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(mount.textContent, /不是「AI 智学」的服务端/);
  assert.match(mount.textContent, /缺少 \/auth\/config/);
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
      server: all.find((n) => n.type === 'text' && n.placeholder === 'https://study.xjtuwhy.com'),
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
