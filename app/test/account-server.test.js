/**
 * 「更改服务器地址」的测试（`POST /account/server` 与设置页里那一段）。
 *
 * **零真实外网**：所有上游请求打到本文件用 `node:http` 起的假服务器上，
 * 它只复刻本功能依赖的三个端点：
 *   - `GET  /auth/config`    —— 探测"这是不是本程序的服务端"（必须有 serverName）；
 *   - `GET  /api/v1/health`  —— 用旧令牌问新服务器"认不认这个会话"；
 *   - `POST /auth/login`     —— 只在需要真实登录态时用（多数用例直接写 account.json）。
 *
 * 覆盖的每条都是容易做错的判断：
 *   - **先探测再切换**：地址不是本程序时，一个字段都不许改（否则用户会被带去陌生地址）；
 *   - **令牌有效就保留**：同一套部署换域名（真机 `study.xjtuwhy.com` → `studywhy.3q.hair`）
 *     不该逼用户重输密码 —— 本程序本来就不存密码；
 *   - **令牌无效必须清掉**：否则界面显示"已登录"、每个请求都 401；
 *   - **验证失败（连不上 / 5xx）不改任何东西**：判断不了令牌好坏时，留在原来能用的服务器；
 *   - 渲染层真的有「更改服务器」入口与行内输入框。
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
  NOT_POTATO_SERVER_MESSAGE,
  SESSION_COOKIE,
  SWITCH_PROBE_TIMEOUT_MS,
  UNREACHABLE_MESSAGE,
  normalizeServerUrl,
} from '../src/modules/account/service.js';
import { bootRenderer } from './helpers/renderer-dom.js';

/** 旧服务器上的登录令牌（只有真令牌才能让新服务器回 200）。 */
const TOKEN = 'tok_switch_9d2c4a7e1f60';

/** 假服务器认定的用户。 */
const USER = { id: 'u-alice', username: 'alice', role: 'admin' };

/**
 * 起一个假「智学服务端」。
 *
 * @param {object} [options]
 * @param {string} [options.serverName] `/auth/config` 回的服务名；传 `null` 表示**没有**服务名
 * @param {boolean} [options.configHtml] `/auth/config` 回一段 HTML（"能打开但不是本程序"）
 * @param {number} [options.healthStatus] `/api/v1/health` 回的状态码（默认 200）
 * @param {string} [options.token] 健康检查认的令牌（默认 TOKEN）
 */
