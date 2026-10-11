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
      }
    } catch (error) {
      ui.error = error;
    } finally {
      ui.loading = false;
      paint();
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

  /* ------------------------------------------------------------ 渲染 */

  function paint() {
    const mount = ui.mount;
    if (!mount) return;
    mount.innerHTML = '';

    const head = mk('div', 'ac-head');
    head.appendChild(mk('h2', 'ac-title', '学业情况'));
    head.appendChild(
      mk('p', 'ac-sub', '成绩来自本科教务系统。学分绩只统计你勾选的课程，每一门都可以单独选择算不算。'),
    );
    mount.appendChild(head);

    if (ui.error) mount.appendChild(errorBox(ui.error));

    if (ui.loading && !ui.status) {
      mount.appendChild(mk('p', 'ac-muted', '正在读取…'));
      return;
    }

    if (!ui.status?.loggedIn) {
      mount.appendChild(loginCard());
      return;
    }

    mount.appendChild(toolbar());
    mount.appendChild(statCards());
    mount.appendChild(analysisCard());
    mount.appendChild(bulkBar());
    mount.appendChild(gradeTable());
    mount.appendChild(attentionCard());

    if (ui.status?.lastError) {
      const box = mk('div', 'ac-warn');
      box.appendChild(mk('strong', null, '上次同步失败：'));
      box.appendChild(mk('span', null, ui.status.lastError.message ?? ''));
      mount.appendChild(box);
    }
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
    const bar = mk('div', 'ac-toolbar');

    const sync = mk('button', 'primary-btn', ui.busy === 'sync' ? '同步中…' : '同步成绩');
    sync.type = 'button';
    sync.disabled = Boolean(ui.busy);
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

    const spacer = mk('span', 'ac-spacer');
    bar.appendChild(spacer);

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

    const table = mk('table', 'ac-table');
    const thead = mk('thead');
    const headRow = mk('tr');
    for (const [label, className] of [
      ['计入', 'ac-col-check'],
      ['课程', ''],
      ['学分', 'ac-col-num'],
      ['成绩', 'ac-col-num'],
      ['绩点', 'ac-col-num'],
      ['学期', ''],
      ['性质', ''],
    ]) {
      const th = mk('th', className, label);
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = mk('tbody');
    for (const grade of ui.grades) {
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
      row.appendChild(mk('td', 'ac-muted', grade.termLabel ?? grade.term ?? ''));
      row.appendChild(mk('td', 'ac-muted', grade.natureLabel ?? ''));

      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    card.appendChild(table);
    return card;
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
