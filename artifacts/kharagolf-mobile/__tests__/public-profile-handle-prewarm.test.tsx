/**
 * Task #2234 — Pre-warming the userId → public-handle cache for the
 * visible rows on a fresh leaderboard / leagues members tab so the
 * *first* tap on each row opens the public profile (or private
 * fallback) without a centred spinner.
 *
 * The HTTP contract for the batch resolver this exercises
 *   POST /api/public/users/handles
 * is covered against the live PostgreSQL test DB by
 * artifacts/api-server/src/tests/public-profile-flows.test.ts.
 *
 * This test guards the mobile-side wiring so a future refactor cannot
 * silently regress two important properties:
 *
 *   1. After pre-warming, mounting /member/[userId] for any pre-warmed
 *      id must NOT trigger another fetch — the singular-resolver
 *      `usePublicProfileHandle` query reads the same cache entry the
 *      batch endpoint just seeded.
 *   2. Re-running the pre-warm with the same set of ids (e.g. a live
 *      leaderboard re-render) must NOT hit the batch endpoint again
 *      either — the cache check is what makes pre-warming cheap enough
 *      to run on every list mount.
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

vi.mock("@/hooks/useFollowCounts", () => ({
  useFollowCounts: () => ({ data: null }),
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

import {
  prewarmPublicProfileHandles,
  publicProfileHandleQueryKey,
} from "../hooks/usePublicProfileHandle";
import MemberProfileScreen from "../app/member/[userId]";

interface FetchState {
  batchCalls: number;
  singleCalls: number;
  batchPayloads: Array<{ userIds: number[] }>;
  // Map of userId → handle | null actually present in the server's
  // batch response payload. An id missing from this map is *omitted*
  // from the response (simulates a partial payload).
  batchHandles: Record<string, string | null>;
  // When set, the batch endpoint responds with this HTTP status and an
  // empty body. Used to exercise non-OK / failure branches that must
  // NOT poison the cache.
  batchStatusOverride: number | null;
  // When true, the batch endpoint rejects with a transport error.
  batchThrows: boolean;
}

let fetchState: FetchState;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/public/users/handles") && init?.method === "POST") {
      fetchState.batchCalls += 1;
      const body = JSON.parse(String(init.body)) as { userIds: number[] };
      fetchState.batchPayloads.push(body);
      if (fetchState.batchThrows) {
        throw new TypeError("Network request failed");
      }
      if (fetchState.batchStatusOverride !== null) {
        return new Response("", { status: fetchState.batchStatusOverride }) as unknown as Response;
      }
      // Only include ids that the test has explicitly registered in
      // `batchHandles` — every other requested id is *omitted* from
      // the response (the server treats it as unknown). The prewarm
      // path must leave such ids absent in the cache so the singular
      // resolver can recover them on tap.
      const handles: Record<string, string | null> = {};
      for (const id of body.userIds) {
        if (Object.prototype.hasOwnProperty.call(fetchState.batchHandles, String(id))) {
          handles[String(id)] = fetchState.batchHandles[String(id)];
        }
      }
      return new Response(JSON.stringify({ handles }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (/\/api\/public\/users\/\d+\/handle$/.test(url)) {
      fetchState.singleCalls += 1;
      const m = url.match(/\/users\/(\d+)\/handle$/);
      const id = m ? m[1] : "0";
      const handle =
        fetchState.batchHandles[id] !== undefined ? fetchState.batchHandles[id] : null;
      return new Response(JSON.stringify({ handle }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as unknown as typeof fetch;
}

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 24 * 60 * 60 * 1000, gcTime: 24 * 60 * 60 * 1000 },
    },
  });
}

function renderMember(client: QueryClient) {
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(MemberProfileScreen),
    ),
  );
}

beforeEach(() => {
  fetchState = {
    batchCalls: 0,
    singleCalls: 0,
    batchPayloads: [],
    batchHandles: {},
    batchStatusOverride: null,
    batchThrows: false,
  };
  routerMock.push.mockClear();
  routerMock.back.mockClear();
  routerMock.replace.mockClear();
  searchParams = {};
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("prewarmPublicProfileHandles — batch cache seeding (Task #2234)", () => {
  it("writes one cache entry per requested id (handle or null) under the singular query key", async () => {
    fetchState.batchHandles = { "501": "alpha-golfer", "502": null, "503": "charlie-chip" };

    const client = makeClient();
    await prewarmPublicProfileHandles(client, [501, 502, 503]);

    expect(fetchState.batchCalls).toBe(1);
    expect(fetchState.batchPayloads[0].userIds.sort()).toEqual([501, 502, 503]);
    // The cached value must live under the same key `usePublicProfileHandle`
    // reads from, otherwise the resolver screen will re-fetch.
    expect(client.getQueryData(publicProfileHandleQueryKey(501))).toBe("alpha-golfer");
    expect(client.getQueryData(publicProfileHandleQueryKey(502))).toBe(null);
    expect(client.getQueryData(publicProfileHandleQueryKey(503))).toBe("charlie-chip");

    client.clear();
  });

  it("dedupes ids and skips invalid ones before issuing the batch request", async () => {
    fetchState.batchHandles = { "501": "alpha-golfer" };

    const client = makeClient();
    await prewarmPublicProfileHandles(client, [501, 501, -1, 0, NaN as unknown as number, 501]);

    expect(fetchState.batchCalls).toBe(1);
    expect(fetchState.batchPayloads[0].userIds).toEqual([501]);

    client.clear();
  });

  it("does not hit the network at all when every id already has a fresh cache entry", async () => {
    // Simulate a viewer who already opened these profiles earlier in the
    // session — `usePublicProfileHandle` would have populated the cache
    // (see Task #1790). The next leaderboard mount must NOT re-fetch.
    const client = makeClient();
    client.setQueryData(publicProfileHandleQueryKey(501), "alpha-golfer");
    client.setQueryData(publicProfileHandleQueryKey(502), null);

    await prewarmPublicProfileHandles(client, [501, 502]);
    expect(fetchState.batchCalls).toBe(0);

    client.clear();
  });

  it("only fetches the missing ids when some are already cached", async () => {
    fetchState.batchHandles = { "502": null, "503": "charlie-chip" };

    const client = makeClient();
    client.setQueryData(publicProfileHandleQueryKey(501), "alpha-golfer");

    await prewarmPublicProfileHandles(client, [501, 502, 503]);
    expect(fetchState.batchCalls).toBe(1);
    expect(fetchState.batchPayloads[0].userIds.sort()).toEqual([502, 503]);
    expect(client.getQueryData(publicProfileHandleQueryKey(502))).toBe(null);
    expect(client.getQueryData(publicProfileHandleQueryKey(503))).toBe("charlie-chip");

    client.clear();
  });

  it("does NOT poison the cache for ids the server omits from the response", async () => {
    // The server may legitimately drop ids (validation, partial
    // payload, …). If we synthesised a `null` entry for those ids
    // they would be locked into the private fallback for 24h — even
    // for users who actually reserved a public handle. Instead the
    // prewarm path must leave the cache untouched so the singular
    // resolver fires (and recovers) on the next tap.
    fetchState.batchHandles = { "501": "alpha-golfer" };

    const client = makeClient();
    await prewarmPublicProfileHandles(client, [501, 502]);

    expect(fetchState.batchCalls).toBe(1);
    expect(client.getQueryData(publicProfileHandleQueryKey(501))).toBe("alpha-golfer");
    // 502 absent from response → must NOT have a cache entry.
    expect(client.getQueryState(publicProfileHandleQueryKey(502))).toBeUndefined();

    client.clear();
  });

  it("does NOT poison the cache when the batch endpoint returns a non-OK status", async () => {
    // 5xx / rate-limit / auth failure on the batch endpoint must not
    // get persisted as "no public handle" for every requested id.
    fetchState.batchStatusOverride = 503;

    const client = makeClient();
    await prewarmPublicProfileHandles(client, [501, 502, 503]);

    expect(fetchState.batchCalls).toBe(1);
    expect(client.getQueryState(publicProfileHandleQueryKey(501))).toBeUndefined();
    expect(client.getQueryState(publicProfileHandleQueryKey(502))).toBeUndefined();
    expect(client.getQueryState(publicProfileHandleQueryKey(503))).toBeUndefined();

    client.clear();
  });

  it("does NOT poison the cache when the batch request itself throws (offline)", async () => {
    fetchState.batchThrows = true;

    const client = makeClient();
    await prewarmPublicProfileHandles(client, [501, 502]);

    expect(fetchState.batchCalls).toBe(1);
    expect(client.getQueryState(publicProfileHandleQueryKey(501))).toBeUndefined();
    expect(client.getQueryState(publicProfileHandleQueryKey(502))).toBeUndefined();

    client.clear();
  });

  it("chunks >200 ids into multiple batches so a large leaderboard still pre-warms instantly", async () => {
    // The server caps each batch at 200. A 250-player leaderboard
    // would hit a 400 if we sent everything in one call, leaving the
    // entire prewarm with nothing — the first tap on every row would
    // spin. Instead we should split client-side and merge results.
    const TOTAL = 250;
    fetchState.batchHandles = {};
    for (let i = 1; i <= TOTAL; i++) {
      fetchState.batchHandles[String(i)] = i % 2 === 0 ? null : `player-${i}`;
    }

    const client = makeClient();
    const ids = Array.from({ length: TOTAL }, (_, i) => i + 1);
    await prewarmPublicProfileHandles(client, ids);

    // Two batch requests — 200 + 50 — and EVERY request stays within
    // the server cap.
    expect(fetchState.batchCalls).toBe(2);
    expect(fetchState.batchPayloads[0].userIds.length).toBe(200);
    expect(fetchState.batchPayloads[1].userIds.length).toBe(50);
    for (const payload of fetchState.batchPayloads) {
      expect(payload.userIds.length).toBeLessThanOrEqual(200);
    }
    // Random spot-checks across the chunk boundary prove every id
    // landed in the cache under the singular resolver's query key.
    expect(client.getQueryData(publicProfileHandleQueryKey(1))).toBe("player-1");
    expect(client.getQueryData(publicProfileHandleQueryKey(199))).toBe("player-199");
    expect(client.getQueryData(publicProfileHandleQueryKey(200))).toBe(null);
    expect(client.getQueryData(publicProfileHandleQueryKey(201))).toBe("player-201");
    expect(client.getQueryData(publicProfileHandleQueryKey(250))).toBe(null);

    // And first-tap cache reuse still holds: navigating to a player
    // in either chunk redirects without a singular fetch.
    searchParams = { userId: "201", displayName: "Player 201" };
    renderMember(client);
    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith({
        pathname: "/profile/[handle]",
        params: { handle: "player-201" },
      });
    });
    expect(fetchState.singleCalls).toBe(0);

    client.clear();
  });

  it("after a batch failure the singular resolver still fetches and resolves on tap", async () => {
    // Regression for the cache-poisoning bug: even if the prewarm
    // batch fails server-side, the *first* tap on /member/[userId]
    // must still hit the singular resolver and end up redirecting
    // when the player does have a public profile.
    fetchState.batchStatusOverride = 503;
    fetchState.batchHandles = { "501": "alpha-golfer" };

    const client = makeClient();
    await prewarmPublicProfileHandles(client, [501]);
    // Failure path — nothing in cache, no singular call yet.
    expect(client.getQueryState(publicProfileHandleQueryKey(501))).toBeUndefined();
    expect(fetchState.singleCalls).toBe(0);

    // Now the user taps. Restore the endpoint and mount the resolver.
    fetchState.batchStatusOverride = null;
    searchParams = { userId: "501", displayName: "Alpha Golfer" };
    renderMember(client);

    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith({
        pathname: "/profile/[handle]",
        params: { handle: "alpha-golfer" },
      });
    });
    // Singular resolver was the one that recovered the redirect —
    // exactly what would NOT happen if the failed batch had written
    // a synthetic `null` for id 501.
    expect(fetchState.singleCalls).toBe(1);

    client.clear();
  });
});

describe("Pre-warm + first /member tap does not double-fetch (Task #2234)", () => {
  it("opens the public profile on the FIRST tap with no spinner and no extra request", async () => {
    // Simulate the leaderboard pre-warming the cache for a row, then
    // the player immediately tapping that row. The /member resolver
    // screen must redirect without a second network round-trip.
    fetchState.batchHandles = { "501": "alpha-golfer" };

    const client = makeClient();
    await prewarmPublicProfileHandles(client, [501]);
    expect(fetchState.batchCalls).toBe(1);
    expect(fetchState.singleCalls).toBe(0);

    searchParams = { userId: "501", displayName: "Alpha Golfer" };
    renderMember(client);

    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith({
        pathname: "/profile/[handle]",
        params: { handle: "alpha-golfer" },
      });
    });
    // Crucially: no singular-resolver call was ever made. The cache
    // hydrated the redirect synchronously on first render.
    expect(fetchState.singleCalls).toBe(0);
    expect(fetchState.batchCalls).toBe(1);
    // And the private fallback never paints.
    expect(screen.queryByTestId("follow-501")).toBeNull();
    expect(screen.queryByText("Member profile")).toBeNull();

    client.clear();
  });

  it("falls back to the private view (still without a spinner / fetch) for pre-warmed null handles", async () => {
    // A row whose userId batch-resolved to null (no public handle) is
    // also a cache hit — the resolver screen must paint the private
    // fallback immediately instead of refetching.
    fetchState.batchHandles = { "777": null };

    const client = makeClient();
    await prewarmPublicProfileHandles(client, [777]);
    expect(fetchState.batchCalls).toBe(1);

    searchParams = { userId: "777", displayName: "Private Pat" };
    renderMember(client);

    await waitFor(() => {
      expect(screen.queryByText("Private Pat")).not.toBeNull();
    });
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(fetchState.singleCalls).toBe(0);

    client.clear();
  });

  it("re-running the pre-warm with the same ids does not double-fetch (live leaderboard re-render)", async () => {
    // A live leaderboard polls every 30s and re-renders on every tick.
    // The pre-warm hook must not refetch the same ids each tick.
    fetchState.batchHandles = { "501": "alpha-golfer", "502": null };

    const client = makeClient();
    await prewarmPublicProfileHandles(client, [501, 502]);
    expect(fetchState.batchCalls).toBe(1);

    await prewarmPublicProfileHandles(client, [501, 502]);
    await prewarmPublicProfileHandles(client, [502, 501]);
    expect(fetchState.batchCalls).toBe(1);

    client.clear();
  });
});
