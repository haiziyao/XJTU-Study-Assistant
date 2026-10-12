/**
 * 「复习」页 —— 左栏入口（order 65，排在「笔记系统」之后）。
 *
 * 为什么把复习卡片 / 学习目标 / 学习周报放在**同一页的三个标签**里，而不是三个左栏入口：
 * 三者是同一条学习闭环上的三个时刻，用户真正的工作流是串起来的 ——
 *
 *     从笔记生成卡片 → 今天排队复习 → 目标（考试 / 截止）决定要不要加量 → 周末看周报回顾
 *
 * 拆成三个入口，用户每次都要在左栏来回跳，而且"这周到底学了多少"这个问题的答案
 * 分散在三处。三个标签页共用一条数据刷新路径，也共用同一套错误与空态写法。
 *
 * 与三个后端模块的分工（本页**只读地组合**，不复制它们的判断规则）：
 *   - `cards`  ：复习队列、统计、生成、增删改、评分推进。排期与去重全在服务层
 *                （`scheduler.js` 的 `computeNext`、`service.js` 的 `noteId + front` 幂等），
 *                本页**不自己算间隔**，也不自己判断"哪张算到期" —— 那是 `GET /cards/due` 的事；
 *   - `goals`  ：`GET /goals/overview` 已经把三份来源（目标 / 待办 / 事件）合并排好序，
 *                本页只负责按 `severity` 分组显示。**不重排、不重算 daysLeft**；
 *   - `weekly` ：`GET /weekly/reports` 给历史，`POST /weekly/report/generate` 生成。
 *                `fallback: true` 表示"这次没能写成文章"，页面上必须**如实标出**，
 *                不能把规则小结伪装成 AI 写的（见 renderWeeklyDetail）。
 *
 * 三条硬约定（与其它视图一致，见根目录 AGENTS.md 与 views/chat-hub.js）：
 *   1. 所有文本走 textContent（等价转义），**不写 inline style**（CSP 的 `style-src 'self'` 会拦），
 *      颜色只用主题令牌（`--bg-*` / `--fg*` / `--line` / `--blue` / `--red` / `--green` / `--orange` / `--purple`）；
 *   2. 重画前用 `PC.snapshotScroll()` 记住滚动位置、画完 `PC.keepScroll()` 还回去；
 *   3. 每个动作走同一个 `run(key, task)` 包装：busy 期间按钮禁用、失败落到页面顶部的错误条，
 *      **绝不 `alert()`**，也不静默失败。
 *
 * 后端三个模块是并行开发的，可能还没装配（`registerCardRoutes` 那类函数在服务缺席时直接
 * 不注册路由）。所以本页对 404 / 501 / 5xx **一律降级成"这个功能还没装好"的提示条**，
 * 而不是白屏或者抛到控制台 —— 见 `isMissingModule()` / `missingNotice()`。
 */

