// Coach voice-over ↔ swing-video sync helper (Task #1684).
//
// The drift-correction logic for keeping the coach voice-over aligned with
// the swing video used to live in two places that had to be kept in
// lockstep:
//
//   - artifacts/kharagolf-web/src/pages/coach-marketplace.tsx
//     → ReviewPlaybackModal (HTMLVideoElement + HTMLAudioElement)
//   - artifacts/kharagolf-mobile/app/(tabs)/coach.tsx
//     → syncVoiceToVideo (expo-av Sound + Video)
//
// Both implementations share the same rules (throttle to ~100 ms, re-seek
// only when drift > 250 ms, cap to voiceOverDurationSeconds, mirror playback
// rate, stop cleanly past end). Task #1400 already showed how easy it is for
// the two paths to drift apart; this module hoists the rules out so future
// tweaks are applied in exactly one place.
//
// The module is platform-agnostic — it has zero DOM / React Native imports
// and reasons purely about positions in milliseconds. Each call site keeps
// the platform-specific work of reading positions and applying the returned
// decision (HTMLAudioElement APIs on web, Audio.Sound APIs on mobile).

// How often the call site should be allowed to issue a sync decision when a
// timeupdate-style event fires repeatedly. Forced syncs (play / pause /
// seek / ratechange) bypass this throttle.
export const VOICE_SYNC_THROTTLE_MS = 100;

// When the audio drifts more than this from the video while playing, force a
// re-seek. Below this threshold the audio is "close enough" and we let it
// continue freewheeling, which avoids constant small seeks that themselves
// introduce audible glitches.
export const VOICE_SYNC_DRIFT_THRESHOLD_MS = 250;

// While the video is paused (and we are not past the voice-over end) the
// audio should be parked at the current video position. We only re-seek when
// the gap is meaningfully larger than this — a redundant seek-to-self has no
// user-visible effect and just costs a round-trip on mobile.
export const VOICE_SYNC_PAUSED_SEEK_TOLERANCE_MS = 50;

export interface VoiceSyncInput {
  // Current video playhead in milliseconds.
  videoPosMs: number;
  // Current voice-over playhead in milliseconds.
  audioPosMs: number;
  // Whether the video element is currently playing (not paused, not ended).
  videoIsPlaying: boolean;
  // Video playback rate (1.0 = normal). The decision mirrors this onto the
  // audio so slow-motion review keeps the voice-over aligned.
  rate: number;
  // Voice-over duration cap in milliseconds, or null if unknown / unbounded.
  // When the video plays past this, the voice-over should stop cleanly
  // instead of looping or trailing on.
  capMs: number | null;
}

export interface VoiceSyncDecision {
  // Pause the audio (the call site should additionally check that audio is
  // currently playing before issuing the pause, to avoid spurious calls).
  shouldPause: boolean;
  // Start the audio (the call site should additionally check that audio is
  // currently paused before issuing the play call).
  shouldPlay: boolean;
  // Seek the audio to this position (in milliseconds). null means "leave the
  // audio playhead alone".
  seekToMs: number | null;
  // Mirror this playback rate onto the audio. The call site is free to skip
  // applying it if the platform does not expose a rate control.
  rate: number;
}

// Compute the next sync action to apply to the voice-over given the current
// video / audio state. Pure function — safe to call from anywhere.
export function computeVoiceSyncAction(
  input: VoiceSyncInput,
): VoiceSyncDecision {
  const cap =
    input.capMs == null || !Number.isFinite(input.capMs)
      ? Infinity
      : input.capMs;
  const target = Math.max(0, Math.min(input.videoPosMs, cap));
  const pastEnd = input.videoPosMs >= cap;

  if (!input.videoIsPlaying || pastEnd) {
    const drift = Math.abs(input.audioPosMs - target);
    const needsSeek =
      !pastEnd && drift > VOICE_SYNC_PAUSED_SEEK_TOLERANCE_MS;
    return {
      shouldPause: true,
      shouldPlay: false,
      seekToMs: needsSeek ? target : null,
      rate: input.rate,
    };
  }

  const drift = Math.abs(input.audioPosMs - target);
  const needsSeek = drift > VOICE_SYNC_DRIFT_THRESHOLD_MS;
  return {
    shouldPause: false,
    shouldPlay: true,
    seekToMs: needsSeek ? target : null,
    rate: input.rate,
  };
}

// Whether enough time has passed since the last sync to issue a new one.
// Forced syncs (e.g. on play / pause / seek / ratechange events) should pass
// `force = true` to bypass the throttle.
export function shouldRunVoiceSync(
  lastSyncAt: number,
  nowMs: number,
  force: boolean,
  throttleMs: number = VOICE_SYNC_THROTTLE_MS,
): boolean {
  if (force) return true;
  return nowMs - lastSyncAt >= throttleMs;
}

// Parse the `voiceOverDurationSeconds` field as it lands in API responses
// (the value can be a number, a numeric string from a `numeric` SQL column,
// or null/undefined when the coach hasn't recorded any voice-over). Returns
// the cap in milliseconds, or null when no usable value is present.
export function parseVoiceOverDurationMs(
  raw: number | string | null | undefined,
): number | null {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? parseFloat(raw)
        : NaN;
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}
