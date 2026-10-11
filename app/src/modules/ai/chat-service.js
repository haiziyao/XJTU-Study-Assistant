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
  async send({ text, conversationId, context = {}, stream = false } = {}) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) throw HttpError.badRequest('text 不能为空');
    if (!this.provider.configured()) {
      throw new HttpError(501, ERROR_CODES.AI_UNAVAILABLE, 'AI 尚未配置密钥，无法对话', {
        hint: '在设置里填 API Key，或 POST /api/v1/ai/config {"apiKey":"sk-…"}。',
        provider: this.config.get().provider,
      });
    }

    const conversation = conversationId ? this.getConversation(conversationId) : await this.createConversation(trimmed);
    const userMessage = await this.#appendMessage({ conversationId: conversation.id, role: 'user', content: trimmed });

    const enriched = await this.buildContext(context);
    const messages = [
      { role: 'system', content: buildChatSystemPrompt({ ...enriched, ...context }) },
      ...this.#history(conversation.id),
    ];

    // 先落一条占位消息：流式 delta 需要一个稳定的 messageId
    const assistant = await this.#appendMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: '',
      status: stream ? 'streaming' : 'pending',
      model: this.config.get().model,
      provider: this.config.get().provider,
    });

    let partial = '';
    try {
      const result = await this.provider.chat({
        messages,
        stream: Boolean(stream),
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

      const { text: visible, drafts: rawDrafts } = extractDrafts(result.text ?? partial);
      const drafts = await previewDrafts(this.commands, rawDrafts);
      const saved = await this.store.aiMessages.update(assistant.id, {
        content: visible,
        drafts,
        status: 'done',
        model: result.model ?? this.config.get().model,
        usage: result.usage ?? null,
        finishReason: result.finishReason ?? null,
        // 抽掉草稿前的原文留着：排查"模型到底说了啥"时只有这里有
        raw: rawDrafts.length ? result.text : null,
        error: null,
      });
      await this.#touchConversation(conversation.id, trimmed);
      this.broadcast?.({
        type: 'ai_message',
        module: 'ai',
        payload: { conversationId: conversation.id, message: saved, drafts },
      });
      return {
        ok: true,
        conversation: this.store.aiConversations.get(conversation.id),
        user: userMessage,
        assistant: saved,
        drafts,
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
      usage: null,
      model: null,
      provider: null,
      error: null,
      raw: null,
      ...data,
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
