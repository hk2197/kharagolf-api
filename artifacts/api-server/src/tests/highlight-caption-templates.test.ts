/**
 * Test: Highlight caption-style templates (Task #698).
 *
 * Covers the favorites flow added to `src/routes/highlights.ts`:
 *
 *   • POST /api/portal/highlights/caption-templates
 *       - persists a (pattern, tokenKeys) pair for the caller
 *       - validates that every {token} placeholder has a matching key
 *       - upserts on (userId, pattern) so re-favoriting is a no-op
 *
 *   • GET /api/portal/highlights/caption-templates
 *       - returns the caller's saved templates
 *       - is scoped to the caller (other users' templates are not visible)
 *
 *   • DELETE /api/portal/highlights/caption-templates/:id
 *       - removes the favorite and refuses cross-user deletes
 *
 *   • GET /api/portal/highlights/candidate-media
 *       - now returns `suggestedCaptionTemplates` with isFavorite/templateId
 *         set for any pattern matching a saved template
 *       - applies a saved template's pattern to similar shots so the
 *         player's preferred wording resurfaces on new media
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
  playersTable,
  shotsTable,
  coursesTable,
  holeDetailsTable,
  mediaTable,
  highlightCaptionTemplatesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, uid, type TestUser } from "./helpers";

let orgId: number;
let userIdA: number;
let userIdB: number;
let courseId: number;
let tournamentId: number;
let playerId: number;
const mediaIds: number[] = [];

beforeAll(async () => {
  const ts = uid("hct");
  const [o] = await db.insert(organizationsTable).values({
    name: `HCTOrg_${ts}`, slug: ts, subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgId = o.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `${ts}_a`, username: `${ts}_a`, email: `${ts}_a@t.local`,
    displayName: "P A", role: "player", organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userIdA = u.id;

  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `${ts}_b`, username: `${ts}_b`, email: `${ts}_b@t.local`,
    displayName: "P B", role: "player", organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userIdB = u2.id;

  await db.insert(orgMembershipsTable).values([
    { userId: userIdA, organizationId: orgId, role: "player" },
    { userId: userIdB, organizationId: orgId, role: "player" },
  ]);

  const [c] = await db.insert(coursesTable).values({
    organizationId: orgId, name: `HCTCourse_${ts}`, slug: `hct-${ts}`, holes: 18,
  }).returning({ id: coursesTable.id });
  courseId = c.id;

  // Two holes both par-4 so a pattern saved for hole 5 also applies to hole 7.
  await db.insert(holeDetailsTable).values([
    { courseId, holeNumber: 5, par: 4, yardageWhite: 380 },
    { courseId, holeNumber: 7, par: 4, yardageWhite: 410 },
  ]);

  const [t] = await db.insert(tournamentsTable).values({
    organizationId: orgId, name: `HCTTour_${ts}`, courseId, status: "active",
  }).returning({ id: tournamentsTable.id });
  tournamentId = t.id;

  const [p] = await db.insert(playersTable).values({
    tournamentId, userId: userIdA,
    firstName: "Player", lastName: "A",
    email: `${ts}_a@t.local`,
  }).returning({ id: playersTable.id });
  playerId = p.id;

  // Two tee shots with identical token shape (hole, club, carry).
  await db.insert(shotsTable).values([
    { tournamentId, playerId, round: 1, holeNumber: 5, shotNumber: 1,
      shotType: "tee", club: "7-iron", distanceCarried: "165" },
    { tournamentId, playerId, round: 1, holeNumber: 7, shotNumber: 1,
      shotType: "tee", club: "5-iron", distanceCarried: "190" },
  ]);

  // One media item per hole.
  const m1 = await db.insert(mediaTable).values({
    organizationId: orgId, objectPath: `/objects/${ts}_h5.jpg`, mediaType: "image",
    approved: true, uploadedByUserId: userIdA, tournamentId, holeNumber: 5,
  }).returning({ id: mediaTable.id });
  const m2 = await db.insert(mediaTable).values({
    organizationId: orgId, objectPath: `/objects/${ts}_h7.jpg`, mediaType: "image",
    approved: true, uploadedByUserId: userIdA, tournamentId, holeNumber: 7,
  }).returning({ id: mediaTable.id });
  mediaIds.push(m1[0].id, m2[0].id);
});

beforeEach(async () => {
  // Wipe templates between tests so each starts from a clean slate.
  await db.delete(highlightCaptionTemplatesTable)
    .where(inArray(highlightCaptionTemplatesTable.userId, [userIdA, userIdB]));
});

afterAll(async () => {
  await db.delete(highlightCaptionTemplatesTable)
    .where(inArray(highlightCaptionTemplatesTable.userId, [userIdA, userIdB]));
  if (mediaIds.length) await db.delete(mediaTable).where(inArray(mediaTable.id, mediaIds));
  await db.delete(shotsTable).where(eq(shotsTable.playerId, playerId));
  await db.delete(playersTable).where(eq(playersTable.id, playerId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(holeDetailsTable).where(eq(holeDetailsTable.courseId, courseId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(orgMembershipsTable)
    .where(inArray(orgMembershipsTable.userId, [userIdA, userIdB]));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [userIdA, userIdB]));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

function asUser(id: number): TestUser {
  return { id, username: `u${id}`, role: "player", organizationId: orgId };
}

describe("Highlight caption-style templates (Task #698)", () => {
  it("saves a favorite pattern and rejects bad payloads", async () => {
    const app = createTestApp(asUser(userIdA));

    // 400 — pattern references a token not in tokenKeys.
    const bad = await request(app)
      .post("/api/portal/highlights/caption-templates")
      .send({ pattern: "Hole {hole} · {club}", tokenKeys: ["hole"], sampleCaption: "x" });
    expect(bad.status).toBe(400);

    // Happy path
    const ok = await request(app)
      .post("/api/portal/highlights/caption-templates")
      .send({
        pattern: "Hole {hole} · {club} · {carry}y",
        tokenKeys: ["hole", "club", "carry"],
        sampleCaption: "Hole 5 · 7-iron · 165y",
      });
    expect(ok.status).toBe(201);
    expect(ok.body.template.pattern).toBe("Hole {hole} · {club} · {carry}y");
    expect(ok.body.template.userId).toBe(userIdA);

    // Re-favoriting the same pattern is an upsert, not a duplicate.
    const again = await request(app)
      .post("/api/portal/highlights/caption-templates")
      .send({
        pattern: "Hole {hole} · {club} · {carry}y",
        tokenKeys: ["hole", "club", "carry"],
        sampleCaption: "Hole 5 · 7-iron · 165y",
      });
    expect(again.status).toBe(201);
    expect(again.body.template.id).toBe(ok.body.template.id);
  });

  it("scopes list + delete to the calling user", async () => {
    const appA = createTestApp(asUser(userIdA));
    const appB = createTestApp(asUser(userIdB));

    const created = await request(appA)
      .post("/api/portal/highlights/caption-templates")
      .send({
        pattern: "{hole} - {club}",
        tokenKeys: ["hole", "club"],
        sampleCaption: "5 - 7-iron",
      });
    expect(created.status).toBe(201);
    const tplId = created.body.template.id;

    const listA = await request(appA).get("/api/portal/highlights/caption-templates");
    expect(listA.body.templates.length).toBe(1);

    const listB = await request(appB).get("/api/portal/highlights/caption-templates");
    expect(listB.body.templates.length).toBe(0);

    // B can't delete A's template.
    const delB = await request(appB).delete(`/api/portal/highlights/caption-templates/${tplId}`);
    expect(delB.status).toBe(404);

    const delA = await request(appA).delete(`/api/portal/highlights/caption-templates/${tplId}`);
    expect(delA.status).toBe(200);

    const listA2 = await request(appA).get("/api/portal/highlights/caption-templates");
    expect(listA2.body.templates.length).toBe(0);
  });

  it("applies the saved template to similar shots in candidate-media", async () => {
    const app = createTestApp(asUser(userIdA));

    // Save a non-default style ("Hole {hole} - {club}, {carry} yds").
    const saved = await request(app)
      .post("/api/portal/highlights/caption-templates")
      .send({
        pattern: "Hole {hole} - {club}, {carry} yds",
        tokenKeys: ["hole", "club", "carry"],
        sampleCaption: "Hole 5 - 7-iron, 165 yds",
      });
    expect(saved.status).toBe(201);
    const tplId = saved.body.template.id;

    const r = await request(app)
      .get(`/api/portal/highlights/candidate-media?tournamentId=${tournamentId}`);
    expect(r.status).toBe(200);
    const media: Array<{
      id: number;
      holeNumber: number | null;
      suggestedCaptions: string[];
      suggestedCaptionTemplates: Array<{
        text: string; pattern: string; isFavorite: boolean; templateId: number | null;
      }>;
    }> = r.body.media;

    const hole5 = media.find(m => m.holeNumber === 5)!;
    const hole7 = media.find(m => m.holeNumber === 7)!;
    expect(hole5).toBeTruthy();
    expect(hole7).toBeTruthy();

    // The saved style appears (rendered with the hole's tokens) and is
    // marked as a favorite, on BOTH new shots that share the token shape.
    expect(hole5.suggestedCaptions).toContain("Hole 5 - 7-iron, 165 yds");
    expect(hole7.suggestedCaptions).toContain("Hole 7 - 5-iron, 190 yds");

    const fav5 = hole5.suggestedCaptionTemplates.find(s => s.text === "Hole 5 - 7-iron, 165 yds");
    expect(fav5?.isFavorite).toBe(true);
    expect(fav5?.templateId).toBe(tplId);

    const fav7 = hole7.suggestedCaptionTemplates.find(s => s.text === "Hole 7 - 5-iron, 190 yds");
    expect(fav7?.isFavorite).toBe(true);
    expect(fav7?.templateId).toBe(tplId);
  });
});
