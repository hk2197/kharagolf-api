/**
 * E2E-style component test for the coach voice-over sync inside
 * `ReviewPlaybackModal` on the /coach-marketplace page — Task #1683
 * (regression coverage for Task #1400).
 *
 * Task #1400 tightened the audio↔video sync in
 * `artifacts/kharagolf-web/src/pages/coach-marketplace.tsx` so that a
 * delivered swing review's voice-over stays within ~250 ms of the
 * video element while members:
 *
 *   - press play
 *   - scrub the video to a new position
 *   - change the video's playback rate
 *   - let the video play past `voiceOverDurationSeconds`
 *
 * The mobile equivalent (`artifacts/kharagolf-mobile/app/(tabs)/coach.tsx`
 * → `syncVoiceToVideo`) already had its drift-correction logic exercised
 * by tests; this file adds the matching web-side safety net so that a
 * future refactor of the `useEffect` that wires the two media elements
 * together (e.g. dropping the throttle, the drift threshold, the
 * playbackRate mirror, or the past-end pause) cannot silently regress
 * the playback experience.
 *
 * The test stubs `fetch` with a tiny in-memory backend that owns just
 * enough of the swing-reviews endpoints to land a delivered review with
 * a voice-over in `MyReviewsSection`, opens the modal, then drives the
 * stubbed <video> element through play/scrub/rate-change/past-end
 * events. After each event it asserts on the <audio> element's
 * `currentTime`, `playbackRate`, and `paused` properties — the same
 * properties the production sync effect reads/writes.
 *
 * Notes on the jsdom shims:
 *   - jsdom's HTMLMediaElement does not actually play media, and its
 *     `paused`, `currentTime`, and `playbackRate` getters are pinned to
 *     defaults. `stubMedia` overrides them on each instance with a
 *     local backing store and replaces `play()` / `pause()` with spies
 *     so the production effect's reads and writes round-trip cleanly.
 *   - The sync effect throttles to one re-sync per 100 ms via
 *     `performance.now()`. We spy on `performance.now` and advance a
 *     local clock by 200 ms between scenarios so every dispatched event
 *     is allowed through the throttle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  act,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CoachMarketplacePage from "@/pages/coach-marketplace";

interface ReviewSeed {
  id: number;
  proId: number;
  proName: string;
  videoUrl: string;
  voiceOverUrl: string;
  voiceOverDurationSeconds: number;
}

/**
 * Tiny in-memory backend covering the four endpoints the marketplace
 * page hits while landing on a delivered review with a voice-over:
 *
 *   - GET /api/coach-marketplace/coaches → empty list (we never need
 *     the coach grid; it would just complicate the test if it rendered)
 *   - GET /api/swing-reviews/my-requests → one delivered review so
 *     `MyReviewsSection` renders the "Play review" button
 *   - GET /api/swing-reviews/requests/:id → review detail with the
 *     voice-over URL + capped duration that the sync effect reads
 *
 * Anything else returns an empty 200 so a stray fetch in the page
 * doesn't reject and pollute the console.
 */
function buildBackend(review: ReviewSeed) {
  const calls: { url: string; method: string }[] = [];

  const ok = (body: unknown) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    } as Response);

  const handler = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });
    const path = url.split("?")[0].replace(/^.*\/api\//, "/api/");

    if (method === "GET" && path === "/api/coach-marketplace/coaches") {
      return ok({ coaches: [] });
    }

    if (method === "GET" && path === "/api/swing-reviews/my-requests") {
      const createdAt = new Date("2026-04-29T10:00:00Z").toISOString();
      return ok({
        requests: [
          {
            request: {
              id: review.id,
              proId: review.proId,
              status: "delivered",
              pricePaise: 50000,
              createdAt,
              deliveredAt: createdAt,
              // Already rated → the rating prompt stays hidden so the
              // test isn't competing with star buttons or the textarea
              // for the test's keyboard/mouse focus.
              rating: 5,
              annotationId: 1,
            },
            proName: review.proName,
            proPhoto: null,
            videoUrl: review.videoUrl,
            videoThumb: null,
            videoFps: 30,
          },
        ],
      });
    }

    if (
      method === "GET" &&
      path === `/api/swing-reviews/requests/${review.id}`
    ) {
      return ok({
        request: {
          id: review.id,
          status: "delivered",
          rating: 5,
          annotationId: 1,
          deliveredAt: new Date("2026-04-29T10:00:00Z").toISOString(),
          memberPrompt: null,
        },
        video: { id: 1, videoUrl: review.videoUrl, fps: 30 },
        annotation: {
          id: 1,
          drawings: [],
          voiceOverUrl: review.voiceOverUrl,
          voiceOverDurationSeconds: review.voiceOverDurationSeconds,
          textNotes: null,
        },
        pro: { id: review.proId, displayName: review.proName, photoUrl: null },
      });
    }

    return ok({});
  };

  return { handler, calls };
}

