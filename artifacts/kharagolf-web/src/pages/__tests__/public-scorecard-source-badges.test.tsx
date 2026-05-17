/**
 * Task #1367 — UI test for the shared scorecard's per-round Watch / Phone /
 * Scorer / Manual badges (the optional UI assertion deferred from Task #1182).
 *
 * The API-side contract for
 *   GET /api/public/scorecard/:shareToken/source-breakdown/:round
 * (token resolution, round filtering, hidden-card 404, zero-shot rounds) is
 * covered against the live PostgreSQL test DB by
 * artifacts/api-server/src/tests/public-profile-flows.test.ts.
 *
 * This test exercises the *React rendering* on the public scorecard page that
 * the API tests can't see:
 *
 *   1. After loading a scorecard with multiple rounds, the page fires a
 *      per-round source-breakdown fetch and renders the resulting badges next
 *      to each round header with the correctly rounded percentage.
 *   2. A round whose breakdown comes back with `total: 0` renders no badges
 *      (the component's empty-state branch). A round whose source-breakdown
 *      fetch 404s also renders no badges. This guards against a refactor that
 *      drops the per-round fetch loop or mis-applies the percentage math in
 *      <ShotSourceBadges />.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";

vi.mock("wouter", () => ({
  useRoute: () => [true, { shareToken: "share-token-1367" }] as const,
}));

vi.mock("@/components/AdSlot", () => ({
  default: () => <div data-testid="adslot-stub" />,
}));

import PublicScorecardPage from "../public-scorecard";

type SourceCounts = { watch: number; phone: number; scorer: number; manual: number };

interface FetchState {
  scorecardCalls: number;
  breakdownCalls: number[];
  breakdownsByRound: Record<number, { status: number; counts?: SourceCounts; total?: number }>;
}

let state: FetchState;

const SHARE_TOKEN = "share-token-1367";

function makeRound(roundNumber: number) {
  return {
    round: roundNumber,
    gross: 72,
    net: null,
    toPar: 0,
    holes: [
      { holeNumber: 1, par: 4, strokes: 4, toPar: 0, putts: null, fairwayHit: null, girHit: null },
      { holeNumber: 2, par: 4, strokes: 4, toPar: 0, putts: null, fairwayHit: null, girHit: null },
    ],
    fairwayPct: null,
    girPct: null,
    totalPutts: null,
  };
}

const SCORECARD_DATA = {
  player: { id: 1, firstName: "Sample", lastName: "Player", handicapIndex: 12.3, teeBox: "White" },
  tournament: {
    id: 99,
    name: "Badge Test Open",
    format: "stroke",
    startDate: null,
    rounds: 3,
    organizationId: 7,
  },
  organization: { name: "Test Club", logoUrl: null, primaryColor: null },
  courseName: "Test Course",
  rounds: [makeRound(1), makeRound(2), makeRound(3)],
  prizeAwards: [],
};

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "GET" && url.endsWith(`/api/public/scorecard/${SHARE_TOKEN}`)) {
      state.scorecardCalls += 1;
      return new Response(JSON.stringify(SCORECARD_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    const breakdownPrefix = `/api/public/scorecard/${SHARE_TOKEN}/source-breakdown/`;
    if (method === "GET" && url.includes(breakdownPrefix)) {
      const round = Number(url.slice(url.indexOf(breakdownPrefix) + breakdownPrefix.length));
      state.breakdownCalls.push(round);
      const stub = state.breakdownsByRound[round];
      if (!stub) {
        return new Response("not found", { status: 404 }) as unknown as Response;
      }
      if (stub.status !== 200) {
        return new Response("err", { status: stub.status }) as unknown as Response;
      }
      return new Response(JSON.stringify({ counts: stub.counts, total: stub.total }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  state = { scorecardCalls: 0, breakdownCalls: [], breakdownsByRound: {} };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function roundCard(roundNumber: number): HTMLElement {
  const heading = screen.getByRole("heading", { name: `Round ${roundNumber}` });
  // Walk up to the round-header row that contains both the heading and the
  // <ShotSourceBadges /> output.
  const headerRow = heading.parentElement as HTMLElement | null;
  expect(headerRow).not.toBeNull();
  return headerRow!;
}

describe("Task #1367 — public scorecard shot-source badges (UI)", () => {
  it("renders Watch / Phone / Scorer / Manual badges with correctly rounded percentages for a round with mixed sources", async () => {
    // Round 1 — mixed sources, total = 10. Percentages should round to
    // Watch 30% / Phone 20% / Scorer 10% / Manual 40% (matches the API
    // contract test in public-profile-flows.test.ts).
    state.breakdownsByRound[1] = {
      status: 200,
      counts: { watch: 3, phone: 2, scorer: 1, manual: 4 },
      total: 10,
    };
    // Round 2 — empty round (the component must render no badges).
    state.breakdownsByRound[2] = {
      status: 200,
      counts: { watch: 0, phone: 0, scorer: 0, manual: 0 },
      total: 0,
    };
    // Round 3 — single source, exercises the "omit zero-count badges" path
    // and the rounding at 100%. Also uses an odd total to verify the
    // Math.round(n / total * 100) math: 1/3 ≈ 33% and 2/3 ≈ 67%.
    state.breakdownsByRound[3] = {
      status: 200,
      counts: { watch: 1, phone: 2, scorer: 0, manual: 0 },
      total: 3,
    };

    render(<PublicScorecardPage />);

    // Wait for the scorecard payload + per-round breakdowns to land.
    await screen.findByRole("heading", { name: "Badge Test Open" });
    await waitFor(() => expect(state.scorecardCalls).toBe(1));
    await waitFor(() => expect(state.breakdownCalls.sort()).toEqual([1, 2, 3]));

    // --- Round 1: full mixed breakdown ---
    const r1 = roundCard(1);
    await waitFor(() => {
      expect(within(r1).getByText(/Watch 30%/)).toBeInTheDocument();
    });
    expect(within(r1).getByText(/Phone 20%/)).toBeInTheDocument();
    expect(within(r1).getByText(/Scorer 10%/)).toBeInTheDocument();
    expect(within(r1).getByText(/Manual 40%/)).toBeInTheDocument();
    // Percentages must add to 100 in the rendered text (sanity: the math
    // wasn't applied to the wrong denominator).
    const r1Text = r1.textContent ?? "";
    const pcts = Array.from(r1Text.matchAll(/(\d+)%/g)).map(m => Number(m[1]));
    expect(pcts.reduce((a, b) => a + b, 0)).toBe(100);

    // --- Round 2: zero-shot round renders NO badges ---
    const r2 = roundCard(2);
    expect(within(r2).queryByText(/Watch \d+%/)).toBeNull();
    expect(within(r2).queryByText(/Phone \d+%/)).toBeNull();
    expect(within(r2).queryByText(/Scorer \d+%/)).toBeNull();
    expect(within(r2).queryByText(/Manual \d+%/)).toBeNull();

    // --- Round 3: only the non-zero sources are rendered, with the right %s ---
    const r3 = roundCard(3);
    await waitFor(() => {
      expect(within(r3).getByText(/Watch 33%/)).toBeInTheDocument();
    });
    expect(within(r3).getByText(/Phone 67%/)).toBeInTheDocument();
    // Sources with zero shots must be omitted (no "Scorer 0%"/"Manual 0%").
    expect(within(r3).queryByText(/Scorer/)).toBeNull();
    expect(within(r3).queryByText(/Manual/)).toBeNull();
  });

  it("renders no badges when the per-round source-breakdown fetch fails (e.g. 404)", async () => {
    // Round 1 succeeds, round 2 fails, round 3 returns total=0. All three
    // must result in 'no badges' for rounds 2 and 3 — proving the page
    // doesn't fall back to stale or fabricated percentages on error and
    // honours the empty-state branch in <ShotSourceBadges />.
    state.breakdownsByRound[1] = {
      status: 200,
      counts: { watch: 4, phone: 0, scorer: 0, manual: 0 },
      total: 4,
    };
    // Round 2 intentionally not stubbed → 404 from installFetch.
    state.breakdownsByRound[3] = {
      status: 200,
      counts: { watch: 0, phone: 0, scorer: 0, manual: 0 },
      total: 0,
    };

    render(<PublicScorecardPage />);

    await screen.findByRole("heading", { name: "Badge Test Open" });
    await waitFor(() => expect(state.breakdownCalls.sort()).toEqual([1, 2, 3]));

    const r1 = roundCard(1);
    await waitFor(() => {
      expect(within(r1).getByText(/Watch 100%/)).toBeInTheDocument();
    });

    const r2 = roundCard(2);
    expect(within(r2).queryByText(/Watch \d+%/)).toBeNull();
    expect(within(r2).queryByText(/Phone \d+%/)).toBeNull();
    expect(within(r2).queryByText(/Scorer \d+%/)).toBeNull();
    expect(within(r2).queryByText(/Manual \d+%/)).toBeNull();

    const r3 = roundCard(3);
    expect(within(r3).queryByText(/Watch \d+%/)).toBeNull();
    expect(within(r3).queryByText(/Phone \d+%/)).toBeNull();
    expect(within(r3).queryByText(/Scorer \d+%/)).toBeNull();
    expect(within(r3).queryByText(/Manual \d+%/)).toBeNull();
  });
});
