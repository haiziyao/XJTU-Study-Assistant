/**
 * 「设置 → 多端同步」渲染层测试（DOM 桩，不起浏览器、不发网络请求）。
 *
 * 三条必须钉住的界面口径：
 *   1. **网页版不显示敏感数据开关**，改成一句说明（用户口径：只能在桌面端/手机里开）；
 *   2. 非网页客户端要显示两个复选框，并且把"AI key 也会同步到你的服务器"这句风险说明写出来；
 *   3. 报告用人话展示（推了 / 拉了 / 跳过 / 重命名 / 疑似重复 / 冲突），失败要说清原因
 *      （401 → 重新登录），而且**一个 inline style 都没有**（CSP 禁 inline style）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootRenderer } from './helpers/renderer-dom.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VIEW = path.resolve(HERE, '../src/renderer/views/sync.js');
const CSS = path.resolve(HERE, '../src/renderer/views/sync.css');

/** 一份"已登录 + 有一个设备"的 /sync/status 响应。 */
function statusBody(overrides = {}) {
  return {
    deviceId: 'dev-1234-5678',
    deviceName: '我的笔记本',
    lastPullAt: '2026-10-14T08:00:00.000Z',
    lastPushAt: '2026-10-14T08:00:01.000Z',
    lastError: null,
    account: { connected: true, serverUrl: 'https://study.xjtuwhy.com', user: { username: 'alice', role: 'admin' } },
    runtime: { kind: 'native', reason: '127.0.0.1 是回环/私有网段地址', hostname: '127.0.0.1', hasSameOriginAuthConfig: null },
    syncSecrets: { aiConfig: false, lms: false },
    collections: {
      notes: { count: 12, maxUpdatedAt: '2026-10-14T07:00:00.000Z', label: '笔记', kind: 'collection', secret: null, enabled: true, deleteSync: 'soft' },
      todos: { count: 3, maxUpdatedAt: null, label: '待办', kind: 'collection', secret: null, enabled: true, deleteSync: 'none' },
      'ai-config': { count: 1, maxUpdatedAt: null, label: 'AI 配置与密钥', kind: 'file', secret: 'aiConfig', enabled: false, deleteSync: 'file' },
    },
    ...overrides,
  };
}

/** 起一个渲染层，`api` 按路径分发；返回 mount（已 await 一轮异步刷新）。 */
async function renderSection({ api, hostname = '127.0.0.1', authConfigOk = null } = {}) {
  const renderer = bootRenderer({ api, state: {} });
  // 环境事实由页面提供：主机名 + 同源 /auth/config 探测（这里是 stub）
  renderer.window.location.hostname = hostname;
  renderer.window.fetch = async () => ({ ok: authConfigOk === true });
  const section = renderer.PCModules.settingsSections().find((item) => item.id === 'sync.devices');
  assert.ok(section, '必须登记 sync.devices 这个设置区块');
  const mount = new renderer.El('div');
  section.render(mount);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { renderer, section, mount };
}

test('多端同步：区块登记在「账号登录」之后（order 89），标题是「多端同步」', async () => {
  const renderer = bootRenderer({ api: async () => statusBody(), state: {} });
  const sections = renderer.PCModules.settingsSections();
  const sync = sections.find((item) => item.id === 'sync.devices');
  assert.ok(sync);
  assert.equal(sync.title, '多端同步');
  assert.equal(sync.order, 89);
  const account = sections.find((item) => item.id === 'account.login');
  assert.ok(account && account.order < sync.order, '同步排在账号登录之后（先登录再同步）');
});

test('多端同步：原生客户端显示两个敏感数据复选框 + 风险说明 + 「立即同步」', async () => {
  const { mount } = await renderSection({ api: async () => statusBody(), hostname: '127.0.0.1' });
  const boxes = mount.querySelectorAll('.sync-secret-box');
  assert.equal(boxes.length, 2, '两个复选框：AI 配置与密钥 / 学堂账号凭据');
  assert.equal(boxes[0].checked, false, '默认不勾（敏感数据默认不同步）');
  assert.equal(boxes[1].checked, false);

  const text = mount.textContent;
  assert.match(text, /同步 AI 配置与密钥/);
  assert.match(text, /AI key 也会同步到你的服务器/, '必须写明 key 会存到自己的服务器');
  assert.match(text, /同步思源学堂账号密码/);
  assert.match(text, /服务端版不会用它登录（只做存储/, '学堂凭据在服务端只存不用，必须写明');
  assert.ok(mount.querySelectorAll('button').some((node) => node.textContent === '立即同步'), '要有「立即同步」按钮');

  // 状态区：账号、设备名、各集合条数
  assert.match(text, /alice/);
  assert.match(text, /我的笔记本/);
  assert.match(text, /笔记/);
  assert.match(text, /12/);
  // 不支持删除同步的集合要如实标注
  assert.match(text, /不支持删除同步/);
});

test('多端同步：网页版不显示这两个开关，改成一句说明', async () => {
  const { mount } = await renderSection({
    api: async () =>
      statusBody({ runtime: { kind: 'web', reason: 'study.example.com 是公网地址，且同源 /auth/config 可达', hostname: 'study.example.com', hasSameOriginAuthConfig: true } }),
    hostname: 'study.example.com',
    authConfigOk: true,
  });
  assert.equal(mount.querySelectorAll('.sync-secret-box').length, 0, '网页版不能出现敏感数据复选框');
  assert.match(mount.textContent, /网页版不提供敏感数据同步；要同步学堂账号与 API key，请在桌面端或手机 App 的「设置 → 多端同步」里开启。/);
});

