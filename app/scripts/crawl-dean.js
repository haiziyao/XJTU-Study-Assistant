#!/usr/bin/env node
/**
 * 教务处政策文本抓取器（零依赖，Node ≥ 20）。
 *
 * 为什么要有这个脚本，而不是"手动存一份网页"：
 *   - 政策文件会**修订**（转专业、保研、考试纪律都改过），语料必须能一条命令重刷；
 *   - 记忆 / 检索功能需要一个稳定的**索引**（标题、URL、日期、字符数、内容哈希），
 *     索引由本脚本生成，不靠人手维护（手维护的索引一定会飘）。
 *
 * 输出（`knowledge/dean/`，进仓库、协作者共用）：
 *   <栏目 slug>/<NN>-<标题>.md   —— 每篇一个文件，YAML front matter + 正文 Markdown
 *   index.json                   —— 全量索引：栏目 → 文档清单（含 sha256 与字符数）
 *   README.md                    —— 由人手维护，本脚本**不动它**
 *
 * 用法：
 *   node scripts/crawl-dean.js                # 抓全部栏目并重建索引（默认）
 *   node scripts/crawl-dean.js --only=xssw-xjgl,gzzd-jwgl   # 只抓指定栏目
 *   node scripts/crawl-dean.js --index-only   # 不联网，只按现有文件重建索引
 *   node scripts/crawl-dean.js --check        # 不联网，校验索引与文件一致（CI/自检用）
 *
 * 抓取礼仪：串行 + 每次请求间隔 400ms + 明确的 User-Agent；失败退避重试一次，仍失败就跳过
 * 并在索引里记 `error`（**不编内容**）。这不是爬虫，是一次性把公开政策存成本地语料。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'knowledge', 'dean');
const BASE = 'https://dean.xjtu.edu.cn/';
const UA = 'XJTU-study-assistant/0.2 (personal study tool; contact: local)';
const DELAY_MS = 400;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_LISTING_PAGES = 6;

/**
 * 要抓的栏目。顺序就是索引里的顺序（学生最关心的排前面）。
 *
 * 只收**政策 / 规章 / 办事依据**这类相对稳定的页面；「教学通知」「教学动态」这种
 * 时效性内容不收 —— 它们几天就过期，进了语料只会让模型答出过时的东西。
 * `kind: 'portal'` 的栏目（校历、作息时间、培养方案）常常只是跳转入口，
 * 抓下来如实记成"入口说明"，不假装里面有正文。
 */
const CATEGORIES = [
  { slug: 'xssw-xjgl', label: '学生事务 / 学籍管理', listing: 'xssw/xjgl.htm' },
  { slug: 'xssw-kcks', label: '学生事务 / 课程考试', listing: 'xssw/kcks.htm' },
  { slug: 'xssw-byxw', label: '学生事务 / 毕业学位', listing: 'xssw/byxw.htm' },
  { slug: 'xssw-jljh', label: '学生事务 / 交流交换', listing: 'xssw/jljh.htm' },
  { slug: 'xssw-zhyw', label: '学生事务 / 综合业务', listing: 'xssw/zhyw.htm' },
  { slug: 'gzzd-jwgl', label: '规章制度 / 教务管理', listing: 'gzzd/jwgl.htm' },
  { slug: 'gzzd-jxyj', label: '规章制度 / 教学研究', listing: 'gzzd/jxyj.htm' },
  { slug: 'gzzd-hzjl', label: '规章制度 / 合作交流', listing: 'gzzd/hzjl.htm' },
  { slug: 'gzzd-zhsw', label: '规章制度 / 综合事务', listing: 'gzzd/zhsw.htm' },
  { slug: 'jsjx-kcgl', label: '教学业务 / 课程管理', listing: 'jsjx/kcgl.htm' },
  { slug: 'jsjx-jwgl', label: '教学业务 / 教务管理', listing: 'jsjx/jwgl.htm' },
  { slug: 'jsjx-jxyw', label: '教学业务 / 教学业务', listing: 'jsjx/jxyw.htm' },
  { slug: 'jsjx-jxsb', label: '教学业务 / 奖项申报', listing: 'jsjx/jxsb.htm' },
  { slug: 'jsjx-zhsw', label: '教学业务 / 综合事务', listing: 'jsjx/zhsw.htm' },
  { slug: 'xxfw-xl', label: '信息服务 / 校历', listing: 'xxfw/xl.htm', kind: 'portal' },
  { slug: 'xxfw-zxsj', label: '信息服务 / 作息时间', listing: 'xxfw/zxsj.htm', kind: 'portal' },
  { slug: 'xxfw-qa', label: '信息服务 / Q&A', listing: 'xxfw/Q_A.htm', kind: 'portal' },
  { slug: 'jxxx-pyfa', label: '教学信息 / 培养方案', listing: 'jxxx/pyfa.htm', kind: 'portal' },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ 抓取 */

/** 取一个页面。SJTU 的门户有 utf-8 也有 gb18030 的老页面，两种都要认。 */
async function fetchText(url, { retry = 1 } = {}) {
  for (let attempt = 0; attempt <= retry; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      return decode(buffer);
    } catch (error) {
      if (attempt === retry) throw error;
      await sleep(1000);
    }
  }
  throw new Error('unreachable');
}

