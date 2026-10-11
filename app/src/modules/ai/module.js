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
import { registerAiRoutes } from './routes.js';
import { AI_TOOL_SPECS } from './tools.js';

export default {
  id: 'ai',
  title: 'AI 接入',
  order: 90,

  collections: [
    { name: 'aiConversations', file: 'ai-conversations.json' },
    { name: 'aiMessages', file: 'ai-messages.json', indexes: ['conversationId'] },
  ],

  aiTools: AI_TOOL_SPECS,

  async createServices({ store, broadcast, services, dataDir, options }) {
    const config = new AiConfigStore({ dataDir, options });
    await config.load();

    const provider = createOpenAiCompatProvider({ getConfig: () => config.get() });

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

    const ai = new AiChatService({
      store,
      broadcast,
      services,
      config,
      provider,
      commands: services.commands,
      onConfigChange: () => bridge.sync(),
    });
    bridge.sync();

    return { ai };
  },

  registerRoutes(router, ctx) {
    registerAiRoutes(router, { ai: ctx.own.ai, apiPrefix: ctx.apiPrefix });
  },
};
