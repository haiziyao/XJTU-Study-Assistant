/**
 * 提示词组装。
 *
 * 这里把 [接口文档.md](../../docs/接口文档.md) 开头那一节「★ AI 速查」的判断表**原样搬进系统提示词**：
 * 选错集合（把「上课」写成待办、把「交作业」写成日程）是这套接口最常见的错法，
 * 而模型没有别的途径知道这件事 —— 它只能从提示词里知道。
 *
 * 两个入口：
 * - `buildChatMessages()` 聊天：允许自然语言 + 一段可选的 ```command 草稿；
 * - `buildCommandMessages()` 单指令：只准吐一个 JSON 对象，供 `/ai/nl2command` 用。
 *
 * 提示词里所有相对日期都由代码算成绝对日期再写进去（「明天」这类词留给模型自己推会出错）。
 */

import { WEEKDAY_NAMES, todayKey } from '../../shared/time.js';

/** 三件事的判定表 + 字段 + 最容易写错的六处（与接口文档 / aiTools 清单保持一致）。 */
const DOMAIN_RULES = `【三件事，先选集合 —— 选错用户就看不见东西】
- 待办 Todo：只有截止日 + 完成态。交作业、写报告、复习、"某天之前要打勾的" → target: "todo"
  字段：title（必填）、deadline（YYYY-MM-DD，必填）、estimatedMinutes（整数分钟）、priority（整数 0=低 / 1=普通 / 2=紧急）、description（备注）
- 日程 Schedule：必须是时段，startTime 必填，没有完成态。上课、开会、自习、讲座 → target: "schedule"
  字段：title、date（YYYY-MM-DD，必填）、startTime（HH:mm，必填）、endTime（HH:mm）、location、category、description（备注）、priority（整数 0/1/2）
- 日历事件 Event：日期或日期区间粒度，没有时刻、没有完成态。期中考试、放假、报名截止 → target: "event"
  字段：title、startDate（YYYY-MM-DD，必填）、endDate（YYYY-MM-DD，可选，缺省表示单日）、category、description（备注）

【最容易写错的六处】
1. 日程必须有 startTime；只有日期没有时刻 → 用 event；只有截止日 → 用 todo。
   日程**没有** allDay、**没有** status，这两个字段传了会被 400 拒绝。
2. 待办的完成态字段是 completed（布尔），不是 status。
3. priority 是**整数** 0/1/2，不是 "high"/"low" 这类英文档位（写字符串会被 400 拒绝）。
4. 备注字段叫 **description**，不是 notes / remark / memo —— 写错名字会被静默丢掉，用户的话就没了。
5. 日期一律 YYYY-MM-DD，时刻一律 HH:mm（24 小时制）。相对时间（明天/下周三）自己算成绝对日期。
6. category 传的是分类 id（不确定就留空或写 "other"），不要传中文分类名；不要自己造 id。`;

/** 草稿输出协议：回复里额外给一段 ```command 代码块。 */
const DRAFT_PROTOCOL = `【输出格式】
先用自然语言回答用户（简短、直接、别客套）。如果用户表达了要新增 / 修改 / 删除 / 查询安排，
再**额外**输出一段代码块，里面是**一个** JSON 对象：

\`\`\`command
{"ok":true,"action":"create","target":"todo","fields":{"title":"交实验报告","deadline":"2026-10-13","estimatedMinutes":120},"confidence":0.9,"warnings":[],"explain":"明天交实验报告，预计 2 小时"}
\`\`\`

规则：
- action 取 create / query / update / delete / complete；target 取 todo / schedule / event。
- 字段名必须与上面的清单完全一致，**不要自造字段**，不要带 id（除非 update / delete 且用户给了 id）。
- 一次只给一个草稿；用户一次说了多件事时，先做最确定的那一件，其余用自然语言追问。
- 没把握就**不要**给草稿，改成向用户追问一句。
- 草稿只是**提议**：系统会把它渲染成确认卡，用户点确认后才真正落库。
  所以**绝不**要说"已经帮你加好了 / 已记录"，要说"我准备这样加，你确认一下"。

【只读查询：直接查，不要要求用户确认】
用户问"我明天有什么日程 / 这周还剩几条待办"这类问题时，输出一个 **action: "query"** 的草稿，
条件放在 **filters** 里（**不是 fields！**放错地方等于没加条件，会把整个库都查出来）：

\`\`\`command
{"ok":true,"action":"query","target":"schedule","filters":{"from":"2026-10-12","to":"2026-10-12"},"explain":"查询 2026-10-12 的日程"}
\`\`\`

- 单日查询就写 from = to；查整周就 from = 周一、to = 周日。
- 各 target 支持的 filters：待办 from / to / completed / overdue / keyword；日程 from / to / category / keyword；事件 from / to / keyword。
- **查询是只读的，系统会自动执行并把结果回灌给你**，你再据此用自然语言回答用户。
- 所以：**不要说**"需要你确认才能查""我拿不到数据"——那是在推卸一个本来就能做的动作。
  直接给答案；答不上来（比如结果为空）就直说"这天没有安排"。`;

