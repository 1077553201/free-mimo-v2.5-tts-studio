"""语音识别（ASR）—— 两种引擎，同一接口。

1. `mimo`  ：走 MiMo 云端 `mimo-v2.5-asr`，中文/方言识别效果最好，零本地参数，需要 API Key。
2. `local` ：本地 SenseVoice-Small（234M 参数，ONNX，CPU 实时），离线可用，中/粤/英/日/韩。

选型理由：中文识别要在「准」和「小」之间取平衡，234M 的 SenseVoice 是当前性价比最高的一档
（Paraformer-zh 220M 也不错但依赖 torch；whisper-small 244M 中文弱于 SenseVoice）。
"""

from __future__ import annotations

import asyncio
import time
import wave
from pathlib import Path

import config

_recognizer = None
_load_error: str | None = None


# ---------------------------------------------------------------- 本地引擎


def local_model_dir() -> Path:
    return config.SENSEVOICE_DIR


def local_available() -> bool:
    d = local_model_dir()
    if not d.exists():
        return False
    return (d / "model.int8.onnx").exists() or (d / "model.onnx").exists()


def local_status() -> dict:
    d = local_model_dir()
    return {
        "available": local_available(),
        "dir": str(d),
        "ready": _recognizer is not None,
        "error": _load_error,
        "note": "SenseVoice-Small · 234M 参数 · 中英日韩粤",
    }


def _get_recognizer():
    global _recognizer, _load_error
    if _recognizer is not None:
        return _recognizer
    if not local_available():
        raise RuntimeError("本地 SenseVoice 模型未安装（见 README）")
    try:
        import sherpa_onnx
    except ImportError as exc:  # pragma: no cover
        _load_error = "未安装 sherpa-onnx，请执行 pip install sherpa-onnx"
        raise RuntimeError(_load_error) from exc

    d = local_model_dir()
    model_file = d / "model.int8.onnx"
    if not model_file.exists():
        model_file = d / "model.onnx"

    try:
        _recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(model_file),
            tokens=str(d / "tokens.txt"),
            num_threads=2,
            use_itn=True,      # 逆文本正则化：把「二零二五」转成「2025」
            debug=False,
            language="zh",
        )
        _load_error = None
    except Exception as exc:  # noqa: BLE001
        _load_error = f"模型加载失败：{exc}"
        raise RuntimeError(_load_error) from exc
    return _recognizer


def _read_wav_16k(path: Path) -> list[float]:
    """sherpa-onnx 只吃 16k 单声道 float32，这里做一次简单校验。"""
    with wave.open(str(path), "rb") as w:
        if w.getnchannels() != 1 or w.getframerate() != 16000 or w.getsampwidth() != 2:
            raise RuntimeError("音频需要是 16kHz 单声道 16bit，请用 ffmpeg 先转码")
        frames = w.readframes(w.getnframes())
    import array

    pcm = array.array("h")
    pcm.frombytes(frames)
    return [s / 32768.0 for s in pcm]


def _transcribe_local_sync(wav_path: Path) -> str:
    recognizer = _get_recognizer()
    samples = _read_wav_16k(wav_path)
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, samples)
    recognizer.decode_stream(stream)
    return (stream.result.text or "").strip()


async def transcribe_local(wav_path: Path) -> dict:
    started = time.perf_counter()
    text = await asyncio.to_thread(_transcribe_local_sync, wav_path)
    return {
        "text": text,
        "engine": "local",
        "engine_label": "SenseVoice-Small (本地)",
        "ms": int((time.perf_counter() - started) * 1000),
    }


# ---------------------------------------------------------------- 云端引擎


async def transcribe_mimo(client, wav_bytes: bytes, api_key: str, language: str = "zh") -> dict:
    started = time.perf_counter()
    text = await client.transcribe(wav_bytes, api_key, language=language, fmt="wav")
    return {
        "text": text,
        "engine": "mimo",
        "engine_label": "MiMo ASR (云端)",
        "ms": int((time.perf_counter() - started) * 1000),
    }
