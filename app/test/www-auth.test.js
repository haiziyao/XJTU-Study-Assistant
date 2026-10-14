/**
 * 服务端版：**账号契约**的集成测试。
 *
 * 冻结的契约（前端与 iOS/Android 都照它写，见 README「服务端版（公开网页）」）：
 *   GET  /auth/config    公开
 *   POST /auth/register  201 + Set-Cookie；首个用户即 admin；之后必须邀请码
 *   POST /auth/login     200 + Set-Cookie；密码错 401；连错 5 次锁 60 秒（429）
 *   POST /auth/logout    200 {ok:true} + 清 Cookie（服务端真的删会话）
 *   GET  /auth/me        200 {user} / 401
 *   POST /auth/password  200 {ok:true}，并作废该用户**其它**会话
 *   POST/GET/DELETE /auth/invites  仅 admin（非 admin 403）
 *   会话令牌同时接受 Cookie / `Authorization: Bearer` / `X-Potato-Token`
 *
 * 这些用例一条断言对应契约里的一条：改契约就要改测试，改不动就说明它是契约。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';

import { createWwwServer } from '../src/www/server.js';
import { register, login, request, startWww } from './helpers/www-client.js';

/** 测试里不要让宿主的日志刷屏（失败时断言信息本身已经足够定位）。 */
const SILENT = { log() {}, warn() {}, error() {} };

const AUTO =
  '连错 5 次后锁定 60 秒：第 5 次失败本身回 429（不是 401），锁定期间即使密码正确也回 429 —— ' +
  '否则"锁 60 秒"就只是一句文案。';

test('服务端版：/auth/config 公开可读，且如实声明"需要邀请码、没有 LMS"', async () => {
  const app = await startWww();
  try {
    const res = await app.call('/auth/config');
    assert.equal(res.status, 200);
    assert.equal(res.json.serverName, 'AI 智学');
    assert.equal(typeof res.json.version, 'string');
    assert.equal(res.json.registration, 'invite');
    assert.equal(res.json.firstUserBecomesAdmin, true);
    assert.deepEqual(res.json.features, { lms: false });
    // 公开接口不能泄露账号库里的东西
    assert.equal(res.json.users, undefined);
    assert.equal(JSON.stringify(res.json).includes('password'), false);
  } finally {
    await app.close();
  }
});

test('服务端版：第一个注册的用户自动成为 admin，且拿到 30 天有效的 HttpOnly Cookie', async () => {
  const app = await startWww();
  try {
    const res = await app.call('/auth/register', { method: 'POST', body: { username: 'alice', password: 'password1' } });
    assert.equal(res.status, 201);
    assert.equal(res.json.user.username, 'alice');
    assert.equal(res.json.user.role, 'admin', '空库的第一个注册者必须是管理员，否则这台服务器永远发不出邀请码');
    assert.equal(typeof res.json.user.id, 'string');
    assert.equal(typeof res.json.user.createdAt, 'string');

    const setCookie = String(res.headers['set-cookie']);
    assert.match(setCookie, /^potato_session=[0-9a-f]{64};/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Path=\//);
    assert.match(setCookie, /Max-Age=2592000/);

    // Cookie 立刻生效
    const me = await app.call('/auth/me', { headers: { cookie: res.cookie } });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.username, 'alice');
  } finally {
    await app.close();
  }
});

test('服务端版：第二个注册必须有邀请码（无码 403、空库之后不再有"第一个"这个窗口）', async () => {
  const app = await startWww();
  try {
    await register(app, { username: 'alice' });

    const noCode = await app.call('/auth/register', { method: 'POST', body: { username: 'bob', password: 'password1' } });
    assert.equal(noCode.status, 403);
    assert.equal(noCode.json.error.code, 'INVITE_INVALID');
    assert.equal(noCode.headers['set-cookie'], undefined, '注册失败不能顺手发一个会话 Cookie');

    const badCode = await app.call('/auth/register', { method: 'POST', body: { username: 'bob', password: 'password1', inviteCode: 'AAAA-BBBB' } });
    assert.equal(badCode.status, 403);
    assert.equal(badCode.json.error.code, 'INVITE_INVALID');

    // 用户仍然只有 alice 一个
    const again = await app.call('/auth/login', { method: 'POST', body: { username: 'bob', password: 'password1' } });
    assert.equal(again.status, 401);
  } finally {
    await app.close();
  }
});

