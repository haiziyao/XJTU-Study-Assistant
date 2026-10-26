/**
 * 成长视图（左栏「成长」，order 50）。
 *
 * 来源：Brain Online 的个人成长经营系统（`src/web/app.js` / `app.css` / `index.html`）。
 * 移植时保留它的数据口径与交互，不重新发明：
 *   - 今日：状态读数（六维 + 睡眠）→ 任务表单（生成 / 重排 / 打卡 / 跳过 / 改期）→ 会话存档；
 *   - 角色：等级 / 经验 / 五维属性 / 成就；
 *   - 周报：近 14 天趋势 + 本周账 + Markdown 导出；
 *   - 设置：提醒与跨天、AI 接入与连通测试、任务模板、备份与恢复、数据自检。
 *
 * 与其它视图相同的三条约定：
 *   1. 内容放进 `.view-content`（`.panel-body` 不滚动、没有内边距）；
 *   2. 所有文本走 textContent / `mk()`，**不写 inline style**（CSP 的 `style-src 'self'` 会拦）；
 *      只有 JS 动态设置 `element.style.width/height` 这类布局量（仓库里已有先例），
 *      颜色、边框、层级全部落在 `growth.css` 的 class 上；
 *   3. 请求失败只落在页面内的 errorBox + `PC.toast`，不 `alert()`，也不让整页白屏。
 *
 * 后端由 `growth` 模块提供，HTTP 挂在 `/api/v1/growth/*`，路径与 Brain Online 的 `/api/*` 一一对应。
 * 模块尚未装配时，第一个探活请求（`GET /growth/state`）会 404 —— 页面显示「成长模块未启用」。
 */

