/**
 * UI tests: round-robin standings table on the player mobile app
 * (Task #660 — covers components/RoundRobinStandings.tsx and the
 * conditional render inside app/(tabs)/match-play.tsx -> BracketView).
 *
 * Verifies:
 *   1. <RoundRobinStandings /> renders a row per player with the correct
 *      rank, played count, wins, losses, halved, holes won and points.
 *   2. The standings card is shown by <BracketView /> when the bracket
 *      format is "round_robin".
 *   3. The standings card is NOT rendered when the bracket format is
 *      anything else (e.g. "single_elim").
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (vars && "n" in vars) return `${key} ${vars.n}`;
      return key;
    },
    i18n: { language: "en", changeLanguage: async () => {} },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    token: "test-token",
    user: { id: 1, organizationId: 9, role: "player" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

import { RoundRobinStandings } from "../components/RoundRobinStandings";
import type { StandingsMatch } from "../utils/round-robin-standings";
import { BracketView } from "../app/(tabs)/match-play";

const player = (id: number, last: string) => ({ id, firstName: "P", lastName: last });

function match(
  id: number,
  p1: number,
  p2: number,
  result: string,
  winnerId: number | null,
  holes: Record<string, "player1" | "player2" | "halved"> = {},
): StandingsMatch {
  return {
    id,
    bracketType: "main",
    player1Id: p1,
    player2Id: p2,
    player1IsBye: false,
    player2IsBye: false,
    result,
    winnerId,
    holeResults: holes,
    player1: player(p1, `L${p1}`),
    player2: player(p2, `L${p2}`),
  };
}

function renderWithClient(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, refetchInterval: false } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("<RoundRobinStandings /> — Task #660", () => {
  it("renders a row per player with rank, P/W/L/H, holes won and points", () => {
    // Three-player round robin — every pairing played once.
    // P1 beats P2 (3 holes won), P3 beats P1 (4 holes won), P3 beats P2 (5 holes won).
    // Expected:
    //   P3: played 2, W 2, L 0, H 0, holesWon 9, points 2 (rank 1)
    //   P1: played 2, W 1, L 1, H 0, holesWon 3, points 1 (rank 2)
    //   P2: played 2, W 0, L 2, H 0, holesWon 0, points 0 (rank 3)
    const matches: StandingsMatch[] = [
      match(1, 1, 2, "player1_wins", 1, {
        1: "player1", 2: "player1", 3: "player1",
        4: "halved", 5: "halved",
      }),
      match(2, 1, 3, "player2_wins", 3, {
        1: "player2", 2: "player2", 3: "player2", 4: "player2",
      }),
      match(3, 2, 3, "player2_wins", 3, {
        1: "player2", 2: "player2", 3: "player2", 4: "player2", 5: "player2",
      }),
    ];

    renderWithClient(<RoundRobinStandings matches={matches} bracket={null} />);

    // Card is rendered.
    expect(screen.getByTestId("rr-standings")).toBeInTheDocument();
    // All three player names appear.
    expect(screen.getByText(/P L1/)).toBeInTheDocument();
    expect(screen.getByText(/P L2/)).toBeInTheDocument();
    expect(screen.getByText(/P L3/)).toBeInTheDocument();

    // Locate each player's row by walking up from the name <Text>.
    const rowFor = (last: string): HTMLElement => {
      const nameEl = screen.getByText(`P ${last}`);
      // Climb until we hit the row container (the parent of the rank cell).
      // Each row is a flex direction "row" View; here we just find the
      // ancestor whose textContent contains the rank+stats.
      let el: HTMLElement | null = nameEl;
      while (el && el.parentElement) {
        el = el.parentElement;
        // The full row contains the rank, name and a 'pts' header equivalent.
        // We detect it by checking it contains both the player name AND a
        // numeric (W) cell sibling.
        if (el.textContent && el.textContent.includes(`P ${last}`) && el.children.length >= 6) {
          return el;
        }
      }
      throw new Error(`Could not find row for P ${last}`);
    };

    const r1 = rowFor("L1");
    const r2 = rowFor("L2");
    const r3 = rowFor("L3");

    const cells = (row: HTMLElement) =>
      Array.from(row.children).map((c) => (c.textContent ?? "").trim());

    // Cells layout: [rank, name, P, W, L, H, holesWon, points]
    expect(cells(r3)).toEqual(["1", "P L3", "2", "2", "0", "0", "9", "2"]);
    expect(cells(r1)).toEqual(["2", "P L1", "2", "1", "1", "0", "3", "1"]);
    expect(cells(r2)).toEqual(["3", "P L2", "2", "0", "2", "0", "0", "0"]);
  });

  it("shows the empty-state copy when there are no completed matches", () => {
    renderWithClient(<RoundRobinStandings matches={[]} />);
    // Card still renders, but with the i18n empty key (mocked to echo).
    expect(screen.getByTestId("rr-standings")).toBeInTheDocument();
    expect(screen.getByText("standingsEmpty")).toBeInTheDocument();
  });
});

describe("<BracketView /> standings visibility — Task #660", () => {
  let fetchMock: Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;

  beforeEach(() => {
    fetchMock = vi.fn() as unknown as typeof fetchMock;
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const baseBracket = {
    id: 1,
    tournamentId: 11,
    totalRounds: 1,
    hasConsolation: false,
    drawGeneratedAt: "2026-04-01T00:00:00Z",
    tieBreakRule: "sudden_death" as const,
  };
  const baseRound = {
    id: 100,
    name: "Round 1",
    bracketType: "main",
    roundNumber: 1,
  };
  const baseMatches = [
    {
      id: 1000,
      roundId: 100,
      matchNumber: 1,
      result: "player1_wins",
      bracketType: "main",
      player1Id: 1,
      player2Id: 2,
      player1IsBye: false,
      player2IsBye: false,
      winnerId: 1,
      holeResults: { "1": "player1", "2": "player1" },
      player1: player(1, "L1"),
      player2: player(2, "L2"),
    },
  ];

  it("renders the standings card when format is round_robin", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        bracket: { ...baseBracket, format: "round_robin" },
        rounds: [baseRound],
        matches: baseMatches,
      }),
    );

    renderWithClient(<BracketView orgId={9} tournamentId={11} />);

    await waitFor(() => expect(screen.getByTestId("rr-standings")).toBeInTheDocument());
    // The round still renders below, so we know the page progressed past loading.
    expect(screen.getByText("Round 1")).toBeInTheDocument();
  });

  it("live-refreshes the standings when the bracket payload changes on refetch", async () => {
    const initialMatches = [
      {
        id: 1000,
        roundId: 100,
        matchNumber: 1,
        result: "player1_wins",
        bracketType: "main",
        player1Id: 1,
        player2Id: 2,
        player1IsBye: false,
        player2IsBye: false,
        winnerId: 1,
        holeResults: { "1": "player1" },
        player1: player(1, "Alpha"),
        player2: player(2, "Bravo"),
      },
    ];
    // After refetch a second match completes which adds a third player to the
    // standings table.
    const refreshedMatches = [
      ...initialMatches,
      {
        id: 1001,
        roundId: 100,
        matchNumber: 2,
        result: "player2_wins",
        bracketType: "main",
        player1Id: 1,
        player2Id: 3,
        player1IsBye: false,
        player2IsBye: false,
        winnerId: 3,
        holeResults: { "1": "player2", "2": "player2" },
        player1: player(1, "Alpha"),
        player2: player(3, "Charlie"),
      },
    ];

    let getCount = 0;
    fetchMock.mockImplementation(async () => {
      getCount += 1;
      return jsonResponse({
        bracket: { ...baseBracket, format: "round_robin" },
        rounds: [baseRound],
        matches: getCount === 1 ? initialMatches : refreshedMatches,
      });
    });

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const ui = render(
      <QueryClientProvider client={client}>
        <BracketView orgId={9} tournamentId={11} />
      </QueryClientProvider>,
    );

    // First payload: standings card lists Alpha and Bravo only.
    const standings = await screen.findByTestId("rr-standings");
    expect(within(standings).getByText("P Alpha")).toBeInTheDocument();
    expect(within(standings).getByText("P Bravo")).toBeInTheDocument();
    expect(within(standings).queryByText("P Charlie")).toBeNull();

    // Force a refetch (simulates the 30s refetchInterval firing) and verify
    // the new player appears in the standings table.
    await client.refetchQueries({ queryKey: ["bracket-mobile", 11, 9] });

    await waitFor(() => {
      const card = screen.getByTestId("rr-standings");
      expect(within(card).getByText("P Charlie")).toBeInTheDocument();
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    ui.unmount();
  });

  it("does NOT render the standings card when format is single_elim", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        bracket: { ...baseBracket, format: "single_elim" },
        rounds: [baseRound],
        matches: baseMatches,
      }),
    );

    renderWithClient(<BracketView orgId={9} tournamentId={11} />);

    // Wait for the round (which only renders after the bracket has loaded)
    // before asserting the standings card is absent.
    await waitFor(() => expect(screen.getByText("Round 1")).toBeInTheDocument());
    expect(screen.queryByTestId("rr-standings")).toBeNull();
  });
});
