/**
 * 卡片的**字段口径**：长度上限、枚举、写入校验、读出归一化。
 *
 * 为什么单独一层（而不是像 memory 那样把校验写在 service.js 里）：
 * 抽取器（extract.js）也要用同一套长度口径来判定"这条候选值不值得做成卡片"，
 * 而 service.js 已经 import 了 extract.js —— 口径写在 service 里会形成循环依赖，
 * 抄两份又迟早会漂移（一处改了 500、另一处还是 300，于是"生成时能建、手工建不了"）。
 * 这里没有任何业务逻辑，只有"一个字段长什么样"。
 *
 * 字段与理由
 * ----------
 * - `front` 正面/问题：≤500 字。卡片的价值在于"能问出来"，超过 500 字的问题
 *   已经不是问题而是一段材料，用户复习时会跳过它。
 * - `back` 答案：≤2000 字。比正面宽松，因为答案需要自足（含公式、要点列表），
 *   但也不能无限 —— 一页纸的答案说明这张卡该拆成几张。
 * - `noteId` 来自哪条笔记：只做格式校验，**不校验存在性**。笔记被删掉之后，
 *   用户已经复习过这些卡片的记录不该跟着消失；反过来，卡片引用一条不存在的笔记
 *   只是少了个"回到出处"的入口，不构成数据错误。
 * - `course` 课程：可空。它决定界面上的分组与"这门课今天有多少张卡"，
 *   值来自笔记的 `properties.course`，所以长度限制与笔记模块保持一致的口径（≤120）。
 * - `tags[]`：≤24 个、每个 ≤40 字，与笔记模块的 `uniqueText(value, 24)` 同口径，
 *   这样"从笔记生成"时标签可以原样带过来而不被截断。
 * - `source`：`note`（从笔记生成）/ `manual`（用户手输）/ `ai`（模型经用户确认后落库）。
 *   它决定"这张卡从哪来的"，用于排查"是不是模型生成的垃圾卡"。
 * - 调度字段（due/intervalDays/ease/reps/lapses/lastReviewedAt/lastGrade）**不在这里校验**：
 *   它们只能由 scheduler.js 算出来，接口层根本不接受客户端传入（见 validate 的返回值）。
 */

import { HttpError } from '../../core/http/router.js';
import { DEFAULT_EASE, clampEase } from './scheduler.js';

export const MAX_FRONT_CHARS = 500;
export const MAX_BACK_CHARS = 2000;
export const MAX_COURSE_CHARS = 120;
export const MAX_NOTE_ID_CHARS = 200;
export const MAX_TAGS = 24;
export const MAX_TAG_CHARS = 40;

/** 卡片来源：三种写法都对应一条真实路径，没有"其它"。 */
export const CARD_SOURCES = Object.freeze(['note', 'manual', 'ai']);

const fail = (field, message, extra) => {
  throw HttpError.badRequest(`字段 ${field} 不合法：${message}`, { field, ...extra });
};

/** 必填文本：先 trim 再量长度 —— 与字数统计口径一致，也避免"全是空格"混过去。 */
export function requiredText(value, { field, max }) {
  if (typeof value !== 'string' || !value.trim()) fail(field, '必填且不能为空');
  const text = value.trim();
  if (text.length > max) fail(field, `长度不能超过 ${max} 字（收到 ${text.length}）`);
  return text;
}

/** 可选文本：`''` / `null` 一律当"没填"（存成 null），避免空串在分组统计里变成一类。 */
export function optionalText(value, { field, max, fallback = null }) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') fail(field, '必须是字符串');
  const text = value.trim();
  if (!text) return fallback;
  if (text.length > max) fail(field, `长度不能超过 ${max} 字（收到 ${text.length}）`);
  return text;
}

/** 标签：去重（同一门课的标签常常重复写）、逐个限量、整体限量。 */
export function optionalTags(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail('tags', '必须是字符串数组');
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string') fail('tags', '每一项都必须是字符串');
    const tag = raw.trim();
    if (!tag) continue;
    if (tag.length > MAX_TAG_CHARS) fail('tags', `单个标签不能超过 ${MAX_TAG_CHARS} 字（收到 ${tag.length}）`);
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** 暂停：只认显式布尔与 `1/0`、`true/false` 这类写法，`'false'` 不能被当成真。 */
export function parseBool(value, { fallback = false } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

/**
 * 校验并归一化**可写字段**（不落库）。
 *
 * 独立出来的两个用途：指令处理器的 `dryRun` 要能只校验（用户点确认前就报错），
 * 生成器要能在建卡前拿到同一份归一化结果。返回值里**只有**这七个字段 ——
 * 调度状态（due / intervalDays / …）故意不在其中：它们只由 `computeNext()` 产出，
 * 否则"手工把 due 改成 2099 年"就能让一张卡永远消失，而界面看不出来。
 */
export function validateCardFields(input = {}, { defaultSource = 'manual' } = {}) {
  const source = input.source === undefined || input.source === null || input.source === '' ? defaultSource : input.source;
  if (!CARD_SOURCES.includes(source)) fail('source', `取值必须是 ${CARD_SOURCES.join(' / ')} 之一`);
  return {
    front: requiredText(input.front, { field: 'front', max: MAX_FRONT_CHARS }),
    back: requiredText(input.back, { field: 'back', max: MAX_BACK_CHARS }),
    noteId: optionalText(input.noteId, { field: 'noteId', max: MAX_NOTE_ID_CHARS }),
    course: optionalText(input.course, { field: 'course', max: MAX_COURSE_CHARS }),
    tags: optionalTags(input.tags),
    source,
    suspended: parseBool(input.suspended, { fallback: false }),
  };
}

/**
 * 读出时的归一化：手工改过 `data/cards.json`、或旧版本缺字段时，界面拿到的东西仍然是完整的。
 *
 * 注意它**不回写**存储 —— 归一化是投影，不是修复。真正的修复时机是下一次写入
 * （`update` 会带上被补齐的调度字段，见 service.js）。这样读取路径保持零 IO。
 */
export function normalizeCard(record) {
  const card = record ?? {};
  const createdAt = typeof card.createdAt === 'string' ? card.createdAt : new Date(0).toISOString();
  return {
    id: String(card.id ?? ''),
    front: String(card.front ?? ''),
    back: String(card.back ?? ''),
    noteId: card.noteId ?? null,
    course: card.course ?? null,
    tags: Array.isArray(card.tags) ? [...card.tags] : [],
    source: CARD_SOURCES.includes(card.source) ? card.source : 'manual',
    // due 缺失时回落到 createdAt：一张手工塞进文件、没有排期的卡会立刻进入队列，
    // 这比"永远不到期、用户以为数据丢了"要好
    due: typeof card.due === 'string' && !Number.isNaN(Date.parse(card.due)) ? card.due : createdAt,
    intervalDays: Math.max(0, Math.floor(Number(card.intervalDays) || 0)),
    ease: clampEase(card.ease ?? DEFAULT_EASE),
    reps: Math.max(0, Math.floor(Number(card.reps) || 0)),
    lapses: Math.max(0, Math.floor(Number(card.lapses) || 0)),
    lastReviewedAt: typeof card.lastReviewedAt === 'string' ? card.lastReviewedAt : null,
    lastGrade: card.lastGrade ?? null,
    suspended: Boolean(card.suspended),
    createdAt,
    updatedAt: typeof card.updatedAt === 'string' ? card.updatedAt : createdAt,
  };
}
