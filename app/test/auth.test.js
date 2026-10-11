/**
 * 全局统一身份认证的测试。
 *
 * 用 `test/helpers/sso-mock.js`：一个 CAS + 两个业务站点，**真实实现**了 SSO 的换票流程
 * （TGC → 免密 ticket → 站点会话）。所以这里的断言不是"看起来对"，
 * 而是"机制真的成立了"：
 *
 *   - 登录站点 A 之后，站点 B 不需要第二次密码 —— 用 `passwordLogins === 1` 与
 *     `ssoTickets >= 1` 两个计数器同时钉住；
 *   - 把共享罐拆成两个，这些用例会立刻红。
 *
 * 另一条线索是**降级路径**：`siteBRequiresPassword` 模拟"SSO 对该站点不生效"，
 * 此时 ensure 应当明确说"需要登录"，而不是假装成功或直接抛异常。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AUTH_STATUS } from '../src/modules/lms/cas-auth.js';
import { JsonFile } from '../src/modules/lms/secret-store.js';
import { AuthService } from '../src/modules/auth/service.js';
import { AuthError } from '../src/modules/auth/config.js';
import { startMockSso } from './helpers/sso-mock.js';

const USER = '2024001';
const PASS = 'secret-pass';

/** 起一个指向 mock 的 AuthService，并注册两个站点。 */
async function makeAuth({ mock, dataDir, register = true } = {}) {
  const dir = dataDir ?? (await mkdtemp(path.join(tmpdir(), 'potato-auth-')));
  const auth = new AuthService({ dataDir: dir, config: { casOrigin: mock.origin } });
  if (register) {
    auth.registerSite({ id: 'a', label: '站点A', loginUrl: mock.siteAUrl });
    auth.registerSite({ id: 'b', label: '站点B', loginUrl: mock.siteBUrl });
  }
  return { auth, dataDir: dir };
}

/* ------------------------------------------------------------------ 站点注册与状态 */

test('auth：注册站点后的初始状态是「未登录」，且逐站点可见', async () => {
  const mock = await startMockSso();
  const { auth } = await makeAuth({ mock });
  try {
    const status = auth.status();
    assert.equal(status.loggedIn, false);
    assert.equal(status.siteCount, 2);
    assert.equal(status.readyCount, 0);
    assert.deepEqual(
      status.sites.map((site) => site.id),
      ['a', 'b'],
    );
    assert.equal(status.sites[0].label, '站点A');
    assert.equal(status.sites[0].ready, false);
    assert.equal(auth.hasSite('a'), true);
    assert.equal(auth.hasSite('nope'), false);
  } finally {
    await mock.close();
  }
});

