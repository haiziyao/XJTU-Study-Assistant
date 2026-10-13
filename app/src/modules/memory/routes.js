/**
 * 记忆路由：接口文档 §10.5 的 6 个接口，全部挂在 `/api/v1/memories` 下。
 *
 * 这一层刻意很薄：去重、覆盖链、敏感信息、预算排序都在 `MemoryService` 里。
 * 路由只做三件事 —— **参数校验**（把 HTTP 的字符串查询参数变成服务层认识的类型）、
 * **边界收敛**（limit/offset 夹紧，防止一次请求把整库拖出来）、以及**错误语义**
 * （400 说清是哪个字段错了、409 让用户选）。规则写两份，迟早会有一份先过期。
 *
 * 几条刻意的取舍：
 *
 * 1. **`GET /memories` 默认不过滤 `status`**：管理页要看全生命周期，而且 §10.4 要求
 *    AI 提议前能查到"同 scope+key 是否已被否决" —— 默认只给 active 会让这条规则失效。
 *
 * 2. **冲突返回 409 而不是静默覆盖**（§10.5）。一条错的长期偏好会污染之后每一次对话，
 *    所以"保留旧的 / 换成新的 / 两条都留"必须由用户来选，调用方不许替他决定；
 *    只有带 `replace: true` 才是明确的"换成新的"（旧条转 superseded，不删除）。
 *
 * 3. **`POST /memories/propose` 永远 `writes: false`**：它只产出草稿。前端可以把这个草稿
 *    直接喂给 §4.2 的确认卡，用户点确认后走 `/commands/execute`（target `memory`）——
 *    那是唯一的落库时刻。
 *
 * 4. **多了一个 `DELETE /memories`（清空）**：§10.8 明确要求"整体删除前先备份成
 *    `memories.json.bak-<时间戳>`"，管理页的一键清空总得有个后端。它不在 6 个接口里，
 *    是**额外加的一条**，不影响别的路径。
 */

import { HttpError } from '../../core/http/router.js';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  isValidKey,
  isValidScope,
  normalizeKey,
} from './service.js';

/** 可选文本：空串当"没传"，避免 `?kind=` 把结果过滤成空。 */
const optionalText = (value) => {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
};

/** 可选布尔：只认显式的真值写法（`?dueReview=1|true|yes`）。 */
const optionalBool = (value) => value === true || ['1', 'true', 'yes'].includes(String(value ?? '').toLowerCase());

/**
 * 可选整数：**给了就必须是合法整数**。
 *
 * 与知识库的 `normalizeLimit`（非法值静默回落默认值）不同：这里的 limit/offset 是
 * 管理页分页用的，`?limit=abc` 静默变成 50 会让前端以为"一共就这么多"，宁可 400。
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
 * 注册记忆路由。
 *
 * @param {object} router createRouter() 的实例（见 core/http/router.js）
 * @param {object} ctx    模块上下文：`services.memory` 是 MemoryService，
 *                        `apiPrefix` 由 server 注入（形如 `/api/v1`）
 */
