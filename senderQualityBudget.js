/**
 * NON-INTRUSIVE PATCH
 * Sender-side automatic clarity budget configuration. These levels are internal
 * only and must not be exposed as user-facing quality controls.
 */

/**
 * @typedef {"Q1" | "Q2" | "Q3" | "Q4"} SenderQualityLevel
 */

/**
 * @typedef {{
 *   id: SenderQualityLevel;
 *   maxBitrate: number;
 *   minAvailableOutgoingBitrateKbps: number;
 *   label: string;
 * }} SenderQualityBudget
 */

/** @type {SenderQualityBudget[]} */
export const SENDER_QUALITY_BUDGETS = [
  {
    id: "Q1",
    maxBitrate: 1_400_000,
    minAvailableOutgoingBitrateKbps: 2_000,
    label: "internal-low"
  },
  {
    id: "Q2",
    maxBitrate: 1_800_000,
    minAvailableOutgoingBitrateKbps: 2_500,
    label: "internal-mid-low"
  },
  {
    id: "Q3",
    maxBitrate: 2_200_000,
    minAvailableOutgoingBitrateKbps: 3_100,
    label: "internal-mid"
  },
  {
    id: "Q4",
    maxBitrate: 2_600_000,
    minAvailableOutgoingBitrateKbps: 3_700,
    label: "internal-mid-high"
  }
];

export const DEFAULT_SENDER_QUALITY_INDEX = 1;
export const MIN_SENDER_QUALITY_INDEX = 0;
export const MAX_SENDER_QUALITY_INDEX = SENDER_QUALITY_BUDGETS.length - 1;

export function clampQualityIndex(index) {
  if (!Number.isFinite(index)) return DEFAULT_SENDER_QUALITY_INDEX;
  return Math.max(MIN_SENDER_QUALITY_INDEX, Math.min(MAX_SENDER_QUALITY_INDEX, Math.round(index)));
}

export function getSenderQualityBudget(index) {
  return SENDER_QUALITY_BUDGETS[clampQualityIndex(index)] ?? SENDER_QUALITY_BUDGETS[DEFAULT_SENDER_QUALITY_INDEX];
}

export function getNextHigherQualityIndex(index) {
  return Math.min(MAX_SENDER_QUALITY_INDEX, clampQualityIndex(index) + 1);
}

export function getNextLowerQualityIndex(index) {
  return Math.max(MIN_SENDER_QUALITY_INDEX, clampQualityIndex(index) - 1);
}
