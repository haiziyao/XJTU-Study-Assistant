/**
 * 复习调度内核：SM-2 的简化版。**纯函数，无 IO、不读系统时钟**。
 *
 * 为什么单独一个文件、且坚持纯函数：
 * - 调度是这个模块里唯一"算错了不会报错"的部分 —— 卡片不会抛异常，它只会以错误的节奏
 *   出现（该复习的永远不出现、刚忘掉的却被推到半年后），用户要到考试前才发现；
 * - 只有不读时钟、不碰存储，才能用固定的 `now` 把"第 1/2/3 次复习分别排到哪天"
 *   钉死在测试里，而不是靠等一天或者改系统时间。
 *
 * 与原始 SM-2 / Anki 的三处刻意简化：
 *
 * 1. **只保留 ease 一个因子**，不引入 interval modifier、fuzz、独立的重学队列。
 *    单机单用户的卡片量级不需要那套复杂度；尤其是 fuzz（随机抖动）会让"同样的输入
 *    得到不同结果"，而本模块明确要求 `computeNext` 可复现。
 *
 * 2. **again 不进重学队列，只把间隔清零、due 推后 10 分钟**：契约要的就是
 *    "当天再来一次"（`intervalDays = 0`）。再引入一套队列状态就多一处会写错的地方，
 *    而"今天还要再见到它一次"这个效果，靠 `intervalDays = 0` 已经拿到了。
 *
 * 3. **`hard` 不调 ease**：只有"忘了"（again）才说明这张卡本身难，该下调 ease；
 *    答对但吃力（hard）只压缩间隔增长。否则连点几次 hard 会把 ease 一路拖到 1.3，
 *    此后所有评分都变成 1.3 倍增长 —— 那不是用户的记忆变差了，是我们惩罚过头了。
 *
 * 间隔规则表（`intervalDays` 是这张卡**当前**的间隔，ease 是当前易度）：
 *
 * | 评分 | 间隔 | ease | reps | lapses |
 * | --- | --- | --- | --- | --- |
 * | again | 0（due = now + 10 分钟） | −0.2 | 归零 | +1 |
 * | hard  | <1 天 → 1；否则 max(间隔+1, round(间隔×1.2)) | 不变 | +1 | 不变 |
 * | good  | <1 天 → 1；第二次成功 → 3；否则 round(间隔×ease) | 不变 | +1 | 不变 |
 * | easy  | <1 天 → 4；否则 max(good 的结果+1, round(间隔×ease×1.3)) | +0.15 | +1 | 不变 |
 *
 * 所有间隔最后都夹到 `[0, 365]` 天，ease 夹到 `[1.3, 3.0]`。
 */

/** 四档评分。顺序即界面按钮顺序：忘了 → 吃力 → 记得 → 太简单。 */
export const GRADES = Object.freeze(['again', 'hard', 'good', 'easy']);

/** 中文标签：界面、指令回执、AI 解释共用一份，别再各写一套。 */
export const GRADE_LABEL = Object.freeze({
  again: '忘了',
  hard: '吃力',
  good: '记得',
  easy: '太简单',
});

/** ease 的上下限：低于 1.3 会出现"越复习越频繁"的死循环，高于 3.0 会一步跳到几年后。 */
export const MIN_EASE = 1.3;
export const MAX_EASE = 3.0;
/** 新卡的初始易度（SM-2 的经典取值 2.5）。 */
export const DEFAULT_EASE = 2.5;
/**
 * 单次间隔上限 365 天。
 *
 * 上限存在的理由不是"算法"，而是人：一年之内这门课早就考完了，把间隔排到两年后
 * 等于这张卡永远不会再出现；而上限的存在也保证了"再次复习时至少还能想起来"。
 */
export const MAX_INTERVAL_DAYS = 365;

/** again 之后的冷却时长：见文件头第 2 条。 */
export const AGAIN_DELAY_MINUTES = 10;
/** 各档的调整量（集中在这里，便于在报告/界面上解释"为什么这次变简单了"）。 */
export const EASE_PENALTY_AGAIN = 0.2;
export const EASE_BONUS_EASY = 0.15;
export const HARD_FACTOR = 1.2;
export const EASY_BONUS = 1.3;

/** 首次成功的间隔：good 1 天、easy 4 天（"太简单"的东西没必要明天再见）。 */
const FIRST_GOOD_DAYS = 1;
const FIRST_EASY_DAYS = 4;
/** 第二次成功固定 3 天：第一次和第二次之间拉不开差距没有意义，第三天才是分水岭。 */
const SECOND_GOOD_DAYS = 3;

const MINUTE_MS = 60_000;

/** ease 夹紧；脏数据（NaN / 字符串 / 缺字段）一律回落到默认值，不让 NaN 传染整条链。 */
export function clampEase(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_EASE;
  return Math.min(MAX_EASE, Math.max(MIN_EASE, num));
}

/** 评分是否合法（路由与指令层共用，避免"接口放行、调度抛异常"变成 500）。 */
export function isGrade(value) {
  return GRADES.includes(value);
}

/**
 * 把一组调度状态推进一天：用**日历加法**而不是 `+86400000` 毫秒。
 *
 * 跨夏令时/闰秒时毫秒加法会把"明天 09:00"变成"明天 08:00 或 10:00"，
 * 而用户的复习时间是挂在墙上的钟点。`setDate` 由 Date 自己处理月末与闰日。
 */
function shiftDays(date, days) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function asDate(now) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new TypeError(`now 不是合法时间：${JSON.stringify(now)}`);
  return date;
}

