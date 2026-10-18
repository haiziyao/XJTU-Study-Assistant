/**
 * 学习周报的**只读数据源适配层**。
 *
 * 为什么单独一层、而不是写在 service.js 里：
 *
 * 1. **一个字段一个出处**。周报的每个数字都必须能回答"这是从哪张表的哪个字段算出来的"，
 *    所以每个来源一个函数、字段对照表写在 README，方便复核（也方便别人接自己的模块）。
 *
 * 2. **只读、绝不写别人的集合**。周报是"事后汇总"，不是业务动作；写别人的数据必须走对方
 *    服务（contract.js 的「数据边界」）。这个文件里没有一个 insert / update / remove。
 *
 * 3. **拿不到就说拿不到**。任何"取不到"都不抛异常、也不退化成 0，而是给 `null` + 一条
 *    `missing` 记录。0 与"没数据"是两件事：报告里写"新写 0 篇笔记"和"笔记数据缺失"对用户的
 *    含义完全不同，而**编一个 0 出来是最坏的一种谎**（用户会以为系统真的没记录、或者自己真的没做）。
 *    `missing[].reason` 取值：
 *      - `unavailable`：这个来源整个不存在（模块没装配 / 没有对应集合）；
 *      - `partial`：来源在，但只有一部分字段能算（例如 academic 服务不在，算不出学分绩）；
 *      - `read_failed`：集合存在但读的时候抛了（文件损坏等），如实记下原话。
 *
 * 4. **范围只覆盖仍然存在的四个来源**：AI 对话 / 笔记 / 待办 / 成绩。
 *    已移除的两个学习功能不再读取、也不再统计 —— 既不保留恒为 null 的统计项，
 *    也不在 `missing` 里假装"这个来源这次没读到"。
 *
 * 5. **口径优先问对方模块**。academic 若装配好并提供 `stats()`，学分绩就用它自己的口径
 *    （字段语义只有对方最清楚）；集合只用来判断"这周成绩数据有没有变动"。
 */

import { addDays } from '../../shared/time.js';

/** 四个来源的固定顺序：响应里 `missing` 与 stats 的键顺序都按它来（便于前端与测试对照）。 */
export const SOURCE_KEYS = ['conversations', 'notes', 'schedule', 'grades'];

/** 中文名：给模型看的提示与降级小结都要用（模型读中文标签比读英文键更不容易张冠李戴）。 */
export const SOURCE_LABEL = {
  conversations: 'AI 对话',
  notes: '笔记',
  schedule: '待办',
  grades: '成绩',
};

const unavailable = (source, detail) => ({ source, reason: 'unavailable', detail });
const partial = (source, detail) => ({ source, reason: 'partial', detail });
const readFailed = (source, detail) => ({ source, reason: 'read_failed', detail });

/** ISO 时间戳是否落在区间内。区间按**本地日界**闭区间（from 00:00:00.000 ~ to 23:59:59.999）。 */
function within(value, range) {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) && ms >= range.fromMs && ms <= range.toMs;
}

/** 取第一个真实存在的集合（`store.<name>` 由模块描述符的 collections 声明决定）。 */
function firstCollection(store, names) {
  for (const name of names) {
    const collection = store?.[name];
    if (collection && typeof collection.all === 'function') return { name, collection };
  }
  return null;
}

/** 读一个集合的全部记录：读失败返回 null（由调用方记 read_failed，而不是让接口 500）。 */
function allOf(collection) {
  try {
    return collection.all();
  } catch {
    return null;
  }
}

const newestFirst = (key) => (a, b) => String(b?.[key] ?? '').localeCompare(String(a?.[key] ?? ''));

/** 数字或 null：**先把 null / 空串 / 非数字挡掉**（`Number(null) === 0` 会把"没有"读成 0）。 */
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}
const titlesOf = (items, limit = 5) =>
  items
    .slice(0, limit)
    .map((item) => String(item?.title ?? '').trim())
    .filter(Boolean);

