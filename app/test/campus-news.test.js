/**
 * 栏目列表直读（`readSiteNews`，campus 档的 ⓪ 条通道）的测试。
 *
 * 为什么单独一个文件：这条通道解决的问题跟"站内直搜"不是一回事 ——
 * 真机反馈是"用户问最近学院有什么新闻，命中的全是招生栏目、学院新闻停在年初"，
 * 根因是 VSB 站群的**列表页没被站内搜索收录/收录滞后**。所以这里验的是
 * "直接读栏目页能不能拿到最新的几条"，而不是"关键词检索准不准"。
 *
 * **绝不访问真实外网**：所有"校内站点""搜索引擎"都是本文件里用 `node:http` 起的假服务器，
 * 通过注入 `fetchImpl` 接进去；`localOnlyFetch()` 在发请求前检查 host，一旦有代码打到真实域名
 * 就立刻抛错（"忘记注入 fetch"会马上暴露，而不是偷偷联网）。
 *
 * 覆盖点：
 *   首页找栏目入口 → 列表页抽条目（标题/链接/日期）/
 *   日期七种写法（`2026-06-20` `2026/06/20` `2026.06.20` `2026.06` `06-20` `[2026-06-20]` `2026年6月20日`）/
 *   相对链接 resolve 成绝对链接 / 跨域条目与导航项一律丢掉 / 按日期倒序 + limit /
 *   列表页 500 与超时**失败隔离** / 全是 JS 渲染时返回空 + 原因（不拿标题凑数）/
 *   站点不可达时如实报空 / 问法里认站点（`findCampusSiteForQuery`）/
 *   端到端：`searchWebDetailed({mode:'campus'})` 里栏目条目 `matchedBy==='column'`、
 *   带 `publishedAt`、且排在招生类结果前面。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  COLUMN_LIMIT_DEFAULT,
  MATCHED_BY_RANK,
  extractColumnDate,
  findCampusSiteForQuery,
  looksLikeNewsQuery,
  parseColumnList,
  readSiteNews,
  searchWebDetailed,
} from '../src/modules/ai/web-search.js';

const realFetch = globalThis.fetch;

/** 只允许打到 127.0.0.1 的 fetch 包装（照 campus-search.test.js 的做法）。 */
function localOnlyFetch(record = []) {
  return async (url, init = {}) => {
    const target = String(url);
    const host = new URL(target).hostname;
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
      throw new Error(`测试禁止访问真实网络：${target}`);
    }
    record.push({ url: target, method: init.method ?? 'GET' });
    return realFetch(target, init);
  };
}

