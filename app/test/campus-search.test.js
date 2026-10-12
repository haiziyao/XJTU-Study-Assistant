/**
 * 校内站点直搜（campus 档第 ① 条通道）的测试。
 *
 * **绝不访问真实外网**：所有"校内站点""搜索引擎"都是本文件里用 `node:http` 起的假服务器，
 * 通过注入 `fetchImpl` 接进去；`localOnlyFetch()` 在发请求前检查 host，一旦有代码打到真实域名
 * 就立刻抛错（"忘记注入 fetch"会马上暴露，而不是偷偷联网）。
 *
 * 覆盖点：
 *   站内直搜解析（标题/日期/摘要）/ 只留本站域名 / `matchedBy: 'site'` /
 *   站点级并发上限 3 / 单站点 500 与超时的隔离 + notes 写清原因 /
 *   站内直搜为空时退回公共结果页（不空手而归）/
 *   campus 档排序 site > domain > mention > web /
 *   真实模板的解析形态（教务处 / 航天学院 / 新闻网 / 门户那种"没有高亮就别信"的页面）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  CAMPUS_SEARCH_CONCURRENCY,
  CAMPUS_SITE_SEARCH,
  MATCHED_BY_RANK,
  base64Utf8,
  buildCampusSiteSearchBody,
  isCampusUrl,
  matchedByRank,
  parseVsbSearchResults,
  searchCampusSites,
  searchWebDetailed,
} from '../src/modules/ai/web-search.js';

const realFetch = globalThis.fetch;

/** 只允许打到 127.0.0.1 的 fetch 包装（照 web-search.test.js 的做法）。 */
function localOnlyFetch(record = []) {
  return async (url, init = {}) => {
    const target = String(url);
    const host = new URL(target).hostname;
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
      throw new Error(`测试禁止访问真实网络：${target}`);
    }
    record.push({ url: target, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
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
      state.requests.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body });
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

/** 一个"确定没人监听"的端口：起一个再关掉。 */
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

const DEAN_A = 'https://dean.xjtu.edu.cn/info/1095/10422.htm';
const DEAN_B = 'https://dean.xjtu.edu.cn/info/1095/10413.htm';
const GS_A = 'https://gs.xjtu.edu.cn/info/1233/6056.htm';
const OFF_SITE = 'https://spam.example.net/ad';

/** 教务处那种模板：`<UL>` + `<li><span class="time">日期</span><a href="info/...">标题</a></li>`。 */
function vsbListPage({ items, keyword = '转专业', highlight = true, nav = true }) {
  const mark = (title) =>
    highlight && keyword
      ? title.replace(
        keyword,
        `<span class="keywordfontcolor1091141">${keyword}</span>`,
      )
      : title;
  const rows = items
    .map((item) => `<li>\n<span class="time">${item.date ?? ''}</span>\n<a href="${item.url}">${mark(item.title)}</a></li>`)
    .join('\n');
  return `<!doctype html><html><head><title>搜索结果页</title></head><body>
<div class="nav"><ul>
  <li><a href="index.htm">首页</a></li>
  <li><a href="gypk/syjj.htm">关于我们</a></li>
  ${nav ? '<li><a href="xynr.jsp?urltype=tree.TreeTempUrl&wbtreeid=1001">教学服务</a></li>' : ''}
</ul></div>
<UL>
${rows}
</UL>
</body></html>`;
}

// ---------------------------------------------------------------------------
// 1. 站内直搜：解析、域名过滤、并发、失败隔离
// ---------------------------------------------------------------------------

/** 四个假校内站点：dean（正常）、gs（字段名不同、无高亮但有日期）、boom（500）、slow（超时）。 */
async function startCampusWorld() {
  const world = await startFakeServer(({ url, finish }) => {
    if (url.pathname === '/dean/search.jsp') {
      return finish(
        200,
        vsbListPage({
          items: [
            { title: '关于2026年本科生转专业拟录取名单的通知', url: DEAN_A, date: '2026-07-31' },
            { title: '2026年转专业工作实施方案', url: DEAN_B, date: '2026-07-25' },
            // 校外结果：站内直搜必须丢掉（只留本站域名）
            { title: '转专业培训机构', url: OFF_SITE, date: '2026-07-01' },
            // == 导航入口（.jsp），不是内容页
            { title: '转专业在线服务大厅', url: 'xynr.jsp?urltype=tree.TreeTempUrl&wbtreeid=9', date: '2026-07-02' },
          ],
        }),
      );
    }
    if (url.pathname === '/gs/search.jsp') {
      // 研究生院：字段名是 keyword 版，页面**没有关键词高亮**，只能靠发布日期认结果
      return finish(
        200,
        vsbListPage({
          highlight: false,
          items: [{ title: '研究生转专业实施细则', url: GS_A, date: '2025-01-17' }],
        }),
      );
    }
    if (url.pathname === '/boom/search.jsp') return finish(500, '<html>boom</html>');
    if (url.pathname === '/slow/search.jsp') return undefined; // 永不响应 → 走超时
    return finish(404, '<html>nope</html>');
  });
  const sites = [
    { id: 'dean', label: '教务处（假）', host: 'dean.xjtu.edu.cn', origin: world.base, path: '/dean/search.jsp?wbtreeid=1001', keyField: 'lucenenewssearchkey' },
    { id: 'gs', label: '研究生院（假）', host: 'gs.xjtu.edu.cn', origin: world.base, path: '/gs/search.jsp?wbtreeid=1111', keyField: 'lucenenewssearchkeyword' },
    { id: 'boom', label: '会 500 的站（假）', host: 'boom.xjtu.edu.cn', origin: world.base, path: '/boom/search.jsp' },
    { id: 'slow', label: '会超时的站（假）', host: 'slow.xjtu.edu.cn', origin: world.base, path: '/slow/search.jsp' },
  ];
  return { ...world, sites };
}

test('站内直搜：解析出标题/日期，只留本站域名，标 matchedBy=site 与来源站点', async () => {
  const world = await startCampusWorld();
  try {
    const out = await searchCampusSites({
      query: '转专业',
      limit: 8,
      fetchImpl: localOnlyFetch(),
      sites: world.sites.slice(0, 2),
      timeoutMs: 1_000,
    });

    assert.equal(out.results.length, 3, 'dean 2 条（校外那条与 .jsp 导航被丢）+ gs 1 条');
    assert.ok(out.results.every((item) => isCampusUrl(item.url)), '只允许 *.xjtu.edu.cn');
    assert.ok(out.results.every((item) => item.scope === 'campus'));
    assert.ok(out.results.every((item) => item.matchedBy === 'site'));
    assert.deepEqual(out.results.map((item) => item.site), ['dean', 'dean', 'gs']);
    assert.ok(!out.results.some((item) => item.url === OFF_SITE), '别的网站的链接必须丢掉');
    assert.ok(!out.results.some((item) => item.url.includes('.jsp')), '导航入口不是检索结果');

    const first = out.results[0];
    assert.equal(first.title, '关于2026年本科生转专业拟录取名单的通知', '标题里的关键词高亮标签要剥掉');
    assert.equal(first.url, DEAN_A);
    assert.equal(first.snippet, '发布日期：2026-07-31');
    assert.equal(first.source, 'campus-site');

    // 请求形状：POST 表单 + base64(UTF-8) 关键词 + 两个必需参数
    const deanRequest = world.state.requests.find((request) => request.path === '/dean/search.jsp');
    const params = new URLSearchParams(deanRequest.body);
    assert.equal(deanRequest.method, 'POST');
    assert.equal(params.get('lucenenewssearchkey'), '6L2s5LiT5Lia', '「转专业」的 base64(UTF-8)');
    assert.equal(params.get('_lucenesearchtype'), '1');
    assert.equal(params.get('searchScope'), '0');

    // 每个站点用自己的字段名（研究生院是 lucenenewssearchkeyword）
    const gsRequest = world.state.requests.find((request) => request.path === '/gs/search.jsp');
    assert.equal(new URLSearchParams(gsRequest.body).get('lucenenewssearchkeyword'), '6L2s5LiT5Lia');

    assert.ok(out.notes.some((line) => line.includes('站内直搜命中 3 条')));
    assert.ok(out.notes.some((line) => line.includes('dean 2 条')), 'notes 要写清每个站点各出多少');
  } finally {
    await world.close();
  }
});

test('站内直搜：单站点 500/超时不影响其它站点，sites[] 与 notes 都写明原因', async () => {
  const world = await startCampusWorld();
  try {
    const logs = [];
    const out = await searchCampusSites({
      query: '转专业',
      limit: 8,
      fetchImpl: localOnlyFetch(),
      sites: world.sites,
      timeoutMs: 200, // slow 站点会在这个时间内被 AbortController 掐掉
      log: (message) => logs.push(message),
    });

    const byId = Object.fromEntries(out.sites.map((report) => [report.id, report]));
    assert.equal(byId.dean.ok, true);
    assert.equal(byId.dean.count, 2);
    assert.equal(byId.gs.ok, true, '别的站点失败不该拖垮它');
    assert.equal(byId.boom.ok, false);
    assert.match(byId.boom.error, /500/);
    assert.equal(byId.slow.ok, false);
    assert.match(byId.slow.error, /超时|中断/);

    assert.equal(out.results.length, 3, '两个坏站点不影响 dean/gs 的结果');
    assert.ok(out.notes.some((line) => line.includes('站内直搜失败：会 500 的站（假）（boom）') && line.includes('500')));
    assert.ok(out.notes.some((line) => line.includes('（slow）') && /超时|中断/.test(line)));
    assert.ok(logs.some((line) => line.includes('站内直搜失败')), '失败也要进日志，便于排查');
  } finally {
    await world.close();
  }
});

test('站内直搜：站点级并发不超过 3，且每站结果数受 limit 约束', async () => {
  const world = await startFakeServer(({ url, finish }) => {
    if (url.pathname.endsWith('/search.jsp')) {
      const items = Array.from({ length: 9 }, (_, index) => ({
        title: `转专业结果 ${index + 1} 条通知`,
        url: `https://${url.pathname.split('/')[1]}.xjtu.edu.cn/info/1/${index}.htm`,
        date: '2026-07-01',
      }));
      return setTimeout(() => finish(200, vsbListPage({ items })), 60);
    }
    return finish(404, 'nope');
  });
  const sites = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
    id,
    label: `站点 ${id}`,
    host: `${id}.xjtu.edu.cn`,
    origin: world.base,
    path: `/${id}/search.jsp`,
  }));
  try {
    const out = await searchCampusSites({
      query: '转专业',
      limit: 5,
      fetchImpl: localOnlyFetch(),
      sites,
      concurrency: 9, // 越界 → 收敛到并发上限 3
      timeoutMs: 2_000,
    });
    assert.equal(out.results.length, 25, '5 个站点 × 每站 5 条');
    assert.ok(world.state.maxInFlight <= CAMPUS_SEARCH_CONCURRENCY, `同时在飞的请求 ${world.state.maxInFlight} 不该超过 3`);
    assert.ok(world.state.maxInFlight > 1, '并发要真的并发（否则 5 个站点白等）');
  } finally {
    await world.close();
  }
});

