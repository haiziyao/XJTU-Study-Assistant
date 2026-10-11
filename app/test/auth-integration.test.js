/**
 * 「在设置里登录 → 各模块的 status 立刻反映出来」的集成测试。
 *
 * 这是用户实测报出来的 bug：在设置页登录成功后，切到学堂/学业页却还显示未登录。
 * 根因是**登录态的真相在 auth 模块**，而 `lms.status()` / `academic.status()`
 * 返回的是自己缓存的 `state.status` —— 用户从设置页登录时，那两个模块的 state 不会自己变。
 *
 * 所以这里刻意**不直接调 auth**，而是走完整链路：
 *   起全套服务 → 用 auth 的登录端点（设置页走的就是它）→ 再读各模块的 status。
 * 谁把"投影"那一步删掉，这些用例立刻红。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { startMockEhall } from './helpers/ehall-mock.js';
import { startMockSso } from './helpers/sso-mock.js';

const USER = '2024001';
const PASS = 'secret-pass';

/**
 * 起一套**全套模块**的服务，把 lms 与 academic 指向同一个 SSO mock 的**不同站点**。
 *
 * 用不同站点很关键：这才是真实情形（学堂与教务是两个业务站点），
 * 也才真正在测 SSO —— 登录 A 站之后，B 站要靠 TGC 免密换票就绪。
 * 如果两个都指向同一个站点，测的就只是"cookie 还在"，SSO 那一步根本没走到。
 */
async function startFullApp() {
  const mock = await startMockSso();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-auth-integration-'));
  const app = await createServer({
    dataDir,
    auth: { casOrigin: mock.origin },
    lms: { config: { baseUrl: mock.siteAUrl, casOrigin: mock.origin } },
    academic: { config: { loginUrl: mock.siteBUrl, casOrigin: mock.origin } },
  });
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
  return { app, call, mock, dataDir };
}

/* ------------------------------------------------------------------ ★ 核心 */

