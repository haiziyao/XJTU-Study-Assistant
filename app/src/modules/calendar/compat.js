/**
 * 与 dschat 2 的兼容层。
 *
 * dschat 2（同工作区 `dschat 2`）用 snake_case 扁平字段描述「单日事件」，
 * 并通过中文标记行（`[新增日程] 标题 | 日期 | …`）让 AI 触发写入。本模块提供：
 *
 * 1. 宽松日期/时刻归一化（`2026-9-1` / `2026/09/01` / `2026年9月1日` / `无`）；
 * 2. snake_case ↔ camelCase 字段别名映射（主程序可直接沿用 dschat 2 的字段名）；
 * 3. dschat 2 扁平重复字段（repeat / repeat_interval / repeat_end）↔ 本模块嵌套 repeat；
 * 4. 单日事件 ↔ 本模块 Schedule/Event 的双向转换。
 *
 * 说明：dschat 2 的事件模型没有跨天、没有状态机、没有分类与提醒，
 * 因此转换只做「语义等价」的部分，其余字段保持本模块默认值。
 */

const LOOSE_DATE_RE = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?$/;

const pad2 = (n) => String(n).padStart(2, '0');

/** 宽松日期归一化；`无`、空串、null 视为未提供。 */
export function normalizeLooseDate(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (!text || text === '无' || text === 'null') return undefined;
  const m = text.match(LOOSE_DATE_RE);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return text; // 交给上层校验报错
}

/** 宽松时刻归一化：`9:00` -> `09:00`；`无`/空 -> undefined。 */
export function normalizeLooseClock(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (!text || text === '无' || text === 'null') return undefined;
  const m = text.match(/^(\d{1,2})\s*[:：点时]\s*(\d{0,2})/);
  if (!m) return text;
  return `${pad2(Number(m[1]))}:${pad2(Number(m[2] || 0))}`;
}

/** dschat 2 的扁平重复字段 -> 本模块嵌套 repeat。 */
export function repeatFromDschat({ repeat, repeat_interval: interval, repeat_end: end }) {
  const table = {
    none: 'none',
    无: 'none',
    daily: 'daily',
    每天: 'daily',
    每日: 'daily',
    weekly: 'weekly',
    每周: 'weekly',
    monthly: 'monthly',
    每月: 'monthly',
    yearly: 'yearly',
    每年: 'yearly',
  };
  const raw = String(repeat ?? 'none').trim();
  const direct = table[raw] ?? table[raw.toLowerCase()];
  const everyN = raw.match(/^每\s*(\d+)?\s*(天|日|周|星期|月|年)$/);
  let type = direct;
  let step = Number(interval ?? 1) || 1;
  if (!type && everyN) {
    type = everyN[2].match(/天|日/) ? 'daily' : everyN[2].match(/周|星期/) ? 'weekly' : everyN[2] === '月' ? 'monthly' : 'yearly';
    if (everyN[1]) step = Number(everyN[1]);
  }
  if (!type) type = 'none';
  const untilDate = normalizeLooseDate(end);
  return {
    type,
    interval: Math.max(1, step),
    weekdays: [],
    until: untilDate ? { mode: 'date', date: untilDate } : { mode: 'never' },
  };
}

/** 本模块嵌套 repeat -> dschat 2 扁平字段。 */
export function repeatToDschat(repeat) {
  if (!repeat || repeat.type === 'none') return { repeat: 'none', repeat_interval: 1, repeat_end: null };
  const until = repeat.until?.mode === 'date' ? repeat.until.date : null;
  return {
    repeat: repeat.type,
    repeat_interval: repeat.interval ?? 1,
    repeat_end: until,
  };
}

const ALIASES = {
  start_time: 'startTime',
  end_time: 'endTime',
  all_day: 'allDay',
  notes: 'description',
  note: 'description',
  due_date: 'date',
  deadline: 'date',
  title: 'title',
  location: 'location',
  priority: 'priority',
  category: 'category',
  subject: 'category',
  completed: 'status',
};

/**
 * 把 dschat 2 风格（或混用）的入参映射为本模块字段。
 * 未识别的键原样保留，交由各服务的校验层处理（未知字段会被忽略）。
 */
