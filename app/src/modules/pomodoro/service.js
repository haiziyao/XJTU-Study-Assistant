/**
 * 番茄钟服务：**权威状态 + 会话账本 + 到点补账 + 时间归属**。
 *
 * 三条边界（写清楚，避免以后有人图省事把逻辑挪错地方）：
 *
 * 1. **状态迁移只在 state.js**。本文件只负责把迁移结果落盘、写账本、广播、把学习时长
 *    记到待办上。这样纯函数测试能覆盖全部时间边界，而服务层只测"副作用"。
 *
 * 2. **写待办必须走 calendar 模块自己的服务**（`services.todos.addSpentSec`），不直接改
 *    `store.todos`。契约要求"写别人的数据走对方服务"：校验、广播、后续的派生字段口径
 *    都归待办模块所有。番茄钟只知道"给这条待办加 N 秒"。
 *
 * 3. **运行中的状态不同步**（见 sync/catalog.js 的注释）。当前在专注/休息、还剩多少秒，
 *    是"这台设备此刻正在发生的事"；同步到另一台设备只会让两个界面抢同一个计时器。
 *    会话账本（已经发生的历史）才是可同步的内容。
 *
 * 关于「时间记到所有祖先」的偏离（相对参考实现）：
 * 参考实现只给直接父级加一次，但本项目的待办最多 3 层；只加一层会让祖父级的
 * `spentSec` 少掉孙辈的投入。这里**只把秒数写进当前待办的 `spentSelfSec`**，祖先的
 * `spentSec` 由待办服务在读取时按"自己 + 全部后代"现算 —— 效果就是每一层都加到了，
 * 而且不会因为移动父子关系 / 删除子任务留下重复累计的脏数字（写死聚合值必然过期）。
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { HttpError } from '../../core/http/router.js';
import { addDays, isDateKey, toDateKey, todayKey, weekdayOf } from '../../shared/time.js';
import {
  coreStatus,
  createIdleState,
  elapsedSeconds,
  finishPhase,
  normalizeState,
  pauseState,
  reconcileState,
  resumeState,
  setTaskState,
  startState,
  stopState,
  updateConfigState,
} from './state.js';

/** 会话账本上限：超过就丢最旧（理由见 #appendSessions）。 */
export const MAX_SESSIONS = 2000;
export const MAX_SESSIONS_LIMIT = 2000;
/** 列表默认给全量（账本上限 2000）；调用方要分页时再显式传 limit。 */
export const DEFAULT_SESSIONS_LIMIT = MAX_SESSIONS_LIMIT;

/** 定时器默认 5 秒对一次账：足够让两端的提醒及时，又不会把 CPU 吵醒。 */
export const DEFAULT_TICK_MS = 5000;

const SESSION_FIELDS = ['id', 'kind', 'taskId', 'taskTitle', 'startedAt', 'endedAt', 'plannedSec', 'actualSec', 'completed', 'day'];

/** 只保留账本契约里的字段（不把 JsonStore 的 createdAt/updatedAt 漏出去）。 */
function projectSession(record) {
  return Object.fromEntries(SESSION_FIELDS.map((key) => [key, record[key] ?? null]));
}

/** 本地日期键：会话归到**结束那一天**（23:50 开始、00:35 结束的番茄算第二天的投入）。 */
function dayOf(record) {
  if (typeof record.day === 'string' && isDateKey(record.day)) return record.day;
  const ms = Date.parse(String(record.endedAt ?? ''));
  return Number.isFinite(ms) ? toDateKey(new Date(ms)) : todayKey();
}

/** 小时数保留一位小数（0.5h 比 "1800 秒" 更像人话；0 不抹成 null）。 */
const toHours = (sec) => Number(((Number(sec) || 0) / 3600).toFixed(1));

