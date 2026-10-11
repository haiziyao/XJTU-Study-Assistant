/**
 * 周次解析与位图互转。
 *
 * 上游（jwapp 课表）把周次压成位图字符串 `SKZC`，例如 `"1111001111"` → 第 1,2,3,4,7,8,9,10 周
 * （下标从 0 开始对应第 1 周），天然能表达单双周与不连续周。
 *
 * 但位图不是人类可读的，考勤/研究生那套接口给的是**周次字符串**，形如：
 *   `1-16周`、`第1-4,6-16周`、`1-16单周`、`2-16双周`、`第1-16周(单)`、`3,5,7周`、`第1周`
 * 参考实现（XJTUToolBox 的研究生解析函数）遇到 `1-16单周` 会 `int("16单")` 抛错，
 * 然后**静默丢掉整段**（实测 `1-16单周 → []`，这门课直接不入库）。我们明确不继承这个缺陷：
 *
 * - 显式支持 `单/双` 后缀与 `(单)/(双)` 写法（含中文括号）；
 * - 任何无法识别的片段都抛 `WeekParseError`（带原始的坏片段），**绝不静默返回空数组**；
 * - 「本来就没有周次」用空串/null 表达，与「解析失败」严格区分，由调用方决定怎么处理。
 */

/** 周次解析失败。带 `code` 便于上层翻译成 HTTP 400。 */
export class WeekParseError extends Error {
  constructor(message, { fragment = null, input = null } = {}) {
    super(message);
    this.name = 'WeekParseError';
    this.code = 'WEEK_PARSE_FAILED';
    this.fragment = fragment;
    this.input = input;
  }
}

/** 与 weeksToBitmap 对偶：位图长度上限（标准学期 18 周、小学期 8 周，留足余量）。 */
export const MAX_BITMAP_LENGTH = 60;

/** 全角标点 → 半角（只处理周次字符串里会出现的几种）。 */
function toHalfWidth(text) {
  return String(text)
    .replace(/[\uFF0C\u3001\uFF1B]/g, ',') // ，、；
    .replace(/[\uFF08]/g, '(')
    .replace(/[\uFF09]/g, ')')
    .replace(/[\uFF0D\u2013\u2014\u301C~]/g, '-') // － – — 〜 ~
    .replace(/\u3000/g, ' ');
}

/**
 * 解析「周次字符串」为升序去重的周次数组。
 *
 * @param {string} input 例如 `第1-4，6-16周` / `1-16单周` / `2-16双周` / `第1-16周(单)` / `3,5,7周`
 * @returns {number[]} 升序去重的周次（如 `[1,2,3,4,7]`）
 * @throws {WeekParseError} 任何无法识别的片段（空输入除外：空输入返回 `[]`）
 */
