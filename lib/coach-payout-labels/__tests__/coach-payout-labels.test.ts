/**
 * Unit test: shared coach-payout label helpers (Task #1912).
 *
 * The helpers in `@workspace/coach-payout-labels` were extracted from
 * three duplicate per-artifact copies (admin web, coach web, coach mobile)
 * so a single source of truth feeds the badge/text mappings, the cron's
 * per-channel cap, and the coach-side "Try again" cooldown. Coverage
 * existed only indirectly via the api-server retry-cron tests, which
 * exercise the cap constants but never the label/badge/text helpers.
 *
 * This suite covers, exhaustively:
 *   - `coachPayoutChannelLabel` for every status branch (null, sent,
 *     failed, exhausted by `attempts >= max`, exhausted by stamped
 *     `*RetryExhaustedAt`, skipped, no_user, no_address, opted_out,
 *     and unknown statuses → "failed" fallback).
 *   - `isCoachPayoutChannelResettable` for every label.
 *   - `coachPayoutBothChannelsNonSent` for the (sent × sent),
 *     (sent × non-sent), (non-sent × sent), and (non-sent × non-sent)
 *     combinations.
 *   - `coachPayoutChannelBadgeStyle` and `coachPayoutChannelText`
 *     for every label, plus the mobile alias `coachPayoutChannelColors`.
 *   - `coachEarningsTabLabel` fallback behaviour.
 *   - `coachPayoutCanCoachRetry` cooldown / resettability gating.
 */
import { describe, it, expect } from "vitest";
import {
  COACH_PAYOUT_MAX_PUSH_ATTEMPTS,
  COACH_PAYOUT_MAX_SMS_ATTEMPTS,
  COACH_PAYOUT_COACH_RETRY_COOLDOWN_MS,
  COACH_EARNINGS_TAB_LABEL,
  COACH_PAYOUT_TRIED_TARGET_LABEL,
  COACH_PAYOUT_UPDATE_PREFS_LINK_LABEL,
  type CoachPayoutChannelLabel,
  type CoachPayoutNotificationAttempt,
  coachPayoutChannelLabel,
  coachPayoutChannelBadgeStyle,
  coachPayoutChannelColors,
  coachPayoutChannelText,
  coachPayoutBothChannelsNonSent,
  coachEarningsTabLabel,
  coachPayoutTriedTargetLabel,
  coachPayoutUpdatePrefsLinkLabel,
  coachPayoutCanCoachRetry,
  coachPayoutRetryState,
  formatCoachPayoutRetryCountdown,
  isCoachPayoutChannelResettable,
} from "../src/index";

const ALL_LABELS: CoachPayoutChannelLabel[] = [
  "sent",
  "failed",
  "exhausted",
  "skipped",
  "no_user",
  "no_address",
  "opted_out",
  "pending",
];

describe("coach-payout-labels: cap constants", () => {
  it("keeps the per-channel attempt caps in sync with the cron", () => {
    expect(COACH_PAYOUT_MAX_PUSH_ATTEMPTS).toBe(5);
    expect(COACH_PAYOUT_MAX_SMS_ATTEMPTS).toBe(5);
  });

  it("keeps the coach-side retry cooldown at five minutes", () => {
    expect(COACH_PAYOUT_COACH_RETRY_COOLDOWN_MS).toBe(5 * 60 * 1000);
  });
});

