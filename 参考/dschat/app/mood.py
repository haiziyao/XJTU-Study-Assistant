#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""智能体情绪系统: 基于文本启发式分析 + 时间衰减的二维情绪模型。

情绪用"环模型"(circumplex model) 表示, 两个轴:
  - valence (愉悦度): -10 ~ +10, 负值=负面情绪, 正值=正面情绪
  - arousal (唤醒度):   0 ~ +10, 低=平静/疲惫, 高=激动/亢奋

状态持久化为 JSON 字符串, 存于 agents.mood 字段。
"""

import json
import time

# 情绪回归的基准值 (长期平静状态)
BASE_VALENCE = 0.0
BASE_AROUSAL = 3.0

# 时间衰减速率 (每秒向基准回归的比例)
DECAY_RATE = 0.0002  # 约 1 小时后衰减约一半

# 单次分析的情绪增量上限, 防止一次对话把情绪拉满
MAX_DELTA = 6.0


# ---------------------------------------------------------------------------
# 关键词表 (中文情绪词, 简单子串匹配)
# ---------------------------------------------------------------------------
_POSITIVE = [
    "开心", "高兴", "快乐", "幸福", "开心", "喜欢", "爱你", "爱你", "谢谢",
    "感谢", "棒", "厉害", "优秀", "可爱", "温柔", "温暖", "抱抱", "亲亲",
    "晚安", "早安", "想你", "完美", "哈哈", "嘻嘻", "真好", "太好了", "赞",
    "❤", "😊", "🥰", "😘", "🌟",
]

_NEGATIVE = [
    "讨厌", "生气", "滚", "恨", "难过", "伤心", "哭", "死", "滚开", "闭嘴",
    "烦", "失望", "抛弃", "离开我", "讨厌你", "痛苦", "害怕", "恐惧",
    "呜呜", "呜呜呜", "不开心", "沮丧", "崩溃", "绝望", "😭", "😡", "💔",
]

_HIGH_AROUSAL = [
    "！", "!", "快", "立刻", "马上", "紧急", "救命", "哇", "天哪", "震惊",
    "刺激", "激动", "兴奋", "啊啊",
]


def _count_hits(text, keywords):
    if not text:
        return 0
    n = 0
    for kw in keywords:
        n += text.count(kw)
    return n


def analyze_text(text):
    """分析一段文本, 返回情绪增量 (d_valence, d_arousal)。"""
    if not text:
        return 0.0, 0.0
    pos = _count_hits(text, _POSITIVE)
    neg = _count_hits(text, _NEGATIVE)
    high = _count_hits(text, _HIGH_AROUSAL)

    # 感叹号额外提升唤醒度
    high += text.count("!") + text.count("！")

    d_valence = (pos - neg) * 2.0
    d_arousal = high * 1.5

    d_valence = max(-MAX_DELTA, min(MAX_DELTA, d_valence))
    d_arousal = max(-MAX_DELTA, min(MAX_DELTA, d_arousal))
    return d_valence, d_arousal


# ---------------------------------------------------------------------------
# 状态管理
# ---------------------------------------------------------------------------
def default_state(now=None):
    return {
        "valence": BASE_VALENCE,
        "arousal": BASE_AROUSAL,
        "updated_at": now if now is not None else time.time(),
    }


def load_state(mood_json):
    """解析持久化的情绪 JSON, 失败则返回默认状态。"""
    if not mood_json:
        return default_state()
    try:
        state = json.loads(mood_json)
        return {
            "valence": float(state.get("valence", BASE_VALENCE)),
            "arousal": float(state.get("arousal", BASE_AROUSAL)),
            "updated_at": float(state.get("updated_at", time.time())),
        }
    except (ValueError, TypeError, json.JSONDecodeError):
        return default_state()


def apply_delta(state, d_valence, d_arousal, now=None, reactivity=0.5):
    """先做时间衰减, 再叠加本次增量, 返回新状态 (dict)。

    reactivity (情绪变化系数): 0~1, 默认 0.5。
      值为 0.5 时按标准幅度变化; 越高变化越快, 越低越迟钝。
      实现: 增量乘以 (2 * reactivity), 故 0=不变, 0.5=标准, 1=翻倍。
    """
    now = now if now is not None else time.time()
    dt = max(0.0, now - state.get("updated_at", now))
    decay = 1.0 - (1.0 - DECAY_RATE) ** dt  # 简化的指数衰减近似

    valence = state.get("valence", BASE_VALENCE)
    arousal = state.get("arousal", BASE_AROUSAL)

    # 时间衰减: 向基准回归
    valence += (BASE_VALENCE - valence) * decay
    arousal += (BASE_AROUSAL - arousal) * decay

    # 情绪变化系数缩放增量 (0.5 为标准幅度)
    factor = 2.0 * max(0.0, min(1.0, reactivity))

    # 叠加本次增量
    valence += d_valence * factor
    arousal += d_arousal * factor

    # 截断到合法范围
    valence = max(-10.0, min(10.0, valence))
    arousal = max(0.0, min(10.0, arousal))

    return {
        "valence": round(valence, 3),
        "arousal": round(arousal, 3),
        "updated_at": now,
    }


def dump_state(state):
    return json.dumps(state, ensure_ascii=False)


# ---------------------------------------------------------------------------
# 情绪 -> 自然语言描述
# ---------------------------------------------------------------------------
def _scale_by_intensity(valence, arousal, intensity):
    """按情绪化系数缩放情绪偏离, 返回 (v, a)。

    intensity (情绪化系数): 0~1, 默认 0.5。
      值为 0.5 时情绪按原样呈现; 越高回答受情绪影响越强, 越低越克制。
      实现: 偏离乘以 (2 * intensity), 故 0=完全平静, 0.5=原样, 1=放大一倍。
    """
    factor = 2.0 * max(0.0, min(1.0, intensity))
    v = BASE_VALENCE + (valence - BASE_VALENCE) * factor
    a = BASE_AROUSAL + (arousal - BASE_AROUSAL) * factor
    return v, a


def mood_to_text(valence, arousal, intensity=0.5):
    """将二维情绪映射为中文描述, 用于注入 system prompt。"""
    v, a = _scale_by_intensity(valence, arousal, intensity)
    if v >= 6:
        if a >= 6:
            return "非常兴奋雀跃，充满热情，情绪高昂"
        if a >= 3:
            return "心情愉悦，情绪积极开朗"
        return "安心满足，平静而喜悦"
    if v >= 2:
        if a >= 6:
            return "有些兴奋，情绪比较高涨"
        if a >= 3:
            return "心情不错，温和而积极"
        return "平静中带着淡淡的满足"
    if v > -2:
        if a >= 6:
            return "情绪有些激动，但心态还算平稳"
        if a >= 3:
            return "情绪平静，心态平稳"
        return "平静，甚至有些慵懒"
    if v > -6:
        if a >= 6:
            return "有些烦躁不安，情绪焦躁"
        if a >= 3:
            return "心情有些低落，情绪淡淡的"
        return "情绪低落，有些疲惫消沉"
    # v <= -6
    if a >= 6:
        return "非常愤怒或激动，情绪激烈"
    if a >= 3:
        return "心情沉重，悲伤难过"
    return "极度消沉，情绪跌入低谷"


def mood_label(valence, arousal, intensity=0.5):
    """返回简短的 emoji 情绪标签, 用于前端展示。"""
    v, a = _scale_by_intensity(valence, arousal, intensity)
    if v >= 6:
        return "😊 开心" if a >= 3 else "😌 满足"
    if v >= 2:
        return "🙂 愉悦" if a >= 3 else "😌 平静"
    if v > -2:
        return "😐 平静" if a < 6 else "😲 激动"
    if v > -6:
        return "😕 低落" if a < 6 else "😣 焦躁"
    return "😢 难过" if a < 6 else "😡 愤怒"
