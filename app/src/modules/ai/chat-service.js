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
 *   4. 调上游 → 抽草稿 → dryRun 预校验 → 更新这条消息为 `done`；
 *   5. 失败则把这条消息标成 `failed` 并带上错误（不删，用户能看到"刚才那次没成"）。
 *
 * 本服务**不直接写业务数据**：草稿只做 dryRun 预览，真正落库由用户确认后走 `/commands/execute`。
 */

import { ERROR_CODES } from '../../shared/constants.js';
import { HttpError } from '../../core/http/router.js';
import { todayKey } from '../../shared/time.js';

import { maskAiConfig } from './config.js';
import { extractDrafts, previewDrafts } from './drafts.js';
import { buildChatSystemPrompt, buildCommandSystemPrompt } from './prompt.js';

/** 给上下文注入留的默认预算（与接口文档 §10.7 一致）。 */
const DEFAULT_MEMORY_BUDGET = Object.freeze({ maxItems: 8, maxChars: 600 });

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
 * 思考强度：映射到 OpenAI 兼容的 `reasoning_effort`。
 * `none` 表示不带这个字段（也就是上游默认行为）。
 */
const THINKING_LEVELS = Object.freeze({ none: null, low: 'low', medium: 'medium', high: 'high' });

/**
 * 写入权限三档（UI 上叫「自动审批 / 手动审批 / 全部确认」）：
 * - `auto`   自动审批：**写操作也自动执行**，结果以卡片回执（默认不选它，风险自负）；
 * - `manual` 手动审批（默认）：只读查询自动跑，写操作必须点确认；
 * - `strict` 全部确认：连只读查询也要用户点确认。
 */
