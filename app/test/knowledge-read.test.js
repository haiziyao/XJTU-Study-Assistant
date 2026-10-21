/**
 * 「点名读一篇」这条通道的测试：`search({ path | url })` 必须回**够用的正文**，
 * 而按关键词检索仍然只回片段。
 *
 * 为什么单独开一个文件、且句句钉在真语料上：
 *   跨功能实测（用户问"学校对学业预警是怎么规定的？我会不会被预警？"）失败过 ——
 *   模型引用了真链接、也确实按 url 读到了那一篇，却说"这一页正文读到第三条就断了"，
 *   给不出 12 / 8 / 4 学分三档阈值。根因不是模型，是工具面：
 *     - `search()` 只把 240 字片段放进 item（当时 `service.js` 的 `#searchByPath`；本版已调到 800）；
 *     - 模型唯一的入口是 `commands.js` 的 `query()`，它只调 `search()`；
 *     - 能返回全文的 `read()` 只挂在 HTTP `GET /knowledge/doc` 上，**不是 AI target**。
 *   而《学业预警与学籍处理实施细则》2169 字，那张 "12 / 8 / 4 学分" 的表格在**第 341 字**处 ——
 *   240 字片段刚好停在"一级预警、二级预警、三级…"，**差一行就是数字**。
 *   现在片段默认 800 字，且带 `offset` / `nextOffset`，模型可以先检索、再按位置续读。
 *
 * 所以这里的断言刻意"看数字，不看长度"：`/12\s*学分/` 这类模式必须真的出现在返回内容里。
 * 只断言 `content.length > 240` 是骗得过去的（片段长一点就绿了），而数字骗不过去。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { KnowledgeService } from '../src/modules/knowledge/service.js';
import { createKnowledgeCommands } from '../src/modules/knowledge/commands.js';

/** 那篇"基准篇"：2169 字，12/8/4 三档阈值在第 341 字的表格里。 */
const WARNING_REL = 'knowledge/dean/gzzd-jwgl/06-西安交通大学本科生学业预警与学籍处理实施细则（试行）.md';
const WARNING_REL_IN_CORPUS = 'gzzd-jwgl/06-西安交通大学本科生学业预警与学籍处理实施细则（试行）.md';
const WARNING_URL = 'https://dean.xjtu.edu.cn/info/1033/1130.htm';

/** 三档阈值的写法：数字与"学分"之间可能有空格（语料里就有），所以别写死成一个字符串。 */
const THRESHOLDS = [
  { pattern: /12\s*学分/, label: '一级预警 12 学分' },
  { pattern: /8\s*学分/, label: '二级预警 8 学分' },
  { pattern: /4\s*学分/, label: '三级预警 4 学分' },
];

/** 真实语料服务（已 restore）；语料缺失时用例会明确失败，而不是静默跳过。 */
async function realService() {
  const knowledge = new KnowledgeService({ log: () => {} });
  await knowledge.restore();
  assert.equal(knowledge.available, true, '真实语料应该可用（knowledge/dean/index.json）');
  return knowledge;
}

/** 断言一段正文里三档阈值都在 —— 这是"AI 能读到条款"的最小可验证标准。 */
function assertThresholds(text, where) {
  for (const { pattern, label } of THRESHOLDS) {
    assert.match(text, pattern, `${where} 里应该读到「${label}」：${JSON.stringify(String(text).slice(0, 120))}`);
  }
}

/* ------------------------------------------------------------------ 点名读一篇 */

