/**
 * 思源学堂视图：首页（自动同步 + 课程）与课程页（课程信息 / 作业 / 课程回放下载 / 资料 / 直播）。
 * 课程页的分节顺序是**作业在前、回放在后** —— 学生进课程页第一件事是看有什么要交的。
 *
 * **这里没有登录表单，也不展示账号信息**：登录已收敛到「设置 → 统一身份认证」，
 * 学堂与学业用同一个学校账号，在设置里登录一次两边都会自动完成认证。
 * 未登录 / 需要两步验证时本视图只给一张引导卡（见 lmsLoginCard），
 * 学号、姓名、缓存统计、服务地址、上次同步这些登录信息一律不再重复展示。
 *
 * 视图内的会话状态只保存在本文件的闭包里（后端才是唯一数据源），
 * 所有类名以 `lms-` 为前缀，样式见同目录 lms.css。
 */

(function () {
/**
 * 视图内的会话态。
 *
 * 刻意不写进 PC.state：学堂的登录态、课程、活动全部由后端持有，
 * 前端只需要记住「最近一次拿到的 status / 课程 / 活动」这些渲染素材。
 * 所有交互都只改这一份数据，再 lmsPaint() 整体重画，避免 DOM 与数据不一致。
 */
const lmsUi = {
  mount: null,
  /**
   * 当前页：`home`（首页：自动同步 + 课程） / `course`（课程页：四个板块页签）
   * / `activity`（活动详情页：作业 / 资料 / 回放 / 直播各自的内容）。
   */
  page: 'home',
  /** 课程页正在看哪门课。 */
  courseId: null,
  /** 课程页当前选中的板块：`homework` / `material` / `replay` / `live`。 */
  tab: 'homework',
  /** 详情页正在看哪条活动，以及取回来的详情。 */
  activityId: null,
  activityDetail: null,
  activityBusy: false,
  activityError: null,
  /** 作业的提交记录（其它类型不拉）。 */
  submissions: null,
  submissionsBusy: false,
  submissionsError: null,
  /** 课程页数据（课程信息 + 该课活动分组），来自 GET /lms/courses/:id。 */
  coursePage: null,
  courseBusy: false,
  courseError: null,
  status: null,
  /** 最近一次取到 status 的时间戳：用来判断快照是否过期（见 lmsMaybeLoad）。 */
  statusAt: 0,
  statusLoading: false,
  statusError: null,
  courses: null,
  coursesBusy: false,
  coursesError: null,
  /**
   * 活动缓存。首页只用它算"这门课有多少作业/网课"（课程行下面那行分布），
   * 课程页的内容走 `/lms/courses/:id`。
   */
  activities: null,
  activitiesBusy: false,
  activitiesError: null,
  /** 课程卡的学期折叠：key → true/false；`courseSemestersAll` 是「全部展开/收起」的覆盖。 */
  courseSemesterToggle: new Map(),
  courseSemestersAll: null,
  /** 自动同步小卡的忙碌态与错误。 */
  autoSyncBusy: false,
  autoSyncError: null,
  /** 回放：已取到的视频列表（按活动 id 缓存）与展开/忙碌状态。 */
  replays: new Map(),
  replayOpen: null,
  replayBusy: false,
  replayError: null,
  /** 课程页各分节的折叠状态（key = `${courseId}:${kind}`，默认展开）。 */
  sectionToggle: new Map(),
  /** 下载任务列表（轮询 GET /lms/downloads）、落盘目录、轮询定时器。 */
  downloads: null,
  downloadDir: null,
  downloadTimer: null,
  /** 这一屏渲染出来的下载状态节点（按任务 id），用于轮询时原地更新、不整屏重画。 */
  downloadNodes: new Map(),
  /** 上一次看到的任务状态，用来判断"刚跑完"要补一次重画。 */
  downloadStatus: new Map(),
  /** 当前这一次渲染出来的节点，用于不重画的原地更新（自动同步那一行）。 */
  refs: { autoSync: null },
};

const LMS_STATUS_LABEL = {
  anonymous: '未登录',
  need_mfa: '需要两步验证',
  need_captcha: '需要图形验证码',
  ready: '已登录',
  error: '登录异常',
};

/**
 * 活动类型页签。
 *
 * 「网课」= 直播 + 回放 + 在线视频（见 LMS_TYPE_MATCH），都是学堂里同一门课的形态，
 * 所以左栏不再单开一个「网课」入口 —— 网课就长在思源学堂里，每一行仍标注具体是哪种。
 * 后端 `/lms/activities?type=online` 用的是同一套划分（modules/lms/config.js）。
 */
const LMS_TYPE_TABS = [
  ['', '全部'],
  ['homework', '作业'],
  ['online', '网课'],
  ['material', '资料'],
];

/**
 * 分组默认全展开的阈值：这一层不超过 12 条就展开（小列表直接看内容），
 * 超了就收起先看概览。课程卡的学期分组、课程页的分节都用它。
 */
const LMS_GROUP_AUTO_EXPAND = 12;

/**
 * 登录态快照的有效期（毫秒）。
 *
 * status 是「登录态 + 缓存统计」的快照，会因为在**设置页**登录 / 退出而失效：
 * 切回本视图时快照太旧就必须重新取，否则会停在旧的登录态上（现象就是：
 * 设置里明明登录了，学堂页还说未登录）。取一个很短的值当闸门，
 * 既保证每次进入视图都拿到新状态，又不会 paint → load → paint 打转。
 */
const STATUS_TTL_MS = 1000;

/** 页签值 -> 命中的底层类型；不在表里就按 type 精确匹配。 */
const LMS_TYPE_MATCH = {
  online: ['lecture_live', 'lesson', 'online_video'],
};

const LMS_ACTIVITY_LABEL = {
  homework: '作业',
  lecture_live: '直播',
  lesson: '课程回放',
  material: '资料',
  course: '课程',
  // 下面这些是实测真实账号里出现、不参与同步的类型。**必须和后端 config.js 的
  // ACTIVITY_TYPE_LABEL 保持一致**，否则列表里会冒出裸英文（online_video 就漏过一次）。
  page: '课程页面',
  forum: '讨论',
  web_link: '外部链接',
  online_video: '在线视频',
  questionnaire: '问卷',
  exam: '考试',
  unknown: '其它',
};

const LMS_ACTION_LABEL = { create: '新建', update: '更新', skip: '跳过', stale: '失效' };

/**
 * 课程页的四个板块 —— **顺序即业务重要性**，也是页签从左到右的顺序。
 *
 * `key` 必须与后端 `coursePage()` 返回的 `groups` 键一致：
 * replay←lesson、homework←homework、material←material、live←lecture_live。
 * 刻意**不加「全部」**：四个板块各自是一种动作（要交的 / 要读的 / 要看的 / 要赶的），
 * 混在一起反而失去分类的意义。
 */
const LMS_TABS = [
  { key: 'homework', label: '作业', empty: '这门课还没有发布作业' },
  { key: 'material', label: '资料', empty: '这门课还没有上传资料' },
  { key: 'replay', label: '课程回放', empty: '这门课还没有可回放的录像' },
  { key: 'live', label: '直播', empty: '这门课还没有直播安排' },
];

/** 页签 key → 后端 groups 的键（两边名字不同，只在这一处换算）。 */
const LMS_TAB_TO_GROUP = { homework: 'homework', material: 'material', replay: 'replay', live: 'live' };

const lmsView = {
  title: '思源学堂',

  render(ctx) {
    lmsUi.mount = ctx.mount;
    lmsPaint();
  },
};

/* --------------------------------------------------------------- 小工具 */

/**
 * 时间展示：思源学堂返回的是不带时区的 ISO 串（`2026-10-14T23:59:00`），
 * 直接按字面量切片最稳，避免 `new Date()` 把它当 UTC 而串到前一天。
 * 只保留到分钟，并把 T 换成空格。
 */
function lmsFormatTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const match = text.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
  if (match) return match[2] ? `${match[1]} ${match[2]}` : match[1];
  return lmsFormatStamp(text);
}

/** 后端生成的 `lastSyncAt` / `fetchedAt` 是带 Z 的 ISO，按本地时间展示。 */
function lmsFormatStamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return (
    `${date.getFullYear()}-${PCUtil.pad2(date.getMonth() + 1)}-${PCUtil.pad2(date.getDate())}` +
    ` ${PCUtil.pad2(date.getHours())}:${PCUtil.pad2(date.getMinutes())}`
  );
}

