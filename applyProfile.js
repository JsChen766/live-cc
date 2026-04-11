/**
 * NON-INTRUSIVE PATCH
 * Stable-first stream profile helpers. This module only applies gentle
 * constraints and sender parameter updates; it never owns the realtime flow.
 */

/**
 * @typedef {"HD_30" | "SD_60" | "HD_60" | "SD_30"} StreamProfile
 */

/**
 * @typedef {{
 *   profile: StreamProfile;
 *   width: number;
 *   height: number;
 *   frameRate: number;
 *   contentHint: "detail" | "motion" | "text";
 *   maxBitrate: number;
 *   minBitrate: number;
 *   scaleResolutionDownBy: number;
 *   label: string;
 * }} StreamProfileConfig
 */

export const DEFAULT_START_PROFILE = "HD_30";

/** @type {Record<StreamProfile, StreamProfileConfig>} */
export const STREAM_PROFILES = {
  HD_30: {
    profile: "HD_30",
    width: 1280,
    height: 720,
    frameRate: 30,
    contentHint: "motion",
    minBitrate: 1_800_000,
    maxBitrate: 2_500_000,
    scaleResolutionDownBy: 1,
    label: "720p 30fps"
  },
  SD_60: {
    profile: "SD_60",
    width: 960,
    height: 540,
    frameRate: 60,
    contentHint: "motion",
    minBitrate: 1_800_000,
    maxBitrate: 2_800_000,
    scaleResolutionDownBy: 1.33,
    label: "540p 60fps"
  },
  HD_60: {
    profile: "HD_60",
    width: 1280,
    height: 720,
    frameRate: 60,
    contentHint: "motion",
    minBitrate: 3_000_000,
    maxBitrate: 4_500_000,
    scaleResolutionDownBy: 1,
    label: "720p 60fps"
  },
  SD_30: {
    profile: "SD_30",
    width: 960,
    height: 540,
    frameRate: 30,
    contentHint: "motion",
    minBitrate: 900_000,
    maxBitrate: 1_500_000,
    scaleResolutionDownBy: 1.33,
    label: "540p 30fps"
  }
};

export function getInitialDisplayVideoConstraints() {
  return {
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 30, max: 60 }
  };
}

export function getProfileConfig(profile) {
  return STREAM_PROFILES[profile] ?? STREAM_PROFILES[DEFAULT_START_PROFILE];
}

export function getContentHintForProfile(profile) {
  return getProfileConfig(profile).contentHint;
}

async function trySetContentHint(track, hint, logger) {
  try {
    if ("contentHint" in track) {
      track.contentHint = hint;
    }
  } catch (error) {
    logger?.warn?.("applyProfile: contentHint unsupported", error);
  }
}

async function trySetSenderParameters(sender, profile, logger) {
  let previousParameters = null;
  try {
    previousParameters = sender.getParameters?.() ?? null;
    if (!previousParameters) return { ok: true, rollback: null };

    const nextParameters = {
      ...previousParameters,
      encodings: Array.isArray(previousParameters.encodings) && previousParameters.encodings.length > 0
        ? previousParameters.encodings.map((encoding, index) => {
            if (index !== 0) return { ...encoding };
            return {
              ...encoding,
              maxBitrate: profile.maxBitrate,
              maxFramerate: profile.frameRate,
              scaleResolutionDownBy: profile.scaleResolutionDownBy
            };
          })
        : [
            {
              maxBitrate: profile.maxBitrate,
              maxFramerate: profile.frameRate,
              scaleResolutionDownBy: profile.scaleResolutionDownBy
            }
          ]
    };
    nextParameters.degradationPreference = "maintain-framerate";

    await sender.setParameters(nextParameters);
    return {
      ok: true,
      rollback: async () => {
        if (previousParameters) {
          await sender.setParameters(previousParameters);
        }
      }
    };
  } catch (error) {
    logger?.warn?.("applyProfile: sender.setParameters failed", error);
    return { ok: false, rollback: null };
  }
}

/**
 * Gently applies a stream profile. Failure never throws to the caller by
 * default; instead, it returns a structured result so the live session can
 * continue using the current track settings.
 */
export async function applyProfile({ profile, videoTrack, videoSender, logger = console }) {
  const nextProfile = getProfileConfig(profile);
  const previousHint = "contentHint" in videoTrack ? videoTrack.contentHint : "";
  let senderRollback = null;

  try {
    await trySetContentHint(videoTrack, getContentHintForProfile(profile), logger);

    if (videoSender) {
      const senderResult = await trySetSenderParameters(videoSender, nextProfile, logger);
      senderRollback = senderResult.rollback;
      if (!senderResult.ok) {
        return {
          ok: false,
          profile,
          error: new Error("sender-parameters-failed")
        };
      }
    }

    return {
      ok: true,
      profile,
      appliedSettings: videoTrack.getSettings?.() ?? null
    };
  } catch (error) {
    logger?.warn?.(`applyProfile: failed to apply ${profile}`, error);

    try {
      if ("contentHint" in videoTrack) {
        videoTrack.contentHint = previousHint;
      }
    } catch (hintError) {
      logger?.warn?.("applyProfile: rollback contentHint failed", hintError);
    }

    if (senderRollback) {
      try {
        await senderRollback();
      } catch (senderRollbackError) {
        logger?.warn?.("applyProfile: rollback sender parameters failed", senderRollbackError);
      }
    }

    return {
      ok: false,
      profile,
      error
    };
  }
}