test('服务端版：注册校验（密码 < 8 → 400、用户名重复 → 409、用户名形状不合法 → 400）', async () => {
  const app = await startWww();
  try {
    const short = await app.call('/auth/register', { method: 'POST', body: { username: 'alice', password: 'short' } });
    assert.equal(short.status, 400);
    assert.equal(short.json.error.code, 'BAD_REQUEST');
    assert.match(short.json.error.message, /8/);

    await register(app, { username: 'alice', password: 'password1' });

    const dup = await app.call('/auth/register', { method: 'POST', body: { username: 'alice', password: 'password1' } });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error.code, 'USER_EXISTS');

    const admin = await login(app, { username: 'alice', password: 'password1' });
    const invite = await app.call('/auth/invites', { method: 'POST', headers: { cookie: admin.cookie } });
    assert.equal(invite.status, 201);

    const weird = await app.call('/auth/register', { method: 'POST', body: { username: 'a b', password: 'password1', inviteCode: invite.json.invite.code } });
    assert.equal(weird.status, 400);
    assert.equal(weird.json.error.code, 'BAD_REQUEST');
  } finally {
    await app.close();
  }
});

test('服务端版：邀请码形如 K7Q3-M9XW、一次性、只有 admin 能发/看/删', async () => {
  const app = await startWww();
  try {
    const admin = await register(app, { username: 'alice' });
    assert.equal(admin.user.role, 'admin');

    const created = await app.call('/auth/invites', { method: 'POST', headers: { cookie: admin.cookie } });
    assert.equal(created.status, 201);
    const code = created.json.invite.code;
    // 去掉易混字符：不含 0 O 1 I L
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/, `邀请码形状不对：${code}`);

    // 列表里能看到它
    const list = await app.call('/auth/invites', { headers: { cookie: admin.cookie } });
    assert.equal(list.status, 200);
    assert.equal(list.json.invites.length, 1);
    assert.equal(list.json.invites[0].code, code);
    assert.equal(list.json.invites[0].used, false);
    assert.equal(typeof list.json.invites[0].createdAt, 'string');
    assert.equal(list.json.invites[0].usedBy, null);

    // 用它注册 bob
    const bob = await register(app, { username: 'bob', inviteCode: code });
    assert.equal(bob.status, 201);
    assert.equal(bob.user.role, 'user', '邀请码不该把管理员权限扩散出去');

    // 一次性：同一个码再用 → 403
    const reuse = await app.call('/auth/register', { method: 'POST', body: { username: 'carol', password: 'password1', inviteCode: code } });
    assert.equal(reuse.status, 403);
    assert.equal(reuse.json.error.code, 'INVITE_INVALID');
    assert.match(reuse.json.error.message, /使用过/);

    // 列表里它已被标记为使用过
    const used = await app.call('/auth/invites', { headers: { cookie: admin.cookie } });
    assert.equal(used.json.invites[0].used, true);
    assert.equal(used.json.invites[0].usedBy, bob.user.id);

    // 非 admin 一律 403
    const forbidden = await app.call('/auth/invites', { method: 'POST', headers: { cookie: bob.cookie } });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.json.error.code, 'FORBIDDEN');
    const forbiddenList = await app.call('/auth/invites', { headers: { cookie: bob.cookie } });
    assert.equal(forbiddenList.status, 403);
    const forbiddenDelete = await app.call(`/auth/invites/${created.json.invite.id}`, { method: 'DELETE', headers: { cookie: bob.cookie } });
    assert.equal(forbiddenDelete.status, 403);
    const anonList = await app.call('/auth/invites');
    assert.equal(anonList.status, 401);

    // admin 删除
    const removed = await app.call(`/auth/invites/${created.json.invite.id}`, { method: 'DELETE', headers: { cookie: admin.cookie } });
    assert.equal(removed.status, 200);
    const after = await app.call('/auth/invites', { headers: { cookie: admin.cookie } });
    assert.equal(after.json.invites.length, 0);
  } finally {
    await app.close();
  }
});

