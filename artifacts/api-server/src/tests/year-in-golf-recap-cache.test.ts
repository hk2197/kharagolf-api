/**
 * Test #1503 — `getCachedYearInGolf` reuses one aggregation per
 * (userId, year, period) inside its TTL window so flipping between
 * recap chapters doesn't re-run the full DB aggregation per chapter.
 *
 * The cache lives one level above the existing PNG cache: a real user
 * paging chapter 0 → 1 → 2 → … keeps the same (userId, year, period)
 * and so should hit the cached recap object on every chapter after
 * the first. We assert this by reference equality of the returned
 * recap object — `computeYearInGolf` always builds a brand new object
 * literal, so a `===` match proves the value came from the cache and
 * not from a re-computation.
 *
 * We also exercise the in-flight coalescing path: two concurrent
 * misses for the same key resolve to the same recap object (one
 * shared computation), and a third call after both resolve still
 * gets the same cached object back.
 *
 * A different (year, period) for the same user must NOT collide with
 * the cached entry — we verify it returns a distinct object so we
 * know the cache is correctly keyed by all three components.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { db } from "@workspace/db";
import { appUsersTable, organizationsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { getCachedYearInGolf } from "../lib/year-in-golf.js";

let testOrgId: number;
const userIds: number[] = [];

beforeAll(async () => {
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `RecapCacheOrg_${ts}`,
    slug: `recap-cache-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `recap-cache-${ts}`,
    username: `recap_cache_${ts}`,
    email: `recap_cache_${ts}@example.test`,
    displayName: "Recap Cache Player",
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  userIds.push(u.id);
});

afterAll(async () => {
  if (userIds.length > 0) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
    userIds.length = 0;
  }
  if (testOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  }
});

describe("getCachedYearInGolf", () => {
  it("returns the same recap object reference for repeated calls within the TTL", async () => {
    // Use a far-future year so we never collide with real seeded data.
    const year = 3027;
    const userId = userIds[0]!;

    const first = await getCachedYearInGolf(userId, year, "year");
    const second = await getCachedYearInGolf(userId, year, "year");
    const third = await getCachedYearInGolf(userId, year, "year");

    // `computeYearInGolf` always allocates a brand new object literal,
    // so reference equality across calls proves the cached object was
    // returned without re-running the aggregation.
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("coalesces concurrent misses for the same key into a single computation", async () => {
    const year = 3028;
    const userId = userIds[0]!;

    const [a, b, c] = await Promise.all([
      getCachedYearInGolf(userId, year, "year"),
      getCachedYearInGolf(userId, year, "year"),
      getCachedYearInGolf(userId, year, "year"),
    ]);
    expect(b).toBe(a);
    expect(c).toBe(a);

    // A follow-up call after the in-flight promise settles still
    // returns the cached object (proves the inflight result was also
    // written into the cache, not just shared between racers).
    const followup = await getCachedYearInGolf(userId, year, "year");
    expect(followup).toBe(a);
  });

  it("recomputes a fresh recap once the 60s TTL expires", async () => {
    const year = 3030;
    const userId = userIds[0]!;

    const first = await getCachedYearInGolf(userId, year, "year");
    const stillFresh = await getCachedYearInGolf(userId, year, "year");
    expect(stillFresh).toBe(first);

    // Advance the wall clock past the 60s TTL window. The cache uses
    // `Date.now()` for expiry, so spying on it lets us simulate TTL
    // expiry without actually sleeping in tests.
    const realNow = Date.now();
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(realNow + 61_000);
    try {
      const afterExpiry = await getCachedYearInGolf(userId, year, "year");
      // A new aggregation must have run, producing a brand new object
      // literal — so reference equality with the expired entry must
      // NOT hold.
      expect(afterExpiry).not.toBe(first);

      // The fresh result is itself cached: another call inside the
      // (now-shifted) TTL window returns the same new reference.
      const cachedAgain = await getCachedYearInGolf(userId, year, "year");
      expect(cachedAgain).toBe(afterExpiry);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("keys the cache by (userId, year, period) — different periods do not collide", async () => {
    const year = 3029;
    const userId = userIds[0]!;

    const yearRecap = await getCachedYearInGolf(userId, year, "year");
    const q1Recap = await getCachedYearInGolf(userId, year, "q1");

    expect(q1Recap).not.toBe(yearRecap);
    // Each period's own cache slot, however, is sticky.
    const q1Again = await getCachedYearInGolf(userId, year, "q1");
    expect(q1Again).toBe(q1Recap);
  });
});
