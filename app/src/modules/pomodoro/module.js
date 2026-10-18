/**
 * 番茄钟模块（`pomodoro`，order 22）：专注/休息计时、到点自动切换、时间记到待办、
 * 会话账本与统计。
 *
 * 为什么 order 是 22：它要写待办的 `spentSelfSec`，必须排在 calendar(10) 之后；
 * 又要在 weekly(48)/sync(89)/ai(90) 之前把服务挂进共享表，让周报、同步、AI 都能拿到它。
 *
 * 状态存在两个地方，边界必须清楚：
 * - `data/pomodoro-state.json`：**运行中的临时状态**（当前阶段、endsAt、暂停剩余秒…）；
 * - `data/pomodoro-sessions.json`：**已经发生的会话账本**（JsonStore 集合，可同步）。
 * 运行中状态不参与多端同步（理由见 sync/catalog.js 与 service.js 文件头）。
 */

import { createPomodoroCommands } from './commands.js';
import { registerPomodoroRoutes } from './routes.js';
import { PomodoroService } from './service.js';

/**
 * 给对话模型的领域说明（由 ai 模块聚合进系统提示词）。
 *
 * 必须把"能写"写清楚：模型只看到能力清单时，很容易把"番茄钟"当成只读统计，
 * 于是用户说「帮我重开一下番茄钟」它却回"这一步得你手点"。权限由 ai 模块决定
 * （manual 出确认卡 / auto 直接执行），这里只负责告诉模型有哪些动作、草稿怎么给。
 */
const AI_PROMPT = `【番茄钟（可控制，统计只读）】
- 你可以直接控制番茄钟：开始/重开、暂停、继续、跳过当前阶段、停止、换关联待办。
  统计查询仍然只读（见下面 query）。
- 开始或重开（当前正在跑时，系统会先把这一阶段按实际时长记入账本，再开始新一轮）：
  {"ok":true,"action":"create","target":"pomodoro","fields":{"studyMin":45},"explain":"开始一个 45 分钟的番茄钟（确认后立刻开始计时）"}
  fields.studyMin 省略就用用户设置里的专注时长；fields.taskId 可选（给了会校验待办是否存在）；
  fields.reset:true 与"正在跑时再 create"都表示重开。
- 暂停（把 op 换成 resume / skip / stop 就是继续 / 跳过当前阶段 / 停止）：
  {"ok":true,"action":"update","target":"pomodoro","fields":{"op":"pause"},"explain":"暂停当前番茄钟"}
  换关联待办用 {"op":"setTask","taskId":"…"}，解除关联传 taskId:null。
  未开始时 pause/resume/skip 会 400（当前是 idle，要先 create）；停止在未开始时是成功的空操作。
- 用户说"帮我重开一下番茄钟，一轮后我去吃饭"时直接给 create 草稿，不要回答"需要你手点"。
- 读统计（只读）：
  {"ok":true,"action":"query","target":"pomodoro","filters":{"range":"today"}}
  range 取 today / week / all：today 是今天、week 是本周（周一到周日）、all 是账本全量；
  返回 studySec（专注秒数）、focusHours、sessions、completedSessions、current（此刻阶段/剩余秒/待办），
  daily 是**近 7 天**按天的专注秒数与番茄数。统计口径与番茄钟页、学习周报完全相同。
- 权限：manual（默认）档只生成确认卡，用户点「确认执行」后才会真的开始/暂停计时；auto 档由系统直接执行。
  所以 explain 要写清后果，例如"确认后立刻开始计时"，不要用"已为你开始"冒充尚未执行的草稿。
- 统计只讲账本里真实存在的数字：没有记录就如实说"番茄钟还没有记录"，不要估算。`;

/**
 * 给外部 Agent 的工具契约：读状态 + 控制计时，每个写工具都对应一个已实现的 HTTP 接口。
 * `mutates:true` 提醒 Agent 先征得用户确认（界面里的 manual 档就是确认卡）。
 */
