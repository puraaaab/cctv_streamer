/**
 * CCTV MATRIX // Surveillance Operations Center Web Application
 * Handles multi-protocol streaming, WebRTC WHEP playback, HLS.js, MJPEG, and video hosting.
 */

// Application State
const state = {
  hostIp: window.location.hostname || "127.0.0.1",
  tunnelUrl: "",   // Cloudflare / public tunnel URL (e.g. https://xxxx.trycloudflare.com)
  publicIp: "",    // Public WAN IP (for internet RTSP links)
  channels: [],
  selectedChannelId: null,
  activePlayers: {}, // map of channel_id -> { type: 'webrtc'|'hls'|'mjpeg', instance: ... }
  isSoloMode: false,
  soloCamId: null,
  soloPlayer: null,
  soloModeType: "hls",
  telemetryTimer: null,
  channelsTimer: null,
  clockTimer: null,
};

// ==========================================================================
// Initialization & Telemetry
// ==========================================================================

document.addEventListener("DOMContentLoaded", async () => {
  initGridPresetButtons();
  initDragAndDrop();
  initTabs();
  startLiveClocks();

  // Check URL query param e.g. ?cam=cam1 to immediately enter Solo Viewer mode
  const urlParams = new URLSearchParams(window.location.search);
  const targetCam = urlParams.get("cam") || urlParams.get("watch");
  if (targetCam) {
    state.isSoloMode = true;
    state.soloCamId = targetCam.toLowerCase();
  }

  // Handle browser Back / Forward buttons
  window.addEventListener("popstate", () => {
    const params = new URLSearchParams(window.location.search);
    const cam = params.get("cam") || params.get("watch");
    if (cam) {
      enterSoloView(cam.toLowerCase(), false);
    } else if (state.isSoloMode) {
      exitSoloView();
    }
  });

  fetch("/api/public-ip").then((r) => r.json()).then((d) => { if (d && d.public_ip) state.publicIp = d.public_ip; }).catch(() => {});

  await loadNetworkIps();
  await refreshChannels();
  await updateTelemetry();

  // If URL specified a camera feed, activate the Solo Player right away
  if (state.isSoloMode && state.soloCamId) {
    enterSoloView(state.soloCamId, false);
  }

  // Poll channels every 3 seconds and telemetry every 2 seconds
  state.channelsTimer = setInterval(refreshChannels, 3000);
  state.telemetryTimer = setInterval(updateTelemetry, 2000);

  // Setup header events
  document.getElementById("btn-open-upload").addEventListener("click", openUploadModal);
  document.getElementById("btn-generate-demo").addEventListener("click", generateDemoFeed);
  document.getElementById("btn-refresh-streams").addEventListener("click", refreshChannels);
  document.getElementById("btn-protocols-cheat").addEventListener("click", () => {
    if (state.channels.length > 0) {
      openLinksModal(state.channels[0].channel_id);
    } else {
      showToast("No active channels yet. Generating demo camera...", "info");
      generateDemoFeed();
    }
  });

  document.getElementById("host-ip-select").addEventListener("change", (e) => {
    state.hostIp = e.target.value;
    refreshChannels(true);
    if (state.selectedChannelId) {
      renderProtocolsList(state.selectedChannelId);
    }
  });

  // Cloudflare tunnel URL input with auto-detection & persistence
  const tunnelInput = document.getElementById("tunnel-url-input");
  const tunnelDot = document.getElementById("tunnel-status-dot");

  function applyTunnelUrl(url) {
    if (!url) return;
    const clean = url.trim().replace(/\/$/, "");
    state.tunnelUrl = clean;
    if (tunnelInput) {
      tunnelInput.value = clean;
      tunnelInput.classList.add("tunnel-active");
    }
    if (tunnelDot) tunnelDot.classList.add("active");
    if (state.selectedChannelId) renderProtocolsList(state.selectedChannelId);
  }

  // 1. If currently browsing through a Cloudflare tunnel or remote HTTPS
  if (window.location.hostname.endsWith(".trycloudflare.com") || (window.location.protocol === "https:" && window.location.hostname !== "localhost")) {
    applyTunnelUrl(window.location.origin);
  } else {
    // 2. Check localStorage
    const saved = localStorage.getItem("cctv_tunnel_url");
    if (saved) applyTunnelUrl(saved);

    // 3. Fetch auto-detected tunnel URL from server (if available in logs)
    fetch("/api/tunnel-url")
      .then((res) => res.json())
      .then((data) => {
        if (data && data.tunnel_url && !state.tunnelUrl) {
          applyTunnelUrl(data.tunnel_url);
        }
      })
      .catch(() => {});
  }

  if (tunnelInput) {
    tunnelInput.addEventListener("input", (e) => {
      let val = e.target.value.trim().replace(/\/$/, "");
      state.tunnelUrl = val;
      tunnelInput.classList.toggle("tunnel-active", val.length > 0);
      if (tunnelDot) tunnelDot.classList.toggle("active", val.length > 0);
      localStorage.setItem("cctv_tunnel_url", val);
      fetch("/api/tunnel-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tunnel_url: val }),
      }).catch(() => {});
      if (state.selectedChannelId) renderProtocolsList(state.selectedChannelId);
    });
  }
});

// Load available Network / LAN IPs
async function loadNetworkIps() {
  try {
    const res = await fetch("/api/network-ips");
    const data = await res.json();
    const select = document.getElementById("host-ip-select");
    select.innerHTML = "";

    const currentHost = window.location.hostname;
    let selected = false;

    data.ips.forEach((ip) => {
      const opt = document.createElement("option");
      opt.value = ip;
      opt.textContent = ip === "127.0.0.1" || ip === "localhost" ? `${ip} (Local)` : `${ip} (LAN / Network)`;
      if (ip === currentHost) {
        opt.selected = true;
        state.hostIp = ip;
        selected = true;
      }
      select.appendChild(opt);
    });

    if (!selected && data.ips.length > 0) {
      state.hostIp = data.ips[0];
    }
  } catch (err) {
    console.error("Failed to load network IPs:", err);
  }
}

// Fetch GPU & System Telemetry
async function updateTelemetry() {
  try {
    const res = await fetch("/api/telemetry");
    const data = await res.json();
    const gpu = data.gpu || {};

    const nameEl = document.getElementById("gpu-name-val");
    const loadEl = document.getElementById("gpu-load-val");
    const vramEl = document.getElementById("vram-val");
    const feedsEl = document.getElementById("active-feeds-val");

    if (gpu.has_gpu) {
      nameEl.textContent = gpu.name ? gpu.name.replace("NVIDIA GeForce ", "") : "NVIDIA GPU";
      loadEl.textContent = `${gpu.utilization_gpu || 0}%`;
      vramEl.textContent = `${Math.round(gpu.memory_used_mb || 0)} / ${Math.round(gpu.memory_total_mb || 0)} MB`;
    } else {
      nameEl.textContent = "Hardware MF / CPU";
      loadEl.textContent = `${gpu.system_cpu_percent || 0}% CPU`;
      vramEl.textContent = `${gpu.system_ram_used_gb || 0} / ${gpu.system_ram_total_gb || 0} GB`;
    }

    const runningCount = state.channels.filter((c) => c.status === "running").length;
    feedsEl.textContent = `${runningCount} / ${state.channels.length}`;
  } catch (err) {
    console.warn("Telemetry update failed:", err);
  }
}

// ==========================================================================
// Channel Rendering & Video Matrix
// ==========================================================================

async function refreshChannels(forceReRender = false) {
  try {
    const res = await fetch(`/api/channels?host=${state.hostIp}`);
    const data = await res.json();
    const newChannels = data.channels || [];

    const idsChanged =
      forceReRender ||
      newChannels.length !== state.channels.length ||
      newChannels.some((c, i) => !state.channels[i] || c.channel_id !== state.channels[i].channel_id);

    state.channels = newChannels;

    if (state.isSoloMode) {
      updateSoloCamUI();
      return;
    }

    const emptyMatrix = document.getElementById("empty-matrix");
    const grid = document.getElementById("matrix-grid");

    if (newChannels.length === 0) {
      emptyMatrix.classList.remove("hidden");
      grid.innerHTML = "";
      return;
    }

    emptyMatrix.classList.add("hidden");

    if (idsChanged) {
      renderMatrixCards();
    } else {
      updateChannelStatuses();
    }
  } catch (err) {
    console.error("Failed to fetch channels:", err);
  }
}

