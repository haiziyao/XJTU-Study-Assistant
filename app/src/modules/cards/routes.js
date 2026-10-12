/**
 * 复习卡片路由：全部挂在 `/api/v1/cards` 下。
 *
 * 这一层刻意很薄：排期、去重、幂等、统计口径都在 `CardService` 与 `scheduler.js` 里。
 * 路由只做三件事 —— **参数校验**（把 HTTP 的字符串查询参数变成服务层认识的类型）、
 * **边界收敛**（limit/offset 夹紧，防止一次请求把整库拖出来）、**错误语义**
 * （400 说清是哪个字段错了；404 说清哪张卡不存在）。规则写两份，迟早有一份先过期。
 *
 * 几条刻意的约定：
 *
 * 1. **`GET /cards/due` 与 `GET /cards?due=1` 返回同一个信封**（`{ count, counts, items, filters }`）。
 *    它是给"定时唤醒"用的快捷方式：任务提示词里写 `GET /cards/due?limit=5` 比让模型
 *    自己拼 `?due=1&limit=5&suspended=false` 可靠得多。两处口径必须一致，所以这里
 *    只是把 `due: true` 传下去，不另写一套过滤。
 *
 * 2. **状态码**：新建 `201`；改/删/复习 `200`；非法 grade / 非法字段 `400`；不存在 `404`。
 *    复习不是"新建一次复习记录"（没有复习记录这个集合），所以它不返回 201。
 *
 * 3. **`POST /cards/generate` 不是"批量写"接口**：它按 `noteId + 正面` 幂等，
 *    重复调用返回 `created: 0, skipped: N` —— 用户点了两次「生成」不该得到两套卡。
 *
 * 4. 校验仍以服务层为准（`CardService` 与指令处理器是两条入口，规则只写一份）；
 *    这里只负责把明显不合法的查询参数挡在 400，而不是让它悄悄变成别的查询。
 */

import { HttpError } from '../../core/http/router.js';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, STATS_DAYS } from './service.js';
import { GRADES } from './scheduler.js';

/** 可选文本：空串当"没传"，避免 `?course=` 把结果过滤成空。 */
const optionalText = (value) => {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
};

/**
 * 可选布尔：只认显式的真值写法（`?due=1|true|yes`）。
 *
 * 返回 `undefined`（没传）与 `false`（显式写了 0/不）语义不同：前者是"不筛"，
 * 后者是"只看不满足的"。所以不能用 `Boolean(query.due)` 一把梭。
 */
function optionalBool(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  throw HttpError.badRequest(`布尔参数不合法：${JSON.stringify(value)}（可用 1/0、true/false）`);
}

/**
 * 可选整数：**给了就必须是合法整数**。
 *
 * 与知识库的"非法值静默回落默认值"不同：这里的分页参数错了要 400 —— `?limit=abc`
 * 静默变成 50 会让前端以为"一共就这么多"，宁可报错。
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
 * 注册卡片路由。
 *
 * @param {object} router createRouter() 的实例（见 core/http/router.js）
 * @param {object} ctx    模块上下文：`services.cards` 是 CardService，
 *                        `apiPrefix` 由 server 注入（形如 `/api/v1`）
 */