/** 顶部工具条按钮：忙碌态由数据驱动，重画后自动恢复。 */
function lmsActionButton(label, busyLabel, busy, handler) {
  const button = mk('button', 'ghost-btn', busy ? busyLabel : label);
  button.type = 'button';
  button.disabled = Boolean(busy);
  button.addEventListener('click', () => handler());
  return button;
}

function lmsStatusPill(status) {
  const kind = status === 'ready' ? 'ready' : status === 'error' ? 'error' : status === 'anonymous' ? '' : 'warn';
  return mk('span', `lms-pill ${kind}`.trim(), LMS_STATUS_LABEL[status] ?? status ?? '未知');
}

/* --------------------------------------------------------------- 数据加载 */

/**
 * 业务接口返回 401：学堂登录态已经失效（后端此时已清掉票据），
 * 顺手把状态刷新一次，界面就会退回引导卡，而不是停在一个已经不能用的页面上。
 */
function lmsCheckAuthLost(error) {
  if (error?.status === 401) void lmsLoadStatus();
}

async function lmsLoadStatus({ manual = false } = {}) {
  if (lmsUi.statusLoading) return;
  lmsUi.statusLoading = true;
  lmsUi.statusError = null;
  if (manual) lmsPaint();
  const wasReady = lmsUi.status?.status === 'ready';
  try {
    lmsUi.status = await PC.api('/lms/status');
    // 登录态翻转（在设置里登录 / 退出）时把课程缓存丢掉：否则会拿着上一份
    // 登录态的数据继续渲染，看起来像"登录了但列表还是空的 / 退出了课程还在"。
    if (wasReady !== (lmsUi.status?.status === 'ready')) {
      lmsUi.courses = null;
      lmsUi.activities = null;
      lmsUi.coursePage = null;
      lmsUi.replays = new Map();
      lmsUi.replayOpen = null;
    }
  } catch (error) {
    lmsUi.statusError = error.message;
  } finally {
    // 成功失败都要记时间：否则下一次重画会立刻重试，失败时变成刷屏式请求
    lmsUi.statusAt = Date.now();
    lmsUi.statusLoading = false;
    lmsPaint();
  }
}

async function lmsLoadCourses(refresh) {
  if (lmsUi.coursesBusy) return;
  lmsUi.coursesBusy = true;
  lmsUi.coursesError = null;
  lmsPaint();
  try {
    lmsUi.courses = await PC.api(`/lms/courses${refresh ? '?refresh=1' : ''}`);
  } catch (error) {
    lmsUi.coursesError = error.message;
    // 置空对象而不是 null：避免每次重画都自动重试，把失败的接口刷爆
    lmsUi.courses = { items: [], count: 0, fetchedAt: null };
    lmsCheckAuthLost(error);
  } finally {
    lmsUi.coursesBusy = false;
    lmsPaint();
  }
}

async function lmsLoadActivities(refresh) {
  if (lmsUi.activitiesBusy) return;
  lmsUi.activitiesBusy = true;
  lmsUi.activitiesError = null;
  lmsPaint();
  try {
    // 不传 type：后端在 refresh=1 时并不做类型过滤，统一由前端过滤，行为才一致
    lmsUi.activities = await PC.api(`/lms/activities${refresh ? '?refresh=1' : ''}`);
  } catch (error) {
    lmsUi.activitiesError = error.message;
    lmsUi.activities = { items: [], count: 0, fetchedAt: null };
    lmsCheckAuthLost(error);
  } finally {
    lmsUi.activitiesBusy = false;
    lmsPaint();
  }
}

/**
 * 重画后按需补数据。
 *
 * status 是「登录态 + 缓存统计」的**快照**，会因为在设置页登录 / 退出而失效：
 * 切回本视图时快照太旧就必须重新取，否则会停在旧的登录态上
 * （用户看到的现象就是：设置里明明登录了，学堂页还说未登录）。
 * 用时间戳当闸门，避免 paint → load → paint 打转。
 */
function lmsMaybeLoad() {
  const stale = Date.now() - (lmsUi.statusAt || 0) > STATUS_TTL_MS;
  if (!lmsUi.status || stale) {
    if (!lmsUi.statusLoading) void lmsLoadStatus();
    return;
  }
  if (lmsUi.status.status !== 'ready') return;
  if (lmsUi.courses === null && !lmsUi.coursesBusy) void lmsLoadCourses(false);
  if (lmsUi.activities === null && !lmsUi.activitiesBusy) void lmsLoadActivities(false);
}

/* --------------------------------------------------------------- 自动同步 */

/**
 * 保存自动同步设置：两个字段一起传（后端 updateSettings 也支持只传其中一个）。
 * 成功后用返回的 status 刷新小卡，失败（400 校验 / 401 未登录）走卡片里的错误条。
 */
async function lmsSaveAutoSync(enabled, intervalHours) {
  lmsUi.autoSyncBusy = true;
  lmsUi.autoSyncError = null;
  const controls = lmsUi.refs.autoSync;
  if (controls) {
    controls.toggle.disabled = true;
    controls.hours.disabled = true;
  }
  try {
    const status = await PC.api('/lms/settings', {
      method: 'POST',
      body: { autoSync: enabled, autoSyncIntervalHours: intervalHours },
    });
    lmsUi.status = status;
    PC.toast(enabled ? `已开启自动同步：每 ${intervalHours} 小时` : '已关闭自动同步');
  } catch (error) {
    lmsUi.autoSyncError = error.message;
    lmsCheckAuthLost(error);
  } finally {
    lmsUi.autoSyncBusy = false;
    lmsPaint();
  }
}

/**
 * 未登录时的引导卡。
 *
 * 登录已收敛到「设置 → 统一身份认证」：学堂与学业用的是同一个学校账号，
 * 在那里登录一次，两边都会自动完成各自的认证（共享 Cookie 罐里的 CAS 票据做单点登录）。
 *
 * 所以这里**刻意不再提供密码表单** —— 两个地方各输一次密码既多余，
 * 也容易让人以为"要登录两次"。两步验证与图形验证码同样在设置里完成。
 */
function lmsLoginCard() {
  const card = mk('div', 'card');

  const head = mk('div', 'lms-head');
  head.appendChild(mk('div', 'card-title', '需要登录'));
  head.appendChild(mk('div', 'spacer'));
  head.appendChild(lmsStatusPill(lmsUi.status?.status));
  card.appendChild(head);

  const body = mk('div', 'lms-form');
  body.appendChild(
    mk(
      'div',
      'lms-hint',
      '思源学堂与学业情况用的是同一个学校账号，登录入口已统一到「设置 → 统一身份认证」：在那里登录一次，两个模块都会自动完成认证。',
    ),
  );

  // 把"现在卡在哪一步"如实说出来，用户才知道去设置里要做什么
  const step = lmsUi.status?.status;
  if (step === 'need_mfa') {
    body.appendChild(mk('div', 'lms-hint', '当前需要两步验证，请在设置里完成短信验证码校验。'));
  } else if (step === 'need_captcha') {
    body.appendChild(mk('div', 'lms-hint', '当前需要图形验证码，请在设置里输入。'));
  } else if (step === 'error') {
    body.appendChild(mk('div', 'lms-error', lmsUi.status?.error ?? '登录异常'));
  }

  const actions = mk('div', 'lms-actions');
  const go = mk('button', 'primary-btn', '去设置里登录');
  go.type = 'button';
  go.addEventListener('click', () => {
    // openView 由外壳提供（shell/app.js 把 selectView 暴露到 PC 上）。
    // 万一外壳版本较旧没有它，退化成文字指引，不要让按钮点了没反应。
    if (typeof PC.openView === 'function') PC.openView('settings');
    else PC.toast?.('请打开左侧的「设置」，在「统一身份认证」里登录');
  });
  actions.appendChild(go);

  const retry = mk('button', 'ghost-btn', '刷新状态');
  retry.type = 'button';
  retry.disabled = lmsUi.statusLoading;
  retry.addEventListener('click', () => void lmsLoadStatus({ manual: true }));
  actions.appendChild(retry);

  body.appendChild(actions);
  card.appendChild(body);
  return card;
}

/* --------------------------------------------------------------- 卡片 */

/**
 * 自动同步小卡（POST /lms/settings）。
 *
 * 学堂页只留「自动同步 + 课程」两块：登录态、账号、缓存统计、服务地址、退出登录
 * 全部收在设置页的统一身份认证里，这里不再重复展示。
 *
 * 任何一次改动都把 autoSync 与 autoSyncIntervalHours 一起提交；成功后用返回的 status 刷新卡片。
 */
