/**
 * 学习周报模块（`weekly`）：一周结束时自动汇总「聊了什么 / 写了哪些笔记 / 待办完成了什么 /
 * 成绩有什么变动」，并用模型写成一段人能读的中文简报。
 *
 * 依赖与顺序
 * ----------
 * - `order = 48`：排在 notes(40)、memory(45) 之后，**ai(90) 之前**。
 * - **统计不依赖任何模块服务**：数字全部来自各模块已落库的集合（只读；见 `sources.js` 的字段对照表）。
 *   来源固定为 AI 对话 / 笔记 / 待办 / 成绩；**缺任何一个都不影响出报** ——
 *   那一项给 `null` 并写进 `missing`，接口不失败、页面也不空白。
 * - `ai` 是**惰性依赖**：`createServices` 收到的 `services` 是**共享注册表**，order=90 的 ai 模块
 *   之后才把 `services.ai` 合并进来。因此本模块**只在请求时**读 `this.services.ai`，
 *   绝不在 `createServices` 里立刻取（那时一定是 undefined）。
 *   这也是本模块敢排在 ai 前面的原因：没配密钥时统计与接口要照常可用。
 *
 * 集合
 * ----
 * `weeklyReports` → `data/weekly-reports.json`（`{ schemaVersion, items }`，原子写、逐条容错，
 * 与其它集合完全一致 —— 不自己造存储层）。**一周一条**，`from`（周区间起点）就是键；
 * 同一周重复生成时原地更新（保留 id），`force: true` 才会重写正文。
 *
 * 界面
 * ----
 * 本模块只有后端；前端面板挂在「待办」页里（`views/weekly-panel.js`），不占左栏入口。
 *
 * 接口 / 指令 / 工具
 * ------------------
 * - REST：`/weekly/report`（读）、`/weekly/report/generate`（生成）、`/weekly/reports`（历史）、
 *   `DELETE /weekly/reports/:id`；详见本目录 README.md。
 * - 对话指令：target `weekly`，`query` 读报告（只读，会被 AI 自动执行）、`create` 生成（唯一花 token 的动作）。
 * - AI 工具：`weekly_report_get`（mutates:false）/ `weekly_report_generate`（mutates:true）。
 *
 * 不做中文解析器（不像 memory 有「记住 …」这种稳定句式）：一周的时间边界（自然周 / 上周 /
 * 本月初到现在）靠规则猜很容易错一周，而模型本来就会给出明确日期；`create` 的 from/to 校验
 * 会当面 400，不会静默算错一周。
 */

import { WeeklyService } from './service.js';
import { createWeeklyCommands } from './commands.js';
import { registerWeeklyRoutes } from './routes.js';
import { WEEKLY_TOOLS } from './tools.js';

/**
 * 给对话模型的领域说明（由 ai 模块聚合进系统提示词）。
 *
 * 四段都是必需的：**什么时候该生成**（否则模型要么从不主动、要么每次闲聊都生成一次花钱）、
 * **怎么读**（先读缓存，没有再说"还没生成"）、**只依据数字**（周报的全部价值在数字可信）、
 * 以及**没有"学习时长"这个数据源**（这是最容易被编造、也最容易被用户相信的一类数字）。
 */
const AI_PROMPT = `【学习周报】
- 什么时候用：用户问"这周/上周学了什么""总结一下最近"，或者到了周末该复盘时，
  可以**提议**生成一份周报。
- 只读先看：{"ok":true,"action":"query","target":"weekly","filters":{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}}
  —— 它不花钱。有报告就照报告回答；没有报告时它会给**现算的统计**，你可以直接用那些数字回答，
  并告诉用户"这一周还没生成周报，要的话我生成一份"。
- 生成（**会调用一次模型、消耗额度**，所以要先跟用户说一声）：
  {"ok":true,"action":"create","target":"weekly","fields":{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}}
  同一周已经有报告时直接命中缓存、不会重复花；要重写已有报告才加 "force": true。
  from/to 都省略 = 本周（周一 ~ 周日）。用户说"上周"时，你要自己算出上周一与上周日两个日期再填。
- 报告正文与 stats 里，**null 表示"没有这个数据源"**（例如 AI 对话 / 成绩模块还没装配），
  不是 0，也不代表用户没做这件事：如实说"暂无数据"，**绝不估算、绝不补造**。
- 统计只有四类：AI 对话、笔记、待办、成绩。**系统没有"学习时长 / 专注时长 / 自习小时数"这个数据源**，
  任何情况下都不要说"这周学习了 12 小时"这类话；要谈投入只能用对话与提问条数、笔记篇数、待办完成数。
- 学分绩为 null 表示没有可计算的成绩，不是 0 分。`;

export default {
  id: 'weekly',
  title: '学习周报',
  order: 48,
  collections: [{ name: 'weeklyReports', file: 'weekly-reports.json' }],

  aiPrompt: AI_PROMPT,
  // 只读查询回灌给模型时保留哪些字段：正文（report）是主体，week/from/to 是定位，fallback/reason 说明这段字怎么来的
  aiQueryFields: {
    weekly: ['id', 'from', 'to', 'week', 'report', 'generatedAt', 'model', 'fallback', 'reason'],
  },
  // 一份周报约 300~400 字，回灌 4 份就到提示词预算的量级了（stats 走 summary 单独带回）
  aiQueryLimits: { weekly: 4 },
  aiTools: WEEKLY_TOOLS,

  createServices({ store, broadcast, services, options }) {
    const weekly = new WeeklyService({ store, broadcast, services, options });
    // 指令处理器：query 只读（AI 自动执行），create 是唯一会花 token 的动作（dryRun 不花）
    services.commands.registerHandler('weekly', createWeeklyCommands({ weekly }));
    return { weekly };
  },

  registerRoutes(router, ctx) {
    registerWeeklyRoutes(router, ctx);
  },
};
