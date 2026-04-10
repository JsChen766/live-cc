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
  hostToken: document.getElementById("host-token"),
  resolutionSelect: document.getElementById("resolution-select"),
  fpsSelect: document.getElementById("fps-select"),
  audioToggle: document.getElementById("audio-toggle"),
  volumeRange: document.getElementById("volume-range"),
  qualitySelect: document.getElementById("quality-select")
};

const player = new Plyr(els.mainVideo, {
  controls: ["play", "progress", "current-time", "mute", "volume", "settings", "fullscreen"],
  fullscreen: { enabled: true, fallback: true, iosNative: true }
});

const IDLE_POLL_MS = 5000;
const LIVE_POLL_MS = 60000;
const HOST_STATS_POLL_MS = 5000;
const PROFILE_CHANGE_COOLDOWN_MS = 15000;
const VIDEO_PROFILES = {
  "1080p-60": {
    label: "1080p 60fps",
    width: 1920,
    height: 1080,
    frameRate: 60,
    maxBitrate: 8_000_000
  },
  "720p-60": {
    label: "720p 60fps",
    width: 1280,
    height: 720,
    frameRate: 60,
    maxBitrate: 4_500_000
  },
  "540p-60": {
    label: "540p 60fps",
    width: 960,
    height: 540,
    frameRate: 60,
    maxBitrate: 2_800_000
  },
  "1080p-30": {
    label: "1080p 30fps",
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrate: 5_000_000
  },
  "720p-30": {
    label: "720p 30fps",
    width: 1280,
    height: 720,
    frameRate: 30,
    maxBitrate: 2_500_000
  }
};
const AUTO_FALLBACKS = {
  "1080p-60": "720p-60",
  "720p-60": "540p-60",
  "540p-60": "720p-30",
  "1080p-30": "720p-30",
  "720p-30": null
};

const state = {
  role: "viewer",
  hostPc: null,
  hostSessionId: null,
  hostLocalStream: null,
  hostPublishedTracks: [],
  hostStatsTimer: null,
  hostSelectedProfileKey: null,
  hostAppliedProfileKey: null,
  hostLastProfileChangeAt: 0,
  viewerPc: null,
  viewerRemoteStream: null,
  viewerSessionId: null,
  viewerLiveSessionId: null,
  viewerConnectingLiveSessionId: null,
  activeLive: null,
  pollTimer: null,
  pollIntervalMs: IDLE_POLL_MS,
  refreshInFlight: false
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

function setButtons(hosting) {
  els.startBtn.disabled = hosting;
  els.stopBtn.disabled = !hosting;
}

function setPollingInterval(intervalMs) {
  if (state.pollIntervalMs === intervalMs && state.pollTimer) return;
  state.pollIntervalMs = intervalMs;
  startPolling();
}

function resumeIdlePolling() {
  setPollingInterval(IDLE_POLL_MS);
}

function useLivePolling() {
  setPollingInterval(LIVE_POLL_MS);
}

function createRealtimePeerConnection() {
  return new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    bundlePolicy: "max-bundle"
  });
}

function getSelectedVideoProfileKey() {
  const resolution = els.resolutionSelect.value;
  const fps = Number(els.fpsSelect.value);
  if (resolution === "1080p" && fps >= 60) return "1080p-60";
  if (resolution === "720p" && fps >= 60) return "720p-60";
  if (resolution === "1080p") return "1080p-30";
  return "720p-30";
}

function getVideoConstraintsForProfile(profileKey) {
  const profile = VIDEO_PROFILES[profileKey] ?? VIDEO_PROFILES["720p-30"];
  return {
    width: { ideal: profile.width, max: profile.width },
    height: { ideal: profile.height, max: profile.height },
    frameRate: { ideal: profile.frameRate, max: profile.frameRate }
  };
}

async function configureVideoSender(videoTrack, sender, profileKey) {
  const profile = VIDEO_PROFILES[profileKey] ?? VIDEO_PROFILES["720p-30"];
  await videoTrack.applyConstraints(getVideoConstraintsForProfile(profileKey));
  videoTrack.contentHint = profile.frameRate >= 60 ? "motion" : "detail";

  try {
    const parameters = sender.getParameters();
    const encoding = parameters.encodings?.[0] ?? {};
    encoding.maxBitrate = profile.maxBitrate;
    encoding.maxFramerate = profile.frameRate;
    encoding.scaleResolutionDownBy = 1;
    parameters.encodings = [encoding];
    parameters.degradationPreference = "maintain-framerate";
    await sender.setParameters(parameters);
  } catch (error) {
    console.warn("setParameters unsupported, falling back to track constraints only", error);
  }

  state.hostAppliedProfileKey = profileKey;
  state.hostLastProfileChangeAt = Date.now();
}

