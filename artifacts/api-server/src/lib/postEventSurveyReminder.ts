/**
 * Task #2011 — Shared post-event survey reminder dispatcher.
 *
 * Task #1625 added an admin-triggered "remind un-submitted players" action
 * (POST .../survey/remind). The original brief also mentioned an automated
 * scheduled job. This module factors the recipient-filtering, race-safe
 * stamping, and notification dispatch out of `routes/wave2.ts` so both the
 * admin endpoint and the new daily cron call the same code path. Once
 * `reminderSentAt` is stamped, repeat calls (admin OR cron) are no-ops, so
 * cron + admin manual reminders can co-exist without double-pushing players.
 *
 * Public surface:
 *   • `dispatchPostEventSurveyReminder(survey)` — fires reminders for a
 *     single survey and returns a tagged result the caller can map to its
 *     own response semantics (HTTP status for the admin route, log line for
 *     cron).
 *   • `sendScheduledSurveyReminders()` — daily-cron entry point; finds
 *     surveys whose `sentAt` is older than the configured window with
 *     `reminderSentAt` still null and dispatches each via the helper.
 *   • `POST_EVENT_SURVEY_REMINDER_POLL_INTERVAL_MS` — daily poll cadence.
 *   • `getPostEventSurveyReminderDelayDays()` — resolves the configured
 *     delay (defaults to 3 days; overridable via the
 *     `POST_EVENT_SURVEY_REMINDER_DAYS` env var so installs can tune the
 *     window without a code change).
 */