function renderMatrixCards() {
  if (state.isSoloMode) return;
  const grid = document.getElementById("matrix-grid");
  grid.innerHTML = "";

  state.channels.forEach((ch) => {
    const card = document.createElement("div");
    card.className = "camera-card";
    card.id = `card-${ch.channel_id}`;

    const isRunning = ch.status === "running";
    const statusClass = isRunning ? "" : ch.status === "error" ? "error" : "stopped";

    card.innerHTML = `
      <div class="cam-header">
        <div class="cam-title-wrap" onclick="enterSoloView('${ch.channel_id}')" style="cursor:pointer;" title="Click for dedicated solo view">
          <div class="cam-live-dot ${statusClass}" id="dot-${ch.channel_id}"></div>
          <span class="cam-name">${escapeHtml(ch.name)}</span>
          <span class="cam-id-pill">${ch.channel_id.toUpperCase()}</span>
        </div>
        <div class="cam-meta-tags">
          <span class="cam-badge cam-badge-gpu">${ch.encoder === 'cpu' ? 'CPU 264' : 'GPU NVENC'}</span>
          <span class="cam-badge">${ch.fps} FPS</span>
          <span class="cam-badge">${ch.bitrate}</span>
        </div>
      </div>

      <div class="cam-video-stage" id="stage-${ch.channel_id}" ondblclick="enterSoloView('${ch.channel_id}')" title="Double click for Solo View">
        <!-- Video Element / MJPEG Image dynamically mounted -->
        <video id="vid-${ch.channel_id}" class="cam-video-player" autoplay playsinline muted></video>
        <img id="img-${ch.channel_id}" class="cam-mjpeg-img hidden" alt="MJPEG Feed">

        <!-- OSD Overlay (Live on-screen display) -->
        <div class="osd-overlay">
          <div class="osd-top">
            <div class="osd-rec">
              <div class="osd-rec-dot"></div>
              <span>${escapeHtml(ch.name)}</span>
            </div>
            <div class="osd-clock live-time-clock">--:--:--</div>
          </div>
          <div class="osd-bottom">
            <span class="osd-stat" id="stat-bottom-${ch.channel_id}">CH: ${ch.channel_id.toUpperCase()} | 1080p | H.264</span>
            <span class="osd-stat" id="telemetry-${ch.channel_id}" style="color:var(--cyan-core);font-weight:700;">INIT...</span>
            <span class="osd-stat" id="uptime-${ch.channel_id}">UPTIME: ${formatUptime(ch.uptime_seconds)}</span>
          </div>
        </div>

        <!-- Mode Selector (WebRTC / HLS / MJPEG) -->
        <div class="cam-mode-bar">
          <button class="btn-mode active" onclick="switchPlayerMode('${ch.channel_id}', 'webrtc', this)">WebRTC (Real-Time)</button>
          <button class="btn-mode" onclick="switchPlayerMode('${ch.channel_id}', 'hls', this)">HLS (HD)</button>
          <button class="btn-mode" onclick="switchPlayerMode('${ch.channel_id}', 'mjpeg', this)">MJPEG</button>
        </div>
      </div>

      <div class="cam-footer">
        <div class="cam-controls-left">
          <button class="btn-icon-sm" title="Toggle Mute / Audio" onclick="toggleMute('${ch.channel_id}')">
            <i class="fa-solid fa-volume-xmark" id="mute-icon-${ch.channel_id}"></i>
          </button>
          <button class="btn-icon-sm" title="Download High-Res Snapshot Frame" onclick="downloadSnapshot('${ch.channel_id}')">
            <i class="fa-solid fa-camera"></i>
          </button>
          <button class="btn-icon-sm" title="View Stream Logs & Frame Rate Diagnostics" onclick="openChannelLogsModal('${ch.channel_id}')">
            <i class="fa-solid fa-terminal"></i>
          </button>
          <button class="btn-icon-sm" title="Restart Stream Pipeline" onclick="restartChannel('${ch.channel_id}')">
            <i class="fa-solid fa-rotate-right"></i>
          </button>
          <button class="btn-icon-sm" title="Copy Public Share Link" onclick="shareChannel('${ch.channel_id}')" id="share-btn-${ch.channel_id}">
            <i class="fa-solid fa-share-nodes"></i>
          </button>
          <button class="btn-icon-sm danger" title="Delete Channel" onclick="deleteChannel('${ch.channel_id}')">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>

        <div class="cam-controls-right" style="display:flex;align-items:center;gap:6px;">
          <button class="btn-solo-grid" onclick="enterSoloView('${ch.channel_id}')" title="Open Dedicated Solo Monitor View">
            <i class="fa-solid fa-expand"></i> SOLO VIEW
          </button>
          <button class="btn-stream-links" onclick="openLinksModal('${ch.channel_id}')">
            <i class="fa-solid fa-link"></i> STREAM LINKS
          </button>
        </div>
      </div>
    `;

    grid.appendChild(card);

    // Initialize Default Player with WebRTC (sub-150ms latency, zero buffering)
    // with automatic fallback to optimized HLS if needed
    const defaultMode = (window.location.protocol === "https:" && !window.location.hostname.includes("localhost")) ? "hls" : "webrtc";
    initChannelPlayer(ch.channel_id, defaultMode);
  });
}

function updateChannelStatuses() {
  state.channels.forEach((ch) => {
    const dot = document.getElementById(`dot-${ch.channel_id}`);
    const uptime = document.getElementById(`uptime-${ch.channel_id}`);
    if (dot) {
      dot.className = `cam-live-dot ${ch.status === "running" ? "" : ch.status === "error" ? "error" : "stopped"}`;
    }
    if (uptime) {
      uptime.textContent = `UPTIME: ${formatUptime(ch.uptime_seconds)}`;
    }
  });
}

// ==========================================================================
// Player Implementations: WebRTC (WHEP), HLS.js, MJPEG
// ==========================================================================

async function initChannelPlayer(channelId, mode = "mjpeg") {
  const vid = document.getElementById(`vid-${channelId}`);
  const img = document.getElementById(`img-${channelId}`);
  const stage = document.getElementById(`stage-${channelId}`);
  if (!vid || !img) return;

  // Sync mode button active state
  if (stage) {
    const buttons = stage.querySelectorAll(".btn-mode");
    buttons.forEach((btn) => {
      const text = btn.textContent.toLowerCase();
      if (text.includes(mode)) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });
  }

  // Cleanup existing player instance
  if (state.activePlayers[channelId]) {
    const prev = state.activePlayers[channelId];
    if (prev.pc) prev.pc.close();
    if (prev.hls) prev.hls.destroy();
    if (prev.telemTimer) clearInterval(prev.telemTimer);
    delete state.activePlayers[channelId];
  }

  if (mode === "mjpeg") {
    vid.classList.add("hidden");
    img.classList.remove("hidden");
    img.src = `/api/stream/${channelId}/mjpeg?t=${Date.now()}`;
    state.activePlayers[channelId] = { type: "mjpeg" };
  } else if (mode === "webrtc") {
    vid.classList.remove("hidden");
    img.classList.add("hidden");
    startWebRTCPlayer(channelId, vid);
  } else if (mode === "hls") {
    vid.classList.remove("hidden");
    img.classList.add("hidden");
    startHLSPlayer(channelId, vid);
  }
}

