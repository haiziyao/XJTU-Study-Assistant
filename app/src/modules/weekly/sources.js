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
 * 3. **拿不到就说拿不到**。`cards`(46) / `goals`(47) 已经装配、能读到；但它们是否可用不该由本模块假定
 *    （换个只装了部分模块的进程、或将来重命名集合都可能读不到）。任何"取不到"都不抛异常、也不退化成 0，
 *    而是给 `null` + 一条 `missing` 记录。
 *    0 与"没数据"是两件事：报告里写"复习 0 次"和"复习数据缺失"对用户的含义完全不同，
 *    而**编一个 0 出来是最坏的一种谎**（用户会以为系统真的没记录、或者自己真的没复习）。
 *    `missing[].reason` 取值：
 *      - `unavailable`：这个来源整个不存在（模块没装配 / 没有对应集合）；
 *      - `partial`：来源在，但只有一部分字段能算（例如没有复习日志集合，算不出区间复习次数）；
 *      - `read_failed`：集合存在但读的时候抛了（文件损坏等），如实记下原话。
 *
 * 4. **口径优先问对方模块**。cards / goals 若装配好了并提供 `weeklyStats({ from, to })`，
 *    就用它们自己的口径（字段语义只有对方最清楚）；没有才退回去按约定字段名读集合。
 *    这样并行开发的模块**不必为周报改任何代码**，只需要（可选地）多提供一个只读方法 ——
 *    见 README 的「需要父智能体接线」一节。
 */

import { addDays, isDateKey, toDateKey } from '../../shared/time.js';

/** 六个来源的固定顺序：响应里 `missing` 与 stats 的键顺序都按它来（便于前端与测试对照）。 */
export const SOURCE_KEYS = ['conversations', 'notes', 'cards', 'goals', 'schedule', 'grades'];

/** 中文名：给模型看的提示与降级小结都要用（模型读中文标签比读英文键更不容易张冠李戴）。 */
export const SOURCE_LABEL = {
  conversations: 'AI 对话',
  notes: '笔记',
  cards: '复习卡片',
  goals: '学习目标',
  schedule: '待办',
  grades: '成绩',
};

const unavailable = (source, detail) => ({ source, reason: 'unavailable', detail });
const partial = (source, detail) => ({ source, reason: 'partial', detail });
const readFailed = (source, detail) => ({ source, reason: 'read_failed', detail });

/**
 * 名字不统一时的候选集合名（当前 cards/goals 用的就是 `cards` / `goals`，其余是兜底）。
 *
 * 首选仍是对方服务自己给的口径（`weeklyStats({from,to})`，退一步认 `stats()`）：
 * 「什么算到期 / 什么算完成」的语义只有对方模块说得清。之所以还要探测集合名，
 * 是因为「周报能不能出数字」不该取决于另一个模块有没有想到周报 —— 数据一旦落库，谁都能算。
 * 但命名或字段不一致时**不猜错的**：宁可记 partial、给 null，也不拿错字段当数字。
 */
const CARD_COLLECTIONS = ['cards', 'reviewCards', 'studyCards'];
const REVIEW_COLLECTIONS = ['cardReviews', 'reviewLogs', 'cardReviewLogs'];
const GOAL_COLLECTIONS = ['goals', 'studyGoals', 'goalItems'];

/** ISO 时间戳是否落在区间内。区间按**本地日界**闭区间（from 00:00:00.000 ~ to 23:59:59.999）。 */
function within(value, range) {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) && ms >= range.fromMs && ms <= range.toMs;
}

/** 只取日期部分：集合里既有 `2026-01-11` 也有 `2026-01-11T08:00:00.000Z`，还有毫秒时间戳。 */
function datePartOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  if (isDateKey(text.slice(0, 10))) return text.slice(0, 10);
  const num = Number(value);
  if (Number.isFinite(num) && num > 1e11) return toDateKey(new Date(num));
  return null;
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