test('站内直搜：working=false 的站点不发请求，只记一笔跳过', async () => {
  const world = await startCampusWorld();
  try {
    const out = await searchCampusSites({
      query: '转专业',
      fetchImpl: localOnlyFetch(),
      sites: [...world.sites.slice(0, 1), { id: 'library', label: '图书馆', host: 'library.xjtu.edu.cn', working: false, reason: '实测连接超时' }],
      timeoutMs: 500,
    });
    assert.equal(world.state.requests.filter((request) => request.path.includes('library')).length, 0);
    assert.ok(out.notes.some((line) => line.includes('跳过 1 个已知不可用')));
    assert.equal(out.results.length, 2);
  } finally {
    await world.close();
  }
});

// ---------------------------------------------------------------------------
// 2. 解析器：真页面形态
// ---------------------------------------------------------------------------

test('解析器：航天学院模板（标题在 h3、日期在 a 内的 .a-date）', () => {
  const html = `<ul>
<li><a href="info/1091/8801.htm">
        <div class="a-date"><b>28</b><span>2025.05</span></div>
        <div class="a-tx"><h3>2025年航天航空学院本科生<span class="keywordfontcolor1076033">转</span><span class="keywordfontcolor1076033">专业</span>工作实施方案</h3></div>
    </a></li>
<li><a href="info/1086/8474.htm">
        <div class="a-date"><b>21</b><span>2015.04</span></div>
        <div class="a-tx"><h3>数学与统计学院接收本科生转专业实施办法</h3></div>
    </a></li>
</ul>`;
  const items = parseVsbSearchResults(html, { baseUrl: 'https://sae.xjtu.edu.cn/search.jsp?wbtreeid=1001', allowHosts: ['sae.xjtu.edu.cn'] });
  assert.equal(items.length, 2);
  assert.equal(items[0].title, '2025年航天航空学院本科生转专业工作实施方案', '标题取 h3，不能把日期块读进来');
  assert.equal(items[0].url, 'https://sae.xjtu.edu.cn/info/1091/8801.htm');
  assert.equal(items[0].snippet, '发布日期：2025-05');
});