// WebRTC WHEP Client (Sub-150ms zero-buffering, butter-smooth playback)
async function startWebRTCPlayer(channelId, videoEl) {
  try {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
    });

    state.activePlayers[channelId] = { type: "webrtc", pc };

    // Only add video transceiver since surveillance feeds are video-only
    pc.addTransceiver("video", { direction: "recvonly" });

    videoEl.muted = true; // Required by browsers for immediate autoplay
    setupVideoTelemetry(channelId, videoEl);

    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        videoEl.srcObject = event.streams[0];
        videoEl.play().catch(() => {
          videoEl.muted = true;
          videoEl.play().catch(() => {});
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") {
        console.warn(`WebRTC ICE failed for ${channelId}, switching to HLS`);
        initChannelPlayer(channelId, "hls");
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Wait for ICE candidates to gather so offer SDP has full routing candidates
    if (pc.iceGatheringState !== "complete") {
      await new Promise((resolve) => {
        const onState = () => {
          if (pc.iceGatheringState === "complete") {
            pc.removeEventListener("icegatheringstatechange", onState);
            resolve();
          }
        };
        pc.addEventListener("icegatheringstatechange", onState);
        setTimeout(resolve, 600); // 600ms maximum wait
      });
    }

    // Try relative proxy endpoint first (works everywhere, local and tunnel)
    const whepUrl = `/whep/${channelId}`;
    let res;
    try {
      res = await fetch(whepUrl, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: pc.localDescription.sdp,
      });
    } catch (_) {
      // Fallback to direct MediaMTX port 8889 on LAN
      res = await fetch(`http://${state.hostIp}:8889/${channelId}/whep`, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: pc.localDescription.sdp,
      });
    }

    if (!res || !res.ok) {
      console.warn(`WHEP handshake for ${channelId} failed, switching to smooth HLS`);
      initChannelPlayer(channelId, "hls");
      return;
    }

    const answerSdp = await res.text();
    await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: answerSdp }));
    console.log(`%c[WebRTC] ${channelId.toUpperCase()} connected successfully!`, "color: #10b981; font-weight: bold");
  } catch (err) {
    console.warn(`WebRTC error on ${channelId}, switching to smooth HLS:`, err);
    initChannelPlayer(channelId, "hls");
  }
}

// Live Telemetry & Playback Monitor
function setupVideoTelemetry(channelId, videoEl) {
  const telemEl = document.getElementById(`telemetry-${channelId}`);
  const bottomEl = document.getElementById(`stat-bottom-${channelId}`);
  let lastTime = 0;
  let frameCount = 0;
  let lastFpsCalcTime = performance.now();
  let measuredFps = 0;

  // Frame callback counter if browser supports requestVideoFrameCallback
  if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
    const onFrame = (now, metadata) => {
      frameCount++;
      const elapsed = (now - lastFpsCalcTime) / 1000;
      if (elapsed >= 1.0) {
        measuredFps = (frameCount / elapsed).toFixed(1);
        frameCount = 0;
        lastFpsCalcTime = now;
      }
      if (state.activePlayers[channelId]) {
        videoEl.requestVideoFrameCallback(onFrame);
      }
    };
    videoEl.requestVideoFrameCallback(onFrame);
  }

  // Periodic Telemetry & State Checker (runs every 500ms)
  const timer = setInterval(() => {
    if (!document.getElementById(`vid-${channelId}`)) {
      clearInterval(timer);
      return;
    }

    let bufSec = 0;
    try {
      for (let i = 0; i < videoEl.buffered.length; i++) {
        if (videoEl.buffered.start(i) <= videoEl.currentTime && videoEl.currentTime <= videoEl.buffered.end(i)) {
          bufSec = (videoEl.buffered.end(i) - videoEl.currentTime).toFixed(1);
          break;
        }
      }
    } catch (_) {}

    // Fallback FPS estimation if requestVideoFrameCallback is unsupported
    if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) {
      const dt = videoEl.currentTime - lastTime;
      if (dt > 0 && !videoEl.paused) {
        measuredFps = (dt / 0.5 * 30).toFixed(0);
      } else {
        measuredFps = 0;
      }
      lastTime = videoEl.currentTime;
    }

    if (telemEl) {
      if (videoEl.error) {
        telemEl.innerHTML = `<span style="color:#ef4444;">❌ ERR: ${videoEl.error.code}</span>`;
      } else if (videoEl.paused) {
        telemEl.innerHTML = `<span style="color:#f59e0b;">⏸ PAUSED</span>`;
      } else if (videoEl.readyState < 3) {
        telemEl.innerHTML = `<span style="color:#f59e0b;">⏳ BUFFERING (buf: ${bufSec}s)</span>`;
      } else {
        telemEl.innerHTML = `<span style="color:#10b981;">🟢 LIVE ${measuredFps || 30} FPS (buf: ${bufSec}s)</span>`;
      }
    }

    if (bottomEl && videoEl.videoWidth > 0) {
      bottomEl.textContent = `CH: ${channelId.toUpperCase()} | ${videoEl.videoWidth}x${videoEl.videoHeight} | H.264`;
    }
  }, 500);

  return timer;
}

// HLS.js Player (Hardware accelerated, ultra-smooth, works over any tunnel or browser)
function startHLSPlayer(channelId, videoEl) {
  // Use universal relative proxy endpoint (works seamlessly across LAN, HTTPS, and Cloudflare)
  const hlsUrl = `/hls/${channelId}/index.m3u8`;

  videoEl.muted = true;
  videoEl.defaultMuted = true;
  videoEl.playsInline = true;
  videoEl.setAttribute("playsinline", "");
  videoEl.setAttribute("webkit-playsinline", "");

  // Attach exhaustive HTML5 Video Element Lifecycle Event Loggers
  videoEl.onloadstart = () => console.log(`%c[${channelId.toUpperCase()}] ⏳ Video loadstart...`, "color: #38bdf8");
  videoEl.onloadedmetadata = () => console.log(`%c[${channelId.toUpperCase()}] 📋 Metadata: ${videoEl.videoWidth}x${videoEl.videoHeight}, duration=${videoEl.duration.toFixed(1)}s`, "color: #38bdf8");
  videoEl.onloadeddata = () => console.log(`%c[${channelId.toUpperCase()}] 📦 First frame rendered!`, "color: #10b981");
  videoEl.oncanplay = () => console.log(`%c[${channelId.toUpperCase()}] ▶ Video canplay`, "color: #10b981");
  videoEl.onplaying = () => console.log(`%c[${channelId.toUpperCase()}] 🟢 Video PLAYING smoothly`, "color: #10b981; font-weight: bold;");
  videoEl.onwaiting = () => console.warn(`[${channelId.toUpperCase()}] ⏳ Video waiting for buffer data...`);
  videoEl.onstalled = () => console.warn(`[${channelId.toUpperCase()}] ⚠️ Video playback stalled!`);
  videoEl.onerror = () => console.error(`[${channelId.toUpperCase()}] ❌ Video element error:`, videoEl.error);

  const telemTimer = setupVideoTelemetry(channelId, videoEl);

  if (Hls.isSupported()) {
    const hls = new Hls({
      lowLatencyMode: false,
      backBufferLength: 10,
      maxBufferLength: 8,
      maxMaxBufferLength: 15,
      maxBufferSize: 20 * 1024 * 1024,
      enableWorker: true,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 6,
      manifestLoadingMaxRetry: 10,
      manifestLoadingRetryDelay: 1000,
      fragLoadingMaxRetry: 10,
      fragLoadingRetryDelay: 1000,
    });

    hls.loadSource(hlsUrl);
    hls.attachMedia(videoEl);

    hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
      console.log(`%c[${channelId.toUpperCase()}] 📄 Manifest parsed: ${data.levels.length} quality levels available`, "color: #06b6d4");
      videoEl.play().catch((err) => {
        console.warn(`[${channelId.toUpperCase()}] Autoplay blocked, muted playback:`, err);
        videoEl.muted = true;
        videoEl.play().catch(() => {});
      });
    });

    hls.on(Hls.Events.FRAG_LOADED, (event, data) => {
      console.log(`[${channelId.toUpperCase()}] 🧩 Frag #${data.frag.sn} loaded (${(data.stats.total / 1024).toFixed(0)} KB in ${data.stats.loading.end - data.stats.loading.start}ms)`);
    });

    let hlsFailCount = 0;
    hls.on(Hls.Events.ERROR, (event, data) => {
      console.warn(`[${channelId.toUpperCase()}] HLS Event Error:`, data.type, data.details, "fatal:", data.fatal);
      if (data.fatal) {
        hlsFailCount++;
        if (hlsFailCount >= 3) {
          console.warn(`[${channelId.toUpperCase()}] HLS failed repeatedly, switching to MJPEG fallback`);
          initChannelPlayer(channelId, "mjpeg");
          return;
        }
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            console.warn(`[${channelId.toUpperCase()}] Recovering from network error...`);
            hls.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            console.warn(`[${channelId.toUpperCase()}] Recovering from media error...`);
            hls.recoverMediaError();
            break;
          default:
            console.error(`[${channelId.toUpperCase()}] Unrecoverable HLS error, auto-refreshing player...`);
            hls.destroy();
            setTimeout(() => startHLSPlayer(channelId, videoEl), 1500);
            break;
        }
      }
    });

    state.activePlayers[channelId] = { type: "hls", hls, telemTimer };
  } else if (videoEl.canPlayType("application/vnd.apple.mpegurl")) {
    videoEl.src = hlsUrl;
    videoEl.addEventListener("loadedmetadata", () => {
      videoEl.play().catch(() => {});
    });
    state.activePlayers[channelId] = { type: "hls_native", telemTimer };
  } else {
    initChannelPlayer(channelId, "mjpeg");
  }
}

