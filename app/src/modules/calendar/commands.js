/**
 * 日历模块的对话指令处理器。
 *
 * 由 module.js 注册给 target `event` / `schedule` / `todo`（三者共用同一份实现：
 * 走哪条分支由 `draft.target` 决定）。
 *
 * 处理器契约见 core/commands/command-service.js：
 *   键 = action 名，值 = (draft, options) => object；`options.dryRun` 时只预览不写库。
 *
 * 语义铁律（2026-10 重做）：
 * - **「完成」只属于待办**：日程与日历事件都没有完成态，对它们 complete 一律 400；
 * - **「顺延」也只属于待办**：把未完成的待办截止日平移到目标周，不克隆记录。
 */

import { HttpError } from '../../core/http/router.js';

const TARGET_LABEL = { schedule: '日程', event: '日历事件', todo: '待办' };
const labelOf = (target) => TARGET_LABEL[target] ?? target;

/** 范围文案：回执/预览里说清"删的是哪一块"，用户才敢点确认。 */
const BULK_SOURCE_LABEL = { manual: '仅手动创建', timetable: '仅课表导入', lms: '仅学堂同步' };

/**
 * filters 里出现 `scope`（或只有 `ids`）就按"按范围批量删除"处理。
 *
 * 为什么用"出现 scope"而不是"条数超过 N"：口径必须由调用方**明说**。按条数自动切换，
 * 会让"删掉这一条"和"清空全部"共用一条路径 —— 哪天匹配范围算错，删的就不是一条。
 * 老的逐条删除（关键词 / 日期区间）保持原行为，不受这次改动影响。
 */
function bulkScopeOf(filters = {}) {
  const scope = String(filters.scope ?? '').trim();
  if (scope) return scope;
  if (Array.isArray(filters.ids) && filters.ids.length) return 'ids';
  return null;
}

function bulkRangeLabel(scope, filters = {}) {
  if (scope === 'all') return '全部';
  // 「时间段」三个字要留着：确认卡上只有日期时，用户还得自己判断这是"某个范围"还是"某一天"
  if (scope === 'range') return `时间段 ${filters.from ?? '?'} 至 ${filters.to ?? '?'}`;
  if (scope === 'source') return BULK_SOURCE_LABEL[filters.source] ?? `来源 ${filters.source ?? '?'}`;
  if (scope === 'ids') return `指定 ${Array.isArray(filters.ids) ? filters.ids.length : 0} 条`;
  return scope;
}

/**
 * 「这会清空全部日程」只加一次。
 *
 * 为什么要去重：确认卡回传草稿时会把 warnings 一起带回来（前端把整个 draft 再 POST 一次），
 * 再加一遍就变成同一句提示出现两遍。用关键词判断而不是全等 —— 条数会变（预览 10 条、
 * 执行时可能只剩 9 条），全等会让去重失效。
 */
function clearAllWarnings(draft, text) {
  const warnings = Array.isArray(draft.warnings) ? [...draft.warnings] : [];
  if (text && !warnings.some((item) => String(item).includes('这会清空全部日程'))) warnings.push(text);
  return warnings;
}

/**
 * 分类 target 的对外字段（AI 草稿与查询回灌都用这一套名字）：
 *
 *   name  ← 分类名（服务层叫 label，但 `name` 是用户/模型最自然的说法）
 *   sort  ← 排序（服务层叫 order）
 *   usage ← 有多少条日程/事件在用（服务层只读字段 inUse）
 *
 * 为什么要做这层映射而不是让模型直接写 label/order：
 * 用户说的是「分类名叫考试、排序放前面、有多少条在用」，提示词里教模型 `name/color/sort`
 * 比教它数据库字段名更不容易编错；而服务层保持原有 REST 契约（label/order）不动。
 * 两个名字都接受，但同一个字段给两个不同值会 400 —— 静默取一个等于把用户的话丢掉。
 */
const CATEGORY_KIND_LABEL = { schedule: '日程分类', event: '日历事件分类' };
const CATEGORY_FILTER_KEYS = ['id', 'name', 'label', 'kind', 'keyword'];

