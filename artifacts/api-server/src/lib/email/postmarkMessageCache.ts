/**
 * Task #1937 — In-memory cache for Postmark outbound-message lookups.
 *
 * Background
 * ----------
 * `GET /organizations/:orgId/marketing/suppressions/:id/message` (Task #1556)
 * lets admins jump from a suppressed address straight to the bounced message
 * preview. Each open hits Postmark's outbound-messages API which is rate
 * limited and slow (typically 500–1500ms). The underlying message body never
 * changes after send — Postmark itself only retains bodies for ~45 days but
 * within that window the payload is fully immutable — so re-fetching the same
 * MessageID on every modal open is pure waste.
 *
 * This cache memoises *successful* lookups keyed by Postmark MessageID for a
 * configurable TTL (default: 1 hour, well within Postmark's retention window
 * but generous enough that repeated triage on the same suppression feels
 * instant). Failures are deliberately *not* cached so transient network /
 * 502 / token-misconfig issues recover on the next request.
 *
 * Invalidation isn't needed (bodies are immutable). The route layer exposes a
 * `?refresh=1` query parameter that bypasses the cache and refreshes the
 * stored entry, primarily as a debugging affordance.
 *
 * Concurrency: Node's single-threaded event loop means concurrent callers can
 * only race at the await points inside `fetchPostmarkMessageDetails`. We
 * accept that a small burst on the same MessageID may issue duplicate
 * requests on first miss; once any of them resolves the cache is populated
 * and subsequent opens are HITs.
 */

import { fetchPostmarkMessageDetails } from "./adapter";

type FetchResult = Awaited<ReturnType<typeof fetchPostmarkMessageDetails>>;
type SuccessResult = Extract<FetchResult, { ok: true }>;

interface CacheEntry {
  details: SuccessResult["details"];
  expiresAt: number;
}

/** Default TTL — 1 hour. Task spec requires "at least an hour"; Postmark
 * retains bodies for ~45 days so a longer TTL is also safe. Overridable via
 * `POSTMARK_MESSAGE_CACHE_TTL_MS` for ops tuning, but never lower than the
 * spec-mandated 1-hour floor (see `MIN_TTL_MS`). */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/** Spec floor — the task requires "stores successful responses for at least
 * an hour". An env override below this would silently violate that
 * contract, so we clamp upward instead of trusting the operator. */
const MIN_TTL_MS = 60 * 60 * 1000;

/** Soft cap on cache size to bound memory in long-running processes. When
 * exceeded we drop the oldest half — admins triaging suppressions touch a
 * small working set, so this is plenty. */
const MAX_ENTRIES = 1000;

const cache = new Map<string, CacheEntry>();

function ttlMs(): number {
  const raw = process.env.POSTMARK_MESSAGE_CACHE_TTL_MS;
  if (!raw) return DEFAULT_TTL_MS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_MS;
  // Clamp to the spec floor so an over-eager env override can't drop the
  // effective TTL below the "at least an hour" promise the task demands.
  return Math.max(n, MIN_TTL_MS);
}

function pruneIfNeeded(): void {
  if (cache.size <= MAX_ENTRIES) return;
  // Map iteration order is insertion order; drop the oldest half.
  const drop = Math.ceil(cache.size / 2);
  let i = 0;
  for (const key of cache.keys()) {
    if (i++ >= drop) break;
    cache.delete(key);
  }
}

export type CacheStatus = "HIT" | "MISS";

export type CachedFetchResult =
  | { ok: true; details: SuccessResult["details"]; cacheStatus: CacheStatus }
  | (Extract<FetchResult, { ok: false }> & { cacheStatus: CacheStatus });

/**
 * Cached wrapper around `fetchPostmarkMessageDetails`.
 *
 * - On HIT: returns the stored details without touching Postmark.
 * - On MISS or `refresh=true`: calls Postmark, stores successful responses,
 *   and returns the live result. Failures pass through but are NOT cached.
 */
export async function getCachedPostmarkMessageDetails(
  messageId: string,
  opts: { refresh?: boolean } = {},
): Promise<CachedFetchResult> {
  const now = Date.now();

  if (!opts.refresh) {
    const hit = cache.get(messageId);
    if (hit && hit.expiresAt > now) {
      return { ok: true, details: hit.details, cacheStatus: "HIT" };
    }
    if (hit) {
      // Expired — drop so we don't leak stale entries forever.
      cache.delete(messageId);
    }
  } else {
    // Explicit refresh — drop any existing entry up front so a failed
    // refresh doesn't keep serving the old body indefinitely.
    cache.delete(messageId);
  }

  const result = await fetchPostmarkMessageDetails(messageId);
  if (result.ok) {
    cache.set(messageId, {
      details: result.details,
      expiresAt: now + ttlMs(),
    });
    pruneIfNeeded();
    return { ok: true, details: result.details, cacheStatus: "MISS" };
  }
  return { ...result, cacheStatus: "MISS" };
}

/** Test-only: drop every cached entry. Exported so the integration test
 * suite can isolate hit/miss assertions across cases. */
export function __resetPostmarkMessageCacheForTests(): void {
  cache.clear();
}

/** Test-only: peek at the current entry count (useful for assertions). */
export function __postmarkMessageCacheSizeForTests(): number {
  return cache.size;
}
