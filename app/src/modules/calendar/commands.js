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
 * 待办按范围批量处理：六个范围与 `filters.scope` 一一对应。
 *
 * 为什么不复用日程的 scope 词汇：日程的范围是「时间段 / 来源」，待办的日常说法是
 * 「已完成 / 未完成 / 学堂同步 / 自己建的」。硬套 source+range 会让模型把
 * "删掉所有已完成的待办" 写成 `completed: true` 的逐条钻取，又在超过条数上限时卡住。
 */
const TODO_BULK_SCOPES = ['all', 'completed', 'incomplete', 'lms', 'manual', 'ids'];
const TODO_BULK_SCOPE_LABEL = {
  all: '全部',
  completed: '已完成的',
  incomplete: '未完成的',
  lms: '仅学堂同步的',
  manual: '仅手动创建的',
};
const TODO_BULK_ACTION_LABEL = { delete: '删除', complete: '完成', uncomplete: '取消完成' };

/**
 * 服务层一次最多 200 个 id（`todo-service.js` 的 MAX_BULK_IDS）。
 *
 * 指令层在**这里**分批，而不是把限制改大：200 是防误删的安全阀，不是业务上限。
 * 用户说"删掉所有已完成的待办"时范围已经明确，不能因为恰好有 201 条就让他自己缩小范围。
 * 分批仍然只调用 `todos.bulk()`，不绕过任何单条语义（级联完成、解除子级、跳过 already 都在服务层）。
 */
const TODO_BULK_BATCH = 200;
/** 预览样例条数：与 `todos.bulk()` 的 dryRun 保持一致（8 条足够确认选对了范围）。 */
const TODO_BULK_SAMPLE_LIMIT = 8;

/** 学堂同步的待办判据与 lms 模块一致：externalId 以 `lms:` 开头。 */
function isLmsTodo(item) {
  return String(item?.externalId ?? '').startsWith('lms:');
}

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

/**
 * 待办的范围识别：**空 `filters.ids` 也必须进批量路径**。
 *
 * 为什么不复用 bulkScopeOf 末尾那个 `.length` 判断：`ids: []` 若被当成"没有范围"，
 * 就会掉进老 locate 路径；而 locate 不看 `filters.ids`，一个条件都没加时等于「全部待办」。
 * 模型给空数组时用户的本意是"这 0 条"，绝不能因此改成"那全部吧"。
 * 批量路径会明确 400（ids 不能为空），这是安全方向上的失败。
 */
function todoBulkScopeOf(filters = {}) {
  const scope = bulkScopeOf(filters);
  if (scope) return scope;
  return Array.isArray(filters.ids) ? 'ids' : null;
}

function bulkRangeLabel(scope, filters = {}) {
  if (scope === 'all') return '全部';
  // 「时间段」三个字要留着：确认卡上只有日期时，用户还得自己判断这是"某个范围"还是"某一天"
  if (scope === 'range') return `时间段 ${filters.from ?? '?'} 至 ${filters.to ?? '?'}`;
  if (scope === 'source') return BULK_SOURCE_LABEL[filters.source] ?? `来源 ${filters.source ?? '?'}`;
  if (scope === 'ids') return `指定 ${Array.isArray(filters.ids) ? filters.ids.length : 0} 条`;
  return scope;
}

/** 待办范围文案；`ids` 的数字用**实际命中条数**，不是模型数组长度。 */
function todoBulkScopeLabel(scope, count) {
  if (scope === 'ids') return `指定 ${count} 条`;
  return TODO_BULK_SCOPE_LABEL[scope] ?? scope;
}

/**
 * 范围安全提示。
 *
 * 为什么提示要写到草稿里而不是只放响应：确认卡（`shell/app.js`）只渲染
 * `draft.warnings`。只把 `scope:'all'` / `lms` 的影响写在 `preview.warnings`，
 * 用户在点确认之前根本看不到，等于没有警告。
 *
 * 返回 `{ marker, text }`：marker 用来在"预览 → 回传草稿 → 真正执行"之间去重，
 * 同时允许用执行后的真实条数**替换**预览时的数字（全等去重会留下过期的 N）。
 */
