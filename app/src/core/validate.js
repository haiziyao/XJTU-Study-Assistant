/**
 * 通用入参校验与规范化（与具体业务无关）。
 *
 * 原则：
 * - 校验失败一律抛 HttpError.badRequest，并在 details 中给出字段级原因；
 * - 校验成功时返回**规范化后的对象**（补默认值、去空白、统一枚举），业务层不再处理脏值；
 * - 未知字段直接忽略，保证向前兼容（后续版本新增可选字段不会打断旧前端）。
 *
 * 领域相关的校验（日期/时刻的宽松归一化、重复规则、提醒、复杂度）放在各模块自己的
 * `schema.js` 里，例如 modules/calendar/schema.js。
 */

import { HttpError } from './http/router.js';

const MAX_TITLE = 120;
const MAX_TEXT = 2000;

export function fail(field, message) {
  throw HttpError.badRequest(`字段 ${field} 不合法：${message}`, { field });
}

export function pickDefined(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

export function requireTitle(value, field = 'title') {
  if (typeof value !== 'string' || !value.trim()) fail(field, '必填且不能为空');
  const title = value.trim();
  if (title.length > MAX_TITLE) fail(field, `长度不能超过 ${MAX_TITLE}`);
  return title;
}

export function optionalText(value, field, max = MAX_TEXT) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') fail(field, '必须是字符串');
  const text = value.trim();
  if (text.length > max) fail(field, `长度不能超过 ${max}`);
  return text;
}

export function enumValue(value, allowed, field, { optional = true, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return fallback;
    fail(field, `必填，可选值：${allowed.join(' / ')}`);
  }
  if (!allowed.includes(value)) fail(field, `取值必须是 ${allowed.join(' / ')} 之一`);
  return value;
}

export function intValue(value, field, { min = 0, max = 100000, optional = true, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return fallback;
    fail(field, '必填');
  }
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num)) fail(field, '必须是整数');
  if (num < min || num > max) fail(field, `取值范围 ${min}~${max}`);
  return num;
}

export function stringArray(value, field, { max = 20 } = {}) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) fail(field, '必须是数组');
  if (value.length > max) fail(field, `最多 ${max} 项`);
  return value.map((item) => String(item).trim()).filter(Boolean);
}
