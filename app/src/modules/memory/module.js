/**
 * 记忆模块：关于**用户本人**的长期记忆（接口文档 §10）。
 *
 * 边界（§10.1）：记忆 = 跨会话、可复用、且**不是从别的数据现算出来**的结论。
 * 有确切时间位置的进日历三域（事件/日程/待办），能算出来的走查询，
 * 外部世界的事实（校规 / 政策 / 课程安排）归知识库模块 —— 三者共用同一条注入管道，
 * 但**不许互相写**：同一件事存两处，必然有一天不一致。
 *
 * 依赖与顺序
 * ----------
 * - order = 45：排在 notes(40) 之后、ai(90) 之前。ai 模块要聚合各模块的 `aiPrompt`
 *   （它在 createServices 里收 `modules`），所以声明必须在它之前装配完；
 * - **不依赖任何其它模块**：记忆是单机单用户的数据，只用自己的集合。
 *
 * 集合
 * ----
 * `memories` → `data/memories.json`（`{ schemaVersion, items }`，原子写、逐条容错，
 * 与其它集合完全一致 —— 不自己造存储层）。
 *
 * 给主程序的注入接口（chat-service 已经按这个签名在调）
 * ---------------------------------------------------
 *   `services.memory.inject({ view, module, courseId, maxItems, maxChars })`
 *     → `{ injected: [{ id, scope, kind, key, text, value, source, confidence, reviewAt, score, truncated }],
 *          truncated: boolean, budget: {...}, dueReview: number }`
 *   `services.memory.contextItems({ limit, chars, view, module, courseId })` → 数组（纯选择，不回报命中）
 * 细节与语义见 `service.js` 的 `inject()` / `contextItems()`。
 */

import { MemoryService } from './service.js';
import { createMemoryCommands } from './commands.js';
import { MemoryParser } from './parser.js';
import { registerMemoryRoutes } from './routes.js';
import { MEMORY_TOOLS } from './tools.js';

/**
 * 给对话模型的领域说明（会被 ai 模块聚合进系统提示词）。
 *
 * 三段都是必需的：**记什么**（否则模型会把"明天下午三点开会"记成偏好）、
 * **不记什么**（尤其是校规这类外部事实 —— 写进记忆会污染之后每一次对话）、
 * 以及**只能提议**（§10.6 的硬规则，模型最常见的越界就是宣称"已经帮你记住了"）。
 */
const AI_PROMPT = `【长期记忆：关于用户本人的事】
- 记忆里只放**关于用户本人、跨会话依然成立、且不能从别的数据算出来**的结论：
  偏好（我习惯晚上 19:00 之后安排学习任务）/ 限制（我周三下午不方便）/ 事实（我在读大二，专业是材料）/
  取舍（不导入已过期作业）/ 经历（上次数据结构作业拖到最后一天，这类不注入、只检索）。
- **不该记**：① 有确切时间位置的（"明天下午三点开会""10 月底交大作业"→ 日程/待办）；
  ② 能从日程/待办/指令日志查出来的（"这周有 3 条待办"）；
  ③ **校规、政策、课程安排、老师是谁开的课这类外部事实 —— 那是知识库的内容，绝不许写进记忆**
  （写进去会变成"我记得的校规"，之后每一次对话都被它污染）。
- 查询：{"ok":true,"action":"query","target":"memory","filters":{"q":"关键词","scope":"global","kind":"preference","limit":10}}
  filters 支持 scope / kind / status / key / q / limit。用在"你还记得…"，以及**提议前先查重**：
  status 为 rejected 的同 scope+key 是被否决过的，**绝不再提**。
- 写：**你只能提议，不能直接写**。用户明说"记住…"时给一条
  {"ok":true,"action":"create","target":"memory","fields":{"scope":"global","kind":"preference","text":"我……"}}
  草稿（source: user）；你自己觉得值得记时也只能给草稿等用户确认，**绝不说"已经记住了"**。
  一轮最多 3 条；只说用户自己讲过的事，不写推测（"用户可能想考研"❌）；写完整句、主语是用户、≤200 字。
- **key 默认不要写**（省掉它最稳）：系统按"scope + 正文"去重，同一句话不会被记两遍。
  只有"同一条结论会被反复更新"时才给 key（例如作息偏好将来会改），而且它必须是
  **小写字母 / 数字 / 下划线、≤40 字符**的英文短语（preferred_study_window ✅、周三下午 ❌、Bad Key ❌）。
  中文 / 空格 / 超长 / 大写的 key 服务端不会报错，但会把它**降级**（丢中文、转小写、截断，
  全丢了就等于没有 key）并在响应里回 keyAdjusted —— 那不是你想指定的那条键，所以别写中文。
- 每轮注入给你的只是预算内的一小部分（默认 ≤8 条 / 600 字）：**没注入的就是你不知道的**，
  不许假装记得；需要时用上面的查询去检索。`;

export default {
  id: 'memory',
  title: '记忆',
  order: 45,
  collections: [{ name: 'memories', file: 'memories.json' }],

  aiPrompt: AI_PROMPT,
  // 只读查询回灌给模型时保留哪些字段：text/kind/scope 是判断依据，id 是后续改删的句柄
  aiQueryFields: {
    memory: ['id', 'scope', 'kind', 'key', 'text', 'value', 'status', 'source', 'reviewAt', 'useCount', 'updatedAt'],
  },
  // 检索（pull）是"注入被截断时补查"用的：10 条够定位，再多会把对话挤掉
  aiQueryLimits: { memory: 10 },
  aiTools: MEMORY_TOOLS,

  createServices({ store, broadcast, services, options }) {
    // `options.now` 可注入时钟（测试复核/衰减语义时不必改系统时间）
    // services/audit：用户写记忆时记一条 actor:'user'；AI 写由 chat-service 统一记。
    const memory = new MemoryService({ store, broadcast, now: options?.now, services, audit: services.audit });

    // ① 指令处理器：查询只读（会被 AI 自动执行），写入只在用户确认后发生
    services.commands.registerHandler('memory', createMemoryCommands({ memory }));
    // ② 中文规则「记住 …」：让"记住 我不喜欢早上排任务"从输入框就能落成草稿
    //    （带确切时间的句子会被这个解析器放行给日历，见 parser.js）
    services.commands.registerParser('memory', new MemoryParser());

    return { memory };
  },

  registerRoutes(router, ctx) {
    registerMemoryRoutes(router, ctx);
  },
};
