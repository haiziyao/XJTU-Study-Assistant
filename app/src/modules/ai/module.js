/**
 * AI 模块：把框架里「只留接口」的 AI 层接上真实模型。
 *
 * 与框架的边界（本模块**没有**改 `src/core` 一行）：
 * - `services.aiBridge` 是框架提供的全局服务，这里注册 provider，
 *   于是 `POST /ai/nl2command` 从 501 占位变成真的可用（降级路径仍是本地规则）；
 * - 对话与配置走自己的路由 `/api/v1/ai/*`（见 routes.js），键名与框架的 `/ai/capabilities` 不冲突。
 *
 * 依赖声明
 * --------
 * - order = 90：排在所有业务模块之后。对话要读待办/日程做摘要、要经 `services.commands`
 *   预校验草稿，排前面会拿到空的集合与服务。
 * - 需要 `ctx.dataDir`：密钥落在 `<dataDir>/ai-config.json`（0600），**不进 JsonStore**
 *   （集合是 0644 的业务数据，语义不同）。
 *
 * 私有文件
 * --------
 * `data/ai-config.json` —— 地址/模型/密钥/对话参数，`DELETE /api/v1/ai/config` 可清空。
 * `data/ai-schedules.json` —— 定时唤醒任务（时间 + 提示词），见 `schedule.js`。
 */

import { AiConfigStore } from './config.js';
import { AiChatService, SCHEDULE_RUN_OPTIONS } from './chat-service.js';
import { AiScheduleService } from './schedule.js';
import { createOpenAiCompatProvider } from './provider.js';
import { AiFiles } from './files.js';
import { registerAiRoutes } from './routes.js';
import { AI_TOOL_SPECS } from './tools.js';