const PERMISSIONS = Object.freeze(['auto', 'manual', 'strict']);

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
  constructor({ store, broadcast, services, config, provider, commands, onConfigChange }) {
    this.store = store;
    this.broadcast = broadcast;
    this.services = services;
    this.config = config;
    this.provider = provider;
    this.commands = commands;
    /** 配置变化后的回调（模块层用它决定是否把 provider 注册给 aiBridge）。 */
    this.onConfigChange = onConfigChange;
  }

  // ---------------------------------------------------------------- 状态 / 配置

  status() {
    const conversations = this.store.aiConversations?.all?.() ?? [];
    const messages = this.store.aiMessages?.all?.() ?? [];
    return {
      configured: this.provider.configured(),
      provider: this.provider.configured() ? this.provider.name : null,
      config: maskAiConfig(this.config.get()),
      conversations: conversations.length,
      messages: messages.length,
      /** 前端据此决定聊天框上方显示「AI 未配置」还是模型名。 */
      ready: this.provider.configured(),
    };
  }

  maskConfig() {
    return maskAiConfig(this.config.get());
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
        { role: 'system', content: buildCommandSystemPrompt({ ...enriched, ...context }) },
        { role: 'user', content: trimmed },
      ],
      temperature: 0,
    });
    const { drafts } = extractDrafts(result.text);
    if (!drafts.length) {
      return { ok: false, raw: trimmed, warnings: ['模型没有给出可用的指令对象'], explain: result.text.trim().slice(0, 200) };
    }
    return { ...drafts[0], raw: trimmed };
  }

  /**
   * 发一条消息。
   * @param {object} input
   * @param {string} input.text 用户输入
   * @param {string} [input.conversationId] 不传则新建会话
   * @param {object} [input.context] `{ view, module, courseId }`
   * @param {boolean} [input.stream] 是否边生成边通过 WebSocket 广播
   */
  async send({ text, conversationId, context = {}, stream = false, attachments = [], thinking = 'none', permission = 'manual' } = {}) {
    const trimmed = String(text ?? '').trim();
    const files = normalizeAttachments(attachments);
    // 允许"只发附件不写字"，但两者都空就没意义
    if (!trimmed && !files.length) throw HttpError.badRequest('text 不能为空');
    const effort = THINKING_LEVELS[thinking] ?? null;
    const mode = PERMISSIONS.includes(permission) ? permission : 'manual';
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
      // 只落**元信息**：base64 动辄几 MB，塞进 JSON 集合会把业务数据文件撑爆
      attachments: files.map((file) => ({ name: file.name, type: file.type, size: file.size })),
      thinking,
      permission: mode,
    });

    const enriched = await this.buildContext(context);
    // 作图：设置里开着就给（默认开），关着但用户用了「画…」这类指令词也临时给
    const draw = this.config.get().drawMode !== false || DRAW_KEYWORDS.test(trimmed);
    const history = this.#history(conversation.id);
    // #history 里最后一条就是刚存的用户正文，这里换成"正文 + 附件"的多模态版本
    const messages = [
      { role: 'system', content: buildChatSystemPrompt({ ...enriched, ...context, draw }) },
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
    });

    let partial = '';
    try {
      const result = await this.provider.chat({
        messages,
        stream: Boolean(stream),
        reasoningEffort: effort,
        onDelta: stream
          ? (delta) => {
              partial += delta;
              this.broadcast?.({
                type: 'ai_delta',
                module: 'ai',
                payload: { conversationId: conversation.id, messageId: assistant.id, delta, text: partial },
              });
            }
          : undefined,
      });

      const extracted = extractDrafts(result.text ?? partial);
      const previewed = await previewDrafts(this.commands, extracted.drafts);

      // 只读查询**自动执行**：查询不改数据，让用户为"我明天有什么课"点一次确认毫无意义，
      // 更关键的是模型看不到结果就只能说"我拿不到数据"（实测它真的会这么说）。
      // 执行结果回灌给模型，它再用自然语言回答 —— 这是"只读工具先放开"的最小实现。
      // 「全部确认」：连只读查询也要用户点确认，所以不自动执行
      const autoQuery = mode !== 'strict';
      const queried = autoQuery ? await this.#runReadOnlyQueries(previewed) : [];
      let content = extracted.text;
      let drafts = autoQuery
        ? previewed.filter((entry) => entry.draft?.action !== 'query' || entry.error)
        : previewed;
      // 「自动审批」：写操作也直接执行（先过 dryRun 校验，再真执行）
      const executed = mode === 'auto' ? await this.#autoExecuteWrites(drafts) : [];
      if (executed.length) drafts = drafts.filter((entry) => !executed.some((item) => item.entry === entry));
      let followupUsage = null;
      let queryError = null;

      if (queried.length) {
        try {
          const followup = await this.provider.chat({
            messages: this.#withQueryResults(messages, extracted.text, queried),
            reasoningEffort: effort,
          });
          const answer = extractDrafts(followup.text);
          content = answer.text || followup.text;
          followupUsage = followup.usage ?? null;
          // 第二次回复里的写操作草稿照样要渲染出来（"顺手把那条推迟到明天"）
          const extra = await previewDrafts(this.commands, answer.drafts.filter((item) => item.action !== 'query'));
          drafts = [...drafts, ...extra];
        } catch (error) {
          // 总结这一步失败不影响"已经查到了"：正文仍然给用户，数据靠下面的 queried 卡片呈现
          queryError = error?.message ?? '查询结果总结失败';
        }
      }

      const saved = await this.store.aiMessages.update(assistant.id, {
        content: content || (queried.length ? '已经查到数据。' : ''),
        drafts,
        executed,
        thinking,
        permission: mode,
        // 只读查询的原始结果：前端据此画数据卡片，也方便排查"模型到底看到了什么"
        queried,
        status: 'done',
        model: result.model ?? this.config.get().model,
        usage: result.usage ?? null,
        usageFollowup: followupUsage,
        finishReason: result.finishReason ?? null,
        // 抽掉草稿前的原文留着：排查"模型到底说了啥"时只有这里有
        raw: extracted.drafts.length ? result.text : null,
        error: queryError ? { code: 'PARTIAL', message: queryError } : null,
      });
      await this.#touchConversation(conversation.id, trimmed);
      this.broadcast?.({
        type: 'ai_message',
        module: 'ai',
        payload: { conversationId: conversation.id, message: saved, drafts, queried },
      });
      return {
        ok: true,
        conversation: this.store.aiConversations.get(conversation.id),
        user: userMessage,
        assistant: saved,
        drafts,
        queried,
        executed,
        // 把这一轮的选择回显给调用方：前端据此在气泡上标注"自动执行/思考强度"
        thinking,
        permission: mode,
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

  #messagesOf(conversationId) {
    return (this.store.aiMessages?.all?.() ?? [])
      .filter((item) => item.conversationId === conversationId)
      .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
  }

  /**
   * 送进模型的历史：最近 N 轮（一轮 = 一问一答）。
   * 只带 role + content —— 草稿、usage 这些是给人看的，进提示词只会浪费 token。
   */
  #history(conversationId) {
    const turns = this.config.get().historyTurns ?? 0;
    if (turns <= 0) return [];
    const all = this.#messagesOf(conversationId).filter(
      (item) => (item.role === 'user' || item.role === 'assistant') && item.status !== 'failed' && item.content,
    );
    return all.slice(-turns * 2).map((item) => ({ role: item.role, content: item.content }));
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
  async #runReadOnlyQueries(previewed) {
    const out = [];
    for (const entry of previewed) {
      if (entry.error || entry.draft?.action !== 'query') continue;
      if (out.length >= MAX_AUTO_QUERIES) break;
      try {
        const result = await this.commands.execute(entry.draft, { dryRun: true });
        out.push({ draft: entry.draft, result: this.#compactQueryResult(entry.draft.target, result) });
      } catch (error) {
        out.push({ draft: entry.draft, error: { code: error.code ?? 'INTERNAL', message: error.message } });
      }
    }
    return out;
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
    };
    const fields = FIELDS[target] ?? ['id', 'title'];
    const items = (result.items ?? []).slice(0, MAX_QUERY_ITEMS).map((item) => {
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
      items,
    };
  }

  /**
   * 把查询结果回灌进对话（第二次模型调用）。
   *
   * 用一条 `role: "user"` 的显式标注消息而不是 `role: "tool"`：我们没走函数调用协议，
   * 各家 OpenAI 兼容端点对 `tool` 消息的校验不一致，而带标注的 user 消息到处都能跑。
   */
  #withQueryResults(messages, replyText, queried) {
    const usable = queried.filter((entry) => entry.result);
    return [
      ...messages,
      { role: 'assistant', content: replyText || '（我发起了一次只读查询）' },
      {
        role: 'user',
        content:
          '[系统注入] 上面的只读查询已由系统执行完毕，结果如下（JSON）。请**据此直接用自然语言回答用户的问题**：' +
          '不要再说"需要你确认""我拿不到数据"，也不要再输出查询草稿。\n' +
          JSON.stringify(usable.map((entry) => entry.result)),
      },
    ];
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

/** 组装送进模型的 user 内容：纯文本、或"文本 + 图片"的多模态数组。 */
export function buildUserContent(text, files) {
  const images = files.filter((file) => file.type.startsWith('image/') && file.dataUrl).slice(0, MAX_IMAGES);
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
    ...images.map((file) => ({ type: 'image_url', image_url: { url: file.dataUrl } })),
  ];
}
