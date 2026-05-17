/**
 * Task #2024 — Realistic preview payloads for every registered notification key.
 *
 * The admin "Preview template" dialog (Task #1631) renders whatever
 * `previewNotificationTemplate` returns. Before this task, the helper
 * fell back to a generic `[Sample] {description}` body for every key
 * outside a tiny hard-coded `SAMPLE_TITLES` list (4 entries), so the
 * preview was not representative of what the dispatcher actually sends.
 *
 * Each key registered in `notificationRegistry.ts` SEED_TYPES now ships
 * a matching row in {@link NOTIFICATION_SAMPLES} with:
 *   - a realistic title / subject line,
 *   - a realistic body line (used verbatim by the generic non-branded
 *     wrapper, and as the dispatch payload's `body` for branded keys), and
 *   - an optional `data` payload mirroring the placeholders the branded
 *     renderer in `notificationEmailTemplates.ts` reads (e.g.
 *     `{playerName}`, `{eventName}`, `{courseName}`).
 *
 * Adding a new key in SEED_TYPES requires shipping a sibling row here:
 * `notificationRegistry.ts` performs a static cross-check at module load
 * and throws if any seed key is missing a sample. The companion test in
 * `tests/notification-dispatch-and-digest.test.ts` enforces the same
 * contract so new dispatch keys can never reach production with a
 * generic preview.
 */

export interface NotificationSample {
  /** Used as the dispatch payload `title` (and as the fallback subject for non-branded keys). */
  title: string;
  /** Used as the dispatch payload `body` (and as the body line in the generic non-branded wrapper). */
  body: string;
  /**
   * Structured data forwarded to the branded renderer (mirrors what a
   * real dispatch site would pass in `payload.data`). Keys without a
   * branded renderer ignore this and rely on `title` / `body`.
   */
  data?: Record<string, unknown>;
}

/** Base URL used in sample CTA links so previews look like real emails. */
const SAMPLE_BASE_URL = "https://app.kharagolf.com";