// ---------------------------------------------------------------- 各来源

/**
 * AI 对话：区间内的新会话数、消息数、用户提问数。
 *
 * 数据源：`store.aiConversations`（`createdAt`）与 `store.aiMessages`（`createdAt` + `role`）。
 * 消息的 `role` 只有 user / assistant 两种（system 不进集合），所以"提问数"= role=user 的条数。
 */
export function readConversations({ store, range }) {
  const conversations = firstCollection(store, ['aiConversations']);
  const messages = firstCollection(store, ['aiMessages']);
  if (!conversations || !messages) {
    return { value: null, missing: [unavailable('conversations', 'ai 模块未装配（没有 aiConversations / aiMessages 集合）')] };
  }
  const conversationList = allOf(conversations.collection);
  const messageList = allOf(messages.collection);
  if (!conversationList || !messageList) {
    return { value: null, missing: [readFailed('conversations', 'ai 会话或消息集合读取失败')] };
  }

  const fresh = conversationList.filter((item) => within(item.createdAt, range));
  const inWindow = messageList.filter((item) => within(item.createdAt, range));
  const userMessages = inWindow.filter((item) => item.role === 'user');
  const active = new Set(inWindow.map((item) => String(item.conversationId ?? '')).filter(Boolean));

  return {
    value: {
      newConversations: fresh.length,
      messages: inWindow.length,
      userMessages: userMessages.length,
      assistantMessages: inWindow.filter((item) => item.role === 'assistant').length,
      /** 区间内有消息往来的会话数（含区间之前就建好的老会话）——「延续了几天」比"新开了几个"更接近投入。 */
      activeConversations: active.size,
      titles: titlesOf([...fresh].sort(newestFirst('createdAt')), 3),
    },
    missing: [],
  };
}

/**
 * 笔记：区间内新建 / 更新的笔记数与前几条标题。
 *
 * 数据源：`store.notes` 的 `createdAt` / `updatedAt` / `deletedAt`。
 * 软删除的笔记（`deletedAt` 非空）不计入新建/更新 —— 用户看到的是"这周写了什么"，
 * 删掉的草稿不该出现在周报里；删除条数单独给一个 `deleted`，不混进 created。
 */
export function readNotes({ store, range }) {
  const notes = firstCollection(store, ['notes']);
  if (!notes) return { value: null, missing: [unavailable('notes', 'notes 模块未装配（没有 notes 集合）')] };
  const list = allOf(notes.collection);
  if (!list) return { value: null, missing: [readFailed('notes', 'notes 集合读取失败')] };

  const alive = list.filter((item) => !item.deletedAt);
  const created = alive.filter((item) => within(item.createdAt, range));
  const updated = alive.filter((item) => within(item.updatedAt, range));
  const updatedOnly = updated.filter((item) => !within(item.createdAt, range));
  const merged = [...created, ...updatedOnly].sort(newestFirst('updatedAt'));

  return {
    value: {
      created: created.length,
      updated: updated.length,
      /** 区间之前就写好、但这周动过的（周报里常写成"另有 N 篇有更新"）。 */
      updatedOnly: updatedOnly.length,
      deleted: list.filter((item) => item.deletedAt && within(item.deletedAt, range)).length,
      titles: titlesOf(merged, 5),
    },
    missing: [],
  };
}

/**
 * 待办：区间内新增 / 完成数，以及**当前**逾期与 7 天内到期的条数。
 *
 * 数据源：`store.todos`（calendar 模块）的 `createdAt` / `completedAt` / `deadline` / `completed`。
 * 逾期与临近按**统计时刻的今天**判断，而不是区间末尾 —— 周报的用途是提醒"下一步该做什么"，
 * 一周结束时生成时两者恰好重合，回看历史周时"现在仍逾期"才是需要行动的信息。
 */
