/**
 * AI 对话服务：会话与消息的存储、上下文组装、一次问答的完整流程。
 *
 * 数据落库（两个集合，`module.js` 里声明）：
 *   - `aiConversations`：会话（标题、消息数、最后消息时间）
 *   - `aiMessages`：消息（role / content / drafts / model / usage / status）
 *
 * 一次 send 的顺序（重要，顺序错了会出现"消息已存但没回复"的脏状态）：
 *   1. 建/取会话 → 存用户消息；
 *   2. 组装 system（含判定表 + 记忆注入）+ 最近 N 轮历史；
 *   3. **先插一条 assistant 占位消息**（`status: "streaming"`）拿到稳定的 messageId，
 *      流式的 delta 才能带着它广播出去；
 *   4. **循环**调上游（最多 `MAX_ROUNDS` 轮，一轮 = 一次 `provider.chat`，**每轮都流式**）：
 *      抽草稿（一轮可含多条写入草稿）→ dryRun 预校验 → 只读查询自动执行（`auto` 档连写操作一起执行，
 *      但受设置项 `maxActionsPerTurn` 约束：只执行前 N 条，0 = 不限制）→
 *      把这一轮的结果（查询结果 **和** 已自动执行的写操作结果）回灌进上下文再进下一轮；
 *      某一轮既没有**新**查询、也没有真执行写操作、也没有"因上限被截下来待确认"的草稿，
 *      就说明它在作答，循环结束；
 *   5. 用**最后一轮**的正文把占位消息更新成 `done`（`rounds` / `roundLimit` / `usageRounds` 一起记下）；
 *   6. 失败：第一轮就失败 → 整条标 `failed` 并带上错误（不删，用户能看到"刚才那次没成"）；
 *      第二轮及以后的"总结失败" → 只记 `PARTIAL`，已经查到的数据照常返回。
 *
 * 本服务**不直接写业务数据**：草稿只做 dryRun 预览，真正落库由用户确认后走 `/commands/execute`；
 * 唯一的例外是 `auto`（自动审批）档 —— 那是用户显式授权系统替他点确认，执行结果照样回执 + 回灌。
 */

import { ERROR_CODES } from '../../shared/constants.js';
import { HttpError } from '../../core/http/router.js';
import { todayKey } from '../../shared/time.js';

import {
  AI_DEFAULTS,
  MAX_ACTIONS_UNLIMITED,
  SEARCH_RETRY_MIN,
  SEARCH_RETRY_MAX,
  maskAiConfig,
  normalizeMaxActionsPerTurn,
} from './config.js';
import { extractDrafts, previewDrafts } from './drafts.js';
import { buildChatSystemPrompt, buildCommandSystemPrompt, describeChatPrompt, estimateTokens } from './prompt.js';
import {
  pageFromSearchContent,
  readPages,
  searchWebDetailed,
  SEARCH_LIMIT_DEFAULT,
  normalizeSearchLimit,
  WEB_SEARCH_MODES,
} from './web-search.js';

/** 给上下文注入留的默认预算（与接口文档 §10.7 一致）。 */
const DEFAULT_MEMORY_BUDGET = Object.freeze({ maxItems: 8, maxChars: 600 });

/**
 * 每条网页回灌给模型的正文上限（字）。
 *
 * 「网络搜索最大条数」管的是**读几个网页**（5–30，用户可在设置里改）；单页正文还得单独截，
 * 否则 30 页 × 4000 字 = 12 万字全塞进上下文，这一轮没被截断、下一轮就直接爆掉，
 * 而模型会因为上下文里全是网页噪声而答得更差。2000 字足够覆盖一篇通知的要点。
 */
const WEB_TEXT_CHARS = 1_200;

/** 联网检索在草稿里用的 target 名（模型输出 `{"action":"query","target":"web"}`）。 */
const WEB_TARGET = 'web';

/**
 * 被用户中途停止的 assistant 消息落库时用的状态。
 *
 * 为什么不复用 `failed`：这两件事对用户**完全不同** ——
 * `failed` 是"这次没成，你可以重来"，界面该给错误原因与重试入口；
 * `stopped` 是"你叫停的"，界面该显示"已停止"，并且**保留已经生成的那半段正文**
 * （用户往往正是看着那半段才决定停的）。混成一个状态，用户会以为程序崩了。
 */
const STATUS_STOPPED = 'stopped';

/**
 * 本回合的联网检索次数已经用完。
 *
 * 为什么用"回灌一个错误"而不是"悄悄跳过这次草稿"：跳过的话模型完全不知道自己的检索
 * 没有执行 —— 它会照着"我搜过了"的语气继续编，或者把同一件事再说一遍，
 * 把剩下的轮次全烧在同一个动作上，用户最终拿到的还是一句空话。
 * 把"次数用完"当成**一次有原因的结果**回灌，模型才有依据收尾：
 * 要么用已经拿到的数据作答，要么如实说拿不到并给下一步。
 */
const SEARCH_RETRY_EXHAUSTED = 'SEARCH_RETRY_EXHAUSTED';

/** 停止信号触发时内部用的错误码（停止有自己的落库状态，这个码不会落库）。 */
const STOPPED_CODE = 'AI_STOPPED';

/**
 * 一次检索失败 / 空结果时给模型的**三条具体建议**（回灌文案里逐条给出）。
 *
 * 为什么必须具体到"换更短的关键词 / 直读某个网址"：只说"再试试"等于没说 ——
 * 实测模型会原地把同一句话换个说法再搜一遍（预算就是这么被烧掉的）。
 * 给出可执行的岔路，它才会真的换策略，或者按第三条如实收尾。
 */
const SEARCH_RETRY_ADVICE = Object.freeze([
  '①换一组更短、更具体的关键词再搜一次（把整句问话压成 2–4 个关键词，例如「西安 天气」）',
  '②如果你知道是哪个校方栏目/页面，直接读那个网址：草稿里给 fields.url，不要再拿网址去搜',
  '③如果确实拿不到，就如实告诉用户"这次没拿到"并给出下一步（换个问法再试 / 用户自己打开某个网址），不要编内容',
]);

/**
 * 过程清单里写操作用的动词。
 *
 * 与 `#historySummary` 的 `ACTION_LABELS`（新建/修改/删除）**故意不同**：
 * 那边是"上一轮做了什么"的回顾（可以说"新建"），这边是"它准备做什么"的进行时。
 */
const PLAN_WRITE_LABELS = Object.freeze({
  create: '写入',
  update: '修改',
  delete: '删除',
  complete: '完成',
  rollover: '顺延',
});

/**
 * 定时唤醒的执行策略。
 *
 * - `permission: 'manual'`：到点是**没有人看着**的时候，让模型自己把日程/待办写进库
 *   太危险（用户第二天才发现多了几条莫名其妙的记录）。写操作一律留成待确认草稿，
 *   等用户回到那个会话点确认；只读查询照常自动执行，所以"计划播报"这类任务依旧一次就出结果。
 * - `search`：由任务自己声明（见 schedule 的 `search` 字段），默认沿用"不联网"，
 *   用户明确要"每天搜一下最新通知"时才开 —— 后台悄悄联网不符合这个程序一贯的显式风格。
 * - `context.view` 标成 `schedule`：让记忆注入按"定时任务"这个场景来挑（当前没有专门规则，
 *   但视图名进上下文能让模型知道这次不是用户在实时对话）。
 */
export const SCHEDULE_RUN_OPTIONS = Object.freeze({ permission: 'manual', search: 'off', context: { view: 'schedule' } });

/**
 * 「指令词触发绘图」：即使设置里关掉了作图，用户明说要画也照给 ——
 * 关掉的意思是"别主动画"，不是"用户要画也不给"。
 */
const DRAW_KEYWORDS = /画|绘制|作图|图形|图表|函数图|示意图|流程图|坐标|svg|diagram/i;

/** 一轮对话最多自动执行几个只读查询（防止模型把"查一下"拆成八条）。 */
const MAX_AUTO_QUERIES = 3;
/** 回灌给模型的单次查询条数上限（只读；多了只会让提示词变贵、让它跑偏）。 */
const MAX_QUERY_ITEMS = 20;

/**
 * 一次 `send` 最多让模型调几轮（一轮 = 一次上游调用）。
 *
 * 以前这里**只有一轮回灌**：模型查完一次就再没有机会动第二次，于是"先查冲突、再写"
 * 这种最常见的两步动作永远走不完，用户看到的就是"调用完工具，对话也结束了"。
 * 现在是真正的循环：每轮都能查，查到没有新查询为止（或到上限为止）。
 * 5 轮足够覆盖"查日程 → 查待办 → 写一条 → 回话"，再多就是模型在打转。
 */
/**
 * 一次提问最多跑几轮工具循环（一轮 = 一次上游调用）。
 *
 * 从 5 提到 8：实测「缓考怎么申请、要哪些材料、找谁签字」这类要走好几个来源的问题，
 * 5 轮真的不够 —— 模型查了 6 次（正文里还在说"再把…原文读一遍"）就被上限截断，
 * 用户看到的是一个半截答案，而且**界面上完全看不出是被截断的**。
 * 上限仍然保留：它防的是"模型把同一条查询变着花样烧钱"，而不是限制正常的多来源研究。
 */
const MAX_ROUNDS = 8;

/**
 * 滚动摘要（长对话不丢线）。
 *
 * 问题：`historyTurns` 一到就**硬截断**，用户聊到第 40 轮时，第 1 轮的约定（"我周三下午不方便"、
 * "这次考试按 60% 平时分算"）已经不在上下文里了，模型于是"忘了"——用户感觉是"聊着聊着就断了"。
 *
 * 做法：把窗口之外**已经聊过去**的部分压成一段不超过 `SUMMARY_MAX_CHARS` 的摘要，常驻系统提示词。
 *   - 只在"未摘要的旧消息 ≥ `SUMMARY_MIN_MESSAGES` 条"时才压一次（不是每轮都调模型）；
 *   - 压过就记 `summaryCount`（已覆盖多少条），下次只压新增的部分，不重复烧 token；
 *   - **压缩失败不阻塞对话**：拿旧摘要继续，宁可少记一点也不让这条消息发不出去。
 */
/**
 * "我再去查/看一下"这类**空承诺**的识别（只用于兜底补救，不用于判断语义好坏）。
 * 命中后系统会注入一条提醒再跑一轮：要么发草稿，要么把话说完整（见循环里的 `looksLikePromise`）。
 */
function looksLikePromiseToLook(text) {
  const line = String(text ?? '').trim();
  // 只可能是"一整段就是一句承诺"：稍长的回答里出现"查"字太正常了（"查到了 1 条。"就是被误判过的）
  if (!line || line.length > 24) return false;
  // **单句**：带逗号/分号的是"我先看 A，然后做 B"这种有内容的复合句，不是纯承诺
  // （"我先看一下你的待办，然后给你排个顺序。"被误判过一次，害得它多跑一轮还把话说了两遍）
  if (/[，,；;]/.test(line)) return false;
  // 有数字或完成态 = 已经在说结果了，不是承诺
  if (/[0-9]/.test(line) || /[了到出]/.test(line)) return false;
  // 必须带"要去查/看"的动词（未来时）
  return /(搜|查|检索|看看|看一下|读一下|翻一下)/.test(line);
}

const SUMMARY_MIN_MESSAGES = 6;
const SUMMARY_MAX_CHARS = 600;

/**
 * 「分类合计」用的键：system / tools 由 `describeChatPrompt` 给，history / summary 由本文件算。
 * 顺序就是弹层里的行序（用户先看规则占多少，再看对话本身占多少）。
 */
const CONTEXT_BREAKDOWN_KEYS = Object.freeze(['system', 'tools', 'history', 'summary']);

/**
 * 思考强度 → 官方 `reasoning_effort`。
 *
 * 官方合法取值只有 `none / low / high / max`（**没有 medium**：它只是兼容别名，会映射成 high，
 * 所以这里不再对外暴露"中"，免得界面说"中"、上游当"高"）。
 * 另外：DeepSeek 的思考模式**默认就是开的**（effort 默认 high），所以关闭时必须显式传 `none`。
 */
const THINKING_LEVELS = Object.freeze({
  none: 'none',
  low: 'low',
  high: 'high',
  max: 'max',
  // 兼容旧前端/别名
  medium: 'high',
  minimal: 'low',
  xhigh: 'high',
});

/** 支持看图的官方模型（见「图像理解」文档：目前只有 flash）。 */
const VISION_MODELS = /flash/i;
/** 官方支持的图片格式；**按内容判断**，所以只认 data URL 里的 MIME。 */
const IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];

/**
 * 写入权限三档（UI 上叫「自动审批 / 手动审批 / 全部确认」）：
 * - `auto`   自动审批：**写操作也自动执行**，结果以卡片回执（默认不选它，风险自负）；
 * - `manual` 手动审批（默认）：只读查询自动跑，写操作必须点确认；
 * - `strict` 全部确认：连只读查询也要用户点确认。
 */
const PERMISSIONS = Object.freeze(['auto', 'manual', 'strict']);

/**
 * 联网检索档位（UI 上的「关闭 / 校外网 / 校内网」）。
 *
 * 目前**还没有真正的检索实现**：这个值只是原样交给提示词（`context.search`），
 * 让模型如实说明"检索还没接入"，而不是编造几条"搜到的"内容 —— 后者比不搜更糟。
 */
const SEARCH_MODES = Object.freeze(['off', 'web', 'campus']);

/**
 * 历史摘要里给写操作用的动词（见 `#history`）。
 * 不认识的 action 原样显示 —— 宁可显示 `update`，也不要猜成"已删除"。
 */
const ACTION_LABELS = Object.freeze({
  create: '新建',
  update: '修改',
  delete: '删除',
  complete: '完成',
  rollover: '顺延',
});

/**
 * 一行历史摘要最多多少字（见 `#historySummary`）。
 * 它是补充说明，不能喧宾夺主：里面全是条数与标题，200 字足够说清"上一轮干了什么"。
 */
const HISTORY_SUMMARY_MAX = 200;

/** 附件上限：图片走多模态直传，文本文件内联进提示词，其余只登记名字。 */
const MAX_ATTACHMENTS = 8;
const MAX_IMAGES = 4;
const MAX_TEXT_CHARS = 20_000;
const MAX_TEXT_TOTAL = 60_000;

/** 会话标题最长多少字（取用户第一句话的开头）。 */
const TITLE_MAX = 24;

const EMPTY_MEMORY = (maxItems = DEFAULT_MEMORY_BUDGET.maxItems, maxChars = DEFAULT_MEMORY_BUDGET.maxChars) => ({
  injected: [],
  budget: { maxItems, maxChars, usedItems: 0, usedChars: 0, truncated: false },
});

/* ------------------------------------------------------------ 过程清单（plan） */

/**
 * 一条草稿的**业务指纹**（与 `#draftKey` 同一口径）。
 *
 * 抽成模块级函数是为了让过程清单也能用它去重，而不必把服务实例传进去：
 * 模型把同一件事说两遍时，清单里不该出现两个一模一样的步骤。
 */
function draftFingerprint(entry) {
  const draft = entry?.draft ?? {};
  return JSON.stringify({
    action: draft.action ?? '',
    target: draft.target ?? '',
    filters: draft.filters ?? null,
    fields: draft.fields ?? null,
    id: draft.id ?? null,
  });
}

/** 从草稿里挑一个"人话名字"：标题优先，其次检索词 / 关键词 / id。 */
function draftName(draft = {}) {
  const value =
    draft.fields?.title ??
    draft.filters?.title ??
    draft.fields?.query ??
    draft.filters?.q ??
    draft.fields?.keyword ??
    draft.filters?.keyword ??
    draft.fields?.url ??
    draft.id ??
    '';
  return String(value).trim().slice(0, 60);
}

/**
 * 过程清单里的 target 中文名。
 *
 * 为什么不直接用 `draft.target`：这张卡片是**给用户看的**，
 * 「查询 schedule」「写入 schedule」这种中英夹杂的句子没人愿意读第二眼。
 * 认不出的 target 原样显示 —— 宁可显示一个陌生词，也不要猜成"日程"。
 */
const PLAN_TARGET_LABELS = Object.freeze({
  web: '网上资料',
  schedule: '日程',
  todo: '待办',
  event: '考试/事件',
  note: '笔记',
  grade: '成绩',
  memory: '记忆',
});

/** 查询带了日期区间时缀在步骤名后面：`查询日程（2026-10-13）`。 */
function planRangeText(filters = {}) {
  const from = filters?.from ?? filters?.date ?? null;
  const to = filters?.to ?? filters?.date ?? null;
  if (!from && !to) return '';
  return from && to && from !== to ? `（${from}~${to}）` : `（${from ?? to}）`;
}

/**
 * 过程清单里一步的文案：只读查询 → 「检索/查询 …」，写入 → 「写入/修改/删除 …」。
 * 用户扫一眼就能分清"它要去看"还是"它要改我的数据" —— 这两件事的心理预期完全不同。
 */
function planStepLabel(entry) {
  const draft = entry?.draft ?? {};
  const kind = PLAN_TARGET_LABELS[draft.target] ?? draft.target ?? '数据';
  const name = draftName(draft);
  if (draft.action === 'query') {
    // 联网检索按契约写成「检索「关键词」」：这是用户最常见到的一步
    if (draft.target === WEB_TARGET) return name ? `检索「${name}」` : '检索网上资料';
    return name ? `查询${kind}「${name}」` : `查询${kind}${planRangeText(draft.filters)}`;
  }
  const verb = PLAN_WRITE_LABELS[draft.action] ?? draft.action ?? '操作';
  return name ? `${verb}${kind}「${name}」` : `${verb}${kind}`;
}

/**
 * 一轮对话的「过程清单」（界面上那张 AI todolist）。
 *
 * 四条口径都是契约：
 *   1. **只在有草稿时才有清单**：纯聊天一次 plan 都不广播 —— 给一句"你好"套一层进度条，
 *      用户会以为系统在背后做了一堆事，而它其实只是回了句话；
 *   2. **每次都是全量快照**（`steps` 整份重发），前端整体重画，不做增量合并 ——
 *      少一类"漏收一条事件就画错"的 bug；
 *   3. **同一回合内 messageId 不变**：所有轮次的步骤都挂在这一条 assistant 消息上；
 *   4. 停止之后不再广播任何后续步骤（`isAborted`）；但停止那一刻会先把没跑完的
 *      落成 `failed` 再广播最后一份（见 `AiChatService#stop`），否则界面上会留下
 *      永远转圈的步骤，用户以为它还在干活。
 */
