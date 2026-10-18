/**
 * DeepSeek 官方 Search / Fetch 接入的测试。
 *
 * **全程零真实外网**：假 DeepSeek 服务器与假网页都是本文件里用 `node:http` 起的，
 * 通过 `fetchImpl` / `config.searchApiBase` 注入。`localOnlyFetch()` 会拒绝任何非 127.0.0.1
 * 的请求 —— 一旦代码偷偷打真实域名就立刻失败，而不是悄悄联网。
 *
 * 覆盖点（对应需求）：
 *   - 请求体：campus 的 `site:` 语法、`count` 来自配置、`need_content:true`、`ori_question` 透传；
 *   - 响应映射：rerank_score/authority/date/summary/content/site_name → item 字段 + publishedAt + text；
 *   - 排序：rerank_score 降序（authority 次之、date 新者优先）；
 *   - 一次拿全：content 非空时不再 Fetch（请求数 = 1）；
 *   - 降级：429 两次后仍失败 → 回退抓取；402 → SEARCH_BALANCE_EXHAUSTED；401 → SEARCH_KEY_INVALID；
 *     Fetch 403/404 → 回退本地正文提取；
 *   - auto：无 key 走抓取，有 key 走官方；
 *   - 配置默认值 / 校验 / 打码，以及 AI 侧投影表字段契约。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { startMockAi } from './helpers/ai-mock.js';
import {
  DEEPSEEK_CONTENT_NOTE,
  DEEPSEEK_FETCH_NOTE,
  PAGE_TEXT_VIA,
  SEARCH_ERROR_CODES,
  deepSeekCampusQuery,
  fetchDeepSeekPage,
  pageFromSearchContent,
  readPages,
  resolveDeepSeekFetch,
  resolveSearchBackend,
  searchAndRead,
  searchDeepSeek,
  searchWebDetailed,
} from '../src/modules/ai/web-search.js';
import {
  AI_DEFAULTS,
  assertAiConfigInput,
  maskAiConfig,
  normalizeAiConfig,
} from '../src/modules/ai/config.js';

const realFetch = globalThis.fetch;

/** 只允许打到 127.0.0.1；顺手记录请求（断言"该带的头/体"与"没有偷偷联网"）。 */
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

