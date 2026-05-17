/**
 * Task #1027 — Cover the cue sheet refresh action with automated tests.
 *
 * The producer panel's "Update from current" button issues a
 *   PUT /api/organizations/:orgId/tournaments/:tournamentId/overlay-templates/:templateId
 * with a `{ state }` body to refresh a saved cue sheet's captured snapshot
 * in place. This file pins down the backend half of that flow:
 *
 *   - the new state payload is persisted onto the template row, and
 *   - `updatedAt` strictly moves forward (so the FE row's "Updated …"
 *     timestamp visibly bumps after a successful refresh).
 *
 * A regression in either of those would silently break the broadcast
 * producer's ability to keep a cue sheet in sync with the live state,
 * so they're worth pinning explicitly.
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
let testTournamentId: number;
let testCourseId: number;
let testUserId: number;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `OverlayTplRefreshOrg_${Date.now()}`,
    slug: uid("overlay-tpl-refresh-org"),
    subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: testOrgId,
    name: "Overlay Tpl Refresh Course",
    slug: uid("overlay-tpl-refresh-course"),
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  testCourseId = course.id;

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: testOrgId,
    courseId: testCourseId,
    name: `Overlay Tpl Refresh Tournament ${Date.now()}`,
    format: "stroke_play",
    status: "active",
    startDate: new Date(),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    maxPlayers: 32,
  }).returning({ id: tournamentsTable.id });
  testTournamentId = tournament.id;

  const stamp = Date.now();
  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `overlay-tpl-refresh-admin-${stamp}`,
    username: `overlay_tpl_refresh_admin_${stamp}`,
  }).returning({ id: appUsersTable.id });
  testUserId = adminRow.id;
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
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

const adminUser = () => ({
  id: testUserId,
  username: "tpl-refresh-admin",
  role: "super_admin",
});

describe("PUT overlay-templates/:templateId — refresh from current state", () => {
  it("persists the new state payload and bumps updatedAt forward", async () => {
    const app = createTestApp(adminUser());

    // Seed live state and capture it as a template.
    await request(app)
      .put(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/overlay-state`)
      .send({
        active: { leaderboard: true, "lower-third": false },
        currentHole: 4,
        lowerThirdText: "Front nine",
        leaderboardLimit: 5,
      });

    const saveRes = await request(app)
      .post(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/overlay-templates`)
      .send({ name: `Refresh me ${Date.now()}` });
    expect(saveRes.status).toBe(201);
    const templateId = saveRes.body.id as number;
    const initialUpdatedAt = new Date(saveRes.body.updatedAt).getTime();
    expect(saveRes.body.state.currentHole).toBe(4);
    expect(saveRes.body.state.lowerThirdText).toBe("Front nine");

    // Wait long enough that a millisecond-resolution timestamp must advance.
    await new Promise((r) => setTimeout(r, 25));

    // Refresh the template with a brand-new state snapshot — this is the
    // exact body the FE sends from the "Update from current" button.
    const refreshedState = {
      active: { leaderboard: true, "lower-third": true, "sponsor-bug": true },
      currentHole: 18,
      lowerThirdText: "Back nine — final hole",
      leaderboardLimit: 8,
    };
    const refreshRes = await request(app)
      .put(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/overlay-templates/${templateId}`)
      .send({ state: refreshedState });
    expect(refreshRes.status).toBe(200);

    // Returned row reflects the new state…
    expect(refreshRes.body.id).toBe(templateId);
    expect(refreshRes.body.state.currentHole).toBe(18);
    expect(refreshRes.body.state.lowerThirdText).toBe("Back nine — final hole");
    expect(refreshRes.body.state.leaderboardLimit).toBe(8);
    expect(refreshRes.body.state.active.leaderboard).toBe(true);
    expect(refreshRes.body.state.active["lower-third"]).toBe(true);
    expect(refreshRes.body.state.active["sponsor-bug"]).toBe(true);

    // …and updatedAt has strictly moved forward.
    const refreshedUpdatedAt = new Date(refreshRes.body.updatedAt).getTime();
    expect(refreshedUpdatedAt).toBeGreaterThan(initialUpdatedAt);

    // Persisted in the DB (not just echoed back).
    const [persisted] = await db
      .select()
      .from(broadcastOverlayStateTemplatesTable)
      .where(eq(broadcastOverlayStateTemplatesTable.id, templateId));
    expect(persisted).toBeTruthy();
    const persistedState = persisted.state as { currentHole: number; lowerThirdText: string };
    expect(persistedState.currentHole).toBe(18);
    expect(persistedState.lowerThirdText).toBe("Back nine — final hole");
    expect(new Date(persisted.updatedAt as unknown as string).getTime()).toBe(refreshedUpdatedAt);

    // Listing the templates surfaces the bumped updatedAt for the same row,
    // which is what drives the "Updated …" label on the FE.
    const listRes = await request(app)
      .get(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/overlay-templates`);
    expect(listRes.status).toBe(200);
    const listed = (listRes.body.templates as Array<{ id: number; updatedAt: string }>).find(
      (t) => t.id === templateId,
    );
    expect(listed).toBeTruthy();
    expect(new Date(listed!.updatedAt).getTime()).toBe(refreshedUpdatedAt);
  });

  it("404s when refreshing a template that doesn't belong to the tournament", async () => {
    const app = createTestApp(adminUser());
    const res = await request(app)
      .put(`/api/organizations/${testOrgId}/tournaments/${testTournamentId}/overlay-templates/9999999`)
      .send({ state: { currentHole: 1 } });
    expect(res.status).toBe(404);
  });
});
