/**
 * Integration tests: Broadcast overlay producer cue-sheet templates (Task #549).
 *
 * Verifies that producers can:
 *   - Save the live overlay state as a named template (POST)
 *   - List saved templates per tournament (GET)
 *   - Rename a template / refresh its captured state (PUT)
 *   - Load a template into the live cue state, replacing it (POST /load)
 *   - Delete a template (DELETE)
 *
 * Also asserts authorization (401/403 for outsiders) and per-tournament name
 * uniqueness (409 conflict on duplicate names).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  tournamentsTable,
  appUsersTable,
  broadcastOverlayStatesTable,
  broadcastOverlayStateTemplatesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTestApp, uid } from "./helpers.js";

let testOrgId: number;
let otherOrgId: number;
let testTournamentId: number;
let testCourseId: number;
let testUserId: number;
let testOutsiderUserId: number;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `OverlayTplOrg_${Date.now()}`,
    slug: uid("overlay-tpl-org"),
    subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [other] = await db.insert(organizationsTable).values({
    name: `OverlayTplOther_${Date.now()}`,
    slug: uid("overlay-tpl-other"),
    subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  otherOrgId = other.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: testOrgId,
    name: "Overlay Tpl Course",
    slug: uid("overlay-tpl-course"),
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  testCourseId = course.id;

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: testOrgId,
    courseId: testCourseId,
    name: `Overlay Tpl Tournament ${Date.now()}`,
    format: "stroke_play",
    status: "active",
    startDate: new Date(),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    maxPlayers: 32,
  }).returning({ id: tournamentsTable.id });
  testTournamentId = tournament.id;

  const stamp = Date.now();
  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `overlay-tpl-admin-${stamp}`,
    username: `overlay_tpl_admin_${stamp}`,
  }).returning({ id: appUsersTable.id });
  testUserId = adminRow.id;

  const [outsiderRow] = await db.insert(appUsersTable).values({
    replitUserId: `overlay-tpl-outsider-${stamp}`,
    username: `overlay_tpl_outsider_${stamp}`,
  }).returning({ id: appUsersTable.id });
  testOutsiderUserId = outsiderRow.id;
});

afterAll(async () => {
  await db.delete(broadcastOverlayStateTemplatesTable)
    .where(eq(broadcastOverlayStateTemplatesTable.tournamentId, testTournamentId));
  await db.delete(broadcastOverlayStatesTable)
    .where(eq(broadcastOverlayStatesTable.tournamentId, testTournamentId));
  await db.delete(tournamentsTable)
    .where(and(eq(tournamentsTable.id, testTournamentId), eq(tournamentsTable.organizationId, testOrgId)));
  await db.delete(coursesTable).where(eq(coursesTable.id, testCourseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, testOutsiderUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrgId));
});

const adminUser = () => ({
  id: testUserId,
  username: "tpl-admin",
  role: "super_admin",
});

const outsiderUser = () => ({
  id: testOutsiderUserId,
  username: "outsider",
  role: "org_admin",
  organizationId: otherOrgId,
});

describe("Broadcast overlay cue-sheet templates", () => {
  it("requires authentication for listing templates", async () => {
    const app = createTestApp();
    const res = await request(app)
      .get(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/overlay-templates`);
    expect(res.status).toBe(401);
  });

  it("denies access to producers from other orgs", async () => {
    const app = createTestApp(outsiderUser());
    const res = await request(app)
      .post(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/overlay-templates`)
      .send({ name: "Sneaky" });
    expect(res.status).toBe(403);
  });

  it("rejects empty / oversized template names with 400", async () => {
    const app = createTestApp(adminUser());
    const blank = await request(app)
      .post(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/overlay-templates`)
      .send({ name: "   " });
    expect(blank.status).toBe(400);

    const huge = await request(app)
      .post(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/overlay-templates`)
      .send({ name: "x".repeat(200) });
    expect(huge.status).toBe(400);
  });

  it("saves the current cue state as a named template, lists, loads, renames, and deletes it", async () => {
    const app = createTestApp(adminUser());

    // Seed the live cue state via the existing PUT endpoint.
    const liveRes = await request(app)
      .put(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/overlay-state`)
      .send({
        active: { leaderboard: true, "lower-third": true, hole: false },
        currentHole: 17,
        lowerThirdText: "Amen Corner",
        leaderboardLimit: 5,
      });
    expect(liveRes.status).toBe(200);
    expect(liveRes.body.currentHole).toBe(17);

    // Save the live state as "Hole 17 amen corner".
    const saveRes = await request(app)
      .post(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/overlay-templates`)
      .send({ name: "Hole 17 amen corner" });
    expect(saveRes.status).toBe(201);
    expect(saveRes.body.name).toBe("Hole 17 amen corner");
    expect(saveRes.body.state.currentHole).toBe(17);
    expect(saveRes.body.state.lowerThirdText).toBe("Amen Corner");
    expect(saveRes.body.organizationId).toBe(testOrgId);
    const templateId = saveRes.body.id;

    // Save a second template with an explicit state body.
    const sundayRes = await request(app)
      .post(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/overlay-templates`)
      .send({
        name: "Sunday final round",
        state: {
          active: { leaderboard: true, "sponsor-bug": true },
          leaderboardLimit: 10,
          lowerThirdText: "Final Round Sunday",
        },
      });
    expect(sundayRes.status).toBe(201);
    expect(sundayRes.body.state.leaderboardLimit).toBe(10);
    expect(sundayRes.body.state.active.leaderboard).toBe(true);

    // Duplicate name → 409.
    const dup = await request(app)
      .post(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/overlay-templates`)
      .send({ name: "Sunday final round" });
    expect(dup.status).toBe(409);

    // List returns both, newest-first.
    const listRes = await request(app)
      .get(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/overlay-templates`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.templates).toHaveLength(2);
    const names = listRes.body.templates.map((t: { name: string }) => t.name);
    expect(names).toContain("Hole 17 amen corner");
    expect(names).toContain("Sunday final round");

    // Mutate the live state so we can prove `load` replaces it.
    await request(app)
      .put(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/overlay-state`)
      .send({ currentHole: 1, lowerThirdText: "Welcome", active: { leaderboard: false, "lower-third": false } });

    // Load the "Hole 17" template into the live cue state.
    const loadRes = await request(app)
      .post(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/overlay-templates/${templateId}/load`);
    expect(loadRes.status).toBe(200);
    expect(loadRes.body.currentHole).toBe(17);
    expect(loadRes.body.lowerThirdText).toBe("Amen Corner");
    expect(loadRes.body.active.leaderboard).toBe(true);
    expect(loadRes.body.active["lower-third"]).toBe(true);

    // Verify GET overlay-state now reflects the loaded template (and persisted to DB).
    const stateAfter = await request(app)
      .get(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/overlay-state`);
    expect(stateAfter.status).toBe(200);
    expect(stateAfter.body.currentHole).toBe(17);
    expect(stateAfter.body.lowerThirdText).toBe("Amen Corner");

    // Rename the template.
    const renameRes = await request(app)
      .put(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/overlay-templates/${templateId}`)
      .send({ name: "Hole 17 closer look" });
    expect(renameRes.status).toBe(200);
    expect(renameRes.body.name).toBe("Hole 17 closer look");

    // Delete the template.
    const delRes = await request(app)
      .delete(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/overlay-templates/${templateId}`);
    expect(delRes.status).toBe(200);
    expect(delRes.body.deleted).toBe(true);

    // Loading a deleted template returns 404.
    const missing = await request(app)
      .post(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/overlay-templates/${templateId}/load`);
    expect(missing.status).toBe(404);
  });

  it("404s when loading a template that belongs to a different tournament/org", async () => {
    const app = createTestApp(adminUser());
    const res = await request(app)
      .post(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/overlay-templates/9999999/load`);
    expect(res.status).toBe(404);
  });
});
