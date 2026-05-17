/**
 * Unit tests for the per-org bounced-reminders digest scheduling rules
 * (Task #274). The cron now polls hourly, so the gating logic in
 * `shouldSendBouncedDigestNow` is the heart of the feature.
 *
 * Two paths are covered:
 *   - Hour-aware path: orgs that opted into a specific local hour.
 *   - Legacy path: orgs with hourLocal=null still fire on a 24h cadence,
 *     matching the pre-Task-#274 setInterval(24h) behaviour.
 */
import { describe, it, expect } from "vitest";
import { shouldSendBouncedDigestNow } from "../lib/cron.js";

describe("shouldSendBouncedDigestNow", () => {
  describe("legacy default (no hourLocal)", () => {
    it("fires on the very first tick when there is no recorded send", () => {
      const now = new Date("2026-04-15T03:30:00Z");
      const out = shouldSendBouncedDigestNow({
        frequency: "daily", hourLocal: null, timezone: null, lastSentOn: null,
      }, now);
      expect(out).toBe(now.toISOString());
    });

    it("blocks a second send less than 24h after the previous one", () => {
      const last = new Date("2026-04-15T03:30:00Z");
      const now = new Date("2026-04-15T22:30:00Z"); // 19h later
      expect(shouldSendBouncedDigestNow({
        frequency: "daily", hourLocal: null, timezone: null,
        lastSentOn: last.toISOString(),
      }, now)).toBeNull();
    });

    it("allows a send once at least ~24h have passed", () => {
      const last = new Date("2026-04-15T03:30:00Z");
      const now = new Date("2026-04-16T03:30:00Z"); // 24h later
      const out = shouldSendBouncedDigestNow({
        frequency: "daily", hourLocal: null, timezone: null,
        lastSentOn: last.toISOString(),
      }, now);
      expect(out).toBe(now.toISOString());
    });

    it("still respects the weekday/weekly day-of-week filters", () => {
      const sun = new Date("2026-04-19T12:00:00Z"); // Sunday
      expect(shouldSendBouncedDigestNow({
        frequency: "weekday", hourLocal: null, timezone: null, lastSentOn: null,
      }, sun)).toBeNull();
      expect(shouldSendBouncedDigestNow({
        frequency: "weekly", hourLocal: null, timezone: null, lastSentOn: null,
      }, sun)).toBeNull();
    });
  });

  describe("hour-aware path", () => {
    it("respects local hour in the configured timezone", () => {
      // 09:30 UTC == 15:00 IST (UTC+5:30) — admin asked for 09:00 IST
      const at0930Utc = new Date("2026-04-15T09:30:00Z");
      expect(shouldSendBouncedDigestNow({
        frequency: "daily", hourLocal: 9, timezone: "Asia/Kolkata", lastSentOn: null,
      }, at0930Utc)).toBeNull();

      // 03:30 UTC == 09:00 IST → eligible
      const at0330Utc = new Date("2026-04-15T03:30:00Z");
      expect(shouldSendBouncedDigestNow({
        frequency: "daily", hourLocal: 9, timezone: "Asia/Kolkata", lastSentOn: null,
      }, at0330Utc)).toBe("2026-04-15");
    });

    it("weekday frequency skips Saturday/Sunday in the org's tz", () => {
      // 2026-04-18 12:00Z is Sat 08:00 EDT
      const sat = new Date("2026-04-18T12:00:00Z");
      expect(shouldSendBouncedDigestNow({
        frequency: "weekday", hourLocal: 8, timezone: "America/New_York", lastSentOn: null,
      }, sat)).toBeNull();
      // Friday equivalent
      const fri = new Date("2026-04-17T12:00:00Z"); // Fri 08:00 EDT
      expect(shouldSendBouncedDigestNow({
        frequency: "weekday", hourLocal: 8, timezone: "America/New_York", lastSentOn: null,
      }, fri)).toBe("2026-04-17");
    });

    it("weekly frequency only fires on Mondays", () => {
      const tue = new Date("2026-04-14T07:00:00Z");
      expect(shouldSendBouncedDigestNow({
        frequency: "weekly", hourLocal: 7, timezone: "UTC", lastSentOn: null,
      }, tue)).toBeNull();

      const mon = new Date("2026-04-13T07:00:00Z");
      expect(shouldSendBouncedDigestNow({
        frequency: "weekly", hourLocal: 7, timezone: "UTC", lastSentOn: null,
      }, mon)).toBe("2026-04-13");
    });

    it("dedup is anchored to the org's local date, not UTC", () => {
      // Sydney is UTC+10 in April → 2026-04-15 14:00Z is 16-Apr 00:00 Sydney
      const lateNightUtc = new Date("2026-04-15T14:00:00Z");
      expect(shouldSendBouncedDigestNow({
        frequency: "daily", hourLocal: 0, timezone: "Australia/Sydney", lastSentOn: null,
      }, lateNightUtc)).toBe("2026-04-16");
      // Already sent today (Sydney) → null
      expect(shouldSendBouncedDigestNow({
        frequency: "daily", hourLocal: 0, timezone: "Australia/Sydney", lastSentOn: "2026-04-16",
      }, lateNightUtc)).toBeNull();
    });

    it("invalid timezone falls back to UTC gating", () => {
      const now = new Date("2026-04-15T07:00:00Z");
      expect(shouldSendBouncedDigestNow({
        frequency: "daily", hourLocal: 7, timezone: "Not/A_Real_TZ", lastSentOn: null,
      }, now)).toBe("2026-04-15");
    });
  });
});