test('点名读一篇：filters.path 用**语料相对路径**写，回正文且含 12/8/4 学分阈值', async () => {
  const knowledge = await realService();
  const result = knowledge.search({ path: WARNING_REL, q: '学业预警' });
  assert.equal(result.count, 1);
  const [item] = result.items;
  assert.equal(item.title, '西安交通大学本科生学业预警与学籍处理实施细则（试行）');
  assert.equal(item.url, WARNING_URL, '正文要带着能点回去的出处');
  assert.equal(item.score, null, '直接定位不是排序出来的');

  // 片段**仍然比正文短**（它服务于"扫一眼"），长正文另走 content。
  // 本版把默认片段调到 800 字：240 字会停在阈值表格之前，模型只能回去整篇读。
  assert.ok(item.snippet.length <= 900, `片段仍应短于全文：${item.snippet.length}`);
  assert.ok(item.snippet.length < item.content.length, '片段不该等于全文');
  assert.match(item.snippet, /学业预警/, '片段要包含命中处的上下文');

  assert.equal(typeof item.content, 'string');
  // 带 q 时窗口会从命中处附近开始（offset 可能不是 0），"没截断"的判据是
  // offset + content 覆盖到原文末尾，而不是 content 从第 0 字开始。
  assert.equal(item.truncated, false, '2169 字没超过 4000 字窗口');
  assert.equal(item.offset + item.content.length, item.totalChars, '没截断时窗口应覆盖到原文末尾');
  assert.ok(item.content.length > 2000, `正文要给够：${item.content.length}`);
  assertThresholds(item.content, 'path 直读的 content');

  // 顺带确认"语料相对路径"（不带 knowledge/dean 前缀）也认 —— 索引里存的是仓库相对写法，
  // 模型照抄两种写法都可能出现
  assert.equal(knowledge.search({ path: WARNING_REL_IN_CORPUS }).items[0].title, item.title);
});

test('点名读一篇：filters.path 用**来源 URL** 写，同样回含阈值的正文', async () => {
  const knowledge = await realService();
  for (const asUrl of [WARNING_URL, '/info/1033/1130.htm']) {
    const [item] = knowledge.search({ path: asUrl }).items;
    assert.equal(item.path, WARNING_REL, `URL 写法 ${asUrl} 应该落到同一条`);
    assert.equal(item.truncated, false);
    assertThresholds(item.content, `用 ${asUrl} 读到的 content`);
  }
});

test('点名读一篇：只有 url（filters.url）没给 q，也回正文 —— 模型只攥着出处时的兜底', async () => {
  const knowledge = await realService();
  const commands = createKnowledgeCommands({ knowledge });
  // 模型手里最牢的就是它刚引用过的那个 url；这条路径以前只拿到 240 字片段
  const result = commands.query({ filters: { url: WARNING_URL } });
  assert.equal(result.count, 1);
  assertThresholds(result.items[0].content, 'filters.url 直读的 content');
  assert.match(result.explain, /读取/, 'explain 要说清这次给的是正文，而不是片段');

  // 用 path 覆盖同一篇时 explain 也要能自圆其说（模型据此知道这次读到了什么）
  const byPath = commands.query({ filters: { path: WARNING_REL, q: '预警' } });
  assert.match(byPath.explain, /已给全|已截断/);
});

/* ------------------------------------------------------------------ 按关键词检索：维持原样 */

test('按关键词检索：只给片段，绝不把整篇（或整库）倒出来', async () => {
  const knowledge = await realService();
  const result = knowledge.search({ q: '学业预警' });
  assert.ok(result.count >= 1, '「学业预警」应该能查到东西');
  for (const item of result.items) {
    assert.equal(typeof item.snippet, 'string');
    assert.ok(item.snippet.length > 0 && item.snippet.length <= 900, `片段长度异常：${item.snippet.length}`);
    // 契约（§14.1/§14.4）：没点名哪一篇时，正文一个字都不出去
    assert.equal(item.content, undefined, '关键词检索不许返回正文');
    assert.equal(item.totalChars, undefined);
    assert.equal(item.truncated, undefined);
  }

  // 命中学业预警的那一篇在列表里也存在，只是**只有片段** —— 模型想读条款必须再点一次名
  const hit = result.items.find((item) => item.title.includes('学业预警与学籍处理'));
  assert.ok(hit, `命中列表里应该有那篇实施细则：${result.items.map((item) => item.title).join('、')}`);
  assert.ok(hit.path, '要给出可以再点名一次的 path');
  assert.ok(hit.url, '要给出可以再点名一次的 url');

  // 六条结果 × 800 字是刻意的上限口径（module.js 的 aiQueryLimits）：
  // 足够覆盖一条完整条款，又不会像整篇正文那样把对话挤掉。
  assert.ok(result.items.length <= 6);
});

