#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""音频工具：RIFF 解析、PCM→WAV、跨块拼装。

只依赖标准库。这里的每个函数都被 tests/test_core.py 直接单测，
不联网、不需要 Key。
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

SAMPLE_RATE = 24000
CHANNELS = 1
SAMPLE_WIDTH = 2  # 16-bit


class AudioError(Exception):
    """上游返回的音频不符合预期（不是 RIFF、采样率不对、缺少 data 等）。"""


@dataclass
class WavInfo:
    sample_rate: int
    channels: int
    sample_width: int
    pcm: bytes

    @property
    def frames(self) -> int:
        return len(self.pcm) // (self.channels * self.sample_width)


class PcmAssembler:
    """把流式 SSE 里一段段 base64 解出来的 PCM 拼起来。

    上游每块长度不保证是偶数，多出来的 1 字节必须留到下一块，
    否则从那一块开始所有样本错位半个采样 -> 听感是噪声/爆音。
    """

    def __init__(self) -> None:
        self._carry = b""
        self.dropped = 0

    def feed(self, chunk: bytes) -> bytes:
        data = self._carry + chunk
        usable = len(data) - (len(data) % 2)
        self._carry = data[usable:]
        return data[:usable]

    def finish(self) -> bytes:
        self.dropped += len(self._carry)
        self._carry = b""
        return b""


def _parse_fmt(body: bytes) -> tuple[int, int, int, int]:
    """解析 fmt chunk，返回 (格式标签, 声道数, 采样率, 位深)。"""
    if len(body) < 16:
        raise AudioError("WAV 的 fmt chunk 长度不足")
    tag, channels, rate, _byte_rate, _block_align, bits = struct.unpack_from("<HHIIHH", body, 0)

    # WAVE_FORMAT_EXTENSIBLE：真实格式在 SubFormat GUID 的前 2 字节
    if tag == 0xFFFE:
        if len(body) < 40:
            raise AudioError("WAVE_FORMAT_EXTENSIBLE 的 fmt chunk 不完整")
        tag = struct.unpack_from("<H", body, 24)[0]

    if channels <= 0:
        raise AudioError("WAV 声道数异常：%d" % channels)
    if rate <= 0:
        raise AudioError("WAV 采样率异常：%d" % rate)
    return tag, channels, rate, bits


def _to_int16(pcm: bytes, tag: int, channels: int, bits: int) -> bytes:
    """把任意 PCM/浮点样本统一成单声道 int16 小端。"""
    if tag == 1:  # PCM
        if bits == 8:  # 8-bit 是无符号，需要减 128
            samples = [(b - 128) << 8 for b in pcm]
        elif bits == 16:
            body = pcm[: len(pcm) - (len(pcm) % 2)]
            if channels == 1:
                return body
            frames = len(body) // (2 * channels)
            out = bytearray(frames * 2)
            for f in range(frames):
                total = 0
                base = f * 2 * channels
                for c in range(channels):
                    total += struct.unpack_from("<h", body, base + c * 2)[0]
                struct.pack_into("<h", out, f * 2, int(total / channels))
            return bytes(out)
        elif bits == 24:
            frames = len(pcm) // (3 * channels)
            out = bytearray(frames * 2)
            for f in range(frames):
                total = 0
                for c in range(channels):
                    off = (f * channels + c) * 3
                    v = pcm[off] | (pcm[off + 1] << 8) | (pcm[off + 2] << 16)
                    if v & 0x800000:
                        v -= 0x1000000
                    total += v >> 8
                struct.pack_into("<h", out, f * 2, max(-32768, min(32767, int(total / channels))))
            return bytes(out)
        elif bits == 32:
            frames = len(pcm) // (4 * channels)
            out = bytearray(frames * 2)
            for f in range(frames):
                total = 0
                for c in range(channels):
                    v = struct.unpack_from("<i", pcm, (f * channels + c) * 4)[0]
                    total += v >> 16
                struct.pack_into("<h", out, f * 2, max(-32768, min(32767, int(total / channels))))
            return bytes(out)
        else:
            raise AudioError("不支持的 PCM 位深：%d" % bits)

    if tag == 3:  # IEEE float
        fmt_char = "f" if bits == 32 else ("d" if bits == 64 else None)
        if fmt_char is None:
            raise AudioError("不支持的浮点位深：%d" % bits)
        size = bits // 8
        frames = len(pcm) // (size * channels)
        out = bytearray(frames * 2)
        for f in range(frames):
            total = 0.0
            for c in range(channels):
                total += struct.unpack_from("<" + fmt_char, pcm, (f * channels + c) * size)[0]
            v = max(-1.0, min(1.0, total / channels))
            struct.pack_into("<h", out, f * 2, int(v * 32767))
        return bytes(out)

    raise AudioError("不支持的音频格式标签：0x%04X" % tag)


