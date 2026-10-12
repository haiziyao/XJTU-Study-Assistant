/**
 * 统一检索的**纯函数层**：查询展开 → 命中打分 → 跨源归一化 → 片段窗口 → 去重合并。
 *
 * 为什么单独一个文件：这一层是"可解释、可测"的部分。混进 `service.js` 之后，
 * 想验证"两路分数到底能不能比"就得先造三个服务（知识库要磁盘语料、笔记要 JsonStore、
 * 记忆要落盘），而这里把几段手写的 `{ title, text }` 丢进来就能断言排序与归一化。
 * 无 I/O、无状态、不 import 任何其它模块 —— 这个文件坏了，只可能是它自己坏了。
 *
 * ## 跨源分数为什么能比（本模块最需要解释的一个决定）
 *
 * 三路各有各的"原始分"，直接混排是耍流氓：知识库的 raw 动辄 8 分，记忆的命中可能只有 1 分，
 * 但那是**量纲不同**，不是"记忆不重要"。所以分两步：
 *
 * 1. **原始分用同一个公式族**（`scoreText()`）：`(标题命中×8 + 正文命中) / (1 + log(1 + 字数/1000))`。
 *    知识库那一侧刻意**不重算**（要求就是"知识库用它自己的分数"），而是直接采信
 *    `knowledge.search()` 的 `score` —— 它与本文件这个公式同形（同样的标题 8 倍权重、
 *    同样的 log 长度阻尼、同样的单词命中封顶 2 次），所以三个 raw 落在同一个量纲上。
 *    这也是本文件的三档词权重（整串 4 / 切分词 2 / 二元组 1）**故意与知识库模块一致**的原因：
 *    同一个 q 在三个源里必须切出同一批词、同一批权重，分数才有可比性。
 *    （代价是本文件与 `knowledge/search.js` 有一份"同口径"的重复实现。这是清醒的取舍：
 *    不 import 那边的内部文件，是为了让知识库模块将来重构打分公式时**不会**连带改掉
 *    本模块的排序；口径一旦分叉，两边各自有注释说明自己是什么口径。）
 * 2. **归一化到 [0,1]**（`normalizeScore()`）：`score = raw / (raw + 4)`。
 *    单调、有界、不需要看"本次结果集里最大是多少"（那种相对归一化会让同一个文档
 *    因为旁边多了/少了一条命中而改变分数，做分页与前端缓存时会很难受）。
 *    语义好记：**raw = 4 分 → 0.5**（约等于"一次整串正文命中，或四次二元组命中"），
 *    raw = 8 分（标题整串命中）→ 0.667，raw = 40 → 0.909。饱和的尾巴是有意的：
 *    长文里命中 20 次不该比命中 5 次强四倍（这本来就是词频，不是相关性）。
 */

/** 三档词权重（与知识库模块同口径）：整串 > 切分词 > 中文二元组。 */
export const TERM_WEIGHTS = { full: 4, token: 2, bigram: 1 };

/** 标题命中权重：标题是"这一条讲什么"的主题词，比正文里顺带提一句强得多。 */
export const TITLE_BOOST = 8;

/** 长度归一的参考长度（字）：分母 `1 + log(1 + 字数/1000)`，用 log 而非线性，别把长文一棍打死。 */
export const LENGTH_UNIT = 1000;

/** 饱和常数：raw = 4 分映射到 0.5（见文件头）。 */
export const HALF_SCORE = 4;

/** 单个词的命中次数封顶：词频是"提及"，不是"相关"。 */
const HIT_CAP = 2;

/** 一次查询最多展开多少组词、单个词最长多少字（防"的的的的…"这类输入拖垮打分）。 */
const MAX_TERMS = 64;
const MAX_TERM_CHARS = 64;

/** 片段的省略号。首尾都加，为的是别让人/模型把片段当成全文的边界。 */
export const ELLIPSIS = '…';