function decode(buffer) {
  const utf8 = buffer.toString('utf8');
  // 乱码检测：utf-8 解出来满屏替换符就说明它其实是 gb18030
  if ((utf8.match(/\uFFFD/g) ?? []).length > 3) {
    try {
      return new TextDecoder('gb18030').decode(buffer);
    } catch {
      return utf8;
    }
  }
  return utf8;
}

/* ------------------------------------------------------------------ 解析 */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–', middot: '·', times: '×',
};

const decodeEntities = (text) =>
  String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);

const stripTags = (html) => decodeEntities(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * 列表页里的文档链接，按出现顺序去重。
 *
 * 两种形态都要认（实测都有）：
 *   - `/info/<栏目>/<id>.htm`（绝大多数）；
 *   - `content.jsp?urltype=news.NewsContentUrl&wbtreeid=…&wbnewsid=…`（少数老条目，
 *     对应的 `/info/…` 地址是 **404**，只有 content.jsp 能打开）。
 * **只收本站链接**：Q&A 栏目里混着一半 `syxt.xjtu.edu.cn` 的站外入口，
 * 放进来会变成"抓了外站当政策"——那是明确不做的。
 */
function extractDocLinks(html, baseUrl = BASE, { keepExternal = false } = {}) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html))) {
    const href = match[1].trim();
    const isDoc = /info\/\d+\/\d+\.html?$/i.test(href) || /content\.jsp\?[^"']*wbnewsid=/i.test(href);
    if (!isDoc) continue;
    const title = stripTags(match[2]).replace(/^\[[^\]]{1,12}\]/, '').trim();
    if (!title) continue;
    let url;
    try {
      url = new URL(href, baseUrl);
    } catch {
      continue;
    }
    const sameSite = url.host.endsWith('dean.xjtu.edu.cn');
    if (!sameSite) {
      if (keepExternal) out.push({ title, url: url.href, external: true });
      continue;
    }
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    out.push({ title, url: url.href });
  }
  return out;
}

/** 分页：跟随页面里的分页链接（别按序号猜 —— 实测 jwgl 的尾页是 `jwgl/1.htm`、下页是 `jwgl/2.htm`）。 */
function paginationUrls(html, listingUrl) {
  const urls = [];
  const blocks = [...String(html).matchAll(/<(div|ul|p)[^>]+class="[^"]*(pagination|page|fanye|turnpage)[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi)];
  const scope = blocks.length ? blocks.map((block) => block[3]).join('\n') : '';
  const source = scope || html;
  for (const [, href] of source.matchAll(/<a[^>]+href="([^"]+)"[^>]*>/gi)) {
    if (!/\/\d+\.html?$/i.test(href)) continue;
    try {
      const url = new URL(href, listingUrl).href;
      if (url !== listingUrl && !urls.includes(url)) urls.push(url);
    } catch {
      /* ignore */
    }
  }
  return urls.slice(0, MAX_LISTING_PAGES);
}

/**
 * 附件链接：**不在**正文容器里（实测挂在 `div_vote_id` 之后的独立 `<ul>`）。
 * 只抓正文会丢掉整份政策（不少页面正文只有一句"具体见附件"）。
 */
