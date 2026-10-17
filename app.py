"""MiMo TTS Studio —— 本地 FastAPI 服务。

启动：python run.py  （或 uvicorn app:app --host 127.0.0.1 --port 8000）
注意：必须绑 127.0.0.1，浏览器录音（getUserMedia）只在 secure context 可用，
用局域网 IP 访问会直接拿不到麦克风权限。
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import re
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import audio_util
import asr
import config
import db
import memory
import mimo_client
from mimo_client import MimoClient, MimoError, friendly_error

app = FastAPI(title="MiMo TTS Studio", version="1.0.0", docs_url=None, redoc_url=None)


@app.exception_handler(Exception)
async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
    """兜底：任何未捕获异常都回结构化 JSON，前端才能给出人话提示。"""
    return JSONResponse(
        status_code=500,
        content={"detail": {"message": f"本地服务异常：{type(exc).__name__}: {exc}"[:300], "raw": ""}},
    )


client = MimoClient()
semaphore = asyncio.Semaphore(config.MAX_CONCURRENCY)
_runtime_key: dict[str, str] = {"value": ""}
_sample_b64_cache: dict[str, tuple[float, str]] = {}
_cleaner_task: asyncio.Task | None = None
_ffmpeg_ok = audio_util.ffmpeg_available()  # 导入时先探一次，startup 再刷新


# ---------------------------------------------------------------- 生命周期


@app.on_event("startup")
async def _startup() -> None:
    global _cleaner_task, _ffmpeg_ok
    mimo_client.load_dotenv()
    _ffmpeg_ok = audio_util.ffmpeg_available()
    db.init()
    memory.ensure_dirs()
    audio_util.cleanup_old_files([config.OUTPUT_DIR])
    _cleaner_task = asyncio.create_task(_cleaner_loop())


@app.on_event("shutdown")
async def _shutdown() -> None:
    if _cleaner_task:
        _cleaner_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await _cleaner_task
    await client.aclose()
    db.close()


async def _cleaner_loop() -> None:
    while True:
        try:
            await asyncio.sleep(config.CLEAN_INTERVAL)
            audio_util.cleanup_old_files([config.OUTPUT_DIR, config.CACHE_DIR])
        except asyncio.CancelledError:
            raise
        except Exception:
            continue


# ---------------------------------------------------------------- 请求模型


class TTSRequest(BaseModel):
    model: str = "mimo-v2.5-tts"
    text: str = ""
    instruction: str = ""
    voice: str | None = None
    optimize_text_preview: bool | None = None
    sample_id: str | None = None
    stream: bool = False
    format: str | None = None


class SettingsRequest(BaseModel):
    api_key: str = Field(default="", max_length=512)
    persist: bool = False


class PreviewRequest(BaseModel):
    voice: str


class ChatMessage(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(max_length=4000)


class LLMConfig(BaseModel):
    base_url: str | None = Field(default=None, max_length=300)
    api_key: str | None = Field(default=None, max_length=512)
    model: str | None = Field(default=None, max_length=120)
    # auto=不指定（交给服务端默认）／on=开启思考／off=关闭思考
    thinking: str | None = Field(default=None, pattern="^(auto|on|off)$")


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(default_factory=list)
    llm: LLMConfig | None = None
    use_memory: bool = True


class RecordRequest(BaseModel):
    """一条合成记录。params 存完整界面参数，点「复原」时原样回填。"""

    id: str | None = Field(default=None, max_length=40)
    created_at: int | None = None
    model: str = Field(default="", max_length=80)
    short: str = Field(default="", max_length=16)
    text: str = Field(default="", max_length=4000)
    user_text: str = Field(default="", max_length=4000)
    url: str = Field(default="", max_length=500)
    filename: str = Field(default="", max_length=200)
    duration: float = 0
    bytes: int = 0
    first_ms: int | None = None
    total_ms: int | None = None
    streamed: bool = False
    generated_text: str = Field(default="", max_length=4000)
    params: dict[str, Any] = Field(default_factory=dict)


class ChatLogRequest(BaseModel):
    session_id: str = Field(default="", max_length=40)
    user: str = Field(default="", max_length=4000)
    assistant: str = Field(default="", max_length=4000)
    voice: str = Field(default="", max_length=40)
    audio_url: str = Field(default="", max_length=500)
    title: str = Field(default="", max_length=80)
    asr_ms: int | None = None
    first_audio_ms: int | None = None


class MemoryWriteRequest(BaseModel):
    permanent: str | None = Field(default=None, max_length=config.MEMORY_PERMANENT_MAX)


class MemoryDistillRequest(BaseModel):
    llm: LLMConfig | None = None
    limit: int = Field(default=config.MEMORY_DISTILL_TURNS, ge=4, le=200)


# ---------------------------------------------------------------- 工具


def resolve_key(x_api_key: str | None) -> str:
    header_key = (x_api_key or "").strip()
    if header_key:
        return header_key
    if _runtime_key["value"]:
        return _runtime_key["value"]
    return mimo_client.env_api_key()


def key_state(x_api_key: str | None) -> dict:
    header_key = (x_api_key or "").strip()
    if header_key:
        source = "browser"
    elif _runtime_key["value"]:
        source = "runtime"
    elif mimo_client.env_api_key():
        source = "env"
    else:
        source = None
    return {"key_configured": bool(resolve_key(x_api_key)), "key_source": source}


def to_http(exc: MimoError) -> HTTPException:
    status = exc.status if 400 <= exc.status <= 599 else (503 if exc.status == 0 else 502)
    return HTTPException(
        status_code=status,
        detail={
            "message": friendly_error(exc.status, exc.message),
            "raw": (exc.raw or exc.message)[:600],
            "upstream_status": exc.status,
        },
    )


_THINK_REJECT = re.compile(
    r"(unknown|unrecogni[sz]ed|unexpected|unsupported|not\s+support|invalid|extra|additional)"
    r"[\s\S]{0,80}(thinking|reasoning)",
    re.I,
)


def _thinking_field_rejected(message: str) -> bool:
    """上游是否因为不认识 thinking/reasoning 字段而拒绝。"""
    text = message or ""
    if _THINK_REJECT.search(text):
        return True
    # 反向语序：「thinking 不支持」这类
    return bool(re.search(r"(thinking|reasoning)[\s\S]{0,40}(unknown|not\s+support|unsupported|invalid)", text, re.I))


def load_sample_data_url(sample_id: str | None) -> str:
    sid = (sample_id or "").strip()
    if not re.fullmatch(r"[0-9a-f]{32}", sid):
        raise HTTPException(400, detail={"message": "样本编号无效，请重新上传"})
    meta_path = config.UPLOAD_DIR / f"{sid}.json"
    if not meta_path.exists():
        raise HTTPException(404, detail={"message": "样本不存在，可能已过期，请重新上传"})
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        raise HTTPException(500, detail={"message": "样本元数据损坏，请重新上传"})

    file_path = config.UPLOAD_DIR / str(meta.get("file", ""))
    if not file_path.exists():
        raise HTTPException(404, detail={"message": "样本文件丢失，请重新上传"})

    mtime = file_path.stat().st_mtime
    cached = _sample_b64_cache.get(sid)
    if cached and cached[0] == mtime:
        return cached[1]

    b64 = base64.b64encode(file_path.read_bytes()).decode("ascii")
    if len(b64) > 10 * 1024 * 1024:
        raise HTTPException(413, detail={"message": "样本 Base64 后超过 10MB，请压缩或剪短后重试"})
    mime = meta.get("mime") or config.MIME_BY_EXT.get(file_path.suffix, "audio/mpeg")
    data_url = f"data:{mime};base64,{b64}"
    _sample_b64_cache[sid] = (mtime, data_url)
    return data_url


def prepare_payload(req: TTSRequest, stream: bool) -> dict:
    sample_url = load_sample_data_url(req.sample_id) if req.model == "mimo-v2.5-tts-voiceclone" else None
    return mimo_client.build_payload(
        model=req.model,
        text=req.text,
        instruction=req.instruction,
        voice=req.voice,
        stream=stream,
        optimize_text_preview=req.optimize_text_preview,
        sample_data_url=sample_url,
    )


# ---------------------------------------------------------------- 基础接口


@app.get("/api/bootstrap")
async def bootstrap(x_api_key: str | None = Header(default=None)) -> dict:
    return {
        "models": config.MODELS,
        "voices": config.VOICES,
        "opening_tags": config.OPENING_TAGS,
        "inline_tags": config.INLINE_TAGS,
        "style_presets": config.STYLE_PRESETS,
        "design_dimensions": config.DESIGN_DIMENSIONS,
        "design_templates": config.DESIGN_TEMPLATES,
        "director_example": config.DIRECTOR_EXAMPLE,
        "sample_texts": config.SAMPLE_TEXTS,
        "voice_preview_text": config.VOICE_PREVIEW_TEXT,
        "limits": {
            "max_upload_mb": round(config.MAX_UPLOAD_BYTES / 1024 / 1024, 1),
            "soft_chars": 500,
            "base_url": config.BASE_URL,
            "sample_rate": config.SAMPLE_RATE,
        },
        "talk": {
            "default_voice": config.TALK_VOICE,
            "asr": {
                "engine": "local",
                "label": "SenseVoice-Small",
                "desc": "234M 参数 · CPU 实时 · 离线免费 · 中英日韩粤",
                "available": asr.local_available(),
            },
            "llm": {
                "base_url": config.LLM_BASE_URL,
                "model": config.LLM_MODEL,
                "has_key": bool(config.LLM_API_KEY or resolve_key(x_api_key)),
                "thinking": config.LLM_THINKING,
            },
        },
        "memory": memory.stats(),
        "stats": db.stats(),
        "ffmpeg_available": _ffmpeg_ok,
        **key_state(x_api_key),
    }


@app.post("/api/settings")
async def update_settings(body: SettingsRequest) -> dict:
    key = (body.api_key or "").strip()
    if key:
        _runtime_key["value"] = key
        if body.persist:
            try:
                mimo_client.persist_key(key)
            except OSError:
                pass
    else:
        _runtime_key["value"] = ""
    return {
        "key_configured": bool(_runtime_key["value"] or mimo_client.env_api_key()),
        "persisted": bool(body.persist and key),
    }


@app.post("/api/settings/test")
async def test_settings(x_api_key: str | None = Header(default=None)) -> dict:
    key = resolve_key(x_api_key)
    if not key:
        return {"ok": False, "error": "尚未填写 API Key"}
    payload = mimo_client.build_payload(
        model="mimo-v2.5-tts",
        text=config.VOICE_TEST_TEXT,
        instruction="",
        voice="mimo_default",
        stream=False,
    )
    started = time.perf_counter()
    try:
        audio_bytes, _ = await client.synthesize(payload, key)
    except MimoError as exc:
        return {"ok": False, "error": friendly_error(exc.status, exc.message), "raw": (exc.raw or "")[:400]}
    return {
        "ok": True,
        "latency_ms": int((time.perf_counter() - started) * 1000),
        "bytes": len(audio_bytes),
    }


@app.post("/api/payload")
async def payload_preview(req: TTSRequest) -> dict:
    """给前端「查看请求」面板用，返回脱敏后的真实 payload。不请求上游。"""
    try:
        payload = prepare_payload(req, stream=bool(req.stream))
    except HTTPException as exc:
        return {"error": (exc.detail or {}).get("message") if isinstance(exc.detail, dict) else str(exc.detail)}
    except MimoError as exc:
        return {"error": exc.message}
    return {"payload": mimo_client.redact_payload(payload), "format": payload["audio"].get("format")}


# ---------------------------------------------------------------- 合成


def _store_output(audio_bytes: bytes, ext: str) -> tuple[Path, dict]:
    path = audio_util.write_audio_file(audio_bytes, config.OUTPUT_DIR, ext)
    duration = audio_util.wav_duration(path) if ext == ".wav" else 0.0
    return path, {
        "url": f"/media/{path.name}",
        "filename": path.name,
        "bytes": len(audio_bytes),
        "duration": round(duration, 2),
    }


@app.post("/api/tts")
async def synthesize(req: TTSRequest, x_api_key: str | None = Header(default=None)) -> JSONResponse:
    key = resolve_key(x_api_key)
    if not key:
        raise HTTPException(401, detail={"message": "尚未配置 API Key，请点击右上角齿轮填写"})

    try:
        payload = prepare_payload(req, stream=False)
    except MimoError as exc:
        raise to_http(exc)

    started = time.perf_counter()
    async with semaphore:
        try:
            audio_bytes, meta = await client.synthesize(payload, key)
        except MimoError as exc:
            raise to_http(exc)

    path, info = _store_output(audio_bytes, ".wav")
    return JSONResponse(
        {
            **info,
            "model": payload["model"],
            "format": "wav",
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "upstream_ms": meta.get("latency_ms"),
            "streamed": False,
        }
    )


def _sse(obj: dict) -> str:
    return "data: " + json.dumps(obj, ensure_ascii=False) + "\n\n"


@app.post("/api/tts/stream")
async def synthesize_stream(req: TTSRequest, x_api_key: str | None = Header(default=None)):
    key = resolve_key(x_api_key)
    if not key:
        raise HTTPException(401, detail={"message": "尚未配置 API Key，请点击右上角齿轮填写"})

    try:
        payload = prepare_payload(req, stream=True)
    except MimoError as exc:
        raise to_http(exc)

    await semaphore.acquire()
    started = time.perf_counter()
    try:
        resp = await client.open_stream(payload, key)
    except MimoError as exc:
        semaphore.release()
        raise to_http(exc)
    except Exception:
        semaphore.release()
        raise

    out_path = config.OUTPUT_DIR / f"{uuid.uuid4().hex}.wav"
    writer = audio_util.PcmWavWriter(out_path)
    first_audio_ms: list[int] = []
    text_parts: list[str] = []

    async def event_stream():
        finished = False
        try:
            yield _sse({"type": "ack", "model": payload["model"], "ts": int(time.time() * 1000)})
            async for event in MimoClient.iter_chunks(resp):
                if event["type"] == "audio":
                    if not first_audio_ms:
                        first_audio_ms.append(int((time.perf_counter() - started) * 1000))
                    try:
                        raw = base64.b64decode(event["data"])
                    except Exception:
                        continue
                    writer.write(raw)
                    yield _sse({"type": "audio", "data": event["data"]})
                elif event["type"] == "text":
                    text_parts.append(event["text"])
                    yield _sse({"type": "text", "text": event["text"]})
                elif event["type"] == "error":
                    yield _sse({"type": "error", "message": event.get("message") or "生成失败"})
                    return

            ok = writer.close()
            finished = True
            total_ms = int((time.perf_counter() - started) * 1000)
            if not ok:
                yield _sse({"type": "error", "message": "未收到音频数据，请检查文本内容或标签格式"})
                return
            yield _sse(
                {
                    "type": "meta",
                    "url": f"/media/{out_path.name}",
                    "filename": out_path.name,
                    "bytes": writer.bytes_written,
                    "duration": round(writer.duration, 2),
                    "first_audio_ms": first_audio_ms[0] if first_audio_ms else None,
                    "total_ms": total_ms,
                    "model": payload["model"],
                    "generated_text": "".join(text_parts)[:2000] or None,
                    "streamed": True,
                }
            )
        except asyncio.CancelledError:
            raise  # 客户端断开：让取消自然向上传播
        except Exception as exc:  # noqa: BLE001
            yield _sse({"type": "error", "message": f"流式生成中断：{exc}"})
        finally:
            if not finished:
                writer.abort()
            semaphore.release()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream; charset=utf-8",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ---------------------------------------------------------------- 音色试听


@app.post("/api/voice/preview")
async def voice_preview(body: PreviewRequest, x_api_key: str | None = Header(default=None)) -> dict:
    key = resolve_key(x_api_key)
    if not key:
        raise HTTPException(401, detail={"message": "尚未配置 API Key"})
    if body.voice not in config.VOICE_IDS:
        raise HTTPException(400, detail={"message": "未知音色"})

    safe = re.sub(r"[^A-Za-z0-9_-]", "_", body.voice)
    cache_path = config.CACHE_DIR / f"preview_{safe}.wav"
    if cache_path.exists() and time.time() - cache_path.stat().st_mtime < 24 * 3600:
        return {
            "url": f"/cache/{cache_path.name}",
            "cached": True,
            "duration": round(audio_util.wav_duration(cache_path), 2),
        }

    payload = mimo_client.build_payload(
        model="mimo-v2.5-tts",
        text=config.VOICE_PREVIEW_TEXT,
        instruction="自然、亲和，像和朋友随口聊天。",
        voice=body.voice,
        stream=False,
    )
    async with semaphore:
        try:
            audio_bytes, meta = await client.synthesize(payload, key)
        except MimoError as exc:
            raise to_http(exc)

    path = audio_util.write_audio_file(audio_bytes, config.CACHE_DIR, ".wav")
    return {
        "url": f"/cache/{path.name}",
        "cached": False,
        "duration": round(audio_util.wav_duration(path), 2),
        "latency_ms": meta.get("latency_ms"),
    }


# ---------------------------------------------------------------- 音色复刻样本


@app.post("/api/clone/prepare")
async def clone_prepare(file: UploadFile = File(...), kind: str = Form(default="upload")) -> dict:
    raw_name = file.filename or "sample"
    ext = Path(raw_name).suffix.lower()
    if ext not in config.ALLOWED_UPLOAD_EXT | {".webm", ".ogg", ".oga", ".m4a", ".mp4"}:
        raise HTTPException(400, detail={"message": f"不支持的音频格式 {ext or '(未知)'}，请上传 mp3 / wav"})

    sid = uuid.uuid4().hex
    tmp_in = config.UPLOAD_DIR / f"{sid}.src{ext}"
    total = 0
    try:
        with tmp_in.open("wb") as fh:
            while True:
                chunk = await file.read(1 << 20)
                if not chunk:
                    break
                total += len(chunk)
                if total > config.MAX_UPLOAD_BYTES:
                    fh.close()
                    with contextlib.suppress(OSError):
                        tmp_in.unlink()
                    raise HTTPException(413, detail={"message": f"文件超过 {config.MAX_UPLOAD_BYTES // 1024 // 1024}MB 上限"})
                fh.write(chunk)
    finally:
        await file.close()

    if total == 0:
        with contextlib.suppress(OSError):
            tmp_in.unlink()
        raise HTTPException(400, detail={"message": "上传的文件是空的"})

    final_ext = ".mp3" if ext in {".mp3", ".webm", ".ogg", ".oga", ".m4a", ".mp4"} else ".wav"
    final_path = config.UPLOAD_DIR / f"{sid}{final_ext}"

    try:
        if ext in {".mp3", ".wav"}:
            tmp_in.replace(final_path)
        else:
            if not _ffmpeg_ok:
                raise HTTPException(400, detail={"message": "浏览器录音需要本机 ffmpeg 转码，当前未检测到，请改为上传 mp3 / wav"})
            await audio_util.convert_to_mp3(tmp_in, final_path)
            with contextlib.suppress(OSError):
                tmp_in.unlink()
    except HTTPException:
        for p in (tmp_in, final_path):
            with contextlib.suppress(OSError):
                p.unlink()
        raise
    except Exception as exc:  # noqa: BLE001
        for p in (tmp_in, final_path):
            with contextlib.suppress(OSError):
                p.unlink()
        raise HTTPException(500, detail={"message": f"音频处理失败：{exc}"})

    mime = config.MIME_BY_EXT.get(final_ext, "audio/mpeg")
    duration = await audio_util.probe_duration(final_path)
    meta = {
        "id": sid,
        "file": final_path.name,
        "name": Path(raw_name).stem[:40] or ("录音样本" if kind == "record" else "上传样本"),
        "mime": mime,
        "bytes": final_path.stat().st_size,
        "duration": round(duration, 2),
        "kind": kind,
        "created": int(time.time()),
    }
    (config.UPLOAD_DIR / f"{sid}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return {**meta, "url": f"/samples/{final_path.name}"}


@app.get("/api/clone/samples")
async def clone_samples() -> dict:
    items: list[dict] = []
    for meta_path in sorted(config.UPLOAD_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        file_path = config.UPLOAD_DIR / str(meta.get("file", ""))
        if not file_path.exists():
            continue
        items.append({**meta, "url": f"/samples/{file_path.name}"})
    return {"samples": items, "ffmpeg_available": _ffmpeg_ok}


@app.delete("/api/clone/samples/{sample_id}")
async def clone_delete(sample_id: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{32}", sample_id):
        raise HTTPException(400, detail={"message": "样本编号无效"})
    meta_path = config.UPLOAD_DIR / f"{sample_id}.json"
    if not meta_path.exists():
        raise HTTPException(404, detail={"message": "样本不存在"})
    with contextlib.suppress(Exception):
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        for p in (config.UPLOAD_DIR / str(meta.get("file", "")), meta_path):
            with contextlib.suppress(OSError):
                p.unlink()
    _sample_b64_cache.pop(sample_id, None)
    return {"ok": True}


# ---------------------------------------------------------------- 实时对话


@app.post("/api/asr")
async def speech_to_text(file: UploadFile = File(...)) -> dict:
    """录音 → 文本。只用本地 SenseVoice-Small，全程离线。"""
    if not asr.local_available():
        raise HTTPException(
            400,
            detail={"message": "本地识别模型未安装：运行 scripts/download_asr.py 下载 SenseVoice-Small（约 65MB）"},
        )

    raw = bytearray()
    while True:
        chunk = await file.read(1 << 20)
        if not chunk:
            break
        raw.extend(chunk)
        if len(raw) > config.MAX_UPLOAD_BYTES:
            raise HTTPException(413, detail={"message": "录音文件过大，请缩短说话时长"})
    await file.close()
    if not raw:
        raise HTTPException(400, detail={"message": "没有收到音频数据"})

    token = uuid.uuid4().hex
    tmp_src = config.CACHE_DIR / f"asr_{token}.src"
    tmp_wav = config.CACHE_DIR / f"asr_{token}.wav"
    tmp_src.write_bytes(bytes(raw))
    try:
        if _ffmpeg_ok:
            await audio_util.convert_to_wav16k(tmp_src, tmp_wav)
        elif bytes(raw[:4]) == b"RIFF":
            tmp_wav.write_bytes(bytes(raw))  # 没有 ffmpeg 时，直接收 wav
        else:
            raise HTTPException(500, detail={"message": "需要 ffmpeg 处理浏览器的录音格式，请先安装 ffmpeg"})

        result = await asr.transcribe_local(tmp_wav)
    finally:
        for path in (tmp_src, tmp_wav):
            with contextlib.suppress(OSError):
                path.unlink()

    if not result.get("text"):
        result["empty"] = True
    return result


@app.post("/api/chat")
async def chat(req: ChatRequest, x_api_key: str | None = Header(default=None)):
    """流式对话：任意 OpenAI 兼容服务，base_url / key / model 均可由前端覆盖。

    两个关键点：
    1) 思考开关。MiMo 的深度思考默认开启，参数是 `thinking: {"type": "disabled"}`；
       开启思考时上游会强制 temperature=1.0，所以我们只在关闭/未指定时才带 temperature。
       不同厂商字段名不一致，万一上游因为不认这个字段返回 400，会自动去掉重试一次。
    2) 记忆注入。永久记忆 + 最近几天对话记忆拼进 system prompt。
    """
    llm = req.llm or LLMConfig()
    base_url = (llm.base_url or config.LLM_BASE_URL or config.BASE_URL).strip()
    model = (llm.model or config.LLM_MODEL).strip()
    key = (llm.api_key or config.LLM_API_KEY or resolve_key(x_api_key) or "").strip()

    if not base_url.startswith(("http://", "https://")):
        raise HTTPException(400, detail={"message": "对话模型的 Base URL 必须以 http:// 或 https:// 开头"})
    if not key:
        raise HTTPException(401, detail={"message": "还没有配置对话模型的 API Key"})
    if not model:
        raise HTTPException(400, detail={"message": "还没有填写对话模型的模型 ID"})

    history = [{"role": m.role, "content": m.content} for m in req.messages if m.content.strip()]
    history = history[-config.TALK_MAX_TURNS * 2 :]

    system = config.CHAT_SYSTEM_PROMPT
    memory_block = memory.context_block() if req.use_memory else ""
    if memory_block:
        system = system + "\n\n下面是你记得的信息，回答时自然参考，不要复述这段内容：\n" + memory_block

    messages = [{"role": "system", "content": system}, *history]

    # 前端传了就用前端的，没传就回落到 .env 的默认值
    mode = (llm.thinking or config.LLM_THINKING or "auto").strip().lower()
    if mode not in ("auto", "on", "off"):
        mode = "auto"
    thinking: bool | None = None if mode == "auto" else (mode == "on")

    def build(t: bool | None) -> dict:
        payload: dict[str, Any] = {"model": model, "messages": messages, "stream": True}
        if t is not None:
            payload["thinking"] = {"type": "enabled" if t else "disabled"}
        # 深度思考下 temperature 不可自定义，带了反而可能报错
        if t is not True:
            payload["temperature"] = config.CHAT_TEMPERATURE
        return payload

    payload = build(thinking)
    try:
        resp = await client.open_llm_stream(payload, key, base_url)
    except MimoError as exc:
        if "thinking" in payload and exc.status == 400 and _thinking_field_rejected(exc.message):
            # 上游不认 thinking 字段：去掉重试，保证换个服务也能用
            payload = build(None)
            try:
                resp = await client.open_llm_stream(payload, key, base_url)
            except MimoError as exc2:
                raise to_http(exc2)
        else:
            raise to_http(exc)

    async def gen():
        try:
            yield _sse(
                {
                    "type": "meta",
                    "model": model,
                    "thinking": thinking,
                    "memory_chars": len(memory_block),
                }
            )
            async for event in MimoClient.iter_chunks(resp):
                if event["type"] == "text":
                    yield _sse({"type": "delta", "text": event["text"]})
                elif event["type"] == "error":
                    yield _sse({"type": "error", "message": event.get("message") or "对话生成失败"})
                    return
            yield _sse({"type": "done"})
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            yield _sse({"type": "error", "message": f"对话中断：{exc}"})
        finally:
            await resp.aclose()

    return StreamingResponse(
        gen(),
        media_type="text/event-stream; charset=utf-8",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ---------------------------------------------------------------- 合成记录（SQLite）


@app.get("/api/history")
async def history_list(limit: int = 60, offset: int = 0, model: str = "", q: str = "") -> dict:
    return db.list_records(limit=limit, offset=offset, model=model, keyword=q)


@app.post("/api/history")
async def history_add(req: RecordRequest) -> dict:
    item = db.add_record(req.model_dump())
    return {"ok": True, "item": item}


@app.delete("/api/history/{record_id}")
async def history_delete(record_id: str) -> dict:
    return {"ok": db.delete_record(record_id)}


@app.delete("/api/history")
async def history_clear() -> dict:
    return {"ok": True, "deleted": db.clear_records()}


# ---------------------------------------------------------------- 对话记录（SQLite）


@app.post("/api/chat/log")
async def chat_log(req: ChatLogRequest) -> dict:
    """一轮对话落库，同时追加到当天的对话记忆文件。"""
    sid = db.ensure_session(req.session_id, title=(req.user or "")[:40], voice=req.voice)
    meta = {"asr_ms": req.asr_ms, "first_audio_ms": req.first_audio_ms, "voice": req.voice}
    if req.user.strip():
        db.add_message(sid, "user", req.user, meta=meta)
    if req.assistant.strip():
        db.add_message(sid, "assistant", req.assistant, audio_url=req.audio_url, meta=meta)
    if req.user.strip() or req.assistant.strip():
        memory.append_dialogue(req.user, req.assistant, voice=req.voice, session_id=sid)
    return {"ok": True, "session_id": sid}


@app.get("/api/chat/sessions")
async def chat_sessions(limit: int = 50) -> dict:
    return {"sessions": db.list_sessions(limit=limit), "stats": db.stats()}


@app.delete("/api/chat/sessions")
async def chat_sessions_clear() -> dict:
    return {"ok": True, "deleted": db.clear_sessions()}


@app.get("/api/chat/sessions/{session_id}")
async def chat_session_detail(session_id: str) -> dict:
    msgs = db.session_messages(session_id)
    if not msgs:
        raise HTTPException(404, detail={"message": "这段对话不存在或已删除"})
    return {"session_id": session_id, "messages": msgs}


@app.delete("/api/chat/sessions/{session_id}")
async def chat_session_delete(session_id: str) -> dict:
    return {"ok": db.delete_session(session_id)}


# ---------------------------------------------------------------- 记忆


@app.get("/api/memory")
async def memory_read() -> dict:
    return {
        "permanent": memory.read_permanent(),
        "conversation": memory.read_conversation(
            days=400, max_chars=0
        ),  # 页面里看全部，注入时才截断
        "days": memory.list_days(),
        "stats": memory.stats(),
    }


@app.put("/api/memory")
async def memory_write(req: MemoryWriteRequest) -> dict:
    if req.permanent is None:
        raise HTTPException(400, detail={"message": "没有收到要保存的内容"})
    try:
        chars = memory.write_permanent(req.permanent)
    except ValueError as exc:
        raise HTTPException(400, detail={"message": str(exc)})
    return {"ok": True, "chars": chars, "stats": memory.stats()}


@app.delete("/api/memory")
async def memory_clear(scope: str = "conversation") -> dict:
    if scope == "permanent":
        memory.write_permanent(memory.PERMANENT_TEMPLATE)
        return {"ok": True, "reset": "permanent"}
    if scope == "all":
        memory.write_permanent(memory.PERMANENT_TEMPLATE)
        return {"ok": True, "deleted_days": memory.clear_conversation(), "reset": "permanent"}
    return {"ok": True, "deleted_days": memory.clear_conversation()}


DISTILL_PROMPT = (
    "你是记忆整理助手。下面是一段用户和语音助手的对话记录。\n"
    "请提炼出「值得长期记住的用户信息」，例如称呼、身份、偏好、习惯、正在做的事、重要的人或日期。\n"
    "要求：\n"
    "1. 只用 markdown 无序列表，每行一条，以「- 」开头；\n"
    "2. 每条不超过 40 字，只写结论，不要写「用户提到」这类前缀；\n"
    "3. 最多 8 条；宁缺毋滥，客套话和一次性的问题不要写；\n"
    "4. 没有值得记的内容就只输出「- 暂无」。\n"
    "只输出列表本身，不要任何解释。"
)


def _resolve_llm(llm: LLMConfig | None, x_api_key: str | None) -> tuple[str, str, str]:
    cfg = llm or LLMConfig()
    base_url = (cfg.base_url or config.LLM_BASE_URL or config.BASE_URL).strip()
    model = (cfg.model or config.LLM_MODEL).strip()
    key = (cfg.api_key or config.LLM_API_KEY or resolve_key(x_api_key) or "").strip()
    if not base_url.startswith(("http://", "https://")):
        raise HTTPException(400, detail={"message": "对话模型的 Base URL 必须以 http:// 或 https:// 开头"})
    if not key:
        raise HTTPException(401, detail={"message": "还没有配置对话模型的 API Key"})
    if not model:
        raise HTTPException(400, detail={"message": "还没有填写对话模型的模型 ID"})
    return base_url, model, key


@app.post("/api/memory/distill")
async def memory_distill(req: MemoryDistillRequest, x_api_key: str | None = Header(default=None)) -> dict:
    """用对话模型把最近的聊天记录压成几条记忆要点（不落盘，前端确认后再保存）。"""
    rows = db.recent_dialogues(limit=req.limit)
    if not rows:
        raise HTTPException(400, detail={"message": "还没有对话记录，先在实时对话里聊两句"})

    lines: list[str] = []
    for r in rows:
        who = "我" if r.get("role") == "user" else "MiMo"
        lines.append(f"{who}：{str(r.get('content') or '').strip()}")
    transcript = "\n".join(lines)
    if len(transcript) > 8000:
        transcript = transcript[-8000:]

    base_url, model, key = _resolve_llm(req.llm, x_api_key)
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": DISTILL_PROMPT},
            {"role": "user", "content": transcript},
        ],
        "stream": True,
        "temperature": 0.3,
    }
    try:
        resp = await client.open_llm_stream(payload, key, base_url)
    except MimoError as exc:
        raise to_http(exc)

    parts: list[str] = []
    try:
        async for event in MimoClient.iter_chunks(resp):
            if event["type"] == "text":
                parts.append(event["text"])
            elif event["type"] == "error":
                raise HTTPException(502, detail={"message": event.get("message") or "整理失败"})
    finally:
        with contextlib.suppress(Exception):
            await resp.aclose()

    markdown = "".join(parts).strip()
    # 去掉模型偶尔加的代码块围栏
    markdown = re.sub(r"^```[a-zA-Z]*\n?|```$", "", markdown).strip()
    return {"markdown": markdown, "samples": len(rows)}


# ---------------------------------------------------------------- 静态资源


app.mount("/media", StaticFiles(directory=str(config.OUTPUT_DIR)), name="media")
app.mount("/cache", StaticFiles(directory=str(config.CACHE_DIR)), name="cache")
app.mount("/samples", StaticFiles(directory=str(config.UPLOAD_DIR)), name="samples")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(config.STATIC_DIR / "index.html")


@app.get("/favicon.ico")
async def favicon():
    icon = config.STATIC_DIR / "favicon.svg"
    if icon.exists():
        return FileResponse(icon, media_type="image/svg+xml")
    return JSONResponse(status_code=204, content=None)


app.mount("/static", StaticFiles(directory=str(config.STATIC_DIR)), name="static")
