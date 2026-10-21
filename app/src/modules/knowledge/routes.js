/**
 * 知识库（教务处政策语料）路由，全部挂在 `/api/v1/knowledge` 下。
 *
 * 这一层刻意很薄：检索口径、打分、片段截取都在 `KnowledgeService` 里，
 * 路由只做三件事 —— **参数校验**（把用户输入变成服务层认识的形状）、
 * **边界收敛**（limit / maxChars 夹紧，防止一条请求把十万字语料拖进内存或提示词）、
 * 以及**错误语义**（400 说清是哪个字段错了）。
 * 打分规则如果写在这里，做前端筛选或只读指令（commands.js）的人就得抄第二遍，迟早抄歪。
 *
 * 几条刻意的取舍：
 *
 * 1. **不提供抓取（联网）接口**。更新语料是"用户显式跑 `node scripts/crawl-dean.js`"的动作，
 *    服务端不代替用户发网络请求 —— 让一个本地后端在用户没点过的情况下访问教务处，
 *    既是权限越界，也让"语料是哪来的"变得不可追溯（索引里的 generatedAt/source 会失真）。
 *    所以这里只有读与"重新读一遍磁盘上的索引"。
 *
 * 2. **语料缺失照常返回，不抛 501/500**。`knowledge/` 可能还没抓过、索引可能损坏，
 *    这时 `stats()` 给 `available: false` + `reason`，检索给 0 条结果。
 *    把它做成 5xx 会让前端只能显示"服务出错了"，而真实情况是"你还没跑抓取脚本"——
 *    这是两种完全不同的排查方向（见 §14.3 的降级要求）。
 *
 * 3. **响应里不再手写 `{ ok: true }`**。router 统一把处理器返回值展开成 `{ ok: true, ...result }`
 *    （core/http/router.js 的 `sendJson(res, status, { ok: true, ...payload }, req)`），
 *    这里再写一遍只会让"同一份数据的 ok 出现在哪"有两个来源。HTTP 上看到的仍是
 *    `{ ok: true, available: … }`，与其它模块一致。
 */

import { HttpError } from '../../core/http/router.js';
import { DEFAULT_DOC_MAX_CHARS } from './service.js';

/** 检索条数上限：6 条 × 约 800 字片段 ≈ 4.8k 字，再多会把对话里的其余上下文挤掉（与 module.js 的 aiQueryLimits 同口径）。 */
const MAX_LIMIT = 10;
const DEFAULT_LIMIT = 5;

/** 单篇返回的字数区间：低于 500 读不出条款，高于 20000 会把"只给片段"的设计撑破。 */
const MIN_MAX_CHARS = 500;
const MAX_MAX_CHARS = 20000;

/**
 * 必填文本：缺失、非字符串、全空白都算"没给"。
 *
 * 为什么不直接 `!query.q` 了事：`?q=%20%20` 这种"看起来给了、其实是空白"的查询会被
 * 当成合法关键词往下传，最后返回 0 条 —— 用户以为是"语料里没有这条政策"，
 * 而真实原因是查询词是空白。这两种结论差得很远，所以空白一律 400。
 */
function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw HttpError.badRequest(`字段 ${field} 必填`, { field });
  }
  return value.trim();
}

/** 可选文本：空串一律当"没传"，避免 `?category=` 把结果过滤成空。 */
function optionalText(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
}

/** 可选条数：非数字/缺省回落默认值，再夹进 [1, MAX_LIMIT]。 */
function normalizeLimit(value) {
  const size = Number(value);
  const base = Number.isFinite(size) && size > 0 ? Math.floor(size) : DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, base));
}

/** 可选字数：缺省返回 undefined，交给服务用自己的默认值；显式传时夹在 [500, 20000]。 */
function normalizeMaxChars(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const size = Number(value);
  if (!Number.isFinite(size)) return undefined;
  return Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, Math.floor(size)));
}

/** 可选续读位置：负值/非数字按 0 处理（等价于从头读），避免一个拼错的参数把整篇读空。 */
function normalizeOffset(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const offset = Number(value);
  if (!Number.isFinite(offset)) return undefined;
  return Math.max(0, Math.floor(offset));
}