class TurnPlan {
  constructor({ conversationId, messageId, broadcast, isAborted = () => false }) {
    this.conversationId = conversationId;
    this.messageId = messageId;
    this.broadcast = broadcast;
    this.isAborted = isAborted;
    this.steps = [];
    this.byKey = new Map();
    /** 步骤 id 的序号：`q1` / `w1`（查询与写入各自编号，与契约里的例子一致）。 */
    this.counters = { q: 0, w: 0 };
    this.closed = false;
  }

  /** 登记一条草稿对应的步骤；同一条草稿（指纹相同）只登记一次。 */
  add(entry, { defer = false } = {}) {
    if (this.closed) return null;
    const key = draftFingerprint(entry);
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const draft = entry?.draft ?? {};
    const kind = draft.action === 'query' ? 'q' : 'w';
    this.counters[kind] += 1;
    const step = {
      id: `${kind}${this.counters[kind]}`,
      label: planStepLabel(entry),
      status: 'pending',
      target: draft.target ?? null,
    };
    this.steps.push(step);
    this.byKey.set(key, step);
    // 新步骤出现本身就是一次状态变化：先让界面把"待办"列出来，再逐个变成 running
    if (!defer) this.emit();
    return step;
  }

  /**
   * 一轮的草稿**一次性**登记：这一轮的快照只广播一次，而不是每条草稿各广播一次。
   * 为什么：一次广播里就该看到"这一轮要做的全部事情"，否则界面会先画出一条、
   * 半秒后再补上第二条 —— 看起来像系统漏了一步。
   */
  addAll(entries) {
    let added = false;
    for (const entry of entries ?? []) {
      const before = this.steps.length;
      this.add(entry, { defer: true });
      if (this.steps.length > before) added = true;
    }
    if (added) this.emit();
  }

  /** 这一步真的开始跑了（检索发出去了 / 写操作要落库了）。 */
  start(entry) {
    const step = this.byKey.get(draftFingerprint(entry));
    if (!step || step.status !== 'pending') return;
    step.status = 'running';
    this.emit();
  }

  /** 这一步有结果了：`error` 为空 = done，否则 = failed。 */
  finish(entry, error) {
    const step = this.byKey.get(draftFingerprint(entry));
    if (!step || step.status === 'done' || step.status === 'failed') return;
    step.status = error ? 'failed' : 'done';
    this.emit();
  }

  /**
   * 收尾：还在 pending / running 的一律落到终态。
   *
   * 正常收尾传 `done`：没自动执行的写草稿已经变成"待用户确认"的卡片了，
   * 系统这一轮该做的做完（卡片本身会写清"还没落库"）。
   * 被停止时传 `failed`：那一步**确实没有完成**，标成 done 就是撒谎。
   */
  settle(status = 'done') {
    let changed = false;
    for (const step of this.steps) {
      if (step.status === 'done' || step.status === 'failed') continue;
      step.status = status;
      changed = true;
    }
    if (changed) this.emit();
  }

  /** 回合结束后封口：不再有任何 plan 广播（迟到的步骤不该在下一轮之后又冒出来）。 */
  close() {
    this.closed = true;
  }

  emit() {
    if (this.closed || !this.steps.length) return;
    if (this.isAborted()) return;
    this.broadcast?.({
      type: 'plan',
      module: 'ai',
      payload: {
        conversationId: this.conversationId,
        messageId: this.messageId,
        // 全量快照：拷一层再发，免得广播出去之后被后续改动"追改"
        steps: this.steps.map((step) => ({ ...step })),
      },
    });
  }
}

/* ------------------------------------------------------------ 联网检索预算 */

/**
 * 一个回合的联网检索预算（`searchRetryMax`，默认 3、范围 1–6）。
 *
 * 为什么次数要在服务端数：模型看不到自己这一回合搜过几次（每一轮都是全新的一次请求），
 * 不告诉它剩余次数，它就会一路换词重试到轮次上限 —— 用户等半天，最后拿到的还是"没搜到"。
 */
function createSearchBudget(max) {
  const value = Number(max);
  const limit = Number.isFinite(value)
    ? Math.min(SEARCH_RETRY_MAX, Math.max(SEARCH_RETRY_MIN, Math.trunc(value)))
    : AI_DEFAULTS.searchRetryMax;
  return { max: limit, used: 0 };
}

/** 用掉一次预算，返回"这是第几次、还剩几次"。 */
function consumeSearchBudget(budget) {
  budget.used += 1;
  return { attempt: budget.used, remaining: Math.max(0, budget.max - budget.used) };
}

export class AiChatService {
  /**
   * 正在跑的回合：`conversationId -> { messageId, controller, plan, phase }`。
   * `POST /ai/chat/stop` 靠它找到"该打断哪一轮"；没有登记 = 空闲（返回 idle，不是错误）。
   */
  #turns = new Map();

  /**
   * 会话级的排队链：`conversationId -> Promise`（见 `#acquireTurn`）。
   * 同一个会话同一时刻只跑一轮；不同会话互不影响。
   */
  #turnQueue = new Map();

  constructor({
    store,
    broadcast,
    services,
    config,
    provider,
    commands,
    files,
    onConfigChange,
    domainBlocks = [],
    queryFields = {},
    queryLimits = {},
    logger = null,
    searchFetch = null,
  }) {
    this.store = store;
    this.broadcast = broadcast;
    this.services = services;
    this.config = config;
    this.provider = provider;
    this.commands = commands;
    /**
     * 框架的 `log`（`log(level, message)`）。联网检索与定时唤醒会产生
     * "用户看不见、排查时却必须有"的信息（反爬拦截、正文抓取失败、唤醒失败原因），
     * 统一走它落进后端日志；没注入时错误级别退回 console，绝不因为没日志就抛。
     */
    this.logger = typeof logger === 'function' ? logger : null;
    /**
     * 检索用的 fetch。生产不传（用全局 fetch）；测试传一个指向本地假搜索引擎的实现，
     * 这样"搜到 → 读正文 → 回灌模型 → 引用链接"整条链路可以在**完全不联网**的情况下验证。
     */
    this.searchFetch = typeof searchFetch === 'function' ? searchFetch : null;
    /** Files API 的本地账本（可为空：没有它就不上传，退回内联）。 */
    this.files = files;
    /** 配置变化后的回调（模块层用它决定是否把 provider 注册给 aiBridge）。 */
    this.onConfigChange = onConfigChange;
    /**
     * 各业务模块自己声明的领域说明（模块描述符的 `aiPrompt`），拼进系统提示词。
     * 这样新增一个可查询的 target 不必回来改本模块。
     */
    this.domainBlocks = domainBlocks;
    /**
     * 只读查询结果回灌给模型时保留哪些字段：`{ [target]: string[] }`。
     * 来自各模块的 `aiQueryFields`，**覆盖**下面 #compactQueryResult 里的内置表。
     */
    this.queryFields = queryFields;
    /**
     * 每个 target 回灌时最多保留多少条：`{ [target]: number }`，来自各模块的 `aiQueryLimits`。
     * 有些数据**整份才有意义**（成绩单被截到 20 条就没法算学分绩了），模块自己最清楚该给多少。
     * 没声明的 target 仍用 MAX_QUERY_ITEMS。
     */
    this.queryLimits = queryLimits;
  }

  // ---------------------------------------------------------------- 状态 / 配置

  status() {
    const conversations = this.store.aiConversations?.all?.() ?? [];
    const messages = this.store.aiMessages?.all?.() ?? [];
    return {
      configured: this.provider.configured(),
      provider: this.provider.configured() ? this.provider.name : null,
      config: maskAiConfig(this.config.get()),
      /** 老配置里的旧模型名被自动换掉时，这里给出原名字（界面据此提示一次） */
      modelMigratedFrom: this.config.migratedFrom ?? null,
      conversations: conversations.length,
      messages: messages.length,
      /** 前端据此决定聊天框上方显示「AI 未配置」还是模型名。 */
      ready: this.provider.configured(),
    };
  }

  maskConfig() {
    return maskAiConfig(this.config.get());
  }

  /**
   * Token 用量统计（含缓存命中率）。
   *
   * 官方 usage 形状：`prompt_tokens` = 命中 + 未命中，另有 `prompt_cache_hit_tokens` /
   * `prompt_cache_miss_tokens`，以及 `completion_tokens_details.reasoning_tokens`（思考链）。
   * 命中率按**输入侧**算：命中 / (命中 + 未命中) —— 和"这次请求读了多少缓存"是同一件事。
   *
   * @param {object} [options]
   * @param {string} [options.conversationId] 只统计这个会话；不传就统计全部
   */
  usage({ conversationId } = {}) {
    const messages = (this.store.aiMessages?.all?.() ?? []).filter(
      (item) => item.role === 'assistant' && item.usage && (!conversationId || item.conversationId === conversationId),
    );

    const sum = { prompt: 0, completion: 0, total: 0, cached: 0, uncached: 0, reasoning: 0 };
    let calls = 0;
    /**
     * 后台调用（`complete()`，例如生成周报）单独累计，再并入总量。
     *
     * 为什么不"只算总量就完事"：用户需要能分辨"这些 token 是我聊天花的，还是后台自动花的" ——
     * 合并显示但**单独报一个 background 字段**，用量气泡里就能解释清楚。
     * 按会话过滤时不计入（后台调用不属于任何会话，硬塞进去会让单会话的数字对不上）。
     */
    const background = { calls: 0, prompt: 0, completion: 0, total: 0, cached: 0 };
    if (!conversationId) {
      for (const row of this.store.aiUsage?.all?.() ?? []) {
        background.calls += Number(row.calls) || 0;
        background.prompt += Number(row.prompt) || 0;
        background.completion += Number(row.completion) || 0;
        background.total += Number(row.total) || 0;
        background.cached += Number(row.cached) || 0;
      }
      // 并进总量：用户看的是"这段时间花了多少"，后台调用（周报之类）当然算在内。
      // 单独留 background 明细只是为了让他能分辨"哪些是自动花的"，不是不计入。
      calls += background.calls;
      sum.prompt += background.prompt;
      sum.completion += background.completion;
      sum.total += background.total;
      sum.cached += background.cached;
      sum.uncached += Math.max(background.prompt - background.cached, 0);
    }
    // 一条回复可能是**多次**上游调用（只读查询一轮一轮地回灌），每次都是真花钱的，都要算。
    //
    // 统计口径（保证**同一轮只算一次**，且对字段的任意组合都成立）：
    //   - 第 1 轮取 `usage ?? usageRounds[0]`、第 2 轮取 `usageFollowup ?? usageRounds[1]`，
    //     第 3 轮起才从 `usageRounds` 里取 —— 新代码这三个字段都落，所以不会重复计；
    //   - **老消息**只有 usage + usageFollowup（没有 usageRounds），照旧全都计入；
    //   - 直接改库的写法（测试里就是只覆写 usage / usageFollowup）也照旧生效，
    //     不会被一个陈旧的 usageRounds 顶掉；3 轮以上同样一个不落；
    //   - 下面还有 `if (!raw) continue;`，所以某轮没有 usage 时不会虚增 calls。
    for (const message of messages) {
      for (const raw of this.#usageRoundsOf(message)) {
        if (!raw) continue;
        calls += 1;
        const completion = Number(raw.completion_tokens) || 0;
        const prompt = Number(raw.prompt_tokens) || 0;
        const cached = Number(raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens) || 0;
        // 有些 OpenAI 兼容端点只给 prompt_tokens，不给缓存细分，那就按"全未命中"算
        const uncached = Number(raw.prompt_cache_miss_tokens) || Math.max(prompt - cached, 0);
        sum.prompt += prompt;
        sum.completion += completion;
        sum.total += Number(raw.total_tokens) || prompt + completion;
        sum.cached += cached;
        sum.uncached += uncached;
        sum.reasoning += Number(raw.completion_tokens_details?.reasoning_tokens) || 0;
      }
    }

    const inputDenominator = sum.cached + sum.uncached;
    return {
      ok: true,
      conversationId: conversationId ?? null,
      replies: messages.length,
      /** 计入口径：一条回复可能是 1 次调用，也可能是多次（每轮只读查询回灌各算一次） */
      calls,
      /** 其中有多少次是**后台调用**（周报这类不带会话的模型请求），以及它们花了多少 —— 与聊天分开报。 */
      background,
      tokens: {
        total: sum.total,
        input: inputDenominator,
        cached: sum.cached,
        uncached: sum.uncached,
        output: sum.completion,
        reasoning: sum.reasoning,
      },
      /** 0~1；没有任何输入 token 时为 null（而不是 0，免得显示成"命中率 0%"误导人）。 */
      cacheHitRate: inputDenominator > 0 ? sum.cached / inputDenominator : null,
    };
  }

  /**
   * 「上下文占用了多少」——给输入框上方那个圆环与明细弹层用（`GET /ai/context?conversationId=`）。
   *
   * 为什么 `used` 优先用**最近一次真实请求的 `prompt_tokens`**：
   *   那一次请求里带的东西（系统提示词 + 工具契约 + 窗口内消息 + 摘要 + 回灌）**就是**"当前上下文有多大"，
   *   而且是上游算的、免费拿到的（usage 已经随消息落库）。自己按字符估，只会在"到底用了几成"这种
   *   要做决定的地方给出一个偏差很大的数 —— 圆环一偏，用户就该压的时候不压、不该压时瞎压。
   *
   * 为什么没 usage 时必须**标 `source: "estimate"`**：
   *   新会话（还没有任何一次请求）或没配密钥时，真实值根本不存在。这时给一个估算是有用的
   *   （能让用户看到"已经堆了多少"），但它和真实 token 不是一回事 —— 把它当真实值展示就是骗人，
   *   所以来源一路带到界面上（圆环 title、弹层底部那行小字都写了来源）。
   *
   * 口径：
   *   - 会话不存在 → 404；不传 conversationId → 400（这一层只管"某个会话的占用"，
   *     全库累计用量在 `/ai/usage` 里，两者不是一回事，别在这里再算一遍）；
   *   - `breakdown` 各分类**永远是字符估算**（真实 usage 不给分类），所以另有 `breakdownSource` 标明；
   *   - 算不准的字段给 `null`（例如 `injection`：记忆/数据注入已经算在 system 里，单列会让分类合计对不上）。
   */
  async contextUsage({ conversationId } = {}) {
    const id = String(conversationId ?? '').trim();
    if (!id) {
      throw HttpError.badRequest('conversationId 不能为空：本接口只报某个会话的上下文占用（全库累计用量看 /ai/usage）', {
        field: 'conversationId',
      });
    }
    const conversation = this.getConversation(id); // 未知 id 一律 404（复用服务层的判定）
    return this.#contextPayload(conversation);
  }

  /**
   * 「立刻压缩上下文」——`/com` 指令与圆环弹层里那个按钮走的就是这一条。
   *
   * 语义与**自动压缩完全同一套**（共用 `#summaryPlan` + `#writeSummary`）：
   *   - 最近 `historyTurns` 轮（= `historyTurns * 2` 条消息）留在窗口里，一个字都不动；
   *   - 更早、且还没进过摘要的部分并进 `summary`（累加/合并，仍受 `SUMMARY_MAX_CHARS` 约束）；
   *   - 待压条数 < `SUMMARY_MIN_MESSAGES` 时**不调模型**（这正是"没有可压缩的部分"），
   *     返回 `compacted:false`，省下一次真金白银的调用；
   *   - 没配密钥 → 501（AI_UNAVAILABLE），不是 500：这不是服务出错，而是这条功能还没被启用。
   *
   * 返回里的 `before`/`after.used` **都用字符估算**（而不是 before 用真实 usage）：
   *   after 的真实值要等下一次请求才存在。若 before 拿"最近一次真实请求"、after 只能估算，
   *   两个数字口径不同，相减出来的"省了多少"就是假的；同口径估算至少让差值可用。
   *   真实总量仍然去 `/ai/context` 看（那里 `source: "prompt_tokens"`）。
   */
  async compact({ conversationId } = {}) {
    const id = String(conversationId ?? '').trim();
    if (!id) throw HttpError.badRequest('conversationId 不能为空', { field: 'conversationId' });
    const conversation = this.getConversation(id); // 不存在 → 404

    // 未配置密钥：**不抛 500**。501 + AI_UNAVAILABLE 是"这个功能还没启用"的既有语义
    // （与 /ai/chat、/ai/nl2command 一致），前端据此显示"未配置密钥，无法压缩"。
    if (!this.provider.configured()) {
      throw new HttpError(501, ERROR_CODES.AI_UNAVAILABLE, 'AI 尚未配置密钥，无法压缩上下文', {
        hint: '在设置里填 API Key，或 POST /api/v1/ai/config {"apiKey":"sk-…"}。',
        provider: this.config.get().provider,
      });
    }

    const plan = this.#summaryPlan(conversation);
    const before = await this.#contextPayload(conversation, { estimateOnly: true });
    const base = {
      ok: true,
      conversationId: conversation.id,
      messages: plan.all.length,
      windowMessages: plan.windowMessages,
      windowTurns: plan.turns,
      before: {
        messages: plan.all.length,
        windowMessages: plan.windowMessages,
        used: before.used,
        source: before.source,
        summaryChars: plan.existing.length,
        // 最近一次真实请求的 prompt_tokens（有就带上）：与估算值并排给出，不做任何换算
        promptTokens: before.real?.tokens ?? null,
      },
    };
    if (plan.fresh.length < SUMMARY_MIN_MESSAGES) {
      return {
        ...base,
        compacted: false,
        reason: 'nothing_to_compact',
        /** 窗口之外、还没进摘要的条数 —— 说明"为什么没压"（不是出错，是还不够压） */
        pending: plan.fresh.length,
        minMessages: SUMMARY_MIN_MESSAGES,
      };
    }

    const written = await this.#writeSummary(conversation, plan);
    if (!written.ok) {
      if (written.error) {
        // 用户显式要求压缩，就该看到失败原因（自动压缩那条路仍然是"悄悄沿用旧摘要"）
        if (written.error instanceof HttpError) throw written.error;
        throw new HttpError(502, ERROR_CODES.UPSTREAM_ERROR, `压缩上下文失败：${written.message}`, {
          hint: '上游这次没返回可用内容；稍后再试一次即可，对话本身不受影响。',
        });
      }
      return { ...base, compacted: false, reason: 'empty_summary', detail: written.message };
    }

    const saved = this.store.aiConversations.get(conversation.id) ?? conversation;
    const after = await this.#contextPayload(saved, { estimateOnly: true });
    // 压缩只改会话的 summary/summaryCount 两个字段，界面上没有任何列表依赖它们
    // （与 `send` 里的自动压缩一致：那里也只广播 ai_message，不额外广播会话变更）。
    return {
      ...base,
      compacted: true,
      /** N：这次新压进去的条数 */
      summarized: written.summarized,
      /** K：摘要**累计**覆盖到第几条（界面上的"覆盖到第 K 条"） */
      covered: written.covered,
      /** M：压缩后的摘要字数 */
      summaryChars: written.text.length,
      after: { used: after.used, source: after.source, summaryChars: written.text.length },
    };
  }

