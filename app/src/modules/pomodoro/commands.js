/**
 * 指令 target `pomodoro` 的处理器（`services.commands.registerHandler('pomodoro', ...)`）。
 *
 * **只注册 query，不注册任何写动作** —— 这是刻意的：开始/暂停/停止意味着"用户此刻
 * 要坐下来学"，只有界面上的按钮能表达这个意图。让模型替用户启动一个计时器，
 * 既容易在用户没看屏幕时误触发，也会让两个客户端同时以为自己该开始。
 * AI 的正确做法是引导用户去点「番茄钟」页里的按钮（见 module.js 的 aiPrompt）。
 *
 * 返回形状与其它只读 target 一致：`{ filters, count, items, summary, explain }`；
 * `summary` 是给模型看的聚合，`items` 里放同样一份对象，方便通用投影逻辑处理。
 */

import { HttpError } from '../../core/http/router.js';

const RANGES = ['today', 'week', 'all'];

function rangeOf(draft) {
  const raw = draft?.filters?.range ?? draft?.fields?.range ?? 'today';
  const range = typeof raw === 'string' ? raw.trim().toLowerCase() : 'today';
  if (!RANGES.includes(range)) {
    throw HttpError.badRequest(`字段 range 不合法：取值必须是 today / week / all 之一`, { field: 'range', value: raw });
  }
  return range;
}

export function createPomodoroCommands({ pomodoro }) {
  return {
    async query(draft) {
      const range = rangeOf(draft);
      const result = await pomodoro.query({ range });
      return {
        filters: { range },
        count: 1,
        items: [result],
        summary: result,
        explain: result.explain,
      };
    },
  };
}
