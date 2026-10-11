/**
 * 指令解析器：把一句中文指令解析成「指令对象」（不直接写库）。
 *
 * 指令对象与 /api/v1/commands/parse 的返回、AI provider 的返回结构完全一致，
 * 因此 AI 接入后可以由模型直接产出同样结构，业务侧无需改动。
 *
 * 支持的书写形式（示例）：
 *   添加日程 明天 15:00-16:00 项目周会
 *   添加日程 每周一 9点半 站会 提前10分钟提醒
 *   添加待办 明天 交实验报告 预计2小时 重要
 *   添加日历事件 2025-10-20 到 2025-10-22 期中考试 重要
 *   查询本周日程
 *   把明天的项目周会改到 16:00
 *   完成今天的英语听力
 *   顺延未完成的待办到本周
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
  parseDurationExpr,
  parseReminderExpr,
  parseRepeatExpr,
  parseTimeRangeExpr,
  parseWeekdayRepeat,
} from '../../core/commands/nlp-rules.js';
import { isoWeekday, matchesRepeat } from './recurrence.js';

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
  // 顺延必须排在 create 之前：「顺延未完成的待办到本周」里的“到本周”不是创建动作
  { action: 'rollover', re: /(顺延|滚到下周|挪到下周|推到下周|移到下周|延到下?周)/ },
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
  '预计', '大概', '大约', '顺延',
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

/** 「顺延到本周 / 下周」的目标周一（周一为一周之始）。 */
function parseWeekStart(text, today) {
  const thisMonday = addDays(today, 1 - isoWeekday(today));
  if (/下周|下个?星期/.test(text)) return addDays(thisMonday, 7);
  if (/本周|这周|这个星期|本星期/.test(text)) return thisMonday;
  return undefined;
}

