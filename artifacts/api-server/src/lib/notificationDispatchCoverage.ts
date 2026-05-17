/**
 * Task #1005 — Registry → dispatch coverage matrix.
 *
 * Every key in `notificationRegistry.ts` (the SEED_TYPES list) must
 * appear in this map exactly once. Each entry documents *where* the
 * notification is fired so a reviewer can audit the registry against
 * the codebase without grepping. The companion test
 * (`tests/notification-dispatch-coverage.test.ts`) asserts that:
 *
 *   - every registered key is present in `DISPATCH_COVERAGE`
 *   - every entry in `DISPATCH_COVERAGE` is in the registry
 *
 * Coverage modes:
 *   - `in_process`   → dispatched in-process via `dispatchNotification`
 *                      or a feature-specific helper (file/function noted).
 *   - `event_driven` → fired by an external scheduler / webhook / cron
 *                      (file noted). The dispatch site lives in code
 *                      that runs only when the upstream event arrives.
 */
export type CoverageMode = "in_process" | "event_driven";

export interface CoverageEntry {
  mode: CoverageMode;
  /** File where the dispatch happens (relative to artifacts/api-server/src). */
  file: string;
  /** One-line note describing the trigger. */
  note: string;
}

export const DISPATCH_COVERAGE: Record<string, CoverageEntry> = {
  // Player engagement
  "achievement.unlocked":               { mode: "in_process", file: "lib/achievementEngine.ts",        note: "Task #2008 — notifyAchievementUnlocked invoked from the achievement evaluator after sendTransactionalPush, alongside the existing badge-unlock push." },
  "highlight.ready":                    { mode: "event_driven", file: "lib/highlightRender.ts",        note: "Task #2008 — notifyHighlightReady invoked at end of renderReel() once status flips to 'ready'." },
  "recap.year.ready":                   { mode: "event_driven", file: "lib/year-in-golf-cron.ts",      note: "Task #2008 — notifyRecapYearReady invoked from sendLaunchBroadcastFor(), batched same as the bespoke push fan-out." },
  "social.follow.new":                  { mode: "in_process", file: "routes/portal.ts",                note: "Dispatched on follow-create." },
  "social.mention":                     { mode: "in_process", file: "routes/portal.ts",                note: "Dispatched when a mention is parsed in a post body." },
  "streak.broken":                      { mode: "event_driven", file: "lib/cron.ts",                   note: "Daily streak cron emits when a user's streak resets." },
  "streak.milestone":                   { mode: "event_driven", file: "lib/cron.ts",                   note: "Task #2008 — runBrandedNotificationDailySweep() invokes notifyStreakMilestone for every user_streaks row whose currentLen sits at a milestone (3/7/14/30/100), with per-(userId, kind, milestone) dedup via member_audit_log so the same threshold isn't announced twice." },
  "near.miss":                          { mode: "in_process", file: "lib/achievementEngine.ts",        note: "Task #2008 — notifyNearMiss invoked from evaluateAchievementsForPlayer when a cumulative numeric badge sits exactly one event short of unlock (current === target - 1) and wasn't earned this pass; per-(user, badge) dedup via member_audit_log entity=achievement_near_miss." },
  "scoring.event.eagle":                { mode: "in_process", file: "routes/scores.ts",                note: "Task #2008 — notifyScoringEventEagle invoked from detectAndDispatchScoringEvents() alongside the bespoke spectator push." },
  "scoring.event.hole_in_one":          { mode: "in_process", file: "routes/scores.ts",                note: "Task #2008 — notifyScoringEventHoleInOne invoked from detectAndDispatchScoringEvents() alongside the bespoke spectator push." },
  "leaderboard.position.change":        { mode: "in_process", file: "routes/scores.ts",                note: "Task #2008 — notifyLeaderboardPositionChange invoked when a scorer-driven leaderboard recompute moves the player ≥3 places." },
  "post.round.results":                 { mode: "in_process", file: "routes/general-play.ts",          note: "Task #2008 — notifyPostRoundResults invoked from POST /portal/general-play/:id/confirm after WHS recalculation." },

  // Bookings / tee sheet
  "booking.confirmed":                  { mode: "in_process", file: "routes/tee-bookings.ts",          note: "Task #2008 — notifyBookingConfirmed invoked from both the pay-at-checkin path and the verify-payment path on confirmation." },
  "booking.reminder.24h":               { mode: "event_driven", file: "lib/cron.ts",                   note: "Task #2008 — notifyBooking24hReminder invoked from the existing tee-reminder cron sweep." },
  "booking.reminder.2h":                { mode: "event_driven", file: "lib/cron.ts",                   note: "Task #2008 — notifyBooking2hReminder invoked from the existing 2h tee-reminder cron sweep." },
  "booking.cancelled":                  { mode: "in_process", file: "routes/tee-bookings.ts",          note: "Task #2008 — notifyBookingCancelled invoked from the cancellation handler." },
  "booking.waitlist.promoted":          { mode: "in_process", file: "lib/teeWaitlistPromote.ts",      note: "Wave-2 promotion path dispatches via the central helper." },

  // Tournaments / play
  "tournament.cut.applied":             { mode: "in_process", file: "routes/wave2.ts",                 note: "POST /tournaments/:id/cut applies the cut and dispatches per-player." },
  "tournament.tee.published":           { mode: "in_process", file: "routes/tee-times.ts",             note: "Task #2008 — notifyTournamentTeePublished invoked from the publish-pairings handler." },
  "tournament.override.applied":        { mode: "in_process", file: "routes/organizations.ts",         note: "Task #2088 — POST /organizations/:orgId/notification-defaults/apply-to-tournaments dispatches per affected tournament after the bulk-apply transaction commits, fanning out to org_admin / tournament_director / committee_member / competition_secretary recipients (excluding the actor) with a deep link to the tournament settings page where the existing override-notice banner exposes the one-click POST .../manual-entry-override-notice/restore action." },
  "post.event.survey":                  { mode: "in_process", file: "routes/wave2.ts",                 note: "Survey publish endpoint dispatches to the tournament roster." },
  "course.correction.resolved":         { mode: "in_process", file: "routes/wave2.ts",                 note: "Resolve endpoint dispatches to the original reporter." },
  "match.scheduled":                    { mode: "in_process", file: "routes/match-play.ts",            note: "Task #2008 — notifyMatchScheduled invoked when a new bracket is created (POST /bracket), fanned out to every participating player." },
  "match.result.recorded":              { mode: "in_process", file: "routes/match-play.ts",            note: "Task #2008 — notifyMatchResultRecorded invoked from POST /bracket/matches/:matchId/result for each side of the match." },
  "interclub.qualified":                { mode: "in_process", file: "routes/cross-club-ladders.ts",    note: "Task #2008 — notifyInterclubQualified invoked from POST /cross-club-ladders/:id/results when a qualifying-round result is posted for a player." },
  "marshal.pace.alert":                 { mode: "event_driven", file: "routes/pace-of-play.ts",        note: "Pace-of-play monitor emits when a group falls behind." },
  "league.standings.updated":           { mode: "in_process", file: "routes/leagues.ts",               note: "Task #2008 — notifyLeagueStandingsUpdated invoked from the fixture-result handler after the full standings recompute, fanned out only to members whose position actually moved (no-op edits stay silent)." },
  "marker.share.requested":             { mode: "in_process", file: "routes/general-play.ts",          note: "Task #2008 — notifyMarkerShareRequested invoked from POST /portal/general-play/:id/submit when marker user-ids are resolved." },

  // Handicap / verification
  "handicap.committee.changed":         { mode: "in_process", file: "routes/handicap-committee.ts",    note: "Task #2008 — notifyHandicapCommitteeChanged invoked from POST /adjustments after the handicap_adjustments audit row is written." },
  "handicap.exceptional.score":         { mode: "in_process", file: "routes/handicap-committee.ts",    note: "Task #2008 — notifyHandicapExceptionalScore invoked from POST /exceptional-scores/:flagId/apply." },
  "verified.handicap.expiring":         { mode: "event_driven", file: "lib/cron.ts",                   note: "Task #2008 — runBrandedNotificationDailySweep() invokes notifyVerifiedHandicapExpiring for every verified_handicap_badges row whose expiresAt falls in the renew-now window (~7 days, tunable via VERIFIED_HANDICAP_EXPIRING_LEAD_DAYS). Per-badge dedup via member_audit_log fingerprints expiresAt so a renewal naturally re-arms the reminder." },
  "wearable.reauth.required":           { mode: "event_driven", file: "lib/wearables.ts",              note: "Task #2008 — notifyWearableReauthRequired invoked from markConnectionNeedsReauth() alongside the bespoke 'Wearable disconnected' push." },

  // Coach / payouts / wallet
  "coach.review.delivered":             { mode: "in_process", file: "routes/lessons.ts",               note: "Task #2008 — notifyCoachReviewDelivered invoked from POST /bookings/:bookingId/complete when noteContent (the review) is provided." },
  "coach.payout.sent":                  { mode: "in_process", file: "lib/notifications.ts",            note: "Fired by Razorpay payout webhook handler." },
  "coach.payout.account.needs_attention": { mode: "in_process", file: "lib/coachReverifyPayouts.ts",   note: "Fired when a coach's payout account fails KYC re-verification." },
  "coach.payout.account.changed.admin": { mode: "in_process", file: "lib/coachPayoutAccountChangeNotify.ts", note: "notifyOrgAdminsCoachPayoutAccountChanged dispatches to org admins when a coach's payout account is created or updated (Task #1060)." },
  "coach.payout.account.changed.coach": { mode: "in_process", file: "lib/coachPayoutAccountChangeNotify.ts", note: "notifyCoachPayoutAccountChanged fans out email/in-app/push to the coach when their own payout account is created or updated, writing one audit row per channel (Task #1406)." },
  "wallet.payout.account.needs_attention": { mode: "event_driven", file: "lib/cron.ts",                 note: "Daily cron re-verifies stale wallet payout accounts; emits when Razorpay validation fails." },
  "wallet.refund.digest.failed":        { mode: "event_driven", file: "routes/side-games-v2.ts",       note: "Wallet auto-refund digest run dispatches when delivery fails or all recipients are paused." },
  "side_game.receipt.digest.failed":    { mode: "event_driven", file: "routes/side-games-v2.ts",       note: "Stuck side-game receipts digest run dispatches when delivery fails or all recipients are paused." },
  "levy.ledger.digest.failed":          { mode: "event_driven", file: "routes/member-360.ts",          note: "Per-levy ledger CSV digest run dispatches when delivery fails or all recipients are paused (Task #1444)." },
  "levy.ledger.org.digest.failed":      { mode: "event_driven", file: "routes/member-360.ts",          note: "Club-wide combined levy ledger CSV digest run dispatches when delivery fails or all recipients are paused (Task #1444)." },
  "levy.reminders.digest.failed":       { mode: "event_driven", file: "lib/cron.ts",                   note: "Bounced-levy reminders digest dispatches when every admin recipient is on the suppression list or every send fails (Task #1444)." },
  "notify.exhaustion.admin_digest.failed": { mode: "event_driven", file: "lib/cron.ts",                note: "sendNotifyExhaustionAdminDigest dispatches to super_admins when every admin recipient for an org bounces / is on the suppression list / fails the SMTP send (Task #1855)." },
  "coaching.gap.closed":               { mode: "event_driven", file: "lib/cron.ts",                note: "runCoachingGapClosedDailySweep iterates active players, computes 30-day proximity-vs-tour trend per club, and pushes encouragement when the gap shrunk by ≥ 1.5 ft. Deduped per (user, clubKey) for 14 days via member_audit_log entity=coaching_tip action=gap_closed_notified (Task #2040)." },
  "payment.received":                   { mode: "in_process", file: "routes/carts.ts",                 note: "Fired on successful payment capture." },

  // Membership / moderation / admin
  "caddie.mode.blocked":                { mode: "in_process", file: "routes/caddies.ts",                note: "Task #2008 — notifyCaddieModeBlocked invoked from the PATCH /caddies/:caddieId handler when status transitions to 'cancelled'." },
  "member.document.rejected":           { mode: "in_process", file: "lib/notifications.ts",            note: "Fired when a KYC/membership document is rejected." },
  "moderation.assigned":                { mode: "in_process", file: "lib/notifications.ts",            note: "Fired when a moderation case is assigned to a reviewer." },
  "sponsor.asset.review":               { mode: "in_process", file: "routes/marketing.ts",             note: "Fired when a sponsor uploads an asset awaiting review." },
  "scheduled.email.failed":             { mode: "event_driven", file: "lib/cron.ts",                   note: "Mailer cron dispatches to admins when a scheduled mail fails." },
  "privacy.erasure.storage_failures.controller_digest": { mode: "event_driven", file: "lib/cron.ts", note: "Daily controller digest cron (Task #1078) dispatches an in-app inbox row + push when an org has stuck erasure cleanups; deduped by erasureStorageDigestLastSentOn." },
};
