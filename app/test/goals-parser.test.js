/**
 * 目标模块本地解析器的测试：`我打算 12 月前考完六级` 这类说法 → `target: "goal"` 草稿。
 *
 * 为什么解析器值得单独一个测试文件：
 *   1. 它是**唯一在没配 AI 时**把中文变成目标的路径，坏了用户就只能手填表单；
 *   2. 它的失败模式很具体 —— 标题里剩下一个"前"、日期算成明年、把待办抢过来，
 *      这些都只有对着具体句子才能发现（实测确实踩过前两个）；
 *   3. **边界都在日期上**：跨月（3 月说"12 月前"）、跨年（"明年 6 月前"）、学期末顺延。
 *      这些必须注入固定时钟，否则只在某些月份跑得过。
 *
 * 同时锁死"不该接的句子不要接"：`记住…` 归记忆、`明天交实验报告` 归待办。
 * `tryParse` 是按置信度取最高的，本解析器一旦贪心就会把这些句子抢成目标。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { GoalParser, parseTargetDate, resolveTargetDate } from '../src/modules/goals/parser.js';

/** 固定"今天"= 2026-03-15（周日），避免测试随真实日期漂移。 */
const NOW = new Date('2026-03-15T09:00:00');

const parse = (text, now = NOW) => new GoalParser().parse(text, { now });

test('goals 解析器：「我打算 12 月前考完六级」→ 考试 + 12 月底', () => {
  const draft = parse('我打算 12 月前考完六级');
  assert.equal(draft.ok, true);
  assert.equal(draft.target, 'goal');
  assert.equal(draft.action, 'create');
  assert.equal(draft.fields.kind, 'exam', '带"六级"要判成考试');
  assert.equal(draft.fields.title, '考完六级', '标题里不能剩下"前"或日期残渣');
  assert.equal(draft.fields.targetDate, '2026-12-31', '「N 月前」= 那个月月底之前');
  assert.equal(draft.fields.source, 'command');
  assert.equal(draft.provider, 'rules');
  assert.equal(draft.confidence, 0.9);
  assert.ok(draft.warnings.some((text) => text.includes('估计')), '近似日期要给出警告让用户确认');
  assert.match(draft.explain, /考完六级/);
});

test('goals 解析器：日期在前在后都认，标题都能摘干净', () => {
  const cases = [
    ['定个目标 考完六级 12月前', '考完六级'],
    ['目标：期末前写完大作业', '写完大作业'],
    ['我计划明年6月前考过雅思', '考过雅思'],
    ['我打算 2026-12-15 前完成毕业设计', '完成毕业设计'],
    ['目标 12月31日之前提交论文', '提交论文'],
    ['目标：这学期结束前刷完 200 道题', '刷完 200 道题'],
  ];
  for (const [text, expected] of cases) {
    const draft = parse(text);
    assert.equal(draft.ok, true, `${text} 应该能解析`);
    assert.equal(draft.fields.title, expected, `${text} 的标题应该是「${expected}」`);
  }
});