async function startFakeServer({ serverName = '智学公开服务端', configHtml = false, healthStatus = 200, token = TOKEN } = {}) {
  const state = { requests: [] };

  const sendJson = (res, status, payload, headers = {}) => {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    state.requests.push({ method: req.method, url: req.url, headers: req.headers, raw });
    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/auth/config') {
      if (configHtml) {
        const html = '<!doctype html><html><body>某个站点首页</body></html>';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
        res.end(html);
        return;
      }
      return sendJson(res, 200, {
        ...(serverName === null ? {} : { serverName }),
        version: '0.3.0',
        registration: 'invite',
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/v1/health') {
      const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (bearer !== token) {
        return sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: '需要先登录' } });
      }
      if (healthStatus !== 200) {
        return sendJson(res, healthStatus, { ok: false, error: { code: 'INTERNAL', message: '服务器内部错误' } });
      }
      return sendJson(res, 200, { ok: true, serverName: '智学公开服务端', time: new Date().toISOString() });
    }

    if (req.method === 'POST' && url.pathname === '/auth/login') {
      const body = raw ? JSON.parse(raw) : {};
      if (body.username !== 'alice' || body.password !== 'correct-horse-battery') {
        return sendJson(res, 401, { ok: false, error: { code: 'BAD_CREDENTIALS', message: '用户名或密码不对' } });
      }
      return sendJson(res, 200, { ok: true, user: USER }, {
        'Set-Cookie': `${SESSION_COOKIE}=${TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
      });
    }

    return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `未实现 ${req.method} ${url.pathname}` } });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 起一套桌面端后端，返回 `call(method, route, body)`。 */
async function startApp(dataDir) {
  // 只装 account：这是账号模块的 HTTP 契约测试，不该被 transfer 的 8886 等无关端口干扰
  const app = await createServer({ dataDir, onlyModules: ['account'] });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, call, accountFile: path.join(dataDir, 'account.json') };
}

/** 直接写一份 account.json（比先起一台旧服务器再登录快，语义完全一样：本地已有 token）。 */
async function seedAccount(dataDir, { serverUrl, token = TOKEN } = {}) {
  await writeFile(
    path.join(dataDir, 'account.json'),
    `${JSON.stringify({ serverUrl, token, user: USER, loginAt: '2026-10-20T02:00:00.000Z' }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

/** 读凭据文件；不存在时回 null。 */
async function readAccountFile(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** 轮询等待条件成立（渲染层是异步重画的，固定 sleep 在慢机器上会假红）。 */
async function waitFor(predicate, { timeoutMs = 2000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}

/* ================================================================ 归一化 */

test('更改服务器：不带协议的域名补 https（studywhy.3q.hair -> https://studywhy.3q.hair）', () => {
  // 真机上用户就是从浏览器地址栏复制一个域名过来。补成 http 会先挨一次 301，
  // 而 301 会把 POST 改写成 GET（见 service.js 顶部注释）—— 所以这一步必须补 https。
  assert.equal(normalizeServerUrl('studywhy.3q.hair'), 'https://studywhy.3q.hair');
  assert.equal(normalizeServerUrl('  studywhy.3q.hair/  '), 'https://studywhy.3q.hair');
  // 本机/回环仍然补 http（本地开发服务器没有证书），与既有归一化口径一致
  assert.equal(normalizeServerUrl('localhost:8866'), 'http://localhost:8866');
  // 8 秒探测超时是契约的一部分：界面上的「正在验证…」不该无限转
  assert.equal(SWITCH_PROBE_TIMEOUT_MS, 8_000);
});

/* ================================================================ 成功：保留登录态 */

test('更改服务器：新服务器认令牌 -> 切换地址且保留 token（keptSession:true）', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-switch-kept-'));
  const oldServer = 'https://old.example.com';
  await seedAccount(dataDir, { serverUrl: oldServer });
  const next = await startFakeServer();
  const { app, call, accountFile } = await startApp(dataDir);
  try {
    // 用户只写 host:port（不带协议）：既验证归一化，又验证真实 HTTP 全链路
    const bare = next.origin.replace(/^http:\/\//, '');
    const response = await call('POST', '/account/server', { serverUrl: bare });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.switched, true);
    assert.equal(response.body.keptSession, true);
    assert.equal(response.body.serverUrl, next.origin, '回给面板的是归一化（含跳转）之后的地址');
    assert.equal(response.body.user.username, 'alice');
    assert.equal(JSON.stringify(response.body).includes(TOKEN), false, '响应里绝不能出现令牌明文');

    // 顺序很重要：先探测 /auth/config，确认是本程序后才用令牌问 /api/v1/health
    assert.deepEqual(
      next.state.requests.map((item) => `${item.method} ${item.url}`),
      ['GET /auth/config', 'GET /api/v1/health'],
    );
    const health = next.state.requests[1];
    assert.equal(health.headers.authorization, `Bearer ${TOKEN}`, '健康检查必须带 Authorization: Bearer <旧令牌>');
    assert.equal(health.headers['x-potato-token'], TOKEN);

    // 落盘：地址变了、令牌与用户没变
    const saved = await readAccountFile(accountFile);
    assert.equal(saved.serverUrl, next.origin);
    assert.equal(saved.token, TOKEN, '令牌有效时必须保留，不该逼用户重新登录');
    assert.equal(saved.user.username, 'alice');
    // Windows 的 stat().mode 只反映只读位（README「已知限制」）
    if (process.platform !== 'win32') assert.equal((await stat(accountFile)).mode & 0o777, 0o600);

    // 面板随后读到的是新地址、仍然是已登录
    const status = await call('GET', '/account');
    assert.equal(status.body.connected, true);
    assert.equal(status.body.serverUrl, next.origin);
    assert.equal(JSON.stringify(status.body).includes(TOKEN), false);
  } finally {
    await app.close();
    await next.close();
  }
});

/* ================================================================ 广播 */

test('更改服务器：成功后广播 data_changed{module:account}（其它窗口据此刷新）', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-switch-broadcast-'));
  await seedAccount(dataDir, { serverUrl: 'https://old.example.com' });
  const next = await startFakeServer();
  const messages = [];
  const service = new AccountService({ dataDir, broadcast: (message) => messages.push(message) });
  await service.load();
  try {
    const result = await service.switchServer({ serverUrl: next.origin });
    assert.equal(result.keptSession, true);
    assert.equal(messages.length, 1, '切换成功必须广播一次（不多不少）');
    assert.equal(messages[0].type, 'data_changed');
    assert.equal(messages[0].module, 'account', '外壳按 module 判断要不刷新设置页');
    assert.equal(messages[0].payload.action, 'server');
    assert.equal(messages[0].payload.serverUrl, next.origin);
    assert.equal(messages[0].payload.keptSession, true);
  } finally {
    await next.close();
  }
});

/* ================================================================ 需要重登 */

test('更改服务器：新服务器回 401 -> 切换地址但清掉 token（requiresLogin:true）', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-switch-401-'));
  await seedAccount(dataDir, { serverUrl: 'https://old.example.com' });
  // 新服务器不认这个令牌：健康检查回 401
  const next = await startFakeServer({ token: 'tok_a_different_session' });
  const { app, call, accountFile } = await startApp(dataDir);
  try {
    const response = await call('POST', '/account/server', { serverUrl: next.origin });
    assert.equal(response.status, 200, '地址切过去了，只是需要重新登录 —— 这不是失败');
    assert.equal(response.body.ok, true);
    assert.equal(response.body.switched, true);
    assert.equal(response.body.keptSession, false);
    assert.equal(response.body.requiresLogin, true);
    assert.equal(response.body.serverUrl, next.origin);

    const health = next.state.requests.find((item) => item.url === '/api/v1/health');
    assert.equal(health.headers.authorization, `Bearer ${TOKEN}`, '确实拿旧令牌去问过新服务器');

    // token 从文件里消失；地址还在（下次登录要预填它）
    const saved = await readAccountFile(accountFile);
    assert.equal(saved.serverUrl, next.origin);
    assert.equal('token' in saved, false, '新服务器不认的令牌必须清掉');
    assert.equal(saved.token, undefined);
    assert.equal(JSON.stringify(saved).includes(TOKEN), false);

    // 后端状态已经是"未登录"，但地址是新的 —— 渲染层据此预填登录表单
    const status = await call('GET', '/account');
    assert.equal(status.body.connected, false);
    assert.equal(status.body.serverUrl, next.origin, '未登录也要记住新地址，登录表单才能预填');
    assert.equal(status.body.user, null);
  } finally {
    await app.close();
    await next.close();
  }
});

test('更改服务器：重启后仍记得"需要重登"的那个地址（token 没了，地址不能丢）', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-switch-reboot-'));
  await seedAccount(dataDir, { serverUrl: 'https://old.example.com' });
  const next = await startFakeServer({ token: 'tok_a_different_session' });
  const first = await startApp(dataDir);
  try {
    await first.call('POST', '/account/server', { serverUrl: next.origin });
    await first.app.close();

    const second = await createServer({ dataDir, onlyModules: ['account'] });
    const info = await second.listen({ port: 0 });
    try {
      const response = await fetch(`${info.baseUrl}/account`);
      const payload = await response.json();
      assert.equal(payload.connected, false);
      assert.equal(payload.serverUrl, next.origin, '登录表单的预填地址要能跨重启保留');
    } finally {
      await second.close();
    }
  } finally {
    await first.app.close().catch(() => {});
    await next.close();
  }
});

/* ================================================================ 非本程序 */

test('更改服务器：/auth/config 没有 serverName -> NOT_POTATO_SERVER，原地址与令牌都不变', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-switch-notpotato-'));
  const oldServer = 'https://old.example.com';
  await seedAccount(dataDir, { serverUrl: oldServer });

  // 两种"能打开但不是本程序"的形态：JSON 里没有服务名、以及干脆回 HTML
  for (const options of [{ serverName: null }, { configHtml: true }]) {
    const other = await startFakeServer(options);
    const { app, call, accountFile } = await startApp(dataDir);
    try {
      const response = await call('POST', '/account/server', { serverUrl: other.origin });
      assert.equal(response.status, 502);
      assert.equal(response.body.ok, false);
      assert.equal(response.body.error.code, 'NOT_POTATO_SERVER');
      assert.equal(response.body.error.message, NOT_POTATO_SERVER_MESSAGE);

      // 一个字段都没改：用户还在原来那台服务器上
      const saved = await readAccountFile(accountFile);
      assert.equal(saved.serverUrl, oldServer);
      assert.equal(saved.token, TOKEN);
      // 探测失败就不该再用令牌去碰对面：连 health 请求都不发
      assert.equal(other.state.requests.some((item) => item.url === '/api/v1/health'), false);
      assert.equal(other.state.requests.every((item) => item.url === '/auth/config'), true);
    } finally {
      await app.close();
      await other.close();
    }
  }
});

/* ================================================================ 不可达 */

test('更改服务器：地址连不上 -> SERVER_UNREACHABLE，原地址与令牌都不变', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-switch-offline-'));
  const oldServer = 'https://old.example.com';
  await seedAccount(dataDir, { serverUrl: oldServer });

  // 先拿到一个端口再关掉：这个地址确实"没人监听"，而不是 DNS 解析失败
  const dead = await startFakeServer();
  const deadOrigin = dead.origin;
  await dead.close();

  const { app, call, accountFile } = await startApp(dataDir);
  try {
    const response = await call('POST', '/account/server', { serverUrl: deadOrigin });
    assert.equal(response.status, 502, '连不上是网关语义，不该是 500');
    assert.equal(response.body.error.code, 'SERVER_UNREACHABLE');
    assert.equal(response.body.error.message, UNREACHABLE_MESSAGE);
    assert.match(response.body.error.message, /检查地址与端口/);

    const saved = await readAccountFile(accountFile);
    assert.equal(saved.serverUrl, oldServer);
    assert.equal(saved.token, TOKEN);
  } finally {
    await app.close();
  }
});

test('更改服务器：探测通过但健康检查 5xx -> SERVER_UNREACHABLE，仍不改任何东西', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-switch-5xx-'));
  const oldServer = 'https://old.example.com';
  await seedAccount(dataDir, { serverUrl: oldServer });
  const next = await startFakeServer({ healthStatus: 503 });
  const { app, call, accountFile } = await startApp(dataDir);
  try {
    const response = await call('POST', '/account/server', { serverUrl: next.origin });
    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, 'SERVER_UNREACHABLE');
    assert.equal(response.body.error.message, UNREACHABLE_MESSAGE);

    // 5xx 说明"这次验证本身没成功"，不能据此判断令牌好坏 —— 原样留着
    const saved = await readAccountFile(accountFile);
    assert.equal(saved.serverUrl, oldServer);
    assert.equal(saved.token, TOKEN);
  } finally {
    await app.close();
    await next.close();
  }
});

