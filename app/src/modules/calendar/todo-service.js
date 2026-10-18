/**
 * 待办服务（Todo）。
 *
 * 领域模型（对齐 PotatoCalendar 的 `TodoItem`）：
 * - **待办是独立实体**：`deadline`（截止日，**可选**）+ 预估工时 + 优先级 + 完成态；
 * - **日程是时段**：有起止时刻，没有完成态；
 * - **日历事件是日期/区间粒度**：假期、考试周、纪念日，也没有完成态。
 *
 * 与旧实现的区别：待办不再用 `Schedule` 的 `allDay` + `status` 冒充。旧模型里
 * 「完成」这种语义被硬塞进日程，导致「完成一场会议」这种无意义操作；现在
 * `completed` 只存在于本服务，日程与事件都没有完成态。
 *
 * 派生字段（`isOverdue` / `isToday` / `daysRemaining` / `complexity` / `complexityLabel`）
 * 只出现在响应里，不落库：它们随「今天」变化，存下来必然过期。
 *
 * 分类与父子分级（2026-10 追加）
 * ----------------------------
 * - `category` 是**自由文本**（≤24 字），不是枚举：分类是用户自己的语言（"期末复习"、
 *   "实验室"），预设一套枚举等于逼用户改词。空串 = 未分类，所以它永远存在、永远可筛。
 * - `parentId` 表达「一件事拆成几步」：父/子/孙最多 **3 层**。限 3 层的理由见 `MAX_DEPTH`。
 * - `autoCompletedBy` 是**系统维护的标记**：父完成时被连带完成的后代记下「是谁把我带完成的」，
 *   取消完成父时只回滚这一批（详见 `#revertCascade` 的注释）。
 * - `childCount` / `childDoneCount` / `hasChildren` 是派生字段（只算**直接子级**），不落库：
 *   它们随任何一次子任务变更变化，存下来必然过期。
 */

import { HttpError } from '../../core/http/router.js';
import { addDays, todayKey } from '../../shared/time.js';
import { enumValue, intValue, optionalText, pickDefined, requireTitle, stringArray } from '../../core/validate.js';
import { complexityOfHours, numberValue, requireDate } from './schema.js';
import { isoWeekday } from './recurrence.js';

/** 复杂度中文标签（阈值见 schema.complexityOfHours，与 PotatoCalendar 一致）。 */
export const COMPLEXITY_LABEL = { simple: '简单', normal: '一般', complex: '复杂', heavy: '繁琐' };

const SOURCES = ['manual', 'command', 'ai', 'import'];
/** 预估工时上限（30 天 × 24 小时），足够表达任何学习任务，同时挡住脏数据。 */
const MAX_ESTIMATED_HOURS = 24 * 30;
/** 分类长度上限。24 个字足够说清「期末复习 / 实验室 / 英语六级」，再长就成备注了。 */
const MAX_CATEGORY_LENGTH = 24;
/**
 * 层级上限 3 层（父 / 子 / 孙）。
 *
 * 为什么是 3 而不是不限：
 * - **界面**：待办列表按「分类 → 顶层 → 子（缩进）」展示，每多一层就多一份缩进；
 *   手机上一屏只有 ~390px，第 4 层缩进完标题只剩十几个字的位置，等于不能用；
 * - **语义**：父子是"把一件事拆成几步"，3 层已经能表达「大目标 → 章节 → 小节」；
 *   再深的树用户自己也记不住有几个分支，反而比扁平列表更难勾；
 * - **级联**：完成父要连带所有后代，层数越深"误点完成"的波及面越大。3 层是一个
 *   既能拆开、又能一眼看全、还能安全撤销的边界。
 */
const MAX_DEPTH = 3;
/**
 * **只读字段**：由番茄钟（pomodoro 模块）在会话结算时累加，客户端一个字都不能改。
 *
 * 它们出现在 `KNOWN_FIELDS` 里（让乱写的人拿到"这是只读字段"的明确 400，而不是被
 * 当成未知字段去猜拼写），但**刻意不放进 `EDITABLE`**：
 * - `#rebuild` 用「当前记录 + patch」重建，只挑 EDITABLE —— 不在里面就不会被 patch 覆盖；
 * - 更新时 `normalize` 也不产出它，集合层的 merge 会原样保留已累计的秒数。
 * 如果放进 EDITABLE，普通改标题也会把它一起重建；一旦 normalize 给默认 0，
 * 用户攒了几小时的专注时长就会在改标题时被清零。
 */
const READONLY_FIELDS = ['spentSelfSec'];
/** 可写字段白名单：更新时用「当前记录 + patch」重建，避免未知字段落库。 */
const EDITABLE = [
  'title',
  'deadline',
  'estimatedHours',
  'priority',
  'completed',
  'completedAt',
  'description',
  'tags',
  'source',
  'externalId',
  'rolledFrom',
  'category',
  'parentId',
  // 系统在级联完成时写入。放进白名单不是为了"允许客户端随便设"，而是为了让
  // 「当前记录 + patch」重建时它不会被抹掉：否则改一次标题就把连带标记弄丢了，
  // 取消完成父时就再也找不到该回滚哪些子任务。
  'autoCompletedBy',
];

/**
 * 入参里**允许出现**的字段名（canonical 名，别名先过 `mapFieldName`）。
 *
 * - `estimatedMinutes` 不落库（会被换算成 `estimatedHours`），但必须在这里：它是**日程**的字段，
 *   而提示词、前端、模型都容易顺手把它写进待办（真机缺陷 S3 就是这么来的）。
 * - `id` 允许出现但**被忽略**：模型给 update 草稿时常把 id 一并塞进 `fields`，
 *   拿它定位可以，写进数据不行（那是另一条记录的主键，落进文件就是脏数据）。
 * - `spentSelfSec` 出现在这里只为给"只读"的明确报错（见 READONLY_FIELDS 的注释），
 *   它不在 EDITABLE 里，因此不是可写字段。
 */
const KNOWN_FIELDS = new Set([...EDITABLE, ...READONLY_FIELDS, 'estimatedMinutes', 'id']);

/** 报错时摆在最前面的字段清单（人/模型照着改一次就能对）。 */
const KNOWN_FIELD_LIST =
  'title / deadline（可选，不填就是“没有截止日”） / estimatedHours（小时，可小数；也收 estimatedMinutes，整数分钟） / priority / completed / description / tags / category / parentId（spentSelfSec 只读，由番茄钟维护）';

/**
 * 单个别名的归一化（不认识的键原样返回）。
 * `normalizeInput`（取值）与 `assertKnownFields`（判断认不认识）共用这一张表：
 * 各写一份的话，迟早出现"别名能转换、却被未知字段检查拦下"这种自相矛盾。
 */
