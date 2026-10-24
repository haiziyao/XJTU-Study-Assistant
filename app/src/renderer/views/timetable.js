/**
 * 课表导入视图（左栏「课表导入」，order 23）。
 *
 * 三件事必须在**同一页**完成（用户明确要求，别拆成三个页面）：
 *   1. 登录与学期 —— 未登录只给指引（不在这里收密码，登录统一在「设置 → 统一身份认证」）；
 *   2. 预览与选择 —— 课程卡片逐门勾选 + 一个「导入到第几周」的数字 + 实时条数；
 *   3. 已导入 —— 按课程分组、逐门删除 / 全部删除 / 重新导入（删除前二次确认）。
 *
 * 几个刻意的取舍：
 * - **不上传任何本地选择到后端长期保存**：勾选状态只在这次页面会话里，
 *   刷新后默认全选，避免「上次只勾了两门」这种隐式状态让用户漏导课程。
 * - **条数由前端按预览数据实时算**（每个 `schedulePreviews` 条目 = 一条日程），
 *   而不是等导入结果；这样用户调小周次时能立刻看到「将写入 N 条」的变化。
 * - **删除只调后端 `/timetable/remove`**，前端不自己拼库、不碰 `PC.store`：
 *   后端只删 `timetable:` 前缀，手建日程的安全边界只有一处实现。
 * - **没有 inline style**（CSP `style-src 'self'`），所有样式在 timetable.css；
 *   手机端（≤900px）单列、按钮 ≥44px，靠媒体查询而不是 JS 测宽度。
 */