test('解析器：新闻网模板（标题 class=bt、摘要 class=zy2、日期 2026年07）', () => {
  const html = `<ul class="listq1-1 clearfix">
<li class="clearfix"><div class="fl bor"><a href="../info/1033/233442.htm" class="y">2026年07</a><a href="../info/1033/233442.htm" class="r">04</a></div>
  <div class="fr zws"><a href="../info/1033/233442.htm" class="bt">【中国教育报】报道西安交大本科<span class="keywordfontcolor257441">转</span><span class="keywordfontcolor257441">专业</span>政策</a>
  <a href="../info/1033/233442.htm" class="zy2">，从大一起就让学生进入科研项目，学院党委书记、院长亲自抓教学、带团队，通过优化培养方案提升教学质量。</a></div></li>
</ul>`;
  const items = parseVsbSearchResults(html, { baseUrl: 'https://news.xjtu.edu.cn/xmb/ssjgg.jsp?wbtreeid=1001', allowHosts: ['news.xjtu.edu.cn'] });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '【中国教育报】报道西安交大本科转专业政策');
  assert.equal(items[0].url, 'https://news.xjtu.edu.cn/info/1033/233442.htm', '../info/… 要相对结果页解析');
  assert.ok(items[0].snippet.startsWith('，从大一起'), '摘要锚（class=zy2）要当 snippet');
});