function mapFieldName(key) {
  if (key === 'due_date' || key === 'dueDate' || key === 'date') return 'deadline';
  if (key === 'estimated_hours' || key === 'hours') return 'estimatedHours';
  if (key === 'done') return 'completed';
  if (key === 'notes' || key === 'note') return 'description';
  // 模型/表单常见两种写法：下划线，以及只写 parent。两者都归一化到 canonical 名，
  // 否则会出现"字段认不出来 → 400"，而调用方其实说对了语义。
  if (key === 'parent_id' || key === 'parent') return 'parentId';
  return key;
}

/**
 * 入参别名归一化。
 *
 * 刻意**不复用** compat.js 的 `normalizeAliases`：那张表属于 dschat 2 的单日事件形状，
 * 它把 `deadline` 映射成 `date`、把布尔的 `completed` 映射成 `status`，
 * 对「待办」来说两者都是错的方向（待办的截止日就写作 `deadline`，完成态就是布尔）。
 */
function normalizeInput(rawInput = {}) {
  const out = {};
  for (const [key, value] of Object.entries(rawInput)) out[mapFieldName(key)] = value;
  return out;
}

/** Levenshtein 距离（字段名都很短，这一小段足够，不值得引依赖）。 */
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(prev[j] + 1, current[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = current;
  }
  return prev[b.length];
}

/**
 * 语义分组：整个词都写错（不是拼错一两个字母）时，靠这层猜"他大概想说什么"。
 * 例：`due` → deadline、`status` → completed。
 * `category` 排在 `tags` 之前：`categor` 现在有**自己的**字段（分类），
 * 不能再被猜成 tags（那是加分类之前的口径）。
 */
const FIELD_GROUPS = [
  { match: /(minut|hour|dur|time|estimat|length)/i, suggest: ['estimatedHours', 'estimatedMinutes'] },
  { match: /(dead|due|date|day|when)/i, suggest: ['deadline'] },
  { match: /(titl|name|task|content|text)/i, suggest: ['title'] },
  { match: /(desc|note|remark|memo|detail|comment|备注|说明)/i, suggest: ['description'] },
  { match: /(done|finish|complete|status|check|state|完成)/i, suggest: ['completed'] },
  { match: /(prior|level|urgent|import|rank|优先)/i, suggest: ['priority'] },
  { match: /(categor|classif|分类)/i, suggest: ['category'] },
  { match: /(parent|child|subtask|sub_task|上级|父|子任务)/i, suggest: ['parentId'] },
  { match: /(tag|kind|type|group|label|标签)/i, suggest: ['tags'] },
  { match: /(source|origin|origi|from)/i, suggest: ['source'] },
];

/**
 * 明明属于**日程**（或历史遗留）的字段被写到待办上时，给一句更具体的解释。
 * 这类错误光说"不认识"没用：调用方要知道"那我该用哪个 target / 哪个字段"。
 */
const FOREIGN_HINTS = {
  startTime: '待办只有截止日、没有时刻：要记"几点到几点"请用 target: "schedule"',
  endTime: '待办没有结束时刻：要记起止时间请用 target: "schedule"',
  location: '待办没有地点：要记地点请用 target: "schedule"（或写进 description）',
  reminders: '待办没有提醒：提醒属于日程（target: "schedule"）',
  repeat: '待办不支持重复：重复规则属于日程（target: "schedule"）',
  status: '待办的完成态字段是 completed（布尔），没有 status',
  allDay: '待办本来就是"某天之前要打勾的事"，没有 allDay',
  completed_at: '完成时间由系统维护（completedAt），不需要传',
};

/** 「你是不是想用 X」：先给拼写最近的，再用语义分组补一个（最多两个，别把提示塞满）。 */
function suggestFields(name) {
  const lowered = String(name).toLowerCase();
  const near = [...KNOWN_FIELDS]
    .filter((field) => field !== 'id')
    .map((field) => ({ field, distance: editDistance(lowered, field.toLowerCase()) }))
    .filter((entry) => entry.distance <= 2)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 2)
    .map((entry) => entry.field);
  const group = FIELD_GROUPS.find((entry) => entry.match.test(lowered));
  if (!group) return near;
  return [...near, ...group.suggest.filter((field) => !near.includes(field))].slice(0, 2);
}

/**
 * 未知字段**必须报错**，而不是静默丢掉。
 *
 * 为什么（真机缺陷 S3 的教训）：提示词把待办的预估工时写成 `estimatedMinutes`，而服务端只认
 * `estimatedHours` —— 未知键被静默丢弃，用户说"预计两小时"、落库变成默认 1 小时，全程没有任何
 * 报错，用户和模型都以为记对了。**字段名写错 = 用户说的话被丢掉**，这种损失必须当场可见。
 *
 * 只对**写入**生效：读取没有"字段"可写。建议尽量"就近"（拼写距离 + 语义分组），
 * 因为调用方看不到我们的字段清单，报错里直接告诉它该用哪个键，下一轮就能改对；
 * 只说"未知字段 x"，它多半会换个名字继续猜。
 */
function assertKnownFields(rawInput = {}) {
  const unknown = [];
  for (const key of Object.keys(rawInput)) {
    const mapped = mapFieldName(key);
    if (!KNOWN_FIELDS.has(mapped)) unknown.push({ field: key, mapped });
  }
  if (!unknown.length) return;

  const suggestions = unknown.map(({ field, mapped }) => {
    const suggest = suggestFields(mapped);
    const hint = FOREIGN_HINTS[mapped];
    return { field, ...(suggest.length ? { suggest } : {}), ...(hint ? { hint } : {}) };
  });
  const [first] = suggestions;
  // advice 里不带句末标点：hint 与建议两种句式共用同一句收尾，拼出来的错误信息才读得通
  const advice = first.hint ?? (first.suggest?.length ? `你是不是想用 ${first.suggest.join(' / ')}` : '请检查拼写');
  throw HttpError.badRequest(
    `字段 ${first.field} 不是待办认识的字段：${advice}。待办字段：${KNOWN_FIELD_LIST}`,
    {
      field: first.field,
      unknownFields: suggestions.map((item) => item.field),
      suggestions,
    },
  );
}

/**
 * 某个入参键（含别名）是不是待办认得的？
 *
 * 给**兼容层**用（calendar/routes.js 的 dschat PATCH）：那边收到的是 dschat 的事件形状，
 * 里面本来就带 `start_time` / `all_day` / `repeat*` 这些"待办根本没有"的装饰字段。
 * 适配层负责在进入严格校验之前把它们滤掉，否则 dschat 客户端的读-改-写会整条失败。
 * 域内接口（/todos、指令、AI 草稿）不走这里 —— 它们必须**如实报错**，见 assertKnownFields。
 */
export function isTodoInputField(key) {
  return KNOWN_FIELDS.has(mapFieldName(String(key)));
}

/** 布尔字段：接受 true/false 与 'true'/'false'/'1'/'0'（HTTP query 里都是字符串）。 */
function booleanValue(value, field, { optional = true, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return fallback;
    throw HttpError.badRequest(`字段 ${field} 必填`, { field });
  }
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  throw HttpError.badRequest(`字段 ${field} 不合法：必须是布尔值`, { field });
}

