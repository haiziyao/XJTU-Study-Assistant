/**
 * 提醒引擎：逾期推送 + 早晚两次温度提示。
 *
 * 三条设计原则（否则提醒会变成噪音，用户第一件事就是关掉它）：
 * 1. **同一件事只提醒一次**：逾期任务按 id 去重，只要它还在逾期状态就不再重复推；
 * 2. **有上限**：一轮最多推 5 条摘要，剩下的用总数一句带过；
 * 3. **不深夜叫人**：收尾提示只发一次，23:00 之后完全静默。
 *
 * 时间点、逾期升级天数、总开关、跨天顺延策略都从 `settings` 读，
 * 不再是写死的常量（默认值：10:00 状态提示 / 21:00 收尾 / 3 天升级 / 不顺延）。
 *
 * 与源项目的差别：源项目 `bus.emit(type, payload)` 走 SSE；这里注入的 bus 由
 * `module.js` 包装成 WebSocket 的 `data_changed`（module='growth'），
 * 引擎本身不关心通道，只关心"发出了什么"。
 */

import { addDays, dateKey, diffDays, iso } from './time.js';

export function createReminderEngine({ clock, bus, services }) {
  const seenOverdue = new Set();
  const escalated = new Set();
  const nudged = new Map();
  let timer = null;
  let lastTick = null;
  let lastDay = dateKey(clock.now());

  /** 跨天时按设置决定未完成任务怎么处理。 */
  async function carryOver(day) {
    const settings = await services.settings.read();
    if (settings.tasks.carryOver !== 'auto') return 0;
    const open = (await services.tasks.list({})).filter((task) => task.status === 'todo' && task.date < day);
    const batch = open.slice(0, 50);
    for (const task of batch) {
      await services.tasks.postpone(task.id, { to: day });
    }
    if (batch.length) {
      await services.session.log('system', `自动顺延：${batch.length} 条未完成任务挪到 ${day}`, { count: batch.length });
    }
    return batch.length;
  }

  async function tick(now = clock.now()) {
    const day = dateKey(now);
    const hour = now.getHours();
    const events = [];
    const flags = nudged.get(day) ?? new Set();
    nudged.set(day, flags);
    const settings = await services.settings.read();
    const prefs = settings.reminders;

    // 跨天：程序常驻时页面不会自己知道"昨天过完了"，这里补一个事件
    if (day !== lastDay) {
      const previous = lastDay;
      lastDay = day;
      await services.session.log('system', `跨天：${previous} → ${day}`);
      const carried = await carryOver(day);
      bus.emit('day', { date: day, previous, carried, at: iso(now) });
      events.push('day');
      // 顺手清掉一周前的提示记录，避免常驻进程里这个 Map 无限长
      for (const key of [...nudged.keys()]) {
        if (key < addDays(day, -7)) nudged.delete(key);
      }
    }

    if (!prefs.enabled) {
      lastTick = { at: iso(now), overdue: (await services.tasks.overdue(now)).length, events, muted: true };
      return lastTick;
    }

    const overdue = await services.tasks.overdue(now);
    const overdueIds = new Set(overdue.map((task) => task.id));
    const fresh = overdue.filter((task) => !seenOverdue.has(task.id));
    seenOverdue.clear();
    for (const id of overdueIds) seenOverdue.add(id);

    if (fresh.length) {
      bus.emit('reminder', {
        kind: 'overdue',
        count: overdue.length,
        fresh: fresh.slice(0, 5).map((task) => ({
          id: task.id,
          title: task.title,
          date: task.date,
          dueAt: task.dueAt,
        })),
        message: `有 ${overdue.length} 条任务已逾期`,
        at: iso(now),
      });
      events.push('overdue');
    }

    // 挂了超过 N 天（默认 3）的：只推一次，逼一个决定（补做 / 改期 / 放弃）
    const stillOverdue = new Set();
    for (const task of overdue) {
      const days = diffDays(day, task.date);
      if (days < prefs.deepDays) continue;
      stillOverdue.add(task.id);
      if (escalated.has(task.id)) continue;
      escalated.add(task.id);
      bus.emit('nudge', {
        kind: 'overdue-deep',
        taskId: task.id,
        days,
        message: `「${task.title}」已经逾期 ${days} 天。今天做个决定：补做、改期到明天，还是直接放弃。`,
        at: iso(now),
      });
      events.push('nudge-overdue-deep');
    }
    for (const id of [...escalated]) {
      if (!stillOverdue.has(id)) escalated.delete(id);
    }

    const state = await services.state.get(day);
    if (!state && hour >= prefs.stateHour && hour < 23 && !flags.has('state')) {
      flags.add('state');
      bus.emit('nudge', {
        kind: 'state',
        message: '今天还没录入状态。先填 30 秒，任务表单才能按你今天的真实电量排。',
        at: iso(now),
      });
      events.push('nudge-state');
    }

    if (hour >= prefs.closeHour && hour < 23 && !flags.has('close')) {
      const todays = await services.tasks.list({ date: day });
      const todo = todays.filter((task) => task.status === 'todo');
      if (todo.length) {
        flags.add('close');
        bus.emit('nudge', {
          kind: 'close',
          message: `今天还有 ${todo.length} 条没打卡。要么现在做最小的一条，要么明天第一件事是决定放弃它。`,
          at: iso(now),
        });
        events.push('nudge-close');
      }
    }

    lastTick = { at: iso(now), overdue: overdue.length, events };
    return lastTick;
  }

  return {
    tick,

    start(intervalMs = 60_000) {
      if (timer) return;
      timer = setInterval(() => {
        tick().catch((err) => console.error('[growth] 提醒扫描失败：', err.message));
      }, intervalMs);
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },

    async status() {
      const overdue = await services.tasks.overdue();
      return {
        lastTick,
        overdue: overdue.map((task) => ({
          id: task.id,
          title: task.title,
          date: task.date,
          dueAt: task.dueAt,
        })),
        nudgesToday: [...(nudged.get(dateKey(clock.now())) ?? [])],
      };
    },
  };
}
