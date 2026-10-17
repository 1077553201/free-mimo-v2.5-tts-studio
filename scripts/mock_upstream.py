"""本地 mock 上游 —— 不消耗任何配额就能联调整条链路。

它假装成 MiMo 的 /v1/chat/completions：
- 非流式：返回一段 320Hz 正弦波（wav，base64 放在 choices[0].message.audio.data）
- 流式：把正弦波切成 12 块，按 PCM16/24k 逐块 SSE 吐出

用法（两个终端）：
    .venv\\Scripts\\python.exe scripts\\mock_upstream.py
    set MIMO_BASE_URL=http://127.0.0.1:8899/v1
    set MIMO_API_KEY=mock
    .venv\\Scripts\\python.exe run.py --port 8001

然后打开 http://127.0.0.1:8001 随便填个 key 就能看到完整的生成流程。
"""

from __future__ import annotations

import base64
import io
import json
import math
import struct
import sys
import time
import wave
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

SR = 24000

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def tone(seconds: float = 2.4, freq: float = 320.0) -> bytes:
    """带淡入淡出的正弦波，避免首尾爆音。"""
    n = int(SR * seconds)
    out = bytearray()
    for i in range(n):
        env = min(1.0, i / 2000.0, (n - i) / 2000.0)
        # 加一点泛音，听起来不那么像测试音
        value = 0.6 * math.sin(2 * math.pi * freq * i / SR) + 0.18 * math.sin(2 * math.pi * freq * 2 * i / SR)
        out += struct.pack("<h", int(11000 * env * value))
    return bytes(out)


def to_wav(pcm: bytes) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm)
    return buf.getvalue()


app = FastAPI(title="mock upstream")


@app.get("/v1/models")
async def models() -> dict:
    return {"data": [{"id": "mimo-v2.5-tts"}, {"id": "mimo-v2.5-tts-voicedesign"}, {"id": "mimo-v2.5-tts-voiceclone"}]}


@app.post("/v1/chat/completions")
async def chat(request: Request):
    body = await request.json()
    text = ""
    for msg in body.get("messages", []):
        if msg.get("role") == "assistant":
            text = msg.get("content") or ""

    # 文本越长，假装生成的音频越长（1 秒 / 8 字，封顶 6 秒）
    seconds = max(1.2, min(6.0, len(text) / 8.0))
    pcm = tone(seconds=seconds)
    model = body.get("model", "")

    if body.get("stream"):
        def gen():
            yield 'data: {"choices":[{"delta":{"content":"（mock）正在合成…"}}]}\n\n'
            step = max(2, len(pcm) // 12)
            for i in range(0, len(pcm), step):
                chunk = pcm[i:i + step]
                payload = {
                    "choices": [{
                        "delta": {"audio": {"data": base64.b64encode(chunk).decode()}},
                        "finish_reason": None,
                    }]
                }
                yield "data: " + json.dumps(payload) + "\n\n"
                time.sleep(0.07)
            yield 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":42}}\n\n'
            yield "data: [DONE]\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream")

    audio = base64.b64encode(to_wav(pcm)).decode()
    return JSONResponse({
        "id": "mock-1",
        "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "", "audio": {"data": audio, "format": "wav"}},
            "finish_reason": "stop",
        }],
        "usage": {"total_tokens": 42},
    })


if __name__ == "__main__":
    print("mock upstream → http://127.0.0.1:8899/v1")
    uvicorn.run(app, host="127.0.0.1", port=8899, log_level="warning")
