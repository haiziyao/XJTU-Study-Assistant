/**
 * 语料自检：`knowledge/dean/` 是**进仓库**的政策文本语料，必须和索引对得上。
 *
 * 为什么值得一条测试：语料是手工/脚本混合维护的 —— 有人手改一段正文、删一个文件、
 * 或者抓了一半就中断，索引就会飘。飘了的索引比没有索引更坏：检索会指向不存在或过期的内容。
 * 这里只做**结构与一致性**校验（不联网、不比对教务处官网）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'knowledge', 'dean');
const INDEX_FILE = path.join(DIR, 'index.json');

const readIndex = () => JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
// 剥 front matter 必须认 `\r?\n`：只写 `\n` 的话 CRLF 文件根本剥不掉，
// 正文里混进 front matter，哈希必然不对（Windows 检出下整库会"对不上"）。
const bodyOf = (file) =>
  fs.readFileSync(file, 'utf8')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .trim();
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

/**
 * 索引里的哈希是否与正文对得上（容忍两种换行）。
 *
 * 索引的 `sha256` 是按**仓库里的内容**算的，而 `core.autocrlf=true` 的检出会把一部分
 * 文件的 LF 变成 CRLF —— 同一份语料在两台机器上哈希不同。实测：原样匹配 65 条、
 * 归一成 LF 后匹配 83 条，`65 + 83 = 148` 恰好互补（仓库里本来就有一部分是混合换行）。
 * 取其一即通过；**真被改过内容的文件两种都对不上**，判据没有被放宽。
 */
const hashMatches = (body, expected) =>
  sha256(body) === expected || sha256(body.replace(/\r\n/g, '\n')) === expected;

test('教务处语料：index.json 存在且结构完整', () => {
  assert.ok(fs.existsSync(INDEX_FILE), 'knowledge/dean/index.json 应该存在（node scripts/crawl-dean.js）');
  const index = readIndex();
  assert.equal(index.source, 'dean.xjtu.edu.cn');
  assert.equal(index.generator, 'scripts/crawl-dean.js');
  assert.ok(Array.isArray(index.categories) && index.categories.length >= 10, '栏目数量应该像样');
  assert.ok(index.counts?.documents >= 20, `语料太少（${index.counts?.documents} 篇），确认抓取是否完整`);
  for (const category of index.categories) {
    assert.match(category.slug, /^[a-z0-9-]+$/, `栏目 slug 应该是 ASCII：${category.slug}`);
    assert.ok(category.listingUrl?.startsWith('https://dean.xjtu.edu.cn/'), '栏目要有官网来源');
    assert.ok(Array.isArray(category.items), `${category.slug} 的 items 应该是数组`);
  }
});

test('教务处语料：索引里的每一篇都对得上磁盘上的文件', () => {
  const index = readIndex();
  const problems = [];
  let checked = 0;
  for (const category of index.categories) {
    for (const item of category.items) {
      if (!item.path) continue; // 抓取失败的那种，索引里如实记了 error
      const file = path.join(ROOT, item.path);
      if (!fs.existsSync(file)) {
        problems.push(`文件不存在：${item.path}`);
        continue;
      }
      checked += 1;
      const body = bodyOf(file);
      if (!hashMatches(body, item.sha256)) problems.push(`内容与索引不一致：${item.path}`);
      // 字符数同样要容忍两种换行：`chars` 是按**仓库里的内容**算的，
      // 而 CRLF 检出会让正文每行多一个 `\r`。两种长度命中其一即可（与哈希同一口径）。
      const charsOk = body.length === item.chars || body.replace(/\r\n/g, '\n').length === item.chars;
      if (!charsOk) problems.push(`字符数与索引不一致：${item.path}`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
  assert.ok(checked >= 20, `实际校验到的篇数太少：${checked}`);
});

test('教务处语料：每篇都有 YAML 头，且标了来源 URL', () => {
  const index = readIndex();
  const files = index.categories.flatMap((category) => category.items.filter((item) => item.path).map((item) => item.path));
  for (const relative of files.slice(0, 200)) {
    // 先把 CRLF 归一成 LF 再断言：YAML 头是抓取器按 `\n` 写的，
    // 直接拿 CRLF 原文去匹配 `/^---\n/` 会整库报"缺少 front matter"。
    const raw = fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
    assert.match(raw, /^---\n/, `${relative} 缺少 front matter`);
    assert.match(raw, /\ntitle: /, `${relative} 缺少 title`);
    assert.match(raw, /\ncategorySlug: /, `${relative} 缺少 categorySlug`);
    assert.match(raw, /\nsource: dean\.xjtu\.edu\.cn/, `${relative} 缺少来源标注`);
    // 政策类文档必须有可点回的原始 URL（回答里要带出处）
    assert.match(raw, /\nurl: "?https:\/\/dean\.xjtu\.edu\.cn\//, `${relative} 缺少原始 URL`);
  }
});

test('教务处语料：没有把非政策栏目（通知/动态）误抓进来', () => {
  const index = readIndex();
  const slugs = index.categories.map((item) => item.slug);
  for (const bad of ['jxxx-jxtz2', 'jxxx-jxdt', 'jxxx-jxal']) {
    assert.ok(!slugs.includes(bad), `${bad} 是时效性栏目，不该进语料`);
  }
});