  /** 上游可用的模型列表（给顶栏的模型选择器用）。 */
  async listModels() {
    const result = await this.provider.listModels();
    return { ok: true, current: this.config.get().model, ...result };
  }

  /** 改配置：白名单字段才能进来；`apiKey: ""` 表示清空。 */
  async updateConfig(patch = {}) {
    const next = await this.config.save(patch ?? {});
    // 配置变了要同步 aiBridge 的注册状态：没配密钥时**必须撤掉 provider**，
    // 否则 /ai/nl2command 的 `fallback: "rules"` 降级路径会被一个不可用的 provider 挡死。
    this.onConfigChange?.();
    this.broadcast?.({ type: 'data_changed', module: 'ai', payload: { target: 'ai_config' } });
    return maskAiConfig(next);
  }

  async resetConfig() {
    const next = await this.config.reset();
    this.onConfigChange?.();
    // 与保存配置对称：清空也要广播，否则设置页与顶部徽标会停在旧状态
    this.broadcast?.({ type: 'data_changed', module: 'ai', payload: { target: 'ai_config' } });
    return maskAiConfig(next);
  }

  // ---------------------------------------------------------------- 会话

  listConversations() {
    const items = (this.store.aiConversations?.all?.() ?? [])
      .slice()
      .sort((a, b) => String(b.lastMessageAt ?? b.updatedAt ?? '').localeCompare(String(a.lastMessageAt ?? a.updatedAt ?? '')));
    return { ok: true, count: items.length, items };
  }

  getConversation(id) {
    const record = this.store.aiConversations?.get?.(id);
    if (!record) throw HttpError.notFound(`会话 ${id} 不存在`);
    return record;
  }

  async createConversation(title) {
    return this.store.aiConversations.insert({
      title: String(title ?? '').trim().slice(0, TITLE_MAX) || '新对话',
      messageCount: 0,
      lastMessageAt: null,
    });
  }

  async deleteConversation(id) {
    const record = this.getConversation(id);
    const messages = this.#messagesOf(id);
    await this.store.aiMessages.removeMany(messages.map((item) => item.id));
    await this.store.aiConversations.remove(record.id);
    return { ok: true, deleted: true, id: record.id, messages: messages.length };
  }

  getConversationDetail(id) {
    const conversation = this.getConversation(id);
    const messages = this.#messagesOf(id);
    return { ok: true, conversation, count: messages.length, messages };
  }

  /** 清空全部会话与消息（设置页的「清空全部会话」）。返回删掉了多少，便于回显。 */
  async clearConversations() {
    const conversations = this.store.aiConversations?.all?.() ?? [];
    const messages = this.store.aiMessages?.all?.() ?? [];
    if (messages.length) await this.store.aiMessages.removeMany(messages.map((item) => item.id));
    if (conversations.length) await this.store.aiConversations.removeMany(conversations.map((item) => item.id));
    return { ok: true, deleted: true, conversations: conversations.length, messages: messages.length };
  }

  // ---------------------------------------------------------------- 上下文

  /**
   * 组装「给模型的上下文」。
   *
   * 记忆部分按接口文档 §10 的契约：记忆模块装配了就问它要（`services.memory.inject`），
   * 没装配就返回空预算 —— 这样这一层现在就能用，记忆落地后不用改调用方。
   */
  async buildContext({ view, module, courseId, maxItems, maxChars } = {}) {
    const budget = {
      maxItems: Number(maxItems) > 0 ? Number(maxItems) : DEFAULT_MEMORY_BUDGET.maxItems,
      maxChars: Number(maxChars) > 0 ? Number(maxChars) : DEFAULT_MEMORY_BUDGET.maxChars,
    };
    const now = new Date();
    const today = todayKey(now);
    return {
      ok: true,
      now: now.toISOString(),
      today,
      view: view ?? null,
      module: module ?? null,
      courseId: courseId ?? null,
      memory: await this.#injectMemory({ view, module, courseId, ...budget }),
      recent: this.#recentSummary(today),
    };
  }

