/**
 * Task #2008 — Centralized helpers for the 25 branded `dispatchNotification`
 * keys whose renderers exist in `notificationEmailTemplates.ts` but had no
 * production call site before this task.
 *
 * Every helper here contains exactly one literal
 * `dispatchNotification("<branded.key>", …)` call with the CTA URL alias
 * (per `tests/_fixtures/notificationEmailExpectations.ts → CTA_EXPECTATIONS`)
 * populated in `payload.data`, so the
 *   - branded email renders its CTA button and
 *   - codebase-wide guard rail in
 *     `notification-dispatch-and-digest.test.ts` (and the new
 *     `notification-branded-dispatch-coverage.test.ts`)
 * both pass.
 *
 * Each helper is a thin wrapper around `dispatchNotification` that:
 *   - normalises the CTA URL (relative paths are expanded against
 *     {@link buildPublicBaseUrl}),
 *   - logs and swallows delivery errors so a notify failure can never
 *     break the surrounding event path (mirrors the `.catch(() => {})`
 *     pattern used elsewhere for `sendPushToUsers`),
 *   - is a no-op when `userIds` is empty (most call sites can't be
 *     bothered to pre-filter and we don't want to issue an empty
 *     dispatch).
 *
 * Wiring is intentionally minimal — each helper is invoked from the
 * single most-natural production event path (route handler, cron tick,
 * achievement awarder, etc.). See `notificationDispatchCoverage.ts` for
 * the per-key event path.
 */
import { dispatchNotification, type DispatchResult } from "./notifyDispatch.js";
import type { EmailBranding } from "./mailer.js";
import { logger } from "./logger.js";

/**
 * Resolve the public base URL the CTA buttons should hang off. Mirrors
 * the env-var precedence used in `notifyDispatch.ts` and `cron.ts`:
 *   1. `PUBLIC_BASE_URL` if explicitly set,
 *   2. else `https://${REPLIT_DEV_DOMAIN}` while developing on Replit,
 *   3. else the production domain.
 */
export function buildPublicBaseUrl(): string {
  const explicit = process.env.PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const dev = process.env.REPLIT_DEV_DOMAIN?.trim();
  if (dev) return `https://${dev}`;
  return "https://kharagolf.com";
}

/** Expand a relative path into an absolute https URL for email CTA buttons. */
export function absoluteUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = buildPublicBaseUrl();
  return pathOrUrl.startsWith("/") ? `${base}${pathOrUrl}` : `${base}/${pathOrUrl}`;
}

interface BaseOpts {
  /** Recipient app-user ids. */
  userIds: number[];
  /** Optional org branding (logo / primary colour / orgName). */
  branding?: EmailBranding;
}

function logFailure(key: string) {
  return (err: unknown) => {
    logger.warn({ err, key }, "[branded-notify] dispatch failed");
  };
}

// ───────────────────────────── Player engagement ─────────────────────────────

export interface AchievementUnlockedOpts extends BaseOpts {
  achievementName: string;
  description?: string;
  /** Deep link to the achievement detail screen. */
  achievementUrl?: string;
}
export async function notifyAchievementUnlocked(opts: AchievementUnlockedOpts): Promise<void> {
  if (opts.userIds.length === 0) return;
  const achievementUrl = absoluteUrl(opts.achievementUrl ?? "/portal/profile/achievements");
  await dispatchNotification("achievement.unlocked", opts.userIds, {
    title: `Achievement unlocked: ${opts.achievementName}`,
    body: opts.description ?? "Tap to view your new badge.",
    branding: opts.branding,
    data: {
      type: "achievement_unlocked",
      achievementName: opts.achievementName,
      description: opts.description,
      achievementUrl,
    },
  }).catch(logFailure("achievement.unlocked"));
}

export interface HighlightReadyOpts extends BaseOpts {
  highlightId: number | string;
  highlightTitle?: string;
  highlightUrl?: string;
}
export async function notifyHighlightReady(opts: HighlightReadyOpts): Promise<void> {
  if (opts.userIds.length === 0) return;
  const highlightUrl = absoluteUrl(opts.highlightUrl ?? `/portal/highlights/${opts.highlightId}`);
  await dispatchNotification("highlight.ready", opts.userIds, {
    title: opts.highlightTitle ?? "Your highlight is ready",
    body: "Your highlight reel finished rendering — tap to watch and share.",
    branding: opts.branding,
    data: {
      type: "highlight_ready",
      highlightId: String(opts.highlightId),
      highlightUrl,
    },
  }).catch(logFailure("highlight.ready"));
}

