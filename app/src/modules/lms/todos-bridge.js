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
 */

import { parseLmsDate } from './time.js';

/** 待办上的标签：用来在待办页筛出"学堂来的"，也是 AI 识别来源的标记。 */
export const LMS_TODO_TAG = '学堂';

/** 外部键前缀：与 `sync.js` 共用同一套（幂等匹配只看这个）。 */
export const LMS_ACTIVITY_PREFIX = 'lms:activity:';

/** `source` 取值：现有枚举里"从外部导入"的那个（理由见文件头第 1 条）。 */
const SOURCE = 'import';

/** 待办标题上限与 calendar 的 `requireTitle` 一致（120），超长直接截断，不让一条脏数据挡住整次同步。 */
const MAX_TITLE = 120;

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
 * @param {object} input
 * @param {object[]} [input.activities] 归一化活动（可来自缓存）
 * @param {object[]} [input.courses]   课程（用 `id` 或 `courseId` 认课程名）
 * @param {object[]} [input.existingTodos] 现有待办（含非学堂的；只按 externalId 命中）
 * @returns {{items: object[], summary: {create:number, update:number, skip:number, completed:number}}}
 */
export function planHomeworkTodos({ activities = [], courses = [], existingTodos = [] } = {}) {
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

    const courseName = resolveCourseName(activity, courseById);
    const payload = homeworkTodoPayload(activity, { courseName });
    const submitted = isSubmittedHomework(activity);

    if (!payload) {
      summary.skip += 1;
      items.push({
        key,
        action: 'skip',
        activityId: activity.id,
        courseId: Number(activity.courseId ?? 0) || null,
        courseName,
        title: activity.title ?? null,
        submitted,
        reason: '没有截止日期，不建待办（不编日期）',
      });
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

  return { items, summary };
}

/**
 * 执行计划。单个条目失败只记进 `errors`，不影响其它作业（一次坏数据不该让整批不同步）。
 *
 * @param {object} input
 * @param {object} input.todos 待办服务（`create` / `update`）
 * @param {object} input.plan  `planHomeworkTodos()` 的返回
 * @returns {Promise<{created:number, updated:number, completed:number, skipped:number, written:number, errors:object[]}>}
 */
export async function applyHomeworkTodoPlan({ todos, plan } = {}) {
  if (!todos?.create || !todos?.update) throw new Error('待办服务不可用：需要 create/update');
  const result = { created: 0, updated: 0, completed: 0, skipped: 0, written: 0, errors: [] };

  for (const item of plan?.items ?? []) {
    if (item.action === 'skip') {
      result.skipped += 1;
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
export async function syncHomeworkTodos({ todos, activities, courses, existingTodos } = {}) {
  const plan = planHomeworkTodos({ activities, courses, existingTodos });
  const result = await applyHomeworkTodoPlan({ todos, plan });
  return { ...result, items: plan.items.filter((item) => item.action === 'skip') };
}
