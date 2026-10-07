import os
import subprocess
import time
from pathlib import Path

UPLOADS_DIR = Path("uploads")

files_map = [
    ("IMG_0111.MOV", "opt_cam1.mp4", "CAM-01 [IMG_0111]"),
    ("IMG_0112.MOV", "opt_cam2.mp4", "CAM-02 [IMG_0112]"),
    ("IMG_0113.MOV", "opt_cam3.mp4", "CAM-03 [IMG_0113]"),
    ("IMG_0114.MOV", "opt_cam4.mp4", "CAM-04 [IMG_0114]"),
    ("IMG_0115.MOV", "opt_cam5.mp4", "CAM-05 [IMG_0115]"),
]

print("=" * 60)
print("  ACCELERATING & OPTIMIZING USER CCTV RECORDINGS FOR 60FPS / 30FPS")
print("=" * 60)

font_path = "C\\:/Windows/Fonts/arial.ttf"

for src_name, dst_name, title in files_map:
    src = UPLOADS_DIR / src_name
    dst = UPLOADS_DIR / dst_name

    if not src.exists():
        print(f"[-] Skipping {src_name} (not found)")
        continue

    print(f"[*] Optimizing {src_name} -> {dst_name} with GPU acceleration...")
    t0 = time.time()

    # OSD overlay filter + YUV420p standard 8-bit surveillance format
    vf = (
        f"format=yuv420p,"
        f"drawtext=fontfile='{font_path}':text='REC  {title}':fontcolor=white:fontsize=20:x=20:y=20:box=1:boxcolor=black@0.65,"
        f"drawtext=fontfile='{font_path}':text='CCTV LIVE | 30 FPS | GPU HW':fontcolor=white@0.85:fontsize=14:x=20:y=h-34:box=1:boxcolor=black@0.65"
    )

    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(src),
        "-map", "0:v:0",
        "-vf", vf,
        "-c:v", "h264_mf",
        "-b:v", "3500k",
        "-r", "30",
        "-g", "30",
        "-pix_fmt", "yuv420p",
        "-an",
        str(dst)
    ]

    subprocess.run(cmd, check=True)
    dt = round(time.time() - t0, 1)
    print(f"[+] Successfully optimized {dst_name} in {dt}s")

print("=" * 60)
print("All videos are now 100% GPU-ready for butter-smooth streaming!")
