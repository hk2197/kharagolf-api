/**
 * Task #1363 — GET/POST /api/portal/surveys/:surveyId
 *
 * Pins the contract for the new player-facing post-event survey endpoints.
 * Covers:
 *   • GET — registered player sees questions and "alreadySubmitted" flag.
 *   • GET — non-registered player gets 403.
 *   • GET — unauthenticated caller gets 401.
 *   • GET — unknown surveyId gets 404.
 *   • POST — registered player can submit answers; row lands in
 *     postEventSurveyResponsesTable.
 *   • POST — second submission from same player is rejected with 409.
 *   • POST — past `closesAt` is rejected with 410.
 *   • POST — non-registered player gets 403.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

let orgId: number;
let registeredUser: TestUser;
let outsiderUser: TestUser;
let secondRegisteredUser: TestUser;
let openTournamentId: number;
let closedTournamentId: number;
let openSurveyId: number;
let closedSurveyId: number;
const userIdsToCleanup: number[] = [];

beforeAll(async () => {
  const stamp = uid("t1363");

  const [org] = await db.insert(organizationsTable).values({
    name: `T1363 ${stamp}`, slug: `t1363-${stamp}`, subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [reg] = await db.insert(appUsersTable).values({
    replitUserId: `t1363-reg-${stamp}`,
    username: `t1363_reg_${stamp}`,
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userIdsToCleanup.push(reg.id);
  registeredUser = { id: reg.id, username: `reg_${stamp}`, role: "player", organizationId: orgId };

  const [reg2] = await db.insert(appUsersTable).values({
    replitUserId: `t1363-reg2-${stamp}`,
    username: `t1363_reg2_${stamp}`,
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userIdsToCleanup.push(reg2.id);
  secondRegisteredUser = { id: reg2.id, username: `reg2_${stamp}`, role: "player", organizationId: orgId };

  const [out] = await db.insert(appUsersTable).values({
    replitUserId: `t1363-out-${stamp}`,
    username: `t1363_out_${stamp}`,
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userIdsToCleanup.push(out.id);
  outsiderUser = { id: out.id, username: `out_${stamp}`, role: "player", organizationId: orgId };

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgId, userId: registeredUser.id, role: "player" },
    { organizationId: orgId, userId: secondRegisteredUser.id, role: "player" },
    { organizationId: orgId, userId: outsiderUser.id, role: "player" },
  ]);

  const [tOpen] = await db.insert(tournamentsTable).values({
    organizationId: orgId, name: `T1363 open ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  openTournamentId = tOpen.id;

  const [tClosed] = await db.insert(tournamentsTable).values({
    organizationId: orgId, name: `T1363 closed ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  closedTournamentId = tClosed.id;

  // Both `registeredUser` and `secondRegisteredUser` actually played both
  // tournaments. `outsiderUser` did not.
  await db.insert(playersTable).values([
    { tournamentId: openTournamentId, userId: registeredUser.id, firstName: "Reg", lastName: "User" },
    { tournamentId: openTournamentId, userId: secondRegisteredUser.id, firstName: "Reg2", lastName: "User" },
    { tournamentId: closedTournamentId, userId: registeredUser.id, firstName: "Reg", lastName: "User" },
  ]);

  const questions = [
    { id: "overall", prompt: "Overall experience", type: "rating" as const },
    { id: "comeback", prompt: "Would you play again?", type: "boolean" as const },
    { id: "comments", prompt: "Any comments?", type: "text" as const },
  ];

  const [openSurvey] = await db.insert(postEventSurveysTable).values({
    tournamentId: openTournamentId,
    organizationId: orgId,
    questions,
    sentAt: new Date("2026-04-01T10:00:00Z"),
    closesAt: new Date("2099-01-01T00:00:00Z"),
  }).returning({ id: postEventSurveysTable.id });
  openSurveyId = openSurvey.id;

  const [closedSurvey] = await db.insert(postEventSurveysTable).values({
    tournamentId: closedTournamentId,
    organizationId: orgId,
    questions,
    sentAt: new Date("2026-01-01T10:00:00Z"),
    closesAt: new Date("2026-01-15T00:00:00Z"),
  }).returning({ id: postEventSurveysTable.id });
  closedSurveyId = closedSurvey.id;
});

afterAll(async () => {
  await db.delete(postEventSurveyResponsesTable)
    .where(inArray(postEventSurveyResponsesTable.surveyId, [openSurveyId, closedSurveyId]));
  await db.delete(postEventSurveysTable)
    .where(inArray(postEventSurveysTable.id, [openSurveyId, closedSurveyId]));
  await db.delete(playersTable)
    .where(inArray(playersTable.tournamentId, [openTournamentId, closedTournamentId]));
  await db.delete(tournamentsTable)
    .where(inArray(tournamentsTable.id, [openTournamentId, closedTournamentId]));
  await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, userIdsToCleanup));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIdsToCleanup));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("GET /api/portal/surveys/:surveyId", () => {
  it("returns the survey to a registered player with questions", async () => {
    const app = createTestApp(registeredUser);
    const res = await request(app).get(`/api/portal/surveys/${openSurveyId}`);
    expect(res.status).toBe(200);
    expect(res.body.survey.id).toBe(openSurveyId);
    expect(res.body.survey.tournamentId).toBe(openTournamentId);
    expect(res.body.survey.questions).toHaveLength(3);
    expect(res.body.closed).toBe(false);
    expect(res.body.alreadySubmitted).toBe(false);
  });

  it("flags closed surveys but still returns the questions", async () => {
    const app = createTestApp(registeredUser);
    const res = await request(app).get(`/api/portal/surveys/${closedSurveyId}`);
    expect(res.status).toBe(200);
    expect(res.body.closed).toBe(true);
    expect(res.body.survey.questions).toHaveLength(3);
  });

  it("rejects players who weren't registered for the tournament with 403", async () => {
    const app = createTestApp(outsiderUser);
    const res = await request(app).get(`/api/portal/surveys/${openSurveyId}`);
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const app = createTestApp();
    const res = await request(app).get(`/api/portal/surveys/${openSurveyId}`);
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown survey id", async () => {
    const app = createTestApp(registeredUser);
    const res = await request(app).get(`/api/portal/surveys/999999999`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/portal/surveys/:surveyId", () => {
  it("stores answers from a registered player and prevents double submission", async () => {
    const app = createTestApp(secondRegisteredUser);
    const res = await request(app)
      .post(`/api/portal/surveys/${openSurveyId}`)
      .send({ answers: { overall: 5, comeback: true, comments: "Great event!" } });
    expect(res.status).toBe(201);
    expect(res.body.response.surveyId).toBe(openSurveyId);
    expect(res.body.response.userId).toBe(secondRegisteredUser.id);

    const stored = await db.select().from(postEventSurveyResponsesTable)
      .where(eq(postEventSurveyResponsesTable.surveyId, openSurveyId));
    const mine = stored.find(r => r.userId === secondRegisteredUser.id);
    expect(mine).toBeTruthy();
    expect(mine!.answers).toMatchObject({ overall: 5, comeback: true, comments: "Great event!" });

    // GET now reports alreadySubmitted=true.
    const followup = await request(app).get(`/api/portal/surveys/${openSurveyId}`);
    expect(followup.status).toBe(200);
    expect(followup.body.alreadySubmitted).toBe(true);

    // Second submission rejected.
    const second = await request(app)
      .post(`/api/portal/surveys/${openSurveyId}`)
      .send({ answers: { overall: 4 } });
    expect(second.status).toBe(409);
  });

  it("rejects submissions to a closed survey with 410", async () => {
    const app = createTestApp(registeredUser);
    const res = await request(app)
      .post(`/api/portal/surveys/${closedSurveyId}`)
      .send({ answers: { overall: 4 } });
    expect(res.status).toBe(410);
  });

  it("rejects players who weren't registered for the tournament with 403", async () => {
    const app = createTestApp(outsiderUser);
    const res = await request(app)
      .post(`/api/portal/surveys/${openSurveyId}`)
      .send({ answers: { overall: 4 } });
    expect(res.status).toBe(403);
  });

  it("rejects empty submissions with 400", async () => {
    const app = createTestApp(registeredUser);
    const res = await request(app)
      .post(`/api/portal/surveys/${openSurveyId}`)
      .send({ answers: {} });
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post(`/api/portal/surveys/${openSurveyId}`)
      .send({ answers: { overall: 4 } });
    expect(res.status).toBe(401);
  });
});
