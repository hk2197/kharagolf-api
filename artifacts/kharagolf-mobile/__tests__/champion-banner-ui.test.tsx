/**
 * UI tests: champion celebration banner on the mobile bracket viewer
 * (Task #1197 — covers the ChampionBanner component and its conditional
 * render inside app/(tabs)/match-play.tsx -> BracketView).
 *
 * Verifies:
 *   1. The banner (champion-banner, champion-name, runner-up-name testIDs)
 *      is rendered when a round-robin bracket is complete and a champion
 *      and runner-up are set on the bracket payload.
 *   2. The banner is hidden when either completedAt or championId is
 *      missing from the bracket payload.
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

// expo-router is mocked centrally in __tests__/setup.ts so any test that
// imports a route module (e.g. BracketView from app/(tabs)/match-play.tsx)
// can load without tripping on expo-router's untransformed JSX sources.

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    token: "test-token",
    user: { id: 1, organizationId: 9, role: "player" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

import { BracketView } from "../app/(tabs)/match-play";

const player = (id: number, last: string) => ({ id, firstName: "P", lastName: last });

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

const baseBracket = {
  id: 1,
  tournamentId: 11,
  totalRounds: 1,
  hasConsolation: false,
  drawGeneratedAt: "2026-04-01T00:00:00Z",
  tieBreakRule: "sudden_death" as const,
  format: "round_robin" as const,
};

const baseRound = {
  id: 100,
  name: "Round 1",
  bracketType: "main",
  roundNumber: 1,
};

// A completed round-robin: P1 (champion) beat P2, P1 beat P3, P3 beat P2.
// P1 is champion, P3 is runner-up.
const completedMatches = [
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
    holeResults: { "1": "player1", "2": "player1", "3": "player1" },
    player1: player(1, "Champ"),
    player2: player(2, "Bravo"),
  },
  {
    id: 1001,
    roundId: 100,
    matchNumber: 2,
    result: "player1_wins",
    bracketType: "main",
    player1Id: 1,
    player2Id: 3,
    player1IsBye: false,
    player2IsBye: false,
    winnerId: 1,
    holeResults: { "1": "player1", "2": "player1" },
    player1: player(1, "Champ"),
    player2: player(3, "Runnerup"),
  },
  {
    id: 1002,
    roundId: 100,
    matchNumber: 3,
    result: "player1_wins",
    bracketType: "main",
    player1Id: 3,
    player2Id: 2,
    player1IsBye: false,
    player2IsBye: false,
    winnerId: 3,
    holeResults: { "1": "player1", "2": "player1" },
    player1: player(3, "Runnerup"),
    player2: player(2, "Bravo"),
  },
];

describe("<BracketView /> champion banner — Task #1197", () => {
  let fetchMock: Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;

  beforeEach(() => {
    fetchMock = vi.fn() as unknown as typeof fetchMock;
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the champion banner with champion + runner-up when the round-robin is complete", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        bracket: {
          ...baseBracket,
          championId: 1,
          runnerUpId: 3,
          completedAt: "2026-04-15T12:00:00Z",
        },
        rounds: [baseRound],
        matches: completedMatches,
      }),
    );

    renderWithClient(<BracketView orgId={9} tournamentId={11} />);

    const banner = await screen.findByTestId("champion-banner");
    expect(banner).toBeInTheDocument();

    const championName = screen.getByTestId("champion-name");
    expect(championName).toBeInTheDocument();
    expect(championName.textContent).toContain("P Champ");

    const runnerUp = screen.getByTestId("runner-up-name");
    expect(runnerUp).toBeInTheDocument();
    expect(runnerUp.textContent).toContain("P Runnerup");
  });

  it("hides the champion banner when completedAt is missing", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        bracket: {
          ...baseBracket,
          championId: 1,
          runnerUpId: 3,
          completedAt: null,
        },
        rounds: [baseRound],
        matches: completedMatches,
      }),
    );

    renderWithClient(<BracketView orgId={9} tournamentId={11} />);

    // Wait for the bracket to finish loading (round renders only after data arrives).
    await waitFor(() => expect(screen.getByText("Round 1")).toBeInTheDocument());
    expect(screen.queryByTestId("champion-banner")).toBeNull();
    expect(screen.queryByTestId("champion-name")).toBeNull();
    expect(screen.queryByTestId("runner-up-name")).toBeNull();
  });

  it("hides the champion banner when championId is missing", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        bracket: {
          ...baseBracket,
          championId: null,
          runnerUpId: null,
          completedAt: "2026-04-15T12:00:00Z",
        },
        rounds: [baseRound],
        matches: completedMatches,
      }),
    );

    renderWithClient(<BracketView orgId={9} tournamentId={11} />);

    await waitFor(() => expect(screen.getByText("Round 1")).toBeInTheDocument());
    expect(screen.queryByTestId("champion-banner")).toBeNull();
    expect(screen.queryByTestId("champion-name")).toBeNull();
    expect(screen.queryByTestId("runner-up-name")).toBeNull();
  });
});
