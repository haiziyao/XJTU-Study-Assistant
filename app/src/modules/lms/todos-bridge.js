/**
 * 思源学堂作业 → 待办（Todo）的桥接：纯函数规划 + 落库。
 *
 * 目标只有一个：**不登录待办页也能看到"哪天要交什么"**。活动同步（拉作业列表）成功后
 * 自动把作业 upsert 成待办，用户不必再走「预览 → 勾选 → 同步」三步。
 *
 * 几个刻意的取舍（写在这里，避免以后被"优化"掉）：
 *
 * 1. **为什么用 `externalId = lms:activity:<id>` 而不是给待办加一个新的 `source: 'lms'`**
 *    `TodoService` 的 `SOURCES` 是封闭枚举（manual/command/ai/import），加 'lms' 要改
 *    `modules/calendar/**`，而日历正在被另一个任务改动。`externalId` 本来就是"这条记录来自
 *    外部系统的哪一项"的唯一键（课表导入用 `timetable:` 前缀，也是同一套语义），
 *    复用它既能幂等、又不动日历模块；`source: 'import'` 是现有枚举里最准确的一个
 *    （它确实是从外部导入的）。将来若 `SOURCES` 里补上 'lms'，改这里的 `SOURCE` 常量即可，
 *    匹配逻辑不变（匹配只看 externalId）。
 *
 * 2. **为什么不自动删待办**
 *    学校侧"活动消失"可能是老师撤回、课程退课，也可能只是这次接口没返回（限流 / 分页 / 临时缺数据）。
 *    而待办是**用户可编辑**的：他可能改了标题、补了说明、勾了完成。自动删是不可撤销的破坏，
 *    一次接口抖动就会让用户丢掉自己写过的东西。宁可留下一条过期待办让用户自己删，
 *    也不替用户做删除这种"看起来贴心"的决定。清理入口仍然在待办页（用户自己删）。
 *
 * 3. **为什么没有截止日就不建**
 *    待办的领域核心就是 `deadline`：排序、逾期、日历分桶全靠它。没有截止日时编一个
 *    "今天"或"学期末"会让「哪天要交什么」这句承诺直接变成假话。跳过并计入 `skipped`，
 *    让调用方知道"有一条作业因为缺日期没进来"，而不是静默当成没有作业。
 *
 * 4. **为什么已提交只标完成、不删除**
 *    学生可能还要回看要求、分数、附件；把记录删掉等于"交完就找不到了"。
 *    完成态只是把它从"待办"的视角收起来，记录本身仍然在。
 *
 * 5. **为什么不覆盖 `completed: false`**
 *    用户可能已经手动勾掉一条作业，而学校那边还没标提交；同步不能把用户亲手记录的完成态
 *    翻回去。本桥接只做「未完成 → 完成」这一个方向。
 *
 * 6. **为什么默认只同步「本学期」**
 *    学堂会返回**所有历史学期**的课程与作业（真实账号里横跨好几年）。全量 upsert 的后果是：
 *    用户第一次打开待办页，就被几百条往年作业淹没，真正要交的本学期作业反而找不到。
 *    "待办"的语义是接下来要做什么，不是学校数据的镜像，所以默认只收本学期。
 *
 * 7. **为什么不因为过滤而删除历史待办**
 *    切换口径不是"清理数据"：历史作业待办可能被用户改过标题、加过备注、勾过完成，
 *    甚至就是用户想留着回看的记录。过滤只决定"这次要不要 upsert"，删除仍是用户自己的事
 *    （待办页支持批量删除）。`currentTermOnly` 关掉后，之前没建的历史作业会补建；
 *    已经存在的历史待办不会因为重新打开过滤而消失。
 *
 * 8. **为什么学期未知时不建（宁缺勿滥）**
 *    没有学期字段也没有截止日，等于既证明不了"属于本学期"，也排不出"哪天要交"。
 *    这时建一条待办只会制造噪声；而漏掉一条的代价是用户还能在学堂页看到它。
 *    所以计入 `skipped` 并把 `reasonCode` 明确写成 `term_unknown`，让调用方知道
 *    "不是没作业，是判断不了"，而不是静默吞掉。
 */

