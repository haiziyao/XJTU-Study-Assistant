/**
 * 从笔记正文里**规则化**抽取卡片候选（不调模型）。
 *
 * 为什么不调模型（这是刻意的取舍，不是省事）：
 * - 生成卡片是**幂等**操作（同一篇笔记重复生成不许产生重复卡），而模型的输出天然不稳定：
 *   同一段文字两次调用会给出措辞不同的正反面，去重键立刻失效；
 * - 抽查成本：模型生成的卡片用户必须逐张核对才敢用，规则生成的至少能预测它从哪来
 *   （每条候选都带 `rule`，界面上能显示"来自标题/冒号行/列表项"）；
 * - 离线可用、零费用、可测试。真需要"提炼"的时候，入口是模型经用户确认后**逐张**提议
 *   （`source: "ai"`），而不是让它在后台批量生成一堆没人看的卡。
 *
 * 三条规则（对应笔记里本来就存在的三种"成对"结构）：
 *
 * 1. `heading`  —— `## 标题` + 紧随其后的**第一个内容块**（空行即止）。
 *    课堂笔记的骨架就是它，标题天然是一个"话题"，紧接的那段就是对它的解释。
 *    **刻意不收"整节"**（到下一个标题为止）：笔记里最后一个标题会把后面所有小节、
 *    甚至 `- [ ] 复习第三章` 这类复选框一起吞进一张卡的答案里 —— 答案长到两屏时
 *    用户只会跳过这张卡；不如让后续小节各自成卡。
 * 2. `colon` / `question` —— 以冒号或问号结尾的行 + 下一行（或紧随的一段列表）。
 *    「熵：混乱度的度量」「为什么会有熵增？」正是最标准的问答对。
 * 3. `list` —— Markdown 列表项 + 其子项；列表项内部是「术语：解释」时按它拆。
 *    例题步骤、要点清单都以这种形式存在。
 *
 * 不生成卡片的几种情况（都能解释"为什么这篇笔记只出了 3 张卡"）：
 * - 空标题、裸列表项（没有子项也没有解释）：它们本来就不是成对的知识；
 * - 复选框行（`- [ ] 复习第四章`）：那是待办，归日历模块；
 * - 正反面没有实义（纯符号/纯数字）或过长（超过 model.js 的上限）：与其静默截断，
 *   不如让它进 `ignored` 计数，让用户知道"有内容没能自动成卡"。
 */

import { MAX_BACK_CHARS, MAX_FRONT_CHARS } from './model.js';

/**
 * 长度门槛。**刻意取得很低**：中文里一个词常常只有一个字，`## 熵` 抽出来的正面就是
 * 「熵」—— 那是最标准的一张卡。实测过：把门槛写成"≥3 个字符"会让「熵」「导数」
 * 这类笔记标题一张卡都出不来，而这恰恰是笔记里最多的写法。
 * 真正挡住符号碎片的是下面的 `isSubstantive()`，不是长度。
 */
export const MIN_FRONT_CHARS = 1;
export const MIN_BACK_CHARS = 2;

/**
 * 有没有"实义内容"：必须含汉字或字母。
 *
 * 纯符号/纯数字（`-`、`1.`、`√`、`[x]`）不是能被问出来的知识，
 * 而 `5S`、`pH`、`熵` 必须留下。
 */
function isSubstantive(text) {
  return /[\p{Script=Han}\p{L}]/u.test(text);
}