test('多端同步：没登录时面板先说「还没登录」，不假装能同步', async () => {
  const { mount } = await renderSection({ api: async () => statusBody({ account: { connected: false, serverUrl: 'http://localhost:8866', user: null } }) });
  assert.match(mount.textContent, /还没登录/);
  assert.match(mount.textContent, /在上面「账号登录」那一块登录/);
});

test('多端同步：同步结果用人话展示（推了/拉了/跳过/重命名/冲突），并解释"重命名=两条都留"', async () => {
  const report = {
    ok: true,
    pushed: 3,
    pulled: 2,
    updated: 1,
    skipped: 7,
    renamed: 1,
    deleted: 0,
    deletedCount: 0,
    duplicates: [{ collection: 'notes', label: '笔记', title: '高等数学', id: 'n2', existingId: 'n1', reason: 'same-name-different-id', detail: '两条都留' }],
    conflicts: [{ collection: 'notes', label: '笔记', title: '高等数学', id: 'n1', variantId: 'n1-h12345678', origin: { id: 'dev-b', name: 'B 机' }, reason: 'same-id-different-content', detail: '两条都留' }],
    skippedSecrets: ['ai-config'],
    deleteSync: { notes: 'soft', todos: 'none' },
    durationMs: 123,
    at: '2026-10-14T08:00:02.000Z',
    runtime: { kind: 'native' },
  };
  const { mount } = await renderSection({
    api: async (url) => (String(url).startsWith('/sync/run') ? report : statusBody()),
  });

  const button = mount.querySelectorAll('button').find((node) => node.textContent === '立即同步');
  assert.ok(button);
  await button.listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const text = mount.textContent;
  assert.match(text, /同步完成/);
  assert.match(text, /推了/);
  assert.match(text, /拉了/);
  assert.match(text, /跳过/);
  assert.match(text, /重命名/);
  assert.match(text, /疑似重复/);
  assert.match(text, /冲突/);
  assert.match(text, /两条都留/, '必须解释"重命名"不是丢数据');
  assert.match(text, /没有写进本机/, '跳过的敏感集合要说清楚');
  assert.match(text, /不支持删除同步/);
  assert.match(text, /B 机/, '冲突明细里要有来源设备');
});

test('多端同步：失败时显示具体原因（401 → 重新登录）', async () => {
  const report = {
    ok: false,
    error: { code: 'TOKEN_EXPIRED', message: '登录已过期：请到「设置 → 账号登录」重新登录这台服务器。' },
    pushed: 0,
    pulled: 0,
    skipped: 0,
    renamed: 0,
    duplicates: [],
    conflicts: [],
    durationMs: 12,
    at: '2026-10-14T08:00:02.000Z',
  };
  const { mount } = await renderSection({ api: async (url) => (String(url).startsWith('/sync/run') ? report : statusBody()) });
  const button = mount.querySelectorAll('button').find((node) => node.textContent === '立即同步');
  await button.listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const text = mount.textContent;
  assert.match(text, /登录已过期/);
  assert.match(text, /重新登录/);
});

test('多端同步：同步进行中按钮禁用并显示「同步中…」', async () => {
  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { mount } = await renderSection({
    api: async (url) => {
      if (String(url).startsWith('/sync/run')) {
        await gate;
        return { ok: true, pushed: 0, pulled: 0, updated: 0, skipped: 0, renamed: 0, deleted: 0, duplicates: [], conflicts: [], durationMs: 1, at: 'x' };
      }
      return statusBody();
    },
  });
  const button = mount.querySelectorAll('button').find((node) => node.textContent === '立即同步');
  const pending = button.listeners.click[0]();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const busy = mount.querySelectorAll('button').find((node) => node.textContent.includes('同步中'));
  assert.ok(busy, '进行中要显示「同步中…」');
  assert.equal(busy.disabled, true, '进行中必须禁用，防止连点');
  release();
  await pending;
});

test('多端同步：CSP 禁 inline style —— 视图源码没有 style 赋值，样式全在 sync.css 且在 ≤760px 有断点', async () => {
  const source = fs.readFileSync(VIEW, 'utf8');
  assert.ok(!/\.style\b/.test(source), '视图里不能出现 node.style.x = …（CSP 会拦下 inline style）');
  assert.ok(!/style\s*=/.test(source), '视图里不能拼 style="…"');
  assert.ok(!/setAttribute\(\s*['"]style/.test(source));

  const css = fs.readFileSync(CSS, 'utf8');
  assert.match(css, /@media\s*\(max-width:\s*760px\)/, '窄屏（≤760px，与 shell/account 同一断点）必须有适配');
  assert.match(css, /minmax\(0,\s*1fr\)/, '网格必须用 minmax(0, 1fr)，否则长标题会把卡片撑破（溢出）');
  assert.match(css, /overflow-wrap:\s*anywhere/, '长设备名/长标题要能换行，不能溢出');
  assert.ok(!/style=/.test(css), 'css 文件里不该出现内联样式残留');
});
