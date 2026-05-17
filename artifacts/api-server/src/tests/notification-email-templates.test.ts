/**
 * Task #1171 — snapshot + visual smoke tests for the 29 branded
 * notification email renderers added in
 * `lib/notificationEmailTemplates.ts`.
 *
 * The renderers are pure (string in → string out), so we can exercise
 * each one without spinning up DB, SMTP, or the dispatcher. The goals
 * of this suite are:
 *
 *   1. Lock the registered key set so a future PR that drops or
 *      renames a template breaks loudly instead of silently falling
 *      back to the un-branded generic envelope.
 *   2. Snapshot every renderer's `subject` + a normalised `html`
 *      shape so visual regressions surface in review.
 *   3. Assert the branded header is actually present (logo / club
 *      name / primary colour) — that's the whole point of this
 *      task — and that the dispatcher key is surfaced in the footer
 *      for transparency.
 */

import { describe, it, expect } from "vitest";
import {
  NOTIFICATION_EMAIL_TEMPLATES,
  listBrandedNotificationKeys,
  renderNotificationEmail,
  type NotificationEmailContext,
} from "../lib/notificationEmailTemplates.js";
import {
  CTA_EXPECTATIONS as SHARED_CTA_EXPECTATIONS,
  EXPECTED_BRANDED_KEYS,
} from "./_fixtures/notificationEmailExpectations.js";

const BRANDING = {
  orgId: 42,
  orgName: "Pebble Beach GC",
  logoUrl: "https://cdn.example.com/pebble-logo.png",
  primaryColor: "#1e4d2b",
};

/**
 * Per-key sample data — covers the fields each renderer reads.
 *
 * Task #1357 added a deep-link CTA to every renderer: each entry now
 * carries the renderer's preferred URL alias (`bookingUrl`,
 * `leaderboardUrl`, …) so the CTA-button branch is exercised by both
 * the snapshot tests and the explicit CTA assertions below.
 */
