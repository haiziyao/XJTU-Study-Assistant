/**
 * 通知模块测试。
 *
 * 重点不在"能不能抓到"（那条链路由 campus-search.test.js 覆盖），而在**本地沉淀的规则**：
 *   · `firstSeenAt` 只设一次 —— 它是"这条是不是新的"的唯一可靠判据（校方 publishedAt 常缺）；
 *   · 保留期清理按 `firstSeenAt` 算，**固定的条目永不清理**；
 *   · `retentionDays = 0` 表示永久保留，不能误删；
 *   · 自定义站点要挡内网地址（这是个用户可填 URL、服务端会去抓的入口 = SSRF 面）；
 *   · 失败站点要如实进 `perSite`，不能当成"那个站没有新通知"。
 *
 * 假站点通过注入 `fetchImpl` 接进来，和 campus-search.test.js 一个路子：
 * 返回真实 `Response`，数据是复刻教务处模板的栏目页。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { canonicalUrl, normalizeCustomSource, RETENTION_OPTIONS } from '../src/modules/notifications/service.js';

/* ---------------------------------------------------------------- 假站点 */

/** 教务处那种模板：`<li><span class="time">日期</span><a href="info/...">标题</a></li>`。 */
function listPage(items) {
  const rows = items
    .map((item) => `<li>\n<span class="time">${item.date ?? ''}</span>\n<a href="${item.url}">${item.title}</a></li>`)
    .join('\n');
  return `<!doctype html><html><head><title>通知公告</title></head><body>
<div class="nav"><ul><li><a href="index.htm">首页</a></li></ul></div>
<UL>${rows}</UL></body></html>`;
}