export function readSchedule({ store, range, today }) {
  const todos = firstCollection(store, ['todos']);
  if (!todos) return { value: null, missing: [unavailable('schedule', 'calendar 模块未装配（没有 todos 集合）')] };
  const list = allOf(todos.collection);
  if (!list) return { value: null, missing: [readFailed('schedule', 'todos 集合读取失败')] };

  const open = list.filter((item) => !item.completed);
  const overdue = open.filter((item) => item.deadline && item.deadline < today);
  const dueSoon = open.filter((item) => item.deadline && item.deadline >= today && item.deadline <= addDays(today, 7));

  return {
    value: {
      todosCreated: list.filter((item) => within(item.createdAt, range)).length,
      todosCompleted: list.filter((item) => item.completed && within(item.completedAt, range)).length,
      todosOpen: open.length,
      todosOverdue: overdue.length,
      todosDueSoon: dueSoon.length,
      /** 逾期优先、其次临近：报告「需要注意的事」直接引用，不必让模型自己挑。 */
      attention: [...overdue, ...dueSoon]
        .slice(0, 3)
        .map((item) => ({ title: String(item.title ?? '').trim(), deadline: item.deadline ?? null }))
        .filter((item) => item.title),
    },
    missing: [],
  };
}

/**
 * 成绩：区间内成绩数据有没有变化；有 academic 的统计口径就给 gpa。
 *
 * 数据源：`store.academicGrades` 的 `updatedAt` / `syncedAt`，加上 `services.academic.stats()`。
 * `gpa: null` 表示"没有可计算的成绩"（不是 0 分）—— 这点要写进提示词，否则模型会把它读成 0。
 * 成绩集合在、但 academic 服务没装配时记 partial：数据能读、学分绩算不出来。
 */
export function readGrades({ store, services, range }) {
  const grades = firstCollection(store, ['academicGrades']);
  if (!grades) return { value: null, missing: [unavailable('grades', 'academic 模块未装配（没有 academicGrades 集合）')] };
  const list = allOf(grades.collection);
  if (!list) return { value: null, missing: [readFailed('grades', 'academicGrades 集合读取失败')] };

  const updated = list.filter((item) => within(item.updatedAt, range)).length;
  const synced = list.filter((item) => item.syncedAt && within(item.syncedAt, range)).length;

  let stats = null;
  try {
    if (typeof services?.academic?.stats === 'function') stats = services.academic.stats();
  } catch {
    stats = null;
  }
  const missing = stats
    ? []
    : [partial('grades', 'academic 服务不可用，只给出成绩数据的变动情况，学分绩为 null')];

  return {
    value: {
      // 注意 `Number(null) === 0`：null 必须先挡掉，否则"没有可计算的成绩"会变成 0 分（正好是本模块最忌的错）
      gpa: numberOrNull(stats?.gpa),
      includedCount: numberOrNull(stats?.includedCount),
      total: list.length,
      updated,
      synced,
      /** 「区间内成绩数据有无变化」：同步刷新或记录被改动都算变化。 */
      changed: updated > 0 || synced > 0,
    },
    missing,
  };
}

const READERS = {
  conversations: readConversations,
  notes: readNotes,
  schedule: readSchedule,
  grades: readGrades,
};

/**
 * 收齐四个来源。
 *
 * 单个来源炸了**不影响其它来源**：每个 reader 单独 try/catch，失败降级成 `null` + `read_failed`。
 * 这就是"数据统计必须永远可用"的落点 —— 周报接口不允许因为别人模块的一次读失败而 500。
 *
 * @returns {{ conversations, notes, schedule, grades, missing: Array }}
 */
export function collectStats({ store, services, range, today }) {
  const out = {};
  const missing = [];
  for (const key of SOURCE_KEYS) {
    let result;
    try {
      result = READERS[key]({ store, services, range, today });
    } catch (error) {
      result = { value: null, missing: [readFailed(key, `统计 ${SOURCE_LABEL[key]} 时出错：${error?.message ?? String(error)}`)] };
    }
    out[key] = result?.value ?? null;
    missing.push(...(result?.missing ?? []));
  }
  return { ...out, missing };
}
