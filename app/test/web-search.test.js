/**
 * 联网检索适配层的测试。
 *
 * **绝不访问真实外网**：所有"搜索引擎""网页""校园网点"都是本文件里用 `node:http` 起的
 * 假服务器，通过注入 `fetchImpl` 接进去。`localOnlyFetch()` 还会在发请求前检查 host，
 * 一旦有代码试图打到真实域名就直接抛错 —— 这样"忘记注入 fetch"会立刻暴露，而不是偷偷联网。
 *
 * 覆盖点（对应需求里的每一条）：
 *   无 key 解析结果页 / API provider / provider 自动选择 / campus 站点过滤 /
 *   limit 收敛到 5–30 / 正文清洗与截断 / 单页失败 / 并发上限 / 结果去重 /
 *   反爬时如实返回空 + 说明 / 配置校验与打码。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  SCRAPE_ENGINE_IDS,
  SCRAPE_MAX_ENGINES,
  SCRAPE_RELEVANCE_THRESHOLD,
  WEB_SEARCH_MODE_NOTES,
  WEB_SEARCH_PROMPT,
  WEB_SEARCH_TOOL,
  canonicalUrl,
  campusScopedQuery,
  defaultReferer,
  dedupeResults,
  detectCampusNetwork,
  extractPageText,
  htmlToText,
  isCampusUrl,
  isJunkUrl,
  normalizeSearchLimit,
  parse360Results,
  parseBaiduResults,
  parseBingResults,
  parseSogouResults,
  queryTerms,
  readPages,
  relevanceScore,
  requestText,
  resolveSearchBackend,
  searchAndRead,
  searchWeb,
  searchWebDetailed,
} from '../src/modules/ai/web-search.js';
import {
  AI_DEFAULTS,
  AiConfigStore,
  aiConfigFromEnv,
  assertAiConfigInput,
  maskAiConfig,
  normalizeAiConfig,
} from '../src/modules/ai/config.js';

const realFetch = globalThis.fetch;

/**
 * 只允许打到 127.0.0.1 的 fetch 包装。
 * 顺手把请求记下来，测试据此断言"该带的头/体带了吗"以及"有没有偷偷联网"。
 */
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

/** 起一个本地假服务器；handler 拿到 (req, res, ctx) 与解析好的 URL。 */
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
      Promise.resolve(handler({ req, url, body, state, finish })).catch((error) => finish(500, String(error)));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
    /** 找到一个"确定没人监听"的端口：起一个再关掉。 */
  };
}