/** AI 形状 → 服务层形状；`name` 优先，`label` 作为兼容别名。 */
function categoryNameOf(fields = {}) {
  const { name, label } = fields;
  if (name !== undefined && label !== undefined && String(name).trim() !== String(label).trim()) {
    throw HttpError.badRequest('分类名不要同时用 name 和 label 两个字段给出不同的值，保留一个即可', {
      fields: ['name', 'label'],
    });
  }
  const value = name ?? label;
  return value === undefined ? undefined : String(value).trim();
}

/** `sort` 优先，`order` 作为兼容别名（与服务层 REST 字段一致）。 */
function categoryOrderOf(fields = {}) {
  const { sort, order } = fields;
  if (sort !== undefined && order !== undefined && String(sort) !== String(order)) {
    throw HttpError.badRequest('分类排序不要同时用 sort 和 order 两个字段给出不同的值，保留一个即可', {
      fields: ['sort', 'order'],
    });
  }
  return sort ?? order;
}

/** 服务层分类 → AI 可读形状（查询回灌、写回执共用）。 */
function categoryView(item) {
  return {
    id: item.id,
    name: item.label,
    kind: item.kind,
    color: item.color,
    sort: item.order,
    usage: item.inUse,
    locked: Boolean(item.locked),
    builtin: Boolean(item.builtin),
  };
}

function categoryKindLabel(kind) {
  return CATEGORY_KIND_LABEL[kind] ?? kind;
}

/**
 * 分类名唯一性：**只在同一个 kind 内**判重。
 *
 * 为什么 AI 层要加这一条（CategoryService 本身没有）：
 * REST 的更新/删除走 id，重名只是显示上不好看；而 AI 的 filters 是「按名字定位」，
 * 同名分类会让“把考试改成红色”无法确定改哪一个。与其猜，不如拒绝并让模型改用 id。
 * 这条不写进 CategoryService：那会改变既有 REST 语义（现有测试与用户数据都按 id 操作）。
 */
function assertCategoryNameFree(categories, kind, name, excludeId = null) {
  const duplicate = categories
    .list({ kind })
    .find((item) => item.label === name && item.id !== excludeId);
  if (duplicate) {
    throw HttpError.badRequest(
      `${categoryKindLabel(kind)}里已经有「${name}」了（颜色 ${duplicate.color}）：` +
        '要改颜色/名字请用 action: "update"，不要重复新建',
      { field: 'name', id: duplicate.id },
    );
  }
}

/**
 * 按 filters 定位一个分类。id 优先；否则按 name 精确匹配（keyword 子串兜底）。
 *
 * kind 不传时会在两个集合里找：日程与事件共用 study/exam/other 这些名字，
 * 命中多个时必须让调用方指定 kind，而不是随手挑一个改掉。
 */
function locateCategory(categories, filters = {}) {
  const kind = filters.kind;
  if (filters.id) return categoryView(categories.get(filters.id, kind));

  const name = filters.name ?? filters.label;
  const keyword = filters.keyword;
  if (name === undefined && keyword === undefined) {
    throw HttpError.badRequest('更新/删除分类必须提供 filters.name（分类名）或 filters.id', {
      field: 'filters.name',
    });
  }
  const wanted = name === undefined ? null : String(name).trim();
  const matches = categories
    .list({ kind })
    .map(categoryView)
    .filter((item) => (wanted === null ? true : item.name === wanted))
    .filter((item) => (keyword === undefined ? true : String(item.name).includes(String(keyword))));

  if (!matches.length) {
    throw HttpError.notFound(`没有找到分类${wanted ? `「${wanted}」` : ''}`);
  }
  if (matches.length > 1) {
    const list = matches.map((item) => `${item.kind}:${item.id}「${item.name}」`).join('、');
    throw HttpError.badRequest(
      `找到 ${matches.length} 个同名分类（${list}）：日程和日历事件的分类可以同名，请用 filters.kind 指定 schedule 或 event`,
      { field: 'filters.kind', candidates: matches.map((item) => ({ id: item.id, kind: item.kind, name: item.name })) },
    );
  }
  return matches[0];
}