describe("coachPayoutChannelLabel", () => {
  it("returns 'pending' for null status (pre-first-attempt rows)", () => {
    expect(coachPayoutChannelLabel(null, 0, null, 5)).toBe("pending");
    // Even if attempts/exhaustedAt are populated, null status wins.
    expect(coachPayoutChannelLabel(null, 99, "2026-04-30T00:00:00Z", 5)).toBe(
      "pending",
    );
  });

  it("returns 'pending' for empty-string status", () => {
    expect(coachPayoutChannelLabel("", 0, null, 5)).toBe("pending");
  });

  it("maps 'sent' through unchanged", () => {
    expect(coachPayoutChannelLabel("sent", 1, null, 5)).toBe("sent");
  });

  it("maps 'skipped' through unchanged", () => {
    expect(coachPayoutChannelLabel("skipped", 0, null, 5)).toBe("skipped");
  });

  it("maps 'no_user' / 'no_address' / 'opted_out' through unchanged", () => {
    expect(coachPayoutChannelLabel("no_user", 0, null, 5)).toBe("no_user");
    expect(coachPayoutChannelLabel("no_address", 0, null, 5)).toBe("no_address");
    expect(coachPayoutChannelLabel("opted_out", 0, null, 5)).toBe("opted_out");
  });

  it("returns 'failed' when status='failed' and attempts < max with no exhaustedAt", () => {
    expect(coachPayoutChannelLabel("failed", 0, null, 5)).toBe("failed");
    expect(coachPayoutChannelLabel("failed", 4, null, 5)).toBe("failed");
  });

  it("returns 'exhausted' once attempts hits the cap", () => {
    expect(coachPayoutChannelLabel("failed", 5, null, 5)).toBe("exhausted");
    expect(coachPayoutChannelLabel("failed", 6, null, 5)).toBe("exhausted");
  });

  it("returns 'exhausted' when *RetryExhaustedAt is stamped, even below the cap", () => {
    // The cron stamps the exhaustion timestamp before bumping attempts in
    // some paths, so a stamped exhaustedAt with low attempts must still
    // surface as "exhausted" to the badge.
    expect(
      coachPayoutChannelLabel("failed", 1, "2026-04-30T00:00:00Z", 5),
    ).toBe("exhausted");
    expect(
      coachPayoutChannelLabel("failed", 0, "2026-04-30T00:00:00Z", 5),
    ).toBe("exhausted");
  });

  it("respects an artifact-specific maxAttempts override", () => {
    // Mobile/web are free to pass either MAX_PUSH or MAX_SMS in. Both
    // currently match (5), but the helper itself must honour the
    // caller's value rather than hard-coding the constant.
    expect(coachPayoutChannelLabel("failed", 2, null, 3)).toBe("failed");
    expect(coachPayoutChannelLabel("failed", 3, null, 3)).toBe("exhausted");
  });

  it("falls back to 'failed' for an unknown / drifted status string", () => {
    expect(coachPayoutChannelLabel("queued", 0, null, 5)).toBe("failed");
    expect(coachPayoutChannelLabel("retrying", 0, null, 5)).toBe("failed");
  });
});

describe("isCoachPayoutChannelResettable", () => {
  it("returns true for failed / exhausted / skipped", () => {
    expect(isCoachPayoutChannelResettable("failed")).toBe(true);
    expect(isCoachPayoutChannelResettable("exhausted")).toBe(true);
    expect(isCoachPayoutChannelResettable("skipped")).toBe(true);
  });

  it("returns false for sent / pending / opted_out / no_user / no_address", () => {
    expect(isCoachPayoutChannelResettable("sent")).toBe(false);
    expect(isCoachPayoutChannelResettable("pending")).toBe(false);
    expect(isCoachPayoutChannelResettable("opted_out")).toBe(false);
    expect(isCoachPayoutChannelResettable("no_user")).toBe(false);
    expect(isCoachPayoutChannelResettable("no_address")).toBe(false);
  });

  it("covers every CoachPayoutChannelLabel exactly once", () => {
    // Drift guard: if a new label is added the union widens and the
    // resettable helper must be re-considered. This loop ensures we
    // explicitly classify every label rather than relying on the
    // default-false branch.
    const resettable = new Set<CoachPayoutChannelLabel>([
      "failed",
      "exhausted",
      "skipped",
    ]);
    for (const label of ALL_LABELS) {
      expect(isCoachPayoutChannelResettable(label)).toBe(resettable.has(label));
    }
  });
});