function extractAttachments(html, baseUrl) {
  const out = [];
  const seen = new Set();
  for (const [, href, label] of String(html).matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    if (!/download\.jsp|wbfileid=|\.(pdf|docx?|xlsx?|zip|rar)$/i.test(href)) continue;
    let url;
    try {
      url = new URL(href, baseUrl).href;
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    const name = stripTags(label) || url.split('/').pop();
    out.push({ name, url });
  }
  return out;
}

/**
 * 取正文容器。
 *
 * 学校门户的正文在 `<div class="v_news_content">`（外层 `#vsb_content`），
 * Node 里没有 DOM，所以按 `<div` / `</div>` 配平扫出这一段的完整内容；
 * 找不到就退回 `#vsb_content`，再找不到就整页去掉 script/style（宁可多点导航文字，也别空手）。
 */
function extractContent(html) {
  const start = html.search(/<div[^>]+class="[^"]*v_news_content[^"]*"[^>]*>/i);
  if (start >= 0) {
    const inner = sliceBalancedDiv(html, start);
    if (inner) return inner;
  }
  const fallback = html.search(/<div[^>]+id="vsb_content"[^>]*>/i);
  if (fallback >= 0) {
    const inner = sliceBalancedDiv(html, fallback);
    if (inner) return inner;
  }
  return html;
}

function sliceBalancedDiv(html, startIndex) {
  const open = html.indexOf('>', startIndex);
  if (open < 0) return '';
  let depth = 1;
  let i = open + 1;
  while (i < html.length && depth > 0) {
    const nextOpen = html.indexOf('<div', i);
    const nextClose = html.indexOf('</div', i);
    if (nextClose < 0) break;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1;
      i = nextOpen + 4;
    } else {
      depth -= 1;
      i = nextClose + 5;
    }
  }
  return html.slice(open + 1, Math.max(open + 1, i - 5));
}

