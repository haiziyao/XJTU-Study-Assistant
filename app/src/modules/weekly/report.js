/**
 * 周报文本：**给模型看的提示词**与**规则降级小结**（两个纯函数，不碰存储、不碰网络）。
 *
 * 为什么把提示词单独放一个文件、还要写得这么啰嗦：
 * 周报是"把数字翻译成人话"，模型最容易犯的错不是写不通顺，而是**写出没有来源的数字**
 * （"本周学习约 12 小时""专注度提升了 20%"）。所以提示词里有三条硬规则：
 *
 *   1. **只依据给定的 JSON 数字**，一个都不许新增；
 *   2. **明说没有"学习时长"这个数据源** —— 系统不记录专注时长/自习小时数，
 *      这是最容易被编出来的一类数字（用户也最信）；
 *   3. `null` 的含义是"**没有数据**"，不是 0 —— 降级小结与提示词用同一句话表达，
 *      免得同一次统计在两种路径下被读成两个意思。
 *
 * 降级小结（`fallbackReport`）刻意与模型简报**同结构**（一句话 + 三个小节），
 * 这样前端只有一套渲染逻辑；区别只在 `fallback: true` 与文风（规则版只陈述数字）。
 */

import { SOURCE_LABEL } from './sources.js';

/** 与模型约定的三条小节标题：前端按行切分渲染，改动等于改契约。 */
export const SECTION_TITLES = ['学习投入', '复习与笔记', '需要注意的事'];

/** 报告长度上限：提示词里要求 ≤400 字，落库前再夹一次（防模型跑飞把 JSON 集合写胖）。 */
export const REPORT_MAX_CHARS = 2000;

const rangeLabel = (stats) => `${stats.week}（${stats.from} ~ ${stats.to}，共 ${stats.days} 天）`;

/**
 * 把 stats 压成**给模型看的摘要**：中文键 + 只留模型真的会引用的数。
 *
 * 为什么不直接丢整个 stats：英文键 + 内部字段（`todosDueSoon`、`activeConversations`…）
 * 会让模型去猜语义，而它猜错的方式是"换一个听起来更漂亮的说法"，于是数字就变了。
 * `缺失的数据` 单独一列，是为了让模型知道**哪些事它不许提**（提了只能是编的）。
 */
export function buildDigest(stats) {
  const { conversations, notes, cards, goals, schedule, grades } = stats;
  return {
    时间区间: rangeLabel(stats),
    AI对话: conversations
      ? {
          新会话: conversations.newConversations,
          消息条数: conversations.messages,
          我的提问: conversations.userMessages,
          有往来的会话: conversations.activeConversations,
          新会话标题: conversations.titles,
        }
      : null,
    笔记: notes ? { 新建: notes.created, 更新: notes.updated, 其中仅更新旧笔记: notes.updatedOnly, 删除: notes.deleted, 标题: notes.titles } : null,
    复习卡片: cards
      ? {
          复习次数: cards.reviews,
          新学会: cards.learned,
          本周复习过的卡片数: cards.reviewedCards,
          当前到期: cards.due,
          卡片总数: cards.total,
        }
      : null,
    学习目标: goals
      ? {
          本周有改动的目标: goals.updated,
          进度变化次数: goals.progressChanges,
          本周完成: goals.completed,
          已逾期: goals.overdue,
          '7天内到期': goals.dueSoon,
          进行中: goals.active,
          标题: goals.titles,
        }
      : null,
    待办: schedule
      ? {
          本周新增: schedule.todosCreated,
          本周完成: schedule.todosCompleted,
          未完成: schedule.todosOpen,
          已逾期: schedule.todosOverdue,
          '7天内到期': schedule.todosDueSoon,
          需要留意: schedule.attention,
        }
      : null,
    成绩: grades ? { 学分绩: grades.gpa, 计入课程数: grades.includedCount, 本周有变动: grades.changed, 变动条数: grades.updated } : null,
    缺失的数据: (stats.missing ?? []).map((item) => `${SOURCE_LABEL[item.source] ?? item.source}：${item.reason} —— ${item.detail}`),
  };
}

