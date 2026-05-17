/**
 * UI tests for the champion celebration banner on the public bracket page
 * (Task #891).
 *
 * Mounts <PublicBracketPage /> with stubbed fetch + EventSource and a real
 * React Query client. The banner is only supposed to render when the
 * round-robin bracket is complete (has a completedAt and a championId), and
 * must surface the champion name, runner-up name, and completion date.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("wouter", () => ({
  useParams: () => ({ shareToken: "test-token" }),
}));

import PublicBracketPage from "../public-bracket";

type Player = { id: number; firstName: string; lastName: string };
type Match = {
  id: number;
  roundId: number;
  matchNumber: number;
  bracketType: string;
  player1Id?: number | null;
  player2Id?: number | null;
  player1IsBye: boolean;
  player2IsBye: boolean;
  result: string;
  winnerId?: number | null;
  matchStatus?: string | null;
  holeResults?: Record<string, "player1" | "player2" | "halved"> | null;
  player1?: Player | null;
  player2?: Player | null;
  winner?: Player | null;
};

const ALICE: Player = { id: 1, firstName: "Alice", lastName: "Anderson" };
const BOB: Player = { id: 2, firstName: "Bob", lastName: "Brown" };
const CHARLIE: Player = { id: 3, firstName: "Charlie", lastName: "Clarke" };

function makeMatches(): Match[] {
  return [
    {
      id: 10, roundId: 100, matchNumber: 1, bracketType: "main",
      player1Id: ALICE.id, player2Id: BOB.id,
      player1IsBye: false, player2IsBye: false,
      result: "completed", winnerId: ALICE.id,
      player1: ALICE, player2: BOB, winner: ALICE,
    },
    {
      id: 11, roundId: 100, matchNumber: 2, bracketType: "main",
      player1Id: ALICE.id, player2Id: CHARLIE.id,
      player1IsBye: false, player2IsBye: false,
      result: "completed", winnerId: ALICE.id,
      player1: ALICE, player2: CHARLIE, winner: ALICE,
    },
    {
      id: 12, roundId: 100, matchNumber: 3, bracketType: "main",
      player1Id: BOB.id, player2Id: CHARLIE.id,
      player1IsBye: false, player2IsBye: false,
      result: "completed", winnerId: BOB.id,
      player1: BOB, player2: CHARLIE, winner: BOB,
    },
  ];
}

function bracketResponse(opts: {
  format?: string;
  championId?: number | null;
  runnerUpId?: number | null;
  completedAt?: string | null;
}) {
  return {
    tournament: { id: 1, name: "Spring Invitational", status: "active" },
    bracket: {
      id: 1,
      format: opts.format ?? "round_robin",
      tieBreakRule: "extra_holes_3",
      hasConsolation: false,
      totalRounds: 1,
      tournamentId: 7,
      championId: opts.championId ?? null,
      runnerUpId: opts.runnerUpId ?? null,
      completedAt: opts.completedAt ?? null,
    },
    rounds: [{ id: 100, roundNumber: 1, name: "Round Robin", bracketType: "main" }],
    matches: makeMatches(),
  };
}

let response: ReturnType<typeof bracketResponse>;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/public/brackets/test-token")) {
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

function installEventSource() {
  class FakeEventSource {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    close() {}
  }
  (globalThis as unknown as { EventSource: typeof EventSource }).EventSource =
    FakeEventSource as unknown as typeof EventSource;
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PublicBracketPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  installFetch();
  installEventSource();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<PublicBracketPage /> — champion celebration banner", () => {
  it("renders the banner with champion name, runner-up name, and completion date when the round-robin bracket is complete", async () => {
    response = bracketResponse({
      format: "round_robin",
      championId: ALICE.id,
      runnerUpId: BOB.id,
      completedAt: "2026-04-15T12:00:00.000Z",
    });

    renderPage();

    const banner = await screen.findByTestId("champion-banner");
    expect(banner).toBeInTheDocument();

    expect(screen.getByTestId("champion-name")).toHaveTextContent("Alice Anderson");
    expect(screen.getByTestId("runner-up-name")).toHaveTextContent("Bob Brown");
    expect(screen.getByTestId("champion-avatar")).toHaveTextContent("AA");

    const expected = new Date("2026-04-15T12:00:00.000Z").toLocaleDateString(
      undefined,
      { year: "numeric", month: "long", day: "numeric" },
    );
    expect(banner).toHaveTextContent(new RegExp(`Completed ${expected}`));
    expect(banner).toHaveTextContent(/wins Spring Invitational/i);
  });

  it("renders the banner without a runner-up chip when only the champion is set", async () => {
    response = bracketResponse({
      format: "round_robin",
      championId: ALICE.id,
      runnerUpId: null,
      completedAt: "2026-04-15T12:00:00.000Z",
    });

    renderPage();

    expect(await screen.findByTestId("champion-banner")).toBeInTheDocument();
    expect(screen.getByTestId("champion-name")).toHaveTextContent("Alice Anderson");
    expect(screen.queryByTestId("runner-up-name")).not.toBeInTheDocument();
  });

  it("hides the banner while the round-robin bracket is still in progress (no completedAt)", async () => {
    response = bracketResponse({
      format: "round_robin",
      championId: null,
      runnerUpId: null,
      completedAt: null,
    });

    renderPage();

    // Wait for the page to finish loading (header is visible once data arrives).
    await screen.findByText("Spring Invitational");
    expect(screen.queryByTestId("champion-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("champion-name")).not.toBeInTheDocument();
  });

  it("hides the banner when a champion is set but completedAt is still null (bracket not yet finalized)", async () => {
    response = bracketResponse({
      format: "round_robin",
      championId: ALICE.id,
      runnerUpId: BOB.id,
      completedAt: null,
    });

    renderPage();

    await screen.findByText("Spring Invitational");
    expect(screen.queryByTestId("champion-banner")).not.toBeInTheDocument();
  });

  it("hides the banner when completedAt is set but no champion has been recorded yet", async () => {
    response = bracketResponse({
      format: "round_robin",
      championId: null,
      runnerUpId: null,
      completedAt: "2026-04-15T12:00:00.000Z",
    });

    renderPage();

    await screen.findByText("Spring Invitational");
    expect(screen.queryByTestId("champion-banner")).not.toBeInTheDocument();
  });

  it("does not render the banner for non round-robin formats even when a champion is set", async () => {
    response = bracketResponse({
      format: "single_elim",
      championId: ALICE.id,
      runnerUpId: BOB.id,
      completedAt: "2026-04-15T12:00:00.000Z",
    });

    renderPage();

    await screen.findByText("Spring Invitational");
    await waitFor(() => {
      expect(screen.queryByTestId("champion-banner")).not.toBeInTheDocument();
    });
  });
});