function stopHostQualityMonitor() {
  if (state.hostStatsTimer) {
    window.clearInterval(state.hostStatsTimer);
    state.hostStatsTimer = null;
  }
}

function startHostQualityMonitor(videoTrack, sender) {
  stopHostQualityMonitor();
  state.hostStatsTimer = window.setInterval(async () => {
    if (state.role !== "host" || !state.hostPc || sender.transport?.state === "closed") {
      stopHostQualityMonitor();
      return;
    }

    try {
      const stats = await sender.getStats();
      let outboundVideo = null;
      stats.forEach((report) => {
        if (report.type === "outbound-rtp" && report.kind === "video" && !report.isRemote) {
          outboundVideo = report;
        }
      });
      if (!outboundVideo) return;

      const currentProfileKey = state.hostAppliedProfileKey;
      const currentProfile = VIDEO_PROFILES[currentProfileKey];
      if (!currentProfile) return;

      const measuredFps = Number(outboundVideo.framesPerSecond ?? 0);
      const limitationReason = outboundVideo.qualityLimitationReason ?? "none";
      const targetFps = currentProfile.frameRate;
      const hasLowFps = measuredFps > 0 && measuredFps < Math.max(45, targetFps * 0.85);
      const fallbackProfileKey = AUTO_FALLBACKS[currentProfileKey];
      const cooledDown = Date.now() - state.hostLastProfileChangeAt > PROFILE_CHANGE_COOLDOWN_MS;
      const shouldDowngrade =
        fallbackProfileKey &&
        cooledDown &&
        hasLowFps &&
        ["bandwidth", "cpu", "other"].includes(limitationReason);

      if (!shouldDowngrade) return;

      await configureVideoSender(videoTrack, sender, fallbackProfileKey);
      const fallbackProfile = VIDEO_PROFILES[fallbackProfileKey];
      setStatus(
        `检测到发送帧率偏低（约 ${Math.round(measuredFps)} fps），已自动切换到更稳的 ${fallbackProfile.label}。`,
        "live"
      );
    } catch (error) {
      console.warn("host quality monitor failed", error);
    }
  }, HOST_STATS_POLL_MS);
}

async function waitForConnected(pc, timeoutMs = 12000) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Realtime 初始连接超时。")), timeoutMs);
    const onState = () => {
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
  state.hostSelectedProfileKey = null;
  state.hostAppliedProfileKey = null;
  state.hostLastProfileChangeAt = 0;
  stopHostQualityMonitor();
  if (state.hostLocalStream) {
    state.hostLocalStream.getTracks().forEach((track) => track.stop());
    state.hostLocalStream = null;
  }
}

function cleanupViewerState() {
  state.viewerPc?.close();
  state.viewerPc = null;
  state.viewerSessionId = null;
  state.viewerLiveSessionId = null;
  state.viewerConnectingLiveSessionId = null;
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
  showEmpty("当前未开播", "主播开始投屏后，这个页面会自动播放直播。");
  setStatus("直播已停止。", "idle");
  resumeIdlePolling();
}

async function startHostShare() {
  state.role = "host";
  setStatus("正在请求屏幕共享...", "loading");
  cleanupViewerState();
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  const hostToken = els.hostToken.value.trim();
  const selectedProfileKey = getSelectedVideoProfileKey();
  const videoConstraints = getVideoConstraintsForProfile(selectedProfileKey);

  try {
    await cleanupHostState();
    const localStream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints,
      audio: els.audioToggle.checked
    });
    state.hostLocalStream = localStream;
    state.hostSelectedProfileKey = selectedProfileKey;
    showVideo(localStream);

    const pc = createRealtimePeerConnection();
    state.hostPc = pc;

    const transceivers = localStream.getTracks().map((track) =>
      pc.addTransceiver(track, {
        direction: "sendonly"
      })
    );
    const videoTrack = localStream.getVideoTracks()[0] ?? null;
    const videoTransceiver = transceivers.find((transceiver) => transceiver.sender.track?.kind === "video") ?? null;
    if (videoTrack && videoTransceiver?.sender) {
      await configureVideoSender(videoTrack, videoTransceiver.sender, selectedProfileKey);
    }

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
    if (videoTrack && videoTransceiver?.sender) {
      startHostQualityMonitor(videoTrack, videoTransceiver.sender);
    }
    setButtons(true);
    setStatus(
      `直播已启动，当前发送档位 ${VIDEO_PROFILES[state.hostAppliedProfileKey ?? selectedProfileKey].label}。`,
      "live"
    );
  } catch (error) {
    console.error(error);
    setStatus(`启动失败：${error instanceof Error ? error.message : "Unknown error"}`, "error");
    await cleanupHostState();
    showEmpty("当前未开播", "主播开始投屏后，这个页面会自动播放直播。");
  }
}

