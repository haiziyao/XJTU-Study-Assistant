/**
 * 界面偏好模块（`/ui/prefs`）测试。
 *
 * 存在的理由很简单：**`localStorage` 在桌面端靠不住**。
 * Web UI 的页面由后端在 `http://127.0.0.1:PORT` 提供，而 Electron 用 `loadFile()`
 * 加载（来源是 `file://`）—— 两份存储互不相干，换端口也会换一份。
 * 于是"自定义侧边栏顺序"在浏览器里记得住、桌面端下次打开就没了。
 * 把偏好落到后端，两个环境读同一份。
 *
 * 重点覆盖三件事：
 *   1. 存进去能读回来（跨"进程重启"——这里用重开 app 模拟）；
 *   2. `value: null` 语义是**删除**（回到默认），不是存一个 null；
 *   3. 键名与体积有边界（这是偏好表，不是第二个数据库）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';

async function startApp(dataDir) {
  const dir = dataDir ?? (await mkdtemp(path.join(tmpdir(), 'potato-uiprefs-')));
  const app = await createServer({ dataDir: dir });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { app, call, dir };
}

const LAYOUT = { main: ['calendar', 'chat'], more: ['lms'] };

test('存进去能读回来', async () => {
  const ctx = await startApp();
  try {
    const put = await ctx.call('PUT', '/ui/prefs/sidebar', { value: LAYOUT });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.value, LAYOUT);

    const one = await ctx.call('GET', '/ui/prefs/sidebar');
    assert.deepEqual(one.body.value, LAYOUT);

    const all = await ctx.call('GET', '/ui/prefs');
    assert.deepEqual(all.body.items.sidebar, LAYOUT);
  } finally {
    await ctx.app.close();
  }
});

test('★ 重启后还在（这就是"下次进入后依旧显示"）', async () => {
  const first = await startApp();
  const dir = first.dir;
  try {
    await first.call('PUT', '/ui/prefs/sidebar', { value: LAYOUT });
  } finally {
    await first.app.close();
  }

  // 用同一个数据目录重开一次，等于用户关掉程序再打开
  const second = await startApp(dir);
  try {
    const one = await second.call('GET', '/ui/prefs/sidebar');
    assert.deepEqual(one.body.value, LAYOUT, '★ 重启后应当还是用户自定义的顺序');
  } finally {
    await second.app.close();
  }
});

test('value: null 等于删除（回到默认），不是存一个 null', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('PUT', '/ui/prefs/sidebar', { value: LAYOUT });
    const removed = await ctx.call('PUT', '/ui/prefs/sidebar', { value: null });
    assert.equal(removed.body.removed, true);
    const after = await ctx.call('GET', '/ui/prefs/sidebar');
    assert.equal(after.body.value, null, '删掉之后读回来应是 null（表示从未设置过）');
    const all = await ctx.call('GET', '/ui/prefs');
    assert.equal(Object.prototype.hasOwnProperty.call(all.body.items, 'sidebar'), false, '列表里不该还留着这个键');
  } finally {
    await ctx.app.close();
  }
});

test('键名有白名单：路径穿越 / 大写 / 空值一律 4xx', async () => {
  const ctx = await startApp();
  try {
    for (const key of ['Sidebar', 'a b', '.hidden', '', 'x'.repeat(80)]) {
      const response = await ctx.call('PUT', `/ui/prefs/${encodeURIComponent(key)}`, { value: 1 });
      assert.ok(response.status >= 400 && response.status < 500, `键 ${JSON.stringify(key)} 应被拒，实际 ${response.status}`);
    }
    // 带点的合法键要能用（命名空间风格）
    const ok = await ctx.call('PUT', '/ui/prefs/sidebar.layout', { value: LAYOUT });
    assert.equal(ok.status, 200);
  } finally {
    await ctx.app.close();
  }
});

test('漏传 value 字段是 400，而不是静默删掉', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('PUT', '/ui/prefs/sidebar', { value: LAYOUT });
    const bad = await ctx.call('PUT', '/ui/prefs/sidebar', {});
    assert.equal(bad.status, 400);
    // 原来的值必须还在 —— 一个漏传的请求不该把用户的偏好抹掉
    const after = await ctx.call('GET', '/ui/prefs/sidebar');
    assert.deepEqual(after.body.value, LAYOUT);
  } finally {
    await ctx.app.close();
  }
});

test('体积有上限（偏好表不是数据库）', async () => {
  const ctx = await startApp();
  try {
    const huge = { blob: 'x'.repeat(20 * 1024) };
    const response = await ctx.call('PUT', '/ui/prefs/sidebar', { value: huge });
    assert.equal(response.status, 400);
    assert.match(response.body.error.message, /太大/);
  } finally {
    await ctx.app.close();
  }
});

test('多个键互不影响；覆盖写是替换而不是追加', async () => {
  const ctx = await startApp();
  try {
    await ctx.call('PUT', '/ui/prefs/sidebar', { value: { main: ['a'] } });
    await ctx.call('PUT', '/ui/prefs/theme', { value: 'dark' });
    await ctx.call('PUT', '/ui/prefs/sidebar', { value: { main: ['b'] } });
    const all = await ctx.call('GET', '/ui/prefs');
    assert.deepEqual(all.body.items.sidebar, { main: ['b'] }, '第二次写应当是替换');
    assert.equal(all.body.items.theme, 'dark', '另一个键应当不受影响');
    const theme = await ctx.call('GET', '/ui/prefs/theme');
    assert.equal(theme.body.value, 'dark');
  } finally {
    await ctx.app.close();
  }
});
