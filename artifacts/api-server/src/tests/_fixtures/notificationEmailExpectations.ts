/**
 * Task #1621 — canonical source-of-truth maps describing the 29 branded
 * notification email keys, their renderer's preferred URL alias for the
 * deep-link CTA button, and the CTA label string the renderer emits.
 *
 * These constants are imported by both
 *   - `notification-email-templates.test.ts` (per-template snapshot +
 *     CTA-href + plain-text-fallback assertions)
 *   - `notification-dispatch-and-digest.test.ts` (dispatcher propagation
 *     + codebase-wide guard rail that every branded-key
 *     `dispatchNotification(...)` call site populates the URL alias).
 *
 * Keeping them in one fixture file means a new branded notification key
 * (or a CTA alias rename) has exactly one update site, and both test
 * suites pick the change up automatically.
 */

export const EXPECTED_BRANDED_KEYS: readonly string[] = [
  "achievement.unlocked",
  "booking.cancelled",
  "booking.confirmed",
  "booking.reminder.24h",
  "booking.reminder.2h",
  "booking.waitlist.promoted",
  "caddie.mode.blocked",
  "coach.review.delivered",
  "course.correction.resolved",
  "handicap.committee.changed",
  "handicap.exceptional.score",
  "highlight.ready",
  "interclub.qualified",
  "leaderboard.position.change",
  "league.standings.updated",
  "marker.share.requested",
  "match.result.recorded",
  "match.scheduled",
  "near.miss",
  "post.event.survey",
  "post.round.results",
  "recap.year.ready",
  "scoring.event.eagle",
  "scoring.event.hole_in_one",
  "streak.milestone",
  "tournament.cut.applied",
  "tournament.tee.published",
  "verified.handicap.expiring",
  "wearable.reauth.required",
] as const;

export type BrandedNotificationKey = (typeof EXPECTED_BRANDED_KEYS)[number];

export interface CtaExpectation {
  /** Primary URL alias the renderer reads from `data` for the CTA href. */
  urlField: string;
  /** Visible CTA button label emitted by the renderer (English). */
  label: string;
  /**
   * Optional secondary URL alias names the renderer also accepts (e.g.
   * `tournament.cut.applied` accepts `groupingUrl` for the survivors
   * branch and `leaderboardUrl` for the eliminated branch). When set, a
   * dispatch site is considered compliant if it populates *any* of these
   * fields.
   */
  altUrlFields?: readonly string[];
}

export const CTA_EXPECTATIONS: Record<BrandedNotificationKey, CtaExpectation> = {
  "achievement.unlocked": { urlField: "achievementUrl", label: "View achievement" },
  "booking.confirmed": { urlField: "bookingUrl", label: "View booking" },
  "booking.reminder.24h": { urlField: "bookingUrl", label: "View booking" },
  "booking.reminder.2h": { urlField: "bookingUrl", label: "View booking" },
  "booking.cancelled": { urlField: "bookingUrl", label: "View booking" },
  "booking.waitlist.promoted": { urlField: "bookingUrl", label: "View booking" },
  "caddie.mode.blocked": { urlField: "settingsUrl", label: "Open settings" },
  "coach.review.delivered": { urlField: "reviewUrl", label: "Watch review" },
  "course.correction.resolved": { urlField: "correctionUrl", label: "View correction" },
  "handicap.committee.changed": { urlField: "handicapUrl", label: "View handicap" },
  "handicap.exceptional.score": { urlField: "handicapUrl", label: "View handicap" },
  "highlight.ready": { urlField: "highlightUrl", label: "Watch highlight" },
  "interclub.qualified": { urlField: "eventUrl", label: "Confirm spot" },
  "leaderboard.position.change": { urlField: "leaderboardUrl", label: "View leaderboard" },
  "league.standings.updated": { urlField: "standingsUrl", label: "View standings" },
  "marker.share.requested": { urlField: "markerUrl", label: "Open marker view" },
  "match.result.recorded": { urlField: "matchUrl", label: "View match" },
  "match.scheduled": { urlField: "matchUrl", label: "View match" },
  "near.miss": { urlField: "profileUrl", label: "View round" },
  "post.event.survey": { urlField: "surveyUrl", label: "Open survey" },
  "post.round.results": { urlField: "roundUrl", label: "View round" },
  "recap.year.ready": { urlField: "recapUrl", label: "Open recap" },
  "scoring.event.eagle": { urlField: "highlightUrl", label: "View highlight" },
  "scoring.event.hole_in_one": { urlField: "highlightUrl", label: "View highlight" },
  "streak.milestone": { urlField: "streakUrl", label: "View streak" },
  "tournament.cut.applied": {
    urlField: "groupingUrl",
    label: "View grouping",
    altUrlFields: ["leaderboardUrl"],
  },
  "tournament.tee.published": { urlField: "teeSheetUrl", label: "View tee sheet" },
  "verified.handicap.expiring": { urlField: "renewUrl", label: "Renew now" },
  "wearable.reauth.required": { urlField: "reauthUrl", label: "Re-authorise Garmin Connect" },
};