/** 更新后的预览值（不写库）：让确认卡直接显示“改完会变成什么”。 */
function previewCategoryUpdate(found, name, color, order) {
  return {
    ...found,
    name: name ?? found.name,
    color: color ?? found.color,
    sort: order ?? found.sort,
  };
}

/** 分类写操作的 explain：说清实际改了什么，而不是重复模型的措辞。 */
function categoryUpdateExplain(found, next) {
  const parts = [];
  if (next.name !== found.name) parts.push(`改名为「${next.name}」`);
  if (next.color !== found.color) parts.push(`颜色改为 ${next.color}`);
  if (next.sort !== found.sort) parts.push(`排序改为 ${next.sort}`);
  return parts.length
    ? `已修改${categoryKindLabel(found.kind)}「${found.name}」：${parts.join('，')}`
    : `没有改动${categoryKindLabel(found.kind)}「${found.name}」`;
}

/**
 * 分类 target 的处理器（注册为 `services.commands.registerHandler('category', ...)`）。
 *
 * 权限闸不在这里：`manual` / `strict` 档由 chat-service 留在确认卡里，只有 `auto`
 * 才会调用本对象真正执行 —— 与其它 target 完全同一条路，命令层不该再复制一份权限判断。
 */
export function createCategoryCommands({ categories }) {
  return {
    async create(draft, options) {
      const fields = draft.fields ?? {};
      const unknown = Object.keys(fields).filter((key) => !['name', 'label', 'color', 'sort', 'order', 'kind'].includes(key));
      if (unknown.length) {
        throw HttpError.badRequest(`分类不认识的字段：${unknown.join('、')}（可用：name / color / kind / sort）`, {
          fields: unknown,
        });
      }
      const kind = fields.kind ?? 'schedule';
      const name = categoryNameOf(fields);
      const order = categoryOrderOf(fields);
      const prepared = categories.prepareCreate({ kind, label: name, color: fields.color, order });
      assertCategoryNameFree(categories, prepared.kind, prepared.data.label);

      if (options.dryRun) {
        return {
          dryRun: true,
          planned: {
            action: 'create',
            target: 'category',
            fields: {
              name: prepared.data.label,
              color: prepared.data.color,
              kind: prepared.kind,
              sort: prepared.data.order,
            },
          },
          validated: categoryView({
            ...prepared.data,
            kind: prepared.kind,
            id: null,
            inUse: 0,
          }),
        };
      }

      const created = await categories.create({
        kind: prepared.kind,
        label: prepared.data.label,
        color: prepared.data.color,
        order: prepared.data.order,
      });
      return {
        item: categoryView(created),
        affected: [{ id: created.id, name: created.label, color: created.color, kind: created.kind }],
        explain: `已新建${categoryKindLabel(created.kind)}「${created.label}」，颜色 ${created.color}`,
      };
    },

    query(draft) {
      const filters = draft.filters ?? {};
      const unknown = Object.keys(filters).filter((key) => !CATEGORY_FILTER_KEYS.includes(key));
      if (unknown.length) {
        throw HttpError.badRequest(`分类查询不认识的筛选条件：${unknown.join('、')}（可用：id / name / kind / keyword）`, {
          fields: unknown,
        });
      }
      const kind = filters.kind;
      let items = categories.list({ kind });
      if (filters.id) {
        items = items.filter((item) => item.id === filters.id);
      } else {
        const name = filters.name ?? filters.label;
        if (name !== undefined) items = items.filter((item) => item.label === String(name).trim());
        if (filters.keyword !== undefined) {
          items = items.filter((item) => String(item.label).includes(String(filters.keyword)));
        }
      }
      return {
        filters,
        items: items.map(categoryView),
        count: items.length,
        explain: draft.explain ?? `共 ${items.length} 个${kind ? categoryKindLabel(kind) : '分类'}`,
      };
    },

    async update(draft, options) {
      const found = locateCategory(categories, draft.filters ?? {});
      const fields = draft.fields ?? {};
      const unknown = Object.keys(fields).filter((key) => !['name', 'label', 'color', 'sort', 'order', 'kind'].includes(key));
      if (unknown.length) {
        throw HttpError.badRequest(`分类不认识的字段：${unknown.join('、')}（可用：name / color / kind / sort）`, {
          fields: unknown,
        });
      }
      const name = categoryNameOf(fields);
      const order = categoryOrderOf(fields);
      const patch = {};
      if (name !== undefined) patch.label = name;
      if (fields.color !== undefined) patch.color = fields.color;
      if (order !== undefined) patch.order = order;
      if (fields.kind !== undefined) patch.kind = fields.kind;
      if (!Object.keys(patch).length) {
        throw HttpError.badRequest('分类更新至少要提供 name / color / sort 之一', { fields: ['name', 'color', 'sort'] });
      }

      const prepared = categories.prepareUpdate(found.id, patch, { kind: found.kind });
      if (prepared.data.label !== undefined) {
        assertCategoryNameFree(categories, prepared.kind, prepared.data.label, found.id);
      }
      const next = previewCategoryUpdate(found, prepared.data.label, prepared.data.color, prepared.data.order);

      if (options.dryRun) {
        return {
          dryRun: true,
          planned: {
            action: 'update',
            target: 'category',
            ids: [found.id],
            fields: {
              ...(prepared.data.label !== undefined ? { name: prepared.data.label } : {}),
              ...(prepared.data.color !== undefined ? { color: prepared.data.color } : {}),
              ...(prepared.data.order !== undefined ? { sort: prepared.data.order } : {}),
            },
          },
          validated: next,
        };
      }

      const updated = await categories.update(found.id, prepared.data, { kind: found.kind });
      return {
        item: categoryView(updated),
        affected: [{ id: updated.id, name: updated.label, color: updated.color, kind: updated.kind }],
        explain: categoryUpdateExplain(found, categoryView(updated)),
      };
    },

    async delete(draft, options) {
      const found = locateCategory(categories, draft.filters ?? {});

      /**
       * AI 删除分类：**被引用时直接拒绝**，不沿用 REST 的“改派到 other”后备。
       *
       * REST 那条语义（删分类不丢数据、记录改成 other）对界面单条操作是合理的，
       * 但 AI 是一句话批量执行：用户说“删掉考试分类”时，看不到「有 12 条日程会被静默改成其它」。
       * 确认卡也没有空间逐条列出受影响的记录。让用户先去改派、再删，是更可解释的行为。
       */
      if (found.usage > 0) {
        throw HttpError.badRequest(
          `${categoryKindLabel(found.kind)}「${found.name}」还有 ${found.usage} 条记录在用，不能删除：` +
            '请先把这些记录改到别的分类（或只改名/改色保留它）',
          { field: 'filters.name', usage: found.usage },
        );
      }

      if (options.dryRun) {
        return {
          dryRun: true,
          planned: { action: 'delete', target: 'category', ids: [found.id], name: found.name },
        };
      }

      const result = await categories.remove(found.id, { kind: found.kind });
      return {
        affected: [{ id: found.id, name: found.name, color: found.color, kind: found.kind }],
        deleted: result.deleted,
        reassigned: result.reassigned,
        explain: `已删除${categoryKindLabel(found.kind)}「${found.name}」`,
      };
    },
  };
}