/**
 * 注册知识库路由。
 *
 * @param {object} router createRouter() 的实例（get/post 的签名见 core/http/router.js）
 * @param {object} ctx    模块上下文：`services.knowledge` 是 KnowledgeService，
 *                        `apiPrefix` 由 server 注入（形如 `/api/v1`，与 §14.3 的路径拼出完整地址）
 */
export function registerKnowledgeRoutes(router, { services, apiPrefix = '/api/v1' }) {
  const P = `${apiPrefix}/knowledge`;
  const knowledge = services.knowledge;

  // 与 lms/academic/notes 的 `if (!lms) return;` 同一习惯：服务没装配好时宁可不注册，
  // 也不要让每个请求在运行期炸一个 "Cannot read properties of undefined"。
  if (!knowledge) return;

  /**
   * 语料概览：栏目、篇数、字数、来源与生成时间，加上 `available` / `reason`。
   * 设置页的「知识库」卡片直接用它；语料没抓过时也是 200 + `available: false`。
   */
  router.get(`${P}/stats`, () => knowledge.stats());

  /**
   * 关键词检索。
   *
   * 只接受 GET：检索是幂等的只读动作，带 query 参数更容易被前端缓存/重放，
   * 也让"Agent 只能用只读工具取语料"这条边界在 HTTP 层就成立。
   * 返回 `{ q, count, items: [{ title, url, path, category, …, score, snippet, matches }] }`——
   * 每条都带 `url`，因为回答引用校规必须给得出出处（§14.4）。
   */
  router.get(`${P}/search`, ({ query }) => {
    const q = requireText(query?.q, 'q');
    return knowledge.search({
      q,
      category: optionalText(query?.category),
      // 精确到章 / 条：`?q=退学&section=第六章 退学警告与退学` 只在这一节里找
      section: optionalText(query?.section),
      limit: normalizeLimit(query?.limit),
    });
  });

  /**
   * 读某一篇（正文窗口默认 8000 字，带 offset / nextOffset / truncated）。
   *
   * `offset` 是续读入口：模型 / Agent 从上一轮结果里拿 `nextOffset`，下一次直接传回来。
   * 没有它时，8213 字的《学籍规定》永远只能读到前 8000 字，第六章仍在窗口外。
   *
   * `path` 必填，且**越界一律 400**：`..`、绝对路径、站外路径都由服务层的
   * "必须落在 knowledge/ 目录内"判定挡掉（§14.3）；这里只负责"没给 path"这一种 400，
   * 路径安全的判断留给唯一持有语料根目录的服务层，避免两处规则各写一套、哪天放宽了其中一处。
   */
  router.get(`${P}/doc`, ({ query }) => {
    const docPath = requireText(query?.path, 'path');
    const maxChars = normalizeMaxChars(query?.maxChars);
    const offset = normalizeOffset(query?.offset);
    return knowledge.read({
      path: docPath,
      // HTTP 契约保持 8000 字：这里显式给，服务层默认值（4000）服务于"对话续读窗口"
      maxChars: maxChars ?? DEFAULT_DOC_MAX_CHARS,
      ...(offset === undefined ? {} : { offset }),
    });
  });

  /**
   * 重新读 `index.json`。
   *
   * 用 POST 而不是 GET：它会重新解析索引与文件哈希，语义上不是"取一份数据"，
   * 而是"让服务重新读一遍磁盘"。用 GET 的话浏览器/中间的预取逻辑可能顺手就打一次，
   * 抓完语料后这个动作应该是**用户点一下**才发生的。
   *
   * 名字叫 reload 而不是 refresh：refresh 在本仓库另有含义（lms/academic 的 refresh
   * 表示"去上游重新拉数据"，会联网）。这里**只重读本地文件、一个网络包都不发**，
   * 换个词是为了不让人误以为它会把语料更新到最新 —— 更新语料只能跑抓取脚本。
   */
  router.post(`${P}/reload`, async () => {
    await knowledge.reload();
    // 重新读一遍后再报 stats：调用方最想知道的就是"重读之后还剩多少篇"
    return knowledge.stats();
  });

  /** 一致性自检：索引里的每一项是否都在磁盘上且哈希对得上（与 `crawl-dean.js --check` 同一套判据）。 */
  router.get(`${P}/check`, () => knowledge.check());
}
