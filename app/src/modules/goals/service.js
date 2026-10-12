/**
 * 学习目标 / DDL 追踪与预警 —— 服务层。
 *
 * 这个模块要解决的问题只有一个：**用户打开界面时，"接下来要面对什么"应当是一份排好序的
 * 清单**，而不是分散在四个地方（本模块的目标、日历的待办、日历的事件、教务的成绩）让人自己拼。
 * 所以本模块的价值一半在存储，一半在 `overview()` 的**合并与排序口径**。
 *
 * 一、边界：目标不是待办，也不是记忆
 * --------------------------------
 * 三者的分工（写错了必然出现"同一件事两处不一致"）：
 *   - **待办（calendar.todos）**：一件具体的事 + 一个截止日 + 完成态。「交实验报告」；
 *   - **目标（本模块）**：一个方向 + 目标日期 + 进度 + 里程碑。「期末绩点 3.8」「12 月前考完六级」；
 *     它可以没有任何一条待办与之对应，也不该被"某一条待办完成了"自动关掉；
 *   - **记忆（memory）**：跨会话可复用、且**不是从别的数据现算出来**的结论。「我习惯晚上学习」。
 *
 * 因此本模块**只写自己的集合**；`todos` / `events` / 教务成绩一律**只读**（见 `collectExternal()`）。
 *
 * 二、字段名为什么这么定（对齐 + 必要的偏离）
 * -----------------------------------------
 *   - `title` / `priority`（0/1/2）/ `source` / `createdAt` / `updatedAt`：与日历三域完全同形，
 *     前端同一套标签与配色可以直接复用，不再各造一份（§2.1~§2.3）；
 *   - `targetDate`（YYYY-MM-DD）而不是 `deadline`：目标是"面向某一天"，不是"某天前必须交"。
 *     沿用 `deadline` 会让 AI 把目标误当待办（`target`/`action` 都不同，字段名是最后的提示）；
 *   - `kind`（goal / deadline / exam）：区分"长期方向"、"一次性截止"、"考试"。
 *     三者混在一起时，排序与话术都不同（考试要提前更多天提醒，长期目标不该有"逾期"压力）；
 *   - `course`：课程名字符串（不是 id）。课程主数据在 lms/academic，本模块**不依赖它们存在** ——
 *     用户的"考研"根本不属于任何一门课，硬要外键只会让录不进去；
 *   - `progress`（0~100，可选）：只有"能估个百分比"的目标才填。缺省是 `null` 而不是 0 ——
 *     "还没开始"与"不知道该算多少"是两件事，前者是 0，后者不该被显示成一个进度条；
 *   - `milestones[]`（`{ id, title, done, due? }`）：里程碑是**目标内部**的分解步骤，
 *     它们的 id 只在目标内有效（不同目标各有一份），因此不复用集合层的 UUID 主键语义；
 *   - `remindDays[]`（默认 `[7, 3, 1]`）：**预警阈值只存一份**。首页预警、定时唤醒、
 *     `/goals/alerts` 全部读它，避免"设置里写 7 天、推送里写 3 天"这种两套口径；
 *   - `note`：备注，与事件/日程的 `description` 分开命名，因为它的语义是"给这个目标的一句话
 *     补充说明"（为什么要考、跟谁一起），不参与任何计算。
 *
 * 三、severity 只由 daysLeft 决定，不看 priority
 * -------------------------------------------
 * `priority` 是用户自己的主观排序，`severity` 是时间事实。把 priority 混进 severity 会让
 * AI 说出"这条不急"这种与日期矛盾的话。两者都返回，让界面与模型各自组合。
 *
 * 四、日期一律按"本地日期键"算，不用毫秒差
 * -------------------------------------
 * `new Date('2026-03-01') - new Date('2026-02-28')` 在夏令时地区会得到 23 或 25 小时，
 * `Math.round` 偶尔会翻车；而"今天"本身是本地概念。所以天数差用两个日期键相减
 * （`daysBetweenKeys`），与 `shared/time.js` 的本地时区约定一致。
 */

import { HttpError } from '../../core/http/router.js';
import { addDays, isDateKey, todayKey } from '../../shared/time.js';

// ---------------------------------------------------------------- 枚举与常量

/** 三类目标。`deadline` 与日历事件的 `category: deadline` 同名是刻意的：合并展示时语义一致。 */
export const GOAL_KINDS = Object.freeze(['goal', 'deadline', 'exam']);
export const GOAL_STATUSES = Object.freeze(['active', 'done', 'archived']);
/** 预警阈值允许的范围：1~60 天。超过 60 天提醒没有任何行动价值，0 天则是"当天才响"。 */
export const REMIND_MIN = 1;
export const REMIND_MAX = 60;
/** 默认预警阈值（需求给定）。 */
export const DEFAULT_REMIND_DAYS = Object.freeze([7, 3, 1]);
/** 标题上限与日历保持一致（120），前端不换行策略可以直接复用。 */
const MAX_TITLE = 120;
const MAX_NOTE = 2000;
const MAX_COURSE = 80;
/** 里程碑条数上限：目标分解超过 32 步时，真正该做的是拆成多个目标。 */
const MAX_MILESTONES = 32;
const MAX_MILESTONE_TITLE = 120;

/** 列表分页口径：默认 50，上限 500（与 memory 模块一致，避免一次拖出整库）。 */
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

/** severity 的中文标签：explain / 前端徽标共用一份。 */
export const SEVERITY_LABEL = Object.freeze({
  overdue: '已逾期',
  urgent: '紧急',
  soon: '临近',
  later: '还早',
});
/** kind 的中文标签。 */
export const KIND_LABEL = Object.freeze({ goal: '长期目标', deadline: '截止事项', exam: '考试' });
/** status 的中文标签。 */
export const STATUS_LABEL = Object.freeze({ active: '进行中', done: '已完成', archived: '已归档' });

/**
 * 明确写死、会被原样返回给调用方的免责声明。
 *
 * 为什么是一个常量而不是每次拼字符串：这句话是**产品承诺**，不能让任何一次改动
 * 顺手把它改软（比如变成"参考保研线"）。用户填的目标学分绩只是自己给自己定的靶子。
 */
