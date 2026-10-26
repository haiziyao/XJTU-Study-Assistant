/**
 * 任务模板：内置 36 条 + 用户自己的。
 *
 * 为什么这一层必须可改：模板决定"系统建议你做什么"，而每个人的生活不一样。
 * 一个不写代码的人也应该能加"每天给花浇水"这种事，否则这套系统最后只是在
 * 执行作者的偏好。
 *
 * 覆盖关系存在单文档（集合 `growthTemplates` 的固定记录）：
 *   { custom: [模板…], disabled: [内置模板 id…] }
 * 这样内置库可以随版本升级，用户的改动不会被打包覆盖。
 */

import { randomUUID } from 'node:crypto';

import { badRequest, notFound } from './errors.js';
import { doc } from './store-utils.js';
import { CATALOG, KINDS, KINDS_LIST } from './catalog.js';

const MAX_CUSTOM = 200;
const CUSTOM_PREFIX = 'custom:';

function validate(input, { partial = false } = {}) {
  const out = {};
  if (!partial || input.title !== undefined) {
    const title = String(input.title ?? '').trim();
    if (!title) throw badRequest('INVALID_FIELD', '标题不能为空');
    if (title.length > 40) throw badRequest('INVALID_FIELD', '标题最多 40 字');
    out.title = title;
  }
  if (!partial || input.kind !== undefined) {
    const kind = String(input.kind ?? 'life');
    if (!KINDS_LIST.includes(kind)) throw badRequest('INVALID_FIELD', `类型只能是 ${KINDS_LIST.join(' / ')}`);
    out.kind = kind;
  }
  if (!partial || input.estimateMin !== undefined) {
    const minutes = Number(input.estimateMin ?? 25);
    if (!Number.isFinite(minutes) || minutes < 5 || minutes > 240) {
      throw badRequest('INVALID_FIELD', '预估时长必须在 5–240 分钟之间');
    }
    out.estimateMin = Math.round(minutes);
  }
  if (!partial || input.difficulty !== undefined) {
    const difficulty = Number(input.difficulty ?? 2);
    if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 5) {
      throw badRequest('INVALID_FIELD', '难度必须是 1–5 的整数');
    }
    out.difficulty = difficulty;
  }
  if (input.detail !== undefined) {
    const detail = String(input.detail).trim();
    if (detail.length > 200) throw badRequest('INVALID_FIELD', '说明最多 200 字');
    out.detail = detail;
  }
  return out;
}

export function createTemplateService({ store, clock }) {
  const overrides = doc(store, 'growthTemplates', { custom: [], disabled: [] });

  async function read() {
    const value = await overrides.read();
    return {
      custom: Array.isArray(value.custom) ? value.custom : [],
      disabled: Array.isArray(value.disabled) ? value.disabled : [],
    };
  }

  return {
    /** 设置页用：内置 + 自定义，各带启用状态。 */
    async list() {
      const state = await read();
      const disabled = new Set(state.disabled);
      return {
        builtin: CATALOG.map((item) => ({
          ...item,
          source: 'builtin',
          enabled: !disabled.has(item.id),
          kindLabel: KINDS[item.kind]?.label ?? item.kind,
        })),
        custom: state.custom.map((item) => ({
          ...item,
          id: `${CUSTOM_PREFIX}${item.id}`,
          source: 'custom',
          enabled: item.enabled !== false,
          kindLabel: KINDS[item.kind]?.label ?? item.kind,
        })),
      };
    },

    /** 生成器用：当前生效的模板集合。 */
    async active() {
      const state = await read();
      const disabled = new Set(state.disabled);
      const builtin = CATALOG.filter((item) => !disabled.has(item.id));
      const custom = state.custom
        .filter((item) => item.enabled !== false)
        .map((item) => ({
          id: `${CUSTOM_PREFIX}${item.id}`,
          title: item.title,
          detail: item.detail ?? '',
          kind: item.kind,
          estimateMin: item.estimateMin,
          difficulty: item.difficulty,
          custom: true,
        }));
      return [...builtin, ...custom];
    },

    async add(input) {
      const state = await read();
      if (state.custom.length >= MAX_CUSTOM) {
        throw badRequest('TOO_MANY_TEMPLATES', `自定义模板最多 ${MAX_CUSTOM} 条`);
      }
      const fields = validate(input);
      const title = fields.title;
      if (state.custom.some((item) => item.title === title) || CATALOG.some((item) => item.title === title)) {
        throw badRequest('DUPLICATE_TITLE', `已经有同名模板「${title}」`);
      }
      const item = {
        id: randomUUID(),
        title,
        detail: fields.detail ?? '',
        kind: fields.kind,
        estimateMin: fields.estimateMin,
        difficulty: fields.difficulty,
        enabled: true,
        createdAt: clock.now().toISOString(),
      };
      await overrides.set({ ...state, custom: [...state.custom, item] });
      return { ...item, id: `${CUSTOM_PREFIX}${item.id}`, source: 'custom' };
    },

    /** 启用/停用：内置走 disabled 列表，自定义改 enabled 字段。 */
    async setEnabled(id, enabled) {
      const state = await read();
      const raw = String(id).replace(CUSTOM_PREFIX, '');
      const isCustom = state.custom.some((item) => item.id === raw);
      if (isCustom) {
        const custom = state.custom.map((item) => (item.id === raw ? { ...item, enabled: Boolean(enabled) } : item));
        await overrides.set({ ...state, custom });
        return { id: `${CUSTOM_PREFIX}${raw}`, enabled: Boolean(enabled), source: 'custom' };
      }
      const exists = CATALOG.some((item) => item.id === raw);
      if (!exists) throw notFound('TEMPLATE_NOT_FOUND', '没有这个模板');
      const disabled = new Set(state.disabled);
      if (enabled) disabled.delete(raw);
      else disabled.add(raw);
      await overrides.set({ ...state, disabled: [...disabled] });
      return { id: raw, enabled: Boolean(enabled), source: 'builtin' };
    },

    async remove(id) {
      const state = await read();
      const raw = String(id).replace(CUSTOM_PREFIX, '');
      const exists = state.custom.some((item) => item.id === raw);
      if (!exists) throw notFound('TEMPLATE_NOT_FOUND', '只能删除自定义模板');
      const custom = state.custom.filter((item) => item.id !== raw);
      await overrides.set({ ...state, custom });
      return { ok: true, removed: true };
    },

    /** 内置模板能否恢复默认（设置页的"全部启用"）。 */
    async enableAll() {
      const state = await read();
      await overrides.set({ ...state, disabled: [] });
      return { ok: true, enabled: CATALOG.length };
    },
  };
}

export { validate as validateTemplate };