test('解析器：门户那种"没有高亮就别信"的页面 —— 没高亮且没日期时返回 0 条，不把默认推荐当结果', () => {
  const list = `<div class="list_rsou"><ul>
<li><a href="http://news.xjtu.edu.cn/info/1004/216356.htm">西安交大科研团队实现二维材料高通量制备</a></li>
<li><a href="http://news.xjtu.edu.cn/info/1033/229465.htm">【中国日报】Elite study program reforms</a></li>
</ul></div>`;
  // ① 有关键词高亮（真命中）→ 认这些条目（门户搜的是整个 xjtu.edu.cn，所以 allowHosts 放宽）
  const hit = list.replace('西安交大科研团队', '<span style="color:#dd4b39" >西安交大</span>科研团队');
  const kept = parseVsbSearchResults(hit, { baseUrl: 'https://www.xjtu.edu.cn/soso_2.jsp?wbtreeid=1001', allowHosts: ['xjtu.edu.cn'] });
  assert.equal(kept.length, 2);
  assert.equal(kept[0].url, 'http://news.xjtu.edu.cn/info/1004/216356.htm', '门户的结果可以落在别的校内子域');
  // ② 垃圾查询：服务端返回的是一版"默认推荐"，没有高亮也没有日期 → 一条都不认
  const junk = parseVsbSearchResults(list, { baseUrl: 'https://www.xjtu.edu.cn/soso_2.jsp?wbtreeid=1001', allowHosts: ['xjtu.edu.cn'] });
  assert.deepEqual(junk, [], '宁可报 0 条，也不能把无关的默认列表当成检索结果');
});