/**
 * 分钟 → 小时（待办落库只认小时）：保留一位小数（120 → 2、90 → 1.5）。
 * 正数不抹成 0：1 分钟也是要花的时间，落成 0 小时会让"复杂度/计划工时"统计失真。
 */
function minutesToHours(minutes) {
  if (!(minutes > 0)) return 0;
  return Math.max(0.1, Number((minutes / 60).toFixed(1)));
}

/**
 * 父级 id 的形状归一化：`''` / 空白 → null（顶层）。
 *
 * 为什么不接受数字：id 是 UUID 字符串，传数字几乎一定是调用方把别的字段
 * （例如优先级、序号）错塞进了 parentId —— 静默 String() 会把它变成一个
 * **永远找不到的父级**，比当场报错更难排查。
 */
function normalizeParentId(value) {
  if (typeof value !== 'string') {
    throw HttpError.badRequest('字段 parentId 不合法：必须是父待办的 id（字符串）或 null（表示顶层）', {
      field: 'parentId',
      code: 'PARENT_INVALID',
    });
  }
  const id = value.trim();
  return id || null;
}

function normalize(rawInput, { partial = false } = {}) {
  // 未知字段先拦（理由见 assertKnownFields）：写错的字段名 = 用户说的话被丢掉，
  // 必须当场 400 并给出"你是不是想用 X"，而不是静默忽略后落一个默认值。
  assertKnownFields(rawInput);
  const input = normalizeInput(rawInput);
  const data = {};

  /**
   * 只读字段就算"认识"也不能写：明确 400，而不是静默丢掉。
   *
   * 为什么不是默默忽略：客户端传 `spentSelfSec` 只可能有两个意图 —— 补录/迁移，或
   * 试图把统计改成好看的数。两种都不该由这条接口决定；告诉它"这是番茄钟自动累计的"
   * 比假装写成功更诚实，也不会让用户以为自己的补录生效了。
   */
  for (const field of READONLY_FIELDS) {
    if (input[field] !== undefined) {
      throw HttpError.badRequest(`字段 ${field} 是只读的：由番茄钟在会话结算时自动累计，不能直接修改`, {
        field,
        code: 'READONLY_FIELD',
      });
    }
  }

  if (input.title !== undefined) data.title = requireTitle(input.title);
  else if (!partial) data.title = requireTitle(undefined);

  /**
   * `deadline` 是**可选**的：`null` / `''` / 不传都表示“没有截止日”。
   *
   * 为什么放开：生活里大量待办本来就"想做，但不赶时间"（买牙膏、看完某本书）。
   * 以前必填只能逼用户随便挑一天，于是逾期统计被垃圾日期污染 —— 那比没有截止日更糟。
   * 显式传 `null` / `''` 在 PATCH 里是**清空**（不是"不改"）：两者语义必须能区分，
   * 否则用户没法把已经填过的日期去掉。
   */
  if (input.deadline === null || input.deadline === '') data.deadline = null;
  else if (input.deadline !== undefined) data.deadline = requireDate(input.deadline, 'deadline');
  else if (!partial) data.deadline = null;

  /**
   * 预估工时：待办的领域字段是 `estimatedHours`（小时，可小数），但 `estimatedMinutes`
   * 是**日程**的字段、也是模型最容易顺手写进来的那个（真机缺陷 S3：提示词里就写着 estimatedMinutes，
   * 服务端只认 estimatedHours，120 分钟被静默丢掉、落库成了默认 1 小时）。
   * 所以两种写法都收：分钟 ÷ 60 保留一位小数。原字段的语义一个字都不改。
   */
  const hasHours = input.estimatedHours !== undefined && input.estimatedHours !== null && input.estimatedHours !== '';
  const hasMinutes = input.estimatedMinutes !== undefined && input.estimatedMinutes !== null && input.estimatedMinutes !== '';
  if (hasHours && hasMinutes) {
    // 同一件事的两种口径给出两个值 = 调用方自己没说清，猜哪个都可能丢数据（原则同 assertKnownFields）
    throw HttpError.badRequest('字段 estimatedHours 与 estimatedMinutes 不能同时传：它们是同一个语义的两种写法，只传一个', {
      field: 'estimatedHours',
      alsoGiven: 'estimatedMinutes',
    });
  }
  if (hasHours) {
    data.estimatedHours = numberValue(input.estimatedHours, 'estimatedHours', {
      min: 0,
      max: MAX_ESTIMATED_HOURS,
      optional: true,
      fallback: 1,
    });
  } else if (hasMinutes) {
    const minutes = intValue(input.estimatedMinutes, 'estimatedMinutes', {
      min: 0,
      max: MAX_ESTIMATED_HOURS * 60,
      optional: false,
    });
    data.estimatedHours = minutesToHours(minutes);
  } else if (!partial) data.estimatedHours = 1;

  if (input.priority !== undefined) {
    data.priority = intValue(input.priority, 'priority', { min: 0, max: 2, optional: true, fallback: 0 });
  } else if (!partial) data.priority = 0;

  if (input.completed !== undefined) data.completed = booleanValue(input.completed, 'completed');
  else if (!partial) data.completed = false;
  // completedAt 允许 null（显式「没有完成时间」），因此这里不能只判断 undefined
  if (input.completedAt === null) data.completedAt = null;

  if (input.description !== undefined) data.description = optionalText(input.description, 'description') ?? '';
  if (input.tags !== undefined) data.tags = stringArray(input.tags, 'tags') ?? [];
  else if (!partial) data.tags = [];

  /**
   * 分类：自由文本、≤24 字、空串 = 未分类。
   * 这里**不做枚举校验**（理由见文件头）：用户写「期末复习」就是「期末复习」，
   * 服务端只保证类型与长度，不猜、也不替他把词改成某个内置分类。
   * `null` 与 `''` 都落成 `''`：两者在用户心里是同一件事（没分类），
   * 存成一个值，筛选与计数就只有一种口径。
   */
  if (input.category === null) data.category = '';
  else if (input.category !== undefined) data.category = optionalText(input.category, 'category', MAX_CATEGORY_LENGTH) ?? '';
  else if (!partial) data.category = '';

  /**
   * 父待办：null = 顶层。这里只做**形状**校验（字符串 / null）。
   * 「父是否存在 / 会不会成环 / 会不会超 3 层」需要看整个集合，交给 `#assertParent`：
   * `normalize` 是纯函数（create / dryRun 预览 / update 重建都复用它），不该在里头读库。
   */
  if (input.parentId === null) data.parentId = null;
  else if (input.parentId !== undefined) data.parentId = normalizeParentId(input.parentId);
  else if (!partial) data.parentId = null;

  // 系统标记：同样允许显式置 null（取消完成时由 #rebuild 统一清掉）
  if (input.autoCompletedBy === null) data.autoCompletedBy = null;
  else if (input.autoCompletedBy !== undefined) data.autoCompletedBy = normalizeParentId(input.autoCompletedBy);

  if (input.source !== undefined) {
    data.source = enumValue(input.source, SOURCES, 'source', { optional: true, fallback: 'manual' });
  } else if (!partial) data.source = 'manual';

  if (input.externalId !== undefined) data.externalId = input.externalId === null ? null : String(input.externalId);
  // completedAt 由服务在「完成态变化」时统一维护，但更新时必须能原样带过（否则改标题会刷新完成时间）
  if (input.completedAt !== undefined) data.completedAt = input.completedAt;
  if (input.rolledFrom !== undefined) data.rolledFrom = input.rolledFrom;

  return data;
}