function lmsAutoSyncCard() {
  const autoSync = lmsUi.status?.autoSync ?? {};
  const interval = Number(autoSync.intervalHours) > 0 ? Number(autoSync.intervalHours) : 6;

  const card = mk('div', 'card');
  const head = mk('div', 'lms-head');
  head.append(
    mk('div', 'card-title', '自动同步'),
    mk('div', 'spacer'),
    mk('span', 'lms-hint', autoSync.enabled ? `已开启 · 每 ${interval} 小时` : '已关闭'),
  );
  card.appendChild(head);

  const body = mk('div', 'card-body');
  const box = mk('div', 'lms-autosync');
  const toggleLabel = mk('label', 'check-field');
  const toggle = mk('input', 'lms-autosync-toggle');
  toggle.type = 'checkbox';
  toggle.checked = Boolean(autoSync.enabled);
  toggle.disabled = Boolean(lmsUi.autoSyncBusy);
  toggleLabel.append(toggle, mk('span', null, '自动同步'));

  const hoursWrap = mk('span', 'lms-hours');
  const hoursInput = mk('input', 'lms-autosync-hours');
  hoursInput.type = 'number';
  hoursInput.min = '1';
  hoursInput.max = '168';
  hoursInput.step = '1';
  hoursInput.title = '自动同步间隔（1~168 小时）';
  hoursInput.value = String(interval);
  hoursInput.disabled = Boolean(lmsUi.autoSyncBusy);
  hoursWrap.append(hoursInput, mk('span', 'lms-hint', '小时'));

  box.append(
    toggleLabel,
    hoursWrap,
    mk('span', 'lms-hint', `最近自动同步：${autoSync.lastRunAt ? lmsFormatStamp(autoSync.lastRunAt) : '尚未执行'}`),
    mk('span', 'lms-hint', '改动即时生效 · 默认关闭'),
  );
  lmsUi.refs.autoSync = { toggle, hours: hoursInput };
  body.append(box, mk('div', 'lms-hint', '自动同步只新建与更新记录，不会删除任何日程（默认关闭）。'));

  const apply = () => {
    if (lmsUi.autoSyncBusy) return;
    const raw = Number(hoursInput.value);
    if (!Number.isFinite(raw) || raw < 1 || raw > 168) {
      lmsUi.autoSyncError = '自动同步间隔需为 1~168 小时';
      lmsPaint();
      return;
    }
    void lmsSaveAutoSync(toggle.checked, raw);
  };
  toggle.addEventListener('change', apply);
  hoursInput.addEventListener('change', apply);

  if (lmsUi.autoSyncError) body.appendChild(mk('div', 'lms-error', `自动同步设置失败：${lmsUi.autoSyncError}`));
  card.appendChild(body);
  return card;
}

/**
 * 首页顶部状态提示：只在「还没读到登录态」或「读取失败」时出现。
 *
 * 原来这里是一张「账号状态」卡（状态徽标 / 账号 / 上次同步 / 缓存 / 服务地址 / 退出登录）。
 * 登录信息既然收在设置页，这里就只留一条读取进度和失败重试。
 */
function lmsStatusNotice() {
  const row = mk('div', 'lms-status-notice');
  if (lmsUi.statusError) {
    row.appendChild(mk('span', 'lms-error', `状态读取失败：${lmsUi.statusError}`));
    const retry = mk('button', 'ghost-btn', lmsUi.statusLoading ? '读取中…' : '重试');
    retry.type = 'button';
    retry.disabled = lmsUi.statusLoading;
    retry.addEventListener('click', () => void lmsLoadStatus({ manual: true }));
    row.appendChild(retry);
  } else {
    row.appendChild(mk('span', 'lms-hint', '正在读取学堂登录状态…'));
  }
  return row;
}
function lmsCoursesCard() {
  const card = mk('div', 'card');
  const items = lmsUi.courses?.items ?? [];
  const semesters = lmsSemesterOptions();

  const head = mk('div', 'lms-head');
  head.appendChild(mk('div', 'card-title', '课程'));
  if (lmsUi.courses?.count) {
    // 学期数一起报出来 —— 课程多的时候它就是"按学期分"的那一层
    head.appendChild(
      mk('span', 'lms-hint', `${lmsUi.courses.count} 门 · ${semesters.length} 个学期`),
    );
  }
  head.appendChild(mk('div', 'spacer'));
  if (semesters.length > 1) {
    head.appendChild(
      lmsAllToggleButton({
        expanded: lmsEverythingExpanded(lmsUi.courseSemestersAll, items.length),
        onClick: () => {
          lmsUi.courseSemestersAll = !lmsEverythingExpanded(lmsUi.courseSemestersAll, items.length);
          lmsResetGroupState({ keep: 'courseSemestersAll' });
          lmsPaint();
        },
      }),
    );
  }
  head.appendChild(lmsActionButton('刷新课程', '刷新中…', lmsUi.coursesBusy, () => void lmsLoadCourses(true)));
  card.appendChild(head);

  if (lmsUi.coursesError) card.appendChild(mk('div', 'lms-error', `课程加载失败：${lmsUi.coursesError}`));

  if (lmsUi.courses === null || (lmsUi.coursesBusy && !items.length)) {
    card.appendChild(mk('div', 'loading', '加载中…'));
    return card;
  }
  if (!items.length) {
    card.appendChild(emptyBox('还没有课程缓存，点「刷新课程」从思源学堂拉取。'));
    return card;
  }

  // 课程也按学期分（新学期在前，最新那个默认展开）
  semesters.forEach((semester, index) =>
    card.appendChild(lmsCourseSemesterSection(semester, index === 0, items.length)),
  );
  if (lmsUi.courses?.fetchedAt) {
    card.appendChild(mk('div', 'lms-hint', `更新于 ${lmsFormatStamp(lmsUi.courses.fetchedAt)}`));
  }
  return card;
}

/** 课程卡里的一个学期分组。 */
function lmsCourseSemesterSection(semester, isNewest, totalCourses) {
  const expanded = lmsGroupExpandedIn(lmsUi.courseSemesterToggle, lmsUi.courseSemestersAll, semester.key, {
    isNewest,
    smallEnough: totalCourses <= LMS_GROUP_AUTO_EXPAND,
  });
  return lmsCollapsibleGroup({
    label: semester.label,
    level: 1,
    tags: [mk('span', 'lms-hint', `${semester.courses.length} 门`)],
    expanded,
    onToggle: (next) => {
      lmsUi.courseSemesterToggle.set(semester.key, next);
      lmsUi.courseSemestersAll = null;
      lmsPaint();
    },
    render: () => semester.courses.map((course) => lmsCourseRow(course, { clickable: true })),
  });
}

