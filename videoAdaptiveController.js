/**
 * NON-INTRUSIVE PATCH
 * Stable-first sender clarity control for game screen sharing. This controller
 * only observes WebRTC stats and gently updates RTCRtpSender encodings; it does
 * not own or modify the Cloudflare Realtime publish/subscribe flow.
 */

import { applyProfile, DEFAULT_START_PROFILE, getProfileConfig } from "./applyProfile.js";
import {
  DEFAULT_SENDER_QUALITY_INDEX,
  getNextHigherQualityIndex,
  getNextLowerQualityIndex,
  getSenderQualityBudget,
  MIN_SENDER_QUALITY_INDEX
} from "./senderQualityBudget.js";
import { WebRtcStatsCollector } from "./webrtcStats.js";

const SAMPLE_INTERVAL_MS = 1000;
const STARTUP_STABLE_GUARD_MS = 10000;
const SWITCH_COOLDOWN_MS = 8000;
const UPGRADE_WINDOW_SIZE = 8;
const DOWNGRADE_WINDOW_SIZE = 3;
const RECOVERY_WINDOW_SIZE = 12;
const LOG_THROTTLE_MS = 4000;
const RTT_NORMAL_MS = 140;
const RTT_HIGH_MS = 240;
const RTT_SEVERE_MS = 320;
const LOW_BITRATE_KBPS = 500;
const AVAILABLE_BITRATE_MARGIN = 1.25;
const RETRANSMIT_WARN_KBPS = 180;