(function () {
  const TABS = [
    { id: 'cards', label: '复习' },
    { id: 'goals', label: '目标' },
    { id: 'weekly', label: '周报' },
  ];

  /** 四档评分：顺序即按钮顺序（`scheduler.js` 的 GRADES 同序）。 */
  const GRADES = [
    { value: 'again', label: '忘了', hint: '1', cls: 'rv-g-again' },
    { value: 'hard', label: '有点难', hint: '2', cls: 'rv-g-hard' },
    { value: 'good', label: '记得', hint: '3', cls: 'rv-g-good' },
    { value: 'easy', label: '太简单', hint: '4', cls: 'rv-g-easy' },
  ];
  const GRADE_LABEL = Object.fromEntries(GRADES.map((item) => [item.value, item.label]));

  /** severity → 中文与配色类（文案与 `goals/service.js` 的 SEVERITY_LABEL 一致）。 */
  const SEVERITY = [
    { id: 'overdue', label: '已逾期' },
    { id: 'urgent', label: '紧急（两天内）' },
    { id: 'soon', label: '临近（一周内）' },
    { id: 'later', label: '还早（窗口内）' },
  ];

  /** overview 条目的 source → 中文标签。来自目标模块时 source === kind。 */
  const SOURCE_LABEL = {
    goal: '长期目标',
    deadline: '截止事项',
    exam: '考试',
    todo: '待办',
    event: '日程',
  };

  /** 周报六个来源的中文名（与 `weekly/sources.js` 的 SOURCE_LABEL 同步）。 */
  const WEEKLY_SOURCE_LABEL = {
    conversations: 'AI 对话',
    notes: '笔记',
    cards: '复习卡片',
    goals: '学习目标',
    schedule: '待办',
    grades: '成绩',
  };
  /** `missing[].reason` → 一句人话。 */
  const MISSING_REASON = {
    unavailable: '这个来源还没装好',
    partial: '只取到了一部分',
    read_failed: '读取失败',
  };

  const CARD_FILTERS = [
    { value: 'all', label: '全部' },
    { value: 'due', label: '到期' },
    { value: 'suspended', label: '已暂停' },
  ];

  const ui = {
    mount: null,
    tab: 'cards',
    error: null,
    busy: null,
    /** 后端模块没装好时的提示（与 error 分开显示：它不是"你操作错了"，是"功能还没接上"） */
    missing: { cards: false, goals: false, weekly: false },
    /** 各标签页的数据缓存：`null` = 还没拉过（同一次停留里切回来不重复打请求） */
    stats: null,
    /** 到期队列快照（`GET /cards/due?limit=20`）：开始复习时再取一次，避免拿着进页面时的旧队列 */
    dueQueue: [],
    /** `GET /cards` 的 `counts`（不受筛选影响的那份），列表筛选时用来区分"筛选后条数" */
    cardCounts: null,
    /** 复习队列：`{ queue, index, revealed, recorded }`；没有会话时为 null */
    session: null,
    /** 本次复习里已经评过的卡：`{ front, grade, explain }`（全部复习完的完成态要展示它） */
    reviewed: [],
    generateForm: null,
    generateResult: null,
    newCardForm: null,
    cardFilter: 'all',
    cardQuery: '',
    cards: null,
    editing: null,
    /** `{ queue }` / `{ list }` 两个请求各自的降级标记（任一 404 就整块不可用） */
    listsMissing: false,
    overview: null,
    targetGpa: null,
    gpaForm: '',
    goalForm: null,
    editingGoal: null,
    goalList: null,
    reports: null,
    openReport: null,
    weeklyDetail: null,
    /** 需要二次确认的删除：存 key，第一次点变文案，第二次才真删（不弹原生对话框） */
    confirming: null,
  };

  /** 全局键盘监听是否已经挂上（进入本页时挂一次，见 register 里的说明）。 */
  let keyBound = false;

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
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }

  function iconButton(name, title, onClick) {
    const node = mk('button', 'rv-icon-btn');
    node.type = 'button';
    node.title = title;
    node.setAttribute('aria-label', title);
    const svg = window.PCIcons?.svg?.(name, 18);
    if (svg) node.innerHTML = svg;
    else node.textContent = title;
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }

  function alertBox(title, message, kind = 'warn') {
    const box = mk('div', `rv-alert ${kind}`);
    box.appendChild(mk('div', 'rv-alert-title', title));
    if (message) box.appendChild(mk('div', 'rv-alert-msg', message));
    return box;
  }

  const empty = (text) => mk('div', 'rv-empty', text);
  const note = (text) => mk('div', 'rv-note', text);
  const subtitle = (text) => mk('div', 'rv-subtitle', text);

  function field(label, control, hint) {
    const wrap = mk('label', 'rv-field');
    wrap.appendChild(mk('span', 'rv-field-label', label));
    wrap.appendChild(control);
    if (hint) wrap.appendChild(mk('span', 'rv-field-hint', hint));
    return wrap;
  }

  function textInput(value, placeholder, onInput, type = 'text') {
    const input = mk('input', 'rv-input');
    input.type = type;
    input.value = value ?? '';
    if (placeholder) input.placeholder = placeholder;
    if (onInput) input.addEventListener('input', () => onInput(input.value));
    return input;
  }

  function select(options, value, onChange) {
    const node = mk('select', 'rv-select');
    for (const item of options) {
      const option = mk('option', null, item.label);
      option.value = item.value;
      node.appendChild(option);
    }
    // 传进来的值不在选项里时保留第一项（例如数据里出现了旧枚举），不静默变成空字符串
    const known = options.some((item) => item.value === value);
    node.value = known ? value : (options[0]?.value ?? '');
    if (onChange) node.addEventListener('change', () => onChange(node.value));
    return node;
  }

  function textarea(value, placeholder, rows = 3) {
    const node = mk('textarea', 'rv-textarea');
    node.rows = rows;
    node.value = value ?? '';
    if (placeholder) node.placeholder = placeholder;
    return node;
  }

  function checkbox(label, checked, onChange) {
    const wrap = mk('label', 'rv-check');
    const box = mk('input');
    box.type = 'checkbox';
    box.checked = Boolean(checked);
    box.addEventListener('change', () => onChange(box.checked));
    wrap.append(box, mk('span', null, label));
    return wrap;
  }

  function statCell(label, value) {
    const cell = mk('div', 'rv-stat');
    cell.appendChild(mk('div', 'rv-stat-value', value));
    cell.appendChild(mk('div', 'rv-stat-label', label));
    return cell;
  }

  function badge(text, cls) {
    return mk('span', `rv-badge${cls ? ` ${cls}` : ''}`, text);
  }

  function externalBadge(kind) {
    return badge(kind === 'todo' ? '来自待办' : '来自日程', 'ext');
  }

  /* ------------------------------------------------------------ 时间格式 */

  const pad2 = (n) => String(n).padStart(2, '0');

  /** 本地日期键（与后端 `shared/time.js` 的 todayKey 同口径：按用户本地时区，不是 UTC）。 */
  function dateKeyOf(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  const todayKey = () => dateKeyOf(new Date());

  /** ISO → 本地可读（后端给 UTC，直接显示用户对不上时间）。 */
  function formatStamp(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return `${dateKeyOf(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  /** 日期键 → `2026-03-01`；也接受完整 ISO（取本地日部分）。 */
  function formatDay(value) {
    if (!value) return '';
    const text = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? text : dateKeyOf(date);
  }

  /** 两个日期键相差几天（纯日期相减，跨夏令时不会算出 23/25 小时）。 */
  function daysBetween(fromKey, toKey) {
    const a = Date.parse(`${fromKey}T00:00:00Z`);
    const b = Date.parse(`${toKey}T00:00:00Z`);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.round((b - a) / 86400000);
  }

  /**
   * 「下次复习」的人话。
   *
   * 刻意只按**本地日期**比较，不显示后端回执里那句 `explain` —— 回执的 explain 用的是
   * 后端进程的时区，前端按本地日期自己说一句更不容易和用户看到的钟对不上。
   */
  function describeDue(dueIso) {
    if (!dueIso) return '';
    const date = new Date(dueIso);
    if (Number.isNaN(date.getTime())) return String(dueIso);
    const diff = daysBetween(todayKey(), dateKeyOf(date));
    if (diff === null) return formatStamp(dueIso);
    if (diff < 0) return `逾期 ${-diff} 天（${dateKeyOf(date)}）`;
    if (diff === 0) return `今天 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    if (diff === 1) return `明天（${dateKeyOf(date)}）`;
    return `${diff} 天后（${dateKeyOf(date)}）`;
  }

  /** 倒计时：0 天说"今天"，负数说"逾期 N 天"。 */
  function describeLeft(daysLeft) {
    const value = Number(daysLeft);
    if (!Number.isFinite(value)) return '';
    if (value < 0) return `逾期 ${-value} 天`;
    if (value === 0) return '今天';
    if (value === 1) return '明天';
    return `${value} 天后`;
  }

  /** 本周范围（周一 ~ 周日，本地时区）：与后端 `weekRange(today, 1)` 同口径。 */
  function currentWeekRange() {
    const now = new Date();
    const weekday = now.getDay() === 0 ? 7 : now.getDay(); // 1=周一 … 7=周日
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (weekday - 1));
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    return { from: dateKeyOf(start), to: dateKeyOf(end) };
  }

  /* ------------------------------------------------------------ 缺失模块 */

  /**
   * 这个错误是不是"功能还没装好"。
   *
   * 三种都算（都要降级成提示条，而不是显示一句"未找到接口 GET /api/v1/cards"）：
   *   - 404：模块没装配 → `registerXxxRoutes` 直接 return，路由根本不存在；
   *   - 501：模块装配了但明确说不支持（例如"从笔记生成"要 notes 模块先装配）；
   *   - 5xx：模块在跑但内部炸了（并行开发期间很常见），对用户来说同样是"这块还不能用"。
   */
  function isMissingModule(error) {
    const status = Number(error?.status);
    if (status === 404 || status === 501) return true;
    if (status >= 500) return true;
    const code = error?.payload?.error?.code;
    return code === 'NOT_FOUND' || code === 'NOT_IMPLEMENTED';
  }

  /** 缺失提示条：说清"哪一块"和"现在能做什么"，而不是把 HTTP 原文甩给用户。 */
  function missingNotice(what, error) {
    const detail = error?.message ?? String(error ?? '');
    return alertBox(
      `${what}还没装好`,
      `后端这个模块暂时不可用（${detail}）。这不影响其它标签页：等模块装配好、重启后端之后，这一块会自动恢复；` +
        '出现 404 说明模块还没接上，500/501 说明接上了但这次没跑成。',
      'fail',
    );
  }

  /* ------------------------------------------------------------ 重画 */

  /** 重画（默认保住滚动位置）。所有动作完成后统一走这里，避免各处手写 paint。 */
  function paint() {
    if (!ui.mount) return;
    const restore = window.PC?.snapshotScroll?.() ?? null;
    const draw = () => {
      ui.mount.textContent = '';
      // 真正滚动的是外壳的 .view-content（.panel-body 是 overflow:hidden，不滚动也不留白）。
      // 直接把内容挂到 mount 上会表现为「贴边 + 不能滚」，所以这里自己建一层。
      const content = mk('div', 'view-content');
      content.appendChild(renderTabs());
      if (ui.error) content.appendChild(alertBox('没能完成', ui.error.message ?? String(ui.error), 'fail'));
      const render = { cards: renderCardsTab, goals: renderGoalsTab, weekly: renderWeeklyTab }[ui.tab];
      render?.(content);
      ui.mount.appendChild(content);
    };
    draw();
    window.PC?.keepScroll?.(restore, draw);
  }

  function renderTabs() {
    const bar = mk('div', 'rv-tabs');
    bar.setAttribute('role', 'tablist');
    for (const tab of TABS) {
      const node = mk('button', `rv-tab${ui.tab === tab.id ? ' active' : ''}`, tab.label);
      node.type = 'button';
      node.setAttribute('role', 'tab');
      node.addEventListener('click', () => {
        if (ui.tab === tab.id) return;
        ui.tab = tab.id;
        ui.error = null;
        // 切标签回到顶部：换了一屏内容，停在上一个标签的位置会让人以为页面卡住了
        paint();
        const scroller = ui.mount.querySelector('.view-content') ?? ui.mount;
        scroller.scrollTop = 0;
        // 切标签是"看一眼"的动作，不套 run()（那会把整页刷成 busy 态）；这里只需要
        // 把这次加载的失败**收住** —— 否则它会以未处理的 rejection 消失在控制台里，
        // 而界面停在一片空数据上，用户只会觉得"这个标签坏了"。
        void ensureLoaded(tab.id).catch((error) => {
          ui.error = error;
          if (isMissingModule(error)) ui.missing[tab.id] = true;
          paint();
        });
      });
      bar.appendChild(node);
    }
    return bar;
  }

  /**
   * 强制重取某个标签的数据。**每次进入「复习」页都调它** ——
   * 缓存只服务于"同一次停留里来回切标签"：否则在别处（对话里让 AI 建了一张卡、
   * 日历里改了待办）产生的变化，回到这一页看到的还是进页时那份旧数据。
   */
  async function reloadTab(tab = ui.tab) {
    ui.missing[tab] = false;
    if (tab === 'cards') return loadCards();
    if (tab === 'goals') return loadGoals();
    if (tab === 'weekly') return loadWeekly();
    return undefined;
  }

  /**
   * 标签之间切换用它：已经拉过就不重复打请求（同一次停留里数据不会自己变）。
   *
   * 两个刻意的细节：
   *   1. 数据到手后**自己再画一次**。外壳在视图 render 返回后就不会再画了，而这个视图
   *      是异步取数 —— 不补这一次，用户可能盯着一屏"0 条 / 空清单"直到下一次重画
   *      （下一页数据、或者切标签），而接口明明已经成功了；
   *   2. 这里**不吞异常**：调用方（标签点击）自己决定怎么显示失败。
   */
  async function ensureLoaded(tab = ui.tab) {
    const stale =
      (tab === 'cards' && ui.stats === null) ||
      (tab === 'goals' && ui.overview === null) ||
      (tab === 'weekly' && ui.reports === null);
    if (!stale) return undefined;
    try {
      return await reloadTab(tab);
    } finally {
      paint();
    }
  }

  /** 统一动作包装：busy 期间按钮禁用并显示「处理中…」，失败落到 ui.error 而不是静默。 */
  async function run(key, task) {
    ui.busy = key;
    ui.error = null;
    paint();
    try {
      await task();
    } catch (error) {
      if (isMissingModule(error)) ui.missing[ui.tab] = true;
      ui.error = error;
    } finally {
      ui.busy = null;
      paint();
    }
  }

  /** 二次确认：第一次点改文案，3 秒内再点才执行（比 window.confirm 更不发怵，也不阻塞渲染）。 */
  function confirmThen(key, onConfirm) {
    if (ui.confirming === key) {
      ui.confirming = null;
      return onConfirm();
    }
    ui.confirming = key;
    paint();
    setTimeout(() => {
      if (ui.confirming === key) {
        ui.confirming = null;
        paint();
      }
    }, 3000);
    return undefined;
  }

  const countText = (n) => Number(n ?? 0).toLocaleString('zh-CN');

  /** 逗号 / 空格分隔的标签串 → 数组（与后端 `optionalTags` 的去重口径一致）。 */
  function parseTags(text) {
    return [...new Set(String(text ?? '').split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean))];
  }

  /* ============================================================ 1) 复习 */

  /**
   * 一次拉齐复习页要用的三份数据。
   *
   * **`Promise.all` 而不是三个 await**：三者互相独立，串行只是白等两轮网络。
   * 统计与到期队列都必须成功（顶部四个数字不能显示成 0 —— 0 和"没读到"是两件事，
   * 见 `weekly/sources.js` 同一原则）；卡片列表失败就降级成"只有队列能用"，
   * 不让一次列表读取失败把整页拖黑。
   */
  async function loadCards() {
    const [stats, due, list] = await Promise.all([
      PC.api('/cards/stats'),
      PC.api('/cards/due?limit=20'),
      PC.api('/cards?limit=100').catch((error) => {
        if (isMissingModule(error)) throw error;
        ui.listsMissing = true;
        return null;
      }),
    ]);
    ui.listsMissing = false;
    ui.stats = stats ?? null;
    ui.dueQueue = Array.isArray(due?.items) ? due.items : [];
    ui.cards = list ? (Array.isArray(list.items) ? list.items : []) : [];
    ui.cardCounts = list?.counts ?? null;
    return ui.stats;
  }

  /** 取一张卡：优先从本地列表里找（省一次往返），找不到才去后端。 */
  async function fetchCard(id) {
    const local = (ui.cards ?? []).find((item) => item.id === id);
    if (local) return local;
    const data = await PC.api(`/cards/${encodeURIComponent(id)}`);
    return data?.item ?? null;
  }

  function startSession() {
    const queue = [...(ui.dueQueue ?? [])];
    if (!queue.length) {
      PC.toast('没有到期的卡片了');
      return;
    }
    ui.session = { queue, index: 0, revealed: false };
    ui.reviewed = [];
    ui.error = null;
    paint();
  }

  function endSession() {
    ui.session = null;
    ui.reviewed = [];
    paint();
  }

  /**
   * 评完一张：走下一张，走到队列尾就是完成态。
   *
   * `finished` 这个标记必须落在 `ui.session` 上（不是某个临时对象）——
   * 它是"这一轮复习结束"的唯一状态，paint 之后还要靠它画出完成态。
   */
  function advanceSession() {
    const session = ui.session;
    if (!session) return;
    if (session.index + 1 >= session.queue.length) {
      session.index = session.queue.length;
      session.revealed = false;
      session.finished = true;
    } else {
      session.index += 1;
      session.revealed = false;
    }
    paint();
  }

  /**
   * 记录一次评分（`POST /cards/:id/review`）。
   *
   * `again` 的卡会被排到 10 分钟后 —— 它**不在**本次队列里重来一遍：队列是"今天这一轮"的
   * 快照，中途插入会让"还剩 N 张"的数字来回跳。回执里的 `explain` 说明它下次什么时候见。
   */
  async function rateCard(card, grade) {
    const data = await PC.api(`/cards/${encodeURIComponent(card.id)}/review`, {
      method: 'POST',
      body: { grade },
    });
    const item = data?.item ?? card;
    ui.reviewed = [...(ui.reviewed ?? []), { front: card.front, grade, nextDue: item.due }];
    // 本地就地更新统计，省掉一次 /cards/stats 往返；下一次进入页面仍会强制刷新
    if (ui.stats) {
      ui.stats = {
        ...ui.stats,
        reviewedToday: Number(ui.stats.reviewedToday ?? 0) + 1,
        dueNow: Math.max(0, Number(ui.stats.dueNow ?? 0) - 1),
      };
    }
    advanceSession();
  }

  /** 键盘快捷键：空格显示答案、1–4 评档。复习是重复劳动，键盘比鼠标快得多。 */
  function sessionKeyHandler(event) {
    const session = ui.session;
    if (!session || ui.tab !== 'cards') return;
    // 焦点在输入框里时不抢键（用户可能正在"手动加卡"的表单里打字）
    const tag = event.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (!session.revealed) {
      if (event.key === ' ' || event.key === 'Spacebar' || event.key === 'Enter') {
        event.preventDefault();
        session.revealed = true;
        paint();
      }
      return;
    }
    const card = session.queue[session.index];
    if (!card) return;
    const grade = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' }[event.key];
    if (!grade) return;
    event.preventDefault();
    if (ui.busy) return; // 上一次评分还在路上，别把同一张卡评两次
    void run(`review:${card.id}`, () => rateCard(card, grade));
  }

  function renderKeys() {
    const box = mk('div', 'rv-keys');
    const pairs = [
      ['空格', '显示答案'],
      ['1', '忘了'],
      ['2', '有点难'],
      ['3', '记得'],
      ['4', '太简单'],
    ];
    for (const [key, label] of pairs) {
      const cell = mk('span', 'rv-key');
      cell.append(mk('kbd', null, key), mk('span', null, label));
      box.appendChild(cell);
    }
    return box;
  }

  function renderStats() {
    const stats = ui.stats;
    const row = mk('div', 'rv-stats');
    row.appendChild(statCell('今日到期', countText(stats?.dueToday ?? 0)));
    row.appendChild(statCell('总数', countText(stats?.total ?? 0)));
    row.appendChild(statCell('已暂停', countText(stats?.suspended ?? 0)));
    row.appendChild(statCell('今日已复习', countText(stats?.reviewedToday ?? 0)));
    return row;
  }

  /**
   * 未来 7 天到期曲线（`stats.byDay` 固定 7 格，含今天）。
   *
   * 柱高用**类名分档**而不是行内 style：CSP 的 `style-src 'self'` 会拦 inline style，
   * 而这套主题不需要真实比例尺 —— 用户看的是"哪几天重"，不是精确高度。
   */
  function renderForecast() {
    const byDay = Array.isArray(ui.stats?.byDay) ? ui.stats.byDay : [];
    if (!byDay.length) return null;
    const max = Math.max(1, ...byDay.map((item) => Number(item.count) || 0));
    const box = mk('div', 'rv-forecast');
    box.appendChild(mk('div', 'rv-forecast-title', '未来 7 天到期（按天，含逾期积压到今天）'));
    const bars = mk('div', 'rv-bars');
    for (const [index, item] of byDay.entries()) {
      const count = Number(item.count) || 0;
      const level = count === 0 ? 0 : Math.max(1, Math.ceil((count / max) * 4));
      const col = mk('div', 'rv-bar-col');
      col.appendChild(mk('div', `rv-bar rv-bar-${level}`));
      col.appendChild(mk('div', 'rv-bar-value', countText(count)));
      const key = String(item.date ?? '');
      col.appendChild(mk('div', 'rv-bar-label', index === 0 ? '今天' : key.slice(5)));
      bars.appendChild(col);
    }
    box.appendChild(bars);
    return box;
  }

  function renderSession() {
    const session = ui.session;
    const box = mk('div', 'rv-session');

    if (session.finished) {
      box.appendChild(mk('div', 'rv-done-title', '今天清空了 🎉'));
      const summary = mk('div', 'rv-done-summary');
      if (ui.reviewed.length) {
        const tally = new Map();
        for (const item of ui.reviewed) tally.set(item.grade, (tally.get(item.grade) ?? 0) + 1);
        summary.textContent = `这一轮 ${ui.reviewed.length} 张：${[...tally.entries()]
          .map(([grade, count]) => `${GRADE_LABEL[grade] ?? grade} ${count}`)
          .join(' · ')}`;
      } else {
        summary.textContent = '这一轮没有卡片。';
      }
      box.appendChild(summary);
      if (ui.reviewed.length) {
        const list = mk('div', 'rv-done-list');
        for (const item of ui.reviewed) {
          const row = mk('div', 'rv-done-row');
          row.appendChild(badge(GRADE_LABEL[item.grade] ?? item.grade, `g-${item.grade}`));
          row.appendChild(mk('span', 'rv-done-front', item.front));
          row.appendChild(mk('span', 'rv-done-when', describeDue(item.nextDue)));
          list.appendChild(row);
        }
        box.appendChild(list);
      }
      const actions = mk('div', 'rv-form-actions');
      actions.appendChild(button('再拉一次队列', 'primary-btn', () => void run('cards:reload', () => loadCards())));
      actions.appendChild(button('结束复习', 'ghost-btn', endSession));
      box.appendChild(actions);
      return box;
    }

    const card = session.queue[session.index];
    if (!card) {
      box.appendChild(empty('队列里的卡片不见了，重新拉一次队列试试。'));
      return box;
    }

    const head = mk('div', 'rv-session-head');
    head.appendChild(mk('div', 'rv-session-progress', `第 ${session.index + 1} / ${session.queue.length} 张`));
    head.appendChild(
      mk('div', 'rv-session-meta', [card.course, card.source === 'note' ? '来自笔记' : '手动添加'].filter(Boolean).join(' · ')),
    );
    head.appendChild(button('退出复习', 'ghost-btn', endSession));
    box.appendChild(head);

    box.appendChild(mk('div', 'rv-card-front', card.front));

    if (!session.revealed) {
      const actions = mk('div', 'rv-form-actions');
      const reveal = button(ui.busy ? '处理中…' : '显示答案（空格）', 'primary-btn', () => {
        session.revealed = true;
        paint();
      });
      reveal.disabled = Boolean(ui.busy);
      actions.appendChild(reveal);
      box.appendChild(actions);
      return box;
    }

    const answer = mk('div', 'rv-card-back');
    if (card.back) answer.textContent = card.back;
    else answer.textContent = '（这张卡没有答案内容）';
    box.appendChild(answer);

    const tags = mk('div', 'rv-card-tags');
    for (const tag of card.tags ?? []) tags.appendChild(badge(tag));
    if (card.tags?.length) box.appendChild(tags);

    const grades = mk('div', 'rv-grades');
    for (const grade of GRADES) {
      const node = mk('button', `rv-grade ${grade.cls}`, `${grade.label}（${grade.hint}）`);
      node.type = 'button';
      node.disabled = Boolean(ui.busy);
      node.addEventListener('click', () => void run(`review:${card.id}`, () => rateCard(card, grade.value)));
      grades.appendChild(node);
    }
    box.appendChild(grades);
    box.appendChild(mk('div', 'rv-hint', '评完立刻排下一次复习时间；「忘了」的卡会安排在今天稍后再来一次。'));
    return box;
  }

  function renderGenerate() {
    const form = ui.generateForm ?? { query: '', noteId: '', limit: 5 };
    ui.generateForm = form;
    const box = mk('div', 'rv-form rv-form-flat');

    box.appendChild(
      field(
        '笔记关键词',
        textInput(form.query, '例如 热力学 / tag:物理 / folder:期末', (value) => {
          form.query = value;
          form.noteId = ''; // 关键词与指定笔记二选一，填了关键词就清掉选中的那条
        }),
        '按关键词在笔记里检索，命中的前几篇会被扫一遍（规则化抽取，不调用模型）',
      ),
    );

    const notes = ui.noteOptions ?? [];
    const options = [{ value: '', label: notes.length ? '（不指定，用上面的关键词）' : '（笔记列表没读到，只能用关键词）' }];
    for (const item of notes) options.push({ value: item.id, label: item.title });
    box.appendChild(
      field(
        '或指定一条笔记',
        select(options, form.noteId, (value) => {
          form.noteId = value;
          if (value) form.query = '';
          paint();
        }),
      ),
    );

    const limit = mk('input', 'rv-input rv-number');
    limit.type = 'number';
    limit.min = '1';
    limit.max = '20';
    limit.value = String(form.limit ?? 5);
    limit.addEventListener('input', () => {
      form.limit = Number(limit.value) || 5;
    });
    box.appendChild(field('最多扫几篇', limit, '1–20；一篇笔记可能抽出好几张卡'));

    const actions = mk('div', 'rv-form-actions');
    const submit = button(ui.busy === 'generate' ? '生成中…' : '生成卡片', 'primary-btn', () => {
      void run('generate', async () => {
        if (!form.noteId && !form.query.trim()) throw new Error('先填关键词，或选一条笔记');
        const body = { limit: form.limit };
        if (form.noteId) body.noteId = form.noteId;
        else body.query = form.query.trim();
        const data = await PC.api('/cards/generate', { method: 'POST', body });
        ui.generateResult = {
          created: Number(data?.created ?? 0),
          skipped: Number(data?.skipped ?? 0),
          ignored: Number(data?.ignored ?? 0),
          notes: Number(data?.notes ?? 0),
        };
        ui.generateForm = null;
        await loadCards();
        PC.toast(`生成了 ${ui.generateResult.created} 张卡片`);
      });
    });
    submit.disabled = ui.busy === 'generate';
    actions.appendChild(submit);
    if (ui.generateForm) {
      actions.appendChild(
        button('取消', 'ghost-btn', () => {
          ui.generateForm = null;
          paint();
        }),
      );
    }
    box.appendChild(actions);

    const result = ui.generateResult;
    if (result) {
      const box2 = mk('div', 'rv-result');
      box2.appendChild(mk('div', 'rv-result-title', '这次生成的结果'));
      box2.appendChild(
        mk(
          'div',
          'rv-result-line',
          `新建 ${result.created} 张 · 跳过 ${result.skipped} 张 · 忽略 ${result.ignored} 条 · 扫了 ${result.notes} 篇笔记`,
        ),
      );
      if (!result.created && result.skipped) {
        box2.appendChild(
          mk('div', 'rv-result-note', '一张都没新建：这些内容之前已经生成过了（按「笔记 + 正面」去重，重复点不会给出两套卡）。'),
        );
      } else if (!result.created && !result.skipped) {
        box2.appendChild(mk('div', 'rv-result-note', '没抽出可做成卡的内容。换一篇笔记，或手工加卡。'));
      }
      if (result.created) {
        const actions2 = mk('div', 'rv-form-actions');
        actions2.appendChild(button('去复习', 'primary-btn', () => void run('cards:reload', () => loadCards())));
        box2.appendChild(actions2);
      }
      box.appendChild(box2);
    }
    return box;
  }

  function renderNewCard() {
    const form = ui.newCardForm ?? { front: '', back: '', course: '', tags: '' };
    ui.newCardForm = form;
    const box = mk('div', 'rv-form rv-form-flat');

    const front = textarea(form.front, '例如：熵的定义是什么？', 2);
    front.addEventListener('input', () => {
      form.front = front.value;
    });
    box.appendChild(field('正面（问题）', front, '≤ 500 字；写成能问出来的一句话'));

    const back = textarea(form.back, '例如：系统混乱程度的度量，S = k ln Ω', 3);
    back.addEventListener('input', () => {
      form.back = back.value;
    });
    box.appendChild(field('答案', back, '≤ 2000 字；答案要自足（可以带公式和要点）'));

    box.appendChild(
      field(
        '课程（可留空）',
        textInput(form.course, '例如 热力学', (value) => {
          form.course = value;
        }),
        '影响列表分组；也可以留空，之后按标签找',
      ),
    );
    box.appendChild(
      field(
        '标签（逗号分隔，可留空）',
        textInput(form.tags, '例如 第二章, 公式', (value) => {
          form.tags = value;
        }),
      ),
    );

    const actions = mk('div', 'rv-form-actions');
    const submit = button(ui.busy === 'card:create' ? '保存中…' : '加进复习队列', 'primary-btn', () => {
      void run('card:create', async () => {
        if (!form.front.trim()) throw new Error('正面不能为空');
        if (!form.back.trim()) throw new Error('答案不能为空');
        const body = { front: form.front.trim(), back: form.back.trim() };
        if (form.course.trim()) body.course = form.course.trim();
        const tags = parseTags(form.tags);
        if (tags.length) body.tags = tags;
        await PC.api('/cards', { method: 'POST', body });
        ui.newCardForm = null;
        await loadCards();
        PC.toast('已加入今天的复习队列');
      });
    });
    submit.disabled = ui.busy === 'card:create';
    actions.appendChild(submit);
    actions.appendChild(
      button('取消', 'ghost-btn', () => {
        ui.newCardForm = null;
        paint();
      }),
    );
    box.appendChild(actions);
    return box;
  }

  function cardMeta(card) {
    const topics = [card.course ?? '未分类', ...(card.tags ?? [])].join(' · ');
    const source = card.source === 'note' ? '来自笔记' : card.source === 'ai' ? 'AI 生成' : '手动添加';
    const reviewed = card.lastReviewedAt ? `上次 ${formatStamp(card.lastReviewedAt)}` : '还没复习过';
    return `${topics} · ${source} · 复习 ${countText(card.reps ?? 0)} 次 · ${reviewed}`;
  }

  function renderCardEditor(card) {
    const form = ui.editDraft ?? {
      front: card.front,
      back: card.back,
      course: card.course ?? '',
      tags: (card.tags ?? []).join(', '),
    };
    ui.editDraft = form;
    const box = mk('div', 'rv-form rv-form-flat');

    const front = textarea(form.front, '', 2);
    front.addEventListener('input', () => {
      form.front = front.value;
    });
    box.appendChild(field('正面', front));

    const back = textarea(form.back, '', 3);
    back.addEventListener('input', () => {
      form.back = back.value;
    });
    box.appendChild(field('答案', back));

    box.appendChild(
      field(
        '课程',
        textInput(form.course, '留空 = 未分类', (value) => {
          form.course = value;
        }),
      ),
    );
    box.appendChild(
      field(
        '标签（逗号分隔）',
        textInput(form.tags, '', (value) => {
          form.tags = value;
        }),
      ),
    );

    const actions = mk('div', 'rv-form-actions');
    actions.appendChild(
      button('保存', 'primary-btn', () => {
        void run(`card:save:${card.id}`, async () => {
          if (!form.front.trim()) throw new Error('正面不能为空');
          if (!form.back.trim()) throw new Error('答案不能为空');
          await PC.api(`/cards/${encodeURIComponent(card.id)}`, {
            method: 'PATCH',
            // 四个字段全给：PATCH 是局部更新，但"清空课程"必须显式传空串才生效
            body: {
              front: form.front.trim(),
              back: form.back.trim(),
              course: form.course.trim(),
              tags: parseTags(form.tags),
            },
          });
          ui.editing = null;
          ui.editDraft = null;
          await loadCards();
          PC.toast('已保存');
        });
      }),
    );
    actions.appendChild(
      button('取消', 'ghost-btn', () => {
        ui.editing = null;
        ui.editDraft = null;
        paint();
      }),
    );
    box.appendChild(actions);
    return box;
  }

  function renderCardList() {
    const head = mk('div', 'rv-head');
    const left = mk('div', 'rv-head-left');
    left.appendChild(
      button('＋ 手动加卡', 'primary-btn', () => {
        ui.newCardForm = ui.newCardForm ? null : { front: '', back: '', course: '', tags: '' };
        paint();
      }),
    );
    left.appendChild(
      button('＋ 从笔记生成', 'ghost-btn', () => {
        ui.generateForm = ui.generateForm ? null : { query: '', noteId: '', limit: 5 };
        ui.generateResult = null;
        paint();
      }),
    );
    head.appendChild(left);

    const right = mk('div', 'rv-head-right');
    right.appendChild(
      select(CARD_FILTERS, ui.cardFilter, (value) => {
        ui.cardFilter = value;
        void run('cards:filter', () => loadCardList());
      }),
    );
    right.appendChild(
      textInput(ui.cardQuery, '搜索正面/答案/课程/标签…', (value) => {
        ui.cardQuery = value;
      }),
    );
    right.appendChild(
      button('搜索', 'ghost-btn', () => {
        void run('cards:search', () => loadCardList());
      }),
    );
    head.appendChild(right);
    return head;
  }

  /** 只重取列表（筛选 / 搜索用）：不动统计与队列，避免顶部数字跟着闪。 */
  async function loadCardList() {
    const params = new URLSearchParams();
    if (ui.cardFilter === 'due') params.set('due', '1');
    if (ui.cardFilter === 'suspended') params.set('suspended', '1');
    if (ui.cardQuery.trim()) params.set('q', ui.cardQuery.trim());
    params.set('limit', '100');
    const data = await PC.api(`/cards?${params.toString()}`);
    ui.cards = Array.isArray(data?.items) ? data.items : [];
    ui.cardCounts = data?.counts ?? null;
  }

  function renderCardRows(host) {
    const all = ui.cards ?? [];
    if (!all.length) {
      host.appendChild(
        empty(
          ui.cardQuery.trim() || ui.cardFilter !== 'all'
            ? '这个筛选下没有卡片。换个筛选或清空搜索词试试。'
            : '还没有卡片。可以从笔记生成（规则化抽取，不调用模型），也可以手动加一张 —— 新卡会立刻出现在今天的队列里。',
        ),
      );
      return;
    }
    const list = mk('div', 'rv-list');
    for (const card of all) {
      const row = mk('div', `rv-row${card.suspended ? ' off' : ''}`);
      const main = mk('div', 'rv-row-main');
      const titleLine = mk('div', 'rv-row-title');
      titleLine.appendChild(mk('span', 'rv-row-name', card.front));
      if (card.suspended) titleLine.appendChild(badge('已暂停'));
      if (card.source === 'note') titleLine.appendChild(badge('笔记', 'kind'));
      main.appendChild(titleLine);

      if (ui.editing === card.id) {
        main.appendChild(renderCardEditor(card));
      } else {
        main.appendChild(mk('div', 'rv-row-text', card.back));
        main.appendChild(mk('div', 'rv-row-meta', cardMeta(card)));
        const dueLine = mk('div', `rv-row-meta${card.suspended ? '' : ' due'}`);
        dueLine.textContent = card.suspended ? '暂停中：不参与到期队列与统计' : `下次复习：${describeDue(card.due)}`;
        main.appendChild(dueLine);
      }
      row.appendChild(main);

      if (ui.editing !== card.id) {
        const actions = mk('div', 'rv-row-actions');
        actions.appendChild(
          button('改正', 'ghost-btn', () => {
            ui.editing = card.id;
            ui.editDraft = null;
            paint();
          }),
        );
        actions.appendChild(
          button(card.suspended ? '恢复' : '暂停', 'ghost-btn', () => {
            void run(`card:suspend:${card.id}`, async () => {
              await PC.api(`/cards/${encodeURIComponent(card.id)}`, {
                method: 'PATCH',
                body: { suspended: !card.suspended },
              });
              await loadCards();
              PC.toast(card.suspended ? '已恢复：重新参与到期队列' : '已暂停：不再提醒，但记录都留着');
            });
          }),
        );
        const key = `card-del:${card.id}`;
        actions.appendChild(
          iconButton('trash', ui.confirming === key ? '再点一次确认删除' : '删除（不可恢复）', () => {
            if (ui.confirming !== key) return void confirmThen(key);
            return void run(key, async () => {
              await PC.api(`/cards/${encodeURIComponent(card.id)}`, { method: 'DELETE' });
              ui.editing = null;
              await loadCards();
              PC.toast('已删除这张卡');
            });
          }),
        );
        row.appendChild(actions);
      }
      list.appendChild(row);
    }
    host.appendChild(list);
  }

  function renderCardsTab(host) {
    if (ui.missing.cards) {
      host.appendChild(missingNotice('复习卡片', ui.error));
      return;
    }

    host.appendChild(renderStats());

    const tools = mk('div', 'rv-head');
    const left = mk('div', 'rv-head-left');
    const dueCount = ui.dueQueue?.length ?? Number(ui.stats?.dueNow ?? 0);
    const start = button(
      ui.busy === 'cards:reload' ? '拉取中…' : ui.session ? '重新开始复习' : `开始复习（${countText(dueCount)} 张到期）`,
      'primary-btn',
      () => {
        if (ui.session) {
          endSession();
          return;
        }
        void run('cards:start', async () => {
          const data = await PC.api('/cards/due?limit=20');
          ui.dueQueue = Array.isArray(data?.items) ? data.items : [];
          if (!ui.dueQueue.length) {
            PC.toast('没有现在到期的卡片：都清空了');
            await loadCards();
            return;
          }
          startSession();
        });
      },
    );
    start.disabled = ui.busy === 'cards:start';
    left.appendChild(start);
    left.appendChild(
      button('刷新', 'ghost-btn', () => {
        void run('cards:reload', () => loadCards());
      }),
    );
    tools.appendChild(left);
    host.appendChild(tools);

    host.appendChild(renderKeys());

    if (ui.session) host.appendChild(renderSession());

    const forecast = renderForecast();
    if (forecast) host.appendChild(forecast);

    host.appendChild(subtitle('从笔记生成卡片'));
    host.appendChild(
      note(
        '规则化抽取（标题 / 列表 / 定义句），不调用模型：同一篇笔记重复生成是**幂等**的 —— ' +
          '按「笔记 + 正面」去重，点两次不会得到两套卡。抽出来的卡会自动带上笔记的课程与标签。',
      ),
    );
    if (ui.generateForm || ui.generateResult) host.appendChild(renderGenerate());
    else {
      const actions = mk('div', 'rv-form-actions');
      actions.appendChild(
        button('＋ 从笔记生成', 'ghost-btn', () => {
          ui.generateForm = { query: '', noteId: '', limit: 5 };
          ui.generateResult = null;
          paint();
        }),
      );
      host.appendChild(actions);
    }

    host.appendChild(subtitle('手动加卡'));
    if (ui.newCardForm) host.appendChild(renderNewCard());
    else {
      const actions = mk('div', 'rv-form-actions');
      actions.appendChild(
        button('＋ 手动加卡', 'ghost-btn', () => {
          ui.newCardForm = { front: '', back: '', course: '', tags: '' };
          paint();
        }),
      );
      host.appendChild(actions);
    }

    host.appendChild(subtitle(`卡片列表${ui.cards ? `（${countText(ui.cards.length)} 张）` : ''}`));
    host.appendChild(renderCardList());
    if (ui.listsMissing) {
      host.appendChild(alertBox('卡片列表没读到', '列表接口这次失败了，但统计与开始复习仍然可用。', 'warn'));
    }
    renderCardRows(host);
  }

  /* ============================================================ 2) 目标 */

  /**
   * 目标页的数据：概览（`/goals/overview`）+ 目标学分绩 + 管理用列表。
   *
   * 三份**并行、互相独立**地取，任一份失败只降级它自己那一块：
   *   - 概览挂了 → 整页显示"还没装好"（`run()` 统一处理，它是这一页的主数据）；
   *   - 学分绩挂了 → 只有那一栏说"读不到"，清单照常；
   *   - 列表挂了 → 只有"管理目标"那块给提示，概览照常。
   * 串成一条 await 链会让"列表读不到"把整个概览也拖黑，那是没必要的信息损失。
   */
  async function loadGoals() {
    const [overview, target, list] = await Promise.all([
      PC.api('/goals/overview?days=30'),
      PC.api('/goals/target-gpa').catch((error) => {
        // 目标学分绩读不到不该拖垮整个概览：那一栏降级成"读不到"，其余照常
        if (isMissingModule(error)) throw error;
        return null;
      }),
      PC.api('/goals?limit=200')
        .then((data) => (Array.isArray(data?.items) ? data.items : []))
        .catch(() => null),
    ]);
    ui.overview = overview ?? null;
    ui.targetGpa = target ?? null;
    ui.goalList = list;
    // 只在用户还没动过输入框时回填，免得覆盖正在输入的值
    ui.gpaForm = ui.gpaForm || (target?.targetGpa === null || target?.targetGpa === undefined ? '' : String(target.targetGpa));
    return ui.overview;
  }

  /**
   * 目标学分绩一栏（诚实版）。
   *
   * 三条刻意的处理：
   *   1. `current` 为 null 时**显示原因**，绝不显示 0 —— "没有成绩数据"和"学分绩是 0"
   *      是两件事，写错会让人以为系统算错了（`goals/service.js` 的注释同样强调这点）；
   *   2. `disclaimer` **原样显示**（用户自己填的靶子，不是学校公布的保研线）—— 这句话是
   *      产品承诺，不能在界面上改软；
   *   3. `gap` 的正负分开说：差多少 / 高出多少。
   */
  function renderGpa() {
    const gpa = ui.overview?.gpa ?? null;
    const disclaimer = ui.overview?.disclaimer ?? ui.targetGpa?.disclaimer ?? '目标是用户自己填的，不是学校公布的保研线';
    const box = mk('div', 'rv-card');

    const head = mk('div', 'rv-card-head');
    head.appendChild(mk('div', 'rv-card-title', '目标学分绩'));
    const target = gpa?.target ?? ui.targetGpa?.targetGpa ?? null;
    head.appendChild(badge(target === null || target === undefined ? '还没设目标' : `目标 ${target}`, 'gpa'));
    box.appendChild(head);

    const row = mk('div', 'rv-gpa');
    row.appendChild(statCell('当前学分绩', gpa?.current === null || gpa?.current === undefined ? '—' : String(gpa.current)));
    row.appendChild(statCell('目标学分绩', target === null || target === undefined ? '—' : String(target)));
    row.appendChild(
      statCell(
        '差距',
        gpa?.gap === null || gpa?.gap === undefined ? '—' : gpa.gap > 0 ? `还差 ${gpa.gap}` : `高出 ${Math.abs(gpa.gap)}`,
      ),
    );
    box.appendChild(row);

    if (gpa?.current === null || gpa?.current === undefined) {
      // 原因如实说：未登录教务 / 一条成绩都没有 / 学业模块没装配
      box.appendChild(
        alertBox(
          '当前学分绩暂时读不到',
          `${gpa?.message ?? '还没有可用的成绩数据（或尚未登录教务）。'}` +
            `${gpa?.reason ? `（原因：${gpa.reason}）` : ''}` +
            '这一栏不会用 0 顶替：0 和"没有数据"是两件事。',
          'warn',
        ),
      );
    } else {
      const meta = [
        gpa?.source ? `来源 ${gpa.source}` : '',
        Number.isFinite(Number(gpa?.includedCount)) ? `纳入 ${countText(gpa.includedCount)} 门课` : '',
        gpa?.message ?? '',
      ]
        .filter(Boolean)
        .join(' · ');
      box.appendChild(mk('div', 'rv-row-meta', meta));
    }

    box.appendChild(mk('div', 'rv-disclaimer', disclaimer));

    const actions = mk('div', 'rv-form-actions');
    const input = mk('input', 'rv-input rv-number');
    input.type = 'number';
    input.min = '0';
    input.max = '5';
    input.step = '0.01';
    input.placeholder = '例如 3.8';
    input.value = ui.gpaForm ?? '';
    input.addEventListener('input', () => {
      ui.gpaForm = input.value;
    });
    actions.appendChild(input);
    actions.appendChild(
      button(ui.busy === 'gpa:set' ? '保存中…' : '设为目标', 'ghost-btn', () => {
        void run('gpa:set', async () => {
          const raw = String(ui.gpaForm ?? '').trim();
          const value = raw === '' ? null : Number(raw);
          if (value !== null && (!Number.isFinite(value) || value < 0 || value > 5)) {
            throw new Error('目标学分绩必须是 0~5 之间的数字（清空输入框 = 取消目标）');
          }
          const data = await PC.api('/goals/target-gpa', { method: 'POST', body: { targetGpa: value } });
          ui.targetGpa = data ?? null;
          await loadGoals();
          PC.toast(value === null ? '已取消目标学分绩' : `目标学分绩已设为 ${value}`);
        });
      }),
    );
    box.appendChild(actions);
    box.appendChild(
      mk('div', 'rv-field-hint', '这是你自己给自己定的靶子，程序只做两个数的差；不同学校满绩口径不同，所以取值范围放宽到 0~5。'),
    );
    return box;
  }

  function severityGroup(host, items) {
    for (const group of SEVERITY) {
      const rows = items.filter((item) => item.severity === group.id);
      if (!rows.length) continue;
      host.appendChild(subtitle(`${group.label} · ${rows.length} 条`));
      const list = mk('div', 'rv-list');
      for (const item of rows) list.appendChild(renderOverviewRow(item));
      host.appendChild(list);
    }
  }

  function renderOverviewRow(item) {
    const row = mk('div', `rv-row sev-${item.severity ?? 'later'}`);
    const main = mk('div', 'rv-row-main');
    const titleLine = mk('div', 'rv-row-title');
    titleLine.appendChild(badge(SOURCE_LABEL[item.source] ?? item.kind ?? item.source ?? '条目', `src-${item.source ?? 'goal'}`));
    titleLine.appendChild(mk('span', 'rv-row-name', item.title ?? '（无标题）'));
    if (item.course) titleLine.appendChild(badge(item.course));
    if (item.remindHit) titleLine.appendChild(badge('命中你的提醒阈值', 'pin'));
    main.appendChild(titleLine);
    main.appendChild(
      mk(
        'div',
        'rv-row-meta',
        [formatDay(item.date), describeLeft(item.daysLeft), item.overdue ? '已逾期' : ''].filter(Boolean).join(' · '),
      ),
    );
    if (Number.isFinite(Number(item.progress))) main.appendChild(progressBar(Number(item.progress)));
    if (item.milestoneTotal) main.appendChild(mk('div', 'rv-row-meta', `里程碑 ${item.milestoneDone}/${item.milestoneTotal}`));
    row.appendChild(main);

    // 待办与日程来自日历模块：这里只读，改动要去日历页做（两处都能写必然两处不一致）
    if (item.source === 'todo' || item.source === 'event') {
      const actions = mk('div', 'rv-row-actions');
      actions.appendChild(externalBadge(item.source));
      row.appendChild(actions);
    } else if (item.id) {
      const actions = mk('div', 'rv-row-actions');
      actions.appendChild(
        button('详情', 'ghost-btn', () => {
          ui.tab = 'goals';
          ui.editingGoal = item.id;
          ui.goalForm = null;
          paint();
        }),
      );
      row.appendChild(actions);
    }
    return row;
  }

  function progressBar(value) {
    // 进度条同样不写 inline style：用类名分档（每 10% 一档），够看趋势
    const level = value >= 100 ? 10 : Math.max(0, Math.min(9, Math.floor(value / 10)));
    const wrap = mk('div', 'rv-progress');
    wrap.appendChild(mk('div', `rv-progress-fill lv-${level}`));
    wrap.appendChild(mk('span', 'rv-progress-text', `进度 ${value}%`));
    return wrap;
  }

  function goalFormFields(form) {
    const box = mk('div', 'rv-form rv-form-flat');
    box.appendChild(field('标题', textInput(form.title, '例如 期末绩点 3.8 / 12 月前考完六级', (value) => {
      form.title = value;
    })));

    box.appendChild(
      field(
        '类型',
        select(
          [
            { value: 'goal', label: '长期目标' },
            { value: 'deadline', label: '截止事项' },
            { value: 'exam', label: '考试' },
          ],
          form.kind,
          (value) => {
            form.kind = value;
          },
        ),
        '类型影响排序与话术：考试不会说"延期"，长期目标不该有逾期压力',
      ),
    );

    const date = mk('input', 'rv-input');
    date.type = 'date';
    date.value = form.targetDate ?? '';
    date.addEventListener('input', () => {
      form.targetDate = date.value;
    });
    box.appendChild(field('目标日期', date, '格式 YYYY-MM-DD；逾期项永远会出现在概览最上面'));

    box.appendChild(field('课程（可留空）', textInput(form.course, '例如 物理实验', (value) => {
      form.course = value;
    })));

    const progress = mk('input', 'rv-input rv-number');
    progress.type = 'number';
    progress.min = '0';
    progress.max = '100';
    progress.placeholder = '留空 = 还没估过';
    progress.value = form.progress ?? '';
    progress.addEventListener('input', () => {
      form.progress = progress.value;
    });
    box.appendChild(field('进度 %（可留空）', progress, '留空与 0 不同：留空表示"还没估过"，不会显示进度条'));

    const noteArea = textarea(form.note, '为什么要做这件事、跟谁一起…', 2);
    noteArea.addEventListener('input', () => {
      form.note = noteArea.value;
    });
    box.appendChild(field('备注（可留空）', noteArea));

    return box;
  }

  function renderGoalCreator() {
    const form = ui.goalForm ?? { title: '', kind: 'goal', targetDate: todayKey(), course: '', progress: '', note: '' };
    ui.goalForm = form;
    const box = goalFormFields(form);
    const actions = mk('div', 'rv-form-actions');
    actions.appendChild(
      button(ui.busy === 'goal:create' ? '保存中…' : '新建目标', 'primary-btn', () => {
        void run('goal:create', async () => {
          if (!form.title.trim()) throw new Error('标题不能为空');
          if (!form.targetDate) throw new Error('请选择目标日期');
          const body = { title: form.title.trim(), kind: form.kind, targetDate: form.targetDate };
          if (form.course.trim()) body.course = form.course.trim();
          if (String(form.progress ?? '').trim() !== '') body.progress = Number(form.progress);
          if (form.note.trim()) body.note = form.note.trim();
          await PC.api('/goals', { method: 'POST', body });
          ui.goalForm = null;
          await loadGoals();
          PC.toast('已新建目标');
        });
      }),
    );
    actions.appendChild(
      button('取消', 'ghost-btn', () => {
        ui.goalForm = null;
        paint();
      }),
    );
    box.appendChild(actions);
    return box;
  }

  function renderGoalEditor(goal) {
    const form = ui.editGoalDraft ?? {
      title: goal.title ?? '',
      kind: goal.kind ?? 'goal',
      targetDate: goal.targetDate ?? todayKey(),
      course: goal.course ?? '',
      progress: goal.progress === null || goal.progress === undefined ? '' : String(goal.progress),
      note: goal.note ?? '',
    };
    ui.editGoalDraft = form;
    const box = goalFormFields(form);
    box.appendChild(
      field(
        '状态',
        select(
          [
            { value: 'active', label: '进行中' },
            { value: 'done', label: '已完成' },
            { value: 'archived', label: '已归档' },
          ],
          ui.editGoalStatus ?? goal.status ?? 'active',
          (value) => {
            ui.editGoalStatus = value;
          },
        ),
        '标成已完成时进度会自动补到 100（里程碑全勾完**不会**自动完成目标）',
      ),
    );

    const milestones = mk('div', 'rv-milestones');
    for (const step of goal.milestones ?? []) {
      const line = mk('div', 'rv-milestone-edit');
      line.appendChild(
        checkbox(step.title, step.done, (checked) => {
          void run(`goal:ms:${goal.id}:${step.id}`, async () => {
            await PC.api(`/goals/${encodeURIComponent(goal.id)}/progress`, {
              method: 'POST',
              body: { milestoneId: step.id, done: checked },
            });
            await loadGoals();
          });
        }),
      );
      line.appendChild(
        iconButton('trash', '删除这个里程碑', () => {
          void run(`goal:ms-del:${goal.id}:${step.id}`, async () => {
            const next = (goal.milestones ?? [])
              .filter((item) => item.id !== step.id)
              .map((item) => ({ id: item.id, title: item.title, done: item.done, due: item.due ?? null }));
            await PC.api(`/goals/${encodeURIComponent(goal.id)}`, { method: 'PATCH', body: { milestones: next } });
            await loadGoals();
          });
        }),
      );
      milestones.appendChild(line);
    }
    const addRow = mk('div', 'rv-form-actions');
    const input = textInput('', '新里程碑，例如 背完 List 1-10', null);
    addRow.appendChild(input);
    addRow.appendChild(
      button('＋ 加里程碑', 'ghost-btn', () => {
        const title = input.value.trim();
        if (!title) return void PC.toast('先写一句里程碑');
        return void run(`goal:ms-add:${goal.id}`, async () => {
          const next = [
            ...(goal.milestones ?? []).map((item) => ({ id: item.id, title: item.title, done: item.done, due: item.due ?? null })),
            { title },
          ];
          await PC.api(`/goals/${encodeURIComponent(goal.id)}`, { method: 'PATCH', body: { milestones: next } });
          await loadGoals();
        });
      }),
    );
    box.appendChild(field('里程碑', milestones, '勾完最后一步会把进度补到 100；取消勾选不会自动改状态'));
    box.appendChild(addRow);

    const actions = mk('div', 'rv-form-actions');
    actions.appendChild(
      button('保存', 'primary-btn', () => {
        void run(`goal:save:${goal.id}`, async () => {
          if (!form.title.trim()) throw new Error('标题不能为空');
          if (!form.targetDate) throw new Error('请选择目标日期');
          const body = {
            title: form.title.trim(),
            kind: form.kind,
            targetDate: form.targetDate,
            course: form.course.trim(),
            note: form.note.trim(),
            status: ui.editGoalStatus ?? goal.status ?? 'active',
          };
          if (String(form.progress ?? '').trim() === '') body.progress = null;
          else body.progress = Number(form.progress);
          await PC.api(`/goals/${encodeURIComponent(goal.id)}`, { method: 'PATCH', body });
          ui.editingGoal = null;
          ui.editGoalDraft = null;
          ui.editGoalStatus = null;
          await loadGoals();
          PC.toast('已保存');
        });
      }),
    );
    actions.appendChild(
      button('取消', 'ghost-btn', () => {
        ui.editingGoal = null;
        ui.editGoalDraft = null;
        ui.editGoalStatus = null;
        paint();
      }),
    );
    box.appendChild(actions);
    return box;
  }

  function renderGoalRows(host) {
    const items = ui.goalList;
    if (items === null) {
      host.appendChild(alertBox('目标列表没读到', '概览仍然可用；新建/编辑/删除需要列表接口。', 'warn'));
      return;
    }
    if (!items.length) {
      host.appendChild(empty('还没有目标。点「＋ 新建目标」记一个方向（期末绩点、考研、六级），或者一条截止事项。'));
      return;
    }
    const list = mk('div', 'rv-list');
    for (const goal of items) {
      const row = mk('div', `rv-row${goal.status === 'active' ? '' : ' off'}`);
      const main = mk('div', 'rv-row-main');
      const titleLine = mk('div', 'rv-row-title');
      titleLine.appendChild(badge(goal.kindLabel ?? goal.kind ?? '目标', 'kind'));
      titleLine.appendChild(mk('span', 'rv-row-name', goal.title ?? '（无标题）'));
      if (goal.status !== 'active') titleLine.appendChild(badge(goal.statusLabel ?? goal.status));
      if (goal.course) titleLine.appendChild(badge(goal.course));
      main.appendChild(titleLine);

      if (ui.editingGoal === goal.id) {
        main.appendChild(renderGoalEditor(goal));
      } else {
        main.appendChild(
          mk(
            'div',
            'rv-row-meta',
            [formatDay(goal.targetDate), describeLeft(goal.daysLeft), goal.severityLabel ?? ''].filter(Boolean).join(' · '),
          ),
        );
        if (Number.isFinite(Number(goal.progress))) main.appendChild(progressBar(Number(goal.progress)));
        if (goal.milestoneTotal) {
          const steps = mk('div', 'rv-milestones');
          for (const step of goal.milestones ?? []) {
            steps.appendChild(
              checkbox(step.title, step.done, (checked) => {
                void run(`goal:ms:${goal.id}:${step.id}`, async () => {
                  await PC.api(`/goals/${encodeURIComponent(goal.id)}/progress`, {
                    method: 'POST',
                    body: { milestoneId: step.id, done: checked },
                  });
                  await loadGoals();
                });
              }),
            );
          }
          main.appendChild(steps);
        }
        if (goal.note) main.appendChild(mk('div', 'rv-row-text', goal.note));
      }
      row.appendChild(main);

      if (ui.editingGoal !== goal.id) {
        const actions = mk('div', 'rv-row-actions');
        actions.appendChild(
          button('改正', 'ghost-btn', () => {
            ui.editingGoal = goal.id;
            ui.editGoalDraft = null;
            ui.editGoalStatus = null;
            ui.goalForm = null;
            paint();
          }),
        );
        actions.appendChild(
          button('+10%', 'ghost-btn', () => {
            void run(`goal:prog:${goal.id}`, async () => {
              await PC.api(`/goals/${encodeURIComponent(goal.id)}/progress`, { method: 'POST', body: { delta: 10 } });
              await loadGoals();
            });
          }),
        );
        if (goal.status === 'active') {
          actions.appendChild(
            button('完成', 'ghost-btn', () => {
              void run(`goal:done:${goal.id}`, async () => {
                await PC.api(`/goals/${encodeURIComponent(goal.id)}/progress`, { method: 'POST', body: { status: 'done' } });
                await loadGoals();
                PC.toast('已标为完成，进度补到 100%');
              });
            }),
          );
        }
        const key = `goal-del:${goal.id}`;
        actions.appendChild(
          iconButton('trash', ui.confirming === key ? '再点一次确认删除' : '删除（不可恢复）', () => {
            if (ui.confirming !== key) return void confirmThen(key);
            return void run(key, async () => {
              await PC.api(`/goals/${encodeURIComponent(goal.id)}`, { method: 'DELETE' });
              ui.editingGoal = null;
              await loadGoals();
              PC.toast('已删除这个目标');
            });
          }),
        );
        row.appendChild(actions);
      }
      list.appendChild(row);
    }
    host.appendChild(list);
  }

  function renderGoalsTab(host) {
    if (ui.missing.goals) {
      host.appendChild(missingNotice('学习目标', ui.error));
      return;
    }
    const overview = ui.overview ?? {};
    const summary = overview.summary ?? {};

    const stats = mk('div', 'rv-stats');
    stats.appendChild(statCell('已逾期', countText(summary.overdue ?? 0)));
    stats.appendChild(statCell('7 天内', countText(summary.dueWithin7Days ?? 0)));
    stats.appendChild(statCell('30 天内', countText(summary.dueWithin30Days ?? 0)));
    stats.appendChild(statCell('清单共', countText(summary.total ?? 0)));
    host.appendChild(stats);

    const head = mk('div', 'rv-head');
    const left = mk('div', 'rv-head-left');
    left.appendChild(mk('div', 'rv-head-note', `接下来 ${overview.days ?? 30} 天（${formatDay(overview.from)} ~ ${formatDay(overview.to)}）`));
    head.appendChild(left);
    const right = mk('div', 'rv-head-right');
    right.appendChild(
      button('刷新', 'ghost-btn', () => {
        void run('goals:reload', () => loadGoals());
      }),
    );
    head.appendChild(right);
    host.appendChild(head);

    host.appendChild(
      note(
        '这份清单由三处合并而来：本页的目标 / 日历的未完成待办 / 日历的日程事件（考试、报名截止）。' +
          '排序与 daysLeft 都由后端算好 —— 逾期项永远在最上面，隐藏逾期等于骗人。',
      ),
    );

    const items = Array.isArray(overview.items) ? overview.items : [];
    if (!items.length) {
      host.appendChild(empty(`这 ${overview.days ?? 30} 天里没有要面对的事。想记点什么就点下面的「＋ 新建目标」。`));
    } else {
      severityGroup(host, items);
    }
    if (overview.truncated) {
      host.appendChild(note(`清单被截断了：共 ${countText(overview.count ?? 0)} 条，这里显示前 ${countText(items.length)} 条。`));
    }

    host.appendChild(renderGpa());

    host.appendChild(subtitle('管理目标'));
    const actions = mk('div', 'rv-form-actions');
    actions.appendChild(
      button('＋ 新建目标', 'primary-btn', () => {
        ui.goalForm = ui.goalForm
          ? null
          : { title: '', kind: 'goal', targetDate: todayKey(), course: '', progress: '', note: '' };
        ui.editingGoal = null;
        paint();
      }),
    );
    host.appendChild(actions);
    if (ui.goalForm) host.appendChild(renderGoalCreator());
    renderGoalRows(host);
  }

  /* ============================================================ 3) 周报 */

  async function loadWeekly() {
    const data = await PC.api('/weekly/reports?limit=50');
    ui.reports = Array.isArray(data?.items) ? data.items : [];
    // 打开着的那份用列表里的新数据重取一遍（生成后缓存的正文会变）
    if (ui.openReport) {
      const fresh = ui.reports.find((item) => item.id === ui.openReport.id);
      ui.openReport = fresh ?? null;
    }
    // 列表本身不带详情；`ui.weeklyDetail` 由 `openReport()` 单独取（见那里的注释），
    // 所以这里**不清空**它 —— 否则刷新列表会把正在读的正文收起，看着像点空了
    if (!ui.openReport && ui.reports.length && !ui.weeklyDetail) ui.openReport = ui.reports[0];
    return ui.reports;
  }

  /**
   * 展开某一周的正文。
   *
   * 用 `GET /weekly/report?from=&to=` 而不是列表里的缓存正文：这个接口**每次都现算 stats**，
   * 并给出 `statsChangedSinceReport` —— "报告是当时的数字写的，这周后来又变了"必须能看出来。
   * 它永远不会调用模型（GET 不该花钱），这一点也写进界面提示里。
   */
  async function openReport(item) {
    ui.openReport = item;
    const data = await PC.api(`/weekly/report?from=${encodeURIComponent(item.from)}&to=${encodeURIComponent(item.to)}`);
    ui.weeklyDetail = data ?? null;
  }

  /** 统计表格：每个来源一行；`null` 一律显示「—」而不是 0（0 与"没数据"是两件事）。 */
  function renderStatsTable(stats) {
    const box = mk('div', 'rv-card');
    box.appendChild(mk('div', 'rv-card-title', '客观统计（这一周）'));
    if (!stats) {
      box.appendChild(empty('这一周的统计还没读到。'));
      return box;
    }
    const rows = [];
    const push = (label, value) => rows.push([label, value === null || value === undefined ? '—' : String(value)]);

    const conversations = stats.conversations;
    if (conversations) {
      push('AI 对话', `新会话 ${conversations.newConversations} · 提问 ${conversations.userMessages} · 消息 ${conversations.messages}`);
    } else push('AI 对话', null);

    const notes = stats.notes;
    if (notes) push('笔记', `新建 ${notes.created} · 更新 ${notes.updated}（其中仅更新 ${notes.updatedOnly}）`);
    else push('笔记', null);

    const cards = stats.cards;
    if (cards) push('复习卡片', `复习 ${cards.reviews ?? '—'} 次 · 新学会 ${cards.learned ?? '—'} · 到期 ${cards.due ?? '—'} · 共 ${cards.total ?? '—'}`);
    else push('复习卡片', null);

    const goals = stats.goals;
    if (goals) push('学习目标', `进行中 ${goals.active ?? '—'} · 本周改动 ${goals.updated ?? '—'} · 逾期 ${goals.overdue ?? '—'} · 7 天内 ${goals.dueSoon ?? '—'}`);
    else push('学习目标', null);

    const schedule = stats.schedule;
    if (schedule) push('待办', `新增 ${schedule.todosCreated} · 完成 ${schedule.todosCompleted} · 未完成 ${schedule.todosOpen} · 逾期 ${schedule.todosOverdue}`);
    else push('待办', null);

    const grades = stats.grades;
    if (grades) push('成绩', `学分绩 ${grades.gpa ?? '—'}${grades.changed ? '（本周有变动）' : ''} · 记录 ${grades.total ?? '—'} 条`);
    else push('成绩', null);

    const table = mk('div', 'rv-table');
    for (const [label, value] of rows) {
      const line = mk('div', 'rv-table-row');
      line.appendChild(mk('span', 'rv-table-key', label));
      line.appendChild(mk('span', 'rv-table-value', value));
      table.appendChild(line);
    }
    box.appendChild(table);
    return box;
  }

  /** `missing[]` 如实列出：哪些数据源没取到、为什么。 */
  function renderMissing(missing) {
    const list = Array.isArray(missing) ? missing : [];
    if (!list.length) {
      return note('六个数据源这一周都读到了。');
    }
    const box = mk('div', 'rv-missing');
    box.appendChild(mk('div', 'rv-missing-title', `这一周有 ${list.length} 处数据没取全（周报里对应的数字是「—」，不是 0）`));
    for (const item of list) {
      const line = mk('div', 'rv-missing-line');
      line.appendChild(badge(WEEKLY_SOURCE_LABEL[item.source] ?? item.source ?? '未知来源', 'ext'));
      line.appendChild(mk('span', null, `${MISSING_REASON[item.reason] ?? item.reason ?? '读取失败'}：${item.detail ?? ''}`));
      box.appendChild(line);
    }
    return box;
  }

  function renderWeeklyDetail(host) {
    const detail = ui.weeklyDetail;
    const item = ui.openReport;
    if (!item) return;

    const card = mk('div', 'rv-card');
    const head = mk('div', 'rv-card-head');
    head.appendChild(mk('div', 'rv-card-title', `${detail?.week ?? item.week ?? '周报'} · ${item.from} ~ ${item.to}`));
    const fallback = Boolean(detail?.fallback ?? item.fallback);
    const cached = detail ? detail.cached !== false : true;
    head.appendChild(badge(fallback ? '降级：不是 AI 写的' : 'AI 撰写', fallback ? 'fail' : 'ok'));
    card.appendChild(head);
    host.appendChild(card);

    const meta = [
      detail?.generatedAt || item.generatedAt ? `生成于 ${formatStamp(detail?.generatedAt ?? item.generatedAt)}` : '',
      detail?.model ?? item.model ? `模型 ${detail?.model ?? item.model}` : '',
      detail?.reportTruncated || item.reportTruncated ? '正文被截断到上限字数' : '',
      cached ? '' : '还没生成过正文',
    ]
      .filter(Boolean)
      .join(' · ');
    card.appendChild(mk('div', 'rv-row-meta', meta));

    if (fallback) {
      // ★ 这一段是这一页最重要的一条诚实：降级结果不能伪装成 AI 写的
      card.appendChild(
        alertBox(
          '这次没能写成文章，下面是客观统计生成的规则小结',
          `原因：${detail?.reason ?? item.reason ?? '模型不可用'}。` +
            '这段文字不是任何模型写的，模型字段也为空（不保留上一次的模型名，免得误导）。' +
            '想让它重写一次，点下面的「重新生成」。',
          'warn',
        ),
      );
    }
    if (detail?.statsChangedSinceReport) {
      card.appendChild(
        alertBox('这周的数据在生成之后又变了', '正文是生成当时的数字写的，下面的统计是刚刚现算的；想要一致的版本就重新生成。', 'warn'),
      );
    }

    const body = mk('div', 'rv-report');
    const text = detail?.report ?? item.report ?? '';
    if (!text) {
      body.appendChild(empty('这一周还没有正文。点「生成」会调用一次模型（未配置 AI 时降级为规则小结）。'));
    } else if (window.PCRichText) {
      // 模型输出按富文本渲染（Markdown 子集 + LaTeX 子集）；它自带转义，不直接注入原文 HTML
      window.PCRichText.render(body, text);
    } else {
      body.textContent = text; // 没有富文本组件时退回纯文本，宁可少渲染也不吞内容
    }
    card.appendChild(body);

    const stats = detail?.stats ?? item.stats ?? null;
    host.appendChild(renderStatsTable(stats));
    host.appendChild(renderMissing(stats?.missing));

    const actions = mk('div', 'rv-form-actions');
    actions.appendChild(
      button(ui.busy === 'weekly:force' ? '生成中…' : '重新生成（force）', 'ghost-btn', () => {
        void run('weekly:force', () => generateWeekly(item, true));
      }),
    );
    actions.appendChild(
      button('收起', 'ghost-btn', () => {
        ui.openReport = null;
        ui.weeklyDetail = null;
        paint();
      }),
    );
    host.appendChild(actions);

    if (detail?.hint) host.appendChild(note(detail.hint));
  }

  /** 生成某一周的周报。`force` 为真时**重写**已有正文（模型不可用时会降级）。 */
  async function generateWeekly(item, force) {
    const range = item ? { from: item.from, to: item.to } : currentWeekRange();
    const data = await PC.api('/weekly/report/generate', {
      method: 'POST',
      body: { from: range.from, to: range.to, force: Boolean(force) },
    });
    ui.weeklyDetail = data ?? null;
    await loadWeekly();
    ui.openReport = (ui.reports ?? []).find((row) => row.from === range.from && row.to === range.to) ?? ui.openReport;
    if (data?.fallback) {
      PC.toast('模型没写成，已生成客观统计小结（正文里标了降级）');
    } else if (data?.cached) {
      PC.toast('这一周已经有周报了，直接给你看缓存；要重写点「重新生成」');
    } else {
      PC.toast('周报已生成');
    }
  }

  function renderWeeklyTab(host) {
    if (ui.missing.weekly) {
      host.appendChild(missingNotice('学习周报', ui.error));
      return;
    }

    const head = mk('div', 'rv-head');
    const left = mk('div', 'rv-head-left');
    const week = currentWeekRange();
    left.appendChild(mk('div', 'rv-head-note', `本周 ${week.from} ~ ${week.to}`));
    head.appendChild(left);
    const right = mk('div', 'rv-head-right');
    const generate = button(ui.busy === 'weekly:generate' ? '生成中…（要等模型写完）' : '生成本周周报', 'primary-btn', () => {
      void run('weekly:generate', () => generateWeekly(null, false));
    });
    generate.disabled = ui.busy === 'weekly:generate';
    right.appendChild(generate);
    right.appendChild(
      button('刷新', 'ghost-btn', () => {
        void run('weekly:reload', () => loadWeekly());
      }),
    );
    head.appendChild(right);
    host.appendChild(head);

    host.appendChild(
      note(
        '生成会**真的调用一次模型**（也就真的花 token）—— 所以只有点「生成」才会发生，GET 永远不会偷偷调用。' +
          '一周一条：同一周再生成会原地更新同一条，不会越攒越多。模型不可用时降级成客观统计小结，并在正文上方明确标出来。',
      ),
    );

    if (ui.openReport && ui.weeklyDetail) {
      renderWeeklyDetail(host);
    }

    host.appendChild(subtitle('历史周报'));
    const items = ui.reports ?? [];
    if (!items.length) {
      host.appendChild(empty('还没有任何周报。点右上角「生成本周周报」试试 —— 统计部分不依赖模型，一定能出来。'));
      return;
    }
    const list = mk('div', 'rv-list');
    for (const item of items) {
      const row = mk('div', `rv-row${ui.openReport?.id === item.id ? ' current' : ''}`);
      const main = mk('div', 'rv-row-main');
      const titleLine = mk('div', 'rv-row-title');
      titleLine.appendChild(mk('span', 'rv-row-name', item.week ?? `${item.from} ~ ${item.to}`));
      titleLine.appendChild(badge(item.fallback ? '降级小结' : 'AI 撰写', item.fallback ? 'fail' : 'ok'));
      if (item.reportTruncated) titleLine.appendChild(badge('已截断'));
      main.appendChild(titleLine);
      main.appendChild(
        mk('div', 'rv-row-meta', [`${item.from} ~ ${item.to}`, `生成于 ${formatStamp(item.generatedAt)}`, item.model ?? '无模型'].join(' · ')),
      );
      const missingCount = Array.isArray(item.stats?.missing) ? item.stats.missing.length : 0;
      if (missingCount) main.appendChild(mk('div', 'rv-row-meta', `有 ${missingCount} 处数据没取全`));
      row.appendChild(main);

      const actions = mk('div', 'rv-row-actions');
      actions.appendChild(
        button(ui.openReport?.id === item.id ? '刷新正文' : '看正文', 'ghost-btn', () => {
          void run(`weekly:open:${item.id}`, () => openReport(item));
        }),
      );
      const key = `weekly-del:${item.id}`;
      actions.appendChild(
        iconButton('trash', ui.confirming === key ? '再点一次确认删除' : '删除这份周报', () => {
          if (ui.confirming !== key) return void confirmThen(key);
          return void run(key, async () => {
            await PC.api(`/weekly/reports/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
            if (ui.openReport?.id === item.id) {
              ui.openReport = null;
              ui.weeklyDetail = null;
            }
            await loadWeekly();
            PC.toast('已删除这份周报');
          });
        }),
      );
      row.appendChild(actions);
      list.appendChild(row);
    }
    host.appendChild(list);
  }

  /* ------------------------------------------------------------ 注册 */

  window.PCModules.register({
    id: 'review',
    label: '复习',
    icon: 'cards',
    // 65：紧跟在「笔记系统」(50) 之后、「消息」(70) 之前 ——
    // 卡片的主要来源就是笔记，两个入口挨着才走得通"写完笔记顺手生成卡片"这条路。
    order: 65,
    title: '复习',
    render(ctx) {
      ui.mount = ctx.mount;
      ui.error = null;
      paint();
      // 键盘快捷键在**进入本页时**挂上（不是脚本加载时）：
      //   1. 脚本求值时挂全局监听，在渲染层测试的 DOM 桩里会直接炸（那里没有 window.addEventListener），
      //      而"顶层代码不许抛异常"是 views/ 的硬约定；
      //   2. 语义上也更对：复习快捷键只在复习页里该生效，别的页面不该被 1–4 抢键。
      // 处理器内部还会再检查一次（ui.tab === 'cards' 且真的有会话在跑），重复挂也不会误触发。
      if (!keyBound && typeof window.addEventListener === 'function') {
        keyBound = true;
        window.addEventListener('keydown', sessionKeyHandler);
      }
      // 每次进入都强制刷新：卡片可能在对话里被 AI 建过、目标可能在日历里改过、
      // 周报可能刚被定时任务生成过 —— 缓存只服务于"同一次停留里切标签"，不能跨越一次进入
      void run(`load:${ui.tab}`, async () => {
        await reloadTab(ui.tab);
        // 复习页的"从笔记生成"需要一个笔记下拉：装配失败（notes 模块没装）时留空，不拦路
        ui.noteOptions = await PC.api('/notes?limit=200')
          .then((data) => (Array.isArray(data?.items) ? data.items : []))
          .catch(() => []);
      });
    },
  });
})();
