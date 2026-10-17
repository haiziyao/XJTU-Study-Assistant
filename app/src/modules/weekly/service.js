/**
 * 学习周报服务：**统计（不依赖模型）** + **简报生成（可选依赖模型）**。
 *
 * 依赖与顺序
 * ----------
 * - `order = 48`：排在 notes(40) / memory(45) 之后，`ai`(90) 之前 —— 与 `memory` 同一段位。
 * - **不依赖任何模块的服务**：统计数据全部来自各模块**已落库的集合**（只读，契约允许）；
  只有学分绩会问一下 `services.academic.stats()`，取不到就给 null + `missing`。
 * - `ai` 是**惰性依赖**：`createServices` 拿到的 `services` 是**共享注册表**，后装配的模块
 *   （ai 的 order=90）会把服务合并进同一个对象，所以 `this.services.ai` 在**请求时**读得到，
 *   而在 `createServices` 里立刻取只会拿到 undefined。这正是"不把自己排在 ai 后面"的原因：
 *   周报的统计与接口必须在没有 AI 时也完全可用。
 *
 * 两条路径的边界（这是本模块的核心设计）
 * ------------------------------------
 *   1. `stats({ from, to })` —— **纯统计**，永远可用、永远不花钱：只读集合，不调模型、不写库。
 *      来源固定为 AI 对话 / 笔记 / 待办 / 成绩四项（见 sources.js）。
 *      读不到的来源给 null + `missing`（见 sources.js），接口不因此失败。
 *   2. `generate({ from, to, force })` —— 生成简报：把 stats 交给模型写一段中文简报。
 *      模型不可用/调用失败 → **降级**成规则小结，`ok` 仍是 true、`fallback: true` 并带 `reason`。
 *      "没写成文章"不是错误状态，是这条路径的正常分支。
 *
 * 缓存口径：一周一条（`from` 即周区间起点，也是落库的键），`force` 不为真时命中缓存直接返回，
 * **不重复花 token**。降级结果同样进缓存（否则每次打开都会重试模型、白烧 token），
 * 想重写就带 `force: true`。
 */

import { HttpError } from '../../core/http/router.js';
import { isDateKey, todayKey, weekRange } from '../../shared/time.js';
import { REPORT_MAX_CHARS, buildDigest, fallbackReport, weeklyRequest } from './report.js';
import { SOURCE_KEYS, collectStats } from './sources.js';

/** 历史列表默认/上限条数（一周一条，200 条够看四年）。 */
export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 200;

/** 模型温度：写简报不是创作，0.3 足够把数字讲顺，又不至于开始加形容词。 */
export const DEFAULT_TEMPERATURE = 0.3;

/** 本地零点 / 本地当天最后一毫秒：区间是**闭区间**，按本地日界切。 */
const startOfDay = (dateKey) => new Date(`${dateKey}T00:00:00.000`).getTime();
const endOfDay = (dateKey) => new Date(`${dateKey}T23:59:59.999`).getTime();

/** 同一天 = 0，次日 = 1（用于天数与"7 天内"）。 */
export const daysBetween = (from, to) => Math.round((startOfDay(to) - startOfDay(from)) / 86400000);

/**
 * ISO 8601 周标签（`2026-W02`）：**用所在周的周四**决定属于哪一年的第几周，
 * 这样跨年那一周不会出现"12-29 属于明年 W01"的自相矛盾写法（这也是 `from` 键的人话形式）。
 */