/* ------------------------------------------------------------------ 截断要如实 */

test('超长文档：truncated / totalChars / content 长度三者自洽，且不假装给全了', async () => {
  const knowledge = await realService();
  const longest = knowledge.categories
    .flatMap((category) => category.items)
    .reduce((best, item) => (item.chars > best.chars ? item : best));
  assert.ok(longest.chars > 4000, `要有一篇超过 4000 字上限的样本，最长的是 ${longest.chars} 字`);

  const [item] = knowledge.search({ path: longest.path }).items;
  assert.equal(item.truncated, true, '超过上限必须如实标 truncated');
  assert.equal(item.content.length, 4000, `content 要给到上限：${item.content.length}`);
  assert.ok(item.totalChars > item.content.length, 'totalChars 是原文真实字数，必须大于给出的部分');

  // 与 read() 的口径一致（同一个正文来源，不该出现两个"总字数"）
  const doc = knowledge.read({ path: longest.path });
  assert.equal(doc.totalChars, item.totalChars, 'search 与 read 对同一篇的总字数必须一致');
  assert.equal(doc.content.startsWith(item.content.slice(0, 200)), true, '两者取的是同一段开头');

  // 显式放宽上限后应该给得更多（说明这个上限是参数，不是写死的幻觉）
  const [wider] = knowledge.search({ path: longest.path, pathMaxChars: 8000 }).items;
  assert.equal(wider.content.length, 8000);
  assert.equal(wider.totalChars, item.totalChars, '放宽上限不该改变"原文一共多少字"');
  assert.equal(wider.truncated, wider.totalChars > 8000);

  // 恰好不截断的一篇：truncated=false 时字段仍要自洽（别只在截断时才填）
  const [short] = knowledge.search({ path: WARNING_REL }).items;
  assert.equal(short.truncated, false);
  assert.equal(short.totalChars, short.content.length);
});

/* ------------------------------------------------------------------ 给模型的那一份（投影 + 提示词） */

test('回灌给模型的那一份：url 与 path 两种点名都要能看到阈值数字', async () => {
  const knowledge = await realService();
  const commands = createKnowledgeCommands({ knowledge });

  const byUrl = commands.query({
    filters: { url: WARNING_URL, q: '学业预警 学分' },
  });
  const byPath = commands.query({
    filters: { path: WARNING_REL, q: '学业预警 学分' },
  });
  for (const [label, result] of [['url', byUrl], ['path', byPath]]) {
    const [item] = result.items;
    // 只有这些字段能进模型的上下文（module.js 的 aiQueryFields 白名单）；
    // 少一个 `content`，模型就永远读不到条款 —— 这正是当初失败的原因之一
    for (const field of ['content', 'truncated', 'totalChars']) {
      assert.notEqual(item[field], undefined, `按 ${label} 点名时 items[0] 必须带 ${field}`);
    }
    assertThresholds(item.content, `${label} 点名后交给模型的内容`);
    // JSON 化之后数字还得在（真正进提示词的是序列化结果，不是对象）
    const serialized = JSON.stringify(result);
    for (const { pattern } of THRESHOLDS) {
      assert.match(serialized, pattern, `${label} 点名后的 JSON 里应该带上阈值`);
    }
    // 但整篇 JSON 不能因此膨胀成"把语料倒进去"：一篇 2169 字的正文 ≈ 一次正常读取
    assert.ok(serialized.length < 6000, `单篇点名不该把上下文撑爆：${serialized.length}`);
  }
});
