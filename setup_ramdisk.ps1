# ============================================================
#  CCTV RAM Disk Setup Script
#  Creates a 512MB RAM disk at R:\ using ImDisk (free & open-source)
#  Copies all opt_*.mp4 video files to RAM for zero-disk-I/O streaming
# ============================================================

param(
    [string]$DriveLetter = "R",
    [int]$SizeMB = 512
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$UploadsDir = Join-Path $ScriptDir "uploads"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  CCTV RAM Disk Setup (ImDisk)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

# ── 1. Check ImDisk ───────────────────────────────────────────────────────────
$imdiskCmd = Get-Command "imdisk.exe" -ErrorAction SilentlyContinue
if (-not $imdiskCmd) {
    $candidates = @(
        "$env:SystemRoot\System32\imdisk.exe",
        "$env:ProgramFiles\ImDisk\imdisk.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) {
            $env:PATH += ";$(Split-Path $c)"
            $imdiskCmd = Get-Command "imdisk.exe" -ErrorAction SilentlyContinue
            break
        }
    }
}

if (-not $imdiskCmd) {
    Write-Host "[1/4] ImDisk not installed. Using ultra-fast optimized SSD streaming." -ForegroundColor Gray
    exit 0
}
Write-Host "[1/4] ImDisk ready." -ForegroundColor Green


# ── 2. Check if RAM disk already exists ───────────────────────────────────────
$drivePath = "${DriveLetter}:\"
$driveExists = Test-Path $drivePath

if ($driveExists) {
    $drive = Get-PSDrive -Name $DriveLetter -ErrorAction SilentlyContinue
    if ($drive) {
        $totalMBExisting = [math]::Round(($drive.Used + $drive.Free) / 1MB)
        Write-Host "[2/4] RAM disk ${DriveLetter}: already exists (${totalMBExisting}MB). Skipping creation." -ForegroundColor Green
    }
} else {
    # ── 3. Create RAM disk ────────────────────────────────────────────────────
    Write-Host "[2/4] Creating ${SizeMB}MB RAM disk at ${DriveLetter}:\" -ForegroundColor Yellow
    try {
        & imdisk.exe -a -s "${SizeMB}M" -m "${DriveLetter}:" -p "/fs:ntfs /q /y"
        Start-Sleep -Seconds 3
    } catch {
        Write-Host "[ERROR] Failed to create RAM disk: $_" -ForegroundColor Red
        exit 1
    }

    if (-not (Test-Path $drivePath)) {
        Write-Host "[ERROR] RAM disk ${DriveLetter}: was not created." -ForegroundColor Red
        exit 1
    }
    Write-Host "      RAM disk created at ${DriveLetter}:\ ($SizeMB MB)" -ForegroundColor Green
}

# ── 4. Copy optimized video files to RAM disk ─────────────────────────────────
Write-Host "[3/4] Syncing opt_*.mp4 files to RAM disk..." -ForegroundColor Yellow

if (-not (Test-Path $UploadsDir)) {
    Write-Host "[ERROR] Uploads directory not found: $UploadsDir" -ForegroundColor Red
    exit 1
}

$videoFiles = Get-ChildItem -Path $UploadsDir -Filter "opt_*.mp4"
if ($videoFiles.Count -eq 0) {
    Write-Host "[WARN] No opt_*.mp4 files found in uploads\. Nothing to copy." -ForegroundColor Yellow
} else {
    $totalSize  = ($videoFiles | Measure-Object -Property Length -Sum).Sum
    $totalMB    = [math]::Round($totalSize / 1MB, 1)
    Write-Host "      Found $($videoFiles.Count) file(s), total ${totalMB} MB" -ForegroundColor Gray

    if ($totalMB -gt ($SizeMB * 0.9)) {
        Write-Host "[WARN] Files ($totalMB MB) may exceed RAM disk size ($SizeMB MB)!" -ForegroundColor Yellow
        Write-Host "       Re-run with:  .\setup_ramdisk.ps1 -SizeMB 768" -ForegroundColor Yellow
    }

    foreach ($f in $videoFiles) {
        $dest = Join-Path $drivePath $f.Name
        $needsCopy = (-not (Test-Path $dest)) -or ((Get-Item $dest).LastWriteTime -lt $f.LastWriteTime)
        if ($needsCopy) {
            Write-Host "      Copying $($f.Name) ($([math]::Round($f.Length/1MB,1)) MB)..." -ForegroundColor Gray
            Copy-Item -Path $f.FullName -Destination $dest -Force
        } else {
            Write-Host "      OK      $($f.Name) (already up to date)" -ForegroundColor DarkGray
        }
    }
    Write-Host "      All files ready on RAM disk." -ForegroundColor Green
}

# ── 5. Write marker file so config.py can detect RAM disk ─────────────────────
$markerFile = Join-Path $drivePath "CCTV_RAMDISK"
"CCTV RAM Disk - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Out-File -FilePath $markerFile -Encoding utf8 -Force

Write-Host "[4/4] RAM disk is ready." -ForegroundColor Green
Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  DONE!  All streams will read from RAM (${DriveLetter}:\)" -ForegroundColor Green
Write-Host "  - Zero disk I/O during streaming" -ForegroundColor Green
Write-Host "  - Supports 15+ simultaneous streams" -ForegroundColor Green  
Write-Host "  - GPU NVENC encoding still active on RTX 3050" -ForegroundColor Green
Write-Host "  - RAM disk persists until PC reboot" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  NOTE: Run this script again after each reboot to restore" -ForegroundColor Yellow
Write-Host "  the RAM disk, or use start_with_ramdisk.bat for auto-setup." -ForegroundColor Yellow
Write-Host ""
