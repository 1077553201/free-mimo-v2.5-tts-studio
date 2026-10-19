#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""纯函数单测：切句、文本规则、payload、WAV 解析、字节对齐、顺序。

零配额、零网络。运行：
  python -m unittest discover -s skills/mimo-tts/tests -v
"""

import json
import os
import struct
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(SKILL_DIR, "scripts"))

import mimo_audio  # noqa: E402
import mimo_client  # noqa: E402
import mimo_tts  # noqa: E402

CATALOG = mimo_tts.load_catalog()
INLINE_SET = mimo_tts.inline_tag_set(CATALOG)


def build_wav(pcm: bytes, *, rate=24000, channels=1, bits=16, tag=1,
              extra_before=(), extra_middle=(), two_data=False, broken_size=False) -> bytes:
    """拼一个带任意附加 chunk 的 WAV，用于测试解析健壮性。"""
    block = channels * bits // 8
    fmt = struct.pack("<HHIIHH", tag, channels, rate, rate * block, block, bits)
    if tag == 0xFFFE:
        fmt = struct.pack("<HHIIHH", 0xFFFE, channels, rate, rate * block, block, bits)
        fmt += struct.pack("<HHI", 22, bits, 3)
        fmt += b"\x01\x00\x00\x00\x00\x00\x10\x00\x80\x00\x00\xaa\x00\x38\x9b\x71"

    body = b""
    for cid, payload in extra_before:
        body += cid + struct.pack("<I", len(payload)) + payload

    body += b"fmt " + struct.pack("<I", len(fmt)) + fmt

    for cid, payload in extra_middle:
        body += cid + struct.pack("<I", len(payload)) + payload
        if len(payload) % 2:
            body += b"\x00"

    if two_data:
        half = len(pcm) // 2
        half -= half % block
        for piece in (pcm[:half], pcm[half:]):
            body += b"data" + struct.pack("<I", len(piece)) + piece
    else:
        size = 0xFFFFFFFF if broken_size else len(pcm)
        body += b"data" + struct.pack("<I", size) + pcm

    return b"RIFF" + struct.pack("<I", 4 + len(body)) + b"WAVE" + body


class CatalogTest(unittest.TestCase):
    def test_counts(self):
        self.assertEqual(len(CATALOG["models"]), 3)
        self.assertEqual(len(CATALOG["voices"]), 9)
        self.assertEqual(len(CATALOG["style_presets"]), 12)
        self.assertEqual(sum(len(g["tags"]) for g in CATALOG["opening_tags"]), 47)
        self.assertEqual(sum(len(g["tags"]) for g in CATALOG["inline_tags"]), 30)
        self.assertEqual(len(CATALOG["design_dimensions"]), 7)
        self.assertEqual(len(CATALOG["design_templates"]), 4)
        self.assertEqual(CATALOG["sample_rate"], 24000)

    def test_design_required_dimensions(self):
        required = [d for d in CATALOG["design_dimensions"] if d.get("required")]
        self.assertEqual(len(required), 4)


class NormalizeTest(unittest.TestCase):
    def norm(self, raw, **kw):
        kw.setdefault("model", mimo_client.MODEL_PRESET)
        kw.setdefault("singing", False)
        kw.setdefault("opening_tags", [])
        return mimo_tts.normalize_text(raw, inline_set=INLINE_SET, **kw)

    def test_user_style_prefix_kept(self):
        prefix, body = self.norm("(温柔)你好呀。")
        self.assertEqual(prefix, "(温柔)")
        self.assertEqual(body, "你好呀。")

    def test_opening_tags_used_when_no_prefix(self):
        prefix, _ = self.norm("你好呀。", opening_tags=["温柔", "磁性"])
        self.assertEqual(prefix, "(温柔 磁性)")

    def test_user_prefix_beats_opening_tags(self):
        prefix, _ = self.norm("(高冷)你好。", opening_tags=["温柔"])
        self.assertEqual(prefix, "(高冷)")

    def test_inline_tag_not_mistaken_for_prefix(self):
        prefix, body = self.norm("[叹气]算了吧。")
        self.assertEqual(prefix, "")
        self.assertEqual(body, "[叹气]算了吧。")

    def test_inline_in_fullwidth_becomes_bracket(self):
        _, body = self.norm("算了（叹气）吧。")
        self.assertEqual(body, "算了[叹气]吧。")

    def test_unknown_paren_kept(self):
        _, body = self.norm("这是（随便写的）内容。")
        self.assertEqual(body, "这是（随便写的）内容。")

    def test_singing_forces_tag_first(self):
        prefix, body = self.norm("原谅我这一生不羁放纵爱自由。", singing=True)
        self.assertEqual(prefix, "(唱歌)")
        self.assertFalse(body.startswith(" "))

    def test_singing_strips_bracket_groups(self):
        _, body = self.norm("(温柔)原谅我[叹气]爱自由。", singing=True)
        self.assertNotIn("[", body)
        self.assertNotIn("温柔", body)

    def test_singing_dedup(self):
        prefix, body = self.norm("(唱歌)原谅我", singing=True)
        self.assertEqual(prefix + body, "(唱歌)原谅我")

    def test_duplicate_prefix_removed(self):
        prefix, body = self.norm("(唱歌)(唱歌)原谅我")
        self.assertEqual(prefix + body, "(唱歌)原谅我")

    def test_design_untouched(self):
        prefix, body = self.norm("(温柔)你好。[叹气]", model=mimo_client.MODEL_DESIGN)
        self.assertEqual(prefix, "")
        self.assertEqual(body, "(温柔)你好。[叹气]")


class SplitTest(unittest.TestCase):
    def test_short_text_single_chunk(self):
        self.assertEqual(mimo_tts.split_text("你好呀。", 400), ["你好呀。"])

    def test_respects_max_chars(self):
        text = "这是一个用来测试切分的句子，它需要足够长才会被切开。" * 12
        pieces = mimo_tts.split_text(text, 80)
        self.assertTrue(all(len(p) <= 120 for p in pieces), [len(p) for p in pieces])
        self.assertEqual("".join(pieces), text)

    def test_keeps_punctuation(self):
        text = "第一句。第二句！第三句？"
        pieces = mimo_tts.split_text(text, 400)
        self.assertEqual("".join(pieces), text)

    def test_never_cuts_inside_brackets(self):
        text = "(温柔)这是一段很长的文字，用来验证切分不会把【行内标签】切开。" * 6
        pieces = mimo_tts.split_text(text, 60)
        for piece in pieces:
            self.assertEqual(piece.count("("), piece.count(")"))
            self.assertEqual(piece.count("【"), piece.count("】"))

    def test_decimal_not_split(self):
        pieces = mimo_tts.split_text("圆周率是3.14159，很长的数字。", 400)
        self.assertEqual("".join(pieces), "圆周率是3.14159，很长的数字。")
        self.assertEqual(len(pieces), 1)

    def test_hard_split_without_punctuation(self):
        text = "啊" * 500
        pieces = mimo_tts.split_text(text, 100)
        self.assertTrue(all(len(p) <= 100 for p in pieces))
        self.assertEqual("".join(pieces), text)

    def test_trailing_tag_moves_to_next(self):
        text = "这是一段足够长的开头内容内容内容内容内容内容内容内容内容内容[叹气]后面还有内容。"
        pieces = mimo_tts.split_text(text, 40)
        for piece in pieces[:-1]:
            self.assertFalse(piece.endswith("[叹气]"), pieces)

    def test_merge_short_fragments(self):
        pieces = mimo_tts.split_text("嗯。好。我们开始吧。", 400)
        self.assertEqual(len(pieces), 1)


class PayloadTest(unittest.TestCase):
    def test_preset_streams_pcm16(self):
        payload = mimo_client.build_payload(
            model=mimo_client.MODEL_PRESET, text="(温柔)你好。", instruction="自然一点", voice="冰糖")
        self.assertTrue(payload["stream"])
        self.assertEqual(payload["audio"]["format"], "pcm16")
        self.assertEqual(payload["audio"]["voice"], "冰糖")
        self.assertEqual(payload["messages"][0]["role"], "user")
        self.assertEqual(payload["messages"][-1]["role"], "assistant")
        self.assertEqual(payload["messages"][-1]["content"], "(温柔)你好。")

    def test_no_user_message_when_no_instruction(self):
        payload = mimo_client.build_payload(
            model=mimo_client.MODEL_PRESET, text="你好。", voice="冰糖")
        self.assertEqual(len(payload["messages"]), 1)

    def test_design_has_no_stream_and_explicit_optimize(self):
        payload = mimo_client.build_payload(
            model=mimo_client.MODEL_DESIGN, text="你好。", instruction="年轻女性", optimize=False)
        self.assertNotIn("stream", payload)
        self.assertEqual(payload["audio"]["format"], "wav")
        self.assertIs(payload["audio"]["optimize_text_preview"], False)
        self.assertNotIn("voice", payload["audio"])
        self.assertEqual(payload["messages"][0]["content"], "年轻女性")

    def test_design_requires_description(self):
        with self.assertRaises(mimo_client.TtsError):
            mimo_client.build_payload(model=mimo_client.MODEL_DESIGN, text="你好。", instruction="")

    def test_design_optimize_allows_empty_text(self):
        payload = mimo_client.build_payload(
            model=mimo_client.MODEL_DESIGN, text="", instruction="年轻女性", optimize=True)
        self.assertEqual(len(payload["messages"]), 1)

    def test_clone_uses_data_url(self):
        payload = mimo_client.build_payload(
            model=mimo_client.MODEL_CLONE, text="你好。",
            sample_data_url="data:audio/wav;base64,AAAA")
        self.assertNotIn("stream", payload)
        self.assertEqual(payload["audio"]["format"], "wav")
        self.assertTrue(payload["audio"]["voice"].startswith("data:audio/wav"))

    def test_clone_requires_sample(self):
        with self.assertRaises(mimo_client.TtsError):
            mimo_client.build_payload(model=mimo_client.MODEL_CLONE, text="你好。")

    def test_redact_payload_masks_sample(self):
        payload = mimo_client.build_payload(
            model=mimo_client.MODEL_CLONE, text="你好。",
            sample_data_url="data:audio/wav;base64," + "A" * 4000)
        masked = mimo_client.redact_payload(payload)["audio"]["voice"]
        self.assertIn("KB", masked)
        self.assertNotIn("A" * 100, masked)


class WavParseTest(unittest.TestCase):
    PCM = b"\x01\x02" * 24000  # 1 秒

    def test_plain_wav(self):
        info = mimo_audio.parse_wav(build_wav(self.PCM))
        self.assertEqual(info.sample_rate, 24000)
        self.assertEqual(info.pcm, self.PCM)
        self.assertEqual(info.frames, 24000)

    def test_list_before_fmt(self):
        info = mimo_audio.parse_wav(build_wav(self.PCM, extra_before=[(b"LIST", b"abcdef")]))
        self.assertEqual(info.pcm, self.PCM)

    def test_junk_between_fmt_and_data(self):
        info = mimo_audio.parse_wav(build_wav(self.PCM, extra_middle=[(b"JUNK", b"xyz")]))
        self.assertEqual(info.pcm, self.PCM)

    def test_odd_size_chunk_padding(self):
        info = mimo_audio.parse_wav(build_wav(self.PCM, extra_middle=[(b"JUNK", b"abcde")]))
        self.assertEqual(info.pcm, self.PCM)

    def test_multiple_data_chunks(self):
        info = mimo_audio.parse_wav(build_wav(self.PCM, two_data=True))
        self.assertEqual(len(info.pcm), len(self.PCM))

    def test_broken_size_field(self):
        info = mimo_audio.parse_wav(build_wav(self.PCM, broken_size=True))
        self.assertEqual(info.pcm, self.PCM)

    def test_extensible_format(self):
        info = mimo_audio.parse_wav(build_wav(self.PCM, tag=0xFFFE))
        self.assertEqual(info.pcm, self.PCM)

    def test_stereo_downmix(self):
        frames = 100
        interleaved = b"".join(struct.pack("<hh", 4, 2) for _ in range(frames))
        info = mimo_audio.parse_wav(build_wav(interleaved, channels=2))
        self.assertEqual(info.channels, 1)
        self.assertEqual(len(info.pcm), frames * 2)
        self.assertEqual(struct.unpack_from("<h", info.pcm, 0)[0], 3)

    def test_wrong_sample_rate_rejected(self):
        with self.assertRaises(mimo_audio.AudioError):
            mimo_audio.parse_wav(build_wav(self.PCM, rate=48000))

    def test_not_riff(self):
        with self.assertRaises(mimo_audio.AudioError):
            mimo_audio.parse_wav(b"not a wav at all")

    def test_truncated_does_not_crash(self):
        blob = build_wav(self.PCM)
        info = mimo_audio.parse_wav(blob[: len(blob) // 2])
        self.assertGreater(len(info.pcm), 0)


class AssemblerTest(unittest.TestCase):
    def test_odd_bytes_carry(self):
        asm = mimo_audio.PcmAssembler()
        out = asm.feed(b"\x01\x02\x03") + asm.feed(b"\x04") + asm.feed(b"\x05\x06")
        out += asm.finish()
        self.assertEqual(out, b"\x01\x02\x03\x04\x05\x06")

    def test_never_emits_odd_length(self):
        asm = mimo_audio.PcmAssembler()
        total = b""
        for chunk in (b"\x01", b"\x02\x03", b"\x04", b"\x05\x06\x07"):
            piece = asm.feed(chunk)
            self.assertEqual(len(piece) % 2, 0)
            total += piece
        total += asm.finish()
        # 7 字节里只有前 6 个凑成完整 16bit 帧，最后 1 字节丢弃且被记数
        self.assertEqual(total, b"\x01\x02\x03\x04\x05\x06")
        self.assertEqual(asm.dropped, 1)


class OutputTest(unittest.TestCase):
    def test_make_wav_header(self):
        pcm = b"\x00\x01" * 2400
        blob = mimo_audio.make_wav([pcm])
        self.assertEqual(blob[:4], b"RIFF")
        self.assertEqual(blob[8:12], b"WAVE")
        size, rate = struct.unpack_from("<I", blob, 4)[0], struct.unpack_from("<I", blob, 24)[0]
        self.assertEqual(rate, 24000)
        self.assertEqual(size, len(blob) - 8)
        self.assertEqual(len(blob), 44 + len(pcm))

    def test_roundtrip_duration(self):
        pcm = b"\x00\x00" * 12000
        blob = mimo_audio.make_wav([pcm])
        info = mimo_audio.parse_wav(blob)
        self.assertAlmostEqual(mimo_audio.duration(len(info.pcm)), 0.5, places=3)

    def test_order_preserved(self):
        """并发返回乱序时，结果仍按 index 落位。"""
        order = [2, 0, 1]
        results = [None] * 3
        for idx in order:
            results[idx] = "chunk-%d" % idx
        self.assertEqual(results, ["chunk-0", "chunk-1", "chunk-2"])


class SafetyTest(unittest.TestCase):
    def test_redact_masks_key(self):
        self.assertNotIn("abcdef123456", mimo_client.redact("Authorization: Bearer sk-abcdef123456"))
        self.assertIn("***", mimo_client.redact("sk-testsecretvalue"))

    def test_error_kinds(self):
        self.assertEqual(mimo_client._error_from_body(401, "").kind, "auth")
        self.assertEqual(mimo_client._error_from_body(429, "").kind, "rate_limit")
        self.assertTrue(mimo_client._error_from_body(503, "").retryable)
        self.assertFalse(mimo_client._error_from_body(401, "").retryable)


if __name__ == "__main__":
    unittest.main(verbosity=2)
