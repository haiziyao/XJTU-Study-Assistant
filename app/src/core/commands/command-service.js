/**
 * 指令服务（框架级）：把「指令对象」分发到各模块注册的处理器，并记录指令日志。
 *
 * 指令对象既可以来自本地规则解析器（各模块通过 `registerParser` 提供），也可以来自
 * 未来的 AI provider，两者结构一致，因此这里不需要关心来源。
 *
 * 两个注册表让本文件完全不认识具体业务：
 *
 *   registerParser(id, parser)        各模块贡献自己的自然语言解析器
 *   registerHandler(target, handler)  各模块贡献自己 target 的读写实现
 *
 * 命令处理器契约
 * --------------
 *   键 = action 名（`create` / `query` / `update` / `delete` / `complete` / `rollover` / 自定义）
 *   值 = `(draft, options) => Promise<object> | object`
 *   返回对象会与 `{ ok, action, target, explain, confidence, warnings }` 合并后交给调用方。
 *   约定：`options.dryRun === true` 时只返回预览，不写库。
 */

import { HttpError } from '../http/router.js';

export class CommandService {
  constructor({ store } = {}) {
    this.store = store;
    /** @type {Map<string, {parse: Function}>} 自然语言解析器，按注册顺序尝试 */
    this.parsers = new Map();
    /** @type {Map<string, object>} target -> 处理器 */
    this.handlers = new Map();
  }

  // ---------------------------------------------------------------- 注册表

  /**
   * 注册一个自然语言解析器。
   * @param {string} id 模块 id（用于标记 draft.parser）
   * @param {{parse: (text: string, options?: object) => object}} parser
   */
  registerParser(id, parser) {
    if (typeof id !== 'string' || !id) throw new Error('解析器 id 必填');
    if (typeof parser?.parse !== 'function') throw new Error(`解析器 ${id} 必须实现 parse(text, options)`);
    if (this.parsers.has(id)) throw new Error(`解析器已注册: ${id}`);
    this.parsers.set(id, parser);
    return this;
  }

  /**
   * 注册某个 target 的指令处理器。
   * @param {string} target 指令对象的 target，例如 `schedule` / `lmsTask`
   * @param {object} handler 形如 `{ create, query, update, delete, complete }`
   */
  registerHandler(target, handler) {
    if (typeof target !== 'string' || !target) throw new Error('指令 target 必填');
    if (!handler || typeof handler !== 'object') throw new Error(`target ${target} 的处理器必须是对象`);
    if (this.handlers.has(target)) throw new Error(`指令 target 已注册: ${target}`);
    this.handlers.set(target, handler);
    return this;
  }

  /** 已注册的 target 列表，供自描述与错误提示使用。 */
  get targets() {
    return [...this.handlers.keys()];
  }

  // ---------------------------------------------------------------- 解析

  /**
   * 依次尝试各模块注册的解析器，返回第一个解析成功的指令对象。
   * **不抛异常**：全部失败时返回 `{ ok: false, warnings }`，供 AI 降级路径使用。
   */
  tryParse(text, options = {}) {
    let fallback;
    for (const [id, parser] of this.parsers) {
      let draft;
      try {
        draft = parser.parse(text, options);
      } catch (error) {
        draft = { ok: false, raw: text, warnings: [error.message] };
      }
      if (draft?.ok) return { parser: id, ...draft };
      fallback ??= draft;
    }
    return (
      fallback ?? {
        ok: false,
        raw: text,
        warnings: ['没有可用的指令解析器（模块需要用 services.commands.registerParser 注册）'],
      }
    );
  }

  /** 只解析，不写库；解析失败抛 422。 */
  parse(text, options = {}) {
    const draft = this.tryParse(text, options);
    if (!draft.ok) throw new HttpError(422, 'PARSE_FAILED', draft.warnings?.[0] ?? '无法解析该指令', draft);
    return draft;
  }

  /** 解析并执行。 */
  async run(text, options = {}) {
    const draft = this.parse(text, options);
    const result = await this.execute(draft, options);
    return { draft, ...result };
  }

  /**
   * 解析并逐条执行「多行标记」文本。
   *
   * 解析函数由调用方注入（例如日历模块的 dschat 标记行解析器），因此框架不依赖任何具体格式。
   * 单条失败不影响其它条目，结果按行返回，便于前端逐条反馈。
   *
   * @param {string} text 原始多行文本
   * @param {(text: string) => { drafts: object[], unparsed: string[] }} parse 解析函数
   * @param {{ dryRun?: boolean }} [options]
   */
  async runBatch(text, parse, options = {}) {
    const { drafts, unparsed } = parse(text);
    const results = [];
    for (const draft of drafts) {
      if (!draft.ok) {
        results.push({ draft, ok: false, error: { code: 'PARSE_FAILED', message: draft.warnings?.[0] ?? '标记行不完整' } });
        continue;
      }
      try {
        results.push({ draft, ...(await this.execute(draft, options)) });
      } catch (error) {
        results.push({ draft, ok: false, error: { code: error.code ?? 'INTERNAL', message: error.message } });
      }
    }
    return {
      drafts,
      results,
      unparsed,
      succeeded: results.filter((item) => item.ok !== false).length,
      failed: results.filter((item) => item.ok === false).length,
    };
  }

  // ---------------------------------------------------------------- 执行

  /**
   * 执行指令对象：按 target 找到模块注册的处理器，再按 action 找方法。
   * @param {object} draft 指令对象（来自解析器或 AI）
   * @param {object} [options]
   * @param {boolean} [options.dryRun] 只返回将执行的动作，不写库
   */
  async execute(draft, options = {}) {
    if (!draft?.ok) throw HttpError.badRequest('指令对象无效（ok !== true）');
    const { action, target } = draft;

    const handler = this.handlers.get(target);
    if (!handler) {
      throw HttpError.badRequest(`不支持的 target: ${target}（已注册：${this.targets.join(' / ') || '无'}）`);
    }
    const run = handler[action];
    if (typeof run !== 'function') {
      throw HttpError.badRequest(
        `target ${target} 不支持 action: ${action}（可用：${Object.keys(handler).join(' / ')}）`,
      );
    }

    const result = (await run.call(handler, draft, options)) ?? {};
    const payload = {
      ok: true,
      action,
      target,
      explain: draft.explain ?? null,
      confidence: draft.confidence ?? null,
      warnings: draft.warnings ?? [],
      ...result,
    };
    if (!options.dryRun) await this.#log(draft, payload);
    return payload;
  }

  async #log(draft, payload) {
    if (!this.store) return;
    try {
      await this.store.commandLogs.insert({
        text: draft.raw ?? '',
        action: draft.action,
        target: draft.target,
        confidence: draft.confidence ?? null,
        ok: payload.ok !== false,
        affectedCount: payload.affected?.length ?? payload.count ?? 0,
        source: draft.provider ?? 'rules',
      });
    } catch (error) {
      console.error('[command] 写入指令日志失败:', error.message);
    }
  }
}