// ==========================================================================
// Stream Logs & Pipeline Diagnostics Viewer
// ==========================================================================
let activeLogChannel = null;
let logRefreshInterval = null;

async function openChannelLogsModal(channelId) {
  activeLogChannel = channelId;
  const modal = document.getElementById("modal-logs");
  const title = document.getElementById("logs-modal-title");
  if (modal) modal.classList.remove("hidden");
  if (title) title.textContent = `Camera Pipeline Diagnostics & Live Logs // ${channelId.toUpperCase()}`;
  
  await refreshCurrentLogs();
  if (logRefreshInterval) clearInterval(logRefreshInterval);
  logRefreshInterval = setInterval(refreshCurrentLogs, 2000);
}

function closeLogsModal() {
  const modal = document.getElementById("modal-logs");
  if (modal) modal.classList.add("hidden");
  if (logRefreshInterval) {
    clearInterval(logRefreshInterval);
    logRefreshInterval = null;
  }
  activeLogChannel = null;
}

async function refreshCurrentLogs() {
  if (!activeLogChannel) return;
  const statsBar = document.getElementById("logs-stats-bar");
  const term = document.getElementById("logs-terminal");
  try {
    const res = await fetch(`/api/channels/${activeLogChannel}/logs`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const st = data.stats || {};
    
    if (statsBar) {
      statsBar.innerHTML = `
        <span style="color:#10b981;">STATUS: <b>${data.status.toUpperCase()}</b></span> | 
        <span style="color:#06b6d4;">LIVE FPS: <b>${st.fps || 0}</b></span> | 
        <span style="color:#38bdf8;">FRAMES: <b>${st.frame || 0}</b></span> | 
        <span style="color:#f59e0b;">BITRATE: <b>${st.bitrate || 'N/A'}</b></span> | 
        <span style="color:#a855f7;">SPEED: <b>${st.speed || 'N/A'}</b></span> | 
        <span>TIME: <b>${st.time || '00:00:00'}</b></span>
      `;
    }
    
    if (term) {
      const logs = data.logs || [];
      term.textContent = logs.length > 0 ? logs.join("\n") : "No log output recorded yet for this stream pipeline.";
      term.scrollTop = term.scrollHeight;
    }
  } catch (err) {
    if (term) term.textContent = `Failed to fetch live logs: ${err.message}`;
  }
}

function switchPlayerMode(channelId, mode, btnEl) {
  const parent = btnEl.parentElement;
  parent.querySelectorAll(".btn-mode").forEach((b) => b.classList.remove("active"));
  btnEl.classList.add("active");
  initChannelPlayer(channelId, mode);
}

function toggleMute(channelId) {
  const vid = document.getElementById(`vid-${channelId}`);
  const icon = document.getElementById(`mute-icon-${channelId}`);
  if (!vid || !icon) return;

  vid.muted = !vid.muted;
  icon.className = vid.muted ? "fa-solid fa-volume-xmark" : "fa-solid fa-volume-high";
}

function downloadSnapshot(channelId) {
  const url = `/api/stream/${channelId}/snapshot.jpg?t=${Date.now()}`;
  const a = document.createElement("a");
  a.href = url;
  a.download = `cctv_snapshot_${channelId}_${Date.now()}.jpg`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast("Snapshot saved successfully!", "success");
}

async function restartChannel(channelId) {
  showToast(`Restarting channel ${channelId.toUpperCase()}...`, "info");
  try {
    const res = await fetch(`/api/channels/${channelId}/restart?host=${state.hostIp}`, { method: "POST" });
    const data = await res.json();
    if (data.success) {
      showToast(`Channel ${channelId.toUpperCase()} restarted`, "success");
      setTimeout(() => initChannelPlayer(channelId, "webrtc"), 1000);
    }
  } catch (err) {
    showToast(`Failed to restart channel: ${err}`, "error");
  }
}

async function deleteChannel(channelId) {
  if (!confirm(`Are you sure you want to delete channel "${channelId}"?`)) return;
  try {
    const res = await fetch(`/api/channels/${channelId}`, { method: "DELETE" });
    const data = await res.json();
    if (data.success) {
      showToast(`Channel ${channelId} deleted`, "success");
      refreshChannels(true);
    }
  } catch (err) {
    showToast(`Failed to delete channel: ${err}`, "error");
  }
}

function shareChannel(channelId) {
  const tunnel = state.tunnelUrl ? state.tunnelUrl.replace(/\/$/, "") : null;
  if (!tunnel) {
    showToast("⚠️ Paste your Cloudflare tunnel URL in the header first!", "error");
    const inp = document.getElementById("tunnel-url-input");
    if (inp) {
      inp.focus();
      inp.classList.add("tunnel-highlight");
      setTimeout(() => inp.classList.remove("tunnel-highlight"), 1500);
    }
    return;
  }
  // Universal share link: opens this exact camera directly in any browser
  const shareViewerUrl = `${tunnel}/?cam=${channelId}`;
  copyToClipboard(shareViewerUrl);
  showToast(`📋 Public viewer link copied! Send to anyone to watch ${channelId.toUpperCase()} live: ${shareViewerUrl}`, "success");
}

// ==========================================================================
// Protocol Links Modal & SDK Cheat Sheet
// ==========================================================================

function openLinksModal(channelId) {
  const ch = state.channels.find((c) => c.channel_id === channelId);
  if (!ch) return;

  state.selectedChannelId = channelId;
  document.getElementById("links-modal-title").textContent = `Stream Links // ${ch.name} [${ch.channel_id.toUpperCase()}]`;

  renderProtocolsList(channelId);
  updateCodeSnippets(channelId);

  document.getElementById("modal-links").classList.remove("hidden");
}

function closeLinksModal() {
  document.getElementById("modal-links").classList.add("hidden");
}

function renderProtocolsList(channelId) {
  const ch = state.channels.find((c) => c.channel_id === channelId);
  if (!ch) return;

  const host = state.hostIp;
  const cid = ch.channel_id;
  const tunnel = state.tunnelUrl ? state.tunnelUrl.replace(/\/$/, "") : null;

  const container = document.getElementById("protocols-container");
  container.innerHTML = "";

  // ── Shareable Public Links (Cloudflare tunnel) ─────────────────────────────
  if (tunnel) {
    const shareSection = document.createElement("div");
    shareSection.className = "share-section";
    shareSection.innerHTML = `
      <div class="share-section-header">
        <i class="fa-solid fa-globe icon-green"></i>
        <strong>Public Shareable Links</strong>
        <span class="share-badge">Cloudflare Live Tunnel</span>
        <span class="share-hint">Accessible worldwide without firewall restrictions</span>
      </div>
      <div class="share-links-grid">
        <div class="share-link-card primary">
          <div class="share-link-label"><i class="fa-solid fa-desktop"></i> Web Viewer (One-Click Browser Link)</div>
          <div class="share-link-url">${tunnel}/?cam=${cid}</div>
          <div class="share-link-actions">
            <button class="btn-share-copy" onclick="copyToClipboard('${tunnel}/?cam=${cid}')"><i class="fa-solid fa-copy"></i> Copy Link</button>
            <a class="btn-share-open" href="${tunnel}/?cam=${cid}" target="_blank"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open</a>
          </div>
        </div>
        <div class="share-link-card">
          <div class="share-link-label"><i class="fa-solid fa-play"></i> Direct HLS Stream (.m3u8 for VLC / Apps)</div>
          <div class="share-link-url">${tunnel}/hls/${cid}/index.m3u8</div>
          <div class="share-link-actions">
            <button class="btn-share-copy" onclick="copyToClipboard('${tunnel}/hls/${cid}/index.m3u8')"><i class="fa-solid fa-copy"></i> Copy Link</button>
            <a class="btn-share-open" href="${tunnel}/hls/${cid}/index.m3u8" target="_blank"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open</a>
          </div>
        </div>
        <div class="share-link-card">
          <div class="share-link-label"><i class="fa-solid fa-satellite-dish"></i> Public RTSP Stream (VLC / NVR / OpenCV)</div>
          <div class="share-link-url">rtsp://${state.publicIp || state.hostIp}:8554/${cid}</div>
          <div class="share-link-actions">
            <button class="btn-share-copy" onclick="copyToClipboard('rtsp://${state.publicIp || state.hostIp}:8554/${cid}')"><i class="fa-solid fa-copy"></i> Copy RTSP</button>
            <button class="btn-share-open" onclick="copyToClipboard('rtsp://${state.publicIp || state.hostIp}:8554/${cid}?transport=tcp')"><i class="fa-solid fa-network-wired"></i> Copy TCP</button>
          </div>
        </div>
        <div class="share-link-card">
          <div class="share-link-label"><i class="fa-solid fa-image"></i> Live Snapshot (Instant JPEG)</div>
          <div class="share-link-url">${tunnel}/api/stream/${cid}/snapshot.jpg</div>
          <div class="share-link-actions">
            <button class="btn-share-copy" onclick="copyToClipboard('${tunnel}/api/stream/${cid}/snapshot.jpg')"><i class="fa-solid fa-copy"></i> Copy Link</button>
            <a class="btn-share-open" href="${tunnel}/api/stream/${cid}/snapshot.jpg" target="_blank"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open</a>
          </div>
        </div>
        <div class="share-link-card">
          <div class="share-link-label"><i class="fa-solid fa-film"></i> MJPEG Stream (Continuous Feed)</div>
          <div class="share-link-url">${tunnel}/api/stream/${cid}/mjpeg</div>
          <div class="share-link-actions">
            <button class="btn-share-copy" onclick="copyToClipboard('${tunnel}/api/stream/${cid}/mjpeg')"><i class="fa-solid fa-copy"></i> Copy Link</button>
            <a class="btn-share-open" href="${tunnel}/api/stream/${cid}/mjpeg" target="_blank"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open</a>
          </div>
        </div>
      </div>
      <div class="share-note">
        <i class="fa-solid fa-circle-info"></i>
        <span><strong>Web Viewer & HLS</strong> work worldwide over Cloudflare tunnel. <strong>Public RTSP</strong> uses WAN IP <code>${state.publicIp || state.hostIp}</code> (requires router port 8554 forwarded, or TCP tunnel like <code>ngrok tcp 8554</code>).</span>
      </div>
    `;
    container.appendChild(shareSection);

  } else {
    const promptDiv = document.createElement("div");
    promptDiv.className = "tunnel-prompt";
    promptDiv.innerHTML = `
      <i class="fa-solid fa-link-slash"></i>
      <span>Paste your <strong>Cloudflare tunnel URL</strong> (e.g. <code>https://xxxx.trycloudflare.com</code>) in the header box to generate shareable public links for anyone to watch.</span>
    `;
    container.appendChild(promptDiv);
  }

  // ── Local / LAN Protocol Links ─────────────────────────────────────────────
  const lanHeader = document.createElement("div");
  lanHeader.className = "lan-section-header";
  lanHeader.innerHTML = `<i class="fa-solid fa-network-wired"></i> <strong>Local / LAN Protocol Links</strong> <span class="share-hint">Only accessible on your network</span>`;
  container.appendChild(lanHeader);

  const protocols = [
    { name: "RTSP (Default)", stars: "⭐⭐⭐⭐⭐", latency: "Low (~100-300ms)", usecase: "Direct IP Camera feed, NVRs, VMS, Milestone, OpenCV", url: `rtsp://${host}:8554/${cid}` },
    { name: "RTSP over TCP",  stars: "⭐⭐⭐⭐⭐", latency: "Low-Medium",       usecase: "Firewall / NAT bypass, stable enterprise surveillance",        url: `rtsp://${host}:8554/${cid}?transport=tcp` },
    { name: "RTSP over UDP",  stars: "⭐⭐⭐⭐⭐", latency: "Ultra-Low (<100ms)",usecase: "Direct low-latency broadcast, zero transport buffer",          url: `rtsp://${host}:8554/${cid}?transport=udp` },
    { name: "WebRTC (WHEP)",  stars: "⭐⭐⭐⭐",  latency: "Ultra-Low (<200ms)",usecase: "Instant zero-plugin browser streaming, surveillance UI",      url: `http://${host}:8889/${cid}/whep` },
    { name: "HLS (m3u8)",     stars: "⭐⭐⭐",   latency: "1-2s",              usecase: "Universal web/mobile compatibility, Safari, iOS, Android",    url: `http://${host}:8888/${cid}/index.m3u8` },
    { name: "MJPEG over HTTP",stars: "⭐⭐⭐⭐",  latency: "Low-Medium",       usecase: "Legacy IP Camera web streams, Home Assistant, Axis cameras",   url: `http://${host}:8000/api/stream/${cid}/mjpeg` },
    { name: "HTTP Snapshot",  stars: "⭐⭐⭐⭐",  latency: "Instant",          usecase: "ANPR, AI triggers, thumbnails",                               url: `http://${host}:8000/api/stream/${cid}/snapshot.jpg` },
    { name: "SRT Transport",  stars: "⭐⭐⭐",   latency: "Low (~200ms)",      usecase: "Long-haul reliable video transport over public internet",      url: `srt://${host}:8890?streamid=read:${cid}` },
    { name: "RTMP Stream",    stars: "⭐⭐⭐",   latency: "Low-Medium",        usecase: "OBS Studio, YouTube Live, legacy RTMP NVR ingestion",         url: `rtmp://${host}:1935/${cid}` },
    { name: "Axis CGI URL",   stars: "⭐⭐⭐⭐",  latency: "Low",              usecase: "Drop-in compatibility for Axis CCTV video managers",           url: `http://${host}:8000/axis-cgi/mjpg/video.cgi?camera=${cid}` },
    { name: "ONVIF Snapshot", stars: "⭐⭐⭐⭐",  latency: "Instant",          usecase: "Drop-in ONVIF snapshot query for security panels",             url: `http://${host}:8000/onvif/snapshot?channel=${cid}` },
  ];

  protocols.forEach((p) => {
    const card = document.createElement("div");
    card.className = "proto-card";
    card.innerHTML = `
      <div class="proto-info">
        <div class="proto-top-row">
          <span class="proto-title">${p.name}</span>
          <span class="proto-stars">${p.stars}</span>
          <span class="proto-latency-badge"><i class="fa-solid fa-stopwatch"></i> ${p.latency}</span>
        </div>
        <div class="proto-usecase">${p.usecase}</div>
        <div class="proto-url-row">
          <span class="proto-url-text">${p.url}</span>
        </div>
      </div>
      <div class="proto-actions">
        <button class="btn-copy-proto" onclick="copyToClipboard('${p.url}')">
          <i class="fa-solid fa-copy"></i> Copy
        </button>
      </div>
    `;
    container.appendChild(card);
  });
}

function updateCodeSnippets(channelId) {
  const host = state.hostIp;
  const cid = channelId;

  const opencvEl = document.getElementById("code-opencv");
  if (opencvEl) {
    opencvEl.textContent = `import cv2

# Open GPU-accelerated RTSP Stream
rtsp_url = "rtsp://${host}:8554/${cid}"
cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

while True:
    ret, frame = cap.read()
    if not ret:
        break
    cv2.imshow("CCTV Feed: ${cid}", frame)
    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()`;
  }

  const vlcEl = document.getElementById("code-vlc");
  if (vlcEl) {
    vlcEl.textContent = `vlc --network-caching=150 rtsp://${host}:8554/${cid}`;
  }

  const frigateEl = document.getElementById("code-frigate");
  if (frigateEl) {
    frigateEl.textContent = `cameras:
  ${cid}:
    ffmpeg:
      inputs:
        - path: rtsp://${host}:8554/${cid}
          roles:
            - detect
            - record
    detect:
      width: 1280
      height: 720
      fps: 25`;
  }

  const haEl = document.getElementById("code-ha");
  if (haEl) {
    haEl.textContent = `camera:
  - platform: generic
    name: CCTV ${cid.toUpperCase()}
    still_image_url: http://${host}:8000/api/stream/${cid}/snapshot.jpg
    stream_source: rtsp://${host}:8554/${cid}`;
  }
}

function copySnippet(elementId) {
  const el = document.getElementById(elementId);
  if (el) {
    copyToClipboard(el.textContent);
  }
}

// ==========================================================================
// Video Upload & Form Handling
// ==========================================================================

let selectedUploadFile = null;

function openUploadModal() {
  document.getElementById("modal-upload").classList.remove("hidden");
  resetUploadForm();
}

function closeUploadModal() {
  document.getElementById("modal-upload").classList.add("hidden");
}

function resetUploadForm() {
  selectedUploadFile = null;
  document.getElementById("file-input").value = "";
  document.getElementById("selected-file-badge").classList.add("hidden");
  document.getElementById("upload-progress-wrap").classList.add("hidden");
  document.getElementById("progress-fill").style.width = "0%";
  document.getElementById("cfg-channel-id").value = "";
  document.getElementById("cfg-camera-name").value = "";
}

function initDragAndDrop() {
  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");

  ["dragenter", "dragover"].forEach((eventName) => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
    });
  });

  dropZone.addEventListener("drop", (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileSelected(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener("change", (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileSelected(e.target.files[0]);
    }
  });
}

function handleFileSelected(file) {
  selectedUploadFile = file;
  const badge = document.getElementById("selected-file-badge");
  const nameEl = document.getElementById("selected-file-name");

  badge.classList.remove("hidden");
  nameEl.textContent = `${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)`;

  // Auto-populate channel ID if empty
  const cidInput = document.getElementById("cfg-channel-id");
  const nameInput = document.getElementById("cfg-camera-name");
  const baseName = file.name.split(".")[0].toLowerCase().replace(/[^a-z0-9_-]/g, "_");

  if (!cidInput.value) {
    cidInput.value = baseName;
  }
  if (!nameInput.value) {
    nameInput.value = `CAM-${baseName.toUpperCase().slice(0, 10)} [SECURITY]`;
  }
}

async function submitVideoUpload() {
  if (!selectedUploadFile) {
    showToast("Please select or drop a video file first.", "error");
    return;
  }

  const cid = document.getElementById("cfg-channel-id").value.trim() || `cam_${Date.now()}`;
  const name = document.getElementById("cfg-camera-name").value.trim() || `CAMERA ${cid.toUpperCase()}`;
  const encoder = document.getElementById("cfg-encoder").value;
  const resolution = document.getElementById("cfg-resolution").value;
  const bitrate = document.getElementById("cfg-bitrate").value;
  const fps = document.getElementById("cfg-fps").value;
  const osd = document.getElementById("cfg-osd").checked;
  const loop = document.getElementById("cfg-loop").checked;

  const formData = new FormData();
  formData.append("file", selectedUploadFile);
  formData.append("auto_create_stream", "true");
  formData.append("channel_name", name);
  formData.append("encoder", encoder);
  formData.append("resolution", resolution);
  formData.append("bitrate", bitrate);
  formData.append("fps", fps);
  formData.append("osd_enabled", osd ? "true" : "false");
  formData.append("loop", loop ? "true" : "false");

  const progressWrap = document.getElementById("upload-progress-wrap");
  const progressFill = document.getElementById("progress-fill");
  const progressStatus = document.getElementById("progress-status");
  const btnSubmit = document.getElementById("btn-submit-upload");

  progressWrap.classList.remove("hidden");
  btnSubmit.disabled = true;

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/upload", true);

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      progressFill.style.width = `${pct}%`;
      progressStatus.textContent = `Uploading: ${pct}%...`;
    }
  };

  xhr.onload = async () => {
    btnSubmit.disabled = false;
    if (xhr.status === 200) {
      progressFill.style.width = "100%";
      progressStatus.textContent = "Transcoding pipeline initialized with GPU!";
      showToast("Video uploaded and CCTV stream started!", "success");
      setTimeout(() => {
        closeUploadModal();
        refreshChannels(true);
      }, 800);
    } else {
      showToast(`Upload failed: ${xhr.responseText}`, "error");
    }
  };

  xhr.onerror = () => {
    btnSubmit.disabled = false;
    showToast("Network error while uploading video.", "error");
  };

  xhr.send(formData);
}