export function isoWeekLabel(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7; // 1=周一 … 7=周日
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** 日期参数校验：非法格式 / 不存在的日期（2026-02-30）都当场 400，并指出是哪个字段。 */
function validDate(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (!isDateKey(text)) {
    throw HttpError.badRequest(`字段 ${field} 不合法：必须是 YYYY-MM-DD 格式的真实日期`, { field, value: String(value) });
  }
  return text;
}

/** 结构相同即视为同一份统计（两个对象都由本模块同一段代码生成，键顺序稳定，比较序列化结果足够）。 */
const sameStats = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export class WeeklyService {
  /**
   * @param {object} input
   * @param {object} input.store    JsonStore
   * @param {Function} [input.broadcast]
   * @param {object} input.services **共享注册表**（惰性读 `services.ai`）
   * @param {object} [input.options] `createServer({ weekly: { now, temperature } })` 的配置切片
   */
  constructor({ store, broadcast = () => {}, services, options = {} }) {
    this.store = store;
    this.broadcast = broadcast;
    this.services = services;
    this.options = options ?? {};
  }

  /** 可注入时钟（测试周区间边界时不必改系统时间）。 */
  #now() {
    const source = this.options.now;
    if (typeof source === 'function') return new Date(source());
    if (source instanceof Date) return new Date(source);
    if (source) {
      const parsed = new Date(source);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return new Date();
  }

  // ---------------------------------------------------------------- 区间

  /**
   * 把请求参数规范化成一个**闭区间**。
   *
   * - 都不给 → 今天所在的**自然周**（周一 ~ 周日，本地时区）；
   * - 只给一端 → 那一天所在的自然周（"给我 1 月 7 号那一周"，不必自己算周一）；
   * - 两端都给 → 原样采用（允许自定义区间：月度复盘、假期两周都走得通）；
   * - 非法日期 / `to < from` → 400（错误信息里给出字段名与两个值）。
   */
  resolveRange(input = {}) {
    const from = validDate(input?.from, 'from');
    const to = validDate(input?.to, 'to');
    const today = todayKey(this.#now());

    if (!from && !to) {
      const week = weekRange(today, 1);
      return this.#rangeOf(week.start, week.end);
    }
    if (from && to) {
      if (to < from) throw HttpError.badRequest(`字段 to 不能早于 from：${from} ~ ${to}`, { field: 'to', from, to });
      return this.#rangeOf(from, to);
    }
    const week = weekRange(from ?? to, 1);
    return this.#rangeOf(week.start, week.end);
  }

  #rangeOf(from, to) {
    const now = this.#now();
    return {
      from,
      to,
      fromMs: startOfDay(from),
      toMs: endOfDay(to),
      days: daysBetween(from, to) + 1,
      week: isoWeekLabel(from),
      /** 逾期/临近的基准日：按"统计时刻的今天"，而不是区间末尾（见 sources.js 的说明）。 */
      today: todayKey(now),
    };
  }

  // ---------------------------------------------------------------- 统计

  /**
   * 区间统计（**不依赖模型，必须永远可用**）。
   *
   * @param {{ from?: string, to?: string }} [input]
   * @returns {{ from, to, week, days, partial, missing, conversations, notes, schedule, grades }}
   */
  stats(input = {}) {
    return this.#collect(this.resolveRange(input));
  }

  #collect(range) {
    const collected = collectStats({ store: this.store, services: this.services, range, today: range.today });
    const stats = { from: range.from, to: range.to, week: range.week, days: range.days };
    for (const key of SOURCE_KEYS) stats[key] = collected[key];
    stats.partial = collected.missing.length > 0;
    stats.missing = collected.missing;
    return stats;
  }

  // ---------------------------------------------------------------- 读

  /** 一周一条：`from` 是键；`to` 一起比对，避免自定义区间与自然周互相顶掉同一条报告。 */
  #findByWindow(range) {
    return this.store.weeklyReports.all().find((item) => item.from === range.from && item.to === range.to) ?? null;
  }

  /** 按 id 取一条（commands 的定位用）；不存在就 404，不猜。 */
  get(id) {
    const item = this.store.weeklyReports.get(String(id));
    if (!item) throw HttpError.notFound(`周报不存在：${id}`, { field: 'id' });
    return item;
  }

  /**
   * 读某一周的周报：**有缓存给缓存，没有就只给 stats + `report: null` + `hint`**。
   *
   * `stats` 永远**现算**（这才是"数据统计必须永远可用"的落点），因此缓存里的正文与
   * 刚算出来的数字可能不一致 —— 用 `statsChangedSinceReport` 如实标出来，而不是拿旧数字糊弄。
   * 这个接口**永远不会调用模型**（GET 不该有副作用、更不该花钱）。
   */
  getReport(input = {}) {
    const range = this.resolveRange(input);
    const stats = this.#collect(range);
    const base = { from: range.from, to: range.to, week: range.week, days: range.days, stats };
    const stored = this.#findByWindow(range);

    if (!stored) {
      return {
        ...base,
        cached: false,
        id: null,
        report: null,
        generatedAt: null,
        model: null,
        fallback: null,
        reason: null,
        statsChangedSinceReport: null,
        hint: '这一周还没有生成周报：POST /weekly/report/generate 会让模型写一段简报（未配置 AI 时降级为规则小结）。GET 不会偷偷调用模型。',
      };
    }

    return {
      ...base,
      cached: true,
      id: stored.id,
      report: stored.report,
      generatedAt: stored.generatedAt ?? null,
      model: stored.model ?? null,
      fallback: Boolean(stored.fallback),
      reason: stored.reason ?? null,
      statsChangedSinceReport: !sameStats(stored.stats, stats),
      hint: 'report 是生成当时的正文，stats 是刚刚现算的；statsChangedSinceReport 为 true 说明这周的数据又变了，可用 force 重新生成。',
    };
  }

  /** 历史周报列表：按周倒序（`from` 倒序即时间倒序，日期键可直接比大小）。 */
  list({ limit = DEFAULT_LIST_LIMIT } = {}) {
    const all = this.store.weeklyReports.all();
    const items = [...all]
      .sort((a, b) => String(b.from ?? '').localeCompare(String(a.from ?? '')) || String(b.generatedAt ?? '').localeCompare(String(a.generatedAt ?? '')))
      .slice(0, Math.max(0, Number(limit) || 0));
    return { items, count: items.length, total: all.length };
  }

  // ---------------------------------------------------------------- 生成

  /**
   * 生成（或命中缓存、或用 `force` 重写）某一周的简报。
   *
   * 落库字段：`{ id, from, to, week, stats, report, generatedAt, model, fallback, reason, reportTruncated }`。
   * 同一周二次生成**原地更新**同一条（保留 id），保证"一周一条"，列表不会越用越长。
   *
   * @param {{ from?: string, to?: string, force?: boolean }} [input]
   */
  async generate(input = {}) {
    const force = input?.force === true;
    const range = this.resolveRange(input);
    const existing = this.#findByWindow(range);

    if (existing && !force) {
      // 命中缓存：连 stats 都不重算（想看最新数字用 GET /weekly/report，它每次都现算并给差异标记）
      return { ok: true, cached: true, ...existing };
    }

    const stats = this.#collect(range);
    const request = weeklyRequest({ stats, temperature: this.options.temperature ?? DEFAULT_TEMPERATURE });

    let text = null;
    let model = null;
    let reason = null;
    // ★ 惰性取：ai 模块 order=90，比本模块晚装配；装配好的那一刻起这个引用就一直有效
    const ai = this.services?.ai;
    if (typeof ai?.complete === 'function') {
      try {
        const result = await ai.complete({
          system: request.system,
          user: request.user,
          temperature: request.temperature,
          // 写 400 字简报不需要思考链：开了只是多烧 token（complete 的 thinking 档位见 ai/chat-service.js）
          thinking: request.thinking,
        });
        text = String(result?.text ?? '').trim() || null;
        model = result?.model ?? null;
        if (!text) reason = '模型返回了空内容';
      } catch (error) {
        // 未配置密钥是 501、上游故障是 502：两种都走同一条降级路径，报告生成失败不是接口错误
        reason = error?.message ?? String(error);
      }
    } else {
      reason = 'AI 模块未装配或没有 complete()（未配置密钥时不提供该能力）';
    }

    const truncated = Boolean(text) && text.length > REPORT_MAX_CHARS;
    if (truncated) text = text.slice(0, REPORT_MAX_CHARS);
    const fallback = !text;
    if (fallback) text = fallbackReport(stats);

    const record = {
      from: range.from,
      to: range.to,
      week: range.week,
      stats,
      report: text,
      generatedAt: new Date().toISOString(),
      // 降级时 model 为 null：这段字不是任何模型写的，留着上一次的模型名会误导
      model: fallback ? null : model,
      fallback,
      reason,
      reportTruncated: truncated,
    };

    const item = existing
      ? await this.store.weeklyReports.update(existing.id, record)
      : await this.store.weeklyReports.insert(record);
    this.broadcast({
      type: 'data_changed',
      payload: { module: 'weekly', target: 'weeklyReport', action: existing ? 'update' : 'create', id: item.id, week: item.week },
    });
    return { ok: true, cached: false, ...item };
  }

  /** 删除一条历史周报（不可逆）。 */
  async remove(id) {
    const current = this.get(id);
    await this.store.weeklyReports.remove(current.id);
    this.broadcast({
      type: 'data_changed',
      payload: { module: 'weekly', target: 'weeklyReport', action: 'delete', id: current.id },
    });
    return { deleted: true, id: current.id };
  }

  /** 给 commands / tools 用的摘要（不含报告正文，避免把几百字塞进查询回灌）。 */
  digestOf(stats) {
    return buildDigest(stats);
  }
}