function lmsCourseRow(course, { clickable = false } = {}) {
  const row = mk('div', clickable ? 'lms-row lms-row-clickable' : 'lms-row');
  if (clickable) {
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.title = '打开课程页';
    const open = () => lmsOpenCourse(course.id);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
  }
  const title = mk('div', 'lms-row-title');
  title.appendChild(mk('span', null, course.name ?? '（未命名课程）'));
  if (course.courseCode) title.appendChild(mk('span', 'tag', course.courseCode));
  if (course.compulsory) title.appendChild(mk('span', 'tag', '必修'));
  row.appendChild(title);

  const teachers = (course.instructors ?? []).map((item) => item?.name).filter(Boolean).join('、');
  const semester = course.semester?.realName || course.semester?.name || course.semester?.label;
  const meta1 = [
    teachers ? `教师：${teachers}` : null,
    course.credit ? `学分：${course.credit}` : null,
    semester ? `学期：${semester}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (meta1) row.appendChild(mk('div', 'lms-row-meta', meta1));

  const klass = course.teachingClassName || course.klass;
  const range = course.startDate || course.endDate ? `${course.startDate ?? '?'} ~ ${course.endDate ?? '?'}` : null;
  const meta2 = [klass ? `教学班：${klass}` : null, range].filter(Boolean).join(' · ');
  if (meta2) row.appendChild(mk('div', 'lms-row-meta', meta2));

  // 这门课缓存里有多少活动（按类型分）—— "按课程分类"的另一半：
  // 课程列表也能一眼看出哪门课有东西待办
  const counts = lmsCourseActivityCounts(course.id);
  if (counts) row.appendChild(mk('div', 'lms-row-meta lms-course-counts', counts));
  if (clickable) row.appendChild(mk('div', 'lms-row-more', '进入课程页 ›'));

  return row;
}

/**
 * 作业的提交状态是不是"已知"。
 *
 * 活动列表接口**不返回**提交状态（`userSubmitCount`），它是补拉活动详情才有的字段，
 * 而且一次预览最多补拉 40 条。所以"没有这个字段"≠"没提交" —— 是**还没查**。
 * 两者必须分开：混在一起就是在骗用户。
 */
function lmsSubmitKnown(item) {
  return item?.userSubmitCount !== undefined && item?.userSubmitCount !== null;
}

/** 明确未提交（查过了，确实是 0）。 */
function lmsSubmitPending(item) {
  return lmsSubmitKnown(item) && Number(item.userSubmitCount) === 0;
}

/** 某门课在活动缓存里的分布，形如「作业 3（未提交 2） · 网课 12 · 资料 5」。 */
function lmsCourseActivityCounts(courseId) {
  const items = (lmsUi.activities?.items ?? []).filter((item) => String(item.courseId) === String(courseId));
  if (!items.length) return '';
  const homework = items.filter((item) => item.type === 'homework');
  const online = items.filter((item) => (LMS_TYPE_MATCH.online ?? []).includes(item.type));
  const others = items.filter((item) => item.type !== 'homework' && !(LMS_TYPE_MATCH.online ?? []).includes(item.type));
  const pending = homework.filter(lmsSubmitPending).length;
  const unknown = homework.filter((item) => !lmsSubmitKnown(item)).length;
  const detail = [pending ? `未提交 ${pending}` : null, unknown ? `未查 ${unknown}` : null].filter(Boolean).join(' · ');
  return [
    homework.length ? `作业 ${homework.length}${detail ? `（${detail}）` : ''}` : null,
    online.length ? `网课 ${online.length}` : null,
    others.length ? `其它 ${others.length}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** 活动列表：类型与课程都在前端过滤（后端 refresh 时不做类型过滤）。 */
/* ------------------------------------------------------------------ 学期 */

/** 学期的身份：优先 id，其次 code，最后 label（同一学期必须落到同一个键上）。 */
function lmsSemesterKey(semester) {
  if (!semester) return '__none__';
  if (semester.id !== null && semester.id !== undefined) return `id:${semester.id}`;
  if (semester.code) return `code:${semester.code}`;
  const label = lmsSemesterLabel(semester);
  return label === '未知学期' ? '__none__' : `label:${label}`;
}

/** 学期怎么显示：接口已经把 real_name / name / code 归一成 label 了。 */
function lmsSemesterLabel(semester) {
  return semester?.label || semester?.realName || semester?.name || semester?.code || '未知学期';
}

/** 课程 id → 所属学期。活动只带 courseId，学期信息得从课程表查。 */
function lmsCourseSemesterIndex() {
  const index = new Map();
  for (const course of lmsUi.courses?.items ?? []) {
    index.set(String(course.id), {
      key: lmsSemesterKey(course.semester),
      label: course.semester ? lmsSemesterLabel(course.semester) : '未知学期',
    });
  }
  return index;
}

/**
 * 学期之间怎么排：**新学期在前**。
 *
 * 依据优先用学期内最晚的活动时间，其次课程起止日期，最后退化到学期 code
 * （`2026-1` 这种字符串直接比大小也够用）。都没有的（「未知学期」）永远排最后。
 */
function lmsSemesterRank(latestActivity, courses) {
  if (latestActivity) return latestActivity;
  let latest = '';
  for (const course of courses ?? []) {
    const stamp = String(course.endDate || course.startDate || '');
    if (stamp > latest) latest = stamp;
  }
  if (latest) return latest;
  for (const course of courses ?? []) {
    const code = String(course.semester?.code ?? '');
    if (code > latest) latest = code;
  }
  return latest;
}

function lmsSemesterSort(a, b) {
  if (a.key === '__none__') return 1;
  if (b.key === '__none__') return -1;
  return b.rank.localeCompare(a.rank) || a.label.localeCompare(b.label, 'zh');
}

/** 课程列表里出现过的所有学期（新学期在前）—— 学期下拉的选项。 */
function lmsSemesterOptions() {
  const semesters = new Map();
  for (const course of lmsUi.courses?.items ?? []) {
    const key = lmsSemesterKey(course.semester);
    if (!semesters.has(key)) {
      semesters.set(key, {
        key,
        label: course.semester ? lmsSemesterLabel(course.semester) : '未知学期',
        rank: '',
        courses: [],
      });
    }
    semesters.get(key).courses.push(course);
  }
  const list = [...semesters.values()];
  for (const semester of list) semester.rank = lmsSemesterRank('', semester.courses);
  return list.sort(lmsSemesterSort);
}

/* ------------------------------------------------------------------ 分组 */

/**
 * 分组展开与否。三档优先：**手动点过 > 全部展开/收起 > 自适应默认**。
 *
 * 自适应默认：这一层不超过 12 条就展开（小列表直接看内容），超了就收起（先看概览）。
 * 两层的"这一层"判据不同，故意的：
 *   - **学期层**看**整批**条数 —— 大账号（上千条）进来只展开最新学期，先看概览；
 *   - **课程层**看**这个学期自己**的条数 —— 展开一个小学期时，里面的课直接铺开。
 * 学期层还额外保证**最新学期一定展开**，否则大账号第一眼是一片折叠标题。
 */
function lmsGroupExpandedIn(map, allOverride, key, { isNewest = false, smallEnough = true } = {}) {
  const explicit = map.get(key);
  if (explicit !== undefined) return explicit;
  if (allOverride !== null) return allOverride;
  return smallEnough || isNewest;
}

/** 分组表头上的小标记：条数 / 未提交 / 未查 / 最近时间。 */
function lmsGroupTags({ count, pending = 0, unknown = 0, latest = '' }) {
  const tags = [mk('span', 'lms-hint', `${count} 条`)];
  if (pending) tags.push(mk('span', 'tag late', `未提交 ${pending}`));
  if (unknown) {
    const tag = mk('span', 'lms-hint', `未查 ${unknown}`);
    tag.title = '活动列表不含作业提交状态；「预览同步」时会补拉详情，那时才知道交没交';
    tags.push(tag);
  }
  if (latest) tags.push(mk('span', 'lms-hint lms-group-latest', `最近 ${lmsFormatTime(latest)}`));
  return tags;
}

/**
 * 通用可折叠分组：表头（箭头 + 标题 + 标记）+ 内容。
 *
 * 三处共用（活动卡的学期层、学期里的课程层、课程卡的学期层），免得三份各写一遍还长歪。
 * `render` 只在展开时调用 —— 活动上千条时这一步很关键。
 */
function lmsCollapsibleGroup({ label, level = 1, tags = [], expanded, onToggle, render }) {
  const box = mk('div', `lms-group lms-group-l${level}`);
  const head = mk('button', 'lms-group-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  head.appendChild(mk('span', 'lms-group-caret', expanded ? '▾' : '▸'));
  head.appendChild(mk('span', 'lms-group-name', label));
  for (const tag of tags) if (tag) head.appendChild(tag);
  head.addEventListener('click', () => onToggle(!expanded));
  box.appendChild(head);
  if (expanded) {
    const body = mk('div', `lms-list lms-group-body lms-group-body-l${level}`);
    for (const child of render()) body.appendChild(child);
    box.appendChild(body);
  }
  return box;
}

/** 「全部展开 / 全部收起」按钮（一层状态，按钮文案跟着实际状态走）。 */
function lmsAllToggleButton({ expanded, onClick }) {
  const button = mk('button', 'ghost-btn lms-group-all', expanded ? '全部收起' : '全部展开');
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

/** 当前是否"整体展开"（决定按钮文案）。 */
function lmsEverythingExpanded(override, total) {
  if (override !== null) return override;
  return total <= LMS_GROUP_AUTO_EXPAND;
}

/** 课程卡的「全部展开/收起」：清掉逐个点过的记录（`keep` 的那个覆盖值留着）。 */
function lmsResetGroupState({ keep } = {}) {
  if (keep !== 'courseSemestersAll') lmsUi.courseSemestersAll = null;
  lmsUi.courseSemesterToggle = new Map();
}

/* --------------------------------------------------------------- 课程页 */

/** 打开某门课的课程页（首页课程行点一下走这里）。 */
function lmsOpenCourse(courseId) {
  lmsUi.page = 'course';
  lmsUi.courseId = String(courseId);
  lmsUi.coursePage = null;
  lmsUi.courseError = null;
  // 默认停在「作业」：进课程页第一件事是看有什么要交的
  lmsUi.tab = 'homework';
  lmsUi.activityId = null;
  lmsUi.activityDetail = null;
  lmsUi.replayOpen = null;
  lmsUi.replayError = null;
  lmsUi.sectionToggle = new Map();
  lmsPaint();
}

/** 回首页（课程页左上角返回键）。 */
function lmsBackHome() {
  lmsUi.page = 'home';
  lmsUi.courseId = null;
  lmsUi.coursePage = null;
  lmsUi.courseError = null;
  lmsUi.activityId = null;
  lmsUi.activityDetail = null;
  lmsUi.activityError = null;
  lmsUi.submissions = null;
  lmsStopDownloadPolling();
  lmsPaint();
}

/**
 * 课程页数据。**打开课程就自动拉一次**（服务端按课程做 10 分钟节流）。
 *
 * 以前这里只在 `refresh` 时才联网，于是点进一门课四个板块全空，
 * 必须自己去找「刷新本课活动」按钮。现在默认就让服务端判断要不要补。
 */
async function lmsLoadCoursePage({ refresh = false } = {}) {
  if (!lmsUi.courseId || lmsUi.courseBusy) return;
  lmsUi.courseBusy = true;
  lmsUi.courseError = null;
  if (refresh) lmsUi.coursePage = null;
  lmsPaint();
  try {
    const suffix = refresh ? '?refresh=1' : '';
    lmsUi.coursePage = await PC.api(`/lms/courses/${encodeURIComponent(lmsUi.courseId)}${suffix}`);
  } catch (error) {
    lmsUi.courseError = error.message ?? String(error);
  } finally {
    lmsUi.courseBusy = false;
    lmsPaint();
  }
}

/** 重画后按需补课程页数据。 */
function lmsMaybeLoadCourse() {
  if (lmsUi.coursePage === null && !lmsUi.courseBusy) void lmsLoadCoursePage();
}

/**
 * 活动行（作业/资料/直播共用）：标题 + 时间 + 提交状态，**整行可点进详情页**。
 *
 * 键盘可达：行是 `role="button"` + `tabindex="0"`，Enter/Space 等同于点击 ——
 * 用 `div` 而不是 `<button>` 是因为行里以后可能要放子按钮（下载/取消），
 * 按钮套按钮是非法 HTML。
 */
function lmsCourseActivityRow(item) {
  const row = mk('div', 'lms-row lms-row-clickable');
  row.setAttribute('role', 'button');
  row.setAttribute('tabindex', '0');
  row.title = '查看详情';

  const title = mk('div', 'lms-row-title');
  title.appendChild(mk('span', null, item.title ?? '（无标题）'));
  title.appendChild(mk('span', 'tag', LMS_ACTIVITY_LABEL[item.type] ?? item.type ?? '活动'));
  if (lmsSubmitKnown(item) && Number(item.userSubmitCount) > 0) title.appendChild(mk('span', 'tag submitted', '已提交'));
  if (lmsSubmitKnown(item) && Number(item.userSubmitCount) === 0) title.appendChild(mk('span', 'tag late', '未提交'));
  if (item.published === false) title.appendChild(mk('span', 'tag', '未发布'));
  row.appendChild(title);
  const start = lmsFormatTime(item.startTime);
  const end = lmsFormatTime(item.endTime);
  row.appendChild(mk('div', 'lms-row-meta', start || end ? `开始 ${start || '—'} · 结束 ${end || '—'}` : '无时间信息'));
  row.appendChild(mk('span', 'lms-row-chevron', '›'));

  const open = () => lmsOpenActivity(item.id);
  row.addEventListener('click', open);
  row.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault?.();
    open();
  });
  return row;
}

/** 体积文案（1024 进制），和后端 humanSize 保持一致的口径。 */
function lmsSizeText(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = size >= 100 || unit === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)}${units[unit]}`;
}

/** 找一个回放视频对应的下载任务（按 活动 + 标签 匹配）。 */
function lmsJobFor(activityId, video) {
  return (lmsUi.downloads?.items ?? []).find(
    (job) => String(job.activityId ?? '') === String(activityId ?? '') && job.labelText === (video.labelText || '视频'),
  );
}

function lmsDownloadText(job) {
  if (job.status === 'running') {
    const percent = job.percent === null || job.percent === undefined ? '…' : `${job.percent}%`;
    const speed = job.speed ? ` · ${lmsSizeText(job.speed)}/s` : '';
    return `下载中 ${percent}${speed}`;
  }
  if (job.status === 'done') return `已保存（${lmsSizeText(job.total ?? job.bytes)}）`;
  if (job.status === 'cancelled') return '已取消';
  return `失败：${job.error ?? '未知原因'}`;
}

/** 下载状态节点（渲染时记进 downloadNodes，轮询时原地改文字，不整屏重画）。 */
function lmsDownloadStatus(job) {
  const node = mk('span', `lms-download-status is-${job.status}`, lmsDownloadText(job));
  if (job.path) node.title = job.path;
  lmsUi.downloadNodes.set(job.id, node);
  lmsUi.downloadStatus.set(job.id, job.status);
  return node;
}

/** 回放分节里的一行：一个回放活动 + 取到的视频 + 下载按钮/进度。 */
function lmsReplayRow(item) {
  const row = mk('div', 'lms-row');
  const title = mk('div', 'lms-row-title');
  title.appendChild(mk('span', null, item.title ?? '（无标题）'));
  title.appendChild(mk('span', 'tag', '课程回放'));
  row.appendChild(title);

  const start = lmsFormatTime(item.startTime);
  const end = lmsFormatTime(item.endTime);
  row.appendChild(mk('div', 'lms-row-meta', start || end ? `开始 ${start || '—'} · 结束 ${end || '—'}` : '无时间信息'));

  const actions = mk('div', 'lms-row-actions');
  const busy = lmsUi.replayBusy && String(lmsUi.replayOpen) === String(item.id);
  const button = mk('button', 'ghost-btn', busy ? '取视频…' : lmsUi.replays.has(String(item.id)) ? '重新取视频' : '取视频');
  button.type = 'button';
  button.disabled = busy;
  button.addEventListener('click', () => void lmsLoadReplays(item));
  actions.appendChild(button);
  row.appendChild(actions);

  const videos = lmsUi.replays.get(String(item.id));
  if (videos) {
    const list = mk('div', 'lms-replay-videos');
    if (!videos.length) list.appendChild(mk('div', 'lms-hint', '这次回放没有可下载的视频'));
    for (const video of videos) {
      const line = mk('div', 'lms-replay-video');
      line.appendChild(mk('span', 'lms-replay-name', `${video.labelText}${video.sizeText ? ` · ${video.sizeText}` : ''}`));
      if (video.isBestAudio) line.appendChild(mk('span', 'tag', '音质更好'));

      /*
       * 「在线播放」：直接开录播站给的播放地址（带签名，浏览器能直接放）。
       *
       * 为什么是 `target="_blank"` 而不是内嵌 `<video>`：播放地址在录播站那个域上，
         * 内嵌要处理跨域与票据，而**打开新标签页**是浏览器原生就会做的事，
         * 不经过我们这一层，也就不会把票据泄漏到页面里。
       * 没有 `playUrl` 的录像不显示这个按钮（有些只给了下载直链）。
       */
      if (video.playUrl) {
        const play = mk('a', 'ghost-btn lms-replay-play', '在线播放');
        play.href = video.playUrl;
        play.target = '_blank';
        play.rel = 'noopener';
        line.appendChild(play);
      }

      const job = lmsJobFor(item.id, video);
      if (job) {
        line.appendChild(lmsDownloadStatus(job));
        if (job.status === 'running') {
          const cancel = mk('button', 'ghost-btn', '取消');
          cancel.type = 'button';
          cancel.addEventListener('click', () => void lmsCancelDownload(job.id));
          line.appendChild(cancel);
        }
      } else {
        const download = mk('button', 'ghost-btn', '下载');
        download.type = 'button';
        download.addEventListener('click', () => void lmsStartDownload(item, video));
        line.appendChild(download);
      }
      list.appendChild(line);
    }
    row.appendChild(list);
  }
  if (lmsUi.replayError && String(lmsUi.replayOpen) === String(item.id)) {
    row.appendChild(mk('div', 'lms-error', lmsUi.replayError));
  }
  return row;
}

/** 取一次回放的视频列表（后端去学堂与录播站换票据，注意别把地址打日志）。 */
async function lmsLoadReplays(item) {
  if (lmsUi.replayBusy) return;
  lmsUi.replayBusy = true;
  lmsUi.replayOpen = item.id;
  lmsUi.replayError = null;
  lmsPaint();
  try {
    const data = await PC.api(`/lms/activities/${encodeURIComponent(item.id)}/replays`);
    lmsUi.replays.set(String(item.id), data.videos ?? []);
  } catch (error) {
    lmsUi.replayError = error.message ?? String(error);
  } finally {
    lmsUi.replayBusy = false;
    lmsPaint();
  }
}

async function lmsStartDownload(item, video) {
  try {
    await PC.api('/lms/downloads', {
      method: 'POST',
      body: {
        activityId: item.id,
        video: {
          downloadUrl: video.downloadUrl,
          playUrl: video.playUrl,
          label: video.label,
          labelText: video.labelText,
          size: video.size,
        },
      },
    });
    PC.toast?.(`开始下载：${item.title ?? '回放'}`);
    await lmsRefreshDownloads();
    lmsStartDownloadPolling();
  } catch (error) {
    lmsUi.replayError = error.message ?? String(error);
  }
  lmsPaint();
}

async function lmsCancelDownload(id) {
  try {
    await PC.api(`/lms/downloads/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  } catch (error) {
    PC.toast?.(`取消失败：${error.message}`);
  }
  await lmsRefreshDownloads();
  lmsPaint();
}

