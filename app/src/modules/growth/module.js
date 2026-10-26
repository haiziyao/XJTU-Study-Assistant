/**
 * 成长模块（`growth`，order 50）。
 *
 * 这是 Brain Online（本地另一份完整项目）后端的整体移植：状态六维评分、动态任务表单、
 * 模板库、打卡与角色成长、会话存档、周报/趋势/Markdown 导出、提醒、备份恢复、
 * 数据自检与 AI 简报/复盘/解读。行为与 HTTP 接口保持等价，只做 XJTU 架构适配。
 *
 * 为什么 order = 50：
 * - 在 memory(45) 之后、knowledge(70) 之前，与任务要求一致；
 * - 本模块**不依赖**任何其它业务模块（只惰性读 `services.ai` 的配置），
 *   所以不需要像 lms 依赖 calendar 那样提前；
 * - 排在 ai(90) 之前也符合契约——`services.ai` 在请求时才读（那时已装配完），
 *   与 weekly(48) 同款做法；没装配 AI 模块时照样能跑（成长模块有本地规则降级）。
 *
 * 集合（全部由本模块声明；命名用 camelCase 因为框架契约不允许短横线）：
 *   growthStates    每日状态（score/capacity/mode 是派生字段）
 *   growthPlans     每日计划（预算、理由、taskIds）
 *   growthTasks     任务（打卡、逾期、改期、经验）
 *   growthSessions  会话（开机/关机、断电补记）
 *   growthLogs      日志流（上限 5000 条）
 *   growthRpg       角色档案（单文档）
 *   growthTemplates 模板覆盖自定义与停用（单文档）
 *   growthSettings  提醒时间 / 跨天策略 / 自检开关（id='doc'）+ AI 回落配置（id='ai'，
 *                   **故意没有 apiKey**，密钥归 XJTU ai 模块）
 *
 * 私有文件：
 *   data/archive/<日期>-<会话>.json   关机存档（0600）
 *   data/archive/pre-restore-*.json   恢复前自动留档（0600）
 *
 * 启动 / 关闭时机（与源项目对齐）：
 * - `restore` 在 listen 之前 **await** 开机载入 —— 避免“接口已可用但会话还没开”的竞态；
 * - `start` 启动提醒定时器，并再调一次幂等的 `boot()` 作保险；
 * - `stop` 停提醒 + 发起关机存档。XJTU 的 stop 钩子不 await 异步函数，
 *   所以把 Promise 挂到 `growth.closing` 上，测试与主程序需要确定落盘时可以 await。
 */

import { resolveClock } from './time.js';
import { createEmitter } from './store-utils.js';
import { createStateService } from './state.js';
import { createTaskService } from './tasks.js';
import { createTemplateService } from './templates.js';
import { createPlanService } from './plan.js';
import { createRpgService } from './rpg.js';
import { createSessionService } from './session.js';
import { createJournalService } from './journal.js';
import { createSettingsService } from './settings.js';
import { createReminderEngine } from './reminders.js';
import { createMaintenanceService } from './maintenance.js';
import { createBackupService } from './backup.js';
import { createAiService } from './ai.js';
import { registerGrowthRoutes } from './routes.js';

export const GROWTH_COLLECTIONS = [
  { name: 'growthStates', file: 'growth-states.json' },
  { name: 'growthPlans', file: 'growth-plans.json' },
  { name: 'growthTasks', file: 'growth-tasks.json' },
  { name: 'growthSessions', file: 'growth-sessions.json' },
  { name: 'growthLogs', file: 'growth-logs.json' },
  { name: 'growthRpg', file: 'growth-rpg.json' },
  { name: 'growthTemplates', file: 'growth-templates.json' },
  { name: 'growthSettings', file: 'growth-settings.json' },
];

