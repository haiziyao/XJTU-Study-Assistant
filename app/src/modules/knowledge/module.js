/**
 * 知识库模块：把 `knowledge/` 下的**外部知识**（当前是教务处政策语料）接进对话。
 *
 * 边界（接口文档 §14.1）：这里只负责"取用"，不负责"记住用户"——
 *   - 语料在**仓库里**（`knowledge/dean/`），由 `scripts/crawl-dean.js` 抓取，本模块**不联网**；
 *   - 检索是**关键词 + 栏目**，不引入向量检索；结果只给**片段**（绝不整篇进提示词）；
 *   - 每篇都带来源 URL，引用必须带出处（政策会修订，用户得能点回去核对）。
 *
 * 与"记忆"（§10）严格分开：那是关于用户本人的事实（≤200 字/条、每条都注入），
 * 这里是外部世界的事实（十万字量级、命中才注入片段）。两者只是共用同一条注入管道。
 */

import { KnowledgeService } from './service.js';
import { createKnowledgeCommands } from './commands.js';
import { registerKnowledgeRoutes } from './routes.js';
import { KNOWLEDGE_TOOLS } from './tools.js';

/**
 * 给对话模型的领域说明。
 *
 * 三条硬规则都写在这里，因为模型最容易犯的错就是"没查到就凭记忆编校规"——
 * 那比答不出来危险得多：用户会照着办。
 */
const AI_PROMPT = `【知识库：教务处政策 / 规章 / 校历】
- 可以用只读指令 {"ok":true,"action":"query","target":"knowledge","filters":{"q":"转专业 条件","limit":5}} 检索教务处政策语料
  （148 篇：学籍管理、课程考核、学业预警、毕业学位、培养方案、校历与作息时间等）。filters 还支持
  category（栏目 slug）与 path（直接读某一篇的前 8000 字）。
- **引用必须带 url**：把校规说成"一般来说"是不行的，每条结论都要能点回教务处原文。
- **语料里没有的，如实说不知道**（例如"今年保研名额"）——绝不许用你自己的记忆编政策。
- 结果里 kind 为 portal / attachments / external-links 的篇目**没有可检索正文**
  （正文在图片或附件里）：只能告诉用户"原文见此链接"，不要展开想象。
- 政策会修订：publishedAt 较早的条款要提示"以官网最新版本为准"。`;

export default {
  id: 'knowledge',
  title: '知识库',
  // 排在业务模块之后、ai（90）之前：ai 聚合各模块 aiPrompt 时要能收到本模块的声明
  order: 70,
  // 语料是仓库里的文件（不是 JsonStore 集合），没有 collections
  aiPrompt: AI_PROMPT,
  aiQueryFields: {
    knowledge: ['title', 'url', 'publishedAt', 'category', 'kind', 'snippet'],
  },
  // 检索结果只给片段，条数也别多：6 条 × 240 字 ≈ 1.5k 字，够模型引用又不淹掉对话
  aiQueryLimits: { knowledge: 6 },
  aiTools: KNOWLEDGE_TOOLS,

  createServices({ services, log, dataDir, options }) {
    // `options` 来自 `createServer({ knowledge: { corpusDir } })`：语料放别处（或测试指向临时目录）
    // 不必改代码；不传就用模块内的默认位置（仓库里的 knowledge/dean）。
    const knowledge = new KnowledgeService({ log, dataDir, corpusDir: options?.corpusDir });
    services.commands.registerHandler('knowledge', createKnowledgeCommands({ knowledge }));
    return { knowledge };
  },

  async restore({ services }) {
    // 语料缺失 / 索引损坏时降级成"空语料"，**不影响其它模块启动**
    await services.knowledge.restore();
  },

  registerRoutes(router, ctx) {
    registerKnowledgeRoutes(router, ctx);
  },
};
