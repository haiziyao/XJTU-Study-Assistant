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
  category（栏目 slug）、path（直接读某一篇）、url（那一篇的来源链接）。
- **要读某篇的具体条款（数字、学分、比例、时限、名单、表格），必须用 filters.path 或 filters.url 点名那一篇**：
  {"ok":true,"action":"query","target":"knowledge","filters":{"url":"https://dean.xjtu.edu.cn/info/1033/1130.htm"}}
  —— 点名时系统会回**较长正文**（content，默认 4000 字，带 truncated 与 totalChars）。
- **只给 q 的检索只回 240 字片段（snippet），那不是全文**。片段断在句中、或你要的条款显然在更后面时：
  绝不许把片段当全文、更不许拿片段外推或编数字；要么说"我只读到片段"，要么拿这条结果的 path/url 再查一次。
- content 的 truncated 为 true 时，表示这篇比 content 更长（totalChars 是它真实的总字数）：
  说明"我只读到这部分"，不要把截断处当成结尾，也不要补全没读到的部分。
- 结果里 kind 为 portal / attachments / external-links 的篇目**没有可检索正文**
  （正文在图片或附件里）：只能告诉用户"原文见此链接"，不要展开想象。
- **引用必须带 url**：把校规说成"一般来说"是不行的，每条结论都要能点回教务处原文。
- **语料里没有的，如实说不知道**（例如"今年保研名额"）——绝不许用你自己的记忆编政策。
- 政策会修订：publishedAt 较早的条款要提示"以官网最新版本为准"。`;

export default {
  id: 'knowledge',
  title: '知识库',
  // 排在业务模块之后、ai（90）之前：ai 聚合各模块 aiPrompt 时要能收到本模块的声明
  order: 70,
  // 语料是仓库里的文件（不是 JsonStore 集合），没有 collections
  aiPrompt: AI_PROMPT,
  /**
   * 回灌给对话模型的字段白名单（`chat-service` 的 `#compactQueryResult` 按它挑字段）。
   *
   * `content` / `truncated` / `totalChars` 必须在这里 —— 它们**只在 filters 带 path/url 时才有值**
   * （按关键词检索的那条路径根本没有这三个字段，见 `service.js` 的 search()），
   * 所以加上它们是安全的：不会把整库倒进上下文，只会让"点名读一篇"真的读得到条款。
   * 白名单一旦漏字段，模型就永远看不见正文全文 —— 这正是本次"读不到 12/8/4 学分阈值"的根因之一。
   */
  aiQueryFields: {
    knowledge: ['title', 'url', 'publishedAt', 'category', 'kind', 'snippet', 'content', 'truncated', 'totalChars'],
  },
  // 检索结果只给片段，条数也别多：6 条 × 240 字 ≈ 1.5k 字，够模型引用又不淹掉对话。
  // path 直读是 count:1（只可能 1 条），所以这条上限对它没有影响，不必为它放宽。
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