test('goals 解析器：日期边界 —— 跨月、跨年、学期末顺延', () => {
  // 「N 月前」= 那个月月底；月份已过则顺势理解成明年
  assert.equal(parseTargetDate('12 月前考完', new Date('2026-03-15T09:00:00')).dateKey, '2026-12-31');
  assert.equal(parseTargetDate('12 月前考完', new Date('2026-12-20T09:00:00')).dateKey, '2026-12-31', '12 月 20 日说 12 月前仍是今年');
  assert.equal(parseTargetDate('1 月前考完', new Date('2026-12-20T09:00:00')).dateKey, '2027-01-31', '1 月已过 → 明年 1 月');
  assert.equal(parseTargetDate('2 月前考完', new Date('2026-03-15T09:00:00')).dateKey, '2027-02-28', '平年 2 月是 28 日');

  // 显式年份 / 明年 / 后年
  assert.equal(parseTargetDate('2026-06-15 交', NOW).dateKey, '2026-06-15');
  assert.equal(parseTargetDate('明年6月前考过雅思', NOW).dateKey, '2027-06-30');
  assert.equal(parseTargetDate('后年拿下驾照', NOW).dateKey, '2028-12-31');
  assert.equal(parseTargetDate('今年12月前', NOW).dateKey, '2026-12-31', '显式"今年"不跨年');

  /**
   * 学期末近似：取**最近一个还没到的**学期末（1 月中 / 7 月中两个锚点）。
   *
   * 这条边界想清楚过一次：1 月 5 日说"期末前"指的是即将到来的 7 月那个期末，
   * 而不是 10 天前刚过去的 1 月 15 日，也不是 12 个月后的下一个 1 月。
   */
  assert.equal(parseTargetDate('期末前', new Date('2026-06-01T09:00:00')).dateKey, '2026-07-15', '6 月 → 7 月中的期末');
  assert.equal(parseTargetDate('期末前', new Date('2026-09-01T09:00:00')).dateKey, '2027-01-15', '9 月 → 明年 1 月中的期末');
  assert.equal(parseTargetDate('期末前', new Date('2026-01-05T09:00:00')).dateKey, '2026-01-15', '刚开学时最近的那个期末就在 10 天后');
  assert.equal(parseTargetDate('期末前', new Date('2026-01-20T09:00:00')).dateKey, '2026-07-15', '期末已过 → 下一个（7 月）');

  // 解析结果必须是合法日期键（与服务层同一条校验）
  for (const text of ['12 月前', '明年6月前', '期末前', '2026-06-15', '后年']) {
    const resolved = resolveTargetDate(text, NOW);
    assert.ok(resolved, `${text} 应该能解析出日期`);
    assert.match(resolved.dateKey, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('goals 解析器：kind 的推断（考试 / 截止 / 普通目标）', () => {
  assert.equal(parse('我打算 12 月前考完六级').fields.kind, 'exam');
  assert.equal(parse('目标：期末前通过考研初试').fields.kind, 'exam');
  assert.equal(parse('目标 12月31日前提交论文').fields.kind, 'deadline', '"提交"是截止类');
  assert.equal(parse('目标 明年6月前报名夏令营').fields.kind, 'deadline');
  assert.equal(parse('我打算 后年拿下驾照').fields.kind, 'goal');
});

test('goals 解析器：不该接的句子一律放行给别的解析器', () => {
  // ① 没有目标措辞
  assert.equal(parse('明天 交实验报告').ok, false);
  assert.equal(parse('记住 我习惯晚上学习').ok, false);
  assert.equal(parse('随便说点什么').ok, false);

  // ② 有目标措辞但没有日期：宁可说"听不出日期"，也不要生成一条今天到期的假目标
  const noDate = parse('我准备考研');
  assert.equal(noDate.ok, false);
  assert.match(noDate.warnings[0], /日期/);

  // ③ 近端日期归待办/日程（明天、下周、今晚、具体时刻）
  for (const text of ['目标 明天写完作业', '我打算 下周完成报告', '我计划 今晚复习完']) {
    const draft = parse(text);
    assert.equal(draft.ok, false, `${text} 不该被目标解析器接走`);
    assert.match(draft.warnings[0], /待办|日程/);
  }

  // ④ 只有触发词没有内容
  assert.equal(parse('目标：').ok, false);
});

test('goals 解析器：置信度低于记忆（0.95）高于日历兜底（0.82~0.87）', () => {
  const draft = parse('我打算 12 月前考完六级');
  assert.ok(draft.confidence > 0.87, '要能压过日历兜底解析器');
  assert.ok(draft.confidence < 0.95, '不能压过「记住…」的记忆解析器');
});

test('goals 解析器：字段形状与 REST 入口一致（能直接喂给 POST /goals）', () => {
  const draft = parse('我打算 12 月前考完六级');
  // 只允许出现服务层认识的字段：多一个未知字段就意味着"解析能过、落库被忽略"
  for (const key of Object.keys(draft.fields)) {
    assert.ok(['title', 'kind', 'targetDate', 'source', 'milestones'].includes(key), `未知字段 ${key}`);
  }
  assert.deepEqual(draft.fields.milestones, [], '从一句话里猜不出里程碑，留空让用户补');
  assert.equal(draft.fields.remindDays, undefined, '默认阈值由服务层给，规则层不写第二份');
});
