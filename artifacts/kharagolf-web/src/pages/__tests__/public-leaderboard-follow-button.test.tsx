/**
 * Task #1729 — permanent regression coverage for the Follow button on the
 * public tournament leaderboard (web). Pins the three contracts the task
 * brief calls out:
 *
 *   (a) The viewer's own row NEVER renders <FollowButton />. The self-row
 *       guard at PlayerRow lives at:
 *         src/pages/public-leaderboard.tsx (PlayerRow:174)
 *         `entry.userId != null && entry.userId !== currentUserId`
 *       and is the only thing standing between the viewer and a "Follow
 *       yourself" button.
 *
 *   (b) The leaderboard payload exposes `userId` per entry. We mock the
 *       payload here, but the matching server contract is locked in by
 *       artifacts/api-server/src/tests/leaderboard-follow-userid-hydration
 *       .test.ts. If the server stops emitting `userId`, this test will
 *       still pass against the mock — but the API integration test fails
 *       loudly so the regression is caught upstream.
 *
 *   (c) The pre-fetched followee list from /api/portal/follows hydrates
 *       <FollowButton initialFollowing={...}> as "Following" instead of
 *       flashing "Follow" → "Following" on reload. We assert the final
 *       rendered label after the page-level useFolloweeIds() query
 *       resolves: a regression where the page stops piping the hook into
 *       initialFollowing would render every row as "Follow" indefinitely.
 *
 * Mobile coverage for the same FollowButton lives at:
 *   artifacts/kharagolf-mobile/__tests__/feed-follow-button.test.tsx
 * The leaderboard tab on mobile reuses the same hook + button and is
 * indirectly protected by the (b) server contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Router, Route } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// jsdom polyfills for Radix primitives used inside the page (Tooltip,
// etc) — copied from bulk-clone-save-segment.test.tsx so the initial
// render doesn't blow up before the rows mount.
if (typeof Element !== "undefined") {
  if (!(Element.prototype as unknown as { hasPointerCapture?: unknown }).hasPointerCapture) {
    (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = () => false;
  }
  if (!(Element.prototype as unknown as { releasePointerCapture?: unknown }).releasePointerCapture) {
    (Element.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {};
  }
  if (!(Element.prototype as unknown as { setPointerCapture?: unknown }).setPointerCapture) {
    (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  }
  if (!(Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView) {
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  }
}

const VIEWER_USER_ID = 501;
const OTHER_USER_ID = 502;
const FOLLOWED_USER_ID = 503;

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: { id: VIEWER_USER_ID, organizationId: 7, role: "player" },
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// LiveOdds + Prediction widgets do their own fetches; in tests they would
// get our 404 fallback and render an empty body. Stub them to no-ops so
// jsdom does not have to chew through their internal Radix hover-cards
// before our PlayerRow assertions run.
vi.mock("@/components/LiveOddsWidget", () => ({
  default: () => null,
}));
vi.mock("@/components/PredictionGameWidget", () => ({
  default: () => null,
}));

// EventSource is opened on mount for the leaderboard SSE stream. jsdom
// does not implement it; replace with a no-op.
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

import PublicLeaderboard from "../public-leaderboard";

interface Entry {
  playerId: number;
  userId: number | null;
  playerName: string;
  position: number;
  positionDisplay: string;
  profileImage: string | null;
  grossScore: number;
  netScore: number;
  scoreToPar: number;
  netToPar: number;
  stablefordPoints: number;
  thru: string;
  currentRound: number;
  roundScores: Array<{ round: number; grossScore: number; scoreToPar: number; netScore: number; stablefordPoints: number; holesPlayed: number; isComplete: boolean }>;
  madeCut: boolean | null;
  flight: string | null;
  flights: string[];
  handicapIndex: number;
  playingHandicap: number;
  holeScores: unknown[];
  isVerified: boolean;
  dns: boolean;
  stats: { eagles: number; birdies: number; pars: number; bogeys: number; doublePlus: number };
}

function entry(opts: {
  id: number;
  userId: number | null;
  name: string;
  pos: number;
}): Entry {
  return {
    playerId: opts.id,
    userId: opts.userId,
    playerName: opts.name,
    position: opts.pos,
    positionDisplay: String(opts.pos),
    profileImage: null,
    grossScore: 70 + opts.pos,
    netScore: 70 + opts.pos,
    scoreToPar: opts.pos - 2,
    netToPar: opts.pos - 2,
    stablefordPoints: 36,
    thru: "F",
    currentRound: 1,
    roundScores: [
      { round: 1, grossScore: 70 + opts.pos, scoreToPar: opts.pos - 2, netScore: 70 + opts.pos, stablefordPoints: 36, holesPlayed: 18, isComplete: true },
    ],
    madeCut: true,
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

interface Handler {
  /** userIds returned by GET /api/portal/follows. */
  followeeIds: number[];
  followeesFetchCount: number;
  leaderboardEntries: Entry[];
}

