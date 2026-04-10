/**
 * NON-INTRUSIVE PATCH
 * Stable-first adaptive sender control. It observes standard WebRTC stats and
 * applies gentle profile changes without owning the realtime session flow.
 */

import { applyProfile, DEFAULT_START_PROFILE, getProfileConfig } from "./applyProfile.js";
import { WebRtcStatsCollector } from "./webrtcStats.js";

const SAMPLE_INTERVAL_MS = 1000;
const WINDOW_5 = 5;
const WINDOW_8 = 8;
const DEGRADE_COOLDOWN_MS = 8000;
const UPGRADE_COOLDOWN_MS = 15000;
const LOG_THROTTLE_MS = 4000;

function avg(values) {
  const valid = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (valid.length === 0) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function tail(items, size) {
  return items.slice(Math.max(0, items.length - size));
}

function dominantReason(metrics) {
  const counts = { none: 0, cpu: 0, bandwidth: 0, other: 0, unknown: 0 };
  for (const item of metrics) {
    const reason = item.qualityLimitationReason ?? "unknown";
    counts[reason] = (counts[reason] ?? 0) + 1;
  }

  let winner = "unknown";
  let maxCount = -1;
  for (const [reason, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxCount = count;
      winner = reason;
    }
  }
  return winner;
}

function countBelow(metrics, field, threshold, windowSize) {
  return tail(metrics, windowSize).filter((item) => typeof item[field] === "number" && item[field] < threshold).length;
}

function averageField(metrics, field, windowSize) {
  return avg(tail(metrics, windowSize).map((item) => item[field]));
}

function mostlyReason(metrics, reason, windowSize) {
  const items = tail(metrics, windowSize);
  if (items.length === 0) return false;
  const matched = items.filter((item) => item.qualityLimitationReason === reason).length;
  return matched >= Math.ceil(items.length * 0.6);
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
    onDebugSample
  }) {
    this.pc = pc;
    this.videoSender = videoSender;
    this.videoTrack = videoTrack;
    this.logger = logger;
    this.onProfileChanged = onProfileChanged;
    this.onUserMessage = onUserMessage;
    this.onDebugSample = onDebugSample;
    this.currentProfile = initialProfile;
    this.state = "stable";
    this.samples = [];
    this.timer = null;
    this.lastSwitchAt = 0;
    this.lastLogAtByKey = new Map();
    this.statsCollector = new WebRtcStatsCollector({
      pc,
      sender: videoSender,
      videoTrack,
      logger
    });
  }

  async start() {
    try {
      const result = await applyProfile({
        profile: this.currentProfile,
        videoTrack: this.videoTrack,
        videoSender: this.videoSender,
        logger: this.logger
      });

      if (!result.ok) {
        this.logger?.warn?.("adaptive-controller: initial profile apply failed, keeping current sender state");
      } else {
        this.lastSwitchAt = Date.now();
        this.emitProfileChanged("init", this.currentProfile, null);
      }
    } catch (error) {
      this.logger?.warn?.("adaptive-controller: failed to start initial profile", error);
    }

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

  async tick() {
    const metrics = await this.statsCollector.sample();
    if (!metrics) return;

    this.samples.push(metrics);
    if (this.samples.length > WINDOW_8 + 2) {
      this.samples.shift();
    }

    this.emitDebug(metrics);
    const severeTarget = this.evaluateSevereFallback();
    if (severeTarget) {
      await this.transitionTo(severeTarget.profile, severeTarget.reason, severeTarget.message, true);
      return;
    }

    const now = Date.now();
    const inCooldown = now - this.lastSwitchAt < DEGRADE_COOLDOWN_MS;
    if (!inCooldown) {
      const degradeDecision = this.evaluateDegrade();
      if (degradeDecision) {
        await this.transitionTo(degradeDecision.profile, degradeDecision.reason, degradeDecision.message, false);
        return;
      }
    }

    const upgradeDecision = this.evaluateUpgrade();
    if (upgradeDecision) {
      await this.transitionTo(upgradeDecision.profile, upgradeDecision.reason, upgradeDecision.message, false);
    }
  }

  evaluateSevereFallback() {
    const last3 = tail(this.samples, 3);
    if (last3.length < 3) return null;

    const sentAvg3 = avg(last3.map((item) => item.sentFps));
    const bitrateAvg3 = avg(last3.map((item) => item.availableOutgoingBitrateKbps));
    const rttAvg3 = avg(last3.map((item) => item.rttMs));
    const discardedSum = last3.reduce((sum, item) => sum + (item.packetsDiscardedOnSendDelta ?? 0), 0);

    const severe =
      (typeof sentAvg3 === "number" && sentAvg3 < 24) ||
      (typeof bitrateAvg3 === "number" && bitrateAvg3 < 900) ||
      (typeof rttAvg3 === "number" && rttAvg3 > 280) ||
      discardedSum >= 10;

    if (!severe || this.currentProfile === "SD_30") return null;

    return {
      profile: "SD_30",
      reason: "severe-fallback",
      message: "网络异常或链路持续恶化，已进入 540p 30fps 兜底档位"
    };
  }

  evaluateDegrade() {
    const last5 = tail(this.samples, WINDOW_5);
    const last3 = tail(this.samples, 3);
    if (last5.length < WINDOW_5) return null;

    const sourceAvg5 = avg(last5.map((item) => item.sourceFps));
    const sentAvg5 = avg(last5.map((item) => item.sentFps));
    const limitation = dominantReason(last5);

    const sourceUnable60 =
      (typeof sourceAvg5 === "number" && sourceAvg5 < 50) || countBelow(this.samples, "sourceFps", 45, 3) >= 2;

    if (sourceUnable60) {
      if (this.currentProfile === "HD_60") {
        return {
          profile: "HD_30",
          reason: "source-cannot-60",
          message: `源帧率不足，判定为采集侧无法稳定提供 60fps，降为更稳的 ${getProfileConfig("HD_30").label}`
        };
      }
      if (this.currentProfile === "SD_60") {
        return {
          profile: "SD_30",
          reason: "source-cannot-60",
          message: `源帧率不足，判定为采集侧无法稳定提供 60fps，降为更稳的 ${getProfileConfig("SD_30").label}`
        };
      }
    }

    const sourceCapable60 = typeof sourceAvg5 === "number" && sourceAvg5 >= 55;
    const senderUnstable = typeof sentAvg5 === "number" && sentAvg5 < 45;
    const degradeTriggered = countBelow(this.samples, "sentFps", 45, 3) >= 2 || countBelow(this.samples, "sentFps", 24, 3) >= 1;
    if (!sourceCapable60 || !senderUnstable || !degradeTriggered) return null;

    if (limitation === "cpu") {
      if (this.currentProfile === "HD_60") {
        return {
          profile: "HD_30",
          reason: "cpu-degrade",
          message: `发送端主要受 CPU 限制（近 5 秒发送帧率 ${sentAvg5?.toFixed(1) ?? "-"}），优先降帧率到 ${getProfileConfig("HD_30").label}`
        };
      }
      if (this.currentProfile === "SD_60") {
        return {
          profile: "SD_30",
          reason: "cpu-degrade",
          message: `发送端主要受 CPU 限制（近 5 秒发送帧率 ${sentAvg5?.toFixed(1) ?? "-"}），优先降帧率到 ${getProfileConfig("SD_30").label}`
        };
      }
    }

    if (limitation === "bandwidth") {
      if (this.currentProfile === "HD_60") {
        return {
          profile: "SD_60",
          reason: "bandwidth-degrade",
          message: `发送端主要受带宽限制（近 5 秒发送帧率 ${sentAvg5?.toFixed(1) ?? "-"}），优先降分辨率到 ${getProfileConfig("SD_60").label}`
        };
      }
      if (this.currentProfile === "HD_30") {
        return {
          profile: "SD_30",
          reason: "bandwidth-degrade",
          message: `发送端主要受带宽限制（近 5 秒发送帧率 ${sentAvg5?.toFixed(1) ?? "-"}），优先降分辨率到 ${getProfileConfig("SD_30").label}`
        };
      }
    }

    if (["other", "unknown"].includes(limitation)) {
      if (this.currentProfile === "HD_60") {
        return {
          profile: "HD_30",
          reason: "other-degrade",
          message: `发送端状态不稳定（原因 ${limitation}），已从 ${getProfileConfig("HD_60").label} 回退到 ${getProfileConfig("HD_30").label}`
        };
      }
      if (this.currentProfile === "HD_30") {
        return {
          profile: "SD_30",
          reason: "other-degrade",
          message: `发送端状态持续异常（原因 ${limitation}），已回退到 ${getProfileConfig("SD_30").label}`
        };
      }
    }

    return null;
  }

  evaluateUpgrade() {
    const now = Date.now();
    if (now - this.lastSwitchAt < UPGRADE_COOLDOWN_MS) return null;

    const last8 = tail(this.samples, WINDOW_8);
    if (last8.length < WINDOW_8) return null;

    const sourceAvg8 = avg(last8.map((item) => item.sourceFps));
    const sentAvg8 = avg(last8.map((item) => item.sentFps));
    const rttAvg8 = avg(last8.map((item) => item.rttMs));
    const outgoingAvg8 = avg(last8.map((item) => item.availableOutgoingBitrateKbps));
    const stableNone = mostlyReason(last8, "none", WINDOW_8);
    const networkStable =
      (typeof rttAvg8 !== "number" || rttAvg8 < 140) &&
      (typeof outgoingAvg8 !== "number" || outgoingAvg8 > 2_200);

    if (!(stableNone && networkStable && typeof sourceAvg8 === "number" && sourceAvg8 >= 58)) {
      return null;
    }

    if (this.currentProfile === "SD_30" && typeof sentAvg8 === "number" && sentAvg8 >= 28) {
      return {
        profile: "HD_30",
        reason: "upgrade-stable",
        message: `链路恢复稳定，已从 ${getProfileConfig("SD_30").label} 升级到 ${getProfileConfig("HD_30").label}`
      };
    }

    if (this.currentProfile === "HD_30" && typeof sentAvg8 === "number" && sentAvg8 >= 55) {
      return {
        profile: "SD_60",
        reason: "upgrade-stable",
        message: `链路恢复稳定，已从 ${getProfileConfig("HD_30").label} 升级到 ${getProfileConfig("SD_60").label}`
      };
    }

    if (this.currentProfile === "SD_60" && typeof sentAvg8 === "number" && sentAvg8 >= 55) {
      return {
        profile: "HD_60",
        reason: "upgrade-stable",
        message: `链路恢复稳定，已从 ${getProfileConfig("SD_60").label} 升级到 ${getProfileConfig("HD_60").label}`
      };
    }

    return null;
  }

  async transitionTo(nextProfile, reason, message, bypassCooldown) {
    if (!nextProfile || nextProfile === this.currentProfile) return;
    if (!bypassCooldown && Date.now() - this.lastSwitchAt < DEGRADE_COOLDOWN_MS) return;

    const previousProfile = this.currentProfile;
    this.state = reason === "upgrade-stable" ? "recovering" : "degrading";

    const result = await applyProfile({
      profile: nextProfile,
      videoTrack: this.videoTrack,
      videoSender: this.videoSender,
      logger: this.logger
    });

    if (!result.ok) {
      this.state = "stable";
      this.throttledLog(`transition-failed:${nextProfile}`, "warn", `自适应切档失败，保持当前档位 ${getProfileConfig(previousProfile).label}`);
      return;
    }

    this.currentProfile = nextProfile;
    this.lastSwitchAt = Date.now();
    this.state = "stable";
    this.emitProfileChanged(reason, nextProfile, previousProfile);
    this.throttledLog(`transition:${reason}:${nextProfile}`, "info", message);
    if (this.onUserMessage) {
      this.onUserMessage(message);
    }
  }

  emitDebug(metrics) {
    const payload = {
      profile: this.currentProfile,
      state: this.state,
      sourceFps: metrics.sourceFps,
      sourceWidth: metrics.sourceWidth,
      sourceHeight: metrics.sourceHeight,
      sentFps: metrics.sentFps,
      sentWidth: metrics.sentWidth,
      sentHeight: metrics.sentHeight,
      bitrateKbps: metrics.bitrateKbps,
      availableOutgoingBitrateKbps: metrics.availableOutgoingBitrateKbps,
      rttMs: metrics.rttMs,
      qualityLimitationReason: metrics.qualityLimitationReason,
      packetsDiscardedOnSendDelta: metrics.packetsDiscardedOnSendDelta
    };

    this.logger?.debug?.("adaptive-controller", payload);
    this.onDebugSample?.(payload);
  }

  emitProfileChanged(reason, profile, previousProfile) {
    this.onProfileChanged?.({
      reason,
      profile,
      previousProfile,
      profileLabel: getProfileConfig(profile).label,
      trackSettings: this.videoTrack.getSettings?.() ?? null
    });
  }

  throttledLog(key, level, message) {
    const now = Date.now();
    const previous = this.lastLogAtByKey.get(key) ?? 0;
    if (now - previous < LOG_THROTTLE_MS) return;
    this.lastLogAtByKey.set(key, now);
    this.logger?.[level]?.(message);
  }
}
