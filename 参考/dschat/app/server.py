#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""HTTP 服务器与 API 路由 (ThreadingHTTPServer + SSE)。"""

import io
import json
import mimetypes
import os
import re
import socket
import sqlite3
import ssl
import tempfile
import threading
import uuid
import webbrowser
import zipfile
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote

from openai import OpenAI

from . import auth as auth_mod
from . import config as config_mod
from . import mood as mood_mod
from . import storage
from . import websearch
from .config import SYSTEM_PROMPT
from .deepseek import build_user_message, stream_chat, trim_messages

HOST = os.environ.get("DSCHAT_HOST", "::")
PORT = int(os.environ.get("DSCHAT_PORT", "8799"))

# Cookie Secure 开关: 环境变量 DSCHAT_COOKIE_SECURE 控制
#   "1" = 启用 Secure (HTTPS 部署时用)
#   其他/未设置 = 不启用 Secure (默认, 兼容本地与 HTTP 内网穿透)
_COOKIE_SECURE_FORCE = os.environ.get("DSCHAT_COOKIE_SECURE")

# 是否启用了 HTTPS (main 中根据证书判断)
_HTTPS_ENABLED = False


class DualStackHTTPServer(ThreadingHTTPServer):
    """双栈服务器: 监听 IPv6 时同时接受 IPv4 (显式关闭 V6ONLY)。"""
    address_family = socket.AF_INET6

    def server_bind(self):
        # Windows 上 AF_INET6 socket 默认 V6ONLY=1, 需显式关闭以兼容 IPv4
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except OSError:
            pass
        super().server_bind()

_TZ_UTC8 = timezone(timedelta(hours=8))
_WEEKDAYS = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]


def current_time_text():
    """返回当前现实时间的中文描述 (UTC+8)。"""
    now = datetime.now(_TZ_UTC8)
    return f"{now.year}年{now.month}月{now.day}日 {now.hour:02d}:{now.minute:02d}:{now.second:02d} {_WEEKDAYS[now.weekday()]}"


def scan_decorations():
    """扫描 sources/images 目录, 按角色归类装饰图片。

    命名规律: <角色>-<类型>.<ext>
      类型含"高余额"→high, "中余额"→mid, "低余额"→low, "互动"→interact(可多张)
    """
    characters = {}
    if not os.path.isdir(SOURCES_IMAGES_DIR):
        return []
    for fname in sorted(os.listdir(SOURCES_IMAGES_DIR)):
        stem, ext = os.path.splitext(fname)
        if ext.lower() not in _IMAGE_EXTS:
            continue
        if "-" not in stem:
            continue
        name, _, typ = stem.partition("-")
        name = name.strip()
        typ = typ.strip()
        if not name or not typ:
            continue
        if typ.startswith("高余额"):
            kind = "high"
        elif typ.startswith("中余额"):
            kind = "mid"
        elif typ.startswith("低余额"):
            kind = "low"
        elif typ.startswith("互动"):
            kind = "interact"
        else:
            continue
        entry = characters.setdefault(name, {
            "name": name,
            "high": None, "mid": None, "low": None,
            "interact": [],
        })
        if kind == "interact":
            entry["interact"].append(fname)
        else:
            entry[kind] = fname
    return [v for v in characters.values()]


# 进行中的请求停止信号: request_id -> threading.Event
_STOP_EVENTS = {}
_STOP_LOCK = threading.Lock()

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
SOURCES_IMAGES_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sources", "images"
)

_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp")

_MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
}


def _read_json(handler):
    length = int(handler.headers.get("Content-Length", 0) or 0)
    if length <= 0:
        return {}
    try:
        return json.loads(handler.rfile.read(length) or b"{}")
    except (ValueError, json.JSONDecodeError):
        return {}


