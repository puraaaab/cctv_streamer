# CCTV Multi-Protocol Video Hosting & Streaming Server (GPU-Accelerated)

A high-performance, GPU-accelerated CCTV & IP Camera Simulator and Video Hosting server. Upload any video files and instantly stream them 24/7 across **all standard surveillance protocols** with real-time On-Screen Display (OSD), timecode clocks, and dynamic multi-camera matrix monitoring.

---

## Supported CCTV Protocols & Formats

| Protocol / Format | Relevance | Latency | URL Pattern | Best Use Case |
| :--- | :---: | :---: | :--- | :--- |
| **RTSP (Default)** | ⭐⭐⭐⭐⭐ | Low (~100-300ms) | `rtsp://<host>:8554/<stream_id>` | NVRs, VMS (Milestone, Shinobi, Frigate), OpenCV |
| **RTSP over TCP** | ⭐⭐⭐⭐⭐ | Low–Med | `rtsp://<host>:8554/<stream_id>?transport=tcp` | Firewall & NAT bypass, high-reliability enterprise CCTV |
| **RTSP over UDP** | ⭐⭐⭐⭐⭐ | Ultra-Low (<100ms) | `rtsp://<host>:8554/<stream_id>?transport=udp` | Low-latency live broadcast, minimal buffering |
| **RTP / RTCP** | ⭐⭐⭐⭐⭐ | Low | `rtsp://<host>:8554/<stream_id>` | Real-time transport layer (Ports 8002-8005) |
| **WebRTC (WHEP Live)** | ⭐⭐⭐⭐ | Ultra-Low (<200ms) | `http://<host>:8889/<stream_id>/whep` | Zero-plugin, instant live playback directly in browser |
| **WebRTC Player Page** | ⭐⭐⭐⭐ | Ultra-Low | `http://<host>:8889/<stream_id>/` | Standalone browser player view |
| **HLS (m3u8)** | ⭐⭐⭐ | Med (1-2s LL-HLS) | `http://<host>:8888/<stream_id>/index.m3u8` | Universal browser & mobile video (Safari, iOS, Chrome) |
| **MJPEG over HTTP** | ⭐⭐⭐⭐ | Low–Med | `http://<host>:8000/api/stream/<stream_id>/mjpeg` | Classic IP camera feeds, Axis/Hikvision compatibility, Home Assistant |
| **HTTP Snapshot (JPEG)** | ⭐⭐⭐⭐ | Instant (1 frame) | `http://<host>:8000/api/stream/<stream_id>/snapshot.jpg` | ANPR / License plate detection, facial recognition triggers |
| **SRT** | ⭐⭐⭐ | Low (~200ms) | `srt://<host>:8890?streamid=read:<stream_id>` | Reliable low-latency video transport across long distances |
| **RTMP** | ⭐⭐⭐ | Low–Med | `rtmp://<host>:1935/<stream_id>` | OBS Studio, YouTube/Twitch live ingestion, legacy NVRs |
| **Axis CGI Format** | ⭐⭐⭐⭐ | Low–Med | `http://<host>:8000/axis-cgi/mjpg/video.cgi?camera=<id>` | Simulated Axis IP camera video stream |
| **ONVIF Snapshot** | ⭐⭐⭐⭐ | Instant | `http://<host>:8000/onvif/snapshot?channel=<id>` | Simulated ONVIF camera snapshot endpoint |

---

## Hardware & GPU Acceleration

- **Hardware Encoders**:
  - `h264_mf` (Windows MediaFoundation GPU Acceleration)
  - `h264_nvenc` (NVIDIA NVENC Hardware Video Encoder)
  - `libx264` (CPU Ultra-Fast fallback)
- **Features**:
  - Seamless 24/7 video looping.
  - Dynamic CCTV OSD overlay (Camera Name, Recording indicator, dynamic timestamp clock, FPS).
  - Multi-threaded MJPEG and snapshot cache engine.

---

## Quick Start

### 1. Requirements
- Python 3.10+
- FFmpeg installed and in PATH

### 2. Start the Server
```bash
# Windows Batch:
start.bat

# Or run directly via Python:
python run_server.py
```

### 3. Open the Surveillance Control Center
Open your browser at:
- **Localhost**: `http://localhost:8000`
- **LAN / Network**: `http://<YOUR_IP>:8000`

---

## Integration Quick Reference

### Python OpenCV
```python
import cv2

rtsp_url = "rtsp://localhost:8554/cam1"
cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

while True:
    ret, frame = cap.read()
    if not ret:
        break
    cv2.imshow("CCTV Live Feed", frame)
    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()
```

### VLC Player
```bash
vlc --network-caching=150 rtsp://localhost:8554/cam1
```

### Frigate NVR
```yaml
cameras:
  cam1:
    ffmpeg:
      inputs:
        - path: rtsp://localhost:8554/cam1
          roles:
            - detect
            - record
    detect:
      width: 1280
      height: 720
      fps: 25
```

### Home Assistant Generic Camera
```yaml
camera:
  - platform: generic
    name: CCTV Entrance
    still_image_url: http://localhost:8000/api/stream/cam1/snapshot.jpg
    stream_source: rtsp://localhost:8554/cam1
```
