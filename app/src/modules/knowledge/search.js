/**
 * 知识库检索的**纯函数**部分（无 I/O、无状态）—— 打分、Markdown 清洗、片段抽取。
 *
 * 为什么单独一个文件：检索口径是"可解释、可测"的东西（接口文档 §14.4），
 * 混在 `service.js` 里就得先准备磁盘语料才能验证排序是否合理。放这里之后，
 * 把几篇手写的 `{ title, text }` 丢进 `searchDocuments` 就能断言打分与排序。
 *
 * 口径（§14.4）：**关键词 + 栏目**，不做向量 / embedding。语料只有 11.5 万字，
 * 全量驻留内存做暴力匹配完全够快，而向量检索要引第三方库、要建索引、还要解释
 * "为什么这条排前面"——在这个量级上不划算，模型也没法用 `matches` 复核相关性。
 */

/**
 * 三档词权重（"整串 > 切分 > 二元组"）。
 *
 * 为什么这么分：中文没有词边界，光靠二元组召回高但噪音大（"转专"也能命中一堆东西）；
 * 整串命中几乎可以确定相关（"转专业 条件"整句出现在一句里）；切分出的词居中。
 * **权重是相对的**：一律除以本次查询里最大的权重（见 `expandQuery`），
 * 所以"只有二元组"的查询不会因为绝对值小而整体得 0 分。
 */
export const TERM_WEIGHTS = { full: 4, token: 2, bigram: 1 };

/** 标题命中权重（§14.4：标题 8、正文 1）—— 标题是编辑写的主题词，比正文里顺带提一句强得多。 */
export const TITLE_BOOST = 8;

/**
 * 长度归一的参考长度：正文 1000 字（语料中位数约 240 字、最长 8200 字，1000 是中间量级）。
 *
 * 分母 `1 + log(1 + chars/1000)`：1000 字约除以 1.7、8200 字约除以 3.2。
 * 用 log 而不是直接除以字数，是因为"长文里顺带提一句"确实更弱，但长文也可能
 * 正是答案（8243 字的《学籍管理与学位授予规定》）—— 线性惩罚会把它直接埋掉。
 */
export const LENGTH_UNIT = 1000;

/**
 * 可见正文为空时的惩罚系数。
 *
 * 语料里有 77 篇正文在图片 / 附件里（README 的「还差的」），还有几篇清洗后只剩一行
 * `# 标题`（整页就是一张图，如《学生转专业流程》）。这些篇目**必须能被标题命中**
 * （用户问"校历"要找到它），但不该排在真正写了条款的篇目前面。0.35 是"仍能进列表、
 * 但压不过正文命中"的量级：一个整串标题命中（8 分）降到约 2.8。
 */
export const NO_BODY_PENALTY = 0.35;

/** 片段的省略号与"正文不在文字里"的说明。 */
export const ELLIPSIS = '…';
export const NO_TEXT_NOTE = '（这一篇正文在图片或附件里，请点链接看原文）';

/** 一次查询最多展开多少组词（防"的的的的…"这类输入把打分拖垮）。 */
const MAX_TERMS = 64;

/** 术语里最长保留多少字：再长的整串命中概率极低，但保留它不花什么代价。 */
const MAX_TERM_CHARS = 64;

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * 空白与标点。中文标点（，。、（）「」…）和英文标点一起当分隔符，且**不参与**整串，
 * 因为模型写查询时"转专业，条件"和"转专业 条件"显然是同一个意图。
 * 注意：保留 `-` `_` `.` `+` `#` —— 它们是 C++、3.5、a-b 这类术语的一部分。
 *
 * **带 `g` 标志**（用 `new RegExp` 拼，避免在字面量里数标志位出错）：
 * `String.replace` 遇到不带 `g` 的正则**只替换第一处**，"转专业，条件！"会剩下全角
 * 感叹号留在"整串"里，于是这句话永远匹配不上任何正文 —— 曾经真的栽在这里。
 */
const SEPARATOR = new RegExp(
  '[\\s\\u3000!-/:-@[-`{-~\\u2000-\\u206f\\u2e00-\\u2e7f\\u3001-\\u303f\\uff01-\\uff5e]+',
  'g',
);

