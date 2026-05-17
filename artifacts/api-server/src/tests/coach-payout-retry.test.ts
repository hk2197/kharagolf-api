/**
 * Unit tests: coach payout-paid push/SMS retry helpers (Task #967).
 *
 * Mirrors the levy-receipt retry test shape (Task #247 / #286) for the new
 * `retryCoachPayoutPush` / `retryCoachPayoutSms` helpers in
 * `coachPayoutNotify.ts`:
 *   - Happy path: a previously `failed` push/SMS retries successfully and
 *     the attempts row is updated with the new status, attempt count, and
 *     `lastPushRetryAt` / `lastSmsRetryAt`.
 *   - Cap: once `pushAttempts`/`smsAttempts` reaches the configured cap and
 *     the retry still fails, `pushRetryExhaustedAt` / `smsRetryExhaustedAt`
 *     is stamped and any subsequent retry returns `null`.
 *   - SMS provider-not-configured: status flips to terminal `skipped`, the
 *     cron stops re-selecting the row, and `smsAttempts` is NOT incremented.
 *   - Ineligibility: rows whose status is no longer `failed` return `null`
 *     without firing any provider call.
 *
 * The comms module is mocked so we don't touch real push/SMS providers. The
 * DB is real so we exercise the same lookup/update path the cron uses.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/comms.js", async () => ({
  sendTransactionalPush: vi.fn(async (userIds: number[]) => ({
    attempted: userIds.length,
    sent: userIds.length,
    failed: 0,
    invalid: 0,
  })),
  sendTransactionalSms: vi.fn(async () => undefined),
}));

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  teachingProsTable,
  coachPayoutsTable,
  coachPayoutNotificationAttemptsTable,
  type CoachPayoutNotificationAttempt,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  retryCoachPayoutPush,
  retryCoachPayoutSms,
  COACH_PAYOUT_MAX_PUSH_ATTEMPTS,
  COACH_PAYOUT_MAX_SMS_ATTEMPTS,
} from "../lib/coachPayoutNotify.js";
import { sendTransactionalPush, sendTransactionalSms } from "../lib/comms.js";

const pushMock = vi.mocked(sendTransactionalPush);
const smsMock = vi.mocked(sendTransactionalSms);

let testOrgId: number;
const userIds: number[] = [];
const proIds: number[] = [];
const payoutIds: number[] = [];
const attemptIds: number[] = [];
let seq = 0;

async function makeAppUser(): Promise<number> {
  seq += 1;
  const tag = `${Date.now()}_${seq}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `coach-payout-retry-${tag}`,
    username: `coach_payout_retry_${tag}`,
  }).returning({ id: appUsersTable.id });
  userIds.push(u.id);
  return u.id;
}

async function makePro(opts: { withUser?: boolean; phone?: string | null }): Promise<{ proId: number; userId: number | null }> {
  const userId = opts.withUser ? await makeAppUser() : null;
  const [pro] = await db.insert(teachingProsTable).values({
    organizationId: testOrgId,
    userId,
    displayName: "Coach Retry",
    email: null,
    phone: opts.phone ?? null,
  }).returning({ id: teachingProsTable.id });
  proIds.push(pro.id);
  return { proId: pro.id, userId };
}

async function makePayout(proId: number): Promise<number> {
  const now = new Date();
  const [p] = await db.insert(coachPayoutsTable).values({
    proId,
    organizationId: testOrgId,
    periodStart: now,
    periodEnd: now,
    grossPaise: 50000,
    platformFeePaise: 0,
    netPayoutPaise: 50000,
    status: "paid",
    payoutReference: "REF-RETRY",
    paidAt: now,
  }).returning({ id: coachPayoutsTable.id });
  payoutIds.push(p.id);
  return p.id;
}

async function makeAttempt(opts: {
  payoutId: number;
  proId: number;
  coachUserId: number | null;
  pushStatus?: string | null;
  pushAttempts?: number;
  smsStatus?: string | null;
  smsAttempts?: number;
}): Promise<CoachPayoutNotificationAttempt> {
  const [a] = await db.insert(coachPayoutNotificationAttemptsTable).values({
    payoutId: opts.payoutId,
    proId: opts.proId,
    organizationId: testOrgId,
    coachUserId: opts.coachUserId,
    amountPaise: 50000,
    reference: "REF-RETRY",
    notes: null,
    orgName: "Test Coach Payout Retry Org",
    pushStatus: opts.pushStatus ?? null,
    pushAttempts: opts.pushAttempts ?? 0,
    smsStatus: opts.smsStatus ?? null,
    smsAttempts: opts.smsAttempts ?? 0,
  }).returning();
  attemptIds.push(a.id);
  return a;
}

async function loadAttempt(id: number): Promise<CoachPayoutNotificationAttempt> {
  const [row] = await db.select().from(coachPayoutNotificationAttemptsTable)
    .where(eq(coachPayoutNotificationAttemptsTable.id, id));
  return row;
}

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_CoachPayoutRetry_${stamp}`,
    slug: `test-coach-payout-retry-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;
});

afterAll(async () => {
  for (const id of attemptIds) {
    await db.delete(coachPayoutNotificationAttemptsTable)
      .where(eq(coachPayoutNotificationAttemptsTable.id, id));
  }
  for (const id of payoutIds) {
    await db.delete(coachPayoutsTable).where(eq(coachPayoutsTable.id, id));
  }
  for (const id of proIds) {
    await db.delete(teachingProsTable).where(eq(teachingProsTable.id, id));
  }
  for (const id of userIds) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, id));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(() => {
  pushMock.mockReset();
  smsMock.mockReset();
  pushMock.mockImplementation(async (uids: number[]) => ({
    attempted: uids.length,
    sent: uids.length,
    failed: 0,
    invalid: 0,
  }));
  smsMock.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────
// retryCoachPayoutPush
// ─────────────────────────────────────────────────────────────────────────
describe("retryCoachPayoutPush — happy path", () => {
  it("retries a previously-failed push, flips status to sent, increments attempts, stamps lastPushRetryAt", async () => {
    const { proId, userId } = await makePro({ withUser: true });
    const payoutId = await makePayout(proId);
    const attempt = await makeAttempt({
      payoutId, proId, coachUserId: userId,
      pushStatus: "failed", pushAttempts: 1,
    });

    const before = Date.now();
    const res = await retryCoachPayoutPush({ attempt });
    const after = Date.now();

    expect(res).not.toBeNull();
    expect(res!.channel).toBe("push");
    expect(res!.status).toBe("sent");
    expect(res!.attempts).toBe(2);
    expect(res!.exhausted).toBe(false);
    expect(pushMock).toHaveBeenCalledTimes(1);

    const row = await loadAttempt(attempt.id);
    expect(row.pushStatus).toBe("sent");
    expect(row.pushAttempts).toBe(2);
    expect(row.lastPushError).toBeNull();
    expect(row.pushRetryExhaustedAt).toBeNull();
    expect(row.lastPushRetryAt).toBeInstanceOf(Date);
    const ts = row.lastPushRetryAt!.getTime();
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(after + 1000);
    expect(row.lastPushAt).toBeInstanceOf(Date);
  });
});

describe("retryCoachPayoutPush — bounded cap", () => {
  it("when attempts reach the cap and push still fails, stamps pushRetryExhaustedAt", async () => {
    const { proId, userId } = await makePro({ withUser: true });
    const payoutId = await makePayout(proId);
    const attempt = await makeAttempt({
      payoutId, proId, coachUserId: userId,
      pushStatus: "failed", pushAttempts: COACH_PAYOUT_MAX_PUSH_ATTEMPTS - 1,
    });
    pushMock.mockRejectedValueOnce(new Error("fcm down"));

    const res = await retryCoachPayoutPush({ attempt });
    expect(res).not.toBeNull();
    expect(res!.status).toBe("failed");
    expect(res!.attempts).toBe(COACH_PAYOUT_MAX_PUSH_ATTEMPTS);
    expect(res!.exhausted).toBe(true);

    const row = await loadAttempt(attempt.id);
    expect(row.pushStatus).toBe("failed");
    expect(row.pushAttempts).toBe(COACH_PAYOUT_MAX_PUSH_ATTEMPTS);
    expect(row.pushRetryExhaustedAt).toBeInstanceOf(Date);
    expect(row.lastPushError).toBe("fcm down");

    // Subsequent cron pass for the same row short circuits to null.
    pushMock.mockClear();
    const next = await retryCoachPayoutPush({ attempt: row });
    expect(next).toBeNull();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("subsequent retries return null once the cap has already been reached", async () => {
    const { proId, userId } = await makePro({ withUser: true });
    const payoutId = await makePayout(proId);
    const attempt = await makeAttempt({
      payoutId, proId, coachUserId: userId,
      pushStatus: "failed", pushAttempts: COACH_PAYOUT_MAX_PUSH_ATTEMPTS,
    });

    const res = await retryCoachPayoutPush({ attempt });
    expect(res).toBeNull();
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe("retryCoachPayoutPush — ineligibility", () => {
  it("returns null without firing push when the row's pushStatus is no longer 'failed'", async () => {
    const { proId, userId } = await makePro({ withUser: true });
    const payoutId = await makePayout(proId);
    const attempt = await makeAttempt({
      payoutId, proId, coachUserId: userId,
      pushStatus: "sent", pushAttempts: 1,
    });

    const res = await retryCoachPayoutPush({ attempt });
    expect(res).toBeNull();
    expect(pushMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// retryCoachPayoutSms
// ─────────────────────────────────────────────────────────────────────────
describe("retryCoachPayoutSms — happy path", () => {
  it("retries a previously-failed SMS, flips status to sent, increments attempts, stamps lastSmsRetryAt", async () => {
    const { proId, userId } = await makePro({ withUser: true, phone: "+911234588001" });
    const payoutId = await makePayout(proId);
    const attempt = await makeAttempt({
      payoutId, proId, coachUserId: userId,
      smsStatus: "failed", smsAttempts: 1,
    });

    const before = Date.now();
    const res = await retryCoachPayoutSms({ attempt });
    const after = Date.now();

    expect(res).not.toBeNull();
    expect(res!.channel).toBe("sms");
    expect(res!.status).toBe("sent");
    expect(res!.attempts).toBe(2);
    expect(res!.exhausted).toBe(false);
    expect(smsMock).toHaveBeenCalledTimes(1);

    const row = await loadAttempt(attempt.id);
    expect(row.smsStatus).toBe("sent");
    expect(row.smsAttempts).toBe(2);
    expect(row.lastSmsError).toBeNull();
    expect(row.smsRetryExhaustedAt).toBeNull();
    expect(row.lastSmsRetryAt).toBeInstanceOf(Date);
    const ts = row.lastSmsRetryAt!.getTime();
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(after + 1000);
  });
});

describe("retryCoachPayoutSms — bounded cap", () => {
  it("when attempts reach the cap and SMS still fails, stamps smsRetryExhaustedAt", async () => {
    const { proId, userId } = await makePro({ withUser: true, phone: "+911234588002" });
    const payoutId = await makePayout(proId);
    const attempt = await makeAttempt({
      payoutId, proId, coachUserId: userId,
      smsStatus: "failed", smsAttempts: COACH_PAYOUT_MAX_SMS_ATTEMPTS - 1,
    });
    smsMock.mockRejectedValueOnce(new Error("twilio down"));

    const res = await retryCoachPayoutSms({ attempt });
    expect(res).not.toBeNull();
    expect(res!.status).toBe("failed");
    expect(res!.attempts).toBe(COACH_PAYOUT_MAX_SMS_ATTEMPTS);
    expect(res!.exhausted).toBe(true);

    const row = await loadAttempt(attempt.id);
    expect(row.smsStatus).toBe("failed");
    expect(row.smsAttempts).toBe(COACH_PAYOUT_MAX_SMS_ATTEMPTS);
    expect(row.smsRetryExhaustedAt).toBeInstanceOf(Date);
    expect(row.lastSmsError).toBe("twilio down");

    smsMock.mockClear();
    const next = await retryCoachPayoutSms({ attempt: row });
    expect(next).toBeNull();
    expect(smsMock).not.toHaveBeenCalled();
  });

  it("subsequent retries return null once the cap has already been reached", async () => {
    const { proId, userId } = await makePro({ withUser: true, phone: "+911234588003" });
    const payoutId = await makePayout(proId);
    const attempt = await makeAttempt({
      payoutId, proId, coachUserId: userId,
      smsStatus: "failed", smsAttempts: COACH_PAYOUT_MAX_SMS_ATTEMPTS,
    });

    const res = await retryCoachPayoutSms({ attempt });
    expect(res).toBeNull();
    expect(smsMock).not.toHaveBeenCalled();
  });
});

describe("retryCoachPayoutSms — provider not configured", () => {
  it("flips status to terminal 'skipped', does NOT increment smsAttempts, and stamps lastSmsRetryAt so the cron stops selecting it", async () => {
    const { proId, userId } = await makePro({ withUser: true, phone: "+911234588004" });
    const payoutId = await makePayout(proId);
    const attempt = await makeAttempt({
      payoutId, proId, coachUserId: userId,
      smsStatus: "failed", smsAttempts: 2,
    });
    smsMock.mockRejectedValueOnce(new Error("SMS_PROVIDER not configured"));

    const res = await retryCoachPayoutSms({ attempt });
    expect(res).not.toBeNull();
    expect(res!.status).toBe("skipped");
    expect(res!.error).toBe("provider_not_configured");
    expect(res!.attempts).toBe(2);
    expect(res!.exhausted).toBe(false);

    const row = await loadAttempt(attempt.id);
    expect(row.smsStatus).toBe("skipped");
    expect(row.smsAttempts).toBe(2);
    expect(row.lastSmsError).toBe("provider_not_configured");
    expect(row.lastSmsRetryAt).toBeInstanceOf(Date);
    expect(row.smsRetryExhaustedAt).toBeNull();

    const reloaded = await loadAttempt(attempt.id);
    smsMock.mockClear();
    const next = await retryCoachPayoutSms({ attempt: reloaded });
    expect(next).toBeNull();
    expect(smsMock).not.toHaveBeenCalled();
  });
});

describe("retryCoachPayoutSms — ineligibility", () => {
  it("returns null without firing SMS when the row's smsStatus is no longer 'failed'", async () => {
    const { proId, userId } = await makePro({ withUser: true, phone: "+911234588005" });
    const payoutId = await makePayout(proId);
    const attempt = await makeAttempt({
      payoutId, proId, coachUserId: userId,
      smsStatus: "sent", smsAttempts: 1,
    });

    const res = await retryCoachPayoutSms({ attempt });
    expect(res).toBeNull();
    expect(smsMock).not.toHaveBeenCalled();
  });
});
