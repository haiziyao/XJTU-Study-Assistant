/**
 * 知识库服务：把 `knowledge/dean/` 的教务处政策语料读进内存，对外提供
 * 统计 / 检索 / 读单篇 / 重载 / 自检五个只读动作（接口文档 §14.3）。
 *
 * 几个刻意的取舍：
 *
 * 1. **语料在仓库里，不在 `data/`**（§14.2）。语料随代码一起走 git，是"程序搬运的外部事实"；
 *    用户数据才进 `data/`。所以目录用**模块自身位置**定位（而不是 cwd，也不是 dataDir）——
 *    从 Electron 主进程、测试、`bin/server.js` 启动时 cwd 各不相同，只有模块位置是稳定的。
 *    构造参数里的 `dataDir` 只是与其它模块保持一致的占位，这里用不到。
 *
 * 2. **坏索引不抛错，降级成空语料**（§14.3）。用户删过 `knowledge/`、抓取脚本跑了一半、
 *    索引里混进了非法 JSON —— 这些都不该让整个服务起不来。`available: false` + `reason`
 *    能让设置页说清"你还没跑抓取脚本"，比 500 有用得多。
 *
 * 3. **正文惰性加载**。索引（约 57KB）在 `restore()` 时读；148 篇正文（约 11.5 万字）
 *    等到第一次 `search()` 才读。启动路径上少一次全量磁盘 I/O，改语料也不必重启进程。
 *
 * 4. **只给片段**。`search()` 返回 `snippet` 而不是 `content`：命中片段才进提示词，
 *    整篇进提示词会把对话预算撑爆（§14.1）。要整篇得显式调 `read()`。
 *
 * 5. **长文必须能续读**（2026-10 真机缺陷）。`read()` 一次只给一个窗口，但窗口不是全文：
 *    返回 `offset` / `nextOffset` / `truncated` / `totalChars`，模型可以按 offset 继续读。
 *    这条不是"锦上添花"——《学籍管理与学位授予规定》正文 8213 字，回答"挂几科退学"的
 *    「第六章 退学警告与退学」从**第 4860 字**才开始，只给前 4000 字等于没给。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { HttpError } from '../../core/http/router.js';
import {
  buildSnippet,
  expandQuery,
  findFirstMatch,
  findSection,
  rawOffsetFor,
  searchDocuments,
  stripMarkdown,
} from './search.js';

/** 没有可检索正文的篇目类型（§14.2）：正文在图片 / 附件 / 站外入口里。 */
const NO_TEXT_KINDS = ['portal', 'attachments', 'external-links'];

/**
 * 语料目录：`src/modules/knowledge/` → 上三级是 `app/`，再进 `knowledge/dean`。
 * 允许用 `PC_KNOWLEDGE_DIR` 覆盖（测试指向临时目录；也让"语料放别处"不必改代码）。
 */
export const CORPUS_DIR = process.env.PC_KNOWLEDGE_DIR
  ? path.resolve(process.env.PC_KNOWLEDGE_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'knowledge', 'dean');

/** 索引文件名（唯一真源，别手改 —— 要改就跑 `node scripts/crawl-dean.js --index-only`）。 */
const INDEX_FILE = 'index.json';

/** `search()` 的条数上限：与路由 / 只读指令同口径（§14.5：默认 5、最大 10）。 */
const MAX_LIMIT = 10;
const DEFAULT_LIMIT = 5;

/**
 * `read()` 的默认窗口与硬上限。
 *
 * 默认 4000 而不是"整篇"：这是**一次续读窗口**的语义，配合 `offset` 就可以读完任意长文。
 * 为什么窗口不设成 8000：AI 对话里一次查询回灌的正文预算是按 4000 设计的，
 * 而真正解决长文问题的不是"窗口更大"，是"窗口能往后移"（offset）。
 * HTTP `/knowledge/doc` 保持既有 8000 字契约（见 `DEFAULT_DOC_MAX_CHARS`），
 * 它面向的是人在浏览器里读原文，不是对话上下文。
 */
const DEFAULT_MAX_CHARS = 4000;
const MAX_MAX_CHARS = 20000;

/**
 * `GET /knowledge/doc` 的默认窗口：沿用接口文档公开的 8000 字。
 *
 * 服务层默认值是给"一次性把一篇尽量给全"的调用方的；对话里的续读走 `search({ path })`
 * 或 `read({ offset })`，窗口 4000 + offset 反而更省上下文。两个默认值都是真实契约，
 * 由路由显式选一个，避免"服务层改了默认值，HTTP 文档悄悄过期"。
 */
