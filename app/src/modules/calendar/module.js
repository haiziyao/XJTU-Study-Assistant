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

import { EventService } from './event-service.js';
import { ScheduleService } from './schedule-service.js';
import { TodoService } from './todo-service.js';
import { ReminderService } from './reminder-service.js';
import { CommandParser } from './parser.js';
import { createCalendarCommands } from './commands.js';
import { registerCalendarRoutes } from './routes.js';
import { CALENDAR_TOOL_SPECS } from './tools.js';

export default {
  id: 'calendar',
  title: '日历与待办',
  order: 10,

  collections: [
    { name: 'events', file: 'events.json' },
    { name: 'schedules', file: 'schedules.json' },
    { name: 'todos', file: 'todos.json' },
  ],

  /** 聚合进 GET /api/v1/ai/capabilities —— AI 靠这份清单才知道自己能读写待办/日程/事件。 */
  aiTools: CALENDAR_TOOL_SPECS,

  createServices({ store, broadcast, services }) {
    const events = new EventService({ store, broadcast });
    const schedules = new ScheduleService({ store, broadcast });
    const todos = new TodoService({ store, broadcast });
    const reminders = new ReminderService({ store, scheduleService: schedules, broadcast });

    // 向框架的指令系统登记本模块的能力：
    // 解析器负责「中文 → 指令对象」，处理器负责「指令对象 → 落库」。
    // 登记之后，/commands/parse|execute|run 即可操作 event / schedule / todo，框架无需认识日历。
    services.commands.registerParser('calendar', new CommandParser());
    const calendarCommands = createCalendarCommands({ events, schedules, todos, store });
    services.commands.registerHandler('event', calendarCommands);
    services.commands.registerHandler('schedule', calendarCommands);
    services.commands.registerHandler('todo', calendarCommands);

    return { events, schedules, todos, reminders };
  },

  /**
   * 一次性迁移（listen 之前跑）：早期版本把「待办」写成 schedules 里的**日期锚点**
   * （`source === 'import' && allDay === true`）。待办现在有独立集合，这类行留在
   * schedules 里就会「数据还在但界面看不见」，所以搬进 todos 再从 schedules 删掉。
   *
   * 只动带 externalId 的导入行；手写的日程不受影响。迁移是幂等的（搬完就没有了）。
   */
  async restore({ store, broadcast }) {
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
