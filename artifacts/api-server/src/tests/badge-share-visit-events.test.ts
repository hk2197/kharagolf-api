/**
 * Integration tests for the Task #1798 visit-attribution telemetry.
 *
 *   POST /api/public/p/:handle/badge/:type/visit-event
 *     - 404 for unknown handle / unknown badge type / disabled profile
 *     - 201 happy-path: row inserted with handle snapshot, badge type,
 *       and source classified to "web" / "mobile" / "crawler" / "unknown"
 *       based on UA + body
 *
 *   GET  /organizations/:orgId/analytics/badge-share-leaderboard
 *     - exposes per-badge `visits` + per-badge `conversionRate`
 *     - exposes org-wide `totals.visits` + `totals.conversionRate`
 *     - excludes crawler-classified visits from the conversion ratio
 *
 *   GET  /organizations/:orgId/analytics/badge-share-leaderboard/:badgeType
 *     - exposes per-member `visits` + per-member `conversionRate`
 *     - exposes badge-wide `totals.visits` + `totals.conversionRate`
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  badgeShareEventsTable,
  badgeShareDailyAggregatesTable,
  badgeShareVisitEventsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";
import { _resetRateLimiterForTests } from "../lib/publicRateLimit.js";

let orgId: number;
let ownerId: number;
let owner: TestUser;
let admin: TestUser;

const stamp = Date.now();
const handle = `bvisit${stamp}`;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_BadgeVisit_${stamp}`,
    slug: `test-badgevisit-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [a] = await db.insert(appUsersTable).values({
    replitUserId: `bvisit-${stamp}`,
    username: `bvisit_${stamp}`,
    email: `bvisit_${stamp}@example.com`,
    displayName: "Badge Visitee",
    role: "player",
    organizationId: orgId,
    publicHandle: handle,
    publicProfileEnabled: true,
    publicShowAchievements: true,
  }).returning({ id: appUsersTable.id });
  ownerId = a.id;

  owner = { id: ownerId, username: `bvisit_${stamp}`, role: "player", organizationId: orgId };
  admin = {
    id: ownerId,
    username: `bvisit_${stamp}`,
    role: "org_admin",
    organizationId: orgId,
  };
});

afterAll(async () => {
  await db.delete(badgeShareVisitEventsTable).where(eq(badgeShareVisitEventsTable.handle, handle));
  await db.delete(badgeShareEventsTable).where(eq(badgeShareEventsTable.handle, handle));
  await db.delete(badgeShareDailyAggregatesTable).where(eq(badgeShareDailyAggregatesTable.handle, handle));
  if (ownerId) await db.delete(appUsersTable).where(eq(appUsersTable.id, ownerId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("POST /api/public/p/:handle/badge/:type/visit-event (Task #1798)", () => {
  it("returns 404 when the handle does not resolve to a public profile", async () => {
    await _resetRateLimiterForTests();
    const app = createTestApp();
    const r = await request(app)
      .post(`/api/public/p/does-not-exist-${stamp}/badge/first_birdie/visit-event`)
      .set("User-Agent", "Mozilla/5.0")
      .send({ source: "web" });
    expect(r.status).toBe(404);
  });

  it("returns 404 when the badge type is unknown", async () => {
    await _resetRateLimiterForTests();
    const app = createTestApp();
    const r = await request(app)
      .post(`/api/public/p/${handle}/badge/not_a_real_badge/visit-event`)
      .set("User-Agent", "Mozilla/5.0")
      .send({ source: "web" });
    expect(r.status).toBe(404);
  });

  it("inserts a row with source=web on a normal browser User-Agent", async () => {
    await _resetRateLimiterForTests();
    await db.delete(badgeShareVisitEventsTable).where(eq(badgeShareVisitEventsTable.handle, handle));
    const app = createTestApp();
    const r = await request(app)
      .post(`/api/public/p/${handle}/badge/first_birdie/visit-event`)
      .set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Chrome/120")
      .send({ source: "web" });
    expect(r.status).toBe(201);

    const rows = await db.select().from(badgeShareVisitEventsTable)
      .where(eq(badgeShareVisitEventsTable.handle, handle));
    expect(rows).toHaveLength(1);
    expect(rows[0].badgeType).toBe("first_birdie");
    expect(rows[0].source).toBe("web");
  });

  it("classifies known social crawlers as source=crawler regardless of body", async () => {
    await _resetRateLimiterForTests();
    await db.delete(badgeShareVisitEventsTable).where(eq(badgeShareVisitEventsTable.handle, handle));
    const app = createTestApp();
    const r = await request(app)
      .post(`/api/public/p/${handle}/badge/first_birdie/visit-event`)
      .set("User-Agent", "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)")
      .send({ source: "web" }); // body says web — UA must win
    expect(r.status).toBe(201);

    const rows = await db.select().from(badgeShareVisitEventsTable)
      .where(eq(badgeShareVisitEventsTable.handle, handle));
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("crawler");
  });
});

describe("Badge Share Leaderboard with visit attribution (Task #1798)", () => {
  it("surfaces per-badge visits/conversionRate on the org-wide leaderboard and excludes crawler hits", async () => {
    await _resetRateLimiterForTests();
    // Clean slate so counts are deterministic for this test run.
    await db.delete(badgeShareEventsTable).where(eq(badgeShareEventsTable.handle, handle));
    await db.delete(badgeShareDailyAggregatesTable).where(eq(badgeShareDailyAggregatesTable.handle, handle));
    await db.delete(badgeShareVisitEventsTable).where(eq(badgeShareVisitEventsTable.handle, handle));

    // 4 outbound shares of `first_birdie` from this member.
    await db.insert(badgeShareEventsTable).values([
      { handle, badgeType: "first_birdie", method: "copy", source: "web" },
      { handle, badgeType: "first_birdie", method: "copy", source: "web" },
      { handle, badgeType: "first_birdie", method: "web_share", source: "web" },
      { handle, badgeType: "first_birdie", method: "native_share", source: "mobile" },
    ]);
    // 3 human visits + 2 crawler visits attributed to that badge.
    await db.insert(badgeShareVisitEventsTable).values([
      { handle, badgeType: "first_birdie", source: "web" },
      { handle, badgeType: "first_birdie", source: "web" },
      { handle, badgeType: "first_birdie", source: "mobile" },
      { handle, badgeType: "first_birdie", source: "crawler" },
      { handle, badgeType: "first_birdie", source: "crawler" },
    ]);

    const app = createTestApp(admin);
    const r = await request(app)
      .get(`/api/organizations/${orgId}/analytics/badge-share-leaderboard?period=month`);
    expect(r.status).toBe(200);
    expect(r.body.totals.total).toBe(4);
    // 3 human visits — the 2 crawler hits must be excluded from the
    // numerator so the ratio reflects real visitors.
    expect(r.body.totals.visits).toBe(3);
    expect(r.body.totals.conversionRate).toBeCloseTo(3 / 4);
    expect(r.body.totals.visitsBySource).toEqual({
      web: 2,
      mobile: 1,
      crawler: 2,
      unknown: 0,
    });

    const badge = r.body.badges.find((b: { badgeType: string }) => b.badgeType === "first_birdie");
    expect(badge).toBeDefined();
    expect(badge.total).toBe(4);
    expect(badge.visits).toBe(3);
    expect(badge.conversionRate).toBeCloseTo(3 / 4);
    expect(badge.visitsBySource).toEqual({
      web: 2,
      mobile: 1,
      crawler: 2,
      unknown: 0,
    });
  });

  it("surfaces per-member visits/conversionRate on the per-badge drill-down", async () => {
    const app = createTestApp(admin);
    const r = await request(app)
      .get(`/api/organizations/${orgId}/analytics/badge-share-leaderboard/first_birdie?period=month`);
    expect(r.status).toBe(200);
    expect(r.body.totals.total).toBe(4);
    expect(r.body.totals.visits).toBe(3);
    expect(r.body.totals.conversionRate).toBeCloseTo(3 / 4);
    expect(r.body.totals.visitsBySource).toEqual({
      web: 2,
      mobile: 1,
      crawler: 2,
      unknown: 0,
    });

    const member = r.body.members.find((m: { userId: number }) => m.userId === ownerId);
    expect(member).toBeDefined();
    expect(member.total).toBe(4);
    expect(member.visits).toBe(3);
    expect(member.conversionRate).toBeCloseTo(3 / 4);
    expect(member.visitsBySource).toEqual({
      web: 2,
      mobile: 1,
      crawler: 2,
      unknown: 0,
    });
  });

  it("returns conversionRate=null for a badge that has visits but zero shares", async () => {
    await _resetRateLimiterForTests();
    await db.delete(badgeShareEventsTable).where(eq(badgeShareEventsTable.handle, handle));
    await db.delete(badgeShareDailyAggregatesTable).where(eq(badgeShareDailyAggregatesTable.handle, handle));
    await db.delete(badgeShareVisitEventsTable).where(eq(badgeShareVisitEventsTable.handle, handle));
    // Visits without any matching shares — old bookmark, off-platform link.
    await db.insert(badgeShareVisitEventsTable).values([
      { handle, badgeType: "first_eagle", source: "web" },
    ]);

    const app = createTestApp(admin);
    const r = await request(app)
      .get(`/api/organizations/${orgId}/analytics/badge-share-leaderboard?period=month`);
    expect(r.status).toBe(200);
    const badge = r.body.badges.find((b: { badgeType: string }) => b.badgeType === "first_eagle");
    expect(badge).toBeDefined();
    expect(badge.total).toBe(0);
    expect(badge.visits).toBe(1);
    expect(badge.conversionRate).toBeNull();
  });
});
