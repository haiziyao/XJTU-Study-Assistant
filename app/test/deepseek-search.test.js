/**
 * DeepSeek Search 接入测试。
 *
 * 依据官方文档 `https://api-docs.deepseek.com/zh-cn/guides/search`：
 *   · `POST https://api.deepseek.com/v1/tools/search`，Bearer 鉴权；
 *   · 请求 `{query, count(1–50), need_content, ori_question?}`；
 *   · 响应 `results[]`，每项带 `rerank_score / title / url / snippet / summary / content /
 *     site_name / date(RFC3339 UTC) / authority(-1..4)`；
 *   · **与聊天接口分开计费**（5 元/1000 次成功请求，QPS 5）——所以默认不启用，
 *     没配密钥时**一次都不能打到这个端点**（本文件最要紧的护栏）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { searchWebDetailed, SEARCH_PROVIDERS } from '../src/modules/ai/web-search.js';

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/tools/search';

/** 记录请求、返回一份文档形状的响应。 */
function fakeDeepSeek(payload, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers ?? {} });
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  };
  impl.calls = calls;
  return impl;
}

const SAMPLE = {
  results: [
    {
      rerank_score: 1.82,
      title: '关于 2026 年转专业工作的通知',
      url: 'https://dean.xjtu.edu.cn/info/1095/10422.htm',
      snippet: '短摘要',
      summary: '更长的摘要',
      content: '整篇正文，很长',
      site_name: '教务处',
      date: '2026-09-15T02:30:00Z',
      authority: 3,
    },
  ],
};

const config = { searchProvider: 'deepseek', searchApiKeys: { deepseek: 'sk-test-123' } };

/** 只挑打到 DeepSeek 的那个请求（免密钥通道会打别的地址，不能混在一起数）。 */
const deepseekCalls = (fetchImpl) => fetchImpl.calls.filter((call) => call.url === DEEPSEEK_URL);

test('deepseek 已在 provider 白名单里（否则配置里的密钥会被丢掉）', () => {
  assert.ok(SEARCH_PROVIDERS.includes('deepseek'));
});

test('★ 请求打到 /v1/tools/search，带 Bearer，且 count 在 1–50 内', async () => {
  const fetchImpl = fakeDeepSeek(SAMPLE);
  await searchWebDetailed({ query: '转专业 site:dean.xjtu.edu.cn', mode: 'web', limit: 5, config, fetchImpl });

  const call = deepseekCalls(fetchImpl)[0];
  assert.ok(call, '应当打到 deepseek');
  assert.equal(call.headers.Authorization, 'Bearer sk-test-123');
  assert.equal(call.body.query, '转专业 site:dean.xjtu.edu.cn', '★ 搜索语法要原样透传');
  assert.equal(call.body.count, 5);
  assert.equal(call.body.need_content, false);
});

test('count 永远落在 1–50 内；应用层的 searchMaxPages 上限（30）先生效', async () => {
  // 应用层先把 limit 夹到 30（`searchMaxPages` 的上限），provider 里的 50 是第二道保险，
  // 保证"别处直接调 provider"时也守得住文档的硬限制。
  // 200 会被应用层夹到 30（searchMaxPages 上限）
  {
    const fetchImpl = fakeDeepSeek(SAMPLE);
    await searchWebDetailed({ query: 'q', mode: 'web', limit: 200, config, fetchImpl });
    assert.equal(deepseekCalls(fetchImpl)[0].body.count, 30, '超上限应夹到 30');
  }
  // 非法/缺失的 limit 回落到配置里的默认条数 —— 只要求它落在合法区间，不钉死具体数字
  for (const limit of [0, -3, undefined]) {
    const fetchImpl = fakeDeepSeek(SAMPLE);
    await searchWebDetailed({ query: 'q', mode: 'web', limit, config, fetchImpl });
    const call = deepseekCalls(fetchImpl)[0];
    assert.ok(call, `limit=${limit} 时应当打到 deepseek`);
    assert.ok(call.body.count >= 1 && call.body.count <= 50, `limit=${limit} 时 count=${call.body.count} 必须落在 1–50`);
  }
});

test('字段映射：date → publishedAt、snippet 优先、带上 source', async () => {
  const fetchImpl = fakeDeepSeek(SAMPLE);
  const out = await searchWebDetailed({ query: '转专业', mode: 'web', limit: 5, config, fetchImpl });
  const item = out.results.find((hit) => hit.url.includes('10422'));
  assert.ok(item, '应当有那条结果');
  assert.equal(item.title, '关于 2026 年转专业工作的通知');
  assert.equal(item.publishedAt, '2026-09-15T02:30:00Z', '★ date 要能直接当 publishedAt');
  assert.equal(item.snippet, '短摘要', '有 snippet 时优先用它，不用更长的 summary');
  assert.equal(item.source, 'deepseek');
});

test('snippet 为空时退回 summary（而不是给个空串）', async () => {
  const payload = { results: [{ ...SAMPLE.results[0], snippet: '' }] };
  const fetchImpl = fakeDeepSeek(payload);
  const out = await searchWebDetailed({ query: 'q', mode: 'web', limit: 5, config, fetchImpl });
  const item = out.results.find((hit) => hit.url.includes('10422'));
  assert.equal(item.snippet, '更长的摘要');
});

test('★ 计费护栏：没配密钥时绝不打 deepseek（会走免费的免密钥通道）', async () => {
  const fetchImpl = fakeDeepSeek(SAMPLE);
  await searchWebDetailed({
    query: '转专业',
    mode: 'web',
    limit: 5,
    config: { searchProvider: 'deepseek', searchApiKeys: {} },
    fetchImpl,
  });
  // 免密钥通道会发请求（那是免费的），但**一次都不能打到按次计费的 deepseek**
  assert.equal(deepseekCalls(fetchImpl).length, 0, '★ 没有密钥绝不能打 deepseek —— 它按次计费');
});

test('上游把错误放在 200 的 body 里时当失败处理（不当成"没搜到"）', async () => {
  const fetchImpl = fakeDeepSeek({ error: { message: 'insufficient balance', code: 'insufficient_balance' } });
  const out = await searchWebDetailed({ query: 'q', mode: 'web', limit: 5, config, fetchImpl });
  assert.equal(out.results.length, 0);
  const text = JSON.stringify(out);
  assert.match(text, /insufficient balance|余额|error/i, '错误原因应当透出，而不是静默变成空结果');
});