export const DEFAULT_DOC_MAX_CHARS = 8000;

/**
 * `search()` 的默认片段长度。
 *
 * 从 240 调到 800：240 字只够"确认这篇讲这个"，不够读完一条完整条款。
 * 真机里「12 / 8 / 4 学分」的表格距离命中词 300 多字，240 字片段刚好停在表格前一行——
 * 模型看到片段却读不到数字，只能回去整篇 read（然后又被窗口截断）。
 * 800 字能覆盖绝大多数"一条 = 一段"的校规条款；6 条结果 × 800 ≈ 4.8k 字，
 * 仍在一次检索回灌的预算内（比整篇 8213 字小，且每条都带出处）。
 */
const DEFAULT_SNIPPET_CHARS = 800;

/**
 * `search({ path })`（"我点名要这一篇"）额外带回的**长正文**上限。
 *
 * 为什么按关键词检索时不能有它、点名时却必须有：
 *   - 按 `q` 检索是"我不知道是哪一篇，帮我找" —— 10 条 × 全文就等于把半个语料倒进提示词，
 *     这是 §14.1/§14.4 明令禁止的，所以那里**只给片段**，维持原样；
 *   - 带 `path` 是"**我就要这一篇**"（模型已经拿到 url/path，只是想读条款）—— 这时再只给 240/800 字
 *     片段就等于收了一次钱不给货：实测《学业预警与学籍处理实施细则》2169 字，
 *     12/8/4 三档阈值在**第 341 字**的表格里，240 字片段刚好停在"三级预警"前一行，
 *     模型只能老实说"这一页正文读到第三条就断了"。
 *
 * 4000 的来历：约等于 2 页 A4 的政策正文，够覆盖绝大多数细则的条款主体；
 * 再长就走 `truncated` + `totalChars` + `nextOffset` 如实告知并续读。
 */
const DEFAULT_PATH_MAX_CHARS = 4000;

/** 哈希口径与抓取器一致：sha256 十六进制的前 16 位（`scripts/crawl-dean.js` 的 `sha256()`）。 */
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

/**
 * 索引与文件的哈希口径是否一致。
 *
 * **为什么要容忍两种换行**：索引里的 `sha256` 是按**仓库里的内容**算的，
 * 而 Windows 检出（`core.autocrlf=true`）会把其中一部分文件的 LF 变成 CRLF ——
 * 同一份语料在两台机器上算出的哈希不同，自检就会在 Windows 上报 148 条"内容与索引不一致"，
 * 而语料其实一个字都没错。实测：原样匹配 65 条、归一成 LF 后匹配 83 条，`65 + 83 = 148`，
 * 两种口径恰好互补（仓库里本来就有一部分文件是混合换行）。
 *
 * 这**没有放宽判据**：真被改过内容的文件两种口径都对不上，仍然会报错。
 */
const matchesIndexHash = (body, expected) =>
  sha256(body) === expected || sha256(body.replace(/\r\n/g, '\n')) === expected;

/**
 * 正文口径：**front matter 之后的全部内容并 trim()**，包含那行 `# 标题`。
 *
 * 这一处定义是"索引与文件对不上"的历史教训（抓取器注释里写过）：索引算 body、
 * 校验算含 H1 的全文，于是 148 篇集体"对不上"。两边都只留这一个口径。
 */
const splitFrontMatter = (raw) => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  return { front: match?.[1] ?? '', body: (match ? raw.slice(match[0].length) : raw).trim() };
};

/** 取 front matter 里某个键的值（去掉包裹引号；`null` 视为没有）。 */
function frontValue(front, key) {
  const value = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(front)?.[1]?.trim();
  if (!value) return null;
  const unquoted = value.replace(/^"(.*)"$/, '$1');
  return unquoted === 'null' ? null : unquoted;
}

