/**
 * UI test (Task #1211) — the new member-facing swing-review playback on the
 * web Coach Marketplace surfaces the source video's frame rate next to the
 * playback controls, mirroring the coach delivery canvas:
 *
 *   - When the server has a persisted fps for the source video, the page
 *     renders "{N}fps" immediately on opening the playback modal.
 *   - When the server's fps is null (slow-mo not yet detected), the page
 *     renders the "detecting…" placeholder.
 *
 * The test stubs `fetch` so that:
 *   - GET /api/coach-marketplace/coaches returns one coach (so the page
 *     mounts cleanly with the standard layout)
 *   - GET /api/swing-reviews/my-requests returns one delivered request
 *   - GET /api/swing-reviews/requests/:id returns the matching detail with
 *     a parameterised `video.fps` value
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
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
  videoFps: null,
};

function jsonResponse(body: unknown, ok = true) {
  return Promise.resolve({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

function buildDetail(fps: number | string | null) {
  return {
    request: {
      id: 7,
      status: "delivered",
      rating: null,
      annotationId: 99,
      deliveredAt: "2026-04-21T10:00:00.000Z",
      memberPrompt: null,
    },
    video: { id: 33, videoUrl: "https://example.test/swing.mp4", fps },
    annotation: {
      id: 99,
      drawings: [],
      voiceOverUrl: null,
      voiceOverDurationSeconds: null,
      textNotes: "Nice tempo!",
    },
    pro: { id: 1, displayName: "Test Coach", photoUrl: null },
  };
}

function installFetch(detailFps: number | string | null) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
      if (url.includes("/api/coach-marketplace/coaches")) {
        return jsonResponse({ coaches: [COACH] });
      }
      if (url.endsWith("/api/swing-reviews/my-requests")) {
        return jsonResponse({ requests: [DELIVERED_REQUEST] });
      }
      if (url.endsWith("/api/swing-reviews/requests/7")) {
        return jsonResponse(buildDetail(detailFps));
      }
      return jsonResponse({});
    }) as unknown as typeof fetch,
  );
  return calls;
}

describe("Coach Marketplace — member review playback fps label (Task #1211)", () => {
  beforeEach(() => {
    // wouter calls window.history; jsdom has it. No extra stubs required.
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the persisted fps label next to the playback controls when the server reports it", async () => {
    installFetch(60);
    const user = userEvent.setup();
    render(<CoachMarketplacePage />);

    // The "My swing reviews" section appears once /my-requests resolves.
    const playBtn = await screen.findByTestId("button-play-review-7");
    await user.click(playBtn);

    // Modal opens; detail load resolves; fps label shows "60fps".
    await waitFor(() => {
      const label = screen.getByTestId("review-video-fps");
      expect(label.textContent).toBe("60fps");
    });
  });

  it("falls back to the 'detecting…' placeholder when the server has no fps yet", async () => {
    installFetch(null);
    const user = userEvent.setup();
    render(<CoachMarketplacePage />);

    const playBtn = await screen.findByTestId("button-play-review-7");
    await user.click(playBtn);

    await waitFor(() => {
      const label = screen.getByTestId("review-video-fps");
      expect(label.textContent).toBe("detecting…");
    });
  });

  it("rounds non-integer fps values (e.g. 29.97) for the visible label", async () => {
    installFetch("29.97");
    const user = userEvent.setup();
    render(<CoachMarketplacePage />);

    const playBtn = await screen.findByTestId("button-play-review-7");
    await user.click(playBtn);

    await waitFor(() => {
      const label = screen.getByTestId("review-video-fps");
      expect(label.textContent).toBe("30fps");
    });
  });

  it("does not POST to the coach-only fps persistence endpoint from the member modal", async () => {
    // Persistence (POST /api/swing-reviews/requests/:id/swing-video-fps) is
    // gated to the assigned coach in artifacts/api-server/src/routes/swing-reviews.ts;
    // calling it from a member viewer would always 403 and add log noise.
    const calls = installFetch(60);
    const user = userEvent.setup();
    render(<CoachMarketplacePage />);

    const playBtn = await screen.findByTestId("button-play-review-7");
    await user.click(playBtn);

    await waitFor(() => {
      expect(screen.getByTestId("review-video-fps").textContent).toBe("60fps");
    });

    const persistCalls = calls.filter(c =>
      c.url.endsWith("/api/swing-reviews/requests/7/swing-video-fps") && c.method === "POST",
    );
    expect(persistCalls).toEqual([]);
  });
});
