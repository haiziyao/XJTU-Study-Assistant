/**
 * 「设置 → 统一身份认证」卡片的渲染测试。
 *
 * 这张卡是全程序唯一的登录入口，所以要钉住几件用户直接看到的事：
 *   - 未登录时给表单，已登录时给账号与逐站点状态；
 *   - **逐站点**如实显示（"登录成功但某站点没通"是真实存在的状态）；
 *   - 需要两步验证时，界面要告诉用户现在该做什么；
 *   - 密码提交后立刻从内存里清掉，且界面明说不会保存；
 *   - 没有模块接入时给出可读的空态，而不是一片空白。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootRenderer } from './helpers/renderer-dom.js';

const SECTION_ID = 'auth.account';

/** 伪后端：只回认证卡片用到的接口。 */
function makeApi(overrides = {}) {
  const calls = [];
  const api = async (url, options = {}) => {
    calls.push(`${options.method ?? 'GET'} ${url}`);
    for (const [prefix, value] of Object.entries(overrides)) {
      if (url.startsWith(prefix)) return typeof value === 'function' ? value(url, options) : value;
    }
    if (url.startsWith('/auth/status')) {
      return {
        status: 'anonymous',
        loggedIn: false,
        username: null,
        mfa: null,
        captchaRequired: false,
        error: null,
        siteCount: 0,
        readyCount: 0,
        sites: [],
      };
    }
    return {};
  };
  return { api, calls };
}

/** 渲染这张卡，返回挂载点。 */
async function renderCard(overrides = {}) {
  const { api, calls } = makeApi(overrides);
  const boot = bootRenderer({ api });
  const section = boot.PCModules.settingsSections().find((item) => item.id === SECTION_ID);
  assert.ok(section, `应注册设置区块 ${SECTION_ID}`);
  const mount = new boot.El('div');
  section.render(mount);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { mount, calls, section, boot };
}

function walk(node, out = []) {
  out.push(node);
  for (const child of node.children ?? []) walk(child, out);
  return out;
}

const textsOf = (mount) => walk(mount).map((node) => node.textContent).join('\n');
const findByClass = (mount, className) =>
  walk(mount).filter((node) => String(node.className).split(' ').includes(className));
const inputsOf = (mount) => walk(mount).filter((node) => node.tagName === 'INPUT');
/**
 * 按**精确文本**找按钮。
 *
 * 不能用 `includes`：`'退出登录'.includes('登录')` 为真，于是"找登录按钮"会命中"退出登录"，
 * 让「已登录时不该有登录按钮」这条断言永远失败（或被误判通过）。
 * 这里只有「重新连接」这类按钮是多实例同名，用 findAllButtons 取。
 */
const findButton = (mount, label) =>
  walk(mount)
    .filter((node) => node.tagName === 'BUTTON')
    .find((node) => node.textContent.trim() === label);
const findAllButtons = (mount, label) =>
  walk(mount)
    .filter((node) => node.tagName === 'BUTTON')
    .filter((node) => node.textContent.trim() === label);

/* ------------------------------------------------------------------ 注册 */

test('auth 设置卡：登记为 order 10，排在笔记接入之前', () => {
  const boot = bootRenderer({ api: async () => ({}) });
  const section = boot.PCModules.settingsSections().find((item) => item.id === SECTION_ID);
  assert.ok(section);
  assert.equal(section.title, '统一身份认证');
  assert.equal(section.order, 10);
  assert.equal(typeof section.render, 'function');

  // vm 里造的数组原型属于另一个 realm，断言前用 Array.from 归一到宿主 realm
  // （renderer.test.js 里也踩过这个坑）
  const ordered = Array.from(boot.PCModules.settingsSections()).map((item) => item.order);
  assert.deepEqual(ordered, [...ordered].sort((a, b) => a - b), '设置区块应按 order 升序返回');
  assert.ok(ordered.includes(10), '认证卡应当在列表里');
});

/* ------------------------------------------------------------------ 未登录 */