/** 正文开头的 `# 标题`（写文件时由抓取器加的）：读全文时去掉，避免与 `title` 字段重复一遍。 */
const stripLeadingHeading = (body) => body.replace(/^\s*#\s+.*(\r?\n)+/, '').trim();

/**
 * 路径比较键：统一分隔符、统一 Unicode 形式。
 *
 * 为什么要 normalize：macOS 的 HFS+/APFS 在**查找**路径时忽略 NFD/NFC 差异，
 * 但 `readdir()` 返回的名字可能是 NFD，而 `index.json` 里是 NFC（脚本生成时的形式）。
 * 直接 `===` 比较会莫名其妙地不相等，拼出来的路径甚至 `existsSync` 为 false。
 */
const pathKey = (value) =>
  String(value ?? '')
    .split('\\')
    .join('/')
    .replace(/^\.\//, '')
    .normalize('NFC');

/**
 * 索引 / 调用方给的 `path` → **相对语料根**的文件名。
 *
 * 又一种"两种写法"的收敛：索引里存的是**仓库相对**路径
 * （`knowledge/dean/gzzd-jwgl/a.md`，抓取器 `path.relative(ROOT, …)` 的产物），
 * 而文件在 `<corpusDir>/gzzd-jwgl/a.md`。不收敛的后果是拼出
 * `<corpusDir>/knowledge/dean/…` —— 文件明明在，全文却静默读空（曾经真的这样过）。
 */
function corpusRelative(value) {
  const key = pathKey(value);
  const marker = `${path.basename(CORPUS_DIR)}/`;
  // 只认"…/knowledge/dean/xxx"或"knowledge/dean/xxx"这种**带上级目录**的前缀，
  // 不能见到 `dean/` 就切：语料根自己的名字恰好叫 dean 时会把相对路径切坏
  const at = key.lastIndexOf(`/${marker}`);
  if (at >= 0 && key.slice(0, at).endsWith('knowledge')) return key.slice(at + marker.length + 1);
  if (key.startsWith(`knowledge/${marker}`)) return key.slice(`knowledge/${marker}`.length);
  return key;
}
/** `kind` 归一：索引里缺省就是普通文章；未知值一律当 document（别把脏数据当"没有正文"）。 */
const normalizeKind = (kind) =>
  ['document', ...NO_TEXT_KINDS].includes(kind) ? kind : 'document';

/** 一条索引项先归一成内部结构，后续所有出口都从这里长出来，避免各处 `??` 满天飞。 */
function normalizeItem(item, category) {
  return {
    title: String(item?.title ?? '').trim() || '（无标题）',
    url: typeof item?.url === 'string' && item.url.trim() ? item.url.trim() : null,
    path: typeof item?.path === 'string' ? item.path.trim() : '',
    publishedAt: typeof item?.publishedAt === 'string' ? item.publishedAt : null,
    kind: normalizeKind(item?.kind),
    chars: Number(item?.chars) || 0,
    sha256: typeof item?.sha256 === 'string' ? item.sha256 : null,
    category: category.label,
    categorySlug: category.slug,
  };
}

/**
 * 归一化索引。**宽松解析**：栏目/篇目形状不对就丢掉那一条，而不是让整个语料不可用 ——
 * 索引是脚本产出的，单条脏数据不该让 147 篇好文章一起消失（`check()` 会把问题报出来）。
 */
function normalizeIndex(raw) {
  const categories = [];
  for (const entry of Array.isArray(raw?.categories) ? raw.categories : []) {
    const slug = typeof entry?.slug === 'string' ? entry.slug.trim() : '';
    if (!slug) continue;
    const label = String(entry?.label ?? slug).trim() || slug;
    const items = [];
    for (const item of Array.isArray(entry?.items) ? entry.items : []) {
      // 没有 path 的条目（抓取失败）留在这里只为 count，读不了也检索不了
      items.push(normalizeItem(item, { slug, label }));
    }
    categories.push({ slug, label, listingUrl: entry?.listingUrl ?? null, items });
  }
  return categories;
}

export class KnowledgeService {
  /**
   * @param {{ log?: Function, dataDir?: string, corpusDir?: string }} [options]
   *        `dataDir` 是模块装配惯例的占位（语料不在 data/ 下）；`corpusDir` 一般不用，
   *        测试要临时语料请优先用 `PC_KNOWLEDGE_DIR`（模块级常量在 import 时定下）。
   */
  constructor({ log, dataDir, corpusDir } = {}) {
    this.log = typeof log === 'function' ? log : () => {};
    this.dataDir = dataDir ?? null;
    this.corpusDir = path.resolve(corpusDir ?? CORPUS_DIR);
    this.indexFile = path.join(this.corpusDir, INDEX_FILE);

    /** @type {Array<{slug:string,label:string,items:Array<object>}>} 归一化后的栏目 */
    this.categories = [];
    /** 索引原文里的 source / generatedAt（stats 直接照抄，不臆造） */
    this.source = null;
    this.generatedAt = null;
    /** 语料是否可用：false 时其余接口按"空语料"工作，不抛错 */
    this.available = false;
    this.reason = '尚未加载语料';
    /** path → 正文（惰性） */
    this.texts = new Map();
    this.loaded = false;
  }

  /* ---------------------------------------------------------------- 加载 */

  /**
   * 读 `index.json`。失败（文件缺失 / 不是 JSON / 形状不对）**不抛**：
   * 记 `available: false` + `reason`，其余接口按空语料工作（§14.3）。
   */
  async restore() {
    this.categories = [];
    this.source = null;
    this.generatedAt = null;
    this.texts.clear();
    this.loaded = false;

    let raw;
    try {
      raw = fs.readFileSync(this.indexFile, 'utf8');
    } catch (error) {
      this.available = false;
      this.reason = `没有找到语料索引 ${this.indexFile}（先跑 node scripts/crawl-dean.js）：${error.code ?? error.message}`;
      this.log('warn', `[knowledge] ${this.reason}`);
      return this.stats();
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // 坏 JSON 是最常见的"抓取脚本跑了一半"的痕迹：如实说原因，别假装语料是空的
      this.available = false;
      this.reason = `语料索引不是合法 JSON（${this.indexFile}）：${error.message}`;
      this.log('warn', `[knowledge] ${this.reason}`);
      return this.stats();
    }

    const categories = normalizeIndex(parsed);
    const documents = categories.reduce((sum, category) => sum + category.items.length, 0);
    if (!documents) {
      this.available = false;
      this.reason = `语料索引里没有任何篇目（${this.indexFile}）`;
      this.log('warn', `[knowledge] ${this.reason}`);
      return this.stats();
    }

    this.categories = categories;
    this.source = typeof parsed.source === 'string' ? parsed.source : null;
    this.generatedAt = typeof parsed.generatedAt === 'string' ? parsed.generatedAt : null;
    this.available = true;
    this.reason = null;
    this.log('info', `[knowledge] 语料就绪：${categories.length} 个栏目 / ${documents} 篇（${this.corpusDir}）`);
    return this.stats();
  }

  /** 重新读 `index.json`（跑完抓取脚本后用它，不必重启进程），返回新的 stats()。 */
  async reload() {
    return this.restore();
  }

  /* ---------------------------------------------------------------- 统计 */

  /** 语料概览。语料缺失时也返回（`available: false` + `reason`），而不是抛错。 */
  stats() {
    const counts = {
      categories: this.categories.length,
      documents: 0,
      chars: 0,
    };
    const categories = this.categories.map((category) => {
      const chars = category.items.reduce((sum, item) => sum + (item.chars || 0), 0);
      counts.documents += category.items.length;
      counts.chars += chars;
      // kinds：只在栏目里混了"没有正文"的篇目时才给，纯 document 的栏目不必背这个字段
      const kinds = {};
      for (const item of category.items) kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;
      const mixed = Object.keys(kinds).length > 1;
      return {
        slug: category.slug,
        label: category.label,
        count: category.items.length,
        chars,
        ...(mixed ? { kinds } : {}),
      };
    });

    return {
      available: this.available,
      ...(this.available ? {} : { reason: this.reason ?? '语料不可用' }),
      source: this.source,
      generatedAt: this.generatedAt,
      corpusDir: this.corpusDir,
      counts,
      categories,
    };
  }

  /* ---------------------------------------------------------------- 正文 */

  /**
   * 惰性把所有正文读进内存。
   *
   * 148 篇 / 11.5 万字，全量驻留是"暴力匹配够快"的前提（§14.4）。读不到的文件
   * （被删了、路径飘了）记成空串：检索时它只能靠标题命中，`check()` 会把不一致报出来。
   */
  #ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    for (const category of this.categories) {
      for (const item of category.items) {
        if (!item.path) continue;
        // 走 `#findOnDisk` 而不是直接拼路径：索引里的 path 可能是仓库相对写法，
        // 文件名还可能因为 macOS 的 NFC/NFD 差异对不上（见该方法注释）
        const file = this.#findOnDisk(item.path);
        if (!file) {
          // 读不到就留空串：检索时它只能靠标题命中，`check()` 会把"文件不存在"报出来
          item.text = '';
          item.rawText = '';
          continue;
        }
        const raw = fs.readFileSync(file, 'utf8');
        // 正文先去掉那行 `# 标题`：它已经作为 `title` 参与打分（还带 ×8 权重），
        // 留在正文里会被算第二遍。`rawText` 保留**原文**（含表格/粗体），
        // 它是 `read()` 的切片口径，也是 `offset` 的坐标系；`text` 是清洗后给片段与打分的。
        item.rawText = stripLeadingHeading(splitFrontMatter(raw).body);
        // 清洗则挡掉 `](http://…)` 这类语法白送命中（比如查 jpg 竟然能搜到一片校历页）
        item.text = stripMarkdown(item.rawText);
      }
    }
  }

  /**
   * 找出 `path` 对应的篇目；同时完成**路径安全判定**。
   *
   * 安全逻辑放在这里（服务层是唯一知道语料根目录的地方），规则两条：
   *   1. 索引里有的 `path` 一定先命中 —— 这是绝大多数调用（模型拿 `search()` 的 path 回来读全文）；
   *   2. 索引里没有时，才回落到"文件系统解析 + 必须落在语料目录内"，这样重抓过语料、
   *      索引还没 reload 时也能读。`..`、绝对路径、站外相对路径都会在这条上被挡掉（§14.3）。
   *
   * @returns {{ item?: object, absPath?: string, outside?: boolean }}
   */
  #resolve(requestedPath) {
    const value = String(requestedPath ?? '').trim();
    if (!value) throw HttpError.badRequest('字段 path 必填', { field: 'path' });

    const wanted = corpusRelative(value);
    const indexed = this.#allItems().find((item) => corpusRelative(item.path) === wanted);
    // 命中的话以**索引里的 path** 为准：它才是这一篇的身份（返回给调用方的 path 也用它）
    if (indexed) return { item: indexed, absPath: this.#findOnDisk(indexed.path) };

    const resolved = path.resolve(this.corpusDir, wanted);
    const inside = resolved === this.corpusDir || resolved.startsWith(`${this.corpusDir}${path.sep}`);
    if (!inside) return { absPath: resolved, outside: true };
    return { absPath: this.#findOnDisk(wanted) ?? resolved };
  }

  /** 索引里所有篇目（扁平化）。检索与路径查找都从这里取，避免各处再写一遍 flatMap。 */
  #allItems() {
    return this.categories.flatMap((category) => category.items);
  }

  /**
   * 磁盘上真正存在的那份文件。
   *
   * 先按原样试（99% 的情况一次 `existsSync` 就完了）；不行再**逐段扫描目录**、
   * 用 `pathKey` 归一后比较 —— 解决 macOS 上 NFC/NFD（或大小写）不一致导致的
   * "文件明明在，`readFileSync` 却说没有"。找不到返回 null。
   */
  #findOnDisk(relativePath) {
    const wanted = corpusRelative(relativePath);
    const direct = path.join(this.corpusDir, wanted);
    if (fs.existsSync(direct)) return direct;
    const segments = wanted.split('/').filter(Boolean);
    let current = this.corpusDir;
    for (const segment of segments) {
      let names;
      try {
        names = fs.readdirSync(current);
      } catch {
        return null;
      }
      const found = names.find((name) => pathKey(name) === pathKey(segment));
      if (!found) return null;
      current = path.join(current, found);
    }
    return fs.existsSync(current) ? current : null;
  }

  /**
   * 读一篇（`content` 默认截前 4000 字，超出用 `truncated` 标出）。
   *
   * `offset` 是**续读入口**：从第 N 字开始切同一个窗口，返回 `nextOffset`。
   * 为什么必须支持它：政策正文的关键条款经常在 4000 字之后（真实语料里
   * 《学籍管理与学位授予规定》正文 8213 字，第六章从第 4860 字开始）。没有 offset 时，
   * 模型只能整篇 read，而整篇 read 永远只给开头 —— 它会如实说"我只能读到 4000 字"，
   * 用户的问题就答不出来。**不传 offset 时行为不变**（前 4000 字）。
   *
   * `content` 去掉开头那行 `# 标题`：`title` 已经单独返回了，正文里再来一遍是重复。
   * `path` 不在语料目录内 → 400（`HttpError.badRequest`），这是 §14.3 的硬要求。
   */
  read({ path: requestedPath, maxChars = DEFAULT_MAX_CHARS, offset = 0 } = {}) {
    /**
     * 允许把**来源 URL** 当 path 传进来。
     *
     * 为什么：检索结果里每条都同时带 `path`（语料相对路径）与 `url`（教务处原文链接），
     * 而模型最容易记住的是 URL —— 实测它就这样发过
     * `{"action":"query","target":"knowledge","filters":{"path":"https://dean.xjtu.edu.cn/info/1033/8963.htm"}}`，
     * 然后被 400 挡掉、这一轮白跑（更糟的是它上一句已经说了"我把原文调出来看"，用户只等到一句空话）。
     * 用户看到的"来源"就是 URL，那 URL 就该能用。
     */
    const asked = String(requestedPath ?? '').trim();
    // 索引在服务里就是 `this.categories`（`categories[].items[]`，每项有 title/url/path）；
    // 我第一版写成 `this.index.categories` 根本取不到，于是 URL 匹配静默失效 —— 探测才发现
    const docs = (this.categories ?? this.index?.categories ?? []).flatMap((category) => category.items ?? []);
    const byUrl = /^https?:\/\//i.test(asked) ? docs.find((doc) => doc.url === asked) : null;
    // 只给"网址的路径片段"也认（模型实测发过 `/info/1033/1130.htm`）——
    // 它对用户来说就是"这一篇的地址"，能对上就别让它白跑一轮
    const bySuffix = !byUrl && !/^https?:/i.test(asked) && asked.includes('/')
      ? docs.find((doc) => String(doc.url ?? '').endsWith(asked))
      : null;
    const effectivePath = byUrl?.path ?? bySuffix?.path ?? requestedPath;
    const { item, absPath, outside } = this.#resolve(effectivePath);
    if (outside) throw HttpError.badRequest(`path 不在语料目录内：${requestedPath}`, { field: 'path' });

    // 读**原文**（不清洗 Markdown）：`read()` 是"把这一篇给出来"，表格与列表结构
    // 对读条款有用；清洗只服务于检索与片段（见 search.js 的 stripMarkdown）。
    // `#resolve` 已经把仓库相对路径、NFC/NFD 差异都归一过了
    let body;
    try {
      if (!absPath) throw new Error('语料目录里没有这个文件');
      body = splitFrontMatter(fs.readFileSync(absPath, 'utf8')).body;
    } catch {
      throw HttpError.badRequest(
        `语料里没有这一篇：${requestedPath}。path 要么用结果里的 path 字段（仓库相对路径），要么直接用结果里的 url；` +
          '也可以改用 filters.q 按关键词检索。',
        { field: 'path' },
      );
    }

    const text = stripLeadingHeading(body);
    const totalChars = text.length;
    const size = Math.min(MAX_MAX_CHARS, Math.max(1, Math.floor(Number(maxChars) || DEFAULT_MAX_CHARS)));
    // offset 越界不报 400：模型可能拿着旧结果的 offset 来读一篇已经变短的文档，
    // 这时"给空正文 + 真实 totalChars"比让它再白跑一轮更容易自愈。
    const start = Math.min(totalChars, Math.max(0, Math.floor(Number(offset) || 0)));
    const end = Math.min(totalChars, start + size);
    return {
      title: item?.title ?? path.basename(absPath ?? requestedPath, '.md'),
      url: item?.url ?? null,
      path: item?.path ?? requestedPath,
      category: item?.category ?? null,
      categorySlug: item?.categorySlug ?? null,
      publishedAt: item?.publishedAt ?? null,
      kind: item?.kind ?? 'document',
      content: text.slice(start, end),
      // 这次窗口从第几字开始、下一次该从第几字续读。`nextOffset` 为 null = 已经读到结尾，
      // 模型据此才敢说"条款读全了"，而不是把窗口末尾当全文末尾。
      offset: start,
      nextOffset: end < totalChars ? end : null,
      truncated: end < totalChars,
      // 这一篇**一共多少字**（截断前的真实长度）。给它是为了让"被截了"可被校验：
      // `truncated` 是个布尔，调用方无法判断"差一点"还是"差一个数量级"，
      // 而"要不要再读一次 / 该不该说'我只看到一部分'"正是靠这个数字决定的。
      totalChars,
    };
  }

  /* ---------------------------------------------------------------- 检索 */

  /**
   * 关键词 + 栏目检索（打分公式与片段规则见 `search.js` 的注释）。
   *
   * 约定（任务书 + §14.4）：
   *   - `q` 为空且没有 `path` → 空结果，**不抛错**（`count: 0`）；
   *   - `path` 非空 → 直接读那一篇，按片段逻辑返回 1 条，并**额外带上正文窗口**
   *     （`content` / `truncated` / `totalChars` / `offset` / `nextOffset`，默认窗口 4000 字）；
   *   - `section` 非空 → 只在这一小节里检索 / 只返回这一节；`offset` 用于从命中处续读；
   *   - `limit` 默认 5、上限 10；`category` 是栏目 slug，收窄到该栏目。
   *
   * 两条通道给的东西**刻意不一样**，这是本文件最重要的分叉：
   *   "帮我找一篇"（只有 q）→ 只给片段 + `offset`（命中在第几字），
   *   "我就要这一篇"（有 path）→ 给正文窗口 + `nextOffset`（能继续读）。
   * 混起来任何一边都会坏：全都给全文会把对话预算撑爆，全都只给片段则模型永远读不到条款数字。
   */
  search({
    q = '',
    category = '',
    path: requestedPath = '',
    limit = DEFAULT_LIMIT,
    snippetChars = DEFAULT_SNIPPET_CHARS,
    pathMaxChars = DEFAULT_PATH_MAX_CHARS,
    offset = 0,
    section = '',
  } = {}) {
    const query = String(q ?? '').trim();
    const wantedSection = String(section ?? '').trim();
    if (requestedPath) {
      return this.#searchByPath(requestedPath, query, snippetChars, pathMaxChars, { offset, section: wantedSection });
    }
    if (!query || !this.available) return { available: this.available, q: query, count: 0, items: [] };

    this.#ensureLoaded();
    const wantedCategory = String(category ?? '').trim();
    const docs = [];
    for (const entry of this.categories) {
      if (wantedCategory && entry.slug !== wantedCategory) continue;
      for (const item of entry.items) {
        if (!wantedSection) {
          docs.push(item);
          continue;
        }
        /**
         * 按小节检索：把每篇的检索范围换成"这一节"。
         *
         * 为什么不先全篇检索再过滤：`q` 可能在正文别处命中（比如"退学"在请假办法里
         * 也出现一次），那样排在前面的会是一篇无关的短公告，而真正写条款的那一节被埋掉。
         * 换成"每篇只看这一节"后，打分与片段都落在同一段文字上，模型拿到的东西才自洽。
         */
        const range = findSection(item.rawText ?? '', wantedSection);
        if (!range) continue;
        const rawSection = (item.rawText ?? '').slice(range.offset, range.end);
        docs.push({
          ...item,
          text: stripMarkdown(rawSection),
          rawText: rawSection,
          offsetBase: range.offset,
          section: {
            title: range.title,
            kind: range.kind,
            offset: range.offset,
            end: range.end,
            chars: range.chars,
          },
        });
      }
    }

    const expanded = expandQuery(query);
    const size = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(limit) || DEFAULT_LIMIT)));
    const { count, items } = searchDocuments(docs, expanded, { limit: size, snippetChars });
    return {
      available: this.available,
      q: query,
      ...(wantedSection ? { section: wantedSection } : {}),
      count,
      // 只回片段：整篇正文不在这里出去（要正文请走 `search({ path })` 或 `read({ offset })`），
      // 这是"不整篇进提示词"的落点。这里顺手丢掉内部字段 `text`/`rawText`/`offsetBase`，
      // 于是这条路径**天然不可能**带上 `content` —— 用户没点名哪一篇，凭什么给它全文。
      items: items.map(({ text, rawText, offsetBase, ...item }) => item),
    };
  }

  /**
   * `search({ path })`：直接定位那一篇，做 1 条结果（越界照旧 400）。
   *
   * 与按关键词检索的两点差别（都只在"点名 = 我知道要哪一篇"这个语义下才成立）：
   *   1. 多回 `content`（正文窗口 + `offset` / `nextOffset` / `truncated` / `totalChars`）；
   *   2. `content` 用**原文**（`read()` 的口径，保留表格与 Markdown 结构），
   *      而 `snippet` 仍是清洗过的片段 —— 读条款要结构，找关键词要干净文本。
   *
   * 三个"能续读"的细节：
   *   - 带 `q` 时窗口**开在命中处附近**，而不是永远从第 0 字开始。否则模型按 path+q 读长文，
   *     拿到的还是前 4000 字，命中在第 5000 字的条款照样读不到（这是真机缺陷的另一半）；
   *   - `offset` 显式续读时以它为准；
   *   - `section` 把范围收窄到一节，窗口不越过节尾。
   */
  #searchByPath(requestedPath, query, snippetChars, pathMaxChars, { offset = 0, section = '' } = {}) {
    // 读**全文**再切窗口：小节与 offset 都可能落在 4000 字之后，先截断再找必然找不到。
    // MAX_MAX_CHARS = 20000，远大于语料里最长的一篇（约 8300 字），所以这里拿到的就是全文。
    const full = this.read({ path: requestedPath, maxChars: MAX_MAX_CHARS });
    const text = full.content;
    const expanded = expandQuery(query);
    const range = section ? findSection(text, section) : null;
    if (section && !range) {
      return {
        available: this.available,
        q: query,
        section,
        title: full.title,
        path: full.path,
        count: 0,
        items: [],
      };
    }

    const lo = range ? range.offset : 0;
    const hi = range ? range.end : text.length;
    const scoped = text.slice(lo, hi);
    const scopedClean = stripMarkdown(scoped);
    const hit = query ? findFirstMatch(scopedClean, expanded) : null;
    const hitAt = hit
      ? lo + rawOffsetFor(scoped, scopedClean, hit.at, hit.term.value)
      : null;

    const requestedOffset = Math.max(0, Math.floor(Number(offset) || 0));
    let start;
    if (requestedOffset > 0) {
      start = Math.min(hi, Math.max(lo, requestedOffset));
    } else if (hitAt !== null) {
      // 命中点前面只留一小段上下文（小标题、条款序号），其余窗口全部朝后 ——
      // 条款正文在命中词**之后**，把命中点放在窗口正中反而会把后面的条文切掉。
      // 真实例：查「退学」命中学籍规定第 1385 字，目标第六章在第 4860 字；
      // 从 1185 字往后给 4000 字，正好覆盖到 5185 字（窗口末尾仍可用 nextOffset 续读）。
      start = Math.max(lo, hitAt - Math.min(200, Math.floor(pathMaxChars / 10)));
    } else {
      start = lo;
    }
    const end = Math.min(hi, start + Math.max(1, Math.floor(Number(pathMaxChars) || DEFAULT_PATH_MAX_CHARS)));
    const content = text.slice(start, end);
    const truncated = end < hi;

    // 片段仍以整节 / 整篇为取材范围：它要回答"命中处长什么样"，不局限于本次窗口。
    // 用清洗文本（`stripMarkdown`）是为了不让 `**第二十六条**` 这类排版符号占字数。
    const snippet = buildSnippet({ ...full, text: scopedClean }, expanded, snippetChars);
    const matches = expanded.terms
      .filter((term) => `${full.title}\n${scopedClean}`.toLowerCase().includes(term.value.toLowerCase()))
      .map((term) => term.value);
    return {
      available: this.available,
      q: query,
      ...(section ? { section } : {}),
      count: 1,
      items: [
        {
          title: full.title,
          url: full.url,
          path: full.path,
          category: full.category,
          categorySlug: full.categorySlug,
          publishedAt: full.publishedAt,
          kind: full.kind,
          score: null, // 直接定位不是"排序出来的"，给 null 比编一个分数诚实
          snippet,
          matches,
          section: range
            ? {
                title: range.title,
                kind: range.kind,
                offset: range.offset,
                end: range.end,
                chars: range.chars,
              }
            : undefined,
          // 点了名就给正文窗口：`truncated` / `totalChars` / `nextOffset` 是**如实口径** ——
          // 超过窗口时必须让调用方看得出"这只是第 offset 到 nextOffset 字"，不许把窗口当全文讲出去
          content,
          offset: start,
          ...(hitAt !== null ? { matchOffset: hitAt } : {}),
          nextOffset: truncated ? end : null,
          truncated,
          totalChars: full.totalChars,
        },
      ],
    };
  }

  /* ---------------------------------------------------------------- 自检 */

  /**
   * 索引与文件一致性自检，判据与 `scripts/crawl-dean.js --check` **同一套**：
   * 文件存在，且 `sha256(正文)` 与索引一致（正文 = front matter 之后、trim()、含那行 H1）。
   *
   * 为什么要在服务里再实现一遍：抓取器是"用户显式跑的一次性脚本"，而设置页的
   * 「检查语料」按钮要在进程里立刻给出答案 —— 判据必须一致，否则两处结论会打架。
   */
  check() {
    const problems = [];
    // 索引都没读进来时，这里往往正是"文件缺失/损坏"的直接原因，先报它
    if (!fs.existsSync(this.indexFile)) {
      problems.push(`没有 index.json：${this.indexFile}（先跑 node scripts/crawl-dean.js）`);
      return { ok: false, problems };
    }
    // 索引在、但读不起来（坏 JSON / 形状不对）：这正是 `restore()` 降级成空语料的原因，
    // 必须报出来 —— 否则会出现"available: false 而自检 ok"这种自相矛盾的结论
    if (this.reason) problems.push(`${this.reason}（${this.indexFile}）`);
    for (const category of this.categories) {
      for (const item of category.items) {
        if (!item.path) {
          problems.push(`索引里有一条没有文件：${item.title}（${item.url ?? '没有 url'}）`);
          continue;
        }
        const file = this.#findOnDisk(item.path);
        if (!file) {
          problems.push(`文件不存在：${item.path}`);
          continue;
        }
        const { body } = splitFrontMatter(fs.readFileSync(file, 'utf8'));
        // 换行口径见 matchesIndexHash：Windows 检出会把 LF 变成 CRLF，
        // 不做这层容忍就会整库报"内容与索引不一致"（实测 148 条全报）。
        if (!matchesIndexHash(body, item.sha256)) problems.push(`内容与索引不一致：${item.path}`);
      }
    }
    return { ok: problems.length === 0, problems };
  }
}