const SAMPLE_DATA: Record<string, Record<string, unknown>> = {
  "achievement.unlocked": { achievementName: "Sub-80 Streak", points: 250, achievementUrl: "https://app.example.com/achievements/sub-80" },
  "booking.confirmed": { courseName: "Ocean Course", teeDate: "2026-05-12", teeTime: "08:40", partySize: 4, bookingUrl: "https://app.example.com/portal/bookings/501" },
  "booking.reminder.24h": { courseName: "Ocean Course", teeDate: "2026-05-12", teeTime: "08:40", bookingUrl: "https://app.example.com/portal/bookings/501" },
  "booking.reminder.2h": { courseName: "Ocean Course", teeTime: "08:40", bookingUrl: "https://app.example.com/portal/bookings/501" },
  "booking.cancelled": { courseName: "Ocean Course", teeDate: "2026-05-12", teeTime: "08:40", reason: "Course closure", bookingUrl: "https://app.example.com/portal/bookings/501" },
  "booking.waitlist.promoted": { courseName: "Ocean Course", teeTime: "08:40", bookingUrl: "https://app.example.com/portal/bookings/777" },
  "caddie.mode.blocked": { reason: "Tournament round mode disables AI assistance", settingsUrl: "https://app.example.com/portal/caddie/settings" },
  "coach.review.delivered": { coachName: "Coach Lee", reviewUrl: "https://app.example.com/reviews/9" },
  "course.correction.resolved": { decision: "accepted", fieldName: "Hole 3 yardage", holeNumber: 3, reviewNotes: "Verified by greenkeeper", correctionUrl: "https://app.example.com/portal/course-corrections/12" },
  "handicap.committee.changed": { previousIndex: "12.4", newIndex: "11.8", reason: "Annual review adjustment", handicapUrl: "https://app.example.com/portal/handicap" },
  "handicap.exceptional.score": { score: 68, course: "Ocean Course", reduction: "0.4", handicapUrl: "https://app.example.com/portal/handicap" },
  "highlight.ready": { highlightUrl: "https://app.example.com/h/abc", roundName: "Saturday Match Play" },
  "leaderboard.position.change": { tournamentName: "Spring Open", previousPosition: 14, newPosition: 7, leaderboardUrl: "https://app.example.com/leaderboard/55" },
  "league.standings.updated": { leagueName: "Tuesday Night League", position: 3, points: 84, standingsUrl: "https://app.example.com/leagues/3/standings" },
  "marker.share.requested": { fromName: "Sam Cooke", roundName: "Saturday Stableford", markerUrl: "https://app.example.com/marker/req/42" },
  "match.scheduled": { opponentName: "Alex Murray", matchDate: "2026-05-18", matchTime: "10:00", courseName: "Ocean Course", matchUrl: "https://app.example.com/matches/91" },
  "match.result.recorded": { opponentName: "Alex Murray", result: "won", score: "3 & 2", matchUrl: "https://app.example.com/matches/91" },
  "post.event.survey": { tournamentName: "Spring Open", surveyUrl: "https://app.example.com/surveys/123" },
  "post.round.results": { courseName: "Ocean Course", grossScore: 82, netScore: 74, handicap: "11.8", roundUrl: "https://app.example.com/rounds/2024" },
  "recap.year.ready": { year: 2025, recapUrl: "https://app.example.com/recap/2025" },
  "scoring.event.eagle": { holeNumber: 13, courseName: "Ocean Course", highlightUrl: "https://app.example.com/highlights/eagle-13" },
  "scoring.event.hole_in_one": { holeNumber: 7, courseName: "Ocean Course", club: "7-iron", highlightUrl: "https://app.example.com/highlights/ace-7" },
  "tournament.cut.applied": { tournamentName: "Spring Open", throughRound: 2, madeCut: true, groupingUrl: "https://app.example.com/portal/tournaments/55/grouping", leaderboardUrl: "https://app.example.com/leaderboard/55" },
  "tournament.tee.published": { tournamentName: "Spring Open", teeDate: "2026-05-12", teeTime: "08:40", round: 1, teeSheetUrl: "https://app.example.com/portal/tournaments/55/tee-sheet" },
  "wearable.reauth.required": { provider: "Garmin Connect", reauthUrl: "https://app.example.com/wearables" },
  "interclub.qualified": { eventName: "Coastal Inter-Club", qualifiedFrom: "Spring Open", eventUrl: "https://app.example.com/events/interclub-2026" },
  "streak.milestone": { streakLabel: "10 sub-90 rounds", days: 30, streakUrl: "https://app.example.com/portal/streaks" },
  "near.miss": { achievementName: "10 Rounds Played", gap: "1", profileUrl: "https://app.example.com/portal/profile/badges" },
  "verified.handicap.expiring": { expiresOn: "2026-06-01", handicapNumber: "VH-1042", renewUrl: "https://app.example.com/portal/handicap/renew" },
};

/**
 * For each branded key, declare which sample-data field carries the
 * deep-link the renderer should surface as a CTA, plus the CTA button
 * label the renderer is expected to use. This drives the explicit
 * CTA-path assertions below — the snapshot tests on their own would
 * miss a renderer that silently dropped the CTA branch.
 */
// Re-export the canonical shared maps under the in-file names this
// suite already uses, so the assertions below stay readable.
const CTA_EXPECTATIONS = SHARED_CTA_EXPECTATIONS;
const EXPECTED_KEYS = [...EXPECTED_BRANDED_KEYS];

function ctxFor(key: string): NotificationEmailContext {
  return {
    recipientName: "Jordan Spieth",
    branding: BRANDING,
    title: "Notification",
    body: "You have a new notification.",
    data: SAMPLE_DATA[key] ?? {},
  };
}

/**
 * Strip volatile content from the rendered HTML so snapshots stay
 * stable across cosmetic refactors of the wrap helper while still
 * catching changes to the body / header / footer text.
 */
function shape(html: string): string {
  return html
    .replace(/\s+/g, " ")
    .replace(/style="[^"]*"/g, 'style="…"')
    .trim();
}

describe("notificationEmailTemplates — registry", () => {
  it("exports exactly the 29 branded keys promised by Task #1171", () => {
    const keys = listBrandedNotificationKeys();
    expect(keys).toEqual(EXPECTED_KEYS);
    expect(keys).toHaveLength(29);
  });

  it("returns null for an unregistered key (dispatcher falls back)", () => {
    const out = renderNotificationEmail("totally.bogus.key", ctxFor("achievement.unlocked"));
    expect(out).toBeNull();
  });
});