export const GPA_DISCLAIMER = '目标是用户自己填的，不是学校公布的保研线';

// ---------------------------------------------------------------- 纯函数（导出给测试与路由复用）

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** 日期键 → 从今天起的天数差（今天 = 0，过去为负）。**不用毫秒差**，见文件头第四条。 */
export function daysBetweenKeys(fromKey, toKey) {
  // 用 UTC 归一化只为消除"本地零点"在不同时区下的偏差：这里两个键都是本地日期键，
  // 换算成 UTC 零点后相减，得到的恰是整数天。
  const a = Date.UTC(...fromKey.split('-').map(Number).map((n, i) => (i === 1 ? n - 1 : n)));
  const b = Date.UTC(...toKey.split('-').map(Number).map((n, i) => (i === 1 ? n - 1 : n)));
  return Math.round((b - a) / 86400000);
}

/**
 * 由「距目标日还有几天」判定严重度。**唯一的判定入口**（服务层、概览、告警全走这里）。
 *
 * 口径（与前端徽标、AI 话术共用，改动即全站生效）：
 *   - `daysLeft < 0`  → `overdue`（已逾期，含昨天）
 *   - `daysLeft <= 1` → `urgent`（今天到期 / 明天到期）
 *   - `daysLeft <= 7` → `soon`（一周内，与默认预警的 7 天阈值对齐）
 *   - 其余            → `later`（含 8 天及更远）
 *
 * 为什么 7 天用闭区间：`remindDays: [7]` 的字面意思就是"提前 7 天提醒一次"，
 * 如果 7 天判成 `later`，那条提醒永远不会触发。
 */
export function severityOf(daysLeft) {
  if (daysLeft < 0) return 'overdue';
  if (daysLeft <= 1) return 'urgent';
  if (daysLeft <= 7) return 'soon';
  return 'later';
}

/**
 * severity 的排序权重（小者先）。
 *
 * 导出是给**前端**用的：徽标的配色顺序要与服务端一致。服务端自己的排序见 `compareRows()`
 * —— 它**不是**按这个权重排的（那里日期的优先级更高），所以两处不要互相套用。
 */
export const SEVERITY_RANK = Object.freeze({ overdue: 0, urgent: 1, soon: 2, later: 3 });

/**
 * **同一天同一严重度**时的稳定次序：考试 > 截止 > 进行中的目标 > 待办 > 事件。
 *
 * 这一级存在的唯一理由是**可测**：没有它，两次请求的顺序会随集合插入序变化，
 * 测试写成"第 0 条是 A"就会随机失败。语义上也说得通 —— 考试没法推迟，
 * 待办可以顺延（`POST /todos/rollover`），事件更是背景信息。
 *
 * 键与条目上的 `source` 取值一一对应（`goal` / `deadline` / `exam` / `todo` / `event`）。
 */
const SOURCE_RANK = Object.freeze({ exam: 0, deadline: 1, goal: 2, todo: 3, event: 4 });

// ---------------------------------------------------------------- 字段校验
// 校验放在服务层：REST 与指令处理器（commands.js）是两条入口，规则写两份迟早有一份先过期。

function fail(field, message, extra) {
  throw HttpError.badRequest(`字段 ${field} 不合法：${message}`, { field, ...extra });
}

/** 日期键：必须是真实存在的 `YYYY-MM-DD`（`2026-02-30` 直接 400，不静默滚动到 3 月）。 */
function requireTargetDate(value, field = 'targetDate') {
  if (typeof value !== 'string' || !value.trim()) fail(field, '必填，格式 YYYY-MM-DD');
  const key = value.trim();
  if (!isDateKey(key)) fail(field, '必须是真实存在的日期，格式 YYYY-MM-DD');
  return key;
}

function requiredTitle(value) {
  if (typeof value !== 'string' || !value.trim()) fail('title', '必填且不能为空');
  const title = value.trim();
  if (title.length > MAX_TITLE) fail('title', `长度不能超过 ${MAX_TITLE} 字（收到 ${title.length}）`);
  return title;
}

function optionalKind(value, { fallback = 'goal' } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!GOAL_KINDS.includes(value)) fail('kind', `取值必须是 ${GOAL_KINDS.join(' / ')} 之一`);
  return value;
}

function optionalStatus(value, { fallback = 'active' } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!GOAL_STATUSES.includes(value)) fail('status', `取值必须是 ${GOAL_STATUSES.join(' / ')} 之一`);
  return value;
}

function optionalCourse(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail('course', '必须是课程名字符串（可以不填）');
  const course = value.trim();
  if (course.length > MAX_COURSE) fail('course', `长度不能超过 ${MAX_COURSE} 字`);
  return course || null;
}

function optionalNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') fail('note', '必须是字符串');
  const note = value.trim();
  if (note.length > MAX_NOTE) fail('note', `长度不能超过 ${MAX_NOTE} 字（收到 ${note.length}）`);
  return note;
}

/** 把任意数字夹进 0~100 并取整（只给 `delta` 这条路径用，见 `setProgress` 的注释）。 */
function clampProgress(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) fail('progress', '必须是数字');
  return Math.min(100, Math.max(0, Math.round(num)));
}

/** 进度：0~100 的整数；`null` 表示"还没估过"（与 0 不同，见文件头）。 */
function optionalProgress(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) fail('progress', '必须是 0~100 的数字，或用 null 表示未估');
  // 直接给的值越界一律 400（用户填错了要让他知道）；夹紧只用于 `delta` 的结果
  if (num < 0 || num > 100) fail('progress', '取值范围 0~100');
  // 取整：界面上是进度条，小数点后两位没有任何意义，还会让"进度 100"判定出现 99.99 的边界问题
  return Math.round(num);
}

