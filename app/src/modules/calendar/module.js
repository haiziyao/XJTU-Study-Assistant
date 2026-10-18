/**
 * 日历与待办模块。
 *
 * 领域模型（三件事，各归其位）：
 * - `Event`    日历事件：日期 / 日期区间粒度（假期、考试周、纪念日），没有完成态；
 * - `Schedule` 日程：**时段**粒度（上课、会议、自习），`startTime` 必填，没有完成态；
 * - `Todo`     待办：只有截止日 + 预估工时 + 优先级 + **完成态**，是独立实体。
 *
 * 被依赖情况：lms 模块（order 20）同步时会调用本模块的 `services.schedules/events`，
 * 因此本模块的 order 必须更小。lms 投递的是历史形状（`allDay` 的日期锚点），
 * 服务层照收照存，但对外路由一律严格（见 routes.js）。
 */

import { CategoryService } from './category-service.js';
import { EventService } from './event-service.js';
import { ScheduleService } from './schedule-service.js';
import { TodoService } from './todo-service.js';
import { ReminderService } from './reminder-service.js';
import { CommandParser } from './parser.js';
import { createCalendarCommands } from './commands.js';
import { registerCalendarRoutes } from './routes.js';
import { CALENDAR_TOOL_SPECS } from './tools.js';

/**
 * 给对话模型的领域说明（由 ai 模块聚合进系统提示词）。
 *
 * 为什么这两段必须写：`category` / `parentId` 是 2026-10 新加的字段，提示词里不说，
 * 模型只会沿用旧清单（title / deadline / …）。用户说"拆成子任务""归到期末复习分类下"时，
 * 它要么不写、要么自己造一个字段名 —— 而待办对未知字段是**硬 400**
 * （见 todo-service 的 assertKnownFields），整条草稿都会失败。
 */
const AI_PROMPT = `【待办的分类与父子拆解】
- 分类填在 category（自由文本，≤24 字，例如 "期末复习" / "实验室"）；没有分类就用空字符串 ""，
  不要编一个不存在的枚举值。用户说"归到 xx 分类下"时写 category: "xx"。
- 可以把一件事拆成父子（parentId）：父 / 子 / 孙最多 3 层，parentId 必须是**已存在**待办的 id。
  要给某条现有待办加子任务时，先用 {"action":"query","target":"todo","filters":{"keyword":"<父任务名>"}}
  查到它的 id，再 {"action":"create","target":"todo","fields":{"title":"…","deadline":"…","parentId":"<那个 id>"}}。
  **不要**把 parentId 写成标题、序号或 "root"；也不要一轮里先建父再拿"新父的 id"建子（id 由服务端生成，
  你拿不到）。父已存在就先查后建。
- 查询可以按分类 / 父子筛：filters 额外支持 category（分类名，"" = 未分类）与 parentId（父 id；"root" = 只看顶层）。
- 完成父待办会**连带完成所有后代**（响应里的 cascaded.completed 是受影响的 id 列表）；取消完成父只会
  回滚那些由它连带完成的子任务，用户自己手动勾过的子任务保持完成。回执里带了 cascaded 就如实说明
  "已连带完成 N 个"。
`;

