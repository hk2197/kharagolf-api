/**
 * Coverage for the member-side voice-over auto-sync logic inside
 * `RequestDetailModalInner` (artifacts/kharagolf-mobile/app/(tabs)/coach.tsx).
 *
 * The modal wires the coach's voice-over track to the swing video via
 * `syncVoiceToVideo`, which delegates to `@workspace/voice-over-sync`'s
 * `computeVoiceSyncAction`. The cases this test pins down are:
 *
 *   (a) When the video reports `isPlaying = true` with both video and audio
 *       at zero, the audio is started in sync (no spurious seek).
 *   (b) When the audio drifts more than ~250 ms from the video while
 *       playing, `Audio.Sound.setPositionAsync` is called with the video's
 *       current position so the voice-over snaps back into sync.
 *   (c) When `positionMillis` passes `voiceOverDurationSeconds * 1000`,
 *       the audio is paused (the past-end branch of `computeVoiceSyncAction`)
 *       and its position is left alone.
 *
 * The test mocks `expo-av`'s `Video` component so we can capture the
 * `onPlaybackStatusUpdate` prop and drive it directly, and mocks
 * `Audio.Sound.createAsync` so we can both control what the next
 * `getStatusAsync()` returns and assert on `playAsync` /
 * `setPositionAsync` / `pauseAsync` calls.
 *
 * `Date.now()` is stubbed so we can step past the 100 ms throttle inside
 * `shouldRunVoiceSync` between scenarios without sleeping the test.
 */
import React from "react";
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

// Hoisted captures shared between the test body and the `vi.mock` factory
// (vi.mock is hoisted to the top of the file, so it can't close over
// regular module-scope `let`s without `vi.hoisted`).
const expoAv = vi.hoisted(() => {
  type StatusUpdate = {
    isLoaded: true;
    isPlaying: boolean;
    didJustFinish?: boolean;
    positionMillis: number;
    durationMillis?: number;
    rate?: number;
  };
  type FakeSound = {
    playAsync: ReturnType<typeof vi.fn>;
    pauseAsync: ReturnType<typeof vi.fn>;
    setPositionAsync: ReturnType<typeof vi.fn>;
    setRateAsync: ReturnType<typeof vi.fn>;
    unloadAsync: ReturnType<typeof vi.fn>;
    getStatusAsync: ReturnType<typeof vi.fn>;
    _state: { isLoaded: true; isPlaying: boolean; positionMillis: number };
  };
  const captured: {
    onPlaybackStatusUpdate: ((s: StatusUpdate) => void) | null;
    sounds: FakeSound[];
  } = { onPlaybackStatusUpdate: null, sounds: [] };
  return { captured };
});

vi.mock("expo-av", () => {
  const ReactLib = require("react") as typeof import("react");

  type VideoProps = {
    onPlaybackStatusUpdate?: (s: unknown) => void;
    children?: React.ReactNode;
  };
  const FakeVideo = ReactLib.forwardRef<unknown, VideoProps>((props, ref) => {
    expoAv.captured.onPlaybackStatusUpdate =
      (props.onPlaybackStatusUpdate as
        | ((
            s: Parameters<NonNullable<typeof expoAv.captured.onPlaybackStatusUpdate>>[0],
          ) => void)
        | undefined) ?? null;
    ReactLib.useImperativeHandle(
      ref,
      () => ({
        // Stub so MemberDrawingTimeline's seek wiring (and any other
        // ref-based call) doesn't crash when the test triggers it.
        setPositionAsync: vi.fn(async (_ms: number) => ({})),
      }),
      [],
    );
    return null;
  });
  FakeVideo.displayName = "FakeVideo";

  const createAsync = vi.fn(async (_src: unknown, _opts: unknown) => {
    const state = { isLoaded: true as const, isPlaying: false, positionMillis: 0 };
    const sound = {
      playAsync: vi.fn(async () => {
        state.isPlaying = true;
      }),
      pauseAsync: vi.fn(async () => {
        state.isPlaying = false;
      }),
      setPositionAsync: vi.fn(async (ms: number) => {
        state.positionMillis = ms;
      }),
      setRateAsync: vi.fn(async (_r: number) => {}),
      unloadAsync: vi.fn(async () => {}),
      getStatusAsync: vi.fn(async () => ({ ...state })),
      _state: state,
    };
    expoAv.captured.sounds.push(sound);
    return { sound };
  });

  return {
    Video: FakeVideo,
    ResizeMode: { COVER: "cover", CONTAIN: "contain" },
    Audio: {
      Sound: { createAsync },
      setAudioModeAsync: vi.fn(async () => {}),
    },
  };
});

