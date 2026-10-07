import asyncio
import json
import logging
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional

from server.config import (
    BIN_DIR,
    HLS_PORT,
    HTTP_PORT,
    LOGS_DIR,
    MEDIAMTX_BIN,
    MEDIAMTX_CONFIG,
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

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("CCTVStreamManager")

STREAMS_DB_FILE = ROOT_DIR / "streams_config.json"


class StreamChannel:
    def __init__(
        self,
        channel_id: str,
        name: str,
        source_filename: str,
        encoder: str = "auto",  # auto, gpu_mf, gpu_nvenc, cpu
        osd_enabled: bool = True,
        resolution: str = "native",  # native, 1920x1080, 1280x720, 640x360
        bitrate: str = "4000k",
        fps: int = 25,
        loop: bool = True,
    ):
        self.channel_id = channel_id
        self.name = name
        self.source_filename = source_filename
        self.encoder = encoder
        self.osd_enabled = osd_enabled
        self.resolution = resolution
        self.bitrate = bitrate
        self.fps = fps
        self.loop = loop

        self.status = "stopped"  # stopped, running, error
        self.error_message: Optional[str] = None
        self.start_time: Optional[float] = None
        self.process: Optional[subprocess.Popen] = None
        self.mjpeg_process: Optional[subprocess.Popen] = None
        
        self.latest_frame: Optional[bytes] = None
        self.frame_subscribers: List[asyncio.Queue] = []
        self._mjpeg_thread: Optional[threading.Thread] = None
        self._stop_mjpeg_thread = threading.Event()

    def to_dict(self, host_ip: Optional[str] = None, live_stats: Optional[dict] = None):
        uptime = int(time.time() - self.start_time) if self.start_time and self.status == "running" else 0
        return {
            "channel_id": self.channel_id,
            "name": self.name,
            "source_filename": self.source_filename,
            "encoder": self.encoder,
            "osd_enabled": self.osd_enabled,
            "resolution": self.resolution,
            "bitrate": self.bitrate,
            "fps": self.fps,
            "loop": self.loop,
            "status": self.status,
            "error_message": self.error_message,
            "uptime_seconds": uptime,
            "has_frame": self.latest_frame is not None,
            "links": self.get_links(host_ip or PRIMARY_IP),
            "live_stats": live_stats or {},
        }

    def get_links(self, host: str):
        cid = self.channel_id
        return {
            "rtsp_default": f"rtsp://{host}:{RTSP_PORT}/{cid}",
            "rtsp_tcp": f"rtsp://{host}:{RTSP_PORT}/{cid}?transport=tcp",
            "rtsp_udp": f"rtsp://{host}:{RTSP_PORT}/{cid}?transport=udp",
            "rtp_rtcp": f"rtsp://{host}:{RTSP_PORT}/{cid}",
            "webrtc_whep": f"http://{host}:{WEBRTC_PORT}/{cid}/whep",
            "webrtc_player": f"http://{host}:{WEBRTC_PORT}/{cid}/",
            "hls_m3u8": f"http://{host}:{HLS_PORT}/{cid}/index.m3u8",
            "mjpeg_stream": f"http://{host}:{HTTP_PORT}/api/stream/{cid}/mjpeg",
            "snapshot_jpeg": f"http://{host}:{HTTP_PORT}/api/stream/{cid}/snapshot.jpg",
            "srt_stream": f"srt://{host}:{SRT_PORT}?streamid=read:{cid}",
            "rtmp_stream": f"rtmp://{host}:{RTMP_PORT}/{cid}",
            "axis_cgi_mjpg": f"http://{host}:{HTTP_PORT}/axis-cgi/mjpg/video.cgi?camera={cid}",
            "onvif_snapshot": f"http://{host}:{HTTP_PORT}/onvif/snapshot?channel={cid}",
            "dahua_live": f"http://{host}:{HTTP_PORT}/live/{cid}.mjpg",
        }


class StreamManager:
    def __init__(self):
        self.channels: Dict[str, StreamChannel] = {}
        self.mediamtx_proc: Optional[subprocess.Popen] = None
        self.load_channels()

    def start_mediamtx(self):
        """Ensure MediaMTX background core is running."""
        if self.mediamtx_proc and self.mediamtx_proc.poll() is None:
            logger.info("MediaMTX is already running.")
            return

        if not MEDIAMTX_BIN.exists():
            logger.error(f"MediaMTX binary not found at {MEDIAMTX_BIN}")
            return

        cmd = [str(MEDIAMTX_BIN), str(MEDIAMTX_CONFIG)]
        logger.info(f"Starting MediaMTX core: {' '.join(cmd)}")
        try:
            mtx_log = open(LOGS_DIR / "mediamtx.log", "a", encoding="utf-8")
            self.mediamtx_proc = subprocess.Popen(
                cmd,
                cwd=str(ROOT_DIR),
                stdout=mtx_log,
                stderr=mtx_log,
            )
            time.sleep(1)
        except Exception as e:
            logger.error(f"Failed to start MediaMTX: {e}")

    def stop_mediamtx(self):
        if self.mediamtx_proc and self.mediamtx_proc.poll() is None:
            logger.info("Stopping MediaMTX...")
            self.mediamtx_proc.terminate()
            try:
                self.mediamtx_proc.wait(timeout=3)
            except Exception:
                self.mediamtx_proc.kill()
            self.mediamtx_proc = None

    def save_channels(self):
        data = []
        for ch in self.channels.values():
            data.append({
                "channel_id": ch.channel_id,
                "name": ch.name,
                "source_filename": ch.source_filename,
                "encoder": ch.encoder,
                "osd_enabled": ch.osd_enabled,
                "resolution": ch.resolution,
                "bitrate": ch.bitrate,
                "fps": ch.fps,
                "loop": ch.loop,
            })
        try:
            with open(STREAMS_DB_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to save stream configuration: {e}")

    def load_channels(self):
        if not STREAMS_DB_FILE.exists():
            return
        try:
            with open(STREAMS_DB_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            for item in data:
                ch = StreamChannel(**item)
                self.channels[ch.channel_id] = ch
        except Exception as e:
            logger.error(f"Failed to load stream configuration: {e}")

    def add_channel(
        self,
        channel_id: str,
        name: str,
        source_filename: str,
        encoder: str = "auto",
        osd_enabled: bool = True,
        resolution: str = "native",
        bitrate: str = "4000k",
        fps: int = 25,
        loop: bool = True,
        auto_start: bool = True,
    ) -> StreamChannel:
        # Clean channel ID (alphanumeric and underscores)
        channel_id = "".join(c for c in channel_id if c.isalnum() or c in ("-", "_")).lower()
        if not channel_id:
            channel_id = f"cam_{int(time.time())}"

        if channel_id in self.channels:
            self.stop_channel(channel_id)

        channel = StreamChannel(
            channel_id=channel_id,
            name=name or f"CAMERA {channel_id.upper()}",
            source_filename=source_filename,
            encoder=encoder,
            osd_enabled=osd_enabled,
            resolution=resolution,
            bitrate=bitrate,
            fps=fps,
            loop=loop,
        )
        self.channels[channel_id] = channel
        self.save_channels()

        if auto_start:
            self.start_channel(channel_id)

        return channel

    def _resolve_encoder_flags(self, encoder: str, bitrate: str, fps: int):
        """Determine FFmpeg video encoder flags with NVIDIA GPU NVENC priority."""
        if encoder in ("auto", "gpu_nvenc", "gpu"):
            # Hardware NVENC encoder on NVIDIA GeForce RTX 3050 (High FPS, ~0% CPU, handles 20+ streams)
            return [
                "-c:v", "h264_nvenc",
                "-preset", "p1",        # Fastest performance preset for 20+ streams
                "-tune", "ll",          # Low-latency tuning
                "-b:v", bitrate,
                "-maxrate", bitrate,
                "-bufsize", "2M",
                "-r", str(fps),
                "-g", str(fps),
                "-pix_fmt", "yuv420p",
            ]
        elif encoder == "gpu_mf":
            return [
                "-c:v", "h264_mf",
                "-b:v", bitrate,
                "-r", str(fps),
                "-g", str(fps),
                "-pix_fmt", "yuv420p",
            ]
        else:  # CPU libx264
            return [
                "-c:v", "libx264",
                "-preset", "ultrafast",
                "-tune", "zerolatency",
                "-b:v", bitrate,
                "-maxrate", bitrate,
                "-bufsize", "2M",
                "-r", str(fps),
                "-g", str(fps),
                "-pix_fmt", "yuv420p",
            ]

    def _build_filter_graph(self, channel: StreamChannel):
        """Construct video filter chain (scaling + CCTV OSD overlay)."""
        filters = []

        # Resolution scaling
        if channel.resolution and channel.resolution != "native":
            try:
                w, h = channel.resolution.split("x")
                filters.append(f"scale={w}:{h}")
            except Exception:
                pass

        # CCTV On-Screen Display Overlay
        if channel.osd_enabled:
            cam_title = channel.name.replace("'", "\\'").replace(":", "\\:")
            # Font path on Windows
            font_path = "C\\:/Windows/Fonts/arial.ttf"
            if not os.path.exists("C:/Windows/Fonts/arial.ttf"):
                font_path = "C\\:/Windows/Fonts/consola.ttf"

            # Top overlay: Camera Name + Live Timestamp
            osd_top = (
                f"drawtext=fontfile='{font_path}':"
                f"text='REC  {cam_title}   %{{localtime}}':"
                f"fontcolor=white:fontsize=18:x=16:y=16:box=1:boxcolor=black@0.65"
            )
            # Bottom overlay: Codec, FPS, CCTV status
            osd_bottom = (
                f"drawtext=fontfile='{font_path}':"
                f"text='CCTV LIVE | CH\\: {channel.channel_id.upper()} | {channel.fps} FPS':"
                f"fontcolor=white@0.85:fontsize=14:x=16:y=h-30:box=1:boxcolor=black@0.65"
            )
            filters.append(osd_top)
            filters.append(osd_bottom)

        if filters:
            return ",".join(filters)
        return None

    def start_channel(self, channel_id: str) -> bool:
        channel = self.channels.get(channel_id)
        if not channel:
            return False

        self.stop_channel(channel_id)
        self.start_mediamtx()

        source_path = UPLOADS_DIR / channel.source_filename
        if not source_path.exists():
            # Fallback: check the on-disk uploads folder (e.g. newly uploaded file not yet on RAM disk)
            from server.config import _DISK_UPLOADS
            fallback_path = _DISK_UPLOADS / channel.source_filename
            if fallback_path.exists():
                logger.warning(
                    f"[{channel_id}] File not on RAM disk yet, using disk copy: {fallback_path}. "
                    f"Run setup_ramdisk.ps1 to sync."
                )
                source_path = fallback_path
            else:
                channel.status = "error"
                channel.error_message = f"Source video not found: {channel.source_filename}"
                return False

        filter_graph = self._build_filter_graph(channel)
        enc_flags = self._resolve_encoder_flags(channel.encoder, channel.bitrate, channel.fps)

        is_optimized_mp4 = channel.source_filename.startswith("opt_") or channel.source_filename.endswith(".mp4")

        # 1. Main RTSP Pipeline to MediaMTX
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "info", "-stats"]
        
        # Realtime input and looping
        cmd.extend(["-re"])
        if channel.loop:
            cmd.extend(["-stream_loop", "-1"])
        cmd.extend(["-i", str(source_path)])

        cmd.extend(["-map", "0:v:0"])

        if is_optimized_mp4:
            # Zero CPU, pure stream copy for maximum smoothness
            cmd.extend(["-c:v", "copy"])
        else:
            if filter_graph:
                cmd.extend(["-vf", filter_graph])
            cmd.extend(enc_flags)

        cmd.extend(["-an"])  # Surveillance video typically has no audio
        cmd.extend([
            "-f", "rtsp",
            "-rtsp_transport", "tcp",
            f"rtsp://127.0.0.1:{RTSP_PORT}/{channel.channel_id}"
        ])

        logger.info(f"Starting RTSP Pipeline for {channel_id}: {' '.join(cmd)}")
        log_file_path = LOGS_DIR / f"ffmpeg_{channel_id}.log"
        try:
            channel._log_handle = open(log_file_path, "w", encoding="utf-8")
            channel.process = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=channel._log_handle,
            )
            channel.status = "running"
            channel.start_time = time.time()
            channel.error_message = None
        except Exception as e:
            logger.error(f"Failed to spawn FFmpeg for {channel_id}: {e}")
            channel.status = "error"
            channel.error_message = str(e)
            return False

        # Stream started successfully (uses 0% CPU with stream-copy or NVIDIA NVENC)
        return True

    def get_channel_snapshot(self, channel_id: str) -> Optional[bytes]:
        """Captures a single snapshot frame on-demand (zero idle CPU, zero RAM bloat)."""
        channel = self.channels.get(channel_id)
        if not channel:
            return None
        now = time.time()
        if channel.latest_frame and (now - getattr(channel, "_last_frame_ts", 0)) < 2.0:
            return channel.latest_frame

        # Grab a single frame from the local RTSP stream in ~50ms
        try:
            source = f"rtsp://127.0.0.1:{RTSP_PORT}/{channel_id}"
            proc = subprocess.run(
                [
                    "ffmpeg", "-hide_banner", "-loglevel", "fatal",
                    "-rtsp_transport", "tcp",
                    "-i", source,
                    "-frames:v", "1",
                    "-f", "image2",
                    "-q:v", "2",
                    "pipe:1"
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=2.5,
            )
            if proc.stdout and len(proc.stdout) > 1000:
                channel.latest_frame = proc.stdout
                channel._last_frame_ts = now
                return proc.stdout
        except Exception:
            pass

        # Robust Fallback: grab frame from local source video file
        try:
            source_path = UPLOADS_DIR / channel.source_filename
            if source_path.exists():
                proc = subprocess.run(
                    [
                        "ffmpeg", "-hide_banner", "-loglevel", "fatal",
                        "-ss", "00:00:01",
                        "-i", str(source_path),
                        "-frames:v", "1",
                        "-f", "image2",
                        "-q:v", "2",
                        "pipe:1"
                    ],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    timeout=2.0,
                )
                if proc.stdout and len(proc.stdout) > 1000:
                    channel.latest_frame = proc.stdout
                    channel._last_frame_ts = now
                    return proc.stdout
        except Exception:
            pass

        return channel.latest_frame

    def stop_channel(self, channel_id: str):
        channel = self.channels.get(channel_id)
        if not channel:
            return

        channel._stop_mjpeg_thread.set()

        if channel.mjpeg_process and channel.mjpeg_process.poll() is None:
            try:
                channel.mjpeg_process.terminate()
                channel.mjpeg_process.wait(timeout=1)
            except Exception:
                channel.mjpeg_process.kill()
            channel.mjpeg_process = None

        if channel.process and channel.process.poll() is None:
            try:
                channel.process.terminate()
                channel.process.wait(timeout=1)
            except Exception:
                channel.process.kill()
            channel.process = None

        if hasattr(channel, "_log_handle") and channel._log_handle:
            try:
                channel._log_handle.close()
            except Exception:
                pass
            channel._log_handle = None

        channel.status = "stopped"
        channel.start_time = None

    def get_channel_stats(self, channel_id: str) -> dict:
        log_file_path = LOGS_DIR / f"ffmpeg_{channel_id}.log"
        stats = {
            "channel_id": channel_id,
            "fps": 0.0,
            "frame": 0,
            "speed": "0x",
            "bitrate": "0kbits/s",
            "time": "00:00:00",
            "status": "stopped"
        }
        channel = self.channels.get(channel_id)
        if channel:
            stats["status"] = channel.status
        if not log_file_path.exists():
            return stats
        try:
            with open(log_file_path, "r", encoding="utf-8", errors="ignore") as f:
                lines = f.readlines()
            for line in reversed(lines[-25:]):
                if "frame=" in line and "fps=" in line:
                    parts = line.strip().split()
                    for i, p in enumerate(parts):
                        if p.startswith("frame="):
                            try:
                                stats["frame"] = int(p.split("=")[1] if p.split("=")[1] else parts[i+1])
                            except Exception:
                                pass
                        elif p.startswith("fps="):
                            try:
                                stats["fps"] = float(p.split("=")[1] if p.split("=")[1] else parts[i+1])
                            except Exception:
                                pass
                        elif p.startswith("time="):
                            stats["time"] = p.split("=")[1]
                        elif p.startswith("bitrate="):
                            stats["bitrate"] = p.split("=")[1]
                        elif p.startswith("speed="):
                            stats["speed"] = p.split("=")[1]
                    break
        except Exception:
            pass
        return stats

    def get_channel_logs(self, channel_id: str, max_lines: int = 50) -> List[str]:
        log_file_path = LOGS_DIR / f"ffmpeg_{channel_id}.log"
        if not log_file_path.exists():
            return [f"Log file for {channel_id} not yet generated."]
        try:
            with open(log_file_path, "r", encoding="utf-8", errors="ignore") as f:
                lines = f.readlines()
            return [l.strip() for l in lines[-max_lines:]]
        except Exception as e:
            return [f"Error reading log: {e}"]

    def delete_channel(self, channel_id: str) -> bool:
        self.stop_channel(channel_id)
        if channel_id in self.channels:
            del self.channels[channel_id]
            self.save_channels()
            return True
        return False

    def restart_channel(self, channel_id: str) -> bool:
        self.stop_channel(channel_id)
        time.sleep(0.5)
        return self.start_channel(channel_id)

    def get_channel(self, channel_id: str) -> Optional[StreamChannel]:
        return self.channels.get(channel_id)

    def get_all_channels_data(self, host_ip: Optional[str] = None):
        # Refresh statuses
        for ch in self.channels.values():
            if ch.status == "running" and ch.process and ch.process.poll() is not None:
                ch.status = "error" if ch.process.returncode != 0 else "stopped"
                err = ch.process.stderr.read() if ch.process.stderr else ""
                ch.error_message = err.strip()[-300:] if err else "Process exited"

        return [ch.to_dict(host_ip, live_stats=self.get_channel_stats(ch.channel_id)) for ch in self.channels.values()]

    def stop_all(self):
        for cid in list(self.channels.keys()):
            self.stop_channel(cid)
        self.stop_mediamtx()

    def generate_synthetic_cctv_video(self, filename: str = "cctv_demo_entrance.mp4", duration: int = 15) -> Path:
        """Generates a realistic CCTV camera test footage video with surveillance grid, movement, and noise."""
        target_path = UPLOADS_DIR / filename
        if target_path.exists():
            return target_path

        cmd = [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi",
            "-i", (
                f"testsrc2=size=1280x720:rate=25:duration={duration},"
                f"eq=contrast=1.2:brightness=-0.05:saturation=0.4,"
                f"noise=alls=15:allf=t+u"
            ),
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-pix_fmt", "yuv420p",
            str(target_path)
        ]
        logger.info(f"Generating synthetic CCTV sample video: {' '.join(cmd)}")
        subprocess.run(cmd, check=True)
        return target_path


# Global instance
stream_manager = StreamManager()
