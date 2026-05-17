/**
 * Wave 2 (Task #937) — load-bearing endpoints.
 *
 *   POST /api/portal/course-corrections                          — player report
 *   GET  /api/organizations/:orgId/course-corrections            — admin queue
 *   POST /api/organizations/:orgId/course-corrections/:id/resolve — accept/reject
 *   GET  /api/portal/handicap/explain                            — index breakdown
 *   POST /api/organizations/:orgId/tournaments/:tid/cut          — apply cut line
 *   POST /api/organizations/:orgId/tournaments/:tid/survey/send  — schedule survey
 *   POST /api/portal/tee-bookings/:bookingId/cancel-and-promote  — auto-promote
 *   GET  /api/match-play/form-guide                              — head-to-head
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import {
  db,
  courseDataCorrectionsTable,
  postEventSurveysTable,
  postEventSurveyResponsesTable,
  postEventSurveyTemplatesTable,
  tournamentsTable,
  whsScoreRecordsTable,
  handicapHistoryTable,
  bracketMatchesTable,
  matchPlayBracketTable,
  teeBookingsTable,
  appUsersTable,
  playersTable,
  organizationsTable,
  orgMembershipsTable,
} from "@workspace/db";
import type { AuthUser } from "@workspace/api-zod";
import { requireOrgAdmin } from "../lib/permissions";
import { applyCut } from "../lib/cutHandler.js";
import { promoteFromWaitlist } from "../lib/teeWaitlistPromote.js";
import { dispatchNotification } from "../lib/notifyDispatch.js";
import type { EmailBranding } from "../lib/mailer.js";
import { resolveOrgBranding } from "../lib/clubTheming.js";
import { dispatchPostEventSurveyReminder } from "../lib/postEventSurveyReminder.js";

/**
 * Task #1171 — small helper to fetch the org's branding fields so the
 * dispatcher's branded email renderer can stamp the right logo /
 * primary colour / club name onto outgoing notification emails.
 * Returns `undefined` (not null) so the renderer's optional-chaining
 * paths work cleanly.
 *
 * Task #1438 — when the org has saved a custom theme via the
 * club-theming UI, prefer that logo/primary colour over the legacy
 * `organizations.logo_url` / `organizations.primary_color` columns.
 * `resolveOrgBranding` handles the merge.
 */
async function loadOrgBrandingForNotify(orgId: number): Promise<EmailBranding | undefined> {
  try {
    const [org] = await db.select({
      name: organizationsTable.name,
      logoUrl: organizationsTable.logoUrl,
      primaryColor: organizationsTable.primaryColor,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId)).limit(1);
    if (!org) return undefined;
    const merged = await resolveOrgBranding(orgId, org);
    return { orgId, ...merged };
  } catch {
    return undefined;
  }
}

const router: IRouter = Router();

function requireAuth(req: Request, res: Response): boolean {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return false; }
  return true;
}

/**
 * Task #1633 — Build a (userId → display label) lookup for a batch of survey
 * responses, falling back from `displayName` → `username` → "Anonymous".
 * Returns a function that resolves a `userId | null` to its label so callers
 * don't have to repeat the null/missing handling at every call site.
 *
 * Anonymous responses (userId = null, set when a respondent's account is
 * deleted or when the survey was answered without auth) always resolve to
 * the literal string "Anonymous".
 */
async function buildRespondentLabelLookup(
  responses: Array<{ userId: number | null }>,
): Promise<(userId: number | null) => string> {
  const userIds = Array.from(
    new Set(
      responses
        .map((r) => r.userId)
        .filter((u): u is number => u != null),
    ),
  );
  const labels = new Map<number, string>();
  if (userIds.length > 0) {
    const rows = await db
      .select({
        id: appUsersTable.id,
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
      })
      .from(appUsersTable)
      .where(inArray(appUsersTable.id, userIds));
    for (const u of rows) {
      labels.set(u.id, u.displayName ?? u.username ?? "Anonymous");
    }
  }
  return (userId: number | null) => {
    if (userId == null) return "Anonymous";
    return labels.get(userId) ?? "Anonymous";
  };
}

// ─── COURSE DATA CORRECTIONS ───────────────────────────────────────────────

router.post("/portal/course-corrections", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const { courseId, organizationId, holeNumber, fieldName, currentValue, proposedValue, reason } = req.body ?? {};
  if (!courseId || !organizationId || !fieldName || proposedValue == null) {
    res.status(400).json({ error: "courseId, organizationId, fieldName, proposedValue required" });
    return;
  }
  const [row] = await db.insert(courseDataCorrectionsTable).values({
    courseId: Number(courseId),
    organizationId: Number(organizationId),
    holeNumber: holeNumber != null ? Number(holeNumber) : null,
    fieldName: String(fieldName),
    currentValue: currentValue != null ? String(currentValue) : null,
    proposedValue: String(proposedValue),
    reason: reason ? String(reason) : null,
    reportedByUserId: req.user!.id,
  }).returning();
  res.status(201).json({ correction: row });
});

router.get("/portal/course-corrections/mine", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const rows = await db.select().from(courseDataCorrectionsTable)
    .where(eq(courseDataCorrectionsTable.reportedByUserId, req.user!.id))
    .orderBy(desc(courseDataCorrectionsTable.createdAt))
    .limit(100);
  res.json({ corrections: rows });
});

router.get("/organizations/:orgId/course-corrections", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const status = (req.query.status as string | undefined) ?? "open";
  const rows = await db.select().from(courseDataCorrectionsTable)
    .where(and(
      eq(courseDataCorrectionsTable.organizationId, orgId),
      // Only filter by status if it's one of the enum values; otherwise return all.
      ["open", "accepted", "rejected"].includes(status)
        ? eq(courseDataCorrectionsTable.status, status as "open" | "accepted" | "rejected")
        : sql`true`,
    ))
    .orderBy(desc(courseDataCorrectionsTable.createdAt))
    .limit(200);
  res.json({ corrections: rows });
});

