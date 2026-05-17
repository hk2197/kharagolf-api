/**
 * Regression test for Task #1611 — survivor / missed-the-cut grouping
 * across the kiosk, display, spectator, and tournament-results pages.
 *
 * Each of the four pages renders a different layout for the same
 * leaderboard payload, and shares one contract: when the API returns
 * entries with `madeCut === false`, they must NOT appear inline with
 * the survivors in the main list, and they MUST surface in the
 * page-specific "Missed the Cut" block (always-on for the broadcast
 * surfaces, collapsible toggle for the interactive surfaces).
 *
 * The test mounts each page inside a wouter Router driven by
 * `memoryLocation`, stubs `fetch` + `EventSource`, and asserts:
 *
 *   - kiosk:    `kiosk-cut-section` renders with the cut count and the
 *               cut player's name appears only inside it.
 *   - display:  `display-cut-section` renders in the standings layout
 *               (always-on, no toggle).
 *   - display (cumulative): `display-cut-section-cumulative` renders
 *               under the round-by-round view.
 *   - spectator: `spectator-cut-toggle` shows the count, starts
 *               collapsed (cut player's row is not visible), and
 *               reveals the cut row after a click.
 *   - results:  `results-cut-toggle` mirrors the spectator behaviour
 *               for the published-results page.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Router, Route } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import LeaderboardKiosk from "@/pages/leaderboard-kiosk";
import LeaderboardDisplay from "@/pages/leaderboard-display";
import SpectatorPage from "@/pages/spectator";
import TournamentResultsPage from "@/pages/tournament-results";

// ── Shared fixtures ────────────────────────────────────────────────────
//
// Three survivors + two missed-cut players so we can confirm the
// "n PLAYERS" / "n player(s)" label pluralisation hooks fire on the
// secondary block as well as the survivor list capping at the cut.

const SURVIVOR_NAMES = ["Alice Survivor", "Bob Survivor", "Cara Survivor"];
const CUT_NAMES = ["Dan Cutter", "Eve Cutter"];

function makeEntry(opts: {
  id: number;
  name: string;
  pos: number;
  posDisplay: string;
  madeCut: boolean | null;
  toPar: number;
}) {
  return {
    playerId: opts.id,
    playerName: opts.name,
    position: opts.pos,
    positionDisplay: opts.posDisplay,
    profileImage: null,
    grossScore: 70 + opts.toPar,
    netScore: 70 + opts.toPar,
    scoreToPar: opts.toPar,
    netToPar: opts.toPar,
    stablefordPoints: 36,
    parBogeyScore: 0,
    thru: "F",
    currentRound: 1,
    currentHole: null,
    holesCompleted: 18,
    roundScores: [
      { round: 1, grossScore: 70 + opts.toPar, scoreToPar: opts.toPar, netScore: 70 + opts.toPar, stablefordPoints: 36, holesPlayed: 18, isComplete: true },
      { round: 2, grossScore: 72 + opts.toPar, scoreToPar: opts.toPar, netScore: 72 + opts.toPar, stablefordPoints: 36, holesPlayed: 18, isComplete: true },
    ],
    madeCut: opts.madeCut,
    flight: null,
    flights: [],
    handicapIndex: 12,
    playingHandicap: 12,
    holeScores: [],
    isVerified: false,
    dns: false,
    stats: { eagles: 0, birdies: 0, pars: 18, bogeys: 0, doublePlus: 0 },
  };
}

function makeEntries() {
  const survivors = SURVIVOR_NAMES.map((name, i) =>
    makeEntry({
      id: 100 + i,
      name,
      pos: i + 1,
      posDisplay: `${i + 1}`,
      madeCut: true,
      toPar: -2 + i,
    }),
  );
  const missed = CUT_NAMES.map((name, i) =>
    makeEntry({
      id: 200 + i,
      name,
      // Server still assigns a position for cut players; the UI
      // should override that with "MC" instead of rendering it.
      pos: 50 + i,
      posDisplay: `${50 + i}`,
      madeCut: false,
      toPar: 8 + i,
    }),
  );
  return [...survivors, ...missed];
}

function makeLeaderboardPayload() {
  const entries = makeEntries();
  return {
    tournamentId: 999,
    tournamentName: "Cut Regression Open",
    format: "stroke",
    coursePar: 72,
    rounds: 2,
    lastUpdated: "2026-04-29T12:00:00.000Z",
    entries,
    netEntries: entries,
    stablefordEntries: entries,
    byFlight: { Overall: entries },
    flights: [],
    organizationId: 1,
    organizationName: "KharaGolf",
    organizationLogoUrl: null,
    organizationPrimaryColor: "#22c55e",
    sponsors: [],
    leaderboardType: "gross",
    availableViews: ["gross"],
    cutLineIndex: 3,
    cutAfterRound: 2,
    isTeamFormat: false,
    teamEntries: [],
  };
}

function makeResultsPayload() {
  const entries = makeEntries();
  return {
    tournamentId: 999,
    tournamentName: "Cut Regression Open",
    format: "stroke",
    coursePar: 72,
    rounds: 2,
    entries,
    netEntries: entries,
    sideGamesConfig: null,
    sideGameWinners: [],
    skinsResults: [],
    organizationName: "KharaGolf",
    organizationLogoUrl: null,
    organizationPrimaryColor: "#22c55e",
    sponsors: [],
    leaderboardType: "gross",
  };
}

// ── Browser API stubs ─────────────────────────────────────────────────
//
// EventSource: the kiosk / display / spectator pages all open an SSE
// stream on mount. Replace it with a no-op so the tests don't wedge
// jsdom on a missing constructor.

class FakeEventSource {
  url: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(url: string) { this.url = url; }
  close() { /* noop */ }
  addEventListener() { /* noop */ }
  removeEventListener() { /* noop */ }
}