/** 直接子级的派生统计（没有子级时的常量，省一次分配）。 */
const NO_CHILDREN = Object.freeze({ count: 0, done: 0 });

/**
 * `parentId -> { count, done }` 索引（只算直接子级）。
 *
 * 只建**一份**、list 里复用：逐条去 filter 整个集合会退化成 O(n²)，
 * 待办上几百条时列表会肉眼可见地卡。只算直接子级而不是全部后代：
 * 父行上那个 `2/3` 是"我这一步拆成了几步、勾完几步"，
 * 把孙辈也算进去会和子行自己的进度重复表达。
 */
function childStatsIndex(records) {
  const index = new Map();
  for (const record of records) {
    if (!record.parentId) continue;
    const stat = index.get(record.parentId) ?? { count: 0, done: 0 };
    stat.count += 1;
    if (record.completed) stat.done += 1;
    index.set(record.parentId, stat);
  }
  return index;
}

/**
 * 某条待办的**子树高度**（1 = 叶子）。用来判断"把整棵子树挪到某个父级下"会不会超层：
 * 只看被移动的那一条是不够的，它的后代也跟着往下沉。
 */
function subtreeHeight(id, byId) {
  const byParent = new Map();
  for (const item of byId.values()) {
    if (!item.parentId) continue;
    const list = byParent.get(item.parentId) ?? [];
    list.push(item.id);
    byParent.set(item.parentId, list);
  }
  let height = 1;
  let frontier = [id];
  const seen = new Set([id]);
  while (frontier.length) {
    const next = [];
    for (const parent of frontier) {
      for (const child of byParent.get(parent) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        next.push(child);
      }
    }
    if (!next.length) break;
    height += 1;
    frontier = next;
  }
  return height;
}

/**
 * `id -> 自己 + 全部后代` 的专注秒数（`spentSec`）。
 *
 * 为什么现算而不是把秒数写进祖先：
 * - 番茄钟只把 N 秒写进**当前待办**的 `spentSelfSec`。如果同时给每一层祖先的
 *   `spentSec` 也加 N，那么"父任务自己专注 100 秒、子任务专注 50 秒"时，父的
 *   存储值会是 100 + 50，而它再被汇总到祖父时又会被加一次 —— 多层就是重复累计；
 * - 父子关系可以移动、子任务可以删除。写死的聚合值在移动/删除后必然过期，
 *   而派生值每次都按当前树重算，天然不会留下"祖父多了 30 分钟"这种脏数字。
 *
 * 算法：每条记录的 `spentSelfSec` 沿 parentId 往上加，最多 3 层；用 `seen` 防历史
 * 脏数据成环时死循环。O(n × 深度)，在待办量级下可忽略。
 */
function spentStatsIndex(records) {
  const byId = new Map(records.map((item) => [item.id, item]));
  const index = new Map();
  for (const record of records) {
    const own = Math.max(0, Math.round(Number(record.spentSelfSec) || 0));
    let cursor = record;
    const seen = new Set();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      index.set(cursor.id, (index.get(cursor.id) ?? 0) + own);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
    }
  }
  return index;
}

/** 只出现在响应里的派生字段。 */
function decorate(item, today, children = NO_CHILDREN, spentSec = 0) {
  const hours = item.estimatedHours ?? 1;
  const complexity = complexityOfHours(hours);
  return {
    ...item,
    // 取消完成时显式落 null（集合层会把 undefined 当「不修改」）
    completedAt: item.completedAt ?? null,
    // 老记录没有分类/父级：响应里补成稳定的默认值，前端不必到处写 `?? ''`
    category: item.category ?? '',
    parentId: item.parentId ?? null,
    autoCompletedBy: item.autoCompletedBy ?? null,
    // 番茄钟累计的**自己的**专注秒数（落库；只读，见 READONLY_FIELDS）
    spentSelfSec: Math.max(0, Math.round(Number(item.spentSelfSec) || 0)),
    // 派生：自己 + 全部后代，**实时**计算（存下来会在移动/删除子任务后过期）
    spentSec: Math.max(0, Math.round(Number(spentSec) || 0)),
    // 派生：只算直接子级，且是**实时**算的（存下来必然过期）
    childCount: children.count,
    childDoneCount: children.done,
    hasChildren: children.count > 0,
    // 没有截止日 = 不逾期、不是今天、没有剩余天数（`null` 而不是 0：0 天会被读成"今天到期"）
    isOverdue: Boolean(item.deadline) && !item.completed && item.deadline < today,
    isToday: Boolean(item.deadline) && item.deadline === today,
    daysRemaining: item.deadline ? Math.round((new Date(item.deadline) - new Date(today)) / 86400000) : null,
    complexity,
    complexityLabel: COMPLEXITY_LABEL[complexity] ?? '',
  };
}

export class TodoService {
  constructor({ store, broadcast = () => {} }) {
    this.store = store;
    this.broadcast = broadcast;
  }

  get collection() {
    return this.store.todos;
  }

