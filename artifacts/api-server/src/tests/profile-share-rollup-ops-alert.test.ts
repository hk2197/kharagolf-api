/**
 * Tests for Task #1813 — auto-page on-call when the profile-share rollup
 * cron stops firing.
 *
 * Mirrors `badge-share-rollup-ops-alert.test.ts` (Task #1478). Covers:
 *   - Healthy summary (not stale) → no email sent.
 *   - Stale but raw events table empty → no email sent (fresh / quiet
 *     systems must not page on-call).
 *   - Stale + raw events present → emails super-admins + on-call once.
 *   - Cooldown suppresses repeat pages within the cooldown window;
 *     `force` overrides.
 *   - No recipients (no super_admin email AND OPS_ALERT_EMAILS unset)
 *     returns `no_recipients` instead of throwing.
 *   - Reads recipient list from DB super_admins + OPS_ALERT_EMAILS env
 *     when no explicit recipients are passed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => ({
  sendProfileShareRollupStaleOpsAlertEmail: vi.fn(async () => undefined),
}));

import { db } from "@workspace/db";
import { appUsersTable, profileShareRollupOpsAlertsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

import {
  runProfileShareRollupStaleOpsAlertJob,
  _resetProfileShareRollupStaleOpsAlertDedupForTest,
} from "../lib/profileShareRollupOpsAlert.js";
import { sendProfileShareRollupStaleOpsAlertEmail } from "../lib/mailer.js";
import {
  STALE_RUN_WARNING_MS,
  ROLLUP_AGE_MS,
  type ProfileShareRollupAdminSummary,
} from "../lib/profileShareRollup.js";

const emailMock = vi.mocked(sendProfileShareRollupStaleOpsAlertEmail);

let testSuperAdminId: number | null = null;
let testSuperAdminEmail: string | null = null;

function makeSummary(overrides: Partial<ProfileShareRollupAdminSummary> = {}): ProfileShareRollupAdminSummary {
  return {
    lastRun: {
      ranAt: new Date("2026-04-20T00:00:00Z").toISOString(),
      rolledUpEvents: 100,
      upsertedAggregateRows: 10,
      prunedAggregateRows: 0,
    },
    currentRawEventCount: 0,
    currentAggregateRowCount: 0,
    storageSavings: {
      aggregatedEventCount: 0,
      estimatedRowsSaved: 0,
      estimatedBytesSaved: 0,
      estimatedBytesPerRawRow: 0,
      savingsPercent: null,
      savingsRatio: null,
    },
    isStale: false,
    staleThresholdMs: STALE_RUN_WARNING_MS,
    rollupAgeMs: ROLLUP_AGE_MS,
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  testSuperAdminEmail = `psroll_admin_${stamp}@example.com`;
  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `psroll-admin-${stamp}`,
    username: `psroll_admin_${stamp}`,
    email: testSuperAdminEmail,
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  testSuperAdminId = admin.id;
});

afterAll(async () => {
  if (testSuperAdminId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, testSuperAdminId));
  }
});

beforeEach(async () => {
  emailMock.mockReset();
  emailMock.mockResolvedValue(undefined);
  // Task #2261 — cooldown gate is now backed by the
  // `profile_share_rollup_ops_alerts` audit table, so resetting
  // between tests must clear the table (and is now async).
  await _resetProfileShareRollupStaleOpsAlertDedupForTest();
});

afterAll(async () => {
  await db.delete(profileShareRollupOpsAlertsTable);
});

afterEach(() => {
  delete process.env.OPS_ALERT_EMAILS;
});

describe("runProfileShareRollupStaleOpsAlertJob — no breach", () => {
  it("does not page when the rollup summary is not stale", async () => {
    const res = await runProfileShareRollupStaleOpsAlertJob({
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary: makeSummary({
        isStale: false,
        currentRawEventCount: 5000, // raw events but recent run → fine
      }),
    });
    expect(res.alerted).toBe(false);
    expect(res.reason).toBe("not_stale");
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("does not page when the rollup is stale but the raw events table is empty", async () => {
    const res = await runProfileShareRollupStaleOpsAlertJob({
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary: makeSummary({
        isStale: true,
        currentRawEventCount: 0, // nothing waiting → quiet system
        lastRun: null,
      }),
    });
    expect(res.alerted).toBe(false);
    expect(res.reason).toBe("no_raw_events");
    expect(emailMock).not.toHaveBeenCalled();
  });
});

describe("runProfileShareRollupStaleOpsAlertJob — stale + raw events present", () => {
  it("emails super-admins + on-call list (deduped) when stale and raw events are waiting", async () => {
    process.env.OPS_ALERT_EMAILS = `oncall@example.com, ops@example.com, ${testSuperAdminEmail!.toUpperCase()}`;
    const summary = makeSummary({
      isStale: true,
      currentRawEventCount: 12345,
      currentAggregateRowCount: 678,
      lastRun: {
        ranAt: new Date("2026-04-25T08:00:00Z").toISOString(),
        rolledUpEvents: 9999,
        upsertedAggregateRows: 100,
        prunedAggregateRows: 5,
      },
    });

    const res = await runProfileShareRollupStaleOpsAlertJob({
      cooldownHours: 6,
      summary,
      now: new Date("2026-04-29T12:00:00Z"),
    });

    expect(res.alerted).toBe(true);
    // Test super-admin (loaded from DB) + 2 on-call addresses, with the
    // env's UPPERCASE duplicate of the super-admin email collapsed.
    expect(res.recipientsAttempted).toBe(3);
    expect(res.recipientsEmailed).toBe(3);
    expect(emailMock).toHaveBeenCalledTimes(3);
    const firstCall = emailMock.mock.calls[0][0];
    expect(firstCall.dashboardUrl).toMatch(/\/super-admin\/profile-share-rollup$/);
    expect(firstCall.summary.currentRawEventCount).toBe(12345);
    expect(firstCall.cooldownHours).toBe(6);
  });

  it("uses the explicit recipients override (no super-admin / env lookup)", async () => {
    const res = await runProfileShareRollupStaleOpsAlertJob({
      cooldownHours: 6,
      recipients: ["only@example.com", "Only@Example.com"], // dedup test
      summary: makeSummary({
        isStale: true,
        currentRawEventCount: 1,
      }),
    });
    expect(res.alerted).toBe(true);
    expect(res.recipientsEmailed).toBe(1);
    expect(emailMock).toHaveBeenCalledTimes(1);
  });
});

describe("runProfileShareRollupStaleOpsAlertJob — cooldown", () => {
  it("suppresses a second page within the cooldown window; force overrides", async () => {
    const summary = makeSummary({
      isStale: true,
      currentRawEventCount: 100,
    });
    const t0 = new Date("2026-04-24T09:00:00Z");

    const first = await runProfileShareRollupStaleOpsAlertJob({
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary,
      now: t0,
    });
    expect(first.alerted).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(1);

    // 1h later — still in cooldown, no email.
    const second = await runProfileShareRollupStaleOpsAlertJob({
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary,
      now: new Date(t0.getTime() + 60 * 60 * 1000),
    });
    expect(second.alerted).toBe(false);
    expect(second.reason).toBe("in_cooldown");
    expect(emailMock).toHaveBeenCalledTimes(1);

    // Force override re-pages even inside the cooldown.
    const forced = await runProfileShareRollupStaleOpsAlertJob({
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary,
      now: new Date(t0.getTime() + 2 * 60 * 60 * 1000),
      force: true,
    });
    expect(forced.alerted).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(2);

    // The forced page reset `lastAlertedAtMs` to t0+2h, so the next
    // natural re-page must be at least 6h after that (t0+8h).
    const fourth = await runProfileShareRollupStaleOpsAlertJob({
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary,
      now: new Date(t0.getTime() + 9 * 60 * 60 * 1000),
    });
    expect(fourth.alerted).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(3);
  });
});

describe("runProfileShareRollupStaleOpsAlertJob — no recipients", () => {
  it("returns no_recipients without throwing when neither super-admins (filtered out) nor OPS_ALERT_EMAILS provide an address", async () => {
    const res = await runProfileShareRollupStaleOpsAlertJob({
      cooldownHours: 6,
      recipients: [], // explicitly bypass DB / env lookup
      summary: makeSummary({
        isStale: true,
        currentRawEventCount: 1,
      }),
    });
    expect(res.alerted).toBe(false);
    expect(res.reason).toBe("no_recipients");
    expect(emailMock).not.toHaveBeenCalled();
  });
});