export interface RecapYearReadyOpts extends BaseOpts {
  year: number;
  recapUrl?: string;
}
export async function notifyRecapYearReady(opts: RecapYearReadyOpts): Promise<void> {
  if (opts.userIds.length === 0) return;
  const recapUrl = absoluteUrl(opts.recapUrl ?? `/portal/recap/${opts.year}`);
  await dispatchNotification("recap.year.ready", opts.userIds, {
    title: `Your ${opts.year} Year in Golf is ready`,
    body: `Tap to relive your ${opts.year} season — rounds, milestones and bests.`,
    branding: opts.branding,
    data: {
      type: "recap_year_ready",
      year: opts.year,
      recapUrl,
    },
  }).catch(logFailure("recap.year.ready"));
}

export interface StreakMilestoneOpts extends BaseOpts {
  streakDays: number;
  streakUrl?: string;
}
export async function notifyStreakMilestone(opts: StreakMilestoneOpts): Promise<void> {
  if (opts.userIds.length === 0) return;
  const streakUrl = absoluteUrl(opts.streakUrl ?? "/portal/profile/streaks");
  await dispatchNotification("streak.milestone", opts.userIds, {
    title: `${opts.streakDays}-day playing streak!`,
    body: `You've kept your golf streak alive for ${opts.streakDays} days. Keep it going!`,
    branding: opts.branding,
    data: {
      type: "streak_milestone",
      streakDays: opts.streakDays,
      streakUrl,
    },
  }).catch(logFailure("streak.milestone"));
}

export interface NearMissOpts extends BaseOpts {
  /**
   * The badge / achievement that the player narrowly missed. Rendered as
   * the headline subject by the branded `near.miss` email template.
   */
  achievementName: string;
  /**
   * Gap between the player's current state and the unlock threshold,
   * formatted for display (e.g. "1" round, "0.3" strokes). Falls back
   * to the renderer's default ("a hair") if omitted.
   */
  gap?: string;
  /** Optional deep link to the player's profile / badge progress page. */
  profileUrl?: string;
}
export async function notifyNearMiss(opts: NearMissOpts): Promise<void> {
  if (opts.userIds.length === 0) return;
  const profileUrl = absoluteUrl(opts.profileUrl ?? "/portal/profile/badges");
  await dispatchNotification("near.miss", opts.userIds, {
    title: "So close!",
    body: opts.gap
      ? `You're just ${opts.gap} away from unlocking "${opts.achievementName}".`
      : `You're just shy of unlocking "${opts.achievementName}".`,
    branding: opts.branding,
    data: {
      type: "near_miss",
      achievementName: opts.achievementName,
      gap: opts.gap,
      profileUrl,
    },
  }).catch(logFailure("near.miss"));
}

