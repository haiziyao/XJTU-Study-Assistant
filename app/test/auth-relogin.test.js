/**
 * 站点会话过期后的**重新登录**（回归测试）。
 *
 * 用户报的 bug：「思源学堂过期了要重新登录，点『重新连接』没用，必须退出登录后再登录。」
 *
 * 查下来是两个缺陷叠加：
 *
 * 1. **界面**不给入口：`/auth/status` 的 `loggedIn` 是 `readyCount > 0`
 *    —— 只要**还有任一站点**就绪就算已登录。于是"教务还活着、学堂掉了"时
 *    `loggedIn` 仍是 true，卡片只画「重新连接」按钮，**永远没有输入密码的地方**。
 *    而「重新连接」只能做静默 SSO，CAS 的 TGC 也过期时必然失败。
 * 2. **CasAuth 状态陈旧**：`begin()` 不清理上一次的 `hasLogin` / `alreadyAuthenticated`。
 *    站点票据过期后这两个字段还是 true，`login()` 第一行
 *    `if (this.hasLogin) return READY` 直接早退 —— 密码一个字节都没发，却说登录成功。
 *    只有 `logout()` 里那句 `casAuth.reset()` 会把它们清干净，所以现象成了"必须退出再登录"。
 *
 * 这里把两条都钉住：CasAuth 层（本文件前半）与设置卡渲染层（后半）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CasAuth } from '../src/modules/lms/cas-auth.js';
import { bootRenderer } from './helpers/renderer-dom.js';

/** 一个 CAS 登录页（带 execution，说明"没登录，请填密码"）。 */
const LOGIN_FORM = `
<!doctype html><html><body>
<form id="fm1" method="post" action="/cas/login">
  <input type="hidden" name="execution" value="e1s1" />
  <input type="text" name="username" />
  <input type="password" name="password" />
</form>
<script>globalConfig = { mfaEnabled: false };</script>
</body></html>`;

/** 一个已经登录后的业务页（没有 execution，也不在 /cas/login）。 */
const BUSINESS_PAGE = '<!doctype html><html><body><div id="app">学堂首页</div></body></html>';

/**
 * 假的 HttpClient：只实现 `get`，按 URLs 顺序吐响应。
 * `begin()` 只用到 `{ url, text }` 两个字段。
 */
function fakeHttp(responses) {
  let index = 0;
  const calls = [];
  return {
    calls,
    async get(url, options = {}) {
      calls.push({ url: String(url), options });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return { url: next.url, text: next.text, status: 200, headers: new Map(), bytes: null };
    },
  };
}

function makeCas(responses = [{ url: 'https://lms.xjtu.edu.cn/cas/login', text: LOGIN_FORM }]) {
  const http = fakeHttp(responses);
  const cas = new CasAuth({
    http,
    config: { baseUrl: 'https://lms.xjtu.edu.cn/', casOrigin: 'https://login.xjtu.edu.cn' },
    visitorId: 'test-visitor',
  });
  return { cas, http };
}

/* --------------------------------------------------------- CasAuth 层 */

test('★ 会话过期后 begin() 必须清掉「我已经登录过」的旧结论', async () => {
  const { cas } = makeCas();
  // 模拟上一次登录成功留下的状态（这正是"重新登录却不动作"的来源）
  cas.hasLogin = true;
  cas.alreadyAuthenticated = true;

  const status = await cas.begin('https://lms.xjtu.edu.cn/');

  assert.equal(status, 'login_form', '服务端给了登录页就说明会话已失效');
  assert.equal(cas.hasLogin, false, '★ hasLogin 必须被清掉，否则 login() 会早退成 READY');
  assert.equal(cas.alreadyAuthenticated, false, '★ 同理，alreadyAuthenticated 也不能留旧值');
  assert.ok(cas.execution, '应当解析出执行令牌，后面的密码提交才有东西可发');
});

