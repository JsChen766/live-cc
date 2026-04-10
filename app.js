class RealtimeApiClient {
  async request(path, init) {
    const response = await fetch(path, {
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {})
      },
      ...init
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body?.error?.message ?? "Request failed");
    }
    return body.data;
  }

  sessionNew(offerSdp) {
    return this.request("/api/realtime/sessions/new", {
      method: "POST",
      body: JSON.stringify({
        sessionDescription: { type: "offer", sdp: offerSdp }
      })
    });
  }

  tracksNew(sessionId, tracks, offerSdp) {
    const body = { tracks };
    if (offerSdp) {
      body.sessionDescription = { type: "offer", sdp: offerSdp };
    }
    return this.request(`/api/realtime/sessions/${encodeURIComponent(sessionId)}/tracks/new`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  renegotiate(sessionId, answerSdp) {
    return this.request(`/api/realtime/sessions/${encodeURIComponent(sessionId)}/renegotiate`, {
      method: "PUT",
      body: JSON.stringify({
        sessionDescription: { type: "answer", sdp: answerSdp }
      })
    });
  }

  closeTracks(sessionId, mids) {
    return this.request(`/api/realtime/sessions/${encodeURIComponent(sessionId)}/tracks/close`, {
      method: "PUT",
      body: JSON.stringify({
        force: true,
        tracks: mids.map((mid) => ({ mid }))
      })
    });
  }

  getCurrentLive() {
    return this.request("/api/live/current", { method: "GET" });
  }

  startLive(payload, hostToken) {
    return this.request("/api/live/start", {
      method: "POST",
      headers: hostToken ? { "x-host-token": hostToken } : {},
      body: JSON.stringify(payload)
    });
  }

  stopLive(hostToken) {
    return this.request("/api/live/stop", {
      method: "POST",
      headers: hostToken ? { "x-host-token": hostToken } : {},
      body: JSON.stringify({})
    });
  }
}

const api = new RealtimeApiClient();
const els = {
  mainVideo: document.getElementById("main-video"),
  emptyState: document.getElementById("empty-state"),
  emptyTitle: document.getElementById("empty-title"),
  emptyCopy: document.getElementById("empty-copy"),
  startBtn: document.getElementById("start-btn"),
  stopBtn: document.getElementById("stop-btn"),
  muteBtn: document.getElementById("mute-btn"),
  fullscreenBtn: document.getElementById("fullscreen-btn"),
  statusText: document.getElementById("status-text"),
  statusPill: document.getElementById("status-pill"),
  networkChip: document.getElementById("network-chip"),
  hostToken: document.getElementById("host-token"),
  resolutionSelect: document.getElementById("resolution-select"),
  fpsSelect: document.getElementById("fps-select"),
  audioToggle: document.getElementById("audio-toggle"),
  volumeRange: document.getElementById("volume-range"),
  qualitySelect: document.getElementById("quality-select"),
  metricConnection: document.getElementById("metric-connection"),
  metricAudio: document.getElementById("metric-audio"),
  metricQuality: document.getElementById("metric-quality"),
  metricRole: document.getElementById("metric-role")
};

const player = new Plyr(els.mainVideo, {
  controls: ["play", "progress", "current-time", "mute", "volume", "settings", "fullscreen"],
  fullscreen: { enabled: true, fallback: true, iosNative: true }
});

const state = {
  role: "viewer",
  hostPc: null,
  hostSessionId: null,
  hostLocalStream: null,
  hostPublishedTracks: [],
  viewerPc: null,
  viewerRemoteStream: null,
  viewerSessionId: null,
  activeLive: null,
  pollTimer: null
};

function setStatus(message, tone = "idle") {
  els.statusText.textContent = message;
  els.statusPill.textContent = tone === "live" ? "直播中" : tone === "error" ? "失败" : tone === "loading" ? "连接中" : "待机中";
  els.statusPill.className = `status-pill ${tone}`;
}

function showVideo(stream) {
  els.mainVideo.srcObject = stream;
  els.emptyState.style.display = "none";
  void els.mainVideo.play().catch(() => undefined);
}

function showEmpty(title, copy) {
  els.mainVideo.srcObject = null;
  els.emptyTitle.textContent = title;
  els.emptyCopy.textContent = copy;
  els.emptyState.style.display = "flex";
}

function updateMetrics() {
  els.metricRole.textContent = state.role === "host" ? "主播" : "观众";
  els.metricAudio.textContent = els.audioToggle.checked ? "系统音频" : "关闭";
  els.metricQuality.textContent = `${els.resolutionSelect.value} / ${els.fpsSelect.value}fps`;
}

function setButtons(hosting) {
  els.startBtn.disabled = hosting;
  els.stopBtn.disabled = !hosting;
}

function createRealtimePeerConnection() {
  return new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    bundlePolicy: "max-bundle"
  });
}

