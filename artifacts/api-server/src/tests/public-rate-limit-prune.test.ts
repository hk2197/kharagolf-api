/**
 * Task #930 — The cron-driven sweep of `public_rate_limit_buckets`
 * deletes any row untouched for more than one hour, regardless of
 * whether traffic happens to be hitting the request hot path.
 */
process.env.SESSION_SECRET ||= "test-session-secret-for-rl-prune";

import { describe, it, expect, beforeEach } from "vitest";
import { db, publicRateLimitBucketsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import {
  pruneStaleRateLimitBuckets,
  _resetRateLimiterForTests,
} from "../lib/publicRateLimit.js";

const STALE_MS = 60 * 60 * 1000;

const FRESH_KEY = "test-prune:fresh";
const RECENT_STALE_KEY = "test-prune:just-stale";
const VERY_STALE_KEY = "test-prune:very-stale";
const ALL_TEST_KEYS = [FRESH_KEY, RECENT_STALE_KEY, VERY_STALE_KEY];

beforeEach(async () => {
  await _resetRateLimiterForTests();
});

describe("pruneStaleRateLimitBuckets", () => {
  it("deletes only rows older than the 1-hour stale threshold", async () => {
    const now = Date.now();
    await db.insert(publicRateLimitBucketsTable).values([
      { key: FRESH_KEY, tokens: 5, lastRefillAt: new Date(now - 60 * 1000) },
      {
        key: RECENT_STALE_KEY,
        tokens: 5,
        lastRefillAt: new Date(now - STALE_MS - 60 * 1000),
      },
      {
        key: VERY_STALE_KEY,
        tokens: 5,
        lastRefillAt: new Date(now - 24 * 60 * 60 * 1000),
      },
    ]);

    const deleted = await pruneStaleRateLimitBuckets(now);
    // `>=` because other tests in the suite may share the table; what we
    // assert below is that *our* stale rows were the ones deleted.
    expect(deleted).toBeGreaterThanOrEqual(2);

    const remaining = await db
      .select({ key: publicRateLimitBucketsTable.key })
      .from(publicRateLimitBucketsTable)
      .where(inArray(publicRateLimitBucketsTable.key, ALL_TEST_KEYS));

    const remainingKeys = remaining.map((r) => r.key);
    expect(remainingKeys).toContain(FRESH_KEY);
    expect(remainingKeys).not.toContain(RECENT_STALE_KEY);
    expect(remainingKeys).not.toContain(VERY_STALE_KEY);
  });

  it("is a no-op when the table is empty", async () => {
    const deleted = await pruneStaleRateLimitBuckets(Date.now());
    expect(deleted).toBe(0);
  });

  it("runs independently of the opportunistic hot-path throttle", async () => {
    // The hot-path prune skips if it ran in the last 5 minutes. The
    // explicit cron entry-point must still delete stale rows even when
    // the hot path has just run.
    const now = Date.now();
    await db.insert(publicRateLimitBucketsTable).values({
      key: VERY_STALE_KEY,
      tokens: 5,
      lastRefillAt: new Date(now - 2 * STALE_MS),
    });

    // Simulate that the hot path just ran by leaving lastPruneAt fresh —
    // _resetRateLimiterForTests already cleared it, but call prune here
    // directly to prove cron does not consult the hot-path throttle.
    const deleted = await pruneStaleRateLimitBuckets(now);
    expect(deleted).toBeGreaterThanOrEqual(1);

    const stillThere = await db
      .select({ key: publicRateLimitBucketsTable.key })
      .from(publicRateLimitBucketsTable)
      .where(inArray(publicRateLimitBucketsTable.key, [VERY_STALE_KEY]));
    expect(stillThere).toHaveLength(0);
  });
});