// Generate Demo Channel
async function generateDemoFeed() {
  showToast("Generating CCTV security test pattern feed...", "info");
  try {
    const res = await fetch("/api/generate-demo", { method: "POST" });
    const data = await res.json();
    if (data.success) {
      showToast("Demo CCTV Camera stream active!", "success");
      refreshChannels(true);
    }
  } catch (err) {
    showToast(`Failed to generate demo feed: ${err}`, "error");
  }
}

// ==========================================================================
// Helper Utilities & UI Interactions
// ==========================================================================

function initGridPresetButtons() {
  const buttons = document.querySelectorAll("#grid-preset-buttons .btn-grid");
  const grid = document.getElementById("matrix-grid");

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      const mode = btn.dataset.grid;
      grid.className = "matrix-grid";
      if (mode === "1") grid.classList.add("grid-cols-1");
      else if (mode === "4") grid.classList.add("grid-cols-4");
      else if (mode === "9") grid.classList.add("grid-cols-9");
      else if (mode === "auto") grid.classList.add("grid-cols-auto");
    });
  });
}

function initTabs() {
  const tabBtns = document.querySelectorAll(".links-tab-bar .tab-btn");
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));

      btn.classList.add("active");
      const targetId = btn.dataset.tab;
      const target = document.getElementById(targetId);
      if (target) target.classList.add("active");
    });
  });
}

