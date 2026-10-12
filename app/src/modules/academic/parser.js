/**
 * 学业模块的本地规则解析器（target `grade`）。
 *
 * 作用：**没接 AI 时也能用**。「我学分绩多少」「把选修课都排除掉」「同步一下成绩」
 * 这类话不必依赖模型；接了 AI 时它也是更便宜、更确定的第一道。
 *
 * ⚠️ 必须**保守**：`CommandService.tryParse` 取**置信度最高**的草稿（同分时先注册的胜，
 * 日历 order=10 比本模块 order=30 先注册），所以本解析器只能在自己确实认得时才成功 ——
 * 否则会把「明天下午三点开会」这类日历指令抢过来，让日历模块永远收不到输入。
 * 因此下面每一条规则都要求出现**明确的学业词**（成绩 / 学分 / 绩点 / 课程名 + 纳入排除）。
 */

/**
 * 「在聊学业」的信号词。
 *
 * 刻意不包含裸的「课」：日历解析器是个"什么都能接"的兜底解析器（任何文本都能给出
 * 0.82~0.85 的置信度），所以本解析器只有在自己**确实认得**时才该成功。
 * 少了这道门槛，「把明天的会排除掉」会被当成"排除某门课"。
 */
const GRADE_WORDS = /成绩|分数|学分|学分绩|绩点|GPA|gpa|考了|考多少|多少分|几分|不及格|挂科|重修|课程|这门课|那门课|选修|必修/;
const TOGGLE_WORDS = /纳入|计入|排除|不算|去掉|勾上|取消勾选/;
const SYNC_WORDS = /同步|刷新|更新/;
/**
 * 「列举/查询」意图。
 *
 * ★ 「成绩单 / 成绩表 / 成绩报告」必须在这里，而且要**当成列举意图**：
 * 「我的成绩单」一个疑问词都不带，只靠 GRADE_WORDS 判不出列举意图就会返回 `ok:false`，
 * 随后被日历那个兜底解析器接走 —— 变成一个截止日今天的待办「我成绩单」。
 * 裸的「成绩 / 绩点 / 学分绩」同理：「这学期成绩」这种省略疑问词的说法非常常见，
 * 既然 GRADE_WORDS 已经确认是在聊学业，就不该再要求它带疑问词。
 */
const QUERY_WORDS = /多少|几门|查|看看|有没有|哪些|列出|列出来|统计|怎么样|成绩单|成绩表|成绩报告|成绩|绩点|学分绩/;

/**
 * 「整份成绩单」的说法。
 *
 * 单独拎出来是为了给更高置信度：`CommandService.tryParse` **取置信度最高者，同分时先注册的胜**，
 * 而日历解析器 order=10、本模块 order=30，日历先注册。日历对「明天把成绩单打印出来」这类
 * 带日期的话也能给出 0.9，和普通查询同分就会输给它。出现「成绩单/成绩表」时学业意图是明确的，
 * 给 0.93 才能稳定赢下这一类。
 */
const SHEET_WORDS = /成绩单|成绩表|成绩报告|成绩明细|报告单|绩点单/;

/**
 * 剥完词之后**剩下的这些东西不算课程名**。
 *
 * 为什么要单独维护一个集合，而不是只看长度：
 * 「成绩单」剥掉「成绩单」剩下「单」，「成绩表」剩下「表」，「列一下成绩」剩下「一下」，
 * 「把选修课都排除掉」剩下「掉」—— 都是长度 1~2 的语气词/量词残渣。一旦当成 keyword，
 * `commands.locate` 的模糊包含匹配就会拿「单」去比对全部课程名，结果必然 0 命中，
 * 用户看到的是「本地有成绩数据，但没有符合这些条件的课程」，比不加关键词还糟。
 * 所以遇到残渣就**宁可返回 ''（＝不加 keyword，列出全部成绩）**。
 */
const STOPWORDS = new Set([
  '单', '表', '单子', '了', '的', '我', '你', '是', '掉',
  '成绩', '绩点', '学分绩', '成绩单', '成绩表', '报告', '明细', '查询',
  '查', '看', '一下', '出来', '列出', '列', '全部', '所有', '都',
  '哪些', '几门', '不及格', '挂科', '及格', '学期', '学年',
]);

