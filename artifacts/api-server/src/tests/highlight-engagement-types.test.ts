/**
 * Test: Highlight reel engagement event types — Task #708.
 *
 * Covers the new 'view' and 'feed_share' event types accepted by
 *   POST /api/portal/highlights/:id/events
 * and verifies that aggregate counts (downloadCount, shareCount, viewCount,
 * feedShareCount) surface uniformly on the list, detail, and admin/list
 * endpoints.
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
  feedPostsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers";

let orgA: number;
let userOwner: number;
let userMember: number; // same org, non-owner
const reelIds: number[] = [];

beforeAll(async () => {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [oA] = await db.insert(organizationsTable).values({
    name: `EngOrg_${ts}`,
    slug: `eng-${ts}`,
    subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgA = oA.id;

  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `eng-owner-${ts}`,
    username: `eng_owner_${ts}`,
    email: `owner_${ts}@test.local`,
    displayName: "Owner",
    role: "player",
    organizationId: orgA,
  }).returning({ id: appUsersTable.id });
  userOwner = u1.id;

  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `eng-mem-${ts}`,
    username: `eng_mem_${ts}`,
    email: `mem_${ts}@test.local`,
    displayName: "Member",
    role: "player",
    organizationId: orgA,
  }).returning({ id: appUsersTable.id });
  userMember = u2.id;

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgA, userId: userOwner, role: "player" },
    { organizationId: orgA, userId: userMember, role: "player" },
  ]);
});

afterAll(async () => {
  if (reelIds.length > 0) {
    await db.delete(highlightReelEngagementsTable).where(inArray(highlightReelEngagementsTable.reelId, reelIds));
    await db.delete(highlightReelsTable).where(inArray(highlightReelsTable.id, reelIds));
  }
  if (feedPostIds.length > 0) {
    await db.delete(feedPostsTable).where(inArray(feedPostsTable.id, feedPostIds));
  }
  for (const u of [userOwner, userMember].filter(Boolean)) {
    await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.userId, u));
    await db.delete(appUsersTable).where(eq(appUsersTable.id, u));
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

const feedPostIds: number[] = [];

async function seedReel(opts: { posted?: boolean } = {}): Promise<number> {
  let feedPostId: number | null = null;
  if (opts.posted) {
    const [fp] = await db.insert(feedPostsTable).values({
      organizationId: orgA,
      authorUserId: userOwner,
      type: "member_post",
      body: "Reel post",
    }).returning({ id: feedPostsTable.id });
    feedPostId = fp.id;
    feedPostIds.push(fp.id);
  }
  const [reel] = await db.insert(highlightReelsTable).values({
    organizationId: orgA,
    userId: userOwner,
    templateId: "classic",
    title: "Engagement Reel",
    options: {},
    summary: {},
    status: "ready",
    outputObjectPath: "/objects/test/eng.mp4",
    feedPostId,
  }).returning({ id: highlightReelsTable.id });
  reelIds.push(reel.id);
  return reel.id;
}

describe("Task #708 — highlight reel engagement event types", () => {
  it("accepts the new 'view' event type from any org member when the reel is posted to feed", async () => {
    const reelId = await seedReel({ posted: true });
    const app = createTestApp(asUser(userMember, orgA));

    const res = await request(app)
      .post(`/api/portal/highlights/${reelId}/events`)
      .send({ type: "view", source: "mobile_feed" });
    expect(res.status).toBe(201);
    expect(res.body.viewCount).toBe(1);
    expect(res.body.downloadCount).toBe(0);
    expect(res.body.shareCount).toBe(0);
    expect(res.body.feedShareCount).toBe(0);
  });

  it("accepts the new 'feed_share' event type from any org member when the reel is posted to feed", async () => {
    const reelId = await seedReel({ posted: true });
    const app = createTestApp(asUser(userMember, orgA));

    const res = await request(app)
      .post(`/api/portal/highlights/${reelId}/events`)
      .send({ type: "feed_share", source: "web_feed" });
    expect(res.status).toBe(201);
    expect(res.body.feedShareCount).toBe(1);
    expect(res.body.viewCount).toBe(0);
  });

  it("rejects unknown event types", async () => {
    const reelId = await seedReel({ posted: true });
    const app = createTestApp(asUser(userOwner, orgA));
    const res = await request(app)
      .post(`/api/portal/highlights/${reelId}/events`)
      .send({ type: "bogus" });
    expect(res.status).toBe(400);
  });

  it("rejects 'view' from a non-member when the reel is not posted to feed", async () => {
    const reelId = await seedReel({ posted: false });
    const app = createTestApp(asUser(userMember, orgA));
    const res = await request(app)
      .post(`/api/portal/highlights/${reelId}/events`)
      .send({ type: "view" });
    // non-owner + reel not posted to feed → forbidden
    expect(res.status).toBe(403);
  });

  it("surfaces all four counts on the owner's detail and admin/list endpoints", async () => {
    const reelId = await seedReel({ posted: true });
    await db.insert(highlightReelEngagementsTable).values([
      { reelId, organizationId: orgA, userId: userOwner, eventType: "download" },
      { reelId, organizationId: orgA, userId: userMember, eventType: "view" },
      { reelId, organizationId: orgA, userId: userMember, eventType: "feed_share" },
    ]);

    const ownerApp = createTestApp(asUser(userOwner, orgA));
    const detail = await request(ownerApp).get(`/api/portal/highlights/${reelId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.downloadCount).toBe(1);
    expect(detail.body.shareCount).toBe(0);
    expect(detail.body.viewCount).toBe(1);
    expect(detail.body.feedShareCount).toBe(1);

    const adminApp = createTestApp({ ...asUser(userOwner, orgA), role: "super_admin" });
    const admin = await request(adminApp).get("/api/portal/highlights/admin/list");
    expect(admin.status).toBe(200);
    const adminReel = admin.body.reels.find((r: { id: number }) => r.id === reelId);
    expect(adminReel).toBeDefined();
    expect(adminReel.downloadCount).toBe(1);
    expect(adminReel.viewCount).toBe(1);
    expect(adminReel.feedShareCount).toBe(1);
  });

  it("surfaces all four counts on the owner's list endpoint, deduping repeat same-day views from the same viewer", async () => {
    const reelId = await seedReel({ posted: true });
    // Seed one of each event type directly via db so we don't depend on
    // the route under test. The two userMember 'view' rows below simulate
    // a viewer scrubbing back / reloading the feed in one session — they
    // must collapse to a single view in the surfaced viewCount (Task #864).
    await db.insert(highlightReelEngagementsTable).values([
      { reelId, organizationId: orgA, userId: userOwner, eventType: "download" },
      { reelId, organizationId: orgA, userId: userOwner, eventType: "share" },
      { reelId, organizationId: orgA, userId: userMember, eventType: "view" },
      { reelId, organizationId: orgA, userId: userMember, eventType: "view" },
      { reelId, organizationId: orgA, userId: userMember, eventType: "feed_share" },
    ]);

    const app = createTestApp(asUser(userOwner, orgA));
    const res = await request(app).get("/api/portal/highlights");
    expect(res.status).toBe(200);
    const reel = res.body.reels.find((r: { id: number }) => r.id === reelId);
    expect(reel).toBeDefined();
    expect(reel.downloadCount).toBe(1);
    expect(reel.shareCount).toBe(1);
    // Two raw view rows from the same user on the same day → 1 unique view.
    expect(reel.viewCount).toBe(1);
    expect(reel.feedShareCount).toBe(1);
  });

  it("dedupes view counts per (viewer, day) but keeps distinct viewers and distinct days separate", async () => {
    const reelId = await seedReel({ posted: true });
    // Today: userOwner watches twice, userMember watches three times → 2 unique.
    // Yesterday: userMember watched once → +1 unique.
    // Two days ago: an anonymous (null user_id) view → +1 unique.
    // Grand total surfaced viewCount = 4.
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000);
    await db.insert(highlightReelEngagementsTable).values([
      { reelId, organizationId: orgA, userId: userOwner,  eventType: "view", createdAt: today },
      { reelId, organizationId: orgA, userId: userOwner,  eventType: "view", createdAt: today },
      { reelId, organizationId: orgA, userId: userMember, eventType: "view", createdAt: today },
      { reelId, organizationId: orgA, userId: userMember, eventType: "view", createdAt: today },
      { reelId, organizationId: orgA, userId: userMember, eventType: "view", createdAt: today },
      { reelId, organizationId: orgA, userId: userMember, eventType: "view", createdAt: yesterday },
      { reelId, organizationId: orgA, userId: null,       eventType: "view", createdAt: twoDaysAgo },
    ]);

    // Raw rows must still exist for future analytics — Task #864 acceptance.
    const raw = await db.select().from(highlightReelEngagementsTable)
      .where(eq(highlightReelEngagementsTable.reelId, reelId));
    expect(raw.length).toBe(7);

    const app = createTestApp(asUser(userOwner, orgA));
    const res = await request(app).get(`/api/portal/highlights/${reelId}`);
    expect(res.status).toBe(200);
    expect(res.body.viewCount).toBe(4);
  });
});
