/**
 * Tests for Task #2002 — auto-page on-call when the daily
 * round-weather-cache backfill cron keeps failing or stalling.
 *
 * Covers:
 *   - Pure breach evaluator: each streak detector (failed / pending /
 *     errored) fires only when EVERY entry in the trailing window
 *     exceeds its threshold; mixed entries break the streak; an
 *     all-errored window emits ONLY `errored_streak`; insufficient
 *     history yields no breach.
 *   - Recording: the rolling history buffer is trimmed to the
 *     configured size (FIFO).
 *   - Run job: no breach → no email; breach → emails super-admin +
 *     OPS_ALERT_EMAILS (deduped case-insensitively); cooldown
 *     suppresses re-pages, `force` overrides.
 *   - No recipients (no super_admin email AND OPS_ALERT_EMAILS unset)
 *     returns `no_recipients` instead of throwing.
 *   - Env-driven defaults: thresholds + cooldown + history size pull
 *     from env when not overridden.
 */
process.env.SESSION_SECRET ||= "test-session-secret-for-round-weather-backfill-ops-alert";

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => ({
  sendRoundWeatherBackfillOpsAlertEmail: vi.fn(async () => undefined),
}));

vi.mock("../lib/push.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/push.js")>(
    "../lib/push.js",
  );
  return {
    ...actual,
    sendPushToUsers: vi.fn(async (userIds: number[]) => ({
      attempted: userIds.length,
      sent: userIds.length,
      failed: 0,
      invalid: 0,
    })),
  };
});