// Task #2040 — daily "you closed the gap" coaching encouragement push.
// Fired by `runCoachingGapClosedDailySweep` in `lib/cron.ts` when a
// player's proximity-vs-tour trend on a club has improved by at least
// `TREND_ENCOURAGEMENT_FT` (1.5 ft) between the prior 30-day window
// and the current 30-day window — the same threshold the AI Caddie uses
// to flip its hint to encouragement (`computeProximityCoachingTips` in
// `lib/strokes-gained.ts`). Push-only by registry policy
// (`defaultChannels: ["push"]`); the email channel intentionally has no
// branded template — the encouragement nudge belongs in the home-screen
// surface, not the inbox. Per-event opt-out is wired through
// `notify_coaching_tip_closed` so a `false` value short-circuits to
// audit-only without affecting the global `preferPush` toggle.
export interface CoachingGapClosedOpts extends BaseOpts {
  /** Display label for the club (e.g. "7-iron"). */
  clubLabel: string;
  /** Stable key the stats tab uses to scroll to the right club row. */
  clubKey: string;
  /**
   * How many feet closer to tour the player got, expressed as a
   * positive number for display (the underlying `trendVsTourFt` is
   * negative). Rounded to one decimal by the caller.
   */
  improvedByFt: number;
  /**
   * Optional override for the deep link. Defaults to the stats tab
   * scrolled to the relevant club via `?club=<clubKey>` so the mobile
   * push handler and the web portal land the player in the same place.
   */
  statsUrl?: string;
}
// Returns the raw `DispatchResult` (or `null` for an empty recipient
// list) so the cron caller in `runCoachingGapClosedDailySweep` can gate
// its 14-day per-club dedup row on a real push delivery — opted-out,
// skipped, or failed pushes must NOT suppress tomorrow's retry. We
// intentionally do NOT swallow errors here (unlike the other helpers in
// this file): the caller wraps the whole tip loop in try/catch and
// needs the throw to skip the audit insert on a hard dispatch failure.
export async function notifyCoachingGapClosed(opts: CoachingGapClosedOpts): Promise<DispatchResult | null> {
  if (opts.userIds.length === 0) return null;
  const statsUrl = absoluteUrl(opts.statsUrl ?? `/portal/stats?club=${encodeURIComponent(opts.clubKey)}`);
  const ftLabel = `${opts.improvedByFt.toFixed(1)} ft`;
  return dispatchNotification("coaching.gap.closed", opts.userIds, {
    title: `You closed the gap with your ${opts.clubLabel}`,
    body: `Your ${opts.clubLabel} is ${ftLabel} closer to tour vs the prior 30 days — keep it up!`,
    branding: opts.branding,
    data: {
      type: "coaching_gap_closed",
      clubKey: opts.clubKey,
      clubLabel: opts.clubLabel,
      improvedByFt: opts.improvedByFt,
      statsUrl,
    },
  });
}

export interface ScoringEventOpts extends BaseOpts {
  roundId: number | string;
  holeNumber: number;
  /** Deep link to the highlight clip / scorecard hole detail. */
  highlightUrl?: string;
}
export async function notifyScoringEventEagle(opts: ScoringEventOpts): Promise<void> {
  if (opts.userIds.length === 0) return;
  const highlightUrl = absoluteUrl(opts.highlightUrl ?? `/portal/rounds/${opts.roundId}/holes/${opts.holeNumber}`);
  await dispatchNotification("scoring.event.eagle", opts.userIds, {
    title: "Eagle!",
    body: `You carded an eagle on hole ${opts.holeNumber}. Outstanding play!`,
    branding: opts.branding,
    data: {
      type: "scoring_event_eagle",
      roundId: String(opts.roundId),
      holeNumber: opts.holeNumber,
      highlightUrl,
    },
  }).catch(logFailure("scoring.event.eagle"));
}

export async function notifyScoringEventHoleInOne(opts: ScoringEventOpts): Promise<void> {
  if (opts.userIds.length === 0) return;
  const highlightUrl = absoluteUrl(opts.highlightUrl ?? `/portal/rounds/${opts.roundId}/holes/${opts.holeNumber}`);
  await dispatchNotification("scoring.event.hole_in_one", opts.userIds, {
    title: "HOLE IN ONE!",
    body: `Unbelievable — you aced hole ${opts.holeNumber}!`,
    branding: opts.branding,
    data: {
      type: "scoring_event_hole_in_one",
      roundId: String(opts.roundId),
      holeNumber: opts.holeNumber,
      highlightUrl,
    },
  }).catch(logFailure("scoring.event.hole_in_one"));
}

export interface LeaderboardPositionChangeOpts extends BaseOpts {
  tournamentId: number | string;
  newPosition: number;
  previousPosition: number;
  leaderboardUrl?: string;
}
export async function notifyLeaderboardPositionChange(opts: LeaderboardPositionChangeOpts): Promise<void> {
  if (opts.userIds.length === 0) return;
  const leaderboardUrl = absoluteUrl(opts.leaderboardUrl ?? `/portal/tournaments/${opts.tournamentId}/leaderboard`);
  const direction = opts.newPosition < opts.previousPosition ? "up" : "down";
  await dispatchNotification("leaderboard.position.change", opts.userIds, {
    title: `Leaderboard: you moved ${direction} to T${opts.newPosition}`,
    body: `Your position changed from T${opts.previousPosition} to T${opts.newPosition}.`,
    branding: opts.branding,
    data: {
      type: "leaderboard_position_change",
      tournamentId: String(opts.tournamentId),
      newPosition: opts.newPosition,
      previousPosition: opts.previousPosition,
      leaderboardUrl,
    },
  }).catch(logFailure("leaderboard.position.change"));
}