export function createCalendarCommands({ events, schedules, todos, store }) {
  /** 三个 target 各自的集合服务：写库与「只校验」都从这里取，避免出现两套校验。 */
  const targetService = (target) =>
    target === 'todo' ? todos : target === 'schedule' ? schedules : target === 'event' ? events : null;

  /**
   * 按时间范围查日程：把重复规则展开成「每一次发生」。
   *
   * 为什么必须走 `range()` 而不是 `list()`：`list({from,to})` 只拿 `date`（**首次发生日**）
   * 做过滤，课表导入的每周课程存的是 9 月 14 日 —— 问「这周有什么课」时自然一条都命中不了。
   * 真机上用户界面里明明有 24 条课，AI 却回答「你没有日程」，根因就在这里。
   * `range()` 与日历日/周视图用的是同一套展开逻辑，保证「界面看得到」和「AI 查得到」不会漂移。
   *
   * `id` 覆盖成**原日程 id**（`range()` 内部的 occurrence id 是 `${id}:${date}`）：
   * 模型拿到 `id` 后会直接用于后续改/删，而带日期后缀的合成 id 在集合里根本不存在，
   * 传回来只会 404；「这是哪一天」由 `occurrenceDate` 单独表达。
   * 只传 from 或只传 to 时退回 `list()`：`range()` 要求两端都有，硬造另一端会把
   * 「某天以后的全部」展开成没有边界的查询。
   */
  function scheduleOccurrences(filters = {}) {
    const day = filters.date;
    const from = day ?? filters.from;
    const to = day ?? filters.to;
    if (!from || !to) return null;
    return schedules
      .range({ from, to, category: filters.category, keyword: filters.keyword })
      .map((occurrence) => ({ ...occurrence, id: occurrence.scheduleId }));
  }

  /**
   * 写操作按**原日程**去重。
   *
   * 展开后同一条重复日程会在区间里出现多次（每周一次），而 update/delete 一次只该动
   * 这一条记录本身：不去重会把「改/删本周的课」变成对同一 id 重复调用 N 次，
   * 回执里的条数也从「改了 1 条日程」变成「发生了 5 次」。
   */
  function uniqueByScheduleId(items) {
    const seen = new Set();
    return items.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }

  /** 按 filters 定位待操作记录；id 优先。三个集合的过滤条件形状一致，但各自独立查询。 */
  function locate(draft) {
    const filters = draft.filters ?? {};
    if (draft.target === 'todo') {
      if (filters.id) return [todos.get(filters.id)];
      return todos.list({
        from: filters.from,
        to: filters.to,
        // 「完成」默认只找未完成的；删除/修改要能命中任意状态
        completed: filters.completed ?? (draft.action === 'complete' ? false : undefined),
        priority: filters.priority,
        keyword: filters.keyword,
        // 分类与父待办也可以作为定位条件（"完成期末复习下面的第一章"这类说法）
        category: filters.category,
        parentId: filters.parentId,
      });
    }
    if (draft.target === 'schedule') {
      if (filters.id) return [schedules.get(filters.id)];
      /**
       * 写操作（改/删）也要能命中重复日程的"某一次发生"，否则「删掉这节材料力学」
       * 会因为 `date` 存的是首次发生日而找不到 —— 与查询是同一个根因。
       * 但真正落库时一条日程只能改/删一次，所以先按原日程 id 去重。
       */
      const occurrences = scheduleOccurrences(filters);
      if (occurrences) return uniqueByScheduleId(occurrences);
      return schedules.list({
        from: filters.from,
        to: filters.to,
        category: filters.category,
        keyword: filters.keyword,
      });
    }
    if (filters.id) return [events.get(filters.id)];
    return events.list({ from: filters.from, to: filters.to, keyword: filters.keyword });
  }

  /**
   * 按范围删除日程：**一个动作、一个草稿**。
   *
   * 为什么必须走服务层的 `bulkDelete` 而不是自己循环 `remove`：
   *   - 回收站、confirm/confirmText、范围口径都只该有一份实现；
   *   - 循环删既没有预览数字，也没法撤销 —— 正是真机上模型说"只能逐条删"的根因。
   *
   * dryRun 返回 `planned: 'bulk'`（不是 `planned.action` 对象）：批量删除的"计划"就是
   * "一次删一批"，条数与样例另有顶层字段，前端/回灌都不需要再理解一层结构。
   */
  async function deleteScheduleBulk(draft, options, scope) {
    const filters = draft.filters ?? {};
    const input = { scope, from: filters.from, to: filters.to, source: filters.source, ids: filters.ids };
    const label = bulkRangeLabel(scope, filters);
    const draftWarnings = Array.isArray(draft.warnings) ? draft.warnings : [];

    if (options.dryRun) {
      const preview = await schedules.bulkDelete({ ...input, dryRun: true });
      // 「清空全部」必须在确认之前就说清楚：这是唯一一个会动到整个日程库的范围
      const warnings =
        scope === 'all'
          ? clearAllWarnings(draft, `这会清空全部日程（${preview.count} 条），删除后可在日程页的「回收站」撤销`)
          : draftWarnings;
      /**
       * 写回草稿本身：确认卡（shell/app.js 的 draftCard）只渲染 `draft.warnings`，
       * 不读 `preview.warnings`。只把提示放在响应里，用户在卡上就看不到 —— 这一步不是缓存，
       * 而是让"点确认之前"真的看得见警告。
       */
      if (warnings.length) draft.warnings = warnings;
      return {
        dryRun: true,
        planned: 'bulk',
        scope,
        count: preview.count,
        samples: preview.samples,
        bySource: preview.bySource,
        explain: `将删除 ${preview.count} 条日程（范围：${label}）`,
        warnings,
      };
    }

    /**
     * 用户在对话里已经明确说过"删除所有日程"，所以指令层可以替他把 confirm 补成 true；
     * 但 `scope:'all'` 的 confirmText 仍然照补 —— 它防的是"程序顺手清了整个库"，
     * 而不是"用户没确认"。这条路径与 UI 走的是同一个服务方法、同一套安全阀。
     */
    const result = await schedules.bulkDelete({
      ...input,
      dryRun: false,
      confirm: true,
      ...(scope === 'all' ? { confirmText: '删除' } : {}),
    });
    // removed 为 0 时不要硬补"已放进回收站"（没有批次可撤）；预览阶段的警告照旧保留
    const warnings =
      scope === 'all' && result.removed > 0
        ? clearAllWarnings(draft, `这会清空全部日程（${result.removed} 条），已放进日程页的「回收站」，可撤销`)
        : draftWarnings;
    return {
      planned: 'bulk',
      scope,
      removed: result.removed,
      trashId: result.trashId,
      bySource: result.bySource,
      count: result.removed,
      warnings,
      explain: result.removed
        ? `已删除 ${result.removed} 条日程（范围：${label}），可在日程页的「回收站」撤销`
        : `没有符合条件的日程（范围：${label}）`,
    };
  }

  return {
    async create(draft, options) {
      const fields = { ...(draft.fields ?? {}), source: draft.fields?.source ?? 'command' };
      if (options.dryRun) {
        // 预览必须跑**真实的字段校验**（只是不写库）：否则"缺 startTime"这类错误要等用户
        // 点了确认才冒出来，确认卡就成了摆设 —— 走 AI 的草稿尤其依赖这一步兜住模型的编造字段。
        // `planned` 是原样回显（模型到底给了什么），`validated` 是校验/归一化后的最终字段。
        const validated = targetService(draft.target)?.preview(fields) ?? null;
        /**
         * 日程的预览还要**算冲突**：时段重叠这件事，用户点"确认"之前就该看见。
         *
         * 以前只有真写（下面 schedules.create 之后）才调 `conflictsFor`，于是：
         *   - 用户看着一张干干净净的确认卡点了确认，才知道撞了已有的日程；
         *   - 自动审批档下模型更是全程不知情，正文只会说"给你加上了"，绝口不提重叠 ——
         *     而它本来是可以提醒"这条和你的英语晨读重叠了"的。
         *
         * 这里刻意**调用与真写同一个** `schedules.conflictsFor`，不复制第二份判断：
         * 两边各写一套"什么算重叠"（跨天、重复日程展开、缺 endTime 按 60 分钟兜底）迟早会漂移，
         * 到时候预览说不撞、落库说撞，比不提示更糟。
         *
         * 无重叠时返回空数组（而不是省略字段）：确认卡与回灌逻辑要能区分"没查"和"查了没撞"。
         * 待办/日历事件没有时段，真写时也不报冲突，所以这里不造一个空字段出来。
         */
        const conflicts = draft.target === 'schedule' && validated ? schedules.conflictsFor(validated) : null;
        return {
          dryRun: true,
          planned: { action: 'create', target: draft.target, fields },
          validated,
          ...(conflicts ? { conflicts } : {}),
        };
      }
      if (draft.target === 'todo') {
        const item = await todos.create(fields);
        return { item, affected: [{ id: item.id, title: item.title, date: item.deadline }] };
      }
      if (draft.target === 'schedule') {
        const item = await schedules.create(fields);
        const conflicts = schedules.conflictsFor(item);
        return { item, conflicts, affected: [{ id: item.id, title: item.title, date: item.date }] };
      }
      const item = await events.create(fields);
      return { item, affected: [{ id: item.id, title: item.title, date: item.startDate }] };
    },

    query(draft) {
      const filters = draft.filters ?? {};
      if (draft.target === 'todo') {
        const items = todos.list({
          from: filters.from,
          to: filters.to,
          completed: filters.completed,
          priority: filters.priority,
          overdue: filters.overdue,
          keyword: filters.keyword,
          category: filters.category,
          parentId: filters.parentId,
        });
        return {
          filters,
          items,
          count: items.length,
          stats: todos.stats(items),
          explain: draft.explain ?? `共 ${items.length} 条待办`,
        };
      }
      if (draft.target === 'schedule') {
        /**
         * 查询是 AI 回答「这周有什么课」的唯一数据来源，必须展开重复规则：
         * 走 `list()` 只会看到首次发生日，模型就会得出「你没有日程」的错误结论。
         * 与 locate 共用 `scheduleOccurrences`，避免查询和改/删各有一套「一条日程算几天」的口径。
         */
        const items =
          scheduleOccurrences(filters) ??
          schedules.list({
            from: filters.from,
            to: filters.to,
            category: filters.category,
            keyword: filters.keyword,
          });
        return {
          filters,
          items,
          count: items.length,
          explain: draft.explain ?? `共 ${items.length} 条日程`,
        };
      }
      const items = events.list({ from: filters.from, to: filters.to, keyword: filters.keyword });
      return {
        filters,
        items,
        count: items.length,
        explain: draft.explain ?? `共 ${items.length} 个日历事件`,
      };
    },

    async update(draft, options) {
      const matches = locate(draft);
      if (!matches.length) throw HttpError.notFound(`没有找到符合条件的${labelOf(draft.target)}`);
      const fields = draft.fields ?? {};
      if (options.dryRun) {
        /**
         * 待办的更新预览要跑**真校验**（与 create 分支同一个理由）：
         * 真写走的是「现有记录 + patch」重建，未知字段/两种工时口径冲突都会 400；
         * 预览不跑的话，用户点一张"看起来没问题"的确认卡才会失败 —— 那就是卡点点不动。
         *
         * 拿第一条匹配来重建：字段级校验与"改哪一条"无关（多条匹配时真写会对每条各跑一次）。
         * 日程/事件保持不变（它们本来就不拒绝未知字段，预览语义不在这次改动范围内）。
         */
        const validated = draft.target === 'todo' ? todos.previewUpdate(matches[0].id, fields) : null;
        return {
          dryRun: true,
          planned: { action: 'update', target: draft.target, ids: matches.map((m) => m.id), fields },
          ...(validated ? { validated } : {}),
        };
      }
      const updated = [];
      for (const match of matches) {
        if (draft.target === 'todo') updated.push(await todos.update(match.id, fields));
        else if (draft.target === 'schedule') updated.push(await schedules.update(match.id, fields));
        else updated.push(await events.update(match.id, fields));
      }
      return {
        items: updated,
        affected: updated.map((item) => ({ id: item.id, title: item.title })),
        ambiguous: matches.length > 1,
        explain: `已修改 ${updated.length} 条${labelOf(draft.target)}`,
      };
    },

    async delete(draft, options) {
      /**
       * 日程支持"按范围删除"：`filters.scope` 出现时整件事是一个批量动作，
       * 不再走下面"先 locate 再逐条"的老路径。待办/日历事件目前没有这个能力，
       * 不能顺手给它们也开一个 —— 那需要各自想清楚范围与回收站语义。
       */
      if (draft.target === 'schedule') {
        const scope = bulkScopeOf(draft.filters);
        if (scope) return deleteScheduleBulk(draft, options, scope);
      }
      const matches = locate(draft);
      if (!matches.length) throw HttpError.notFound(`没有找到符合条件的${labelOf(draft.target)}`);
      if (options.dryRun) {
        return { dryRun: true, planned: { action: 'delete', target: draft.target, ids: matches.map((item) => item.id) } };
      }
      const ids = matches.map((item) => item.id);
      // 待办必须走服务层批量删除：直接删集合会把子任务的 parentId 留成悬空
      if (draft.target === 'todo') {
        const result = await todos.removeMany(ids);
        return {
          affected: matches.map((item) => ({ id: item.id, title: item.title })),
          deleted: result.deleted,
          detachedChildren: result.detachedChildren,
          ambiguous: matches.length > 1,
          explain: `已删除 ${result.deleted} 条${labelOf(draft.target)}${result.detachedChildren.length ? `，${result.detachedChildren.length} 个子任务改为独立待办` : ''}`,
        };
      }
      if (draft.target === 'schedule') await store.schedules.removeMany(ids);
      else await store.events.removeMany(ids);
      return {
        affected: matches.map((item) => ({ id: item.id, title: item.title })),
        deleted: ids.length,
        ambiguous: matches.length > 1,
        explain: `已删除 ${ids.length} 条${labelOf(draft.target)}`,
      };
    },

    /**
     * 标记完成：**只有待办有完成态**。
     * 对日程 / 日历事件执行「完成」是语义错误，必须明确报错而不是静默改错东西。
     */
    async complete(draft, options) {
      if (draft.target !== 'todo') {
        const label = labelOf(draft.target);
        throw HttpError.badRequest(
          `${label}没有完成态，完成只属于待办：请说「完成 <待办名>」，或先把这条${label}改建成待办`,
          { field: 'target' },
        );
      }
      const matches = locate(draft);
      if (!matches.length) {
        // 用户/AI 说的「完成 X」如果其实是一条日程或日历事件，必须明确回答「没有完成态」，
        // 而不是 404 —— 404 会被理解成「没有这条记录」，接着可能被当成新建。
        const filters = draft.filters ?? {};
        const probe = { from: filters.from, to: filters.to, keyword: filters.keyword };
        const scheduleHit = schedules.list(probe)[0];
        const eventHit = schedules.list(probe).length ? undefined : events.list(probe)[0];
        const hit = scheduleHit ?? eventHit;
        if (hit) {
          const what = scheduleHit ? '日程' : '日历事件';
          const span = scheduleHit ? `（${hit.startTime ?? ''}${hit.endTime ? `-${hit.endTime}` : ''}）` : '';
          throw HttpError.badRequest(
            `「${hit.title}」是${what}${span}，${what}没有完成态：完成只属于待办，请说「完成 <待办名>」`,
            { field: 'target' },
          );
        }
        throw HttpError.notFound('没有找到符合条件的待办');
      }
      if (options.dryRun) {
        return { dryRun: true, planned: { action: 'complete', target: 'todo', ids: matches.map((m) => m.id) } };
      }
      const updated = [];
      // 完成父会连带完成所有后代：把影响清单汇总起来回给前端/AI，
      // 否则模型只会说"完成了"，用户不知道还连带勾掉了 3 个子任务。
      const cascaded = { completed: [], reverted: [] };
      for (const match of matches) {
        const item = await todos.setCompleted(match.id, true);
        updated.push(item);
        cascaded.completed.push(...(item.cascaded?.completed ?? []));
      }
      const extra = cascaded.completed.length ? `，并连带完成 ${cascaded.completed.length} 个子任务` : '';
      return {
        items: updated,
        affected: updated.map((item) => ({ id: item.id, title: item.title, date: item.deadline })),
        cascaded,
        ambiguous: matches.length > 1,
        explain: `已完成 ${updated.length} 条待办${extra}`,
      };
    },

    /** 顺延未完成待办到目标周（周一）。同样只对待办成立。 */
    async rollover(draft, options) {
      if (draft.target !== 'todo') {
        throw HttpError.badRequest('顺延只适用于待办：日程与日历事件都是固定日期的安排', { field: 'target' });
      }
      const weekStart = draft.fields?.weekStart ?? draft.filters?.weekStart;
      if (options.dryRun) return { dryRun: true, planned: { action: 'rollover', target: 'todo', weekStart } };
      const result = await todos.rollover({ weekStart });
      return {
        ...result,
        affected: result.items.map((item) => ({ id: item.id, title: item.title, date: item.to, from: item.from })),
        explain: result.moved ? `已顺延 ${result.moved} 条待办到 ${result.weekStart} 那一周` : '没有需要顺延的待办',
      };
    },
  };
}
