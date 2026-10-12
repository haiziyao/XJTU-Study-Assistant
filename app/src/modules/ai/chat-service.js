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
 *      抽草稿 → dryRun 预校验 → 只读查询自动执行（`auto` 档连写操作一起执行）→
 *      把查询结果回灌进上下文再进下一轮；某一轮没查出**新**查询，就说明它在作答，循环结束；
 *   5. 用**最后一轮**的正文把占位消息更新成 `done`（`rounds` / `roundLimit` / `usageRounds` 一起记下）；
 *   6. 失败：第一轮就失败 → 整条标 `failed` 并带上错误（不删，用户能看到"刚才那次没成"）；
 *      第二轮及以后的"总结失败" → 只记 `PARTIAL`，已经查到的数据照常返回。
 *
 * 本服务**不直接写业务数据**：草稿只做 dryRun 预览，真正落库由用户确认后走 `/commands/execute`。
 */

import { ERROR_CODES } from '../../shared/constants.js';
import { HttpError } from '../../core/http/router.js';
import { todayKey } from '../../shared/time.js';

import { maskAiConfig } from './config.js';
import { extractDrafts, previewDrafts } from './drafts.js';
import { buildChatSystemPrompt, buildCommandSystemPrompt } from './prompt.js';
import {
  readPages,
  searchWeb,
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
const MAX_ROUNDS = 5;

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
const SUMMARY_MIN_MESSAGES = 6;
const SUMMARY_MAX_CHARS = 600;

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

export class AiChatService {
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
      const rounds =
        Array.isArray(message.usageRounds) && message.usageRounds.length
          ? [
              message.usage ?? message.usageRounds[0],
              message.usageFollowup ?? message.usageRounds[1],
              ...message.usageRounds.slice(2),
            ]
          : [message.usage, message.usageFollowup];
      for (const raw of rounds) {
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
    return {
      ok: true,
      text: String(result.text ?? '').trim(),
      usage: result.usage ?? null,
      model: this.config.get().model,
      provider: this.config.get().provider,
    };
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
    const summary = await this.#ensureSummary(conversation);
    // 作图：设置里开着就给（默认开），关着但用户用了「画…」这类指令词也临时给
    const draw = this.config.get().drawMode !== false || DRAW_KEYWORDS.test(trimmed);
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

    // 一次 send 里所有"跨轮"的状态都提到循环外面 —— 它们最终要一起落库/回显
    let partial = '';            // 本轮已流出的正文（第一轮就失败时，这就是能留住的那半句）
    let reasoningAll = '';       // 思维链：**跨轮累积**，一张「思考过程」卡里看得到全部轮
    const usageRounds = [];      // 每轮的 usage（/ai/usage 按它算多次调用）
    const queried = [];          // 只读查询结果：跨轮累积
    const executed = [];         // 自动执行的写操作：跨轮累积
    let drafts = [];             // 留给用户确认的草稿（没执行的，含校验不过的）
    let content = '';            // 被采纳的那一轮正文（每轮都会被下一轮覆盖）
    let lastRaw = null;          // 最近一轮"抽草稿前"的原文
    let lastModel = model;
    let lastFinishReason = null;
    let queryError = null;
    let hitRoundLimit = false;
    let rounds = 0;
    try {
      // 上下文逐轮追加（回灌 = 追加一条 assistant 草稿 + 一条注入结果的 user），
      // 所以下一轮**看得到**前面所有轮查过什么，不会把同一条查询再问一遍。
      let turnMessages = messages;
      for (let round = 1; round <= MAX_ROUNDS; round += 1) {
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
          // 第一轮就失败 = 这条回复彻底没成，照旧往上抛（外层把消息标 failed）
          if (round === 1) throw error;
          // 后面几轮失败只是"总结这一步没成"：已经查到的数据必须照常返回给用户，
          // 所以只记 PARTIAL 然后收尾（数据靠 queried 卡片呈现）。
          queryError = error?.message ?? '查询结果总结失败';
          break;
        }

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
        // 原文只在"这轮确实抽出了草稿"时更新：排查"模型到底说了啥"时只有这里有，
        // 而纯自然语言那一轮（content 就等于原文）留着也是重复。
        if (extracted.drafts.length) lastRaw = result.text ?? partial ?? '';

        // ── 写操作 ──────────────────────────────────────────────────────────
        // 「自动审批」**每一轮**都要跑：以前只在第一轮回灌前执行一次，于是"先查一次、再照着写"
        // 这条最常见的路径里，第二轮才冒出来的写草稿再也无人执行 —— 这正是用户说的
        // "自动审批没啥用"。没执行的（校验不过的、非 auto 档的）留在 drafts 里走人工确认卡。
        const autoQuery = mode !== 'strict';
        let roundDrafts = autoQuery
          ? previewed.filter((entry) => entry.draft?.action !== 'query' || entry.error)
          : previewed;
        // 同一条写操作被模型在多轮里重复输出时**只能执行一次** —— auto 档尤其致命：
        // 它会落两条一模一样的记录。模型看不到自己上一轮输出过的 ```command 块（回灌时草稿已经
        // 被抽掉了），只看到"我准备加一条待办"的正文，所以它在后面某一轮把同一件事再说一遍很常见。
        const doneKeys = new Set(executed.map((item) => this.#draftKey(item.entry)));
        const freshWrites = roundDrafts.filter((entry) => !doneKeys.has(this.#draftKey(entry)));
        const executedNow = mode === 'auto' ? await this.#autoExecuteWrites(freshWrites) : [];
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
            })
          : [];
        queried.push(...fresh);

        // **循环终止条件**：这一轮没有查出任何"新"查询 = 模型这轮是在直接回答用户，
        // 它就是最终回答，收尾。这条判断同时覆盖两种正常结束：纯聊天（压根没草稿）、
        // 以及查完之后开始作答（模型不再发查询草稿）。
        if (!fresh.length) break;
        // 还有新查询、但轮数已经用光（模型想查第六次）：记下来，调用方据此知道
        // "答案是被上限截断的"，而不是以为模型就答了这么点。
        if (round >= MAX_ROUNDS) {
          hitRoundLimit = true;
          break;
        }
        // 把这一轮的结果回灌进上下文，进入下一轮 —— 这才是真正的工具循环
        turnMessages = this.#withQueryResults(turnMessages, extracted.text, fresh);
      }

      const saved = await this.store.aiMessages.update(assistant.id, {
        // 正文 = **最后一轮**抽掉草稿后的话；它为空时按"这一刻的事实"兜底：
        // 查过数据就说查到了、自动执行过写操作就说处理好了（细节另有数据卡片/回执卡）。
        content: content || (queried.length ? '已经查到数据。' : executed.length ? '已经照你说的处理好了。' : ''),
        // 草稿 / 已执行 / 查询都是**跨轮累积**：用户看到的应该是整次交互的全貌
        drafts,
        executed,
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

  // ---------------------------------------------------------------- 内部

  /**
   * 需要时生成/更新这段对话的滚动摘要，返回要注入提示词的文本（没有就返回空串）。
   *
   * 触发条件是"窗口之外还有没压过的消息，且数量够多"，所以：
   *   - 正常短对话一次压缩都不会发生（不花额外的钱）；
   *   - 长对话每积累 `SUMMARY_MIN_MESSAGES` 条才压一次；
   *   - 已经覆盖的部分不重压（`summaryCount` 记着覆盖到第几条）。
   */
  async #ensureSummary(conversation) {
    const existing = String(conversation?.summary ?? '').trim();
    const covered = Number(conversation?.summaryCount ?? 0);
    const turns = this.config.get().historyTurns ?? 0;
    if (turns <= 0) return existing;

    const all = this.#messagesOf(conversation.id).filter(
      (item) => (item.role === 'user' || item.role === 'assistant') && item.status !== 'failed' && item.content,
    );
    // 窗口之外的部分才是"该被压缩"的：窗口里的内容模型直接看得到，压了纯属浪费
    const older = all.slice(0, Math.max(0, all.length - turns * 2));
    if (older.length - covered < SUMMARY_MIN_MESSAGES) return existing;

    const fresh = older.slice(covered);
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
            content:
              (existing ? `【已有摘要】\n${existing}\n\n` : '') +
              `【需要并入的对话】\n${transcript}`,
          },
        ],
        temperature: 0.2,
      });
      const text = String(result?.text ?? '').trim().slice(0, SUMMARY_MAX_CHARS);
      if (!text) return existing;
      await this.store.aiConversations.update(conversation.id, {
        summary: text,
        summaryCount: older.length,
        summaryAt: new Date().toISOString(),
      });
      return text;
    } catch (error) {
      // 压缩是"锦上添花"：失败只记日志，绝不让这条消息发不出去
      this.#log('warn', `对话摘要压缩失败（继续用旧摘要）：${error?.message ?? error}`);
      return existing;
    }
  }

  #messagesOf(conversationId) {
    return (this.store.aiMessages?.all?.() ?? [])
      .filter((item) => item.conversationId === conversationId)
      .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
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
    const all = this.#messagesOf(conversationId).filter(
      (item) => (item.role === 'user' || item.role === 'assistant') && item.status !== 'failed' && item.content,
    );
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
    const line = `[上一轮：${parts.join('；')}]`;
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
  async #runReadOnlyQueries(previewed, { searchMode = 'off' } = {}) {
    const out = [];
    for (const entry of previewed) {
      if (entry.draft?.action !== 'query') continue;
      if (out.length >= MAX_AUTO_QUERIES) break;
      // 联网检索走自己的执行器：它要读**用户在界面上选的通道**（校外/校内/关），
      // 而那个信息只存在于这一次请求里，命令服务那边看不到（理由见 #runWebQuery）。
      if (entry.draft.target === WEB_TARGET) {
        out.push(await this.#runWebQuery(entry, searchMode));
        continue;
      }
      if (entry.error) continue;
      try {
        const result = await this.commands.execute(entry.draft, { dryRun: true });
        out.push({ draft: entry.draft, result: this.#compactQueryResult(entry.draft.target, result) });
      } catch (error) {
        out.push({ draft: entry.draft, error: { code: error.code ?? 'INTERNAL', message: error.message } });
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
  async searchPreview({ query, mode = 'web', limit } = {}) {
    const config = this.config.get() ?? {};
    const scope = WEB_SEARCH_MODES.includes(mode) ? mode : 'web';
    const configured = normalizeSearchLimit(config.searchMaxPages, { fallback: SEARCH_LIMIT_DEFAULT });
    const max = normalizeSearchLimit(limit, { fallback: configured });
    const log = (level, message) => this.#log(level, message);
    const detailed = await searchWebDetailed({ query, mode: scope, limit: max, config, log, fetchImpl: this.searchFetch ?? undefined });
    const pages = await readPages(detailed.results, { limit: max, log, fetchImpl: this.searchFetch ?? undefined });
    const byUrl = new Map(pages.map((page) => [page.url, page]));
    const items = detailed.results.map((item) => {
      const page = byUrl.get(item.url) ?? {};
      return {
        title: item.title,
        url: item.url,
        snippet: item.snippet,
        source: item.source,
        ok: page.ok !== false,
        error: page.error ?? null,
        chars: String(page.text ?? '').length,
        text: String(page.text ?? '').slice(0, WEB_TEXT_CHARS),
      };
    });
    return {
      query: detailed.query,
      mode: detailed.mode,
      limit: detailed.limit,
      backend: detailed.backend,
      campus: detailed.campus,
      notes: detailed.notes,
      count: items.length,
      read: items.filter((item) => item.chars > 0).length,
      items,
    };
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
  async #runWebQuery(entry, searchMode) {
    const draft = entry.draft;
    const query = String(draft.fields?.query ?? draft.filters?.q ?? '').trim();
    if (!query) {
      return { draft, error: { code: 'BAD_REQUEST', message: '联网检索缺少检索词（fields.query）' } };
    }
    if (!WEB_SEARCH_MODES.includes(searchMode) || searchMode === 'off') {
      return {
        draft,
        error: {
          code: 'SEARCH_OFF',
          message:
            '联网搜索已关闭（输入框下面的地球图标选了「不联网」）。想让我搜，先把它切成「从校外网搜索」或「从校内网搜索」。',
        },
      };
    }
    // 通道以界面为准：界面选校外时，模型写 campus 也不越权（反过来同理）
    const mode = searchMode;
    const config = this.config.get() ?? {};
    // 「网络搜索最大条数」在设置里（5–30，默认 8）：改了立刻生效，不必重启进程
    const limit = normalizeSearchLimit(config.searchMaxPages, { fallback: SEARCH_LIMIT_DEFAULT });
    const asked = normalizeSearchLimit(draft.fields?.limit, { fallback: limit });
    const count = Math.max(1, Math.min(limit, asked));
    const log = (level, message) => this.#log(level, message);
    try {
      const results = await searchWeb({ query, mode, limit: count, config, log, fetchImpl: this.searchFetch ?? undefined });
      if (!results.length) {
        return {
          draft,
          result: this.#compactQueryResult(WEB_TARGET, {
            filters: { query, mode },
            count: 0,
            items: [],
            explain:
              mode === 'campus'
                ? '校内检索没有返回结果（可能被反爬挡住，或校内站点里没有匹配）—— 如实告诉用户没搜到，不要编造'
                : '检索没有返回结果（可能被搜索引擎拦截，或还没配置搜索 API 密钥）—— 如实告诉用户没搜到，不要编造',
          }),
        };
      }
      const pages = await readPages(results, { limit: count, log, fetchImpl: this.searchFetch ?? undefined });
      const byUrl = new Map(pages.map((page) => [page.url, page]));
      const items = results.slice(0, count).map((item) => {
        const page = byUrl.get(item.url) ?? {};
        return {
          title: item.title,
          url: item.url,
          snippet: item.snippet,
          source: item.source,
          // 正文只在真抓到时才有：`ok:false` 的条目 text 为空、error 说明原因（列表页/PDF/要登录），
          // 模型据此知道"这条只有摘要，别当成读过了"
          text: String(page.text ?? '').slice(0, WEB_TEXT_CHARS),
          // 真实字数单独留一份：界面要显示"读了 N 字"，用截断后的长度会说少
          chars: String(page.text ?? '').length,
          ok: page.ok !== false,
          error: page.error ?? null,
        };
      });
      const read = items.filter((item) => item.text).length;
      return {
        draft,
        result: this.#compactQueryResult(WEB_TARGET, {
          filters: { query, mode },
          count: items.length,
          items,
          explain: `${mode === 'campus' ? '校内' : '校外'}检索「${query}」：搜到 ${results.length} 条，读到 ${read} 篇正文`,
        }),
      };
    } catch (error) {
      return { draft, error: { code: error.code ?? 'INTERNAL', message: `联网检索失败：${error.message}` } };
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
  async #autoExecuteWrites(drafts) {
    const out = [];
    for (const entry of drafts) {
      if (entry.error || entry.draft?.action === 'query' || entry.draft?.ok === false) continue;
      try {
        const result = await this.commands.execute(entry.draft);
        out.push({ entry, draft: entry.draft, result });
      } catch (error) {
        out.push({ entry, draft: entry.draft, error: { code: error.code ?? 'INTERNAL', message: error.message } });
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
      web: ['title', 'url', 'snippet', 'source', 'text', 'chars', 'ok', 'error'],
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
   * 把这一轮查到的只读结果回灌进对话（**每轮**都回灌，不是固定的"第二次调用"）。
   *
   * 用一条 `role: "user"` 的显式标注消息而不是 `role: "tool"`：我们没走函数调用协议，
   * 各家 OpenAI 兼容端点对 `tool` 消息的校验不一致，而带标注的 user 消息到处都能跑。
   *
   * 文案刻意留了"还可以再查"的口子：多轮循环靠它继续下去（查日程 → 查待办 → 写一条 → 回话）。
   * 以前这里写死"不要再输出查询草稿"，等于把模型的手绑住 —— 它只能拿第一轮的数据硬答，
   * 真正需要两步的问题（"先看看有没有冲突，再帮我加一条"）就永远做不完。
   */
  #withQueryResults(messages, replyText, queried) {
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
    return [
      ...messages,
      { role: 'assistant', content: replyText || '（我发起了一次只读查询）' },
      {
        role: 'user',
        content:
          '[系统注入] 上面的只读查询已由系统执行完毕，结果如下（JSON）。请据此处理用户的问题：' +
          '如果还需要查别的，可以再输出一个 query 草稿；否则现在就用自然语言回答用户，不要再输出查询草稿。' +
          '不要再说"需要你确认""我拿不到数据"。\n' +
          JSON.stringify(usable.map((entry) => entry.result)) +
          (failed.length
            ? '\n下面这些查询**没有执行成功**（把原因如实告诉用户，不要假装查过、也不要换个说法编内容）：\n' +
              JSON.stringify(failed)
            : ''),
      },
    ];
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
    const draft = entry?.draft ?? {};
    return JSON.stringify({
      action: draft.action ?? '',
      target: draft.target ?? '',
      filters: draft.filters ?? null,
      fields: draft.fields ?? null,
      id: draft.id ?? null,
    });
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