  /** 全部未删除的待办（待办是硬删除，`deletedAt` 只作为同步/迁移的兜底判断）。 */
  #alive() {
    return this.collection.all().filter((item) => !item.deletedAt);
  }

  /**
   * 父级合法性：**存在 / 不成环 / 不超 3 层**。
   *
   * 三层校验缺一不可：
   * - 不存在 → 子任务会在树里彻底消失（悬空 parentId），所以当场 400 并给 PARENT_NOT_FOUND；
   * - 成环 → 树形遍历永远走不完，界面与 AI 都会卡死，必须从写入端拒绝；
   * - 超 3 层 → 见 MAX_DEPTH 的理由（界面缩进、语义、级联波及面）。
   *
   * `selfId` 只在更新时给：新建还没有 id，谈不上"自己当自己的父"。
   */
  #assertParent(parentId, { selfId = null } = {}) {
    if (!parentId) return;
    const byId = new Map(this.#alive().map((item) => [item.id, item]));
    const parent = byId.get(parentId);
    if (!parent) {
      throw HttpError.badRequest(`父待办不存在（或已删除）：${parentId}`, {
        field: 'parentId',
        code: 'PARENT_NOT_FOUND',
        parentId,
      });
    }

    // 从候选父往上走：走回自己 = 成环（自己、自己的后代都不能当父）
    let cursor = parent;
    let depth = 0; // 候选父自身的层级（顶层 = 1）
    const seen = new Set();
    while (cursor) {
      if (selfId && cursor.id === selfId) {
        throw HttpError.badRequest('字段 parentId 不能指向自己或自己的子任务：那会形成环', {
          field: 'parentId',
          code: 'PARENT_CYCLE',
          parentId,
        });
      }
      // 库里已经有环（历史脏数据 / 同步合并而来）：别在这里死循环，按"最多 3 层"照常判
      if (seen.has(cursor.id)) break;
      seen.add(cursor.id);
      depth += 1;
      cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
    }

    if (depth + 1 > MAX_DEPTH) {
      throw HttpError.badRequest(
        `层级最多 ${MAX_DEPTH} 层（父 / 子 / 孙）：这条会落到第 ${depth + 1} 层，请挂到更靠上的待办，或改成同级`,
        { field: 'parentId', code: 'PARENT_TOO_DEEP', maxDepth: MAX_DEPTH, depth: depth + 1, parentId },
      );
    }
    // 移动一棵**子树**时，新父不仅要让自己放得下，也要让整棵子树放得下：
    // 例如把「父 → 子 → 孙」整体挂到第 2 层，孙辈就成第 4 层了。
    // 只校验自己那一层是不够的 —— 那会留下一个查不到、但确实超过 3 层的树。
    if (selfId) {
      const height = subtreeHeight(selfId, byId);
      if (depth + height > MAX_DEPTH) {
        throw HttpError.badRequest(
          `层级最多 ${MAX_DEPTH} 层：这条待办下面还有 ${height - 1} 层子任务，挂到第 ${depth + 1} 层会让最深的变成第 ${depth + height} 层`,
          { field: 'parentId', code: 'PARENT_TOO_DEEP', maxDepth: MAX_DEPTH, depth: depth + 1, subtreeHeight: height, parentId },
        );
      }
    }
  }

  /** 直接子级（存活记录）。 */
  #childrenOf(id) {
    return this.#alive().filter((item) => item.parentId === id);
  }

  /**
   * 全部后代（BFS，由近到远，最多 MAX_DEPTH 层）。
   * 写入端已经保证不成环，这里仍用 `seen` 兜底：历史脏数据不该让一次完成/删除操作死循环。
   */
  #descendantsOf(id) {
    const byParent = new Map();
    for (const item of this.#alive()) {
      if (!item.parentId) continue;
      const list = byParent.get(item.parentId) ?? [];
      list.push(item);
      byParent.set(item.parentId, list);
    }
    const out = [];
    const seen = new Set([id]);
    const queue = [...(byParent.get(id) ?? [])];
    while (queue.length) {
      const next = queue.shift();
      if (seen.has(next.id)) continue;
      seen.add(next.id);
      out.push(next);
      queue.push(...(byParent.get(next.id) ?? []));
    }
    return out;
  }

  /** 单条记录的响应形状（含直接子级统计 + 自己与后代的专注秒数）。 */
  #decorate(item) {
    const alive = this.#alive();
    return decorate(item, todayKey(), childStatsIndex(alive).get(item.id), spentStatsIndex(alive).get(item.id));
  }

  /**
   * 待办列表。
   *
   * @param {object} [filters]
   * @param {string} [filters.date]       截止日 = 该日
   * @param {string} [filters.from]       截止日 >= from
   * @param {string} [filters.to]         截止日 <= to
   * @param {boolean|string} [filters.completed] 完成态精确过滤
   * @param {number|string} [filters.priority]   优先级精确过滤
   * @param {boolean|string} [filters.overdue]   true = 未完成且 deadline < 今天（无截止日的不算逾期）
   * @param {boolean|string} [filters.noDeadline] true = 只看没有截止日的待办
   * @param {string} [filters.keyword]    标题 / 备注 / 标签模糊匹配
   * @param {string} [filters.category]   分类精确过滤（空串 = 只看未分类）
   * @param {string} [filters.parentId]   父待办 id；`root` = 只看顶层
   * @param {number|string} [filters.limit]
   */
  list({ date, from, to, completed, priority, overdue, noDeadline, keyword, category, parentId, limit } = {}) {
    const today = todayKey();
    let items = this.#alive();

    if (date) items = items.filter((item) => item.deadline === date);
    if (from) items = items.filter((item) => item.deadline >= from);
    if (to) items = items.filter((item) => item.deadline <= to);
    if (completed !== undefined && completed !== null && completed !== '') {
      const wanted = booleanValue(completed, 'completed');
      items = items.filter((item) => Boolean(item.completed) === wanted);
    }
    if (priority !== undefined && priority !== null && priority !== '') {
      items = items.filter((item) => item.priority === Number(priority));
    }
    if (booleanValue(overdue, 'overdue', { optional: true, fallback: false })) {
      // 空截止日绝不能算逾期：`null < '2026-10-18'` 在 JS 里是 true，漏了这个判断
      // 会让所有"不赶时间"的待办永远挂在逾期列表里。
      items = items.filter((item) => Boolean(item.deadline) && !item.completed && item.deadline < today);
    }
    if (booleanValue(noDeadline, 'noDeadline', { optional: true, fallback: false })) {
      items = items.filter((item) => !item.deadline);
    }
    if (keyword) {
      const kw = String(keyword).toLowerCase();
      items = items.filter(
        (item) =>
          item.title.toLowerCase().includes(kw) ||
          (item.description ?? '').toLowerCase().includes(kw) ||
          (item.tags ?? []).some((tag) => tag.toLowerCase().includes(kw)),
      );
    }
    // `category` 只要**出现**就过滤：`?category=`（空串）是"未分类"这个具体的桶，
    // 不能和"没传这个参数"混为一谈，否则用户永远筛不出未分类的待办。
    if (category !== undefined && category !== null) {
      const wanted = String(category).trim();
      items = items.filter((item) => (item.category ?? '') === wanted);
    }
    if (parentId !== undefined && parentId !== null && String(parentId).trim() !== '') {
      const wanted = String(parentId).trim();
      items = wanted === 'root'
        ? items.filter((item) => !item.parentId)
        : items.filter((item) => item.parentId === wanted);
    }

    items.sort((a, b) => {
      // 无截止日的排最后：它们"不赶时间"，不该挤在今天/逾期的事情前面
      if (!a.deadline !== !b.deadline) return a.deadline ? -1 : 1;
      if (a.deadline !== b.deadline) return (a.deadline ?? '').localeCompare(b.deadline ?? '');
      if (Boolean(a.completed) !== Boolean(b.completed)) return a.completed ? 1 : -1;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.title.localeCompare(b.title);
    });

    // 子级统计按**全部存活记录**算，不按过滤后的集合算：
    // 父行的 `2/3` 说的是"这一步拆成了几步、勾完几步"，不该因为当前只看未完成就变样。
    // 专注秒数同理：父行的 spentSec 是"这棵子树一共投入了多少"，不能被筛选条件改变。
    const alive = this.#alive();
    const index = childStatsIndex(alive);
    const spent = spentStatsIndex(alive);
    const decorated = items.map((item) => decorate(item, today, index.get(item.id), spent.get(item.id)));
    // 不传 limit 就不截断（与旧 /schedules 行为一致）；日历聚合拿全量自己分桶
    const capped = Number(limit);
    return limit !== undefined && limit !== '' && Number.isFinite(capped) && capped > 0
      ? decorated.slice(0, capped)
      : decorated;
  }

  /**
   * 树形列表：顶层数组，每项带 `children`（最多 3 层）。
   *
   * 口径（与 `GET /todos?tree=1` 的文档一致）：
   * - `count` = 顶层条数，`totalCount` = 返回的记录总数（含子项）；
 * - 额外返回 `flat`（全部返回记录的扁平列表），让调用方按同一口径算 stats；
   * - `limit` 作用在**顶层**上（先截顶层再带上子项），否则一棵树会被从中间切断；
   * - 父不在结果里的记录（父被 category / 日期等条件过滤掉，或父已删除）
   *   **提升为顶层**：悄悄丢掉它比多显示一条更糟 —— 用户会以为数据没了。
   */
  tree(filters = {}) {
    const { limit, ...rest } = filters;
    const all = this.list({ ...rest, limit: undefined });
    const nodes = new Map(all.map((item) => [item.id, { ...item, children: [] }]));
    // 脏数据成环时（A 父 B、B 父 A）两条都不是顶层、会一起消失；
    // 走一遍父链判断，会成环的那条直接提升为顶层。
    const formsCycle = (item) => {
      const seen = new Set([item.id]);
      let cursor = item.parentId ? nodes.get(item.parentId) : null;
      while (cursor) {
        if (seen.has(cursor.id)) return true;
        seen.add(cursor.id);
        cursor = cursor.parentId ? nodes.get(cursor.parentId) : null;
      }
      return false;
    };

    const roots = [];
    for (const item of all) {
      const node = nodes.get(item.id);
      const parent = item.parentId ? nodes.get(item.parentId) : null;
      if (parent && parent !== node && !formsCycle(item)) parent.children.push(node);
      else roots.push(node);
    }

    const capped = Number(limit);
    const limited =
      limit !== undefined && limit !== '' && Number.isFinite(capped) && capped > 0 ? roots.slice(0, capped) : roots;
    // 拍平一遍：count 只数顶层，totalCount / stats 要按"返回的全部记录"算（与可见行数一致）
    const flat = [];
    const flatten = (list) => {
      for (const node of list) {
        flat.push(node);
        flatten(node.children);
      }
    };
    flatten(limited);
    return { items: limited, count: limited.length, totalCount: flat.length, flat };
  }

  /**
   * 分类清单：`[{ name, total, open }]`，按 total 降序（未分类的 `name: ''`）。
   *
   * 为什么单独一个接口：顶部筛选条要"每个分类还有多少条"，让前端把所有待办拉下来
   * 自己数，等于把 limit 的口径问题搬进渲染层（只筛一个分类时就看不到其它分类的计数）。
   * 计数按**记录条数**算（含子任务）：子任务也是一条待办，只是挂在父级下面。
   */
  categories() {
    const map = new Map();
    for (const item of this.#alive()) {
      const name = item.category ?? '';
      const row = map.get(name) ?? { name, total: 0, open: 0 };
      row.total += 1;
      if (!item.completed) row.open += 1;
      map.set(name, row);
    }
    return [...map.values()].sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      // 并列时未分类沉底：它是兜底桶，不是用户起的分类名
      if (a.name === '') return 1;
      if (b.name === '') return -1;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
  }

  /**
   * 未完成待办，按截止日升序（等价 PotatoCalendar 的 `get_upcoming`）。
   * 首页/日视图右侧面板用它回答「接下来要做什么」。
   */
  upcoming({ limit } = {}) {
    const items = this.list({ completed: false });
    // 缺省 50 条；显式传 limit=0（或负数）表示「不限制」
    const capped = limit === undefined || limit === '' ? 50 : Number(limit);
    return Number.isFinite(capped) && capped > 0 ? items.slice(0, capped) : items;
  }

  /**
   * 番茄钟结算时把「自己」的专注秒数记到待办上（**唯一**允许写 `spentSelfSec` 的入口）。
   *
   * 为什么是"加到当前待办、祖先自动派生"：
   * - 只写一处，就不存在"父任务上加了两次 / 移动子树后祖父多算"的重复累计；
   * - `decorate` 的 `spentSec` 按当前父子树现算（自己 + 全部后代），所以从子任务到
   *   祖父每一层都能看见这笔投入，而数据里没有一份会过期的聚合值；
   * - 参考实现只给直接父级加一次，在 3 层待办下会让祖父级少算 —— 这是有意的偏离。
   *
   * **已完成 / 已删除的待办不累计**：返回 `{added:0, skipped}`，不报错（番茄钟不应因为
   * 用户中途勾掉了任务而崩），也不写库。调用方不需要重复判断完成态。
   *
   * 写库走集合层的 merge（不是 `update()`）：`update()` 会用「当前记录 + patch」重建
   * 完整字段，而 `spentSelfSec` 是只读字段，不该走客户端可写的那条路径。服务内部直接
   * 写这一个字段是安全的 —— 这里就是"拥有这个字段的模块"。
   *
   * @param {string} id 待办 id
   * @param {number} seconds 要累计的秒数（正数）
   * @param {{notify?: boolean}} [options] `notify:false` 时不广播（番茄钟每 5 秒
   *   实时入账，若每次都广播，前台会每 5 秒整体重画一次，用户正在填的设置会被冲掉）
   * @returns {Promise<{id:string, added:number, spentSelfSec:number, skipped?:string}|null>}
   */
  async addSpentSec(id, seconds, { notify = true } = {}) {
    const current = this.collection.get(String(id ?? ''));
    if (!current || current.deletedAt) return null;
    const amount = Math.max(0, Math.round(Number(seconds) || 0));
    if (!amount) return { id: current.id, added: 0, spentSelfSec: current.spentSelfSec ?? 0 };
    if (current.completed) {
      return { id: current.id, added: 0, skipped: 'completed', spentSelfSec: current.spentSelfSec ?? 0 };
    }
    const spentSelfSec = Math.max(0, Math.round(Number(current.spentSelfSec) || 0)) + amount;
    const updated = await this.collection.update(current.id, { spentSelfSec });
    if (!updated) return null;
    if (notify) {
      this.broadcast?.({
        type: 'data_changed',
        payload: { target: 'todo', action: 'spend', id: current.id, spentSelfSec },
      });
    }
    return { id: updated.id, added: amount, spentSelfSec: updated.spentSelfSec };
  }

  /** 统计：以「过滤后的集合」为准（不受 limit 影响），口径见 docs/接口文档.md。 */
  stats(items) {
    const total = items.length;
    const completed = items.filter((item) => item.completed).length;
    const pending = total - completed;
    const overdue = items.filter((item) => item.isOverdue).length;
    const plannedHours = Number(items.reduce((sum, item) => sum + (item.estimatedHours ?? 1), 0).toFixed(1));
    return {
      total,
      completed,
      pending,
      overdue,
      completionRate: total ? Number(((completed / total) * 100).toFixed(1)) : 0,
      plannedHours,
    };
  }

  get(id) {
    const item = this.collection.get(id);
    if (!item) throw HttpError.notFound(`待办不存在: ${id}`);
    return this.#decorate(item);
  }

  /** 供 /calendar 聚合：按截止日分桶（带派生字段，前端直接用）。 */
  groupByDeadline({ from, to } = {}) {
    const buckets = new Map();
    for (const item of this.list({ from, to })) {
      // 没有截止日的待办不属于任何一天：日历聚合必须跳过，否则会被塞进一个 key 为 null 的桶
      if (!item.deadline) continue;
      if (!buckets.has(item.deadline)) buckets.set(item.deadline, []);
      buckets.get(item.deadline).push(item);
    }
    return buckets;
  }

  async create(input) {
    const data = normalize(input);
    // 新待办从 0 开始计专注；normalize 不产出这个字段（只读，见 READONLY_FIELDS），
    // 所以在**落库这一步**补默认值，更新路径碰不到它
    data.spentSelfSec = 0;
    // 父级必须在写入前验证：落库之后再发现父不存在，就只能靠启动修复去擦屁股
    this.#assertParent(data.parentId);
    if (data.completed && !data.completedAt) data.completedAt = new Date().toISOString();
    const created = await this.collection.insert(data);
    this.broadcast({ type: 'data_changed', payload: { target: 'todo', action: 'create', id: created.id } });
    return this.#decorate(created);
  }

  /** 只校验、不落库（与 create 同一条归一化路径），供 dryRun 预览与 AI 草稿预校验。 */
  preview(input) {
    const data = normalize(input);
    data.spentSelfSec = 0;
    // dryRun 也要提前报"父不存在 / 超 3 层"：否则确认卡看起来没问题，点确认才 400
    this.#assertParent(data.parentId);
    if (data.completed && !data.completedAt) data.completedAt = new Date().toISOString();
    return data;
  }

  /**
   * 「现有记录 + patch」重建成一份完整字段（**不落库**）。
   *
   * `update()` 与 `previewUpdate()` 共用它：dryRun 预览必须与真写走同一条归一化路径，
   * 否则会出现"预览说没问题、点确认才 400"的卡点 —— 那正是这一版要修的毛病。
   */
  #rebuild(id, patch = {}) {
    const current = this.get(id);
    const incoming = normalizeInput(patch);
    const merged = { ...pickDefined(current, EDITABLE), ...incoming };
    // patch 只给了"分钟"写法时，必须把从库里带过来的 estimatedHours 让位：
    // 两个都在会被当成"调用方同时给了两种口径"而 400，而调用方其实只写了一个。
    if (incoming.estimatedMinutes !== undefined && incoming.estimatedHours === undefined) delete merged.estimatedHours;
    const data = normalize(merged, { partial: false });
    // 父级合法性：存在 / 不成环 / 不超 3 层（selfId = 自己，用来挡住"自己当父"与"后代当父"）
    this.#assertParent(data.parentId, { selfId: id });
    // 完成态与 completedAt 必须一起变：勾选时写时间戳，取消勾选时清成 null
    // （必须是 null 而不是 undefined：JSON 集合的合并会把 undefined 当成「不带这个字段」）
    if (data.completed) {
      data.completedAt = data.completedAt ?? new Date().toISOString();
    } else {
      data.completedAt = null;
      // 取消完成 = 用户说"这件事还没做完"：连带完成的标记随之失效。
      // 留着它的话，之后父任务再取消完成会把这件**已手动恢复**的事再回滚一遍。
      data.autoCompletedBy = null;
    }
    return data;
  }

  /** update 的「只校验、不落库」版本：dryRun 的更新预览与真写同口径（含未知字段 400）。 */
  previewUpdate(id, patch) {
    return this.#rebuild(id, patch);
  }

  /**
   * 局部更新；`completed` 出现时顺带处理父子级联。
   *
   * 为什么只认**显式**的 completed：改标题时重建出来的 completed 一定等于当前值，
   * 若按"重建结果是 true 就扫一遍子任务"，用户手动取消过的子任务会在父任务改标题时
   * 被悄悄重新勾上 —— 那是改动用户的数据。
   */
  async update(id, patch = {}) {
    const incoming = normalizeInput(patch);
    const data = this.#rebuild(id, patch);
    const updated = await this.collection.update(id, data);

    const cascaded = { completed: [], reverted: [] };
    if (incoming.completed !== undefined) {
      if (data.completed) cascaded.completed = await this.#cascadeComplete(id);
      else cascaded.reverted = await this.#revertCascade(id);
    }

    this.broadcast({ type: 'data_changed', payload: { target: 'todo', action: 'update', id } });
    const item = this.#decorate(updated);
    // 级联影响清单只挂在这条写响应上（GET 不会带它，它描述的是"这次操作做了什么"）
    item.cascaded = cascaded;
    return item;
  }

  /**
   * 完成父 → 连带完成**所有后代**（递归，最多 3 层）。
   *
   * 只动还没完成的后代，并记 `autoCompletedBy = <触发级联的那条 id>`：
   * - 已经手动完成的子任务不改写：它本来就不是"被连带的"，
   *   取消完成父时自然也不该回滚它（核心用例见 #revertCascade）；
   * - 标记是撤销的唯一依据：没有它就只能"把子任务全取消"，那会连用户手动勾掉的完成态一起抹掉。
   * 子完成不反向影响父：这里只往下走，父的 childDoneCount 由派生字段跟着算。
   */
  async #cascadeComplete(id) {
    const completed = [];
    const now = new Date().toISOString();
    for (const child of this.#descendantsOf(id)) {
      if (child.completed) continue; // 手动完成过的子任务不碰（否则撤销父会误伤）
      await this.collection.update(child.id, { completed: true, completedAt: now, autoCompletedBy: id });
      completed.push(child.id);
    }
    return completed;
  }

  /**
   * 取消完成父 → **只回滚因它而被连带完成**的后代。
   *
   * 为什么必须按 `autoCompletedBy === id` 精确匹配，而不是"把所有后代取消完成"：
   * 用户很可能早就手动勾完了某个子任务（那件事真的做完了），父任务只是汇总。
   * 误点父的完成再撤销时，若连手动勾过的子任务一起抹掉，
   * **用户亲手记录的完成状态就丢了** —— 这是数据丢失，不是"恢复原状"。
   * 另外，子任务被手动取消完成时标记会被清掉（见 #rebuild），
   * 所以"手动完成 → 手动取消 → 再手动完成"之后再撤销父，也不会被误回滚。
   */
  async #revertCascade(id) {
    const reverted = [];
    for (const child of this.#descendantsOf(id)) {
      if (child.autoCompletedBy !== id) continue;
      await this.collection.update(child.id, { completed: false, completedAt: null, autoCompletedBy: null });
      // 本来就没完成（例如用户手动勾掉过）的不算"被回滚"，不虚报数量
      if (child.completed) reverted.push(child.id);
    }
    return reverted;
  }

  /** 勾选 / 取消勾选。语义唯一入口，避免各处自己写 completedAt。 */
  async setCompleted(id, completed) {
    const wanted = booleanValue(completed, 'completed', { optional: false });
    return this.update(id, { completed: wanted, completedAt: wanted ? new Date().toISOString() : null });
  }

  /**
   * 删除待办。
   *
   * **不级联删除子任务**：子任务往往是自己独立做完的事（"复习第一章"不会因为
   * "期末复习"这个汇总被删掉就没发生过），删父级顺手毁掉一整个子树的记录与进度，
   * 是最容易让用户丢数据的一种"贴心"。
   * 但也不能留下悬空 parentId（那会让子任务在树形视图里消失、AI 也查不到归属），
   * 所以把直接子级的 parentId 置空 = **父级已删除，子任务独立显示**。
   * 选置空而不是"保留一个已删除父级的标记再特判显示"：置空后子任务就是正常的顶层待办，
   * 能继续被勾选 / 编辑 / 筛选，前端也不必为"父已删除"发明第四种渲染状态。
   */
  async remove(id) {
    this.get(id);
    const detachedChildren = this.#childrenOf(id).map((item) => item.id);
    // 先断开再删：任何时刻都不存在"指向不存在记录"的中间状态
    for (const childId of detachedChildren) await this.collection.update(childId, { parentId: null });
    await this.collection.remove(id);
    this.broadcast({ type: 'data_changed', payload: { target: 'todo', action: 'delete', id } });
    return { id, deleted: true, detachedChildren };
  }

  /**
   * 批量删除（指令 / dschat 兼容层用）。
   *
   * 逐条走 `remove()` 而不是集合层的 `removeMany`：后者会把子任务留成悬空 parentId。
   */
  async removeMany(ids = []) {
    const list = [...ids].filter((id) => this.collection.get(id));
    const detachedChildren = [];
    for (const id of list) {
      const result = await this.remove(id);
      detachedChildren.push(...result.detachedChildren);
    }
    return { ids: list, deleted: list.length, detachedChildren };
  }

  /**
   * 启动时修复父子关系（幂等，一条记录都不删）：
   * 1. 父记录不存在（被删 / 同步冲突时父被改名换了 id）→ parentId = null（不留悬空）；
   * 2. 自己指自己 / 成环 → 断开这一条；
   * 3. 层级超过 3 层（同步合并可能带来更深的链）→ 把超限的那条提升为顶层。
   *
   * 为什么放在启动：同步是"按 id 合并"，冲突时会给副本换新 id，父链可能因此在
   * 另一台设备上指向不存在的记录；不修的话树形视图会静默少掉整棵子树。
   *
   * @returns {Promise<{ repaired: Array<{id: string, from: string, reason: string}> }>}
   */
  async repairHierarchy() {
    const all = this.collection.all();
    const byId = new Map(all.map((item) => [item.id, item]));
    const repaired = [];
    for (const item of all) {
      if (!item.parentId) continue;
      let reason = null;
      let cursor = item;
      let depth = 0;
      const seen = new Set();
      while (cursor) {
        if (seen.has(cursor.id)) {
          reason = 'cycle';
          break;
        }
        seen.add(cursor.id);
        depth += 1;
        const parent = cursor.parentId ? byId.get(cursor.parentId) : null;
        if (!parent) {
          // 正常终点是"顶层记录（没有 parentId）"；"有 parentId 但查不到"才是悬空
          if (cursor.parentId) reason = 'missing-parent';
          break;
        }
        cursor = parent;
      }
      if (!reason && depth > MAX_DEPTH) reason = 'too-deep';
      if (!reason) continue;
      await this.collection.update(item.id, { parentId: null });
      repaired.push({ id: item.id, from: item.parentId, reason });
    }
    if (repaired.length) {
      this.broadcast({ type: 'data_changed', payload: { target: 'todo', action: 'repair', count: repaired.length } });
    }
    return { repaired };
  }

  /**
   * 顺延未完成待办：把截止日早于目标周一的未完成待办，挪到目标周的**同一星期几**；
   * 若那个日期已经过去（早于今天），则落到目标周一。
   *
   * 与旧「顺延日程」的关键差异：待办是**同一条记录的截止日平移**，不克隆新记录、
   * 也不会把原记录标记成什么状态（待办只有 completed 一个布尔）。
   * `rolledFrom.deadline` 保留「这次顺延前它原本是哪天到期」，便于追溯。
   *
   * @param {object} [options]
   * @param {string} [options.weekStart] 目标周的周一（缺省 = 本周一）
   */
  async rollover({ weekStart } = {}) {
    const today = todayKey();
    const anchor = weekStart ? requireDate(weekStart, 'weekStart') : addDays(today, 1 - isoWeekday(today));
    if (isoWeekday(anchor) !== 1) {
      throw HttpError.badRequest('字段 weekStart 不合法：必须是周一', { field: 'weekStart' });
    }

    const candidates = this.collection
      .all()
      .filter((item) => Boolean(item.deadline) && !item.completed && item.deadline < anchor)
      .sort((a, b) => a.deadline.localeCompare(b.deadline));
    if (!candidates.length) return { weekStart: anchor, moved: 0, items: [] };

    const moved = [];
    for (const item of candidates) {
      const sameWeekday = addDays(anchor, isoWeekday(item.deadline) - 1);
      // 目标任何分支都不得早于今天：否则「顺延到本周」会把逾期待办挪到本周一（仍是过去），
      // 等于没顺延。同星期几已过 -> 目标周一；目标周一也过了（本周已开始）-> 今天。
      const target = sameWeekday >= today ? sameWeekday : anchor >= today ? anchor : today;
      await this.collection.update(item.id, {
        deadline: target,
        rolledFrom: { deadline: item.deadline },
      });
      moved.push({ id: item.id, title: item.title, from: item.deadline, to: target });
    }
    this.broadcast({ type: 'data_changed', payload: { target: 'todo', action: 'rollover', count: moved.length } });
    return { weekStart: anchor, moved: moved.length, items: moved };
  }
}
