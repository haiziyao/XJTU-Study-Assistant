#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""认证: 密码哈希 + 会话令牌 (仅用标准库, 无额外依赖)。"""

import hashlib
import hmac
import secrets
import time

# PBKDF2 迭代次数 (在安全与登录延迟之间取平衡)
_PBKDF2_ITERATIONS = 120_000

# 会话有效期 (秒): 30 天
SESSION_TTL = 30 * 24 * 3600


def hash_password(password, salt=None):
    """返回 (salt_hex, hash_hex)。"""
    salt = salt or secrets.token_hex(16)
    raw = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        bytes.fromhex(salt),
        _PBKDF2_ITERATIONS,
    )
    return salt, raw.hex()


def verify_password(password, salt_hex, hash_hex):
    """校验密码是否匹配, 使用恒定时间比较。"""
    try:
        _, computed = hash_password(password, salt_hex)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(computed, hash_hex or "")


def new_token():
    """生成会话令牌。"""
    return secrets.token_hex(32)


def new_user_id():
    return secrets.token_hex(16)


# 邀请码字符集 (去掉易混淆的 0/O/1/I)
_INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def new_invite_code():
    """生成易读的邀请码, 形如 K7Q3-M9XW。"""
    return "-".join(
        "".join(secrets.choice(_INVITE_ALPHABET) for _ in range(4))
        for _ in range(2)
    )


def session_expires_at(now=None):
    return (now or time.time()) + SESSION_TTL
