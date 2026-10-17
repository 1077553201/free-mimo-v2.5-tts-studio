"""启动脚本：自动探测空闲端口，绑 127.0.0.1（浏览器录音要求 secure context）。

用法：
    .venv\\Scripts\\python.exe run.py
    .venv\\Scripts\\python.exe run.py --port 8010 --no-open
"""

from __future__ import annotations

import argparse
import socket
import sys
import threading
import time
import webbrowser

import uvicorn


def find_free_port(start: int, tries: int = 12) -> int:
    for port in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit(f"{start}-{start + tries - 1} 端口都被占用了，请用 --port 指定其他端口")


def main() -> None:
    parser = argparse.ArgumentParser(description="MiMo TTS Studio")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    parser.add_argument("--reload", action="store_true", help="开发模式，自动重载")
    args = parser.parse_args()

    port = find_free_port(args.port)
    url = f"http://127.0.0.1:{port}"

    print("=" * 58)
    print("  MiMo TTS Studio")
    print(f"  本地地址: {url}")
    print("  提示: API Key 可以在页面右上角齿轮里填，或写进 .env")
    print("=" * 58)

    if not args.no_open:
        def open_later() -> None:
            time.sleep(1.2)
            webbrowser.open(url)

        threading.Thread(target=open_later, daemon=True).start()

    if args.reload:
        uvicorn.run("app:app", host="127.0.0.1", port=port, reload=True)
    else:
        uvicorn.run("app:app", host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