async function lmsRefreshDownloads() {
  try {
    const data = await PC.api('/lms/downloads');
    lmsUi.downloads = data;
    lmsUi.downloadDir = data.downloadDir ?? lmsUi.downloadDir;
    return data;
  } catch {
    return null;
  }
}

/**
 * 下载进度轮询：只在有任务在跑时开着。
 *
 * 更新策略：**原地改文字**（节点在渲染时记进 `downloadNodes`）。否则每 800ms 整屏重画，
 * 列表会闪、折叠状态和滚动位置也保不住。任务从"跑着"变成终态时补一次重画 ——
 * 那一刻按钮要从「取消」变回「下载」。
 */
function lmsStartDownloadPolling() {
  if (lmsUi.downloadTimer) return;
  lmsUi.downloadTimer = setInterval(async () => {
    const data = await lmsRefreshDownloads();
    if (!data) return;
    let finished = false;
    for (const job of data.items) {
      if (lmsUi.downloadStatus.get(job.id) === 'running' && job.status !== 'running') finished = true;
      lmsUi.downloadStatus.set(job.id, job.status);
      const node = lmsUi.downloadNodes.get(job.id);
      if (node) {
        node.textContent = lmsDownloadText(job);
        node.className = `lms-download-status is-${job.status}`;
      }
    }
    if (!data.active) {
      lmsStopDownloadPolling();
      if (finished) lmsPaint();
    }
  }, 800);
}

