/**
 * Unit tests: Levy receipt push/SMS retry helpers (Task #247, coverage Task #286)
 *
 * Verifies the bounded retry helpers `retryLevyReceiptPush` and
 * `retryLevyReceiptSms` at the bottom of `levyReceiptNotify.ts`:
 *   - Happy path: a previously `failed` push/SMS retries successfully and the
 *     attempts row is updated with the new status, attempt count, and
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
 * DB is real so we exercise the same lookup/update path the cron does.
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
  clubMembersTable,
  memberLeviesTable,
  memberLevyChargesTable,
  memberLevyReceiptAttemptsTable,
  type MemberLevyReceiptAttempt,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  retryLevyReceiptPush,
  retryLevyReceiptSms,
  LEVY_RECEIPT_MAX_PUSH_ATTEMPTS,
  LEVY_RECEIPT_MAX_SMS_ATTEMPTS,
} from "../lib/levyReceiptNotify.js";
import { sendTransactionalPush, sendTransactionalSms } from "../lib/comms.js";

const pushMock = vi.mocked(sendTransactionalPush);
const smsMock = vi.mocked(sendTransactionalSms);

let testOrgId: number;
let testLevyId: number;
const memberIds: number[] = [];
const userIds: number[] = [];
const chargeIds: number[] = [];
const attemptIds: number[] = [];
let seq = 0;

async function makeAppUser(): Promise<number> {
  seq += 1;
  const tag = `${Date.now()}_${seq}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `levy-retry-test-${tag}`,
    username: `levy_retry_test_${tag}`,
  }).returning({ id: appUsersTable.id });
  userIds.push(u.id);
  return u.id;
}

async function makeMember(opts: {
  phone?: string | null;
  withUser?: boolean;
}): Promise<number> {
  const userId = opts.withUser ? await makeAppUser() : null;
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Retry",
    lastName: "Tester",
    email: null,
    phone: opts.phone ?? null,
    userId,
  }).returning({ id: clubMembersTable.id });
  memberIds.push(m.id);
  return m.id;
}

async function makeCharge(memberId: number): Promise<number> {
  const [c] = await db.insert(memberLevyChargesTable).values({
    levyId: testLevyId,
    clubMemberId: memberId,
    amount: "100.00",
    status: "paid",
    paidAmount: "100.00",
  }).returning({ id: memberLevyChargesTable.id });
  chargeIds.push(c.id);
  return c.id;
}

async function makeAttempt(opts: {
  memberId: number;
  chargeId: number;
  pushStatus?: string | null;
  pushAttempts?: number;
  smsStatus?: string | null;
  smsAttempts?: number;
}): Promise<MemberLevyReceiptAttempt> {
  const [a] = await db.insert(memberLevyReceiptAttemptsTable).values({
    organizationId: testOrgId,
    chargeId: opts.chargeId,
    clubMemberId: opts.memberId,
    kind: "payment",
    levyName: "Annual Subscription",
    currency: "INR",
    transactionAmount: "100.00",
    newBalance: "0.00",
    pushStatus: opts.pushStatus ?? null,
    pushAttempts: opts.pushAttempts ?? 0,
    smsStatus: opts.smsStatus ?? null,
    smsAttempts: opts.smsAttempts ?? 0,
  }).returning();
  attemptIds.push(a.id);
  return a;
}

async function loadAttempt(id: number): Promise<MemberLevyReceiptAttempt> {
  const [row] = await db.select().from(memberLevyReceiptAttemptsTable)
    .where(eq(memberLevyReceiptAttemptsTable.id, id));
  return row;
}

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_LevyRetry_${stamp}`,
    slug: `test-levy-retry-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [levy] = await db.insert(memberLeviesTable).values({
    organizationId: testOrgId,
    name: `Retry Test Levy ${stamp}`,
    amount: "100.00",
    currency: "INR",
    status: "applied",
    appliedAt: new Date(),
  }).returning({ id: memberLeviesTable.id });
  testLevyId = levy.id;
});

afterAll(async () => {
  for (const id of attemptIds) {
    await db.delete(memberLevyReceiptAttemptsTable)
      .where(eq(memberLevyReceiptAttemptsTable.id, id));
  }
  for (const id of chargeIds) {
    await db.delete(memberLevyChargesTable).where(eq(memberLevyChargesTable.id, id));
  }
  for (const id of memberIds) {
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, id));
  }
  for (const id of userIds) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, id));
  }
  await db.delete(memberLeviesTable).where(eq(memberLeviesTable.id, testLevyId));
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
// retryLevyReceiptPush
// ─────────────────────────────────────────────────────────────────────────
describe("retryLevyReceiptPush — happy path", () => {
  it("retries a previously-failed push, flips status to sent, increments attempts, stamps lastPushRetryAt", async () => {
    const memberId = await makeMember({ withUser: true });
    const chargeId = await makeCharge(memberId);
    const attempt = await makeAttempt({
      memberId,
      chargeId,
      pushStatus: "failed",
      pushAttempts: 1,
    });

    const before = Date.now();
    const res = await retryLevyReceiptPush({ attempt });
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

describe("retryLevyReceiptPush — bounded cap", () => {
  it("when attempts reach the cap and push still fails, stamps pushRetryExhaustedAt", async () => {
    const memberId = await makeMember({ withUser: true });
    const chargeId = await makeCharge(memberId);
    // One short of the cap so the next failed attempt hits it.
    const attempt = await makeAttempt({
      memberId,
      chargeId,
      pushStatus: "failed",
      pushAttempts: LEVY_RECEIPT_MAX_PUSH_ATTEMPTS - 1,
    });
    pushMock.mockRejectedValueOnce(new Error("fcm down"));

    const res = await retryLevyReceiptPush({ attempt });
    expect(res).not.toBeNull();
    expect(res!.status).toBe("failed");
    expect(res!.attempts).toBe(LEVY_RECEIPT_MAX_PUSH_ATTEMPTS);
    expect(res!.exhausted).toBe(true);

    const row = await loadAttempt(attempt.id);
    expect(row.pushStatus).toBe("failed");
    expect(row.pushAttempts).toBe(LEVY_RECEIPT_MAX_PUSH_ATTEMPTS);
    expect(row.pushRetryExhaustedAt).toBeInstanceOf(Date);
    expect(row.lastPushError).toBe("fcm down");

    // And on the very next cron pass for the same row, the helper short
    // circuits and returns null without hitting the provider again.
    pushMock.mockClear();
    const next = await retryLevyReceiptPush({ attempt: row });
    expect(next).toBeNull();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("subsequent retries return null once the cap has already been reached", async () => {
    const memberId = await makeMember({ withUser: true });
    const chargeId = await makeCharge(memberId);
    const attempt = await makeAttempt({
      memberId,
      chargeId,
      pushStatus: "failed",
      pushAttempts: LEVY_RECEIPT_MAX_PUSH_ATTEMPTS,
    });

    const res = await retryLevyReceiptPush({ attempt });
    expect(res).toBeNull();
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe("retryLevyReceiptPush — ineligibility", () => {
  it("returns null without firing push when the row's pushStatus is no longer 'failed'", async () => {
    const memberId = await makeMember({ withUser: true });
    const chargeId = await makeCharge(memberId);
    const attempt = await makeAttempt({
      memberId,
      chargeId,
      pushStatus: "sent",
      pushAttempts: 1,
    });

    const res = await retryLevyReceiptPush({ attempt });
    expect(res).toBeNull();
    expect(pushMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// retryLevyReceiptSms
// ─────────────────────────────────────────────────────────────────────────
describe("retryLevyReceiptSms — happy path", () => {
  it("retries a previously-failed SMS, flips status to sent, increments attempts, stamps lastSmsRetryAt", async () => {
    const memberId = await makeMember({ phone: "+911234599001" });
    const chargeId = await makeCharge(memberId);
    const attempt = await makeAttempt({
      memberId,
      chargeId,
      smsStatus: "failed",
      smsAttempts: 1,
    });

    const before = Date.now();
    const res = await retryLevyReceiptSms({ attempt });
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

describe("retryLevyReceiptSms — bounded cap", () => {
  it("when attempts reach the cap and SMS still fails, stamps smsRetryExhaustedAt", async () => {
    const memberId = await makeMember({ phone: "+911234599002" });
    const chargeId = await makeCharge(memberId);
    const attempt = await makeAttempt({
      memberId,
      chargeId,
      smsStatus: "failed",
      smsAttempts: LEVY_RECEIPT_MAX_SMS_ATTEMPTS - 1,
    });
    smsMock.mockRejectedValueOnce(new Error("twilio down"));

    const res = await retryLevyReceiptSms({ attempt });
    expect(res).not.toBeNull();
    expect(res!.status).toBe("failed");
    expect(res!.attempts).toBe(LEVY_RECEIPT_MAX_SMS_ATTEMPTS);
    expect(res!.exhausted).toBe(true);

    const row = await loadAttempt(attempt.id);
    expect(row.smsStatus).toBe("failed");
    expect(row.smsAttempts).toBe(LEVY_RECEIPT_MAX_SMS_ATTEMPTS);
    expect(row.smsRetryExhaustedAt).toBeInstanceOf(Date);
    expect(row.lastSmsError).toBe("twilio down");

    // And on the very next cron pass for the same row, the helper short
    // circuits and returns null without hitting the provider again.
    smsMock.mockClear();
    const next = await retryLevyReceiptSms({ attempt: row });
    expect(next).toBeNull();
    expect(smsMock).not.toHaveBeenCalled();
  });

  it("subsequent retries return null once the cap has already been reached", async () => {
    const memberId = await makeMember({ phone: "+911234599003" });
    const chargeId = await makeCharge(memberId);
    const attempt = await makeAttempt({
      memberId,
      chargeId,
      smsStatus: "failed",
      smsAttempts: LEVY_RECEIPT_MAX_SMS_ATTEMPTS,
    });

    const res = await retryLevyReceiptSms({ attempt });
    expect(res).toBeNull();
    expect(smsMock).not.toHaveBeenCalled();
  });
});

describe("retryLevyReceiptSms — provider not configured", () => {
  it("flips status to terminal 'skipped', does NOT increment smsAttempts, and stamps lastSmsRetryAt so the cron stops selecting it", async () => {
    const memberId = await makeMember({ phone: "+911234599004" });
    const chargeId = await makeCharge(memberId);
    const attempt = await makeAttempt({
      memberId,
      chargeId,
      smsStatus: "failed",
      smsAttempts: 2,
    });
    smsMock.mockRejectedValueOnce(new Error("SMS_PROVIDER not configured"));

    const res = await retryLevyReceiptSms({ attempt });
    expect(res).not.toBeNull();
    expect(res!.status).toBe("skipped");
    expect(res!.error).toBe("provider_not_configured");
    // Crucially: attempts is NOT incremented for the "provider unconfigured"
    // branch — it's an environment issue, not a delivery failure.
    expect(res!.attempts).toBe(2);
    expect(res!.exhausted).toBe(false);

    const row = await loadAttempt(attempt.id);
    expect(row.smsStatus).toBe("skipped");
    expect(row.smsAttempts).toBe(2);
    expect(row.lastSmsError).toBe("provider_not_configured");
    expect(row.lastSmsRetryAt).toBeInstanceOf(Date);
    expect(row.smsRetryExhaustedAt).toBeNull();

    // And on the next cron pass, the row is no longer eligible (status is
    // 'skipped', not 'failed'), so we return null without firing the provider.
    const reloaded = await loadAttempt(attempt.id);
    smsMock.mockClear();
    const next = await retryLevyReceiptSms({ attempt: reloaded });
    expect(next).toBeNull();
    expect(smsMock).not.toHaveBeenCalled();
  });
});

describe("retryLevyReceiptSms — ineligibility", () => {
  it("returns null without firing SMS when the row's smsStatus is no longer 'failed'", async () => {
    const memberId = await makeMember({ phone: "+911234599005" });
    const chargeId = await makeCharge(memberId);
    const attempt = await makeAttempt({
      memberId,
      chargeId,
      smsStatus: "sent",
      smsAttempts: 1,
    });

    const res = await retryLevyReceiptSms({ attempt });
    expect(res).toBeNull();
    expect(smsMock).not.toHaveBeenCalled();
  });
});
