/**
 * 全局认证的 HTTP 端点测试。
 *
 * 关注**状态码与可操作性** —— 前端与 AI 都靠它们决定下一步：
 *   - 需要登录 → 401；
 *   - 参数不对 → 400；
 *   - 站点没注册 → 404（而不是含糊的 500）；
 *   - 验证码端点回的是**二进制图片**，不是 JSON。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { loadModules } from '../src/core/module/registry.js';
import { startMockSso } from './helpers/sso-mock.js';

const USER = '2024001';
const PASS = 'secret-pass';

/**
 * 起一套**只装配 auth 模块**的服务，再注册两个指向 SSO mock 的站点。
 *
 * 为什么只装 auth：这是 auth 的 HTTP 契约测试，不该被别的模块干扰。
 * 装配全部模块时，`lms` 也会注册一个站点（它已经接入共享认证），
 * 站点数、readyCount 这些断言就会跟着变 —— 那种耦合会让用例变脆。
 * 真实的全量装配另有一条冒烟用例覆盖（见文件末尾）。
 */
async function startApp({ mock, onlyAuth = true } = {}) {
  const server = mock ?? (await startMockSso());
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-auth-http-'));
  const modules = onlyAuth ? await loadModules({ only: ['auth'] }) : undefined;
  const app = await createServer({
    dataDir,
    ...(modules ? { modules } : {}),
    auth: { casOrigin: server.origin },
  });
  const info = await app.listen({ port: 0 });

  app.services.auth.registerSite({ id: 'a', label: '站点A', loginUrl: server.siteAUrl });
  app.services.auth.registerSite({ id: 'b', label: '站点B', loginUrl: server.siteBUrl });

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
    return { status: response.status, body: parsed, headers: response.headers };
  };
  /** 拿原始 Response —— 验证二进制/内容类型时用（`call` 会把 body 读成文本）。 */
  const raw = (method, route) => fetch(`${info.baseUrl}${route}`, { method });
  return { app, call, raw, info, mock: server, dataDir };
}

/* ------------------------------------------------------------------ 状态 */

