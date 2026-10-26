/**
 * 成长模块的全部 HTTP 路由。
 *
 * 路径约定：**源项目（Brain Online）的 `/api/xxx` 原样保留**，整体挂在
 * `/api/v1/growth` 之下 ——
 *   /api/state        → /api/v1/growth/state
 *   /api/ai/probe     → /api/v1/growth/ai/probe
 * 这样前端移植时只需要换前缀，不必重记一套命名。
 *
 * 响应外壳与框架一致：普通 JSON 由 `core/http/router.js` 统一加 `{ ok: true, ... }`；
 * 两个“直接下文件”的接口（Markdown 导出、备份导出）返回 `{ __raw }`，
 * 与日历的 ICS 导出走同一条通道。
 *
 * 与源项目的行为差异（都写在模块 README / 交付报告里）：
 * - 不再有 SSE `/api/events`：提醒与数据变更走 WebSocket `data_changed`（module='growth'）；
 * - `POST /system/shutdown` 的 `stop:true` **不会**退出进程（这是 XJTU 主程序的进程，
 *   不能由某个模块擅自 `process.exit`）；
 * - 备份/恢复的 `app` 标记仍是 `brain-online`（兼容旧备份），但 AI key 永不进入成长模块。
 */

import { badRequest, notFound } from './errors.js';
import { dateKey } from './time.js';
import { streakLabel } from './rpg.js';

/** 成长模块自己的集合条数（/system/status 用；不把其它模块的集合混进来）。 */
function dataCounts(store) {
  const out = {};
  for (const name of store.collectionNames.filter((item) => item.startsWith('growth'))) {
    out[name] = store.collection(name).all().length;
  }
  return out;
}

