/**
 * Unit test: voice-over ↔ video sync helper (Task #1684).
 *
 * The web modal (artifacts/kharagolf-web/src/pages/coach-marketplace.tsx
 * → ReviewPlaybackModal) and the mobile coach screen
 * (artifacts/kharagolf-mobile/app/(tabs)/coach.tsx → syncVoiceToVideo) used
 * to each carry their own copy of the drift-correction logic. This suite
 * is the canonical source of truth for the rules now that both sides
 * delegate to `computeVoiceSyncAction` from this package.
 */
import { describe, it, expect } from "vitest";
import {
  VOICE_SYNC_THROTTLE_MS,
  VOICE_SYNC_DRIFT_THRESHOLD_MS,
  VOICE_SYNC_PAUSED_SEEK_TOLERANCE_MS,
  computeVoiceSyncAction,
  shouldRunVoiceSync,
  parseVoiceOverDurationMs,
} from "../src/index";

describe("computeVoiceSyncAction — playing", () => {
  it("plays without seeking when audio is in sync", () => {
    const dec = computeVoiceSyncAction({
      videoPosMs: 5000,
      audioPosMs: 5050, // 50 ms drift, well under threshold
      videoIsPlaying: true,
      rate: 1,
      capMs: 30_000,
    });
    expect(dec.shouldPlay).toBe(true);
    expect(dec.shouldPause).toBe(false);
    expect(dec.seekToMs).toBeNull();
    expect(dec.rate).toBe(1);
  });

  it("does not seek at the drift-threshold boundary (250 ms)", () => {
    const dec = computeVoiceSyncAction({
      videoPosMs: 5000,
      audioPosMs: 5000 + VOICE_SYNC_DRIFT_THRESHOLD_MS,
      videoIsPlaying: true,
      rate: 1,
      capMs: 30_000,
    });
    expect(dec.seekToMs).toBeNull();
  });

  it("seeks to the video position when drift exceeds the threshold", () => {
    const dec = computeVoiceSyncAction({
      videoPosMs: 5000,
      audioPosMs: 5000 + VOICE_SYNC_DRIFT_THRESHOLD_MS + 1,
      videoIsPlaying: true,
      rate: 1,
      capMs: 30_000,
    });
    expect(dec.shouldPlay).toBe(true);
    expect(dec.seekToMs).toBe(5000);
  });

  it("seeks symmetrically when the audio is ahead of the video", () => {
    const dec = computeVoiceSyncAction({
      videoPosMs: 5000,
      audioPosMs: 5000 - VOICE_SYNC_DRIFT_THRESHOLD_MS - 1,
      videoIsPlaying: true,
      rate: 1,
      capMs: 30_000,
    });
    expect(dec.seekToMs).toBe(5000);
  });

  it("mirrors the playback rate onto the decision", () => {
    const dec = computeVoiceSyncAction({
      videoPosMs: 5000,
      audioPosMs: 5000,
      videoIsPlaying: true,
      rate: 0.5,
      capMs: 30_000,
    });
    expect(dec.rate).toBe(0.5);
  });
});

describe("computeVoiceSyncAction — paused", () => {
  it("pauses without seeking when the gap is below the tolerance", () => {
    const dec = computeVoiceSyncAction({
      videoPosMs: 5000,
      audioPosMs: 5000 + VOICE_SYNC_PAUSED_SEEK_TOLERANCE_MS,
      videoIsPlaying: false,
      rate: 1,
      capMs: 30_000,
    });
    expect(dec.shouldPause).toBe(true);
    expect(dec.shouldPlay).toBe(false);
    expect(dec.seekToMs).toBeNull();
  });

  it("re-seeks to the video position when paused with meaningful drift", () => {
    const dec = computeVoiceSyncAction({
      videoPosMs: 5000,
      audioPosMs: 5000 + VOICE_SYNC_PAUSED_SEEK_TOLERANCE_MS + 1,
      videoIsPlaying: false,
      rate: 1,
      capMs: 30_000,
    });
    expect(dec.shouldPause).toBe(true);
    expect(dec.seekToMs).toBe(5000);
  });
});

describe("computeVoiceSyncAction — voice-over end cap", () => {
  it("pauses and does not seek once the video plays past the cap", () => {
    const dec = computeVoiceSyncAction({
      videoPosMs: 31_000, // past 30 s cap
      audioPosMs: 30_000,
      videoIsPlaying: true,
      rate: 1,
      capMs: 30_000,
    });
    expect(dec.shouldPause).toBe(true);
    expect(dec.shouldPlay).toBe(false);
    // Past the end the audio is already exhausted — no point seeking.
    expect(dec.seekToMs).toBeNull();
  });

  it("clamps the seek target to the cap when the video sits exactly at it", () => {
    const dec = computeVoiceSyncAction({
      videoPosMs: 30_000,
      audioPosMs: 0,
      videoIsPlaying: true,
      rate: 1,
      capMs: 30_000,
    });
    // videoPosMs >= cap → past-end branch fires, audio is paused without seek.
    expect(dec.shouldPause).toBe(true);
    expect(dec.seekToMs).toBeNull();
  });

  it("treats a null cap as unbounded (never past end)", () => {
    const dec = computeVoiceSyncAction({
      videoPosMs: 1_000_000,
      audioPosMs: 0,
      videoIsPlaying: true,
      rate: 1,
      capMs: null,
    });
    expect(dec.shouldPlay).toBe(true);
    expect(dec.seekToMs).toBe(1_000_000);
  });
});

describe("computeVoiceSyncAction — clamping", () => {
  it("clamps a negative video position to zero before targeting the audio", () => {
    const dec = computeVoiceSyncAction({
      videoPosMs: -50,
      audioPosMs: 1000,
      videoIsPlaying: true,
      rate: 1,
      capMs: 30_000,
    });
    expect(dec.seekToMs).toBe(0);
  });
});

describe("shouldRunVoiceSync", () => {
  it("blocks repeat syncs inside the throttle window", () => {
    expect(shouldRunVoiceSync(1000, 1050, false)).toBe(false);
  });

  it("allows a sync once the throttle window has elapsed", () => {
    expect(shouldRunVoiceSync(1000, 1000 + VOICE_SYNC_THROTTLE_MS, false)).toBe(
      true,
    );
  });

  it("forced syncs bypass the throttle entirely", () => {
    expect(shouldRunVoiceSync(1000, 1001, true)).toBe(true);
  });
});

describe("parseVoiceOverDurationMs", () => {
  it("converts a positive number of seconds to milliseconds", () => {
    expect(parseVoiceOverDurationMs(12.5)).toBe(12_500);
  });

  it("parses a numeric string (postgres NUMERIC columns serialise as strings)", () => {
    expect(parseVoiceOverDurationMs("8.25")).toBe(8250);
  });

  it("returns null for missing / invalid / non-positive values", () => {
    expect(parseVoiceOverDurationMs(null)).toBeNull();
    expect(parseVoiceOverDurationMs(undefined)).toBeNull();
    expect(parseVoiceOverDurationMs("not-a-number")).toBeNull();
    expect(parseVoiceOverDurationMs(0)).toBeNull();
    expect(parseVoiceOverDurationMs(-1)).toBeNull();
  });
});
