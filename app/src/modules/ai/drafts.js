/**
 * 从模型回复里抽「指令草稿」，并**用 dryRun 预校验**。
 *
 * 为什么不让模型直接写库：
 *   - 模型会编字段（`allDay`、`status`、中文分类名），会被接口 400 拒绝；
 *   - 更糟的是它**编得刚好合法**，于是脏数据进了库，而用户以为只是聊了句天。
 * 所以模型只能"提议"：这里抽出草稿 → `commands.execute(draft, { dryRun: true })` 走一遍
 * **真实的校验与业务语义**（不写库、不广播、不记指令日志）→ 把预览连同错误一起交给前端确认卡。
 *
 * 用户点确认后，前端照旧 `POST /commands/execute`（就是本地规则走的那条路），
 * 因此「模型加的」和「规则加的」在落库时没有任何区别，审计与广播也不会漏。
 */

import { HttpError } from '../../core/http/router.js';

/** 认这三种围栏：```command / ```json / ```指令。 */
const FENCE_RE = /```(?:command|json|指令|javascript)\s*\n?([\s\S]*?)```/g;

/** 一个看起来很像我方草稿的对象。 */
function looksLikeDraft(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && value.target && value.action);
}

function collect(value, out) {
  if (looksLikeDraft(value)) {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, out);
    return;
  }
  if (value && typeof value === 'object' && Array.isArray(value.drafts)) {
    for (const item of value.drafts) collect(item, out);
  }
}

/**
 * 把回复拆成「给用户看的文本」+「草稿数组」。
 * 抽不出草稿时原样返回文本（模型纯聊天也走这条路）。
 */
export function extractDrafts(reply) {
  const source = String(reply ?? '');
  const drafts = [];
  const stripped = source.replace(FENCE_RE, (whole, body) => {
    try {
      const parsed = JSON.parse(body.trim());
      const found = [];
      collect(parsed, found);
      if (!found.length) return whole; // 不是草稿（比如一段代码示例），保留给用户看
      drafts.push(...found);
      return '';
    } catch {
      return whole;
    }
  });

  // 有些模型不加围栏，直接把整个回复写成一个 JSON 对象
  if (!drafts.length) {
    const trimmed = source.trim();
    if (trimmed.startsWith('{')) {
      try {
        const found = [];
        collect(JSON.parse(trimmed), found);
        if (found.length) return { text: '', drafts: found, raw: source };
      } catch {
        /* 当作普通文本 */
      }
    }
  }

  return { text: stripped.replace(/\n{3,}/g, '\n\n').trim(), drafts, raw: source };
}

/** 补齐模型常漏的 `ok`，其余一律不动（校验交给真实服务）。 */
function normalizeDraft(draft) {
  return { ...draft, ok: draft.ok === undefined ? true : draft.ok };
}

/**
 * 查询类草稿的兜底：把误写在 `fields` 里的条件搬到 `filters`。
 *
 * 实测模型会把日期写成 `fields: { date }`，而查询处理器只读 `draft.filters` ——
 * 结果不是"查不到"，而是**没加条件地查了整个库**（更危险：答案看着像真的）。
 * 这里做一次最小归一，不改变调用方看到的内容。
 */
function normalizeQueryFilters(draft) {
  if (draft.action !== 'query') return draft;
  const filters = { ...(draft.filters ?? {}) };
  const fields = draft.fields ?? {};
  if (!filters.from && !filters.to && fields.date) {
    filters.from = fields.date;
    filters.to = filters.date ?? fields.date;
  }
  if (!filters.from && fields.from) filters.from = fields.from;
  if (!filters.to && fields.to) filters.to = fields.to;
  if (!filters.keyword && fields.keyword) filters.keyword = fields.keyword;
  return { ...draft, filters };
}

/**
 * 逐条预校验：成功给 `preview`（dryRun 的返回），失败给 `error`。
 * 单条失败不影响其它草稿，也不影响这次聊天本身。
 */
export async function previewDrafts(commands, drafts = []) {
  const results = [];
  for (const draft of drafts) {
    const normalized = normalizeQueryFilters(normalizeDraft(draft));
    try {
      if (normalized.ok === false) {
        results.push({ draft: normalized, preview: null, error: { code: 'PARSE_FAILED', message: normalized.warnings?.[0] ?? '模型表示无法确定' } });
        continue;
      }
      const preview = await commands.execute(normalized, { dryRun: true });
      results.push({ draft: normalized, preview, error: null });
    } catch (error) {
      results.push({
        draft: normalized,
        preview: null,
        error: {
          code: error instanceof HttpError ? error.code : 'INTERNAL',
          message: error.message,
          ...(error instanceof HttpError && error.details ? { details: error.details } : {}),
        },
      });
    }
  }
  return results;
}
