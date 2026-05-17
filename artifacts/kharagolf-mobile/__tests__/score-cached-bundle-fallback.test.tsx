/**
 * Task #1591 — regression coverage for the score screen's offline `/holes`
 * fallback (originally added in Task #1160).
 *
 * The fallback wiring lives in `useHolesWithCachedFallback` (in
 * `utils/useHolesWithCachedFallback.ts`), which `app/(tabs)/score.tsx`
 * consumes for its in-round scorecard. Without this hook firing correctly,
 * the scorecard would blank out for offline players when
 * `/api/tournaments/:id/holes` rejects mid-round.
 *
 * Task #1333 already covers the projection helper itself
 * (`bundleToHolesResponse`) and the HoleMapSheet / CaddieCard banners that
 * surface the same fallback. This test fills the remaining gap: the score
 * screen's own consumer of the fallback hook.
 *
 * We exercise the REAL hook (not a copy) and render a tiny consumer that
 * mirrors how the score-screen HoleCard reads `hole.holeNumber`,
 * `hole.par`, and `hole.yardageWhite` (`app/(tabs)/score.tsx` ~lines
 * 985-1004), so a regression in the hook OR the rendered fields trips the
 * test.
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// AsyncStorage is shared between the test setup (priming a cached bundle)
// and the helper-under-test (`loadCachedCourseBundleForRound`).
const memoryStore = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (k: string) => Promise.resolve(memoryStore.get(k) ?? null),
    setItem: (k: string, v: string) => { memoryStore.set(k, v); return Promise.resolve(); },
    removeItem: (k: string) => { memoryStore.delete(k); return Promise.resolve(); },
    getAllKeys: () => Promise.resolve(Array.from(memoryStore.keys())),
  },
}));

type FetchPublicResponse = unknown;
type FetchPublicFn = <T = FetchPublicResponse>(path: string) => Promise<T>;

vi.mock("@/utils/api", () => ({
  BASE_URL: "",
  fetchPublic: vi.fn<FetchPublicFn>(),
}));

import {
  useHolesWithCachedFallback,
  type HolesResponse,
} from "@/utils/useHolesWithCachedFallback";
import { COURSE_BUNDLE_KEY_PREFIX } from "@/utils/courseBundle";
import { fetchPublic } from "@/utils/api";

const fetchPublicMock = vi.mocked(fetchPublic) as unknown as Mock<FetchPublicFn>;

// ── Score-screen consumer harness ───────────────────────────────────────────
//
// Calls the REAL `useHolesWithCachedFallback` hook from production, then
// mirrors the score-screen HoleCard's read of hole.holeNumber, hole.par
// and hole.yardageWhite. The score screen's HoleCard lives inside a
// 5.8k-line file with native dependencies that can't be bundled under
// jsdom (camera, sensors, FileSystem, etc.), so we exercise the real
// hook + mirror only the three fields the in-round scorecard renders.
function ScoreScreenConsumer({
  tournamentId,
  round,
}: { tournamentId: number; round: number }) {
  const { data: holesData, isLoading, usingCachedCourse } =
    useHolesWithCachedFallback({ tournamentId, round });

  if (isLoading) return <span data-testid="loading">loading</span>;
  if (!holesData) return <span data-testid="no-data">no holes</span>;

  return (
    <div data-testid="scorecard">
      {usingCachedCourse && (
        <div data-testid="using-cached">Offline · saved course data</div>
      )}
      {holesData.holes.map((h) => (
        <div key={h.holeNumber} data-testid={`hole-${h.holeNumber}`}>
          <span>HOLE {h.holeNumber}</span>
          <span> · PAR {h.par}</span>
          {h.yardageWhite ? <span> · {h.yardageWhite} yds</span> : null}
        </div>
      ))}
    </div>
  );
}

function renderConsumer(): void {
  // Disable retries so a single deliberate rejection doesn't trigger
  // background re-attempts that would re-set `usingCachedCourse` mid-test.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <ScoreScreenConsumer tournamentId={TOURNAMENT_ID} round={1} />
    </QueryClientProvider>,
  );
}

// ── Test fixtures ──────────────────────────────────────────────────────────

const TOURNAMENT_ID = 314;
const COURSE_ID = 88;
const ORG_ID = 9;

function primeCachedBundle() {
  // A minimal-but-realistic two-hole bundle covering the par + yardage +
  // greenCentre fields the in-round scorecard reads.
  const bundle = {
    courseId: COURSE_ID,
    course: { id: COURSE_ID, name: "Cached Course", organizationId: ORG_ID },
    holes: [
      {
        courseId: COURSE_ID,
        holeNumber: 1,
        par: 4,
        yardageWhite: 380,
        handicap: 7,
        greenCentreLat: "12.971800",
        greenCentreLng: "77.594560",
      },
      {
        courseId: COURSE_ID,
        holeNumber: 2,
        par: 5,
        yardageWhite: 510,
        handicap: 3,
        greenCentreLat: "12.972100",
        greenCentreLng: "77.594880",
      },
    ],
    geometry: [],
    roundContext: {
      tournamentId: TOURNAMENT_ID,
      leagueId: null,
      generalPlayRoundId: null,
      aiCaddieMode: "open" as const,
    },
    cachedAt: new Date().toISOString(),
  };
  memoryStore.set(
    `${COURSE_BUNDLE_KEY_PREFIX}${COURSE_ID}`,
    JSON.stringify({ fetchedAt: Date.now(), bundle }),
  );
}

beforeEach(() => {
  memoryStore.clear();
  fetchPublicMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("score screen — cached course bundle fallback (Task #1591)", () => {
  it("renders the scorecard from the cached bundle when /tournaments/:id/holes rejects", async () => {
    primeCachedBundle();
    fetchPublicMock.mockImplementation(async (path: string) => {
      if (path.includes("/tournaments/") && path.includes("/holes")) {
        throw new Error("offline");
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    renderConsumer();

    // The fallback resolves through a real AsyncStorage round-trip, so we
    // wait rather than asserting synchronously.
    await waitFor(() => {
      expect(screen.getByTestId("scorecard")).toBeInTheDocument();
    });

    // The hook must have hit the right URL — this guards against a future
    // refactor that changes the round/tournament path shape.
    expect(fetchPublicMock).toHaveBeenCalledWith(
      `/tournaments/${TOURNAMENT_ID}/holes?round=1`,
    );

    // Hole numbers, pars, and yardages must all flow through from the
    // cached bundle into the rendered scorecard.
    const hole1 = screen.getByTestId("hole-1");
    expect(hole1.textContent).toContain("HOLE 1");
    expect(hole1.textContent).toContain("PAR 4");
    expect(hole1.textContent).toContain("380 yds");

    const hole2 = screen.getByTestId("hole-2");
    expect(hole2.textContent).toContain("HOLE 2");
    expect(hole2.textContent).toContain("PAR 5");
    expect(hole2.textContent).toContain("510 yds");

    // The round-level "saved course data" indicator is set so the score
    // screen can thread it down into GpsDistanceRow / CaddieCard /
    // HoleMapSheet (Task #1160 / #1332 / #1586 wiring).
    expect(screen.getByTestId("using-cached")).toBeInTheDocument();
  });

  it("uses the live response when /tournaments/:id/holes succeeds", async () => {
    // Prime a bundle anyway so we can prove the live path takes priority.
    primeCachedBundle();
    fetchPublicMock.mockImplementation(async (path: string) => {
      if (path.includes("/tournaments/") && path.includes("/holes")) {
        return {
          holes: [
            { holeNumber: 1, par: 3, yardageWhite: 175 },
          ],
          rounds: 1,
          courseId: COURSE_ID,
          organizationId: ORG_ID,
        } as HolesResponse;
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    renderConsumer();

    await waitFor(() => {
      expect(screen.getByTestId("hole-1").textContent).toContain("PAR 3");
    });
    expect(screen.getByTestId("hole-1").textContent).toContain("175 yds");
    // The "saved course data" indicator must NOT be set when the live
    // call succeeded.
    expect(screen.queryByTestId("using-cached")).not.toBeInTheDocument();
    // And cached pars / yardages must NOT bleed through.
    expect(screen.queryByText(/PAR 4/)).not.toBeInTheDocument();
    expect(screen.queryByText(/380 yds/)).not.toBeInTheDocument();
  });

  it("renders nothing when the live call fails AND no cached bundle is available", async () => {
    // No primeCachedBundle() — the fallback's bundle lookup must come
    // back empty, so the query rethrows and the scorecard never renders.
    fetchPublicMock.mockImplementation(async (path: string) => {
      if (path.includes("/tournaments/") && path.includes("/holes")) {
        throw new Error("offline");
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    renderConsumer();

    // Wait for the query to settle (loading → error). The scorecard must
    // not appear.
    await waitFor(() => {
      expect(screen.queryByTestId("loading")).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId("scorecard")).not.toBeInTheDocument();
    expect(screen.queryByTestId("using-cached")).not.toBeInTheDocument();
  });
});
