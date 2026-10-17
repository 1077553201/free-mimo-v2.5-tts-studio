"""音频工具：PCM 拼接落盘、ffmpeg 转码、时长探测、过期文件清理。

Windows 上注意三点（都是踩过的坑）：
1. 子进程一律用列表参数 + `-nostdin`，避开 shell 引号、中文/空格路径、以及 ffmpeg 等 stdin 卡死；
2. `CREATE_NO_WINDOW` 防止每次转码闪黑框；
3. 落盘先写 `.part` 再 `os.replace()` 原子改名，避免中断留下半截 WAV。
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import shutil
import subprocess
import time
import uuid
import wave
from pathlib import Path

import config


# ---------------------------------------------------------------- WAV 落盘


class PcmWavWriter:
    """把上游的 PCM16LE 单声道 24k 分块写成 WAV。

    唯一会静默损坏文件的地方是**跨块奇数字节**：base64 解码后每块长度不保证偶数，
    必须把多出来的 1 个字节留到下一块拼接，否则整段音频后面全部错位。
    """

    def __init__(self, path: Path):
        self.path = Path(path)
        self.part_path = self.path.with_suffix(self.path.suffix + ".part")
        self._carry = b""
        self._frames = 0
        self._wav = wave.open(str(self.part_path), "wb")
        self._wav.setnchannels(1)
        self._wav.setsampwidth(2)
        self._wav.setframerate(config.SAMPLE_RATE)
        self._closed = False

    @property
    def bytes_written(self) -> int:
        return self._frames * 2

    @property
    def duration(self) -> float:
        return self._frames / float(config.SAMPLE_RATE)

    def write(self, chunk: bytes) -> None:
        if not chunk:
            return
        data = self._carry + chunk
        usable = len(data) - (len(data) % 2)
        self._carry = data[usable:]
        if not usable:
            return
        self._wav.writeframes(data[:usable])
        self._frames += usable // 2

    def close(self) -> bool:
        """收尾并原子改名。返回是否有有效音频。"""
        if self._closed:
            return self._frames > 0
        self._closed = True
        try:
            self._wav.close()  # wave 在 close 时回填 RIFF/data 长度，不关就是 0
        except Exception:
            pass
        self._carry = b""
        if self._frames <= 0:
            with contextlib.suppress(OSError):
                self.part_path.unlink()
            return False
        try:
            os.replace(self.part_path, self.path)  # 原子替换
        except OSError:
            with contextlib.suppress(OSError):
                self.part_path.unlink()
            return False
        return True

    def abort(self) -> None:
        """异常/取消时清掉半截文件。"""
        if self._closed:
            return
        self._closed = True
        with contextlib.suppress(Exception):
            self._wav.close()
        for p in (self.part_path, self.path):
            with contextlib.suppress(OSError):
                p.unlink()


def write_audio_file(data: bytes, directory: Path, ext: str = ".wav") -> Path:
    """原始字节（如上游直接返回的完整 WAV）原子落盘。"""
    directory.mkdir(parents=True, exist_ok=True)
    final = directory / f"{uuid.uuid4().hex}{ext}"
    tmp = final.with_suffix(final.suffix + ".part")
    tmp.write_bytes(data)
    os.replace(tmp, final)
    return final


def wav_duration(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as w:
            return w.getnframes() / float(w.getframerate() or config.SAMPLE_RATE)
    except Exception:
        return 0.0


# ---------------------------------------------------------------- ffmpeg


def find_binary(name: str) -> str | None:
    return shutil.which(name)


def ffmpeg_available() -> bool:
    return find_binary("ffmpeg") is not None


def _no_window() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0


async def convert_to_mp3(src: Path, dst: Path, timeout: float = config.FFMPEG_TIMEOUT) -> None:
    """任意浏览器录音格式（webm/ogg/mp4）转成 24k 单声道 mp3。

    统一成 mp3 是因为上游只接受 mp3 / wav，而 MediaRecorder 产不出这两种。
    """
    exe = find_binary("ffmpeg")
    if not exe:
        raise RuntimeError("未检测到 ffmpeg")

    cmd = [
        exe, "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(src),
        "-vn",                    # 丢掉可能存在的封面图流
        "-ac", "1",               # 单声道
        "-ar", str(config.SAMPLE_RATE),
        "-c:a", "libmp3lame",
        "-b:a", "64k",
        "-f", "mp3",
        str(dst),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        creationflags=_no_window(),
    )
    try:
        _, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()  # 不杀会留下进程锁住文件，Windows 上后续删不掉
        await proc.wait()
        raise RuntimeError("音频转码超时")
    if proc.returncode != 0:
        msg = (err or b"").decode("utf-8", "replace").strip()
        raise RuntimeError(f"音频转码失败：{msg[:300] or '未知错误'}")


async def probe_duration(src: Path, timeout: float = 20.0) -> float:
    """用 ffprobe 取时长；失败返回 0，前端只是少显示一个数字而已。"""
    exe = find_binary("ffprobe")
    if not exe:
        return wav_duration(src)
    cmd = [
        exe, "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", str(src),
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            creationflags=_no_window(),
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        return max(0.0, float(out.decode("utf-8", "replace").strip() or 0))
    except Exception:
        return wav_duration(src)


# ---------------------------------------------------------------- 清理


def cleanup_old_files(directories: list[Path], ttl: int = config.FILE_TTL_SECONDS) -> int:
    """删除过期文件。逐个 try/except —— Windows 上被播放器占用会 PermissionError，
    不能让清理任务因此崩掉。"""
    now = time.time()
    removed = 0
    for directory in directories:
        if not directory.exists():
            continue
        for entry in directory.iterdir():
            if not entry.is_file():
                continue
            try:
                if now - entry.stat().st_mtime > ttl:
                    entry.unlink()
                    removed += 1
            except OSError:
                continue
    return removed


def human_size(num: int | float) -> str:
    num = float(num)
    for unit in ("B", "KB", "MB", "GB"):
        if num < 1024 or unit == "GB":
            return f"{num:.0f}{unit}" if unit == "B" else f"{num:.1f}{unit}"
        num /= 1024
    return f"{num:.1f}GB"