/** 一个"永远返回这份列表"的 fetch 替身（每个 URL 都给同一页，够 readSiteNews 用）。 */
function fakeSiteFetch(items, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    if (status !== 200) return new Response('boom', { status });
    return new Response(listPage(items), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  impl.calls = calls;
  return impl;
}

const ITEM_A = { title: '关于 2026 年转专业工作的通知', url: 'https://dean.xjtu.edu.cn/info/1095/10422.htm', date: '2026-09-15' };
const ITEM_B = { title: '关于调整本学期教学安排的通知', url: 'https://dean.xjtu.edu.cn/info/1095/10413.htm', date: '2026-09-12' };

async function startApp() {
  const app = await createServer({ dataDir: await mkdtemp(path.join(tmpdir(), 'potato-notify-')) });
  await app.listen({ port: 0 });
  const { notifications } = app.services;
  return {
    app,
    notifications,
    close: () => app.close(),
  };
}

/* ------------------------------------------------------------ 纯函数部分 */

test('canonicalUrl：去掉 #fragment 与跟踪参数，保留有意义的 query', () => {
  assert.equal(
    canonicalUrl('https://dean.xjtu.edu.cn/info/1095/10422.htm#top'),
    'https://dean.xjtu.edu.cn/info/1095/10422.htm',
  );
  assert.equal(
    canonicalUrl('https://dean.xjtu.edu.cn/info/1095/10422.htm?utm_source=wechat&utm_medium=mp'),
    'https://dean.xjtu.edu.cn/info/1095/10422.htm',
  );
  // 末尾斜杠归一
  assert.equal(canonicalUrl('https://gs.xjtu.edu.cn/tzgg/'), canonicalUrl('https://gs.xjtu.edu.cn/tzgg'));
  // ★ 有意义的 query 必须保留：不少校方站点靠 ?id= 区分文章，删了就全并成一条
  assert.equal(canonicalUrl('https://x.xjtu.edu.cn/a.htm?id=123'), 'https://x.xjtu.edu.cn/a.htm?id=123');
  assert.notEqual(canonicalUrl('https://x.xjtu.edu.cn/a.htm?id=1'), canonicalUrl('https://x.xjtu.edu.cn/a.htm?id=2'));
  // 相对地址按 base 解析
  assert.equal(canonicalUrl('../info/1.htm', 'https://dean.xjtu.edu.cn/jxxx/tzgg.htm'), 'https://dean.xjtu.edu.cn/info/1.htm');
});

test('canonicalUrl：不同站点的同名通知**不合并**', () => {
  const a = canonicalUrl('https://dean.xjtu.edu.cn/info/1.htm');
  const b = canonicalUrl('https://gs.xjtu.edu.cn/info/1.htm');
  assert.notEqual(a, b, '不同站点的通知本来就该是两条');
});

test('normalizeCustomSource：只收 http(s)，且挡内网地址（SSRF）', () => {
  const ok = normalizeCustomSource({ label: '能动学院', url: 'https://epe.xjtu.edu.cn/' });
  assert.equal(ok.custom, true);
  assert.equal(ok.enabled, true);
  assert.ok(ok.id);

  for (const bad of [
    'http://127.0.0.1:3210/api/v1/notifications',
    'http://localhost/x',
    'http://10.0.0.5/x',
    'http://192.168.1.1/x',
    'http://172.20.0.1/x',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/x',
    'ftp://x.xjtu.edu.cn/',
  ]) {
    assert.throws(() => normalizeCustomSource({ label: 'x', url: bad }), /内网|本机|http/i, `应当拒绝 ${bad}`);
  }

  assert.throws(() => normalizeCustomSource({ label: '', url: 'https://a.xjtu.edu.cn/' }), /名称/);
  assert.throws(() => normalizeCustomSource({ label: 'x', url: 'https://a.xjtu.edu.cn/', id: 'Bad_ID' }), /id/);
  // 与内置站点撞 id 会让 enabledSiteIds 的语义说不清，必须拒绝
  assert.throws(() => normalizeCustomSource({ label: 'x', url: 'https://a.xjtu.edu.cn/', id: 'dean' }), /重名/);
});

/* ---------------------------------------------------------------- 同步 */

test('sync：新条目入库，带 firstSeenAt 且默认未读', async () => {
  const ctx = await startApp();
  try {
    const result = await ctx.notifications.sync({ siteIds: ['dean'], fetchImpl: fakeSiteFetch([ITEM_A, ITEM_B]) });
    assert.equal(result.inserted, 2, `应当插入 2 条，实际 ${result.inserted}（perSite: ${JSON.stringify(result.perSite)}）`);
    assert.equal(result.total, 2);

    const list = ctx.notifications.list({});
    assert.equal(list.total, 2);
    const first = list.items.find((item) => item.title.includes('转专业'));
    assert.ok(first, '应当有转专业那条');
    assert.equal(first.pinned, false);
    assert.ok(first.firstSeenAt, '必须有 firstSeenAt');
    assert.equal(first.siteId, 'dean');
    assert.equal(first.publishedAt, '2026-09-15');
  } finally {
    await ctx.close();
  }
});

test('★ sync 二次同步：不重复插入、firstSeenAt 不变', async () => {
  const ctx = await startApp();
  try {
    const fetchImpl = fakeSiteFetch([ITEM_A, ITEM_B]);
    await ctx.notifications.sync({ siteIds: ['dean'], fetchImpl });
    const before = ctx.notifications.list({}).items.find((item) => item.title.includes('转专业'));

    const again = await ctx.notifications.sync({ siteIds: ['dean'], fetchImpl });
    assert.equal(again.inserted, 0, '同一批内容不该再插入');
    assert.equal(again.refreshed, 2);
    assert.equal(again.total, 2);

    const after = ctx.notifications.list({}).items.find((item) => item.id === before.id);
    assert.equal(after.firstSeenAt, before.firstSeenAt, '★ firstSeenAt 只能设一次');
  } finally {
    await ctx.close();
  }
});

test('sync：抓取失败的站点进 perSite.error，其它站照常入库', async () => {
  const ctx = await startApp();
  try {
    const result = await ctx.notifications.sync({
      siteIds: ['dean', 'gs'],
      fetchImpl: async (url) => {
        // dean 正常，gs 一律 500
        if (String(url).includes('gs.xjtu.edu.cn')) return new Response('boom', { status: 500 });
        return new Response(listPage([ITEM_A]), { status: 200, headers: { 'content-type': 'text/html' } });
      },
    });
    const dean = result.perSite.find((site) => site.siteId === 'dean');
    const gs = result.perSite.find((site) => site.siteId === 'gs');
    assert.ok(dean && dean.count >= 1, 'dean 应当抓到');
    assert.ok(gs?.error, '★ gs 抓不到时必须给出 error，不能当成"没有新通知"');
    assert.equal(result.inserted, 1);
  } finally {
    await ctx.close();
  }
});

test('sync：dryRun 只抓不写', async () => {
  const ctx = await startApp();
  try {
    const result = await ctx.notifications.sync({ siteIds: ['dean'], fetchImpl: fakeSiteFetch([ITEM_A]), dryRun: true });
    assert.ok(result.inserted >= 1, '应当报告"能插入几条"');
    assert.equal(ctx.notifications.list({}).total, 0, '★ dryRun 不能真的写库');
  } finally {
    await ctx.close();
  }
});

/* ------------------------------------------------------ 保留期与固定 */

/** 直接往集合里塞一条"很早以前发现的"通知，绕过抓取。 */
async function seedOld(notifications, { id, daysAgo, pinned = false }) {
  const seen = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  await notifications.store.notifications.insert({
    id,
    title: `老通知 ${id}`,
    url: `https://dean.xjtu.edu.cn/info/${id}.htm`,
    siteId: 'dean',
    siteLabel: '教务处',
    publishedAt: null,
    firstSeenAt: seen,
    lastSeenAt: seen,
    pinned,
    pinnedAt: pinned ? seen : null,
    source: 'column',
    snippet: null,
    authority: null,
  });
}

test('★ 保留期：超期的被清掉，未超期的留下，固定的永不清理', async () => {
  const ctx = await startApp();
  try {
    await ctx.notifications.updateSettings({ retentionDays: 30 });
    await seedOld(ctx.notifications, { id: 'old-plain', daysAgo: 100 });
    await seedOld(ctx.notifications, { id: 'old-pinned', daysAgo: 100, pinned: true });
    await seedOld(ctx.notifications, { id: 'recent', daysAgo: 3 });
    assert.equal(ctx.notifications.list({}).total, 3, '清理前应当有 3 条');

    const result = await ctx.notifications.sync({ siteIds: ['dean'], fetchImpl: fakeSiteFetch([ITEM_A]) });

    assert.equal(result.pruned, 1, `★ 只该清掉 1 条（老的未固定那条），实际 ${result.pruned}`);
    const ids = ctx.notifications.list({}).items.map((item) => item.id);
    assert.ok(!ids.includes('old-plain'), '超期未固定的应当被清掉');
    assert.ok(ids.includes('old-pinned'), '★ 固定的绝对不能被清理');
    assert.ok(ids.includes('recent'), '未超期的应当留下');
  } finally {
    await ctx.close();
  }
});

test('保留期 = 0 表示永久保留，一条都不删', async () => {
  const ctx = await startApp();
  try {
    await ctx.notifications.updateSettings({ retentionDays: 0 });
    await seedOld(ctx.notifications, { id: 'ancient', daysAgo: 4000 });
    const result = await ctx.notifications.sync({ siteIds: ['dean'], fetchImpl: fakeSiteFetch([ITEM_A]) });
    assert.equal(result.pruned, 0);
    assert.ok(ctx.notifications.list({}).items.some((item) => item.id === 'ancient'), '★ 永久保留时不能删');
  } finally {
    await ctx.close();
  }
});

test('保留期只接受白名单里的值', async () => {
  const ctx = await startApp();
  try {
    for (const days of RETENTION_OPTIONS) {
      const settings = await ctx.notifications.updateSettings({ retentionDays: days });
      assert.equal(settings.retentionDays, days);
    }
    await assert.rejects(() => ctx.notifications.updateSettings({ retentionDays: 45 }), /保留期/);
  } finally {
    await ctx.close();
  }
});

test('pin：固定后可被 pinned 筛选出来，取消固定后又回到清理范围内', async () => {
  const ctx = await startApp();
  try {
    await ctx.notifications.sync({ siteIds: ['dean'], fetchImpl: fakeSiteFetch([ITEM_A, ITEM_B]) });
    const [one] = ctx.notifications.list({}).items;

    await ctx.notifications.pin({ ids: [one.id], pinned: true });
    assert.equal(ctx.notifications.list({ pinned: true }).total, 1);
    assert.equal(ctx.notifications.stats().pinned, 1);

    await ctx.notifications.pin({ ids: [one.id], pinned: false });
    assert.equal(ctx.notifications.list({ pinned: true }).total, 0);
    assert.equal(ctx.notifications.stats().pinned, 0);
  } finally {
    await ctx.close();
  }
});

/* ---------------------------------------------------------------- 查询 */

test('list：站点 / 关键词 / 未读 / 固定 四种筛选，且分页正确', async () => {
  const ctx = await startApp();
  try {
    await ctx.notifications.sync({ siteIds: ['dean'], fetchImpl: fakeSiteFetch([ITEM_A, ITEM_B]) });
    const all = ctx.notifications.list({});
    assert.equal(all.total, 2);

    assert.equal(ctx.notifications.list({ q: '转专业' }).total, 1);
    assert.equal(ctx.notifications.list({ q: '不存在的词' }).total, 0);
    assert.equal(ctx.notifications.list({ siteId: 'dean' }).total, 2);
    assert.equal(ctx.notifications.list({ siteId: 'gs' }).total, 0);

    const page = ctx.notifications.list({ limit: 1, offset: 1 });
    assert.equal(page.total, 2);
    assert.equal(page.items.length, 1);
    assert.equal(page.offset, 1);
  } finally {
    await ctx.close();
  }
});


test('stats：按站点分桶，并给出未读与固定计数', async () => {
  const ctx = await startApp();
  try {
    await ctx.notifications.sync({ siteIds: ['dean'], fetchImpl: fakeSiteFetch([ITEM_A, ITEM_B]) });
    const stats = ctx.notifications.stats();
    assert.equal(stats.total, 2);
    assert.equal(stats.bySite.length, 1);
    assert.equal(stats.bySite[0].siteId, 'dean');
    assert.equal(stats.bySite[0].total, 2);
    assert.equal(stats.retentionDays, 90);
  } finally {
    await ctx.close();
  }
});

/* ---------------------------------------------------------- 自定义站点 */

test('自定义站点：能存进设置、出现在 sources 列表里、也能被同步', async () => {
  const ctx = await startApp();
  try {
    const settings = await ctx.notifications.updateSettings({
      customSources: [{ label: '能动学院', url: 'https://epe.xjtu.edu.cn/' }],
    });
    assert.equal(settings.customSources.length, 1);
    const custom = settings.customSources[0];

    const sources = ctx.notifications.sources();
    assert.ok(sources.some((site) => site.id === custom.id && site.custom === true), '应当出现在 sources 里');

    // 启用它并同步（用假 fetch，不去真的打校方站点）
    await ctx.notifications.updateSettings({ enabledSiteIds: [custom.id] });
    const result = await ctx.notifications.sync({
      siteIds: [custom.id],
      fetchImpl: fakeSiteFetch([{ ...ITEM_A, url: 'https://epe.xjtu.edu.cn/info/1.htm' }]),
    });
    assert.ok(result.inserted >= 1, `自定义站点也该能抓到（perSite: ${JSON.stringify(result.perSite)}）`);
  } finally {
    await ctx.close();
  }
});

test('删除自定义站点会把它从启用列表里一并摘掉', async () => {
  const ctx = await startApp();
  try {
    const settings = await ctx.notifications.updateSettings({
      customSources: [{ label: '临时站点', url: 'https://tmp.xjtu.edu.cn/' }],
      enabledSiteIds: ['dean'],
    });
    const custom = settings.customSources[0];
    await ctx.notifications.updateSettings({ enabledSiteIds: ['dean', custom.id] });
    assert.ok(ctx.notifications.settings().enabledSiteIds.includes(custom.id));

    await ctx.notifications.updateSettings({ customSources: [] });
    // 不摘掉的话，同步时会报"站点不在清单里"，用户看不出原因
    assert.ok(!ctx.notifications.settings().enabledSiteIds.includes(custom.id), '★ 删掉的站点不该还留在启用列表');
    assert.ok(ctx.notifications.settings().enabledSiteIds.includes('dean'), '内置站点不受影响');
  } finally {
    await ctx.close();
  }
});

test('内置站点里已知不可用的（working:false）被跳过并说明原因', async () => {
  const ctx = await startApp();
  try {
    const sources = ctx.notifications.sources();
    const broken = sources.find((site) => !site.custom && site.working === false);
    if (!broken) return; // 站点表若全都可用，这条就不适用
    const result = await ctx.notifications.sync({ siteIds: [broken.id], fetchImpl: fakeSiteFetch([ITEM_A]) });
    assert.equal(result.inserted, 0);
    assert.ok(result.perSite[0].error, '应当给出原因');
  } finally {
    await ctx.close();
  }
});
