/**
 * 学习周报面板 —— **挂在「待办」页里的子功能**，不占左栏入口。
 *
 * 为什么放在这里而不是做成第四个左栏页：
 * 周报回答的是"这周到底做了什么"，它和待办是同一件事的两个时刻（先列出来、做完再看）。
 * 入口放在待办页顶部，用户不用在左栏多记一个位置；面板打开时**替换**待办列表那一块内容，
 * 关掉就回到列表 —— 既不挤占主列表，也不会让人以为"待办页变成周报页了"。
 *
 * 与后端的分工（本文件**只读地组合**，不复制任何统计口径）：
 *   - `GET /weekly/report?from=&to=` 给现算统计 + 缓存正文（**永不调用模型**）；
 *   - `POST /weekly/report/generate` 是**唯一**会花 token 的动作，只在点按钮时发生；
 *   - `GET /weekly/reports` 给历史列表，`DELETE /weekly/reports/:id` 删除一条。
 *   `fallback: true` 表示"这次没能写成文章"，页面上必须**如实标出**，不能把规则小结伪装成 AI 写的。
 *
 * 三条硬约定（与其它视图一致）：
 *   1. 所有文本走 textContent（等价转义），**不写 inline style**（CSP 的 `style-src 'self'` 会拦），
 *      颜色只用主题令牌；
 *   2. 面板里任何请求失败都落到页面内的错误条，**绝不 `alert()`**；
 *   3. `PCModules.service('weeklyPanel', ...)` 暴露给待办页，不直接改外壳代码。
 */

