/**
 * Task #1625 — POST /api/organizations/:orgId/tournaments/:tid/survey/remind
 *
 * Pins the contract for the post-event survey reminder endpoint.
 *
 * Covers:
 *   • Happy path — an admin can fire the reminder; the response counts the
 *     un-submitted registered players and `reminderSentAt` is stamped.
 *   • Idempotency — the second invocation is rejected with 409 and the
 *     timestamp does not move.
 *   • Filtering — players who already submitted are NOT counted as
 *     recipients; players with no linked user account are skipped.
 *   • All-submitted edge case — when every registered player has already
 *     answered, the endpoint returns `remindersSent: 0` and leaves
 *     `reminderSentAt` null so a future late registration could still be
 *     reminded.
 *   • Closed survey — once `closesAt` is in the past we return 410.
 *   • IDOR — admin of org A can't fire the reminder for a tournament in
 *     org B (404).
 *   • AuthZ — non-admin players are rejected with 403.
 *   • Auth — unauthenticated callers are rejected with 401.
 *   • 404 when no survey row exists for the tournament.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import {
  db,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  tournamentsTable,
  playersTable,
  postEventSurveysTable,
  postEventSurveyResponsesTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, uid, type TestUser } from "../../tests/helpers.js";

let orgAId: number;
let orgBId: number;
let adminAUser: TestUser;
let adminBUser: TestUser;
let playerSubmitted: TestUser;
let playerUnsubmitted1: TestUser;
let playerUnsubmitted2: TestUser;
let playerOutsideTournament: TestUser;

let openTournamentId: number;
let allSubmittedTournamentId: number;
let closedTournamentId: number;
let noUserTournamentId: number;
let orgBTournamentId: number;

let openSurveyId: number;
let allSubmittedSurveyId: number;
let closedSurveyId: number;
let noUserSurveyId: number;
let orgBSurveyId: number;

const userIdsToCleanup: number[] = [];

beforeAll(async () => {
  const stamp = uid("t1625");

  const [orgA] = await db.insert(organizationsTable).values({
    name: `T1625 A ${stamp}`, slug: `t1625a-${stamp}`, subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `T1625 B ${stamp}`, slug: `t1625b-${stamp}`, subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  async function makeUser(suffix: string, role: "org_admin" | "player", orgId: number): Promise<TestUser> {
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `t1625-${suffix}-${stamp}`,
      username: `t1625_${suffix}_${stamp}`,
      role,
      organizationId: orgId,
    }).returning({ id: appUsersTable.id });
    userIdsToCleanup.push(u.id);
    return { id: u.id, username: `${suffix}_${stamp}`, role, organizationId: orgId };
  }

  adminAUser = await makeUser("admA", "org_admin", orgAId);
  adminBUser = await makeUser("admB", "org_admin", orgBId);
  playerSubmitted = await makeUser("plSub", "player", orgAId);
  playerUnsubmitted1 = await makeUser("plUn1", "player", orgAId);
  playerUnsubmitted2 = await makeUser("plUn2", "player", orgAId);
  playerOutsideTournament = await makeUser("plOut", "player", orgAId);

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgAId, userId: adminAUser.id, role: "org_admin" },
    { organizationId: orgBId, userId: adminBUser.id, role: "org_admin" },
    { organizationId: orgAId, userId: playerSubmitted.id, role: "player" },
    { organizationId: orgAId, userId: playerUnsubmitted1.id, role: "player" },
    { organizationId: orgAId, userId: playerUnsubmitted2.id, role: "player" },
    { organizationId: orgAId, userId: playerOutsideTournament.id, role: "player" },
  ]);

  // ── Open tournament: 3 registered players, 1 has submitted, 2 unsubmitted.
  //    Plus a "ghost" roster row with no userId to confirm we filter it out.
  const [tOpen] = await db.insert(tournamentsTable).values({
    organizationId: orgAId, name: `T1625 open ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  openTournamentId = tOpen.id;

  await db.insert(playersTable).values([
    { tournamentId: openTournamentId, userId: playerSubmitted.id, firstName: "Sub", lastName: "User" },
    { tournamentId: openTournamentId, userId: playerUnsubmitted1.id, firstName: "Un1", lastName: "User" },
    { tournamentId: openTournamentId, userId: playerUnsubmitted2.id, firstName: "Un2", lastName: "User" },
    { tournamentId: openTournamentId, userId: null, firstName: "Ghost", lastName: "Player" },
  ]);

  const questions = [
    { id: "overall", prompt: "Overall experience", type: "rating" as const },
  ];

  const [openSurvey] = await db.insert(postEventSurveysTable).values({
    tournamentId: openTournamentId,
    organizationId: orgAId,
    questions,
    sentAt: new Date("2026-04-01T10:00:00Z"),
    closesAt: new Date("2099-01-01T00:00:00Z"),
  }).returning({ id: postEventSurveysTable.id });
  openSurveyId = openSurvey.id;

  await db.insert(postEventSurveyResponsesTable).values({
    surveyId: openSurveyId,
    userId: playerSubmitted.id,
    answers: { overall: 5 },
    submittedAt: new Date("2026-04-02T09:00:00Z"),
  });

  // ── All-submitted tournament: every roster entry has a response on file.
  const [tAll] = await db.insert(tournamentsTable).values({
    organizationId: orgAId, name: `T1625 all ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  allSubmittedTournamentId = tAll.id;

  await db.insert(playersTable).values([
    { tournamentId: allSubmittedTournamentId, userId: playerSubmitted.id, firstName: "Sub", lastName: "User" },
    { tournamentId: allSubmittedTournamentId, userId: playerUnsubmitted1.id, firstName: "Un1", lastName: "User" },
  ]);

  const [allSurvey] = await db.insert(postEventSurveysTable).values({
    tournamentId: allSubmittedTournamentId,
    organizationId: orgAId,
    questions,
    sentAt: new Date("2026-04-01T10:00:00Z"),
  }).returning({ id: postEventSurveysTable.id });
  allSubmittedSurveyId = allSurvey.id;

  await db.insert(postEventSurveyResponsesTable).values([
    {
      surveyId: allSubmittedSurveyId,
      userId: playerSubmitted.id,
      answers: { overall: 4 },
      submittedAt: new Date("2026-04-02T09:00:00Z"),
    },
    {
      surveyId: allSubmittedSurveyId,
      userId: playerUnsubmitted1.id,
      answers: { overall: 3 },
      submittedAt: new Date("2026-04-02T10:00:00Z"),
    },
  ]);

  // ── Closed tournament: closesAt in the past.
  const [tClosed] = await db.insert(tournamentsTable).values({
    organizationId: orgAId, name: `T1625 closed ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  closedTournamentId = tClosed.id;

  await db.insert(playersTable).values([
    { tournamentId: closedTournamentId, userId: playerUnsubmitted1.id, firstName: "Un1", lastName: "User" },
  ]);

  const [closedSurvey] = await db.insert(postEventSurveysTable).values({
    tournamentId: closedTournamentId,
    organizationId: orgAId,
    questions,
    sentAt: new Date("2026-01-01T10:00:00Z"),
    closesAt: new Date("2026-01-15T00:00:00Z"),
  }).returning({ id: postEventSurveysTable.id });
  closedSurveyId = closedSurvey.id;

  // ── No-user tournament: only roster entries with userId null exist.
  //    Confirms the 0-recipient branch leaves reminderSentAt null.
  const [tNoUser] = await db.insert(tournamentsTable).values({
    organizationId: orgAId, name: `T1625 noUser ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  noUserTournamentId = tNoUser.id;

  await db.insert(playersTable).values([
    { tournamentId: noUserTournamentId, userId: null, firstName: "Walk-up", lastName: "Player" },
  ]);

  const [noUserSurvey] = await db.insert(postEventSurveysTable).values({
    tournamentId: noUserTournamentId,
    organizationId: orgAId,
    questions,
    sentAt: new Date("2026-04-01T10:00:00Z"),
  }).returning({ id: postEventSurveysTable.id });
  noUserSurveyId = noUserSurvey.id;

  // ── Org B tournament (IDOR guard).
  const [tB] = await db.insert(tournamentsTable).values({
    organizationId: orgBId, name: `T1625 orgB ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  orgBTournamentId = tB.id;

  const [orgBSurvey] = await db.insert(postEventSurveysTable).values({
    tournamentId: orgBTournamentId,
    organizationId: orgBId,
    questions,
    sentAt: new Date("2026-04-01T10:00:00Z"),
  }).returning({ id: postEventSurveysTable.id });
  orgBSurveyId = orgBSurvey.id;
});

afterAll(async () => {
  const surveyIds = [openSurveyId, allSubmittedSurveyId, closedSurveyId, noUserSurveyId, orgBSurveyId];
  await db.delete(postEventSurveyResponsesTable).where(inArray(postEventSurveyResponsesTable.surveyId, surveyIds));
  await db.delete(postEventSurveysTable).where(inArray(postEventSurveysTable.id, surveyIds));

  const tournamentIds = [openTournamentId, allSubmittedTournamentId, closedTournamentId, noUserTournamentId, orgBTournamentId];
  await db.delete(playersTable).where(inArray(playersTable.tournamentId, tournamentIds));
  await db.delete(tournamentsTable).where(inArray(tournamentsTable.id, tournamentIds));

  await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, userIdsToCleanup));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIdsToCleanup));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgAId, orgBId]));
});

beforeEach(async () => {
  // Reset reminderSentAt between tests so each one exercises a clean state
  // (the happy-path test stamps the open survey, and the idempotency test
  // wants to read that stamp back).
  await db.update(postEventSurveysTable)
    .set({ reminderSentAt: null })
    .where(inArray(postEventSurveysTable.id, [openSurveyId, allSubmittedSurveyId, noUserSurveyId, orgBSurveyId]));
});

describe("POST /api/organizations/:orgId/tournaments/:tid/survey/remind", () => {
  it("admin can fire reminders to un-submitted registered players and stamps reminderSentAt", async () => {
    const app = createTestApp(adminAUser);
    const before = Date.now();
    const res = await request(app)
      .post(`/api/organizations/${orgAId}/tournaments/${openTournamentId}/survey/remind`)
      .send({});

    expect(res.status).toBe(200);
    // 3 registered players: 1 submitted + 1 ghost (no userId) → 2 reminders.
    expect(res.body.remindersSent).toBe(2);
    expect(res.body.reminderSentAt).toBeTruthy();
    expect(new Date(res.body.reminderSentAt).getTime()).toBeGreaterThanOrEqual(before);

    // Survey row was actually updated.
    const [row] = await db.select({ reminderSentAt: postEventSurveysTable.reminderSentAt })
      .from(postEventSurveysTable)
      .where(eq(postEventSurveysTable.id, openSurveyId));
    expect(row.reminderSentAt).toBeTruthy();
  });

  it("two concurrent invocations only stamp + dispatch once (race-safe via conditional update)", async () => {
    const app = createTestApp(adminAUser);

    // Fire both requests in parallel without awaiting in between so they
    // both pass the `survey.reminderSentAt IS NULL` read check before
    // either UPDATE commits. Exactly one should succeed (200, remindersSent=2),
    // the other should be rejected by the conditional UPDATE with 409.
    const [a, b] = await Promise.all([
      request(app).post(`/api/organizations/${orgAId}/tournaments/${openTournamentId}/survey/remind`).send({}),
      request(app).post(`/api/organizations/${orgAId}/tournaments/${openTournamentId}/survey/remind`).send({}),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = a.status === 200 ? a : b;
    const loser = a.status === 409 ? a : b;
    expect(winner.body.remindersSent).toBe(2);
    expect(winner.body.reminderSentAt).toBeTruthy();
    expect(loser.body.error).toMatch(/already sent/i);
    expect(new Date(loser.body.reminderSentAt).getTime()).toBe(new Date(winner.body.reminderSentAt).getTime());

    const [row] = await db.select({ reminderSentAt: postEventSurveysTable.reminderSentAt })
      .from(postEventSurveysTable)
      .where(eq(postEventSurveysTable.id, openSurveyId));
    expect(row.reminderSentAt!.getTime()).toBe(new Date(winner.body.reminderSentAt).getTime());
  });

  it("rejects a second invocation with 409 (idempotent within the once-per-survey window)", async () => {
    const app = createTestApp(adminAUser);

    const first = await request(app)
      .post(`/api/organizations/${orgAId}/tournaments/${openTournamentId}/survey/remind`)
      .send({});
    expect(first.status).toBe(200);
    const firstStamp = first.body.reminderSentAt;

    const second = await request(app)
      .post(`/api/organizations/${orgAId}/tournaments/${openTournamentId}/survey/remind`)
      .send({});
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already sent/i);
    // Existing stamp is surfaced and unchanged.
    expect(new Date(second.body.reminderSentAt).getTime()).toBe(new Date(firstStamp).getTime());

    const [row] = await db.select({ reminderSentAt: postEventSurveysTable.reminderSentAt })
      .from(postEventSurveysTable)
      .where(eq(postEventSurveysTable.id, openSurveyId));
    expect(row.reminderSentAt!.getTime()).toBe(new Date(firstStamp).getTime());
  });

  it("returns remindersSent=0 and leaves reminderSentAt null when every registered player already submitted", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .post(`/api/organizations/${orgAId}/tournaments/${allSubmittedTournamentId}/survey/remind`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.remindersSent).toBe(0);
    expect(res.body.reminderSentAt).toBeNull();

    const [row] = await db.select({ reminderSentAt: postEventSurveysTable.reminderSentAt })
      .from(postEventSurveysTable)
      .where(eq(postEventSurveysTable.id, allSubmittedSurveyId));
    expect(row.reminderSentAt).toBeNull();
  });

  it("returns remindersSent=0 and leaves reminderSentAt null when no roster entry has a linked user account", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .post(`/api/organizations/${orgAId}/tournaments/${noUserTournamentId}/survey/remind`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.remindersSent).toBe(0);
    expect(res.body.reminderSentAt).toBeNull();

    const [row] = await db.select({ reminderSentAt: postEventSurveysTable.reminderSentAt })
      .from(postEventSurveysTable)
      .where(eq(postEventSurveysTable.id, noUserSurveyId));
    expect(row.reminderSentAt).toBeNull();
  });

  it("rejects reminders for a closed survey with 410", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .post(`/api/organizations/${orgAId}/tournaments/${closedTournamentId}/survey/remind`)
      .send({});
    expect(res.status).toBe(410);
  });

  it("returns 404 when the tournament has no survey row", async () => {
    // Create + tear down a transient tournament with no survey.
    const stamp = uid("t1625-bare");
    const [t] = await db.insert(tournamentsTable).values({
      organizationId: orgAId, name: `T1625 bare ${stamp}`,
    }).returning({ id: tournamentsTable.id });
    try {
      const app = createTestApp(adminAUser);
      const res = await request(app)
        .post(`/api/organizations/${orgAId}/tournaments/${t.id}/survey/remind`)
        .send({});
      expect(res.status).toBe(404);
    } finally {
      await db.delete(tournamentsTable).where(eq(tournamentsTable.id, t.id));
    }
  });

  it("blocks an admin of a different org via 404 (tournament not in their org)", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app)
      .post(`/api/organizations/${orgAId}/tournaments/${orgBTournamentId}/survey/remind`)
      .send({});
    expect(res.status).toBe(404);

    // adminB can also not reach the orgA survey through the orgA path.
    const appB = createTestApp(adminBUser);
    const resB = await request(appB)
      .post(`/api/organizations/${orgAId}/tournaments/${openTournamentId}/survey/remind`)
      .send({});
    // requireOrgAdmin returns 403 when the caller isn't an admin of that org.
    expect([403, 404]).toContain(resB.status);
  });

  it("rejects non-admin players with 403", async () => {
    const app = createTestApp(playerOutsideTournament);
    const res = await request(app)
      .post(`/api/organizations/${orgAId}/tournaments/${openTournamentId}/survey/remind`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post(`/api/organizations/${orgAId}/tournaments/${openTournamentId}/survey/remind`)
      .send({});
    expect(res.status).toBe(401);
  });
});