// Heavy native modules that `coach.tsx` pulls in at module scope but that
// the modal under test doesn't actually exercise.
vi.mock("expo-camera", () => ({
  CameraView: () => null,
  useCameraPermissions: () => [
    { granted: true },
    async () => ({ granted: true }),
  ],
}));
vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: async () => ({ canceled: true }),
  launchCameraAsync: async () => ({ canceled: true }),
  MediaTypeOptions: { Images: "Images", Videos: "Videos", All: "All" },
  requestCameraPermissionsAsync: async () => ({ granted: true }),
  requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
}));
vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///documents/",
  cacheDirectory: "file:///cache/",
}));
vi.mock("react-native-svg", () => {
  const Stub = ({ children }: { children?: React.ReactNode }) => children ?? null;
  return {
    __esModule: true,
    default: Stub,
    Svg: Stub,
    Line: Stub,
    Circle: Stub,
    Polyline: Stub,
    Path: Stub,
    Rect: Stub,
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    token: "test-token",
    user: { id: 42 },
    isAuthenticated: true,
    isLoading: false,
  }),
}));
vi.mock("@/utils/api", () => ({ BASE_URL: "" }));

import { RequestDetailModalInner } from "../app/(tabs)/coach";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  expoAv.captured.onPlaybackStatusUpdate = null;
  expoAv.captured.sounds.length = 0;
});

// `shouldRunVoiceSync` reads `Date.now()` and only lets a fresh decision
// through every 100 ms. The test wants every dispatched
// `onPlaybackStatusUpdate` to be honored, so we drive a deterministic clock
// and step it past the 100 ms gate between scenarios.
let mockNow = 0;
beforeEach(() => {
  mockNow = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => mockNow);
});

function makeData(overrides?: { voiceOverDurationSeconds?: number }) {
  return {
    request: {
      id: 101,
      status: "delivered",
      rating: 5,
      annotationId: 1,
    },
    video: { id: 1, videoUrl: "https://example.test/swing.mp4", fps: 30 },
    annotation: {
      id: 1,
      drawings: [],
      voiceOverUrl: "https://example.test/voice.mp3",
      voiceOverDurationSeconds: overrides?.voiceOverDurationSeconds ?? 4,
      textNotes: null,
    },
    pro: { id: 9, displayName: "Pro VoiceSync", photoUrl: null },
  };
}

async function mountModal(durationSeconds = 4) {
  const onClose = vi.fn();
  const setRating = vi.fn();
  const setComment = vi.fn();
  const submitRating = vi.fn();
  render(
    <RequestDetailModalInner
      data={makeData({ voiceOverDurationSeconds: durationSeconds })}
      onClose={onClose}
      rating={5}
      setRating={setRating}
      comment=""
      setComment={setComment}
      submitRating={submitRating}
    />,
  );
  // Wait for the Audio.Sound.createAsync useEffect to resolve so the
  // sync helper has something to work with.
  await waitFor(() => {
    expect(expoAv.captured.sounds.length).toBeGreaterThan(0);
    expect(expoAv.captured.onPlaybackStatusUpdate).not.toBeNull();
  });
}

// `syncVoiceToVideo` awaits `getStatusAsync` and then conditionally awaits
// `pauseAsync` / `setPositionAsync` / `playAsync`, all behind an
// `syncInFlightRef` guard. Two pumps of the microtask queue are enough to
// settle the longest of those chains under jsdom; `act` flushes any React
// state updates the chain might enqueue (e.g. `setVoicePlaying`).
async function flushSyncMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function dispatchStatus(
  status: {
    isPlaying: boolean;
    positionMillis: number;
    didJustFinish?: boolean;
    durationMillis?: number;
    rate?: number;
  },
) {
  const cb = expoAv.captured.onPlaybackStatusUpdate;
  if (!cb) throw new Error("onPlaybackStatusUpdate was not captured");
  await act(async () => {
    cb({
      isLoaded: true,
      isPlaying: status.isPlaying,
      didJustFinish: status.didJustFinish ?? false,
      positionMillis: status.positionMillis,
      durationMillis: status.durationMillis ?? 10_000,
      rate: status.rate ?? 1,
    });
  });
  await flushSyncMicrotasks();
  // Step past the 100 ms `shouldRunVoiceSync` throttle for the next call.
  mockNow += 200;
}