/** 起一个本地假服务器；handler 拿到 `{ req, url, body, state, finish }`。 */
async function startFakeServer(handler) {
  const state = { requests: [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      state.requests.push({ method: req.method, path: url.pathname, search: url.searchParams, headers: req.headers, body });
      const finish = (status, payload, type = 'application/json; charset=utf-8') => {
        res.writeHead(status, { 'Content-Type': type });
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };
      Promise.resolve(handler({ req, url, body, state, finish })).catch((error) => finish(500, String(error)));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, state, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** 一条官方结果（字段名照官方文档）。 */
function deepseekResult(overrides = {}) {
  return {
    rerank_score: 1.8,
    title: '官方结果标题',
    url: 'https://example.com/a',
    snippet: '官方短摘要',
    summary: '官方长摘要：'.repeat(20),
    content: '官方正文：'.repeat(120),
    site_name: '示例站',
    site_icon: 'https://example.com/favicon.ico',
    date: '2026-10-01T08:00:00Z',
    authority: 3,
    ...overrides,
  };
}

/** 一个"像真的"的搜索结果页（免密钥 fallback 用）。 */
function sogouHtml(items) {
  return `<!doctype html><html><body>${items
    .map(
      (item) =>
        `<div class="vrwrap"><h3 class="vr-title"><a href="${item.url}">${item.title}</a></h3>`
        + `<div class="fz-mid space-txt">${item.snippet}</div></div>`,
    )
    .join('')}</body></html>`;
}

/** 静态文章页（本地正文提取用，正文必须 >200 字才不会被 meta 摘要顶掉）。 */
function articleHtml({ title = '一篇通知', body = '教务处通知正文。'.repeat(60) } = {}) {
  return `<!doctype html><html><head><title>${title}</title></head><body>
<nav>首页 | 教务处 | 联系我们</nav>
<article><h1>${title}</h1><p>${body}</p><p>联系人：教务处学籍科。</p></article>
<footer>版权所有</footer></body></html>`;
}

// ---------------------------------------------------------------------------
// 1. 请求体：campus site: 语法 / count / need_content / ori_question
// ---------------------------------------------------------------------------

test('Search 请求体：campus 用 site: 收窄、count 来自配置、need_content=true、ori_question 透传', async () => {
  const world = await startFakeServer(({ finish }) =>
    finish(200, {
      results: [
        deepseekResult({
          title: '航天航空学院：中物院流体物理研究所来访交流',
          url: 'https://sae.xjtu.edu.cn/info/1024/1173.htm',
          content: '来访交流正文。'.repeat(80),
        }),
      ],
    }),
  );
  const record = [];
  try {
    const detail = await searchWebDetailed({
      query: '来访 交流 航天航空学院',
      mode: 'campus',
      oriQuestion: '最近有什么单位来访我们航天航空学院吗',
      config: {
        apiKey: 'sk-deepseek-test-0001',
        searchProvider: 'auto',
        searchMaxPages: 12,
        searchNeedContent: true,
        searchApiBase: world.base,
      },
      fetchImpl: localOnlyFetch(record),
    });

    assert.equal(world.state.requests.length, 1, '有 key 时 campus 只该发一次官方请求（不再打校内站点/引擎）');
    const request = world.state.requests[0];
    assert.equal(request.path, '/v1/tools/search');
    assert.equal(request.headers.authorization, 'Bearer sk-deepseek-test-0001');
    const body = JSON.parse(request.body);
    assert.match(body.query, /site:sae\.xjtu\.edu\.cn/, '认得出"航天航空学院"就要用 site: 收窄到 sae');
    assert.equal(body.count, 12, 'count 来自「网络搜索最大条数」');
    assert.equal(body.need_content, true);
    assert.equal(body.ori_question, '最近有什么单位来访我们航天航空学院吗');

    assert.equal(detail.backend.kind, 'deepseek');
    assert.equal(detail.results.length, 1);
    assert.equal(detail.results[0].matchedBy, 'site');
    assert.equal(detail.results[0].scope, 'campus');
    assert.equal(detail.deepseek.attempts, 1);
    assert.equal(detail.deepseek.needContent, true);
  } finally {
    await world.close();
  }
});

test('campus site: 语法：认不出站点就用 site:xjtu.edu.cn，多个站点用 OR 连接', () => {
  assert.equal(deepSeekCampusQuery('选课'), '选课 site:xjtu.edu.cn');
  assert.equal(deepSeekCampusQuery('来访 交流 航天航空学院'), '来访 交流 航天航空学院 site:sae.xjtu.edu.cn');
  assert.equal(
    deepSeekCampusQuery('来访 交流', { hosts: ['sae.xjtu.edu.cn', 'gs.xjtu.edu.cn'] }),
    '来访 交流 site:sae.xjtu.edu.cn OR site:gs.xjtu.edu.cn',
  );
  // 调用方自己写了 site: 就不重复加
  assert.equal(deepSeekCampusQuery('选课 site:dean.xjtu.edu.cn'), '选课 site:dean.xjtu.edu.cn');
});

// ---------------------------------------------------------------------------
// 2. 响应映射 + 排序 + 一次拿全（不再逐页 Fetch）
// ---------------------------------------------------------------------------

test('响应映射：rerank_score/authority/date/summary/content/site_name → item 字段，按 rerank_score 降序', async () => {
  const world = await startFakeServer(({ finish }) =>
    finish(200, {
      results: [
        deepseekResult({
          title: '低相关但高权威',
          url: 'https://example.com/a',
          rerank_score: 1.2,
          authority: 4,
          date: '2026-10-01T08:00:00Z',
        }),
        deepseekResult({
          title: '最相关',
          url: 'https://example.com/b',
          rerank_score: 2.4,
          authority: 2,
          date: '2025-01-01T00:00:00Z',
          content: '最相关那篇的正文。'.repeat(50),
          summary: '最相关那篇的长摘要。'.repeat(10),
        }),
        deepseekResult({
          title: '次相关',
          url: 'https://example.com/c',
          rerank_score: 1.8,
          authority: 3,
          date: '2026-10-10T00:00:00Z',
        }),
      ],
    }),
  );
  try {
    const detail = await searchAndRead({
      query: '来访 交流',
      config: {
        apiKey: 'sk-deepseek-test-0002',
        searchMaxPages: 5,
        searchApiBase: world.base,
      },
      fetchImpl: localOnlyFetch(),
    });

    assert.deepEqual(
      detail.results.map((item) => item.title),
      ['最相关', '次相关', '低相关但高权威'],
      '排序必须是 rerank_score 降序（authority 只在同分时作次判据）',
    );
    const top = detail.results[0];
    assert.equal(top.rerankScore, 2.4);
    assert.equal(top.authority, 2);
    assert.equal(top.date, '2025-01-01T00:00:00.000Z');
    assert.equal(top.publishedAt, '2025-01-01', 'date 要映射到现有 publishedAt');
    assert.equal(top.siteName, '示例站');
    assert.match(top.summary, /长摘要/);
    assert.match(top.content, /正文/);

    // text 来自 Search 的 content（不是本地容器/摘要），且不再发 Fetch 请求
    assert.equal(detail.pages.length, 3);
    assert.equal(detail.pages[0].via, PAGE_TEXT_VIA.deepseekContent);
    assert.match(detail.pages[0].text, /最相关那篇的正文/);
    assert.equal(detail.pages[0].note, DEEPSEEK_CONTENT_NOTE);
    assert.equal(world.state.requests.length, 1, 'content 非空时整条链路只该有 1 次请求（Search）');
  } finally {
    await world.close();
  }
});

test('一次拿全：内容已带正文的条目不会触发 Fetch；readPages 也短路', async () => {
  const world = await startFakeServer(({ finish }) => finish(500, '不该被请求'));
  try {
    const record = [];
    const page = pageFromSearchContent(
      { title: '带正文', url: 'https://example.com/x', content: '已经有正文了。'.repeat(40) },
      { maxChars: 200 },
    );
    assert.equal(page.via, PAGE_TEXT_VIA.deepseekContent);
    assert.match(page.text, /已经有正文/);

    const pages = await readPages(
      [{ title: '带正文', url: 'https://example.com/x', content: '已经有正文了。'.repeat(40) }],
      { config: { apiKey: 'sk-deepseek-test-0003', searchApiBase: world.base }, fetchImpl: localOnlyFetch(record) },
    );
    assert.equal(pages.length, 1);
    assert.equal(pages[0].via, PAGE_TEXT_VIA.deepseekContent);
    assert.equal(record.length, 0, 'content 非空时 readPages 不该发任何请求');
    assert.equal(world.state.requests.length, 0);
  } finally {
    await world.close();
  }
});

test('need_content=false：请求体关掉全文，item 里也没有 content（空结果不计费）', async () => {
  const world = await startFakeServer(({ finish }) => finish(200, { results: [deepseekResult()] }));
  try {
    const detail = await searchWebDetailed({
      query: '来访 交流',
      config: {
        apiKey: 'sk-deepseek-test-0004',
        searchMaxPages: 5,
        searchNeedContent: false,
        searchApiBase: world.base,
      },
      fetchImpl: localOnlyFetch(),
    });
    const body = JSON.parse(world.state.requests[0].body);
    assert.equal(body.need_content, false);
    assert.equal(detail.results[0].content, undefined, '关掉 need_content 就不该有 content');
    assert.equal(resolveDeepSeekFetch({ apiKey: 'k', searchNeedContent: false }), null, '关掉正文时也不该逐页 Fetch');
  } finally {
    await world.close();
  }
});

// ---------------------------------------------------------------------------
// 3. 失败语义与降级
// ---------------------------------------------------------------------------

test('429 两次重试后仍失败 → 明确 SEARCH_RATE_LIMITED，并回退到免密钥抓取', async () => {
  const world = await startFakeServer(({ url, finish }) => {
    if (url.pathname === '/v1/tools/search') return finish(429, { error: { message: 'rate limit exceeded' } });
    if (url.pathname === '/sogou') {
      return finish(
        200,
        sogouHtml([
          { title: '西安 天气 今天 天气预报', url: 'https://tianqi.example.com/1', snippet: '西安 今天 天气 晴' },
        ]),
        'text/html; charset=utf-8',
      );
    }
    return finish(404, 'not found', 'text/html');
  });
  try {
    const detail = await searchWebDetailed({
      query: '西安 天气 今天',
      config: {
        apiKey: 'sk-deepseek-test-0005',
        searchMaxPages: 5,
        searchApiBase: world.base,
      },
      endpoints: {
        sogou: `${world.base}/sogou`,
        so360: `${world.base}/so360`,
        bing: `${world.base}/bing`,
        baidu: `${world.base}/baidu`,
      },
      fetchImpl: localOnlyFetch(),
      retryDelayMs: 1,
    });

    const searchRequests = world.state.requests.filter((request) => request.path === '/v1/tools/search');
    assert.equal(searchRequests.length, 3, '首次 + 2 次重试 = 3 次请求');
    assert.equal(detail.deepseek.error.code, SEARCH_ERROR_CODES.RATE_LIMITED);
    assert.equal(detail.deepseek.attempts, 3);
    assert.ok(detail.results.length >= 1, '官方失败后要回退抓取，而不是空手而归');
    assert.equal(detail.results[0].source, 'sogou-html');
    assert.ok(
      detail.notes.some((line) => line.includes('降级到免密钥通道') && line.includes('SEARCH_RATE_LIMITED')),
      'notes 要写明降级原因与错误码',
    );
  } finally {
    await world.close();
  }
});

test('402 → SEARCH_BALANCE_EXHAUSTED（不可重试，直接翻译成"余额不足"）', async () => {
  const world = await startFakeServer(({ finish }) => finish(402, { error: { message: 'Insufficient Balance' } }));
  try {
    const outcome = await searchDeepSeek({
      query: '来访 交流',
      apiKey: 'sk-deepseek-test-0006',
      baseUrl: world.base,
      fetchImpl: localOnlyFetch(),
      retryDelayMs: 1,
    });
    assert.equal(outcome.error.code, SEARCH_ERROR_CODES.BALANCE_EXHAUSTED);
    assert.match(outcome.error.message, /余额不足/);
    assert.equal(outcome.error.retryable, false);
    assert.equal(world.state.requests.length, 1, '402 不该重试');
  } finally {
    await world.close();
  }
});

test('401 → SEARCH_KEY_INVALID（不可重试）', async () => {
  const world = await startFakeServer(({ finish }) => finish(401, { error: { message: 'invalid api key' } }));
  try {
    const outcome = await searchDeepSeek({
      query: '来访 交流',
      apiKey: 'sk-bad',
      baseUrl: world.base,
      fetchImpl: localOnlyFetch(),
      retryDelayMs: 1,
    });
    assert.equal(outcome.error.code, SEARCH_ERROR_CODES.KEY_INVALID);
    assert.equal(outcome.error.retryable, false);
    assert.equal(world.state.requests.length, 1);
  } finally {
    await world.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Fetch：成功 → Markdown 正文；403/404/429 → 回退本地提取
// ---------------------------------------------------------------------------

test('Fetch 成功：Markdown 正直接作为 text，via=deepseek-fetch，note 说明官方来源', async () => {
  const world = await startFakeServer(({ url, body, finish }) => {
    if (url.pathname === '/v1/tools/fetch') {
      const payload = JSON.parse(body);
      assert.match(payload.url, /\/page\/ok$/);
      return finish(200, { title: '官方抓取标题', content: '# 官方标题\n\n这是 Fetch 返回的 Markdown 正文。'.repeat(20) });
    }
    return finish(404, 'not found', 'text/html');
  });
  try {
    const pages = await readPages(
      [{ title: '原标题', url: `${world.base}/page/ok` }],
      {
        config: { apiKey: 'sk-deepseek-test-0007', searchApiBase: world.base },
        fetchImpl: localOnlyFetch(),
      },
    );
    assert.equal(pages.length, 1);
    assert.equal(pages[0].ok, true);
    assert.equal(pages[0].via, PAGE_TEXT_VIA.deepseekFetch);
    assert.equal(pages[0].title, '官方抓取标题');
    assert.match(pages[0].text, /Fetch 返回的 Markdown 正文/);
    assert.equal(pages[0].note, DEEPSEEK_FETCH_NOTE);
    assert.equal(world.state.requests.filter((request) => request.path === '/v1/tools/fetch').length, 1);
    assert.equal(world.state.requests.some((request) => request.path === '/page/ok'), false, 'Fetch 成功就不该再打本地提取');
  } finally {
    await world.close();
  }
});

test('Fetch 403 / 404 → 回退本地正文提取（不重试、via 回到 container/body、note 写明回退）', async () => {
  const world = await startFakeServer(({ url, body, finish }) => {
    if (url.pathname === '/v1/tools/fetch') {
      const payload = JSON.parse(body);
      if (/\/page\/forbidden$/.test(payload.url)) return finish(403, { error: { message: 'blocked by safety policy' } });
      return finish(404, { error: { message: 'no usable content' } });
    }
    if (url.pathname === '/page/forbidden' || url.pathname === '/page/missing') {
      return finish(200, articleHtml({ title: '本地提取到的通知' }), 'text/html; charset=utf-8');
    }
    return finish(404, 'not found', 'text/html');
  });
  try {
    for (const [name, code] of [
      ['forbidden', SEARCH_ERROR_CODES.FETCH_FORBIDDEN],
      ['missing', SEARCH_ERROR_CODES.FETCH_NOT_FOUND],
    ]) {
      const pages = await readPages(
        [{ title: '通知', url: `${world.base}/page/${name}` }],
        {
          config: { apiKey: 'sk-deepseek-test-0008', searchApiBase: world.base },
          fetchImpl: localOnlyFetch(),
          retryDelayMs: 1,
        },
      );
      assert.equal(pages[0].ok, true, `${name} 的本地提取应成功`);
      assert.equal(pages[0].via, PAGE_TEXT_VIA.body, '回退后 via 仍是本地提取');
      assert.match(pages[0].text, /教务处通知正文/);
      assert.match(pages[0].note, new RegExp(`${code}.*回退本地`), 'note 要如实说明 Fetch 失败并回退');

      const fetchRequests = world.state.requests.filter((request) => request.path === '/v1/tools/fetch');
      assert.ok(fetchRequests.length >= 1);
      if (name === 'forbidden') assert.equal(fetchRequests.length, 1, '403 不该重试');
    }
  } finally {
    await world.close();
  }
});

test('Fetch 前置校验：无 host / 带用户名密码 / 非 http(s) 直接拒绝', async () => {
  for (const url of ['https://', 'ftp://example.com/x', 'https://user:pass@example.com/x']) {
    const outcome = await fetchDeepSeekPage({ url, apiKey: 'sk-x', fetchImpl: localOnlyFetch() });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, 'SEARCH_FETCH_BAD_URL', url);
  }
});

// ---------------------------------------------------------------------------
// 5. auto：无 key 走抓取，有 key 走官方
// ---------------------------------------------------------------------------

test('auto：无 key → 抓取；有 key → 官方；scrape 即使有 key 也不打官方', async () => {
  assert.equal(resolveSearchBackend({}).kind, 'scrape');
  assert.equal(resolveSearchBackend({ apiKey: 'sk-x' }).kind, 'deepseek');
  assert.equal(resolveSearchBackend({ apiKey: 'sk-x', searchProvider: 'scrape' }).kind, 'scrape');
  assert.equal(resolveSearchBackend({ searchProvider: 'deepseek' }).kind, 'scrape', '显式选官方但没 key → 抓取兜底');

  const world = await startFakeServer(({ url, finish }) => {
    if (url.pathname === '/v1/tools/search') return finish(200, { results: [deepseekResult({ url: 'https://example.com/official' })] });
    if (url.pathname === '/sogou') {
      return finish(
        200,
        sogouHtml([{ title: '选课 通知', url: 'https://example.com/scraped', snippet: '选课 通知 摘要' }]),
        'text/html; charset=utf-8',
      );
    }
    return finish(404, 'not found', 'text/html');
  });
  const endpoints = {
    sogou: `${world.base}/sogou`,
    so360: `${world.base}/so360`,
    bing: `${world.base}/bing`,
    baidu: `${world.base}/baidu`,
  };
  try {
    const noKey = await searchWebDetailed({
      query: '选课 通知',
      config: {},
      endpoints,
      fetchImpl: localOnlyFetch(),
    });
    assert.equal(noKey.backend.kind, 'scrape');
    assert.equal(noKey.results[0].source, 'sogou-html');
    assert.equal(world.state.requests.some((request) => request.path === '/v1/tools/search'), false);

    const withKey = await searchWebDetailed({
      query: '选课 通知',
      config: { apiKey: 'sk-deepseek-test-0009', searchMaxPages: 5, searchApiBase: world.base },
      endpoints,
      fetchImpl: localOnlyFetch(),
    });
    assert.equal(withKey.backend.kind, 'deepseek');
    assert.equal(withKey.results[0].source, 'deepseek-search');
    assert.equal(withKey.results[0].url, 'https://example.com/official');
    assert.equal(world.state.requests.filter((request) => request.path === '/v1/tools/search').length, 1);
  } finally {
    await world.close();
  }
});

// ---------------------------------------------------------------------------
// 6. 配置与投影契约
// ---------------------------------------------------------------------------

test('配置：searchApiBase / searchNeedContent 默认值与严格校验，打码不泄露 key', () => {
  assert.equal(AI_DEFAULTS.searchApiBase, 'https://api.deepseek.com');
  assert.equal(AI_DEFAULTS.searchNeedContent, true);

  assert.equal(normalizeAiConfig({}).searchApiBase, 'https://api.deepseek.com');
  assert.equal(normalizeAiConfig({ searchApiBase: 'http://127.0.0.1:9000/proxy/' }).searchApiBase, 'http://127.0.0.1:9000/proxy');
  assert.equal(normalizeAiConfig({ searchApiBase: 'ftp://bad' }).searchApiBase, 'https://api.deepseek.com');
  assert.equal(normalizeAiConfig({ searchNeedContent: 'off' }).searchNeedContent, false);
  assert.equal(normalizeAiConfig({ searchNeedContent: 'yes' }).searchNeedContent, true);
  assert.equal(normalizeAiConfig({ searchProvider: 'deepseek' }).searchProvider, 'deepseek');

  assert.throws(() => assertAiConfigInput({ searchApiBase: 'ftp://x' }), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.details.field, 'searchApiBase');
    return true;
  });

  const masked = maskAiConfig(normalizeAiConfig({ apiKey: 'sk-super-secret-9876', searchProvider: 'auto' }));
  assert.equal(JSON.stringify(masked).includes('sk-super-secret-9876'), false);
  assert.equal(masked.searchBackend, 'deepseek');
  assert.equal(masked.searchKeyHint, '…9876');
  assert.equal(masked.hasDeepSeekKey, true);
  assert.equal(masked.searchNeedContent, true);

  // 显式 deepseek 时 searchApiKey 可以覆盖官方 key，但绝不能被当成 Tavily 的密钥
  const override = maskAiConfig(normalizeAiConfig({
    searchProvider: 'deepseek',
    searchApiKey: 'sk-search-override-1111',
  }));
  assert.equal(override.searchBackend, 'deepseek');
  assert.equal(override.searchKeyHint, '…1111');
  assert.equal(override.searchKeys.tavily.hasKey, false, 'DeepSeek 的 key 不能喂给 Tavily');
});

test('契约：AI 侧 web 投影表包含官方新字段与提示词口径', async () => {
  const source = await readFile(new URL('../src/modules/ai/chat-service.js', import.meta.url), 'utf8');
  const line = source.split('\n').find((row) => row.includes("web: ['title'"));
  assert.ok(line, '找不到 web 投影表');
  for (const field of ['summary', 'date', 'authority', 'rerankScore', 'siteName']) {
    assert.ok(line.includes(`'${field}'`), `投影表要包含 ${field}：${line.trim()}`);
  }
  const prompt = await readFile(new URL('../src/modules/ai/web-search.js', import.meta.url), 'utf8');
  assert.ok(prompt.includes('时按时间判断新旧'), '提示词要讲 date 的用法');
  assert.ok(prompt.includes('优先采信高权威、高相关的结果'), '提示词要讲 authority/rerankScore 的用法');
  assert.ok(prompt.includes('长摘要') && prompt.includes('才是正文'), '提示词要讲 summary 与 content 的分工');
});

// ---------------------------------------------------------------------------
// 7. 对话闭环：ori_question 透传 + content 直接回灌（不再 Fetch）+ 投影字段
// ---------------------------------------------------------------------------

test('对话闭环：官方一次 Search 拿全正文（零 Fetch），ori_question 用用户原话，投影带官方字段', async () => {
  const world = await startFakeServer(({ finish }) =>
    finish(200, {
      results: [
        deepseekResult({
          title: '航天航空学院：来访交流',
          url: 'https://sae.xjtu.edu.cn/info/1024/1173.htm',
          rerank_score: 2.6,
          authority: 3,
          date: '2026-10-12T02:00:00Z',
          summary: '学院近期接待了中物院流体物理研究所来访，双方就高温力学合作展开交流。',
          content: '来访交流的正文：双方就高温力学合作展开交流。'.repeat(40),
          site_name: '航天航空学院',
        }),
      ],
    }),
  );
  const key = 'sk-test-deepseek-chat-0001';
  const mock = await startMockAi({
    apiKey: key,
    replies: [
      '我查一下。\n```command\n'
        + JSON.stringify({ ok: true, action: 'query', target: 'web', fields: { query: '来访 交流 航天航空学院' }, explain: '查学院来访' })
        + '\n```',
      '查到了：学院近期有来访交流。',
    ],
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'potato-deepseek-chat-'));
  const app = await createServer({ dataDir: dir, ai: { searchFetch: localOnlyFetch() } });
  const info = await app.listen({ port: 0 });
  const call = async (method, route, body) => {
    const response = await fetch(`${info.baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const saved = await call('POST', '/ai/config', {
      apiKey: key,
      model: 'deepseek-flash',
      baseUrl: mock.baseUrl,
      searchProvider: 'auto',
      searchMaxPages: 5,
      searchApiBase: world.base,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const userText = '帮我搜一下最近有什么单位来访我们学院';

    const sent = await call('POST', '/ai/chat', { text: userText, search: 'web', stream: false });
    assert.equal(sent.status, 200, JSON.stringify(sent.body).slice(0, 300));

    // 1) 只发了一次 Search，没有逐页 Fetch、也没有本地抓页
    assert.equal(world.state.requests.filter((request) => request.path === '/v1/tools/search').length, 1);
    assert.equal(world.state.requests.filter((request) => request.path === '/v1/tools/fetch').length, 0);
    // 2) ori_question 是用户原话（不是模型改写的检索词）
    const searchBody = JSON.parse(world.state.requests.find((request) => request.path === '/v1/tools/search').body);
    assert.equal(searchBody.ori_question, userText);
    assert.equal(searchBody.need_content, true);

    // 3) 回灌给模型的结果带官方字段，且正文直接来自 content
    const entry = (sent.body.queried ?? [])[0];
    assert.ok(entry?.result, JSON.stringify(sent.body.queried));
    assert.equal(entry.result.items.length, 1);
    const item = entry.result.items[0];
    assert.equal(item.rerankScore, 2.6);
    assert.equal(item.authority, 3);
    assert.equal(item.date, '2026-10-12T02:00:00.000Z');
    assert.equal(item.publishedAt, '2026-10-12');
    assert.equal(item.siteName, '航天航空学院');
    assert.match(item.summary, /中物院/);
    assert.equal(item.textSource, PAGE_TEXT_VIA.deepseekContent);
    assert.match(item.text, /来访交流的正文/);
    assert.equal(mock.state.calls, 2, '草稿一轮 + 作答一轮');
  } finally {
    await app.close();
    await mock.close();
    await world.close();
  }
});