router.post("/organizations/:orgId/course-corrections/:id/resolve", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const id = Number((req.params as Record<string, string>).id);
  const { decision, reviewNotes } = req.body ?? {};
  if (!["accepted", "rejected"].includes(decision)) {
    res.status(400).json({ error: "decision must be 'accepted' or 'rejected'" });
    return;
  }
  const [updated] = await db.update(courseDataCorrectionsTable)
    .set({
      status: decision,
      reviewedByUserId: req.user!.id,
      reviewedAt: new Date(),
      reviewNotes: reviewNotes ? String(reviewNotes) : null,
    })
    .where(and(
      eq(courseDataCorrectionsTable.id, id),
      eq(courseDataCorrectionsTable.organizationId, orgId),
    ))
    .returning();
  if (!updated) { { res.status(404).json({ error: "correction not found" }); return; } }

  // Notify the player who reported the correction. Fire-and-forget — the
  // resolve action has already succeeded; a delivery failure must not
  // surface as a 500.
  if (updated.reportedByUserId) {
    const verb = decision === "accepted" ? "accepted" : "rejected";
    // Task #1171 — drop the inline `emailHtml` snippet; the branded
    // renderer in `notificationEmailTemplates.ts` consumes these
    // structured fields and produces the club-branded layout used by
    // every other transactional email.
    const branding = await loadOrgBrandingForNotify(orgId);
    // Task #1357 — supply a deep-link the branded template can render
    // as a CTA button, so the recipient lands directly on the
    // resolution page from the email.
    const baseUrl = process.env.PUBLIC_BASE_URL ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`;
    const correctionUrl = `${baseUrl.replace(/\/$/, "")}/portal/course-corrections/${updated.id}`;
    dispatchNotification("course.correction.resolved", [updated.reportedByUserId], {
      title: `Course correction ${verb}`,
      body: `Your reported change to ${updated.fieldName}${updated.holeNumber != null ? ` on hole ${updated.holeNumber}` : ""} was ${verb}.`,
      data: {
        type: "course_correction_resolved",
        correctionId: updated.id,
        decision,
        organizationId: orgId,
        fieldName: updated.fieldName,
        holeNumber: updated.holeNumber,
        reviewNotes: updated.reviewNotes,
        correctionUrl,
      },
      branding,
    }).catch((err: unknown) => { /* logged inside dispatcher */ void err; });
  }
  res.json({ correction: updated });
});

// ─── HANDICAP EXPLAIN ──────────────────────────────────────────────────────

router.get("/portal/handicap/explain", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const userId = req.user!.id;

  // Pull the most recent 20 score records (the WHS rolling window).
  const records = await db.select()
    .from(whsScoreRecordsTable)
    .where(eq(whsScoreRecordsTable.userId, userId))
    .orderBy(desc(whsScoreRecordsTable.playedAt))
    .limit(20);

  // The lowest 8 of the last 20 differentials are the ones used in the index.
  const sortedByDiff = records
    .filter(r => r.finalDifferential != null)
    .map((r, i) => ({ ...r, _origIdx: i }))
    .sort((a, b) => Number(a.finalDifferential) - Number(b.finalDifferential));
  const usedRowIds = new Set(sortedByDiff.slice(0, 8).map(r => r.id));

  const explained = records.map(r => ({
    id: r.id,
    playedAt: r.playedAt,
    courseId: r.courseId,
    courseRating: r.courseRating,
    slopeRating: r.slopeRating,
    grossScore: r.grossScore,
    adjustedGrossScore: r.adjustedGrossScore,
    pccAdjustment: r.pccAdjustment,
    rawDifferential: r.rawDifferential,
    esrAdjustment: r.esrAdjustment,
    finalDifferential: r.finalDifferential,
    is9Hole: r.is9Hole,
    handicapIndexAfter: r.handicapIndexAfter,
    usedInIndex: usedRowIds.has(r.id),
    exceptional: r.esrAdjustment != null && Number(r.esrAdjustment) !== 0,
  }));

  // Current index = most recent handicap_history row, with fall-back.
  const [latestHistory] = await db.select()
    .from(handicapHistoryTable)
    .where(eq(handicapHistoryTable.userId, userId))
    .orderBy(desc(handicapHistoryTable.recordedAt))
    .limit(1);

  res.json({
    currentIndex: latestHistory?.handicapIndex ?? records[0]?.handicapIndexAfter ?? null,
    rollingWindow: explained,
    used: explained.filter(e => e.usedInIndex).length,
    total: explained.length,
    note: "WHS uses the lowest 8 of your last 20 score differentials. Records flagged 'exceptional' triggered an ESR reduction.",
  });
});

// ─── TOURNAMENT CUT ────────────────────────────────────────────────────────

router.post("/organizations/:orgId/tournaments/:tid/cut", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const tid = Number((req.params as Record<string, string>).tid);

  // Architect-flagged IDOR fix: prove the tournament belongs to this org
  // BEFORE invoking applyCut. Otherwise an admin of org A could cut a
  // tournament in org B by id.
  const [owned] = await db.select({ id: tournamentsTable.id })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tid), eq(tournamentsTable.organizationId, orgId)))
    .limit(1);
  if (!owned) { { res.status(404).json({ error: "tournament not found in this organization" }); return; } }

  const throughRound = Number(req.body?.throughRound ?? 2);
  const result = await applyCut(tid, throughRound);
  if (!result.applied) {
    res.status(409).json({ error: result.reason, ...result });
    return;
  }
  // Pull the tournament name + branding once so the per-survivor /
  // per-cut dispatch below can render personalised "made"/"missed"
  // copy in the branded template.
  const [tournamentRow] = await db.select({ name: tournamentsTable.name })
    .from(tournamentsTable).where(eq(tournamentsTable.id, tid)).limit(1);
  const branding = await loadOrgBrandingForNotify(orgId);

  // Notify every registered player. cutHandler returns survivor + cut
  // arrays keyed by playerId; resolve those to app-user ids so the
  // dispatcher can reach the right inboxes / push tokens.
  const allPlayerIds = [...result.survivors, ...result.cut].map(p => p.playerId);
  const survivorIds = new Set(result.survivors.map(p => p.playerId));
  let playerToUser: Array<{ playerId: number; userId: number }> = [];
  if (allPlayerIds.length > 0) {
    const userRows = await db.select({ playerId: playersTable.id, userId: playersTable.userId })
      .from(playersTable)
      .where(inArray(playersTable.id, allPlayerIds));
    playerToUser = userRows
      .filter((r): r is { playerId: number; userId: number } => r.userId != null);
  }

  // Task #1171 — fan out per-recipient so the branded template can
  // render the correct made/missed-the-cut copy. The dispatcher still
  // batches DB calls (prefs / addresses) when more than one recipient
  // shares the same call.
  const made = playerToUser.filter(r => survivorIds.has(r.playerId)).map(r => r.userId);
  const missed = playerToUser.filter(r => !survivorIds.has(r.playerId)).map(r => r.userId);
  const tournamentName = tournamentRow?.name ?? "Tournament";

  // Task #1357 — supply deep-links so the branded "made the cut" /
  // "missed the cut" templates can render their CTA buttons. Survivors
  // get a link to the round-3 grouping; eliminated players get the
  // public leaderboard.
  const baseUrl = process.env.PUBLIC_BASE_URL ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`;
  const cleanBase = baseUrl.replace(/\/$/, "");
  const groupingUrl = `${cleanBase}/portal/tournaments/${tid}/grouping`;
  const leaderboardUrl = `${cleanBase}/leaderboard/${tid}`;

  if (made.length > 0) {
    dispatchNotification("tournament.cut.applied", made, {
      title: `${tournamentName} — you made the cut`,
      body: `The cut has been set after round ${throughRound}. Round 3 groupings are published.`,
      data: {
        type: "tournament_cut_applied",
        tournamentId: tid,
        tournamentName,
        throughRound,
        madeCut: true,
        groupingUrl,
        leaderboardUrl,
      },
      branding,
    }).catch((err: unknown) => { void err; });
  }
  if (missed.length > 0) {
    dispatchNotification("tournament.cut.applied", missed, {
      title: `${tournamentName} — cut applied`,
      body: `The cut has been set after round ${throughRound}.`,
      data: {
        type: "tournament_cut_applied",
        tournamentId: tid,
        tournamentName,
        throughRound,
        madeCut: false,
        leaderboardUrl,
      },
      branding,
    }).catch((err: unknown) => { void err; });
  }
  res.json(result);
});

