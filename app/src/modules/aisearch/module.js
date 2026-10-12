/**
 * 统一检索模块（id: aisearch）：把「校规语料 + 我的笔记 + 长期记忆」用**一次查询**合并返回。
 *
 * 依赖与装配顺序（order = 85）
 * --------------------------
 * - 必须在 `notes`(40) / `memory`(45) / `knowledge`(70) **之后**：本模块的 `createServices`
 *   就从 `ctx.services` 上取这三个服务（`order` 排小了会拿到 undefined，
 *   表现为"某一路永远 available: false"，不报错 —— 属于会静默失效的那类错误，注释写在这里）；
 * - 必须在 `ai`(90) **之前**：`ai` 模块在 `createServices` 里聚合各模块的
 *   `aiPrompt` / `aiQueryFields` / `aiQueryLimits`，排它后面声明就收不到。
 *
 * 没有 `collections`：纯检索，不落库（不写任何集合、不广播、不建私有文件）。
 */

import { AiSearchService } from './service.js';
import { createSearchCommands } from './commands.js';
import { registerSearchRoutes } from './routes.js';
import { AISEARCH_TOOLS } from './tools.js';

/**
 * 给对话模型的领域说明（会被 ai 模块聚合进系统提示词）。
 *
 * 三段各有用处：
 *   ① **什么时候用 search**（涉及两路以上、或一时判断不出查哪路）——省下有限的查询额度；
 *   ② **什么时候仍该用单独的 target**（免得模型把统一检索当成万能入口，
 *      拿不到"某条笔记的全文""被否决过的记忆"这些只有单路才有的东西）；
 *   ③ **引用规则**（三种来源性质完全不同，混着说会把用户自己的笔记当成学校规定）。
 */
const AI_PROMPT = `【统一检索 target "search"：一次查三路（校规 + 你的笔记 + 长期记忆）】
- 用法：{"ok":true,"action":"query","target":"search","filters":{"q":"转专业 条件","scope":"all","limit":10}}
  filters：q 必填（关键词，空格分隔即可）；scope 取 all / knowledge / note / memory（缺省 all）；
  limit 是**合并去重后**的总条数；course 只看某门课的笔记；noteIds 只在指定笔记里找。
- **什么时候用它**：问题同时涉及"学校规定"与"我自己记过/说过的东西"时
  （"我上次写的高数笔记说了什么""转专业要什么条件，顺便看看我记过什么"），
  或者你一时判断不出该查哪一路时。系统每轮能自动执行的只读查询有配额（当前 3 条），
  一次 search 顶三次单独查询，省下来的额度要留给后续步骤。
- **什么时候仍然用单独的 target**：
  ① 只要校规条款、还要按栏目（category）或直接读某篇全文（path）→ target "knowledge"；
  ② 要看某条笔记的**正文全文**（search 只给 240 字片段）、或按 id/标签翻笔记 → target "note"（用 noteId）；
  ③ 「你还记得…」、以及**提议前查重**（要查 rejected / superseded 这类非 active 记忆，
     或按 scope + key 精确定位）→ target "memory"。
- 每条结果都带 source：knowledge = 教务处校规语料，note = 用户自己的笔记，memory = 关于用户本人的长期记忆。
- **引用规则（三种来源不许混着说）**：
  ① source=knowledge 必须带 url 出处；语料里没有的如实说不知道，绝不许凭自己的记忆编校规；
     同一条在校规与笔记里都命中时（返回里已合并成一条），两个说法都要给到用户；
  ② source=note 必须说清是"**你的笔记**里写的"——那是用户自己记的内容，不是学校规定；
  ③ source=memory 必须说"**你之前提过**"——那是用户过去说过的事，既不是校规也不是笔记；
  ④ 回灌给你的每条只保留 source/title/snippet/url/noteId/score：
     snippet 是片段而不是全文（不要当成整篇读过），要看笔记全文用 target "note" 的 filters.ids。
- summary.sources 里某一路 **error 非空 = 那一路这次没查成**（例如知识库语料还没抓取、
  笔记服务坏了）：要如实告诉用户"这一路没查到/不可用"，**不能**把它当成"那一路里没有这条内容"。`;

export default {
  id: 'aisearch',
  title: '统一检索',
  // 85：在 notes(40) / memory(45) / knowledge(70) 之后拿到它们的服务，在 ai(90) 之前声明 AI 扩展点
  order: 85,

  aiPrompt: AI_PROMPT,
  // 只读查询回灌给模型时保留哪些字段：source 决定引用口径，url/noteId 是"点回去核对"的入参，
  // score 是跨源归一后的相关性（统一尺度，可直接比较）
  aiQueryFields: {
    search: ['source', 'title', 'snippet', 'url', 'noteId', 'score'],
  },
  // 12 条：比界面默认的 10 条略多（模型要在一轮里同时看清三路），
  // 又远小于"三路各 20 条"那种会淹掉对话的量
  aiQueryLimits: { search: 12 },
  aiTools: AISEARCH_TOOLS,

  createServices({ services, log }) {
    // 依赖**显式**列出（而不是把 services 整个塞进服务里）：
    // 一看就知道这个模块依赖谁，将来某一路改名/换实现，改这一行就够
    const search = new AiSearchService({
      knowledge: services.knowledge,
      notes: services.notes,
      memory: services.memory,
      log,
    });

    // 登记只读 target `search`：AI 输出 {"action":"query","target":"search"} 就会被自动执行
    // （chat-service 的 #runReadOnlyQueries 对 query 走 dryRun，不写库）
    services.commands.registerHandler('search', createSearchCommands({ search }));

    // 全局服务名用 `aisearch`（而不是 `search`）：`services` 是各模块 Object.assign 合并的，
    // 重名会**静默顶掉**别人（"搜索"又是个很容易被别的模块占用的名字）。
    // 指令 target 仍然是 `search`（那是给模型看的名字），只有内部句柄带模块前缀。
    return { aisearch: search };
  },

  registerRoutes(router, ctx) {
    registerSearchRoutes(router, { search: ctx.own.aisearch, apiPrefix: ctx.apiPrefix });
  },
};
