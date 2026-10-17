"""三模型冒烟测试 —— 在写界面之前先确认真实接口行为。

用法：
    set MIMO_API_KEY=sk-xxx
    .venv\\Scripts\\python.exe scripts\\smoke_test.py
    .venv\\Scripts\\python.exe scripts\\smoke_test.py --sample D:\\some\\voice.mp3

它会依次验证：
1. mimo-v2.5-tts 非流式（wav）
2. mimo-v2.5-tts 流式（pcm16，记录首包耗时）
3. mimo-v2.5-tts-voicedesign（带 assistant 文本）
4. mimo-v2.5-tts-voicedesign + optimize_text_preview（不带 assistant）
5. mimo-v2.5-tts-voiceclone（样本 data-url，依次尝试两种字段位置）
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import config  # noqa: E402
import mimo_client  # noqa: E402

OUT = ROOT / "data" / "smoke"
OUT.mkdir(parents=True, exist_ok=True)

RESET = "\033[0m"
GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
DIM = "\033[2m"


def log(ok: bool, title: str, extra: str = "") -> None:
    mark = f"{GREEN}PASS{RESET}" if ok else f"{RED}FAIL{RESET}"
    print(f"[{mark}] {title}" + (f"  {DIM}{extra}{RESET}" if extra else ""))


def err_text(resp: httpx.Response) -> str:
    try:
        data = resp.json()
        err = data.get("error") if isinstance(data, dict) else None
        if isinstance(err, dict):
            return str(err.get("message") or err)[:300]
        return json.dumps(data, ensure_ascii=False)[:300]
    except Exception:
        return resp.text[:300]


def request(client: httpx.Client, key: str, payload: dict) -> httpx.Response:
    return client.post(
        "/chat/completions",
        json=payload,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )


def pick_audio(payload: dict) -> str | None:
    try:
        message = payload["choices"][0]["message"]
    except Exception:
        return None
    audio = message.get("audio") if isinstance(message, dict) else None
    return audio.get("data") if isinstance(audio, dict) else None


def test_non_stream(client: httpx.Client, key: str) -> bool:
    payload = mimo_client.build_payload(
        model="mimo-v2.5-tts",
        text="(温柔)你好，这是一次冒烟测试。",
        instruction="自然、亲和。",
        voice="冰糖",
        stream=False,
    )
    started = time.perf_counter()
    resp = request(client, key, payload)
    cost = int((time.perf_counter() - started) * 1000)
    if resp.status_code >= 400:
        log(False, "tts 非流式", f"HTTP {resp.status_code} · {err_text(resp)}")
        return False
    b64 = pick_audio(resp.json())
    if not b64:
        log(False, "tts 非流式", "200 但 choices[0].message.audio.data 为空")
        print(f"  {DIM}原始响应前 400 字：{resp.text[:400]}{RESET}")
        return False
    data = base64.b64decode(b64)
    path = OUT / "tts_once.wav"
    path.write_bytes(data)
    log(True, "tts 非流式", f"{len(data)} bytes · {cost}ms · {path.name}（RIFF={data[:4] == b'RIFF'}）")
    return True


def test_stream(client: httpx.Client, key: str) -> bool:
    payload = mimo_client.build_payload(
        model="mimo-v2.5-tts",
        text="(活泼)流式测试，一二三四五六七八九十。",
        instruction="",
        voice="冰糖",
        stream=True,
    )
    payload["stream"] = True
    started = time.perf_counter()
    first_ms = None
    total = 0
    chunks = 0
    try:
        with client.stream(
            "POST",
            "/chat/completions",
            json=payload,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            timeout=httpx.Timeout(connect=10, read=180, write=30),
        ) as resp:
            if resp.status_code >= 400:
                body = resp.read().decode("utf-8", "replace")
                log(False, "tts 流式", f"HTTP {resp.status_code} · {body[:200]}")
                return False
            for line in resp.iter_lines():
                if not line or not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if not raw or raw == "[DONE]":
                    continue
                try:
                    data = json.loads(raw)
                except Exception:
                    continue
                delta = (data.get("choices") or [{}])[0].get("delta") or {}
                audio = delta.get("audio")
                b64 = audio.get("data") if isinstance(audio, dict) else None
                if b64:
                    if first_ms is None:
                        first_ms = int((time.perf_counter() - started) * 1000)
                    total += len(base64.b64decode(b64))
                    chunks += 1
    except Exception as exc:  # noqa: BLE001
        log(False, "tts 流式", f"{exc}")
        return False

    if not chunks:
        log(False, "tts 流式", "没有收到任何音频 delta")
        return False
    log(True, "tts 流式", f"{chunks} 块 · {total} bytes · 首包 {first_ms}ms · 约 {total / 2 / 24000:.2f}s")
    return True


def test_design(client: httpx.Client, key: str, optimize: bool) -> bool:
    payload = mimo_client.build_payload(
        model="mimo-v2.5-tts-voicedesign",
        text="" if optimize else "今天辛苦了，把手机放下，闭上眼睛。",
        instruction="二十多岁的年轻女性，丝滑醇厚，温柔治愈，语速缓慢沉稳。",
        stream=False,
        optimize_text_preview=optimize,
    )
    title = "voicedesign " + ("+ optimize_text_preview（无 assistant）" if optimize else "（带 assistant 文本）")
    resp = request(client, key, payload)
    if resp.status_code >= 400:
        log(False, title, f"HTTP {resp.status_code} · {err_text(resp)}")
        return False
    data = resp.json()
    b64 = pick_audio(data)
    if not b64:
        log(False, title, "无音频返回")
        return False
    audio = base64.b64decode(b64)
    name = "design_opt.wav" if optimize else "design.wav"
    (OUT / name).write_bytes(audio)
    text = ""
    try:
        text = (data["choices"][0]["message"].get("content") or "")[:40]
    except Exception:
        pass
    log(True, title, f"{len(audio)} bytes" + (f" · 模型文本「{text}」" if text else ""))
    return True


def test_clone(client: httpx.Client, key: str, sample: Path) -> bool:
    ext = sample.suffix.lower()
    mime = config.MIME_BY_EXT.get(ext, "audio/mpeg")
    b64 = base64.b64encode(sample.read_bytes()).decode("ascii")
    data_url = f"data:{mime};base64,{b64}"
    print(f"  {DIM}样本 {sample.name} · 原始 {len(b64) // 1024}KB(base64){RESET}")

    variants = [
        ("audio.voice", {"format": "wav", "voice": data_url}),
        ("audio.sample", {"format": "wav", "sample": data_url}),
        ("audio.voice_audio", {"format": "wav", "voice_audio": data_url}),
    ]
    for label, audio_block in variants:
        payload = {
            "model": "mimo-v2.5-tts-voiceclone",
            "messages": [{"role": "assistant", "content": "你好，这是音色复刻的冒烟测试。"}],
            "audio": audio_block,
        }
        resp = request(client, key, payload)
        if resp.status_code >= 400:
            log(False, f"voiceclone 字段 {label}", f"HTTP {resp.status_code} · {err_text(resp)}")
            continue
        got = pick_audio(resp.json())
        if not got:
            log(False, f"voiceclone 字段 {label}", "200 但无音频")
            continue
        audio = base64.b64decode(got)
        (OUT / "clone.wav").write_bytes(audio)
        log(True, f"voiceclone 字段 {label} 可用", f"{len(audio)} bytes")
        return True
    return False


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--key", default=os.environ.get("MIMO_API_KEY", ""))
    parser.add_argument("--sample", default="", help="用于复刻测试的 mp3/wav 路径")
    parser.add_argument("--only", default="", help="只跑某几项：once,stream,design,clone")
    args = parser.parse_args()

    mimo_client.load_dotenv()
    key = (args.key or mimo_client.env_api_key()).strip()
    if not key:
        print(f"{YELLOW}没有找到 API Key{RESET}")
        print("  set MIMO_API_KEY=sk-xxx   然后重跑，或  --key sk-xxx")
        return

    print(f"接口 {config.BASE_URL}")
    print(f"输出 {OUT}")
    print("-" * 58)

    only = {x.strip() for x in args.only.split(",") if x.strip()}
    results: dict[str, bool] = {}

    with httpx.Client(base_url=config.BASE_URL, timeout=httpx.Timeout(connect=10, read=180, write=30)) as client:
        if not only or "once" in only:
            results["tts 非流式"] = test_non_stream(client, key)
        if not only or "stream" in only:
            results["tts 流式"] = test_stream(client, key)
        if not only or "design" in only:
            results["voicedesign"] = test_design(client, key, optimize=False)
            results["voicedesign+润色"] = test_design(client, key, optimize=True)
        if not only or "clone" in only:
            if args.sample:
                sample = Path(args.sample)
                if sample.exists():
                    results["voiceclone"] = test_clone(client, key, sample)
                else:
                    print(f"{YELLOW}样本不存在：{sample}{RESET}")
            else:
                print(f"{DIM}跳过 voiceclone（没有 --sample 指定 mp3/wav）{RESET}")

    print("-" * 58)
    passed = sum(1 for v in results.values() if v)
    print(f"通过 {passed}/{len(results)}")


if __name__ == "__main__":
    main()