function stubFetch(handlers: Record<string, () => unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const stripped = url.split("?")[0];
      const matched = Object.keys(handlers).find(key => stripped.endsWith(key));
      // Unmatched endpoints (telemetry pings, the live-odds widget, the
      // event-documents loader, etc.) get a 404 so the consumers fall
      // back to their own empty / silent-render branches. Matched ones
      // resolve with the supplied JSON body.
      if (!matched) {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve("{}"),
        } as unknown as Response);
      }
      const body = handlers[matched]();
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body ?? {})),
      } as unknown as Response);
    }) as unknown as typeof fetch,
  );
}

function renderRoute(routePath: string, currentPath: string, element: React.ReactNode) {
  const { hook } = memoryLocation({ path: currentPath, static: true });
  // SpectatorPage now reads the portal-wide follow list via React Query
  // (Task #1730), so every page rendered through this helper needs a
  // QueryClientProvider in scope. The other pages don't issue queries here,
  // so the wrapper is a harmless no-op for them.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Router hook={hook}>
        <Route path={routePath}>{element}</Route>
      </Router>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  // jsdom doesn't implement requestFullscreen; the kiosk calls it
  // optionally on mount. Stub a no-op to avoid TS console noise.
  Object.defineProperty(document.documentElement, "requestFullscreen", {
    configurable: true,
    value: () => Promise.resolve(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("missed-cut grouping — kiosk leaderboard", () => {
  it("renders survivors inline and surfaces the cut block with the right count", async () => {
    stubFetch({
      "/api/public/tournaments/999/leaderboard": makeLeaderboardPayload,
    });

    renderRoute(
      "/leaderboard/:tournamentId/kiosk",
      "/leaderboard/999/kiosk",
      <LeaderboardKiosk />,
    );

    // Wait for the leaderboard fetch to resolve and survivors to render.
    for (const name of SURVIVOR_NAMES) {
      expect(await screen.findByText(name)).toBeInTheDocument();
    }

    const cutSection = await screen.findByTestId("kiosk-cut-section");
    expect(cutSection).toBeInTheDocument();

    // The cut block carries its own "n PLAYERS" count line.
    expect(within(cutSection).getByText(/2 PLAYERS/i)).toBeInTheDocument();

    // Each missed-cut player appears exactly once — inside the cut block.
    for (const name of CUT_NAMES) {
      expect(within(cutSection).getByText(name)).toBeInTheDocument();
      expect(screen.getAllByText(name)).toHaveLength(1);
    }
  });
});

describe("missed-cut grouping — display leaderboard", () => {
  it("renders the always-on cut block in the standings view", async () => {
    stubFetch({
      "/api/public/tournaments/999/leaderboard": makeLeaderboardPayload,
    });

    renderRoute(
      "/leaderboard/:tournamentId/display",
      "/leaderboard/999/display",
      <LeaderboardDisplay />,
    );

    for (const name of SURVIVOR_NAMES) {
      expect(await screen.findByText(name)).toBeInTheDocument();
    }

    const cutSection = await screen.findByTestId("display-cut-section");
    expect(within(cutSection).getByText(/2 PLAYERS/i)).toBeInTheDocument();

    // Each missed-cut player appears exactly once on the page — and that
    // single occurrence lives inside the always-on cut block, not the
    // main standings rows above it.
    for (const name of CUT_NAMES) {
      expect(within(cutSection).getByText(name)).toBeInTheDocument();
      expect(screen.getAllByText(name)).toHaveLength(1);
    }

    // Sanity: the cumulative-only block is not present until the user
    // toggles into the cumulative round-by-round view.
    expect(screen.queryByTestId("display-cut-section-cumulative")).toBeNull();
  });

  it("renders the cumulative cut block under the round-by-round view", async () => {
    stubFetch({
      "/api/public/tournaments/999/leaderboard": makeLeaderboardPayload,
    });

    renderRoute(
      "/leaderboard/:tournamentId/display",
      "/leaderboard/999/display?view=cumulative",
      <LeaderboardDisplay />,
    );

    for (const name of SURVIVOR_NAMES) {
      expect(await screen.findByText(name)).toBeInTheDocument();
    }

    const cutSection = await screen.findByTestId("display-cut-section-cumulative");
    expect(within(cutSection).getByText(/2 PLAYERS/i)).toBeInTheDocument();

    // Same exclusion contract as the standings view — cut players must
    // appear only inside the cumulative cut block, never inline with
    // the surviving round-by-round rows.
    for (const name of CUT_NAMES) {
      expect(within(cutSection).getByText(name)).toBeInTheDocument();
      expect(screen.getAllByText(name)).toHaveLength(1);
    }
  });
});

describe("missed-cut grouping — spectator page", () => {
  it("hides cut rows behind a collapsible toggle that opens on click", async () => {
    stubFetch({
      "/api/public/tournaments/999/leaderboard": makeLeaderboardPayload,
      "/api/public/tournaments/999/tee-sheet": () => [],
      "/api/public/tournaments/999/notable-events": () => ({ events: [] }),
      "/api/public/tournaments/999/pace-board": () => ({ groups: [] }),
    });

    renderRoute(
      "/spectator/:tournamentId",
      "/spectator/999",
      <SpectatorPage />,
    );

    // Wait for survivors to render in the main player list.
    for (const name of SURVIVOR_NAMES) {
      expect(await screen.findByText(name)).toBeInTheDocument();
    }

    const toggle = await screen.findByTestId("spectator-cut-toggle");
    // Count text comes via the "— N players" suffix span.
    expect(toggle.textContent ?? "").toMatch(/2 players/i);
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Cut player rows are NOT in the DOM before the toggle is opened.
    for (const name of CUT_NAMES) {
      expect(screen.queryByText(name)).toBeNull();
    }

    const user = userEvent.setup();
    await user.click(toggle);

    await waitFor(() => {
      expect(screen.getByTestId("spectator-cut-toggle")).toHaveAttribute("aria-expanded", "true");
    });

    // Cut rows are now rendered.
    for (const name of CUT_NAMES) {
      expect(await screen.findByText(name)).toBeInTheDocument();
    }
  });
});

describe("missed-cut grouping — tournament-results page", () => {
  it("hides cut rows behind a collapsible toggle that opens on click", async () => {
    stubFetch({
      "/api/public/tournaments/999/results": makeResultsPayload,
      // PublicEventDocuments expects an array body and matches the real
      // endpoint path so we don't mask regressions there.
      "/api/public/tournaments/999/documents": () => [],
    });

    renderRoute(
      "/tournaments/:tournamentId/results",
      "/tournaments/999/results",
      <TournamentResultsPage />,
    );

    // Wait for the results table to populate. Survivor names render in
    // the table rows; we use a `findAllByText` because the podium also
    // shows the leader.
    for (const name of SURVIVOR_NAMES) {
      expect((await screen.findAllByText(name)).length).toBeGreaterThan(0);
    }

    const toggle = await screen.findByTestId("results-cut-toggle");
    expect(toggle.textContent ?? "").toMatch(/2 players/i);
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    // Before clicking, cut player names should not be in the DOM.
    for (const name of CUT_NAMES) {
      expect(screen.queryByText(name)).toBeNull();
    }

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByTestId("results-cut-toggle")).toHaveAttribute("aria-expanded", "true");
    });

    for (const name of CUT_NAMES) {
      expect((await screen.findAllByText(name)).length).toBeGreaterThan(0);
    }
  });
});