/**
 * 去掉口语里的疑问尾巴与语气词，剩下的当课程名。
 *
 * 先整块吃掉疑问短语，再清零散成分 —— 否则「高等数学考了多少分」会剩下「高等数学考了分」
 * （「多少」被吃掉但「分」还在），拿去做关键词匹配就永远查不到。
 */
function extractCourseName(text) {
  let name = text;
  for (const pattern of [
    /(考了多少分|考了多少|考了几分|考多少分|考多少|多少分|几分|是多少|是几|多少|怎么样|如何)/g,
    /(有哪些|有哪几门|有没有|哪几门|哪些|几门)/g,
    /^(把|将|帮我|请|给我|我|你)+/,
    /(都|全部|全都)/g,
    /(纳入|计入|排除|不算|去掉|勾上|取消勾选)/g,
    // 「不及格/挂科」已经落成 filters.failedOnly，留在串里只会变成查不到的 keyword
    /(不及格|挂科|没过的)/g,
    // ★ 长词必须排在短词前面，否则「成绩单」会被拆成「成绩」+ 残渣「单」
    /(成绩单|成绩表|成绩报告|成绩明细|报告单|报告|明细)/g,
    /(学分绩|绩点|成绩|分数|课程|选修课|必修课|选修|必修)/g,
    // 「导出/打印/列出/看看/查」这些是动作，不是课程名
    /(查询|查一下|查|看一下|看看|看|列出|列一下|列出来|列|导出|打印|出来|一下|给我)/g,
    // 时间词也不是课程名：「明天把成绩单打印出来」剥到这里会剩下「明天把」，
    // 拿它去模糊匹配课程名必然 0 命中（用户看到"有成绩数据但没有符合条件的课程"）。
    // 相对日期与绝对日期都吃掉 —— 这里不解析时间，只是别让它污染 keyword。
    /(今天|明天|后天|大后天|昨天|前天|今晚|明晚|这周|本周|这学期|本学期|下周|下个月|这个月|本月|上周|上个月)/g,
    /(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*[日号]?/g,
    /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g,
    /(这门|那门|的课|课)/g,
    // 学期代码与「学年/学期」字样同样不是课程名（「2024-2025学年第二学期有哪些课不及格」）；
    // 先吃带序号的完整代码（2024-2025-1），再吃光秃秃的学年区间，否则会剩下「-1」这种残渣。
    // 教务的 label 写成「2025-2026 学年 · 第 1 学期」，序号两边可能有空格，得容忍。
    /(\d{4})\s*[-–—]\s*(\d{4})\s*[-–—]\s*[12]/g,
    /(\d{4})\s*[-–—]\s*(\d{4})/g,
    /(学年|学期|第\s*[一二1１2２]\s*学期)/g,
    /[·•、]/g,
    /(吗|呢|？|\?|。|！|!|，|,)/g,
  ]) {
    name = name.replace(pattern, '');
  }
  // 句首/句尾剩下的「我」「你」也算没指定课程（「2024-2025-1 学期我考了多少分」会剩下「我」）
  name = name.replace(/^[的了是我你]+/, '').replace(/[的了是掉我你]+$/, '').trim();
  // 残渣（「单」「表」「一下」…）不当课程名：宁可不加 keyword 返回全部，也不要 0 命中
  if (!name || name.length <= 1 || STOPWORDS.has(name)) return '';
  // 剩下的若是代词，说明用户没指定具体课程
  if (/^(我|我的|你|他|她|它|这门|那门|全部|所有|一切)$/.test(name)) return '';
  return name;
}

/**
 * 从文本里认出学期，形如「2024-2025-1」「2024-2025学年第一学期」「2025-2026 学年 · 第 1 学期」。
 *
 * 「这学期 / 本学期」返回 `'current'` 而不是在这里定死日期：解析器保持纯函数（好测、好复现），
 * 由 `commands.js` 按"今天"推断具体学期，数据里没有那个学期时也能明确地退化。
 */
function extractTerm(text) {
  const code = text.match(/(\d{4})\s*[-–—]\s*(\d{4})\s*[-–—]\s*([12])/);
  if (code) return `${code[1]}-${code[2]}-${code[3]}`;
  // 「学年」与「第 X 学期」之间可能有空格、间隔号（2025-2026 学年 · 第 1 学期），统统容忍
  const named = text.match(/(\d{4})\s*[-–—]\s*(\d{4})\s*学年[\s·•,，、]*第?\s*([一二1１2２])\s*学期/);
  if (named) {
    const index = /[一1１]/.test(named[3]) ? '1' : '2';
    return `${named[1]}-${named[2]}-${index}`;
  }
  if (/(这|本|当前|这个)\s*学期/.test(text)) return 'current';
  return undefined;
}

export class AcademicParser {
  /** @param {{ academic?: object }} [deps] 目前不需要依赖，留作后续扩展。 */
  constructor(deps = {}) {
    this.deps = deps;
  }

  parse(rawText) {
    const raw = typeof rawText === 'string' ? rawText.trim() : '';
    const miss = { ok: false, raw: rawText, warnings: [] };
    if (!raw) return miss;

    // ---- 同步：要求「同步/刷新/更新」与学业词同现，避免抢走「刷新一下页面」这类 ----
    if (SYNC_WORDS.test(raw) && GRADE_WORDS.test(raw)) {
      return {
        ok: true,
        raw,
        action: 'sync',
        target: 'grade',
        filters: {},
        confidence: 0.92,
        explain: '同步教务成绩',
      };
    }

    const term = extractTerm(raw);
    const isGradeTalk = GRADE_WORDS.test(raw);
    // ★ 必须真的提到学业才继续 —— 日历解析器是兜底的，这里放宽就会把它抢了
    if (!isGradeTalk) return miss;

    const wantsToggle = TOGGLE_WORDS.test(raw);
    const include = /纳入|计入|勾上/.test(raw);
    const exclude = /排除|不算|去掉|取消勾选/.test(raw);

    // ---- 纳入 / 排除 ----
    if (wantsToggle && (include || exclude)) {
      const filters = {};
      if (term) filters.term = term;
      if (/选修/.test(raw)) filters.nature = '02';
      if (/必修/.test(raw)) filters.nature = '01';
      if (/不及格|挂科|没过的/.test(raw)) filters.failedOnly = true;

      const courseName = extractCourseName(raw);
      if (courseName) filters.keyword = courseName;

      return {
        ok: true,
        raw,
        action: include ? 'include' : 'exclude',
        target: 'grade',
        filters,
        confidence: 0.9,
        explain: `${include ? '纳入' : '排除'}${courseName ? `「${courseName}」` : '符合条件的课程'}`,
      };
    }

    // ---- 查询：需要疑问/列举意图，否则「我的课程设计」这类会被当成查询 ----
    const isListing = QUERY_WORDS.test(raw) || /不及格|挂科|没过的|全部|所有|列一下|有哪些/.test(raw);
    if (isListing) {
      const filters = {};
      if (term) filters.term = term;
      if (/必修/.test(raw)) filters.nature = '01';
      if (/选修/.test(raw)) filters.nature = '02';
      if (/不及格|挂科|没过的/.test(raw)) filters.failedOnly = true;
      if (/没纳入|已排除|不算的/.test(raw)) filters.included = false;
      if (/已纳入|算进去的|计入的/.test(raw)) filters.included = true;

      const courseName = extractCourseName(raw);
      if (courseName) filters.keyword = courseName;

      return {
        ok: true,
        raw,
        action: 'query',
        target: 'grade',
        filters,
        // 「成绩单/成绩表」是明确的学业意图，给得比普通查询高一点才不会被带日期的日历指令压过去
        confidence: SHEET_WORDS.test(raw) ? 0.93 : 0.9,
        explain: courseName ? `查询「${courseName}」的成绩` : '查询成绩',
      };
    }

    return miss;
  }
}
