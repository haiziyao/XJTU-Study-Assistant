/**
 * 课表模块的 jwapp 授权握手与诊断（零真实外网）。
 *
 * 这组用例钉住 2026-10 真机定位到的那条根因链：
 * 1. `loginUrl` 必须是 HTML 应用页 —— 用 GET 打 POST-only 的 JSON 接口会拿到 403 HTML，
 *    被 `CasAuth.begin()` 误判成"已登录"（`lastOkAt` 有值但业务全废）；
 * 2. 业务请求前必须先做 `应用页 → getAppConfig → appInit` 握手，否则真机稳定 403；
 * 3. 403 只是"应用授权"问题 → 502 `EHALL_HANDSHAKE_FAILED`，**绝不能**冒充 401 未登录；
 * 4. `/status?probe=1` 的 `diagnose` 要能指出卡在哪一步。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { resolveTimetableConfig } from '../src/modules/timetable/config.js';
import { MOCK_APP_ID, startMockTimetable } from './helpers/timetable-mock.js';

const TERM = '2026-2027-1';
const APP_PAGE_PATH = '/jwapp/sys/wdkb/*default/index.do';
const APP_CONFIG_PATH = `/jwapp/sys/funauthapp/api/getAppConfig/wdkb-${MOCK_APP_ID}.do`;
const APP_INIT_PATH = '/jwapp/sys/jwpubapp/modules/bb/cxjwggbbdqx.do';
const XSKCB_PATH = '/jwapp/sys/wdkb/modules/xskcb/xskcb.do';
const CXJCS_PATH = '/jwapp/sys/wdkb/modules/jshkcb/cxjcs.do';

test('timetable 配置：loginUrl 指向 HTML 应用页，不是 POST-only 的课表 JSON 接口', () => {
  const config = resolveTimetableConfig();
  assert.equal(config.loginUrl, 'https://ehall.xjtu.edu.cn/jwapp/sys/wdkb/*default/index.do');
  assert.equal(config.app.indexPath, APP_PAGE_PATH);
  assert.doesNotMatch(config.loginUrl, /xskcb\.do$/, '用 GET 打 JSON 接口会拿到 403 HTML，被 CAS 状态机误判成已登录');
  // appId 只信应用页（真机 2026-10 实测值在页面里），不用写死值兜底
  assert.equal(config.app.id, null);
  assert.match(String(config.app.appConfigPath(config.app.name, MOCK_APP_ID)), /^\/jwapp\/sys\/funauthapp\/api\/getAppConfig\/wdkb-4770397878132218\.do$/);
  assert.equal(config.app.appInitPath, APP_INIT_PATH);
});

async function startApp(mock) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'potato-timetable-handshake-'));
  const app = await createServer({ dataDir, timetable: mock.config() });
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
  return { app, info, call, dataDir };
}

async function loggedIn(options = {}) {
  const mock = await startMockTimetable(options);
  const ctx = await startApp(mock);
  const result = await ctx.app.services.auth.login({
    username: '2024001',
    password: 'secret-pass',
    siteId: 'timetable',
  });
  assert.equal(result.status, 'ready', `登录应成功：${JSON.stringify(result).slice(0, 300)}`);
  return { ...ctx, mock };
}

/** 登录之后发生的 `/jwapp/` 请求（按时间顺序，带 method）。 */
function jwappCallsSince(mock, from) {
  return mock.state.calls
    .slice(from)
    .filter((item) => item.path.startsWith('/jwapp/'))
    .map((item) => `${item.method} ${item.path}`);
}

/* ------------------------------------------------------------------ 握手序列 */