/** 当前状态的读法：缺字段/脏数据按"新卡"处理，而不是算出 NaN。 */
function stateOf(card) {
  return {
    intervalDays: Math.max(0, Math.floor(Number(card?.intervalDays) || 0)),
    reps: Math.max(0, Math.floor(Number(card?.reps) || 0)),
    lapses: Math.max(0, Math.floor(Number(card?.lapses) || 0)),
    ease: clampEase(card?.ease),
  };
}

/** good 的"标准增长"：首次 1 天 → 第二次 3 天 → 之后 间隔 × ease。 */
function goodInterval(intervalDays, reps, ease) {
  if (intervalDays < 1) return FIRST_GOOD_DAYS;
  if (reps <= 1) return SECOND_GOOD_DAYS;
  return Math.round(intervalDays * ease);
}

/**
 * 某一档评分在这张卡上会得到多少天**间隔**（不含 ease / reps 的变化，便于单独核对规则表）。
 *
 * @param {'again'|'hard'|'good'|'easy'} grade
 * @param {{ intervalDays?: number, reps?: number, ease?: number }} state
 * @returns {number} 天数（0 表示"当天再来一次"）
 */
export function intervalAfter(grade, state = {}) {
  if (!isGrade(grade)) throw new TypeError(`未知评分：${JSON.stringify(grade)}（可用：${GRADES.join(' / ')}）`);
  const { intervalDays, reps, ease } = stateOf(state);
  let days;
  switch (grade) {
    case 'again':
      days = 0;
      break;
    case 'hard':
      // 「较小系数增长」= 1.2 倍，且至少 +1 天：否则长间隔的卡几乎不动（365×1.2 还是 365）
      days = intervalDays < 1 ? 1 : Math.max(intervalDays + 1, Math.round(intervalDays * HARD_FACTOR));
      break;
    case 'easy':
      if (intervalDays < 1) {
        days = FIRST_EASY_DAYS;
      } else {
        // 与 good 同一状态下的结果比较，保证"太简单"永远比"记得"排得更远；
        // 否则易度低时 round(间隔×ease×1.3) 可能反而不大于 good，标签就名不副实了。
        days = Math.max(goodInterval(intervalDays, reps, ease) + 1, Math.round(intervalDays * ease * EASY_BONUS));
      }
      break;
    case 'good':
    default:
      days = goodInterval(intervalDays, reps, ease);
      break;
  }
  return Math.min(MAX_INTERVAL_DAYS, Math.max(0, days));
}

/**
 * **调度唯一入口**：给定卡片当前状态与一次评分，算出新的调度状态。
 *
 * 纯函数：不修改入参、不读时钟（`now` 由调用方给）、同样的输入恒定得到同样的输出。
 *
 * @param {object} card 卡片（只读 intervalDays / ease / reps / lapses）
 * @param {'again'|'hard'|'good'|'easy'} grade
 * @param {Date|string} [now] 复习发生的时刻；不传才读系统时钟
 * @returns {{ due: string, intervalDays: number, ease: number, reps: number, lapses: number, lastReviewedAt: string, lastGrade: string }}
 */
export function computeNext(card, grade, now = new Date()) {
  if (!isGrade(grade)) throw new TypeError(`未知评分：${JSON.stringify(grade)}（可用：${GRADES.join(' / ')}）`);
  const at = asDate(now);
  const current = stateOf(card);
  const intervalDays = intervalAfter(grade, current);

  // 先按"答对了"结算，再让 again 覆盖 —— 这样四种评分只有一处分支会改 reps/ease
  const next = {
    intervalDays,
    ease: current.ease,
    reps: current.reps + 1,
    lapses: current.lapses,
  };

  if (grade === 'again') {
    // 忘了 = 这条"连续答对"的链断了：reps 归零（下次答对重新从 1 天起步），
    // lapses 留痕（它是判断一张卡是否"天生难"的唯一依据），ease 下调
    next.reps = 0;
    next.lapses = current.lapses + 1;
    next.ease = clampEase(current.ease - EASE_PENALTY_AGAIN);
  } else if (grade === 'easy') {
    next.ease = clampEase(current.ease + EASE_BONUS_EASY);
  }

  // 间隔为 0 时 due 不能用 shiftDays(0)（那等于"现在就到期"，界面刷新一下它又回来了），
  // 给 10 分钟冷却：够完成后面几张卡，又保证它今天一定会再出现
  const due =
    next.intervalDays < 1
      ? new Date(at.getTime() + AGAIN_DELAY_MINUTES * MINUTE_MS)
      : shiftDays(at, next.intervalDays);

  return {
    due: due.toISOString(),
    intervalDays: next.intervalDays,
    ease: next.ease,
    reps: next.reps,
    lapses: next.lapses,
    lastReviewedAt: at.toISOString(),
    lastGrade: grade,
  };
}

/**
 * 这张卡现在该不该出现在复习队列里。
 *
 * 队列 = **未暂停 且 已到期**。暂停（suspended）是用户的显式决定（这门课这学期不上了、
 * 这张卡是错的），它必须优先于到期时间 —— 否则"暂停"就只是界面上的一个标签。
 *
 * 注意与 `service.dueToday()` 的区别：这里比的是 **now**（"现在就能复习"），
 * `dueToday()` 比的是"今天结束之前"（给定时唤醒用）。两者语义不同，不要互相替代。
 */
export function isDue(card, now = new Date()) {
  if (!card || card.suspended) return false;
  const at = Date.parse(card.due);
  return Number.isFinite(at) && at <= asDate(now).getTime();
}