export interface PostRoundResultsOpts extends BaseOpts {
  roundId: number | string;
  grossScore?: number;
  netScore?: number;
  roundUrl?: string;
}
export async function notifyPostRoundResults(opts: PostRoundResultsOpts): Promise<void> {
  if (opts.userIds.length === 0) return;
  const roundUrl = absoluteUrl(opts.roundUrl ?? `/portal/rounds/${opts.roundId}`);
  await dispatchNotification("post.round.results", opts.userIds, {
    title: "Your round is finalised",
    body: opts.grossScore !== undefined
      ? `Gross ${opts.grossScore}${opts.netScore !== undefined ? ` • Net ${opts.netScore}` : ""}. Tap to see your full scorecard.`
      : "Your round results are ready.",
    branding: opts.branding,
    data: {
      type: "post_round_results",
      roundId: String(opts.roundId),
      grossScore: opts.grossScore,
      netScore: opts.netScore,
      roundUrl,
    },
  }).catch(logFailure("post.round.results"));
}

// ───────────────────────────── Bookings / tee sheet ─────────────────────────────

export interface BookingOpts extends BaseOpts {
  bookingId: number | string;
  orgName?: string;
  slotDate?: Date;
  slotTime?: string;
  bookingUrl?: string;
}
export async function notifyBookingConfirmed(opts: BookingOpts): Promise<void> {
  if (opts.userIds.length === 0) return;
  const bookingUrl = absoluteUrl(opts.bookingUrl ?? `/portal/bookings/${opts.bookingId}`);
  await dispatchNotification("booking.confirmed", opts.userIds, {
    title: "Tee booking confirmed",
    body: opts.orgName && opts.slotTime
      ? `Your tee time at ${opts.orgName} is confirmed for ${opts.slotTime}.`
      : "Your tee booking is confirmed.",
    branding: opts.branding,
    data: {
      type: "booking_confirmed",
      bookingId: String(opts.bookingId),
      orgName: opts.orgName,
      slotDate: opts.slotDate?.toISOString(),
      slotTime: opts.slotTime,
      bookingUrl,
    },
  }).catch(logFailure("booking.confirmed"));
}

export async function notifyBookingCancelled(opts: BookingOpts & { cancellationReason?: string }): Promise<void> {
  if (opts.userIds.length === 0) return;
  const bookingUrl = absoluteUrl(opts.bookingUrl ?? `/portal/bookings/${opts.bookingId}`);
  await dispatchNotification("booking.cancelled", opts.userIds, {
    title: "Tee booking cancelled",
    body: opts.cancellationReason
      ? `Your booking was cancelled: ${opts.cancellationReason}`
      : "Your tee booking has been cancelled.",
    branding: opts.branding,
    data: {
      type: "booking_cancelled",
      bookingId: String(opts.bookingId),
      orgName: opts.orgName,
      slotDate: opts.slotDate?.toISOString(),
      slotTime: opts.slotTime,
      cancellationReason: opts.cancellationReason,
      bookingUrl,
    },
  }).catch(logFailure("booking.cancelled"));
}

export async function notifyBooking24hReminder(opts: BookingOpts): Promise<void> {
  if (opts.userIds.length === 0) return;
  const bookingUrl = absoluteUrl(opts.bookingUrl ?? `/portal/bookings/${opts.bookingId}`);
  await dispatchNotification("booking.reminder.24h", opts.userIds, {
    title: "Tee time tomorrow",
    body: opts.orgName && opts.slotTime
      ? `Your tee time at ${opts.orgName} is tomorrow at ${opts.slotTime}.`
      : "Your tee time is tomorrow.",
    branding: opts.branding,
    data: {
      type: "booking_reminder_24h",
      bookingId: String(opts.bookingId),
      orgName: opts.orgName,
      slotDate: opts.slotDate?.toISOString(),
      slotTime: opts.slotTime,
      bookingUrl,
    },
  }).catch(logFailure("booking.reminder.24h"));
}

