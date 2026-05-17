/**
 * Test #1842 — `primeYearInGolfCache` (the launch cron's warm-up entry
 * point) must write into the same in-memory recap cache that user-facing
 * recap fetches read from, so the very first user who taps the launch
 * push notification skips the aggregation entirely.
 *
 * Task #1503 added a 60s in-memory cache of `computeYearInGolf` keyed
 * by (userId, year, period) used by every user-facing recap fetch
 * (public PNG, portal recap JSON, portal card.png, portal video.mp4).
 * Before Task #1842, the cron's prime path called the raw
 * `computeYearInGolf` directly, which only warmed the DB query cache —
 * the first user tapping the push still paid a fresh aggregation.
 *
 * This test exercises the new contract directly:
 *
 *   1. Calls `primeYearInGolfCache` for a synthetic user.
 *   2. Calls `getCachedYearInGolf` for the same (userId, year, period)
 *      and asserts reference equality with the primed result. Since
 *      `computeYearInGolf` always allocates a brand new object literal,
 *      a `===` match proves the second call resolved from the cache
 *      that the prime step warmed (no second aggregation ran).
 *   3. Asserts the cache write also wins against a different period
 *      for the same user (the cache is correctly keyed) and against a
 *      different user (no cross-user leakage).
 *
 * The cron's delegation through `primeYearInGolfCache` (instead of the
 * old direct `computeYearInGolf` call) is asserted in
 * `year-in-golf-cron-restart.test.ts`, which mocks the module so the
 * call counts can be inspected directly.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@workspace/db";
import { appUsersTable, organizationsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  primeYearInGolfCache,
  getCachedYearInGolf,
} from "../lib/year-in-golf.js";

let testOrgId: number;
const userIds: number[] = [];

beforeAll(async () => {
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `RecapPrimeOrg_${ts}`,
    slug: `recap-prime-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;
  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `recap-prime-a-${ts}`,
    username: `recap_prime_a_${ts}`,
    email: `recap_prime_a_${ts}@example.test`,
    displayName: "Prime Player A",
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `recap-prime-b-${ts}`,
    username: `recap_prime_b_${ts}`,
    email: `recap_prime_b_${ts}@example.test`,
    displayName: "Prime Player B",
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  userIds.push(u1.id, u2.id);
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

describe("primeYearInGolfCache (Task #1842)", () => {
  it("warms the same cache that getCachedYearInGolf reads from — first cached fetch returns the primed object", async () => {
    // Far-future year keeps us out of any seeded data and guarantees
    // both functions see the same empty-data shape.
    const year = 3042;
    const userId = userIds[0]!;

    const primed = await primeYearInGolfCache(userId, year, "q1");
    const fetched = await getCachedYearInGolf(userId, year, "q1");

    // `computeYearInGolf` allocates a brand new object literal per call,
    // so reference equality proves the cached object came back rather
    // than a fresh re-aggregation.
    expect(fetched).toBe(primed);
  });

  it("does not collide across (userId, year, period) — only the primed slot is warmed", async () => {
    const year = 3043;
    const userA = userIds[0]!;
    const userB = userIds[1]!;

    const primedQ1A = await primeYearInGolfCache(userA, year, "q1");

    // Same user, different period → distinct cache slot, fresh object.
    const yearForA = await getCachedYearInGolf(userA, year, "year");
    expect(yearForA).not.toBe(primedQ1A);

    // Different user, same period → distinct cache slot, fresh object.
    const q1ForB = await getCachedYearInGolf(userB, year, "q1");
    expect(q1ForB).not.toBe(primedQ1A);

    // The originally primed slot is still warm.
    const q1AAgain = await getCachedYearInGolf(userA, year, "q1");
    expect(q1AAgain).toBe(primedQ1A);
  });

  it("re-priming the same key replaces the cached entry with the freshly computed one", async () => {
    const year = 3044;
    const userId = userIds[0]!;

    const first = await primeYearInGolfCache(userId, year, "q2");
    const fetchedFirst = await getCachedYearInGolf(userId, year, "q2");
    expect(fetchedFirst).toBe(first);

    // Re-prime: a brand-new object literal must overwrite the prior
    // entry (the prime path is the source of truth for the warmed
    // value, not a passive read-through).
    const second = await primeYearInGolfCache(userId, year, "q2");
    expect(second).not.toBe(first);

    const fetchedSecond = await getCachedYearInGolf(userId, year, "q2");
    expect(fetchedSecond).toBe(second);
  });
});