describe("coachPayoutBothChannelsNonSent", () => {
  it("returns false when push channel was 'sent'", () => {
    expect(coachPayoutBothChannelsNonSent("sent", "failed")).toBe(false);
    expect(coachPayoutBothChannelsNonSent("sent", "pending")).toBe(false);
    expect(coachPayoutBothChannelsNonSent("sent", "sent")).toBe(false);
  });

  it("returns false when sms channel was 'sent'", () => {
    expect(coachPayoutBothChannelsNonSent("failed", "sent")).toBe(false);
    expect(coachPayoutBothChannelsNonSent("exhausted", "sent")).toBe(false);
    expect(coachPayoutBothChannelsNonSent("pending", "sent")).toBe(false);
  });

  it("returns true when neither channel reached 'sent'", () => {
    const nonSent: CoachPayoutChannelLabel[] = [
      "failed",
      "exhausted",
      "skipped",
      "no_user",
      "no_address",
      "opted_out",
      "pending",
    ];
    for (const push of nonSent) {
      for (const sms of nonSent) {
        expect(coachPayoutBothChannelsNonSent(push, sms)).toBe(true);
      }
    }
  });
});

describe("coachPayoutChannelBadgeStyle", () => {
  it("maps every label to a unique-per-state colour pair", () => {
    expect(coachPayoutChannelBadgeStyle("sent")).toEqual({
      bg: "#1a4d2e",
      fg: "#86efac",
    });
    expect(coachPayoutChannelBadgeStyle("failed")).toEqual({
      bg: "#5a2d1a",
      fg: "#fca5a5",
    });
    expect(coachPayoutChannelBadgeStyle("exhausted")).toEqual({
      bg: "#3f1d1d",
      fg: "#f87171",
    });
    expect(coachPayoutChannelBadgeStyle("skipped")).toEqual({
      bg: "#2a2a2a",
      fg: "#cbd5e1",
    });
    expect(coachPayoutChannelBadgeStyle("opted_out")).toEqual({
      bg: "#2a2a2a",
      fg: "#cbd5e1",
    });
    expect(coachPayoutChannelBadgeStyle("no_user")).toEqual({
      bg: "#2a2a2a",
      fg: "#cbd5e1",
    });
    expect(coachPayoutChannelBadgeStyle("no_address")).toEqual({
      bg: "#2a2a2a",
      fg: "#cbd5e1",
    });
    expect(coachPayoutChannelBadgeStyle("pending")).toEqual({
      bg: "#2a2a2a",
      fg: "#9ca3af",
    });
  });

  it("returns a defined { bg, fg } pair for every label", () => {
    for (const label of ALL_LABELS) {
      const style = coachPayoutChannelBadgeStyle(label);
      expect(style.bg).toMatch(/^#[0-9a-f]{6}$/i);
      expect(style.fg).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("exposes the same style under the mobile alias coachPayoutChannelColors", () => {
    for (const label of ALL_LABELS) {
      expect(coachPayoutChannelColors(label)).toEqual(
        coachPayoutChannelBadgeStyle(label),
      );
    }
    expect(coachPayoutChannelColors).toBe(coachPayoutChannelBadgeStyle);
  });
});

describe("coachPayoutChannelText", () => {
  it("maps every label to its UI string", () => {
    expect(coachPayoutChannelText("sent")).toBe("Sent");
    expect(coachPayoutChannelText("failed")).toBe("Failed (will retry)");
    expect(coachPayoutChannelText("exhausted")).toBe("Failed (gave up)");
    expect(coachPayoutChannelText("skipped")).toBe("Skipped");
    expect(coachPayoutChannelText("opted_out")).toBe("Opted out");
    expect(coachPayoutChannelText("no_user")).toBe("No app user");
    expect(coachPayoutChannelText("no_address")).toBe("No phone");
    expect(coachPayoutChannelText("pending")).toBe("Pending");
  });

  it("returns a non-empty string for every label", () => {
    for (const label of ALL_LABELS) {
      const text = coachPayoutChannelText(label);
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
    }
  });
});

describe("coachEarningsTabLabel", () => {
  it("returns the English label when lang is null/undefined/empty", () => {
    expect(coachEarningsTabLabel(null)).toBe("Earnings");
    expect(coachEarningsTabLabel(undefined)).toBe("Earnings");
    expect(coachEarningsTabLabel("")).toBe("Earnings");
  });

  it("returns the localised label for every supported language", () => {
    for (const [lang, label] of Object.entries(COACH_EARNINGS_TAB_LABEL)) {
      expect(coachEarningsTabLabel(lang)).toBe(label);
    }
  });

  it("falls back to English for unknown language codes", () => {
    expect(coachEarningsTabLabel("xx")).toBe("Earnings");
    expect(coachEarningsTabLabel("klingon")).toBe("Earnings");
  });

  it("uses the parenthetical English root in every translation", () => {
    // Drift guard for Task #1820: every localised value must keep the
    // bare English literal so the still-partially-English coach
    // workspace navigation stays scannable.
    for (const [lang, label] of Object.entries(COACH_EARNINGS_TAB_LABEL)) {
      if (lang === "en") {
        expect(label).toBe("Earnings");
      } else {
        expect(label).toContain("Earnings");
      }
    }
  });
});

describe("coachPayoutTriedTargetLabel", () => {
  // Stand-in for the masked snapshot the cron stamps on each attempt
  // (e.g. "+91 ●●●●●● 4321"). The exact format is opaque to the
  // helper — it just substitutes whatever the caller passes.
  const TARGET = "+91 ●●●●●● 4321";

  it("returns the English template for null/undefined/empty lang", () => {
    expect(coachPayoutTriedTargetLabel(null, TARGET)).toBe(`tried ${TARGET}`);
    expect(coachPayoutTriedTargetLabel(undefined, TARGET)).toBe(`tried ${TARGET}`);
    expect(coachPayoutTriedTargetLabel("", TARGET)).toBe(`tried ${TARGET}`);
  });

  it("substitutes {target} for every supported language", () => {
    for (const [lang, template] of Object.entries(COACH_PAYOUT_TRIED_TARGET_LABEL)) {
      const expected = template.replace("{target}", TARGET);
      expect(coachPayoutTriedTargetLabel(lang, TARGET)).toBe(expected);
      // Drift guard: the substituted output must include the masked
      // contact so a coach scanning the cell can actually see *which*
      // device / phone we tried.
      expect(coachPayoutTriedTargetLabel(lang, TARGET)).toContain(TARGET);
    }
  });

  it("falls back to the English template for unknown language codes", () => {
    expect(coachPayoutTriedTargetLabel("xx", TARGET)).toBe(`tried ${TARGET}`);
    expect(coachPayoutTriedTargetLabel("klingon", TARGET)).toBe(`tried ${TARGET}`);
  });

  it("includes a {target} placeholder in every locale template", () => {
    // Drift guard: a translator dropping the placeholder would silently
    // erase the masked contact from the cell. Catch it at lint time.
    for (const [, template] of Object.entries(COACH_PAYOUT_TRIED_TARGET_LABEL)) {
      expect(template).toContain("{target}");
    }
  });
});

describe("coachPayoutUpdatePrefsLinkLabel", () => {
  it("returns the English label for null/undefined/empty lang", () => {
    expect(coachPayoutUpdatePrefsLinkLabel(null)).toBe("Update notification settings");
    expect(coachPayoutUpdatePrefsLinkLabel(undefined)).toBe("Update notification settings");
    expect(coachPayoutUpdatePrefsLinkLabel("")).toBe("Update notification settings");
  });

  it("returns the localised label for every supported language", () => {
    for (const [lang, label] of Object.entries(COACH_PAYOUT_UPDATE_PREFS_LINK_LABEL)) {
      expect(coachPayoutUpdatePrefsLinkLabel(lang)).toBe(label);
    }
  });

  it("falls back to English for unknown language codes", () => {
    expect(coachPayoutUpdatePrefsLinkLabel("xx")).toBe("Update notification settings");
    expect(coachPayoutUpdatePrefsLinkLabel("klingon")).toBe("Update notification settings");
  });

  it("returns a non-empty string for every supported language", () => {
    for (const label of Object.values(COACH_PAYOUT_UPDATE_PREFS_LINK_LABEL)) {
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("covers the same language set as the other coach-earnings-cell tables", () => {
    // Drift guard: if a new locale is added to COACH_EARNINGS_TAB_LABEL
    // (the existing translation table the same files import) the two
    // new payout-notification tables must keep up — otherwise that
    // locale's coach would see a partially-localised cell with the
    // tab in the right language but the inline note still in English.
    const tabLangs = Object.keys(COACH_EARNINGS_TAB_LABEL).sort();
    expect(Object.keys(COACH_PAYOUT_TRIED_TARGET_LABEL).sort()).toEqual(tabLangs);
    expect(Object.keys(COACH_PAYOUT_UPDATE_PREFS_LINK_LABEL).sort()).toEqual(tabLangs);
  });
});

function makeAttempt(
  overrides: Partial<CoachPayoutNotificationAttempt> = {},
): CoachPayoutNotificationAttempt {
  return {
    id: 1,
    pushStatus: null,
    pushAttempts: 0,
    lastPushAt: null,
    lastPushError: null,
    pushRetryExhaustedAt: null,
    smsStatus: null,
    smsAttempts: 0,
    lastSmsAt: null,
    lastSmsError: null,
    smsRetryExhaustedAt: null,
    coachRetryRequestedAt: null,
    pushTargetLabel: null,
    smsTargetMasked: null,
    ...overrides,
  };
}

describe("coachPayoutCanCoachRetry", () => {
  const NOW = Date.parse("2026-04-30T12:00:00Z");

  it("returns false when the notification row is null", () => {
    expect(coachPayoutCanCoachRetry(null, NOW)).toBe(false);
  });

  it("returns false when both channels are non-resettable (e.g. sent + pending)", () => {
    const attempt = makeAttempt({ pushStatus: "sent", smsStatus: null });
    expect(coachPayoutCanCoachRetry(attempt, NOW)).toBe(false);
  });

  it("returns true when the push channel has failed and is resettable", () => {
    const attempt = makeAttempt({
      pushStatus: "failed",
      pushAttempts: 1,
      smsStatus: "sent",
    });
    expect(coachPayoutCanCoachRetry(attempt, NOW)).toBe(true);
  });

  it("returns true when only the sms channel is resettable", () => {
    const attempt = makeAttempt({
      pushStatus: "sent",
      smsStatus: "failed",
      smsAttempts: 1,
    });
    expect(coachPayoutCanCoachRetry(attempt, NOW)).toBe(true);
  });

  it("returns true when an exhausted channel can be reset", () => {
    const attempt = makeAttempt({
      pushStatus: "failed",
      pushAttempts: COACH_PAYOUT_MAX_PUSH_ATTEMPTS,
      smsStatus: "sent",
    });
    expect(coachPayoutCanCoachRetry(attempt, NOW)).toBe(true);
  });

  it("returns false during the cooldown window after the coach last retried", () => {
    const attempt = makeAttempt({
      pushStatus: "failed",
      pushAttempts: 1,
      coachRetryRequestedAt: new Date(NOW - 60_000).toISOString(),
    });
    expect(coachPayoutCanCoachRetry(attempt, NOW)).toBe(false);
  });

  it("returns true once the cooldown window has elapsed", () => {
    const attempt = makeAttempt({
      pushStatus: "failed",
      pushAttempts: 1,
      coachRetryRequestedAt: new Date(
        NOW - COACH_PAYOUT_COACH_RETRY_COOLDOWN_MS - 1_000,
      ).toISOString(),
    });
    expect(coachPayoutCanCoachRetry(attempt, NOW)).toBe(true);
  });

  it("ignores an unparseable coachRetryRequestedAt and falls back to the resettable check", () => {
    const attempt = makeAttempt({
      pushStatus: "failed",
      pushAttempts: 1,
      coachRetryRequestedAt: "not-a-date",
    });
    expect(coachPayoutCanCoachRetry(attempt, NOW)).toBe(true);
  });

  it("honours a custom cooldownMs override", () => {
    const attempt = makeAttempt({
      pushStatus: "failed",
      pushAttempts: 1,
      coachRetryRequestedAt: new Date(NOW - 30_000).toISOString(),
    });
    // Default cooldown (5 min) blocks; override to 10s should allow.
    expect(coachPayoutCanCoachRetry(attempt, NOW)).toBe(false);
    expect(coachPayoutCanCoachRetry(attempt, NOW, 10_000)).toBe(true);
  });
});

describe("coachPayoutRetryState (Task #1913)", () => {
  const NOW = Date.parse("2026-04-30T12:00:00Z");

  it("returns hidden when the notification row is null", () => {
    expect(coachPayoutRetryState(null, NOW)).toEqual({
      kind: "hidden",
      remainingMs: 0,
    });
  });

  it("returns hidden when neither channel is resettable", () => {
    const attempt = makeAttempt({ pushStatus: "sent", smsStatus: null });
    expect(coachPayoutRetryState(attempt, NOW)).toEqual({
      kind: "hidden",
      remainingMs: 0,
    });
  });

  it("returns button when push has failed and there is no cooldown stamp", () => {
    const attempt = makeAttempt({
      pushStatus: "failed",
      pushAttempts: 1,
      smsStatus: "sent",
    });
    expect(coachPayoutRetryState(attempt, NOW)).toEqual({
      kind: "button",
      remainingMs: 0,
    });
  });

  it("returns countdown with the remaining ms while cooldown is still ticking", () => {
    const elapsed = 60_000; // 1 minute into the 5-minute cooldown
    const attempt = makeAttempt({
      pushStatus: "failed",
      pushAttempts: 1,
      coachRetryRequestedAt: new Date(NOW - elapsed).toISOString(),
    });
    const state = coachPayoutRetryState(attempt, NOW);
    expect(state.kind).toBe("countdown");
    expect(state.remainingMs).toBe(
      COACH_PAYOUT_COACH_RETRY_COOLDOWN_MS - elapsed,
    );
  });

  it("returns button the moment the cooldown clears", () => {
    const attempt = makeAttempt({
      pushStatus: "failed",
      pushAttempts: 1,
      coachRetryRequestedAt: new Date(
        NOW - COACH_PAYOUT_COACH_RETRY_COOLDOWN_MS,
      ).toISOString(),
    });
    expect(coachPayoutRetryState(attempt, NOW)).toEqual({
      kind: "button",
      remainingMs: 0,
    });
  });

  it("ignores an unparseable coachRetryRequestedAt and shows the button", () => {
    const attempt = makeAttempt({
      pushStatus: "failed",
      pushAttempts: 1,
      coachRetryRequestedAt: "not-a-date",
    });
    expect(coachPayoutRetryState(attempt, NOW)).toEqual({
      kind: "button",
      remainingMs: 0,
    });
  });

  it("honours a custom cooldownMs override", () => {
    const attempt = makeAttempt({
      pushStatus: "failed",
      pushAttempts: 1,
      coachRetryRequestedAt: new Date(NOW - 30_000).toISOString(),
    });
    // Default cooldown (5 min) → still in countdown.
    const def = coachPayoutRetryState(attempt, NOW);
    expect(def.kind).toBe("countdown");
    // Override to 10s → cooldown long elapsed, button shown.
    expect(coachPayoutRetryState(attempt, NOW, 10_000)).toEqual({
      kind: "button",
      remainingMs: 0,
    });
  });

  it("agrees with coachPayoutCanCoachRetry on the boolean projection", () => {
    // Drift guard: the boolean helper now delegates to this state
    // helper, so for any input the two MUST agree on whether to show
    // the button.
    const cases: Array<Partial<CoachPayoutNotificationAttempt>> = [
      {},
      { pushStatus: "sent", smsStatus: "sent" },
      { pushStatus: "failed", pushAttempts: 1 },
      {
        pushStatus: "failed",
        pushAttempts: 1,
        coachRetryRequestedAt: new Date(NOW - 60_000).toISOString(),
      },
      {
        pushStatus: "failed",
        pushAttempts: 1,
        coachRetryRequestedAt: new Date(
          NOW - COACH_PAYOUT_COACH_RETRY_COOLDOWN_MS - 1,
        ).toISOString(),
      },
      { smsStatus: "skipped" },
      { pushStatus: "opted_out", smsStatus: "no_address" },
    ];
    for (const overrides of cases) {
      const attempt = makeAttempt(overrides);
      const stateIsButton =
        coachPayoutRetryState(attempt, NOW).kind === "button";
      expect(coachPayoutCanCoachRetry(attempt, NOW)).toBe(stateIsButton);
    }
  });
});

describe("formatCoachPayoutRetryCountdown (Task #1913)", () => {
  it("returns '0s' for a zero / negative duration (cooldown just cleared)", () => {
    expect(formatCoachPayoutRetryCountdown(0)).toBe("0s");
    expect(formatCoachPayoutRetryCountdown(-500)).toBe("0s");
  });

  it("rounds sub-second durations up so the UI shows '1s' rather than '0s'", () => {
    // Ceil semantics: anything > 0ms surfaces as at least one second so
    // a freshly-pressed button doesn't briefly flash "4m 59s" / "0s".
    expect(formatCoachPayoutRetryCountdown(1)).toBe("1s");
    expect(formatCoachPayoutRetryCountdown(999)).toBe("1s");
    expect(formatCoachPayoutRetryCountdown(1_000)).toBe("1s");
    expect(formatCoachPayoutRetryCountdown(1_001)).toBe("2s");
  });

  it("drops the minutes component below 60 seconds", () => {
    expect(formatCoachPayoutRetryCountdown(30_000)).toBe("30s");
    expect(formatCoachPayoutRetryCountdown(59_000)).toBe("59s");
    // 59_001ms rounds up to 60 ceil-seconds, which the formatter
    // promotes to "1m 00s" (the minute branch fires once totalSec
    // reaches 60). 60_000ms exact behaves the same.
    expect(formatCoachPayoutRetryCountdown(59_001)).toBe("1m 00s");
    expect(formatCoachPayoutRetryCountdown(60_000)).toBe("1m 00s");
  });

  it("pads the seconds digit to two when minutes are present", () => {
    // Stable text width so the countdown doesn't jitter between e.g.
    // "4m 9s" (3 chars) and "4m 10s" (4 chars).
    expect(formatCoachPayoutRetryCountdown(60_000 + 9_000)).toBe("1m 09s");
    expect(formatCoachPayoutRetryCountdown(60_000 + 10_000)).toBe("1m 10s");
    expect(formatCoachPayoutRetryCountdown(4 * 60_000 + 30_000)).toBe(
      "4m 30s",
    );
    expect(formatCoachPayoutRetryCountdown(COACH_PAYOUT_COACH_RETRY_COOLDOWN_MS))
      .toBe("5m 00s");
  });
});
