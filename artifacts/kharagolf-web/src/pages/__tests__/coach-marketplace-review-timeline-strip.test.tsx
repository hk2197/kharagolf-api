/**
 * UI test (Task #1409) — the member-facing swing-review playback on the
 * web Coach Marketplace shows a read-only timeline marker strip beneath
 * the video, mirroring mobile's RequestDetailModalInner:
 *
 *   - One marker per drawing in the delivered annotation.
 *   - Markers carry a stable test id (`review-drawing-marker-<i>`).
 *   - Clicking a marker seeks the underlying <video> element to the
 *     drawing's timestamp.
 *
 * The test stubs `fetch` so the page can mount with a single coach and
 * one delivered review whose annotation has three drawings.
 *
 * jsdom's HTMLMediaElement does not implement playback or duration, so
 * we stub `duration` and `currentTime` on HTMLMediaElement.prototype to
 * exercise the marker strip's seek + positioning behaviour without
 * pulling in a real media engine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import CoachMarketplacePage from "../coach-marketplace";

const COACH = {
  proId: 1,
  organizationId: 1,
  organizationName: "Test Club",
  displayName: "Test Coach",
  bio: null,
  photoUrl: null,
  specialisms: [],
  certifications: [],
  yearsExperience: 5,
  languages: ["en"],
  hourlyRatePaise: 500000,
  asyncReviewPricePaise: 200000,
  acceptsInPerson: true,
  acceptsAsync: true,
  asyncTurnaroundHours: 48,
  ratingsAvg: 0,
  ratingsCount: 0,
};

const DELIVERED_REQUEST = {
  request: {
    id: 7,
    proId: 1,
    status: "delivered",
    pricePaise: 200000,
    createdAt: "2026-04-20T10:00:00.000Z",
    deliveredAt: "2026-04-21T10:00:00.000Z",
    rating: null,
    annotationId: 99,
  },
  proName: "Test Coach",
  proPhoto: null,
  videoUrl: "https://example.test/swing.mp4",
  videoThumb: null,
  videoFps: 60,
};

const DRAWINGS = [
  { kind: "line", t: 1.0, color: "#ff0000", x1: 10, y1: 10, x2: 20, y2: 20 },
  { kind: "circle", t: 5.0, color: "#00ff00", x: 50, y: 50, r: 15 },
  { kind: "arrow", t: 9.0, color: "#0000ff", x1: 30, y1: 30, x2: 60, y2: 60 },
];

const DETAIL = {
  request: {
    id: 7,
    status: "delivered",
    rating: null,
    annotationId: 99,
    deliveredAt: "2026-04-21T10:00:00.000Z",
    memberPrompt: null,
  },
  video: { id: 33, videoUrl: "https://example.test/swing.mp4", fps: 60 },
  annotation: {
    id: 99,
    drawings: DRAWINGS,
    voiceOverUrl: null,
    voiceOverDurationSeconds: null,
    textNotes: "Nice tempo!",
  },
  pro: { id: 1, displayName: "Test Coach", photoUrl: null },
};

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/coach-marketplace/coaches")) {
        return jsonResponse({ coaches: [COACH] });
      }
      if (url.endsWith("/api/swing-reviews/my-requests")) {
        return jsonResponse({ requests: [DELIVERED_REQUEST] });
      }
      if (url.endsWith("/api/swing-reviews/requests/7")) {
        return jsonResponse(DETAIL);
      }
      return jsonResponse({});
    }) as unknown as typeof fetch,
  );
}

// Stub HTMLMediaElement so we can drive `duration`/`currentTime` and
// observe the seek that the marker strip's onClick performs.
function stubVideoElement() {
  let currentTime = 0;
  let duration = 10;
  const proto = window.HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  const original = {
    currentTime: Object.getOwnPropertyDescriptor(proto, "currentTime"),
    duration: Object.getOwnPropertyDescriptor(proto, "duration"),
    load: proto.load,
    play: proto.play,
    pause: proto.pause,
  };
  Object.defineProperty(proto, "currentTime", {
    configurable: true,
    get() { return currentTime; },
    set(v: number) { currentTime = v; },
  });
  Object.defineProperty(proto, "duration", {
    configurable: true,
    get() { return duration; },
    set(v: number) { duration = v; },
  });
  proto.load = function () {};
  proto.play = function () { return Promise.resolve(); };
  proto.pause = function () {};
  return {
    setDuration: (v: number) => { duration = v; },
    getCurrentTime: () => currentTime,
    restore: () => {
      if (original.currentTime) Object.defineProperty(proto, "currentTime", original.currentTime);
      if (original.duration) Object.defineProperty(proto, "duration", original.duration);
      if (original.load) proto.load = original.load;
      if (original.play) proto.play = original.play;
      if (original.pause) proto.pause = original.pause;
    },
  };
}

describe("Coach Marketplace — member review timeline marker strip (Task #1409)", () => {
  let stub: ReturnType<typeof stubVideoElement>;
  beforeEach(() => {
    stub = stubVideoElement();
  });
  afterEach(() => {
    stub.restore();
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders one marker per drawing inside the playback modal", async () => {
    installFetch();
    const user = userEvent.setup();
    render(<CoachMarketplacePage />);

    const playBtn = await screen.findByTestId("button-play-review-7");
    await user.click(playBtn);

    // Trigger metadata load so the marker strip learns the duration.
    const video = (await screen.findByTestId("review-video")) as HTMLVideoElement;
    fireEvent.loadedMetadata(video);

    await waitFor(() => {
      expect(screen.getByTestId("review-drawing-timeline-strip")).toBeInTheDocument();
      expect(screen.getByTestId("review-drawing-marker-0")).toBeInTheDocument();
      expect(screen.getByTestId("review-drawing-marker-1")).toBeInTheDocument();
      expect(screen.getByTestId("review-drawing-marker-2")).toBeInTheDocument();
    });

    // Marker positions are proportional to the (t / duration). With the
    // stub duration = 10s, drawings at 1s/5s/9s should land at ~10%, 50%, 90%.
    const m0 = screen.getByTestId("review-drawing-marker-0") as HTMLElement;
    const m1 = screen.getByTestId("review-drawing-marker-1") as HTMLElement;
    const m2 = screen.getByTestId("review-drawing-marker-2") as HTMLElement;
    expect(m0.style.left).toBe("10%");
    expect(m1.style.left).toBe("50%");
    expect(m2.style.left).toBe("90%");
  });

  it("seeks the video to the drawing's timestamp when a marker is clicked", async () => {
    installFetch();
    const user = userEvent.setup();
    render(<CoachMarketplacePage />);

    const playBtn = await screen.findByTestId("button-play-review-7");
    await user.click(playBtn);

    const video = (await screen.findByTestId("review-video")) as HTMLVideoElement;
    fireEvent.loadedMetadata(video);

    const marker = await screen.findByTestId("review-drawing-marker-1");
    await user.click(marker);

    expect(stub.getCurrentTime()).toBe(5);
  });

  it("hides the strip entirely when the delivered review has no drawings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/coach-marketplace/coaches")) {
          return jsonResponse({ coaches: [COACH] });
        }
        if (url.endsWith("/api/swing-reviews/my-requests")) {
          return jsonResponse({ requests: [DELIVERED_REQUEST] });
        }
        if (url.endsWith("/api/swing-reviews/requests/7")) {
          return jsonResponse({
            ...DETAIL,
            annotation: { ...DETAIL.annotation, drawings: [] },
          });
        }
        return jsonResponse({});
      }) as unknown as typeof fetch,
    );
    const user = userEvent.setup();
    render(<CoachMarketplacePage />);

    const playBtn = await screen.findByTestId("button-play-review-7");
    await user.click(playBtn);

    const video = (await screen.findByTestId("review-video")) as HTMLVideoElement;
    fireEvent.loadedMetadata(video);

    // Wait long enough for the strip to render if drawings were present;
    // since there are none, it should never appear.
    await waitFor(() => {
      expect(screen.getByTestId("review-video-fps")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("review-drawing-timeline-strip")).toBeNull();
  });
});