export function registerCardRoutes(router, { services, apiPrefix = '/api/v1' }) {
  const P = `${apiPrefix}/cards`;
  const cards = services.cards;

  // 与 memory / lms / notes 的 `if (!xxx) return;` 同一习惯：服务没装配好时宁可不注册，
  // 也不要让每个请求在运行期炸一个 "Cannot read properties of undefined"
  if (!cards) return;

  /**
   * 列表 / 检索：`?due=1&course=&tag=&noteId=&suspended=&q=&limit=&offset=`。
   *
   * `counts` 不受筛选影响（界面顶部统计），`count` 是筛选后的条数 —— 两者的区别
   * 写在 `CardService.list()` 的注释里，这里不重复实现。
   */
  router.get(P, ({ query }) =>
    cards.list({
      due: optionalBool(query?.due),
      course: optionalText(query?.course),
      tag: optionalText(query?.tag),
      noteId: optionalText(query?.noteId),
      suspended: optionalBool(query?.suspended),
      q: optionalText(query?.q),
      limit: optionalInt(query?.limit, 'limit', { min: 1, max: MAX_LIST_LIMIT }) ?? DEFAULT_LIST_LIMIT,
      offset: optionalInt(query?.offset, 'offset', { min: 0, max: 100000 }) ?? 0,
    }),
  );

  /** 统计（界面顶部与「未来 7 天」曲线）：`byDay` 固定返回 7 格（含今天）。 */
  router.get(`${P}/stats`, () => ({ days: STATS_DAYS, ...cards.stats() }));

  /**
   * 到期队列的快捷方式（等价于 `?due=1`，给定时唤醒直接用）。
   * 同样返回 `counts`：唤醒提示词里"今天一共 12 张、这是前 5 张"比只给 5 张更有用。
   */
  router.get(`${P}/due`, ({ query }) =>
    cards.list({
      due: true,
      course: optionalText(query?.course),
      limit: optionalInt(query?.limit, 'limit', { min: 1, max: MAX_LIST_LIMIT }) ?? DEFAULT_LIST_LIMIT,
      offset: optionalInt(query?.offset, 'offset', { min: 0, max: 100000 }) ?? 0,
    }),
  );

  /**
   * 取一张卡：`{ item }`，不存在 `404`。
   *
   * **必须注册在 `/cards/stats` 与 `/cards/due` 之后**：路由按注册顺序取第一个匹配，
   * `:id` 能匹配任何一段路径，放前面会把那两个接口吞掉。
   * 需要它是因为列表是分页的（`limit` 上限 500）—— 不在已加载那一页里的卡片
   * 仍要能被按 id 打开（详情/编辑），而不是先翻遍列表。
   */
  router.get(`${P}/:id`, ({ params }) => ({ item: cards.get(params.id) }));

  /** 手工加卡：`201`。调度状态（due/interval/ease…）不接受传入，由服务层从零开始排。 */
  router.post(P, async ({ body }) => {
    const input = requireBody(body);
    const item = await cards.create(input);
    return { __status: 201, item, writes: true };
  });

  /**
   * 从笔记生成（规则化、幂等）。
   *
   * 200 而不是 201：这次调用可能一张都没新建（重复生成），用 201 会让调用方以为
   * "又建了一批"。真正的结果看 `created`。
   */
  router.post(`${P}/generate`, async ({ body }) => cards.generate(requireBody(body)));

  /**
   * 改正面 / 答案 / 标签 / 课程 / 暂停。
   * 调度字段与 `source` 不接受修改（服务层会忽略并在无字段可改时 400）。
   */
  router.patch(`${P}/:id`, async ({ params, body }) => ({ item: await cards.update(params.id, requireBody(body)) }));

  /** 删除（不可逆；没有回收站 —— 重建一张卡的代价远小于多一套状态）。 */
  router.delete(`${P}/:id`, async ({ params }) => cards.remove(params.id));

  /**
   * 记录一次复习：`{ grade }` ∈ again / hard / good / easy。
   *
   * 非法 grade 在这里就 400（带可选值列表），而不是让 `computeNext` 抛 TypeError 变成 500；
   * 服务层还有一道同样的校验，用于指令与内部调用。
   */
  router.post(`${P}/:id/review`, async ({ params, body }) => {
    const input = requireBody(body);
    const grade = typeof input.grade === 'string' ? input.grade.trim() : input.grade;
    if (!GRADES.includes(grade)) {
      throw HttpError.badRequest(`字段 grade 不合法：取值必须是 ${GRADES.join(' / ')} 之一`, {
        field: 'grade',
        allowed: [...GRADES],
      });
    }
    return cards.review(params.id, grade);
  });
}