async function waitForConnected(pc, timeoutMs = 12000) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Realtime 初始连接超时。")), timeoutMs);
    const onState = () => {
      els.metricConnection.textContent = `${pc.connectionState} / ${pc.iceConnectionState}`;
      els.networkChip.textContent = `${pc.connectionState} / ${pc.iceConnectionState}`;
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        clearTimeout(timer);
        resolve();
      } else if (pc.iceConnectionState === "failed") {
        clearTimeout(timer);
        reject(new Error("Realtime ICE 连接失败。"));
      }
    };
    pc.addEventListener("iceconnectionstatechange", onState);
    onState();
  });
}

async function cleanupHostState() {
  try {
    if (state.hostSessionId && state.hostPublishedTracks.length > 0) {
      await api.closeTracks(state.hostSessionId, state.hostPublishedTracks.map((track) => track.mid).filter(Boolean));
    }
  } catch (error) {
    console.warn("close host tracks failed", error);
  }

  state.hostPc?.close();
  state.hostPc = null;
  state.hostSessionId = null;
  state.hostPublishedTracks = [];
  if (state.hostLocalStream) {
    state.hostLocalStream.getTracks().forEach((track) => track.stop());
    state.hostLocalStream = null;
  }
}

function cleanupViewerState() {
  state.viewerPc?.close();
  state.viewerPc = null;
  state.viewerSessionId = null;
  if (state.viewerRemoteStream) {
    state.viewerRemoteStream.getTracks().forEach((track) => track.stop());
    state.viewerRemoteStream = null;
  }
}

async function stopLive() {
  const hostToken = els.hostToken.value.trim();
  setStatus("正在停止直播...", "loading");
  try {
    await api.stopLive(hostToken);
  } catch (error) {
    console.warn("stop live state failed", error);
  }
  await cleanupHostState();
  state.activeLive = null;
  setButtons(false);
  updateMetrics();
  showEmpty("当前未开播", "主播点击右侧“开始投屏”后，观众访问本页会自动看到直播。");
  setStatus("直播已停止。", "idle");
}

async function startHostShare() {
  state.role = "host";
  updateMetrics();
  setStatus("正在请求屏幕共享...", "loading");
  cleanupViewerState();

  const hostToken = els.hostToken.value.trim();
  const resolution = els.resolutionSelect.value;
  const fps = Number(els.fpsSelect.value);
  const videoConstraints =
    resolution === "720p"
      ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: fps }
      : { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: fps };

  try {
    await cleanupHostState();
    const localStream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints,
      audio: els.audioToggle.checked
    });
    state.hostLocalStream = localStream;
    showVideo(localStream);

    const pc = createRealtimePeerConnection();
    state.hostPc = pc;

    const transceivers = localStream.getTracks().map((track) =>
      pc.addTransceiver(track, {
        direction: "sendonly"
      })
    );

    setStatus("正在创建 Realtime Session...", "loading");
    await pc.setLocalDescription(await pc.createOffer());
    const sessionResult = await api.sessionNew(pc.localDescription.sdp);
    state.hostSessionId = sessionResult.sessionId;
    await pc.setRemoteDescription(new RTCSessionDescription(sessionResult.sessionDescription));

    setStatus("等待初始连接建立...", "loading");
    await waitForConnected(pc);

    const publishedTracks = transceivers
      .map((transceiver) => {
        if (!transceiver.mid || !transceiver.sender.track) {
          return null;
        }
        return {
          location: "local",
          mid: transceiver.mid,
          trackName: `${transceiver.sender.track.kind}-${crypto.randomUUID().replaceAll("-", "")}`,
          kind: transceiver.sender.track.kind
        };
      })
      .filter(Boolean);

    setStatus("正在发布本地轨道...", "loading");
    await pc.setLocalDescription(await pc.createOffer());
    const publishResult = await api.tracksNew(state.hostSessionId, publishedTracks, pc.localDescription.sdp);
    await pc.setRemoteDescription(new RTCSessionDescription(publishResult.sessionDescription));

    state.hostPublishedTracks = publishedTracks;
    state.activeLive = {
      sessionId: state.hostSessionId,
      tracks: publishedTracks.map((track) => ({
        sessionId: state.hostSessionId,
        trackName: track.trackName,
        kind: track.kind
      })),
      startedAt: new Date().toISOString()
    };

    await api.startLive(state.activeLive, hostToken);
    setButtons(true);
    setStatus("直播已启动，其他访客访问同一页面会自动看到。", "live");
    els.networkChip.textContent = "Host Live";
  } catch (error) {
    console.error(error);
    setStatus(`启动失败：${error instanceof Error ? error.message : "Unknown error"}`, "error");
    await cleanupHostState();
    showEmpty("当前未开播", "主播点击右侧“开始投屏”后，观众访问本页会自动看到直播。");
  }
}

