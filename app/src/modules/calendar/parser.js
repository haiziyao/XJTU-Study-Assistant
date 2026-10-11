/**
 * 指令解析器：把一句中文指令解析成「指令对象」（不直接写库）。
 *
 * 指令对象与 /api/v1/commands/parse 的返回、AI provider 的返回结构完全一致，
 * 因此 AI 接入后可以由模型直接产出同样结构，业务侧无需改动。
 *
 * 支持的书写形式（示例）：
 *   添加日程 明天 15:00-16:00 项目周会
 *   添加日程 每周一 9点半 站会 提前10分钟提醒
 *   添加日历事件 2025-10-20 到 2025-10-22 期中考试 重要
 *   查询本周日程
 *   把明天的项目周会改到 16:00
 *   完成今天的英语听力
 *   删除日程 项目周会
 */

import {
  addDays,
  combine,
  isClock,
  isDateKey,
  monthRange,
  todayKey,
  weekRange,
  yearRange,
} from '../../shared/time.js';
import { EVENT_CATEGORIES, SCHEDULE_CATEGORIES } from '../../shared/constants.js';
import {
  alignRepeatWithDate,
  hasExplicitTime,
  parseDateExpr,
  parseReminderExpr,
  parseRepeatExpr,
  parseTimeRangeExpr,
  parseWeekdayRepeat,
} from '../../core/commands/nlp-rules.js';
import { matchesRepeat } from './recurrence.js';

/** 两个日期键相差的天数。 */
function dayDiff(fromKey, toKey) {
  return Math.round((new Date(toKey) - new Date(fromKey)) / 86400000);
}

/** 从 from 之后找到第一个命中重复规则的日期（最多向后找 2 年）。 */
function nextOccurrence(anchorKey, from, repeat) {
  let cursor = from;
  for (let i = 0; i < 730; i += 1) {
    if (matchesRepeat(cursor, anchorKey, repeat)) return cursor;
    cursor = addDays(cursor, 1);
  }
  return undefined;
}

const ACTION_PATTERNS = [
  // 注意：“未完成 / 没完成 / 还没做完”是查询条件，不是完成动作，故用否定后顾排除
  { action: 'complete', re: /(?<![未没不])(完成|做完|打了?卡|勾选|标记为?完成)/ },
  { action: 'delete', re: /(删除|删掉|移除|去掉|取消)/ },
  { action: 'update', re: /(修改|改成|改为|调整为|更新|推迟|延期|挪到|改到|提前到)/ },
  { action: 'query', re: /(查询|查看|看一下|看看|列出|显示|有哪些|有什么|还有什么|日程表|安排是)/ },
  { action: 'create', re: /(添加|新建|创建|新增|加一个|安排|记一下|记录|提醒我|帮我记)/ },
];

const STOPWORDS = [
  '帮我', '请', '麻烦', '一下', '一个', '一条', '把', '将', '在', '的', '了', '要', '需要',
  '记得', '提醒我', '提醒', '添加', '新建', '创建', '新增', '安排', '记录', '记一下',
  '查询', '查看', '看看', '列出', '显示', '删除', '删掉', '移除', '取消', '修改', '改成',
  '改为', '调整', '更新', '完成', '做完', '打卡', '勾选', '日历事件', '日历', '事件',
  '日程', '事项', '待办', '任务', '标题', '名称', '内容', '备注', '标题是', '叫做', '叫',
];

const CATEGORY_KEYWORDS = [
  { re: /(上课|课程|课|讲座|网课)/, schedule: 'class', event: 'study' },
  { re: /(自习|复习|预习|刷题|背单词|听力|阅读|作业|论文|学习|读书)/, schedule: 'study', event: 'study' },
  { re: /(考试|测验|月考|期中|期末|模拟考)/, schedule: 'exam', event: 'exam' },
  { re: /(会议|开会|例会|周会|站会|讨论|面谈|约见|面试)/, schedule: 'meeting', event: 'other' },
  { re: /(活动|社团|运动|跑步|锻炼|比赛|演出|聚会)/, schedule: 'activity', event: 'other' },
  { re: /(假期|放假|节日|春节|国庆|寒假|暑假|调休)/, schedule: 'other', event: 'holiday' },
  { re: /(纪念日|生日|周年)/, schedule: 'other', event: 'anniversary' },
  { re: /(截止|deadline|提交|报名截止|交付)/, schedule: 'other', event: 'deadline' },
];

