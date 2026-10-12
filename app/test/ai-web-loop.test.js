/**
 * 「联网检索」在对话多轮循环里的端到端测试（**全程不联网**）。
 *
 * 为什么值得单独测：检索这条链有四个"错了会静默出事"的地方 ——
 *   1. **开关没关住**：界面上选了「不联网」，模型却还是发出去了请求（用户会以为程序偷偷联网）；
 *   2. **预校验把检索跑了两遍**：`previewDrafts` 是 dryRun，只读查询本来要在循环里再跑一次，
 *      但联网检索有副作用（真的请求、可能计费），必须"推迟执行"（见 drafts.js 的 DEFERRED_TARGETS）；
 *   3. **正文没回灌**：只把标题给模型，它就只能凭标题猜，回答会像"看起来读过"；
 *   4. **网页上限不生效**：设置里的「网络搜索最大条数」决定读几个网页，越界必须收敛。
 *
 * 假世界：本地 `node:http` 同时扮演「搜索引擎结果页」与「被搜到的文章页」，
 * 通过 `createServer({ ai: { searchFetch } })` 注入 —— 任何真实外网请求都不会发生。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server/index.js';
import { startMockAi } from './helpers/ai-mock.js';

const KEY = 'sk-test-search-0001';

const fenced = (draft) => ['```command', JSON.stringify(draft), '```'].join('\n');

/** 一个 Bing 形状的结果页：`<li class="b_algo">` + `<h2><a href>` + `<p>` 摘要。 */
function bingPage(items) {
  const blocks = items
    .map(
      (item) => `<li class="b_algo"><h2><a href="${item.url}">${item.title}</a></h2><p>${item.snippet}</p></li>`,
    )
    .join('');
  return `<!doctype html><html><body><ol id="b_results">${blocks}</ol></body></html>`;
}

