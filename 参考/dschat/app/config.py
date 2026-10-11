#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""配置管理: 读写用户级 JSON 配置文件。"""

import json
import os

CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".dschat_web_config.json")

DEFAULT_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")

DEFAULT_CONFIG = {
    "api_key": DEFAULT_API_KEY,
    "base_url": "https://api.deepseek.com",
    "model": "deepseek-flash",
    "thinking": "enabled",
    "effort": "high",
    "temperature": 0.7,
    "max_tokens": 4096,
    "max_context": 32768,
    "font_size": 14,      # 聊天文本字号 (px)
    "math_scale": 100,    # 公式相对字号 (%)
    "show_mood": True,    # 是否显示智能体情绪指示
    "draw_mode": True,    # 是否启用作图模式 (AI 可输出 SVG 图形)
    "balance_mode": "floating",   # 余额显示模式: floating / fixed
    "balance_character": "",       # 固定模式下的角色名 (空=第一个角色)
    "balance_warn_threshold": 25.0,   # 余额低于此变黄
    "balance_danger_threshold": 10.0, # 余额低于此变红
}

MODELS = ["deepseek-flash", "deepseek-v4-pro"]
EFFORTS = ["low", "high", "max"]

SYSTEM_PROMPT = "You are a helpful assistant"


def normalize_config(cfg):
    """合并默认值并对字段做类型规范化 (供全局与每用户配置复用)。"""
    result = dict(DEFAULT_CONFIG)
    if isinstance(cfg, dict):
        result.update(cfg)
    # 数值型字段强制转换
    for key in ("max_tokens", "max_context", "font_size", "math_scale"):
        try:
            result[key] = int(result[key])
        except (ValueError, TypeError, KeyError):
            result[key] = DEFAULT_CONFIG[key]
    try:
        result["temperature"] = float(result["temperature"])
    except (ValueError, TypeError, KeyError):
        result["temperature"] = DEFAULT_CONFIG["temperature"]
    # 余额阈值 (浮点数)
    for key in ("balance_warn_threshold", "balance_danger_threshold"):
        try:
            result[key] = float(result[key])
        except (ValueError, TypeError, KeyError):
            result[key] = DEFAULT_CONFIG[key]
    # 布尔型字段: 兼容字符串形式
    result["show_mood"] = _to_bool(result.get("show_mood"), DEFAULT_CONFIG["show_mood"])
    result["draw_mode"] = _to_bool(result.get("draw_mode"), DEFAULT_CONFIG["draw_mode"])
    return result


def load_config():
    """读取全局配置文件 (兼容旧版, 主要作为系统默认来源)。"""
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, dict):
                cfg.update(data)
    except (OSError, json.JSONDecodeError):
        pass
    return normalize_config(cfg)


def _to_bool(value, default=True):
    """宽松解析布尔值。"""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes", "on")
    if isinstance(value, (int, float)):
        return bool(value)
    return default


def save_config(cfg):
    """保存配置到用户目录。"""
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