/** 正文（或片段）为空的兜底文案：如实说"没有可读正文"，不要静默返回空串装"没搜到"。 */
export const NO_TEXT_NOTE = '（这一条没有可检索的正文，只有标题）';

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * 空白与标点。中文标点与英文标点一起当分隔符，且**不参与整串** ——
 * 模型写 "转专业，条件" 和 "转专业 条件" 显然是同一个意图。
 * 保留 `-` `_` `.` `+` `#`（C++、3.5、a-b 这类术语的一部分）。
 *
 * **带 `g` 标志**（用 `new RegExp` 拼，不写字面量）：`String.replace` 遇到不带 `g` 的正则
 * 只替换第一处，"转专业，条件！"会剩下全角感叹号留在"整串"里，于是这句话永远匹配不上任何正文。
 */
const SEPARATOR = new RegExp(
  '[\\s\\u3000!-/:-@[-`{-~\\u2000-\\u206f\\u2e00-\\u2e7f\\u3001-\\u303f\\uff01-\\uff5e]+',
  'g',
);

const weightOf = (term) => TERM_WEIGHTS[term.kind];
const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** 查询归一化：NFKC 把全角标点折成半角，再去掉所有空白与标点。 */
const normalizeQuery = (value) => String(value ?? '').normalize('NFKC').replace(SEPARATOR, '');

/**
 * 词条去重：同一个字符串只留**权重最高**的那一档，再按权重砍到 MAX_TERMS。
 *
 * 为什么必须去重：`q = "转专业 条件"` 的整串是"转专业条件"，切分词里有"转专业""条件"，
 * 二元组里还会再出现"转专"……不去重的话正文里同一处会被累加两三次，分数就变成
 * "谁重复得多的函数"，而不是相关性的函数。
 * 为什么先收全再截断：反过来的话一条超长查询会把后面的高权重词挤掉，只剩先入队的二元组。
 */
function dedupe(terms) {
  const best = new Map();
  for (const term of terms) {
    if (!term.value || term.value.length > MAX_TERM_CHARS) continue;
    const previous = best.get(term.value);
    if (!previous || weightOf(term) > weightOf(previous)) best.set(term.value, term);
  }
  return [...best.values()]
    .sort((a, b) => weightOf(b) - weightOf(a) || b.value.length - a.value.length)
    .slice(0, MAX_TERMS);
}

/**
 * 把查询拆成三档词，并把权重**归一化**到本次查询的最大权重（整串命中 = 1.0）。
 *
 * @param {string} query 原始查询串（"转专业 条件" / "LMS 成绩" / "转专业，条件"）
 * @returns {{ raw: string, normalized: string, terms: Array<{value:string, kind:string, weight:number}> }}
 */
