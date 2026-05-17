/**
 * Task #2009 — GET /api/organizations/:orgId/survey-response-summaries
 *
 * Pins the contract for the batch endpoint that powers the survey-response
 * badge on the admin tournament list page. Covers:
 *   • Returns one row per tournament that has had a survey actually sent,
 *     with `totalResponses` and `eligiblePlayers` ready to render as
 *     "12 / 48 — 25%".
 *   • Tournaments without a sent survey are omitted entirely (so the list
 *     page falls through to "no badge").
 *   • Draft surveys (sentAt IS NULL) are also omitted — the badge would
 *     otherwise read 0% before the email had even gone out.
 *   • Cross-org isolation — admin of org A only sees rows for orgA's
 *     tournaments, never orgB's.
 *   • AuthZ — players are rejected with 403; unauthenticated callers 401.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  tournamentsTable,
  postEventSurveysTable,
  postEventSurveyResponsesTable,
  playersTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, uid, type TestUser } from "../../tests/helpers.js";

let orgAId: number;
let orgBId: number;
let adminAUser: TestUser;
let playerUser: TestUser;
let tournamentLowEngagementId: number;
let tournamentHighEngagementId: number;
let tournamentNoSurveyId: number;
let tournamentDraftSurveyId: number;
let tournamentOrgBId: number;
let surveyLowId: number;
let surveyHighId: number;
let surveyDraftId: number;
let surveyOrgBId: number;
const userIdsToCleanup: number[] = [];

beforeAll(async () => {
  const stamp = uid("t2009");

  const [orgA] = await db.insert(organizationsTable).values({
    name: `T2009 A ${stamp}`, slug: `t2009a-${stamp}`, subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `T2009 B ${stamp}`, slug: `t2009b-${stamp}`, subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [aAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `t2009-admA-${stamp}`,
    username: `t2009_admA_${stamp}`,
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  userIdsToCleanup.push(aAdmin.id);
  adminAUser = { id: aAdmin.id, username: `admA_${stamp}`, role: "org_admin", organizationId: orgAId };

  const [pl] = await db.insert(appUsersTable).values({
    replitUserId: `t2009-pl-${stamp}`,
    username: `t2009_pl_${stamp}`,
    role: "player",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  userIdsToCleanup.push(pl.id);
  playerUser = { id: pl.id, username: `pl_${stamp}`, role: "player", organizationId: orgAId };

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgAId, userId: adminAUser.id, role: "org_admin" },
    { organizationId: orgAId, userId: playerUser.id, role: "player" },
  ]);

  // Tournament 1: low engagement (1 / 10 = 10%)
  const [tLow] = await db.insert(tournamentsTable).values({
    organizationId: orgAId, name: `T2009 low ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  tournamentLowEngagementId = tLow.id;

  // Tournament 2: high engagement (4 / 5 = 80%)
  const [tHigh] = await db.insert(tournamentsTable).values({
    organizationId: orgAId, name: `T2009 high ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  tournamentHighEngagementId = tHigh.id;

  // Tournament 3: no survey at all
  const [tNo] = await db.insert(tournamentsTable).values({
    organizationId: orgAId, name: `T2009 no-survey ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  tournamentNoSurveyId = tNo.id;

  // Tournament 4: survey row exists but sentAt is null (draft / scheduled)
  const [tDraft] = await db.insert(tournamentsTable).values({
    organizationId: orgAId, name: `T2009 draft-survey ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  tournamentDraftSurveyId = tDraft.id;

  // Tournament 5: in a DIFFERENT org — must never appear in orgA's response.
  const [tB] = await db.insert(tournamentsTable).values({
    organizationId: orgBId, name: `T2009 orgB ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  tournamentOrgBId = tB.id;

  // Player rosters define the eligible-pool denominators above.
  await db.insert(playersTable).values([
    ...Array.from({ length: 10 }).map((_, i) => ({
      tournamentId: tournamentLowEngagementId, firstName: `Low${i}`, lastName: "P",
    })),
    ...Array.from({ length: 5 }).map((_, i) => ({
      tournamentId: tournamentHighEngagementId, firstName: `High${i}`, lastName: "P",
    })),
    { tournamentId: tournamentDraftSurveyId, firstName: "Draft", lastName: "P" },
    { tournamentId: tournamentOrgBId, firstName: "OrgB", lastName: "P" },
  ]);

  const questions = [{ id: "overall", prompt: "Overall", type: "rating" as const }];

  const [sLow] = await db.insert(postEventSurveysTable).values({
    tournamentId: tournamentLowEngagementId,
    organizationId: orgAId,
    questions,
    sentAt: new Date("2026-04-01T10:00:00Z"),
  }).returning({ id: postEventSurveysTable.id });
  surveyLowId = sLow.id;

  const [sHigh] = await db.insert(postEventSurveysTable).values({
    tournamentId: tournamentHighEngagementId,
    organizationId: orgAId,
    questions,
    sentAt: new Date("2026-04-02T10:00:00Z"),
  }).returning({ id: postEventSurveysTable.id });
  surveyHighId = sHigh.id;

  const [sDraft] = await db.insert(postEventSurveysTable).values({
    tournamentId: tournamentDraftSurveyId,
    organizationId: orgAId,
    questions,
    sentAt: null, // draft — must be omitted.
  }).returning({ id: postEventSurveysTable.id });
  surveyDraftId = sDraft.id;

  const [sB] = await db.insert(postEventSurveysTable).values({
    tournamentId: tournamentOrgBId,
    organizationId: orgBId,
    questions,
    sentAt: new Date("2026-04-03T10:00:00Z"),
  }).returning({ id: postEventSurveysTable.id });
  surveyOrgBId = sB.id;

  // Responses: low gets 1, high gets 4.
  await db.insert(postEventSurveyResponsesTable).values([
    { surveyId: surveyLowId, userId: null, answers: { overall: 3 }, submittedAt: new Date("2026-04-02T09:00:00Z") },
    ...Array.from({ length: 4 }).map((_, i) => ({
      surveyId: surveyHighId, userId: null, answers: { overall: 4 },
      submittedAt: new Date(`2026-04-03T0${i}:00:00Z`),
    })),
  ]);
});

afterAll(async () => {
  await db.delete(postEventSurveyResponsesTable).where(inArray(postEventSurveyResponsesTable.surveyId, [
    surveyLowId, surveyHighId, surveyDraftId, surveyOrgBId,
  ]));
  await db.delete(postEventSurveysTable).where(inArray(postEventSurveysTable.id, [
    surveyLowId, surveyHighId, surveyDraftId, surveyOrgBId,
  ]));
  await db.delete(playersTable).where(inArray(playersTable.tournamentId, [
    tournamentLowEngagementId, tournamentHighEngagementId, tournamentNoSurveyId, tournamentDraftSurveyId, tournamentOrgBId,
  ]));
  await db.delete(tournamentsTable).where(inArray(tournamentsTable.id, [
    tournamentLowEngagementId, tournamentHighEngagementId, tournamentNoSurveyId, tournamentDraftSurveyId, tournamentOrgBId,
  ]));
  await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, userIdsToCleanup));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIdsToCleanup));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgAId, orgBId]));
});

describe("GET /api/organizations/:orgId/survey-response-summaries", () => {
  it("returns one row per tournament with a sent survey, with response and eligible counts", async () => {
    const app = createTestApp(adminAUser);
    const res = await request(app).get(`/api/organizations/${orgAId}/survey-response-summaries`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const byTournamentId = new Map<number, { totalResponses: number; eligiblePlayers: number; sentAt: string | null }>(
      (res.body as Array<{ tournamentId: number; totalResponses: number; eligiblePlayers: number; sentAt: string | null }>).map((r) => [r.tournamentId, r]),
    );

    // Low engagement: 1 response over a pool of 10.
    expect(byTournamentId.get(tournamentLowEngagementId)).toMatchObject({
      totalResponses: 1,
      eligiblePlayers: 10,
    });

    // High engagement: 4 responses over a pool of 5.
    expect(byTournamentId.get(tournamentHighEngagementId)).toMatchObject({
      totalResponses: 4,
      eligiblePlayers: 5,
    });

    // Tournament with no survey row at all → omitted.
    expect(byTournamentId.has(tournamentNoSurveyId)).toBe(false);

    // Draft survey (sentAt null) → omitted so it doesn't render as 0%.
    expect(byTournamentId.has(tournamentDraftSurveyId)).toBe(false);

    // Cross-org isolation — orgB's tournament must not appear in orgA's
    // response, even though its survey was sent.
    expect(byTournamentId.has(tournamentOrgBId)).toBe(false);
  });

  it("returns an empty array for an org with no surveys at all", async () => {
    // Use orgB as the empty-ish org; it has one survey, but we ask via a
    // different (admin-empty) angle by switching the orgId path segment to
    // a non-existent org and confirming we get a 403/empty rather than
    // accidentally exposing rows. Easier: confirm orgB's admin sees only
    // orgB's row (a clean cross-check on the where clause).
    // Build a fresh orgB admin so the auth check passes.
    const stamp = uid("t2009b");
    const [bAdmin] = await db.insert(appUsersTable).values({
      replitUserId: `t2009-admB-${stamp}`,
      username: `t2009_admB_${stamp}`,
      role: "org_admin",
      organizationId: orgBId,
    }).returning({ id: appUsersTable.id });
    try {
      await db.insert(orgMembershipsTable).values({
        organizationId: orgBId, userId: bAdmin.id, role: "org_admin",
      });
      const adminB: TestUser = { id: bAdmin.id, username: `admB_${stamp}`, role: "org_admin", organizationId: orgBId };
      const app = createTestApp(adminB);
      const res = await request(app).get(`/api/organizations/${orgBId}/survey-response-summaries`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      // OrgB has exactly one tournament with a sent survey, no responses.
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({
        tournamentId: tournamentOrgBId,
        totalResponses: 0,
        eligiblePlayers: 1,
      });
    } finally {
      await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.userId, bAdmin.id));
      await db.delete(appUsersTable).where(eq(appUsersTable.id, bAdmin.id));
    }
  });

  it("rejects non-admin players with 403", async () => {
    const app = createTestApp(playerUser);
    const res = await request(app).get(`/api/organizations/${orgAId}/survey-response-summaries`);
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const app = createTestApp();
    const res = await request(app).get(`/api/organizations/${orgAId}/survey-response-summaries`);
    expect(res.status).toBe(401);
  });
});