(function () {
  'use strict';

  const TABS = [
    { id: 'today', label: '今日' },
    { id: 'character', label: '角色' },
    { id: 'week', label: '周报' },
    { id: 'settings', label: '设置' },
  ];

  const KIND_LABEL = { focus: '深度', mind: '认知', body: '身体', life: '生活', recover: '恢复' };
  const MODE_LABEL = { push: '推进', steady: '稳态', recover: '修复' };
  const MODE_HINT = {
    push: '状态在线，今天适合啃硬骨头',
    steady: '按常规节奏推进，不用加码',
    recover: '先修复，别硬撑',
  };
  const ATTR_LABEL = { focus: '专注', wisdom: '认知', vitality: '体魄', discipline: '秩序', resilience: '韧性' };

  const ui = {
    mount: null,
    tab: 'today',
    loading: false,
    loadedOnce: false,
    unavailable: false,
    error: null,
    actionError: null,
    booted: false,
    busy: false,

    today: null,
    probeEntry: null,
    character: null,
    streakLabel: '',
    overview: null,
    ai: null,
    trend: [],
    week: null,
    templates: null,
    settings: null,
    settingsModes: null,
    maintenance: null,
    allTasks: [],
    allTasksLoaded: false,
    overdue: [],
    logs: [],
    archives: [],
    achievements: null,
    achievementsLoading: false,
    achievementsError: null,

    taskFilter: 'today',
    taskManagerOpen: false,
    stateForm: null,
    renaming: false,
    briefings: {},
    reviews: {},
    errors: {},
    shutdown: false,
  };

  let loadSeq = 0;

  /* ------------------------------------------------------------ 基础工具 */

  const pad2 = (value) => String(value).padStart(2, '0');

  function num(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function clampPercent(value) {
    return Math.max(0, Math.min(100, num(value)));
  }

  function scoreClass(score) {
    const value = num(score);
    if (value >= 70) return 'is-good';
    if (value >= 45) return 'is-mid';
    return 'is-low';
  }

  function modeLabel(mode) {
    return MODE_LABEL[mode] ?? String(mode ?? '');
  }

  function kindLabel(kind) {
    return KIND_LABEL[kind] ?? String(kind ?? '');
  }

  function attrLabel(key) {
    return ATTR_LABEL[key] ?? String(key ?? '');
  }

  function weekdayOf(dateKey) {
    if (!dateKey) return '';
    try {
      const cn = window.PCUtil?.weekdayCN?.(dateKey);
      if (cn) return cn;
    } catch {
      /* 退回到手算 */
    }
    const [y, m, d] = String(dateKey).split('-').map(Number);
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return names[new Date(y, m - 1, d).getDay()] ?? '';
  }

  function shiftDate(dateKey, delta) {
    const [y, m, d] = String(dateKey).split('-').map(Number);
    const date = new Date(y, (m ?? 1) - 1, d ?? 1);
    date.setDate(date.getDate() + num(delta));
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function timeOf(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value).slice(11, 16);
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  function notify(title, message) {
    const text = message ? `${title} · ${message}` : title;
    try {
      window.PC?.toast?.(text);
    } catch {
      /* toast 不是核心功能 */
    }
  }

  function confirmAction(message) {
    if (typeof window.confirm !== 'function') {
      notify('无法确认', '这个窗口不支持确认对话框');
      return false;
    }
    try {
      return Boolean(window.confirm(message));
    } catch {
      return false;
    }
  }

  /** 404 = 后端还没有 growth 模块（或这个版本没装）。 */
  function isMissingModule(error) {
    if (!error) return false;
    if (Number(error.status) === 404) return true;
    if (error.code === 'NOT_FOUND') return true;
    if (error.payload?.error?.code === 'NOT_FOUND') return true;
    return /成长模块未启用|not found|404/i.test(String(error.message ?? ''));
  }

  function apiBase() {
    const value = window.PC?.state?.apiBase;
    if (typeof value === 'string' && value) return value.replace(/\/+$/, '');
    return '/api/v1';
  }

  function growthUrl(path) {
    return `${apiBase()}/growth${path}`;
  }

  function isNarrow() {
    try {
      return Boolean(window.matchMedia?.('(max-width: 900px)')?.matches);
    } catch {
      return false;
    }
  }

  function mkButton(label, className, onClick) {
    const node = mk('button', className, label);
    node.type = 'button';
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }

  function downloadFile(label, path, fallbackName, className = 'growth-btn is-ghost') {
    return mkButton(label, className, () =>
      run(async () => {
        try {
          // 下载走 fetch + Blob（与日历导出 ICS 同一条路）：Electron 的页面是 file://，
          // 直接给 http 链接加 download 在部分宿主里会被忽略或另开外部浏览器。
          const response = await fetch(`${apiBase()}/growth${path}`);
          if (!response.ok) throw new Error(`导出失败（${response.status}）`);
          const disposition = response.headers?.get?.('content-disposition') ?? '';
          const matched = /filename="?([^";]+)"?/i.exec(disposition);
          const filename = matched?.[1] ?? fallbackName;
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = filename;
          document.body.appendChild(link);
          link.click();
          link.remove?.();
          URL.revokeObjectURL(url);
          notify('已导出', filename);
        } catch (error) {
          handleActionError(error);
        }
      }),
    );
  }

  function svgEl(tag, attrs = {}, text) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /** 动态布局量：只碰 width/height，颜色与其它视觉全部交给 CSS class。 */
  function setWidth(node, percent) {
    if (!node) return;
    node.style.width = `${clampPercent(percent)}%`;
  }

  function setHeight(node, percent) {
    if (!node) return;
    node.style.height = `${clampPercent(percent)}%`;
  }

  function readControl(fields, name) {
    const item = fields?.[name];
    if (item && typeof item === 'object' && typeof item.tagName === 'string') return item.value;
    return item;
  }

  function readNumber(fields, name, fallback = 0) {
    const value = Number(readControl(fields, name));
    return Number.isFinite(value) ? value : fallback;
  }

  function readChecked(fields, name) {
    const item = fields?.[name];
    if (item && typeof item === 'object' && 'checked' in item) return Boolean(item.checked);
    return Boolean(item);
  }

  function groupSection(title, id) {
    const node = mk('section', `growth-group growth-group-${id}`);
    node.appendChild(mk('h3', 'growth-group-title', title));
    return node;
  }

  /** 卡片骨架：返回 node（要 append 的东西都放 node 里）与右上角 actions。 */
  function card(title, sub) {
    const node = mk('section', 'growth-card');
    const head = mk('div', 'growth-card-head');
    const titles = mk('div', 'growth-card-titles');
    titles.appendChild(mk('h3', 'growth-card-title', title));
    if (sub) titles.appendChild(mk('p', 'growth-card-sub', sub));
    const actions = mk('div', 'growth-card-actions');
    head.append(titles, actions);
    node.appendChild(head);
    return { node, head, actions };
  }

  function tag(text, className = '') {
    return mk('span', `growth-tag${className ? ` ${className}` : ''}`, text);
  }

  function showErrorBox(error) {
    if (typeof errorBox === 'function') return errorBox(error);
    const box = mk('div', 'error-box');
    box.append(mk('div', 'eb-title', '加载失败'), mk('div', 'eb-msg', error?.message ?? '未知错误'));
    return box;
  }

  function actionErrorBox(error) {
    const box = mk('div', 'error-box growth-action-error');
    box.append(mk('div', 'eb-title', '操作失败'), mk('div', 'eb-msg', error?.message ?? '未知错误'));
    return box;
  }

  function run(task) {
    Promise.resolve()
      .then(task)
      .catch(handleActionError);
  }

  function handleActionError(error, { missingDisables = false } = {}) {
    const failure = rowError(error);
    // 页面已经正常加载过之后，单个可选接口 404 只说明"这个子功能没装"，
    // 不能把整页切成「未启用」；首屏探活失败，或核心写接口（POST /growth/state）
    // 404 才说明模块没装配好。
    if (isMissingModule(failure) && (!ui.loadedOnce || missingDisables)) {
      ui.unavailable = true;
      paint();
      return;
    }
    ui.actionError = failure;
    notify('操作失败', failure.message ?? '未知错误');
    paint();
  }

  /* ------------------------------------------------------------ 数据加载 */

  function rowError(error) {
    if (error instanceof Error) return error;
    const wrapped = new Error(error?.message ?? String(error ?? '未知错误'));
    if (error?.status !== undefined) wrapped.status = error.status;
    if (error?.payload !== undefined) wrapped.payload = error.payload;
    return wrapped;
  }

  async function loadCore(seq) {
    const specs = [
      ['today', '/growth/today'],
      ['overdue', '/growth/tasks/overdue'],
      ['character', '/growth/character'],
      ['overview', '/growth/system/status'],
    ];
    const results = await Promise.allSettled(specs.map(([, path]) => PC.api(path)));
    if (seq !== loadSeq) return;

    const failures = [];
    results.forEach((result, index) => {
      const key = specs[index][0];
      if (result.status === 'fulfilled') {
        const value = result.value ?? {};
        if (key === 'today') ui.today = value;
        if (key === 'overdue') ui.overdue = Array.isArray(value.tasks) ? value.tasks : [];
        if (key === 'character') {
          ui.character = value.character ?? null;
          ui.streakLabel = value.streakLabel ?? '';
        }
        if (key === 'overview') ui.overview = value;
      } else {
        const error = rowError(result.reason);
        ui.errors[key] = error;
        failures.push([key, error]);
      }
    });

    // 今日快照是整页的核心；它失败时页面没有可画的东西，直接交给外层显示错误。
    const fatal = failures.find(([key]) => key === 'today');
    if (fatal) throw fatal[1];

    if (!ui.character && ui.overview?.character) {
      ui.character = { ...ui.overview.character, attrs: {}, counters: {} };
    }
  }

  async function loadLogsArchives() {
    const [logs, archives] = await Promise.allSettled([
      PC.api('/growth/logs?limit=200'),
      PC.api('/growth/archives'),
    ]);
    if (logs.status === 'fulfilled') {
      ui.logs = Array.isArray(logs.value?.logs) ? logs.value.logs : [];
      delete ui.errors.logs;
    } else {
      ui.errors.logs = rowError(logs.reason);
    }
    if (archives.status === 'fulfilled') {
      ui.archives = Array.isArray(archives.value?.archives) ? archives.value.archives : [];
      delete ui.errors.archives;
    } else {
      ui.errors.archives = rowError(archives.reason);
    }
  }

  async function loadTrendData() {
    try {
      const value = await PC.api('/growth/journal/trend?days=14');
      ui.trend = Array.isArray(value?.points) ? value.points : [];
      delete ui.errors.trend;
    } catch (error) {
      ui.errors.trend = rowError(error);
    }
  }

  async function loadWeekData() {
    try {
      const value = await PC.api('/growth/journal/weekly');
      ui.week = value && typeof value === 'object' ? value : null;
      delete ui.errors.week;
    } catch (error) {
      ui.week = null;
      ui.errors.week = rowError(error);
    }
  }

  async function loadSettingsData() {
    try {
      const value = await PC.api('/growth/settings');
      ui.settings = value?.settings ?? null;
      ui.settingsModes = value?.carryOverModes ?? null;
      delete ui.errors.settings;
    } catch (error) {
      ui.errors.settings = rowError(error);
    }
  }

  async function loadTemplates() {
    try {
      const value = await PC.api('/growth/templates');
      ui.templates = value && typeof value === 'object' ? value : null;
      delete ui.errors.templates;
    } catch (error) {
      ui.errors.templates = rowError(error);
    }
  }

  async function loadMaintenanceData() {
    try {
      const value = await PC.api('/growth/maintenance');
      ui.maintenance = value?.report ?? null;
      delete ui.errors.maintenance;
    } catch (error) {
      ui.errors.maintenance = rowError(error);
    }
  }

  async function loadAiData() {
    try {
      const value = await PC.api('/growth/ai/status');
      ui.ai = value && typeof value === 'object' ? value : null;
      delete ui.errors.ai;
    } catch (error) {
      ui.errors.ai = rowError(error);
    }
  }

  async function loadAchievements(seq) {
    if (ui.achievementsLoading) return;
    ui.achievementsLoading = true;
    ui.achievementsError = null;
    try {
      const value = await PC.api('/growth/character/achievements');
      if (seq === loadSeq) ui.achievements = Array.isArray(value?.achievements) ? value.achievements : [];
    } catch (error) {
      if (seq === loadSeq) ui.achievementsError = rowError(error);
    } finally {
      ui.achievementsLoading = false;
      if (seq === loadSeq) paint();
    }
  }

  async function loadTab(tab, seq) {
    if (tab === 'today') {
      await loadLogsArchives();
      return;
    }
    if (tab === 'character') {
      if (!ui.character) {
        try {
          const value = await PC.api('/growth/character');
          if (seq === loadSeq) {
            ui.character = value?.character ?? null;
            ui.streakLabel = value?.streakLabel ?? '';
            delete ui.errors.character;
          }
        } catch (error) {
          if (seq === loadSeq) ui.errors.character = rowError(error);
        }
      }
      await loadAchievements(seq);
      return;
    }
    if (tab === 'week') {
      await Promise.all([loadTrendData(), loadWeekData()]);
      return;
    }
    if (tab === 'settings') {
      await Promise.all([loadSettingsData(), loadTemplates(), loadMaintenanceData(), loadAiData()]);
    }
  }

  async function ensureBoot() {
    if (ui.booted) return;
    ui.booted = true;
    try {
      // 与源项目一致：进入成长模块时开一次会话；后端已有进行中的会话会直接返回 resume。
      await PC.api('/growth/system/boot', { method: 'POST', body: { trigger: 'ui' } });
      delete ui.errors.boot;
    } catch (error) {
      // 会话不是读数/任务的硬依赖：记进 errors，由存档卡片显示，不阻断整页。
      ui.errors.boot = rowError(error);
    }
  }

  async function reload() {
    const seq = ++loadSeq;
    const wasUnavailable = ui.unavailable;
    ui.loading = true;
    ui.unavailable = false;
    ui.error = null;
    ui.actionError = null;
    ui.errors = {};
    if (!ui.loadedOnce || wasUnavailable) paint();

    try {
      // 探活：模块没装配时这个端点回 404，用它来区分「模块未启用」与普通网络错误。
      const probe = await PC.api('/growth/state');
      if (seq !== loadSeq) return;
      ui.unavailable = false;
      ui.probeEntry = probe?.entry ?? null;

      await ensureBoot();
      if (seq !== loadSeq) return;

      await loadCore(seq);
      if (seq !== loadSeq) return;

      // 用户打开过「全部」之后，任务管理里的那份列表也要跟着任何一次刷新更新，
      // 否则在全部筛选下打卡会看到旧状态（源项目在任务页同样会刷新全量列表）。
      if (ui.allTasksLoaded) await loadAllTasks();
      if (seq !== loadSeq) return;

      await loadTab(ui.tab, seq);
      if (seq !== loadSeq) return;

      ui.loadedOnce = true;
      ui.loading = false;
      paint();
    } catch (error) {
      if (seq !== loadSeq) return;
      ui.loading = false;
      if (isMissingModule(error)) {
        ui.unavailable = true;
        ui.error = null;
      } else {
        ui.error = rowError(error);
        notify('载入失败', ui.error.message);
      }
      paint();
    }
  }

  /* ------------------------------------------------------------ 交互动作 */

  function currentEntry() {
    return ui.today?.state ?? ui.probeEntry ?? null;
  }

  function currentDate() {
    return String(ui.today?.date ?? window.PCUtil?.todayKey?.() ?? '');
  }

  async function saveState(fields) {
    const body = {
      sleepHours: readNumber(fields, 'sleepHours', 7.5),
      sleepQuality: readNumber(fields, 'sleepQuality', 3),
      energy: readNumber(fields, 'energy', 3),
      mood: readNumber(fields, 'mood', 3),
      stress: readNumber(fields, 'stress', 3),
      focus: readNumber(fields, 'focus', 3),
      body: readNumber(fields, 'body', 3),
      note: String(readControl(fields, 'note') ?? ''),
    };
    try {
      const result = await PC.api('/growth/state', { method: 'POST', body });
      const entry = result?.entry ?? null;
      notify('状态已保存', `就绪度 ${num(entry?.score)} · ${modeLabel(entry?.mode)}模式`);
      if (!ui.today?.plan) {
        try {
          await PC.api('/growth/plan/generate', { method: 'POST', body: {} });
          notify('已顺手排好今日任务', '按刚录入的状态生成');
        } catch {
          // 排表单失败不影响状态已保存的结论（源项目同样忽略这一步）。
        }
      }
      if (entry) ui.probeEntry = entry;
      await reload();
    } catch (error) {
      handleActionError(error, { missingDisables: true });
    }
  }

  async function generatePlan(force) {
    if (force && !confirmAction('重排会清掉今天「还没开始」的自动任务；已完成的、手动加的都会保留。继续？')) return;
    try {
      const result = await PC.api('/growth/plan/generate', { method: 'POST', body: force ? { force: true } : {} });
      if (force) {
        notify('已重排', `${Array.isArray(result?.tasks) ? result.tasks.length : 0} 条任务，预算 ${num(result?.plan?.usedMinutes)} 分钟`);
      } else {
        notify('任务表单已生成', '按今天的状态排好了');
      }
      await reload();
    } catch (error) {
      handleActionError(error);
    }
  }

  async function toggleTask(task) {
    if (!task?.id) return;
    const next = task.status === 'done' ? 'todo' : 'done';
    try {
      const result = await PC.api(`/growth/tasks/${encodeURIComponent(task.id)}`, {
        method: 'PATCH',
        body: { status: next },
      });
      if (next === 'done') {
        const award = result?.award;
        if (award?.leveledUp) notify('升级了', `Lv.${num(award.prevLevel, 1)} → Lv.${num(award.level, 1)}`);
        else if (award?.xp) {
          notify(`+${num(award.xp)} XP`, award.attrGain ? `${attrLabel(award.attr)} +${num(award.attrGain)}` : '');
        }
        for (const achievement of award?.newAchievements ?? []) {
          notify('解锁成就', `${achievement.name} · ${achievement.desc}`);
        }
      }
      await reload();
    } catch (error) {
      handleActionError(error);
    }
  }

  async function skipTask(task) {
    if (!task?.id) return;
    try {
      await PC.api(`/growth/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: { status: 'skipped' } });
      await reload();
    } catch (error) {
      handleActionError(error);
    }
  }

  async function postponeTask(task) {
    if (!task?.id) return;
    try {
      const result = await PC.api(`/growth/tasks/${encodeURIComponent(task.id)}/postpone`, {
        method: 'POST',
        body: {},
      });
      const moved = result?.task;
      notify('已改期', `${moved?.title ?? task.title} → ${moved?.date ?? ''}`);
      await reload();
    } catch (error) {
      handleActionError(error);
    }
  }

  async function loadAllTasks() {
    try {
      const value = await PC.api('/growth/tasks');
      ui.allTasks = Array.isArray(value?.tasks) ? value.tasks : [];
      ui.allTasksLoaded = true;
      delete ui.errors.allTasks;
    } catch (error) {
      ui.errors.allTasks = rowError(error);
    }
  }

  async function selectTaskFilter(filter) {
    ui.taskFilter = filter;
    ui.taskManagerOpen = true;
    if (filter === 'all' && !ui.allTasksLoaded) await loadAllTasks();
    paint();
  }

  async function addManualTask(fields) {
    const title = String(readControl(fields, 'title') ?? '').trim();
    if (!title) {
      notify('请先填写任务标题');
      return;
    }
    const body = {
      title,
      kind: String(readControl(fields, 'kind') ?? 'life'),
      estimateMin: readNumber(fields, 'estimateMin', 25),
      difficulty: readNumber(fields, 'difficulty', 2),
    };
    try {
      const result = await PC.api('/growth/tasks', { method: 'POST', body });
      notify('已添加', result?.task?.title ?? title);
      await reload();
    } catch (error) {
      handleActionError(error);
    }
  }

  async function refreshBriefing(kind) {
    if (ui.busy) return;
    ui.busy = true;
    paint();
    try {
      const path = kind === 'review' ? '/growth/ai/review' : '/growth/ai/briefing';
      const result = await PC.api(path, { method: 'POST', body: {} });
      const date = currentDate();
      if (kind === 'review') ui.reviews[date] = result;
      else ui.briefings[date] = result;
      notify(kind === 'review' ? '复盘完成' : '简报已生成', result?.source === 'ai' ? '来自模型' : '来自本地规则');
      await reload();
    } catch (error) {
      handleActionError(error);
    } finally {
      ui.busy = false;
      paint();
    }
  }

  async function snapshotNow() {
    try {
      const result = await PC.api('/growth/system/snapshot', { method: 'POST', body: {} });
      if (result?.ok === false) notify('存档失败', result?.file ?? result?.error ?? '');
      else notify('已存档', result?.file ?? '');
      await reload();
    } catch (error) {
      handleActionError(error);
    }
  }

  async function shutdownSession() {
    if (!confirmAction('结束成长模块的当前会话并写一份当天存档？这不会退出整个程序。')) return;
    try {
      const result = await PC.api('/growth/system/shutdown', { method: 'POST', body: { reason: 'ui' } });
      if (result?.ok === false) throw new Error(result?.error ?? '结束会话失败');
      ui.shutdown = true;
      notify('会话已结束', '存档已写入');
      await reload();
    } catch (error) {
      handleActionError(error);
    }
  }

  async function renameCharacter(name) {
    const clean = String(name ?? '').trim();
    if (!clean) {
      notify('角色名不能为空');
      return;
    }
    try {
      const result = await PC.api('/growth/character', { method: 'PATCH', body: { name: clean } });
      if (result?.character) ui.character = result.character;
      ui.renaming = false;
      notify('已改名', clean);
      await reload();
    } catch (error) {
      handleActionError(error);
    }
  }

  async function requestNotifications() {
    if (!('Notification' in window)) {
      notify('不支持', '这个窗口没有通知能力');
      return;
    }
    try {
      const permission = await window.Notification.requestPermission();
      notify('通知权限', permission === 'granted' ? '已允许' : '未允许');
    } catch (error) {
      handleActionError(error);
    }
  }

  async function toggleTemplate(item, enabled) {
    if (!item?.id) return;
    try {
      await PC.api(`/growth/templates/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: { enabled } });
      await loadTemplates();
      paint();
    } catch (error) {
      handleActionError(error);
    }
  }

  async function deleteTemplate(item) {
    if (!item?.id) return;
    if (!confirmAction('删除这条自定义模板？已经生成的任务不受影响。')) return;
    try {
      await PC.api(`/growth/templates/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      await loadTemplates();
      paint();
    } catch (error) {
      handleActionError(error);
    }
  }

  async function enableAllTemplates() {
    try {
      await PC.api('/growth/templates/enable-all', { method: 'POST', body: {} });
      await loadTemplates();
      paint();
      notify('已恢复内置模板', '全部启用');
    } catch (error) {
      handleActionError(error);
    }
  }

  async function saveSettings(fields) {
    const payload = {
      reminders: {
        stateHour: readNumber(fields, 'stateHour', 10),
        closeHour: readNumber(fields, 'closeHour', 21),
        deepDays: readNumber(fields, 'deepDays', 3),
        enabled: readChecked(fields, 'enabled'),
      },
      tasks: { carryOver: String(readControl(fields, 'carryOver') ?? 'off') },
      data: { selfCheck: readChecked(fields, 'selfCheck') },
    };
    try {
      const result = await PC.api('/growth/settings', { method: 'PATCH', body: payload });
      if (result?.settings) ui.settings = result.settings;
      notify('设置已保存', '提醒时间即时生效');
      await loadSettingsData();
      paint();
    } catch (error) {
      handleActionError(error);
    }
  }

  async function addTemplate(fields) {
    const title = String(readControl(fields, 'title') ?? '').trim();
    if (!title) {
      notify('请先填写模板标题');
      return;
    }
    const body = {
      title,
      kind: String(readControl(fields, 'kind') ?? 'life'),
      estimateMin: readNumber(fields, 'estimateMin', 15),
      difficulty: readNumber(fields, 'difficulty', 2),
    };
    try {
      const result = await PC.api('/growth/templates', { method: 'POST', body });
      notify('模板已添加', result?.template?.title ?? title);
      await loadTemplates();
      paint();
    } catch (error) {
      handleActionError(error);
    }
  }

  async function saveAiConfig(fields) {
    const payload = {
      baseUrl: String(readControl(fields, 'baseUrl') ?? '').trim(),
      model: String(readControl(fields, 'model') ?? '').trim(),
    };
    const apiKey = String(readControl(fields, 'apiKey') ?? '').trim();
    if (apiKey) payload.apiKey = apiKey;
    try {
      await PC.api('/growth/ai/config', { method: 'POST', body: payload });
      notify('AI 配置已保存');
      await loadAiData();
      paint();
    } catch (error) {
      handleActionError(error);
    }
  }

  async function probeAi() {
    try {
      const result = await PC.api('/growth/ai/probe', { method: 'POST', body: {} });
      const probe = result?.probe ?? {};
      if (probe.ok) notify('AI 连通', `${Array.isArray(probe.models) ? probe.models.length : 0} 个模型可用 · ${num(probe.ms)}ms`);
      else notify('AI 不通', probe.error ?? '未知错误');
      await loadAiData();
      paint();
    } catch (error) {
      handleActionError(error);
    }
  }

  async function runSelfCheck() {
    try {
      const result = await PC.api('/growth/maintenance/check', { method: 'POST', body: {} });
      ui.maintenance = result?.report ?? ui.maintenance;
      const fixed = num(ui.maintenance?.totalFixed);
      notify('自检完成', fixed ? `修复 ${fixed} 项` : '没有需要修复的东西');
      await loadMaintenanceData();
      if (fixed) await reload();
      else paint();
    } catch (error) {
      handleActionError(error);
    }
  }

  async function restoreFile(file) {
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const counts = bundle?.counts ?? {};
      const summary = Object.entries(counts)
        .map(([name, count]) => `${name} ${count}`)
        .join(' · ');
      if (!confirmAction(`从「${file.name}」恢复？\n\n备份内容：${summary || '未知'}\n\n当前数据会先自动留档到 data/archive/pre-restore-*.json。`)) return;
      const result = await PC.api('/growth/restore', { method: 'POST', body: bundle });
      notify('已恢复', `当前数据已留档：${result?.snapshotFile ?? '（留档失败）'}`);
      await reload();
    } catch (error) {
      handleActionError(error);
    }
  }

  function scrollToStateForm() {
    const form = ui.mount?.querySelector?.('.growth-state-form');
    if (form?.scrollIntoView) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const first = ui.stateForm?.fields?.sleepHours ?? ui.stateForm?.fields?.energy;
    if (first?.focus) first.focus();
  }

  /* ------------------------------------------------------------ 通用渲染件 */

  function ringSvg(score) {
    const radius = 60;
    const circumference = 2 * Math.PI * radius;
    const safe = Number.isFinite(Number(score)) ? Math.max(0, Math.min(100, Number(score))) : 0;
    const offset = circumference * (1 - safe / 100);
    const wrap = mk('div', 'growth-ring-wrap');

    const svg = svgEl('svg', {
      class: 'growth-ring',
      viewBox: '0 0 136 136',
      width: '136',
      height: '136',
      role: 'img',
      'aria-label': `就绪度 ${Math.round(safe)}`,
    });
    svg.appendChild(svgEl('circle', { class: 'growth-ring-track', cx: 68, cy: 68, r: radius, fill: 'none', 'stroke-width': 8 }));
    svg.appendChild(
      svgEl('circle', {
        class: `growth-ring-value ${scoreClass(safe)}`,
        cx: 68,
        cy: 68,
        r: radius,
        fill: 'none',
        'stroke-width': 8,
        'stroke-linecap': 'round',
        'stroke-dasharray': circumference.toFixed(1),
        'stroke-dashoffset': offset.toFixed(1),
      }),
    );
    wrap.appendChild(svg);

    const label = mk('div', 'growth-ring-label');
    label.append(
      mk('strong', null, Number.isFinite(Number(score)) ? String(Math.round(Number(score))) : '—'),
      mk('span', null, 'READINESS'),
    );
    wrap.appendChild(label);
    return wrap;
  }

  function modeBadge(mode) {
    const key = MODE_LABEL[mode] ? mode : 'steady';
    const node = mk('span', `growth-mode is-${key}`);
    node.append(mk('b', null, MODE_LABEL[key]), mk('span', 'growth-mode-hint', MODE_HINT[key]));
    return node;
  }

  /** 六维里最拖后腿的一项（压力分高反而说明没问题，所以先反向）。 */
  function weakestOf(entry) {
    const rows = [
      { key: 'energy', label: '精力', value: num(entry?.energy) },
      { key: 'mood', label: '情绪', value: num(entry?.mood) },
      { key: 'stress', label: '压力', value: 6 - num(entry?.stress) },
      { key: 'focus', label: '专注', value: num(entry?.focus) },
      { key: 'body', label: '身体', value: num(entry?.body) },
    ].sort((a, b) => a.value - b.value);
    return rows[0];
  }

  function kvItem(label, value) {
    const node = mk('span', 'growth-kv-item');
    node.append(mk('span', null, label), mk('b', 'growth-mono', String(value)));
    return node;
  }

  /* ------------------------------------------------------------ 今日：状态 */

  function renderReadinessCard() {
    const entry = currentEntry();
    const built = card('今日读数', entry ? '状态是输入，任务是输出' : '先录入一次，今天的表单才有依据');
    if (entry) {
      const readiness = mk('div', 'growth-readiness');
      readiness.appendChild(ringSvg(entry.score));

      const meta = mk('div', 'growth-readiness-meta');
      meta.appendChild(modeBadge(entry.mode));

      const weakest = weakestOf(entry);
      const weakestText =
        entry.stress != null && weakest.key === 'stress'
          ? `${num(entry.stress)}/5（压力偏高）`
          : `${weakest.value}/5`;
      meta.appendChild(
        mk(
          'p',
          'growth-summary',
          `可投入约 ${num(entry.capacity)} 分钟 · 睡眠 ${num(entry.sleepHours)} 小时 · 最短板：${weakest.label} ${weakestText}`,
        ),
      );

      const stats = ui.today?.stats ?? {};
      const kv = mk('div', 'growth-kv-row');
      kv.append(
        kvItem('今日任务', `${num(stats.done)}/${num(stats.total)}`),
        kvItem('投入', `${num(stats.minutesDone)} 分钟`),
        kvItem('获得', `${num(ui.today?.xpGained)} XP`),
        kvItem('连击', `${num(ui.today?.character?.streak)} 天`),
      );
      meta.appendChild(kv);
      readiness.appendChild(meta);
      built.node.appendChild(readiness);
    } else {
      const empty = mk('div', 'growth-empty');
      empty.append(
        mk('p', 'growth-empty-title', '今天还没有录入状态。'),
        mk('p', 'growth-empty-text', '任务表单是按你的真实电量排的 —— 没有读数就没有表单，先花 30 秒填一下。'),
      );
      empty.appendChild(mkButton('去录入状态', 'growth-btn is-primary', scrollToStateForm));
      built.node.appendChild(empty);
    }
    return built.node;
  }

  function makeRange(fields, name, label, value, min, max, step, hint, unit) {
    const wrap = mk('div', 'growth-field');
    const labelNode = mk('label', 'growth-field-label');
    labelNode.appendChild(mk('span', null, label));
    const valueNode = mk('b', 'growth-field-value');
    const output = mk('span', 'growth-range-output', String(value));
    valueNode.appendChild(output);
    valueNode.appendChild(mk('span', null, unit ? ` ${unit}` : ' / 5'));
    labelNode.appendChild(valueNode);

    const input = mk('input', 'growth-range');
    input.type = 'range';
    input.name = name;
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.setAttribute('aria-label', label);
    input.addEventListener('input', () => {
      output.textContent = input.value;
    });

    wrap.append(labelNode, input, mk('span', 'growth-field-hint', hint));
    fields[name] = input;
    return wrap;
  }

  function buildStateForm(entry) {
    const fields = {};
    const valueOf = (key, fallback) => (entry && entry[key] != null ? entry[key] : fallback);
    const form = mk('form', 'growth-form growth-state-form');
    const grid = mk('div', 'growth-form-grid');

    grid.appendChild(
      makeRange(fields, 'sleepHours', '睡眠时长', num(valueOf('sleepHours', 7.5)), 0, 12, 0.5, '0 → 12 小时', '小时'),
    );
    grid.appendChild(makeRange(fields, 'sleepQuality', '睡眠质量', num(valueOf('sleepQuality', 3)), 1, 5, 1, '醒了几次？入睡难不难？'));
    grid.appendChild(makeRange(fields, 'energy', '精力', num(valueOf('energy', 3)), 1, 5, 1, '现在有多少电'));
    grid.appendChild(makeRange(fields, 'mood', '情绪', num(valueOf('mood', 3)), 1, 5, 1, '心情的底色'));
    grid.appendChild(makeRange(fields, 'stress', '压力', num(valueOf('stress', 3)), 1, 5, 1, '越紧张分越高（反向计分）'));
    grid.appendChild(makeRange(fields, 'focus', '专注', num(valueOf('focus', 3)), 1, 5, 1, '现在能坐得住吗'));
    grid.appendChild(makeRange(fields, 'body', '身体', num(valueOf('body', 3)), 1, 5, 1, '有没有酸痛、头痛、不适'));

    const noteWrap = mk('div', 'growth-field growth-field-full');
    const noteLabel = mk('label', 'growth-field-label');
    noteLabel.appendChild(mk('span', null, '今天有什么特殊情况'));
    const note = mk('textarea', 'growth-input growth-textarea');
    note.name = 'note';
    note.maxLength = 1000;
    note.placeholder = '例如：昨晚被吵醒两次；下午有重要会议；嗓子有点疼';
    note.value = String(valueOf('note', ''));
    noteWrap.append(noteLabel, note);
    grid.appendChild(noteWrap);
    fields.note = note;

    const actions = mk('div', 'growth-form-actions');
    const submit = mk('button', 'growth-btn is-primary', '保存状态');
    submit.type = 'submit';
    actions.appendChild(submit);

    form.append(grid, actions);
    // 测试缝：DOM 桩没有 form.elements，submit 处理器直接用构造时留下的字段引用。
    form._fields = fields;
    form.addEventListener('submit', async (event) => {
      event?.preventDefault?.();
      await saveState(fields);
    });
    return { form, fields };
  }

  function renderStateFormCard() {
    const entry = currentEntry();
    const built = card(entry ? '今天的读数（可随时修正）' : '录入今日状态', '6 个维度，30 秒填完');
    const formParts = buildStateForm(entry);
    ui.stateForm = formParts;
    built.node.appendChild(formParts.form);
    return built.node;
  }

  function renderStatusGroup() {
    const group = groupSection('状态', 'state');
    group.append(renderReadinessCard(), renderStateFormCard());
    return group;
  }

  /* ------------------------------------------------------------ 今日：任务 */

  function renderOverdueBanner() {
    if (!ui.overdue.length) return null;
    const first = ui.overdue[0] ?? {};
    const banner = mk('div', 'growth-banner is-danger');
    banner.appendChild(mk('span', 'growth-banner-icon', '⚠'));
    const body = mk('div', 'growth-banner-body');
    body.append(
      mk('b', null, `${ui.overdue.length} 条任务已逾期`),
      mk('span', null, ` 最旧的一条是 ${first.date ?? '—'} 的「${first.title ?? '未命名'}」。今天第一件事：决定补做还是放弃，别让它一直挂着。`),
    );
    banner.appendChild(body);
    const actions = mk('div', 'growth-banner-actions');
    actions.appendChild(mkButton('处理逾期', 'growth-btn is-ghost is-sm', () => run(() => selectTaskFilter('overdue'))));
    banner.appendChild(actions);
    return banner;
  }

  function renderTaskRow(task, { overdue = false, showDate = false } = {}) {
    const done = task.status === 'done';
    const skipped = task.status === 'skipped';
    const node = mk('div', `growth-task${done ? ' is-done' : ''}${overdue ? ' is-overdue' : ''}`);

    const check = mkButton('✓', 'growth-task-check', () => run(() => toggleTask(task)));
    check.title = done ? '取消完成' : '打卡完成';
    check.setAttribute('aria-label', done ? `取消完成：${task.title ?? ''}` : `打卡完成：${task.title ?? ''}`);
    check.dataset.id = String(task.id ?? '');
    node.appendChild(check);

    const body = mk('div', 'growth-task-body');
    body.appendChild(mk('div', 'growth-task-title', task.title ?? '未命名任务'));
    if (task.detail) body.appendChild(mk('div', 'growth-task-detail', task.detail));
    const meta = mk('div', 'growth-task-meta');
    meta.appendChild(tag(kindLabel(task.kind), `kind-${task.kind ?? 'life'}`));
    meta.appendChild(tag(`${num(task.estimateMin)} 分钟`));
    if (task.slot) meta.appendChild(tag(String(task.slot)));
    if (showDate) meta.appendChild(tag(String(task.date ?? '—')));
    if (overdue) meta.appendChild(tag('逾期', 'is-danger'));
    if (skipped) meta.appendChild(tag('已跳过'));
    if (!done && !skipped) {
      const skip = mkButton('跳过', 'growth-btn is-ghost is-sm', () => run(() => skipTask(task)));
      skip.dataset.id = String(task.id ?? '');
      meta.appendChild(skip);
    }
    if (overdue) {
      const postpone = mkButton('改期到明天', 'growth-btn is-ghost is-sm', () => run(() => postponeTask(task)));
      postpone.dataset.id = String(task.id ?? '');
      meta.appendChild(postpone);
    }
    body.appendChild(meta);
    node.appendChild(body);

    const right = mk('div', 'growth-task-right');
    right.appendChild(mk('span', 'growth-task-xp', `+${num(task.xp)} XP`));
    const dots = mk('span', 'growth-dots');
    dots.title = `难度 ${num(task.difficulty)}/5`;
    for (let index = 1; index <= 5; index += 1) {
      dots.appendChild(mk('i', index <= num(task.difficulty) ? 'on' : ''));
    }
    right.appendChild(dots);
    node.appendChild(right);
    return node;
  }

  function renderPlanCard() {
    const day = ui.today ?? {};
    const tasks = Array.isArray(day.tasks) ? day.tasks : [];
    const entry = currentEntry();
    const plan = day.plan ?? null;
    const built = card('今日任务表单');

    if (tasks.length) {
      built.actions.appendChild(
        mk('span', 'growth-card-sub', `${tasks.length} 条 · 预算 ${num(plan?.usedMinutes)}/${num(plan?.budget)} 分钟`),
      );
      built.actions.appendChild(
        mkButton('重排', 'growth-btn is-ghost is-sm', () => run(() => generatePlan(true))),
      );
      const list = mk('div', 'growth-tasks');
      for (const task of tasks) {
        list.appendChild(renderTaskRow(task, { overdue: ui.overdue.some((item) => item.id === task.id) }));
      }
      built.node.appendChild(list);

      if (Array.isArray(plan?.rationale) && plan.rationale.length) {
        const details = mk('details', 'growth-details');
        details.appendChild(mk('summary', 'growth-details-summary', '为什么这么排'));
        const ul = mk('ul', 'growth-rationale');
        for (const line of plan.rationale) ul.appendChild(mk('li', null, line));
        details.appendChild(ul);
        built.node.appendChild(details);
      }
      return built.node;
    }

    if (entry) {
      built.actions.appendChild(mk('span', 'growth-card-sub', '还没生成'));
      built.node.appendChild(
        mk(
          'p',
          'growth-muted',
          `按当前读数（${num(entry.score)} 分 / 可投入 ${num(entry.capacity)} 分钟）排一份今天的表单。`,
        ),
      );
      built.node.appendChild(
        mkButton('生成任务表单', 'growth-btn is-primary', () => run(() => generatePlan(false))),
      );
      return built.node;
    }

    built.actions.appendChild(mk('span', 'growth-card-sub', '先录入状态'));
    built.node.appendChild(mk('p', 'growth-muted', '没有状态读数就没有任务表单。先花 30 秒录入今天的电量。'));
    built.node.appendChild(mkButton('去录入状态', 'growth-btn is-primary', scrollToStateForm));
    return built.node;
  }

  function renderBriefingCard() {
    const date = currentDate();
    const briefing = ui.briefings[date] ?? null;
    const review = ui.reviews[date] ?? null;
    const built = card('今日简报');

    if (briefing) {
      built.actions.appendChild(tag(briefing.source === 'ai' ? `AI · ${briefing.model ?? ''}` : '本地规则'));
    }
    const generate = mkButton('生成', 'growth-btn is-sm', () => run(() => refreshBriefing('briefing')));
    const reviewButton = mkButton('复盘', 'growth-btn is-ghost is-sm', () => run(() => refreshBriefing('review')));
    if (ui.busy) {
      generate.disabled = true;
      reviewButton.disabled = true;
    }
    built.actions.append(generate, reviewButton);

    const body = mk('div', 'growth-briefing', briefing ? briefing.text : '');
    if (!briefing) body.appendChild(mk('span', 'growth-muted', '点「生成」拿一段今天的作战简报；没接 AI 也能用（本地规则生成）。'));
    built.node.appendChild(body);

    if (review) {
      const block = mk('div', 'growth-briefing-review');
      const head = mk('div', 'growth-row growth-row-between');
      head.appendChild(mk('span', 'growth-card-sub', `复盘 · ${review.source === 'ai' ? 'AI' : '本地规则'}`));
      block.appendChild(head);
      block.appendChild(mk('div', 'growth-briefing', review.text ?? ''));
      built.node.appendChild(block);
    }
    return built.node;
  }

  function makeInput(fields, name, label, options = {}) {
    const wrap = mk('div', 'growth-field');
    const labelNode = mk('label', 'growth-field-label');
    labelNode.appendChild(mk('span', null, label));
    const input = mk('input', 'growth-input');
    input.type = options.type ?? 'text';
    input.name = name;
    input.value = String(options.value ?? '');
    if (options.placeholder) input.placeholder = options.placeholder;
    if (options.maxLength) input.maxLength = Number(options.maxLength);
    if (options.min !== undefined) input.min = String(options.min);
    if (options.max !== undefined) input.max = String(options.max);
    if (options.step !== undefined) input.step = String(options.step);
    input.setAttribute('aria-label', label);
    wrap.append(labelNode, input);
    if (options.hint) wrap.appendChild(mk('span', 'growth-field-hint', options.hint));
    fields[name] = input;
    return wrap;
  }

  function makeSelect(fields, name, label, options, value) {
    const wrap = mk('div', 'growth-field');
    const labelNode = mk('label', 'growth-field-label');
    labelNode.appendChild(mk('span', null, label));
    const select = mk('select', 'growth-select');
    select.name = name;
    for (const [optionValue, optionLabel] of options) {
      const optionNode = mk('option', null, optionLabel);
      optionNode.value = optionValue;
      select.appendChild(optionNode);
    }
    select.value = String(value ?? options[0]?.[0] ?? '');
    select.setAttribute('aria-label', label);
    wrap.append(labelNode, select);
    fields[name] = select;
    return wrap;
  }

  function makeCheck(fields, name, label, checked) {
    const wrap = mk('label', 'growth-check');
    const input = mk('input');
    input.type = 'checkbox';
    input.name = name;
    input.checked = Boolean(checked);
    wrap.append(input, mk('span', null, label));
    fields[name] = input;
    return wrap;
  }

  function renderManualTaskForm() {
    const fields = {};
    const form = mk('form', 'growth-form growth-manual-task');
    const grid = mk('div', 'growth-form-grid');
    grid.appendChild(makeInput(fields, 'title', '标题', { placeholder: '例如：给导师回邮件', maxLength: 80 }));
    grid.appendChild(
      makeSelect(
        fields,
        'kind',
        '类型',
        Object.entries(KIND_LABEL).map(([key, label]) => [key, label]),
        'focus',
      ),
    );
    grid.appendChild(makeInput(fields, 'estimateMin', '预估分钟', { type: 'number', value: 25, min: 5, max: 240, step: 5 }));
    grid.appendChild(makeInput(fields, 'difficulty', '难度 1–5', { type: 'number', value: 2, min: 1, max: 5, step: 1 }));
    const actions = mk('div', 'growth-form-actions');
    const submit = mk('button', 'growth-btn', '添加任务');
    submit.type = 'submit';
    actions.appendChild(submit);
    form.append(grid, actions);
    form._fields = fields;
    form.addEventListener('submit', async (event) => {
      event?.preventDefault?.();
      await addManualTask(fields);
    });
    return form;
  }

  function renderTaskManager() {
    const day = ui.today ?? {};
    const todayTasks = Array.isArray(day.tasks) ? day.tasks : [];
    const details = mk('details', 'growth-card growth-details growth-task-manager');
    details.open = ui.taskManagerOpen;
    details.addEventListener('toggle', () => {
      ui.taskManagerOpen = Boolean(details.open);
    });
    details.appendChild(
      mk(
        'summary',
        'growth-details-summary',
        `任务管理 · 手动添加 / 今日 ${todayTasks.length} / 逾期 ${ui.overdue.length} / 全部${ui.allTasksLoaded ? ` ${ui.allTasks.length}` : ''}`,
      ),
    );

    const inner = mk('div', 'growth-task-manager-body');
    const filters = mk('div', 'growth-filter-row');
    for (const [key, label] of [
      ['today', `今日 ${todayTasks.length}`],
      ['overdue', `逾期 ${ui.overdue.length}`],
      ['all', '全部'],
    ]) {
      const button = mkButton(label, `growth-btn is-sm${ui.taskFilter === key ? ' is-primary' : ' is-ghost'}`, () =>
        run(() => selectTaskFilter(key)),
      );
      button.dataset.filter = key;
      filters.appendChild(button);
    }
    if (ui.taskFilter === 'all') {
      filters.appendChild(mkButton('刷新', 'growth-btn is-ghost is-sm', () => run(async () => { await loadAllTasks(); paint(); })));
    }
    inner.appendChild(filters);

    if (ui.errors.allTasks && ui.taskFilter === 'all') inner.appendChild(showErrorBox(ui.errors.allTasks));

    let rows = [];
    if (ui.taskFilter === 'today') rows = todayTasks.slice();
    else if (ui.taskFilter === 'overdue') rows = ui.overdue.slice();
    else rows = ui.allTasks.slice().sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));

    if (rows.length) {
      const list = mk('div', 'growth-tasks growth-task-manager-list');
      for (const task of rows) {
        list.appendChild(
          renderTaskRow(task, {
            overdue: ui.overdue.some((item) => item.id === task.id),
            showDate: ui.taskFilter === 'all',
          }),
        );
      }
      inner.appendChild(list);
    } else {
      inner.appendChild(
        mk(
          'p',
          'growth-muted',
          `这里还没有任务。${ui.taskFilter === 'today' && !ui.today?.plan ? '先去上面生成任务表单。' : ''}`,
        ),
      );
    }

    inner.appendChild(mk('div', 'growth-divider'));
    inner.appendChild(mk('h4', 'growth-subtitle', '手动加一条'));
    inner.appendChild(mk('p', 'growth-muted', '临时冒出来的事，不必等生成器。'));
    inner.appendChild(renderManualTaskForm());
    details.appendChild(inner);
    return details;
  }

  function renderTaskGroup() {
    const group = groupSection('任务', 'tasks');
    if (ui.errors.overdue) group.appendChild(showErrorBox(ui.errors.overdue));
    const banner = renderOverdueBanner();
    if (banner) group.appendChild(banner);
    group.append(renderPlanCard(), renderBriefingCard(), renderTaskManager());
    return group;
  }

  /* ------------------------------------------------------------ 今日：存档 */

  function renderArchiveRow(row) {
    const node = mk('div', 'growth-archive-row');
    const link = mk('a', 'growth-archive-file', row.file ?? '（未知存档）');
    link.href = growthUrl(`/archives/${encodeURIComponent(String(row.file ?? ''))}`);
    link.target = '_blank';
    link.rel = 'noreferrer';
    node.appendChild(link);

    const meta = mk('div', 'growth-archive-meta');
    meta.appendChild(mk('span', null, row.date ?? '—'));
    meta.appendChild(mk('span', null, row.reason ?? '—'));
    node.appendChild(meta);

    const tags = mk('div', 'growth-archive-tags');
    const counts = row.counts ?? {};
    tags.append(
      tag(`任务 ${num(counts.tasks)}`),
      tag(`状态 ${num(counts.stateEntries)}`),
      tag(`日志 ${num(counts.logs)}`),
    );
    node.appendChild(tags);
    return node;
  }

  function renderSessionCard() {
    const session = ui.overview?.session ?? null;
    const built = card('会话与存档', '关机时把当天现场写成一份存档；存档在 data/archive/ 里');
    if (ui.errors.overview) built.node.appendChild(showErrorBox(ui.errors.overview));
    if (ui.errors.boot) built.node.appendChild(showErrorBox(ui.errors.boot));
    const line = mk('p', 'growth-session-line');
    line.textContent = session
      ? `当前会话 ${String(session.id ?? '').slice(0, 8)} 开始于 ${timeOf(session.startedAt)}（${session.trigger ?? 'startup'}）`
      : '当前没有进行中的会话。';
    built.node.appendChild(line);

    if (ui.shutdown) {
      built.node.appendChild(mk('p', 'growth-notice', '会话已结束，存档已写入。重新打开程序后会开启新会话。'));
    }

    const row = mk('div', 'growth-row');
    row.appendChild(mkButton('立即存档', 'growth-btn', () => run(snapshotNow)));
    row.appendChild(mkButton('结束会话', 'growth-btn is-danger', () => run(shutdownSession)));
    built.node.appendChild(row);

    if (ui.errors.archives) {
      built.node.appendChild(showErrorBox(ui.errors.archives));
    } else if (!ui.archives.length) {
      built.node.appendChild(mk('p', 'growth-muted', '还没有存档。关机或点「立即存档」后会在这里出现。'));
    } else {
      const list = mk('div', 'growth-archive-list');
      for (const row of ui.archives) list.appendChild(renderArchiveRow(row));
      built.node.appendChild(list);
    }
    return built.node;
  }

  function renderLogCard() {
    const details = mk('details', 'growth-card growth-details growth-log-card');
    if (ui.errors.logs) details.open = true;
    details.appendChild(mk('summary', 'growth-details-summary', `最近日志 · ${ui.logs.length} 条`));
    const body = mk('div', 'growth-log-body');
    const row = mk('div', 'growth-row');
    row.appendChild(
      mkButton('刷新', 'growth-btn is-ghost is-sm', () =>
        run(async () => {
          await loadLogsArchives();
          paint();
        }),
      ),
    );
    body.appendChild(row);

    if (ui.errors.logs) {
      body.appendChild(showErrorBox(ui.errors.logs));
    } else if (!ui.logs.length) {
      body.appendChild(mk('p', 'growth-muted', '暂无日志。'));
    } else {
      const list = mk('div', 'growth-log-list');
      for (const log of ui.logs) {
        const item = mk('div', 'growth-log-item');
        item.appendChild(mk('span', 'growth-log-time', timeOf(log.at)));
        const type = mk('span', 'growth-log-type', String(log.type ?? ''));
        type.dataset.type = String(log.type ?? '');
        item.appendChild(type);
        item.appendChild(mk('span', 'growth-log-msg', String(log.message ?? '')));
        list.appendChild(item);
      }
      body.appendChild(list);
    }
    details.appendChild(body);
    return details;
  }

  function renderArchiveGroup() {
    const group = groupSection('存档', 'archive');
    group.append(renderSessionCard(), renderLogCard());
    return group;
  }

  function renderToday() {
    const body = mk('div', 'growth-tab-body growth-today');
    body.append(renderStatusGroup(), renderTaskGroup(), renderArchiveGroup());
    return body;
  }

  /* ------------------------------------------------------------ 角色 */

  function renderCharacterHero(character) {
    const ch = character ?? {};
    const built = card('角色', '等级只由累计有效投入决定');
    const progress = Number.isFinite(Number(ch.progress))
      ? Number(ch.progress)
      : ch.xpForNext
        ? num(ch.xpIntoLevel) / Math.max(1, num(ch.xpForNext))
        : 1;

    const readiness = mk('div', 'growth-readiness');
    readiness.appendChild(ringSvg(Math.round(progress * 100)));
    const meta = mk('div', 'growth-readiness-meta');

    const nameRow = mk('div', 'growth-name-row');
    nameRow.appendChild(mk('h3', 'growth-character-name', ch.name ?? 'Operator'));
    nameRow.appendChild(tag(`Lv.${num(ch.level, 1)}`, 'is-level'));
    if (!ui.renaming) {
      nameRow.appendChild(
        mkButton('改名', 'growth-btn is-ghost is-sm', () => {
          ui.renaming = true;
          paint();
        }),
      );
    }
    meta.appendChild(nameRow);

    if (ui.renaming) {
      const fields = {};
      const form = mk('form', 'growth-rename-form');
      const input = mk('input', 'growth-input');
      input.name = 'name';
      input.value = String(ch.name ?? 'Operator');
      input.maxLength = 24;
      input.setAttribute('aria-label', '角色名');
      fields.name = input;
      const save = mk('button', 'growth-btn is-primary is-sm', '保存');
      save.type = 'submit';
      const cancel = mkButton('取消', 'growth-btn is-ghost is-sm', () => {
        ui.renaming = false;
        paint();
      });
      form.append(input, save, cancel);
      form.addEventListener('submit', async (event) => {
        event?.preventDefault?.();
        await renameCharacter(input.value);
      });
      meta.appendChild(form);
    }

    meta.appendChild(
      mk(
        'p',
        'growth-summary',
        `${num(ch.totalXp)} 总经验 · 本级 ${num(ch.xpIntoLevel)}/${ch.xpForNext == null ? 'MAX' : num(ch.xpForNext)}`,
      ),
    );

    const kv = mk('div', 'growth-kv-row');
    kv.append(
      kvItem('连击', `${num(ch.streak)} 天（最佳 ${num(ch.bestStreak)}）`),
      kvItem('累计完成', `${num(ch.counters?.tasksDone)} 条`),
      kvItem('全清天数', `${num(ch.counters?.perfectDays)}`),
    );
    meta.appendChild(kv);
    meta.appendChild(mk('p', 'growth-muted', ui.streakLabel || ch.streakLabel || ''));

    readiness.appendChild(meta);
    built.node.appendChild(readiness);
    return built.node;
  }

  function renderAttrsCard(character) {
    const ch = character ?? {};
    const attrs = ch.attrs ?? {};
    const built = card('属性', '由完成任务的行为类型累积');
    const values = Object.keys(ATTR_LABEL).map((key) => num(attrs[key]));
    const maxAttr = Math.max(10, ...values);
    const list = mk('div', 'growth-attrs');
    for (const [key, label] of Object.entries(ATTR_LABEL)) {
      const value = num(attrs[key]);
      const row = mk('div', 'growth-attr');
      row.appendChild(mk('span', 'growth-attr-label', label));
      const bar = mk('span', 'growth-attr-bar');
      const fill = mk('i');
      setWidth(fill, (value / maxAttr) * 100);
      bar.appendChild(fill);
      row.appendChild(bar);
      row.appendChild(mk('b', 'growth-attr-value', String(value)));
      list.appendChild(row);
    }
    built.node.appendChild(list);
    built.node.appendChild(mk('p', 'growth-muted growth-footnote', '深度→专注 · 认知→认知 · 身体→体魄 · 生活→秩序 · 恢复→韧性'));
    return built.node;
  }

  function renderAchievementsCard() {
    const achievements = ui.achievements;
    const unlocked = Array.isArray(achievements) ? achievements.filter((item) => item.unlocked).length : 0;
    const built = card(
      '成就',
      Array.isArray(achievements) ? `${unlocked}/${achievements.length}` : '解锁后会出现在这里',
    );

    if (ui.achievementsError) {
      built.node.appendChild(showErrorBox(ui.achievementsError));
    } else if (!Array.isArray(achievements)) {
      built.node.appendChild(mk('p', 'growth-muted', ui.achievementsLoading ? '载入中…' : '正在读取…'));
    } else if (!achievements.length) {
      built.node.appendChild(mk('p', 'growth-muted', '还没有成就。'));
    } else {
      const grid = mk('div', 'growth-achievements');
      for (const item of achievements) {
        const node = mk('div', `growth-ach${item.unlocked ? ' is-unlocked' : ''}`);
        node.appendChild(mk('strong', null, item.name ?? ''));
        node.appendChild(mk('small', null, item.desc ?? ''));
        grid.appendChild(node);
      }
      built.node.appendChild(grid);
    }
    return built.node;
  }

  function renderCharacterBody() {
    const body = mk('div', 'growth-tab-body growth-character');
    if (ui.errors.character) body.appendChild(showErrorBox(ui.errors.character));
    body.appendChild(renderCharacterHero(ui.character));
    const grid = mk('div', 'growth-grid-2');
    grid.append(renderAttrsCard(ui.character), renderAchievementsCard());
    body.appendChild(grid);
    return body;
  }

  /* ------------------------------------------------------------ 周报 */

  function trendChart(points) {
    const width = 780;
    const height = 132;
    const pad = 10;
    const count = Math.max(1, points.length);
    const slot = (width - pad * 2) / count;
    const svg = svgEl('svg', {
      class: 'growth-chart',
      viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': '近两周状态与完成率',
    });

    points.forEach((point, index) => {
      const x = pad + index * slot;
      const score = num(point.score);
      const barHeight = point.hasState ? Math.max(3, (score / 100) * (height - 34)) : 0;
      const y = height - 20 - barHeight;
      if (point.hasState) {
        svg.appendChild(
          svgEl('rect', {
            class: `growth-chart-bar ${scoreClass(score)}`,
            x: (x + 2).toFixed(2),
            y: y.toFixed(2),
            width: Math.max(4, slot - 4).toFixed(2),
            height: barHeight.toFixed(2),
            rx: 3,
          }),
        );
      } else {
        svg.appendChild(
          svgEl('text', { class: 'growth-chart-empty', x: (x + slot / 2).toFixed(2), y: height - 24, 'text-anchor': 'middle' }, '–'),
        );
      }

      svg.appendChild(
        svgEl('rect', {
          class: 'growth-chart-track',
          x: (x + 2).toFixed(2),
          y: height - 12,
          width: Math.max(4, slot - 4).toFixed(2),
          height: 3,
          rx: 1.5,
        }),
      );
      const doneRatio = point.total ? num(point.done) / num(point.total) : 0;
      if (doneRatio > 0) {
        svg.appendChild(
          svgEl('rect', {
            class: 'growth-chart-done',
            x: (x + 2).toFixed(2),
            y: height - 12,
            width: Math.max(4, (slot - 4) * doneRatio).toFixed(2),
            height: 3,
            rx: 1.5,
          }),
        );
      }
      if (index % 2 === 0) {
        svg.appendChild(
          svgEl(
            'text',
            { class: 'growth-chart-label', x: (x + slot / 2).toFixed(2), y: height - 2, 'text-anchor': 'middle' },
            String(point.date ?? '').slice(5),
          ),
        );
      }
    });
    return svg;
  }

  function renderTrendCard() {
    const built = card('近 14 天', '状态是输入，任务是输出');
    if (ui.errors.trend) {
      built.node.appendChild(showErrorBox(ui.errors.trend));
      return built.node;
    }
    if (!ui.trend.length) {
      built.node.appendChild(mk('p', 'growth-muted', '还没有足够的数据画趋势。'));
      return built.node;
    }
    built.node.appendChild(trendChart(ui.trend));
    const legend = mk('div', 'growth-chart-legend');
    legend.append(mk('span', null, '柱子 = 就绪度'), mk('span', null, '底部细条 = 完成率'), mk('span', 'growth-muted', '— = 当天没录入'));
    built.node.appendChild(legend);
    return built.node;
  }

  function weekBarClass(point) {
    if (!point?.hasState) return 'is-empty';
    return scoreClass(point.score);
  }

  function renderWeekGrid(points) {
    const grid = mk('div', 'growth-week-grid');
    for (const point of points) {
      const cell = mk('div', 'growth-week-cell');
      cell.title = `${point.date ?? ''} · 就绪度 ${point.hasState ? num(point.score) : '—'} · 完成 ${num(point.done)}/${num(point.total)}`;
      const bar = mk('div', 'growth-week-bar');
      const fill = mk('i', weekBarClass(point));
      const completion = point.total ? num(point.done) / num(point.total) : 0;
      setHeight(fill, completion * 100);
      bar.appendChild(fill);
      cell.appendChild(bar);
      cell.appendChild(mk('span', 'growth-week-label', String(point.date ?? '').slice(5)));
      cell.appendChild(
        mk(
          'b',
          `growth-week-score${point.hasState ? ` ${scoreClass(point.score)}` : ''}`,
          point.hasState ? String(Math.round(num(point.score))) : '—',
        ),
      );
      grid.appendChild(cell);
    }
    return grid;
  }

  function renderWeeklyCard() {
    const built = card('本周', '截止日往前 7 天（含当天）');
    if (ui.errors.week) {
      built.node.appendChild(showErrorBox(ui.errors.week));
      return built.node;
    }
    if (!ui.week) {
      built.node.appendChild(mk('p', 'growth-muted', '周报还没准备好。'));
      return built.node;
    }

    const week = ui.week;
    const totals = week.totals ?? {};
    const rate = num(totals.planned) ? Math.round((num(totals.done) / num(totals.planned)) * 100) : 0;
    built.actions.appendChild(mk('span', 'growth-card-sub', `${week.from ?? '—'} → ${week.to ?? '—'}`));

    const kv = mk('div', 'growth-kv-row');
    kv.append(
      kvItem('完成', `${num(totals.done)}/${num(totals.planned)}（${rate}%）`),
      kvItem('投入', `${num(totals.minutes)} 分钟`),
      kvItem('获得', `${num(totals.xp)} XP`),
      kvItem('平均就绪度', totals.avgScore == null ? '—' : String(Math.round(num(totals.avgScore)))),
      kvItem('活跃', `${num(totals.activeDays)}/7 天`),
      kvItem('连击', String(num(week.streak))),
    );
    built.node.appendChild(kv);

    const points = Array.isArray(week.points) ? week.points : [];
    if (points.length) built.node.appendChild(renderWeekGrid(points));

    built.node.appendChild(mk('div', 'growth-briefing', week.verdict ?? ''));
    const insights = Array.isArray(week.insights) ? week.insights : [];
    if (insights.length) {
      const ul = mk('ul', 'growth-rationale growth-insights');
      for (const line of insights) ul.appendChild(mk('li', null, line));
      built.node.appendChild(ul);
    }
    const kindLine = Object.entries(week.byKind ?? {})
      .map(([kind, bucket]) => `${kindLabel(kind)} ${num(bucket?.done)}/${num(bucket?.planned)}`)
      .join(' · ');
    if (kindLine) built.node.appendChild(mk('p', 'growth-muted growth-footnote', kindLine));
    return built.node;
  }

  function renderExportCard() {
    const date = currentDate() || '1970-01-01';
    const built = card('导出 Markdown', '状态、任务、角色与日志都在文件里');
    const row = mk('div', 'growth-row');
    row.appendChild(
      downloadFile('导出今日 .md', `/journal/export?date=${encodeURIComponent(date)}`, `growth-${date}.md`),
    );
    const from = shiftDate(date, -6);
    row.appendChild(
      downloadFile(
        '导出近 7 天 .md',
        `/journal/export?from=${encodeURIComponent(from)}&to=${encodeURIComponent(date)}`,
        `growth-${from}_${date}.md`,
      ),
    );
    built.node.appendChild(row);
    built.node.appendChild(mk('p', 'growth-muted growth-footnote', '导出内容与成长日记口径一致：状态、任务、计划理由、角色与日志。'));
    return built.node;
  }

  function renderWeekBody() {
    const body = mk('div', 'growth-tab-body growth-week');
    body.append(renderTrendCard(), renderWeeklyCard(), renderExportCard());
    return body;
  }

  /* ------------------------------------------------------------ 设置 */

  function buildSettingsForm(settings, modes) {
    const s = settings ?? {};
    const reminders = s.reminders ?? {};
    const fields = {};
    const form = mk('form', 'growth-form growth-settings-form');
    const grid = mk('div', 'growth-form-grid');
    grid.appendChild(
      makeInput(fields, 'stateHour', '状态提醒时间（0–23 点）', {
        type: 'number',
        value: num(reminders.stateHour, 10),
        min: 0,
        max: 23,
        step: 1,
      }),
    );
    grid.appendChild(
      makeInput(fields, 'closeHour', '收尾提醒时间（要晚于上面）', {
        type: 'number',
        value: num(reminders.closeHour, 21),
        min: 0,
        max: 23,
        step: 1,
      }),
    );
    grid.appendChild(
      makeInput(fields, 'deepDays', '逾期几天后升级提醒', {
        type: 'number',
        value: num(reminders.deepDays, 3),
        min: 1,
        max: 30,
        step: 1,
      }),
    );
    grid.appendChild(
      makeSelect(
        fields,
        'carryOver',
        '跨天时未完成的任务',
        Object.entries(modes ?? { off: '保持逾期', auto: '自动顺延到今天' }),
        s.tasks?.carryOver ?? 'off',
      ),
    );

    const checks = mk('div', 'growth-check-row');
    checks.append(
      makeCheck(fields, 'enabled', '启用提醒推送', reminders.enabled !== false),
      makeCheck(fields, 'selfCheck', '启动时做一次数据自检', s.data?.selfCheck !== false),
    );
    grid.appendChild(checks);

    const actions = mk('div', 'growth-form-actions');
    const submit = mk('button', 'growth-btn is-primary', '保存设置');
    submit.type = 'submit';
    actions.appendChild(submit);
    form.append(grid, actions);
    form._fields = fields;
    form.addEventListener('submit', async (event) => {
      event?.preventDefault?.();
      await saveSettings(fields);
    });
    return form;
  }

  function renderMaintenanceRow() {
    const report = ui.maintenance;
    const wrap = mk('div', 'growth-maintenance');
    if (ui.errors.maintenance) {
      wrap.appendChild(showErrorBox(ui.errors.maintenance));
      return wrap;
    }
    const row = mk('div', 'growth-row growth-row-between');
    const label = report
      ? `数据自检 · 上次 ${timeOf(report.at)} · 修复 ${num(report.totalFixed)} 项`
      : '数据自检 · 还没有跑过';
    row.appendChild(mk('span', 'growth-muted', label));
    row.appendChild(mkButton('立即自检', 'growth-btn is-ghost is-sm', () => run(runSelfCheck)));
    wrap.appendChild(row);

    if (report && num(report.totalFixed)) {
      const detail = Object.entries(report.fixed ?? {})
        .filter(([, value]) => (typeof value === 'number' ? value > 0 : Boolean(value)))
        .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
        .join(' · ');
      wrap.appendChild(mk('p', 'growth-muted growth-footnote', `修复明细：${detail || '无'}`));
    } else {
      wrap.appendChild(mk('p', 'growth-muted growth-footnote', '自检只做解绑与重算，不删除任何记录。'));
    }
    return wrap;
  }

  function renderSettingsFormCard() {
    const built = card('提醒与跨天', '都在本机，不需要推送服务');
    if (ui.errors.settings) built.node.appendChild(showErrorBox(ui.errors.settings));
    if (ui.settings) built.node.appendChild(buildSettingsForm(ui.settings, ui.settingsModes));
    else if (!ui.errors.settings) built.node.appendChild(mk('p', 'growth-muted', '正在读取设置…'));
    built.node.appendChild(mk('div', 'growth-divider'));
    built.node.appendChild(renderMaintenanceRow());
    return built.node;
  }

  function buildAiForm(ai) {
    const fields = {};
    const form = mk('form', 'growth-form growth-ai-form');
    const grid = mk('div', 'growth-form-grid');
    grid.appendChild(
      makeInput(fields, 'baseUrl', '接口地址（OpenAI 兼容）', {
        value: ai.baseUrl ?? '',
        placeholder: 'http://127.0.0.1:11434/v1',
      }),
    );
    grid.appendChild(makeInput(fields, 'model', '模型', { value: ai.model ?? '', placeholder: 'deepseek-r1:latest' }));
    grid.appendChild(
      makeInput(fields, 'apiKey', 'API Key（本地端点留空即可）', {
        type: 'password',
        placeholder: ai.hasKey ? `已保存 ${ai.keyMask ?? ''}（留空不改）` : '未设置',
      }),
    );

    const statusWrap = mk('div', 'growth-field');
    statusWrap.appendChild(mk('span', 'growth-field-label', '状态'));
    const tags = mk('div', 'growth-status-tags');
    tags.append(
      tag(ai.enabled ? '已启用' : '已关闭'),
      tag(ai.isLocal ? '本机' : '远程'),
      ai.hasKey ? tag(`Key ${ai.keyMask ?? ''}`) : tag('无 Key'),
    );
    statusWrap.appendChild(tags);
    grid.appendChild(statusWrap);

    const actions = mk('div', 'growth-form-actions');
    const save = mk('button', 'growth-btn is-primary', '保存');
    save.type = 'submit';
    const probe = mkButton('测试连通', 'growth-btn', () => run(probeAi));
    actions.append(save, probe);
    const hint = mk('p', 'growth-muted growth-footnote growth-ai-hint');
    hint.append(mk('span', null, '本地推荐：'), mk('code', 'growth-code', 'ollama serve'), mk('span', null, ' + '), mk('code', 'growth-code', 'ollama pull deepseek-r1:7b'), mk('span', null, '，然后地址填 http://127.0.0.1:11434/v1'));
    actions.appendChild(hint);
    form.append(grid, actions);
    form._fields = fields;
    form.addEventListener('submit', async (event) => {
      event?.preventDefault?.();
      await saveAiConfig(fields);
    });
    return form;
  }

  function renderAiCard() {
    const ai = ui.ai ?? {};
    const built = card('AI 接入', '默认本机端点，连不上就自动降级');
    if (ui.errors.ai) built.node.appendChild(showErrorBox(ui.errors.ai));
    built.node.appendChild(buildAiForm(ai));
    return built.node;
  }

  function buildTemplateForm() {
    const fields = {};
    const form = mk('form', 'growth-form growth-template-form');
    const grid = mk('div', 'growth-form-grid');
    grid.appendChild(makeInput(fields, 'title', '标题', { placeholder: '例如：给花浇水', maxLength: 40 }));
    grid.appendChild(
      makeSelect(
        fields,
        'kind',
        '类型',
        Object.entries(KIND_LABEL).map(([key, label]) => [key, label]),
        'life',
      ),
    );
    grid.appendChild(makeInput(fields, 'estimateMin', '预估分钟', { type: 'number', value: 15, min: 5, max: 240, step: 5 }));
    grid.appendChild(makeInput(fields, 'difficulty', '难度 1–5', { type: 'number', value: 2, min: 1, max: 5, step: 1 }));
    const actions = mk('div', 'growth-form-actions');
    const submit = mk('button', 'growth-btn', '添加模板');
    submit.type = 'submit';
    actions.appendChild(submit);
    form.append(grid, actions);
    form._fields = fields;
    form.addEventListener('submit', async (event) => {
      event?.preventDefault?.();
      await addTemplate(fields);
    });
    return form;
  }

  function renderTemplateCard() {
    const t = ui.templates;
    const built = card(
      '任务模板',
      t ? `生效 ${num(t.activeCount)} / 内置 ${num(t.builtinCount)} · 自定义 ${num(t.customCount)}` : '生成器只从启用的模板里挑任务',
    );
    built.actions.appendChild(mkButton('内置全部启用', 'growth-btn is-ghost is-sm', () => run(enableAllTemplates)));

    if (ui.errors.templates) built.node.appendChild(showErrorBox(ui.errors.templates));
    if (!t) {
      if (!ui.errors.templates) built.node.appendChild(mk('p', 'growth-muted', '正在读取模板…'));
      return built.node;
    }

    built.node.appendChild(
      mk('p', 'growth-muted', '生成器只从启用的模板里挑任务。内置模板可以点一下停用；你自己的模板可以随时增删。'),
    );

    const customList = mk('div', 'growth-tpl-list');
    if (Array.isArray(t.custom) && t.custom.length) {
      for (const item of t.custom) {
        const row = mk('div', 'growth-tpl-row');
        row.appendChild(tag(item.kindLabel ?? kindLabel(item.kind), `kind-${item.kind ?? 'life'}`));
        row.appendChild(mk('span', 'growth-tpl-title', item.title ?? ''));
        row.appendChild(mk('span', 'growth-muted', `${num(item.estimateMin)} 分钟 · 难度 ${num(item.difficulty)}`));
        row.appendChild(mk('span', 'growth-spacer'));
        row.appendChild(
          mkButton(item.enabled ? '停用' : '启用', 'growth-btn is-ghost is-sm', () =>
            run(() => toggleTemplate(item, !item.enabled)),
          ),
        );
        row.appendChild(mkButton('删除', 'growth-btn is-ghost is-sm', () => run(() => deleteTemplate(item))));
        customList.appendChild(row);
      }
    } else {
      customList.appendChild(mk('p', 'growth-muted', '还没有自定义模板。下面加一条你自己的日常事项。'));
    }
    built.node.appendChild(customList);
    built.node.appendChild(buildTemplateForm());

    const details = mk('details', 'growth-details');
    details.appendChild(mk('summary', 'growth-details-summary', '内置模板（点一下切换启用）'));
    const chips = mk('div', 'growth-chips');
    for (const item of Array.isArray(t.builtin) ? t.builtin : []) {
      const chip = mkButton(item.title ?? '', `growth-chip${item.enabled ? ' is-on' : ''}`, () =>
        run(() => toggleTemplate(item, !item.enabled)),
      );
      chip.title = `${item.title ?? ''} · ${num(item.estimateMin)} 分钟`;
      chips.appendChild(chip);
    }
    details.appendChild(chips);
    built.node.appendChild(details);
    return built.node;
  }

  function renderDataCard() {
    const overview = ui.overview ?? {};
    const counts = overview.dataCounts ?? {};
    const built = card('本机数据', '全部离线，不上传');
    if (ui.errors.overview) built.node.appendChild(showErrorBox(ui.errors.overview));
    const kv = mk('div', 'growth-kv-row');
    kv.append(
      kvItem('数据目录', overview.dataDir ?? '—'),
      kvItem('任务', num(counts.tasks)),
      kvItem('状态', num(counts.states)),
      kvItem('计划', num(counts.plans)),
      kvItem('日志', num(counts.logs)),
      kvItem('会话', num(counts.sessions)),
    );
    built.node.appendChild(kv);

    const row = mk('div', 'growth-row');
    row.appendChild(mkButton('允许系统通知', 'growth-btn', () => run(requestNotifications)));
    row.appendChild(mkButton('手动存档', 'growth-btn', () => run(snapshotNow)));
    row.appendChild(mkButton('结束会话', 'growth-btn is-danger', () => run(shutdownSession)));
    built.node.appendChild(row);
    built.node.appendChild(
      mk('p', 'growth-muted growth-footnote', '「结束会话」只结束成长模块的这次会话并写存档，不会关掉整个智学程序。'),
    );
    return built.node;
  }

  function renderBackupCard() {
    const built = card('备份与恢复', '整库 JSON，能带走也能放回来');
    built.node.appendChild(
      mk('p', 'growth-muted', '备份包含状态、计划、任务、角色、模板覆盖与日志。默认不含 AI Key（备份文件可能会被分享）。'),
    );
    const restoreInput = mk('input', 'growth-restore-input');
    restoreInput.type = 'file';
    restoreInput.accept = 'application/json,.json';
    restoreInput.hidden = true;
    restoreInput.addEventListener('change', async () => {
      const file = restoreInput.files?.[0];
      restoreInput.value = '';
      if (file) await restoreFile(file);
    });

    const row = mk('div', 'growth-row');
    row.appendChild(downloadFile('导出备份', '/backup', `growth-backup-${currentDate() || 'export'}.json`));
    // 兼容旧备份接口的 `?secrets=1`：成长模块**不持有** AI Key，所以这份导出同样不含 Key，
    // 文案必须如实（原来写“含 AI Key”会让人以为导出的文件里有密钥）。
    const secrets = downloadFile('导出（兼容旧版参数）', '/backup?secrets=1', `growth-backup-${currentDate() || 'export'}.json`, 'growth-btn is-ghost');
    secrets.title = '与普通导出相同：成长模块不保存 AI Key，文件里不会有密钥';
    row.appendChild(secrets);
    row.appendChild(
      mkButton('选择备份文件恢复…', 'growth-btn is-ghost', () => {
        if (typeof restoreInput.click === 'function') restoreInput.click();
        else notify('不支持', '这个窗口不能选择文件');
      }),
    );
    built.node.appendChild(row);
    built.node.appendChild(restoreInput);

    built.node.appendChild(
      mk('p', 'growth-muted growth-footnote', '恢复前会先把当前数据存到 data/archive/pre-restore-*.json，恢复错了还能回去。'),
    );
    return built.node;
  }

  function renderSettingsBody() {
    const body = mk('div', 'growth-tab-body growth-settings');
    body.append(
      renderSettingsFormCard(),
      renderAiCard(),
      renderTemplateCard(),
      renderDataCard(),
      renderBackupCard(),
    );
    return body;
  }

  /* ------------------------------------------------------------ 主渲染 */

  function renderSkeleton() {
    return mk('div', 'growth-skeleton', '正在载入成长数据…');
  }

  function renderUnavailable() {
    const root = mk('div', `view-content growth-view growth-unavailable${isNarrow() ? ' growth-narrow' : ''}`);
    const node = mk('section', 'growth-card growth-disabled');
    node.append(
      mk('h2', 'growth-disabled-title', '成长模块未启用'),
      mk(
        'p',
        'growth-disabled-text',
        '后端没有安装 growth 模块（/api/v1/growth/* 返回 404），或当前版本还不包含这个功能。',
      ),
      mk('p', 'growth-disabled-hint', '装好模块后点「重试」即可，不需要重启窗口。'),
    );
    node.appendChild(mkButton('重试', 'growth-btn is-primary', () => run(reload)));
    root.appendChild(node);
    return root;
  }

  function renderHeader() {
    const day = ui.today ?? {};
    const date = String(day.date ?? window.PCUtil?.todayKey?.() ?? '');
    const weekday = weekdayOf(date);
    const stats = day.stats ?? {};
    const mode = day.state?.mode;

    let summary = '今天还没录入状态';
    if (day.plan) {
      summary = `${modeLabel(mode)}模式 · 任务 ${num(stats.done)}/${num(stats.total)} · 投入 ${num(stats.minutesDone)} 分钟`;
    } else if (day.state) {
      summary = `就绪度 ${num(day.state.score)} · 还没生成任务表单`;
    }

    const head = mk('header', 'growth-head');
    const titles = mk('div', 'growth-head-text');
    titles.append(
      mk('h2', 'growth-title', '成长'),
      mk('p', 'growth-sub', `${date ? `${date}${weekday ? ` · ${weekday}` : ''} · ` : ''}${summary}`),
    );

    const chips = mk('div', 'growth-head-chips');
    const ch = ui.character ?? {};
    const progress = Number.isFinite(Number(ch.progress))
      ? Number(ch.progress)
      : ch.xpForNext
        ? num(ch.xpIntoLevel) / Math.max(1, num(ch.xpForNext))
        : 1;

    const level = mk('div', 'growth-level');
    level.title = '等级与经验';
    const levelTop = mk('div', 'growth-level-top');
    levelTop.append(
      mk('span', 'growth-level-num', `Lv.${num(ch.level, 1)}`),
      mk('span', 'growth-level-xp', `${num(ch.xpIntoLevel)} / ${ch.xpForNext == null ? 'MAX' : num(ch.xpForNext)}`),
    );
    const levelBar = mk('div', 'growth-level-bar');
    const levelFill = mk('i');
    setWidth(levelFill, progress * 100);
    levelBar.appendChild(levelFill);
    level.append(levelTop, levelBar);
    chips.appendChild(level);

    const streak = mk('div', 'growth-streak');
    streak.title = '连续有产出的天数';
    streak.append(mk('span', 'growth-streak-flame', '▲'), mk('b', null, String(num(ch.streak))), mk('span', null, '天'));
    chips.appendChild(streak);
    chips.appendChild(mkButton('刷新', 'growth-btn is-ghost is-sm', () => run(reload)));

    head.append(titles, chips);
    return head;
  }

  function renderTabs() {
    const bar = mk('div', 'growth-tabs');
    bar.setAttribute('role', 'tablist');
    for (const tab of TABS) {
      const active = ui.tab === tab.id;
      const button = mk('button', `growth-tab${active ? ' is-active' : ''}`, tab.label);
      button.type = 'button';
      button.dataset.tab = tab.id;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.addEventListener('click', () => selectTab(tab.id));
      bar.appendChild(button);
    }
    return bar;
  }

  function selectTab(tabId) {
    if (tabId === ui.tab || !TABS.some((tab) => tab.id === tabId)) return;
    ui.tab = tabId;
    ui.actionError = null;
    ui.renaming = false;
    // 切页要回顶部：这里直接重画而不走 keepScroll —— 外壳的 keepScroll 会在下一帧
    // 异步还原旧位置，把我们刚写进去的 0 又盖掉。等新页数据回来后的 paint() 再负责保位置。
    paintInner();
    const scroller = ui.mount?.querySelector?.('.view-content');
    if (scroller) scroller.scrollTop = 0;
    run(async () => {
      await loadTab(tabId, loadSeq);
      if (ui.tab === tabId) paint();
    });
  }

  function renderBody() {
    if (ui.tab === 'character') return renderCharacterBody();
    if (ui.tab === 'week') return renderWeekBody();
    if (ui.tab === 'settings') return renderSettingsBody();
    return renderToday();
  }

  function paintInner() {
    const mount = ui.mount;
    if (!mount) return;
    mount.textContent = '';
    if (ui.unavailable) {
      mount.appendChild(renderUnavailable());
      return;
    }

    const root = mk('div', `view-content growth-view${isNarrow() ? ' growth-narrow' : ''}`);
    root.appendChild(renderHeader());
    if (ui.error) root.appendChild(showErrorBox(ui.error));
    if (ui.actionError) root.appendChild(actionErrorBox(ui.actionError));
    root.appendChild(renderTabs());

    if (ui.loading && !ui.loadedOnce) {
      root.appendChild(renderSkeleton());
    } else {
      root.appendChild(renderBody());
    }
    mount.appendChild(root);
  }

  function paint() {
    if (!ui.mount) return;
    if (typeof window.PC?.keepScroll === 'function') window.PC.keepScroll(paintInner);
    else paintInner();
  }

  function render({ mount }) {
    ui.mount = mount;
    paint();
    void reload();
  }

  /* ------------------------------------------------------------ 注册 */

  window.PCModules.register({
    id: 'growth',
    label: '成长',
    icon: 'chart',
    order: 50,
    title: '成长',
    render,
  });

  // 测试 / 维护缝：不新增全局变量，仍走 PCModules 的 service 注册表。
  window.PCModules.service('growth', {
    refresh: () => reload(),
    submitState: (fields) => saveState(fields),
    state: ui,
  });
})();