test('更改服务器：空地址 -> 400 BAD_SERVER_URL，不发任何请求', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-switch-empty-'));
  await seedAccount(dataDir, { serverUrl: 'https://old.example.com' });
  const { app, call, accountFile } = await startApp(dataDir);
  try {
    const response = await call('POST', '/account/server', { serverUrl: '   ' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'BAD_SERVER_URL');
    assert.match(response.body.error.message, /服务器地址看起来不对/);

    const saved = await readAccountFile(accountFile);
    assert.equal(saved.serverUrl, 'https://old.example.com');
    assert.equal(saved.token, TOKEN);
  } finally {
    await app.close();
  }
});

/* ================================================================ 渲染层 */

test('更改服务器：渲染层源码里存在「更改服务器」入口与行内输入框', async () => {
  // 源码级断言：这类"入口有没有做出来"最容易在重构时被整段删掉而不被行为测试发现
  // （卸载了设置区块后，所有行为测试都看不到它）。先钉住入口本身。
  const source = await readFile(new URL('../src/renderer/views/account.js', import.meta.url), 'utf8');
  assert.match(source, /更改服务器/, '缺少「更改服务器」入口');
  assert.match(source, /\/account\/server/, '缺少对 POST /account/server 的调用');
  assert.match(source, /acct-input/, '缺少行内输入框');
  assert.match(source, /正在验证/, '保存过程中要显示「正在验证…」');
  assert.match(source, /已切换到/, '成功后的 toast 文案');
});