export async function notifyBooking2hReminder(opts: BookingOpts): Promise<void> {
  if (opts.userIds.length === 0) return;
  const bookingUrl = absoluteUrl(opts.bookingUrl ?? `/portal/bookings/${opts.bookingId}`);
  await dispatchNotification("booking.reminder.2h", opts.userIds, {
    title: "Tee time in 2 hours",
    body: opts.orgName && opts.slotTime
      ? `Your tee time at ${opts.orgName} starts at ${opts.slotTime}.`
      : "Your tee time starts in 2 hours.",
    branding: opts.branding,
    data: {
      type: "booking_reminder_2h",
      bookingId: String(opts.bookingId),
      orgName: opts.orgName,
      slotDate: opts.slotDate?.toISOString(),
      slotTime: opts.slotTime,
      bookingUrl,
    },
  }).catch(logFailure("booking.reminder.2h"));
}

// ───────────────────────────── Tournaments / play ─────────────────────────────

export interface TournamentTeePublishedOpts extends BaseOpts {
  tournamentId: number | string;
  tournamentName?: string;
  teeSheetUrl?: string;
}
export async function notifyTournamentTeePublished(opts: TournamentTeePublishedOpts): Promise<void> {
  if (opts.userIds.length === 0) return;
  const teeSheetUrl = absoluteUrl(opts.teeSheetUrl ?? `/portal/tournaments/${opts.tournamentId}/tee-sheet`);
  await dispatchNotification("tournament.tee.published", opts.userIds, {
    title: "Tee sheet published",
    body: opts.tournamentName
      ? `The tee sheet for ${opts.tournamentName} is live. Check your tee time.`
      : "The tournament tee sheet is published.",
    branding: opts.branding,
    data: {
      type: "tournament_tee_published",
      tournamentId: String(opts.tournamentId),
      tournamentName: opts.tournamentName,
      teeSheetUrl,
    },
  }).catch(logFailure("tournament.tee.published"));
}

export interface MatchOpts extends BaseOpts {
  matchId: number | string;
  opponentName?: string;
  matchUrl?: string;
}
export async function notifyMatchScheduled(opts: MatchOpts & { scheduledAt?: Date }): Promise<void> {
  if (opts.userIds.length === 0) return;
  const matchUrl = absoluteUrl(opts.matchUrl ?? `/portal/matches/${opts.matchId}`);
  await dispatchNotification("match.scheduled", opts.userIds, {
    title: "Match scheduled",
    body: opts.opponentName
      ? `You have a match scheduled against ${opts.opponentName}.`
      : "A new match has been scheduled.",
    branding: opts.branding,
    data: {
      type: "match_scheduled",
      matchId: String(opts.matchId),
      opponentName: opts.opponentName,
      scheduledAt: opts.scheduledAt?.toISOString(),
      matchUrl,
    },
  }).catch(logFailure("match.scheduled"));
}

export async function notifyMatchResultRecorded(opts: MatchOpts & { result?: string }): Promise<void> {
  if (opts.userIds.length === 0) return;
  const matchUrl = absoluteUrl(opts.matchUrl ?? `/portal/matches/${opts.matchId}`);
  await dispatchNotification("match.result.recorded", opts.userIds, {
    title: "Match result recorded",
    body: opts.result ?? "The result for your match has been recorded.",
    branding: opts.branding,
    data: {
      type: "match_result_recorded",
      matchId: String(opts.matchId),
      opponentName: opts.opponentName,
      result: opts.result,
      matchUrl,
    },
  }).catch(logFailure("match.result.recorded"));
}