test('解析器：没有检索结果的空页（一堆导航 li）→ 0 条，绝不把菜单当结果', () => {
  const navRows = Array.from({ length: 60 }, (_, index) => `<li><a href="zjjw/bmjs${index}.htm">机构设置与部门介绍</a></li>`).join('\n');
  const html = `<html><body><ul>${navRows}</ul><div class="nav2"><span>搜索结果页</span></div></body></html>`;
  assert.deepEqual(parseVsbSearchResults(html, { baseUrl: 'https://dean.xjtu.edu.cn/search.jsp', allowHosts: ['dean.xjtu.edu.cn'] }), []);
});

test('解析器：校外链接、javascript:、静态资源一律不进结果', () => {
  const html = `<ul>
<li><span class="time">2026-07-31</span><a href="https://evil.example.com/转专业.htm">转专业通知（仿冒）</a></li>
<li><span class="time">2026-07-30</span><a href="javascript:void(0)">转专业在线咨询</a></li>
<li><span class="time">2026-07-29</span><a href="files/转专业名单.pdf">转专业名单下载</a></li>
<li><span class="time">2026-07-28</span><a href="images/转专业.banner.jpg">转专业宣传图</a></li>
<li><span class="time">2026-07-27</span><a href="xynr.jsp?wbtreeid=9">转专业在线办理入口</a></li>
<li><span class="time">2026-07-26</span><a href="/info/1/2.htm">转专业结果公示</a></li>
</ul>`;
  const items = parseVsbSearchResults(html, { baseUrl: 'https://dean.xjtu.edu.cn/search.jsp', allowHosts: ['dean.xjtu.edu.cn'] });
  assert.deepEqual(items.map((item) => item.title), ['转专业结果公示']);
});

// ---------------------------------------------------------------------------
// 3. 与 campus 档接线：回退公共结果页 + 排序
// ---------------------------------------------------------------------------

/** Bing 假结果页（结果块结构照 web-search.test.js 的写法）。 */
function bingHtml(items) {
  return `<!doctype html><html><body><ol id="b_results">${items
    .map((item) => `<li class="b_algo"><h2><a href="${item.url}">${item.title}</a></h2><div class="b_caption"><p>${item.snippet}</p></div></li>`)
    .join('')}</ol></body></html>`;
}

const PUBLIC_A = 'https://example.com/news/1'; // 与本校无关的公网结果
const PUBLIC_B = 'https://blog.example.org/post/42'; // 摘要里提到"西安交通大学"

