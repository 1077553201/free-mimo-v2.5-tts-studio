#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MiMo TTS 命令行：把多段文字合成语音并按原顺序拼接成一个 WAV。

子命令：
  synth    合成并写出 wav（默认）
  plan     只做校验/切分/payload 预演，不联网、不需要 Key
  voices   列出预置音色
  presets  列出风格预设
  tags     列出开场/行内标签

示例：
  python mimo_tts.py plan --text "第一段。" --text @part2.txt --voice 冰糖
  python mimo_tts.py synth --text "你好。" --voice 茉莉 --out out.wav
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.dirname(HERE)
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import mimo_audio  # noqa: E402
import mimo_client  # noqa: E402
from mimo_client import (  # noqa: E402
    MODEL_CLONE,
    MODEL_DESIGN,
    MODEL_PRESET,
    MODELS,
    TtsError,
    build_payload,
    redact_payload,
    resolve_credentials,
    sample_to_data_url,
    synthesize,
)

CATALOG_PATH = os.path.join(SKILL_DIR, "assets", "catalog.json")

LEAD_GROUP = re.compile(r"^\s*([(（【\[])\s*([^)）】\]]{1,24})\s*([)）】\]])")
ANY_GROUP = re.compile(r"([（(【\[])([^）)】\]]{1,24})([）)】\]])")
SINGING_TAG = re.compile(r"^(唱歌|sing|singing)$", re.I)

HARD_BREAK = set("。！？!?；;…\n")
SOFT_BREAK = set("，,、：:")
CLOSE_QUOTE = set("”’」』\"'")
PAIRS = {"(": ")", "（": "）", "【": "】", "[": "]", "《": "》"}
CLOSERS = set(PAIRS.values())

MIN_MERGE_CHARS = 24


# --------------------------------------------------------------------- 词表


def load_catalog() -> dict:
    with open(CATALOG_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)


def inline_tag_set(catalog: dict) -> set:
    words = set()
    for group in catalog.get("inline_tags", []):
        for tag in group.get("tags", []):
            words.add(tag)
    return words


def voice_table(catalog: dict) -> dict:
    table = {}
    for v in catalog.get("voices", []):
        table[v["id"]] = v
        table.setdefault(v.get("label", v["id"]), v)
    return table


def preset_table(catalog: dict) -> dict:
    return {p["label"]: p["text"] for p in catalog.get("style_presets", [])}


# --------------------------------------------------------------------- 文本规则


def _is_inline_group(content: str, inline_set: set) -> bool:
    parts = [p for p in re.split(r"[，,、\s]+", content or "") if p]
    if not parts:
        return False
    return all(p in inline_set for p in parts)


def normalize_text(raw: str, *, model: str, singing: bool, opening_tags: list, inline_set: set):
    """返回 (前缀, 正文)。规则对齐站点 static/ui-state.js 的 finalAssistant()。"""
    raw = (raw or "").strip()
    if model == MODEL_DESIGN:
        return "", raw

    lead = LEAD_GROUP.match(raw)
    lead_inner = lead.group(2).strip() if lead else ""
    lead_is_inline = _is_inline_group(lead_inner, inline_set) if lead_inner else False

    if singing:
        body = raw
        if lead and SINGING_TAG.fullmatch(lead_inner):
            body = raw[lead.end():]
        body = ANY_GROUP.sub(" ", body)
        body = re.sub(r"\s{2,}", " ", body).strip()
        return "(唱歌)", body

    prefix = ""
    rest = raw
    if lead and not lead_is_inline:
        prefix = raw[lead.start():lead.end()].strip()
        rest = raw[lead.end():]

    def repl(m):
        inner = m.group(2).strip()
        return "[%s]" % inner if _is_inline_group(inner, inline_set) else m.group(0)

    rest = ANY_GROUP.sub(repl, rest)

    if not prefix and opening_tags:
        prefix = "(" + " ".join(opening_tags) + ")"

    while prefix and rest.startswith(prefix):
        rest = rest[len(prefix):].lstrip()

    return prefix, rest.strip()


def _is_hard_break(text: str, i: int) -> bool:
    ch = text[i]
    if ch in HARD_BREAK:
        return True
    if ch == ".":  # 英文句号：后面是空白或结尾，且前面不是数字
        nxt = text[i + 1] if i + 1 < len(text) else ""
        prev = text[i - 1] if i > 0 else ""
        return (not nxt or nxt.isspace()) and not prev.isdigit()
    return False


