import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { BASE_URL } from "@/utils/api";

/**
 * Task #1790 — Cache the userId → public-handle lookup.
 *
 * The `/member/[userId]` redirect screen used to fire
 *   GET /api/public/users/:userId/handle
 * on every mount. On a busy leaderboard or the leagues members tab (50+
 * rows) tapping each player triggered a fresh round-trip and a centred
 * spinner before the public profile shell could load. The same userId
 * is also looked up repeatedly across screens (feed, follows, …).
 *
 * Wrapping the resolver in React Query with a long staleTime makes the
 * second (and subsequent) tap on a known userId resolve from cache
 * synchronously — no spinner, no network call. Handles change rarely
 * (a player reserving or releasing one is a once-in-a-blue-moon event)
 * so a 24h staleTime is more than safe for the lifetime of an app
 * session and keeps the leaderboard feeling instantaneous.
 */
const STALE_TIME_MS = 24 * 60 * 60 * 1000; // 24 hours

// Must stay <= the cap enforced by `POST /api/public/users/handles`
// (currently 200). Any larger and the server returns 400 and the
// batch contributes nothing, defeating the prewarm — so we chunk
// client-side rather than rely on every caller passing a small set.
const PREWARM_BATCH_SIZE = 200;

export function publicProfileHandleQueryKey(userId: number) {
  return ["public-profile-handle", userId] as const;
}

async function fetchPublicProfileHandle(userId: number): Promise<string | null> {
  const res = await fetch(`${BASE_URL}/api/public/users/${userId}/handle`);
  if (!res.ok) return null;
  const json = (await res.json()) as { handle?: string | null };
  return typeof json.handle === "string" && json.handle.length > 0 ? json.handle : null;
}

/**
 * Resolve the public handle (if any) for the given member userId, with the
 * result cached in React Query so repeat navigations do not re-hit the API.
 *
 * - Returns `data === undefined` while the very first lookup is in flight.
 * - Returns `data === null` when the member has no reserved/opted-in handle.
 * - Returns `data === "<handle>"` when the member has a public profile.
 *
 * The query is disabled (and therefore never fires) when `userId` is not a
 * positive finite number, matching the defensive behaviour the original
 * inline `useEffect` had for malformed route params.
 */
export function usePublicProfileHandle(userId: number) {
  const enabled = Number.isFinite(userId) && userId > 0;
  return useQuery({
    queryKey: publicProfileHandleQueryKey(userId),
    queryFn: () => fetchPublicProfileHandle(userId),
    enabled,
    staleTime: STALE_TIME_MS,
    gcTime: STALE_TIME_MS,
    retry: false,
  });
}

/**
 * Task #2234 — Pre-warm the userId → public-handle cache for a batch of
 * visible rows so the *first* tap on each row opens the public profile
 * (or the private fallback) without any spinner or network round-trip.
 *
 * The single-row cache from Task #1790 makes repeat taps instant, but a
 * fresh leaderboard / leagues members tab paints with an empty cache, so
 * every visible row is a "first tap" target. Hitting the singular
 * resolver row-by-row from a useEffect would mean dozens of parallel
 * requests; instead we ask the small batch resolver
 *   POST /api/public/users/handles
 * (added in the same task) for everyone in one shot and seed the same
 * `publicProfileHandleQueryKey(userId)` entries that `usePublicProfileHandle`
 * reads. That way the cache lookup is a synchronous hit on first render
 * of /member/[userId].
 */
/**
 * Returns the parsed `handles` map on a successful 2xx response, or
 * `null` to signal "do not poison the cache" — covering both transport
 * failures (no `res`) and non-OK responses. The distinction matters:
 * if the batch endpoint is down or rate-limited, writing synthetic
 * `null`s into the cache would mark every visible row as "no public
 * profile" for the next 24h, hiding real public profiles from the
 * viewer. Returning `null` here lets the caller skip the write so the
 * singular resolver can still recover on the actual tap.
 */
async function fetchPublicProfileHandlesBatch(
  userIds: number[],
): Promise<Record<string, string | null> | null> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/public/users/handles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userIds }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let json: { handles?: Record<string, string | null> };
  try {
    json = (await res.json()) as { handles?: Record<string, string | null> };
  } catch {
    return null;
  }
  if (!json || typeof json.handles !== "object" || json.handles === null) return null;
  return json.handles;
}

