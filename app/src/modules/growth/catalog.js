/**
 * 任务模板库。
 *
 * 这是"动态任务表单"的原料。每条模板都是现实生活里真会发生的一件事，
 * 不是抽象的"完成一个目标"。难度 1–5 表示**对状态的消耗**，不是重要性：
 * 状态差的时候不是事情不重要，而是今天扛不动它。
 *
 * kind：
 *   focus   深度工作（消耗最大，收益最高）
 *   mind    学习与整理（中等）
 *   body    身体（恢复精力，短期消耗、长期回本）
 *   life    生活事务（低消耗，但会积压，拖着会变成压力源）
 *   recover 主动恢复（不消耗，专门用来把状态拉回来）
 */

export const KINDS = {
  focus: { label: '深度', color: '#6ee7ff' },
  mind: { label: '认知', color: '#a78bfa' },
  body: { label: '身体', color: '#4ade80' },
  life: { label: '生活', color: '#fbbf24' },
  recover: { label: '恢复', color: '#fb7185' },
};

export const CATALOG = [
  // 深度
  { id: 'focus-deep-90', title: '深度工作块', detail: '关掉通知，90 分钟只推进一件最重要的事', kind: 'focus', estimateMin: 90, difficulty: 4 },
  { id: 'focus-sprint-45', title: '专注冲刺', detail: '45 分钟一个番茄，中间不碰手机', kind: 'focus', estimateMin: 45, difficulty: 3 },
  { id: 'focus-hard-thing', title: '啃下最硬的那件事', detail: '把今天最不想开始的事先做 25 分钟', kind: 'focus', estimateMin: 25, difficulty: 3 },
  { id: 'focus-deep-120', title: '长块推进', detail: '两小时不被打断，适合写方案/写代码/写论文', kind: 'focus', estimateMin: 120, difficulty: 5 },
  { id: 'focus-review-output', title: '收尾与交付', detail: '把在做的半成品收干净，别留到明天', kind: 'focus', estimateMin: 40, difficulty: 3 },

  // 认知
  { id: 'mind-read-20', title: '读 20 页书', detail: '纸质或电子都行，读完记一句结论', kind: 'mind', estimateMin: 30, difficulty: 2 },
  { id: 'mind-write-500', title: '写 500 字', detail: '随便写，重点是让想法落到纸面', kind: 'mind', estimateMin: 40, difficulty: 3 },
  { id: 'mind-words-20', title: '背 20 个词', detail: '间隔重复，先过一遍旧的再加新的', kind: 'mind', estimateMin: 20, difficulty: 2 },
  { id: 'mind-one-concept', title: '搞懂一个概念', detail: '挑一个一直半懂不懂的点，写成三句话', kind: 'mind', estimateMin: 25, difficulty: 2 },
  { id: 'mind-three-things', title: '写下今天最重要的三件事', detail: '排序，然后只认第一件', kind: 'mind', estimateMin: 10, difficulty: 1 },
  { id: 'mind-review-yesterday', title: '复盘昨天', detail: '哪件事白做了，哪件事值得再来一次', kind: 'mind', estimateMin: 15, difficulty: 2 },
  { id: 'mind-inbox-15', title: '清空收件箱 15 分钟', detail: '只处理两分钟内能回完的', kind: 'mind', estimateMin: 15, difficulty: 1 },
  { id: 'mind-notes-sort', title: '整理散落的笔记', detail: '把未读的收藏与截图处理掉一批', kind: 'mind', estimateMin: 25, difficulty: 2 },

  // 身体
  { id: 'body-walk-20', title: '户外走 20 分钟', detail: '不带耳机，让注意力散一会儿', kind: 'body', estimateMin: 20, difficulty: 1 },
  { id: 'body-stretch-10', title: '拉伸 10 分钟', detail: '颈、肩、髋，久坐的人先松这三个地方', kind: 'body', estimateMin: 10, difficulty: 1 },
  { id: 'body-strength-45', title: '力量训练 45 分钟', detail: '推/拉/蹲各两组就够', kind: 'body', estimateMin: 45, difficulty: 3 },
  { id: 'body-run-30', title: '慢跑 30 分钟', detail: '能说话的强度，别追配速', kind: 'body', estimateMin: 30, difficulty: 3 },
  { id: 'body-squat-15', title: '三组自重组', detail: '深蹲/俯卧撑/平板，各三组', kind: 'body', estimateMin: 15, difficulty: 2 },
  { id: 'body-water', title: '喝水 + 维生素', detail: '顺手的事，但今天确实容易忘', kind: 'body', estimateMin: 5, difficulty: 1 },
  { id: 'body-sun-15', title: '晒 15 分钟太阳', detail: '上午的光对睡眠节律最有用', kind: 'body', estimateMin: 15, difficulty: 1 },
  { id: 'body-sleep-early', title: '提前 30 分钟上床', detail: '今天欠的觉，今天先还一点', kind: 'body', estimateMin: 30, difficulty: 1 },

  // 生活
  { id: 'life-cleanse-20', title: '20 分钟清扫', detail: '只清一个区域，看得见的地方', kind: 'life', estimateMin: 20, difficulty: 1 },
  { id: 'life-desk', title: '桌面归位', detail: '清空桌面，只留今天要用的', kind: 'life', estimateMin: 10, difficulty: 1 },
  { id: 'life-kitchen', title: '厨房归位', detail: '洗完碗再坐下，明天的你会感谢今天', kind: 'life', estimateMin: 15, difficulty: 1 },
  { id: 'life-shopping', title: '补一次生活物资', detail: '列清单再去，别在超市现想', kind: 'life', estimateMin: 30, difficulty: 2 },
  { id: 'life-contact', title: '联系一个人', detail: '一个你确实想联系但一直没发消息的人', kind: 'life', estimateMin: 15, difficulty: 1 },
  { id: 'life-finance-5', title: '记账 5 分钟', detail: '把这两天的支出补上', kind: 'life', estimateMin: 5, difficulty: 1 },
  { id: 'life-appointment', title: '处理一件拖着的杂事', detail: '预约、报销、寄快递这类两分钟能发起的', kind: 'life', estimateMin: 15, difficulty: 2 },
  { id: 'life-meal', title: '认真吃一顿饭', detail: '不在屏幕前吃，好好吃完', kind: 'life', estimateMin: 30, difficulty: 1 },

  // 恢复
  { id: 'recover-breath-10', title: '闭眼呼吸 10 分钟', detail: '4 秒吸、6 秒呼，走神了拉回来', kind: 'recover', estimateMin: 10, difficulty: 1 },
  { id: 'recover-nap-20', title: '闭眼躺 20 分钟', detail: '不一定要睡着，躺平不看屏幕即可', kind: 'recover', estimateMin: 20, difficulty: 1 },
  { id: 'recover-shower', title: '洗个热水澡', detail: '把它当成切换状态的仪式', kind: 'recover', estimateMin: 20, difficulty: 1 },
  { id: 'recover-journal-3', title: '情绪日志三行', detail: '现在什么感觉、因为什么、下一步做什么', kind: 'recover', estimateMin: 10, difficulty: 1 },
  { id: 'recover-screen-off', title: '睡前断网 30 分钟', detail: '屏幕放下，明天再刷', kind: 'recover', estimateMin: 30, difficulty: 1 },
  { id: 'recover-music', title: '什么都不做 15 分钟', detail: '允许自己发呆，不用填满每一分钟', kind: 'recover', estimateMin: 15, difficulty: 1 },
  { id: 'recover-sun-walk', title: '慢走不看手机', detail: '把注意力放在脚下的路上', kind: 'recover', estimateMin: 15, difficulty: 1 },
];

export function byId(id) {
  return CATALOG.find((item) => item.id === id) ?? null;
}

export const KINDS_LIST = Object.keys(KINDS);