const DEFAULT_TITLES = { class: '上课', study: '学习', exam: '考试', meeting: '会议', activity: '活动', other: '未命名日程' };

/** 全角 -> 半角，压缩空白。 */
function normalize(text) {
  return String(text ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从原文中剔除已识别片段，剩下的即为候选标题。 */
function stripSpans(text, spans) {
  let rest = text;
  const unique = [...new Set(spans.filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const span of unique) rest = rest.split(span).join(' ');
  return rest;
}

function cleanupTitle(text) {
  let rest = text;
  for (const word of STOPWORDS) rest = rest.split(word).join(' ');
  return rest
    .replace(/[，。,.、；;：:!！?？"'“”‘’()（）\[\]【】《》]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectCategory(text, target) {
  for (const entry of CATEGORY_KEYWORDS) {
    if (entry.re.test(text)) return target === 'schedule' ? entry.schedule : entry.event;
  }
  return 'other';
}

function detectPriority(text) {
  if (/(重要|紧急|必须|务必|优先)/.test(text)) return 2;
  if (/(不急|随便|次要|有空)/.test(text)) return 0;
  return 1;
}

function extractQuoted(text) {
  const m = text.match(/[「『"“]([^」』"”]{1,60})[」』"”]/);
  return m?.[1]?.trim();
}

function extractLabeled(text, labels) {
  const pattern = new RegExp(`(?:${labels.join('|')})\\s*[:：]\\s*([^,，。;；]{1,60})`);
  return text.match(pattern)?.[1]?.trim();
}

/** 日期词元（用于区间解析，避免把标题也吞进匹配区间）。 */
const DATE_TOKEN_RE =
  /(\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*[日号]?)|(\d{1,2}\s*[月/]\s*\d{1,2}\s*[日号]?)|(大后天|后天|明天|明日|今天|今日|昨天|昨日|前天)/g;
/** 日期区间连接词（不含裸 “-”，否则会把 2025-10-20 自身切成两半）。 */
const DATE_RANGE_JOINER = /^\s*(到|至|~|～|—|–|-\s|\s-)\s*$/;

/** 解析「A 到 B」形式的日期区间，A/B 必须是日期词元。 */
function parseDateRange(text, now) {
  DATE_TOKEN_RE.lastIndex = 0;
  const tokens = [];
  for (let m = DATE_TOKEN_RE.exec(text); m; m = DATE_TOKEN_RE.exec(text)) {
    const parsed = parseDateExpr(m[0], now);
    if (parsed) tokens.push({ text: m[0], index: m.index, end: m.index + m[0].length, dateKey: parsed.dateKey });
  }
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const left = tokens[i];
    const right = tokens[i + 1];
    const gap = text.slice(left.end, right.index);
    if (!DATE_RANGE_JOINER.test(gap)) continue;
    if (left.dateKey > right.dateKey) continue;
    return {
      startDate: left.dateKey,
      endDate: right.dateKey,
      matched: text.slice(left.index, right.end),
    };
  }
  return undefined;
}

/** 解析查询用的时间范围（今天 / 本周 / 本月 / 今年 / 全部）。 */
function parseQueryRange(text, now) {
  const today = todayKey(now);
  if (/(全部|所有|历史)/.test(text)) return { from: undefined, to: undefined, label: '全部', matched: '全部' };
  if (/今天|今日/.test(text)) return { from: today, to: today, label: '今天', matched: '今天' };
  if (/明天|明日/.test(text)) {
    const d = addDays(today, 1);
    return { from: d, to: d, label: '明天', matched: '明天' };
  }
  if (/(本周|这周|这个星期|本星期)/.test(text)) {
    const { start, end } = weekRange(today, 1);
    return { from: start, to: end, label: '本周', matched: '本周' };
  }
  if (/(本月|这个月|当月)/.test(text)) {
    const { start, end } = monthRange(today);
    return { from: start, to: end, label: '本月', matched: '本月' };
  }
  if (/(今年|本年)/.test(text)) {
    const { start, end } = yearRange(today);
    return { from: start, to: end, label: '今年', matched: '今年' };
  }
  const explicit = parseDateExpr(text, now);
  if (explicit) return { from: explicit.dateKey, to: explicit.dateKey, label: explicit.dateKey, matched: explicit.matched };
  return { from: undefined, to: undefined, label: '全部', matched: undefined };
}

/**
 * 「待办」类措辞。命中这些词时即使没给具体时刻也要判到 schedule：
 * 待办 = 全天日程（`date` + `allDay` + `status`），而待办视图只读 schedules 集合，
 * 判成 event 会让用户说了「加待办」却在待办列表里看不到东西。
 */
const TODO_HINT_RE = /(待办|任务|清单|todo|作业|提交|截止|deadline|报名|打卡)/i;

/**
 * 判断指令作用在哪个集合（`event` = 日历事件，`schedule` = 日程/待办）。
 *
 * 优先级：明确措辞 > 待办类措辞 > 动作语义 > 有没有时刻。
 *
 * 默认分支的取向（2026-10 修订）：**没给具体时刻的单日项一律算待办**（schedule + allDay），
 * 因为用户嘴里的「明天交实验报告」就是待办，而待办视图只读 schedules 集合。
 * 只有跨天的日期区间（`10月20日到10月22日 期中考试`）才当日期粒度的事件 ——
 * 那类东西的语义是「这段时间」，不适合塞进某一天的待办列表。
 */
function detectTarget(text, { hasTime, action, hasDateRange = false }) {
  if (/(日历事件|日历|纪念日|假期|节日|节假日|生日)/.test(text)) return 'event';
  if (/(日程|安排|课程|上课|自习|会议|例会|周会|站会|面试|活动)/.test(text)) return 'schedule';
  if (TODO_HINT_RE.test(text)) return 'schedule';
  // 「完成」只对日程有意义：日历事件没有完成态，handler 会直接报错。所以动作是完成时
  // 默认按日程定位（上面已排除「日历事件 / 日历 / 假期 …」这类明确措辞）。
  if (action === 'complete') return 'schedule';
  if (action === 'query' && /(日历|月历)/.test(text)) return 'event';
  if (hasTime) return 'schedule';
  return hasDateRange ? 'event' : 'schedule';
}

export class CommandParser {
  /**
   * @param {object} [deps]
   * @param {() => Date} [deps.now] 注入时钟，便于测试
   */
  constructor(deps = {}) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * 解析指令。
   * @param {string} rawText 用户输入的指令
   * @param {object} [options]
   * @param {object} [options.context] 预留上下文（当前时间由本解析器提供，不依赖前端）
   * @returns {object} 指令对象
   */
  parse(rawText, options = {}) {
    const now = options.now ?? this.now();
    const text = normalize(rawText);
    const today = todayKey(now);
    const warnings = [];
    const spans = [];

    if (!text) {
      return {
        ok: false,
        raw: rawText,
        action: 'create',
        target: 'schedule',
        confidence: 0,
        warnings: ['指令为空'],
        explain: '没有识别到任何内容',
      };
    }

    const action = ACTION_PATTERNS.find((entry) => entry.re.test(text))?.action ?? 'create';
    const actionMatch = ACTION_PATTERNS.find((entry) => entry.re.test(text))?.re.exec(text)?.[0];
    if (actionMatch) spans.push(actionMatch);

    const timeRange = parseTimeRangeExpr(text);
    if (timeRange?.matched) spans.push(timeRange.matched);
    // 日期区间只解析一次：既用于判断「跨天 → 日历事件」，也用于 event 分支的字段填充
    const dateRange = parseDateRange(text, now);
    const target = detectTarget(text, {
      hasTime: hasExplicitTime(text),
      action,
      hasDateRange: Boolean(dateRange),
    });

    // ---- 查询 / 删除 / 完成：产出条件对象 ----
    if (action === 'query' || action === 'delete' || action === 'complete' || action === 'update') {
      const range = parseQueryRange(text, now);
      if (range.matched) spans.push(range.matched);
      const keyword = cleanupTitle(stripSpans(text, spans));
      const filters = {
        from: range.from,
        to: range.to,
        rangeLabel: range.label,
        status: /未完成|待办|还没/.test(text) ? 'pending' : /已完成|做完了/.test(text) ? 'done' : undefined,
      };
      // 说了「待办 / 作业 / 任务 / 截止」，或者动作是「完成」时，条件限定为待办（只有日期的条目）：
      // 否则「完成今天的作业」会把同一天的时段日程（开会、上课）也算成候选。
      if (TODO_HINT_RE.test(text) || action === 'complete') filters.allDay = true;
      if (keyword) filters.keyword = keyword;

      const fields = {};
      if (action === 'update') {
        if (timeRange?.startTime) {
          fields.startTime = timeRange.startTime;
          if (timeRange.endTime) fields.endTime = timeRange.endTime;
        }
        if (range.from) fields.date = range.from;
      }

      const confidence = action === 'query' ? 0.85 : keyword ? 0.8 : 0.5;
      if (!keyword && action !== 'query') warnings.push('未指定明确的对象名称，将按时间范围匹配');
      return {
        ok: true,
        raw: rawText,
        action,
        target,
        filters,
        fields: action === 'update' ? fields : undefined,
        confidence,
        warnings,
        explain:
          action === 'query'
            ? `查询 ${range.label} 的${target === 'event' ? '日历事件' : '日程'}${keyword ? `（关键词：${keyword}）` : ''}`
            : `${action === 'delete' ? '删除' : action === 'complete' ? '标记完成' : '修改'} ${range.label} 的${target === 'event' ? '日历事件' : '日程'}${keyword ? `（关键词：${keyword}）` : ''}`,
      };
    }

    // ---- 创建：产出字段对象 ----
    const fields = { source: 'command' };

    if (target === 'event') {
      const single = parseDateExpr(text, now);
      if (dateRange) {
        fields.startDate = dateRange.startDate;
        fields.endDate = dateRange.endDate;
        spans.push(dateRange.startDate, dateRange.endDate, dateRange.matched);
      } else if (single) {
        fields.startDate = single.dateKey;
        fields.endDate = single.dateKey;
        spans.push(single.dateKey, single.matched);
      } else {
        fields.startDate = today;
        fields.endDate = today;
        warnings.push('未识别到日期，默认今天');
      }
      fields.allDay = true;
    } else {
      const single = parseDateExpr(text, now);
      if (single) {
        fields.date = single.dateKey;
        spans.push(single.dateKey, single.matched);
      } else {
        fields.date = today;
        warnings.push('未识别到日期，默认今天');
      }
      if (timeRange?.allDay) {
        fields.allDay = true;
      } else if (timeRange?.startTime) {
        fields.startTime = timeRange.startTime;
        if (timeRange.endTime) {
          fields.endTime = timeRange.endTime;
        } else {
          fields.endTime = timeRange.durationMinutes
            ? timeRange.endTime
            : alignEndTime(timeRange.startTime);
          warnings.push('未指定结束时间，默认持续 1 小时');
        }
      } else if (timeRange?.durationMinutes) {
        fields.startTime = '09:00';
        fields.endTime = alignEndTime('09:00', timeRange.durationMinutes);
        warnings.push('未指定开始时间，默认 09:00');
      } else {
        fields.allDay = true;
        warnings.push('未识别到具体时刻，按全天日程处理');
      }
      fields.status = 'pending';
    }

    const repeatExpr = parseWeekdayRepeat(text) ?? parseRepeatExpr(text);
    if (repeatExpr) {
      fields.repeat = alignRepeatWithDate(repeatExpr.repeat, fields.date ?? fields.startDate);
      spans.push(repeatExpr.matched);
      // 重复日程/事件的锚点落在过去时，向后滚动到下一个命中日（例如周三说“每周一 9点”）
      if (target === 'schedule' && fields.repeat && fields.date < today) {
        const next = nextOccurrence(fields.date, today, fields.repeat);
        if (next) fields.date = next;
      }
      if (target === 'event' && fields.repeat && fields.startDate < today) {
        const next = nextOccurrence(fields.startDate, today, fields.repeat);
        if (next) {
          fields.endDate = addDays(next, Math.max(0, dayDiff(fields.startDate, fields.endDate)));
          fields.startDate = next;
        }
      }
    }

    const reminder = parseReminderExpr(text);
    if (reminder) {
      fields.reminders = [{ offsetMinutes: reminder.offsetMinutes, channel: 'app' }];
      spans.push(reminder.matched);
    }

    fields.category = detectCategory(text, target);
    fields.priority = detectPriority(text);
    if (/(重要|紧急|必须|务必|优先)/.test(text)) spans.push(text.match(/(重要|紧急|必须|务必|优先)/)[0]);

    const labeledTitle = extractLabeled(text, ['标题', '名称', '内容', '备注']);
    const title = extractQuoted(text) ?? labeledTitle ?? cleanupTitle(stripSpans(text, spans));
    if (title) {
      fields.title = title;
      spans.push(title);
    } else {
      fields.title = target === 'schedule' ? DEFAULT_TITLES[fields.category] ?? '未命名日程' : '未命名事件';
      warnings.push('未识别到名称，已使用默认名称');
    }

    const location = extractLabeled(text, ['地点', '位置']);
    if (location) fields.location = location;
    const description = extractLabeled(text, ['备注', '说明']);
    if (description) fields.description = description;

    // 置信度：基础分 + 命中要素 - 警告扣分
    let confidence = 0.55;
    if (fields.title && fields.title !== '未命名日程' && fields.title !== '未命名事件') confidence += 0.2;
    if (fields.date || fields.startDate !== today) confidence += 0.15;
    if (timeRange?.startTime) confidence += 0.1;
    confidence -= warnings.length * 0.08;
    confidence = Math.max(0.05, Math.min(0.99, Number(confidence.toFixed(2))));

    return {
      ok: true,
      raw: rawText,
      action,
      target,
      fields,
      confidence,
      warnings,
      explain: buildExplain(action, target, fields),
    };
  }
}

function alignEndTime(startTime, durationMinutes = 60) {
  const [h, m] = startTime.split(':').map(Number);
  const total = (h * 60 + m + durationMinutes) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function buildExplain(action, target, fields) {
  const label = target === 'schedule' ? '日程' : '日历事件';
  const when =
    target === 'schedule'
      ? `${fields.date}${fields.allDay ? ' 全天' : ` ${fields.startTime ?? ''}${fields.endTime ? `-${fields.endTime}` : ''}`}`
      : `${fields.startDate}${fields.endDate && fields.endDate !== fields.startDate ? ` 至 ${fields.endDate}` : ''}`;
  const repeatNote = fields.repeat
    ? `，重复：${fields.repeat.type}${fields.repeat.interval > 1 ? `（每 ${fields.repeat.interval} 次）` : ''}`
    : '';
  const reminderNote = fields.reminders?.length ? `，提前 ${fields.reminders[0].offsetMinutes} 分钟提醒` : '';
  const verb = action === 'create' ? '添加' : action;
  return `${verb}${label}「${fields.title}」：${when}${repeatNote}${reminderNote}`;
}

/** 指令语法速查表，由 /api/v1/commands/grammar 返回。 */
export const COMMAND_GRAMMAR = {
  pattern: '[动作] [对象] [时间] [名称] [重复] [提醒] [优先级]',
  actions: {
    create: '添加 / 新建 / 创建 / 安排 / 记一下 / 提醒我',
    query: '查询 / 查看 / 列出 / 显示 / 有哪些',
    update: '修改 / 改成 / 改到 / 推迟 / 挪到',
    delete: '删除 / 删掉 / 移除 / 取消',
    complete: '完成 / 做完 / 打卡 / 勾选',
  },
  targets: {
    schedule: '日程与待办：有具体时刻 → 时段日程；单日且无时刻 → 全天待办（待办列表只读这个集合）｜「待办 / 任务 / 作业 / 截止」等措辞一律归到这里',
    event: '日历事件 / 假期 / 生日 / 纪念日，以及跨天的日期区间（如「10月20日到10月22日 期中考试」）',
  },
  dates: ['今天', '明天', '后天', '大后天', '下周三', '周五', '周末', '10月20日', '2025-10-20', '10月20日到10月22日'],
  times: ['15:00', '15:00-16:00', '下午3点', '下午3点半', '晚上7点到8点', '全天', '15:00 起 1 小时'],
  repeats: ['每天', '每周一', '每两周', '每月1日', '每年', '工作日'],
  reminders: ['提前10分钟', '提前半小时', '提前1天', '提醒'],
  priorities: ['重要 / 紧急', '不急'],
  categories: {
    schedule: SCHEDULE_CATEGORIES,
    event: EVENT_CATEGORIES,
  },
  examples: [
    '添加日程 明天 15:00-16:00 项目周会 提前10分钟提醒',
    '添加日程 每周一 9点半 英语晨读',
    '添加日历事件 2025-10-20 到 2025-10-22 期中考试 重要',
    '添加日历事件 10月1日 国庆假期',
    '查询本周日程',
    '查询今天未完成的日程',
    '把明天的项目周会改到 16:00',
    '完成今天的英语听力',
    '删除日程 项目周会',
  ],
};

export { combine, isClock, isDateKey };
