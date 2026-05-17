/**
 * Task #1383 — the super-admin "Watch GPS position rate" panel must
 * remember the chosen 24h / 7d / 30d window between visits. The previous
 * implementation kept the selection in plain `useState`, which reset to
 * "24h" on every mount. This test pins down the new behaviour:
 *
 *   1. A direct link with `?watchWindow=7d` opens the panel on the 7d
 *      window without the admin clicking anything.
 *   2. Clicking 30d mirrors the choice into the URL (`?watchWindow=30d`)
 *      via `history.replaceState` AND into a `super-admin:watchWindow`
 *      localStorage entry, so a follow-up visit (no query string, fresh
 *      mount) still opens on 30d.
 *   3. Switching back to the default 24h cleans the query string up
 *      again rather than pinning `?watchWindow=24h` on the URL forever.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: { id: 1, organizationId: 1, role: "super_admin" },
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/super-admin", vi.fn()],
}));

import SuperAdminPage from "../super-admin";

// Per-window summaries with deliberately distinct numbers so we can tell
// which window is rendered without inspecting any internal state.
const WINDOWS = {
  "24h": {
    totalMessages: 100,
    bucketCount: 11,
    activeSessionCount: 3,
    avgMessagesPerSessionMinute: 5.5,
    p50MessagesPerSessionMinute: 5,
    p95MessagesPerSessionMinute: 9,
    maxMessagesPerSessionMinute: 12,
  },
  "7d": {
    totalMessages: 700,
    bucketCount: 77,
    activeSessionCount: 21,
    avgMessagesPerSessionMinute: 6.6,
    p50MessagesPerSessionMinute: 6,
    p95MessagesPerSessionMinute: 14,
    maxMessagesPerSessionMinute: 22,
  },
  "30d": {
    totalMessages: 3000,
    bucketCount: 333,
    activeSessionCount: 88,
    avgMessagesPerSessionMinute: 7.7,
    p50MessagesPerSessionMinute: 7,
    p95MessagesPerSessionMinute: 17,
    maxMessagesPerSessionMinute: 33,
  },
} as const;

const SERIES = {
  "24h": [
    { bucket: "2026-04-23T10:00:00.000Z", sampleCount: 2, avg: 5.5, p95: 9, max: 12, batteryAvg: null, batterySampleCount: 0, normalAvg: 5.5, normalSampleCount: 2 },
  ],
  "7d": [
    { bucket: "2026-04-22T10:00:00.000Z", sampleCount: 5, avg: 6.6, p95: 14, max: 22, batteryAvg: 8, batterySampleCount: 1, normalAvg: 6.2, normalSampleCount: 4 },
  ],
  "30d": [
    { bucket: "2026-04-15T00:00:00.000Z", sampleCount: 8, avg: 7.7, p95: 17, max: 33, batteryAvg: 10, batterySampleCount: 2, normalAvg: 7, normalSampleCount: 6 },
  ],
};

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SuperAdminPage />
    </QueryClientProvider>,
  );
}

const STORAGE_KEY = "super-admin:watchWindow";
const ORIGINAL_URL = "/super-admin";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.history.replaceState({}, "", ORIGINAL_URL);
  window.localStorage.removeItem(STORAGE_KEY);

  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.startsWith("/api/super-admin/dashboard") && method === "GET") {
      return jsonResponse({
        totalClubs: 0, activeClubs: 0, totalUsers: 0, totalTournaments: 0,
        activeTournaments: 0,
        tierBreakdown: { free: 0, starter: 0, pro: 0, enterprise: 0 },
        estimatedMrr: 0, bookingsThisMonth: 0, bookingRevenueThisMonth: 0,
        bookingsByClub: [],
      });
    }
    if (url.startsWith("/api/super-admin/caddie-prompt-metrics") && method === "GET") {
      return jsonResponse({
        total: 0, windowStart: null, windowEnd: null,
        byMode: { shots: 0, rounds: 0 },
        avgEstimatedInputTokens: 0, p50EstimatedInputTokens: 0,
        p95EstimatedInputTokens: 0, maxEstimatedInputTokens: 0,
        avgTotalTrackedShots: 0, avgRoundCount: 0, recent: [],
      });
    }
    if (url.startsWith("/api/super-admin/watch-position-metrics") && method === "GET") {
      return jsonResponse({
        windows: WINDOWS,
        seriesByWindow: SERIES,
        seriesBucketSeconds: { "24h": 60, "7d": 3600, "30d": 6 * 3600 },
        recent: [],
      });
    }
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  window.history.replaceState({}, "", ORIGINAL_URL);
  window.localStorage.removeItem(STORAGE_KEY);
});

describe("Super-admin Watch GPS — chosen window persists between visits", () => {
  it("opens on the window encoded in the URL (?watchWindow=7d) without a click", async () => {
    window.history.replaceState({}, "", "/super-admin?watchWindow=7d");

    renderPage();

    // The 7d numbers should be on screen on first paint — no click required.
    await waitFor(() => {
      expect(screen.getByTestId("text-watch-avg-rate")).toHaveTextContent(/6\.6/);
    });
    expect(screen.getByTestId("text-watch-max-rate")).toHaveTextContent(/^22$/);
    expect(screen.getByTestId("text-watch-sessions")).toHaveTextContent(/^21$/);
    // The 7d button is the selected tab.
    expect(screen.getByTestId("button-watch-window-7d")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // None of the 24h-only numbers leak in.
    expect(screen.getByTestId("text-watch-avg-rate")).not.toHaveTextContent(/5\.5/);
  });

  it("falls back to the default 24h when ?watchWindow=garbage is passed", async () => {
    window.history.replaceState({}, "", "/super-admin?watchWindow=bogus");

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("text-watch-avg-rate")).toHaveTextContent(/5\.5/);
    });
    expect(screen.getByTestId("button-watch-window-24h")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("mirrors the chosen window into the URL and localStorage, and a fresh mount restores it", async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("text-watch-avg-rate")).toHaveTextContent(/5\.5/);
    });

    // Switching to 30d updates the URL and localStorage.
    await user.click(screen.getByTestId("button-watch-window-30d"));

    await waitFor(() => {
      expect(window.location.search).toBe("?watchWindow=30d");
    });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("30d");

    // Switching back to 24h removes the query string entirely (we don't
    // want to pin the default value on the URL forever).
    await user.click(screen.getByTestId("button-watch-window-24h"));
    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("24h");

    // Now go back to 7d so we can prove a fresh mount with no query
    // string still restores the last choice from localStorage.
    await user.click(screen.getByTestId("button-watch-window-7d"));
    await waitFor(() => {
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe("7d");
    });

    unmount();

    // Simulate a fresh visit — clean URL, but localStorage retained.
    window.history.replaceState({}, "", ORIGINAL_URL);

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("text-watch-avg-rate")).toHaveTextContent(/6\.6/);
    });
    expect(screen.getByTestId("button-watch-window-7d")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("URL takes precedence over a stored localStorage value", async () => {
    // localStorage says 30d, but the URL says 7d — URL wins so deep-links
    // are deterministic.
    window.localStorage.setItem(STORAGE_KEY, "30d");
    window.history.replaceState({}, "", "/super-admin?watchWindow=7d");

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId("text-watch-avg-rate")).toHaveTextContent(/6\.6/);
    });
    expect(screen.getByTestId("button-watch-window-7d")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