function todoBulkWarnings(action, scope, count) {
  if (count <= 0) return [];
  if (scope === 'all') {
    if (action === 'delete') {
      return [{ marker: '会删除全部', text: `这会删除全部 ${count} 条待办（含你自己建的），删除后无法恢复` }];
    }
    if (action === 'complete') {
      return [{ marker: '会完成全部', text: `这会完成全部 ${count} 条待办（含你自己建的），已完成的会自动跳过` }];
    }
    return [{ marker: '会取消完成全部', text: `这会取消完成全部 ${count} 条待办（含你自己建的），未完成的会自动跳过` }];
  }
  if (scope === 'lms') {
    // 「删了还会回来」是用户最容易误解的一点：学堂同步按 externalId 重建，本地删除不是永久清除。
    if (action === 'delete') {
      return [{
        marker: '下次同步会重新生成',
        text: '这些是学堂同步的，下次同步会重新生成（externalId 以 lms: 开头）',
      }];
    }
    return [{
      marker: '这些是学堂同步的',
      text: '这些是学堂同步的（externalId 以 lms: 开头）：本操作只改本地状态，不会提交或撤销学堂里的作业',
    }];
  }
  return [];
}

/** 把范围提示合并进草稿（同 marker 替换旧文案，避免预览/执行的条数不一致）。 */
function applyDraftWarnings(draft, entries) {
  if (!entries.length) return Array.isArray(draft.warnings) ? [...draft.warnings] : [];
  const warnings = Array.isArray(draft.warnings) ? [...draft.warnings] : [];
  for (const { marker, text } of entries) {
    const index = warnings.findIndex((item) => String(item).includes(marker));
    if (index >= 0) warnings[index] = text;
    else warnings.push(text);
  }
  draft.warnings = warnings;
  return warnings;
}

