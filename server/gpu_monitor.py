import subprocess
import shutil
import psutil
import json

def get_gpu_info():
    """Query NVIDIA GPU metrics via nvidia-smi with fallback to general system metrics."""
    info = {
        "has_gpu": False,
        "name": "CPU Only",
        "utilization_gpu": 0,
        "utilization_memory": 0,
        "memory_used_mb": 0,
        "memory_total_mb": 0,
        "memory_free_mb": 0,
        "temperature_c": 0,
        "power_w": 0,
        "driver_version": "N/A",
        "cuda_version": "N/A",
        "encoders_active": 0,
        "nvenc_supported": False,
        "system_cpu_percent": psutil.cpu_percent(interval=None),
        "system_ram_percent": psutil.virtual_memory().percent,
        "system_ram_used_gb": round(psutil.virtual_memory().used / (1024**3), 2),
        "system_ram_total_gb": round(psutil.virtual_memory().total / (1024**3), 2),
    }

    nvidia_smi = shutil.which("nvidia-smi")
    if not nvidia_smi:
        return info

    try:
        # Query detailed metrics using CSV format
        cmd = [
            nvidia_smi,
            "--query-gpu=name,driver_version,utilization.gpu,utilization.memory,memory.used,memory.total,memory.free,temperature.gpu,power.draw",
            "--format=csv,noheader,nounits"
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=2)
        if result.returncode == 0 and result.stdout.strip():
            parts = [p.strip() for p in result.stdout.strip().split("\n")[0].split(",")]
            if len(parts) >= 8:
                info["has_gpu"] = True
                info["name"] = parts[0]
                info["driver_version"] = parts[1]
                info["utilization_gpu"] = float(parts[2]) if parts[2].replace('.', '', 1).isdigit() else 0
                info["utilization_memory"] = float(parts[3]) if parts[3].replace('.', '', 1).isdigit() else 0
                info["memory_used_mb"] = float(parts[4]) if parts[4].replace('.', '', 1).isdigit() else 0
                info["memory_total_mb"] = float(parts[5]) if parts[5].replace('.', '', 1).isdigit() else 0
                info["memory_free_mb"] = float(parts[6]) if parts[6].replace('.', '', 1).isdigit() else 0
                info["temperature_c"] = float(parts[7]) if parts[7].replace('.', '', 1).isdigit() else 0
                if len(parts) >= 9 and parts[8].replace('.', '', 1).isdigit():
                    info["power_w"] = float(parts[8])
                info["nvenc_supported"] = True
    except Exception:
        pass

    return info