async function deadPort() {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// ---------------------------------------------------------------------------
// 假页面构造
// ---------------------------------------------------------------------------

const CAMPUS_A = 'https://dean.xjtu.edu.cn/info/1001/2001.htm';
const CAMPUS_B = 'https://gs.xjtu.edu.cn/zsgz/1234.htm';
const PUBLIC_A = 'https://example.com/news/1';
const PUBLIC_B = 'https://blog.example.org/post/42';

function bingBlock({ title, url, snippet, ad = false }) {
  return `<li class="b_algo b_algoBorder${ad ? ' b_ad' : ''}"><h2><a href="${url}">${title}</a></h2><div class="b_caption"><p>${snippet}</p></div></li>`;
}

function bingHtml(items) {
  return `<!doctype html><html><head><title>必应搜索</title></head><body><ol id="b_results">${items
    .map(bingBlock)
    .join('')}</ol></body></html>`;
}

function baiduBlock({ title, url, snippet }) {
  return `<div class="result c-container" id="1"><h3 class="t"><a href="${url}">${title}</a></h3><div class="c-abstract">${snippet}</div></div>`;
}

function baiduHtml(items) {
  return `<!doctype html><html><body><div id="content_left">${items.map(baiduBlock).join('')}</div></body></html>`;
}

const CAPTCHA_HTML = '<!doctype html><html><head><title>安全验证</title></head><body><div>请完成验证码后继续访问</div></body></html>';

/**
 * 一个"正常的搜索结果页"：Bing 命中 query 里带 site: 时只给校内结果。
 *
 * 注意标题/摘要都带上了查询词「选课」：免密钥通道现在会按**相关度**挑引擎，
 * 假结果如果与查询词完全不沾边（覆盖率 0），会被当成"引擎答非所问"丢掉 ——
 * 这正是 2026-10-13 实测 Bing 返回"西安市_百度百科"那个 bug 的防线，所以夹具必须"像真的搜到了"。
 */
function fakeBingResponse(url) {
  const query = url.searchParams.get('q') ?? '';
  if (/site:xjtu\.edu\.cn/i.test(query)) {
    return bingHtml([
      { title: '教务处：关于选课的通知', url: CAMPUS_A, snippet: '选课时间安排如下' },
      // 故意塞一条校外结果（它也"命中"了选课，确保它是被**域名过滤**挡掉的，而不是被相关度挡掉）
      { title: '选课保过班（校外培训）', url: 'https://spam.example.net/ad', snippet: '选课保过' },
      { title: '研究生院：选课与培养方案', url: CAMPUS_B, snippet: '选课说明' },
    ]);
  }
  return bingHtml([
    { title: '选课全网结果一', url: PUBLIC_A, snippet: '选课摘要一' },
    { title: '选课广告：买点什么', url: 'https://ads.example.com/x', snippet: '广告摘要', ad: true },
    { title: '必应站内搜索', url: 'https://www.bing.com/search?q=more', snippet: '站内跳转' },
  ]);
}

/** 长正文页面：用来测清洗与截断。 */
function articleHtml({ title = '一篇很长的文章', filler = 0 } = {}) {
  const paragraphs = ['第一段：西安交通大学教务处发布通知。', '第二段：请同学们按时完成选课。'];
  const long = filler ? `<p>${'正文内容'.repeat(Math.ceil(filler / 4)).slice(0, filler)}</p>` : '';
  return `<!doctype html><html><head><title>${title}</title>
<style>.hidden{color:red}</style>
<script>var SCRIPT_MARKER = "不该被读到的脚本";</script>
</head><body>
<nav>首页 | 概况 | 师资 | 招生 | 联系我们</nav>
<div>首页 | 概况 | 师资 | 招生</div>
<header>站内搜索</header>
<h1>${title}</h1>
${paragraphs.map((text) => `<p>${text}</p>`).join('\n')}
${long}
<footer>版权所有 © 西安交通大学</footer>
</body></html>`;
}

/**
 * 一整套假世界：结果页 + 四家 API + 正文页 + 校园网点。
 * 同一个 `/bing` 路径按"有没有 API 密钥头"分派 ——
 * 于是"有 key 走 API、没 key 解析结果页"这件事可以用同一个端点验证。
 */
async function startFakeWorld() {
  const world = await startFakeServer(({ req, url, body, state, finish }) => {
    // ---- 无 key 通道：结果页 ------------------------------------------------
    if (url.pathname === '/bing') {
      if (req.headers['ocp-apim-subscription-key']) {
        return finish(
          200,
          JSON.stringify({
            webPages: {
              value: [
                { name: 'Bing API 结果', url: 'https://api-result.example.com/a', snippet: '来自 Bing Web Search API' },
              ],
            },
          }),
          'application/json; charset=utf-8',
        );
      }
      if (url.searchParams.get('mode') === 'captcha') return finish(200, CAPTCHA_HTML);
      if (url.searchParams.get('mode') === '403') return finish(403, '<html>forbidden</html>');
      return finish(200, fakeBingResponse(url));
    }
    if (url.pathname === '/baidu') {
      if (url.searchParams.get('mode') === 'captcha') return finish(200, CAPTCHA_HTML);
      return finish(
        200,
        baiduHtml([
          { title: '百度选课结果一', url: 'http://www.baidu.com/link?url=abc123', snippet: '百度选课摘要一' },
          { title: '百度选课结果二', url: 'https://public.example.cn/page', snippet: '百度选课摘要二' },
        ]),
      );
    }

    // ---- 有 key 通道：四家 API ---------------------------------------------
    if (url.pathname === '/tavily-api') {
      if (!body.includes('tvly-test-key-0001')) return finish(401, JSON.stringify({ detail: 'bad key' }), 'application/json');
      return finish(
        200,
        JSON.stringify({ results: [{ title: 'Tavily 结果', url: 'https://tavily.example.com/a', content: 'Tavily 摘要' }] }),
        'application/json',
      );
    }
    if (url.pathname === '/brave-api') {
      if (req.headers['x-subscription-token'] !== 'brave-test-key-0002') {
        return finish(401, JSON.stringify({ error: 'bad token' }), 'application/json');
      }
      return finish(
        200,
        JSON.stringify({ web: { results: [{ title: 'Brave 结果', url: 'https://brave.example.com/b', description: 'Brave 摘要' }] } }),
        'application/json',
      );
    }
    if (url.pathname === '/serper-api') {
      if (req.headers['x-api-key'] !== 'serper-test-key-0003') {
        return finish(401, JSON.stringify({ message: 'unauthorized' }), 'application/json');
      }
      // 注意字段名：Serper 官方用 `link`（不是 url），这里照官方形状复刻
      return finish(
        200,
        JSON.stringify({ organic: [{ title: 'Serper 结果', link: 'https://serper.example.com/c', snippet: 'Serper 摘要' }] }),
        'application/json',
      );
    }
    if (url.pathname === '/json-errors') {
      return finish(200, JSON.stringify({ error: { message: 'quota exceeded' } }), 'application/json');
    }

    // ---- 正文页 ------------------------------------------------------------
    if (url.pathname.startsWith('/page/')) {
      const id = url.pathname.slice('/page/'.length);
      if (id === 'slow') {
        return setTimeout(() => finish(200, articleHtml({ title: '慢页面' })), 60);
      }
      if (id === 'boom') return finish(500, '<html>server error</html>');
      if (id === 'gone') return finish(404, '<html>not found</html>');
      if (id === 'json') return finish(200, JSON.stringify({ ok: true }), 'application/json');
      if (id === 'empty') return finish(200, '<html><head><script>x</script></head><body></body></html>');
      if (id === 'long') return finish(200, articleHtml({ title: '超长文章', filler: 6000 }));
      return finish(200, articleHtml({ title: `页面 ${id}` }));
    }

    // ---- 校园网探测点 ------------------------------------------------------
    if (url.pathname === '/campus/ok') return finish(200, '<html>教务处</html>');
    if (url.pathname === '/campus/302') {
      // 302 也算"可达"：能应答就说明这个校内域名在当前网络下是通的
      return finish(302, '<html>redirect</html>');
    }
    return finish(404, '<html>nope</html>');
  });
  const endpoints = {
    bing: `${world.base}/bing`,
    baidu: `${world.base}/baidu`,
    tavily: `${world.base}/tavily-api`,
    brave: `${world.base}/brave-api`,
    serper: `${world.base}/serper-api`,
  };
  return { ...world, endpoints };
}

// ---------------------------------------------------------------------------
// 1. 无 key：解析结果页
// ---------------------------------------------------------------------------

test('无 key：解析 Bing 结果页拿到 标题/链接/摘要/来源，广告与站内跳转被丢掉', async () => {
  const world = await startFakeWorld();
  const logs = [];
  try {
    const results = await searchWeb({
      query: '选课',
      config: {}, // 没有任何 key
      fetchImpl: localOnlyFetch(),
      endpoints: world.endpoints,
      log: (message) => logs.push(message),
    });
    assert.equal(results.length, 1, '广告与 bing 站内跳转都应被过滤');
    assert.deepEqual(results[0], {
      title: '选课全网结果一',
      url: PUBLIC_A,
      snippet: '选课摘要一',
      source: 'bing-html',
      scope: 'web',
    });
    assert.ok(
      logs.some((line) => line.includes('未配置搜索 API 密钥')),
      '要说清现在是免密钥通道',
    );
    assert.ok(
      logs.some((line) => line.includes('结果页解析成功')),
      '成功也要记一笔，便于排查"为什么结果这么少"',
    );
  } finally {
    await world.close();
  }
});

test('无 key：Bing 挂了自动退百度，并且百度的 /link?url= 自然结果保留', async () => {
  const world = await startFakeWorld();
  try {
    const detail = await searchWebDetailed({
      query: '选课',
      config: {},
      fetchImpl: localOnlyFetch(),
      endpoints: { ...world.endpoints, bing: `${world.base}/bing?mode=403` },
    });
    assert.equal(detail.results.length, 2, 'Bing 403 之后应该继续去百度');
    assert.deepEqual(
      detail.results.map((item) => item.source),
      ['baidu-html', 'baidu-html'],
    );
    assert.ok(detail.results.some((item) => item.url.includes('baidu.com/link?url=')), '百度的自然结果链接要保留');
    assert.ok(detail.notes.some((note) => note.includes('403')));
  } finally {
    await world.close();
  }
});

test('反爬：两个引擎都被挡住时返回空数组，并在日志里如实说明「不是搜到 0 条」', async () => {
  const world = await startFakeWorld();
  const logs = [];
  try {
    const detail = await searchWebDetailed({
      query: '选课',
      config: {},
      fetchImpl: localOnlyFetch(),
      endpoints: {
        bing: `${world.base}/bing?mode=captcha`,
        baidu: `${world.base}/baidu?mode=captcha`,
      },
      log: (message) => logs.push(message),
    });

    assert.deepEqual(detail.results, [], '被反爬时必须返回空，绝不能伪造结果');
    assert.ok(
      detail.notes.some((note) => note.includes('命中风控页特征')),
      '要说出被什么挡住了',
    );
    assert.ok(
      detail.notes.some((note) => note.includes('不是「搜到 0 条」')),
      '必须区分「取不到结果」和「确实没有结果」',
    );
    assert.ok(
      detail.notes.some((note) => note.includes('未配置搜索 API 密钥')),
      '也要说清"未配置密钥"这件事，而不是含糊过去',
    );
    assert.ok(logs.length > 0, 'log 回调要被真正调用');
  } finally {
    await world.close();
  }
});

test('关闭总开关时不检索，并明确说明是「被设置关掉」而不是「没结果」', async () => {
  const record = [];
  const results = await searchWeb({
    query: '选课',
    config: { searchEnabled: false },
    fetchImpl: localOnlyFetch(record),
  });
  assert.deepEqual(results, []);
  assert.equal(record.length, 0, '关掉开关后一个请求都不该发出去');
});

// ---------------------------------------------------------------------------
// 2. API provider 与自动选择
// ---------------------------------------------------------------------------

test('API：Tavily / Brave / Serper 三家都能解析成统一结构，并且带上了各自的鉴权', async () => {
  const world = await startFakeWorld();
  try {
    const cases = [
      { provider: 'tavily', key: 'tvly-test-key-0001', source: 'tavily', url: 'https://tavily.example.com/a', title: 'Tavily 结果' },
      { provider: 'brave', key: 'brave-test-key-0002', source: 'brave', url: 'https://brave.example.com/b', title: 'Brave 结果' },
      { provider: 'serper', key: 'serper-test-key-0003', source: 'serper', url: 'https://serper.example.com/c', title: 'Serper 结果' },
    ];
    for (const item of cases) {
      const record = [];
      const results = await searchWeb({
        query: '选课',
        config: { searchProvider: item.provider, searchApiKey: item.key },
        fetchImpl: localOnlyFetch(record),
        endpoints: world.endpoints,
      });
      assert.equal(results.length, 1, `${item.provider} 应该给出 1 条`);
      assert.equal(results[0].source, item.source);
      assert.equal(results[0].title, item.title);
      assert.equal(results[0].url, item.url);
      assert.equal(record.length, 1, `${item.provider} 只该发一次请求`);
      assert.ok(
        record[0].url.startsWith(world.endpoints[item.provider]),
        '要打到配置的端点上（测试用本地假服务器）',
      );
    }

    // 鉴权细节：Serper 用 X-API-KEY 头，Brave 用 X-Subscription-Token
    const serperRecord = [];
    await searchWeb({
      query: '选课',
      config: { searchProvider: 'serper', searchApiKey: 'serper-test-key-0003' },
      fetchImpl: localOnlyFetch(serperRecord),
      endpoints: world.endpoints,
    });
    assert.equal(serperRecord[0].headers['X-API-KEY'], 'serper-test-key-0003');
    assert.equal(serperRecord[0].method, 'POST');
    assert.deepEqual(JSON.parse(serperRecord[0].body), { q: '选课', num: 8 });
  } finally {
    await world.close();
  }
});

test('provider 自动选择：有 key 走 API，没 key 解析结果页，指定哪家就只喂哪家', async () => {
  const world = await startFakeWorld();
  try {
    // 1) 有 key（auto）→ 走 API
    assert.equal(resolveSearchBackend({ searchApiKey: 'tvly-x' }).id, 'tavily');
    assert.equal(resolveSearchBackend({ searchApiKeys: { serper: 'k' } }).id, 'serper');
    assert.equal(resolveSearchBackend({}).id, 'scrape');

    const withKey = await searchWebDetailed({
      query: '选课',
      config: { searchApiKeys: { bing: 'bing-key-0004' } },
      fetchImpl: localOnlyFetch(),
      endpoints: world.endpoints,
    });
    assert.equal(withKey.backend.kind, 'api');
    assert.equal(withKey.results[0].source, 'bing', '同一路径下带鉴权头就是 API 通道');

    // 2) 没 key → 结果页
    const noKey = await searchWebDetailed({
      query: '选课',
      config: {},
      fetchImpl: localOnlyFetch(),
      endpoints: world.endpoints,
    });
    assert.equal(noKey.backend.kind, 'scrape');
    assert.equal(noKey.results[0].source, 'bing-html');

    // 3) 指定了 provider 但没有它的 key → 退到"有 key 的那家"
    const fallback = resolveSearchBackend({ searchProvider: 'bing', searchApiKeys: { tavily: 'k' } });
    assert.equal(fallback.kind, 'api');
    assert.equal(fallback.id, 'tavily');
    assert.match(fallback.reason, /指定了 bing 但没有它的密钥/);

    // 4) 指定了 provider、一把 key 都没有 → 退回结果页并说明
    const downgraded = resolveSearchBackend({ searchProvider: 'brave' });
    assert.equal(downgraded.kind, 'scrape');
    assert.match(downgraded.reason, /没有配置任何搜索 API 密钥/);

    // 5) scrape：配了 key 也强制走结果页
    assert.equal(resolveSearchBackend({ searchProvider: 'scrape', searchApiKey: 'tvly-x' }).kind, 'scrape');
  } finally {
    await world.close();
  }
});

test('API 返回错误体（HTTP 200 但带 error）时不算成功，要降级并说明原因', async () => {
  const world = await startFakeWorld();
  try {
    const detail = await searchWebDetailed({
      query: '选课',
      config: { searchProvider: 'tavily', searchApiKey: 'tvly-test-key-0001' },
      fetchImpl: localOnlyFetch(),
      endpoints: { ...world.endpoints, tavily: `${world.base}/json-errors` },
    });
    // 降级到结果页后仍应拿到结果，而不是"空手而归"
    assert.ok(detail.results.length >= 1, 'API 报错要降级到免密钥通道');
    assert.ok(detail.notes.some((note) => note.includes('quota exceeded')));
    assert.ok(detail.notes.some((note) => note.includes('降级到免密钥通道')));
  } finally {
    await world.close();
  }
});

// ---------------------------------------------------------------------------
// 3. campus 模式
// ---------------------------------------------------------------------------

test('campus：只保留校内站点结果；探测不可达时不并走公网', async () => {
  const world = await startFakeWorld();
  const port = await deadPort();
  try {
    const detail = await searchWebDetailed({
      query: '选课',
      mode: 'campus',
      config: {},
      fetchImpl: localOnlyFetch(),
      endpoints: world.endpoints,
      probes: [{ url: `http://127.0.0.1:${port}/`, label: '教务处（假）' }],
    });

    assert.equal(detail.campus.onCampus, false);
    assert.ok(detail.campus.caveat.includes('不能证明'), '探测结论必须自带这句免责说明');
    assert.ok(detail.notes.some((note) => note.includes('不并走公网')));

    assert.equal(detail.results.length, 2, '校外结果必须被过滤掉');
    assert.ok(detail.results.every((item) => isCampusUrl(item.url)), 'campus 档只留 *.xjtu.edu.cn');
    assert.ok(detail.results.every((item) => item.scope === 'campus'));
    assert.ok(
      world.state.requests.some((request) => (request.query.get('q') ?? '').includes('site:xjtu.edu.cn')),
      '检索词要收窄到校内站点',
    );
    // 没有并走公网：不该出现公网检索词的那批结果
    assert.equal(detail.results.some((item) => item.url === PUBLIC_A), false);
  } finally {
    await world.close();
  }
});

test('campus：校内域名可达时并走公网，两批结果合并去重并标明 scope', async () => {
  const world = await startFakeWorld();
  try {
    const detail = await searchWebDetailed({
      query: '选课',
      mode: 'campus',
      config: {},
      fetchImpl: localOnlyFetch(),
      endpoints: world.endpoints,
      probes: [
        { url: `${world.base}/campus/ok`, label: '教务处（假）' },
        { url: `${world.base}/campus/302`, label: '研究生院（假，302）' },
      ],
    });

    assert.equal(detail.campus.onCampus, true);
    assert.equal(detail.campus.reachable.length, 2, '302 也算可达');
    assert.ok(detail.notes.some((note) => note.includes('再并走一次公网检索')));

    const scopes = detail.results.map((item) => item.scope).sort();
    assert.deepEqual(scopes, ['campus', 'campus', 'web'], '校内 + 公网各来一批');
    assert.ok(detail.results.some((item) => item.url === PUBLIC_A));
    assert.ok(detail.results.some((item) => item.url === CAMPUS_A));
  } finally {
    await world.close();
  }
});

test('campus：检索词带上学校名（实测只写 site: 拿不到校内结果），已写 site: 就照调用方说的做', () => {
  // 这条期望值是被**真网实测**改过的：免密钥通道下只用 `site:xjtu.edu.cn`，
  // Bing 的结果页基本不认这个语法，返回的全是各校教务处首页，被域名过滤一清就什么都不剩 ——
  // 于是"校内检索"一条校内结果都没有。所以补上学校名，让结果页至少把西交大的页面排上来。
  assert.equal(campusScopedQuery('选课'), '选课 西安交通大学 site:xjtu.edu.cn');
  // 已经有校名就不重复堆
  assert.equal(campusScopedQuery('西安交通大学 选课'), '西安交通大学 选课 site:xjtu.edu.cn');
  // 调用方自己写了 site: 时别擅自加词：它可能就是想精确限定某个子域
  assert.equal(campusScopedQuery('选课 site:dean.xjtu.edu.cn'), '选课 site:dean.xjtu.edu.cn');
  assert.equal(campusScopedQuery('  '), '');
});

test('detectCampusNetwork：逐个目标给结论 + 理由 + caveat', async () => {
  const world = await startFakeWorld();
  const port = await deadPort();
  try {
    const mixed = await detectCampusNetwork({
      fetchImpl: localOnlyFetch(),
      probes: [
        { url: `${world.base}/campus/ok`, label: '教务处' },
        { url: `http://127.0.0.1:${port}/`, label: '不可达站点' },
      ],
    });
    assert.equal(mixed.onCampus, true);
    assert.equal(mixed.probes.length, 2);
    assert.equal(mixed.unreachable.length, 1);
    assert.match(mixed.reason, /教务处/);
    assert.match(mixed.caveat, /可达/);

    const none = await detectCampusNetwork({
      fetchImpl: localOnlyFetch(),
      probes: [{ url: `http://127.0.0.1:${port}/`, label: '不可达站点' }],
    });
    assert.equal(none.onCampus, false);
    assert.match(none.reason, /全部不可达/);
  } finally {
    await world.close();
  }
});

// ---------------------------------------------------------------------------
// 4. limit 收敛
// ---------------------------------------------------------------------------

test('limit：越界一律收敛到 5–30，没传就用配置里的「网络搜索最大条数」', async () => {
  assert.equal(normalizeSearchLimit(0), 5);
  assert.equal(normalizeSearchLimit(1), 5);
  assert.equal(normalizeSearchLimit(-100), 5);
  assert.equal(normalizeSearchLimit(999), 30);
  assert.equal(normalizeSearchLimit('abc'), 8);
  assert.equal(normalizeSearchLimit(undefined), 8);
  assert.equal(normalizeSearchLimit(12), 12);
  assert.equal(normalizeSearchLimit(undefined, { fallback: 20 }), 20);
  assert.equal(normalizeSearchLimit(undefined, { fallback: 999 }), 30, '配置兜底值本身越界也要收敛');

  const world = await startFakeWorld();
  try {
    const low = await searchWebDetailed({ query: '选课', limit: 1, config: {}, fetchImpl: localOnlyFetch(), endpoints: world.endpoints });
    assert.equal(low.limit, 5);

    const high = await searchWebDetailed({ query: '选课', limit: 500, config: {}, fetchImpl: localOnlyFetch(), endpoints: world.endpoints });
    assert.equal(high.limit, 30);

    const fromConfig = await searchWebDetailed({
      query: '选课',
      config: { searchMaxPages: 12 },
      fetchImpl: localOnlyFetch(),
      endpoints: world.endpoints,
    });
    assert.equal(fromConfig.limit, 12);

    // limit 是**上限**：结果不超过它
    const limited = await searchWeb({
      query: '选课',
      limit: 30,
      config: { searchMaxPages: 5 },
      fetchImpl: localOnlyFetch(),
      endpoints: world.endpoints,
    });
    assert.ok(limited.length <= 5);
  } finally {
    await world.close();
  }
});

// ---------------------------------------------------------------------------
// 5. 读正文：清洗 / 截断 / 失败隔离 / 并发
// ---------------------------------------------------------------------------

test('正文清洗：脚本、样式、导航、页脚、菜单条都被去掉，正文段落保留', async () => {
  const world = await startFakeWorld();
  try {
    const [page] = await readPages([{ title: '文章', url: `${world.base}/page/1` }], {
      fetchImpl: localOnlyFetch(),
      limit: 1,
    });
    assert.equal(page.ok, true);
    assert.ok(page.text.includes('第一段：西安交通大学教务处发布通知。'));
    assert.ok(page.text.includes('第二段：请同学们按时完成选课。'));
    assert.equal(page.text.includes('SCRIPT_MARKER'), false, 'script 内容必须被丢掉');
    assert.equal(page.text.includes('不该被读到的脚本'), false);
    assert.equal(page.text.includes('color:red'), false, 'style 内容必须被丢掉');
    assert.equal(page.text.includes('版权所有'), false, '页脚噪声要去掉');
    assert.equal(page.text.includes('首页 | 概况'), false, '导航条要去掉');
    assert.equal(page.text.includes('站内搜索'), false, 'header 要去掉');
    assert.equal(/\n{3,}/.test(page.text), false, '空行要折叠');
  } finally {
    await world.close();
  }
});

test('正文截断：默认每页约 4000 字，自定义 maxChars 生效且带截断标记', async () => {
  const world = await startFakeWorld();
  try {
    const [page] = await readPages([{ title: '长文', url: `${world.base}/page/long` }], { fetchImpl: localOnlyFetch(), limit: 1 });
    assert.equal(page.ok, true);
    assert.ok(page.text.length <= 4_000 + 80, `默认截断到 4000 字上下，实际 ${page.text.length}`);
    assert.ok(page.text.includes('已按设置截断'));

    const [short] = await readPages([{ title: '长文', url: `${world.base}/page/long` }], {
      fetchImpl: localOnlyFetch(),
      limit: 1,
      maxChars: 300,
    });
    assert.ok(short.text.length <= 300 + 80);
    assert.ok(short.text.includes('前 300 字'));
  } finally {
    await world.close();
  }
});

test('读正文：单页失败不拖垮整批（500 / 404 / 非网页 / 空页各自如实报错）', async () => {
  const world = await startFakeWorld();
  const logs = [];
  try {
    const pages = await readPages(
      [
        { title: '正常', url: `${world.base}/page/1` },
        { title: '服务端错误', url: `${world.base}/page/boom` },
        { title: '不存在', url: `${world.base}/page/gone` },
        { title: '接口', url: `${world.base}/page/json` },
        { title: '空页', url: `${world.base}/page/empty` },
      ],
      { fetchImpl: localOnlyFetch(), log: (message) => logs.push(message) },
    );

    assert.equal(pages.length, 5, '一条都不能少，失败的也要占位');
    assert.deepEqual(
      pages.map((page) => page.ok),
      [true, false, false, false, false],
    );
    assert.match(pages[1].error, /500/);
    assert.match(pages[2].error, /404/);
    assert.match(pages[3].error, /不是网页正文/);
    assert.match(pages[4].error, /没有可提取的正文/);
    assert.ok(pages[0].text.includes('第一段'));
    assert.ok(
      logs.some((line) => line.includes('读正文失败')),
      '失败的页面要留下可排查的日志（哪一页、什么原因）',
    );
    assert.ok(logs.some((line) => line.includes('boom')));
  } finally {
    await world.close();
  }
});

test('读正文：并发有上限（默认 3，最多 4），顺序与入参一致', async () => {
  const world = await startFakeWorld();
  try {
    const targets = Array.from({ length: 9 }, (_, index) => ({
      title: `页面 ${index}`,
      url: `${world.base}/page/slow?i=${index}`,
    }));

    world.state.maxInFlight = 0;
    const defaultRun = await readPages(targets, { fetchImpl: localOnlyFetch() });
    assert.equal(defaultRun.length, 9);
    assert.ok(world.state.maxInFlight <= 3, `默认并发不得超过 3，实际 ${world.state.maxInFlight}`);
    assert.deepEqual(
      defaultRun.map((page) => page.title),
      targets.map((target) => target.title),
      '返回顺序必须与入参一致，方便和结果列表对齐',
    );

    world.state.maxInFlight = 0;
    const clamped = await readPages(targets, { fetchImpl: localOnlyFetch(), concurrency: 99 });
    assert.equal(clamped.length, 9);
    assert.ok(world.state.maxInFlight <= 4, `并发上限就是 4，实际 ${world.state.maxInFlight}`);
    assert.ok(world.state.maxInFlight >= 2, '并发确实生效（不是串行）');

    const limited = await readPages(targets, { fetchImpl: localOnlyFetch(), limit: 2 });
    assert.equal(limited.length, 2);
  } finally {
    await world.close();
  }
});

// ---------------------------------------------------------------------------
// 6. 去重 / 垃圾过滤
// ---------------------------------------------------------------------------

test('去重：同 URL 只留一条（忽略 utm、末尾斜杠、www 与 hash）', async () => {
  assert.equal(canonicalUrl('https://www.example.com/a/?utm_source=x#top'), 'https://example.com/a');
  assert.equal(canonicalUrl('https://example.com/a'), canonicalUrl('https://www.example.com/a/?utm_source=weibo'));

  const world = await startFakeWorld();
  try {
    const html = bingHtml([
      // 标题都带「选课」：不然会被相关度过滤（覆盖率 0）丢掉，测不到去重这件事
      { title: '选课结果 A', url: 'https://news.example.com/post/1?utm_source=weibo', snippet: '选课摘要一' },
      { title: '选课结果 A（重复）', url: 'https://www.news.example.com/post/1/#comments', snippet: '选课摘要一' },
      { title: '选课结果 B', url: 'https://news.example.com/post/2', snippet: '选课摘要二' },
    ]);
    const fake = await startFakeServer(({ finish }) => finish(200, html));
    try {
      const results = await searchWeb({
        query: '选课',
        config: {},
        fetchImpl: localOnlyFetch(),
        endpoints: { bing: `${fake.base}/bing` },
      });
      assert.equal(results.length, 2, '同一条结果的不同写法只能留一条');
      assert.equal(results[0].title, '选课结果 A');
      assert.equal(results[1].title, '选课结果 B');
    } finally {
      await fake.close();
    }

    const filtered = dedupeResults([
      { title: '校内', url: CAMPUS_A, scope: 'campus' },
      { title: '校外混进来的', url: PUBLIC_A, scope: 'campus' },
      { title: '公网', url: PUBLIC_A, scope: 'web' },
      { title: '', url: PUBLIC_B, scope: 'web' },
    ]);
    assert.deepEqual(
      filtered.map((item) => item.url),
      [CAMPUS_A, PUBLIC_A],
      'campus 档丢掉校外链接；同一条 URL 只留首次出现的那条；没有标题的丢掉',
    );
  } finally {
    await world.close();
  }
});

test('垃圾过滤：非 http(s)、静态资源、搜索站自身的检索页都丢掉，百度的结果跳转保留', () => {
  assert.equal(isJunkUrl('javascript:void(0)'), true);
  assert.equal(isJunkUrl('mailto:a@b.com'), true);
  assert.equal(isJunkUrl('#anchor'), true);
  assert.equal(isJunkUrl('https://www.bing.com/search?q=x'), true);
  assert.equal(isJunkUrl('https://www.baidu.com/s?wd=x'), true);
  assert.equal(isJunkUrl('https://cdn.example.com/logo.png'), true);
  assert.equal(isJunkUrl('https://dean.xjtu.edu.cn/info/1.htm'), false);
  // 百度的自然结果基本都是这个形状：跟着跳一次能到目标页，所以不算垃圾
  assert.equal(isJunkUrl('http://www.baidu.com/link?url=abc'), false);
});

test('结果页结构变化（解析出 0 条）时返回空 + 说明，而不是伪造', async () => {
  const fake = await startFakeServer(({ finish }) => finish(200, '<html><body><div>我们改版啦</div></body></html>'));
  const logs = [];
  try {
    const detail = await searchWebDetailed({
      query: '选课',
      config: {},
      fetchImpl: localOnlyFetch(),
      endpoints: { bing: `${fake.base}/bing`, baidu: `${fake.base}/baidu2` },
      log: (message) => logs.push(message),
    });
    assert.deepEqual(detail.results, []);
    assert.ok(detail.notes.some((note) => note.includes('结构可能已改版') || note.includes('解析出 0 条')));
    assert.ok(detail.notes.some((note) => note.includes('没能取到搜索结果')));
    assert.ok(logs.length > 0);
  } finally {
    await fake.close();
  }
});

test('空检索词不发请求也不假装搜过', async () => {
  const record = [];
  const detail = await searchWebDetailed({ query: '   ', config: {}, fetchImpl: localOnlyFetch(record) });
  assert.deepEqual(detail.results, []);
  assert.equal(record.length, 0);
  assert.ok(detail.notes.some((note) => note.includes('检索词为空')));
});

// ---------------------------------------------------------------------------
// 7. 纯函数（解析器 / 清洗）
// ---------------------------------------------------------------------------

test('解析器：Bing 与百度各自的结果块都能直接解析（含实体解码）', () => {
  const bing = parseBingResults(
    bingHtml([{ title: 'A&amp;B 通知', url: 'https://a.example.com/1', snippet: '摘要 &lt;重要&gt;' }]),
  );
  assert.equal(bing.length, 1);
  assert.equal(bing[0].title, 'A&B 通知');
  assert.equal(bing[0].snippet, '摘要 <重要>');

  const baidu = parseBaiduResults(
    baiduHtml([{ title: '百度标题', url: 'http://www.baidu.com/link?url=zzz', snippet: '百度摘要' }]),
  );
  assert.equal(baidu.length, 1);
  assert.equal(baidu[0].url, 'http://www.baidu.com/link?url=zzz');
  assert.equal(baidu[0].source, 'baidu-html');

  assert.deepEqual(parseBingResults('<html>没有结果块</html>'), []);
  assert.deepEqual(parseBaiduResults(''), []);
});

test('清洗函数：htmlToText / extractPageText 对残缺 HTML 也不抛异常', () => {
  assert.equal(htmlToText('<p>a</p><script>var x = 1;'), 'a');
  assert.equal(htmlToText(undefined), '');
  const text = extractPageText('<div>正文</div><style>p{}</style>', { maxChars: 100 });
  assert.equal(text, '正文');
  assert.equal(extractPageText('', {}), '');
});

// ---------------------------------------------------------------------------
// 8. 工具描述符与提示词
// ---------------------------------------------------------------------------

test('工具描述符：web_search 是只读工具，参数含 query / mode / limit', () => {
  assert.equal(WEB_SEARCH_TOOL.name, 'web_search');
  assert.equal(WEB_SEARCH_TOOL.mutates, false, '检索是只读动作，任何权限档位都不该拦');
  assert.ok(WEB_SEARCH_TOOL.params.query.includes('必填'));
  assert.ok(WEB_SEARCH_TOOL.params.mode.includes('campus'));
  assert.ok(WEB_SEARCH_TOOL.params.limit.includes('5–30'));
});

test('提示词：讲清何时该搜、必须引用真实 URL、搜不到要说不知道、不许编造链接', () => {
  const text = WEB_SEARCH_PROMPT;
  assert.ok(text.includes('什么时候该搜'));
  assert.ok(text.includes('什么时候别搜'));
  assert.ok(text.includes('必须引用真实 URL'));
  assert.ok(text.includes('绝对不许编造链接'));
  assert.ok(text.includes('搜不到就直说'));
  assert.ok(text.includes('先看本地数据'));

  // 三档都要有，且 campus 档必须说清"可达 ≠ 登录/不等于确认在校园网"
  assert.deepEqual(Object.keys(WEB_SEARCH_MODE_NOTES), ['off', 'web', 'campus']);
  assert.ok(WEB_SEARCH_MODE_NOTES.campus.includes('不等于确认在校园网'));
  assert.ok(WEB_SEARCH_MODE_NOTES.off.includes('不要') && WEB_SEARCH_MODE_NOTES.off.includes('编造'));
});

test('searchAndRead：一次拿到候选结果与正文，供多轮对话直接回灌', async () => {
  const world = await startFakeWorld();
  try {
    const payload = await searchAndRead({
      query: '选课',
      config: {},
      fetchImpl: localOnlyFetch(),
      endpoints: world.endpoints,
    });
    assert.ok(payload.results.length >= 1);
    assert.equal(payload.pages.length, payload.results.length, '候选和正文要一一对应');
    assert.ok(payload.notes.length > 0, '诊断说明要一起带出来，模型才能如实解释');
    assert.equal(typeof payload.backend.id, 'string');
    assert.equal(payload.mode, 'web');

    // 不开 read 时只搜不读（省流量/省时间）
    const searchOnly = await searchAndRead({
      query: '选课',
      config: {},
      fetchImpl: localOnlyFetch(),
      endpoints: world.endpoints,
      read: false,
    });
    assert.deepEqual(searchOnly.pages, []);
    assert.ok(searchOnly.results.length >= 1);
  } finally {
    await world.close();
  }
});

// ---------------------------------------------------------------------------
// 9. 日志适配（对接 chat-service 的 this.logger）
// ---------------------------------------------------------------------------

test('日志适配：兼容 (message) 与 (level, message) 两种写法，日志抛错不影响检索', async () => {
  const world = await startFakeWorld();
  const single = [];
  const dual = [];
  try {
    await searchWebDetailed({
      query: '选课',
      config: {},
      fetchImpl: localOnlyFetch(),
      endpoints: world.endpoints,
      log: (message) => single.push(message),
    });
    assert.ok(single.length > 0);
    assert.ok(single.every((line) => line.startsWith('[web-search] ')), '单参写法拿到整条消息');

    await searchWebDetailed({
      query: '选课',
      config: {},
      fetchImpl: localOnlyFetch(),
      endpoints: world.endpoints,
      // chat-service 就是这么传的：`(level, message) => this.logger?.(level, message)`
      log: (level, message) => dual.push([level, message]),
    });
    assert.ok(dual.length > 0);
    assert.ok(
      dual.every(
        ([level, message]) =>
          ['info', 'warn', 'error'].includes(level) && typeof message === 'string' && message.includes('[web-search]'),
      ),
      '两参写法下级别与正文各归各位（级别是 info/warn，正文带来源前缀）',
    );

    // 反爬失败必须以 warn 级别报出来，便于上层按级别筛选
    const warns = [];
    await searchWebDetailed({
      query: '选课',
      config: {},
      fetchImpl: localOnlyFetch(),
      endpoints: { bing: `${world.base}/bing?mode=captcha`, baidu: `${world.base}/baidu?mode=captcha` },
      log: (level, message) => warns.push([level, message]),
    });
    assert.ok(warns.some(([level, message]) => level === 'warn' && message.includes('免密钥通道失败')));

    // console 形状的对象
    const consoleLike = {
      lines: [],
      warn(message) {
        this.lines.push(message);
      },
    };
    await searchWebDetailed({
      query: '选课',
      config: {},
      fetchImpl: localOnlyFetch(),
      endpoints: world.endpoints,
      log: consoleLike,
    });
    assert.ok(consoleLike.lines.length > 0);

    // 日志本身抛异常也不能把检索带崩
    const results = await searchWeb({
      query: '选课',
      config: {},
      fetchImpl: localOnlyFetch(),
      endpoints: world.endpoints,
      log: () => {
        throw new Error('logger boom');
      },
    });
    assert.ok(results.length >= 1);
  } finally {
    await world.close();
  }
});

// ---------------------------------------------------------------------------
// 10. 配置：默认值 / 校验 / 打码
// ---------------------------------------------------------------------------

test('配置：检索字段的默认值与宽松归一化（磁盘脏值不阻塞启动）', () => {
  assert.equal(AI_DEFAULTS.searchMaxPages, 8);
  assert.equal(AI_DEFAULTS.searchEnabled, true);
  assert.equal(AI_DEFAULTS.searchProvider, 'auto');

  const config = normalizeAiConfig({});
  assert.equal(config.searchMaxPages, 8);
  assert.equal(config.searchEnabled, true);
  assert.equal(config.searchProvider, 'auto');
  assert.deepEqual(config.searchApiKeys, {});

  // 磁盘/环境变量里的越界值 → 静默回落，不抛
  assert.equal(normalizeAiConfig({ searchMaxPages: 999 }).searchMaxPages, 8);
  assert.equal(normalizeAiConfig({ searchMaxPages: 3 }).searchMaxPages, 8);
  assert.equal(normalizeAiConfig({ searchMaxPages: '12' }).searchMaxPages, 12);
  assert.equal(normalizeAiConfig({ searchProvider: 'Tavly' }).searchProvider, 'auto');
  assert.equal(normalizeAiConfig({ searchProvider: 'BRAVE' }).searchProvider, 'brave');
  assert.equal(normalizeAiConfig({ searchEnabled: 'maybe' }).searchEnabled, true);
  assert.equal(normalizeAiConfig({ searchEnabled: 'off' }).searchEnabled, false);
});

test('配置：用户输入越界抛 HttpError.badRequest（5–30 的整数）', () => {
  const codeOf = (fn) => {
    try {
      fn();
    } catch (error) {
      return { status: error.status, code: error.code, message: error.message, details: error.details };
    }
    return null;
  };

  for (const value of [4, 31, 0, -1, 100, 4.5, 'abc', NaN]) {
    const error = codeOf(() => assertAiConfigInput({ searchMaxPages: value }));
    assert.ok(error, `${value} 应该被拒绝`);
    assert.equal(error.status, 400);
    assert.equal(error.code, 'BAD_REQUEST');
    assert.equal(error.details.field, 'searchMaxPages');
  }

  // 合法值一个都不能误杀
  for (const value of [5, 8, 30, '5', '30', 12.0]) {
    assert.equal(assertAiConfigInput({ searchMaxPages: value }).searchMaxPages !== undefined, true);
  }
  // 没传就不校验
  assert.doesNotThrow(() => assertAiConfigInput({}));

  const providerError = codeOf(() => assertAiConfigInput({ searchProvider: 'google' }));
  assert.equal(providerError.status, 400);
  assert.equal(providerError.details.field, 'searchProvider');
  assert.match(providerError.message, /tavily/);

  const keyError = codeOf(() => assertAiConfigInput({ searchApiKeys: { tavly: 'x' } }));
  assert.equal(keyError.status, 400);
  assert.match(keyError.message, /不认识的服务/);
});

test('配置：落盘走 save() 时严格校验，被拒绝后内存里的旧值不受影响', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'potato-search-config-'));
  const store = new AiConfigStore({ dataDir: dir });
  await store.load();
  assert.equal(store.get().searchMaxPages, 8);

  await store.save({ searchMaxPages: 30, searchApiKeys: { brave: 'brave-key-1234' } });
  assert.equal(store.get().searchMaxPages, 30);
  assert.equal(store.get().searchApiKeys.brave, 'brave-key-1234');

  await assert.rejects(() => store.save({ searchMaxPages: 31 }), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, 'BAD_REQUEST');
    return true;
  });
  assert.equal(store.get().searchMaxPages, 30, '非法值不能被写进去');

  // 改一家的 key 不该把别家清掉
  await store.save({ searchApiKeys: { serper: 'serper-key-5678' } });
  assert.equal(store.get().searchApiKeys.brave, 'brave-key-1234');
  assert.equal(store.get().searchApiKeys.serper, 'serper-key-5678');
});

