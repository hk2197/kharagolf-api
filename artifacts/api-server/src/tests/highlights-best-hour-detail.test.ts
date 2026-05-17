/**
 * Regression test: Task #1651 — `/portal/highlights/:id/engagement-hourly`
 * detail endpoint must return 200 with the correct `bestHour` and
 * `bestHourCount` when a reel has engagement events spread across many
 * hours, including under a non-zero `tzOffsetMinutes` window.
 *
 * Background: Task #1377 added a regression test for the gallery list
 * endpoint (GET /api/portal/highlights), which had been 500-ing because
 * of a SQL shape in `fetchBestHours`. The sibling per-reel endpoint
 * GET /api/portal/highlights/:id/engagement-hourly uses a different
 * query (a simple GROUP BY hour/event_type rather than ROW_NUMBER) and
 * was previously uncovered. This test locks down the detail view —
 * both the raw HTTP path and the in-process tiebreak/timezone math —
 * so the producer-facing "Best hour" badge is protected end-to-end on
 * busy reels too.
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
    name: `BestHourDetailOrg_${ts}`,
    slug: `bhd-${ts}`,
    subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgA = oA.id;

  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `bhd-owner-${ts}`,
    username: `bhd_owner_${ts}`,
    email: `bhd_owner_${ts}@test.local`,
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
    title: "Best Hour Detail Reel",
    options: {},
    summary: {},
    status: "ready",
    outputObjectPath: "/objects/test/best-hour-detail.mp4",
  }).returning({ id: highlightReelsTable.id });
  reelIds.push(reel.id);
  return reel.id;
}

/**
 * Build a UTC timestamp at the top of `targetUtcHour` on a recent day.
 * We keep the events well inside the default 30-day trailing window the
 * endpoint uses, but pin to "N days ago" so the test is stable no matter
 * when CI runs it. Minutes are set to :30 so a +/-60 minute timezone
 * shift never crosses an hour boundary by accident.
 */
function atUtcHour(targetUtcHour: number, daysAgo: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(targetUtcHour, 30, 0, 0);
  return d;
}

describe("Task #1651 — /portal/highlights/:id/engagement-hourly bestHour", () => {
  it("returns 200 and the correct bestHour/bestHourCount on a busy reel (tz=0)", async () => {
    const reelId = await seedReel();

    // 5 events at UTC hour 14, 3 at UTC hour 9, 1 at UTC hour 22.
    // tzOffsetMinutes=0, so the local hour == the UTC hour and the
    // computed bestHour should be 14 with bestHourCount=5.
    await db.insert(highlightReelEngagementsTable).values([
      { reelId, organizationId: orgA, userId: userOwner, eventType: "view",       createdAt: atUtcHour(14, 1) },
      { reelId, organizationId: orgA, userId: userOwner, eventType: "view",       createdAt: atUtcHour(14, 2) },
      { reelId, organizationId: orgA, userId: userOwner, eventType: "view",       createdAt: atUtcHour(14, 3) },
      { reelId, organizationId: orgA, userId: userOwner, eventType: "feed_share", createdAt: atUtcHour(14, 4) },
      { reelId, organizationId: orgA, userId: userOwner, eventType: "share",      createdAt: atUtcHour(14, 5) },
      { reelId, organizationId: orgA, userId: userOwner, eventType: "view",       createdAt: atUtcHour(9, 1) },
      { reelId, organizationId: orgA, userId: userOwner, eventType: "view",       createdAt: atUtcHour(9, 2) },
      { reelId, organizationId: orgA, userId: userOwner, eventType: "download",   createdAt: atUtcHour(9, 3) },
      { reelId, organizationId: orgA, userId: userOwner, eventType: "view",       createdAt: atUtcHour(22, 1) },
    ]);

    const app = createTestApp(asUser(userOwner, orgA));
    const res = await request(app).get(
      `/api/portal/highlights/${reelId}/engagement-hourly?tzOffsetMinutes=0`,
    );

    expect(res.status).toBe(200);
    expect(res.body.reelId).toBe(reelId);
    expect(res.body.tzOffsetMinutes).toBe(0);
    expect(Array.isArray(res.body.hourly)).toBe(true);
    expect(res.body.hourly).toHaveLength(24);

    // The bucket at the seeded peak hour should reflect every event type
    // we placed there, and the "best hour" callout should match.
    const peak = res.body.hourly.find((h: { hour: number }) => h.hour === 14);
    expect(peak).toBeDefined();
    expect(peak.view).toBe(3);
    expect(peak.feed_share).toBe(1);
    expect(peak.share).toBe(1);
    expect(peak.total).toBe(5);

    expect(res.body.bestHour).toBe(14);
    expect(res.body.bestHourCount).toBe(5);
  });

  it("respects tzOffsetMinutes when computing bestHour on the detail endpoint", async () => {
    const reelId = await seedReel();

    // 4 events at UTC 23:30 — under a -300-minute offset (UTC-5) those
    // land at local hour 18 (23 - 5 = 18). A separate, smaller cluster
    // at UTC 12:30 lands at local hour 7 and should NOT win, both
    // because it has fewer events and because the bestHour tiebreak in
    // the route picks the later hour anyway.
    await db.insert(highlightReelEngagementsTable).values([
      { reelId, organizationId: orgA, userId: userOwner, eventType: "view", createdAt: atUtcHour(23, 1) },
      { reelId, organizationId: orgA, userId: userOwner, eventType: "view", createdAt: atUtcHour(23, 2) },
      { reelId, organizationId: orgA, userId: userOwner, eventType: "view", createdAt: atUtcHour(23, 3) },
      { reelId, organizationId: orgA, userId: userOwner, eventType: "view", createdAt: atUtcHour(23, 4) },
      { reelId, organizationId: orgA, userId: userOwner, eventType: "view", createdAt: atUtcHour(12, 1) },
      { reelId, organizationId: orgA, userId: userOwner, eventType: "view", createdAt: atUtcHour(12, 2) },
    ]);

    const app = createTestApp(asUser(userOwner, orgA));
    const res = await request(app).get(
      `/api/portal/highlights/${reelId}/engagement-hourly?tzOffsetMinutes=-300`,
    );

    expect(res.status).toBe(200);
    expect(res.body.tzOffsetMinutes).toBe(-300);

    // 23 UTC + (-5h) = 18 local
    expect(res.body.bestHour).toBe(18);
    expect(res.body.bestHourCount).toBe(4);

    const peakLocal = res.body.hourly.find((h: { hour: number }) => h.hour === 18);
    expect(peakLocal).toBeDefined();
    expect(peakLocal.total).toBe(4);

    // 12 UTC + (-5h) = 7 local — populated, but not the winner.
    const morningLocal = res.body.hourly.find((h: { hour: number }) => h.hour === 7);
    expect(morningLocal).toBeDefined();
    expect(morningLocal.total).toBe(2);
  });
});
