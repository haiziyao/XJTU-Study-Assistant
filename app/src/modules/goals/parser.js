/**
 * 本地规则解析器：把「我打算 12 月前考完六级」这类话变成 `target: "goal"` 的草稿。
 *
 * 为什么本地规则也值得写（模型明明能做到）：
 *   1. 用户没配 AI 时，输入框里的这句话仍然应该能落成一条目标 —— 退化成"看不懂"的功能
 *      等于没有功能；
 *   2. 规则的**边界很清楚**：只认显式的目标措辞 + 一个日期表达式。猜不到就返回 `ok: false`，
 *      让 `tryParse` 继续问下一个解析器（日历那个兜底解析器会把"明天交实验报告"接成待办）。
 *
 * 与记忆/待办的分工（写反了就会出现"同一件事两处不一致"）：
 *   - 有**确切日期与时刻**的安排 → 日程（`明天 15:00 开会`）；
 *   - 有**确切截止日**的一件事 → 待办（`明天交实验报告`）；
 *   - 一个**方向 + 一个较远的目标日** → 目标（本解析器）。
 * 所以这里刻意**不认**"明天/后天"这类近端日期：那是待办的地盘。
 *
 * 词序上做了兼容（实测后补的）：
 *   `我打算 12 月前考完六级` / `定个目标 考完六级 12月前` / `目标：期末前写完大作业`
 * 三种都能出草稿 —— 中文口语里日期在前在后都常见，只认一种会显得很笨。
 */

import { parseDateExpr } from '../../core/commands/nlp-rules.js';
import { addDays, isDateKey, todayKey } from '../../shared/time.js';

/**
 * 触发词：必须**显式表达"这是一件我要达成的事"**。
 *
 * 不认光秃秃的陈述句（"我想考六级"）—— 让规则去判断一句闲聊是不是目标，猜错的代价是
 * 用户的待办列表旁边凭空多出一条三年期的"目标"。那种推断是模型的活（由用户点确认兜底）。
 */
const TRIGGER_RE =
  /^\s*(?:帮我|请|麻烦|给我)?\s*(?:我的目标|定个目标|定一个目标|立个目标|立一个目标|设个目标|建个目标|新目标|长期目标|目标|我打算|我计划|我准备|我希望能|我希望|计划|打算|想要|要)\s*[：:，,、]?\s*/;

/** 近端日期词：出现这些就说明是"这两天要做的事"，属于待办/日程，不是目标。 */
const NEAR_DATE_RE = /(今天|今日|明天|明日|后天|大后天|下周|下个星期|本周|这周|这个星期|今晚|上午|下午|晚上|\d{1,2}\s*[:：]\s*\d{2})/;

/** 一年内的学期末近似日期：`期末` 这类说法没有确切日子，只能给一个**可改**的估计值。 */
const SEMESTER_END = { first: '01-15', second: '07-15' };

/** `N月` / `N月份`（不带日）。`parseDateExpr` 不认这种写法（它要求"X月Y日"）。 */
const MONTH_ONLY_RE = /(\d{1,2})\s*月(?:份)?/;
/** 年份前缀：「明年」+1、「今年」+0、「后年」+2。 */
const YEAR_PREFIX_RE = /(明年|今年|后年)/;
/**
 * 紧跟在日期短语后面的连接词：`12月31日之前考完` → 去掉"之前"才得到动作部分。
 *
 * 允许前面有空白（`12 月 前考完` 摘掉日期后剩 `" 前考完"`）—— 必须容忍这个空格，
 * 否则会剩下一个孤零零的"前"进到标题里。
 */
const TAIL_CONNECTOR_RE = /^\s*(?:之前要|以前要|之前|以前|前|底|末)\s*/;

/** `kind` 的规则推断。 */
function kindOf(text) {
  if (/(考试|测验|期末考|补考|重修|四六级|六级|四级|考研|初试|复试|雅思|托福|GRE|机考|笔试|面试|答辩)/i.test(text)) {
    return 'exam';
  }
  if (/(截止|提交|报名|交材料|交表|投稿|交稿|申请)/.test(text)) return 'deadline';
  return 'goal';
}