import { daysBetween, parseLmsDate } from './time.js';

/** 待办上的标签：用来在待办页筛出"学堂来的"，也是 AI 识别来源的标记。 */
export const LMS_TODO_TAG = '学堂';

/** 外部键前缀：与 `sync.js` 共用同一套（幂等匹配只看这个）。 */
export const LMS_ACTIVITY_PREFIX = 'lms:activity:';

/** `source` 取值：现有枚举里"从外部导入"的那个（理由见文件头第 1 条）。 */
const SOURCE = 'import';

/** 待办标题上限与 calendar 的 `requireTitle` 一致（120），超长直接截断，不让一条脏数据挡住整次同步。 */
const MAX_TITLE = 120;

/**
 * 没有明确学期字段时，截止日超出「本学期」后还额外容忍多少天。
 *
 * 为什么是 30 天：学期边界并不总是刚好落在 1 月 31 日 / 8 月 31 日，学校还可能给
 * 补交、延期留口子；30 天足够覆盖"学期末顺延到下一学期初"的作业，又不至于把上一个
 * 学期（通常相隔 2~3 个月）的作业重新捞进来。数值写死而不做成配置，是为了让口径可测、
 * 可解释 —— 多一个配置项只会让"为什么这条作业没进来"更难回答。
 */
const TERM_GRACE_DAYS = 30;

/**
 * 判断"今天"时用的时区。
 *
 * 学堂所有时间都是北京时间墙上时间（见 time.js），学期划分也必须按北京时间算：
 * 进程时区设成 UTC 时，8 月 31 日 16:30 UTC 已经是北京时间 9 月 1 日 00:30，
 * 属于**新学期**。用本地 `getMonth()` 会在这种边界上错一个学期。
 */
const BEIJING_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** `Date | 'YYYY-MM-DD...'` → 北京时间 `YYYY-MM-DD`（纯函数，便于测试边界）。 */
function schoolDateKey(value = new Date()) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('无效日期：无法推算学期');
    return BEIJING_DATE.format(value);
  }
  const text = String(value ?? '').trim();
  // 只有纯日期才直接读；带时刻/时区的串必须交给 Date + 北京时间格式化，
  // 否则 '2026-08-31T16:30:00Z'（北京时间已是 9 月 1 日）会被错当成 8 月 31 日。
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`无效日期：${text}`);
  return BEIJING_DATE.format(parsed);
}