test('auth HTTP：/auth/status 逐站点报告，未登录时 loggedIn=false', async () => {
  const { app, call, mock } = await startApp();
  try {
    const result = await call('GET', '/auth/status');
    assert.equal(result.status, 200);
    assert.equal(result.body.loggedIn, false);
    assert.equal(result.body.siteCount, 2);
    assert.deepEqual(
      result.body.sites.map((site) => site.id),
      ['a', 'b'],
    );
    assert.equal(result.body.sites[0].label, '站点A');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('auth HTTP：/auth/sites/:id 返回单站点状态；未注册的站点 404', async () => {
  const { app, call, mock } = await startApp();
  try {
    const ok = await call('GET', '/auth/sites/a');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.id, 'a');
    assert.equal(ok.body.ready, false);

    const missing = await call('GET', '/auth/sites/ghost');
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 登录 */

test('auth HTTP：登录缺字段返回 400 而不是 500', async () => {
  const { app, call, mock } = await startApp();
  try {
    const noUser = await call('POST', '/auth/login', { password: PASS });
    assert.equal(noUser.status, 400);
    assert.equal(noUser.body.error.code, 'BAD_REQUEST');

    const noPass = await call('POST', '/auth/login', { username: USER });
    assert.equal(noPass.status, 400);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('auth HTTP：★ 登录一次，两个站点都就绪（SSO 走完整 HTTP 栈）', async () => {
  const { app, call, mock } = await startApp();
  try {
    const login = await call('POST', '/auth/login', { username: USER, password: PASS });
    assert.equal(login.status, 200);
    assert.equal(login.body.status, 'ready');
    assert.equal(login.body.loggedIn, true);
    assert.equal(login.body.username, USER);
    assert.equal(login.body.readyCount, 2, '两个站点都应就绪');
    assert.ok(login.body.sso.some((entry) => entry.id === 'b' && entry.ok === true), 'sso 字段应报告 B 已就绪');
    assert.equal(mock.state.passwordLogins, 1, '密码只应使用一次');

    const status = await call('GET', '/auth/status');
    assert.equal(status.body.readyCount, 2);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('auth HTTP：账号密码错误时状态为 error，但仍返回 200（前端据此原地提示）', async () => {
  const { app, call, mock } = await startApp();
  try {
    const result = await call('POST', '/auth/login', { username: USER, password: 'wrong-password' });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'error');
    assert.ok(result.body.error);

    const status = await call('GET', '/auth/status');
    assert.equal(status.body.loggedIn, false);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('auth HTTP：可以指定只为某个站点登录', async () => {
  const { app, call, mock } = await startApp();
  try {
    const result = await call('POST', '/auth/sites/b/login', { username: USER, password: PASS });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'ready');
    assert.equal(mock.state.passwordLogins, 1);

    const sso = await call('POST', '/auth/sites/a/ensure', {});
    assert.equal(sso.status, 200);
    assert.equal(sso.body.ok, true, 'A 应能靠 SSO 就绪');
    assert.equal(mock.state.passwordLogins, 1, 'ensure 不该再要密码');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('auth HTTP：给未注册站点发登录请求返回 404', async () => {
  const { app, call, mock } = await startApp();
  try {
    const result = await call('POST', '/auth/sites/ghost/login', { username: USER, password: PASS });
    assert.equal(result.status, 404);
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ ensure */

test('auth HTTP：未登录时 ensure 返回 ok:false + needsLogin，而不是 401 抛错', async () => {
  const { app, call, mock } = await startApp();
  try {
    const result = await call('POST', '/auth/sites/a/ensure', {});
    assert.equal(result.status, 200, 'ensure 是"问答"而非"断言"，不该用错误码表达未登录');
    assert.equal(result.body.ok, false);
    assert.equal(result.body.needsLogin, true);
    assert.match(result.body.reason, /重新登录/);
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 退出 */

test('auth HTTP：退出后两个站点都不可用，且会话文件消失', async () => {
  const { app, call, mock, dataDir } = await startApp();
  try {
    await call('POST', '/auth/login', { username: USER, password: PASS });
    const logout = await call('POST', '/auth/logout', {});
    assert.equal(logout.status, 200);
    assert.equal(logout.body.loggedIn, false);
    assert.equal(logout.body.readyCount, 0);

    const ensure = await call('POST', '/auth/sites/a/ensure', {});
    assert.equal(ensure.body.ok, false);

    const fs = await import('node:fs/promises');
    await assert.rejects(() => fs.stat(path.join(dataDir, 'auth-session.json')));
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 验证码 */

test('auth HTTP：验证码端点回二进制图片，而不是被 JSON 包一层', async () => {
  const { app, raw, mock } = await startApp();
  try {
    const response = await raw('GET', '/auth/captcha');
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get('content-type')), /image\/png/, '必须是图片类型');
    const bytes = new Uint8Array(await response.arrayBuffer());
    // PNG 魔数：确认拿到的是原始字节，而不是被 JSON.stringify 过的文本
    assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], '应当是原始 PNG 字节');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('auth HTTP：没有注册任何站点时，验证码端点给出明确失败', async () => {
  const mock = await startMockSso();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-auth-nosite-'));
  // 只装 auth：否则 lms 会注册一个站点，这条用例就测不到"无站点"的分支了
  const modules = await loadModules({ only: ['auth'] });
  const app = await createServer({ dataDir, modules, auth: { casOrigin: mock.origin } });
  const info = await app.listen({ port: 0 });
  try {
    const response = await fetch(`${info.baseUrl}/auth/captcha`);
    assert.equal(response.status, 500, '没有站点时应当是明确的装配期错误，而不是静默 200');
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 与真实装配的集成 */

test('auth HTTP：★ 全量装配时 lms 与 academic 都注册了自己的站点，且 auth 排在最前', async () => {
  const mock = await startMockSso();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-auth-full-'));
  const app = await createServer({ dataDir, auth: { casOrigin: mock.origin } });
  const info = await app.listen({ port: 0 });
  try {
    const listed = await (await fetch(`${info.baseUrl}/modules`)).json();
    assert.equal(listed.items[0].id, 'auth', 'auth 必须排在所有业务模块之前');
    assert.equal(listed.items[0].order, 5);

    const status = app.services.auth.status();
    const ids = status.sites.map((site) => site.id);
    assert.ok(ids.includes('lms'), `lms 应当注册了自己的站点，实际：${ids.join(', ')}`);
    assert.ok(ids.includes('academic'), `academic 应当注册了自己的站点，实际：${ids.join(', ')}`);

    // 两个站点都带可读标签与各自的登录入口 —— 设置卡要逐站点显示
    for (const site of status.sites) {
      assert.ok(site.label, `站点 ${site.id} 应有标签`);
      assert.equal(site.ready, false, '尚未登录时都不该是就绪');
    }
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 模块自描述 */

test('auth HTTP：模块出现在 /modules 且 order 最小（要早于所有业务模块）', async () => {
  const { app, call, mock } = await startApp();
  try {
    const listed = await call('GET', '/modules');
    const items = listed.body.items;
    const authIndex = items.findIndex((item) => item.id === 'auth');
    assert.ok(authIndex >= 0, 'auth 应被装配');
    assert.equal(authIndex, 0, 'auth 必须是第一个（order 最小），否则业务模块拿不到 services.auth');
    assert.equal(items[0].order, 5);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('auth HTTP：aiTools 聚合进 /ai/capabilities', async () => {
  const { app, call, mock } = await startApp();
  try {
    const result = await call('GET', '/ai/capabilities');
    const mine = (result.body.aiTools ?? []).filter((tool) => tool.module === 'auth');
    assert.equal(mine.length, 2);
    assert.ok(mine.every((tool) => tool.implemented === true));
    assert.ok(mine.some((tool) => tool.name === 'auth_status'));
  } finally {
    await app.close();
    await mock.close();
  }
});