/** 全角 -> 半角，压缩空白。 */
function normalize(text) {
  return String(text ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 完成态措辞：它们是**过滤条件**，不是标题的一部分。
 * 必须在通用 STOPWORDS 之前剔除，否则「未完成」会先被「完成」吃掉、只剩一个「未」字，
 * 变成 filters.keyword="未" 这种会把结果筛空的垃圾关键词。
 */
const STATUS_PHRASES = ['未完成', '没完成', '未做完', '还没做', '还没', '已完成', '做完了', '完成了', '逾期', '过期', '超期'];

/** 从原文中剔除已识别片段，剩下的即为候选标题。 */
function stripSpans(text, spans) {
  let rest = text;
  const unique = [...new Set(spans.filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const span of unique) rest = rest.split(span).join(' ');
  return rest;
}

function cleanupTitle(text) {
  let rest = text;
  for (const word of [...STATUS_PHRASES, ...STOPWORDS]) rest = rest.split(word).join(' ');
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

function detectPriority(text, target = 'schedule') {
  if (/(重要|紧急|必须|务必|优先)/.test(text)) return 2;
  if (/(不急|随便|次要|有空)/.test(text)) return 0;
  // 优先级默认值与各自的领域模型一致：待办默认「低」（0），日程/事件默认「普通」（1）
  return target === 'todo' ? 0 : 1;
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

/** 三类措辞。命中即定向，顺序即优先级：「日历事件」>「日程」>「待办」。 */
const EVENT_HINT_RE = /(日历事件|日历|纪念日|假期|节日|节假日|生日)/;
const SCHEDULE_HINT_RE = /(日程|安排|课程|上课|自习|会议|例会|周会|站会|面试)/;
const TODO_HINT_RE = /(待办|任务|作业|提交|截止|报名|ddl|deadline|打卡|完成|做完|勾选)/i;

/**
 * 判断指令作用在哪个集合（`event` 日历事件 / `schedule` 日程 / `todo` 待办）。
 *
 * 判定顺序（2026-10 重做，与 docs/接口文档.md 的「★ AI 速查」表一致）：
 *   1. 明确措辞优先：日历事件类 → `event`；日程类 → `schedule`；
 *   2. 待办措辞（待办 / 任务 / 作业 / 截止 / 提交 / 完成 …）→ `todo`；
 *   3. 跨天日期区间（`10月20日到10月22日`）→ `event`（那类语义是「这段时间」）；
 *   4. 有具体时刻 → `schedule`；
 *   5. 其余单日、无时刻 → `todo`（用户嘴里的「明天交实验报告」就是待办）。
 */
function detectTarget(text, { hasTime, hasDateRange = false }) {
  if (EVENT_HINT_RE.test(text)) return 'event';
  if (SCHEDULE_HINT_RE.test(text)) return 'schedule';
  if (TODO_HINT_RE.test(text)) return 'todo';
  if (hasDateRange) return 'event';
  return hasTime ? 'schedule' : 'todo';
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
      hasDateRange: Boolean(dateRange),
    });

    // ---- 查询 / 删除 / 完成 / 顺延：产出条件对象 ----
    if (['query', 'delete', 'complete', 'update', 'rollover'].includes(action)) {
      const range = parseQueryRange(text, now);
      if (range.matched) spans.push(range.matched);
      const keyword = cleanupTitle(stripSpans(text, spans));
      const filters = { from: range.from, to: range.to, rangeLabel: range.label };
      // 只有待办有完成态：说「未完成 / 已完成」才是完成态过滤；日程与日历事件没有状态可过滤
      if (target === 'todo') {
        if (/(未完成|还没|没完成|未做完)/.test(text)) filters.completed = false;
        else if (/(已完成|做完了|完成了)/.test(text)) filters.completed = true;
        // 「完成 X」的意图是「把还没完成的 X 标记完成」，所以默认只找未完成的
        else if (action === 'complete') filters.completed = false;
        if (/(逾期|过期|超期)/.test(text)) filters.overdue = true;
      }
      // 顺延的作用域是「所有逾期待办」，不接受关键词：带上它只会在 explain 里误导 AI
      const scopedKeyword = action === 'rollover' ? undefined : keyword;
      if (scopedKeyword) filters.keyword = scopedKeyword;

      const fields = {};
      if (action === 'update') {
        if (target === 'todo') {
          if (range.from) fields.deadline = range.from;
        } else {
          if (timeRange?.startTime) {
            fields.startTime = timeRange.startTime;
            if (timeRange.endTime) fields.endTime = timeRange.endTime;
          }
          if (range.from) fields.date = range.from;
        }
      }
      if (action === 'rollover') {
        const weekStart = parseWeekStart(text, today);
        if (weekStart) filters.weekStart = weekStart;
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
        explain: explainMatchAction(action, target, range.label, scopedKeyword),
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
    } else if (target === 'todo') {
      // 待办只有一条时间信息：截止日（不是时段）
      const single = parseDateExpr(text, now);
      if (single) {
        fields.deadline = single.dateKey;
        spans.push(single.dateKey, single.matched);
      } else {
        fields.deadline = today;
        warnings.push('未识别到截止日，默认今天');
      }
      const duration = parseDurationExpr(text);
      if (duration) {
        fields.estimatedHours = Number((duration.minutes / 60).toFixed(2));
        spans.push(duration.matched);
      }
      const tagMatches = [...text.matchAll(/#([^\s#，,。;；]{1,12})/g)];
      const tags = tagMatches.map((m) => m[1]);
      if (tags.length) {
        fields.tags = tags;
        for (const match of tagMatches) spans.push(match[0]);
      }
      fields.priority = detectPriority(text, 'todo');
    } else {
      const single = parseDateExpr(text, now);
      if (single) {
        fields.date = single.dateKey;
        spans.push(single.dateKey, single.matched);
      } else {
        fields.date = today;
        warnings.push('未识别到日期，默认今天');
      }
      // 日程必须是时段：没有时刻时给一个默认时段（而不是退化成全天/待办）
      if (timeRange?.startTime) {
        fields.startTime = timeRange.startTime;
        if (timeRange.endTime) {
          fields.endTime = timeRange.endTime;
        } else {
          fields.endTime = alignEndTime(timeRange.startTime);
          warnings.push('未指定结束时间，默认持续 1 小时');
        }
      } else if (timeRange?.durationMinutes) {
        fields.startTime = '09:00';
        fields.endTime = alignEndTime('09:00', timeRange.durationMinutes);
        warnings.push('未指定开始时间，默认 09:00');
      } else {
        fields.startTime = '09:00';
        fields.endTime = '10:00';
        warnings.push('未识别到具体时刻，已按 09:00-10:00 排入日程（只有日期的请说「待办」）');
      }
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

    // 待办没有分类（它不是日程），优先级默认值也不同（0 而不是 1）
    if (target !== 'todo') {
      fields.category = detectCategory(text, target);
      fields.priority = detectPriority(text, target);
    }
    if (/(重要|紧急|必须|务必|优先)/.test(text)) spans.push(text.match(/(重要|紧急|必须|务必|优先)/)[0]);

    const labeledTitle = extractLabeled(text, ['标题', '名称', '内容', '备注']);
    const title = extractQuoted(text) ?? labeledTitle ?? cleanupTitle(stripSpans(text, spans));
    if (title) {
      fields.title = title;
      spans.push(title);
    } else {
      fields.title =
        target === 'todo'
          ? '未命名待办'
          : target === 'schedule'
            ? DEFAULT_TITLES[fields.category] ?? '未命名日程'
            : '未命名事件';
      warnings.push('未识别到名称，已使用默认名称');
    }

    // 待办没有「地点」（它不是要发生的事件，而是一件要做的事）
    const location = extractLabeled(text, ['地点', '位置']);
    if (location && target !== 'todo') fields.location = location;
    const description = extractLabeled(text, ['备注', '说明']);
    if (description) fields.description = description;

    // 置信度：基础分 + 命中要素 - 警告扣分
    let confidence = 0.55;
    if (fields.title && !String(fields.title).startsWith('未命名')) confidence += 0.2;
    if (fields.date || fields.deadline || fields.startDate !== today) confidence += 0.15;
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

const TARGET_TEXT = { schedule: '日程', event: '日历事件', todo: '待办' };
const MATCH_VERB = { query: '查询', delete: '删除', complete: '标记完成', update: '修改', rollover: '顺延' };

/** 查询/删除/完成/顺延这类「按条件命中」动作的说明文案。 */
function explainMatchAction(action, target, rangeLabel, keyword) {
  const label = TARGET_TEXT[target] ?? target;
  const scope = action === 'rollover' ? '未完成的' : '';
  const suffix = keyword ? `（关键词：${keyword}）` : '';
  return `${MATCH_VERB[action] ?? action} ${rangeLabel} 的${scope}${label}${suffix}`;
}

function buildExplain(action, target, fields) {
  const verb = action === 'create' ? '添加' : action;
  if (target === 'todo') {
    const priority = { 0: '低', 1: '普通', 2: '紧急' }[fields.priority] ?? '普通';
    const hours = fields.estimatedHours ? `，预估 ${fields.estimatedHours} 小时` : '';
    const tags = fields.tags?.length ? `，标签 ${fields.tags.join('、')}` : '';
    return `${verb}待办「${fields.title}」：截止 ${fields.deadline}，优先级 ${priority}${hours}${tags}`;
  }
  const label = target === 'schedule' ? '日程' : '日历事件';
  const when =
    target === 'schedule'
      ? `${fields.date} ${fields.startTime ?? ''}${fields.endTime ? `-${fields.endTime}` : ''}`
      : `${fields.startDate}${fields.endDate && fields.endDate !== fields.startDate ? ` 至 ${fields.endDate}` : ''}`;
  const repeatNote = fields.repeat
    ? `，重复：${fields.repeat.type}${fields.repeat.interval > 1 ? `（每 ${fields.repeat.interval} 次）` : ''}`
    : '';
  const reminderNote = fields.reminders?.length ? `，提前 ${fields.reminders[0].offsetMinutes} 分钟提醒` : '';
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
    complete: '完成 / 做完 / 打卡 / 勾选（**只对待办有效**）',
    rollover: '顺延 / 挪到下周（**只对待办有效**）',
  },
  targets: {
    todo: '待办：只有截止日、有完成态。措辞含「待办 / 任务 / 作业 / 截止 / 提交 / 报名 / 打卡 / 完成」，以及**单日且没有具体时刻**的表达（如「明天 交实验报告」）',
    schedule: '日程：必须是时段（有起止时刻）。措辞含「日程 / 安排 / 课程 / 上课 / 自习 / 会议 / 例会 / 周会 / 站会 / 面试」',
    event: '日历事件：日期或日期区间粒度。措辞含「日历事件 / 日历 / 假期 / 节日 / 生日 / 纪念日」，以及跨天区间（如「10月20日到10月22日 期中考试」）',
  },
  dates: ['今天', '明天', '后天', '大后天', '下周三', '周五', '周末', '10月20日', '2025-10-20', '10月20日到10月22日'],
  times: ['15:00', '15:00-16:00', '下午3点', '下午3点半', '晚上7点到8点', '15:00 起 1 小时'],
  repeats: ['每天', '每周一', '每两周', '每月1日', '每年', '工作日'],
  reminders: ['提前10分钟', '提前半小时', '提前1天', '提醒'],
  priorities: ['重要 / 紧急', '不急（待办默认低、日程默认普通）'],
  todoFields: {
    deadline: '截止日 = 指令里的日期（缺省今天）',
    estimatedHours: '「预计2小时 / 半小时 / 30分钟」-> 工时（缺省 1）',
    tags: '#标签',
  },
  categories: {
    schedule: SCHEDULE_CATEGORIES,
    event: EVENT_CATEGORIES,
  },
  examples: [
    '添加日程 明天 15:00-16:00 项目周会 提前10分钟提醒',
    '添加日程 每周一 9点半 英语晨读',
    '添加待办 明天 交实验报告 预计2小时 重要 #实验',
    '添加待办 周五 提交作业',
    '添加日历事件 2025-10-20 到 2025-10-22 期中考试 重要',
    '添加日历事件 10月1日 国庆假期',
    '查询本周日程',
    '查询今天未完成的待办',
    '把明天的项目周会改到 16:00',
    '完成今天的英语听力',
    '顺延未完成的待办到本周',
    '删除日程 项目周会',
  ],
};

export { combine, isClock, isDateKey };
