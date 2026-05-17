/**
 * Task #1184 — Coverage for the producer-facing sort param on
 *
 *   GET /api/portal/highlights?sort=recent|top|reshared
 *
 * The sort branch (around line 815 of routes/highlights.ts) is what powers
 * the "Top performing" / "Most re-shared" toggles in the web + mobile
 * highlights gallery. Without test coverage a regression in either the
 * param parsing, the engagement totalling, or the tie-break would silently
 * scramble the producer's gallery.
 *
 * Asserted contract:
 *   1. `sort=recent` (and the default with no param) returns reels in
 *      created-at descending order — newest first.
 *   2. `sort=top` returns reels in *total engagement* desc
 *      (view + feed_share + share + download), with createdAt-desc as
 *      the documented tie-break.
 *   3. `sort=reshared` (and the alias `feed_share`) returns reels in
 *      feedShareCount desc with createdAt-desc as the tie-break.
 *   4. Response carries the resolved `sort` value back so the client can
 *      sync UI state with what the server actually applied (including
 *      alias normalization).
 *   5. Unknown `sort` values silently fall back to `recent` rather than
 *      400-ing — keeps the producer's gallery resilient to typos in
 *      saved deep-links.
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
    name: `SortOrg_${ts}`,
    slug: `sort-${ts}`,
    subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgA = oA.id;

  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `sort-owner-${ts}`,
    username: `sort_owner_${ts}`,
    email: `sort_${ts}@test.local`,
    displayName: "Reel Owner",
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

async function seedReel(title: string, createdAt: Date): Promise<number> {
  const [reel] = await db.insert(highlightReelsTable).values({
    organizationId: orgA,
    userId: userOwner,
    templateId: "classic",
    title,
    options: {},
    summary: {},
    status: "ready",
    outputObjectPath: "/objects/test/sort.mp4",
    createdAt,
    updatedAt: createdAt,
  }).returning({ id: highlightReelsTable.id });
  reelIds.push(reel.id);
  return reel.id;
}

/** Insert N raw event rows for the given reel + event type. We bypass
 * the API on purpose so the seed data can't be coupled to the auth /
 * dedup rules of POST /events. The list endpoint is what's under test
 * here — it consumes raw rows. */
async function seedEvents(
  reelId: number,
  spec: { download?: number; share?: number; feedShare?: number },
) {
  const rows: Array<typeof highlightReelEngagementsTable.$inferInsert> = [];
  for (let i = 0; i < (spec.download ?? 0); i++) {
    rows.push({ reelId, organizationId: orgA, userId: userOwner, eventType: "download" });
  }
  for (let i = 0; i < (spec.share ?? 0); i++) {
    rows.push({ reelId, organizationId: orgA, userId: userOwner, eventType: "share" });
  }
  for (let i = 0; i < (spec.feedShare ?? 0); i++) {
    rows.push({ reelId, organizationId: orgA, userId: userOwner, eventType: "feed_share" });
  }
  if (rows.length > 0) {
    await db.insert(highlightReelEngagementsTable).values(rows);
  }
}

/** Seed 3 reels chosen so that each sort produces a distinct, unambiguous
 * order. We deliberately avoid `view` events so the per-(viewer, day)
 * dedup in fetchEngagementCounts can't perturb the totals — this test is
 * about the sort order, not about view dedup (which has its own
 * dedicated test at highlight-engagement-types.test.ts).
 *
 *   reelA — oldest. download=5, share=0, feedShare=0 → total=5, reshare=0
 *   reelB — middle. download=0, share=0, feedShare=10 → total=10, reshare=10
 *   reelC — newest. download=2, share=2, feedShare=1 → total=5, reshare=1
 *
 * Expected orderings:
 *   recent   → [C, B, A]    (newest first)
 *   top      → [B, C, A]    (10, then 5+5 with createdAt-desc tie-break → C before A)
 *   reshared → [B, C, A]    (10, 1, 0)
 */
async function seedThreeReels() {
  const now = Date.now();
  const reelA = await seedReel("Reel A (oldest)",  new Date(now - 3 * 60 * 60 * 1000));
  const reelB = await seedReel("Reel B (middle)",  new Date(now - 2 * 60 * 60 * 1000));
  const reelC = await seedReel("Reel C (newest)",  new Date(now - 1 * 60 * 60 * 1000));
  await seedEvents(reelA, { download: 5 });
  await seedEvents(reelB, { feedShare: 10 });
  await seedEvents(reelC, { download: 2, share: 2, feedShare: 1 });
  return { reelA, reelB, reelC };
}

