/**
 * 学业情况视图（左栏「学业」，order 40）。
 *
 * 这一页要回答三个问题，顺序也就是从上到下的排布：
 *   1. **我现在多少分** —— 学分绩 / 加权平均分 / 已修学分；
 *   2. **AI 怎么看** —— 一段学情分析（同步后自动生成；拿不到 AI 时是本地统计摘要，
 *      界面会如实标明来源，不会把本地统计说成"AI 点评"）；
 *   3. **每一项算不算** —— 成绩表里每行一个勾，勾选变化立刻重算，这就是题面要的
 *      「计算学分绩对每一项成绩都是可选的」。
 *
 * 几个刻意的取舍：
 *   - 学分绩**由后端算**（`/academic/stats`），前端只展示。同一套口径只能在服务端有一份，
 *     否则两边算法漂移时，用户会看到两个不一样的数字而不知道该信哪个。
 *   - 勾选走的是「单项 / 批量 / 重置」三个后端接口，前端不自己拼库。
 *   - 分析是**过期**的（成绩或勾选变了）时会明确提示，而不是继续拿旧结论糊弄人。
 */

(function () {
  const ui = {
    mount: null,
    loading: false,
    busy: null,
    error: null,
    /** 登录表单的临时输入 */
    login: { username: '', password: '', visible: false },
    status: null,
    grades: [],
    stats: null,
    terms: [],
    /** undefined = 还没有分析；null = 读取失败 */
    analysis: undefined,
    filter: { term: '', onlyFailed: false, onlyExcluded: false },
  };

  const academicView = {
    title: '学业',
    render(ctx) {
      ui.mount = ctx.mount;
      paint();
      void loadAll();
    },
  };

  /* ------------------------------------------------------------ 取数 */

  async function loadAll() {
    ui.loading = true;
    ui.error = null;
    paint();
    try {
      ui.status = await PC.api('/academic/status');
      if (ui.status?.loggedIn) {
        await Promise.all([loadGrades(), loadTerms(), loadAnalysis()]);
        await ensureAnalysis();
      }
    } catch (error) {
      ui.error = error;
    } finally {
      ui.loading = false;
      paint();
    }
  }

  /**
   * 有成绩却没有分析时，自动补一段。
   *
   * 为什么需要这一步：**登录本身也会同步**（`/academic/login` 顺手拉一次成绩），
   * 但那条路径不会生成分析，于是"第一次进来什么都没有、必须手动点一次同步"
   * —— 而用户刚登录完，最想看到的恰恰就是那段点评。
   * 这里以"有没有成绩"为准而不是"刚才有没有点同步"，所以无论数据是被谁、
   * 通过哪条路径同步进来的，进来都能看到分析。
   */
  async function ensureAnalysis() {
    if (ui.analysis?.available) return;
    if (!(ui.stats?.includedCount > 0)) return;
    try {
      // 不带 force：数据没变时后端会命中缓存，不会重复烧 token
      ui.analysis = await PC.api('/academic/analysis', { method: 'POST', body: { force: false } });
    } catch (error) {
      // 补分析失败不该挡住成绩展示
      ui.analysis = null;
      if (!ui.error) ui.error = error;
    }
  }

  async function loadGrades() {
    const query = new URLSearchParams();
    if (ui.filter.term) query.set('term', ui.filter.term);
    const suffix = query.toString() ? `?${query}` : '';
    const [grades, stats] = await Promise.all([
      PC.api(`/academic/grades${suffix}`),
      PC.api(`/academic/stats${suffix}`),
    ]);
    ui.grades = grades?.items ?? [];
    ui.stats = stats ?? null;
  }

  async function loadTerms() {
    const result = await PC.api('/academic/terms');
    ui.terms = result?.items ?? [];
  }

  async function loadAnalysis() {
    try {
      ui.analysis = await PC.api('/academic/analysis');
    } catch {
      ui.analysis = null;
    }
  }

  /* ------------------------------------------------------------ 动作 */

  async function withBusy(key, fn) {
    ui.busy = key;
    ui.error = null;
    paint();
    try {
      await fn();
    } catch (error) {
      ui.error = error;
    } finally {
      ui.busy = null;
      paint();
    }
  }

  const doLogin = () =>
    withBusy('login', async () => {
      const result = await PC.api('/academic/login', {
        method: 'POST',
        body: { username: ui.login.username.trim(), password: ui.login.password },
      });
      ui.login.password = '';
      if (result?.status !== 'ready') {
        ui.error = new Error(result?.error ?? '登录未完成，请检查账号与密码');
        return;
      }
      ui.login.visible = false;
      await loadAll();
    });

  const doSync = () =>
    withBusy('sync', async () => {
      await PC.api('/academic/sync/apply', { method: 'POST', body: {} });
      await Promise.all([loadTerms(), loadGrades()]);
      // 同步完顺手要一段新的分析 —— 这正是「每次同步学分绩后展示学情分析」的落点
      await analyze(true);
    });

  /**
   * 生成学情分析。
   * @param {boolean} force 真的重新生成（否则数据没变时后端会命中缓存）
   */
  async function analyze(force) {
    try {
      ui.analysis = await PC.api('/academic/analysis', { method: 'POST', body: { force: Boolean(force) } });
    } catch (error) {
      ui.analysis = null;
      ui.error = error;
    }
  }

  const doAnalyze = () => withBusy('analyze', () => analyze(true));

  const doLogout = () =>
    withBusy('logout', async () => {
      await PC.api('/academic/logout', { method: 'POST', body: {} });
      ui.grades = [];
      ui.stats = null;
      ui.analysis = undefined;
      await loadAll();
    });

  const toggleOne = (id, included) =>
    withBusy(`row:${id}`, async () => {
      const result = await PC.api(`/academic/grades/${id}/included`, { method: 'POST', body: { included } });
      ui.stats = result?.stats ?? ui.stats;
      const row = ui.grades.find((item) => item.id === id);
      if (row) row.included = Boolean(included);
    });

  const bulk = (body) =>
    withBusy('bulk', async () => {
      const result = await PC.api('/academic/grades/included/bulk', { method: 'POST', body });
      ui.stats = result?.stats ?? ui.stats;
      await loadGrades();
      await loadAnalysis();
    });

  const resetIncluded = () =>
    withBusy('reset', async () => {
      const result = await PC.api('/academic/grades/included/reset', { method: 'POST', body: {} });
      ui.stats = result?.stats ?? ui.stats;
      await loadGrades();
      await loadAnalysis();
    });

  /* ------------------------------------------------------------ 渲染

     结构必须与其它视图一致，否则会同时踩两个坑：
       mount 是 `.panel-body`，它的样式是 `display:flex; flex-direction:column; overflow:hidden`，
       **没有内边距、也不滚动**。所以内容要放进 `.view-content`
       （`flex:1; overflow:auto; padding:12px 14px 16px`）里 —— 滚动与留白都由它提供；
       按钮放 `.toolbar`（固定在顶部，不随内容滚走）。
     直接把内容 append 到 mount 上，就会表现为「贴边 + 不能滚」。 */

  function paint() {
    const mount = ui.mount;
    if (!mount) return;
    mount.innerHTML = '';

    if (ui.loading && !ui.status) {
      const content = mk('div', 'view-content');
      content.appendChild(viewHeader());
      content.appendChild(mk('p', 'ac-muted', '正在读取…'));
      mount.appendChild(content);
      return;
    }

    // 未登录：没有可操作的东西，不给工具条
    if (!ui.status?.loggedIn) {
      const content = mk('div', 'view-content');
      content.appendChild(viewHeader());
      if (ui.error) content.appendChild(errorBox(ui.error));
      content.appendChild(loginCard());
      mount.appendChild(content);
      return;
    }

    mount.appendChild(toolbar());

    const content = mk('div', 'view-content');
    content.appendChild(viewHeader());
    if (ui.error) content.appendChild(errorBox(ui.error));
    content.appendChild(statCards());
    content.appendChild(analysisCard());
    content.appendChild(bulkBar());
    content.appendChild(gradeTable());
    content.appendChild(attentionCard());

    if (ui.status?.lastError) {
      const box = mk('div', 'ac-warn');
      box.appendChild(mk('strong', null, '上次同步失败：'));
      box.appendChild(mk('span', null, ui.status.lastError.message ?? ''));
      content.appendChild(box);
    }
    mount.appendChild(content);
  }

  function viewHeader() {
    const head = mk('div', 'ac-head');
    head.appendChild(mk('h2', 'ac-title', '学业情况'));
    head.appendChild(
      mk('p', 'ac-sub', '成绩来自本科教务系统。学分绩只统计你勾选的课程，每一门都可以单独选择算不算。'),
    );
    return head;
  }

  function loginCard() {
    const card = mk('section', 'ac-card');
    card.appendChild(mk('h3', 'ac-card-title', '先登录教务系统'));
    card.appendChild(
      mk('p', 'ac-muted', '登录用的是学校统一身份认证，账号密码只发往学校，本程序不保存。'),
    );
    if (ui.status?.captchaRequired) {
      card.appendChild(mk('p', 'ac-warn-inline', '登录失败次数较多，需要图形验证码（稍后版本支持）。'));
    }

    const form = mk('div', 'ac-form');
    const user = mk('input', 'ac-input');
    user.type = 'text';
    user.placeholder = '学号';
    user.autocomplete = 'username';
    user.value = ui.login.username;
    user.addEventListener('input', () => {
      ui.login.username = user.value;
    });

    const pass = mk('input', 'ac-input');
    pass.type = 'password';
    pass.placeholder = '密码';
    pass.autocomplete = 'current-password';
    pass.value = ui.login.password;
    pass.addEventListener('input', () => {
      ui.login.password = pass.value;
    });
    pass.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void doLogin();
    });

    form.appendChild(user);
    form.appendChild(pass);

    const submit = mk('button', 'primary-btn', ui.busy === 'login' ? '登录中…' : '登录并同步');
    submit.type = 'button';
    submit.disabled = ui.busy === 'login' || !ui.login.username.trim() || !ui.login.password;
    submit.addEventListener('click', () => void doLogin());
    form.appendChild(submit);

    card.appendChild(form);
    return card;
  }

  function toolbar() {
    // 用共享的 `.toolbar`：它自带左右内边距与下边框，并固定在内容区上方不随滚动
    const bar = mk('div', 'toolbar wrap');
    const title = mk('div', 'toolbar-title', '学业');
    bar.appendChild(title);

    /**
     * 同步按钮。
     *
     * 注意 `ui.status.syncing`：登录成功后后端会**自动补一次同步**（见
     * academic/service.js 的 #autoSyncIfEmpty）。那一次不是用户点的，
     * `ui.busy` 不会变 —— 不看这个标志的话，用户登录完切过来只看到一片空白，
     * 会以为登录没生效，然后又点一次同步（撞上 409）。
     */
    const autoSyncing = Boolean(ui.status?.syncing) && ui.busy !== 'sync';
    const sync = mk('button', 'primary-btn', ui.busy === 'sync' || autoSyncing ? '同步中…' : '同步成绩');
    sync.type = 'button';
    sync.disabled = Boolean(ui.busy) || autoSyncing;
    sync.addEventListener('click', () => void doSync());
    bar.appendChild(sync);

    const analyzeBtn = mk('button', 'ghost-btn', ui.busy === 'analyze' ? '生成中…' : '重新生成分析');
    analyzeBtn.type = 'button';
    analyzeBtn.disabled = Boolean(ui.busy);
    analyzeBtn.addEventListener('click', () => void doAnalyze());
    bar.appendChild(analyzeBtn);

    const select = mk('select', 'ac-select');
    select.appendChild(option('', '全部学期', ui.filter.term === ''));
    for (const item of ui.terms) select.appendChild(option(item.term, item.label ?? item.term, ui.filter.term === item.term));
    select.addEventListener('change', () => {
      ui.filter.term = select.value;
      void withBusy('filter', async () => {
        await loadGrades();
        await loadAnalysis();
      });
    });
    bar.appendChild(select);

    bar.appendChild(mk('span', 'spacer'));

    if (ui.status?.lastSyncAt) {
      bar.appendChild(mk('span', 'ac-muted', `上次同步 ${formatStamp(ui.status.lastSyncAt)}`));
    }

    const logout = mk('button', 'ghost-btn', '退出登录');
    logout.type = 'button';
    logout.disabled = Boolean(ui.busy);
    logout.addEventListener('click', () => void doLogout());
    bar.appendChild(logout);

    return bar;
  }

  function statCards() {
    const wrap = mk('div', 'ac-stats');
    const stats = ui.stats ?? {};
    wrap.appendChild(statCard('学分绩', formatGpa(stats.gpa), `${stats.includedCount ?? 0} 门课计入`));
    wrap.appendChild(statCard('加权平均分', formatNumber(stats.weightedAverage, 2), '按学分加权'));
    wrap.appendChild(
      statCard('参与计算的学分', formatNumber(stats.totalCredits, 2), `其中已获得 ${formatNumber(stats.earnedCredits, 1)}`),
    );
    return wrap;
  }

  function statCard(label, value, hint) {
    const card = mk('div', 'ac-stat');
    card.appendChild(mk('div', 'ac-stat-label', label));
    card.appendChild(mk('div', 'ac-stat-value', value));
    if (hint) card.appendChild(mk('div', 'ac-stat-hint', hint));
    return card;
  }

  function analysisCard() {
    const card = mk('section', 'ac-card ac-analysis');

    const header = mk('div', 'ac-card-head');
    header.appendChild(mk('h3', 'ac-card-title', '学情分析'));

    const state = ui.analysis;
    if (state?.available !== false && state?.source) {
      const badge = mk('span', `ac-badge ac-badge-${state.source}`, state.source === 'ai' ? 'AI 点评' : '本地统计');
      header.appendChild(badge);
    }
    if (state?.stale) header.appendChild(mk('span', 'ac-badge ac-badge-stale', '已过期'));
    card.appendChild(header);

    if (ui.busy === 'analyze') {
      card.appendChild(mk('p', 'ac-muted', '正在生成…'));
      return card;
    }
    if (!state || state.available === false) {
      card.appendChild(
        mk(
          'p',
          'ac-muted',
          state?.hasData === false
            ? '还没有可用于分析的成绩，先同步一次。'
            : '还没有学情分析。同步成绩后会自动生成一段。',
        ),
      );
      return card;
    }

    card.appendChild(mk('p', 'ac-analysis-text', state.text ?? ''));

    const meta = [];
    if (state.createdAt) meta.push(`生成于 ${formatStamp(state.createdAt)}`);
    if (state.model) meta.push(`模型 ${state.model}`);
    if (state.stale) meta.push('成绩或勾选已变化，建议重新生成');
    if (state.error) meta.push(`未使用 AI：${state.error}`);
    if (meta.length) card.appendChild(mk('p', 'ac-analysis-meta', meta.join(' · ')));

    return card;
  }

  function bulkBar() {
    const bar = mk('div', 'ac-bulk');
    bar.appendChild(mk('span', 'ac-bulk-label', '批量：'));

    const actions = [
      ['全部计入', () => bulk({ only: 'all', included: true })],
      ['全部排除', () => bulk({ only: 'all', included: false })],
      [ui.filter.term ? '本学期排除' : '本学期排除（先选学期）', () => ui.filter.term && bulk({ term: ui.filter.term, included: false })],
      ['不及格排除', () => bulk({ only: 'failed', included: false })],
      ['恢复默认', () => resetIncluded()],
    ];
    for (const [label, handler] of actions) {
      const button = mk('button', 'ghost-btn small', label);
      button.type = 'button';
      button.disabled = Boolean(ui.busy) || (label.includes('先选学期') && !ui.filter.term);
      button.addEventListener('click', () => void handler());
      bar.appendChild(button);
    }
    return bar;
  }

  /**
   * 成绩明细，**按学期分组**。
   *
   * 为什么分组：一屏几十门课平铺下来，用户很难看出"这学期几门、多少学分、学期绩点多少"，
   * 也分不清哪些课属于同一学期。每个学期插一行小标题（学期名 + 门数 + 学分 + 学期绩点），
   * 既是视觉分隔，也顺带把该学期的口径摊开 —— 数据直接取自 `stats.terms`，不另算一套。
   */
  function gradeTable() {
    const card = mk('section', 'ac-card');
    const head = mk('div', 'ac-card-head');
    head.appendChild(mk('h3', 'ac-card-title', `成绩明细（${ui.grades.length} 门）`));
    head.appendChild(mk('span', 'ac-muted', '取消勾选的课程不计入学分绩'));
    card.appendChild(head);

    if (!ui.grades.length) {
      card.appendChild(mk('p', 'ac-muted', '这个范围内没有成绩。'));
      return card;
    }

    // 学期口径索引（stats.terms 与列表用的是同一套计算）
    const termStats = new Map((ui.stats?.terms ?? []).map((item) => [item.term, item]));

    // 按学期分组，保持 listGrades 已有的排序（学期倒序、学期内按课程名）
    const groups = [];
    for (const grade of ui.grades) {
      const key = grade.term ?? '';
      let group = groups.find((item) => item.term === key);
      if (!group) {
        group = { term: key, label: grade.termLabel ?? key ?? '未标注学期', grades: [] };
        groups.push(group);
      }
      group.grades.push(grade);
    }

    const table = mk('table', 'ac-table');
    const thead = mk('thead');
    const headRow = mk('tr');
    for (const [label, className] of [
      ['计入', 'ac-col-check'],
      ['课程', ''],
      ['学分', 'ac-col-num'],
      ['成绩', 'ac-col-num'],
      ['绩点', 'ac-col-num'],
      ['性质', ''],
    ]) {
      headRow.appendChild(mk('th', className, label));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = mk('tbody');
    for (const group of groups) {
      // --- 学期分隔行 ---
      const termRow = mk('tr', 'ac-term-row');
      const termCell = mk('td', null);
      termCell.colSpan = 6;

      const termHead = mk('div', 'ac-term-head');
      termHead.appendChild(mk('span', 'ac-term-name', group.label));

      const stat = termStats.get(group.term);
      const chips = [`${group.grades.length} 门`];
      const credits = termCellCredits(group.grades);
      if (credits > 0) chips.push(`${credits} 学分`);
      if (stat && typeof stat.gpa === 'number') chips.push(`学期学分绩 ${stat.gpa.toFixed(3)}`);
      // 只统计被纳入的：与上方总分口径保持一致，避免用户以为"这门没算进去"
      const includedCount = group.grades.filter((item) => item.included !== false).length;
      if (includedCount !== group.grades.length) chips.push(`已计入 ${includedCount} 门`);
      termHead.appendChild(mk('span', 'ac-term-meta', chips.join(' · ')));

      termCell.appendChild(termHead);
      termRow.appendChild(termCell);
      tbody.appendChild(termRow);

      // --- 该学期的课程行 ---
      for (const grade of group.grades) {
        tbody.appendChild(gradeRow(grade));
      }
    }
    table.appendChild(tbody);
    card.appendChild(table);
    return card;
  }

  /** 一组课程的学分合计（只看有数值的）。 */
  function termCellCredits(list) {
    return list.reduce((sum, item) => sum + (typeof item.credit === 'number' ? item.credit : 0), 0);
  }

  /** 单门课的一行。 */
  function gradeRow(grade) {
    const row = mk('tr', grade.included === false ? 'ac-row-off' : '');
    if (grade.stale) row.classList.add('ac-row-stale');

    const checkCell = mk('td', 'ac-col-check');
    const check = mk('input');
    check.type = 'checkbox';
    check.checked = grade.included !== false;
    check.disabled = ui.busy === `row:${grade.id}`;
    check.addEventListener('change', () => void toggleOne(grade.id, check.checked));
    checkCell.appendChild(check);
    row.appendChild(checkCell);

    const nameCell = mk('td');
    nameCell.appendChild(mk('span', 'ac-course', grade.courseName || grade.courseCode || '(未命名)'));
    if (grade.stale) nameCell.appendChild(mk('span', 'ac-tag', '本次未返回'));
    if ((grade.gradePointResolved ?? grade.gradePoint) === null && grade.included === false) {
      nameCell.appendChild(mk('span', 'ac-tag', '等级制'));
    }
    row.appendChild(nameCell);

    row.appendChild(mk('td', 'ac-col-num', formatNumber(grade.credit, 1)));
    row.appendChild(mk('td', 'ac-col-num', formatScore(grade)));
    row.appendChild(mk('td', 'ac-col-num', formatGpa(grade.gradePointResolved ?? grade.gradePoint)));
    row.appendChild(mk('td', 'ac-muted', grade.natureLabel ?? ''));

    return row;
  }

  function attentionCard() {
    const list = ui.stats?.needsAttention ?? [];
    const warnings = ui.stats?.warnings ?? [];
    if (!list.length && !warnings.length) return mk('span');

    const card = mk('section', 'ac-card');
    card.appendChild(mk('h3', 'ac-card-title', '需要留意'));

    for (const warning of warnings) card.appendChild(mk('p', 'ac-muted', `· ${warning}`));

    if (list.length) {
      card.appendChild(
        mk(
          'p',
          'ac-muted',
          `下面 ${list.length} 门是等级制或其他未识别的成绩形式，没有绩点、默认不计入学分绩；如果你希望它们参与，学校口径也需要先给出绩点。`,
        ),
      );
      const ul = mk('ul', 'ac-attention');
      for (const item of list) {
        ul.appendChild(mk('li', null, `${item.courseName}（${item.termLabel ?? item.term ?? ''}${item.scoreText ? ` · ${item.scoreText}` : ''}）`));
      }
      card.appendChild(ul);
    }
    return card;
  }

  /* ------------------------------------------------------------ 格式化 */

  function formatGpa(value) {
    return typeof value === 'number' ? value.toFixed(3) : '—';
  }

  function formatNumber(value, digits) {
    return typeof value === 'number' ? value.toFixed(digits) : '—';
  }

  /** 成绩可能是数值，也可能只有等级文本（优秀/良好）。 */
  function formatScore(grade) {
    if (typeof grade.score === 'number') return String(grade.score);
    if (grade.finalScoreText) return grade.finalScoreText;
    if (grade.levelGrade) return grade.levelGrade;
    return '—';
  }

  function formatStamp(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  window.PCModules.register({
    id: 'academic',
    label: '学业',
    icon: '📈',
    order: 40,
    title: '学业',
    render: (ctx) => academicView.render(ctx),
  });
})();
