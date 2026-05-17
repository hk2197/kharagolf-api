/**
 * Integration tests for the badge-share analytics endpoints (Task #926).
 *
 *   POST /api/public/p/:handle/badge/:type/share-event
 *     - 404 for unknown handle / unknown badge type / hidden achievements
 *     - 400 for invalid method
 *     - 201 happy-path: row inserted with handle snapshot, normalised
 *       method, and source whitelisted to "web"/"mobile"
 *     - source coerced to null when client supplies an unknown value
 *
 *   GET  /api/portal/me/badge-share-stats
 *     - aggregates per-badge + per-method counts for the caller's handle only
 *     - returns empty totals when caller has no public handle reserved
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  badgeShareEventsTable,
  badgeShareDailyAggregatesTable,
  badgeShareRollupRunsTable,
  badgeShareRollupRunHistoryTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";
import { _resetRateLimiterForTests } from "../lib/publicRateLimit.js";
import {
  pruneAndRollupBadgeShareEvents,
  getBadgeShareRollupAdminSummary,
  STALE_RUN_WARNING_MS,
  MAX_RUN_HISTORY_AGE_MS,
  HISTORY_SPARKLINE_DAYS,
} from "../lib/badgeShareRollup.js";

let orgId: number;
let ownerId: number;
let noHandleId: number;
let owner: TestUser;
let noHandle: TestUser;

const stamp = Date.now();
const handle = `bshare${stamp}`;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_BadgeShare_${stamp}`,
    slug: `test-badgeshare-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [a] = await db.insert(appUsersTable).values({
    replitUserId: `bshare-a-${stamp}`,
    username: `bshare_a_${stamp}`,
    email: `bshare_a_${stamp}@example.com`,
    displayName: "Badge Sharer",
    role: "player",
    organizationId: orgId,
    publicHandle: handle,
    publicProfileEnabled: true,
    publicShowAchievements: true,
  }).returning({ id: appUsersTable.id });
  ownerId = a.id;

  const [b] = await db.insert(appUsersTable).values({
    replitUserId: `bshare-b-${stamp}`,
    username: `bshare_b_${stamp}`,
    email: `bshare_b_${stamp}@example.com`,
    displayName: "No Handle",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  noHandleId = b.id;

  owner = { id: ownerId, username: `bshare_a_${stamp}`, role: "player", organizationId: orgId };
  noHandle = { id: noHandleId, username: `bshare_b_${stamp}`, role: "player", organizationId: orgId };
});

afterAll(async () => {
  await db.delete(badgeShareEventsTable).where(eq(badgeShareEventsTable.handle, handle));
  await db.delete(badgeShareDailyAggregatesTable).where(eq(badgeShareDailyAggregatesTable.handle, handle));
  if (ownerId) await db.delete(appUsersTable).where(eq(appUsersTable.id, ownerId));
  if (noHandleId) await db.delete(appUsersTable).where(eq(appUsersTable.id, noHandleId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("POST /api/public/p/:handle/badge/:type/share-event", () => {
  it("returns 404 when the handle does not resolve to a public profile", async () => {
    const app = createTestApp();
    const r = await request(app)
      .post(`/api/public/p/does-not-exist-${stamp}/badge/first_birdie/share-event`)
      .send({ method: "copy", source: "web" });
    expect(r.status).toBe(404);
  });

  it("returns 404 when the badge type is unknown", async () => {
    const app = createTestApp();
    const r = await request(app)
      .post(`/api/public/p/${handle}/badge/not_a_real_badge/share-event`)
      .send({ method: "copy", source: "web" });
    expect(r.status).toBe(404);
  });

  it("rejects unknown methods with 400", async () => {
    const app = createTestApp();
    for (const bad of ["", "unknown", "qr_open", "facebook", null]) {
      const r = await request(app)
        .post(`/api/public/p/${handle}/badge/first_birdie/share-event`)
        .send({ method: bad, source: "web" });
      expect(r.status, `method=${JSON.stringify(bad)}`).toBe(400);
    }
  });

  it("inserts a row capturing handle, badgeType, method, and a whitelisted source", async () => {
    await _resetRateLimiterForTests();
    const app = createTestApp();
    const r = await request(app)
      .post(`/api/public/p/${handle}/badge/first_birdie/share-event`)
      .send({ method: "copy", source: "web" });
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);

    const rows = await db
      .select()
      .from(badgeShareEventsTable)
      .where(eq(badgeShareEventsTable.handle, handle));
    const copyRow = rows.find(row => row.method === "copy" && row.badgeType === "first_birdie");
    expect(copyRow).toBeDefined();
    expect(copyRow!.source).toBe("web");
  });

  it("nulls out an unknown source rather than echoing client-supplied junk", async () => {
    await _resetRateLimiterForTests();
    const app = createTestApp();
    const r = await request(app)
      .post(`/api/public/p/${handle}/badge/first_eagle/share-event`)
      .send({ method: "native_share", source: "twitter" });
    expect(r.status).toBe(201);

    const rows = await db
      .select()
      .from(badgeShareEventsTable)
      .where(eq(badgeShareEventsTable.handle, handle));
    const row = rows.find(r => r.badgeType === "first_eagle" && r.method === "native_share");
    expect(row).toBeDefined();
    expect(row!.source).toBeNull();
  });
});

describe("POST /api/public/p/:handle/badge/:type/share-event — rate limiting (Task #1096)", () => {
  it("returns 429 once a single IP exhausts the per-IP-per-handle-per-badge bucket", async () => {
    await _resetRateLimiterForTests();
    const app = createTestApp();
    let saw429 = false;
    // Per-IP+handle+badge bucket caps at 5; fire 8 to overflow.
    for (let i = 0; i < 8; i++) {
      const r = await request(app)
        .post(`/api/public/p/${handle}/badge/first_birdie/share-event`)
        .send({ method: "copy", source: "web" });
      if (r.status === 429) { saw429 = true; break; }
    }
    expect(saw429).toBe(true);
    await _resetRateLimiterForTests();
  });
});

describe("pruneAndRollupBadgeShareEvents (Task #1096)", () => {
  it("rolls events older than the cutoff into per-day aggregates and deletes them", async () => {
    await _resetRateLimiterForTests();
    // Clear pre-existing rows for this handle so counts are deterministic.
    await db.delete(badgeShareEventsTable).where(eq(badgeShareEventsTable.handle, handle));
    await db.delete(badgeShareDailyAggregatesTable).where(eq(badgeShareDailyAggregatesTable.handle, handle));

    const oldDay1 = new Date("2024-01-15T03:14:00Z");
    const oldDay2 = new Date("2024-01-16T22:00:00Z");
    const recent = new Date(); // very fresh — must NOT be rolled up

    // Two events on day 1 (copy) + one on day 2 (native_share) + one fresh.
    await db.insert(badgeShareEventsTable).values([
      { handle, badgeType: "first_birdie", method: "copy", source: "web" },
      { handle, badgeType: "first_birdie", method: "copy", source: "web" },
      { handle, badgeType: "first_birdie", method: "native_share", source: "mobile" },
      { handle, badgeType: "first_birdie", method: "copy", source: "web" },
    ]);

    // Backdate the first three rows. Use returning IDs of just-inserted rows:
    const inserted = await db
      .select({ id: badgeShareEventsTable.id, createdAt: badgeShareEventsTable.createdAt })
      .from(badgeShareEventsTable)
      .where(eq(badgeShareEventsTable.handle, handle))
      .orderBy(badgeShareEventsTable.id);
    expect(inserted.length).toBe(4);

    await db.update(badgeShareEventsTable)
      .set({ createdAt: oldDay1 })
      .where(eq(badgeShareEventsTable.id, inserted[0].id));
    await db.update(badgeShareEventsTable)
      .set({ createdAt: oldDay1 })
      .where(eq(badgeShareEventsTable.id, inserted[1].id));
    await db.update(badgeShareEventsTable)
      .set({ createdAt: oldDay2 })
      .where(eq(badgeShareEventsTable.id, inserted[2].id));
    await db.update(badgeShareEventsTable)
      .set({ createdAt: recent })
      .where(eq(badgeShareEventsTable.id, inserted[3].id));

    const summary = await pruneAndRollupBadgeShareEvents();
    expect(summary.rolledUpEvents).toBe(3);
    expect(summary.upsertedAggregateRows).toBeGreaterThanOrEqual(2);

    // Fresh event survives.
    const remaining = await db
      .select({ id: badgeShareEventsTable.id })
      .from(badgeShareEventsTable)
      .where(eq(badgeShareEventsTable.handle, handle));
    expect(remaining.length).toBe(1);

    // Aggregate rows reflect the rolled-up counts.
    const aggs = await db
      .select()
      .from(badgeShareDailyAggregatesTable)
      .where(eq(badgeShareDailyAggregatesTable.handle, handle));
    const day1Copy = aggs.find(a => a.method === "copy" && a.day.toISOString().startsWith("2024-01-15"));
    const day2Native = aggs.find(a => a.method === "native_share" && a.day.toISOString().startsWith("2024-01-16"));
    expect(day1Copy?.count).toBe(2);
    expect(day2Native?.count).toBe(1);
  });

  it("re-running the rollup is safe — a second pass on the same window doesn't drop counts", async () => {
    // Insert another aged event and run the rollup twice.
    await db.insert(badgeShareEventsTable).values({
      handle, badgeType: "first_eagle", method: "web_share", source: "web",
    });
    const [{ id }] = await db
      .select({ id: badgeShareEventsTable.id })
      .from(badgeShareEventsTable)
      .where(sql`${badgeShareEventsTable.handle} = ${handle} AND ${badgeShareEventsTable.badgeType} = 'first_eagle'`)
      .orderBy(badgeShareEventsTable.id);
    await db.update(badgeShareEventsTable)
      .set({ createdAt: new Date("2024-02-01T00:00:00Z") })
      .where(eq(badgeShareEventsTable.id, id));

    const first = await pruneAndRollupBadgeShareEvents();
    expect(first.rolledUpEvents).toBe(1);
    const second = await pruneAndRollupBadgeShareEvents();
    expect(second.rolledUpEvents).toBe(0);

    const aggs = await db
      .select()
      .from(badgeShareDailyAggregatesTable)
      .where(eq(badgeShareDailyAggregatesTable.handle, handle));
    const eagleAgg = aggs.find(a => a.badgeType === "first_eagle" && a.method === "web_share");
    expect(eagleAgg?.count).toBe(1);
  });

  it("portal stats include both raw events and rolled-up aggregates", async () => {
    await _resetRateLimiterForTests();
    const app = createTestApp(owner);
    const r = await request(app).get("/api/portal/me/badge-share-stats");
    expect(r.status).toBe(200);
    // first_birdie copy: 2 (aggregate) + recent unrolled rows from prior tests
    const firstBirdie = r.body.badges.find((b: { badgeType: string }) => b.badgeType === "first_birdie");
    expect(firstBirdie).toBeDefined();
    expect(firstBirdie.byMethod.copy).toBeGreaterThanOrEqual(2);
    const firstEagle = r.body.badges.find((b: { badgeType: string }) => b.badgeType === "first_eagle");
    expect(firstEagle).toBeDefined();
    expect(firstEagle.byMethod.web_share).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/portal/me/badge-share-stats", () => {
  it("aggregates per-badge + per-method counts for the caller's handle only", async () => {
    await _resetRateLimiterForTests();
    const app = createTestApp(owner);
    // Re-seed the events the earlier tests inserted (the rollup test
    // above clears them so its assertions are deterministic). We need
    // both first_birdie/copy and first_eagle/native_share to exist for
    // the per-badge breakdown assertion below.
    await request(app)
      .post(`/api/public/p/${handle}/badge/first_eagle/share-event`)
      .send({ method: "native_share", source: "web" });
    await request(app)
      .post(`/api/public/p/${handle}/badge/first_birdie/share-event`)
      .send({ method: "copy", source: "web" });
    // Add another share so we have multiple methods and badges.
    await request(app)
      .post(`/api/public/p/${handle}/badge/first_birdie/share-event`)
      .send({ method: "native_share", source: "mobile" });

    const r = await request(app).get("/api/portal/me/badge-share-stats");
    expect(r.status).toBe(200);
    expect(r.body.totalsByMethod).toMatchObject({
      copy: expect.any(Number),
      web_share: expect.any(Number),
      native_share: expect.any(Number),
    });

    const firstBirdie = r.body.badges.find((b: { badgeType: string }) => b.badgeType === "first_birdie");
    expect(firstBirdie).toBeDefined();
    expect(firstBirdie.label).toBe("First Birdie");
    expect(firstBirdie.byMethod.copy).toBeGreaterThanOrEqual(1);
    expect(firstBirdie.byMethod.native_share).toBeGreaterThanOrEqual(1);

    const firstEagle = r.body.badges.find((b: { badgeType: string }) => b.badgeType === "first_eagle");
    expect(firstEagle).toBeDefined();
    expect(firstEagle.byMethod.native_share).toBeGreaterThanOrEqual(1);

    // Total matches sum across methods
    expect(r.body.total).toBe(
      r.body.totalsByMethod.copy +
      r.body.totalsByMethod.web_share +
      r.body.totalsByMethod.native_share,
    );
  });

  it("admin badge-share leaderboard combines raw events with rolled-up aggregates", async () => {
    await _resetRateLimiterForTests();
    // Seed an aggregate row for an aged day directly so we don't have to
    // backdate raw events again — this is what the rollup writes.
    await db.insert(badgeShareDailyAggregatesTable).values({
      handle,
      badgeType: "first_birdie",
      method: "copy",
      day: new Date(`${new Date().getUTCFullYear()}-01-15T00:00:00Z`),
      count: 5,
    }).onConflictDoUpdate({
      target: [
        badgeShareDailyAggregatesTable.handle,
        badgeShareDailyAggregatesTable.badgeType,
        badgeShareDailyAggregatesTable.method,
        badgeShareDailyAggregatesTable.day,
      ],
      set: { count: sql`${badgeShareDailyAggregatesTable.count} + EXCLUDED.count` },
    });
    // Add a fresh raw event so the response covers both sources.
    await db.insert(badgeShareEventsTable).values({
      handle, badgeType: "first_birdie", method: "copy", source: "web",
    });

    const adminUser: TestUser = { ...owner, role: "org_admin" };
    const app = createTestApp(adminUser);
    const r = await request(app)
      .get(`/api/organizations/${orgId}/analytics/badge-share-leaderboard?period=year`);
    expect(r.status).toBe(200);
    const firstBirdie = r.body.badges.find((b: { badgeType: string }) => b.badgeType === "first_birdie");
    expect(firstBirdie).toBeDefined();
    // Aggregate (>=5) + at least one fresh raw event = >=6.
    expect(firstBirdie.byMethod.copy).toBeGreaterThanOrEqual(6);
  });

  it("badge-share member breakdown lists sharers for a single badge with per-method counts (Task #1248)", async () => {
    await _resetRateLimiterForTests();
    // Seed an aggregate row + a fresh raw event so the breakdown sums both
    // sources, mirroring the leaderboard combine test above.
    await db.insert(badgeShareDailyAggregatesTable).values({
      handle,
      badgeType: "first_birdie",
      method: "web_share",
      day: new Date(`${new Date().getUTCFullYear()}-01-20T00:00:00Z`),
      count: 3,
    }).onConflictDoUpdate({
      target: [
        badgeShareDailyAggregatesTable.handle,
        badgeShareDailyAggregatesTable.badgeType,
        badgeShareDailyAggregatesTable.method,
        badgeShareDailyAggregatesTable.day,
      ],
      set: { count: sql`${badgeShareDailyAggregatesTable.count} + EXCLUDED.count` },
    });
    await db.insert(badgeShareEventsTable).values({
      handle, badgeType: "first_birdie", method: "native_share", source: "mobile",
    });

    const adminUser: TestUser = { ...owner, role: "org_admin" };
    const app = createTestApp(adminUser);
    const r = await request(app)
      .get(`/api/organizations/${orgId}/analytics/badge-share-leaderboard/first_birdie?period=year`);
    expect(r.status).toBe(200);
    expect(r.body.badge.badgeType).toBe("first_birdie");
    expect(r.body.badge.label).toBe("First Birdie");
    expect(Array.isArray(r.body.members)).toBe(true);
    const ownerRow = r.body.members.find((m: { userId: number }) => m.userId === ownerId);
    expect(ownerRow).toBeDefined();
    expect(ownerRow.publicHandle).toBe(handle);
    expect(ownerRow.byMethod.web_share).toBeGreaterThanOrEqual(3);
    expect(ownerRow.byMethod.native_share).toBeGreaterThanOrEqual(1);
    expect(ownerRow.total).toBe(
      ownerRow.byMethod.copy + ownerRow.byMethod.web_share + ownerRow.byMethod.native_share,
    );
    // Sheet is scoped to one badge — totals match members' totals
    expect(r.body.totals.total).toBe(
      r.body.totals.byMethod.copy +
      r.body.totals.byMethod.web_share +
      r.body.totals.byMethod.native_share,
    );
  });

  it("badge-share member breakdown 403s for non-admin callers (Task #1248)", async () => {
    const app = createTestApp(owner);
    const r = await request(app)
      .get(`/api/organizations/${orgId}/analytics/badge-share-leaderboard/first_birdie?period=year`);
    expect(r.status).toBe(403);
  });

  it("returns empty totals when the caller has no reserved public handle", async () => {
    const app = createTestApp(noHandle);
    const r = await request(app).get("/api/portal/me/badge-share-stats");
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(0);
    expect(r.body.badges).toEqual([]);
    expect(r.body.totalsByMethod).toEqual({ copy: 0, web_share: 0, native_share: 0 });
  });
});

// ─── Task #1260 — Super-admin storage-savings panel ─────────────────
//
// The rollup persists its last-run summary so a super-admin endpoint
// can show ops how much it's saving and warn when the cron stops
// firing. These tests cover the persistence + admin endpoint.
describe("badge-share rollup last-run state (Task #1260)", () => {
  it("UPSERTs the singleton run row at the end of every successful rollup", async () => {
    const before = Date.now();
    await pruneAndRollupBadgeShareEvents();

    const rows = await db.select().from(badgeShareRollupRunsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
    // ranAt is set to the rollup's `nowMs`, which defaults to `Date.now()`
    // and is captured *before* the transaction completes.
    expect(rows[0].ranAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(rows[0].ranAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    // A second pass overwrites the same row (no run-history accumulation).
    await pruneAndRollupBadgeShareEvents();
    const rowsAfter = await db.select().from(badgeShareRollupRunsTable);
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0].ranAt.getTime()).toBeGreaterThanOrEqual(rows[0].ranAt.getTime());
  });

  it("getBadgeShareRollupAdminSummary returns last-run state + live row counts", async () => {
    await pruneAndRollupBadgeShareEvents();

    const summary = await getBadgeShareRollupAdminSummary();
    expect(summary.lastRun).not.toBeNull();
    expect(summary.lastRun!.ranAt).toEqual(expect.any(String));
    expect(summary.lastRun!.rolledUpEvents).toBeGreaterThanOrEqual(0);
    expect(summary.lastRun!.upsertedAggregateRows).toBeGreaterThanOrEqual(0);
    expect(summary.lastRun!.prunedAggregateRows).toBeGreaterThanOrEqual(0);

    expect(summary.currentRawEventCount).toEqual(expect.any(Number));
    expect(summary.currentAggregateRowCount).toEqual(expect.any(Number));
    expect(summary.isStale).toBe(false);
    expect(summary.staleThresholdMs).toBe(STALE_RUN_WARNING_MS);
    expect(summary.rollupAgeMs).toBeGreaterThan(0);

    // Task #1814 — Auto-pager state surfaced for the super-admin panel.
    // `lastOpsAlertAt` may be null (no page yet) or a string set by the
    // alert-job tests; either is acceptable here. `opsAlertCooldownMs`
    // must always be a positive number derived from the env-driven
    // cooldown so the panel can render the "won't re-page for Nh" line.
    expect(["string", "object"]).toContain(typeof summary.lastOpsAlertAt);
    if (summary.lastOpsAlertAt !== null) {
      expect(typeof summary.lastOpsAlertAt).toBe("string");
    }
    expect(summary.opsAlertCooldownMs).toBeGreaterThan(0);

    // Task #1474 — savings estimate fields are present and non-negative.
    expect(summary.storageSavings.aggregatedEventCount).toBeGreaterThanOrEqual(0);
    expect(summary.storageSavings.estimatedRowsSaved).toBeGreaterThanOrEqual(0);
    expect(summary.storageSavings.estimatedBytesSaved).toBeGreaterThanOrEqual(0);
    expect(summary.storageSavings.estimatedBytesPerRawRow).toBeGreaterThan(0);
    // estimatedRowsSaved == aggregatedEventCount - currentAggregateRowCount
    // (clamped at 0). Sanity-check the relationship holds.
    expect(summary.storageSavings.estimatedRowsSaved).toBe(
      Math.max(
        0,
        summary.storageSavings.aggregatedEventCount - summary.currentAggregateRowCount,
      ),
    );
  });

  it("derives storageSavings.savingsPercent / savingsRatio from the aggregate volume (Task #1479)", async () => {
    // Wipe both tables so the only rows the summary sees come from
    // this test — otherwise other tests' fixtures swamp the math.
    await db.delete(badgeShareEventsTable);
    await db.delete(badgeShareDailyAggregatesTable);

    // Seed: 100 raw events folded into 4 aggregate buckets (100 → 4
    // = 25× compression, 96% smaller). No "still raw" events left.
    await db.insert(badgeShareDailyAggregatesTable).values([
      { handle, badgeType: "first_birdie", method: "copy", day: new Date("2024-01-15"), count: 30 },
      { handle, badgeType: "first_birdie", method: "native_share", day: new Date("2024-01-15"), count: 20 },
      { handle, badgeType: "first_eagle", method: "copy", day: new Date("2024-01-16"), count: 35 },
      { handle, badgeType: "first_eagle", method: "native_share", day: new Date("2024-01-16"), count: 15 },
    ]);

    const summary = await getBadgeShareRollupAdminSummary();
    expect(summary.currentRawEventCount).toBe(0);
    expect(summary.currentAggregateRowCount).toBe(4);
    expect(summary.storageSavings.aggregatedEventCount).toBe(100);
    // 1 - (0+4)/(0+100) = 0.96
    expect(summary.storageSavings.savingsPercent).not.toBeNull();
    expect(summary.storageSavings.savingsPercent!).toBeCloseTo(96, 5);
    // (0+100)/(0+4) = 25
    expect(summary.storageSavings.savingsRatio).not.toBeNull();
    expect(summary.storageSavings.savingsRatio!).toBeCloseTo(25, 5);

    // Cleanup so later tests aren't polluted by these fixture rows.
    await db.delete(badgeShareDailyAggregatesTable).where(eq(badgeShareDailyAggregatesTable.handle, handle));
  });

  it("returns null savings when the rollup has not collapsed any events yet (Task #1479)", async () => {
    // Empty aggregate table — no compression has happened, so the
    // panel should render the "no savings yet" empty state instead
    // of a misleading "0%".
    await db.delete(badgeShareEventsTable);
    await db.delete(badgeShareDailyAggregatesTable);

    const summary = await getBadgeShareRollupAdminSummary();
    expect(summary.storageSavings.aggregatedEventCount).toBe(0);
    expect(summary.storageSavings.savingsPercent).toBeNull();
    expect(summary.storageSavings.savingsRatio).toBeNull();
  });

  it("isStale flips to true when the last run is older than the warning threshold", async () => {
    await pruneAndRollupBadgeShareEvents();
    // Backdate the singleton so it falls outside the stale window.
    await db
      .update(badgeShareRollupRunsTable)
      .set({ ranAt: new Date(Date.now() - STALE_RUN_WARNING_MS - 60 * 1000) })
      .where(eq(badgeShareRollupRunsTable.id, 1));

    const summary = await getBadgeShareRollupAdminSummary();
    expect(summary.isStale).toBe(true);
  });

  it("treats a brand-new database (no runs ever) as stale", async () => {
    // Wipe the singleton row and re-query.
    await db.delete(badgeShareRollupRunsTable);
    const summary = await getBadgeShareRollupAdminSummary();
    expect(summary.lastRun).toBeNull();
    expect(summary.isStale).toBe(true);
  });
});

describe("GET /api/super-admin/badge-share-rollup/summary (Task #1260)", () => {
  it("requires authentication", async () => {
    const app = createTestApp();
    const r = await request(app).get("/api/super-admin/badge-share-rollup/summary");
    expect(r.status).toBe(401);
  });

  it("rejects non-super-admins with 403", async () => {
    const app = createTestApp(owner); // role: "player"
    const r = await request(app).get("/api/super-admin/badge-share-rollup/summary");
    expect(r.status).toBe(403);
  });

  it("returns the admin summary for a super-admin caller", async () => {
    await pruneAndRollupBadgeShareEvents();

    const superAdmin: TestUser = {
      id: 9_991_260,
      username: "badge_rollup_admin",
      role: "super_admin",
    };
    const app = createTestApp(superAdmin);
    const r = await request(app).get("/api/super-admin/badge-share-rollup/summary");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      currentRawEventCount: expect.any(Number),
      currentAggregateRowCount: expect.any(Number),
      isStale: expect.any(Boolean),
      staleThresholdMs: STALE_RUN_WARNING_MS,
      rollupAgeMs: expect.any(Number),
      generatedAt: expect.any(String),
      // Task #1474 — byte-level savings estimate.
      // Task #1479 — row-count compression KPIs (savingsPercent / savingsRatio
      // are nullable; assert presence via toHaveProperty below rather than
      // constraining the type here).
      storageSavings: {
        aggregatedEventCount: expect.any(Number),
        estimatedRowsSaved: expect.any(Number),
        estimatedBytesSaved: expect.any(Number),
        estimatedBytesPerRawRow: expect.any(Number),
      },
    });
    expect(r.body.storageSavings.estimatedBytesPerRawRow).toBeGreaterThan(0);
    expect(r.body.storageSavings.estimatedRowsSaved).toBeGreaterThanOrEqual(0);
    expect(r.body.storageSavings.estimatedBytesSaved).toBeGreaterThanOrEqual(0);
    expect(r.body.storageSavings).toHaveProperty("savingsPercent");
    expect(r.body.storageSavings).toHaveProperty("savingsRatio");
    expect(r.body.lastRun).toMatchObject({
      ranAt: expect.any(String),
      rolledUpEvents: expect.any(Number),
      upsertedAggregateRows: expect.any(Number),
      prunedAggregateRows: expect.any(Number),
    });
  });
});

// ─── Task #1821 — 7-day savings sparkline ──────────────────────────────
//
// The lifetime savings KPI on the super-admin panel is a single
// point-in-time number; this feature adds an append-only per-run
// history table so the panel can render a 7-day trend sparkline. These
// tests cover:
//   - The rollup APPENDs (does NOT upsert) one history row per run.
//   - The summary surfaces those points, capped to the last 7 days.
//   - Retention prunes anything older than MAX_RUN_HISTORY_AGE_MS so
//     the table can't grow unbounded.
//   - The savingsPercent / savingsRatio columns track the same
//     compression formula as the lifetime KPI.
describe("badge-share rollup per-run history (Task #1821)", () => {
  it("appends one history row per successful run (singleton run row stays one)", async () => {
    // Wipe both run-state tables so this test's count assertions are
    // deterministic regardless of what the earlier suites left behind.
    await db.delete(badgeShareRollupRunHistoryTable);
    await db.delete(badgeShareRollupRunsTable);

    await pruneAndRollupBadgeShareEvents();
    const after1 = await db
      .select()
      .from(badgeShareRollupRunHistoryTable)
      .orderBy(badgeShareRollupRunHistoryTable.id);
    expect(after1).toHaveLength(1);

    await pruneAndRollupBadgeShareEvents();
    const after2 = await db
      .select()
      .from(badgeShareRollupRunHistoryTable)
      .orderBy(badgeShareRollupRunHistoryTable.id);
    expect(after2).toHaveLength(2);

    // Singleton table is still one row — the history table is the only
    // place that grows.
    const singleton = await db.select().from(badgeShareRollupRunsTable);
    expect(singleton).toHaveLength(1);
  });

  it("captures savingsPercent / savingsRatio that mirror the lifetime KPI formula", async () => {
    // Fresh slate: no raw events, four aggregate buckets totalling 100
    // folded events. Mirrors the lifetime-KPI test above so the
    // history point should record the same 96 % / 25× compression.
    await db.delete(badgeShareEventsTable);
    await db.delete(badgeShareDailyAggregatesTable);
    await db.delete(badgeShareRollupRunHistoryTable);

    await db.insert(badgeShareDailyAggregatesTable).values([
      { handle, badgeType: "first_birdie", method: "copy", day: new Date("2024-01-15"), count: 30 },
      { handle, badgeType: "first_birdie", method: "native_share", day: new Date("2024-01-15"), count: 20 },
      { handle, badgeType: "first_eagle", method: "copy", day: new Date("2024-01-16"), count: 35 },
      { handle, badgeType: "first_eagle", method: "native_share", day: new Date("2024-01-16"), count: 15 },
    ]);

    await pruneAndRollupBadgeShareEvents();
    const rows = await db
      .select()
      .from(badgeShareRollupRunHistoryTable)
      .orderBy(badgeShareRollupRunHistoryTable.id);
    expect(rows).toHaveLength(1);
    const point = rows[0];
    expect(point.currentRawEventCount).toBe(0);
    expect(point.currentAggregateRowCount).toBe(4);
    expect(point.aggregatedEventCount).toBe(100);
    // numeric() comes back as a string — parse before comparing.
    expect(Number(point.savingsPercent)).toBeCloseTo(96, 3);
    expect(Number(point.savingsRatio)).toBeCloseTo(25, 3);

    // Cleanup so later tests aren't polluted.
    await db.delete(badgeShareDailyAggregatesTable).where(eq(badgeShareDailyAggregatesTable.handle, handle));
  });

  it("records null savingsPercent / savingsRatio when no aggregates exist yet", async () => {
    // No raw events, no aggregates → savings KPIs are null (matches
    // the lifetime-KPI empty-state behaviour).
    await db.delete(badgeShareEventsTable);
    await db.delete(badgeShareDailyAggregatesTable);
    await db.delete(badgeShareRollupRunHistoryTable);

    await pruneAndRollupBadgeShareEvents();
    const rows = await db.select().from(badgeShareRollupRunHistoryTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].savingsPercent).toBeNull();
    expect(rows[0].savingsRatio).toBeNull();
    expect(rows[0].aggregatedEventCount).toBe(0);
  });

  it("prunes history rows older than MAX_RUN_HISTORY_AGE_MS so the table stays bounded", async () => {
    await db.delete(badgeShareRollupRunHistoryTable);

    // Seed three points: well outside the retention window, just
    // outside, and a fresh-but-aged point that should survive.
    const farPast = new Date(Date.now() - MAX_RUN_HISTORY_AGE_MS - 10 * 24 * 60 * 60 * 1000);
    const justExpired = new Date(Date.now() - MAX_RUN_HISTORY_AGE_MS - 60 * 1000);
    const stillFresh = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

    await db.insert(badgeShareRollupRunHistoryTable).values([
      { ranAt: farPast, currentRawEventCount: 0, currentAggregateRowCount: 0, aggregatedEventCount: 0 },
      { ranAt: justExpired, currentRawEventCount: 0, currentAggregateRowCount: 0, aggregatedEventCount: 0 },
      { ranAt: stillFresh, currentRawEventCount: 0, currentAggregateRowCount: 0, aggregatedEventCount: 0 },
    ]);

    await pruneAndRollupBadgeShareEvents(); // adds one fresh row + prunes old

    const rows = await db
      .select({ ranAt: badgeShareRollupRunHistoryTable.ranAt })
      .from(badgeShareRollupRunHistoryTable)
      .orderBy(badgeShareRollupRunHistoryTable.ranAt);
    // Both expired points are gone; the fresh seed + the just-inserted
    // history point from the rollup remain.
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.ranAt.getTime()).toBeGreaterThanOrEqual(
        Date.now() - MAX_RUN_HISTORY_AGE_MS,
      );
    }
  });

  it("getBadgeShareRollupAdminSummary returns the last 7 days of points (oldest → newest)", async () => {
    await db.delete(badgeShareRollupRunHistoryTable);

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // Seed a 14-day stretch — 7 in window, 7 out — so we can verify
    // the summary clips to HISTORY_SPARKLINE_DAYS and orders ascending.
    const points: Array<{
      ranAt: Date;
      savingsPercent: string;
      savingsRatio: string;
      currentRawEventCount: number;
      currentAggregateRowCount: number;
      aggregatedEventCount: number;
    }> = [];
    for (let i = 14; i >= 1; i--) {
      points.push({
        ranAt: new Date(now - i * day),
        savingsPercent: (90 + i * 0.1).toFixed(3),
        savingsRatio: (10 + i * 0.1).toFixed(3),
        currentRawEventCount: 0,
        currentAggregateRowCount: 1,
        aggregatedEventCount: 100,
      });
    }
    await db.insert(badgeShareRollupRunHistoryTable).values(points);

    const summary = await getBadgeShareRollupAdminSummary(now);
    expect(summary.historyDays).toBe(HISTORY_SPARKLINE_DAYS);
    // Only the points within the 7-day window are returned.
    expect(summary.history).toHaveLength(HISTORY_SPARKLINE_DAYS);
    // Ordered oldest → newest so the chart can plot left-to-right.
    for (let i = 1; i < summary.history.length; i++) {
      expect(new Date(summary.history[i].ranAt).getTime()).toBeGreaterThanOrEqual(
        new Date(summary.history[i - 1].ranAt).getTime(),
      );
    }
    // numeric() coercion lands the values as plain numbers (not strings).
    for (const p of summary.history) {
      expect(typeof p.savingsPercent).toBe("number");
      expect(typeof p.savingsRatio).toBe("number");
    }
  });

  it("history endpoint surfaces the summary on the super-admin response", async () => {
    await db.delete(badgeShareRollupRunHistoryTable);
    // Seed two distinct points so the summary returns >= 2 — the UI
    // requires this to render the sparkline (a single point isn't a
    // trend).
    await pruneAndRollupBadgeShareEvents();
    await pruneAndRollupBadgeShareEvents();

    const superAdmin: TestUser = {
      id: 9_991_821,
      username: "badge_rollup_history_admin",
      role: "super_admin",
    };
    const app = createTestApp(superAdmin);
    const r = await request(app).get("/api/super-admin/badge-share-rollup/summary");
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty("history");
    expect(r.body).toHaveProperty("historyDays", HISTORY_SPARKLINE_DAYS);
    expect(Array.isArray(r.body.history)).toBe(true);
    expect(r.body.history.length).toBeGreaterThanOrEqual(2);
    for (const p of r.body.history) {
      expect(p).toHaveProperty("ranAt");
      expect(p).toHaveProperty("savingsPercent");
      expect(p).toHaveProperty("savingsRatio");
    }
  });
});