import { and, eq, gt, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import {
  appUsersTable,
  db,
  organizationsTable,
  playersTable,
  postEventSurveyResponsesTable,
  postEventSurveysTable,
  tournamentsTable,
} from "@workspace/db";
import { dispatchNotification } from "./notifyDispatch.js";
import { resolveOrgBranding } from "./clubTheming.js";
import type { EmailBranding } from "./mailer.js";
import { logger } from "./logger.js";
import { translatePostEventSurveyReminderPush } from "./postEventSurveyPushI18n.js";

/** Default delay between sending the survey and firing the reminder. */
export const POST_EVENT_SURVEY_REMINDER_DEFAULT_DELAY_DAYS = 3;

/** Daily cadence for the cron poll. */
export const POST_EVENT_SURVEY_REMINDER_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Resolves the configured "days after `sentAt`" window before the cron
 * fires a reminder. The env var lets ops tune the window per install
 * without a code change. Invalid values fall back to the default so a
 * mistyped env doesn't silently disable reminders.
 */
export function getPostEventSurveyReminderDelayDays(): number {
  const raw = process.env.POST_EVENT_SURVEY_REMINDER_DAYS;
  if (raw == null || raw === "") return POST_EVENT_SURVEY_REMINDER_DEFAULT_DELAY_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return POST_EVENT_SURVEY_REMINDER_DEFAULT_DELAY_DAYS;
  return Math.floor(n);
}

/** Tagged result returned by {@link dispatchPostEventSurveyReminder}. */
export type DispatchSurveyReminderResult =
  | { kind: "sent"; remindersSent: number; reminderSentAt: Date }
  | { kind: "no_recipients" }
  | { kind: "already_sent"; reminderSentAt: Date }
  | { kind: "closed" };

/**
 * Mirror of the small `loadOrgBrandingForNotify` used by `routes/wave2.ts`
 * — kept here so the helper is self-contained and the cron doesn't have to
 * pull a route module just to render a branded email. Returns `undefined`
 * (not null) so the dispatcher's optional-chaining branding paths work.
 */
async function loadOrgBranding(orgId: number): Promise<EmailBranding | undefined> {
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

export interface DispatchSurveyReminderInput {
  surveyId: number;
  tournamentId: number;
  tournamentName: string | null;
  organizationId: number;
  /** Current `reminderSentAt` from the survey row (if known). */
  reminderSentAt: Date | null;
  /** Current `closesAt` from the survey row. */
  closesAt: Date | null;
}

/**
 * Fire the post-event survey reminder for a single survey.
 *
 * Idempotency contract (shared with the admin endpoint):
 *   • If `reminderSentAt` is already set → returns `already_sent`.
 *   • If `closesAt` has passed → returns `closed` (no point asking for
 *     feedback the portal won't accept).
 *   • Otherwise the recipient list is computed (registered players minus
 *     those who already submitted) and the survey row is conditionally
 *     stamped with `WHERE reminder_sent_at IS NULL`. If the stamp fails
 *     (a concurrent caller — admin or cron — won the race), returns
 *     `already_sent` with the latest stamp from the DB.
 *   • If there are zero eligible recipients (everyone has submitted, or no
 *     roster row has a linked user) → `no_recipients` and `reminderSentAt`
 *     is left null so a future late registration is still eligible.
 *
 * Notification delivery errors are swallowed by `dispatchNotification` per
 * recipient, so the stamp stays accurate even if a single email/push
 * provider call fails.
 */
export async function dispatchPostEventSurveyReminder(
  input: DispatchSurveyReminderInput,
): Promise<DispatchSurveyReminderResult> {
  if (input.reminderSentAt) {
    return { kind: "already_sent", reminderSentAt: input.reminderSentAt };
  }
  if (input.closesAt && input.closesAt.getTime() <= Date.now()) {
    return { kind: "closed" };
  }

  // Players who have already submitted — exclude them from the recipient
  // list. Anonymous responses (`userId = null`) can't be linked to a
  // roster entry so they are ignored here.
  const submittedRows = await db
    .select({ userId: postEventSurveyResponsesTable.userId })
    .from(postEventSurveyResponsesTable)
    .where(and(
      eq(postEventSurveyResponsesTable.surveyId, input.surveyId),
      isNotNull(postEventSurveyResponsesTable.userId),
    ));
  const submittedUserIds = submittedRows
    .map(r => r.userId)
    .filter((u): u is number => u != null);

  const playerWhere = submittedUserIds.length > 0
    ? and(
        eq(playersTable.tournamentId, input.tournamentId),
        isNotNull(playersTable.userId),
        notInArray(playersTable.userId, submittedUserIds),
      )
    : and(
        eq(playersTable.tournamentId, input.tournamentId),
        isNotNull(playersTable.userId),
      );
  const candidateRows = await db
    .select({ userId: playersTable.userId })
    .from(playersTable)
    .where(playerWhere);
  const recipients = Array.from(new Set(
    candidateRows.map(r => r.userId).filter((u): u is number => u != null),
  ));

  if (recipients.length === 0) {
    return { kind: "no_recipients" };
  }

  const tournamentName = input.tournamentName ?? "the event you just played";
  const branding = await loadOrgBranding(input.organizationId);

  // Stamp BEFORE dispatching so a concurrent caller (admin click + cron
  // tick, two cron runs, two admin clicks) can't fire twice. The
  // conditional `WHERE reminder_sent_at IS NULL` makes this race-safe:
  // exactly one UPDATE will affect a row.
  const reminderSentAt = new Date();
  const stamped = await db.update(postEventSurveysTable)
    .set({ reminderSentAt })
    .where(and(
      eq(postEventSurveysTable.id, input.surveyId),
      sql`${postEventSurveysTable.reminderSentAt} IS NULL`,
    ))
    .returning({ reminderSentAt: postEventSurveysTable.reminderSentAt });

  if (stamped.length === 0) {
    const [latest] = await db.select({ reminderSentAt: postEventSurveysTable.reminderSentAt })
      .from(postEventSurveysTable)
      .where(eq(postEventSurveysTable.id, input.surveyId))
      .limit(1);
    return {
      kind: "already_sent",
      reminderSentAt: latest?.reminderSentAt ?? reminderSentAt,
    };
  }

  // Task #2012 — push title/body are sent verbatim to the push provider with
  // no per-recipient translation, so we group recipients by their preferred
  // language and dispatch once per language with the localised push payload.
  // The email leg is auto-localised inside `dispatchNotification` via each
  // recipient's `recipientLang`, which is why we no longer pass an
  // `emailSubject` override (the renderer's `reminderSubject` bundle wins).
  const langRows = await db
    .select({ id: appUsersTable.id, preferredLanguage: appUsersTable.preferredLanguage })
    .from(appUsersTable)
    .where(inArray(appUsersTable.id, recipients));
  const langById = new Map<number, string | null>(
    langRows.map(r => [r.id, r.preferredLanguage]),
  );
  const recipientsByLang = new Map<string, number[]>();
  for (const userId of recipients) {
    const lang = langById.get(userId) ?? null;
    const key = lang && lang.length > 0 ? lang : "en";
    const bucket = recipientsByLang.get(key);
    if (bucket) bucket.push(userId);
    else recipientsByLang.set(key, [userId]);
  }

  await Promise.all(
    Array.from(recipientsByLang.entries()).map(([lang, ids]) => {
      const push = translatePostEventSurveyReminderPush(lang, tournamentName);
      return dispatchNotification("post.event.survey", ids, {
        title: push.title,
        body: push.body,
        data: {
          type: "post_event_survey_reminder",
          surveyId: input.surveyId,
          tournamentId: input.tournamentId,
          tournamentName,
          surveyUrl: `/portal/surveys/${input.surveyId}`,
          isReminder: true,
        },
        branding,
      }).catch((err: unknown) => { void err; });
    }),
  );

  return { kind: "sent", remindersSent: recipients.length, reminderSentAt };
}

/**
 * Daily-cron entry point. Finds surveys whose `sentAt` is at least
 * `getPostEventSurveyReminderDelayDays()` days old, whose `reminderSentAt`
 * is still null, and whose `closesAt` is either unset or still in the
 * future. For each survey it calls
 * {@link dispatchPostEventSurveyReminder} (idempotent — admin manual
 * reminders that already fired will short-circuit on `reminderSentAt`).
 *
 * Logs a summary `{ checked, remindersSent }` for observability so an ops
 * dashboard can graph reminder volume per day.
 */
export async function sendScheduledSurveyReminders(): Promise<{
  checked: number;
  remindersSent: number;
  surveysReminded: number;
}> {
  const delayDays = getPostEventSurveyReminderDelayDays();
  const cutoff = new Date(Date.now() - delayDays * 24 * 60 * 60 * 1000);
  const now = new Date();

  const candidates = await db
    .select({
      surveyId: postEventSurveysTable.id,
      tournamentId: postEventSurveysTable.tournamentId,
      organizationId: postEventSurveysTable.organizationId,
      reminderSentAt: postEventSurveysTable.reminderSentAt,
      closesAt: postEventSurveysTable.closesAt,
      tournamentName: tournamentsTable.name,
    })
    .from(postEventSurveysTable)
    .leftJoin(tournamentsTable, eq(tournamentsTable.id, postEventSurveysTable.tournamentId))
    .where(and(
      isNotNull(postEventSurveysTable.sentAt),
      lte(postEventSurveysTable.sentAt, cutoff),
      isNull(postEventSurveysTable.reminderSentAt),
      or(
        isNull(postEventSurveysTable.closesAt),
        gt(postEventSurveysTable.closesAt, now),
      ),
    ));

  let remindersSent = 0;
  let surveysReminded = 0;

  for (const row of candidates) {
    try {
      const result = await dispatchPostEventSurveyReminder({
        surveyId: row.surveyId,
        tournamentId: row.tournamentId,
        tournamentName: row.tournamentName,
        organizationId: row.organizationId,
        reminderSentAt: row.reminderSentAt,
        closesAt: row.closesAt,
      });
      if (result.kind === "sent") {
        remindersSent += result.remindersSent;
        surveysReminded += 1;
        logger.info(
          { surveyId: row.surveyId, tournamentId: row.tournamentId, recipients: result.remindersSent },
          "[cron] post-event survey reminder dispatched",
        );
      } else {
        logger.debug(
          { surveyId: row.surveyId, tournamentId: row.tournamentId, kind: result.kind },
          "[cron] post-event survey reminder skipped",
        );
      }
    } catch (err: unknown) {
      logger.warn(
        { err, surveyId: row.surveyId, tournamentId: row.tournamentId },
        "[cron] post-event survey reminder failed",
      );
    }
  }

  logger.info(
    { checked: candidates.length, remindersSent, surveysReminded, delayDays },
    "[cron] post-event survey scheduled reminders summary",
  );

  return { checked: candidates.length, remindersSent, surveysReminded };
}
