/**
 * Task #2011 — sendScheduledSurveyReminders cron coverage.
 *
 * Pins the scheduled-job semantics defined in the task brief:
 *
 *   • Surveys whose `sentAt` is older than the configured window (default
 *     3 days) and whose `reminderSentAt` is null get reminded.
 *   • Surveys whose `sentAt` is more recent than the window are left alone.
 *   • Surveys with `closesAt` already in the past are skipped (no point
 *     asking for feedback the portal won't accept).
 *   • Surveys whose `reminderSentAt` is already stamped (because an admin
 *     fired the reminder manually first) are skipped — admin-manual and
 *     cron remain idempotent.
 *   • The job logs (and returns) a summary so observability can graph
 *     reminders sent per day.
 *   • Re-running the cron immediately after a successful run is a no-op
 *     because the helper stamps `reminderSentAt` on the first dispatch
 *     (the same conditional-UPDATE path the admin endpoint uses).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  appUsersTable,
  organizationsTable,
  orgMembershipsTable,
  playersTable,
  postEventSurveyResponsesTable,
  postEventSurveysTable,
  tournamentsTable,
} from "@workspace/db";
import { uid } from "../../tests/helpers.js";
import { sendScheduledSurveyReminders } from "../postEventSurveyReminder.js";

let orgId: number;
let userIds: number[] = [];

let dueSurveyId: number;
let dueTournamentId: number;
let recentSurveyId: number;
let recentTournamentId: number;
let closedSurveyId: number;
let closedTournamentId: number;
let alreadyRemindedSurveyId: number;
let alreadyRemindedTournamentId: number;
let allSubmittedSurveyId: number;
let allSubmittedTournamentId: number;

const FOUR_DAYS_AGO = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
const ONE_DAY_AGO = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 24 * 60 * 60 * 1000);

beforeAll(async () => {
  const stamp = uid("t2011");
  const [org] = await db.insert(organizationsTable).values({
    name: `T2011 ${stamp}`, slug: `t2011-${stamp}`, subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  async function makeUser(suffix: string): Promise<number> {
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `t2011-${suffix}-${stamp}`,
      username: `t2011_${suffix}_${stamp}`,
      role: "player",
      organizationId: orgId,
    }).returning({ id: appUsersTable.id });
    userIds.push(u.id);
    await db.insert(orgMembershipsTable).values({
      organizationId: orgId, userId: u.id, role: "player",
    });
    return u.id;
  }

  const playerA = await makeUser("plA");
  const playerB = await makeUser("plB");
  const playerC = await makeUser("plC");

  // ── Due survey: sentAt 4 days ago, no reminder yet, future closesAt,
  //    two un-submitted players + one submitted player.
  const [tDue] = await db.insert(tournamentsTable).values({
    organizationId: orgId, name: `T2011 due ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  dueTournamentId = tDue.id;
  await db.insert(playersTable).values([
    { tournamentId: dueTournamentId, userId: playerA, firstName: "A", lastName: "U" },
    { tournamentId: dueTournamentId, userId: playerB, firstName: "B", lastName: "U" },
    { tournamentId: dueTournamentId, userId: playerC, firstName: "C", lastName: "U" },
  ]);
  const [dueSurvey] = await db.insert(postEventSurveysTable).values({
    tournamentId: dueTournamentId,
    organizationId: orgId,
    questions: [{ id: "q1", prompt: "Rate", type: "rating" as const }],
    sentAt: FOUR_DAYS_AGO,
    closesAt: FUTURE,
  }).returning({ id: postEventSurveysTable.id });
  dueSurveyId = dueSurvey.id;
  await db.insert(postEventSurveyResponsesTable).values({
    surveyId: dueSurveyId, userId: playerC, answers: { q1: 5 },
  });

  // ── Recent survey: sentAt only 1 day ago, must be skipped (under window).
  const [tRecent] = await db.insert(tournamentsTable).values({
    organizationId: orgId, name: `T2011 recent ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  recentTournamentId = tRecent.id;
  await db.insert(playersTable).values([
    { tournamentId: recentTournamentId, userId: playerA, firstName: "A", lastName: "U" },
  ]);
  const [recentSurvey] = await db.insert(postEventSurveysTable).values({
    tournamentId: recentTournamentId,
    organizationId: orgId,
    questions: [{ id: "q1", prompt: "Rate", type: "rating" as const }],
    sentAt: ONE_DAY_AGO,
    closesAt: FUTURE,
  }).returning({ id: postEventSurveysTable.id });
  recentSurveyId = recentSurvey.id;

  // ── Closed survey: sentAt 4 days ago but closesAt has already passed.
  const [tClosed] = await db.insert(tournamentsTable).values({
    organizationId: orgId, name: `T2011 closed ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  closedTournamentId = tClosed.id;
  await db.insert(playersTable).values([
    { tournamentId: closedTournamentId, userId: playerA, firstName: "A", lastName: "U" },
  ]);
  const [closedSurvey] = await db.insert(postEventSurveysTable).values({
    tournamentId: closedTournamentId,
    organizationId: orgId,
    questions: [{ id: "q1", prompt: "Rate", type: "rating" as const }],
    sentAt: FOUR_DAYS_AGO,
    closesAt: PAST,
  }).returning({ id: postEventSurveysTable.id });
  closedSurveyId = closedSurvey.id;

  // ── Already-reminded survey: admin already nudged (reminderSentAt set).
  const [tAlready] = await db.insert(tournamentsTable).values({
    organizationId: orgId, name: `T2011 already ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  alreadyRemindedTournamentId = tAlready.id;
  await db.insert(playersTable).values([
    { tournamentId: alreadyRemindedTournamentId, userId: playerA, firstName: "A", lastName: "U" },
  ]);
  const [alreadySurvey] = await db.insert(postEventSurveysTable).values({
    tournamentId: alreadyRemindedTournamentId,
    organizationId: orgId,
    questions: [{ id: "q1", prompt: "Rate", type: "rating" as const }],
    sentAt: FOUR_DAYS_AGO,
    closesAt: FUTURE,
    reminderSentAt: ONE_DAY_AGO,
  }).returning({ id: postEventSurveysTable.id });
  alreadyRemindedSurveyId = alreadySurvey.id;

  // ── All-submitted survey: due window but every roster player already
  //    answered, so cron should run the helper, get 0 recipients, and leave
  //    `reminderSentAt` null (so a future late registration is still
  //    eligible — same semantics as the admin endpoint).
  const [tAll] = await db.insert(tournamentsTable).values({
    organizationId: orgId, name: `T2011 all ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  allSubmittedTournamentId = tAll.id;
  await db.insert(playersTable).values([
    { tournamentId: allSubmittedTournamentId, userId: playerA, firstName: "A", lastName: "U" },
  ]);
  const [allSurvey] = await db.insert(postEventSurveysTable).values({
    tournamentId: allSubmittedTournamentId,
    organizationId: orgId,
    questions: [{ id: "q1", prompt: "Rate", type: "rating" as const }],
    sentAt: FOUR_DAYS_AGO,
    closesAt: FUTURE,
  }).returning({ id: postEventSurveysTable.id });
  allSubmittedSurveyId = allSurvey.id;
  await db.insert(postEventSurveyResponsesTable).values({
    surveyId: allSubmittedSurveyId, userId: playerA, answers: { q1: 5 },
  });
});

afterAll(async () => {
  const surveyIds = [
    dueSurveyId,
    recentSurveyId,
    closedSurveyId,
    alreadyRemindedSurveyId,
    allSubmittedSurveyId,
  ];
  await db.delete(postEventSurveyResponsesTable)
    .where(inArray(postEventSurveyResponsesTable.surveyId, surveyIds));
  await db.delete(postEventSurveysTable)
    .where(inArray(postEventSurveysTable.id, surveyIds));

  const tournamentIds = [
    dueTournamentId,
    recentTournamentId,
    closedTournamentId,
    alreadyRemindedTournamentId,
    allSubmittedTournamentId,
  ];
  await db.delete(playersTable).where(inArray(playersTable.tournamentId, tournamentIds));
  await db.delete(tournamentsTable).where(inArray(tournamentsTable.id, tournamentIds));

  await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, userIds));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("sendScheduledSurveyReminders", () => {
  it("reminds only due surveys, stamps reminderSentAt, and is idempotent on a second run", async () => {
    const summary = await sendScheduledSurveyReminders();

    // The job should have considered the due + all-submitted surveys (both
    // pass the window/closes filters). Only the due one actually dispatches.
    expect(summary.surveysReminded).toBe(1);
    expect(summary.remindersSent).toBe(2); // playerC already submitted → only A and B remain

    const [dueRow] = await db.select({ reminderSentAt: postEventSurveysTable.reminderSentAt })
      .from(postEventSurveysTable).where(eq(postEventSurveysTable.id, dueSurveyId));
    expect(dueRow.reminderSentAt).toBeTruthy();
    const firstStamp = dueRow.reminderSentAt!;

    // Recent / closed / already-reminded must NOT be touched.
    const [recentRow] = await db.select({ reminderSentAt: postEventSurveysTable.reminderSentAt })
      .from(postEventSurveysTable).where(eq(postEventSurveysTable.id, recentSurveyId));
    expect(recentRow.reminderSentAt).toBeNull();

    const [closedRow] = await db.select({ reminderSentAt: postEventSurveysTable.reminderSentAt })
      .from(postEventSurveysTable).where(eq(postEventSurveysTable.id, closedSurveyId));
    expect(closedRow.reminderSentAt).toBeNull();

    const [alreadyRow] = await db.select({ reminderSentAt: postEventSurveysTable.reminderSentAt })
      .from(postEventSurveysTable).where(eq(postEventSurveysTable.id, alreadyRemindedSurveyId));
    // Stamp already existed when the test started; cron must leave it
    // alone (and the WHERE filter excludes it from the candidate set).
    expect(alreadyRow.reminderSentAt).not.toBeNull();
    expect(alreadyRow.reminderSentAt!.getTime()).toBe(ONE_DAY_AGO.getTime());

    // All-submitted survey: helper runs but finds 0 recipients, leaves
    // reminderSentAt null so a future late registration is still eligible.
    const [allRow] = await db.select({ reminderSentAt: postEventSurveysTable.reminderSentAt })
      .from(postEventSurveysTable).where(eq(postEventSurveysTable.id, allSubmittedSurveyId));
    expect(allRow.reminderSentAt).toBeNull();

    // Re-run: the now-stamped due survey is filtered out by the candidate
    // query, so the second run reports zero. The all-submitted survey is
    // re-checked but still produces zero recipients — no flapping stamps.
    const second = await sendScheduledSurveyReminders();
    expect(second.surveysReminded).toBe(0);
    expect(second.remindersSent).toBe(0);

    const [dueRow2] = await db.select({ reminderSentAt: postEventSurveysTable.reminderSentAt })
      .from(postEventSurveysTable).where(eq(postEventSurveysTable.id, dueSurveyId));
    expect(dueRow2.reminderSentAt!.getTime()).toBe(firstStamp.getTime());
  });
});
