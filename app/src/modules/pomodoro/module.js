/**
 * 番茄钟模块（`pomodoro`，order 22）：专注/休息计时、到点自动切换、时间记到待办、
 * 会话账本与只读统计。
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
 * 反复强调"只读、没有写入口"是有原因的：模型看到"番茄钟"很容易直接回
 * "好的，已经为你开始 45 分钟专注了" —— 而系统里根本没有这个写通道，
 * 用户会对着一个实际停在 idle 的计时器等 45 分钟。
 */
const AI_PROMPT = `【番茄钟（只读）】
- 用户问"我今天学了多久 / 今天几个番茄 / 这周专注了多久"时，用只读查询：
  {"ok":true,"action":"query","target":"pomodoro","filters":{"range":"today"}}
  range 取 today / week / all，缺省 today。返回里的 studySec 是专注秒数，focusHours 是换算后的小时数，
  sessions 是专注次数，completedSessions 是完整番茄数，current 是此刻的计时状态（阶段/剩余秒/关联待办）。
- **你没有任何启动/暂停/停止番茄钟的写能力**。用户说"帮我开始专注 / 开始一个番茄"时，
  要引导用户点左栏「番茄钟」页里的「开始专注」按钮，**不要假装已经启动**，也不要说"已为你计时"。
- 统计只讲账本里真实存在的数字：没有记录就如实说"番茄钟还没有记录"，不要估算。`;

/** 给外部 Agent 的工具契约：只读状态查询，没有写入口。 */
const POMODORO_TOOLS = [
  {
    name: 'pomodoro_status',
    description:
      '查番茄钟当前状态与专注统计（只读）。返回当前阶段/剩余秒/关联待办，以及今日、本周、近 7 天的专注秒数与番茄数。' +
      '它**不能**启动或暂停计时；要开始专注请让用户点界面上的按钮。',
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
    // 只登记 query（没有写 action）—— 写操作只有界面按钮能触发，理由见 commands.js
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