interface MediaStub {
  setCurrentTime: (t: number) => void;
  setPlaybackRate: (r: number) => void;
  setPaused: (p: boolean) => void;
  readonly playSpy: ReturnType<typeof vi.fn>;
  readonly pauseSpy: ReturnType<typeof vi.fn>;
}

/**
 * Replace the four media-element bits the production sync effect
 * touches (`currentTime`, `paused`, `playbackRate`, `play()`,
 * `pause()`) with a local backing store + spies. jsdom's defaults
 * either pin these to constants (`paused` is always true, `playbackRate`
 * is always 1) or no-op the methods, which would make every assertion
 * below trivially pass — defining them on the instance forces the
 * production code through the same property reads/writes a real
 * browser would see.
 */
function stubMedia(el: HTMLMediaElement): MediaStub {
  let _currentTime = 0;
  let _paused = true;
  let _playbackRate = 1;

  Object.defineProperty(el, "currentTime", {
    configurable: true,
    get: () => _currentTime,
    set: (v: number) => {
      _currentTime = v;
    },
  });
  Object.defineProperty(el, "paused", {
    configurable: true,
    get: () => _paused,
  });
  Object.defineProperty(el, "playbackRate", {
    configurable: true,
    get: () => _playbackRate,
    set: (v: number) => {
      _playbackRate = v;
    },
  });

  const playSpy = vi.fn(() => {
    _paused = false;
    return Promise.resolve();
  });
  const pauseSpy = vi.fn(() => {
    _paused = true;
  });
  // Cast through unknown to satisfy the dom lib's strict play() signature
  // while keeping the real prototype methods out of the way.
  (el as unknown as { play: () => Promise<void> }).play =
    playSpy as unknown as () => Promise<void>;
  (el as unknown as { pause: () => void }).pause =
    pauseSpy as unknown as () => void;

  return {
    setCurrentTime: (t: number) => {
      _currentTime = t;
    },
    setPlaybackRate: (r: number) => {
      _playbackRate = r;
    },
    setPaused: (p: boolean) => {
      _paused = p;
    },
    get playSpy() {
      return playSpy;
    },
    get pauseSpy() {
      return pauseSpy;
    },
  };
}

