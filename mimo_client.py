"""MiMo TTS 上游客户端。

刻意不用 OpenAI SDK：
- `audio.voice` / `audio.optimize_text_preview` 属于非标准扩展字段，SDK 需要 extra_body 绕过；
- 流式响应里 `delta.audio` 是对象而非字符串，SDK 的 delta 解析对未知字段容易丢弃或抛错；
- 我们需要「先看状态码再决定回 SSE 还是回 JSON」，SDK 的 stream 语义把这两件事耦合了。

所以这里手写 httpx 请求 + 手写 SSE 行解析，规则完全对齐官方文档。
"""

from __future__ import annotations

import base64
import json
import os
import time
from pathlib import Path
from typing import AsyncIterator

import httpx

import config


class MimoError(Exception):
    """上游错误。status=0 表示网络层错误。"""

    def __init__(self, message: str, status: int = 0, raw: str = ""):
        super().__init__(message)
        self.message = message
        self.status = status
        self.raw = raw


# ---------------------------------------------------------------- .env 支持


def load_dotenv(path: Path | None = None) -> None:
    """兼容旧调用：真正的解析在 config 里（BASE_URL 依赖它先执行）。"""
    config._load_dotenv(path)


def persist_key(api_key: str) -> None:
    """把 key 写进 .env（用户勾选「记住到本地」时才会调用）。"""
    path = config.ROOT / ".env"
    lines: list[str] = []
    if path.exists():
        for raw in path.read_text(encoding="utf-8").splitlines():
            if raw.strip().startswith("MIMO_API_KEY="):
                continue
            lines.append(raw)
    lines.append(f"MIMO_API_KEY={api_key}")
    path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")


def env_api_key() -> str:
    return (os.environ.get("MIMO_API_KEY") or "").strip()


# ---------------------------------------------------------------- payload


def build_audio_block(
    model: str,
    fmt: str,
    voice: str | None = None,
    sample_data_url: str | None = None,
    optimize_text_preview: bool | None = None,
) -> dict:
    """按模型差异化组装 audio 对象。

    - tts：voice = 预置音色 id
    - voicedesign：不带 voice，可带 optimize_text_preview
    - voiceclone：voice = data:{mime};base64,{...}
    """
    if model == "mimo-v2.5-tts-voicedesign":
        block: dict = {"format": fmt}
        if optimize_text_preview is not None:
            block["optimize_text_preview"] = bool(optimize_text_preview)
        return block

    if model == "mimo-v2.5-tts-voiceclone":
        if not sample_data_url:
            raise MimoError("音色复刻需要先选择或上传一段音频样本", status=400)
        return {"format": fmt, "voice": sample_data_url}

    # 预置音色
    block = {"format": fmt}
    if voice:
        block["voice"] = voice
    return block


def build_payload(
    *,
    model: str,
    text: str,
    instruction: str = "",
    voice: str | None = None,
    stream: bool = False,
    optimize_text_preview: bool | None = None,
    sample_data_url: str | None = None,
) -> dict:
    """把界面上的字段翻译成 messages + audio。

    规则来自文档：
    - 待合成文本必须放在 role=assistant
    - role=user 放风格/情绪指令，可为空；voicedesign 时 user 是音色描述且必填
    - voicedesign + optimize_text_preview=true 时可以完全不发 assistant
    """
    model = model if model in config.MODEL_MAP else "mimo-v2.5-tts"
    text = (text or "").strip()
    instruction = (instruction or "").strip()

    messages: list[dict] = []

    if model == "mimo-v2.5-tts-voicedesign":
        if not instruction:
            raise MimoError("音色设计需要在 user 消息里提供音色描述", status=400)
        messages.append({"role": "user", "content": instruction})
        if text:
            messages.append({"role": "assistant", "content": text})
        elif not optimize_text_preview:
            raise MimoError("请填写要合成的文本，或开启「智能润色」让模型自动生成", status=400)
    else:
        if instruction:
            messages.append({"role": "user", "content": instruction})
        if not text:
            raise MimoError("要合成的文本不能为空", status=400)
        messages.append({"role": "assistant", "content": text})

    fmt = "pcm16" if stream else "wav"
    audio = build_audio_block(
        model,
        fmt,
        voice=voice,
        sample_data_url=sample_data_url,
        optimize_text_preview=optimize_text_preview,
    )

    payload: dict = {"model": model, "messages": messages, "audio": audio}
    if stream:
        payload["stream"] = True
    return payload