test('campus：站内直搜为空时退回公共结果页，结果标 matchedBy=domain 且不空手而归', async () => {
  const world = await startFakeServer(({ url, finish }) => {
    if (url.pathname === '/dean/search.jsp') {
      // 站内直搜：站点可达，但这个词在站内没有内容（真网里很常见）
      return finish(200, vsbListPage({ items: [], keyword: '不存在的词' }));
    }
    if (url.pathname === '/bing') {
      const query = url.searchParams.get('q') ?? '';
      if (/site:xjtu\.edu\.cn/i.test(query)) {
        return finish(200, bingHtml([
          { title: '教务处：转专业工作实施方案', url: DEAN_A, snippet: '西安交通大学教务处发布' },
          // 校外广告：它把校名与关键词都写上了（现实里就是这样），所以能过相关度这关，
          // 但必须被**域名过滤**挡掉 —— 这两道闸门是分开的
          { title: '转专业保过班（西安交通大学旁）', url: OFF_SITE, snippet: '西安交通大学 转专业 保过班' },
        ]));
      }
      return finish(200, bingHtml([{ title: '转专业全网讨论', url: PUBLIC_A, snippet: '与本校无关的转专业讨论' }]));
    }
    return finish(404, 'nope');
  });
  const port = await deadPort();
  const logs = [];
  try {
    const detail = await searchWebDetailed({
      query: '转专业',
      mode: 'campus',
      config: {},
      fetchImpl: localOnlyFetch(),
      endpoints: { bing: `${world.base}/bing` },
      probes: [{ url: `http://127.0.0.1:${port}/`, label: '探测点（不可达）' }],
      sites: [{ id: 'dean', label: '教务处（假）', host: 'dean.xjtu.edu.cn', origin: world.base, path: '/dean/search.jsp' }],
      log: (message) => logs.push(message),
    });

    assert.equal(detail.results.length, 1, '站内直搜 0 条 → 公共结果页兜住，不能空手而归');
    assert.equal(detail.results[0].url, DEAN_A);
    assert.equal(detail.results[0].scope, 'campus');
    assert.equal(detail.results[0].matchedBy, 'domain');
    assert.ok(detail.siteSearch, 'campus 档要把站内直搜的诊断信息带出来');
    assert.equal(detail.siteSearch.sites[0].ok, true);
    assert.equal(detail.siteSearch.sites[0].count, 0);
    assert.ok(detail.notes.some((line) => line.includes('站内直搜没有命中任何条目')));
    assert.ok(detail.notes.some((line) => line.includes('结果页解析成功')), '公共结果页的成功也要记一笔');
    assert.ok(detail.notes.some((line) => line.includes('站内直搜 0 条')), 'notes 要写清每条通道各出多少');
    assert.ok(detail.notes.some((line) => line.includes('公共结果页校内域名 1 条')));
  } finally {
    await world.close();
  }
});

test('campus：排序 site > domain > mention > web（同档内保持原顺序）', async () => {
  const world = await startFakeServer(({ url, finish }) => {
    if (url.pathname === '/dean/search.jsp') {
      return finish(200, vsbListPage({
        items: [
          { title: '站内直搜：转专业拟录取名单', url: DEAN_A, date: '2026-07-31' },
          { title: '站内直搜：转专业实施方案', url: DEAN_B, date: '2026-07-25' },
        ],
      }));
    }
    if (url.pathname === '/bing') {
      const query = url.searchParams.get('q') ?? '';
      if (/site:xjtu\.edu\.cn/i.test(query)) {
        // 公共结果页这一路（`site:` 收窄）：只留校内域名那条（domain）；
        // 别的学校的页面（哪怕内容相关）会被 dedupeResults 按域名挡掉，不会混进校内档
        return finish(200, bingHtml([
          { title: '研究生院转专业细则', url: GS_A, snippet: '西安交通大学研究生院' },
          { title: '北京大学的转专业管理办法', url: 'https://dean.pku.edu.cn/info/1.htm', snippet: '与西安交通大学等高校的转专业交流' },
        ]));
      }
      // 探测可达后才并走的那一路公网检索：一条只是提到校名（mention）、一条与本校无关但相关（web）
      return finish(200, bingHtml([
        { title: '西安交通大学转专业经验分享（外部博客）', url: PUBLIC_B, snippet: '西安交通大学 转专业 经历' },
        { title: '转专业经验分享：从迷茫到笃定', url: PUBLIC_A, snippet: '转专业之前先想清楚' },
      ]));
    }
    return finish(404, 'nope');
  });
  try {
    const detail = await searchWebDetailed({
      query: '转专业',
      mode: 'campus',
      limit: 10,
      config: {},
      fetchImpl: localOnlyFetch(),
      endpoints: { bing: `${world.base}/bing` },
      probes: [{ url: `${world.base}/dean/search.jsp`, label: '探测点（可达）' }],
      sites: [{ id: 'dean', label: '教务处（假）', host: 'dean.xjtu.edu.cn', origin: world.base, path: '/dean/search.jsp' }],
    });

    assert.equal(detail.campus.onCampus, true);
    assert.equal(detail.results[4].matchedBy, undefined, '公网结果不带 matchedBy（界面上按 web 展示）');
    assert.deepEqual(
      detail.results.map((item) => [item.scope, item.matchedBy ?? 'web', item.url]),
      [
        ['campus', 'site', DEAN_A],
        ['campus', 'site', DEAN_B],
        ['campus', 'domain', GS_A],
        ['campus', 'mention', PUBLIC_B],
        ['web', 'web', PUBLIC_A],
      ],
      'site > domain > mention > web，同档内保持通道产出顺序',
    );
    assert.ok(!detail.results.some((item) => item.url.includes('dean.pku.edu.cn')), '公共结果页里的别校结果必须被挡掉');
    assert.ok(detail.notes.some((line) => line.includes('站内直搜 2 条')));
    assert.ok(detail.notes.some((line) => line.includes('公网提到本校 1 条')));
    assert.ok(detail.notes.some((line) => line.includes('其它公网 1 条')));
  } finally {
    await world.close();
  }
});

