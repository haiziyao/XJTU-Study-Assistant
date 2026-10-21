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
 * 核心规则只有两条，都是被真机缺陷逼出来的：
 *   1. **具体条款优先 search**：问"挂几科退学""转专业要绩点多少"这类数字/条件时，
 *      先用 `filters.q` 关键词检索拿命中片段与 `offset`，不要一上来按 path/url 整篇读；
 *   2. **不要整篇 read**：整篇读永远只能拿到一个窗口（默认 4000 字），而长文的关键条款
 *      经常在窗口之外（《学籍管理与学位授予规定》正文 8213 字，第六章从第 4860 字开始）。
 *      窗口被截断时用 `filters.offset=nextOffset` 续读，不许把"窗口没给全"说成"语料里没有"。
 *
 * 其余几条（引用带 url、没有就不知道、portal 篇目没有正文、政策会修订）是安全底线：
 * 校规会被用户照着办，编一条比答不出来危险得多。
 */
const AI_PROMPT = `【知识库：教务处政策 / 规章 / 校历】
- 可以用只读指令 {"ok":true,"action":"query","target":"knowledge","filters":{"q":"挂科 退学","limit":5}} 检索教务处政策语料
  （148 篇：学籍管理、课程考核、学业预警、毕业学位、培养方案、校历与作息时间等）。filters 还支持
  category（栏目 slug）、path（直接读某一篇）、url（那一篇的来源链接）、offset（从第几字续读）、
  section（精确到小节，如"第六章 退学警告与退学""第二十七条"）。
- **具体条款优先 search**：问"挂几科会被退学""转专业要绩点多少""补考怎么算"这类具体条款 / 数字 / 条件时，
  必须先用 filters.q 关键词检索（对话里的 search 就是 filters.q），把命中片段（snippet，默认约 800 字）读完再回答；
  不要凭记忆直接给数字，也不要一上来就按 path/url 整篇读。
- **不要整篇 read**：filters.path / filters.url（对话里的 read）只在两种情况下用：
  ① "给我看全文 / 这一章完整内容"；② 检索确认篇目后，按 filters.offset 或 filters.section 续读条款。
  不要不带 offset/section 就整篇 read。
- 检索结果每条都带 snippet（命中位置附近的原文）与 offset（命中位置在全文第几字）：
  先读 snippet；不够时用 filters.path + filters.offset 续读，或带 filters.section 精确到小节。
  按 path 读时 offset 是本次窗口起点、matchOffset 才是命中位置。
  例：{"filters":{"path":"…","offset":5000}}、{"filters":{"path":"…","section":"第六章 退学警告与退学"}}。
- 按 path/url 读到的 content 是原文的一个窗口（默认 4000 字），带 truncated、totalChars、offset、nextOffset。
  truncated 为 true 只表示"这次窗口没给全"，**不代表条款不存在**：必须用 filters.offset=nextOffset
  继续读，直到读到目标条款或 nextOffset 为 null；绝不许回一句"我只能读到 4000 字"就结束。
- **引用必须带 url，并写清文件与小节**：回答具体条款时说明"这是检索到的条款原文（《title》· section）"，
  每条结论都要能点回教务处原文；把校规说成"一般来说"是不行的。
- 结果里 kind 为 portal / attachments / external-links 的篇目**没有可检索正文**
  （正文在图片或附件里）：只能告诉用户"原文见此链接"，不要展开想象；它们也可能因为标题精确而
  排在前几条，**不要停在第一条**，继续看后面有 snippet 的条目。
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
   * 三类字段缺一不可：
   *   - `snippet` / `offset` / `matchOffset`：**具体条款先检索**的落点 —— 片段告诉模型
   *     "条款长什么样"，offset 告诉它"在第几个字"，两者一起才能既不整篇读、又能续读到原文；
   *   - `path` / `section`：续读的地址（`filters.path + filters.offset/section`）；
   *     以前白名单没有 path，模型只拿到 url，只能整篇读，读不到就卡住；
   *   - `content` / `truncated` / `nextOffset` / `totalChars`：点名读时的正文与"还有没有"，
   *     没有 nextOffset 模型就不知道窗口能往后移，只会说"我只能读到 4000 字"。
   * 关键词检索本来就不返回 content，所以放行这些字段不会把整库倒进上下文。
   */
  aiQueryFields: {
    knowledge: [
      'title',
      'url',
      'path',
      'publishedAt',
      'category',
      'kind',
      'score',
      'snippet',
      'offset',
      'matchOffset',
      'nextOffset',
      'section',
      'content',
      'truncated',
      'totalChars',
    ],
  },
  // 检索结果只给片段，条数也别多：6 条 × 800 字 ≈ 4.8k 字，够模型引用又不淹掉对话。
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