export interface MarkerShareRequestedOpts extends BaseOpts {
  roundId: number | string;
  playerName?: string;
  markerUrl?: string;
}
export async function notifyMarkerShareRequested(opts: MarkerShareRequestedOpts): Promise<void> {
  if (opts.userIds.length === 0) return;
  const markerUrl = absoluteUrl(opts.markerUrl ?? `/portal/general-play/${opts.roundId}/marker`);
  await dispatchNotification("marker.share.requested", opts.userIds, {
    title: "Scorecard to countersign",
    body: opts.playerName
      ? `${opts.playerName} has asked you to countersign their scorecard.`
      : "A player has asked you to countersign their scorecard.",
    branding: opts.branding,
    data: {
      type: "marker_share_requested",
      roundId: String(opts.roundId),
      playerName: opts.playerName,
      markerUrl,
    },
  }).catch(logFailure("marker.share.requested"));
}

export interface InterclubQualifiedOpts extends BaseOpts {
  eventId: number | string;
  eventName?: string;
  eventUrl?: string;
}
export async function notifyInterclubQualified(opts: InterclubQualifiedOpts): Promise<void> {
  if (opts.userIds.length === 0) return;
  const eventUrl = absoluteUrl(opts.eventUrl ?? `/portal/interclub/${opts.eventId}`);
  await dispatchNotification("interclub.qualified", opts.userIds, {
    title: "You qualified for inter-club play!",
    body: opts.eventName
      ? `You've qualified for ${opts.eventName}. Confirm your spot.`
      : "You've qualified for the inter-club event. Confirm your spot.",
    branding: opts.branding,
    data: {
      type: "interclub_qualified",
      eventId: String(opts.eventId),
      eventName: opts.eventName,
      eventUrl,
    },
  }).catch(logFailure("interclub.qualified"));
}

export interface LeagueStandingsUpdatedOpts extends BaseOpts {
  leagueId: number | string;
  leagueName?: string;
  newPosition?: number;
  standingsUrl?: string;
}
export async function notifyLeagueStandingsUpdated(opts: LeagueStandingsUpdatedOpts): Promise<void> {
  if (opts.userIds.length === 0) return;
  const standingsUrl = absoluteUrl(opts.standingsUrl ?? `/portal/leagues/${opts.leagueId}/standings`);
  await dispatchNotification("league.standings.updated", opts.userIds, {
    title: opts.leagueName ? `${opts.leagueName} standings updated` : "League standings updated",
    body: opts.newPosition !== undefined
      ? `The latest league standings are out — you're sitting at position ${opts.newPosition}.`
      : "The latest league standings are out.",
    branding: opts.branding,
    data: {
      type: "league_standings_updated",
      leagueId: String(opts.leagueId),
      leagueName: opts.leagueName,
      newPosition: opts.newPosition,
      standingsUrl,
    },
  }).catch(logFailure("league.standings.updated"));
}

// ───────────────────────────── Handicap / verification ─────────────────────────────

export interface HandicapChangedOpts extends BaseOpts {
  oldIndex?: string | number;
  newIndex: string | number;
  reason?: string;
  handicapUrl?: string;
}
export async function notifyHandicapCommitteeChanged(opts: HandicapChangedOpts): Promise<void> {
  if (opts.userIds.length === 0) return;
  const handicapUrl = absoluteUrl(opts.handicapUrl ?? "/portal/profile/handicap");
  await dispatchNotification("handicap.committee.changed", opts.userIds, {
    title: "Handicap index updated",
    body: opts.oldIndex !== undefined
      ? `The handicap committee changed your index from ${opts.oldIndex} to ${opts.newIndex}.`
      : `The handicap committee updated your index to ${opts.newIndex}.`,
    branding: opts.branding,
    data: {
      type: "handicap_committee_changed",
      oldIndex: opts.oldIndex,
      newIndex: opts.newIndex,
      reason: opts.reason,
      handicapUrl,
    },
  }).catch(logFailure("handicap.committee.changed"));
}