test('campus：参数不合法/缺省时不炸（limit 收敛、sites 缺省、检索词为空）', async () => {
  const out = await searchCampusSites({ query: '   ', fetchImpl: localOnlyFetch() });
  assert.deepEqual(out.results, []);
  assert.ok(out.notes.some((line) => line.includes('检索词为空')));

  const noSites = await searchCampusSites({ query: '转专业', sites: [{ id: 'x', host: 'x.xjtu.edu.cn', working: false }] });
  assert.deepEqual(noSites.results, []);
  assert.ok(noSites.notes.some((line) => line.includes('没有可用站点')));
});

// ---------------------------------------------------------------------------
// 4. 配置表与工具函数
// ---------------------------------------------------------------------------

test('配置表：可直搜的条目字段齐全，不可用的条目必须写清原因', () => {
  const ids = CAMPUS_SITE_SEARCH.map((site) => site.id);
  assert.equal(new Set(ids).size, ids.length, 'id 不能重复');
  for (const site of CAMPUS_SITE_SEARCH) {
    assert.ok(site.host.endsWith('xjtu.edu.cn'), `${site.id} 必须是校内站点`);
    assert.ok(site.label, `${site.id} 要有中文名`);
    if (site.working === false) {
      assert.ok(site.reason, `${site.id} 标了 working:false 就必须写清原因`);
      assert.equal(site.path, undefined, '不可用的条目不该留一条会误导人的搜索路径');
      continue;
    }
    assert.match(site.path, /\.jsp\?wbtreeid=\d+$/, `${site.id} 的搜索路径要带 wbtreeid`);
    assert.match(site.keyField, /^lucenenewssearchkey(word)?$/, `${site.id} 的字段名必须是实测过的那两种之一`);
    assert.ok(site.evidence, `${site.id} 要写明实测日期与结果条数`);
  }
  // 优先级常量本身
  assert.deepEqual(MATCHED_BY_RANK, { site: 0, domain: 1, mention: 2, web: 3 });
  assert.equal(matchedByRank({ scope: 'campus', matchedBy: 'site' }), 0);
  assert.equal(matchedByRank({ scope: 'campus' }), 1, 'campus 档没写 matchedBy 的按 domain 算');
  assert.equal(matchedByRank({ scope: 'web', matchedBy: 'site' }), 3, '域外结果一律最低档');
});

test('工具函数：base64(UTF-8) 与请求体形状（实测过的那些站点都吃这一套）', () => {
  assert.equal(base64Utf8('转专业'), '6L2s5LiT5Lia');
  assert.equal(base64Utf8('通知'), '6YCa55+l');
  assert.equal(base64Utf8('abc'), 'YWJj');
  assert.equal(base64Utf8(''), '');

  const body = buildCampusSiteSearchBody({ keyField: 'lucenenewssearchkey' }, '转专业');
  const params = new URLSearchParams(body);
  assert.equal(params.get('lucenenewssearchkey'), '6L2s5LiT5Lia');
  assert.equal(params.get('_lucenesearchtype'), '1');
  assert.equal(params.get('searchScope'), '0');
});