test('服务端版：登录 401 / 限速 429 —— ' + AUTO, async () => {
  const app = await startWww();
  try {
    await register(app, { username: 'alice', password: 'password1' });

    const wrong = await login(app, { username: 'alice', password: 'nope-nope' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, 'BAD_CREDENTIALS');
    assert.equal(wrong.cookie, null, '登录失败不能发会话 Cookie');

    // 第 2、3、4 次仍然是 401
    for (const round of [2, 3, 4]) {
      const res = await login(app, { username: 'alice', password: `nope-${round}` });
      assert.equal(res.status, 401, `第 ${round} 次失败应当是 401`);
    }

    // 第 5 次 → 429（锁定）
    const fifth = await login(app, { username: 'alice', password: 'nope-5' });
    assert.equal(fifth.status, 429);
    assert.equal(fifth.body.error.code, 'RATE_LIMITED');
    assert.equal(fifth.body.error.details.locked, true);
    assert.ok(fifth.body.error.details.retryAfterSeconds > 0);

    // 锁定期内**正确**密码也拒绝（否则锁定毫无意义）
    const locked = await login(app, { username: 'alice', password: 'password1' });
    assert.equal(locked.status, 429);

    // 换一个用户名：不同桶，不受影响（也证明桶是 IP+用户名，不是按 IP 一刀切）
    const other = await login(app, { username: 'nobody', password: 'password1' });
    assert.equal(other.status, 401);

    // 未知用户与已知用户的失败形状一致（不泄露"这个用户名存不存在"）
    assert.equal(other.body.error.code, 'BAD_CREDENTIALS');
  } finally {
    await app.close();
  }
});

test('服务端版：/auth/me 与登出（服务端真的删会话，不只是清 Cookie）', async () => {
  const app = await startWww();
  try {
    const anon = await app.call('/auth/me');
    assert.equal(anon.status, 401);
    assert.equal(anon.json.error.code, 'UNAUTHORIZED');

    const alice = await register(app, { username: 'alice' });
    const me = await app.call('/auth/me', { headers: { cookie: alice.cookie } });
    assert.equal(me.status, 200);
    assert.deepEqual(Object.keys(me.json.user).sort(), ['createdAt', 'id', 'role', 'username']);
    assert.equal(JSON.stringify(me.json).includes('passwordHash'), false);
    assert.equal(JSON.stringify(me.json).includes('salt'), false);

    const out = await app.call('/auth/logout', { method: 'POST', headers: { cookie: alice.cookie } });
    assert.equal(out.status, 200);
    assert.equal(out.json.ok, true);
    assert.match(String(out.headers['set-cookie']), /potato_session=;/);
    assert.match(String(out.headers['set-cookie']), /Max-Age=0/);

    const after = await app.call('/auth/me', { headers: { cookie: alice.cookie } });
    assert.equal(after.status, 401, '退出后原令牌必须失效（服务端删会话，而不是只清浏览器 Cookie）');
  } finally {
    await app.close();
  }
});

test('服务端版：改密码后旧会话失效、新密码可登录、当前会话保留', async () => {
  const app = await startWww();
  try {
    const phone = await register(app, { username: 'alice', password: 'password1' }); // 手机上的会话
    const desktop = await login(app, { username: 'alice', password: 'password1' }); // 另一台设备的会话

    // 当前密码不对 → 401，且密码没被改掉
    const wrong = await app.call('/auth/password', {
      method: 'POST',
      headers: { cookie: desktop.cookie },
      body: { currentPassword: 'not-my-password', newPassword: 'password2' },
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error.code, 'BAD_CREDENTIALS');

    const changed = await app.call('/auth/password', {
      method: 'POST',
      headers: { cookie: desktop.cookie },
      body: { currentPassword: 'password1', newPassword: 'password2' },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.json.ok, true);
    assert.equal(changed.json.revokedSessions, 1, '除了当前会话，其它会话都要作废');

    // 手机上的旧会话已失效
    const phoneAfter = await app.call('/auth/me', { headers: { cookie: phone.cookie } });
    assert.equal(phoneAfter.status, 401);
    // 当前会话还在（改完密码不该把自己踢下线）
    const desktopAfter = await app.call('/auth/me', { headers: { cookie: desktop.cookie } });
    assert.equal(desktopAfter.status, 200);

    // 新密码可登录、旧密码不行
    const oldLogin = await login(app, { username: 'alice', password: 'password1' });
    assert.equal(oldLogin.status, 401);
    const newLogin = await login(app, { username: 'alice', password: 'password2' });
    assert.equal(newLogin.status, 200);
    assert.equal(newLogin.body.user.username, 'alice');

    // 新密码太短 → 400
    const tooShort = await app.call('/auth/password', {
      method: 'POST',
      headers: { cookie: newLogin.cookie },
      body: { currentPassword: 'password2', newPassword: 'short' },
    });
    assert.equal(tooShort.status, 400);
  } finally {
    await app.close();
  }
});

test('服务端版：会话令牌也认 Authorization: Bearer 与 X-Potato-Token（给手机客户端）', async () => {
  const app = await startWww();
  try {
    const alice = await register(app, { username: 'alice' });
    assert.ok(alice.token, '注册响应里应当能从 Set-Cookie 取到令牌');

    const bearer = await app.call('/auth/me', { headers: { authorization: `Bearer ${alice.token}` } });
    assert.equal(bearer.status, 200);
    assert.equal(bearer.json.user.username, 'alice');

    const header = await app.call('/auth/me', { headers: { 'X-Potato-Token': alice.token } });
    assert.equal(header.status, 200);

    // 宿主自己的令牌头**不会**透传给用户后端（见 proxy.js 的凭据头过滤）——
    // 这里用"令牌错"来断言它确实没有被下游认成别的东西：错令牌必须 401，而不是被放行
    const bogus = await app.call('/auth/me', { headers: { 'X-Potato-Token': 'not-a-real-token' } });
    assert.equal(bogus.status, 401);
  } finally {
    await app.close();
  }
});

test('服务端版：账号库落盘不含明文密码，且重启后账号仍在', async () => {
  const first = await startWww();
  const dir = first.dir;
  let second = null;
  try {
    const alice = await register(first, { username: 'alice', password: 'password1' });
    const users = await readFile(path.join(dir, 'users.json'), 'utf8');
    assert.equal(users.includes('password1'), false, '账号库里绝不能出现明文密码');
    const parsed = JSON.parse(users);
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.items[0].username, 'alice');
    assert.match(parsed.items[0].passwordHash, /^[0-9a-f]{64}$/);
    assert.match(parsed.items[0].salt, /^[0-9a-f]{32}$/);
    assert.ok(alice.user.id);

    const sessions = JSON.parse(await readFile(path.join(dir, 'sessions.json'), 'utf8'));
    assert.ok(sessions.items.some((session) => session.userId === alice.user.id));
    assert.equal(typeof sessions.items[0].expiresAt, 'number');

    // 关掉再起一台（同一个数据目录）：账号与会话都应当还在 —— 这是"重启不掉线"的根据
    await first.www.close();
    second = await createWwwServer({ dataDir: dir, idleMs: 0, logger: SILENT });
    await second.init();
    const info = await second.listen({ port: 0 });

    const me = await request(info.port, '/auth/me', { headers: { cookie: alice.cookie } });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.username, 'alice');
    const relogin = await request(info.port, '/auth/login', { method: 'POST', body: { username: 'alice', password: 'password1' } });
    assert.equal(relogin.status, 200);
    assert.equal(relogin.json.user.role, 'admin');
  } finally {
    await second?.close().catch(() => {});
    await first.www.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
