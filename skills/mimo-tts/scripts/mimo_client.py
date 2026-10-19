#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MiMo 接口客户端：payload 组装、HTTP/SSE、错误翻译、重试。

只用标准库（urllib / json / base64），不引入 requests。
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

from mimo_audio import AudioError, PcmAssembler, parse_wav

MODEL_PRESET = "mimo-v2.5-tts"
MODEL_DESIGN = "mimo-v2.5-tts-voicedesign"
MODEL_CLONE = "mimo-v2.5-tts-voiceclone"
MODELS = (MODEL_PRESET, MODEL_DESIGN, MODEL_CLONE)

DEFAULT_BASE = "https://api.xiaomimimo.com/v1"
CHAT_PATH = "/chat/completions"
MAX_SAMPLE_BYTES = 7 * 1024 * 1024  # base64 后约 9.3MB，留出 JSON 余量
UA = "mimo-tts-skill/1.0 (+https://github.com/1077553201/free-mimo-v2.5-tts-studio)"


class TtsError(Exception):
    def __init__(self, kind, message, *, status=None, raw="", retryable=False):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.status = status
        self.raw = redact(raw or "")
        self.retryable = retryable

    def to_dict(self):
        d = {"kind": self.kind, "message": self.message}
        if self.status is not None:
            d["status"] = self.status
        if self.raw:
            d["raw"] = self.raw
        return d


def redact(text: str) -> str:
    """把 sk-xxx 和 Bearer xxx 打码，避免日志泄露 Key。"""
    if not text:
        return ""
    text = re.sub(r"(sk-[A-Za-z0-9_\-]{4})[A-Za-z0-9_\-]+", r"\1***", str(text))
    text = re.sub(r"(Bearer\s+)[A-Za-z0-9._\-]+", r"\1***", text)
    return text[:600]


def normalize_base(url: str | None) -> str:
    base = (url or DEFAULT_BASE).strip().rstrip("/")
    if base.endswith(CHAT_PATH):
        base = base[: -len(CHAT_PATH)]
    return base or DEFAULT_BASE