// ---------------------------------------------------------------------------
// 排序：站内直搜的结果必须**按相关度**排，而不是按"哪个站点先被查"
// ---------------------------------------------------------------------------

/**
 * 这条来自真机反馈，值得单独锁死：
 * 用户问「最近有什么单位来访我们航空航天学院吗」，站内直搜其实**抓到了**航院那几条
 * （"中国工程物理研究院…来访航天航空学院并做技术交流"），但 12 个站点共 113 条候选
 * 是按站点顺序（教务处排第一）截前 10 条的 → 航院的结果全被教务处的竞赛/学籍通知挤掉，
 * 模型看到的就是"只搜到教务处、跟来访无关"，于是它如实回答"搜不到"（那是产品的错，不是模型的错）。
 */
test('站内直搜结果按相关度排序：问"学院来访"时，航院的来访新闻要排在教务处通知前面', async () => {
  const world = await startFakeServer(({ url, finish }) => {
    if (url.pathname === '/dean/search.jsp') {
      // 教务处：标题里只有"航天航空学院"这个限定词，讲的是竞赛与转专业 —— 与"来访"无关
      return finish(
        200,
        vsbListPage({
          keyword: '',
          items: [
            { title: '关于组织参加第十八届蓝桥杯全国大学生软件大赛的通知', url: DEAN_A, date: '2026-07-31' },
            { title: '2021年航天航空学院本科生转专业工作实施方案', url: DEAN_B, date: '2021-06-01' },
          ],
        }),
      );
    }
    if (url.pathname === '/sae/search.jsp') {
      // 航院：真正在讲"来访/交流"的新闻
      return finish(
        200,
        vsbListPage({
          keyword: '来访',
          items: [
            { title: '厦门大学航空航天学院来院交流调研', url: 'https://sae.xjtu.edu.cn/info/1056/7457.htm', date: '2026-06-20' },
            { title: '河南理工大学来访航天航空学院', url: 'https://sae.xjtu.edu.cn/info/1056/7458.htm', date: '2026-06-10' },
          ],
        }),
      );
    }
    return finish(404, '<html>nope</html>');
  });

  const sites = [
    { id: 'dean', label: '教务处（假）', host: 'dean.xjtu.edu.cn', origin: world.base, path: '/dean/search.jsp?wbtreeid=1001', keyField: 'lucenenewssearchkey' },
    { id: 'sae', label: '航天航空学院（假）', host: 'sae.xjtu.edu.cn', origin: world.base, path: '/sae/search.jsp?wbtreeid=1001', keyField: 'lucenenewssearchkey' },
  ];

  try {
    const out = await searchWebDetailed({
      query: '航空航天学院 来访',
      mode: 'campus',
      limit: 4,
      fetchImpl: localOnlyFetch(),
      probeCampus: false,
      config: { campusSites: sites, searchProvider: 'scrape', searchMaxPages: 8 },
    });

    assert.ok(out.results.length >= 3, `至少该带回几条：${JSON.stringify(out.results)}`);
    const hosts = out.results.map((item) => new URL(item.url).hostname);
    assert.equal(hosts[0], 'sae.xjtu.edu.cn', `第一条必须是讲来访的航院新闻，实际：${hosts.join(' | ')}`);
    assert.equal(hosts[1], 'sae.xjtu.edu.cn', `第二条也该是航院，实际：${hosts.join(' | ')}`);
    // 教务处的条目仍在（相关度低不等于没搜到），只是被排到后面
    assert.ok(hosts.includes('dean.xjtu.edu.cn'), '相关度低的结果不该被丢掉，只是排在后面');
  } finally {
    await world.close();
  }
});
