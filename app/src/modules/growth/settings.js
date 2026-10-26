/**
 * 设置：把"写死的策略"变成可配置项。
 *
 * 目前三类：
 *   reminders.stateHour / closeHour / deepDays —— 什么时候提醒、挂几天算"该做决定了"
 *   tasks.carryOver —— 跨天时未完成的任务怎么处理
 *   data.selfCheck —— 启动时要不要做一次数据自检
 *
 * 读取走单文档（集合 `growthSettings` 的固定记录）；缺字段一律回落到默认值，
 * 所以旧版本的数据文件不需要迁移。
 */

import { badRequest } from './errors.js';
import { iso } from './time.js';
import { doc } from './store-utils.js';

export const DEFAULTS = {
  reminders: { enabled: true, stateHour: 10, closeHour: 21, deepDays: 3 },
  tasks: { carryOver: 'off' },
  data: { selfCheck: true },
};

export const CARRY_OVER_MODES = {
  off: '保持逾期（默认）：未完成的任务继续挂着，第二天提醒你处理',
  auto: '自动顺延：跨天时把所有未完成任务挪到今天（逾期信号会变弱）',
};

function merge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof base[key] === 'object') {
      out[key] = { ...base[key], ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

function intInRange(value, field, min, max) {
  const num = Number(value);
  if (!Number.isInteger(num) || num < min || num > max) {
    throw badRequest('INVALID_FIELD', `${field} 必须是 ${min}–${max} 的整数`);
  }
  return num;
}

/** 规范化 + 校验（导出给测试用）。 */
export function normalizeSettings(input = {}) {
  const merged = merge(DEFAULTS, input);
  const reminders = {
    enabled: Boolean(merged.reminders?.enabled ?? true),
    stateHour: intInRange(merged.reminders?.stateHour ?? 10, '提醒时间（状态）', 0, 23),
    closeHour: intInRange(merged.reminders?.closeHour ?? 21, '提醒时间（收尾）', 0, 23),
    deepDays: intInRange(merged.reminders?.deepDays ?? 3, '逾期升级天数', 1, 30),
  };
  if (reminders.closeHour <= reminders.stateHour) {
    // 收尾提示早于状态提示没有意义，会把两件事挤在同一时段
    throw badRequest('INVALID_FIELD', '「收尾提醒」要晚于「状态提醒」');
  }
  const carryOver = String(merged.tasks?.carryOver ?? 'off');
  if (!Object.hasOwn(CARRY_OVER_MODES, carryOver)) {
    throw badRequest('INVALID_FIELD', `跨天策略只能是 ${Object.keys(CARRY_OVER_MODES).join(' / ')}`);
  }
  return {
    reminders,
    tasks: { carryOver },
    data: { selfCheck: Boolean(merged.data?.selfCheck ?? true) },
  };
}

export function createSettingsService({ store, clock }) {
  const settingsDoc = doc(store, 'growthSettings', DEFAULTS);

  return {
    async read() {
      return normalizeSettings(await settingsDoc.read());
    },

    async update(patch = {}) {
      const current = await settingsDoc.read();
      const next = normalizeSettings(merge(current, patch));
      await settingsDoc.set({ ...next, updatedAt: iso(clock.now()) });
      return next;
    },

    defaults: DEFAULTS,
    modes: CARRY_OVER_MODES,
  };
}
