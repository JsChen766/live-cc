/**
 * NON-INTRUSIVE PATCH
 * Stable-first sender control for game screen sharing. This controller only
 * observes WebRTC stats and gently updates sender encodings; it never owns the
 * Cloudflare Realtime publish/subscribe flow.
 */

import { applyProfile, DEFAULT_START_PROFILE, getProfileConfig } from "./applyProfile.js";
import { WebRtcStatsCollector } from "./webrtcStats.js";

const SAMPLE_INTERVAL_MS = 1000;
const SWITCH_COOLDOWN_MS = 8000;
const SOURCE_UNSTABLE_UPGRADE_BAN_MS = 20000;
const UPGRADE_COOLDOWN_MS = 10000;
const LOG_THROTTLE_MS = 4000;
const HIGH_RTT_MS = 260;
const LOW_BITRATE_KBPS = 700;

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

function countBelow(samples, field, threshold, size) {
  return tail(samples, size).filter((sample) => typeof sample[field] === "number" && sample[field] < threshold).length;
}

function hasLimitation(samples, reason, size) {
  return tail(samples, size).some((sample) => sample.qualityLimitationReason === reason);
}

function stableNoLimitation(samples, size) {
  const items = tail(samples, size);
  return items.length === size && items.every((sample) => !["cpu", "bandwidth"].includes(sample.qualityLimitationReason));
}

function nextUpgradeProfile(profile) {
  if (profile === "SD_30") return "HD_30";
  if (profile === "HD_30") return "SD_60";
  if (profile === "SD_60") return "HD_60";
  return null;
}

