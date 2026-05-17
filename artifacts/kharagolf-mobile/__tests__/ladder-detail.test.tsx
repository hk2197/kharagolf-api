/**
 * UI tests: player-facing cross-club ladder detail / registration screen
 * (Task #602 — covers app/ladders/[slug].tsx).
 *
 * Verifies:
 *   1. The loading spinner renders while the public payload is in flight.
 *   2. A failed GET surfaces an error state (no register button).
 *   3. "Join this ladder" CTA shows for open and active ladders.
 *   4. "Registration is closed" copy renders for completed ladders.
 *   5. Tapping the CTA while signed-out triggers the "Sign in required" prompt
 *      and does NOT POST to /register.
 *   6. After a successful POST /api/cross-club-ladders/:id/register, the
 *      player's standings row is highlighted (testID="ladder-mine") and the
 *      CTA is replaced by the "You're registered" confirmation.
 */
import React, { type ReactNode } from "react";
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const { routerMock, slugRef } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), back: vi.fn(), replace: vi.fn() },
  slugRef: { current: "spring-2026" as string | undefined },
}));

vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ slug: slugRef.current }),
  router: routerMock,
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const { alertMock } = vi.hoisted(() => ({
  alertMock: vi.fn<(title: string, message?: string, buttons?: Array<{ text: string; onPress?: () => void; style?: string }>) => void>(),
}));
vi.mock("react-native", async () => {
  const RN = await vi.importActual<typeof import("react-native")>("react-native");
  return { ...RN, Alert: { alert: alertMock } };
});

type AuthValue = {
  token: string | null;
  user: { id: number; username: string; role: string; displayName?: string } | null;
  isAuthenticated: boolean;
  isLoading: boolean;
};