function startLiveClocks() {
  function updateTime() {
    const now = new Date();
    const timeStr = now.toTimeString().split(" ")[0];
    document.querySelectorAll(".live-time-clock").forEach((el) => {
      el.textContent = timeStr;
    });
  }
  updateTime();
  state.clockTimer = setInterval(updateTime, 1000);
}

function formatUptime(seconds) {
  if (!seconds || seconds <= 0) return "00:00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((v) => (v < 10 ? `0${v}` : `${v}`)).join(":");
}

function copyToClipboard(text) {
  navigator.clipboard
    .writeText(text)
    .then(() => {
      showToast("Copied to clipboard!", "success");
    })
    .catch(() => {
      // Fallback
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      showToast("Copied to clipboard!", "success");
    });
}

function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = "toast-msg";

  let icon = "fa-circle-info icon-cyan";
  if (type === "success") icon = "fa-circle-check icon-green";
  if (type === "error") icon = "fa-circle-exclamation icon-red";

  toast.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(100%)";
    toast.style.transition = "all 0.3s ease";
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// ==========================================================================
// Solo Camera Viewer Controller (Dedicated Single-Feed Surveillance Mode)
// ==========================================================================

function enterSoloView(channelId, updateUrl = true) {
  if (!channelId) return;
  state.isSoloMode = true;
  state.soloCamId = channelId.toLowerCase();

  // Stop any players running in the background matrix to save 100% bandwidth
  stopAllGridPlayers();

  // Hide the matrix grid dashboard workspace
  const matrixMain = document.getElementById("dashboard-main");
  if (matrixMain) matrixMain.classList.add("hidden");

  // Show the dedicated solo viewer monitor
  const soloContainer = document.getElementById("solo-viewer-container");
  if (soloContainer) soloContainer.classList.remove("hidden");

  // Update browser URL query param (?cam=cam1)
  if (updateUrl) {
    const url = new URL(window.location);
    url.searchParams.set("cam", state.soloCamId);
    window.history.pushState({ soloCam: state.soloCamId }, "", url);
  }

  // Update metadata in Solo UI & start dedicated single stream
  updateSoloCamUI();
  initSoloPlayer(state.soloCamId);
}

