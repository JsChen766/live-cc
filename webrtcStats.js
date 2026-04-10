/**
 * NON-INTRUSIVE PATCH
 * Standard WebRTC stats sampling with defensive fallbacks.
 */

/**
 * @typedef {"none" | "cpu" | "bandwidth" | "other" | "unknown"} QualityLimitationReason
 */

/**
 * @typedef {{
 *   timestamp: number;
 *   sourceFps: number | null;
 *   sourceWidth: number | null;
 *   sourceHeight: number | null;
 *   sentFps: number | null;
 *   sentWidth: number | null;
 *   sentHeight: number | null;
 *   bitrateKbps: number | null;
 *   availableOutgoingBitrateKbps: number | null;
 *   rttMs: number | null;
 *   qualityLimitationReason: QualityLimitationReason;
 *   packetsDiscardedOnSend: number | null;
 *   packetsDiscardedOnSendDelta: number | null;
 *   retransmittedBitrateKbps: number | null;
 *   packetsSentDelta: number | null;
 * }} RealtimeVideoMetrics
 */

function safeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toKbps(bytesDelta, elapsedMs) {
  if (!Number.isFinite(bytesDelta) || bytesDelta < 0 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  return (bytesDelta * 8) / elapsedMs;
}

function toFps(frameDelta, elapsedMs) {
  if (!Number.isFinite(frameDelta) || frameDelta < 0 || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  return (frameDelta * 1000) / elapsedMs;
}

function findTransportSelectedPairId(stats) {
  for (const report of stats.values()) {
    if (report.type === "transport" && report.selectedCandidatePairId) {
      return report.selectedCandidatePairId;
    }
  }
  return null;
}

function pickMediaSource(stats, senderTrackId) {
  let fallback = null;
  for (const report of stats.values()) {
    if (report.type !== "media-source" || report.kind !== "video") continue;
    if (senderTrackId && report.trackIdentifier === senderTrackId) {
      return report;
    }
    fallback = fallback ?? report;
  }
  return fallback;
}

function pickOutboundVideo(stats, senderTrackId) {
  let fallback = null;
  for (const report of stats.values()) {
    if (report.type !== "outbound-rtp" || report.kind !== "video" || report.isRemote) continue;
    if (senderTrackId && report.trackId === senderTrackId) {
      return report;
    }
    fallback = fallback ?? report;
  }
  return fallback;
}

function pickCandidatePair(stats) {
  const selectedPairId = findTransportSelectedPairId(stats);
  let fallback = null;
  for (const report of stats.values()) {
    if (report.type !== "candidate-pair") continue;
    if (selectedPairId && report.id === selectedPairId) return report;
    if (report.selected || report.nominated) return report;
    fallback = fallback ?? report;
  }
  return fallback;
}

export class WebRtcStatsCollector {
  constructor({ pc, sender, videoTrack, logger = console }) {
    this.pc = pc;
    this.sender = sender;
    this.videoTrack = videoTrack;
    this.logger = logger;
    this.previous = null;
  }

  async sample() {
    try {
      const stats = await this.pc.getStats();
      return this.buildMetrics(stats);
    } catch (error) {
      this.logger?.warn?.("webrtcStats: sample failed", error);
      return null;
    }
  }

  buildMetrics(stats) {
    const timestamp = Date.now();
    const senderTrackId = this.sender?.track?.id ?? this.videoTrack?.id ?? null;
    const mediaSource = pickMediaSource(stats, senderTrackId);
    const outbound = pickOutboundVideo(stats, senderTrackId);
    const candidatePair = pickCandidatePair(stats);

    const previous = this.previous;
    const elapsedMs = previous ? timestamp - previous.timestamp : 0;

    let sourceFps = safeNumber(mediaSource?.framesPerSecond);
    let sentFps = safeNumber(outbound?.framesPerSecond);

    if (sourceFps === null && previous?.mediaSourceFrames !== null && typeof mediaSource?.frames === "number") {
      sourceFps = toFps(mediaSource.frames - previous.mediaSourceFrames, elapsedMs);
    }

    if (sentFps === null && previous?.outboundFramesSent !== null && typeof outbound?.framesSent === "number") {
      sentFps = toFps(outbound.framesSent - previous.outboundFramesSent, elapsedMs);
    }

    const bitrateKbps =
      previous?.outboundBytesSent !== null && typeof outbound?.bytesSent === "number"
        ? toKbps(outbound.bytesSent - previous.outboundBytesSent, elapsedMs)
        : null;

    const retransmittedBitrateKbps =
      previous?.outboundRetransmittedBytesSent !== null && typeof outbound?.retransmittedBytesSent === "number"
        ? toKbps(outbound.retransmittedBytesSent - previous.outboundRetransmittedBytesSent, elapsedMs)
        : null;

    const packetsSentDelta =
      previous?.outboundPacketsSent !== null && typeof outbound?.packetsSent === "number"
        ? Math.max(0, outbound.packetsSent - previous.outboundPacketsSent)
        : null;

    const packetsDiscardedOnSend = safeNumber(candidatePair?.packetsDiscardedOnSend);
    const packetsDiscardedOnSendDelta =
      previous?.candidatePacketsDiscardedOnSend !== null && packetsDiscardedOnSend !== null
        ? Math.max(0, packetsDiscardedOnSend - previous.candidatePacketsDiscardedOnSend)
        : null;

    /** @type {RealtimeVideoMetrics} */
    const metrics = {
      timestamp,
      sourceFps,
      sourceWidth: safeNumber(mediaSource?.width),
      sourceHeight: safeNumber(mediaSource?.height),
      sentFps,
      sentWidth: safeNumber(outbound?.frameWidth),
      sentHeight: safeNumber(outbound?.frameHeight),
      bitrateKbps,
      availableOutgoingBitrateKbps: candidatePair?.availableOutgoingBitrate
        ? candidatePair.availableOutgoingBitrate / 1000
        : null,
      rttMs: candidatePair?.currentRoundTripTime ? candidatePair.currentRoundTripTime * 1000 : null,
      qualityLimitationReason: outbound?.qualityLimitationReason ?? "unknown",
      packetsDiscardedOnSend,
      packetsDiscardedOnSendDelta,
      retransmittedBitrateKbps,
      packetsSentDelta
    };

    this.previous = {
      timestamp,
      mediaSourceFrames: typeof mediaSource?.frames === "number" ? mediaSource.frames : null,
      outboundFramesSent: typeof outbound?.framesSent === "number" ? outbound.framesSent : null,
      outboundBytesSent: typeof outbound?.bytesSent === "number" ? outbound.bytesSent : null,
      outboundRetransmittedBytesSent:
        typeof outbound?.retransmittedBytesSent === "number" ? outbound.retransmittedBytesSent : null,
      outboundPacketsSent: typeof outbound?.packetsSent === "number" ? outbound.packetsSent : null,
      candidatePacketsDiscardedOnSend: packetsDiscardedOnSend
    };

    return metrics;
  }
}