async function startViewerPlayback(liveState) {
  if (!liveState) return;
  if (state.viewerLiveSessionId === liveState.sessionId && state.viewerPc) return;
  if (state.viewerConnectingLiveSessionId === liveState.sessionId) return;

  cleanupViewerState();
  state.viewerConnectingLiveSessionId = liveState.sessionId;
  state.role = "viewer";
  setStatus("检测到直播，正在连接观看流...", "loading");

  try {
    const pc = createRealtimePeerConnection();
    state.viewerPc = pc;
    const remoteStream = new MediaStream();
    state.viewerRemoteStream = remoteStream;
    let recovering = false;

    const recoverViewerPlayback = () => {
      if (recovering) return;
      recovering = true;
      if (state.role !== "viewer") return;
      cleanupViewerState();
      showEmpty("直播已断开", "正在重新检查直播状态。");
      setStatus("播放连接已断开，正在重新检查直播状态。", "loading");
      resumeIdlePolling();
      void refreshLiveState();
    };

    const hasVideo = liveState.tracks.some((track) => track.kind === "video");
    const hasAudio = liveState.tracks.some((track) => track.kind === "audio");
    if (hasVideo) pc.addTransceiver("video", { direction: "recvonly" });
    if (hasAudio) pc.addTransceiver("audio", { direction: "recvonly" });

    pc.addEventListener("connectionstatechange", () => {
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        recoverViewerPlayback();
      }
    });

    pc.ontrack = (event) => {
      if (event.streams[0]) {
        event.streams[0].getTracks().forEach((track) => {
          if (!remoteStream.getTracks().some((existing) => existing.id === track.id)) {
            remoteStream.addTrack(track);
          }
          track.addEventListener("ended", recoverViewerPlayback, { once: true });
        });
      } else if (!remoteStream.getTracks().some((existing) => existing.id === event.track.id)) {
        remoteStream.addTrack(event.track);
        event.track.addEventListener("ended", recoverViewerPlayback, { once: true });
      }
      showVideo(remoteStream);
    };

    await pc.setLocalDescription(await pc.createOffer());
    const sessionResult = await api.sessionNew(pc.localDescription.sdp);
    state.viewerSessionId = sessionResult.sessionId;
    state.viewerLiveSessionId = liveState.sessionId;
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
    useLivePolling();
  } catch (error) {
    console.error(error);
    cleanupViewerState();
    setStatus(`观看失败：${error instanceof Error ? error.message : "Unknown error"}`, "error");
    showEmpty("连接失败", "当前直播无法建立播放连接，请稍后重试。");
    resumeIdlePolling();
  } finally {
    state.viewerConnectingLiveSessionId = null;
  }
}

async function refreshLiveState() {
  if (state.refreshInFlight) return;
  state.refreshInFlight = true;
  try {
    const result = await api.getCurrentLive();
    state.activeLive = result.live ?? null;
    if (state.activeLive) {
      if (state.role !== "host") {
        await startViewerPlayback(state.activeLive);
      }
    } else if (state.role !== "host") {
      cleanupViewerState();
      showEmpty("当前未开播", "主播开始投屏后，这个页面会自动播放直播。");
      setStatus("当前未检测到直播。", "idle");
      resumeIdlePolling();
    }
  } catch (error) {
    console.warn("refreshLiveState failed", error);
  } finally {
    state.refreshInFlight = false;
  }
}

function startPolling() {
  if (state.pollTimer) window.clearInterval(state.pollTimer);
  state.pollTimer = window.setInterval(() => {
    if (state.role !== "host") {
      void refreshLiveState();
    }
  }, state.pollIntervalMs);
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
els.qualitySelect.addEventListener("change", () => {
  setStatus(`播放器清晰度标记已切换到 ${els.qualitySelect.value}。`, state.activeLive ? "live" : "idle");
});

window.addEventListener("beforeunload", () => {
  if (state.role === "host") {
    navigator.sendBeacon("/api/live/stop");
  }
});

setButtons(false);
showEmpty("当前未开播", "主播开始投屏后，这个页面会自动播放直播。");
setStatus("页面加载完成，正在检查当前直播状态。", "loading");
startPolling();
void refreshLiveState();