export function normalizeAliases(input = {}) {
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'repeat' || key === 'repeat_interval' || key === 'repeat_end' || key === 'repeatInterval' || key === 'repeatEnd') continue;
    const mapped = ALIASES[key] ?? key;
    if (mapped === 'status' && typeof value === 'boolean') {
      out.status = value ? 'done' : 'pending';
      continue;
    }
    out[mapped] = value;
  }
  if (out.date !== undefined) out.date = normalizeLooseDate(out.date);
  if (out.startDate !== undefined) out.startDate = normalizeLooseDate(out.startDate);
  if (out.endDate !== undefined) out.endDate = normalizeLooseDate(out.endDate);
  if (out.startTime !== undefined) out.startTime = normalizeLooseClock(out.startTime);
  if (out.endTime !== undefined) out.endTime = normalizeLooseClock(out.endTime);
  // 已经是本模块嵌套结构（含 type）时原样透传，避免把对象误当成 dschat 2 的字符串字段
  if (input.repeat && typeof input.repeat === 'object' && input.repeat.type) {
    out.repeat = input.repeat;
  } else if (input.repeat !== undefined || input.repeat_interval !== undefined || input.repeat_end !== undefined) {
    out.repeat = repeatFromDschat(input);
  } else if (input.repeatInterval !== undefined || input.repeatEnd !== undefined) {
    out.repeat = repeatFromDschat({
      repeat: typeof input.repeat === 'string' ? input.repeat : input.repeat?.type,
      repeat_interval: input.repeatInterval,
      repeat_end: input.repeatEnd,
    });
  }
  return out;
}

/**
 * dschat 2 单日事件 -> 本模块入参。
 *
 * 归属（2026-10 重做后）：有具体时刻 => `Schedule`（时段）；没有时刻 => `Todo`（待办，
 * dschat 2 的日期锚点就是待办）；需要跨天区间时显式传 `target: "event"`。
 */
export function fromDschatEvent(payload = {}, { target } = {}) {
  const mapped = normalizeAliases(payload);
  const allDay = mapped.allDay === true || mapped.allDay === 1 || (!mapped.startTime && !mapped.endTime);
  const resolvedTarget = target ?? (allDay ? 'todo' : 'schedule');
  if (resolvedTarget === 'event') {
    return {
      target: 'event',
      fields: {
        title: mapped.title,
        description: mapped.notes ?? mapped.description ?? '',
        category: mapped.category,
        startDate: mapped.date,
        endDate: mapped.endDate ?? mapped.date,
        allDay: true,
        repeat: mapped.repeat,
        source: 'import',
        externalId: payload.id,
      },
    };
  }
  if (allDay) {
    // 没有时刻 = 待办：只有截止日 + 优先级（dschat 的 completed -> completed）
    return {
      target: 'todo',
      fields: {
        title: mapped.title,
        description: mapped.description ?? '',
        deadline: mapped.date,
        priority: typeof mapped.priority === 'number' ? mapped.priority : undefined,
        // dschat 2 的 `completed` 布尔在别名层被折成 `status: 'done'|'pending'`（见 ALIASES），
        // 这里再折回待办的布尔：显式布尔优先，status 兜底，两者都没有就不动完成态。
        completed: mapped.completed ?? (mapped.status === 'done' ? true : mapped.status === 'pending' ? false : undefined),
        source: 'import',
        externalId: payload.id,
      },
    };
  }
  return {
    target: 'schedule',
    fields: {
      title: mapped.title,
      description: mapped.description ?? '',
      category: mapped.category,
      location: mapped.location,
      date: mapped.date,
      startTime: mapped.startTime,
      endTime: mapped.endTime,
      priority: typeof mapped.priority === 'number' ? mapped.priority : undefined,
      repeat: mapped.repeat,
      source: 'import',
    },
  };
}

/** 本模块记录 -> dschat 2 API 形状（snake_case，单日锚点）。待办记录按「全天 + completed」输出。 */
export function toDschatEvent(record) {
  const isTodo = record.deadline !== undefined;
  return {
    id: record.id,
    title: record.title,
    notes: record.description ?? '',
    location: record.location ?? '',
    date: record.date ?? record.deadline ?? record.startDate,
    start_time: isTodo || record.allDay ? null : record.startTime ?? null,
    end_time: isTodo || record.allDay ? null : record.endTime ?? null,
    all_day: isTodo ? true : Boolean(record.allDay),
    ...(isTodo ? { completed: Boolean(record.completed) } : {}),
    ...repeatToDschat(record.repeat),
    created_at: record.createdAt ? Date.parse(record.createdAt) / 1000 : null,
    updated_at: record.updatedAt ? Date.parse(record.updatedAt) / 1000 : null,
  };
}