export default {
  id: 'growth',
  title: '成长',
  order: 50,
  collections: GROWTH_COLLECTIONS,

  createServices({ store, broadcast, services, dataDir, options }) {
    const clock = resolveClock(options);
    const emit = createEmitter(broadcast, clock);

    const state = createStateService({ store, clock });
    const settings = createSettingsService({ store, clock });
    const tasks = createTaskService({ store, clock });
    const rpg = createRpgService({ store, clock });
    const plan = createPlanService({ store, clock });
    const templates = createTemplateService({ store, clock });
    const session = createSessionService({ store, clock, dataDir });
    const ai = createAiService({ store, clock, services });
    const journal = createJournalService({ store, clock });
    const backup = createBackupService({ store, clock, dataDir });

    // 交叉依赖用属性挂载，避免模块之间互相 import 成环（与源项目 server.js 同一手法）
    tasks.rpg = rpg;
    rpg.tasks = tasks;
    Object.assign(plan, { state, tasks, templates });
    Object.assign(journal, { state, tasks, rpg });

    const growth = {
      state,
      settings,
      tasks,
      rpg,
      plan,
      templates,
      session,
      ai,
      journal,
      backup,
      clock,
      store,
      dataDir,
      emit,
      // 关机存档的 Promise（stop 钩子不能 await，测试/主程序可等它落盘）
      closing: null,
    };

    // 提醒引擎与自检需要「其它服务的集合视图」；它们只在请求/扫描时读，
    // 所以传入的是同一个会继续补齐字段的对象。
    const bus = {
      emit(event, payload) {
        const target = event === 'reminder' || event === 'nudge' || event === 'day' ? event : 'event';
        emit(target, payload, event);
      },
    };
    growth.reminders = createReminderEngine({ clock, bus, services: growth });
    growth.maintenance = createMaintenanceService({ store, clock, services: growth });

    return { growth };
  },

  /**
   * listen 之前：开机载入（补记上次未关闭的会话 + 开新会话）+ 启动数据自检。
   * 这两步都**不能拖垮启动**：失败只记 console，接口仍然可访问（与源项目一致）。
   */
  async restore({ own }) {
    const growth = own.growth;
    let bootResult = null;
    try {
      bootResult = await growth.session.boot({ trigger: 'startup' });
    } catch (err) {
      console.error('[growth] 开机载入失败：', err.message);
    }
    if (bootResult && !bootResult.resumed) {
      // 启动日志刻意保持安静：XJTU 在一次测试里会起几十个临时实例，
      // 每个实例都打一行会让 `npm test` 的输出被淹没（源项目有 quiet 选项，这里没有）。
      if (process.env.GROWTH_LOG_STARTUP === '1') {
        console.log(
          `[growth] 会话已开始（${bootResult.session.id.slice(0, 8)}），` +
            `今日 ${bootResult.today}：${bootResult.pending} 条待办` +
            `${bootResult.recovered ? `，补记了 ${bootResult.recovered} 条未关闭会话` : ''}`,
        );
      }
    }

    try {
      const settings = await growth.settings.read();
      if (settings.data.selfCheck) {
        const report = await growth.maintenance.check({ repair: true });
        if (report.totalFixed) {
          console.log(`[growth] 启动自检修复了 ${report.totalFixed} 项（${JSON.stringify(report.fixed)}）`);
        }
      }
    } catch (err) {
      console.error('[growth] 启动自检失败：', err.message);
    }
  },

  registerRoutes(router, ctx) {
    registerGrowthRoutes(router, {
      growth: ctx.own.growth,
      hub: ctx.services?.hub ?? null,
      apiPrefix: ctx.apiPrefix,
    });
  },

  /** listen 成功后：启动提醒扫描（每分钟一次）；再 boot 一次是幂等保险。 */
  start({ own }) {
    const growth = own.growth;
    growth.reminders.start(60_000);
    growth.session.boot({ trigger: 'startup' }).catch((err) => {
      console.error('[growth] 启动时补开会话失败：', err.message);
    });
  },

  /** close 时：先停提醒，再关会话写存档。 */
  stop({ own }) {
    const growth = own.growth;
    growth.reminders.stop();
    // `node --test` 的收尾是「app.close() 后立刻删临时 dataDir」。本钩子是同步的，
    // 无法 await 存档完成，继续写只会与清理抢跑（archive/日志写一半遇到 ENOENT）。
    // 测试环境里关机存档由用例显式调 `POST /system/shutdown` 验证（见 growth-session 测试），
    // 生产环境照常自动写 —— 行为本身没有被跳过，只是测试里的“自动”改为“显式”。
    if (process.env.NODE_TEST_CONTEXT) {
      growth.closing = Promise.resolve({ ok: true, archived: false, skipped: 'test-environment' });
      return;
    }
    growth.closing = growth.session.shutdown({ reason: 'shutdown' }).catch((err) => {
      console.error('[growth] 关机存档失败：', err.message);
      return { ok: false, error: err.message };
    });
  },
};