test('配置：maskConfig 只回显"配没配"和末四位，绝不泄露密钥原文', () => {
  const config = normalizeAiConfig({
    searchMaxPages: 20,
    searchProvider: 'tavily',
    searchApiKeys: { tavily: 'tvly-super-secret-4321', brave: 'brave-super-secret-8765' },
  });
  const masked = maskAiConfig(config);
  const json = JSON.stringify(masked);

  assert.equal(json.includes('tvly-super-secret-4321'), false);
  assert.equal(json.includes('brave-super-secret-8765'), false);
  assert.equal(masked.searchMaxPages, 20);
  assert.equal(masked.searchBackend, 'tavily');
  assert.equal(masked.hasSearchKey, true);
  assert.equal(masked.searchKeyHint, '…4321');
  assert.deepEqual(masked.searchKeys.tavily, { hasKey: true, keyHint: '…4321' });
  assert.deepEqual(masked.searchKeys.serper, { hasKey: false, keyHint: null });

  const empty = maskAiConfig(normalizeAiConfig({}));
  assert.equal(empty.hasSearchKey, false);
  assert.equal(empty.searchKeyHint, null);
  assert.equal(empty.searchBackend, 'scrape', '没配密钥时如实显示"免密钥解析结果页"');
});

test('配置：环境变量可以给通用密钥，也可以按服务分别给', () => {
  const fromEnv = aiConfigFromEnv({
    PC_AI_SEARCH_ENABLED: 'off',
    PC_AI_SEARCH_MAX_PAGES: '20',
    PC_AI_SEARCH_PROVIDER: 'brave',
    PC_AI_BRAVE_API_KEY: 'brave-env-key',
  });
  const config = normalizeAiConfig(fromEnv);
  assert.equal(config.searchEnabled, false);
  assert.equal(config.searchMaxPages, 20);
  assert.equal(config.searchProvider, 'brave');
  assert.equal(config.searchApiKeys.brave, 'brave-env-key');
  assert.equal(resolveSearchBackend(config).id, 'brave');

  const generic = normalizeAiConfig(aiConfigFromEnv({ PC_AI_SEARCH_PROVIDER: 'serper', PC_AI_SEARCH_API_KEY: 'serper-env' }));
  assert.equal(resolveSearchBackend(generic).id, 'serper');
});

