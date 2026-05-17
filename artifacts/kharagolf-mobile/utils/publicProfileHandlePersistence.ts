import AsyncStorage from "@react-native-async-storage/async-storage";
import type { QueryClient, QueryCacheNotifyEvent } from "@tanstack/react-query";

import { publicProfileHandleQueryKey } from "@/hooks/usePublicProfileHandle";

/**
 * Task #2235 — Persist the userId → public-handle cache across cold launches.
 *
 * Task #1790 added an in-memory React Query cache for
 *   GET /api/public/users/:userId/handle
 * so a leaderboard row tap only paid the spinner cost the first time. That
 * cache lives only for the current app session, though — cold-launching the
 * app (or backgrounding it long enough for the JS context to be reclaimed)
 * drops every cached entry and the next tap on a familiar player pays the
 * round-trip again.
 *
 * Public handles change rarely (a player reserving or releasing one is a
 * once-in-a-blue-moon event), so persisting the entries to AsyncStorage with
 * a multi-day TTL is safe and keeps the leaderboard feeling instantaneous on
 * the very first tap of the day. We deliberately scope persistence to the
 * `["public-profile-handle", userId]` query key rather than wiring up the
 * full `@tanstack/react-query-persist-client` plumbing — most other queries
 * (notifications, leaderboards, badges, …) intentionally re-fetch on every
 * launch and would be wrong to persist.
 */

export const PUBLIC_PROFILE_HANDLE_STORAGE_KEY = "public_profile_handles_v1";

/**
 * Persistence TTL. Entries older than this are dropped on hydrate so a
 * long-dormant cache never serves a years-old handle that has since been
 * released. The hook's own `staleTime` (24h) sits well inside this window
 * and triggers a transparent background revalidation when an entry is
 * served stale.
 */
export const PUBLIC_PROFILE_HANDLE_PERSIST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Debounce window for AsyncStorage writes so a burst of leaderboard taps
 *  coalesces into a single round-trip to native storage. */
const WRITE_DEBOUNCE_MS = 250;

type PersistedEntry = {
  handle: string | null;
  updatedAt: number;
};

type PersistedPayload = {
  version: 1;
  entries: Record<string, PersistedEntry>;
};

function isPersistedEntry(value: unknown): value is PersistedEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as { handle?: unknown; updatedAt?: unknown };
  const handleOk = entry.handle === null || typeof entry.handle === "string";
  const tsOk = typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt);
  return handleOk && tsOk;
}

function parsePayload(raw: string | null): PersistedPayload {
  if (!raw) return { version: 1, entries: {} };
  try {
    const json = JSON.parse(raw) as unknown;
    if (!json || typeof json !== "object") return { version: 1, entries: {} };
    const entries = (json as { entries?: unknown }).entries;
    if (!entries || typeof entries !== "object") return { version: 1, entries: {} };
    const out: Record<string, PersistedEntry> = {};
    for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
      if (isPersistedEntry(value)) out[key] = value;
    }
    return { version: 1, entries: out };
  } catch {
    return { version: 1, entries: {} };
  }
}

function isPublicProfileHandleKey(key: readonly unknown[]): key is readonly [string, number] {
  return (
    Array.isArray(key) &&
    key.length === 2 &&
    key[0] === "public-profile-handle" &&
    typeof key[1] === "number" &&
    Number.isFinite(key[1]) &&
    key[1] > 0
  );
}

/**
 * Read the persisted cache from AsyncStorage and seed React Query with each
 * still-fresh entry. Should be awaited (or at least kicked off) on app
 * startup before the first profile tap so the cached handles are available
 * synchronously on initial render.
 *
 * Stale-by-TTL entries are dropped during hydrate; a follow-up write is
 * scheduled when at least one expired entry was pruned so the on-disk copy
 * shrinks too. Entries that are merely past the hook's `staleTime` are still
 * hydrated — React Query's normal stale-while-revalidate flow will refetch
 * them in the background on the next render.
 */
export async function hydratePublicProfileHandleCache(
  queryClient: QueryClient,
  now: number = Date.now(),
): Promise<number> {
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(PUBLIC_PROFILE_HANDLE_STORAGE_KEY);
  } catch {
    return 0;
  }
  const payload = parsePayload(raw);
  let hydrated = 0;
  let pruned = 0;
  const surviving: Record<string, PersistedEntry> = {};
  for (const [key, entry] of Object.entries(payload.entries)) {
    const userId = Number(key);
    if (!Number.isFinite(userId) || userId <= 0) {
      pruned += 1;
      continue;
    }
    if (now - entry.updatedAt > PUBLIC_PROFILE_HANDLE_PERSIST_TTL_MS) {
      pruned += 1;
      continue;
    }
    surviving[key] = entry;
    queryClient.setQueryData(
      publicProfileHandleQueryKey(userId),
      entry.handle,
      { updatedAt: entry.updatedAt },
    );
    hydrated += 1;
  }
  if (pruned > 0) {
    try {
      await AsyncStorage.setItem(
        PUBLIC_PROFILE_HANDLE_STORAGE_KEY,
        JSON.stringify({ version: 1, entries: surviving } satisfies PersistedPayload),
      );
    } catch {
      // best-effort prune; we'll try again on the next write
    }
  }
  return hydrated;
}

/**
 * Subscribe to the React Query cache and mirror every successful
 * `["public-profile-handle", userId]` resolution to AsyncStorage. Writes are
 * debounced so a burst of tap-resolutions across a single leaderboard render
 * coalesces into one storage round-trip.
 *
 * Returns an unsubscribe function suitable for a `useEffect` cleanup.
 */
export function subscribePublicProfileHandlePersistence(
  queryClient: QueryClient,
): () => void {
  const pending = new Map<number, PersistedEntry>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  const flush = async () => {
    timer = null;
    if (pending.size === 0) return;
    const updates = Array.from(pending.entries());
    pending.clear();
    let raw: string | null = null;
    try {
      raw = await AsyncStorage.getItem(PUBLIC_PROFILE_HANDLE_STORAGE_KEY);
    } catch {
      raw = null;
    }
    const payload = parsePayload(raw);
    for (const [userId, entry] of updates) {
      payload.entries[String(userId)] = entry;
    }
    if (cancelled) return;
    try {
      await AsyncStorage.setItem(
        PUBLIC_PROFILE_HANDLE_STORAGE_KEY,
        JSON.stringify(payload),
      );
    } catch {
      // best-effort; leaderboard taps will re-queue the same entries soon
    }
  };

  const schedule = () => {
    if (timer !== null) return;
    timer = setTimeout(() => { void flush(); }, WRITE_DEBOUNCE_MS);
  };

  const unsubscribe = queryClient.getQueryCache().subscribe((event: QueryCacheNotifyEvent) => {
    if (event.type !== "updated") return;
    const action = event.action;
    // Only persist successful resolutions (including null handles); skip
    // pending/error states so we don't overwrite a good entry with noise.
    if (action.type !== "success") return;
    const key = event.query.queryKey as readonly unknown[];
    if (!isPublicProfileHandleKey(key)) return;
    const userId = key[1];
    const data = event.query.state.data;
    if (data !== null && typeof data !== "string") return;
    pending.set(userId, {
      handle: data,
      updatedAt: event.query.state.dataUpdatedAt || Date.now(),
    });
    schedule();
  });

  return () => {
    cancelled = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    unsubscribe();
  };
}

/** Test helper: wipe the persisted cache. Not used in app code. */
export async function clearPublicProfileHandlePersistence(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PUBLIC_PROFILE_HANDLE_STORAGE_KEY);
  } catch {
    // ignore
  }
}