describe("Task #1184 — GET /portal/highlights?sort", () => {
  it("default (no param) and ?sort=recent both return reels newest-first", async () => {
    const { reelA, reelB, reelC } = await seedThreeReels();
    const app = createTestApp(asUser(userOwner, orgA));

    for (const url of ["/api/portal/highlights", "/api/portal/highlights?sort=recent"]) {
      const res = await request(app).get(url);
      expect(res.status).toBe(200);
      expect(res.body.sort).toBe("recent");
      const ids = res.body.reels.map((r: { id: number }) => r.id);
      expect(ids).toEqual([reelC, reelB, reelA]);
    }
  });

  it("?sort=top orders by total engagement (view + feed_share + share + download) desc, with createdAt desc as the tie-break", async () => {
    const { reelA, reelB, reelC } = await seedThreeReels();
    const app = createTestApp(asUser(userOwner, orgA));

    const res = await request(app).get("/api/portal/highlights?sort=top");
    expect(res.status).toBe(200);
    expect(res.body.sort).toBe("top");

    const ids = res.body.reels.map((r: { id: number }) => r.id);
    // B(10) > C(5, newer) > A(5, older) — note the tie between C and A
    // is broken in favor of the more recently-created reel.
    expect(ids).toEqual([reelB, reelC, reelA]);

    // Sanity-check the engagement counts the API surfaced match what we
    // seeded — a regression in fetchEngagementCounts would change the
    // sort outcome.
    const byId = new Map<number, { downloadCount: number; shareCount: number; feedShareCount: number; viewCount: number }>(
      res.body.reels.map((r: { id: number; downloadCount: number; shareCount: number; feedShareCount: number; viewCount: number }) =>
        [r.id, r]),
    );
    expect(byId.get(reelA)).toMatchObject({ downloadCount: 5, shareCount: 0, feedShareCount: 0, viewCount: 0 });
    expect(byId.get(reelB)).toMatchObject({ downloadCount: 0, shareCount: 0, feedShareCount: 10, viewCount: 0 });
    expect(byId.get(reelC)).toMatchObject({ downloadCount: 2, shareCount: 2, feedShareCount: 1, viewCount: 0 });
  });

  it("?sort=reshared orders by feedShareCount desc, with createdAt desc as the tie-break", async () => {
    const { reelA, reelB, reelC } = await seedThreeReels();
    const app = createTestApp(asUser(userOwner, orgA));

    const res = await request(app).get("/api/portal/highlights?sort=reshared");
    expect(res.status).toBe(200);
    expect(res.body.sort).toBe("reshared");

    const ids = res.body.reels.map((r: { id: number }) => r.id);
    // B(10) > C(1) > A(0)
    expect(ids).toEqual([reelB, reelC, reelA]);
  });

  it("accepts the alias `?sort=feed_share` and normalizes it to reshared", async () => {
    const { reelA, reelB, reelC } = await seedThreeReels();
    const app = createTestApp(asUser(userOwner, orgA));

    const res = await request(app).get("/api/portal/highlights?sort=feed_share");
    expect(res.status).toBe(200);
    expect(res.body.sort).toBe("reshared");
    const ids = res.body.reels.map((r: { id: number }) => r.id);
    expect(ids).toEqual([reelB, reelC, reelA]);
  });

  it("accepts the alias `?sort=engagement` and normalizes it to top", async () => {
    const { reelA, reelB, reelC } = await seedThreeReels();
    const app = createTestApp(asUser(userOwner, orgA));

    const res = await request(app).get("/api/portal/highlights?sort=engagement");
    expect(res.status).toBe(200);
    expect(res.body.sort).toBe("top");
    const ids = res.body.reels.map((r: { id: number }) => r.id);
    expect(ids).toEqual([reelB, reelC, reelA]);
  });

  it("falls back to recent for unknown sort values rather than 400-ing", async () => {
    const { reelA, reelB, reelC } = await seedThreeReels();
    const app = createTestApp(asUser(userOwner, orgA));

    const res = await request(app).get("/api/portal/highlights?sort=banana");
    expect(res.status).toBe(200);
    expect(res.body.sort).toBe("recent");
    const ids = res.body.reels.map((r: { id: number }) => r.id);
    expect(ids).toEqual([reelC, reelB, reelA]);
  });

  it("?sort=top with no engagement events at all keeps the natural recency order (createdAt desc tie-break)", async () => {
    // All three reels have zero engagement — the sort by total is a 0/0/0
    // tie, so the createdAt-desc tie-break must take over and the result
    // is identical to ?sort=recent.
    const now = Date.now();
    const reelA = await seedReel("ZeroA", new Date(now - 3 * 60 * 60 * 1000));
    const reelB = await seedReel("ZeroB", new Date(now - 2 * 60 * 60 * 1000));
    const reelC = await seedReel("ZeroC", new Date(now - 1 * 60 * 60 * 1000));

    const app = createTestApp(asUser(userOwner, orgA));
    const res = await request(app).get("/api/portal/highlights?sort=top");
    expect(res.status).toBe(200);
    const ids = res.body.reels.map((r: { id: number }) => r.id);
    expect(ids).toEqual([reelC, reelB, reelA]);
  });
});
