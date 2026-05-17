/**
 * Task #2235 — Persisted public-handle cache.
 *
 * The in-memory React Query cache from Task #1790 keeps repeat profile taps
 * cheap within a single app session, but is wiped on cold launch. These
 * tests pin the AsyncStorage-backed persistor that carries the cache across
 * launches:
 *
 *   1. A persisted entry hydrates the cache on next launch without
 *      re-hitting the API (the core acceptance criterion).
 *   2. Successful query resolutions are mirrored back to AsyncStorage so
 *      the next launch can repeat trick (1).
 *   3. Entries past the multi-day TTL are pruned during hydrate so a
 *      long-dormant cache never serves a years-old handle.
 *   4. Stale-but-fresh-enough entries are still hydrated; React Query's
 *      normal stale-while-revalidate flow then refetches them transparently.
 *   5. Malformed/corrupt persisted JSON degrades to an empty cache instead
 *      of crashing app startup.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

vi.mock("@/utils/api", () => ({ BASE_URL: "https://example.test" }));

const memoryStore = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (k: string) => Promise.resolve(memoryStore.get(k) ?? null),
    setItem: (k: string, v: string) => { memoryStore.set(k, v); return Promise.resolve(); },
    removeItem: (k: string) => { memoryStore.delete(k); return Promise.resolve(); },
    getAllKeys: () => Promise.resolve(Array.from(memoryStore.keys())),
  },
}));

import {
  publicProfileHandleQueryKey,
} from "@/hooks/usePublicProfileHandle";
import {
  PUBLIC_PROFILE_HANDLE_PERSIST_TTL_MS,
  PUBLIC_PROFILE_HANDLE_STORAGE_KEY,
  hydratePublicProfileHandleCache,
  subscribePublicProfileHandlePersistence,
} from "@/utils/publicProfileHandlePersistence";

beforeEach(() => {
  memoryStore.clear();
});

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 24 * 60 * 60 * 1000 } },
  });
}

async function flushDebounce(ms = 300) {
  await new Promise((r) => setTimeout(r, ms));
}

describe("hydratePublicProfileHandleCache", () => {
  it("seeds React Query with persisted entries so the next tap doesn't re-fetch", async () => {
    const now = Date.now();
    memoryStore.set(
      PUBLIC_PROFILE_HANDLE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        entries: {
          "42": { handle: "ghost-rider", updatedAt: now - 60_000 },
          "99": { handle: null, updatedAt: now - 60_000 },
        },
      }),
    );

    const queryClient = makeClient();
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ handle: "x" }) } as Response));
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetcher as unknown as typeof fetch;

    const hydrated = await hydratePublicProfileHandleCache(queryClient, now);
    expect(hydrated).toBe(2);

    // Cached values should be readable straight away — no fetch needed.
    expect(queryClient.getQueryData(publicProfileHandleQueryKey(42))).toBe("ghost-rider");
    expect(queryClient.getQueryData(publicProfileHandleQueryKey(99))).toBe(null);

    // The hook's staleTime is 24h and the persisted entry is only 60s old,
    // so React Query treats it as fresh — fetchQuery returns the cached
    // value without firing the network resolver.
    const result = await queryClient.fetchQuery({
      queryKey: publicProfileHandleQueryKey(42),
      queryFn: async () => {
        fetcher();
        return "from-network";
      },
      staleTime: 24 * 60 * 60 * 1000,
    });
    expect(result).toBe("ghost-rider");
    expect(fetcher).not.toHaveBeenCalled();

    globalThis.fetch = realFetch;
  });

  it("drops entries older than the persistence TTL and rewrites the storage", async () => {
    const now = Date.now();
    const tooOld = now - PUBLIC_PROFILE_HANDLE_PERSIST_TTL_MS - 1_000;
    memoryStore.set(
      PUBLIC_PROFILE_HANDLE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        entries: {
          "1": { handle: "fresh", updatedAt: now - 1_000 },
          "2": { handle: "ancient", updatedAt: tooOld },
        },
      }),
    );

    const queryClient = makeClient();
    const hydrated = await hydratePublicProfileHandleCache(queryClient, now);
    expect(hydrated).toBe(1);
    expect(queryClient.getQueryData(publicProfileHandleQueryKey(1))).toBe("fresh");
    expect(queryClient.getQueryData(publicProfileHandleQueryKey(2))).toBeUndefined();

    // The pruned entry should also be gone from disk so the next launch
    // doesn't keep re-evaluating it.
    const reread = JSON.parse(memoryStore.get(PUBLIC_PROFILE_HANDLE_STORAGE_KEY) ?? "{}");
    expect(Object.keys(reread.entries)).toEqual(["1"]);
  });

  it("hydrates stale-but-within-TTL entries so React Query can revalidate them in the background", async () => {
    const now = Date.now();
    // 2 days old: past the hook's 24h staleTime, but well within the
    // 7-day persistence TTL.
    const updatedAt = now - 2 * 24 * 60 * 60 * 1000;
    memoryStore.set(
      PUBLIC_PROFILE_HANDLE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        entries: { "7": { handle: "stale-but-shown", updatedAt } },
      }),
    );

    const queryClient = makeClient();
    await hydratePublicProfileHandleCache(queryClient, now);

    expect(queryClient.getQueryData(publicProfileHandleQueryKey(7))).toBe("stale-but-shown");

    // React Query reports the entry as stale (so a transparent background
    // refetch will fire the next time `useQuery` mounts), but the cached
    // data is still surfaced immediately — no spinner.
    const state = queryClient.getQueryState(publicProfileHandleQueryKey(7));
    expect(state?.dataUpdatedAt).toBe(updatedAt);
  });

  it("treats malformed persisted JSON as an empty cache instead of crashing", async () => {
    memoryStore.set(PUBLIC_PROFILE_HANDLE_STORAGE_KEY, "not-json");
    const queryClient = makeClient();
    await expect(hydratePublicProfileHandleCache(queryClient)).resolves.toBe(0);
    expect(queryClient.getQueryData(publicProfileHandleQueryKey(1))).toBeUndefined();
  });

  it("ignores entries that don't match the persisted shape", async () => {
    memoryStore.set(
      PUBLIC_PROFILE_HANDLE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        entries: {
          "11": { handle: 42, updatedAt: Date.now() }, // wrong handle type
          "12": { handle: "ok", updatedAt: "yesterday" }, // wrong ts type
          "13": { handle: "good", updatedAt: Date.now() },
        },
      }),
    );
    const queryClient = makeClient();
    const hydrated = await hydratePublicProfileHandleCache(queryClient);
    expect(hydrated).toBe(1);
    expect(queryClient.getQueryData(publicProfileHandleQueryKey(13))).toBe("good");
  });
});

describe("subscribePublicProfileHandlePersistence", () => {
  it("mirrors successful resolutions to AsyncStorage so the next launch can hydrate", async () => {
    const queryClient = makeClient();
    const unsubscribe = subscribePublicProfileHandlePersistence(queryClient);

    queryClient.setQueryData(publicProfileHandleQueryKey(42), "ghost-rider");
    queryClient.setQueryData(publicProfileHandleQueryKey(99), null);

    await flushDebounce();

    const stored = JSON.parse(memoryStore.get(PUBLIC_PROFILE_HANDLE_STORAGE_KEY) ?? "{}");
    expect(stored.entries["42"].handle).toBe("ghost-rider");
    expect(stored.entries["99"].handle).toBe(null);
    expect(typeof stored.entries["42"].updatedAt).toBe("number");

    unsubscribe();
  });

  it("does not persist updates after unsubscribe", async () => {
    const queryClient = makeClient();
    const unsubscribe = subscribePublicProfileHandlePersistence(queryClient);
    unsubscribe();

    queryClient.setQueryData(publicProfileHandleQueryKey(7), "after-unsub");
    await flushDebounce();

    expect(memoryStore.get(PUBLIC_PROFILE_HANDLE_STORAGE_KEY)).toBeUndefined();
  });

  it("ignores updates for unrelated query keys", async () => {
    const queryClient = makeClient();
    const unsubscribe = subscribePublicProfileHandlePersistence(queryClient);

    queryClient.setQueryData(["leaderboard", 1], { rows: [] });
    queryClient.setQueryData(["public-profile-handle"], "missing-userid"); // wrong shape
    await flushDebounce();

    expect(memoryStore.get(PUBLIC_PROFILE_HANDLE_STORAGE_KEY)).toBeUndefined();

    unsubscribe();
  });

  it("round-trips through hydrate so a saved handle survives a simulated cold launch", async () => {
    // Session 1: resolve a handle and let the persistor flush it to disk.
    const session1 = makeClient();
    const unsubscribe = subscribePublicProfileHandlePersistence(session1);
    session1.setQueryData(publicProfileHandleQueryKey(123), "the-shark");
    await flushDebounce();
    unsubscribe();

    // Session 2: brand new QueryClient — hydrate from disk and confirm the
    // entry is available without any network call.
    const session2 = makeClient();
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ handle: "x" }) } as Response));
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetcher as unknown as typeof fetch;

    await hydratePublicProfileHandleCache(session2);
    expect(session2.getQueryData(publicProfileHandleQueryKey(123))).toBe("the-shark");

    const result = await session2.fetchQuery({
      queryKey: publicProfileHandleQueryKey(123),
      queryFn: async () => {
        fetcher();
        return "from-network";
      },
      staleTime: 24 * 60 * 60 * 1000,
    });
    expect(result).toBe("the-shark");
    expect(fetcher).not.toHaveBeenCalled();

    globalThis.fetch = realFetch;
  });
});