function lmsStopDownloadPolling() {
  if (lmsUi.downloadTimer) {
    clearInterval(lmsUi.downloadTimer);
    lmsUi.downloadTimer = null;
  }
}

/** 课程页整屏：返回键 + 课程信息 + 回放（可下载）+ 作业/资料/直播。 */
/* ------------------------------------------------- 课程页：四个板块 + 详情页 */

/** 切板块：纯本地，不联网（四个板块的内容早在课程页数据里了）。 */
function lmsSelectTab(key) {
  if (!LMS_TABS.some((tab) => tab.key === key)) return;
  lmsUi.tab = key;
  lmsPaint();
}

/**
 * 页签条：四个板块 + 条数。
 *
 * 条数**为 0 也显示**："这门课没有资料"是有效信息；藏起来会让人以为漏加载了。
 */
function lmsTabBar(page) {
  const bar = mk('div', 'lms-tabs');
  bar.setAttribute('role', 'tablist');
  for (const tab of LMS_TABS) {
    const count = page?.groups?.[LMS_TAB_TO_GROUP[tab.key]]?.length ?? 0;
    const active = lmsUi.tab === tab.key;
    const button = mk('button', `lms-tab${active ? ' active' : ''}`);
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', active ? 'true' : 'false');
    button.append(mk('span', 'lms-tab-label', tab.label), mk('span', 'lms-tab-count', String(count)));
    button.addEventListener('click', () => lmsSelectTab(tab.key));
    bar.appendChild(button);
  }
  return bar;
}

/** 当前板块的活动列表（或空态）。 */
function lmsTabPanel(page) {
  const tab = LMS_TABS.find((item) => item.key === lmsUi.tab) ?? LMS_TABS[0];
  const items = page?.groups?.[LMS_TAB_TO_GROUP[tab.key]] ?? [];
  const box = mk('div', 'lms-tab-panel');
  if (!items.length) {
    box.appendChild(emptyBox(tab.empty));
    return box;
  }
  for (const item of items) box.appendChild(lmsCourseActivityRow(item));
  return box;
}

/** 进活动详情页。 */
function lmsOpenActivity(activityId) {
  lmsUi.page = 'activity';
  lmsUi.activityId = String(activityId);
  lmsUi.activityDetail = null;
  lmsUi.activityError = null;
  lmsUi.submissions = null;
  lmsUi.submissionsError = null;
  lmsUi.replayOpen = null;
  lmsUi.replayError = null;
  lmsPaint();
  void lmsLoadActivity();
}

/** 从详情页回到课程页（**回到原来那个板块**，不是跳回第一个）。 */
function lmsBackToCourse() {
  lmsUi.page = 'course';
  lmsUi.activityId = null;
  lmsUi.activityDetail = null;
  lmsUi.activityError = null;
  lmsUi.submissions = null;
  lmsUi.submissionsError = null;
  lmsStopDownloadPolling();
  lmsPaint();
}

/**
 * 拉活动详情。
 *
 * 作业会**再拉一次提交记录** —— "我交没交、多少分、老师怎么评"是作业板块最要紧的三件事，
 * 而详情接口本身不带这些（要单独问 `submission_list`）。
 */
async function lmsLoadActivity({ refresh = false } = {}) {
  if (!lmsUi.activityId || lmsUi.activityBusy) return;
  lmsUi.activityBusy = true;
  lmsUi.activityError = null;
  if (refresh) lmsUi.activityDetail = null;
  lmsPaint();
  try {
    const data = await PC.api(`/lms/activities/${encodeURIComponent(lmsUi.activityId)}`);
    lmsUi.activityDetail = data.item ?? null;
    if (lmsUi.activityDetail?.type === 'homework') {
      lmsUi.submissionsBusy = true;
      lmsPaint();
      try {
        const mine = await PC.api(`/lms/activities/${encodeURIComponent(lmsUi.activityId)}/submission`);
        lmsUi.submissions = mine;
      } catch (error) {
        // 提交记录拿不到不该让整页失败 —— 描述和附件仍然有用
        lmsUi.submissionsError = error.message ?? String(error);
      } finally {
        lmsUi.submissionsBusy = false;
      }
    }
  } catch (error) {
    lmsUi.activityError = error.message ?? String(error);
  } finally {
    lmsUi.activityBusy = false;
    lmsPaint();
  }
}

/** 重画后按需补详情。 */
function lmsMaybeLoadActivity() {
  if (lmsUi.page !== 'activity' || lmsUi.activityDetail || lmsUi.activityBusy) return;
  void lmsLoadActivity();
}

/** 一行附件：图标 + 名字 + 体积 + 「下载」/「预览」。 */
function lmsAttachmentRow(upload) {
  const row = mk('div', 'lms-file-row');
  const kindIcon = { video: '▶', audio: '♪', image: '▣', document: '▤', file: '▥' }[upload.kind] ?? '▥';
  row.appendChild(mk('span', `lms-file-icon lms-file-${upload.kind ?? 'file'}`, kindIcon));
  const main = mk('div', 'lms-file-main');
  main.append(mk('div', 'lms-file-name', upload.name ?? '（未命名附件）'), mk('div', 'lms-file-meta', lmsSizeText(upload.size)));
  row.appendChild(main);

  const actions = mk('div', 'lms-file-actions');
  const filename = encodeURIComponent(upload.name ?? '');
  if (upload.downloadUrl) {
    const download = mk('a', 'ghost-btn lms-file-btn', '下载');
    download.href = `${PC.state.apiBase}${upload.downloadUrl}?name=${filename}`;
    download.setAttribute('download', upload.name ?? '');
    actions.appendChild(download);
  }
  if (upload.previewUrl) {
    const preview = mk('a', 'ghost-btn lms-file-btn', '预览');
    preview.href = `${PC.state.apiBase}${upload.previewUrl}&name=${filename}`;
    preview.target = '_blank';
    preview.rel = 'noopener';
    actions.appendChild(preview);
  }
  // 老师关掉了下载：明说一句，别让用户以为按钮漏画了
  if (!upload.downloadUrl && !upload.previewUrl) actions.appendChild(mk('span', 'lms-hint', '不可下载'));
  row.appendChild(actions);
  return row;
}