// ─── POST-EVENT SURVEY SCHEDULING ──────────────────────────────────────────

router.post("/organizations/:orgId/tournaments/:tid/survey/send", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const tid = Number((req.params as Record<string, string>).tid);
  const { questions, closesAt } = req.body ?? {};

  // Verify tournament belongs to org.
  const [t] = await db.select({ id: tournamentsTable.id })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tid), eq(tournamentsTable.organizationId, orgId)))
    .limit(1);
  if (!t) { { res.status(404).json({ error: "tournament not found" }); return; } }

  const [survey] = await db.insert(postEventSurveysTable).values({
    tournamentId: tid,
    organizationId: orgId,
    questions: Array.isArray(questions) ? questions : [],
    sentAt: new Date(),
    closesAt: closesAt ? new Date(closesAt) : null,
  }).onConflictDoUpdate({
    target: postEventSurveysTable.tournamentId,
    set: {
      questions: Array.isArray(questions) ? questions : [],
      sentAt: new Date(),
      closesAt: closesAt ? new Date(closesAt) : null,
    },
  }).returning();

  // Notify every player who appeared in the tournament. Pulls the
  // distinct user ids from the players roster.
  const playerRows = await db.select({ userId: playersTable.userId })
    .from(playersTable)
    .where(eq(playersTable.tournamentId, tid));
  const recipients = Array.from(new Set(
    playerRows.map(r => r.userId).filter((u): u is number => u != null),
  ));
  if (recipients.length > 0) {
    // Task #1171 — let the branded renderer build the email; pass
    // `tournamentName`, `surveyUrl`, and `branding` so the layout
    // matches every other transactional email from this club.
    const [tournamentRow] = await db.select({ name: tournamentsTable.name })
      .from(tournamentsTable).where(eq(tournamentsTable.id, tid)).limit(1);
    const branding = await loadOrgBrandingForNotify(orgId);
    // Task #1621 — emit an absolute deep-link so the branded
    // template's CTA button works in email clients (which can't
    // resolve relative URLs). Mirrors the cut/correction sites above
    // so every wave2 dispatch shares the same URL-build pattern.
    const baseUrl = process.env.PUBLIC_BASE_URL ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`;
    const surveyUrl = `${baseUrl.replace(/\/$/, "")}/portal/surveys/${survey.id}`;
    dispatchNotification("post.event.survey", recipients, {
      title: "How was the event?",
      body: "Tap to share quick feedback about the event you just played.",
      data: {
        type: "post_event_survey",
        surveyId: survey.id,
        tournamentId: tid,
        tournamentName: tournamentRow?.name ?? "the event you just played",
        surveyUrl,
      },
      branding,
    }).catch((err: unknown) => { void err; });
  }
  res.status(201).json({ survey });
});

/**
 * Task #1625 — POST /organizations/:orgId/tournaments/:tid/survey/remind
 *
 * Nudge the players who registered for the tournament but never submitted
 * to the post-event survey. Re-uses the `post.event.survey` notification
 * key (already wired through the dispatcher with branded i18n templates,
 * registry, and coverage entry) but overrides the push title/body and
 * email subject so the recipient can tell this is a follow-up rather than
 * the original invitation.
 *
 * Done looks like (from the task brief):
 *   • Admin-only (requireOrgAdmin) action
 *   • Only un-submitted, registered players are notified
 *   • `postEventSurveysTable.reminderSentAt` is stamped when the reminder fires
 *   • Idempotent — once `reminderSentAt` is set, repeat calls are 409
 *     (one reminder per survey is the agreed window)
 *
 * Edge cases:
 *   • No survey for the tournament → 404
 *   • Tournament not in the caller's org → 404 (IDOR)
 *   • Survey is closed (`closesAt` already passed) → 410, no point asking
 *     for feedback the portal won't accept
 *   • Every registered player has already submitted → 200 with
 *     `remindersSent: 0` and `reminderSentAt` is left untouched, so a
 *     future late registration could still be reminded if the admin
 *     re-runs the action.
 */
router.post("/organizations/:orgId/tournaments/:tid/survey/remind", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const tid = Number((req.params as Record<string, string>).tid);

  const [tournament] = await db.select({ id: tournamentsTable.id, name: tournamentsTable.name })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tid), eq(tournamentsTable.organizationId, orgId)))
    .limit(1);
  if (!tournament) { { res.status(404).json({ error: "tournament not found" }); return; } }

  const [survey] = await db.select().from(postEventSurveysTable)
    .where(eq(postEventSurveysTable.tournamentId, tid))
    .limit(1);
  if (!survey) { { res.status(404).json({ error: "no survey for tournament" }); return; } }

  // Task #2011 — recipient filtering, race-safe stamping, and dispatch are
  // now factored into `dispatchPostEventSurveyReminder` so the daily cron
  // can call the same code path. The route still maps the result kinds to
  // the HTTP semantics the admin UI expects (409 already-sent, 410 closed,
  // 200 with `remindersSent`/`reminderSentAt`).
  // Task #2012 — per-recipient push/email localisation lives inside that
  // shared library now (groups recipients by `preferredLanguage` and uses
  // `translatePostEventSurveyReminderPush` per bucket), so both this admin
  // route AND the cron emit localised reminders without duplication here.
  const result = await dispatchPostEventSurveyReminder({
    surveyId: survey.id,
    tournamentId: tid,
    tournamentName: tournament.name,
    organizationId: orgId,
    reminderSentAt: survey.reminderSentAt,
    closesAt: survey.closesAt,
  });

  switch (result.kind) {
    case "already_sent":
      res.status(409).json({
        error: "reminder already sent",
        reminderSentAt: result.reminderSentAt,
      });
      return;
    case "closed":
      res.status(410).json({ error: "survey is closed" });
      return;
    case "no_recipients":
      res.json({
        remindersSent: 0,
        reminderSentAt: null,
        note: "every registered player has already submitted or has no linked account",
      });
      return;
    case "sent":
      res.json({
        remindersSent: result.remindersSent,
        reminderSentAt: result.reminderSentAt,
      });
      return;
  }
});

// Task #1634 / #2028 — shared ISO 8601 from/to parser. The CSV export
// (Task #1634) and the windowed count endpoint (Task #2028) accept the same
// `from`/`to` query params so admins picking a tight window can see
// "X of Y responses in window" without downloading the file. We accept the
// common ISO 8601 date and date-time forms (with optional fractional seconds
// and a Z / ±hh:mm timezone) and reject anything `new Date()` would otherwise
// loosely accept (e.g. "Jan 1, 2026").
const SURVEY_RANGE_ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
function parseSurveyRangeParam(raw: unknown, name: "from" | "to"): Date | null | { error: string } {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !SURVEY_RANGE_ISO_8601_RE.test(raw)) {
    return { error: `invalid '${name}' query param: expected ISO 8601 date string` };
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return { error: `invalid '${name}' query param: expected ISO 8601 date string` };
  }
  return d;
}

router.get("/organizations/:orgId/tournaments/:tid/survey/responses", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const tid = Number((req.params as Record<string, string>).tid);

  // Confirm tournament belongs to this org (avoid IDOR).
  const [t] = await db.select({ id: tournamentsTable.id })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tid), eq(tournamentsTable.organizationId, orgId)))
    .limit(1);
  if (!t) { { res.status(404).json({ error: "tournament not found" }); return; } }

  // Eligible pool — registered players for this tournament. Surfacing this
  // alongside `totalResponses` lets the admin panel render a response rate
  // (e.g. "12 / 48 (25%)") so 12 responses can be read as great or terrible
  // instead of a number with no denominator. (Task #1626)
  const [{ count: eligiblePlayersRaw } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(playersTable)
    .where(eq(playersTable.tournamentId, tid));
  const eligiblePlayers = Number(eligiblePlayersRaw ?? 0);

  const [survey] = await db.select().from(postEventSurveysTable)
    .where(eq(postEventSurveysTable.tournamentId, tid))
    .limit(1);
  if (!survey) {
    res.json({ survey: null, totalResponses: 0, eligiblePlayers, aggregates: [] });
    return;
  }

  const responses = await db.select().from(postEventSurveyResponsesTable)
    .where(eq(postEventSurveyResponsesTable.surveyId, survey.id))
    .orderBy(desc(postEventSurveyResponsesTable.submittedAt));

  // Task #1633 — resolve a display label for each respondent so the text
  // answers list (and the CSV export below) can identify who said what.
  // `userId` is `set null` on user delete for the anonymous case, which we
  // surface as the literal string "Anonymous" in both endpoints.
  const respondentLabel = await buildRespondentLabelLookup(responses);

  type QuestionShape = { id: string; type: "rating" | "text" | "boolean"; prompt?: string; label?: string };
  type RatingAggregate = { id: string; label: string; type: "rating"; count: number; average: number | null; distribution: Record<string, number> };
  type BooleanAggregate = { id: string; label: string; type: "boolean"; count: number; yes: number; no: number };
  type TextAggregate = { id: string; label: string; type: "text"; count: number; answers: Array<{ text: string; respondent: string; submittedAt: string }> };
  type Aggregate = RatingAggregate | BooleanAggregate | TextAggregate;

  const questions = (survey.questions ?? []) as QuestionShape[];
  const aggregates: Aggregate[] = questions.map((q) => {
    const label = q.prompt ?? q.label ?? q.id;
    if (q.type === "rating") {
      const values: number[] = [];
      for (const r of responses) {
        const raw = (r.answers as Record<string, unknown>)[q.id];
        const n = Number(raw);
        if (Number.isFinite(n)) values.push(n);
      }
      const distribution: Record<string, number> = {};
      for (const v of values) {
        const k = String(Math.round(v));
        distribution[k] = (distribution[k] ?? 0) + 1;
      }
      const average = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
      return { id: q.id, label, type: "rating", count: values.length, average, distribution };
    }
    if (q.type === "boolean") {
      let yes = 0, no = 0;
      for (const r of responses) {
        const v = (r.answers as Record<string, unknown>)[q.id];
        if (v === true) { yes++; continue; }
        if (v === false) { no++; continue; }
        if (typeof v === "string") {
          const norm = v.trim().toLowerCase();
          if (norm === "yes" || norm === "true") yes++;
          else if (norm === "no" || norm === "false") no++;
        }
      }
      return { id: q.id, label, type: "boolean", count: yes + no, yes, no };
    }
    const answers: Array<{ text: string; respondent: string; submittedAt: string }> = [];
    for (const r of responses) {
      const v = (r.answers as Record<string, unknown>)[q.id];
      if (typeof v === "string" && v.trim().length > 0) {
        answers.push({
          text: v.trim(),
          respondent: respondentLabel(r.userId),
          submittedAt: r.submittedAt.toISOString(),
        });
      }
    }
    return { id: q.id, label, type: "text", count: answers.length, answers };
  });

  res.json({
    survey: {
      id: survey.id,
      sentAt: survey.sentAt,
      reminderSentAt: survey.reminderSentAt,
      closesAt: survey.closesAt,
      questions: survey.questions,
    },
    totalResponses: responses.length,
    eligiblePlayers,
    aggregates,
  });
});

// Task #2028 — lightweight windowed-count companion to the JSON
// `survey/responses` endpoint above. Powers the "X of Y responses in window"
// hint that admins see next to the export date pickers, so they can sanity
// check a tight window without downloading the CSV first.
//
// Returns just `{ count }` rather than re-aggregating every answer — the
// panel already has the unfiltered totals from `survey/responses` and just
// needs the windowed numerator. Accepts the same `from`/`to` ISO 8601 query
// params (and the same validation rules) as the CSV export endpoint so
// admins always see numbers consistent with what the export will contain.
router.get("/organizations/:orgId/tournaments/:tid/survey/responses/count", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const tid = Number((req.params as Record<string, string>).tid);

  const fromParsed = parseSurveyRangeParam(req.query.from, "from");
  if (fromParsed && typeof fromParsed === "object" && "error" in fromParsed) {
    res.status(400).json({ error: fromParsed.error }); return;
  }
  const toParsed = parseSurveyRangeParam(req.query.to, "to");
  if (toParsed && typeof toParsed === "object" && "error" in toParsed) {
    res.status(400).json({ error: toParsed.error }); return;
  }
  const fromDate = fromParsed as Date | null;
  const toDate = toParsed as Date | null;
  if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
    res.status(400).json({ error: "'from' must be on or before 'to'" }); return;
  }

  // Confirm tournament belongs to this org (avoid IDOR), same shape as the
  // sibling endpoints above.
  const [t] = await db.select({ id: tournamentsTable.id })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tid), eq(tournamentsTable.organizationId, orgId)))
    .limit(1);
  if (!t) { res.status(404).json({ error: "tournament not found" }); return; }

  // No survey yet → nothing to count. Return 0 (instead of 404) so the
  // frontend hint can fall back gracefully without a special error path.
  const [survey] = await db.select({ id: postEventSurveysTable.id }).from(postEventSurveysTable)
    .where(eq(postEventSurveysTable.tournamentId, tid))
    .limit(1);
  if (!survey) { res.json({ count: 0 }); return; }

  const conditions = [eq(postEventSurveyResponsesTable.surveyId, survey.id)];
  if (fromDate) conditions.push(gte(postEventSurveyResponsesTable.submittedAt, fromDate));
  if (toDate) conditions.push(lte(postEventSurveyResponsesTable.submittedAt, toDate));

  const [{ count: countRaw } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(postEventSurveyResponsesTable)
    .where(and(...conditions));

  res.json({ count: Number(countRaw ?? 0) });
});

// Task #2009 — batch survey-response summaries for the admin tournament list.
//
// The single-tournament endpoint above already returns `totalResponses` and
// `eligiblePlayers` for one tournament, but the admin tournament list shows
// dozens of cards at once. Calling that endpoint per card would N+1 the API
// (and re-aggregate every text/rating/boolean answer for nothing) just to
// render a "12 / 48 — 25%" badge. This endpoint returns one row per
// tournament in the org that has had a survey actually sent, so the list
// page can highlight low-engagement tournaments at a glance.
//
// Tournaments without a sent survey are simply omitted from the response —
// the list page treats "missing" the same as "no badge", which keeps the
// shape stable as more tournaments get surveys over time.
//
// NOTE: the path lives under `/organizations/:orgId/survey-response-summaries`
// rather than `/tournaments/survey-summaries` because the tournaments
// router (registered earlier) has a greedy `GET /:tournamentId` handler
// that would otherwise swallow the request and try to parse
// "survey-summaries" as an integer ID.
router.get("/organizations/:orgId/survey-response-summaries", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!Number.isFinite(orgId)) { res.status(400).json({ error: "invalid orgId" }); return; }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  // Sent surveys for this org. `organization_id` lives on the survey row
  // itself so we can scope without a join (and we still constrain by
  // `sent_at IS NOT NULL` so a draft/scheduled survey doesn't get a 0%
  // badge before the email has actually gone out). The schema enforces
  // `post_event_surveys.tournament_id UNIQUE`, so at most one row per
  // tournament — the response Map on the frontend can safely key by it.
  const sentSurveys = await db
    .select({
      surveyId: postEventSurveysTable.id,
      tournamentId: postEventSurveysTable.tournamentId,
      sentAt: postEventSurveysTable.sentAt,
    })
    .from(postEventSurveysTable)
    .where(and(
      eq(postEventSurveysTable.organizationId, orgId),
      isNotNull(postEventSurveysTable.sentAt),
    ));

  if (sentSurveys.length === 0) { res.json([]); return; }

  const surveyIds = sentSurveys.map((s) => s.surveyId);
  const tournamentIds = sentSurveys.map((s) => s.tournamentId);

  // Two grouped queries (responses by survey, players by tournament) +
  // an in-memory join, so the wall-clock cost is independent of the
  // number of tournaments being summarised.
  const responseCounts = await db
    .select({
      surveyId: postEventSurveyResponsesTable.surveyId,
      count: sql<number>`count(*)::int`,
    })
    .from(postEventSurveyResponsesTable)
    .where(inArray(postEventSurveyResponsesTable.surveyId, surveyIds))
    .groupBy(postEventSurveyResponsesTable.surveyId);
  const responsesBySurveyId = new Map<number, number>(
    responseCounts.map((r) => [r.surveyId, Number(r.count ?? 0)]),
  );

  const playerCounts = await db
    .select({
      tournamentId: playersTable.tournamentId,
      count: sql<number>`count(*)::int`,
    })
    .from(playersTable)
    .where(inArray(playersTable.tournamentId, tournamentIds))
    .groupBy(playersTable.tournamentId);
  const playersByTournamentId = new Map<number, number>(
    playerCounts.map((p) => [p.tournamentId, Number(p.count ?? 0)]),
  );

  const summaries = sentSurveys.map((s) => ({
    tournamentId: s.tournamentId,
    sentAt: s.sentAt,
    totalResponses: responsesBySurveyId.get(s.surveyId) ?? 0,
    eligiblePlayers: playersByTournamentId.get(s.tournamentId) ?? 0,
  }));

  res.json(summaries);
});

// ─── POST-EVENT SURVEY — PLAYER-FACING SUBMIT FLOW ────────────────────────
//
// Task #1363 — admins can already schedule a post-event survey and read the
// aggregated responses, but the player-facing route to actually answer one
// (linked from the notification email body as `/portal/surveys/:surveyId`)
// did not exist. These two endpoints close that loop:
//
//   GET  /portal/surveys/:surveyId — fetch the questions for a registered
//        player. Returns 404 if the survey doesn't exist, 403 if the caller
//        wasn't a player in the tournament, and `closed: true` once
//        `closesAt` has passed (the page still shows the questions but the
//        submit form is disabled). Also returns whether the caller has
//        already submitted so the page can render the thank-you state on
//        re-visits without writing.
//
//   POST /portal/surveys/:surveyId — store the player's answers. Validates
//        each answer against the question shape (rating → number, boolean
//        → bool, text → string), rejects unknown question ids silently,
//        rejects late submissions with 410 Gone, and returns 409 Conflict
//        if the player already submitted (one response per user per
//        survey). The schema's `userId` is `set null` on user delete, so
//        we enforce uniqueness in code rather than via a new index.

type SurveyQuestion = { id: string; prompt: string; type: "rating" | "text" | "boolean" };

function normalizeAnswers(
  questions: SurveyQuestion[],
  raw: unknown,
): { ok: true; answers: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "answers must be an object keyed by question id" };
  }
  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const q of questions) {
    if (!(q.id in input)) continue; // unanswered questions are allowed (skip)
    const v = input[q.id];
    if (v == null || (typeof v === "string" && v.trim() === "")) continue;
    if (q.type === "rating") {
      const n = Number(v);
      if (!Number.isFinite(n)) return { ok: false, error: `answer for "${q.id}" must be a number` };
      out[q.id] = n;
    } else if (q.type === "boolean") {
      if (typeof v === "boolean") { out[q.id] = v; continue; }
      if (typeof v === "string") {
        const norm = v.trim().toLowerCase();
        if (norm === "yes" || norm === "true") { out[q.id] = true; continue; }
        if (norm === "no" || norm === "false") { out[q.id] = false; continue; }
      }
      return { ok: false, error: `answer for "${q.id}" must be a boolean` };
    } else {
      // text — cap at 2000 chars to match other free-text inputs and avoid
      // a stray paste blowing past sensible limits.
      if (typeof v !== "string") return { ok: false, error: `answer for "${q.id}" must be a string` };
      out[q.id] = v.trim().slice(0, 2000);
    }
  }
  return { ok: true, answers: out };
}

router.get("/portal/surveys/:surveyId", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const surveyId = Number((req.params as Record<string, string>).surveyId);
  if (!Number.isFinite(surveyId)) { { res.status(400).json({ error: "invalid surveyId" }); return; } }

  const [survey] = await db.select().from(postEventSurveysTable)
    .where(eq(postEventSurveysTable.id, surveyId))
    .limit(1);
  if (!survey) { { res.status(404).json({ error: "survey not found" }); return; } }

  // Only players who actually appeared in the tournament can answer.
  const [registered] = await db.select({ id: playersTable.id })
    .from(playersTable)
    .where(and(
      eq(playersTable.tournamentId, survey.tournamentId),
      eq(playersTable.userId, req.user!.id),
    ))
    .limit(1);
  if (!registered) { { res.status(403).json({ error: "not registered for this tournament" }); return; } }

  const [tournamentRow] = await db.select({ name: tournamentsTable.name })
    .from(tournamentsTable).where(eq(tournamentsTable.id, survey.tournamentId)).limit(1);

  const [existing] = await db.select({ id: postEventSurveyResponsesTable.id, submittedAt: postEventSurveyResponsesTable.submittedAt })
    .from(postEventSurveyResponsesTable)
    .where(and(
      eq(postEventSurveyResponsesTable.surveyId, survey.id),
      eq(postEventSurveyResponsesTable.userId, req.user!.id),
    ))
    .limit(1);

  const closed = survey.closesAt ? survey.closesAt.getTime() <= Date.now() : false;

  res.json({
    survey: {
      id: survey.id,
      tournamentId: survey.tournamentId,
      tournamentName: tournamentRow?.name ?? null,
      questions: survey.questions ?? [],
      closesAt: survey.closesAt,
      sentAt: survey.sentAt,
    },
    closed,
    alreadySubmitted: Boolean(existing),
    submittedAt: existing?.submittedAt ?? null,
  });
});

router.post("/portal/surveys/:surveyId", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const surveyId = Number((req.params as Record<string, string>).surveyId);
  if (!Number.isFinite(surveyId)) { { res.status(400).json({ error: "invalid surveyId" }); return; } }

  const [survey] = await db.select().from(postEventSurveysTable)
    .where(eq(postEventSurveysTable.id, surveyId))
    .limit(1);
  if (!survey) { { res.status(404).json({ error: "survey not found" }); return; } }

  const [registered] = await db.select({ id: playersTable.id })
    .from(playersTable)
    .where(and(
      eq(playersTable.tournamentId, survey.tournamentId),
      eq(playersTable.userId, req.user!.id),
    ))
    .limit(1);
  if (!registered) { { res.status(403).json({ error: "not registered for this tournament" }); return; } }

  if (survey.closesAt && survey.closesAt.getTime() <= Date.now()) {
    res.status(410).json({ error: "survey is closed" });
    return;
  }

  const [existing] = await db.select({ id: postEventSurveyResponsesTable.id })
    .from(postEventSurveyResponsesTable)
    .where(and(
      eq(postEventSurveyResponsesTable.surveyId, survey.id),
      eq(postEventSurveyResponsesTable.userId, req.user!.id),
    ))
    .limit(1);
  if (existing) {
    res.status(409).json({ error: "you have already submitted a response to this survey" });
    return;
  }

  const questions = (survey.questions ?? []) as SurveyQuestion[];
  const normalized = normalizeAnswers(questions, req.body?.answers);
  if (!normalized.ok) { { res.status(400).json({ error: normalized.error }); return; } }
  if (Object.keys(normalized.answers).length === 0) {
    res.status(400).json({ error: "at least one answer is required" });
    return;
  }

  const [response] = await db.insert(postEventSurveyResponsesTable).values({
    surveyId: survey.id,
    userId: req.user!.id,
    answers: normalized.answers,
  }).returning();

  res.status(201).json({ response });
});

/**
 * Task #1365 — CSV export of post-event survey responses.
 *
 * Produces one row per response with columns:
 *   submittedAt, <question 1 prompt>, <question 2 prompt>, ...
 *
 * Boolean answers are normalised to "yes"/"no" (matching the on-screen
 * rendering); rating answers are written as numbers; text answers are
 * passed through verbatim and CSV-escaped. AuthZ mirrors the JSON
 * endpoint above (org admin only, IDOR-safe via the tournament/org
 * lookup).
 */
router.get("/organizations/:orgId/tournaments/:tid/survey/responses.csv", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const tid = Number((req.params as Record<string, string>).tid);

  // Task #1634 — optional ISO 8601 date-window filter so admins can scope
  // exports to e.g. "the last 7 days" or a specific committee window.
  // The parsing logic is shared with the windowed count endpoint
  // (Task #2028) via `parseSurveyRangeParam` defined above.
  const fromParsed = parseSurveyRangeParam(req.query.from, "from");
  if (fromParsed && typeof fromParsed === "object" && "error" in fromParsed) {
    res.status(400).json({ error: fromParsed.error }); return;
  }
  const toParsed = parseSurveyRangeParam(req.query.to, "to");
  if (toParsed && typeof toParsed === "object" && "error" in toParsed) {
    res.status(400).json({ error: toParsed.error }); return;
  }
  const fromDate = fromParsed as Date | null;
  const toDate = toParsed as Date | null;
  if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
    res.status(400).json({ error: "'from' must be on or before 'to'" }); return;
  }

  const [t] = await db.select({ id: tournamentsTable.id, name: tournamentsTable.name })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tid), eq(tournamentsTable.organizationId, orgId)))
    .limit(1);
  if (!t) { { res.status(404).json({ error: "tournament not found" }); return; } }

  const [survey] = await db.select().from(postEventSurveysTable)
    .where(eq(postEventSurveysTable.tournamentId, tid))
    .limit(1);
  if (!survey) { { res.status(404).json({ error: "no survey for tournament" }); return; } }

  const conditions = [eq(postEventSurveyResponsesTable.surveyId, survey.id)];
  if (fromDate) conditions.push(gte(postEventSurveyResponsesTable.submittedAt, fromDate));
  if (toDate) conditions.push(lte(postEventSurveyResponsesTable.submittedAt, toDate));

  const responses = await db.select().from(postEventSurveyResponsesTable)
    .where(and(...conditions))
    .orderBy(desc(postEventSurveyResponsesTable.submittedAt));

  // Task #1633 — include the responder's display name on every row so admins
  // can follow up with specific players. Anonymous responses (userId = null,
  // either because the schema's `set null` on user delete fired or because
  // the response was submitted without auth) get the literal "Anonymous".
  const respondentLabel = await buildRespondentLabelLookup(responses);

  type QuestionShape = { id: string; type: "rating" | "text" | "boolean"; prompt?: string; label?: string };
  const questions = (survey.questions ?? []) as QuestionShape[];

  const escapeCell = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (s === "") return "";
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const formatAnswer = (q: QuestionShape, raw: unknown): string => {
    if (raw === null || raw === undefined) return "";
    if (q.type === "boolean") {
      if (raw === true) return "yes";
      if (raw === false) return "no";
      if (typeof raw === "string") {
        const norm = raw.trim().toLowerCase();
        if (norm === "yes" || norm === "true") return "yes";
        if (norm === "no" || norm === "false") return "no";
      }
      return "";
    }
    if (q.type === "rating") {
      const n = Number(raw);
      return Number.isFinite(n) ? String(n) : "";
    }
    if (typeof raw === "string") return raw;
    return JSON.stringify(raw);
  };

  const headerCells = ["submittedAt", "respondent", ...questions.map((q) => q.prompt ?? q.label ?? q.id)];
  const lines: string[] = [headerCells.map(escapeCell).join(",")];
  for (const r of responses) {
    const answers = (r.answers ?? {}) as Record<string, unknown>;
    const cells: string[] = [r.submittedAt.toISOString(), respondentLabel(r.userId)];
    for (const q of questions) cells.push(formatAnswer(q, answers[q.id]));
    lines.push(cells.map(escapeCell).join(","));
  }

  // Prepend a UTF-8 BOM so Excel opens unicode comments correctly.
  const csv = "\uFEFF" + lines.join("\r\n") + "\r\n";
  const filename = `survey-responses-tournament-${tid}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
});

