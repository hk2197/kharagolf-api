/**
 * Task #1457 — The /member/[userId] stub must funnel taps from
 * leaderboards, league member tabs, the social feed, my-follows, etc.
 * into the public profile viewer at /profile/[handle] when the player
 * has a reserved + opted-in public handle. Otherwise it must keep
 * showing the existing private member view (member name + Follow
 * button) so members without a public profile have a sensible
 * destination.
 *
 * The HTTP contract for the resolver this screen calls
 *   GET /api/public/users/:userId/handle
 * is covered against the live PostgreSQL test DB by
 * artifacts/api-server/src/tests/public-profile-flows.test.ts.
 *
 * This test guards the mobile-side wiring so a future refactor of the
 * stub cannot silently regress the redirect (which would leave the
 * leaderboard / leagues / feed taps stuck on the bare-bones private
 * card and starve the public profile of share traffic).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const routerMock = vi.hoisted(() => {
  process.env.EXPO_PUBLIC_DOMAIN = "test.example.com";
  return {
    push: vi.fn(),
    back: vi.fn(),
    replace: vi.fn(),
  };
});

let searchParams: { userId?: string; displayName?: string; avatar?: string } = {};

vi.mock("expo-router", () => ({
  router: routerMock,
  Stack: { Screen: () => null },
  useLocalSearchParams: () => searchParams,
}));

vi.mock("@/context/auth", () => ({
  useAuth: () => ({ token: "tok", user: { id: 99 } }),
}));

vi.mock("@/hooks/useFolloweeIds", () => ({
  useFolloweeIds: () => ({ followeeIds: [], loading: false }),
}));

vi.mock("@/components/FollowButton", () => {
  const ReactInner = require("react") as typeof React;
  return {
    FollowButton: ({ userId }: { userId: number }) =>
      ReactInner.createElement("div", { "data-testid": `follow-${userId}` }, "Follow"),
  };
});

vi.mock("@expo/vector-icons", () => {
  const Stub = (props: { name?: string }) =>
    React.createElement("span", { "data-icon": props?.name ?? "icon" });
  return { Feather: Stub };
});

import MemberProfileScreen from "../app/member/[userId]";

interface FetchState {
  handleCalls: number;
  // null → server says no public handle (caller falls back to private view)
  // string → server returns a reserved+enabled handle (caller must redirect)
  responseHandle: string | null;
}

let fetchState: FetchState;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (/\/api\/public\/users\/\d+\/handle$/.test(url)) {
      fetchState.handleCalls += 1;
      return new Response(JSON.stringify({ handle: fetchState.responseHandle }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as unknown as typeof fetch;
}

// A fresh client per test so cache-state from one test cannot leak into the
// next. The dedicated cache-hit test below builds its own shared client to
// exercise the across-mount caching behaviour explicitly.
let queryClient: QueryClient;

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 24 * 60 * 60 * 1000, gcTime: 24 * 60 * 60 * 1000 },
    },
  });
}

function renderScreen(client: QueryClient = queryClient) {
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(MemberProfileScreen),
    ),
  );
}

beforeEach(() => {
  fetchState = { handleCalls: 0, responseHandle: null };
  routerMock.push.mockClear();
  routerMock.back.mockClear();
  routerMock.replace.mockClear();
  searchParams = {};
  queryClient = makeClient();
  installFetch();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

describe("MemberProfileScreen — public profile redirect (Task #1457)", () => {
  it("redirects to /profile/[handle] when the resolver returns a handle", async () => {
    fetchState.responseHandle = "alpha-golfer";
    searchParams = { userId: "501", displayName: "Alpha Golfer" };

    renderScreen();

    await waitFor(() => {
      expect(fetchState.handleCalls).toBe(1);
      expect(routerMock.replace).toHaveBeenCalledWith({
        pathname: "/profile/[handle]",
        params: { handle: "alpha-golfer" },
      });
    });
    // The private fallback (FollowButton + "Member profile") must NOT
    // render — we keep the spinner up while replacing the route to
    // avoid a flash of the wrong screen.
    expect(screen.queryByTestId("follow-501")).toBeNull();
    expect(screen.queryByText("Member profile")).toBeNull();
  });

  it("falls back to the private member view when the resolver returns null", async () => {
    fetchState.responseHandle = null;
    searchParams = { userId: "777", displayName: "Private Pat" };

    renderScreen();

    await waitFor(() => {
      expect(fetchState.handleCalls).toBe(1);
      // Private card is shown
      expect(screen.queryByText("Private Pat")).not.toBeNull();
    });
    // No redirect when there's no public handle.
    expect(routerMock.replace).not.toHaveBeenCalled();
    // The Follow button (private-card affordance) is wired up for the
    // viewed user since they're not the current viewer (id 99).
    expect(screen.queryByTestId("follow-777")).not.toBeNull();
  });

  it("does not redirect or fetch when the userId param is missing/invalid", async () => {
    // Defensive: a bad route param should fall back to the private view
    // without hitting the resolver. Otherwise we'd fire a 400 against the
    // API for every malformed nav.
    searchParams = { userId: "not-a-number" };

    renderScreen();

    await waitFor(() => {
      // Renders the private fallback card with the "User #NaN" placeholder
      expect(screen.queryByText(/User #NaN/)).not.toBeNull();
    });
    expect(fetchState.handleCalls).toBe(0);
    expect(routerMock.replace).not.toHaveBeenCalled();
  });
});

describe("MemberProfileScreen — handle resolver caching (Task #1790)", () => {
  it("does not re-hit the API when the same userId is opened again (cache hit)", async () => {
    // Tap player 501 from the leaderboard the first time — this is the
    // network round-trip the player sees once, ever.
    fetchState.responseHandle = "alpha-golfer";
    searchParams = { userId: "501", displayName: "Alpha Golfer" };

    const sharedClient = makeClient();
    const first = renderScreen(sharedClient);

    await waitFor(() => {
      expect(fetchState.handleCalls).toBe(1);
      expect(routerMock.replace).toHaveBeenCalledWith({
        pathname: "/profile/[handle]",
        params: { handle: "alpha-golfer" },
      });
    });

    // Player taps "back" and lands on the same profile again from the
    // standings. Reset router spies so we can assert the second mount
    // also redirects, this time without any spinner / API traffic.
    first.unmount();
    routerMock.replace.mockClear();

    renderScreen(sharedClient);

    // The cached entry hydrates the second mount synchronously: the
    // redirect fires (proving the cache hit was observed) and the
    // private fallback never paints. Crucially, fetch was never called
    // a second time — that's the whole point of the cache.
    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith({
        pathname: "/profile/[handle]",
        params: { handle: "alpha-golfer" },
      });
    });
    expect(fetchState.handleCalls).toBe(1);
    expect(screen.queryByTestId("follow-501")).toBeNull();
    expect(screen.queryByText("Member profile")).toBeNull();

    sharedClient.clear();
  });

  it("scopes the cache by userId so a different player still triggers a lookup", async () => {
    // Guard against an off-by-one cache key (e.g. caching globally instead
    // of per-userId) which would silently break the redirect for every
    // member after the first one tapped on a leaderboard.
    fetchState.responseHandle = "alpha-golfer";
    searchParams = { userId: "501", displayName: "Alpha Golfer" };

    const sharedClient = makeClient();
    const first = renderScreen(sharedClient);
    await waitFor(() => expect(fetchState.handleCalls).toBe(1));
    first.unmount();

    // Now tap a different member — the cache must not answer for them.
    fetchState.responseHandle = "bravo-bird";
    searchParams = { userId: "502", displayName: "Bravo Bird" };
    routerMock.replace.mockClear();

    renderScreen(sharedClient);

    await waitFor(() => {
      expect(fetchState.handleCalls).toBe(2);
      expect(routerMock.replace).toHaveBeenCalledWith({
        pathname: "/profile/[handle]",
        params: { handle: "bravo-bird" },
      });
    });

    sharedClient.clear();
  });
});