/** 起假搜索引擎 + 假文章页，返回 `{ origin, fetchImpl, hits, pages }`。 */
async function startFakeWeb({ articleText = '这是教务处通知的正文：转专业申请时间为每学年春季学期。' } = {}) {
  const hits = [];
  const pages = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/doc1' || url.pathname === '/doc2' || url.pathname === '/doc3') {
      pages.push(url.pathname);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><head><title>通知</title></head><body>` +
          `<nav>首页 | 教务处 | 联系我们</nav>` +
          `<article><h1>关于转专业的通知</h1><p>${articleText}</p><p>联系人：教务处学籍科。</p></article>` +
          `<footer>版权所有</footer></body></html>`,
      );
      return;
    }
    hits.push(url.search);
    // 结果条数故意给 6 条（超过最小上限 5），用来验证"读几个"确实由配置决定
    // 标题与摘要**必须含查询词**：检索现在会按"查询词覆盖率"过滤（覆盖率 0 的条目直接丢），
    // 而真实结果本来就会含查询词 —— 造假数据也得像真的，否则测的是"过滤器把垃圾丢了"而不是检索链路
    const items = [1, 2, 3, 4, 5, 6].map((n) => ({
      url: `http://127.0.0.1:${server.address().port}/doc${((n - 1) % 3) + 1}?i=${n}`,
      title: `转专业 相关通知 第 ${n} 条`,
      snippet: `教务处关于转专业申请的通知摘要（第 ${n} 条）`,
    }));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(bingPage(items));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  /**
   * 注入用 fetch：把搜索站域名改写到本地假引擎，其余原样。
   *
   * 这样除了"搜索引擎"这一跳，其它代码路径（结果解析、正文抓取、清洗、截断、回灌）
   * 全都按生产逻辑跑 —— 测试才有效。
   */
  /**
   * 注入用 fetch：把**所有搜索引擎域名**改写到本地假引擎，其它非本地地址一律抛错。
   *
   * 两条都必须：
   *   - 引擎清单是会变的（现在有 bing / 百度 / 搜狗 / 360，将来可能更多），只拦 bing/baidu
   *     就会漏掉新引擎 → 测试偷偷打真网（曾实测到 6.3 秒的"慢"就是打真网超时）；
   *   - 非本地地址**直接抛**，这样"测试不联网"是**强制**的，而不是靠自觉。
   */
  const ENGINE_HOSTS = /(^|\.)(bing\.com|baidu\.com|sogou\.com|so\.com|duckduckgo\.com|mojeek\.com)$/i;
  const fetchImpl = (input, init) => {
    const raw = typeof input === 'string' ? input : input?.url ?? String(input);
    const url = new URL(raw);
    if (ENGINE_HOSTS.test(url.hostname)) {
      return fetch(`${origin}/search?${url.searchParams.toString()}`, init);
    }
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return fetch(raw, init);
    throw new Error(`测试不该访问外网：${raw}`);
  };
  return { origin, fetchImpl, hits, pages, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function startApp({ searchFetch, ai, dataDir } = {}) {
  const dir = dataDir ?? (await mkdtemp(path.join(tmpdir(), 'potato-ai-web-')));
  const app = await createServer({ dataDir: dir, ...(ai ? { ai } : {}), ...(searchFetch ? { ai: { ...(ai ?? {}), searchFetch } } : {}) });
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
  return { app, info, call, dataDir: dir };
}

/** 配好指向 mock 上游的 AI（免密钥通道 + 指定条数）。 */
async function configure(call, mock, extra = {}) {
  const saved = await call('POST', '/ai/config', {
    apiKey: KEY,
    model: 'deepseek-flash',
    baseUrl: mock.baseUrl,
    searchProvider: 'scrape',
    searchMaxPages: 5,
    ...extra,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
}

test('联网检索：开关是「不联网」时，一条请求都不发，并明确告诉模型原因', async () => {
  const mock = await startMockAi({
    apiKey: KEY,
    replies: [
      `我搜一下。\n${fenced({ ok: true, action: 'query', target: 'web', fields: { query: '转专业 条件' }, explain: '搜一下' })}`,
      '好的，那我不搜了。',
    ],
  });
  const web = await startFakeWeb();
  const { app, call } = await startApp({ searchFetch: web.fetchImpl });
  try {
    await configure(call, mock);
    const sent = await call('POST', '/ai/chat', {
      text: '帮我搜一下转专业条件',
      search: 'off',
      permission: 'manual',
      stream: false,
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(web.hits.length, 0, '关了联网就不许发检索请求');
    // 回灌给模型的内容里必须写清"为什么没搜" —— 否则它会以为"网上没有"
    const fedBack = mock.state.bodies
      .flatMap((body) => body.messages ?? [])
      .map((message) => String(message.content ?? ''))
      .join('\n');
    assert.match(fedBack, /联网搜索已关闭/, '回灌内容要说明联网已关闭');
    // 页面上也要能看见这条失败原因（用户有权知道为什么没搜）
    const queried = sent.body.queried ?? [];
    assert.equal(queried.length, 1);
    assert.equal(queried[0].error?.code, 'SEARCH_OFF');
  } finally {
    await app.close();
    await web.close();
    await mock.close();
  }
});

test('联网检索：开着时搜一次、读正文并回灌 —— 预校验不会重复搜（次数=1）', async () => {
  const mock = await startMockAi({
    apiKey: KEY,
    replies: [
      `我查一下。\n${fenced({ ok: true, action: 'query', target: 'web', fields: { query: '转专业 通知' }, explain: '查一下' })}`,
      '看到了，通知里写了申请时间。',
    ],
  });
  const web = await startFakeWeb();
  const { app, call } = await startApp({ searchFetch: web.fetchImpl });
  try {
    await configure(call, mock, { searchMaxPages: 5 });
    const sent = await call('POST', '/ai/chat', {
      text: '搜一下转专业通知',
      search: 'web',
      permission: 'manual',
      stream: false,
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    /**
     * 「一次提问只该搜一次」的新语义：**同一条查询**最多试几个引擎（现在会按相关度换引擎，
     * 见 web-search.js 的引擎选择），但绝不能因为"预校验 + 执行"把同一条查询跑两遍。
     * 所以断言的是"请求用的都是同一个查询词，且次数不超过引擎上限（3）"。
     */
    assert.ok(web.hits.length >= 1 && web.hits.length <= 3, `同一查询最多试 3 个引擎，实际 ${web.hits.length}`);
    // 各引擎的查询参数名不同（Bing/360 用 q、搜狗用 query、百度用 wd），所以三个都取一遍再比
    const queries = new Set(
      web.hits
        .map((search) => {
          const params = new URLSearchParams(search.replace(/^\?/, ''));
          return params.get('q') ?? params.get('query') ?? params.get('wd') ?? '';
        })
        .filter(Boolean),
    );
    assert.equal(queries.size, 1, `不该出现两条不同的查询（说明同一条查询被重复执行了）：${[...queries].join(' | ')}`);

    const entry = (sent.body.queried ?? [])[0];
    assert.ok(entry?.result, `应该有一条检索结果：${JSON.stringify(sent.body.queried)}`);
    assert.equal(entry.result.target, 'web');
    assert.ok(entry.result.items.length > 0, '要有条目');
    assert.ok(entry.result.items.length <= 5, `条数要收敛到设置里的 5，实际 ${entry.result.items.length}`);
    const withText = entry.result.items.filter((item) => item.text);
    assert.ok(withText.length > 0, '要有条目带正文（只有标题等于没读过）');
    assert.match(withText[0].text, /转专业申请时间/, '正文应是文章里的真实文字');
    assert.match(withText[0].url, /^http:\/\/127\.0\.0\.1:\d+\/doc/, 'url 要是真实抓到的那个');

    // 回灌给模型的 JSON 里必须同时有链接与正文，模型才可能"引用真实来源"
    const fedBack = mock.state.bodies
      .flatMap((body) => body.messages ?? [])
      .map((message) => String(message.content ?? ''))
      .join('\n');
    assert.match(fedBack, /\[系统注入\]/, '要有回灌消息');
    assert.match(fedBack, /转专业申请时间为每学年春季学期/, '回灌里要有正文原文');
    assert.match(fedBack, /"url":"http:\/\/127\.0\.0\.1:\d+\/doc/, '回灌里要有真实链接');
  } finally {
    await app.close();
    await web.close();
    await mock.close();
  }
});

test('联网检索：网页上限来自设置（5–30），模型要更多也不越过它', async () => {
  const mock = await startMockAi({
    apiKey: KEY,
    replies: [
      `我多读几篇。\n${fenced({ ok: true, action: 'query', target: 'web', fields: { query: '转专业', limit: 30 }, explain: '多读几篇' })}`,
      '读完了。',
      // 第二次提问会再有"草稿 + 结论"两轮（同一个 mock 上游按调用次数取回复）
      `再读一轮。\n${fenced({ ok: true, action: 'query', target: 'web', fields: { query: '转专业', limit: 30 }, explain: '再读一轮' })}`,
      '这次读得更多。',
    ],
  });
  const web = await startFakeWeb();
  const { app, call } = await startApp({ searchFetch: web.fetchImpl });
  try {
    await configure(call, mock, { searchMaxPages: 5 });
    const sent = await call('POST', '/ai/chat', { text: '多搜几篇', search: 'web', stream: false });
    const entry = (sent.body.queried ?? [])[0];
    assert.ok(entry?.result, JSON.stringify(sent.body.queried));
    assert.ok(
      entry.result.items.length <= 5,
      `设置里是 5，模型要 30 也只能读 5，实际 ${entry.result.items.length}`,
    );
    // 设置改成 6 之后立刻生效（不需要重启）
    await configure(call, mock, { searchMaxPages: 6 });
    const again = await call('POST', '/ai/chat', { text: '再多搜几篇', search: 'web', stream: false });
    const entry2 = (again.body.queried ?? [])[0];
    assert.ok(entry2?.result, JSON.stringify(again.body.queried));
    assert.ok(entry2.result.items.length > 5, `改成 6 之后应该能读到第 6 条，实际 ${entry2.result.items.length}`);
  } finally {
    await app.close();
    await web.close();
    await mock.close();
  }
});

test('联网检索：试搜接口把诊断信息一起给出来（后端选择 / 条数 / 抓到正文几条）', async () => {
  const mock = await startMockAi({ apiKey: KEY, reply: '（本用例不该调用模型）' });
  const web = await startFakeWeb();
  const { app, call } = await startApp({ searchFetch: web.fetchImpl });
  try {
    await configure(call, mock, { searchMaxPages: 5 });
    const bad = await call('POST', '/ai/search/test', { query: '   ' });
    assert.equal(bad.status, 400, '空检索词要 400，而不是返回空结果');
    const ok = await call('POST', '/ai/search/test', { query: '转专业', mode: 'web' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.mode, 'web');
    assert.equal(ok.body.limit, 5);
    assert.equal(ok.body.backend?.kind, 'scrape', '没配密钥时如实说明走的是免密钥通道');
    assert.ok(ok.body.count > 0);
    assert.ok(ok.body.read > 0, '要报告读到了几篇正文');
    assert.ok(Array.isArray(ok.body.notes) && ok.body.notes.length > 0, '要有可读的诊断说明');
    assert.equal(mock.state.calls, 0, '试搜不该调用模型');
  } finally {
    await app.close();
    await web.close();
    await mock.close();
  }
});