/** 预览样例：批量动作只回答"选中的是哪些"，带截止日让用户能认出是哪一批。 */
function todoBulkSamples(items) {
  return items.slice(0, TODO_BULK_SAMPLE_LIMIT).map((item) => ({
    id: item.id,
    title: item.title,
    ...(item.deadline ? { deadline: item.deadline } : {}),
  }));
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

  /**
   * 待办查询的「非完成态」条件：批量范围与 locate 共用这一份。
   *
   * 为什么不复制两份 filter 表：`scope:'completed'` 与老路径 `filters.completed` 如果各写一套，
   * 迟早出现"预览说 2 条、执行删 3 条"的漂移。完成态由调用方单独决定（见 todoListFilters / todoBulkTargets）。
   */
  function todoBaseFilters(draft) {
    const filters = draft.filters ?? {};
    return {
      from: filters.from,
      to: filters.to,
      priority: filters.priority,
      keyword: filters.keyword,
      category: filters.category,
      parentId: filters.parentId,
    };
  }

  /** 老路径（关键词/日期/单 id）的完成态默认值：完成默认找未完成，取消完成默认找已完成。 */
  function todoListFilters(draft) {
    const filters = draft.filters ?? {};
    const completed = draft.action === 'complete' ? false : draft.action === 'uncomplete' ? true : undefined;
    return { ...todoBaseFilters(draft), completed: filters.completed ?? completed };
  }

  /** 按 filters 定位待操作记录；id 优先。三个集合的过滤条件形状一致，但各自独立查询。 */
  function locate(draft) {
    const filters = draft.filters ?? {};
    if (draft.target === 'todo') {
      if (filters.id) return [todos.get(filters.id)];
      return todos.list(todoListFilters(draft));
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
   * 按 scope 算待办目标集合。
   *
   * 核心口径：**先走与 locate 相同的 `todos.list()` 过滤，再按 scope 收窄**。
   * 不直接拿整库 id 去批量服务里筛，是因为服务层的 bulk 只认显式 id，不懂"已完成 / 学堂同步"
   * 这些业务范围；而如果这里自己再实现一套"completed 怎么算、lms 怎么认"，
   * 又和 locate 的筛选漂移。两个问题合起来只有一个解法：目标集合由这里算一次，服务层只负责执行。
   */
  function todoBulkTargets(draft, scope) {
    const filters = draft.filters ?? {};

    if (scope === 'ids') {
      if (!Array.isArray(filters.ids) || !filters.ids.length) {
        throw HttpError.badRequest('filters.scope 为 ids 时必须同时给 filters.ids（待办 id 数组）', {
          field: 'filters.ids',
        });
      }
      const unique = [];
      for (const raw of filters.ids) {
        if (typeof raw !== 'string' || !raw.trim()) {
          throw HttpError.badRequest('filters.ids 不合法：每一项都必须是待办 id（字符串）', {
            field: 'filters.ids',
            code: 'INVALID_IDS',
          });
        }
        const id = raw.trim();
        if (!unique.includes(id)) unique.push(id);
      }
      const byId = new Map(todos.list().map((item) => [item.id, item]));
      const records = [];
      const skipped = [];
      for (const id of unique) {
        const item = byId.get(id);
        if (item) records.push(item);
        else skipped.push({ id, reason: 'not_found' });
      }
      return { records, ids: records.map((item) => item.id), skipped };
    }

    const listFilters = todoBaseFilters(draft);
    if (scope === 'completed') listFilters.completed = true;
    else if (scope === 'incomplete') listFilters.completed = false;
    // all / lms / manual 允许再带一个显式 completed 条件（例如"学堂同步里还没做的"），
    // 但**不套用 complete 动作的"默认只看未完成"**：scope 已经是调用方明说的范围，不能再被动作偷偷收窄。
    else if (filters.completed !== undefined) listFilters.completed = filters.completed;

    let records = todos.list(listFilters);
    if (scope === 'lms') records = records.filter(isLmsTodo);
    else if (scope === 'manual') records = records.filter((item) => !isLmsTodo(item));
    return { records, ids: records.map((item) => item.id), skipped: [] };
  }

  /**
   * 按范围删除 / 完成 / 取消完成待办：**一个动作、一条草稿**。
   *
   * 为什么必须走服务层的 `todos.bulk()` 而不是在指令层循环 `setCompleted/remove`：
   *   - 删父不级联删子、父完成级联完成子并写 `autoCompletedBy`、取消完成只回滚被级联项，
   *     这些语义都只维护在服务层；循环单条调用等于把同一套规则再实现一遍，迟早漂移；
   *   - 逐条执行还会把"一个动作"拆成 N 次写库与 N 次广播，用户看到的回执条数也不对。
   *
   * 超过 200 条时分批**顺序**执行，每批仍然是一次 `todos.bulk()`（见 TODO_BULK_BATCH 的注释）。
   * 某一批失败会抛错并中止后续批次：已提交的批次无法回滚，但绝不静默吞掉失败、假装全部完成。
   */
  async function todoBulk(draft, options, scope) {
    if (!TODO_BULK_SCOPES.includes(scope)) {
      throw HttpError.badRequest(`filters.scope 不合法：可选 ${TODO_BULK_SCOPES.join(' / ')}`, {
        field: 'filters.scope',
        allowed: [...TODO_BULK_SCOPES],
      });
    }
    const action = draft.action;
    if (!['delete', 'complete', 'uncomplete'].includes(action)) {
      throw HttpError.badRequest(`待办范围操作不支持 action: ${action}`, { field: 'action' });
    }

    const { records, ids, skipped: missing } = todoBulkTargets(draft, scope);
    const count = records.length;
    const label = todoBulkScopeLabel(scope, count);
    const batches = ids.length ? Math.ceil(ids.length / TODO_BULK_BATCH) : 0;
    const batchNote = batches > 1
      ? `；服务层单批最多 ${TODO_BULK_BATCH} 条，将分 ${batches} 批顺序执行`
      : '';
    const verb = TODO_BULK_ACTION_LABEL[action];

    if (options.dryRun) {
      /**
       * 写回草稿本身，理由与日程批量删除相同：确认卡只渲染 `draft.warnings`。
       * 预览**不调用**服务层 bulk：这里已经拿到真实目标集合，再跑一次 dryRun 既多一次全量查询，
       * 也拿不到 deadline（服务层 sample 只有 id/title），而用户正是靠截止日确认"选对了吗"。
       */
      const warnings = applyDraftWarnings(draft, todoBulkWarnings(action, scope, count));
      return {
        dryRun: true,
        planned: 'bulk',
        action,
        scope,
        count,
        samples: todoBulkSamples(records),
        warnings,
        ...(batches > 1 ? { batchCount: batches, batchSize: TODO_BULK_BATCH } : {}),
        explain: count
          ? `将${verb} ${count} 条待办（范围：${label}）${batchNote}`
          : `没有符合条件的待办（范围：${label}）`,
      };
    }

    if (!ids.length) {
      const warnings = applyDraftWarnings(draft, []);
      const skippedText = missing.length ? `，跳过 ${missing.length} 条不存在的` : '';
      return {
        planned: 'bulk',
        action,
        scope,
        count: 0,
        matched: 0,
        ...(action === 'delete' ? { deleted: 0 } : {}),
        changed: 0,
        skipped: missing,
        ...(action === 'delete' ? { detachedChildren: [] } : { cascaded: { completed: [], reverted: [] } }),
        warnings,
        explain: `没有符合条件的待办（范围：${label}）${skippedText}`,
      };
    }

    const totals = {
      matched: 0,
      changed: 0,
      skipped: [...missing],
      cascaded: { completed: [], reverted: [] },
      detachedChildren: [],
    };
    for (let start = 0; start < ids.length; start += TODO_BULK_BATCH) {
      const result = await todos.bulk({
        action,
        ids: ids.slice(start, start + TODO_BULK_BATCH),
      });
      totals.matched += result.matched ?? 0;
      totals.changed += result.changed ?? 0;
      if (Array.isArray(result.skipped)) totals.skipped.push(...result.skipped);
      if (Array.isArray(result.detachedChildren)) totals.detachedChildren.push(...result.detachedChildren);
      if (Array.isArray(result.cascaded?.completed)) totals.cascaded.completed.push(...result.cascaded.completed);
      if (Array.isArray(result.cascaded?.reverted)) totals.cascaded.reverted.push(...result.cascaded.reverted);
    }
    totals.detachedChildren = [...new Set(totals.detachedChildren)];
    /**
     * 只报**最终真的独立**的子任务。
     *
     * 删父不级联删子，服务层会先解除直接子级的 parentId；但如果子任务自己也在这批目标里，
     * 它随后（同批或下一批）就被删掉了，回执还说"N 个子任务改为独立待办"就是在报一个
     * 用户永远看不到的中间状态。分批执行时父/子被切到两批尤其容易触发。
     */
    const targetIds = new Set(ids);
    totals.detachedChildren = totals.detachedChildren.filter((id) => !targetIds.has(id));
    totals.cascaded.completed = [...new Set(totals.cascaded.completed)];
    totals.cascaded.reverted = [...new Set(totals.cascaded.reverted)];

    const actual = totals.changed;
    // 用**实际执行后的条数**替换预览阶段的警告（全等去重会把预览数字留成过期值）。
    // 完成 / 取消完成用目标条数：`全部 N 条` 说的是范围，实际变更条数由 explain 单独报，
    // 否则"全部 4 条里完成了 2 条"会被写成自相矛盾的"全部 2 条"。
    const warningCount = action === 'delete' ? actual : count;
    const warnings = applyDraftWarnings(draft, todoBulkWarnings(action, scope, warningCount));
    const doneLabel = action === 'delete' ? '已删除' : action === 'complete' ? '已完成' : '已取消完成';
    const tail = [];
    if (batches > 1) tail.push(`分 ${batches} 批执行`);
    if (action === 'delete' && totals.detachedChildren.length) {
      tail.push(`${totals.detachedChildren.length} 个子任务改为独立待办`);
    }
    if (action === 'complete' && totals.cascaded.completed.length) {
      tail.push(`并连带完成 ${totals.cascaded.completed.length} 个子任务`);
    }
    if (action === 'uncomplete' && totals.cascaded.reverted.length) {
      tail.push(`并恢复 ${totals.cascaded.reverted.length} 个被连带完成的子任务`);
    }
    /**
     * 把最关键的范围提醒也写进 explain。
     *
     * 为什么不止放 `warnings`：auto 档回灌给模型的「紧凑执行结果」只保留
     * `explain/deleted/affected…`，不包含 warnings 数组（见 chat-service 的 #compactWriteResult）。
     * 学堂范围如果只写 warnings，模型下一轮就只看到"已删除 N 条"，很可能漏掉
     * "下次同步会回来"这句用户最需要知道的话。explain 是模型一定会读到的字段。
     */
    if (scope === 'all' && action === 'delete' && actual) tail.push('含你自己建的');
    if (scope === 'lms' && actual) {
      tail.push(action === 'delete'
        ? '这些是学堂同步的，下次同步会重新生成'
        : '这些是学堂同步的，只改本地状态');
    }
    if (totals.skipped.length) tail.push(`跳过 ${totals.skipped.length} 条（不存在或状态已符合）`);
    const explain = actual
      ? `${doneLabel} ${actual} 条待办（范围：${label}）${tail.length ? `，${tail.join('，')}` : ''}`
      : `没有需要${verb}的待办（范围：${label}）${tail.length ? `，${tail.join('，')}` : ''}`;

    return {
      planned: 'bulk',
      action,
      scope,
      count: actual,
      matched: totals.matched,
      ...(action === 'delete' ? { deleted: actual } : {}),
      changed: actual,
      skipped: totals.skipped,
      ...(action === 'delete' ? { detachedChildren: totals.detachedChildren } : { cascaded: totals.cascaded }),
      ...(batches > 1 ? { batchCount: batches, batchSize: TODO_BULK_BATCH } : {}),
      warnings,
      explain,
    };
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
       * 按范围删除：日程与待办各有一套明确的范围词汇（日程看时间/来源，待办看完成态/来源）。
       * `filters.scope`（或只有 `filters.ids`）出现时整件事是**一个批量动作**，
       * 不再走下面"先 locate 再逐条"的老路径；没有 scope 的关键词/日期删除保持原行为。
       * 日历事件不在这条路径上：批量删事件需要先想清楚范围语义，不能顺手开。
       */
      if (draft.target === 'schedule') {
        const scope = bulkScopeOf(draft.filters);
        if (scope) return deleteScheduleBulk(draft, options, scope);
      }
      if (draft.target === 'todo') {
        const scope = todoBulkScopeOf(draft.filters);
        if (scope) return todoBulk(draft, options, scope);
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
      /**
       * 批量完成（"把未完成的待办全部完成"）：与删除共用同一套 scope / 回执 / 警告。
       * 服务层 bulk 的 complete 走 `update()`，所以父完成级联子、`autoCompletedBy` 标记一个都不会少。
       */
      const scope = todoBulkScopeOf(draft.filters);
      if (scope) return todoBulk(draft, options, scope);
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

    /**
     * 取消完成：同样只对待办成立。
     *
     * 单条路径与服务层 `setCompleted(false)` 一致：只回滚 `autoCompletedBy === 父` 的后代，
     * 用户亲手勾过的子任务保持完成。按范围的路径复用 todoBulk，避免两套撤销语义。
     */
    async uncomplete(draft, options) {
      if (draft.target !== 'todo') {
        const label = labelOf(draft.target);
        throw HttpError.badRequest(
          `${label}没有完成态，取消完成只属于待办：日程与日历事件都没有可撤销的完成状态`,
          { field: 'target' },
        );
      }
      const scope = todoBulkScopeOf(draft.filters);
      if (scope) return todoBulk(draft, options, scope);
      const matches = locate(draft);
      if (!matches.length) throw HttpError.notFound('没有找到符合条件的待办');
      if (options.dryRun) {
        return { dryRun: true, planned: { action: 'uncomplete', target: 'todo', ids: matches.map((m) => m.id) } };
      }
      const updated = [];
      const cascaded = { completed: [], reverted: [] };
      for (const match of matches) {
        const item = await todos.setCompleted(match.id, false);
        updated.push(item);
        cascaded.reverted.push(...(item.cascaded?.reverted ?? []));
      }
      const extra = cascaded.reverted.length ? `，并恢复 ${cascaded.reverted.length} 个被连带完成的子任务` : '';
      return {
        items: updated,
        affected: updated.map((item) => ({ id: item.id, title: item.title, date: item.deadline })),
        changed: updated.length,
        cascaded,
        ambiguous: matches.length > 1,
        explain: `已取消完成 ${updated.length} 条待办${extra}`,
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