(function () {
  const ui = {
    mount: null,
    loading: false,
    busy: null,
    error: null,
    /** `/timetable/status` 的返回 */
    status: null,
    /** `/timetable/preview` 的返回 */
    preview: null,
    /** `/timetable/imported` 的返回 */
    imported: null,
    /** 当前选中的学期 */
    term: '',
    /** 「导入到第几周」输入框的值（字符串） */
    untilWeek: '',
    /** 勾选中的课程 id 集合 */
    selected: new Set(),
  };

  const timetableView = {
    title: '课表导入',
    render(ctx) {
      ui.mount = ctx.mount;
      paint();
      void loadAll();
    },
  };

  /* ------------------------------------------------------------ 取数 */

  /**
   * @param {{probe?:boolean}} [options] `probe:true` = 用户点了「刷新状态」：
   *   让后端主动重试一次站点认证（共享罐里可能还有 CAS 票据，能静默恢复）。
   */
  async function loadAll({ probe = false } = {}) {
    ui.loading = true;
    ui.error = null;
    paint();
    try {
      ui.status = await PC.api(`/timetable/status${probe ? '?probe=1' : ''}`);
      if (ui.status?.loggedIn) {
        const values = (ui.status.terms ?? []).map((item) => item.value);
        if (!ui.term || !values.includes(ui.term)) {
          ui.term = ui.status.currentTerm ?? values[0] ?? '';
        }
        await Promise.all([loadPreview(ui.term), loadImported(ui.term)]);
      } else {
        ui.preview = null;
        ui.selected = new Set();
        await loadImported(ui.term);
      }
    } catch (error) {
      ui.error = error;
    } finally {
      ui.loading = false;
      paint();
    }
  }

  /**
   * 拉预览。成功时重置勾选（默认全选）与周次上限 —— 换学期 / 刷新课表都是一份新数据，
   * 沿用上一份的勾选会让用户以为「我明明勾了这门课」而实际没勾上。
   */
  async function loadPreview(term, { refresh = false } = {}) {
    if (!term) return;
    const suffix = refresh ? '&refresh=1' : '';
    ui.preview = await PC.api(`/timetable/preview?term=${encodeURIComponent(term)}${suffix}`);
    ui.term = ui.preview?.term ?? term;
    ui.selected = new Set((ui.preview?.courses ?? []).map((course) => course.id));
    ui.untilWeek = String(ui.preview?.maxWeek ?? ui.preview?.totalWeeks ?? 18);
  }

  async function loadImported(term) {
    const suffix = term ? `?term=${encodeURIComponent(term)}` : '';
    ui.imported = await PC.api(`/timetable/imported${suffix}`);
  }

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

  /* ------------------------------------------------------------ 动作 */

  const refreshPreview = () =>
    withBusy('preview', async () => {
      await loadPreview(ui.term, { refresh: true });
      await loadImported(ui.term);
      PC.toast?.('课表已刷新');
    });

  const changeTerm = (value) =>
    withBusy('preview', async () => {
      ui.term = value;
      ui.preview = null;
      await Promise.all([loadPreview(value), loadImported(value)]);
    });

  const doImport = () =>
    withBusy('import', async () => {
      if (!ui.preview?.courses?.length) {
        PC.toast?.('当前学期没有可导入的课程');
        return;
      }
      const courseIds = ui.preview.courses.filter((course) => ui.selected.has(course.id)).map((course) => course.id);
      const limit = Number(ui.untilWeek);
      const result = await PC.api('/timetable/import', {
        method: 'POST',
        body: {
          term: ui.term,
          courseIds,
          untilWeek: Number.isInteger(limit) && limit > 0 ? limit : undefined,
        },
      });
      await loadImported(ui.term);
      const extra = result?.removed ? `，清理旧日程 ${result.removed} 条` : '';
      PC.toast?.(`已写入 ${result?.events ?? 0} 条日程（新增 ${result?.created ?? 0} / 更新 ${result?.updated ?? 0}${extra}）`);
    });

  const removeCourse = (group) =>
    withBusy(`remove:${group.id}`, async () => {
      if (!confirmAction(`删除「${group.name}」导入的 ${group.count} 条日程？\n（只删课表导入的日程，不影响你手动创建的日程）`)) return;
      const result = await PC.api('/timetable/remove', {
        method: 'POST',
        body: { term: group.term, courseIds: [group.id] },
      });
      await loadImported(ui.term);
      PC.toast?.(`已删除 ${result?.removed ?? 0} 条日程`);
    });

  const removeAll = () =>
    withBusy('removeAll', async () => {
      const total = ui.imported?.total ?? 0;
      const scope = ui.term ? '当前学期' : '全部学期';
      if (!total) {
        PC.toast?.(`${scope}还没有导入过课表`);
        return;
      }
      if (!confirmAction(`删除${scope}导入的全部 ${total} 条课表日程？\n（只删课表导入的日程，不影响你手动创建的日程）`)) return;
      const result = await PC.api('/timetable/remove', {
        method: 'POST',
        body: ui.term ? { term: ui.term, all: true } : { all: true },
      });
      await loadImported(ui.term);
      PC.toast?.(`已删除 ${result?.removed ?? 0} 条日程`);
    });

  /** 删除前的二次确认。渲染测试的 DOM 桩没有 confirm，降级为「确认」。 */
  function confirmAction(message) {
    if (typeof window.confirm === 'function') return window.confirm(message);
    return true;
  }

  /* ------------------------------------------------------------ 渲染 */

  /**
   * 重画。与 academic / lms 一致：外层只负责保住 `.view-content` 的滚动位置，
   * 否则勾一门课、导入一次都会把页面弹回顶部。
   */
  function paint() {
    const restore = PC.snapshotScroll?.();
    try {
      paintInner();
    } finally {
      restore?.();
    }
  }

  function paintInner() {
    const mount = ui.mount;
    if (!mount) return;
    mount.innerHTML = '';

    const content = mk('div', 'view-content tt-page');
    content.appendChild(viewHeader());

    if (ui.loading && !ui.status) {
      content.appendChild(mk('p', 'tt-muted', '正在读取课表…'));
      mount.appendChild(content);
      return;
    }
    if (ui.error) content.appendChild(errorBox(ui.error));

    content.appendChild(loginSection());
    if (ui.status?.loggedIn) content.appendChild(previewSection());
    content.appendChild(importedSection());

    mount.appendChild(content);
  }

  function viewHeader() {
    const head = mk('div', 'tt-head');
    head.appendChild(mk('h2', 'tt-title', '课表导入'));
    head.appendChild(
      mk('p', 'tt-sub', '课表来自本科教务系统（ehall · wdkb），登录复用「设置 → 统一身份认证」。选课、导入周次、删除都在这一页完成。'),
    );
    return head;
  }

  /* ---------------------------------------------------------- 1. 登录与学期 */

  function loginSection() {
    const card = mk('section', 'tt-card');
    const head = mk('div', 'tt-card-head');
    head.appendChild(mk('h3', 'tt-card-title', '登录与学期'));
    if (ui.status?.loggedIn) head.appendChild(mk('span', 'tt-badge tt-badge-ok', '已登录'));
    card.appendChild(head);

    if (!ui.status) {
      card.appendChild(mk('p', 'tt-muted', '正在读取登录状态…'));
      return card;
    }

    if (!ui.status.loggedIn) {
      card.appendChild(
        mk(
          'p',
          'tt-muted',
          '请先在 设置 → 统一身份认证 登录。教务与思源学堂用的是同一个学校账号，登录一次两边都能用；课表导入不会保存你的密码。',
        ),
      );
      if (ui.status.reason) card.appendChild(mk('p', 'tt-warn-inline', `当前状态：${ui.status.reason}`));

      const actions = mk('div', 'tt-actions');
      const go = mk('button', 'primary-btn', '去设置里登录');
      go.type = 'button';
      go.addEventListener('click', () => {
        if (typeof PC.openView === 'function') PC.openView('settings');
        else PC.toast?.('请打开左侧的「设置」，在「统一身份认证」里登录');
      });
      actions.appendChild(go);

      const retry = mk('button', 'ghost-btn', '刷新状态');
      retry.type = 'button';
      retry.disabled = Boolean(ui.busy);
      retry.addEventListener('click', () => void loadAll({ probe: true }));
      actions.appendChild(retry);
      card.appendChild(actions);
      return card;
    }

    if (ui.status.error) card.appendChild(mk('p', 'tt-warn-inline', `读取学期失败：${ui.status.error}`));

    const row = mk('div', 'tt-term-row');
    row.appendChild(mk('label', 'tt-label', '学期'));
    const select = mk('select', 'tt-term-select');
    select.setAttribute('aria-label', '选择学期');
    const terms = ui.status.terms ?? [];
    if (!terms.length) select.appendChild(option('', '（没有可选的学期）', true));
    for (const item of terms) {
      select.appendChild(option(item.value, item.label ?? item.value, item.value === ui.term));
    }
    select.disabled = Boolean(ui.busy) || !terms.length;
    select.addEventListener('change', () => void changeTerm(select.value));
    row.appendChild(select);

    const refresh = mk('button', 'primary-btn', ui.busy === 'preview' ? '刷新中…' : '刷新课表');
    refresh.type = 'button';
    refresh.disabled = Boolean(ui.busy) || !ui.term;
    refresh.addEventListener('click', () => void refreshPreview());
    row.appendChild(refresh);

    // 已登录但连学期都没拿到（上游抽风）：给一个能重新探测认证的出口，
    // 否则下拉框是空的、「刷新课表」也因为没有 term 而禁用，页面就卡死了。
    if (!terms.length) {
      const retry = mk('button', 'ghost-btn', '刷新状态');
      retry.type = 'button';
      retry.disabled = Boolean(ui.busy);
      retry.addEventListener('click', () => void loadAll({ probe: true }));
      row.appendChild(retry);
    }
    card.appendChild(row);

    if (ui.status.currentTerm) {
      const current = terms.find((item) => item.value === ui.status.currentTerm);
      card.appendChild(
        mk('p', 'tt-muted', `当前学期：${current?.label ?? ui.status.currentTerm}（起始日与周次以预览为准）`),
      );
    }
    return card;
  }

  /* ---------------------------------------------------------- 2. 预览与选择 */

  function previewSection() {
    const card = mk('section', 'tt-card');
    const head = mk('div', 'tt-card-head');
    head.appendChild(mk('h3', 'tt-card-title', '预览与选择'));
    if (ui.preview) head.appendChild(mk('span', 'tt-muted', `${ui.preview.count ?? 0} 门课程`));
    card.appendChild(head);

    if (ui.busy === 'preview' && !ui.preview) {
      card.appendChild(mk('p', 'tt-muted', '正在读取课表…'));
      return card;
    }
    if (!ui.preview) {
      card.appendChild(mk('p', 'tt-muted', ui.busy ? '正在读取课表…' : '还没有预览数据，点「刷新课表」重新读取。'));
      return card;
    }

    const courses = ui.preview.courses ?? [];
    if (!courses.length) {
      card.appendChild(mk('p', 'tt-muted', '这个学期没有查到课程。'));
      return card;
    }

    const bar = mk('div', 'tt-import-bar');
    const label = mk('label', 'tt-label');
    label.appendChild(mk('span', null, '导入到第几周'));
    const input = mk('input', 'tt-week-input');
    input.type = 'number';
    input.min = '1';
    input.max = String(ui.preview.maxWeek ?? 18);
    input.value = ui.untilWeek || String(ui.preview.maxWeek ?? 18);
    input.setAttribute('aria-label', '导入到第几周');
    input.disabled = Boolean(ui.busy);
    input.addEventListener('input', () => {
      ui.untilWeek = input.value;
      updateCount();
    });
    label.appendChild(input);
    bar.appendChild(label);
    bar.appendChild(mk('span', 'tt-hint', `默认 ${ui.preview.maxWeek ?? 18} 周；调小只会导入前面的周次。`));
    card.appendChild(bar);

    const list = mk('div', 'tt-courses');
    for (const course of courses) list.appendChild(courseCard(course));
    card.appendChild(list);

    const footer = mk('div', 'tt-import-footer');
    footer.appendChild(mk('span', 'tt-count', ''));
    const start = mk('button', 'primary-btn tt-import-btn', ui.busy === 'import' ? '正在导入…' : '开始导入');
    start.type = 'button';
    start.disabled = Boolean(ui.busy);
    start.dataset.action = 'import';
    start.addEventListener('click', () => void doImport());
    footer.appendChild(start);
    card.appendChild(footer);

    // 首次画完就同步一次条数（input 的初始值在事件之外设置）。
    // 用 setTimeout 而不是 queueMicrotask：渲染测试的 DOM 桩环境不一定提供后者。
    setTimeout(updateCount, 0);
    return card;
  }

  function courseCard(course) {
    const row = mk('label', 'tt-course');
    row.dataset.courseId = course.id;

    const check = mk('input', 'tt-course-check');
    check.type = 'checkbox';
    check.checked = ui.selected.has(course.id);
    check.disabled = Boolean(ui.busy);
    check.dataset.courseId = course.id;
    check.addEventListener('change', () => {
      if (check.checked) ui.selected.add(course.id);
      else ui.selected.delete(course.id);
      row.classList.toggle('tt-course-off', !check.checked);
      updateCount();
    });
    row.appendChild(check);

    const main = mk('div', 'tt-course-main');
    main.appendChild(mk('div', 'tt-course-name', course.name));
    const meta = [];
    if (course.teacher) meta.push(course.teacher);
    if (course.location) meta.push(course.location);
    if (meta.length) main.appendChild(mk('div', 'tt-course-meta', meta.join(' · ')));

    const slots = [];
    for (const slot of course.slots ?? []) {
      slots.push(`${weekDayText(slot.weekDay)} 第${slot.startPeriod}-${slot.endPeriod}节`);
    }
    main.appendChild(mk('div', 'tt-course-meta', slots.join('；')));
    main.appendChild(
      mk(
        'div',
        'tt-course-meta',
        `${describeWeeks(course.weeks)} · ${course.eventCount ?? 0} 条日程${course.weeks?.min ? ` · 第${course.weeks.min}-${course.weeks.max}周` : ''}`,
      ),
    );
    // 作息切换（5/1、10/1）会把一条下午课的周次段切成两条日程。
    // 不说明的话，用户看到「一条课 2 条日程」会以为是重复导入；这里把切点与两段作息写清楚。
    const splitNote = seasonSplitNote(course.seasonSplit);
    if (splitNote) main.appendChild(mk('div', 'tt-course-meta tt-course-season-split', splitNote));
    row.appendChild(main);
    return row;
  }

  /**
   * 「因作息切换拆为 N 条」的说明文案。
   *
   * 后端只在真的切过时带 `seasonSplit`：`runs` 个原始周次段被切成 `segments` 条日程，
   * `groups` 里是每个时段的切点与各段作息。没切过的课程不会出现这一行。
   */
  function seasonSplitNote(split) {
    if (!split || !((split.segments ?? 0) > (split.runs ?? 0))) return '';
    const groups = (split.groups ?? []).map((group) => {
      const periods = `${weekDayText(group.weekDay)} 第${group.periodRange[0]}-${group.periodRange[1]}节`;
      const parts = (group.parts ?? [])
        .map((part) => `${describeRun(part.weeks)} ${part.season === 'summer' ? '夏季' : '冬季'} ${part.startTime}起`)
        .join(' / ');
      return `${periods}：${parts}`;
    });
    const detail = groups.length ? `（${groups.join('；')}）` : '';
    return `因作息切换拆为 ${split.segments} 条${detail}`;
  }

  /** 连续周次段 →「第1-3周」。 */
  function describeRun(run) {
    return run.start === run.end ? `第${run.start}周` : `第${run.start}-${run.end}周`;
  }

  /** 实时条数：选中课程里、段首不晚于「导入到第几周」的日程预览条数。 */
  function countSelectedEvents() {
    const courses = ui.preview?.courses ?? [];
    const limit = Number(ui.untilWeek);
    const max = Number.isFinite(limit) && limit > 0 ? limit : Infinity;
    let count = 0;
    for (const course of courses) {
      if (!ui.selected.has(course.id)) continue;
      for (const preview of course.schedulePreviews ?? []) {
        if ((preview.weeks?.start ?? 1) <= max) count += 1;
      }
    }
    return count;
  }

  function updateCount() {
    const mount = ui.mount;
    if (!mount) return;
    const node = mount.querySelector('.tt-count');
    if (!node) return;
    const count = countSelectedEvents();
    node.textContent = `将写入 ${count} 条日程`;
    const button = mount.querySelector('.tt-import-btn');
    if (button) button.disabled = Boolean(ui.busy) || count === 0;
  }

  /* ---------------------------------------------------------- 3. 已导入 */

  function importedSection() {
    const card = mk('section', 'tt-card');
    const head = mk('div', 'tt-card-head');
    head.appendChild(mk('h3', 'tt-card-title', '已导入'));
    const total = ui.imported?.total ?? 0;
    head.appendChild(mk('span', 'tt-muted', `${total} 条日程 · ${ui.imported?.count ?? 0} 门课程`));
    card.appendChild(head);

    if (ui.busy === 'remove' || ui.busy === 'removeAll') {
      // 删除中仍把清单画出来，按钮禁用即可，避免整页闪成空白
    }

    const groups = ui.imported?.courses ?? [];
    if (!groups.length) {
      card.appendChild(mk('p', 'tt-muted', '当前学期还没有导入过课表。'));
    } else {
      const list = mk('div', 'tt-imported-list');
      for (const group of groups) list.appendChild(importedRow(group));
      card.appendChild(list);
    }

    const actions = mk('div', 'tt-actions');
    const reimport = mk('button', 'ghost-btn', ui.busy === 'import' ? '正在导入…' : '重新导入');
    reimport.type = 'button';
    reimport.disabled = Boolean(ui.busy) || !ui.preview?.courses?.length;
    reimport.addEventListener('click', () => void doImport());
    actions.appendChild(reimport);

    const removeAllButton = mk('button', 'danger-btn', ui.busy === 'removeAll' ? '删除中…' : '全部删除');
    removeAllButton.type = 'button';
    removeAllButton.disabled = Boolean(ui.busy) || !groups.length;
    removeAllButton.addEventListener('click', () => void removeAll());
    actions.appendChild(removeAllButton);
    card.appendChild(actions);

    card.appendChild(mk('p', 'tt-hint', '删除只影响课表导入的日程（externalId 以 timetable: 开头），不会动你手动创建的日程。'));
    return card;
  }

  function importedRow(group) {
    const row = mk('div', 'tt-imported-row');
    const main = mk('div', 'tt-imported-main');
    main.appendChild(mk('span', 'tt-imported-name', group.name));
    const meta = [`${group.count} 条`];
    if (group.weeks?.min) meta.push(`第${group.weeks.min}-${group.weeks.max}周`);
    if (group.weekDays?.length) meta.push(group.weekDays.map(weekDayText).join('、'));
    main.appendChild(mk('span', 'tt-muted', meta.join(' · ')));
    row.appendChild(main);

    const remove = mk('button', 'danger-btn small', ui.busy === `remove:${group.id}` ? '删除中…' : '删除');
    remove.type = 'button';
    remove.disabled = Boolean(ui.busy);
    remove.dataset.courseId = group.id;
    remove.addEventListener('click', () => void removeCourse(group));
    row.appendChild(remove);
    return row;
  }

  /* ------------------------------------------------------------ 格式化 */

  const WEEKDAY_CN = [null, '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  function weekDayText(weekDay) {
    return WEEKDAY_CN[weekDay] ?? `星期${weekDay}`;
  }

  /** 周次列表 →「第1-8,10-16周」；与后端 term.describeWeeks 的口径一致。 */
  function describeWeeks(weeks) {
    const list = [...new Set((weeks?.list ?? []).map(Number))].filter((week) => Number.isInteger(week) && week > 0).sort((a, b) => a - b);
    if (!list.length) return '无周次';
    const runs = [];
    for (const week of list) {
      const last = runs[runs.length - 1];
      if (last && week === last.end + 1) last.end = week;
      else runs.push({ start: week, end: week });
    }
    return `第${runs.map((run) => (run.start === run.end ? `${run.start}` : `${run.start}-${run.end}`)).join(',')}周`;
  }

  window.PCModules.register({
    id: 'timetable',
    label: '课表导入',
    icon: 'grid',
    order: 23,
    title: '课表导入',
    render: (ctx) => timetableView.render(ctx),
  });
})();