async function startFakeServer(handler) {
  const state = { requests: [], inFlight: 0, maxInFlight: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      state.requests.push({ method: req.method, path: url.pathname, query: url.searchParams, body });
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      const finish = (status, payload, type = 'text/html; charset=utf-8') => {
        state.inFlight -= 1;
        res.writeHead(status, { 'Content-Type': type });
        res.end(payload);
      };
      try {
        Promise.resolve(handler({ req, url, body, state, finish })).catch((error) => finish(500, String(error)));
      } catch (error) {
        finish(500, String(error));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () =>
      new Promise((resolve) => {
        // 有测试故意让请求挂住（超时用例），close 前先把残留连接掐掉，否则测试进程会等它
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

/** 一个"确定没人监听"的端口：起一个再关掉（模拟站点不可达）。 */
async function deadPort() {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// ---------------------------------------------------------------------------
// 假页面：按真页面（2026-10-13 实测）的形状复刻
// ---------------------------------------------------------------------------

/** 航天学院首页：栏目入口 + 一条内容页链接（内容页**不是**栏目页）+ 一条跨域链接。 */
const SAE_HOME = `<!doctype html><html><head><title>西安交通大学航天航空学院</title></head><body>
<ul class="nav">
  <li><a href="index.htm">首页</a></li>
  <li><a href="index/zhxw.htm">综合新闻</a></li>
  <li><a href="index/tzgg.htm">通知公告</a></li>
  <li><a href="xygk/xyjj.htm">学院简介</a></li>
  <li><a href="https://evil.example.com/news.htm">校外新闻</a></li>
</ul>
<div class="news">
  <a href="info/1056/9993.htm">航天航空学院青工委举办学术讲座暨青年教师座谈会 2026-10-10</a>
  <a href="info/1091/9995.htm" title="第二届机械与航空航天工程国际会议通知">2026-10-12 第二届机械与航空航天工程国际会议通知 查看详情 →</a>
</div>
</body></html>`;

/**
 * 航天学院"综合新闻"列表页：**照真页面**的三种模板混排 ——
 * `tz-date`（`<span>2026</span><b>10-12</b>`）、`a-date`（`<b>04</b><span>2026.05</span>`）、裸 `<span>日期</span>`。
 * 日期故意不按顺序放，用来验"按发布日期倒序"而不是"按页面顺序"。
 */
const SAE_NEWS = `<!doctype html><html><head><title>综合新闻-西安交通大学航天航空学院</title></head><body>
<ul class="nav"><li><a href="../index.htm">首页</a></li><li><a href="more.htm">更多</a></li></ul>
<ul id="list">
  <li id="line_u12_0"><a href="../info/1056/9993.htm">
    <div class="tz-date"><span>2026</span><b>06-20</b><div class="tz-arrow"></div></div>
    <div class="tz-tx"><h3>学院新闻：本条是列表里最新的一条</h3><p>摘要文字，里面还藏着一个 2020年1月1日 的说法，不该被当成发布日期。</p></div>
  </a></li>
  <li id="line_u12_1"><a href="../info/1056/9994.htm"><div class="a-tx"><h3>学院新闻：斜杠日期</h3></div></a><span>2026/06/19</span></li>
  <li id="line_u12_2"><a href="../info/1056/9995.htm"><div class="a-date"><b>18</b><span>2026.06</span></div><div class="a-tx"><h3>学院新闻：点号日期（只到月，日藏在相邻元素里）</h3></div></a></li>
  <li id="line_u12_3"><a href="../info/1056/9996.htm"><div class="a-date"><b>17</b><span>2026.06</span></div><div class="a-tx"><h3>学院新闻：还是点号日期</h3></div></a></li>
  <li id="line_u12_4"><a href="../info/1056/9997.htm" title="学院新闻：title 属性里的干净标题"><span class="date"><span class="r">06-16 </span><span class="y">2026</span></span><div class="tit"><p class="tits">学院新闻：标题属性优先（锚文本里混着日期）</p></div></a></li>
  <li id="line_u12_5"><a href="../info/1056/9998.htm"><h3>学院新闻：中文日期</h3></a><span>2026年6月15日</span></li>
  <li id="line_u12_6"><a href="../info/1056/9999.htm"><h3>学院新闻：方括号日期</h3></a><span>[2026-06-14]</span></li>
  <li id="line_u12_7"><a href="https://evil.example.com/info/1.htm"><h3>校外仿冒的新闻（跨域，必须丢掉）</h3></a><span>2026-06-30</span></li>
  <li class="nav"><a href="../index.htm"><h3>首页</h3></a><span>2026-06-30</span></li>
  <li class="nav"><a href="more.htm"><h3>更多</h3></a><span>2026-06-30</span></li>
</ul>
</body></html>`;

/** 假站点条目：`origin` 让真请求打到本地假服务器，返回的 URL 仍是 `sae.xjtu.edu.cn`。 */
function saeSite(world, extra = {}) {
  return {
    id: 'sae',
    label: '航天航空学院（假）',
    host: 'sae.xjtu.edu.cn',
    aliases: ['航天航空学院', '航院'],
    origin: world.base,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 1. 日期解析：七种写法
// ---------------------------------------------------------------------------

test('日期解析：七种写法都认（含只到月份 / 只到月日 / 方括号）', () => {
  assert.equal(extractColumnDate('2026-06-20 标题'), '2026-06-20');
  assert.equal(extractColumnDate('标题 2026/06/20'), '2026-06-20');
  assert.equal(extractColumnDate('2026.06.20 标题'), '2026-06-20');
  assert.equal(extractColumnDate('2026年6月20日 标题'), '2026-06-20');
  assert.equal(extractColumnDate('[2026-06-20] 标题'), '2026-06-20', '方括号包着的日期也要认');
  // 只到月份：**不补 01** —— 补了就是在编造"这条是 6 月 1 日发的"
  assert.equal(extractColumnDate('2026.06 标题'), '2026-06');
  // 只到月日：年份在相邻元素里（页面级年份或同一行的 4 位年份）
  assert.equal(extractColumnDate('06-20 标题', { pageYear: '2026' }), '2026-06-20');
  assert.equal(extractColumnDate('2026 06-20 标题'), '2026-06-20', '同行有年份就用同行的');
  // 抽不到就返回空 —— 上层据此**丢掉这一行**，绝不硬塞
  assert.equal(extractColumnDate('06-20 标题（哪一年的？）'), '', '没有年份就不猜');
  assert.equal(extractColumnDate('本页没有日期'), '');
  // 学年区间不是日期
  assert.equal(extractColumnDate('关于2026-2027学年第一学期选课的通知 2026-09-15'), '2026-09-15');
});

// ---------------------------------------------------------------------------
// 2. readSiteNews：找栏目页 → 抽条目
// ---------------------------------------------------------------------------

test('栏目直读：首页找栏目入口 → 列表页抽标题/链接/日期，按日期倒序并截到 limit', async () => {
  const world = await startFakeServer(({ url, finish }) => {
    if (url.pathname === '/') return finish(200, SAE_HOME);
    if (url.pathname === '/index/zhxw.htm') return finish(200, SAE_NEWS);
    return finish(404, 'nope');
  });
  try {
    const out = await readSiteNews({ site: saeSite(world), limit: 5, fetchImpl: localOnlyFetch(), timeoutMs: 1_000 });

    assert.equal(out.site, 'sae');
    assert.equal(out.host, 'sae.xjtu.edu.cn');
    assert.equal(out.items.length, 5, 'limit=5 就只回 5 条');
    assert.equal(out.newest, '2026-06-20');
    assert.deepEqual(
      out.items.map((item) => [item.publishedAt, item.title]),
      [
        ['2026-06-20', '学院新闻：本条是列表里最新的一条'],
        ['2026-06-19', '学院新闻：斜杠日期'],
        ['2026-06-18', '学院新闻：点号日期（只到月，日藏在相邻元素里）'],
        ['2026-06-17', '学院新闻：还是点号日期'],
        ['2026-06-16', '学院新闻：title 属性里的干净标题'],
      ],
      '按发布日期倒序；只到月份的 2026.06 由相邻的 <b>18</b> 补出日',
    );
    // 相对链接要解析成绝对链接，且指向**公开地址**
    assert.deepEqual(
      out.items.map((item) => item.url),
      [
        'https://sae.xjtu.edu.cn/info/1056/9993.htm',
        'https://sae.xjtu.edu.cn/info/1056/9994.htm',
        'https://sae.xjtu.edu.cn/info/1056/9995.htm',
        'https://sae.xjtu.edu.cn/info/1056/9996.htm',
        'https://sae.xjtu.edu.cn/info/1056/9997.htm',
      ],
      '../info/… 相对链接要相对列表页解析成 sae.xjtu.edu.cn 上的绝对链接',
    );
    assert.ok(out.items.every((item) => item.source === 'https://sae.xjtu.edu.cn/index/zhxw.htm'));
    assert.equal(out.source, 'https://sae.xjtu.edu.cn/index/zhxw.htm');

    // 首页里那条 `info/1056/9993.htm`（内容页）**不能**被当成栏目页去抓
    const fetched = out.fetched.map((report) => report.url);
    assert.ok(!fetched.includes('https://sae.xjtu.edu.cn/info/1056/9993.htm'), '内容页不是栏目页');
    assert.ok(fetched.includes('https://sae.xjtu.edu.cn/index/zhxw.htm'));
    // 标题属性比锚文本干净时用 title 属性（wen 的真模板就是"日期 + 标题 + 摘要"挤在锚文本里）
    assert.ok(
      out.items.some((item) => item.title === '学院新闻：title 属性里的干净标题'),
      '锚文本里混着日期时，用 title 属性里的干净标题',
    );
    assert.ok(out.fetched.find((report) => report.url.endsWith('/index/zhxw.htm')).count === 7);
    assert.deepEqual(out.home, { url: 'https://sae.xjtu.edu.cn/', ok: true, status: 200, error: null });
    assert.ok(out.notes.some((line) => line.includes('最新 2026-06-20')));
    assert.equal(out.error, null);
  } finally {
    await world.close();
  }
});

test('栏目直读：摘要里的日期/跨域链接/导航项都不能混进来', async () => {
  const world = await startFakeServer(({ url, finish }) => {
    if (url.pathname === '/index/zhxw.htm') return finish(200, SAE_NEWS);
    return finish(404, 'nope');
  });
  try {
    // 直接给 url（不给站点条目）：白名单按这个 URL 的域名算
    const out = await readSiteNews({
      url: `${world.base}/index/zhxw.htm`,
      limit: 20,
      fetchImpl: localOnlyFetch(),
      timeoutMs: 1_000,
    });
    const titles = out.items.map((item) => item.title);
    assert.equal(out.items.length, 7, '10 行里：跨域 1 条、导航 2 条要丢掉');
    assert.ok(!titles.some((title) => title.includes('校外仿冒')), '跨域条目一律丢掉（同 searchCampusSites 口径）');
    assert.ok(!titles.includes('首页') && !titles.includes('更多'), '导航项不是新闻条目');
    // 摘要里那句"2020年1月1日"不能把发布日期带跑（真网踩过：会议通知的正文写着会议日期）
    assert.equal(out.items[0].publishedAt, '2026-06-20');
    // 方括号日期那条也在（说明 span 里的日期能被认出来），且仍是绝对链接
    assert.ok(titles.includes('学院新闻：方括号日期'));
    for (const item of out.items) {
      assert.ok(item.url.startsWith('http://127.0.0.1:'), `给出的 url 入口下，链接属于该入口域名：${item.url}`);
      assert.ok(item.publishedAt, '每条都必须有发布日期');
      assert.ok(item.title.length <= 120, '标题截断到 120 字以内');
      assert.ok(!/\s{2,}/.test(item.title), '标题不能有多余空白');
    }
  } finally {
    await world.close();
  }
});

test('栏目直读：只到月份的那条排在同月有具体日期的条目**后面**（不把精度当新鲜度）', async () => {
  const html = `<ul>
<li><a href="../info/1/1.htm"><h3>只有月份的条目</h3></a><span>2026.06</span></li>
<li><a href="../info/1/2.htm"><h3>当月较早的具体日期</h3></a><span>2026-06-03</span></li>
</ul>`;
  const world = await startFakeServer(({ url, finish }) => {
    if (url.pathname === '/list.htm') return finish(200, html);
    return finish(404, 'nope');
  });
  try {
    const out = await readSiteNews({ url: `${world.base}/list.htm`, fetchImpl: localOnlyFetch(), timeoutMs: 1_000 });
    assert.deepEqual(out.items.map((item) => item.publishedAt), ['2026-06-03', '2026-06'], '2026-06 按"当月最早"参与排序');
    assert.equal(out.newest, '2026-06-03');
  } finally {
    await world.close();
  }
});

test('栏目直读：列表页 500 / 超时只影响它自己，其余候选页照样出结果（失败隔离）', async () => {
  const world = await startFakeServer(({ url, finish }) => {
    if (url.pathname === '/') return finish(200, SAE_HOME);
    if (url.pathname === '/index/zhxw.htm') return finish(200, SAE_NEWS);
    if (url.pathname === '/index/tzgg.htm') return finish(500, '<html>boom</html>');
    if (url.pathname === '/index/xsjz.htm') return undefined; // 永不响应 → 走超时
    return finish(404, 'nope');
  });
  try {
    const out = await readSiteNews({
      site: saeSite(world, { columns: ['/index/tzgg.htm', '/index/xsjz.htm', '/index/zhxw.htm'] }),
      limit: 3,
      fetchImpl: localOnlyFetch(),
      timeoutMs: 300,
    });
    assert.equal(out.items.length, 3, '坏掉的两页不该拖垮好的那一页');
    assert.equal(out.newest, '2026-06-20');
    assert.equal(out.source, 'https://sae.xjtu.edu.cn/index/zhxw.htm');
    const byUrl = new Map(out.fetched.map((report) => [report.url, report]));
    assert.equal(byUrl.get('https://sae.xjtu.edu.cn/index/tzgg.htm').ok, false);
    assert.match(byUrl.get('https://sae.xjtu.edu.cn/index/tzgg.htm').error, /HTTP 500/);
    assert.equal(byUrl.get('https://sae.xjtu.edu.cn/index/xsjz.htm').ok, false);
    assert.match(byUrl.get('https://sae.xjtu.edu.cn/index/xsjz.htm').error, /超时|中断/);
    assert.equal(byUrl.get('https://sae.xjtu.edu.cn/index/zhxw.htm').ok, true);
    assert.ok(out.notes.some((line) => line.includes('栏目直读跳过') && line.includes('index/tzgg.htm')), '失败原因要写进 notes');
  } finally {
    await world.close();
  }
});

test('栏目直读：全是 JS 渲染（抽不到日期）→ 返回空 + 每页原因，绝不把标题当新闻硬塞', async () => {
  // 结构漂漂亮亮，就是**没有发布日期**：真网里对应"列表由 JS 从接口拉、HTML 里只有骨架"
  const jsRendered = `<ul id="list">
<li><a href="info/1056/1.htm"><h3>看起来像新闻的条目一</h3></a></li>
<li><a href="info/1056/2.htm"><h3>看起来像新闻的条目二</h3></a></li>
<li><a href="info/1056/3.htm"><h3>看起来像新闻的条目三</h3></a></li>
</ul>`;
  const world = await startFakeServer(({ url, finish }) => {
    if (url.pathname === '/') {
      return finish(200, '<html><body><a href="xwdt.htm">学院新闻</a></body></html>');
    }
    if (url.pathname === '/xwdt.htm') return finish(200, jsRendered);
    return finish(404, 'nope');
  });
  try {
    const out = await readSiteNews({ site: saeSite(world), fetchImpl: localOnlyFetch(), timeoutMs: 500 });
    assert.deepEqual(out.items, [], '抽不到日期就是 0 条');
    assert.equal(out.newest, '');
    assert.equal(out.source, '');
    assert.ok(out.error && out.error.includes('抽到带发布日期的条目'), `要如实说明为什么是空的：${out.error}`);
    const page = out.fetched.find((report) => report.url.endsWith('/xwdt.htm'));
    assert.equal(page.ok, true, '页面本身抓到了（200），是"解析不出日期"而不是"抓取失败"');
    assert.equal(page.rows, 3, '行数要如实带出来，便于判断是不是模板改版');
    assert.equal(page.dated, 0);
    assert.match(page.error, /JS 渲染|改版/);
    assert.ok(out.notes.some((line) => line.includes('没读到任何带日期的条目')));
  } finally {
    await world.close();
  }
});

test('栏目直读：站点整个不可达 → 如实报空 + 原因，不再白试候选页（也不静默成"没有新闻"）', async () => {
  const port = await deadPort();
  const logs = [];
  const out = await readSiteNews({
    url: `http://127.0.0.1:${port}/`,
    fetchImpl: localOnlyFetch(),
    timeoutMs: 500,
    log: (message) => logs.push(message),
  });
  assert.deepEqual(out.items, []);
  assert.equal(out.home.ok, false);
  assert.ok(out.error.includes('站点不可达'), out.error);
  assert.ok(out.fetched.length >= 1, '候选页要逐页写清"为什么没试"');
  assert.ok(out.fetched.every((report) => report.ok === false && report.error.includes('首页就不可达')));
  assert.ok(logs.length > 0, '日志要打出来（调用方靠它排错）');
});

test('栏目直读：不给 site 也不给 url 时不发请求、不抛错（对外的形状永远一致）', async () => {
  const out = await readSiteNews({ fetchImpl: localOnlyFetch() });
  assert.deepEqual(out.items, []);
  assert.deepEqual(out.fetched, []);
  assert.equal(out.site, null);
  assert.ok(out.error.includes('需要 site 或 url'));
  assert.equal(COLUMN_LIMIT_DEFAULT, 10, '默认取 10 条');
});

// ---------------------------------------------------------------------------
// 3. 解析函数本身 + 问法里认站点
// ---------------------------------------------------------------------------

test('parser：`parseColumnList` 只认带日期的行，跨域与导航一律不进（可单独测）', () => {
  const items = parseColumnList(SAE_NEWS, {
    baseUrl: 'https://sae.xjtu.edu.cn/index/zhxw.htm',
    allowHosts: ['sae.xjtu.edu.cn'],
  });
  assert.equal(items.length, 7, '10 行里只留 7 条（跨域 1 条、导航 2 条丢掉）');
  assert.ok(items.every((item) => item.url.startsWith('https://sae.xjtu.edu.cn/')));
  assert.ok(items.every((item) => item.publishedAt));
  assert.deepEqual(parseColumnList('', { baseUrl: 'https://sae.xjtu.edu.cn/', allowHosts: ['sae.xjtu.edu.cn'] }), []);
  assert.deepEqual(parseColumnList(SAE_NEWS, { baseUrl: 'https://sae.xjtu.edu.cn/' }), [], '没有白名单就不解析（免得把别校的列表当成本站）');
});

test('parser：标题里"贴着的日期"只在等于本行发布日期时才剥掉（崇实书院的真实形态）', () => {
  const glued = `<ul>
<li><span class="time">2023-09-07</span><a href="info/1002/4613.htm">09-07【2023崇实“崇”你】崇实书院拍了拍你说“一切准备就绪”</a></li>
<li><span class="time">2026-10-12</span><a href="info/1002/4614.htm">10-12月工作安排</a></li>
</ul>`;
  const items = parseColumnList(glued, { baseUrl: 'https://cssy.xjtu.edu.cn/sydt.htm', allowHosts: ['cssy.xjtu.edu.cn'] });
  assert.equal(items[0].title, '【2023崇实“崇”你】崇实书院拍了拍你说“一切准备就绪”', '贴在前面的日期正好是本行发布日期 → 剥掉');
  assert.equal(items[1].title, '10-12月工作安排', '不是日期前缀（真标题）就不许动 —— 剥完只剩 5 个字，宁可留着');
});

test('问法里认站点：别名取最长命中，认不出就返回 null（认不出就不读，免得读错站）', () => {
  assert.equal(findCampusSiteForQuery('最近 航天航空学院 有什么新闻')?.id, 'sae');
  assert.equal(findCampusSiteForQuery('航院最近的通知')?.id, 'sae');
  assert.equal(findCampusSiteForQuery('彭康书院最新动态')?.id, 'pksy');
  assert.equal(findCampusSiteForQuery('文治书院有什么讲座')?.id, 'wen');
  assert.equal(findCampusSiteForQuery('教务处最近的通知')?.id, 'dean');
  assert.equal(findCampusSiteForQuery('sae.xjtu.edu.cn 上的新闻')?.id, 'sae', '直接写域名也认');
  assert.equal(findCampusSiteForQuery('最近有什么新闻'), null, '没点名站点就不认（否则会读错站）');
  assert.equal(findCampusSiteForQuery('图书馆最新通知')?.id, 'library', '"图书馆"要认出来，读不到时如实说读不到');
  // 问法判据
  assert.equal(looksLikeNewsQuery('最近 航天航空学院 新闻'), true);
  assert.equal(looksLikeNewsQuery('最近有什么通知'), true);
  assert.equal(looksLikeNewsQuery('转专业学分怎么算'), false, '不是"要最新列表"的问法不该多花请求');
});

// ---------------------------------------------------------------------------
// 4. 端到端：campus 档里栏目直读要**真的被用上**，并排在招生类结果前面
// ---------------------------------------------------------------------------

/** 站内检索（`/search.jsp`）返回的招生/教务类结果：相关度高，但不是"最新新闻"。 */
function vsbAdmissionPage() {
  // 链接写成绝对地址：真页面是相对的，而相对链接会相对**请求 URL**（测试里是 127.0.0.1）
  // 解析，域名白名单一过就没了 —— 站内直搜的测试历来用绝对地址（见 campus-search.test.js）
  return `<html><body><ul>
<li><span class="time">2026-07-31</span><a href="https://sae.xjtu.edu.cn/info/1093/9800.htm">航天航空学院2026年转专业工作实施方案</a></li>
<li><span class="time">2026-07-25</span><a href="https://sae.xjtu.edu.cn/info/1093/9790.htm">航天航空学院本科生转专业拟录取名单公示</a></li>
</ul></body></html>`;
}

function bingHtml(items) {
  return `<!doctype html><html><body><ol id="b_results">${items
    .map((item) => `<li class="b_algo"><h2><a href="${item.url}">${item.title}</a></h2><div class="b_caption"><p>${item.snippet}</p></div></li>`)
    .join('')}</ol></body></html>`;
}

test('端到端：campus 档"最近 航天航空学院 新闻" → 栏目直读条目 matchedBy=column、带 publishedAt，且排在招生类结果前面', async () => {
  const world = await startFakeServer(({ url, finish }) => {
    if (url.pathname === '/') return finish(200, SAE_HOME);
    if (url.pathname === '/index/zhxw.htm') return finish(200, SAE_NEWS);
    if (url.pathname === '/search.jsp') return finish(200, vsbAdmissionPage());
    if (url.pathname === '/bing') {
      // 公共结果页这一路：给一条公网结果，证明它不会插到栏目直读前面去
      return finish(200, bingHtml([
        { title: '航天航空学院新闻（公网转载）', url: 'https://news.example.com/sae', snippet: '西安交通大学航天航空学院' },
      ]));
    }
    return finish(404, 'nope');
  });
  try {
    const log = [];
    const detail = await searchWebDetailed({
      query: '最近 航天航空学院 新闻',
      mode: 'campus',
      limit: 10,
      config: {},
      sites: [saeSite(world, { path: '/search.jsp?wbtreeid=1001', keyField: 'lucenenewssearchkey' })],
      fetchImpl: localOnlyFetch(),
      endpoints: { bing: `${world.base}/bing` },
      probeCampus: false,
      log: (message) => log.push(message),
    });

    const columns = detail.results.filter((item) => item.matchedBy === 'column');
    assert.ok(columns.length >= 3, `栏目直读条目要出现在结果里：${JSON.stringify(detail.results.map((r) => r.matchedBy))}`);
    assert.ok(columns.every((item) => item.publishedAt), '栏目条目必须带 publishedAt');
    assert.ok(columns.every((item) => item.scope === 'campus' && item.site === 'sae'));
    assert.equal(columns[0].publishedAt, '2026-06-20', '同分条目保持 readSiteNews 的日期倒序');

    // 招生类结果（站内直搜命中）仍在，但必须排在栏目直读之后
    const siteItems = detail.results.filter((item) => item.matchedBy === 'site');
    assert.ok(siteItems.length >= 1, '站内直搜的招生/教务类结果不该消失');
    const lastColumnIndex = detail.results.map((item) => item.matchedBy).lastIndexOf('column');
    const firstSiteIndex = detail.results.map((item) => item.matchedBy).indexOf('site');
    assert.ok(
      lastColumnIndex < firstSiteIndex,
      `栏目直读要排在站内直搜（招生栏目）前面：${detail.results.map((item) => `${item.matchedBy}:${item.title.slice(0, 8)}`).join(' | ')}`,
    );
    // 公网上那条（相关度不低）只能排在两者后面
    const publicItem = detail.results.find((item) => item.url === 'https://news.example.com/sae');
    if (publicItem) {
      assert.ok(detail.results.indexOf(publicItem) > firstSiteIndex, '公网转载排在最后');
    }

    assert.equal(MATCHED_BY_RANK.column, 0, 'column 是最高优先档');
    assert.ok(detail.columnRead, '诊断信息要带出来（界面/模型据此说明这次读了哪个栏目页）');
    assert.equal(detail.columnRead.site, 'sae');
    assert.equal(detail.columnRead.newest, '2026-06-20');
    assert.ok(
      detail.notes.some((line) => line.includes('栏目直读 3 条') || line.includes('栏目直读')),
      `notes 要写清栏目通道命中多少条：${detail.notes.join(' / ')}`,
    );
    assert.ok(detail.notes.some((line) => line.includes('publishedAt')), 'notes 要提示按 publishedAt 排序作答');
  } finally {
    await world.close();
  }
});

test('端到端：不是"要最新列表"的问法（或认不出站点）时**不做**栏目直读，省掉那几次请求', async () => {
  const world = await startFakeServer(({ url, finish }) => {
    if (url.pathname === '/') return finish(200, SAE_HOME);
    if (url.pathname === '/index/zhxw.htm') return finish(200, SAE_NEWS);
    if (url.pathname === '/search.jsp') return finish(200, vsbAdmissionPage());
    if (url.pathname === '/bing') return finish(200, bingHtml([]));
    return finish(404, 'nope');
  });
  try {
    const detail = await searchWebDetailed({
      query: '转专业学分怎么算',
      mode: 'campus',
      limit: 10,
      config: {},
      sites: [saeSite(world, { path: '/search.jsp?wbtreeid=1001', keyField: 'lucenenewssearchkey' })],
      fetchImpl: localOnlyFetch(),
      endpoints: { bing: `${world.base}/bing` },
      probeCampus: false,
    });
    assert.equal(detail.columnRead, null, '不是"要最新列表"的问法就不读栏目页');
    assert.ok(!detail.results.some((item) => item.matchedBy === 'column'));
    assert.ok(!world.state.requests.some((request) => request.path === '/index/zhxw.htm'), '不该去抓栏目页');
  } finally {
    await world.close();
  }
});