def parse_wav(data: bytes, expect_rate: int = SAMPLE_RATE) -> WavInfo:
    """按 RIFF chunk 遍历解析 WAV。

    不能假定 44 字节头：上游可能带 LIST/JUNK，可能有多个 data，
    奇数长度的 chunk 后面还会有 1 字节对齐填充。
    """
    if len(data) < 12 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise AudioError("返回的数据不是 RIFF/WAVE")

    fmt = None
    datas: list[bytes] = []
    off = 12
    total = len(data)

    while off + 8 <= total:
        cid = data[off : off + 4]
        size = struct.unpack_from("<I", data, off + 4)[0]
        body_off = off + 8
        avail = total - body_off
        if size == 0xFFFFFFFF or size > avail:  # 流式 WAV 常见，按剩余长度截断
            size = avail
        body = data[body_off : body_off + size]
        if cid == b"fmt ":
            fmt = _parse_fmt(body)
        elif cid == b"data":
            datas.append(body)
        off = body_off + size + (size & 1)

    if fmt is None:
        raise AudioError("WAV 缺少 fmt chunk")
    if not datas:
        raise AudioError("WAV 缺少 data chunk")

    tag, channels, rate, bits = fmt
    if rate != expect_rate:
        raise AudioError(
            "采样率是 %d Hz，预期 %d Hz（本工具不做重采样）" % (rate, expect_rate)
        )

    pcm = _to_int16(b"".join(datas), tag, channels, bits)
    # 尾巴不完整的帧丢掉
    frame = 2
    pcm = pcm[: len(pcm) - (len(pcm) % frame)]
    return WavInfo(sample_rate=rate, channels=1, sample_width=2, pcm=pcm)


def silence(ms: int, sample_rate: int = SAMPLE_RATE) -> bytes:
    if ms <= 0:
        return b""
    return b"\x00\x00" * int(sample_rate * ms / 1000)


def duration(pcm_bytes: int | bytes, sample_rate: int = SAMPLE_RATE) -> float:
    n = pcm_bytes if isinstance(pcm_bytes, int) else len(pcm_bytes)
    return n / (sample_rate * CHANNELS * SAMPLE_WIDTH)


def make_wav(pcm_parts: list[bytes], sample_rate: int = SAMPLE_RATE) -> bytes:
    """把若干段单声道 int16 PCM 拼成一个完整 WAV（只写一个头）。"""
    pcm = b"".join(pcm_parts)
    pcm = pcm[: len(pcm) - (len(pcm) % 2)]
    byte_rate = sample_rate * CHANNELS * SAMPLE_WIDTH
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + len(pcm),
        b"WAVE",
        b"fmt ",
        16,
        1,
        CHANNELS,
        sample_rate,
        byte_rate,
        CHANNELS * SAMPLE_WIDTH,
        SAMPLE_WIDTH * 8,
        b"data",
        len(pcm),
    )
    return header + pcm


def write_wav(path: str, pcm_parts: list[bytes], sample_rate: int = SAMPLE_RATE) -> dict:
    blob = make_wav(pcm_parts, sample_rate)
    with open(path, "wb") as fh:
        fh.write(blob)
    return {
        "bytes": len(blob),
        "pcm_bytes": len(blob) - 44,
        "duration_sec": round((len(blob) - 44) / (sample_rate * CHANNELS * SAMPLE_WIDTH), 6),
        "sample_rate": sample_rate,
        "channels": CHANNELS,
        "sample_width": SAMPLE_WIDTH,
    }
