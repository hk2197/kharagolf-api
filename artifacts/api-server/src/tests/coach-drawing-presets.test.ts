/**
 * Task #2131 — verify the new persistent drawing-preset library routes
 * under /api/swing-reviews/coach/drawing-presets behave the way the
 * coach UI expects:
 *
 *   • A signed-in coach can save a named preset of the current
 *     selection, list their library, rename a preset, and delete one.
 *   • The library is scoped per coach: Coach A cannot read, rename or
 *     delete Coach B's presets.
 *   • Anonymous and non-coach callers get 401 / 403.
 *   • Validation rejects empty names, oversized names, empty drawings,
 *     and arrays past the per-preset shape cap.
 *   • Listing returns the most-recently-updated preset first so the
 *     picker surfaces the coach's last-touched library entry on top.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  teachingProsTable,
  coachDrawingPresetsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let orgId: number;
let coachAUserId: number;
let coachBUserId: number;
let nonCoachUserId: number;
let coachAProId: number;
let coachBProId: number;

let coachA: TestUser;
let coachB: TestUser;
let nonCoach: TestUser;
let appAsCoachA: ReturnType<typeof createTestApp>;
let appAsCoachB: ReturnType<typeof createTestApp>;
let appAsNonCoach: ReturnType<typeof createTestApp>;
let appAnonymous: ReturnType<typeof createTestApp>;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `DrawingPresetsTest_${stamp}`,
    slug: `drawing-presets-test-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [a] = await db.insert(appUsersTable).values({
    replitUserId: `presets-coach-a-${stamp}`,
    username: `presets_coach_a_${stamp}`,
    email: `presets_a_${stamp}@example.com`,
    displayName: "Coach A",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  coachAUserId = a.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: coachAUserId, role: "player",
  });

  const [b] = await db.insert(appUsersTable).values({
    replitUserId: `presets-coach-b-${stamp}`,
    username: `presets_coach_b_${stamp}`,
    email: `presets_b_${stamp}@example.com`,
    displayName: "Coach B",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  coachBUserId = b.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: coachBUserId, role: "player",
  });

  const [n] = await db.insert(appUsersTable).values({
    replitUserId: `presets-noncoach-${stamp}`,
    username: `presets_noncoach_${stamp}`,
    email: `presets_n_${stamp}@example.com`,
    displayName: "Member",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  nonCoachUserId = n.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: nonCoachUserId, role: "player",
  });

  const [proA] = await db.insert(teachingProsTable).values({
    organizationId: orgId, userId: coachAUserId, displayName: "Coach A",
  }).returning({ id: teachingProsTable.id });
  coachAProId = proA.id;
  const [proB] = await db.insert(teachingProsTable).values({
    organizationId: orgId, userId: coachBUserId, displayName: "Coach B",
  }).returning({ id: teachingProsTable.id });
  coachBProId = proB.id;

  coachA = { id: coachAUserId, username: `presets_coach_a_${stamp}`, role: "player", organizationId: orgId };
  coachB = { id: coachBUserId, username: `presets_coach_b_${stamp}`, role: "player", organizationId: orgId };
  nonCoach = { id: nonCoachUserId, username: `presets_noncoach_${stamp}`, role: "player", organizationId: orgId };
  appAsCoachA = createTestApp(coachA);
  appAsCoachB = createTestApp(coachB);
  appAsNonCoach = createTestApp(nonCoach);
  appAnonymous = createTestApp();
});

beforeEach(async () => {
  // Wipe presets between tests so library-cap / ordering checks don't
  // leak state across cases.
  await db.delete(coachDrawingPresetsTable)
    .where(inArray(coachDrawingPresetsTable.proId, [coachAProId, coachBProId]));
});

afterAll(async () => {
  await db.delete(coachDrawingPresetsTable)
    .where(inArray(coachDrawingPresetsTable.proId, [coachAProId, coachBProId]));
  await db.delete(teachingProsTable).where(inArray(teachingProsTable.id, [coachAProId, coachBProId]));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, orgId));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [coachAUserId, coachBUserId, nonCoachUserId]));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

const drawingsFixture = [
  { kind: "line", t: 0.5, x1: 10, y1: 20, x2: 100, y2: 200, color: "#FFD700" },
  { kind: "circle", t: 1.2, x: 50, y: 60, r: 12, color: "#FF6666" },
];

describe("Task #2131 — coach drawing presets API", () => {
  it("a coach can save and list a preset", async () => {
    const create = await request(appAsCoachA)
      .post("/api/swing-reviews/coach/drawing-presets")
      .send({ name: "Setup checkpoints", drawings: drawingsFixture });
    expect(create.status).toBe(200);
    expect(create.body.success).toBe(true);
    expect(create.body.preset.name).toBe("Setup checkpoints");
    expect(create.body.preset.proId).toBe(coachAProId);
    expect(create.body.preset.drawings).toEqual(drawingsFixture);

    const list = await request(appAsCoachA).get("/api/swing-reviews/coach/drawing-presets");
    expect(list.status).toBe(200);
    expect(list.body.presets).toHaveLength(1);
    expect(list.body.presets[0].name).toBe("Setup checkpoints");
  });

  it("trims whitespace and rejects empty / oversized names", async () => {
    const trim = await request(appAsCoachA)
      .post("/api/swing-reviews/coach/drawing-presets")
      .send({ name: "   Tempo bars   ", drawings: drawingsFixture });
    expect(trim.status).toBe(200);
    expect(trim.body.preset.name).toBe("Tempo bars");

    const empty = await request(appAsCoachA)
      .post("/api/swing-reviews/coach/drawing-presets")
      .send({ name: "   ", drawings: drawingsFixture });
    expect(empty.status).toBe(400);

    const tooLong = await request(appAsCoachA)
      .post("/api/swing-reviews/coach/drawing-presets")
      .send({ name: "x".repeat(81), drawings: drawingsFixture });
    expect(tooLong.status).toBe(400);
  });

  it("rejects empty drawings and oversized payloads", async () => {
    const empty = await request(appAsCoachA)
      .post("/api/swing-reviews/coach/drawing-presets")
      .send({ name: "Empty", drawings: [] });
    expect(empty.status).toBe(400);

    const huge = Array.from({ length: 201 }, () => ({ kind: "line", t: 0, x1: 0, y1: 0, x2: 1, y2: 1, color: "#fff" }));
    const tooMany = await request(appAsCoachA)
      .post("/api/swing-reviews/coach/drawing-presets")
      .send({ name: "Too many", drawings: huge });
    expect(tooMany.status).toBe(400);

    const notArray = await request(appAsCoachA)
      .post("/api/swing-reviews/coach/drawing-presets")
      .send({ name: "Bad", drawings: "not-an-array" });
    expect(notArray.status).toBe(400);
  });

  it("renames a preset and bumps updatedAt", async () => {
    const create = await request(appAsCoachA)
      .post("/api/swing-reviews/coach/drawing-presets")
      .send({ name: "Old", drawings: drawingsFixture });
    const id = create.body.preset.id;
    const originalUpdatedAt = create.body.preset.updatedAt;

    // Sleep a tick so the bumped updatedAt is provably newer.
    await new Promise(r => setTimeout(r, 25));

    const rename = await request(appAsCoachA)
      .patch(`/api/swing-reviews/coach/drawing-presets/${id}`)
      .send({ name: "New" });
    expect(rename.status).toBe(200);
    expect(rename.body.preset.name).toBe("New");
    expect(new Date(rename.body.preset.updatedAt).getTime())
      .toBeGreaterThan(new Date(originalUpdatedAt).getTime());

    const empty = await request(appAsCoachA)
      .patch(`/api/swing-reviews/coach/drawing-presets/${id}`)
      .send({ name: "" });
    expect(empty.status).toBe(400);
  });

  it("deletes a preset", async () => {
    const create = await request(appAsCoachA)
      .post("/api/swing-reviews/coach/drawing-presets")
      .send({ name: "Doomed", drawings: drawingsFixture });
    const id = create.body.preset.id;

    const del = await request(appAsCoachA)
      .delete(`/api/swing-reviews/coach/drawing-presets/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);

    const list = await request(appAsCoachA).get("/api/swing-reviews/coach/drawing-presets");
    expect(list.body.presets).toHaveLength(0);

    // Second delete should 404.
    const del2 = await request(appAsCoachA)
      .delete(`/api/swing-reviews/coach/drawing-presets/${id}`);
    expect(del2.status).toBe(404);
  });

  it("scopes presets per coach — Coach A cannot see, rename or delete Coach B's library", async () => {
    const aCreate = await request(appAsCoachA)
      .post("/api/swing-reviews/coach/drawing-presets")
      .send({ name: "Coach A's pack", drawings: drawingsFixture });
    const bCreate = await request(appAsCoachB)
      .post("/api/swing-reviews/coach/drawing-presets")
      .send({ name: "Coach B's pack", drawings: drawingsFixture });
    const bId = bCreate.body.preset.id;

    const aList = await request(appAsCoachA).get("/api/swing-reviews/coach/drawing-presets");
    expect(aList.body.presets).toHaveLength(1);
    expect(aList.body.presets[0].id).toBe(aCreate.body.preset.id);

    const bList = await request(appAsCoachB).get("/api/swing-reviews/coach/drawing-presets");
    expect(bList.body.presets).toHaveLength(1);
    expect(bList.body.presets[0].id).toBe(bId);

    // Coach A trying to rename Coach B's preset → 404 (deliberately
    // not 403 so we don't leak the existence of B's library).
    const aRenamesB = await request(appAsCoachA)
      .patch(`/api/swing-reviews/coach/drawing-presets/${bId}`)
      .send({ name: "Hijacked" });
    expect(aRenamesB.status).toBe(404);

    const aDeletesB = await request(appAsCoachA)
      .delete(`/api/swing-reviews/coach/drawing-presets/${bId}`);
    expect(aDeletesB.status).toBe(404);

    // Sanity: Coach B's row is unchanged.
    const stillThere = await request(appAsCoachB).get("/api/swing-reviews/coach/drawing-presets");
    expect(stillThere.body.presets).toHaveLength(1);
    expect(stillThere.body.presets[0].name).toBe("Coach B's pack");
  });

  it("orders the picker by most-recently-updated first", async () => {
    const first = await request(appAsCoachA)
      .post("/api/swing-reviews/coach/drawing-presets")
      .send({ name: "First", drawings: drawingsFixture });
    await new Promise(r => setTimeout(r, 10));
    const second = await request(appAsCoachA)
      .post("/api/swing-reviews/coach/drawing-presets")
      .send({ name: "Second", drawings: drawingsFixture });
    await new Promise(r => setTimeout(r, 10));

    let list = await request(appAsCoachA).get("/api/swing-reviews/coach/drawing-presets");
    expect(list.body.presets.map((p: any) => p.name)).toEqual(["Second", "First"]);

    // Renaming the older preset bumps it to the top.
    await request(appAsCoachA)
      .patch(`/api/swing-reviews/coach/drawing-presets/${first.body.preset.id}`)
      .send({ name: "First (renamed)" });

    list = await request(appAsCoachA).get("/api/swing-reviews/coach/drawing-presets");
    expect(list.body.presets.map((p: any) => p.name)).toEqual(["First (renamed)", "Second"]);
  });

  it("rejects anonymous and non-coach callers", async () => {
    const anon = await request(appAnonymous).get("/api/swing-reviews/coach/drawing-presets");
    expect(anon.status).toBe(401);

    const member = await request(appAsNonCoach).get("/api/swing-reviews/coach/drawing-presets");
    expect(member.status).toBe(403);

    const memberCreate = await request(appAsNonCoach)
      .post("/api/swing-reviews/coach/drawing-presets")
      .send({ name: "Nope", drawings: drawingsFixture });
    expect(memberCreate.status).toBe(403);
  });
});