describe("notificationEmailTemplates — every renderer produces a branded email", () => {
  for (const key of EXPECTED_KEYS) {
    it(`${key} → renders subject + branded HTML + plaintext`, () => {
      const out = renderNotificationEmail(key, ctxFor(key));
      expect(out).not.toBeNull();
      const { subject, html, text } = out!;

      // Basic envelope shape.
      expect(subject).toBeTruthy();
      expect(typeof subject).toBe("string");
      expect(html).toContain("<div");
      expect(text).toContain("Hi Jordan Spieth");
      expect(text).toContain("Pebble Beach GC");

      // Branded header is rendered (club name surfaces somewhere in
      // the header block; primary colour is applied to the gradient).
      expect(html).toContain("Pebble Beach GC");
      expect(html.toLowerCase()).toContain("#1e4d2b");

      // Footer surfaces the notification key for support transparency.
      expect(html).toContain(key);
    });
  }
});

describe("notificationEmailTemplates — visual snapshots", () => {
  for (const key of EXPECTED_KEYS) {
    it(`${key} → matches snapshot`, () => {
      const out = renderNotificationEmail(key, ctxFor(key));
      expect(out).not.toBeNull();
      expect({
        key,
        subject: out!.subject,
        text: out!.text,
        html: shape(out!.html),
      }).toMatchSnapshot();
    });
  }
});

describe("notificationEmailTemplates — recipient personalisation", () => {
  it("falls back to 'there' when the recipient name is missing", () => {
    const ctx = ctxFor("achievement.unlocked");
    ctx.recipientName = null;
    const out = renderNotificationEmail("achievement.unlocked", ctx);
    expect(out).not.toBeNull();
    expect(out!.text).toContain("Hi there");
    expect(out!.html).toContain("there");
  });

  it("falls back to 'your club' when no branding is supplied", () => {
    const ctx: NotificationEmailContext = {
      recipientName: "Jordan",
      title: "Hello",
      body: "Body",
      data: SAMPLE_DATA["achievement.unlocked"]!,
    };
    const out = renderNotificationEmail("achievement.unlocked", ctx);
    expect(out).not.toBeNull();
    // Header default name kicks in.
    expect(out!.html).toContain("KHARAGOLF");
    // Plaintext footer uses the `clubName()` fallback.
    expect(out!.text).toContain("your club");
  });
});