export async function notifyHandicapExceptionalScore(opts: HandicapChangedOpts & { reduction?: number }): Promise<void> {
  if (opts.userIds.length === 0) return;
  const handicapUrl = absoluteUrl(opts.handicapUrl ?? "/portal/profile/handicap");
  await dispatchNotification("handicap.exceptional.score", opts.userIds, {
    title: "Exceptional score reduction applied",
    body: opts.reduction !== undefined
      ? `Your handicap was reduced by ${opts.reduction} for an exceptional score. New index: ${opts.newIndex}.`
      : `An exceptional score reduction has been applied. New index: ${opts.newIndex}.`,
    branding: opts.branding,
    data: {
      type: "handicap_exceptional_score",
      oldIndex: opts.oldIndex,
      newIndex: opts.newIndex,
      reduction: opts.reduction,
      handicapUrl,
    },
  }).catch(logFailure("handicap.exceptional.score"));
}

export interface VerifiedHandicapExpiringOpts extends BaseOpts {
  expiresAt: Date;
  renewUrl?: string;
}
export async function notifyVerifiedHandicapExpiring(opts: VerifiedHandicapExpiringOpts): Promise<void> {
  if (opts.userIds.length === 0) return;
  const renewUrl = absoluteUrl(opts.renewUrl ?? "/portal/profile/handicap/renew");
  const expires = opts.expiresAt.toISOString().slice(0, 10);
  await dispatchNotification("verified.handicap.expiring", opts.userIds, {
    title: `Verified-handicap badge expiring ${expires}`,
    body: `Your verified-handicap badge will expire on ${expires}. Renew now to keep it active.`,
    branding: opts.branding,
    data: {
      type: "verified_handicap_expiring",
      expires,
      renewUrl,
    },
  }).catch(logFailure("verified.handicap.expiring"));
}

export interface WearableReauthRequiredOpts extends BaseOpts {
  provider: string;
  providerLabel?: string;
  reauthUrl?: string;
}
export async function notifyWearableReauthRequired(opts: WearableReauthRequiredOpts): Promise<void> {
  if (opts.userIds.length === 0) return;
  const reauthUrl = absoluteUrl(opts.reauthUrl ?? `/portal/profile/wearables?reauth=${encodeURIComponent(opts.provider)}`);
  const label = opts.providerLabel ?? opts.provider;
  await dispatchNotification("wearable.reauth.required", opts.userIds, {
    title: `${label} sign-in expired`,
    body: `Your ${label} sign-in expired. Tap to reconnect and resume syncing.`,
    branding: opts.branding,
    data: {
      type: "wearable_reauth_required",
      provider: opts.provider,
      providerLabel: label,
      reauthUrl,
    },
  }).catch(logFailure("wearable.reauth.required"));
}

// ───────────────────────────── Coach / membership ─────────────────────────────

export interface CoachReviewDeliveredOpts extends BaseOpts {
  reviewId: number | string;
  coachName?: string;
  reviewUrl?: string;
}
export async function notifyCoachReviewDelivered(opts: CoachReviewDeliveredOpts): Promise<void> {
  if (opts.userIds.length === 0) return;
  const reviewUrl = absoluteUrl(opts.reviewUrl ?? `/portal/lessons/reviews/${opts.reviewId}`);
  await dispatchNotification("coach.review.delivered", opts.userIds, {
    title: "Your coach review is ready",
    body: opts.coachName
      ? `${opts.coachName} just posted your video review.`
      : "Your coach has posted a video review for you.",
    branding: opts.branding,
    data: {
      type: "coach_review_delivered",
      reviewId: String(opts.reviewId),
      coachName: opts.coachName,
      reviewUrl,
    },
  }).catch(logFailure("coach.review.delivered"));
}

export interface CaddieModeBlockedOpts extends BaseOpts {
  reason?: string;
  settingsUrl?: string;
}
export async function notifyCaddieModeBlocked(opts: CaddieModeBlockedOpts): Promise<void> {
  if (opts.userIds.length === 0) return;
  const settingsUrl = absoluteUrl(opts.settingsUrl ?? "/portal/profile/settings");
  await dispatchNotification("caddie.mode.blocked", opts.userIds, {
    title: "Caddie mode blocked",
    body: opts.reason
      ? `Caddie mode has been blocked on your account: ${opts.reason}`
      : "Caddie mode has been blocked on your account by an administrator.",
    branding: opts.branding,
    data: {
      type: "caddie_mode_blocked",
      reason: opts.reason,
      settingsUrl,
    },
  }).catch(logFailure("caddie.mode.blocked"));
}
