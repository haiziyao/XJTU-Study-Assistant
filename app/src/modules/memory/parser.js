/**
 * 本地规则解析器：把「记住 我不喜欢早上排任务」这类话直接变成 `target: "memory"` 的草稿
 * （§10.9 的「指令」一栏：`registerHandler('memory')` + 中文规则「记住 …」）。
 *
 * 两条刻意的取舍：
 *
 * 1. **只认显式的记忆措辞**（记住 / 记一下 / 以后都 / 别再 …）。不认「我周三下午不方便」
 *    这种陈述句 —— 让规则去猜"这句是不是在描述我自己"，猜错的代价是把一句普通的抱怨
 *    变成一条终身生效的偏好（§10.6）。那种推断是模型提议（`/memories/propose`）的活，
 *    由用户点确认兜底。
 *
 * 2. **带确切时间位置的内容一律不接**（§10.1 第一条铁律）。「记住 明天下午三点开会」里
 *    有日期与时刻 —— 它该进日程，不该进记忆（同一条信息存两处，必然有一天不一致）。
 *    这里返回 `ok: false`，`tryParse` 会继续问下一个解析器（日历那个兜底解析器），
 *    于是这句话仍然会变成一张日程草稿。
 */

import { hasExplicitTime, parseDateExpr } from '../../core/commands/nlp-rules.js';
import { KIND_LABEL } from './service.js';

/** 显式记忆措辞：出现在句首（允许"帮我/请/麻烦"这类前缀）。 */
const TRIGGER_RE = /^\s*(?:帮我|请|麻烦|给我)?\s*(?:记住|记一下|记下|记录一下|帮我记|以后都|以后|从此|今后|别再|不要再)\s*[，,、:：]?\s*/;

/** `kind` 的规则推断（§10.2 的语义边界：选错会让注入顺序和界面分组一起错）。 */
function kindOf(text) {
  if (/(别再|不要再|不能|不可以|不方便|没空|没时间|避免|禁止)/.test(text)) return 'constraint';
  if (/(习惯|喜欢|偏好|讨厌|不喜欢|效率|最好|宁愿)/.test(text)) return 'preference';
  if (/(决定|定了|以后不|取消|不再)/.test(text)) return 'decision';
  if (/(上次|那次|曾经|之前有过|上回)/.test(text)) return 'episodic';
  return 'fact';
}

export class MemoryParser {
  /** @param {string} text 用户原话 */
  parse(text) {
    const raw = String(text ?? '').trim();
    const match = raw.match(TRIGGER_RE);
    if (!match) return { ok: false, raw, warnings: ['不是记忆指令（缺少「记住…」这类措辞）'] };

    const payload = raw.slice(match[0].length).trim().replace(/^[「"'“]|[」"'”]$/g, '').trim();
    if (!payload) return { ok: false, raw, warnings: ['要记住什么？请把内容说完整'] };

    // 有确切时间位置 → 交给日历三域（事件/日程/待办）
    if (parseDateExpr(payload) || hasExplicitTime(payload)) {
      return {
        ok: false,
        raw,
        warnings: ['提到具体日期或时刻的内容应该进日程/待办，不是长期记忆'],
      };
    }

    const kind = kindOf(payload);
    return {
      ok: true,
      raw,
      action: 'create',
      target: 'memory',
      fields: {
        scope: 'global',
        kind,
        // key 留空：从中文里猜 snake_case 键，猜错了就会在之后每次写入时覆盖错的那条。
        // 稳定的 key 由模型提议时给出（§10.3），本地规则只按正文去重。
        key: null,
        text: payload,
        // 用户明说「记住」→ source: user（§10.5 的显式写入路径），不需要再点确认才可信
        source: 'user',
        sourceRef: null,
      },
      // 0.95：高于日历兜底解析器的 0.82~0.92，否则"记住…"会被它当成一条待办抢走
      confidence: 0.95,
      warnings: payload.length > 60 ? ['这句话有点长（60 字以内最合适），确认一下要不要精简'] : [],
      explain: `记住这条${KIND_LABEL[kind] ?? '事实'}：${payload}`,
      provider: 'rules',
    };
  }
}