// ─── POST-EVENT SURVEY TEMPLATES (Task #1637) ──────────────────────────────
//
// Tournament admins kept rebuilding the same set of survey questions for
// every event. These endpoints let a club save reusable named templates
// (e.g. "Standard post-round survey") and load one to prefill the
// SendSurveyDialog. Templates live at the org level so every tournament
// admin in the club shares the same library.
//
// Permissions:
//   • GET (list)        — anyone with org-admin access (org_admin,
//                         tournament_director, super_admin). The dialog
//                         picker has to work for tournament directors.
//   • POST (create)     — org_admin or super_admin only. Tournament
//                         directors can use templates but not curate
//                         the shared library.
//   • DELETE            — same as create. Removing a template doesn't
//                         touch any surveys that were sent from it; the
//                         survey row stores its own snapshot of the
//                         questions JSON.

/**
 * Stricter variant of `requireOrgAdmin` that excludes `tournament_director`.
 * Used for create/delete on the shared template library so a TD can't
 * accidentally (or deliberately) overwrite or remove a template another
 * admin set up. Read-side endpoints continue to use `requireOrgAdmin` so
 * the picker still works for tournament directors.
 *
 * Returns true when the caller is super_admin, an org_admin attached to
 * the org via `app_users.organizationId`, or has an `org_memberships` row
 * with role `org_admin` for this org. Anything else (including a TD with
 * matching org) gets a 403.
 */
