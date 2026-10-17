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
 *    整篇进提示词会把对话预算撑爆（§14.1）。要整篇得显式调 `read()`，且默认截 8000 字。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { HttpError } from '../../core/http/router.js';
import { buildSnippet, expandQuery, searchDocuments, stripMarkdown } from './search.js';

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

/** `read()` 的默认与上限字数（§14.3：默认 8000）。 */
const DEFAULT_MAX_CHARS = 8000;
const MAX_MAX_CHARS = 20000;

/**
 * `search({ path })`（"我点名要这一篇"）额外带回的**长正文**上限。
 *
 * 为什么按关键词检索时不能有它、点名时却必须有：
 *   - 按 `q` 检索是"我不知道是哪一篇，帮我找" —— 10 条 × 全文就等于把半个语料倒进提示词，
 *     这是 §14.1/§14.4 明令禁止的，所以那里**只给片段**，维持原样；
 *   - 带 `path` 是"**我就要这一篇**"（模型已经拿到 url/path，只是想读条款）—— 这时再只给 240 字
 *     片段就等于收了一次钱不给货：实测《学业预警与学籍处理实施细则》2169 字，
 *     12/8/4 三档阈值在**第 341 字**的表格里，240 字片段刚好停在"三级预警"前一行，
 *     模型只能老实说"这一页正文读到第三条就断了"。给全文片段才配得上"点名读一篇"的语义。
 *
 * 4000 的来历：约等于 2 页 A4 的政策正文，够覆盖绝大多数细则的条款主体；
 * 再长就走 `truncated` + `totalChars` 如实告知，需要更多再显式调 `read()`（默认 8000）。
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
          continue;
        }
        const raw = fs.readFileSync(file, 'utf8');
        // 正文先去掉那行 `# 标题`、再过 Markdown 清洗：打分与片段都基于"给人看的文字"。
        // 去标题是因为它已经作为 `title` 参与打分（还带 ×8 权重），留在正文里会被算第二遍；
        // 清洗则挡掉 `](http://…)` 这类语法白送命中（比如查 jpg 竟然能搜到一片校历页）
        item.text = stripMarkdown(stripLeadingHeading(splitFrontMatter(raw).body));
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
   * 读一篇（`content` 默认截前 8000 字，超出用 `truncated` 标出）。
   *
   * `content` 去掉开头那行 `# 标题`：`title` 已经单独返回了，正文里再来一遍是重复。
   * `path` 不在语料目录内 → 400（`HttpError.badRequest`），这是 §14.3 的硬要求。
   */
  read({ path: requestedPath, maxChars = DEFAULT_MAX_CHARS } = {}) {
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
    const size = Math.min(MAX_MAX_CHARS, Math.max(1, Math.floor(Number(maxChars) || DEFAULT_MAX_CHARS)));
    return {
      title: item?.title ?? path.basename(absPath ?? requestedPath, '.md'),
      url: item?.url ?? null,
      path: item?.path ?? requestedPath,
      category: item?.category ?? null,
      categorySlug: item?.categorySlug ?? null,
      publishedAt: item?.publishedAt ?? null,
      kind: item?.kind ?? 'document',
      content: text.slice(0, size),
      truncated: text.length > size,
      // 这一篇**一共多少字**（截断前的真实长度）。给它是为了让"被截了"可被校验：
      // `truncated` 是个布尔，调用方无法判断"差一点"还是"差一个数量级"，
      // 而"要不要再读一次 / 该不该说'我只看到一部分'"正是靠这个数字决定的。
      totalChars: text.length,
    };
  }

  /* ---------------------------------------------------------------- 检索 */

  /**
   * 关键词 + 栏目检索（打分公式与片段规则见 `search.js` 的注释）。
   *
   * 约定（任务书 + §14.4）：
   *   - `q` 为空且没有 `path` → 空结果，**不抛错**（`count: 0`）；
   *   - `path` 非空 → 直接读那一篇，按片段逻辑返回 1 条，并**额外带上长正文**
   *     （`content` / `truncated` / `totalChars`，默认上限 4000 字，见 `DEFAULT_PATH_MAX_CHARS`）；
   *   - `limit` 默认 5、上限 10；`category` 是栏目 slug，收窄到该栏目。
   *
   * 两条通道给的东西**刻意不一样**，这是本文件最重要的分叉：
   *   "帮我找一篇"（只有 q）→ 只给片段；"我就要这一篇"（有 path）→ 给正文。
   * 混起来任何一边都会坏：全都给全文会把对话预算撑爆，全都只给片段则模型永远读不到条款数字。
   */
  search({
    q = '',
    category = '',
    path: requestedPath = '',
    limit = DEFAULT_LIMIT,
    snippetChars = 240,
    pathMaxChars = DEFAULT_PATH_MAX_CHARS,
  } = {}) {
    const query = String(q ?? '').trim();
    if (requestedPath) return this.#searchByPath(requestedPath, query, snippetChars, pathMaxChars);
    if (!query || !this.available) return { available: this.available, q: query, count: 0, items: [] };

    this.#ensureLoaded();
    const wantedCategory = String(category ?? '').trim();
    const docs = [];
    for (const entry of this.categories) {
      if (wantedCategory && entry.slug !== wantedCategory) continue;
      for (const item of entry.items) docs.push(item);
    }

    const expanded = expandQuery(query);
    const size = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(limit) || DEFAULT_LIMIT)));
    const { count, items } = searchDocuments(docs, expanded, { limit: size, snippetChars });
    return {
      available: this.available,
      q: query,
      count,
      // 只回片段：整篇正文不在这里出去（要整篇请走 `search({ path })` 或 `read()`），
      // 这是"不整篇进提示词"的落点。`({ text, ...item })` 顺手丢掉内部字段 `text`，
      // 于是这条路径**天然不可能**带上 `content` —— 用户没点名哪一篇，凭什么给它全文。
      items: items.map(({ text, ...item }) => item),
    };
  }

  /**
   * `search({ path })`：直接定位那一篇，做 1 条结果（越界照旧 400）。
   *
   * 与按关键词检索的两点差别（都只在"点名 = 我知道要哪一篇"这个语义下才成立）：
   *   1. 多回 `content`（长正文 + `truncated` + `totalChars`）；
   *   2. `content` 用**原文**（`read()` 的口径，保留表格与 Markdown 结构），
   *      而 `snippet` 仍是清洗过的片段 —— 读条款要结构，找关键词要干净文本。
   */
  #searchByPath(requestedPath, query, snippetChars, pathMaxChars) {
    const doc = this.read({ path: requestedPath, maxChars: pathMaxChars });
    const expanded = expandQuery(query);
    // 片段基于正文（`read()` 已经去掉 H1）：有查询词就把窗口开在命中处，否则给开头
    const snippet = buildSnippet({ ...doc, text: doc.content }, expanded, snippetChars);
    const matches = expanded.terms
      .filter((term) => `${doc.title}\n${doc.content}`.toLowerCase().includes(term.value.toLowerCase()))
      .map((term) => term.value);
    return {
      available: this.available,
      q: query,
      count: 1,
      items: [
        {
          title: doc.title,
          url: doc.url,
          path: doc.path,
          category: doc.category,
          categorySlug: doc.categorySlug,
          publishedAt: doc.publishedAt,
          kind: doc.kind,
          score: null, // 直接定位不是"排序出来的"，给 null 比编一个分数诚实
          snippet,
          matches,
          // 点了名就给正文：`truncated` / `totalChars` 是**如实口径** ——
          // 超过上限时必须让调用方看得出"这只是前 N 字"，不许把截断当成全文讲出去
          content: doc.content,
          truncated: doc.truncated,
          totalChars: doc.totalChars,
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