const { authRef } = vi.hoisted(() => ({
  authRef: {
    current: {
      token: "test-token",
      user: { id: 42, username: "alice", role: "player", displayName: "Alice Smith" },
      isAuthenticated: true,
      isLoading: false,
    } as AuthValue,
  },
}));
vi.mock("@/context/auth", () => ({
  useAuth: () => authRef.current,
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks)
// ---------------------------------------------------------------------------
import LadderDetailScreen from "../app/ladders/[slug]";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type LadderStatus = "draft" | "open" | "active" | "completed";

interface StandingRow {
  id: number;
  playerName: string;
  homeOrganizationId: number | null;
  division: number;
  totalPoints: number;
  roundsCounted: number;
  position: number | null;
  previousPosition: number | null;
  orgName: string | null;
  orgSlug: string | null;
}

interface LadderDetail {
  id: number;
  name: string;
  description: string | null;
  scope: "regional" | "national";
  format: string;
  status: LadderStatus;
  region: string | null;
  shareSlug: string;
  seasonStart: string;
  seasonEnd: string;
  minHandicap: string | null;
  maxHandicap: string | null;
  bestOfRounds: number | null;
  divisionCount: number;
  clubs: Array<{ organizationId: number; orgName: string | null; orgSlug: string | null }>;
  standings: StandingRow[];
}

function makeLadder(overrides: Partial<LadderDetail> = {}): LadderDetail {
  return {
    id: 7,
    name: "Spring 2026 Regional",
    description: "Regional ladder",
    scope: "regional",
    format: "stableford",
    status: "open",
    region: "South",
    shareSlug: "spring-2026",
    seasonStart: "2026-03-01",
    seasonEnd: "2026-06-30",
    minHandicap: null,
    maxHandicap: null,
    bestOfRounds: 5,
    divisionCount: 1,
    clubs: [
      { organizationId: 1, orgName: "Kharagpur GC", orgSlug: "kharagpur" },
      { organizationId: 2, orgName: "Howrah GC", orgSlug: "howrah" },
    ],
    standings: [
      {
        id: 100,
        playerName: "Bob Jones",
        homeOrganizationId: 1,
        division: 1,
        totalPoints: 32,
        roundsCounted: 4,
        position: 1,
        previousPosition: 1,
        orgName: "Kharagpur GC",
        orgSlug: "kharagpur",
      },
    ],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderScreen(): ReactNode {
  // Fresh QueryClient per test so the cache from one test doesn't leak.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LadderDetailScreen />
    </QueryClientProvider>,
  );
}

type FetchMock = Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;
let fetchMock: FetchMock;

beforeEach(() => {
  slugRef.current = "spring-2026";
  authRef.current = {
    token: "test-token",
    user: { id: 42, username: "alice", role: "player", displayName: "Alice Smith" },
    isAuthenticated: true,
    isLoading: false,
  };
  alertMock.mockReset();
  routerMock.push.mockReset();
  routerMock.back.mockReset();
  routerMock.replace.mockReset();
  fetchMock = vi.fn() as unknown as FetchMock;
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("<LadderDetailScreen /> — Task #602", () => {
  it("shows the loading spinner while the public payload is in flight", async () => {
    let resolveFetch: (r: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
    );

    renderScreen();

    expect(await screen.findByTestId("ladder-loading")).toBeInTheDocument();
    // Standings/CTA aren't on screen yet.
    expect(screen.queryByTestId("ladder-register-btn")).toBeNull();

    await act(async () => {
      resolveFetch(jsonResponse(makeLadder()));
    });
  });

  it("renders an error state when the GET fails (and no register CTA)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));

    renderScreen();

    expect(await screen.findByText(/Failed to load ladder \(500\)/i)).toBeInTheDocument();
    expect(screen.queryByTestId("ladder-register-btn")).toBeNull();
    expect(screen.queryByText(/Join this ladder/i)).toBeNull();
  });

  it("shows the 'Join this ladder' CTA for an OPEN ladder", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeLadder({ status: "open" })));

    renderScreen();

    expect(await screen.findByTestId("ladder-register-btn")).toBeInTheDocument();
    expect(screen.getByText(/Join this ladder/i)).toBeInTheDocument();
    expect(screen.queryByText(/Registration is closed/i)).toBeNull();
  });

  it("shows the 'Join this ladder' CTA for an ACTIVE ladder", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeLadder({ status: "active" })));

    renderScreen();

    expect(await screen.findByTestId("ladder-register-btn")).toBeInTheDocument();
    expect(screen.getByText(/Join this ladder/i)).toBeInTheDocument();
    expect(screen.queryByText(/Registration is closed/i)).toBeNull();
  });

  it("shows the 'Registration is closed' copy for a COMPLETED ladder", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeLadder({ status: "completed" })));

    renderScreen();

    expect(
      await screen.findByText(/Registration is closed for this ladder\./i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("ladder-register-btn")).toBeNull();
  });

  it("prompts the signed-out user to sign in and does NOT POST to /register", async () => {
    authRef.current = { token: null, user: null, isAuthenticated: false, isLoading: false };
    fetchMock.mockResolvedValueOnce(jsonResponse(makeLadder({ status: "open" })));

    renderScreen();

    const cta = await screen.findByTestId("ladder-register-btn");
    // The "You'll be asked to sign in." hint is shown above the CTA.
    expect(screen.getByText(/You'll be asked to sign in/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(cta);
    });

    // The Alert sign-in prompt fired.
    await waitFor(() => expect(alertMock).toHaveBeenCalledTimes(1));
    const [title, message, buttons] = alertMock.mock.calls[0];
    expect(title).toBe("Sign in required");
    expect(message).toMatch(/Please sign in to join this ladder/i);
    expect(Array.isArray(buttons)).toBe(true);
    const signInBtn = buttons!.find((b) => b.text === "Sign in");
    expect(signInBtn).toBeTruthy();

    // Tapping the "Sign in" alert button routes to login.
    signInBtn!.onPress?.();
    expect(routerMock.push).toHaveBeenCalledWith("/(auth)/login");

    // No POST happened.
    const postCalls = fetchMock.mock.calls.filter(
      (c) => (c[1]?.method ?? "GET").toUpperCase() === "POST",
    );
    expect(postCalls).toHaveLength(0);
  });

  it("highlights the player's row after a successful POST /register", async () => {
    const initialLadder = makeLadder({ status: "open" });
    // After registration, the standings include a row for the new entry whose
    // id matches what the POST returned. Fresh GETs (refetch + invalidate)
    // should return the updated payload.
    const newEntryId = 555;
    const refreshedLadder = makeLadder({
      status: "open",
      standings: [
        ...initialLadder.standings,
        {
          id: newEntryId,
          playerName: "Alice Smith",
          homeOrganizationId: 1,
          division: 1,
          totalPoints: 0,
          roundsCounted: 0,
          position: 2,
          previousPosition: null,
          orgName: "Kharagpur GC",
          orgSlug: "kharagpur",
        },
      ],
    });

    let getCount = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as URL | Request).toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("/api/public/cross-club-ladders/")) {
        getCount += 1;
        return jsonResponse(getCount === 1 ? initialLadder : refreshedLadder);
      }
      if (method === "POST" && url.includes(`/api/cross-club-ladders/${initialLadder.id}/register`)) {
        return jsonResponse({ id: newEntryId }, 200);
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    renderScreen();

    const cta = await screen.findByTestId("ladder-register-btn");

    // Initially the player's row is not present and not highlighted.
    expect(screen.queryByTestId("ladder-mine")).toBeNull();

    await act(async () => {
      fireEvent.click(cta);
    });

    // POST was issued with the bearer token and JSON body.
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) => (c[1]?.method ?? "GET").toUpperCase() === "POST",
      );
      expect(post).toBeTruthy();
    });
    const postCall = fetchMock.mock.calls.find(
      (c) => (c[1]?.method ?? "GET").toUpperCase() === "POST",
    )!;
    const postUrl = String(postCall[0]);
    expect(postUrl).toContain(`/api/cross-club-ladders/${initialLadder.id}/register`);
    const postInit = postCall[1] as RequestInit;
    const headers = (postInit.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["Content-Type"]).toBe("application/json");

    // The player's row is now highlighted via testID="ladder-mine".
    const mineRow = await screen.findByTestId("ladder-mine");
    expect(mineRow).toBeInTheDocument();
    expect(mineRow.textContent).toMatch(/Alice Smith/);
    expect(mineRow.textContent).toMatch(/\(you\)/);

    // The CTA is replaced by the "You're registered" confirmation.
    await waitFor(() => {
      expect(screen.queryByTestId("ladder-register-btn")).toBeNull();
    });
    expect(screen.getByText(/You're registered/i)).toBeInTheDocument();
  });
});