describe("RequestDetailModalInner voice-over auto-sync", () => {
  it("starts the voice-over in sync when the video begins playing", async () => {
    await mountModal();
    const sound = expoAv.captured.sounds[0]!;

    await dispatchStatus({ isPlaying: true, positionMillis: 0 });

    expect(sound.playAsync).toHaveBeenCalledTimes(1);
    // Drift is 0 → no seek issued. (computeVoiceSyncAction returns
    // seekToMs = null when |audio − video| ≤ 250 ms.)
    expect(sound.setPositionAsync).not.toHaveBeenCalled();
    expect(sound.pauseAsync).not.toHaveBeenCalled();
  });

  it("snaps the audio to the video position when drift exceeds ~250 ms", async () => {
    await mountModal();
    const sound = expoAv.captured.sounds[0]!;

    // Prime the audio by playing once at t=0 so the audio is "playing"
    // and is at position 0.
    await dispatchStatus({ isPlaying: true, positionMillis: 0 });
    expect(sound.playAsync).toHaveBeenCalledTimes(1);

    // Now report a video position 600 ms ahead while the audio is still
    // at 0 ms — drift = 600 ms, comfortably past the 250 ms threshold.
    sound._state.positionMillis = 0;
    sound._state.isPlaying = true;
    await dispatchStatus({ isPlaying: true, positionMillis: 600 });

    expect(sound.setPositionAsync).toHaveBeenCalledTimes(1);
    expect(sound.setPositionAsync).toHaveBeenCalledWith(600);
    expect(sound.pauseAsync).not.toHaveBeenCalled();
  });

  it("does NOT seek when drift is within ~250 ms (the audio is allowed to freewheel)", async () => {
    await mountModal();
    const sound = expoAv.captured.sounds[0]!;

    // Prime the audio at t=0.
    await dispatchStatus({ isPlaying: true, positionMillis: 0 });
    expect(sound.playAsync).toHaveBeenCalledTimes(1);

    // Video advances 200 ms; audio is still at 0 → drift = 200 ms, under
    // the 250 ms threshold, so no setPositionAsync.
    sound._state.positionMillis = 0;
    sound._state.isPlaying = true;
    await dispatchStatus({ isPlaying: true, positionMillis: 200 });

    expect(sound.setPositionAsync).not.toHaveBeenCalled();
  });

  it("pauses the voice-over once positionMillis passes voiceOverDurationSeconds * 1000", async () => {
    await mountModal(4); // cap = 4000 ms
    const sound = expoAv.captured.sounds[0]!;

    // Prime: video starts playing in sync at t=1000 ms while the audio
    // is still at 0 / not playing — that should kick off audio.playAsync()
    // and seek the audio to 1000 ms (drift 1000 > 250).
    sound._state.positionMillis = 0;
    sound._state.isPlaying = false;
    await dispatchStatus({ isPlaying: true, positionMillis: 1000 });
    expect(sound.playAsync).toHaveBeenCalled();
    expect(sound.pauseAsync).not.toHaveBeenCalled();

    // Video plays past the 4000 ms cap → past-end branch should pause.
    // The audio's status reads as playing (so the production code's
    // `voicePlayingRef.current && pauseAsync()` guard fires).
    sound._state.positionMillis = 3500;
    sound._state.isPlaying = true;
    await dispatchStatus({ isPlaying: true, positionMillis: 5000 });

    expect(sound.pauseAsync).toHaveBeenCalledTimes(1);
    // The past-end branch must NOT seek the audio (there's nothing
    // useful past the cap to seek to).
    const seekCallsPastCap = (sound.setPositionAsync as Mock).mock.calls.filter(
      ([ms]) => ms >= 4000,
    );
    expect(seekCallsPastCap).toHaveLength(0);
  });

  it("pauses the voice-over and clears the playing indicator when the video reports didJustFinish", async () => {
    // The `didJustFinish` branch lives above the `shouldRunVoiceSync`
    // throttle in `onPlaybackStatus` and is independent from the
    // `computeVoiceSyncAction` past-end logic exercised above. It exists
    // because expo-av reports `isPlaying = false` together with
    // `didJustFinish = true` on the very last status tick, and without
    // this branch the voice-over would keep playing even though the
    // swing video has ended. This test pins that branch so a future
    // refactor of `onPlaybackStatus` can't silently regress it.
    await mountModal(10); // cap = 10000 ms, well past anything we play
    const sound = expoAv.captured.sounds[0]!;

    // Prime: video is playing in sync, audio kicks off via syncVoiceToVideo.
    await dispatchStatus({ isPlaying: true, positionMillis: 1000 });
    expect(sound.playAsync).toHaveBeenCalledTimes(1);
    expect(sound.pauseAsync).not.toHaveBeenCalled();
    // The accessibility label flips to "Voice-over playing" once
    // `setVoicePlaying(true)` fires inside `syncVoiceToVideo`.
    expect(screen.getByLabelText("Voice-over playing")).toBeTruthy();

    // Now the video reports it has just finished. expo-av sends
    // `isPlaying = false` together with `didJustFinish = true` on the
    // final status tick, which is exactly the branch under test.
    sound._state.positionMillis = 1000;
    sound._state.isPlaying = true;
    await dispatchStatus({
      isPlaying: false,
      didJustFinish: true,
      positionMillis: 10_000,
      durationMillis: 10_000,
    });

    // The didJustFinish branch must pause the voice-over...
    expect(sound.pauseAsync).toHaveBeenCalledTimes(1);
    // ...and the visible "voice-over playing" indicator must clear
    // (AudioLevelIndicator's accessibilityLabel flips back to
    // "Voice-over paused" when `setVoicePlaying(false)` fires).
    await waitFor(() => {
      expect(screen.getByLabelText("Voice-over paused")).toBeTruthy();
    });
    expect(screen.queryByLabelText("Voice-over playing")).toBeNull();
  });
});
