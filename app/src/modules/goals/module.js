/**
 * 学习目标 / DDL 追踪与预警模块。
 *
 * 职责：把"目标视角"补上 —— 课程 DDL、考试、长期目标（考研 / 保研 / 竞赛 / 绩点目标）
 * 集中在一处，算倒计时、给预警，并让 AI 能读写。
 *
 * 依赖与顺序
 * ----------
 * `order: 47` —— 排在 calendar(10) / academic(30) / memory(45) 之后、ai(90) 之前：
 *   - **需要 calendar 先装配**：`overview()` 要只读日历的待办与事件
 *     （`services.todos.list()` / `services.events.list()`，见 service.js 的 `collectExternal()`）；
 *   - **需要 academic 先装配**：`gpaComparison()` 要读学业模块的真实学分绩
 *     （`services.academic.stats()`，缺失时降级，不报错）；
 *   - **必须在 ai(90) 之前**：ai 模块在 `createServices` 里聚合各模块的 `aiPrompt` /
 *     `aiQueryFields` / `aiQueryLimits`，声明晚了就静默失效。
 * 依赖是三处，但**都不是硬依赖**：两个服务拿不到时各自降级（少一块数据 / gpa 为 null），
 * 本模块自己的 CRUD 完全不受影响。
 *
 * 集合
 * ----
 * `goals`        → `data/goals.json`          目标 / 截止 / 考试
 * `goalSettings` → `data/goal-settings.json`  单行设置（目标学分绩）
 *
 * 为什么设置要单独一个集合：目标学分绩是**全局单值**，塞进 goals 会让列表、分组计数、
 * overview 全都要特判"这条不算目标"（一处特判换来四处特判），而它对 `data/goals.json`
 * 的语义也是一种污染。
 *
 * 数据边界（本模块最需要说清的一条）
 * ------------------------------
 * **只写自己的两个集合。** `todos` / `events` / `academicGrades` 一律只读，
 * 而且优先走对方服务上的只读方法而不是直连集合（把字段约定的耦合面收到最小）。
 * 理由：同一条信息存两处必然有一天不一致 —— 让"12 月前考完六级"既是一条目标、
 * 又被谁顺手建成一条待办，是最容易发生也最难排查的那种脏数据。
 */

import { GoalService } from './service.js';
import { GoalParser } from './parser.js';
import { createGoalCommands } from './commands.js';
import { registerGoalRoutes } from './routes.js';
import { GOAL_TOOLS } from './tools.js';

/**
 * 给对话模型的领域说明（会被 ai 模块聚合进系统提示词）。
 *
 * 四段都是必需的：
 *   ① 什么该建目标（否则模型会把"明天交实验报告"建成一条三年期的目标）；
 *   ② 目标与待办/日程/事件的边界（边界说不清，模型一定选最"重要"的那个词）；
 *   ③ **不许编造保研线与预测分数**（这是本模块唯一的高风险区，必须写成硬规则）；
 *   ④ 读数据用哪个 target、写数据只能给草稿。
 */
