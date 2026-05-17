/**
 * Tests for Task #1130 — daily ops alert for retry-exhausted notification
 * rows (coach-payout + levy-receipt push/SMS).
 *
 * Covers:
 *   - Below threshold → no email sent.
 *   - Above threshold (combined coach-payout + levy-receipt) → one email
 *     per recipient with the correct breakdown counts.
 *   - Stale exhaustions (outside the lookback window) are excluded.
 *   - Threshold-met but `OPS_ALERT_EMAILS` unset → no email, no throw,
 *     warn-logged via the `no_recipients` branch.
 *   - Daily dedup: a second run on the same UTC day is suppressed unless
 *     `force` is set.
 *   - Task #1305: when `opts.threshold` / `opts.windowHours` are NOT
 *     pinned by the caller, the cron resolves them from the
 *     `ops_alert_settings` singleton row (DB override → env var →
 *     hardcoded default), so an admin can tune sensitivity without a
 *     redeploy and the next cron run picks the change up.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => ({
  sendNotifyRetryExhaustionOpsAlertEmail: vi.fn(async () => undefined),
}));

// Task #1652 — chat dispatch fires alongside the email send. Keep these
// tests focused on the email / threshold / dedup behaviour by stubbing
// the chat senders out (defence in depth: the env vars are also unset,
// so no HTTP would happen, but mocking guards against accidental env
// leakage from the dev shell).
vi.mock("../lib/opsAlertChat.js", async () => ({
  postNotifyRetryExhaustionOpsAlertSlack: vi.fn(async () => undefined),
  triggerNotifyRetryExhaustionOpsAlertPagerDuty: vi.fn(async () => undefined),
  resolveOpsAlertChatTargets: vi.fn(() => ({ slackWebhook: null, pagerDutyRoutingKey: null })),
}));

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  teachingProsTable,
  coachPayoutsTable,
  coachPayoutNotificationAttemptsTable,
  clubMembersTable,
  memberLeviesTable,
  memberLevyChargesTable,
  memberLevyReceiptAttemptsTable,
  opsAlertSettingsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

import {
  runNotifyExhaustionOpsAlertJob,
  _resetNotifyExhaustionAlertDedupForTest,
} from "../lib/notifyExhaustionOpsAlert.js";
import {
  resolveOpsAlertConfig,
  updateOpsAlertSettings,
  _resetOpsAlertSettingsCacheForTest,
} from "../lib/opsAlertSettings.js";
import { sendNotifyRetryExhaustionOpsAlertEmail } from "../lib/mailer.js";

const emailMock = vi.mocked(sendNotifyRetryExhaustionOpsAlertEmail);

let testOrgId: number;
let testUserId: number;
let testProId: number;
let testMemberId: number;
let testLevyId: number;
const coachAttemptIds: number[] = [];
const coachPayoutIds: number[] = [];
const levyAttemptIds: number[] = [];
const levyChargeIds: number[] = [];

let payoutSeq = 0;
async function makeCoachAttempt(opts: {
  pushExhaustedAt?: Date | null;
  smsExhaustedAt?: Date | null;
}) {
  payoutSeq += 1;
  const now = new Date();
  const [payout] = await db.insert(coachPayoutsTable).values({
    proId: testProId,
    organizationId: testOrgId,
    periodStart: now,
    periodEnd: now,
    grossPaise: 50000,
    platformFeePaise: 0,
    netPayoutPaise: 50000,
    status: "paid",
    payoutReference: `OPS-ALERT-${Date.now()}-${payoutSeq}`,
    paidAt: now,
  }).returning({ id: coachPayoutsTable.id });
  coachPayoutIds.push(payout.id);

  const [a] = await db.insert(coachPayoutNotificationAttemptsTable).values({
    payoutId: payout.id,
    proId: testProId,
    organizationId: testOrgId,
    coachUserId: testUserId,
    amountPaise: 50000,
    reference: "OPS-ALERT-TEST",
    notes: null,
    orgName: "OpsAlertTestOrg",
    pushStatus: opts.pushExhaustedAt ? "failed" : null,
    pushAttempts: opts.pushExhaustedAt ? 5 : 0,
    pushRetryExhaustedAt: opts.pushExhaustedAt ?? null,
    smsStatus: opts.smsExhaustedAt ? "failed" : null,
    smsAttempts: opts.smsExhaustedAt ? 5 : 0,
    smsRetryExhaustedAt: opts.smsExhaustedAt ?? null,
  }).returning({ id: coachPayoutNotificationAttemptsTable.id });
  coachAttemptIds.push(a.id);
  return a.id;
}

const levyMemberIds: number[] = [];
async function makeLevyAttempt(opts: {
  pushExhaustedAt?: Date | null;
  smsExhaustedAt?: Date | null;
}) {
  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Ops",
    lastName: `LevyMember_${levyMemberIds.length}`,
    email: null,
    phone: null,
  }).returning({ id: clubMembersTable.id });
  levyMemberIds.push(member.id);

  const [charge] = await db.insert(memberLevyChargesTable).values({
    clubMemberId: member.id,
    levyId: testLevyId,
    amount: "100.00",
    status: "unpaid",
  }).returning({ id: memberLevyChargesTable.id });
  levyChargeIds.push(charge.id);

  const [a] = await db.insert(memberLevyReceiptAttemptsTable).values({
    organizationId: testOrgId,
    chargeId: charge.id,
    clubMemberId: member.id,
    kind: "payment",
    levyName: "OpsAlertLevy",
    currency: "INR",
    transactionAmount: "100.00",
    newBalance: "0.00",
    note: null,
    pushStatus: opts.pushExhaustedAt ? "failed" : "skipped",
    pushAttempts: opts.pushExhaustedAt ? 5 : 0,
    pushRetryExhaustedAt: opts.pushExhaustedAt ?? null,
    smsStatus: opts.smsExhaustedAt ? "failed" : "skipped",
    smsAttempts: opts.smsExhaustedAt ? 5 : 0,
    smsRetryExhaustedAt: opts.smsExhaustedAt ?? null,
  }).returning({ id: memberLevyReceiptAttemptsTable.id });
  levyAttemptIds.push(a.id);
  return a.id;
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `OpsAlertTestOrg_${stamp}`,
    slug: `ops-alert-test-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `ops-alert-${stamp}`,
    username: `ops_alert_${stamp}`,
  }).returning({ id: appUsersTable.id });
  testUserId = u.id;

  const [pro] = await db.insert(teachingProsTable).values({
    organizationId: testOrgId,
    userId: testUserId,
    displayName: "Ops Alert Coach",
    email: null,
    phone: null,
  }).returning({ id: teachingProsTable.id });
  testProId = pro.id;

  const [member] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    userId: testUserId,
    firstName: "Ops",
    lastName: "Alert",
    email: null,
    phone: null,
  }).returning({ id: clubMembersTable.id });
  testMemberId = member.id;

  const [levy] = await db.insert(memberLeviesTable).values({
    organizationId: testOrgId,
    name: "OpsAlertLevy",
    amount: "100.00",
    currency: "INR",
  }).returning({ id: memberLeviesTable.id });
  testLevyId = levy.id;

});

afterAll(async () => {
  for (const id of coachAttemptIds) {
    await db.delete(coachPayoutNotificationAttemptsTable)
      .where(eq(coachPayoutNotificationAttemptsTable.id, id));
  }
  for (const id of levyAttemptIds) {
    await db.delete(memberLevyReceiptAttemptsTable)
      .where(eq(memberLevyReceiptAttemptsTable.id, id));
  }
  for (const id of levyChargeIds) {
    await db.delete(memberLevyChargesTable).where(eq(memberLevyChargesTable.id, id));
  }
  if (testLevyId) {
    await db.delete(memberLeviesTable).where(eq(memberLeviesTable.id, testLevyId));
  }
  for (const id of levyMemberIds) {
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, id));
  }
  if (testMemberId) {
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, testMemberId));
  }
  for (const id of coachPayoutIds) {
    await db.delete(coachPayoutsTable).where(eq(coachPayoutsTable.id, id));
  }
  if (testProId) {
    await db.delete(teachingProsTable).where(eq(teachingProsTable.id, testProId));
  }
  if (testUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  }
  if (testOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  }
});

beforeEach(async () => {
  emailMock.mockReset();
  emailMock.mockResolvedValue(undefined);
  _resetNotifyExhaustionAlertDedupForTest();
  _resetOpsAlertSettingsCacheForTest();
  // Wipe per-test state so counts don't leak across tests in the same file.
  for (const id of coachAttemptIds.splice(0)) {
    await db.delete(coachPayoutNotificationAttemptsTable)
      .where(eq(coachPayoutNotificationAttemptsTable.id, id));
  }
  for (const id of levyAttemptIds.splice(0)) {
    await db.delete(memberLevyReceiptAttemptsTable)
      .where(eq(memberLevyReceiptAttemptsTable.id, id));
  }
  // Reset the singleton ops_alert_settings row to "no overrides" so each
  // test starts from a known baseline (env vars / hardcoded defaults).
  await db.update(opsAlertSettingsTable)
    .set({
      notifyExhaustionThreshold: null,
      notifyExhaustionWindowHours: null,
      // Task #1910 — also clear the recipient override so a previous
      // test's PATCH cannot leak through and silently take over the
      // env-based recipient resolution path.
      notifyExhaustionRecipients: null,
      updatedByUserId: null,
    })
    .where(eq(opsAlertSettingsTable.id, 1));
});

describe("runNotifyExhaustionOpsAlertJob — below threshold", () => {
  it("does not send when combined exhaustion count is under the threshold", async () => {
    const now = new Date();
    await makeCoachAttempt({ pushExhaustedAt: now });

    const res = await runNotifyExhaustionOpsAlertJob({
      threshold: 5,
      windowHours: 24,
      opsEmails: ["ops@example.com"],
      now,
    });

    expect(res.alerted).toBe(false);
    expect(res.reason).toBe("below_threshold");
    expect(res.summary.totalRows).toBe(1);
    expect(emailMock).not.toHaveBeenCalled();
  });
});

describe("runNotifyExhaustionOpsAlertJob — above threshold", () => {
  it("emails every recipient with the per-pipeline breakdown", async () => {
    const now = new Date();
    // 3 coach rows (one with both push+sms exhausted) + 3 levy push rows
    // → 6 distinct rows, above threshold 5. Per-channel: coach push=3,
    // sms=1, rows=3; levy push=3, sms=0, rows=3.
    await makeCoachAttempt({ pushExhaustedAt: now });
    await makeCoachAttempt({ pushExhaustedAt: now });
    await makeCoachAttempt({ pushExhaustedAt: now, smsExhaustedAt: now });
    await makeLevyAttempt({ pushExhaustedAt: now });
    await makeLevyAttempt({ pushExhaustedAt: now });
    await makeLevyAttempt({ pushExhaustedAt: now });

    const res = await runNotifyExhaustionOpsAlertJob({
      threshold: 5,
      windowHours: 24,
      opsEmails: ["ops@example.com", "oncall@example.com"],
      now,
    });

    expect(res.alerted).toBe(true);
    expect(res.recipients).toBe(2);
    expect(res.summary.totalRows).toBe(6);
    expect(res.summary.coachPayout).toEqual({ push: 3, sms: 1, rows: 3 });
    expect(res.summary.levyReceipt).toEqual({ push: 3, sms: 0, rows: 3 });
    expect(emailMock).toHaveBeenCalledTimes(2);
    const firstCall = emailMock.mock.calls[0][0];
    expect(firstCall.summary.totalRows).toBe(6);
    expect(firstCall.to).toBe("ops@example.com");
  });

  it("excludes exhaustions stamped outside the lookback window", async () => {
    const now = new Date();
    const stale = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    for (let i = 0; i < 6; i++) {
      await makeCoachAttempt({ pushExhaustedAt: stale });
    }

    const res = await runNotifyExhaustionOpsAlertJob({
      threshold: 5,
      windowHours: 24,
      opsEmails: ["ops@example.com"],
      now,
    });

    expect(res.alerted).toBe(false);
    expect(res.summary.totalRows).toBe(0);
    expect(emailMock).not.toHaveBeenCalled();
  });
});

describe("runNotifyExhaustionOpsAlertJob — no recipients", () => {
  it("returns no_recipients without throwing when threshold met but OPS_ALERT_EMAILS is empty", async () => {
    const now = new Date();
    for (let i = 0; i < 6; i++) {
      await makeCoachAttempt({ pushExhaustedAt: now });
    }

    const res = await runNotifyExhaustionOpsAlertJob({
      threshold: 5,
      windowHours: 24,
      opsEmails: [],
      now,
    });

    expect(res.alerted).toBe(false);
    expect(res.reason).toBe("no_recipients");
    expect(res.summary.totalRows).toBe(6);
    expect(emailMock).not.toHaveBeenCalled();
  });
});

describe("runNotifyExhaustionOpsAlertJob — daily dedup", () => {
  it("suppresses a second run on the same UTC day, but `force` overrides", async () => {
    const now = new Date();
    for (let i = 0; i < 6; i++) {
      await makeCoachAttempt({ pushExhaustedAt: now });
    }

    const first = await runNotifyExhaustionOpsAlertJob({
      threshold: 5,
      windowHours: 24,
      opsEmails: ["ops@example.com"],
      now,
    });
    expect(first.alerted).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(1);

    const second = await runNotifyExhaustionOpsAlertJob({
      threshold: 5,
      windowHours: 24,
      opsEmails: ["ops@example.com"],
      now,
    });
    expect(second.alerted).toBe(false);
    expect(second.reason).toBe("already_alerted_today");
    expect(emailMock).toHaveBeenCalledTimes(1);

    const forced = await runNotifyExhaustionOpsAlertJob({
      threshold: 5,
      windowHours: 24,
      opsEmails: ["ops@example.com"],
      now,
      force: true,
    });
    expect(forced.alerted).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(2);
  });
});

describe("runNotifyExhaustionOpsAlertJob — Task #1305 admin-tunable settings", () => {
  it("uses the DB-stored threshold when caller does not pin opts.threshold", async () => {
    // Arrange: 4 exhausted rows, env default threshold of 5 — would NOT
    // alert under env defaults. Stash a DB override of 3 so the cron
    // *should* alert on the same data.
    const now = new Date();
    for (let i = 0; i < 4; i++) {
      await makeCoachAttempt({ pushExhaustedAt: now });
    }

    const setRes = await updateOpsAlertSettings({
      notifyExhaustionThreshold: 3,
      // notifyExhaustionWindowHours intentionally omitted → leave inheriting
      userId: null,
    });
    expect(setRes.ok).toBe(true);
    _resetOpsAlertSettingsCacheForTest();

    // Act: do NOT pin threshold/windowHours — cron must resolve from DB.
    const result = await runNotifyExhaustionOpsAlertJob({
      opsEmails: ["ops@example.com"],
      now,
    });

    // Assert: alerted because DB override (3) lowered the bar.
    expect(result.alerted).toBe(true);
    expect(result.summary.totalRows).toBe(4);
    expect(result.summary.threshold).toBe(3);
    expect(emailMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to env / default when the DB override is null", async () => {
    // No DB override set (beforeEach reset). Default threshold is 5.
    // 4 exhausted rows should not trigger an alert.
    const now = new Date();
    for (let i = 0; i < 4; i++) {
      await makeCoachAttempt({ pushExhaustedAt: now });
    }

    const cfg = await resolveOpsAlertConfig();
    expect(cfg.dbThreshold).toBeNull();
    expect(cfg.dbWindowHours).toBeNull();

    const result = await runNotifyExhaustionOpsAlertJob({
      opsEmails: ["ops@example.com"],
      now,
    });

    expect(result.alerted).toBe(false);
    expect(result.reason).toBe("below_threshold");
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("PATCH semantics: only the supplied tunable changes; the other stays as-is", async () => {
    // Set both via one call.
    const r1 = await updateOpsAlertSettings({
      notifyExhaustionThreshold: 7,
      notifyExhaustionWindowHours: 36,
      userId: null,
    });
    expect(r1.ok).toBe(true);
    _resetOpsAlertSettingsCacheForTest();
    let cfg = await resolveOpsAlertConfig();
    expect(cfg.dbThreshold).toBe(7);
    expect(cfg.dbWindowHours).toBe(36);

    // Now PATCH only threshold; window must persist at 36.
    const r2 = await updateOpsAlertSettings({
      notifyExhaustionThreshold: 9,
      // notifyExhaustionWindowHours intentionally omitted
      userId: null,
    });
    expect(r2.ok).toBe(true);
    _resetOpsAlertSettingsCacheForTest();
    cfg = await resolveOpsAlertConfig();
    expect(cfg.dbThreshold).toBe(9);
    expect(cfg.dbWindowHours).toBe(36);

    // Explicit null clears just the window, leaves threshold intact.
    const r3 = await updateOpsAlertSettings({
      notifyExhaustionWindowHours: null,
      userId: null,
    });
    expect(r3.ok).toBe(true);
    _resetOpsAlertSettingsCacheForTest();
    cfg = await resolveOpsAlertConfig();
    expect(cfg.dbThreshold).toBe(9);
    expect(cfg.dbWindowHours).toBeNull();
  });

  it("rejects non-positive / non-integer values", async () => {
    const a = await updateOpsAlertSettings({ notifyExhaustionThreshold: 0, userId: null });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error.kind).toBe("invalid_threshold");

    const b = await updateOpsAlertSettings({ notifyExhaustionWindowHours: -1, userId: null });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error.kind).toBe("invalid_window_hours");

    const c = await updateOpsAlertSettings({ notifyExhaustionThreshold: 1.5, userId: null });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.error.kind).toBe("invalid_threshold");
  });
});

describe("runNotifyExhaustionOpsAlertJob — Task #1547 manual test alert", () => {
  it("sends a synthetic isTest email regardless of DB counts or threshold", async () => {
    const now = new Date();
    // Intentionally NO real exhaustions in the DB — the test path must
    // not depend on the underlying counts.

    const res = await runNotifyExhaustionOpsAlertJob({
      isTest: true,
      threshold: 999, // way above what any synthetic summary would meet
      windowHours: 24,
      opsEmails: ["ops@example.com", "oncall@example.com"],
      now,
    });

    expect(res.alerted).toBe(true);
    expect(res.isTest).toBe(true);
    expect(res.recipients).toBe(2);
    // Synthetic summary has small non-zero counts so the email body is legible.
    expect(res.summary.totalRows).toBeGreaterThan(0);
    expect(res.summary.coachPayout.rows + res.summary.levyReceipt.rows)
      .toBe(res.summary.totalRows);
    expect(emailMock).toHaveBeenCalledTimes(2);
    for (const call of emailMock.mock.calls) {
      expect(call[0].isTest).toBe(true);
      expect(call[0].summary.totalRows).toBe(res.summary.totalRows);
    }
  });

  it("does NOT consume the daily dedup — a real alert later today still fires", async () => {
    const now = new Date();

    // 1) Send a test — must not stamp lastAlertedDateUtc.
    const test = await runNotifyExhaustionOpsAlertJob({
      isTest: true,
      threshold: 5,
      windowHours: 24,
      opsEmails: ["ops@example.com"],
      now,
    });
    expect(test.alerted).toBe(true);
    expect(test.isTest).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(1);

    // 2) Now a real exhaustion incident: 6 rows + a normal cron run.
    for (let i = 0; i < 6; i++) {
      await makeCoachAttempt({ pushExhaustedAt: now });
    }

    const real = await runNotifyExhaustionOpsAlertJob({
      threshold: 5,
      windowHours: 24,
      opsEmails: ["ops@example.com"],
      now,
    });

    expect(real.alerted).toBe(true);
    expect(real.reason).toBeUndefined();
    expect(real.summary.totalRows).toBe(6);
    expect(emailMock).toHaveBeenCalledTimes(2);
    // Second call is the real one — isTest must NOT be set.
    expect(emailMock.mock.calls[1][0].isTest).toBeUndefined();
  });

  it("returns no_recipients without throwing when OPS_ALERT_EMAILS is empty", async () => {
    const res = await runNotifyExhaustionOpsAlertJob({
      isTest: true,
      threshold: 5,
      windowHours: 24,
      opsEmails: [],
      now: new Date(),
    });

    expect(res.alerted).toBe(false);
    expect(res.reason).toBe("no_recipients");
    expect(res.isTest).toBe(true);
    expect(res.recipients).toBe(0);
    expect(emailMock).not.toHaveBeenCalled();
  });
});

describe("runNotifyExhaustionOpsAlertJob — Task #1917 override recipient", () => {
  it("delivers the test email only to the override recipient and ignores OPS_ALERT_EMAILS", async () => {
    const res = await runNotifyExhaustionOpsAlertJob({
      isTest: true,
      threshold: 5,
      windowHours: 24,
      // The live ops list is non-empty, but the override flow must
      // bypass it entirely — admins are previewing the email on their
      // own inbox without paging the on-call team.
      opsEmails: ["ops@example.com", "oncall@example.com"],
      overrideRecipient: "me@example.com",
      now: new Date(),
    });

    expect(res.alerted).toBe(true);
    expect(res.isTest).toBe(true);
    expect(res.recipients).toBe(1);
    expect(emailMock).toHaveBeenCalledTimes(1);
    const call = emailMock.mock.calls[0][0];
    expect(call.to).toBe("me@example.com");
    expect(call.isTest).toBe(true);
  });

  it("trims whitespace and treats blank/whitespace-only override as no override", async () => {
    // Whitespace-only override → falls back to OPS_ALERT_EMAILS path.
    const res = await runNotifyExhaustionOpsAlertJob({
      isTest: true,
      threshold: 5,
      windowHours: 24,
      opsEmails: ["ops@example.com"],
      overrideRecipient: "   ",
      now: new Date(),
    });

    expect(res.alerted).toBe(true);
    expect(res.isTest).toBe(true);
    expect(res.recipients).toBe(1);
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(emailMock.mock.calls[0][0].to).toBe("ops@example.com");
  });

  it("does not consume the daily dedup when sent to an override recipient", async () => {
    const now = new Date();

    // 1) Send a test to an override address.
    const test = await runNotifyExhaustionOpsAlertJob({
      isTest: true,
      threshold: 5,
      windowHours: 24,
      opsEmails: ["ops@example.com"],
      overrideRecipient: "me@example.com",
      now,
    });
    expect(test.alerted).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(emailMock.mock.calls[0][0].to).toBe("me@example.com");

    // 2) A real exhaustion incident later the same UTC day still alerts.
    for (let i = 0; i < 6; i++) {
      await makeCoachAttempt({ pushExhaustedAt: now });
    }
    const real = await runNotifyExhaustionOpsAlertJob({
      threshold: 5,
      windowHours: 24,
      opsEmails: ["ops@example.com"],
      now,
    });
    expect(real.alerted).toBe(true);
    expect(real.reason).toBeUndefined();
    expect(emailMock).toHaveBeenCalledTimes(2);
    expect(emailMock.mock.calls[1][0].to).toBe("ops@example.com");
    expect(emailMock.mock.calls[1][0].isTest).toBeUndefined();
  });

  it("reports alerted=false (no no_recipients) when the override send throws", async () => {
    emailMock.mockRejectedValueOnce(new Error("smtp boom"));
    const res = await runNotifyExhaustionOpsAlertJob({
      isTest: true,
      threshold: 5,
      windowHours: 24,
      opsEmails: ["ops@example.com"],
      overrideRecipient: "me@example.com",
      now: new Date(),
    });
    expect(res.alerted).toBe(false);
    expect(res.recipients).toBe(0);
    expect(res.isTest).toBe(true);
    // Importantly NOT no_recipients — the override list is one address
    // that just happened to fail; the route surfaces 502 in that case.
    expect(res.reason).toBeUndefined();
  });
});

// Task #1910 — DB-backed override of the recipient list. The cron
// resolves recipients via the same DB→env priority as the numeric
// tunables (Task #1305): a non-empty `notifyExhaustionRecipients`
// column on the singleton wins; otherwise we fall back to the env
// list. These tests exercise the end-to-end path: write the override
// via `updateOpsAlertSettings` (so the cache + history paths are real),
// then run the cron WITHOUT pinning `opsEmails` so resolution must come
// from the resolved config.
describe("runNotifyExhaustionOpsAlertJob — Task #1910 recipient override", () => {
  it("uses the DB recipient list when set; cron does not pin opsEmails", async () => {
    const now = new Date();
    for (let i = 0; i < 6; i++) {
      await makeCoachAttempt({ pushExhaustedAt: now });
    }

    const setRes = await updateOpsAlertSettings({
      notifyExhaustionThreshold: 5,
      notifyExhaustionWindowHours: 24,
      notifyExhaustionRecipients: ["override-a@example.com", "override-b@example.com"],
      userId: null,
    });
    expect(setRes.ok).toBe(true);
    _resetOpsAlertSettingsCacheForTest();

    // No `opsEmails` pinned — must resolve from DB override.
    const result = await runNotifyExhaustionOpsAlertJob({ now });

    expect(result.alerted).toBe(true);
    expect(result.recipients).toBe(2);
    expect(emailMock).toHaveBeenCalledTimes(2);
    const recipients = emailMock.mock.calls.map(c => c[0].to).sort();
    expect(recipients).toEqual(["override-a@example.com", "override-b@example.com"]);
  });

  it("falls back to env recipients when the DB override is empty / null", async () => {
    const now = new Date();
    for (let i = 0; i < 6; i++) {
      await makeCoachAttempt({ pushExhaustedAt: now });
    }

    // Seed an override, then clear it via empty array — same path the
    // super-admin UI takes when the recipient textarea is emptied.
    const seed = await updateOpsAlertSettings({
      notifyExhaustionThreshold: 5,
      notifyExhaustionWindowHours: 24,
      notifyExhaustionRecipients: ["soon-to-be-cleared@example.com"],
      userId: null,
    });
    expect(seed.ok).toBe(true);
    const cleared = await updateOpsAlertSettings({
      notifyExhaustionRecipients: [],
      userId: null,
    });
    expect(cleared.ok).toBe(true);
    _resetOpsAlertSettingsCacheForTest();

    // Pin opsEmails to simulate what the env-driven scheduler does
    // when the DB override is absent — this mirrors the real cron
    // wiring where the scheduler reads OPS_ALERT_EMAILS as a fallback
    // and passes it as opsEmails. The cron itself prefers the pinned
    // list, so a cleared DB override correctly falls all the way back
    // to env without needing the cron to re-read process.env.
    const result = await runNotifyExhaustionOpsAlertJob({
      now,
      opsEmails: ["env-fallback@example.com"],
    });

    expect(result.alerted).toBe(true);
    expect(result.recipients).toBe(1);
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(emailMock.mock.calls[0][0].to).toBe("env-fallback@example.com");
  });
});
