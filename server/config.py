import os
import socket
from pathlib import Path

# Paths
ROOT_DIR = Path(__file__).resolve().parent.parent
BIN_DIR = ROOT_DIR / "bin"
FRONTEND_DIR = ROOT_DIR / "frontend"
LOGS_DIR = ROOT_DIR / "logs"
MEDIAMTX_BIN = BIN_DIR / "mediamtx.exe"
MEDIAMTX_CONFIG = ROOT_DIR / "mediamtx.yml"

# RAM Disk auto-detection
# If setup_ramdisk.ps1 has been run, opt_*.mp4 files live in R:\ (or another
# drive) for zero-disk-I/O streaming.  The marker file "CCTV_RAMDISK" is
# written by the setup script so we can detect it here automatically.
_RAMDISK_CANDIDATES = [Path("R:/"), Path("T:/"), Path("Z:/")]
_DISK_UPLOADS = ROOT_DIR / "uploads"

def _detect_uploads_dir() -> Path:
    for candidate in _RAMDISK_CANDIDATES:
        marker = candidate / "CCTV_RAMDISK"
        if marker.exists():
            print(f"[config] RAM disk detected at {candidate} — using it for zero-disk-I/O streaming.")
            return candidate
    return _DISK_UPLOADS

UPLOADS_DIR = _detect_uploads_dir()

_DISK_UPLOADS.mkdir(parents=True, exist_ok=True)
BIN_DIR.mkdir(parents=True, exist_ok=True)
LOGS_DIR.mkdir(parents=True, exist_ok=True)

# Ports
HTTP_PORT = 8000
RTSP_PORT = 8554
WEBRTC_PORT = 8889
HLS_PORT = 8888
SRT_PORT = 8890
RTMP_PORT = 1935
MEDIAMTX_API_PORT = 9997

def get_network_ips():
    """Detect local IP addresses on the machine."""
    ips = ["127.0.0.1", "localhost"]
    try:
        # Connect to an external address (doesn't send data) to determine outgoing interface IP
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        primary_ip = s.getsockname()[0]
        s.close()
        if primary_ip not in ips:
            ips.insert(0, primary_ip)
    except Exception:
        pass
    
    # Try hostname resolution
    try:
        host_ip = socket.gethostbyname(socket.gethostname())
        if host_ip not in ips and not host_ip.startswith("127."):
            ips.append(host_ip)
    except Exception:
        pass

    return ips

PRIMARY_IP = get_network_ips()[0]