async function startViewerPlayback(liveState) {
  if (!liveState) return;
  if (state.viewerPc && state.viewerSessionId === liveState.sessionId) return;

  cleanupViewerState();
  state.role = "viewer";
  updateMetrics();
  setStatus("检测到直播，正在连接观看流...", "loading");

  try {
    const pc = createRealtimePeerConnection();
    state.viewerPc = pc;
    const remoteStream = new MediaStream();
    state.viewerRemoteStream = remoteStream;

    const hasVideo = liveState.tracks.some((track) => track.kind === "video");
    const hasAudio = liveState.tracks.some((track) => track.kind === "audio");
    if (hasVideo) pc.addTransceiver("video", { direction: "recvonly" });
    if (hasAudio) pc.addTransceiver("audio", { direction: "recvonly" });

    pc.ontrack = (event) => {
      if (event.streams[0]) {
        event.streams[0].getTracks().forEach((track) => {
          if (!remoteStream.getTracks().some((existing) => existing.id === track.id)) {
            remoteStream.addTrack(track);
          }
        });
      } else if (!remoteStream.getTracks().some((existing) => existing.id === event.track.id)) {
        remoteStream.addTrack(event.track);
      }
      showVideo(remoteStream);
    };

    await pc.setLocalDescription(await pc.createOffer());
    const sessionResult = await api.sessionNew(pc.localDescription.sdp);
    state.viewerSessionId = sessionResult.sessionId;
    await pc.setRemoteDescription(new RTCSessionDescription(sessionResult.sessionDescription));
    await waitForConnected(pc);

    const subscribeTracks = liveState.tracks.map((track) => ({
      location: "remote",
      sessionId: liveState.sessionId,
      trackName: track.trackName
    }));
    const subscribeResult = await api.tracksNew(state.viewerSessionId, subscribeTracks);
    if (subscribeResult.requiresImmediateRenegotiation && subscribeResult.sessionDescription?.type === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(subscribeResult.sessionDescription));
      await pc.setLocalDescription(await pc.createAnswer());
      await api.renegotiate(state.viewerSessionId, pc.localDescription.sdp);
    }

    els.mainVideo.muted = false;
    els.mainVideo.volume = Number(els.volumeRange.value) / 100;
    player.muted = false;
    player.volume = Number(els.volumeRange.value) / 100;
    setStatus("正在观看直播。", "live");
    els.networkChip.textContent = "Viewer Live";
  } catch (error) {
    console.error(error);
    cleanupViewerState();
    setStatus(`观看失败：${error instanceof Error ? error.message : "Unknown error"}`, "error");
    showEmpty("连接失败", "当前直播无法建立播放连接，请稍后重试。");
  }
}

async function refreshLiveState() {
  try {
    const result = await api.getCurrentLive();
    state.activeLive = result.live ?? null;
    if (state.activeLive) {
      if (state.role !== "host") {
        await startViewerPlayback(state.activeLive);
      }
    } else if (state.role !== "host") {
      cleanupViewerState();
      showEmpty("当前未开播", "主播点击右侧“开始投屏”后，观众访问本页会自动看到直播。");
      setStatus("当前未检测到直播。", "idle");
    }
  } catch (error) {
    console.warn("refreshLiveState failed", error);
  }
}

function startPolling() {
  if (state.pollTimer) window.clearInterval(state.pollTimer);
  state.pollTimer = window.setInterval(() => {
    if (state.role !== "host") {
      void refreshLiveState();
    }
  }, 5000);
}

els.startBtn.addEventListener("click", () => void startHostShare());
els.stopBtn.addEventListener("click", () => void stopLive());
els.muteBtn.addEventListener("click", () => {
  player.muted = !player.muted;
  els.mainVideo.muted = player.muted;
  els.muteBtn.textContent = player.muted ? "取消静音" : "静音";
});
els.fullscreenBtn.addEventListener("click", () => player.fullscreen.enter());
els.volumeRange.addEventListener("input", () => {
  const nextVolume = Number(els.volumeRange.value) / 100;
  player.volume = nextVolume;
  els.mainVideo.volume = nextVolume;
});
els.audioToggle.addEventListener("change", updateMetrics);
els.resolutionSelect.addEventListener("change", updateMetrics);
els.fpsSelect.addEventListener("change", updateMetrics);
els.qualitySelect.addEventListener("change", () => {
  setStatus(`播放器清晰度标记已切换到 ${els.qualitySelect.value}。`, state.activeLive ? "live" : "idle");
});

window.addEventListener("beforeunload", () => {
  if (state.role === "host") {
    navigator.sendBeacon("/api/live/stop");
  }
});

updateMetrics();
setButtons(false);
showEmpty("当前未开播", "主播点击右侧“开始投屏”后，观众访问本页会自动看到直播。");
setStatus("页面加载完成，正在检查当前直播状态。", "loading");
startPolling();
void refreshLiveState();
