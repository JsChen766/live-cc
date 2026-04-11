/**
 * NON-INTRUSIVE PATCH
 * RECEIVER-SIDE ONLY
 * Runtime controller for optional smooth playback on remote video receivers.
 */

import {
  applyReceiverSmoothBuffer,
  getSmoothBufferModeOptions,
  getReceiverSmoothBufferValue,
  isReceiverSmoothBufferSupported
} from "./receiverSmoothBuffer.js";
import { ReceiverStatsCollector } from "./receiverStats.js";

const LOG_THROTTLE_MS = 5000;
const STATS_SAMPLE_MS = 3000;

function createInitialState(mode) {
  return {
    enabled: mode !== "off",
    mode,
    supported: false,
    appliedMs: null,
    lastError: null
  };
}

export class RemotePlaybackController {
  constructor({ mode = "off", logger = console, onStateChange, onStats } = {}) {
    this.mode = mode;
    this.logger = logger;
    this.onStateChange = onStateChange;
    this.onStats = onStats;
    this.receiver = null;
    this.statsCollector = null;
    this.statsTimer = null;
    this.lastLogAtByKey = new Map();
    this.state = createInitialState(mode);
  }

  attachReceiver(receiver) {
    if (!receiver) return this.getState();
    this.receiver = receiver;
    this.statsCollector = new ReceiverStatsCollector({ receiver, logger: this.logger });

    this.throttledLog("receiver-detected", "debug", "[SmoothBuffer] remote video receiver detected");
    this.applyCurrentMode();
    this.startStats();
    return this.getState();
  }

  setSmoothBufferMode(mode) {
    const previousMode = this.mode;
    this.mode = mode;
    this.applyCurrentMode();
    this.throttledLog(
      `mode:${previousMode}:${mode}`,
      "info",
      `[SmoothBuffer] switched mode from ${previousMode} to ${mode}`
    );
    return this.getState();
  }

  getState() {
    return { ...this.state };
  }

  getModeOptions() {
    return getSmoothBufferModeOptions();
  }

  stop() {
    if (this.statsTimer) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.receiver = null;
    this.statsCollector = null;
  }

  applyCurrentMode() {
    const supported = isReceiverSmoothBufferSupported(this.receiver);
    const targetMs = getReceiverSmoothBufferValue(this.mode);

    this.throttledLog(
      `support:${supported}:${this.mode}`,
      "debug",
      `[SmoothBuffer] support=${supported} currentMode=${this.mode} target=${targetMs}ms`
    );

    if (!this.receiver) {
      this.updateState({
        enabled: this.mode !== "off",
        mode: this.mode,
        supported: false,
        appliedMs: null,
        lastError: "receiver-unavailable"
      });
      return;
    }

    const result = applyReceiverSmoothBuffer(this.receiver, this.mode, {
      logger: this.createThrottledLogger(),
      forceReset: this.mode === "off" && this.state.appliedMs !== null
    });
    this.updateState({
      enabled: this.mode !== "off",
      mode: this.mode,
      supported: result.supported,
      appliedMs: result.ok ? result.appliedMs : null,
      lastError: result.error
    });
  }

  startStats() {
    if (this.statsTimer) window.clearInterval(this.statsTimer);
    this.statsTimer = window.setInterval(async () => {
      const stats = await this.statsCollector?.sample();
      if (!stats) return;
      this.logger.debug?.("[SmoothBuffer] receiver stats", stats);
      this.onStats?.(stats);
    }, STATS_SAMPLE_MS);
  }

  updateState(nextState) {
    this.state = nextState;
    this.onStateChange?.(this.getState());
  }

  createThrottledLogger() {
    return {
      debug: (message, extra) => this.throttledLog(message, "debug", message, extra),
      info: (message, extra) => this.throttledLog(message, "info", message, extra),
      warn: (message, extra) => this.throttledLog(message, "warn", message, extra)
    };
  }

  throttledLog(key, level, message, extra) {
    const now = Date.now();
    const previous = this.lastLogAtByKey.get(key) ?? 0;
    if (now - previous < LOG_THROTTLE_MS) return;
    this.lastLogAtByKey.set(key, now);
    if (extra !== undefined) {
      this.logger[level]?.(message, extra);
    } else {
      this.logger[level]?.(message);
    }
  }
}
