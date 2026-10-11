#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""会话与消息持久化 (SQLite) + 图片文件存储。"""

import base64
import json
import os
import sqlite3
import threading
import time
import uuid

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(APP_DIR, "..", "data")
DB_PATH = os.path.join(DATA_DIR, "chat.db")
IMAGES_DIR = os.path.join(DATA_DIR, "images")

_lock = threading.Lock()

_MIME_EXT = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
}
_EXT_MIME = {v: k for k, v in _MIME_EXT.items()}


def _ensure_dirs():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(IMAGES_DIR, exist_ok=True)


def _conn():
    _ensure_dirs()
    return sqlite3.connect(DB_PATH)


def init_db():
    """初始化数据库表结构。"""
    _ensure_dirs()
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS agents (
                    id TEXT PRIMARY KEY,
                    name TEXT DEFAULT '',
                    avatar TEXT DEFAULT '🤖',
                    persona TEXT DEFAULT '',
                    max_context INTEGER DEFAULT 32768,
                    mood TEXT DEFAULT '',
                    mood_intensity REAL DEFAULT 0.5,
                    mood_reactivity REAL DEFAULT 0.5,
                    created_at REAL,
                    updated_at REAL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT DEFAULT '',
                    title TEXT DEFAULT '',
                    created_at REAL,
                    updated_at REAL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT DEFAULT '',
                    reasoning TEXT DEFAULT '',
                    images TEXT DEFAULT '[]',
                    created_at REAL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id)"
            )
            # 用户 / 会话 / 用户配置表
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    username TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    salt TEXT NOT NULL,
                    role TEXT DEFAULT 'user',
                    ics_token TEXT DEFAULT '',
                    created_at REAL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    token TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    expires_at REAL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS user_configs (
                    user_id TEXT PRIMARY KEY,
                    config_json TEXT DEFAULT '{}'
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS invite_codes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    code TEXT UNIQUE NOT NULL,
                    note TEXT DEFAULT '',
                    used_by TEXT DEFAULT NULL,
                    used_at REAL DEFAULT NULL,
                    created_at REAL
                )
                """
            )
            # 待办事项表
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS todos (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    notes TEXT DEFAULT '',
                    priority TEXT DEFAULT 'medium',
                    due_date TEXT,
                    category TEXT DEFAULT '',
                    completed INTEGER DEFAULT 0,
                    completed_at REAL,
                    created_at REAL,
                    updated_at REAL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id, completed)"
            )
            # 日程事件表
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS events (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    notes TEXT DEFAULT '',
                    location TEXT DEFAULT '',
                    date TEXT NOT NULL,
                    start_time TEXT,
                    end_time TEXT,
                    all_day INTEGER DEFAULT 0,
                    repeat TEXT DEFAULT 'none',
                    repeat_interval INTEGER DEFAULT 1,
                    repeat_end TEXT,
                    created_at REAL,
                    updated_at REAL
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, date)"
            )
            # 学期规则表
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS semesters (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    name TEXT DEFAULT '',
                    start_date TEXT NOT NULL,
                    total_weeks INTEGER DEFAULT 18,
                    created_at REAL,
                    updated_at REAL
                )
                """
            )
            # 兼容旧库: conversations 表补 agent_id / user_id 列
            cols = [r[1] for r in conn.execute("PRAGMA table_info(conversations)").fetchall()]
            if "agent_id" not in cols:
                conn.execute("ALTER TABLE conversations ADD COLUMN agent_id TEXT DEFAULT ''")
            if "user_id" not in cols:
                conn.execute("ALTER TABLE conversations ADD COLUMN user_id TEXT DEFAULT ''")
            # 兼容旧库: agents 表补 mood 列
            acols = [r[1] for r in conn.execute("PRAGMA table_info(agents)").fetchall()]
            if "mood" not in acols:
                conn.execute("ALTER TABLE agents ADD COLUMN mood TEXT DEFAULT ''")
            if "mood_intensity" not in acols:
                conn.execute("ALTER TABLE agents ADD COLUMN mood_intensity REAL DEFAULT 0.5")
            if "mood_reactivity" not in acols:
                conn.execute("ALTER TABLE agents ADD COLUMN mood_reactivity REAL DEFAULT 0.5")
            if "user_id" not in acols:
                conn.execute("ALTER TABLE agents ADD COLUMN user_id TEXT DEFAULT ''")
            # 兼容旧库: users 表补 ics_token 列
            ucols = [r[1] for r in conn.execute("PRAGMA table_info(users)").fetchall()]
            if "ics_token" not in ucols:
                conn.execute("ALTER TABLE users ADD COLUMN ics_token TEXT DEFAULT ''")
            # 兼容旧库: todos 表补 category 列
            tcols = [r[1] for r in conn.execute("PRAGMA table_info(todos)").fetchall()]
            if "category" not in tcols:
                conn.execute("ALTER TABLE todos ADD COLUMN category TEXT DEFAULT ''")
            # 兼容旧库: events 表补 location 列
            ecols = [r[1] for r in conn.execute("PRAGMA table_info(events)").fetchall()]
            if "location" not in ecols:
                conn.execute("ALTER TABLE events ADD COLUMN location TEXT DEFAULT ''")
            if "repeat" not in ecols:
                conn.execute("ALTER TABLE events ADD COLUMN repeat TEXT DEFAULT 'none'")
            if "repeat_interval" not in ecols:
                conn.execute("ALTER TABLE events ADD COLUMN repeat_interval INTEGER DEFAULT 1")
            if "repeat_end" not in ecols:
                conn.execute("ALTER TABLE events ADD COLUMN repeat_end TEXT")
            conn.commit()
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# 智能体 (Agent)
# ---------------------------------------------------------------------------
def create_agent(user_id="", name="", avatar="🤖", persona="", max_context=32768, mood="",
                 mood_intensity=0.5, mood_reactivity=0.5):
    agent_id = uuid.uuid4().hex
    now = time.time()
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                "INSERT INTO agents (id, user_id, name, avatar, persona, max_context, mood, "
                "mood_intensity, mood_reactivity, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (agent_id, user_id, name, avatar, persona, max_context, mood,
                 mood_intensity, mood_reactivity, now, now),
            )
            conn.commit()
        finally:
            conn.close()
    return agent_id


