/**
 * 复习卡片模块：把笔记变成卡片，按遗忘曲线安排"学过的东西回来找你"。
 *
 * 边界（跟相邻模块的分工，写清楚是为了防止同一件事存两处）
 * ------------------------------------------------------
 * - 卡片是**一问一答的复习单位**，不是笔记的副本：正文永远在 notes 里，卡片只留
 *   `noteId` 指回去。矛盾时以笔记为准（用户改笔记不等于改卡片，反过来也一样：
 *   卡片被删不影响笔记）；
 * - **有确切时间位置的安排**（"明天交实验报告"）属于日历三域，不是卡片。
 *   它到点要响，而卡片是到点要"问"，两者混在一起会让复习队列变成第二个待办列表；
 * - **外部事实**（校规、政策）归知识库，**关于用户本人的结论**归记忆模块。
 *   卡片只装"这门课要背下来的东西"。
 *
 * 依赖与顺序
 * ----------
 * - `order = 46`：排在 notes(40) 之后、ai(90) 之前。两个理由：
 *   ① 生成卡片要读 `services.notes`（它必须在 createServices 时已存在）；
 *   ② ai 模块在 createServices 里聚合各模块的 `aiPrompt` / `aiTools`，本模块的声明
 *      必须在那之前完成 —— 与 memory(45) 同一档，只是它只要读自己的集合，这里还要读笔记。
 * - 除了笔记的**只读**接口（`notes.get` / `notes.list`）之外不依赖任何模块；
 *   不写别人的数据，所以不需要更靠后的装配顺序。
 *
 * 集合
 * ----
 * `cards` → `data/cards.json`（`{ schemaVersion, items }`，原子写、逐条容错、损坏先备份，
 * 与其它集合完全一致 —— 不自己造存储层）。
 *
 * 给「定时唤醒」的接口（模块级只读方法）
 * ------------------------------------
 *   `services.cards.dueToday({ limit, course, tag })` → `Card[]`
 *     今天之内到期的卡片（含刚才 again 掉、安排在今晚再来的），按 due 升序、已排除暂停。
 *     定时唤醒的接线方式：任务提示词里让模型调 `GET /cards/due?limit=5`（比 now 的队列），
 *     或者在 runner 里直接读 `services.cards.dueToday().length` 决定这句提示词还要不要说。
 *     两者的区别（比 now vs 比今天结束）写在 service.js 的 `dueToday()` 注释里。
 */

import { CardService } from './service.js';
import { createCardCommands } from './commands.js';
import { CardParser } from './parser.js';
import { registerCardRoutes } from './routes.js';
import { CARD_TOOLS } from './tools.js';

/**
 * 给对话模型的领域说明（会被 ai 模块聚合进系统提示词）。
 *
 * 四段都是必需的，缺一段就会出现一类具体的坏行为：
 * ① 不说什么该做成卡片 → 模型把整段笔记当卡片塞进库里；
 * ② 不说什么时候该查到期 → 用户问"今天背什么"时它凭印象回答；
 * ③ 不说"只能记用户自己给的评分" → 它会替用户评价掌握程度；
 * ④ 不说"复习 ≠ 已完成" → 它生成完卡片就说"已经帮你复习完了"（最坏的一种：
 *    用户以为今天复习过了，其实只是多了几张从没见过的卡）。
 */
const AI_PROMPT = `【复习卡片与间隔重复】
- 卡片 = 一问一答的最小复习单位：front 是能被问出来的问题，back 是自足的答案。
  排期由 SM-2 简化版自动计算（again 忘了 / hard 吃力 / good 记得 / easy 太简单），**你不要自己算日期**。
- 什么该做成卡片：一个知识点一张，而且是"能问出来"的（定义、公式、步骤、易错点）。
  **不该做的**：整段笔记（先用「从笔记生成」或拆成几张卡）、没有答案的疑问、
  有确切时间位置的安排（"明天交作业" → 待办/日程）、外部事实（校规/政策 → 知识库）。
- 什么时候查到期：用户问"今天要复习什么 / 还有几张卡 / 我该背什么"时，先执行只读查询
  {"ok":true,"action":"query","target":"card","filters":{"due":true,"limit":10}}
  —— count 是这次筛选下的**全部**到期数（items 只是返回的前几条，别说成"就这 10 张"）。
  定时唤醒任务同理：先查再说话；一张都没有就如实说"今天没有到期的卡片"，
  不要为了显得有用而编造卡片内容。
- 写操作三种，都必须在用户明确说了之后才做：
  ① 建卡 {"ok":true,"action":"create","target":"card","fields":{"front":"问题","back":"答案","course":"可选","tags":["可选"]}}
     （front ≤500 字、back ≤2000 字，一张卡只问一个知识点）；
  ② 从笔记生成走 POST /cards/generate（**幂等**：同一篇笔记重复生成不会重复建卡）；
  ③ 记一次复习 {"ok":true,"action":"review","target":"card","fields":{"id":"卡片的 id","grade":"good"}}
     —— grade 只能是**用户自己**给出的判断（忘了/吃力/记得/太简单），缺了会被拒绝。
- **绝不许把"复习"说成"已完成"**：只有真的调用过 review 并拿到回执，才能说
  "这次复习记下了，下次 X 天后再见"；生成卡片、列出到期清单、或者只是把知识点讲了一遍，
  都**不是**复习完成 —— 不许说"已经帮你复习完了""你已经掌握了"。
  复习有没有完成由用户的评分决定，不由你判断。
- 卡片内容用户随时可以改删（PATCH / DELETE /cards/:id）：发现内容错了就提醒他
  "这张卡你可以改或删掉"，不要自己悄悄改。`;

export default {
  id: 'cards',
  title: '复习卡片',
  order: 46,
  collections: [{ name: 'cards', file: 'cards.json' }],

  aiPrompt: AI_PROMPT,
  // 只读查询回灌给模型时保留哪些字段：id 是后续 review / 改删的句柄，
  // front/back 是它念题与对答案的依据，due/intervalDays/reps/lapses/suspended 是
  // 回答"这张卡多久没见了/为什么没出现"的依据。调度字段**必须**在里面 ——
  // 只给 front/back 的话，模型无法解释"为什么今天没有它"。
  aiQueryFields: {
    card: [
      'id',
      'front',
      'back',
      'due',
      'intervalDays',
      'ease',
      'reps',
      'lapses',
      'suspended',
      'lastGrade',
      'course',
      'tags',
      'noteId',
    ],
  },
  // 8 张：一次复习对话里念 8 道题已经很长了（每张卡的 back 上限 2000 字），
  // 需要更多时模型可以再发一次带 offset / 更窄筛选的查询
  aiQueryLimits: { card: 8 },
  aiTools: CARD_TOOLS,

  createServices({ store, broadcast, services, options }) {
    // `options.now` 可注入时钟（测试复习排期与到期队列时不必改系统时间）
    const cards = new CardService({ store, broadcast, services, now: options?.now });

    // ① 指令处理器：query 只读（会被 AI 自动执行），create/update/delete/review 都尊重 dryRun
    services.commands.registerHandler('card', createCardCommands({ cards }));
    // ② 中文规则「加一张卡片：正面？答案」/「今天要复习什么」→ 草稿
    //    解析器 id 用 target 名 `card`（框架只用它标记 draft.parser / 报重复注册）
    services.commands.registerParser('card', new CardParser());

    return { cards };
  },

  registerRoutes(router, ctx) {
    registerCardRoutes(router, ctx);
  },
};
