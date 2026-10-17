"""本地记忆：永久记忆 + 对话记忆，都是磁盘上的 Markdown 文件。

设计取舍：
- 用纯文本而不是数据库，因为记忆要被用户「看见 / 手改」，
  打开 data/memory/permanent.md 就能改，比 SQLite 直观得多；
- 永久记忆（permanent.md）只放稳定信息（称呼、偏好、长期设定），手动或半自动维护；
- 对话记忆（chat/YYYY-MM-DD.md）按天追加，程序自动写，用来跨会话续上上下文；
- 注入 system prompt 时都做截断，避免把上下文撑爆。
"""

from __future__ import annotations

import re
import threading
from datetime import datetime
from pathlib import Path

import config

_lock = threading.RLock()

PERMANENT_FILE = config.MEMORY_DIR / "permanent.md"
CHAT_DIR = config.MEMORY_DIR / "chat"

PERMANENT_TEMPLATE = """# 永久记忆

> 这里放「长期有效、值得一直记住」的信息：怎么称呼你、说话偏好、常用场景、固定设定。
> 每次实时对话都会把这段内容带给模型。可以直接手改这个文件，也可以在页面里编辑。

## 关于我
- （例如）叫我阿泽

## 偏好
- （例如）回答简短一点，别用书面语
"""


def ensure_dirs() -> None:
    CHAT_DIR.mkdir(parents=True, exist_ok=True)
    if not PERMANENT_FILE.exists():
        PERMANENT_FILE.write_text(PERMANENT_TEMPLATE, encoding="utf-8")


# ---------------------------------------------------------------- 永久记忆


def read_permanent() -> str:
    ensure_dirs()
    try:
        return PERMANENT_FILE.read_text(encoding="utf-8")
    except OSError:
        return ""


def write_permanent(text: str) -> int:
    """原子写：先写临时文件再 replace，避免写一半停电留下坏文件。"""
    ensure_dirs()
    body = str(text or "")
    if len(body) > config.MEMORY_PERMANENT_MAX:
        raise ValueError(f"永久记忆超过 {config.MEMORY_PERMANENT_MAX} 字上限")
    tmp = PERMANENT_FILE.with_suffix(".md.tmp")
    with _lock:
        tmp.write_text(body, encoding="utf-8")
        tmp.replace(PERMANENT_FILE)
    return len(body)


def permanent_chars() -> int:
    return len(read_permanent().strip())


# ---------------------------------------------------------------- 对话记忆


def _day_file(ts: datetime | None = None) -> Path:
    ensure_dirs()
    stamp = (ts or datetime.now()).strftime("%Y-%m-%d")
    return CHAT_DIR / f"{stamp}.md"


def append_dialogue(
    user: str,
    assistant: str,
    voice: str = "",
    session_id: str = "",
    ts: datetime | None = None,
) -> Path:
    """把一轮问答追加进当天的对话记忆文件。空内容自动跳过。"""
    ensure_dirs()
    now = ts or datetime.now()
    user = (user or "").strip()
    assistant = (assistant or "").strip()
    if not user and not assistant:
        return _day_file(now)

    path = _day_file(now)
    head = f"# 对话记忆 {now.strftime('%Y-%m-%d')}\n\n"
    lines: list[str] = []
    if not path.exists():
        lines.append(head)
    lines.append(f"## {now.strftime('%H:%M')}" + (f" · {voice}" if voice else ""))
    if user:
        lines.append(f"- 我：{user}")
    if assistant:
        lines.append(f"- MiMo：{assistant}")
    lines.append("")

    with _lock:
        with path.open("a", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
    return path


def read_conversation(days: int | None = None, max_chars: int | None = None) -> str:
    """读最近 N 天的对话记忆，超出上限时保留最新的部分。"""
    ensure_dirs()
    days = days or config.MEMORY_CHAT_DAYS
    max_chars = max_chars if max_chars is not None else config.MEMORY_CONTEXT_CHARS
    files = sorted(CHAT_DIR.glob("*.md"), key=lambda p: p.name, reverse=True)[: max(1, days)]
    chunks: list[str] = []
    for path in files:
        try:
            text = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if not text:
            continue
        # 去掉每天的 H1 标题，省点 token
        text = re.sub(r"^#\s*对话记忆[^\n]*\n+", "", text).strip()
        if text:
            chunks.append(text)
    merged = "\n\n".join(chunks).strip()
    if max_chars and len(merged) > max_chars:
        merged = "…（更早的内容已省略）\n" + merged[-max_chars:]
    return merged


def list_days(limit: int = 30) -> list[dict]:
    ensure_dirs()
    out: list[dict] = []
    for path in sorted(CHAT_DIR.glob("*.md"), key=lambda p: p.name, reverse=True)[:limit]:
        try:
            text = path.read_text(encoding="utf-8")
            stat = path.stat()
        except OSError:
            continue
        out.append(
            {
                "day": path.stem,
                "chars": len(text.strip()),
                "turns": text.count("- 我："),
                "mtime": int(stat.st_mtime),
            }
        )
    return out


def clear_conversation() -> int:
    ensure_dirs()
    removed = 0
    for path in CHAT_DIR.glob("*.md"):
        try:
            path.unlink()
            removed += 1
        except OSError:
            continue
    return removed


# ---------------------------------------------------------------- 注入上下文


def _injectable_permanent() -> str:
    """把永久记忆整理成适合注入提示词的样子。

    去掉标题行、引用提示行和模板里的「（例如）…」示例行——
    否则用户还没写任何东西，提示词里就先混进一句「叫我阿泽」。
    """
    text = read_permanent()
    kept: list[str] = []
    for raw in text.splitlines():
        line = raw.rstrip()
        stripped = line.strip()
        if not stripped or stripped.startswith(">") or stripped.startswith("#"):
            continue
        if "（例如）" in stripped or "(例如)" in stripped:
            continue
        kept.append(line)
    return "\n".join(kept).strip()


def context_block() -> str:
    """拼成要注入 system prompt 的记忆块；两边都空就返回空串。"""
    parts: list[str] = []

    perm = _injectable_permanent()
    if perm:
        if len(perm) > config.MEMORY_PERMANENT_INJECT:
            perm = perm[: config.MEMORY_PERMANENT_INJECT] + "…"
        parts.append("【关于用户的长期记忆】\n" + perm)

    convo = read_conversation()
    if convo:
        parts.append("【最近的对话记忆】（时间从早到晚，仅作背景参考）\n" + convo)

    if not parts:
        return ""
    return "\n\n".join(parts)


def stats() -> dict:
    return {
        "permanent_chars": permanent_chars(),
        "permanent_file": str(PERMANENT_FILE),
        "chat_days": len(list_days(400)),
        "chat_dir": str(CHAT_DIR),
    }
