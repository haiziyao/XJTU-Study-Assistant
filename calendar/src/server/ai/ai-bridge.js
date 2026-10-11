/**
 * AI 接入层（本阶段只留接口，不实现任何模型调用）。
 *
 * 设计目标：主程序（AI 智学）后续接入大模型时，只需注册一个 provider，
 * 无需改动路由与业务服务。约定如下：
 *
 *   1. 输入：用户自然语言文本 + 最小上下文（当前时间、所在视图、近期数据摘要）。
 *   2. 输出：**指令对象**（与 /commands/parse 的返回结构一致），而不是直接写库。
 *      这样 AI 只负责「理解」，落库仍走规则校验与业务服务，避免模型产出脏数据。
 *   3. 前端拿到指令对象后，可先展示确认卡片，再调用 /commands/execute 落库。
 *
 * 未注册 provider 时：/ai/nl2command 返回 501，并在 details 中给出完整契约；
 * 若请求显式声明 `fallback: "rules"`，则降级到本地规则解析器（标记 provider = rules）。
 */

import { AI_FEATURES, ERROR_CODES } from '../../shared/constants.js';
import { HttpError } from '../http/router.js';

/** 协议版本：未来契约变更时递增，便于主程序兼容。 */
export const AI_CONTRACT_VERSION = '1.0.0';

/**
 * 指令对象契约（AI provider 必须返回该结构）：
 * @typedef {object} AiCommandDraft
 * @property {boolean} ok                   是否解析成功
 * @property {'create'|'query'|'update'|'delete'|'complete'} action 操作类型
 * @property {'event'|'schedule'} target    作用对象（日历事件 / 日程）
 * @property {object} [fields]              写操作字段，见 接口文档.md
 * @property {object} [filters]             查询/删除条件
 * @property {number} [confidence]          0~1 置信度
 * @property {string[]} [warnings]          需要用户确认的疑点
 * @property {string} [explain]             给用户看的一句话解释
 */

export class AiBridge {
  constructor({ parser }) {
    this.parser = parser;
    /** @type {{name: string, nlToCommand: Function}|undefined} */
    this.provider = undefined;
  }

  /** 注册 AI provider；由未来的 AI 模块调用。 */
  registerProvider(provider) {
    if (!provider?.name || typeof provider.nlToCommand !== 'function') {
      throw new Error('AI provider 必须实现 { name, nlToCommand(text, context) }');
    }
    this.provider = provider;
    return this;
  }

  unregisterProvider() {
    this.provider = undefined;
  }

  get available() {
    return Boolean(this.provider);
  }

  /** 能力声明，供主程序探测。 */
  capabilities() {
    return {
      contractVersion: AI_CONTRACT_VERSION,
      available: this.available,
      provider: this.provider?.name ?? null,
      features: Object.values(AI_FEATURES).map((feature) => ({
        feature,
        enabled: feature === AI_FEATURES.COMMAND_EXPLAIN ? true : this.available,
        note:
          feature === AI_FEATURES.COMMAND_EXPLAIN
            ? '当前由本地规则解析器提供，无需模型'
            : '等待 AI 模块注册 provider',
      })),
      endpoints: {
        nl2command: 'POST /api/v1/ai/nl2command',
        capabilities: 'GET /api/v1/ai/capabilities',
      },
    };
  }

  /** 供路由调用的统一入口。 */
  async nlToCommand({ text, context, fallback }) {
    if (typeof text !== 'string' || !text.trim()) {
      throw HttpError.badRequest('text 不能为空');
    }
    if (this.provider) {
      const draft = await this.provider.nlToCommand(text, context ?? {});
      return { ...draft, provider: this.provider.name };
    }
    if (fallback === 'rules') {
      const parsed = this.parser.parse(text, { context });
      return { ...parsed, provider: 'rules', degraded: true };
    }
    throw new HttpError(501, ERROR_CODES.AI_UNAVAILABLE, 'AI 能力尚未接入', {
      contractVersion: AI_CONTRACT_VERSION,
      hint: '注册 provider（AiBridge.registerProvider）后即可用；或在请求体中传 "fallback": "rules" 使用本地规则解析。',
      expectedResponse: {
        ok: true,
        action: 'create',
        target: 'schedule',
        fields: { title: '项目周会', date: '2025-10-21', startTime: '15:00', endTime: '16:00' },
        confidence: 0.92,
        warnings: [],
        explain: '明天 15:00-16:00 添加日程「项目周会」',
      },
    });
  }
}