test('auth 设置卡：未登录时给账号密码表单，并说明不会保存密码', async () => {
  const { mount } = await renderCard();
  const inputs = inputsOf(mount);
  assert.equal(inputs.length, 2, '应有账号与密码两个输入框');
  assert.equal(inputs[0].type, 'text');
  assert.equal(inputs[1].type, 'password', '密码框必须是 password 类型');
  assert.ok(findButton(mount, '登录'), '应有登录按钮');

  const text = textsOf(mount);
  assert.match(text, /未登录/);
  assert.match(text, /不保存/, '必须如实说明密码不会被保存');
  assert.match(text, /学堂与教务用的是同一个学校账号/, '要说明一次登录两边通用的原因');
});

test('auth 设置卡：还没有模块接入时给出可读空态，而不是空白', async () => {
  const { mount } = await renderCard();
  const text = textsOf(mount);
  assert.match(text, /还没有模块接入统一认证/);
  assert.match(text, /思源学堂/, '应提示后续会有哪些模块接入');
});

/* ------------------------------------------------------------------ 已登录 */

test('auth 设置卡：已登录时显示账号与逐站点状态', async () => {
  const { mount } = await renderCard({
    '/auth/status': {
      status: 'ready',
      loggedIn: true,
      username: '2024001',
      mfa: null,
      siteCount: 2,
      readyCount: 1,
      sites: [
        { id: 'lms', label: '思源学堂', ready: true, optimistic: false, reason: null, lastOkAt: '2026-10-11T02:00:00.000Z' },
        { id: 'academic', label: '学业情况', ready: false, optimistic: false, reason: '登录票据已过期，请重新登录', lastOkAt: null },
      ],
    },
  });

  const text = textsOf(mount);
  assert.match(text, /已登录/);
  assert.match(text, /2024001/, '应显示当前账号');
  assert.match(text, /1\/2 个站点就绪/);
  assert.match(text, /思源学堂/);
  assert.match(text, /学业情况/);
  assert.match(text, /登录票据已过期/, '未就绪的站点要说明原因');
  assert.ok(findButton(mount, '退出登录'), '已登录时应给退出按钮');
  assert.equal(findButton(mount, '登录'), undefined, '已登录时不该再显示登录按钮');

  // 两个站点各有一个「重新连接」
  assert.equal(findAllButtons(mount, '重新连接').length, 2);
});

test('auth 设置卡：点击「重新连接」会打对应站点的 ensure 接口', async () => {
  const { mount, calls } = await renderCard({
    '/auth/status': {
      status: 'ready',
      loggedIn: true,
      username: '2024001',
      siteCount: 1,
      readyCount: 0,
      sites: [{ id: 'lms', label: '思源学堂', ready: false, reason: '票据已过期' }],
    },
  });

  const retry = findButton(mount, '重新连接');
  assert.ok(retry);
  retry.listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(
    calls.includes('POST /auth/sites/lms/ensure'),
    `应调用该站点的 ensure 接口，实际：${calls.join(' | ')}`,
  );
});

/* ------------------------------------------------------------------ 两步验证 */

test('auth 设置卡：需要两步验证时给出验证码输入与发送按钮', async () => {
  const { mount } = await renderCard({
    '/auth/status': {
      status: 'need_mfa',
      loggedIn: false,
      username: null,
      mfa: { phone: null, sent: false },
      siteCount: 1,
      readyCount: 0,
      sites: [{ id: 'lms', label: '思源学堂', ready: false, reason: '需要两步验证' }],
    },
  });

  const text = textsOf(mount);
  assert.match(text, /需要两步验证/);
  assert.ok(findButton(mount, '发送验证码'), '应能发送验证码');
  assert.ok(findButton(mount, '完成验证'), '应能提交验证码');
  const codeInput = inputsOf(mount).find((node) => String(node.placeholder).includes('短信验证码'));
  assert.ok(codeInput, '应有验证码输入框');
});

test('auth 设置卡：已发送过验证码时显示脱敏手机号', async () => {
  const { mount } = await renderCard({
    '/auth/status': {
      status: 'need_mfa',
      loggedIn: false,
      mfa: { phoneMasked: '138****8888', sent: true },
      siteCount: 1,
      readyCount: 0,
      sites: [],
    },
  });
  assert.match(textsOf(mount), /138\*\*\*\*8888/);
});

/* ------------------------------------------------------------------ 凭据处理 */