/** 只取日期部分（课程起止日可能是 `YYYY-MM-DD`，也可能带时刻）。 */
function datePrefix(value) {
  const match = String(value ?? '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

/**
 * 由「学年起始年 + 第几学期」构造学期对象。
 *
 * 约定（与 deriveSchoolTerm 的注释一致）：
 * - 第一学期：startYear-09-01 ~ startYear+1-01-31；
 * - 第二学期：startYear+1-02-01 ~ startYear+1-08-31（暑假并入第二学期）。
 */
function buildTerm(startYear, index, { source = 'system' } = {}) {
  const endYear = startYear + 1;
  return {
    startYear,
    index,
    academicYear: `${startYear}-${endYear}`,
    code: `${startYear}-${index}`,
    label: `${startYear}-${endYear} 学年${index === 1 ? '第一' : '第二'}学期`,
    startDate: index === 1 ? `${startYear}-09-01` : `${endYear}-02-01`,
    endDate: index === 1 ? `${endYear}-01-31` : `${endYear}-08-31`,
    source,
  };
}

/**
 * 系统学年/学期推算（纯函数）。
 *
 * 口径（用户要求，也贴合西安交大的校历）：
 * - **9 月 1 日 ~ 次年 1 月 31 日** = 该学年第一学期；
 * - **2 月 1 日 ~ 8 月 31 日** = 该学年第二学期（暑假并入第二学期，作为兜底足够粗）。
 *
 * 例：2026-08-31 → 2025-2026 学年第二学期；2026-09-01 → 2026-2027 学年第一学期；
 * 2027-01-31 → 2026-2027 学年第一学期；2027-02-01 → 2026-2027 学年第二学期。
 *
 * @param {Date|string} [now] 默认现在；测试可传固定时刻
 * @returns {{startYear:number,index:1|2,academicYear:string,code:string,label:string,startDate:string,endDate:string,source:'system'}}
 */
export function deriveSchoolTerm(now = new Date()) {
  const today = schoolDateKey(now);
  const [year, month] = today.split('-').map(Number);
  // 9~12 月属于当年开始的学年；1~8 月属于上一年 9 月开始的学年
  const startYear = month >= 9 ? year : year - 1;
  // 9~12 月与 1 月是第一学期；2~8 月是第二学期
  const index = month >= 9 || month === 1 ? 1 : 2;
  return buildTerm(startYear, index);
}

/** 两个学期是否是同一个（学年起点 + 学期序号）。 */
export function sameSchoolTerm(a, b) {
  return Boolean(a && b && a.startYear === b.startYear && a.index === b.index);
}

const CN_TERM_INDEX = Object.freeze({ 一: 1, 二: 2, 1: 1, 2: 2 });

/** 从一组文本里读「第几学期」：中文、数字 code、秋/春英文都认。 */
function termIndexOfTexts(texts) {
  for (const text of texts) {
    const chinese = String(text).match(/第\s*([一二12])\s*学期/);
    if (chinese) return CN_TERM_INDEX[chinese[1]];
  }
  for (const text of texts) {
    const numeric = String(text).match(/(?:^|[-_/])([12])\s*$/);
    if (numeric) return Number(numeric[1]);
  }
  for (const text of texts) {
    const value = String(text);
    if (/秋季|秋天|秋|autumn|fall/i.test(value)) return 1;
    if (/春季|春天|春|spring/i.test(value)) return 2;
    // 夏季学期 / 小学期并入第二学期：宁可多收，也不要因为名称特殊而漏掉
    if (/夏季|夏天|夏|summer/i.test(value)) return 2;
  }
  return null;
}

/** 从一组文本里读学年起始年（`2026-2027`、`2026 学年`、code `2026-1` 都认）。 */
function academicYearStartOfTexts(texts) {
  for (const text of texts) {
    const range = String(text).match(/(20\d{2})\s*[-–—~至]\s*(20\d{2})/);
    if (range) return Number(range[1]);
  }
  for (const text of texts) {
    const withYear = String(text).match(/(20\d{2})\s*学年/);
    if (withYear) return Number(withYear[1]);
  }
  for (const text of texts) {
    const anyYear = String(text).match(/(20\d{2})/);
    if (anyYear) return Number(anyYear[1]);
  }
  return null;
}

/**
 * 一个学期对象（学堂课程里的 `semester`）→ 可比较的学期身份。
 *
 * 真实数据里学期字段并不完整：可能只有 `code: '2026-1'`，可能只有 `name: '秋季学期'`，
 * 也可能 `real_name: '2026-2027学年秋季学期'`；学年信息有时在课程上而不是学期上。
 * 所以这里做的是"尽量读"：读不出来返回 null，让调用方走截止日兜底，
 * **不要**把"读不出来"猜成"当前学期"。
 *
 * @param {object|string|null} semester
 * @param {object|null} [academicYear] 课程上的学年信息（辅助判断秋季/春季属于哪一年）
 * @returns {object|null} 与 deriveSchoolTerm 同形状；无法判断时 null
 */
export function termIdentityOfSemester(semester, academicYear = null) {
  if (!semester && !academicYear) return null;
  const raw = typeof semester === 'string' ? { code: semester, name: semester } : semester ?? {};
  const yearRaw = typeof academicYear === 'string' ? { code: academicYear, name: academicYear } : academicYear ?? {};
  // 顺序有讲究：realName/name 通常信息最全（含学年与秋/春），code 可能是 'autumn'
  const texts = [
    raw.realName,
    raw.real_name,
    raw.name,
    raw.label,
    raw.code,
    yearRaw.name,
    yearRaw.code,
  ]
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map(String);
  const index = termIndexOfTexts(texts);
  const startYear = academicYearStartOfTexts(texts);
  if (!index || !startYear) return null;
  return buildTerm(startYear, index, { source: 'semester' });
}

/** 活动 / 课程上能表达"属于哪个学期"的字段（活动本身没有时看课程）。 */
function termIdentityOfActivity(activity, course) {
  // 归一化活动没有学期字段，真实学期挂在课程上；这里仍兼容活动直出学期的接口形态
  const semester =
    activity?.semester ??
    activity?.courseSemester ??
    activity?.term ??
    course?.semester ??
    course?.term ??
    activity?.XNXQDM ??
    activity?.xnxqdm ??
    course?.XNXQDM ??
    course?.xnxqdm ??
    null;
  const academicYear = activity?.academicYear ?? course?.academicYear ?? null;
  return termIdentityOfSemester(semester, academicYear);
}

/**
 * 当前学期：优先从 LMS 课程缓存里取，取不到再退回系统推算。
 *
 * "从 LMS 取"的判断依据是**课程自己的起止日期**：今天落在某门课的 `startDate~endDate`
 * 里，就说明 LMS 认为这门课正在上，它挂的 `semester` 就是"当前学期"。这样学校校历
 * 比 9 月 1 日 / 2 月 1 日略有出入时（比如 8 月底开学、1 月中旬结束）也能对准。
 *
 * 找不到"正在上"的课时，退一步用系统推算；如果课程里恰好有与系统推算同一个学期的
 * 课程（常见于还没到开学日、但课表已经下发），仍标记为来自 LMS，方便排查。
 *
 * @param {{courses?: object[], now?: Date|string}} [input]
 * @returns {object} 学期对象（`source` 为 `lms` 或 `system`）
 */
export function resolveCurrentTerm({ courses = [], now = new Date() } = {}) {
  const systemTerm = deriveSchoolTerm(now);
  const today = schoolDateKey(now);
  const inSession = [];
  let matchedSystem = false;

  for (const course of courses ?? []) {
    const term = termIdentityOfSemester(course?.semester ?? course?.term ?? null, course?.academicYear ?? null);
    if (!term) continue;
    if (sameSchoolTerm(term, systemTerm)) matchedSystem = true;
    const start = datePrefix(course?.startDate);
    const end = datePrefix(course?.endDate);
    if (!start || !end || start > today || today > end) continue;
    // 课程日期区间自己是否覆盖今天：覆盖的优先（第二学期里的暑期课程可能标"夏季学期"）
    const containsToday = term.startDate <= today && today <= term.endDate ? 1 : 0;
    inSession.push({ term, start, containsToday });
  }

  if (inSession.length) {
    // 同一时刻有两门不同学期的课（旧数据没清理）时，优先"学期区间覆盖今天"的那个，
    // 再按开课日期新的优先 —— 至少不会因为一门陈年课程把当前学期带偏。
    inSession.sort((a, b) => b.containsToday - a.containsToday || b.start.localeCompare(a.start));
    const chosen = inSession[0].term;
    return buildTerm(chosen.startYear, chosen.index, { source: 'lms' });
  }
  if (matchedSystem) return buildTerm(systemTerm.startYear, systemTerm.index, { source: 'lms' });
  return systemTerm;
}

/** 作业截止日：优先 endTime（作业的 end_time 就是截止时刻），没有再看 startTime。 */
function deadlineOf(activity) {
  return parseLmsDate(activity?.endTime) ?? parseLmsDate(activity?.startTime);
}

/** 生成活动的外部键（与 sync.js 的历史格式完全一致）。 */
export function activityExternalId(activityId) {
  return `${LMS_ACTIVITY_PREFIX}${activityId}`;
}

/** 是否是作业类活动（直播/回放/资料/其它一律不进待办）。 */
export function isHomeworkActivity(activity) {
  return activity?.type === 'homework';
}

/**
 * 作业是否已提交 / 已完成。
 *
 * 学堂的活动**列表接口不返回提交状态**，只有详情里才有 `user_submit_count`
 * （归一化后是 `userSubmitCount`，见 api.js 的 normalizeActivityDetail）。
 * 所以这里只认这个字段；拿不到就是"不知道"，按未提交处理 —— 宁可多留一条未完成待办，
 * 也不要把"没查过"说成"已完成"。
 */
export function isSubmittedHomework(activity) {
  return Number(activity?.userSubmitCount ?? 0) > 0;
}

function clip(text, max = MAX_TITLE) {
  const value = String(text ?? '').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** 作业标题里的日期前缀（真实数据里部分活动带）会让标题又长又重复，去掉它。 */
function cleanHomeworkTitle(rawTitle) {
  return String(rawTitle ?? '')
    .trim()
    .replace(/^\d{4}[-/]\d{1,2}[-/]\d{1,2}[-_\s]*/, '')
    .trim();
}

/** 取活动上的链接（不同接口版本可能叫 url / link；没有就是没有，绝不编一个地址）。 */
function activityLink(activity) {
  for (const key of ['url', 'link', 'webUrl']) {
    const value = activity?.[key];
    if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) return value.trim();
  }
  return null;
}

/** 课程名：活动缓存上带着（`#saveActivities` 写入），其次是课程表里的名字。 */
export function resolveCourseName(activity, courseById) {
  if (activity?.courseName) return String(activity.courseName);
  const course = courseById?.get(Number(activity?.courseId));
  return course?.name ? String(course.name) : null;
}

/**
 * 一条作业活动 → 待办 payload；没有截止日返回 null（调用方计入 skipped）。
 *
 * 字段映射（对外契约）：
 * - `title`：`课程名：作业标题`（没有课程名时只用作业标题）；
 * - `deadline`：活动截止日的 `YYYY-MM-DD`（北京时间墙上时间，见 time.js）；
 * - `description`：`来自思源学堂`（有活动链接时追加一行）；
 * - `tags`：`['学堂']`；
 * - `source`：`import`；`externalId`：`lms:activity:<活动 id>`。
 *
 * @param {object} activity 归一化活动（至少 `type` / `id` / `title` / `endTime`|`startTime`）
 * @param {{courseName?: string|null}} [options]
 * @returns {object|null} 没有可用截止日时返回 null
 */
export function homeworkTodoPayload(activity, { courseName = null } = {}) {
  if (!isHomeworkActivity(activity)) return null;
  // 截止日优先 endTime（作业的 end_time 就是截止时刻），没有再看 startTime
  const deadline = parseLmsDate(activity.endTime) ?? parseLmsDate(activity.startTime);
  if (!deadline) return null;

  const rawTitle = cleanHomeworkTitle(activity.title) || `作业 ${activity.id}`;
  const title = courseName ? `${courseName}：${rawTitle}` : rawTitle;
  const link = activityLink(activity);
  const description = link ? `来自思源学堂\n活动链接：${link}` : '来自思源学堂';

  return {
    title: clip(title),
    deadline,
    description,
    tags: [LMS_TODO_TAG],
    source: SOURCE,
    externalId: activityExternalId(activity.id),
  };
}

/** 数组字段比较（tags 的顺序即语义，直接用 `|` 拼起来比）。 */
function sameArray(a, b) {
  return (a ?? []).join('|') === (b ?? []).join('|');
}

/** 桥接管理的字段：只碰这几个，`priority` / `estimatedHours` / `parentId` 等用户字段一律不动。 */
const MANAGED_FIELDS = ['title', 'deadline', 'description'];

/**
 * 跳过原因（写进 `items[].reasonCode`，并按原因汇总到 `skippedReasons`）。
 *
 * 用稳定的英文 code 而不是只给一句中文：界面 / AI / 日志需要按原因分类统计
 * （"这次少进来的作业里，多少是历史学期、多少是缺日期"），中文文案随时会改，
 * code 是调用方可以放心依赖的契约。
 */
export const SKIP_REASONS = Object.freeze({
  /** 有明确学期，但不是当前学期。 */
  TERM_MISMATCH: 'term_mismatch',
  /** 没有学期字段，且截止日也不在当前学期 / 未来 30 天内。 */
  DEADLINE_OUTSIDE_TERM: 'deadline_outside_term',
  /** 既没有学期字段也没有截止日：无法证明属于本学期。 */
  TERM_UNKNOWN: 'term_unknown',
  /** 学期对了，但没有截止日（不编日期）。 */
  NO_DEADLINE: 'no_deadline',
});

/**
 * 判断一条作业是否属于「本学期」。
 *
 * 判定顺序（**不能调换**）：
 * a. 活动/课程带明确学期 → 只接受与当前学期相同；不同就是历史学期，直接跳过。
 *    先看明确学期，是因为它是学校给的权威信息，不能被"截止日看起来像本学期"覆盖
 *    （例如往年作业的补交截止日被改到了今年）。
 * b. 没有明确学期 → 用截止日兜底：落在本学期起止内，或从今天起 30 天内，才同步。
 * c. 两者都没有 → 跳过，原因 `term_unknown`（宁缺勿滥，理由见文件头第 8 条）。
 */
function filterHomeworkByTerm({ activity, course, currentTerm, now }) {
  const deadline = deadlineOf(activity);
  const explicitTerm = termIdentityOfActivity(activity, course);

  if (explicitTerm) {
    if (!sameSchoolTerm(explicitTerm, currentTerm)) {
      return {
        allowed: false,
        reasonCode: SKIP_REASONS.TERM_MISMATCH,
        reason: `作业属于「${explicitTerm.label}」，不是当前学期「${currentTerm.label}」，不建待办`,
      };
    }
    if (!deadline) {
      return {
        allowed: false,
        reasonCode: SKIP_REASONS.NO_DEADLINE,
        reason: '没有截止日期，不建待办（不编日期）',
      };
    }
    return { allowed: true, deadline };
  }

  if (!deadline) {
    return {
      allowed: false,
      reasonCode: SKIP_REASONS.TERM_UNKNOWN,
      reason: '既没有学期信息也没有截止日期，无法确认属于本学期，不建待办（宁缺勿滥）',
    };
  }

  const today = schoolDateKey(now);
  const insideTerm = deadline >= currentTerm.startDate && deadline <= currentTerm.endDate;
  // 未来 30 天内也收：学期边界上的作业可能落在下一学期初，学校也可能给补交/延期留口子
  const withinGrace = deadline >= today && daysBetween(today, deadline) <= TERM_GRACE_DAYS;
  if (insideTerm || withinGrace) return { allowed: true, deadline };

  return {
    allowed: false,
    reasonCode: SKIP_REASONS.DEADLINE_OUTSIDE_TERM,
    reason: `没有学期信息，且截止日 ${deadline} 不在当前学期（${currentTerm.startDate} ~ ${currentTerm.endDate}）内，也不在未来 ${TERM_GRACE_DAYS} 天内，不建待办`,
  };
}

/** 统一构造 skip 条目，保证调用方拿到的字段齐（界面能显示是哪条作业被跳过了）。 */
function skipItem({ activity, courseName, submitted, reasonCode, reason, deadline = null }) {
  return {
    key: activityExternalId(activity.id),
    action: 'skip',
    activityId: activity.id,
    courseId: Number(activity.courseId ?? 0) || null,
    courseName,
    title: activity.title ?? null,
    submitted,
    ...(deadline ? { deadline } : {}),
    reasonCode,
    reason,
  };
}

/**
 * 生成「作业 → 待办」的 upsert 计划（不落库，方便单测与诊断）。
 *
 * 幂等口径：同一 `externalId` 只对应一条待办。已存在时：
 *   - `title` / `deadline` / `description` / `tags` 与学校数据不一致才写（不制造无意义 IO）；
 *   - **不动** `completed`（除了"已提交且现在未完成 → 完成"这一个方向）；
 *   - 不新建第二条，也不会把用户改过的其它字段（优先级、分类、父任务…）重置。
 *
 * `updated` 在 summary / 结果里按「命中的已有待办」计数（含字段一致、无需写库的那些）：
 * 第二次同步的语义是"这条已经由学堂核对并接管"，而不是"什么都没发生" —— 调用方据此判断
 * 桥接确实跑过。真正写库的条数另由 `written` 给出。
 *
 * `currentTermOnly` 默认 **true**：只 upsert 本学期的作业。它只影响"这次建/更新哪些"，
 * 不会删除任何已有待办（见文件头第 7 条）。关掉即恢复旧行为（全量同步）。
 *
 * @param {object} input
 * @param {object[]} [input.activities] 归一化活动（可来自缓存）
 * @param {object[]} [input.courses]   课程（用 `id` 或 `courseId` 认课程名）
 * @param {object[]} [input.existingTodos] 现有待办（含非学堂的；只按 externalId 命中）
 * @param {boolean} [input.currentTermOnly=true] 只同步本学期
 * @param {object} [input.currentTerm] 当前学期（调用方已从 LMS 状态算好时传入；不传则用课程 + now 推算）
 * @param {Date|string} [input.now] 测试注入的"今天"
 * @returns {{items: object[], summary: {create:number, update:number, skip:number, completed:number}, currentTerm: object|null}}
 */
export function planHomeworkTodos({
  activities = [],
  courses = [],
  existingTodos = [],
  currentTermOnly = true,
  currentTerm = null,
  now = new Date(),
} = {}) {
  const courseById = new Map();
  for (const course of courses ?? []) {
    const id = Number(course?.id ?? course?.courseId);
    if (Number.isFinite(id)) courseById.set(id, course);
  }
  const todoByExternalId = new Map();
  for (const todo of existingTodos ?? []) {
    if (todo?.deletedAt) continue;
    if (todo?.externalId) todoByExternalId.set(String(todo.externalId), todo);
  }

  // 只在需要过滤时推算学期；关掉开关就完全走旧路径，连"今天"都不读
  const effectiveTerm = currentTermOnly ? currentTerm ?? resolveCurrentTerm({ courses, now }) : null;

  const items = [];
  const seen = new Set();
  const summary = { create: 0, update: 0, skip: 0, completed: 0 };

  for (const activity of activities ?? []) {
    // 非作业（直播 / 回放 / 资料 / 在线视频…）不是候选，连 skipped 都不计：
    // 那个数字要能回答"为什么我的作业没进来"，把上千条回放算进去只会把它淹掉。
    if (!isHomeworkActivity(activity)) continue;
    const key = activityExternalId(activity.id);
    if (seen.has(key)) continue; // 同一活动被多门课/多次返回时只处理第一次
    seen.add(key);

    const course = courseById.get(Number(activity.courseId)) ?? null;
    const courseName = resolveCourseName(activity, courseById);
    const submitted = isSubmittedHomework(activity);

    // 学期过滤放在字段映射之前：被判定为历史学期的活动连 payload 都不生成，
    // 这样"这次同步到底碰了哪些作业"在 items 里一眼可见（skip + reasonCode）。
    if (currentTermOnly) {
      const verdict = filterHomeworkByTerm({ activity, course, currentTerm: effectiveTerm, now });
      if (!verdict.allowed) {
        summary.skip += 1;
        items.push(
          skipItem({
            activity,
            courseName,
            submitted,
            reasonCode: verdict.reasonCode,
            reason: verdict.reason,
            deadline: deadlineOf(activity),
          }),
        );
        continue;
      }
    }

    const payload = homeworkTodoPayload(activity, { courseName });
    if (!payload) {
      summary.skip += 1;
      items.push(
        skipItem({
          activity,
          courseName,
          submitted,
          reasonCode: SKIP_REASONS.NO_DEADLINE,
          reason: '没有截止日期，不建待办（不编日期）',
        }),
      );
      continue;
    }

    const existing = todoByExternalId.get(key);
    if (!existing) {
      const createdPayload = submitted ? { ...payload, completed: true } : payload;
      summary.create += 1;
      if (submitted) summary.completed += 1;
      items.push({
        key,
        action: 'create',
        activityId: activity.id,
        courseId: Number(activity.courseId ?? 0) || null,
        courseName,
        submitted,
        payload: createdPayload,
        title: createdPayload.title,
      });
      continue;
    }

    const patch = {};
    for (const field of MANAGED_FIELDS) {
      const before = existing[field] ?? null;
      const after = payload[field] ?? null;
      if (String(before ?? '') !== String(after ?? '')) patch[field] = payload[field];
    }
    if (!sameArray(existing.tags, payload.tags)) patch.tags = payload.tags;
    // 已提交 → 只往"完成"方向推；绝不写 completed:false（用户手动勾掉的不能被同步翻回去）
    if (submitted && !existing.completed) {
      patch.completed = true;
      summary.completed += 1;
    }

    summary.update += 1;
    items.push({
      key,
      action: 'update',
      activityId: activity.id,
      courseId: Number(activity.courseId ?? 0) || null,
      courseName,
      submitted,
      existingId: existing.id,
      patch,
      // 写库条数（patch 为空表示核对过、无需改动，但同样计入 updated，口径见上面的注释）
      written: Object.keys(patch).length > 0,
      title: payload.title,
    });
  }

  return { items, summary, currentTerm: effectiveTerm };
}

/**
 * 执行计划。单个条目失败只记进 `errors`，不影响其它作业（一次坏数据不该让整批不同步）。
 *
 * `skippedReasons` 按 `reasonCode` 汇总跳过原因（`term_unknown` / `term_mismatch` …），
 * 让接口能回答"为什么这次少了几条"，而不是只给一个总数。
 *
 * @param {object} input
 * @param {object} input.todos 待办服务（`create` / `update`）
 * @param {object} input.plan  `planHomeworkTodos()` 的返回
 * @returns {Promise<{created:number, updated:number, completed:number, skipped:number, written:number, skippedReasons:object, errors:object[]}>}
 */
export async function applyHomeworkTodoPlan({ todos, plan } = {}) {
  if (!todos?.create || !todos?.update) throw new Error('待办服务不可用：需要 create/update');
  const result = { created: 0, updated: 0, completed: 0, skipped: 0, written: 0, skippedReasons: {}, errors: [] };

  for (const item of plan?.items ?? []) {
    if (item.action === 'skip') {
      result.skipped += 1;
      const reason = item.reasonCode ?? 'unknown';
      result.skippedReasons[reason] = (result.skippedReasons[reason] ?? 0) + 1;
      continue;
    }
    try {
      if (item.action === 'create') {
        const created = await todos.create(item.payload);
        result.created += 1;
        if (created?.completed) result.completed += 1;
      } else if (item.action === 'update') {
        result.updated += 1;
        if (item.written) {
          await todos.update(item.existingId, item.patch);
          result.written += 1;
        }
        if (item.patch?.completed === true) result.completed += 1;
      }
    } catch (error) {
      result.errors.push({ key: item.key, message: error?.message ?? String(error) });
    }
  }
  return result;
}

/** `planHomeworkTodos` + `applyHomeworkTodoPlan` 的便捷组合（测试与手动同步都用它）。 */
export async function syncHomeworkTodos({
  todos,
  activities,
  courses,
  existingTodos,
  currentTermOnly = true,
  currentTerm = null,
  now = new Date(),
} = {}) {
  const plan = planHomeworkTodos({ activities, courses, existingTodos, currentTermOnly, currentTerm, now });
  const result = await applyHomeworkTodoPlan({ todos, plan });
  return { ...result, currentTerm: plan.currentTerm, items: plan.items.filter((item) => item.action === 'skip') };
}
