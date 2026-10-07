import os
import sys

# Prevent blocked or corrupted optional binary C-extension packages
# (e.g. ujson/orjson blocked by Windows Application Control or AppLocker policies)
# from breaking FastAPI startup. Setting sys.modules entry to None causes importlib
# to raise ModuleNotFoundError, which FastAPI cleanly catches to fall back to standard JSON.
for _mod in ("ujson", "orjson"):
    try:
        __import__(_mod)
    except Exception:
        sys.modules[_mod] = None

import uvicorn
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT_DIR))

from server.config import HTTP_PORT, PRIMARY_IP, MEDIAMTX_BIN

def main():
    print("=" * 70)
    print("  CCTV MULTI-PROTOCOL STREAMING & VIDEO HOSTING SERVER (GPU)")
    print("=" * 70)
    print(f"  * Web Surveillance Center : http://localhost:{HTTP_PORT} or http://{PRIMARY_IP}:{HTTP_PORT}")
    print(f"  * RTSP Server             : rtsp://{PRIMARY_IP}:8554/<stream_id>")
    print(f"  * WebRTC WHEP / Live      : http://{PRIMARY_IP}:8889/<stream_id>/whep")
    print(f"  * HLS (m3u8) Streams      : http://{PRIMARY_IP}:8888/<stream_id>/index.m3u8")
    print(f"  * MJPEG over HTTP         : http://{PRIMARY_IP}:{HTTP_PORT}/api/stream/<stream_id>/mjpeg")
    print(f"  * Snapshot Frame (JPEG)   : http://{PRIMARY_IP}:{HTTP_PORT}/api/stream/<stream_id>/snapshot.jpg")
    print(f"  * SRT Transport           : srt://{PRIMARY_IP}:8890?streamid=read:<stream_id>")
    print(f"  * RTMP Broadcast          : rtmp://{PRIMARY_IP}:1935/<stream_id>")
    print("=" * 70)

    if not MEDIAMTX_BIN.exists():
        print(f"[!] Warning: MediaMTX binary not found at {MEDIAMTX_BIN}")

    import threading
    import webbrowser
    def _open_browser():
        import time
        time.sleep(1.0)
        try:
            webbrowser.open(f"http://localhost:{HTTP_PORT}")
        except Exception:
            pass

    threading.Thread(target=_open_browser, daemon=True).start()

    uvicorn.run(
        "server.app:app",
        host="0.0.0.0",
        port=HTTP_PORT,
        log_level="info",
        reload=False,
    )

if __name__ == "__main__":
    main()