export default {
  id: 'calendar',
  title: '日历与待办',
  order: 10,

  collections: [
    // 分类拆两张表：日程与事件各自一套，且共用 study/exam/other 这些内置 id，
    // 合表会让「记录 id」不再等于「写进日程的 category 值」（见 category-service.js 的注释）
    { name: 'scheduleCategories', file: 'schedule-categories.json' },
    { name: 'eventCategories', file: 'event-categories.json' },
    { name: 'events', file: 'events.json' },
    { name: 'schedules', file: 'schedules.json' },
    { name: 'todos', file: 'todos.json' },
  ],

  /** 聚合进 GET /api/v1/ai/capabilities —— AI 靠这份清单才知道自己能读写待办/日程/事件。 */
  aiTools: CALENDAR_TOOL_SPECS,

  aiPrompt: AI_PROMPT,

  /**
   * 只读查询结果回灌给模型时保留这些字段（**覆盖** ai 模块内置的 todo 投影表）。
   *
   * 投影表是"模型能看到什么"的唯一决定因素，缺一个字段就等于那个信息不存在：
   * - `category` / `parentId`：缺了模型就没法按分类回答，也拿不到"给现有待办加子任务"
   *   所需的父 id（parentId 必须是真实 id，它不能靠标题猜）；
   * - `childCount` / `childDoneCount` / `hasChildren`：缺了它就说不清"这一步拆成几步、做到哪了"。
   */
  aiQueryFields: {
    /**
     * 日程查询走 `range()` 展开重复后，每条是「某一天的那一次」：
     * `occurrenceDate` 是这次发生的日期，`id` / `scheduleId` 是**原日程 id**
     * （改/删要用它 —— `range()` 内部的 `${id}:${date}` 是合成 id，集合里没有这条记录）。
     * 展开结果里没有 `date`（那是 `list()` 路径上的首次发生日）；只给 `date` 不给
     * `occurrenceDate`，模型会把「每周重复的课」当成只在 9 月 14 日上一次。
     */
    schedule: [
      'id',
      'scheduleId',
      'occurrenceDate',
      'date',
      'title',
      'category',
      'priority',
      'startTime',
      'endTime',
      'location',
      'estimatedMinutes',
      'isRepeatInstance',
    ],
    todo: [
      'id',
      'title',
      'deadline',
      'completed',
      'priority',
      'estimatedHours',
      'category',
      'parentId',
      'childCount',
      'childDoneCount',
      'hasChildren',
    ],
  },

  createServices({ store, broadcast, services }) {
    // 分类注册表要先建：日程/事件服务写库时用它把 category 归一化
    const categories = new CategoryService({ store, broadcast });
    // audit 是 order 6 的全局服务：注入给三个写服务后，用户经界面/HTTP 的写操作才会被记录
    // （AI 写由 chat-service 统一记 actor:'ai'，服务端在 __actor 标记期间跳过，避免重复）。
    const audit = services.audit;
    const events = new EventService({ store, broadcast, categories, services, audit });
    const schedules = new ScheduleService({ store, broadcast, categories, services, audit });
    const todos = new TodoService({ store, broadcast, services, audit });
    const reminders = new ReminderService({ store, scheduleService: schedules, broadcast });

    // 向框架的指令系统登记本模块的能力：
    // 解析器负责「中文 → 指令对象」，处理器负责「指令对象 → 落库」。
    // 登记之后，/commands/parse|execute|run 即可操作 event / schedule / todo，框架无需认识日历。
    services.commands.registerParser('calendar', new CommandParser());
    const calendarCommands = createCalendarCommands({ events, schedules, todos, store });
    services.commands.registerHandler('event', calendarCommands);
    services.commands.registerHandler('schedule', calendarCommands);
    services.commands.registerHandler('todo', calendarCommands);

    return { events, schedules, todos, categories, reminders };
  },

  /**
   * 一次性迁移（listen 之前跑）：早期版本把「待办」写成 schedules 里的**日期锚点**
   * （`source === 'import' && allDay === true`）。待办现在有独立集合，这类行留在
   * schedules 里就会「数据还在但界面看不见」，所以搬进 todos 再从 schedules 删掉。
   *
   * 只动带 externalId 的导入行；手写的日程不受影响。迁移是幂等的（搬完就没有了）。
   */
  async restore({ store, broadcast, own }) {
    // 分类：集合为空时才播种内置的 6+6 个（用户改过就不覆盖）
    await own.categories.ensureDefaults();

    // 父子关系修复：同步按 id 合并、冲突时会给副本换 id，父链可能指向已不存在的记录；
    // 不修就会留下悬空 parentId（树形视图会静默少掉整棵子树）。修复是幂等的。
    const hierarchy = await own.todos.repairHierarchy();
    if (hierarchy.repaired.length) {
      console.log(`[calendar] 已修复 ${hierarchy.repaired.length} 条待办的父子关系（悬空/成环/超 3 层）`);
    }

    const legacy = store.schedules.all().filter((item) => item.allDay === true && item.source === 'import');
    if (!legacy.length) return;
    for (const item of legacy) {
      await store.todos.insert({
        title: item.title,
        deadline: item.date,
        estimatedHours: item.estimatedMinutes ? Number((item.estimatedMinutes / 60).toFixed(2)) : 1,
        priority: item.priority ?? 0,
        completed: item.status === 'done',
        completedAt: item.completedAt ?? null,
        description: item.description ?? '',
        tags: item.tags ?? [],
        source: 'import',
        externalId: item.externalId ?? null,
      });
      await store.schedules.remove(item.id);
    }
    broadcast?.({ type: 'data_changed', payload: { target: 'todo', action: 'migrate', count: legacy.length } });
    console.log(`[calendar] 已迁移 ${legacy.length} 条日期锚点 -> 待办（todos.json）`);
  },

  registerRoutes(router, ctx) {
    registerCalendarRoutes(router, ctx);
  },

  /** 提醒扫描持有 setInterval，必须在 listen 成功后启动、close 时停止。 */
  start({ own }) {
    own.reminders.start();
  },

  stop({ own }) {
    own.reminders.stop();
  },
};