/** 某年某月的最后一天（`2026-02` → `2026-02-28`）。 */
function endOfMonth(year, month) {
  const lastDay = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

/**
 * 把目标日期短语解析成日期键。
 *
 * 优先复用框架的 `parseDateExpr`（"12月31日前""2026-12-15""下个月"…），
 * 只在它不认的三种写法上补：
 *   - **`N月前`**：`parseDateExpr` 要求"X月Y日"，而用户说的"12 月前"意思是**12 月底之前**；
 *   - **`明年N月`**：同上，但年份要 +1；
 *   - **`期末前` / `这学期结束前`**：没有确切日子，按今天的月份给一个**近似学期末**。
 *
 * @returns {{dateKey: string, matched: string, guess?: boolean, near?: boolean}|undefined}
 */
export function parseTargetDate(text, now = new Date()) {
  const today = todayKey(now);

  const direct = parseDateExpr(text, now);
  if (direct) {
    // "近端" = 落在未来一周内。`parseDateExpr` 也可能给出过去的日期（今年 3 月说"1月15日"），
    // 那属于"用户写错了"，不该被当成"这是待办" —— 所以只有**未来**的近端日期才算 near。
    const near = direct.dateKey >= today && direct.dateKey <= addDays(today, 7);
    return { dateKey: direct.dateKey, matched: direct.matched, datePhrase: direct.matched, near };
  }

  // 「期末」「这学期结束」：没有确切日子，按今天的月份给**最近一个还没到的学期末**。
  // 长写法排在前面：`这学期结束` 必须整体匹配，只吃"学期结束"会在标题里剩一个"这"
  const semester = text.match(/[这本]个?学期(?:结束|末)|学期结束|期末|放假前/);
  if (semester) {
    const year = Number(today.slice(0, 4));
    // 两个候选锚点：今年 1 月中的学期末、今年 7 月中的学期末（上半年该看后者）
    const anchors = [`${year}-${SEMESTER_END.first}`, `${year}-${SEMESTER_END.second}`, `${year + 1}-${SEMESTER_END.first}`];
    /**
     * 取"最近且还没到"的那个（严格晚于今天）。
     *
     * 不取"当月的那个"：1 月 5 日说"期末前"指的显然是**即将到来的**那个期末（7 月），
     * 而不是 10 天前刚过去的 1 月 15 日。也不取"顺延到下一年同一个"：
     * 那会给出一个 12 个月后的日期，比给近的那个更没用。
     */
    const key = anchors.find((anchor) => anchor > today) ?? `${year + 1}-${SEMESTER_END.second}`;
    return { dateKey: key, matched: semester[0], datePhrase: semester[0], guess: true };
  }

  const monthMatch = text.match(MONTH_ONLY_RE);
  if (monthMatch) {
    const month = Number(monthMatch[1]);
    if (month >= 1 && month <= 12) {
      const prefix = text.match(YEAR_PREFIX_RE)?.[1];
      const thisYear = Number(today.slice(0, 4));
      const year = thisYear + (prefix === '明年' ? 1 : prefix === '后年' ? 2 : 0);
      let key = endOfMonth(year, month);
      // 没写年份且那个月已经过去（今天 12 月 20 日说"12 月前"）→ 顺势理解成明年那个月，
      // 而不是生成一个已经逾期的目标。显式写了"今年"的照旧（用户明确要今年）。
      if (!prefix && key < today) key = endOfMonth(year + 1, month);
      // `datePhrase` 带上年份前缀（"明年6月"），否则标题里会剩一个孤零零的"明年"
      return { dateKey: key, matched: monthMatch[0], datePhrase: prefix ? `${prefix}${monthMatch[0]}` : monthMatch[0], guess: true };
    }
  }

  // 「明年」「后年」这类只有年份的写法：给年末
  const yearWord = text.match(YEAR_PREFIX_RE)?.[1];
  if (yearWord) {
    const year = Number(today.slice(0, 4)) + (yearWord === '明年' ? 1 : yearWord === '后年' ? 2 : 0);
    return { dateKey: `${year}-12-31`, matched: yearWord, datePhrase: yearWord, guess: true };
  }

  return undefined;
}

/**
 * 去掉日期短语后剩下的标题。
 *
 * 三步都要按顺序做（实测踩过两个坑）：
 *   1. 先摘掉**整个日期短语**（含"明年"这类前缀），否则 `我计划明年6月前考过雅思`
 *      会剩一个"明年"留在标题里；
 *   2. 摘掉紧随其后的连接词（"前 / 之前 / 底 / 末"）—— `12月31日之前提交论文`
 *      里的"之前"虽然没改语义，留在标题开头读起来很奇怪。**标点归一化前后各做一次**：
 *      摘掉日期短语后可能剩下一个孤零零的"前"，它前面没有空格，只有归一化之后再匹配才吃得到；
 *   3. 最后统一空白与标点（`我打算 12 月前考完六级` 里的空格与全角标点）。
 */
function titleOf(payload, datePhrase) {
  return payload
    // 只替换一次：`replace(str, ' ')` 的非正则形式正好满足（短语里可能含正则元字符）
    .replace(datePhrase, ' ')
    .replace(TAIL_CONNECTOR_RE, ' ')
    .replace(/\s*(?:之前|以前|前|底|末)\s*$/, ' ')
    .replace(/[\s，,、:：;；.。-]+/g, ' ')
    .replace(TAIL_CONNECTOR_RE, ' ')
    .replace(/\s*(?:之前|以前|前|底|末)$/, '')
    .trim();
}

/**
 * `parseTargetDate` + 一道"日期键真实存在"的自检。
 *
 * 解析器与 REST 入口共用服务层的同一条日期校验（`isDateKey`），所以规则给出来的 `targetDate`
 * 不可能出现"解析成功、落库 400"这种自相矛盾的情况。
 */
export function resolveTargetDate(text, now = new Date()) {
  const parsed = parseTargetDate(text, now);
  return parsed && isDateKey(parsed.dateKey) ? parsed : undefined;
}

export class GoalParser {
  /**
   * @param {string} text 用户原话
   * @param {object} [options]
   * @param {Date}   [options.now] 注入时钟（测试跨月边界用）
   */
  parse(text, options = {}) {
    const raw = String(text ?? '').trim();
    const match = raw.match(TRIGGER_RE);
    if (!match) return { ok: false, raw, warnings: ['不是目标指令（缺少「我打算 / 目标 / 计划 / 定个目标」这类措辞）'] };

    const payload = raw.slice(match[0].length).trim();
    if (!payload) return { ok: false, raw, warnings: ['要达成什么？请把目标说完整'] };

    // 近端日期（明天/下周/今晚/15:00）不是目标的地盘：交给待办或日程
    if (NEAR_DATE_RE.test(payload)) {
      return { ok: false, raw, warnings: ['带着这两天具体安排的内容应该进待办或日程，不是长期目标'] };
    }

    // 用 `resolveTargetDate` 而不是 `parseTargetDate`：它多做一道"日期键真实存在"的自检，
    // 保证从这里出去的 `targetDate` 一定能通过服务层的校验（不会出现"解析成功但落库 400"）
    const parsed = resolveTargetDate(payload, options.now ?? new Date());
    if (!parsed) {
      /**
       * 没有日期就不建目标 —— 这是刻意的。
       *
       * 目标的价值全在"还有多少天"上（本模块的 `severity` / `daysLeft` / `alerts` 都靠它）。
       * 没有目标日的"我想学好英语"更适合当长期记忆或干脆不进系统；
       * 这里返回 `ok: false` 并说明原因，比生成一条 `targetDate` 是今天的假目标要诚实。
       */
      return { ok: false, raw, warnings: ['没听出目标日期（如「12 月前」「2026-06-15」「期末前」），说清楚才能算倒计时'] };
    }

    const title = titleOf(payload, parsed.datePhrase ?? parsed.matched);
    if (!title) return { ok: false, raw, warnings: ['目标内容为空：日期部分被识别成了整个句子'] };

    const kind = kindOf(`${title} ${payload}`);
    const warnings = [];
    if (parsed.guess) warnings.push(`「${parsed.matched}」没有确切日子，暂按 ${parsed.dateKey} 估计，请确认`);
    if (parsed.near) warnings.push('目标日期就在这一周内，确认一下是不是待办更合适');

    /**
     * 置信度 0.9：高于日历兜底解析器的 0.82~0.87（`目标` / `我打算` 是明确措辞），
     * 低于记忆解析器的 0.95（"记住…"比"我打算…"更明确）。
     */
    return {
      ok: true,
      raw,
      action: 'create',
      target: 'goal',
      fields: {
        title: title.slice(0, 120),
        kind,
        targetDate: parsed.dateKey,
        source: 'command',
        // 里程碑留空：从一句话里猜"该分几步"必然猜错，等用户或模型补
        milestones: [],
        // remindDays 不传：服务层会用默认 [7,3,1]，规则层不再写一遍默认值
      },
      confidence: 0.9,
      warnings,
      explain: `记下${{ exam: '考试', deadline: '截止事项' }[kind] ?? '目标'}「${title.slice(0, 40)}」：${parsed.dateKey}`,
      provider: 'rules',
    };
  }
}