export function registerGrowthRoutes(router, { growth, hub, apiPrefix = '/api/v1' }) {
  const P = `${apiPrefix}/growth`;
  const {
    state,
    tasks,
    templates,
    plan,
    rpg,
    session,
    journal,
    reminders,
    maintenance,
    backup,
    settings,
    ai,
    store,
    clock,
    emit,
  } = growth;

  // ---------------------------------------------------------------- 状态
  router.get(`${P}/state`, async ({ query }) => {
    const date = query?.date ?? dateKey(clock.now());
    return { ok: true, date, entry: await state.get(date) };
  });

  router.get(`${P}/state/recent`, async ({ query }) => {
    const days = Math.min(90, Math.max(1, Number(query?.days) || 14));
    return { ok: true, days, entries: await state.recent(days) };
  });

  router.post(`${P}/state`, async ({ body }) => {
    const entry = await state.upsert(body ?? {});
    await session.log('state', `录入状态 ${entry.date}：就绪度 ${entry.score}`, { date: entry.date, score: entry.score });
    emit('state', { action: 'upsert', date: entry.date, score: entry.score, entry });
    return {
      ok: true,
      entry,
      mode: state.mode(entry.score),
      capacity: state.capacity(entry.score),
      interpretation: state.interpret(entry, entry.score),
    };
  });

  // ---------------------------------------------------------------- 任务
  router.get(`${P}/tasks`, async ({ query }) => {
    const list = await tasks.list({
      date: query?.date,
      status: query?.status,
      from: query?.from,
      to: query?.to,
    });
    return { ok: true, count: list.length, tasks: list };
  });

  router.get(`${P}/tasks/overdue`, async () => {
    const list = await tasks.overdue();
    return { ok: true, count: list.length, tasks: list };
  });

  router.post(`${P}/tasks`, async ({ body }) => {
    let task = await tasks.createManual(body ?? {});
    // 有当天计划就挂上去，否则"今日"页面看不到这条手动任务
    const detail = await plan.get(task.date).catch(() => null);
    if (detail?.plan) {
      task = (await tasks.attachPlan(task.id, detail.plan.id)) ?? task;
      await plan.attachTask(detail.plan.id, task.id);
    }
    await session.log('task', `手动添加任务：${task.title}`, { id: task.id, date: task.date });
    emit('tasks', { action: 'create', id: task.id, date: task.date });
    return { ok: true, task };
  });

  router.patch(`${P}/tasks/:id`, async ({ params, body }) => {
    if (!body?.status) throw badRequest('INVALID_FIELD', '缺少 status');
    const result = await tasks.setStatus(params.id, body.status, { note: body.note });
    await session.log('task', `任务「${result.task.title}」→ ${result.task.status}`, {
      id: result.task.id,
      xp: result.award?.xp ?? 0,
    });
    emit('tasks', { action: 'status', id: params.id, status: body.status });
    return { ok: true, ...result };
  });

  router.delete(`${P}/tasks/:id`, async ({ params }) => {
    const result = await tasks.remove(params.id);
    await session.log('task', `删除任务 ${params.id}`);
    emit('tasks', { action: 'delete', id: params.id });
    return result;
  });

  router.post(`${P}/tasks/:id/postpone`, async ({ params, body }) => {
    const task = await tasks.postpone(params.id, { to: body?.to });
    await session.log('task', `任务「${task.title}」改期到 ${task.date}`, { id: task.id });
    emit('tasks', { action: 'postpone', id: task.id, date: task.date });
    return { ok: true, task };
  });

  // ---------------------------------------------------------------- 模板
  router.get(`${P}/templates`, async () => {
    const { builtin, custom } = await templates.list();
    return {
      ok: true,
      builtinCount: builtin.length,
      customCount: custom.length,
      activeCount: builtin.filter((item) => item.enabled).length + custom.filter((item) => item.enabled).length,
      builtin,
      custom,
    };
  });

  router.post(`${P}/templates`, async ({ body }) => {
    const template = await templates.add(body ?? {});
    await session.log('system', `新增自定义任务模板：${template.title}`, { id: template.id });
    emit('templates', { action: 'create', id: template.id });
    return { ok: true, template };
  });

  router.patch(`${P}/templates/:id`, async ({ params, body }) => {
    if (body?.enabled === undefined) throw badRequest('INVALID_FIELD', '缺少 enabled');
    const result = await templates.setEnabled(params.id, body.enabled);
    emit('templates', { action: 'toggle', id: params.id, enabled: result.enabled });
    return { ok: true, ...result };
  });

  router.post(`${P}/templates/enable-all`, async () => {
    const result = await templates.enableAll();
    emit('templates', { action: 'enable-all' });
    return { ok: true, ...result };
  });

  router.delete(`${P}/templates/:id`, async ({ params }) => {
    const result = await templates.remove(params.id);
    emit('templates', { action: 'delete', id: params.id });
    return result;
  });

  // ---------------------------------------------------------------- 计划
  router.get(`${P}/plan`, async ({ query }) => {
    const date = query?.date ?? dateKey(clock.now());
    const detail = await plan.get(date);
    if (!detail) return { ok: true, date, plan: null, tasks: [], stats: await tasks.stats(date) };
    return { ok: true, date, ...detail };
  });

  router.post(`${P}/plan/generate`, async ({ body }) => {
    const result = await plan.generate({ date: body?.date, force: Boolean(body?.force) });
    if (result.created) {
      await session.log(
        'plan',
        `生成 ${result.plan.date} 的任务表单（${result.tasks.length} 条 / ${result.plan.usedMinutes} 分钟）`,
        { planId: result.plan.id, mode: result.plan.mode },
      );
      emit('plan', { action: 'generate', date: result.plan.date, created: true });
    }
    return { ok: true, ...result };
  });

  router.get(`${P}/plan/history`, async ({ query }) => {
    const plans = await plan.list({ from: query?.from, to: query?.to });
    return { ok: true, count: plans.length, plans };
  });

  // ---------------------------------------------------------------- 今日 / 日记 / 周报 / 导出
  router.get(`${P}/today`, async () => {
    const day = await journal.day(dateKey(clock.now()));
    return { ok: true, ...day };
  });

  router.get(`${P}/journal/day`, async ({ query }) => {
    return { ok: true, ...(await journal.day(query?.date)) };
  });

  router.get(`${P}/journal/trend`, async ({ query }) => {
    const days = Math.min(90, Math.max(2, Number(query?.days) || 14));
    return { ok: true, days, points: await journal.trend(days) };
  });

  router.get(`${P}/journal/weekly`, async ({ query }) => {
    return { ok: true, ...(await journal.weekly({ end: query?.end })) };
  });

  // 直接吐 Markdown 文件（不走 JSON 包装）
  router.get(`${P}/journal/export`, async ({ query }) => {
    const { filename, markdown, from, to, days } = await journal.exportMarkdown({
      date: query?.date,
      from: query?.from,
      to: query?.to,
    });
    return {
      __raw: {
        contentType: 'text/markdown; charset=utf-8',
        headers: {
          'Content-Disposition': `attachment; filename="${filename}"`,
          'X-Export-Days': String(days),
          'X-Export-Range': `${from}..${to}`,
        },
        body: markdown,
      },
    };
  });

  // ---------------------------------------------------------------- 角色
  router.get(`${P}/character`, async () => {
    const character = await rpg.read();
    return {
      ok: true,
      character,
      streakLabel: streakLabel(character.streak),
      nextLevelXp: character.xpForNext,
    };
  });

  router.patch(`${P}/character`, async ({ body }) => {
    const character = await rpg.rename(body?.name);
    await session.log('system', `角色改名为 ${character.name}`);
    emit('character', { action: 'rename', name: character.name });
    return { ok: true, character };
  });

  router.get(`${P}/character/achievements`, async () => {
    return { ok: true, achievements: await rpg.achievements() };
  });

  // ---------------------------------------------------------------- 会话 / 日志 / 存档
  router.get(`${P}/system/status`, async () => {
    const status = await session.status();
    const [character, stats] = await Promise.all([rpg.read(), tasks.stats()]);
    return {
      ok: true,
      ...status,
      character: { name: character.name, level: character.level, streak: character.streak },
      today: stats,
      dataCounts: dataCounts(store),
      clients: hub?.size ?? 0,
    };
  });

  router.post(`${P}/system/boot`, async ({ body }) => {
    const result = await session.boot({ trigger: body?.trigger ?? 'ui' });
    emit('session', { action: 'boot', sessionId: result.session.id });
    return { ok: true, ...result };
  });

  router.post(`${P}/system/shutdown`, async ({ body }) => {
    const result = await session.shutdown({ reason: body?.reason ?? 'manual' });
    emit('session', { action: 'shutdown', ...result });
    // 源项目在 `stop:true` 时会 200ms 后 process.exit(0)。这里是 XJTU 主程序的进程，
    // 一个业务模块无权退出（会连带杀掉其它模块与 Electron 主进程），所以只关会话写存档。
    return result;
  });

  router.post(`${P}/system/snapshot`, async () => {
    return session.snapshotNow();
  });

  router.get(`${P}/sessions`, async ({ query }) => {
    const limit = Math.min(100, Math.max(1, Number(query?.limit) || 20));
    return { ok: true, sessions: await session.listSessions(limit) };
  });

  router.get(`${P}/logs`, async ({ query }) => {
    const limit = Math.min(500, Math.max(1, Number(query?.limit) || 100));
    return { ok: true, logs: await session.listLogs({ limit, type: query?.type }) };
  });

  router.get(`${P}/archives`, async () => {
    return { ok: true, archives: await session.listArchives() };
  });

  router.get(`${P}/archives/:file`, async ({ params }) => {
    const archive = await session.readArchive(params.file);
    if (!archive) throw notFound('ARCHIVE_NOT_FOUND', '找不到这份存档');
    return { ok: true, archive };
  });

  // ---------------------------------------------------------------- 提醒 / 自检
  router.get(`${P}/reminders`, async () => {
    return { ok: true, ...(await reminders.status()) };
  });

  router.post(`${P}/reminders/scan`, async () => {
    return { ok: true, result: await reminders.tick() };
  });

  router.get(`${P}/maintenance`, async () => {
    return { ok: true, report: maintenance.last ?? (await maintenance.check({ repair: false })) };
  });

  router.post(`${P}/maintenance/check`, async ({ body }) => {
    const report = await maintenance.check({ repair: body?.repair !== false });
    if (report.totalFixed) {
      await session.log('system', `数据自检修复了 ${report.totalFixed} 项`, report.fixed);
    }
    emit('maintenance', { action: 'check', totalFixed: report.totalFixed });
    return { ok: true, report };
  });

  // ---------------------------------------------------------------- 备份 / 恢复
  router.get(`${P}/backup`, async ({ query }) => {
    // `?secrets=1` 仍接受（旧前端会传），但成长模块不持有 AI key，导出的 key 恒为空
    const includeSecrets = query?.secrets === '1';
    const bundle = await backup.exportBundle();
    const filename = `brain-online-backup-${bundle.exportedAt.slice(0, 10)}.json`;
    const text = `${JSON.stringify(bundle, null, 2)}\n`;
    await session.log(
      'system',
      `导出备份（${Object.values(bundle.counts).reduce((a, b) => a + b, 0)} 条记录${includeSecrets ? '，成长模块不含密钥' : ''}）`,
    );
    return {
      __raw: {
        contentType: 'application/json; charset=utf-8',
        headers: { 'Content-Disposition': `attachment; filename="${filename}"` },
        body: text,
      },
    };
  });

  router.post(`${P}/restore`, async ({ body }) => {
    const result = await backup.restoreBundle(body);
    await session.log('system', '已从备份恢复数据', { counts: result.counts, snapshotFile: result.snapshotFile });
    emit('restore', { action: 'restore', counts: result.counts });
    return { ok: true, ...result };
  });

  // ---------------------------------------------------------------- 设置
  router.get(`${P}/settings`, async () => {
    return {
      ok: true,
      settings: await settings.read(),
      carryOverModes: settings.modes,
    };
  });

  router.patch(`${P}/settings`, async ({ body }) => {
    const next = await settings.update(body ?? {});
    await session.log('system', '设置已更新', next);
    emit('settings', { action: 'update', settings: next });
    return { ok: true, settings: next };
  });

  // ---------------------------------------------------------------- AI
  router.get(`${P}/ai/status`, async () => {
    return { ok: true, ...(await ai.status()), fallback: true };
  });

  router.post(`${P}/ai/probe`, async () => {
    const result = await ai.probe();
    await session.log('ai', `AI 探测：${result.ok ? '连通' : `失败（${result.error}）`}`);
    return { ok: true, probe: result };
  });

  router.post(`${P}/ai/config`, async ({ body }) => {
    const config = await ai.saveConfig(body ?? {});
    await session.log('ai', `AI 配置更新：${config.baseUrl} / ${config.model}`);
    emit('ai', { action: 'config', config });
    return { ok: true, config };
  });

  router.post(`${P}/ai/briefing`, async ({ body }) => {
    const day = await journal.day(body?.date);
    // 简报要"懂这周"，不能只看今天：把周洞察与逾期情况一起给它，
    // 否则它只会重复"你今天状态不错"这种没用的话。
    const [week, overdue] = await Promise.all([
      journal.weekly({ end: day.date }).catch(() => null),
      tasks.overdue().catch(() => []),
    ]);
    const payload = {
      date: day.date,
      state: day.state,
      mode: day.state?.mode ?? null,
      capacity: day.state?.capacity ?? null,
      tasks: day.tasks.map((task) => ({
        title: task.title,
        kind: task.kind,
        estimateMin: task.estimateMin,
        difficulty: task.difficulty,
        status: task.status,
      })),
      stats: day.stats,
      character: { level: day.character.level, streak: day.character.streak },
      week: week ? { verdict: week.verdict, insights: week.insights, totals: week.totals, modeMix: week.modeMix } : null,
      overdue: overdue.slice(0, 10).map((task) => ({ title: task.title, date: task.date })),
    };
    try {
      const result = await ai.briefing(payload);
      await session.log('ai', `生成作战简报（${result.model}）`, { date: day.date });
      return { ok: true, text: result.content, source: 'ai', model: result.model };
    } catch (err) {
      const text = ai.localBriefing({
        state: day.state,
        plan: day.plan,
        tasks: day.tasks,
        character: day.character,
        overdue,
        insights: week?.insights ?? [],
      });
      await session.log('ai', `AI 简报失败，已降级为本地规则：${err.message}`);
      return { ok: true, text, source: 'local', reason: err.message };
    }
  });

  router.post(`${P}/ai/review`, async ({ body }) => {
    const day = await journal.day(body?.date);
    try {
      const result = await ai.review({
        date: day.date,
        state: day.state,
        stats: day.stats,
        tasks: day.tasks.map((task) => ({
          title: task.title,
          kind: task.kind,
          status: task.status,
          estimateMin: task.estimateMin,
        })),
      });
      await session.log('ai', `生成复盘（${result.model}）`, { date: day.date });
      return { ok: true, text: result.content, source: 'ai', model: result.model };
    } catch (err) {
      const text = ai.localReview({ state: day.state, tasks: day.tasks, stats: day.stats });
      await session.log('ai', `AI 复盘失败，已降级为本地规则：${err.message}`);
      return { ok: true, text, source: 'local', reason: err.message };
    }
  });

  router.post(`${P}/ai/interpret`, async ({ body }) => {
    const date = body?.date;
    const entry = date ? await state.get(date) : await state.latest();
    if (!entry) return { ok: false, error: '还没有状态记录' };
    try {
      const result = await ai.interpret({ entry });
      return { ok: true, text: result.content, source: 'ai', model: result.model };
    } catch (err) {
      return {
        ok: true,
        text: state.interpret(entry, entry.score).join(' '),
        source: 'local',
        reason: err.message,
      };
    }
  });
}
