/**
 * 卡片模块的**纯函数**测试：调度内核（SM-2 简化版）与笔记抽取规则。
 *
 * 为什么这些必须与集成测试分开、且不碰 HTTP：
 *   1. 调度是这个模块里唯一"算错了不报错"的部分 —— 卡片只会以错误的节奏出现。
 *      纯函数才能用固定的 `now` 把"第 1/2/3 次复习分别排到哪天"钉死，
 *      不然验证一次 3 天后的复习要等 3 天（或者去改系统时间，那会连累整个测试套件）；
 *   2. 抽取规则决定了"笔记里哪些内容会变成卡片"，它是**幂等**的地基：
 *      同样的笔记必须每次抽出同样的正面，否则重复生成就会造出重复卡。
 *
 * 全部按本地时区断言日期（用 shared/time.js 的 toDateKey），不写死 UTC 串。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { toDateKey } from '../src/shared/time.js';
import { MAX_FRONT_CHARS } from '../src/modules/cards/model.js';
import {
  DEFAULT_EASE,
  GRADES,
  MAX_EASE,
  MAX_INTERVAL_DAYS,
  MIN_EASE,
  computeNext,
  intervalAfter,
  isDue,
} from '../src/modules/cards/scheduler.js';
import {
  EXTRACT_RULES,
  MIN_BACK_CHARS,
  MIN_FRONT_CHARS,
  extractCandidates,
  normalizeFront,
} from '../src/modules/cards/extract.js';

/** 固定"现在"：本地 2026-03-05 09:00（不写 Z，避免被时区推走）。 */
const NOW = new Date('2026-03-05T09:00:00');
const LATER = new Date('2026-03-05T15:00:00');

/** 一张刚建出来的卡：没有间隔、没有历史。 */
const fresh = () => ({ intervalDays: 0, ease: DEFAULT_EASE, reps: 0, lapses: 0, suspended: false });

