/**
 * Integration tests for the profile-share rollup (Task #1259).
 *
 * Mirrors `badge-share-events.test.ts`'s rollup block for the sibling
 * `profile_share_events` table. Validates:
 *
 *   pruneAndRollupProfileShareEvents
 *     - rolls events older than the cutoff into per-day aggregates and
 *       deletes them; recent events survive
 *     - re-running the rollup is safe — a second pass on the same
 *       window doesn't drop counts
 *     - persists last-run state (Task #1474)
 *
 *   GET /api/public/p/:handle/share-stats
 *     - returns the same total before and after rollup (raw + aggregate
 *       UNIONed)
 *
 *   GET /api/portal/me/public-profile/share-stats
 *     - returns the same per-method counts before and after rollup
 *
 *   GET /api/organizations/:orgId/analytics/profile-share-leaderboard
 *     - org leaderboard combines raw events with rolled-up aggregates
 *
 *   GET /api/super-admin/profile-share-rollup/summary (Task #1474)
 *     - 401 / 403 / happy-path
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  profileShareEventsTable,
  profileShareDailyAggregatesTable,
  profileShareRollupRunsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";
import {
  pruneAndRollupProfileShareEvents,
  getProfileShareRollupAdminSummary,
  STALE_RUN_WARNING_MS,
} from "../lib/profileShareRollup.js";

let orgId: number;
let ownerId: number;
let owner: TestUser;

const stamp = Date.now();
const handle = `pshareroll${stamp}`;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_ProfileShareRollup_${stamp}`,
    slug: `test-pshareroll-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [a] = await db.insert(appUsersTable).values({
    replitUserId: `pshareroll-a-${stamp}`,
    username: `pshareroll_a_${stamp}`,
    email: `pshareroll_a_${stamp}@example.com`,
    displayName: "Profile Sharer",
    role: "org_admin",
    organizationId: orgId,
    publicHandle: handle,
    publicProfileEnabled: true,
  }).returning({ id: appUsersTable.id });
  ownerId = a.id;

  owner = { id: ownerId, username: `pshareroll_a_${stamp}`, role: "org_admin", organizationId: orgId };
});

afterAll(async () => {
  await db.delete(profileShareEventsTable).where(eq(profileShareEventsTable.userId, ownerId));
  await db.delete(profileShareDailyAggregatesTable).where(eq(profileShareDailyAggregatesTable.userId, ownerId));
  if (ownerId) await db.delete(appUsersTable).where(eq(appUsersTable.id, ownerId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("pruneAndRollupProfileShareEvents (Task #1259)", () => {
  it("rolls events older than the cutoff into per-day aggregates and deletes them", async () => {
    // Clear pre-existing rows for this user so counts are deterministic.
    await db.delete(profileShareEventsTable).where(eq(profileShareEventsTable.userId, ownerId));
    await db.delete(profileShareDailyAggregatesTable).where(eq(profileShareDailyAggregatesTable.userId, ownerId));

    const oldDay1 = new Date("2024-01-15T03:14:00Z");
    const oldDay2 = new Date("2024-01-16T22:00:00Z");
    const recent = new Date(); // very fresh — must NOT be rolled up

    // Two events on day 1 (copy) + one on day 2 (native_share) + one fresh.
    await db.insert(profileShareEventsTable).values([
      { userId: ownerId, handle, method: "copy", source: "web" },
      { userId: ownerId, handle, method: "copy", source: "web" },
      { userId: ownerId, handle, method: "native_share", source: "mobile" },
      { userId: ownerId, handle, method: "copy", source: "web" },
    ]);

    const inserted = await db
      .select({ id: profileShareEventsTable.id })
      .from(profileShareEventsTable)
      .where(eq(profileShareEventsTable.userId, ownerId))
      .orderBy(profileShareEventsTable.id);
    expect(inserted.length).toBe(4);

    await db.update(profileShareEventsTable)
      .set({ createdAt: oldDay1 })
      .where(eq(profileShareEventsTable.id, inserted[0].id));
    await db.update(profileShareEventsTable)
      .set({ createdAt: oldDay1 })
      .where(eq(profileShareEventsTable.id, inserted[1].id));
    await db.update(profileShareEventsTable)
      .set({ createdAt: oldDay2 })
      .where(eq(profileShareEventsTable.id, inserted[2].id));
    await db.update(profileShareEventsTable)
      .set({ createdAt: recent })
      .where(eq(profileShareEventsTable.id, inserted[3].id));

    // Public share-stats returns the total *before* rollup.
    const app = createTestApp();
    const before = await request(app).get(`/api/public/p/${handle}/share-stats`);
    expect(before.status).toBe(200);
    expect(before.body.total).toBe(4);

    const summary = await pruneAndRollupProfileShareEvents();
    expect(summary.rolledUpEvents).toBe(3);
    expect(summary.upsertedAggregateRows).toBeGreaterThanOrEqual(2);

    // Fresh event survives.
    const remaining = await db
      .select({ id: profileShareEventsTable.id })
      .from(profileShareEventsTable)
      .where(eq(profileShareEventsTable.userId, ownerId));
    expect(remaining.length).toBe(1);

    // Aggregate rows reflect the rolled-up counts.
    const aggs = await db
      .select()
      .from(profileShareDailyAggregatesTable)
      .where(eq(profileShareDailyAggregatesTable.userId, ownerId));
    const day1Copy = aggs.find(a => a.method === "copy" && a.day.toISOString().startsWith("2024-01-15"));
    const day2Native = aggs.find(a => a.method === "native_share" && a.day.toISOString().startsWith("2024-01-16"));
    expect(day1Copy?.count).toBe(2);
    expect(day2Native?.count).toBe(1);

    // Public share-stats returns the same total *after* rollup — the
    // raw event survives unchanged and the aggregates make up the rest.
    const after = await request(app).get(`/api/public/p/${handle}/share-stats`);
    expect(after.status).toBe(200);
    expect(after.body.total).toBe(before.body.total);
  });

  it("re-running the rollup is safe — a second pass on the same window doesn't drop counts", async () => {
    // Insert another aged event and run the rollup twice.
    await db.insert(profileShareEventsTable).values({
      userId: ownerId, handle, method: "web_share", source: "web",
    });
    const [{ id }] = await db
      .select({ id: profileShareEventsTable.id })
      .from(profileShareEventsTable)
      .where(sql`${profileShareEventsTable.userId} = ${ownerId} AND ${profileShareEventsTable.method} = 'web_share'`)
      .orderBy(profileShareEventsTable.id);
    await db.update(profileShareEventsTable)
      .set({ createdAt: new Date("2024-02-01T00:00:00Z") })
      .where(eq(profileShareEventsTable.id, id));

    const first = await pruneAndRollupProfileShareEvents();
    expect(first.rolledUpEvents).toBe(1);
    const second = await pruneAndRollupProfileShareEvents();
    expect(second.rolledUpEvents).toBe(0);

    const aggs = await db
      .select()
      .from(profileShareDailyAggregatesTable)
      .where(eq(profileShareDailyAggregatesTable.userId, ownerId));
    const webShareAgg = aggs.find(a => a.method === "web_share" && a.day.toISOString().startsWith("2024-02-01"));
    expect(webShareAgg?.count).toBe(1);
  });

  it("portal share-stats include both raw events and rolled-up aggregates", async () => {
    const app = createTestApp(owner);
    const r = await request(app).get("/api/portal/me/public-profile/share-stats");
    expect(r.status).toBe(200);
    // From the rollup tests above we have:
    //   - aggregates: copy=2, native_share=1, web_share=1
    //   - raw: at least 1 fresh row (copy from the first test)
    expect(r.body.byMethod.copy).toBeGreaterThanOrEqual(3);
    expect(r.body.byMethod.native_share).toBeGreaterThanOrEqual(1);
    expect(r.body.byMethod.web_share).toBeGreaterThanOrEqual(1);
    expect(r.body.total).toBe(
      r.body.byMethod.copy +
      r.body.byMethod.web_share +
      r.body.byMethod.native_share +
      r.body.byMethod.qr_open,
    );
  });

  // Task #1781 — The per-day rollup now preserves `source` so the
  // bySource breakdown stays accurate after old events get archived.
  it("rollup preserves source on aggregate rows so bySource survives pruning", async () => {
    // Reset all state for this user so this block is deterministic
    // regardless of what the prior blocks left behind.
    await db.delete(profileShareEventsTable).where(eq(profileShareEventsTable.userId, ownerId));
    await db.delete(profileShareDailyAggregatesTable).where(eq(profileShareDailyAggregatesTable.userId, ownerId));

    const oldDay = new Date("2024-03-10T12:00:00Z");

    // Aged events: 2 web copy + 1 mobile native_share + 1 untagged copy.
    await db.insert(profileShareEventsTable).values([
      { userId: ownerId, handle, method: "copy", source: "web" },
      { userId: ownerId, handle, method: "copy", source: "web" },
      { userId: ownerId, handle, method: "native_share", source: "mobile" },
      { userId: ownerId, handle, method: "copy", source: null },
    ]);
    const aged = await db
      .select({ id: profileShareEventsTable.id })
      .from(profileShareEventsTable)
      .where(eq(profileShareEventsTable.userId, ownerId))
      .orderBy(profileShareEventsTable.id);
    for (const row of aged) {
      await db.update(profileShareEventsTable)
        .set({ createdAt: oldDay })
        .where(eq(profileShareEventsTable.id, row.id));
    }

    // Snapshot the bySource split BEFORE rollup — every row is still
    // in the raw table so the chips reflect the full split.
    const app = createTestApp(owner);
    const before = await request(app).get("/api/portal/me/public-profile/share-stats");
    expect(before.status).toBe(200);
    expect(before.body.bySource).toEqual({ web: 2, mobile: 1 });
    expect(before.body.total).toBe(4);

    const summary = await pruneAndRollupProfileShareEvents();
    expect(summary.rolledUpEvents).toBe(4);

    // Aggregate rows now carry source — including the sentinel
    // `'unknown'` for the legacy null-source event.
    const aggs = await db
      .select()
      .from(profileShareDailyAggregatesTable)
      .where(eq(profileShareDailyAggregatesTable.userId, ownerId));
    const webCopy = aggs.find(a => a.method === "copy" && a.source === "web");
    const mobileNative = aggs.find(a => a.method === "native_share" && a.source === "mobile");
    const unknownCopy = aggs.find(a => a.method === "copy" && a.source === "unknown");
    expect(webCopy?.count).toBe(2);
    expect(mobileNative?.count).toBe(1);
    expect(unknownCopy?.count).toBe(1);

    // After rollup the raw table is empty for this user — but the
    // bySource split must STILL show 2 web / 1 mobile because the
    // aggregate preserves source. The `'unknown'` sentinel is excluded
    // from the chips, mirroring how legacy null-source raw rows are
    // excluded.
    const after = await request(app).get("/api/portal/me/public-profile/share-stats");
    expect(after.status).toBe(200);
    expect(after.body.total).toBe(4);
    expect(after.body.bySource).toEqual({ web: 2, mobile: 1 });
  });

  // Task #1781 — Mixed raw + aggregate rows must sum correctly into
  // bySource (the read path UNIONs both and excludes legacy/unknown
  // sources from either side).
  it("portal share-stats UNIONs raw + aggregate sources after rollup", async () => {
    // Add a fresh raw event tagged web on top of the aggregate state
    // left behind by the previous block.
    await db.insert(profileShareEventsTable).values({
      userId: ownerId, handle, method: "copy", source: "web",
    });

    const app = createTestApp(owner);
    const r = await request(app).get("/api/portal/me/public-profile/share-stats");
    expect(r.status).toBe(200);
    // Aggregates from the prior block: web=2, mobile=1, unknown=1.
    // Raw: web=1.
    expect(r.body.bySource.web).toBe(3);
    expect(r.body.bySource.mobile).toBe(1);
    expect(r.body.total).toBe(5);
  });

  it("admin profile-share leaderboard combines raw events with rolled-up aggregates", async () => {
    // Seed an aggregate row directly on a day inside the leaderboard's
    // current-year window so we don't have to backdate raw events again.
    await db.insert(profileShareDailyAggregatesTable).values({
      userId: ownerId,
      method: "copy",
      source: "web",
      day: new Date(`${new Date().getUTCFullYear()}-01-15T00:00:00Z`),
      count: 5,
    }).onConflictDoUpdate({
      target: [
        profileShareDailyAggregatesTable.userId,
        profileShareDailyAggregatesTable.method,
        profileShareDailyAggregatesTable.day,
        profileShareDailyAggregatesTable.source,
      ],
      set: { count: sql`${profileShareDailyAggregatesTable.count} + EXCLUDED.count` },
    });
    // Add a fresh raw event so the response covers both sources.
    await db.insert(profileShareEventsTable).values({
      userId: ownerId, handle, method: "copy", source: "web",
    });

    const app = createTestApp(owner);
    const r = await request(app)
      .get(`/api/organizations/${orgId}/analytics/profile-share-leaderboard?period=year`);
    expect(r.status).toBe(200);
    const ownerRow = (r.body.leaderboard as Array<{ userId: number; byMethod: Record<string, number> }>)
      .find(m => m.userId === ownerId);
    expect(ownerRow).toBeDefined();
    // Aggregate (>=5) + at least one fresh raw event = >=6.
    expect(ownerRow!.byMethod.copy).toBeGreaterThanOrEqual(6);
  });
});

// ─── Task #1474 — Super-admin storage-savings panel ─────────────────
//
// Mirrors the badge-share variant from Task #1260: the rollup persists
// its last-run summary so a super-admin endpoint can show ops how much
// it's saving and warn when the cron stops firing.
describe("profile-share rollup last-run state (Task #1474)", () => {
  it("UPSERTs the singleton run row at the end of every successful rollup", async () => {
    const before = Date.now();
    await pruneAndRollupProfileShareEvents();

    const rows = await db.select().from(profileShareRollupRunsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
    // ranAt is set to the rollup's `nowMs`, which defaults to `Date.now()`
    // and is captured *before* the transaction completes.
    expect(rows[0].ranAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(rows[0].ranAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    // A second pass overwrites the same row (no run-history accumulation).
    await pruneAndRollupProfileShareEvents();
    const rowsAfter = await db.select().from(profileShareRollupRunsTable);
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0].ranAt.getTime()).toBeGreaterThanOrEqual(rows[0].ranAt.getTime());
  });

  it("getProfileShareRollupAdminSummary returns last-run state + live row counts", async () => {
    await pruneAndRollupProfileShareEvents();

    const summary = await getProfileShareRollupAdminSummary();
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

    // Task #1474 — savings estimate fields are present and non-negative.
    expect(summary.storageSavings.aggregatedEventCount).toBeGreaterThanOrEqual(0);
    expect(summary.storageSavings.estimatedRowsSaved).toBeGreaterThanOrEqual(0);
    expect(summary.storageSavings.estimatedBytesSaved).toBeGreaterThanOrEqual(0);
    expect(summary.storageSavings.estimatedBytesPerRawRow).toBeGreaterThan(0);
    expect(summary.storageSavings.estimatedRowsSaved).toBe(
      Math.max(
        0,
        summary.storageSavings.aggregatedEventCount - summary.currentAggregateRowCount,
      ),
    );
  });

  it("derives storageSavings.savingsPercent / savingsRatio from the aggregate volume (Task #1817)", async () => {
    // Wipe both tables so the only rows the summary sees come from
    // this test — otherwise other tests' fixtures swamp the math.
    // Mirrors the badge-share variant from Task #1479 so the two
    // panels stay symmetrical.
    await db.delete(profileShareEventsTable);
    await db.delete(profileShareDailyAggregatesTable);

    // Seed: 100 raw events folded into 4 aggregate buckets (100 → 4
    // = 25× compression, 96% smaller). No "still raw" events left.
    await db.insert(profileShareDailyAggregatesTable).values([
      { userId: ownerId, method: "copy", source: "web", day: new Date("2024-01-15"), count: 30 },
      { userId: ownerId, method: "native_share", source: "mobile", day: new Date("2024-01-15"), count: 20 },
      { userId: ownerId, method: "copy", source: "web", day: new Date("2024-01-16"), count: 35 },
      { userId: ownerId, method: "native_share", source: "mobile", day: new Date("2024-01-16"), count: 15 },
    ]);

    const summary = await getProfileShareRollupAdminSummary();
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
    await db
      .delete(profileShareDailyAggregatesTable)
      .where(eq(profileShareDailyAggregatesTable.userId, ownerId));
  });

  it("returns null savings when the rollup has not collapsed any events yet (Task #1817)", async () => {
    // Empty aggregate table — no compression has happened, so the
    // panel should render the "no savings yet" empty state instead
    // of a misleading "0%".
    await db.delete(profileShareEventsTable);
    await db.delete(profileShareDailyAggregatesTable);

    const summary = await getProfileShareRollupAdminSummary();
    expect(summary.storageSavings.aggregatedEventCount).toBe(0);
    expect(summary.storageSavings.savingsPercent).toBeNull();
    expect(summary.storageSavings.savingsRatio).toBeNull();
  });

  it("isStale flips to true when the last run is older than the warning threshold", async () => {
    await pruneAndRollupProfileShareEvents();
    // Backdate the singleton so it falls outside the stale window.
    await db
      .update(profileShareRollupRunsTable)
      .set({ ranAt: new Date(Date.now() - STALE_RUN_WARNING_MS - 60 * 1000) })
      .where(eq(profileShareRollupRunsTable.id, 1));

    const summary = await getProfileShareRollupAdminSummary();
    expect(summary.isStale).toBe(true);
  });

  it("treats a brand-new database (no runs ever) as stale", async () => {
    // Wipe the singleton row and re-query.
    await db.delete(profileShareRollupRunsTable);
    const summary = await getProfileShareRollupAdminSummary();
    expect(summary.lastRun).toBeNull();
    expect(summary.isStale).toBe(true);
  });
});

describe("GET /api/super-admin/profile-share-rollup/summary (Task #1474)", () => {
  it("requires authentication", async () => {
    const app = createTestApp();
    const r = await request(app).get("/api/super-admin/profile-share-rollup/summary");
    expect(r.status).toBe(401);
  });

  it("rejects non-super-admins with 403", async () => {
    const app = createTestApp(owner); // role: "org_admin"
    const r = await request(app).get("/api/super-admin/profile-share-rollup/summary");
    expect(r.status).toBe(403);
  });

  it("returns the admin summary for a super-admin caller", async () => {
    await pruneAndRollupProfileShareEvents();

    const superAdmin: TestUser = {
      id: 9_991_474,
      username: "profile_rollup_admin",
      role: "super_admin",
    };
    const app = createTestApp(superAdmin);
    const r = await request(app).get("/api/super-admin/profile-share-rollup/summary");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      currentRawEventCount: expect.any(Number),
      currentAggregateRowCount: expect.any(Number),
      isStale: expect.any(Boolean),
      staleThresholdMs: STALE_RUN_WARNING_MS,
      rollupAgeMs: expect.any(Number),
      generatedAt: expect.any(String),
      // Task #1474 — byte-level savings estimate.
      // Task #1817 — row-count compression KPIs (savingsPercent / savingsRatio
      // are nullable; assert presence via toHaveProperty below rather than
      // constraining the type here). Mirrors the badge-share endpoint test
      // from Task #1479 so the two panels stay symmetrical.
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
