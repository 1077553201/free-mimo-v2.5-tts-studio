"""SQLite 持久化：语音合成记录 + 实时对话记录。

为什么用 SQLite 而不是 localStorage：
- 记录会越积越多，localStorage 只有 5MB，且是同步阻塞的；
- 需要「按时间/模型筛选」「单条删除」「跨浏览器一致」；
- 音频文件名和完整参数是结构化的，塞进 JSON 字符串里检索不了。

库文件：data/studio.db（随 data/ 一起被 .gitignore 排除）。
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from typing import Any

import config

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS tts_records (
    id             TEXT PRIMARY KEY,
    created_at     INTEGER NOT NULL,
    model          TEXT    NOT NULL DEFAULT '',
    short          TEXT    NOT NULL DEFAULT '',
    text           TEXT    NOT NULL DEFAULT '',
    user_text      TEXT    NOT NULL DEFAULT '',
    params         TEXT    NOT NULL DEFAULT '{}',
    url            TEXT    NOT NULL DEFAULT '',
    filename       TEXT    NOT NULL DEFAULT '',
    duration       REAL    NOT NULL DEFAULT 0,
    bytes          INTEGER NOT NULL DEFAULT 0,
    first_ms       INTEGER,
    total_ms       INTEGER,
    streamed       INTEGER NOT NULL DEFAULT 0,
    generated_text TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tts_created ON tts_records (created_at DESC);

CREATE TABLE IF NOT EXISTS chat_sessions (
    id         TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    voice      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions (updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT    NOT NULL,
    role       TEXT    NOT NULL,
    content    TEXT    NOT NULL,
    audio_url  TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    meta       TEXT    NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages (session_id, id);
"""