def list_agents(user_id=None):
    conn = _conn()
    try:
        if user_id is not None:
            rows = conn.execute(
                """
                SELECT a.id, a.name, a.avatar, a.persona, a.max_context, a.mood,
                       a.mood_intensity, a.mood_reactivity,
                       a.created_at, a.updated_at,
                       (SELECT COUNT(*) FROM conversations c WHERE c.agent_id = a.id)
                FROM agents a
                WHERE a.user_id = ?
                ORDER BY a.updated_at DESC
                """,
                (user_id,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT a.id, a.name, a.avatar, a.persona, a.max_context, a.mood,
                       a.mood_intensity, a.mood_reactivity,
                       a.created_at, a.updated_at,
                       (SELECT COUNT(*) FROM conversations c WHERE c.agent_id = a.id)
                FROM agents a
                ORDER BY a.updated_at DESC
                """
            ).fetchall()
    finally:
        conn.close()
    return [
        {
            "id": r[0],
            "name": r[1],
            "avatar": r[2],
            "persona": r[3],
            "max_context": r[4],
            "mood": r[5],
            "mood_intensity": r[6],
            "mood_reactivity": r[7],
            "created_at": r[8],
            "updated_at": r[9],
            "conversation_count": r[10],
        }
        for r in rows
    ]


def get_agent(agent_id):
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT id, user_id, name, avatar, persona, max_context, mood, "
            "mood_intensity, mood_reactivity, created_at, updated_at "
            "FROM agents WHERE id = ?",
            (agent_id,),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    return {
        "id": row[0],
        "user_id": row[1],
        "name": row[2],
        "avatar": row[3],
        "persona": row[4],
        "max_context": row[5],
        "mood": row[6],
        "mood_intensity": row[7],
        "mood_reactivity": row[8],
        "created_at": row[9],
        "updated_at": row[10],
    }


def update_agent(agent_id, name=None, avatar=None, persona=None, max_context=None,
                 mood=None, mood_intensity=None, mood_reactivity=None):
    fields = {}
    if name is not None:
        fields["name"] = name
    if avatar is not None:
        fields["avatar"] = avatar
    if persona is not None:
        fields["persona"] = persona
    if max_context is not None:
        fields["max_context"] = max_context
    if mood is not None:
        fields["mood"] = mood
    if mood_intensity is not None:
        fields["mood_intensity"] = mood_intensity
    if mood_reactivity is not None:
        fields["mood_reactivity"] = mood_reactivity
    if not fields:
        return
    fields["updated_at"] = time.time()
    assignments = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values()) + [agent_id]
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                f"UPDATE agents SET {assignments} WHERE id = ?", values
            )
            conn.commit()
        finally:
            conn.close()


def get_agent_mood(agent_id):
    """读取智能体情绪 JSON 字符串, 无则返回空。"""
    agent = get_agent(agent_id)
    return agent.get("mood", "") if agent else ""


def set_agent_mood(agent_id, mood_json):
    """写入智能体情绪 JSON 字符串。"""
    update_agent(agent_id, mood=mood_json)


def delete_agent(agent_id):
    with _lock:
        conn = _conn()
        try:
            conn.execute("DELETE FROM agents WHERE id = ?", (agent_id,))
            # 该智能体下的会话解除绑定 (置空 agent_id, 不删除对话)
            conn.execute(
                "UPDATE conversations SET agent_id = '' WHERE agent_id = ?",
                (agent_id,),
            )
            conn.commit()
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# 会话
# ---------------------------------------------------------------------------
def create_conversation(user_id="", title="", agent_id=""):
    conv_id = uuid.uuid4().hex
    now = time.time()
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                "INSERT INTO conversations (id, user_id, agent_id, title, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?)",
                (conv_id, user_id, agent_id, title, now, now),
            )
            conn.commit()
        finally:
            conn.close()
    return conv_id


def list_conversations(user_id=None, agent_id=None):
    conn = _conn()
    try:
        conds = []
        params = []
        if user_id is not None:
            conds.append("c.user_id = ?")
            params.append(user_id)
        if agent_id is not None:
            conds.append("c.agent_id = ?")
            params.append(agent_id)
        where = (" WHERE " + " AND ".join(conds)) if conds else ""
        rows = conn.execute(
            """
            SELECT c.id, c.agent_id, c.title, c.created_at, c.updated_at,
                   (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id),
                   (SELECT m.content FROM messages m WHERE m.conversation_id = c.id
                        AND m.role = 'user' ORDER BY m.id DESC LIMIT 1)
            FROM conversations c
            """ + where + " ORDER BY c.updated_at DESC",
            params,
        ).fetchall()
    finally:
        conn.close()
    return [
        {
            "id": r[0],
            "agent_id": r[1],
            "title": r[2],
            "created_at": r[3],
            "updated_at": r[4],
            "message_count": r[5],
            "preview": r[6],
        }
        for r in rows
    ]


def get_conversation(conv_id):
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT id, user_id, agent_id, title FROM conversations WHERE id = ?", (conv_id,)
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    return {
        "id": row[0],
        "user_id": row[1],
        "agent_id": row[2],
        "title": row[3],
        "messages": get_messages(conv_id),
    }


def delete_conversation(conv_id):
    with _lock:
        conn = _conn()
        try:
            conn.execute("DELETE FROM conversations WHERE id = ?", (conv_id,))
            conn.execute("DELETE FROM messages WHERE conversation_id = ?", (conv_id,))
            conn.commit()
        finally:
            conn.close()


def rename_conversation(conv_id, title):
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
                (title, time.time(), conv_id),
            )
            conn.commit()
        finally:
            conn.close()


def auto_title(conv_id, text):
    """首条用户消息自动作为标题 (仅当标题为空时)。"""
    if not text:
        return
    with _lock:
        conn = _conn()
        try:
            row = conn.execute(
                "SELECT title FROM conversations WHERE id = ?", (conv_id,)
            ).fetchone()
            if row and not (row[0] or "").strip():
                title = text.replace("\n", " ").strip()[:30]
                conn.execute(
                    "UPDATE conversations SET title = ? WHERE id = ?",
                    (title, conv_id),
                )
                conn.commit()
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# 消息
# ---------------------------------------------------------------------------
def add_message(conv_id, role, content, reasoning="", images=None):
    now = time.time()
    images_json = json.dumps(images or [], ensure_ascii=False)
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                "INSERT INTO messages (conversation_id, role, content, reasoning, images, created_at) "
                "VALUES (?,?,?,?,?,?)",
                (conv_id, role, content, reasoning, images_json, now),
            )
            conn.execute(
                "UPDATE conversations SET updated_at = ? WHERE id = ?",
                (now, conv_id),
            )
            conn.commit()
        finally:
            conn.close()


def get_messages(conv_id):
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT id, role, content, reasoning, images, created_at FROM messages "
            "WHERE conversation_id = ? ORDER BY id ASC",
            (conv_id,),
        ).fetchall()
    finally:
        conn.close()
    return [
        {
            "id": r[0],
            "role": r[1],
            "content": r[2],
            "reasoning": r[3],
            "images": json.loads(r[4] or "[]"),
            "created_at": r[5],
        }
        for r in rows
    ]


def get_message(message_id):
    """读取单条消息 (含 id / conversation_id / role)。"""
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT id, conversation_id, role, content, reasoning, images, created_at "
            "FROM messages WHERE id = ?",
            (message_id,),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    return {
        "id": row[0],
        "conversation_id": row[1],
        "role": row[2],
        "content": row[3],
        "reasoning": row[4],
        "images": json.loads(row[5] or "[]"),
        "created_at": row[6],
    }


def delete_last_assistant_message(conv_id):
    """删除会话中最后一条 assistant 消息, 返回是否删除。"""
    with _lock:
        conn = _conn()
        try:
            row = conn.execute(
                "SELECT id FROM messages WHERE conversation_id = ? AND role = 'assistant' "
                "ORDER BY id DESC LIMIT 1",
                (conv_id,),
            ).fetchone()
            if not row:
                return False
            conn.execute("DELETE FROM messages WHERE id = ?", (row[0],))
            conn.commit()
            return True
        finally:
            conn.close()


def update_message_content(message_id, text):
    """更新一条消息的内容 (编辑用户消息)。"""
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                "UPDATE messages SET content = ? WHERE id = ?",
                (text, message_id),
            )
            conn.commit()
        finally:
            conn.close()


def delete_messages_after(conv_id, message_id):
    """删除 id 大于 message_id 的所有消息。"""
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                "DELETE FROM messages WHERE conversation_id = ? AND id > ?",
                (conv_id, message_id),
            )
            conn.commit()
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# 图片
# ---------------------------------------------------------------------------
def save_image(data_url):
    """将 data URL 存为图片文件, 返回文件名。"""
    header, _, b64 = data_url.partition(",")
    mime = "image/png"
    if ":" in header:
        mime = header.split(":")[1].split(";")[0]
    ext = _MIME_EXT.get(mime, "png")
    raw = base64.b64decode(b64)
    filename = f"{uuid.uuid4().hex}.{ext}"
    with open(os.path.join(IMAGES_DIR, filename), "wb") as f:
        f.write(raw)
    return filename


def image_data_url(filename):
    """读取图片文件, 返回 base64 data URL。"""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "png"
    mime = _EXT_MIME.get(ext, "image/png")
    with open(os.path.join(IMAGES_DIR, filename), "rb") as f:
        b64 = base64.b64encode(f.read()).decode("utf-8")
    return f"data:{mime};base64,{b64}"


def image_path(filename):
    return os.path.join(IMAGES_DIR, filename)


# ---------------------------------------------------------------------------
# 用户 (User)
# ---------------------------------------------------------------------------
def create_user(user_id, username, password_hash, salt, role="user"):
    now = time.time()
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                "INSERT INTO users (id, username, password_hash, salt, role, created_at) "
                "VALUES (?,?,?,?,?,?)",
                (user_id, username, password_hash, salt, role, now),
            )
            conn.commit()
        finally:
            conn.close()


def get_user_by_username(username):
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT id, username, password_hash, salt, role, created_at "
            "FROM users WHERE username = ?",
            (username,),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    return {
        "id": row[0],
        "username": row[1],
        "password_hash": row[2],
        "salt": row[3],
        "role": row[4],
        "created_at": row[5],
    }


def get_user(user_id):
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT id, username, role, created_at FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    return {"id": row[0], "username": row[1], "role": row[2], "created_at": row[3]}


def get_ics_token(user_id):
    """读取用户 ICS 订阅 token; 无则生成一个并写入。"""
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT ics_token FROM users WHERE id = ?", (user_id,)
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    token = row[0]
    if not token:
        token = uuid.uuid4().hex + uuid.uuid4().hex
        with _lock:
            conn = _conn()
            try:
                conn.execute(
                    "UPDATE users SET ics_token = ? WHERE id = ?", (token, user_id)
                )
                conn.commit()
            finally:
                conn.close()
    return token


def get_user_by_ics_token(token):
    """通过 ICS token 反查用户 (供订阅链接鉴权)。"""
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT id, username FROM users WHERE ics_token = ?", (token,)
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    return {"id": row[0], "username": row[1]}


def list_users():
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT id, username, role, created_at FROM users ORDER BY created_at ASC"
        ).fetchall()
    finally:
        conn.close()
    return [
        {"id": r[0], "username": r[1], "role": r[2], "created_at": r[3]}
        for r in rows
    ]


def count_users():
    conn = _conn()
    try:
        return conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    finally:
        conn.close()


def set_user_password(user_id, password_hash, salt):
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                "UPDATE users SET password_hash = ?, salt = ? WHERE id = ?",
                (password_hash, salt, user_id),
            )
            conn.commit()
        finally:
            conn.close()


def delete_user(user_id):
    with _lock:
        conn = _conn()
        try:
            conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            conn.execute("DELETE FROM user_configs WHERE user_id = ?", (user_id,))
            conn.execute("DELETE FROM agents WHERE user_id = ?", (user_id,))
            conn.execute("DELETE FROM todos WHERE user_id = ?", (user_id,))
            conn.execute("DELETE FROM events WHERE user_id = ?", (user_id,))
            conn.execute("DELETE FROM semesters WHERE user_id = ?", (user_id,))
            convs = conn.execute(
                "SELECT id FROM conversations WHERE user_id = ?", (user_id,)
            ).fetchall()
            for (cid,) in convs:
                conn.execute("DELETE FROM messages WHERE conversation_id = ?", (cid,))
            conn.execute("DELETE FROM conversations WHERE user_id = ?", (user_id,))
            conn.commit()
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# 邀请码 (Invite Code)
# ---------------------------------------------------------------------------
def create_invite(code, note=""):
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                "INSERT INTO invite_codes (code, note, created_at) VALUES (?,?,?)",
                (code, note, time.time()),
            )
            conn.commit()
        finally:
            conn.close()


def get_invite(code):
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT id, code, note, used_by, used_at, created_at "
            "FROM invite_codes WHERE code = ?",
            (code,),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    return {
        "id": row[0],
        "code": row[1],
        "note": row[2],
        "used_by": row[3],
        "used_at": row[4],
        "created_at": row[5],
    }


def list_invites():
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT id, code, note, used_by, used_at, created_at "
            "FROM invite_codes ORDER BY created_at DESC"
        ).fetchall()
    finally:
        conn.close()
    return [
        {
            "id": r[0],
            "code": r[1],
            "note": r[2],
            "used_by": r[3],
            "used_at": r[4],
            "created_at": r[5],
        }
        for r in rows
    ]


def use_invite(code, user_id):
    """标记邀请码已被某用户使用; 仅当未使用时生效, 返回是否成功。"""
    with _lock:
        conn = _conn()
        try:
            cur = conn.execute(
                "UPDATE invite_codes SET used_by = ?, used_at = ? "
                "WHERE code = ? AND used_by IS NULL",
                (user_id, time.time(), code),
            )
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()


def delete_invite(invite_id):
    with _lock:
        conn = _conn()
        try:
            conn.execute("DELETE FROM invite_codes WHERE id = ?", (invite_id,))
            conn.commit()
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# 会话 (Session)
# ---------------------------------------------------------------------------
def create_session(token, user_id, expires_at):
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                "INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)",
                (token, user_id, expires_at),
            )
            conn.commit()
        finally:
            conn.close()


def get_session_user(token):
    """返回 token 对应的 user_id; 无效或过期返回 None。"""
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT user_id, expires_at FROM sessions WHERE token = ?", (token,)
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    if row[1] < time.time():
        delete_session(token)
        return None
    return row[0]


def delete_session(token):
    with _lock:
        conn = _conn()
        try:
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
            conn.commit()
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# 用户配置 (User Config)
# ---------------------------------------------------------------------------
def get_user_config(user_id):
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT config_json FROM user_configs WHERE user_id = ?", (user_id,)
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return {}
    try:
        return json.loads(row[0] or "{}")
    except (ValueError, json.JSONDecodeError):
        return {}


def save_user_config(user_id, cfg):
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                "INSERT OR REPLACE INTO user_configs (user_id, config_json) VALUES (?,?)",
                (user_id, json.dumps(cfg, ensure_ascii=False)),
            )
            conn.commit()
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# 待办事项 (Todo)
# ---------------------------------------------------------------------------
_UNSET = object()


def create_todo(user_id, title, notes="", priority="medium", due_date=None, category=""):
    todo_id = uuid.uuid4().hex
    now = time.time()
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                "INSERT INTO todos (id, user_id, title, notes, priority, due_date, "
                "category, completed, completed_at, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (todo_id, user_id, title, notes, priority, due_date, category,
                 0, None, now, now),
            )
            conn.commit()
        finally:
            conn.close()
    return todo_id


def list_todos(user_id):
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT id, title, notes, priority, due_date, category, completed, completed_at, "
            "created_at, updated_at FROM todos WHERE user_id = ? "
            "ORDER BY completed ASC, created_at ASC",
            (user_id,),
        ).fetchall()
    finally:
        conn.close()
    return [
        {
            "id": r[0],
            "title": r[1],
            "notes": r[2],
            "priority": r[3],
            "due_date": r[4],
            "category": r[5],
            "completed": bool(r[6]),
            "completed_at": r[7],
            "created_at": r[8],
            "updated_at": r[9],
        }
        for r in rows
    ]


def get_todo(todo_id):
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT id, user_id, title, notes, priority, due_date, category, completed, "
            "completed_at, created_at, updated_at FROM todos WHERE id = ?",
            (todo_id,),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    return {
        "id": row[0],
        "user_id": row[1],
        "title": row[2],
        "notes": row[3],
        "priority": row[4],
        "due_date": row[5],
        "category": row[6],
        "completed": bool(row[7]),
        "completed_at": row[8],
        "created_at": row[9],
        "updated_at": row[10],
    }


def update_todo(todo_id, title=None, notes=None, priority=None, due_date=_UNSET,
                completed=None, category=None):
    """更新待办字段; 传入 None 表示不改动该字段 (due_date 例外: None 表示清除)。"""
    fields = {}
    if title is not None:
        fields["title"] = title
    if notes is not None:
        fields["notes"] = notes
    if priority is not None:
        fields["priority"] = priority
    if category is not None:
        fields["category"] = category
    if due_date is not _UNSET:
        fields["due_date"] = due_date
    if completed is not None:
        fields["completed"] = 1 if completed else 0
        fields["completed_at"] = time.time() if completed else None
    if not fields:
        return
    fields["updated_at"] = time.time()
    assignments = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values()) + [todo_id]
    with _lock:
        conn = _conn()
        try:
            conn.execute(f"UPDATE todos SET {assignments} WHERE id = ?", values)
            conn.commit()
        finally:
            conn.close()


def delete_todo(todo_id):
    with _lock:
        conn = _conn()
        try:
            conn.execute("DELETE FROM todos WHERE id = ?", (todo_id,))
            conn.commit()
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# 日程事件 (Event)
# ---------------------------------------------------------------------------
def create_event(user_id, title, notes="", date="", start_time=None,
                 end_time=None, all_day=False, location="", repeat="none",
                 repeat_interval=1, repeat_end=None):
    event_id = uuid.uuid4().hex
    now = time.time()
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                "INSERT INTO events (id, user_id, title, notes, location, date, start_time, "
                "end_time, all_day, repeat, repeat_interval, repeat_end, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (event_id, user_id, title, notes, location, date, start_time, end_time,
                 1 if all_day else 0, repeat, repeat_interval, repeat_end, now, now),
            )
            conn.commit()
        finally:
            conn.close()
    return event_id


def list_events(user_id, start_date=None, end_date=None):
    """列出日程, 可按日期范围过滤 (含边界)。"""
    conn = _conn()
    try:
        if start_date and end_date:
            rows = conn.execute(
                "SELECT id, title, notes, location, date, start_time, end_time, all_day, "
                "repeat, repeat_interval, repeat_end, created_at, updated_at FROM events "
                "WHERE user_id = ? AND date >= ? AND date <= ? "
                "ORDER BY date ASC, all_day DESC, start_time ASC",
                (user_id, start_date, end_date),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, title, notes, location, date, start_time, end_time, all_day, "
                "repeat, repeat_interval, repeat_end, created_at, updated_at FROM events WHERE user_id = ? "
                "ORDER BY date ASC, all_day DESC, start_time ASC",
                (user_id,),
            ).fetchall()
    finally:
        conn.close()
    return [
        {
            "id": r[0],
            "title": r[1],
            "notes": r[2],
            "location": r[3],
            "date": r[4],
            "start_time": r[5],
            "end_time": r[6],
            "all_day": bool(r[7]),
            "repeat": r[8] or "none",
            "repeat_interval": r[9] or 1,
            "repeat_end": r[10],
            "created_at": r[11],
            "updated_at": r[12],
        }
        for r in rows
    ]


def get_event(event_id):
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT id, user_id, title, notes, location, date, start_time, end_time, all_day, "
            "repeat, repeat_interval, repeat_end, created_at, updated_at FROM events WHERE id = ?",
            (event_id,),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    return {
        "id": row[0],
        "user_id": row[1],
        "title": row[2],
        "notes": row[3],
        "location": row[4],
        "date": row[5],
        "start_time": row[6],
        "end_time": row[7],
        "all_day": bool(row[8]),
        "repeat": row[9] or "none",
        "repeat_interval": row[10] or 1,
        "repeat_end": row[11],
        "created_at": row[12],
        "updated_at": row[13],
    }


def update_event(event_id, title=None, notes=None, date=None, start_time=_UNSET,
                 end_time=_UNSET, all_day=None, location=None, repeat=None,
                 repeat_interval=None, repeat_end=_UNSET):
    """更新日程字段; start_time/end_time/repeat_end 传 None 表示清除。"""
    fields = {}
    if title is not None:
        fields["title"] = title
    if notes is not None:
        fields["notes"] = notes
    if location is not None:
        fields["location"] = location
    if repeat is not None:
        fields["repeat"] = repeat
    if repeat_interval is not None:
        fields["repeat_interval"] = repeat_interval
    if repeat_end is not _UNSET:
        fields["repeat_end"] = repeat_end
    if date is not None:
        fields["date"] = date
    if start_time is not _UNSET:
        fields["start_time"] = start_time
    if end_time is not _UNSET:
        fields["end_time"] = end_time
    if all_day is not None:
        fields["all_day"] = 1 if all_day else 0
    if not fields:
        return
    fields["updated_at"] = time.time()
    assignments = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values()) + [event_id]
    with _lock:
        conn = _conn()
        try:
            conn.execute(f"UPDATE events SET {assignments} WHERE id = ?", values)
            conn.commit()
        finally:
            conn.close()


def delete_event(event_id):
    with _lock:
        conn = _conn()
        try:
            conn.execute("DELETE FROM events WHERE id = ?", (event_id,))
            conn.commit()
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# 学期规则 (Semester)
# ---------------------------------------------------------------------------
def create_semester(user_id, name="", start_date="", total_weeks=18):
    sid = uuid.uuid4().hex
    now = time.time()
    with _lock:
        conn = _conn()
        try:
            conn.execute(
                "INSERT INTO semesters (id, user_id, name, start_date, total_weeks, "
                "created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
                (sid, user_id, name, start_date, total_weeks, now, now),
            )
            conn.commit()
        finally:
            conn.close()
    return sid


def list_semesters(user_id):
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT id, name, start_date, total_weeks, created_at, updated_at "
            "FROM semesters WHERE user_id = ? ORDER BY created_at ASC",
            (user_id,),
        ).fetchall()
    finally:
        conn.close()
    return [
        {
            "id": r[0],
            "name": r[1],
            "start_date": r[2],
            "total_weeks": r[3],
            "created_at": r[4],
            "updated_at": r[5],
        }
        for r in rows
    ]


def get_semester(sid):
    conn = _conn()
    try:
        row = conn.execute(
            "SELECT id, user_id, name, start_date, total_weeks, created_at, updated_at "
            "FROM semesters WHERE id = ?",
            (sid,),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    return {
        "id": row[0],
        "user_id": row[1],
        "name": row[2],
        "start_date": row[3],
        "total_weeks": row[4],
        "created_at": row[5],
        "updated_at": row[6],
    }


def update_semester(sid, name=None, start_date=None, total_weeks=None):
    fields = {}
    if name is not None:
        fields["name"] = name
    if start_date is not None:
        fields["start_date"] = start_date
    if total_weeks is not None:
        fields["total_weeks"] = total_weeks
    if not fields:
        return
    fields["updated_at"] = time.time()
    assignments = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values()) + [sid]
    with _lock:
        conn = _conn()
        try:
            conn.execute(f"UPDATE semesters SET {assignments} WHERE id = ?", values)
            conn.commit()
        finally:
            conn.close()


def delete_semester(sid):
    with _lock:
        conn = _conn()
        try:
            conn.execute("DELETE FROM semesters WHERE id = ?", (sid,))
            conn.commit()
        finally:
            conn.close()


# ---------------------------------------------------------------------------
# 按标题/名称删除 (供 AI 命令使用)
# ---------------------------------------------------------------------------
def delete_todos_by_title(user_id, title):
    """删除指定用户下标题完全匹配的所有待办, 返回删除数量。"""
    with _lock:
        conn = _conn()
        try:
            cur = conn.execute(
                "DELETE FROM todos WHERE user_id = ? AND title = ?",
                (user_id, title),
            )
            conn.commit()
            return cur.rowcount
        finally:
            conn.close()


def delete_events_by_title(user_id, title):
    """删除指定用户下标题完全匹配的所有日程, 返回删除数量。"""
    with _lock:
        conn = _conn()
        try:
            cur = conn.execute(
                "DELETE FROM events WHERE user_id = ? AND title = ?",
                (user_id, title),
            )
            conn.commit()
            return cur.rowcount
        finally:
            conn.close()


def delete_semesters_by_name(user_id, name):
    """删除指定用户下名称完全匹配的所有学期, 返回删除数量。"""
    with _lock:
        conn = _conn()
        try:
            cur = conn.execute(
                "DELETE FROM semesters WHERE user_id = ? AND name = ?",
                (user_id, name),
            )
            conn.commit()
            return cur.rowcount
        finally:
            conn.close()
