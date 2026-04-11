/**
 * NON-INTRUSIVE PATCH
 * RECEIVER-SIDE ONLY
 * Helpers for applying a preferred receive-side jitter buffer target.
 */

/**
 * @typedef {"off" | "light" | "balanced" | "aggressive"} SmoothBufferMode
 */

export const SMOOTH_BUFFER_MODE_LABELS = {
  off: "低延迟模式",
  light: "轻度平滑（约 200ms 额外缓冲）",
  balanced: "平衡平滑（约 350ms 额外缓冲）",
  aggressive: "强平滑（约 600ms 额外缓冲）"
};

export const SMOOTH_BUFFER_TARGETS_MS = {
  off: 0,
  light: 200,
  balanced: 350,
  aggressive: 600
};

export const MAX_EXPERIMENTAL_AGGRESSIVE_TARGET_MS = 800;

export function getReceiverSmoothBufferValue(mode) {
  return SMOOTH_BUFFER_TARGETS_MS[mode] ?? SMOOTH_BUFFER_TARGETS_MS.off;
}

export function getSmoothBufferModeOptions() {
  return Object.entries(SMOOTH_BUFFER_MODE_LABELS).map(([mode, label]) => ({
    mode,
    label,
    targetMs: getReceiverSmoothBufferValue(mode)
  }));
}

export function isReceiverSmoothBufferSupported(receiver) {
  return Boolean(receiver && "jitterBufferTarget" in receiver);
}

/**
 * Applies a receiver-side jitter buffer target when supported.
 * This never throws; unsupported browsers keep playback unchanged.
 */
export function applyReceiverSmoothBuffer(receiver, mode, options = {}) {
  const logger = options.logger ?? console;
  const targetMs = getReceiverSmoothBufferValue(mode);

  if (!receiver) {
    return {
      ok: false,
      supported: false,
      mode,
      appliedMs: null,
      error: "receiver-unavailable"
    };
  }

  try {
    if (mode === "off" && !options.forceReset) {
      return {
        ok: true,
        supported: isReceiverSmoothBufferSupported(receiver),
        mode,
        appliedMs: null,
        error: null
      };
    }

    if (!isReceiverSmoothBufferSupported(receiver)) {
      logger.warn?.("[SmoothBuffer] jitterBufferTarget not supported in current browser, skip patch");
      return {
        ok: false,
        supported: false,
        mode,
        appliedMs: null,
        error: "unsupported"
      };
    }

    receiver.jitterBufferTarget = targetMs;
    logger.info?.(`[SmoothBuffer] applied receiver jitterBufferTarget=${targetMs}ms`);
    return {
      ok: true,
      supported: true,
      mode,
      appliedMs: targetMs,
      error: null
    };
  } catch (error) {
    logger.warn?.("[SmoothBuffer] failed to apply receiver buffer target, keep playback unchanged", error);
    return {
      ok: false,
      supported: true,
      mode,
      appliedMs: null,
      error: error instanceof Error ? error.message : "apply-failed"
    };
  }
}