test('更改服务器：已登录面板点「更改」出现输入框，保存后提示登录态有效', async () => {
  let connected = true;
  const toasts = [];
  const bodies = [];
  const nextUrl = 'https://studywhy.3q.hair';
  const { PCModules, PC, El } = bootRenderer({
    state: {},
    api: async (url, options = {}) => {
      if (url === '/account') {
        return {
          ok: true,
          connected,
          serverUrl: connected ? 'https://study.xjtuwhy.com' : nextUrl,
          user: connected ? USER : null,
          loginAt: connected ? '2026-10-20T02:00:00.000Z' : null,
        };
      }
      if (url === '/account/server') {
        bodies.push(options.body);
        return { ok: true, serverUrl: nextUrl, switched: true, keptSession: true, user: USER };
      }
      return { ok: true };
    },
  });
  PC.toast = (text) => toasts.push(text);

  const section = PCModules.settingsSections().find((item) => item.id === 'account.login');
  const mount = new El('div');
  section.render(mount);
  await waitFor(() => /已登录：alice/.test(mount.textContent));

  const edit = mount.querySelectorAll('button').find((node) => node.textContent === '更改');
  assert.ok(edit, `已登录面板要有「更改」按钮，实际：${mount.querySelectorAll('button').map((b) => b.textContent).join(', ')}`);
  edit.listeners.click[0]();

  // 展开后：输入框默认填当前地址，保存/取消都在
  const addressInput = mount.querySelectorAll('input').find((node) => node.className.includes('acct-input'));
  assert.ok(addressInput, '「更改」展开后要有服务器地址输入框');
  assert.equal(addressInput.value, 'https://study.xjtuwhy.com', '输入框默认填当前地址');
  const labels = mount.querySelectorAll('button').map((node) => node.textContent);
  assert.ok(labels.includes('保存') && labels.includes('取消'), `要有保存/取消，实际：${labels.join(', ')}`);

  addressInput.value = 'studywhy.3q.hair';
  mount.querySelectorAll('button').find((node) => node.textContent === '保存').listeners.click[0]();
  // 保存中：按钮禁用并显示「正在验证…」（请求回来前先重画一次，见 run()）
  assert.ok(mount.querySelectorAll('button').some((node) => node.textContent === '正在验证…'), '保存过程中要显示「正在验证…」');

  await waitFor(() => toasts.length > 0);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].serverUrl, 'studywhy.3q.hair', '输入原样交给后端归一化，前端不自己补协议');
  assert.equal(toasts[0], '已切换到 studywhy.3q.hair（登录态有效）');
});