test('timetable 握手：预览前固定走「应用页 → getAppConfig → appInit → xskcb」，且带 Referer / X-Requested-With', async () => {
  const { app, call, mock } = await loggedIn();
  try {
    const from = mock.state.calls.length;
    const preview = await call('GET', `/timetable/preview?term=${TERM}`);
    assert.equal(preview.status, 200);

    assert.deepEqual(jwappCallsSince(mock, from), [
      `GET ${APP_PAGE_PATH}`,
      `GET ${APP_CONFIG_PATH}`,
      `POST ${APP_INIT_PATH}`,
      `POST ${XSKCB_PATH}`,
      `POST ${CXJCS_PATH}`,
    ]);

    const beforeLoginWindow = mock.state.calls.slice(from).filter((item) => item.path.startsWith('/jwapp/'));
    const [appPage, appConfig, appInit, xskcb] = beforeLoginWindow;
    for (const item of [appConfig, appInit, xskcb]) {
      assert.equal(item.referer, `${mock.origin}${APP_PAGE_PATH}`, 'jwapp 请求的 Referer 必须指向应用页');
      assert.equal(item.xRequestedWith, 'XMLHttpRequest');
    }
    assert.equal(appPage.referer, null, '打开应用页是普通页面导航，不带 Referer');
    assert.equal(appPage.xRequestedWith, null, '打开应用页是普通页面请求，不带 X-Requested-With');
    assert.deepEqual(appInit.body, { SFQY: '1', APP: MOCK_APP_ID }, 'appInit 必须带 SFQY=1 与 wdkb 的 appId');
    assert.deepEqual(xskcb.body, { XNXQDM: TERM });

    // 握手成功后缓存：再预览（绕过行缓存）不会重做握手
    const second = mock.state.calls.length;
    const again = await call('GET', `/timetable/preview?term=${TERM}&refresh=1`);
    assert.equal(again.status, 200);
    assert.deepEqual(jwappCallsSince(mock, second), [`POST ${XSKCB_PATH}`, `POST ${CXJCS_PATH}`], '握手只做一次');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('timetable 握手：拿到 appId 后 getAppConfig 用 <appName>-<appId>.do，业务接口返回 {code:"0"} 正常解析', async () => {
  const { app, call, mock } = await loggedIn();
  try {
    const preview = await call('GET', `/timetable/preview?term=${TERM}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.count, 7);
    assert.equal(preview.body.courses.find((item) => item.name === '高等数学').eventCount, 1);
    // 握手真的按应用页里的 appId 发了请求（不是写死别的应用）
    assert.ok(
      mock.state.calls.some((item) => item.path === `/jwapp/sys/funauthapp/api/getAppConfig/wdkb-${MOCK_APP_ID}.do`),
      'getAppConfig 必须用应用页里的 appId',
    );
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 未登录 / 未握手 */

test('timetable 握手：未登录时业务接口 302 到 CAS → 401 NOT_LOGGED_IN，且不返回"没课"', async () => {
  const mock = await startMockTimetable();
  const ctx = await startApp(mock);
  try {
    const preview = await ctx.call('GET', `/timetable/preview?term=${TERM}`);
    assert.equal(preview.status, 401);
    assert.equal(preview.body.error.code, 'NOT_LOGGED_IN');
    // 302 发生在业务 handler 之前：根本没有拉过课表，更不可能返回空课程表
    assert.equal(mock.state.timetableCalls, 0);
    assert.equal(preview.body.courses, undefined);
    assert.ok(mock.state.requests.some((item) => item.includes('/cas/')), '应被 302 到 CAS 登录页');
  } finally {
    await ctx.app.close();
    await mock.close();
  }
});

test('timetable 握手：未登录时 authorize() 抛 401 NOT_LOGGED_IN（不是握手失败）', async () => {
  const mock = await startMockTimetable();
  const ctx = await startApp(mock);
  try {
    const api = ctx.app.services.timetable.api;
    await assert.rejects(api.authorize(), (error) => {
      assert.equal(error.code, 'NOT_LOGGED_IN');
      assert.equal(error.status, 401);
      return true;
    });
    assert.equal(api.diagnose().handshake.ok, false);
    assert.equal(mock.state.timetableCalls, 0);
  } finally {
    await ctx.app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 握手失败 */

test('timetable 握手：应用页里取不到 appId → 502 EHALL_HANDSHAKE_FAILED，steps 指明 appPage', async () => {
  const { app, call, mock } = await loggedIn({ appId: null });
  try {
    const preview = await call('GET', `/timetable/preview?term=${TERM}`);
    assert.equal(preview.status, 502);
    assert.equal(preview.body.error.code, 'EHALL_HANDSHAKE_FAILED');
    assert.equal(preview.body.error.details.step, 'appPage');
    assert.match(preview.body.error.message, /appId/);
    const steps = preview.body.error.details.handshake.steps;
    assert.deepEqual(
      steps.map((item) => item.step),
      ['appPage'],
    );
    assert.equal(steps[0].status, 200);
    assert.match(steps[0].error, /appId/);
    assert.equal(mock.state.timetableCalls, 0, '握手失败不应继续打业务接口');
    // 未登录的 401 与握手失败的 502 必须分开
    assert.notEqual(preview.body.error.code, 'NOT_LOGGED_IN');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('timetable 握手：appInit 500 → 502 EHALL_HANDSHAKE_FAILED，steps 保留已成功步骤并指出 appInit', async () => {
  const { app, call, mock } = await loggedIn();
  try {
    mock.state.failNextAppInitWith = 500;
    const preview = await call('GET', `/timetable/preview?term=${TERM}`);
    assert.equal(preview.status, 502);
    assert.equal(preview.body.error.code, 'EHALL_HANDSHAKE_FAILED');
    assert.equal(preview.body.error.details.step, 'appInit');
    assert.deepEqual(
      preview.body.error.details.handshake.steps.map((item) => [item.step, item.status]),
      [
        ['appPage', 200],
        ['getAppConfig', 200],
        ['appInit', 500],
      ],
    );
    assert.equal(mock.state.timetableCalls, 0);
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ 403 重试 */

test('timetable 握手：业务接口 403 → 用全新握手重试一次并成功（不是让用户重新登录）', async () => {
  const { app, call, mock } = await loggedIn();
  try {
    // 登录过程中 CAS 会 302 回应用页一次（浏览器同样如此），所以先记下基线
    const base = {
      appPage: mock.state.appPageCalls,
      appConfig: mock.state.appConfigCalls,
      appInit: mock.state.appInitCalls,
    };
    // 先做一次健康预览，让握手进入缓存
    assert.equal((await call('GET', `/timetable/preview?term=${TERM}`)).status, 200);
    assert.equal(mock.state.appPageCalls, base.appPage + 1);

    // 模拟应用授权过期：下一次业务请求 403
    mock.state.forbidNextBusiness = 1;
    const preview = await call('GET', `/timetable/preview?term=${TERM}&refresh=1`);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.count, 7);
    assert.equal(mock.state.appPageCalls, base.appPage + 2, '403 后应重做一次全新握手');
    assert.equal(mock.state.appConfigCalls, base.appConfig + 2);
    assert.equal(mock.state.appInitCalls, base.appInit + 2);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('timetable 握手：重试后仍 403 → 502 EHALL_HANDSHAKE_FAILED，且不把登录态打回未登录', async () => {
  const { app, call, mock } = await loggedIn();
  try {
    mock.state.forbidAllBusiness = true;
    const preview = await call('GET', `/timetable/preview?term=${TERM}`);
    assert.equal(preview.status, 502, '403 是应用授权问题，不是 401');
    assert.equal(preview.body.error.code, 'EHALL_HANDSHAKE_FAILED');
    assert.match(preview.body.error.message, /握手/);
    assert.equal(preview.body.error.details.handshake.ok, false);
    const last = preview.body.error.details.handshake.steps.at(-1);
    assert.equal(last.status, 403);
    assert.equal(last.step, 'timetable');

    // 登录本身没坏：站点仍是 ready（否则又会回到"登录态已失效"的假象）
    assert.equal(app.services.auth.siteStatus('timetable').ready, true);
    const status = await call('GET', '/timetable/status');
    assert.equal(status.body.loggedIn, true);
    assert.equal(status.body.diagnose.handshake.ok, false);
    assert.equal(status.body.diagnose.lastError.code, 'EHALL_HANDSHAKE_FAILED');
  } finally {
    await app.close();
    await mock.close();
  }
});

/* ------------------------------------------------------------------ diagnose */

test('timetable 诊断：status?probe=1 的 diagnose 形状固定，且不含 cookie / 票据', async () => {
  const { app, call, mock } = await loggedIn();
  try {
    const probe = await call('GET', '/timetable/status?probe=1');
    assert.equal(probe.status, 200);
    assert.equal(probe.body.loggedIn, true);
    assert.equal(probe.body.currentTerm, TERM);

    const { diagnose } = probe.body;
    assert.deepEqual(Object.keys(diagnose).sort(), ['handshake', 'lastError', 'site']);
    assert.deepEqual(Object.keys(diagnose.site).sort(), ['lastOkAt', 'ready', 'reason']);
    assert.equal(diagnose.site.ready, true);
    assert.equal(diagnose.site.reason, null);
    assert.ok(diagnose.site.lastOkAt, '成功握手后应有 lastOkAt');
    assert.deepEqual(Object.keys(diagnose.handshake).sort(), ['appId', 'ok', 'steps']);
    assert.equal(diagnose.handshake.ok, true);
    assert.equal(diagnose.handshake.appId, MOCK_APP_ID);
    assert.deepEqual(
      diagnose.handshake.steps.map((item) => [item.step, item.status, item.error]),
      [
        ['appPage', 200, null],
        ['getAppConfig', 200, null],
        ['appInit', 200, null],
      ],
    );
    assert.equal(diagnose.lastError, null);

    // 只读诊断不能把凭据带出去
    const serialized = JSON.stringify(probe.body);
    assert.doesNotMatch(serialized, /EHALL_SESSION|CASTGC|TGC=|Cookie|cookie/i);
  } finally {
    await app.close();
    await mock.close();
  }
});

test('timetable 诊断：登录有效但握手失败时 loggedIn 仍为 true，diagnose 指出卡在 appPage', async () => {
  const { app, call, mock } = await loggedIn({ appId: null });
  try {
    const probe = await call('GET', '/timetable/status?probe=1');
    assert.equal(probe.status, 200);
    assert.equal(probe.body.loggedIn, true, '登录是好的，不能说成未登录');
    assert.equal(probe.body.reason, null);
    assert.match(probe.body.error, /握手失败/);
    assert.equal(probe.body.diagnose.handshake.ok, false);
    assert.equal(probe.body.diagnose.handshake.steps[0].step, 'appPage');
    assert.match(probe.body.diagnose.lastError.message, /appId/);
    assert.equal(mock.state.timetableCalls, 0);
  } finally {
    await app.close();
    await mock.close();
  }
});