/** 正文 HTML → Markdown（够用就好：标题 / 段落 / 列表 / 表格 / 链接 / 粗体）。 */
function htmlToMarkdown(html, baseUrl) {
  let text = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');

  // 表格先单独处理成 Markdown 表格
  text = text.replace(/<table[\s\S]*?<\/table>/gi, (table) => `${tableToMarkdown(table)}`);

  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|h[1-6]|tr|li|blockquote)>/gi, '\n\n')
    .replace(/<(h[1-6])[^>]*>/gi, (_, tag) => `\n\n${'#'.repeat(Number(tag[1]) + 1)} `)
    .replace(/<li[^>]*>/gi, '\n- ')
    // ⚠️ 这两条必须要求标签名后面是空白或 `>`：`<(em|i)[^>]*>` 会把 `<img>` 吃掉（整页图片变 `*`），
    // `<(strong|b)[^>]*>` 同理会把 `<body>` 变成 `**` —— 实测就是这么把校历抓成 `[*](图片地址)` 的。
    .replace(/<(strong|b)(?:\s[^>]*)?>/gi, '**')
    .replace(/<\/(strong|b)>/gi, '**')
    .replace(/<(em|i)(?:\s[^>]*)?>/gi, '*')
    .replace(/<\/(em|i)>/gi, '*')
    // 图片：政策页里不少正文**整页就是一张图**（流程图、校历），漏了 <img> 就等于抓了个空壳
    .replace(/<img[^>]*>/gi, (tag) => {
      const src = /src="([^"]+)"/i.exec(tag)?.[1];
      if (!src) return '';
      // 内联的 base64 图片（教务处有几篇是**扫描件**，一张图几十 KB）不写进语料：
      // 它对检索毫无价值（模型读不了），却会让语料凭空胖几十 KB。留一句如实说明，
      // 读者知道"这一篇的正文是扫描图，要看就去原文链接"。
      if (/^data:/i.test(src)) return '（正文是扫描图，请点原文链接查看）';
      const alt = stripTags(/alt="([^"]*)"/i.exec(tag)?.[1] ?? '') || '图片';
      try {
        return `![${alt}](${new URL(src, baseUrl).href})`;
      } catch {
        return '';
      }
    })
    // 链接：文字为空但里面裹着图片时（`<a href><img></a>`）保留成"点图看原图"
    .replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const name = stripTags(label);
      let url;
      try {
        url = new URL(href, baseUrl).href;
      } catch {
        return name;
      }
      if (!name) {
        const img = /!\[[^\]]*\]\(([^)]+)\)/.exec(label)?.[1];
        return img ? `[![图片](${img})](${url})` : '';
      }
      return `[${name}](${url})`;
    })
    .replace(/<[^>]+>/g, '');

  text = decodeEntities(text)
    // 空的 `<strong></strong>`（页面上真实存在）会留下孤零零的 `**`，清掉
    .replace(/\*\*\s*\*\*/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

/**
 * 表格 → Markdown。
 *
 * **必须处理 rowspan / colspan**：教务处的「作息时间表」首列是一个 `rowspan=21` 的竖排表名、
 * 季节列还有 `colspan=2`，按"每行单元格个数"直接拼会整体错位一列（实测过）。
 * 这里的做法是把合并单元格**展开**成矩形网格（被合并覆盖的位置填同一个值），
 * 再把"整列都一样的值"提成表格上方的说明 —— 既不丢信息，也不会让读者错行。
 */
function tableToMarkdown(table) {
  const grid = [];
  const spans = []; // 还在生效的 rowspan：{ col, value, left }
  for (const row of String(table).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t([hd])([^>]*)>([\s\S]*?)<\/t\1>/gi)].map((cell) => {
      const attrs = cell[2] ?? '';
      const span = (name) => Number(new RegExp(`${name}\\s*=\\s*"?\\s*(\\d+)`, 'i').exec(attrs)?.[1] ?? 1);
      return {
        value: stripTags(cell[3]).replace(/\|/g, '\\|'),
        colspan: Math.max(1, span('colspan')),
        rowspan: Math.max(1, span('rowspan')),
      };
    });
    if (!cells.length) continue;
    const line = [];
    let col = 0;
    const pushSpans = () => {
      for (const item of spans) {
        if (item.left <= 0) continue;
        while (line[col] !== undefined) col += 1;
        line[col] = item.value;
        item.left -= 1;
        col += 1;
      }
    };
    pushSpans();
    for (const cell of cells) {
      while (line[col] !== undefined) col += 1;
      for (let i = 0; i < cell.colspan; i += 1) line[col + i] = cell.value;
      if (cell.rowspan > 1) spans.push({ col, value: cell.value, left: cell.rowspan - 1 });
      col += cell.colspan;
    }
    grid.push(line.map((value) => value ?? ''));
  }
  const rows = grid.filter((line) => line.some((cell) => cell !== ''));
  if (!rows.length) return '';

  // 整列取值相同 → 提到表格上方（否则 Markdown 表格里会是一列重复值，读者要横向找）
  const width = Math.max(...rows.map((line) => line.length));
  const notes = [];
  const keep = rows.map((line) => [...line, ...Array(width - line.length).fill('')]);
  for (let col = width - 1; col >= 0; col -= 1) {
    const values = keep.map((line) => line[col]);
    const first = values[0];
    if (first && values.every((value) => value === first) && keep[0].filter(Boolean).length > 2) {
      notes.unshift(`${first}（整列同值）`);
      for (const line of keep) line[col] = '';
    }
  }
  const trimmed = keep.map((line) => {
    const copy = [...line];
    while (copy.length && copy[copy.length - 1] === '') copy.pop();
    return copy;
  });
  const body = trimmed.filter((line) => line.some(Boolean));
  if (!body.length) return notes.length ? `\n\n${notes.join('；')}\n\n` : '';
  const size = Math.max(...body.map((line) => line.length));
  const render = (cells) => `| ${[...cells, ...Array(size - cells.length).fill('')].join(' | ')} |`;
  const head = render(body[0].length ? body[0] : Array(size).fill(''));
  const sep = `| ${Array(size).fill('---').join(' | ')} |`;
  return `\n\n${notes.length ? `${notes.join('；')}\n\n` : ''}${[head, sep, ...body.slice(1).map(render)].join('\n')}\n\n`;
}

