/**
 * Periodic background jobs for KHARAGOLF.
 * Runs entirely in-process using setInterval (no external scheduler required).
 *
 * Jobs:
 *  - 24h tee-time reminder — every 30 minutes, find tournaments starting
 *    between 23h and 25h from now and push a reminder to all registered players.
 *  - 1h tee-time reminder — every 10 minutes, find tournaments starting
 *    between 45 minutes and 75 minutes from now and push an imminent reminder.
 *  - Locker renewal reminders — daily, find assignments expiring in ~30 or ~7 days.
 */

import { db } from "@workspace/db";
import {
  tournamentsTable,
  playersTable,
  memberSubscriptionsTable,
  clubMembersTable,
  membershipTiersTable,
  teeBookingsTable,
  teeBookingPlayersTable,
  courseTeeSlotTable,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  lockerAssignmentsTable,
  lockersTable,
  generalPlayRoundsTable,
  generalPlayHoleScoresTable,
  generalPlayMarkersTable,
  roundSubmissionsTable,
  vendorContractsTable,
  vendorOperatorsTable,
  vendorContractAlertsTable,
  vendorBillingCyclesTable,
  vendorInvoicesTable,
  posTransactionsTable,
  memberAccountChargesTable,
  shopVariantStockTable,
  shopLocationsTable,
  shopProductVariantsTable,
  shopProductsTable,
  shopCategoryFlashSalesTable,
  automationRulesTable,
  automationRuleLogsTable,
  leagueMembersTable,
  leaguesTable,
  flightsTable,
  playerFlightsTable,
  tournamentRoundsTable,
  memberDataRequestsTable,
  mediaTable,
  swingVideosTable,
  swingAnnotationsTable,
  swingComparisonsTable,
  highlightReelsTable,
  memberDocumentsTable,
  memberDocumentVersionsTable,
  feedPostsTable,
  feedPostMediaTable,
  memberLevyReceiptAttemptsTable,
  sideGameSettlementReceiptAttemptsTable,
  coachPayoutNotificationAttemptsTable,
  manualEntryAlertRecipientsTable,
  walletWithdrawalNotifyAttemptsTable,
  walletTopupRefundNotifyAttemptsTable,
  coachPayoutAccountChangeNotifyAttemptsTable,
  notifyExhaustionAdminDigestRecipientSendsTable,
  adminCommPrefOverrideNotifyAttemptsTable,
  teachingProsTable,
  watchMotionBufferTable,
  gpsChunkBufferTable,
  teeTimesTable,
  teeTimePlayersTable,
  memberAuditLogTable,
  pendingStorageDeletionsTable,
  stripeWebhookDeliveriesTable,
  stripeWebhookSweepRunsTable,
  userNotificationPrefsTable,
  clubMarketingSitesTable,
  verifiedHandicapBadgesTable,
  userStreaksTable,
  shotsTable,
  type MemberDataRequest,
} from "@workspace/db";
import { deliverSpectatorPush } from "./spectatorNotify";
import { materializeAllCoursesForDate } from "./teeMaterializer";
import { and, eq, gte, inArray, isNotNull, lte, or, sql, isNull, lt, sum, desc } from "drizzle-orm";
import { sendTransactionalPush, sendBroadcast } from "./comms";
import {
  sendPaymentReminderEmail,
  sendMarketplaceBookingEmail,
  sendTeeReminderEmail,
  sendTeeCancellationEmail,
  sendLockerRenewalReminderEmail,
  sendBroadcastEmail,
  sendDataRequestDeadlineAlertEmail,
  sendBouncedLevyDigestEmail,
  sendErasureStorageFailuresDigestEmail,
  sendMemberPrefsDigestEmail,
  sendErasureStorageFailureExhaustedEmail,
  sendMarketingImageBrokenEmail,
  sendMarketingImageRefreshFailingEmail,
  sendLegacyVideoUnverifiableDigestEmail,
  sendErasureAutoRetryCappedEmail,
  sendNotifyExhaustionAdminDigestEmail,
  classifyMailerError,
} from "./mailer";
import {
  getBouncedLeviesForOrg,
  listOrgIdsWithFailedLevyMessages,
} from "./levyBouncedReminders";
import { logger } from "./logger";
import { _setLastStripeWebhookSweepResult } from "./stripeWebhookSweepStatus";
import { dispatchNotification } from "./notifyDispatch.js";
import {
  notifyBooking24hReminder,
  notifyBooking2hReminder,
  notifyVerifiedHandicapExpiring,
  notifyStreakMilestone,
  notifyLeaderboardPositionChange,
  notifyLeagueStandingsUpdated,
  notifyCoachingGapClosed,
} from "./brandedNotifications.js";
import {
  computeProximityByClub,
  computeProximityCoachingTips,
} from "./strokes-gained.js";
import { pauseSuppressedRecipients } from "./digestRecipientPause.js";
import { startYearInGolfCron } from "./year-in-golf-cron";
import { getRazorpayClient, type RazorpayPaymentLinkCreateOpts } from "./razorpay";
import { postScoreAndRecalculate, getPccForCourseDate } from "./whs-recalc";
import {
  notifyDataRequest,
  retryDataRequestPush,
  retryDataRequestSms,
  retryDataRequestEmail,
  retryDataRequestWhatsapp,
  notifyAdminsOfRetryExhaustion,
  DATA_REQUEST_MAX_PUSH_ATTEMPTS,
  DATA_REQUEST_MAX_SMS_ATTEMPTS,
  DATA_REQUEST_MAX_EMAIL_ATTEMPTS,
  DATA_REQUEST_MAX_WHATSAPP_ATTEMPTS,
  type NotifyDataRequestResult,
} from "./dataRequestNotify";
import {
  retryLevyReceiptPush,
  retryLevyReceiptSms,
  retryLevyReceiptWhatsapp,
  retryLevyReceiptEmail,
  notifyAdminsOfLevyReceiptRetryExhaustion,
  LEVY_RECEIPT_MAX_PUSH_ATTEMPTS,
  LEVY_RECEIPT_MAX_SMS_ATTEMPTS,
  LEVY_RECEIPT_MAX_WHATSAPP_ATTEMPTS,
  LEVY_RECEIPT_MAX_EMAIL_ATTEMPTS,
} from "./levyReceiptNotify";
import {
  retrySideGameReceiptEmail,
  retrySideGameReceiptPush,
  SIDE_GAME_RECEIPT_MAX_EMAIL_ATTEMPTS,
  SIDE_GAME_RECEIPT_MAX_PUSH_ATTEMPTS,
} from "./sideGameSettlementPaidNotify";
import {
  retryCoachPayoutPush,
  retryCoachPayoutSms,
  retryCoachPayoutEmail,
  COACH_PAYOUT_MAX_PUSH_ATTEMPTS,
  COACH_PAYOUT_MAX_SMS_ATTEMPTS,
  COACH_PAYOUT_MAX_EMAIL_ATTEMPTS,
} from "./coachPayoutNotify";
import {
  retryManualEntryEmail,
  MANUAL_ENTRY_MAX_EMAIL_ATTEMPTS,
} from "./manualEntryNotify";
import { runNotifyExhaustionOpsAlertJob } from "./notifyExhaustionOpsAlert";
import { runManualEntryAlertHealthOpsAlertJob } from "./manualEntryAlertHealthOpsAlert";
import { runWalletTopupRefundRetryExhaustionOpsAlertJob } from "./walletTopupRefundRetryExhaustionOpsAlert";
import { runBadgeShareRollupStaleOpsAlertJob } from "./badgeShareRollupOpsAlert";
import { runProfileShareRollupStaleOpsAlertJob } from "./profileShareRollupOpsAlert";
import { runStripeWebhookSweepStaleOpsAlertJob } from "./stripeWebhookSweepStaleOpsAlert";
import {
  retryWalletWithdrawalEmail,
  retryWalletWithdrawalPush,
  WALLET_WITHDRAWAL_NOTIFY_MAX_EMAIL_ATTEMPTS,
  WALLET_WITHDRAWAL_NOTIFY_MAX_PUSH_ATTEMPTS,
} from "./walletWithdrawalNotify";
import {
  retryWalletTopupRefundEmail,
  retryWalletTopupRefundPush,
  retryWalletTopupRefundSms,
  retryWalletTopupRefundWhatsapp,
  WALLET_TOPUP_REFUND_NOTIFY_MAX_EMAIL_ATTEMPTS,
  WALLET_TOPUP_REFUND_NOTIFY_MAX_PUSH_ATTEMPTS,
  WALLET_TOPUP_REFUND_NOTIFY_MAX_SMS_ATTEMPTS,
  WALLET_TOPUP_REFUND_NOTIFY_MAX_WHATSAPP_ATTEMPTS,
} from "./walletTopupRefundNotify";
import {
  retryCoachPayoutAccountChangeEmail,
  retryCoachPayoutAccountChangePush,
  retryCoachPayoutAccountChangeSms,
  retryCoachPayoutAccountChangeWhatsapp,
  COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_EMAIL_ATTEMPTS,
  COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_PUSH_ATTEMPTS,
  COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_SMS_ATTEMPTS,
  COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_WHATSAPP_ATTEMPTS,
} from "./coachPayoutAccountChangeNotify";
import {
  retryAdminCommPrefOverrideEmail,
  ADMIN_COMM_PREF_OVERRIDE_NOTIFY_MAX_EMAIL_ATTEMPTS,
} from "./adminCommPrefOverrideNotify";
import { recordMemberAudit } from "./auditMember";
import { sendPlanMigrationDigestToSuperAdmins } from "./planMigrationDigest";
import { sendSilentAlertsDigestToSuperAdmins } from "./silentAlertsDigest";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";
import { refreshAllOrgFxRates } from "./fx";
import {
  sweepWellnessConnections,
  evaluateWeeklyReauthDrift,
  sweepStaleHrSessions,
  HR_SESSION_SWEEP_INTERVAL_MS,
} from "./wearables";
import { DATA_EXPORT_VALID_DAYS } from "./dataExportRetention";
import { getIngressClient, type CertStatus } from "./ingressClient";
import { verifyExternalImageUrl, MARKETING_LOGO_FAVICON_MAX_BYTES } from "./externalImageVerifier";
import { rehostExternalImageBytes } from "./marketingImageCache";
import { runRoundWeatherCacheBackfill } from "./roundWeatherBackfill.js";
import {
  recordRoundWeatherBackfillPass,
  runRoundWeatherBackfillOpsAlertJob,
} from "./roundWeatherBackfillOpsAlert.js";
import {
  sendScheduledSurveyReminders,
  POST_EVENT_SURVEY_REMINDER_POLL_INTERVAL_MS,
} from "./postEventSurveyReminder.js";

const REMINDER_24H_POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const REMINDER_1H_POLL_INTERVAL_MS = 10 * 60 * 1000;  // 10 minutes

/**
 * In-memory fast-path dedup of tournament reminders within a single process.
 * The authoritative dedup is `tournaments.reminder_24h_sent_at` /
 * `reminder_1h_sent_at` so a restart inside the polling window does not
 * re-push every player. See Task #796.
 */
const remindedTournaments = new Set<number>();
const reminded1hTournaments = new Set<number>();

/** Test-only: clear the in-memory dedup sets to simulate a server restart. */
export function _resetTournamentReminderDedupForTest() {
  remindedTournaments.clear();
  reminded1hTournaments.clear();
}

/**
 * Task #2008 — Daily branded notification sweep.
 *
 * Detects three event sources whose templated email/push exists in the
 * notification renderer but had no upstream dispatcher wired into the
 * codebase, and fires the appropriate `notify*` helper from
 * `lib/brandedNotifications.ts`:
 *
 *   - `verified.handicap.expiring` — verified-handicap badges whose
 *     `expiresAt` falls into a "renew now" window (~7 days out by
 *     default; tunable via `VERIFIED_HANDICAP_EXPIRING_LEAD_DAYS`).
 *     Per-badge dedup uses `member_audit_log` so a badge inside the
 *     window only emits one reminder; the next reminder won't re-fire
 *     until the badge is renewed (which resets `verifiedAt`/`expiresAt`)
 *     or the same badge enters a fresh window.
 *
 *   - `streak.milestone` — `user_streaks` rows whose `currentLen` has
 *     just crossed a milestone (3, 7, 14, 30, 100). Per-milestone
 *     dedup uses `member_audit_log` keyed on `entity = "user_streak"`
 *     and `metadata.milestone` so the same threshold is never
 *     announced twice. A reset (currentLen falls back below the
 *     milestone) clears the dedup naturally — the next time the user
 *     re-attains the threshold, a new audit row records the fresh fire.
 *
 * The sweep runs once daily and on cold-boot. Per-row dedup keeps the
 * boot-fire safe across restarts. Failures are logged and swallowed so
 * one bad row never blocks the rest of the sweep.
 */
const STREAK_MILESTONES = [3, 7, 14, 30, 100] as const;

export async function runBrandedNotificationDailySweep(): Promise<{
  verifiedHandicapExpiringFired: number;
  streakMilestonesFired: number;
}> {
  let verifiedHandicapExpiringFired = 0;
  let streakMilestonesFired = 0;

  // ── verified.handicap.expiring ─────────────────────────────────────
  // Window = [today + (lead-1) days, today + (lead+1) days]. The
  // ±1-day fuzz absorbs small clock skew between the cron tick and
  // `expiresAt` so we don't miss a badge that crosses the boundary
  // during the exact tick. `member_audit_log` records each fire so
  // the same badge isn't reminded twice in the same window.
  try {
    const leadDaysRaw = parseInt(process.env.VERIFIED_HANDICAP_EXPIRING_LEAD_DAYS ?? "7", 10);
    const leadDays = Number.isFinite(leadDaysRaw) && leadDaysRaw > 0 ? leadDaysRaw : 7;
    const now = new Date();
    const windowStart = new Date(now.getTime() + (leadDays - 1) * 24 * 60 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + (leadDays + 1) * 24 * 60 * 60 * 1000);

    const expiring = await db
      .select({
        userId: verifiedHandicapBadgesTable.userId,
        expiresAt: verifiedHandicapBadgesTable.expiresAt,
      })
      .from(verifiedHandicapBadgesTable)
      .where(and(
        isNotNull(verifiedHandicapBadgesTable.expiresAt),
        gte(verifiedHandicapBadgesTable.expiresAt, windowStart),
        lte(verifiedHandicapBadgesTable.expiresAt, windowEnd),
      ));

    for (const row of expiring) {
      if (!row.expiresAt) continue;
      const expiresMs = row.expiresAt.getTime();
      // Dedup: skip if we already fired a reminder for this user whose
      // recorded expiry matches this badge's current expiresAt. The
      // metadata.expiresAt fingerprint changes whenever the badge is
      // renewed, so a renewal naturally re-arms the reminder.
      const prior = await db
        .select({ id: memberAuditLogTable.id, metadata: memberAuditLogTable.metadata })
        .from(memberAuditLogTable)
        .where(and(
          eq(memberAuditLogTable.entity, "verified_handicap_badge"),
          eq(memberAuditLogTable.action, "expiring_reminder_sent"),
          eq(memberAuditLogTable.entityId, row.userId),
        ));
      const alreadyFired = prior.some((p) => {
        const md = (p.metadata ?? {}) as Record<string, unknown>;
        return md.expiresAtMs === expiresMs;
      });
      if (alreadyFired) continue;

      try {
        await notifyVerifiedHandicapExpiring({
          userIds: [row.userId],
          expiresAt: row.expiresAt,
        });
        await db.insert(memberAuditLogTable).values({
          entity: "verified_handicap_badge",
          action: "expiring_reminder_sent",
          entityId: row.userId,
          metadata: { expiresAtMs: expiresMs, leadDays },
        });
        verifiedHandicapExpiringFired++;
      } catch (err) {
        logger.warn(
          { err, userId: row.userId },
          "[cron] verified.handicap.expiring reminder failed",
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, "[cron] verified.handicap.expiring sweep failed");
  }

  // ── streak.milestone ───────────────────────────────────────────────
  // For every (user_id, kind) row whose currentLen is exactly at a
  // milestone, fire `notifyStreakMilestone` unless an audit row
  // already records this exact (userId, kind, milestone) combo. A
  // streak reset that drops the user back below a milestone clears
  // the dedup naturally — the next time they reach that threshold a
  // brand-new audit row records the fresh fire.
  try {
    const atMilestone = await db
      .select({
        userId: userStreaksTable.userId,
        kind: userStreaksTable.kind,
        currentLen: userStreaksTable.currentLen,
      })
      .from(userStreaksTable)
      .where(inArray(userStreaksTable.currentLen, [...STREAK_MILESTONES]));

    for (const row of atMilestone) {
      const milestone = row.currentLen;
      const prior = await db
        .select({ id: memberAuditLogTable.id, metadata: memberAuditLogTable.metadata })
        .from(memberAuditLogTable)
        .where(and(
          eq(memberAuditLogTable.entity, "user_streak"),
          eq(memberAuditLogTable.action, "milestone_notified"),
          eq(memberAuditLogTable.entityId, row.userId),
        ));
      const alreadyFired = prior.some((p) => {
        const md = (p.metadata ?? {}) as Record<string, unknown>;
        return md.milestone === milestone && md.kind === row.kind;
      });
      if (alreadyFired) continue;

      try {
        await notifyStreakMilestone({
          userIds: [row.userId],
          streakDays: milestone,
        });
        await db.insert(memberAuditLogTable).values({
          entity: "user_streak",
          action: "milestone_notified",
          entityId: row.userId,
          metadata: { milestone, kind: row.kind },
        });
        streakMilestonesFired++;
      } catch (err) {
        logger.warn(
          { err, userId: row.userId, milestone, kind: row.kind },
          "[cron] streak.milestone notification failed",
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, "[cron] streak.milestone sweep failed");
  }

  return { verifiedHandicapExpiringFired, streakMilestonesFired };
}

/**
 * Task #2040 — Daily "you closed the gap" coaching encouragement push.
 *
 * Iterates active players who have logged shots in the last 30 days,
 * computes proximity-vs-tour stats over the current 30-day window AND
 * the prior 30-day window via the same `computeProximityCoachingTips`
 * pipeline used by the AI Caddie (lib/strokes-gained.ts), and fires the
 * `coaching.gap.closed` push (helper: `notifyCoachingGapClosed`) for any
 * club whose `trendVsTourFt` is at least `TREND_ENCOURAGEMENT_FT`
 * (-1.5 ft) — the same threshold the AI Caddie's `caddieHint` already
 * flips to encouragement at, so the on-course rationale and the daily
 * push agree on what counts as "closing the gap".
 *
 * Per-event opt-out is wired through `notifyCoachingTipClosed` on
 * `userNotificationPrefsTable` (registered in
 * `PER_EVENT_OPT_OUT_COLUMNS`), so a player who muted the nudge still
 * gets the audit row but no push, and the global `preferPush` toggle
 * is left untouched.
 *
 * Dedup: per-(user, clubKey) for 14 days via `member_audit_log`
 * (entity = `coaching_tip`, action = `gap_closed_notified`,
 * metadata.clubKey). The 14-day window matches the typical "you've
 * already been told this week" debounce on the engagement-push side
 * and gives a player who opens the stats tab a chance to act on the
 * tip before the next nudge.
 *
 * Failures are logged and swallowed per-user / per-club so one bad
 * row never blocks the rest of the sweep, mirroring the safety
 * posture of `runBrandedNotificationDailySweep` above.
 */
const COACHING_GAP_TREND_THRESHOLD_FT = -1.5;
const COACHING_GAP_DEDUP_DAYS = 14;
const COACHING_GAP_WINDOW_DAYS = 30;

export async function runCoachingGapClosedDailySweep(): Promise<{
  usersScanned: number;
  notificationsFired: number;
}> {
  let notificationsFired = 0;
  const totalWindowDays = COACHING_GAP_WINDOW_DAYS * 2;
  const now = Date.now();
  const currentSince = new Date(now - COACHING_GAP_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const priorSince = new Date(now - totalWindowDays * 24 * 60 * 60 * 1000);
  const dedupSince = new Date(now - COACHING_GAP_DEDUP_DAYS * 24 * 60 * 60 * 1000);

  // Enumerate distinct active player userIds with at least one shot in the
  // current 30-day window. UNION covers both general-play (shots.user_id is
  // set) and tournament play (shots.player_id → players.user_id), matching
  // the ownership predicate used by `fetchAllUserShots` in routes/portal.ts.
  let userIds: number[] = [];
  try {
    const rows = await db.execute<{ user_id: number }>(sql`
      SELECT DISTINCT user_id FROM (
        SELECT s.user_id AS user_id
          FROM shots s
          WHERE s.recorded_at >= ${currentSince}
            AND s.user_id IS NOT NULL
        UNION
        SELECT p.user_id AS user_id
          FROM shots s
          JOIN players p ON p.id = s.player_id
          WHERE s.recorded_at >= ${currentSince}
            AND p.user_id IS NOT NULL
      ) u
    `);
    const raw = (rows as unknown as { rows?: { user_id: number | string }[] }).rows
      ?? (rows as unknown as { user_id: number | string }[]);
    userIds = (raw as { user_id: number | string }[])
      .map((r) => Number(r.user_id))
      .filter((id) => Number.isFinite(id) && id > 0);
  } catch (err) {
    logger.warn({ err }, "[cron] coaching.gap.closed sweep: user enumeration failed");
    return { usersScanned: 0, notificationsFired: 0 };
  }

  for (const userId of userIds) {
    try {
      const userPlayers = await db
        .select({ id: playersTable.id })
        .from(playersTable)
        .where(eq(playersTable.userId, userId));
      const playerIds = userPlayers.map((p) => p.id);
      const ownership = playerIds.length > 0
        ? sql`(${eq(shotsTable.userId, userId)} OR ${inArray(shotsTable.playerId, playerIds)})`
        : sql`${eq(shotsTable.userId, userId)}`;
      const shots = await db
        .select()
        .from(shotsTable)
        .where(sql`${ownership} AND ${shotsTable.recordedAt} >= ${priorSince}`);

      const currentShots = shots.filter((s) => {
        const t = s.recordedAt instanceof Date ? s.recordedAt.getTime() : 0;
        return t >= currentSince.getTime();
      });
      const priorShots = shots.filter((s) => {
        const t = s.recordedAt instanceof Date ? s.recordedAt.getTime() : 0;
        return t >= priorSince.getTime() && t < currentSince.getTime();
      });
      if (currentShots.length === 0 || priorShots.length === 0) continue;

      const tips = computeProximityCoachingTips(
        computeProximityByClub(currentShots),
        {
          maxTips: 5,
          previousStats: computeProximityByClub(priorShots),
          previousWindowLabel: `prev ${COACHING_GAP_WINDOW_DAYS}d`,
        },
      );

      const closingTips = tips.filter(
        (t) => t.trendVsTourFt !== null && t.trendVsTourFt <= COACHING_GAP_TREND_THRESHOLD_FT,
      );
      if (closingTips.length === 0) continue;

      // One round-trip for the dedup window — every closing tip is checked
      // against the same set of recent audit rows, so we don't re-query
      // per club.
      const priorAudits = await db
        .select({ metadata: memberAuditLogTable.metadata })
        .from(memberAuditLogTable)
        .where(and(
          eq(memberAuditLogTable.entity, "coaching_tip"),
          eq(memberAuditLogTable.action, "gap_closed_notified"),
          eq(memberAuditLogTable.entityId, userId),
          gte(memberAuditLogTable.createdAt, dedupSince),
        ));
      const recentlyNotifiedClubKeys = new Set<string>();
      for (const r of priorAudits) {
        const md = (r.metadata ?? {}) as Record<string, unknown>;
        if (typeof md.clubKey === "string") recentlyNotifiedClubKeys.add(md.clubKey);
      }

      for (const tip of closingTips) {
        if (recentlyNotifiedClubKeys.has(tip.clubKey)) continue;
        const trend = tip.trendVsTourFt;
        if (trend === null) continue;
        const improvedByFt = Math.round(Math.abs(trend) * 10) / 10;
        try {
          const dispatch = await notifyCoachingGapClosed({
            userIds: [userId],
            clubLabel: tip.club,
            clubKey: tip.clubKey,
            improvedByFt,
          });
          // Task #2040 — only insert the 14-day per-club dedup row when
          // a push was actually delivered. Opt-out (`event_opted_out` /
          // `all_channels_opted_out`) and provider failures must NOT
          // suppress tomorrow's retry, otherwise a transient blip or a
          // since-toggled-back-on preference would silence the coach
          // encouragement for a fortnight.
          const wasDelivered = dispatch?.recipients.some((r) =>
            r.channels.some((ch) => ch.channel === "push" && ch.status === "sent"),
          ) ?? false;
          if (!wasDelivered) continue;
          await db.insert(memberAuditLogTable).values({
            entity: "coaching_tip",
            action: "gap_closed_notified",
            entityId: userId,
            metadata: {
              clubKey: tip.clubKey,
              club: tip.club,
              trendVsTourFt: trend,
              improvedByFt,
              firedAtMs: now,
            },
          });
          recentlyNotifiedClubKeys.add(tip.clubKey);
          notificationsFired++;
        } catch (err) {
          logger.warn(
            { err, userId, clubKey: tip.clubKey },
            "[cron] coaching.gap.closed notification failed",
          );
        }
      }
    } catch (err) {
      logger.warn({ err, userId }, "[cron] coaching.gap.closed sweep: per-user pass failed");
    }
  }

  return { usersScanned: userIds.length, notificationsFired };
}

export async function send24hReminders() {
  const now = new Date();
  const in23h = new Date(now.getTime() + 23 * 60 * 60 * 1000);
  const in25h = new Date(now.getTime() + 25 * 60 * 60 * 1000);

  // Find active/upcoming tournaments whose startDate falls in [now+23h, now+25h]
  // Only process tournaments with autoReminder enabled (true by default).
  // The persisted `reminder_24h_sent_at` mark survives restarts.
  const upcoming = await db
    .select({
      id: tournamentsTable.id,
      name: tournamentsTable.name,
      startDate: tournamentsTable.startDate,
      organizationId: tournamentsTable.organizationId,
      autoReminder: tournamentsTable.autoReminder,
    })
    .from(tournamentsTable)
    .where(
      and(
        gte(tournamentsTable.startDate, in23h),
        lte(tournamentsTable.startDate, in25h),
        sql`${tournamentsTable.status} IN ('upcoming', 'active')`,
        sql`${tournamentsTable.autoReminder} = true`,
        isNull(tournamentsTable.reminder24hSentAt),
      ),
    );

  for (const tournament of upcoming) {
    if (remindedTournaments.has(tournament.id)) continue;

    // Get all players in this tournament that have a linked user account
    const players = await db
      .select({ userId: playersTable.userId })
      .from(playersTable)
      .where(
        and(
          eq(playersTable.tournamentId, tournament.id),
          sql`${playersTable.userId} IS NOT NULL`,
        ),
      );

    const userIds = players.map(p => p.userId!).filter(Boolean);
    if (userIds.length === 0) {
      remindedTournaments.add(tournament.id);
      await db.update(tournamentsTable)
        .set({ reminder24hSentAt: new Date() })
        .where(eq(tournamentsTable.id, tournament.id));
      continue;
    }

    const startDate = tournament.startDate!;
    const timeStr = startDate.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    });

    if (userIds.length > 0) {
      await sendTransactionalPush(
        userIds,
        `Tee off tomorrow — ${tournament.name} ⛳`,
        `Your tournament starts tomorrow at ${timeStr} UTC. Check your tee time and get ready!`,
        { type: "reminder_24h", tournamentId: String(tournament.id) },
      ).catch((err: unknown) => {
        logger.warn({ err, tournamentId: tournament.id }, "[cron] 24h reminder push failed");
      });

      logger.info(
        { tournamentId: tournament.id, recipients: userIds.length },
        "[cron] 24h reminder sent",
      );
    }

    remindedTournaments.add(tournament.id);
    await db.update(tournamentsTable)
      .set({ reminder24hSentAt: new Date() })
      .where(eq(tournamentsTable.id, tournament.id));
  }
}

export async function send1hReminders() {
  const now = new Date();
  const in45m = new Date(now.getTime() + 45 * 60 * 1000);
  const in75m = new Date(now.getTime() + 75 * 60 * 1000);

  const upcoming = await db
    .select({
      id: tournamentsTable.id,
      name: tournamentsTable.name,
      startDate: tournamentsTable.startDate,
      autoReminder: tournamentsTable.autoReminder,
    })
    .from(tournamentsTable)
    .where(
      and(
        gte(tournamentsTable.startDate, in45m),
        lte(tournamentsTable.startDate, in75m),
        sql`${tournamentsTable.status} IN ('upcoming', 'active')`,
        sql`${tournamentsTable.autoReminder} = true`,
        isNull(tournamentsTable.reminder1hSentAt),
      ),
    );

  for (const tournament of upcoming) {
    if (reminded1hTournaments.has(tournament.id)) continue;

    const players = await db
      .select({ userId: playersTable.userId })
      .from(playersTable)
      .where(
        and(
          eq(playersTable.tournamentId, tournament.id),
          sql`${playersTable.userId} IS NOT NULL`,
        ),
      );

    const userIds = players.map(p => p.userId!).filter(Boolean);
    if (userIds.length === 0) {
      reminded1hTournaments.add(tournament.id);
      await db.update(tournamentsTable)
        .set({ reminder1hSentAt: new Date() })
        .where(eq(tournamentsTable.id, tournament.id));
      continue;
    }

    const startDate = tournament.startDate!;
    const timeStr = startDate.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    });

    await sendTransactionalPush(
      userIds,
      `Tee off in ~1 hour — ${tournament.name} ⛳`,
      `Your tournament starts at ${timeStr} UTC. Head to the course and good luck!`,
      { type: "reminder_1h", tournamentId: String(tournament.id) },
    ).catch((err: unknown) => {
      logger.warn({ err, tournamentId: tournament.id }, "[cron] 1h reminder push failed");
    });

    logger.info(
      { tournamentId: tournament.id, recipients: userIds.length },
      "[cron] 1h reminder sent",
    );

    reminded1hTournaments.add(tournament.id);
    await db.update(tournamentsTable)
      .set({ reminder1hSentAt: new Date() })
      .where(eq(tournamentsTable.id, tournament.id));
  }
}

// ─── N-days payment reminder ─────────────────────────────────────────────────
// Checks once daily whether any tournament has `reminderDaysBefore` set and
// its startDate falls exactly N days from today.  Sends email reminders to
// all players whose paymentStatus is still "unpaid".
const PAYMENT_REMINDER_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function sendPaymentDayReminders() {
  // Fetch all upcoming tournaments where reminderDaysBefore is set
  const tournaments = await db
    .select({
      id: tournamentsTable.id,
      name: tournamentsTable.name,
      startDate: tournamentsTable.startDate,
      entryFee: tournamentsTable.entryFee,
      currency: tournamentsTable.currency,
      reminderDaysBefore: tournamentsTable.reminderDaysBefore,
    })
    .from(tournamentsTable)
    .where(
      and(
        isNotNull(tournamentsTable.reminderDaysBefore),
        isNotNull(tournamentsTable.startDate),
        sql`${tournamentsTable.status} IN ('upcoming', 'active')`,
      ),
    );

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (const tournament of tournaments) {
    if (!tournament.startDate || tournament.reminderDaysBefore === null) continue;

    const startDay = new Date(tournament.startDate);
    startDay.setUTCHours(0, 0, 0, 0);
    const daysUntil = Math.round((startDay.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));

    if (daysUntil !== tournament.reminderDaysBefore) continue;

    // Fetch unpaid players with an email address
    const unpaidPlayers = await db
      .select({
        id: playersTable.id,
        firstName: playersTable.firstName,
        lastName: playersTable.lastName,
        email: playersTable.email,
        paymentLinkId: playersTable.paymentLinkId,
        paymentLinkUrl: playersTable.paymentLinkUrl,
      })
      .from(playersTable)
      .where(
        and(
          eq(playersTable.tournamentId, tournament.id),
          eq(playersTable.paymentStatus, "unpaid"),
          sql`${playersTable.email} IS NOT NULL`,
        ),
      );

    const currency = (tournament.currency as string | null) ?? "INR";
    const CURRENCY_SYMBOLS: Record<string, string> = {
      INR: "₹", USD: "$", GBP: "£", AED: "د.إ", EUR: "€", SGD: "S$", AUD: "A$",
    };
    const sym = CURRENCY_SYMBOLS[currency] ?? currency;
    const amount = tournament.entryFee ? Number(tournament.entryFee).toFixed(2) : "—";

    for (const player of unpaidPlayers) {
      if (!player.email) continue;
      let paymentUrl = player.paymentLinkUrl ?? undefined;

      // Auto-create a payment link if the player doesn't have one yet
      if (!paymentUrl && tournament.entryFee) {
        try {
          const razorpay = getRazorpayClient();
          const amountSubunit = Math.round(Number(tournament.entryFee) * 100);
          const opts: RazorpayPaymentLinkCreateOpts = {
            amount: amountSubunit, currency,
            description: `Entry fee — ${tournament.name}`,
            customer: { name: `${player.firstName} ${player.lastName}`, email: player.email },
            notify: { email: true },
            upi_link: currency === "INR",
            expire_by: Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60,
            callback_url: process.env.RAZORPAY_CALLBACK_URL,
            reference_id: `tp_${player.id}`,
            notes: { playerId: String(player.id) },
          };
          const link = await razorpay.paymentLink.create(opts);
          await db.update(playersTable)
            .set({ paymentLinkId: link.id, paymentLinkUrl: link.short_url })
            .where(eq(playersTable.id, player.id));
          paymentUrl = link.short_url;
          logger.info({ playerId: player.id }, "[cron] auto-created payment link for reminder");
        } catch (linkErr: unknown) {
          logger.warn({ err: linkErr, playerId: player.id }, "[cron] failed to auto-create payment link");
        }
      }

      try {
        await sendPaymentReminderEmail({
          to: player.email,
          name: `${player.firstName} ${player.lastName}`,
          eventName: tournament.name,
          eventType: "tournament",
          currencySymbol: sym,
          amount,
          paymentUrl,
        });
        logger.info(
          { tournamentId: tournament.id, playerId: player.id },
          "[cron] payment reminder email sent",
        );
      } catch (err: unknown) {
        logger.warn({ err, playerId: player.id }, "[cron] payment reminder email failed");
      }
    }
  }
}

// ─── Grace period expiry ──────────────────────────────────────────────────────
// Runs once daily. Finds all `past_due` subscriptions whose grace period has
// elapsed (updatedAt + gracePeriodDays < now), then marks both the subscription
// and club member record as `expired`.
const GRACE_PERIOD_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function expireGracePeriods() {
  const now = new Date();

  // Fetch all past_due subscriptions along with the tier's grace period days
  const pastDueSubs = await db
    .select({
      subId: memberSubscriptionsTable.id,
      clubMemberId: memberSubscriptionsTable.clubMemberId,
      updatedAt: memberSubscriptionsTable.updatedAt,
      gracePeriodDays: membershipTiersTable.gracePeriodDays,
    })
    .from(memberSubscriptionsTable)
    .leftJoin(membershipTiersTable, eq(memberSubscriptionsTable.tierId, membershipTiersTable.id))
    .where(eq(memberSubscriptionsTable.status, "past_due"));

  let expired = 0;
  for (const sub of pastDueSubs) {
    const graceDays = sub.gracePeriodDays ?? 14;
    const graceExpiresAt = new Date(sub.updatedAt.getTime() + graceDays * 24 * 60 * 60 * 1000);
    if (now >= graceExpiresAt) {
      await db.update(memberSubscriptionsTable)
        .set({ status: "expired", updatedAt: now })
        .where(eq(memberSubscriptionsTable.id, sub.subId));
      await db.update(clubMembersTable)
        .set({ subscriptionStatus: "expired", updatedAt: now })
        .where(eq(clubMembersTable.id, sub.clubMemberId));
      expired++;
      logger.info(
        { subId: sub.subId, clubMemberId: sub.clubMemberId, graceDays, graceExpiresAt },
        "[cron] Grace period elapsed — subscription expired",
      );
    }
  }

  if (expired > 0) {
    logger.info({ count: expired }, "[cron] expireGracePeriods: expired subscriptions processed");
  }
}

// ─── Shop fulfillment order status polling ────────────────────────────────────
// Every 6 hours: poll Printful and Printify for processing orders, update
// tracking numbers and status when the provider marks them shipped/fulfilled.
const FULFILLMENT_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function pollFulfillmentOrderStatus() {
  // Self-managed India-first shop: fulfillment is tracked via Shiprocket.
  // POD/dropship polling (Printful, Printify, DSers) has been removed.
  logger.debug("[cron] fulfillment-poll: self-managed shop, no external polling required");
}

/**
 * TTL-based Maps to deduplicate tee booking reminders across polling cycles.
 * Each entry records the Unix timestamp (ms) when the reminder was sent.
 * Entries are pruned on every poll run to prevent unbounded memory growth.
 * 24h reminders expire after 26h; 2h reminders expire after 4h.
 */
const remindedTeeBookings24h = new Map<number, number>(); // bookingId → sentAtMs
const remindedTeeBookings2h  = new Map<number, number>(); // bookingId → sentAtMs

function pruneRemindedSets() {
  const now = Date.now();
  for (const [id, sentAt] of remindedTeeBookings24h) {
    if (now - sentAt > 26 * 60 * 60 * 1000) remindedTeeBookings24h.delete(id);
  }
  for (const [id, sentAt] of remindedTeeBookings2h) {
    if (now - sentAt > 4 * 60 * 60 * 1000) remindedTeeBookings2h.delete(id);
  }
}

/** Parse "HH:MM" or "H:MM AM/PM" slot time text into { hours, minutes } */
function parseSlotTime(slotTimeStr: string): { hours: number; minutes: number } | null {
  const m = slotTimeStr.trim().match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
  if (!m) return null;
  let hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  const meridiem = (m[3] ?? "").toUpperCase();
  if (meridiem === "PM" && hours < 12) hours += 12;
  if (meridiem === "AM" && hours === 12) hours = 0;
  return { hours, minutes };
}

/** Build the actual tee datetime from slotDate (date part) + slotTime (text) */
function buildTeeDatetime(slotDate: Date, slotTimeStr: string): Date {
  const parsed = parseSlotTime(slotTimeStr);
  const dt = new Date(slotDate);
  if (parsed) { dt.setHours(parsed.hours, parsed.minutes, 0, 0); }
  return dt;
}

/**
 * Send 24h tee booking reminders to all confirmed players.
 * Runs every 30 minutes; finds bookings where actual tee time is in [now+23h, now+25h].
 * SQL selects all slots whose slotDate falls on the calendar day that is 24h from now
 * (covers timezone drift ±1 day); exact [23h, 25h] window applied in-process using slotTime.
 */
async function sendTeeBooking24hReminders() {
  pruneRemindedSets();
  const now = new Date();
  // Fetch all confirmed bookings on the target calendar day (±1 day for TZ safety).
  // slotDate is a timestamp stored at midnight; we compare its calendar day (UTC) to
  // the calendar day of (now + 24h) using date_trunc so that a 00:00 slotDate is matched
  // regardless of whether 22h or 26h hour-arithmetic would span it.
  const upcoming = await db
    .select({
      bookingId: teeBookingsTable.id,
      slotDate: courseTeeSlotTable.slotDate,
      slotTime: courseTeeSlotTable.slotTime,
      orgName: organizationsTable.name,
      reminder24hSentAt: teeBookingsTable.reminder24hSentAt,
    })
    .from(teeBookingsTable)
    .innerJoin(courseTeeSlotTable, eq(courseTeeSlotTable.id, teeBookingsTable.slotId))
    .innerJoin(organizationsTable, eq(organizationsTable.id, teeBookingsTable.organizationId))
    .where(and(
      eq(teeBookingsTable.status, "confirmed"),
      sql`date_trunc('day', ${courseTeeSlotTable.slotDate}) = date_trunc('day', now() + interval '1 day')`,
      sql`${teeBookingsTable.reminder24hSentAt} IS NULL`,
    ));

  const in23h = new Date(now.getTime() + 23 * 60 * 60 * 1000);
  const in25h = new Date(now.getTime() + 25 * 60 * 60 * 1000);

  for (const row of upcoming) {
    if (remindedTeeBookings24h.has(row.bookingId)) continue;

    // Exact timing check: build actual tee datetime from slotDate + slotTime
    const teeDatetime = buildTeeDatetime(new Date(row.slotDate), row.slotTime ?? "");
    if (teeDatetime < in23h || teeDatetime > in25h) continue;

    const players = await db
      .select({
        userId: teeBookingPlayersTable.userId,
        guestEmail: teeBookingPlayersTable.guestEmail,
        guestName: teeBookingPlayersTable.guestName,
        playerType: teeBookingPlayersTable.playerType,
        userEmail: appUsersTable.email,
        userName: appUsersTable.displayName,
      })
      .from(teeBookingPlayersTable)
      .leftJoin(appUsersTable, eq(appUsersTable.id, teeBookingPlayersTable.userId))
      .where(and(
        eq(teeBookingPlayersTable.bookingId, row.bookingId),
        eq(teeBookingPlayersTable.confirmationStatus, "confirmed"),
      ));

    if (players.length === 0) continue;

    const memberUserIds = players.filter(p => p.userId !== null).map(p => p.userId!);
    if (memberUserIds.length > 0) {
      await sendTransactionalPush(
        memberUserIds,
        "Tee Time Tomorrow",
        `Your tee time at ${row.orgName} is tomorrow at ${row.slotTime}. Don't forget!`,
        { type: "tee_booking_reminder_24h", bookingId: row.bookingId },
      );
    }

    // Email all players (members + guests) with an email address
    for (const p of players) {
      const email = p.playerType === "guest" ? p.guestEmail : p.userEmail;
      const name = p.playerType === "guest" ? (p.guestName ?? "Guest") : (p.userName ?? "Member");
      if (email) {
        sendTeeReminderEmail({
          to: email,
          name,
          bookingId: row.bookingId,
          orgName: row.orgName,
          slotDate: new Date(row.slotDate),
          slotTime: row.slotTime ?? "",
          horizonLabel: "tomorrow",
          players: players.length,
        }).catch(() => {});
      }
    }

    // Task #2008 — central branded `booking.reminder.24h` dispatch on top of
    // the bespoke push + tee-reminder email above so members opted into
    // digest mode still get the reminder rolled into their daily summary.
    if (memberUserIds.length > 0) {
      void notifyBooking24hReminder({
        userIds: memberUserIds,
        bookingId: row.bookingId,
        orgName: row.orgName,
        slotDate: new Date(row.slotDate),
        slotTime: row.slotTime ?? undefined,
      });
    }

    remindedTeeBookings24h.set(row.bookingId, Date.now());
    await db.update(teeBookingsTable).set({ reminder24hSentAt: new Date() }).where(eq(teeBookingsTable.id, row.bookingId));
    logger.info({ bookingId: row.bookingId, playerCount: players.length }, "[cron] tee 24h reminder sent");
  }
}

/**
 * Send 2h tee booking reminders to all confirmed players.
 * Runs every 10 minutes; finds bookings where actual tee time is in [now+1.5h, now+2.5h].
 */
async function sendTeeBooking2hReminders() {
  pruneRemindedSets();
  const now = new Date();
  // Fetch all today's confirmed bookings; refine to [1.5h, 2.5h] in-process via slotTime.
  // slotDate is a timestamp at midnight, so date_trunc comparison is required.
  const upcoming = await db
    .select({
      bookingId: teeBookingsTable.id,
      slotDate: courseTeeSlotTable.slotDate,
      slotTime: courseTeeSlotTable.slotTime,
      orgName: organizationsTable.name,
    })
    .from(teeBookingsTable)
    .innerJoin(courseTeeSlotTable, eq(courseTeeSlotTable.id, teeBookingsTable.slotId))
    .innerJoin(organizationsTable, eq(organizationsTable.id, teeBookingsTable.organizationId))
    .where(and(
      eq(teeBookingsTable.status, "confirmed"),
      // Include today AND tomorrow so cross-midnight tee times fall in the 1.5–2.5h window
      sql`date_trunc('day', ${courseTeeSlotTable.slotDate}) IN (date_trunc('day', now()), date_trunc('day', now() + interval '1 day'))`,
      sql`${teeBookingsTable.reminder2hSentAt} IS NULL`,
    ));

  const in1h30 = new Date(now.getTime() + 90 * 60 * 1000);
  const in2h30 = new Date(now.getTime() + 150 * 60 * 1000);

  for (const row of upcoming) {
    if (remindedTeeBookings2h.has(row.bookingId)) continue;  // in-memory fast-path

    // Exact timing check: build actual tee datetime from slotDate + slotTime
    const teeDatetime = buildTeeDatetime(new Date(row.slotDate), row.slotTime ?? "");
    if (teeDatetime < in1h30 || teeDatetime > in2h30) continue;

    const players = await db
      .select({
        userId: teeBookingPlayersTable.userId,
        guestEmail: teeBookingPlayersTable.guestEmail,
        guestName: teeBookingPlayersTable.guestName,
        playerType: teeBookingPlayersTable.playerType,
        userEmail: appUsersTable.email,
        userName: appUsersTable.displayName,
      })
      .from(teeBookingPlayersTable)
      .leftJoin(appUsersTable, eq(appUsersTable.id, teeBookingPlayersTable.userId))
      .where(and(
        eq(teeBookingPlayersTable.bookingId, row.bookingId),
        eq(teeBookingPlayersTable.confirmationStatus, "confirmed"),
      ));

    if (players.length === 0) continue;

    const memberUserIds = players.filter(p => p.userId !== null).map(p => p.userId!);
    if (memberUserIds.length > 0) {
      await sendTransactionalPush(
        memberUserIds,
        "Tee Time in 2 Hours",
        `Your tee time at ${row.orgName} starts at ${row.slotTime}. Time to get ready!`,
        { type: "tee_booking_reminder_2h", bookingId: row.bookingId },
      );
    }

    // Email all players (members + guests) with an email address
    for (const p of players) {
      const email = p.playerType === "guest" ? p.guestEmail : p.userEmail;
      const name = p.playerType === "guest" ? (p.guestName ?? "Guest") : (p.userName ?? "Member");
      if (email) {
        sendTeeReminderEmail({
          to: email,
          name,
          bookingId: row.bookingId,
          orgName: row.orgName,
          slotDate: new Date(row.slotDate),
          slotTime: row.slotTime ?? "",
          horizonLabel: "in 2 hours",
          players: players.length,
        }).catch(() => {});
      }
    }

    // Task #2008 — central branded `booking.reminder.2h` dispatch on top of
    // the bespoke push + tee-reminder email above so members opted into
    // digest mode still get the reminder.
    if (memberUserIds.length > 0) {
      void notifyBooking2hReminder({
        userIds: memberUserIds,
        bookingId: row.bookingId,
        orgName: row.orgName,
        slotDate: new Date(row.slotDate),
        slotTime: row.slotTime ?? undefined,
      });
    }

    remindedTeeBookings2h.set(row.bookingId, Date.now());
    await db.update(teeBookingsTable).set({ reminder2hSentAt: new Date() }).where(eq(teeBookingsTable.id, row.bookingId));
    logger.info({ bookingId: row.bookingId, playerCount: players.length }, "[cron] tee 2h reminder sent");
  }
}

/**
 * Cancel tee bookings that have been in "pending" state for more than 30 minutes.
 * Pending bookings are created for online/prepaid clubs and should be confirmed after
 * payment; if the user abandons checkout, the seat hold is released automatically.
 * Runs every 5 minutes.
 */
async function expireStalePendingTeeBookings() {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago

  const stale = await db
    .select({
      id: teeBookingsTable.id,
      slotId: teeBookingsTable.slotId,
      leadUserId: teeBookingsTable.leadUserId,
      organizationId: teeBookingsTable.organizationId,
    })
    .from(teeBookingsTable)
    .where(and(
      eq(teeBookingsTable.status, "pending"),
      sql`${teeBookingsTable.createdAt} < ${cutoff}`,
    ));

  for (const booking of stale) {
    await db.update(teeBookingsTable).set({
      status: "cancelled",
      cancellationReason: "Booking expired — payment not completed within 30 minutes",
      cancelledAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(teeBookingsTable.id, booking.id));

    // Notify lead and all invited members
    const members = await db
      .select({ userId: teeBookingPlayersTable.userId })
      .from(teeBookingPlayersTable)
      .where(and(
        eq(teeBookingPlayersTable.bookingId, booking.id),
        sql`${teeBookingPlayersTable.userId} IS NOT NULL`,
      ));
    const notifyIds = [...new Set([
      ...(booking.leadUserId ? [booking.leadUserId] : []),
      ...members.map(m => m.userId!),
    ])];
    if (notifyIds.length > 0) {
      sendTransactionalPush(
        notifyIds,
        "Tee Booking Expired",
        "Your pending tee time booking was cancelled because payment was not completed in time.",
        { type: "tee_booking_expired", bookingId: booking.id },
      ).catch(() => {});
    }

    logger.info({ bookingId: booking.id }, "[cron] stale pending tee booking expired");
  }

  if (stale.length > 0) {
    logger.info({ count: stale.length }, "[cron] expired stale pending tee bookings");
  }
}

/* ─── Automation Rules Engine ──────────────────────────────────── */

function substituteMergeTags(
  text: string,
  vars: { playerName: string; tournamentName: string; leagueName: string; teeTime: string; drawLink: string; resultsLink: string; orgName: string },
): string {
  return text
    .replace(/\{\{player_name\}\}/gi, vars.playerName)
    .replace(/\{\{tournament_name\}\}/gi, vars.tournamentName)
    .replace(/\{\{league_name\}\}/gi, vars.leagueName)
    .replace(/\{\{tee_time\}\}/gi, vars.teeTime)
    .replace(/\{\{draw_link\}\}/gi, vars.drawLink)
    .replace(/\{\{results_link\}\}/gi, vars.resultsLink)
    .replace(/\{\{org_name\}\}/gi, vars.orgName);
}

/** Poll every 5 min → each event-based trigger uses a slightly wider detection window */
const AUTOMATION_POLL_WINDOW_MS = 7 * 60 * 1000;

function timingWindowMs(params: { value?: number; unit?: string } | null): number {
  if (!params) return 24 * 60 * 60 * 1000;
  return params.unit === "days"
    ? (params.value ?? 1) * 24 * 60 * 60 * 1000
    : (params.value ?? 1) * 60 * 60 * 1000;
}

/** Returns true if a target date falls within ±HALF of POLL_INTERVAL from now+offset */
function inTimeWindow(targetDate: Date, offsetMs: number, now: Date): boolean {
  const half = 5 * 60 * 1000;
  const target = now.getTime() + offsetMs;
  return targetDate.getTime() >= target - half && targetDate.getTime() <= target + half;
}

/** Returns true if an event timestamp is within the recent poll window */
function recentlyOccurred(eventAt: Date | null, now: Date): boolean {
  if (!eventAt) return false;
  return eventAt.getTime() >= now.getTime() - AUTOMATION_POLL_WINDOW_MS && eventAt.getTime() <= now.getTime();
}

/** Returns true if this rule has not yet fired for this particular event timestamp */
function notYetFired(lastFired: Date | null, eventAt: Date): boolean {
  if (!lastFired) return true;
  return lastFired < eventAt;
}

async function evaluateAutomationRules() {
  const now = new Date();
  const baseUrl = process.env.PUBLIC_BASE_URL ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`;

  const activeRules = await db.select().from(automationRulesTable).where(eq(automationRulesTable.isActive, true));
  if (activeRules.length === 0) return;

  for (const rule of activeRules) {
    try {
      let shouldFire = false;
      let context: {
        tournamentName: string; leagueName: string; orgName: string;
        startDate: Date | null; orgId: number;
      } = { tournamentName: "", leagueName: "", orgName: "KHARAGOLF", startDate: null, orgId: 0 };

      if (rule.tournamentId) {
        const [t] = await db
          .select({
            id: tournamentsTable.id,
            name: tournamentsTable.name,
            status: tournamentsTable.status,
            startDate: tournamentsTable.startDate,
            registrationDeadline: tournamentsTable.registrationDeadline,
            pairingsPublishedAt: tournamentsTable.pairingsPublishedAt,
            createdAt: tournamentsTable.createdAt,
            updatedAt: tournamentsTable.updatedAt,
            organizationId: tournamentsTable.organizationId,
          })
          .from(tournamentsTable)
          .where(eq(tournamentsTable.id, rule.tournamentId));
        if (!t) continue;

        const [org] = await db.select({ name: organizationsTable.name })
          .from(organizationsTable).where(eq(organizationsTable.id, t.organizationId));
        context = { tournamentName: t.name, leagueName: "", orgName: org?.name ?? "KHARAGOLF", startDate: t.startDate, orgId: t.organizationId };

        switch (rule.triggerType) {
          case "event_starts":
            if (t.startDate && rule.triggerParams) {
              const offsetMs = timingWindowMs(rule.triggerParams);
              if (inTimeWindow(t.startDate, offsetMs, now) && notYetFired(rule.lastTriggeredAt, new Date(t.startDate.getTime() - offsetMs))) {
                shouldFire = true;
              }
            }
            break;
          case "registration_deadline":
            if (t.registrationDeadline && rule.triggerParams) {
              const offsetMs = timingWindowMs(rule.triggerParams);
              if (inTimeWindow(t.registrationDeadline, offsetMs, now) && notYetFired(rule.lastTriggeredAt, new Date(t.registrationDeadline.getTime() - offsetMs))) {
                shouldFire = true;
              }
            }
            break;
          case "draw_published":
            if (recentlyOccurred(t.pairingsPublishedAt, now) && notYetFired(rule.lastTriggeredAt, t.pairingsPublishedAt!)) {
              shouldFire = true;
            }
            break;
          case "event_created":
            if (recentlyOccurred(t.createdAt, now) && notYetFired(rule.lastTriggeredAt, t.createdAt)) {
              shouldFire = true;
            }
            break;
          case "registration_opens":
            if (t.status === "upcoming" && recentlyOccurred(t.updatedAt, now) && notYetFired(rule.lastTriggeredAt, t.updatedAt)) {
              shouldFire = true;
            }
            break;
          case "round_complete": {
            const recentRound = await db.select({ scheduledDate: tournamentRoundsTable.scheduledDate })
              .from(tournamentRoundsTable)
              .where(and(
                eq(tournamentRoundsTable.tournamentId, t.id),
                lte(tournamentRoundsTable.scheduledDate, now),
                gte(tournamentRoundsTable.scheduledDate, new Date(now.getTime() - AUTOMATION_POLL_WINDOW_MS)),
              ))
              .limit(1);
            if (recentRound[0]?.scheduledDate && notYetFired(rule.lastTriggeredAt, recentRound[0].scheduledDate)) {
              shouldFire = true;
            }
            break;
          }
          case "event_closed":
            if (t.status === "completed" && recentlyOccurred(t.updatedAt, now) && notYetFired(rule.lastTriggeredAt, t.updatedAt)) {
              shouldFire = true;
            }
            break;
        }
      } else if (rule.leagueId) {
        const [lg] = await db
          .select({ id: leaguesTable.id, name: leaguesTable.name, status: leaguesTable.status, seasonStart: leaguesTable.seasonStart, seasonEnd: leaguesTable.seasonEnd, createdAt: leaguesTable.createdAt, updatedAt: leaguesTable.updatedAt, organizationId: leaguesTable.organizationId })
          .from(leaguesTable).where(eq(leaguesTable.id, rule.leagueId));
        if (!lg) continue;

        const [org] = await db.select({ name: organizationsTable.name })
          .from(organizationsTable).where(eq(organizationsTable.id, lg.organizationId));
        context = { tournamentName: "", leagueName: lg.name, orgName: org?.name ?? "KHARAGOLF", startDate: lg.seasonStart, orgId: lg.organizationId };

        switch (rule.triggerType) {
          case "event_starts":
            if (lg.seasonStart && rule.triggerParams) {
              const offsetMs = timingWindowMs(rule.triggerParams);
              if (inTimeWindow(lg.seasonStart, offsetMs, now) && notYetFired(rule.lastTriggeredAt, new Date(lg.seasonStart.getTime() - offsetMs))) {
                shouldFire = true;
              }
            }
            break;
          case "registration_deadline":
            if (lg.seasonEnd && rule.triggerParams) {
              const offsetMs = timingWindowMs(rule.triggerParams);
              if (inTimeWindow(lg.seasonEnd, offsetMs, now) && notYetFired(rule.lastTriggeredAt, new Date(lg.seasonEnd.getTime() - offsetMs))) {
                shouldFire = true;
              }
            }
            break;
          case "event_created":
            if (recentlyOccurred(lg.createdAt, now) && notYetFired(rule.lastTriggeredAt, lg.createdAt)) {
              shouldFire = true;
            }
            break;
          case "event_closed":
            if (lg.status === "completed" && recentlyOccurred(lg.updatedAt, now) && notYetFired(rule.lastTriggeredAt, lg.updatedAt)) {
              shouldFire = true;
            }
            break;
        }
      }

      if (!shouldFire) continue;

      const audience = (rule.audienceFilter as { type: string; flightId?: number } | null) ?? { type: "all_registrants" };
      let recipients: { name: string; email: string | null; userId: number | null }[] = [];

      if (rule.tournamentId) {
        const allPlayers = await db
          .select({ id: playersTable.id, firstName: playersTable.firstName, lastName: playersTable.lastName, email: playersTable.email, userId: playersTable.userId, paymentStatus: playersTable.paymentStatus })
          .from(playersTable)
          .where(eq(playersTable.tournamentId, rule.tournamentId));

        let filtered = allPlayers;

        if (audience.type === "unpaid_registrants") {
          filtered = allPlayers.filter(p => p.paymentStatus === "unpaid" || p.paymentStatus === "pending");
        } else if (audience.type === "specific_flight" && audience.flightId) {
          const flightPlayerIds = await db.select({ playerId: playerFlightsTable.playerId })
            .from(playerFlightsTable)
            .where(eq(playerFlightsTable.flightId, audience.flightId));
          const idSet = new Set(flightPlayerIds.map(fp => fp.playerId));
          filtered = allPlayers.filter(p => idSet.has(p.id));
        } else if (audience.type === "all_members") {
          const orgMembers = await db
            .select({ email: appUsersTable.email, id: appUsersTable.id, displayName: appUsersTable.displayName })
            .from(orgMembershipsTable)
            .innerJoin(appUsersTable, eq(appUsersTable.id, orgMembershipsTable.userId))
            .where(eq(orgMembershipsTable.organizationId, context.orgId));
          recipients = orgMembers.filter(m => m.email).map(m => ({ name: m.displayName ?? m.email!, email: m.email!, userId: m.id }));
        }

        if (audience.type !== "all_members") {
          recipients = filtered.map(p => ({ name: `${p.firstName} ${p.lastName}`, email: p.email ?? null, userId: p.userId ?? null }));
        }
      } else if (rule.leagueId) {
        const allMembers = await db
          .select({ id: leagueMembersTable.id, firstName: leagueMembersTable.firstName, lastName: leagueMembersTable.lastName, email: leagueMembersTable.email, userId: leagueMembersTable.userId, paymentStatus: leagueMembersTable.paymentStatus })
          .from(leagueMembersTable)
          .where(eq(leagueMembersTable.leagueId, rule.leagueId));

        let filtered = allMembers;
        if (audience.type === "unpaid_registrants") {
          filtered = allMembers.filter(m => m.paymentStatus === "unpaid" || m.paymentStatus === "pending");
        } else if (audience.type === "all_members") {
          const orgMembers = await db
            .select({ email: appUsersTable.email, id: appUsersTable.id, displayName: appUsersTable.displayName })
            .from(orgMembershipsTable)
            .innerJoin(appUsersTable, eq(appUsersTable.id, orgMembershipsTable.userId))
            .where(eq(orgMembershipsTable.organizationId, context.orgId));
          recipients = orgMembers.filter(m => m.email).map(m => ({ name: m.displayName ?? m.email!, email: m.email!, userId: m.id }));
        }

        if (audience.type !== "all_members") {
          recipients = filtered.map(m => ({ name: `${m.firstName} ${m.lastName}`, email: m.email ?? null, userId: m.userId ?? null }));
        }
      }

      if (recipients.length === 0) continue;

      let deliveredCount = 0;
      let failedCount = 0;

      for (const recipient of recipients) {
        const vars = {
          playerName: recipient.name,
          tournamentName: context.tournamentName,
          leagueName: context.leagueName,
          teeTime: context.startDate ? new Date(context.startDate).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" }) : "",
          drawLink: rule.tournamentId ? `${baseUrl}/leaderboard/${rule.tournamentId}` : "#",
          resultsLink: rule.tournamentId ? `${baseUrl}/leaderboard/${rule.tournamentId}` : (rule.leagueId ? `${baseUrl}/leagues/${rule.leagueId}` : "#"),
          orgName: context.orgName,
        };

        const subject = rule.subject ? substituteMergeTags(rule.subject, vars) : rule.name;
        const body = substituteMergeTags(rule.body, vars);

        try {
          if (rule.channel === "email") {
            if (recipient.email) {
              await sendBroadcastEmail(recipient.email, vars.playerName, subject, body, vars.orgName, {
                // Task #1566 — tag automation-rule emails with the
                // originating club so the Postmark bounce webhook
                // (Task #981) can attribute hard bounces back to this
                // org instantly.
                orgId: context.orgId,
              });
              deliveredCount++;
            } else {
              failedCount++;
            }
          } else if (rule.channel === "push") {
            if (recipient.userId) {
              await sendTransactionalPush([recipient.userId], subject, body.slice(0, 150), { type: "automation_rule", ruleId: rule.id });
              deliveredCount++;
            } else {
              failedCount++;
            }
          } else {
            // sms/whatsapp: not yet integrated — count as not-deliverable
            failedCount++;
          }
        } catch {
          failedCount++;
        }
      }

      await db.insert(automationRuleLogsTable).values({
        ruleId: rule.id,
        triggeredAt: now,
        audienceSize: recipients.length,
        deliveredCount,
        failedCount,
        status: failedCount === recipients.length ? "failed" : failedCount > 0 ? "partial" : "completed",
      });

      await db.update(automationRulesTable)
        .set({ lastTriggeredAt: now, updatedAt: now })
        .where(eq(automationRulesTable.id, rule.id));

      logger.info({ ruleId: rule.id, name: rule.name, channel: rule.channel, audienceSize: recipients.length, deliveredCount, failedCount }, "[cron] automation rule fired");
    } catch (err) {
      logger.error({ err, ruleId: rule.id }, "[cron] automation rule evaluation error");
    }
  }
}

// ─── Daily bounced levy reminders digest (Task #242) ─────────────────────────
//
// Once per UTC day, for each org with unresolved bounced levy reminders, email
// each member-admin a summary of the affected levies with deep-links back to
// /club-members?openLevy=<id>. No email is sent on days with zero unresolved
// failures, matching the dashboard banner's hide-on-zero behaviour.
// Task #274 — the digest now runs hourly so we can honour each org's chosen
// local hour. Per-org gating decides whether the current tick is actually a
// send moment for that org; orgs without explicit prefs preserve the legacy
// "first tick of a UTC day" cadence via the bouncedDigestLastSentOn marker.
const BOUNCED_LEVY_DIGEST_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Compute the "current local moment" inside an IANA timezone using Intl.
 * Returns null if the tz string isn't recognised by the runtime.
 */
function localMomentInTz(tz: string, now: Date = new Date()):
  | { isoDate: string; hour: number; weekday: number /* 0=Sun..6=Sat */ }
  | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
    const year = parts.year, month = parts.month, day = parts.day;
    if (!year || !month || !day) return null;
    let hour = parseInt(parts.hour ?? "0", 10);
    if (hour === 24) hour = 0; // some runtimes emit "24" at midnight
    const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const weekday = wdMap[parts.weekday ?? ""] ?? 0;
    return { isoDate: `${year}-${month}-${day}`, hour, weekday };
  } catch {
    return null;
  }
}

export type BouncedDigestPrefs = {
  frequency: string | null;
  hourLocal: number | null;
  timezone: string | null;
  /**
   * Either an ISO date ("YYYY-MM-DD") for legacy/empty orgs, or a full ISO
   * timestamp once we've recorded a send under the new hour-aware logic.
   * The helper handles both transparently.
   */
  lastSentOn: string | null;
};

// Legacy cadence: the digest used to fire every 24h via setInterval. We
// preserve that for orgs that have not opted into hour-aware scheduling by
// requiring at least this many ms since the last successful send.
const LEGACY_MIN_GAP_MS = 23 * 60 * 60 * 1000;

/**
 * Decide whether the digest for an org should fire on this cron tick.
 * Returns the value to persist as `bouncedDigestLastSentOn` (ISO date string
 * for hour-aware orgs, full ISO timestamp for legacy orgs) if a send goes
 * ahead, or null to skip this tick.
 *
 * Rules:
 *  - frequency 'weekly' → only on Mondays (org-local).
 *  - frequency 'weekday' → skip Sat/Sun (org-local).
 *  - frequency 'daily' (or anything unrecognised) → no day-of-week filter.
 *  - If `hourLocal` is set: fire only when current local hour matches and
 *    the local date differs from the last recorded send (per-day dedup).
 *  - If `hourLocal` is null (legacy default): require at least ~24h since
 *    the previous send, matching the old setInterval(24h) cadence.
 */
export function shouldSendBouncedDigestNow(
  prefs: BouncedDigestPrefs,
  now: Date = new Date(),
): string | null {
  const frequency = (prefs.frequency ?? "daily").toLowerCase();
  const tz = prefs.timezone && prefs.timezone.trim() ? prefs.timezone.trim() : null;
  const moment = tz ? localMomentInTz(tz, now) : null;
  // Fall back to UTC if no tz configured or the tz is invalid.
  const isoDate = moment?.isoDate ?? now.toISOString().slice(0, 10);
  const hour = moment?.hour ?? now.getUTCHours();
  // For UTC fallback we still need a weekday; derive it from the UTC date.
  const weekday = moment?.weekday ?? now.getUTCDay();

  if (frequency === "weekly" && weekday !== 1) return null;
  if (frequency === "weekday" && (weekday === 0 || weekday === 6)) return null;

  if (prefs.hourLocal == null) {
    // Legacy cadence: enforce a 24h floor between sends. If we have never
    // recorded a send, fire on this tick (mirrors the old "first tick after
    // server start" behaviour).
    if (prefs.lastSentOn) {
      const last = Date.parse(prefs.lastSentOn);
      if (!Number.isNaN(last) && now.getTime() - last < LEGACY_MIN_GAP_MS) {
        return null;
      }
    }
    return now.toISOString();
  }

  // Hour-aware path: only the tick whose local hour matches qualifies, and
  // only once per local day.
  if (hour !== prefs.hourLocal) return null;
  if (prefs.lastSentOn) {
    // Compare on the date portion so either format (date or full timestamp)
    // works.
    const lastDate = prefs.lastSentOn.slice(0, 10);
    if (lastDate === isoDate) return null;
  }
  return isoDate;
}

export async function sendBouncedLevyRemindersDigest() {
  const baseUrl = process.env.APP_BASE_URL
    ?? (process.env.PUBLIC_BASE_URL
      ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`);

  const candidateOrgIds = await listOrgIdsWithFailedLevyMessages();
  if (candidateOrgIds.length === 0) {
    logger.debug("[cron] bounced-levy-digest: no orgs with failed levy messages");
    return;
  }

  let orgsEmailed = 0;
  let recipientsEmailed = 0;

  for (const orgId of candidateOrgIds) {
    const [org] = await db
      .select({
        name: organizationsTable.name,
        logoUrl: organizationsTable.logoUrl,
        primaryColor: organizationsTable.primaryColor,
        bouncedDigestFrequency: organizationsTable.bouncedDigestFrequency,
        bouncedDigestHourLocal: organizationsTable.bouncedDigestHourLocal,
        bouncedDigestTimezone: organizationsTable.bouncedDigestTimezone,
        bouncedDigestLastSentOn: organizationsTable.bouncedDigestLastSentOn,
        // Task #1099 — thread the org's defaultLanguage through to the
        // bounced-digest email helper so admins read the digest in their
        // configured language (EN fallback for unsupported codes).
        defaultLanguage: organizationsTable.defaultLanguage,
      })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    if (!org) continue;

    const sendDate = shouldSendBouncedDigestNow({
      frequency: org.bouncedDigestFrequency,
      hourLocal: org.bouncedDigestHourLocal,
      timezone: org.bouncedDigestTimezone,
      lastSentOn: org.bouncedDigestLastSentOn,
    });
    if (!sendDate) continue;

    let summary;
    try {
      summary = await getBouncedLeviesForOrg(orgId);
    } catch (err) {
      logger.warn({ err, orgId }, "[cron] bounced-levy-digest: aggregation failed");
      continue;
    }
    // Skip silently when nothing is unresolved — the only failures on record
    // were already cleared by a later successful retry. Don't burn the daily
    // dedup slot either: tomorrow we may find new failures and want to email.
    if (summary.totalBounced === 0 || summary.levies.length === 0) {
      continue;
    }
    const branding = {
      orgName: org.name,
      logoUrl: org.logoUrl ?? undefined,
      primaryColor: org.primaryColor ?? undefined,
    };

    // Member-admin recipients = direct org_admin app_users plus org_memberships
    // entries whose role is org_admin / membership_secretary / treasurer
    // (mirrors the requireMemberAdmin RBAC used by the in-app banner endpoint).
    const directAdmins = await db
      .select({ userId: appUsersTable.id, email: appUsersTable.email, displayName: appUsersTable.displayName, username: appUsersTable.username })
      .from(appUsersTable)
      .where(and(eq(appUsersTable.organizationId, orgId), eq(appUsersTable.role, "org_admin")));
    const memberAdmins = await db
      .select({ userId: appUsersTable.id, email: appUsersTable.email, displayName: appUsersTable.displayName, username: appUsersTable.username })
      .from(orgMembershipsTable)
      .innerJoin(appUsersTable, eq(orgMembershipsTable.userId, appUsersTable.id))
      .where(and(
        eq(orgMembershipsTable.organizationId, orgId),
        inArray(orgMembershipsTable.role, ["org_admin", "membership_secretary", "treasurer"]),
      ));
    const seen = new Set<number>();
    const admins = [...directAdmins, ...memberAdmins].filter(a => {
      if (seen.has(a.userId)) return false;
      seen.add(a.userId);
      return true;
    }).filter(a => Boolean(a.email));

    if (admins.length === 0) {
      logger.info({ orgId }, "[cron] bounced-levy-digest: no admin recipients with email");
      // Stamp lastSentOn so we don't reprocess this org every hour today.
      await db.update(organizationsTable)
        .set({ bouncedDigestLastSentOn: sendDate, updatedAt: new Date() })
        .where(eq(organizationsTable.id, orgId));
      // Task #1444 — alert via the standard digest-failed channel so an
      // org with zero deliverable admins is auditable rather than silent.
      await notifyAdminsOfBouncedLevyRemindersDigestFailure({
        orgId,
        status: "skipped",
        reason: "no admin recipients with an email address",
        pausedRecipients: [],
        org: { name: org.name, logoUrl: org.logoUrl, primaryColor: org.primaryColor },
      });
      continue;
    }

    // ── Bounce-aware recipient filter (Task #1444) ─────────────────────
    // Strip suppressed addresses out of the dynamically-derived admin
    // list. Unlike the per-levy / org ledger digests there is no JSON
    // recipient list to persist — admins are recomputed every tick from
    // RBAC roles — so the helper is used purely as a filter.
    const adminEmails = admins.map(a => a.email!).filter(Boolean);
    const { pausedRecipients } = await pauseSuppressedRecipients({
      organizationId: orgId,
      configuredRecipients: adminEmails,
      logScope: "bounced-levy-digest",
    });
    const pausedSet = new Set(pausedRecipients.map(s => s.toLowerCase()));
    const sendable = admins.filter(a => !pausedSet.has(String(a.email).toLowerCase()));

    if (sendable.length === 0) {
      logger.info({ orgId, paused: pausedRecipients.length }, "[cron] bounced-levy-digest: every admin recipient is on the suppression list");
      await db.update(organizationsTable)
        .set({ bouncedDigestLastSentOn: sendDate, updatedAt: new Date() })
        .where(eq(organizationsTable.id, orgId));
      await notifyAdminsOfBouncedLevyRemindersDigestFailure({
        orgId,
        status: "skipped",
        reason: `every admin recipient (${pausedRecipients.join(", ")}) is on the bounce / unsubscribe suppression list`,
        pausedRecipients,
        org: { name: org.name, logoUrl: org.logoUrl, primaryColor: org.primaryColor },
      });
      continue;
    }

    let orgRecipientsEmailed = 0;
    const sendErrors: string[] = [];
    for (const rec of sendable) {
      try {
        await sendBouncedLevyDigestEmail({
          to: rec.email!,
          staffName: rec.displayName ?? rec.username ?? "Admin",
          baseUrl,
          totalBounced: summary.totalBounced,
          levies: summary.levies,
          branding,
          lang: org.defaultLanguage,
        });
        orgRecipientsEmailed += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendErrors.push(`${rec.email}: ${msg}`);
        logger.warn({ err, orgId, recipient: rec.email }, "[cron] bounced-levy-digest email failed");
      }
    }

    if (orgRecipientsEmailed > 0) {
      orgsEmailed += 1;
      recipientsEmailed += orgRecipientsEmailed;
      logger.info(
        { orgId, totalBounced: summary.totalBounced, leviesAffected: summary.levies.length, recipients: orgRecipientsEmailed, paused: pausedRecipients.length },
        "[cron] bounced-levy-digest sent",
      );
    } else {
      // Task #1444 — every send to a non-paused recipient still failed,
      // so this is a hard digest failure (mailer outage / auth break /
      // etc). Audit-log it under the failed key.
      await notifyAdminsOfBouncedLevyRemindersDigestFailure({
        orgId,
        status: "failed",
        reason: `every send attempt failed: ${sendErrors.join("; ") || "unknown error"}`,
        pausedRecipients,
        org: { name: org.name, logoUrl: org.logoUrl, primaryColor: org.primaryColor },
      });
    }
    // Stamp lastSentOn even if every send threw — we don't want to bombard
    // the same inboxes again at the next hourly tick if Gmail is down now.
    await db.update(organizationsTable)
      .set({ bouncedDigestLastSentOn: sendDate, updatedAt: new Date() })
      .where(eq(organizationsTable.id, orgId));
  }

  if (orgsEmailed > 0) {
    logger.info({ orgsEmailed, recipientsEmailed }, "[cron] bounced-levy-digest: hourly run complete");
  }
}

/**
 * Task #1444 — alert org admins / treasurers / membership_secretaries
 * when the bounced-levy reminders cron either has zero deliverable
 * recipients (because every admin email is on the suppression list, or
 * because there are no admins with an email at all) OR when every
 * non-paused recipient's send threw. Mirrors the wallet auto-refund
 * digest's `notifyAdminsOfRefundDigestFailure` shape so audit reviewers
 * see one consistent format across all four finance digests.
 */
async function notifyAdminsOfBouncedLevyRemindersDigestFailure(opts: {
  orgId: number;
  status: "failed" | "skipped";
  reason: string;
  pausedRecipients: string[];
  org: { name: string; logoUrl: string | null; primaryColor: string | null };
}): Promise<void> {
  try {
    const directAdmins = await db
      .select({ userId: appUsersTable.id })
      .from(appUsersTable)
      .where(and(
        eq(appUsersTable.organizationId, opts.orgId),
        eq(appUsersTable.role, "org_admin"),
      ));
    const memberAdmins = await db
      .select({ userId: orgMembershipsTable.userId })
      .from(orgMembershipsTable)
      .where(and(
        eq(orgMembershipsTable.organizationId, opts.orgId),
        inArray(orgMembershipsTable.role, ["org_admin", "treasurer", "membership_secretary"]),
      ));
    const userIds = Array.from(new Set(
      [...directAdmins, ...memberAdmins].map(r => r.userId).filter((n): n is number => typeof n === "number"),
    ));
    if (userIds.length === 0) {
      logger.info({ orgId: opts.orgId }, "[bounced-levy-digest] no admin user ids for failure alert");
      return;
    }

    const orgName = opts.org.name ?? "your club";
    const title = opts.status === "skipped"
      ? `Bounced-levy reminders digest paused (${orgName})`
      : `Bounced-levy reminders digest failed to send (${orgName})`;
    const pausedLine = opts.pausedRecipients.length > 0
      ? ` Paused recipients on the suppression list: ${opts.pausedRecipients.join(", ")}.`
      : "";
    const body = `${opts.reason}.${pausedLine} Open Member 360 → Bounced levies to review the affected members and update the admin recipient list.`;
    const safeBody = escapeHtmlForBouncedLevyDigestAlert(body);
    const safeTitle = escapeHtmlForBouncedLevyDigestAlert(title);
    const emailHtml = `<div style="font-family:Inter,Arial,sans-serif;background:#0a0a0a;color:#fff;padding:24px;max-width:560px;margin:0 auto;border-radius:12px;">
        <h2 style="margin:0 0 12px;font-size:18px;color:#f87171;">${safeTitle}</h2>
        <p style="margin:0 0 16px;color:#d1d5db;line-height:1.5;">${safeBody}</p>
        <p style="margin:24px 0 0;color:#6b7280;font-size:12px;">Status: ${opts.status} · Org id: ${opts.orgId}</p>
      </div>`;

    await dispatchNotification("levy.reminders.digest.failed", userIds, {
      title,
      body,
      emailSubject: title,
      emailHtml,
      data: {
        organizationId: opts.orgId,
        status: opts.status,
        reason: opts.reason,
        pausedRecipients: opts.pausedRecipients,
      },
      branding: {
        orgName,
        logoUrl: opts.org.logoUrl ?? undefined,
        primaryColor: opts.org.primaryColor ?? undefined,
        orgId: opts.orgId,
      },
    });
  } catch (err) {
    logger.warn({ err, orgId: opts.orgId }, "[bounced-levy-digest] admin failure dispatch failed");
  }
}

function escapeHtmlForBouncedLevyDigestAlert(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Stuck erasure cleanup digest (Task #1078) ──────────────────────────────
// Daily controller digest emailed to org_admins / membership_secretaries /
// treasurers when one or more members' account erasure left object-storage
// files behind. Suppressed silently on days the org-wide stuck count is
// zero so the inbox doesn't become noise. Per-org `erasureStorageDigestLastSentOn`
// dedup watermark (UTC YYYY-MM-DD) survives restarts so the boot-time fire
// can't double-send when the job is also polled every 24h.
export async function sendErasureStorageFailuresDigest() {
  const baseUrl = process.env.APP_BASE_URL
    ?? (process.env.PUBLIC_BASE_URL
      ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`);

  // Only consider orgs that actually have at least one erasure audit row —
  // any org without one cannot have a stuck cleanup, and skipping them keeps
  // the per-org loop cheap on fresh installs / test orgs.
  const candidateOrgs = await db
    .selectDistinct({ orgId: memberAuditLogTable.organizationId })
    .from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.entity, "club_member"),
      eq(memberAuditLogTable.action, "delete"),
    ));

  const candidateOrgIds = candidateOrgs
    .map(o => o.orgId)
    .filter((id): id is number => typeof id === "number");
  if (candidateOrgIds.length === 0) {
    logger.debug("[cron] erasure-storage-digest: no orgs with erasure audit rows");
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  // Lazy-import the aggregator to avoid a static cron ↔ member-360 cycle.
  const { getStuckErasureStorageFailuresForOrg } = await import("../routes/member-360.js");

  let orgsEmailed = 0;
  let recipientsEmailed = 0;
  // Task #1242 — track controllers who opted out via
  // `userNotificationPrefs.notifyErasureStorageDigest`. Counted on a
  // dedicated log field so it never inflates the "delivered" metric.
  let recipientsSuppressed = 0;
  // Task #1241 — track in-app dispatch separately so orgs that only have
  // push-only controllers (no email-on-file) still show up in the daily
  // summary log instead of looking like a no-op run.
  let orgsInAppNotified = 0;
  let inAppRecipientsNotified = 0;

  for (const orgId of candidateOrgIds) {
    const [org] = await db
      .select({
        name: organizationsTable.name,
        logoUrl: organizationsTable.logoUrl,
        primaryColor: organizationsTable.primaryColor,
        erasureStorageDigestLastSentOn: organizationsTable.erasureStorageDigestLastSentOn,
      })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    if (!org) continue;

    // Per-day dedup — the cron fires on boot AND every 24h, so a restart
    // inside the daily window must not re-send today's digest.
    if (org.erasureStorageDigestLastSentOn === today) continue;

    let agg;
    try {
      agg = await getStuckErasureStorageFailuresForOrg(orgId);
    } catch (err) {
      logger.warn({ err, orgId }, "[cron] erasure-storage-digest: aggregation failed");
      continue;
    }
    // Suppress on zero — no inbox noise, no dedup-stamp burned, so a fresh
    // failure tomorrow still triggers the digest.
    if (agg.count === 0) continue;

    // Recipients = direct org_admin app_users plus org_memberships entries
    // with org_admin / membership_secretary / treasurer (mirrors the same
    // requireMemberAdmin RBAC the privacy dashboard endpoint uses).
    // Task #1242 — left-join `userNotificationPrefs` so we can honour the
    // per-user `notifyErasureStorageDigest` opt-out without a second query
    // per recipient. A missing prefs row is treated as opted-in (the
    // column defaults to true), matching the data-export-expiring opt-out
    // pattern (Task #1075).
    const directAdmins = await db
      .select({
        userId: appUsersTable.id,
        email: appUsersTable.email,
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
        notifyDigest: userNotificationPrefsTable.notifyErasureStorageDigest,
      })
      .from(appUsersTable)
      .leftJoin(userNotificationPrefsTable, eq(userNotificationPrefsTable.userId, appUsersTable.id))
      .where(and(eq(appUsersTable.organizationId, orgId), eq(appUsersTable.role, "org_admin")));
    const memberAdmins = await db
      .select({
        userId: appUsersTable.id,
        email: appUsersTable.email,
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
        notifyDigest: userNotificationPrefsTable.notifyErasureStorageDigest,
      })
      .from(orgMembershipsTable)
      .innerJoin(appUsersTable, eq(orgMembershipsTable.userId, appUsersTable.id))
      .leftJoin(userNotificationPrefsTable, eq(userNotificationPrefsTable.userId, appUsersTable.id))
      .where(and(
        eq(orgMembershipsTable.organizationId, orgId),
        inArray(orgMembershipsTable.role, ["org_admin", "membership_secretary", "treasurer"]),
      ));
    const seen = new Set<number>();
    // Task #1241 — keep ALL controllers (no email filter) so the in-app
    // inbox + push dispatch reaches controllers who live in the app and
    // never set an email on file. The email send below still requires
    // an email address.
    const allControllers = [...directAdmins, ...memberAdmins].filter(a => {
      if (seen.has(a.userId)) return false;
      seen.add(a.userId);
      return true;
    });
    const emailRecipients = allControllers.filter(a => Boolean(a.email));

    if (allControllers.length === 0) {
      logger.info({ orgId }, "[cron] erasure-storage-digest: no controller recipients");
      // Still stamp so we don't keep recomputing this org every poll today.
      await db.update(organizationsTable)
        .set({ erasureStorageDigestLastSentOn: today, updatedAt: new Date() })
        .where(eq(organizationsTable.id, orgId));
      continue;
    }

    const branding = {
      orgName: org.name,
      logoUrl: org.logoUrl ?? undefined,
      primaryColor: org.primaryColor ?? undefined,
    };

    // Task #1242 — lazy-import the unsubscribe-token signer. Kept inside
    // the loop body's module scope (not at the top of cron.ts) so unit
    // tests that don't exercise this path don't have to provide a
    // SESSION_SECRET.
    const { signErasureStorageDigestOptOutToken } = await import("./bouncedDigestUnsubscribe.js");

    let orgRecipientsEmailed = 0;
    let orgRecipientsSuppressed = 0;
    for (const rec of emailRecipients) {
      // Task #1242 — honour the per-user opt-out. Suppressed recipients
      // are counted on a separate log field (not `recipientsEmailed`) so
      // operations dashboards can distinguish "we delivered" from "they
      // muted". Missing prefs row → defaults to opted-in, matching the
      // column default.
      if (rec.notifyDigest === false) {
        orgRecipientsSuppressed += 1;
        continue;
      }
      // Mint a one-click unsubscribe URL per recipient. If
      // SESSION_SECRET is missing we still send the email — the
      // in-portal toggle remains available — but skip the link rather
      // than dropping the digest entirely.
      let unsubscribeUrl: string | undefined;
      try {
        const token = signErasureStorageDigestOptOutToken(rec.userId, orgId);
        unsubscribeUrl = `${baseUrl.replace(/\/$/, "")}/api/public/erasure-digest-unsubscribe?token=${encodeURIComponent(token)}`;
      } catch (err) {
        logger.warn({ err, orgId }, "[cron] erasure-storage-digest: could not sign unsubscribe token");
      }
      try {
        await sendErasureStorageFailuresDigestEmail({
          to: rec.email!,
          staffName: rec.displayName ?? rec.username ?? "Controller",
          baseUrl,
          count: agg.count,
          totalFailedFiles: agg.totalFailedFiles,
          pendingStorageDeletions: agg.pendingStorageDeletions,
          items: agg.items,
          branding,
          unsubscribeUrl,
        });
        orgRecipientsEmailed += 1;
      } catch (err) {
        logger.warn({ err, orgId, recipient: rec.email }, "[cron] erasure-storage-digest email failed");
      }
    }

    // Task #1241 — emit an in-app inbox row + push to every controller
    // (regardless of email-on-file) so controllers who live in the app and
    // never check email still see the alert. Same per-org per-UTC-day dedup
    // as the email — the watermark stamp below covers both channels in one
    // pass, so a restart inside the daily window can't double-notify.
    // Deep-links into the same /privacy?panel=erasure-storage-failures
    // surface the email links to.
    const trimmedBaseUrl = baseUrl.replace(/\/+$/, "");
    const dashboardUrl = `${trimmedBaseUrl}/privacy?panel=erasure-storage-failures`;
    let inAppDispatched = false;
    try {
      await dispatchNotification(
        "privacy.erasure.storage_failures.controller_digest",
        allControllers.map(c => c.userId),
        {
          title: `${org.name ?? "Your club"} — stuck erasure cleanup`,
          body: agg.count === 1
            ? `1 member's account erasure left ${agg.totalFailedFiles} object-storage file${agg.totalFailedFiles === 1 ? "" : "s"} behind.`
            : `${agg.count} members' account erasures left ${agg.totalFailedFiles} object-storage file${agg.totalFailedFiles === 1 ? "" : "s"} behind.`,
          data: {
            type: "privacy_erasure_storage_failures_digest",
            organizationId: orgId,
            count: agg.count,
            totalFailedFiles: agg.totalFailedFiles,
            url: dashboardUrl,
            deepLink: "/privacy?panel=erasure-storage-failures",
          },
          branding: {
            orgId,
            orgName: org.name ?? undefined,
            logoUrl: org.logoUrl ?? undefined,
            primaryColor: org.primaryColor ?? undefined,
          },
        },
      );
      inAppDispatched = true;
      orgsInAppNotified += 1;
      inAppRecipientsNotified += allControllers.length;
    } catch (err) {
      // dispatchNotification already swallows per-channel delivery errors;
      // the only way it throws is programmer error (unregistered key).
      // Log + carry on so the email path and watermark stamp still run.
      logger.warn({ err, orgId }, "[cron] erasure-storage-digest in-app dispatch failed");
    }

    if (orgRecipientsEmailed > 0 || orgRecipientsSuppressed > 0 || inAppDispatched) {
      if (orgRecipientsEmailed > 0) orgsEmailed += 1;
      recipientsEmailed += orgRecipientsEmailed;
      recipientsSuppressed += orgRecipientsSuppressed;
      logger.info(
        {
          orgId,
          count: agg.count,
          totalFailedFiles: agg.totalFailedFiles,
          recipients: orgRecipientsEmailed,
          suppressed: orgRecipientsSuppressed,
          inAppRecipients: inAppDispatched ? allControllers.length : 0,
        },
        "[cron] erasure-storage-digest sent",
      );
    }
    // Stamp regardless — if every send threw (e.g. SMTP down), we don't want
    // to bombard the same inboxes again on the next poll today.
    await db.update(organizationsTable)
      .set({ erasureStorageDigestLastSentOn: today, updatedAt: new Date() })
      .where(eq(organizationsTable.id, orgId));
  }

  if (orgsEmailed > 0 || recipientsSuppressed > 0 || orgsInAppNotified > 0) {
    logger.info(
      { orgsEmailed, recipientsEmailed, recipientsSuppressed, orgsInAppNotified, inAppRecipientsNotified },
      "[cron] erasure-storage-digest: daily run complete",
    );
  }
}

// ─── Monthly member-preferences controller digest (Task #1489) ─────────────
// Once per calendar month, email org_admins / membership_secretaries /
// treasurers a CSV snapshot of every member's notification preferences
// for their org. Reuses the same recipient resolution and per-user
// opt-out + List-Unsubscribe pattern as the daily stuck-erasure digest
// (Task #1242) but stamps a `YYYY-MM` watermark on
// `organizations.memberPrefsDigestLastSentOn` so the cron polls daily
// and only fires once per (org, calendar month). The polling cadence
// keeps the boot-time fire safe — a deploy mid-month re-checks the
// stamp instead of double-sending.
export async function sendMemberPrefsDigest() {
  const baseUrl = process.env.APP_BASE_URL
    ?? (process.env.PUBLIC_BASE_URL
      ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`);

  const now = new Date();
  // YYYY-MM in UTC — matches the comment on
  // `organizations.memberPrefsDigestLastSentOn`. A month rollover at
  // 00:00 UTC may differ from a controller's local month rollover, but
  // the stamp's only job is dedup; admins reading the audit row see the
  // exact `sentAt` timestamp anyway.
  const yearMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const periodLabel = now.toLocaleString("en", {
    timeZone: "UTC", month: "long", year: "numeric",
  });

  // Iterate every org; per-org dedup via the watermark stamp keeps
  // re-runs cheap even on installs with hundreds of orgs because the
  // CSV builder + recipient query is only invoked when the stamp lags
  // the current month.
  const orgs = await db.select({
    id: organizationsTable.id,
    name: organizationsTable.name,
    logoUrl: organizationsTable.logoUrl,
    primaryColor: organizationsTable.primaryColor,
    memberPrefsDigestLastSentOn: organizationsTable.memberPrefsDigestLastSentOn,
  }).from(organizationsTable);

  let orgsEmailed = 0;
  let recipientsEmailed = 0;
  // Mirrors the erasure digest's separate counter so opt-outs never
  // inflate the "delivered" metric on the daily summary log.
  let recipientsSuppressed = 0;

  // Lazy-imports to avoid pulling routes/members.ts (and its express
  // router transitive imports) into cron.ts module init, and to keep
  // the unsubscribe-token signer's SESSION_SECRET requirement out of
  // unit tests that don't exercise this path.
  const { buildMemberNotificationPrefsCsv } = await import("../routes/members.js");
  const { signMemberPrefsDigestOptOutToken } = await import("./bouncedDigestUnsubscribe.js");

  for (const org of orgs) {
    if (org.memberPrefsDigestLastSentOn === yearMonth) continue;

    // Recipients = direct org_admin app_users plus org_memberships
    // entries with org_admin / membership_secretary / treasurer.
    // Mirrors the requireMemberAdmin RBAC the privacy dashboard
    // endpoint and the erasure-storage digest cron use. Left-joins
    // `userNotificationPrefs` so we can honour the per-user
    // `notifyMemberPrefsDigest` opt-out without a second query per
    // recipient. A missing prefs row is treated as opted-in (the
    // column defaults to true).
    const directAdmins = await db
      .select({
        userId: appUsersTable.id,
        email: appUsersTable.email,
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
        notifyDigest: userNotificationPrefsTable.notifyMemberPrefsDigest,
      })
      .from(appUsersTable)
      .leftJoin(userNotificationPrefsTable, eq(userNotificationPrefsTable.userId, appUsersTable.id))
      .where(and(eq(appUsersTable.organizationId, org.id), eq(appUsersTable.role, "org_admin")));
    const memberAdmins = await db
      .select({
        userId: appUsersTable.id,
        email: appUsersTable.email,
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
        notifyDigest: userNotificationPrefsTable.notifyMemberPrefsDigest,
      })
      .from(orgMembershipsTable)
      .innerJoin(appUsersTable, eq(orgMembershipsTable.userId, appUsersTable.id))
      .leftJoin(userNotificationPrefsTable, eq(userNotificationPrefsTable.userId, appUsersTable.id))
      .where(and(
        eq(orgMembershipsTable.organizationId, org.id),
        inArray(orgMembershipsTable.role, ["org_admin", "membership_secretary", "treasurer"]),
      ));
    const seen = new Set<number>();
    const allControllers = [...directAdmins, ...memberAdmins].filter(a => {
      if (seen.has(a.userId)) return false;
      seen.add(a.userId);
      return true;
    });
    const emailRecipients = allControllers.filter(a => Boolean(a.email));

    if (emailRecipients.length === 0) {
      // Stamp anyway so we don't keep recomputing this org every poll
      // for the rest of the month (mirrors the erasure-digest "no
      // recipients" path).
      await db.update(organizationsTable)
        .set({ memberPrefsDigestLastSentOn: yearMonth, updatedAt: new Date() })
        .where(eq(organizationsTable.id, org.id));
      continue;
    }

    let csvBundle: { csv: string; rowCount: number; filename: string };
    try {
      csvBundle = await buildMemberNotificationPrefsCsv({ orgId: org.id });
    } catch (err) {
      logger.warn({ err, orgId: org.id }, "[cron] member-prefs-digest: CSV build failed");
      continue;
    }

    const branding = {
      orgId: org.id,
      orgName: org.name,
      logoUrl: org.logoUrl ?? undefined,
      primaryColor: org.primaryColor ?? undefined,
    };

    let orgRecipientsEmailed = 0;
    let orgRecipientsSuppressed = 0;
    // Tracks how many sends we *attempted* (after opt-out filtering) so
    // we can distinguish "nothing to do" (no eligible recipients ⇒ safe
    // to stamp the watermark) from "all sends failed" (transient SMTP
    // outage ⇒ must NOT stamp, otherwise a single bad poll silences
    // the whole calendar month).
    let orgRecipientsAttempted = 0;
    const deliveredTo: Array<{ userId: number; email: string }> = [];
    for (const rec of emailRecipients) {
      // Honour the per-user opt-out. Suppressed recipients are counted
      // on a separate log field (not `recipientsEmailed`) so ops
      // dashboards distinguish "we delivered" from "they muted".
      if (rec.notifyDigest === false) {
        orgRecipientsSuppressed += 1;
        continue;
      }
      let unsubscribeUrl: string | undefined;
      try {
        const token = signMemberPrefsDigestOptOutToken(rec.userId, org.id);
        unsubscribeUrl = `${baseUrl.replace(/\/$/, "")}/api/public/member-prefs-digest-unsubscribe?token=${encodeURIComponent(token)}`;
      } catch (err) {
        logger.warn({ err, orgId: org.id }, "[cron] member-prefs-digest: could not sign unsubscribe token");
      }
      orgRecipientsAttempted += 1;
      try {
        await sendMemberPrefsDigestEmail({
          to: rec.email!,
          staffName: rec.displayName ?? rec.username ?? "Controller",
          baseUrl,
          period: periodLabel,
          rowCount: csvBundle.rowCount,
          filename: csvBundle.filename,
          csv: csvBundle.csv,
          branding,
          unsubscribeUrl,
        });
        orgRecipientsEmailed += 1;
        deliveredTo.push({ userId: rec.userId, email: rec.email! });
      } catch (err) {
        logger.warn({ err, orgId: org.id, recipient: rec.email }, "[cron] member-prefs-digest email failed");
      }
    }

    if (orgRecipientsEmailed > 0 || orgRecipientsSuppressed > 0) {
      if (orgRecipientsEmailed > 0) orgsEmailed += 1;
      recipientsEmailed += orgRecipientsEmailed;
      recipientsSuppressed += orgRecipientsSuppressed;
      logger.info(
        {
          orgId: org.id,
          period: periodLabel,
          memberRows: csvBundle.rowCount,
          recipients: orgRecipientsEmailed,
          suppressed: orgRecipientsSuppressed,
        },
        "[cron] member-prefs-digest sent",
      );
    }

    // Audit row recording recipients + timing so admins can later see
    // who received the digest and when. Skipped on dry-runs (no
    // delivered recipients AND no suppressed). The audit lives on
    // `member_audit_log` with `entity = "comm_prefs"` to match the
    // shape used by the public unsubscribe handlers (Task #1454).
    if (deliveredTo.length > 0 || orgRecipientsSuppressed > 0) {
      try {
        const { recordMemberAudit } = await import("./auditMember.js");
        await recordMemberAudit({
          req: null,
          organizationId: org.id,
          clubMemberId: null,
          entity: "comm_prefs",
          entityId: null,
          action: "member_prefs_digest_sent",
          reason: "Monthly member notification-preferences digest",
          metadata: {
            source: "cron",
            kind: "member_prefs_digest",
            period: yearMonth,
            sentAt: new Date().toISOString(),
            memberRows: csvBundle.rowCount,
            filename: csvBundle.filename,
            recipientsEmailed: orgRecipientsEmailed,
            recipientsSuppressed: orgRecipientsSuppressed,
            recipients: deliveredTo,
          },
        });
      } catch (err) {
        logger.warn({ err, orgId: org.id }, "[cron] member-prefs-digest audit insert failed");
      }
    }

    // Stamp the watermark UNLESS we attempted at least one send and
    // every attempt failed (transient SMTP outage). Stamping in that
    // scenario would silence the digest for the entire calendar month
    // — too long a blackout for a monthly cadence. Cases that DO stamp:
    //   * orgRecipientsEmailed > 0  → at least one delivery succeeded.
    //   * orgRecipientsAttempted == 0 → no eligible recipients (all
    //     opted out, or no controllers at all). Re-running tomorrow
    //     would compute the same empty result, so stamping prevents
    //     an unnecessary daily re-query for the rest of the month.
    // The `attempted > 0 && emailed === 0` branch logs a loud warning
    // so ops can spot persistent outages from the daily run summary.
    const allSendsFailed = orgRecipientsAttempted > 0 && orgRecipientsEmailed === 0;
    if (allSendsFailed) {
      logger.warn(
        {
          orgId: org.id,
          period: periodLabel,
          attempted: orgRecipientsAttempted,
          suppressed: orgRecipientsSuppressed,
        },
        "[cron] member-prefs-digest: every send failed — leaving watermark unstamped so tomorrow's poll retries",
      );
    } else {
      await db.update(organizationsTable)
        .set({ memberPrefsDigestLastSentOn: yearMonth, updatedAt: new Date() })
        .where(eq(organizationsTable.id, org.id));
    }
  }

  if (orgsEmailed > 0 || recipientsSuppressed > 0) {
    logger.info(
      { orgsEmailed, recipientsEmailed, recipientsSuppressed, period: periodLabel },
      "[cron] member-prefs-digest: monthly run complete",
    );
  }
}

// ─── Spectator tee-off countdown alerts ──────────────────────────────────────
// Runs every 5 minutes. Finds tee times whose teeTime falls in [now+4m, now+10m]
// and emits a `tee_off` spectator push for every player in the group, so any
// follower with notifyTeeOff = true is alerted ~5–10 minutes before the group
// is up. Deduped per teeTimeId via an in-memory map (TTL-pruned) so the same
// group never gets multiple alerts across overlapping cron windows.
const TEE_OFF_ALERT_POLL_INTERVAL_MS = 5 * 60 * 1000;
const teeOffAlertedTeeTimes = new Map<number, number>(); // teeTimeId → sentAtMs

function pruneTeeOffAlertedTeeTimes() {
  const now = Date.now();
  for (const [id, sentAt] of teeOffAlertedTeeTimes) {
    // Keep entries for ~2 hours, well past the 10-minute lookahead window.
    if (now - sentAt > 2 * 60 * 60 * 1000) teeOffAlertedTeeTimes.delete(id);
  }
}

export function _resetSpectatorTeeOffDedupForTest() {
  teeOffAlertedTeeTimes.clear();
}

export async function sendSpectatorTeeOffAlerts() {
  pruneTeeOffAlertedTeeTimes();
  const now = new Date();
  const windowStart = new Date(now.getTime() + 4 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + 10 * 60 * 1000);

  const upcomingGroups = await db
    .select({
      teeTimeId: teeTimesTable.id,
      tournamentId: teeTimesTable.tournamentId,
      teeTime: teeTimesTable.teeTime,
      round: teeTimesTable.round,
      startingHole: teeTimesTable.startingHole,
    })
    .from(teeTimesTable)
    .innerJoin(tournamentsTable, eq(tournamentsTable.id, teeTimesTable.tournamentId))
    .where(and(
      gte(teeTimesTable.teeTime, windowStart),
      lte(teeTimesTable.teeTime, windowEnd),
      sql`${tournamentsTable.status} IN ('upcoming', 'active')`,
      isNull(teeTimesTable.spectatorTeeOffAlertedAt),
    ));

  for (const group of upcomingGroups) {
    if (teeOffAlertedTeeTimes.has(group.teeTimeId)) continue;

    const groupPlayers = await db
      .select({
        playerId: playersTable.id,
        firstName: playersTable.firstName,
        lastName: playersTable.lastName,
      })
      .from(teeTimePlayersTable)
      .innerJoin(playersTable, eq(playersTable.id, teeTimePlayersTable.playerId))
      .where(eq(teeTimePlayersTable.teeTimeId, group.teeTimeId));

    if (groupPlayers.length === 0) {
      teeOffAlertedTeeTimes.set(group.teeTimeId, Date.now());
      await db.update(teeTimesTable)
        .set({ spectatorTeeOffAlertedAt: new Date() })
        .where(eq(teeTimesTable.id, group.teeTimeId));
      continue;
    }

    for (const p of groupPlayers) {
      await deliverSpectatorPush({
        tournamentId: group.tournamentId,
        playerId: p.playerId,
        playerName: `${p.firstName} ${p.lastName}`.trim(),
        holeNumber: group.startingHole,
        strokes: 0,
        par: 0,
        toPar: 0,
        eventType: "tee_off",
        occurredAt: group.teeTime.toISOString(),
        round: group.round,
      });
    }

    teeOffAlertedTeeTimes.set(group.teeTimeId, Date.now());
    await db.update(teeTimesTable)
      .set({ spectatorTeeOffAlertedAt: new Date() })
      .where(eq(teeTimesTable.id, group.teeTimeId));
    logger.info(
      { teeTimeId: group.teeTimeId, tournamentId: group.tournamentId, players: groupPlayers.length },
      "[cron] spectator tee-off alert dispatched",
    );
  }
}

// ─── Custom-domain TLS re-poll (Task #667) ────────────────────────────────────
// Periodically re-poll the ingress provider for organisations whose vanity
// domain certificate is still 'pending' so HTTPS flips to 'active' (or
// 'failed') automatically without an admin opening the settings page.
//
// Backoff: certificate issuance often blocks on DNS propagation, so we don't
// hammer the provider — re-check frequency grows with the age of the request:
//   age <  5 min  → re-check every  1 min   (fast feedback right after save)
//   age < 30 min  → re-check every  5 min
//   age <  2 h    → re-check every 15 min
//   age ≥  2 h    → re-check every  1 h     (long-tail DNS / manual fixes)
const CUSTOM_DOMAIN_CERT_POLL_INTERVAL_MS = 5 * 60 * 1000; // tick every 5 min

export function customDomainCertNextCheckBackoffMs(ageSinceRequestedMs: number): number {
  if (ageSinceRequestedMs < 5 * 60 * 1000) return 60 * 1000;
  if (ageSinceRequestedMs < 30 * 60 * 1000) return 5 * 60 * 1000;
  if (ageSinceRequestedMs < 2 * 60 * 60 * 1000) return 15 * 60 * 1000;
  return 60 * 60 * 1000;
}

export async function recheckPendingCustomDomainCerts() {
  const rows = await db
    .select({
      id: organizationsTable.id,
      customDomain: organizationsTable.customDomain,
      requestedAt: organizationsTable.customDomainCertRequestedAt,
      checkedAt: organizationsTable.customDomainCertCheckedAt,
    })
    .from(organizationsTable)
    .where(and(
      eq(organizationsTable.customDomainCertStatus, "pending"),
      isNotNull(organizationsTable.customDomain),
    ));

  if (rows.length === 0) return;

  const client = getIngressClient();
  const now = new Date();
  let flippedActive = 0;
  let flippedFailed = 0;
  let skipped = 0;

  for (const row of rows) {
    const host = (row.customDomain ?? "").trim().toLowerCase();
    if (!host) continue;

    const requestedAt = row.requestedAt ?? row.checkedAt ?? now;
    const ageMs = Math.max(0, now.getTime() - requestedAt.getTime());
    const sinceLastCheckMs = row.checkedAt
      ? now.getTime() - row.checkedAt.getTime()
      : Number.POSITIVE_INFINITY;
    const minIntervalMs = customDomainCertNextCheckBackoffMs(ageMs);
    if (sinceLastCheckMs < minIntervalMs) { skipped++; continue; }

    let result: { provider: string; status: CertStatus; error?: string };
    try {
      result = await client.getHostnameStatus(host);
    } catch (e) {
      // Transient ingress error — record but stay 'pending' so the next tick
      // (with backoff) retries. We bump checkedAt + error so admins can see
      // the latest attempt and the backoff timer advances.
      const msg = e instanceof Error ? e.message : "Ingress request failed";
      await db.update(organizationsTable)
        .set({
          customDomainCertError: msg,
          customDomainCertCheckedAt: now,
          updatedAt: now,
        })
        .where(eq(organizationsTable.id, row.id));
      logger.warn({ err: msg, orgId: row.id, host }, "[cron] custom-domain cert re-check threw, will retry");
      continue;
    }

    const patch: Record<string, unknown> = {
      customDomainCertStatus: result.status,
      customDomainCertProvider: result.provider,
      customDomainCertError: result.error ?? null,
      customDomainCertCheckedAt: now,
      updatedAt: now,
    };
    if (result.status === "active") {
      patch.customDomainCertIssuedAt = now;
      // Task #1101 — clear any active re-nudge snooze once the cert is
      // healthy again, so a future regression starts with a fresh window
      // and the admin UI doesn't show a stale "snoozed until …" line.
      patch.customDomainCertRenudgeSnoozedUntil = null;
      // Task #1482 — and drop the "your snooze just ended" banner: the
      // cert is healthy again so the panel shouldn't keep nagging
      // about a snooze that no longer matters.
      patch.customDomainCertSnoozeEndedFromUntil = null;
      flippedActive++;
    } else if (result.status === "failed") {
      flippedFailed++;
    }
    await db.update(organizationsTable)
      .set(patch)
      .where(eq(organizationsTable.id, row.id));
    logger.info(
      { orgId: row.id, host, status: result.status, ageMs },
      "[cron] custom-domain cert re-check",
    );
  }

  if (flippedActive > 0 || flippedFailed > 0) {
    logger.info(
      { totalPending: rows.length, flippedActive, flippedFailed, skipped },
      "[cron] custom-domain cert re-check pass complete",
    );
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * Task #1249 — Re-check saved external logo / favicon URLs in the
 * background so newly broken hosts get caught.
 *
 * Task #1089 verifies the URL at save time, but a host that goes down
 * a week later silently breaks the public mini-site until an admin
 * happens to look. This sweep re-probes each saved external URL with
 * the same SSRF-guarded `verifyExternalImageUrl` helper and:
 *   - skips rows that were checked within the last day (so the sweep
 *     can be polled aggressively without hammering third-party hosts),
 *   - skips internal `/objects/...` paths (the editor's content-type
 *     check already validates those),
 *   - tolerates transient blips by tracking consecutive failures per
 *     URL and only auto-clearing once the count crosses the threshold,
 *   - emails the org admins (org_admin role on app_users + on
 *     org_memberships) when a URL is auto-cleared, with the dropped
 *     URL and the most recent verifier error so they have everything
 *     in hand to paste a fix.
 * ─────────────────────────────────────────────────────────────────── */

/** Sweep cadence — every 6 h. Per-row backoff is enforced separately. */
const MARKETING_IMAGE_RECHECK_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Per-URL backoff: re-verify the same URL at most once a day. */
const MARKETING_IMAGE_RECHECK_PER_ROW_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Auto-clear after this many consecutive failed verifications. */
export const MARKETING_IMAGE_AUTO_CLEAR_FAILURE_THRESHOLD = 3;

/** Test-only override for the per-row backoff window. */
let marketingImageRecheckPerRowMs = MARKETING_IMAGE_RECHECK_PER_ROW_INTERVAL_MS;
/** Test-only override for the auto-clear threshold. */
let marketingImageAutoClearThreshold = MARKETING_IMAGE_AUTO_CLEAR_FAILURE_THRESHOLD;

/**
 * Test-only hook to tighten the per-row backoff and auto-clear
 * threshold so a test can drive an auto-clear in a single call.
 * Pass `null` to restore the production defaults.
 */
export function _setMarketingImageRecheckTuningForTest(
  opts: { perRowMs?: number; autoClearThreshold?: number } | null,
): void {
  if (opts === null) {
    marketingImageRecheckPerRowMs = MARKETING_IMAGE_RECHECK_PER_ROW_INTERVAL_MS;
    marketingImageAutoClearThreshold = MARKETING_IMAGE_AUTO_CLEAR_FAILURE_THRESHOLD;
    return;
  }
  if (opts.perRowMs !== undefined) marketingImageRecheckPerRowMs = opts.perRowMs;
  if (opts.autoClearThreshold !== undefined) marketingImageAutoClearThreshold = opts.autoClearThreshold;
}

/** True when this URL is something the cron should probe externally. */
function isExternalImageUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  return /^https?:\/\//i.test(url);
}

/**
 * Notify org admins (and emit a push) that a marketing-site image URL
 * was just auto-cleared because it failed N consecutive background
 * verifications. Mirrors the recipient lookup the
 * `sendErasureStorageFailureExhaustedEmail` flow uses so it stays
 * consistent with other org-admin alerts.
 */
async function notifyOrgAdminsMarketingImageCleared(opts: {
  organizationId: number;
  imageKind: "logo" | "favicon";
  clearedUrl: string;
  consecutiveFailures: number;
  lastError: string | null;
}): Promise<{ pushRecipients: number; emailRecipients: number }> {
  const { organizationId, imageKind, clearedUrl, consecutiveFailures, lastError } = opts;

  const [org] = await db
    .select({
      name: organizationsTable.name,
      logoUrl: organizationsTable.logoUrl,
      primaryColor: organizationsTable.primaryColor,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, organizationId));
  if (!org) return { pushRecipients: 0, emailRecipients: 0 };

  const directAdmins = await db
    .select({
      userId: appUsersTable.id,
      email: appUsersTable.email,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
    })
    .from(appUsersTable)
    .where(and(
      eq(appUsersTable.organizationId, organizationId),
      eq(appUsersTable.role, "org_admin"),
    ));
  const memberAdmins = await db
    .select({
      userId: appUsersTable.id,
      email: appUsersTable.email,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
    })
    .from(orgMembershipsTable)
    .innerJoin(appUsersTable, eq(orgMembershipsTable.userId, appUsersTable.id))
    .where(and(
      eq(orgMembershipsTable.organizationId, organizationId),
      eq(orgMembershipsTable.role, "org_admin"),
    ));

  const seen = new Set<number>();
  const recipients = [...directAdmins, ...memberAdmins].filter(a => {
    if (seen.has(a.userId)) return false;
    seen.add(a.userId);
    return true;
  });

  const userIds = recipients.map(r => r.userId);
  let pushRecipients = 0;
  if (userIds.length > 0) {
    try {
      const kindLabel = imageKind === "logo" ? "logo" : "favicon";
      await sendTransactionalPush(
        userIds,
        `Marketing ${kindLabel} stopped loading — auto-cleared`,
        `Your saved ${kindLabel} URL failed ${consecutiveFailures} background re-checks. Open the marketing-site editor to paste a working URL.`,
        {
          type: "marketing_image_auto_cleared",
          organizationId,
          imageKind,
          route: "/marketing-site",
        },
      );
      pushRecipients = userIds.length;
    } catch (err) {
      logger.warn(
        { err, organizationId, imageKind },
        "[cron] marketing-image auto-clear admin push failed",
      );
    }
  }

  const baseUrl = process.env.APP_BASE_URL
    ?? (process.env.PUBLIC_BASE_URL
      ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`);
  const branding = {
    orgName: org.name,
    logoUrl: org.logoUrl ?? undefined,
    primaryColor: org.primaryColor ?? undefined,
    orgId: organizationId,
  };

  let emailRecipients = 0;
  for (const rec of recipients) {
    if (!rec.email) continue;
    try {
      await sendMarketingImageBrokenEmail({
        to: rec.email,
        staffName: rec.displayName ?? rec.username ?? "Admin",
        baseUrl,
        imageKind,
        clearedUrl,
        consecutiveFailures,
        lastError,
        branding,
      });
      emailRecipients += 1;
    } catch (err) {
      logger.warn(
        { err, organizationId, imageKind, recipient: rec.email },
        "[cron] marketing-image auto-clear admin email failed",
      );
    }
  }

  return { pushRecipients, emailRecipients };
}

/**
 * Run one pass of the marketing-image recheck.
 *
 * Returns counters useful for logging + tests:
 *   - rowsConsidered: rows whose external URL hadn't been re-verified
 *     within the per-row backoff window.
 *   - probesOk / probesFailed: how the verifier classified them.
 *   - cleared: rows whose URL crossed the auto-clear threshold and was
 *     dropped to NULL (with cacheVersion bumped + admins notified).
 */
export async function recheckExternalMarketingImages(): Promise<{
  rowsConsidered: number;
  probesOk: number;
  probesFailed: number;
  cleared: number;
}> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - marketingImageRecheckPerRowMs);

  // Cheap pre-filter — only pull rows that have at least one external
  // URL whose last-checked timestamp is null (never verified) or older
  // than the per-row backoff. Internal `/objects/...` paths are filtered
  // in JS so the SQL stays portable.
  const dueRows = await db
    .select({
      id: clubMarketingSitesTable.id,
      organizationId: clubMarketingSitesTable.organizationId,
      logoImageUrl: clubMarketingSitesTable.logoImageUrl,
      logoLastCheckedAt: clubMarketingSitesTable.logoImageUrlLastCheckedAt,
      logoConsecutiveFailures: clubMarketingSitesTable.logoImageUrlConsecutiveFailures,
      faviconUrl: clubMarketingSitesTable.faviconUrl,
      faviconLastCheckedAt: clubMarketingSitesTable.faviconUrlLastCheckedAt,
      faviconConsecutiveFailures: clubMarketingSitesTable.faviconUrlConsecutiveFailures,
      cacheVersion: clubMarketingSitesTable.cacheVersion,
    })
    .from(clubMarketingSitesTable)
    .where(or(
      and(
        isNotNull(clubMarketingSitesTable.logoImageUrl),
        or(
          isNull(clubMarketingSitesTable.logoImageUrlLastCheckedAt),
          lt(clubMarketingSitesTable.logoImageUrlLastCheckedAt, cutoff),
        ),
      ),
      and(
        isNotNull(clubMarketingSitesTable.faviconUrl),
        or(
          isNull(clubMarketingSitesTable.faviconUrlLastCheckedAt),
          lt(clubMarketingSitesTable.faviconUrlLastCheckedAt, cutoff),
        ),
      ),
    ));

  let rowsConsidered = 0;
  let probesOk = 0;
  let probesFailed = 0;
  let cleared = 0;

  for (const row of dueRows) {
    for (const kind of ["logo", "favicon"] as const) {
      const url = kind === "logo" ? row.logoImageUrl : row.faviconUrl;
      const lastCheckedAt = kind === "logo" ? row.logoLastCheckedAt : row.faviconLastCheckedAt;
      const failures = (kind === "logo" ? row.logoConsecutiveFailures : row.faviconConsecutiveFailures) ?? 0;

      if (!url) continue;
      if (lastCheckedAt && lastCheckedAt >= cutoff) continue;
      // Internal `/objects/...` paths are validated at save-time by
      // ObjectStorageService — there's nothing to re-probe externally.
      // Stamp the lastCheckedAt anyway so the SQL pre-filter stops
      // re-pulling this row every sweep; the per-row backoff below
      // then keeps it out of the eligible set until it's swapped for
      // an external URL or the row is updated otherwise.
      if (!isExternalImageUrl(url)) {
        const patch: Record<string, unknown> = { updatedAt: now };
        patch[kind === "logo" ? "logoImageUrlLastCheckedAt" : "faviconUrlLastCheckedAt"] = now;
        await db.update(clubMarketingSitesTable)
          .set(patch)
          .where(eq(clubMarketingSitesTable.id, row.id));
        continue;
      }
      rowsConsidered += 1;

      let result;
      try {
        // Task #1800 — Pass the same 1 MB cap that save-time validation
        // applies (Task #1468), so a logo saved before the tightening
        // or a third-party host that later swaps its file for an
        // over-cap image gets rejected by the background re-verify
        // exactly the way re-saving the URL through the admin UI
        // would. Without this, the verifier's 10 MB default would let
        // a 5 MB logo silently keep passing the cron sweep.
        result = await verifyExternalImageUrl(url, {
          maxBytes: MARKETING_LOGO_FAVICON_MAX_BYTES,
        });
      } catch (err) {
        // Treat thrown errors as transient transport failures — record
        // the message but DON'T increment the consecutive-failure
        // counter. The verifier promises to resolve with `{ok:false}`
        // for real failure modes; a thrown exception means our own
        // code blew up and we shouldn't punish the admin for it.
        logger.warn(
          { err, organizationId: row.organizationId, kind },
          "[cron] marketing-image recheck verifier threw, will retry next pass",
        );
        const msg = err instanceof Error ? err.message : String(err);
        const patch: Record<string, unknown> = {
          updatedAt: now,
        };
        patch[kind === "logo" ? "logoImageUrlLastCheckedAt" : "faviconUrlLastCheckedAt"] = now;
        patch[kind === "logo" ? "logoImageUrlLastError" : "faviconUrlLastError"] = `verifier threw: ${msg.slice(0, 240)}`;
        await db.update(clubMarketingSitesTable)
          .set(patch)
          .where(eq(clubMarketingSitesTable.id, row.id));
        continue;
      }

      if (result.ok) {
        probesOk += 1;
        // Reset the failure counter + last error.
        const patch: Record<string, unknown> = {
          updatedAt: now,
        };
        patch[kind === "logo" ? "logoImageUrlLastCheckedAt" : "faviconUrlLastCheckedAt"] = now;
        patch[kind === "logo" ? "logoImageUrlConsecutiveFailures" : "faviconUrlConsecutiveFailures"] = 0;
        patch[kind === "logo" ? "logoImageUrlLastError" : "faviconUrlLastError"] = null;
        await db.update(clubMarketingSitesTable)
          .set(patch)
          .where(eq(clubMarketingSitesTable.id, row.id));
        continue;
      }

      probesFailed += 1;
      const newFailures = failures + 1;

      if (newFailures >= marketingImageAutoClearThreshold) {
        // Auto-clear the URL: reset to NULL, bump cacheVersion so
        // visitors stop loading the broken reference, reset the
        // tracking columns, and notify org admins.
        const patch: Record<string, unknown> = {
          updatedAt: now,
          cacheVersion: row.cacheVersion + 1,
        };
        if (kind === "logo") {
          patch.logoImageUrl = null;
          patch.logoImageUrlLastCheckedAt = now;
          patch.logoImageUrlConsecutiveFailures = 0;
          patch.logoImageUrlLastError = null;
        } else {
          patch.faviconUrl = null;
          patch.faviconUrlLastCheckedAt = now;
          patch.faviconUrlConsecutiveFailures = 0;
          patch.faviconUrlLastError = null;
        }
        await db.update(clubMarketingSitesTable)
          .set(patch)
          .where(eq(clubMarketingSitesTable.id, row.id));
        cleared += 1;

        const notify = await notifyOrgAdminsMarketingImageCleared({
          organizationId: row.organizationId,
          imageKind: kind,
          clearedUrl: url,
          consecutiveFailures: newFailures,
          lastError: result.error,
        });
        logger.info(
          {
            organizationId: row.organizationId,
            kind,
            consecutiveFailures: newFailures,
            error: result.error,
            pushRecipients: notify.pushRecipients,
            emailRecipients: notify.emailRecipients,
          },
          "[cron] marketing-image auto-cleared after consecutive failures",
        );
        // Reflect the bumped cacheVersion in our local copy so a
        // subsequent same-row clear (logo + favicon both broken) keeps
        // monotonically increasing.
        row.cacheVersion += 1;
      } else {
        // Still under threshold — record progress and try again on the
        // next pass.
        const patch: Record<string, unknown> = {
          updatedAt: now,
        };
        patch[kind === "logo" ? "logoImageUrlLastCheckedAt" : "faviconUrlLastCheckedAt"] = now;
        patch[kind === "logo" ? "logoImageUrlConsecutiveFailures" : "faviconUrlConsecutiveFailures"] = newFailures;
        patch[kind === "logo" ? "logoImageUrlLastError" : "faviconUrlLastError"] = result.error;
        await db.update(clubMarketingSitesTable)
          .set(patch)
          .where(eq(clubMarketingSitesTable.id, row.id));
        logger.info(
          {
            organizationId: row.organizationId,
            kind,
            consecutiveFailures: newFailures,
            threshold: marketingImageAutoClearThreshold,
            error: result.error,
          },
          "[cron] marketing-image recheck failed, will retry",
        );
      }
    }
  }

  if (rowsConsidered > 0) {
    logger.info(
      { rowsConsidered, probesOk, probesFailed, cleared },
      "[cron] marketing-image recheck pass complete",
    );
  }

  return { rowsConsidered, probesOk, probesFailed, cleared };
}

/* ─────────────────────────────────────────────────────────────────────
 * Task #1584 — Bounded background auto-retry for legacy NULL-duration
 * videos.
 *
 * Task #1327 added the manual admin "Re-check" action that recovers many
 * of Task #855's transient backfill failures. But it still requires a
 * human to press the button — rows that could be auto-recovered by a
 * simple retry sit on the admin "unverifiable videos" page until someone
 * notices.
 *
 * This sweep:
 *   - finds video rows with `duration_seconds IS NULL` that the cron
 *     hasn't already given up on (`duration_unverifiable_reason IS NULL`),
 *   - skips rows whose `duration_last_checked_at` is more recent than the
 *     per-row backoff (default 1 day) so a single row isn't re-probed
 *     more than once a day even if the sweep is polled more often,
 *   - re-runs the same `probeMediaDurationSeconds` helper the manual
 *     admin endpoint uses,
 *   - on success: writes `duration_seconds`, clears the count + reason,
 *     wipes `duration_last_checked_at` so the row drops off the admin
 *     list,
 *   - on failure: increments `duration_auto_recheck_count`, stamps
 *     `duration_last_checked_at`, and once the count crosses the
 *     `LEGACY_VIDEO_AUTO_RETRY_CAP` threshold flags the row with
 *     `duration_unverifiable_reason = 'object_missing'` (storage said
 *     the file is gone) or `'permanently_unverifiable'` (ffprobe still
 *     can't read it). Flagged rows stop being retried and are the only
 *     thing the admin "unverifiable videos" page shows.
 *
 * The probe is sequential (one row at a time) and bounded per pass so a
 * runaway backlog can't pin the API server on a single ffprobe storm.
 * ─────────────────────────────────────────────────────────────────── */

/** Sweep cadence — daily. Per-row backoff is enforced separately. */
const LEGACY_VIDEO_RECHECK_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Per-row backoff: re-probe a single row at most once a day. */
const LEGACY_VIDEO_RECHECK_PER_ROW_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * After this many consecutive failed background re-probes a row is
 * flagged with a `duration_unverifiable_reason` and stops being
 * auto-retried. Exported so admin tooling and tests can reference the
 * same value.
 */
export const LEGACY_VIDEO_AUTO_RETRY_CAP = 5;
/** Max rows to re-probe per pass. Bounds wall-clock time per sweep. */
const LEGACY_VIDEO_RECHECK_BATCH_SIZE = 25;

let legacyVideoRecheckPerRowMs = LEGACY_VIDEO_RECHECK_PER_ROW_INTERVAL_MS;
let legacyVideoAutoRetryCap = LEGACY_VIDEO_AUTO_RETRY_CAP;
let legacyVideoRecheckBatchSize = LEGACY_VIDEO_RECHECK_BATCH_SIZE;

/**
 * Test-only hook to tighten the per-row backoff, the auto-retry cap,
 * and the batch size so a single test pass can drive a row from
 * fresh-NULL to flagged-unverifiable without sleeping. Pass `null` to
 * restore the production defaults.
 */
export function _setLegacyVideoRecheckTuningForTest(
  opts: { perRowMs?: number; autoRetryCap?: number; batchSize?: number } | null,
): void {
  if (opts === null) {
    legacyVideoRecheckPerRowMs = LEGACY_VIDEO_RECHECK_PER_ROW_INTERVAL_MS;
    legacyVideoAutoRetryCap = LEGACY_VIDEO_AUTO_RETRY_CAP;
    legacyVideoRecheckBatchSize = LEGACY_VIDEO_RECHECK_BATCH_SIZE;
    return;
  }
  if (opts.perRowMs !== undefined) legacyVideoRecheckPerRowMs = opts.perRowMs;
  if (opts.autoRetryCap !== undefined) legacyVideoAutoRetryCap = opts.autoRetryCap;
  if (opts.batchSize !== undefined) legacyVideoRecheckBatchSize = opts.batchSize;
}

/**
 * Run one pass of the legacy-video duration recheck.
 *
 * The probe helper is loaded lazily so unit tests can mock the module
 * via `vi.mock("../lib/mediaDurationProbe")` without the cron module
 * pulling in the real ffprobe path at import time.
 *
 * Returns counters useful for logging + tests:
 *   - rowsConsidered: rows whose per-row backoff had elapsed and were
 *     therefore re-probed this pass.
 *   - recovered:      rows that produced a real duration this pass.
 *   - stillFailing:   rows that re-probed and still failed (bumped
 *                     count, may or may not have crossed the cap).
 *   - flaggedMissing / flaggedUnverifiable: how many rows the cron just
 *                     gave up on, broken down by reason.
 */
export async function recheckLegacyVideoDurations(): Promise<{
  rowsConsidered: number;
  recovered: number;
  stillFailing: number;
  flaggedMissing: number;
  flaggedUnverifiable: number;
}> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - legacyVideoRecheckPerRowMs);

  // Lazy-load so tests can stub the probe module (vi.mock in
  // legacy-video-recheck-cron.test.ts) without importing real ffprobe.
  const { probeMediaDurationSeconds } = await import("./mediaDurationProbe.js");

  const dueRows = await db
    .select({
      id: mediaTable.id,
      organizationId: mediaTable.organizationId,
      objectPath: mediaTable.objectPath,
      uploaderName: mediaTable.uploaderName,
    })
    .from(mediaTable)
    .where(and(
      eq(mediaTable.mediaType, "video"),
      isNull(mediaTable.durationSeconds),
      isNull(mediaTable.durationUnverifiableReason),
      or(
        isNull(mediaTable.durationLastCheckedAt),
        lt(mediaTable.durationLastCheckedAt, cutoff),
      ),
    ))
    // Stable ordering across passes — oldest unattempted rows first so
    // a fresh row doesn't starve out something that's been waiting.
    .orderBy(mediaTable.durationLastCheckedAt, mediaTable.id)
    .limit(legacyVideoRecheckBatchSize);

  let rowsConsidered = 0;
  let recovered = 0;
  let stillFailing = 0;
  let flaggedMissing = 0;
  let flaggedUnverifiable = 0;

  // Task #1975 — Collect rows that this pass just flagged as
  // unverifiable so we can fan out a single digest email per org admin
  // at the end of the sweep. Mirrors the per-org grouping the
  // marketing-image auto-clear flow uses.
  type FlaggedRow = {
    mediaId: number;
    organizationId: number;
    objectPath: string;
    uploaderName: string | null;
    reason: "object_missing" | "permanently_unverifiable";
  };
  const flaggedThisPass: FlaggedRow[] = [];

  for (const row of dueRows) {
    rowsConsidered += 1;

    // Re-read the current count + reason inside the loop in case a
    // concurrent manual recheck just cleared the row from under us.
    const [latest] = await db
      .select({
        count: mediaTable.durationAutoRecheckCount,
        reason: mediaTable.durationUnverifiableReason,
        duration: mediaTable.durationSeconds,
      })
      .from(mediaTable)
      .where(eq(mediaTable.id, row.id))
      .limit(1);
    if (!latest || latest.duration !== null || latest.reason !== null) {
      // Row was recovered or flagged by another path between our SELECT
      // and now. Skip — we'll re-evaluate on the next pass.
      rowsConsidered -= 1;
      continue;
    }

    let probeResult: number | null = null;
    let objectMissing = false;
    let probeError: string | null = null;
    try {
      probeResult = await probeMediaDurationSeconds(row.objectPath);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        objectMissing = true;
      } else {
        // A thrown non-ObjectNotFound error means our own probe code
        // (or transport) blew up — count it as a failure but log it
        // loudly so we notice persistent infra problems.
        probeError = err instanceof Error ? err.message : String(err);
        logger.warn(
          { err, mediaId: row.id, objectPath: row.objectPath },
          "[cron] legacy-video recheck probe threw unexpected error",
        );
      }
    }

    if (probeResult !== null) {
      // Recovered — drop off the unverifiable list.
      await db.update(mediaTable)
        .set({
          durationSeconds: probeResult,
          durationLastCheckedAt: null,
          durationAutoRecheckCount: 0,
          durationUnverifiableReason: null,
        })
        .where(eq(mediaTable.id, row.id));
      recovered += 1;
      logger.info(
        { mediaId: row.id, durationSeconds: probeResult },
        "[cron] legacy-video recheck recovered duration",
      );
      continue;
    }

    // Failure path: bump the count, stamp last-checked, and decide
    // whether we've reached the give-up cap.
    const newCount = (latest.count ?? 0) + 1;
    const reachedCap = newCount >= legacyVideoAutoRetryCap;
    const reason = reachedCap
      ? (objectMissing ? "object_missing" : "permanently_unverifiable")
      : null;

    await db.update(mediaTable)
      .set({
        durationAutoRecheckCount: newCount,
        durationLastCheckedAt: now,
        durationUnverifiableReason: reason,
      })
      .where(eq(mediaTable.id, row.id));

    stillFailing += 1;
    if (reachedCap) {
      if (objectMissing) flaggedMissing += 1;
      else flaggedUnverifiable += 1;
      // Task #1975 — Stash so the post-loop digest pass can group these
      // by org and fan out one email per admin. We don't email inline
      // because a single sweep can flag rows from many orgs, and we
      // want each admin to get a single digest, not one email per row.
      flaggedThisPass.push({
        mediaId: row.id,
        organizationId: row.organizationId,
        objectPath: row.objectPath,
        uploaderName: row.uploaderName,
        reason: reason as "object_missing" | "permanently_unverifiable",
      });
      logger.info(
        {
          mediaId: row.id,
          attempts: newCount,
          reason,
          objectPath: row.objectPath,
          probeError,
        },
        "[cron] legacy-video recheck gave up after consecutive failures",
      );
    } else {
      logger.debug(
        { mediaId: row.id, attempts: newCount, cap: legacyVideoAutoRetryCap, objectMissing, probeError },
        "[cron] legacy-video recheck still failing, will retry",
      );
    }
  }

  if (rowsConsidered > 0) {
    logger.info(
      { rowsConsidered, recovered, stillFailing, flaggedMissing, flaggedUnverifiable },
      "[cron] legacy-video recheck pass complete",
    );
  }

  // Task #1975 — Fan out a single digest email per org admin for the
  // rows we just flagged. The dedup stamp is claimed BEFORE the email
  // fan-out (atomic `WHERE durationFlagNotifiedAt IS NULL` in the
  // helper) so two concurrent sweeps can't both email about the same
  // row. A mailer failure for an individual recipient is logged and
  // skipped without rolling the stamp back — the row is still
  // permanently in the unverifiable set and admins can see it on
  // /media-admin; they just don't get a re-email about it on the next
  // pass. This matches how the marketing-image auto-clear flow treats
  // per-recipient send failures.
  if (flaggedThisPass.length > 0) {
    await notifyOrgAdminsLegacyVideosUnverifiable(flaggedThisPass);
  }

  return { rowsConsidered, recovered, stillFailing, flaggedMissing, flaggedUnverifiable };
}

/**
 * Task #1975 — Group `recheckLegacyVideoDurations`'s newly-flagged rows
 * by org, look up the org's admins (direct + via org_memberships, with
 * dedup), and send each admin a single digest email listing every row.
 *
 * Dedup pattern: each row's `durationFlagNotifiedAt` is stamped before
 * the email fan-out so a subsequent sweep that somehow re-encounters
 * the same row (e.g. a manual recheck cleared and the cron then
 * re-flagged it) won't re-include it in another digest. We claim the
 * stamp with a NULL guard so two concurrent sweeps can't both email
 * about the same row.
 */
async function notifyOrgAdminsLegacyVideosUnverifiable(
  rows: Array<{
    mediaId: number;
    organizationId: number;
    objectPath: string;
    uploaderName: string | null;
    reason: "object_missing" | "permanently_unverifiable";
  }>,
): Promise<void> {
  // Atomic claim: only keep the rows we successfully stamped. A
  // sibling sweep that races us will lose the guard and we'll skip
  // those rows here, exactly mirroring how `exhaustionNotifiedAt`
  // protects the per-row erasure-orphan alert above.
  const now = new Date();
  const claimed = await db
    .update(mediaTable)
    .set({ durationFlagNotifiedAt: now })
    .where(and(
      inArray(mediaTable.id, rows.map(r => r.mediaId)),
      isNull(mediaTable.durationFlagNotifiedAt),
    ))
    .returning({ id: mediaTable.id });
  const claimedIds = new Set(claimed.map(c => c.id));
  const claimedRows = rows.filter(r => claimedIds.has(r.mediaId));
  if (claimedRows.length === 0) return;

  // Group by org so each admin gets a single digest scoped to their
  // org, even if a single sweep flagged rows across many orgs.
  const byOrg = new Map<number, typeof claimedRows>();
  for (const r of claimedRows) {
    const list = byOrg.get(r.organizationId) ?? [];
    list.push(r);
    byOrg.set(r.organizationId, list);
  }

  const baseUrl = process.env.APP_BASE_URL
    ?? (process.env.PUBLIC_BASE_URL
      ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`);

  for (const [organizationId, orgRows] of byOrg) {
    const [org] = await db
      .select({
        name: organizationsTable.name,
        logoUrl: organizationsTable.logoUrl,
        primaryColor: organizationsTable.primaryColor,
      })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId));
    if (!org) continue;

    // Mirrors the recipient lookup the marketing-image auto-clear
    // flow uses: org_admin via app_users.role OR via org_memberships,
    // dedup by user id.
    const directAdmins = await db
      .select({
        userId: appUsersTable.id,
        email: appUsersTable.email,
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
      })
      .from(appUsersTable)
      .where(and(
        eq(appUsersTable.organizationId, organizationId),
        eq(appUsersTable.role, "org_admin"),
      ));
    const memberAdmins = await db
      .select({
        userId: appUsersTable.id,
        email: appUsersTable.email,
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
      })
      .from(orgMembershipsTable)
      .innerJoin(appUsersTable, eq(orgMembershipsTable.userId, appUsersTable.id))
      .where(and(
        eq(orgMembershipsTable.organizationId, organizationId),
        eq(orgMembershipsTable.role, "org_admin"),
      ));

    const seen = new Set<number>();
    const recipients = [...directAdmins, ...memberAdmins].filter(a => {
      if (seen.has(a.userId)) return false;
      seen.add(a.userId);
      return true;
    });

    const branding = {
      orgName: org.name,
      logoUrl: org.logoUrl ?? undefined,
      primaryColor: org.primaryColor ?? undefined,
      orgId: organizationId,
    };

    for (const rec of recipients) {
      if (!rec.email) continue;
      try {
        await sendLegacyVideoUnverifiableDigestEmail({
          to: rec.email,
          staffName: rec.displayName ?? rec.username ?? "Admin",
          baseUrl,
          rows: orgRows.map(r => ({
            mediaId: r.mediaId,
            objectPath: r.objectPath,
            uploaderName: r.uploaderName,
            reason: r.reason,
          })),
          branding,
        });
      } catch (err) {
        logger.warn(
          { err, organizationId, recipient: rec.email, rowCount: orgRows.length },
          "[cron] legacy-video unverifiable digest email failed",
        );
      }
    }
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * Task #1467 — Periodic refresh of cached marketing logos / favicons.
 *
 * Task #1250 snapshots admin-supplied external `logoImageUrl` /
 * `faviconUrl` bytes into our own object storage at save time. The
 * persisted column then points at the cached internal /api/storage/...
 * URL so the public mini-site never has to hit the third-party host
 * once the snapshot is in place. But if the source image at the
 * original URL changes (a club rebrands, a CDN rotates the file), the
 * cached copy goes stale forever.
 *
 * This sweep re-downloads each row's `logoSourceUrl` / `faviconSourceUrl`
 * (the original external URL we now persist alongside the cached one)
 * and:
 *   - skips rows refreshed within the last week (per-row backoff so
 *     the sweep can be polled more often without hammering hosts),
 *   - calls `rehostExternalImageBytes` with the freshly downloaded
 *     bytes — its content-hashed key naturally collapses unchanged
 *     bytes onto the existing object, and produces a new
 *     `/api/storage/...` URL only when the bytes actually differ,
 *   - rotates `logoImageUrl` / `faviconUrl` to the new cached URL
 *     when it differs from the current one and bumps `cacheVersion`
 *     so visitors stop using the stale CDN copy,
 *   - on failure (host down, non-2xx, content-type now wrong, the
 *     bytes are truncated, …) PRESERVES the existing cached copy,
 *     stamps `*SourceLastRefreshError`, and logs a warning so
 *     on-call sees the staleness without the public page breaking.
 *
 * Internal /objects/... paths and direct uploads have `*SourceUrl =
 * NULL` and are skipped entirely — there is no upstream to compare
 * against.
 * ─────────────────────────────────────────────────────────────────── */

/** Sweep cadence — every 24 h. Per-row backoff is enforced separately. */
const MARKETING_IMAGE_REFRESH_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Per-source backoff: refresh the same source URL at most once a week. */
const MARKETING_IMAGE_REFRESH_PER_ROW_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Task #2259 — Notify org admins after this many consecutive failed
 * refresh attempts against the same source URL. At the production
 * weekly per-source backoff this works out to roughly three weeks of
 * consistent upstream failure before we email — long enough that a
 * one-off blip doesn't page anyone, short enough that a permanently
 * dead host doesn't sit silently while the cached copy goes stale.
 * Exported so tests can reference the same value.
 */
export const MARKETING_IMAGE_REFRESH_NOTIFY_FAILURE_THRESHOLD = 3;

/** Test-only override for the per-row refresh backoff window. */
let marketingImageRefreshPerRowMs = MARKETING_IMAGE_REFRESH_PER_ROW_INTERVAL_MS;
/** Test-only override for the notify threshold. */
let marketingImageRefreshNotifyThreshold = MARKETING_IMAGE_REFRESH_NOTIFY_FAILURE_THRESHOLD;

/**
 * Test-only hook to tighten the per-row backoff and notify threshold
 * so a test can drive a full sweep — including the notification flow —
 * in a single call. Pass `null` to restore production.
 */
export function _setMarketingImageRefreshTuningForTest(
  opts: { perRowMs?: number; notifyThreshold?: number } | null,
): void {
  if (opts === null) {
    marketingImageRefreshPerRowMs = MARKETING_IMAGE_REFRESH_PER_ROW_INTERVAL_MS;
    marketingImageRefreshNotifyThreshold = MARKETING_IMAGE_REFRESH_NOTIFY_FAILURE_THRESHOLD;
    return;
  }
  if (opts.perRowMs !== undefined) marketingImageRefreshPerRowMs = opts.perRowMs;
  if (opts.notifyThreshold !== undefined) marketingImageRefreshNotifyThreshold = opts.notifyThreshold;
}

/**
 * Task #2259 — Notify org admins (and emit a push) that the periodic
 * refresh job has failed to re-download a marketing-site source URL
 * for N consecutive runs. Mirrors the recipient lookup that
 * `notifyOrgAdminsMarketingImageCleared` uses (Task #1249) so the two
 * marketing-image admin alerts surface to the same audience. Unlike
 * the auto-clear flow this one preserves the cached copy — the public
 * mini-site keeps rendering — but the admin needs to either fix the
 * upstream source or paste a fresh URL or the cache will keep going
 * stale forever.
 */
async function notifyOrgAdminsMarketingImageRefreshFailing(opts: {
  organizationId: number;
  imageKind: "logo" | "favicon";
  sourceUrl: string;
  consecutiveFailures: number;
  lastError: string | null;
}): Promise<{ pushRecipients: number; emailRecipients: number }> {
  const { organizationId, imageKind, sourceUrl, consecutiveFailures, lastError } = opts;

  const [org] = await db
    .select({
      name: organizationsTable.name,
      logoUrl: organizationsTable.logoUrl,
      primaryColor: organizationsTable.primaryColor,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, organizationId));
  if (!org) return { pushRecipients: 0, emailRecipients: 0 };

  const directAdmins = await db
    .select({
      userId: appUsersTable.id,
      email: appUsersTable.email,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
    })
    .from(appUsersTable)
    .where(and(
      eq(appUsersTable.organizationId, organizationId),
      eq(appUsersTable.role, "org_admin"),
    ));
  const memberAdmins = await db
    .select({
      userId: appUsersTable.id,
      email: appUsersTable.email,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
    })
    .from(orgMembershipsTable)
    .innerJoin(appUsersTable, eq(orgMembershipsTable.userId, appUsersTable.id))
    .where(and(
      eq(orgMembershipsTable.organizationId, organizationId),
      eq(orgMembershipsTable.role, "org_admin"),
    ));

  const seen = new Set<number>();
  const recipients = [...directAdmins, ...memberAdmins].filter(a => {
    if (seen.has(a.userId)) return false;
    seen.add(a.userId);
    return true;
  });

  let host: string;
  try {
    host = new URL(sourceUrl).host;
  } catch {
    host = sourceUrl;
  }

  const userIds = recipients.map(r => r.userId);
  let pushRecipients = 0;
  if (userIds.length > 0) {
    try {
      const kindLabel = imageKind === "logo" ? "logo" : "favicon";
      await sendTransactionalPush(
        userIds,
        `Marketing ${kindLabel} cache going stale`,
        `${host} has failed ${consecutiveFailures} background refreshes. Open the marketing-site editor to paste a fresh URL.`,
        {
          type: "marketing_image_refresh_failing",
          organizationId,
          imageKind,
          route: "/marketing-site",
        },
      );
      pushRecipients = userIds.length;
    } catch (err) {
      logger.warn(
        { err, organizationId, imageKind },
        "[cron] marketing-image refresh-failing admin push failed",
      );
    }
  }

  const baseUrl = process.env.APP_BASE_URL
    ?? (process.env.PUBLIC_BASE_URL
      ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`);
  const branding = {
    orgName: org.name,
    logoUrl: org.logoUrl ?? undefined,
    primaryColor: org.primaryColor ?? undefined,
    orgId: organizationId,
  };

  let emailRecipients = 0;
  for (const rec of recipients) {
    if (!rec.email) continue;
    try {
      await sendMarketingImageRefreshFailingEmail({
        to: rec.email,
        staffName: rec.displayName ?? rec.username ?? "Admin",
        baseUrl,
        imageKind,
        sourceUrl,
        consecutiveFailures,
        lastError,
        branding,
      });
      emailRecipients += 1;
    } catch (err) {
      logger.warn(
        { err, organizationId, imageKind, recipient: rec.email },
        "[cron] marketing-image refresh-failing admin email failed",
      );
    }
  }

  return { pushRecipients, emailRecipients };
}

/**
 * Run one pass of the marketing-image cache refresh.
 *
 * Returns counters useful for logging + tests:
 *   - rowsConsidered: source URLs whose per-row backoff had elapsed.
 *   - refreshed: source URLs whose download succeeded.
 *   - rotated: source URLs whose freshly cached URL differed from the
 *     persisted one (i.e. the upstream image actually changed) and
 *     therefore bumped cacheVersion and the public URL.
 *   - failed: source URLs whose download failed (cache preserved).
 *   - notified: source URLs whose consecutive-refresh-failure counter
 *     just crossed the Task #2259 notify threshold and triggered an
 *     org-admin email + push on this pass.
 */
export async function refreshCachedMarketingImages(): Promise<{
  rowsConsidered: number;
  refreshed: number;
  rotated: number;
  failed: number;
  notified: number;
}> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - marketingImageRefreshPerRowMs);

  // Cheap pre-filter — only pull rows that have at least one source
  // URL populated whose lastRefreshedAt is null (never refreshed) or
  // older than the per-row backoff. Rows without a source URL (direct
  // uploads, internal /objects paths, legacy rows) are skipped at the
  // SQL level so we don't pull the whole table.
  const dueRows = await db
    .select({
      id: clubMarketingSitesTable.id,
      organizationId: clubMarketingSitesTable.organizationId,
      logoImageUrl: clubMarketingSitesTable.logoImageUrl,
      logoSourceUrl: clubMarketingSitesTable.logoSourceUrl,
      logoSourceLastRefreshedAt: clubMarketingSitesTable.logoSourceLastRefreshedAt,
      logoSourceConsecutiveRefreshFailures: clubMarketingSitesTable.logoSourceConsecutiveRefreshFailures,
      faviconUrl: clubMarketingSitesTable.faviconUrl,
      faviconSourceUrl: clubMarketingSitesTable.faviconSourceUrl,
      faviconSourceLastRefreshedAt: clubMarketingSitesTable.faviconSourceLastRefreshedAt,
      faviconSourceConsecutiveRefreshFailures: clubMarketingSitesTable.faviconSourceConsecutiveRefreshFailures,
      cacheVersion: clubMarketingSitesTable.cacheVersion,
    })
    .from(clubMarketingSitesTable)
    .where(or(
      and(
        isNotNull(clubMarketingSitesTable.logoSourceUrl),
        or(
          isNull(clubMarketingSitesTable.logoSourceLastRefreshedAt),
          lt(clubMarketingSitesTable.logoSourceLastRefreshedAt, cutoff),
        ),
      ),
      and(
        isNotNull(clubMarketingSitesTable.faviconSourceUrl),
        or(
          isNull(clubMarketingSitesTable.faviconSourceLastRefreshedAt),
          lt(clubMarketingSitesTable.faviconSourceLastRefreshedAt, cutoff),
        ),
      ),
    ));

  let rowsConsidered = 0;
  let refreshed = 0;
  let rotated = 0;
  let failed = 0;
  let notified = 0;

  /**
   * Task #2259 — Bump the per-source consecutive-refresh-failure counter
   * and (when the count just crossed the notify threshold) email + push
   * the org admins exactly once. Returns the new counter so the caller
   * can fold it into the same UPDATE that stamps `*LastRefreshError`.
   */
  const recordRefreshFailure = async (
    row: typeof dueRows[number],
    kind: "logo" | "favicon",
    sourceUrl: string,
    error: string | null,
  ): Promise<number> => {
    const previous = (kind === "logo"
      ? row.logoSourceConsecutiveRefreshFailures
      : row.faviconSourceConsecutiveRefreshFailures) ?? 0;
    const next = previous + 1;
    if (kind === "logo") {
      row.logoSourceConsecutiveRefreshFailures = next;
    } else {
      row.faviconSourceConsecutiveRefreshFailures = next;
    }
    // De-dup: only fire on the tick that crosses the threshold.
    // Subsequent failures keep the counter climbing for observability
    // but don't re-notify.
    if (previous < marketingImageRefreshNotifyThreshold
      && next >= marketingImageRefreshNotifyThreshold) {
      const notify = await notifyOrgAdminsMarketingImageRefreshFailing({
        organizationId: row.organizationId,
        imageKind: kind,
        sourceUrl,
        consecutiveFailures: next,
        lastError: error,
      });
      notified += 1;
      logger.info(
        {
          organizationId: row.organizationId,
          kind,
          sourceUrl,
          consecutiveFailures: next,
          threshold: marketingImageRefreshNotifyThreshold,
          error,
          pushRecipients: notify.pushRecipients,
          emailRecipients: notify.emailRecipients,
        },
        "[cron] marketing-image refresh notified admins after consecutive failures",
      );
    }
    return next;
  };

  for (const row of dueRows) {
    for (const kind of ["logo", "favicon"] as const) {
      const sourceUrl = kind === "logo" ? row.logoSourceUrl : row.faviconSourceUrl;
      const lastRefreshedAt = kind === "logo"
        ? row.logoSourceLastRefreshedAt
        : row.faviconSourceLastRefreshedAt;
      const currentCachedUrl = kind === "logo" ? row.logoImageUrl : row.faviconUrl;

      if (!sourceUrl) continue;
      if (lastRefreshedAt && lastRefreshedAt >= cutoff) continue;
      rowsConsidered += 1;

      let result;
      try {
        // Task #2248 — Pass the same 1 MB cap that save-time validation
        // (Task #1468) and the recheck cron (Task #1800) enforce, so
        // the refresh sweep can't silently rehost a 5 MB logo just
        // because the verifier's default cap is 10 MB. Without this,
        // a third-party host that swaps its file for an over-cap
        // image would have its bytes happily written to our object
        // storage on the next refresh tick, eating quota and bypassing
        // the marketing-logo size policy.
        result = await verifyExternalImageUrl(sourceUrl, {
          maxBytes: MARKETING_LOGO_FAVICON_MAX_BYTES,
        });
      } catch (err) {
        // Treat thrown errors as transient — record the message but
        // preserve the cached copy. The verifier promises to resolve
        // with `{ok:false}` for real failure modes; a thrown
        // exception means our own code blew up. Task #2259 still
        // counts this against the consecutive-failure counter so a
        // permanently broken outbound network can't sit silently.
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { err, organizationId: row.organizationId, kind, sourceUrl },
          "[cron] marketing-image refresh verifier threw, will retry next pass",
        );
        const stampedError = `verifier threw: ${msg.slice(0, 240)}`;
        const newFailures = await recordRefreshFailure(row, kind, sourceUrl, stampedError);
        const patch: Record<string, unknown> = { updatedAt: now };
        patch[kind === "logo" ? "logoSourceLastRefreshedAt" : "faviconSourceLastRefreshedAt"] = now;
        patch[kind === "logo" ? "logoSourceLastRefreshError" : "faviconSourceLastRefreshError"] = stampedError;
        patch[kind === "logo"
          ? "logoSourceConsecutiveRefreshFailures"
          : "faviconSourceConsecutiveRefreshFailures"] = newFailures;
        await db.update(clubMarketingSitesTable)
          .set(patch)
          .where(eq(clubMarketingSitesTable.id, row.id));
        failed += 1;
        continue;
      }

      if (!result.ok) {
        // Source unreachable / non-2xx / wrong content-type. Preserve
        // the existing cached copy (the public mini-site keeps
        // working) and stamp the error so the editor can surface it
        // and on-call can see the staleness.
        logger.warn(
          {
            organizationId: row.organizationId,
            kind,
            sourceUrl,
            error: result.error,
          },
          "[cron] marketing-image refresh source unreachable, preserving cached copy",
        );
        const newFailures = await recordRefreshFailure(row, kind, sourceUrl, result.error);
        const patch: Record<string, unknown> = { updatedAt: now };
        patch[kind === "logo" ? "logoSourceLastRefreshedAt" : "faviconSourceLastRefreshedAt"] = now;
        patch[kind === "logo" ? "logoSourceLastRefreshError" : "faviconSourceLastRefreshError"] = result.error;
        patch[kind === "logo"
          ? "logoSourceConsecutiveRefreshFailures"
          : "faviconSourceConsecutiveRefreshFailures"] = newFailures;
        await db.update(clubMarketingSitesTable)
          .set(patch)
          .where(eq(clubMarketingSitesTable.id, row.id));
        failed += 1;
        continue;
      }

      // The source returned ok but a test-style stub may not include
      // bytes (existing verifier override hook contract). Without
      // bytes we can't rotate the cache, so just stamp progress and
      // move on. Counts as a successful refresh for the failure-streak
      // counter (Task #2259) so a recovered source re-arms the alert.
      if (!result.buffer || !result.contentType) {
        const patch: Record<string, unknown> = { updatedAt: now };
        patch[kind === "logo" ? "logoSourceLastRefreshedAt" : "faviconSourceLastRefreshedAt"] = now;
        patch[kind === "logo" ? "logoSourceLastRefreshError" : "faviconSourceLastRefreshError"] = null;
        patch[kind === "logo"
          ? "logoSourceConsecutiveRefreshFailures"
          : "faviconSourceConsecutiveRefreshFailures"] = 0;
        if (kind === "logo") row.logoSourceConsecutiveRefreshFailures = 0;
        else row.faviconSourceConsecutiveRefreshFailures = 0;
        await db.update(clubMarketingSitesTable)
          .set(patch)
          .where(eq(clubMarketingSitesTable.id, row.id));
        refreshed += 1;
        continue;
      }

      const cached = await rehostExternalImageBytes(
        result.buffer,
        result.contentType.toLowerCase(),
        { orgId: row.organizationId, kind },
      );
      if (!cached.ok) {
        // Storage write failed. Same posture as a failed download —
        // preserve the cached copy, stamp the error, log, and count
        // toward the Task #2259 failure streak (a persistently broken
        // storage write leaves the cache just as stale as a dead host).
        logger.warn(
          {
            organizationId: row.organizationId,
            kind,
            sourceUrl,
            error: cached.error,
          },
          "[cron] marketing-image refresh storage write failed, preserving cached copy",
        );
        const newFailures = await recordRefreshFailure(row, kind, sourceUrl, cached.error);
        const patch: Record<string, unknown> = { updatedAt: now };
        patch[kind === "logo" ? "logoSourceLastRefreshedAt" : "faviconSourceLastRefreshedAt"] = now;
        patch[kind === "logo" ? "logoSourceLastRefreshError" : "faviconSourceLastRefreshError"] = cached.error;
        patch[kind === "logo"
          ? "logoSourceConsecutiveRefreshFailures"
          : "faviconSourceConsecutiveRefreshFailures"] = newFailures;
        await db.update(clubMarketingSitesTable)
          .set(patch)
          .where(eq(clubMarketingSitesTable.id, row.id));
        failed += 1;
        continue;
      }

      refreshed += 1;
      // A successful refresh re-arms the Task #2259 failure-streak
      // counter for the next streak.
      const patch: Record<string, unknown> = { updatedAt: now };
      patch[kind === "logo" ? "logoSourceLastRefreshedAt" : "faviconSourceLastRefreshedAt"] = now;
      patch[kind === "logo" ? "logoSourceLastRefreshError" : "faviconSourceLastRefreshError"] = null;
      patch[kind === "logo"
        ? "logoSourceConsecutiveRefreshFailures"
        : "faviconSourceConsecutiveRefreshFailures"] = 0;
      if (kind === "logo") row.logoSourceConsecutiveRefreshFailures = 0;
      else row.faviconSourceConsecutiveRefreshFailures = 0;

      // Rotate the public URL only when the bytes actually changed —
      // the content-hashed object key collapses unchanged bytes onto
      // the existing object so `cached.url` is identical when nothing
      // has rotated upstream. This keeps the public mini-site stable
      // (no needless cacheVersion bumps that would spam every CDN
      // edge with a re-fetch on each refresh sweep).
      if (cached.url !== currentCachedUrl) {
        patch[kind === "logo" ? "logoImageUrl" : "faviconUrl"] = cached.url;
        patch.cacheVersion = row.cacheVersion + 1;
        rotated += 1;
        logger.info(
          {
            organizationId: row.organizationId,
            kind,
            sourceUrl,
            previousCachedUrl: currentCachedUrl,
            newCachedUrl: cached.url,
          },
          "[cron] marketing-image refresh rotated cached copy after upstream change",
        );
        // Reflect the bumped cacheVersion in the local copy so a
        // logo+favicon double-rotate keeps monotonically increasing.
        row.cacheVersion += 1;
      }
      await db.update(clubMarketingSitesTable)
        .set(patch)
        .where(eq(clubMarketingSitesTable.id, row.id));
    }
  }

  if (rowsConsidered > 0) {
    logger.info(
      { rowsConsidered, refreshed, rotated, failed, notified },
      "[cron] marketing-image refresh pass complete",
    );
  }

  return { rowsConsidered, refreshed, rotated, failed, notified };
}

// Task #1005 — Daily notification digest delivery cadence.
const NOTIFICATION_DIGEST_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Task #1612 — Daily round-weather-cache refresh wrapper.
 * Pipes the structured logger into the shared backfill loop and
 * surfaces a single summary line ("filled vs. still pending") per
 * pass. Errors are caught here so the surrounding cron tick never
 * crashes the host process.
 */
async function runRoundWeatherCacheBackfillCron() {
  // Task #2002 — record each pass's outcome (completed or errored) into
  // the rolling history buffer used by the streak-based ops alert, then
  // ask the alert job whether on-call needs paging. Recording happens
  // inside an inner try/catch so a transient DB / mailer hiccup in the
  // alert path can never re-crash the cron tick itself.
  const startedAt = new Date();
  try {
    const result = await runRoundWeatherCacheBackfill({
      days: 30,
      log: (msg) => logger.info(msg),
    });
    logger.info(
      {
        filled: result.updated,
        stillPending: result.nullObservation,
        skippedAlreadyCached: result.skippedAlreadyCached,
        skippedNoCoords: result.skippedNoCoords,
        failed: result.failed,
        total: result.total,
      },
      "[cron] round-weather-cache backfill complete",
    );
    try {
      recordRoundWeatherBackfillPass({
        kind: "completed",
        at: new Date(),
        filled: result.updated,
        stillPending: result.nullObservation,
        failed: result.failed,
        total: result.total,
      });
      await runRoundWeatherBackfillOpsAlertJob();
    } catch (alertErr: unknown) {
      logger.warn(
        { err: alertErr },
        "[cron] round-weather-cache ops alert evaluation failed",
      );
    }
  } catch (err: unknown) {
    logger.warn({ err }, "[cron] round-weather-cache backfill failed");
    try {
      recordRoundWeatherBackfillPass({
        kind: "errored",
        at: startedAt,
        message: err instanceof Error ? err.message : String(err),
      });
      await runRoundWeatherBackfillOpsAlertJob();
    } catch (alertErr: unknown) {
      logger.warn(
        { err: alertErr },
        "[cron] round-weather-cache ops alert evaluation failed (after backfill error)",
      );
    }
  }
}

export function startCronJobs() {
  // Notification digest — once per day. Runs immediately on boot so a
  // restart inside the daily window still drains the queue.
  import("./notificationDigest.js").then(({ runNotificationDigest }) => {
    runNotificationDigest().catch((err: unknown) =>
      logger.warn({ err }, "[cron] initial notification digest delivery failed"),
    );
    setInterval(() => {
      runNotificationDigest().catch((err: unknown) =>
        logger.warn({ err }, "[cron] notification digest delivery failed"),
      );
    }, NOTIFICATION_DIGEST_POLL_INTERVAL_MS);
  }).catch((err) => logger.warn({ err }, "[cron] failed to import notificationDigest module"));

  // Year in Golf launch & quarterly recap broadcasts (hourly poll, idempotent per launch window)
  startYearInGolfCron();

  // Run immediately on startup (in case server was down during a window)
  send24hReminders().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial 24h reminder check failed"),
  );
  send1hReminders().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial 1h reminder check failed"),
  );
  sendPaymentDayReminders().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial payment reminder check failed"),
  );
  expireGracePeriods().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial grace period expiry check failed"),
  );

  // Poll every 30 minutes for 24h reminders
  setInterval(() => {
    send24hReminders().catch((err: unknown) =>
      logger.warn({ err }, "[cron] 24h reminder poll failed"),
    );
  }, REMINDER_24H_POLL_INTERVAL_MS);

  // Poll every 10 minutes for 1h reminders
  setInterval(() => {
    send1hReminders().catch((err: unknown) =>
      logger.warn({ err }, "[cron] 1h reminder poll failed"),
    );
  }, REMINDER_1H_POLL_INTERVAL_MS);

  // Poll every 24 hours for N-days-before payment reminders
  setInterval(() => {
    sendPaymentDayReminders().catch((err: unknown) =>
      logger.warn({ err }, "[cron] payment day reminder poll failed"),
    );
  }, PAYMENT_REMINDER_POLL_INTERVAL_MS);

  // Poll every 24 hours for grace period expiry
  setInterval(() => {
    expireGracePeriods().catch((err: unknown) =>
      logger.warn({ err }, "[cron] grace period expiry poll failed"),
    );
  }, GRACE_PERIOD_POLL_INTERVAL_MS);

  // Poll every 6 hours for shop order fulfillment status (Printful + Printify)
  setInterval(() => {
    pollFulfillmentOrderStatus().catch((err: unknown) =>
      logger.warn({ err }, "[cron] fulfillment status poll failed"),
    );
  }, FULFILLMENT_POLL_INTERVAL_MS);

  // Tee booking reminders — 24h every 30 min, 2h every 10 min
  sendTeeBooking24hReminders().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial tee 24h reminder check failed"),
  );
  sendTeeBooking2hReminders().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial tee 2h reminder check failed"),
  );
  setInterval(() => {
    sendTeeBooking24hReminders().catch((err: unknown) =>
      logger.warn({ err }, "[cron] tee 24h reminder poll failed"),
    );
  }, REMINDER_24H_POLL_INTERVAL_MS);
  setInterval(() => {
    sendTeeBooking2hReminders().catch((err: unknown) =>
      logger.warn({ err }, "[cron] tee 2h reminder poll failed"),
    );
  }, REMINDER_1H_POLL_INTERVAL_MS);

  // Expire stale pending tee bookings every 5 minutes
  expireStalePendingTeeBookings().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial stale tee booking expiry check failed"),
  );
  setInterval(() => {
    expireStalePendingTeeBookings().catch((err: unknown) =>
      logger.warn({ err }, "[cron] stale tee booking expiry poll failed"),
    );
  }, 5 * 60 * 1000);

  // Run locker renewal reminders once on startup, then daily
  sendLockerRenewalReminders().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial locker renewal reminder check failed"),
  );
  setInterval(() => {
    sendLockerRenewalReminders().catch((err: unknown) =>
      logger.warn({ err }, "[cron] locker renewal reminder poll failed"),
    );
  }, 24 * 60 * 60 * 1000);

  // Task #2011 — auto-send post-event survey reminders. Runs once on
  // startup so a deploy inside the daily window doesn't push reminders
  // to tomorrow, then daily. Idempotent via `reminderSentAt`: surveys
  // already nudged by an admin (or a previous cron tick) are skipped.
  sendScheduledSurveyReminders().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial post-event survey reminder check failed"),
  );
  setInterval(() => {
    sendScheduledSurveyReminders().catch((err: unknown) =>
      logger.warn({ err }, "[cron] post-event survey reminder poll failed"),
    );
  }, POST_EVENT_SURVEY_REMINDER_POLL_INTERVAL_MS);

  // Mark general play rounds as unverified if marker has not responded in 48h
  expireUnmarkedGeneralPlayRounds().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial general-play unverified check failed"),
  );
  setInterval(() => {
    expireUnmarkedGeneralPlayRounds().catch((err: unknown) =>
      logger.warn({ err }, "[cron] general-play unverified poll failed"),
    );
  }, 60 * 60 * 1000);

  // Analytics scheduled report delivery — check every hour
  setInterval(() => {
    import("../routes/analytics").then(({ runScheduledReports }) => {
      runScheduledReports().catch((err: unknown) =>
        logger.warn({ err }, "[cron] scheduled report delivery failed"),
      );
    }).catch(() => {});
  }, 60 * 60 * 1000);

  // Escalate overdue scoring submissions (deadline-passed scorecards) every 10 minutes
  escalateOverdueScoringSubmissions().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial scoring deadline escalation check failed"),
  );
  setInterval(() => {
    escalateOverdueScoringSubmissions().catch((err: unknown) =>
      logger.warn({ err }, "[cron] scoring deadline escalation poll failed"),
    );
  }, 10 * 60 * 1000);

  // Vendor renewal alerts — run daily (check all orgs)
  dispatchVendorRenewalAlerts().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial vendor renewal alert check failed"),
  );
  setInterval(() => {
    dispatchVendorRenewalAlerts().catch((err: unknown) =>
      logger.warn({ err }, "[cron] vendor renewal alert poll failed"),
    );
  }, 24 * 60 * 60 * 1000);

  // Privacy / data-protection request deadline reminders — daily.
  // Approaching (next 7 days) + overdue (dueBy in the past) for open requests.
  sendDataRequestDeadlineReminders().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial privacy-request deadline check failed"),
  );
  setInterval(() => {
    sendDataRequestDeadlineReminders().catch((err: unknown) =>
      logger.warn({ err }, "[cron] privacy-request deadline poll failed"),
    );
  }, 24 * 60 * 60 * 1000);

  // Daily controller digest of stuck erasure cleanups (Task #1078).
  // Polled every 24h (with a boot-time fire so a deploy inside the window
  // doesn't push the digest to the next day). Per-org `erasureStorageDigestLastSentOn`
  // dedup makes the boot-time fire safe.
  sendErasureStorageFailuresDigest().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial erasure-storage digest failed"),
  );
  setInterval(() => {
    sendErasureStorageFailuresDigest().catch((err: unknown) =>
      logger.warn({ err }, "[cron] erasure-storage digest poll failed"),
    );
  }, 24 * 60 * 60 * 1000);

  // Monthly per-org "member notification preferences" controller digest
  // (Task #1489). Polled daily — the per-org `memberPrefsDigestLastSentOn`
  // watermark (UTC `YYYY-MM`) makes the boot-time fire and the daily
  // poll safe so the digest still goes out exactly once per calendar
  // month, even on installs that re-deploy the API multiple times in a
  // month.
  sendMemberPrefsDigest().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial member-prefs digest failed"),
  );
  setInterval(() => {
    sendMemberPrefsDigest().catch((err: unknown) =>
      logger.warn({ err }, "[cron] member-prefs digest poll failed"),
    );
  }, 24 * 60 * 60 * 1000);

  // Daily admin digest of unresolved bounced levy reminders (Task #242).
  sendBouncedLevyRemindersDigest().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial bounced-levy digest failed"),
  );
  setInterval(() => {
    sendBouncedLevyRemindersDigest().catch((err: unknown) =>
      logger.warn({ err }, "[cron] bounced-levy digest poll failed"),
    );
  }, BOUNCED_LEVY_DIGEST_INTERVAL_MS);

  // Privacy notice push/SMS retries — every 15 minutes (Task 191).
  retryFailedDataRequestPushSms().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial privacy-request push/SMS retry failed"),
  );
  setInterval(() => {
    retryFailedDataRequestPushSms().catch((err: unknown) =>
      logger.warn({ err }, "[cron] privacy-request push/SMS retry poll failed"),
    );
  }, DATA_REQUEST_PUSH_SMS_RETRY_INTERVAL_MS);

  // Levy-receipt push/SMS retries — every 15 minutes (Task #247).
  retryFailedLevyReceiptPushSms().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial levy-receipt push/SMS retry failed"),
  );
  setInterval(() => {
    retryFailedLevyReceiptPushSms().catch((err: unknown) =>
      logger.warn({ err }, "[cron] levy-receipt push/SMS retry poll failed"),
    );
  }, LEVY_RECEIPT_PUSH_SMS_RETRY_INTERVAL_MS);

  // Side-game receipt email/push retries — every 5 minutes (Task #961).
  retryFailedSideGameReceiptEmailPush().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial side-game receipt email/push retry failed"),
  );
  setInterval(() => {
    retryFailedSideGameReceiptEmailPush().catch((err: unknown) =>
      logger.warn({ err }, "[cron] side-game receipt email/push retry poll failed"),
    );
  }, SIDE_GAME_RECEIPT_RETRY_INTERVAL_MS);

  // Coach payout-paid push/SMS/email retries — every 15 minutes (Task
  // #967, email channel added by Task #1847).
  retryFailedCoachPayoutPushSms().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial coach-payout push/SMS/email retry failed"),
  );
  setInterval(() => {
    retryFailedCoachPayoutPushSms().catch((err: unknown) =>
      logger.warn({ err }, "[cron] coach-payout push/SMS/email retry poll failed"),
    );
  }, COACH_PAYOUT_PUSH_SMS_RETRY_INTERVAL_MS);

  // Manual-entry alert email retries — every 5 minutes (Task #1847).
  // Per-recipient row, mirrors the wallet-withdrawal email retry cadence.
  retryFailedManualEntryEmail().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial manual-entry email retry failed"),
  );
  setInterval(() => {
    retryFailedManualEntryEmail().catch((err: unknown) =>
      logger.warn({ err }, "[cron] manual-entry email retry poll failed"),
    );
  }, MANUAL_ENTRY_EMAIL_RETRY_INTERVAL_MS);

  // Task #1130 — daily ops alert when notification retry exhaustions
  // (coach-payout + levy-receipt push/SMS) cross the configured threshold
  // in the lookback window. Catches systemic outages (FCM key revoked,
  // Twilio suspended, SMS_PROVIDER unset) that would otherwise silently
  // strand notifications.
  runNotifyExhaustionOpsAlertJob().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial notify-exhaustion ops alert failed"),
  );
  setInterval(() => {
    runNotifyExhaustionOpsAlertJob().catch((err: unknown) =>
      logger.warn({ err }, "[cron] notify-exhaustion ops alert poll failed"),
    );
  }, 24 * 60 * 60 * 1000);

  // Task #1387 — hourly auto-page on-call when manual-entry alerts stop
  // reaching anyone. Reuses `getManualEntryAlertHealthSummary()` (same
  // data the super-admin dashboard surfaces) and pages super-admins +
  // OPS_ALERT_EMAILS when the 7d delivery rate drops below the configured
  // threshold or when N consecutive alerts all reach zero recipients.
  // Cooldown gating in the job itself prevents repeat pages while an
  // outage persists.
  runManualEntryAlertHealthOpsAlertJob().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial manual-entry alert health ops alert failed"),
  );
  setInterval(() => {
    runManualEntryAlertHealthOpsAlertJob().catch((err: unknown) =>
      logger.warn({ err }, "[cron] manual-entry alert health ops alert poll failed"),
    );
  }, 60 * 60 * 1000);

  // Wallet withdrawal email/push retries — every 5 minutes (Task #1108).
  retryFailedWalletWithdrawalEmailPush().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial wallet-withdrawal email/push retry failed"),
  );
  setInterval(() => {
    retryFailedWalletWithdrawalEmailPush().catch((err: unknown) =>
      logger.warn({ err }, "[cron] wallet-withdrawal email/push retry poll failed"),
    );
  }, WALLET_WITHDRAWAL_NOTIFY_RETRY_INTERVAL_MS);

  // Wallet top-up auto-refund email/push retries — every 5 minutes (Task #1280).
  retryFailedWalletTopupRefundEmailPush().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial wallet-topup-refund email/push retry failed"),
  );
  setInterval(() => {
    retryFailedWalletTopupRefundEmailPush().catch((err: unknown) =>
      logger.warn({ err }, "[cron] wallet-topup-refund email/push retry poll failed"),
    );
  }, WALLET_TOPUP_REFUND_NOTIFY_RETRY_INTERVAL_MS);

  // Wallet top-up refund SMS/WhatsApp retry exhaustion ops alert — hourly (Task #1863).
  // Counts notify rows whose SMS / WhatsApp 5-attempt budget burned out
  // in the last hour, grouped by organization, and pages on-call when
  // any org crosses the configured threshold. Sample provider error
  // strings included so on-call can tell a Twilio outage apart from a
  // misconfigured `SMS_PROVIDER` without having to query the DB.
  runWalletTopupRefundRetryExhaustionOpsAlertJob().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial wallet-topup-refund retry exhaustion ops alert failed"),
  );
  setInterval(() => {
    runWalletTopupRefundRetryExhaustionOpsAlertJob().catch((err: unknown) =>
      logger.warn({ err }, "[cron] wallet-topup-refund retry exhaustion ops alert poll failed"),
    );
  }, 60 * 60 * 1000);

  // Coach payout-account change email/push retries — every 5 minutes (Task #1280).
  retryFailedCoachPayoutAccountChangeEmailPush().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial coach-payout-account-change email/push retry failed"),
  );
  setInterval(() => {
    retryFailedCoachPayoutAccountChangeEmailPush().catch((err: unknown) =>
      logger.warn({ err }, "[cron] coach-payout-account-change email/push retry poll failed"),
    );
  }, COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_RETRY_INTERVAL_MS);

  // Admin comm-pref override email retries — every 5 minutes (Task #1845).
  retryFailedAdminCommPrefOverrideEmail().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial admin-comm-pref-override email retry failed"),
  );
  setInterval(() => {
    retryFailedAdminCommPrefOverrideEmail().catch((err: unknown) =>
      logger.warn({ err }, "[cron] admin-comm-pref-override email retry poll failed"),
    );
  }, ADMIN_COMM_PREF_OVERRIDE_NOTIFY_RETRY_INTERVAL_MS);

  // Daily admin digest of exhausted wallet/coach-payout notify retries
  // (Task #1507). Runs at startup so a deploy/restart inside the daily
  // window doesn't push the digest to tomorrow.
  sendNotifyExhaustionAdminDigest().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial notify-exhaustion-admin-digest failed"),
  );
  setInterval(() => {
    sendNotifyExhaustionAdminDigest().catch((err: unknown) =>
      logger.warn({ err }, "[cron] notify-exhaustion-admin-digest poll failed"),
    );
  }, NOTIFY_EXHAUSTION_ADMIN_DIGEST_INTERVAL_MS);

  // Auto-generate vendor billing cycles daily (fires at period start, idempotent)
  autoGenerateVendorBillingCycles().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial vendor billing cycle auto-gen check failed"),
  );
  setInterval(() => {
    autoGenerateVendorBillingCycles().catch((err: unknown) =>
      logger.warn({ err }, "[cron] vendor billing cycle auto-gen poll failed"),
    );
  }, 24 * 60 * 60 * 1000);

  // Nightly tee sheet materialization — materialise slots for each day entering the 60-day rolling window
  materializeRollingWindow().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial tee sheet materialization failed"),
  );
  setInterval(() => {
    materializeRollingWindow().catch((err: unknown) =>
      logger.warn({ err }, "[cron] tee sheet materialization poll failed"),
    );
  }, 24 * 60 * 60 * 1000);

  // Low-stock inventory alerts — daily check, log + push notification to org admins
  checkLowStockAlerts().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial low-stock check failed"),
  );
  setInterval(() => {
    checkLowStockAlerts().catch((err: unknown) =>
      logger.warn({ err }, "[cron] low-stock check poll failed"),
    );
  }, 24 * 60 * 60 * 1000);

  // Flash sale push notifications — every 5 minutes, notify when a flash sale starts
  dispatchFlashSaleNotifications().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial flash-sale notification check failed"),
  );
  setInterval(() => {
    dispatchFlashSaleNotifications().catch((err: unknown) =>
      logger.warn({ err }, "[cron] flash-sale notification poll failed"),
    );
  }, 5 * 60 * 1000);

  // Automation rules engine — every 5 minutes, evaluate time-based triggers
  evaluateAutomationRules().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial automation rules evaluation failed"),
  );
  setInterval(() => {
    evaluateAutomationRules().catch((err: unknown) =>
      logger.warn({ err }, "[cron] automation rules evaluation poll failed"),
    );
  }, 5 * 60 * 1000);

  // Handicap committee — generate cases (anomalous, ESR backfill, score-not-posted) every 6 hours.
  // Annual review cases are generated once per day (idempotent by year + subject).
  setInterval(() => {
    import("./handicap-cases").then(({ runCaseGenerationForAllOrgs, generateAnnualReviewCases }) => {
      runCaseGenerationForAllOrgs().catch((err: unknown) =>
        logger.warn({ err }, "[cron] handicap case generation poll failed"),
      );
      // Annual cases: only generate during the first 7 days of January for the new year.
      const now = new Date();
      if (now.getUTCMonth() === 0 && now.getUTCDate() <= 7) {
        const year = now.getUTCFullYear();
        import("@workspace/db").then(async ({ db, whsPlayerStateTable }) => {
          const orgs = await db.selectDistinct({ orgId: whsPlayerStateTable.organizationId }).from(whsPlayerStateTable);
          for (const o of orgs) {
            if (o.orgId) {
              await generateAnnualReviewCases(o.orgId, year).catch((err: unknown) =>
                logger.warn({ err, orgId: o.orgId }, "[cron] annual handicap review case generation failed"),
              );
            }
          }
        }).catch(() => {});
      }
    }).catch(() => {});
  }, 6 * 60 * 60 * 1000);
  // Run once on startup as well.
  import("./handicap-cases").then(({ runCaseGenerationForAllOrgs }) => {
    runCaseGenerationForAllOrgs().catch((err: unknown) =>
      logger.warn({ err }, "[cron] initial handicap case generation failed"),
    );
  }).catch(() => {});

  // Handicap committee — daily digest of peer responses since the last
  // successful send (per-(case,peer-review) audit-row watermark enforces
  // exactly-once delivery). Real-time push + inbox is delivered the moment
  // a peer responds (see notifyCommitteeOfPeerResponse); this digest is a
  // belt-and-braces recap so committee members who skim email never miss
  // a response. We also kick one off at startup so a deploy/restart inside
  // the cron window doesn't push the digest to the next day.
  import("./handicap-cases").then(({ sendCommitteePeerResponsesDigests }) => {
    sendCommitteePeerResponsesDigests().catch((err: unknown) =>
      logger.warn({ err }, "[cron] initial committee peer-response digest failed"),
    );
  }).catch(() => {});
  setInterval(() => {
    import("./handicap-cases").then(({ sendCommitteePeerResponsesDigests }) => {
      sendCommitteePeerResponsesDigests().catch((err: unknown) =>
        logger.warn({ err }, "[cron] committee peer-response digest poll failed"),
      );
    }).catch(() => {});
  }, 24 * 60 * 60 * 1000);

  // Levy ledger scheduled-email delivery — every hour, send any due
  // schedule's CSV (Task #229).
  setInterval(() => {
    import("../routes/member-360").then(({ runDueLevyLedgerEmailSchedules }) => {
      runDueLevyLedgerEmailSchedules().catch((err: unknown) =>
        logger.warn({ err }, "[cron] levy-ledger email schedule poll failed"),
      );
    }).catch(() => {});
  }, 60 * 60 * 1000);
  import("../routes/member-360").then(({ runDueLevyLedgerEmailSchedules }) => {
    runDueLevyLedgerEmailSchedules().catch((err: unknown) =>
      logger.warn({ err }, "[cron] initial levy-ledger email schedule check failed"),
    );
  }).catch(() => {});

  // Org-wide combined levy ledger digest (Task #278) — every hour.
  setInterval(() => {
    import("../routes/member-360").then(({ runDueOrgLevyLedgerEmailSchedules }) => {
      runDueOrgLevyLedgerEmailSchedules().catch((err: unknown) =>
        logger.warn({ err }, "[cron] org-levy-ledger email schedule poll failed"),
      );
    }).catch(() => {});
  }, 60 * 60 * 1000);
  import("../routes/member-360").then(({ runDueOrgLevyLedgerEmailSchedules }) => {
    runDueOrgLevyLedgerEmailSchedules().catch((err: unknown) =>
      logger.warn({ err }, "[cron] initial org-levy-ledger email schedule check failed"),
    );
  }).catch(() => {});

  // Per-currency revenue & tax pivot scheduled email (Task #669) — every hour.
  setInterval(() => {
    import("../routes/member-360").then(({ runDueRevenueByCurrencyEmailSchedules }) => {
      runDueRevenueByCurrencyEmailSchedules().catch((err: unknown) =>
        logger.warn({ err }, "[cron] revenue-by-currency email schedule poll failed"),
      );
    }).catch(() => {});
  }, 60 * 60 * 1000);
  import("../routes/member-360").then(({ runDueRevenueByCurrencyEmailSchedules }) => {
    runDueRevenueByCurrencyEmailSchedules().catch((err: unknown) =>
      logger.warn({ err }, "[cron] initial revenue-by-currency email schedule check failed"),
    );
  }).catch(() => {});

  // Wallet auto-refund digest (Task #1073) — every hour.
  setInterval(() => {
    import("../routes/side-games-v2").then(({ runDueWalletTopupRefundEmailSchedules }) => {
      runDueWalletTopupRefundEmailSchedules().catch((err: unknown) =>
        logger.warn({ err }, "[cron] wallet-topup-refund email schedule poll failed"),
      );
    }).catch(() => {});
  }, 60 * 60 * 1000);
  import("../routes/side-games-v2").then(({ runDueWalletTopupRefundEmailSchedules }) => {
    runDueWalletTopupRefundEmailSchedules().catch((err: unknown) =>
      logger.warn({ err }, "[cron] initial wallet-topup-refund email schedule check failed"),
    );
  }).catch(() => {});

  // Stuck side-game receipt deliveries digest (Task #1290) — every hour.
  // Mirrors the wallet auto-refund poller above so org admins get a
  // daily/weekly mailed CSV of receipts that need manual follow-up.
  setInterval(() => {
    import("../routes/side-games-v2").then(({ runDueSideGameReceiptDigestSchedules }) => {
      runDueSideGameReceiptDigestSchedules().catch((err: unknown) =>
        logger.warn({ err }, "[cron] side-game-receipt digest schedule poll failed"),
      );
    }).catch(() => {});
  }, 60 * 60 * 1000);
  import("../routes/side-games-v2").then(({ runDueSideGameReceiptDigestSchedules }) => {
    runDueSideGameReceiptDigestSchedules().catch((err: unknown) =>
      logger.warn({ err }, "[cron] initial side-game-receipt digest schedule check failed"),
    );
  }).catch(() => {});

  // Forecast accuracy digest (Task #1254) — every hour.
  setInterval(() => {
    import("../routes/tee-pricing").then(({ runDueForecastAccuracyEmailSchedules }) => {
      runDueForecastAccuracyEmailSchedules().catch((err: unknown) =>
        logger.warn({ err }, "[cron] forecast-accuracy email schedule poll failed"),
      );
    }).catch(() => {});
  }, 60 * 60 * 1000);
  import("../routes/tee-pricing").then(({ runDueForecastAccuracyEmailSchedules }) => {
    runDueForecastAccuracyEmailSchedules().catch((err: unknown) =>
      logger.warn({ err }, "[cron] initial forecast-accuracy email schedule check failed"),
    );
  }).catch(() => {});

  // Spectator tee-off countdown alerts — every 5 minutes
  sendSpectatorTeeOffAlerts().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial spectator tee-off alert check failed"),
  );
  setInterval(() => {
    sendSpectatorTeeOffAlerts().catch((err: unknown) =>
      logger.warn({ err }, "[cron] spectator tee-off alert poll failed"),
    );
  }, TEE_OFF_ALERT_POLL_INTERVAL_MS);

  // FX rate auto-refresh — pull mid-market rates from a free public API (open.er-api.com)
  // for every org's base ↔ display currency pairs. Runs once on startup and then daily.
  refreshAllOrgFxRates()
    .then((r) => logger.info(r, "[cron] initial FX rate refresh complete"))
    .catch((err: unknown) => logger.warn({ err }, "[cron] initial FX rate refresh failed"));
  setInterval(() => {
    refreshAllOrgFxRates()
      .then((r) => logger.info(r, "[cron] FX rate refresh complete"))
      .catch((err: unknown) => logger.warn({ err }, "[cron] FX rate refresh failed"));
  }, 24 * 60 * 60 * 1000);

  // Wellness sweep — pull Whoop & Google Fit metrics once per 24h per connection.
  // We tick hourly; the sweep itself dedupes by lastSyncAt < now-24h, so each
  // connection is actually synced at most once per day. Token refresh is handled
  // proactively (within 5 min of expiry); 401/403 flips status to needs_reauth.
  sweepWellnessConnections().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial wellness sweep failed"),
  );
  setInterval(() => {
    sweepWellnessConnections().catch((err: unknown) =>
      logger.warn({ err }, "[cron] wellness sweep poll failed"),
    );
  }, 60 * 60 * 1000);

  // Stale HR-session marker sweep (Task #1194). The active-HR-session
  // table (`hr_active_sessions`) is normally cleaned lazily — by
  // `markHrSessionEnded` on hrStop, and by `isHrSessionActive` when it
  // observes an expired TTL. Rows for users who never POST again (rare
  // hard crashes with no follow-up traffic) only get noticed the next
  // time someone checks that user, so they accumulate. This hourly
  // sweep is the safety net: it drops any row whose `expires_at` is
  // older than the grace window documented in `wearables.ts`.
  const runHrSessionSweep = () =>
    sweepStaleHrSessions()
      .then((n) => {
        if (n > 0) {
          logger.info({ deleted: n }, "[cron] stale HR sessions swept");
        }
      })
      .catch((err: unknown) =>
        logger.warn({ err }, "[cron] stale HR session sweep failed"),
      );
  runHrSessionSweep();
  setInterval(runHrSessionSweep, HR_SESSION_SWEEP_INTERVAL_MS);

  // Weekly week-over-week needs_reauth drift alert (Task #1151).
  // The hourly sweep alert above only catches absolute spikes; a slow drift
  // (e.g. tokens silently expiring a few extra per day for a week) never trips
  // it. This evaluator compares the current 7-day window of sweep runs against
  // the prior 7-day window and emails each org's wearable-reauth alert
  // recipient when the increase exceeds the configured threshold. The job is
  // safe to run more often than weekly because the per-org email is rate-
  // limited to once per 7 days via an atomic conditional UPDATE on
  // `organizations.wearable_reauth_wow_alert_last_sent_at` — we tick daily so
  // a drift that begins mid-week is caught without waiting 6 more days.
  const runWeeklyReauthDriftJob = () =>
    evaluateWeeklyReauthDrift()
      .then((r) => logger.info(r, "[cron] weekly needs_reauth drift evaluation complete"))
      .catch((err: unknown) => logger.warn({ err }, "[cron] weekly needs_reauth drift evaluation failed"));
  runWeeklyReauthDriftJob();
  setInterval(runWeeklyReauthDriftJob, 24 * 60 * 60 * 1000);

  // Watch motion buffer sweep (Task #695) — daily. Deletes rows from
  // `watch_motion_buffer` older than the 6h TTL. The per-user prune in
  // shot-detection.ts only fires when a player's buffer is read or written;
  // a player who abandons a round mid-way would otherwise leave stale rows
  // sitting in Postgres until they next play. This nightly sweep keeps the
  // table tidy regardless of user activity and logs how many rows it removed.
  sweepStaleWatchMotionBuffer().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial watch-motion-buffer sweep failed"),
  );
  setInterval(() => {
    sweepStaleWatchMotionBuffer().catch((err: unknown) =>
      logger.warn({ err }, "[cron] watch-motion-buffer sweep poll failed"),
    );
  }, WATCH_MOTION_SWEEP_INTERVAL_MS);

  // GPS chunk buffer sweep (Task #852) — hourly. Deletes rows from
  // `gps_chunk_buffer` older than the 8h TTL. The per-(user,context) prune
  // in shot-detection.ts only fires when a player's ingest/detect endpoint
  // is hit again for that round; an abandoned round would otherwise leak
  // rows forever. This hourly sweep keeps the table tidy regardless of user
  // activity and logs how many rows it removed.
  sweepStaleGpsChunkBuffer().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial gps-chunk-buffer sweep failed"),
  );
  setInterval(() => {
    sweepStaleGpsChunkBuffer().catch((err: unknown) =>
      logger.warn({ err }, "[cron] gps-chunk-buffer sweep poll failed"),
    );
  }, GPS_CHUNK_BUFFER_SWEEP_INTERVAL_MS);

  // WHS Gap 7: Correction window overdue detection — every 15 minutes
  detectCorrectionWindowOverdue().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial correction-window overdue check failed"),
  );
  setInterval(() => {
    detectCorrectionWindowOverdue().catch((err: unknown) =>
      logger.warn({ err }, "[cron] correction-window overdue poll failed"),
    );
  }, 15 * 60 * 1000);

  // Marketplace saved-search alert evaluator (Task 408) — every 15 minutes.
  // Finds newly-matching public slots for each opted-in saved search and
  // pushes a notification to the owner. Per-user-per-day cap enforced
  // inside `runSavedSearchAlerts` to prevent spam.
  const runMarketplaceSavedSearchAlertsJob = () =>
    import("../routes/marketplace-discover")
      .then(({ runSavedSearchAlerts }) => runSavedSearchAlerts())
      .then((r) => logger.info(r, "[cron] marketplace saved-search alerts complete"))
      .catch((err: unknown) =>
        logger.warn({ err }, "[cron] marketplace saved-search alerts failed"),
      );
  runMarketplaceSavedSearchAlertsJob();
  setInterval(runMarketplaceSavedSearchAlertsJob, 15 * 60 * 1000);

  // Expired data-export archive purger — daily (Task #619). Removes the JSON
  // file from object storage 7 days after `resolvedAt` and clears artifactUrl
  // so the controller dashboard shows the export as `expired`.
  purgeExpiredDataExportArchives().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial data-export purge failed"),
  );
  setInterval(() => {
    purgeExpiredDataExportArchives().catch((err: unknown) =>
      logger.warn({ err }, "[cron] data-export purge poll failed"),
    );
  }, DATA_EXPORT_PURGE_POLL_INTERVAL_MS);

  // Data-export "expires in 24h" reminder — daily (Task #922). Sends a
  // friendly nudge through the existing multi-channel pipeline to members
  // whose download link is about to expire and who haven't grabbed the
  // archive yet, only once per row.
  sendDataExportExpiringReminders().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial data-export expiring reminder failed"),
  );
  setInterval(() => {
    sendDataExportExpiringReminders().catch((err: unknown) =>
      logger.warn({ err }, "[cron] data-export expiring reminder poll failed"),
    );
  }, DATA_EXPORT_EXPIRING_POLL_INTERVAL_MS);

  // Data-export "auto-delete tomorrow" purge reminder — daily (Task #972).
  // One-shot courtesy notice the day before the daily purger removes an
  // archive, so members can grab the file before it disappears. Broader
  // eligibility surface than the Task #922 sibling (no lastNotificationKind
  // gate); deduped via the new `expiryNotifiedAt` column plus the existing
  // `expiringNoticeSentAt` so the two crons never double-nudge a row.
  sendDataExportPurgeReminders().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial data-export purge reminder failed"),
  );
  setInterval(() => {
    sendDataExportPurgeReminders().catch((err: unknown) =>
      logger.warn({ err }, "[cron] data-export purge reminder poll failed"),
    );
  }, DATA_EXPORT_PURGE_REMINDER_POLL_INTERVAL_MS);

  // Account-deletion erasure worker — daily (Task #467). Processes erasure
  // rows whose 30-day grace window has elapsed, anonymising member PII and
  // closing the request so the controller's overdue counter stays at zero.
  processOverdueAccountErasures().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial account-erasure pass failed"),
  );
  setInterval(() => {
    processOverdueAccountErasures().catch((err: unknown) =>
      logger.warn({ err }, "[cron] account-erasure poll failed"),
    );
  }, ACCOUNT_ERASURE_POLL_INTERVAL_MS);

  // Task #973 — drain orphan object-storage deletions left behind by failed
  // erasure passes. Runs every 5 minutes with exponential backoff per row so
  // a transient backend hiccup is recovered automatically instead of leaving
  // member PII in the bucket.
  processPendingStorageDeletions().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial pending-storage-deletion pass failed"),
  );
  setInterval(() => {
    processPendingStorageDeletions().catch((err: unknown) =>
      logger.warn({ err }, "[cron] pending-storage-deletion poll failed"),
    );
  }, PENDING_STORAGE_POLL_INTERVAL_MS);

  // Task #1079 — bounded auto-retry for stuck erasure storage cleanups.
  // Hourly pass that re-runs the per-member retry helper for any member
  // whose latest erasure still has bucket files outstanding, capped at
  // 5 attempts spaced exponentially over ~24h. Beyond the cap the member
  // stays on the controller dashboard until handled manually.
  runStuckErasureAutoRetryPass()
    .then((s) => {
      if (s.candidates > 0) {
        logger.info(s, "[cron] initial stuck-erasure auto-retry pass complete");
      }
    })
    .catch((err: unknown) =>
      logger.warn({ err }, "[cron] initial stuck-erasure auto-retry pass failed"),
    );
  setInterval(() => {
    runStuckErasureAutoRetryPass()
      .then((s) => {
        if (s.candidates > 0) {
          logger.info(s, "[cron] stuck-erasure auto-retry pass complete");
        }
      })
      .catch((err: unknown) =>
        logger.warn({ err }, "[cron] stuck-erasure auto-retry pass failed"),
      );
  }, ERASURE_AUTO_RETRY_POLL_INTERVAL_MS);

  // Custom-domain TLS re-poll (Task #667) — flips pending → active/failed
  // automatically as the ingress provider finishes issuing the certificate.
  recheckPendingCustomDomainCerts().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial custom-domain cert re-check failed"),
  );
  setInterval(() => {
    recheckPendingCustomDomainCerts().catch((err: unknown) =>
      logger.warn({ err }, "[cron] custom-domain cert re-check poll failed"),
    );
  }, CUSTOM_DOMAIN_CERT_POLL_INTERVAL_MS);

  // Task #1249 — Background re-verification of saved external marketing
  // logo / favicon URLs. Polls every 6 h; per-row backoff inside the
  // function caps each URL at one verifier hit per ~24 h so we don't
  // hammer third-party hosts. Auto-clears the override + emails admins
  // once a URL crosses the consecutive-failure threshold.
  recheckExternalMarketingImages().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial marketing-image recheck failed"),
  );
  setInterval(() => {
    recheckExternalMarketingImages().catch((err: unknown) =>
      logger.warn({ err }, "[cron] marketing-image recheck poll failed"),
    );
  }, MARKETING_IMAGE_RECHECK_POLL_INTERVAL_MS);

  // Task #1467 — Periodic refresh of the cached marketing logos /
  // favicons. Polls daily; per-source backoff inside the function caps
  // each source URL at one re-download per ~7 days. Rotates the public
  // /api/storage/... URL and bumps cacheVersion only when the upstream
  // bytes have actually changed (the content-hashed object key
  // collapses unchanged bytes onto the existing object).
  refreshCachedMarketingImages().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial marketing-image refresh failed"),
  );
  setInterval(() => {
    refreshCachedMarketingImages().catch((err: unknown) =>
      logger.warn({ err }, "[cron] marketing-image refresh poll failed"),
    );
  }, MARKETING_IMAGE_REFRESH_POLL_INTERVAL_MS);

  // Task #1584 — Bounded background auto-retry for legacy NULL-duration
  // video rows. Polls daily; per-row backoff inside the function caps
  // each row at one re-probe per ~24h, and after
  // LEGACY_VIDEO_AUTO_RETRY_CAP consecutive failures the row is flagged
  // with a duration_unverifiable_reason and stops being retried so the
  // admin "unverifiable videos" page only shows rows that genuinely
  // need attention.
  recheckLegacyVideoDurations().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial legacy-video duration recheck failed"),
  );
  setInterval(() => {
    recheckLegacyVideoDurations().catch((err: unknown) =>
      logger.warn({ err }, "[cron] legacy-video duration recheck poll failed"),
    );
  }, LEGACY_VIDEO_RECHECK_POLL_INTERVAL_MS);

  // Task #1612 — Daily refresh of the per-round historical-weather cache.
  // The Open-Meteo archive lags ~5 days, so any round logged in the last
  // 5 days lands in `round_weather_cache` with a NULL observation and
  // would stay that way until the admin re-ran
  // `pnpm backfill:round-weather-cache` by hand. Polling daily across
  // the trailing 30-day window picks those rows back up automatically
  // once the archive catches up. Idempotent — rows already populated
  // with a non-null temperature/wind are skipped, so the boot-time fire
  // and the daily tick are both safe.
  runRoundWeatherCacheBackfillCron();
  setInterval(runRoundWeatherCacheBackfillCron, 24 * 60 * 60 * 1000);

  // Task #951 — Re-nudge admins whose custom-domain HTTPS has been stuck
  // in 'failed' for more than N days since we last emailed them. Tick
  // hourly; the per-row threshold + atomic claim inside the function
  // ensures each org only gets re-nudged once per window even across
  // restarts or concurrent ticks.
  const runHttpsFailedRenudge = () =>
    import("../routes/organizations")
      .then(({ renudgeStaleCustomDomainHttpsFailures }) => renudgeStaleCustomDomainHttpsFailures())
      .catch((err: unknown) =>
        logger.warn({ err }, "[cron] custom-domain HTTPS failed re-nudge failed"),
      );
  runHttpsFailedRenudge();
  setInterval(runHttpsFailedRenudge, 60 * 60 * 1000);

  // Wallet top-up reconciliation (Task #769) — daily. If a Razorpay
  // wallet-topup payment was captured but never made it into the wallet
  // ledger (signature mismatch / network drop), refund it and record an
  // adjustment row so the member sees the activity in their wallet history.
  const runWalletTopupRefundJob = () =>
    import("../routes/side-games-v2")
      .then(({ refundOrphanedWalletTopups }) => refundOrphanedWalletTopups())
      .catch((err: unknown) =>
        logger.warn({ err }, "[cron] wallet top-up auto-refund failed"),
      );
  runWalletTopupRefundJob();
  setInterval(runWalletTopupRefundJob, 24 * 60 * 60 * 1000);

  // Plan-migration audit super-admin digest (Task #835).
  // Tick hourly so a freshly-written `entity = 'organization_subscription_tier'`
  // / `action = 'migrate'` row surfaces within ~1h, while the in-memory 23h
  // dedup keeps it to a daily cadence in steady state. Runs once at startup
  // so existing unacknowledged rows don't sit unnoticed across restarts.
  sendPlanMigrationDigestToSuperAdmins().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial plan-migration digest failed"),
  );
  setInterval(() => {
    sendPlanMigrationDigestToSuperAdmins().catch((err: unknown) =>
      logger.warn({ err }, "[cron] plan-migration digest failed"),
    );
  }, 60 * 60 * 1000);

  // Weekly super-admin silent-failure alerts CSV digest (Task #1663).
  // Ticks daily so a process restart inside the 7-day window resumes the
  // schedule the same day, while the persisted 6.5-day dedup floor on
  // `member_audit_log` (entity = "silent_alerts_digest", action = "send")
  // keeps it to a weekly cadence in steady state. Boot-fires once so a
  // brand-new install / restart after a long gap surfaces silent failures
  // without waiting up to 24h for the first tick.
  sendSilentAlertsDigestToSuperAdmins().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial silent-alerts digest failed"),
  );
  setInterval(() => {
    sendSilentAlertsDigestToSuperAdmins().catch((err: unknown) =>
      logger.warn({ err }, "[cron] silent-alerts digest failed"),
    );
  }, 24 * 60 * 60 * 1000);

  // Caddie prompt-metrics retention sweep (Task #845) — daily.
  // Deletes `caddie_prompt_metrics` rows older than 90 days so the table
  // doesn't grow unbounded; aggregates only need ~30 days of history.
  const runCaddiePromptMetricsPrune = () =>
    import("./caddiePromptMetrics")
      .then(({ pruneCaddiePromptMetrics }) => pruneCaddiePromptMetrics())
      .catch((err: unknown) =>
        logger.warn({ err }, "[cron] caddie prompt-metrics prune failed"),
      );
  runCaddiePromptMetricsPrune();
  setInterval(runCaddiePromptMetricsPrune, 24 * 60 * 60 * 1000);

  // Branded notification daily sweep (Task #2008) — daily.
  // Detects verified-handicap badges nearing expiry and user-streak
  // milestones and fires the matching branded helpers in
  // `lib/brandedNotifications.ts`. Per-row dedup via `member_audit_log`
  // makes the boot-fire safe across restarts.
  const runBrandedSweep = () =>
    runBrandedNotificationDailySweep()
      .then((s) => logger.info(s, "[cron] branded-notification daily sweep complete"))
      .catch((err: unknown) =>
        logger.warn({ err }, "[cron] branded-notification daily sweep failed"),
      );
  runBrandedSweep();
  setInterval(runBrandedSweep, 24 * 60 * 60 * 1000);

  // Coaching gap-closed daily sweep (Task #2040) — daily.
  // Iterates active players who logged shots in the last 30 days,
  // computes the same proximity-vs-tour trend the AI Caddie uses
  // (`computeProximityCoachingTips`, `TREND_ENCOURAGEMENT_FT = -1.5`)
  // and pushes `coaching.gap.closed` for each club whose gap shrunk
  // by at least that threshold vs the prior 30-day window. Per-(user,
  // clubKey) dedup for 14 days via `member_audit_log` makes the
  // boot-fire safe across restarts; the per-event opt-out
  // (`notifyCoachingTipClosed`) lets a player mute the nudge without
  // touching the global `preferPush` toggle.
  const runCoachingGapSweep = () =>
    runCoachingGapClosedDailySweep()
      .then((s) => logger.info(s, "[cron] coaching.gap.closed daily sweep complete"))
      .catch((err: unknown) =>
        logger.warn({ err }, "[cron] coaching.gap.closed daily sweep failed"),
      );
  runCoachingGapSweep();
  setInterval(runCoachingGapSweep, 24 * 60 * 60 * 1000);

  // Manual-entry skip-reason history retention sweep (Task #2067) — daily.
  // `manual_entry_notify_skips` gets one row per non-delivery
  // `notifyManualEntryRound` call so the super-admin "why did rounds
  // get skipped?" dashboard can render its 7d / 30d breakdown chart.
  // The dashboard never queries beyond 30 days, so anything older is
  // dead weight on disk and on the `(reason, created_at)` index. Rows
  // older than the retention window (90 days by default — one full
  // season + buffer; tunable via `MANUAL_ENTRY_NOTIFY_SKIPS_RETENTION_DAYS`)
  // are deleted here.
  const runManualEntryNotifySkipsPrune = () =>
    import("./manualEntryNotifySkipsRetention")
      .then(({ pruneManualEntryNotifySkips }) => pruneManualEntryNotifySkips())
      .catch((err: unknown) =>
        logger.warn({ err }, "[cron] manual-entry-notify-skips prune failed"),
      );
  runManualEntryNotifySkipsPrune();
  setInterval(runManualEntryNotifySkipsPrune, 24 * 60 * 60 * 1000);

  // Ops alert settings audit log retention sweep (Task #1925) — daily.
  // `ops_alert_settings_history` appends one row per super-admin PATCH
  // and was never pruned; a misbehaving script or a noisy incident with
  // frequent toggles would otherwise grow the table without bound. Rows
  // older than the retention window (1 year by default, tunable via
  // `OPS_ALERT_SETTINGS_HISTORY_RETENTION_DAYS`) are deleted here. The
  // super-admin "Recent changes" UI only renders the last handful, so
  // the year-old cutoff keeps recent forensic value intact while
  // bounding the table.
  const runOpsAlertSettingsHistoryPrune = () =>
    import("./opsAlertSettings")
      .then(({ pruneOpsAlertSettingsHistory }) => pruneOpsAlertSettingsHistory())
      .catch((err: unknown) =>
        logger.warn({ err }, "[cron] ops-alert-settings-history prune failed"),
      );
  runOpsAlertSettingsHistoryPrune();
  setInterval(runOpsAlertSettingsHistoryPrune, 24 * 60 * 60 * 1000);

  // Notification audit-log retention sweep (Task #2224) — daily.
  // `notification_audit_log` is append-only and was never pruned; the
  // `/api/portal/notification-audit` endpoint that surfaces these rows
  // to controllers caps its lookback at 365 days, so anything older
  // than that is never read by the product anyway. Personal data
  // riding inside the `payload` JSON also has to age out alongside
  // the same erasure pipeline this audit log is meant to backstop.
  // Rows older than the retention window (365 days by default,
  // tunable via `NOTIFICATION_AUDIT_LOG_RETENTION_DAYS`) are deleted
  // here.
  const runNotificationAuditLogPrune = () =>
    import("./notifyDispatch.js")
      .then(({ pruneNotificationAuditLog }) => pruneNotificationAuditLog())
      .catch((err: unknown) =>
        logger.warn({ err }, "[cron] notification-audit-log prune failed"),
      );
  runNotificationAuditLogPrune();
  setInterval(runNotificationAuditLogPrune, 24 * 60 * 60 * 1000);

  // Coach payout-account periodic re-verification (Task #913) — daily.
  // Re-runs Razorpay's VPA / bank validation against every saved fund
  // account that hasn't been validated in N days (default 60). Failed
  // re-validations flip the profile's payoutVerificationStatus to
  // 'needs_attention' so the auto-payout job parks the next disbursement
  // and the coach is emailed/pushed to re-verify.
  const runCoachPayoutReverifyJob = () =>
    import("./coachReverifyPayouts")
      .then(({ reverifyStalePayoutAccounts }) => reverifyStalePayoutAccounts())
      .then((s) => logger.info(s, "[cron] coach payout re-verification complete"))
      .catch((err: unknown) =>
        logger.warn({ err }, "[cron] coach payout re-verification failed"),
      );
  runCoachPayoutReverifyJob();
  setInterval(runCoachPayoutReverifyJob, 24 * 60 * 60 * 1000);

  // Wallet payout-account periodic re-verification (Task #1119) — daily.
  // Mirrors the coach job above, but for `wallet_payout_accounts` (the
  // member wallet withdrawal destinations added in Task #770). The same
  // VPA / penny-drop validation is replayed for accounts whose
  // verifiedAt is older than N days; a failure flips the row to
  // 'needs_attention' (the Withdraw button already surfaces the reason)
  // and emails/pushes the member so they can re-save.
  const runWalletPayoutReverifyJob = () =>
    import("./walletReverifyPayouts")
      .then(({ reverifyStaleWalletPayoutAccounts }) => reverifyStaleWalletPayoutAccounts())
      .then((s) => logger.info(s, "[cron] wallet payout re-verification complete"))
      .catch((err: unknown) =>
        logger.warn({ err }, "[cron] wallet payout re-verification failed"),
      );
  runWalletPayoutReverifyJob();
  setInterval(runWalletPayoutReverifyJob, 24 * 60 * 60 * 1000);

  // Watch position-rate metrics retention sweep (Task #877) — daily.
  // Deletes `watch_position_metrics` rows older than 90 days; the dashboard
  // only needs ~30 days of history for pre/post-#722 comparisons.
  //
  // Task #1676 — also sweeps the shared `watch_position_samples` table so
  // sessions that disconnected without being trimmed by the per-session
  // ring cap don't accumulate past the TTL.
  //
  // Task #1679 also reaps expired rows from `watch_session_mutes` here so
  // the persisted block list (now the source of truth for the in-memory
  // mute Map) doesn't carry long-tail expired rows between hydrations.
  // Same daily cadence: an expired mute does no harm in the meantime
  // (hydration skips already-expired rows), the sweep just keeps the
  // table tidy.
  const runWatchPositionMetricsPrune = () =>
    import("./watchPositionMetrics")
      .then(async ({
        pruneWatchPositionMetrics,
        pruneWatchPositionSamples,
        pruneExpiredWatchSessionMutes,
      }) => {
        await pruneWatchPositionMetrics();
        await pruneWatchPositionSamples();
        await pruneExpiredWatchSessionMutes();
      })
      .catch((err: unknown) =>
        logger.warn({ err }, "[cron] watch position-metrics prune failed"),
      );
  runWatchPositionMetricsPrune();
  setInterval(runWatchPositionMetricsPrune, 24 * 60 * 60 * 1000);

  // Public rate-limit bucket sweep (Task #930) — every 5 minutes.
  // Task #784 moved the per-IP / per-course throttle into Postgres
  // (`public_rate_limit_buckets`). The request hot path opportunistically
  // prunes rows untouched for >1h, but only at most every 5 minutes and
  // only when traffic happens to come in. A scheduled sweep keeps the
  // table bounded during quiet periods and ensures a long burst of
  // unique IPs (e.g. a botnet) can't balloon the table between
  // opportunistic sweeps.
  const runPublicRateLimitPrune = () =>
    import("./publicRateLimit")
      .then(({ pruneStaleRateLimitBuckets }) => pruneStaleRateLimitBuckets())
      .then((n) => {
        if (n > 0) {
          logger.info({ deleted: n }, "[cron] public rate-limit buckets pruned");
        }
      })
      .catch((err: unknown) =>
        logger.warn({ err }, "[cron] public rate-limit prune failed"),
      );
  runPublicRateLimitPrune();
  setInterval(runPublicRateLimitPrune, 5 * 60 * 1000);

  // Badge share-event rollup (Task #1096) — daily.
  // Summarises rows in `badge_share_events` older than 30 days into the
  // per-day `badge_share_daily_aggregates` table and deletes them, then
  // drops aggregates older than the long-term retention window. Combined
  // with the per-IP/per-handle/per-badge throttle on the public POST,
  // this keeps the raw-event table bounded even under sustained traffic
  // while preserving the totals that the portal stats and admin
  // leaderboard surface.
  const runBadgeShareRollup = () =>
    import("./badgeShareRollup")
      .then(({ pruneAndRollupBadgeShareEvents }) => pruneAndRollupBadgeShareEvents())
      .then((s) => {
        if (s.rolledUpEvents > 0 || s.prunedAggregateRows > 0) {
          logger.info(s, "[cron] badge-share rollup complete");
        }
      })
      .catch((err: unknown) =>
        logger.warn({ err }, "[cron] badge-share rollup failed"),
      );
  runBadgeShareRollup();
  setInterval(runBadgeShareRollup, 24 * 60 * 60 * 1000);

  // Task #2255 — Badge share-VISIT-event rollup — daily.
  // Mirrors the share-event rollup above for `badge_share_visit_events`:
  // summarises rows older than 30 days into the per-day
  // `badge_share_visit_daily_aggregates` table and deletes them, then
  // drops aggregates older than the long-term retention window. Without
  // this, every public-badge page view appended a row that nothing ever
  // pruned — a viral badge could pull in thousands per day and the
  // leaderboard JOINs would slow down accordingly.
  const runBadgeShareVisitRollup = () =>
    import("./badgeShareVisitRollup")
      .then(({ pruneAndRollupBadgeShareVisitEvents }) =>
        pruneAndRollupBadgeShareVisitEvents(),
      )
      .then((s) => {
        if (s.rolledUpEvents > 0 || s.prunedAggregateRows > 0) {
          logger.info(s, "[cron] badge-share-visit rollup complete");
        }
      })
      .catch((err: unknown) =>
        logger.warn({ err }, "[cron] badge-share-visit rollup failed"),
      );
  runBadgeShareVisitRollup();
  setInterval(runBadgeShareVisitRollup, 24 * 60 * 60 * 1000);

  // Task #1478 — hourly auto-page on-call when the badge-share rollup
  // cron above has not completed in over 36h AND raw badge_share_events
  // rows are waiting to be rolled up. Reuses
  // `getBadgeShareRollupAdminSummary()` (same data the super-admin
  // panel surfaces) and pages super-admins + OPS_ALERT_EMAILS so we
  // catch a silently-failing rollup without anyone having to load the
  // dashboard. Cooldown gating in the job itself prevents repeat pages
  // while the issue persists.
  runBadgeShareRollupStaleOpsAlertJob().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial badge-share rollup stale ops alert failed"),
  );
  setInterval(() => {
    runBadgeShareRollupStaleOpsAlertJob().catch((err: unknown) =>
      logger.warn({ err }, "[cron] badge-share rollup stale ops alert poll failed"),
    );
  }, 60 * 60 * 1000);

  // Profile share-event rollup (Task #1259) — daily.
  // Mirrors the badge-share rollup above for `profile_share_events`:
  // summarises rows older than 30 days into the per-day
  // `profile_share_daily_aggregates` table and deletes them, then
  // drops aggregates older than the long-term retention window.
  // Combined with the per-IP/per-handle throttle on the public POST
  // (Task #625), this keeps the raw-event table bounded even under
  // sustained traffic while preserving the totals that the public
  // share-stats endpoint, the portal share-stats endpoint, and the
  // admin profile-share leaderboard surface.
  const runProfileShareRollup = () =>
    import("./profileShareRollup")
      .then(({ pruneAndRollupProfileShareEvents }) => pruneAndRollupProfileShareEvents())
      .then((s) => {
        if (s.rolledUpEvents > 0 || s.prunedAggregateRows > 0) {
          logger.info(s, "[cron] profile-share rollup complete");
        }
      })
      .catch((err: unknown) =>
        logger.warn({ err }, "[cron] profile-share rollup failed"),
      );
  runProfileShareRollup();
  setInterval(runProfileShareRollup, 24 * 60 * 60 * 1000);

  // Task #1813 — hourly auto-page on-call when the profile-share rollup
  // cron above has not completed in over 36h AND raw
  // profile_share_events rows are waiting to be rolled up. Mirrors the
  // badge-share variant from Task #1478: reuses
  // `getProfileShareRollupAdminSummary()` (same data the super-admin
  // panel surfaces) and pages super-admins + OPS_ALERT_EMAILS so we
  // catch a silently-failing rollup without anyone having to load the
  // dashboard. Cooldown gating in the job itself prevents repeat pages
  // while the issue persists.
  runProfileShareRollupStaleOpsAlertJob().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial profile-share rollup stale ops alert failed"),
  );
  setInterval(() => {
    runProfileShareRollupStaleOpsAlertJob().catch((err: unknown) =>
      logger.warn({ err }, "[cron] profile-share rollup stale ops alert poll failed"),
    );
  }, 60 * 60 * 1000);

  // Recap share-event rollup (Task #1281) — daily.
  // Mirrors the badge-share and profile-share rollups above for the
  // public Year-in-Golf recap link analytics. Summarises rows in
  // `recap_share_events` older than 30 days into the per-day
  // `recap_share_daily_aggregates` table and deletes them, then drops
  // aggregates older than the long-term retention window. The raw
  // table grows quickly because each shared link can produce many
  // hits (a single Twitter/Slack/WhatsApp share fans out into one og
  // hit plus one card.png crawler hit per platform, plus any human
  // clicks), so the rollup keeps it bounded while preserving the
  // totals that the portal recap-share-stats endpoint surfaces.
  const runRecapShareRollup = () =>
    import("./recapShareRollup")
      .then(({ pruneAndRollupRecapShareEvents }) => pruneAndRollupRecapShareEvents())
      .then((s) => {
        if (s.rolledUpEvents > 0 || s.prunedAggregateRows > 0) {
          logger.info(s, "[cron] recap-share rollup complete");
        }
      })
      .catch((err: unknown) =>
        logger.warn({ err }, "[cron] recap-share rollup failed"),
      );
  runRecapShareRollup();
  setInterval(runRecapShareRollup, 24 * 60 * 60 * 1000);

  // Stripe webhook deliveries audit prune (Task #1125) — daily.
  // Drops `stripe_webhook_deliveries` rows older than 30 days so the audit
  // table doesn't grow unboundedly on busy production clubs.
  sweepOldStripeWebhookDeliveries().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial stripe-webhook-deliveries sweep failed"),
  );
  setInterval(() => {
    sweepOldStripeWebhookDeliveries().catch((err: unknown) =>
      logger.warn({ err }, "[cron] stripe-webhook-deliveries sweep failed"),
    );
  }, STRIPE_WEBHOOK_DELIVERIES_SWEEP_INTERVAL_MS);

  // Task #1883 — hourly watchdog that emails super-admins + on-call when
  // the daily Stripe-webhook retention sweep above has not completed in
  // ~36h. The admin Stripe webhook audit page already shows an orange
  // "Sweep stalled" badge in the same condition (Task #1295), but only
  // when an admin happens to load the page — for a silently-failing
  // cron we also push a notification so the issue is caught even when
  // nobody is staring at the dashboard. Cooldown gating in the job
  // itself (persisted to `stripe_webhook_sweep_stale_alerts`) prevents
  // repeat pages while the issue persists, mirroring the wellness
  // re-auth and badge-share / profile-share rollup auto-pagers. We
  // intentionally schedule this independently of the daily sweep —
  // running it inside `sweepOldStripeWebhookDeliveries` would mean a
  // crashed sweep cron also silences the watchdog.
  runStripeWebhookSweepStaleOpsAlertJob().catch((err: unknown) =>
    logger.warn({ err }, "[cron] initial stripe-webhook sweep stale ops alert failed"),
  );
  setInterval(() => {
    runStripeWebhookSweepStaleOpsAlertJob().catch((err: unknown) =>
      logger.warn({ err }, "[cron] stripe-webhook sweep stale ops alert poll failed"),
    );
  }, 60 * 60 * 1000);

  // Swing-video fps probe retention sweep (Task #1412) — daily.
  // Task #1217 made the fps probe queue durable in `swing_video_fps_probes`,
  // one row per swing video. Done rows stay forever for audit, but on a
  // busy club the table grows monotonically as more videos upload. This
  // sweep deletes `done` rows older than ~30 days; `failed` rows are
  // retained so persistent failures stay visible to operators.
  //
  // Task #1704 — after the sweep we also run the fps-probe failure ops
  // alert. The sweep already counted `failed` rows for us in
  // `failedRetained`, so we hand it straight to the alert job (which
  // handles thresholding, cooldown, recipient resolution, and email).
  // The alert call has its own catch so an alert-channel failure (bad
  // SMTP, etc.) does not poison the sweep's success log. The alert
  // intentionally runs only after a successful sweep, because it
  // depends on the sweep's `failedRetained` count — if the sweep
  // throws, we'll see the warning here and try again next tick.
  const runFpsProbeRetentionSweep = async () => {
    try {
      const { sweepOldFpsProbes } = await import("./swingFpsProbeQueue");
      const result = await sweepOldFpsProbes();
      try {
        const { runFpsProbeFailureOpsAlertJob } = await import("./swingFpsProbeFailureOpsAlert");
        await runFpsProbeFailureOpsAlertJob({ failedRetained: result.failedRetained });
      } catch (err) {
        logger.warn({ err }, "[cron] swing-fps-probe failure ops alert failed");
      }
    } catch (err) {
      logger.warn({ err }, "[cron] swing-fps-probe retention sweep failed");
    }
  };
  runFpsProbeRetentionSweep();
  setInterval(runFpsProbeRetentionSweep, 24 * 60 * 60 * 1000);

  logger.info("[cron] all jobs started (24h: 30-min, 1h: 10-min, payment-reminder: 24h, grace-expiry: 24h, fulfillment-poll: 6h, tee-24h: 30-min, tee-2h: 10-min, stale-pending: 5-min, locker-reminder: 24h, analytics-reports: 1h, gp-unverified: 1h, scoring-escalation: 10-min, correction-window: 15-min, vendor-renewal: 24h, privacy-request-deadline: 24h, bounced-levy-digest: 24h, privacy-request-retry: 15-min, levy-receipt-retry: 15-min, vendor-billing-auto-gen: 24h, tee-materialization: 24h, low-stock: 24h, flash-sale: 5-min, automation-rules: 5-min, marketplace-saved-search-alerts: 15-min, data-export-purge: 24h, account-erasure: 24h, erasure-auto-retry: 1h, custom-domain-cert-recheck: 5-min, marketing-image-recheck: 6h, plan-migration-digest: 1h, public-rate-limit-prune: 5-min, badge-share-rollup: 24h, badge-share-rollup-stale-alert: 1h, profile-share-rollup: 24h, profile-share-rollup-stale-alert: 1h, recap-share-rollup: 24h, stripe-webhook-deliveries-prune: 24h, stripe-webhook-sweep-stale-alert: 1h, swing-fps-probe-retention: 24h, hr-session-sweep: 1h)");
}

/**
 * WHS Gap 7 (general-play) — Two-stage correction window pipeline. Runs hourly.
 *
 * Stage 1: At 24 h after submission, if marker has still not countersigned
 *   (`pending_marker`), the round is escalated to `unverified` and all club admins
 *   are notified (and the player is told to expect review).
 *
 * Stage 2: At 24 h after the round was marked `unverified` (i.e. admin had a full
 *   24-hour review window), if no admin has acted, the round is auto-approved,
 *   handicap is recalculated, and emails are sent to both the player and marker
 *   explaining the auto-approval. If auto-approval fails the round stays `unverified`
 *   and is flagged again.
 *
 * NOTE (WHS Gap 6): postScoreAndRecalculate is called HERE (stage 2 auto-approval)
 * and from the explicit countersign/admin-confirm API routes. It is intentionally
 * NOT called on player-only submission routes.
 */
async function expireUnmarkedGeneralPlayRounds() {
  const now = new Date();

  // ---------- Stage 1: pending_marker → unverified (24 h window) ----------
  const stage1Cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const pendingExpired = await db
    .select({
      id: generalPlayRoundsTable.id,
      userId: generalPlayRoundsTable.userId,
      organizationId: generalPlayRoundsTable.organizationId,
    })
    .from(generalPlayRoundsTable)
    .where(and(
      eq(generalPlayRoundsTable.status, "pending_marker"),
      lt(generalPlayRoundsTable.submittedAt, stage1Cutoff),
    ));

  let escalated = 0;
  for (const round of pendingExpired) {
    await db.update(generalPlayRoundsTable).set({
      status: "unverified",
      unverifiedAt: now,
      updatedAt: now,
    }).where(eq(generalPlayRoundsTable.id, round.id));

    // Notify admins so they can act
    const admins = await db
      .select({ userId: orgMembershipsTable.userId })
      .from(orgMembershipsTable)
      .where(and(
        eq(orgMembershipsTable.organizationId, round.organizationId),
        inArray(orgMembershipsTable.role, ["org_admin", "competition_secretary"]),
      ));

    const adminUserIds = admins.map(a => a.userId).filter((id): id is number => id != null);
    if (adminUserIds.length > 0) {
      sendTransactionalPush(
        adminUserIds,
        "⚠️ General Play Round Needs Review",
        "A general play round has passed 24 hours without marker countersign and requires committee review.",
        { type: "general_play_unverified_admin", roundId: String(round.id) },
      ).catch(() => {});
    }

    sendTransactionalPush(
      [round.userId],
      "Round Awaiting Club Review",
      "Your general play round was not countersigned by your marker within 24 hours and has been escalated to your club admin for review.",
      { type: "general_play_unverified", roundId: String(round.id) },
    ).catch(() => {});

    logger.info({ roundId: round.id }, "[cron] general-play stage-1: pending_marker → unverified");
    escalated++;
  }

  // ---------- Stage 2: unverified → confirmed (auto-approve, 24 h admin window) ----------
  const stage2Cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const unverifiedExpired = await db
    .select({
      id: generalPlayRoundsTable.id,
      userId: generalPlayRoundsTable.userId,
      organizationId: generalPlayRoundsTable.organizationId,
      courseId: generalPlayRoundsTable.courseId,
      courseRating: generalPlayRoundsTable.courseRating,
      slopeRating: generalPlayRoundsTable.slopeRating,
      holesPlayed: generalPlayRoundsTable.holesPlayed,
      pccUsed: generalPlayRoundsTable.pccUsed,
      playedAt: generalPlayRoundsTable.playedAt,
      unverifiedAt: generalPlayRoundsTable.unverifiedAt,
    })
    .from(generalPlayRoundsTable)
    .where(and(
      eq(generalPlayRoundsTable.status, "unverified"),
      lt(generalPlayRoundsTable.unverifiedAt, stage2Cutoff),
    ));

  let autoApproved = 0;
  let stillPending = 0;
  for (const round of unverifiedExpired) {
    // WHS spec: auto-approve ONLY when no club admin is available.
    // If admins exist, they have had a 24-hour window since escalation —
    // re-notify them and leave the round in "unverified" for their action.
    const admins = await db
      .select({ userId: orgMembershipsTable.userId })
      .from(orgMembershipsTable)
      .where(and(
        eq(orgMembershipsTable.organizationId, round.organizationId),
        inArray(orgMembershipsTable.role, ["org_admin", "competition_secretary"]),
      ));

    if (admins.length > 0) {
      // Admins exist — re-escalate (push) and leave for human review
      const adminUserIds = admins.map(a => a.userId).filter((id): id is number => id != null);
      sendTransactionalPush(
        adminUserIds,
        "⚠️ General Play Round Still Unverified",
        "A general play round has been awaiting admin review for over 24 hours. Please review and confirm or dispute.",
        { type: "general_play_unverified_admin_reminder", roundId: String(round.id) },
      ).catch(() => {});
      logger.info({ roundId: round.id }, "[cron] general-play stage-2: admins exist — re-notified, round stays unverified");
      stillPending++;
      continue;
    }

    // No admin available — proceed with auto-approval per WHS fallback policy.
    // Look up player email and marker info for notification emails.
    const [playerInfo] = await db
      .select({ email: appUsersTable.email, displayName: appUsersTable.displayName, username: appUsersTable.username })
      .from(appUsersTable)
      .where(eq(appUsersTable.id, round.userId));

    const [markerInfo] = await db
      .select({ markerName: generalPlayMarkersTable.markerName, markerEmail: generalPlayMarkersTable.markerEmail })
      .from(generalPlayMarkersTable)
      .where(eq(generalPlayMarkersTable.roundId, round.id));

    try {
      const holes = await db
        .select({ strokes: generalPlayHoleScoresTable.strokes })
        .from(generalPlayHoleScoresTable)
        .where(eq(generalPlayHoleScoresTable.roundId, round.id));

      const grossScore = holes.reduce((sum, h) => sum + h.strokes, 0);
      if (grossScore === 0) {
        logger.warn({ roundId: round.id }, "[cron] general-play stage-2: skipped — no hole scores");
        continue;
      }

      const pcc = round.pccUsed ? Number(round.pccUsed) : await getPccForCourseDate(round.courseId, round.playedAt);

      // WHS Gap 6: postScoreAndRecalculate is called here ONLY after the full 48 h window
      // (24 h marker window + 24 h admin window) AND confirmed no admin is available.
      // This function is intentionally NOT called on player-only submission routes.
      const recalcResult = await postScoreAndRecalculate({
        userId: round.userId,
        organizationId: round.organizationId,
        courseId: round.courseId,
        sourceType: "general_play",
        sourceGeneralPlayId: round.id,
        holesPlayed: round.holesPlayed,
        grossScore,
        adjustedGrossScore: grossScore,
        courseRating: round.courseRating ? Number(round.courseRating) : 72,
        slopeRating: round.slopeRating ?? 113,
        pcc,
        markerName: "[Auto-approved — 48h window elapsed, no admin available]",
        markerGhinNumber: null,
        playedAt: round.playedAt,
      });

      await db.update(generalPlayRoundsTable).set({
        status: "confirmed",
        grossScore,
        scoreDifferential: String(recalcResult.finalDifferential),
        confirmedAt: now,
        updatedAt: now,
      }).where(eq(generalPlayRoundsTable.id, round.id));

      // Push notification to player
      sendTransactionalPush(
        [round.userId],
        "Round Auto-Confirmed",
        "Your general play round has been automatically confirmed after the 48-hour review window elapsed with no admin available. Your handicap has been updated.",
        { type: "general_play_auto_confirmed", roundId: String(round.id) },
      ).catch(() => {});

      // Email notification to player
      const playerName = playerInfo?.displayName ?? playerInfo?.username ?? "Golfer";
      if (playerInfo?.email) {
        sendBroadcastEmail(
          playerInfo.email,
          playerName,
          "Your general play round has been auto-approved",
          `Your general play round (played ${round.playedAt ? new Date(round.playedAt).toDateString() : "recently"}) was automatically confirmed after the 48-hour review window elapsed with no marker countersign and no club administrator available to review.\n\nYour handicap differential has been recorded and your handicap index updated accordingly.\n\nIf you believe this is incorrect, please contact your regional golf association.`,
          "KHARAGOLF",
          // Task #1566 — tag general-play auto-approval emails with the
          // originating club so the Postmark bounce webhook (Task #981)
          // can attribute hard bounces back to this org instantly.
          { orgId: round.organizationId },
        ).catch(() => {});
      }

      // Email notification to marker (if email on record)
      if (markerInfo?.markerEmail) {
        sendBroadcastEmail(
          markerInfo.markerEmail,
          markerInfo.markerName ?? "Marker",
          "General play round auto-approved — action not required",
          `You were listed as the marker for ${playerName}'s general play round. As no countersign was received within the required window and no club administrator was available to review, the round has been automatically approved by the system.\n\nNo further action is required from you. If you have any concerns, please contact your club.`,
          "KHARAGOLF",
          // Task #1566 — tag marker auto-approval notifications with the
          // originating club so the Postmark bounce webhook (Task #981)
          // can attribute hard bounces back to this org instantly.
          { orgId: round.organizationId },
        ).catch(() => {});
      }

      logger.info({ roundId: round.id, diff: recalcResult.finalDifferential }, "[cron] general-play stage-2: auto-confirmed (48h window elapsed, no admin)");
      autoApproved++;
    } catch (err) {
      logger.warn({ err, roundId: round.id }, "[cron] general-play stage-2: auto-approve failed, round stays unverified");
    }
  }

  if (escalated + autoApproved + stillPending > 0) {
    logger.info({ escalated, autoApproved, stillPending }, "[cron] general-play expiry pipeline: processed");
  }
}

/**
 * Detect tournament round submissions that have exceeded their correction window
 * (correctionWindowHours since the player signed). Transitions them from "submitted"
 * to "overdue_review" and notifies the relevant committee admins.
 *
 * WHS Gap 7 (tournament): Runs every 15 minutes.
 */
async function detectCorrectionWindowOverdue() {
  const now = new Date();

  // Load all active tournaments with their correction window setting and scoring deadline
  const tournaments = await db
    .select({
      id: tournamentsTable.id,
      organizationId: tournamentsTable.organizationId,
      name: tournamentsTable.name,
      correctionWindowHours: tournamentsTable.correctionWindowHours,
      scoringCloseTime: tournamentsTable.scoringCloseTime,
    })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.status, "active"));

  let totalOverdue = 0;

  for (const t of tournaments) {
    // Skip this tournament if the scoring deadline (scoringCloseTime) has already passed —
    // escalateOverdueScoringSubmissions() will handle those directly to "outstanding".
    // This prevents detectCorrectionWindowOverdue() and escalateOverdueScoringSubmissions()
    // from racing to update the same "submitted" rows in conflicting directions.
    if (t.scoringCloseTime) {
      const [sh, sm] = t.scoringCloseTime.split(":").map(Number);
      const scoringDeadline = new Date(now);
      scoringDeadline.setHours(sh, sm, 0, 0);
      if (scoringDeadline <= now) continue; // scoring deadline passed — let the other job handle it
    }

    const windowHours = t.correctionWindowHours ?? 24;
    const cutoff = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

    // Find submissions still in "submitted" state past the correction window
    const overdue = await db
      .select({ id: roundSubmissionsTable.id, playerId: roundSubmissionsTable.playerId })
      .from(roundSubmissionsTable)
      .where(and(
        eq(roundSubmissionsTable.tournamentId, t.id),
        eq(roundSubmissionsTable.status, "submitted"),
        lt(roundSubmissionsTable.submittedAt, cutoff),
      ));

    if (overdue.length === 0) continue;

    // Transition each overdue submission to "overdue_review"
    for (const sub of overdue) {
      await db.update(roundSubmissionsTable)
        .set({ status: "overdue_review" })
        .where(eq(roundSubmissionsTable.id, sub.id));

      logger.info({ submissionId: sub.id, tournamentId: t.id, windowHours }, "[cron] submission transitioned to overdue_review");
    }

    // Notify tournament committee / org admins
    const admins = await db
      .select({ userId: orgMembershipsTable.userId })
      .from(orgMembershipsTable)
      .where(and(
        eq(orgMembershipsTable.organizationId, t.organizationId),
        inArray(orgMembershipsTable.role, ["org_admin", "tournament_director", "committee_member", "competition_secretary"]),
      ));

    const adminUserIds = admins.map(a => a.userId).filter((id): id is number => id != null);
    if (adminUserIds.length > 0) {
      sendTransactionalPush(
        adminUserIds,
        "⚠️ Overdue Scorecards",
        `${overdue.length} scorecard(s) in "${t.name}" have passed the ${windowHours}h marker review window without countersign. Committee action required.`,
        { type: "overdue_review_escalation", tournamentId: String(t.id), count: String(overdue.length) },
      ).catch(() => {});
    }

    totalOverdue += overdue.length;
  }

  if (totalOverdue > 0) {
    logger.info({ totalOverdue }, "[cron] correction-window overdue detection: processed");
  }
}

/**
 * Escalate tournament round submissions that have passed their scoring deadline.
 * - "submitted" (player-signed, no countersign yet): transitions to "outstanding" and notifies admin
 * - "overdue_review" (correction window elapsed, awaiting committee): also escalated to "outstanding"
 *   once the hard scoring deadline passes.
 * - "pending" (player never signed): remains pending but flags admin after 2+ hours
 *
 * State machine relationship with detectCorrectionWindowOverdue():
 *   submitted → overdue_review  (when correctionWindowHours elapsed AND scoring deadline not yet passed)
 *   submitted → outstanding     (when scoring deadline has already passed — no correction-window step)
 *   overdue_review → outstanding (when scoring deadline passes while submission is in committee review)
 *
 * Runs every 10 minutes.
 */
async function escalateOverdueScoringSubmissions() {
  const now = new Date();

  // Find active tournaments with a scoringCloseTime configured
  const tournaments = await db
    .select({ id: tournamentsTable.id, organizationId: tournamentsTable.organizationId, name: tournamentsTable.name, scoringCloseTime: tournamentsTable.scoringCloseTime })
    .from(tournamentsTable)
    .where(and(
      eq(tournamentsTable.status, "active"),
      isNotNull(tournamentsTable.scoringCloseTime),
    ));

  for (const t of tournaments) {
    if (!t.scoringCloseTime) continue;
    const [h, m] = t.scoringCloseTime.split(":").map(Number);
    const deadline = new Date(now);
    deadline.setHours(h, m, 0, 0);
    // Only escalate if deadline has passed today
    if (deadline > now) continue;

    // Find "submitted" AND "overdue_review" scorecards that should be escalated:
    // - "submitted": player signed but no marker countersign before the hard deadline
    // - "overdue_review": correction window elapsed and committee was notified, but
    //   scoring deadline has now passed without resolution
    const overdueSubmitted = await db
      .select({ id: roundSubmissionsTable.id, playerId: roundSubmissionsTable.playerId, status: roundSubmissionsTable.status })
      .from(roundSubmissionsTable)
      .where(and(
        eq(roundSubmissionsTable.tournamentId, t.id),
        inArray(roundSubmissionsTable.status, ["submitted", "overdue_review"]),
        lt(roundSubmissionsTable.submittedAt, deadline),
      ));

    for (const sub of overdueSubmitted) {
      await db.update(roundSubmissionsTable)
        .set({ status: "outstanding" })
        .where(eq(roundSubmissionsTable.id, sub.id));
      logger.info({ submissionId: sub.id, tournamentId: t.id, prevStatus: sub.status }, "[cron] scorecard escalated to outstanding (deadline passed)");
    }

    if (overdueSubmitted.length > 0) {
      // Notify org-scoped admins only (prevent cross-org notification leakage)
      const admins = await db
        .select({ userId: orgMembershipsTable.userId })
        .from(orgMembershipsTable)
        .where(
          and(
            eq(orgMembershipsTable.organizationId, t.organizationId),
            inArray(orgMembershipsTable.role, ["org_admin", "tournament_director", "committee_member", "competition_secretary"]),
          )
        );
      const adminUserIds = admins.map(a => a.userId);
      if (adminUserIds.length > 0) {
        sendTransactionalPush(
          adminUserIds,
          "⚠️ Scorecards Past Deadline",
          `${overdueSubmitted.length} scorecard(s) in "${t.name}" have passed the scoring deadline without marker countersign. Review required.`,
          { type: "scoring_deadline_escalation", tournamentId: String(t.id) },
        ).catch(() => {});
      }
    }
  }
}

/** Send locker renewal reminders at 30 days and 7 days before expiry. */
async function sendLockerRenewalReminders() {
  const now = new Date();

  const windows = [
    { days: 30, field: "reminder30SentAt" as const, label: "30_days" as const },
    { days: 7,  field: "reminder7SentAt" as const,  label: "7_days" as const },
  ];

  for (const { days, field, label } of windows) {
    const windowStart = new Date(now.getTime() + (days - 1) * 24 * 60 * 60 * 1000);
    const windowEnd   = new Date(now.getTime() + (days + 1) * 24 * 60 * 60 * 1000);

    const assignments = await db
      .select({
        id: lockerAssignmentsTable.id,
        memberId: lockerAssignmentsTable.memberId,
        expiryDate: lockerAssignmentsTable.expiryDate,
        annualFee: lockerAssignmentsTable.annualFee,
        paymentLinkUrl: lockerAssignmentsTable.paymentLinkUrl,
        reminder30SentAt: lockerAssignmentsTable.reminder30SentAt,
        reminder7SentAt: lockerAssignmentsTable.reminder7SentAt,
        lockerNumber: lockersTable.lockerNumber,
        firstName: clubMembersTable.firstName,
        lastName: clubMembersTable.lastName,
        email: clubMembersTable.email,
        userId: clubMembersTable.userId,
      })
      .from(lockerAssignmentsTable)
      .innerJoin(lockersTable, eq(lockersTable.id, lockerAssignmentsTable.lockerId))
      .innerJoin(clubMembersTable, eq(clubMembersTable.id, lockerAssignmentsTable.memberId))
      .where(and(
        eq(lockerAssignmentsTable.status, "active"),
        gte(lockerAssignmentsTable.expiryDate, windowStart),
        lte(lockerAssignmentsTable.expiryDate, windowEnd),
        days === 30
          ? isNull(lockerAssignmentsTable.reminder30SentAt)
          : isNull(lockerAssignmentsTable.reminder7SentAt),
      ));

    for (const a of assignments) {
      try {
        const expiryStr = a.expiryDate.toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" });

        if (a.userId) {
          await sendTransactionalPush(
            [a.userId],
            days === 30 ? "Locker Renewal Due in 30 Days" : "Locker Renewal Urgent — 7 Days Left",
            `Your locker ${a.lockerNumber} expires on ${expiryStr}. Please renew soon.`,
            { type: "locker_renewal", days: String(days) },
          );
        }

        if (a.email) {
          await sendLockerRenewalReminderEmail(
            a.email,
            `${a.firstName} ${a.lastName}`,
            label,
            { lockerNumber: a.lockerNumber, expiryDate: expiryStr, paymentUrl: a.paymentLinkUrl ?? undefined },
          );
        }

        const setVal = days === 30 ? { reminder30SentAt: now, updatedAt: now } : { reminder7SentAt: now, updatedAt: now };
        await db.update(lockerAssignmentsTable).set(setVal).where(eq(lockerAssignmentsTable.id, a.id));

        logger.info({ assignmentId: a.id, days, memberId: a.memberId }, "[cron] locker renewal reminder sent");
      } catch (err) {
        logger.warn({ err, assignmentId: a.id }, "[cron] locker reminder failed for assignment");
      }
    }
  }
}

/**
 * Daily: check all orgs for active vendor contracts expiring in 90/60/30 days.
 * Log alert records (idempotent) and email org admins.
 */
async function dispatchVendorRenewalAlerts() {
  const now = new Date();
  const milestones = [90, 60, 30];
  let totalDispatched = 0;

  // Get all distinct org IDs that have active vendor contracts
  const orgs = await db
    .selectDistinct({ orgId: vendorContractsTable.organizationId })
    .from(vendorContractsTable)
    .where(eq(vendorContractsTable.status, "active"));

  for (const { orgId } of orgs) {
    // Get org admin emails
    const orgRow = await db
      .select({ name: organizationsTable.name, contactEmail: organizationsTable.contactEmail })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    const orgAdmins = await db
      .select({ email: appUsersTable.email, name: appUsersTable.displayName })
      .from(orgMembershipsTable)
      .innerJoin(appUsersTable, eq(appUsersTable.id, orgMembershipsTable.userId))
      .where(and(
        eq(orgMembershipsTable.organizationId, orgId),
        inArray(orgMembershipsTable.role, ["org_admin"]),
      ));
    const orgName = orgRow[0]?.name ?? "KHARAGOLF";
    const adminEmails = orgAdmins.map(a => a.email).filter((e): e is string => !!e);

    for (const days of milestones) {
      const windowStart = new Date(now.getTime() + (days - 1) * 24 * 60 * 60 * 1000);
      const windowEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

      const contracts = await db
        .select({ contract: vendorContractsTable, vendorName: vendorOperatorsTable.name, vendorEmail: vendorOperatorsTable.contactEmail })
        .from(vendorContractsTable)
        .innerJoin(vendorOperatorsTable, eq(vendorContractsTable.vendorOperatorId, vendorOperatorsTable.id))
        .where(and(
          eq(vendorContractsTable.organizationId, orgId),
          eq(vendorContractsTable.status, "active"),
          gte(vendorContractsTable.contractEndDate, windowStart),
          lte(vendorContractsTable.contractEndDate, windowEnd),
        ));

      for (const row of contracts) {
        const alertType = `expiry_${days}d`;
        const [existing] = await db
          .select({ id: vendorContractAlertsTable.id })
          .from(vendorContractAlertsTable)
          .where(and(
            eq(vendorContractAlertsTable.vendorContractId, row.contract.id),
            eq(vendorContractAlertsTable.alertType, alertType),
          ));

        if (!existing) {
          await db.insert(vendorContractAlertsTable).values({
            organizationId: orgId,
            vendorContractId: row.contract.id,
            alertType,
            daysBeforeExpiry: days,
          });
          totalDispatched++;

          // Email org admins (not the vendor)
          const endDateStr = row.contract.contractEndDate
            ? new Date(row.contract.contractEndDate).toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" })
            : "open-ended";
          // Task #1566 — route vendor renewal alerts through the central
          // mailer (`sendBroadcastEmail`) instead of an ad-hoc Gmail
          // transport so each send carries `metadata.orgId` and the
          // Postmark bounce webhook (Task #981) can attribute hard
          // bounces back to this club instantly. One send per admin
          // matches how the rest of the surface area behaves.
          const renewalBody = `<p>This is an automated alert from <strong>${orgName} (KHARAGOLF Enterprise)</strong>.</p>
                <p>The vendor contract with <strong>${row.vendorName}</strong> is due to expire on <strong>${endDateStr}</strong> (in approximately <strong>${days} days</strong>).</p>
                <p>Please log in to the KHARAGOLF admin portal to review and renew the contract if required.</p>`;
          for (const adminEmail of adminEmails) {
            try {
              await sendBroadcastEmail(
                adminEmail,
                "Admin",
                `Vendor Contract Alert: ${row.vendorName} expires in ${days} days`,
                renewalBody,
                orgName,
                { orgId },
              );
            } catch (mailErr) {
              logger.warn({ mailErr, vendorName: row.vendorName, days, adminEmail }, "[cron] vendor renewal email failed");
            }
          }

          logger.info({ orgId, contractId: row.contract.id, vendorName: row.vendorName, days }, "[cron] vendor renewal alert dispatched");
        }
      }
    }
  }

  if (totalDispatched > 0) {
    logger.info({ totalDispatched }, "[cron] vendor renewal alerts: dispatched");
  }
}

/**
 * Daily reminder for privacy / data-protection requests approaching or past their
 * 30-day statutory due date. Emails (and push-notifies, when possible) the org's
 * admins and the assigned handler.
 *
 *  - "approaching": open requests whose dueBy falls within the next 7 days
 *  - "overdue":     open requests whose dueBy is in the past
 *
 * Dedup keyed by `${requestId}:${kind}:${YYYY-MM-DD}` so the same request will
 * not be re-emailed multiple times in a single calendar day even if the cron is
 * re-invoked at startup. Daily resends across days are intentional — staff
 * deserve repeated nudges until the request is resolved.
 */
const remindedDataRequests = new Set<string>();

function pruneRemindedDataRequests() {
  const today = new Date().toISOString().slice(0, 10);
  for (const key of remindedDataRequests) {
    if (!key.endsWith(`:${today}`)) remindedDataRequests.delete(key);
  }
}

async function sendDataRequestDeadlineReminders() {
  pruneRemindedDataRequests();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Pull all open requests with a dueBy that is either past or within the next 7 days.
  const openRequests = await db
    .select({
      id: memberDataRequestsTable.id,
      organizationId: memberDataRequestsTable.organizationId,
      clubMemberId: memberDataRequestsTable.clubMemberId,
      requestType: memberDataRequestsTable.requestType,
      requestedAt: memberDataRequestsTable.requestedAt,
      dueBy: memberDataRequestsTable.dueBy,
      handlerUserId: memberDataRequestsTable.handlerUserId,
      memberFirst: clubMembersTable.firstName,
      memberLast: clubMembersTable.lastName,
    })
    .from(memberDataRequestsTable)
    .innerJoin(clubMembersTable, eq(clubMembersTable.id, memberDataRequestsTable.clubMemberId))
    .where(and(
      inArray(memberDataRequestsTable.status, ["pending", "in_progress"]),
      isNotNull(memberDataRequestsTable.dueBy),
      lte(memberDataRequestsTable.dueBy, in7d),
    ));

  if (openRequests.length === 0) return;

  // Group by organizationId so we look up admins once per org.
  const byOrg = new Map<number, typeof openRequests>();
  for (const r of openRequests) {
    if (!byOrg.has(r.organizationId)) byOrg.set(r.organizationId, []);
    byOrg.get(r.organizationId)!.push(r);
  }

  let approachingSent = 0;
  let overdueSent = 0;

  for (const [orgId, requests] of byOrg.entries()) {
    // Resolve org branding for the email header.
    const [org] = await db
      .select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    const branding = {
      orgName: org?.name ?? "KHARAGOLF",
      logoUrl: org?.logoUrl ?? undefined,
      primaryColor: org?.primaryColor ?? undefined,
    };

    // Org admins: union of app_users.role='org_admin' for this org +
    // org_memberships with admin/director/secretary roles.
    const directAdmins = await db
      .select({ userId: appUsersTable.id, email: appUsersTable.email, displayName: appUsersTable.displayName, username: appUsersTable.username })
      .from(appUsersTable)
      .where(and(eq(appUsersTable.organizationId, orgId), eq(appUsersTable.role, "org_admin")));
    const memberAdmins = await db
      .select({ userId: appUsersTable.id, email: appUsersTable.email, displayName: appUsersTable.displayName, username: appUsersTable.username })
      .from(orgMembershipsTable)
      .innerJoin(appUsersTable, eq(orgMembershipsTable.userId, appUsersTable.id))
      .where(and(
        eq(orgMembershipsTable.organizationId, orgId),
        inArray(orgMembershipsTable.role, ["org_admin", "competition_secretary"]),
      ));
    const seen = new Set<number>();
    const admins = [...directAdmins, ...memberAdmins].filter(a => {
      if (seen.has(a.userId)) return false;
      seen.add(a.userId);
      return true;
    });

    for (const req of requests) {
      if (!req.dueBy) continue;
      const dueBy = new Date(req.dueBy);
      const msUntilDue = dueBy.getTime() - now.getTime();
      const daysUntilDue = Math.ceil(msUntilDue / (24 * 60 * 60 * 1000));
      const kind: "approaching" | "overdue" = msUntilDue < 0 ? "overdue" : "approaching";

      const dedupKey = `${req.id}:${kind}:${today}`;
      if (remindedDataRequests.has(dedupKey)) continue;

      // Resolve recipients: org admins + assigned handler (if any and not already an admin).
      const recipients = [...admins];
      if (req.handlerUserId && !seen.has(req.handlerUserId)) {
        const [handler] = await db
          .select({ userId: appUsersTable.id, email: appUsersTable.email, displayName: appUsersTable.displayName, username: appUsersTable.username })
          .from(appUsersTable)
          .where(eq(appUsersTable.id, req.handlerUserId));
        if (handler) recipients.push(handler);
      }

      const memberName = `${req.memberFirst ?? ""} ${req.memberLast ?? ""}`.trim() || "Member";
      const userIdsForPush: number[] = [];

      for (const rec of recipients) {
        if (!rec.email) {
          if (rec.userId) userIdsForPush.push(rec.userId);
          continue;
        }
        const staffName = rec.displayName ?? rec.username ?? "Admin";
        try {
          await sendDataRequestDeadlineAlertEmail({
            to: rec.email,
            staffName,
            kind,
            requestId: req.id,
            requestType: req.requestType,
            memberName,
            requestedAt: new Date(req.requestedAt),
            dueBy,
            daysUntilDue,
            branding,
          });
        } catch (err) {
          logger.warn({ err, requestId: req.id, recipient: rec.email }, "[cron] privacy-request deadline email failed");
        }
        if (rec.userId) userIdsForPush.push(rec.userId);
      }

      if (userIdsForPush.length > 0) {
        const title = kind === "overdue"
          ? "⚠️ Privacy request OVERDUE"
          : `⏰ Privacy request due in ${daysUntilDue}d`;
        const body = kind === "overdue"
          ? `Request #${req.id} from ${memberName} has passed its 30-day statutory deadline.`
          : `Request #${req.id} from ${memberName} is due in ${daysUntilDue} day${daysUntilDue === 1 ? "" : "s"}.`;
        sendTransactionalPush(
          userIdsForPush,
          title,
          body,
          { type: "data_request_deadline", kind, requestId: String(req.id) },
        ).catch((err: unknown) => {
          logger.warn({ err, requestId: req.id }, "[cron] privacy-request deadline push failed");
        });
      }

      remindedDataRequests.add(dedupKey);
      if (kind === "overdue") overdueSent++; else approachingSent++;
      logger.info(
        { requestId: req.id, orgId, kind, daysUntilDue, recipients: recipients.length },
        "[cron] privacy-request deadline reminder sent",
      );
    }
  }

  if (approachingSent + overdueSent > 0) {
    logger.info({ approachingSent, overdueSent }, "[cron] privacy-request deadline reminders dispatched");
  }
}

// ─── Expired data-export archive purger (Task #619) ─────────────────────────
// Self-serve data exports stay downloadable for `DATA_EXPORT_VALID_DAYS` (7)
// after `resolvedAt`; once that window elapses the underlying JSON file in
// private object storage is no longer needed and contradicts the data-
// minimisation promise we make to members. This worker:
//   1. Finds completed access requests with a non-null artifactUrl whose
//      resolvedAt + 7 days has elapsed.
//   2. Deletes the underlying object from storage (best-effort — a missing
//      object is treated as already-purged so the row still gets cleaned up).
//   3. Clears artifactUrl on the row so the controller dashboard surfaces the
//      export as `expired` instead of `ready`.
// ─── Watch motion buffer sweep (Task #695) ───────────────────────────────────
// `watchMotionBufferTable` is per-user pruned in shot-detection.ts only when
// the user's buffer is read or written. If a player abandons a round mid-way
// and never comes back, their stale rows would otherwise sit in Postgres
// indefinitely. This sweep runs daily and deletes ALL rows older than the 6h
// TTL across every user, regardless of activity. Logs how many rows it removed.
const WATCH_MOTION_BUFFER_TTL_MS = 6 * 60 * 60 * 1000; // mirrors shot-detection.ts
const WATCH_MOTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

export async function sweepStaleWatchMotionBuffer(): Promise<{ removed: number }> {
  const cutoffMs = Date.now() - WATCH_MOTION_BUFFER_TTL_MS;
  const removed = await db
    .delete(watchMotionBufferTable)
    .where(lt(watchMotionBufferTable.eventTimestampMs, String(cutoffMs)))
    .returning({ id: watchMotionBufferTable.id });
  const count = removed.length;
  if (count > 0) {
    logger.info(
      { removed: count, cutoffMs },
      "[cron] watch-motion-buffer sweep: stale rows deleted",
    );
  } else {
    logger.debug({ removed: 0, cutoffMs }, "[cron] watch-motion-buffer sweep: no stale rows");
  }
  return { removed: count };
}

// ─── GPS chunk buffer sweep (Task #852) ──────────────────────────────────────
// `gpsChunkBufferTable` is per-(user,context) pruned in shot-detection.ts only
// when the same round is touched again by /portal/shots/ingest or
// /portal/shots/detect. A player who streams a few chunks and then never
// finishes the round (closes the app, loses signal forever, etc.) would
// otherwise leave those rows in Postgres indefinitely — a slow leak. There is
// also an opportunistic global prune that any ingest call may pay (throttled
// to once per 6 minutes per process), but a process that receives no ingest
// traffic at all would never run it. This sweep runs hourly and deletes ALL
// rows older than the 8h TTL across every user, regardless of activity.
const GPS_CHUNK_BUFFER_TTL_MS = 8 * 60 * 60 * 1000; // mirrors shot-detection.ts GPS_BUFFER_TTL_MS
const GPS_CHUNK_BUFFER_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly

export async function sweepStaleGpsChunkBuffer(): Promise<{ removed: number }> {
  const cutoffMs = Date.now() - GPS_CHUNK_BUFFER_TTL_MS;
  const removed = await db
    .delete(gpsChunkBufferTable)
    .where(lt(gpsChunkBufferTable.sampleTimestampMs, String(cutoffMs)))
    .returning({ id: gpsChunkBufferTable.id });
  const count = removed.length;
  if (count > 0) {
    logger.info(
      { removed: count, cutoffMs },
      "[cron] gps-chunk-buffer sweep: stale rows deleted",
    );
  } else {
    logger.debug({ removed: 0, cutoffMs }, "[cron] gps-chunk-buffer sweep: no stale rows");
  }
  return { removed: count };
}

// ─── Stripe webhook deliveries audit prune (Task #1125) ──────────────────────
// `stripe_webhook_deliveries` (Task #974) records one row for every inbound
// POST /api/webhooks/stripe call (real Stripe events plus rejected/forged
// requests). The admin UI only ever surfaces the last 10, so on a busy
// production club the table would otherwise grow forever. This sweep runs
// daily and deletes rows older than the 30-day retention window, logging
// how many rows it removed.
//
// Task #1294 — Each successful sweep also writes a row to
// `stripe_webhook_sweep_runs` so the admin Stripe webhook audit page can
// surface the last-sweep timestamp and pruned-row count without admins
// having to dig through server logs. Old rows in that audit table are
// pruned to ~90 days here too, so it stays bounded.
const STRIPE_WEBHOOK_DELIVERIES_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const STRIPE_WEBHOOK_DELIVERIES_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const STRIPE_WEBHOOK_SWEEP_RUNS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export async function sweepOldStripeWebhookDeliveries(): Promise<{ removed: number }> {
  const cutoff = new Date(Date.now() - STRIPE_WEBHOOK_DELIVERIES_TTL_MS);
  const removed = await db
    .delete(stripeWebhookDeliveriesTable)
    .where(lt(stripeWebhookDeliveriesTable.receivedAt, cutoff))
    .returning({ id: stripeWebhookDeliveriesTable.id });
  const count = removed.length;
  if (count > 0) {
    logger.info(
      { removed: count, cutoff: cutoff.toISOString() },
      "[cron] stripe-webhook-deliveries sweep: stale rows deleted",
    );
  } else {
    logger.debug(
      { removed: 0, cutoff: cutoff.toISOString() },
      "[cron] stripe-webhook-deliveries sweep: no stale rows",
    );
  }

  // Task #1294 — Persist the run summary so the admin UI can show the
  // last-sweep timestamp and removed-row count. We always insert (even
  // when count === 0) because admins want to know the sweep ran on a
  // healthy quiet day, not just when something was deleted. Failure to
  // persist is logged but does NOT fail the sweep itself — the prune is
  // the primary side effect, the audit is best-effort.
  try {
    const [inserted] = await db
      .insert(stripeWebhookSweepRunsTable)
      .values({ removed: count })
      .returning({
        ranAt: stripeWebhookSweepRunsTable.ranAt,
        removed: stripeWebhookSweepRunsTable.removed,
      });
    if (inserted) {
      _setLastStripeWebhookSweepResult({
        ranAt: inserted.ranAt.toISOString(),
        removed: inserted.removed,
      });
    }
    // Prune the audit table itself so it stays bounded.
    const auditCutoff = new Date(Date.now() - STRIPE_WEBHOOK_SWEEP_RUNS_RETENTION_MS);
    await db
      .delete(stripeWebhookSweepRunsTable)
      .where(lt(stripeWebhookSweepRunsTable.ranAt, auditCutoff));
  } catch (err) {
    logger.warn(
      { err },
      "[cron] failed to persist stripe-webhook-deliveries sweep summary",
    );
  }

  return { removed: count };
}

const DATA_EXPORT_PURGE_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

export async function purgeExpiredDataExportArchives(opts?: {
  storage?: { getObjectEntityFile: ObjectStorageService["getObjectEntityFile"] };
}): Promise<{ purged: number; failed: number; missing: number }> {
  const cutoff = new Date(Date.now() - DATA_EXPORT_VALID_DAYS * 24 * 60 * 60 * 1000);
  const expired = await db
    .select({
      id: memberDataRequestsTable.id,
      artifactUrl: memberDataRequestsTable.artifactUrl,
      organizationId: memberDataRequestsTable.organizationId,
      clubMemberId: memberDataRequestsTable.clubMemberId,
    })
    .from(memberDataRequestsTable)
    .where(and(
      eq(memberDataRequestsTable.requestType, "access"),
      eq(memberDataRequestsTable.status, "completed"),
      isNotNull(memberDataRequestsTable.artifactUrl),
      isNotNull(memberDataRequestsTable.resolvedAt),
      lt(memberDataRequestsTable.resolvedAt, cutoff),
    ))
    .limit(500);

  if (expired.length === 0) return { purged: 0, failed: 0, missing: 0 };

  const storage = opts?.storage ?? new ObjectStorageService();
  let purged = 0;
  let failed = 0;
  let missing = 0;

  for (const row of expired) {
    if (!row.artifactUrl) continue;
    let deleteOk = true;
    let wasMissing = false;
    try {
      const file = await storage.getObjectEntityFile(row.artifactUrl);
      await file.delete();
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        wasMissing = true;
      } else {
        deleteOk = false;
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), requestId: row.id, artifactUrl: row.artifactUrl },
          "[cron] data-export archive delete failed",
        );
      }
    }

    if (!deleteOk) {
      failed++;
      continue;
    }

    try {
      const purgedAt = new Date();
      await db.update(memberDataRequestsTable)
        .set({ artifactUrl: null, purgedAt })
        .where(eq(memberDataRequestsTable.id, row.id));
      purged++;
      if (wasMissing) missing++;

      // Task #773: surface the data-minimisation guarantee in the audit trail
      // so members and controllers can see *who* (cron) wiped *what*. Tagged
      // `metadata.source = "cron"` to differentiate from any future manual
      // controller-initiated purges. recordMemberAudit swallows its own
      // errors so an audit-table outage will not prevent purge progress.
      await recordMemberAudit({
        req: null,
        organizationId: row.organizationId,
        clubMemberId: row.clubMemberId,
        entity: "data_export",
        entityId: row.id,
        action: "purge",
        reason: `Auto-deleted expired data-export archive after ${DATA_EXPORT_VALID_DAYS}-day retention window.`,
        metadata: {
          source: "cron",
          artifactUrl: row.artifactUrl,
          alreadyMissing: wasMissing,
          purgedAt: purgedAt.toISOString(),
        },
      });
    } catch (err) {
      failed++;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), requestId: row.id },
        "[cron] data-export artifactUrl clear failed",
      );
    }
  }

  if (purged > 0 || failed > 0) {
    logger.info({ purged, failed, missing, total: expired.length }, "[cron] purgeExpiredDataExportArchives complete");
  }
  return { purged, failed, missing };
}

// ─── Data-export "expires in 24h" reminder (Task #922) ──────────────────────
// Self-serve data exports stay downloadable for `DATA_EXPORT_VALID_DAYS` (7)
// days after `resolvedAt`. Members who never come back to grab the file lose
// it once the daily purger runs and have to file a fresh request — a friction
// point the spec asks us to soften with a one-tap "your archive expires
// tomorrow" nudge ~24h before the link dies.
//
// Eligibility (per row, all conjunctive):
//   • requestType  = 'access' AND status = 'completed'
//   • lastNotificationKind = 'completed_export' (the original "ready" notice
//     was sent — without this we'd nudge rows that never went through the
//     fan-out pipeline at all, or rows we already nudged below).
//   • artifactUrl  IS NOT NULL              (still downloadable; not purged).
//   • artifactDownloadedAt IS NULL          (member hasn't grabbed it yet).
//   • expiringNoticeSentAt IS NULL          (idempotency guard so multiple
//     daily passes inside the eligibility window don't re-nudge).
//   • resolvedAt   <= now - (RETENTION_DAYS - REMINDER_LEAD_DAYS)
//     AND resolvedAt > now - RETENTION_DAYS  (i.e. ~24h before expiry, but
//     never *after* expiry — a post-expiry nudge would be useless because
//     the signed URL no longer works).
//
// Each eligible row is dispatched via `notifyDataRequest({ kind:
// "export_expiring" })` so it goes through the same multi-channel pipeline
// (in-app + email + opted-in push/SMS/WhatsApp) and the per-channel status
// telemetry is persisted automatically. We then stamp `expiringNoticeSentAt`
// regardless of channel-level outcomes so the row is never re-nudged on the
// next run; per-channel retries continue to be handled by the existing
// `retryFailedDataRequestPushSms` worker.
const DATA_EXPORT_EXPIRING_REMINDER_LEAD_DAYS = 1; // ~24h notice
const DATA_EXPORT_EXPIRING_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

export async function sendDataExportExpiringReminders(): Promise<{
  considered: number;
  notified: number;
  failed: number;
  /** Task #1075 — rows that matched the eligibility window but were skipped
   * because the member opted out of the reminder (per-request via the
   * one-click email link, or globally via `userNotificationPrefs`). Counted
   * separately so admins can see the suppression rate at a glance and so
   * `notified` continues to mean "actually pinged". */
  suppressed: number;
}> {
  const now = Date.now();
  const reminderCutoff = new Date(
    now - (DATA_EXPORT_VALID_DAYS - DATA_EXPORT_EXPIRING_REMINDER_LEAD_DAYS) * 24 * 60 * 60 * 1000,
  );
  // Don't nudge after the link has actually expired — once `resolvedAt + 7d`
  // is in the past the signed URL the member would tap is dead, so a
  // reminder is just noise. The purger (above) handles those rows.
  const expiryCutoff = new Date(now - DATA_EXPORT_VALID_DAYS * 24 * 60 * 60 * 1000);

  // Task #1075 — left-join to the member + their user-level prefs so we can
  // honour both the per-request opt-out (`expiringReminderOptedOutAt`) and
  // the per-user global opt-out (`userNotificationPrefs.notifyDataExportExpiring`)
  // without making N extra queries inside the loop. Members without a
  // prefs row keep the default opt-in behaviour.
  const rows = await db
    .select({
      request: memberDataRequestsTable,
      notifyExpiring: userNotificationPrefsTable.notifyDataExportExpiring,
    })
    .from(memberDataRequestsTable)
    .leftJoin(clubMembersTable, eq(clubMembersTable.id, memberDataRequestsTable.clubMemberId))
    .leftJoin(userNotificationPrefsTable, eq(userNotificationPrefsTable.userId, clubMembersTable.userId))
    .where(and(
      eq(memberDataRequestsTable.requestType, "access"),
      eq(memberDataRequestsTable.status, "completed"),
      eq(memberDataRequestsTable.lastNotificationKind, "completed_export"),
      isNotNull(memberDataRequestsTable.artifactUrl),
      isNull(memberDataRequestsTable.artifactDownloadedAt),
      isNull(memberDataRequestsTable.expiringNoticeSentAt),
      isNotNull(memberDataRequestsTable.resolvedAt),
      lte(memberDataRequestsTable.resolvedAt, reminderCutoff),
      gte(memberDataRequestsTable.resolvedAt, expiryCutoff),
    ))
    .limit(500);

  if (rows.length === 0) return { considered: 0, notified: 0, failed: 0, suppressed: 0 };

  let notified = 0;
  let failed = 0;
  let suppressed = 0;
  for (const { request: row, notifyExpiring } of rows) {
    // Task #1075 — honour both opt-out surfaces. Stamp `expiringNoticeSentAt`
    // for suppressed rows too so the same archive isn't re-evaluated on
    // every subsequent daily pass; the per-request flag remains the
    // authoritative "they asked us to stop" record.
    const optedOutPerRequest = row.expiringReminderOptedOutAt != null;
    const optedOutGlobally = notifyExpiring === false;
    if (optedOutPerRequest || optedOutGlobally) {
      suppressed++;
      await db.update(memberDataRequestsTable)
        .set({ expiringNoticeSentAt: new Date() })
        .where(eq(memberDataRequestsTable.id, row.id));
      continue;
    }
    try {
      await notifyDataRequest({
        organizationId: row.organizationId,
        request: row,
        kind: "export_expiring",
        logContext: { job: "sendDataExportExpiringReminders" },
      });
      // Stamp regardless of per-channel outcome — `notifyDataRequest`
      // already persists per-channel telemetry and the existing retry
      // workers will pick up any failed channels. We just need to
      // guarantee we don't nudge the same row twice.
      await db.update(memberDataRequestsTable)
        .set({ expiringNoticeSentAt: new Date() })
        .where(eq(memberDataRequestsTable.id, row.id));
      notified++;
    } catch (err) {
      failed++;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), requestId: row.id },
        "[cron] sendDataExportExpiringReminders: notifyDataRequest failed",
      );
    }
  }

  if (notified > 0 || failed > 0 || suppressed > 0) {
    logger.info(
      { considered: rows.length, notified, failed, suppressed },
      "[cron] sendDataExportExpiringReminders complete",
    );
  }
  return { considered: rows.length, notified, failed, suppressed };
}

// ─── Data-export "auto-delete tomorrow" purge reminder (Task #972) ─────────
// Members today only learn an export was auto-deleted *after* it has happened
// (the "Removed on <date>" note added in Task #773 is retroactive). This
// worker sends a one-shot courtesy notice (in-app + email + opt-in push/SMS/
// WhatsApp via the existing pipeline) ~24h *before* the daily purger
// (`purgeExpiredDataExportArchives`) would remove the archive, so members
// have a chance to grab the file before it disappears.
//
// Eligibility (per row, all conjunctive):
//   • requestType  = 'access' AND status = 'completed'
//   • artifactUrl  IS NOT NULL              (still downloadable; not purged).
//   • artifactDownloadedAt IS NULL          (member hasn't grabbed it yet).
//   • expiryNotifiedAt IS NULL              (one-shot dedup for *this* cron).
//   • expiringNoticeSentAt IS NULL          (avoid double-nudge with the
//     overlapping Task #922 cron which fires on the signed-URL expiry clock).
//   • resolvedAt   <= now - 6 days
//     AND resolvedAt > now - 7 days         (i.e. the day before purge,
//     never *after* the purger has already run on the row).
//
// Unlike Task #922's `sendDataExportExpiringReminders` we do *not* gate on
// `lastNotificationKind = 'completed_export'`: the spec wants this nudge to
// fire for every access export that's about to be auto-deleted, regardless
// of what the most recent privacy-notice kind happened to be (e.g. an admin
// might have manually re-sent a `completed` notice that overwrote the
// original `completed_export` marker).
const DATA_EXPORT_PURGE_REMINDER_LEAD_DAYS = 1; // ~24h before auto-delete
const DATA_EXPORT_PURGE_REMINDER_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

export async function sendDataExportPurgeReminders(): Promise<{
  considered: number;
  notified: number;
  failed: number;
  /** Task #1075 — see `sendDataExportExpiringReminders` for the rationale. */
  suppressed: number;
}> {
  const now = Date.now();
  const reminderCutoff = new Date(
    now - (DATA_EXPORT_VALID_DAYS - DATA_EXPORT_PURGE_REMINDER_LEAD_DAYS) * 24 * 60 * 60 * 1000,
  );
  // Don't nudge after the purger has already deleted the archive — the
  // download link is dead and a reminder would just be noise.
  const expiryCutoff = new Date(now - DATA_EXPORT_VALID_DAYS * 24 * 60 * 60 * 1000);

  // Task #1075 — same opt-out left-join pattern as the sibling cron.
  const rows = await db
    .select({
      request: memberDataRequestsTable,
      notifyExpiring: userNotificationPrefsTable.notifyDataExportExpiring,
    })
    .from(memberDataRequestsTable)
    .leftJoin(clubMembersTable, eq(clubMembersTable.id, memberDataRequestsTable.clubMemberId))
    .leftJoin(userNotificationPrefsTable, eq(userNotificationPrefsTable.userId, clubMembersTable.userId))
    .where(and(
      eq(memberDataRequestsTable.requestType, "access"),
      eq(memberDataRequestsTable.status, "completed"),
      isNotNull(memberDataRequestsTable.artifactUrl),
      isNull(memberDataRequestsTable.artifactDownloadedAt),
      isNull(memberDataRequestsTable.expiryNotifiedAt),
      isNull(memberDataRequestsTable.expiringNoticeSentAt),
      isNotNull(memberDataRequestsTable.resolvedAt),
      lte(memberDataRequestsTable.resolvedAt, reminderCutoff),
      gte(memberDataRequestsTable.resolvedAt, expiryCutoff),
    ))
    .limit(500);

  if (rows.length === 0) return { considered: 0, notified: 0, failed: 0, suppressed: 0 };

  let notified = 0;
  let failed = 0;
  let suppressed = 0;
  for (const { request: row, notifyExpiring } of rows) {
    const optedOutPerRequest = row.expiringReminderOptedOutAt != null;
    const optedOutGlobally = notifyExpiring === false;
    if (optedOutPerRequest || optedOutGlobally) {
      suppressed++;
      // Stamp both dedup columns so neither cron re-evaluates this row.
      await db.update(memberDataRequestsTable)
        .set({ expiryNotifiedAt: new Date(), expiringNoticeSentAt: new Date() })
        .where(eq(memberDataRequestsTable.id, row.id));
      continue;
    }
    try {
      await notifyDataRequest({
        organizationId: row.organizationId,
        request: row,
        kind: "export_expiring",
        logContext: { job: "sendDataExportPurgeReminders" },
      });
      // Stamp both dedup columns so neither this cron nor the Task #922
      // sibling re-nudges the same row on a subsequent pass.
      await db.update(memberDataRequestsTable)
        .set({ expiryNotifiedAt: new Date(), expiringNoticeSentAt: new Date() })
        .where(eq(memberDataRequestsTable.id, row.id));
      notified++;
    } catch (err) {
      failed++;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), requestId: row.id },
        "[cron] sendDataExportPurgeReminders: notifyDataRequest failed",
      );
    }
  }

  if (notified > 0 || failed > 0 || suppressed > 0) {
    logger.info(
      { considered: rows.length, notified, failed, suppressed },
      "[cron] sendDataExportPurgeReminders complete",
    );
  }
  return { considered: rows.length, notified, failed, suppressed };
}

// ─── Account-deletion erasure worker (Task #467) ─────────────────────────────
// Self-serve account deletions are filed as `erasure` rows in
// member_data_requests with `dueBy = requestedAt + ACCOUNT_DELETION_GRACE_DAYS`.
// Inside the grace window members can cancel; once `dueBy <= now()` and the row
// is still open (status ∉ {completed, rejected}) we permanently anonymise the
// member's PII, mark the request `completed`, and write an audit row so the
// controller's "Privacy" overdue counter drops back to zero without manual work.
//
// Scope of erasure is intentionally narrow and reversible-from-FK-perspective:
//   • clubMembersTable — name, email, phone, dateOfBirth, ghin, memberNumber
//     are scrubbed; subscriptionStatus is set to "expired" and showInDirectory
//     to false so the row vanishes from rosters.
//   • appUsersTable (only if linked) — displayName, email, profileImage,
//     publicHandle/profile fields, and any auth tokens/passwordHash are
//     cleared so the account can no longer be used to sign in or surface
//     publicly. We deliberately keep app_users.id + replit_user_id so
//     historical FK relations (scores, audit rows, payments) stay intact —
//     this matches "anonymise" rather than "hard-delete the user record".
const ACCOUNT_ERASURE_POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const ACCOUNT_ERASURE_DEFAULT_BATCH_SIZE = 100;
// Hard ceiling on iterations to guard against pathological loop conditions
// (a row that consistently fails to transition out of the open queue).
const ACCOUNT_ERASURE_MAX_BATCHES = 1000;

// ─── Task #973 — pending object-storage deletion retry queue ─────────────────
// Wait this long after the original erasure before the first retry, so a
// transient backend hiccup gets a moment to recover before we hammer it.
const PENDING_STORAGE_INITIAL_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes
// Cap on the per-row backoff. Once a row hits the cap it is retried at this
// interval indefinitely — orphan files are PII and we never give up.
const PENDING_STORAGE_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000; // 24h
// How often the worker wakes up and drains due rows. Picked to match the
// initial backoff so a 5-min-old failure is acted on promptly.
const PENDING_STORAGE_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
// Per-tick batch cap — keeps a large backlog from monopolising the worker.
const PENDING_STORAGE_DEFAULT_BATCH_SIZE = 200;
// `attempts >= this` is what `/erasures/storage-failures` reports as
// "exhausted" so admins can investigate a row that's been stuck on the
// 24h cap for many cycles.
export const PENDING_STORAGE_EXHAUSTED_AFTER_ATTEMPTS = 10;

/** Backoff for the (attempts+1)th retry, capped at the per-row maximum. */
function pendingStorageBackoffMs(attempts: number): number {
  const exp = Math.min(2 ** attempts, PENDING_STORAGE_MAX_BACKOFF_MS / PENDING_STORAGE_INITIAL_BACKOFF_MS);
  return Math.min(PENDING_STORAGE_INITIAL_BACKOFF_MS * exp, PENDING_STORAGE_MAX_BACKOFF_MS);
}

// ─── Task #616 — purge member-owned media on account erasure ─────────────────
// When a member's account is permanently erased we must also remove the
// personal media they uploaded (tournament/league photos, swing videos and
// coach-annotation voiceovers, server-rendered highlight reels, KYC document
// scans, and feed-post photos), plus the underlying object-storage files.
//
// Anything that is intentionally retained — tournament leaderboard rows,
// score history, paid coach review-request transactions where the swing
// video is escrowed against a payout — is documented in the retention
// policy section of `replit.md`.
interface EraseMemberMediaResult {
  /** Per-table count of rows deleted by the purge. */
  tablesTouched: Record<string, number>;
  /** Total rows touched across all tables (sum of tablesTouched values). */
  totalRowsAffected: number;
  /** Object-storage files successfully removed. */
  storageFilesDeleted: number;
  /** Object-storage files that did not exist (already gone). */
  storageFilesMissing: number;
  /** Object-storage files we could not remove (transient backend error). */
  storageFilesFailed: number;
  /** Paths of every object-storage file we could not remove. Captured so
   *  controllers can re-run the cleanup later (Task #921) without having
   *  to re-derive the path list from rows that no longer exist. */
  storageFilesFailedPaths: string[];
  /** True when object storage is not configured in this environment
   *  (e.g. integration tests) — DB rows are still removed. */
  storageDisabled: boolean;
}

async function eraseMemberUploadedMedia(opts: {
  userId: number | null;
  clubMemberId: number;
  profileImage: string | null;
}): Promise<EraseMemberMediaResult> {
  const { userId, clubMemberId, profileImage } = opts;
  const tablesTouched: Record<string, number> = {};
  const filesToDelete = new Set<string>();
  if (profileImage) filesToDelete.add(profileImage);

  if (userId !== null) {
    // mediaTable — tournament/league/course photos & videos uploaded by
    // the member. We delete the rows; chat_messages.media_id is set null
    // by the FK so chat history degrades gracefully.
    const mediaRows = await db.select({
      id: mediaTable.id,
      objectPath: mediaTable.objectPath,
      thumbnailPath: mediaTable.thumbnailPath,
    }).from(mediaTable).where(eq(mediaTable.uploadedByUserId, userId));
    for (const r of mediaRows) {
      if (r.objectPath) filesToDelete.add(r.objectPath);
      if (r.thumbnailPath) filesToDelete.add(r.thumbnailPath);
    }
    if (mediaRows.length > 0) {
      await db.delete(mediaTable).where(eq(mediaTable.uploadedByUserId, userId));
      tablesTouched.media = mediaRows.length;
    }

    // Server-rendered highlight reels owned by the member.
    const reelRows = await db.select({
      id: highlightReelsTable.id,
      outputObjectPath: highlightReelsTable.outputObjectPath,
      thumbnailPath: highlightReelsTable.thumbnailPath,
    }).from(highlightReelsTable).where(eq(highlightReelsTable.userId, userId));
    for (const r of reelRows) {
      if (r.outputObjectPath) filesToDelete.add(r.outputObjectPath);
      if (r.thumbnailPath) filesToDelete.add(r.thumbnailPath);
    }
    if (reelRows.length > 0) {
      await db.delete(highlightReelsTable).where(eq(highlightReelsTable.userId, userId));
      tablesTouched.highlight_reels = reelRows.length;
    }

    // Swing annotations authored by the member — voice-over audio is the
    // personal-media payload; the rest is metadata.
    const annotRows = await db.select({
      id: swingAnnotationsTable.id,
      voiceOverUrl: swingAnnotationsTable.voiceOverUrl,
    }).from(swingAnnotationsTable).where(eq(swingAnnotationsTable.authorUserId, userId));
    for (const r of annotRows) {
      if (r.voiceOverUrl) filesToDelete.add(r.voiceOverUrl);
    }
    if (annotRows.length > 0) {
      await db.delete(swingAnnotationsTable).where(eq(swingAnnotationsTable.authorUserId, userId));
      tablesTouched.swing_annotations = annotRows.length;
    }

    // Side-by-side comparisons own no media themselves but the rows are
    // personal data — drop them so they don't dangle past erasure.
    const compsDeleted = await db.delete(swingComparisonsTable)
      .where(eq(swingComparisonsTable.userId, userId))
      .returning({ id: swingComparisonsTable.id });
    if (compsDeleted.length > 0) tablesTouched.swing_comparisons = compsDeleted.length;

    // Swing videos (videoUrl + thumbnailUrl). Videos referenced by an
    // active swing_review_request row are kept (FK is `restrict`) because
    // those rows back paid coach payouts; the storage file is still
    // deleted to honour the erasure request, leaving an empty shell row
    // tied to the financial record.
    const swingRows = await db.select({
      id: swingVideosTable.id,
      videoUrl: swingVideosTable.videoUrl,
      thumbnailUrl: swingVideosTable.thumbnailUrl,
      reviewCount: sql<number>`(SELECT COUNT(*)::int FROM swing_review_requests srr WHERE srr.swing_video_id = ${swingVideosTable.id})`,
    }).from(swingVideosTable).where(eq(swingVideosTable.userId, userId));
    let swingDeletedCount = 0;
    for (const r of swingRows) {
      if (r.videoUrl) filesToDelete.add(r.videoUrl);
      if (r.thumbnailUrl) filesToDelete.add(r.thumbnailUrl);
      if (Number(r.reviewCount ?? 0) === 0) {
        await db.delete(swingVideosTable).where(eq(swingVideosTable.id, r.id));
        swingDeletedCount++;
      }
    }
    if (swingRows.length > 0) tablesTouched.swing_videos = swingDeletedCount;

    // Feed-post media for posts the member authored. We delete the media
    // rows + storage files but leave the post itself (other members may
    // have replied/reacted; the post author FK is set null elsewhere).
    const fpAuthored = await db.select({ id: feedPostsTable.id })
      .from(feedPostsTable).where(eq(feedPostsTable.authorUserId, userId));
    const fpIds = fpAuthored.map(r => r.id);
    if (fpIds.length > 0) {
      const fpmRows = await db.select({
        id: feedPostMediaTable.id,
        url: feedPostMediaTable.url,
      }).from(feedPostMediaTable).where(inArray(feedPostMediaTable.postId, fpIds));
      for (const r of fpmRows) {
        if (r.url) filesToDelete.add(r.url);
      }
      if (fpmRows.length > 0) {
        await db.delete(feedPostMediaTable).where(inArray(feedPostMediaTable.postId, fpIds));
        tablesTouched.feed_post_media = fpmRows.length;
      }
    }
  }

  // Member documents (KYC scans, ID proofs, photo uploads) — keyed by
  // clubMemberId. Both the live row and the version history (replaced
  // files) are purged so old PII can't be restored from history.
  const docVersionRows = await db.select({
    id: memberDocumentVersionsTable.id,
    fileUrl: memberDocumentVersionsTable.fileUrl,
  }).from(memberDocumentVersionsTable).where(eq(memberDocumentVersionsTable.clubMemberId, clubMemberId));
  for (const r of docVersionRows) {
    if (r.fileUrl) filesToDelete.add(r.fileUrl);
  }
  if (docVersionRows.length > 0) {
    await db.delete(memberDocumentVersionsTable).where(eq(memberDocumentVersionsTable.clubMemberId, clubMemberId));
    tablesTouched.member_document_versions = docVersionRows.length;
  }

  const docRows = await db.select({
    id: memberDocumentsTable.id,
    fileUrl: memberDocumentsTable.fileUrl,
  }).from(memberDocumentsTable).where(eq(memberDocumentsTable.clubMemberId, clubMemberId));
  for (const r of docRows) {
    if (r.fileUrl) filesToDelete.add(r.fileUrl);
  }
  if (docRows.length > 0) {
    await db.delete(memberDocumentsTable).where(eq(memberDocumentsTable.clubMemberId, clubMemberId));
    tablesTouched.member_documents = docRows.length;
  }

  // Object-storage cleanup. We instantiate the service lazily so that
  // environments without object-storage configured (integration tests,
  // local boxes without the bucket env vars) still purge the DB rows
  // and surface that the file step was skipped via `storageDisabled`.
  let storageFilesDeleted = 0;
  let storageFilesMissing = 0;
  let storageFilesFailed = 0;
  const storageFilesFailedPaths: string[] = [];
  let storageDisabled = false;
  let storage: ObjectStorageService | null = null;
  try {
    storage = new ObjectStorageService();
    // Touch the private object dir to confirm env config is present.
    storage.getPrivateObjectDir();
  } catch (err) {
    storageDisabled = true;
    if (filesToDelete.size > 0) {
      logger.warn(
        { err, files: filesToDelete.size, clubMemberId },
        "[cron] account erasure: object storage unavailable, skipping file cleanup",
      );
    }
  }

  if (storage && !storageDisabled) {
    for (const path of filesToDelete) {
      try {
        const result = await storage.deleteObjectByPath(path);
        if (result === "deleted") storageFilesDeleted++;
        else if (result === "missing") storageFilesMissing++;
      } catch (err) {
        storageFilesFailed++;
        storageFilesFailedPaths.push(path);
        logger.warn(
          { err, path, clubMemberId },
          "[cron] account erasure: failed to delete object-storage file",
        );
      }
    }
  }

  const totalRowsAffected = Object.values(tablesTouched).reduce((a, b) => a + b, 0);
  return {
    tablesTouched,
    totalRowsAffected,
    storageFilesDeleted,
    storageFilesMissing,
    storageFilesFailed,
    storageFilesFailedPaths,
    storageDisabled,
  };
}

/**
 * Task #921 — controller-initiated re-run of the object-storage cleanup for a
 * single member's most-recent erasure. The original cron pass records the list
 * of paths that failed in `member_audit_log.metadata.objectStorageFilesFailedPaths`
 * (Task #776 stored the counter; we now also store the paths so a retry has
 * something to act on). This helper:
 *
 *  1. Looks up the latest erasure audit row for the member.
 *  2. Re-attempts each previously-failed path against object storage.
 *  3. Writes a new audit row capturing the retry outcome so the per-member
 *     "Erasure history" card and the org-wide warning surface naturally
 *     update without a custom write path.
 *
 * Returns the per-path outcome plus the audit ids consulted/written so the
 * HTTP layer can return a structured response and the test suite can lock
 * the contract in.
 */
export interface RetryErasureStorageResult {
  /** The audit row whose failed paths we re-attempted. Null when there is
   *  no prior erasure on file (caller should 404). */
  sourceAuditId: number | null;
  /** Paths attempted in this retry. */
  attempted: number;
  /** Paths now confirmed deleted from object storage. */
  deleted: number;
  /** Paths that no longer exist (eventual-consistency catch-up). */
  missing: number;
  /** Paths that still failed — the surfaced warning will persist. */
  failed: number;
  /** Paths that still failed (carried forward into the new audit row). */
  failedPaths: string[];
  /** True when object storage is unavailable in this env (DB-only). */
  storageDisabled: boolean;
  /** New audit row id capturing the retry outcome (null when nothing to do). */
  retryAuditId: number | null;
}

export async function retryFailedObjectStoragePurgeForMember(opts: {
  organizationId: number;
  clubMemberId: number;
  actorUserId?: number | null;
  actorName?: string | null;
  /** Distinguishes who triggered the retry — controllers click the dashboard
   *  button (default), while the bounded auto-retry cron passes "cron_retry"
   *  so the dashboard / CSV export can tell the two apart (Task #1079). */
  source?: "controller_retry" | "cron_retry";
}): Promise<RetryErasureStorageResult> {
  const { organizationId, clubMemberId } = opts;
  const source = opts.source ?? "controller_retry";
  const isCron = source === "cron_retry";
  const [latest] = await db.select({
    id: memberAuditLogTable.id,
    metadata: memberAuditLogTable.metadata,
  }).from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.organizationId, organizationId),
      eq(memberAuditLogTable.clubMemberId, clubMemberId),
      eq(memberAuditLogTable.entity, "club_member"),
      eq(memberAuditLogTable.action, "delete"),
    ))
    .orderBy(sql`${memberAuditLogTable.createdAt} DESC`, sql`${memberAuditLogTable.id} DESC`)
    .limit(1);

  if (!latest) {
    return {
      sourceAuditId: null, attempted: 0, deleted: 0, missing: 0, failed: 0,
      failedPaths: [], storageDisabled: false, retryAuditId: null,
    };
  }

  const md = (latest.metadata ?? {}) as Record<string, unknown>;
  const rawPaths = Array.isArray(md.objectStorageFilesFailedPaths)
    ? (md.objectStorageFilesFailedPaths as unknown[]).filter((p): p is string => typeof p === "string" && p.length > 0)
    : [];

  if (rawPaths.length === 0) {
    return {
      sourceAuditId: latest.id, attempted: 0, deleted: 0, missing: 0, failed: 0,
      failedPaths: [], storageDisabled: false, retryAuditId: null,
    };
  }

  let storage: ObjectStorageService | null = null;
  let storageDisabled = false;
  try {
    storage = new ObjectStorageService();
    storage.getPrivateObjectDir();
  } catch {
    storageDisabled = true;
  }

  let deleted = 0;
  let missing = 0;
  let failed = 0;
  const failedPaths: string[] = [];

  if (storage && !storageDisabled) {
    for (const path of rawPaths) {
      try {
        const r = await storage.deleteObjectByPath(path);
        if (r === "deleted") deleted++;
        else if (r === "missing") missing++;
        // Task #973 — controller fixed the orphan, so the auto-retry queue
        // shouldn't keep re-attempting it. Drop any matching pending rows.
        await db.delete(pendingStorageDeletionsTable).where(and(
          eq(pendingStorageDeletionsTable.organizationId, organizationId),
          eq(pendingStorageDeletionsTable.path, path),
        ));
      } catch (err) {
        failed++;
        failedPaths.push(path);
        logger.warn(
          { err, path, clubMemberId },
          "[member-360] retry of object-storage cleanup failed",
        );
      }
    }
  } else {
    // Storage backend is not configured — keep the failed paths so a future
    // retry in a properly-configured env still has them to chew on.
    failed = rawPaths.length;
    failedPaths.push(...rawPaths);
  }

  const [retryRow] = await db.insert(memberAuditLogTable).values({
    organizationId,
    clubMemberId,
    entity: "club_member",
    entityId: clubMemberId,
    action: "delete",
    actorUserId: opts.actorUserId ?? null,
    actorName: opts.actorName ?? (isCron ? "system (cron auto-retry)" : "controller"),
    reason: isCron
      ? "auto-erasure storage cleanup re-run (cron auto-retry)"
      : "auto-erasure storage cleanup re-run (controller-initiated)",
    metadata: {
      source,
      autoErasure: true,
      // Keep the data-request linkage so the per-member history rows still
      // group together by the original request id.
      dataRequestId: typeof md.dataRequestId === "number" ? md.dataRequestId : null,
      // Carry forward the cron's structural fields so the per-member CSV
      // export still has uniform columns. Row counts are zero — nothing
      // is being scrubbed in a retry, only storage is being cleaned up.
      playerRowsScrubbed: 0,
      mediaRowsScrubbed: 0,
      mediaTablesPurged: {},
      objectStorageFilesDeleted: deleted,
      objectStorageFilesMissing: missing,
      objectStorageFilesFailed: failed,
      objectStorageFilesFailedPaths: failedPaths,
      objectStorageDisabled: storageDisabled,
      retryOfAuditId: latest.id,
    },
  }).returning({ id: memberAuditLogTable.id });

  return {
    sourceAuditId: latest.id,
    attempted: rawPaths.length,
    deleted, missing, failed, failedPaths, storageDisabled,
    retryAuditId: retryRow?.id ?? null,
  };
}

/**
 * Task #1460 — controller acknowledgement of a stuck-cleanup alert.
 *
 * When the auto-retry cap has been reached (or before the cap if a
 * controller wants to silence the alert proactively), a controller can
 * "Acknowledge" / "Mark reviewed" the row instead of running another
 * pointless storage-purge attempt. This helper writes a new audit row
 * tagged `metadata.source = "controller_acknowledgement"` that:
 *
 *  - Breaks the cron walk-back chain (same effect on the chain as a
 *    controller_retry), resetting the per-member attempt count and
 *    re-arming the cap alert so subsequent cron failures can re-page.
 *  - Carries the prior latest attempt's failed-paths metadata forward
 *    so the dashboard / aggregator still surfaces the member as "stuck"
 *    (the underlying orphan files haven't actually moved) and so the
 *    next cron retry has paths to act on if the controller later wants
 *    automation to keep trying.
 *  - Does NOT touch object storage. The whole point of the action is
 *    that the controller has already investigated and chosen to leave
 *    the files in place (e.g. legal hold).
 *  - Records the controller's identity and an optional free-text note
 *    in the audit row so the regulator-facing history can show who
 *    acknowledged it and why.
 *
 * Returns the prior `sourceAuditId` (so the caller can 404 cleanly when
 * there is no prior erasure on file) and the new `acknowledgementAuditId`.
 */
export interface AcknowledgeStuckErasureResult {
  /** The latest erasure audit row whose state was being acknowledged.
   *  Null when there is no prior erasure on file (caller should 404). */
  sourceAuditId: number | null;
  /** Carried-forward count of object-storage files still failing — useful
   *  for the response body so the UI can show "you acknowledged N stuck
   *  files" without a refetch. Zero when the latest row reported no
   *  failures, in which case the action is a no-op apart from the audit
   *  trail entry. */
  filesFailed: number;
  /** Id of the new acknowledgement audit row (null when no prior erasure). */
  acknowledgementAuditId: number | null;
}

export async function acknowledgeStuckErasureForMember(opts: {
  organizationId: number;
  clubMemberId: number;
  actorUserId?: number | null;
  actorName?: string | null;
  /** Optional free-text reason captured alongside the audit row. */
  note?: string | null;
}): Promise<AcknowledgeStuckErasureResult> {
  const { organizationId, clubMemberId } = opts;
  const note = (opts.note ?? "").trim() || null;

  const [latest] = await db.select({
    id: memberAuditLogTable.id,
    metadata: memberAuditLogTable.metadata,
  }).from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.organizationId, organizationId),
      eq(memberAuditLogTable.clubMemberId, clubMemberId),
      eq(memberAuditLogTable.entity, "club_member"),
      eq(memberAuditLogTable.action, "delete"),
    ))
    .orderBy(sql`${memberAuditLogTable.createdAt} DESC`, sql`${memberAuditLogTable.id} DESC`)
    .limit(1);

  if (!latest) {
    return { sourceAuditId: null, filesFailed: 0, acknowledgementAuditId: null };
  }

  const md = (latest.metadata ?? {}) as Record<string, unknown>;
  const failedCount = typeof md.objectStorageFilesFailed === "number"
    ? md.objectStorageFilesFailed
    : Number(md.objectStorageFilesFailed ?? 0);
  const failedPaths = Array.isArray(md.objectStorageFilesFailedPaths)
    ? (md.objectStorageFilesFailedPaths as unknown[]).filter(
        (p): p is string => typeof p === "string" && p.length > 0,
      )
    : [];

  const reason = note
    ? `auto-erasure storage cleanup acknowledged by controller — ${note}`
    : "auto-erasure storage cleanup acknowledged by controller";

  const [ackRow] = await db.insert(memberAuditLogTable).values({
    organizationId,
    clubMemberId,
    entity: "club_member",
    entityId: clubMemberId,
    action: "delete",
    actorUserId: opts.actorUserId ?? null,
    actorName: opts.actorName ?? "controller",
    reason,
    metadata: {
      source: CONTROLLER_ACKNOWLEDGEMENT_SOURCE,
      autoErasure: true,
      // Preserve the data-request linkage so per-member history rows
      // group together by the original request id.
      dataRequestId: typeof md.dataRequestId === "number" ? md.dataRequestId : null,
      // No purge attempted — counters are zero by definition. The carried-
      // forward "failed" counter / paths reflect the state we acknowledged
      // (so the dashboard keeps surfacing the member, and the next cron
      // retry has paths to act on once the chain is reset).
      playerRowsScrubbed: 0,
      mediaRowsScrubbed: 0,
      mediaTablesPurged: {},
      objectStorageFilesDeleted: 0,
      objectStorageFilesMissing: 0,
      objectStorageFilesFailed: failedCount,
      objectStorageFilesFailedPaths: failedPaths,
      objectStorageDisabled: false,
      acknowledgedAuditId: latest.id,
      acknowledgementNote: note,
    },
  }).returning({ id: memberAuditLogTable.id });

  return {
    sourceAuditId: latest.id,
    filesFailed: failedCount,
    acknowledgementAuditId: ackRow?.id ?? null,
  };
}

// ─── Task #1079 — bounded auto-retry for stuck erasure storage cleanups ──────
// The /erasures/storage-failures dashboard surfaces members whose latest
// erasure left bucket files behind. Most failures are transient provider
// blips, so we re-run the per-member retry helper on a bounded schedule
// (5 attempts spaced exponentially over ~24h) before giving up and waiting
// for a controller. After the cap is reached the member stays on the
// dashboard until a controller acts manually — at which point the manual
// retry resets the cron-attempt count (the loop below stops walking back
// when it hits a non-`cron_retry` row).
// Exported so the dashboard aggregator (member-360.ts) can mirror the same
// cap when it walks the audit chain to flag "auto-retry exhausted" rows.
// Keeping this as the single source of truth means raising the cap in the
// future automatically updates the badge threshold too.
export const ERASURE_AUTO_RETRY_MAX_ATTEMPTS = 5;
const ERASURE_AUTO_RETRY_POLL_INTERVAL_MS = 60 * 60 * 1000; // hourly
// Delay between consecutive cron-driven retries. Index n = the wait *before*
// the (n+1)th attempt, measured from the latest erasure / retry audit row.
// Cumulative budget ≈ 24 hours, matching the task brief.
const ERASURE_AUTO_RETRY_BACKOFF_MS: readonly number[] = [
  60 * 60 * 1000,        // attempt 1: 1h after the original failure
  2 * 60 * 60 * 1000,    // attempt 2: 2h after attempt 1
  4 * 60 * 60 * 1000,    // attempt 3: 4h after attempt 2
  8 * 60 * 60 * 1000,    // attempt 4: 8h after attempt 3
  9 * 60 * 60 * 1000,    // attempt 5: 9h after attempt 4 (~24h total)
];

export interface RunStuckErasureAutoRetryPassResult {
  /** Members whose latest erasure still has unresolved object-storage files. */
  candidates: number;
  /** Members whose retry helper was invoked this pass. */
  retried: number;
  /** Members skipped because their next backoff window has not elapsed. */
  deferred: number;
  /** Members skipped because the per-member attempt cap is reached. */
  capped: number;
  /** Members whose retry helper threw (counted but logged, never rethrown). */
  failed: number;
  /**
   * Members for whom controllers were freshly alerted this pass because the
   * cron auto-retry chain just reached the per-member attempt cap. Counted
   * separately from `capped` because subsequent passes (the cap stays
   * reached until a controller acts) increment `capped` again but must
   * not re-page controllers. Task #1244.
   */
  cappedNotified: number;
}

/**
 * Marker placed in `metadata.source` on the synthetic audit row written
 * after the cron has alerted controllers that the per-member auto-retry
 * cap is reached. The walk-back loop in `runStuckErasureAutoRetryPass`
 * treats this row as transparent (skips it without breaking the chain or
 * counting it as a retry attempt) so a successive cron tick still sees
 * the same `cron_retry` count and knows the alert has already gone out.
 * Task #1244.
 *
 * Exported (Task #1459) so the dashboard aggregator in member-360.ts
 * can match the same string when it walks the chain to derive the
 * "auto-retry exhausted" badge — keeping a single source of truth and
 * avoiding magic-string drift between the cron and the read-side.
 */
export const CRON_CAPPED_NOTIFICATION_SOURCE = "cron_capped_notification";

/**
 * Task #1460 — marker placed in `metadata.source` when a controller
 * acknowledges a stuck cleanup without re-attempting the storage delete.
 * The walk-back loop in `runStuckErasureAutoRetryPass` already breaks the
 * chain on any source that isn't `cron_retry` or the cap-notification
 * marker, so an acknowledgement row naturally resets the cron-attempt
 * budget AND re-arms the cap alert (the same effect a controller_retry
 * has) — but without performing a pointless storage purge attempt for
 * orphans the controller has chosen to keep (e.g. legal hold).
 */
export const CONTROLLER_ACKNOWLEDGEMENT_SOURCE = "controller_acknowledgement";

/**
 * Task #1244 — fan out the "your auto-retry just gave up on this member"
 * alert to every controller (org_admin direct OR org_admin /
 * membership_secretary / treasurer via org_memberships) for the org. Push
 * lands first (drives controllers straight to the per-member dashboard),
 * each controller also gets an individual focused email.
 *
 * Exported so the integration suite can lock in the contract without
 * scraping mailer / push side effects through the cron entry point.
 */
export async function notifyControllersOfCappedErasure(opts: {
  organizationId: number;
  clubMemberId: number;
  attempts: number;
  filesFailed: number;
  failedPaths: string[];
}): Promise<{ pushRecipients: number; emailRecipients: number }> {
  const { organizationId, clubMemberId, attempts, filesFailed, failedPaths } = opts;

  const [org] = await db
    .select({
      name: organizationsTable.name,
      logoUrl: organizationsTable.logoUrl,
      primaryColor: organizationsTable.primaryColor,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, organizationId));

  // Pull the member name so the alert body / push payload is human-friendly.
  // The row may already be hard-deleted (cascading erasure scrubbed it) — fall
  // back to a stable "Member #<id>" label so the controller still has the
  // anchor they need to find the row in audit history.
  const [member] = await db
    .select({
      firstName: clubMembersTable.firstName,
      lastName: clubMembersTable.lastName,
      memberNumber: clubMembersTable.memberNumber,
    })
    .from(clubMembersTable)
    .where(eq(clubMembersTable.id, clubMemberId));
  const nameParts = member
    ? [member.firstName, member.lastName].filter(Boolean).join(" ").trim()
    : "";
  const memberLabel = nameParts || `Member #${clubMemberId}`;

  // Recipients mirror the daily digest (`sendErasureStorageDigestForOrg`):
  // direct org_admin app_users plus org_memberships entries holding any of
  // the controller-equivalent roles. De-duped on userId so an admin granted
  // both surfaces only gets a single push and a single email.
  const directAdmins = await db
    .select({ userId: appUsersTable.id, email: appUsersTable.email, displayName: appUsersTable.displayName, username: appUsersTable.username })
    .from(appUsersTable)
    .where(and(eq(appUsersTable.organizationId, organizationId), eq(appUsersTable.role, "org_admin")));
  const memberAdmins = await db
    .select({ userId: appUsersTable.id, email: appUsersTable.email, displayName: appUsersTable.displayName, username: appUsersTable.username })
    .from(orgMembershipsTable)
    .innerJoin(appUsersTable, eq(orgMembershipsTable.userId, appUsersTable.id))
    .where(and(
      eq(orgMembershipsTable.organizationId, organizationId),
      inArray(orgMembershipsTable.role, ["org_admin", "membership_secretary", "treasurer"]),
    ));
  const seen = new Set<number>();
  const recipients = [...directAdmins, ...memberAdmins].filter(a => {
    if (seen.has(a.userId)) return false;
    seen.add(a.userId);
    return true;
  });

  let pushRecipients = 0;
  const userIds = recipients.map(r => r.userId);
  if (userIds.length > 0) {
    try {
      await sendTransactionalPush(
        userIds,
        "Erasure cleanup stuck — manual action needed",
        `Auto-retry gave up after ${attempts} attempts on ${memberLabel}. Open the member's privacy panel to investigate and re-run cleanup.`,
        {
          type: "erasure_auto_retry_capped",
          organizationId,
          clubMemberId,
          // Deep link the push payload at the same per-member 360 panel
          // the email links to, so tapping the notification jumps straight
          // to the row that needs manual cleanup.
          route: `/members/${clubMemberId}?panel=erasure-history`,
        },
      );
      pushRecipients = userIds.length;
    } catch (err) {
      logger.warn(
        { err, organizationId, clubMemberId },
        "[cron] erasure auto-retry capped controller push failed",
      );
    }
  }

  const baseUrl = process.env.APP_BASE_URL
    ?? (process.env.PUBLIC_BASE_URL
      ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`);
  const branding = org
    ? {
        orgId: organizationId,
        orgName: org.name,
        logoUrl: org.logoUrl ?? undefined,
        primaryColor: org.primaryColor ?? undefined,
      }
    : undefined;

  let emailRecipients = 0;
  for (const rec of recipients) {
    if (!rec.email) continue;
    try {
      await sendErasureAutoRetryCappedEmail({
        to: rec.email,
        staffName: rec.displayName ?? rec.username ?? "Controller",
        baseUrl,
        clubMemberId,
        memberLabel,
        attempts,
        filesFailed,
        failedPaths,
        branding,
      });
      emailRecipients += 1;
    } catch (err) {
      logger.warn(
        { err, organizationId, clubMemberId, recipient: rec.email },
        "[cron] erasure auto-retry capped controller email failed",
      );
    }
  }

  logger.info(
    { organizationId, clubMemberId, attempts, filesFailed, pushRecipients, emailRecipients },
    "[cron] controllers alerted: erasure auto-retry cap reached",
  );

  return { pushRecipients, emailRecipients };
}

export async function runStuckErasureAutoRetryPass(
  now: Date = new Date(),
): Promise<RunStuckErasureAutoRetryPassResult> {
  const rows = await db.select({
    id: memberAuditLogTable.id,
    organizationId: memberAuditLogTable.organizationId,
    clubMemberId: memberAuditLogTable.clubMemberId,
    createdAt: memberAuditLogTable.createdAt,
    metadata: memberAuditLogTable.metadata,
  }).from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.entity, "club_member"),
      eq(memberAuditLogTable.action, "delete"),
    ))
    .orderBy(
      sql`${memberAuditLogTable.organizationId} ASC`,
      sql`${memberAuditLogTable.clubMemberId} ASC`,
      sql`${memberAuditLogTable.createdAt} DESC`,
      sql`${memberAuditLogTable.id} DESC`,
    );

  type Row = typeof rows[number];
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.organizationId == null || r.clubMemberId == null) continue;
    const k = `${r.organizationId}:${r.clubMemberId}`;
    const arr = groups.get(k);
    if (arr) arr.push(r);
    else groups.set(k, [r]);
  }

  let candidates = 0, retried = 0, deferred = 0, capped = 0, failed = 0, cappedNotified = 0;
  for (const groupRows of groups.values()) {
    // The most recent erasure-history row that actually represents an
    // erasure attempt (not a controllers-notified marker). All the
    // failed-counts / failed-paths / next-backoff timing reads come off
    // of this row, never the synthetic notification row — otherwise the
    // notification's zero counters would stop the dashboard / aggregator
    // from surfacing the member.
    const latestAttempt = groupRows.find(r => {
      const m = (r.metadata ?? {}) as Record<string, unknown>;
      return m.source !== CRON_CAPPED_NOTIFICATION_SOURCE;
    });
    if (!latestAttempt) continue;
    const md = (latestAttempt.metadata ?? {}) as Record<string, unknown>;
    // Same filter the dashboard uses — skip non-erasure deletes (manual
    // hard-deletes, etc.) so we don't try to retry storage cleanup that
    // was never part of an account-erasure run.
    if (md.autoErasure !== true && md.mediaTablesPurged == null) continue;
    const failedCount = typeof md.objectStorageFilesFailed === "number"
      ? md.objectStorageFilesFailed
      : Number(md.objectStorageFilesFailed ?? 0);
    if (!(failedCount > 0)) continue;
    const failedPaths = Array.isArray(md.objectStorageFilesFailedPaths)
      ? (md.objectStorageFilesFailedPaths as unknown[]).filter(
          (p): p is string => typeof p === "string" && p.length > 0,
        )
      : [];
    // Without a stored path list there's nothing for the helper to act on
    // (legacy rows from before Task #921 captured paths). Leave for a
    // controller to investigate manually.
    if (failedPaths.length === 0) continue;

    candidates++;

    // Walk back from `latest` counting consecutive cron-driven retries.
    //  - `cron_retry` rows count toward the cap.
    //  - `cron_capped_notification` rows are transparent: skip without
    //    counting and without breaking the chain, but record that an
    //    alert has already gone out for the current chain so we don't
    //    re-notify on every subsequent tick.
    //  - Anything else (the original cron-erasure delete OR a
    //    controller-initiated retry) breaks the chain, so manual
    //    intervention naturally resets the budget AND re-arms the alert.
    let attempts = 0;
    let alreadyNotified = false;
    for (const r of groupRows) {
      const m = (r.metadata ?? {}) as Record<string, unknown>;
      if (m.source === "cron_retry") {
        attempts++;
        continue;
      }
      if (m.source === CRON_CAPPED_NOTIFICATION_SOURCE) {
        alreadyNotified = true;
        continue;
      }
      break;
    }
    if (attempts >= ERASURE_AUTO_RETRY_MAX_ATTEMPTS) {
      capped++;
      // Task #1244 — fire the per-member controller alert exactly once
      // per retry-chain. We claim the alert by writing a synthetic
      // "cron_capped_notification" audit row BEFORE notifying so a
      // crash mid-fanout still flips us off the re-notify path on the
      // next tick.
      //
      // Delivery contract (deliberate tradeoff): this is at-MOST-once,
      // not at-least-once — if the marker insert succeeds but every
      // push/email channel then fails, the alert is permanently
      // suppressed for this retry chain. We accept that risk because
      // the alternative (insert marker after successful fanout) would
      // re-page controllers every cron tick (~hourly) for any transient
      // mailer/push outage, which empirically is the bigger operational
      // hazard. Mitigations:
      //   - per-recipient try/catch in `notifyControllersOfCappedErasure`
      //     ensures one bad address can't take down the whole fanout
      //   - the dashboard widget keeps surfacing the member because the
      //     marker carries the failed-paths metadata forward
      //   - a controller manual retry resets the chain AND re-arms the
      //     alert, so a stuck member never silently drops off
      // If at-least-once delivery is needed in the future, switch to
      // per-channel delivery state (e.g. a `cappedAlertDelivered` flag
      // updated post-send) rather than re-page-on-failure.
      if (!alreadyNotified) {
        try {
          await db.insert(memberAuditLogTable).values({
            organizationId: latestAttempt.organizationId!,
            clubMemberId: latestAttempt.clubMemberId!,
            entity: "club_member",
            entityId: latestAttempt.clubMemberId!,
            action: "delete",
            actorName: "system (cron auto-retry)",
            reason: "auto-retry cap reached — controllers notified",
            metadata: {
              source: CRON_CAPPED_NOTIFICATION_SOURCE,
              autoErasure: true,
              dataRequestId: typeof md.dataRequestId === "number" ? md.dataRequestId : null,
              attempts,
              // Carry forward the failed counters so any read-side that
              // walks the chain after the alert still has the same
              // failed-paths context to render.
              objectStorageFilesFailed: failedCount,
              objectStorageFilesFailedPaths: failedPaths,
            },
          });
          await notifyControllersOfCappedErasure({
            organizationId: latestAttempt.organizationId!,
            clubMemberId: latestAttempt.clubMemberId!,
            attempts,
            filesFailed: failedCount,
            failedPaths,
          });
          cappedNotified++;
        } catch (notifyErr) {
          logger.warn(
            { err: notifyErr, organizationId: latestAttempt.organizationId, clubMemberId: latestAttempt.clubMemberId },
            "[cron] failed to dispatch erasure auto-retry capped controller alert",
          );
        }
      }
      continue;
    }

    const backoff = ERASURE_AUTO_RETRY_BACKOFF_MS[attempts]
      ?? ERASURE_AUTO_RETRY_BACKOFF_MS[ERASURE_AUTO_RETRY_BACKOFF_MS.length - 1];
    const lastTs = latestAttempt.createdAt?.getTime() ?? 0;
    const nextRetryAt = new Date(lastTs + backoff);
    if (now.getTime() < nextRetryAt.getTime()) { deferred++; continue; }

    try {
      // Non-null guarantees: the grouping step above skips rows whose
      // organizationId / clubMemberId is null, so `latestAttempt` always has both.
      await retryFailedObjectStoragePurgeForMember({
        organizationId: latestAttempt.organizationId!,
        clubMemberId: latestAttempt.clubMemberId!,
        actorUserId: null,
        actorName: "system (cron auto-retry)",
        source: "cron_retry",
      });
      retried++;
    } catch (err) {
      failed++;
      logger.warn(
        { err, organizationId: latestAttempt.organizationId, clubMemberId: latestAttempt.clubMemberId },
        "[cron] erasure auto-retry failed for member",
      );
    }
  }

  return { candidates, retried, deferred, capped, failed, cappedNotified };
}

/**
 * Task #971 — purge any outstanding self-serve data-export archives belonging
 * to a member whose account is being erased. Mirrors `purgeExpiredDataExportArchives`
 * (the daily 7-day cron) so the audit-trail row and DB cleanup look identical
 * — only the `metadata.source` differs (`account_erasure` vs `cron`).
 */
async function purgeMemberDataExportArchives(opts: {
  organizationId: number;
  clubMemberId: number;
}): Promise<{ purged: number; failed: number; missing: number; storageDisabled: boolean }> {
  const { organizationId, clubMemberId } = opts;
  const rows = await db
    .select({
      id: memberDataRequestsTable.id,
      artifactUrl: memberDataRequestsTable.artifactUrl,
    })
    .from(memberDataRequestsTable)
    .where(and(
      eq(memberDataRequestsTable.organizationId, organizationId),
      eq(memberDataRequestsTable.requestType, "access"),
      eq(memberDataRequestsTable.clubMemberId, clubMemberId),
      isNotNull(memberDataRequestsTable.artifactUrl),
    ));

  if (rows.length === 0) return { purged: 0, failed: 0, missing: 0, storageDisabled: false };

  let storage: ObjectStorageService | null = null;
  let storageDisabled = false;
  try {
    storage = new ObjectStorageService();
    storage.getPrivateObjectDir();
  } catch (err) {
    storageDisabled = true;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), pendingRows: rows.length, clubMemberId },
      "[cron] account erasure: object storage unavailable, deferring data-export archive cleanup",
    );
  }

  // Storage is unreachable in this environment. We must NOT clear
  // `artifactUrl` or write a "purge" audit row, otherwise the system
  // would record the export as deleted while the actual PII-bearing
  // file is still sitting in object storage. Surface every row as a
  // failure so the next cron pass (or a controller-initiated retry)
  // still has the artifactUrl pointer to act on.
  if (!storage || storageDisabled) {
    return { purged: 0, failed: rows.length, missing: 0, storageDisabled: true };
  }

  let purged = 0;
  let failed = 0;
  let missing = 0;

  for (const row of rows) {
    if (!row.artifactUrl) continue;
    let deleteOk = true;
    let wasMissing = false;

    try {
      const file = await storage.getObjectEntityFile(row.artifactUrl);
      await file.delete();
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        wasMissing = true;
      } else {
        deleteOk = false;
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), requestId: row.id, artifactUrl: row.artifactUrl, clubMemberId },
          "[cron] account erasure: data-export archive delete failed",
        );
      }
    }

    if (!deleteOk) {
      // Don't clear the DB pointer or emit a purge audit row — the file
      // is still in storage. The artifactUrl is preserved so the next
      // cron pass / controller retry can attempt removal again.
      failed++;
      continue;
    }

    try {
      const purgedAt = new Date();
      await db.update(memberDataRequestsTable)
        .set({ artifactUrl: null, purgedAt })
        .where(eq(memberDataRequestsTable.id, row.id));
      purged++;
      if (wasMissing) missing++;

      await recordMemberAudit({
        req: null,
        organizationId,
        clubMemberId,
        entity: "data_export",
        entityId: row.id,
        action: "purge",
        reason: "Auto-deleted data-export archive as part of account erasure.",
        metadata: {
          source: "account_erasure",
          artifactUrl: row.artifactUrl,
          alreadyMissing: wasMissing,
          purgedAt: purgedAt.toISOString(),
        },
      });
    } catch (err) {
      failed++;
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), requestId: row.id, clubMemberId },
        "[cron] account erasure: data-export artifactUrl clear failed",
      );
    }
  }

  return { purged, failed, missing, storageDisabled: false };
}

/**
 * Task #1127 — page org admins when a single orphan-file row first crosses
 * the bounded-retry exhaustion threshold. Caller is responsible for the
 * atomic dedup (claiming `exhaustionNotifiedAt`); this helper just fans
 * out a push notification to admins and emails each admin individually
 * with a deep link back to the storage-failures dashboard.
 *
 * Exported so the integration suite can lock in the contract without
 * having to scrape mailer side effects.
 */
export async function notifyAdminsOfExhaustedStorageDeletion(opts: {
  organizationId: number;
  clubMemberId: number | null;
  path: string;
  attempts: number;
  lastError: string | null;
}): Promise<{ pushRecipients: number; emailRecipients: number }> {
  const { organizationId, clubMemberId, path, attempts, lastError } = opts;

  const [org] = await db
    .select({
      name: organizationsTable.name,
      logoUrl: organizationsTable.logoUrl,
      primaryColor: organizationsTable.primaryColor,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, organizationId));

  // Recipients are strictly org admins (per task brief). Both the direct
  // app_users.role='org_admin' rows and the org_memberships entries with
  // the matching role are included so an admin granted the role through
  // either surface gets paged.
  const directAdmins = await db
    .select({ userId: appUsersTable.id, email: appUsersTable.email, displayName: appUsersTable.displayName, username: appUsersTable.username })
    .from(appUsersTable)
    .where(and(eq(appUsersTable.organizationId, organizationId), eq(appUsersTable.role, "org_admin")));
  const memberAdmins = await db
    .select({ userId: appUsersTable.id, email: appUsersTable.email, displayName: appUsersTable.displayName, username: appUsersTable.username })
    .from(orgMembershipsTable)
    .innerJoin(appUsersTable, eq(orgMembershipsTable.userId, appUsersTable.id))
    .where(and(
      eq(orgMembershipsTable.organizationId, organizationId),
      eq(orgMembershipsTable.role, "org_admin"),
    ));

  const seen = new Set<number>();
  const recipients = [...directAdmins, ...memberAdmins].filter(a => {
    if (seen.has(a.userId)) return false;
    seen.add(a.userId);
    return true;
  });

  // Push first — fast, free, drives admins to the dashboard immediately.
  const userIds = recipients.map(r => r.userId);
  let pushRecipients = 0;
  if (userIds.length > 0) {
    try {
      await sendTransactionalPush(
        userIds,
        "Orphan file stuck — manual cleanup needed",
        `An object-storage deletion has failed ${attempts} times and exceeded its bounded backoff. Open the storage-failures view to investigate.`,
        {
          type: "erasure_storage_exhausted",
          organizationId,
          path,
          // Deep link the push payload at the same admin view the email
          // links to, so tapping the notification jumps straight to the
          // row that needs manual cleanup.
          route: "/privacy?panel=erasure-storage-failures",
        },
      );
      pushRecipients = userIds.length;
    } catch (err) {
      logger.warn(
        { err, organizationId, path },
        "[cron] exhausted-storage-deletion admin push failed",
      );
    }
  }

  // Email digest entry — each admin gets a focused incident-style email
  // with the offending path and last error so on-call has everything in
  // hand before opening the dashboard.
  const baseUrl = process.env.APP_BASE_URL
    ?? (process.env.PUBLIC_BASE_URL
      ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`);
  const branding = org
    ? { orgName: org.name, logoUrl: org.logoUrl ?? undefined, primaryColor: org.primaryColor ?? undefined }
    : undefined;

  let emailRecipients = 0;
  for (const rec of recipients) {
    if (!rec.email) continue;
    try {
      await sendErasureStorageFailureExhaustedEmail({
        to: rec.email,
        staffName: rec.displayName ?? rec.username ?? "Controller",
        baseUrl,
        orphanPath: path,
        attempts,
        lastError,
        clubMemberId,
        branding,
      });
      emailRecipients += 1;
    } catch (err) {
      logger.warn(
        { err, organizationId, path, recipient: rec.email },
        "[cron] exhausted-storage-deletion admin email failed",
      );
    }
  }

  logger.info(
    { organizationId, clubMemberId, path, attempts, pushRecipients, emailRecipients },
    "[cron] org admins alerted: pending storage deletion exhausted bounded backoff",
  );

  return { pushRecipients, emailRecipients };
}

/**
 * Task #973 — drain the pending object-storage deletion queue. Selects rows
 * whose `next_attempt_at` has elapsed (with a per-tick batch cap), re-attempts
 * each path against object storage, and:
 *   • on `deleted` / `missing` — removes the row (orphan is gone).
 *   • on transient failure — bumps `attempts`, records the error, and
 *     reschedules `next_attempt_at` with exponential backoff capped at 24h.
 *
 * Storage being unavailable in the current process (env vars missing) is
 * treated as a soft skip: rows are left alone so a properly-configured
 * environment can pick them up later.
 */
export async function processPendingStorageDeletions(opts?: {
  batchSize?: number;
  now?: Date;
}): Promise<{
  attempted: number;
  deleted: number;
  missing: number;
  failed: number;
  storageDisabled: boolean;
}> {
  const batchSize = Math.max(1, opts?.batchSize ?? PENDING_STORAGE_DEFAULT_BATCH_SIZE);
  const now = opts?.now ?? new Date();

  let storage: ObjectStorageService | null = null;
  let storageDisabled = false;
  try {
    storage = new ObjectStorageService();
    storage.getPrivateObjectDir();
  } catch {
    storageDisabled = true;
  }
  if (!storage || storageDisabled) {
    return { attempted: 0, deleted: 0, missing: 0, failed: 0, storageDisabled: true };
  }

  const due = await db.select()
    .from(pendingStorageDeletionsTable)
    .where(lte(pendingStorageDeletionsTable.nextAttemptAt, now))
    .orderBy(pendingStorageDeletionsTable.nextAttemptAt)
    .limit(batchSize);

  let deleted = 0;
  let missing = 0;
  let failed = 0;
  for (const row of due) {
    try {
      const r = await storage.deleteObjectByPath(row.path);
      if (r === "deleted" || r === "missing") {
        await db.delete(pendingStorageDeletionsTable)
          .where(eq(pendingStorageDeletionsTable.id, row.id));
        if (r === "deleted") deleted++; else missing++;
        continue;
      }
      // Defensive: unknown result shape — treat as a failure so the row
      // gets re-tried on backoff rather than leaking.
      throw new Error(`unexpected deleteObjectByPath result: ${String(r)}`);
    } catch (err) {
      failed++;
      const nextAttempts = (row.attempts ?? 0) + 1;
      const nextAttemptAt = new Date(now.getTime() + pendingStorageBackoffMs(nextAttempts));
      const errMsg = err instanceof Error ? err.message : String(err);
      const truncatedErr = errMsg.slice(0, 500);
      await db.update(pendingStorageDeletionsTable).set({
        attempts: nextAttempts,
        lastAttemptAt: now,
        lastError: truncatedErr,
        nextAttemptAt,
      }).where(eq(pendingStorageDeletionsTable.id, row.id));
      logger.warn(
        { err, path: row.path, clubMemberId: row.clubMemberId, attempts: nextAttempts },
        "[cron] pending object-storage deletion still failing — rescheduled with backoff",
      );

      // Task #1127 — fire the org-admin alert exactly when this row first
      // crosses the bounded-retry exhaustion threshold. The conditional
      // claim on `exhaustionNotifiedAt IS NULL` makes the stamp atomic so
      // two concurrent worker ticks can't both win, and the row-level
      // dedup means subsequent retry ticks (the row stays in the queue
      // forever once exhausted) don't re-page admins.
      const previousAttempts = row.attempts ?? 0;
      if (
        nextAttempts >= PENDING_STORAGE_EXHAUSTED_AFTER_ATTEMPTS &&
        previousAttempts < PENDING_STORAGE_EXHAUSTED_AFTER_ATTEMPTS
      ) {
        const claimed = await db.update(pendingStorageDeletionsTable)
          .set({ exhaustionNotifiedAt: now })
          .where(and(
            eq(pendingStorageDeletionsTable.id, row.id),
            isNull(pendingStorageDeletionsTable.exhaustionNotifiedAt),
          ))
          .returning({ id: pendingStorageDeletionsTable.id });
        if (claimed.length > 0) {
          try {
            await notifyAdminsOfExhaustedStorageDeletion({
              organizationId: row.organizationId,
              clubMemberId: row.clubMemberId,
              path: row.path,
              attempts: nextAttempts,
              lastError: truncatedErr,
            });
          } catch (notifyErr) {
            logger.warn(
              { err: notifyErr, path: row.path, organizationId: row.organizationId },
              "[cron] failed to dispatch exhausted-storage-deletion admin alert",
            );
          }
        }
      }
    }
  }

  if (due.length > 0) {
    logger.info(
      { attempted: due.length, deleted, missing, failed },
      "[cron] processPendingStorageDeletions complete",
    );
  }
  return { attempted: due.length, deleted, missing, failed, storageDisabled: false };
}

export async function processOverdueAccountErasures(opts?: {
  batchSize?: number;
}): Promise<{
  processed: number;
  failed: number;
  batches: number;
}> {
  const batchSize = Math.max(1, opts?.batchSize ?? ACCOUNT_ERASURE_DEFAULT_BATCH_SIZE);
  let processed = 0;
  let failed = 0;
  let batches = 0;

  // Drain the overdue queue in successive batches so a backlog larger than
  // `batchSize` is fully cleared in one cron pass — the controller's
  // "Privacy → overdue" counter is expected to drop to zero after one run.
  for (let i = 0; i < ACCOUNT_ERASURE_MAX_BATCHES; i++) {
    const now = new Date();
    const overdue = await db
      .select({
        id: memberDataRequestsTable.id,
        organizationId: memberDataRequestsTable.organizationId,
        clubMemberId: memberDataRequestsTable.clubMemberId,
        requestedAt: memberDataRequestsTable.requestedAt,
        dueBy: memberDataRequestsTable.dueBy,
        notes: memberDataRequestsTable.notes,
      })
      .from(memberDataRequestsTable)
      .where(and(
        eq(memberDataRequestsTable.requestType, "erasure"),
        sql`${memberDataRequestsTable.status} NOT IN ('completed', 'rejected')`,
        isNotNull(memberDataRequestsTable.dueBy),
        lte(memberDataRequestsTable.dueBy, now),
      ))
      .limit(batchSize);
    if (overdue.length === 0) break;
    batches++;
    const batchResult = await processErasureBatch(overdue, now);
    processed += batchResult.processed;
    failed += batchResult.failed;
    // Defensive: if the entire batch failed, abort the loop so a single
    // poison-pill row can't hot-spin the worker indefinitely. The next cron
    // tick will retry; admins can investigate via the audit / log entries.
    if (batchResult.processed === 0 && batchResult.failed > 0) break;
  }

  if (processed > 0 || failed > 0) {
    logger.info({ processed, failed, batches }, "[cron] processOverdueAccountErasures complete");
  }
  return { processed, failed, batches };
}

interface ErasureRow {
  id: number;
  organizationId: number;
  clubMemberId: number;
  requestedAt: Date;
  dueBy: Date | null;
  notes: string | null;
}

async function processErasureBatch(rows: ErasureRow[], now: Date): Promise<{
  processed: number;
  failed: number;
}> {
  let processed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const [member] = await db.select().from(clubMembersTable)
        .where(eq(clubMembersTable.id, row.clubMemberId));
      if (!member) {
        // Underlying member is already gone (e.g. cascaded org delete) —
        // close out the request so it stops blocking the overdue counter.
        await db.update(memberDataRequestsTable).set({
          status: "completed",
          resolvedAt: now,
          notes: (row.notes ? row.notes + "\n" : "")
            + `Auto-erasure (cron): club member already removed at ${now.toISOString()}.`,
        }).where(eq(memberDataRequestsTable.id, row.id));
        await recordMemberAudit({
          req: null,
          organizationId: row.organizationId,
          clubMemberId: row.clubMemberId,
          entity: "data_request",
          entityId: row.id,
          action: "update",
          reason: "auto-erasure (cron) — club member already removed",
          metadata: { source: "cron", autoErasure: true },
        });
        processed++;
        continue;
      }

      // Task #615 — send a final "your account has been permanently deleted"
      // notice using the previously-known contact details BEFORE the PII is
      // scrubbed. Wrapped in try/catch so a notification failure never blocks
      // the regulatory erasure itself; the resend-history popover and audit
      // trail capture the per-channel delivery outcome the same way the
      // manual admin completion path does.
      let notifyResult: NotifyDataRequestResult | null = null;
      try {
        const [fullRequest] = await db
          .select()
          .from(memberDataRequestsTable)
          .where(eq(memberDataRequestsTable.id, row.id));
        if (fullRequest) {
          notifyResult = await notifyDataRequest({
            organizationId: row.organizationId,
            request: fullRequest,
            kind: "completed",
            senderUserId: null,
            logContext: { job: "processOverdueAccountErasures", dataRequestId: row.id },
          });
          await recordMemberAudit({
            req: null,
            organizationId: row.organizationId,
            clubMemberId: row.clubMemberId,
            entity: "data_request_notification",
            entityId: row.id,
            action: "create",
            reason: `auto-erasure completed notice — email:${notifyResult.emailStatus}, in_app:${notifyResult.inAppMessageId ? "sent" : "skipped"}, push:${notifyResult.pushStatus}, sms:${notifyResult.smsStatus}, whatsapp:${notifyResult.whatsappStatus}`,
            metadata: {
              source: "cron",
              autoErasure: true,
              kind: "completed",
              channels: {
                email: { status: notifyResult.emailStatus, error: notifyResult.emailError ?? null },
                inApp: { status: notifyResult.inAppMessageId ? "sent" : "skipped", messageId: notifyResult.inAppMessageId },
                push: { status: notifyResult.pushStatus, error: notifyResult.pushError ?? null },
                sms: { status: notifyResult.smsStatus, error: notifyResult.smsError ?? null },
                whatsapp: { status: notifyResult.whatsappStatus, error: notifyResult.whatsappError ?? null },
              },
            },
          });
        }
      } catch (notifyErr) {
        logger.warn(
          { err: notifyErr, dataRequestId: row.id },
          "[cron] auto-erasure final 'completed' notification failed; continuing with PII scrub",
        );
      }

      const memberBefore = {
        firstName: member.firstName,
        lastName: member.lastName,
        email: member.email,
        phone: member.phone,
        dateOfBirth: member.dateOfBirth,
        whsGhinNumber: member.whsGhinNumber,
        memberNumber: member.memberNumber,
        showInDirectory: member.showInDirectory,
        subscriptionStatus: member.subscriptionStatus,
      };
      const memberAfter = {
        firstName: "Deleted",
        lastName: "Member",
        email: null,
        phone: null,
        dateOfBirth: null,
        whsGhinNumber: null,
        memberNumber: null,
        showInDirectory: false,
        subscriptionStatus: "expired" as const,
      };
      await db.update(clubMembersTable).set({
        ...memberAfter,
        updatedAt: now,
      }).where(eq(clubMembersTable.id, member.id));

      // Scrub PII carried on tournament `players` rows linked to the same
      // user. Score rows themselves are kept (they are part of tournament
      // history and other competitors' records reference them via FK), but
      // the player's identifying fields — name, email, phone, GHIN — are
      // anonymised so the score is no longer attributable to the member.
      let playerRowsScrubbed = 0;
      if (member.userId) {
        const updatedPlayers = await db.update(playersTable).set({
          firstName: "Deleted",
          lastName: "Member",
          email: null,
          phone: null,
          ghinNumber: null,
        }).where(eq(playersTable.userId, member.userId)).returning({ id: playersTable.id });
        playerRowsScrubbed = updatedPlayers.length;
      }

      // Purge member-uploaded media — both the database rows and the
      // underlying object-storage files (Task #616). This honours the
      // GDPR/DPDP "right to erasure" obligation that personal media a member
      // has uploaded must actually be deleted at the end of the grace
      // window, not just detached. The retention policy in `replit.md`
      // enumerates which member tables this covers and which org-level
      // records are intentionally kept (tournament leaderboards, paid
      // coach review transactions, etc.).
      // Capture the existing profileImage so the storage-cleanup pass can
      // also delete the user's avatar file (the column is set to null below
      // when we tombstone the appUsers row).
      let profileImageForCleanup: string | null = null;
      if (member.userId) {
        const [u] = await db.select({ profileImage: appUsersTable.profileImage })
          .from(appUsersTable)
          .where(eq(appUsersTable.id, member.userId));
        profileImageForCleanup = u?.profileImage ?? null;
      }
      const mediaErasure = await eraseMemberUploadedMedia({
        userId: member.userId ?? null,
        clubMemberId: member.id,
        profileImage: profileImageForCleanup,
      });
      // Backwards-compatible field name: row count for `mediaTable` only,
      // matching the existing audit-log contract used by the controller UI.
      const mediaRowsScrubbed = mediaErasure.tablesTouched.media ?? 0;

      // Task #971 — purge any outstanding self-serve data-export archives
      // belonging to the member. The 7-day cron normally handles these, but
      // an account-erasure happening inside that retention window must
      // proactively delete the archive file so the erasure is genuinely
      // "all PII gone" instead of "all PII gone except the export the member
      // happened to request in the last 7 days".
      const exportArchivesPurged = await purgeMemberDataExportArchives({
        organizationId: row.organizationId,
        clubMemberId: member.id,
      });

      let userBefore: Record<string, unknown> | null = null;
      let userAfter: Record<string, unknown> | null = null;
      if (member.userId) {
        const [user] = await db.select().from(appUsersTable)
          .where(eq(appUsersTable.id, member.userId));
        if (user) {
          userBefore = {
            email: user.email,
            displayName: user.displayName,
            profileImage: user.profileImage,
            publicHandle: user.publicHandle,
            publicProfileEnabled: user.publicProfileEnabled,
            publicBio: user.publicBio,
            publicLocation: user.publicLocation,
          };
          userAfter = {
            email: null,
            displayName: "Deleted Member",
            profileImage: null,
            publicHandle: null,
            publicProfileEnabled: false,
            publicBio: null,
            publicLocation: null,
          };
          await db.update(appUsersTable).set({
            email: null,
            displayName: "Deleted Member",
            profileImage: null,
            publicHandle: null,
            publicProfileEnabled: false,
            publicBio: null,
            publicLocation: null,
            passwordHash: null,
            emailVerified: false,
            emailVerificationToken: null,
            emailVerificationExpiry: null,
            passwordResetToken: null,
            passwordResetExpiry: null,
            // Tombstone the user so the OAuth upsert path refuses to
            // re-hydrate PII on a subsequent login (see routes/auth.ts).
            erasedAt: now,
            updatedAt: now,
          }).where(eq(appUsersTable.id, member.userId));
        }
      }

      await db.update(memberDataRequestsTable).set({
        status: "completed",
        resolvedAt: now,
        notes: (row.notes ? row.notes + "\n" : "")
          + `Auto-erasure (cron) at ${now.toISOString()} — grace window (dueBy=${row.dueBy?.toISOString() ?? "n/a"}) elapsed; member PII anonymised.`,
      }).where(eq(memberDataRequestsTable.id, row.id));

      await recordMemberAudit({
        req: null,
        organizationId: row.organizationId,
        clubMemberId: row.clubMemberId,
        entity: "data_request",
        entityId: row.id,
        action: "update",
        reason: "auto-erasure (cron) — grace period elapsed",
        metadata: { source: "cron", autoErasure: true, dueBy: row.dueBy?.toISOString() ?? null },
      });
      await recordMemberAudit({
        req: null,
        organizationId: row.organizationId,
        clubMemberId: row.clubMemberId,
        entity: "club_member",
        entityId: row.clubMemberId,
        action: "delete",
        before: memberBefore,
        after: memberAfter,
        reason: "auto-erasure (cron) — PII anonymised after 30-day grace window",
        metadata: {
          source: "cron",
          autoErasure: true,
          dataRequestId: row.id,
          playerRowsScrubbed,
          mediaRowsScrubbed,
          mediaTablesPurged: mediaErasure.tablesTouched,
          objectStorageFilesDeleted: mediaErasure.storageFilesDeleted,
          objectStorageFilesMissing: mediaErasure.storageFilesMissing,
          objectStorageFilesFailed: mediaErasure.storageFilesFailed,
          objectStorageFilesFailedPaths: mediaErasure.storageFilesFailedPaths,
          objectStorageDisabled: mediaErasure.storageDisabled,
          appUser: userBefore && userAfter ? { before: userBefore, after: userAfter, userId: member.userId } : null,
          dataExportArchivesPurged: exportArchivesPurged.purged,
          dataExportArchivesFailed: exportArchivesPurged.failed,
          dataExportArchivesMissing: exportArchivesPurged.missing,
        },
      });

      // Task #973 — enqueue every still-orphaned bucket file into the
      // pending-deletion retry queue so a transient 5xx / IAM hiccup does
      // not leave PII in the bucket forever. The cron-driven worker
      // (`processPendingStorageDeletions`) drains these on a backoff
      // schedule and removes the row once the file is gone or missing.
      if (mediaErasure.storageFilesFailedPaths.length > 0 && !mediaErasure.storageDisabled) {
        try {
          // Look up the freshly-written audit row id so we can stamp it on
          // each pending row (lets the controller drill back into the
          // erasure that produced the orphan). Best-effort — null on miss.
          const [latestAudit] = await db.select({ id: memberAuditLogTable.id })
            .from(memberAuditLogTable)
            .where(and(
              eq(memberAuditLogTable.organizationId, row.organizationId),
              eq(memberAuditLogTable.clubMemberId, row.clubMemberId),
              eq(memberAuditLogTable.entity, "club_member"),
              eq(memberAuditLogTable.action, "delete"),
            ))
            .orderBy(sql`${memberAuditLogTable.id} DESC`)
            .limit(1);
          await db.insert(pendingStorageDeletionsTable).values(
            mediaErasure.storageFilesFailedPaths.map((path) => ({
              organizationId: row.organizationId,
              clubMemberId: row.clubMemberId,
              sourceAuditId: latestAudit?.id ?? null,
              path,
              attempts: 0,
              // First retry runs after the initial backoff window so we
              // don't hammer a backend that just rejected us.
              nextAttemptAt: new Date(now.getTime() + PENDING_STORAGE_INITIAL_BACKOFF_MS),
            })),
          );
        } catch (enqueueErr) {
          logger.warn(
            { err: enqueueErr, dataRequestId: row.id, paths: mediaErasure.storageFilesFailedPaths.length },
            "[cron] failed to enqueue pending storage deletions (will be retried by next erasure pass)",
          );
        }
      }

      logger.info(
        {
          dataRequestId: row.id,
          clubMemberId: row.clubMemberId,
          organizationId: row.organizationId,
          dueBy: row.dueBy,
          playerRowsScrubbed,
          mediaRowsScrubbed,
          mediaTablesPurged: mediaErasure.tablesTouched,
          objectStorageFilesDeleted: mediaErasure.storageFilesDeleted,
          objectStorageFilesFailed: mediaErasure.storageFilesFailed,
        },
        "[cron] account erasure completed (grace period elapsed)",
      );
      processed++;
    } catch (err) {
      failed++;
      logger.warn({ err, dataRequestId: row.id }, "[cron] account erasure failed for request");
    }
  }

  return { processed, failed };
}

// ─── Privacy notice email/push/SMS retry (Tasks 191, 210) ────────────────────
// Privacy notices are mandatory regulatory comms. notifyDataRequest() records
// per-channel delivery; failed emails / pushes / SMS are retried here on a
// bounded schedule so a transient provider blip doesn't become a regulatory
// gap. Email is the primary channel and gets the same bounded retry treatment
// as push and SMS (Task 210).
const DATA_REQUEST_PUSH_SMS_RETRY_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const DATA_REQUEST_RETRY_BATCH_LIMIT = 50;

/**
 * Task #251 — record an audit row for an automatic (cron-driven) privacy
 * notification retry so the Member 360 resend-history popover can show admins
 * the per-channel timestamp + provider error for system retries, exactly the
 * way it shows them for manual resends today.
 *
 * `metadata.source = "cron"` lets the resend-history endpoint flag the entry
 * as system-initiated; the structured `channels` payload reuses the same
 * shape as manual resends so the UI's existing tooltip code applies as-is.
 */
async function recordCronRetryAudit(opts: {
  request: MemberDataRequest;
  channel: "push" | "sms" | "email" | "whatsapp";
  result: { status: string; error?: string; attempts: number; exhausted: boolean };
}) {
  const { request, channel, result } = opts;
  const at = new Date().toISOString();
  const channelDetail = { status: result.status, at, error: result.error ?? null };
  const channels: Record<string, { status: string; at: string; error: string | null }> = {};
  channels[channel] = channelDetail;
  const kind = (request.lastNotificationKind as string | null) ?? "filed";
  await recordMemberAudit({
    req: null,
    organizationId: request.organizationId,
    clubMemberId: request.clubMemberId,
    entity: "data_request_notification",
    entityId: request.id,
    action: "resend",
    reason: `automatic ${channel} retry — ${channel}:${result.status}${result.exhausted ? " (exhausted)" : ""} attempt:${result.attempts}`,
    metadata: { kind, source: "cron", channels },
  });
}

export async function retryFailedDataRequestPushSms() {
  // Pick rows where email, push, or SMS is currently `failed` and the
  // per-channel attempt cap has not been reached. We deliberately cap per
  // run so a large outage backlog doesn't block other work; the next interval
  // will pick up any remaining rows.
  const candidates = await db
    .select()
    .from(memberDataRequestsTable)
    .where(or(
      and(
        eq(memberDataRequestsTable.lastPushStatus, "failed"),
        lt(memberDataRequestsTable.pushAttempts, DATA_REQUEST_MAX_PUSH_ATTEMPTS),
      ),
      and(
        eq(memberDataRequestsTable.lastSmsStatus, "failed"),
        lt(memberDataRequestsTable.smsAttempts, DATA_REQUEST_MAX_SMS_ATTEMPTS),
      ),
      and(
        eq(memberDataRequestsTable.lastEmailStatus, "failed"),
        lt(memberDataRequestsTable.emailAttempts, DATA_REQUEST_MAX_EMAIL_ATTEMPTS),
      ),
      and(
        eq(memberDataRequestsTable.lastWhatsappStatus, "failed"),
        lt(memberDataRequestsTable.whatsappAttempts, DATA_REQUEST_MAX_WHATSAPP_ATTEMPTS),
      ),
    ))
    .limit(DATA_REQUEST_RETRY_BATCH_LIMIT);

  if (candidates.length === 0) return;

  let pushRetried = 0, pushSent = 0, pushExhausted = 0;
  let smsRetried = 0, smsSent = 0, smsExhausted = 0;
  let emailRetried = 0, emailSent = 0, emailExhausted = 0;
  let whatsappRetried = 0, whatsappSent = 0, whatsappExhausted = 0;

  for (const row of candidates) {
    if (row.lastEmailStatus === "failed" && (row.emailAttempts ?? 0) < DATA_REQUEST_MAX_EMAIL_ATTEMPTS) {
      try {
        const r = await retryDataRequestEmail({ request: row, logContext: { job: "retryFailedDataRequestPushSms" } });
        if (r) {
          emailRetried++;
          if (r.status === "sent") emailSent++;
          try {
            await recordCronRetryAudit({ request: row, channel: "email", result: r });
          } catch (auditErr) {
            logger.warn({ err: auditErr, requestId: row.id }, "[cron] data-request email retry audit threw");
          }
          if (r.exhausted) {
            emailExhausted++;
            // Task 238: proactively alert admins so the failure doesn't sit
            // unnoticed until someone happens to open Member 360. The helper
            // de-duplicates per request via emailExhaustionNotifiedAt.
            try {
              await notifyAdminsOfRetryExhaustion({
                channel: "email",
                request: { ...row, lastEmailError: r.error ?? row.lastEmailError, emailAttempts: r.attempts, lastEmailStatus: r.status, emailRetryExhaustedAt: new Date() },
                logContext: { job: "retryFailedDataRequestPushSms" },
              });
            } catch (notifyErr) {
              logger.warn({ err: notifyErr, requestId: row.id }, "[cron] data-request admin exhaustion notify threw");
            }
          }
        }
      } catch (err) {
        logger.warn({ err, requestId: row.id }, "[cron] data-request email retry threw");
      }
    }
    if (row.lastPushStatus === "failed" && (row.pushAttempts ?? 0) < DATA_REQUEST_MAX_PUSH_ATTEMPTS) {
      try {
        const r = await retryDataRequestPush({ request: row, logContext: { job: "retryFailedDataRequestPushSms" } });
        if (r) {
          pushRetried++;
          if (r.status === "sent") pushSent++;
          try {
            await recordCronRetryAudit({ request: row, channel: "push", result: r });
          } catch (auditErr) {
            logger.warn({ err: auditErr, requestId: row.id }, "[cron] data-request push retry audit threw");
          }
          if (r.exhausted) {
            pushExhausted++;
            // Task 261: parity with the email exhaustion alert — proactively
            // notify admins so they can fall back to another channel before
            // the regulatory deadline. De-dups via pushExhaustionNotifiedAt.
            try {
              await notifyAdminsOfRetryExhaustion({
                channel: "push",
                request: { ...row, lastPushError: r.error ?? row.lastPushError, pushAttempts: r.attempts, lastPushStatus: r.status, pushRetryExhaustedAt: new Date() },
                logContext: { job: "retryFailedDataRequestPushSms" },
              });
            } catch (notifyErr) {
              logger.warn({ err: notifyErr, requestId: row.id }, "[cron] data-request push exhaustion notify threw");
            }
          }
        }
      } catch (err) {
        logger.warn({ err, requestId: row.id }, "[cron] data-request push retry threw");
      }
    }
    if (row.lastSmsStatus === "failed" && (row.smsAttempts ?? 0) < DATA_REQUEST_MAX_SMS_ATTEMPTS) {
      try {
        const r = await retryDataRequestSms({ request: row, logContext: { job: "retryFailedDataRequestPushSms" } });
        if (r) {
          smsRetried++;
          if (r.status === "sent") smsSent++;
          try {
            await recordCronRetryAudit({ request: row, channel: "sms", result: r });
          } catch (auditErr) {
            logger.warn({ err: auditErr, requestId: row.id }, "[cron] data-request sms retry audit threw");
          }
          if (r.exhausted) {
            smsExhausted++;
            // Task 261: parity with the email exhaustion alert. De-dups via
            // smsExhaustionNotifiedAt.
            try {
              await notifyAdminsOfRetryExhaustion({
                channel: "sms",
                request: { ...row, lastSmsError: r.error ?? row.lastSmsError, smsAttempts: r.attempts, lastSmsStatus: r.status, smsRetryExhaustedAt: new Date() },
                logContext: { job: "retryFailedDataRequestPushSms" },
              });
            } catch (notifyErr) {
              logger.warn({ err: notifyErr, requestId: row.id }, "[cron] data-request sms exhaustion notify threw");
            }
          }
        }
      } catch (err) {
        logger.warn({ err, requestId: row.id }, "[cron] data-request SMS retry threw");
      }
    }
    if (row.lastWhatsappStatus === "failed" && (row.whatsappAttempts ?? 0) < DATA_REQUEST_MAX_WHATSAPP_ATTEMPTS) {
      try {
        const r = await retryDataRequestWhatsapp({ request: row, logContext: { job: "retryFailedDataRequestPushSms" } });
        if (r) {
          whatsappRetried++;
          if (r.status === "sent") whatsappSent++;
          try {
            await recordCronRetryAudit({ request: row, channel: "whatsapp", result: r });
          } catch (auditErr) {
            logger.warn({ err: auditErr, requestId: row.id }, "[cron] data-request whatsapp retry audit threw");
          }
          if (r.exhausted) {
            whatsappExhausted++;
            // Task 297: parity with the email/push/SMS exhaustion alerts —
            // proactively notify admins so they can fall back to another
            // channel before the regulatory deadline. De-dups via
            // whatsappExhaustionNotifiedAt.
            try {
              await notifyAdminsOfRetryExhaustion({
                channel: "whatsapp",
                request: { ...row, lastWhatsappError: r.error ?? row.lastWhatsappError, whatsappAttempts: r.attempts, lastWhatsappStatus: r.status, whatsappRetryExhaustedAt: new Date() },
                logContext: { job: "retryFailedDataRequestPushSms" },
              });
            } catch (notifyErr) {
              logger.warn({ err: notifyErr, requestId: row.id }, "[cron] data-request whatsapp exhaustion notify threw");
            }
          }
        }
      } catch (err) {
        logger.warn({ err, requestId: row.id }, "[cron] data-request WhatsApp retry threw");
      }
    }
  }

  if (pushRetried + smsRetried + emailRetried + whatsappRetried > 0) {
    logger.info(
      { emailRetried, emailSent, emailExhausted, pushRetried, pushSent, pushExhausted, smsRetried, smsSent, smsExhausted, whatsappRetried, whatsappSent, whatsappExhausted, scanned: candidates.length },
      "[cron] data-request email/push/SMS/WhatsApp retry batch complete",
    );
  }
}

// ─── Levy-receipt push/SMS retry (Task #247) ─────────────────────────────────
// Levy receipts fan out to push and SMS for opted-in members. A transient
// provider blip used to be a one-shot — receipts now get the same bounded
// retry treatment as privacy-request notices so a momentary failure doesn't
// quietly drop a member's receipt. Email is intentionally not retried here
// because the receipt-email path enqueues into the mail provider's own queue.
const LEVY_RECEIPT_PUSH_SMS_RETRY_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const LEVY_RECEIPT_RETRY_BATCH_LIMIT = 50;

export async function retryFailedLevyReceiptPushSms() {
  const now = new Date();
  const candidates = await db
    .select()
    .from(memberLevyReceiptAttemptsTable)
    .where(or(
      and(
        eq(memberLevyReceiptAttemptsTable.pushStatus, "failed"),
        lt(memberLevyReceiptAttemptsTable.pushAttempts, LEVY_RECEIPT_MAX_PUSH_ATTEMPTS),
      ),
      and(
        eq(memberLevyReceiptAttemptsTable.smsStatus, "failed"),
        lt(memberLevyReceiptAttemptsTable.smsAttempts, LEVY_RECEIPT_MAX_SMS_ATTEMPTS),
      ),
      and(
        eq(memberLevyReceiptAttemptsTable.whatsappStatus, "failed"),
        lt(memberLevyReceiptAttemptsTable.whatsappAttempts, LEVY_RECEIPT_MAX_WHATSAPP_ATTEMPTS),
      ),
      // Task #1847 — also pick up rows with a failed email channel
      // whose backoff window has elapsed and whose retry budget hasn't
      // been blown. NULL `nextEmailRetryAt` is treated as "due now"
      // (defensive — the first-send path always stamps it but tests
      // and historical rows may not have).
      and(
        eq(memberLevyReceiptAttemptsTable.emailStatus, "failed"),
        lt(memberLevyReceiptAttemptsTable.emailAttempts, LEVY_RECEIPT_MAX_EMAIL_ATTEMPTS),
        isNull(memberLevyReceiptAttemptsTable.emailRetryExhaustedAt),
        or(
          isNull(memberLevyReceiptAttemptsTable.nextEmailRetryAt),
          lte(memberLevyReceiptAttemptsTable.nextEmailRetryAt, now),
        ),
      ),
    ))
    .limit(LEVY_RECEIPT_RETRY_BATCH_LIMIT);

  if (candidates.length === 0) return;

  let pushRetried = 0, pushSent = 0, pushExhausted = 0;
  let smsRetried = 0, smsSent = 0, smsExhausted = 0;
  let whatsappRetried = 0, whatsappSent = 0, whatsappExhausted = 0;
  let emailRetried = 0, emailSent = 0, emailExhausted = 0;

  for (const row of candidates) {
    if (row.pushStatus === "failed" && (row.pushAttempts ?? 0) < LEVY_RECEIPT_MAX_PUSH_ATTEMPTS) {
      try {
        const r = await retryLevyReceiptPush({ attempt: row, logContext: { job: "retryFailedLevyReceiptPushSms" } });
        if (r) {
          pushRetried++;
          if (r.status === "sent") pushSent++;
          if (r.exhausted) {
            pushExhausted++;
            // Task #269: alert admins so the failure doesn't sit unnoticed.
            // Best-effort — never let a notification failure interrupt the
            // batch (other rows still need processing).
            try {
              await notifyAdminsOfLevyReceiptRetryExhaustion({
                attempt: { ...row, pushAttempts: r.attempts, lastPushError: r.error ?? row.lastPushError },
                channel: "push",
                logContext: { job: "retryFailedLevyReceiptPushSms" },
              });
            } catch (err) {
              logger.warn({ err, attemptId: row.id }, "[cron] levy-receipt push exhaustion notify threw");
            }
          }
        }
      } catch (err) {
        logger.warn({ err, attemptId: row.id }, "[cron] levy-receipt push retry threw");
      }
    }
    if (row.smsStatus === "failed" && (row.smsAttempts ?? 0) < LEVY_RECEIPT_MAX_SMS_ATTEMPTS) {
      try {
        const r = await retryLevyReceiptSms({ attempt: row, logContext: { job: "retryFailedLevyReceiptPushSms" } });
        if (r) {
          smsRetried++;
          if (r.status === "sent") smsSent++;
          if (r.exhausted) {
            smsExhausted++;
            // Task #269: alert admins on SMS retry exhaustion as well.
            try {
              await notifyAdminsOfLevyReceiptRetryExhaustion({
                attempt: { ...row, smsAttempts: r.attempts, lastSmsError: r.error ?? row.lastSmsError },
                channel: "sms",
                logContext: { job: "retryFailedLevyReceiptPushSms" },
              });
            } catch (err) {
              logger.warn({ err, attemptId: row.id }, "[cron] levy-receipt SMS exhaustion notify threw");
            }
          }
        }
      } catch (err) {
        logger.warn({ err, attemptId: row.id }, "[cron] levy-receipt SMS retry threw");
      }
    }
    // Task #298: WhatsApp retry pass. The matching admin-exhaustion alert
    // is intentionally out of scope here — it lands with the updated #269
    // task. We still track the exhaustion counter so cron telemetry stays
    // honest about how many rows have given up this batch.
    if (row.whatsappStatus === "failed" && (row.whatsappAttempts ?? 0) < LEVY_RECEIPT_MAX_WHATSAPP_ATTEMPTS) {
      try {
        const r = await retryLevyReceiptWhatsapp({ attempt: row, logContext: { job: "retryFailedLevyReceiptPushSms" } });
        if (r) {
          whatsappRetried++;
          if (r.status === "sent") whatsappSent++;
          if (r.exhausted) whatsappExhausted++;
        }
      } catch (err) {
        logger.warn({ err, attemptId: row.id }, "[cron] levy-receipt WhatsApp retry threw");
      }
    }
    // Task #1847 — email retry pass. The retry helper itself owns the
    // admin-alert dispatch on cap (matching push/SMS exhaustion alerts
    // already wired above), so we only need to forward the result for
    // batch telemetry here.
    if (
      row.emailStatus === "failed"
      && (row.emailAttempts ?? 0) < LEVY_RECEIPT_MAX_EMAIL_ATTEMPTS
      && row.emailRetryExhaustedAt == null
      && (row.nextEmailRetryAt == null || row.nextEmailRetryAt.getTime() <= now.getTime())
    ) {
      try {
        const r = await retryLevyReceiptEmail({ attempt: row, logContext: { job: "retryFailedLevyReceiptPushSms" } });
        if (r) {
          emailRetried++;
          if (r.status === "sent") emailSent++;
          if (r.exhausted) emailExhausted++;
        }
      } catch (err) {
        logger.warn({ err, attemptId: row.id }, "[cron] levy-receipt email retry threw");
      }
    }
  }

  if (pushRetried + smsRetried + whatsappRetried + emailRetried > 0) {
    logger.info(
      {
        pushRetried, pushSent, pushExhausted,
        smsRetried, smsSent, smsExhausted,
        whatsappRetried, whatsappSent, whatsappExhausted,
        emailRetried, emailSent, emailExhausted,
        scanned: candidates.length,
      },
      "[cron] levy-receipt push/SMS/WhatsApp/email retry batch complete",
    );
  }
}

// ─── Side-game receipt email/push retry (Task #961) ──────────────────────────
// Side-game settlement notifications fan out to push and email for the
// recipient. Until now those were one-shot — a brief SMTP / push outage
// quietly dropped the receipt. Mirroring the levy-receipt pattern, we now
// persist a per-settlement attempts row and re-attempt failed deliveries on
// a bounded schedule with exponential backoff (5/10/20/40/80 minutes between
// attempts, capped at 5 attempts per channel). The retry helpers themselves
// flip provider-not-configured errors to terminal `skipped` so the cron
// stops re-selecting rows it can never deliver.
const SIDE_GAME_RECEIPT_RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SIDE_GAME_RECEIPT_RETRY_BATCH_LIMIT = 50;

export async function retryFailedSideGameReceiptEmailPush() {
  const now = new Date();
  const candidates = await db
    .select()
    .from(sideGameSettlementReceiptAttemptsTable)
    .where(or(
      and(
        eq(sideGameSettlementReceiptAttemptsTable.emailStatus, "failed"),
        lt(sideGameSettlementReceiptAttemptsTable.emailAttempts, SIDE_GAME_RECEIPT_MAX_EMAIL_ATTEMPTS),
        or(
          isNull(sideGameSettlementReceiptAttemptsTable.nextEmailRetryAt),
          lte(sideGameSettlementReceiptAttemptsTable.nextEmailRetryAt, now),
        ),
      ),
      and(
        eq(sideGameSettlementReceiptAttemptsTable.pushStatus, "failed"),
        lt(sideGameSettlementReceiptAttemptsTable.pushAttempts, SIDE_GAME_RECEIPT_MAX_PUSH_ATTEMPTS),
        or(
          isNull(sideGameSettlementReceiptAttemptsTable.nextPushRetryAt),
          lte(sideGameSettlementReceiptAttemptsTable.nextPushRetryAt, now),
        ),
      ),
    ))
    .limit(SIDE_GAME_RECEIPT_RETRY_BATCH_LIMIT);

  if (candidates.length === 0) return;

  let emailRetried = 0, emailSent = 0, emailExhausted = 0;
  let pushRetried = 0, pushSent = 0, pushExhausted = 0;

  for (const row of candidates) {
    if (row.emailStatus === "failed" && (row.emailAttempts ?? 0) < SIDE_GAME_RECEIPT_MAX_EMAIL_ATTEMPTS) {
      try {
        const r = await retrySideGameReceiptEmail({ attempt: row, logContext: { job: "retryFailedSideGameReceiptEmailPush" }, now });
        if (r) {
          emailRetried++;
          if (r.status === "sent") emailSent++;
          if (r.exhausted) emailExhausted++;
        }
      } catch (err) {
        logger.warn({ err, attemptId: row.id }, "[cron] side-game receipt email retry threw");
      }
    }
    if (row.pushStatus === "failed" && (row.pushAttempts ?? 0) < SIDE_GAME_RECEIPT_MAX_PUSH_ATTEMPTS) {
      try {
        const r = await retrySideGameReceiptPush({ attempt: row, logContext: { job: "retryFailedSideGameReceiptEmailPush" }, now });
        if (r) {
          pushRetried++;
          if (r.status === "sent") pushSent++;
          if (r.exhausted) pushExhausted++;
        }
      } catch (err) {
        logger.warn({ err, attemptId: row.id }, "[cron] side-game receipt push retry threw");
      }
    }
  }

  if (emailRetried + pushRetried > 0) {
    logger.info(
      { emailRetried, emailSent, emailExhausted, pushRetried, pushSent, pushExhausted, scanned: candidates.length },
      "[cron] side-game receipt email/push retry batch complete",
    );
  }
}

// ─── Coach payout-paid push/SMS retry (Task #967) ────────────────────────────
// Coach payout-paid notifications fan out to push and SMS for opted-in
// coaches. A transient provider blip used to be a one-shot — we now mirror
// the levy-receipt pattern and re-attempt failed deliveries on a bounded
// schedule so coaches don't silently miss their payout confirmation.
const COACH_PAYOUT_PUSH_SMS_RETRY_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const COACH_PAYOUT_RETRY_BATCH_LIMIT = 50;

export async function retryFailedCoachPayoutPushSms() {
  const now = new Date();
  const candidates = await db
    .select()
    .from(coachPayoutNotificationAttemptsTable)
    .where(or(
      and(
        eq(coachPayoutNotificationAttemptsTable.pushStatus, "failed"),
        lt(coachPayoutNotificationAttemptsTable.pushAttempts, COACH_PAYOUT_MAX_PUSH_ATTEMPTS),
      ),
      and(
        eq(coachPayoutNotificationAttemptsTable.smsStatus, "failed"),
        lt(coachPayoutNotificationAttemptsTable.smsAttempts, COACH_PAYOUT_MAX_SMS_ATTEMPTS),
      ),
      // Task #1847 — also pick up rows with a failed email channel
      // whose backoff window has elapsed and whose retry budget hasn't
      // been blown.
      and(
        eq(coachPayoutNotificationAttemptsTable.emailStatus, "failed"),
        lt(coachPayoutNotificationAttemptsTable.emailAttempts, COACH_PAYOUT_MAX_EMAIL_ATTEMPTS),
        isNull(coachPayoutNotificationAttemptsTable.emailRetryExhaustedAt),
        or(
          isNull(coachPayoutNotificationAttemptsTable.nextEmailRetryAt),
          lte(coachPayoutNotificationAttemptsTable.nextEmailRetryAt, now),
        ),
      ),
    ))
    .limit(COACH_PAYOUT_RETRY_BATCH_LIMIT);

  if (candidates.length === 0) return;

  let pushRetried = 0, pushSent = 0, pushExhausted = 0;
  let smsRetried = 0, smsSent = 0, smsExhausted = 0;
  let emailRetried = 0, emailSent = 0, emailExhausted = 0;

  for (const row of candidates) {
    if (row.pushStatus === "failed" && (row.pushAttempts ?? 0) < COACH_PAYOUT_MAX_PUSH_ATTEMPTS) {
      try {
        const r = await retryCoachPayoutPush({ attempt: row, logContext: { job: "retryFailedCoachPayoutPushSms" } });
        if (r) {
          pushRetried++;
          if (r.status === "sent") pushSent++;
          if (r.exhausted) pushExhausted++;
        }
      } catch (err) {
        logger.warn({ err, attemptId: row.id }, "[cron] coach-payout push retry threw");
      }
    }
    if (row.smsStatus === "failed" && (row.smsAttempts ?? 0) < COACH_PAYOUT_MAX_SMS_ATTEMPTS) {
      try {
        const r = await retryCoachPayoutSms({ attempt: row, logContext: { job: "retryFailedCoachPayoutPushSms" } });
        if (r) {
          smsRetried++;
          if (r.status === "sent") smsSent++;
          if (r.exhausted) smsExhausted++;
        }
      } catch (err) {
        logger.warn({ err, attemptId: row.id }, "[cron] coach-payout SMS retry threw");
      }
    }
    // Task #1847 — email retry pass. The retry helper itself owns the
    // admin-alert dispatch on cap, so this loop only forwards the
    // result for batch telemetry.
    if (
      row.emailStatus === "failed"
      && (row.emailAttempts ?? 0) < COACH_PAYOUT_MAX_EMAIL_ATTEMPTS
      && row.emailRetryExhaustedAt == null
      && (row.nextEmailRetryAt == null || row.nextEmailRetryAt.getTime() <= now.getTime())
    ) {
      try {
        const r = await retryCoachPayoutEmail({ attempt: row, logContext: { job: "retryFailedCoachPayoutPushSms" } });
        if (r) {
          emailRetried++;
          if (r.status === "sent") emailSent++;
          if (r.exhausted) emailExhausted++;
        }
      } catch (err) {
        logger.warn({ err, attemptId: row.id }, "[cron] coach-payout email retry threw");
      }
    }
  }

  if (pushRetried + smsRetried + emailRetried > 0) {
    logger.info(
      {
        pushRetried, pushSent, pushExhausted,
        smsRetried, smsSent, smsExhausted,
        emailRetried, emailSent, emailExhausted,
        scanned: candidates.length,
      },
      "[cron] coach-payout push/SMS/email retry batch complete",
    );
  }
}

// ─── Manual-entry alert email retry (Task #1847) ──────────────────────────
// One row per (alert, recipient) email attempt. Mirrors the wallet
// withdrawal pattern: only re-select rows whose backoff window has
// elapsed, cap = 5 deliveries, hard SMTP bounce → terminal exhausted
// (handled inside `retryManualEntryEmail`).
const MANUAL_ENTRY_EMAIL_RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MANUAL_ENTRY_EMAIL_RETRY_BATCH_LIMIT = 50;

export async function retryFailedManualEntryEmail() {
  const now = new Date();
  const candidates = await db
    .select()
    .from(manualEntryAlertRecipientsTable)
    .where(and(
      eq(manualEntryAlertRecipientsTable.channel, "email"),
      eq(manualEntryAlertRecipientsTable.status, "failed"),
      lt(manualEntryAlertRecipientsTable.emailAttempts, MANUAL_ENTRY_MAX_EMAIL_ATTEMPTS),
      isNull(manualEntryAlertRecipientsTable.emailRetryExhaustedAt),
      or(
        isNull(manualEntryAlertRecipientsTable.nextEmailRetryAt),
        lte(manualEntryAlertRecipientsTable.nextEmailRetryAt, now),
      ),
    ))
    .orderBy(manualEntryAlertRecipientsTable.createdAt)
    .limit(MANUAL_ENTRY_EMAIL_RETRY_BATCH_LIMIT);

  if (candidates.length === 0) return;

  let retried = 0, sent = 0, exhausted = 0;

  for (const row of candidates) {
    try {
      const r = await retryManualEntryEmail({ recipient: row, logContext: { job: "retryFailedManualEntryEmail" }, now });
      if (r) {
        retried++;
        if (r.status === "sent") sent++;
        if (r.exhausted) exhausted++;
      }
    } catch (err) {
      logger.warn({ err, recipientRowId: row.id }, "[cron] manual-entry email retry threw");
    }
  }

  if (retried > 0) {
    logger.info(
      { retried, sent, exhausted, scanned: candidates.length },
      "[cron] manual-entry email retry batch complete",
    );
  }
}

// ─── Wallet withdrawal email/push retry (Task #1108) ─────────────────────────
// Wallet withdrawal lifecycle alerts (paid / failed / reversed) are the
// only confirmation a member gets for an irreversible bank-side action.
// They used to be one-shot — we now mirror the side-game receipt retry
// pattern so a transient SMTP/Expo blip on the first try is re-attempted
// on a bounded exponential-backoff schedule (5/10/20/40/80 minutes).
const WALLET_WITHDRAWAL_NOTIFY_RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const WALLET_WITHDRAWAL_NOTIFY_RETRY_BATCH_LIMIT = 50;

export async function retryFailedWalletWithdrawalEmailPush() {
  const now = new Date();
  // Only select rows whose backoff window has actually elapsed for at
  // least one channel, and order by `createdAt` so a backlog larger than
  // the batch limit drains oldest-first (the original failure is the
  // one most at risk of timing out the member's expectation window).
  // `nextEmailRetryAt`/`nextPushRetryAt` are NULL until the first
  // failure stamps them, so we treat NULL as "due now" for freshly
  // failed rows that bypassed the backoff path (defensive).
  const candidates = await db
    .select()
    .from(walletWithdrawalNotifyAttemptsTable)
    .where(or(
      and(
        eq(walletWithdrawalNotifyAttemptsTable.emailStatus, "failed"),
        lt(walletWithdrawalNotifyAttemptsTable.emailAttempts, WALLET_WITHDRAWAL_NOTIFY_MAX_EMAIL_ATTEMPTS),
        or(
          isNull(walletWithdrawalNotifyAttemptsTable.nextEmailRetryAt),
          lte(walletWithdrawalNotifyAttemptsTable.nextEmailRetryAt, now),
        ),
      ),
      and(
        eq(walletWithdrawalNotifyAttemptsTable.pushStatus, "failed"),
        lt(walletWithdrawalNotifyAttemptsTable.pushAttempts, WALLET_WITHDRAWAL_NOTIFY_MAX_PUSH_ATTEMPTS),
        or(
          isNull(walletWithdrawalNotifyAttemptsTable.nextPushRetryAt),
          lte(walletWithdrawalNotifyAttemptsTable.nextPushRetryAt, now),
        ),
      ),
    ))
    .orderBy(walletWithdrawalNotifyAttemptsTable.createdAt, walletWithdrawalNotifyAttemptsTable.id)
    .limit(WALLET_WITHDRAWAL_NOTIFY_RETRY_BATCH_LIMIT);

  if (candidates.length === 0) return;

  let emailRetried = 0, emailSent = 0, emailExhausted = 0;
  let pushRetried = 0, pushSent = 0, pushExhausted = 0;

  for (const row of candidates) {
    if (row.emailStatus === "failed" && (row.emailAttempts ?? 0) < WALLET_WITHDRAWAL_NOTIFY_MAX_EMAIL_ATTEMPTS) {
      try {
        const r = await retryWalletWithdrawalEmail({ attempt: row, logContext: { job: "retryFailedWalletWithdrawalEmailPush" }, now });
        if (r) {
          emailRetried++;
          if (r.status === "sent") emailSent++;
          if (r.exhausted) emailExhausted++;
        }
      } catch (err) {
        logger.warn({ err, attemptId: row.id }, "[cron] wallet-withdrawal email retry threw");
      }
    }
    if (row.pushStatus === "failed" && (row.pushAttempts ?? 0) < WALLET_WITHDRAWAL_NOTIFY_MAX_PUSH_ATTEMPTS) {
      try {
        const r = await retryWalletWithdrawalPush({ attempt: row, logContext: { job: "retryFailedWalletWithdrawalEmailPush" }, now });
        if (r) {
          pushRetried++;
          if (r.status === "sent") pushSent++;
          if (r.exhausted) pushExhausted++;
        }
      } catch (err) {
        logger.warn({ err, attemptId: row.id }, "[cron] wallet-withdrawal push retry threw");
      }
    }
  }

  if (emailRetried + pushRetried > 0) {
    logger.info(
      { emailRetried, emailSent, emailExhausted, pushRetried, pushSent, pushExhausted, scanned: candidates.length },
      "[cron] wallet-withdrawal email/push retry batch complete",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Task #1280 — Wallet top-up auto-refund email/push retry batch.
//
// Same shape as `retryFailedWalletWithdrawalEmailPush`: scans up to 50
// `wallet_topup_refund_notify_attempts` rows whose backoff window has
// elapsed for at least one channel, and re-attempts that channel via the
// per-module helpers. Provider-not-configured failures inside those
// helpers stamp the row to terminal `skipped` so subsequent batches
// don't re-select them.
// ─────────────────────────────────────────────────────────────────────────
const WALLET_TOPUP_REFUND_NOTIFY_RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const WALLET_TOPUP_REFUND_NOTIFY_RETRY_BATCH_LIMIT = 50;

export async function retryFailedWalletTopupRefundEmailPush() {
  const now = new Date();
  const candidates = await db
    .select()
    .from(walletTopupRefundNotifyAttemptsTable)
    .where(or(
      and(
        eq(walletTopupRefundNotifyAttemptsTable.emailStatus, "failed"),
        lt(walletTopupRefundNotifyAttemptsTable.emailAttempts, WALLET_TOPUP_REFUND_NOTIFY_MAX_EMAIL_ATTEMPTS),
        or(
          isNull(walletTopupRefundNotifyAttemptsTable.nextEmailRetryAt),
          lte(walletTopupRefundNotifyAttemptsTable.nextEmailRetryAt, now),
        ),
      ),
      and(
        eq(walletTopupRefundNotifyAttemptsTable.pushStatus, "failed"),
        lt(walletTopupRefundNotifyAttemptsTable.pushAttempts, WALLET_TOPUP_REFUND_NOTIFY_MAX_PUSH_ATTEMPTS),
        or(
          isNull(walletTopupRefundNotifyAttemptsTable.nextPushRetryAt),
          lte(walletTopupRefundNotifyAttemptsTable.nextPushRetryAt, now),
        ),
      ),
      // Task #1508 — sweep SMS / WhatsApp transient failures too.
      and(
        eq(walletTopupRefundNotifyAttemptsTable.smsStatus, "failed"),
        lt(walletTopupRefundNotifyAttemptsTable.smsAttempts, WALLET_TOPUP_REFUND_NOTIFY_MAX_SMS_ATTEMPTS),
        or(
          isNull(walletTopupRefundNotifyAttemptsTable.nextSmsRetryAt),
          lte(walletTopupRefundNotifyAttemptsTable.nextSmsRetryAt, now),
        ),
      ),
      and(
        eq(walletTopupRefundNotifyAttemptsTable.whatsappStatus, "failed"),
        lt(walletTopupRefundNotifyAttemptsTable.whatsappAttempts, WALLET_TOPUP_REFUND_NOTIFY_MAX_WHATSAPP_ATTEMPTS),
        or(
          isNull(walletTopupRefundNotifyAttemptsTable.nextWhatsappRetryAt),
          lte(walletTopupRefundNotifyAttemptsTable.nextWhatsappRetryAt, now),
        ),
      ),
    ))
    .orderBy(walletTopupRefundNotifyAttemptsTable.createdAt, walletTopupRefundNotifyAttemptsTable.id)
    .limit(WALLET_TOPUP_REFUND_NOTIFY_RETRY_BATCH_LIMIT);

  if (candidates.length === 0) return;

  let emailRetried = 0, emailSent = 0, emailExhausted = 0;
  let pushRetried = 0, pushSent = 0, pushExhausted = 0;
  let smsRetried = 0, smsSent = 0, smsExhausted = 0;
  let whatsappRetried = 0, whatsappSent = 0, whatsappExhausted = 0;

  for (const row of candidates) {
    if (row.emailStatus === "failed" && (row.emailAttempts ?? 0) < WALLET_TOPUP_REFUND_NOTIFY_MAX_EMAIL_ATTEMPTS) {
      try {
        const r = await retryWalletTopupRefundEmail({ attempt: row, logContext: { job: "retryFailedWalletTopupRefundEmailPush" }, now });
        if (r) {
          emailRetried++;
          if (r.status === "sent") emailSent++;
          if (r.exhausted) emailExhausted++;
        }
      } catch (err) {
        logger.warn({ err, attemptId: row.id }, "[cron] wallet-topup-refund email retry threw");
      }
    }
    if (row.pushStatus === "failed" && (row.pushAttempts ?? 0) < WALLET_TOPUP_REFUND_NOTIFY_MAX_PUSH_ATTEMPTS) {
      try {
        const r = await retryWalletTopupRefundPush({ attempt: row, logContext: { job: "retryFailedWalletTopupRefundEmailPush" }, now });
        if (r) {
          pushRetried++;
          if (r.status === "sent") pushSent++;
          if (r.exhausted) pushExhausted++;
        }
      } catch (err) {
        logger.warn({ err, attemptId: row.id }, "[cron] wallet-topup-refund push retry threw");
      }
    }
    if (row.smsStatus === "failed" && (row.smsAttempts ?? 0) < WALLET_TOPUP_REFUND_NOTIFY_MAX_SMS_ATTEMPTS) {
      try {
        const r = await retryWalletTopupRefundSms({ attempt: row, logContext: { job: "retryFailedWalletTopupRefundEmailPush" }, now });
        if (r) {
          smsRetried++;
          if (r.status === "sent") smsSent++;
          if (r.exhausted) smsExhausted++;
        }
      } catch (err) {
        logger.warn({ err, attemptId: row.id }, "[cron] wallet-topup-refund SMS retry threw");
      }
    }
    if (row.whatsappStatus === "failed" && (row.whatsappAttempts ?? 0) < WALLET_TOPUP_REFUND_NOTIFY_MAX_WHATSAPP_ATTEMPTS) {
      try {
        const r = await retryWalletTopupRefundWhatsapp({ attempt: row, logContext: { job: "retryFailedWalletTopupRefundEmailPush" }, now });
        if (r) {
          whatsappRetried++;
          if (r.status === "sent") whatsappSent++;
          if (r.exhausted) whatsappExhausted++;
        }
      } catch (err) {
        logger.warn({ err, attemptId: row.id }, "[cron] wallet-topup-refund WhatsApp retry threw");
      }
    }
  }

  if (emailRetried + pushRetried + smsRetried + whatsappRetried > 0) {
    logger.info(
      {
        emailRetried, emailSent, emailExhausted,
        pushRetried, pushSent, pushExhausted,
        smsRetried, smsSent, smsExhausted,
        whatsappRetried, whatsappSent, whatsappExhausted,
        scanned: candidates.length,
      },
      "[cron] wallet-topup-refund email/push/sms/whatsapp retry batch complete",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Task #1280 — Coach payout-account change email/push retry batch.
//
// Mirrors `retryFailedWalletWithdrawalEmailPush` against the
// `coach_payout_account_change_notify_attempts` table. The retry helpers
// re-load the source `coach_payout_account_history` row at retry time so
// the masked PII in the email body matches the audit log byte-for-byte.
// ─────────────────────────────────────────────────────────────────────────
const COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_RETRY_BATCH_LIMIT = 50;

export async function retryFailedCoachPayoutAccountChangeEmailPush() {
  const now = new Date();
  const candidates = await db
    .select()
    .from(coachPayoutAccountChangeNotifyAttemptsTable)
    .where(or(
      and(
        eq(coachPayoutAccountChangeNotifyAttemptsTable.emailStatus, "failed"),
        lt(coachPayoutAccountChangeNotifyAttemptsTable.emailAttempts, COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_EMAIL_ATTEMPTS),
        or(
          isNull(coachPayoutAccountChangeNotifyAttemptsTable.nextEmailRetryAt),
          lte(coachPayoutAccountChangeNotifyAttemptsTable.nextEmailRetryAt, now),
        ),
      ),
      and(
        eq(coachPayoutAccountChangeNotifyAttemptsTable.pushStatus, "failed"),
        lt(coachPayoutAccountChangeNotifyAttemptsTable.pushAttempts, COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_PUSH_ATTEMPTS),
        or(
          isNull(coachPayoutAccountChangeNotifyAttemptsTable.nextPushRetryAt),
          lte(coachPayoutAccountChangeNotifyAttemptsTable.nextPushRetryAt, now),
        ),
      ),
      // Task #1864 — sweep failed SMS / WhatsApp legs in the same pass
      // so a Twilio outage that briefly knocked out both phone channels
      // is rolled up in a single cron tick.
      and(
        eq(coachPayoutAccountChangeNotifyAttemptsTable.smsStatus, "failed"),
        lt(coachPayoutAccountChangeNotifyAttemptsTable.smsAttempts, COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_SMS_ATTEMPTS),
        or(
          isNull(coachPayoutAccountChangeNotifyAttemptsTable.nextSmsRetryAt),
          lte(coachPayoutAccountChangeNotifyAttemptsTable.nextSmsRetryAt, now),
        ),
      ),
      and(
        eq(coachPayoutAccountChangeNotifyAttemptsTable.whatsappStatus, "failed"),
        lt(coachPayoutAccountChangeNotifyAttemptsTable.whatsappAttempts, COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_WHATSAPP_ATTEMPTS),
        or(
          isNull(coachPayoutAccountChangeNotifyAttemptsTable.nextWhatsappRetryAt),
          lte(coachPayoutAccountChangeNotifyAttemptsTable.nextWhatsappRetryAt, now),
        ),
      ),
    ))
    .orderBy(coachPayoutAccountChangeNotifyAttemptsTable.createdAt, coachPayoutAccountChangeNotifyAttemptsTable.id)
    .limit(COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_RETRY_BATCH_LIMIT);

  if (candidates.length === 0) return;

  let emailRetried = 0, emailSent = 0, emailExhausted = 0;
  let pushRetried = 0, pushSent = 0, pushExhausted = 0;
  let smsRetried = 0, smsSent = 0, smsExhausted = 0;
  let whatsappRetried = 0, whatsappSent = 0, whatsappExhausted = 0;

  for (const row of candidates) {
    if (row.emailStatus === "failed" && (row.emailAttempts ?? 0) < COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_EMAIL_ATTEMPTS) {
      try {
        const r = await retryCoachPayoutAccountChangeEmail({ attempt: row, logContext: { job: "retryFailedCoachPayoutAccountChangeEmailPush" }, now });
        if (r) {
          emailRetried++;
          if (r.status === "sent") emailSent++;
          if (r.exhausted) emailExhausted++;
        }
      } catch (err) {
        logger.warn({ err, attemptId: row.id }, "[cron] coach-payout-account-change email retry threw");
      }
    }
    if (row.pushStatus === "failed" && (row.pushAttempts ?? 0) < COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_PUSH_ATTEMPTS) {
      try {
        const r = await retryCoachPayoutAccountChangePush({ attempt: row, logContext: { job: "retryFailedCoachPayoutAccountChangeEmailPush" }, now });
        if (r) {
          pushRetried++;
          if (r.status === "sent") pushSent++;
          if (r.exhausted) pushExhausted++;
        }
      } catch (err) {
        logger.warn({ err, attemptId: row.id }, "[cron] coach-payout-account-change push retry threw");
      }
    }
    if (row.smsStatus === "failed" && (row.smsAttempts ?? 0) < COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_SMS_ATTEMPTS) {
      try {
        const r = await retryCoachPayoutAccountChangeSms({ attempt: row, logContext: { job: "retryFailedCoachPayoutAccountChangeEmailPush" }, now });
        if (r) {
          smsRetried++;
          if (r.status === "sent") smsSent++;
          if (r.exhausted) smsExhausted++;
        }
      } catch (err) {
        logger.warn({ err, attemptId: row.id }, "[cron] coach-payout-account-change sms retry threw");
      }
    }
    if (row.whatsappStatus === "failed" && (row.whatsappAttempts ?? 0) < COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_WHATSAPP_ATTEMPTS) {
      try {
        const r = await retryCoachPayoutAccountChangeWhatsapp({ attempt: row, logContext: { job: "retryFailedCoachPayoutAccountChangeEmailPush" }, now });
        if (r) {
          whatsappRetried++;
          if (r.status === "sent") whatsappSent++;
          if (r.exhausted) whatsappExhausted++;
        }
      } catch (err) {
        logger.warn({ err, attemptId: row.id }, "[cron] coach-payout-account-change whatsapp retry threw");
      }
    }
  }

  if (emailRetried + pushRetried + smsRetried + whatsappRetried > 0) {
    logger.info(
      {
        emailRetried, emailSent, emailExhausted,
        pushRetried, pushSent, pushExhausted,
        smsRetried, smsSent, smsExhausted,
        whatsappRetried, whatsappSent, whatsappExhausted,
        scanned: candidates.length,
      },
      "[cron] coach-payout-account-change email/push/sms/whatsapp retry batch complete",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Task #1845 — Periodic re-fire of admin-comm-pref-override consent emails
// whose initial send hit a transient SMTP/Postmark failure.
//
// Mirrors `retryFailedCoachPayoutAccountChangeEmailPush` against the
// `admin_comm_pref_override_notify_attempts` table. The retry helper
// re-uses the snapshotted prefLabel / previous / new / reason / changedAt
// columns so a member or admin re-toggling the underlying preference row
// in between can't poison the email body.
// ─────────────────────────────────────────────────────────────────────────
const ADMIN_COMM_PREF_OVERRIDE_NOTIFY_RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const ADMIN_COMM_PREF_OVERRIDE_NOTIFY_RETRY_BATCH_LIMIT = 50;

export async function retryFailedAdminCommPrefOverrideEmail() {
  const now = new Date();
  const candidates = await db
    .select()
    .from(adminCommPrefOverrideNotifyAttemptsTable)
    .where(and(
      eq(adminCommPrefOverrideNotifyAttemptsTable.emailStatus, "failed"),
      lt(adminCommPrefOverrideNotifyAttemptsTable.emailAttempts, ADMIN_COMM_PREF_OVERRIDE_NOTIFY_MAX_EMAIL_ATTEMPTS),
      or(
        isNull(adminCommPrefOverrideNotifyAttemptsTable.nextEmailRetryAt),
        lte(adminCommPrefOverrideNotifyAttemptsTable.nextEmailRetryAt, now),
      ),
    ))
    .orderBy(adminCommPrefOverrideNotifyAttemptsTable.createdAt, adminCommPrefOverrideNotifyAttemptsTable.id)
    .limit(ADMIN_COMM_PREF_OVERRIDE_NOTIFY_RETRY_BATCH_LIMIT);

  if (candidates.length === 0) return;

  let retried = 0, sent = 0, exhausted = 0;
  for (const row of candidates) {
    if (row.emailStatus !== "failed" || (row.emailAttempts ?? 0) >= ADMIN_COMM_PREF_OVERRIDE_NOTIFY_MAX_EMAIL_ATTEMPTS) continue;
    try {
      const r = await retryAdminCommPrefOverrideEmail({
        attempt: row,
        logContext: { job: "retryFailedAdminCommPrefOverrideEmail" },
        now,
      });
      if (r) {
        retried++;
        if (r.status === "sent") sent++;
        if (r.exhausted) exhausted++;
      }
    } catch (err) {
      logger.warn({ err, attemptId: row.id }, "[cron] admin-comm-pref-override email retry threw");
    }
  }

  if (retried > 0) {
    logger.info(
      { retried, sent, exhausted, scanned: candidates.length },
      "[cron] admin-comm-pref-override email retry batch complete",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Task #1507 — Daily admin digest of exhausted wallet/coach-payout notify
// retries.
//
// Both retry pipelines stamp `emailRetryExhaustedAt` / `pushRetryExhaustedAt`
// once a notice burns through every retry (≈2 h 35 min wall clock). The
// underlying refund / coach payout-account swap has already succeeded; the
// member just never heard about it. Without this digest the row sits in the
// table silently and support has no idea who needs an outreach.
//
// Sweep window: 24h. We deliberately do NOT use a calendar-day window — the
// cron fires every 24h on a rolling clock, so picking up "anything stamped
// in the last 24h that hasn't been digested yet" is the right semantic.
// `adminDigestSentAt` prevents the same row from showing up in tomorrow's
// digest if the cron happens to pick it up while it is still inside the 24h
// window.
// ─────────────────────────────────────────────────────────────────────────
const NOTIFY_EXHAUSTION_ADMIN_DIGEST_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const NOTIFY_EXHAUSTION_DIGEST_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Channel labels for the digest (kept stable for the test). */
function describeExhaustedChannels(row: {
  emailRetryExhaustedAt: Date | null;
  pushRetryExhaustedAt: Date | null;
}): string[] {
  const out: string[] = [];
  if (row.emailRetryExhaustedAt) out.push("email");
  if (row.pushRetryExhaustedAt) out.push("push");
  return out;
}

/** Pick the most recent of (email, push) exhaustion stamps. */
function latestExhaustedAt(row: {
  emailRetryExhaustedAt: Date | null;
  pushRetryExhaustedAt: Date | null;
}): Date {
  const e = row.emailRetryExhaustedAt?.getTime() ?? 0;
  const p = row.pushRetryExhaustedAt?.getTime() ?? 0;
  return new Date(Math.max(e, p));
}

export async function sendNotifyExhaustionAdminDigest() {
  const now = new Date();
  const cutoff = new Date(now.getTime() - NOTIFY_EXHAUSTION_DIGEST_LOOKBACK_MS);

  // Pull every wallet-refund row whose email OR push retry was exhausted in
  // the last 24h and which has not yet been included in any digest.
  const walletRows = await db
    .select()
    .from(walletTopupRefundNotifyAttemptsTable)
    .where(and(
      isNull(walletTopupRefundNotifyAttemptsTable.adminDigestSentAt),
      or(
        and(
          isNotNull(walletTopupRefundNotifyAttemptsTable.emailRetryExhaustedAt),
          gte(walletTopupRefundNotifyAttemptsTable.emailRetryExhaustedAt, cutoff),
        ),
        and(
          isNotNull(walletTopupRefundNotifyAttemptsTable.pushRetryExhaustedAt),
          gte(walletTopupRefundNotifyAttemptsTable.pushRetryExhaustedAt, cutoff),
        ),
      ),
    ));

  const coachRows = await db
    .select({
      attempt: coachPayoutAccountChangeNotifyAttemptsTable,
      proName: teachingProsTable.displayName,
    })
    .from(coachPayoutAccountChangeNotifyAttemptsTable)
    .leftJoin(
      teachingProsTable,
      eq(teachingProsTable.id, coachPayoutAccountChangeNotifyAttemptsTable.proId),
    )
    .where(and(
      isNull(coachPayoutAccountChangeNotifyAttemptsTable.adminDigestSentAt),
      or(
        and(
          isNotNull(coachPayoutAccountChangeNotifyAttemptsTable.emailRetryExhaustedAt),
          gte(coachPayoutAccountChangeNotifyAttemptsTable.emailRetryExhaustedAt, cutoff),
        ),
        and(
          isNotNull(coachPayoutAccountChangeNotifyAttemptsTable.pushRetryExhaustedAt),
          gte(coachPayoutAccountChangeNotifyAttemptsTable.pushRetryExhaustedAt, cutoff),
        ),
      ),
    ));

  if (walletRows.length === 0 && coachRows.length === 0) {
    logger.debug("[cron] notify-exhaustion-admin-digest: no exhausted rows in the last 24h");
    return;
  }

  // Group by orgId.
  const orgIds = new Set<number>();
  for (const r of walletRows) orgIds.add(r.organizationId);
  for (const r of coachRows) orgIds.add(r.attempt.organizationId);

  const baseUrl = process.env.APP_BASE_URL
    ?? (process.env.PUBLIC_BASE_URL
      ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`);

  let orgsEmailed = 0;
  let recipientsEmailed = 0;
  let walletItemsDigested = 0;
  let coachItemsDigested = 0;

  for (const orgId of orgIds) {
    const orgWallet = walletRows.filter(r => r.organizationId === orgId);
    const orgCoach = coachRows.filter(r => r.attempt.organizationId === orgId);
    if (orgWallet.length === 0 && orgCoach.length === 0) continue;

    const [org] = await db
      .select({
        id: organizationsTable.id,
        name: organizationsTable.name,
        logoUrl: organizationsTable.logoUrl,
        primaryColor: organizationsTable.primaryColor,
      })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    if (!org) {
      logger.warn({ orgId }, "[cron] notify-exhaustion-admin-digest: org not found, skipping");
      continue;
    }

    // Resolve admin recipients — same RBAC as the bounced-levy digest:
    // direct app_users with role org_admin, plus org_memberships entries
    // whose role is org_admin / membership_secretary / treasurer.
    const directAdmins = await db
      .select({
        userId: appUsersTable.id,
        email: appUsersTable.email,
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
      })
      .from(appUsersTable)
      .where(and(eq(appUsersTable.organizationId, orgId), eq(appUsersTable.role, "org_admin")));
    const memberAdmins = await db
      .select({
        userId: appUsersTable.id,
        email: appUsersTable.email,
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
      })
      .from(orgMembershipsTable)
      .innerJoin(appUsersTable, eq(orgMembershipsTable.userId, appUsersTable.id))
      .where(and(
        eq(orgMembershipsTable.organizationId, orgId),
        inArray(orgMembershipsTable.role, ["org_admin", "membership_secretary", "treasurer"]),
      ));
    const seen = new Set<number>();
    const admins = [...directAdmins, ...memberAdmins].filter(a => {
      if (seen.has(a.userId)) return false;
      seen.add(a.userId);
      return Boolean(a.email);
    });

    const branding = {
      orgId: org.id,
      orgName: org.name,
      logoUrl: org.logoUrl ?? undefined,
      primaryColor: org.primaryColor ?? undefined,
    };

    const walletItems = orgWallet.map(r => ({
      paymentId: r.paymentId,
      refundId: r.refundId,
      currency: r.currency,
      amount: String(r.amount),
      channels: describeExhaustedChannels(r),
      lastError: r.lastEmailError ?? r.lastPushError ?? null,
      exhaustedAt: latestExhaustedAt(r).toISOString(),
    }));

    const coachItems = orgCoach.map(({ attempt, proName }) => ({
      historyId: attempt.historyId,
      proId: attempt.proId,
      coachName: proName ?? `Coach #${attempt.proId}`,
      changeKind: attempt.changeKind,
      method: attempt.method,
      channels: describeExhaustedChannels(attempt),
      lastError: attempt.lastEmailError ?? attempt.lastPushError ?? null,
      exhaustedAt: latestExhaustedAt(attempt).toISOString(),
    }));

    // Task #1855 — durable per-recipient send trail. Replaces the old
    // log-only failure path so a fully-bouncing recipient list no longer
    // looks identical to a healthy one in the dashboard. The new
    // `notify_exhaustion_admin_digest_recipient_sends` table captures
    // sent / failed / paused_suppressed / no_recipients for every run.
    let orgRecipientsEmailed = 0;
    const orgFailedRecipients: string[] = [];
    let orgPausedSnapshots: { email: string; reason: string; bounceType: string | null; description: string | null }[] = [];

    if (admins.length === 0) {
      logger.warn(
        { orgId, walletCount: walletItems.length, coachCount: coachItems.length },
        "[cron] notify-exhaustion-admin-digest: no admin recipients with email — stamping rows anyway",
      );
      await db.insert(notifyExhaustionAdminDigestRecipientSendsTable).values({
        organizationId: orgId,
        recipientUserId: null,
        recipientEmail: "",
        status: "no_recipients",
        errorMessage: "no admin recipients with an email address",
        walletItemCount: walletItems.length,
        coachItemCount: coachItems.length,
        runStartedAt: now,
      }).catch(err => logger.warn(
        { err, orgId },
        "[cron] notify-exhaustion-admin-digest: failed to persist no_recipients row",
      ));
    } else {
      // Task #1855 — bounce-aware recipient pausing. Uses the existing
      // `email_suppressions` table populated by the Postmark bounce
      // webhook (`routes/webhooks.ts`). Addresses on the suppression
      // list are recorded as `paused_suppressed` instead of being
      // re-attempted, mirroring the bounced-levy reminders cron above.
      const adminEmails = admins.map(a => a.email!).filter(Boolean);
      const { pausedRecipientsSnapshot } = await pauseSuppressedRecipients({
        organizationId: orgId,
        configuredRecipients: adminEmails,
        logScope: "notify-exhaustion-admin-digest",
      });
      orgPausedSnapshots = pausedRecipientsSnapshot;
      const pausedLowerToSnap = new Map(
        pausedRecipientsSnapshot.map(s => [s.email.toLowerCase(), s] as const),
      );

      for (const rec of admins) {
        const lower = String(rec.email).toLowerCase();
        const paused = pausedLowerToSnap.get(lower);
        if (paused) {
          await db.insert(notifyExhaustionAdminDigestRecipientSendsTable).values({
            organizationId: orgId,
            recipientUserId: rec.userId,
            recipientEmail: rec.email!,
            status: "paused_suppressed",
            suppressionReason: paused.reason,
            bounceType: paused.bounceType,
            errorMessage: paused.description,
            walletItemCount: walletItems.length,
            coachItemCount: coachItems.length,
            runStartedAt: now,
          }).catch(err => logger.warn(
            { err, orgId, recipient: rec.email },
            "[cron] notify-exhaustion-admin-digest: failed to persist paused row",
          ));
          continue;
        }
        try {
          await sendNotifyExhaustionAdminDigestEmail({
            to: rec.email!,
            staffName: rec.displayName ?? rec.username ?? "Admin",
            baseUrl,
            walletItems,
            coachItems,
            branding,
          });
          orgRecipientsEmailed += 1;
          await db.insert(notifyExhaustionAdminDigestRecipientSendsTable).values({
            organizationId: orgId,
            recipientUserId: rec.userId,
            recipientEmail: rec.email!,
            status: "sent",
            walletItemCount: walletItems.length,
            coachItemCount: coachItems.length,
            runStartedAt: now,
          }).catch(err => logger.warn(
            { err, orgId, recipient: rec.email },
            "[cron] notify-exhaustion-admin-digest: failed to persist sent row",
          ));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const errClass = classifyMailerError(err);
          logger.warn(
            { err, orgId, recipient: rec.email, errClass },
            "[cron] notify-exhaustion-admin-digest email failed",
          );
          orgFailedRecipients.push(rec.email!);
          await db.insert(notifyExhaustionAdminDigestRecipientSendsTable).values({
            organizationId: orgId,
            recipientUserId: rec.userId,
            recipientEmail: rec.email!,
            status: "failed",
            errorMessage: msg.slice(0, 1000),
            errorClass: errClass,
            walletItemCount: walletItems.length,
            coachItemCount: coachItems.length,
            runStartedAt: now,
          }).catch(insErr => logger.warn(
            { err: insErr, orgId, recipient: rec.email },
            "[cron] notify-exhaustion-admin-digest: failed to persist failed row",
          ));
        }
      }
      if (orgRecipientsEmailed > 0) {
        orgsEmailed += 1;
        recipientsEmailed += orgRecipientsEmailed;
      }
    }

    // Task #1855 — super_admin fallback when zero admin recipients
    // received the digest. This catches three failure modes uniformly:
    //   (a) the org has no admin recipients with an email at all,
    //   (b) every admin recipient is on the suppression list,
    //   (c) every non-paused admin's send attempt threw.
    // Without this fallback the per-recipient trail above is the only
    // signal anyone outside the cron's logger.warn line would have to
    // notice. Dispatch goes through `dispatchNotification`, so per-user
    // opt-out (`notifyExhaustionAdminDigestFailed`) is honoured.
    if (orgRecipientsEmailed === 0) {
      await notifySuperAdminsOfExhaustionDigestFailure({
        orgId,
        org: { name: org.name, logoUrl: org.logoUrl, primaryColor: org.primaryColor },
        adminRecipientCount: admins.length,
        pausedRecipients: orgPausedSnapshots.map(s => s.email),
        failedRecipients: orgFailedRecipients,
        walletItemCount: walletItems.length,
        coachItemCount: coachItems.length,
      });
    }

    // Stamp every included row exactly once. We do this even if every send
    // failed: the same broken inboxes will still be broken at the next tick
    // and we'd otherwise re-list the same exhausted rows every day forever.
    if (orgWallet.length > 0) {
      await db.update(walletTopupRefundNotifyAttemptsTable)
        .set({ adminDigestSentAt: now })
        .where(inArray(walletTopupRefundNotifyAttemptsTable.id, orgWallet.map(r => r.id)));
      walletItemsDigested += orgWallet.length;
    }
    if (orgCoach.length > 0) {
      await db.update(coachPayoutAccountChangeNotifyAttemptsTable)
        .set({ adminDigestSentAt: now })
        .where(inArray(coachPayoutAccountChangeNotifyAttemptsTable.id, orgCoach.map(({ attempt }) => attempt.id)));
      coachItemsDigested += orgCoach.length;
    }
  }

  if (orgsEmailed > 0 || walletItemsDigested + coachItemsDigested > 0) {
    logger.info(
      { orgsEmailed, recipientsEmailed, walletItemsDigested, coachItemsDigested },
      "[cron] notify-exhaustion-admin-digest complete",
    );
  }
}

// Task #1855 — super_admin fallback dispatcher for the daily exhaustion
// admin digest cron. Mirrors `notifyAdminsOfBouncedLevyRemindersDigestFailure`
// (cron.ts:1415) but targets `super_admin` role users so the alert
// surfaces above any per-org noise. Routed through `dispatchNotification`
// so the notification audit log + per-user mute via
// `notifyExhaustionAdminDigestFailed` are honoured.
async function notifySuperAdminsOfExhaustionDigestFailure(opts: {
  orgId: number;
  org: { name: string; logoUrl: string | null; primaryColor: string | null };
  adminRecipientCount: number;
  pausedRecipients: string[];
  failedRecipients: string[];
  walletItemCount: number;
  coachItemCount: number;
}): Promise<void> {
  try {
    const superAdmins = await db
      .select({ userId: appUsersTable.id })
      .from(appUsersTable)
      .where(eq(appUsersTable.role, "super_admin"));
    const userIds = Array.from(new Set(
      superAdmins.map(r => r.userId).filter((n): n is number => typeof n === "number"),
    ));
    if (userIds.length === 0) {
      logger.info({ orgId: opts.orgId }, "[notify-exhaustion-admin-digest] no super_admin user ids for failure alert");
      return;
    }

    const orgName = opts.org.name ?? "an organization";
    const reason = opts.adminRecipientCount === 0
      ? "no admin recipients have an email address"
      : opts.pausedRecipients.length > 0 && opts.failedRecipients.length === 0
        ? "every admin recipient is on the suppression list"
        : opts.pausedRecipients.length === 0 && opts.failedRecipients.length > 0
          ? "every admin recipient send attempt failed"
          : "every admin recipient is paused or failed";
    const title = `Daily exhaustion admin digest failed (${orgName})`;
    const pausedLine = opts.pausedRecipients.length > 0
      ? ` Paused recipients on the suppression list: ${opts.pausedRecipients.join(", ")}.`
      : "";
    const failedLine = opts.failedRecipients.length > 0
      ? ` Failed sends: ${opts.failedRecipients.join(", ")}.`
      : "";
    const body = `${reason}. ${opts.walletItemCount} wallet refund + ${opts.coachItemCount} coach payout exhaustion item(s) went unsurfaced for org ${opts.orgId} (${orgName}).${pausedLine}${failedLine} Update the admin recipient list to restore delivery.`;
    const safeTitle = escapeHtmlForBouncedLevyDigestAlert(title);
    const safeBody = escapeHtmlForBouncedLevyDigestAlert(body);
    const emailHtml = `<div style="font-family:Inter,Arial,sans-serif;background:#0a0a0a;color:#fff;padding:24px;max-width:560px;margin:0 auto;border-radius:12px;">
        <h2 style="margin:0 0 12px;font-size:18px;color:#f87171;">${safeTitle}</h2>
        <p style="margin:0 0 16px;color:#d1d5db;line-height:1.5;">${safeBody}</p>
        <p style="margin:24px 0 0;color:#6b7280;font-size:12px;">Org id: ${opts.orgId}</p>
      </div>`;

    await dispatchNotification("notify.exhaustion.admin_digest.failed", userIds, {
      title,
      body,
      emailSubject: title,
      emailHtml,
      data: {
        organizationId: opts.orgId,
        adminRecipientCount: opts.adminRecipientCount,
        pausedRecipients: opts.pausedRecipients,
        failedRecipients: opts.failedRecipients,
        walletItemCount: opts.walletItemCount,
        coachItemCount: opts.coachItemCount,
      },
      branding: {
        orgName,
        logoUrl: opts.org.logoUrl ?? undefined,
        primaryColor: opts.org.primaryColor ?? undefined,
        orgId: opts.orgId,
      },
    });
  } catch (err) {
    logger.warn({ err, orgId: opts.orgId }, "[notify-exhaustion-admin-digest] super_admin failure dispatch failed");
  }
}

/**
 * Auto-generate billing cycles for active vendor contracts at the start of each period.
 *
 * Logic:
 *  - Runs daily
 *  - For each active contract, determines if a billing cycle should be opened today
 *    based on billingFrequency (monthly | quarterly | annual)
 *  - Does NOT generate a duplicate if an open cycle already exists for this period
 *  - Automatically creates an invoice linked to the cycle
 *  - Revenue-share base = grossSales only (POS transaction totals); no double-count
 */
async function autoGenerateVendorBillingCycles() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // start of today UTC-naive
  let generated = 0;

  const contracts = await db
    .select({ contract: vendorContractsTable, vendor: vendorOperatorsTable })
    .from(vendorContractsTable)
    .innerJoin(vendorOperatorsTable, eq(vendorContractsTable.vendorOperatorId, vendorOperatorsTable.id))
    .where(eq(vendorContractsTable.status, "active"));

  for (const { contract, vendor } of contracts) {
    try {
      // Determine current period start and end
      let periodStart: Date;
      let periodEnd: Date;

      // vendor_billing_frequency enum: "monthly" | "annual"
      if (contract.billingFrequency === "monthly") {
        periodStart = new Date(today.getFullYear(), today.getMonth(), 1);
        periodEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999);
      } else { // annual
        periodStart = new Date(today.getFullYear(), 0, 1);
        periodEnd = new Date(today.getFullYear(), 11, 31, 23, 59, 59, 999);
      }

      // Only run on the first day of the period
      const isFirstDayOfPeriod = today.getTime() === periodStart.getTime();
      if (!isFirstDayOfPeriod) continue;

      // Skip if a cycle already exists for this exact period start (idempotency)
      const [exactExisting] = await db
        .select({ id: vendorBillingCyclesTable.id })
        .from(vendorBillingCyclesTable)
        .where(and(
          eq(vendorBillingCyclesTable.vendorContractId, contract.id),
          eq(vendorBillingCyclesTable.organizationId, contract.organizationId),
          eq(vendorBillingCyclesTable.periodStart, periodStart),
        ))
        .limit(1);

      if (exactExisting) continue;

      // Tally POS gross sales for this vendor in the period (completed transactions only)
      const [posAgg] = await db
        .select({ total: sum(posTransactionsTable.totalAmount) })
        .from(posTransactionsTable)
        .where(and(
          eq(posTransactionsTable.organizationId, contract.organizationId),
          eq(posTransactionsTable.vendorOperatorId, contract.vendorOperatorId),
          gte(posTransactionsTable.transactedAt, periodStart),
          lte(posTransactionsTable.transactedAt, periodEnd),
          eq(posTransactionsTable.status, "completed"),
        ));
      const grossSales = parseFloat(String(posAgg?.total ?? 0));

      // Tally member account charges for this vendor in the period
      const [macAgg] = await db
        .select({ total: sum(memberAccountChargesTable.amount) })
        .from(memberAccountChargesTable)
        .where(and(
          eq(memberAccountChargesTable.organizationId, contract.organizationId),
          eq(memberAccountChargesTable.vendorOperatorId, contract.vendorOperatorId),
          gte(memberAccountChargesTable.createdAt, periodStart),
          lte(memberAccountChargesTable.createdAt, periodEnd),
        ));
      const memberChargesTotal = parseFloat(String(macAgg?.total ?? 0));

      // Calculate billing amounts (rev-share on grossSales only, no double-count)
      let revenueShareAmount = 0;
      let fixedFeeAmt = 0;
      const revShareBase = grossSales;
      const fixedFeeAmount = parseFloat(String(contract.fixedFeeAmount ?? 0));
      const revenueSharePct = parseFloat(String(contract.revenueSharePct ?? 0));
      const revenueShareThreshold = contract.revenueShareThreshold != null ? parseFloat(String(contract.revenueShareThreshold)) : null;

      if (contract.billingModel === "fixed") {
        fixedFeeAmt = fixedFeeAmount;
      } else if (contract.billingModel === "revenue_share") {
        revenueShareAmount = (revShareBase * revenueSharePct) / 100;
      } else if (contract.billingModel === "hybrid") {
        fixedFeeAmt = fixedFeeAmount;
        const threshold = revenueShareThreshold ?? 0;
        if (revShareBase > threshold) {
          revenueShareAmount = ((revShareBase - threshold) * revenueSharePct) / 100;
        }
      }
      const netAmountDue = fixedFeeAmt + revenueShareAmount;

      // Create billing cycle (no status column in vendorBillingCyclesTable — track status via linked invoice)
      const [cycle] = await db.insert(vendorBillingCyclesTable).values({
        organizationId: contract.organizationId,
        vendorOperatorId: contract.vendorOperatorId,
        vendorContractId: contract.id,
        periodStart,
        periodEnd,
        grossSales: String(grossSales),
        memberChargesTotal: String(memberChargesTotal),
        revenueShareAmount: String(revenueShareAmount),
        fixedFeeAmount: String(fixedFeeAmt),
        netAmountDue: String(netAmountDue),
        currency: "INR",
      }).returning();

      // Always create an invoice record per billing cycle (even zero-amount) for formal statement trail
      {
        // Generate sequential invoice number
        const [last] = await db
          .select({ invoiceNumber: vendorInvoicesTable.invoiceNumber })
          .from(vendorInvoicesTable)
          .where(eq(vendorInvoicesTable.organizationId, contract.organizationId))
          .orderBy(sql`created_at desc`)
          .limit(1);
        const n = last ? parseInt(last.invoiceNumber.replace(/\D/g, "") || "0") + 1 : 1;
        const invoiceNumber = `VND-${String(contract.organizationId).padStart(3, "0")}-${String(n).padStart(4, "0")}`;

        const dueDate = new Date(periodEnd.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days after period end
        // Zero-amount cycles get status "paid" immediately (no payment needed)
        const invoiceStatus = netAmountDue === 0 ? "paid" : "unpaid";
        await db.insert(vendorInvoicesTable).values({
          organizationId: contract.organizationId,
          vendorOperatorId: contract.vendorOperatorId,
          vendorBillingCycleId: cycle.id,
          invoiceNumber,
          totalAmount: String(netAmountDue),
          dueDate,
          status: invoiceStatus,
        });
      }

      generated++;
      logger.info({ orgId: contract.organizationId, vendorId: contract.vendorOperatorId, contractId: contract.id, grossSales, netAmountDue }, "[cron] auto billing cycle generated");
    } catch (cycleErr) {
      logger.warn({ cycleErr, contractId: contract.id, vendorName: vendor.name }, "[cron] auto billing cycle generation failed for contract");
    }
  }

  if (generated > 0) {
    logger.info({ generated }, "[cron] vendor billing cycles auto-generated");
  }
}

// ─── TEE SHEET ROLLING WINDOW MATERIALIZATION ────────────────────────────────
const TEE_ROLLING_WINDOW_DAYS = 60;

/**
 * Materialise tee time slots for all active orgs and their courses
 * for each day entering the rolling window (60 days ahead).
 * Uses INSERT ... ON CONFLICT DO NOTHING so re-runs are completely safe.
 */
async function materializeRollingWindow() {
  const orgs = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable)
    .where(eq(organizationsTable.isActive, true));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const targetDate = new Date(today.getTime() + TEE_ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  let succeeded = 0;
  for (const org of orgs) {
    try {
      await materializeAllCoursesForDate(org.id, targetDate);
      succeeded++;
    } catch (err) {
      logger.warn({ err, orgId: org.id }, "[cron] tee materialize failed for org");
    }
  }

  logger.info({ succeeded, total: orgs.length, targetDate }, "[cron] tee sheet rolling window materialization complete");
}

/**
 * Daily low-stock alert job.
 * Finds all shop variant stock entries that are at or below their reorder point
 * and logs a summary alert per organisation. Pushes an in-app notification to
 * org admins for orgs that have any below-reorder variants.
 */
async function checkLowStockAlerts() {
  const allBelowReorder = await db
    .select({
      variantId: shopVariantStockTable.variantId,
      locationId: shopVariantStockTable.locationId,
      quantity: shopVariantStockTable.quantity,
      reorderPoint: shopVariantStockTable.reorderPoint,
      reorderQty: shopVariantStockTable.reorderQty,
      organizationId: shopProductsTable.organizationId,
      productName: shopProductsTable.name,
      locationName: shopLocationsTable.name,
    })
    .from(shopVariantStockTable)
    .leftJoin(shopProductVariantsTable, eq(shopVariantStockTable.variantId, shopProductVariantsTable.id))
    .leftJoin(shopProductsTable, eq(shopProductVariantsTable.productId, shopProductsTable.id))
    .leftJoin(shopLocationsTable, eq(shopVariantStockTable.locationId, shopLocationsTable.id))
    .where(
      sql`${shopVariantStockTable.reorderPoint} IS NOT NULL
          AND ${shopVariantStockTable.quantity} <= ${shopVariantStockTable.reorderPoint}`
    );

  if (allBelowReorder.length === 0) {
    logger.info("[cron] low-stock check: no items below reorder point");
    return;
  }

  // Group by org
  const byOrg = new Map<number, typeof allBelowReorder>();
  for (const row of allBelowReorder) {
    if (!row.organizationId) continue;
    if (!byOrg.has(row.organizationId)) byOrg.set(row.organizationId, []);
    byOrg.get(row.organizationId)!.push(row);
  }

  for (const [orgId, alerts] of byOrg.entries()) {
    logger.warn(
      { orgId, count: alerts.length, items: alerts.map(a => ({ product: a.productName, location: a.locationName, qty: a.quantity, reorderAt: a.reorderPoint })) },
      "[cron] low-stock alert: items below reorder point",
    );

    // Push notification + email to org admins
    // Union: users with org_admin role on app_users (direct orgId) + org_memberships admins.
    // Task #1951 — Pull real first/last names from `club_members` (joined via
    // userId, scoped to this org) so the email greeting shows a real admin
    // name instead of falling back to "Admin". `app_users` itself doesn't have
    // first/last name columns; `display_name` is used as a secondary fallback
    // for staff who aren't also on the club roster.
    try {
      const directAdmins = await db
        .select({
          userId: appUsersTable.id,
          email: appUsersTable.email,
          displayName: appUsersTable.displayName,
          firstName: clubMembersTable.firstName,
          lastName: clubMembersTable.lastName,
        })
        .from(appUsersTable)
        .leftJoin(
          clubMembersTable,
          and(
            eq(clubMembersTable.userId, appUsersTable.id),
            eq(clubMembersTable.organizationId, orgId),
          ),
        )
        .where(and(eq(appUsersTable.organizationId, orgId), eq(appUsersTable.role, "org_admin")));
      const memberAdmins = await db
        .select({
          userId: appUsersTable.id,
          email: appUsersTable.email,
          displayName: appUsersTable.displayName,
          firstName: clubMembersTable.firstName,
          lastName: clubMembersTable.lastName,
        })
        .from(orgMembershipsTable)
        .innerJoin(appUsersTable, eq(orgMembershipsTable.userId, appUsersTable.id))
        .leftJoin(
          clubMembersTable,
          and(
            eq(clubMembersTable.userId, appUsersTable.id),
            eq(clubMembersTable.organizationId, orgId),
          ),
        )
        .where(and(
          eq(orgMembershipsTable.organizationId, orgId),
          inArray(orgMembershipsTable.role, ["org_admin", "tournament_director"]),
        ));
      // Deduplicate by userId, preferring rows that did resolve a club_members
      // first/last name over rows that only have a displayName fallback.
      const byUserId = new Map<number, typeof directAdmins[number]>();
      for (const row of [...directAdmins, ...memberAdmins]) {
        const existing = byUserId.get(row.userId);
        if (!existing) {
          byUserId.set(row.userId, row);
          continue;
        }
        if (!existing.firstName && !existing.lastName && (row.firstName || row.lastName)) {
          byUserId.set(row.userId, row);
        }
      }
      const admins = [...byUserId.values()];
      const userIds = admins.map(a => a.userId);
      if (userIds.length > 0) {
        await sendTransactionalPush(
          userIds,
          "⚠️ Low Stock Alert",
          `${alerts.length} product${alerts.length !== 1 ? "s" : ""} ${alerts.length !== 1 ? "are" : "is"} below reorder point and need restocking.`,
          { type: "low_stock_alert", orgId: String(orgId), count: String(alerts.length) },
        );
      }
      // Email summary to each admin with an email address.
      // Prefer club_members first/last (real names). Otherwise split a
      // displayName like "Jane Smith" into first/last so the greeting still
      // reads naturally. Final fallback is "Admin" / blank.
      const emailRecipients = admins.filter(a => a.email).map(a => {
        if (a.firstName || a.lastName) {
          return {
            firstName: a.firstName ?? "",
            lastName: a.lastName ?? "",
            email: a.email!,
          };
        }
        const display = a.displayName?.trim() ?? "";
        if (display) {
          const [first, ...rest] = display.split(/\s+/);
          return {
            firstName: first,
            lastName: rest.join(" "),
            email: a.email!,
          };
        }
        return { firstName: "Admin", lastName: "", email: a.email! };
      });
      if (emailRecipients.length > 0) {
        const alertLines = alerts.map(a =>
          `• ${a.productName ?? "Unknown product"} at ${a.locationName ?? "Unknown location"}: ${a.quantity} in stock (reorder at ${a.reorderPoint})`
        ).join("\n");
        await sendBroadcast(emailRecipients, {
          channels: ["email"],
          subject: `⚠️ Low Stock Alert — ${alerts.length} item${alerts.length !== 1 ? "s" : ""} need restocking`,
          body: `The following inventory items are at or below their reorder point:\n\n${alertLines}\n\nPlease raise a purchase order to replenish stock.`,
          eventName: "Inventory Management",
          // Task #1566 — tag low-stock alert emails with the originating
          // club so the Postmark bounce webhook (Task #981) can attribute
          // hard bounces back to this org instantly.
          organizationId: orgId,
        }).catch(err => logger.warn({ err, orgId }, "[cron] low-stock email notification failed"));
      }
    } catch (err) {
      logger.warn({ err, orgId }, "[cron] low-stock push notification failed");
    }
  }

  logger.info({ totalAlerts: allBelowReorder.length, orgsAffected: byOrg.size }, "[cron] low-stock check complete");
}

/**
 * Track which (productId, saleStart) pairs have already had a push notification fired,
 * to avoid duplicate sends across polling intervals within the same process run.
 */
const notifiedFlashSales = new Set<string>();

/**
 * Dispatch push notifications when a flash sale becomes active.
 * Runs every 5 minutes. Sends to all members in the org who have push tokens.
 */
async function dispatchFlashSaleNotifications() {
  const now = new Date();
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

  const activeFlashSales = await db.select({
    id: shopProductsTable.id,
    name: shopProductsTable.name,
    markupPrice: shopProductsTable.markupPrice,
    salePrice: shopProductsTable.salePrice,
    saleStart: shopProductsTable.saleStart,
    saleEnd: shopProductsTable.saleEnd,
    organizationId: shopProductsTable.organizationId,
  }).from(shopProductsTable)
    .where(and(
      isNotNull(shopProductsTable.salePrice),
      isNotNull(shopProductsTable.saleStart),
      isNotNull(shopProductsTable.saleEnd),
      gte(shopProductsTable.saleStart, fiveMinutesAgo),
      lte(shopProductsTable.saleStart, now),
      gte(shopProductsTable.saleEnd, now),
      eq(shopProductsTable.isActive, true),
    ));

  for (const product of activeFlashSales) {
    if (!product.saleStart) continue;
    const key = `${product.id}:${product.saleStart.toISOString()}`;
    if (notifiedFlashSales.has(key)) continue;
    notifiedFlashSales.add(key);

    // Find org members who are app users.
    // sendTransactionalPush only delivers to users with a registered device token,
    // which requires the user to have explicitly granted OS notification permission —
    // this serves as the push opt-in filter (no token = no delivery).
    const orgMembers = await db.selectDistinct({ userId: orgMembershipsTable.userId })
      .from(orgMembershipsTable)
      .where(and(
        eq(orgMembershipsTable.organizationId, product.organizationId),
        isNotNull(orgMembershipsTable.userId),
      ));

    const userIds = orgMembers.map(m => m.userId).filter((id): id is number => id !== null);
    if (userIds.length === 0) continue;

    const regularPrice = parseFloat(product.markupPrice);
    const salePrice = parseFloat(String(product.salePrice));
    const pctOff = regularPrice > 0 ? Math.round((1 - salePrice / regularPrice) * 100) : 0;

    await sendTransactionalPush(
      userIds,
      `⚡ Flash Sale: ${product.name}`,
      `${pctOff}% off — only ₹${salePrice.toLocaleString('en-IN')} (was ₹${regularPrice.toLocaleString('en-IN')}). Sale ends ${product.saleEnd ? new Date(product.saleEnd).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : 'soon'}!`,
      { type: "flash_sale", productId: product.id, salePrice: String(product.salePrice) },
    ).catch((err: unknown) => {
      logger.warn({ err, productId: product.id }, "[cron] flash-sale push notification failed");
    });

    logger.info({ productId: product.id, name: product.name, userIds: userIds.length }, "[cron] flash-sale push notification sent");
  }

  // Category flash sales — notify when a category sale starts within the poll window
  const activeCategoryFlashSales = await db.select().from(shopCategoryFlashSalesTable)
    .where(and(
      isNotNull(shopCategoryFlashSalesTable.saleStart),
      isNotNull(shopCategoryFlashSalesTable.saleEnd),
      gte(shopCategoryFlashSalesTable.saleStart, fiveMinutesAgo),
      lte(shopCategoryFlashSalesTable.saleStart, now),
      gte(shopCategoryFlashSalesTable.saleEnd, now),
      eq(shopCategoryFlashSalesTable.isActive, true),
    ));

  for (const sale of activeCategoryFlashSales) {
    const key = `cat:${sale.id}:${sale.saleStart.toISOString()}`;
    if (notifiedFlashSales.has(key)) continue;
    notifiedFlashSales.add(key);

    // sendTransactionalPush only delivers to users with a registered device token
    // (requires explicit OS notification permission) — this is the push opt-in filter.
    const orgMembers = await db.selectDistinct({ userId: orgMembershipsTable.userId })
      .from(orgMembershipsTable)
      .where(and(
        eq(orgMembershipsTable.organizationId, sale.organizationId),
        isNotNull(orgMembershipsTable.userId),
      ));

    const userIds = orgMembers.map(m => m.userId).filter((id): id is number => id !== null);
    if (userIds.length === 0) continue;

    const pctOff = parseFloat(String(sale.discountPct));
    const title = sale.label ?? `${sale.category} Flash Sale`;
    await sendTransactionalPush(
      userIds,
      `⚡ Flash Sale: ${title}`,
      `${pctOff}% off all ${sale.category} items in the shop! Sale ends ${new Date(sale.saleEnd).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}.`,
      { type: "category_flash_sale", category: sale.category, discountPct: String(sale.discountPct) },
    ).catch((err: unknown) => {
      logger.warn({ err, saleId: sale.id }, "[cron] category flash-sale push notification failed");
    });

    logger.info({ saleId: sale.id, category: sale.category, userIds: userIds.length }, "[cron] category flash-sale push notification sent");
  }
}
