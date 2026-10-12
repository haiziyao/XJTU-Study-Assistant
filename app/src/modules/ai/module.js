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
 */

import { AiConfigStore } from './config.js';
import { AiChatService } from './chat-service.js';
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
  ],

  aiTools: AI_TOOL_SPECS,

  async createServices({ store, broadcast, services, dataDir, options, modules = [] }) {
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
    });
    bridge.sync();

    return { ai, files };
  },

  registerRoutes(router, ctx) {
    registerAiRoutes(router, { ai: ctx.own.ai, files: ctx.own.files, apiPrefix: ctx.apiPrefix });
  },
};