def load_env_file(path: str) -> dict:
    data = {}
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                data[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        return {}
    return data


def find_env_file(explicit: str | None, skill_dir: str) -> str | None:
    if explicit:
        return explicit if os.path.isfile(explicit) else None
    candidates = [
        os.path.join(os.getcwd(), ".env"),
        os.path.abspath(os.path.join(skill_dir, "..", "..", ".env")),
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    return None


def resolve_credentials(env_file: str | None, base_url: str | None, skill_dir: str) -> tuple[str, str, str | None]:
    """返回 (key, base_url, env_path)。环境变量优先于 .env。"""
    path = find_env_file(env_file, skill_dir)
    env = load_env_file(path) if path else {}

    key = (os.environ.get("MIMO_API_KEY") or env.get("MIMO_API_KEY") or "").strip()
    base = (
        base_url
        or os.environ.get("MIMO_BASE_URL")
        or env.get("MIMO_BASE_URL")
        or DEFAULT_BASE
    )
    return key, normalize_base(base), path


def sample_to_data_url(path: str) -> str:
    if not os.path.isfile(path):
        raise TtsError("usage", "音色样本不存在：%s" % path)
    size = os.path.getsize(path)
    if size > MAX_SAMPLE_BYTES:
        raise TtsError(
            "usage",
            "音色样本 %.1fMB，超过 %.0fMB 上限（base64 后会更大）"
            % (size / 1048576, MAX_SAMPLE_BYTES / 1048576),
        )
    mime = mimetypes.guess_type(path)[0] or "audio/wav"
    with open(path, "rb") as fh:
        raw = fh.read()
    return "data:%s;base64,%s" % (mime, base64.b64encode(raw).decode("ascii"))


def mask_data_url(url: str) -> str:
    if not isinstance(url, str) or not url.startswith("data:"):
        return url
    head, _, payload = url.partition("base64,")
    return "%sbase64,…(%dKB)" % (head, round(len(payload) * 3 / 4 / 1024))


def build_payload(
    *,
    model: str,
    text: str,
    instruction: str = "",
    voice: str | None = None,
    sample_data_url: str | None = None,
    optimize: bool | None = None,
) -> dict:
    """按官方约定组装请求体。

    - 待合成文本放 assistant；风格指令 / 音色描述放 user
    - 预置模型走 pcm16 + stream:true；另外两个模型只支持非流式 wav
    """
    messages = []

    if model == MODEL_DESIGN:
        if not instruction.strip():
            raise TtsError("usage", "音色设计需要 --voice-desc（音色描述）")
        messages.append({"role": "user", "content": instruction})
        if text:
            messages.append({"role": "assistant", "content": text})
        elif not optimize:
            raise TtsError("usage", "音色设计要么给 --text，要么开 --optimize-preview 让模型生成文本")
        audio = {"format": "wav"}
        audio["optimize_text_preview"] = bool(optimize) if isinstance(optimize, bool) else False
        payload = {"model": model, "messages": messages, "audio": audio}
        return payload

    if instruction.strip():
        messages.append({"role": "user", "content": instruction})

    if not text.strip():
        raise TtsError("usage", "待合成文本为空")

    messages.append({"role": "assistant", "content": text})

    if model == MODEL_CLONE:
        if not sample_data_url:
            raise TtsError("usage", "音色复刻需要 --voice-sample")
        payload = {
            "model": model,
            "messages": messages,
            "audio": {"format": "wav", "voice": sample_data_url},
        }
        return payload

    payload = {
        "model": model,
        "messages": messages,
        "audio": {"format": "pcm16", "voice": voice or "mimo_default"},
        "stream": True,
    }
    return payload


def redact_payload(payload: dict) -> dict:
    clone = json.loads(json.dumps(payload))
    audio = clone.get("audio") or {}
    if isinstance(audio.get("voice"), str) and audio["voice"].startswith("data:"):
        audio["voice"] = mask_data_url(audio["voice"])
    return clone


_FRIENDLY = {
    401: ("auth", "API Key 无效或已过期，请检查 MIMO_API_KEY", False),
    403: ("auth", "没有该模型的访问权限，请确认账号已开通", False),
    404: ("upstream", "接口地址不对（404），检查 Base URL 是否到 /v1", False),
    429: ("rate_limit", "触发限流或配额不足，请稍后重试", True),
    413: ("payload", "请求体太大，音色样本建议 ≤ 7MB", False),
}


def _error_from_body(status: int, body: str) -> TtsError:
    text = (body or "").strip()
    try:
        data = json.loads(text)
        err = data.get("error")
        if isinstance(err, str):
            text = err
        elif isinstance(err, dict) and err.get("message"):
            text = err["message"]
        elif isinstance(data.get("message"), str):
            text = data["message"]
        elif isinstance(data.get("detail"), str):
            text = data["detail"]
    except (ValueError, AttributeError):
        pass

    if status in _FRIENDLY:
        kind, message, retryable = _FRIENDLY[status]
        return TtsError(kind, message, status=status, raw=text, retryable=retryable)
    if 500 <= status < 600:
        return TtsError("upstream", "上游服务异常（%d）" % status, status=status, raw=text, retryable=True)
    if 400 <= status < 500:
        return TtsError(
            "upstream",
            "请求被拒绝（%d）：%s" % (status, redact(text) or "参数有误"),
            status=status,
            raw=text,
        )
    return TtsError("upstream", "请求失败（%d）" % status, status=status, raw=text)


@dataclass
class SynthResult:
    pcm: bytes
    streamed: bool
    first_audio_ms: int | None = None
    elapsed_ms: int = 0
    text: str = ""
    attempts: int = 1
    warnings: list = field(default_factory=list)


def _request(payload: dict, key: str, base_url: str, timeout: float):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        normalize_base(base_url) + CHAT_PATH,
        data=body,
        method="POST",
        headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
            "Accept": "text/event-stream, application/json",
            "User-Agent": UA,
        },
    )
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            pass
        raise _error_from_body(exc.code, detail) from None
    except urllib.error.URLError as exc:
        raise TtsError("network", "连不上接口：%s" % exc.reason, retryable=True) from None
    except TimeoutError:
        raise TtsError("network", "请求超时（%.0fs）" % timeout, retryable=True) from None


def _pick_delta_audio(evt: dict) -> str | None:
    try:
        delta = evt["choices"][0].get("delta") or {}
    except (KeyError, IndexError, TypeError):
        return None
    audio = delta.get("audio")
    if isinstance(audio, dict) and audio.get("data"):
        return audio["data"]
    if isinstance(audio, str) and audio:
        return audio
    return None