async function requireOrgAdminStrict(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (req.scorerSession) {
    res.status(403).json({ error: "Scorer sessions may only be used for score entry." });
    return false;
  }
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required." });
    return false;
  }
  const user = req.user as unknown as AuthUser;
  if (user.role === "super_admin") return true;
  if (user.role === "org_admin" && user.organizationId === orgId) return true;

  const [membership] = await db.select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));
  if (membership?.role === "org_admin") return true;

  res.status(403).json({ error: "Only org admins can manage survey templates." });
  return false;
}

type TemplateQuestion = { id: string; prompt: string; type: "rating" | "text" | "boolean" };

/** Validate + normalise the questions array coming from the client. */
function normaliseTemplateQuestions(raw: unknown): { ok: true; questions: TemplateQuestion[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "questions must be an array" };
  if (raw.length === 0) return { ok: false, error: "at least one question is required" };
  const out: TemplateQuestion[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i] as { id?: unknown; prompt?: unknown; type?: unknown };
    const prompt = typeof q?.prompt === "string" ? q.prompt.trim() : "";
    if (!prompt) return { ok: false, error: `question #${i + 1} is missing a prompt` };
    const type = q?.type;
    if (type !== "rating" && type !== "text" && type !== "boolean") {
      return { ok: false, error: `question #${i + 1} has an invalid type` };
    }
    let id = typeof q?.id === "string" && q.id.trim() ? q.id.trim() : `q_${Math.random().toString(36).slice(2, 9)}`;
    while (seenIds.has(id)) id = `q_${Math.random().toString(36).slice(2, 9)}`;
    seenIds.add(id);
    out.push({ id, prompt, type });
  }
  return { ok: true, questions: out };
}

