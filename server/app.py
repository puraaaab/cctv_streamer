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

import asyncio
import io
import logging
import os
import shutil
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger("CCTVServer")

from fastapi import (
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from server.config import (
    FRONTEND_DIR,
    HLS_PORT,
    HTTP_PORT,
    LOGS_DIR,
    PRIMARY_IP,
    ROOT_DIR,
    RTSP_PORT,
    RTMP_PORT,
    SRT_PORT,
    UPLOADS_DIR,
    WEBRTC_PORT,
    get_network_ips,
)
from server.gpu_monitor import get_gpu_info
from server.stream_manager import stream_manager

app = FastAPI(
    title="CCTV Multi-Protocol Video Streaming Server",
    description="GPU-accelerated IP Camera Simulator & CCTV Stream Server",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# -------------------------------------------------------------
# Startup / Shutdown Events
# -------------------------------------------------------------
@app.on_event("startup")
async def on_startup():
    # Start MediaMTX core
    stream_manager.start_mediamtx()

    # 1. Clean up any channels whose source video file no longer exists
    for cid in list(stream_manager.channels.keys()):
        ch = stream_manager.channels[cid]
        source_path = UPLOADS_DIR / ch.source_filename
        if not source_path.exists():
            stream_manager.delete_channel(cid)

    # 2. Find all video files in uploads/ (preferring opt_camX.mp4 if present)
    discovered_videos = []
    
    # Check if optimized files exist for all 5 cameras
    opt_files = sorted(list(UPLOADS_DIR.glob("opt_cam*.mp4")))
    if opt_files:
        discovered_videos = [f.name for f in opt_files]
    else:
        for ext in ("*.mov", "*.MOV", "*.mp4", "*.MP4", "*.mkv", "*.avi", "*.ts", "*.webm", "*.m4v", "*.flv"):
            for f in UPLOADS_DIR.glob(ext):
                if f.name not in discovered_videos:
                    discovered_videos.append(f.name)
        discovered_videos.sort()

    # 3. If no videos exist at all, generate a synthetic CCTV test feed
    if not discovered_videos:
        demo_file = stream_manager.generate_synthetic_cctv_video("cctv_cam1_entrance.mp4")
        discovered_videos.append(demo_file.name)

    # Camera label mapping
    camera_labels = {
        "opt_cam1.mp4": "CAM-01 [IMG_0111]",
        "opt_cam2.mp4": "CAM-02 [IMG_0112]",
        "opt_cam3.mp4": "CAM-03 [IMG_0113]",
        "opt_cam4.mp4": "CAM-04 [IMG_0114]",
        "opt_cam5.mp4": "CAM-05 [IMG_0115]",
        "opt_cam6.mp4": "CAM-06 [GAURAVPATH - KARGIL CHOWK]",
        "opt_cam7.mp4": "CAM-07 [ROKADIYA HANUMAN - BHATENA C-TURN]",
        "opt_cam8.mp4": "CAM-08 [ROKADIYA HANUMAN - JOGANIMATA]",
        "opt_cam9.mp4": "CAM-09 [ROKADIYA HANUMAN - BHATENA]",
        "opt_cam10.mp4": "CAM-10 [KARGIL CHOWK - FROM LAKE VIEW]",
        "opt_cam11.mp4": "CAM-11 [KARGIL CHOWK - TOWARDS LAKE VIEW]",
        "opt_cam12.mp4": "CAM-12 [PARLE POINT - SVNIT TRAFFIC]",
    }

    # 4. Ensure each video file in uploads/ has an active channel
    registered_files = {ch.source_filename for ch in stream_manager.channels.values()}
    for idx, filename in enumerate(discovered_videos, start=1):
        if filename not in registered_files:
            cid = f"cam{idx}"
            display_name = camera_labels.get(filename, f"CAM-0{idx} [{filename.rsplit('.', 1)[0].upper()}]")
            stream_manager.add_channel(
                channel_id=cid,
                name=display_name,
                source_filename=filename,
                encoder="auto",
                osd_enabled=False if filename.startswith("opt_") else True,
                resolution="native",
                bitrate="4000k",
                fps=30,
                loop=True,
                auto_start=False,
            )

    # 5. Auto-start all channels
    for cid in list(stream_manager.channels.keys()):
        stream_manager.start_channel(cid)


@app.on_event("shutdown")
async def on_shutdown():
    stream_manager.stop_all()


# -------------------------------------------------------------
# Telemetry & Status APIs
# -------------------------------------------------------------
@app.get("/api/status")
async def get_system_status(request: Request):
    client_host = request.client.host if request.client else PRIMARY_IP
    host_ip = request.query_params.get("host", PRIMARY_IP)
    return {
        "status": "online",
        "primary_ip": PRIMARY_IP,
        "selected_host": host_ip,
        "network_ips": get_network_ips(),
        "ports": {
            "http": HTTP_PORT,
            "rtsp": RTSP_PORT,
            "webrtc": WEBRTC_PORT,
            "hls": HLS_PORT,
            "srt": SRT_PORT,
            "rtmp": RTMP_PORT,
        },
        "gpu": get_gpu_info(),
        "channels_count": len(stream_manager.channels),
        "active_channels": sum(1 for c in stream_manager.channels.values() if c.status == "running"),
    }


@app.get("/api/telemetry")
async def get_telemetry():
    return {
        "gpu": get_gpu_info(),
        "timestamp": time.time(),
    }


@app.get("/api/network-ips")
async def get_ips():
    return {"ips": get_network_ips()}


_cached_public_ip: Optional[str] = None


@app.get("/api/public-ip")
async def get_public_ip():
    global _cached_public_ip
    if _cached_public_ip:
        return {"public_ip": _cached_public_ip}
    try:
        res = await _proxy_client.get("https://api.ipify.org?format=json", timeout=3.0)
        if res.status_code == 200:
            _cached_public_ip = res.json().get("ip")
            return {"public_ip": _cached_public_ip}
    except Exception:
        pass
    return {"public_ip": None}



_current_tunnel_url: Optional[str] = None


@app.get("/api/tunnel-url")
async def get_tunnel_url():
    global _current_tunnel_url

    tunnel_log = LOGS_DIR / "tunnel.log"
    if tunnel_log.exists():
        try:
            content = tunnel_log.read_text(encoding="utf-8", errors="ignore")
            import re
            m = re.findall(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com", content)
            if m:
                _current_tunnel_url = m[-1]
                return {"tunnel_url": _current_tunnel_url}
        except Exception:
            pass

    if _current_tunnel_url:
        return {"tunnel_url": _current_tunnel_url}
    return {"tunnel_url": None}


class TunnelUrlPayload(BaseModel):
    tunnel_url: Optional[str] = None


@app.post("/api/tunnel-url")
async def set_tunnel_url(payload: TunnelUrlPayload):
    global _current_tunnel_url
    url = (payload.tunnel_url or "").strip().rstrip("/")
    _current_tunnel_url = url if url else None
    return {"tunnel_url": _current_tunnel_url}


# -------------------------------------------------------------
# Video Management APIs
# -------------------------------------------------------------
@app.get("/api/videos")
async def list_videos():
    videos = []
    for ext in ("*.mp4", "*.mkv", "*.avi", "*.mov", "*.flv", "*.ts", "*.webm", "*.m4v"):
        for f in UPLOADS_DIR.glob(ext):
            stat = f.stat()
            videos.append({
                "filename": f.name,
                "size_mb": round(stat.st_size / (1024 * 1024), 2),
                "modified": stat.st_mtime,
                "path": str(f),
            })
    return {"videos": sorted(videos, key=lambda x: x["modified"], reverse=True)}


@app.post("/api/upload")
async def upload_video(
    file: UploadFile = File(...),
    auto_create_stream: bool = Form(True),
    channel_name: Optional[str] = Form(None),
    encoder: str = Form("auto"),
    osd_enabled: bool = Form(True),
    resolution: str = Form("native"),
    bitrate: str = Form("4000k"),
    fps: int = Form(25),
    loop: bool = Form(True),
):
    safe_filename = "".join(c for c in file.filename if c.isalnum() or c in ("-", "_", ".")).lower()
    if not safe_filename:
        safe_filename = f"video_{int(time.time())}.mp4"

    target_path = UPLOADS_DIR / safe_filename
    with open(target_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    channel_data = None
    if auto_create_stream:
        base_id = safe_filename.rsplit(".", 1)[0]
        cid = "".join(c for c in base_id if c.isalnum() or c in ("-", "_")).lower()
        if not cid:
            cid = f"cam_{int(time.time())}"
        
        display_name = channel_name or f"CAM {cid.upper()}"
        ch = stream_manager.add_channel(
            channel_id=cid,
            name=display_name,
            source_filename=safe_filename,
            encoder=encoder,
            osd_enabled=osd_enabled,
            resolution=resolution,
            bitrate=bitrate,
            fps=fps,
            loop=loop,
            auto_start=True,
        )
        channel_data = ch.to_dict()

    return {
        "success": True,
        "filename": safe_filename,
        "channel": channel_data,
    }


@app.post("/api/generate-demo")
async def generate_demo_channel(
    name: str = "CAM-TEST [SURVEILLANCE GRID]",
    channel_id: Optional[str] = None,
):
    cid = channel_id or f"cam_demo_{int(time.time()) % 1000}"
    filename = f"{cid}.mp4"
    stream_manager.generate_synthetic_cctv_video(filename, duration=20)
    ch = stream_manager.add_channel(
        channel_id=cid,
        name=name,
        source_filename=filename,
        encoder="auto",
        osd_enabled=True,
        resolution="native",
        bitrate="4000k",
        fps=25,
        loop=True,
        auto_start=True,
    )
    return {"success": True, "channel": ch.to_dict()}


@app.delete("/api/videos/{filename}")
async def delete_video(filename: str):
    target = UPLOADS_DIR / filename
    if not target.exists():
        raise HTTPException(status_code=404, detail="File not found")
    
    # Check if used by any channel
    for cid, ch in list(stream_manager.channels.items()):
        if ch.source_filename == filename:
            stream_manager.delete_channel(cid)

    os.remove(target)
    return {"success": True, "deleted": filename}


# -------------------------------------------------------------
# Channel Lifecycle APIs
# -------------------------------------------------------------
class ChannelCreateRequest(BaseModel):
    channel_id: str
    name: str
    source_filename: str
    encoder: str = "auto"
    osd_enabled: bool = True
    resolution: str = "native"
    bitrate: str = "4000k"
    fps: int = 25
    loop: bool = True
    auto_start: bool = True


@app.get("/api/channels")
async def get_channels(host: Optional[str] = None):
    return {"channels": stream_manager.get_all_channels_data(host or PRIMARY_IP)}


@app.post("/api/channels")
async def create_channel(req: ChannelCreateRequest, host: Optional[str] = None):
    source_file = UPLOADS_DIR / req.source_filename
    if not source_file.exists():
        raise HTTPException(status_code=400, detail=f"Source video '{req.source_filename}' does not exist.")

    channel = stream_manager.add_channel(
        channel_id=req.channel_id,
        name=req.name,
        source_filename=req.source_filename,
        encoder=req.encoder,
        osd_enabled=req.osd_enabled,
        resolution=req.resolution,
        bitrate=req.bitrate,
        fps=req.fps,
        loop=req.loop,
        auto_start=req.auto_start,
    )
    return {"success": True, "channel": channel.to_dict(host or PRIMARY_IP)}


@app.post("/api/channels/{channel_id}/start")
async def start_channel(channel_id: str, host: Optional[str] = None):
    ok = stream_manager.start_channel(channel_id)
    if not ok:
        ch = stream_manager.get_channel(channel_id)
        msg = ch.error_message if ch else "Channel not found"
        raise HTTPException(status_code=400, detail=f"Failed to start channel: {msg}")
    ch = stream_manager.get_channel(channel_id)
    return {"success": True, "channel": ch.to_dict(host or PRIMARY_IP)}


@app.post("/api/channels/{channel_id}/stop")
async def stop_channel(channel_id: str):
    stream_manager.stop_channel(channel_id)
    return {"success": True, "channel_id": channel_id}


@app.post("/api/channels/{channel_id}/restart")
async def restart_channel(channel_id: str, host: Optional[str] = None):
    ok = stream_manager.restart_channel(channel_id)
    ch = stream_manager.get_channel(channel_id)
    return {"success": ok, "channel": ch.to_dict(host or PRIMARY_IP) if ch else None}


@app.delete("/api/channels/{channel_id}")
async def delete_channel(channel_id: str):
    ok = stream_manager.delete_channel(channel_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Channel not found")
    return {"success": True, "channel_id": channel_id}


@app.get("/api/channels/{channel_id}/logs")
async def get_channel_logs(channel_id: str, lines: int = 50):
    ch = stream_manager.get_channel(channel_id)
    if not ch:
        raise HTTPException(status_code=404, detail="Channel not found")
    log_lines = stream_manager.get_channel_logs(channel_id, max_lines=lines)
    stats = stream_manager.get_channel_stats(channel_id)
    return {
        "channel_id": channel_id,
        "status": ch.status,
        "stats": stats,
        "logs": log_lines,
    }


# -------------------------------------------------------------
# Real-Time MJPEG Stream & Snapshot Endpoints
# -------------------------------------------------------------
@app.get("/api/stream/{channel_id}/snapshot.jpg")
@app.get("/onvif/snapshot")
async def get_snapshot(channel_id: Optional[str] = None, channel: Optional[str] = None):
    cid = channel_id or channel
    if not cid:
        cid = next(iter(stream_manager.channels.keys()), None)
    
    frame = stream_manager.get_channel_snapshot(cid)
    if not frame:
        raise HTTPException(status_code=503, detail="Camera frame not ready yet")

    return Response(
        content=frame,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        }
    )


@app.get("/api/stream/{channel_id}/mjpeg")
@app.get("/axis-cgi/mjpg/video.cgi")
@app.get("/live/{channel_id}.mjpg")
async def stream_mjpeg(
    channel_id: Optional[str] = None,
    camera: Optional[str] = None,
):
    cid = channel_id or camera
    if not cid:
        cid = next(iter(stream_manager.channels.keys()), None)

    ch = stream_manager.get_channel(cid)
    if not ch:
        raise HTTPException(status_code=404, detail=f"CCTV channel '{cid}' not found")

    async def _frame_generator():
        last_sent_frame = None
        while ch.status == "running":
            frame = stream_manager.get_channel_snapshot(cid)
            if frame and frame != last_sent_frame:
                last_sent_frame = frame
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"Content-Length: " + str(len(frame)).encode() + b"\r\n\r\n"
                    + frame + b"\r\n"
                )
            await asyncio.sleep(0.2)  # 5 FPS lightweight fallback

    return StreamingResponse(
        _frame_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
            "Connection": "close",
        }
    )


# -------------------------------------------------------------
# High-Performance HLS & WebRTC Reverse Proxy Endpoints
# (Allows seamless HTTPS tunneling via Cloudflare with zero mixed-content errors)
# -------------------------------------------------------------
import httpx

_proxy_limits = httpx.Limits(max_connections=500, max_keepalive_connections=200, keepalive_expiry=30.0)
_proxy_client = httpx.AsyncClient(limits=_proxy_limits, follow_redirects=True, timeout=15.0)

@app.get("/hls/{channel_id}/{file_path:path}")
async def proxy_hls(channel_id: str, file_path: str, request: Request):
    """Proxy HLS requests to local MediaMTX (port 8888) over standard port 8000/tunnel."""
    query = str(request.url.query)
    target_url = f"http://127.0.0.1:{HLS_PORT}/{channel_id}/{file_path}"
    if query:
        target_url += f"?{query}"
    try:
        res = await _proxy_client.get(target_url)
        headers = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "*",
        }
        if "content-type" in res.headers:
            headers["Content-Type"] = res.headers["content-type"]
        if "cache-control" in res.headers:
            headers["Cache-Control"] = res.headers["cache-control"]
        else:
            headers["Cache-Control"] = "no-cache"

        return Response(
            content=res.content,
            status_code=res.status_code,
            headers=headers,
        )
    except Exception as e:
        logger.warning(f"HLS proxy error on {channel_id}/{file_path}: {repr(e)}")
        raise HTTPException(status_code=502, detail=f"HLS proxy error: {repr(e)}")


@app.api_route("/whep/{channel_id}", methods=["POST", "OPTIONS", "PATCH", "DELETE"])
@app.api_route("/{channel_id}/whep", methods=["POST", "OPTIONS", "PATCH", "DELETE"])
async def proxy_whep(channel_id: str, request: Request):
    """Proxy WebRTC WHEP signaling requests to local MediaMTX (port 8889)."""
    target_url = f"http://127.0.0.1:{WEBRTC_PORT}/{channel_id}/whep"
    body = await request.body()
    req_headers = dict(request.headers)
    req_headers.pop("host", None)
    try:
        res = await _proxy_client.request(
            method=request.method,
            url=target_url,
            content=body,
            headers=req_headers,
        )
        resp_headers = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS, PATCH, DELETE, GET",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Expose-Headers": "*",
        }
        for k, v in res.headers.items():
            if k.lower() in ("content-type", "location", "etag"):
                resp_headers[k] = v
        return Response(
            content=res.content,
            status_code=res.status_code,
            headers=resp_headers,
        )
    except Exception as e:
        logger.warning(f"WHEP proxy error on {channel_id}: {repr(e)}")
        raise HTTPException(status_code=502, detail=f"WHEP proxy error: {repr(e)}")

# -------------------------------------------------------------
# Static Files & UI Mounting
# -------------------------------------------------------------
if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

@app.get("/", response_class=HTMLResponse)
async def serve_index():
    index_path = FRONTEND_DIR / "index.html"
    if index_path.exists():
        with open(index_path, "r", encoding="utf-8") as f:
            return HTMLResponse(content=f.read())
    return HTMLResponse("<h1>CCTV Stream Server Running</h1><p>Frontend initializing...</p>")