function exitSoloView() {
  state.isSoloMode = false;
  state.soloCamId = null;

  // Clean up solo player
  cleanupSoloPlayer();

  // Hide solo container and show matrix grid
  const soloContainer = document.getElementById("solo-viewer-container");
  if (soloContainer) soloContainer.classList.add("hidden");

  const matrixMain = document.getElementById("dashboard-main");
  if (matrixMain) matrixMain.classList.remove("hidden");

  // Remove ?cam= from browser URL
  const url = new URL(window.location);
  url.searchParams.delete("cam");
  url.searchParams.delete("watch");
  window.history.pushState({}, "", url.pathname + (url.search || ""));

  // Re-render and initialize matrix grid
  renderMatrixCards();
}

function switchSoloCam(newChannelId) {
  if (!newChannelId || newChannelId === state.soloCamId) return;
  enterSoloView(newChannelId, true);
}

function openLinksModalForSolo() {
  if (state.soloCamId) {
    openLinksModal(state.soloCamId);
  }
}

function copySoloShareLink() {
  const cid = state.soloCamId;
  if (!cid) return;
  const base = state.tunnelUrl ? state.tunnelUrl.replace(/\/$/, "") : window.location.origin;
  const link = `${base}/?cam=${cid}`;
  copyToClipboard(link);
  showToast(`📋 Public viewer link copied! Send to anyone to watch ${cid.toUpperCase()} live: ${link}`, "success");
}

function updateSoloCamUI() {
  const cid = state.soloCamId;
  if (!cid) return;

  const ch = state.channels.find((c) => c.channel_id.toLowerCase() === cid.toLowerCase());

  const titleEl = document.getElementById("solo-cam-title");
  const pillEl = document.getElementById("solo-cam-id-pill");
  const metaEl = document.getElementById("solo-cam-meta");
  const dotEl = document.getElementById("solo-cam-dot");
  const osdNameEl = document.getElementById("solo-osd-cam-name");
  const statBottomEl = document.getElementById("solo-stat-bottom");
  const uptimeEl = document.getElementById("solo-uptime");

  const displayName = ch ? ch.name : `CAM ${cid.toUpperCase()}`;
  if (titleEl) titleEl.textContent = displayName;
  if (pillEl) pillEl.textContent = cid.toUpperCase();
  if (osdNameEl) osdNameEl.textContent = displayName;

  if (ch) {
    const isRunning = ch.status === "running";
    if (dotEl) dotEl.className = `cam-live-dot ${isRunning ? "" : ch.status === "error" ? "error" : "stopped"}`;
    if (metaEl) metaEl.textContent = `${ch.resolution === 'native' ? '1080p' : ch.resolution} | ${ch.fps} FPS | ${ch.bitrate}`;
    if (statBottomEl) statBottomEl.textContent = `CH: ${cid.toUpperCase()} | ${ch.fps} FPS | H.264`;
    if (uptimeEl) uptimeEl.textContent = `UPTIME: ${formatUptime(ch.uptime_seconds)}`;
  }

  // Populate Camera Switcher Dropdown
  const select = document.getElementById("solo-cam-select");
  if (select && state.channels.length > 0) {
    select.innerHTML = "";
    state.channels.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.channel_id.toLowerCase();
      opt.textContent = `${c.channel_id.toUpperCase()} - ${c.name}`;
      if (c.channel_id.toLowerCase() === cid.toLowerCase()) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });
  }
}

function cleanupSoloPlayer() {
  if (state.soloPlayer) {
    if (state.soloPlayer.pc) state.soloPlayer.pc.close();
    if (state.soloPlayer.hls) state.soloPlayer.hls.destroy();
    if (state.soloPlayer.telemTimer) clearInterval(state.soloPlayer.telemTimer);
    state.soloPlayer = null;
  }
  const vid = document.getElementById("solo-vid");
  if (vid) {
    vid.pause();
    vid.removeAttribute("src");
    vid.srcObject = null;
  }
  const img = document.getElementById("solo-img");
  if (img) {
    img.src = "";
  }
}

function stopAllGridPlayers() {
  Object.keys(state.activePlayers).forEach((cid) => {
    const p = state.activePlayers[cid];
    if (p.pc) p.pc.close();
    if (p.hls) p.hls.destroy();
    if (p.telemTimer) clearInterval(p.telemTimer);
    delete state.activePlayers[cid];

    const vid = document.getElementById(`vid-${cid}`);
    if (vid) {
      vid.pause();
      vid.removeAttribute("src");
      vid.srcObject = null;
    }
    const img = document.getElementById(`img-${cid}`);
    if (img) img.src = "";
  });
}

function setSoloMode(mode) {
  initSoloPlayer(state.soloCamId, mode);
}

function initSoloPlayer(channelId, mode) {
  if (!channelId) return;

  // Auto-detect optimal protocol: over Cloudflare Tunnel (or remote HTTPS), HLS is preferred
  if (!mode) {
    const isCloudflare = window.location.hostname.includes("trycloudflare.com") || (window.location.protocol === "https:" && !window.location.hostname.includes("localhost"));
    mode = isCloudflare ? "hls" : "hls";
  }
  state.soloModeType = mode;

  // Sync mode button active states
  ["hls", "webrtc", "mjpeg"].forEach((m) => {
    const btn = document.getElementById(`solo-btn-${m}`);
    if (btn) btn.classList.toggle("active", m === mode);
  });

  const vid = document.getElementById("solo-vid");
  const img = document.getElementById("solo-img");
  const loadingIndicator = document.getElementById("solo-loading-indicator");
  const playOverlay = document.getElementById("solo-play-overlay");

  if (loadingIndicator) loadingIndicator.classList.remove("hidden");
  if (playOverlay) playOverlay.classList.add("hidden");

  cleanupSoloPlayer();

  if (mode === "mjpeg") {
    vid.classList.add("hidden");
    img.classList.remove("hidden");
    img.src = `/api/stream/${channelId}/mjpeg?t=${Date.now()}`;
    img.onload = () => {
      if (loadingIndicator) loadingIndicator.classList.add("hidden");
    };
    state.soloPlayer = { type: "mjpeg" };
    updateSoloTelemetryText("🟢 LIVE (MJPEG)");
    return;
  }

  // Video modes (HLS or WebRTC)
  img.classList.add("hidden");
  vid.classList.remove("hidden");
  vid.muted = true;
  vid.defaultMuted = true;
  vid.playsInline = true;
  vid.setAttribute("playsinline", "");
  vid.setAttribute("webkit-playsinline", "");
  vid.setAttribute("autoplay", "");

  if (mode === "webrtc") {
    startSoloWebRTC(channelId, vid);
  } else {
    startSoloHLS(channelId, vid);
  }
}

