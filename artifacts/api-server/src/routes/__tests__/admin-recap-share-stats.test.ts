/**
 * Task #1510 — GET /api/admin/recap-share-stats
 *
 * Org-wide companion to GET /api/portal/me/recap-share-stats (Task #1281).
 * Pins the contract on the admin endpoint that surfaces aggregate counts
 * for hits to the public Year-in-Golf recap endpoints, scoped to the
 * caller's organization, plus a top-N players-by-opens list.
 *
 * Covers:
 *   • 401 when unauthenticated.
 *   • 403 for non-admin roles (player).
 *   • Org admin without an organization gets an empty payload (not 500).
 *   • Totals union raw events + daily aggregates without double counting.
 *   • totalsByAsset / totalsBySource / byPeriod buckets are populated.
 *   • topPlayers is ordered by opens (= non-crawler hits) desc, capped by topN,
 *     and includes the user identifying fields the UI needs.
 *   • topN query param is clamped to 1..50.
 *   • Org admin cannot see counts from another tenant's events.
 *   • Super admin sees the platform-wide totals across both tenants.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import {
  db,
  organizationsTable,
  appUsersTable,
  recapShareEventsTable,
  recapShareDailyAggregatesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "../../tests/helpers.js";

let orgAId: number;
let orgBId: number;
let adminAId: number;
let adminBId: number;
let playerAId: number;
let orphanAdminId: number;
let superAdminId: number;
let userA1Id: number;
let userA2Id: number;
let userA3Id: number;
let userBId: number;

const eventIds: number[] = [];

const Y = 2025;

async function seedRawEvent(opts: {
  userId: number;
  asset: "card_png" | "og";
  period: "year" | "q1" | "q2" | "q3" | "q4";
  source: string;
  count?: number;
  handle?: string;
}): Promise<void> {
  const n = opts.count ?? 1;
  for (let i = 0; i < n; i++) {
    const [r] = await db.insert(recapShareEventsTable).values({
      userId: opts.userId,
      handle: opts.handle ?? `t1510_${opts.userId}`,
      asset: opts.asset,
      period: opts.period,
      year: Y,
      source: opts.source,
    }).returning({ id: recapShareEventsTable.id });
    eventIds.push(r.id);
  }
}

async function seedAggregate(opts: {
  userId: number;
  asset: "card_png" | "og";
  period: "year" | "q1" | "q2" | "q3" | "q4";
  source: string;
  day: Date;
  count: number;
}): Promise<void> {
  await db.insert(recapShareDailyAggregatesTable).values({
    userId: opts.userId,
    asset: opts.asset,
    period: opts.period,
    year: Y,
    source: opts.source,
    day: opts.day,
    count: opts.count,
  });
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [orgA] = await db.insert(organizationsTable).values({
    name: `T1510_A_${stamp}`, slug: `t1510-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `T1510_B_${stamp}`, slug: `t1510-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [adminA] = await db.insert(appUsersTable).values({
    replitUserId: `t1510-admin-a-${stamp}`,
    username: `t1510_admin_a_${stamp}`,
    email: `admin_a_${stamp}@t1510.test`,
    role: "org_admin", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminAId = adminA.id;

  const [adminB] = await db.insert(appUsersTable).values({
    replitUserId: `t1510-admin-b-${stamp}`,
    username: `t1510_admin_b_${stamp}`,
    email: `admin_b_${stamp}@t1510.test`,
    role: "org_admin", organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  adminBId = adminB.id;

  const [playerA] = await db.insert(appUsersTable).values({
    replitUserId: `t1510-player-a-${stamp}`,
    username: `t1510_player_a_${stamp}`,
    email: `player_a_${stamp}@t1510.test`,
    role: "player", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  playerAId = playerA.id;

  const [orphan] = await db.insert(appUsersTable).values({
    replitUserId: `t1510-orphan-${stamp}`,
    username: `t1510_orphan_${stamp}`,
    email: `orphan_${stamp}@t1510.test`,
    role: "org_admin", organizationId: null,
  }).returning({ id: appUsersTable.id });
  orphanAdminId = orphan.id;

  const [superUser] = await db.insert(appUsersTable).values({
    replitUserId: `t1510-super-${stamp}`,
    username: `t1510_super_${stamp}`,
    email: `super_${stamp}@t1510.test`,
    role: "super_admin", organizationId: null,
  }).returning({ id: appUsersTable.id });
  superAdminId = superUser.id;

  // Players whose recap share events / aggregates we'll seed.
  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `t1510-u1-${stamp}`,
    username: `t1510_u1_${stamp}`,
    displayName: "T1510 User One",
    email: `u1_${stamp}@t1510.test`,
    publicHandle: `t1510_handle_u1_${stamp}`,
    role: "player", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  userA1Id = u1.id;

  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `t1510-u2-${stamp}`,
    username: `t1510_u2_${stamp}`,
    displayName: "T1510 User Two",
    email: `u2_${stamp}@t1510.test`,
    publicHandle: `t1510_handle_u2_${stamp}`,
    role: "player", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  userA2Id = u2.id;

  const [u3] = await db.insert(appUsersTable).values({
    replitUserId: `t1510-u3-${stamp}`,
    username: `t1510_u3_${stamp}`,
    displayName: "T1510 User Three",
    email: `u3_${stamp}@t1510.test`,
    publicHandle: `t1510_handle_u3_${stamp}`,
    role: "player", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  userA3Id = u3.id;

  const [uB] = await db.insert(appUsersTable).values({
    replitUserId: `t1510-ub-${stamp}`,
    username: `t1510_ub_${stamp}`,
    displayName: "T1510 OtherOrg",
    email: `ub_${stamp}@t1510.test`,
    publicHandle: `t1510_handle_ub_${stamp}`,
    role: "player", organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  userBId = uB.id;

  // Seed:
  //   user A1 — 5 og copy hits (year, raw) + 3 og crawler hits (year, raw)
  //             → opens 5, total 8
  //   user A2 — 2 card_png web_share hits (q1, raw) + 4 og copy hits (year,
  //             aggregates) → opens 6, total 6
  //   user A3 — 1 card_png native_share hit (q2, raw) → opens 1, total 1
  //   user B  — 10 og copy hits (year, raw) — must NOT show up for adminA
  for (let i = 0; i < 5; i++) {
    await seedRawEvent({ userId: userA1Id, asset: "og", period: "year", source: "copy" });
  }
  for (let i = 0; i < 3; i++) {
    await seedRawEvent({ userId: userA1Id, asset: "og", period: "year", source: "crawler" });
  }
  await seedRawEvent({ userId: userA2Id, asset: "card_png", period: "q1", source: "web_share", count: 2 });
  await seedAggregate({
    userId: userA2Id, asset: "og", period: "year", source: "copy",
    day: new Date("2025-01-01T00:00:00Z"), count: 4,
  });
  await seedRawEvent({ userId: userA3Id, asset: "card_png", period: "q2", source: "native_share" });
  for (let i = 0; i < 10; i++) {
    await seedRawEvent({ userId: userBId, asset: "og", period: "year", source: "copy" });
  }
});

afterAll(async () => {
  if (eventIds.length) {
    await db.delete(recapShareEventsTable)
      .where(inArray(recapShareEventsTable.id, eventIds));
  }
  // The aggregate table is keyed by (user, asset, period, year, source, day).
  // We seeded one row for userA2; clean it up. Using a userId IN (…) delete
  // is safe because the test ids are isolated.
  const testUserIds = [userA1Id, userA2Id, userA3Id, userBId]
    .filter((v): v is number => typeof v === "number");
  if (testUserIds.length) {
    await db.delete(recapShareDailyAggregatesTable)
      .where(inArray(recapShareDailyAggregatesTable.userId, testUserIds));
  }
  const allUsers = [
    adminAId, adminBId, playerAId, orphanAdminId, superAdminId,
    userA1Id, userA2Id, userA3Id, userBId,
  ].filter((v): v is number => typeof v === "number");
  if (allUsers.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, allUsers));
  }
  if (orgAId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgAId));
  if (orgBId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgBId));
});

function asUser(id: number, role: string, organizationId: number | null): TestUser {
  const u: TestUser = { id, username: `u${id}`, role };
  if (organizationId != null) u.organizationId = organizationId;
  return u;
}

function callStats(user: TestUser | undefined, query = "") {
  return request(createTestApp(user)).get(`/api/admin/recap-share-stats${query}`);
}

function callPlayerStats(user: TestUser | undefined, userId: number | string) {
  return request(createTestApp(user)).get(
    `/api/admin/recap-share-stats/player/${userId}`,
  );
}

interface PlayerStatsBody {
  userId: number;
  username: string | null;
  displayName: string | null;
  publicHandle: string | null;
  total: number;
  totalsByAsset: { card_png: number; og: number };
  totalsBySource: {
    copy: number; web_share: number; native_share: number;
    qr_open: number; crawler: number; unknown: number;
  };
  byPeriod: Array<{
    year: number; period: string; total: number;
    byAsset: { card_png: number; og: number };
    bySource: Record<string, number>;
  }>;
}

interface StatsBody {
  scope: "org" | "platform";
  organizationId: number | null;
  total: number;
  totalsByAsset: { card_png: number; og: number };
  totalsBySource: {
    copy: number; web_share: number; native_share: number;
    qr_open: number; crawler: number; unknown: number;
  };
  byPeriod: Array<{
    year: number; period: string; total: number;
    byAsset: { card_png: number; og: number };
    bySource: Record<string, number>;
  }>;
  topPlayers: Array<{
    userId: number;
    username: string | null;
    displayName: string | null;
    publicHandle: string | null;
    total: number;
    opens: number;
    crawlerHits: number;
    crawlerRatio: number;
    crawlerAbuseSuspected: boolean;
  }>;
  topN: number;
  abuseThresholds: { minTotalHits: number; crawlerRatio: number };
}

describe("GET /api/admin/recap-share-stats", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await callStats(undefined);
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin roles", async () => {
    const res = await callStats(asUser(playerAId, "player", orgAId));
    expect(res.status).toBe(403);
  });

  it("returns an empty payload (200) for an org-bound admin without an organization", async () => {
    const res = await callStats(asUser(orphanAdminId, "org_admin", null));
    expect(res.status).toBe(200);
    const body = res.body as StatsBody;
    expect(body.scope).toBe("org");
    expect(body.organizationId).toBeNull();
    expect(body.total).toBe(0);
    expect(body.topPlayers).toEqual([]);
  });

  it("aggregates raw events + daily aggregates for an org admin", async () => {
    const res = await callStats(asUser(adminAId, "org_admin", orgAId));
    expect(res.status).toBe(200);
    const body = res.body as StatsBody;
    expect(body.scope).toBe("org");
    expect(body.organizationId).toBe(orgAId);

    // Org A has: A1 (8) + A2 (6) + A3 (1) = 15 hits in this run.
    // Other org B's 10 og/copy hits must be excluded by tenant scoping.
    expect(body.total).toBeGreaterThanOrEqual(15);

    // og: A1 5 copy + 3 crawler + A2 4 copy = 12. card_png: A2 2 + A3 1 = 3.
    expect(body.totalsByAsset.og).toBeGreaterThanOrEqual(12);
    expect(body.totalsByAsset.card_png).toBeGreaterThanOrEqual(3);

    // Sources we seeded for A.
    expect(body.totalsBySource.copy).toBeGreaterThanOrEqual(9);          // 5 raw + 4 agg
    expect(body.totalsBySource.crawler).toBeGreaterThanOrEqual(3);
    expect(body.totalsBySource.web_share).toBeGreaterThanOrEqual(2);
    expect(body.totalsBySource.native_share).toBeGreaterThanOrEqual(1);

    // byPeriod: at least one entry for (year), q1, q2.
    const yearRow = body.byPeriod.find(p => p.period === "year");
    const q1Row = body.byPeriod.find(p => p.period === "q1");
    const q2Row = body.byPeriod.find(p => p.period === "q2");
    expect(yearRow).toBeDefined();
    expect(q1Row).toBeDefined();
    expect(q2Row).toBeDefined();
    // Year row counts both raw + aggregate og copy hits + crawler.
    expect(yearRow!.total).toBeGreaterThanOrEqual(12);
    expect(q1Row!.byAsset.card_png).toBeGreaterThanOrEqual(2);
    expect(q2Row!.byAsset.card_png).toBeGreaterThanOrEqual(1);
  });

  it("orders topPlayers by opens (excluding crawler hits) and includes identifying fields", async () => {
    const res = await callStats(asUser(adminAId, "org_admin", orgAId));
    expect(res.status).toBe(200);
    const body = res.body as StatsBody;
    expect(body.topPlayers.length).toBeGreaterThanOrEqual(3);

    // Locate our seeded users.
    const a1 = body.topPlayers.find(p => p.userId === userA1Id)!;
    const a2 = body.topPlayers.find(p => p.userId === userA2Id)!;
    const a3 = body.topPlayers.find(p => p.userId === userA3Id)!;
    expect(a1).toBeDefined();
    expect(a2).toBeDefined();
    expect(a3).toBeDefined();

    // Identifying fields the UI needs.
    expect(a1.username).toContain("t1510_u1_");
    expect(a1.displayName).toBe("T1510 User One");
    expect(a1.publicHandle).toContain("t1510_handle_u1_");

    // A1 had 5 opens (copy) + 3 crawler hits → opens 5, total 8.
    expect(a1.opens).toBe(5);
    expect(a1.total).toBe(8);
    // A2 had 2 web_share + 4 copy → opens 6, total 6 (no crawler).
    expect(a2.opens).toBe(6);
    expect(a2.total).toBe(6);
    // A3 had 1 native_share → opens 1, total 1.
    expect(a3.opens).toBe(1);
    expect(a3.total).toBe(1);

    // Task #1867 — every top-N row carries the crawler-only abuse signal.
    // None of the seeded users in this test should trip the flag (their
    // totals are all well below the minTotalHits floor), but the derived
    // ratios still need to be correct.
    expect(a1.crawlerHits).toBe(3);                 // 8 total − 5 opens
    expect(a1.crawlerRatio).toBeCloseTo(3 / 8, 5);
    expect(a1.crawlerAbuseSuspected).toBe(false);   // 8 < 20 floor
    expect(a2.crawlerHits).toBe(0);
    expect(a2.crawlerRatio).toBe(0);
    expect(a2.crawlerAbuseSuspected).toBe(false);
    expect(a3.crawlerHits).toBe(0);
    expect(a3.crawlerRatio).toBe(0);
    expect(a3.crawlerAbuseSuspected).toBe(false);

    // Other-org user B must not appear in adminA's top list.
    expect(body.topPlayers.some(p => p.userId === userBId)).toBe(false);

    // Order by opens desc: A2 (6) before A1 (5) before A3 (1).
    const idx = (id: number) => body.topPlayers.findIndex(p => p.userId === id);
    expect(idx(userA2Id)).toBeLessThan(idx(userA1Id));
    expect(idx(userA1Id)).toBeLessThan(idx(userA3Id));
  });

  it("clamps topN to 1..50", async () => {
    const lo = await callStats(asUser(adminAId, "org_admin", orgAId), "?topN=0");
    expect(lo.status).toBe(200);
    expect((lo.body as StatsBody).topN).toBeGreaterThanOrEqual(1);

    const hi = await callStats(asUser(adminAId, "org_admin", orgAId), "?topN=999");
    expect(hi.status).toBe(200);
    expect((hi.body as StatsBody).topN).toBeLessThanOrEqual(50);

    const cap = await callStats(asUser(adminAId, "org_admin", orgAId), "?topN=2");
    expect(cap.status).toBe(200);
    const body = cap.body as StatsBody;
    expect(body.topN).toBe(2);
    expect(body.topPlayers.length).toBeLessThanOrEqual(2);
  });

  it("scopes org admin's view strictly to their own organization", async () => {
    // Admin in org B should see only their own user's 10 og/copy hits.
    const res = await callStats(asUser(adminBId, "org_admin", orgBId));
    expect(res.status).toBe(200);
    const body = res.body as StatsBody;
    expect(body.organizationId).toBe(orgBId);
    expect(body.totalsByAsset.og).toBeGreaterThanOrEqual(10);
    expect(body.totalsByAsset.card_png).toBe(0);
    // Org A users must be invisible to admin B.
    expect(body.topPlayers.some(p => p.userId === userA1Id)).toBe(false);
    expect(body.topPlayers.some(p => p.userId === userA2Id)).toBe(false);
    expect(body.topPlayers.some(p => p.userId === userA3Id)).toBe(false);
    expect(body.topPlayers.some(p => p.userId === userBId)).toBe(true);
  });

  it("flags top sharers whose hits are mostly link-preview crawlers (Task #1867)", async () => {
    // Seed a "bot" sharer in org B whose traffic is dominated by crawler
    // hits — well above both the ratio (≥80%) and total (≥20) floors —
    // plus a "noisy but legitimate" user whose absolute crawler count is
    // higher but whose ratio stays well under threshold. Only the first
    // user should be flagged.
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const [bot] = await db.insert(appUsersTable).values({
      replitUserId: `t1867-bot-${stamp}`,
      username: `t1867_bot_${stamp}`,
      displayName: "T1867 Bot Suspect",
      email: `bot_${stamp}@t1867.test`,
      publicHandle: `t1867_bot_handle_${stamp}`,
      role: "player",
      organizationId: orgBId,
    }).returning({ id: appUsersTable.id });
    const [legit] = await db.insert(appUsersTable).values({
      replitUserId: `t1867-legit-${stamp}`,
      username: `t1867_legit_${stamp}`,
      displayName: "T1867 Heavy But Legit",
      email: `legit_${stamp}@t1867.test`,
      publicHandle: `t1867_legit_handle_${stamp}`,
      role: "player",
      organizationId: orgBId,
    }).returning({ id: appUsersTable.id });
    try {
      // Bot suspect: 24 crawler + 2 copy → 26 total, 2 opens, ratio ~92%.
      for (let i = 0; i < 24; i++) {
        await seedRawEvent({ userId: bot.id, asset: "og", period: "year", source: "crawler" });
      }
      for (let i = 0; i < 2; i++) {
        await seedRawEvent({ userId: bot.id, asset: "og", period: "year", source: "copy" });
      }
      // Legit-but-noisy: 5 crawler + 25 copy → 30 total, 25 opens, ratio ~17%.
      for (let i = 0; i < 5; i++) {
        await seedRawEvent({ userId: legit.id, asset: "og", period: "year", source: "crawler" });
      }
      for (let i = 0; i < 25; i++) {
        await seedRawEvent({ userId: legit.id, asset: "og", period: "year", source: "copy" });
      }

      const res = await callStats(asUser(adminBId, "org_admin", orgBId), "?topN=50");
      expect(res.status).toBe(200);
      const body = res.body as StatsBody;

      // Thresholds are echoed so the UI can document them inline.
      expect(body.abuseThresholds.minTotalHits).toBeGreaterThan(0);
      expect(body.abuseThresholds.crawlerRatio).toBeGreaterThan(0);
      expect(body.abuseThresholds.crawlerRatio).toBeLessThanOrEqual(1);

      const botRow = body.topPlayers.find(p => p.userId === bot.id);
      const legitRow = body.topPlayers.find(p => p.userId === legit.id);
      expect(botRow).toBeDefined();
      expect(legitRow).toBeDefined();

      // Bot row trips the flag.
      expect(botRow!.total).toBe(26);
      expect(botRow!.opens).toBe(2);
      expect(botRow!.crawlerHits).toBe(24);
      expect(botRow!.crawlerRatio).toBeGreaterThanOrEqual(body.abuseThresholds.crawlerRatio);
      expect(botRow!.crawlerAbuseSuspected).toBe(true);

      // Legit row stays under the ratio floor even with more crawler hits
      // in absolute terms — abuse is about the ratio, not the raw count.
      expect(legitRow!.total).toBe(30);
      expect(legitRow!.opens).toBe(25);
      expect(legitRow!.crawlerHits).toBe(5);
      expect(legitRow!.crawlerRatio).toBeLessThan(body.abuseThresholds.crawlerRatio);
      expect(legitRow!.crawlerAbuseSuspected).toBe(false);
    } finally {
      await db.delete(recapShareEventsTable)
        .where(inArray(recapShareEventsTable.userId, [bot.id, legit.id]));
      await db.delete(appUsersTable)
        .where(inArray(appUsersTable.id, [bot.id, legit.id]));
    }
  });

  it("super admin sees the platform-wide totals across both orgs", async () => {
    const res = await callStats(asUser(superAdminId, "super_admin", null));
    expect(res.status).toBe(200);
    const body = res.body as StatsBody;
    expect(body.scope).toBe("platform");
    expect(body.organizationId).toBeNull();
    // Super admin sees A's 15 + B's 10 = 25 from this test seed (other rows
    // from concurrent tests may add to this, hence >=).
    expect(body.total).toBeGreaterThanOrEqual(25);
    // Both orgs' top sharers must be visible.
    expect(body.topPlayers.some(p => p.userId === userBId)).toBe(true);
    // The org B user has 10 opens (no crawler), the highest of all the
    // seeded users — so they should appear in the platform top list.
    const ub = body.topPlayers.find(p => p.userId === userBId);
    if (ub) expect(ub.opens).toBeGreaterThanOrEqual(10);
  });
});

// Task #1865 — drill-down into one top sharer's per-period / per-source
// breakdown. Mirrors the per-player portal endpoint shape so the admin
// UI can reuse the same chart layout, but with admin-side tenant
// scoping (org admins must not be able to drill into other clubs'
// members).
describe("GET /api/admin/recap-share-stats/player/:userId", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await callPlayerStats(undefined, userA1Id);
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin roles", async () => {
    const res = await callPlayerStats(asUser(playerAId, "player", orgAId), userA1Id);
    expect(res.status).toBe(403);
  });

  it("returns 400 for an invalid :userId", async () => {
    const res = await callPlayerStats(asUser(adminAId, "org_admin", orgAId), "abc");
    expect(res.status).toBe(400);
  });

  it("returns 404 for an org-bound admin without an organization", async () => {
    const res = await callPlayerStats(asUser(orphanAdminId, "org_admin", null), userA1Id);
    expect(res.status).toBe(404);
  });

  it("returns the per-period & per-source breakdown for a member of the caller's org", async () => {
    const res = await callPlayerStats(asUser(adminAId, "org_admin", orgAId), userA1Id);
    expect(res.status).toBe(200);
    const body = res.body as PlayerStatsBody;

    expect(body.userId).toBe(userA1Id);
    expect(body.username).toContain("t1510_u1_");
    expect(body.displayName).toBe("T1510 User One");
    expect(body.publicHandle).toContain("t1510_handle_u1_");

    // A1 was seeded with 5 og copy + 3 og crawler hits, all on `year`.
    expect(body.total).toBe(8);
    expect(body.totalsByAsset.og).toBe(8);
    expect(body.totalsByAsset.card_png).toBe(0);
    expect(body.totalsBySource.copy).toBe(5);
    expect(body.totalsBySource.crawler).toBe(3);
    expect(body.totalsBySource.web_share).toBe(0);

    // Single period bucket: year 2025.
    expect(body.byPeriod.length).toBe(1);
    const yearRow = body.byPeriod.find(p => p.period === "year");
    expect(yearRow).toBeDefined();
    expect(yearRow!.year).toBe(Y);
    expect(yearRow!.total).toBe(8);
    expect(yearRow!.byAsset.og).toBe(8);
    expect(yearRow!.bySource.copy).toBe(5);
    expect(yearRow!.bySource.crawler).toBe(3);
  });

  it("unions raw events + daily aggregates for a member with both", async () => {
    const res = await callPlayerStats(asUser(adminAId, "org_admin", orgAId), userA2Id);
    expect(res.status).toBe(200);
    const body = res.body as PlayerStatsBody;

    // A2 was seeded with 2 card_png/web_share/q1 (raw) + 4 og/copy/year
    // (aggregates) → total 6, two distinct period buckets.
    expect(body.total).toBe(6);
    expect(body.totalsByAsset.card_png).toBe(2);
    expect(body.totalsByAsset.og).toBe(4);
    expect(body.totalsBySource.copy).toBe(4);
    expect(body.totalsBySource.web_share).toBe(2);
    expect(body.totalsBySource.crawler).toBe(0);

    expect(body.byPeriod.length).toBe(2);
    const q1 = body.byPeriod.find(p => p.period === "q1");
    const yr = body.byPeriod.find(p => p.period === "year");
    expect(q1).toBeDefined();
    expect(yr).toBeDefined();
    expect(q1!.byAsset.card_png).toBe(2);
    expect(q1!.bySource.web_share).toBe(2);
    expect(yr!.byAsset.og).toBe(4);
    expect(yr!.bySource.copy).toBe(4);
  });

  it("404s when org admin tries to drill into a different tenant's member", async () => {
    // Admin A asking for a user that lives in org B must get the same
    // 'Player not found' response as if the user did not exist — so the
    // endpoint can't be used to enumerate other clubs' member ids.
    const res = await callPlayerStats(asUser(adminAId, "org_admin", orgAId), userBId);
    expect(res.status).toBe(404);
  });

  it("404s when the target userId does not exist at all", async () => {
    const res = await callPlayerStats(asUser(adminAId, "org_admin", orgAId), 999_999_999);
    expect(res.status).toBe(404);
  });

  it("super admin can drill into any member regardless of tenant", async () => {
    // userBId lives in org B; super admin should be able to see their
    // breakdown without needing to be a member of org B.
    const res = await callPlayerStats(asUser(superAdminId, "super_admin", null), userBId);
    expect(res.status).toBe(200);
    const body = res.body as PlayerStatsBody;
    expect(body.userId).toBe(userBId);
    // userB had 10 og/copy/year hits seeded.
    expect(body.total).toBe(10);
    expect(body.totalsByAsset.og).toBe(10);
    expect(body.totalsBySource.copy).toBe(10);
    const yr = body.byPeriod.find(p => p.period === "year");
    expect(yr).toBeDefined();
    expect(yr!.total).toBe(10);
  });

  it("returns an empty breakdown (200) for a member with no recap activity", async () => {
    // playerAId belongs to org A but had no recap share events seeded.
    const res = await callPlayerStats(asUser(adminAId, "org_admin", orgAId), playerAId);
    expect(res.status).toBe(200);
    const body = res.body as PlayerStatsBody;
    expect(body.userId).toBe(playerAId);
    expect(body.total).toBe(0);
    expect(body.totalsByAsset.card_png).toBe(0);
    expect(body.totalsByAsset.og).toBe(0);
    expect(body.byPeriod).toEqual([]);
  });
});
