/**
 * UI test: Shot Analytics Putting Make-Rate + Proximity-by-Club low-sample
 * captions (Task #1997).
 *
 * Mounts <ShotAnalyticsPanel /> with mocked putting + proximity-by-club
 * responses where some bands/clubs have very few attempts/shots, and asserts:
 *   - The "Limited sample (faded bars)" caption appears under the putting
 *     chart and lists every band with attempts < MIN_TRUSTWORTHY_SAMPLE.
 *   - The same caption appears under the proximity-by-club chart and lists
 *     every club with shots < MIN_TRUSTWORTHY_SAMPLE.
 *   - Neither caption renders when every band/club is comfortably above
 *     the threshold.
 *
 * The visual opacity change on the bars themselves is hard to assert under
 * jsdom (recharts SVG geometry isn't laid out), so we cover it via the
 * caption rendering — both branches share the same predicate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ShotAnalyticsPanel } from "../stats";

interface PuttingResponse {
  bands: { band: string; attempts: number; makes: number; makePct: number | null }[];
}

interface ProxByClubResponse {
  clubs: {
    club: string;
    shots: number;
    meanProximityFt: number | null;
    p90ProximityFt: number | null;
    greenInRegPct: number | null;
    benchmark: null;
  }[];
  coachingTips: [];
  preferredBaseline: "auto";
  primaryBaseline: "tour";
  baselineSource: "default";
  handicapIndex: null;
  handicapSource: null;
  handicapAsOf: null;
}

function installFetch(opts: { putting: PuttingResponse; proxByClub: ProxByClubResponse }) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/portal/putting-stats")) {
      return new Response(JSON.stringify(opts.putting), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/api/portal/player/proximity-by-club")) {
      return new Response(JSON.stringify(opts.proxByClub), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // Other panel queries — return empty so the panel renders without errors.
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ShotAnalyticsPanel />
    </QueryClientProvider>,
  );
}

function puttBand(band: string, attempts: number, makes: number): PuttingResponse["bands"][number] {
  const makePct = attempts > 0 ? (makes / attempts) * 100 : null;
  return { band, attempts, makes, makePct };
}

function proxClub(club: string, shots: number, meanFt: number): ProxByClubResponse["clubs"][number] {
  return {
    club,
    shots,
    meanProximityFt: meanFt,
    p90ProximityFt: meanFt * 1.5,
    greenInRegPct: 50,
    benchmark: null,
  };
}

const baseProxResponse: ProxByClubResponse = {
  clubs: [],
  coachingTips: [],
  preferredBaseline: "auto",
  primaryBaseline: "tour",
  baselineSource: "default",
  handicapIndex: null,
  handicapSource: null,
  handicapAsOf: null,
};

describe("ShotAnalyticsPanel putting + proximity-by-club low-sample captions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("captions putting bands with attempts below the trustworthy threshold", async () => {
    installFetch({
      putting: {
        bands: [
          puttBand("<3 ft", 30, 28),
          puttBand("3-6 ft", 12, 8),
          puttBand("6-10 ft", 5, 2),
          puttBand("10-15 ft", 2, 0),
          puttBand("15-25 ft", 1, 0),
          puttBand("25+ ft", 0, 0),
        ],
      },
      proxByClub: baseProxResponse,
    });
    renderPanel();
    vi.useRealTimers();

    await waitFor(() => {
      expect(screen.getByTestId("putting-limited-sample")).toBeTruthy();
    });

    const text = screen.getByTestId("putting-limited-sample").textContent ?? "";
    // Bands with 1-4 attempts are flagged as low-sample; the 5-attempt band is not.
    expect(text).toContain("10-15 ft (2 putts)");
    expect(text).toContain("15-25 ft (1 putt)");
    // Bands with >= 5 attempts must NOT appear in the caption.
    expect(text).not.toContain("3-6 ft");
    expect(text).not.toContain("6-10 ft");
    // Bands with zero attempts also stay out (those bars don't render either).
    expect(text).not.toContain("25+ ft");
  });

  it("omits the putting caption when every band has enough attempts", async () => {
    installFetch({
      putting: {
        bands: [
          puttBand("<3 ft", 30, 28),
          puttBand("3-6 ft", 12, 8),
          puttBand("6-10 ft", 8, 3),
          // 25+ ft has zero attempts — that should NOT trigger the caption.
          puttBand("25+ ft", 0, 0),
        ],
      },
      proxByClub: baseProxResponse,
    });
    renderPanel();
    vi.useRealTimers();

    // Wait for the panel to settle, then assert the putting caption is absent.
    await waitFor(() => {
      // The putts query has resolved when the chart's Bar geometry exists; we
      // approximate by waiting on a settled tick of the render loop.
      expect(screen.queryByText(/No putts tracked yet/)).toBeNull();
    });
    expect(screen.queryByTestId("putting-limited-sample")).toBeNull();
  });

  it("captions proximity-by-club rows with shots below the trustworthy threshold", async () => {
    installFetch({
      putting: { bands: [] },
      proxByClub: {
        ...baseProxResponse,
        clubs: [
          // Anything below 3 shots is hidden by the existing chart filter, so
          // these are the rows we expect to be visible-but-faded:
          proxClub("7-iron", 20, 22),
          proxClub("4-iron", 6, 38),
          proxClub("3-wood", 4, 55),
          proxClub("2-iron", 3, 60),
        ],
      },
    });
    renderPanel();
    vi.useRealTimers();

    await waitFor(() => {
      expect(screen.getByTestId("proximity-club-limited-sample")).toBeTruthy();
    });

    const text = screen.getByTestId("proximity-club-limited-sample").textContent ?? "";
    // Clubs with 3 or 4 shots are flagged (still visible thanks to the >=3 floor).
    expect(text).toContain("3-wood (4 shots)");
    expect(text).toContain("2-iron (3 shots)");
    // Clubs with >=5 shots must NOT appear in the caption.
    expect(text).not.toContain("7-iron");
    expect(text).not.toContain("4-iron");
  });

  it("omits the proximity caption when every visible club has enough shots", async () => {
    installFetch({
      putting: { bands: [] },
      proxByClub: {
        ...baseProxResponse,
        clubs: [
          proxClub("7-iron", 20, 22),
          proxClub("4-iron", 12, 38),
          proxClub("3-wood", 8, 55),
        ],
      },
    });
    renderPanel();
    vi.useRealTimers();

    await waitFor(() => {
      // The empty-state copy is present until the proximity-by-club query
      // settles; once at least one club row renders we know the chart is up.
      expect(screen.queryByText(/Track at least 3 approach shots/)).toBeNull();
    });
    expect(screen.queryByTestId("proximity-club-limited-sample")).toBeNull();
  });
});