test('auth 设置卡：★ 登录提交后密码立刻从内存里清掉', async () => {
  let posted = null;
  const { mount } = await renderCard({
    '/auth/login': (url, options) => {
      posted = options.body;
      return { status: 'ready', loggedIn: true, username: '2024001', sites: [], siteCount: 0, readyCount: 0 };
    },
  });

  const inputs = inputsOf(mount);
  inputs[0].value = '2024001';
  inputs[0].listeners.input[0]();
  inputs[1].value = 'secret-pass';
  inputs[1].listeners.input[0]();

  findButton(mount, '登录').listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(posted?.username, '2024001');
  assert.equal(posted?.password, 'secret-pass', '密码应当被提交（否则登录无意义）');

  // 重新渲染后密码框应是空的 —— 说明密码没有被留在界面状态里
  const after = inputsOf(mount).filter((node) => node.type === 'password');
  assert.equal(after.length, 1);
  assert.equal(after[0].value ?? '', '', '★ 提交之后密码不该还留在内存/界面里');
});

test('auth 设置卡：缺账号或密码时原地提示，不发请求', async () => {
  const { mount, calls } = await renderCard();
  const before = calls.filter((entry) => entry.startsWith('POST')).length;

  // 什么都不填就点登录
  findButton(mount, '登录').listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const after = calls.filter((entry) => entry.startsWith('POST')).length;
  assert.equal(after, before, '字段不全时不该发登录请求');
  assert.match(textsOf(mount), /请填写学号与密码/);
});

/* ------------------------------------------------------------------ 学堂视图的引导 */

test('★ 学堂视图：未登录时不再有密码表单，改为指向设置的引导', async () => {
  const { api, calls } = makeApi({
    '/lms/status': { status: 'anonymous', loggedIn: false, user: null, courses: {}, activities: {} },
  });
  const boot = bootRenderer({ api });
  const mount = await boot.render('lms');

  const text = textsOf(mount);
  const inputs = inputsOf(mount);

  // 一个密码输入框都不该有 —— 这是本次重构最直接的用户可见变化
  assert.equal(
    inputs.filter((node) => node.type === 'password').length,
    0,
    '★ 学堂视图不该再出现密码输入框（登录只在设置里做一次）',
  );

  // 应当明确把用户送去设置，并说清为什么只登一次就够
  assert.match(text, /设置/, '要指向设置页');
  assert.match(text, /同一个学校账号|统一身份认证/, '要说明两个模块共用一个账号');
  assert.ok(findButton(mount, '去设置里登录'), '应给一个去设置的按钮');

  // 不该再去打学堂自己的登录/MFA/验证码接口
  assert.equal(
    calls.some((entry) => /\/lms\/(login|mfa|captcha)/.test(entry)),
    false,
    `学堂视图不该再调用登录类接口，实际：${calls.join(' | ')}`,
  );
});

test('学堂视图：引导按钮会切到设置页（走外壳的 openView）', async () => {
  const opened = [];
  const { api } = makeApi({
    '/lms/status': { status: 'anonymous', loggedIn: false, user: null, courses: {}, activities: {} },
  });
  const boot = bootRenderer({ api });
  // 外壳把 selectView 暴露成 PC.openView；这里用替身记录被切到哪个视图
  boot.PC.openView = (id) => opened.push(id);
  const mount = await boot.render('lms');

  findButton(mount, '去设置里登录').listeners.click[0]();
  assert.deepEqual(opened, ['settings'], '点按钮应当切到设置页');
});

/* ------------------------------------------------------------------ 图形验证码 */

test('auth 设置卡：被要求图形验证码时显示图片与输入框', async () => {
  const { mount } = await renderCard({
    '/auth/status': {
      status: 'need_captcha',
      loggedIn: false,
      captchaRequired: true,
      siteCount: 1,
      readyCount: 0,
      sites: [],
    },
  });

  const text = textsOf(mount);
  assert.match(text, /图形验证码/);
  const img = walk(mount).find((node) => node.tagName === 'IMG');
  assert.ok(img, '应显示验证码图片');
  assert.match(String(img.src), /\/auth\/captcha/, '图片应来自认证模块的验证码端点');
  const input = inputsOf(mount).find((node) => String(node.placeholder).includes('图形验证码'));
  assert.ok(input, '应有图形验证码输入框');
});
