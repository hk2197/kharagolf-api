/**
 * Integration tests: per-channel levy-receipt retry endpoint (Task #338,
 * coverage Task #504).
 *
 * Covers POST
 *   /api/organizations/:orgId/members-360/levies/:id/charges/:memberId/retry-receipt-channel
 *
 * The route is the convenience wrapper the AuditTab "Retry push" / "Retry SMS"
 * buttons fire — it resolves the latest member_levy_receipt_attempts row for
 * the (levy, member) charge and delegates to retryLevyReceiptPush /
 * retryLevyReceiptSms with body `{ channel: 'push' | 'sms' }`.
 *
 * Locks in:
 *   1. The endpoint targets the LATEST attempt for the charge (older attempts
 *      are not touched).
 *   2. Retrying push only increments pushAttempts; retrying SMS only
 *      increments smsAttempts (the other channel's counter is untouched).
 *   3. Channels that are no longer 'failed' return 409 (per-channel cap /
 *      eligibility gate).
 *   4. Unknown / missing channels are rejected with 400 before any DB / retry
 *      work happens.
 *   5. When the latest attempt's pushAttempts is one short of the cap and the
 *      provider keeps failing, the row gets pushRetryExhaustedAt stamped.
 *   6. Same exhaustion guarantee for SMS via smsRetryExhaustedAt.
 *
 * Comms is mocked so push/SMS calls are deterministic; everything else
 * (DB writes, audit log, requireMemberAdmin gate) runs against the real
 * PostgreSQL database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/comms.js", async () => ({
  sendTransactionalPush: vi.fn(async (userIds: number[]) => ({
    attempted: userIds.length,
    sent: userIds.length,
    failed: 0,
    invalid: 0,
  })),
  sendTransactionalSms: vi.fn(async () => undefined),
  sendTransactionalWhatsapp: vi.fn(async () => undefined),
  sendBroadcast: vi.fn(async () => undefined),
}));

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberLeviesTable,
  memberLevyChargesTable,
  memberLevyReceiptAttemptsTable,
  memberAuditLogTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  LEVY_RECEIPT_MAX_PUSH_ATTEMPTS,
  LEVY_RECEIPT_MAX_SMS_ATTEMPTS,
} from "../lib/levyReceiptNotify.js";
import { sendTransactionalPush, sendTransactionalSms } from "../lib/comms.js";
import { createTestApp, type TestUser } from "./helpers.js";

const pushMock = vi.mocked(sendTransactionalPush);
const smsMock = vi.mocked(sendTransactionalSms);

let orgId: number;
let adminUserId: number;
let admin: TestUser;
let app: ReturnType<typeof createTestApp>;

const memberIds: number[] = [];
const userIds: number[] = [];
const levyIds: number[] = [];
const chargeIds: number[] = [];
const attemptIds: number[] = [];
let seq = 0;

const URL = (levyId: number, memberId: number) =>
  `/api/organizations/${orgId}/members-360/levies/${levyId}/charges/${memberId}/retry-receipt-channel`;

async function makeMemberWithUser(opts: { phone?: string | null } = {}): Promise<number> {
  seq += 1;
  const tag = `${Date.now()}_${seq}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `retry-channel-${tag}`,
    username: `retry_channel_${tag}`,
  }).returning({ id: appUsersTable.id });
  userIds.push(u.id);
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    firstName: "Retry",
    lastName: "Channel",
    phone: opts.phone ?? "+911234500000",
    userId: u.id,
  }).returning({ id: clubMembersTable.id });
  memberIds.push(m.id);
  return m.id;
}

async function makeLevy(): Promise<number> {
  seq += 1;
  const [levy] = await db.insert(memberLeviesTable).values({
    organizationId: orgId,
    name: `Retry Channel Levy ${Date.now()}_${seq}`,
    amount: "100.00",
    currency: "INR",
    status: "applied",
    appliedAt: new Date(),
  }).returning({ id: memberLeviesTable.id });
  levyIds.push(levy.id);
  return levy.id;
}

async function makeCharge(levyId: number, memberId: number): Promise<number> {
  const [c] = await db.insert(memberLevyChargesTable).values({
    levyId, clubMemberId: memberId,
    amount: "100.00", status: "paid", paidAmount: "100.00",
  }).returning({ id: memberLevyChargesTable.id });
  chargeIds.push(c.id);
  return c.id;
}

async function makeAttempt(opts: {
  memberId: number; chargeId: number;
  pushStatus?: string | null; pushAttempts?: number;
  smsStatus?: string | null; smsAttempts?: number;
  createdAt?: Date;
}): Promise<number> {
  const [a] = await db.insert(memberLevyReceiptAttemptsTable).values({
    organizationId: orgId,
    chargeId: opts.chargeId,
    clubMemberId: opts.memberId,
    kind: "payment",
    levyName: "Retry Channel",
    currency: "INR",
    transactionAmount: "100.00",
    newBalance: "0.00",
    pushStatus: opts.pushStatus ?? null,
    pushAttempts: opts.pushAttempts ?? 0,
    smsStatus: opts.smsStatus ?? null,
    smsAttempts: opts.smsAttempts ?? 0,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  }).returning({ id: memberLevyReceiptAttemptsTable.id });
  attemptIds.push(a.id);
  return a.id;
}

async function loadAttempt(id: number) {
  const [row] = await db.select().from(memberLevyReceiptAttemptsTable)
    .where(eq(memberLevyReceiptAttemptsTable.id, id));
  return row;
}

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_RetryChannel_${stamp}`,
    slug: `test-retry-channel-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `retry-channel-admin-${stamp}`,
    username: `retry_channel_admin_${stamp}`,
    email: `retry_channel_admin_${stamp}@example.com`,
    displayName: "Retry Channel Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  admin = {
    id: adminUserId,
    username: `retry_channel_admin_${stamp}`,
    displayName: "Retry Channel Admin",
    role: "org_admin",
    organizationId: orgId,
  };
  app = createTestApp(admin);
});

afterAll(async () => {
  if (attemptIds.length) {
    await db.delete(memberLevyReceiptAttemptsTable)
      .where(inArray(memberLevyReceiptAttemptsTable.id, attemptIds));
  }
  if (chargeIds.length) {
    await db.delete(memberLevyChargesTable).where(inArray(memberLevyChargesTable.id, chargeIds));
  }
  if (memberIds.length) {
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.clubMemberId, memberIds));
    await db.delete(clubMembersTable).where(inArray(clubMembersTable.id, memberIds));
  }
  if (userIds.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  }
  if (levyIds.length) {
    await db.delete(memberLeviesTable).where(inArray(memberLeviesTable.id, levyIds));
  }
  if (adminUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(() => {
  pushMock.mockReset();
  smsMock.mockReset();
  pushMock.mockImplementation(async (uids: number[]) => ({
    attempted: uids.length, sent: uids.length, failed: 0, invalid: 0,
  }));
  smsMock.mockResolvedValue(undefined);
});

describe("POST /levies/:id/charges/:memberId/retry-receipt-channel — bad input", () => {
  it("rejects unknown channel with 400 without firing any provider call", async () => {
    const memberId = await makeMemberWithUser();
    const levyId = await makeLevy();
    const chargeId = await makeCharge(levyId, memberId);
    await makeAttempt({ memberId, chargeId, pushStatus: "failed", pushAttempts: 1 });

    const res = await request(app).post(URL(levyId, memberId)).send({ channel: "email" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/push.*sms/i);
    expect(pushMock).not.toHaveBeenCalled();
    expect(smsMock).not.toHaveBeenCalled();
  });

  it("rejects missing channel with 400", async () => {
    const memberId = await makeMemberWithUser();
    const levyId = await makeLevy();
    const chargeId = await makeCharge(levyId, memberId);
    await makeAttempt({ memberId, chargeId, pushStatus: "failed", pushAttempts: 1 });

    const res = await request(app).post(URL(levyId, memberId)).send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 when the charge has no receipt attempt yet", async () => {
    const memberId = await makeMemberWithUser();
    const levyId = await makeLevy();
    await makeCharge(levyId, memberId);

    const res = await request(app).post(URL(levyId, memberId)).send({ channel: "push" });
    expect(res.status).toBe(404);
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe("POST /levies/:id/charges/:memberId/retry-receipt-channel — targets latest attempt", () => {
  it("only retries the most-recent attempt for the charge (older attempts untouched)", async () => {
    const memberId = await makeMemberWithUser();
    const levyId = await makeLevy();
    const chargeId = await makeCharge(levyId, memberId);
    // Older attempt (also failed) — must NOT be touched.
    const olderAt = new Date(Date.now() - 60_000);
    const olderId = await makeAttempt({
      memberId, chargeId,
      pushStatus: "failed", pushAttempts: 2,
      createdAt: olderAt,
    });
    // Newer / latest attempt — this is the one the route should retry.
    const latestId = await makeAttempt({
      memberId, chargeId,
      pushStatus: "failed", pushAttempts: 1,
    });

    const res = await request(app).post(URL(levyId, memberId)).send({ channel: "push" });
    expect(res.status).toBe(200);
    expect(res.body.attempt.id).toBe(latestId);
    expect(res.body.result.channel).toBe("push");
    expect(res.body.result.status).toBe("sent");

    const latestRow = await loadAttempt(latestId);
    expect(latestRow.pushStatus).toBe("sent");
    expect(latestRow.pushAttempts).toBe(2);

    const olderRow = await loadAttempt(olderId);
    expect(olderRow.pushStatus).toBe("failed");
    expect(olderRow.pushAttempts).toBe(2); // unchanged
  });
});

describe("POST /levies/:id/charges/:memberId/retry-receipt-channel — per-channel counters", () => {
  it("retrying push only increments pushAttempts (smsAttempts untouched)", async () => {
    const memberId = await makeMemberWithUser();
    const levyId = await makeLevy();
    const chargeId = await makeCharge(levyId, memberId);
    const attemptId = await makeAttempt({
      memberId, chargeId,
      pushStatus: "failed", pushAttempts: 1,
      smsStatus: "failed", smsAttempts: 2,
    });

    const res = await request(app).post(URL(levyId, memberId)).send({ channel: "push" });
    expect(res.status).toBe(200);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(smsMock).not.toHaveBeenCalled();

    const row = await loadAttempt(attemptId);
    expect(row.pushAttempts).toBe(2);
    expect(row.pushStatus).toBe("sent");
    // SMS counter / status must remain exactly as seeded.
    expect(row.smsAttempts).toBe(2);
    expect(row.smsStatus).toBe("failed");
  });

  it("retrying sms only increments smsAttempts (pushAttempts untouched)", async () => {
    const memberId = await makeMemberWithUser({ phone: "+911234500111" });
    const levyId = await makeLevy();
    const chargeId = await makeCharge(levyId, memberId);
    const attemptId = await makeAttempt({
      memberId, chargeId,
      pushStatus: "failed", pushAttempts: 2,
      smsStatus: "failed", smsAttempts: 1,
    });

    const res = await request(app).post(URL(levyId, memberId)).send({ channel: "sms" });
    expect(res.status).toBe(200);
    expect(smsMock).toHaveBeenCalledTimes(1);
    expect(pushMock).not.toHaveBeenCalled();

    const row = await loadAttempt(attemptId);
    expect(row.smsAttempts).toBe(2);
    expect(row.smsStatus).toBe("sent");
    expect(row.pushAttempts).toBe(2);
    expect(row.pushStatus).toBe("failed");
  });
});

describe("POST /levies/:id/charges/:memberId/retry-receipt-channel — eligibility gate (409)", () => {
  it("returns 409 when the targeted channel is no longer 'failed'", async () => {
    const memberId = await makeMemberWithUser();
    const levyId = await makeLevy();
    const chargeId = await makeCharge(levyId, memberId);
    const attemptId = await makeAttempt({
      memberId, chargeId,
      pushStatus: "sent", pushAttempts: 1, // already delivered
    });

    const res = await request(app).post(URL(levyId, memberId)).send({ channel: "push" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not eligible/i);
    expect(pushMock).not.toHaveBeenCalled();

    // Row stays exactly as it was.
    const row = await loadAttempt(attemptId);
    expect(row.pushStatus).toBe("sent");
    expect(row.pushAttempts).toBe(1);
  });

  it("returns 409 when the per-channel attempt cap has already been reached", async () => {
    const memberId = await makeMemberWithUser();
    const levyId = await makeLevy();
    const chargeId = await makeCharge(levyId, memberId);
    await makeAttempt({
      memberId, chargeId,
      pushStatus: "failed", pushAttempts: LEVY_RECEIPT_MAX_PUSH_ATTEMPTS,
    });

    const res = await request(app).post(URL(levyId, memberId)).send({ channel: "push" });
    expect(res.status).toBe(409);
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe("POST /levies/:id/charges/:memberId/retry-receipt-channel — exhaustion stamping", () => {
  it("stamps pushRetryExhaustedAt when push hits the cap on a failure", async () => {
    const memberId = await makeMemberWithUser();
    const levyId = await makeLevy();
    const chargeId = await makeCharge(levyId, memberId);
    const attemptId = await makeAttempt({
      memberId, chargeId,
      pushStatus: "failed", pushAttempts: LEVY_RECEIPT_MAX_PUSH_ATTEMPTS - 1,
    });
    pushMock.mockRejectedValueOnce(new Error("fcm down"));

    const res = await request(app).post(URL(levyId, memberId)).send({ channel: "push" });
    expect(res.status).toBe(200);
    expect(res.body.result.exhausted).toBe(true);
    expect(res.body.result.attempts).toBe(LEVY_RECEIPT_MAX_PUSH_ATTEMPTS);

    const row = await loadAttempt(attemptId);
    expect(row.pushAttempts).toBe(LEVY_RECEIPT_MAX_PUSH_ATTEMPTS);
    expect(row.pushStatus).toBe("failed");
    expect(row.pushRetryExhaustedAt).toBeInstanceOf(Date);
    expect(row.smsRetryExhaustedAt).toBeNull(); // other channel never touched
  });

  it("stamps smsRetryExhaustedAt when SMS hits the cap on a failure", async () => {
    const memberId = await makeMemberWithUser({ phone: "+911234500222" });
    const levyId = await makeLevy();
    const chargeId = await makeCharge(levyId, memberId);
    const attemptId = await makeAttempt({
      memberId, chargeId,
      smsStatus: "failed", smsAttempts: LEVY_RECEIPT_MAX_SMS_ATTEMPTS - 1,
    });
    smsMock.mockRejectedValueOnce(new Error("twilio down"));

    const res = await request(app).post(URL(levyId, memberId)).send({ channel: "sms" });
    expect(res.status).toBe(200);
    expect(res.body.result.exhausted).toBe(true);
    expect(res.body.result.attempts).toBe(LEVY_RECEIPT_MAX_SMS_ATTEMPTS);

    const row = await loadAttempt(attemptId);
    expect(row.smsAttempts).toBe(LEVY_RECEIPT_MAX_SMS_ATTEMPTS);
    expect(row.smsStatus).toBe("failed");
    expect(row.smsRetryExhaustedAt).toBeInstanceOf(Date);
    expect(row.pushRetryExhaustedAt).toBeNull();
  });
});