/** 优先级：0 普通 / 1 重要 / 2 紧急（与日程 `priority` 同口径）。 */
function optionalPriority(value, { fallback = 0 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  if (!Number.isInteger(num) || num < 0 || num > 2) fail('priority', '取值必须是 0 / 1 / 2');
  return num;
}

/**
 * 预警阈值数组：去重 + 升序 + 夹紧到 [1, 60]。
 *
 * **排序是刻意的**：`[1, 3, 7]` 与 `[7, 3, 1]` 在"下一次该提醒我的是哪一天"这个问题上等价，
 * 但存储形态统一后，`remindDays` 可以直接当 key 比较（查重、去抖），不必每次先规范化。
 */
function optionalRemindDays(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return [...DEFAULT_REMIND_DAYS];
  const list = Array.isArray(value) ? value : String(value).split(',');
  if (!list.length) return [...DEFAULT_REMIND_DAYS];
  const seen = new Set();
  for (const raw of list) {
    const num = Number(raw);
    if (!Number.isInteger(num) || num < REMIND_MIN || num > REMIND_MAX) {
      fail('remindDays', `必须是 ${REMIND_MIN}~${REMIND_MAX} 之间的整数（提前几天预警）`);
    }
    seen.add(num);
  }
  return [...seen].sort((a, b) => a - b);
}

/** 里程碑：本地 id 自动补齐（前端拖拽排序/勾选需要一个稳定句柄）。 */
function optionalMilestones(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail('milestones', '必须是数组，如 [{ "title": "背完单词书" }]');
  if (value.length > MAX_MILESTONES) fail('milestones', `最多 ${MAX_MILESTONES} 条`);
  return value.map((raw, index) => {
    if (!isPlainObject(raw)) fail('milestones', `第 ${index + 1} 条必须是对象`);
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!title) fail('milestones', `第 ${index + 1} 条缺少 title`);
    if (title.length > MAX_MILESTONE_TITLE) fail('milestones', `第 ${index + 1} 条 title 超过 ${MAX_MILESTONE_TITLE} 字`);
    const due = raw.due === undefined || raw.due === null || raw.due === '' ? null : raw.due;
    if (due !== null && (typeof due !== 'string' || !isDateKey(due.trim()))) {
      fail('milestones', `第 ${index + 1} 条的 due 必须是 YYYY-MM-DD 或留空`);
    }
    return {
      // 已有 id 就沿用（PATCH 整份替换里程碑时不会把前端手里的 id 换掉）
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : newMilestoneId(index),
      title,
      done: Boolean(raw.done),
      due: due === null ? null : due.trim(),
    };
  });
}