export class VideoAdaptiveController {
  constructor({
    pc,
    videoSender,
    videoTrack,
    initialProfile = DEFAULT_START_PROFILE,
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
    this.currentProfile = initialProfile;
    this.samples = [];
    this.timer = null;
    this.lastSwitchAt = 0;
    this.upgradeBanUntil = 0;
    this.lastDegradeReason = null;
    this.lastLogAtByKey = new Map();
    this.statsCollector = new WebRtcStatsCollector({ pc, sender: videoSender, videoTrack, logger });
  }

  async start() {
    await this.transitionTo(this.currentProfile, "init", `发送端以 ${getProfileConfig(this.currentProfile).label} 稳定档启动`, true);
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
    return {
      sendProfile: this.currentProfile,
      sendStable: this.isSendStable(),
      sourceFps: last?.sourceFps ?? null,
      sentFps: last?.sentFps ?? null,
      lastDegradeReason: this.lastDegradeReason
    };
  }

  async tick() {
    const metrics = await this.statsCollector.sample();
    if (!metrics) return;

    this.samples.push(metrics);
    if (this.samples.length > 12) this.samples.shift();

    this.emitDebug(metrics);
    this.emitState();

    const severe = this.evaluateSevereFallback();
    if (severe) {
      await this.transitionTo(severe.profile, severe.reason, severe.message, true);
      return;
    }

    const inCooldown = Date.now() - this.lastSwitchAt < SWITCH_COOLDOWN_MS;
    if (!inCooldown) {
      const degrade = this.evaluateDegrade();
      if (degrade) {
        await this.transitionTo(degrade.profile, degrade.reason, degrade.message, false);
        return;
      }
    }

    const upgrade = this.evaluateUpgrade();
    if (upgrade) {
      await this.transitionTo(upgrade.profile, upgrade.reason, upgrade.message, false);
    }
  }

  evaluateSevereFallback() {
    const sentAvg3 = avgField(this.samples, "sentFps", 3);
    const rttAvg3 = avgField(this.samples, "rttMs", 3);
    const bitrateAvg3 = avgField(this.samples, "bitrateKbps", 3);
    const severe =
      (typeof sentAvg3 === "number" && sentAvg3 < 20) ||
      (typeof rttAvg3 === "number" && rttAvg3 > HIGH_RTT_MS) ||
      (typeof bitrateAvg3 === "number" && bitrateAvg3 < LOW_BITRATE_KBPS);

    if (!severe || this.currentProfile === "SD_30") return null;
    return {
      profile: "SD_30",
      reason: "severe-fallback",
      message: "发送端检测到严重链路异常，已进入 540p30 兜底档"
    };
  }

  evaluateDegrade() {
    const sourceAvg3 = avgField(this.samples, "sourceFps", 3);
    const sourceAvg5 = avgField(this.samples, "sourceFps", 5);
    const sentAvg3 = avgField(this.samples, "sentFps", 3);

    const sourceUnstable =
      (typeof sourceAvg5 === "number" && sourceAvg5 < 28) || countBelow(this.samples, "sourceFps", 25, 3) === 3;
    if (sourceUnstable) {
      this.upgradeBanUntil = Date.now() + SOURCE_UNSTABLE_UPGRADE_BAN_MS;
      if (this.currentProfile !== "HD_30") {
        return {
          profile: "HD_30",
          reason: "source-unstable",
          message: "发送端采集帧率不足，已回退到 720p30 稳定档"
        };
      }
      return null;
    }

    if (hasLimitation(this.samples, "bandwidth", 3)) {
      if (this.currentProfile === "HD_60") {
        return {
          profile: "SD_60",
          reason: "bandwidth",
          message: "发送端检测到带宽受限，已降为 540p60 保帧率"
        };
      }
      if (this.currentProfile === "HD_30") {
        return {
          profile: "SD_30",
          reason: "bandwidth",
          message: "发送端检测到带宽受限，已降为 540p30 稳定档"
        };
      }
    }

    if (hasLimitation(this.samples, "cpu", 3)) {
      if (this.currentProfile === "HD_60") {
        return {
          profile: "HD_30",
          reason: "cpu",
          message: "发送端检测到 CPU 受限，已回退到 720p30 稳定档"
        };
      }
      if (this.currentProfile === "SD_60") {
        return {
          profile: "SD_30",
          reason: "cpu",
          message: "发送端检测到 CPU 受限，已回退到 540p30 兜底档"
        };
      }
    }

    const sixtyProfile = this.currentProfile === "HD_60" || this.currentProfile === "SD_60";
    const sixtyUnstable =
      sixtyProfile &&
      ((typeof sentAvg3 === "number" && sentAvg3 < 50) ||
        (typeof sourceAvg3 === "number" && sourceAvg3 < 55));

    if (!sixtyUnstable) return null;

    if (this.currentProfile === "HD_60") {
      return {
        profile: "SD_60",
        reason: "unstable-60",
        message: "发送端检测到 60fps 不稳定，已降级到 540p60"
      };
    }

    return {
      profile: "HD_30",
      reason: "unstable-60",
      message: "发送端检测到 540p60 仍不稳定，已回退到 720p30 稳定档"
    };
  }

  evaluateUpgrade() {
    if (Date.now() - this.lastSwitchAt < UPGRADE_COOLDOWN_MS) return null;
    if (Date.now() < this.upgradeBanUntil) return null;
    if (this.samples.length < 10) return null;

    const target = nextUpgradeProfile(this.currentProfile);
    if (!target) return null;

    const sourceAvg10 = avgField(this.samples, "sourceFps", 10);
    const sentAvg10 = avgField(this.samples, "sentFps", 10);
    const rttAvg10 = avgField(this.samples, "rttMs", 10);
    const noLimit = stableNoLimitation(this.samples, 8);
    const rttNormal = typeof rttAvg10 !== "number" || rttAvg10 < 140;
    const sendThreshold = target === "HD_30" ? 28 : 55;

    if (
      typeof sourceAvg10 === "number" &&
      sourceAvg10 >= 58 &&
      typeof sentAvg10 === "number" &&
      sentAvg10 >= sendThreshold &&
      noLimit &&
      rttNormal
    ) {
      return {
        profile: target,
        reason: "upgrade-stable",
        message: `发送端链路恢复稳定，升级到 ${getProfileConfig(target).label}`
      };
    }

    return null;
  }

  async transitionTo(nextProfile, reason, message, bypassCooldown) {
    if (!nextProfile) return;
    if (!bypassCooldown && Date.now() - this.lastSwitchAt < SWITCH_COOLDOWN_MS) return;

    const previousProfile = this.currentProfile;
    const result = await applyProfile({
      profile: nextProfile,
      videoTrack: this.videoTrack,
      videoSender: this.videoSender,
      logger: this.logger
    });

    if (!result.ok) {
      this.throttledLog(`transition-failed:${nextProfile}`, "warn", `发送端切档失败，保持 ${getProfileConfig(previousProfile).label}`);
      return;
    }

    this.currentProfile = nextProfile;
    this.lastSwitchAt = Date.now();
    this.lastDegradeReason = reason === "upgrade-stable" || reason === "init" ? null : reason;
    this.onProfileChanged?.({
      reason,
      profile: nextProfile,
      previousProfile,
      profileLabel: getProfileConfig(nextProfile).label,
      trackSettings: this.videoTrack.getSettings?.() ?? null
    });
    this.throttledLog(`transition:${reason}:${nextProfile}`, "info", message);
    this.onUserMessage?.(message);
    this.emitState();
  }

  isSendStable() {
    const sourceAvg3 = avgField(this.samples, "sourceFps", 3);
    const sentAvg3 = avgField(this.samples, "sentFps", 3);
    if (sourceAvg3 === null || sentAvg3 === null) return true;
    return sourceAvg3 >= 28 && sentAvg3 >= (this.currentProfile.endsWith("_60") ? 50 : 25);
  }

  emitDebug(metrics) {
    const payload = {
      layer: "sender",
      profile: this.currentProfile,
      sourceFps: metrics.sourceFps,
      sentFps: metrics.sentFps,
      bitrateKbps: metrics.bitrateKbps,
      rttMs: metrics.rttMs,
      qualityLimitationReason: metrics.qualityLimitationReason
    };
    this.logger.debug?.("[SenderAdaptive]", payload);
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