router.get("/organizations/:orgId/survey-templates", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "invalid org id" }); return; } }
  // Read-side check: tournament directors need to see the picker.
  if (!await requireOrgAdmin(req, res, orgId)) return;

  // Task #2035 — surface "who created this template and when" in the picker
  // so admins don't accidentally send last season's questions. Left-join on
  // app_users (created_by_user_id is nullable / set null on user delete) and
  // fall back from displayName → username → null so the UI can show a sensible
  // "Unknown" label instead of an empty string.
  const rows = await db.select({
    id: postEventSurveyTemplatesTable.id,
    name: postEventSurveyTemplatesTable.name,
    questions: postEventSurveyTemplatesTable.questions,
    createdAt: postEventSurveyTemplatesTable.createdAt,
    updatedAt: postEventSurveyTemplatesTable.updatedAt,
    createdByUserId: postEventSurveyTemplatesTable.createdByUserId,
    createdByDisplayName: appUsersTable.displayName,
    createdByUsername: appUsersTable.username,
  }).from(postEventSurveyTemplatesTable)
    .leftJoin(appUsersTable, eq(postEventSurveyTemplatesTable.createdByUserId, appUsersTable.id))
    .where(eq(postEventSurveyTemplatesTable.organizationId, orgId))
    .orderBy(postEventSurveyTemplatesTable.name);

  const templates = rows.map(r => ({
    id: r.id,
    name: r.name,
    questions: r.questions,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    createdByUserId: r.createdByUserId,
    createdByName: r.createdByDisplayName ?? r.createdByUsername ?? null,
  }));

  res.json({ templates });
});