test('接口：POST /ai/config 对越界值回 400，合法值落库，密钥不回显', async () => {
  const { createServer } = await import('../src/server/index.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'potato-search-route-'));
  const app = await createServer({ dataDir: dir });
  const info = await app.listen({ port: 0 });
  const post = async (body) => {
    // 注意：`listen()` 返回的 baseUrl 已经带上了 /api/v1 前缀
    const response = await fetch(`${info.baseUrl}/ai/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const bad = await post({ searchMaxPages: 99 });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'BAD_REQUEST');
    assert.match(bad.body.error.message, /5–30/);

    const good = await post({ searchMaxPages: 12 });
    assert.equal(good.status, 200);
    assert.equal(good.body.config.searchMaxPages, 12);

    const secret = 'tvly-route-secret-9999';
    const withKey = await post({ searchApiKeys: { tavily: secret }, searchProvider: 'tavily' });
    assert.equal(withKey.status, 200);
    assert.equal(JSON.stringify(withKey.body).includes(secret), false, '接口绝不能回显搜索密钥');
    assert.equal(withKey.body.config.searchBackend, 'tavily');
    assert.equal(withKey.body.config.searchKeys.tavily.keyHint, '…9999');
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// 9. 免密钥通道：引擎优先级 + 按相关度选引擎
//    （2026-10-13 真网实测驱动：Bing 对中文查询返回"降级结果"，搜狗/360 是准的）
// ---------------------------------------------------------------------------

/** 搜狗结果页（照真页面结构：`div.vrwrap` + `h3.vr-title` + `div.space-txt`，标题里带 <em> 高亮）。 */
function sogouHtml(items) {
  return `<!doctype html><html><body>${items
    .map(
      (item) =>
        `<div class="vrwrap" id="sogou_vr_30000000_wrap_1"><h3 class="vr-title"><a href="${item.url}">${item.title}</a></h3>`
        + `<div class="fz-mid space-txt base-ellipsis clamp2" id="cacheresult_summary_1">${item.snippet}</div></div>`,
    )
    .join('')}</body></html>`;
}

/** 360 结果页（照真页面结构：`li.res-list` + `h3.res-title` + `p.res-desc`）。 */
function so360Html(items) {
  return `<!doctype html><html><body><ul>${items
    .map(
      (item) =>
        `<li class="res-list referer-news-flow"><h3 class="res-title"><a href="${item.url}">${item.title}</a></h3>`
        + `<p class="res-desc">${item.snippet}</p></li>`,
    )
    .join('')}</ul></body></html>`;
}

/** 四个假引擎的端点；`pages` 里没给的引擎返回 404（用来断言"这个引擎根本不该被请求"）。 */
async function startEngineWorld(pages) {
  const world = await startFakeServer(({ url, finish }) => {
    const page = pages[url.pathname.slice(1)];
    if (page === undefined) return finish(404, '<html>这个引擎不该被请求</html>');
    if (typeof page === 'function') return page(url, finish);
    return finish(200, page);
  });
  return {
    ...world,
    endpoints: {
      sogou: `${world.base}/sogou`,
      so360: `${world.base}/so360`,
      bing: `${world.base}/bing`,
      baidu: `${world.base}/baidu`,
    },
  };
}

test('引擎选择：搜狗答非所问就换 360，最终采用相关度高的那一批（不再赌固定顺序里的第一个）', async () => {
  const world = await startEngineWorld({
    // 搜狗只匹配上"西安"—— 这正是实测里 Bing 给的那种"降级结果"
    sogou: sogouHtml([
      { title: '西安市_百度百科', url: 'https://baike.baidu.com/item/西安市', snippet: '西安，简称"镐"，古称长安' },
      { title: '西安旅游攻略', url: 'https://travel.example.com/xian', snippet: '西安必去景点与美食' },
    ]),
    so360: so360Html([
      { title: '西安天气预报_15天_45天天气查询_全国天气网', url: 'https://tianqi.so.com/weather/101110101', snippet: '西安天气预报：今天 晴 16~25℃' },
      { title: '西安天气预报今天的最新相关消息', url: 'https://news.example.com/weather', snippet: '西安 天气 预报 今天' },
    ]),
    bing: bingHtml([{ title: '西安天气预报 Bing 版', url: 'https://bing.example.com/1', snippet: '今天' }]),
    baidu: baiduHtml([{ title: '西安天气预报 百度版', url: 'https://baidu.example.com/1', snippet: '今天' }]),
  });
  try {
    const detail = await searchWebDetailed({
      query: '西安 天气预报 今天',
      config: {},
      fetchImpl: localOnlyFetch(),
      endpoints: world.endpoints,
    });

    assert.deepEqual(detail.results.map((item) => item.source), ['360-html', '360-html']);
    assert.ok(detail.results.every((item) => item.url.includes('tianqi.so.com') || item.url.includes('news.example.com')));

    // notes 要写清"哪个引擎、相关度多少、为什么换"
    assert.ok(detail.notes.some((line) => line.includes('搜狗') && line.includes('低于阈值')), '要说清为什么换引擎');
    assert.ok(detail.notes.some((line) => line.includes('结果页解析成功') && line.includes('360 搜索')));
    assert.ok(detail.notes.some((line) => /平均相关度 \d\.\d\d/.test(line)), '相关度数字必须落在 notes 里');
    assert.ok(detail.notes.some((line) => line.includes('平均覆盖率')), '覆盖率口径也要写出来');

    // 够好了就停：Bing / 百度 一次都不该被请求（省请求，也让"为什么是 360"一目了然）
    const requested = world.state.requests.map((request) => request.path);
    assert.deepEqual(requested.filter((path) => path === '/bing' || path === '/baidu'), []);
    assert.ok(requested.includes('/sogou') && requested.includes('/so360'));
  } finally {
    await world.close();
  }
});

test('相关度：覆盖率 0 的条目直接丢掉（不相关的结果不许混进回答）', async () => {
  const world = await startEngineWorld({
    sogou: sogouHtml([
      { title: '西安天气预报一周查询', url: 'https://tianqi.example.com/1', snippet: '西安天气预报今天 晴' },
      { title: '成都旅游攻略_马蜂窝', url: 'https://travel.example.com/chengdu', snippet: '成都要去的十个地方' },
    ]),
  });
  try {
    const detail = await searchWebDetailed({
      query: '西安 天气预报 今天',
      config: {},
      fetchImpl: localOnlyFetch(),
      endpoints: world.endpoints,
    });
    assert.equal(detail.results.length, 1, '覆盖率 0 的那条必须被丢掉');
    assert.equal(detail.results[0].url, 'https://tianqi.example.com/1');
    assert.ok(
      detail.notes.some((line) => line.includes('丢掉 1 条覆盖率 0')),
      '丢了几条也要如实写进 notes',
    );
  } finally {
    await world.close();
  }
});

test('相关度：引擎都没答准（都低于阈值）时如实返回 + notes 说明，而不是装作搜到了', async () => {
  const pages = {
    sogou: sogouHtml([{ title: '西安旅游攻略', url: 'https://a.example.com/1', snippet: '西安美食' }]),
    so360: so360Html([{ title: '西安市政府门户', url: 'https://b.example.com/1', snippet: '西安市人民政府' }]),
    bing: bingHtml([{ title: '西安市_百度百科', url: 'https://c.example.com/1', snippet: '古称长安' }]),
    baidu: baiduHtml([{ title: '西安交通大学', url: 'https://d.example.com/1', snippet: '西安交大' }]),
  };
  const world = await startEngineWorld(pages);
  try {
    const detail = await searchWebDetailed({
      query: '西安 天气预报 今天',
      config: {},
      fetchImpl: localOnlyFetch(),
      endpoints: world.endpoints,
    });

    assert.ok(detail.results.length > 0, '真抓到的条目照样返回（不是伪造，也不是空手而归）');
    assert.ok(detail.results.every((item) => item.url.endsWith('/1')), '只返回覆盖率 > 0 的条目');
    assert.ok(
      detail.notes.some((line) => line.includes('相关度仍低于阈值') && line.includes('没搜准')),
      '必须明说"这次没搜准"，让模型能如实解释',
    );
    assert.ok(detail.notes.some((line) => line.includes('各自相关度')), '每个引擎的相关度都要留痕');

    // 引擎数量上限：已经拿到可用结果就停在 3 个，不许把 4 个引擎全跑一遍
    assert.equal(world.state.requests.length, SCRAPE_MAX_ENGINES, `最多试 ${SCRAPE_MAX_ENGINES} 个引擎`);
    assert.equal(SCRAPE_ENGINE_IDS.length, 4, '配置里一共有 4 个引擎，但默认只试前 3 个');
  } finally {
    await world.close();
  }
});

test('引擎数量上限：前 3 个一个可用结果都没有时，才允许"最后一搏"多试一个', async () => {
  const world = await startEngineWorld({
    sogou: '<html><body>403 forbidden</body></html>',
    so360: '<html><body>验证码</body></html>',
    bing: '<html><body>我们改版啦</body></html>',
    baidu: baiduHtml([{ title: '百度选课结果一', url: 'https://baidu.example.com/1', snippet: '选课' }]),
  });
  try {
    const detail = await searchWebDetailed({
      query: '选课',
      config: {},
      fetchImpl: localOnlyFetch(),
      endpoints: world.endpoints,
    });
    assert.equal(world.state.requests.length, SCRAPE_MAX_ENGINES + 1, '三个都空 → 允许再补试一个');
    assert.ok(detail.notes.some((line) => line.includes('最后一搏')));
    assert.equal(detail.results.length, 1, '最后一搏拿到的结果照样采用');
    assert.equal(detail.results[0].source, 'baidu-html');
    assert.ok(detail.notes.some((line) => line.includes('命中风控页特征')), '被拦的原因要写清');
  } finally {
    await world.close();
  }
});

test('请求头：默认带浏览器 UA / Accept-Language，搜索引擎跳转链带来源站 Referer', async () => {
  assert.equal(defaultReferer('http://www.baidu.com/link?url=abc'), 'https://www.baidu.com/');
  assert.equal(defaultReferer('https://www.sogou.com/link?url=abc'), 'https://www.sogou.com/');
  assert.equal(defaultReferer('https://www.so.com/link?m=abc'), 'https://www.so.com/');
  assert.equal(defaultReferer('https://dean.xjtu.edu.cn/info/1.htm'), '', '普通站点不带 Referer');

  const world = await startEngineWorld({
    sogou: sogouHtml([{ title: '选课通知', url: 'https://a.example.com/1', snippet: '选课安排' }]),
  });
  const record = [];
  try {
    await searchWebDetailed({
      query: '选课',
      config: {},
      fetchImpl: localOnlyFetch(record),
      endpoints: world.endpoints,
    });
    const headers = record[0].headers;
    assert.match(headers['User-Agent'], /Mozilla\/5\.0.*Chrome/, '要带浏览器 UA');
    assert.match(headers['Accept-Language'], /^zh-CN/, 'Accept-Language 要声明中文优先');
    assert.match(headers.Accept, /text\/html/);
    assert.equal(headers['Upgrade-Insecure-Requests'], '1', '浏览器做文档导航一定会带它');
    assert.equal(headers.Cookie, undefined, '绝不带 Cookie（不伪造登录态）');
  } finally {
    await world.close();
  }

  // 跳转链的 Referer 是**按 URL 自动判断**的：这里用桩 fetch 打一个搜狗域名，
  // 既能验证行为，又不用真的联网（真实域名在测试里是被 localOnlyFetch 禁掉的）
  const calls = [];
  const stubFetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    return new Response('<!doctype html><html><body>ok</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };
  await requestText(stubFetch, 'https://www.sogou.com/web?query=x', { accept: 'text/html' });
  assert.equal(calls[0].headers.Referer, 'https://www.sogou.com/', '搜索引擎跳转链要自带来源站 Referer');
  await requestText(stubFetch, 'https://dean.xjtu.edu.cn/info/1.htm', { accept: 'text/html' });
  assert.equal(calls[1].headers.Referer, undefined, '普通站点不要硬塞 Referer');

  // 显式 referer 也要能传下去（抓跳转链时用得到）
  const fake = await startFakeServer(({ finish }) => finish(200, articleHtml({ title: '目标页' })));
  const custom = [];
  try {
    await requestText(localOnlyFetch(custom), `${fake.base}/page/1`, {
      accept: 'text/html',
      referer: 'https://www.baidu.com/',
    });
    assert.equal(custom[0].headers.Referer, 'https://www.baidu.com/');
  } finally {
    await fake.close();
  }
});

test('相关度算法：查询词切分、标题/摘要权重、覆盖率口径', () => {
  assert.deepEqual(queryTerms('西安 天气预报 今天'), ['西安', '天气', '气预', '预报', '今天']);
  assert.deepEqual(
    queryTerms('最近有什么单位来访我们航空航天学院吗').filter((term) => ['最近', '什么', '我们', '吗'].includes(term)),
    [],
    '功能词不该进词表',
  );
  assert.ok(queryTerms('最近有什么单位来访我们航空航天学院吗').includes('航空'));
  assert.deepEqual(queryTerms('   '), []);
  assert.deepEqual(queryTerms('a 编译原理'), ['编译', '译原', '原理'], '单字母没信息量，中文长词切 2 字片段');

  const terms = ['西安', '天气', '气预', '预报', '今天'];
  // 标题命中算满分；只在摘要里命中打 6 折
  assert.equal(relevanceScore(terms, { title: '西安天气预报今天', snippet: '' }), 1);
  assert.equal(relevanceScore(terms, { title: '', snippet: '西安天气预报今天' }), 0.6);
  assert.equal(relevanceScore(terms, { title: '西安旅游攻略', snippet: '' }), 0.2);
  assert.equal(relevanceScore(terms, { title: '成都旅游攻略', snippet: '' }), 0);
  assert.equal(relevanceScore([], { title: '随便什么' }), 1, '查询词全是功能词时不惩罚');
  assert.equal(SCRAPE_RELEVANCE_THRESHOLD, 0.5);
});

test('解析器：搜狗与 360 的结果块能解析，相对跳转链会被解析成绝对 URL，高亮 <em> 不会被拆成空格', () => {
  const sogou = parseSogouResults(
    sogouHtml([
      { title: '<em>西安天气预报</em>一周,15天', url: '/link?url=hedJjaC291N2Q4', snippet: '<em>西安</em>主要地区<em>天气预报</em>' },
    ]),
    { baseUrl: 'https://www.sogou.com/web?query=x' },
  );
  assert.equal(sogou.length, 1);
  assert.equal(sogou[0].title, '西安天气预报一周,15天');
  assert.equal(sogou[0].snippet, '西安主要地区天气预报');
  // 搜狗的真实 href 是站内相对路径：必须带着 baseUrl 解析，否则 isJunkUrl 会把它整条丢掉
  assert.equal(sogou[0].url, 'https://www.sogou.com/link?url=hedJjaC291N2Q4', '相对跳转链要变成绝对链接');

  const so360 = parse360Results(
    so360Html([
      { title: '【<em>西安天气预报</em>】_15天', url: 'http://tianqi.so.com/weather/101110101', snippet: '<em>天气网</em>提供西安天气预报' },
      { title: '无链接的卡片结果', url: '', snippet: '不该出现' },
    ]),
  );
  assert.equal(so360.length, 1, '没有 href 的卡片结果不要');
  assert.equal(so360[0].title, '【西安天气预报】_15天');
  assert.equal(so360[0].source, '360-html');
});
