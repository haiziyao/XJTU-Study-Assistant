#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""DeepSeek 流式请求封装 (支持文本 + 图片)。"""

from . import storage


def estimate_tokens(text):
    """粗略估算 token 数: 英文 4 字符 ≈ 1 token, 中文 1 字符 ≈ 1 token。"""
    if not text:
        return 0
    count = 0.0
    for ch in text:
        count += 0.25 if ord(ch) < 128 else 1.0
    return int(count) + 1


def trim_messages(messages, max_context):
    """按最大上下文长度裁剪, 始终保留 system 消息和最后一条。"""
    system = [m for m in messages if m.get("role") == "system"]
    rest = [m for m in messages if m.get("role") != "system"]
    total = sum(estimate_tokens(_content_text(m)) for m in messages)
    while total > max_context and len(rest) > 1:
        removed = rest.pop(0)
        total -= estimate_tokens(_content_text(removed))
    return system + rest


def _content_text(message):
    content = message.get("content", "") or ""
    if isinstance(content, str):
        return content
    # 内容块数组, 只统计文本部分
    parts = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
    return "".join(parts)


def build_user_message(text, image_filenames):
    """构造 user 消息, 含图片时 content 为块数组。"""
    if not image_filenames:
        return {"role": "user", "content": text}
    parts = []
    if text:
        parts.append({"type": "text", "text": text})
    for fn in image_filenames:
        try:
            url = storage.image_data_url(fn)
        except OSError:
            continue
        parts.append({"type": "image_url", "image_url": {"url": url}})
    return {"role": "user", "content": parts}


def stream_chat(client, messages, model, thinking, effort, max_tokens, stop_event=None):
    """流式请求, 逐块 yield (kind, text)。

    stop_event: 可选 threading.Event, 置位后立即中断生成并关闭底层连接。
    """
    kwargs = {
        "model": model,
        "messages": messages,
        "stream": True,
        "max_tokens": max_tokens,
        "reasoning_effort": effort,
        "extra_body": {"thinking": {"type": thinking}},
    }
    if thinking == "disabled":
        kwargs["temperature"] = 0.7

    stream = client.chat.completions.create(**kwargs)
    try:
        for chunk in stream:
            if stop_event is not None and stop_event.is_set():
                break
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            reasoning = getattr(delta, "reasoning_content", None)
            content = getattr(delta, "content", None)
            if reasoning:
                yield ("reasoning", reasoning)
            if content:
                yield ("content", content)
    finally:
        try:
            stream.close()  # 真正断开与上游的流式连接
        except Exception:
            pass