const isCjk = (char) => CJK.test(char);
const weightOf = (term) => TERM_WEIGHTS[term.kind];

/**
 * 查询归一化：把全角标点折成半角（NFKC）、去掉所有空白与标点。
 *
 * 为什么要 NFKC：模型和用户都会打出全角标点（"转专业，条件！"）。ASCII 标点靠正则
 * 区间就够了，但全角标点（U+FF01–FF5E）在 Unicode 里是**另一个区段**，
 * 只写一个区间迟早漏。NFKC 先把它们折成 `,` `!` `(`，再统一去掉，
 * 分隔符规则只需要维护一份。
 */
const normalizeQuery = (value) => String(value ?? '').normalize('NFKC').replace(SEPARATOR, '');

/**
 * 词条去重：同一个字符串只留**权重最高**的那一档，最后按权重砍到 `MAX_TERMS` 条。
 *
 * 为什么必须去重：`q = "转专业 条件"` 的整串是"转专业条件"，切分词里有"转专业"、
 * "条件"，二元组里还可能再次出现"转专"……不去重的话，正文里同一处"转专业"
 * 会被累加两三次，分数就变成"谁重复得多的函数"，而不是相关性的函数。
 *
 * 为什么先全部收下、排序后再截断：反过来的话一条超长查询会把后面的**高权重**词
 * （整串、切分词）挤掉，只剩下先入队的二元组，召回与排序都会莫名其妙地变差。
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
 * 把查询拆成三档词，并把权重**归一化**到本次查询的最大权重。
 *
 * 归一化的理由：分数是给模型和前端看的排序依据，不同查询之间的绝对值没有可比性，
 * 但同一次查询内部必须可比 —— 归一化后"整串命中 = 1.0"永远成立，好解释也好测。
 *
 * @param {string} query 原始查询串（可能是"转专业 条件"、"LMS 成绩"、"转专业，条件"）
 * @returns {{ raw: string, normalized: string, terms: Array<{value:string,kind:string,weight:number}> }}
 */
export function expandQuery(query) {
  const raw = String(query ?? '').trim();
  // 整串：去掉所有空白与标点后的形式，用来做"这句话原样出现在文里"的匹配
  const normalized = normalizeQuery(raw);
  if (!normalized) return { raw, normalized: '', terms: [] };

  const terms = [];
  const push = (value, kind) => {
    if (value && value.length <= MAX_TERM_CHARS) terms.push({ value, kind });
  };
  const tokens = raw.split(SEPARATOR).filter(Boolean);

  // ① 整串（去空白与标点后的全句）
  push(normalized, 'full');
  // ② 空白 / 标点切分出的词
  for (const token of tokens) push(token, 'token');
  // ③ 中文二元组：在**连续中文串**上取相邻两字。
  //    刻意跨过空白与标点（"转专业，条件"也要能切出"业条"那个二元组），
  //    因为检索口径是"保召回"：二元组权重最低，多切几个只是多几条低分候选，
  //    但漏切会让"库里明明有、却搜不到"（比如用不同标点拆开的同一句话）。
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
      // 权重降序 → 长词优先 → 字典序：只为了让 `matches` 与同分排序**确定**
      .sort((a, b) => b.weight - a.weight || b.value.length - a.value.length || (a.value < b.value ? -1 : 1)),
  };
}

/**
 * 去掉 Markdown 噪音，得到"给人看"的纯文本（片段用）。
 *
 * 为什么要清洗：片段直接回灌给模型，`[![图片](http://...jpg?e=.jpg)](http://...jpg)`
 * 这种字符串既占字数又不含信息；标题的 `#`、表格的 `| --- |` 同理。
 * 图片语法整段丢掉，链接压成它的可见文字（保留"附件1：xxx.rar"这类有信息量的文字）。
 */