router.post("/organizations/:orgId/survey-templates", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!Number.isFinite(orgId)) { { res.status(400).json({ error: "invalid org id" }); return; } }
  if (!await requireOrgAdminStrict(req, res, orgId)) return;

  const rawName = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!rawName) { { res.status(400).json({ error: "name is required" }); return; } }
  if (rawName.length > 120) { { res.status(400).json({ error: "name must be 120 characters or fewer" }); return; } }

  const parsed = normaliseTemplateQuestions(req.body?.questions);
  if (!parsed.ok) { { res.status(400).json({ error: parsed.error }); return; } }

  // Pre-check the org exists so a super_admin pointing at a stale id
  // gets a clean 404 instead of a 500 from the FK constraint.
  const [orgRow] = await db.select({ id: organizationsTable.id })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId)).limit(1);
  if (!orgRow) { { res.status(404).json({ error: "organization not found" }); return; } }

  const userId = (req.user as unknown as AuthUser).id;

  // (organization_id, name) is unique — upsert so re-saving "Standard
  // post-round survey" updates the existing template instead of failing
  // with a 409. This matches what the dialog's "Save as template" button
  // does conceptually: if a template with that name exists, replace it.
  try {
    const [tpl] = await db.insert(postEventSurveyTemplatesTable).values({
      organizationId: orgId,
      name: rawName,
      questions: parsed.questions,
      createdByUserId: userId,
    }).onConflictDoUpdate({
      target: [postEventSurveyTemplatesTable.organizationId, postEventSurveyTemplatesTable.name],
      set: {
        questions: parsed.questions,
        updatedAt: new Date(),
      },
    }).returning();
    res.status(201).json({ template: tpl });
  } catch (err) {
    // Don't echo the raw DB error to the client — log internally and
    // return a generic message so we don't leak schema/internals.
    console.error("[survey-templates] failed to save template", { orgId, userId, err });
    res.status(500).json({ error: "failed to save template" });
  }
});