/**
 * 组装一次模型调用（`services.ai.complete({ system, user })`）。
 *
 * `temperature` 默认 0.3：周报要的是"把数字讲顺"，不是创作；调高会开始出现形容词与推测。
 * `thinking` 固定 none —— 写一段 400 字的简报不需要思考链，开了只是白烧 token。
 */
export function weeklyRequest({ stats, temperature = 0.3 }) {
  const system = [
    '你在给一位大学生写「学习周报」。材料是系统从本地数据里统计出来的 JSON 数字。',
    '',
    '硬规则（违反即视为错误输出）：',
    '1. **只依据给定 JSON 里的数字**。一个都不许新增、不许换算、不许四舍五入成"约"，不许写"大概/大约"。',
    '2. **系统没有"学习时长 / 专注时长 / 自习小时数"这个数据源**：任何情况下都不许写"本周学习 12 小时"',
    '   "专注 8 小时"这类句子。要谈投入，只能用给定数字：对话与提问条数、笔记篇数、复习次数、待办完成数。',
    '3. JSON 里为 **null** 的项表示"**没有数据**"，不是 0，也不代表用户没做这件事；',
    '   对应的小节要如实写"暂无数据"，并可以补一句原因（见"缺失的数据"）。**绝不估算、绝不假设**。',
    '4. 学分绩 null 表示没有可计算的成绩，不是 0 分。',
    '5. 只写事实与数字，不写鼓励语、不写学习建议、不写心理状态判断（"你很努力""状态不错"都不要）。',
    '',
    '输出格式（纯文本，不要 Markdown 标题符号、不要列表符号、不要代码块）：',
    '第一行：一句话总结这一周的状态（用具体数字，不要空话）。',
    `然后依次三行，每行以「小节名：」开头，小节名固定为：${SECTION_TITLES.join(' / ')}。`,
    '总长控制在 400 字以内，中文。',
  ].join('\n');

  const user = [
    '以下是本周统计（JSON）：',
    JSON.stringify(buildDigest(stats), null, 2),
    '',
    `请按格式写一段 ≤400 字的周报，覆盖 ${rangeLabel(stats)}。`,
  ].join('\n');

  return { system, user, temperature, thinking: 'none' };
}

// ---------------------------------------------------------------- 规则降级小结

/** `3 个` / `null` -> 跳过（缺失由小节末尾统一说明，不在这里编 0）。 */
const count = (value) => (Number.isFinite(value) ? value : null);

/**
 * 不经过模型也能给出的客观小结。
 *
 * 只在"模型不可用/调用失败"时使用，但**必须自己站得住**：每一句都直接对应 stats 里的一个字段，
 * 没有数据的小节就写"暂无数据"，缺失的来源列在最后一行。这样即使一个字的模型输出都没有，
 * 用户仍然拿到一份如实的周报 —— `fallback: true` 只是说"这段不是模型写的"。
 */