test('更改服务器：新服务器要求重登时，登录表单预填新地址并提示重新登录', async () => {
  let connected = true;
  const toasts = [];
  const nextUrl = 'https://studywhy.3q.hair';
  const { PCModules, PC, El } = bootRenderer({
    state: {},
    api: async (url) => {
      if (url === '/account') {
        return {
          ok: true,
          connected,
          serverUrl: connected ? 'https://study.xjtuwhy.com' : nextUrl,
          user: connected ? USER : null,
          loginAt: connected ? '2026-10-20T02:00:00.000Z' : null,
        };
      }
      if (url === '/account/server') {
        connected = false; // 后端清掉了 token
        return { ok: true, serverUrl: nextUrl, switched: true, keptSession: false, requiresLogin: true };
      }
      return { ok: true };
    },
  });
  PC.toast = (text) => toasts.push(text);

  const section = PCModules.settingsSections().find((item) => item.id === 'account.login');
  const mount = new El('div');
  section.render(mount);
  await waitFor(() => /已登录：alice/.test(mount.textContent));

  mount.querySelectorAll('button').find((node) => node.textContent === '更改').listeners.click[0]();
  const addressInput = mount.querySelectorAll('input').find((node) => node.className.includes('acct-input'));
  addressInput.value = nextUrl;
  mount.querySelectorAll('button').find((node) => node.textContent === '保存').listeners.click[0]();

  await waitFor(() => toasts.length > 0);
  assert.equal(toasts[0], '已切换到 studywhy.3q.hair，请重新登录');
  await waitFor(() => mount.querySelectorAll('input').some((node) => node.value === nextUrl));
  const prefill = mount.querySelectorAll('input').find((node) => node.value === nextUrl);
  assert.ok(prefill, '登录表单的服务器地址要预填为新地址');
  assert.equal(prefill.type, 'text');
  assert.match(mount.textContent, /服务器地址/);
});