const clockOf = (iso) => {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

// ---------------------------------------------------------------- 调度：四档评分

test('调度：四档评分在新卡上各自推进什么（间隔 / 易度 / 计数 / 到期时间）', () => {
  assert.deepEqual([...GRADES], ['again', 'hard', 'good', 'easy'], '评分档位是契约的一部分');

  const card = fresh();

  const again = computeNext(card, 'again', NOW);
  assert.equal(again.intervalDays, 0, '忘了 → 间隔归零');
  assert.equal(again.ease, DEFAULT_EASE - 0.2, '忘了 → 易度下调');
  assert.equal(again.reps, 0, '忘了 → 连续答对链归零');
  assert.equal(again.lapses, 1, '忘了 → 遗忘次数 +1');
  assert.equal(again.lastGrade, 'again');
  assert.equal(again.lastReviewedAt, NOW.toISOString());
  assert.equal(new Date(again.due).getTime() - NOW.getTime(), 10 * 60 * 1000, '忘了之后 10 分钟冷却');
  assert.equal(toDateKey(new Date(again.due)), toDateKey(NOW), '当天再来一次');

  const hard = computeNext(card, 'hard', NOW);
  assert.equal(hard.intervalDays, 1, '吃力 → 小步前进（新卡仍从 1 天起）');
  assert.equal(hard.ease, DEFAULT_EASE, '吃力不调易度（只有"忘了"说明这张卡难）');
  assert.equal(hard.reps, 1);
  assert.equal(hard.lapses, 0);

  const good = computeNext(card, 'good', NOW);
  assert.equal(good.intervalDays, 1, '记得 → 首次 1 天');
  assert.equal(good.ease, DEFAULT_EASE);
  assert.equal(good.reps, 1);
  assert.equal(toDateKey(new Date(good.due)), '2026-03-06', '到期落在明天');
  assert.equal(clockOf(good.due), '09:00', '保留复习时刻（按日历天推进，不是简单加毫秒）');

  const easy = computeNext(card, 'easy', NOW);
  assert.equal(easy.intervalDays, 4, '太简单 → 首次就排 4 天');
  assert.equal(easy.ease, DEFAULT_EASE + 0.15, '太简单 → 易度上调');
  assert.equal(easy.reps, 1);
});

test('调度：good 的标准增长是 1 天 → 3 天 → 之后 间隔 × ease', () => {
  let card = fresh();
  const intervals = [];
  for (let i = 0; i < 4; i += 1) {
    card = { ...card, ...computeNext(card, 'good', NOW) };
    intervals.push(card.intervalDays);
  }
  // 1 → 3 → 3×2.5=7.5 取整 8 → 8×2.5=20
  assert.deepEqual(intervals, [1, 3, 8, 20]);
  assert.equal(card.ease, DEFAULT_EASE, 'good 不改易度，增长才可预测');
  assert.equal(card.reps, 4);
});

test('调度：hard 只小幅增长，easy 永远比同状态的 good 排得更远', () => {
  const mature = { intervalDays: 30, ease: 2.5, reps: 4, lapses: 0 };
  assert.equal(intervalAfter('hard', mature), 36, '30 × 1.2');
  assert.equal(intervalAfter('good', mature), 75, '30 × 2.5');
  assert.equal(intervalAfter('easy', mature), 98, '30 × 2.5 × 1.3');
  assert.ok(intervalAfter('hard', mature) < intervalAfter('good', mature));
  assert.ok(intervalAfter('good', mature) < intervalAfter('easy', mature));

  // 易度已经被压到下限时，"太简单"仍必须严格长于"记得"——
  // 否则按钮的标签就名不副实（用户点"太简单"反而更早见到它）
  const lowEase = { intervalDays: 30, ease: MIN_EASE, reps: 4, lapses: 2 };
  assert.ok(intervalAfter('easy', lowEase) > intervalAfter('good', lowEase));

  // 长间隔的卡：hard 至少要 +1 天，不能因为取整几乎不动
  assert.equal(intervalAfter('hard', { intervalDays: 4, ease: 2.5, reps: 3 }), 5);
});

// ---------------------------------------------------------------- 调度：边界

test('调度：ease 有下限 1.3 与上限 3.0', () => {
  let card = fresh();
  for (let i = 0; i < 12; i += 1) card = { ...card, ...computeNext(card, 'again', NOW) };
  assert.equal(card.ease, MIN_EASE, '一直忘也不能低于 1.3（否则越复习越频繁）');
  assert.equal(card.lapses, 12, '遗忘次数照实累计');

  let easy = fresh();
  for (let i = 0; i < 12; i += 1) easy = { ...easy, ...computeNext(easy, 'easy', NOW) };
  assert.equal(easy.ease, MAX_EASE, '一直"太简单"也不能高于 3.0');

  // 脏数据（缺字段 / NaN / 越界）一律收敛，不让 NaN 传染整条调度链
  assert.equal(computeNext({ intervalDays: 0 }, 'good', NOW).ease, DEFAULT_EASE);
  assert.equal(computeNext({ ease: Number.NaN }, 'easy', NOW).ease, DEFAULT_EASE + 0.15);
  assert.equal(computeNext({ ease: 0.5 }, 'good', NOW).ease, MIN_EASE);
  assert.equal(computeNext({ ease: 99 }, 'good', NOW).ease, MAX_EASE);
});

test('调度：单次间隔上限 365 天', () => {
  const mature = { intervalDays: 300, ease: 3.0, reps: 9, lapses: 0 };
  assert.equal(computeNext(mature, 'good', NOW).intervalDays, MAX_INTERVAL_DAYS, '300 × 3 = 900 → 封顶');
  assert.equal(computeNext(mature, 'easy', NOW).intervalDays, MAX_INTERVAL_DAYS);
  assert.equal(computeNext({ intervalDays: 365, ease: 2.5, reps: 9 }, 'hard', NOW).intervalDays, MAX_INTERVAL_DAYS);
  assert.equal(toDateKey(new Date(computeNext(mature, 'easy', NOW).due)), '2027-03-05', '封顶后正好一年');
});

// ---------------------------------------------------------------- 调度：纯函数与同日复习

test('调度：computeNext 是纯函数（同输入恒等、不改入参、非法评分抛错）', () => {
  const card = Object.freeze({ intervalDays: 3, ease: 2.5, reps: 2, lapses: 1, suspended: false });
  const before = JSON.stringify(card);
  assert.deepEqual(computeNext(card, 'good', NOW), computeNext(card, 'good', NOW));
  assert.equal(JSON.stringify(card), before, '不改入参');

  const next = computeNext(card, 'easy', NOW);
  next.ease = 99;
  assert.equal(card.ease, 2.5, '返回的是新对象，改它不影响入参');

  assert.throws(() => computeNext(card, 'perfect', NOW), TypeError);
  assert.throws(() => computeNext(card, undefined, NOW), TypeError);
  assert.throws(() => computeNext(card, 'good', 'not-a-date'), TypeError, '非法 now 要报错而不是算出 NaN');
});

test('调度：同一天里多次复习（good → again → good 回到 1 天起步）', () => {
  let card = fresh();

  const first = computeNext(card, 'good', NOW);
  assert.equal(first.intervalDays, 1);
  card = { ...card, ...first };

  const failed = computeNext(card, 'again', LATER);
  assert.equal(failed.intervalDays, 0, '当天忘掉 → 间隔清零');
  assert.equal(failed.reps, 0, '连续答对链断了');
  assert.equal(failed.lapses, 1);
  assert.equal(toDateKey(new Date(failed.due)), toDateKey(LATER), '仍然排在今天');
  assert.equal(new Date(failed.due).getTime() - LATER.getTime(), 10 * 60 * 1000);
  card = { ...card, ...failed };

  const againGood = computeNext(card, 'good', new Date('2026-03-05T15:30:00'));
  assert.equal(againGood.intervalDays, 1, '重新从 1 天起步（不是接着 1 天继续乘）');
  assert.equal(againGood.reps, 1);
  assert.equal(againGood.ease, DEFAULT_EASE - 0.2, '这次"忘了"的代价仍然记在易度上');

  // 同一天里连续两次 good：第二次才是 3 天（reps 已经推进过一次）
  const twice = computeNext({ ...fresh(), ...computeNext(fresh(), 'good', NOW) }, 'good', LATER);
  assert.equal(twice.intervalDays, 3);
});

test('调度：暂停的卡片不进到期队列，但评分照算', () => {
  const overdue = '2026-03-01T00:00:00.000Z';
  assert.equal(isDue({ due: overdue, suspended: false }, NOW), true);
  assert.equal(isDue({ due: overdue, suspended: true }, NOW), false, '暂停优先于到期时间');
  assert.equal(isDue({ due: '2026-04-01T00:00:00.000Z', suspended: false }, NOW), false);
  assert.equal(isDue({ due: '不是时间' }, NOW), false, '脏数据不进队列而不是抛错');

  // 暂停只决定"进不进队列"：用户显式复习一张暂停卡时，排期照算（命令层允许这么用）
  const parked = { ...fresh(), due: overdue, suspended: true };
  const active = { ...fresh(), due: overdue, suspended: false };
  assert.deepEqual(computeNext(parked, 'good', NOW), computeNext(active, 'good', NOW));
});

// ---------------------------------------------------------------- 抽取规则

/** 一篇同时含三种结构的笔记：标题+内容、问句+答案、列表项+子项（还有一个待办复选框）。 */
const NOTE_BODY = [
  '# 数据结构',
  '',
  '## 二叉树的遍历',
  '前序遍历的顺序是「根 → 左 → 右」。',
  '',
  '图的最短路径算法有哪些？',
  'Dijkstra 与 Bellman-Ford。',
  '',
  '- 中序遍历：左 → 根 → 右',
  '- 后序遍历：',
  '  - 先左子树',
  '  - 再右子树',
  '  - 最后根',
  '',
  '- [ ] 复习第三章',
  '',
].join('\n');

test('抽取：标题 + 紧随内容、问号行 + 下一行、列表项 + 子项 三种规则', () => {
  const { candidates, ignored } = extractCandidates({ body: NOTE_BODY });
  assert.equal(ignored, 0);
  assert.deepEqual(candidates, [
    { front: '二叉树的遍历', back: '前序遍历的顺序是「根 → 左 → 右」。', rule: 'heading' },
    { front: '图的最短路径算法有哪些？', back: 'Dijkstra 与 Bellman-Ford。', rule: 'question' },
    { front: '中序遍历', back: '左 → 根 → 右', rule: 'list' },
    { front: '后序遍历', back: '先左子树\n再右子树\n最后根', rule: 'list' },
  ]);
  // 顶层标题下面立刻是下一个标题 → 没有答案，不成卡，也不算"被跳过"
  assert.equal(candidates.some((item) => item.front === '数据结构'), false);
  // 复选框是待办，不是知识
  assert.equal(candidates.some((item) => item.front.includes('复习第三章')), false);
  // 规则名是回执的一部分（界面用它显示"这张卡从哪来"），只能是声明过的那几个
  for (const candidate of candidates) assert.ok(EXTRACT_RULES.includes(candidate.rule), `未知规则：${candidate.rule}`);
});

test('抽取：一字正面是合法的中文问题（「熵」），一字答案不算', () => {
  // 门槛取 1 是有意的：中文里一个词常常只有一个字，而 `## 熵` 是最标准的一张卡
  assert.equal(MIN_FRONT_CHARS, 1);
  assert.ok(MIN_BACK_CHARS >= 2);
  const one = extractCandidates({ body: '## 熵\n\n混乱度的度量\n' });
  assert.equal(one.candidates[0].front, '熵');
  // 答案只有一个字 → 不成卡（多半是符号或占位），且如实计入 ignored
  assert.deepEqual(extractCandidates({ body: '什么是熵？\n熵\n' }), { candidates: [], ignored: 1 });
});

test('抽取：冒号行 + 下一行（列表里的内联「术语：解释」同样成立）', () => {
  const body = ['熵：', '混乱度的度量。', '', '- 状态函数：只与状态有关', ''].join('\n');
  const { candidates } = extractCandidates({ body });
  assert.deepEqual(candidates, [
    { front: '熵', back: '混乱度的度量。', rule: 'colon' },
    { front: '状态函数', back: '只与状态有关', rule: 'list' },
  ]);
});

test('抽取：同一篇笔记重复抽取结果完全一致（幂等的地基）', () => {
  const first = extractCandidates({ body: NOTE_BODY });
  const second = extractCandidates({ body: NOTE_BODY });
  assert.deepEqual(second, first);
  // 换行符差异（Windows 上编辑过的笔记）也要抽出同样的东西
  assert.deepEqual(extractCandidates({ body: NOTE_BODY.replace(/\n/g, '\r\n') }).candidates, first.candidates);
});

test('抽取：没有实义的候选进 ignored，超长候选不被静默截断', () => {
  // 纯符号的答案不是知识：计数出来让用户看得见"有一段内容没能成卡"
  assert.deepEqual(extractCandidates({ body: '什么是熵？\n√\n' }), { candidates: [], ignored: 1 });

  const longFront = 'x'.repeat(MAX_FRONT_CHARS + 1);
  const long = extractCandidates({ body: `## ${longFront}\n\n答案内容\n` });
  assert.equal(long.candidates.length, 0);
  assert.equal(long.ignored, 1, '过长候选进 ignored（截断会悄悄丢掉用户的内容）');

  // 裸列表项（没有子项也没有解释）本来就不是成对的知识：跳过且不报"ignored"
  assert.deepEqual(extractCandidates({ body: '- 一条碎片\n- 另一条碎片\n' }), { candidates: [], ignored: 0 });
});

test('抽取：normalizeFront 把全角与空白的等价写法归一到同一个键', () => {
  assert.equal(normalizeFront('熵：'), normalizeFront('熵:'));
  assert.equal(normalizeFront('  What   is  ENTROPY '), 'what is entropy');
  // 标点不同 = 不同提问方式：故意不合并（合并了用户连换个问法都不行）
  assert.notEqual(normalizeFront('什么是熵？'), normalizeFront('什么是熵'));
  assert.equal(normalizeFront(''), '');
});