describe("notificationEmailTemplates — CTA deep-link coverage (Task #1357)", () => {
  it("declares a CTA expectation for every branded key", () => {
    // Guards against a future renderer being added without a matching
    // CTA assertion below — every key in the registry must have an
    // entry in CTA_EXPECTATIONS.
    expect(Object.keys(CTA_EXPECTATIONS).sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  for (const key of EXPECTED_KEYS) {
    const expectation = CTA_EXPECTATIONS[key]!;
    it(`${key} → renders an ${expectation.label} CTA pointing at ${expectation.urlField}`, () => {
      const data = SAMPLE_DATA[key]!;
      const expectedUrl = data[expectation.urlField];
      // Sanity check — sample data must actually carry the URL we
      // claim the renderer should pick up. Otherwise the assertion
      // below would silently pass on a renderer that dropped the CTA.
      expect(typeof expectedUrl).toBe("string");

      const out = renderNotificationEmail(key, ctxFor(key));
      expect(out).not.toBeNull();
      const { html, text } = out!;

      // CTA button is rendered with the expected label + href.
      expect(html).toContain(`href="${expectedUrl as string}"`);
      expect(html).toContain(expectation.label);
      // Plaintext alternative includes the same link so non-HTML
      // clients still get a click target.
      expect(text).toContain(expectedUrl as string);
    });
  }

  it("tournament.cut.applied → swaps CTA to 'View leaderboard' when madeCut=false", () => {
    // The survivor branch (madeCut=true) is exercised by the loop
    // above. Lock the eliminated-player branch explicitly so a future
    // refactor of the alias-priority chain can't silently regress
    // either path.
    const ctx: NotificationEmailContext = {
      recipientName: "Jordan Spieth",
      branding: BRANDING,
      title: "Cut applied",
      body: "The cut has been set.",
      data: {
        tournamentName: "Spring Open",
        throughRound: 2,
        madeCut: false,
        groupingUrl: "https://app.example.com/portal/tournaments/55/grouping",
        leaderboardUrl: "https://app.example.com/leaderboard/55",
      },
    };
    const out = renderNotificationEmail("tournament.cut.applied", ctx);
    expect(out).not.toBeNull();
    const { html, text } = out!;
    // CTA should point at the leaderboard, not the round-3 grouping.
    expect(html).toContain('href="https://app.example.com/leaderboard/55"');
    expect(html).toContain("View leaderboard");
    expect(html).not.toContain("View grouping");
    expect(text).toContain("https://app.example.com/leaderboard/55");
  });

  it("omits the CTA when no URL is supplied", () => {
    // Renderers must degrade gracefully — if the dispatch site doesn't
    // populate a URL field, no naked button or stray placeholder
    // should appear in the output.
    const ctx: NotificationEmailContext = {
      recipientName: "Jordan",
      branding: BRANDING,
      title: "Ping",
      body: "Body",
      data: { courseName: "Ocean Course", teeTime: "08:40" },
    };
    const out = renderNotificationEmail("booking.confirmed", ctx);
    expect(out).not.toBeNull();
    expect(out!.html).not.toContain("View booking");
    expect(out!.html).not.toContain("href=\"undefined\"");
  });
});

/* ─── Task #2012 — post.event.survey reminder variant ───────────────── */

describe("notificationEmailTemplates — post.event.survey reminder variant (Task #2012)", () => {
  // The admin-fired follow-up nudge sets `data.isReminder = true` so
  // the renderer swaps in the "Reminder: …" subject + closing + text.
  // These snapshots lock both branches of the `isReminder` switch so a
  // future change to the bundle wiring breaks loudly.
  function reminderCtx(): NotificationEmailContext {
    return {
      recipientName: "Jordan Spieth",
      branding: BRANDING,
      title: "Notification",
      body: "You have a new notification.",
      data: { ...SAMPLE_DATA["post.event.survey"], isReminder: true },
    };
  }

  it("English reminder uses the reminder subject, closing and plaintext", () => {
    const out = renderNotificationEmail("post.event.survey", reminderCtx());
    expect(out).not.toBeNull();
    const { subject, html, text } = out!;
    expect(subject).toBe("Reminder: How was Spring Open? — Quick feedback");
    expect(html).toContain("We'd still love a couple of minutes of feedback so the next event is even better.");
    expect(text).toContain("Reminder — please share quick feedback on Spring Open.");
    expect({ key: "post.event.survey", variant: "reminder", subject, text, html: shape(html) }).toMatchSnapshot();
  });

  it("non-reminder branch (no isReminder flag) keeps the original subject", () => {
    const out = renderNotificationEmail("post.event.survey", ctxFor("post.event.survey"));
    expect(out).not.toBeNull();
    expect(out!.subject).toBe("How was Spring Open? — Quick feedback");
    expect(out!.subject).not.toContain("Reminder");
    expect(out!.text).not.toContain("Reminder —");
  });

  it("isReminder=false explicitly is treated as the normal variant", () => {
    const out = renderNotificationEmail("post.event.survey", {
      recipientName: "Jordan Spieth",
      branding: BRANDING,
      title: "Notification",
      body: "Body",
      data: { ...SAMPLE_DATA["post.event.survey"], isReminder: false },
    });
    expect(out).not.toBeNull();
    expect(out!.subject).toBe("How was Spring Open? — Quick feedback");
  });
});

describe("notificationEmailTemplates — registry parity with NOTIFICATION_EMAIL_TEMPLATES", () => {
  it("listBrandedNotificationKeys mirrors the registry export", () => {
    const fromList = listBrandedNotificationKeys();
    const fromRegistry = Object.keys(NOTIFICATION_EMAIL_TEMPLATES).sort();
    expect(fromList).toEqual(fromRegistry);
  });

  it("every registry entry is a callable renderer", () => {
    for (const [key, renderer] of Object.entries(NOTIFICATION_EMAIL_TEMPLATES)) {
      expect(typeof renderer).toBe("function");
      const out = renderer(ctxFor(key));
      expect(out.subject.length).toBeGreaterThan(0);
      expect(out.html.length).toBeGreaterThan(0);
      expect(out.text.length).toBeGreaterThan(0);
    }
  });
});