test('会话仍然有效时 begin() 返回 READY，且不影响连续失败计数', async () => {
  const { cas } = makeCas([{ url: 'https://lms.xjtu.edu.cn/', text: BUSINESS_PAGE }]);
  cas.failCount = 2;
  const status = await cas.begin('https://lms.xjtu.edu.cn/');
  assert.equal(status, 'ready');
  assert.equal(cas.alreadyAuthenticated, true);
  assert.equal(cas.failCount, 2, 'failCount 是"连续失败次数"，不该被 begin 动到');
});

test('★ 陈旧 hasLogin 会让 login() 早退 —— 一个请求都不发就说"已经登录"', async () => {
  // 反证（这就是假成功的机制）：只要 hasLogin 还是 true，login() 在第一行就返回 READY。
  const { cas, http } = makeCas();
  cas.hasLogin = true;

  const early = await cas.login({ username: '2024001', password: 'pw' });
  assert.equal(early.status, 'ready');
  assert.equal(early.message, '已经登录', '这正是"什么都没做却说成功"');
  assert.equal(http.calls.length, 0, '早退时一个请求都不会发 —— 所以用户等不到任何反应');

  // 正证：`begin()` 把这个字段清掉之后，早退的入口就不存在了
  // （完整走完密码提交需要 RSA 公钥与真实 CAS，那部分由 auth.test.js 的 mock SSO 覆盖）。
  await cas.begin('https://lms.xjtu.edu.cn/');
  assert.equal(cas.hasLogin, false, '★ begin() 之后不会再命中 `if (this.hasLogin) return READY`');
});
/* ------------------------------------------------------- 设置卡渲染层 */

const SECTION_ID = 'auth.account';

/** 一张"部分站点掉线"的状态：教务还就绪，学堂的票据过期了。 */
const PARTIAL_STATUS = {
  status: 'ready',
  loggedIn: true,
  username: '2024001',
  mfa: null,
  captchaRequired: false,
  error: null,
  siteCount: 2,
  readyCount: 1,
  sites: [
    { id: 'lms', label: '思源学堂', registered: true, ready: false, optimistic: false, reason: '思源学堂的登录票据已过期，请重新登录', lastOkAt: null },
    { id: 'academic', label: '学业情况', registered: true, ready: true, optimistic: false, reason: null, lastOkAt: '2026-10-11T02:00:00.000Z' },
  ],
};

async function renderCard(status, extra = {}) {
  const calls = [];
  const api = async (url, options = {}) => {
    calls.push(`${options.method ?? 'GET'} ${url}`);
    for (const [prefix, value] of Object.entries(extra)) {
      if (url.startsWith(prefix)) return typeof value === 'function' ? value(url, options) : value;
    }
    if (url.startsWith('/auth/status')) return status;
    return {};
  };
  const boot = bootRenderer({ api });
  const section = boot.PCModules.settingsSections().find((item) => item.id === SECTION_ID);
  assert.ok(section, `应注册设置区块 ${SECTION_ID}`);
  const mount = new boot.El('div');
  section.render(mount);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { mount, calls };
}

function walk(node, out = []) {
  out.push(node);
  for (const child of node.children ?? []) walk(child, out);
  return out;
}

test('★★ 已登录但学堂掉线时：必须给出账号密码表单（否则用户无路可走）', async () => {
  const { mount } = await renderCard(PARTIAL_STATUS);
  const nodes = walk(mount);
  const text = nodes.map((node) => node.textContent).join('\n');

  // 关键回归：表单在
  const inputs = nodes.filter((node) => node.tagName === 'INPUT');
  const hasPassword = inputs.some((node) => node.type === 'password');
  assert.ok(hasPassword, '★ 学堂过期时必须出现密码输入框 —— 之前只有「重新连接」，用户只能去退出登录');

  // 而且要说清"为什么又要输密码、不用先退出登录"
  assert.match(text, /票据已过期/, '应当写明是哪个站点的票据过期了');
  assert.match(text, /不必先退出登录/, '应当明确告诉用户不必退出登录');

  // 逐站点状态仍然如实显示
  assert.match(text, /思源学堂/);
  assert.match(text, /1\/2 个站点就绪/);
});