/** 页面标题：优先 h1，其次 <title>（去掉「-西安交通大学教务处」这类后缀）。 */
function extractTitle(html, contentHtml) {
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(contentHtml)?.[1] ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  if (h1) {
    const text = stripTags(h1);
    if (text) return text;
  }
  const title = stripTags(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
  return title.replace(/[-—_|]\s*(西安交通大学)?教务处\s*$/, '').trim();
}

/** 发布时间：页面上通常写「发布时间：2025-04-14」。找不到就 null（**不编**）。 */
function extractPublishedAt(html) {
  const match =
    /发布时间[：:]\s*([0-9]{4})[-/年]([0-9]{1,2})[-/月]([0-9]{1,2})/.exec(html) ??
    /(?:时间|日期)[：:]\s*([0-9]{4})[-/年]([0-9]{1,2})[-/月]([0-9]{1,2})/.exec(html);
  if (!match) return null;
  const [, year, month, day] = match;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ 落盘 */

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

/** 文件名：去掉路径非法字符，压掉空白，限长（中文标题长起来很夸张）。 */
function safeName(title) {
  return String(title)
    .replace(/[\\/:*?"<>|\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, '');
}

const yamlValue = (value) =>
  value === null || value === undefined ? 'null' : `"${String(value).replace(/"/g, '\\"')}"`;

/**
 * 文件正文 = `# 标题` + 抓下来的正文。
 *
 * **索引里的 `chars` / `sha256` 就是按这个字符串算的**（不是只算 body）——
 * 之前两边口径不一致：索引算 body、校验算"front matter 之后的全部内容"（含那行 H1），
 * 于是 148 篇全部"对不上"。口径只留这一处定义。
 */
const docContent = ({ title, body }) => `# ${title}\n\n${body}`.trim();

function renderDoc({ title, url, label, slug, publishedAt, fetchedAt, body, kind }) {
  const front = [
    '---',
    `title: ${yamlValue(title)}`,
    `url: ${url ?? 'null'}`,
    `category: ${yamlValue(label)}`,
    `categorySlug: ${slug}`,
    `publishedAt: ${publishedAt ?? 'null'}`,
    `fetchedAt: ${fetchedAt}`,
    `source: dean.xjtu.edu.cn`,
    `kind: ${kind}`,
    '---',
  ].join('\n');
  return `${front}\n\n${docContent({ title, body })}\n`;
}

/** front matter 里的 fetchedAt（重抓时想保留原时间：内容没变就别制造 diff）。 */
function existingFetchedAt(file) {
  try {
    return /^fetchedAt:\s*(.+)$/m.exec(fs.readFileSync(file, 'utf8'))?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ 主流程 */

async function crawlCategory(category, now, previousByUrl = new Map()) {
  const listingUrl = new URL(category.listing, BASE).href;
  const items = [];
  const links = [];
  const externals = [];
  const errors = [];

  // 分页：**跟随页面上的分页链接**，不按序号猜 —— 实测 `gzzd/jwgl` 的「尾页」是 `jwgl/1.htm`、
  // 「下页」是 `jwgl/2.htm`（顺序是 1 → 2 → 1），照序号拼会 404 或死循环。
  const visited = new Set([listingUrl]);
  const queue = [listingUrl];
  let sawListing = false;
  while (queue.length && visited.size <= MAX_LISTING_PAGES) {
    const pageUrl = queue.shift();
    let html;
    try {
      html = await fetchText(pageUrl);
      if (pageUrl === listingUrl) sawListing = true;
    } catch (error) {
      errors.push({ url: pageUrl, error: error.message });
      continue;
    }
    let found = extractDocLinks(html, pageUrl, { keepExternal: true });
    const isFresh = (list) => list.some((link) => link.external || !links.some((item) => item.url === link.url));
    // CDN 有时对分页请求回第 1 页的内容（HTTP 200、不报错）→ 加时间戳穿透一次
    if (pageUrl !== listingUrl && !isFresh(found)) {
      try {
        const bust = `${pageUrl}${pageUrl.includes('?') ? '&' : '?'}_=${Date.now()}`;
        const retryHtml = await fetchText(bust);
        const retryFound = extractDocLinks(retryHtml, pageUrl, { keepExternal: true });
        if (isFresh(retryFound)) {
          found = retryFound;
          html = retryHtml;
        }
      } catch {
        /* 穿透失败就按原样处理 */
      }
    }
    for (const link of found) {
      if (link.external) {
        if (!externals.some((item) => item.url === link.url)) externals.push({ title: link.title, url: link.url });
        continue;
      }
      if (links.some((item) => item.url === link.url)) continue;
      links.push(link);
    }
    for (const next of paginationUrls(html, pageUrl)) {
      if (visited.has(next) || visited.size >= MAX_LISTING_PAGES) continue;
      visited.add(next);
      queue.push(next);
    }
    await sleep(DELAY_MS);
  }
  if (!sawListing && !links.length) {
    errors.push({ url: listingUrl, error: '列表页没抓到内容（网络或站点异常），本次跳过该栏目' });
    return { category, items, errors, listingUrl };
  }

  // 入口页（校历 / 作息时间）没有文章列表：把这一页本身当成一篇存下来
  if (!links.length) {
    try {
      const html = await fetchText(listingUrl);
      const content = extractContent(html);
      let body = htmlToMarkdown(content, listingUrl);
      const attachments = extractAttachments(html, listingUrl);
      body = `${body}${renderAttachments(body, attachments)}`;
      links.push({ title: extractTitle(html, content) || category.label, url: listingUrl, body, kind: 'portal' });
      await sleep(DELAY_MS);
    } catch (error) {
      errors.push({ url: listingUrl, error: error.message });
    }
  }

  const dir = path.join(OUT_DIR, category.slug);
  fs.mkdirSync(dir, { recursive: true });
  // 清掉上一次抓的、这次列表里已经没有的文件（政策下架了就别留在语料里）。
  // ⚠️ 只在**这次列表确实抓到了东西**时才清：列表页请求失败时 links 为空，
  // 这时候清等于"一次网络抖动删掉整个栏目"。
  // ⚠️ 这里**不能**先删目录里的 .md 再重写。以前这么干，导致 `writeDoc` 永远看到
  // "文件不存在"，于是每次重抓都把 148 篇全部重写一遍（`fetchedAt` 全变），
  // README 里承诺的"内容没变就不动文件、重抓不刷 diff"从来没生效过。
  // 正确做法：先写，再按"这次实际写了哪些文件"清理下架的（见函数末尾）。
  const written = new Set();

  const writeDoc = (name, { title, url, publishedAt, body, kind }) => {
    written.add(name);
    const file = path.join(dir, name);
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    const text = renderDoc({
      title,
      url,
      label: category.label,
      slug: category.slug,
      publishedAt,
      fetchedAt: now,
      body,
      kind,
    });
    const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const previousBody = previous?.split(/^---$/m).slice(2).join('---').trim() ?? null;
    if (previousBody === null || previousBody !== text.split(/^---$/m).slice(2).join('---').trim()) {
      fs.writeFileSync(file, text, 'utf8');
    }
    return { file, relative };
  };

  // 站外入口如实记一笔（Q&A 栏目有一半条目挂在 syxt.xjtu.edu.cn）：不抓正文，但要让人知道它在
  if (externals.length) {
    const body = [
      `本栏目的 ${externals.length} 条目挂在**站外系统**上，本语料只收 dean.xjtu.edu.cn，因此没有抓正文：`,
      '',
      ...externals.map((item) => `- [${item.title}](${item.url})`),
    ].join('\n');
    const { relative } = writeDoc('00-站外入口.md', {
      title: `${category.label}：站外入口清单`,
      url: listingUrl,
      publishedAt: null,
      body,
      kind: 'external-links',
    });
    const content = docContent({ title: `${category.label}：站外入口清单`, body });
    items.push({
      title: `${category.label}：站外入口清单`,
      url: listingUrl,
      path: relative,
      publishedAt: null,
      chars: content.length,
      sha256: sha256(content),
      kind: 'external-links',
    });
  }

  let index = 0;
  for (const link of links) {
    index += 1;
    const name = `${String(index).padStart(2, '0')}-${safeName(link.title)}.md`;
    let body = link.body;
    let publishedAt = null;
    let kind = link.kind ?? 'document';

    if (!body) {
      try {
        const html = await fetchText(link.url);
        const content = extractContent(html);
        body = htmlToMarkdown(content, link.url);
        publishedAt = extractPublishedAt(html);
        // 附件**不在**正文容器里（挂在 div_vote_id 之后），只抓容器会丢掉整份政策
        const attachments = extractAttachments(html, link.url);
        body = `${body}${renderAttachments(body, attachments)}`;
        // 正文薄到只剩"具体见附件"时，如实标成 attachments —— 检索时才知道这篇的正文在附件里
        if (attachments.length && body.replace(/\s/g, '').length < 160) kind = 'attachments';
        await sleep(DELAY_MS);
      } catch (error) {
        errors.push({ url: link.url, title: link.title, error: error.message });
        // 这次没抓到 ≠ 这篇没了：沿用上一次的索引条目（文件还在、哈希还对得上），
        // 只挂一条 error 说明"本轮没刷新成功"。否则一次网络抖动就会让索引缺一片，
        // 检索与 --check 都会跟着抖。
        const previous = previousByUrl.get(link.url);
        items.push(previous ? { ...previous, error: error.message } : {
          title: link.title,
          url: link.url,
          path: null,
          publishedAt: null,
          chars: 0,
          sha256: null,
          error: error.message,
        });
        continue;
      }
    }

    const { relative } = writeDoc(name, { title: link.title, url: link.url, publishedAt, body, kind });
    const content = docContent({ title: link.title, body });
    items.push({
      title: link.title,
      url: link.url,
      path: relative,
      publishedAt,
      chars: content.length,
      sha256: sha256(content),
      ...(kind !== 'document' ? { kind } : {}),
    });
  }

  // 政策**下架**了才删文件 —— 判据必须是"这次列表页里还有没有这个 URL"，而**不是**
  // "这次有没有抓成功"。两者差别很大：站点限流时 `fetch failed` 会让一大批篇目抓不到，
  // 按后者清就会把语料删掉一半（实测发生过：148 篇掉到 91 篇）。
  // 只有列表页确实抓到了、且它不再列这个 URL，才认定是下架。
  if (links.length) {
    const liveUrls = new Set([...links.map((link) => link.url), listingUrl]);
    for (const old of fs.readdirSync(dir)) {
      if (!old.endsWith('.md')) continue;
      const file = path.join(dir, old);
      if (written.has(old)) continue;
      const url = /^url:\s*"?([^"\n]+)"?/m.exec(fs.readFileSync(file, 'utf8'))?.[1]?.trim() ?? '';
      if (!url || !liveUrls.has(url)) fs.rmSync(file, { force: true });
    }
  }

  return { category, items, errors, listingUrl };
}

/** 附件清单：正文里已经出现过（同一 URL）就不重复列。 */
function renderAttachments(body, attachments) {
  if (!attachments.length) return '';
  const fresh = attachments.filter((item) => !body.includes(item.url));
  if (!fresh.length) return '';
  return `\n\n## 附件\n\n${fresh.map((item) => `- [${item.name}](${item.url})`).join('\n')}\n`;
}

function buildIndex(results, now) {
  const categories = results.map((result) => ({
    slug: result.category.slug,
    label: result.category.label,
    listingUrl: result.listingUrl,
    count: result.items.filter((item) => item.path).length,
    items: result.items,
    ...(result.errors.length ? { errors: result.errors } : {}),
  }));
  const documents = categories.reduce((sum, item) => sum + item.count, 0);
  const chars = categories.reduce(
    (sum, item) => sum + item.items.reduce((inner, doc) => inner + (doc.chars ?? 0), 0),
    0,
  );
  return {
    source: 'dean.xjtu.edu.cn',
    generator: 'scripts/crawl-dean.js',
    generatedAt: now,
    counts: { categories: categories.length, documents, chars },
    categories,
  };
}

/** 不联网：按磁盘上现有的 Markdown 重建索引（改了正文 / 手删了文件时用）。 */
function indexFromDisk(now) {
  const results = CATEGORIES.map((category) => {
    const dir = path.join(OUT_DIR, category.slug);
    const items = [];
    if (fs.existsSync(dir)) {
      for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort()) {
        const raw = fs.readFileSync(path.join(dir, file), 'utf8');
        const front = /^---\n([\s\S]*?)\n---\n/.exec(raw)?.[1] ?? '';
        const pick = (key) => new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(front)?.[1]?.replace(/^"|"$/g, '') ?? null;
        const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
        items.push({
          title: pick('title') ?? file.replace(/\.md$/, ''),
          url: pick('url') === 'null' ? null : pick('url'),
          path: path.relative(ROOT, path.join(dir, file)).split(path.sep).join('/'),
          publishedAt: pick('publishedAt') === 'null' ? null : pick('publishedAt'),
          chars: body.length,
          sha256: sha256(body),
          ...(pick('kind') && pick('kind') !== 'document' ? { kind: pick('kind') } : {}),
        });
      }
    }
    return { category, items, errors: [], listingUrl: new URL(category.listing, BASE).href };
  });
  return buildIndex(results, now);
}

/** 校验：索引里的每一项在磁盘上都存在且哈希一致。 */
function check(index) {
  const problems = [];
  for (const category of index.categories) {
    for (const item of category.items) {
      if (!item.path) {
        problems.push(`索引里有一条没有文件：${item.title ?? item.url}（${item.error ?? '未知原因'}）`);
        continue;
      }
      const file = path.join(ROOT, item.path);
      if (!fs.existsSync(file)) {
        problems.push(`文件不存在：${item.path}`);
        continue;
      }
      const body = fs.readFileSync(file, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
      if (sha256(body) !== item.sha256) problems.push(`内容与索引不一致：${item.path}`);
    }
  }
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  // 调试：`--url=<页面>` 只抓这一页并把转换后的 Markdown 打到终端（排查"某篇抓歪了"）
  const debugUrl = args.find((arg) => arg.startsWith('--url='))?.slice('--url='.length);
  if (debugUrl) {
    const html = await fetchText(debugUrl);
    const content = extractContent(html);
    console.log(`标题：${extractTitle(html, content)}`);
    console.log(`发布时间：${extractPublishedAt(html)}`);
    console.log(`附件：${JSON.stringify(extractAttachments(html, debugUrl), null, 2)}`);
    if (args.includes('--raw')) {
      console.log('--- 容器原文（前 1200 字）---');
      console.log(content.slice(0, 1200));
      return;
    }
    console.log('--- 正文 ---');
    console.log(htmlToMarkdown(content, debugUrl).slice(0, 4000));
    return;
  }
  const only = args.find((arg) => arg.startsWith('--only='))?.slice('--only='.length).split(',').filter(Boolean);
  const indexOnly = args.includes('--index-only');
  const now = new Date().toISOString();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let index;
  if (indexOnly) {
    index = indexFromDisk(now);
    console.log(`[dean] 只重建索引：${index.counts.documents} 篇 / ${index.counts.chars} 字符`);
  } else {
    const chosen = only?.length ? CATEGORIES.filter((item) => only.includes(item.slug)) : CATEGORIES;
    if (!chosen.length) {
      console.error(`--only 没匹配到任何栏目，可选：${CATEGORIES.map((item) => item.slug).join(', ')}`);
      process.exit(1);
    }
    const previousIndex = fs.existsSync(path.join(OUT_DIR, 'index.json'))
      ? JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'index.json'), 'utf8'))
      : null;
    const previousByUrl = new Map(
      (previousIndex?.categories ?? []).flatMap((item) => item.items ?? []).filter((item) => item.url).map((item) => [item.url, item]),
    );
    const results = [];
    for (const category of chosen) {
      const result = await crawlCategory(category, now, previousByUrl);
      results.push(result);
      const ok = result.items.filter((item) => item.path).length;
      console.log(`[dean] ${category.slug.padEnd(12)} ${String(ok).padStart(2)} 篇${result.errors.length ? `（失败 ${result.errors.length}）` : ''}`);
    }
    // 只抓了一部分栏目时，其余栏目沿用索引里已有的清单，避免把索引写残
    if (only?.length && fs.existsSync(path.join(OUT_DIR, 'index.json'))) {
      const previous = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'index.json'), 'utf8'));
      for (const old of previous.categories ?? []) {
        if (results.some((item) => item.category.slug === old.slug)) continue;
        const category = CATEGORIES.find((item) => item.slug === old.slug);
        if (category) results.push({ category, items: old.items, errors: old.errors ?? [], listingUrl: old.listingUrl });
      }
      results.sort((a, b) => CATEGORIES.findIndex((c) => c.slug === a.category.slug) - CATEGORIES.findIndex((c) => c.slug === b.category.slug));
    }
    index = buildIndex(results, now);
  }

  const indexFile = path.join(OUT_DIR, 'index.json');
  // 索引也保持幂等：这次的内容与上一次完全一致时，沿用旧的 generatedAt ——
  // 否则"什么都没变"的重抓也会在 git 里留下一行 diff（generatedAt 是给人判断语料新不新的，
  // 不该因为一次空跑就谎报"刚生成过"）。
  if (!indexOnly && fs.existsSync(indexFile)) {
    try {
      const previous = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      const strip = (value) => JSON.stringify({ ...value, generatedAt: null });
      if (strip(previous) === strip(index)) index.generatedAt = previous.generatedAt;
    } catch {
      /* 旧索引坏了就当没有，正常写新的 */
    }
  }
  if (args.includes('--check')) {
    if (!fs.existsSync(indexFile)) {
      console.error('[dean] 没有 index.json，先跑一次 node scripts/crawl-dean.js');
      process.exit(1);
    }
    const problems = check(JSON.parse(fs.readFileSync(indexFile, 'utf8')));
    if (problems.length) {
      console.error(`[dean] 索引与文件不一致（${problems.length} 处）：`);
      for (const line of problems.slice(0, 20)) console.error(`  - ${line}`);
      process.exit(1);
    }
    console.log('[dean] 索引与文件一致 ✓');
    return;
  }

  fs.writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  console.log(
    `[dean] 索引已写入 knowledge/dean/index.json：${index.counts.categories} 个栏目 / ` +
      `${index.counts.documents} 篇 / 约 ${(index.counts.chars / 10000).toFixed(1)} 万字`,
  );
}

main().catch((error) => {
  console.error('[dean] 抓取失败：', error);
  process.exit(1);
});