(function () {
  'use strict';

  /** `missing[].reason` → 一句人话。 */
  const MISSING_REASON = {
    unavailable: '这个数据源还没装好',
    partial: '只取到了一部分',
    read_failed: '读取失败',
  };

  /** 四个数据源的中文名（与 `weekly/sources.js` 的 SOURCE_LABEL 同步）。 */
  const SOURCE_LABEL = {
    conversations: 'AI 对话',
    notes: '笔记',
    schedule: '待办',
    grades: '成绩',
  };

  const ui = {
    /** 面板是否打开（跨待办页重画保留：切换筛选不该把周报悄悄关掉）。 */
    open: false,
    host: null,
    loading: false,
    error: null,
    /** `'generate' | 'force' | 'delete:<id>'`：同一时刻只允许一个动作在跑。 */
    busy: null,
    /** 当前展示区间的 `GET /weekly/report` 响应（含 stats 与缓存正文）。 */
    view: null,
    reports: null,
    /** 看的是历史某一周时记下区间；null = 本周。 */
    selected: null,
    /** 需要二次确认的删除（不弹原生对话框）。 */
    confirming: null,
    /** 防止旧请求盖掉新请求（切周、关面板、连续刷新都会发生）。 */
    requestId: 0,
  };

  /* ------------------------------------------------------------ 基础件 */

  function mk(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function button(label, className, onClick) {
    const node = mk('button', className, label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }

  function badge(text, kind) {
    return mk('span', `wk-badge${kind ? ` ${kind}` : ''}`, text);
  }

  function note(text) {
    return mk('div', 'wk-note', text);
  }

  function empty(text) {
    return mk('div', 'wk-empty', text);
  }

  function alertBox(title, message, kind = 'warn') {
    const box = mk('div', `wk-alert ${kind}`);
    box.appendChild(mk('div', 'wk-alert-title', title));
    box.appendChild(mk('div', 'wk-alert-msg', message));
    return box;
  }

  function formatStamp(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('zh-CN', { hour12: false });
  }

  /** 本周（周一 ~ 周日）：后端在都不传 from/to 时用的也是这个区间。 */
  function currentWeekRange() {
    const from = PCUtil.startOfWeek(PCUtil.todayKey());
    return { from, to: PCUtil.addDays(from, 6) };
  }

  function rangeOf() {
    return ui.selected ?? currentWeekRange();
  }

  function selectedLabel() {
    if (!ui.selected) return '生成本周周报';
    return `生成 ${ui.selected.from} ~ ${ui.selected.to} 的周报`;
  }

  /* ------------------------------------------------------------ 数据 */

  async function load({ quiet = false } = {}) {
    if (!ui.open) return;
    const id = ++ui.requestId;
    ui.error = null;
    if (!quiet) {
      ui.loading = true;
      paint();
    }
    const range = rangeOf();
    const query = `?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
    try {
      const [detail, list] = await Promise.all([PC.api(`/weekly/report${query}`), PC.api('/weekly/reports?limit=50')]);
      if (id !== ui.requestId) return;
      ui.view = detail ?? null;
      ui.reports = Array.isArray(list?.items) ? list.items : [];
    } catch (error) {
      if (id !== ui.requestId) return;
      ui.error = error?.message ?? String(error);
    } finally {
      if (id === ui.requestId) {
        ui.loading = false;
        paint();
      }
    }
  }

  /** 生成某一周：`force` 为真时重写已有正文（模型不可用会降级，仍然 200）。 */
  async function generate(force) {
    if (ui.busy) return;
    const range = rangeOf();
    ui.busy = force ? 'force' : 'generate';
    ui.error = null;
    paint();
    try {
      const data = await PC.api('/weekly/report/generate', {
        method: 'POST',
        body: { from: range.from, to: range.to, force: Boolean(force) },
      });
      if (data?.fallback) PC.toast('模型没写成，已生成客观统计小结（正文里标了降级）');
      else if (data?.cached) PC.toast('这一周已经有周报了，直接给你看缓存；要重写点「重新生成」');
      else PC.toast('周报已生成');
      await load({ quiet: true });
    } catch (error) {
      ui.error = error?.message ?? String(error);
    } finally {
      ui.busy = null;
      paint();
    }
  }

  async function removeReport(item) {
    const key = `delete:${item.id}`;
    if (ui.confirming !== key) {
      ui.confirming = key;
      paint();
      return;
    }
    ui.confirming = null;
    ui.busy = key;
    ui.error = null;
    paint();
    try {
      await PC.api(`/weekly/reports/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      if (ui.selected && ui.selected.from === item.from && ui.selected.to === item.to) ui.selected = null;
      PC.toast('已删除这份周报');
      await load({ quiet: true });
    } catch (error) {
      ui.error = error?.message ?? String(error);
    } finally {
      ui.busy = null;
      paint();
    }
  }

  function openReport(item) {
    ui.selected = { from: item.from, to: item.to };
    ui.confirming = null;
    void load();
  }

  function backToCurrent() {
    ui.selected = null;
    ui.confirming = null;
    void load();
  }

  /* ------------------------------------------------------------ 绘制 */

  function header() {
    const head = mk('div', 'wk-head');
    const main = mk('div', 'wk-head-main');
    const titleLine = mk('div', 'wk-title-line');
    titleLine.appendChild(button('← 返回待办', 'ghost-btn wk-back', () => closeAndRefresh()));
    titleLine.appendChild(mk('div', 'wk-title', '学习周报'));
    const range = ui.view ?? null;
    titleLine.appendChild(
      mk(
        'div',
        'wk-range',
        range ? `${range.week} · ${range.from} ~ ${range.to}（共 ${range.days} 天）` : `${rangeOf().from} ~ ${rangeOf().to}`,
      ),
    );
    main.appendChild(titleLine);
    main.appendChild(
      mk(
        'div',
        'wk-sub',
        ui.selected ? `正在看历史周报：${ui.selected.from} ~ ${ui.selected.to}` : '统计本周（周一 ~ 周日）的学习记录',
      ),
    );
    head.appendChild(main);

    const actions = mk('div', 'wk-actions');
    if (ui.selected) actions.appendChild(button('回到本周', 'ghost-btn', () => backToCurrent()));
    const generateBtn = button(
      ui.busy === 'generate' ? '生成中…（要等模型写完）' : selectedLabel(),
      'primary-btn',
      () => void generate(false),
    );
    generateBtn.disabled = Boolean(ui.busy);
    actions.appendChild(generateBtn);
    const refresh = button('刷新', 'ghost-btn', () => void load());
    refresh.disabled = Boolean(ui.busy);
    actions.appendChild(refresh);
    head.appendChild(actions);
    return head;
  }

  /** 统计表格：每个来源一行；`null` 一律显示「—」而不是 0（0 与"没数据"是两件事）。 */
  function statsCard(stats) {
    const card = mk('div', 'wk-card');
    card.appendChild(mk('div', 'wk-card-title', '客观统计（这一周）'));
    if (!stats) {
      card.appendChild(empty('这一周的统计还没读到。'));
      return card;
    }
    const rows = [];
    const push = (label, value) => rows.push([label, value === null || value === undefined ? '—' : String(value)]);

    const conversations = stats.conversations;
    if (conversations) {
      push('AI 对话', `新会话 ${conversations.newConversations} · 提问 ${conversations.userMessages} · 消息 ${conversations.messages}`);
    } else push('AI 对话', null);

    const notes = stats.notes;
    if (notes) push('笔记', `新建 ${notes.created} · 更新 ${notes.updated}（其中仅更新 ${notes.updatedOnly}）· 删除 ${notes.deleted}`);
    else push('笔记', null);

    const schedule = stats.schedule;
    if (schedule) {
      push(
        '待办',
        `新增 ${schedule.todosCreated} · 完成 ${schedule.todosCompleted} · 未完成 ${schedule.todosOpen} · 逾期 ${schedule.todosOverdue} · 7 天内 ${schedule.todosDueSoon}`,
      );
    } else push('待办', null);

    const grades = stats.grades;
    if (grades) {
      push(
        '成绩',
        `学分绩 ${grades.gpa ?? '—'} · 记录 ${grades.total ?? '—'} 条${grades.changed ? ` · 本周有 ${grades.updated} 条变动` : ''}`,
      );
    } else push('成绩', null);

    const table = mk('div', 'wk-table');
    for (const [label, value] of rows) {
      const line = mk('div', 'wk-table-row');
      line.appendChild(mk('span', 'wk-table-key', label));
      line.appendChild(mk('span', 'wk-table-value', value));
      table.appendChild(line);
    }
    card.appendChild(table);
    return card;
  }

  /** `missing[]` 如实列出：哪些数据源没取到、为什么。 */
  function missingCard(missing) {
    const list = Array.isArray(missing) ? missing : [];
    if (!list.length) return note('四个数据源这一周都读到了。');
    const box = mk('div', 'wk-missing');
    box.appendChild(mk('div', 'wk-missing-title', `这一周有 ${list.length} 处数据没取全（对应的数字是「—」，不是 0）`));
    for (const item of list) {
      const line = mk('div', 'wk-missing-line');
      line.appendChild(badge(SOURCE_LABEL[item.source] ?? item.source ?? '未知来源', 'ext'));
      line.appendChild(mk('span', null, `${MISSING_REASON[item.reason] ?? item.reason ?? '读取失败'}：${item.detail ?? ''}`));
      box.appendChild(line);
    }
    return box;
  }

  function reportCard(view) {
    const card = mk('div', 'wk-card');
    const head = mk('div', 'wk-card-head');
    head.appendChild(mk('div', 'wk-card-title', `${view.week ?? '本周'} · ${view.from} ~ ${view.to}`));
    const fallback = Boolean(view.fallback);
    const hasReport = Boolean(view.report);
    head.appendChild(badge(!hasReport ? '还没有正文' : fallback ? '降级：不是 AI 写的' : 'AI 撰写', !hasReport ? 'ext' : fallback ? 'fail' : 'ok'));
    card.appendChild(head);

    const meta = [
      view.generatedAt ? `生成于 ${formatStamp(view.generatedAt)}` : '',
      view.model ? `模型 ${view.model}` : '',
      view.reportTruncated ? '正文被截断到上限字数' : '',
      hasReport ? '' : '还没生成过正文',
    ]
      .filter(Boolean)
      .join(' · ');
    if (meta) card.appendChild(mk('div', 'wk-row-meta', meta));

    if (fallback) {
      // ★ 这是这一页最重要的一条诚实：降级结果不能伪装成 AI 写的
      card.appendChild(
        alertBox(
          '这次没能写成文章，下面是客观统计生成的规则小结',
          `原因：${view.reason ?? '模型不可用'}。这段文字不是任何模型写的，模型字段也为空。` +
            '想让它重写一次，点下面的「重新生成」。',
          'warn',
        ),
      );
    }
    if (view.statsChangedSinceReport) {
      card.appendChild(alertBox('这周的数据在生成之后又变了', '正文是生成当时的数字写的；想一致的版本就重新生成。', 'warn'));
    }

    const body = mk('div', 'wk-report');
    if (!hasReport) {
      body.appendChild(empty('这一周还没有正文。点「生成」会调用一次模型（未配置 AI 时降级为规则小结）。'));
    } else if (window.PCRichText) {
      // 模型输出按富文本渲染（Markdown 子集 + LaTeX 子集）；它自带转义，不直接注入原文 HTML
      window.PCRichText.render(body, view.report);
    } else {
      body.textContent = view.report; // 没有富文本组件时退回纯文本，宁可少渲染也不吞内容
    }
    card.appendChild(body);

    const actions = mk('div', 'wk-form-actions');
    const regenerate = button(ui.busy === 'force' ? '生成中…' : '重新生成（force）', 'ghost-btn', () => void generate(true));
    regenerate.disabled = Boolean(ui.busy);
    actions.appendChild(regenerate);
    if (view.hint) actions.appendChild(mk('span', 'wk-hint', view.hint));
    card.appendChild(actions);
    return card;
  }

  function historyCard() {
    const box = mk('div', 'wk-history');
    box.appendChild(mk('div', 'wk-subtitle', '历史周报'));
    const items = ui.reports ?? [];
    if (!items.length) {
      box.appendChild(empty('还没有任何周报。点上面的「生成本周周报」试试 —— 统计部分不依赖模型，一定能出来。'));
      return box;
    }
    const list = mk('div', 'wk-list');
    for (const item of items) {
      const active = ui.view && item.from === ui.view.from && item.to === ui.view.to;
      const row = mk('div', `wk-row${active ? ' current' : ''}`);
      const main = mk('div', 'wk-row-main');
      const titleLine = mk('div', 'wk-row-title');
      titleLine.appendChild(mk('span', 'wk-row-name', item.week ?? `${item.from} ~ ${item.to}`));
      titleLine.appendChild(badge(item.fallback ? '降级小结' : 'AI 撰写', item.fallback ? 'fail' : 'ok'));
      if (item.reportTruncated) titleLine.appendChild(badge('已截断', 'ext'));
      if (active) titleLine.appendChild(badge('正在看', 'ext'));
      main.appendChild(titleLine);
      main.appendChild(
        mk('div', 'wk-row-meta', [`${item.from} ~ ${item.to}`, `生成于 ${formatStamp(item.generatedAt)}`, item.model ?? '无模型'].join(' · ')),
      );
      const missingCount = Array.isArray(item.stats?.missing) ? item.stats.missing.length : 0;
      if (missingCount) main.appendChild(mk('div', 'wk-row-meta', `有 ${missingCount} 处数据没取全`));
      row.appendChild(main);

      const actions = mk('div', 'wk-row-actions');
      actions.appendChild(
        button(active ? '刷新正文' : '看正文', 'ghost-btn', () => {
          openReport(item);
        }),
      );
      const key = `delete:${item.id}`;
      actions.appendChild(
        button(
          ui.confirming === key ? '再点一次确认删除' : '删除',
          `ghost-btn wk-danger${ui.confirming === key ? ' confirming' : ''}`,
          () => void removeReport(item),
        ),
      );
      row.appendChild(actions);
      list.appendChild(row);
    }
    box.appendChild(list);
    return box;
  }

  function paint() {
    const host = ui.host;
    if (!host || !ui.open) return;
    host.innerHTML = '';
    const root = mk('section', 'wk-panel');
    root.setAttribute('aria-label', '学习周报');
    host.appendChild(root);
    if (ui.loading) {
      root.appendChild(mk('div', 'loading', '正在读取周报…'));
      return;
    }
    root.appendChild(header());
    root.appendChild(
      note(
        '生成会真的调用一次模型（也就真的花 token）—— 所以只有点「生成」才会发生，读取永远不会偷偷调用。' +
          '一周一条：同一周再生成会原地更新同一条，不会越攒越多。模型不可用时降级成客观统计小结，并在正文上方明确标出来。',
      ),
    );
    if (ui.error) root.appendChild(alertBox('周报请求失败', ui.error, 'fail'));
    if (!ui.view) {
      if (!ui.error) root.appendChild(empty('这一周的统计还没读到。'));
      return;
    }
    root.appendChild(statsCard(ui.view.stats));
    root.appendChild(missingCard(ui.view.stats?.missing));
    root.appendChild(reportCard(ui.view));
    root.appendChild(historyCard());
  }

  /* ------------------------------------------------------------ 对外 */

  function closeAndRefresh() {
    close();
    if (typeof PC.refresh === 'function') PC.refresh();
  }

  function isOpen() {
    return ui.open === true;
  }

  /** 待办页的按钮调用：只翻状态，真正的重画交给调用方的 `PC.refresh()`。 */
  function toggle() {
    ui.open = !ui.open;
    ui.selected = null;
    ui.confirming = null;
    ui.error = null;
    if (!ui.open) {
      ui.requestId += 1;
      ui.loading = false;
      ui.host = null;
    }
    return ui.open;
  }

  function close() {
    ui.open = false;
    ui.selected = null;
    ui.confirming = null;
    ui.error = null;
    ui.requestId += 1;
    ui.loading = false;
    ui.host = null;
  }

  /**
   * 待办页把面板挂进来（只在 `isOpen()` 为真时调用）。
   *
   * 先画缓存再静默刷新：同一屏里重画（切换筛选等）不该闪一下"加载中"，
   * 但每次进入都要拿最新数字 —— 周报是"现在这一刻"的汇总，缓存只用来避免闪烁。
   */
  function mount(host) {
    ui.host = host;
    if (!ui.open) return;
    if (!ui.view && !ui.loading) {
      void load();
      return;
    }
    paint();
    void load({ quiet: true });
  }

  window.PCModules.service('weeklyPanel', { isOpen, toggle, close, mount });
})();
