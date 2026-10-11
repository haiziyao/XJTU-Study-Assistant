/**
 * 日历与待办模块。
 *
 * 领域模型：`Event`（日期/日期区间粒度：假期、考试周、截止日）与
 * `Schedule`（时段粒度：上课、会议、自习；allDay 时退化为日期锚点 = 待办）。
 *
 * 被依赖情况：lms 模块（order 20）同步时会调用本模块的 `services.schedules/events`，
 * 因此本模块的 order 必须更小。
 */

import { EventService } from './event-service.js';
import { ScheduleService } from './schedule-service.js';
import { ReminderService } from './reminder-service.js';
import { CommandParser } from './parser.js';
import { createCalendarCommands } from './commands.js';
import { registerCalendarRoutes } from './routes.js';

export default {
  id: 'calendar',
  title: '日历与待办',
  order: 10,

  collections: [
    { name: 'events', file: 'events.json' },
    { name: 'schedules', file: 'schedules.json' },
  ],

  createServices({ store, broadcast, services }) {
    const events = new EventService({ store, broadcast });
    const schedules = new ScheduleService({ store, broadcast });
    const reminders = new ReminderService({ store, scheduleService: schedules, broadcast });

    // 向框架的指令系统登记本模块的能力：
    // 解析器负责「中文 → 指令对象」，处理器负责「指令对象 → 落库」。
    // 登记之后，/commands/parse|execute|run 即可操作 event / schedule，框架无需认识日历。
    services.commands.registerParser('calendar', new CommandParser());
    const calendarCommands = createCalendarCommands({ events, schedules, store });
    services.commands.registerHandler('event', calendarCommands);
    services.commands.registerHandler('schedule', calendarCommands);

    return { events, schedules, reminders };
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