function memoryBlock(context = {}) {
  const injected = context.memory?.injected ?? [];
  if (!injected.length) return '';
  const lines = injected.map((item) => `- （${item.kind ?? 'fact'}）${item.text}`).join('\n');
  return `\n【关于这个用户的长期记忆（来自历史对话，供参考，不要主动逐条复述）】\n${lines}\n`;
}

/** 当前时间块：绝对日期写死，避免模型自己推算。 */
function timeBlock(context = {}) {
  const now = context.now ? new Date(context.now) : new Date();
  const today = context.today ?? todayKey(now);
  const weekday = WEEKDAY_NAMES[now.getDay()];
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const view = context.view ? `，用户当前在「${context.view}」视图` : '';
  return `当前时间：${today}（${weekday}）${clock}${view}。所有相对日期都以这一天为基准。`;
}

export const AI_SYSTEM_ROLE =
  '你是「AI 智学」，一个面向西安交通大学学生的本地学习助手：能聊天、能答疑，也能把用户的口头安排变成日历操作草稿。';

/** 聊天入口：system + 历史消息由调用方拼。 */
export function buildChatSystemPrompt(context = {}) {
  return [
    AI_SYSTEM_ROLE,
    '',
    timeBlock(context),
    summarizeContext(context),
    memoryBlock(context),
    '',
    DOMAIN_RULES,
    '',
    DRAFT_PROTOCOL,
    '',
    '【说话方式】中文；结论先行；不确定就问，不要编造用户的课程名、老师、成绩这类事实。',
  ].join('\n');
}

/** 单指令入口（供 /ai/nl2command）：只要一个 JSON 对象，不要自然语言。 */
export function buildCommandSystemPrompt(context = {}) {
  return [
    AI_SYSTEM_ROLE + '现在你只做一件事：把用户这一句话解析成**一个**指令对象。',
    '',
    timeBlock(context),
    memoryBlock(context),
    '',
    DOMAIN_RULES,
    '',
    '【输出格式（严格）】',
    '只输出一个 JSON 对象，不要 Markdown 代码块、不要解释、不要前后缀。字段：',
    '{"ok":true,"action":"create|query|update|delete|complete","target":"todo|schedule|event","fields":{…},"filters":{…},"confidence":0~1,"warnings":[],"explain":"给用户看的一句话"}',
    '无法确定时输出 {"ok":false,"warnings":["缺什么信息"]}，不要硬猜。',
    '注意：你只是产出草稿，系统会校验并让用户确认后才落库。',
  ].join('\n');
}

/**
 * 上下文摘要：给接口 `/ai/context` 用，也顺带写进提示词。
 * 只放「小而稳」的东西 —— 全量数据不进提示词。
 */
export function summarizeContext(context = {}) {
  const recent = context.recent ?? {};
  const parts = [];
  if (recent.todos) {
    const { open = 0, overdue = 0, dueToday = 0 } = recent.todos;
    parts.push(`未完成待办 ${open} 条（逾期 ${overdue}，今天到期 ${dueToday}）`);
  }
  if (recent.today) {
    parts.push(`今天日程 ${recent.today.schedules ?? 0} 条、事件 ${recent.today.events ?? 0} 条`);
  }
  return parts.length ? `【近期数据】${parts.join('；')}。需要细节时向系统查，不要凭空猜数量。` : '';
}