  async #injectMemory({ view, module, courseId, maxItems, maxChars }) {
    const memory = this.services?.memory;
    if (typeof memory?.inject !== 'function') return EMPTY_MEMORY(maxItems, maxChars);
    try {
      const result = await memory.inject({ view, module, courseId, maxItems, maxChars });
      const injected = result?.injected ?? [];
      const usedChars = injected.reduce((sum, item) => sum + String(item.text ?? '').length, 0);
      return {
        injected,
        budget: {
          maxItems,
          maxChars,
          usedItems: injected.length,
          usedChars,
          truncated: Boolean(result?.truncated),
        },
      };
    } catch (error) {
      // 记忆坏了不该让对话不可用：降级成空，并把原因留在响应里
      return { ...EMPTY_MEMORY(maxItems, maxChars), error: error.message };
    }
  }

  /** 近期数据摘要：只读别人的集合（契约允许），拿不到就当没有。 */
  #recentSummary(today) {
    const todos = this.store.todos?.all?.() ?? [];
    const schedules = this.store.schedules?.all?.() ?? [];
    const events = this.store.events?.all?.() ?? [];
    const open = todos.filter((item) => !item.completed);
    const within = (event) => {
      const start = event.startDate ?? event.endDate ?? '';
      const end = event.endDate ?? event.startDate ?? '';
      return start <= today && today <= end;
    };
    return {
      todos: {
        open: open.length,
        overdue: open.filter((item) => item.deadline && item.deadline < today).length,
        dueToday: open.filter((item) => item.deadline === today).length,
      },
      today: {
        schedules: schedules.filter((item) => item.date === today).length,
        events: events.filter(within).length,
      },
    };
  }

  // ---------------------------------------------------------------- 对话

  /** 供 `/ai/nl2command` 使用：这条路上由 provider 负责理解，本地规则仍是降级路径。 */
  async nlToCommand(text, context = {}) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) throw HttpError.badRequest('text 不能为空');
    if (!this.provider.configured()) {
      throw new HttpError(501, ERROR_CODES.AI_UNAVAILABLE, 'AI 尚未配置密钥', {
        hint: '配置后本接口即用；不配置也可以传 "fallback": "rules" 走本地规则解析。',
      });
    }
    const enriched = await this.buildContext(context ?? {});
    const result = await this.provider.chat({
      messages: [
        { role: 'system', content: buildCommandSystemPrompt({ ...enriched, ...context, domainBlocks: this.domainBlocks }) },
        { role: 'user', content: trimmed },
      ],
      temperature: 0,
      // 把一句话解析成 JSON 是结构化抽取，开思考纯属烧 token（而且思考模式下 temperature 不生效）
      reasoningEffort: THINKING_LEVELS.none,
    });
    const { drafts } = extractDrafts(result.text);
    if (!drafts.length) {
      return { ok: false, raw: trimmed, warnings: ['模型没有给出可用的指令对象'], explain: result.text.trim().slice(0, 200) };
    }
    return { ...drafts[0], raw: trimmed };
  }

  /**
   * 一次性补全：**不建会话、不落消息、不广播**。
   *
   * 用途：给那些"要一段模型点评，但不该污染对话历史"的场景用 —— 例如学业模块在同步成绩后
   * 生成的「学情分析」小卡片。如果要的是可追溯的多轮对话，用 `send()`。
   *
   * 设计取舍：这里不注入 DOMAIN_RULES / 草稿协议 / 记忆。调用方要的是"就着给定材料写一段话"，
   * 把整套业务规则塞进去既费 token 又容易让模型跑题；需要时由调用方自己在 system 里写清楚。
   *
   * @param {object} input
   * @param {string} input.system 系统提示词（必填）
   * @param {string} input.user   用户消息（必填）
   * @param {number} [input.temperature]
   * @param {string} [input.thinking] `none|low|high|max` 思考档位
   * @returns {Promise<{ ok: boolean, text: string, usage: object|null, model: string, provider: string }>}
   */
  async complete({ system, user, temperature, thinking = 'none' } = {}) {
    const sys = String(system ?? '').trim();
    const ask = String(user ?? '').trim();
    if (!sys) throw HttpError.badRequest('system 不能为空');
    if (!ask) throw HttpError.badRequest('user 不能为空');
    if (!this.provider.configured()) {
      throw new HttpError(501, ERROR_CODES.AI_UNAVAILABLE, 'AI 尚未配置密钥', {
        hint: '配置后本接口即用；未配置时调用方应自行降级到本地统计。',
      });
    }
    const result = await this.provider.chat({
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: ask },
      ],
      temperature: temperature === undefined ? this.config.get().temperature : temperature,
      reasoningEffort: THINKING_LEVELS[thinking] ?? THINKING_LEVELS.none,
    });
    // 后台调用（不带会话的模型请求，例如生成学习周报）也要记账：
    // `/ai/usage` 原来只扫已落库的 assistant 消息，于是这些调用的 token **完全看不见** ——
    // 用户看着"这周才花了这么点"，实际有一部分被周报悄悄花掉了（实测发现的缺陷）。
    await this.#recordBackgroundUsage('complete', result.usage, this.config.get().model);
    return {
      ok: true,
      text: String(result.text ?? '').trim(),
      usage: result.usage ?? null,
      model: this.config.get().model,
      provider: this.config.get().provider,
    };
  }

  /**
   * 记一次"后台模型调用"的用量（按天 + 用途聚合成一条，避免无界增长）。
   *
   * 为什么聚合而不是流水：这些调用的**明细**没有意义（不属于任何会话），
   * 有意义的只是"这段时间后台花了多少"。按 `日期:用途` 记一行，长期也不会把集合撑大。
   * 集合缺失时静默跳过 —— 老数据目录/裁剪过的测试环境不该因此报错。
   */
  async #recordBackgroundUsage(kind, usage, model) {
    const collection = this.store.aiUsage;
    if (!collection || !usage) return;
    try {
      const date = new Date().toISOString().slice(0, 10);
      const id = `${date}:${kind}`;
      const existing = collection.get?.(id);
      const prompt = Number(usage.prompt_tokens) || 0;
      const completion = Number(usage.completion_tokens) || 0;
      const total = Number(usage.total_tokens) || prompt + completion;
      const cached = Number(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens) || 0;
      const patch = {
        date,
        kind,
        model: model ?? null,
        calls: (Number(existing?.calls) || 0) + 1,
        prompt: (Number(existing?.prompt) || 0) + prompt,
        completion: (Number(existing?.completion) || 0) + completion,
        total: (Number(existing?.total) || 0) + total,
        cached: (Number(existing?.cached) || 0) + cached,
      };
      if (existing) await collection.update(id, patch);
      else await collection.insert({ id, ...patch });
    } catch (error) {
      // 记账失败不该影响这次调用本身（用户拿到的是报告，不是一个统计错误）
      this.#log('warn', `后台用量记账失败：${error?.message ?? error}`);
    }
  }

  /**
   * 发一条消息。
   *
   * 内部是**多轮循环**（最多 `MAX_ROUNDS` 轮）：每轮都流式，抽草稿 → 执行只读查询
   * （`auto` 档连写操作一起执行）→ 把结果回灌进上下文再进下一轮，直到某一轮没查出新查询。
   *
   * @param {object} input
   * @param {string} input.text 用户输入
   * @param {string} [input.conversationId] 不传则新建会话
   * @param {object} [input.context] `{ view, module, courseId }`
   * @param {boolean} [input.stream] 是否边生成边通过 WebSocket 广播
   * @param {string} [input.permission] 写入权限：`auto|manual|strict`，非法值回落 `manual`
   * @param {string} [input.search] 联网档位：`off|web|campus`，非法值回落 `off`
   */
  async send({
    text,
    conversationId,
    context = {},
    stream = false,
    attachments = [],
    thinking = 'high',
    permission = 'manual',
    search = 'off',
  } = {}) {
    const trimmed = String(text ?? '').trim();
    const files = normalizeAttachments(attachments);
    const model = this.config.get().model;
    const images = files.filter((file) => IMAGE_TYPES.includes(file.type) && file.dataUrl);
    if (images.length && isKnownNonVisionModel(model)) {
      throw HttpError.badRequest(`${model} 不支持图片输入；换成 deepseek-flash 再发，或去掉图片`, {
        field: 'attachments',
        hint: '官方「图像理解」文档：目前只有 deepseek-flash 支持看图',
      });
    }
    // 图片先走官方 Files API 上传（同内容复用本地记录，不重复上传）；
    // 上传失败不阻断对话：退回内联 base64，并在响应里说明。
    const uploadWarnings = [];
    for (const file of images) {
      if (!this.files) break;
      try {
        const uploaded = await this.files.ensureUploaded(file);
        if (uploaded?.fileId) file.fileId = uploaded.fileId;
      } catch (error) {
        uploadWarnings.push(`${file.name} 上传失败（${error.message}），已改用内联图片`);
      }
    }
    // 允许"只发附件不写字"，但两者都空就没意义
    if (!trimmed && !files.length) throw HttpError.badRequest('text 不能为空');
    const effort = THINKING_LEVELS[thinking] ?? 'high';
    const mode = PERMISSIONS.includes(permission) ? permission : 'manual';
    // 联网档位非法就回落 `off`：它只影响提示词，**不能**因为前端传了个没见过的值就整次对话失败
    const searchMode = SEARCH_MODES.includes(search) ? search : 'off';
    if (!this.provider.configured()) {
      throw new HttpError(501, ERROR_CODES.AI_UNAVAILABLE, 'AI 尚未配置密钥，无法对话', {
        hint: '在设置里填 API Key，或 POST /api/v1/ai/config {"apiKey":"sk-…"}。',
        provider: this.config.get().provider,
      });
    }

    const conversation = conversationId
      ? this.getConversation(conversationId)
      : await this.createConversation(trimmed || files[0]?.name || '新对话');

    /**
     * 停止开关：这一次 send 里**所有**上游调用与工具执行都挂在它上面（见 `#runTurn`）。
     * 它在排队**之前**建好，但只有真正开始跑的那一轮才登记进 `#turns` ——
     * 排队中的请求不该被 stop 打到（它连一条 assistant 消息都还没有）。
     */
    const controller = new AbortController();
    /**
     * 消息排队（服务端这一半）：**同一个会话同一时刻只跑一轮**。
     *
     * 为什么必须排队：界面允许用户在模型还在回答时继续发下一条（排队发送）。
     * 如果两轮并行，会有两个后果 ——
     *   1. 两条 assistant 占位消息交替流式，用户看到两个气泡同时在长，时间线也乱了；
     *   2. 后一轮组装上下文时会把前一轮刚落的用户消息也读进去，等于"抢答"了下一句。
     * 只影响**同一会话**：换到别的会话提问照旧并行，不该被别人的长回答堵住。
     * 排队期间 HTTP 请求就挂着（不返回），这正合"排队"的语义：轮到了才开始跑。
     */
    const releaseTurn = await this.#acquireTurn(conversation.id);
    try {
      return await this.#runTurn({
        conversation,
        trimmed,
        files,
        context,
        stream,
        thinking,
        effort,
        mode,
        searchMode,
        model,
        uploadWarnings,
        controller,
      });
    } finally {
      // 先撤销登记再放行排队者：反过来的话，下一个请求可能已经占用了这一格
      this.#forgetTurn(conversation.id, controller);
      releaseTurn();
    }
  }

  /**
   * 停止正在跑的那一轮（`POST /ai/chat/stop`）。
   *
   * 两种返回，都是 200：
   *   - 有在跑的回合 → `{ ok:true, stopped:true, conversationId, messageId }`，并立刻广播
   *     `chat_stopped`；那一轮会在很短时间内以 `status:"stopped"` 收尾落库。
   *   - 没有在跑的回合 → `{ ok:true, stopped:false, reason:'idle' }`。**不是错误**：
   *     用户连点两下、或消息刚好答完，都不该看到一个 500。
   *
   * 为什么先收尾清单再 abort：plan 的广播在 `abort` 之后会被静音（见 TurnPlan.emit），
   * 最后一份 steps 就发不出去了 —— 而"停止那一刻把没跑完的步骤标成 failed"
   * 恰恰是界面最需要的那一份（否则卡片上永远转圈）。
   */
  stop({ conversationId } = {}) {
    const id = String(conversationId ?? '').trim();
    if (!id) throw HttpError.badRequest('conversationId 不能为空', { field: 'conversationId' });
    const turn = this.#turns.get(id);
    // 已经在收尾（phase 不是 running）或已经被停止过：一律按"空闲"回答，重复点击不报错
    if (!turn || turn.phase !== 'running' || turn.controller.signal.aborted) {
      return { ok: true, stopped: false, reason: 'idle' };
    }
    turn.phase = 'stopping';
    turn.plan?.settle('failed');
    turn.plan?.close();
    turn.controller.abort();
    this.broadcast?.({
      type: 'chat_stopped',
      module: 'ai',
      payload: { conversationId: id, messageId: turn.messageId ?? null },
    });
    return { ok: true, stopped: true, conversationId: id, messageId: turn.messageId ?? null };
  }

  /**
   * 真正跑一轮对话（拿到排队位置之后才会进来）。
   *
   * 拆成两个方法只为一件事：让"排队 → 执行 → 收尾"这条线有一个 `finally`
   * —— 无论是正常答完、出错还是被停止，回合登记都必须撤销、锁都必须放掉。
   * 方法体与拆分前逐行一致（原来的 `send` 从这里往后原样搬过来）。
   */
  async #runTurn({ conversation, trimmed, files, context, stream, thinking, effort, mode, searchMode, model, uploadWarnings, controller }) {
    /**
     * 登记"正在跑的回合"。
     *
     * messageId 先留 null：占位的 assistant 消息要等上下文与摘要都准备好才建，
     * 而"用户按下停止"完全可能发生在那之前 —— 那时也必须能停，否则用户会看到
     * "我明明点了停止，它却接着答完了"（长对话的摘要那一步就是一次几秒的上游调用）。
     */
    const turn = { messageId: null, controller, plan: null, phase: 'running' };
    this.#turns.set(conversation.id, turn);
    const signal = controller.signal;
    const userMessage = await this.#appendMessage({
      conversationId: conversation.id,
      role: 'user',
      content: trimmed,
      // 只落**元信息**（含 Files API 的 file_id）：base64 动辄几 MB，塞进 JSON 集合会把业务数据文件撑爆
      attachments: files.map((file) => ({ name: file.name, type: file.type, size: file.size, fileId: file.fileId ?? null })),
      thinking,
      permission: mode,
      // 联网档位跟着消息落库：事后排查"它当时是不是以为自己能联网"要看这个
      search: searchMode,
    });

    const enriched = await this.buildContext(context);
    // 长对话：把窗口之外的旧内容压成摘要（失败就沿用旧摘要，绝不因此发不出消息）
    const summary = await this.#ensureSummary(conversation, signal);
    // 作图：设置里开着就给（默认开），关着但用户用了「画…」这类指令词也临时给
    const draw = this.config.get().drawMode !== false || DRAW_KEYWORDS.test(trimmed);
    /**
     * 本轮最多自动执行几个写操作（设置项 `maxActionsPerTurn`，0 = 不限制）。
     * 每回合只读一次：一次提问过程中用户改设置是极端情况，中途换数只会让"前面已执行几条"
     * 的账算不清；这里取的是回合开始时的值，并在下面作为**整个回合**的累计预算使用。
     */
    const maxActions = normalizeMaxActionsPerTurn(this.config.get().maxActionsPerTurn);
    const history = this.#history(conversation.id);
    // #history 里最后一条就是刚存的用户正文，这里换成"正文 + 附件"的多模态版本
    const messages = [
      {
        role: 'system',
        content: buildChatSystemPrompt({
          ...enriched,
          ...context,
          draw,
          domainBlocks: this.domainBlocks,
          // 档位与联网开关也要进提示词：模型据此知道"能不能直接动手、要不要先问一句"，
          // 以及"检索其实还没接入，别编搜到的内容"（prompt.js 读 context.permission / context.search）。
          // 放在展开之后，免得请求体里的 context 把这轮的选择覆盖掉。
          permission: mode,
          search: searchMode,
          // 提示词里"一轮最多 N 条写入草稿"的 N 与下面真正执行用的是**同一个配置值**
          // （0 = 不限制），不做任何字符串替换 —— prompt.js 是纯函数拼装。
          maxActionsPerTurn: maxActions,
          // 摘要由上面 #ensureSummary 产出/复用；没有就是空串，提示词里不会多一段
          summary,
        }),
      },
      ...history.slice(0, -1),
      { role: 'user', content: buildUserContent(trimmed, files) },
    ];

    // 先落一条占位消息：流式 delta 需要一个稳定的 messageId
    const assistant = await this.#appendMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: '',
      status: stream ? 'streaming' : 'pending',
      model: this.config.get().model,
      provider: this.config.get().provider,
      thinking,
      permission: mode,
      // 占位消息就把联网档位写上：万一这次调用半路失败，记录里也留得住"当时是什么档位"
      search: searchMode,
    });

    // 占位消息落库之后才知道 messageId：补进登记，并建这一轮的「过程清单」
    turn.messageId = assistant.id;
    const plan = new TurnPlan({
      conversationId: conversation.id,
      messageId: assistant.id,
      broadcast: this.broadcast,
      // 停止之后不再广播 plan 的任何后续步骤（迟到的全量快照也不行）
      isAborted: () => signal.aborted,
    });
    turn.plan = plan;

    // 一次 send 里所有"跨轮"的状态都提到循环外面 —— 它们最终要一起落库/回显
    let partial = '';            // 本轮已流出的正文（第一轮就失败时，这就是能留住的那半句）
    let reasoningAll = '';       // 思维链：**跨轮累积**，一张「思考过程」卡里看得到全部轮
    const usageRounds = [];      // 每轮的 usage（/ai/usage 按它算多次调用）
    const queried = [];          // 只读查询结果：跨轮累积
    const executed = [];         // 自动执行的写操作：跨轮累积
    let drafts = [];             // 留给用户确认的草稿（没执行的，含校验不过的）
    /**
     * 因**超出本轮执行上限**而没有自动执行的写草稿：跨轮累积。
     * 它们同时已经进了 `drafts`（走人工确认卡），这里单独留一份是为了给模型/调用方
     * 说清"还有几条没执行" —— 只靠 drafts 区分不出"校验不过"与"上限截断"。
     */
    const deferredByLimit = [];
    let content = '';            // 被采纳的那一轮正文（每轮都会被下一轮覆盖）
    /**
     * 「停止时该落的正文」= 用户此刻在屏幕上看到的那一份。
     * 流式的每一块 delta 都会更新它（那时还没抽掉草稿，正是屏幕上的样子），
     * 每轮抽完草稿再用干净版覆盖一次 —— 这样"按了停止"不会让正文突然倒回去。
     */
    let lastContent = '';
    let lastRaw = null;          // 最近一轮"抽草稿前"的原文
    let lastModel = model;
    let lastFinishReason = null;
    let queryError = null;
    let hitRoundLimit = false;
    /** 空承诺兜底只用一次（见循环末尾 `looksLikePromise`）。 */
    let promisedNudge = false;
    let rounds = 0;
    /**
     * 联网检索预算（用户第 1 条："查不到之后自己重试，但次数太多就停"）。
     * **一个回合一份、跨轮累计**：模型在第 3 轮发起的那次检索同样消耗这一份。
     */
    const searchBudget = createSearchBudget(this.config.get().searchRetryMax);
    /**
     * 停止收尾：用**此刻**已经积累的状态把这条消息落成 `stopped`。
     * 写成闭包是因为它读的是这些 `let` 变量的最终值（不是快照），
     * 于是循环外面与 catch 里可以共用同一份逻辑。
     */
    const finishStopped = () => this.#saveStopped({
      conversation,
      assistant,
      userMessage,
      trimmed,
      partial,
      content: lastContent,
      reasoningAll,
      usageRounds,
      queried,
      executed,
      drafts,
      lastRaw,
      lastModel,
      lastFinishReason,
      rounds,
      mode,
      searchMode,
      thinking,
      uploadWarnings,
    });
    // 停止可能发生在摘要 / 建占位消息这段时间里（摘要也是一次上游调用）：立刻按"已停止"收尾
    if (signal.aborted) return await finishStopped();
    try {
      // 上下文逐轮追加（回灌 = 追加一条 assistant 草稿 + 一条注入结果的 user），
      // 所以下一轮**看得到**前面所有轮查过什么，不会把同一条查询再问一遍。
      let turnMessages = messages;
      for (let round = 1; round <= MAX_ROUNDS; round += 1) {
        // 用户按了停止：**立刻跳出**，不再追加轮数（也不广播任何后续 plan 步骤）
        if (signal.aborted) break;
        // "实际调用轮数"按发出去了几次算：最后一轮哪怕上游报错，它也确实被调过
        rounds = round;
        // 本轮状态清零。reset 之后前端渲染的就是"这一轮"从零长出来的正文，
        // 详见下面 onDelta 里的说明。
        partial = '';
        let roundReasoning = '';
        let started = false;
        let result;
        try {
          result = await this.provider.chat({
            messages: turnMessages,
            // **每一轮都流式**：回灌之后的轮次以前是静默的（界面几秒不动，用户以为断了），
            // 现在"我查一下 → 拿到数据 → 回答"整个过程都有增量可看。
            stream: Boolean(stream),
            reasoningEffort: effort,
            // 停止要能打断**正在流式输出**的上游调用：provider 把它接到 fetch 的
            // AbortSignal 上（见 provider.js 的 forwardAbort），abort 会让这个 await 直接抛错
            signal,
            onDelta: stream
              ? (delta) => {
                  if (!started) {
                    started = true;
                    // 每轮的第一块 delta 先广播一条 reset，让前端清空气泡。
                    // 不 reset 的话"我查一下……"会和最终答案粘在同一段里，用户看到的是一段
                    // 自相矛盾的半成品；而模型每轮说的话都是**独立**的一段，渲染层只有收到
                    // reset 才知道该翻页。（delta/text 都给空串，前端不必特判 undefined。）
                    this.broadcast?.({
                      type: 'ai_delta',
                      module: 'ai',
                      payload: {
                        conversationId: conversation.id,
                        messageId: assistant.id,
                        reset: true,
                        delta: '',
                        text: '',
                        round,
                      },
                    });
                  }
                  partial += delta;
                  // 停止时要落的正文就是"用户此刻看到的这一段"
                  lastContent = partial;
                  this.broadcast?.({
                    type: 'ai_delta',
                    module: 'ai',
                    payload: {
                      conversationId: conversation.id,
                      messageId: assistant.id,
                      delta,
                      // text 是**本轮**的累计正文（不是各轮拼起来），前端照着覆盖气泡即可
                      text: partial,
                      round,
                    },
                  });
                }
              : undefined,
            // 思维链单独一条通道：前端把它放进默认折叠的「思考过程」卡里，不和正文混在一起。
            // 这里累积的是**全部轮**的思考，用户顺着它就能看出"先查了什么、又想写什么"。
            onReasoning: stream
              ? (delta) => {
                  roundReasoning += delta;
                  reasoningAll += delta;
                  this.broadcast?.({
                    type: 'ai_delta',
                    module: 'ai',
                    payload: {
                      conversationId: conversation.id,
                      messageId: assistant.id,
                      channel: 'reasoning',
                      delta,
                      text: reasoningAll,
                      round,
                    },
                  });
                }
              : undefined,
          });
        } catch (error) {
          // 停止导致的 AbortError 不是"这一轮没成"：不记 PARTIAL，直接交给收尾按 stopped 落库
          if (signal.aborted) break;
          // 第一轮就失败 = 这条回复彻底没成，照旧往上抛（外层把消息标 failed）
          if (round === 1) throw error;
          // 后面几轮失败只是"总结这一步没成"：已经查到的数据必须照常返回给用户，
          // 所以只记 PARTIAL 然后收尾（数据靠 queried 卡片呈现）。
          queryError = error?.message ?? '查询结果总结失败';
          break;
        }

        // 上游这一段刚跑完就收到停止：不再处理这一轮的结果（更不执行任何草稿）
        if (signal.aborted) break;
        usageRounds.push(result.usage ?? null);
        // 模型名与结束原因取**最后一轮**：多轮里只有最后那轮说的话是给用户看的
        lastModel = result.model ?? this.config.get().model;
        lastFinishReason = result.finishReason ?? null;
        // 非流式时思考链只在 result 里；流式时 result.reasoning 与 onReasoning 收到的是同一份
        // 增量（上面已经累积过），这里判一下别拼两遍 —— 也兼容"只在最终结果里给思考"的 provider
        if (!roundReasoning) reasoningAll += String(result.reasoning ?? '');

        const extracted = extractDrafts(result.text ?? partial);
        const previewed = await previewDrafts(this.commands, extracted.drafts);
        // 抽掉草稿后的正文：本轮它就是"当前的最终答案"（下一轮会把它覆盖掉）
        content = extracted.text;
        lastContent = content;
        // 原文只在"这轮确实抽出了草稿"时更新：排查"模型到底说了啥"时只有这里有，
        // 而纯自然语言那一轮（content 就等于原文）留着也是重复。
        if (extracted.drafts.length) lastRaw = result.text ?? partial ?? '';

        /**
         * 过程清单：**只从这一轮的草稿里**登记步骤。
         *
         * 纯聊天（这一轮没有任何草稿）→ 一份 plan 都不广播：不给简单问题套一层假进度条，
         * 那只会让用户以为系统在背后跑了一堆东西。同一条草稿（业务指纹相同）只登记一次。
         */
        plan.addAll(previewed);
        for (const entry of previewed) {
          // 预校验就没过的草稿不会再有"运行"这一步：直接把步骤落成 failed（黄灯不能一直转）
          if (entry.error) plan.finish(entry, entry.error);
        }
        if (signal.aborted) break;

        // ── 写操作 ──────────────────────────────────────────────────────────
        // 「自动审批」**每一轮**都要跑：以前只在第一轮回灌前执行一次，于是"先查一次、再照着写"
        // 这条最常见的路径里，第二轮才冒出来的写草稿再也无人执行 —— 这正是用户说的
        // "自动审批没啥用"。没执行的（校验不过的、非 auto 档的）留在 drafts 里走人工确认卡。
        const autoQuery = mode !== 'strict';
        /**
         * 本轮要处理的写草稿：**一轮可以有多条**。
         *
         * 「一句话三件事」以前只落一件，根因不在这里（提示词只让模型给一条，见 prompt.js），
         * 但这里也不能只取 `previewed[0]` —— 提示词放开成"最多 3 条"之后，三条必须**都**走完
         * 预览→执行这条路。数组顺序与模型输出的顺序一致，落库顺序因此也是用户说话的顺序。
         */
        let roundDrafts = autoQuery
          ? previewed.filter((entry) => entry.draft?.action !== 'query' || entry.error)
          : previewed;
        // 同一条写操作被模型重复输出时**只能执行一次** —— auto 档尤其致命：
        // 它会落两条一模一样的记录。模型看不到自己上一轮输出过的 ```command 块（回灌时草稿已经
        // 被抽掉了），只看到"我准备加一条待办"的正文，所以它在后面某一轮把同一件事再说一遍很常见。
        // 注意：写结果现在会**回灌**（见下面的 #withExecutionResults），模型更容易"把刚做完的事
        // 再说一遍"（它想确认），所以这道指纹去重是必需的，不是可选的优化。
        /**
         * 已经处理过的写入 = 执行过的 + **因上限留成确认卡**的。
         *
         * 后者也要算进来：模型下一轮很可能把刚被截断的那几条再说一遍（它只看到自己说过
         * "我加上这几条"，不知道哪几条没执行）。若不算，它们会被当成新草稿再次进入执行队列，
         * 既可能重复出卡，也会让"回灌 → 再答"多绕好几轮。同一件事只处理一次。
         */
        const doneKeys = new Set(
          [...executed, ...deferredByLimit].map((item) => this.#draftKey(item.entry ?? item)),
        );
        /**
         * 真正要执行的写草稿 = 跨轮去重（`doneKeys`）+ **轮内去重**。
         *
         * 轮内去重不是防御性编程：模型经常把同一件事写两遍（正文里列一遍、再单独给一条草稿），
         * 抽出来就是两条一模一样的草稿 —— 以前两条都会被 auto 档执行掉，库里落两条重复记录。
         * 确认卡那条路（下面的 `seenDrafts`）一直有去重，写库这条路漏了；一轮允许多条草稿之后
         * 这个漏洞更容易被触发，所以在这里一次收干净。
         */
        const freshWrites = [];
        const freshKeys = new Set(doneKeys);
        for (const entry of roundDrafts) {
          const key = this.#draftKey(entry);
          if (freshKeys.has(key)) continue;
          freshKeys.add(key);
          freshWrites.push(entry);
        }
        /**
         * 「一轮最多执行几个操作」：**服务端真正执行限制**，不能只靠提示词。
         *
         * 提示词已经把 N 告诉模型了，但模型完全可能一口气给 5 条 —— 提示词是"请求"，这里才是"事实"。
         * 只把前 N 条交给 `#autoExecuteWrites`，其余**不丢**：留在 `drafts` 里走人工确认卡
         * （manual 语义，用户自己决定点不点）。这条"不静默丢弃"是硬要求：用户看到的应该是
         * "办了 3 件、还有 2 件等你确认"，而不是"说了 5 件只办了 3 件、另外 2 件凭空消失"。
         *
         * 口径：
         *   - 预算按**整个回合**累计（`executed` 跨轮），不是每轮各给 N 条 —— 用户设"一轮最多 3 个操作"，
         *     期望的是"这次提问最多自动改 3 处"，而不是"模型每多说一轮就再多改 3 处"；
         *   - 只统计**可执行**的写草稿：校验不过的本来就不会执行，不该白占名额；
         *   - `0` = 不限制：全部交给执行器（仍受 `MAX_ROUNDS` 与去重约束）；
         *   - manual / strict 档一条都不走这里，因此**不受这个上限影响**：确认卡列表不截断。
         */
        const writableWrites = freshWrites.filter(
          (entry) => !entry.error && entry.draft?.action !== 'query' && entry.draft?.ok !== false,
        );
        const remainingSlots = maxActions === MAX_ACTIONS_UNLIMITED
          ? writableWrites.length
          : Math.max(maxActions - executed.length, 0);
        const allowedWrites = writableWrites.slice(0, remainingSlots);
        const deferredWrites = mode === 'auto' ? writableWrites.slice(remainingSlots) : [];
        const executedNow = mode === 'auto' ? await this.#autoExecuteWrites(allowedWrites, { signal, plan }) : [];
        if (deferredWrites.length) {
          /**
           * 给每张被截断的确认卡补一句"为什么没自动执行"。
           *
           * 写进 `draft.warnings` 而不是另造字段：确认卡本来就会渲染 warnings（见 shell 的 draftCard），
           * 不需要改渲染层；用户点开卡片就能看到"超出上限、需要确认"，而不是以为自己点错了什么。
           */
          const notice = maxActions === MAX_ACTIONS_UNLIMITED
            ? '本轮没有执行条数限制，这条没有自动执行（原因见回灌说明）。'
            : `本轮最多自动执行 ${maxActions} 个操作（设置项「一轮最多执行几个操作」），这条超出了上限，`
              + '**没有自动执行**：点「确认执行」后才会落库。';
          for (const entry of deferredWrites) {
            entry.draft = { ...entry.draft, warnings: [...(entry.draft?.warnings ?? []), notice] };
          }
          deferredByLimit.push(...deferredWrites);
        }
        if (executedNow.length) {
          roundDrafts = freshWrites.filter((entry) => !executedNow.some((item) => item.entry === entry));
          executed.push(...executedNow);
        } else {
          roundDrafts = freshWrites;
        }
        // 同一条草稿被模型在多轮里重复输出时只留第一张确认卡：
        // 否则用户会看到两张一模一样的按钮，不知道该点哪个。
        const seenDrafts = new Set(drafts.map((entry) => this.#draftKey(entry)));
        for (const entry of roundDrafts) {
          const key = this.#draftKey(entry);
          if (seenDrafts.has(key)) continue;
          seenDrafts.add(key);
          drafts.push(entry);
        }

        // ── 只读查询 ────────────────────────────────────────────────────────
        // 只读查询**自动执行**：查询不改数据，让用户为"我明天有什么课"点一次确认毫无意义，
        // 更关键的是模型看不到结果就只能说"我拿不到数据"（实测它真的会这么说）。
        // 先按草稿去重再执行：模型拿到结果后很容易把同一条查询原样再发一遍（想"再确认一次"），
        // 不拦的话 MAX_ROUNDS 会被重复查询烧光，最终答案永远出不来。
        // 「全部确认」档：连只读查询也要用户点确认，所以一条都不自动跑。
        const fresh = autoQuery
          ? await this.#runReadOnlyQueries(previewed.filter((entry) => !this.#isRepeatQuery(entry, queried)), {
              // 联网档位是**这次请求**的属性，必须一路传进执行器（见 #runWebQuery）
              searchMode,
              // 停止信号、过程清单、检索预算也一起带下去：执行器是真正"动手"的地方
              signal,
              plan,
              searchBudget,
              // 用户原话透传给 DeepSeek 官方 Search 的 ori_question（帮助理解检索意图）
              oriQuestion: trimmed,
            })
          : [];
        queried.push(...fresh);
        // 查询/检索跑到一半被停止：立刻跳出，不再执行后面的任何草稿
        if (signal.aborted) break;

        /**
         * **循环终止条件**：这一轮既没有查出"新"查询、也没有真执行写操作 = 模型这轮是在直接
         * 回答用户，它就是最终回答，收尾。这条判断覆盖三种正常结束：纯聊天（压根没草稿）、
         * 查完之后开始作答（模型不再发查询草稿）、以及 auto 档写完之后的最后一句总结。
         *
         * `executedNow.length` 这一项是**缺陷 1 的另一半**：以前只看 `fresh`，于是 auto 档把日程
         * 写进库之后循环立刻结束，写操作的执行结果（尤其是 `conflicts`）根本没机会回到模型那里 ——
         * 正文只会说"给你加上"，绝口不提"这条和你的英语晨读重叠了"。现在真写了就回灌一轮，
         * 让模型有机会把系统刚做的事说清楚。
         *
         * 代价（**只为这一种情况多花一次上游调用**）：auto 档每执行掉一条写操作就多一轮模型调用。
         * 一次对话"加三条安排"从 1 次调用变成 2 次，这一轮的 token 大约翻倍 —— 这是明知故犯的取舍：
         * 用户要的是"它真的做了，而且知道发生了什么"，一句"已经加好了"配上一句"但这条撞了你的英语晨读"
         * 才是自动审批该有的样子；没执行写操作时（只读查询 / 纯聊天 / manual 档）照旧收尾，一次都不多花。
         */
        /**
         * **"我再搜一次"式空承诺的确定性兜底**（真机事故：用户问"最近我们航天学院有什么新闻吗"，
         * 模型回了一句"我再搜一次学院近期的新闻。"、**一条检索草稿都没发**，循环按"这轮答完了"收尾，
         * 用户屏幕上只有一句空话 —— 这正是用户截图里的"？？？"）。
         *
         * 提示词里已经写过"说了要查就必须同轮带上草稿"，但**不能指望模型每次都听话**：
         * 这里做一次确定性的补救 —— 一旦这轮"既没有新查询、也没有执行写入"，而正文又**明显是在
         * 承诺要去查/去看**，就注入一条系统提醒再跑一轮，逼它要么发草稿、要么把话说完整。
         *
         * 只补救一次（`promisedNudge`）：模型第二次仍然只说不做时就按它的原话收尾 ——
         * 无限催下去只会烧钱，而且用户至少能看到"它确实卡住了"。
         */
        const looksLikePromise =
          !extracted.drafts.length &&
          looksLikePromiseToLook(extracted.text) &&
          !promisedNudge &&
          round < MAX_ROUNDS;
        if (looksLikePromise) {
          promisedNudge = true;
          turnMessages = [
            ...turnMessages,
            {
              role: 'user',
              content:
                '[系统注入] 你上一句说了要检索/去看，但**没有发出 ```command 草稿**，系统因此什么都没做。\n' +
                '现在请立刻在这一轮里发出检索草稿（需要联网用 target:"web"，读指定网址用 fields.url）；\n' +
                '如果你其实不需要检索，就把答案直接写完整：已知什么、缺什么、下一步建议。\n' +
                '注意：只写"我再查一次"而没有草稿，系统会把它当成你的最终答复发给用户。',
            },
          ];
          continue;
        }
        /**
         * 终止条件加了一项 `deferredWrites.length`：**被上限截断的这一轮也要回灌**。
         *
         * 不这么做的话，auto 档第二轮才冒出来的写草稿被截断时，循环直接收尾，模型永远不知道
         * 它们没执行 —— 它下一句很可能照旧说"都加好了"，而用户看到的却是几张待确认卡。
         * 回灌一轮让它知道"还有 M 条没执行"，它才有机会改口（也算"超出上限要说明"的兜底）。
         * 不会因此死循环：被截断的草稿指纹已经进了 `doneKeys`，模型原样重发时不会再次触发。
         */
        if (!fresh.length && !executedNow.length && !deferredWrites.length) break;
        // 还有新查询（或刚写完 / 刚被截断还没回灌）、但轮数已经用光：记下来，调用方据此知道
        // "答案是被上限截断的"，而不是以为模型就答了这么点。
        if (round >= MAX_ROUNDS) {
          hitRoundLimit = true;
          break;
        }
        // 把这一轮的结果回灌进上下文，进入下一轮 —— 这才是真正的工具循环
        turnMessages = this.#withExecutionResults(turnMessages, extracted.text, {
          queried: fresh,
          executed: executedNow,
          // 因上限没执行的也要说：模型据此改口，不谎报"都办好了"
          deferred: deferredWrites,
          maxActions,
        });
      }

      // 循环因停止而跳出：按"已停止"收尾（正文保留停止前的内容），绝不落成 done
      if (signal.aborted) return await finishStopped();
      // 已经进入收尾：这之后到来的 stop 一律回 idle（消息马上就落库了，不该再被打断）
      turn.phase = 'finishing';
      /**
       * 收尾时把清单落成终态：还在 pending 的（例如等用户确认的写操作）也算"系统这一步做完了"，
       * 界面因此不会留下一排永远转圈的步骤。
       */
      plan.settle('done');
      const saved = await this.store.aiMessages.update(assistant.id, {
        // 正文 = **最后一轮**抽掉草稿后的话；它为空时按"这一刻的事实"兜底：
        // 查过数据就说查到了、自动执行过写操作就说处理好了（细节另有数据卡片/回执卡）。
        // 有草稿被上限截断时优先说这一句：只报"处理好了"会让用户以为全部办完了。
        content: content || (
          deferredByLimit.length
            ? executed.length
              ? `已经自动执行 ${executed.length} 个操作，另有 ${deferredByLimit.length} 条超出本轮上限、等你确认。`
              : `另有 ${deferredByLimit.length} 条写入草稿超出本轮上限、等你确认。`
            : queried.length
              ? '已经查到数据。'
              : executed.length
                ? '已经照你说的处理好了。'
                : ''
        ),
        // 草稿 / 已执行 / 查询都是**跨轮累积**：用户看到的应该是整次交互的全貌
        drafts,
        executed,
        // 执行上限的**机读回执**：前端/排查都能看出"这一轮设了 3、执行了 3、截下 2 条"。
        // 人话提示同时在 drafts[].draft.warnings 里（确认卡上可见）。
        actionLimit: {
          max: maxActions,
          unlimited: maxActions === MAX_ACTIONS_UNLIMITED,
          executed: executed.length,
          deferred: deferredByLimit.length,
        },
        thinking,
        permission: mode,
        search: searchMode,
        // 思维链最多留 2 万字：它是给人看/排查的，不是数据
        reasoning: reasoningAll.slice(0, 20_000) || null,
        // 只读查询的原始结果：前端据此画数据卡片，也方便排查"模型到底看到了什么"
        queried,
        status: 'done',
        model: lastModel,
        usage: usageRounds[0] ?? null,
        usageFollowup: usageRounds[1] ?? null,
        // 每轮 usage 都留着：一次回复可能是好几次上游调用，token 统计不能只算前两次
        usageRounds,
        // 实际调了几轮、是不是撞上了上限（撞上 = "它还想查，但轮数用完了"）
        rounds,
        roundLimit: hitRoundLimit,
        finishReason: lastFinishReason,
        // 抽掉草稿前的原文留着：排查"模型到底说了啥"时只有这里有
        raw: drafts.length || executed.length ? lastRaw : null,
        // 只有"总结失败"这一种部分失败：已经查到的数据本身照常返回
        error: queryError ? { code: 'PARTIAL', message: queryError } : null,
      });
      await this.#touchConversation(conversation.id, trimmed);
      this.broadcast?.({
        type: 'ai_message',
        module: 'ai',
        payload: { conversationId: conversation.id, message: saved, drafts, queried, rounds, roundLimit: hitRoundLimit },
      });
      const savedConversation = this.store.aiConversations.get(conversation.id);
      return {
        ok: true,
        conversation: savedConversation,
        /**
         * 这次回复是否刚做过"滚动摘要"：界面据此提示一句"较早的内容已压缩"。
         * 为什么要让用户看见：上下文被压缩后模型的记忆方式变了（早期细节只剩摘要），
         * 用户有权知道这件事发生过，而不是某天发现"它怎么忘了我说过的话"。
         */
        compacted: summary
          ? { active: true, chars: summary.length, covered: Number(savedConversation?.summaryCount ?? 0) }
          : { active: false },
        user: userMessage,
        assistant: saved,
        drafts,
        queried,
        executed,
        /** 执行上限回执：`{ max, unlimited, executed, deferred }`（0 = 不限制）。 */
        actionLimit: saved.actionLimit,
        // 把这一轮的选择回显给调用方：前端据此在气泡上标注"自动执行/思考强度/联网"
        thinking,
        permission: mode,
        search: searchMode,
        // 调了几轮、是否撞上轮次上限
        rounds,
        roundLimit: hitRoundLimit,
        warnings: uploadWarnings,
      };
    } catch (error) {
      // 停止也会让上游抛错（AbortError）；那不是失败，按"已停止"落库，绝不标成 failed
      if (signal.aborted) return await finishStopped();
      const failure = {
        code: error instanceof HttpError ? error.code : ERROR_CODES.INTERNAL,
        message: error?.message ?? 'AI 调用失败',
      };
      const saved = await this.store.aiMessages.update(assistant.id, {
        content: partial,
        status: 'failed',
        error: failure,
        raw: partial || null,
      });
      await this.#touchConversation(conversation.id, trimmed);
      this.broadcast?.({
        type: 'ai_message',
        module: 'ai',
        payload: { conversationId: conversation.id, message: saved, drafts: [] },
      });
      throw error;
    }
  }

  // ---------------------------------------------------------------- 回合登记 / 停止 / 排队

  /**
   * 会话级的排队锁：拿到它才能开始跑这一轮。
   *
   * 实现就是"一条链"：后一个请求把前一个的 promise 当自己的前置条件，
   * 于是顺序严格按到达先后（FIFO），不需要定时器、不需要轮询、也不会饿死谁。
   * 返回的 `release` **必须**放在 `finally` 里调用 —— 漏一次，这个会话就永远卡住了。
   */
  async #acquireTurn(conversationId) {
    const previous = this.#turnQueue.get(conversationId) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.#turnQueue.set(conversationId, current);
    await previous;
    return () => {
      release();
      // 只有自己还是队尾时才清掉这一格：否则会把后来者的链断掉
      if (this.#turnQueue.get(conversationId) === current) this.#turnQueue.delete(conversationId);
    };
  }

  /**
   * 回合结束的清理（正常答完、出错、被停止都要走到）。
   * 用 controller 认领：这一格若已经被下一轮接管，就什么都别动。
   */
  #forgetTurn(conversationId, controller) {
    const turn = this.#turns.get(conversationId);
    if (!turn || turn.controller !== controller) return;
    this.#turns.delete(conversationId);
    // 兜底收尾：任何一条异常路径都不能让界面留下"永远转圈"的步骤
    turn.plan?.settle(controller.signal.aborted ? 'failed' : 'done');
    turn.plan?.close();
  }

  /**
   * 让一次"出网调用"可以**不再等待**：停止信号一到就立刻返回 `null`，底层请求在后台自己结束。
   *
   * 为什么不是"取消"：检索/读页面在 web-search.js 里，它们的 fetch 没有接收我们的 signal
   * （那是另一个模块的接口，本轮不动）。但对用户来说"按下停止后不再等它"就是全部所需 ——
   * 结果本来就要丢掉，晚到的返回值只是被忽略。
   * 两个分支都要接住：不然晚到的失败会变成 unhandledRejection（把测试与进程一起带崩）。
   */
  #abortable(promise, signal) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        // 已经停了：不等它，但也要接住它的结果，免得变成未处理的拒绝
        promise.then(() => {}, () => {});
        resolve(null);
        return;
      }
      const onAbort = () => resolve(null);
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  /**
   * 被停止的那条 assistant 消息**落库**（契约里最要紧的一条）。
   *
   * 为什么不把这条占位消息直接丢掉：用户屏幕上的那半段正文是真的、已经查到的数据也是真的。
   * 整条删掉的话，用户会觉得"我明明看到它写了半段，一按停止连话都没了"。
   * 所以：保留 `content`（停止前生成的部分）+ `status:"stopped"` + `stoppedAt`，
   * 前端据此显示「已停止」；而**绝不能当成一条正常答完的回复**（那会让用户以为
   * 半句话就是它的完整答案，还会被后续轮次当成事实引用）。
   */
  async #saveStopped({
    conversation,
    assistant,
    userMessage,
    trimmed,
    partial,
    content,
    reasoningAll,
    usageRounds,
    queried,
    executed,
    drafts,
    lastRaw,
    lastModel,
    lastFinishReason,
    rounds,
    mode,
    searchMode,
    thinking,
    uploadWarnings,
  }) {
    const saved = await this.store.aiMessages.update(assistant.id, {
      // 正文取"停止前最后看到的那一份"：正流到一半时就是已经吐出来的那半段
      content: content || partial || '',
      drafts,
      executed,
      thinking,
      permission: mode,
      search: searchMode,
      reasoning: reasoningAll.slice(0, 20_000) || null,
      queried,
      status: STATUS_STOPPED,
      stoppedAt: new Date().toISOString(),
      model: lastModel,
      usage: usageRounds[0] ?? null,
      usageFollowup: usageRounds[1] ?? null,
      usageRounds,
      rounds,
      // 被停止**不是**"撞上轮次上限"：这两件事在界面上要给不同的提示
      roundLimit: false,
      finishReason: lastFinishReason,
      raw: lastRaw ?? partial ?? null,
      error: null,
    });
    await this.#touchConversation(conversation.id, trimmed);
    this.broadcast?.({
      type: 'ai_message',
      module: 'ai',
      payload: { conversationId: conversation.id, message: saved, drafts, queried, rounds, stopped: true },
    });
    return {
      ok: true,
      stopped: true,
      conversation: this.store.aiConversations.get(conversation.id),
      user: userMessage,
      assistant: saved,
      drafts,
      queried,
      executed,
      thinking,
      permission: mode,
      search: searchMode,
      rounds,
      roundLimit: false,
      warnings: uploadWarnings,
    };
  }

  // ---------------------------------------------------------------- 内部

  /**
   * 需要时生成/更新这段对话的滚动摘要，返回要注入提示词的文本（没有就返回空串）。
   *
   * 触发条件是"窗口之外还有没压过的消息，且数量够多"，所以：
   *   - 正常短对话一次压缩都不会发生（不花额外的钱）；
   *   - 长对话每积累 `SUMMARY_MIN_MESSAGES` 条才压一次；
   *   - 已经覆盖的部分不重压（`summaryCount` 记着覆盖到第几条）。
   */
  async #ensureSummary(conversation, signal = null) {
    const plan = this.#summaryPlan(conversation);
    if (plan.fresh.length < SUMMARY_MIN_MESSAGES) return plan.existing;
    const written = await this.#writeSummary(conversation, plan, signal);
    // 压缩是"锦上添花"：失败（或模型没给出内容）就沿用旧摘要，绝不让这条消息发不出去
    return written.ok ? written.text : plan.existing;
  }

  /**
   * 「哪些旧消息该进摘要」——**唯一口径**，自动压缩（`#ensureSummary`）与手动 `/com`（`compact`）共用。
   *
   * 抽出来的原因是这两条路必须**完全一致**：如果手动压缩按另一套窗口算，
   * 用户点一次"压缩"，压掉的可能正是模型下一秒还要用的那几条。
   */
  #summaryPlan(conversation) {
    const existing = String(conversation?.summary ?? '').trim();
    const covered = Math.max(0, Number(conversation?.summaryCount ?? 0) || 0);
    const turns = Number(this.config.get().historyTurns) || 0;
    const all = this.#contextMessages(conversation?.id);
    // 窗口 = 最近 turns 轮（一问一答各算一条消息，所以是 turns * 2 条）；turns=0 表示不带历史
    const windowMessages = turns > 0 ? Math.min(all.length, turns * 2) : 0;
    // 窗口之外的部分才是"该被压缩"的：窗口里的内容模型直接看得到，压了纯属浪费
    const older = turns > 0 ? all.slice(0, Math.max(0, all.length - windowMessages)) : [];
    // 已经覆盖的部分不重压 —— 这是"不重复烧 token"的关键
    const fresh = older.slice(covered);
    return { existing, covered, turns, all, windowMessages, older, fresh };
  }

  /**
   * 真的去调模型写摘要（自动压缩与 `/com` 共用这一份，**不要**再写第二份提示词）。
   *
   * 不抛异常：自动压缩那条路上"压缩失败"必须降级成"继续用旧摘要"，
   * 所以失败以 `{ ok:false }` 返回，由调用方决定是记日志还是报错给用户。
   */
  async #writeSummary(conversation, { existing, older, fresh }, signal = null) {
    const transcript = fresh
      .slice(-40) // 一次最多压 40 条：再长的对话也是分批压，避免单次请求过大
      .map((item) => `${item.role === 'user' ? '用户' : '助手'}：${String(item.content).slice(0, 500)}`)
      .join('\n');
    try {
      const result = await this.provider.chat({
        messages: [
          {
            role: 'system',
            content:
              '你在压缩一段对话，供后续继续对话时使用。只输出摘要本身，不要开场白、不要分点标题。' +
              `不超过 ${SUMMARY_MAX_CHARS} 字。必须保留：用户的目标与偏好、已经确认的事实与数字、` +
              '未完成的事与约定、已经做过的操作结论；不要保留寒暄、不要复述助手的长篇解释。',
          },
          {
            role: 'user',
            content: (existing ? `【已有摘要】\n${existing}\n\n` : '') + `【需要并入的对话】\n${transcript}`,
          },
        ],
        temperature: 0.2,
        // 摘要也是一次上游调用：停止时要能把它一起打断（否则用户按了停止还得等它跑完）
        signal,
      });
      const text = String(result?.text ?? '').trim().slice(0, SUMMARY_MAX_CHARS);
      if (!text) return { ok: false, message: '模型没有返回可用的摘要内容' };
      await this.store.aiConversations.update(conversation.id, {
        summary: text,
        // 覆盖数是**累计**的（older.length），不是这一次压了几条：下次只压新增的部分
        summaryCount: older.length,
        summaryAt: new Date().toISOString(),
      });
      return { ok: true, text, covered: older.length, summarized: fresh.length };
    } catch (error) {
      this.#log('warn', `对话摘要压缩失败（继续用旧摘要）：${error?.message ?? error}`);
      return { ok: false, error, message: error?.message ?? String(error) };
    }
  }

  /**
   * 上下文占用的原始测量（`contextUsage` 与 `compact` 共用）。
   *
   * 两套口径一起给出来，由调用方决定用哪个：
   *   - `real`：最近一次真实请求的 `prompt_tokens`（可能没有 → null）；
   *   - `estimate`：按"下一次请求会带上的东西"逐块字符估算。
   */
  async #measureContext(conversation) {
    const config = this.config.get();
    const history = this.#history(conversation.id);
    const summary = String(conversation?.summary ?? '').trim();
    /**
     * 系统提示词那段按"下一次真发出去的那份"估。
     *
     * **刻意不调 `buildContext()`**：记忆注入的 `inject()` 会累加命中计数（见 memory 模块），
     * 一个"看一眼占用"的接口每次刷新都去动别人的统计是越界。代价是少算了记忆注入那几十~几百
     * token —— 估算本来就标着 `source: 'estimate'`，不值得为它去改别的模块的状态。
     */
    const prompt = describeChatPrompt({
      draw: config.drawMode !== false,
      permission: 'manual',
      search: 'off',
      // 提示词里的"N 条写入草稿"随配置变，估 token 时也要用同一个 N（差几个字符，但口径要一致）
      maxActionsPerTurn: config.maxActionsPerTurn,
      domainBlocks: this.domainBlocks,
      summary,
      recent: this.#recentSummary(todayKey()),
    });
    const historyText = history.map((item) => String(item.content ?? '')).join('\n');
    const parts = {
      system: prompt.system.tokens,
      tools: prompt.tools.tokens,
      history: estimateTokens(historyText),
      summary: estimateTokens(summary),
    };
    const breakdown = {};
    for (const key of CONTEXT_BREAKDOWN_KEYS) breakdown[key] = parts[key];
    // 记忆/近期数据注入已经算在 system 里了，单列会让"分类合计"和 used 对不上。
    // 宁可给 null（前端不显示这一行），也不编一个会重复计数的数。
    breakdown.injection = null;
    return {
      real: this.#lastPromptTokens(conversation.id),
      breakdown,
      /** 分类合计（估算）——分类是估算，所以这个值只用来算堆叠条各段的比例 */
      breakdownTotal: CONTEXT_BREAKDOWN_KEYS.reduce((sum, key) => sum + parts[key], 0),
      estimateUsed: CONTEXT_BREAKDOWN_KEYS.reduce((sum, key) => sum + parts[key], 0),
      messages: this.#contextMessages(conversation.id).length,
      windowMessages: history.length,
      windowTurns: Number(config.historyTurns) || 0,
      summaryChars: summary.length,
      summaryCovered: Math.max(0, Number(conversation?.summaryCount ?? 0) || 0),
    };
  }

  /** 组装 `/ai/context` 的返回（见 `contextUsage` 的注释：为什么优先真实值、为什么标来源）。 */
  async #contextPayload(conversation, { estimateOnly = false } = {}) {
    const measured = await this.#measureContext(conversation);
    const limit = Number(this.config.get().contextWindow) || AI_DEFAULTS.contextWindow;
    // 有真实 usage 就用它（准确、免费）；只有 `estimateOnly`（压缩前后对比）才强制走估算
    const useReal = !estimateOnly && Boolean(measured.real);
    const used = useReal ? measured.real.tokens : measured.estimateUsed;
    return {
      ok: true,
      conversationId: conversation.id,
      limit,
      used,
      /** 一位小数；used > limit 时不截断（上限是用户填的，超过就该让百分比如实超 100） */
      percent: Number(((used / limit) * 100).toFixed(1)),
      source: useReal ? 'prompt_tokens' : 'estimate',
      /** 真实值的取样时间（估算时 null：没有"哪一次请求"这回事） */
      usedAt: useReal ? measured.real.at : null,
      messages: measured.messages,
      windowMessages: measured.windowMessages,
      windowTurns: measured.windowTurns,
      summaryChars: measured.summaryChars,
      summaryCovered: measured.summaryCovered,
      breakdown: measured.breakdown,
      /** 分类**永远**是字符估算（真实 usage 不给分类），单独标出来，免得被当成真实值 */
      breakdownSource: 'estimate',
      breakdownTotal: measured.breakdownTotal,
      configured: this.provider.configured(),
    };
  }

  /**
   * 最近一次**真实请求**的 `prompt_tokens`（一次回复有多轮时取最后一轮）。
   *
   * 为什么从后往前找：绝大多数会话最后一条 assistant 消息就是最新的那次调用，一次命中；
   * 失败的回复（`status:'failed'`）不带 usage，自然被跳过。
   */
  #lastPromptTokens(conversationId) {
    const messages = this.#messagesOf(conversationId).filter((item) => item.role === 'assistant');
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const rounds = this.#usageRoundsOf(messages[index]).filter((raw) => Number(raw?.prompt_tokens) > 0);
      const last = rounds[rounds.length - 1];
      if (last) {
        return { tokens: Number(last.prompt_tokens), at: messages[index].createdAt ?? null, messageId: messages[index].id ?? null };
      }
    }
    return null;
  }

  /**
   * 一条 assistant 消息上**每一轮**上游调用的 usage（口径与 `usage()` 完全一致）。
   * 抽出来是因为 `/ai/context` 也要按同一顺序取"最后一次调用"，两处各写一份迟早会漂移。
   */
  #usageRoundsOf(message) {
    return Array.isArray(message?.usageRounds) && message.usageRounds.length
      ? [
          message.usage ?? message.usageRounds[0],
          message.usageFollowup ?? message.usageRounds[1],
          ...message.usageRounds.slice(2),
        ]
      : [message?.usage, message?.usageFollowup];
  }

  #messagesOf(conversationId) {
    return (this.store.aiMessages?.all?.() ?? [])
      .filter((item) => item.conversationId === conversationId)
      .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
  }

  /**
   * 「参与上下文的消息」——历史 / 摘要 / 占用统计**共用**这一份过滤与排序。
   * 口径：只要 user / assistant 里**非失败**且有正文的（失败的回复不该占上下文，
   * 空的流式占位消息也不该被算进去）。
   */
  #contextMessages(conversationId) {
    return this.#messagesOf(conversationId).filter(
      (item) => (item.role === 'user' || item.role === 'assistant') && item.status !== 'failed' && item.content,
    );
  }

  /**
   * 送进模型的历史：最近 N 轮（一轮 = 一问一答）。
   * 只带 role + content —— 草稿、usage 这些是给人看的，进提示词只会浪费 token。
   * 唯一的附加内容是 assistant 正文末尾那一行**紧凑摘要**（见 #historySummary）：
   * "上一轮查到了什么 / 自动执行了什么"对**下一句用户发言**必须可见，否则用户说"那明天呢"
   * 时模型是从零开始的（它只看得到一句光秃秃的回复）。
   *
   * 摘要**拼进 content**（`\n\n` 分隔）而不是再插一条 `role: "user"` 的注入消息，理由：
   *   1. history 是要原样发上去的，user/assistant 严格交替最稳 —— 各家 OpenAI 兼容端点
   *      对连续两条同角色消息的容忍度不一样；
   *   2. 不改变"最近 N 轮"的截断口径：多一条消息就会占掉窗口里的位置，把最早那轮挤出去。
   */
  #history(conversationId) {
    const turns = this.config.get().historyTurns ?? 0;
    if (turns <= 0) return [];
    const all = this.#contextMessages(conversationId);
    // 截断逻辑**不变**：仍然是最后 turns 轮（一问一答算一条消息，所以是 turns * 2）
    return all.slice(-turns * 2).map((item) => {
      if (item.role !== 'assistant') return { role: item.role, content: item.content };
      const summary = this.#historySummary(item);
      return { role: 'assistant', content: summary ? `${item.content}\n\n${summary}` : item.content };
    });
  }

  /**
   * 上一轮"实际发生了什么"的一行摘要（给 `#history` 用）。
   *
   * 数据全部来自消息上**已经落库**的字段，不重新查库、不塞原始 JSON：
   *   - `queried`：这一轮跑过的只读查询（`draft.target` + `result.count` / `result.items`）；
   *   - `executed`：自动审批真正执行掉的写操作（`draft` + `result`）。
   * 这两样原本只给人看（数据卡片 / 回执卡），模型一无所知 —— 于是"那明天呢"接不上。
   *
   * 宁缺勿滥：两者都空就返回 null（这种消息一个 token 都不多花），整体也压到 200 字以内。
   * 只保留条数与名字，**不带查询结果本身**：原始数据在回灌那一轮已经进过上下文，
   * 历史里再铺一遍既贵又会把更早的对话挤掉。
   */
  #historySummary(message) {
    /** 查询范围压成 `（2026-10-12）` / `（起~止）`；没有范围就是空串。 */
    const range = (filters) => {
      const from = filters?.from ?? null;
      const to = filters?.to ?? null;
      if (!from && !to) return '';
      return from && to && from !== to ? `（${from}~${to}）` : `（${from ?? to}）`;
    };

    const parts = [];
    const queried = Array.isArray(message?.queried) ? message.queried : [];
    if (queried.length) {
      const items = queried.map((entry) => {
        const target = entry?.draft?.target ?? '数据';
        // 查失败也要说：否则模型会以为"查过了，就是没有"，理直气壮地回答"你没有日程"
        if (entry?.error) return `${target}（没查成）`;
        const count = entry?.result?.count ?? entry?.result?.items?.length ?? 0;
        return `${target} ${count} 条${range(entry?.draft?.filters)}`;
      });
      parts.push(`已查 ${items.join('、')}`);
    }

    const executed = Array.isArray(message?.executed) ? message.executed : [];
    if (executed.length) {
      const items = executed.map((entry) => {
        const draft = entry?.draft ?? {};
        const verb = ACTION_LABELS[draft.action] ?? draft.action ?? '操作';
        // 写操作的"名字"各家返回得不完全一样：create 给 item，update/delete 给 affected
        const name =
          entry?.result?.item?.title ??
          entry?.result?.item?.id ??
          entry?.result?.affected?.[0]?.title ??
          draft.fields?.title ??
          draft.filters?.keyword ??
          '';
        // 连名字都拿不到时至少说清动的是哪张表，别写成光秃秃一个"删除"
        const label = `${verb}${name ? `「${name}」` : draft.target ? ` ${draft.target}` : ''}`;
        return entry?.error ? `${label}（没成）` : label;
      });
      parts.push(`已自动执行 ${items.join('、')}`);
    }

    if (!parts.length) return null;
    /**
     * 前缀写成 `[系统记录 · 上一轮：…]` 而不是 `[上一轮：…]`：
     * 这行是**系统补在 assistant 消息后面**的（模型看不到自己上一轮的回执，只能靠它接上下文），
     * 但真机实测模型会把它当成自己的文风照抄进正文（用户截图里那句"[上一轮：已查 web 8 条]"就是被抄的）。
     * 明确标成"系统记录"，配合提示词里的"不要复述系统记录"，就不会再出现在回答里。
     */
    const line = `[系统记录 · 上一轮：${parts.join('；')}]`;
    return line.length > HISTORY_SUMMARY_MAX ? `${line.slice(0, HISTORY_SUMMARY_MAX - 1)}…` : line;
  }

  async #appendMessage(data) {
    return this.store.aiMessages.insert({
      status: 'done',
      drafts: [],
      queried: [],
      usage: null,
      model: null,
      provider: null,
      error: null,
      raw: null,
      ...data,
    });
  }

  /**
   * 自动执行只读查询草稿（`action: "query"`）。
   *
   * 为什么可以不经确认：它**不改任何数据**（用 `dryRun` 走一遍，连指令日志都不写）。
   * 为什么必须自动执行：模型看不见数据，就会一直说"我拿不到/需要你确认"，
   * 而用户问的是"我明天有什么日程"——这种问题应该直接给答案。
   */
  async #runReadOnlyQueries(previewed, { searchMode = 'off', signal = null, plan = null, searchBudget = null, oriQuestion = '' } = {}) {
    const out = [];
    for (const entry of previewed) {
      if (entry.draft?.action !== 'query') continue;
      if (out.length >= MAX_AUTO_QUERIES) break;
      // **每一条查询之间**都看一下停止信号：用户按了停止，就不该再发起下一条（写入那条路同理）
      if (signal?.aborted) break;
      // 联网检索走自己的执行器：它要读**用户在界面上选的通道**（校外/校内/关），
      // 而那个信息只存在于这一次请求里，命令服务那边看不到（理由见 #runWebQuery）。
      if (entry.draft.target === WEB_TARGET) {
        out.push(await this.#runWebQuery(entry, { searchMode, signal, plan, searchBudget, oriQuestion }));
        continue;
      }
      /**
       * 校验没过的查询**也要记进本轮结果**，不能悄悄跳过。
       *
       * 实测过的事故：模型说"我把原文调出来看"，草稿却被 400 挡掉（path 传了 URL），
       * 旧代码在这里 `continue` → 本轮"没有新查询" → 循环立刻结束 → 用户只看到那句
       * "我去看看"，既没有结果也没有解释。失败也是结果：把它回灌（见 #queryInjectionText
       * 的 failed 段），模型才有机会改个写法重试或如实说明。
       */
      if (entry.error) {
        out.push({ draft: entry.draft, error: entry.error });
        continue;
      }
      plan?.start(entry);
      try {
        const result = await this.commands.execute(entry.draft, { dryRun: true });
        out.push({ draft: entry.draft, result: this.#compactQueryResult(entry.draft.target, result) });
        plan?.finish(entry, null);
      } catch (error) {
        out.push({ draft: entry.draft, error: { code: error.code ?? 'INTERNAL', message: error.message } });
        plan?.finish(entry, error);
      }
    }
    return out;
  }

  /** 后端日志出口：注入了框架 logger 就用它，否则只在错误级别退回 console（免得测试输出被刷屏）。 */
  #log(level, message) {
    if (this.logger) {
      this.logger(level, message);
      return;
    }
    if (level === 'error') console.error(`[ai] ${message}`);
  }

  /**
   * 「设置 → 对话设置 → 试一下」用的检索自检：**和对话里走同一个适配器**，
   * 所以这里能搜到，对话里就能搜到；这里搜不到，界面会直接把原因（后端选择、
   * 校内探测结果、逐条抓取失败原因）摊开给用户看，而不是让人猜。
   *
   * 不写库、不进对话，纯只读的一次尝试。
   */
  async searchPreview({ query, mode = 'web', limit, oriQuestion } = {}) {
    const config = this.config.get() ?? {};
    const scope = WEB_SEARCH_MODES.includes(mode) ? mode : 'web';
    const configured = normalizeSearchLimit(config.searchMaxPages, { fallback: SEARCH_LIMIT_DEFAULT });
    const max = normalizeSearchLimit(limit, { fallback: configured });
    const log = (level, message) => this.#log(level, message);
    const detailed = await searchWebDetailed({
      query,
      mode: scope,
      limit: max,
      config,
      log,
      fetchImpl: this.searchFetch ?? undefined,
      // 试搜没有"对话原话"可用，就把检索词本身当 ori_question 传过去
      oriQuestion: oriQuestion ?? query,
    });
    /**
     * **一次搜索拿全**：官方 `need_content:true` 已经把正文带回来了，
     * 这些条目不要再走 `readPages`（那会多花 N 次 Fetch 计费）；只有 content 为空的才回退抓取。
     */
    const inlinePages = detailed.results
      .map((item) => pageFromSearchContent(item))
      .filter(Boolean);
    const inlineByUrl = new Map(inlinePages.map((page) => [page.url, page]));
    const needsRead = detailed.results.filter((item) => !inlineByUrl.has(item.url));
    const fetchedPages = needsRead.length
      ? await readPages(needsRead, { limit: max, log, fetchImpl: this.searchFetch ?? undefined, config })
      : [];
    const byUrl = new Map([...inlinePages, ...fetchedPages].map((page) => [page.url, page]));
    const items = detailed.results.map((item) => {
      const page = byUrl.get(item.url) ?? {};
      return {
        title: item.title,
        url: item.url,
        snippet: item.snippet,
        source: item.source,
        scope: item.scope,
        matchedBy: item.matchedBy ?? null,
        site: item.site ?? null,
        // 官方结果的新字段：设置页的"试一下"要能显示 rerank_score / authority / date / 来源
        summary: item.summary ?? null,
        date: item.date ?? null,
        publishedAt: item.publishedAt ?? null,
        authority: Number.isFinite(item.authority) ? item.authority : null,
        rerankScore: Number.isFinite(item.rerankScore) ? item.rerankScore : null,
        siteName: item.siteName ?? null,
        ok: page.ok !== false,
        error: page.error ?? null,
        chars: String(page.text ?? '').length,
        text: String(page.text ?? '').slice(0, WEB_TEXT_CHARS),
        // 来源口径与正文一起回灌（见下方 #compactQueryResult 的 web 投影表）
        textSource: page.via ?? null,
        note: page.note ?? null,
      };
    });
    return {
      query: detailed.query,
      mode: detailed.mode,
      limit: detailed.limit,
      backend: detailed.backend,
      campus: detailed.campus,
      deepseek: detailed.deepseek,
      notes: detailed.notes,
      count: items.length,
      read: items.filter((item) => item.chars > 0).length,
      items,
    };
  }

  /**
   * 读用户/模型指定的一批网址（`fields.url`，可逗号或换行分隔多条）。
   *
   * 与"搜索后读正文"共用同一套抓取与清洗（`readPages`），所以正文容器识别、meta 摘要兜底、
   * 失败原因这些都一致；区别只是**不经过搜索引擎**。
   */
  async #readGivenUrls(draft, rawUrls) {
    const urls = String(rawUrls)
      .split(/[\s,，]+/)
      .map((item) => item.trim())
      .filter((item) => /^https?:\/\//i.test(item))
      .slice(0, 5);
    if (!urls.length) {
      return { draft, error: { code: 'BAD_REQUEST', message: 'fields.url 里没有可用的 http(s) 网址' } };
    }
    const config = this.config.get() ?? {};
    const limit = normalizeSearchLimit(config.searchMaxPages, { fallback: SEARCH_LIMIT_DEFAULT });
    const log = (level, message) => this.#log(level, message);
    try {
      const pages = await readPages(
        urls.map((url) => ({ title: url, url })),
        { limit, log, fetchImpl: this.searchFetch ?? undefined, config },
      );
      const items = pages.map((page) => ({
        title: page.title && page.title !== page.url ? page.title : page.url,
        url: page.url,
        snippet: '',
        source: 'direct',
        scope: /(^|\.)xjtu\.edu\.cn$/i.test((() => { try { return new URL(page.url).hostname; } catch { return ''; } })()) ? 'campus' : 'web',
        text: String(page.text ?? '').slice(0, WEB_TEXT_CHARS),
        chars: String(page.text ?? '').length,
        textSource: page.via ?? null,
        note: page.note ?? null,
        ok: page.ok !== false,
        error: page.error ?? null,
      }));
      const read = items.filter((item) => item.chars > 0).length;
      return {
        draft,
        result: this.#compactQueryResult(WEB_TARGET, {
          filters: { url: urls.join(' '), mode: 'direct' },
          count: items.length,
          items,
          explain: `直接读取指定网址：${urls.length} 个，读到正文 ${read} 个`,
        }),
      };
    } catch (error) {
      return { draft, error: { code: error.code ?? 'INTERNAL', message: `读取指定网址失败：${error.message}` } };
    }
  }

  /**
   * 联网检索：搜结果 → 读正文 → 合成一条只读查询结果。
   *
   * 为什么不在命令服务里注册一个 `web` handler（那样看着更"统一"）：命令 handler 的签名
   * 只有草稿本身，看不到**这次请求的联网档位**（off / web / campus）—— 那是前端发消息时带上来的。
   * 让 handler 去读全局状态，两个并发请求就会串档；所以这里显式把档位传进来。
   *
   * 「联网关掉了」的口径：不搜，并且**明确告诉模型原因**（它会照实转告用户），
   * 而不是返回空结果让它以为"网上没有"。
   */
  async #runWebQuery(entry, { searchMode = 'off', signal = null, plan = null, searchBudget = null, oriQuestion = '' } = {}) {
    const draft = entry.draft;
    /**
     * 记一步"没做成"。
     *
     * **一定**要作为结果回灌给模型（调用方会把它 push 进 `queried`）：
     * 静默跳过的话，模型会以为这次检索跑过了，接下来要么编内容、要么把同一条再发一遍。
     * `counters` 是"第几次 / 还剩几次"，失败也要带上（见 #searchFeedbackText）。
     */
    const fail = (error, counters = {}) => {
      plan?.finish(entry, error);
      return { draft, error, ...counters };
    };
    /**
     * 用户**直接给了网址**时，读那一页，而不是"拿网址去搜"。
     *
     * 实测过的笑话：用户说"帮我看看这个页面写了什么：https://sae.xjtu.edu.cn/info/1024/1173.htm"，
     * 模型把整条 URL 当检索词丢给搜索引擎，引擎把 "https" 当成关键词，返回了一堆 HTTP 协议科普文 ——
     * 页面一个字没读到，模型只能如实说"这次检索等于白跑了"。
     * 有 URL 就直接抓（正文提取那套逻辑照用），这才是"看看这个页面"的正解。
     */
    const directUrl = String(draft.fields?.url ?? '').trim();
    const query = String(draft.fields?.query ?? draft.filters?.q ?? '').trim();
    if (!directUrl && !query) {
      return fail({
        code: 'BAD_REQUEST',
        message: '联网检索要么给检索词（fields.query），要么给要读的网址（fields.url）',
      });
    }
    // 同一个开关管两件事：读指定网址同样是"出网"，用户关掉联网就不做
    if (!WEB_SEARCH_MODES.includes(searchMode) || searchMode === 'off') {
      // 这两条**都不算**用掉检索次数：根本没出网（见下面的预算说明）
      return fail({
        code: 'SEARCH_OFF',
        message:
          '联网搜索已关闭（输入框下面的地球图标选了「不联网」）。想让我读这个页面，先把它切成「从校外网搜索」或「从校内网搜索」。',
      });
    }
    /**
     * 检索预算：**只有真的要出网才算一次**。读指定网址也算一次 —— 它一样花掉了
     * 一次出网机会（用户设的额度管的是"联网几次"，不是"搜索几次"）。
     *
     * 用尽时不再发起任何新请求，而是把 `SEARCH_RETRY_EXHAUSTED` 回灌给模型：
     * 这不是"跳过"，是**一次有原因的结果** —— 模型据此用已有数据收尾，
     * 或者如实告诉用户拿不到并给下一步（用户要的"AI 自认为可以结束"）。
     */
    if (searchBudget && searchBudget.used >= searchBudget.max) {
      return fail(
        {
          code: SEARCH_RETRY_EXHAUSTED,
          message:
            `联网检索次数已用完（本回合上限 ${searchBudget.max} 次）。系统不会再执行新的联网检索：` +
            '请用已经拿到的结果作答；如果确实没有可用结果，就如实告诉用户"这次没拿到"并给出下一步，不要编造内容。',
        },
        { attempt: null, remaining: 0 },
      );
    }
    const { attempt, remaining } = searchBudget ? consumeSearchBudget(searchBudget) : { attempt: null, remaining: null };
    /** 成功的结果也要把"第几次 / 还剩几次"带上：模型据此决定"再试一次"还是"收手作答"。 */
    const succeed = (result) => ({ draft, result: { ...result, attempt, remaining }, attempt, remaining });
    if (directUrl) {
      plan?.start(entry);
      const outcome = await this.#abortable(this.#readGivenUrls(draft, directUrl), signal);
      // 停止信号到了：这次读页面不再等结果（底层请求自己在后台结束，结果丢弃）
      if (!outcome) return fail({ code: STOPPED_CODE, message: '这一轮已被用户停止，读页面不再等待结果' }, { attempt, remaining });
      return outcome.error ? fail(outcome.error, { attempt, remaining }) : succeed(outcome.result);
    }
    // 通道以界面为准：界面选校外时，模型写 campus 也不越权（反过来同理）
    const mode = searchMode;
    const config = this.config.get() ?? {};
    // 「网络搜索最大条数」在设置里（5–30，默认 8）：改了立刻生效，不必重启进程
    const limit = normalizeSearchLimit(config.searchMaxPages, { fallback: SEARCH_LIMIT_DEFAULT });
    const asked = normalizeSearchLimit(draft.fields?.limit, { fallback: limit });
    const count = Math.max(1, Math.min(limit, asked));
    const log = (level, message) => this.#log(level, message);
    plan?.start(entry);
    try {
      /**
       * 用 `searchWebDetailed` 而不是 `searchWeb`：要拿 `deepseek` 诊断（欠费/限流/key 无效）
       * 与 `backend`，才能在 explain 里如实说明"官方挂了、已降级"，而不是笼统说"没搜到"。
       */
      const detailed = await this.#abortable(
        searchWebDetailed({
          query,
          mode,
          limit: count,
          config,
          log,
          fetchImpl: this.searchFetch ?? undefined,
          // 用户原话透传给官方 Search 的 ori_question（帮助理解检索意图）
          oriQuestion,
          signal,
        }),
        signal,
      );
      // 停止信号到了：这次检索不再等结果（底层请求自己在后台结束，结果丢弃）
      if (!detailed) return fail({ code: STOPPED_CODE, message: '这一轮已被用户停止，检索结果不再等待' }, { attempt, remaining });
      const results = detailed.results ?? [];
      /** 官方通道的诊断摘要：失败时把明确错误码带进 explain，模型/用户才知道是欠费还是限流。 */
      const deepseekNote = detailed.deepseek
        ? detailed.deepseek.ok
          ? `（DeepSeek 官方搜索：${detailed.deepseek.count} 条，rerank_score ≥ 1.5 的 ${detailed.deepseek.premium} 条、authority ≥ 3 的 ${detailed.deepseek.highAuthority} 条）`
          : `（DeepSeek 官方搜索不可用：${detailed.deepseek.error?.code ?? '无结果'}${detailed.deepseek.error ? `：${detailed.deepseek.error.message}` : ''}；已降级到免密钥抓取）`
        : '';
      if (!results.length) {
        return succeed(this.#compactQueryResult(WEB_TARGET, {
          filters: { query, mode },
          count: 0,
          items: [],
          explain:
            (mode === 'campus'
              ? '校内检索没有返回结果（可能被反爬挡住，或校内站点里没有匹配）—— 如实告诉用户没搜到，不要编造'
              : '检索没有返回结果（可能被搜索引擎拦截，或还没配置搜索 API 密钥）—— 如实告诉用户没搜到，不要编造')
            + deepseekNote,
        }));
      }
      /**
       * **一次 search + need_content 拿全**：官方已经把正文带回来了，
       * 这些条目**不再逐页 Fetch**（每多一次 Fetch 就多花 5 元/1000 次，还多一个往返）。
       * 只有 `content` 为空的条目（官方没给正文、或走的是抓取结果）才回退到 `readPages`。
       */
      const inlinePages = results.map((item) => pageFromSearchContent(item)).filter(Boolean);
      const inlineByUrl = new Map(inlinePages.map((page) => [page.url, page]));
      const needsRead = results.filter((item) => !inlineByUrl.has(item.url));
      let fetchedPages = [];
      if (needsRead.length) {
        fetchedPages = await this.#abortable(
          readPages(needsRead, {
            limit: count,
            log,
            fetchImpl: this.searchFetch ?? undefined,
            config,
            signal,
          }),
          signal,
        );
        if (!fetchedPages) return fail({ code: STOPPED_CODE, message: '这一轮已被用户停止，读正文不再等待' }, { attempt, remaining });
      }
      const byUrl = new Map([...inlinePages, ...fetchedPages].map((page) => [page.url, page]));
      /**
       * 校内结果排前面。
       *
       * 实测过的问题：校内通道会并走一次公网检索，公网结果条数多、把校内结果挤到后面，
       * 用户看到"校内搜索"返回的却是别的学校 —— 明明校内也有命中。所以这里按 scope 稳定排序，
       * 并且每条都带上 `scope`，界面与模型都能标出"这条是校内站点 / 这条是公网"。
       */
      const ordered = [...results].sort((a, b) => Number(b.scope === 'campus') - Number(a.scope === 'campus'));
      const items = ordered.slice(0, count).map((item) => {
        const page = byUrl.get(item.url) ?? {};
        return {
          title: item.title,
          url: item.url,
          snippet: item.snippet,
          source: item.source,
          scope: item.scope,
          matchedBy: item.matchedBy ?? null,
          site: item.site ?? null,
          // 发布日期：栏目直读与 DeepSeek 官方结果都有；没有时**不能**替这条编一个日期。
          publishedAt: item.publishedAt ?? null,
          // DeepSeek 的官方字段：date 判新旧、authority/rerankScore 判可信度、summary 是长摘要
          date: item.date ?? null,
          authority: Number.isFinite(item.authority) ? item.authority : null,
          rerankScore: Number.isFinite(item.rerankScore) ? item.rerankScore : null,
          summary: item.summary ?? null,
          siteName: item.siteName ?? null,
          // 正文只在真抓到时才有：`ok:false` 的条目 text 为空、error 说明原因（列表页/PDF/要登录），
          // 模型据此知道"这条只有摘要，别当成读过了"
          text: String(page.text ?? '').slice(0, WEB_TEXT_CHARS),
          // 真实字数单独留一份：界面要显示"读了 N 字"，用截断后的长度会说少
          chars: String(page.text ?? '').length,
          ok: page.ok !== false,
          error: page.error ?? null,
          // 来源口径：`meta` 时 note 会写明"这是摘要不是全文"，模型据此才算真的知道
          textSource: page.via ?? null,
          note: page.note ?? null,
        };
      });
      const read = items.filter((item) => item.text).length;
      const campusCount = items.filter((item) => item.scope === 'campus').length;
      const explain = mode === 'campus'
        ? `校内检索「${query}」：校内站点命中 ${campusCount} 条、公网结果 ${items.length - campusCount} 条，读到 ${read} 篇正文` +
          (campusCount === 0 && detailed.backend?.kind === 'scrape'
            ? '（校内站点一条都没命中：免密钥通道对 site: 语法支持很差，已带上学校名重试；下面给的是公网结果，回答时要说明这一点）'
            : '')
          + deepseekNote
        : `校外检索「${query}」：搜到 ${results.length} 条，读到 ${read} 篇正文${deepseekNote}`;
      return succeed(this.#compactQueryResult(WEB_TARGET, {
        filters: { query, mode },
        count: items.length,
        items,
        explain,
      }));
    } catch (error) {
      return fail({ code: error.code ?? 'INTERNAL', message: `联网检索失败：${error.message}` }, { attempt, remaining });
    }
  }

  /**
   * 「自动审批」：把通过 dryRun 校验的写操作直接执行掉。
   *
   * 风险自负的一档 —— 它等于替用户点了确认。所以：
   *   - 只执行 **dryRun 已通过** 的草稿（校验不过的一律留着走人工确认卡）；
   *   - 逐条 try/catch，一条失败不影响其它条；
   *   - 结果原样回给前端（渲染成"已自动执行"的回执卡），用户仍然看得见发生了什么。
   */
  async #autoExecuteWrites(drafts, { signal = null, plan = null } = {}) {
    const out = [];
    for (const entry of drafts) {
      // 一条写完之后再看一眼：被停止就不再执行下一条（写操作落库是不可撤销的，宁可少做）
      if (signal?.aborted) break;
      if (entry.error || entry.draft?.action === 'query' || entry.draft?.ok === false) continue;
      plan?.start(entry);
      try {
        const result = await this.commands.execute(entry.draft);
        out.push({ entry, draft: entry.draft, result });
        plan?.finish(entry, null);
      } catch (error) {
        out.push({ entry, draft: entry.draft, error: { code: error.code ?? 'INTERNAL', message: error.message } });
        plan?.finish(entry, error);
      }
    }
    return out;
  }

  /** 只留模型回答需要的字段：整库塞进下一轮提示词既贵又容易跑偏。 */
  #compactQueryResult(target, result) {
    const FIELDS = {
      todo: ['id', 'title', 'deadline', 'completed', 'priority', 'estimatedHours'],
      schedule: ['id', 'title', 'date', 'startTime', 'endTime', 'location', 'category'],
      event: ['id', 'title', 'startDate', 'endDate', 'category'],
      // 联网检索：**必须带上 text（正文）与 url** —— 只给标题，模型就只能凭标题猜，
      // 回答会写得像"读过了"；`ok`/`error` 让它知道哪几条根本没抓到正文（如实说明）。
      // 这条曾经漏掉过：items 里只剩 title，模型于是拿不到任何网页内容。
      // `textSource`/`note` 是**来源口径**：`container`=站内正文容器（真全文）、
      // `body`=整页清洗、`meta`=只拿到 meta 摘要。没有它，模型分不清
      // "我读完了全文"和"我只看到两百字摘要"，就会承诺摘要里没有的细节。
      // `matchedBy`/`site` 是**校内档的来源证据**：column=校方栏目列表直读（最新几条、带发布日期）、
      // site=校内站点自己的检索接口命中、domain=公网结果但域名在校内、mention=公网结果里提到本校。
      // 工具说明与 README 都向模型承诺了这几个字段，而投影表白名单一开始漏了它们 ——
      // 模型因此分不清"这条是校方页面"还是"公网上提到学校"。
      // `publishedAt` 是栏目直读/官方结果的**发布日期**（`YYYY-MM-DD`）：
      // 没有它，"最近有什么新闻"就答不出"最新的一条是几月几号"（真机反馈的原话）。
      // `date`/`authority`/`rerankScore`/`summary`/`siteName` 是 DeepSeek 官方 Search 的字段：
      // 模型要能用"发布时间"与"权威性/相关度"作答，也必须知道 `summary` 是长摘要、`content` 才是正文。
      // 注意：投影表这一行必须保持单行 —— ai-web-loop 的契约测试按前缀定位它。
      web: ['title', 'url', 'snippet', 'source', 'scope', 'matchedBy', 'site', 'publishedAt', 'date', 'authority', 'rerankScore', 'summary', 'siteName', 'text', 'chars', 'textSource', 'note', 'ok', 'error'],
    };
    // 模块声明的投影表覆盖内置表（内置三张表保持原样，行为不变）
    const fields = this.queryFields?.[target] ?? FIELDS[target] ?? ['id', 'title'];
    // 条数上限按 target 可调：有些数据**整份才有意义**（成绩单被截到 20 条就没法算学分绩了），
    // 模块在自己的描述符里用 `aiQueryLimits` 声明该给多少；没声明的仍用内置上限。
    // web 的条数已经在 #runWebQuery 里按设置（5–30）切过了，这里不能再按 MAX_QUERY_ITEMS=20 砍一刀，
    // 否则用户把「最大条数」调到 30 也只有 20 条能进上下文（设置看起来生效了、其实没有）
    const limit = target === WEB_TARGET ? (result.items?.length ?? 0) : (this.queryLimits?.[target] ?? MAX_QUERY_ITEMS);
    const items = (result.items ?? []).slice(0, limit).map((item) => {
      const picked = {};
      for (const key of fields) if (item[key] !== undefined && item[key] !== null) picked[key] = item[key];
      return picked;
    });
    return {
      target,
      filters: result.filters ?? {},
      count: result.count ?? items.length,
      truncated: (result.items?.length ?? 0) > items.length,
      explain: result.explain ?? null,
      // 有些模块（如学业）会在 items 之外给一份聚合口径（学分绩、总学分…）。
      // 「我的学分绩多少」这类问题靠 items 是答不出来的，所以原样带上。
      ...(result.summary && typeof result.summary === 'object' ? { summary: result.summary } : {}),
      items,
    };
  }

  /**
   * 把这一轮"系统真的做了的事"回灌进对话（**每轮**都回灌，不是固定的"第二次调用"）。
   *
   * 三类结果共用一条注入消息（而不是拆成几条）：
   *   - `queried`：只读查询的结果（模型据此作答）；
   *   - `executed`：auto 档**已经落库**的写操作结果（模型据此说清"系统做了什么"，尤其是冲突）；
   *   - `deferred`：因**超出本轮执行上限**而没执行的写草稿（模型据此改口，不谎报全办好了）。
   *
   * 为什么合成一条：它们常常同一轮发生（"先查一下有没有撞，再帮我加一条"），拆成几条会变成
   * 连续几条 user 消息 —— 上游兼容端点对消息角色交替的校验并不一致，能少踩一个坑就少踩一个。
   *
   * 用一条 `role: "user"` 的显式标注消息而不是 `role: "tool"`：我们没走函数调用协议，
   * 各家 OpenAI 兼容端点对 `tool` 消息的校验不一致，而带标注的 user 消息到处都能跑。
   */
  #withExecutionResults(messages, replyText, { queried = [], executed = [], deferred = [], maxActions = 0 } = {}) {
    const sections = [
      this.#queryInjectionText(queried),
      this.#writeInjectionText(executed, { deferred, maxActions }),
    ].filter(Boolean);
    if (!sections.length) return messages;
    return [
      ...messages,
      {
        role: 'assistant',
        content:
          replyText ||
          (queried.length
            ? '（我发起了一次只读查询）'
            : executed.length
              ? '（我执行了一次写入操作）'
              : '（我有几条写入草稿没有执行）'),
      },
      { role: 'user', content: sections.join('\n\n') },
    ];
  }

  /**
   * 只读查询的回灌文案。
   *
   * 文案刻意留了"还可以再查"的口子：多轮循环靠它继续下去（查日程 → 查待办 → 写一条 → 回话）。
   * 以前这里写死"不要再输出查询草稿"，等于把模型的手绑住 —— 它只能拿第一轮的数据硬答，
   * 真正需要两步的问题（"先看看有没有冲突，再帮我加一条"）就永远做不完。
   */
  #queryInjectionText(queried) {
    const usable = queried.filter((entry) => entry.result);
    /**
     * 失败/被拦下的查询也要回灌（只要它的原因）。
     *
     * 为什么必须带上：以前只回灌成功的结果，于是"用户选了不联网但让我搜"这种情况下，
     * 模型看不到任何东西，只能说"我没搜到"或者干脆编一段 —— 而真正的原因
     * （联网开关关着 / 被反爬 / 没配密钥）用户永远听不到。失败原因本身就是这次查询的结果。
     */
    const failed = queried
      .filter((entry) => !entry.result && entry.error)
      .map((entry) => ({ target: entry.draft?.target ?? null, reason: entry.error.message ?? String(entry.error) }));
    if (!usable.length && !failed.length) return '';
    return (
      '[系统注入] 上面的只读查询已由系统执行完毕，结果如下（JSON）。请据此处理用户的问题：' +
      '如果还需要查别的，可以再输出一个 query 草稿；否则现在就用自然语言回答用户，不要再输出查询草稿。' +
      '不要再说"需要你确认""我拿不到数据"。\n' +
      JSON.stringify(usable.map((entry) => entry.result)) +
      (failed.length
        ? '\n下面这些查询**没有执行成功**（把原因如实告诉用户，不要假装查过、也不要换个说法编内容）：\n' +
          JSON.stringify(failed)
        : '') +
      this.#searchFeedbackText(queried)
    );
  }

  /**
   * 联网检索的「预算 + 下一步」说明（接在回灌文案后面）。
   *
   * 三件事必须写清楚，缺一个模型就会犯对应的错：
   *   1. **这是第几次、还剩几次** —— 不说，它就会一直换关键词重试到轮次上限，
   *      用户等半天最后只拿到"没搜到"；
   *   2. 失败/空结果时给**具体建议**（换更短的关键词 / 直读网址 / 如实说拿不到）——
   *      只告诉它"没搜到"，它下一步要么原样再搜一遍，要么开编；
   *   3. 预算用尽时明说"系统不会再执行新的检索"，逼它按已有结果收尾。
   */
  #searchFeedbackText(queried) {
    const web = (queried ?? []).filter((entry) => entry?.draft?.target === WEB_TARGET);
    if (!web.length) return '';
    const lines = [];
    for (const entry of web) {
      const attempt = Number(entry.attempt ?? entry.result?.attempt ?? 0);
      const remaining = Number(entry.remaining ?? entry.result?.remaining ?? 0);
      const exhausted = entry.error?.code === SEARCH_RETRY_EXHAUSTED;
      // 没真的出网（联网关着 / 参数不全）时次数没动，不写"第 N 次"，免得模型以为搜过了
      if (!attempt && !exhausted) continue;
      const name = String(entry.draft?.fields?.query ?? entry.draft?.filters?.q ?? entry.draft?.fields?.url ?? '').trim();
      const counter = attempt
        ? `本次检索是第 ${attempt} 次，还剩 ${remaining} 次`
        : `本次没有发起检索（次数未消耗），还剩 ${remaining} 次`;
      const head = `· ${name ? `检索「${name}」` : '本次联网检索'}：${counter}。`;
      // "没有可用结果"有两种：整条失败（entry.error），或者返回了条目但一条可用正文都没有
      // （count===0 / 全部 ok:false）—— 后者更隐蔽，模型很容易当成"网上没有"
      const empty =
        !entry.result ||
        Number(entry.result.count ?? 0) === 0 ||
        (entry.result.items ?? []).every((item) => item.ok === false);
      if (exhausted) {
        /**
         * 预算用尽时**不能**再劝它"换个关键词再搜" —— 那两句建议此刻是做不到的事，
         * 模型照着做只会又发一条被挡回来的草稿。这里只留第三条：用已有结果作答，
         * 或者如实说拿不到并给下一步（这就是用户要的"AI 自己知道该收尾了"）。
         */
        lines.push(`${head}没有拿到可用结果，且**本回合的检索次数已经用完、不能再发起新的检索**：请用已经拿到的结果作答；如果确实没有可用结果，就如实告诉用户"这次没拿到"并给出下一步，不要编造内容。`);
      } else if (entry.error) {
        lines.push(`${head}没有拿到可用结果（${entry.error.message}）。可以这样办：${SEARCH_RETRY_ADVICE.join('；')}。`);
      } else if (empty) {
        lines.push(`${head}没有拿到可用结果（0 条可用条目）。可以这样办：${SEARCH_RETRY_ADVICE.join('；')}。`);
      } else {
        lines.push(head);
      }
    }
    if (!lines.length) return '';
    return `\n[系统注入 · 联网检索预算] 一个回合内的联网检索次数有限，用完之后系统不再执行新的检索：\n${lines.join('\n')}`;
  }

  /**
   * 写操作执行结果的回灌文案（auto 档专用，manual / strict 档没有"已执行"这回事）。
   *
   * 为什么必须有这一段：写操作是系统"背着模型"做的，模型只看得到自己上一轮说过什么
   * （而且草稿代码块在回灌时已经被抽掉了）。没有这条注入，它就只能按"我准备加…"的口吻收尾，
   * 用户永远听不到①这条到底落库了没有、②它和已有日程撞了没有 —— 而后者恰恰是日历最该主动提醒的。
   *
   * 文案里把三件事说死，都是实测会出错的地方：
   *   1. 只能说系统**回报过**的东西（返回的 id / 标题 / 时间），不许编"已经提醒你了"；
   *   2. `conflicts` 非空时必须**主动**点名冲突条目（标题 + 时刻），不要等用户问；
   *   3. 不许把同一件事再输出一遍草稿 —— 靠 #draftKey 去重兜底，但提示词先说清能少一轮废调用。
   *
   * 第二段 `deferred` 是「超出本轮执行上限、没有执行」的那几条：**必须单独说**，
   * 否则模型会按"我给了草稿 = 系统全办了"的语气收尾，而用户屏幕上明明还有几张待确认卡。
   */
  #writeInjectionText(executed, { deferred = [], maxActions = 0 } = {}) {
    const sections = [];
    if (executed?.length) {
      const records = executed.map((entry) => this.#compactWriteResult(entry));
      const failed = records.filter((item) => item.ok === false);
      sections.push(
        '[系统注入] 上面的**写操作已由系统自动执行完毕**（用户选了"自动审批"档，不需要他再点确认）。' +
          '执行结果（JSON）：\n' +
          JSON.stringify(records) +
          '\n请据此用自然语言告诉用户系统**真的做了什么**（用返回的标题与时间，不要编造 id 或没回报过的细节）：' +
          (failed.length ? '执行失败的条目要如实说没成、并说明原因，绝不能报成成功；' : '') +
          '如果某条结果里的 conflicts 非空，必须**主动提醒**"这条和已有的哪条日程时间重叠"（点名冲突条目的标题与时刻），不要等用户来问。' +
          '不要再说"我准备…你确认一下"，也不要重复输出同一条写入草稿。',
      );
    }
    if (deferred?.length) {
      /**
       * 被截断的草稿只给"哪条没执行"，**不给 id** —— 它们还没落库，没有 id 可给。
       * 标题来自 `draftName`（与过程清单同一口径），模型据此能点名说清是哪几条。
       */
      const brief = deferred.map((entry) => ({
        action: entry.draft?.action ?? null,
        target: entry.draft?.target ?? null,
        title: draftName(entry.draft) || null,
        explain: entry.draft?.explain ?? null,
      }));
      const limitText = maxActions === MAX_ACTIONS_UNLIMITED
        ? ''
        : `本轮最多自动执行 ${maxActions} 个操作（设置项「一轮最多执行几个操作」），`;
      sections.push(
        `[系统注入] 本轮还有 ${deferred.length} 条写入草稿**没有执行**：${limitText}` +
          '超出的部分已留成**待确认草稿**，等用户点确认后才会落库。' +
          '没有执行的是（JSON）：\n' +
          JSON.stringify(brief) +
          `\n请**明确告诉用户**"还有 ${deferred.length} 条因为超出本轮上限没有自动执行，需要你确认"，` +
          '并说清分别是哪几条；**不要**谎称已经全部办好，也不要把它们再输出一遍草稿（确认卡已经在界面上）。',
      );
    }
    return sections.join('\n\n');
  }

  /**
   * 写操作结果的**紧凑投影**：只留模型回话需要的字段。
   *
   * 为什么不整条回灌：`create` 返回的 `item` 是完整记录（description 可能几千字、还带 repeat /
   * 各种内部字段），原样塞进下一轮提示词既贵又容易让模型跑偏；`affected`（id/标题/日期）加上
   * 新建记录自己的时段就够它把话说清楚了。
   *
   * `conflicts` 用的是与确认卡、真写回执**同一份**对象（`schedules.conflictsFor` 的返回），
   * 这里只做字段裁剪，不做二次判断 —— 一份"什么算重叠"的口径就够，多一份迟早会漂移。
   */
  #compactWriteResult(entry) {
    const FIELDS = {
      todo: ['id', 'title', 'deadline', 'priority', 'completed'],
      schedule: ['id', 'title', 'date', 'startTime', 'endTime', 'location', 'category'],
      event: ['id', 'title', 'startDate', 'endDate', 'category'],
    };
    const target = entry.draft?.target ?? null;
    const action = entry.draft?.action ?? null;
    if (entry.error) {
      return { action, target, ok: false, error: entry.error.message ?? String(entry.error) };
    }
    const result = entry.result ?? {};
    const project = (item, keys) => {
      const picked = {};
      for (const key of keys) if (item?.[key] !== undefined && item?.[key] !== null) picked[key] = item[key];
      return picked;
    };
    const keys = FIELDS[target] ?? ['id', 'title'];
    const items = [...(result.item ? [result.item] : []), ...(result.items ?? [])].map((item) => project(item, keys));
    // 冲突条目一定是日程：用日程字段裁，而不是用本条 target 的字段
    const conflicts = (result.conflicts ?? []).map((item) => project(item, FIELDS.schedule));
    return {
      action,
      target,
      ok: true,
      ...(items.length ? { items } : {}),
      ...(result.affected?.length ? { affected: result.affected } : {}),
      ...(result.deleted !== undefined ? { deleted: result.deleted } : {}),
      ...(conflicts.length ? { conflicts, note: `与 ${conflicts.length} 条已有日程时间重叠` } : {}),
      explain: result.explain ?? null,
    };
  }

  /**
   * 这条草稿是不是"已经查过的那条查询"。
   *
   * 比的是**业务指纹**（见 `#draftKey`）而不是整份草稿。为什么必须去重：模型拿到结果后
   * 很容易把同一条查询再发一遍（它想"再确认一次"），不去重就会把 MAX_ROUNDS 全烧在重复查询上，
   * 最终答案永远出不来。失败的查询也算"查过"：同样的草稿再跑一次只会同样失败，白花一次上游调用。
   */
  #isRepeatQuery(entry, queried) {
    const key = this.#draftKey(entry);
    return (queried ?? []).some((item) => this.#draftKey(item) === key);
  }

  /**
   * 草稿的**业务指纹**：动作 + target + 条件 / 字段（+ 记录 id）。
   *
   * 为什么不直接 `JSON.stringify(draft)`：模型换个 `explain` 的说法、`confidence` 抖一下，
   * 整份草稿就不相等了 —— 同一条查询会被当成新查询（把轮次烧光），同一条写入会被执行两遍
   * （auto 档直接落两条重复记录）。只比"这件事本身"才拦得住，所以下面**只取**业务字段。
   */
  #draftKey(entry) {
    return draftFingerprint(entry);
  }

  async #touchConversation(id, firstText) {
    const conversation = this.store.aiConversations.get(id);
    if (!conversation) return;
    const count = this.#messagesOf(id).length;
    const patch = { messageCount: count, lastMessageAt: new Date().toISOString() };
    if (!conversation.title || conversation.title === '新对话') {
      patch.title = String(firstText ?? '').trim().slice(0, TITLE_MAX) || conversation.title;
    }
    await this.store.aiConversations.update(id, patch);
  }
}