/** 里程碑 id：`m-<序号>-<随机>`。只在目标内部唯一，因此不占用集合层的 UUID 语义。 */
function newMilestoneId(seed = 0) {
  return `m-${seed}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * `targetGpa`：0~5 之间的数（两位小数）。
 *
 * 上限 5 而不是 4.0/4.3：不同学校的满绩口径不一样（4.0 / 4.3 / 5.0 都存在），
 * 本模块**不假定**用户学校的口径，宁可放宽校验也不要在录 4.5 时报"不可能"。
 * 只保留两位小数，避免 `3.8000000000000003` 这类浮点噪声污染对比结果。
 */
function optionalTargetGpa(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) fail('targetGpa', '必须是数字，或用 null 清除目标');
  if (num < 0 || num > 5) fail('targetGpa', '取值范围 0~5（不同学校满绩口径不同，这里不假定）');
  return Number(num.toFixed(2));
}

// ---------------------------------------------------------------- 服务

/**
 * 目标服务。
 *
 * 构造收 `{ store, broadcast, services, now }`：
 *   - `now` 可注入（测试"今天到期""跨月"这类边界时不必改系统时钟）；
 *   - `services` 用来**只读**取日历三域与教务统计（见 `collectExternal()`）。
 */
export class GoalService {
  constructor({ store, broadcast = () => {}, services = {}, now } = {}) {
    this.store = store;
    this.broadcast = broadcast;
    this.services = services ?? {};
    this.now = typeof now === 'function' ? now : () => new Date();
  }

  get collection() {
    return this.store.goals;
  }

  /** 模块设置（目标学分绩）：单行集合，永远只取第一行。 */
  get settingsCollection() {
    return this.store.goalSettings;
  }

  /** 今天（本地日期键）。整份实现里"今天"只在这里出现一次，便于测试注入。 */
  today() {
    return todayKey(this.now());
  }

  /**
   * 写操作后的广播（前端据此自动刷新当前视图）。
   *
   * `createdAt` / `updatedAt` 由 JsonStore 统一维护，服务层不自己写 —— 两处都写必然出现
   * "某条记录的时间戳来自另一套时钟"的问题。
   */
  #changed(action, id, extra = {}) {
    this.broadcast?.({
      type: 'data_changed',
      module: 'goals',
      payload: { module: 'goals', target: 'goal', action, ...(id ? { id } : {}), ...extra },
    });
  }

  // ---------------------------------------------------------------- 派生字段

  /**
   * 给一条目标补上"随今天变化"的派生字段。
   *
   * 这些字段**绝不落库**（存下来必然过期），与 `todos` 的 `isOverdue`/`daysRemaining` 同一口径。
   * `needsAttention` 是给预警用的：只在"命中某个提醒阈值"时为 true，
   * 首页与定时唤醒据此决定"今天要不要提这条"。
   */
  decorate(item) {
    const today = this.today();
    const daysLeft = daysBetweenKeys(today, item.targetDate);
    const severity = severityOf(daysLeft);
    // 已完成的条目不再"催"：它的 severity 保留（历史事实），但不进预警。
    // `?? DEFAULT_REMIND_DAYS` 是给手工写进 JSON 的老数据兜底（校验层保证新数据一定有值）
    const remindDays = Array.isArray(item.remindDays) ? item.remindDays : DEFAULT_REMIND_DAYS;
    const remindable = item.status === 'active' && remindDays.includes(daysLeft);
    const milestones = Array.isArray(item.milestones) ? item.milestones : [];
    const doneMilestones = milestones.filter((step) => step.done).length;
    return {
      ...item,
      remindDays: [...remindDays],
      daysLeft,
      overdue: daysLeft < 0 && item.status === 'active',
      severity,
      severityLabel: SEVERITY_LABEL[severity],
      kindLabel: KIND_LABEL[item.kind] ?? item.kind,
      statusLabel: STATUS_LABEL[item.status] ?? item.status,
      /** 里程碑完成度：没有里程碑时为 null，让界面显示"未拆分"而不是 0/0。 */
      milestoneTotal: milestones.length,
      milestoneDone: doneMilestones,
      /**
       * 命中预警阈值（`daysLeft` 正好等于 `remindDays` 中的某一天）且仍在进行中。
       * 用"正好等于"而不是"小于等于"：前者一天只响一次，后者会从 7 天前一路响到当天。
       */
      needsAttention: remindable,
    };
  }

  // ---------------------------------------------------------------- 读取

  /**
   * 列表 / 检索。
   *
   * 排序口径：**进行中优先 → 目标日升序 → 优先级降序 → 标题**。
   * 已完成的沉到底部（而不是被 `status=active` 藏掉）：用户翻列表时最想看的是
   * "还有什么没做完"，但"我上个月做完了什么"也要一眼能翻到。
   */
  list({ status, kind, course, q, limit = DEFAULT_LIST_LIMIT, offset = 0 } = {}) {
    const needle = typeof q === 'string' ? q.trim().toLowerCase() : '';
    const statusFilter = typeof status === 'string' && status.trim()
      ? status.split(',').map((item) => item.trim()).filter(Boolean)
      : null;

    const keep = (item) => {
      if (statusFilter && !statusFilter.includes(item.status)) return false;
      if (kind && item.kind !== kind) return false;
      if (course && item.course !== course) return false;
      if (needle) {
        const haystack = `${item.title ?? ''} ${item.course ?? ''} ${item.note ?? ''}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    };

    const all = this.collection.all();
    const matched = all.filter(keep).map((item) => this.decorate(item));
    matched.sort(compareGoals);

    const size = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(Number(limit) || DEFAULT_LIST_LIMIT)));
    const start = Math.max(0, Math.floor(Number(offset) || 0));

    /**
     * 分组计数：按 status 与 kind 各来一份，且**忽略各自的过滤条件**（其余条件照旧）。
     *
     * 与 memory 模块同一条理由：筛选页签要在"只看进行中"时仍然显示已完成/已归档的条数，
     * 否则一点筛选，其它数字全归零，看不出还有多少东西。
     */
    const counts = { total: 0, byStatus: {}, byKind: {}, overdue: 0, dueSoon: 0 };
    for (const name of GOAL_STATUSES) counts.byStatus[name] = 0;
    for (const name of GOAL_KINDS) counts.byKind[name] = 0;
    for (const item of all) {
      // 计数时把 status / kind 两个维度都放开，只保留 course / q
      if (course && item.course !== course) continue;
      if (needle) {
        const haystack = `${item.title ?? ''} ${item.course ?? ''} ${item.note ?? ''}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      counts.byStatus[item.status] = (counts.byStatus[item.status] ?? 0) + 1;
      counts.byKind[item.kind] = (counts.byKind[item.kind] ?? 0) + 1;
      counts.total += 1;
      const decorated = this.decorate(item);
      if (decorated.overdue) counts.overdue += 1;
      if (decorated.status === 'active' && decorated.daysLeft >= 0 && decorated.daysLeft <= 7) counts.dueSoon += 1;
    }

    return {
      count: matched.length,
      counts,
      items: matched.slice(start, start + size),
      filters: {
        status: statusFilter ? statusFilter.join(',') : null,
        kind: kind ?? null,
        course: course ?? null,
        q: q ?? null,
        limit: size,
        offset: start,
      },
    };
  }

  /** 取一条（不存在一律 404）：PATCH / DELETE / progress 共用。 */
  get(id) {
    const item = this.collection.get(String(id ?? ''));
    if (!item) throw HttpError.notFound(`目标不存在：${id}`);
    return item;
  }

  /** 带派生字段的取一条（指令处理器与 routes 展示用）。 */
  detail(id) {
    return this.decorate(this.get(id));
  }

  /**
   * 「接下来要面对什么」—— 本模块的核心接口。
   *
   * 三份数据合成一条按时间排的清单：
   *   ① 本模块的 active 目标 / 截止 / 考试；
   *   ② 日历模块**未完成且有 deadline** 的待办；
   *   ③ 日历模块的事件（考试、报名截止这类**日期粒度**的东西）。
   *
   * @param {object} [options]
   * @param {number} [options.days=30] 未来窗口天数；**逾期项永远包含**（隐藏逾期等于骗人）
   * @param {number} [options.limit=50] 返回条数上限（在排序之后截断）
   * @param {boolean} [options.includeDone=false] 是否带上已完成的目标
   * @param {string} [options.course] 只看某门课
   */
  overview({ days = 30, limit = 50, includeDone = false, course } = {}) {
    const today = this.today();
    const windowDays = clampInt(days, 1, 365, 30);
    // 窗口用日期键算，不用毫秒：跨月、跨年、闰年都由 addDays 处理
    const until = addDays(today, windowDays);
    const courseFilter = typeof course === 'string' && course.trim() ? course.trim() : null;

    const rows = [
      ...this.#rowsFromGoals({ until, includeDone, courseFilter }),
      ...this.collectExternal({ today, until, courseFilter }),
    ];
    rows.sort(compareRows);

    const size = clampInt(limit, 1, 500, 50);
    const items = rows.slice(0, size);

    return {
      days: windowDays,
      from: today,
      to: until,
      count: rows.length,
      /** 逾期条数不设上限的含义：它统计的是**全部**逾期项，不是本页里的 */
      summary: summarize(rows),
      gpa: this.gpaComparison(),
      disclaimer: GPA_DISCLAIMER,
      items,
      truncated: rows.length > items.length,
      /** 三份来源各自的原始条数：调用方一眼看出"少了哪一块"，不必猜 */
      sources: {
        goals: rows.filter((row) => row.origin === 'goals').length,
        todos: rows.filter((row) => row.origin === 'todos').length,
        events: rows.filter((row) => row.origin === 'events').length,
      },
    };
  }

  /**
   * 预警精简版：给"定时唤醒 / 首页横幅"用。
   *
   * 与 `overview()` 的差别只有三个，都是刻意的：
   *   1. 只保留 `days <= 阈值` 的条目 + 全部逾期项；
   *   2. 只返回**能据此行动**的字段（多一个字段就多一份话术失控的机会）；
   *   3. `attention` 把"命中用户自设 `remindDays`"的条目单独挑出来 ——
   *      定时唤醒该不该打扰用户，由用户自己设的阈值说了算，不由我们替他定。
   */
  alerts({ days = 7, today = this.today() } = {}) {
    const windowDays = clampInt(days, 1, 90, 7);
    const until = addDays(today, windowDays);
    const rows = [...this.#rowsFromGoals({ until, includeDone: false, courseFilter: null }), ...this.collectExternal({ today, until, courseFilter: null })]
      .filter((row) => row.overdue || row.date <= until)
      .sort(compareRows);

    const items = rows.map((row) => ({
      source: row.source,
      id: row.id,
      title: row.title,
      date: row.date,
      daysLeft: row.daysLeft,
      overdue: row.overdue,
      severity: row.severity,
      kind: row.kind,
      course: row.course,
      /** 是否命中用户自设的预警阈值（定时唤醒据此决定要不要打扰用户） */
      remindHit: row.remindHit === true,
    }));

    return {
      days: windowDays,
      from: today,
      to: until,
      count: items.length,
      summary: summarize(rows),
      /**
       * 命中用户自设 `remindDays` 的条目。
       *
       * 只有本模块的目标带阈值：待办与事件的提醒机制在日历模块（`reminders` / 事件小时级），
       * 本模块不替它们再定一套 —— 两套提醒口径必然有一天互相打脸。
       */
      attention: items.filter((row) => row.remindHit),
      items,
      gpa: this.gpaComparison(),
      disclaimer: GPA_DISCLAIMER,
    };
  }

  // ---------------------------------------------------------------- 概览的三份来源

  /** ① 本模块：active（可选含已完成）的目标 / 截止 / 考试，落在窗口内或已逾期。 */
  #rowsFromGoals({ until, includeDone, courseFilter }) {
    const rows = [];
    for (const item of this.collection.all()) {
      if (!includeDone && item.status !== 'active') continue;
      if (courseFilter && item.course !== courseFilter) continue;
      const decorated = this.decorate(item);
      // 窗口外又没逾期的目标不进清单（30 天后的考试不该占今天的版面）
      if (decorated.daysLeft > 0 && item.targetDate > until) continue;
      rows.push({
        origin: 'goals',
        source: item.kind, // goal / deadline / exam：来源即类型，前端不必再查一次
        id: item.id,
        title: item.title,
        date: item.targetDate,
        daysLeft: decorated.daysLeft,
        overdue: decorated.overdue,
        severity: decorated.severity,
        kind: item.kind,
        course: item.course,
        priority: item.priority,
        progress: item.progress,
        status: item.status,
        milestoneDone: decorated.milestoneDone,
        milestoneTotal: decorated.milestoneTotal,
        needsAttention: decorated.needsAttention,
        /** 命中用户自设 `remindDays`（合并排序与 `summary.attention` 都读它） */
        remindHit: decorated.needsAttention,
        sourceModule: 'goals',
      });
    }
    return rows;
  }

  /**
   * ②③ 日历模块的**只读**数据。
   *
   * 为什么走对方的 `services`（而不是 `store.todos.all()`）：
   *   - `services.todos.list({ completed: false })` 已经带上了 `isOverdue` / `daysRemaining` /
   *     `complexity` 这些派生字段，且**排序口径由待办自己维护** —— 这里再算一遍就是第二份口径；
   *   - 事件走 `services.events.list({ from, to })`，它的区间过滤语义（`endDate >= from`）
   *     与日历界面完全一致，重复规则展开也由它负责。
   *
   * 但**只用只读方法**：本模块对别人的集合一个字节都不写（契约 §2.5 的"读可直接访问集合，
   * 写必须走对方服务"更进一层：这里连读都优先走方法，把字段约定的耦合面收到最小）。
   * 两个服务都拿不到时（例如单独装配本模块做单测）**返回空数组而不是抛错** ——
   * 合并视图少一块仍然有用，整个接口 500 则毫无用处。
   */
  collectExternal({ today, until, courseFilter }) {
    const rows = [];

    // ② 待办：只取未完成的（完成的不该再占"接下来要面对什么"的版面）
    const todoService = this.services.todos;
    if (todoService && typeof todoService.list === 'function') {
      for (const todo of safeCall(() => todoService.list({ completed: false })) ?? []) {
        if (!todo?.deadline) continue; // 没有 deadline 的待办无法进入"按时间排"的清单
        const date = todo.deadline;
        if (date > until) continue; // 逾期项 date < today 自动保留
        // 待办没有 course 字段（见接口文档 §2.3），因此课程筛选对它不生效：
        // 用 courseFilter 时保持它可见，好过让用户以为"这周没别的事了"
        const daysLeft = daysBetweenKeys(today, date);
        rows.push({
          origin: 'todos',
          source: 'todo',
          id: todo.id,
          title: todo.title,
          date,
          daysLeft,
          overdue: Boolean(todo.isOverdue) || daysLeft < 0,
          severity: severityOf(daysLeft),
          kind: 'todo',
          course: null,
          priority: todo.priority ?? 0,
          status: todo.completed ? 'done' : 'active',
          needsAttention: false,
          remindHit: false,
          sourceModule: 'calendar',
        });
      }
    }

    // ③ 事件：考试 / 报名截止 / 学习安排这类**日期粒度**的东西
    const eventService = this.services.events;
    if (eventService && typeof eventService.list === 'function') {
      for (const event of safeCall(() => eventService.list({ from: today, to: until })) ?? []) {
        if (!event?.startDate) continue;
        /**
         * 多天事件（如"考试周"）取**结束日**：对"接下来要面对什么"这个问题，
         * 关心的是"它还占着我到哪天"，而不是"它从哪天开始"（开始日早已过去的不该被丢掉）。
         * `endDate` 缺省等于 `startDate`。
         */
        const date = event.endDate && event.endDate > event.startDate ? event.endDate : event.startDate;
        /**
         * 窗口过滤只对**未来**生效：`daysLeft < 0` 的（已经过去的事件）不进概览 ——
         * 事件不像待办有"未完成"这个状态，把上个月的假期一直列在"接下来"里是噪音。
         * 逾期只对本模块目标与待办有意义。
         */
        if (date < today) continue;
        if (date > until) continue;
        const daysLeft = daysBetweenKeys(today, date);
        const kind = eventKindOf(event);
        if (courseFilter && !courseMatches(event, courseFilter)) continue;
        rows.push({
          origin: 'events',
          source: 'event',
          id: event.id,
          title: event.title,
          date,
          daysLeft,
          overdue: false,
          severity: severityOf(daysLeft),
          kind,
          course: event.course ?? null,
          priority: event.priority ?? 1,
          status: 'active',
          startDate: event.startDate,
          endDate: event.endDate ?? event.startDate,
          needsAttention: false,
          remindHit: false,
          sourceModule: 'calendar',
        });
      }
    }

    return rows;
  }

  // ---------------------------------------------------------------- 写入

  /** 校验 + 归一化创建字段（不落库）。REST、指令、parser 三条入口共用。 */
  validate(input = {}) {
    if (!isPlainObject(input)) fail('body', '必须是 JSON 对象');
    const targetDate = requireTargetDate(input.targetDate);
    return {
      title: requiredTitle(input.title),
      kind: optionalKind(input.kind),
      course: optionalCourse(input.course),
      targetDate,
      status: optionalStatus(input.status),
      progress: optionalProgress(input.progress) ?? null,
      milestones: optionalMilestones(input.milestones) ?? [],
      priority: optionalPriority(input.priority),
      note: optionalNote(input.note),
      remindDays: optionalRemindDays(input.remindDays) ?? [...DEFAULT_REMIND_DAYS],
      source: optionalSource(input.source),
    };
  }

  async create(input = {}) {
    const data = this.validate(input);
    const created = await this.collection.insert(data);
    this.#changed('create', created.id);
    return this.decorate(created);
  }

  /**
   * 局部更新（PATCH 语义）。
   *
   * 两条刻意的规则：
   *   - **`status: 'done'` 且没给 progress 时自动把进度补到 100**。用户点"完成"却看到
   *     进度停在 60%，会以为是没保存成功；反过来把进度从 100 改回来**不会**自动改状态
   *     （"我又得继续做了"是明确意图，不该被系统反转）；
   *   - **里程碑全勾完不会自动改 status**：目标是"方向"，全部步骤做完不等于方向达成
   *     （六级单词背完还要考试）。这一条写进 aiPrompt，防止模型替用户宣布完成。
   */
  async update(id, patch = {}) {
    const current = this.get(id);
    if (!isPlainObject(patch)) fail('body', '必须是 JSON 对象');
    const next = {};

    if (patch.title !== undefined) next.title = requiredTitle(patch.title);
    if (patch.kind !== undefined) next.kind = optionalKind(patch.kind, { fallback: current.kind });
    if (patch.course !== undefined) next.course = optionalCourse(patch.course);
    if (patch.targetDate !== undefined) next.targetDate = requireTargetDate(patch.targetDate);
    if (patch.note !== undefined) next.note = optionalNote(patch.note);
    if (patch.priority !== undefined) next.priority = optionalPriority(patch.priority, { fallback: current.priority });
    if (patch.remindDays !== undefined) next.remindDays = optionalRemindDays(patch.remindDays);
    if (patch.milestones !== undefined) next.milestones = optionalMilestones(patch.milestones);
    if (patch.progress !== undefined) next.progress = optionalProgress(patch.progress);

    if (patch.status !== undefined) {
      next.status = optionalStatus(patch.status, { fallback: current.status });
      if (next.status === 'done' && patch.progress === undefined && current.progress !== 100) next.progress = 100;
    }

    // 空 patch（只传了未知字段）时不写库：避免平白刷新 updatedAt 让"最近改动"排序失真
    if (!Object.keys(next).length) return this.decorate(current);

    const updated = await this.collection.update(current.id, next);
    this.#changed('update', current.id);
    return this.decorate(updated);
  }

  async remove(id) {
    const current = this.get(id);
    await this.collection.remove(current.id);
    this.#changed('delete', current.id);
    return { id: current.id, deleted: true };
  }

  /**
   * 改进度 / 勾里程碑（`POST /goals/:id/progress`）。
   *
   * 三种入参互不冲突，可以一次都给：
   *   - `progress`：直接设百分比；
   *   - `delta`：相对增减（"+10"），界面上的快捷按钮用它，省得前端自己读当前值；
   *   - `milestoneId` + `done`：勾/取消勾某一步。**勾完最后一步时进度会跟着走到 100**，
   *     因为"全部步骤都做完了但进度条还是 40%"是最容易被当成 bug 的表现；
   *     反过来取消勾选**不动** progress（用户可能自己调过）。
   */
  async setProgress(id, { progress, delta, milestoneId, done, status } = {}) {
    const current = this.get(id);
    const next = {};

    if (milestoneId !== undefined && milestoneId !== null && milestoneId !== '') {
      const milestones = Array.isArray(current.milestones) ? current.milestones.map((step) => ({ ...step })) : [];
      const target = milestones.find((step) => step.id === String(milestoneId));
      if (!target) {
        throw HttpError.notFound(`目标 ${current.id} 下没有里程碑：${milestoneId}`, { field: 'milestoneId' });
      }
      target.done = done === undefined ? !target.done : Boolean(done);
      next.milestones = milestones;

      // 勾完最后一步 → 进度补 100（只在调用方没显式给 progress/delta 时）
      if (progress === undefined && delta === undefined && milestones.length && milestones.every((step) => step.done)) {
        next.progress = 100;
      }
      if (progress === undefined && delta === undefined && !milestones.every((step) => step.done) && current.progress === 100) {
        // 取消勾选最后一步时把"自动补的 100"退回去，否则进度条会卡在 100 与实际不符
        next.progress = Math.round(((milestones.length - 1) / milestones.length) * 100);
      }
    }

    if (delta !== undefined && delta !== null && delta !== '') {
      const num = Number(delta);
      if (!Number.isFinite(num)) fail('delta', '必须是数字（相对当前进度增减）');
      const base = Number.isFinite(Number(current.progress)) ? Number(current.progress) : 0;
      // `delta` 的结果**夹紧**而不是 400：界面上"+10/-10"的按钮点到底不该弹一个错误，
      // 而"直接填 progress"越界仍然是 400（那是用户在表达一个具体的数，写错了要说出来）
      next.progress = clampProgress(base + num);
    }
    if (progress !== undefined) next.progress = optionalProgress(progress);
    if (status !== undefined) next.status = optionalStatus(status, { fallback: current.status });

    if (!Object.keys(next).length) {
      fail('progress', '至少要给 progress / delta / milestoneId / status 之一');
    }

    const updated = await this.collection.update(current.id, next);
    this.#changed('progress', current.id);
    return this.decorate(updated);
  }

  // ---------------------------------------------------------------- 绩点目标（诚实版）

  /**
   * 目标学分绩的读写。存本模块的 `goalSettings` 集合（单行），**不碰学业模块的任何数据**。
   *
   * 为什么单独一个集合、而不是往 `goals` 里塞一条 `kind: 'gpa'` 的记录：
   * 目标学分绩是**全局设置**（一个用户只有一个），塞进 goals 会让列表、计数、overview
   * 全都要特判"这条不算目标"，是一处特判换来四处特判。
   */
  getTargetGpa() {
    const row = this.settingsCollection.all()[0] ?? null;
    return {
      targetGpa: row?.targetGpa ?? null,
      updatedAt: row?.updatedAt ?? null,
      disclaimer: GPA_DISCLAIMER,
    };
  }

  /** 设置 / 清除目标学分绩（`null` 或 `''` 表示清除）。返回设置后的状态。 */
  async setTargetGpa(value) {
    const targetGpa = optionalTargetGpa(value);
    const row = this.settingsCollection.all()[0] ?? null;
    if (row) await this.settingsCollection.update(row.id, { targetGpa });
    else await this.settingsCollection.insert({ targetGpa });
    this.#changed('target-gpa', row?.id ?? null);
    return this.getTargetGpa();
  }

  /**
   * **当前学分绩 vs 目标学分绩**。
   *
   * `current` 必须来自学业模块的**真实数据**，这里按"最稳 → 最兜底"三级取：
   *   ① `services.academic.stats()` —— 纯本地计算（不联网、不登录），带 `includedCount`，
   *      是学业模块自己对外的**唯一口径**（§12.5 的 Σ(学分×绩点)/Σ(学分)）；
   *   ② 拿不到服务时，退回直读 `store.academicGrades` 并**只做加权平均**（gpa.js 的同一公式），
   *      注释里说明这是降级路径；
   *   ③ 两条都拿不到（未装配学业模块 / 一条成绩都没有）→ `null` + `reason`。
   *
   * **绝不失败**：`/goals/overview` 是首页要渲染的接口，"教务还没登录"绝不能让它 500。
   * 也**绝不说成官方口径**：`disclaimer` 恒为 `GPA_DISCLAIMER`，`gap` 只是两个数的差。
   */
  gpaComparison() {
    const target = this.getTargetGpa().targetGpa;
    const academic = this.services.academic;

    /** 一个数字要算"真实学分绩"，必须**有纳入的课程**且 gpa 不为 null。 */
    const usable = (value, included) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(included) > 0;

    let current = null;
    let source = null;
    let includedCount = null;
    let reason = null;

    if (academic && typeof academic.stats === 'function') {
      const stats = safeCall(() => academic.stats());
      /**
       * `stats.gpa` 在**一条成绩都没有**时是 `null`（学业模块的契约：null 与 0 含义不同）。
       * 所以这里必须显式判 `null`/`undefined`，**不能**用 `Number.isFinite(Number(value))` ——
       * `Number(null)` 是 0，会把"没有数据"读成"学分绩 0"并原样报给用户。
       * `includedCount > 0` 再加一道保险：成绩全被排除时同样不该给出一个数。
       */
      if (stats && usable(stats.gpa, stats.includedCount)) {
        current = Number(stats.gpa);
        source = 'academic.services.stats';
        includedCount = Number(stats.includedCount);
      } else {
        reason = 'NO_GRADES';
      }
    } else {
      // ② 降级：直读集合（只读）。只在 academic 服务缺席时走到这里。
      const grades = safeCall(() => this.store.academicGrades?.all?.());
      if (Array.isArray(grades) && grades.length) {
        const fallback = weightedGpaOf(grades);
        if (fallback) {
          current = fallback.gpa;
          source = 'store.academicGrades(降级：仅按已纳入课程做学分加权，未校正绩点表)';
          includedCount = fallback.count;
        } else {
          reason = 'NO_GRADES';
        }
      } else {
        reason = academic ? 'NO_GRADES' : 'ACADEMIC_MODULE_UNAVAILABLE';
      }
    }

    if (current === null) {
      return {
        current: null,
        target,
        gap: null,
        source,
        includedCount,
        reason: reason ?? 'NO_GRADES',
        /** 给前端/模型一句能直接说的话：为什么这里没有数字。 */
        message:
          reason === 'ACADEMIC_MODULE_UNAVAILABLE'
            ? '学业模块未装配，读不到真实学分绩。'
            : '还没有可用的成绩数据（或尚未登录教务），先同步成绩再来看对比。',
        disclaimer: GPA_DISCLAIMER,
      };
    }

    const gap = target === null ? null : Number((target - current).toFixed(2));
    return {
      current,
      target,
      gap,
      source,
      includedCount,
      reason: null,
      /**
       * `gap` 的正负含义必须在返回里说清：模型很容易把"差 0.2"说成"还差 0.2 分就够保研"。
       */
      message:
        target === null
          ? '当前学分绩来自学业模块；还没有设置目标学分绩。'
          : gap > 0
            ? `距你自己设的目标还差 ${gap} 学分绩。`
            : `已达到你自己设的目标（高出 ${Math.abs(gap)}）。`,
      disclaimer: GPA_DISCLAIMER,
    };
  }
}

// ---------------------------------------------------------------- 排序

/**
 * `overview` / `alerts` 的统一排序。
 *
 * 分两层，顺序不能换：
 *   1. **逾期与非逾期分开**：逾期项全部压在最上面（这是整个接口存在的理由），
 *      且组内按日期**降序** —— 昨天逾期比上个月逾期更该先处理；
 *   2. 其余一律按日期**升序**，同一天再按 `SOURCE_RANK`（考试 > 截止 > 目标 > 待办 > 事件）
 *      与标题。**日期的优先级高于 severity 分档**：3-24 的考试排在 3-16 的交作业之后，
 *      因为"接下来要面对什么"是按日历读的，分档只用来配色与话术。
 *      最后两级存在的理由是可测：没有它们，两次请求的顺序会随集合插入序变化。
 */
export function compareRows(a, b) {
  const aOverdue = a.severity === 'overdue';
  const bOverdue = b.severity === 'overdue';
  if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
  if (a.date !== b.date) {
    // 逾期组内：日期大的（更接近今天）在前；其余组：日期小的在前
    return aOverdue ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date);
  }
  const bySource = (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9);
  if (bySource !== 0) return bySource;
  return String(a.title ?? '').localeCompare(String(b.title ?? ''), 'zh-Hans-CN');
}

/** 目标列表排序：进行中 → 目标日 → 优先级 → 标题。 */
function compareGoals(a, b) {
  const rank = (item) => (item.status === 'active' ? 0 : item.status === 'done' ? 1 : 2);
  const byStatus = rank(a) - rank(b);
  if (byStatus !== 0) return byStatus;
  if (a.targetDate !== b.targetDate) return String(a.targetDate).localeCompare(String(b.targetDate));
  if (a.priority !== b.priority) return b.priority - a.priority;
  return String(a.title ?? '').localeCompare(String(b.title ?? ''), 'zh-Hans-CN');
}

// ---------------------------------------------------------------- 小工具

/** 汇总"逾期几条 / 7 天内几条 / 30 天内几条"。窗口外的条目不计入任何一类。 */
export function summarize(rows) {
  let overdue = 0;
  let within7 = 0;
  let within30 = 0;
  let urgent = 0;
  for (const row of rows) {
    if (row.severity === 'overdue') overdue += 1;
    else if (row.severity === 'urgent') urgent += 1;
    if (row.daysLeft >= 0 && row.daysLeft <= 7) within7 += 1;
    if (row.daysLeft >= 0 && row.daysLeft <= 30) within30 += 1;
  }
  return {
    total: rows.length,
    overdue,
    urgent,
    dueWithin7Days: within7,
    dueWithin30Days: within30,
    /** 命中用户自设 `remindDays` 的条数：定时唤醒用它决定"今天要不要提" */
    attention: rows.filter((row) => row.remindHit === true).length,
    /** 最近的一条是什么（daysLeft 最小的非逾期项；全是逾期时给最接近今天的那个） */
    next:
      rows.filter((row) => row.daysLeft >= 0).sort((a, b) => a.daysLeft - b.daysLeft)[0]?.title ??
      rows.filter((row) => row.overdue).sort((a, b) => b.daysLeft - a.daysLeft)[0]?.title ??
      null,
  };
}

/** 事件类型：考试 / 截止 / 其余。与日历事件的 `category` 约定一致（§2.1）。 */
function eventKindOf(event) {
  const category = String(event.category ?? '').toLowerCase();
  if (category === 'exam' || /考试|测验|考查|机考|笔试|面试/.test(String(event.title ?? ''))) return 'exam';
  if (category === 'deadline' || /截止|报名|提交|deadline|ddl/i.test(String(event.title ?? ''))) return 'deadline';
  return 'event';
}

/** 事件的课程归属：事件没有 `course` 字段，只能从标题/描述里"包含课程名"来判断。 */
function courseMatches(event, course) {
  if (event.course === course) return true;
  const haystack = `${event.title ?? ''} ${event.description ?? ''}`;
  return haystack.includes(course);
}

/** 夹紧整数（查询参数是字符串，服务层统一收敛，路由不再各写一份）。 */
function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

/** 只读调用别人的服务：对方内部抛错时不能拖垮本模块的合并视图。 */
function safeCall(run) {
  try {
    return run();
  } catch {
    return undefined;
  }
}

/** 显式来源（可选）：便于区分手工录入 / 指令 / 导入，与日历三域的 `source` 同口径。 */
function optionalSource(value) {
  if (value === undefined || value === null || value === '') return 'manual';
  const allowed = ['manual', 'command', 'ai', 'import'];
  if (!allowed.includes(value)) fail('source', `取值必须是 ${allowed.join(' / ')} 之一`);
  return value;
}

/**
 * 降级用的学分绩：**只做学业模块同一套加权公式**（Σ(学分×绩点)/Σ(学分)），
 * 且只统计 `included !== false` 的课程，与 `academic/service.js` 的 `listGrades({included:true})` 同口径。
 *
 * 明确不做的两件事：① 不按分数换算绩点（教务直接给 `gradePoint`，自己换算就是第二套口径）；
 * ② 不引入 `academic/config.js` 的绩点表（那会把本模块和学业模块的内部实现绑死）。
 * 因此这条路算出来的数与学业模块**可能有细微差别**，返回里用 `source` 如实标注。
 */
function weightedGpaOf(grades) {
  let credits = 0;
  let weighted = 0;
  let count = 0;
  for (const item of grades) {
    if (item.included === false) continue;
    if (item.active === false) continue;
    const point = Number(item.gradePoint);
    const credit = Number(item.credit);
    if (!Number.isFinite(point) || !Number.isFinite(credit) || credit <= 0) continue;
    credits += credit;
    weighted += credit * point;
    count += 1;
  }
  if (!count || credits <= 0) return null;
  return { gpa: Number((weighted / credits).toFixed(3)), count };
}