def _safe_cut(s: str, limit: int) -> int:
    """在 limit 附近找一个不破坏括号组的切点。"""
    depth = 0
    last_soft = -1
    first_safe_after = -1
    i = 0
    n = len(s)
    while i < n:
        ch = s[i]
        if ch in PAIRS:
            depth += 1
        elif ch in CLOSERS and depth > 0:
            depth -= 1
        else:
            if depth == 0:
                if ch in SOFT_BREAK and i + 1 <= limit:
                    last_soft = i + 1
                if first_safe_after < 0 and i >= limit:
                    first_safe_after = i
        i += 1
        if last_soft >= 0 and i > limit and first_safe_after >= 0:
            break

    floor = max(8, limit // 3)
    if last_soft >= floor:
        return last_soft
    if first_safe_after > 0:
        return first_safe_after
    return min(limit, n) or n


def split_text(text: str, max_chars: int = 400) -> list:
    """先按句末标点切，再把超长句在软标点处切开；括号组内部绝不切。"""
    text = text or ""
    pieces: list = []
    depth = 0
    start = 0
    i = 0
    n = len(text)

    while i < n:
        ch = text[i]
        if ch in PAIRS:
            depth += 1
        elif ch in CLOSERS and depth > 0:
            depth -= 1
        elif depth == 0 and _is_hard_break(text, i):
            j = i + 1
            while j < n and (text[j] in HARD_BREAK or text[j] in CLOSE_QUOTE):
                j += 1
            pieces.append(text[start:j])
            start = j
            i = j
            continue
        i += 1
    if start < n:
        pieces.append(text[start:])

    # 超长句二次切分
    split_pieces: list = []
    for piece in pieces:
        piece = piece.strip()
        while len(piece) > max_chars:
            cut = _safe_cut(piece, max_chars)
            if cut <= 0:
                cut = max_chars
            split_pieces.append(piece[:cut].strip())
            piece = piece[cut:].strip()
        if piece:
            split_pieces.append(piece)

    # 太短的与下一句合并，减少请求数
    merged: list = []
    for piece in split_pieces:
        if (
            merged
            and len(merged[-1]) < MIN_MERGE_CHARS
            and len(merged[-1]) + len(piece) <= max_chars
        ):
            merged[-1] += piece
        else:
            merged.append(piece)

    # 段尾若是完整标签，挪到下一段开头
    for i in range(len(merged) - 1):
        m = re.search(r"(\[[^\[\]]{1,24}\]|[（(【][^）)】]{1,24}[）)】])\s*$", merged[i])
        if m and m.start() > 0:
            merged[i + 1] = m.group(1) + merged[i + 1]
            merged[i] = merged[i][: m.start()].rstrip()

    return [p for p in merged if p]


def read_text_values(values: list) -> list:
    """把 --text 的值展开：@file 读文件、@- 读 stdin、@@ 转义。"""
    out = []
    for value in values or []:
        if value == "@-":
            out.append(sys.stdin.read())
        elif value.startswith("@@"):
            out.append(value[1:])
        elif value.startswith("@"):
            path = value[1:]
            if not os.path.isfile(path):
                raise TtsError("usage", "文本文件不存在：%s" % path)
            with open(path, "r", encoding="utf-8-sig") as fh:
                out.append(fh.read())
        else:
            out.append(value)
    return out


# --------------------------------------------------------------------- CLI


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="mimo_tts",
        description="MiMo TTS：多段文字按顺序合成并拼接成一个 WAV",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("command", nargs="?", default="synth",
                   choices=["synth", "plan", "voices", "presets", "tags"])
    p.add_argument("--text", action="append", default=[], metavar="TEXT",
                   help="要合成的文本，可重复；@file 读文件，@- 读 stdin")

    p.add_argument("--model", default=MODEL_PRESET)
    p.add_argument("--voice", default=None, help="预置音色 id 或名称，默认 mimo_default")
    p.add_argument("--voice-desc", default="", help="音色设计：音色描述（必填）")
    p.add_argument("--voice-sample", default=None, help="音色复刻：本地样本音频路径")
    p.add_argument("--preset", default=None, help="风格预设名称，见 presets 子命令")
    p.add_argument("--instruction", default="", help="自定义风格指令（与 --preset 互斥）")
    p.add_argument("--opening-tag", action="append", default=[],
                   help="开场风格标签，可重复或逗号分隔")
    p.add_argument("--singing", action="store_true", help="唱歌模式（仅预置模型）")
    p.add_argument("--optimize-preview", dest="optimize", action="store_true", default=None)
    p.add_argument("--no-optimize-preview", dest="optimize", action="store_false")

    p.add_argument("--max-chars", type=int, default=400)
    p.add_argument("--no-split", action="store_true")
    p.add_argument("--concurrency", type=int, default=3)
    p.add_argument("--gap-ms", type=int, default=0)

    p.add_argument("--out", default=None)
    p.add_argument("--timeout", type=float, default=180.0)
    p.add_argument("--retries", type=int, default=2)
    p.add_argument("--env-file", default=None)
    p.add_argument("--base-url", default=None)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--quiet", action="store_true")
    p.add_argument("--compact", action="store_true")
    return p


def log(msg: str, quiet: bool = False) -> None:
    if not quiet:
        print(msg, file=sys.stderr, flush=True)


def emit(obj: dict, compact: bool) -> None:
    print(json.dumps(obj, ensure_ascii=False, separators=(",", ":") if compact else None,
                     indent=None if compact else 2))


def pick_voice(args, catalog, warnings):
    table = voice_table(catalog)
    name = (args.voice or "mimo_default").strip()
    if name not in table:
        known = "、".join(v["id"] for v in catalog["voices"])
        raise TtsError("usage", "未知音色 %s，可选：%s" % (name, known))
    return table[name]["id"]


def pick_instruction(args, catalog):
    if args.preset and args.instruction.strip():
        raise TtsError("usage", "--preset 与 --instruction 互斥")
    if args.preset:
        table = preset_table(catalog)
        if args.preset not in table:
            raise TtsError("usage", "未知预设 %s，可选：%s" % (args.preset, "、".join(table)))
        return table[args.preset]
    return args.instruction.strip()


def pick_opening_tags(args, catalog, warnings):
    if not args.opening_tag:
        return []
    valid = set()
    for group in catalog.get("opening_tags", []):
        for tag in group.get("tags", []):
            valid.add(tag)
    tags = []
    for raw in args.opening_tag:
        for part in re.split(r"[,，、\s]+", raw):
            part = part.strip()
            if not part:
                continue
            if part not in valid:
                raise TtsError("usage", "未知开场标签 %s（见 tags 子命令）" % part)
            if part not in tags:
                tags.append(part)
    return tags


def validate(args, warnings):
    if args.model not in MODELS:
        raise TtsError("usage", "未知模型 %s，可选：%s" % (args.model, "、".join(MODELS)))
    if args.max_chars < 40:
        raise TtsError("usage", "--max-chars 至少 40")
    if args.concurrency < 1:
        raise TtsError("usage", "--concurrency 至少 1")

    if args.model == MODEL_DESIGN:
        if not args.voice_desc.strip():
            raise TtsError("usage", "音色设计需要 --voice-desc")
        for name, value in (("--voice", args.voice), ("--voice-sample", args.voice_sample)):
            if value:
                raise TtsError("usage", "音色设计不支持 %s" % name)
        if args.singing:
            raise TtsError("usage", "音色设计不支持唱歌")
        if args.preset or args.instruction.strip():
            raise TtsError("usage", "音色设计的风格由 --voice-desc 决定，不要传风格指令")
        if args.opening_tag:
            raise TtsError("usage", "音色设计不支持开场标签")
    elif args.model == MODEL_CLONE:
        if not args.voice_sample:
            raise TtsError("usage", "音色复刻需要 --voice-sample")
        if args.voice:
            raise TtsError("usage", "音色复刻不使用 --voice（音色来自样本）")
        if args.voice_desc:
            raise TtsError("usage", "音色复刻不使用 --voice-desc")
        if args.singing:
            raise TtsError("usage", "音色复刻不支持唱歌")
        if args.optimize is not None:
            raise TtsError("usage", "只有音色设计支持 --optimize-preview")
    else:
        if args.voice_desc:
            raise TtsError("usage", "预置音色不使用 --voice-desc")
        if args.voice_sample:
            raise TtsError("usage", "预置音色不使用 --voice-sample")
        if args.optimize is not None:
            raise TtsError("usage", "只有音色设计支持 --optimize-preview")
        if args.singing and args.opening_tag:
            raise TtsError("usage", "--singing 与 --opening-tag 互斥")

    if args.singing and args.model != MODEL_PRESET:
        raise TtsError("usage", "只有预置音色模型支持唱歌")


def make_chunks(args, catalog, texts):
    warnings = []
    inline_set = inline_tag_set(catalog)
    opening_tags = pick_opening_tags(args, catalog, warnings)

    chunks = []
    for si, raw in enumerate(texts):
        prefix, body = normalize_text(
            raw, model=args.model, singing=args.singing,
            opening_tags=opening_tags, inline_set=inline_set,
        )
        if args.model == MODEL_DESIGN:
            bodies = [body]
        elif args.no_split:
            bodies = [body] if body else []
        else:
            budget = max(40, args.max_chars - len(prefix))
            bodies = split_text(body, budget)

        for ci, piece in enumerate(bodies):
            text = (prefix + piece).strip()
            if not text:
                continue
            chunks.append({
                "index": len(chunks),
                "segment": si,
                "chunk": ci,
                "text": text,
                "chars": len(text),
            })

    if args.singing and opening_tags:
        warnings.append("唱歌模式会忽略开场标签")

    return chunks, warnings


def attach_payloads(chunks, args, catalog, sample_data_url):
    instruction = pick_instruction(args, catalog)
    voice = None
    if args.model == MODEL_PRESET:
        voice = pick_voice(args, catalog, [])

    for chunk in chunks:
        chunk["payload"] = build_payload(
            model=args.model,
            text=chunk["text"],
            instruction=args.voice_desc.strip() if args.model == MODEL_DESIGN else instruction,
            voice=voice,
            sample_data_url=sample_data_url,
            optimize=args.optimize if args.model == MODEL_DESIGN else None,
        )


def run_synth(chunks, args, key, base_url, quiet):
    results = [None] * len(chunks)

    def work(chunk):
        def on_retry(attempt, delay, exc):
            log("  第 %d 段第 %d 次失败（%s），%.0fs 后重试"
                % (chunk["index"] + 1, attempt, exc.message, delay), quiet)

        return synthesize(
            chunk["payload"], key=key, base_url=base_url,
            timeout=args.timeout, retries=args.retries, on_retry=on_retry,
        )

    started = time.perf_counter()
    errors = []
    with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as pool:
        futures = {pool.submit(work, c): c["index"] for c in chunks}
        for fut in as_completed(futures):
            idx = futures[fut]
            try:
                results[idx] = fut.result()
                r = results[idx]
                log("[%d/%d] seg%d/chunk%d %d 字 · %s · 音频 %.2fs"
                    % (idx + 1, len(chunks), chunks[idx]["segment"], chunks[idx]["chunk"],
                       chunks[idx]["chars"],
                       "%dms" % r.elapsed_ms,
                       mimo_audio.duration(len(r.pcm))), quiet)
            except TtsError as exc:
                errors.append((idx, exc))
                for f in futures:
                    f.cancel()
                break

    if errors:
        errors.sort(key=lambda x: x[0])
        idx, exc = errors[0]
        exc.message = "第 %d 段失败：%s" % (idx + 1, exc.message)
        raise exc

    elapsed = int((time.perf_counter() - started) * 1000)
    return results, elapsed


def cmd_catalog(command, args, catalog):
    if command == "voices":
        emit({"ok": True, "voices": catalog["voices"],
              "models": [{"id": m["id"], "short": m["short"], "caps": m["caps"]}
                         for m in catalog["models"]]}, args.compact)
    elif command == "presets":
        emit({"ok": True, "presets": catalog["style_presets"]}, args.compact)
    else:
        emit({"ok": True, "opening_tags": catalog["opening_tags"],
              "inline_tags": catalog["inline_tags"]}, args.compact)
    return 0


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    args = build_parser().parse_args(argv)
    if args.dry_run:
        args.command = "plan"

    try:
        catalog = load_catalog()
        if args.command in ("voices", "presets", "tags"):
            return cmd_catalog(args.command, args, catalog)

        warnings = []
        validate(args, warnings)

        raw_texts = read_text_values(args.text)
        if not raw_texts:
            raise TtsError("usage", "至少要给一个 --text")

        chunks, warn2 = make_chunks(args, catalog, raw_texts)
        warnings.extend(warn2)
        if not chunks:
            raise TtsError("usage", "没有可合成的文本")

        if args.model == MODEL_DESIGN and len(chunks) > 1:
            if args.optimize:
                raise TtsError("usage", "--optimize-preview 只能用于单段文本")
            warnings.append("音色设计分段是独立请求，音色可能有细微差异；建议 --no-split 或加大 --max-chars")

        sample_url = None
        if args.model == MODEL_CLONE:
            sample_url = sample_to_data_url(args.voice_sample)

        attach_payloads(chunks, args, catalog, sample_url)

        if args.command == "plan":
            emit({
                "ok": True,
                "dry_run": True,
                "model": args.model,
                "stream": args.model == MODEL_PRESET,
                "audio_format": "pcm16" if args.model == MODEL_PRESET else "wav",
                "text": {
                    "segments": len(raw_texts),
                    "chunks": len(chunks),
                    "chars": sum(c["chars"] for c in chunks),
                },
                "requests": [
                    {
                        "index": c["index"],
                        "segment": c["segment"],
                        "chunk": c["chunk"],
                        "chars": c["chars"],
                        "text_preview": c["text"][:60],
                        "payload": redact_payload(c["payload"]),
                    }
                    for c in chunks
                ],
                "warnings": warnings,
            }, args.compact)
            return 0

        key, base_url, env_path = resolve_credentials(args.env_file, args.base_url, SKILL_DIR)
        if not key:
            raise TtsError("auth", "没有找到 API Key：请设置环境变量 MIMO_API_KEY 或在 .env 里填写")

        out = args.out or ("mimo-tts-%s.wav" % time.strftime("%Y%m%d-%H%M%S"))
        if not out.lower().endswith(".wav"):
            out += ".wav"
        out_dir = os.path.dirname(os.path.abspath(out))
        if out_dir and not os.path.isdir(out_dir):
            os.makedirs(out_dir, exist_ok=True)

        log("mimo-tts: model=%s chunks=%d chars=%d concurrency=%d%s"
            % (args.model, len(chunks), sum(c["chars"] for c in chunks),
               args.concurrency, "" if env_path is None else " env=" + os.path.basename(env_path)),
            args.quiet)

        results, elapsed_ms = run_synth(chunks, args, key, base_url, args.quiet)

        parts = []
        for chunk, result in zip(chunks, results):
            parts.append(result.pcm)
            if args.gap_ms:
                parts.append(mimo_audio.silence(args.gap_ms))

        if args.gap_ms and parts:
            parts.pop()

        info = mimo_audio.write_wav(out, parts)

        emit({
            "ok": True,
            "command": "synth",
            "model": args.model,
            "stream": args.model == MODEL_PRESET,
            "voice": (chunks[0]["payload"]["audio"].get("voice")
                      if args.model != MODEL_CLONE else "<clone-sample>"),
            "base_url": base_url,
            "output": os.path.abspath(out),
            "wav": info,
            "text": {
                "segments": len(raw_texts),
                "chunks": len(chunks),
                "chars": sum(c["chars"] for c in chunks),
            },
            "timing": {
                "elapsed_ms": elapsed_ms,
                "first_audio_ms": next((r.first_audio_ms for r in results if r.first_audio_ms), None),
            },
            "parts": [
                {
                    "index": c["index"],
                    "segment": c["segment"],
                    "chunk": c["chunk"],
                    "chars": c["chars"],
                    "text_preview": c["text"][:40],
                    "elapsed_ms": r.elapsed_ms,
                    "audio_sec": round(mimo_audio.duration(len(r.pcm)), 6),
                    "attempts": r.attempts,
                }
                for c, r in zip(chunks, results)
            ],
            "warnings": warnings + [w for r in results for w in (r.warnings or [])],
        }, args.compact)

        log("mimo-tts: 已写出 %s（%.2fs，%s）"
            % (out, info["duration_sec"], "%.1fKB" % (info["bytes"] / 1024)), args.quiet)
        return 0

    except TtsError as exc:
        emit({"ok": False, "command": args.command, "error": exc.to_dict()}, args.compact)
        print("mimo-tts: %s" % exc.message, file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("mimo-tts: 已取消", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