function lmsAttachmentList(uploads) {
  const list = mk('div', 'lms-files');
  for (const upload of uploads ?? []) list.appendChild(lmsAttachmentRow(upload));
  if (!list.childNodes.length) list.appendChild(mk('div', 'lms-hint', '没有附件'));
  return list;
}

/** 作业的「我的提交」：分数 / 评语 / 提交的附件。 */
function lmsSubmissionBlock() {
  const box = mk('div', 'lms-submission');
  if (lmsUi.submissionsBusy) {
    box.appendChild(mk('div', 'lms-hint', '正在查提交记录…'));
    return box;
  }
  if (lmsUi.submissionsError) {
    box.appendChild(mk('div', 'lms-hint', `提交记录查不到：${lmsUi.submissionsError}`));
    return box;
  }
  const list = lmsUi.submissions?.submissions ?? [];
  if (!lmsUi.submissions) {
    box.appendChild(mk('div', 'lms-hint', '还没查提交记录'));
    return box;
  }
  if (!list.length) {
    box.appendChild(mk('div', 'lms-hint', '你还没有提交过这份作业'));
    return box;
  }
  for (const item of list) {
    const one = mk('div', 'lms-submission-item');
    const head = mk('div', 'lms-submission-head');
    head.appendChild(mk('span', 'tag submitted', item.status === 'graded' ? '已批改' : '已提交'));
    if (item.score !== null && item.score !== undefined) head.appendChild(mk('span', 'tag', `${item.score} 分`));
    if (item.submittedAt) head.appendChild(mk('span', 'lms-hint', lmsFormatTime(item.submittedAt)));
    one.appendChild(head);
    if (item.comment) one.appendChild(mk('div', 'lms-submission-text', item.comment));
    if (item.instructorComment) one.appendChild(mk('div', 'lms-submission-text', `评语：${item.instructorComment}`));
    if (item.uploads?.length) one.appendChild(lmsAttachmentList(item.uploads));
    box.appendChild(one);
  }
  return box;
}

/** 详情页里的一块（标签 + 内容）。 */
function lmsDetailSection(title, body, tag) {
  const box = mk('div', 'lms-detail-section');
  const head = mk('div', 'lms-detail-head');
  head.appendChild(mk('div', 'card-title', title));
  if (tag) head.appendChild(mk('span', 'tag', tag));
  box.append(head, body);
  return box;
}

/**
 * 把学堂返回的 **HTML 说明**转成可读纯文本。
 *
 * 为什么必须转：作业/资料的 `description` 是 HTML（`<p>实现单链表并提交源码</p>`），
 * 直接 `textContent` 写进去就会把标签原样显示出来（用户报的就是这个）。
 *
 * 为什么是"转文本"而不是"直接渲染 HTML"：
 *   · 输出是**纯文本**、仍旧用 `textContent` 挂上去，**在结构上就没有注入风险** ——
 *     不需要引入净化库、也不需要信任学校页面的 HTML；
 *   · 代价是丢掉粗体/链接等样式。说明文字通常是几句要求和一两个链接，
 *     可读性不受影响；真需要富文本再单独做白名单渲染。
 *
 * 保留结构：块级标签与新行标签转成换行，`<li>` 变成项目符号 ——
 * 否则一条条要求会被压成一行，反而更难读。
 */
function lmsHtmlToText(raw) {
  const html = String(raw ?? '');
  if (!html.trim()) return '';
  // 已经是纯文本（没有标签）就别动了，避免把正文里的 "<" 误伤
  if (!/<[a-z!/][^>]*>/i.test(html)) return html.trim();
  let text = html
    // 列表项：转成项目符号，换行由后面的规则补
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|blockquote|pre)>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n———\n')
    // 表格单元格之间给个分隔，否则几列会连成一串
    .replace(/<\/(td|th)>/gi, '  ')
    // 其余标签一律剥掉（注释也一起）
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '');
  // 常见实体解码（顺序要紧：&amp; 最后解，否则 &amp;lt; 会被解成 <）
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gi, '&');
  // 收敛空行与行首尾空白
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    // 项目符号前面不留空行：`</p>` 与 `<li>` 各补了一个换行，会变成一条空行一条要点
    .replace(/\n+(?=• )/g, '\n')
    .trim();
}

/**
 * 找出这次直播对应的回放活动。
 *
 * 学堂把"直播"和"它的录像"当成两条独立的活动，靠 `lesson_start` 关联
 * （参考项目也是这么做的：`relatedLessonRequested(lesson_start_time)`）。
 * 先按时间戳精确匹配；匹配不到再退回"同一天"，因为两边的秒级写法并不总是完全一致。
 */
function lmsFindRelatedReplay(detail) {
  const start = detail?.lessonStart;
  if (!start) return null;
  const replays = lmsUi.coursePage?.groups?.replay ?? [];
  const exact = replays.find((item) => item.lessonStart && String(item.lessonStart) === String(start));
  if (exact) return exact;
  const day = String(start).slice(0, 10);
  return replays.find((item) => item.lessonStart && String(item.lessonStart).slice(0, 10) === day) ?? null;
}

/**
 * 详情页主体 —— **按类型给各自的内容**，这是"每个板块点进去都有自己的东西"的落点：
 *   作业：描述 + 分数概况 + 附件 + 我的提交
 *   资料：描述 + 附件（下载/预览）
 *   回放：视频列表 + 下载
 *   直播：起止 + 关联回放
 */
function lmsActivityDetailBody(detail) {
  const wrap = mk('div', 'lms-detail');
  const type = detail.type;

  // 说明是 HTML（`<p>…</p>`），必须转成纯文本再挂 —— 否则标签会原样显示出来
  const description = lmsHtmlToText(detail.description);
  if (description) {
    wrap.appendChild(lmsDetailSection('说明', mk('div', 'lms-description', description)));
  }

  if (type === 'homework') {
    const stats = [];
    if (detail.userSubmitCount !== null && detail.userSubmitCount !== undefined) {
      stats.push(detail.userSubmitCount > 0 ? '你已提交' : '你还没提交');
    }
    if (detail.averageScore !== null && detail.averageScore !== undefined) stats.push(`平均 ${detail.averageScore}`);
    if (detail.highestScore !== null && detail.highestScore !== undefined) stats.push(`最高 ${detail.highestScore}`);
    if (stats.length) wrap.appendChild(lmsDetailSection('概况', mk('div', 'lms-description', stats.join(' · '))));
    wrap.appendChild(lmsDetailSection('我的提交', lmsSubmissionBlock()));
    wrap.appendChild(lmsDetailSection('老师发的附件', lmsAttachmentList(detail.uploads), `${detail.uploads?.length ?? 0} 个`));
    return wrap;
  }

  if (type === 'material') {
    wrap.appendChild(lmsDetailSection('附件', lmsAttachmentList(detail.uploads), `${detail.uploads?.length ?? 0} 个`));
    return wrap;
  }

  if (type === 'lesson') {
    // 回放走已有的视频列表（要联网换录播站票据，所以是显式动作）
    wrap.appendChild(lmsDetailSection('录像', lmsReplayBlock(detail)));
    return wrap;
  }

  if (type === 'lecture_live') {
    const rows = mk('div', 'lms-info');
    for (const [label, value] of [
      ['开始', lmsFormatTime(detail.startTime)],
      ['结束', lmsFormatTime(detail.endTime)],
    ]) {
      if (!value) continue;
      const line = mk('div', 'lms-info-row');
      line.append(mk('span', 'lms-info-key', label), mk('span', 'lms-info-val', value));
      rows.appendChild(line);
    }
    wrap.appendChild(lmsDetailSection('直播时间', rows));
    if (detail.uploads?.length) wrap.appendChild(lmsDetailSection('直播资料', lmsAttachmentList(detail.uploads)));

    // 关联回放：能定位到具体那场录像就给个按钮直接跳过去（参考项目也是这么做的）
    const related = lmsFindRelatedReplay(detail);
    if (related) {
      const box = mk('div', 'lms-related');
      const jump = mk('button', 'primary-btn', '去看这次直播的回放');
      jump.type = 'button';
      jump.addEventListener('click', () => lmsOpenActivity(related.id));
      box.append(jump, mk('span', 'lms-hint', lmsFormatTime(related.startTime ?? related.lessonStart) ?? ''));
      wrap.appendChild(lmsDetailSection('关联回放', box));
    } else if (detail.lessonStart) {
      // 有关联时间但当前缓存里没有那场录像 —— 说清"去哪找"，别给一个点了没反应的按钮
      wrap.appendChild(
        lmsDetailSection(
          '关联回放',
          mk('div', 'lms-hint', `这节课的回放起始于 ${lmsFormatTime(detail.lessonStart)}，去「课程回放」板块找`),
        ),
      );
    } else {
      wrap.appendChild(lmsDetailSection('关联回放', mk('div', 'lms-hint', '这次直播没有关联的录像')));
    }
    return wrap;
  }

  // 其它类型（考试/问卷/讨论…）：能给的都给出
  wrap.appendChild(lmsDetailSection('附件', lmsAttachmentList(detail.uploads), `${detail.uploads?.length ?? 0} 个`));
  return wrap;
}

