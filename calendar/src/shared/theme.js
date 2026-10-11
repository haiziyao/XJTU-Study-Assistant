/**
 * 设计令牌（Design Tokens）。
 *
 * 沿用 PotatoCalendar / PotatoTimer 一脉的深色配色，去掉与 Qt 绑定的 QSS 与私有字体名，
 * 只保留颜色与语义命名，供 Electron 渲染层以及未来的 AI 智学主程序共用。
 */

export const THEME = {
  /** 背景层级：越靠上层越亮。（打磨点：整体加深，拉开层级差） */
  background: {
    base: '#151519',
    surface: '#1e1e24',
    elevated: '#26262d',
    hover: '#2c2c35',
  },
  /** 文字层级。（打磨点：小幅提亮，保证加深底色后仍可读） */
  text: {
    primary: '#f4f4f7',
    secondary: '#b9b9c4',
    muted: '#83838f',
  },
  /** 语义色：与 PotatoCalendar 的配色保持一致。 */
  accent: {
    blue: '#6c8cff',
    red: '#ff6b7a',
    green: '#5cdb8b',
    orange: '#ffb86c',
    purple: '#c792ea',
  },
  /** 状态色。 */
  status: {
    pending: '#6c8cff',
    done: '#5cdb8b',
    cancelled: '#7a7a85',
    rolled: '#ffb86c',
    overdue: '#ff6b7a',
  },
  /** 优先级：0 普通 / 1 重要 / 2 紧急。 */
  priority: {
    0: '#7a7a85',
    1: '#ffb86c',
    2: '#ff6b7a',
  },
  /** 预估时长 -> 复杂度（阈值沿用 PotatoCalendar：≤1h 简单 / ≤3h 一般 / ≤10h 复杂 / 其余繁琐）。 */
  complexity: {
    simple: '#5cdb8b',
    normal: '#6c8cff',
    complex: '#ffb86c',
    heavy: '#ff6b7a',
  },
  /** 日程分类色，供日历/周视图色块轮转。 */
  category: {
    class: '#6c8cff',
    study: '#5cdb8b',
    exam: '#ff6b7a',
    meeting: '#c792ea',
    activity: '#ffb86c',
    other: '#7a7a85',
  },
  /** 复杂度阈值（分钟），与 validate.complexityOf 保持一致。 */
  complexityThresholds: [60, 180, 600],
};

export default THEME;