/**
 * Seed the React Query cache with `userId → handle | null` entries for
 * every id in `userIds` that does not already have a fresh entry. Entries
 * are written under the same query key as `usePublicProfileHandle` so the
 * `/member/[userId]` resolver screen reads them on its very first render.
 *
 * Skipping ids that are already cached (and not stale) avoids the
 * "double-fetch" the task explicitly calls out — once a viewer has tapped
 * a player and the singular resolver cached their handle, the next mount
 * of the leaderboard must not refetch them via the batch endpoint either.
 *
 * Cache hygiene: we only write a value for an id that the server
 * **explicitly** returned in the `handles` payload (the value may be
 * `string` or `null` — `null` means "no public profile", which is a
 * legitimate cache hit). On batch failure (network error / non-OK /
 * malformed body) or for ids the server omitted, we leave the cache
 * untouched so the singular resolver fired by `/member/[userId]` on
 * tap can still fetch and recover. This avoids a poisoning bug where
 * a transient transport failure would silently downgrade real public
 * profiles to the private fallback for 24h.
 */
export async function prewarmPublicProfileHandles(
  queryClient: QueryClient,
  userIds: Iterable<number>,
): Promise<void> {
  const idsToFetch: number[] = [];
  const seen = new Set<number>();
  for (const raw of userIds) {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) continue;
    const id = Math.trunc(raw);
    if (seen.has(id)) continue;
    seen.add(id);
    const key = publicProfileHandleQueryKey(id);
    // Skip when an entry exists AND is still fresh — this is what
    // prevents the prewarm path from racing against (or duplicating)
    // the per-row useQuery from `usePublicProfileHandle`. We use the
    // query state's dataUpdatedAt rather than getQueryData so a cached
    // `null` (which is a valid resolved value here) still counts as a hit.
    const state = queryClient.getQueryState<string | null>(key);
    if (state && state.dataUpdatedAt > 0 && Date.now() - state.dataUpdatedAt < STALE_TIME_MS) {
      continue;
    }
    idsToFetch.push(id);
  }
  if (idsToFetch.length === 0) return;
  // Chunk into <=PREWARM_BATCH_SIZE requests so a large leaderboard
  // (e.g. 250+ players) doesn't trip the server's 200-id cap and
  // produce a 400 that contributes nothing. Each chunk is independent
  // so a single failed batch only loses prewarming for that slice;
  // those ids fall through to the singular resolver on tap.
  for (let i = 0; i < idsToFetch.length; i += PREWARM_BATCH_SIZE) {
    const slice = idsToFetch.slice(i, i + PREWARM_BATCH_SIZE);
    const handles = await fetchPublicProfileHandlesBatch(slice);
    // On transport / non-OK failure, leave the cache untouched so the
    // singular resolver can still try on tap rather than locking in a
    // synthetic null for 24h.
    if (handles === null) continue;
    for (const id of slice) {
      const key = String(id);
      if (!Object.prototype.hasOwnProperty.call(handles, key)) {
        // Id was dropped by the server (validation, partial payload, …).
        // Leave it absent so the singular resolver can fill it in if and
        // when the user actually taps — never overwrite with a
        // synthesized `null`.
        continue;
      }
      const raw = handles[key];
      // Normalise to `string | null` only — guard against unexpected
      // payload shapes turning into typed cache entries.
      const value: string | null =
        typeof raw === "string" && raw.length > 0 ? raw : raw === null ? null : null;
      queryClient.setQueryData(publicProfileHandleQueryKey(id), value);
    }
  }
}

/**
 * React-friendly hook around `prewarmPublicProfileHandles`. Re-runs
 * whenever the deduped, sorted set of ids changes — typical caller is
 * the leaderboard / leagues members tab screen passing the userIds it
 * just finished rendering. Safe to call with `undefined` / empty input
 * while the screen is still loading.
 */
export function usePrewarmPublicProfileHandles(userIds: ReadonlyArray<number | null | undefined> | undefined): void {
  const queryClient = useQueryClient();
  // Build a stable cache key for the effect: dedupe + sort the valid ids
  // so re-renders that don't change the underlying set don't trigger
  // re-prewarming. This matters because list screens often re-render
  // every few seconds (live leaderboard polls, follow toggles, …).
  const sortedIdsKey = (() => {
    if (!userIds || userIds.length === 0) return "";
    const seen = new Set<number>();
    for (const raw of userIds) {
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) continue;
      seen.add(Math.trunc(raw));
    }
    if (seen.size === 0) return "";
    return Array.from(seen).sort((a, b) => a - b).join(",");
  })();
  useEffect(() => {
    if (!sortedIdsKey) return;
    const ids = sortedIdsKey.split(",").map(s => Number(s));
    void prewarmPublicProfileHandles(queryClient, ids);
  }, [queryClient, sortedIdsKey]);
}