const POMODORO_TOOLS = [
  {
    name: 'pomodoro_status',
    description:
      '查番茄钟当前状态与专注统计（只读）。返回当前阶段/剩余秒/关联待办，以及今日、本周、近 7 天的专注秒数与番茄数。' +
      '要开始/重开、暂停、继续、跳过、停止或换关联待办，请用下面的写工具（它们会真的改计时状态）。',
    method: 'GET',
    path: '/pomodoro/status',
    requiresAuth: false,
    mutates: false,
    implemented: true,
    params: {},
    returns: {
      phase: 'idle|study|break',
      running: 'boolean',
      remainingSec: 'number',
      totalSec: 'number',
      round: 'number（本轮完成的番茄数）',
      taskId: 'string|null',
      taskTitle: 'string|null',
      today: '{ studySec, breakSec, sessions }',
      week: '{ studySec, sessions }',
      daily: '[{ day, studySec, sessions }]（近 7 天）',
      config: 'object',
    },
  },
  {
    name: 'pomodoro_start',
    description:
      '开始一个番茄钟。已经在专注/休息时会返回 409（这个 HTTP 接口不做隐式重开）；要重开请先调用 pomodoro_stop' +
      '（它会把当前阶段按实际时长记入账本），再调用本工具开始新一轮。' +
      'studyMin/breakMin 只覆盖本轮，不修改用户设置。',
    method: 'POST',
    path: '/pomodoro/start',
    requiresAuth: false,
    mutates: true,
    implemented: true,
    params: {
      taskId: 'string?（关联待办 id；省略则沿用当前关联，传 null 解除关联）',
      studyMin: 'number?（本轮专注分钟数，0.05~240；省略用设置里的值）',
      breakMin: 'number?（本轮休息分钟数，0.05~240）',
    },
    returns: { phase: 'study', endsAt: 'ISO 时刻', taskTitle: 'string|null', round: 'number', status: '与 GET /pomodoro/status 同形' },
  },
  {
    name: 'pomodoro_pause',
    description: '暂停当前正在跑的番茄钟。未开始或已经暂停时返回 400（错误里带当前状态）。',
    method: 'POST',
    path: '/pomodoro/pause',
    requiresAuth: false,
    mutates: true,
    implemented: true,
    params: {},
  },
  {
    name: 'pomodoro_resume',
    description: '继续已经暂停的番茄钟（按剩余时间重算 endsAt）。未开始或正在跑时返回 400。',
    method: 'POST',
    path: '/pomodoro/resume',
    requiresAuth: false,
    mutates: true,
    implemented: true,
    params: {},
  },
  {
    name: 'pomodoro_skip',
    description: '跳过当前阶段：按实际已过时长记一条 completed:false 的会话，进入下一阶段（专注→休息 / 休息→专注）。',
    method: 'POST',
    path: '/pomodoro/skip',
    requiresAuth: false,
    mutates: true,
    implemented: true,
    params: {},
  },
  {
    name: 'pomodoro_stop',
    description: '停止本轮番茄钟：当前阶段按实际时长记一条不完整会话，回到未开始。未开始时是成功的空操作。',
    method: 'POST',
    path: '/pomodoro/stop',
    requiresAuth: false,
    mutates: true,
    implemented: true,
    params: {},
  },
  {
    name: 'pomodoro_set_task',
    description: '换番茄钟关联的待办（传 null 解除关联）。待办不存在时返回 400。',
    method: 'POST',
    path: '/pomodoro/setTask',
    requiresAuth: false,
    mutates: true,
    implemented: true,
    params: { taskId: 'string|null（必填）' },
  },
];

export default {
  id: 'pomodoro',
  title: '番茄钟',
  order: 22,

  // 会话账本是业务数据（要按天统计、要跟随多端同步），所以走 JsonStore；
  // 运行中的临时状态是单例，放 dataDir 私有文件（见 service.js）。
  collections: [{ name: 'pomodoroSessions', file: 'pomodoro-sessions.json' }],

  aiTools: POMODORO_TOOLS,
  aiPrompt: AI_PROMPT,
  aiQueryFields: {
    // 通用投影只认对象数组里的字段；query 返回的 items 只有一条，把模型要用的都列上
    pomodoro: ['range', 'studySec', 'breakSec', 'focusHours', 'sessions', 'completedSessions', 'daily', 'current', 'explain'],
  },
  // 聚合统计只有一份，多给几条只会重复占上下文
  aiQueryLimits: { pomodoro: 1 },

  createServices({ store, broadcast, services, dataDir, options }) {
    const pomodoro = new PomodoroService({
      store,
      broadcast,
      dataDir,
      todoService: services.todos ?? null,
      options,
    });
    // 读写都登记：query 只读统计，create/update/delete 由服务层状态机执行（理由见 commands.js）
    services.commands.registerHandler('pomodoro', createPomodoroCommands({ pomodoro }));
    return { pomodoro };
  },

  async restore({ own }) {
    await own.pomodoro.restore();
  },

  registerRoutes(router, ctx) {
    registerPomodoroRoutes(router, ctx);
  },

  start({ own }) {
    own.pomodoro.startTimer();
  },

  stop({ own }) {
    own.pomodoro.stopTimer();
  },
};