export class PomodoroService {
  /**
   * @param {object} input
   * @param {object} input.store     JsonStore
   * @param {Function} [input.broadcast]
   * @param {string} input.dataDir   私有状态文件目录（`pomodoro-state.json`）
   * @param {object} [input.todoService] calendar 模块的 TodoService（可缺省：缺省时不记待办时长）
   * @param {object} [input.options] `createServer({ pomodoro: { now, tickMs } })`
   */
  constructor({ store, broadcast = () => {}, dataDir, todoService = null, options = {} }) {
    this.store = store;
    this.broadcast = broadcast;
    this.dataDir = dataDir;
    this.todos = todoService;
    this.options = options ?? {};
    this.stateFile = path.join(dataDir, 'pomodoro-state.json');
    this.sessions = store.pomodoroSessions;
    if (!this.sessions) throw new Error('pomodoro 模块缺少 pomodoroSessions 集合');
    this.state = createIdleState(this.options.config ?? {});
    this.timer = null;
    this.writeQueue = Promise.resolve();
  }

  /* ---------------------------------------------------------------- 时钟 / 持久化 */

  #now() {
    const source = this.options.now;
    if (typeof source === 'function') return new Date(source());
    if (source instanceof Date) return new Date(source);
    if (source) {
      const parsed = new Date(source);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return new Date();
  }

