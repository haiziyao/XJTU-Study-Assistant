/**
 * 提醒服务：扫描待进行日程，到点通过 WebSocket 推送提醒。
 *
 * PotatoCalendar 完全没有提醒能力，这是新版本新增的领域逻辑。
 * 约定：
 * - 定时日程以 `date + startTime` 为基准，全天日程以当天 08:00 为基准；
 * - 每条提醒在 record.reminders[i].sent[occurrenceDate] 记录已发送时间，避免重复推送；
 * - 只处理状态为 pending 的日程，跨重启不会丢（状态存在数据文件里）。
 */

import { WS_MESSAGE_TYPES } from '../../shared/constants.js';
import { addDays, combine, todayKey } from '../../shared/time.js';

/** 全天日程的提醒基准时刻。 */
const ALL_DAY_BASE_CLOCK = '08:00';
/** 超过该窗口的过期提醒不再补发（避免重启后一次性刷屏）。 */
const STALE_WINDOW_MS = 12 * 60 * 60 * 1000;

export class ReminderService {
  constructor({ store, scheduleService, broadcast = () => {}, scanIntervalMs = 30000, now = () => new Date() }) {
    this.store = store;
    this.scheduleService = scheduleService;
    this.broadcast = broadcast;
    this.scanIntervalMs = scanIntervalMs;
    this.now = now;
    this.timer = undefined;
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => {
      this.scanOnce().catch((error) => {
        console.error('[reminder] 扫描失败:', error.message);
      });
    }, this.scanIntervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * 扫描一次。
   * @returns {Promise<Array<object>>} 本次触发的提醒
   */
  async scanOnce() {
    const now = this.now();
    const today = todayKey(now);
    const due = [];

    for (const schedule of this.store.schedules.all()) {
      if (schedule.status !== 'pending') continue;
      if (!schedule.reminders?.length) continue;
      if (schedule.date > addDays(today, 1) || schedule.date < addDays(today, -2)) continue;

      for (const [index, reminder] of schedule.reminders.entries()) {
        const triggerAt = triggerTime(schedule, reminder);
        if (!triggerAt) continue;
        const delta = now.getTime() - triggerAt.getTime();
        if (delta < 0 || delta > STALE_WINDOW_MS) continue;
        const occurrenceDate = schedule.date;
        if (reminder.sent?.[occurrenceDate]) continue;

        const sent = { ...(reminder.sent ?? {}), [occurrenceDate]: now.toISOString() };
        const reminders = schedule.reminders.map((item, i) => (i === index ? { ...item, sent } : item));
        await this.store.schedules.update(schedule.id, { reminders });

        due.push({
          scheduleId: schedule.id,
          title: schedule.title,
          date: schedule.date,
          startTime: schedule.startTime ?? null,
          offsetMinutes: reminder.offsetMinutes,
          channel: reminder.channel,
          triggerAt: triggerAt.toISOString(),
          occurrenceDate,
        });
      }
    }

    for (const item of due) {
      this.broadcast({ type: WS_MESSAGE_TYPES.REMINDER, payload: item });
    }
    return due;
  }
}

function triggerTime(schedule, reminder) {
  if (schedule.allDay || !schedule.startTime) {
    const base = combine(schedule.date, ALL_DAY_BASE_CLOCK);
    return new Date(base.getTime() - reminder.offsetMinutes * 60000);
  }
  const base = combine(schedule.date, schedule.startTime);
  return new Date(base.getTime() - reminder.offsetMinutes * 60000);
}
