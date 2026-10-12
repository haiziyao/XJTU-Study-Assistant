/**
 * 目标模块的 REST 路由（前缀 `${apiPrefix}/goals`）。
 *
 * 这一层刻意很薄：合并排序、severity、gpa 降级都在 `GoalService` 里。路由只做三件事 ——
 * **参数校验**（HTTP 的字符串查询参数 → 服务层认识的类型）、**边界收敛**（limit/days 夹紧，
 * 防止一次请求把整库拖出来）、以及**错误语义**（400 说清哪个字段错了，404 说清哪条不存在）。
 * 规则写两份，迟早有一份先过期。
 *
 * 接口清单：
 *   GET    /goals?status=&kind=&course=&q=&limit=&offset=  列表 + 分组计数
 *   POST   /goals                                          新建（201）
 *   GET    /goals/overview?days=30                         ★ 三来源合并的"接下来要面对什么"
 *   GET    /goals/alerts?days=7                            预警精简版（定时唤醒/首页）
 *   GET    /goals/target-gpa                               读目标学分绩
 *   POST   /goals/target-gpa                               写目标学分绩
 *   GET    /goals/:id                                      取一条
 *   PATCH  /goals/:id                                      局部更新
 *   DELETE /goals/:id                                      删除
 *   POST   /goals/:id/progress                             改进度 / 勾里程碑
 *
 * **路由顺序有讲究**：`/goals/overview`、`/goals/alerts`、`/goals/target-gpa` 必须先于
 * `/goals/:id` 注册，否则 `:id` 会把 "overview" 当成一个目标 id 吃掉（router 按注册顺序匹配）。
 */

import { HttpError } from '../../core/http/router.js';
import { DEFAULT_LIST_LIMIT, GOAL_KINDS, GOAL_STATUSES, MAX_LIST_LIMIT } from './service.js';

/** 可选文本：空串当"没传"，避免 `?kind=` 把结果过滤成空。 */
const optionalText = (value) => {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
};

/** 可选布尔：只认显式的真值写法（`?includeDone=1|true|yes`）。 */
const optionalBool = (value) => value === true || ['1', 'true', 'yes'].includes(String(value ?? '').toLowerCase());

/**
 * 可选整数：**给了就必须是合法整数**。
 *
 * 与知识库的"非法值静默回落默认值"不同：limit/offset 是分页用的，`?limit=abc` 静默变成 50
 * 会让前端以为"一共就这么多"。宁可 400。
 */
function optionalInt(value, field, { min, max }) {
  if (value === undefined || value === null || value === '') return undefined;
  const num = Number(value);
  if (!Number.isInteger(num)) throw HttpError.badRequest(`字段 ${field} 不合法：必须是整数`, { field });
  if (num < min || num > max) {
    throw HttpError.badRequest(`字段 ${field} 不合法：取值范围 ${min}~${max}`, { field });
  }
  return num;
}

function requireBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw HttpError.badRequest('请求体必须是 JSON 对象');
  }
  return body;
}

/**
 * 注册目标路由。
 *
 * @param {object} router   createRouter() 的实例（见 core/http/router.js）
 * @param {object} ctx      模块上下文：`own.goals` 是 GoalService，`apiPrefix` 由 server 注入
 */