export function expandQuery(query) {
  const raw = String(query ?? '').trim();
  const normalized = normalizeQuery(raw);
  if (!normalized) return { raw, normalized: '', terms: [] };

  const terms = [];
  const push = (value, kind) => {
    if (value && value.length <= MAX_TERM_CHARS) terms.push({ value, kind });
  };
  // ① 整串（去掉空白与标点后的全句）
  push(normalized, 'full');
  // ② 空白 / 标点切分出的词
  for (const token of raw.split(SEPARATOR)) push(token, 'token');
  // ③ 中文二元组：在连续中文串上取相邻两字（刻意跨过标点，"转专业，条件"也要能切出"业条"）。
  //    检索口径是"保召回"：二元组权重最低，多切几个只是多几条低分候选；漏切会让
  //    "库里明明有、却搜不到"（比如同一句话被不同的标点拆开）。
  for (const run of normalized.split(/[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/)) {
    for (let i = 0; i + 1 < run.length; i += 1) push(run.slice(i, i + 2), 'bigram');
  }

  const unique = dedupe(terms);
  if (!unique.length) return { raw, normalized, terms: [] };
  const top = Math.max(...unique.map(weightOf));
  return {
    raw,
    normalized,
    terms: unique
      .map((term) => ({ ...term, weight: weightOf(term) / top }))
      // 权重降序 → 长词优先 → 字典序：只为让 matches 与同分排序**确定**（测试能断言顺序）
      .sort((a, b) => b.weight - a.weight || b.value.length - a.value.length || (a.value < b.value ? -1 : 1)),
  };
}

/**
 * 数一个词在文本里出现几次（大小写不敏感，单次命中上限 HIT_CAP×32 次即停）。
 *
 * **游标每次只前进 1 个字符**（重叠计数）：中文二元组天然重叠，正文里一处"作息时间"
 * 就该数出两次"息时"；步进取 `pin.length` 会漏掉一半命中，"出现 10 次"与"出现 2 次"算出来一样。
 */
export function countOccurrences(haystack, needle, max = 64) {
  if (!needle) return 0;
  const hay = String(haystack ?? '').toLowerCase();
  const pin = String(needle).toLowerCase();
  let from = 0;
  let hit = 0;
  while (hit < max) {
    const at = hay.indexOf(pin, from);
    if (at < 0) break;
    hit += 1;
    from = at + 1;
  }
  return hit;
}

/**
 * 打分（笔记 / 记忆用；知识库用它自己的 `knowledge.search()` 分数，不在这里重算）。
 *
 *   raw = ( titleHits × 8 + bodyHits ) / ( 1 + log(1 + 正文字数 / 1000 ) )
 *   titleHits = Σ(命中"标题"的词权重 × 命中次数，单个词封顶 2 次)
 *   bodyHits  = Σ(命中"正文"的词权重 × 命中次数，单个词封顶 2 次)
 *
 * - 笔记：标题 = `title`，正文 = `body`（用户自己的 Markdown 原文）；
 * - 记忆：标题 = `key`（这条记忆的句柄/主题词，等价于标题），正文 = `text`。
 *   记忆正文 ≤200 字，长度阻尼在它身上几乎不起作用 —— 这是**刻意**的：
 *   跨源可比优先于"每一路自己最优"（记忆本来就短，不该因为短而被系统性地抬高或压低）。
 *
 * @returns {{ raw:number, titleHits:number, bodyHits:number, chars:number }}
 */
export function scoreText({ title = '', body = '' } = {}, query) {
  const terms = Array.isArray(query?.terms) ? query.terms : expandQuery(query).terms;
  let titleHits = 0;
  let bodyHits = 0;
  for (const term of terms) {
    titleHits += term.weight * Math.min(HIT_CAP, countOccurrences(title, term.value));
    bodyHits += term.weight * Math.min(HIT_CAP, countOccurrences(body, term.value));
  }
  const chars = String(body ?? '').length;
  const damping = 1 + Math.log(1 + chars / LENGTH_UNIT);
  return { raw: (titleHits * TITLE_BOOST + bodyHits) / damping, titleHits, bodyHits, chars };
}

/** 原始分 → [0,1] 的统一分数（单调饱和，见文件头）。`raw <= 0` 得 0，排序里自然沉底。 */
export function normalizeScore(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return round(value / (value + HALF_SCORE), 4);
}

/** 原始分保留 3 位小数（放 `meta.rawScore`，给人排查"为什么它排前面"用）。 */
export const roundRaw = (raw) => round(Number(raw) || 0, 3);

/**
 * 跨源身份键：**归一化标题**（NFKC → 小写 → 去掉所有空白/标点/符号）。
 *
 * 为什么用标题：这三批数据里没有别的字段能同时标识"同一篇内容"——
 * 知识条目有 url 和 path、笔记有 id，但两边没有交集；而"用户把教务处那篇
 * 存成了自己的笔记"这种重复，唯一会一致的就是标题。
 * 只有**跨源**才合并（同名但同源的两条是不同的条目，合并会凭空吞掉一条真数据）。
 */
export const dedupeKeyOf = (title) => String(title ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

/**
 * 抽片段：把命中位置前后各约 `size/2` 字给出来。
 *
 * 笔记正文是用户自己的 Markdown，**刻意不清洗标记**（`##`、`**` 原样留着）：
 * 用户按自己写的样子认出来最容易，而 `stripMarkdown` 那种清洗是给"外来的政策语料"做的。
 * 只压掉多余空白（换行、连续空格在对话与卡片里没有信息量）。
 *
 * 没有任何命中时给开头（"这条大概讲什么"仍然有用）；正文为空时给 NO_TEXT_NOTE，
 * 而不是空串 —— 空串会让模型以为"没搜到内容"，实际是"这条没有正文"。
 */
export function buildWindow(text, terms, size = 240) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return NO_TEXT_NOTE;
  const window = Math.max(20, Number(size) || 240);
  const list = Array.isArray(terms) ? terms : [];
  let at = -1;
  for (const term of list) {
    const found = flat.toLowerCase().indexOf(String(term.value).toLowerCase());
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return flat.length > window ? `${flat.slice(0, window)}${ELLIPSIS}` : flat;
  const start = Math.max(0, at - Math.floor(window / 2));
  const end = Math.min(flat.length, start + window);
  return `${start > 0 ? ELLIPSIS : ''}${flat.slice(start, end).trim()}${end < flat.length ? ELLIPSIS : ''}`;
}

/** 来源的稳定序（同分时的裁决顺序）：校规 > 笔记 > 记忆 —— 同等相关时以权威来源优先。 */
const SOURCE_RANK = { knowledge: 0, note: 1, memory: 2 };

/** 合并排序 + 跨源去重。**输入必须已按分数降序**（去重要保留分数最高的那条当主条）。 */
export function rankAndMerge(items) {
  const sorted = [...items].sort(
    (a, b) =>
      b.score - a.score ||
      SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
      String(a.title ?? '').localeCompare(String(b.title ?? '')) ||
      String(a.id ?? '').localeCompare(String(b.id ?? '')),
  );

  const out = [];
  /** 归一化标题 → 已输出条目的下标（只有第一条占住这个键）。 */
  const owner = new Map();
  for (const raw of sorted) {
    // dedupeKey 只是内部工序，不进最终返回（`meta` 是给界面看的，不塞实现细节）
    const { dedupeKey = null, ...meta } = raw.meta ?? {};
    const item = { ...raw, sources: [...(raw.sources ?? [raw.source])], meta };
    const at = dedupeKey ? owner.get(dedupeKey) : undefined;

    // 跨源命中同一篇：并进已有那条，不新增（用户不该在列表里看到两份一样的东西）。
    // 判据是"这条的来源**还没被并进去过**"，而不是"和主条不同源"：
    // 语料里可能有两篇同标题的篇目（不同栏目各挂一份），若只判"不同源"，
    // 它们会被一起吞进那条笔记里 —— 那是在**丢数据**，不是去重。
    if (at !== undefined && !out[at].sources.includes(item.source)) {
      const primary = out[at];
      primary.sources.push(item.source);
      primary.meta.merged ??= [];
      primary.meta.merged.push({
        source: item.source,
        id: item.id,
        title: item.title,
        score: item.score,
        ...(item.url ? { url: item.url } : {}),
        ...(item.noteId ? { noteId: item.noteId } : {}),
        ...(item.path ? { path: item.path } : {}),
      });
      // 被并掉的那一路里"能点开"的句柄要保留下来：界面靠 noteId 跳到用户自己的笔记，
      // 靠 url 点回教务处原文 —— 合并只该去掉重复，不该去掉入口
      if (!primary.noteId && item.noteId) primary.noteId = item.noteId;
      if (!primary.url && item.url) primary.url = item.url;
      continue;
    }

    if (dedupeKey && at === undefined) owner.set(dedupeKey, out.length);
    out.push(item);
  }
  return out;
}
