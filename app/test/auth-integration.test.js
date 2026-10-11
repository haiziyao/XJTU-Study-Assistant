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