test('★ 在设置页登录之后，学堂与学业的 status 立刻变成已登录', async () => {
  const { app, call, mock } = await startFullApp();
  try {
    // 登录前：两边都应当是未登录
    const beforeLms = await call('GET', '/lms/status');
    const beforeAcademic = await call('GET', '/academic/status');
    assert.notEqual(beforeLms.body.status, 'ready', '登录前学堂不该是 ready');
    assert.equal(beforeAcademic.body.loggedIn, false, '登录前学业不该是已登录');

    // 设置页那张卡走的就是这个端点
    const login = await call('POST', '/auth/login', { username: USER, password: PASS });
    assert.equal(login.body.status, 'ready');
    // ★ 教务是靠「同一个 CAS 源 + TGC 免密换票」就绪的，不是又输了一次密码
    assert.equal(mock.state.passwordLogins, 1, '★ 全程只应该用一次密码');
    assert.ok(mock.state.ssoTickets >= 1, '★ 教务应当是靠 TGC 换票就绪的');

    // ★ 关键：不碰 lms / academic 的任何登录接口，它们的 status 就该跟着变
    const afterLms = await call('GET', '/lms/status');
    const afterAcademic = await call('GET', '/academic/status');
    assert.equal(afterLms.body.status, 'ready', '★ 设置页登录后，学堂 status 应当立刻是 ready');
    assert.equal(afterAcademic.body.loggedIn, true, '★ 设置页登录后，学业 status 应当立刻是已登录');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('★ 在设置页退出之后，两个模块的 status 也立刻变回未登录', async () => {
  const { app, call, mock } = await startFullApp();
  try {
    await call('POST', '/auth/login', { username: USER, password: PASS });
    assert.equal((await call('GET', '/lms/status')).body.status, 'ready');

    await call('POST', '/auth/logout', {});
    const lms = await call('GET', '/lms/status');
    const academic = await call('GET', '/academic/status');
    assert.equal(lms.body.status, 'anonymous', '★ 退出后学堂不该还声称已登录');
    assert.equal(academic.body.loggedIn, false, '★ 退出后学业不该还声称已登录');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('登录进行中的状态（需要两步验证）不会被投影覆盖成未登录', async () => {
  const mock = await startMockSso({ needMfa: true, mfaCode: '654321' });
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-auth-mfa-'));
  const slice = { config: { baseUrl: mock.siteAUrl, loginUrl: mock.siteAUrl, casOrigin: mock.origin } };
  const app = await createServer({ dataDir, auth: { casOrigin: mock.origin }, lms: slice });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const first = await call('POST', '/auth/login', { username: USER, password: PASS, siteId: 'lms' });
    assert.equal(first.body.status, 'need_mfa');

    // 这一步很关键：status() 会被反复读，投影**不能**把 need_mfa 冲成 anonymous，
    // 否则界面会在用户输验证码的过程中退回"未登录"。
    const lms = await call('GET', '/lms/status');
    assert.equal(lms.body.status, 'need_mfa', '★ 等待两步验证时，学堂应保持 need_mfa');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('未登录时各模块的 status 不会被误报成 ready', async () => {
  const { app, call, mock } = await startFullApp();
  try {
    const lms = await call('GET', '/lms/status');
    const academic = await call('GET', '/academic/status');
    assert.notEqual(lms.body.status, 'ready');
    assert.equal(academic.body.loggedIn, false);
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ ★ 登录后自动同步 */

/** 轮询直到条件成立（自动同步是后端起意的，没有可 await 的句柄）。 */
async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test('★ 登录成功后学业会自动同步，不需要用户手点「同步成绩」', async () => {
  // 用 ehall-mock：它同时提供 CAS 与教务的 jwapp（含四步授权握手），
  // 所以能完整走一遍"登录 → 自动拉成绩"。
  const mock = await startMockEhall();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-auto-sync-'));
  const app = await createServer({ dataDir, auth: { casOrigin: mock.origin }, academic: mock.config() });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    // 登录前：一条成绩都没有
    const before = await call('GET', '/academic/status');
    assert.equal(before.body.grades.total, 0, '登录前不该有成绩');

    // 走设置页那条路径登录（同一个端点）
    const login = await call('POST', '/auth/login', { username: '2024001', password: 'secret-pass', siteId: 'academic' });
    assert.equal(login.body.status, 'ready');

    // ★ 全程**没有**调用 /academic/sync/preview 或 /apply —— 成绩应当自己出现。
    // 条件里带上 `!syncing`：成绩是先落库、后清标志的，只看条数会撞上"还没收尾"的瞬间。
    const synced = await waitFor(async () => {
      const now = await call('GET', '/academic/status');
      return (now.body.grades?.total ?? 0) > 0 && now.body.syncing === false;
    });
    const after = await call('GET', '/academic/status');
    assert.ok(
      synced,
      `★ 登录后应当自动同步出成绩，实际 ${after.body.grades?.total ?? 0} 条 / syncing=${after.body.syncing}`,
    );
    assert.ok(after.body.grades.active > 0, '应当有有效成绩');
    assert.equal(after.body.loggedIn, true);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('已经有成绩时不会重复自动同步（不白打扰学校服务器）', async () => {
  const mock = await startMockEhall();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-auto-sync-2-'));
  const app = await createServer({ dataDir, auth: { casOrigin: mock.origin }, academic: mock.config() });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    await call('POST', '/auth/login', { username: '2024001', password: 'secret-pass', siteId: 'academic' });
    await waitFor(async () => ((await call('GET', '/academic/status')).body.grades?.total ?? 0) > 0);

    // 记下成绩接口被访问的次数，然后**退出再登录**
    const before = mock.state.gradeCalls;
    await call('POST', '/auth/logout', {});
    await call('POST', '/auth/login', { username: '2024001', password: 'secret-pass', siteId: 'academic' });
    await new Promise((resolve) => setTimeout(resolve, 400));

    const status = await call('GET', '/academic/status');
    assert.ok((status.body.grades?.total ?? 0) > 0, '原有成绩应当还在');
    // 本地已有数据 → 不该再自动去拉。允许 +1 的余量以容忍实现细节差异，
    // 但绝不该像第一次那样真的重新拉一遍。
    const after = mock.state.gradeCalls;
    assert.ok(after - before <= 1, `本地已有成绩时不该重复自动同步（拉取次数 +${after - before}）`);
  } finally {
    await app.close();
    await mock.close();
  }
});
