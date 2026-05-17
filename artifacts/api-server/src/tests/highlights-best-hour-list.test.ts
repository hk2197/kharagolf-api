/**
 * Regression test: Task #1377 — `/portal/highlights` list endpoint
 * must not 500 when a reel has engagement events, and must surface the
 * correct `bestHour` for that reel.
 *
 * The bug: `fetchBestHours` previously repeated the EXTRACT(HOUR FROM …)
 * expression inside ROW_NUMBER's ORDER BY. Postgres' planner couldn't
 * always recognise it as the same grouped expression, so the query
 * 500'd the entire list endpoint as soon as any reel had even one
 * engagement row. The fix pre-aggregates per-(reel, hour) totals in an
 * inner subquery and ranks the OUTER projection (`n`, `hour`).
 *
 * This test seeds a single reel with multiple engagement events spread
 * across distinct hours and asserts:
 *   1. GET /api/portal/highlights returns 200 (i.e. did not 500), and
 *   2. the reel's `bestHour` matches the seeded most-active hour.
 *
 * If anyone reverts the inner-subquery rewrite, the list call will 500
 * again and this test will fail at the status assertion.
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
let userOwner: number;
const reelIds: number[] = [];

beforeAll(async () => {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [oA] = await db.insert(organizationsTable).values({
    name: `BestHourOrg_${ts}`,
    slug: `bh-${ts}`,
    subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgA = oA.id;

  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `bh-owner-${ts}`,
    username: `bh_owner_${ts}`,
    email: `bh_owner_${ts}@test.local`,
    displayName: "Owner",
    role: "player",
    organizationId: orgA,
  }).returning({ id: appUsersTable.id });
  userOwner = u1.id;

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgA, userId: userOwner, role: "player" },
  ]);
});

afterAll(async () => {
  if (reelIds.length > 0) {
    await db.delete(highlightReelEngagementsTable).where(inArray(highlightReelEngagementsTable.reelId, reelIds));
    await db.delete(highlightReelsTable).where(inArray(highlightReelsTable.id, reelIds));
  }
  if (userOwner) {
    await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.userId, userOwner));
    await db.delete(appUsersTable).where(eq(appUsersTable.id, userOwner));
  }
  if (orgA) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgA));
});

beforeEach(async () => {
  if (reelIds.length > 0) {
    await db.delete(highlightReelEngagementsTable).where(inArray(highlightReelEngagementsTable.reelId, reelIds));
    await db.delete(highlightReelsTable).where(inArray(highlightReelsTable.id, reelIds));
    reelIds.length = 0;
  }
});

function asUser(id: number, organizationId: number): TestUser {
  return { id, username: `u${id}`, role: "player", organizationId };
}

async function seedReel(): Promise<number> {
  const [reel] = await db.insert(highlightReelsTable).values({
    organizationId: orgA,
    userId: userOwner,
    templateId: "classic",
    title: "Best Hour Reel",
    options: {},
    summary: {},
    status: "ready",
    outputObjectPath: "/objects/test/best-hour.mp4",
  }).returning({ id: highlightReelsTable.id });
  reelIds.push(reel.id);
  return reel.id;
}

/**
 * Build a UTC timestamp for `hoursAgo` hours before `now`, snapped onto
 * the top of the hour at the target UTC hour. We pin to a recent date so
 * the events fall well inside the default 30-day trailing window used by
 * fetchBestHours, but we keep the "hours-ago" framing so this test stays
 * stable no matter when CI runs it.
 */
function atUtcHour(targetUtcHour: number, daysAgo: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(targetUtcHour, 30, 0, 0);
  return d;
}

describe("Task #1377 — /portal/highlights list endpoint with bestHour", () => {
  it("returns 200 and the correct bestHour when a reel has engagements across multiple hours", async () => {
    const reelId = await seedReel();

    // Seed five engagement events at UTC hour 14 and two at UTC hour 9.
    // tzOffsetMinutes defaults to 0 in the request below, so the
    // computed best hour should be 14.
    await db.insert(highlightReelEngagementsTable).values([
      { reelId, organizationId: orgA, userId: userOwner, eventType: "view",       createdAt: atUtcHour(14, 1) },
      { reelId, organizationId: orgA, userId: userOwner, eventType: "view",       createdAt: atUtcHour(14, 2) },
      { reelId, organizationId: orgA, userId: userOwner, eventType: "view",       createdAt: atUtcHour(14, 3) },
      { reelId, organizationId: orgA, userId: userOwner, eventType: "feed_share", createdAt: atUtcHour(14, 4) },
      { reelId, organizationId: orgA, userId: userOwner, eventType: "share",      createdAt: atUtcHour(14, 5) },
      { reelId, organizationId: orgA, userId: userOwner, eventType: "view",       createdAt: atUtcHour(9, 1) },
      { reelId, organizationId: orgA, userId: userOwner, eventType: "download",   createdAt: atUtcHour(9, 2) },
    ]);

    const app = createTestApp(asUser(userOwner, orgA));
    const res = await request(app).get("/api/portal/highlights?tzOffsetMinutes=0");

    // Pre-fix this 500'd as soon as any engagement row existed.
    expect(res.status).toBe(200);

    const reel = res.body.reels.find((r: { id: number }) => r.id === reelId);
    expect(reel).toBeDefined();
    expect(reel.bestHour).toBe(14);
  });

  it("respects tzOffsetMinutes when computing bestHour on the list endpoint", async () => {
    const reelId = await seedReel();

    // Three events at UTC 23:30 — under a +60-minute (UTC+1) offset
    // those land at local hour 0, which is what we expect to surface.
    await db.insert(highlightReelEngagementsTable).values([
      { reelId, organizationId: orgA, userId: userOwner, eventType: "view", createdAt: atUtcHour(23, 1) },
      { reelId, organizationId: orgA, userId: userOwner, eventType: "view", createdAt: atUtcHour(23, 2) },
      { reelId, organizationId: orgA, userId: userOwner, eventType: "view", createdAt: atUtcHour(23, 3) },
      { reelId, organizationId: orgA, userId: userOwner, eventType: "view", createdAt: atUtcHour(10, 1) },
    ]);

    const app = createTestApp(asUser(userOwner, orgA));
    const res = await request(app).get("/api/portal/highlights?tzOffsetMinutes=60");

    expect(res.status).toBe(200);
    const reel = res.body.reels.find((r: { id: number }) => r.id === reelId);
    expect(reel).toBeDefined();
    // 23 UTC + 1h = 24 → 0 local
    expect(reel.bestHour).toBe(0);
  });
});
