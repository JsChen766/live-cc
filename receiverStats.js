/**
 * NON-INTRUSIVE PATCH
 * RECEIVER-SIDE ONLY
 * Lightweight remote playback stats for debugging and optional UI display.
 */

/**
 * @typedef {{
 *   timestamp: number;
 *   jitterMs?: number | null;
 *   jitterBufferDelayMs?: number | null;
 *   jitterBufferTargetDelayMs?: number | null;
 *   packetsLost?: number | null;
 *   framesDecoded?: number | null;
 *   framesDropped?: number | null;
 *   freezeCount?: number | null;
 *   width?: number | null;
 *   height?: number | null;
 * }} RemotePlaybackStats
 */

function safeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function secondsToMs(value) {
  return typeof value === "number" && Number.isFinite(value) ? value * 1000 : null;
}

function pickInboundVideoReport(stats) {
  let fallback = null;
  for (const report of stats.values()) {
    if (report.type !== "inbound-rtp" || report.kind !== "video" || report.isRemote) continue;
    fallback = report;
    break;
  }
  return fallback;
}

function cumulativeDelayToMs(report, delayField, countField) {
  const delay = safeNumber(report?.[delayField]);
  const count = safeNumber(report?.[countField]);
  if (delay === null) return null;
  if (count && count > 0) return (delay / count) * 1000;
  return delay * 1000;
}

export class ReceiverStatsCollector {
  constructor({ receiver, logger = console }) {
    this.receiver = receiver;
    this.logger = logger;
  }

  async sample() {
    try {
      const stats = await this.receiver?.getStats?.();
      if (!stats) return null;
      const inbound = pickInboundVideoReport(stats);
      if (!inbound) return null;

      /** @type {RemotePlaybackStats} */
      return {
        timestamp: Date.now(),
        jitterMs: secondsToMs(inbound.jitter),
        jitterBufferDelayMs: cumulativeDelayToMs(inbound, "jitterBufferDelay", "jitterBufferEmittedCount"),
        jitterBufferTargetDelayMs: cumulativeDelayToMs(
          inbound,
          "jitterBufferTargetDelay",
          "jitterBufferEmittedCount"
        ),
        packetsLost: safeNumber(inbound.packetsLost),
        framesDecoded: safeNumber(inbound.framesDecoded),
        framesDropped: safeNumber(inbound.framesDropped),
        freezeCount: safeNumber(inbound.freezeCount),
        width: safeNumber(inbound.frameWidth),
        height: safeNumber(inbound.frameHeight)
      };
    } catch (error) {
      this.logger.warn?.("[SmoothBuffer] receiver stats sample failed", error);
      return null;
    }
  }
}