export const NOTIFICATION_SAMPLES: Record<string, NotificationSample> = {
  // ─── engagement / play ──────────────────────────────────────────
  "achievement.unlocked": {
    title: "Achievement unlocked: Eagle Eye",
    body: "You unlocked the Eagle Eye achievement for scoring three eagles in a single round.",
    data: {
      achievementName: "Eagle Eye",
      description: "Score three eagles in a single round.",
      profileUrl: `${SAMPLE_BASE_URL}/portal/achievements/eagle-eye`,
    },
  },
  "highlight.ready": {
    title: "Your highlight reel is ready",
    body: "Your 60-second highlight reel from yesterday's round at Ocean Course is ready to share.",
    data: {
      highlightUrl: `${SAMPLE_BASE_URL}/highlights/9341`,
    },
  },
  "recap.year.ready": {
    title: "Your 2026 Year-in-Golf recap is ready",
    body: "Your 2026 Year-in-Golf recap — 47 rounds, 12 birdies, 1 eagle and a new personal best — is waiting for you.",
    data: {
      year: 2026,
      recapUrl: `${SAMPLE_BASE_URL}/portal/recap/2026`,
    },
  },
  "social.follow.new": {
    title: "Anjali Rao started following you",
    body: "Anjali Rao started following you on KHARAGOLF. Tap to view their profile.",
  },
  "social.mention": {
    title: "Rahul Singh mentioned you in a post",
    body: "Rahul Singh tagged you in a feed post: \"Great round with you yesterday at Ocean Course!\"",
  },
  "streak.broken": {
    title: "Your 12-day streak ended",
    body: "Your 12-day daily-practice streak ended today. Tap in tomorrow to start a new one.",
  },
  "streak.milestone": {
    title: "30-day daily-practice streak",
    body: "You hit a 30-day daily-practice streak. Keep it going!",
    data: {
      streakName: "Daily practice",
      milestone: "30 days",
      streakUrl: `${SAMPLE_BASE_URL}/portal/streaks`,
    },
  },
  "near.miss": {
    title: "So close to the Sub-80 Club",
    body: "You finished one stroke off the Sub-80 Club badge today — try again next round!",
    data: {
      badgeName: "Sub-80 Club",
      gap: "1 stroke",
      roundUrl: `${SAMPLE_BASE_URL}/portal/rounds/55891`,
    },
  },
  "coaching.gap.closed": {
    title: "You closed the gap with your 7-iron",
    body: "Your 7-iron is 1.7 ft closer to tour vs the prior 30 days — keep it up!",
    data: {
      type: "coaching_gap_closed",
      clubKey: "7i",
      clubLabel: "7-iron",
      improvedByFt: 1.7,
      statsUrl: `${SAMPLE_BASE_URL}/portal/stats?club=7i`,
    },
  },
  "scoring.event.eagle": {
    title: "Eagle on hole 12 at Ocean Course",
    body: "You made eagle on hole 12 at Ocean Course — nice strike.",
    data: {
      courseName: "Ocean Course",
      holeNumber: 12,
      score: "an eagle on a par 5",
      highlightUrl: `${SAMPLE_BASE_URL}/highlights/9342`,
    },
  },
  "scoring.event.hole_in_one": {
    title: "Hole-in-one at Highland Links",
    body: "Hole-in-one on hole 7 at Highland Links — congratulations!",
    data: {
      courseName: "Highland Links",
      holeNumber: 7,
      club: "7-iron",
      distance: "168 yards",
      highlightUrl: `${SAMPLE_BASE_URL}/highlights/9343`,
    },
  },
  "leaderboard.position.change": {
    title: "You moved up to T9 in the Spring Open",
    body: "You jumped from T14 to T9 on the Spring Open leaderboard.",
    data: {
      previousPosition: 14,
      newPosition: 9,
      tournamentName: "Spring Open",
      leaderboardUrl: `${SAMPLE_BASE_URL}/leaderboard/55`,
    },
  },
  "post.round.results": {
    title: "Your round at Ocean Course is in",
    body: "Your scorecard from Ocean Course is in: 82 gross, 74 net, 32 Stableford points.",
    data: {
      courseName: "Ocean Course",
      grossScore: "82",
      netScore: "74",
      stableford: "32",
      roundUrl: `${SAMPLE_BASE_URL}/portal/rounds/55890`,
    },
  },

  // ─── bookings / tee sheet ───────────────────────────────────────
  "booking.confirmed": {
    title: "Tee time confirmed at Ocean Course",
    body: "Your tee time at Ocean Course on Sat, May 16 at 08:40 is confirmed for a party of 4.",
    data: {
      courseName: "Ocean Course",
      teeTime: "Sat, May 16 · 08:40",
      partySize: 4,
      bookingUrl: `${SAMPLE_BASE_URL}/portal/bookings/8421`,
    },
  },
  "booking.reminder.24h": {
    title: "Tee time tomorrow at Ocean Course",
    body: "Reminder: you tee off at Ocean Course tomorrow at 08:40.",
    data: {
      courseName: "Ocean Course",
      teeTime: "Tomorrow · 08:40",
      bookingUrl: `${SAMPLE_BASE_URL}/portal/bookings/8421`,
    },
  },
  "booking.reminder.2h": {
    title: "Tee off in 2 hours at Ocean Course",
    body: "Reminder: you tee off at Ocean Course in 2 hours (08:40).",
    data: {
      courseName: "Ocean Course",
      teeTime: "Today · 08:40 (in 2 hours)",
      bookingUrl: `${SAMPLE_BASE_URL}/portal/bookings/8421`,
    },
  },
  "booking.cancelled": {
    title: "Tee time cancelled at Ocean Course",
    body: "Your Sat, May 16 · 08:40 tee time at Ocean Course was cancelled because the course is closed for maintenance.",
    data: {
      courseName: "Ocean Course",
      teeTime: "Sat, May 16 · 08:40",
      reason: "Course closed for maintenance",
      rebookUrl: `${SAMPLE_BASE_URL}/portal/bookings`,
    },
  },
  "booking.waitlist.promoted": {
    title: "You're off the waitlist at Ocean Course",
    body: "A spot opened up — your Sat, May 16 · 08:40 booking at Ocean Course is now confirmed.",
    data: {
      courseName: "Ocean Course",
      teeTime: "Sat, May 16 · 08:40",
      bookingUrl: `${SAMPLE_BASE_URL}/portal/bookings/9001`,
    },
  },

  // ─── tournaments / play ─────────────────────────────────────────
  "tournament.cut.applied": {
    title: "You made the cut in the Spring Open",
    body: "Round 2 has finished and you made the cut in the Spring Open. Round 3 grouping is published.",
    data: {
      tournamentName: "Spring Open",
      throughRound: 2,
      madeCut: true,
      groupingUrl: `${SAMPLE_BASE_URL}/portal/tournaments/55/grouping`,
      leaderboardUrl: `${SAMPLE_BASE_URL}/leaderboard/55`,
    },
  },
  "tournament.tee.published": {
    title: "Tee sheet published for the Summer Classic",
    body: "Your Summer Classic tee sheet is published. You tee off Sun, Jun 7 at 09:10 from hole 1.",
    data: {
      tournamentName: "Summer Classic",
      teeTime: "Sun, Jun 7 · 09:10",
      startingHole: "1",
      teeSheetUrl: `${SAMPLE_BASE_URL}/portal/tournaments/61/tee-sheet`,
    },
  },
  "post.event.survey": {
    title: "How was the Spring Open? — Quick feedback",
    body: "Thanks for playing the Spring Open. Share a couple of minutes of feedback so the next event is even better.",
    data: {
      tournamentName: "Spring Open",
      surveyUrl: `${SAMPLE_BASE_URL}/portal/surveys/123`,
    },
  },
  "course.correction.resolved": {
    title: "Your course correction was accepted",
    body: "Your reported correction to the hole 7 yardage marker was accepted. The marker was updated from 145 to 152 yards.",
    data: {
      decision: "accepted",
      fieldName: "Hole 7 yardage marker",
      holeNumber: 7,
      reviewNotes: "Updated marker from 145 to 152 yards.",
      correctionUrl: `${SAMPLE_BASE_URL}/portal/course-corrections/12`,
    },
  },
  "match.scheduled": {
    title: "Match scheduled vs Rahul Singh",
    body: "Your match against Rahul Singh is scheduled for Fri, May 22 at 14:20 at Highland Links.",
    data: {
      opponentName: "Rahul Singh",
      teeTime: "Fri, May 22 · 14:20",
      courseName: "Highland Links",
      matchUrl: `${SAMPLE_BASE_URL}/portal/matches/77`,
    },
  },
  "match.result.recorded": {
    title: "Match result recorded vs Rahul Singh",
    body: "Your match against Rahul Singh is in: you won 3 & 2.",
    data: {
      opponentName: "Rahul Singh",
      result: "Won 3 & 2",
      score: "−2 vs +1",
      matchUrl: `${SAMPLE_BASE_URL}/portal/matches/77`,
    },
  },
  "interclub.qualified": {
    title: "You qualified for the Coastal Inter-Club Final",
    body: "You qualified for the Coastal Inter-Club Final. Confirm your spot before the team is locked.",
    data: {
      eventName: "Coastal Inter-Club Final",
      confirmUrl: `${SAMPLE_BASE_URL}/portal/events/interclub-2026`,
    },
  },
  "marshal.pace.alert": {
    title: "Pace alert: group 14 is 18 minutes behind",
    body: "Group #14 (Singh / Rao / Patel / Khan) is running 18 minutes behind the published pace at hole 11.",
  },
  "league.standings.updated": {
    title: "Standings updated — Saturday League — Division A",
    body: "Saturday League — Division A standings updated. You're now sitting at #3.",
    data: {
      leagueName: "Saturday League — Division A",
      position: 3,
      standingsUrl: `${SAMPLE_BASE_URL}/portal/leagues/sat-div-a`,
    },
  },
  "marker.share.requested": {
    title: "Anjali Rao asked you to mark her card",
    body: "Anjali Rao asked you to mark her card for today's round.",
    data: {
      requesterName: "Anjali Rao",
      markerUrl: `${SAMPLE_BASE_URL}/portal/play/marker/4123`,
    },
  },

  // ─── handicap / verification ────────────────────────────────────
  "handicap.committee.changed": {
    title: "Your handicap index was updated",
    body: "The handicap committee updated your index from 12.4 to 11.8 following a tournament eligibility review.",
    data: {
      previousIndex: "12.4",
      newIndex: "11.8",
      reason: "Tournament eligibility review",
      handicapUrl: `${SAMPLE_BASE_URL}/portal/handicap`,
    },
  },
  "handicap.exceptional.score": {
    title: "Exceptional score reduction applied",
    body: "An exceptional differential of −7.2 triggered a downward adjustment of 0.8 to your handicap index.",
    data: {
      differential: "−7.2",
      reduction: "−0.8 to your index",
      handicapUrl: `${SAMPLE_BASE_URL}/portal/handicap`,
    },
  },
  "verified.handicap.expiring": {
    title: "Your verified-handicap badge expires May 30, 2026",
    body: "Your verified-handicap badge expires on May 30, 2026. Renew now so you can keep entering verified-handicap events.",
    data: {
      expiresOn: "May 30, 2026",
      renewUrl: `${SAMPLE_BASE_URL}/portal/handicap/renew`,
    },
  },
  "wearable.reauth.required": {
    title: "Re-authorise Garmin Connect",
    body: "We can no longer sync your rounds from Garmin Connect. Re-authorise the connection to keep automatic uploads flowing.",
    data: {
      provider: "Garmin Connect",
      reauthUrl: `${SAMPLE_BASE_URL}/portal/settings/wearables`,
    },
  },

  // ─── coach / payouts / wallet ───────────────────────────────────
  "coach.review.delivered": {
    title: "Priya Patel delivered your swing review",
    body: "Coach Priya Patel posted a video review of your last range session. Open it to watch and reply.",
    data: {
      coachName: "Priya Patel",
      reviewUrl: `${SAMPLE_BASE_URL}/portal/coaching/reviews/482`,
    },
  },
  "coach.payout.sent": {
    title: "Coach payout of ₹12,500 sent",
    body: "Your coach payout of ₹12,500 has been released and should arrive in your bank account in 1–2 business days.",
  },
  "coach.payout.account.needs_attention": {
    title: "Action needed: re-verify your coach payout account",
    body: "Today's re-verification of your saved coach payout account failed. Re-save it from your coach dashboard so payouts can keep flowing.",
  },
  "coach.payout.account.changed.admin": {
    title: "Coach Priya Patel updated her payout account",
    body: "Coach Priya Patel updated her saved payout account a moment ago. Review the change in the admin audit log if it looks unexpected.",
  },
  "coach.payout.account.changed.coach": {
    title: "Your coach payout account was updated",
    body: "We saved a new payout account on your coach profile. If this wasn't you, please contact support immediately.",
  },
  "wallet.payout.account.needs_attention": {
    title: "Action needed: re-verify your wallet payout account",
    body: "Today's re-verification of your saved wallet payout account failed. Re-save it so wallet refunds and payouts can keep flowing.",
  },
  "wallet.refund.digest.failed": {
    title: "Wallet refund digest could not be delivered",
    body: "Today's wallet auto-refund digest for Greenfield Golf Club could not be delivered to any configured admin address.",
  },
  "side_game.receipt.digest.failed": {
    title: "Side-game receipt digest could not be delivered",
    body: "Today's stuck side-game receipts digest for Greenfield Golf Club could not be delivered to any configured admin address.",
  },
  "levy.ledger.digest.failed": {
    title: "Levy ledger digest could not be delivered",
    body: "The April 2026 \"Annual Membership Levy\" CSV digest could not be delivered to any configured admin address.",
  },
  "levy.ledger.org.digest.failed": {
    title: "Club levy ledger digest could not be delivered",
    body: "The April 2026 club-wide combined levy ledger CSV digest for Greenfield Golf Club could not be delivered to any configured admin address.",
  },
  "levy.reminders.digest.failed": {
    title: "Bounced-levy reminders digest could not be delivered",
    body: "Today's bounced-levy reminders digest for Greenfield Golf Club could not be delivered (3 of 3 admin email addresses are bouncing).",
  },
  "notify.exhaustion.admin_digest.failed": {
    title: "Daily exhaustion admin digest could not be delivered",
    body: "Today's admin exhaustion digest for Greenfield Golf Club could not be delivered to any administrator. Every recipient is on the bounce suppression list or failed the SMTP send.",
  },
  "payment.received": {
    title: "Payment received: ₹4,500",
    body: "We received your payment of ₹4,500 for the Spring Open entry fee. A receipt has been emailed to you.",
  },

  // ─── membership / moderation / ops / admin ──────────────────────
  "caddie.mode.blocked": {
    title: "AI Caddie was blocked",
    body: "Your AI Caddie request was blocked because AI Caddie is disabled in club championship play.",
    data: {
      reason: "AI Caddie is disabled in club championship play",
      settingsUrl: `${SAMPLE_BASE_URL}/portal/play/caddie`,
    },
  },
  "member.document.rejected": {
    title: "A submitted document was rejected",
    body: "Your handicap certificate could not be verified. Please re-upload a clearer copy from your member dashboard.",
  },
  "moderation.assigned": {
    title: "A moderation case is waiting for you",
    body: "A new moderation report on the community feed has been assigned to you. Review and take action from the moderation queue.",
  },
  "sponsor.asset.review": {
    title: "Acme Golf submitted a sponsor asset for review",
    body: "Acme Golf uploaded a new ad creative awaiting review. Approve or send-back from the sponsor dashboard.",
  },
  "scheduled.email.failed": {
    title: "A scheduled email failed to send",
    body: "The 09:00 weekly newsletter for Greenfield Golf Club did not send because the SMTP relay returned a permanent error.",
  },
  "tournament.override.applied": {
    title: "A club admin changed your manual-entry alert setting",
    body:
      "An org admin bulk-applied the club-wide manual-entry alert default and overwrote the setting on the Spring Open. " +
      "Open the tournament settings page to review the change and restore your previous preference if you'd prefer.",
    data: {
      tournamentName: "Spring Open",
      setting: "notify_manual_entry_alerts",
      previousValue: false,
      appliedValue: true,
      restoreUrl: `${SAMPLE_BASE_URL}/tournaments/123#manual-entry-override-notice`,
    },
  },
  "privacy.erasure.storage_failures.controller_digest": {
    title: "Some erasure cleanups left files behind",
    body: "Yesterday's account-erasure run for Greenfield Golf Club left 3 object-storage files behind for 2 members. Review and clean up from the controller dashboard.",
  },
  "volunteer.assignment.assigned": {
    title: "You're assigned as a starter for the Spring Open",
    body: "You're confirmed as a starter for the Spring Open on Saturday morning. Briefing is at 06:30 by the first tee.",
  },
  "marketing.campaign.push": {
    title: "New from your club",
    body: "Spots are still open for the Sunset Mixer on Friday — book through the Events tab to secure your slot.",
  },
};

/** Look up a sample by registry key. Returns `undefined` if none. */
export function getNotificationSample(key: string): NotificationSample | undefined {
  return NOTIFICATION_SAMPLES[key];
}

/** Sorted snapshot of every key with a sample registered. */
export function listSampleKeys(): string[] {
  return Object.keys(NOTIFICATION_SAMPLES).sort();
}