export function parseWeeksString(input) {
  if (input === undefined || input === null) return [];
  if (typeof input !== 'string' && typeof input !== 'number') {
    throw new WeekParseError(`周次必须是字符串，收到 ${typeof input}`, { input });
  }
  const raw = String(input).trim();
  if (!raw) return [];

  // 先剥掉「周」与「第」：前者可能出现在整串末尾（1-16周）也可能夹在片段之间（1-4周,6-16周），
  // 后者是纯前缀（第1-16周）。剥掉之后，剩下的语法只有数字、连字符、逗号与单双周字样。
  let text = raw.replace(/周/g, ' ').replace(/第/g, ' ').trim();
  if (!text) throw new WeekParseError(`周次里没有任何数字：${raw}`, { input: raw });
  text = toHalfWidth(text).replace(/\s+/g, ' ');

  // 单双周标记：`单周` / `(单)` / `（单）` / 整串末尾的 `单` 都算。
  // 注意 `1-16单周` 里「单」紧跟在数字后面（没有分隔符），所以判定不能用「空格/逗号边界」，
  // 而要在剥掉「周」「第」之后再匹配。
  let parity = null;
  const markParity = (kind, label) => {
    if (parity && parity !== kind) throw new WeekParseError(`周次里同时出现「${parity === 'odd' ? '单' : '双'}」和「${label}」`, { input: raw });
    parity = kind;
  };
  if (/单周/.test(text) || /\(单\)/.test(text)) markParity('odd', '单');
  if (/双周/.test(text) || /\(双\)/.test(text)) markParity('even', '双');
  text = text.replace(/单周|双周|\(单\)|\(双\)/g, ' ');
  // 只剩一个拖尾的 `单` / `双`（形如 `1-16单`）：先剥掉它再判定，避免踩「前面是数字、没有分隔符」的坑。
  // 只有当剥掉之后剩下的部分真的是周次表达式（只含数字、连字符、逗号）时才认作标记，
  // 这样 `1-16单` 能被正确识别，而 `abc单` 仍然会走到下面的「无法识别片段」报错。
  if (!parity) {
    const trailing = text.trimEnd();
    const tail = trailing.slice(-1);
    const body = trailing.slice(0, -1);
    if ((tail === '单' || tail === '双') && body && /^[\d,\-\s]+$/.test(body)) {
      markParity(tail === '单' ? 'odd' : 'even', tail);
      text = body;
    }
  }
  text = text.replace(/\s+/g, '');

  const weeks = new Set();
  if (text) {
    for (const fragment of text.split(',')) {
      if (!fragment) continue;
      const range = fragment.match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) {
        const from = Number(range[1]);
        const to = Number(range[2]);
        if (from < 1 || to < 1) throw new WeekParseError(`周次必须从 1 开始：第 ${fragment} 周`, { fragment, input: raw });
        if (to < from) throw new WeekParseError(`周次区间起止颠倒：第 ${fragment} 周`, { fragment, input: raw });
        if (to > MAX_BITMAP_LENGTH) throw new WeekParseError(`周次超出合理范围（>${MAX_BITMAP_LENGTH}）：第 ${fragment} 周`, { fragment, input: raw });
        for (let week = from; week <= to; week += 1) weeks.add(week);
        continue;
      }
      const single = fragment.match(/^(\d+)$/);
      if (single) {
        const week = Number(single[1]);
        if (week < 1) throw new WeekParseError(`周次必须从 1 开始：第 ${fragment} 周`, { fragment, input: raw });
        if (week > MAX_BITMAP_LENGTH) throw new WeekParseError(`周次超出合理范围（>${MAX_BITMAP_LENGTH}）：第 ${fragment} 周`, { fragment, input: raw });
        weeks.add(week);
        continue;
      }
      throw new WeekParseError(`无法识别的周次片段「${fragment}」（原始输入：${raw}）`, { fragment, input: raw });
    }
  }

  let list = [...weeks].sort((a, b) => a - b);
  if (parity === 'odd') list = list.filter((week) => week % 2 === 1);
  if (parity === 'even') list = list.filter((week) => week % 2 === 0);
  if (parity && !list.length) {
    // 例如「第2-16周(单)」：区间里确实一个符合奇偶的周都没有，这属于自相矛盾的数据
    throw new WeekParseError(`周次「${raw}」的区间与单双周标记矛盾，没有任何一周符合`, { input: raw });
  }
  return list;
}

/**
 * 位图字符串 → 周次数组。
 * 只认 `1`；其余字符（含空格、`0`）都当「不上课」，避免上游掺进来的脏字符把整条数据搞坏。
 */
export function bitmapToWeeks(skzc) {
  if (skzc === undefined || skzc === null) return [];
  const text = String(skzc).trim();
  if (!text) return [];
  const weeks = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '1') weeks.push(index + 1);
  }
  return weeks;
}

/** 周次数组 → 位图字符串（第 1 周在最高位，即字符串第 0 位）。 */
export function weeksToBitmap(weeks, total = MAX_BITMAP_LENGTH) {
  const length = Number(total);
  if (!Number.isInteger(length) || length < 1 || length > MAX_BITMAP_LENGTH) {
    throw new Error(`位图长度必须是 1~${MAX_BITMAP_LENGTH} 之间的整数，收到：${JSON.stringify(total)}`);
  }
  const bits = new Array(length).fill('0');
  for (const value of weeks ?? []) {
    const week = Number(value);
    if (!Number.isInteger(week) || week < 1) throw new Error(`周次必须是正整数，收到：${JSON.stringify(value)}`);
    if (week > length) {
      throw new Error(`周次 ${week} 超出位图长度 ${length}（该学期的总周数不够）`);
    }
    bits[week - 1] = '1';
  }
  return bits.join('');
}

/** 人类可读的周次描述，例如 `[1,2,3,7] -> "第1-3,7周"`。用于预览里的说明文字。 */
export function describeWeeks(weeks) {
  const list = [...new Set((weeks ?? []).map(Number))].filter((week) => Number.isInteger(week) && week > 0).sort((a, b) => a - b);
  if (!list.length) return '无';
  const parts = [];
  let start = list[0];
  let previous = list[0];
  for (const week of list.slice(1)) {
    if (week === previous + 1) {
      previous = week;
      continue;
    }
    parts.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = week;
    previous = week;
  }
  parts.push(start === previous ? `${start}` : `${start}-${previous}`);
  return `第${parts.join(',')}周`;
}
