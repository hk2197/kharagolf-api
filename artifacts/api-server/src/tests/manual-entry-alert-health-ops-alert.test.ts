/**
 * Tests for Task #1387 — auto-page on-call when manual-entry alerts stop
 * reaching anyone.
 *
 * Covers:
 *   - No breach (healthy 7d window) → no email sent.
 *   - Delivery-rate breach → email sent to super-admins + on-call once.
 *   - Consecutive-zero breach → email sent even when 7d rate is healthy.
 *   - Min-sample gate suppresses noisy alerts on quiet windows.
 *   - Cooldown suppresses repeat pages within the cooldown window;
 *     `force` overrides.
 *   - No recipients (no super_admin email AND OPS_ALERT_EMAILS unset)
 *     returns `no_recipients` instead of throwing.
 *   - Pure helper `evaluateManualEntryAlertHealthBreaches` behaves as
 *     expected for representative inputs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => ({
  sendManualEntryAlertHealthOpsAlertEmail: vi.fn(async () => undefined),
}));

import { db } from "@workspace/db";
import {
  manualEntryAlertsTable,
  manualEntryAlertPageHistoryTable,
  appUsersTable,
  organizationsTable,
  tournamentsTable,
  playersTable,
  roundSubmissionsTable,
  opsAlertSettingsTable,
  opsAlertSettingsHistoryTable,
} from "@workspace/db";
import { desc, eq, gte, inArray } from "drizzle-orm";

import {
  runManualEntryAlertHealthOpsAlertJob,
  evaluateManualEntryAlertHealthBreaches,
  getManualEntryAlertHealthCooldownStatus,
  sendManualEntryAlertHealthOpsAlertTestPage,
  _resetManualEntryAlertHealthOpsAlertDedupForTest,
} from "../lib/manualEntryAlertHealthOpsAlert.js";
import { sendManualEntryAlertHealthOpsAlertEmail } from "../lib/mailer.js";
import type { ManualEntryAlertHealthSummary } from "../lib/manualEntryAlertHealth.js";
import { _resetOpsAlertSettingsCacheForTest } from "../lib/opsAlertSettings.js";

const emailMock = vi.mocked(sendManualEntryAlertHealthOpsAlertEmail);

let testOrgId: number;
let testTournamentId: number;
let testPlayerId: number;
let testSubmissionId: number;
let testSuperAdminId: number;
const insertedAlertIds: number[] = [];

function makeSummary(window: Partial<ManualEntryAlertHealthSummary["windows"]["7d"]>): ManualEntryAlertHealthSummary {
  const empty = {
    alertCount: 0,
    recipientTotal: 0,
    pushAttemptedTotal: 0,
    pushSentTotal: 0,
    emailAttemptedTotal: 0,
    emailSentTotal: 0,
    pushDeliveryRate: 0,
    emailDeliveryRate: 0,
    anyDeliveryRate: 0,
    zeroDeliveryCount: 0,
    silentRecipientTotal: 0,
  };
  return {
    windows: {
      "7d": { ...empty, ...window },
      "30d": { ...empty },
    },
    topTournaments7d: [],
    topZeroDeliveryTournaments30d: [],
    topPlayers30d: [],
    topSilentRecipientOrgs30d: [],
    skipReasonBreakdown: {
      "7d": { totalCount: 0, buckets: [] },
      "30d": { totalCount: 0, buckets: [] },
    },
    skipReasonDailySeries: {
      sinceDays: 30,
      since: new Date().toISOString(),
      days: [],
      series: [],
      totalCount: 0,
    },
    generatedAt: new Date().toISOString(),
  };
}

async function insertAlert(opts: {
  pushSent: number;
  emailSent: number;
  recipientCount?: number;
  sentAt?: Date;
}) {
  const [row] = await db.insert(manualEntryAlertsTable).values({
    submissionId: testSubmissionId,
    tournamentId: testTournamentId,
    playerId: testPlayerId,
    round: 1,
    manualPct: "100.00",
    manualShots: 18,
    totalShots: 18,
    recipientCount: opts.recipientCount ?? 1,
    pushAttempted: opts.pushSent > 0 ? opts.pushSent : 1,
    pushSent: opts.pushSent,
    emailAttempted: opts.emailSent > 0 ? opts.emailSent : 1,
    emailSent: opts.emailSent,
    sentAt: opts.sentAt,
  }).returning({ id: manualEntryAlertsTable.id });
  insertedAlertIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `MEAlertHealthOrg_${stamp}`,
    slug: `me-alert-health-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [t] = await db.insert(tournamentsTable).values({
    organizationId: testOrgId,
    name: `MEAlertHealth_${stamp}`,
    startDate: new Date(),
  }).returning({ id: tournamentsTable.id });
  testTournamentId = t.id;

  const [p] = await db.insert(playersTable).values({
    tournamentId: testTournamentId,
    firstName: "ME",
    lastName: `Alert_${stamp}`,
  }).returning({ id: playersTable.id });
  testPlayerId = p.id;

  const [sub] = await db.insert(roundSubmissionsTable).values({
    tournamentId: testTournamentId,
    playerId: testPlayerId,
    round: 1,
    status: "submitted",
  }).returning({ id: roundSubmissionsTable.id });
  testSubmissionId = sub.id;

  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `me-alert-health-admin-${stamp}`,
    username: `me_alert_admin_${stamp}`,
    email: `admin_${stamp}@example.com`,
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  testSuperAdminId = admin.id;
});

afterAll(async () => {
  if (insertedAlertIds.length > 0) {
    await db.delete(manualEntryAlertsTable)
      .where(inArray(manualEntryAlertsTable.id, insertedAlertIds));
  }
  if (testSubmissionId) {
    await db.delete(roundSubmissionsTable).where(eq(roundSubmissionsTable.id, testSubmissionId));
  }
  if (testPlayerId) {
    await db.delete(playersTable).where(eq(playersTable.id, testPlayerId));
  }
  if (testTournamentId) {
    await db.delete(tournamentsTable).where(eq(tournamentsTable.id, testTournamentId));
  }
  if (testSuperAdminId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, testSuperAdminId));
  }
  if (testOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  }
});

// Snapshot of the highest-ID page-history row that existed BEFORE this
// run started. Lets us isolate "rows this test inserted" from "rows
// pre-existing in the local DB" without scrubbing global history.
let pageHistoryWatermarkId = 0;

beforeEach(async () => {
  emailMock.mockReset();
  emailMock.mockResolvedValue(undefined);
  _resetManualEntryAlertHealthOpsAlertDedupForTest();
  // Task #1664 — the cron now resolves tunables via the DB-backed
  // singleton (with env / default fallback). All existing tests pass
  // explicit `opts.*` overrides so the resolved value is ignored, but
  // we still reset the in-process cache + clear any singleton override
  // so the new DB-backed test below starts from a known baseline (and
  // a stale row from a prior `updateOpsAlertSettings` test doesn't
  // leak into the env-fallback tests).
  _resetOpsAlertSettingsCacheForTest();
  await db.delete(opsAlertSettingsHistoryTable);
  await db
    .update(opsAlertSettingsTable)
    .set({
      notifyExhaustionThreshold: null,
      notifyExhaustionWindowHours: null,
      manualEntryRateThresholdPct: null,
      manualEntryMinSample: null,
      manualEntryConsecutiveZero: null,
      manualEntryCooldownHours: null,
      // Task #2081 — three additional manual-entry tunables. Reset
      // alongside the four legacy ones so each test starts from the
      // documented "everything inherits from env / default" baseline.
      manualEntryLookbackHours: null,
      manualEntryDryRun: null,
      manualEntryRecipientLookupLimit: null,
      updatedByUserId: null,
    })
    .where(eq(opsAlertSettingsTable.id, 1));
  // Wipe per-test alerts so consecutive-zero detection starts from a
  // clean slate every test.
  if (insertedAlertIds.length > 0) {
    await db.delete(manualEntryAlertsTable)
      .where(inArray(manualEntryAlertsTable.id, insertedAlertIds.splice(0)));
  }
  const [latest] = await db
    .select({ id: manualEntryAlertPageHistoryTable.id })
    .from(manualEntryAlertPageHistoryTable)
    .orderBy(desc(manualEntryAlertPageHistoryTable.id))
    .limit(1);
  pageHistoryWatermarkId = latest?.id ?? 0;
});

async function fetchPageHistorySinceWatermark() {
  return db
    .select()
    .from(manualEntryAlertPageHistoryTable)
    .where(gte(manualEntryAlertPageHistoryTable.id, pageHistoryWatermarkId + 1))
    .orderBy(desc(manualEntryAlertPageHistoryTable.id));
}

afterEach(() => {
  delete process.env.OPS_ALERT_EMAILS;
});

describe("evaluateManualEntryAlertHealthBreaches (pure helper)", () => {
  it("flags delivery-rate breach when sample is large enough and rate is below threshold", () => {
    const breaches = evaluateManualEntryAlertHealthBreaches({
      summary: {
        alertCount: 10,
        recipientTotal: 10,
        pushAttemptedTotal: 10,
        pushSentTotal: 5,
        emailAttemptedTotal: 10,
        emailSentTotal: 5,
        pushDeliveryRate: 50,
        emailDeliveryRate: 50,
        anyDeliveryRate: 60,
        zeroDeliveryCount: 4,
        silentRecipientTotal: 4,
      },
      thresholdPct: 80,
      minSample: 3,
      consecutiveZero: 5,
      lastNStats: { total: 0, zero: 0, allZero: false },
      // Task #2066 — pure-helper callers must opt in to the
      // muted-skip pile-up rule by passing both the threshold and
      // the per-org rollup; passing an empty list keeps the
      // pre-#2066 behavior verbatim.
      mutedPileUpThreshold: 10,
      mutedPileUpOrgs: [],
    });
    expect(breaches.map((b) => b.kind)).toEqual(["delivery_rate"]);
  });

  it("does not flag delivery-rate when sample is below the minimum", () => {
    const breaches = evaluateManualEntryAlertHealthBreaches({
      summary: {
        alertCount: 2,
        recipientTotal: 2,
        pushAttemptedTotal: 2,
        pushSentTotal: 0,
        emailAttemptedTotal: 2,
        emailSentTotal: 0,
        pushDeliveryRate: 0,
        emailDeliveryRate: 0,
        anyDeliveryRate: 0,
        zeroDeliveryCount: 2,
        silentRecipientTotal: 2,
      },
      thresholdPct: 80,
      minSample: 3,
      consecutiveZero: 5,
      lastNStats: { total: 0, zero: 0, allZero: false },
      mutedPileUpThreshold: 10,
      mutedPileUpOrgs: [],
    });
    expect(breaches).toEqual([]);
  });

  it("flags consecutive-zero breach independent of the rate", () => {
    const breaches = evaluateManualEntryAlertHealthBreaches({
      summary: {
        alertCount: 100,
        recipientTotal: 100,
        pushAttemptedTotal: 100,
        pushSentTotal: 95,
        emailAttemptedTotal: 100,
        emailSentTotal: 95,
        pushDeliveryRate: 95,
        emailDeliveryRate: 95,
        anyDeliveryRate: 99,
        zeroDeliveryCount: 1,
        silentRecipientTotal: 1,
      },
      thresholdPct: 80,
      minSample: 3,
      consecutiveZero: 5,
      lastNStats: { total: 5, zero: 5, allZero: true },
      mutedPileUpThreshold: 10,
      mutedPileUpOrgs: [],
    });
    expect(breaches.map((b) => b.kind)).toEqual(["consecutive_zero"]);
  });

  it("returns no breach when both signals are healthy", () => {
    const breaches = evaluateManualEntryAlertHealthBreaches({
      summary: {
        alertCount: 50,
        recipientTotal: 50,
        pushAttemptedTotal: 50,
        pushSentTotal: 49,
        emailAttemptedTotal: 50,
        emailSentTotal: 49,
        pushDeliveryRate: 98,
        emailDeliveryRate: 98,
        anyDeliveryRate: 100,
        zeroDeliveryCount: 0,
        silentRecipientTotal: 0,
      },
      thresholdPct: 80,
      minSample: 3,
      consecutiveZero: 5,
      lastNStats: { total: 5, zero: 0, allZero: false },
      mutedPileUpThreshold: 10,
      mutedPileUpOrgs: [],
    });
    expect(breaches).toEqual([]);
  });

  // Task #2066 — auto-page when an org is left silently muted with
  // `org_muted` / `tournament_muted` skips piling up. The helper
  // emits a `muted_pile_up` breach per qualifying org so the email
  // can render the offending list. The DB-fetch for the rollup is
  // covered by the runner tests below; these are pure-input cases.
  it("flags muted_pile_up breach per offending org", () => {
    const breaches = evaluateManualEntryAlertHealthBreaches({
      summary: {
        alertCount: 100,
        recipientTotal: 100,
        pushAttemptedTotal: 100,
        pushSentTotal: 99,
        emailAttemptedTotal: 100,
        emailSentTotal: 99,
        pushDeliveryRate: 99,
        emailDeliveryRate: 99,
        anyDeliveryRate: 100,
        zeroDeliveryCount: 0,
        silentRecipientTotal: 0,
      },
      thresholdPct: 80,
      minSample: 3,
      consecutiveZero: 5,
      lastNStats: { total: 5, zero: 0, allZero: false },
      mutedPileUpThreshold: 10,
      mutedPileUpOrgs: [
        {
          organizationId: 42,
          organizationName: "Stuck Org",
          totalCount: 12,
          orgMutedCount: 8,
          tournamentMutedCount: 4,
          tournaments: [
            {
              tournamentId: 7,
              tournamentName: "Spring Open",
              count: 12,
              orgMutedCount: 8,
              tournamentMutedCount: 4,
            },
          ],
        },
      ],
    });
    // The rule only fires the muted-pile-up kind — delivery rate /
    // consecutive zero are healthy in this fixture.
    expect(breaches.map((b) => b.kind)).toEqual(["muted_pile_up"]);
    // Sanity-check the headline detail surfaces blast radius (org
    // count + total rows) so on-call sees scale before drilling into
    // the per-org list rendered in the email body.
    expect(breaches[0]?.detail).toMatch(/1 org/);
    expect(breaches[0]?.detail).toMatch(/12 total/);
    expect(breaches[0]?.detail).toMatch(/>= 10/);
  });

  it("does not flag muted_pile_up when the per-org rollup is empty", () => {
    // Empty `mutedPileUpOrgs` is the steady state — the SQL helper
    // already filters by `>= threshold` so an empty list means no org
    // qualified. The evaluator must not synthesize a breach in that
    // case even when the threshold is set.
    const breaches = evaluateManualEntryAlertHealthBreaches({
      summary: {
        alertCount: 50,
        recipientTotal: 50,
        pushAttemptedTotal: 50,
        pushSentTotal: 49,
        emailAttemptedTotal: 50,
        emailSentTotal: 49,
        pushDeliveryRate: 98,
        emailDeliveryRate: 98,
        anyDeliveryRate: 100,
        zeroDeliveryCount: 0,
        silentRecipientTotal: 0,
      },
      thresholdPct: 80,
      minSample: 3,
      consecutiveZero: 5,
      lastNStats: { total: 5, zero: 0, allZero: false },
      mutedPileUpThreshold: 10,
      mutedPileUpOrgs: [],
    });
    expect(breaches).toEqual([]);
  });
});

describe("runManualEntryAlertHealthOpsAlertJob — no breach", () => {
  it("does not page when 7d delivery rate is above the threshold and no consecutive zeros", async () => {
    // Insert 5 healthy alerts so the consecutive-zero check sees them.
    for (let i = 0; i < 5; i++) {
      await insertAlert({ pushSent: 1, emailSent: 1 });
    }
    const summary = makeSummary({
      alertCount: 10,
      anyDeliveryRate: 95,
      pushDeliveryRate: 95,
      emailDeliveryRate: 90,
      zeroDeliveryCount: 0,
    });

    const res = await runManualEntryAlertHealthOpsAlertJob({
      thresholdPct: 80,
      minSample: 3,
      consecutiveZero: 5,
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary,
    });

    expect(res.alerted).toBe(false);
    expect(res.reason).toBe("no_breach");
    expect(res.breaches).toEqual([]);
    expect(emailMock).not.toHaveBeenCalled();
  });
});

describe("runManualEntryAlertHealthOpsAlertJob — delivery-rate breach", () => {
  it("emails super-admins + on-call list (deduped) when the 7d any-delivery rate falls below threshold", async () => {
    process.env.OPS_ALERT_EMAILS = "oncall@example.com, ops@example.com";
    // Insert healthy alerts so consecutive-zero is NOT a confounding trigger.
    for (let i = 0; i < 5; i++) {
      await insertAlert({ pushSent: 1, emailSent: 1 });
    }
    const summary = makeSummary({
      alertCount: 20,
      anyDeliveryRate: 50,
      pushDeliveryRate: 30,
      emailDeliveryRate: 40,
      zeroDeliveryCount: 10,
      silentRecipientTotal: 18,
    });

    const res = await runManualEntryAlertHealthOpsAlertJob({
      thresholdPct: 80,
      minSample: 3,
      consecutiveZero: 5,
      cooldownHours: 6,
      summary,
    });

    expect(res.alerted).toBe(true);
    expect(res.breaches.map((b) => b.kind)).toContain("delivery_rate");
    // 1 super-admin (testSuperAdminId) + 2 on-call addresses, all distinct.
    expect(res.recipientsAttempted).toBe(3);
    expect(res.recipientsEmailed).toBe(3);
    expect(emailMock).toHaveBeenCalledTimes(3);
    const firstCall = emailMock.mock.calls[0][0];
    expect(firstCall.dashboardUrl).toMatch(/\/super-admin\/manual-entry-alerts$/);
    expect(firstCall.summary7d.anyDeliveryRate).toBe(50);
    expect(firstCall.thresholdPct).toBe(80);
  });

  it("uses the explicit recipients override (no super-admin / env lookup)", async () => {
    for (let i = 0; i < 5; i++) {
      await insertAlert({ pushSent: 1, emailSent: 1 });
    }
    const summary = makeSummary({
      alertCount: 10,
      anyDeliveryRate: 0,
      zeroDeliveryCount: 10,
    });
    const res = await runManualEntryAlertHealthOpsAlertJob({
      thresholdPct: 80,
      minSample: 3,
      consecutiveZero: 5,
      cooldownHours: 6,
      recipients: ["only@example.com", "only@example.com"], // dedup test
      summary,
    });
    expect(res.alerted).toBe(true);
    expect(res.recipientsEmailed).toBe(1);
    expect(emailMock).toHaveBeenCalledTimes(1);
  });
});

describe("runManualEntryAlertHealthOpsAlertJob — muted_pile_up breach", () => {
  it("pages with the offending org list when an org's muted-skip count crosses the threshold", async () => {
    // Healthy delivery + healthy consecutive history so the muted
    // pile-up rule is the *only* trigger — proves the new code path
    // can fire stand-alone, not just folded into another breach.
    for (let i = 0; i < 5; i++) {
      await insertAlert({ pushSent: 1, emailSent: 1 });
    }
    const summary = makeSummary({
      alertCount: 100,
      anyDeliveryRate: 99,
      pushDeliveryRate: 99,
      emailDeliveryRate: 99,
      zeroDeliveryCount: 0,
    });

    const res = await runManualEntryAlertHealthOpsAlertJob({
      thresholdPct: 80,
      minSample: 3,
      consecutiveZero: 5,
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary,
      // Override the DB rollup so this test stays self-contained — the
      // SQL helper itself is exercised by the skip-breakdown tests.
      mutedPileUpThreshold: 10,
      mutedPileUpOrgs: [
        {
          organizationId: 99,
          organizationName: "Silent Org",
          totalCount: 14,
          orgMutedCount: 9,
          tournamentMutedCount: 5,
          tournaments: [
            {
              tournamentId: 11,
              tournamentName: "Stuck Tournament",
              count: 14,
              orgMutedCount: 9,
              tournamentMutedCount: 5,
            },
          ],
        },
      ],
    });

    expect(res.alerted).toBe(true);
    expect(res.breaches.map((b) => b.kind)).toEqual(["muted_pile_up"]);
    expect(emailMock).toHaveBeenCalledTimes(1);
    const call = emailMock.mock.calls[0][0];
    // Email gets the threshold + the offending org list verbatim so
    // the recipient sees who to contact without opening the dashboard.
    expect(call.mutedPileUpThreshold).toBe(10);
    expect(call.mutedPileUpOrgs).toHaveLength(1);
    expect(call.mutedPileUpOrgs?.[0]?.organizationName).toBe("Silent Org");
    expect(call.mutedPileUpOrgs?.[0]?.totalCount).toBe(14);
    expect(call.breaches[0].kind).toBe("muted_pile_up");
  });

  it("does not page when the per-org rollup is empty (steady state)", async () => {
    for (let i = 0; i < 5; i++) {
      await insertAlert({ pushSent: 1, emailSent: 1 });
    }
    const summary = makeSummary({
      alertCount: 100,
      anyDeliveryRate: 99,
      pushDeliveryRate: 99,
      emailDeliveryRate: 99,
      zeroDeliveryCount: 0,
    });
    const res = await runManualEntryAlertHealthOpsAlertJob({
      thresholdPct: 80,
      minSample: 3,
      consecutiveZero: 5,
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary,
      mutedPileUpThreshold: 10,
      mutedPileUpOrgs: [],
    });
    expect(res.alerted).toBe(false);
    expect(res.reason).toBe("no_breach");
    expect(emailMock).not.toHaveBeenCalled();
  });
});

describe("runManualEntryAlertHealthOpsAlertJob — consecutive-zero breach", () => {
  it("pages when the last N alerts all reached zero recipients (even with a healthy 7d rate)", async () => {
    // Last 5 alerts all zero-delivery.
    for (let i = 0; i < 5; i++) {
      await insertAlert({ pushSent: 0, emailSent: 0 });
    }
    const summary = makeSummary({
      alertCount: 100,
      anyDeliveryRate: 99,
      pushDeliveryRate: 99,
      emailDeliveryRate: 99,
      zeroDeliveryCount: 1,
    });

    const res = await runManualEntryAlertHealthOpsAlertJob({
      thresholdPct: 80,
      minSample: 3,
      consecutiveZero: 5,
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary,
    });

    expect(res.alerted).toBe(true);
    expect(res.breaches.map((b) => b.kind)).toEqual(["consecutive_zero"]);
    expect(emailMock).toHaveBeenCalledTimes(1);
  });

  it("does not page when fewer than N alerts exist in total (cold start)", async () => {
    await insertAlert({ pushSent: 0, emailSent: 0 });
    await insertAlert({ pushSent: 0, emailSent: 0 });
    const summary = makeSummary({
      alertCount: 2,
      anyDeliveryRate: 0,
    });
    const res = await runManualEntryAlertHealthOpsAlertJob({
      thresholdPct: 80,
      minSample: 3,
      consecutiveZero: 5,
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary,
    });
    expect(res.alerted).toBe(false);
    expect(res.reason).toBe("no_breach");
    expect(emailMock).not.toHaveBeenCalled();
  });
});

describe("runManualEntryAlertHealthOpsAlertJob — cooldown", () => {
  it("suppresses a second page within the cooldown window; force overrides", async () => {
    for (let i = 0; i < 5; i++) {
      await insertAlert({ pushSent: 0, emailSent: 0 });
    }
    const summary = makeSummary({
      alertCount: 10,
      anyDeliveryRate: 0,
      zeroDeliveryCount: 10,
    });
    const t0 = new Date("2026-04-24T09:00:00Z");

    const first = await runManualEntryAlertHealthOpsAlertJob({
      thresholdPct: 80,
      minSample: 3,
      consecutiveZero: 5,
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary,
      now: t0,
    });
    expect(first.alerted).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(1);

    // 1h later — still in cooldown, no email.
    const second = await runManualEntryAlertHealthOpsAlertJob({
      thresholdPct: 80,
      minSample: 3,
      consecutiveZero: 5,
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary,
      now: new Date(t0.getTime() + 60 * 60 * 1000),
    });
    expect(second.alerted).toBe(false);
    expect(second.reason).toBe("in_cooldown");
    expect(emailMock).toHaveBeenCalledTimes(1);

    // Force override re-pages even inside the cooldown.
    const forced = await runManualEntryAlertHealthOpsAlertJob({
      thresholdPct: 80,
      minSample: 3,
      consecutiveZero: 5,
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
    const fourth = await runManualEntryAlertHealthOpsAlertJob({
      thresholdPct: 80,
      minSample: 3,
      consecutiveZero: 5,
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary,
      now: new Date(t0.getTime() + 9 * 60 * 60 * 1000),
    });
    expect(fourth.alerted).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(3);
  });
});

describe("runManualEntryAlertHealthOpsAlertJob — page history (Task #1665)", () => {
  it("inserts one page_history row per successful page (snapshot of when, breach kinds, recipients, summary)", async () => {
    for (let i = 0; i < 5; i++) {
      await insertAlert({ pushSent: 0, emailSent: 0 });
    }
    const summary = makeSummary({
      alertCount: 12,
      anyDeliveryRate: 25,
      pushDeliveryRate: 20,
      emailDeliveryRate: 30,
      zeroDeliveryCount: 9,
      silentRecipientTotal: 14,
    });
    const t0 = new Date("2026-04-25T08:00:00Z");

    const res = await runManualEntryAlertHealthOpsAlertJob({
      thresholdPct: 80,
      minSample: 3,
      consecutiveZero: 5,
      cooldownHours: 6,
      recipients: ["ops@example.com", "oncall@example.com"],
      summary,
      now: t0,
    });
    expect(res.alerted).toBe(true);
    expect(res.recipientsEmailed).toBe(2);

    const rows = await fetchPageHistorySinceWatermark();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.pagedAt.toISOString()).toBe(t0.toISOString());
    expect(new Set(row.breachKinds)).toEqual(
      new Set(["delivery_rate", "consecutive_zero"]),
    );
    expect(row.recipientCount).toBe(2);
    expect(new Set(row.recipientEmails)).toEqual(
      new Set(["ops@example.com", "oncall@example.com"]),
    );
    expect(Number(row.thresholdPct)).toBe(80);
    expect(Number(row.cooldownHours)).toBe(6);
    expect(row.alertCount7d).toBe(12);
    expect(Number(row.anyDeliveryRate7d)).toBe(25);
    expect(row.zeroDeliveryCount7d).toBe(9);
  });

  it("does not insert a row when the cooldown suppresses the page", async () => {
    for (let i = 0; i < 5; i++) {
      await insertAlert({ pushSent: 0, emailSent: 0 });
    }
    const summary = makeSummary({
      alertCount: 10,
      anyDeliveryRate: 0,
      zeroDeliveryCount: 10,
    });
    const t0 = new Date("2026-04-25T09:00:00Z");

    const first = await runManualEntryAlertHealthOpsAlertJob({
      thresholdPct: 80,
      minSample: 3,
      consecutiveZero: 5,
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary,
      now: t0,
    });
    expect(first.alerted).toBe(true);

    const suppressed = await runManualEntryAlertHealthOpsAlertJob({
      thresholdPct: 80,
      minSample: 3,
      consecutiveZero: 5,
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary,
      now: new Date(t0.getTime() + 60 * 60 * 1000),
    });
    expect(suppressed.alerted).toBe(false);
    expect(suppressed.reason).toBe("in_cooldown");

    const rows = await fetchPageHistorySinceWatermark();
    expect(rows).toHaveLength(1);
    expect(rows[0].pagedAt.toISOString()).toBe(t0.toISOString());
  });

  it("does not insert a row when a no-breach run skips paging entirely", async () => {
    for (let i = 0; i < 5; i++) {
      await insertAlert({ pushSent: 1, emailSent: 1 });
    }
    const summary = makeSummary({
      alertCount: 10,
      anyDeliveryRate: 99,
      pushDeliveryRate: 99,
      emailDeliveryRate: 99,
    });
    const res = await runManualEntryAlertHealthOpsAlertJob({
      thresholdPct: 80,
      minSample: 3,
      consecutiveZero: 5,
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary,
    });
    expect(res.alerted).toBe(false);
    const rows = await fetchPageHistorySinceWatermark();
    expect(rows).toHaveLength(0);
  });
});

// Task #2079 — `sendManualEntryAlertHealthOpsAlertTestPage` lets a
// super-admin verify the on-call email wiring on demand from the
// dashboard. These tests cover the success path (synthetic breaches +
// flagged page-history row), the no-recipients diagnostic, and the
// invariant that a test page does NOT trip the auto-page cooldown
// (since the cron's dedup key is breach-shape + recipients-based and
// the test path doesn't enter the cron's evaluate-and-page flow).
describe("sendManualEntryAlertHealthOpsAlertTestPage (Task #2079)", () => {
  it("emails every recipient, marks the email as a TEST, and writes an is_test=true page-history row", async () => {
    const t0 = new Date("2026-04-26T12:00:00Z");
    const res = await sendManualEntryAlertHealthOpsAlertTestPage({
      recipients: ["ops@example.com", "oncall@example.com"],
      now: t0,
    });
    expect(res.ok).toBe(true);
    expect(res.recipientsAttempted).toBe(2);
    expect(res.recipientsEmailed).toBe(2);
    expect(new Set(res.recipients)).toEqual(
      new Set(["ops@example.com", "oncall@example.com"]),
    );
    expect(res.breaches.length).toBeGreaterThan(0);
    expect(res.pageHistoryId).not.toBeNull();

    expect(emailMock).toHaveBeenCalledTimes(2);
    for (const call of emailMock.mock.calls) {
      // Every send goes out with isTest:true so the subject / banner /
      // body all read as a synthetic wiring check, not a real outage.
      expect(call[0].isTest).toBe(true);
    }

    const rows = await fetchPageHistorySinceWatermark();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.isTest).toBe(true);
    expect(row.pagedAt.toISOString()).toBe(t0.toISOString());
    expect(row.recipientCount).toBe(2);
    expect(new Set(row.recipientEmails)).toEqual(
      new Set(["ops@example.com", "oncall@example.com"]),
    );
    expect(row.breachKinds.length).toBeGreaterThan(0);
  });

  it("returns no_recipients (and writes no page-history row) when neither super_admins nor OPS_ALERT_EMAILS resolve", async () => {
    // Force an empty list — bypasses the super-admin / env lookup so
    // we don't have to scrub other super_admin rows out of the dev DB.
    const res = await sendManualEntryAlertHealthOpsAlertTestPage({
      recipients: [],
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no_recipients");
    expect(res.recipientsAttempted).toBe(0);
    expect(res.recipientsEmailed).toBe(0);
    expect(res.pageHistoryId).toBeNull();
    expect(emailMock).not.toHaveBeenCalled();

    const rows = await fetchPageHistorySinceWatermark();
    expect(rows).toHaveLength(0);
  });

  it("truncates the recipient list to manualEntryRecipientLookupLimit before sending (Task #2081)", async () => {
    // Stash a tighter DB-stored limit so the test page picks it up
    // through `resolveOpsAlertConfig`. The seven supplied recipients
    // should be truncated to the first three after dedup.
    _resetOpsAlertSettingsCacheForTest();
    await db
      .update(opsAlertSettingsTable)
      .set({ manualEntryRecipientLookupLimit: 3 })
      .where(eq(opsAlertSettingsTable.id, 1));

    const t0 = new Date("2026-04-26T14:00:00Z");
    const res = await sendManualEntryAlertHealthOpsAlertTestPage({
      recipients: [
        "a@example.com",
        "b@example.com",
        "c@example.com",
        "d@example.com",
        "e@example.com",
        "f@example.com",
        "g@example.com",
      ],
      now: t0,
    });
    expect(res.ok).toBe(true);
    expect(res.recipientsAttempted).toBe(3);
    expect(res.recipientsEmailed).toBe(3);
    expect(res.recipients).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
    expect(emailMock).toHaveBeenCalledTimes(3);

    // The page-history row also reflects the truncated audience so
    // the dashboard banner agrees with the cron's behaviour at the
    // same configuration.
    const rows = await fetchPageHistorySinceWatermark();
    expect(rows).toHaveLength(1);
    expect(rows[0].recipientCount).toBe(3);
    expect(rows[0].recipientEmails).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
  });

  it("does not consume the auto-page cooldown — a real breach right after a test page still pages on-call", async () => {
    // 1) Fire a test page first.
    const tTest = new Date("2026-04-26T13:00:00Z");
    const testRes = await sendManualEntryAlertHealthOpsAlertTestPage({
      recipients: ["ops@example.com"],
      now: tTest,
    });
    expect(testRes.ok).toBe(true);

    // 2) Immediately after, a real breach should still trigger a page
    //    (the test path must not have armed the cron's dedup window).
    for (let i = 0; i < 5; i++) {
      await insertAlert({ pushSent: 0, emailSent: 0 });
    }
    const summary = makeSummary({
      alertCount: 12,
      anyDeliveryRate: 10,
      zeroDeliveryCount: 11,
    });
    const tCron = new Date(tTest.getTime() + 60 * 1000); // 1 min later
    const cronRes = await runManualEntryAlertHealthOpsAlertJob({
      thresholdPct: 80,
      minSample: 3,
      consecutiveZero: 5,
      cooldownHours: 6,
      recipients: ["ops@example.com"],
      summary,
      now: tCron,
    });
    expect(cronRes.alerted).toBe(true);
    expect(cronRes.recipientsEmailed).toBe(1);

    // We should now see two rows in the watermarked window: the test
    // row (is_test=true) and the real cron row (is_test=false).
    const rows = await fetchPageHistorySinceWatermark();
    expect(rows).toHaveLength(2);
    const flags = rows.map((r) => r.isTest).sort();
    expect(flags).toEqual([false, true]);
  });
});

describe("runManualEntryAlertHealthOpsAlertJob — no recipients", () => {
  it("returns no_recipients without throwing when neither super-admins (filtered out) nor OPS_ALERT_EMAILS provide an address", async () => {
    for (let i = 0; i < 5; i++) {
      await insertAlert({ pushSent: 0, emailSent: 0 });
    }
    const summary = makeSummary({
      alertCount: 10,
      anyDeliveryRate: 0,
      zeroDeliveryCount: 10,
    });
    // recipients=[] forces an empty list (we deliberately bypass the
    // super-admin / env lookup so the test doesn't have to scrub other
    // super-admins out of the DB).
    const res = await runManualEntryAlertHealthOpsAlertJob({
      thresholdPct: 80,
      minSample: 3,
      consecutiveZero: 5,
      cooldownHours: 6,
      recipients: [],
      summary,
    });
    expect(res.alerted).toBe(false);
    expect(res.reason).toBe("no_recipients");
    expect(emailMock).not.toHaveBeenCalled();
  });
});

// Task #1664 — verify the cron honours the DB-backed singleton
// overrides when the caller doesn't pass `opts.*`. The DB → env →
// default precedence is exercised end-to-end by tightening the
// threshold (so a 7d rate that previously didn't breach now does).
describe("runManualEntryAlertHealthOpsAlertJob — DB-backed tunables (Task #1664)", () => {
  it("uses the DB-stored rate threshold when no opts are passed", async () => {
    // Healthy alerts so consecutive-zero is not a confounding trigger.
    for (let i = 0; i < 5; i++) {
      await insertAlert({ pushSent: 1, emailSent: 1 });
    }
    // 50% delivery rate — would NOT breach the default 80% threshold
    // when minSample is reasonable (50 < 80, but we need to make sure
    // we trip on the *DB* override). Bump the DB threshold to 95 so
    // 50% definitely breaches.
    await db
      .update(opsAlertSettingsTable)
      .set({
        manualEntryRateThresholdPct: 95,
        manualEntryMinSample: 3,
        manualEntryConsecutiveZero: 5,
        manualEntryCooldownHours: 6,
      })
      .where(eq(opsAlertSettingsTable.id, 1));
    _resetOpsAlertSettingsCacheForTest();

    const summary = makeSummary({
      alertCount: 20,
      anyDeliveryRate: 50,
      pushDeliveryRate: 50,
      emailDeliveryRate: 50,
      zeroDeliveryCount: 10,
    });

    const res = await runManualEntryAlertHealthOpsAlertJob({
      // No threshold/minSample/consecutiveZero/cooldownHours opts —
      // forces the resolveOpsAlertConfig path.
      recipients: ["ops@example.com"],
      summary,
    });

    expect(res.alerted).toBe(true);
    expect(res.thresholdPct).toBe(95);
    expect(res.minSample).toBe(3);
    expect(res.consecutiveZero).toBe(5);
    expect(res.breaches.map((b) => b.kind)).toContain("delivery_rate");
  });

  it("falls back to env / default when the DB override is null", async () => {
    for (let i = 0; i < 5; i++) {
      await insertAlert({ pushSent: 1, emailSent: 1 });
    }
    // Singleton is NULL on every column (cleared in beforeEach), and
    // we don't set the env vars here, so the cron should fall back to
    // the hardcoded defaults (80 / 3 / 5 / 6). A 95% rate is healthy
    // → no breach.
    const summary = makeSummary({
      alertCount: 20,
      anyDeliveryRate: 95,
      zeroDeliveryCount: 0,
    });
    const res = await runManualEntryAlertHealthOpsAlertJob({
      recipients: ["ops@example.com"],
      summary,
    });
    expect(res.alerted).toBe(false);
    expect(res.thresholdPct).toBe(80);
    expect(res.minSample).toBe(3);
    expect(res.consecutiveZero).toBe(5);
  });
});

// Task #2078 — `getManualEntryAlertHealthCooldownStatus` is the
// dashboard read-only snapshot the super-admin manual-entry alerts page
// polls so admins can see "we would have paged but on-call is shielded
// until <when>" while a fresh breach is firing inside an active
// cooldown. These tests pin the four shapes the dashboard cares about:
// no-history, in-cooldown + breach (active), in-cooldown + healthy
// (inactive), and elapsed-cooldown + breach (inactive).
describe("getManualEntryAlertHealthCooldownStatus (Task #2078)", () => {
  async function insertPageHistoryRow(opts: {
    pagedAt: Date;
    cooldownHours: number;
  }) {
    const [row] = await db
      .insert(manualEntryAlertPageHistoryTable)
      .values({
        pagedAt: opts.pagedAt,
        breachKinds: ["delivery_rate"],
        recipientCount: 1,
        recipientEmails: ["ops@example.com"],
        thresholdPct: "80.00",
        cooldownHours: opts.cooldownHours.toFixed(2),
        alertCount7d: 10,
        anyDeliveryRate7d: "0.00",
        zeroDeliveryCount7d: 10,
      })
      .returning({ id: manualEntryAlertPageHistoryTable.id });
    return row.id;
  }

  it("returns active=false (and null timestamps) when no page-history rows exist for any cohort", async () => {
    // beforeEach already cleared this run's inserts; we need to also
    // wipe any rows the wider test suite left behind so the "no
    // history" branch is deterministic. Restoring is unnecessary —
    // every page-history test re-creates the rows it needs.
    await db.delete(manualEntryAlertPageHistoryTable);

    const summary = makeSummary({
      alertCount: 20,
      anyDeliveryRate: 0,
      zeroDeliveryCount: 20,
    });
    const status = await getManualEntryAlertHealthCooldownStatus({
      now: new Date("2026-04-30T12:00:00Z"),
      summary,
    });
    expect(status.active).toBe(false);
    expect(status.latestPagedAt).toBeNull();
    expect(status.cooldownHours).toBeNull();
    expect(status.nextPageEligibleAt).toBeNull();
    // Live breach state is still surfaced for diagnostics.
    expect(status.breachKinds).toContain("delivery_rate");
  });

  it("returns active=true with nextPageEligibleAt when a fresh breach fires inside the cooldown window", async () => {
    await db.delete(manualEntryAlertPageHistoryTable);
    const t0 = new Date("2026-04-30T10:00:00Z");
    await insertPageHistoryRow({ pagedAt: t0, cooldownHours: 6 });

    // Healthy alerts so consecutive-zero is NOT confounding; only the
    // delivery-rate breach should fire.
    for (let i = 0; i < 5; i++) {
      await insertAlert({ pushSent: 1, emailSent: 1 });
    }
    const summary = makeSummary({
      alertCount: 20,
      anyDeliveryRate: 30,
      pushDeliveryRate: 30,
      emailDeliveryRate: 30,
      zeroDeliveryCount: 14,
    });

    // 1h after the page → still 5h before the cooldown lifts.
    const status = await getManualEntryAlertHealthCooldownStatus({
      now: new Date(t0.getTime() + 60 * 60 * 1000),
      summary,
    });

    expect(status.active).toBe(true);
    expect(status.latestPagedAt).toBe(t0.toISOString());
    expect(status.cooldownHours).toBe(6);
    expect(status.nextPageEligibleAt).toBe(
      new Date(t0.getTime() + 6 * 60 * 60 * 1000).toISOString(),
    );
    expect(status.breachKinds).toContain("delivery_rate");
  });

  it("returns active=false when inside the cooldown but no breach currently fires", async () => {
    await db.delete(manualEntryAlertPageHistoryTable);
    const t0 = new Date("2026-04-30T10:00:00Z");
    await insertPageHistoryRow({ pagedAt: t0, cooldownHours: 6 });
    // Healthy alerts → consecutive-zero is not tripped.
    for (let i = 0; i < 5; i++) {
      await insertAlert({ pushSent: 1, emailSent: 1 });
    }
    // 7d rate above threshold → delivery-rate is not tripped.
    const summary = makeSummary({
      alertCount: 20,
      anyDeliveryRate: 99,
      pushDeliveryRate: 99,
      emailDeliveryRate: 99,
      zeroDeliveryCount: 0,
    });
    const status = await getManualEntryAlertHealthCooldownStatus({
      now: new Date(t0.getTime() + 60 * 60 * 1000),
      summary,
    });
    expect(status.active).toBe(false);
    expect(status.breachKinds).toEqual([]);
    // The timestamps are still populated so the dashboard could show
    // "last paged" context independently of the active flag.
    expect(status.latestPagedAt).toBe(t0.toISOString());
    expect(status.nextPageEligibleAt).toBe(
      new Date(t0.getTime() + 6 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("returns active=false once the cooldown window has elapsed, even with a fresh breach", async () => {
    await db.delete(manualEntryAlertPageHistoryTable);
    const t0 = new Date("2026-04-30T10:00:00Z");
    await insertPageHistoryRow({ pagedAt: t0, cooldownHours: 6 });
    for (let i = 0; i < 5; i++) {
      await insertAlert({ pushSent: 1, emailSent: 1 });
    }
    const summary = makeSummary({
      alertCount: 20,
      anyDeliveryRate: 30,
      pushDeliveryRate: 30,
      emailDeliveryRate: 30,
      zeroDeliveryCount: 14,
    });
    // 7h after the page → cooldown lifted 1h ago.
    const status = await getManualEntryAlertHealthCooldownStatus({
      now: new Date(t0.getTime() + 7 * 60 * 60 * 1000),
      summary,
    });
    expect(status.active).toBe(false);
    expect(status.breachKinds).toContain("delivery_rate");
    expect(status.nextPageEligibleAt).toBe(
      new Date(t0.getTime() + 6 * 60 * 60 * 1000).toISOString(),
    );
  });

  it("uses the cooldown hours captured on the latest page row, not the current tunable", async () => {
    // The cron snapshots `cooldown_hours` onto the page row at page
    // time. If an admin tweaks the tunable mid-incident the dashboard
    // should still derive "next eligible" from the historical snapshot
    // so the displayed time matches the cron's actual gating.
    await db.delete(manualEntryAlertPageHistoryTable);
    const t0 = new Date("2026-04-30T10:00:00Z");
    await insertPageHistoryRow({ pagedAt: t0, cooldownHours: 12 });
    for (let i = 0; i < 5; i++) {
      await insertAlert({ pushSent: 1, emailSent: 1 });
    }
    // Force a stale tunable in DB (3h) — the dashboard should ignore
    // this and use the 12h on the row.
    await db
      .update(opsAlertSettingsTable)
      .set({
        manualEntryRateThresholdPct: 80,
        manualEntryMinSample: 3,
        manualEntryConsecutiveZero: 5,
        manualEntryCooldownHours: 3,
      })
      .where(eq(opsAlertSettingsTable.id, 1));
    _resetOpsAlertSettingsCacheForTest();

    const summary = makeSummary({
      alertCount: 20,
      anyDeliveryRate: 0,
      zeroDeliveryCount: 20,
    });
    // 4h after the page — past the new 3h tunable, but well inside the
    // captured 12h snapshot.
    const status = await getManualEntryAlertHealthCooldownStatus({
      now: new Date(t0.getTime() + 4 * 60 * 60 * 1000),
      summary,
    });
    expect(status.cooldownHours).toBe(12);
    expect(status.active).toBe(true);
    expect(status.nextPageEligibleAt).toBe(
      new Date(t0.getTime() + 12 * 60 * 60 * 1000).toISOString(),
    );
  });
});