// Task #2034 — rename (and optionally update questions on) a saved
// template without changing createdByUserId / createdAt. The original
// "save as template" flow upserts by name, so renaming via that path
// would either silently merge into an existing row or force a delete-
// and-recreate that loses provenance. PATCH lets admins fix typos or
// reword templates while keeping the audit trail intact.
router.patch("/organizations/:orgId/survey-templates/:templateId", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const templateId = Number((req.params as Record<string, string>).templateId);
  if (!Number.isFinite(orgId) || !Number.isFinite(templateId)) {
    res.status(400).json({ error: "invalid id" }); return;
  }
  if (!await requireOrgAdminStrict(req, res, orgId)) return;

  // Pre-check the org exists so a super_admin pointing at a stale id
  // gets a clean 404 instead of a confusing "template not found".
  const [orgRow] = await db.select({ id: organizationsTable.id })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId)).limit(1);
  if (!orgRow) { { res.status(404).json({ error: "organization not found" }); return; } }

  // Build the patch from whatever the caller sent. We accept name and/or
  // questions; sending neither is a no-op 400 so we don't pretend to have
  // updated something.
  const hasName = req.body?.name !== undefined;
  const hasQuestions = req.body?.questions !== undefined;
  if (!hasName && !hasQuestions) {
    res.status(400).json({ error: "name or questions is required" }); return;
  }

  const patch: { name?: string; questions?: TemplateQuestion[]; updatedAt: Date } = { updatedAt: new Date() };

  if (hasName) {
    const rawName = typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (!rawName) { { res.status(400).json({ error: "name is required" }); return; } }
    if (rawName.length > 120) { { res.status(400).json({ error: "name must be 120 characters or fewer" }); return; } }
    patch.name = rawName;
  }

  if (hasQuestions) {
    const parsed = normaliseTemplateQuestions(req.body.questions);
    if (!parsed.ok) { { res.status(400).json({ error: parsed.error }); return; } }
    patch.questions = parsed.questions;
  }

  // Confirm the row exists in this org before attempting the update so
  // a cross-org id guess returns 404 instead of the duplicate-name 409
  // we'd hit if the name happened to collide in *our* org.
  const [existing] = await db.select({ id: postEventSurveyTemplatesTable.id, name: postEventSurveyTemplatesTable.name })
    .from(postEventSurveyTemplatesTable)
    .where(and(
      eq(postEventSurveyTemplatesTable.id, templateId),
      eq(postEventSurveyTemplatesTable.organizationId, orgId),
    ))
    .limit(1);
  if (!existing) { { res.status(404).json({ error: "template not found" }); return; } }

  // If the name didn't actually change, skip the conflict check so a
  // questions-only PATCH (or a no-op rename) doesn't trip on its own row.
  if (patch.name && patch.name !== existing.name) {
    const [clash] = await db.select({ id: postEventSurveyTemplatesTable.id })
      .from(postEventSurveyTemplatesTable)
      .where(and(
        eq(postEventSurveyTemplatesTable.organizationId, orgId),
        eq(postEventSurveyTemplatesTable.name, patch.name),
      ))
      .limit(1);
    if (clash) { { res.status(409).json({ error: "another template already uses that name" }); return; } }
  }

  try {
    const [tpl] = await db.update(postEventSurveyTemplatesTable)
      .set(patch)
      .where(and(
        eq(postEventSurveyTemplatesTable.id, templateId),
        eq(postEventSurveyTemplatesTable.organizationId, orgId),
      ))
      .returning();
    if (!tpl) { { res.status(404).json({ error: "template not found" }); return; } }
    res.json({ template: tpl });
  } catch (err) {
    // Race-safe fallback: if two admins rename to the same name at the
    // same time the pre-check above can pass for both, and Postgres'
    // unique (organization_id, name) index will reject the loser. Map
    // that to a clean 409 instead of a generic 500.
    const code = (err as { code?: string } | null)?.code;
    if (code === "23505") {
      res.status(409).json({ error: "another template already uses that name" });
      return;
    }
    console.error("[survey-templates] failed to rename template", { orgId, templateId, err });
    res.status(500).json({ error: "failed to update template" });
  }
});

router.delete("/organizations/:orgId/survey-templates/:templateId", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const templateId = Number((req.params as Record<string, string>).templateId);
  if (!Number.isFinite(orgId) || !Number.isFinite(templateId)) {
    res.status(400).json({ error: "invalid id" }); return;
  }
  if (!await requireOrgAdminStrict(req, res, orgId)) return;

  // Pre-check the org exists so a super_admin pointing at a stale id
  // gets a clean 404 instead of a silent "no row matched" 404 that
  // could be either "wrong org" or "wrong template".
  const [orgRow] = await db.select({ id: organizationsTable.id })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId)).limit(1);
  if (!orgRow) { { res.status(404).json({ error: "organization not found" }); return; } }

  // Scope by org so an admin in org A can't nuke a template in org B
  // even if they guess the id.
  const deleted = await db.delete(postEventSurveyTemplatesTable)
    .where(and(
      eq(postEventSurveyTemplatesTable.id, templateId),
      eq(postEventSurveyTemplatesTable.organizationId, orgId),
    ))
    .returning({ id: postEventSurveyTemplatesTable.id });

  if (deleted.length === 0) { { res.status(404).json({ error: "template not found" }); return; } }
  res.json({ deleted: deleted[0].id });
});

// ─── TEE BOOKING CANCEL + AUTO-PROMOTE WAITLIST ────────────────────────────

router.post("/portal/tee-bookings/:bookingId/cancel-and-promote", async (req: Request, res: Response) => {
  if (!requireAuth(req, res)) return;
  const bookingId = Number((req.params as Record<string, string>).bookingId);

  const [booking] = await db.select().from(teeBookingsTable)
    .where(eq(teeBookingsTable.id, bookingId)).limit(1);
  if (!booking) { { res.status(404).json({ error: "booking not found" }); return; } }
  if (booking.leadUserId !== req.user!.id) {
    res.status(403).json({ error: "only the lead booker may cancel" });
    return;
  }

  await db.update(teeBookingsTable)
    .set({ status: "cancelled", cancelledAt: new Date(), cancellationReason: req.body?.reason ?? "user_cancelled" })
    .where(eq(teeBookingsTable.id, bookingId));

  const promotion = await promoteFromWaitlist(booking.slotId);
  res.json({ cancelled: true, promotion });
});

// ─── MATCH PLAY FORM GUIDE ─────────────────────────────────────────────────

router.get("/match-play/form-guide", async (req: Request, res: Response) => {
  const playerAId = Number(req.query.playerA);
  const playerBId = Number(req.query.playerB);
  if (!playerAId || !playerBId) {
    res.status(400).json({ error: "playerA and playerB query params required" });
    return;
  }

  // Pull every completed bracket match between these two players.
  const matches = await db.select({
    id: bracketMatchesTable.id,
    bracketId: bracketMatchesTable.bracketId,
    player1Id: bracketMatchesTable.player1Id,
    player2Id: bracketMatchesTable.player2Id,
    winnerId: bracketMatchesTable.winnerId,
    matchStatus: bracketMatchesTable.matchStatus,
    result: bracketMatchesTable.result,
    completedAt: bracketMatchesTable.updatedAt,
  })
    .from(bracketMatchesTable)
    .where(and(
      sql`(${bracketMatchesTable.player1Id} = ${playerAId} AND ${bracketMatchesTable.player2Id} = ${playerBId})
       OR (${bracketMatchesTable.player1Id} = ${playerBId} AND ${bracketMatchesTable.player2Id} = ${playerAId})`,
      sql`${bracketMatchesTable.result} <> 'pending'`,
    ))
    .orderBy(desc(bracketMatchesTable.updatedAt))
    .limit(50);

  let aWins = 0, bWins = 0, halved = 0;
  for (const m of matches) {
    if (m.winnerId === playerAId) aWins++;
    else if (m.winnerId === playerBId) bWins++;
    else halved++;
  }

  res.json({
    playerA: playerAId,
    playerB: playerBId,
    record: { aWins, bWins, halved, total: matches.length },
    matches,
  });
});

export default router;