/* -------------------------------------------------------------- 附件处理 */

/**
 * 附件归一化。
 *
 * 三类分开处理（**不落 base64**，只在这一次请求里用）：
 *   - 图片：转成多模态 `image_url`（需要模型本身支持看图，否则上游会报错）；
 *   - 文本类（text/* 与常见后缀）：读成字符串内联进提示词，单文件 20k 字符、合计 60k 上限；
 *   - 其它：只把文件名告诉模型，明确说"内容无法读取"，免得它假装看过。
 */
export function normalizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, MAX_ATTACHMENTS)
    .map((item) => ({
      name: String(item?.name ?? '未命名').slice(0, 120),
      type: String(item?.type ?? ''),
      size: Number(item?.size) || 0,
      dataUrl: typeof item?.dataUrl === 'string' ? item.dataUrl : '',
      text: typeof item?.text === 'string' ? item.text.slice(0, MAX_TEXT_CHARS) : '',
    }))
    .filter((item) => item.dataUrl || item.text || item.name);
}

const TEXT_LIKE = /^(text\/|\.(txt|md|markdown|csv|json|ya?ml|log|ini|tex)$)/i;

/** 已知不支持看图的官方模型（`deepseek-v4-pro`）；其它端点/模型不拦，交给上游判断。 */
function isKnownNonVisionModel(model) {
  return /^deepseek-v4-pro$/i.test(String(model ?? '').trim());
}

