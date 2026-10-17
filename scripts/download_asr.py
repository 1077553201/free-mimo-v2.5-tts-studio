"""下载本地中文 ASR 模型（SenseVoice-Small，234M 参数，int8 量化 65MB）。

用法：
    .venv\\Scripts\\python.exe scripts\\download_asr.py
    .venv\\Scripts\\python.exe scripts\\download_asr.py --keep-fp32   # 需要更高精度时

默认只保留 int8 模型：65MB，CPU 实时，中文效果几乎无损；
完整包里还有个 895MB 的 fp32 模型，一般用不上，脚本会顺手删掉。
"""

from __future__ import annotations

import argparse
import shutil
import sys
import tarfile
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import config  # noqa: E402

URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
    "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2"
)
ARCHIVE = config.ROOT / "models" / "sense-voice.tar.bz2"


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}GB"


def download(url: str, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    with httpx.stream("GET", url, follow_redirects=True, timeout=httpx.Timeout(60, read=None)) as resp:
        resp.raise_for_status()
        total = int(resp.headers.get("content-length") or 0)
        done = 0
        with dst.open("wb") as fh:
            for chunk in resp.iter_bytes(1 << 20):
                fh.write(chunk)
                done += len(chunk)
                if total:
                    pct = done * 100 // total
                    bar = "#" * (pct // 4)
                    print(f"\r  {pct:3d}% [{bar:<25}] {human(done)}/{human(total)}", end="", flush=True)
                else:
                    print(f"\r  {human(done)}", end="", flush=True)
    print()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep-fp32", action="store_true", help="保留 895MB 的 fp32 模型")
    args = parser.parse_args()

    target = config.SENSEVOICE_DIR
    if (target / "model.int8.onnx").exists():
        print(f"已存在：{target}")
        print("如需重新下载，先删除该目录。")
        return

    if not ARCHIVE.exists():
        print(f"下载 SenseVoice-Small（约 230MB 压缩包）…")
        download(URL, ARCHIVE)
    else:
        print(f"使用已下载的压缩包：{ARCHIVE}")

    print("解压中…")
    with tarfile.open(ARCHIVE, "r:bz2") as tar:
        tar.extractall(ARCHIVE.parent)

    if not args.keep_fp32:
        fp32 = target / "model.onnx"
        if fp32.exists():
            fp32.unlink()
            print(f"已删除 fp32 模型（{human(895 * 1024 * 1024)}）")

    ARCHIVE.unlink()
    print(f"完成：{target}")
    print("  模型：model.int8.onnx（65MB）")
    print("  重启服务后，实时对话里就能选「SenseVoice-Small · 本地」")


if __name__ == "__main__":
    main()