export default {
  id: 'ai',
  title: 'AI 接入',
  order: 90,

  collections: [
    { name: 'aiConversations', file: 'ai-conversations.json' },
    { name: 'aiMessages', file: 'ai-messages.json', indexes: ['conversationId'] },
    // 上传到上游 Files API 的本地账本（只存元信息 + file_id，不存字节）
    { name: 'aiFiles', file: 'ai-files.json', indexes: ['hash'] },
    // 定时唤醒任务（时间 + 提示词）：到点由调度器触发一次对话，结果写进 conversationId 指定的会话
    { name: 'aiSchedules', file: 'ai-schedules.json', indexes: ['nextRunAt'] },
    // 后台模型调用的用量账本（按天 + 用途聚合）：周报这类不落会话的调用也要能用 /ai/usage 看见
    { name: 'aiUsage', file: 'ai-usage.json', indexes: ['date'] },
  ],

  aiTools: AI_TOOL_SPECS,

  async createServices({ store, broadcast, services, dataDir, options, modules = [], log }) {
    const config = new AiConfigStore({ dataDir, options });
    await config.load();

    const provider = createOpenAiCompatProvider({ getConfig: () => config.get() });

    // 聚合各业务模块自己声明的 AI 扩展点（ai 模块 order=90，排在最后，所以能一次收齐）：
    //   aiPrompt       -> 拼进系统提示词，模型由此知道有哪些 target 可查
    //   aiQueryFields  -> 只读查询结果回灌时的字段投影（覆盖内置的 todo/schedule/event 三张表）
    //   aiQueryLimits  -> 各 target 回灌给模型的条数上限（如成绩单要整份给，不能被 20 条腰斩）
    const domainBlocks = modules.map((mod) => mod.aiPrompt).filter(Boolean);
    const queryFields = Object.assign({}, ...modules.map((mod) => mod.aiQueryFields ?? {}));
    const queryLimits = Object.assign({}, ...modules.map((mod) => mod.aiQueryLimits ?? {}));

    // 只在**配了密钥**时把 provider 注册给框架（`name` 用 getter，换 provider 不用重注册）：
    // - 已配置：/ai/capabilities 显示 available: true，/ai/nl2command 走模型；
    // - 未配置：必须撤掉注册，否则 /ai/nl2command 的 `fallback: "rules"` 降级路径会被
    //   一个不可用的 provider 挡住 —— 「AI 挂了也能用」是框架的明文承诺。
    const bridge = {
      sync() {
        if (config.get().apiKey) {
          services.aiBridge.registerProvider({
            get name() {
              return config.get().provider;
            },
            nlToCommand: (text, context) => ai.nlToCommand(text, context),
          });
        } else {
          services.aiBridge.unregisterProvider();
        }
      },
    };

    const files = new AiFiles({ store, provider });
    const ai = new AiChatService({
      store,
      broadcast,
      services,
      config,
      provider,
      files,
      commands: services.commands,
      onConfigChange: () => bridge.sync(),
      domainBlocks,
      queryFields,
      queryLimits,
      logger: log,
      // 只给测试/离线环境用：`createServer({ ai: { searchFetch } })`
      searchFetch: options?.searchFetch,
    });
    bridge.sync();

    // 定时唤醒：只装配调度内核（存储 + 到点判定 + 每分钟一次的驱动），
    // 真正的模型调用在这里接上去 —— 跑一次 `ai.send` 就够：消息落库、会话计数、
    // token 用量、`ai_message` 广播全都顺带就有了，不必再抄一遍那套流程。
    //
    // 名字用 aiScheduler 而不是 schedules：calendar 模块已经占用了 `services.schedules`
    // （课程表服务），装配层是 Object.assign 合并的，重名会把它静默顶掉。
    const aiScheduler = new AiScheduleService({ store, broadcast });
    aiScheduler.setRunner(async (task) => {
      // 没配密钥就别装作跑过了：如实记 lastError，用户回来一眼能看出原因
      if (!ai.status().configured) return { ok: false, error: 'AI 尚未配置密钥，定时唤醒没有执行' };
      try {
        const result = await ai.send({
          text: task.prompt,
          conversationId: task.conversationId ?? undefined,
          stream: false,
          // 无人值守的两条底线：不自动写库（草稿留成待确认），不偷偷联网（任务自己声明要不要搜）
          permission: SCHEDULE_RUN_OPTIONS.permission,
          search: task.search ?? SCHEDULE_RUN_OPTIONS.search,
          context: SCHEDULE_RUN_OPTIONS.context,
        });
        return { ok: true, conversationId: result.conversation?.id, content: result.assistant?.content };
      } catch (error) {
        // 目标会话被删掉（用户在「对话」页清空了会话）不该让任务从此永远失败：
        // 新建一个会话并把新 id 写回任务，下一次照常能响。
        if (error?.code === 'NOT_FOUND' || error?.status === 404) {
          // createConversation 返回的是会话记录本身（见 routes.js 的用法）
          const created = await ai.createConversation('定时唤醒');
          await aiScheduler.update(task.id, { conversationId: created.id });
          const retry = await ai.send({
            text: task.prompt,
            conversationId: created.id,
            stream: false,
            permission: SCHEDULE_RUN_OPTIONS.permission,
            search: task.search ?? SCHEDULE_RUN_OPTIONS.search,
            context: SCHEDULE_RUN_OPTIONS.context,
          });
          return { ok: true, conversationId: retry.conversation?.id, content: retry.assistant?.content };
        }
        throw error;
      }
    });

    return { ai, files, aiScheduler };
  },

  registerRoutes(router, ctx) {
    registerAiRoutes(router, {
      ai: ctx.own.ai,
      files: ctx.own.files,
      aiScheduler: ctx.own.aiScheduler,
      apiPrefix: ctx.apiPrefix,
    });
  },

  /** 调度器持有 setInterval：必须 listen 成功后启动、close 时停止（漏停会让 `node --test` 退不出去）。 */
  start({ own }) {
    own.aiScheduler?.start();
  },

  stop({ own }) {
    own.aiScheduler?.stop();
  },
};