/** 组装送进模型的 user 内容：纯文本、或"文本 + 图片"的多模态数组。 */
export function buildUserContent(text, files) {
  // 只送官方支持的四种格式：格式不对上游会 400（官方按**文件内容**判断格式），
  // 所以不认识的一律降级成"读不了的文件"，而不是硬塞进去赌一把
  const images = files.filter((file) => IMAGE_TYPES.includes(file.type) && file.dataUrl).slice(0, MAX_IMAGES);
  const parts = [text || '（见附件）'];

  const texts = files.filter((file) => file.text || TEXT_LIKE.test(file.type) || TEXT_LIKE.test(file.name));
  let budget = MAX_TEXT_TOTAL;
  if (texts.length) {
    const blocks = [];
    for (const file of texts) {
      const body = file.text || '（没能读到内容）';
      const clipped = body.slice(0, budget);
      budget -= clipped.length;
      blocks.push(`----- 附件：${file.name}（${file.size} 字节）-----\n${clipped}${clipped.length < body.length ? '\n…（已截断）' : ''}`);
      if (budget <= 0) break;
    }
    parts.push(`\n\n【用户附上了文本文件，内容如下】\n${blocks.join('\n\n')}`);
  }

  const opaque = files.filter((file) => !images.includes(file) && !texts.includes(file));
  if (opaque.length) {
    parts.push(`\n\n【用户附了这些文件，但本程序读不了它们的内容，别假装看过】${opaque.map((file) => `${file.name}（${file.type || '未知类型'}，${file.size} 字节）`).join('、')}`);
  }
  const prompt = parts.join('');

  if (!images.length) return prompt;
  return [
    { type: 'text', text: prompt },
    // 有 file_id 就用官方 Files API 的引用块（不受 48MiB 请求体 / 32MiB 单图内联限制，
    // 同一张图多轮复用也不用重传）；没上传成功才退回内联 base64。
    ...images.map((file) =>
      file.fileId
        ? { type: 'file', file_id: file.fileId }
        : { type: 'image_url', image_url: { url: file.dataUrl } },
    ),
  ];
}