class Handler(BaseHTTPRequestHandler):
    # ---------------------------------------------------------------- 基础
    def _send(self, status, body, content_type, cache_control="no-cache"):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache_control)
        self.end_headers()
        self.wfile.write(data)

    def _json(self, obj, status=200):
        self._send(status, json.dumps(obj, ensure_ascii=False), "application/json; charset=utf-8")

    def _json_session(self, obj, token=None, clear=False, status=200):
        """带会话 Cookie 的 JSON 响应 (先 send_response 再设置 Cookie)。"""
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        if token:
            self._set_session_cookie(token)
        if clear:
            self._clear_session_cookie()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # ---------------------------------------------------------------- 认证
    _SESSION_COOKIE = "dschat_session"

    def _get_cookie(self, name):
        header = self.headers.get("Cookie", "")
        for part in header.split(";"):
            part = part.strip()
            if part.startswith(name + "="):
                return part[len(name) + 1:].strip()
        return None

    def _current_user(self):
        token = self._get_cookie(self._SESSION_COOKIE)
        if not token:
            return None
        user_id = storage.get_session_user(token)
        if not user_id:
            return None
        return storage.get_user(user_id)

    def _require_auth(self):
        user = self._current_user()
        if user is None:
            self._json({"error": "unauthorized"}, 401)
            return None
        return user

    def _require_admin(self):
        user = self._require_auth()
        if user is None:
            return None
        if user.get("role") != "admin":
            self._json({"error": "forbidden"}, 403)
            return None
        return user

    def _cookie_secure(self):
        # 显式设置优先
        if _COOKIE_SECURE_FORCE is not None:
            return _COOKIE_SECURE_FORCE == "1"
        # 本地直接启用 HTTPS 时
        if _HTTPS_ENABLED:
            return True
        # 经 Cloudflare 等反向代理转发时, 依据 X-Forwarded-Proto 判断
        proto = (self.headers.get("X-Forwarded-Proto", "") or "").split(",")[0].strip().lower()
        return proto == "https"

    def _is_docs_host(self):
        """判断当前请求是否来自 docs 子域名。"""
        host = (self.headers.get("Host", "") or "").split(":")[0].lower()
        return host.startswith("docs.")

    def _set_session_cookie(self, token):
        secure = "; Secure" if self._cookie_secure() else ""
        self.send_header(
            "Set-Cookie",
            f"{self._SESSION_COOKIE}={token}; Path=/; HttpOnly{secure}; SameSite=Lax; "
            f"Max-Age={auth_mod.SESSION_TTL}",
        )

    def _clear_session_cookie(self):
        secure = "; Secure" if self._cookie_secure() else ""
        self.send_header(
            "Set-Cookie",
            f"{self._SESSION_COOKIE}=; Path=/; HttpOnly{secure}; SameSite=Lax; Max-Age=0",
        )

    def _redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    @staticmethod
    def _load_user_cfg(user_id):
        return config_mod.normalize_config(storage.get_user_config(user_id))

    @staticmethod
    def _save_user_cfg(user_id, cfg):
        storage.save_user_config(user_id, cfg)

    def _serve_static(self, rel_path):
        # 防止路径穿越
        safe = os.path.normpath(rel_path).lstrip("/")
        full = os.path.join(STATIC_DIR, safe)
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            self.send_error(404)
            return
        ext = os.path.splitext(full)[1].lower()
        ctype = _MIME.get(ext, mimetypes.guess_type(full)[0] or "application/octet-stream")
        with open(full, "rb") as f:
            data = f.read()
        # 静态资源强制不缓存 (no-store), 避免开发期浏览器缓存导致旧页面
        self._send(200, data, ctype, cache_control="no-store, must-revalidate")

    # ---------------------------------------------------------------- GET
    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        # 公开路由
        if path == "/login":
            self._serve_static("login.html")
            return
        if path == "/docs" or path == "/docs/":
            self._serve_static("docs.html")
            return
        # docs 子域名: 根路径也返回文档页
        if path == "/" and self._is_docs_host():
            self._serve_static("docs.html")
            return
        if path == "/api/auth/me":
            user = self._current_user()
            self._json({"user": user})
            return
        # ICS 订阅 (公开, 靠 token 鉴权)
        if path.startswith("/ics/"):
            self._serve_ics(path[len("/ics/"):])
            return
        if path.startswith("/static/"):
            self._serve_static(path[len("/static/"):])
            return
        if path == "/api/models":
            self._json({"models": config_mod.MODELS, "efforts": config_mod.EFFORTS})
            return

        # 需登录的页面
        if path in ("/", "/index.html", "/todos", "/calendar") or path == "/settings":
            user = self._current_user()
            if user is None:
                self._redirect("/login")
                return
            if path == "/settings":
                self._serve_static("settings.html")
            elif path == "/todos":
                self._serve_static("todos.html")
            elif path == "/calendar":
                self._serve_static("calendar.html")
            else:
                self._serve_static("index.html")
            return

        # 需登录的 API
        user = self._require_auth()
        if user is None:
            return

        if path == "/api/config":
            self._json(self._load_user_cfg(user["id"]))
        elif path == "/api/export":
            self._handle_export(user)
        elif path == "/api/balance":
            self._handle_balance(user)
        elif path == "/api/decorations":
            self._json({"characters": scan_decorations()})
        elif path.startswith("/api/decorations/"):
            self._serve_decoration(path[len("/api/decorations/"):])
        elif path == "/api/agents":
            self._json({"agents": [self._agent_with_mood(a) for a in storage.list_agents(user["id"])]})
        elif path.startswith("/api/agents/"):
            agent_id = path[len("/api/agents/"):]
            agent = storage.get_agent(agent_id)
            if agent is None or agent.get("user_id") != user["id"]:
                self.send_error(404)
            else:
                self._json(self._agent_with_mood(agent))
        elif path == "/api/conversations":
            params = dict(
                kv.split("=", 1) for kv in parsed.query.split("&") if "=" in kv
            )
            # 注意: agent_id 为空字符串(通用助手)也是有效过滤条件, 不能退化为 None
            agent_id = params.get("agent_id")
            self._json({"conversations": storage.list_conversations(user["id"], agent_id)})
        elif path.startswith("/api/conversations/"):
            conv_id = path[len("/api/conversations/"):]
            conv = storage.get_conversation(conv_id)
            if conv is None or conv.get("user_id") != user["id"]:
                self.send_error(404)
            else:
                self._json(conv)
        elif path == "/api/auth/users":
            admin = self._require_admin()
            if admin is None:
                return
            self._json({"users": storage.list_users()})
        elif path == "/api/auth/invites":
            admin = self._require_admin()
            if admin is None:
                return
            self._json({"invites": storage.list_invites()})
        elif path == "/api/todos":
            self._json({"todos": storage.list_todos(user["id"])})
        elif path == "/api/ics-token":
            token = storage.get_ics_token(user["id"])
            host = self.headers.get("Host", "localhost:8799")
            proto = (self.headers.get("X-Forwarded-Proto", "") or "http").split(",")[0].strip()
            url = f"{proto}://{host}/ics/{token}.ics"
            self._json({"url": url})
        elif path == "/api/events":
            params = dict(
                kv.split("=", 1) for kv in parsed.query.split("&") if "=" in kv
            )
            self._json({"events": storage.list_events(
                user["id"],
                start_date=params.get("start"),
                end_date=params.get("end"),
            )})
        elif path == "/api/semesters":
            self._json({"semesters": storage.list_semesters(user["id"])})
        elif path.startswith("/api/images/"):
            self._serve_image(path[len("/api/images/"):])
        else:
            self.send_error(404)

    def _serve_image(self, filename):
        filename = os.path.basename(filename)
        full = storage.image_path(filename)
        if not os.path.isfile(full):
            self.send_error(404)
            return
        ext = os.path.splitext(full)[1].lower()
        ctype = _MIME.get(ext, "application/octet-stream")
        with open(full, "rb") as f:
            data = f.read()
        self._send(200, data, ctype)

    def _serve_decoration(self, filename):
        """服务 sources/images 下的装饰图片。"""
        filename = os.path.basename(unquote(filename))
        full = os.path.join(SOURCES_IMAGES_DIR, filename)
        if not os.path.isfile(full):
            self.send_error(404)
            return
        ext = os.path.splitext(full)[1].lower()
        ctype = _MIME.get(ext, "application/octet-stream")
        with open(full, "rb") as f:
            data = f.read()
        self._send(200, data, ctype)

    # ---------------------------------------------------------------- ICS
    @staticmethod
    def _ics_escape(text):
        """转义 ICS 文本字段中的逗号/分号/换行。"""
        if not text:
            return ""
        text = str(text).replace("\\", "\\\\")
        text = text.replace(";", "\\;").replace(",", "\\,")
        return text.replace("\r\n", "\\n").replace("\n", "\\n")

    @staticmethod
    def _ics_datetime(date_str, time_str):
        """YYYY-MM-DD + HH:MM -> YYYYMMDDTHHMMSS (floating time)。"""
        d = (date_str or "").replace("-", "")
        t = (time_str or "").replace(":", "")
        if len(d) != 8:
            return None
        if len(t) == 4:
            return d + "T" + t + "00"
        return d + "T000000"

    @staticmethod
    def _ics_date(date_str):
        """YYYY-MM-DD -> YYYYMMDD (全天事件)。"""
        return (date_str or "").replace("-", "")

    def _build_ics(self, user_id):
        """生成用户全部日程的 ICS 日历文本。"""
        events = storage.list_events(user_id)
        now = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        lines = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//dschat//calendar//CN",
            "CALSCALE:GREGORIAN",
        ]
        for e in events:
            uid = e["id"]
            dtstamp = now
            summary = self._ics_escape(e["title"])
            desc = self._ics_escape(e["notes"])
            location = self._ics_escape(e.get("location", ""))
            lines.append("BEGIN:VEVENT")
            lines.append(f"UID:{uid}@dschat")
            lines.append(f"DTSTAMP:{dtstamp}")
            if e["all_day"]:
                d = self._ics_date(e["date"])
                if d:
                    lines.append(f"DTSTART;VALUE=DATE:{d}")
                    lines.append(f"DTEND;VALUE=DATE:{d}")
            else:
                start = self._ics_datetime(e["date"], e["start_time"])
                end = self._ics_datetime(e["date"], e["end_time"])
                if start:
                    lines.append(f"DTSTART:{start}")
                if end:
                    lines.append(f"DTEND:{end}")
            lines.append(f"SUMMARY:{summary}")
            if location:
                lines.append(f"LOCATION:{location}")
            if desc:
                lines.append(f"DESCRIPTION:{desc}")
            # 循环规则 RRULE
            repeat = e.get("repeat") or "none"
            if repeat != "none":
                freq = {
                    "daily": "DAILY",
                    "weekly": "WEEKLY",
                    "monthly": "MONTHLY",
                    "yearly": "YEARLY",
                }.get(repeat, "WEEKLY")
                interval = max(1, e.get("repeat_interval") or 1)
                rrule = f"FREQ={freq};INTERVAL={interval}"
                if e.get("repeat_end"):
                    end = e["repeat_end"].replace("-", "")
                    rrule += f";UNTIL={end}T235959Z"
                lines.append(f"RRULE:{rrule}")
            lines.append("END:VEVENT")
        lines.append("END:VCALENDAR")
        return "\r\n".join(lines) + "\r\n"

    def _serve_ics(self, token_part):
        """根据 token 提供 ICS 订阅 (公开访问)。"""
        token = (token_part or "").split(".")[0].strip()
        if not token:
            self.send_error(404)
            return
        rec = storage.get_user_by_ics_token(token)
        if rec is None:
            self.send_error(404)
            return
        body = self._build_ics(rec["id"])
        self._send(200, body, "text/calendar; charset=utf-8")

    # ---------------------------------------------------------------- POST
    def do_POST(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        # 公开: 登录 / 登出 / 注册
        if path == "/api/auth/login":
            self._handle_login()
            return
        if path == "/api/auth/logout":
            self._handle_logout()
            return
        if path == "/api/auth/register":
            self._handle_register()
            return

        user = self._require_auth()
        if user is None:
            return

        if path == "/api/config":
            self._handle_save_config(user)
        elif path == "/api/agents":
            self._handle_create_agent(user)
        elif path == "/api/conversations":
            self._handle_create_conversation(user)
        elif path == "/api/stop":
            self._handle_stop()
        elif path == "/api/chat":
            self._handle_chat(user)
        elif path == "/api/retry":
            self._handle_retry(user)
        elif path == "/api/edit":
            self._handle_edit(user)
        elif path == "/api/auth/password":
            self._handle_change_password(user)
        elif path == "/api/auth/users":
            admin = self._require_admin()
            if admin is None:
                return
            self._handle_create_user()
        elif path == "/api/auth/invites":
            admin = self._require_admin()
            if admin is None:
                return
            self._handle_create_invites()
        elif path == "/api/todos":
            self._handle_create_todo(user)
        elif path == "/api/todos/delete":
            self._handle_delete_todos_by_title(user)
        elif path == "/api/events":
            self._handle_create_event(user)
        elif path == "/api/events/delete":
            self._handle_delete_events_by_title(user)
        elif path == "/api/semesters":
            self._handle_create_semester(user)
        elif path == "/api/semesters/delete":
            self._handle_delete_semesters_by_name(user)
        else:
            self.send_error(404)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        user = self._require_auth()
        if user is None:
            return
        if path.startswith("/api/agents/"):
            agent_id = path[len("/api/agents/"):]
            agent = storage.get_agent(agent_id)
            if agent is None or agent.get("user_id") != user["id"]:
                self.send_error(404)
                return
            storage.delete_agent(agent_id)
            self._json({"ok": True})
        elif path.startswith("/api/conversations/"):
            conv_id = path[len("/api/conversations/"):]
            conv = storage.get_conversation(conv_id)
            if conv is None or conv.get("user_id") != user["id"]:
                self.send_error(404)
                return
            storage.delete_conversation(conv_id)
            self._json({"ok": True})
        elif path.startswith("/api/auth/users/"):
            admin = self._require_admin()
            if admin is None:
                return
            target_id = path[len("/api/auth/users/"):]
            if target_id == user["id"]:
                self._json({"ok": False, "error": "不能删除自己的账号"}, 400)
                return
            storage.delete_user(target_id)
            self._json({"ok": True})
        elif path.startswith("/api/auth/invites/"):
            admin = self._require_admin()
            if admin is None:
                return
            invite_id = path[len("/api/auth/invites/"):]
            storage.delete_invite(invite_id)
            self._json({"ok": True})
        elif path.startswith("/api/todos/"):
            todo_id = path[len("/api/todos/"):]
            todo = storage.get_todo(todo_id)
            if todo is None or todo.get("user_id") != user["id"]:
                self.send_error(404)
                return
            storage.delete_todo(todo_id)
            self._json({"ok": True})
        elif path.startswith("/api/events/"):
            event_id = path[len("/api/events/"):]
            event = storage.get_event(event_id)
            if event is None or event.get("user_id") != user["id"]:
                self.send_error(404)
                return
            storage.delete_event(event_id)
            self._json({"ok": True})
        elif path.startswith("/api/semesters/"):
            sid = path[len("/api/semesters/"):]
            sem = storage.get_semester(sid)
            if sem is None or sem.get("user_id") != user["id"]:
                self.send_error(404)
                return
            storage.delete_semester(sid)
            self._json({"ok": True})
        else:
            self.send_error(404)

    def do_PATCH(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        user = self._require_auth()
        if user is None:
            return
        if path.startswith("/api/agents/"):
            agent_id = path[len("/api/agents/"):]
            agent = storage.get_agent(agent_id)
            if agent is None or agent.get("user_id") != user["id"]:
                self.send_error(404)
                return
            body = _read_json(self)
            storage.update_agent(
                agent_id,
                name=body.get("name"),
                avatar=body.get("avatar"),
                persona=body.get("persona"),
                max_context=body.get("max_context"),
                mood_intensity=self._parse_coefficient(body.get("mood_intensity"))
                if "mood_intensity" in body else None,
                mood_reactivity=self._parse_coefficient(body.get("mood_reactivity"))
                if "mood_reactivity" in body else None,
            )
            self._json({"ok": True})
        elif path.startswith("/api/conversations/"):
            conv_id = path[len("/api/conversations/"):]
            conv = storage.get_conversation(conv_id)
            if conv is None or conv.get("user_id") != user["id"]:
                self.send_error(404)
                return
            body = _read_json(self)
            storage.rename_conversation(conv_id, body.get("title", ""))
            self._json({"ok": True})
        elif path.startswith("/api/todos/"):
            todo_id = path[len("/api/todos/"):]
            self._handle_update_todo(user, todo_id)
        elif path.startswith("/api/events/"):
            event_id = path[len("/api/events/"):]
            self._handle_update_event(user, event_id)
        elif path.startswith("/api/semesters/"):
            sid = path[len("/api/semesters/"):]
            self._handle_update_semester(user, sid)
        else:
            self.send_error(404)

    # ---------------------------------------------------------------- 业务
    @staticmethod
    def _agent_with_mood(agent):
        """为智能体对象附加情绪标签与描述。"""
        state = mood_mod.load_state(agent.get("mood", ""))
        intensity = agent.get("mood_intensity", 0.5)
        agent["mood_label"] = mood_mod.mood_label(state["valence"], state["arousal"], intensity)
        agent["mood_text"] = mood_mod.mood_to_text(state["valence"], state["arousal"], intensity)
        return agent

    def _handle_export(self, user):
        """打包 data 目录 (chat.db + images) 为 zip, 供其他设备同步。"""
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            # chat.db 用 SQLite backup 导出一致副本, 避免边写边打包损坏
            fd, tmp_db = tempfile.mkstemp(suffix=".db")
            os.close(fd)
            try:
                src = sqlite3.connect(storage.DB_PATH)
                dst = sqlite3.connect(tmp_db)
                try:
                    src.backup(dst)
                finally:
                    dst.close()
                    src.close()
                zf.write(tmp_db, "chat.db")
            finally:
                os.remove(tmp_db)
            # 图片目录
            if os.path.isdir(storage.IMAGES_DIR):
                for fname in sorted(os.listdir(storage.IMAGES_DIR)):
                    full = os.path.join(storage.IMAGES_DIR, fname)
                    if os.path.isfile(full):
                        zf.write(full, os.path.join("images", fname))
        self._send(200, buf.getvalue(), "application/zip")

    def _handle_balance(self, user):
        """查询 DeepSeek 账户余额。"""
        cfg = self._load_user_cfg(user["id"])
        try:
            client = OpenAI(api_key=cfg["api_key"], base_url=cfg["base_url"])
            data = client.get("/user/balance", cast_to=dict)
        except Exception as e:  # noqa: BLE001
            self._json({"ok": False, "error": str(e)})
            return
        # 提取第一个余额信息 (通常为 CNY)
        infos = data.get("balance_infos") or []
        total = None
        currency = None
        if infos:
            first = infos[0]
            currency = first.get("currency", "")
            try:
                total = float(first.get("total_balance", "0"))
            except (ValueError, TypeError):
                total = None
        self._json({
            "ok": True,
            "is_available": data.get("is_available", True),
            "currency": currency,
            "total_balance": total,
        })

    def _handle_save_config(self, user):
        body = _read_json(self)
        cfg = self._load_user_cfg(user["id"])
        for key in ("api_key", "base_url", "model", "thinking", "effort"):
            if key in body and body[key] is not None:
                cfg[key] = str(body[key]).strip()
        for key in ("max_tokens", "max_context", "font_size", "math_scale"):
            if key in body:
                try:
                    cfg[key] = int(body[key])
                except (ValueError, TypeError):
                    pass
        if "temperature" in body:
            try:
                cfg["temperature"] = float(body["temperature"])
            except (ValueError, TypeError):
                pass
        if "show_mood" in body:
            cfg["show_mood"] = bool(body["show_mood"])
        if "draw_mode" in body:
            cfg["draw_mode"] = bool(body["draw_mode"])
        if "balance_mode" in body:
            mode = str(body["balance_mode"])
            if mode in ("floating", "fixed"):
                cfg["balance_mode"] = mode
        if "balance_character" in body:
            cfg["balance_character"] = str(body["balance_character"])
        for key in ("balance_warn_threshold", "balance_danger_threshold"):
            if key in body:
                try:
                    cfg[key] = float(body[key])
                except (ValueError, TypeError):
                    pass
        self._save_user_cfg(user["id"], cfg)
        self._json({"ok": True})

    def _handle_create_conversation(self, user):
        body = _read_json(self)
        agent_id = body.get("agent_id", "")
        conv_id = storage.create_conversation(user["id"], agent_id=agent_id)
        self._json({"id": conv_id})

    def _handle_create_agent(self, user):
        body = _read_json(self)
        agent_id = storage.create_agent(
            user["id"],
            name=body.get("name", ""),
            avatar=body.get("avatar", "🤖"),
            persona=body.get("persona", ""),
            max_context=int(body.get("max_context", 32768) or 32768),
            mood_intensity=self._parse_coefficient(body.get("mood_intensity")),
            mood_reactivity=self._parse_coefficient(body.get("mood_reactivity")),
        )
        self._json({"id": agent_id})

    @staticmethod
    def _parse_coefficient(value):
        """解析情绪系数: 0~1, 默认 0.5, 保留两位小数。"""
        try:
            coeff = float(value)
        except (TypeError, ValueError):
            return 0.5
        coeff = max(0.0, min(1.0, coeff))
        return round(coeff, 2)

    # ---------------------------------------------------------------- 账户
    def _handle_login(self):
        body = _read_json(self)
        username = (body.get("username") or "").strip()
        password = body.get("password") or ""
        if not username or not password:
            self._json({"ok": False, "error": "请输入用户名和密码"}, 400)
            return
        rec = storage.get_user_by_username(username)
        if rec is None or not auth_mod.verify_password(password, rec["salt"], rec["password_hash"]):
            self._json({"ok": False, "error": "用户名或密码错误"}, 401)
            return
        token = auth_mod.new_token()
        storage.create_session(token, rec["id"], auth_mod.session_expires_at())
        self._json_session({
            "ok": True,
            "user": {"id": rec["id"], "username": rec["username"], "role": rec["role"]},
        }, token=token)

    def _handle_logout(self):
        token = self._get_cookie(self._SESSION_COOKIE)
        if token:
            storage.delete_session(token)
        self._json_session({"ok": True}, clear=True)

    def _handle_create_user(self):
        body = _read_json(self)
        username = (body.get("username") or "").strip()
        password = body.get("password") or ""
        role = body.get("role") or "user"
        if not username or not password:
            self._json({"ok": False, "error": "请输入用户名和密码"}, 400)
            return
        if storage.get_user_by_username(username) is not None:
            self._json({"ok": False, "error": "用户名已存在"}, 409)
            return
        if role not in ("user", "admin"):
            role = "user"
        if len(password) < 6:
            self._json({"ok": False, "error": "密码至少 6 位"}, 400)
            return
        salt, phash = auth_mod.hash_password(password)
        user_id = auth_mod.new_user_id()
        storage.create_user(user_id, username, phash, salt, role)
        self._json({"ok": True, "id": user_id})

    def _handle_change_password(self, user):
        body = _read_json(self)
        old = body.get("old_password") or ""
        new = body.get("new_password") or ""
        rec = storage.get_user_by_username(user["username"])
        if rec is None or not auth_mod.verify_password(old, rec["salt"], rec["password_hash"]):
            self._json({"ok": False, "error": "原密码错误"}, 401)
            return
        if len(new) < 6:
            self._json({"ok": False, "error": "新密码至少 6 位"}, 400)
            return
        salt, phash = auth_mod.hash_password(new)
        storage.set_user_password(user["id"], phash, salt)
        self._json({"ok": True})

    def _handle_register(self):
        """邀请码注册: 用户名与密码由用户自设, 必须提供有效邀请码。"""
        body = _read_json(self)
        username = (body.get("username") or "").strip()
        password = body.get("password") or ""
        invite_code = (body.get("invite_code") or "").strip().upper()
        if not username or not password or not invite_code:
            self._json({"ok": False, "error": "请填写用户名、密码和邀请码"}, 400)
            return
        if len(username) < 2 or len(username) > 32:
            self._json({"ok": False, "error": "用户名长度需在 2~32 个字符之间"}, 400)
            return
        if storage.get_user_by_username(username) is not None:
            self._json({"ok": False, "error": "用户名已存在"}, 409)
            return
        if len(password) < 6:
            self._json({"ok": False, "error": "密码至少 6 位"}, 400)
            return
        invite = storage.get_invite(invite_code)
        if invite is None or invite.get("used_by"):
            self._json({"ok": False, "error": "邀请码无效或已被使用"}, 400)
            return

        salt, phash = auth_mod.hash_password(password)
        user_id = auth_mod.new_user_id()
        storage.create_user(user_id, username, phash, salt, "user")
        # 原子占用邀请码; 若并发下已被抢用则回滚刚创建的用户
        if not storage.use_invite(invite_code, user_id):
            storage.delete_user(user_id)
            self._json({"ok": False, "error": "邀请码无效或已被使用"}, 400)
            return
        # 注册成功后自动登录
        token = auth_mod.new_token()
        storage.create_session(token, user_id, auth_mod.session_expires_at())
        self._json_session({
            "ok": True,
            "user": {"id": user_id, "username": username, "role": "user"},
        }, token=token)

    def _handle_create_invites(self):
        """管理员批量生成邀请码。"""
        body = _read_json(self)
        try:
            count = int(body.get("count", 1))
        except (ValueError, TypeError):
            count = 1
        count = max(1, min(count, 100))
        note = str(body.get("note") or "").strip()[:100]
        codes = []
        for _ in range(count):
            code = auth_mod.new_invite_code()
            storage.create_invite(code, note)
            codes.append(code)
        self._json({"ok": True, "codes": codes})

    # ---------------------------------------------------------------- 待办
    @staticmethod
    def _normalize_priority(value):
        v = (value or "medium").strip().lower()
        return v if v in ("high", "medium", "low") else "medium"

    @staticmethod
    def _parse_date_loose(value):
        """宽松解析日期, 返回 YYYY-MM-DD 或 None。

        支持: 2026-09-01, 2026-9-1, 2026/09/01, 2026/9/1, 2026年9月1日
        """
        v = (value or "").strip()
        if not v or v == "无":
            return None
        if re.match(r"^\d{4}-\d{2}-\d{2}$", v):
            return v
        m = re.match(r"^(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})日?$", v)
        if m:
            return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
        m = re.match(r"^(\d{4})年(\d{1,2})月(\d{1,2})日$", v)
        if m:
            return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
        return None

    @staticmethod
    def _normalize_due(value):
        return Handler._parse_date_loose(value)

    @staticmethod
    def _build_todo_note(user_id):
        """把用户未完成待办注入 system prompt, 并约定 AI 添加待办的输出格式。"""
        todos = storage.list_todos(user_id)
        pending = [t for t in todos if not t["completed"]]
        lines = ["\n\n[用户待办事项清单]"]
        if not pending:
            lines.append("（暂无未完成的待办）")
        else:
            pri_map = {"high": "高", "medium": "中", "low": "低"}
            for t in pending:
                pri = pri_map.get(t["priority"], "中")
                due = t["due_date"] or "无"
                cat = f"科目:{t['category']} | " if t.get("category") else ""
                lines.append(f"- {t['title']} | {cat}优先级:{pri} | 截止:{due}")
        lines.append(
            "\n[待办操作约定——必须严格遵守] 当用户要求「添加/新建/记一下」待办事项时，"
            "你必须在回复正文的最后，另起一行，原样输出如下格式（不要包代码块、不要加任何前缀、说明或多余文字）：\n"
            "[新增待办] 标题 | 优先级 | 截止日期 | 科目\n"
            "其中：优先级填 高/中/低 之一；截止日期填 YYYY-MM-DD（没有则填 无）；"
            "科目填学科或分类名（如 数学、化学，没有则填 无）。\n"
            "当用户要求「删除/移除/取消/完成」某个待办时，输出：\n"
            "[删除待办] 标题\n"
            "多个待办请每行输出一条。系统会自动识别这些行并真正写入待办清单，"
            "因此你不需要在正文里说「已添加/已删除」，输出标记行即可。"
        )
        return "\n".join(lines)

    def _handle_create_todo(self, user):
        body = _read_json(self)
        title = (body.get("title") or "").strip()
        if not title:
            self._json({"ok": False, "error": "标题不能为空"}, 400)
            return
        todo_id = storage.create_todo(
            user["id"],
            title,
            notes=(body.get("notes") or "").strip(),
            priority=self._normalize_priority(body.get("priority")),
            due_date=self._normalize_due(body.get("due_date")),
            category=(body.get("category") or "").strip(),
        )
        self._json({"ok": True, "id": todo_id})

    def _handle_delete_todos_by_title(self, user):
        body = _read_json(self)
        title = (body.get("title") or "").strip()
        if not title:
            self._json({"ok": False, "error": "标题不能为空"}, 400)
            return
        n = storage.delete_todos_by_title(user["id"], title)
        self._json({"ok": True, "deleted": n})

    def _handle_update_todo(self, user, todo_id):
        todo = storage.get_todo(todo_id)
        if todo is None or todo.get("user_id") != user["id"]:
            self.send_error(404)
            return
        body = _read_json(self)
        fields = {}
        if "title" in body:
            t = (body.get("title") or "").strip()
            if not t:
                self._json({"ok": False, "error": "标题不能为空"}, 400)
                return
            fields["title"] = t
        if "notes" in body:
            fields["notes"] = (body.get("notes") or "").strip()
        if "priority" in body:
            fields["priority"] = self._normalize_priority(body.get("priority"))
        if "category" in body:
            fields["category"] = (body.get("category") or "").strip()
        if "due_date" in body:
            fields["due_date"] = self._normalize_due(body.get("due_date"))
        if "completed" in body:
            fields["completed"] = bool(body.get("completed"))
        storage.update_todo(todo_id, **fields)
        self._json({"ok": True})

    # ---------------------------------------------------------------- 日程
    @staticmethod
    def _normalize_time(value):
        v = (value or "").strip()
        if re.match(r"^\d{2}:\d{2}$", v):
            return v
        return None

    @staticmethod
    def _normalize_date(value):
        return Handler._parse_date_loose(value) or ""

    @staticmethod
    def _normalize_repeat(value):
        v = (value or "none").strip().lower()
        return v if v in ("none", "daily", "weekly", "monthly", "yearly") else "none"

    def _handle_create_event(self, user):
        body = _read_json(self)
        title = (body.get("title") or "").strip()
        if not title:
            self._json({"ok": False, "error": "标题不能为空"}, 400)
            return
        date = self._normalize_date(body.get("date"))
        if not date:
            self._json({"ok": False, "error": "日期格式应为 YYYY-MM-DD"}, 400)
            return
        try:
            interval = max(1, int(body.get("repeat_interval", 1) or 1))
        except (ValueError, TypeError):
            interval = 1
        event_id = storage.create_event(
            user["id"],
            title,
            notes=(body.get("notes") or "").strip(),
            date=date,
            start_time=self._normalize_time(body.get("start_time")),
            end_time=self._normalize_time(body.get("end_time")),
            all_day=bool(body.get("all_day")),
            location=(body.get("location") or "").strip(),
            repeat=self._normalize_repeat(body.get("repeat")),
            repeat_interval=interval,
            repeat_end=self._normalize_date(body.get("repeat_end") or "") or None,
        )
        self._json({"ok": True, "id": event_id})

    def _handle_delete_events_by_title(self, user):
        body = _read_json(self)
        title = (body.get("title") or "").strip()
        if not title:
            self._json({"ok": False, "error": "标题不能为空"}, 400)
            return
        n = storage.delete_events_by_title(user["id"], title)
        self._json({"ok": True, "deleted": n})

    def _handle_update_event(self, user, event_id):
        event = storage.get_event(event_id)
        if event is None or event.get("user_id") != user["id"]:
            self.send_error(404)
            return
        body = _read_json(self)
        fields = {}
        if "title" in body:
            t = (body.get("title") or "").strip()
            if not t:
                self._json({"ok": False, "error": "标题不能为空"}, 400)
                return
            fields["title"] = t
        if "notes" in body:
            fields["notes"] = (body.get("notes") or "").strip()
        if "location" in body:
            fields["location"] = (body.get("location") or "").strip()
        if "repeat" in body:
            fields["repeat"] = self._normalize_repeat(body.get("repeat"))
        if "repeat_interval" in body:
            try:
                fields["repeat_interval"] = max(1, int(body.get("repeat_interval", 1) or 1))
            except (ValueError, TypeError):
                fields["repeat_interval"] = 1
        if "repeat_end" in body:
            fields["repeat_end"] = self._normalize_date(body.get("repeat_end") or "") or None
        if "date" in body:
            d = self._normalize_date(body.get("date"))
            if not d:
                self._json({"ok": False, "error": "日期格式应为 YYYY-MM-DD"}, 400)
                return
            fields["date"] = d
        if "start_time" in body:
            fields["start_time"] = self._normalize_time(body.get("start_time"))
        if "end_time" in body:
            fields["end_time"] = self._normalize_time(body.get("end_time"))
        if "all_day" in body:
            fields["all_day"] = bool(body.get("all_day"))
        storage.update_event(event_id, **fields)
        self._json({"ok": True})

    # ---------------------------------------------------------------- 学期
    def _handle_create_semester(self, user):
        body = _read_json(self)
        start_date = self._normalize_date(body.get("start_date"))
        if not start_date:
            self._json({"ok": False, "error": "起始日期格式应为 YYYY-MM-DD"}, 400)
            return
        try:
            total_weeks = max(1, int(body.get("total_weeks", 18) or 18))
        except (ValueError, TypeError):
            total_weeks = 18
        sid = storage.create_semester(
            user["id"],
            name=(body.get("name") or "").strip(),
            start_date=start_date,
            total_weeks=total_weeks,
        )
        self._json({"ok": True, "id": sid})

    def _handle_delete_semesters_by_name(self, user):
        body = _read_json(self)
        name = (body.get("name") or "").strip()
        if not name:
            self._json({"ok": False, "error": "名称不能为空"}, 400)
            return
        n = storage.delete_semesters_by_name(user["id"], name)
        self._json({"ok": True, "deleted": n})

    def _handle_update_semester(self, user, sid):
        sem = storage.get_semester(sid)
        if sem is None or sem.get("user_id") != user["id"]:
            self.send_error(404)
            return
        body = _read_json(self)
        fields = {}
        if "name" in body:
            fields["name"] = (body.get("name") or "").strip()
        if "start_date" in body:
            d = self._normalize_date(body.get("start_date"))
            if not d:
                self._json({"ok": False, "error": "起始日期格式应为 YYYY-MM-DD"}, 400)
                return
            fields["start_date"] = d
        if "total_weeks" in body:
            try:
                fields["total_weeks"] = max(1, int(body.get("total_weeks", 18) or 18))
            except (ValueError, TypeError):
                fields["total_weeks"] = 18
        storage.update_semester(sid, **fields)
        self._json({"ok": True})

    @staticmethod
    def _build_event_note(user_id):
        """把用户近期日程注入 system prompt, 并约定 AI 添加日程的输出格式。"""
        events = storage.list_events(user_id)
        lines = ["\n\n[用户日程安排]"]
        if not events:
            lines.append("（暂无日程）")
        else:
            for e in events:
                if e["all_day"]:
                    when = f"{e['date']} 全天"
                else:
                    start = e["start_time"] or "?"
                    end = e["end_time"] or "?"
                    when = f"{e['date']} {start}-{end}"
                loc = f" | 地点:{e['location']}" if e.get("location") else ""
                lines.append(f"- {e['title']} | {when}{loc}")
        lines.append(
            "\n[日程操作约定——必须严格遵守] 当用户要求「添加/安排/约」日程或会议时，"
            "你必须在回复正文的最后，另起一行，原样输出如下格式（不要包代码块、不要加任何前缀、说明或多余文字）：\n"
            "[新增日程] 标题 | 日期 | 开始时间 | 结束时间 | 地点 | 重复 | 重复截止\n"
            "其中：日期填 YYYY-MM-DD；若是全天事件，开始和结束时间都填 全天；"
            "若不知道具体时间，开始和结束都填 无；地点填具体地点（没有则填 无）。\n"
            "重复填 无/每天/每周/每月/每年 之一；若是每隔 N 个周期，直接填 每N天/每N周/每N月/每N年（如 每2周）。"
            "重复截止填 YYYY-MM-DD（无则填 无）。\n"
            "示例（循环）：[新增日程] 每周例会 | 2026-09-20 | 10:00 | 11:00 | 三教101 | 每2周 | 2026-12-31\n"
            "示例（不循环）：[新增日程] 数学考试 | 2026-09-30 | 09:00 | 11:00 | 三教101 | 无 | 无\n"
            "当用户要求「删除/取消」某个日程时，输出：\n"
            "[删除日程] 标题\n"
            "多个日程请每行输出一条。系统会自动识别这些行并真正写入日历，"
            "因此你不需要在正文里说「已添加/已删除」，输出标记行即可。"
        )
        return "\n".join(lines)

    @staticmethod
    def _build_semester_note(user_id):
        """把用户学期规则注入 system prompt, 并约定 AI 添加/删除学期的输出格式。"""
        semesters = storage.list_semesters(user_id)
        lines = ["\n\n[用户学期规则]"]
        if not semesters:
            lines.append("（暂无学期规则）")
        else:
            for s in semesters:
                lines.append(f"- {s['name']} | 起始:{s['start_date']} | {s['total_weeks']}周")
        lines.append(
            "\n[学期操作约定——必须严格遵守] 当用户要求「添加/新建」学期规则时，输出：\n"
            "[新增学期] 名称 | 起始日期 | 周数\n"
            "其中起始日期填第一周任意一天的 YYYY-MM-DD，周数填数字（默认 18）。\n"
            "当用户要求「删除/移除」学期时，输出：\n"
            "[删除学期] 名称\n"
            "系统会自动识别并写入/删除，输出标记行即可。"
        )
        return "\n".join(lines)

    def _handle_stop(self):
        body = _read_json(self)
        request_id = body.get("request_id")
        with _STOP_LOCK:
            ev = _STOP_EVENTS.get(request_id)
        if ev:
            ev.set()
        self._json({"ok": True})

    def _handle_chat(self, user):
        body = _read_json(self)
        text = (body.get("text") or "").strip()
        images = body.get("images") or []
        request_id = body.get("request_id") or uuid.uuid4().hex
        web_search = bool(body.get("web_search"))

        # 校验会话归属: 不存在或不属于当前用户则新建
        conv_id = body.get("conversation_id")
        conv = storage.get_conversation(conv_id) if conv_id else None
        if conv is None or conv.get("user_id") != user["id"]:
            conv_id = storage.create_conversation(user["id"])

        # 保存图片文件
        filenames = []
        for data_url in images:
            if not isinstance(data_url, str) or not data_url.startswith("data:"):
                continue
            try:
                filenames.append(storage.save_image(data_url))
            except (ValueError, OSError):
                continue

        # 保存用户消息
        if text or filenames:
            storage.add_message(conv_id, "user", text, "", filenames)
            storage.auto_title(conv_id, text)

        self._generate(user, conv_id, text, web_search, request_id)

    def _handle_retry(self, user):
        """重新生成最后一条回答 (不新增用户消息)。"""
        body = _read_json(self)
        request_id = body.get("request_id") or uuid.uuid4().hex
        web_search = bool(body.get("web_search"))
        conv_id = body.get("conversation_id")
        conv = storage.get_conversation(conv_id) if conv_id else None
        if conv is None or conv.get("user_id") != user["id"]:
            self._json({"ok": False, "error": "会话不存在"}, 404)
            return
        messages = storage.get_messages(conv_id)
        last_user = next((m for m in reversed(messages) if m["role"] == "user"), None)
        if last_user is None:
            self._json({"ok": False, "error": "没有可重试的消息"}, 400)
            return
        storage.delete_last_assistant_message(conv_id)
        self._generate(user, conv_id, last_user["content"], web_search, request_id)

    def _handle_edit(self, user):
        """编辑某条用户消息并重新生成其后的回答。"""
        body = _read_json(self)
        message_id = body.get("message_id")
        new_text = (body.get("text") or "").strip()
        request_id = body.get("request_id") or uuid.uuid4().hex
        web_search = bool(body.get("web_search"))
        conv_id = body.get("conversation_id")
        conv = storage.get_conversation(conv_id) if conv_id else None
        if conv is None or conv.get("user_id") != user["id"]:
            self._json({"ok": False, "error": "会话不存在"}, 404)
            return
        if not new_text:
            self._json({"ok": False, "error": "内容不能为空"}, 400)
            return
        msg = storage.get_message(message_id)
        if msg is None or msg["conversation_id"] != conv_id or msg["role"] != "user":
            self._json({"ok": False, "error": "消息不存在或不可编辑"}, 404)
            return
        storage.update_message_content(message_id, new_text)
        storage.delete_messages_after(conv_id, message_id)
        self._generate(user, conv_id, new_text, web_search, request_id)

    def _generate(self, user, conv_id, text, web_search, request_id):
        """构造上下文并流式生成回答 (供 chat / retry / edit 复用)。"""
        cfg = self._load_user_cfg(user["id"])

        # 确定智能体人格与上下文长度
        conv = storage.get_conversation(conv_id)
        agent = None
        if conv and conv.get("agent_id"):
            agent = storage.get_agent(conv["agent_id"])
        if agent and agent.get("persona", "").strip():
            system_prompt = agent["persona"].strip()
        else:
            system_prompt = SYSTEM_PROMPT
        # 智能体可覆盖上下文长度, 否则用全局配置
        max_context = cfg["max_context"]
        if agent and agent.get("max_context"):
            max_context = agent["max_context"]

        # 情绪系统: 分析用户消息, 更新智能体情绪, 注入当前情绪
        mood_json = ""
        mood_intensity = 0.5
        mood_reactivity = 0.5
        if agent:
            mood_intensity = agent.get("mood_intensity", 0.5) or 0.5
            mood_reactivity = agent.get("mood_reactivity", 0.5) or 0.5
            state = mood_mod.load_state(agent.get("mood", ""))
            d_valence, d_arousal = mood_mod.analyze_text(text)
            state = mood_mod.apply_delta(
                state, d_valence, d_arousal, reactivity=mood_reactivity
            )
            mood_json = mood_mod.dump_state(state)
            mood_desc = mood_mod.mood_to_text(
                state["valence"], state["arousal"], intensity=mood_intensity
            )
        else:
            mood_desc = None

        # 注入现实时间 (所有对话都附带)
        time_note = f"\n\n[当前现实时间] {current_time_text()}"
        # 注入绘图能力说明 (仅当用户开启作图模式, 避免不必要的 token 消耗)
        draw_note = ""
        if cfg.get("draw_mode"):
            draw_note = (
                "\n\n[绘图能力] 当用户需要几何图形、函数图像、示意图或图表时，"
                "直接输出一个 ```svg 代码块，内容为完整的 SVG 图形。要求："
                "SVG 必须包含 viewBox 属性；使用标准 SVG 元素（line/circle/rect/polygon/path/text 等）；"
                "使用清晰的颜色、坐标轴和文字标注；不要使用 script、foreignObject 或动画元素。"
            )
        # 注入情绪状态 (仅智能体)
        mood_note = ""
        if mood_desc:
            mood_note = (
                f"\n\n[你当前的情绪状态] {mood_desc}。"
                "请在回复中自然地流露与这个情绪相符的语气，但不要生硬地说出'我现在的情绪是……'这类话。"
            )
        # 注入待办事项 (用户个人待办清单 + 添加约定)
        todo_note = self._build_todo_note(user["id"])
        # 注入日程安排 (用户个人日程 + 添加约定)
        event_note = self._build_event_note(user["id"])
        # 注入学期规则 (用户个人学期 + 添加约定)
        semester_note = self._build_semester_note(user["id"])
        system_prompt = system_prompt + time_note + draw_note + mood_note + todo_note + event_note + semester_note

        # SSE 响应头
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        def emit(kind, text, **extra):
            payload = {"type": kind, "text": text}
            if extra:
                payload.update(extra)
            data = json.dumps(payload, ensure_ascii=False)
            self.wfile.write(("data: " + data + "\n\n").encode("utf-8"))
            self.wfile.flush()

        # 告知前端当前会话 id (后端可能在缺失时新建了会话)
        emit("conversation_id", conv_id)

        # 联网搜索 (可选): 在发起模型请求前获取实时结果并注入上下文
        if web_search and text:
            emit("search", "正在联网搜索…")
            search_results = websearch.web_search(text)
            if search_results:
                emit("search", f"已获取 {len(search_results)} 条搜索结果，正在抓取正文…")
                search_results = websearch.enrich_results(search_results)
                system_prompt = system_prompt + "\n\n" + websearch.format_results(search_results)
                emit("search", "联网搜索完成")
            else:
                emit("search", "联网搜索无结果，已按常规回答")

        # 构造发给 API 的历史消息 (不含 reasoning)
        api_messages = [{"role": "system", "content": system_prompt}]
        for m in storage.get_messages(conv_id):
            if m["role"] == "user":
                api_messages.append(build_user_message(m["content"], m["images"]))
            else:
                api_messages.append({"role": "assistant", "content": m["content"]})
        api_messages = trim_messages(api_messages, max_context)

        client = OpenAI(api_key=cfg["api_key"], base_url=cfg["base_url"])
        full_content = []
        full_reasoning = []

        stop_event = threading.Event()
        with _STOP_LOCK:
            _STOP_EVENTS[request_id] = stop_event

        try:
            for kind, text in stream_chat(
                client, api_messages, cfg["model"], cfg["thinking"],
                cfg["effort"], cfg["max_tokens"], stop_event=stop_event,
            ):
                emit(kind, text)
                if kind == "content":
                    full_content.append(text)
                elif kind == "reasoning":
                    full_reasoning.append(text)
            if stop_event.is_set():
                # 已停止, 仍保留部分生成内容
                pass
        except BrokenPipeError:
            return
        except Exception as e:  # noqa: BLE001
            try:
                emit("error", str(e))
            except BrokenPipeError:
                return
        finally:
            with _STOP_LOCK:
                _STOP_EVENTS.pop(request_id, None)
            content = "".join(full_content)
            if content:
                storage.add_message(
                    conv_id, "assistant", content, "".join(full_reasoning), []
                )
            # 保存智能体情绪状态
            if agent and mood_json:
                storage.set_agent_mood(agent["id"], mood_json)
                try:
                    state = mood_mod.load_state(mood_json)
                    emit("mood", mood_mod.mood_label(
                        state["valence"], state["arousal"], intensity=mood_intensity
                    ))
                except BrokenPipeError:
                    pass
            try:
                emit("done", content)
            except BrokenPipeError:
                pass

    def log_message(self, *args):
        # 静默访问日志
        pass


def ensure_admin():
    """确保至少存在一个管理员账号; 首次启动时创建并打印凭据。"""
    if storage.count_users() > 0:
        return
    username = os.environ.get("ADMIN_USERNAME", "admin")
    password = os.environ.get("ADMIN_PASSWORD") or auth_mod.new_token()[:12]
    salt, phash = auth_mod.hash_password(password)
    storage.create_user(auth_mod.new_user_id(), username, phash, salt, "admin")
    print("=" * 50)
    print("已创建管理员账号 (请登录后及时修改密码):")
    print(f"  用户名: {username}")
    print(f"  密码:   {password}")
    print("=" * 50)


def main():
    global _HTTPS_ENABLED
    storage.init_db()
    ensure_admin()
    server = DualStackHTTPServer((HOST, PORT), Handler)

    # HTTPS: 提供证书/私钥环境变量则启用
    cert = os.environ.get("DSCHAT_SSL_CERT")
    key = os.environ.get("DSCHAT_SSL_KEY")
    scheme = "http"
    if cert and key and os.path.isfile(cert) and os.path.isfile(key):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=cert, keyfile=key)
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
        _HTTPS_ENABLED = True
        scheme = "https"

    url = f"{scheme}://localhost:{PORT}"
    print("=" * 50)
    print("DeepSeek Chat 已启动")
    print(f"  协议:   {scheme.upper()}")
    print(f"  监听:   {HOST}:{PORT} (IPv6 双栈)")
    print(f"  登录页: {url}/login")
    print(f"  聊天页: {url}")
    print(f"  设置页: {url}/settings")
    print("  按 Ctrl+C 退出")
    print("=" * 50)

    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