describe("ReviewPlaybackModal voice-over sync (Task #1683)", () => {
  let backend: ReturnType<typeof buildBackend>;
  // The sync effect throttles to 100 ms via performance.now(); a
  // local mock clock lets the test step past the throttle deterministically
  // between scenarios, instead of relying on real wall-clock waits.
  let mockNow = 0;

  beforeEach(() => {
    mockNow = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => mockNow);

    backend = buildBackend({
      id: 77,
      proId: 9,
      proName: "Pro VoiceSync",
      videoUrl: "https://example.test/swing.mp4",
      voiceOverUrl: "https://example.test/voice.mp3",
      // Cap intentionally short so Scenario D can scrub past it
      // without needing an unrealistic video time.
      voiceOverDurationSeconds: 4.0,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(backend.handler) as unknown as typeof fetch,
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the audio within ~250 ms of the video across play/scrub/rate-change and pauses past voiceOverDurationSeconds", async () => {
    const user = userEvent.setup();
    render(<CoachMarketplacePage />);

    // ── Land on the delivered review and open the playback modal ─────
    const playBtn = await screen.findByTestId("button-play-review-77");
    await user.click(playBtn);

    await screen.findByTestId("review-playback-modal");
    const videoEl = (await screen.findByTestId(
      "review-video",
    )) as HTMLVideoElement;
    const audioEl = (await screen.findByTestId(
      "review-voiceover",
    )) as HTMLAudioElement;

    // Stub the media elements BEFORE driving any events. The sync
    // effect has already attached its `addEventListener` listeners by
    // the time the audio element exists in the DOM (the effect re-runs
    // when `data` arrives, and the audio only renders once `data` has
    // arrived), so the listeners will read through these stubs as
    // soon as we dispatch.
    const v = stubMedia(videoEl);
    const a = stubMedia(audioEl);

    // Flush any pending effects so the listeners we'll trigger are
    // definitely registered against the stubbed elements.
    await act(async () => {
      await Promise.resolve();
    });

    // ── Scenario A: member presses play ──────────────────────────────
    // Video advances to 0.10s and is no longer paused; on `play` the
    // sync should mirror playback rate, leave the audio currentTime
    // alone (drift is only 100 ms — well under the 250 ms threshold),
    // and call audio.play().
    v.setCurrentTime(0.1);
    v.setPaused(false);
    mockNow += 200;
    await act(async () => {
      fireEvent(videoEl, new Event("play"));
    });
    expect(a.playSpy).toHaveBeenCalled();
    expect(audioEl.paused).toBe(false);
    // Drift assertion — the headline guarantee from Task #1400.
    expect(
      Math.abs(audioEl.currentTime - videoEl.currentTime),
    ).toBeLessThanOrEqual(0.25);

    // ── Scenario B: member scrubs the video ──────────────────────────
    // Big jump (0 → 2.5s) blows past the 250 ms drift threshold, so
    // the sync MUST snap audio.currentTime to the new position.
    v.setCurrentTime(2.5);
    mockNow += 200;
    await act(async () => {
      fireEvent(videoEl, new Event("seeked"));
    });
    expect(audioEl.currentTime).toBeCloseTo(2.5, 5);
    expect(
      Math.abs(audioEl.currentTime - videoEl.currentTime),
    ).toBeLessThanOrEqual(0.25);
    // Audio remains playing — the seek shouldn't have toggled it.
    expect(audioEl.paused).toBe(false);

    // ── Scenario C: member changes playback rate ─────────────────────
    // The sync effect mirrors v.playbackRate to a.playbackRate on
    // every `ratechange`. After the mirror, drift is still 0 so no
    // re-seek should happen.
    const audioCurrentTimeBeforeRate = audioEl.currentTime;
    v.setPlaybackRate(2);
    mockNow += 200;
    await act(async () => {
      fireEvent(videoEl, new Event("ratechange"));
    });
    expect(audioEl.playbackRate).toBe(2);
    expect(audioEl.currentTime).toBeCloseTo(audioCurrentTimeBeforeRate, 5);
    expect(
      Math.abs(audioEl.currentTime - videoEl.currentTime),
    ).toBeLessThanOrEqual(0.25);

    // ── Scenario D: video runs past voiceOverDurationSeconds ─────────
    // Cap is 4.0s; jump the video to 5.5s and dispatch a (throttled)
    // timeupdate. The sync's pastEnd branch should pause the audio
    // cleanly and leave its currentTime alone (no point seeking the
    // audio past its own duration). This is the "stops cleanly once
    // the video plays past the voice-over duration" guarantee.
    const audioCurrentTimeBeforePastEnd = audioEl.currentTime;
    const pauseCallsBefore = a.pauseSpy.mock.calls.length;
    v.setCurrentTime(5.5);
    mockNow += 200;
    await act(async () => {
      fireEvent(videoEl, new Event("timeupdate"));
    });
    expect(a.pauseSpy.mock.calls.length).toBeGreaterThan(pauseCallsBefore);
    expect(audioEl.paused).toBe(true);
    // Audio currentTime is intentionally NOT advanced past the cap —
    // mirrors the mobile branch which also skips the position update
    // when pastEnd is true.
    expect(audioEl.currentTime).toBeCloseTo(
      audioCurrentTimeBeforePastEnd,
      5,
    );
  });
});