function startSoloHLS(channelId, vid) {
  const hlsUrl = `/hls/${channelId}/index.m3u8`;
  const loadingIndicator = document.getElementById("solo-loading-indicator");
  const playOverlay = document.getElementById("solo-play-overlay");

  vid.muted = true;
  vid.defaultMuted = true;
  vid.playsInline = true;
  setupSoloVideoTelemetry(channelId, vid);

  if (Hls.isSupported()) {
    const hls = new Hls({
      lowLatencyMode: false,
      backBufferLength: 10,
      maxBufferLength: 8,
      maxMaxBufferLength: 15,
      maxBufferSize: 20 * 1024 * 1024,
      enableWorker: true,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 6,
      manifestLoadingMaxRetry: 10,
      manifestLoadingRetryDelay: 1000,
      fragLoadingMaxRetry: 10,
      fragLoadingRetryDelay: 1000,
    });

    state.soloPlayer = { type: "hls", hls };

    hls.loadSource(hlsUrl);
    hls.attachMedia(vid);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      const playPromise = vid.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            if (loadingIndicator) loadingIndicator.classList.add("hidden");
            if (playOverlay) playOverlay.classList.add("hidden");
          })
          .catch((err) => {
            console.warn("[SOLO] Autoplay blocked, awaiting user tap:", err);
            if (loadingIndicator) loadingIndicator.classList.add("hidden");
            if (playOverlay) playOverlay.classList.remove("hidden");
          });
      }
    });

    hls.on(Hls.Events.FRAG_LOADED, () => {
      if (loadingIndicator) loadingIndicator.classList.add("hidden");
      if (playOverlay) playOverlay.classList.add("hidden");
    });

    let hlsFailCount = 0;
    hls.on(Hls.Events.ERROR, (event, data) => {
      console.warn("[SOLO HLS]", data.type, data.details, "fatal:", data.fatal);
      if (data.fatal) {
        hlsFailCount++;
        if (hlsFailCount >= 3) {
          console.warn("[SOLO] HLS multiple errors, auto-falling back to MJPEG");
          showToast(`Switching to instant MJPEG live feed for ${channelId.toUpperCase()}...`, "info");
          initSoloPlayer(channelId, "mjpeg");
          return;
        }
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            hls.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            break;
          default:
            hls.destroy();
            setTimeout(() => {
              if (state.isSoloMode && state.soloCamId === channelId) {
                initSoloPlayer(channelId, "hls");
              }
            }, 1500);
            break;
        }
      }
    });
  } else if (vid.canPlayType("application/vnd.apple.mpegurl")) {
    vid.src = hlsUrl;
    vid.addEventListener("loadedmetadata", () => {
      if (loadingIndicator) loadingIndicator.classList.add("hidden");
      vid.play().catch(() => {
        if (playOverlay) playOverlay.classList.remove("hidden");
      });
    }, { once: true });
    state.soloPlayer = { type: "hls_native" };
  } else {
    initSoloPlayer(channelId, "mjpeg");
  }
}

async function startSoloWebRTC(channelId, vid) {
  const loadingIndicator = document.getElementById("solo-loading-indicator");
  const playOverlay = document.getElementById("solo-play-overlay");

  try {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
    });
    state.soloPlayer = { type: "webrtc", pc };
    pc.addTransceiver("video", { direction: "recvonly" });

    vid.muted = true;
    setupSoloVideoTelemetry(channelId, vid);

    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        vid.srcObject = event.streams[0];
        if (loadingIndicator) loadingIndicator.classList.add("hidden");
        vid.play().catch(() => {
          if (playOverlay) playOverlay.classList.remove("hidden");
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") {
        console.warn(`WebRTC ICE failed for ${channelId}, switching to HLS`);
        showToast("WebRTC connection blocked by firewall/tunnel. Switching to HD HLS...", "info");
        initSoloPlayer(channelId, "hls");
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    if (pc.iceGatheringState !== "complete") {
      await new Promise((resolve) => {
        const onState = () => {
          if (pc.iceGatheringState === "complete") {
            pc.removeEventListener("icegatheringstatechange", onState);
            resolve();
          }
        };
        pc.addEventListener("icegatheringstatechange", onState);
        setTimeout(resolve, 600);
      });
    }

    const whepUrl = `/whep/${channelId}`;
    let res;
    try {
      res = await fetch(whepUrl, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: pc.localDescription.sdp,
      });
    } catch (_) {
      res = await fetch(`http://${state.hostIp}:8889/${channelId}/whep`, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: pc.localDescription.sdp,
      });
    }

    if (!res || !res.ok) {
      console.warn(`WHEP handshake failed for ${channelId}, switching to HLS`);
      initSoloPlayer(channelId, "hls");
      return;
    }

    const answerSdp = await res.text();
    await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: answerSdp }));
  } catch (err) {
    console.warn("WebRTC solo error, falling back to HLS:", err);
    initSoloPlayer(channelId, "hls");
  }
}

function setupSoloVideoTelemetry(channelId, videoEl) {
  const telemEl = document.getElementById("solo-telemetry");
  const statBottomEl = document.getElementById("solo-stat-bottom");
  let frameCount = 0;
  let lastFpsCalcTime = performance.now();
  let measuredFps = 0;

  if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
    const onFrame = (now) => {
      frameCount++;
      const elapsed = (now - lastFpsCalcTime) / 1000;
      if (elapsed >= 1.0) {
        measuredFps = (frameCount / elapsed).toFixed(1);
        frameCount = 0;
        lastFpsCalcTime = now;
      }
      if (state.soloPlayer) {
        videoEl.requestVideoFrameCallback(onFrame);
      }
    };
    videoEl.requestVideoFrameCallback(onFrame);
  }

  const timer = setInterval(() => {
    if (!state.isSoloMode || !videoEl) {
      clearInterval(timer);
      return;
    }

    let bufSec = 0;
    try {
      for (let i = 0; i < videoEl.buffered.length; i++) {
        if (videoEl.buffered.start(i) <= videoEl.currentTime && videoEl.currentTime <= videoEl.buffered.end(i)) {
          bufSec = (videoEl.buffered.end(i) - videoEl.currentTime).toFixed(1);
          break;
        }
      }
    } catch (_) {}

    if (telemEl) {
      if (videoEl.error) {
        telemEl.innerHTML = `<span style="color:#ef4444;">❌ ERR: ${videoEl.error.code}</span>`;
      } else if (videoEl.paused) {
        telemEl.innerHTML = `<span style="color:#f59e0b;">⏸ PAUSED</span>`;
      } else if (videoEl.readyState < 3) {
        telemEl.innerHTML = `<span style="color:#f59e0b;">⏳ BUFFERING (buf: ${bufSec}s)</span>`;
      } else {
        telemEl.innerHTML = `<span style="color:#10b981;">🟢 LIVE ${measuredFps || 30} FPS (buf: ${bufSec}s)</span>`;
      }
    }

    if (statBottomEl && videoEl.videoWidth > 0) {
      statBottomEl.textContent = `CH: ${channelId.toUpperCase()} | ${videoEl.videoWidth}x${videoEl.videoHeight} | H.264`;
    }
  }, 500);

  if (state.soloPlayer) {
    state.soloPlayer.telemTimer = timer;
  }
}

function updateSoloTelemetryText(text) {
  const telemEl = document.getElementById("solo-telemetry");
  if (telemEl) telemEl.textContent = text;
}

function resumeSoloPlayback() {
  const vid = document.getElementById("solo-vid");
  const playOverlay = document.getElementById("solo-play-overlay");
  if (vid) {
    vid.muted = true;
    vid.play().then(() => {
      if (playOverlay) playOverlay.classList.add("hidden");
    }).catch((err) => {
      console.error("Resume play failed:", err);
    });
  }
}

function toggleSoloMute() {
  const vid = document.getElementById("solo-vid");
  const icon = document.getElementById("solo-mute-icon");
  const text = document.getElementById("solo-mute-text");
  if (!vid) return;

  vid.muted = !vid.muted;
  if (icon) icon.className = vid.muted ? "fa-solid fa-volume-xmark" : "fa-solid fa-volume-high";
  if (text) text.textContent = vid.muted ? "Unmute" : "Mute";
}

function downloadSoloSnapshot() {
  if (!state.soloCamId) return;
  const url = `/api/stream/${state.soloCamId}/snapshot.jpg?t=${Date.now()}`;
  const a = document.createElement("a");
  a.href = url;
  a.download = `cctv_snapshot_${state.soloCamId}_${Date.now()}.jpg`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast("Snapshot saved successfully!", "success");
}

function reloadSoloStream() {
  if (!state.soloCamId) return;
  showToast(`Reconnecting to ${state.soloCamId.toUpperCase()}...`, "info");
  initSoloPlayer(state.soloCamId, state.soloModeType);
}

function toggleSoloFullscreen() {
  const stage = document.getElementById("solo-video-stage");
  if (!stage) return;
  if (!document.fullscreenElement) {
    if (stage.requestFullscreen) {
      stage.requestFullscreen();
    } else if (stage.webkitRequestFullscreen) {
      stage.webkitRequestFullscreen();
    }
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    }
  }
}