def _pick_delta_text(evt: dict) -> str:
    try:
        delta = evt["choices"][0].get("delta") or {}
    except (KeyError, IndexError, TypeError):
        return ""
    content = delta.get("content")
    return content if isinstance(content, str) else ""


def _pick_message(payload: dict) -> tuple[str | None, str]:
    try:
        message = payload["choices"][0].get("message") or {}
    except (KeyError, IndexError, TypeError):
        return None, ""
    audio = message.get("audio")
    b64 = audio.get("data") if isinstance(audio, dict) else None
    content = message.get("content")
    return b64, content if isinstance(content, str) else ""


def _consume_stream(resp, started: float) -> SynthResult:
    assembler = PcmAssembler()
    pcm_parts: list[bytes] = []
    first_audio_ms = None
    text = ""
    buf = b""

    while True:
        chunk = resp.read(4096)
        if not chunk:
            break
        buf += chunk.replace(b"\r\n", b"\n")
        while b"\n\n" in buf:
            frame, buf = buf.split(b"\n\n", 1)
            for line in frame.split(b"\n"):
                if not line.startswith(b"data:"):
                    continue
                raw = line[5:].strip()
                if not raw or raw == b"[DONE]":
                    continue
                try:
                    evt = json.loads(raw.decode("utf-8", "replace"))
                except ValueError:
                    continue
                if isinstance(evt, dict) and evt.get("error"):
                    raise _error_from_body(502, json.dumps(evt, ensure_ascii=False))
                audio = _pick_delta_audio(evt)
                if audio:
                    if first_audio_ms is None:
                        first_audio_ms = int((time.perf_counter() - started) * 1000)
                    try:
                        decoded = base64.b64decode(audio, validate=False)
                    except Exception:  # noqa: BLE001
                        continue
                    usable = assembler.feed(decoded)
                    if usable:
                        pcm_parts.append(usable)
                piece = _pick_delta_text(evt)
                if piece:
                    text += piece

    assembler.finish()
    warnings = []
    if assembler.dropped:
        warnings.append("末尾有 %d 字节不完整采样已丢弃" % assembler.dropped)
    return SynthResult(
        pcm=b"".join(pcm_parts),
        streamed=True,
        first_audio_ms=first_audio_ms,
        text=text,
        warnings=warnings,
    )


def _consume_json(resp) -> SynthResult:
    raw = resp.read()
    try:
        data = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        raise TtsError("upstream", "返回的不是 JSON", raw=raw[:600].decode("utf-8", "replace")) from None

    if isinstance(data, dict) and data.get("error"):
        raise _error_from_body(502, json.dumps(data, ensure_ascii=False))

    b64, content = _pick_message(data)
    if not b64:
        raise TtsError("upstream", "返回里没有音频数据（文本可能为空，或参数不被该模型支持）")

    try:
        blob = base64.b64decode(b64, validate=False)
    except Exception:  # noqa: BLE001
        raise TtsError("audio", "音频 base64 解码失败") from None

    try:
        info = parse_wav(blob)
    except AudioError as exc:
        raise TtsError("audio", str(exc)) from None

    return SynthResult(pcm=info.pcm, streamed=False, text=content)


def synthesize(
    payload: dict,
    *,
    key: str,
    base_url: str,
    timeout: float = 180.0,
    retries: int = 2,
    on_retry=None,
) -> SynthResult:
    """发一次请求（含重试）。只有网络错误 / 429 / 5xx 会重试。"""
    attempts = 0
    last: TtsError | None = None
    while attempts <= retries:
        attempts += 1
        started = time.perf_counter()
        try:
            resp = _request(payload, key, base_url, timeout)
            with resp:
                result = _consume_stream(resp, started) if payload.get("stream") else _consume_json(resp)
            result.elapsed_ms = int((time.perf_counter() - started) * 1000)
            result.attempts = attempts
            if not result.pcm:
                raise TtsError("audio", "没有收到音频数据")
            return result
        except TtsError as exc:
            last = exc
            if not exc.retryable or attempts > retries:
                raise
            delay = min(2 ** (attempts - 1), 8)
            if on_retry:
                on_retry(attempts, delay, exc)
            time.sleep(delay)
    raise last or TtsError("upstream", "请求失败")