test('已登录且全部站点就绪时，不显示登录表单（只在真需要时才打扰）', async () => {
  const allReady = {
    ...PARTIAL_STATUS,
    readyCount: 2,
    sites: PARTIAL_STATUS.sites.map((site) => ({ ...site, ready: true, reason: null })),
  };
  const { mount } = await renderCard(allReady);
  const inputs = walk(mount).filter((node) => node.tagName === 'INPUT');
  assert.equal(inputs.some((node) => node.type === 'password'), false, '全部就绪时不该再要密码');
});

test('「重新连接」仍然带 revalidate —— 静默 SSO 能救回来的场景不能退化成要密码', async () => {
  const { mount, calls } = await renderCard(PARTIAL_STATUS);
  const retry = walk(mount)
    .filter((node) => node.tagName === 'BUTTON')
    .find((node) => node.textContent.trim() === '重新连接');
  assert.ok(retry, '应当有「重新连接」按钮');
  // mini-DOM 没有 HTMLElement.click()，直接调登记的监听器（与 auth-render.test.js 一致）
  retry.listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(
    calls.some((line) => line.includes('/auth/sites/lms/ensure')),
    `应当调用该站点的 ensure 接口（实际调用：${JSON.stringify(calls)}）`,
  );
});

test('★★「重新连接」失败时，提示里必须告诉用户「重新输入账号密码」', async () => {
  /*
   * 这是用户明确提的要求，也是这条路上最关键的一句话：
   * 静默 SSO 失败 = 只能重输密码。只显示一句"票据已过期"，
   * 用户刚点完「重新连接」，会以为那就是答案、然后卡住。
   */
  /*
   * 模拟**真实的线上形状**：`ensure` 在站点不可用时返回 HTTP 200 + `ok:false`
   * （业务结果，契约见 auth-routes.test.js），于是 `PC.api` 会抛错，
   * 并把整个响应体挂在 `error.payload` 上。前端必须从那里把 reason 捞出来。
   */
  const { mount, calls } = await renderCard(PARTIAL_STATUS, {
    '/auth/sites/lms/ensure': () => {
      const error = new Error('请求失败 (200)');
      error.payload = {
        ok: false,
        needsLogin: true,
        reason: '思源学堂的登录票据已过期，请重新登录',
      };
      error.status = 200;
      throw error;
    },
  });

  const retry = walk(mount)
    .filter((node) => node.tagName === 'BUTTON')
    .find((node) => node.textContent.trim() === '重新连接');
  assert.ok(retry);
  retry.listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.ok(calls.some((line) => line.includes('/auth/sites/lms/ensure')), '应当调用 ensure');

  const text = walk(mount).map((node) => node.textContent).join('\n');
  assert.match(text, /票据已过期/, '要带上后端给的具体原因');
  assert.match(text, /重新输入账号与密码/, '★ 必须明确告诉用户下一步做什么');
  assert.match(text, /不必先退出登录/, '★ 顺带打消"是不是得先退出"的疑问');
});

test('「重新连接」成功时不弹错误（能静默 SSO 救回来就不该打扰）', async () => {
  const { mount } = await renderCard(PARTIAL_STATUS, {
    '/auth/sites/lms/ensure': { ok: true, connected: true, needsLogin: false, reason: null },
  });
  const retry = walk(mount)
    .filter((node) => node.tagName === 'BUTTON')
    .find((node) => node.textContent.trim() === '重新连接');
  retry.listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 60));

  const text = walk(mount).map((node) => node.textContent).join('\n');
  assert.doesNotMatch(text, /重新输入账号与密码/, '成功时不该要密码');
});