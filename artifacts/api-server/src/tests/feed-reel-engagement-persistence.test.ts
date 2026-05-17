/**
 * Task #865 — End-to-end persistence test for the *exact* payloads the
 * web and mobile feed surfaces send when a viewer crosses the 2s
 * playback threshold or re-shares a reel from the feed.
 *
 * The companion client tests
 *   - artifacts/kharagolf-web/src/pages/__tests__/feed-reel-engagement.test.tsx
 *   - artifacts/kharagolf-mobile/__tests__/feed-reel-engagement.test.tsx
 * verify the *wiring* (the right body is constructed and POSTed). This
 * test closes the loop on the other side: it drives the same HTTP
 * request shape against the real Express app + PostgreSQL test DB and
 * asserts that
 *   1. A row landed in `highlight_reel_engagements` with the expected
 *      reel id, user id, event type AND `source` column ("web_feed"
 *      vs "mobile_feed") so producers can break engagement down by
 *      surface.
 *   2. The aggregate counts the response returns reflect the inserted
 *      row (so a regression that silently stops persisting events would
 *      fail here, not just in the unit tests for the route handler).
 *
 * Together with the existing highlight-engagement-types.test.ts file
 * (which covers the route's authz + count aggregation contract in
 * isolation) and the two client tests, this gives end-to-end coverage
 * from "video crossed 2s" → "row in DB" for both surfaces — the gap
 * Task #865 was opened to close.
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
import { and, eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers";

let orgA: number;
let userOwner: number;
let userViewer: number; // a different org member (simulates a feed viewer)
const reelIds: number[] = [];
const feedPostIds: number[] = [];

beforeAll(async () => {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [oA] = await db.insert(organizationsTable).values({
    name: `FeedEngOrg_${ts}`,
    slug: `feedeng-${ts}`,
    subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgA = oA.id;

  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `feedeng-owner-${ts}`,
    username: `feedeng_owner_${ts}`,
    email: `feedowner_${ts}@test.local`,
    displayName: "Reel Owner",
    role: "player",
    organizationId: orgA,
  }).returning({ id: appUsersTable.id });
  userOwner = u1.id;

  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `feedeng-viewer-${ts}`,
    username: `feedeng_viewer_${ts}`,
    email: `feedviewer_${ts}@test.local`,
    displayName: "Feed Viewer",
    role: "player",
    organizationId: orgA,
  }).returning({ id: appUsersTable.id });
  userViewer = u2.id;

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgA, userId: userOwner, role: "player" },
    { organizationId: orgA, userId: userViewer, role: "player" },
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
  for (const u of [userOwner, userViewer].filter(Boolean)) {
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
  if (feedPostIds.length > 0) {
    await db.delete(feedPostsTable).where(inArray(feedPostsTable.id, feedPostIds));
    feedPostIds.length = 0;
  }
});

function asUser(id: number, organizationId: number): TestUser {
  return { id, username: `u${id}`, role: "player", organizationId };
}

async function seedFeedPostedReel(): Promise<number> {
  const [fp] = await db.insert(feedPostsTable).values({
    organizationId: orgA,
    authorUserId: userOwner,
    type: "member_post",
    body: "Reel post",
  }).returning({ id: feedPostsTable.id });
  feedPostIds.push(fp.id);
  const [reel] = await db.insert(highlightReelsTable).values({
    organizationId: orgA,
    userId: userOwner,
    templateId: "classic",
    title: "Feed Engagement Reel",
    options: {},
    summary: {},
    status: "ready",
    outputObjectPath: "/objects/test/feedeng.mp4",
    feedPostId: fp.id,
  }).returning({ id: highlightReelsTable.id });
  reelIds.push(reel.id);
  return reel.id;
}

describe("Task #865 — feed reel engagement pings persist with the right source tag", () => {
  it("web feed view ping: POST {type:'view',source:'web_feed'} inserts a row tagged source=web_feed", async () => {
    const reelId = await seedFeedPostedReel();
    const app = createTestApp(asUser(userViewer, orgA));

    // Same payload artifacts/kharagolf-web/src/pages/feed.tsx fires from
    // the <video onTimeUpdate> handler once currentTime crosses 2s.
    const res = await request(app)
      .post(`/api/portal/highlights/${reelId}/events`)
      .send({ type: "view", source: "web_feed" });
    expect(res.status).toBe(201);
    expect(res.body.viewCount).toBe(1);

    const rows = await db.select().from(highlightReelEngagementsTable)
      .where(and(
        eq(highlightReelEngagementsTable.reelId, reelId),
        eq(highlightReelEngagementsTable.eventType, "view"),
      ));
    expect(rows.length).toBe(1);
    expect(rows[0].userId).toBe(userViewer);
    expect(rows[0].source).toBe("web_feed");
    expect(rows[0].organizationId).toBe(orgA);
  });

  it("web feed share ping: POST {type:'feed_share',source:'web_feed'} inserts a row tagged source=web_feed", async () => {
    const reelId = await seedFeedPostedReel();
    const app = createTestApp(asUser(userViewer, orgA));

    // Same payload the web feed's Share button fires after the
    // navigator.share / clipboard fallback completes.
    const res = await request(app)
      .post(`/api/portal/highlights/${reelId}/events`)
      .send({ type: "feed_share", source: "web_feed" });
    expect(res.status).toBe(201);
    expect(res.body.feedShareCount).toBe(1);

    const rows = await db.select().from(highlightReelEngagementsTable)
      .where(and(
        eq(highlightReelEngagementsTable.reelId, reelId),
        eq(highlightReelEngagementsTable.eventType, "feed_share"),
      ));
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("web_feed");
    expect(rows[0].userId).toBe(userViewer);
  });

  it("mobile feed view ping: POST {type:'view',source:'mobile_feed'} inserts a row tagged source=mobile_feed", async () => {
    const reelId = await seedFeedPostedReel();
    const app = createTestApp(asUser(userViewer, orgA));

    // Same payload artifacts/kharagolf-mobile/app/(tabs)/feed.tsx fires
    // from expo-av's onPlaybackStatusUpdate once positionMillis >= 2000.
    const res = await request(app)
      .post(`/api/portal/highlights/${reelId}/events`)
      .send({ type: "view", source: "mobile_feed" });
    expect(res.status).toBe(201);
    expect(res.body.viewCount).toBe(1);

    const rows = await db.select().from(highlightReelEngagementsTable)
      .where(and(
        eq(highlightReelEngagementsTable.reelId, reelId),
        eq(highlightReelEngagementsTable.eventType, "view"),
      ));
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("mobile_feed");
    expect(rows[0].userId).toBe(userViewer);
  });

  it("mobile feed share ping: POST {type:'feed_share',source:'mobile_feed'} inserts a row tagged source=mobile_feed", async () => {
    const reelId = await seedFeedPostedReel();
    const app = createTestApp(asUser(userViewer, orgA));

    // Same payload the mobile feed's Share button fires once expo-sharing
    // hands the local cache file off to the system share sheet.
    const res = await request(app)
      .post(`/api/portal/highlights/${reelId}/events`)
      .send({ type: "feed_share", source: "mobile_feed" });
    expect(res.status).toBe(201);
    expect(res.body.feedShareCount).toBe(1);

    const rows = await db.select().from(highlightReelEngagementsTable)
      .where(and(
        eq(highlightReelEngagementsTable.reelId, reelId),
        eq(highlightReelEngagementsTable.eventType, "feed_share"),
      ));
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe("mobile_feed");
    expect(rows[0].userId).toBe(userViewer);
  });

  it("a full simulated viewer journey (web view → mobile re-share) leaves two correctly-tagged rows the admin engagement view can read back", async () => {
    const reelId = await seedFeedPostedReel();
    const viewer = createTestApp(asUser(userViewer, orgA));

    // 1. Viewer scrolls past the reel in the web feed and the video
    //    crosses 2s of playback.
    const r1 = await request(viewer)
      .post(`/api/portal/highlights/${reelId}/events`)
      .send({ type: "view", source: "web_feed" });
    expect(r1.status).toBe(201);

    // 2. Same viewer opens the mobile app later, hits Share on the same
    //    feed post, and the system share sheet completes.
    const r2 = await request(viewer)
      .post(`/api/portal/highlights/${reelId}/events`)
      .send({ type: "feed_share", source: "mobile_feed" });
    expect(r2.status).toBe(201);

    // Both rows should be present with the correct surface tagging.
    const rows = await db.select().from(highlightReelEngagementsTable)
      .where(eq(highlightReelEngagementsTable.reelId, reelId));
    expect(rows.length).toBe(2);
    const bySource = Object.fromEntries(rows.map(r => [r.source, r.eventType]));
    expect(bySource).toEqual({ web_feed: "view", mobile_feed: "feed_share" });

    // And the owner-facing detail endpoint surfaces both counts so the
    // engagement dashboard sees them.
    const ownerApp = createTestApp(asUser(userOwner, orgA));
    const detail = await request(ownerApp).get(`/api/portal/highlights/${reelId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.viewCount).toBe(1);
    expect(detail.body.feedShareCount).toBe(1);
  });
});