def redact_payload(payload: dict) -> dict:
    """给前端「查看请求」面板用的脱敏副本：base64 折叠成占位符。"""
    clone = json.loads(json.dumps(payload))
    audio = clone.get("audio") or {}
    voice = audio.get("voice")
    if isinstance(voice, str) and voice.startswith("data:"):
        head, _, b64 = voice.partition("base64,")
        audio["voice"] = f"{head}base64,…({len(b64) * 3 // 4 // 1024}KB)"
    return clone


# ---------------------------------------------------------------- 响应解析


def _message_audio(payload: dict) -> str | None:
    try:
        message = payload["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        return None
    audio = message.get("audio") if isinstance(message, dict) else None
    if isinstance(audio, dict):
        data = audio.get("data")
        return data if isinstance(data, str) and data else None
    return None


def _delta_audio(payload: dict) -> str | None:
    """delta.audio 可能是 dict、也可能是 null，甚至被序列化成字符串，全部兜住。"""
    try:
        choice = payload["choices"][0]
    except (KeyError, IndexError, TypeError):
        return None
    delta = choice.get("delta") or {}
    if not isinstance(delta, dict):
        return None
    audio = delta.get("audio")
    if isinstance(audio, dict):
        data = audio.get("data")
        if isinstance(data, str) and data:
            return data
    elif isinstance(audio, str) and audio:
        return audio
    return None


def _delta_text(payload: dict) -> str | None:
    try:
        delta = payload["choices"][0].get("delta") or {}
    except (KeyError, IndexError, TypeError):
        return None
    content = delta.get("content")
    return content if isinstance(content, str) and content else None


def _error_message(status: int, body: str) -> str:
    text = (body or "").strip()
    try:
        data = json.loads(text)
    except Exception:
        return text[:300] or f"上游返回 {status}"
    err = data.get("error") if isinstance(data, dict) else None
    if isinstance(err, dict):
        return str(err.get("message") or err.get("msg") or err)[:300]
    if isinstance(err, str):
        return err[:300]
    for key in ("message", "detail", "msg"):
        if isinstance(data, dict) and isinstance(data.get(key), str):
            return data[key][:300]
    return text[:300]


def friendly_error(status: int, message: str) -> str:
    """把上游/网络错误翻译成用户能看懂的一句话，保留原始信息便于排错。"""
    if status == 401:
        return "API Key 无效或已过期，请点击右上角齿轮检查"
    if status == 403:
        return "没有该模型的访问权限，请确认账号已开通"
    if status == 429:
        return "触发限流或配额不足，请稍后重试"
    if 400 <= status < 500:
        return f"请求被拒绝（{status}）：{message}"
    if 500 <= status < 600:
        return f"上游服务异常（{status}）：{message}"
    if status == 0:
        return message or "网络连接失败，请检查网络或代理"
    return message


# ---------------------------------------------------------------- 客户端


class MimoClient:
    def __init__(self) -> None:
        self._client = httpx.AsyncClient(
            base_url=config.BASE_URL,
            timeout=httpx.Timeout(
                connect=config.CONNECT_TIMEOUT,
                read=None,  # 关键：voicedesign 首包可能要十几秒，绝不能用 read 超时
                write=config.WRITE_TIMEOUT,
                pool=config.CONNECT_TIMEOUT,
            ),
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
            headers={"User-Agent": "mimo-tts-studio/1.0"},
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    @staticmethod
    def _headers(api_key: str) -> dict:
        return {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream, application/json",
        }

    async def synthesize(self, payload: dict, api_key: str) -> tuple[bytes, dict]:
        """非流式请求，返回 (音频字节, 元信息)。"""
        if not api_key:
            raise MimoError("尚未配置 API Key", status=401)

        started = time.perf_counter()
        try:
            async with httpx.AsyncClient(
                base_url=config.BASE_URL,
                timeout=httpx.Timeout(
                    connect=config.CONNECT_TIMEOUT,
                    read=config.READ_TIMEOUT_TOTAL,
                    write=config.WRITE_TIMEOUT,
                    pool=config.CONNECT_TIMEOUT,
                ),
                follow_redirects=True,
            ) as client:
                resp = await client.post(config.CHAT_PATH, json=payload, headers=self._headers(api_key))
        except httpx.HTTPError as exc:
            raise MimoError(f"网络请求失败：{str(exc) or type(exc).__name__}", status=0) from exc

        latency_ms = int((time.perf_counter() - started) * 1000)
        if resp.status_code >= 400:
            raise MimoError(_error_message(resp.status_code, resp.text), status=resp.status_code, raw=resp.text[:2000])

        try:
            data = resp.json()
        except Exception as exc:
            raise MimoError("上游返回了无法解析的内容", status=502, raw=resp.text[:500]) from exc

        if isinstance(data, dict) and data.get("error"):
            raise MimoError(_error_message(502, json.dumps(data, ensure_ascii=False)), status=502)

        b64 = _message_audio(data)
        if not b64:
            raise MimoError("上游没有返回音频数据（文本可能为空，或该模型不支持当前参数）", status=502, raw=resp.text[:800])

        try:
            audio_bytes = base64.b64decode(b64)
        except Exception as exc:
            raise MimoError("音频数据解码失败", status=502) from exc

        if not audio_bytes:
            raise MimoError("音频数据为空", status=502)

        usage = data.get("usage") if isinstance(data, dict) else None
        return audio_bytes, {"latency_ms": latency_ms, "usage": usage}

    async def open_stream(self, payload: dict, api_key: str) -> httpx.Response:
        """建立流式连接。

        必须先拿到响应头并判断状态码，再交给 StreamingResponse ——
        否则 HTTP 头已经发出，上游 401 就只能变成一条诡异的中断。
        """
        if not api_key:
            raise MimoError("尚未配置 API Key", status=401)

        payload = {**payload, "stream": True}
        request = self._client.build_request(
            "POST", config.CHAT_PATH, json=payload, headers=self._headers(api_key)
        )
        try:
            resp = await self._client.send(request, stream=True)
        except httpx.HTTPError as exc:
            raise MimoError(f"网络请求失败：{str(exc) or type(exc).__name__}", status=0) from exc

        if resp.status_code >= 400:
            body = ""
            try:
                body = (await resp.aread()).decode("utf-8", "replace")
            except Exception:
                pass
            await resp.aclose()
            raise MimoError(_error_message(resp.status_code, body), status=resp.status_code, raw=body[:2000])
        return resp

    async def open_llm_stream(self, payload: dict, api_key: str, base_url: str | None = None) -> httpx.Response:
        """按 OpenAI 兼容协议建立对话流。

        base_url 可以是任意兼容服务（官方、vLLM、Ollama、OneAPI、DeepSeek…）：
        传 `https://xxx/v1` 或直接传完整的 `.../chat/completions` 都能识别。
        """
        if not api_key:
            raise MimoError("尚未配置对话模型的 API Key", status=401)

        base = (base_url or config.BASE_URL).rstrip("/")
        url = base if base.endswith("/chat/completions") else base + "/chat/completions"
        request = self._client.build_request(
            "POST", url, json={**payload, "stream": True}, headers=self._headers(api_key)
        )
        try:
            resp = await self._client.send(request, stream=True)
        except httpx.HTTPError as exc:
            detail = str(exc) or type(exc).__name__
            raise MimoError(f"无法连接对话模型（{base}）：{detail}", status=0) from exc

        if resp.status_code >= 400:
            body = ""
            try:
                body = (await resp.aread()).decode("utf-8", "replace")
            except Exception:
                pass
            await resp.aclose()
            raise MimoError(_error_message(resp.status_code, body), status=resp.status_code, raw=body[:2000])
        return resp

    @staticmethod
    async def iter_chunks(resp: httpx.Response) -> AsyncIterator[dict]:
        """把上游 SSE 解析成事件字典。

        上游可能发 `: keep-alive` 注释行、空行、以及非 data 行，全部跳过；
        单块 JSON 解析失败也跳过，不让一条坏数据毁掉整条流。
        """
        try:
            async for line in resp.aiter_lines():
                if not line:
                    continue
                line = line.strip()
                if not line or line.startswith(":") or line.startswith("event:"):
                    continue
                if line.startswith("data:"):
                    line = line[5:].strip()
                if not line or line == "[DONE]":
                    continue
                try:
                    payload = json.loads(line)
                except Exception:
                    continue
                if not isinstance(payload, dict):
                    continue

                if payload.get("error"):
                    yield {"type": "error", "message": _error_message(502, json.dumps(payload, ensure_ascii=False))}
                    continue

                b64 = _delta_audio(payload) or _message_audio(payload)
                if b64:
                    yield {"type": "audio", "data": b64}
                text = _delta_text(payload)
                if text:
                    yield {"type": "text", "text": text}
                if payload.get("usage"):
                    yield {"type": "usage", "usage": payload["usage"]}
        finally:
            await resp.aclose()