export function fallbackReport(stats) {
  const { conversations, notes, cards, goals, schedule, grades } = stats;
  const lines = [];

  // 一句话总结：只挑存在的数字
  const headline = [];
  if (notes) headline.push(`新写 ${notes.created} 篇笔记`);
  if (schedule) headline.push(`完成 ${schedule.todosCompleted} 项待办`);
  if (cards && count(cards.reviews) !== null) headline.push(`复习 ${cards.reviews} 次`);
  else if (cards && count(cards.reviewedCards) !== null) headline.push(`复习了 ${cards.reviewedCards} 张卡片`);
  if (conversations) headline.push(`向我提了 ${conversations.userMessages} 个问题`);
  lines.push(
    headline.length
      ? `${rangeLabel(stats)}小结：${headline.join('、')}。`
      : `${rangeLabel(stats)}没有可用于汇总的新数据。`,
  );

  // 学习投入
  const effort = [];
  if (conversations) {
    effort.push(`${conversations.newConversations} 个新会话`, `${conversations.userMessages} 次提问（共 ${conversations.messages} 条消息）`);
  }
  if (schedule) effort.push(`待办新增 ${schedule.todosCreated} 项、完成 ${schedule.todosCompleted} 项`);
  if (goals && count(goals.progressChanges) !== null) effort.push(`目标进度变化 ${goals.progressChanges} 次`);
  // gaps 只在这周真的做过这件事、但数字算不出来时才提示：否则每个小节尾巴都挂一句
  // 暂无数据，读者会以为系统到处都坏着
  lines.push(
    section('学习投入', effort, [
      !conversations && '对话',
      !schedule && '待办',
      goals && count(goals.progressChanges) === null && goals.updated > 0 && '目标进度',
    ]),
  );

  // 复习与笔记
  const study = [];
  if (notes) study.push(`新写 ${notes.created} 篇笔记（更新 ${notes.updated} 篇）`, notes.deleted ? `删除 ${notes.deleted} 篇` : null);
  if (cards) {
    if (count(cards.reviews) !== null) study.push(`复习 ${cards.reviews} 次`);
    if (count(cards.learned) !== null) study.push(`新学会 ${cards.learned} 张卡片`);
    // 没有复习流水时 cards.reviews 为 null，但"复习过的卡片数"是精确值 —— 有就给，不假装没有
    if (count(cards.reviewedCards) !== null) study.push(`复习过 ${cards.reviewedCards} 张卡片`);
    if (count(cards.due) !== null) study.push(`当前到期 ${cards.due} 张`);
  }
  lines.push(
    section('复习与笔记', study, [
      !notes && '笔记',
      !cards && '复习卡片',
      cards && count(cards.reviews) === null && (cards.reviewedCards > 0 || cards.due > 0) && '复习次数',
    ]),
  );

  // 需要注意的事
  const attention = [];
  if (schedule) {
    if (schedule.todosOverdue) attention.push(`${schedule.todosOverdue} 项待办已逾期`);
    if (schedule.todosDueSoon) attention.push(`${schedule.todosDueSoon} 项待办 7 天内到期`);
  }
  if (goals) {
    if (goals.overdue) attention.push(`${goals.overdue} 个目标已逾期`);
    if (goals.dueSoon) attention.push(`${goals.dueSoon} 个目标 7 天内到期`);
  }
  if (grades?.changed) attention.push(`成绩数据有 ${grades.updated} 条变动`);
  lines.push(section('需要注意的事', attention, [!schedule && '待办', !goals && '学习目标'], '暂时没有逾期或临近的条目'));

  // 缺失与"口径有限"分开写：前者是"没有这个数据源"，后者是"有数据但某个字段算不出来" ——
  // 混成一句会让人以为整块都丢了（cards 明明给出了到期数，却被写成"缺复习卡片"）。
  const label = (list) => {
    // 同一个来源可能有两三条不同的口径限制（如 goals 同时缺进度流水与完成时间）：
    // 按来源归并成一句，避免"学习目标（…）；学习目标（…）"这种读起来像复读机的输出
    const bySource = new Map();
    for (const item of list) {
      const name = SOURCE_LABEL[item.source] ?? item.source;
      bySource.set(name, [...(bySource.get(name) ?? []), item.detail]);
    }
    return [...bySource].map(([name, details]) => `${name}（${details.join('；')}）`).join('；');
  };
  const gone = stats.missing.filter((item) => item.reason !== 'partial');
  const limited = stats.missing.filter((item) => item.reason === 'partial');
  if (gone.length) lines.push(`缺：${label(gone)}`);
  if (limited.length) lines.push(`口径有限：${label(limited)}`);
  return lines.join('\n');
}

/** 一个小节：没有数字时给"暂无数据"而不是省略整行（省略会让人以为系统漏写了）。 */
function section(title, parts, gaps, emptyText = '暂无数据') {
  const body = parts.filter(Boolean).join('、') || emptyText;
  const gapText = gaps.filter(Boolean);
  return `${title}：${body}${gapText.length ? `（${gapText.join('、')}暂无数据）` : ''}`;
}