export function registerMemoryRoutes(router, { services, apiPrefix = '/api/v1' }) {
  const P = `${apiPrefix}/memories`;
  const memory = services.memory;

  // 与 lms/academic/notes 的 `if (!xxx) return;` 同一习惯：服务没装配好时宁可不注册，
  // 也不要让每个请求在运行期炸一个 "Cannot read properties of undefined"。
  if (!memory) return;

  /**
   * 列表 / 检索（§10.5）：`?scope=&kind=&status=&key=&q=&limit=&offset=`。
   *
   * `status` 支持逗号分隔（`?status=active,archived`），便于管理页一次拉"没被取代的那些"；
   * `dueReview=1` 只给"到期待复核"的（§10.7 的复核语义：到期不再注入，但仍要看得见）。
   */
  router.get(P, ({ query }) => {
    const kind = optionalText(query?.kind);
    if (kind && !MEMORY_KINDS.includes(kind)) {
      throw HttpError.badRequest(`字段 kind 不合法：取值必须是 ${MEMORY_KINDS.join(' / ')} 之一`, { field: 'kind' });
    }
    const status = optionalText(query?.status);
    if (status) {
      const wanted = status.split(',').map((item) => item.trim()).filter(Boolean);
      const bad = wanted.find((item) => !MEMORY_STATUSES.includes(item));
      if (bad) {
        throw HttpError.badRequest(`字段 status 不合法：取值必须是 ${MEMORY_STATUSES.join(' / ')} 之一`, { field: 'status' });
      }
    }
    const scope = optionalText(query?.scope);
    if (scope && !isValidScope(scope)) {
      throw HttpError.badRequest('字段 scope 不合法：必须是 global / course:<课程 id> / module:<模块 id>', { field: 'scope' });
    }
    const key = optionalText(query?.key);
    // 查询参数**仍然严格** 400：写入降级（把中文 key 变成"无 key"）是为了不丢掉用户说的话，
    // 而查询是要"按这个键去找"。把查询键也降级，`?key=我的键` 会退化成"查全库"，
    // 调用方反而会以为"同键记忆存在" —— 查不到就如实查不到，比悄悄放宽好。
    if (key && !isValidKey(key)) {
      throw HttpError.badRequest('字段 key 不合法：只能是小写字母/数字/下划线且不超过 40 字符', { field: 'key' });
    }

    return memory.list({
      scope,
      kind,
      status,
      key,
      q: optionalText(query?.q),
      dueReview: optionalBool(query?.dueReview),
      limit: optionalInt(query?.limit, 'limit', { min: 1, max: MAX_LIST_LIMIT }) ?? DEFAULT_LIST_LIMIT,
      offset: optionalInt(query?.offset, 'offset', { min: 0, max: 100000 }) ?? 0,
    });
  });

  /**
   * 显式写入（用户明说「记住…」）：`source` 由服务层固定为 `user`，请求体里给别的值也没用。
   *
   * 状态码按 §10.5：新建 `201`；无 key 命中同文（幂等）返回 `200 + duplicated: true`；
   * 同 `scope + key` 已有 active 且没带 `replace` → `409`。
   *
   * `key` 不合法（中文 / 空格 / 超长 / 大写）**不再是 400**：服务层会降级它
   * （见 service.normalizeKey），并在响应里带上 `keyAdjusted: {from, to, reason}`。
   * 用户说过"记住"的事不能因为一个内部句柄的格式而记不下；但降级也绝不静默。
   */
  router.post(P, async ({ body }) => {
    const input = requireBody(body);
    const result = await memory.create(input);
    const adjusted = result.keyAdjusted ? { keyAdjusted: result.keyAdjusted } : {};
    if (result.duplicated) return { item: result.item, duplicated: true, writes: true, ...adjusted };
    return {
      __status: 201,
      item: result.item,
      replaced: result.replaced ?? null,
      writes: true,
      ...adjusted,
    };
  });

  /**
   * 提议（§10.5）：**AI 唯一被允许的写入口，且它不落库**。
   *
   * 返回 `{ draft, conflicts, writes: false }`；`draft` 的形状与 §4.2 的指令对象一致
   * （`target: "memory"`），前端直接复用草稿确认卡。被否否决过 / 已经记过时
   * `draft` 为 `null` + `suppressed` 说明原因，而不是再端一张重复的卡（§10.6）。
   */
  router.post(`${P}/propose`, ({ body }) => {
    const input = requireBody(body);
    const result = memory.propose(input);
    return { ...result, writes: false };
  });

  /**
   * 改正一条（§10.5）：`text / value / scope / kind / key / reviewAt / status`。
   *
   * **不是"记住"的入口**：这里改的是既有记忆，`source` / `confidence` / `supersededBy`
   * 由服务层按 §10.4 的迁移规则自己管，不接受直接改。
   *
   * `key` 与写入路径同口径（降级而不是 400），降级明细照样回报：只改一半就会出现
   * "预览说没问题、点确认才失败"的卡点，那正是要修的毛病。
   */
  router.patch(`${P}/:id`, async ({ params, body }) => {
    const patch = requireBody(body);
    const { keyAdjusted } = normalizeKey(patch.key);
    return { item: await memory.update(params.id, patch), ...(keyAdjusted ? { keyAdjusted } : {}) };
  });

  /** 删除（§10.5）：不可逆；同 key 允许重新提议。 */
  router.delete(`${P}/:id`, async ({ params }) => memory.remove(params.id));

  /**
   * 清空（§10.8，**额外的第 7 条**）：整体删除前先备份成 `memories.json.bak-<时间戳>`。
   * 与 `DELETE /memories/:id` 不是同一个路径（后者带 id），但都不可逆，所以都要求显式调用。
   */
  router.delete(P, async () => memory.clear());

  /**
   * 命中回报（§10.5）：`/ai/context` 会自动回报注入的那批，这里给前端"我用了这条"用。
   *
   * 计数只增不减（`useCount` 是后续淘汰的唯一依据），所以上限 100 次/请求防止误传天文数字。
   */
  router.post(`${P}/:id/use`, async ({ params, body }) => {
    const count = optionalInt(body?.count, 'count', { min: 1, max: 100 }) ?? 1;
    return { item: await memory.markUsed(params.id, { count }) };
  });
}
