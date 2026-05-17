/**
 * Tests for Task #1478 — auto-page on-call when the badge-share rollup
 * cron stops firing.
 *
 * Covers:
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
  sendBadgeShareRollupStaleOpsAlertEmail: vi.fn(async () => undefined),
}));

import { db } from "@workspace/db";
import { appUsersTable, badgeShareRollupOpsAlertsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

import {
  runBadgeShareRollupStaleOpsAlertJob,
  loadLastBadgeShareRollupOpsAlertAt,
  _resetBadgeShareRollupStaleOpsAlertDedupForTest,
} from "../lib/badgeShareRollupOpsAlert.js";
import { sendBadgeShareRollupStaleOpsAlertEmail } from "../lib/mailer.js";
import {
  STALE_RUN_WARNING_MS,
  ROLLUP_AGE_MS,
  type BadgeShareRollupAdminSummary,
} from "../lib/badgeShareRollup.js";

const emailMock = vi.mocked(sendBadgeShareRollupStaleOpsAlertEmail);

let testSuperAdminId: number | null = null;
let testSuperAdminEmail: string | null = null;

function makeSummary(overrides: Partial<BadgeShareRollupAdminSummary> = {}): BadgeShareRollupAdminSummary {
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
    // Task #1821 — sparkline history defaults to empty for the
    // ops-alert tests; the alert job doesn't read these fields, so
    // the empty fixture keeps the existing assertions intact.
    history: [],
    historyDays: 7,
    isStale: false,
    staleThresholdMs: STALE_RUN_WARNING_MS,
    rollupAgeMs: ROLLUP_AGE_MS,
    // Task #1814 — auto-pager state surfaced for the super-admin
    // panel. Defaults to "never paged" so existing test cases (which
    // override only the rollup-status fields) keep their previous
    // semantics; the persisted-cooldown tests below pre-seed the
    // singleton row directly to exercise the gate.
    lastOpsAlertAt: null,
    opsAlertCooldownMs: 6 * 60 * 60 * 1000,
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  testSuperAdminEmail = `bsroll_admin_${stamp}@example.com`;
  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `bsroll-admin-${stamp}`,
    username: `bsroll_admin_${stamp}`,
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
  await _resetBadgeShareRollupStaleOpsAlertDedupForTest();
});

afterEach(() => {
  delete process.env.OPS_ALERT_EMAILS;
});

describe("runBadgeShareRollupStaleOpsAlertJob — no breach", () => {
  it("does not page when the rollup summary is not stale", async () => {
    const res = await runBadgeShareRollupStaleOpsAlertJob({
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
    const res = await runBadgeShareRollupStaleOpsAlertJob({
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

describe("runBadgeShareRollupStaleOpsAlertJob — stale + raw events present", () => {
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

    const res = await runBadgeShareRollupStaleOpsAlertJob({
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
    expect(firstCall.dashboardUrl).toMatch(/\/super-admin\/badge-share-rollup$/);
    expect(firstCall.summary.currentRawEventCount).toBe(12345);
    expect(firstCall.cooldownHours).toBe(6);
  });

  it("uses the explicit recipients override (no super-admin / env lookup)", async () => {
    const res = await runBadgeShareRollupStaleOpsAlertJob({
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

describe("runBadgeShareRollupStaleOpsAlertJob — cooldown", () => {
  it("suppresses a second page within the cooldown window; force overrides", async () => {
    const summary = makeSummary({
      isStale: true,
      currentRawEventCount: 100,
    });
    const t0 = new Date("2026-04-24T09:00:00Z");

    const first = await runBadgeShareRollupStaleOpsAlertJob({
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary,
      now: t0,
    });
    expect(first.alerted).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(1);

    // 1h later — still in cooldown, no email.
    const second = await runBadgeShareRollupStaleOpsAlertJob({
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary,
      now: new Date(t0.getTime() + 60 * 60 * 1000),
    });
    expect(second.alerted).toBe(false);
    expect(second.reason).toBe("in_cooldown");
    expect(emailMock).toHaveBeenCalledTimes(1);

    // Force override re-pages even inside the cooldown.
    const forced = await runBadgeShareRollupStaleOpsAlertJob({
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
    const fourth = await runBadgeShareRollupStaleOpsAlertJob({
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary,
      now: new Date(t0.getTime() + 9 * 60 * 60 * 1000),
    });
    expect(fourth.alerted).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(3);
  });
});

describe("runBadgeShareRollupStaleOpsAlertJob — no recipients", () => {
  it("returns no_recipients without throwing when neither super-admins (filtered out) nor OPS_ALERT_EMAILS provide an address", async () => {
    const res = await runBadgeShareRollupStaleOpsAlertJob({
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

// Task #1814 — The cooldown timestamp is now persisted to the
// `badge_share_rollup_ops_alerts` singleton table so the gate survives
// a process restart inside the cooldown window. Previously the
// in-process variable was lost on restart and on-call could be
// re-paged on a deploy mid-incident.
describe("runBadgeShareRollupStaleOpsAlertJob — persisted cooldown (Task #1814)", () => {
  it("UPSERTs the singleton row after a successful page", async () => {
    const t0 = new Date("2026-04-24T09:00:00Z");
    const res = await runBadgeShareRollupStaleOpsAlertJob({
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary: makeSummary({ isStale: true, currentRawEventCount: 7 }),
      now: t0,
    });
    expect(res.alerted).toBe(true);

    const persisted = await loadLastBadgeShareRollupOpsAlertAt();
    expect(persisted).not.toBeNull();
    expect(persisted!.getTime()).toBe(t0.getTime());
  });

  it("does not UPSERT the row when no email is sent", async () => {
    const res = await runBadgeShareRollupStaleOpsAlertJob({
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary: makeSummary({ isStale: false, currentRawEventCount: 999 }),
    });
    expect(res.alerted).toBe(false);

    const rows = await db.select().from(badgeShareRollupOpsAlertsTable);
    expect(rows).toHaveLength(0);
  });

  it("honours the persisted cooldown across simulated process restarts", async () => {
    // Pre-seed the table with a recent page (as if a previous process
    // instance had paged 1h ago) without going through the alert job.
    const tPaged = new Date("2026-04-24T09:00:00Z");
    await db.insert(badgeShareRollupOpsAlertsTable).values({
      id: 1,
      lastAlertedAt: tPaged,
    });

    // 1h after the persisted page, on a fresh process (no in-process
    // state to seed) — the job must still see the cooldown.
    const res = await runBadgeShareRollupStaleOpsAlertJob({
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary: makeSummary({ isStale: true, currentRawEventCount: 50 }),
      now: new Date(tPaged.getTime() + 60 * 60 * 1000),
    });
    expect(res.alerted).toBe(false);
    expect(res.reason).toBe("in_cooldown");
    expect(emailMock).not.toHaveBeenCalled();

    // 7h after the persisted page — outside the 6h window, page again.
    const res2 = await runBadgeShareRollupStaleOpsAlertJob({
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary: makeSummary({ isStale: true, currentRawEventCount: 50 }),
      now: new Date(tPaged.getTime() + 7 * 60 * 60 * 1000),
    });
    expect(res2.alerted).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(1);
  });
});