def _connect() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        conn = sqlite3.connect(str(config.DB_PATH), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.executescript(SCHEMA)
        conn.commit()
        _conn = conn
    return _conn


def init() -> None:
    """建库建表。startup 调一次即可（_connect 里也会兜底建）。"""
    with _lock:
        _connect()


def close() -> None:
    global _conn
    with _lock:
        if _conn is not None:
            try:
                _conn.close()
            except Exception:
                pass
            _conn = None


# ---------------------------------------------------------------- 工具


def _int_or_none(value: Any) -> int | None:
    try:
        if value is None or value == "":
            return None
        return int(round(float(value)))
    except (TypeError, ValueError):
        return None


def _json_loads(raw: Any, default: Any) -> Any:
    if isinstance(raw, (dict, list)):
        return raw
    try:
        return json.loads(raw or "")
    except Exception:
        return default


def _now() -> int:
    return int(time.time())


# ---------------------------------------------------------------- 合成记录


def _record_row(row: sqlite3.Row) -> dict:
    data = dict(row)
    data["params"] = _json_loads(data.get("params"), {})
    data["streamed"] = bool(data.get("streamed"))
    return data


def add_record(data: dict) -> dict:
    """写入一条合成记录。id 相同则覆盖，前端重复提交不会产生脏数据。"""
    rid = str(data.get("id") or uuid.uuid4().hex[:12])
    created = _int_or_none(data.get("created_at")) or _now()
    params = data.get("params") or {}
    values = (
        rid,
        created,
        str(data.get("model") or ""),
        str(data.get("short") or "")[:8],
        str(data.get("text") or "")[:4000],
        str(data.get("user_text") or "")[:4000],
        json.dumps(params, ensure_ascii=False),
        str(data.get("url") or "")[:500],
        str(data.get("filename") or "")[:200],
        float(data.get("duration") or 0),
        int(data.get("bytes") or 0),
        _int_or_none(data.get("first_ms")),
        _int_or_none(data.get("total_ms")),
        1 if data.get("streamed") else 0,
        str(data.get("generated_text") or "")[:4000],
    )
    with _lock:
        conn = _connect()
        conn.execute(
            "INSERT OR REPLACE INTO tts_records "
            "(id, created_at, model, short, text, user_text, params, url, filename, "
            " duration, bytes, first_ms, total_ms, streamed, generated_text) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            values,
        )
        conn.commit()
        row = conn.execute("SELECT * FROM tts_records WHERE id = ?", (rid,)).fetchone()
    return _record_row(row) if row else {}


def list_records(limit: int = 60, offset: int = 0, model: str = "", keyword: str = "") -> dict:
    limit = max(1, min(int(limit or 60), 200))
    offset = max(0, int(offset or 0))
    where: list[str] = []
    args: list[Any] = []
    if model:
        where.append("model = ?")
        args.append(model)
    if keyword:
        where.append("(text LIKE ? OR user_text LIKE ? OR generated_text LIKE ?)")
        like = f"%{keyword}%"
        args.extend([like, like, like])
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    with _lock:
        conn = _connect()
        rows = conn.execute(
            f"SELECT * FROM tts_records{clause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?",
            (*args, limit, offset),
        ).fetchall()
        total = conn.execute(f"SELECT COUNT(*) AS n FROM tts_records{clause}", args).fetchone()["n"]
    return {"items": [_record_row(r) for r in rows], "total": total, "limit": limit, "offset": offset}


def get_record(rid: str) -> dict:
    with _lock:
        conn = _connect()
        row = conn.execute("SELECT * FROM tts_records WHERE id = ?", (str(rid),)).fetchone()
    return _record_row(row) if row else {}


def delete_record(rid: str) -> bool:
    with _lock:
        conn = _connect()
        cur = conn.execute("DELETE FROM tts_records WHERE id = ?", (str(rid),))
        conn.commit()
    return cur.rowcount > 0


def clear_records() -> int:
    with _lock:
        conn = _connect()
        cur = conn.execute("DELETE FROM tts_records")
        conn.commit()
    return cur.rowcount


# ---------------------------------------------------------------- 对话记录


def ensure_session(session_id: str, title: str = "", voice: str = "") -> str:
    sid = (session_id or "").strip() or uuid.uuid4().hex[:12]
    now = _now()
    with _lock:
        conn = _connect()
        row = conn.execute("SELECT id FROM chat_sessions WHERE id = ?", (sid,)).fetchone()
        if row:
            conn.execute(
                "UPDATE chat_sessions SET updated_at = ?, title = CASE WHEN ? <> '' THEN ? ELSE title END, "
                "voice = CASE WHEN ? <> '' THEN ? ELSE voice END WHERE id = ?",
                (now, title, title, voice, voice, sid),
            )
        else:
            conn.execute(
                "INSERT INTO chat_sessions (id, created_at, updated_at, title, voice) VALUES (?,?,?,?,?)",
                (sid, now, now, title[:80], voice[:40]),
            )
        conn.commit()
    return sid


def add_message(
    session_id: str,
    role: str,
    content: str,
    audio_url: str = "",
    meta: dict | None = None,
    created_at: int | None = None,
) -> int:
    sid = ensure_session(session_id)
    now = _now()
    with _lock:
        conn = _connect()
        cur = conn.execute(
            "INSERT INTO chat_messages (session_id, role, content, audio_url, created_at, meta) "
            "VALUES (?,?,?,?,?,?)",
            (sid, role, str(content or "")[:4000], audio_url[:500], created_at or now,
             json.dumps(meta or {}, ensure_ascii=False)),
        )
        conn.execute("UPDATE chat_sessions SET updated_at = ? WHERE id = ?", (now, sid))
        conn.commit()
    return int(cur.lastrowid or 0)


def list_sessions(limit: int = 50) -> list[dict]:
    limit = max(1, min(int(limit or 50), 200))
    with _lock:
        conn = _connect()
        rows = conn.execute(
            "SELECT s.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS message_count "
            "FROM chat_sessions s ORDER BY s.updated_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def session_messages(session_id: str, limit: int = 300) -> list[dict]:
    limit = max(1, min(int(limit or 300), 1000))
    with _lock:
        conn = _connect()
        rows = conn.execute(
            "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id ASC LIMIT ?",
            (str(session_id), limit),
        ).fetchall()
    out: list[dict] = []
    for r in rows:
        item = dict(r)
        item["meta"] = _json_loads(item.get("meta"), {})
        out.append(item)
    return out


def delete_session(session_id: str) -> bool:
    sid = str(session_id)
    with _lock:
        conn = _connect()
        conn.execute("DELETE FROM chat_messages WHERE session_id = ?", (sid,))
        cur = conn.execute("DELETE FROM chat_sessions WHERE id = ?", (sid,))
        conn.commit()
    return cur.rowcount > 0


def clear_sessions() -> int:
    with _lock:
        conn = _connect()
        conn.execute("DELETE FROM chat_messages")
        cur = conn.execute("DELETE FROM chat_sessions")
        conn.commit()
    return cur.rowcount


def recent_dialogues(limit: int = 40) -> list[dict]:
    """给「从对话里提取记忆」用：最近若干条消息，按时间正序。"""
    limit = max(1, min(int(limit or 40), 400))
    with _lock:
        conn = _connect()
        rows = conn.execute(
            "SELECT session_id, role, content, created_at FROM chat_messages ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


def stats() -> dict:
    with _lock:
        conn = _connect()
        rec = conn.execute("SELECT COUNT(*) AS n FROM tts_records").fetchone()["n"]
        ses = conn.execute("SELECT COUNT(*) AS n FROM chat_sessions").fetchone()["n"]
        msg = conn.execute("SELECT COUNT(*) AS n FROM chat_messages").fetchone()["n"]
    return {
        "records": int(rec or 0),
        "sessions": int(ses or 0),
        "messages": int(msg or 0),
        "db": str(config.DB_PATH),
    }