const AI_PROMPT = `【学习目标 / DDL 追踪】
用户有一份"目标视角"的数据，target 是 "goal"：
- 查询目标：{"action":"query","target":"goal","filters":{"status":"active","kind":"exam","q":"六级","limit":20}}
  filters 支持 status（active/done/archived）、kind（goal/deadline/exam）、course、q、limit、offset。
  每条带 daysLeft（负数 = 已逾期）、severity、progress、里程碑完成度。
- ★ 看"接下来要面对什么"：{"action":"overview","target":"goal","filters":{"days":30}}
  它把**本模块的目标 + 日历里未完成的待办 + 日历事件（考试周、报名截止）**合成一条
  按严重度排好的清单，并带 summary。用户问"我最近有什么要交的""接下来要准备什么"
  **优先用它**，不要分别查 todo 和 event 再自己合并（口径与排序会不一致）。
- 新建：{"action":"create","target":"goal","fields":{"title":"考完六级","kind":"exam","targetDate":"2026-12-31","course":"英语"}}
- 改进度 / 勾里程碑：{"action":"progress","target":"goal","filters":{"id":"..."},"fields":{"progress":60}}
  或 {"action":"progress","target":"goal","filters":{"id":"..."},"fields":{"milestoneId":"m-0-ab12cd","done":true}}
- 改状态 / 改字段：{"action":"update","target":"goal","filters":{"id":"..."},"fields":{"status":"done"}}
- 删除：{"action":"delete","target":"goal","filters":{"id":"..."}}

severity 的口径（不要自己另立一套）：daysLeft < 0 → overdue（已逾期）；
0~1 → urgent；2~7 → soon；≥8 → later。severity 只看天数，**不看 priority**。

**什么该建成目标，什么不该**（这条最容易错）：
- 一次**有确切日期与时刻**的安排（"明天下午三点开会"）→ 日程 schedule；
- **单日要交的一件事**（"明天交实验报告"）→ 待办 todo（POST /todos）；
- **跨天的日期区间**（"10月20日到22日期中考试"）→ 事件 event；
- 只有**目标日期、可能要跟踪几周以上、或者需要分几步**的方向 → 目标 goal
  （考研、保研、竞赛、绩点目标、四六级、驾照、长期项目）。
- 判据是"**要不要跟踪进度**"，不是"离现在多远"。用户说"12 月前考完六级"是要跟踪的
  → 目标；说"12 月 20 日交大作业"只是一件事 → 待办。
- 建目标时 **targetDate 必须有真实日期**。用户只说"我想学好英语"而没有任何日期时，
  **不要**自己编一个日期或拿今天当默认值：先问一句"打算什么时候之前完成"。
- 有确切日期的内容**不要**同时建目标和待办（存两处必然有一天不一致）。

**学分绩目标（这是硬规则，违反了就是骗用户）**：
- \`/goals/overview\` 的 \`gpa\` 里：\`current\` 是学业模块的**真实学分绩**，
  \`target\` 是**用户自己填的**目标学分绩，\`gap\` 只是两个数相减。
- **绝不许**把 targetGpa 说成、暗示成、或换算成"学校公布的保研线""保研分数线""往届保研线"；
  **绝不许**据此预测录取概率、排名或"能不能保研"。库里没有这些数据，编出来就是害人。
- 复述时必须带上这句限定：目标是用户自己填的，不是学校公布的保研线。
- 也不许"根据当前学分绩建议一个目标"然后直接写进去 —— 目标只能由用户自己给数。
- \`gpa.current\` 为 null 时（学业模块没数据 / 还没登录教务）如实说"还没有成绩数据，
  先同步成绩再看差距"，不要猜一个数字，也不要把接口返回 null 说成系统出错。

**写操作的限制**：上面的 create / update / delete / progress 都会经过用户确认才落库，
你输出草稿后**绝不说"已经帮你建好了"**。删除与改状态（done/archived）尤其要先问清楚 ——
"考完了""不考了""先放一放"是三件不同的事，不要替用户合并成同一个动作。
里程碑全勾完**不要**自动把目标改成 done：步骤做完不等于目标达成。`;

export default {
  id: 'goals',
  title: '目标',
  order: 47,

  collections: [
    // externalId 风格的外部键本模块暂时没有，所以不声明索引（索引是给同步幂等用的）
    { name: 'goals', file: 'goals.json' },
    { name: 'goalSettings', file: 'goal-settings.json' },
  ],

  aiTools: GOAL_TOOLS,
  aiPrompt: AI_PROMPT,

  /**
   * 只读查询结果回灌给模型时保留这些字段（**覆盖** ai 模块内置的投影表）。
   *
   * 这份投影表是"模型能看到什么"的唯一决定因素，缺一个字段就等于那个信息不存在：
   *   - `daysLeft` / `severity` / `overdue`：本模块的核心信息，缺了模型只能自己数日子；
   *   - `progress` / `status` / `milestoneDone` / `milestoneTotal`：判断"做到哪了"；
   *   - `course` / `kind` / `priority`：分组与取舍。
   * 刻意**不带** `note`：备注可能很长，而它几乎不影响任何判断，放在投影里只会挤掉别的条目。
   */
  aiQueryFields: {
    goal: [
      'id',
      'title',
      'kind',
      'course',
      'targetDate',
      'daysLeft',
      'severity',
      'overdue',
      'status',
      'progress',
      'priority',
      'milestoneDone',
      'milestoneTotal',
      'remindDays',
    ],
  },

  /**
   * 条数上限：目标不像成绩单那样"整份才有意义"，但它比待办少得多、且模型常常要
   * "把所有在跟踪的目标过一遍"（考研 + 保研 + 几门课的 DDL）。默认 20 条会把
   * 一个正常学生的目标列表腰斩，60 足够覆盖且不至于撑爆提示词。
   */
  aiQueryLimits: {
    goal: 60,
  },

  createServices({ store, broadcast, services }) {
    // `services` 传进去只为**只读**取日历待办/事件与学业统计（见 service.js）；
    // 本模块不写它们，也不持有它们的引用做缓存 —— 每次查询现取，避免看到过期快照。
    const goals = new GoalService({ store, broadcast, services });

    // ① 指令处理器：query / overview 只读（会被 AI 自动执行），
    //    create / update / delete / progress 只在用户确认后发生
    services.commands.registerHandler('goal', createGoalCommands({ goals }));
    // ② 中文规则「我打算 12 月前考完六级」：让输入框里的一句话直接落成草稿。
    //    置信度 0.9 —— 高于日历兜底解析器，低于记忆的「记住…」0.95。
    services.commands.registerParser('goals', new GoalParser());

    return { goals };
  },

  registerRoutes(router, ctx) {
    registerGoalRoutes(router, ctx);
  },
};
