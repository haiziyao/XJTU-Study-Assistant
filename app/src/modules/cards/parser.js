/**
 * 本地规则解析器：把「加一张卡片：光合作用的产物是什么？氧气和葡萄糖」这类话
 * 直接变成 `target: "card"` 的草稿（用户从输入框就能建卡，不必先开界面）。
 *
 * 两条刻意的取舍：
 *
 * 1. **只认显式的卡片措辞**（加 / 添加 / 新建 / 创建 / 做 / 记 / 来 + 「卡片」）。
 *    不认「光合作用是什么」这种普通提问 —— 让规则去猜"这句是不是想要一张卡"，
 *    猜错的代价是用户随口一问就在库里多出一张没人管的卡。
 *
 * 2. **信息不全时返回 `ok: true` + 警告，而不是 `ok: false`**（与 memory 解析器相反）。
 *    原因在 `CommandService.tryParse`：所有解析器都 `ok: false` 时会退回日历的兜底解析器，
 *    于是「加一张卡片：熵」会变成一条待办「加一张卡片：熵」—— 那比直接告诉用户
 *    "这张卡还缺答案"糟糕得多。触发词已经足够明确，所以这里承担"说清楚缺什么"的责任，
 *    真正不合法（正面为空、超长）时由服务层返回 400。
 */

/**
 * 触发词 + 可选的分隔冒号。
 * `张?` 让「加卡片」也能命中；`(?:复习|记忆|知识)?` 覆盖「加一张复习卡片」。
 */
const CREATE_RE =
  /^\s*(?:帮我|请|麻烦|给我)?\s*(?:加|添加|新建|创建|做|记|来)\s*(?:一|1)?\s*张?\s*(?:复习|记忆|知识)?\s*卡(?:片)?\s*[:：,，、]?\s*/;

/** 强分隔符：出现即分界（正面想带问号时用 `|`）。 */
const STRONG_SPLIT_RE = /\s*(?:\||｜|::)\s*/;

/**
 * 弱分隔符：箭头。
 *
 * 它**排在问号之后**：箭头在知识内容里太常见了（「根 → 左 → 右」就是一个答案），
 * 拿它当第一优先级会把「…遍历顺序是什么？根 → 左 → 右」切成
 * 「…是什么？根」+「左 右」—— 正面莫名其妙、答案还缺了一半（实测踩过）。
 * 只有整句里没有问号时才用它，并且重建时把箭头加回去。
 */
const ARROW_SPLIT_RE = /\s*(?:→|->|=>)\s*/;

/** 查询意图：问句形态各异，但都在问"我现在该复习什么"。 */
const QUERY_PATTERNS = [
  {
    re: /复习\s*(?:什么|啥|哪些|哪几张|哪几卡|计划|安排)/,
    filters: { due: true, limit: 10 },
    explain: '查一下现在到期的卡片。',
  },
  {
    re: /(?:有哪些|有什么|有几张|多少张)\s*卡(?:片)?\s*(?:到期|要复习|该复习|需要复习)/,
    filters: { due: true, limit: 10 },
    explain: '查一下现在到期的卡片。',
  },
  {
    re: /卡(?:片)?\s*(?:到期|要复习|该复习)/,
    filters: { due: true, limit: 10 },
    explain: '查一下现在到期的卡片。',
  },
  {
    re: /(?:查看|看看|列出|显示|有哪些)\s*(?:我的|全部|所有)?\s*(?:复习|记忆)?\s*卡(?:片)?/,
    filters: { limit: 10 },
    explain: '列出最近的卡片。',
  },
];

/** `#标签` → tags，并从正文里摘掉（与日历模块的 `#实验` 同一套写法）。 */
function extractTags(text) {
  const tags = [];
  const rest = text.replace(/(?:^|\s)#([^\s#]+)/g, (_, tag) => {
    tags.push(tag.trim());
    return ' ';
  });
  return { tags: [...new Set(tags)].slice(0, 24), rest: rest.replace(/\s+/g, ' ').trim() };
}

/**
 * 拆正反面。优先级：强分隔符 → 第一个问号 → 箭头。
 *
 * 问号排在箭头前面、且让正面**保留**这个问号：「什么是熵？」比「什么是熵」更像
 * 用户自己写的话，也更好读；而答案里的箭头（「根 → 左 → 右」）不会被误当分界。
 */
function splitFrontBack(content) {
  const strong = content.split(STRONG_SPLIT_RE);
  if (strong.length >= 2) {
    return { front: strong[0].trim(), back: strong.slice(1).join(' ').trim() };
  }
  const at = content.search(/[?？]/);
  if (at >= 0) return { front: content.slice(0, at + 1).trim(), back: content.slice(at + 1).trim() };
  const arrow = content.split(ARROW_SPLIT_RE);
  if (arrow.length >= 2) {
    return { front: arrow[0].trim(), back: arrow.slice(1).join(' → ').trim() };
  }
  return { front: content.trim(), back: '' };
}

export class CardParser {
  /**
   * @param {string} text 用户原话
   * @returns {object} 指令对象（`target: "card"`），或 `{ ok: false }`（交给下一个解析器）
   */
  parse(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return { ok: false, raw, warnings: ['空指令'] };

    const create = raw.match(CREATE_RE);
    if (create) {
      const { tags, rest } = extractTags(raw.slice(create[0].length).replace(/^[「"'“]|[」"'”]$/g, '').trim());
      const { front, back } = splitFrontBack(rest);

      const warnings = [];
      if (!front && !back) {
        warnings.push('要加一张卡片的话，把正面和答案一起给我（例：加一张卡片：光合作用的产物是什么？氧气和葡萄糖）');
      } else if (!back) {
        warnings.push('这张卡还缺答案：用「？」或「|」把问题和答案分开（例：加一张卡片：熵是什么？混乱度的度量）');
      }
      if (front.length > 200) warnings.push('正面有点长（超过 200 字），建议拆成几张卡：一张卡只问一个知识点');

      return {
        ok: true,
        raw,
        action: 'create',
        target: 'card',
        fields: {
          front,
          back,
          tags,
          // 用户自己从输入框敲的 → source: manual（不是模型生成的）
          source: 'manual',
        },
        // 0.95：高于日历兜底解析器的 0.82~0.92，否则"加一张卡片…"会被它当成一条待办抢走
        confidence: 0.95,
        warnings,
        explain: front ? `加一张卡片：${front}` : '加一张卡片（信息还不全）',
        provider: 'rules',
      };
    }

    for (const pattern of QUERY_PATTERNS) {
      if (!pattern.re.test(raw)) continue;
      return {
        ok: true,
        raw,
        action: 'query',
        target: 'card',
        filters: { ...pattern.filters },
        // 0.93：**必须高于日历兜底解析器的 0.9**。实测：「今天要复习哪些卡片」会被日历
        // 解析成一条待办「复习哪些卡片」（置信度 0.9），而 tryParse 在平分时取先注册的
        // （日历 order=10 先注册），所以 0.9 在这里等于输。0.93 既压过兜底，又低于
        // 显式的「加卡片」（0.95）—— 两条都足够具体，不会抢走普通句子
        confidence: 0.93,
        warnings: [],
        explain: pattern.explain,
        provider: 'rules',
      };
    }

    return { ok: false, raw, warnings: ['不是卡片指令（既没有「加…卡片」，也没有问「复习什么」）'] };
  }
}