import {
  appUsersTable,
  db,
  organizationsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

import {
  evaluateRoundWeatherBackfillBreaches,
  recordRoundWeatherBackfillPass,
  runRoundWeatherBackfillOpsAlertJob,
  _resetRoundWeatherBackfillOpsAlertForTest,
  _getRoundWeatherBackfillPassHistoryForTest,
  DEFAULT_OPS_WEATHER_BACKFILL_FAILED_THRESHOLD,
  DEFAULT_OPS_WEATHER_BACKFILL_PENDING_THRESHOLD,
  DEFAULT_OPS_WEATHER_BACKFILL_CONSECUTIVE_PASSES,
  DEFAULT_OPS_WEATHER_BACKFILL_ERRORED_CONSECUTIVE_PASSES,
  DEFAULT_OPS_WEATHER_BACKFILL_COOLDOWN_HOURS,
  DEFAULT_OPS_WEATHER_BACKFILL_HISTORY_SIZE,
  type RoundWeatherBackfillPassEntry,
} from "../lib/roundWeatherBackfillOpsAlert.js";
import { sendRoundWeatherBackfillOpsAlertEmail } from "../lib/mailer.js";
import { sendPushToUsers } from "../lib/push.js";

const emailMock = vi.mocked(sendRoundWeatherBackfillOpsAlertEmail);
const pushMock = vi.mocked(sendPushToUsers);

let testSuperAdminId: number | null = null;
let testSuperAdminEmail: string | null = null;
let testOrgId: number | null = null;

function completed(
  daysAgo: number,
  fields: { filled?: number; stillPending?: number; failed?: number; total?: number } = {},
): RoundWeatherBackfillPassEntry {
  return {
    kind: "completed",
    at: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
    filled: fields.filled ?? 0,
    stillPending: fields.stillPending ?? 0,
    failed: fields.failed ?? 0,
    total: fields.total ?? 0,
  };
}

function errored(daysAgo: number, message = "boom"): RoundWeatherBackfillPassEntry {
  return {
    kind: "errored",
    at: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
    message,
  };
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  testSuperAdminEmail = `weather_backfill_admin_${stamp}@example.com`;
  const [org] = await db.insert(organizationsTable).values({
    name: `WeatherBackfillOrg_${stamp}`,
    slug: `weather-backfill-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;
  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `weather-backfill-admin-${stamp}`,
    username: `weather_backfill_admin_${stamp}`,
    email: testSuperAdminEmail,
    role: "super_admin",
    organizationId: org.id,
  }).returning({ id: appUsersTable.id });
  testSuperAdminId = admin.id;
});

afterAll(async () => {
  if (testSuperAdminId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, testSuperAdminId));
  }
  if (testOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  }
});

beforeEach(() => {
  emailMock.mockReset();
  emailMock.mockResolvedValue(undefined);
  pushMock.mockReset();
  pushMock.mockImplementation(async (userIds: number[]) => ({
    attempted: userIds.length,
    sent: userIds.length,
    failed: 0,
    invalid: 0,
  }));
  _resetRoundWeatherBackfillOpsAlertForTest();
});

afterEach(() => {
  delete process.env.OPS_ALERT_EMAILS;
  delete process.env.OPS_WEATHER_BACKFILL_FAILED_THRESHOLD;
  delete process.env.OPS_WEATHER_BACKFILL_PENDING_THRESHOLD;
  delete process.env.OPS_WEATHER_BACKFILL_CONSECUTIVE_PASSES;
  delete process.env.OPS_WEATHER_BACKFILL_COOLDOWN_HOURS;
  delete process.env.OPS_WEATHER_BACKFILL_HISTORY_SIZE;
});

describe("evaluateRoundWeatherBackfillBreaches", () => {
  it("returns no breach when history is shorter than the configured streak", () => {
    const breaches = evaluateRoundWeatherBackfillBreaches({
      history: [completed(2, { failed: 5 }), completed(1, { failed: 5 })],
      failedThreshold: 1,
      pendingThreshold: 25,
      consecutivePasses: 3,
    });
    expect(breaches).toEqual([]);
  });

  it("flags a failed_streak when every recent pass exceeds the failed threshold", () => {
    const breaches = evaluateRoundWeatherBackfillBreaches({
      history: [
        completed(4, { failed: 0 }), // outside the window — irrelevant
        completed(3, { failed: 2 }),
        completed(2, { failed: 1 }),
        completed(1, { failed: 7 }),
      ],
      failedThreshold: 1,
      pendingThreshold: 1000, // out of reach
      consecutivePasses: 3,
    });
    expect(breaches).toHaveLength(1);
    expect(breaches[0].kind).toBe("failed_streak");
    expect(breaches[0].detail).toContain("2, 1, 7");
  });

  it("does NOT flag failed_streak when one pass in the window has zero failures", () => {
    const breaches = evaluateRoundWeatherBackfillBreaches({
      history: [
        completed(3, { failed: 1 }),
        completed(2, { failed: 0 }), // breaks the streak
        completed(1, { failed: 1 }),
      ],
      failedThreshold: 1,
      pendingThreshold: 1000,
      consecutivePasses: 3,
    });
    expect(breaches).toEqual([]);
  });

  it("flags a pending_streak when every recent pass exceeds the pending threshold", () => {
    const breaches = evaluateRoundWeatherBackfillBreaches({
      history: [
        completed(3, { stillPending: 30 }),
        completed(2, { stillPending: 28 }),
        completed(1, { stillPending: 31 }),
      ],
      failedThreshold: 1000, // out of reach
      pendingThreshold: 25,
      consecutivePasses: 3,
    });
    expect(breaches).toHaveLength(1);
    expect(breaches[0].kind).toBe("pending_streak");
    expect(breaches[0].detail).toContain("30, 28, 31");
  });

  it("flags both failed_streak AND pending_streak when both detectors trip", () => {
    const breaches = evaluateRoundWeatherBackfillBreaches({
      history: [
        completed(3, { failed: 4, stillPending: 30 }),
        completed(2, { failed: 5, stillPending: 32 }),
        completed(1, { failed: 6, stillPending: 28 }),
      ],
      failedThreshold: 1,
      pendingThreshold: 25,
      consecutivePasses: 3,
    });
    const kinds = breaches.map((b) => b.kind).sort();
    expect(kinds).toEqual(["failed_streak", "pending_streak"]);
  });

  it("flags ONLY errored_streak when every recent pass errored (not failed/pending)", () => {
    const breaches = evaluateRoundWeatherBackfillBreaches({
      history: [
        errored(3, "open-meteo timeout"),
        errored(2, "open-meteo 503"),
        errored(1, "ECONNRESET"),
      ],
      failedThreshold: 1,
      pendingThreshold: 1,
      consecutivePasses: 3,
    });
    expect(breaches).toHaveLength(1);
    expect(breaches[0].kind).toBe("errored_streak");
    expect(breaches[0].detail).toContain("ECONNRESET");
  });

  it("an errored entry inside the window breaks the failed_streak detector", () => {
    const breaches = evaluateRoundWeatherBackfillBreaches({
      history: [
        completed(3, { failed: 5 }),
        errored(2, "boom"),
        completed(1, { failed: 5 }),
      ],
      failedThreshold: 1,
      pendingThreshold: 1000,
      consecutivePasses: 3,
    });
    // Not all errored → no errored_streak. Not all completed →
    // failed_streak/pending_streak don't fire either.
    expect(breaches).toEqual([]);
  });
});

describe("recordRoundWeatherBackfillPass", () => {
  it("trims the rolling history buffer to the configured size (FIFO)", () => {
    for (let i = 0; i < 12; i++) {
      recordRoundWeatherBackfillPass(completed(i, { filled: i }), { historySize: 5 });
    }
    const history = _getRoundWeatherBackfillPassHistoryForTest();
    expect(history).toHaveLength(5);
    // Latest 5 entries — i=7..11 with `filled` matching i.
    const filledValues = history.map((h) =>
      h.kind === "completed" ? h.filled : -1,
    );
    expect(filledValues).toEqual([7, 8, 9, 10, 11]);
  });

  it("falls back to the env-driven history size when no override is given", () => {
    process.env.OPS_WEATHER_BACKFILL_HISTORY_SIZE = "3";
    for (let i = 0; i < 6; i++) {
      recordRoundWeatherBackfillPass(completed(i, { filled: i }));
    }
    expect(_getRoundWeatherBackfillPassHistoryForTest()).toHaveLength(3);
  });
});

describe("runRoundWeatherBackfillOpsAlertJob — no breach", () => {
  it("does not page when no streak detector trips", async () => {
    const res = await runRoundWeatherBackfillOpsAlertJob({
      historyOverride: [
        completed(3, { failed: 0, stillPending: 5 }),
        completed(2, { failed: 0, stillPending: 4 }),
        completed(1, { failed: 0, stillPending: 6 }),
      ],
      failedThreshold: 1,
      pendingThreshold: 25,
      consecutivePasses: 3,
      cooldownHours: 24,
      recipients: ["ops@example.com"],
      pushUserIds: [123],
    });
    expect(res.alerted).toBe(false);
    expect(res.reason).toBe("no_breach");
    expect(emailMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    expect(res.pushDelivery).toBeNull();
  });
});

describe("runRoundWeatherBackfillOpsAlertJob — breach detected", () => {
  it("emails super-admins + OPS_ALERT_EMAILS (deduped case-insensitively) AND pushes super-admins when failed_streak fires", async () => {
    process.env.OPS_ALERT_EMAILS = `oncall@example.com, ops@example.com, ${testSuperAdminEmail!.toUpperCase()}`;
    const res = await runRoundWeatherBackfillOpsAlertJob({
      historyOverride: [
        completed(3, { failed: 4 }),
        completed(2, { failed: 5 }),
        completed(1, { failed: 6 }),
      ],
      failedThreshold: 1,
      pendingThreshold: 1000,
      consecutivePasses: 3,
      cooldownHours: 24,
      now: new Date("2026-04-29T12:00:00Z"),
    });
    expect(res.alerted).toBe(true);
    // 1 DB super-admin + 2 on-call addresses, with the env's UPPERCASE
    // duplicate of the super-admin email collapsed.
    expect(res.recipientsAttempted).toBe(3);
    expect(res.recipientsEmailed).toBe(3);
    expect(emailMock).toHaveBeenCalledTimes(3);
    const firstCall = emailMock.mock.calls[0][0];
    expect(firstCall.dashboardUrl).toMatch(/\/super-admin\/round-weather-cache$/);
    expect(firstCall.failedThreshold).toBe(1);
    expect(firstCall.pendingThreshold).toBe(1000);
    expect(firstCall.consecutivePasses).toBe(3);
    expect(firstCall.cooldownHours).toBe(24);
    expect(firstCall.breaches.map((b) => b.kind)).toEqual(["failed_streak"]);
    expect(firstCall.windowHistory).toHaveLength(3);

    // The super-admin push leg fanned out to the seeded super_admin
    // user id with the breach kinds embedded in the data payload so
    // the mobile app can deep-link straight into the dashboard.
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(res.pushUsersAttempted).toBe(1);
    expect(res.pushDelivery).toEqual({
      attempted: 1,
      sent: 1,
      failed: 0,
      invalid: 0,
    });
    const [pushIds, pushTitle, pushBody, pushData] = pushMock.mock.calls[0];
    expect(pushIds).toEqual([testSuperAdminId]);
    expect(pushTitle).toMatch(/round-weather/i);
    expect(pushBody).toContain("3 consecutive passes");
    expect(pushData).toMatchObject({
      type: "ops_alert_round_weather_backfill",
      breachKinds: ["failed_streak"],
      consecutivePasses: 3,
    });
    expect(String(pushData?.dashboardUrl)).toMatch(
      /\/super-admin\/round-weather-cache$/,
    );
  });

  it("still pages via push when there is no email recipient (push-only success counts as alerted)", async () => {
    const res = await runRoundWeatherBackfillOpsAlertJob({
      historyOverride: [
        errored(3, "boom"),
        errored(2, "boom"),
        errored(1, "boom"),
      ],
      failedThreshold: 1,
      pendingThreshold: 25,
      consecutivePasses: 3,
      cooldownHours: 24,
      recipients: [], // explicit no-email
      pushUserIds: [testSuperAdminId!],
    });
    expect(res.alerted).toBe(true);
    expect(res.recipientsAttempted).toBe(0);
    expect(res.recipientsEmailed).toBe(0);
    expect(res.pushUsersAttempted).toBe(1);
    expect(res.pushDelivery?.sent).toBe(1);
    expect(emailMock).not.toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it("returns no_recipients only when BOTH email and push targets are empty", async () => {
    // Strip the seeded super_admin email so the email union is empty.
    if (testSuperAdminId) {
      await db.update(appUsersTable).set({ email: null }).where(eq(appUsersTable.id, testSuperAdminId));
    }
    try {
      const res = await runRoundWeatherBackfillOpsAlertJob({
        historyOverride: [
          errored(3, "boom"),
          errored(2, "boom"),
          errored(1, "boom"),
        ],
        failedThreshold: 1,
        pendingThreshold: 25,
        consecutivePasses: 3,
        cooldownHours: 24,
        // Empty push override so neither channel has anywhere to go.
        pushUserIds: [],
      });
      expect(res.alerted).toBe(false);
      expect(res.reason).toBe("no_recipients");
      expect(res.breaches.map((b) => b.kind)).toEqual(["errored_streak"]);
      expect(emailMock).not.toHaveBeenCalled();
      expect(pushMock).not.toHaveBeenCalled();
      expect(res.pushDelivery).toBeNull();
    } finally {
      if (testSuperAdminId) {
        await db.update(appUsersTable).set({ email: testSuperAdminEmail }).where(eq(appUsersTable.id, testSuperAdminId));
      }
    }
  });
});

describe("runRoundWeatherBackfillOpsAlertJob — cooldown", () => {
  it("suppresses a second page (email + push) within the cooldown window; force overrides", async () => {
    const t0 = new Date("2026-04-24T09:00:00Z");
    const history = [
      errored(3, "open-meteo down"),
      errored(2, "open-meteo down"),
      errored(1, "open-meteo down"),
    ];
    const baseOpts = {
      historyOverride: history,
      failedThreshold: 1 as const,
      pendingThreshold: 25 as const,
      consecutivePasses: 3 as const,
      cooldownHours: 24 as const,
      recipients: ["ops@example.com"] as string[],
      pushUserIds: [42] as number[],
    };

    const first = await runRoundWeatherBackfillOpsAlertJob({ ...baseOpts, now: t0 });
    expect(first.alerted).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);

    // 12h later — still inside the cooldown window. Neither channel
    // should fire because the cooldown gate runs before recipient
    // resolution + dispatch.
    const second = await runRoundWeatherBackfillOpsAlertJob({
      ...baseOpts,
      now: new Date(t0.getTime() + 12 * 60 * 60 * 1000),
    });
    expect(second.alerted).toBe(false);
    expect(second.reason).toBe("in_cooldown");
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);

    // 25h later — outside the cooldown window.
    const third = await runRoundWeatherBackfillOpsAlertJob({
      ...baseOpts,
      now: new Date(t0.getTime() + 25 * 60 * 60 * 1000),
    });
    expect(third.alerted).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(2);
    expect(pushMock).toHaveBeenCalledTimes(2);

    // `force` bypasses the cooldown immediately.
    const forced = await runRoundWeatherBackfillOpsAlertJob({
      ...baseOpts,
      now: new Date(t0.getTime() + 25 * 60 * 60 * 1000 + 60 * 1000),
      force: true,
    });
    expect(forced.alerted).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(3);
    expect(pushMock).toHaveBeenCalledTimes(3);
  });
});

describe("runRoundWeatherBackfillOpsAlertJob — env-driven defaults", () => {
  it("pulls thresholds + cooldown from env when not overridden", async () => {
    process.env.OPS_WEATHER_BACKFILL_FAILED_THRESHOLD = "3";
    process.env.OPS_WEATHER_BACKFILL_PENDING_THRESHOLD = "50";
    process.env.OPS_WEATHER_BACKFILL_CONSECUTIVE_PASSES = "2";
    process.env.OPS_WEATHER_BACKFILL_COOLDOWN_HOURS = "6";
    const res = await runRoundWeatherBackfillOpsAlertJob({
      historyOverride: [
        // Two passes with failed >= 3 → trips env-driven failed_streak
        // at the env-driven consecutive count of 2.
        completed(2, { failed: 4 }),
        completed(1, { failed: 3 }),
      ],
      recipients: ["ops@example.com"],
      pushUserIds: [],
    });
    expect(res.alerted).toBe(true);
    expect(res.failedThreshold).toBe(3);
    expect(res.pendingThreshold).toBe(50);
    expect(res.consecutivePasses).toBe(2);
    expect(res.cooldownHours).toBe(6);
    expect(emailMock).toHaveBeenCalledTimes(1);
  });

  it("exposes the documented defaults when neither opts nor env are set", async () => {
    expect(DEFAULT_OPS_WEATHER_BACKFILL_FAILED_THRESHOLD).toBe(1);
    expect(DEFAULT_OPS_WEATHER_BACKFILL_PENDING_THRESHOLD).toBe(25);
    expect(DEFAULT_OPS_WEATHER_BACKFILL_CONSECUTIVE_PASSES).toBe(3);
    expect(DEFAULT_OPS_WEATHER_BACKFILL_COOLDOWN_HOURS).toBe(24);
    expect(DEFAULT_OPS_WEATHER_BACKFILL_HISTORY_SIZE).toBe(10);
    const res = await runRoundWeatherBackfillOpsAlertJob({
      historyOverride: [completed(1, { failed: 0 })],
      recipients: ["ops@example.com"],
      pushUserIds: [],
    });
    // Single completed entry is below the default 3-pass streak — no breach.
    expect(res.alerted).toBe(false);
    expect(res.failedThreshold).toBe(DEFAULT_OPS_WEATHER_BACKFILL_FAILED_THRESHOLD);
    expect(res.pendingThreshold).toBe(DEFAULT_OPS_WEATHER_BACKFILL_PENDING_THRESHOLD);
    expect(res.consecutivePasses).toBe(DEFAULT_OPS_WEATHER_BACKFILL_CONSECUTIVE_PASSES);
    expect(res.cooldownHours).toBe(DEFAULT_OPS_WEATHER_BACKFILL_COOLDOWN_HOURS);
  });
});

describe("errored_streak uses an INDEPENDENT (tighter) streak length", () => {
  it("evaluator: 2 consecutive errored passes fire errored_streak even when consecutivePasses=3 (24h trigger)", () => {
    // The cron runs every 24h and the task spec says "or when the
    // cron itself throws for >24h". 2 consecutive errored passes ≈
    // 24h between the first and second throw, so the dedicated
    // errored window must trip before the failed/pending window
    // (default 3 = ~72h) does.
    const breaches = evaluateRoundWeatherBackfillBreaches({
      history: [errored(2, "open-meteo down"), errored(1, "open-meteo down")],
      failedThreshold: 1,
      pendingThreshold: 25,
      consecutivePasses: 3,
      erroredConsecutivePasses: 2,
    });
    expect(breaches).toHaveLength(1);
    expect(breaches[0].kind).toBe("errored_streak");
    // Detail line reflects the dedicated window length, not the
    // failed/pending one.
    expect(breaches[0].detail).toContain("last 2");
  });

  it("evaluator: a single isolated errored pass does NOT fire when erroredConsecutivePasses=2", () => {
    const breaches = evaluateRoundWeatherBackfillBreaches({
      history: [errored(1, "open-meteo down")],
      failedThreshold: 1,
      pendingThreshold: 25,
      consecutivePasses: 3,
      erroredConsecutivePasses: 2,
    });
    expect(breaches).toEqual([]);
  });

  it("evaluator: a completed pass between two errored passes breaks the errored streak", () => {
    const breaches = evaluateRoundWeatherBackfillBreaches({
      history: [
        errored(3, "boom"),
        completed(2, { failed: 0 }),
        errored(1, "boom"),
      ],
      failedThreshold: 1,
      pendingThreshold: 25,
      consecutivePasses: 3,
      erroredConsecutivePasses: 2,
    });
    // Most recent 2 = [completed, errored] → errored_streak fails.
    // Most recent 3 includes a completed → failed_streak / pending_streak need allCompleted, also fails.
    expect(breaches).toEqual([]);
  });

  it("end-to-end: with defaults, 2 consecutive errored passes page after ~24h while the cron is still alive at 3 days for failed", async () => {
    // Two errored passes — should page now (errored window = 2).
    const erroredRes = await runRoundWeatherBackfillOpsAlertJob({
      historyOverride: [errored(2, "boom"), errored(1, "boom")],
      recipients: ["ops@example.com"],
      pushUserIds: [],
    });
    expect(erroredRes.erroredConsecutivePasses).toBe(
      DEFAULT_OPS_WEATHER_BACKFILL_ERRORED_CONSECUTIVE_PASSES,
    );
    expect(erroredRes.alerted).toBe(true);
    expect(erroredRes.breaches.map((b) => b.kind)).toEqual(["errored_streak"]);

    // Reset state and try with two completed-but-failing passes —
    // failed_streak still uses the longer (default 3) window, so two
    // is not enough.
    _resetRoundWeatherBackfillOpsAlertForTest();
    emailMock.mockClear();
    pushMock.mockClear();
    const failedRes = await runRoundWeatherBackfillOpsAlertJob({
      historyOverride: [
        completed(2, { failed: 5 }),
        completed(1, { failed: 5 }),
      ],
      recipients: ["ops@example.com"],
      pushUserIds: [],
    });
    expect(failedRes.consecutivePasses).toBe(
      DEFAULT_OPS_WEATHER_BACKFILL_CONSECUTIVE_PASSES,
    );
    expect(failedRes.alerted).toBe(false);
    expect(failedRes.reason).toBe("no_breach");
  });

  it("env: OPS_WEATHER_BACKFILL_ERRORED_CONSECUTIVE_PASSES overrides the dedicated knob", async () => {
    process.env.OPS_WEATHER_BACKFILL_ERRORED_CONSECUTIVE_PASSES = "4";
    const res = await runRoundWeatherBackfillOpsAlertJob({
      historyOverride: [
        errored(3, "boom"),
        errored(2, "boom"),
        errored(1, "boom"),
      ],
      recipients: ["ops@example.com"],
      pushUserIds: [],
    });
    // Only 3 entries but env knob raises the bar to 4 — no breach.
    expect(res.erroredConsecutivePasses).toBe(4);
    expect(res.alerted).toBe(false);
    expect(res.reason).toBe("no_breach");
  });
});

describe("threshold === 0 disables the corresponding detector", () => {
  it("evaluator: failedThreshold=0 means a window of zero-failed completed passes is NOT a breach", () => {
    const breaches = evaluateRoundWeatherBackfillBreaches({
      history: [
        completed(3, { failed: 0, stillPending: 0 }),
        completed(2, { failed: 0, stillPending: 0 }),
        completed(1, { failed: 0, stillPending: 0 }),
      ],
      failedThreshold: 0,
      pendingThreshold: 25,
      consecutivePasses: 3,
    });
    // If the disable sentinel were not honoured, `>= 0` would match
    // every completed pass and trip failed_streak immediately.
    expect(breaches).toEqual([]);
  });

  it("evaluator: pendingThreshold=0 disables pending_streak even when failed_streak still trips", () => {
    const breaches = evaluateRoundWeatherBackfillBreaches({
      history: [
        completed(3, { failed: 5, stillPending: 0 }),
        completed(2, { failed: 5, stillPending: 0 }),
        completed(1, { failed: 5, stillPending: 0 }),
      ],
      failedThreshold: 1,
      pendingThreshold: 0,
      consecutivePasses: 3,
    });
    expect(breaches.map((b) => b.kind)).toEqual(["failed_streak"]);
  });

  it("evaluator: both disabled + completed-only history → no breach (errored_streak still works independently)", () => {
    const breachesQuiet = evaluateRoundWeatherBackfillBreaches({
      history: [
        completed(3, { failed: 0, stillPending: 0 }),
        completed(2, { failed: 9, stillPending: 9 }),
        completed(1, { failed: 9, stillPending: 9 }),
      ],
      failedThreshold: 0,
      pendingThreshold: 0,
      consecutivePasses: 3,
    });
    expect(breachesQuiet).toEqual([]);

    const breachesErrored = evaluateRoundWeatherBackfillBreaches({
      history: [errored(3, "boom"), errored(2, "boom"), errored(1, "boom")],
      failedThreshold: 0,
      pendingThreshold: 0,
      consecutivePasses: 3,
    });
    expect(breachesErrored.map((b) => b.kind)).toEqual(["errored_streak"]);
  });

  it("env: OPS_WEATHER_BACKFILL_FAILED_THRESHOLD=0 disables the failed-streak gate end-to-end", async () => {
    process.env.OPS_WEATHER_BACKFILL_FAILED_THRESHOLD = "0";
    const res = await runRoundWeatherBackfillOpsAlertJob({
      historyOverride: [
        completed(3, { failed: 0, stillPending: 0 }),
        completed(2, { failed: 0, stillPending: 0 }),
        completed(1, { failed: 0, stillPending: 0 }),
      ],
      recipients: ["ops@example.com"],
      pushUserIds: [],
    });
    expect(res.failedThreshold).toBe(0);
    expect(res.alerted).toBe(false);
    expect(res.reason).toBe("no_breach");
    expect(emailMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
