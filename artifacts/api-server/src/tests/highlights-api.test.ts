/**
 * Test: Highlight Reels API — hand-picked clip support (Task #543).
 *
 * Covers the parts of `src/routes/highlights.ts` added/extended to support
 * per-clip selection, per-clip captions, and video clips:
 *
 *   • GET  /api/portal/highlights/candidate-media
 *       - org scoping (cross-org media never appears)
 *       - user scoping (without tournamentId, only caller's own uploads)
 *       - tournament scoping (with tournamentId, the round's media is
 *         returned for every uploader, but only when the tournament
 *         belongs to the caller's org)
 *
 *   • POST /api/portal/highlights with body.options.clips
 *       - clips is stored and order is preserved
 *       - foreign mediaIds (cross-org / not owned and not in the round)
 *         are stripped from the persisted row at the API boundary —
 *         not just dropped at render time
 *       - in mixed sets, valid clips survive in their original order
 *
 *   • PATCH /api/portal/highlights/:id with body.options.clips
 *       - clips overwrites the previous selection (merge semantics: any
 *         keys in `options` are merged over existing options)
 *       - the new clips order is preserved
 *       - foreign mediaIds are stripped on PATCH too
 *
 * The render queue side-effect is stubbed out — these tests do not exercise
 * ffmpeg. See highlight-render-clips.test.ts for renderer coverage.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/highlightQueue.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/highlightQueue.js")>(
    "../lib/highlightQueue.js",
  );
  return {
    ...actual,
    enqueueRender: vi.fn(async (_id: number) => {}),
  };
});

import {
  db,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  tournamentsTable,
  mediaTable,
  highlightReelsTable,
  highlightRenderEventsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers";

let orgA: number;
let orgB: number;
let userA: number;
let userB: number; // a different uploader inside orgA
let userOther: number; // member of orgB
let tournamentA: number;
let tournamentOtherOrg: number;

// Media buckets we'll populate per test
const mediaIds: number[] = [];
const reelIds: number[] = [];

async function seedMedia(values: Partial<typeof mediaTable.$inferInsert>) {
  const [row] = await db.insert(mediaTable).values({
    organizationId: orgA,
    objectPath: `/objects/test/${Math.random().toString(36).slice(2)}.jpg`,
    mediaType: "image",
    approved: true,
    uploadedByUserId: userA,
    ...values,
  } as typeof mediaTable.$inferInsert).returning({ id: mediaTable.id });
  mediaIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [oA] = await db.insert(organizationsTable).values({
    name: `HiClipsOrgA_${ts}`,
    slug: `hi-clips-a-${ts}`,
    subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgA = oA.id;

  const [oB] = await db.insert(organizationsTable).values({
    name: `HiClipsOrgB_${ts}`,
    slug: `hi-clips-b-${ts}`,
  }).returning({ id: organizationsTable.id });
  orgB = oB.id;

  const [uA] = await db.insert(appUsersTable).values({
    replitUserId: `hi-clips-a-${ts}`,
    username: `hi_a_${ts}`,
    email: `a_${ts}@test.local`,
    displayName: "Player A",
    role: "player",
    organizationId: orgA,
  }).returning({ id: appUsersTable.id });
  userA = uA.id;

  const [uB] = await db.insert(appUsersTable).values({
    replitUserId: `hi-clips-b-${ts}`,
    username: `hi_b_${ts}`,
    email: `b_${ts}@test.local`,
    displayName: "Player B",
    role: "player",
    organizationId: orgA,
  }).returning({ id: appUsersTable.id });
  userB = uB.id;

  const [uOther] = await db.insert(appUsersTable).values({
    replitUserId: `hi-clips-other-${ts}`,
    username: `hi_other_${ts}`,
    email: `o_${ts}@test.local`,
    displayName: "Player Other",
    role: "player",
    organizationId: orgB,
  }).returning({ id: appUsersTable.id });
  userOther = uOther.id;

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgA, userId: userA, role: "player" },
    { organizationId: orgA, userId: userB, role: "player" },
    { organizationId: orgB, userId: userOther, role: "player" },
  ]);

  const [tA] = await db.insert(tournamentsTable).values({
    organizationId: orgA, name: `Tournament A ${ts}`,
  }).returning({ id: tournamentsTable.id });
  tournamentA = tA.id;

  const [tO] = await db.insert(tournamentsTable).values({
    organizationId: orgB, name: `Tournament B ${ts}`,
  }).returning({ id: tournamentsTable.id });
  tournamentOtherOrg = tO.id;
});

afterAll(async () => {
  if (reelIds.length > 0) {
    await db.delete(highlightRenderEventsTable).where(inArray(highlightRenderEventsTable.reelId, reelIds));
    await db.delete(highlightReelsTable).where(inArray(highlightReelsTable.id, reelIds));
  }
  if (mediaIds.length > 0) await db.delete(mediaTable).where(inArray(mediaTable.id, mediaIds));
  if (tournamentA) await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentA));
  if (tournamentOtherOrg) await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentOtherOrg));
  for (const u of [userA, userB, userOther].filter(Boolean)) {
    await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.userId, u));
    await db.delete(appUsersTable).where(eq(appUsersTable.id, u));
  }
  if (orgA) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgA));
  if (orgB) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgB));
});

beforeEach(async () => {
  if (reelIds.length > 0) {
    await db.delete(highlightRenderEventsTable).where(inArray(highlightRenderEventsTable.reelId, reelIds));
    await db.delete(highlightReelsTable).where(inArray(highlightReelsTable.id, reelIds));
    reelIds.length = 0;
  }
  if (mediaIds.length > 0) {
    await db.delete(mediaTable).where(inArray(mediaTable.id, mediaIds));
    mediaIds.length = 0;
  }
});

function asUser(id: number, organizationId: number): TestUser {
  return { id, username: `u${id}`, role: "player", organizationId };
}

describe("GET /api/portal/highlights/candidate-media — scoping", () => {
  it("requires authentication", async () => {
    const app = createTestApp();
    const res = await request(app).get("/api/portal/highlights/candidate-media");
    expect(res.status).toBe(401);
  });

  it("without a tournament, returns only the caller's own approved media in their org", async () => {
    const mineImg = await seedMedia({ caption: "mine-img" });
    const mineVid = await seedMedia({ caption: "mine-vid", mediaType: "video" });
    await seedMedia({ caption: "other-user", uploadedByUserId: userB });    // same org, not me
    await seedMedia({ caption: "unapproved", approved: false });             // me, not approved
    await seedMedia({ caption: "cross-org", organizationId: orgB, uploadedByUserId: userA }); // another org

    const app = createTestApp(asUser(userA, orgA));
    const res = await request(app).get("/api/portal/highlights/candidate-media");
    expect(res.status).toBe(200);
    const ids = (res.body.media as Array<{ id: number; caption: string; mediaType: string }>).map(m => m.id);
    expect(ids).toEqual(expect.arrayContaining([mineImg, mineVid]));
    expect(ids).toHaveLength(2);
    // Both photos and videos are surfaced for the editor.
    const types = new Set(res.body.media.map((m: { mediaType: string }) => m.mediaType));
    expect(types).toEqual(new Set(["image", "video"]));
  });

  it("with a valid tournamentId, returns own + the round's media for that tournament", async () => {
    const mine = await seedMedia({ caption: "mine" });
    const mineInRound = await seedMedia({ caption: "mine-in-round", tournamentId: tournamentA });
    const otherInRound = await seedMedia({ caption: "other-in-round", uploadedByUserId: userB, tournamentId: tournamentA });
    await seedMedia({ caption: "wrong-round", uploadedByUserId: userB }); // not in any round, not mine

    const app = createTestApp(asUser(userA, orgA));
    const res = await request(app).get(`/api/portal/highlights/candidate-media?tournamentId=${tournamentA}`);
    expect(res.status).toBe(200);
    const ids = (res.body.media as Array<{ id: number }>).map(m => m.id).sort();
    expect(ids).toEqual([mine, mineInRound, otherInRound].sort());
  });

  it("ignores a tournamentId from another organization (returns own only)", async () => {
    const mine = await seedMedia({ caption: "mine" });
    // Media attached to the other-org tournament — must NEVER appear.
    await seedMedia({ caption: "evil", organizationId: orgB, uploadedByUserId: userOther, tournamentId: tournamentOtherOrg });

    const app = createTestApp(asUser(userA, orgA));
    const res = await request(app).get(`/api/portal/highlights/candidate-media?tournamentId=${tournamentOtherOrg}`);
    expect(res.status).toBe(200);
    const ids = (res.body.media as Array<{ id: number }>).map(m => m.id);
    expect(ids).toEqual([mine]);
  });
});

describe("POST /api/portal/highlights — accepts options.clips", () => {
  it("stores clips verbatim and preserves order", async () => {
    const m1 = await seedMedia({ caption: "first" });
    const m2 = await seedMedia({ caption: "second" });
    const m3 = await seedMedia({ caption: "third" });

    const app = createTestApp(asUser(userA, orgA));
    const clips = [
      { mediaId: m3, caption: "Eagle on 3" },
      { mediaId: m1, caption: "Tee shot" },
      { mediaId: m2 },
    ];
    const res = await request(app).post("/api/portal/highlights").send({
      title: "Picked Order",
      templateId: "classic",
      options: { clips, caption: "the round" },
    });
    expect(res.status).toBe(201);
    reelIds.push(res.body.id);

    const [row] = await db.select().from(highlightReelsTable).where(eq(highlightReelsTable.id, res.body.id));
    const stored = (row.options as { clips?: Array<{ mediaId: number; caption?: string }> }).clips ?? [];
    expect(stored.map(c => c.mediaId)).toEqual([m3, m1, m2]);
    expect(stored[0].caption).toBe("Eagle on 3");
    expect(stored[2].caption).toBeUndefined();
  });

  it("strips foreign mediaIds from options.clips before persisting", async () => {
    // Foreign media: another user, another org. Even if a malicious client
    // guesses the id, the row must NEVER store it.
    const foreign = await seedMedia({
      caption: "stolen",
      organizationId: orgB,
      uploadedByUserId: userOther,
    });

    const app = createTestApp(asUser(userA, orgA));
    const res = await request(app).post("/api/portal/highlights").send({
      title: "Try Steal",
      options: { clips: [{ mediaId: foreign, caption: "nope" }] },
    });
    // The request itself succeeds (we silently drop), but the persisted
    // clips array is empty — the foreign id never reaches storage.
    expect(res.status).toBe(201);
    reelIds.push(res.body.id);
    const [row] = await db.select().from(highlightReelsTable).where(eq(highlightReelsTable.id, res.body.id));
    const stored = (row.options as { clips?: Array<{ mediaId: number }> }).clips ?? [];
    expect(stored).toEqual([]);
  });

  it("in a mixed set, keeps valid clips in order and drops foreign ones", async () => {
    const m1 = await seedMedia({ caption: "mine-1" });
    const m2 = await seedMedia({ caption: "mine-2" });
    const foreign = await seedMedia({
      caption: "stolen",
      organizationId: orgB,
      uploadedByUserId: userOther,
    });
    const ghost = 999_999_999; // doesn't exist at all

    const app = createTestApp(asUser(userA, orgA));
    const res = await request(app).post("/api/portal/highlights").send({
      title: "Mixed",
      options: { clips: [{ mediaId: m2 }, { mediaId: foreign }, { mediaId: m1 }, { mediaId: ghost }] },
    });
    expect(res.status).toBe(201);
    reelIds.push(res.body.id);
    const [row] = await db.select().from(highlightReelsTable).where(eq(highlightReelsTable.id, res.body.id));
    const stored = (row.options as { clips?: Array<{ mediaId: number }> }).clips ?? [];
    // Only the caller's own media survives, in its original relative order.
    expect(stored.map(c => c.mediaId)).toEqual([m2, m1]);
  });

  it("accepts a tournament-mate's round photo as a valid clip (round media is shared)", async () => {
    // Other user uploaded a photo TO our tournament — caller is allowed
    // to include it because round media is shared among the round.
    const sharedRound = await seedMedia({
      caption: "shared",
      uploadedByUserId: userB,
      tournamentId: tournamentA,
    });

    const app = createTestApp(asUser(userA, orgA));
    const res = await request(app).post("/api/portal/highlights").send({
      title: "Round Reel",
      tournamentId: tournamentA,
      options: { clips: [{ mediaId: sharedRound, caption: "Nice shot!" }] },
    });
    expect(res.status).toBe(201);
    reelIds.push(res.body.id);
    const [row] = await db.select().from(highlightReelsTable).where(eq(highlightReelsTable.id, res.body.id));
    const stored = (row.options as { clips?: Array<{ mediaId: number; caption?: string }> }).clips ?? [];
    expect(stored.map(c => c.mediaId)).toEqual([sharedRound]);
    expect(stored[0].caption).toBe("Nice shot!");
  });
});

describe("PATCH /api/portal/highlights/:id — overwrites clips and preserves order", () => {
  it("merges options.clips into the stored options and preserves the new order", async () => {
    const m1 = await seedMedia({ caption: "a" });
    const m2 = await seedMedia({ caption: "b" });
    const m3 = await seedMedia({ caption: "c" });

    const app = createTestApp(asUser(userA, orgA));
    // Create with one ordering
    const created = await request(app).post("/api/portal/highlights").send({
      title: "Edit Me",
      options: { clips: [{ mediaId: m1 }, { mediaId: m2 }], caption: "v1" },
    });
    expect(created.status).toBe(201);
    reelIds.push(created.body.id);

    // Patch with a *different* ordering (and add a 3rd clip)
    const patched = await request(app).patch(`/api/portal/highlights/${created.body.id}`).send({
      options: { clips: [{ mediaId: m3, caption: "wow" }, { mediaId: m1 }, { mediaId: m2 }] },
    });
    expect(patched.status).toBe(200);

    const [row] = await db.select().from(highlightReelsTable).where(eq(highlightReelsTable.id, created.body.id));
    const opts = row.options as { clips?: Array<{ mediaId: number; caption?: string }>; caption?: string };
    expect(opts.clips?.map(c => c.mediaId)).toEqual([m3, m1, m2]);
    expect(opts.clips?.[0].caption).toBe("wow");
    // Pre-existing keys (caption: "v1") survive the merge.
    expect(opts.caption).toBe("v1");
    // Status flipped back to queued for re-render.
    expect(row.status).toBe("queued");
  });

  it("strips foreign mediaIds on PATCH (mixed valid + foreign + ghost)", async () => {
    const m1 = await seedMedia({ caption: "a" });
    const m2 = await seedMedia({ caption: "b" });
    const foreign = await seedMedia({
      caption: "stolen", organizationId: orgB, uploadedByUserId: userOther,
    });

    const app = createTestApp(asUser(userA, orgA));
    const created = await request(app).post("/api/portal/highlights").send({
      options: { clips: [{ mediaId: m1 }] },
    });
    expect(created.status).toBe(201);
    reelIds.push(created.body.id);

    // Try to patch in a foreign id — must be removed; valid ids preserved
    // in their original order.
    const patched = await request(app).patch(`/api/portal/highlights/${created.body.id}`).send({
      options: { clips: [{ mediaId: foreign }, { mediaId: m2 }, { mediaId: 999_999 }, { mediaId: m1 }] },
    });
    expect(patched.status).toBe(200);
    const [row] = await db.select().from(highlightReelsTable).where(eq(highlightReelsTable.id, created.body.id));
    const stored = (row.options as { clips?: Array<{ mediaId: number }> }).clips ?? [];
    expect(stored.map(c => c.mediaId)).toEqual([m2, m1]);
  });

  it("ROUND-TRIP: persists per-clip startSec/durationSec on PATCH for a measured-duration video (Task #1574)", async () => {
    // Create with one trim window, then PATCH with a different one.
    // The persisted row must reflect the latest trim values exactly —
    // before Task #1574 the authorize helper silently stripped these
    // fields and the editor's slider was a no-op.
    const vid = await seedMedia({ mediaType: "video", durationSeconds: 20 });
    const created = await request(createTestApp(asUser(userA, orgA)))
      .post("/api/portal/highlights")
      .send({ options: { clips: [{ mediaId: vid, startSec: 0, durationSec: 5 }] } });
    expect(created.status).toBe(201);
    reelIds.push(created.body.id);

    const patched = await request(createTestApp(asUser(userA, orgA)))
      .patch(`/api/portal/highlights/${created.body.id}`)
      .send({ options: { clips: [{ mediaId: vid, startSec: 4, durationSec: 6 }] } });
    expect(patched.status).toBe(200);

    const [row] = await db.select().from(highlightReelsTable).where(eq(highlightReelsTable.id, created.body.id));
    const stored = (row.options as { clips?: Array<{ mediaId: number; startSec?: number; durationSec?: number }> }).clips ?? [];
    expect(stored).toHaveLength(1);
    expect(stored[0].mediaId).toBe(vid);
    expect(stored[0].startSec).toBe(4);
    expect(stored[0].durationSec).toBe(6);
  });

  it("rejects edits to a reel owned by another user", async () => {
    const m1 = await seedMedia({ caption: "a" });
    const created = await request(createTestApp(asUser(userA, orgA)))
      .post("/api/portal/highlights")
      .send({ options: { clips: [{ mediaId: m1 }] } });
    expect(created.status).toBe(201);
    reelIds.push(created.body.id);

    const evil = await request(createTestApp(asUser(userB, orgA)))
      .patch(`/api/portal/highlights/${created.body.id}`)
      .send({ options: { clips: [] } });
    expect(evil.status).toBe(404);
  });
});