function avg(values) {
  const valid = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (valid.length === 0) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function tail(items, size) {
  return items.slice(Math.max(0, items.length - size));
}

function avgField(samples, field, size) {
  return avg(tail(samples, size).map((sample) => sample[field]));
}

function hasReason(samples, reason, size) {
  return tail(samples, size).some((sample) => sample.qualityLimitationReason === reason);
}

function hasBadQualityLimitation(samples, size) {
  return tail(samples, size).some((sample) => ["cpu", "bandwidth"].includes(sample.qualityLimitationReason));
}

function mostlyNoQualityLimitation(samples, size) {
  const items = tail(samples, size);
  if (items.length < size) return false;
  const badCount = items.filter((sample) => ["cpu", "bandwidth"].includes(sample.qualityLimitationReason)).length;
  const noneCount = items.filter((sample) => sample.qualityLimitationReason === "none").length;
  const unknownCount = items.filter((sample) => sample.qualityLimitationReason === "unknown").length;
  return badCount === 0 && (noneCount >= Math.ceil(size * 0.6) || noneCount + unknownCount === size);
}

function hasPacketDiscardWorsening(samples, size) {
  return tail(samples, size).some((sample) => (sample.packetsDiscardedOnSendDelta ?? 0) > 0);
}

function hasRetransmitWorsening(samples, size) {
  return tail(samples, size).some((sample) => (sample.retransmittedBitrateKbps ?? 0) > RETRANSMIT_WARN_KBPS);
}

function isAvailableBitrateEnough(samples, size, budget) {
  const avgAvailable = avgField(samples, "availableOutgoingBitrateKbps", size);
  if (avgAvailable === null) return true;
  const requiredKbps = Math.max(budget.minAvailableOutgoingBitrateKbps, (budget.maxBitrate / 1000) * AVAILABLE_BITRATE_MARGIN);
  return avgAvailable >= requiredKbps;
}

function isAvailableBitrateDropping(samples) {
  const items = tail(samples, 4);
  if (items.length < 4) return false;
  const first = items[0].availableOutgoingBitrateKbps;
  const last = items[items.length - 1].availableOutgoingBitrateKbps;
  if (typeof first !== "number" || typeof last !== "number") return false;
  return last < first * 0.68;
}

function profileForDebug(profile, qualityBudget) {
  return `${getProfileConfig(profile).label}/${qualityBudget.id}`;
}

export class VideoAdaptiveController {
  constructor({
    pc,
    videoSender,
    videoTrack,
    initialProfile = DEFAULT_START_PROFILE,
    initialQualityIndex = DEFAULT_SENDER_QUALITY_INDEX,
    logger = console,
    onProfileChanged,
    onUserMessage,
    onDebugSample,
    onStateChange
  }) {
    this.pc = pc;
    this.videoSender = videoSender;
    this.videoTrack = videoTrack;
    this.logger = logger;
    this.onProfileChanged = onProfileChanged;
    this.onUserMessage = onUserMessage;
    this.onDebugSample = onDebugSample;
    this.onStateChange = onStateChange;
    this.currentProfile = initialProfile === "SD_30" ? "SD_30" : "HD_30";
    this.qualityIndex = initialQualityIndex;
    this.samples = [];
    this.timer = null;
    this.startedAt = 0;
    this.lastSwitchAt = 0;
    this.lastDegradeReason = null;
    this.lastLogAtByKey = new Map();
    this.statsCollector = new WebRtcStatsCollector({ pc, sender: videoSender, videoTrack, logger });
  }

  async start() {
    this.startedAt = Date.now();
    await this.applyCurrentBudget("init", "发送端以 720p30 稳定档启动，清晰度预算由系统自动寻优", true);
    this.timer = window.setInterval(() => {
      void this.tick();
    }, SAMPLE_INTERVAL_MS);
  }

  stop() {
    if (this.timer) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  getState() {
    const last = this.samples[this.samples.length - 1] ?? null;
    const budget = getSenderQualityBudget(this.qualityIndex);
    return {
      sendProfile: this.currentProfile,
      sendStable: this.isSendStable(),
      sourceFps: last?.sourceFps ?? null,
      sentFps: last?.sentFps ?? null,
      senderQualityLevel: budget.id,
      senderQualityMaxBitrate: budget.maxBitrate,
      lastDegradeReason: this.lastDegradeReason
    };
  }

  async tick() {
    const metrics = await this.statsCollector.sample();
    if (!metrics) return;

    this.samples.push(metrics);
    if (this.samples.length > 20) this.samples.shift();

    this.emitDebug(metrics);
    this.emitState();

    const severe = this.evaluateSevereFallback();
    if (severe) {
      await this.transition(severe, true);
      return;
    }

    const inCooldown = Date.now() - this.lastSwitchAt < SWITCH_COOLDOWN_MS;
    if (!inCooldown) {
      const degrade = this.evaluateDegrade();
      if (degrade) {
        await this.transition(degrade, false);
        return;
      }
    }

    const upgrade = this.evaluateUpgrade();
    if (upgrade) {
      await this.transition(upgrade, false);
    }
  }

  evaluateSevereFallback() {
    const sentAvg3 = avgField(this.samples, "sentFps", DOWNGRADE_WINDOW_SIZE);
    const rttAvg3 = avgField(this.samples, "rttMs", DOWNGRADE_WINDOW_SIZE);
    const bitrateAvg3 = avgField(this.samples, "bitrateKbps", DOWNGRADE_WINDOW_SIZE);

    const severe =
      (typeof sentAvg3 === "number" && sentAvg3 < 20) ||
      (typeof rttAvg3 === "number" && rttAvg3 > RTT_SEVERE_MS) ||
      (typeof bitrateAvg3 === "number" && bitrateAvg3 < LOW_BITRATE_KBPS);

    if (!severe) return null;

    if (this.currentProfile !== "SD_30") {
      return {
        profile: "SD_30",
        qualityIndex: MIN_SENDER_QUALITY_INDEX,
        reason: "severe-fallback",
        message: "发送端检测到严重不稳定，已回退到 540p30 兜底档"
      };
    }

    if (this.qualityIndex !== MIN_SENDER_QUALITY_INDEX) {
      const nextIndex = getNextLowerQualityIndex(this.qualityIndex);
      return {
        profile: "SD_30",
        qualityIndex: nextIndex,
        reason: "severe-fallback",
        message: `发送端严重不稳定，已自动降低内部清晰度等级到 ${getSenderQualityBudget(nextIndex).id}`
      };
    }

    return null;
  }

  evaluateDegrade() {
    if (this.samples.length < DOWNGRADE_WINDOW_SIZE) return null;

    const sentAvg3 = avgField(this.samples, "sentFps", DOWNGRADE_WINDOW_SIZE);
    const rttAvg3 = avgField(this.samples, "rttMs", DOWNGRADE_WINDOW_SIZE);
    const sourceAvg3 = avgField(this.samples, "sourceFps", DOWNGRADE_WINDOW_SIZE);
    const bandwidthLimited = hasReason(this.samples, "bandwidth", DOWNGRADE_WINDOW_SIZE);
    const cpuLimited = hasReason(this.samples, "cpu", DOWNGRADE_WINDOW_SIZE);
    const frameUnstable = typeof sentAvg3 === "number" && sentAvg3 < 28;
    const sourceUnstable = typeof sourceAvg3 === "number" && sourceAvg3 < 28;
    const rttHigh = typeof rttAvg3 === "number" && rttAvg3 > RTT_HIGH_MS;
    const availableDropping = isAvailableBitrateDropping(this.samples);
    const packetWorsening = hasPacketDiscardWorsening(this.samples, DOWNGRADE_WINDOW_SIZE);
    const retransmitWorsening = hasRetransmitWorsening(this.samples, DOWNGRADE_WINDOW_SIZE);

    if (!bandwidthLimited && !cpuLimited && !frameUnstable && !sourceUnstable && !rttHigh && !availableDropping && !packetWorsening && !retransmitWorsening) {
      return null;
    }

    const reason = bandwidthLimited
      ? "bandwidth"
      : cpuLimited
        ? "cpu"
        : frameUnstable || sourceUnstable
          ? "frame-unstable"
          : rttHigh
            ? "rtt-high"
            : availableDropping
              ? "available-bitrate-drop"
              : packetWorsening
                ? "packet-discarded"
                : "retransmit";

    if (this.qualityIndex > MIN_SENDER_QUALITY_INDEX) {
      const nextIndex = getNextLowerQualityIndex(this.qualityIndex);
      const prefix = bandwidthLimited ? "检测到带宽受限" : "检测到发送端开始不稳定";
      return {
        profile: this.currentProfile,
        qualityIndex: nextIndex,
        reason,
        message: `${prefix}，已自动降低内部清晰度等级到 ${getSenderQualityBudget(nextIndex).id}`
      };
    }

    if (this.currentProfile === "HD_30") {
      return {
        profile: "SD_30",
        qualityIndex: MIN_SENDER_QUALITY_INDEX,
        reason,
        message: "在最低清晰度预算下仍不稳定，已从 720p30 回退到 540p30"
      };
    }

    return null;
  }

  evaluateUpgrade() {
    const now = Date.now();
    if (now - this.startedAt < STARTUP_STABLE_GUARD_MS) return null;
    if (now - this.lastSwitchAt < SWITCH_COOLDOWN_MS) return null;

    if (this.currentProfile === "SD_30") {
      if (!this.isStableFor(RECOVERY_WINDOW_SIZE, getSenderQualityBudget(MIN_SENDER_QUALITY_INDEX))) return null;
      return {
        profile: "HD_30",
        qualityIndex: MIN_SENDER_QUALITY_INDEX,
        reason: "recover-resolution",
        message: "链路持续稳定，已从 540p30 恢复到 720p30 最低清晰度预算"
      };
    }

    const nextIndex = getNextHigherQualityIndex(this.qualityIndex);
    if (nextIndex === this.qualityIndex) return null;
    const nextBudget = getSenderQualityBudget(nextIndex);

    if (!this.isStableFor(UPGRADE_WINDOW_SIZE, nextBudget)) return null;

    return {
      profile: "HD_30",
      qualityIndex: nextIndex,
      reason: "upgrade-quality-budget",
      message: `链路稳定，已自动提升内部清晰度等级到 ${nextBudget.id}`
    };
  }

  isStableFor(size, targetBudget) {
    if (this.samples.length < size) return false;

    const sourceAvg = avgField(this.samples, "sourceFps", size);
    const sentAvg = avgField(this.samples, "sentFps", size);
    const rttAvg = avgField(this.samples, "rttMs", size);

    const fpsStable =
      (sourceAvg === null || sourceAvg >= 29) &&
      (sentAvg === null || sentAvg >= 29);
    const rttStable = rttAvg === null || rttAvg < RTT_NORMAL_MS;

    return (
      fpsStable &&
      rttStable &&
      mostlyNoQualityLimitation(this.samples, size) &&
      isAvailableBitrateEnough(this.samples, size, targetBudget) &&
      !hasPacketDiscardWorsening(this.samples, size) &&
      !hasRetransmitWorsening(this.samples, size) &&
      !hasBadQualityLimitation(this.samples, size)
    );
  }

  async transition(action, bypassCooldown) {
    if (!action) return;
    if (!bypassCooldown && Date.now() - this.lastSwitchAt < SWITCH_COOLDOWN_MS) return;

    const previousProfile = this.currentProfile;
    const previousQualityIndex = this.qualityIndex;
    this.currentProfile = action.profile;
    this.qualityIndex = action.qualityIndex;

    const result = await this.applyCurrentBudget(action.reason, action.message, false, previousProfile);
    if (!result.ok) {
      this.currentProfile = previousProfile;
      this.qualityIndex = previousQualityIndex;
      this.throttledLog(
        `transition-failed:${action.reason}`,
        "warn",
        "发送端自动清晰度调整失败，已保持原直播参数继续推流"
      );
    }
  }

  async applyCurrentBudget(reason, message, isInitial, previousProfile = this.currentProfile) {
    const budget = getSenderQualityBudget(this.qualityIndex);
    const result = await applyProfile({
      profile: this.currentProfile,
      videoTrack: this.videoTrack,
      videoSender: this.videoSender,
      logger: this.logger,
      maxBitrateOverride: budget.maxBitrate
    });

    if (!result.ok) return result;

    this.lastSwitchAt = Date.now();
    this.lastDegradeReason = reason.startsWith("upgrade") || reason.startsWith("recover") || reason === "init" ? null : reason;
    this.onProfileChanged?.({
      reason,
      profile: this.currentProfile,
      previousProfile,
      profileLabel: getProfileConfig(this.currentProfile).label,
      qualityLevel: budget.id,
      maxBitrate: budget.maxBitrate,
      trackSettings: this.videoTrack.getSettings?.() ?? null
    });
    this.throttledLog(`sender-budget:${reason}:${this.currentProfile}:${budget.id}`, "info", message);
    if (isInitial || previousProfile !== this.currentProfile) {
      this.onUserMessage?.(message);
    }
    this.emitState();
    return result;
  }

  isSendStable() {
    const sourceAvg3 = avgField(this.samples, "sourceFps", DOWNGRADE_WINDOW_SIZE);
    const sentAvg3 = avgField(this.samples, "sentFps", DOWNGRADE_WINDOW_SIZE);
    if (sourceAvg3 === null || sentAvg3 === null) return true;
    return sourceAvg3 >= 28 && sentAvg3 >= 28 && !hasBadQualityLimitation(this.samples, DOWNGRADE_WINDOW_SIZE);
  }

  emitDebug(metrics) {
    const budget = getSenderQualityBudget(this.qualityIndex);
    const payload = {
      layer: "sender",
      profile: this.currentProfile,
      profileLabel: profileForDebug(this.currentProfile, budget),
      sourceFps: metrics.sourceFps,
      sentFps: metrics.sentFps,
      bitrateKbps: metrics.bitrateKbps,
      availableOutgoingBitrateKbps: metrics.availableOutgoingBitrateKbps,
      rttMs: metrics.rttMs,
      qualityLimitationReason: metrics.qualityLimitationReason
    };
    this.logger.debug?.("[SenderAutoClarity]", payload);
    this.onDebugSample?.(payload);
  }

  emitState() {
    this.onStateChange?.(this.getState());
  }

  throttledLog(key, level, message) {
    const now = Date.now();
    const previous = this.lastLogAtByKey.get(key) ?? 0;
    if (now - previous < LOG_THROTTLE_MS) return;
    this.lastLogAtByKey.set(key, now);
    this.logger[level]?.(message);
  }
}