/** 抽取规则名：回执里会带上，便于回答"这张卡是从哪来的"。 */
export const EXTRACT_RULES = Object.freeze(['heading', 'colon', 'question', 'list']);

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*$/;
const LIST_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const TASK_RE = /^\[[ xX]\]/;
const COLON_END_RE = /[:：]\s*$/;
const QUESTION_END_RE = /[?？]\s*$/;
/** 行首行尾的装饰：加粗星号、行内代码反引号、各种引号 —— 它们不该进卡片正面。 */
const EDGE_NOISE_RE = /^[\s*_`「『"'“”]+|[\s*_`」』"'“”]+$/g;

function toHalfWidth(text) {
  return String(text)
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

/**
 * 去重键：全角转半角 + 折叠空白 + 小写。
 *
 * **故意不去标点**：`什么是熵？` 与 `什么是熵` 是两种提问方式，合并它们会让用户
 * 想改一下问法都不可能（新卡会被当成旧的跳过）。而同一篇笔记重复生成时，
 * 抽出来的字符串逐字相同，折叠空白就够了 —— 幂等性靠这个键成立。
 */
export function normalizeFront(text) {
  return toHalfWidth(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 正面清洗：去掉装饰符与结尾冒号（「熵：」的正面是「熵」）。 */
function frontOf(raw) {
  let text = String(raw ?? '').trim();
  text = text.replace(EDGE_NOISE_RE, '');
  text = text.replace(COLON_END_RE, '');
  text = text.replace(EDGE_NOISE_RE, '');
  return text.replace(/\s+/g, ' ').trim();
}

/** 背面清洗：保留换行（要点列表要一行一条），只去掉首尾空行。 */
function backOf(raw) {
  return String(raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
    .trim();
}

/** 「术语：解释」拆成一对；不是这个形状就返回 null。 */
function splitPair(text) {
  const match = String(text).match(/^(.+?)[：:]\s*(.*)$/);
  if (!match) return null;
  const front = frontOf(match[1]);
  const back = backOf(match[2]);
  if (!front) return null;
  return { front, back };
}

/** 第 i 行之后第一个非空行的下标；没有则 -1。 */
function nextContentIndex(lines, from) {
  for (let i = from; i < lines.length; i += 1) if (lines[i].trim()) return i;
  return -1;
}

/**
 * 抽一张笔记里的全部卡片候选。
 *
 * @param {{ body?: string }} note 归一化后的笔记（`NoteService.get()` 的返回值）
 * @returns {{ candidates: Array<{front: string, back: string, rule: string}>, ignored: number }}
 *          `candidates` 已按正面去重；`ignored` 是不合格（过短/过长）的候选数 ——
 *          单独计数是为了让用户看得见"笔记里有 N 段内容没能自动成卡"。
 */
export function extractCandidates(note) {
  const lines = String(note?.body ?? '').split(/\r?\n/);
  const candidates = [];
  let ignored = 0;

  const push = (front, back, rule) => {
    const cleanFront = frontOf(front);
    const cleanBack = backOf(back);
    // 空的（例如标题下面没有内容）直接不计：那不是"没能成卡的内容"，而是本来就没有内容
    if (!cleanFront || !cleanBack) return;
    if (
      cleanFront.length < MIN_FRONT_CHARS ||
      cleanBack.length < MIN_BACK_CHARS ||
      !isSubstantive(cleanFront) ||
      !isSubstantive(cleanBack)
    ) {
      ignored += 1;
      return;
    }
    if (cleanFront.length > MAX_FRONT_CHARS || cleanBack.length > MAX_BACK_CHARS) {
      ignored += 1;
      return;
    }
    candidates.push({ front: cleanFront, back: cleanBack, rule });
  };

  // ---- 规则 1：标题 + 紧随的**第一个内容块**（跳过标题后的空行，遇到空行结束）
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(HEADING_RE);
    if (!match) continue;
    const content = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (HEADING_RE.test(line)) break;
      // 空行 = 这一段内容结束（见文件头的取舍：不收"整节"）
      if (!line.trim()) {
        if (content.length) break;
        continue;
      }
      content.push(line);
    }
    push(match[2], content.join('\n'), 'heading');
  }

  // ---- 规则 2：以冒号 / 问号结尾的行 + 下一行（或下一段列表）
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || HEADING_RE.test(lines[i]) || LIST_RE.test(lines[i])) continue;
    const isColon = COLON_END_RE.test(line);
    if (!isColon && !QUESTION_END_RE.test(line)) continue;
    const at = nextContentIndex(lines, i + 1);
    if (at < 0) continue;
    const nextLine = lines[at];
    // 下一行是标题时交给规则 1：那种写法里"答案"是整节内容，不是标题这一行
    if (HEADING_RE.test(nextLine)) continue;
    if (LIST_RE.test(nextLine)) {
      const block = [];
      for (let j = at; j < lines.length; j += 1) {
        const item = lines[j];
        if (!item.trim()) break;
        if (HEADING_RE.test(item)) break;
        const sub = item.match(LIST_RE);
        block.push(sub ? sub[2].trim() : item.trim());
      }
      push(line, block.join('\n'), isColon ? 'colon' : 'question');
      continue;
    }
    push(line, nextLine, isColon ? 'colon' : 'question');
  }

  // ---- 规则 3：列表项 + 其子项（含「术语：解释」的内联写法）
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(LIST_RE);
    if (!match) continue;
    const indent = match[1].length;
    const text = match[2].trim();
    if (TASK_RE.test(text)) continue;

    const children = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      // 空行视为这一项结束：笔记里的子项都紧跟在下面，跨空行收子项会把它和下一节混在一起
      if (!line.trim()) break;
      if (HEADING_RE.test(line)) break;
      const childIndent = line.match(/^\s*/)[0].length;
      if (childIndent <= indent) break;
      const childList = line.match(LIST_RE);
      children.push(childList ? childList[2].trim() : line.trim());
    }

    const pair = splitPair(text);
    if (pair) {
      push(pair.front, [pair.back, ...children].filter(Boolean).join('\n'), 'list');
      continue;
    }
    // 裸条目（既没有冒号解释也没有子项）不是成对的知识，跳过且不计入 ignored
    if (children.length) push(text, children.join('\n'), 'list');
  }

  // 同一篇笔记里正面重复（标题「熵」+ 冒号行「熵：」）只留一条，先出现的规则胜
  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    const key = normalizeFront(candidate.front);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return { candidates: unique, ignored };
}