test('更改服务器：失败时原样显示后端 message，且不清空输入', async () => {
  const toasts = [];
  const { PCModules, PC, El } = bootRenderer({
    state: {},
    api: async (url) => {
      if (url === '/account') {
        return { ok: true, connected: true, serverUrl: 'https://study.xjtuwhy.com', user: USER, loginAt: '2026-10-20T02:00:00.000Z' };
      }
      if (url === '/account/server') {
        const error = new Error('这个地址能打开，但它不是「AI 智学」的服务端（缺少 /auth/config）');
        error.status = 502;
        error.payload = { ok: false, error: { code: 'NOT_POTATO_SERVER', message: error.message } };
        throw error;
      }
      return { ok: true };
    },
  });
  PC.toast = (text) => toasts.push(text);

  const section = PCModules.settingsSections().find((item) => item.id === 'account.login');
  const mount = new El('div');
  section.render(mount);
  await waitFor(() => /已登录：alice/.test(mount.textContent));

  mount.querySelectorAll('button').find((node) => node.textContent === '更改').listeners.click[0]();
  const addressInput = mount.querySelectorAll('input').find((node) => node.className.includes('acct-input'));
  addressInput.value = 'https://example.com';
  mount.querySelectorAll('button').find((node) => node.textContent === '保存').listeners.click[0]();

  await waitFor(() => /不是「AI 智学」的服务端/.test(mount.textContent));
  assert.match(mount.textContent, /缺少 \/auth\/config/, '后端的中文 message 要原样显示');
  const stillThere = mount.querySelectorAll('input').find((node) => node.value === 'https://example.com');
  assert.ok(stillThere, '失败后不能把用户刚输入的地址清空');
  assert.equal(toasts.length, 0, '失败不弹成功 toast');
});