export function registerGoalRoutes(router, { own, services, apiPrefix = '/api/v1' }) {
  const P = `${apiPrefix}/goals`;
  const goals = own?.goals ?? services?.goals;
  // 与 lms/academic/memory 同一习惯：服务没装配好时宁可不注册，
  // 也不要让每个请求在运行期炸一个 "Cannot read properties of undefined"。
  if (!goals) return;

  /**
   * ★ 概览（放在 `/goals/:id` 之前，否则会被当成 id）。
   *
   * `?days=` 是**未来窗口**；逾期项永远包含（隐藏逾期等于骗人），由服务层保证。
   * `?limit=` 在排序之后截断，且 `count` 给的是**排序后的总条数**而不是本页条数 ——
   * 前端据此显示"还有 N 条"。
   */
  router.get(`${P}/overview`, ({ query }) => {
    const course = optionalText(query?.course);
    return goals.overview({
      days: optionalInt(query?.days, 'days', { min: 1, max: 365 }) ?? 30,
      limit: optionalInt(query?.limit, 'limit', { min: 1, max: MAX_LIST_LIMIT }) ?? 50,
      includeDone: optionalBool(query?.includeDone),
      course,
    });
  });

  /** 预警精简版：只给"能据此行动"的字段，给定时唤醒与首页横幅用。 */
  router.get(`${P}/alerts`, ({ query }) => goals.alerts({
    days: optionalInt(query?.days, 'days', { min: 1, max: 90 }) ?? 7,
  }));

  /**
   * 目标学分绩（诚实版）。
   *
   * `GET` 只回目标值与免责声明；**当前学分绩在 `/goals/overview` 的 `gpa` 里**
   * （它是合并视图的一部分，需要读学业模块，单独放在这里会让前端多打一次接口、
   * 还可能拿到与 overview 不一致的两个数字）。
   */
  router.get(`${P}/target-gpa`, () => goals.getTargetGpa());

  router.post(`${P}/target-gpa`, async ({ body }) => {
    const input = requireBody(body);
    // 只认 `targetGpa` 一个字段：`?clear` 之类的写法各端会不一致
    const result = await goals.setTargetGpa(input.targetGpa);
    return { ...result, writes: true };
  });

  /**
   * 列表 / 检索。
   *
   * `status` / `kind` 都支持逗号分隔（`?status=active,done`），便于管理页一次拉多类；
   * 非法枚举直接 400 —— 静默返回空列表会让用户以为"数据没了"。
   */
  router.get(P, ({ query }) => {
    const kind = optionalText(query?.kind);
    if (kind) {
      const wanted = kind.split(',').map((item) => item.trim()).filter(Boolean);
      const bad = wanted.find((item) => !GOAL_KINDS.includes(item));
      if (bad) {
        throw HttpError.badRequest(`字段 kind 不合法：取值必须是 ${GOAL_KINDS.join(' / ')} 之一`, { field: 'kind' });
      }
    }
    const status = optionalText(query?.status);
    if (status) {
      const wanted = status.split(',').map((item) => item.trim()).filter(Boolean);
      const bad = wanted.find((item) => !GOAL_STATUSES.includes(item));
      if (bad) {
        throw HttpError.badRequest(`字段 status 不合法：取值必须是 ${GOAL_STATUSES.join(' / ')} 之一`, { field: 'status' });
      }
    }

    return goals.list({
      status,
      kind,
      course: optionalText(query?.course),
      q: optionalText(query?.q),
      limit: optionalInt(query?.limit, 'limit', { min: 1, max: MAX_LIST_LIMIT }) ?? DEFAULT_LIST_LIMIT,
      offset: optionalInt(query?.offset, 'offset', { min: 0, max: 100000 }) ?? 0,
    });
  });

  /** 新建（201）。校验在服务层，`dryRun` 之外没有第二条写入路径。 */
  router.post(P, async ({ body }) => {
    const input = requireBody(body);
    const item = await goals.create(input);
    return { __status: 201, item, writes: true };
  });

  router.get(`${P}/:id`, ({ params }) => ({ item: goals.detail(params.id) }));

  /** 局部更新：只改传了的字段（未传的保持原值）。 */
  router.patch(`${P}/:id`, async ({ params, body }) => {
    const patch = requireBody(body);
    return { item: await goals.update(params.id, patch), writes: true };
  });

  router.delete(`${P}/:id`, async ({ params }) => goals.remove(params.id));

  /**
   * 改进度 / 勾里程碑。
   *
   * 用 `POST` 而不是 `PATCH /goals/:id`：这个动作**不是**"改字段"，而是一次语义化的推进
   * （勾完最后一步要把进度补到 100）。混进 PATCH 会让"只想改标题"的调用方也走一遍进度逻辑。
   */
  router.post(`${P}/:id/progress`, async ({ params, body }) => {
    const input = body === undefined ? {} : requireBody(body);
    return { item: await goals.setProgress(params.id, input), writes: true };
  });
}