export function stripMarkdown(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ') // 代码块：语料里没有，真有时也只留占位
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片：语义在图片里，文字留着没意义
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接：压成可见文字
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // 标题井号
    .replace(/^\s{0,3}>\s?/gm, '') // 引用
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, ' ') // 表格分隔行（| --- | --- |）
    .replace(/^\s*[-*+]\s+/gm, '') // 无序列表符号
    .replace(/\*\*|__|`|~~/g, '') // 强调与行内代码标记
    .replace(/[ \t\u3000]+/g, ' ') // 横向空白压成一个空格
    .replace(/ *\n */g, ' ')
    // 空白整体压成单个空格：语料里空的 <p> 会变成成片空行，检索与片段都是给人/模型看的，
    // 版面换行没有信息量（`read()` 给全文时仍然保留原始换行）
    .replace(/\s+/g, ' ')
    // 中文之间被排版塞进来的空格去掉：语料里"学 生 作 息 时 间 表"是表格标题的排版写法，
    // 留着空格会导致"作息时间"匹配不上、片段里也读不出来。只删**两侧都是汉字**的空格，
    // 所以 "LMS 成绩"、"8:00 - 8:50" 这类有意义的间隔不受影响
    .replace(/(?<=[\u3400-\u4dbf\u4e00-\u9fff]) +(?=[\u3400-\u4dbf\u4e00-\u9fff])/g, '')
    .trim();
}

/**
 * 数一个词在文本里出现几次（大小写不敏感）。
 *
 * 用 `indexOf` 游标推进 + 命中上限，避免 `split().length - 1` 为了一次计数
 * 切开整个正文并分配数组（148 篇全量检索时是纯浪费）。
 *
 * **游标每次只前进 1 个字符**（重叠计数）。中文二元组天然重叠：正文里一处
 * "作息时间"就该数出两次"息时"（index 1 与 index 3）；stride 取 `pin.length`
 * 会漏掉一半命中，于是"出现 10 次"与"出现 2 次"算出来一样 ——
 * 词频封顶是为了表达"提及 ≠ 相关"，不该变成"数不准"。
 */
export function countOccurrences(haystack, needle, max = 64) {
  if (!needle) return 0;
  const hay = haystack.toLowerCase();
  const pin = needle.toLowerCase();
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
 * 打分公式（唯一一处定义，测试与注释都以它为准）：
 *
 *   score = ( titleHits × 8 + bodyHits ) / ( 1 + log(1 + bodyChars / 1000) ) × bodyPenalty
 *
 *   titleHits = Σ(命中标题的词权重 × 命中次数，单个词封顶 2 次)
 *   bodyHits  = Σ(命中正文的词权重 × 命中次数，单个词封顶 2 次)
 *   bodyPenalty = 可见正文为空 ? 0.35 : 1        // 图片页 / 附件页（清洗后没剩下文字）
 *
 * 四个设计点：
 *   1. **标题 ×8**（§14.4）：标题是编辑定的主题词，命中它基本就是"这篇讲这个"；
 *   2. **次数封顶 2**：不然一篇反复念叨"转专业"的长文会碾压真正讲条件的那篇 ——
 *      词频是"提及"，不是"相关"；
 *   3. **长度阻尼**：分母 `1 + log(1 + chars/1000)` 是"命中落在多长的正文里"的惩罚。
 *      刻意**不**直接除以正文字数（那会过度惩罚长文：8243 字的学籍规定确实可能是答案），
 *      而是 log 增长：1000 字约除以 1.7、8000 字约除以 3.2，单调、可解释、量级不失控。
 *      没有正文的篇目 chars = 0，分母为 1，标题命中不被冤枉地衰减；
 *   4. **正文为空的 ×0.35**：语料里有一批"正文其实是一张图"的页面
 *      （如《学生转专业流程》只剩一行 `# 标题`）。它们该被标题命中（用户找得到），
 *      但不该排在真正写了条款的篇目前面 —— 模型点进去也读不到内容。
 *      惩罚是**乘性的**（0.35），所以标题命中足够强时仍能进列表，只是不再压过正文命中。
 *
 * 返回的 `score` 保留 3 位小数（纯为可读），`titleHits` / `bodyHits` 一并返回，
 * 便于测试直接断言"标题命中确实被放大了"。
 */
export function scoreDocument(doc, query) {
  const title = String(doc?.title ?? '');
  const text = String(doc?.text ?? '');
  const terms = Array.isArray(query?.terms) ? query.terms : expandQuery(query).terms;
  let titleHits = 0;
  let bodyHits = 0;
  for (const term of terms) {
    titleHits += term.weight * Math.min(2, countOccurrences(title, term.value));
    bodyHits += term.weight * Math.min(2, countOccurrences(text, term.value));
  }
  const chars = text.length;
  const damping = 1 + Math.log(1 + chars / LENGTH_UNIT);
  const penalty = text.trim() ? 1 : NO_BODY_PENALTY;
  const score = ((titleHits * TITLE_BOOST + bodyHits) / damping) * penalty;
  return { score: Math.round(score * 1000) / 1000, titleHits, bodyHits, chars };
}

/**
 * 在「每个词各自的第一次出现」里挑一个最值得展示的命中。
 *
 * 为什么不能简单取位置最靠前的：查询「退学警告」会拆出整串（权重 1）、词（0.5）
 * 与二元组（0.25）。"退学"两个字在长文开头就可能出现（"按退学处理"），
 * 而真正讲"退学警告"的那一条在第 5000 字。按位置取最早，片段会停在无关的第一次提及；
 * 按**词权重优先、同权重取最早**，才会落在用户真正问的那个短语上。
 */
function pickBestHit(hits) {
  return hits.reduce((best, hit) => {
    if (!best) return hit;
    if (hit.term.weight > best.term.weight) return hit;
    if (hit.term.weight === best.term.weight && hit.at < best.at) return hit;
    return best;
  }, null);
}

/** 一篇文章里，命中词实际出现在哪些位置（大小写不敏感的模糊定位）。 */
function findMatches(haystack, terms) {
  const hay = haystack.toLowerCase();
  const hits = [];
  for (const term of terms) {
    const at = hay.indexOf(term.value.toLowerCase());
    if (at >= 0) hits.push({ term, at });
  }
  return hits;
}

/**
 * 第一个命中（权重最高、同权重取最早）。给 `search()` 回填 `offset` 用。
 *
 * 为什么需要它：片段是**清洗后**的文本（`stripMarkdown` 去掉 `#`、`**`、表格竖线），
 * 而 `read({ offset })` 切的是**原文**。两者坐标不同，直接把片段里的位置当 offset 会偏；
 * 这个函数只在清洗文本里定位，映射到原文由 `rawOffsetFor()` 完成。
 */
export function findFirstMatch(text, query) {
  const terms = Array.isArray(query?.terms) ? query.terms : expandQuery(query).terms;
  return pickBestHit(findMatches(String(text ?? ''), terms));
}

/**
 * 把「清洗文本里的第 N 个字」换算成「原文里的第几个字」。
 *
 * 为什么用**出现次序**而不是按长度比例估算：
 *   - `stripMarkdown` 只删字符、不重排词序（图片语法整段删掉、链接只留可见文字）；
 *   - 同一个词在原文与清洗文本里的出现顺序一致，所以"第 k 次出现"能精确对上；
 *   - 按比例估算在长文里可能差出几百字，而 `read({ offset })` 的价值就在于"从命中处附近接着读"。
 *
 * 词本身被清洗掉（例如查询里带了 Markdown 标记）时退回"原文里第一次出现"，
 * 再不行就退回清洗位置——宁可偏一点，也不能给出一个越过全文长度的 offset。
 */
export function rawOffsetFor(rawText, cleanText, cleanOffset, term) {
  const raw = String(rawText ?? '');
  const clean = String(cleanText ?? '');
  const pin = String(term ?? '').toLowerCase();
  if (!raw || !pin) return Math.max(0, cleanOffset);

  let ordinal = 0;
  let from = 0;
  const hay = clean.toLowerCase();
  while (ordinal < 1000) {
    const at = hay.indexOf(pin, from);
    if (at < 0 || at > cleanOffset) break;
    ordinal += 1;
    from = at + 1;
  }

  const rawHay = raw.toLowerCase();
  let scan = 0;
  let found = -1;
  for (let index = 0; index < Math.max(1, ordinal); index += 1) {
    found = rawHay.indexOf(pin, scan);
    if (found < 0) break;
    scan = found + 1;
  }
  if (found >= 0) return found;
  const first = rawHay.indexOf(pin);
  return first >= 0 ? first : Math.max(0, cleanOffset);
}

/** 小节标签归一：去 Markdown 标记、空白与全半角差异，只留可比较的文字。 */
const normalizeSection = (value) =>
  String(value ?? '')
    .normalize('NFKC')
    .replace(/[*#]/g, '')
    .replace(/\s+/g, '')
    .trim();

/**
 * 在原文里找一个小节（章 / 条 / Markdown 标题），返回它的字符区间。
 *
 * 为什么需要 `section`：用户问「挂几科退学」时，真正回答问题的可能只是《学籍规定》
 * 里「第六章 退学警告与退学」这 1000 多字；整篇 8213 字既读不完，也没必要读。
 * 有了区间，`search({ section })` 只在这个范围里找片段，`read` 也能从这一节开头读。
 *
 * 识别三种写法（语料里都真实存在）：
 *   - 章：`第六章 退学警告与退学`（普通一行，不是 Markdown 标题）；
 *   - 条：`**第二十六条 **学生出现…`（整条就是一段，粗体只是排版）；
 *   - Markdown 标题：`## 学业预警`。
 *
 * 区间终点按类型取：章到下一章/标题为止，条到下一章/条/标题为止。
 * 不能一律"到下一个第 X 条"——那会把一整章切碎，问"第六章是怎么规定的"只会拿到第一条。
 */
export function findSection(text, section) {
  const wanted = normalizeSection(section);
  // 一两个字的要求（如"退学"）太宽，会把正文里随便一句当小节标题；至少要求"第X章/第X条"级别的信息量
  if (!wanted || wanted.length < 2) return null;

  const source = String(text ?? '');
  const lines = [];
  let offset = 0;
  for (const rawLine of source.split('\n')) {
    const trimmed = rawLine.trim();
    const plain = trimmed.replace(/\*/g, '').replace(/^#+\s*/, '').trim();
    let kind = null;
    if (/^第[一二三四五六七八九十百零〇\d]+章(?:\s|$|[、.．:：])/.test(plain)) kind = 'chapter';
    else if (/^第[一二三四五六七八九十百零〇\d]+条/.test(plain)) kind = 'clause';
    else if (/^\s{0,3}#{1,6}\s+\S/.test(rawLine)) kind = 'heading';
    if (kind) lines.push({ kind, label: plain || trimmed, offset });
    offset += rawLine.length + 1;
  }

  const matches = [];
  lines.forEach((line, index) => {
    const label = normalizeSection(line.label);
    // `startsWith` 覆盖「第六章」查「第六章 退学警告与退学」；
    // `includes` 覆盖用户只记得正文里的关键词、没抄全标题的情况。
    if (label === wanted || label.startsWith(wanted) || label.includes(wanted)) matches.push(index);
  });
  if (!matches.length) return null;
  // 章/条优先于 Markdown 标题：用户说 `section:"学业预警"` 时想要的是「第二章 学业预警」，
  // 而不是页面最上面那行 H1 标题（它也会包含同样的关键词，但只覆盖前言）。
  const index = matches.find((at) => lines[at].kind !== 'heading') ?? matches[0];

  const found = lines[index];
  const stopKinds = found.kind === 'clause' ? ['clause', 'chapter', 'heading'] : ['chapter', 'heading'];
  const next = lines.slice(index + 1).find((line) => stopKinds.includes(line.kind));
  return {
    title: found.label.length > 80 ? `${found.label.slice(0, 80)}…` : found.label,
    kind: found.kind,
    offset: found.offset,
    end: next ? next.offset : source.length,
    chars: (next ? next.offset : source.length) - found.offset,
  };
}

/**
 * 抽片段：命中位置前后各约 `snippetChars / 2` 字。
 *
 * **只给片段，不给全文**（§14.1 / §14.4）：模型只需要"这句话长什么样"来引用，
 * 整篇进提示词会把对话预算撑爆，而且政策原文里的表格、附件清单对回答没有增量。
 * 首尾加省略号是为了如实告诉读者"这里被截过"—— 别让模型把片段当成全文的边界。
 *
 * 无正文的篇目（portal / attachments / external-links）**不编内容**，
 * 返回一句说明：用户问"校历"时命中一篇图片页，正确的回答是"原文在此链接"，不是"没找到"。
 * 正文清洗后为空（整页都是图片，比如校历）也走这一条 —— 让模型别把空正文当成"没搜到"。
 */
export function buildSnippet(doc, query, snippetChars = 240) {
  const size = Math.max(20, Number(snippetChars) || 240);
  const half = Math.floor(size / 2);
  const text = String(doc?.text ?? '');
  // 清洗后为空 = 这篇的正文不在文字里（图片 / 附件），如实说明，不要返回空串装"没找到"
  if (!text.trim()) return NO_TEXT_NOTE;
  const terms = Array.isArray(query?.terms) ? query.terms : [];
  const hits = findMatches(text, terms);
  if (!hits.length) {
    // 只有标题命中：给正文开头，"这篇大概讲什么"仍然有用
    const head = text.slice(0, size);
    return text.length > size ? `${head}${ELLIPSIS}` : head;
  }
  const first = pickBestHit(hits);
  const start = Math.max(0, first.at - half);
  const end = Math.min(text.length, start + size);
  const body = text.slice(start, end).trim();
  return `${start > 0 ? ELLIPSIS : ''}${body}${end < text.length ? ELLIPSIS : ''}`;
}

/**
 * 纯检索：对一组文档打分、排序、抽片段。**不读盘**，所以测试可以直接喂人工语料。
 *
 * 排序：分数降序 → 标题命中多者优先 → 短的优先（同分时更"专注"的那篇）→ path 升序（保证确定性）。
 *
 * @param {Array<{title:string, text?:string, kind?:string, path?:string, chars?:number, rawText?:string, offsetBase?:number}>} docs
 * @param {string|{terms:Array}} query 查询串或 `expandQuery()` 的结果
 * @param {{limit?:number, snippetChars?:number}} [options]
 * @returns {{ count:number, items:Array<object> }} items 原样带上 doc 的其它字段
 */
export function searchDocuments(docs, query, { limit = 5, snippetChars = 240 } = {}) {
  const expanded = typeof query === 'string' ? expandQuery(query) : query;
  const size = Math.max(1, Number(limit) || 5);
  if (!expanded?.terms?.length) return { count: 0, items: [] };

  const scored = [];
  for (const doc of docs ?? []) {
    const text = String(doc?.text ?? '');
    const kind = doc?.kind ?? 'document';
    const result = scoreDocument({ ...doc, text }, expanded);
    // 正文为空（图片 / 附件页）时只有标题能命中；仅凭正文命中的篇目才算数
    if (!result.titleHits && !result.bodyHits) continue;
    const hit = findFirstMatch(text, expanded);
    /**
     * `offset` 是**命中位置在原文里的字符偏移**，模型可以拿它直接 `read({ offset })`。
     *
     * 片段给的是"命中处长什么样"，offset 给的是"这句话在第几个字"——两者缺一不可：
     * 只有片段时模型知道条款存在却不知道它在全文的哪里，只好整篇 read 碰运气；
     * 而长文的关键条款常常在第 4000 字之后，整篇 read 的前 4000 字根本读不到。
     *
     * 清洗文本与原文的坐标不同（见 `rawOffsetFor`），`offsetBase` 是"按小节检索"时的节首偏移。
     */
    const mapped = hit ? rawOffsetFor(doc.rawText ?? text, text, hit.at, hit.term.value) : 0;
    const offset = Math.max(0, Number(doc.offsetBase) || 0) + mapped;
    scored.push({
      ...doc,
      kind,
      score: result.score,
      titleHits: result.titleHits,
      bodyHits: result.bodyHits,
      // 长度归一的输入是**可见正文**长度（§14.4）；图片页算 0（没有正文），
      // 于是"标题命中但没有正文"自然排在前面 —— 正是"问校历要能找到那一篇"想要的效果
      chars: text.length || Number(doc?.chars) || 0,
      snippet: buildSnippet({ ...doc, text, kind }, expanded, snippetChars),
      matches: findMatches(`${doc?.title ?? ''}\n${text}`, expanded.terms)
        .map((hit) => hit.term.value)
        // 同一个字符串可能在标题和正文各命中一次：去重并保持已排好的权重顺序
        .filter((value, index, all) => all.indexOf(value) === index),
      offset,
      ...(hit ? { matchOffset: offset } : {}),
    });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.titleHits - a.titleHits ||
      a.chars - b.chars ||
      String(a.path ?? '').localeCompare(String(b.path ?? '')),
  );

  const items = scored.slice(0, size).map(({ titleHits, bodyHits, ...item }) => item);
  return { count: items.length, items };
}