test('auth：重复注册同一站点是幂等的（模块可能被重复装配）', async () => {
  const mock = await startMockSso();
  const { auth } = await makeAuth({ mock });
  try {
    const first = auth.registerSite({ id: 'a', label: '换个名字', loginUrl: 'https://example.invalid/' });
    assert.equal(first.label, '站点A', '应返回既有站点，不覆盖');
    assert.equal(auth.status().siteCount, 2);
  } finally {
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 未登录时的 ensure */

test('auth：未登录时 ensure 明确返回「需要登录」，不抛异常', async () => {
  const mock = await startMockSso();
  const { auth } = await makeAuth({ mock });
  try {
    const outcome = await auth.ensure('a');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.needsLogin, true);
    assert.match(outcome.reason, /票据已过期|重新登录/);
    assert.equal(auth.status().readyCount, 0);
  } finally {
    await mock.close();
  }
});

test('auth：ensure 未注册的站点时给出可读原因，而不是崩', async () => {
  const mock = await startMockSso();
  const { auth } = await makeAuth({ mock });
  try {
    const outcome = await auth.ensure('ghost');
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /未注册/);
  } finally {
    await mock.close();
  }
});

/* ------------------------------------------------------------------ ★ SSO 核心 */

test('auth：★ 登录站点 A 之后，站点 B 无需第二次密码（SSO 成立）', async () => {
  const mock = await startMockSso();
  const { auth, dataDir } = await makeAuth({ mock });
  try {
    // 先把 A 的登录页打开（真实流程里是 ensure 触发的）
    await auth.ensure('a');

    const result = await auth.login({ username: USER, password: PASS, siteId: 'a' });
    assert.equal(result.status, 'ready');
    assert.equal(result.username, USER);

    // 两个站点都可用
    assert.equal(auth.siteStatus('a').ready, true);
    assert.equal(auth.siteStatus('b').ready, true, '★ 站点 B 应当靠 SSO 自动就绪');

    // 密码只输了一次，且 B 是靠 TGC 换票进来的
    assert.equal(mock.state.passwordLogins, 1, '★ 密码只应该用一次');
    assert.ok(mock.state.ssoTickets >= 1, '★ 站点 B 应当是通过 TGC 免密换票就绪的');

    // 会话落盘了
    const saved = JSON.parse(await readFile(path.join(dataDir, 'auth-session.json'), 'utf8'));
    assert.ok(saved.cookies.some((cookie) => cookie.name === 'TGC'), '共享罐里应有 TGC');
    assert.ok(saved.sites.a?.lastOkAt, '应记录站点 A 就绪时间');
    assert.ok(saved.sites.b?.lastOkAt, '应记录站点 B 就绪时间');
  } finally {
    await mock.close();
  }
});

test('auth：★ 反向也成立 —— 登录站点 B 后站点 A 自动就绪', async () => {
  const mock = await startMockSso();
  const { auth } = await makeAuth({ mock });
  try {
    await auth.login({ username: USER, password: PASS, siteId: 'b' });
    assert.equal(auth.siteStatus('b').ready, true);
    assert.equal(auth.siteStatus('a').ready, true, '★ 站点 A 应当靠 SSO 自动就绪');
    assert.equal(mock.state.passwordLogins, 1);
    const again = await auth.ensure('a');
    assert.equal(again.ok, true);
    assert.equal(mock.state.passwordLogins, 1, 'SSO 之后不该再触发密码登录');
  } finally {
    await mock.close();
  }
});

test('auth：login 不带 siteId 时用第一个注册的站点做入口', async () => {
  const mock = await startMockSso();
  const { auth } = await makeAuth({ mock });
  try {
    const result = await auth.login({ username: USER, password: PASS });
    assert.equal(result.status, 'ready');
    assert.equal(auth.siteStatus('a').ready, true);
    assert.equal(auth.siteStatus('b').ready, true);
  } finally {
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 降级路径 */

test('auth：SSO 对某站点不生效时，明确说「需要登录」并可单独为它登录', async () => {
  const mock = await startMockSso({ siteBRequiresPassword: true });
  const { auth } = await makeAuth({ mock });
  try {
    const result = await auth.login({ username: USER, password: PASS, siteId: 'a' });
    assert.equal(auth.siteStatus('a').ready, true);
    assert.equal(auth.siteStatus('b').ready, false, 'B 不接受 SSO，不该被标成就绪');
    assert.ok(result.sso.some((entry) => entry.id === 'b' && entry.ok === false), 'sso 结果里应如实报告 B 未就绪');

    // 兜底：单独为 B 登录一次（还是同一份账号密码）
    const direct = await auth.login({ username: USER, password: PASS, siteId: 'b' });
    assert.equal(direct.status, 'ready');
    assert.equal(auth.siteStatus('b').ready, true);
    assert.equal(mock.state.passwordLogins, 2, '这一次确实用了一次密码 —— 这正是降级路径的代价');
  } finally {
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 失效与重验 */

test('auth：invalidate 之后下一次 ensure 会重新验证（能救回来就静默救回）', async () => {
  const mock = await startMockSso();
  const { auth } = await makeAuth({ mock });
  try {
    await auth.login({ username: USER, password: PASS, siteId: 'a' });
    assert.equal(auth.siteStatus('b').ready, true);

    // 模拟模块发现业务请求 401，把 B 打回待验证
    auth.invalidate('b', '业务接口返回 401');
    assert.equal(auth.siteStatus('b').ready, false);
    assert.equal(auth.siteStatus('b').reason, '业务接口返回 401');

    // 再 ensure：TGC 还在，应当静默恢复
    const outcome = await auth.ensure('b');
    assert.equal(outcome.ok, true);
    assert.equal(mock.state.passwordLogins, 1, '恢复过程不该再要密码');
  } finally {
    await mock.close();
  }
});

test('auth：登录成功后 ensure 命中乐观缓存，不再往返一次', async () => {
  const mock = await startMockSso();
  const { auth } = await makeAuth({ mock });
  try {
    await auth.login({ username: USER, password: PASS, siteId: 'a' });
    const before = mock.state.requests.length;
    const outcome = await auth.ensure('a');
    assert.equal(outcome.ok, true);
    assert.equal(mock.state.requests.length, before, '乐观可用时 ensure 不该产生请求');
  } finally {
    await mock.close();
  }
});

test('auth：同一站点的并发 ensure 只验证一次', async () => {
  const mock = await startMockSso();
  const { auth } = await makeAuth({ mock });
  try {
    const before = mock.state.requests.length;
    const [r1, r2, r3] = await Promise.all([auth.ensure('a'), auth.ensure('a'), auth.ensure('a')]);
    assert.equal(r1.ok, false);
    assert.equal(r2.ok, false);
    assert.equal(r3.ok, false);
    const used = mock.state.requests.length - before;
    assert.ok(used <= 2, `并发的三次 ensure 不该各走一遍（实际产生 ${used} 次请求）`);
  } finally {
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 退出 */

test('auth：退出会清空共享罐、重置全部站点并删掉会话文件', async () => {
  const mock = await startMockSso();
  const { auth, dataDir } = await makeAuth({ mock });
  try {
    await auth.login({ username: USER, password: PASS, siteId: 'a' });
    const sessionPath = path.join(dataDir, 'auth-session.json');
    assert.equal(await exists(sessionPath), true);

    const status = await auth.logout();
    assert.equal(status.loggedIn, false);
    assert.equal(status.readyCount, 0);
    assert.equal(auth.jar.toJSON().length, 0, '共享罐应被清空');
    assert.equal(await exists(sessionPath), false, '会话文件应被删除');

    const outcome = await auth.ensure('a');
    assert.equal(outcome.ok, false);
    assert.equal(mock.state.passwordLogins, 1, '退出不影响已发生的登录次数计数');
  } finally {
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 订阅 */

test('auth：登录与退出都会通知订阅者', async () => {
  const mock = await startMockSso();
  const { auth } = await makeAuth({ mock });
  const events = [];
  const off = auth.onChange((event) => events.push(event.type));
  try {
    await auth.login({ username: USER, password: PASS, siteId: 'a' });
    await auth.logout();
    assert.ok(events.includes('login'), '应收到 login');
    assert.ok(events.includes('logout'), '应收到 logout');

    off();
    await auth.login({ username: USER, password: PASS, siteId: 'a' });
    const after = events.length;
    await auth.logout();
    assert.equal(events.length, after, '取消订阅后不该再收到通知');
  } finally {
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 参数校验 */

test('auth：缺少账号或密码时抛 NEED_CREDENTIALS（供路由翻成 400）', async () => {
  const mock = await startMockSso();
  const { auth } = await makeAuth({ mock });
  try {
    await assert.rejects(
      () => auth.login({ username: USER }),
      (error) => error instanceof AuthError && error.code === 'AUTH_NEED_CREDENTIALS' && error.status === 400,
    );
  } finally {
    await mock.close();
  }
});

test('auth：没有任何注册站点时，登录报 NO_SITE 而不是静默失败', async () => {
  const mock = await startMockSso();
  const { auth } = await makeAuth({ mock, register: false });
  try {
    await assert.rejects(
      () => auth.login({ username: USER, password: PASS }),
      (error) => error instanceof AuthError && error.code === 'AUTH_NO_SITE',
    );
  } finally {
    await mock.close();
  }
});

test('auth：指定不存在的站点登录时抛 UNKNOWN_SITE', async () => {
  const mock = await startMockSso();
  const { auth } = await makeAuth({ mock });
  try {
    await assert.rejects(
      () => auth.login({ username: USER, password: PASS, siteId: 'ghost' }),
      (error) => error instanceof AuthError && error.code === 'AUTH_UNKNOWN_SITE',
    );
  } finally {
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 落盘与恢复 */

test('auth：会话落盘后重启仍是已登录，且票据文件是 0600', async () => {
  const mock = await startMockSso();
  const { auth, dataDir } = await makeAuth({ mock });
  await auth.login({ username: USER, password: PASS, siteId: 'a' });
  const sessionPath = path.join(dataDir, 'auth-session.json');

  if (process.platform !== 'win32') {
    const info = await stat(sessionPath);
    assert.equal(info.mode & 0o777, 0o600, '会话票据必须是 0600');
  }

  // 模拟重启：同一个 dataDir、新的 AuthService
  const second = new AuthService({ dataDir, config: { casOrigin: mock.origin } });
  second.registerSite({ id: 'a', label: '站点A', loginUrl: mock.siteAUrl });
  second.registerSite({ id: 'b', label: '站点B', loginUrl: mock.siteBUrl });
  try {
    const status = await second.restore();
    assert.equal(status.loggedIn, true, '恢复后应当是已登录');
    assert.equal(second.siteStatus('a').ready, true);
    assert.equal(second.siteStatus('b').ready, true);
    assert.equal(second.siteStatus('a').optimistic, true, '恢复出来的是乐观状态，等业务请求去证实');

    // 乐观状态足够让模块直接开工
    const outcome = await second.ensure('a');
    assert.equal(outcome.ok, true);
    assert.equal(outcome.cached, true);
  } finally {
    await mock.close();
  }
});

test('auth：会话文件里的站点状态在恢复后仍可见（lastOkAt）', async () => {
  const mock = await startMockSso();
  const { auth, dataDir } = await makeAuth({ mock });
  const first = await auth.login({ username: USER, password: PASS, siteId: 'a' });
  const lastOkAt = first.sites.find((site) => site.id === 'a').lastOkAt;
  assert.ok(lastOkAt);

  const second = new AuthService({ dataDir, config: { casOrigin: mock.origin } });
  second.registerSite({ id: 'a', label: '站点A', loginUrl: mock.siteAUrl });
  try {
    await second.restore();
    assert.equal(second.siteStatus('a').lastOkAt, lastOkAt, '上次成功时间应当被保留');
  } finally {
    await mock.close();
  }
});

test('auth：过期的会话文件会被丢弃', async () => {
  const mock = await startMockSso();
  const dir = await mkdtemp(path.join(tmpdir(), 'potato-auth-old-'));
  await new JsonFile(path.join(dir, 'auth-session.json')).write({
    savedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    cookies: [{ name: 'TGC', value: 'stale', domain: '127.0.0.1', path: '/', hostOnly: true, expiresAt: null, secure: false }],
    sites: {},
  });
  const auth = new AuthService({ dataDir: dir, config: { casOrigin: mock.origin } });
  auth.registerSite({ id: 'a', label: '站点A', loginUrl: mock.siteAUrl });
  try {
    const status = await auth.restore();
    assert.equal(status.loggedIn, false, '超过 7 天的会话不该被认');
    assert.equal(await exists(path.join(dir, 'auth-session.json')), false, '过期文件应被删除');
  } finally {
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 迁移 */

test('auth：★ 旧版 lms/academic 会话文件在被「认领」后会被合并并删除', async () => {
  const mock = await startMockSso();
  const dir = await mkdtemp(path.join(tmpdir(), 'potato-auth-migrate-'));
  const legacyCookie = (name) => ({
    name,
    value: 'legacy',
    domain: '127.0.0.1',
    path: '/',
    hostOnly: true,
    expiresAt: null,
    secure: false,
  });
  await new JsonFile(path.join(dir, 'lms-session.json')).write({
    savedAt: new Date().toISOString(),
    cookies: [legacyCookie('SESSION_LMS')],
  });
  await new JsonFile(path.join(dir, 'academic-session.json')).write({
    savedAt: new Date().toISOString(),
    cookies: [legacyCookie('SESSION_ACADEMIC')],
  });

  const auth = new AuthService({ dataDir: dir, config: { casOrigin: mock.origin } });
  auth.registerSite({ id: 'a', label: '站点A', loginUrl: mock.siteAUrl });
  // 各模块在自己的切换提交里认领（这里模拟 lms 与 academic 都已切换）
  auth.adoptLegacySession('lms-session.json');
  auth.adoptLegacySession('academic-session.json');
  try {
    await auth.restore();

    const merged = JSON.parse(await readFile(path.join(dir, 'auth-session.json'), 'utf8'));
    const names = merged.cookies.map((cookie) => cookie.name);
    assert.ok(names.includes('SESSION_LMS'), '应合并 lms 的 cookie');
    assert.ok(names.includes('SESSION_ACADEMIC'), '应合并 academic 的 cookie');

    assert.equal(await exists(path.join(dir, 'lms-session.json')), false, '旧文件应被删除');
    assert.equal(await exists(path.join(dir, 'academic-session.json')), false, '旧文件应被删除');
  } finally {
    await mock.close();
  }
});

test('auth：★ 没有被认领的旧会话文件不会被碰（切换是分步进行的）', async () => {
  const mock = await startMockSso();
  const dir = await mkdtemp(path.join(tmpdir(), 'potato-auth-noclaim-'));
  const legacy = path.join(dir, 'lms-session.json');
  await new JsonFile(legacy).write({
    savedAt: new Date().toISOString(),
    cookies: [{ name: 'SESSION_LMS', value: 'x', domain: '127.0.0.1', path: '/', hostOnly: true, expiresAt: null, secure: false }],
  });

  // 只注册站点、**不认领** lms 的会话文件 —— 模拟 lms 尚未切换到共享认证
  const auth = new AuthService({ dataDir: dir, config: { casOrigin: mock.origin } });
  auth.registerSite({ id: 'a', label: '站点A', loginUrl: mock.siteAUrl });
  try {
    await auth.restore();
    assert.equal(await exists(legacy), true, '未认领的文件必须原样保留，否则 lms 会突然变成未登录');
    assert.equal(await exists(path.join(dir, 'auth-session.json')), false, '也不该凭空造一个新会话文件');
  } finally {
    await mock.close();
  }
});

test('auth：没有旧文件时不产生空的 auth-session.json', async () => {
  const mock = await startMockSso();
  const dir = await mkdtemp(path.join(tmpdir(), 'potato-auth-fresh-'));
  const auth = new AuthService({ dataDir: dir, config: { casOrigin: mock.origin } });
  auth.registerSite({ id: 'a', label: '站点A', loginUrl: mock.siteAUrl });
  try {
    const status = await auth.restore();
    assert.equal(status.loggedIn, false);
    assert.equal(await exists(path.join(dir, 'auth-session.json')), false, '没登录过就不该有票据文件');
  } finally {
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 两步验证 */

test('auth：需要两步验证时状态为 need_mfa，验证后完成登录', async () => {
  const mock = await startMockSso({ needMfa: true, mfaCode: '654321' });
  const { auth } = await makeAuth({ mock });
  try {
    await auth.ensure('a');
    const first = await auth.login({ username: USER, password: PASS, siteId: 'a' });
    assert.equal(first.status, 'need_mfa');
    assert.equal(auth.status().loggedIn, false);

    const sent = await auth.sendMfaCode();
    assert.equal(sent.sent, true);
    assert.ok(sent.phoneMasked, '应返回脱敏手机号');

    const done = await auth.verifyMfaCode('654321');
    assert.equal(done.status, 'ready');
    assert.equal(auth.siteStatus('a').ready, true);
  } finally {
    await mock.close();
  }
});

/** 小工具：文件是否存在。 */
async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

// AUTH_STATUS 只用于类型参考，避免 lint 报未使用
void AUTH_STATUS;