  #saveState() {
    const payload = { schemaVersion: 1, state: this.state };
    this.writeQueue = this.writeQueue.catch(() => {}).then(async () => {
      const tmp = `${this.stateFile}.${process.pid}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await fs.rename(tmp, this.stateFile);
    });
    return this.writeQueue;
  }

  /**
   * 启动时恢复：状态文件在就跑一次补账（电脑关机/服务重启期间到点的阶段也要记上）。
   * 恢复阶段不广播（此刻还没有客户端连上来），但仍然要写账本与待办时长。
   */
  async restore() {
    await fs.mkdir(this.dataDir, { recursive: true }).catch(() => {});
    try {
      const raw = await fs.readFile(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = normalizeState(parsed?.state ?? parsed);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // 状态文件损坏时先备份再以 idle 启动：绝不静默覆盖用户文件
        const backup = `${this.stateFile}.corrupt-${Date.now()}`;
        await fs.rename(this.stateFile, backup).catch(() => {});
        console.error(`[pomodoro] 状态文件解析失败（${error.message}），已备份到 ${backup}`);
      }
      this.state = createIdleState(this.options.config ?? {});
    }
    // 服务重启可能已经过去了很久：先把当前 study 的秒数结算到待办，再补阶段账
    await this.#creditCurrentStudy();
    await this.#reconcile({ broadcast: false });
    await this.#creditCurrentStudy();
    await this.#pruneTaskIfDeleted({ broadcast: false });
    // 历史文件可能来自更早的版本 / 手工导入：启动时就裁到上限，
    // 不要等下一次会话结算才"突然少了几百条"
    await this.pruneSessions();
    await this.#saveState();
  }

  /** 进程内定时器：只有 running 时才做补账；`unref()` 不阻止测试进程退出。 */
  startTimer() {
    if (this.timer) return;
    const tickMs = Math.max(10, Number(this.options.tickMs) || DEFAULT_TICK_MS);
    this.timer = setInterval(() => {
      this.tick().catch((error) => console.error('[pomodoro] 对账失败:', error.message));
    }, tickMs);
    this.timer.unref?.();
  }

  stopTimer() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** 定时器与 GET /status 共用：到点就补账、广播、写待办时长。 */
  async tick() {
    if (!this.state.running) return { ended: [] };
    // 先结算「已经过去的这一小段」，再对账阶段边界；顺序不能反：
    // 反过来的话，到点那一秒会被算进下一阶段（因为状态已经切走了）
    await this.#creditCurrentStudy();
    const ended = await this.#reconcile({ broadcast: true });
    await this.#creditCurrentStudy();
    await this.#pruneTaskIfDeleted({ broadcast: true });
    return { ended };
  }

  /* ---------------------------------------------------------------- 待办 */

  #taskRecord(taskId) {
    if (!taskId) return null;
    const record = this.store.todos?.get?.(taskId) ?? null;
    return record && !record.deletedAt ? record : null;
  }

  #taskTitle(taskId) {
    return this.#taskRecord(taskId)?.title ?? null;
  }

  /** 关联的待办被删了：状态里清掉并如实广播，但**绝不让定时器崩**。 */
  async #pruneTaskIfDeleted({ broadcast = true } = {}) {
    if (!this.state.taskId) return false;
    if (this.#taskRecord(this.state.taskId)) return false;
    const removed = this.state.taskId;
    this.state = { ...this.state, taskId: null };
    await this.#saveState();
    if (broadcast) {
      this.broadcast?.({
        type: 'data_changed',
        module: 'pomodoro',
        payload: { target: 'pomodoro', action: 'task-cleared', taskId: removed },
      });
    }
    return true;
  }

  #requireTask(taskId) {
    if (taskId === undefined || taskId === null || taskId === '') return null;
    if (typeof taskId !== 'string') {
      throw HttpError.badRequest('字段 taskId 不合法：必须是待办 id（字符串）或 null', { field: 'taskId' });
    }
    const record = this.#taskRecord(taskId.trim());
    if (!record) {
      throw HttpError.badRequest(`关联的待办不存在（或已删除）：${taskId}`, { field: 'taskId', code: 'TASK_NOT_FOUND' });
    }
    return record;
  }

  /**
   * 把一段专注时长记到待办上（**唯一**入口）。
   *
   * 只调用待办服务的一个方法，不碰它的集合。`addSpentSec` 会拒绝已完成/已删除的待办
   * （返回 null），所以这里不需要重复判断 —— 判断口径只能有一份。
   */
  async #creditStudy(taskId, seconds, { notify = false } = {}) {
    if (!taskId || !(seconds > 0)) return null;
    if (typeof this.todos?.addSpentSec !== 'function') return null;
    try {
      return await this.todos.addSpentSec(taskId, seconds, { notify });
    } catch (error) {
      // 待办侧失败不能让已经发生的番茄丢掉：账本照记，错误只写日志
      console.error(`[pomodoro] 专注时长入账失败（taskId=${taskId}）:`, error.message);
      return null;
    }
  }

  /**
   * 把「当前专注阶段从上次结算到现在」新增的秒数记到关联待办。
   *
   * 为什么不是只在阶段结束时记：用户专注到一半去看待办，界面上应该已经能看到
   * 这半小时的投入；参考实现也是每秒累计。`creditedSec` 记录"已经记过多少"，
   * 每个 tick 只补差额，所以不会重复加。
   *
   * 暂停态也结算一次（暂停后 elapsed 不再增长，delta 为 0 就是幂等）；
   * 已完成/已删除的待办由 `addSpentSec` 拒绝，但仍然把 `creditedSec` 推到当前值 ——
   * 否则用户中途取消完成时，会把"完成期间"的秒数补记到任务上。
   */
  async #creditCurrentStudy() {
    if (this.state.phase !== 'study') return false;
    const elapsed = elapsedSeconds(this.state, this.#now());
    const credited = Math.max(0, Math.round(Number(this.state.creditedSec) || 0));
    const delta = elapsed - credited;
    if (delta <= 0) return false;
    const taskId = this.state.taskId;
    // 先推进内存里的 creditedSec 再 await：避免并发调用（tick 与 GET）重复加同一段。
    // notify:false —— 每 5 秒一次的数据广播会让前台每 5 秒整体重画，用户正在填的设置会被冲掉；
    // 阶段结束时账本广播一次就够了，届时所有视图都会刷新。
    this.state = { ...this.state, creditedSec: elapsed };
    await this.#creditStudy(taskId, delta, { notify: false });
    await this.#saveState();
    return true;
  }

  /** 阶段已经结束（补账时）：把该阶段尚未记到待办的差额补上。 */
  async #creditEndedSessions(list) {
    for (const session of list) {
      if (session.kind !== 'study') continue;
      const delta = (Number(session.actualSec) || 0) - (Number(session.creditedSec) || 0);
      // 阶段结束（补账）时广播一次，让待办页看到最终投入时长
      await this.#creditStudy(session.taskId, delta, { notify: true });
    }
  }

  /* ---------------------------------------------------------------- 账本 */

  /**
   * 追加会话。**只保留最近 2000 条**：
   * 一年按每天 8 个番茄算约 3000 条，2000 条足够覆盖一年多的"按天统计"；
   * 再往上只会把 `pomodoro-sessions.json` 与同步 payload 越推越大，而更早的
   * 细粒度记录对周报/今日统计已经没有作用（周报只看本周）。
   * 丢弃按**会话结束时间**（`endedAt`）排旧，理由见 `pruneSessions()`。
   */
  async #appendSessions(list = [], { broadcast = true } = {}) {
    if (!list.length) return;
    for (const session of list) {
      const record = {
        id: randomUUID(),
        kind: session.kind,
        taskId: session.taskId ?? null,
        taskTitle: this.#taskTitle(session.taskId),
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        plannedSec: session.plannedSec,
        actualSec: session.actualSec,
        completed: Boolean(session.completed),
        day: dayOf(session),
      };
      await this.sessions.insert(record);
    }
    await this.pruneSessions();
    if (broadcast) {
      this.broadcast?.({
        type: 'data_changed',
        module: 'pomodoro',
        payload: { target: 'pomodoro-sessions', action: 'append', count: list.length },
      });
    }
  }

  /** 公开给测试/维护用：把账本裁到 MAX_SESSIONS。 */
  async pruneSessions() {
    const all = this.sessions.all();
    if (all.length <= MAX_SESSIONS) return { removed: 0, total: all.length };
    // 按**会话结束时间**排旧，而不是 createdAt：同步拉过来的记录会由集合层重写
    // createdAt（变成"这台设备收到它的时间"），拿它排旧会把老会话当成新记录留下。
    const oldest = all
      .slice()
      .sort((a, b) => String(a.endedAt ?? a.createdAt ?? '').localeCompare(String(b.endedAt ?? b.createdAt ?? '')))
      .slice(0, all.length - MAX_SESSIONS)
      .map((item) => item.id);
    await this.sessions.removeMany(oldest);
    return { removed: oldest.length, total: MAX_SESSIONS };
  }

  /**
   * 补账：把到点的阶段逐段结算。返回本次结束的阶段（按时间顺序）。
   * 广播的 `round` 是**该阶段结束后**的完成数，而不是最终值 —— 跨多个阶段时，
   * 每个提醒说的都是"当时完成了几个"，不会三条提醒都报同一个数字。
   */
  async #reconcile({ broadcast = true } = {}) {
    const now = this.#now();
    const before = this.state;
    const { state, ended } = reconcileState(before, now);
    if (ended.length === 0 && state === before) return [];
    this.state = state;
    // 跨阶段补账时，中间那些 study 阶段还没被"实时结算"过：按每个 session 的
    // creditedSec 差额补记，既不会漏，也不会把已经记过的部分再加一遍。
    await this.#creditEndedSessions(ended);
    await this.#appendSessions(ended, { broadcast });
    await this.#saveState();
    if (broadcast) {
      let round = before.round;
      for (const session of ended) {
        if (session.kind === 'study' && session.completed) round += 1;
        this.broadcast?.({
          type: 'pomodoro',
          payload: {
            kind: 'phase-end',
            phase: session.kind,
            next: session.kind === 'study' ? 'break' : 'study',
            taskId: session.taskId,
            round,
          },
        });
      }
    }
    return ended;
  }

  /* ---------------------------------------------------------------- 状态 / 统计 */

  #dailyRows(list, fromKey, toKey) {
    const map = new Map();
    for (const record of list) {
      if (record.kind !== 'study') continue;
      const day = dayOf(record);
      if (day < fromKey || day > toKey) continue;
      const row = map.get(day) ?? { day, studySec: 0, sessions: 0 };
      row.studySec += Number(record.actualSec) || 0;
      row.sessions += 1;
      map.set(day, row);
    }
    const rows = [];
    for (let cursor = fromKey; cursor <= toKey; cursor = addDays(cursor, 1)) {
      rows.push(map.get(cursor) ?? { day: cursor, studySec: 0, sessions: 0 });
    }
    return rows;
  }

  #aggregate(all, now) {
    const today = todayKey(now);
    const weekStart = addDays(today, 1 - weekdayOf(today));
    const weekEnd = addDays(weekStart, 6);
    const todayRow = { studySec: 0, breakSec: 0, sessions: 0 };
    const weekRow = { studySec: 0, sessions: 0 };
    for (const record of all) {
      const day = dayOf(record);
      const seconds = Number(record.actualSec) || 0;
      if (day === today) {
        if (record.kind === 'study') {
          todayRow.studySec += seconds;
          todayRow.sessions += 1;
        } else if (record.kind === 'break') {
          todayRow.breakSec += seconds;
        }
      }
      if (record.kind === 'study' && day >= weekStart && day <= weekEnd) {
        weekRow.studySec += seconds;
        weekRow.sessions += 1;
      }
    }
    /**
     * **正在进行的这个阶段**还没进账本，但它确实已经发生了：今日/本周统计要把它加上，
     * 否则用户专注 40 分钟时页面还写着"0 分钟"，会以为计时器没生效。
     * 结束后账本记一条 actualSec，此时 phase 已经切走，不会重复加。
     */
    const currentSec = this.state.phase === 'idle' ? 0 : elapsedSeconds(this.state, now);
    if (currentSec > 0) {
      if (this.state.phase === 'study') {
        todayRow.studySec += currentSec;
        weekRow.studySec += currentSec;
      } else if (this.state.phase === 'break') {
        todayRow.breakSec += currentSec;
      }
    }
    const daily = this.#dailyRows(all, addDays(today, -6), today);
    if (currentSec > 0 && this.state.phase === 'study' && daily.length) {
      daily[daily.length - 1].studySec += currentSec;
    }
    return { today: todayRow, week: weekRow, daily };
  }

  /** GET /pomodoro/status —— 先补账，再返回**权威状态**与统计。 */
  async status() {
    // 先记当前专注的增量（用户可能正专注到一半打开页面看统计），再补阶段账
    await this.#creditCurrentStudy();
    await this.#reconcile({ broadcast: true });
    await this.#creditCurrentStudy();
    await this.#pruneTaskIfDeleted({ broadcast: true });
    // 同步可能一次拉来很多历史会话；这里顺手维持 2000 条上限（没超时只是读一遍数组）
    await this.pruneSessions();
    const now = this.#now();
    const core = coreStatus(this.state, now);
    const all = this.sessions.all();
    const aggregate = this.#aggregate(all, now);
    return {
      phase: core.phase,
      running: core.running,
      remainingSec: core.remainingSec,
      totalSec: core.totalSec,
      round: core.round,
      taskId: core.taskId,
      taskTitle: this.#taskTitle(core.taskId),
      startedAt: core.startedAt,
      endsAt: core.endsAt,
      today: aggregate.today,
      week: aggregate.week,
      daily: aggregate.daily,
      config: core.config,
    };
  }

  /**
   * 会话列表：`from`/`to` 是本地日期（含端点），`limit` 默认全量、上限 2000。
   * 按结束时间倒序 —— 账本页面先看最近的。
   */
  async sessionsList({ from, to, limit } = {}) {
    for (const [field, value] of [
      ['from', from],
      ['to', to],
    ]) {
      if (value !== undefined && value !== null && value !== '' && !isDateKey(String(value))) {
        throw HttpError.badRequest(`字段 ${field} 不合法：必须是 YYYY-MM-DD 格式的真实日期`, { field, value: String(value) });
      }
    }
    if (from && to && String(to) < String(from)) {
      throw HttpError.badRequest(`字段 to 不能早于 from：${from} ~ ${to}`, { field: 'to', from, to });
    }
    const size = Math.min(MAX_SESSIONS_LIMIT, Math.max(1, Math.floor(Number(limit) || DEFAULT_SESSIONS_LIMIT)));
    const list = this.sessions
      .all()
      .filter((record) => (!from || dayOf(record) >= from) && (!to || dayOf(record) <= to))
      .sort((a, b) => String(b.endedAt ?? '').localeCompare(String(a.endedAt ?? '')) || String(b.id).localeCompare(String(a.id)))
      .slice(0, size)
      .map(projectSession);
    return { items: list, count: list.length };
  }

  /* ---------------------------------------------------------------- 写操作 */

  #changed(action, extra = {}) {
    this.broadcast?.({
      type: 'data_changed',
      module: 'pomodoro',
      payload: { target: 'pomodoro', action, ...extra },
    });
  }

  async start(input = {}) {
    await this.#creditCurrentStudy();
    await this.#reconcile({ broadcast: true });
    await this.#pruneTaskIfDeleted({ broadcast: true });
    // `taskId` 不传 = 沿用当前关联（用户可以先在界面上选好待办再点开始）；
    // 显式传 null 才是"这次不关联"。
    const hasTask = Object.prototype.hasOwnProperty.call(input, 'taskId');
    const taskId = hasTask ? input.taskId : this.state.taskId;
    this.#requireTask(taskId);
    this.state = startState(this.state, {
      now: this.#now(),
      taskId: taskId ?? null,
      studyMin: input.studyMin,
      breakMin: input.breakMin,
    });
    await this.#saveState();
    this.#changed('start');
    return this.status();
  }

  async pause() {
    await this.#creditCurrentStudy();
    await this.#reconcile({ broadcast: true });
    await this.#creditCurrentStudy();
    this.state = pauseState(this.state, { now: this.#now() });
    await this.#saveState();
    this.#changed('pause');
    return this.status();
  }

  async resume() {
    await this.#creditCurrentStudy();
    await this.#reconcile({ broadcast: true });
    this.state = resumeState(this.state, { now: this.#now() });
    await this.#saveState();
    this.#changed('resume');
    return this.status();
  }

  /** 跳过：把当前阶段按**实际已过时长**记一条（completed:false），马上进入下一阶段。 */
  async skip() {
    await this.#creditCurrentStudy();
    await this.#reconcile({ broadcast: true });
    await this.#creditCurrentStudy();
    const before = this.state;
    const result = finishPhase(before, { now: this.#now(), completed: false });
    this.state = result.state;
    await this.#creditEndedSessions([result.session]);
    await this.#appendSessions([result.session], { broadcast: true });
    await this.#saveState();
    const round = result.session.kind === 'study' && result.session.completed ? before.round + 1 : before.round;
    this.broadcast?.({
      type: 'pomodoro',
      payload: {
        kind: 'phase-end',
        phase: result.session.kind,
        next: result.session.kind === 'study' ? 'break' : 'study',
        taskId: result.session.taskId,
        round,
      },
    });
    return this.status();
  }

  async stop() {
    await this.#creditCurrentStudy();
    await this.#reconcile({ broadcast: true });
    await this.#creditCurrentStudy();
    const result = stopState(this.state, { now: this.#now() });
    if (!result.session) return this.status();
    this.state = result.state;
    await this.#creditEndedSessions([result.session]);
    await this.#appendSessions([result.session], { broadcast: true });
    await this.#saveState();
    this.#changed('stop');
    return this.status();
  }

  async setTask(input = {}) {
    // 换任务前先把已经专注的秒数记到**旧任务**上；否则这段投入会跟着 taskId 一起消失
    await this.#creditCurrentStudy();
    await this.#reconcile({ broadcast: true });
    await this.#creditCurrentStudy();
    this.#requireTask(input.taskId);
    this.state = setTaskState(this.state, { taskId: input.taskId ?? null });
    await this.#saveState();
    this.#changed('set-task', { taskId: this.state.taskId });
    return this.status();
  }

  async updateConfig(input = {}) {
    // 先对一次账：如果正好到点，先按旧配置结算，再改配置，不能把已经发生的阶段改掉
    await this.#creditCurrentStudy();
    await this.#reconcile({ broadcast: true });
    this.state = updateConfigState(this.state, input);
    await this.#saveState();
    this.#changed('config');
    return this.status();
  }

  /* ---------------------------------------------------------------- 给 AI 的只读查询 */

  /**
   * 只读统计（AI 查询 target `pomodoro` 用）。
   *
   * `range` 只有 today / week / all 三档：
   * - today / week 走与 /status 完全相同的聚合函数，数字不会两套口径；
   * - all 是账本全量（2000 条上限内），给"总共学了多久"这种问题。
   */
  async query({ range = 'today' } = {}) {
    if (!['today', 'week', 'all'].includes(range)) {
      throw HttpError.badRequest(`字段 range 不合法：取值必须是 today / week / all 之一`, { field: 'range' });
    }
    const status = await this.status();
    const all = this.sessions.all();
    let studySec = 0;
    let breakSec = 0;
    let sessions = 0;
    let completedSessions = 0;
    let daily = [];
    if (range === 'today') {
      studySec = status.today.studySec;
      breakSec = status.today.breakSec;
      sessions = status.today.sessions;
      daily = status.daily.slice(-1);
    } else if (range === 'week') {
      studySec = status.week.studySec;
      sessions = status.week.sessions;
      const now = this.#now();
      const today = todayKey(now);
      const start = addDays(today, 1 - weekdayOf(today));
      const end = addDays(start, 6);
      breakSec = all
        .filter((record) => record.kind === 'break' && dayOf(record) >= start && dayOf(record) <= end)
        .reduce((sum, record) => sum + (Number(record.actualSec) || 0), 0);
      daily = status.daily;
    } else {
      const days = new Map();
      for (const record of all) {
        const seconds = Number(record.actualSec) || 0;
        if (record.kind === 'study') {
          studySec += seconds;
          sessions += 1;
          if (record.completed) completedSessions += 1;
          const day = dayOf(record);
          const row = days.get(day) ?? { day, studySec: 0, sessions: 0 };
          row.studySec += seconds;
          row.sessions += 1;
          days.set(day, row);
        } else if (record.kind === 'break') {
          breakSec += seconds;
        }
      }
      daily = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
    }
    if (range !== 'all') {
      completedSessions = all.filter((record) => {
        if (record.kind !== 'study' || !record.completed) return false;
        if (range === 'today') return dayOf(record) === todayKey(this.#now());
        const today = todayKey(this.#now());
        const start = addDays(today, 1 - weekdayOf(today));
        return dayOf(record) >= start && dayOf(record) <= addDays(start, 6);
      }).length;
    }
    const current = {
      phase: status.phase,
      running: status.running,
      remainingSec: status.remainingSec,
      round: status.round,
      taskId: status.taskId,
      taskTitle: status.taskTitle,
    };
    return {
      range,
      studySec,
      breakSec,
      focusHours: toHours(studySec),
      sessions,
      completedSessions,
      daily,
      current,
      explain:
        `番茄钟（${range}）：专注 ${studySec} 秒（约 ${toHours(studySec)} 小时）、` +
        `${completedSessions} 个完整番茄、${sessions} 次专注；` +
        `当前 ${status.phase}${status.running ? '（进行中）' : ''}，剩余 ${status.remainingSec} 秒。`,
    };
  }
}
