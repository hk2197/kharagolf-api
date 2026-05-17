/**
 * Task #1013 — Coverage for the per-reel engagement timeseries endpoint.
 *
 *   GET /api/portal/highlights/:id/engagement-timeseries?days=N
 *
 * The route powers the producer-facing trend chart that lives inside the
 * highlights gallery (web + mobile). Without test coverage the auth rules
 * and bucket shape can drift silently — leaking engagement data across
 * orgs or breaking the chart's stable-width assumption.
 *
 * Asserted contract (matches the comment on the route handler):
 *   1. Owner can fetch.
 *   2. Org admin (different user, same org) can fetch.
 *   3. Unrelated user (different org, no membership) gets 403.
 *   4. `days` query is clamped to [1, 90] (and falls back to 7 when
 *      missing / invalid).
 *   5. Zero buckets are pre-seeded for every day in the window so the
 *      client can render a stable-width chart even before the first
 *      event lands.
 *   6. Counts are bucketed per UTC day per event type.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/highlightQueue.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/highlightQueue.js")>(
    "../lib/highlightQueue.js",
  );
  return { ...actual, enqueueRender: vi.fn(async (_id: number) => {}) };
});

import {
  db,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  highlightReelsTable,
  highlightReelEngagementsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers";

let orgA: number;
let orgB: number;
let userOwner: number;
let userOrgAdmin: number;
let userStranger: number;
const reelIds: number[] = [];

beforeAll(async () => {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [oA] = await db.insert(organizationsTable).values({
    name: `TsOrgA_${ts}`,
    slug: `tsa-${ts}`,
    subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgA = oA.id;

  const [oB] = await db.insert(organizationsTable).values({
    name: `TsOrgB_${ts}`,
    slug: `tsb-${ts}`,
    subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgB = oB.id;

  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `ts-owner-${ts}`,
    username: `ts_owner_${ts}`,
    email: `tsowner_${ts}@test.local`,
    displayName: "Reel Owner",
    role: "player",
    organizationId: orgA,
  }).returning({ id: appUsersTable.id });
  userOwner = u1.id;

  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `ts-admin-${ts}`,
    username: `ts_admin_${ts}`,
    email: `tsadmin_${ts}@test.local`,
    displayName: "Org Admin",
    role: "org_admin",
    organizationId: orgA,
  }).returning({ id: appUsersTable.id });
  userOrgAdmin = u2.id;

  const [u3] = await db.insert(appUsersTable).values({
    replitUserId: `ts-stranger-${ts}`,
    username: `ts_stranger_${ts}`,
    email: `tsstranger_${ts}@test.local`,
    displayName: "Stranger",
    role: "player",
    organizationId: orgB,
  }).returning({ id: appUsersTable.id });
  userStranger = u3.id;

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgA, userId: userOwner, role: "player" },
    { organizationId: orgA, userId: userOrgAdmin, role: "org_admin" },
    { organizationId: orgB, userId: userStranger, role: "player" },
  ]);
});

afterAll(async () => {
  if (reelIds.length > 0) {
    await db.delete(highlightReelEngagementsTable).where(inArray(highlightReelEngagementsTable.reelId, reelIds));
    await db.delete(highlightReelsTable).where(inArray(highlightReelsTable.id, reelIds));
  }
  for (const u of [userOwner, userOrgAdmin, userStranger].filter(Boolean)) {
    await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.userId, u));
    await db.delete(appUsersTable).where(eq(appUsersTable.id, u));
  }
  for (const o of [orgA, orgB].filter(Boolean)) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, o));
  }
});

beforeEach(async () => {
  if (reelIds.length > 0) {
    await db.delete(highlightReelEngagementsTable).where(inArray(highlightReelEngagementsTable.reelId, reelIds));
    await db.delete(highlightReelsTable).where(inArray(highlightReelsTable.id, reelIds));
    reelIds.length = 0;
  }
});

function asUser(id: number, organizationId: number, role = "player"): TestUser {
  return { id, username: `u${id}`, role, organizationId };
}

async function seedReel(): Promise<number> {
  const [reel] = await db.insert(highlightReelsTable).values({
    organizationId: orgA,
    userId: userOwner,
    templateId: "classic",
    title: "Trend Reel",
    options: {},
    summary: {},
    status: "ready",
    outputObjectPath: "/objects/test/trend.mp4",
  }).returning({ id: highlightReelsTable.id });
  reelIds.push(reel.id);
  return reel.id;
}

describe("Task #1013 — GET /portal/highlights/:id/engagement-timeseries", () => {
  it("owner can fetch and gets a series window of length `days`", async () => {
    const reelId = await seedReel();
    const app = createTestApp(asUser(userOwner, orgA));

    const res = await request(app)
      .get(`/api/portal/highlights/${reelId}/engagement-timeseries`)
      .query({ days: 14 });

    expect(res.status).toBe(200);
    expect(res.body.reelId).toBe(reelId);
    expect(res.body.days).toBe(14);
    expect(Array.isArray(res.body.series)).toBe(true);
    expect(res.body.series.length).toBe(14);
  });

  it("an org admin from the same org can fetch", async () => {
    const reelId = await seedReel();
    const app = createTestApp(asUser(userOrgAdmin, orgA, "org_admin"));

    const res = await request(app)
      .get(`/api/portal/highlights/${reelId}/engagement-timeseries`);

    expect(res.status).toBe(200);
    expect(res.body.reelId).toBe(reelId);
  });

  it("an unrelated user from another org gets 403", async () => {
    const reelId = await seedReel();
    const app = createTestApp(asUser(userStranger, orgB));

    const res = await request(app)
      .get(`/api/portal/highlights/${reelId}/engagement-timeseries`);

    expect(res.status).toBe(403);
  });

  it("unauthenticated callers get 401", async () => {
    const reelId = await seedReel();
    const app = createTestApp(); // no user injected

    const res = await request(app)
      .get(`/api/portal/highlights/${reelId}/engagement-timeseries`);

    expect(res.status).toBe(401);
  });

  it("caps `days` at 90 and falls back to the 7-day default when missing, non-positive, or non-numeric", async () => {
    const reelId = await seedReel();
    const app = createTestApp(asUser(userOwner, orgA));

    // Default (no query param) → 7 days.
    const def = await request(app).get(`/api/portal/highlights/${reelId}/engagement-timeseries`);
    expect(def.status).toBe(200);
    expect(def.body.days).toBe(7);
    expect(def.body.series.length).toBe(7);

    // Above the cap → clamped to 90.
    const big = await request(app).get(`/api/portal/highlights/${reelId}/engagement-timeseries?days=500`);
    expect(big.status).toBe(200);
    expect(big.body.days).toBe(90);
    expect(big.body.series.length).toBe(90);

    // Below the floor → clamped to 1.
    const small = await request(app).get(`/api/portal/highlights/${reelId}/engagement-timeseries?days=0`);
    expect(small.status).toBe(200);
    expect(small.body.days).toBe(7); // 0 is non-positive → falls back to default 7
    expect(small.body.series.length).toBe(7);

    // Garbage string → falls back to default 7.
    const junk = await request(app).get(`/api/portal/highlights/${reelId}/engagement-timeseries?days=banana`);
    expect(junk.status).toBe(200);
    expect(junk.body.days).toBe(7);
    expect(junk.body.series.length).toBe(7);
  });

  it("pre-seeds zero buckets for every day in the window even when the reel has no events", async () => {
    const reelId = await seedReel();
    const app = createTestApp(asUser(userOwner, orgA));

    const res = await request(app)
      .get(`/api/portal/highlights/${reelId}/engagement-timeseries?days=5`);
    expect(res.status).toBe(200);

    const series: Array<{ date: string; download: number; share: number; view: number; feed_share: number }>
      = res.body.series;
    expect(series.length).toBe(5);

    // Every bucket has the four count fields, all zero, and a stable shape
    // so the chart can render without null-checks.
    for (const slot of series) {
      expect(slot).toEqual({
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        download: 0,
        share: 0,
        view: 0,
        feed_share: 0,
      });
    }

    // Days are unique and in chronological (ascending) order — the chart
    // relies on this to draw a stable left-to-right axis.
    const dates = series.map(s => s.date);
    expect(new Set(dates).size).toBe(dates.length);
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
  });

  it("buckets real events into the right day + event type", async () => {
    const reelId = await seedReel();

    // Seed two views today, one feed_share yesterday, one share two days
    // ago, plus a download outside the 3-day window we'll query for —
    // the out-of-window row must NOT show up in the response.
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000);
    const tenDaysAgo = new Date(today.getTime() - 10 * 24 * 60 * 60 * 1000);
    await db.insert(highlightReelEngagementsTable).values([
      { reelId, organizationId: orgA, userId: userOwner,    eventType: "view",       createdAt: today },
      { reelId, organizationId: orgA, userId: userOrgAdmin, eventType: "view",       createdAt: today },
      { reelId, organizationId: orgA, userId: userOrgAdmin, eventType: "feed_share", createdAt: yesterday },
      { reelId, organizationId: orgA, userId: userOwner,    eventType: "share",      createdAt: twoDaysAgo },
      { reelId, organizationId: orgA, userId: userOwner,    eventType: "download",   createdAt: tenDaysAgo },
    ]);

    const app = createTestApp(asUser(userOwner, orgA));
    const res = await request(app)
      .get(`/api/portal/highlights/${reelId}/engagement-timeseries?days=3`);
    expect(res.status).toBe(200);

    const series: Array<{ date: string; download: number; share: number; view: number; feed_share: number }>
      = res.body.series;
    expect(series.length).toBe(3);

    // Sum across the window: 2 views, 1 feed_share, 1 share, 0 downloads.
    const totals = series.reduce(
      (acc, s) => ({
        view: acc.view + s.view,
        feed_share: acc.feed_share + s.feed_share,
        share: acc.share + s.share,
        download: acc.download + s.download,
      }),
      { view: 0, feed_share: 0, share: 0, download: 0 },
    );
    expect(totals).toEqual({ view: 2, feed_share: 1, share: 1, download: 0 });

    // The today bucket must carry both views.
    const todayKey = today.toISOString().slice(0, 10);
    const todaySlot = series.find(s => s.date === todayKey);
    expect(todaySlot?.view).toBe(2);
  });

  it("returns 404 for a missing reel and 400 for a non-numeric id", async () => {
    const app = createTestApp(asUser(userOwner, orgA));

    const missing = await request(app)
      .get(`/api/portal/highlights/99999999/engagement-timeseries`);
    expect(missing.status).toBe(404);

    const bad = await request(app)
      .get(`/api/portal/highlights/not-a-number/engagement-timeseries`);
    expect(bad.status).toBe(400);
  });
});