let handler: Handler;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const stripped = url.split("?")[0];

    if (stripped.endsWith("/api/portal/follows")) {
      handler.followeesFetchCount += 1;
      return new Response(JSON.stringify({ followeeIds: handler.followeeIds }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    if (stripped.endsWith("/leaderboard")) {
      const entries = handler.leaderboardEntries;
      return new Response(JSON.stringify({
        tournamentId: 999,
        tournamentName: "Follow Button Open",
        format: "stroke",
        coursePar: 72,
        rounds: 1,
        lastUpdated: "2026-04-30T10:00:00.000Z",
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
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    if (stripped.endsWith("/side-games")) {
      return new Response(JSON.stringify({ config: null, manual: [], skins: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    if (stripped.endsWith("/gallery")) {
      return new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    if (stripped.endsWith("/bracket")) {
      return new Response(JSON.stringify({ format: "stroke", rounds: [], matches: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    // Anything else (telemetry pings, etc) → empty body.
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as unknown as Response;
  }) as typeof fetch;
}

function renderPage() {
  const { hook } = memoryLocation({ path: "/leaderboard/999", static: true });
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook}>
        <Route path="/leaderboard/:tournamentId">
          <PublicLeaderboard />
        </Route>
      </Router>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  handler = {
    followeeIds: [],
    followeesFetchCount: 0,
    leaderboardEntries: [
      // Position 1: a peer the viewer already follows (hydration target).
      entry({ id: 1, userId: FOLLOWED_USER_ID, name: "Followed Fiona", pos: 1 }),
      // Position 2: the viewer's own row — must NEVER show a Follow button.
      entry({ id: 2, userId: VIEWER_USER_ID, name: "Viewer Vee", pos: 2 }),
      // Position 3: another peer the viewer does not follow yet.
      entry({ id: 3, userId: OTHER_USER_ID, name: "Other Olive", pos: 3 }),
      // Position 4: an unlinked tournament-only player (userId: null).
      //             Must NEVER show a Follow button (no portal account).
      entry({ id: 4, userId: null, name: "Walk Onlee", pos: 4 }),
    ],
  };
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Task #1729 — Follow button on the public tournament leaderboard", () => {
  it("never renders the Follow button on the viewer's own row, on unlinked rows, or for spectators", async () => {
    handler.followeeIds = [];

    renderPage();

    // Wait for the leaderboard fetch to resolve and rows to render.
    expect(await screen.findByText("Followed Fiona")).toBeInTheDocument();
    expect(screen.getByText("Viewer Vee")).toBeInTheDocument();
    expect(screen.getByText("Other Olive")).toBeInTheDocument();
    expect(screen.getByText("Walk Onlee")).toBeInTheDocument();

    // (a) Self-row guard — the viewer must never get a Follow button on
    //     their own row.
    expect(
      screen.queryByTestId(`button-follow-${VIEWER_USER_ID}`),
    ).not.toBeInTheDocument();

    // Unlinked rows have no userId at all — by definition no
    // button-follow-* testid exists for them.

    // The two non-self linked peers must each render a Follow button.
    expect(
      await screen.findByTestId(`button-follow-${FOLLOWED_USER_ID}`),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`button-follow-${OTHER_USER_ID}`),
    ).toBeInTheDocument();

    // Locking down the exact set: exactly two follow buttons are rendered
    // for this fixture (positions 1 & 3). A regression that drops the
    // self-row guard would surface as 3 here.
    const allFollowButtons = screen.getAllByTestId(/^button-follow-\d+$/);
    expect(allFollowButtons.map(b => b.getAttribute("data-testid")).sort()).toEqual([
      `button-follow-${FOLLOWED_USER_ID}`,
      `button-follow-${OTHER_USER_ID}`,
    ].sort());
  });

  it("hydrates the row to 'Following' when GET /api/portal/follows includes that userId", async () => {
    handler.followeeIds = [FOLLOWED_USER_ID];

    renderPage();

    const followedBtn = await screen.findByTestId(`button-follow-${FOLLOWED_USER_ID}`);
    const otherBtn = await screen.findByTestId(`button-follow-${OTHER_USER_ID}`);

    // The page passes initialFollowing={followeeIdSet.has(entry.userId)}
    // into <FollowButton> — once the followee query resolves, the row
    // for FOLLOWED_USER_ID must read "Following" (not "Follow"). Without
    // the page-level useFolloweeIds wiring this row would stay on
    // "Follow" forever (no per-button GET).
    await waitFor(() => {
      expect(followedBtn).toHaveTextContent(/^Following$/);
    });
    // Sanity: the un-followed peer stays on "Follow".
    expect(otherBtn).toHaveTextContent(/^Follow$/);

    // The pre-fetch endpoint actually fired — locks in the wiring the
    // task brief specifically calls out (a regression where the page
    // stops calling useFolloweeIds would skip this fetch and every
    // button would flash "Follow" on reload).
    expect(handler.followeesFetchCount).toBeGreaterThanOrEqual(1);
  });

  it("hides every Follow button when the viewer is not signed in", async () => {
    // useGetMe is mocked at the module level to return a signed-in
    // viewer; for this case we need it to resolve to an unauthenticated
    // session. Re-mock just for this test.
    vi.doMock("@workspace/api-client-react", () => ({
      useGetMe: () => ({ data: undefined }),
    }));
    vi.resetModules();
    const { default: PublicLeaderboardSignedOut } = await import("../public-leaderboard");

    const { hook } = memoryLocation({ path: "/leaderboard/999", static: true });
    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={qc}>
        <Router hook={hook}>
          <Route path="/leaderboard/:tournamentId">
            <PublicLeaderboardSignedOut />
          </Route>
        </Router>
      </QueryClientProvider>,
    );

    // Wait for the leaderboard to render; spectators see the same rows.
    expect(await screen.findByText("Followed Fiona")).toBeInTheDocument();

    // No Follow buttons at all — the `showFollow = !!me?.id` gate keeps
    // the public leaderboard usable for signed-out spectators (Task #1420).
    expect(screen.queryByTestId(/^button-follow-\d+$/)).not.toBeInTheDocument();
  });
});

/**
 * Task #2147 — spam-click race coverage for the Follow button.
 *
 * Task #1729 (above) only asserts the *initial* render contracts. It
 * does not exercise what happens when a user taps the same Follow
 * button twice in quick succession on a slow network — the failure
 * mode the original "Follow → Following flash" bug came from.
 *
 * Today the in-flight guard lives at FollowButton.tsx:
 *   - `disabled={loading}` on the <Button>
 *   - `loading` flips true the moment `toggle()` runs and only flips
 *     back to false in the `finally` after the POST/DELETE settles.
 * Together those two lines mean a second click fired before the first
 * fetch resolves is dropped on the floor by React (synthetic onClick
 * is suppressed for disabled buttons), so the optimistic state flip
 * (`setFollowing(!following)`) only ever runs once per server round-
 * trip and the UI cannot drift away from the server.
 *
 * If a future refactor removes that guard — e.g. drops `disabled`,
 * pulls the optimistic flip out ahead of the await without re-reading
 * the latest `following` state, or fires the fetch from a non-React
 * handler that ignores `disabled` — the test below fails because:
 *   - the API gets called twice for one tap-tap, and/or
 *   - the final UI label disagrees with the final server-side state
 *     (POST then DELETE leaves the user not-followed but the label
 *     would read "Following").
 *
 * The mobile leaderboard reuses the same FollowButton (web) and a
 * separate RN button (mobile); a parallel mobile spam-click test is
 * tracked separately so this file stays focused on web behaviour.
 */
describe("Task #2147 — spam-clicking the Follow button does not desync UI from server", () => {
  /**
   * Build a fetch mock that:
   *   - Defers any POST/DELETE to /api/portal/follows/<targetUserId>
   *     by returning a Promise the test can resolve manually. This
   *     simulates a slow network where the user can keep tapping
   *     before the first request settles.
   *   - Records every (method, url) pair against the target so the
   *     test can assert the *order* of calls, not just the count
   *     (a regression that flips state optimistically and then
   *     fires both POST + DELETE would still come out to the right
   *     final state but would show up here as the wrong sequence).
   *   - Falls through to the same JSON fixtures as the Task #1729
   *     suite for everything else (leaderboard, followees, side-
   *     games, etc).
   */
  function installControllableFetch(targetUserId: number) {
    const calls: Array<{ method: string }> = [];
    const pending: Array<(res: Response) => void> = [];

    const targetPath = `/api/portal/follows/${targetUserId}`;

    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const stripped = url.split("?")[0];

      if (stripped.endsWith(targetPath)) {
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push({ method });
        return new Promise<Response>((resolve) => {
          pending.push(resolve);
        });
      }

      // Re-use the Task #1729 fixture handler for everything else so
      // the page mounts identically.
      if (stripped.endsWith("/api/portal/follows")) {
        handler.followeesFetchCount += 1;
        return new Response(JSON.stringify({ followeeIds: handler.followeeIds }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (stripped.endsWith("/leaderboard")) {
        const entries = handler.leaderboardEntries;
        return new Response(JSON.stringify({
          tournamentId: 999,
          tournamentName: "Follow Button Open",
          format: "stroke",
          coursePar: 72,
          rounds: 1,
          lastUpdated: "2026-04-30T10:00:00.000Z",
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
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (stripped.endsWith("/side-games")) {
        return new Response(JSON.stringify({ config: null, manual: [], skins: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (stripped.endsWith("/bracket")) {
        return new Response(JSON.stringify({ format: "stroke", rounds: [], matches: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    return {
      calls,
      /** Resolve the next pending POST/DELETE with `{ ok: true }`. */
      async resolveNext() {
        const next = pending.shift();
        if (!next) throw new Error("resolveNext called with no in-flight follow request");
        await act(async () => {
          next(new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }));
        });
      },
      pendingCount: () => pending.length,
    };
  }

  it("ignores rapid double-clicks: only one POST is sent and the final UI matches the server", async () => {
    handler.followeeIds = [];
    const { calls, resolveNext, pendingCount } = installControllableFetch(OTHER_USER_ID);

    renderPage();

    const btn = await screen.findByTestId(`button-follow-${OTHER_USER_ID}`);
    expect(btn).toHaveTextContent(/^Follow$/);
    expect(btn).not.toBeDisabled();

    // Tap-tap-tap — three clicks in the same tick. With the in-flight
    // guard intact, only the first one runs `toggle()`; clicks 2 & 3
    // hit a disabled button and are dropped by React.
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);

    // The button must immediately enter the loading state. If a
    // future refactor drops `disabled={loading}`, three POSTs would
    // be queued before this assertion and `pendingCount()` below
    // would be 3.
    await waitFor(() => {
      expect(btn).toBeDisabled();
    });

    expect(calls.map(c => c.method)).toEqual(["POST"]);
    expect(pendingCount()).toBe(1);

    // Resolve the single POST → the optimistic flip lands.
    await resolveNext();

    await waitFor(() => {
      expect(btn).not.toBeDisabled();
    });
    expect(btn).toHaveTextContent(/^Following$/);

    // Server saw exactly one POST and zero DELETEs. UI ("Following")
    // and server state (one follow row) agree.
    expect(calls.map(c => c.method)).toEqual(["POST"]);
    expect(pendingCount()).toBe(0);
  });

  it("ignores rapid double-clicks when un-following: only one DELETE is sent and the final UI matches the server", async () => {
    // Pre-hydrate the row as already followed so the next tap is an
    // unfollow (DELETE).
    handler.followeeIds = [OTHER_USER_ID];
    const { calls, resolveNext, pendingCount } = installControllableFetch(OTHER_USER_ID);

    renderPage();

    const btn = await screen.findByTestId(`button-follow-${OTHER_USER_ID}`);
    await waitFor(() => {
      expect(btn).toHaveTextContent(/^Following$/);
    });
    expect(btn).not.toBeDisabled();

    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);

    await waitFor(() => {
      expect(btn).toBeDisabled();
    });

    // Critical: exactly one DELETE, no POST. A regression that flips
    // `following` optimistically *before* the disabled guard latches
    // could fire DELETE then POST and leave the user followed even
    // though the UI reads "Follow" — the method-order assertion is
    // what catches that.
    expect(calls.map(c => c.method)).toEqual(["DELETE"]);
    expect(pendingCount()).toBe(1);

    await resolveNext();

    await waitFor(() => {
      expect(btn).not.toBeDisabled();
    });
    expect(btn).toHaveTextContent(/^Follow$/);

    expect(calls.map(c => c.method)).toEqual(["DELETE"]);
    expect(pendingCount()).toBe(0);
  });

  it("queues the second tap until the first round-trip settles, then sends it as the opposite verb", async () => {
    // This locks in the *correct* behaviour for the slow-network
    // tap-then-tap-again-after-a-pause case: tap 1 → POST, wait for
    // it to land, tap 2 → DELETE. The two requests must arrive in
    // POST-then-DELETE order (not interleaved, not collapsed) so the
    // server-side follow row ends up gone, matching the final UI.
    handler.followeeIds = [];
    const { calls, resolveNext } = installControllableFetch(OTHER_USER_ID);

    renderPage();

    const btn = await screen.findByTestId(`button-follow-${OTHER_USER_ID}`);
    expect(btn).toHaveTextContent(/^Follow$/);

    fireEvent.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
    await resolveNext();
    await waitFor(() => {
      expect(btn).not.toBeDisabled();
      expect(btn).toHaveTextContent(/^Following$/);
    });

    // Now the user changes their mind and taps again. Because the
    // first round-trip has fully settled the button is enabled, so
    // this click is *intended* and must hit the wire as a DELETE.
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
    await resolveNext();
    await waitFor(() => {
      expect(btn).not.toBeDisabled();
      expect(btn).toHaveTextContent(/^Follow$/);
    });

    // Order matters: POST first (follow), DELETE second (unfollow).
    // A regression that swallows the second tap (e.g. a stale
    // `following` closure inside `toggle`) would show up here as
    // ["POST", "POST"] or just ["POST"].
    expect(calls.map(c => c.method)).toEqual(["POST", "DELETE"]);
  });
});