/** 从对方服务给的数字里按别名取字段；取不到的字段记 partial，而不是拿 0 顶上。 */
function pickCounts(raw, aliasesByField) {
  const value = {};
  const absent = [];
  for (const [field, aliases] of Object.entries(aliasesByField)) {
    const hit = aliases.find((alias) => raw?.[alias] !== undefined && raw?.[alias] !== null && Number.isFinite(Number(raw[alias])));
    if (hit) value[field] = Number(raw[hit]);
    else {
      value[field] = null;
      absent.push(field);
    }
  }
  return { value, absent };
}

/** 对方模块自己算好的口径：`services.<mod>.weeklyStats({from,to})`，退一步认 `stats()`。 */
function fromService(service, range) {
  if (!service || typeof service !== 'object') return null;
  const fn =
    typeof service.weeklyStats === 'function' ? service.weeklyStats : typeof service.stats === 'function' ? service.stats : null;
  if (!fn) return null;
  try {
    const raw = fn.call(service, { from: range.from, to: range.to });
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 复习卡片：区间内复习次数、新学会（reps 从 0 变正）数量、当前到期数、本周复习过的卡片数。
 *
 * 数据来源**两者并用**，各取所长（cards 模块 order=46，比本模块早装配，取得到）：
 *   - 「当前到期 / 总数」优先用 `services.cards.stats()`（`dueNow` / `total`）——
 *     "什么算到期"的语义由 cards 模块定义（`isDue` = 未暂停且 `due <= now`），
 *     周报自己发明一套就会与复习页上的数字对不上；服务不在时才读 `store.cards` 现算。
 *   - 「本周复习过的卡片数」（`reviewedCards`）：按每张卡 `lastReviewedAt` 的落点统计，
 *     这个口径**精确**（"最后一次复习发生在本周"）；卡片集合读不到就为 null。
 *   - 「区间复习次数 / 新学会」需要**复习流水**才敢给：cards 现在只保留每张卡的
 *     `lastReviewedAt` 与累计 `reps`，两次复习之间发生了什么无从得知（一张卡这周复习了 3 次
 *     也只留下最后那一次），所以这两个字段在没有流水集合时给 **null + partial**，
 *     而不是拿"复习过的卡片数"冒充"次数"、也不是把 `reps > 0` 当成"这周学会的"。
 *     将来 cards 落了复习流水（或提供 `weeklyStats`），这里会自动用上。
 */
export function readCards({ store, services, range, today, nowMs = range.nowMs ?? Date.now() }) {
  const missing = [];
  const cards = firstCollection(store, CARD_COLLECTIONS);
  const list = cards ? allOf(cards.collection) : null;
  const provided = fromService(services?.cards, range);

  if (!cards && !provided) {
    return { value: null, missing: [unavailable('cards', 'cards 模块未装配（没有 cards / reviewCards 集合，也没有 services.cards.weeklyStats）')] };
  }
  if (cards && !list && !provided) {
    return { value: null, missing: [readFailed('cards', `${cards.name} 集合读取失败`)] };
  }
  if (cards && !list) missing.push(readFailed('cards', `${cards.name} 集合读取失败，只能给出对方服务提供的字段`));

  const value = { total: null, due: null, reviewedCards: null, reviews: null, learned: null };

  // ① 总数 / 当前到期：对方的统计口径优先（见函数头注释）
  if (provided) {
    const picked = pickCounts(provided, {
      due: ['due', 'dueCount', 'dueNow', 'dueToday'],
      total: ['total', 'cardCount'],
    });
    value.due = picked.value.due;
    value.total = picked.value.total;
  }

  // ② 卡片集合还能给出「本周复习过的卡片数」等精确口径
  if (list) {
    const alive = list.filter((item) => !item.deletedAt);
    if (value.total === null) value.total = alive.length;
    if (value.due === null) {
      value.due = alive.filter((item) => {
        if (item.suspended) return false;
        const at = Date.parse(String(item.due ?? item.dueAt ?? item.dueDate ?? item.nextDue ?? ''));
        return Number.isFinite(at) ? at <= nowMs : false;
      }).length;
    }
    // 精确：最后一次复习落在区间内的卡片数（**不是**复习次数，别混用）
    value.reviewedCards = alive.filter((item) => within(item.lastReviewedAt, range)).length;
  }

  // ③ 复习流水（若有）：区间复习次数与"这周新学会"（该卡最早一条流水落在区间内 = reps 从 0 变正）
  const log = firstCollection(store, REVIEW_COLLECTIONS);
  const entries = log ? allOf(log.collection) : null;
  if (log && entries) {
    value.reviews = entries.filter((item) => within(item.reviewedAt ?? item.at ?? item.createdAt, range)).length;
    const firstSeen = new Map();
    for (const entry of entries) {
      const id = String(entry.cardId ?? entry.card ?? entry.targetId ?? '');
      const ms = Date.parse(String(entry.reviewedAt ?? entry.at ?? entry.createdAt ?? ''));
      if (!id || !Number.isFinite(ms)) continue;
      const previous = firstSeen.get(id);
      if (previous === undefined || ms < previous) firstSeen.set(id, ms);
    }
    value.learned = [...firstSeen.values()].filter((ms) => ms >= range.fromMs && ms <= range.toMs).length;
  } else if (log) {
    missing.push(readFailed('cards', `${log.name} 集合读取失败，区间复习次数无法统计`));
  } else {
    // 没有流水：卡片上若有「首次学习时间」字段就认它，否则如实 null
    const stamps = (list ?? [])
      .filter((item) => Number(item.reps ?? item.reviewCount ?? item.reviews ?? 0) > 0)
      .map((item) => item.firstReviewedAt ?? item.learnedAt ?? item.startedAt)
      .filter(Boolean);
    if (stamps.length && value.learned === null) value.learned = stamps.filter((stamp) => within(stamp, range)).length;
    else if (value.learned === null) {
      missing.push(
        partial(
          'cards',
          'cards 只保留每张卡的最后复习时间与累计 reps、没有复习流水，所以"区间复习次数"与"这周新学会"为 null；' +
            '已给出可精确计算的"本周复习过的卡片数"（reviewedCards）',
        ),
      );
    }
  }

  return { value, missing };
}

/**
 * 学习目标 / DDL：区间内的进度变化、完成数、逾期与临近条目数。
 *
 * 与 cards 同一套优先级：先问 `services.goals.weeklyStats({from,to})`，没有就读 `store.goals`。
 *
 * 三处口径刻意对齐 goals 模块自己的定义（否则周报与「复习」页会对不上）：
 *   - `status` 只有 `active / done / archived`，**完成就是 `status === 'done'`**；
 *     `progress` 是 0~100 的百分数（不是 0~1），所以绝不能拿 `progress >= 1` 当"做完了"；
 *   - 「逾期」= `status === 'active'` 且 `targetDate < 今天`（与 `decorate().overdue` 同义）；
 *   - 「临近」= `status === 'active'` 且 `targetDate ∈ [今天, 今天+7]`（与 `remindDays` 的量级一致）。
 *
 * 「进度变化」需要**进度流水**才敢给：goals 只存当前的 `progress` 与里程碑 `done` 标记
 * （里程碑没有时间戳），没有流水时 `updatedAt` 只能说明"这周改过"（可能只是改了标题），
 * 所以 `progressChanges` 给 null + partial，`updated`（本周有改动的目标数）照给。
 * 同理 goals 没有 `completedAt`，「本周完成」只能按 `status=done` 且 `updatedAt` 落在区间内近似 ——
 * 这一点也写进 partial，让报告与复核的人都知道它不是精确值。
 */
export function readGoals({ store, services, range, today }) {
  const provided = fromService(services?.goals, range);
  if (provided) {
    const { value, absent } = pickCounts(provided, {
      progressChanges: ['progressChanges', 'progressUpdated', 'progressLogCount'],
      completed: ['completed', 'completedCount', 'finished'],
      overdue: ['overdue', 'overdueCount'],
      dueSoon: ['dueSoon', 'dueSoonCount', 'upcoming'],
      // 刻意**不**把 total 当 active 的别名：把「全部目标」写成「进行中」是造数，不是兜底
      active: ['active', 'activeCount', 'inProgress'],
    });
    const missing = absent.length
      ? [partial('goals', `goals 服务没有给出 ${absent.join(' / ')}，这些字段为 null（不猜）`)]
      : [];
    return { value, missing };
  }

  const goals = firstCollection(store, GOAL_COLLECTIONS);
  if (!goals) {
    return { value: null, missing: [unavailable('goals', 'goals 模块未装配（没有 goals / studyGoals 集合，也没有 services.goals.weeklyStats）')] };
  }
  const list = allOf(goals.collection);
  if (!list) return { value: null, missing: [readFailed('goals', `${goals.name} 集合读取失败`)] };

  const statusOf = (item) => String(item.status ?? 'active');
  const isDone = (item) => statusOf(item) === 'done';
  const active = list.filter((item) => statusOf(item) === 'active');
  const dueKeyOf = (item) => datePartOf(item.targetDate ?? item.dueDate ?? item.deadline ?? item.due);
  const inWeek = (key) => Boolean(key) && key >= today && key <= addDays(today, 7);

  const updated = list.filter((item) => within(item.updatedAt, range));
  const completed = list.filter((item) => isDone(item) && within(item.updatedAt, range)).length;
  const logs = list.map((item) => item.progressLog ?? item.history ?? item.updates).filter(Array.isArray);
  const missing = [];
  let progressChanges = null;
  if (logs.length) {
    progressChanges = logs.flat().filter((entry) => within(entry?.at ?? entry?.createdAt ?? entry?.time, range)).length;
  } else if (updated.length) {
    // 只有**这周真的动过目标**时才提这个口径限制：一周都没碰过目标的话，
    // "进度变化量算不出来"对读者没有意义，只会让报告多一句噪音。
    missing.push(partial('goals', '目标没有进度流水（progressLog / history），无法判断进度变化量，只给出"本周有改动的目标条数"'));
  }
  if (completed > 0 && !list.some((item) => item.completedAt ?? item.finishedAt ?? item.doneAt)) {
    // 同理：只有在**真的用到这个近似值**（本周有目标被标成 done）时才声明它是近似
    missing.push(partial('goals', '目标没有完成时间字段，"本周完成"按 status=done 且 updatedAt 落在区间内近似（可能把"改完标题就搁置"的算进来）'));
  }

  return {
    value: {
      total: list.length,
      active: active.length,
      /** 本周有改动的目标数（含改标题/改截止日，不都是"进度"）。 */
      updated: updated.length,
      progressChanges,
      completed,
      overdue: active.filter((item) => {
        const key = dueKeyOf(item);
        return Boolean(key) && key < today;
      }).length,
      dueSoon: active.filter((item) => inWeek(dueKeyOf(item))).length,
      titles: titlesOf([...updated].sort(newestFirst('updatedAt')), 3),
    },
    missing,
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
  cards: readCards,
  goals: readGoals,
  schedule: readSchedule,
  grades: readGrades,
};

/**
 * 收齐六个来源。
 *
 * 单个来源炸了**不影响其它来源**：每个 reader 单独 try/catch，失败降级成 `null` + `read_failed`。
 * 这就是"数据统计必须永远可用"的落点 —— 周报接口不允许因为别人模块的一次读失败而 500。
 *
 * @returns {{ conversations, notes, cards, goals, schedule, grades, missing: Array }}
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
