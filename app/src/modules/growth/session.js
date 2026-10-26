/**
 * 会话与存档模块 —— 负责"开机载入、关机留档"这条主线。
 *
 * 为什么要有会话这个概念：
 * - 开机时如果发现上一次会话没有正常关闭（断电、强制关机、进程被杀），
 *   说明那次"关机存档"可能没做完，这里会把它补记成 `recovered` 并在日志里留痕；
 * - 关机时把当天的状态、计划、任务、角色与本次会话的全部日志写成一个
 *   `archive/<日期>-<会话号>.json` 快照。这不是备份的替代品，
 *   而是"这一天的完整现场"，用来做长期回顾。
 *
 * 为什么和源项目用同一个 `archive/`：
 * 前端文案、旧数据目录与源项目测试都按 `data/archive/` 写；当前全仓没有其它模块
 * 占用这个目录（已检索），保留同名目录能最大化行为等价。若将来有别的模块也要写快照，
 * 应先在框架层约定命名空间，而不是由某个模块单方面改名。
 *
 * 所有函数都不抛出致命错误：存档失败只记一条 error 日志，
 * 绝不阻断关机流程（关机时抛错等于让用户丢数据）。
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';

import { iso, dateKey } from './time.js';
import { collection, doc, writeJsonFile } from './store-utils.js';
import { badRequest } from './errors.js';
import { DEFAULT_CHARACTER } from './rpg.js';

const LOG_LIMIT = 5000;
const ARCHIVE_DIRNAME = 'archive';

export function createSessionService({ store, clock, dataDir }) {
  const sessions = collection(store, 'growthSessions');
  const logs = collection(store, 'growthLogs');
  const archiveDir = path.join(dataDir, ARCHIVE_DIRNAME);
  let current = null;
  let counter = 0;

  async function log(type, message, data = null) {
    counter += 1;
    const doc = {
      at: iso(clock.now()),
      sessionId: current?.id ?? null,
      type,
      message: String(message).slice(0, 500),
      data,
    };
    await logs.insert(doc);
    if (counter % 100 === 0) {
      const all = await logs.all();
      if (all.length > LOG_LIMIT) {
        await logs.replace(all.slice(all.length - LOG_LIMIT));
      }
    }
    return doc;
  }

  async function archiveSession(session, { reason = 'shutdown' } = {}) {
    const day = dateKey(new Date(session.startedAt ?? clock.now()));
    try {
      await fs.mkdir(archiveDir, { recursive: true });
      const [states, plans, tasks, character, sessionLogs] = await Promise.all([
        collection(store, 'growthStates').all(),
        collection(store, 'growthPlans').all(),
        collection(store, 'growthTasks').all(),
        doc(store, 'growthRpg', DEFAULT_CHARACTER).read(),
        logs.find((item) => item.sessionId === session.id),
      ]);
      const snapshot = {
        archivedAt: iso(clock.now()),
        reason,
        date: day,
        session: {
          id: session.id,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          closedBy: session.closedBy ?? reason,
        },
        day: {
          state: states.find((item) => item.date === day) ?? null,
          plan: plans.find((item) => item.date === day) ?? null,
          tasks: tasks.filter((task) => task.date === day),
        },
        character: character ?? null,
        logs: sessionLogs,
        counts: {
          stateEntries: states.length,
          plans: plans.length,
          tasks: tasks.length,
          logs: sessionLogs.length,
        },
      };
      const file = path.join(archiveDir, `${day}-${String(session.id).slice(0, 8)}.json`);
      await writeJsonFile(file, snapshot);
      return { file, snapshot };
    } catch (err) {
      // 存档失败只记一条日志，绝不阻断关机流程。注意这条“记日志”本身也可能失败
      // （测试里 app.close() 之后临时目录立刻被删掉，写盘会 ENOENT）—— 再包一层，
      // 否则 catch 里抛出的错误会冒到 stop 钩子，变成无意义的红字。
      try {
        await log('error', `存档失败：${err.message}`, { sessionId: session.id });
      } catch {
        /* 目录已经没了：没有地方可记，安静返回 null 即可 */
      }
      return null;
    }
  }

  async function closeOpenSessions(reason) {
    const open = await sessions.find((item) => !item.endedAt);
    for (const session of open) {
      const closed = await sessions.patch(session.id, {
        endedAt: iso(clock.now()),
        closedBy: reason,
      });
      await log('system', `补记上一次会话 ${session.id.slice(0, 8)} 的结束（${reason}）`);
      if (session.id !== current?.id) {
        await archiveSession(closed, { reason });
      }
    }
    return open.length;
  }

  const service = {
    /** 开机：补记未关闭的会话、开一条新会话、载入当日上下文。 */
    async boot({ trigger = 'startup' } = {}) {
      if (current) return { session: current, resumed: true, recovered: 0 };

      const recovered = await closeOpenSessions('recovered');

      const today = dateKey(clock.now());
      const session = await sessions.insert({
        startedAt: iso(clock.now()),
        endedAt: null,
        closedBy: null,
        trigger,
        host: process.env.COMPUTERNAME ?? 'local',
        platform: `${process.platform} ${process.arch}`,
      });
      current = session;
      await log('boot', `会话开始（${trigger}）`, { date: today });

      const state = await collection(store, 'growthStates').one((item) => item.date === today);
      const plan = await collection(store, 'growthPlans').one((item) => item.date === today);
      const tasks = plan
        ? await collection(store, 'growthTasks').find((task) => task.planId === plan.id)
        : [];

      return {
        session,
        resumed: false,
        recovered,
        today,
        state,
        plan,
        tasks,
        pending: tasks.filter((task) => task.status === 'todo').length,
      };
    },

    /** 关机/退出：关会话并写当天存档。 */
    async shutdown({ reason = 'shutdown' } = {}) {
      const target = current ?? (await sessions.one((item) => !item.endedAt));
      if (!target) return { ok: true, archived: false, reason: 'no-open-session' };

      await log('shutdown', `会话结束（${reason}），开始写当天存档`);
      const closed = await sessions.patch(target.id, {
        endedAt: iso(clock.now()),
        closedBy: reason,
      });
      const result = await archiveSession(closed, { reason });
      current = null;
      return {
        ok: true,
        archived: Boolean(result),
        file: result?.file ? path.basename(result.file) : null,
        sessionId: closed.id,
        counts: result?.snapshot?.counts ?? null,
      };
    },

    /** 手动存档（不结束会话）。 */
    async snapshotNow() {
      const target = current ?? (await sessions.one((item) => !item.endedAt));
      if (!target) return { ok: false, error: '没有进行中的会话' };
      const result = await archiveSession(target, { reason: 'manual' });
      await log('system', '手动存档完成');
      return {
        ok: Boolean(result),
        file: result?.file ? path.basename(result.file) : null,
        counts: result?.snapshot?.counts ?? null,
      };
    },

    async status() {
      const all = await sessions.all();
      const open = all.find((item) => !item.endedAt) ?? null;
      return {
        session: open,
        sessionCount: all.length,
        logCount: await logs.count(),
        dataDir,
        now: iso(clock.now()),
      };
    },

    async listSessions(limit = 20) {
      const all = await sessions.all();
      return all.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, limit);
    },

    async listLogs({ limit = 100, type } = {}) {
      const all = await logs.all();
      const filtered = type ? all.filter((item) => item.type === type) : all;
      return filtered.slice(Math.max(0, filtered.length - limit)).reverse();
    },

    async listArchives() {
      try {
        const files = await fs.readdir(archiveDir);
        const out = [];
        for (const name of files.filter((file) => file.endsWith('.json')).sort().reverse()) {
          const file = path.join(archiveDir, name);
          try {
            const raw = JSON.parse(await fs.readFile(file, 'utf8'));
            out.push({
              file: name,
              date: raw.date,
              archivedAt: raw.archivedAt,
              reason: raw.reason,
              counts: raw.counts,
            });
          } catch {
            out.push({ file: name, date: null, broken: true });
          }
        }
        return out;
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
    },

    /** 读一份存档原文。文件名必须来自存档目录清单，不接受路径。 */
    async readArchive(name) {
      const safe = String(name);
      if (!/^[0-9A-Za-z._-]+\.json$/.test(safe) || safe.includes('..')) {
        throw badRequest('INVALID_FIELD', '存档文件名不合法');
      }
      const file = path.join(archiveDir, safe);
      try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },

    get currentSession() {
      return current;
    },

    get archiveDir() {
      return archiveDir;
    },

    log,
    archiveSession,
  };

  return service;
}

export { ARCHIVE_DIRNAME, LOG_LIMIT };