/** 回放板块的视频块：直接复用现有的「取视频 + 下载 + 进度」那一整行，不重造一遍。 */
function lmsReplayBlock(detail) {
  const box = mk('div', 'lms-replay');
  box.appendChild(lmsReplayRow(detail));
  if (!detail.replayCode) box.appendChild(mk('div', 'lms-hint', '这次课没有可下载的录像'));
  return box;
}

/** 活动详情页（独立一屏，左上角返回课程页）。 */
function lmsActivityView() {
  const wrap = mk('div', 'lms-course lms-activity');
  const detail = lmsUi.activityDetail;
  const page = lmsUi.coursePage;
  const course = page?.course;

  const bar = mk('div', 'lms-course-bar');
  const back = mk('button', 'ghost-btn lms-back', '← 返回课程');
  back.type = 'button';
  back.addEventListener('click', lmsBackToCourse);
  bar.appendChild(back);
  bar.appendChild(mk('div', 'card-title', detail?.title ?? '活动'));
  if (detail?.type) bar.appendChild(mk('span', 'tag', LMS_ACTIVITY_LABEL[detail.type] ?? detail.type));
  if (course?.name) bar.appendChild(mk('span', 'lms-hint', course.name));
  bar.appendChild(mk('div', 'spacer'));
  bar.appendChild(lmsActionButton('刷新', '刷新中…', lmsUi.activityBusy, () => void lmsLoadActivity({ refresh: true })));
  wrap.appendChild(bar);

  if (lmsUi.activityError) {
    wrap.appendChild(mk('div', 'lms-error', `详情加载失败：${lmsUi.activityError}`));
    return wrap;
  }
  if (!detail) {
    wrap.appendChild(mk('div', 'loading', lmsUi.activityBusy ? '加载中…' : '没有数据，点「刷新」'));
    return wrap;
  }
  wrap.appendChild(lmsActivityDetailBody(detail));
  return wrap;
}

function lmsCourseView() {
  const wrap = mk('div', 'lms-course');
  const page = lmsUi.coursePage;
  const course = page?.course;

  const bar = mk('div', 'lms-course-bar');
  const back = mk('button', 'ghost-btn lms-back', '← 返回');
  back.type = 'button';
  back.addEventListener('click', lmsBackHome);
  bar.appendChild(back);
  bar.appendChild(mk('div', 'card-title', course?.name ?? '课程'));
  if (course?.courseCode) bar.appendChild(mk('span', 'tag', course.courseCode));
  if (course?.compulsory) bar.appendChild(mk('span', 'tag', '必修'));
  bar.appendChild(mk('div', 'spacer'));
  if (lmsUi.downloadDir) bar.appendChild(mk('span', 'lms-hint', `下载到 ${lmsUi.downloadDir}`));
  bar.appendChild(
    lmsActionButton('刷新本课活动', '刷新中…', lmsUi.courseBusy, () => void lmsLoadCoursePage({ refresh: true })),
  );
  wrap.appendChild(bar);

  if (lmsUi.courseError) wrap.appendChild(mk('div', 'lms-error', `课程页加载失败：${lmsUi.courseError}`));
  // 自动补数据失败不该让整页打不开：课程信息仍然有用，说一句就行
  if (page?.refreshError) wrap.appendChild(mk('div', 'lms-hint', `活动没拉到最新的：${page.refreshError}`));
  if (!page) {
    wrap.appendChild(mk('div', 'loading', lmsUi.courseBusy ? '加载中…' : '没有数据，点「刷新本课活动」'));
    return wrap;
  }

  // 课程信息收成一行摘要：详细字段放详情页用不到，这里只留"这门课是什么"
  const teachers = (course?.instructors ?? []).map((item) => item?.name).filter(Boolean).join('、');
  const semester = course?.semester?.label || course?.semester?.name;
  const summary = [teachers, semester, course?.credit ? `${course.credit} 学分` : null].filter(Boolean).join(' · ');
  if (summary) wrap.appendChild(mk('div', 'lms-course-summary', summary));

  wrap.append(lmsTabBar(page), lmsTabPanel(page));
  return wrap;
}

/**
 * 整体重画：所有文本都经 textContent 写入（等价于 escapeHtml），不使用 innerHTML 拼接。
 *
 * 顶栏刻意不再有工具条：登录信息收在设置页，这一屏只有「自动同步 + 课程」两张卡。
 *
 * 外面这层还负责**保住滚动位置**：这个视图每拉一次数据、点一次折叠都会整体重建 DOM，
 * 而真正滚动的是里面的 `.view-content`，一重建 scrollTop 就归零 ——
 * 用户看到的是「每刷新一次就跳回页面顶部」（在几十门课的列表里尤其烦）。
 */
function lmsPaint() {
  const restoreScroll = PC.snapshotScroll?.();
  try {
    lmsPaintInner();
  } finally {
    restoreScroll?.();
  }
}

function lmsPaintInner() {
  const mount = lmsUi.mount;
  if (!mount) return;
  mount.innerHTML = '';
  lmsUi.refs = { autoSync: null };

  const content = mk('div', 'view-content');
  mount.appendChild(content);

  const ready = lmsUi.status?.status === 'ready';
  // 退出登录后不该还停在课程页/详情页（那是上一个登录态下的页面）
  if (!ready && lmsUi.page !== 'home') lmsUi.page = 'home';

  if (!lmsUi.status || lmsUi.statusError) content.appendChild(lmsStatusNotice());
  if (ready && lmsUi.page === 'activity') {
    // 活动详情页：独立一屏，左上角返回课程页（回到原来那个板块）
    content.appendChild(lmsActivityView());
    lmsMaybeLoadActivity();
    return;
  }
  if (ready && lmsUi.page === 'course') {
    // 课程页：独立一屏，左上角返回首页
    content.appendChild(lmsCourseView());
    lmsMaybeLoadCourse();
    return;
  }
  if (ready) content.appendChild(lmsAutoSyncCard());
  else if (lmsUi.status) content.appendChild(lmsLoginCard());
  if (ready) content.appendChild(lmsCoursesCard());

  lmsMaybeLoad();
}

/* ------------------------------------------------------------------ 登记到外壳 */

/**
 * 渲染层测试用的**测试缝**（与 `shell/app.js` 的 `__PC_CHAT_TEST__` / `__PC_NAV_TEST__` 同一口径：
 * 只暴露已经存在的函数与状态本身，不为测试另写一套逻辑）。
 *
 * 为什么需要它：这门课的三级导航（课程 → 板块 → 详情）与"切页签不联网""返回回到原板块"
 * 这几条不变式全在视图内部，不挖缝就只能靠肉眼点浏览器，回归时第一个坏掉的就是它们。
 */
window.__PC_LMS_TEST__ = {
  ui: lmsUi,
  paint: lmsPaint,
  openCourse: lmsOpenCourse,
  openActivity: lmsOpenActivity,
  backToCourse: lmsBackToCourse,
  selectTab: lmsSelectTab,
  loadCoursePage: lmsLoadCoursePage,
  /** 取回放的视频列表（详情页里"在线播放/下载"那一行的数据来源）。 */
  loadReplays: lmsLoadReplays,
  /** 直播 → 对应回放活动的匹配（纯函数，便于直接断言）。 */
  findRelatedReplay: lmsFindRelatedReplay,
  /** 学堂 HTML 说明 → 纯文本（纯函数）。 */
  htmlToText: lmsHtmlToText,
  /** 直接塞一份课程页数据（省掉一次网络往返）。 */
  setCoursePage: (page) => {
    lmsUi.coursePage = page;
    lmsPaint();
  },
};

window.PCModules.register({
  id: 'lms',
  label: '思源学堂',
  icon: '🎓',
  order: 30,
  title: lmsView.title,
  render: (ctx) => lmsView.render(ctx),
});
})();
