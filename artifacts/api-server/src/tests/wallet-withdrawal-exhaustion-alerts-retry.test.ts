/**
 * Integration test: Admin retry action for retry-exhausted wallet
 * withdrawal alerts (Task #1857).
 *
 * Covers:
 *   - POST /api/admin/wallet-withdrawal-exhaustion-alerts/:attemptId/retry
 *
 * The route resets every previously-exhausted channel on the attempts
 * row and immediately re-runs the per-channel retry helper. On a
 * successful re-dispatch (any channel `sent`) the row is also stamped
 * `adminFollowupAcknowledgedAt` so it drops off the worklist — mirrors
 * the "row drops off the list (just like acknowledge)" contract from
 * the task description.
 *
 * Email + push are mocked so the suite can deterministically force a
 * `sent` outcome (member contact info corrected) or a `failed` outcome
 * (still bouncing) without standing up a mail / push provider.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendWalletWithdrawalProcessedEmail: vi.fn(async () => undefined),
    sendWalletWithdrawalFailedEmail: vi.fn(async () => undefined),
  };
});
vi.mock("../lib/push.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/push.js")>();
  return {
    ...actual,
    sendPushToUsers: vi.fn(async () => ({ attempted: 1, sent: 1, failed: 0, invalid: 0 })),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  clubWalletsTable,
  clubWalletWithdrawalsTable,
  walletWithdrawalNotifyAttemptsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  sendWalletWithdrawalProcessedEmail,
  sendWalletWithdrawalFailedEmail,
} from "../lib/mailer.js";
import { sendPushToUsers } from "../lib/push.js";
import { createTestApp, type TestUser } from "./helpers.js";

const processedEmailMock = vi.mocked(sendWalletWithdrawalProcessedEmail);
const failedEmailMock = vi.mocked(sendWalletWithdrawalFailedEmail);
const pushMock = vi.mocked(sendPushToUsers);

let testOrgId: number;
let testWalletId: number;
let admin: TestUser;
let app: ReturnType<typeof createTestApp>;
let nonAdminApp: ReturnType<typeof createTestApp>;
let memberUserId: number;

const withdrawalIds: number[] = [];
const attemptIds: number[] = [];
const userIds: number[] = [];
const memberIds: number[] = [];
let seq = 0;

async function makeUser(opts: { displayName?: string; email?: string } = {}): Promise<number> {
  seq += 1;
  const tag = `${Date.now()}_${seq}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `wd-exh-retry-${tag}`,
    username: `wd_exh_retry_${tag}`,
    displayName: opts.displayName ?? null,
    email: opts.email ?? null,
  }).returning({ id: appUsersTable.id });
  userIds.push(u.id);
  return u.id;
}

async function makeMember(userId: number, opts: {
  firstName?: string;
  lastName?: string;
  email?: string;
} = {}): Promise<void> {
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    userId,
    firstName: opts.firstName ?? "Test",
    lastName: opts.lastName ?? "Member",
    email: opts.email ?? null,
  }).returning({ id: clubMembersTable.id });
  memberIds.push(m.id);
}

async function makeWithdrawal(userId: number): Promise<number> {
  const [w] = await db.insert(clubWalletWithdrawalsTable).values({
    walletId: testWalletId,
    organizationId: testOrgId,
    userId,
    amount: "750.00",
    currency: "INR",
    method: "upi",
    status: "processed",
  }).returning({ id: clubWalletWithdrawalsTable.id });
  withdrawalIds.push(w.id);
  return w.id;
}

async function makeAttempt(opts: {
  withdrawalId: number;
  userId: number;
  outcome?: string;
  adminExhaustionNotifiedAt?: Date | null;
  adminFollowupAcknowledgedAt?: Date | null;
  emailRetryExhaustedAt?: Date | null;
  pushRetryExhaustedAt?: Date | null;
  lastEmailError?: string | null;
  lastPushError?: string | null;
}): Promise<number> {
  const [a] = await db.insert(walletWithdrawalNotifyAttemptsTable).values({
    withdrawalId: opts.withdrawalId,
    organizationId: testOrgId,
    userId: opts.userId,
    outcome: opts.outcome ?? "processed",
    amount: "750.00",
    currency: "INR",
    destination: "UPI ****9999",
    emailStatus: opts.emailRetryExhaustedAt ? "failed" : "sent",
    emailAttempts: opts.emailRetryExhaustedAt ? 5 : 1,
    emailRetryExhaustedAt: opts.emailRetryExhaustedAt ?? null,
    lastEmailError: opts.lastEmailError ?? null,
    pushStatus: opts.pushRetryExhaustedAt ? "failed" : "sent",
    pushAttempts: opts.pushRetryExhaustedAt ? 5 : 1,
    pushRetryExhaustedAt: opts.pushRetryExhaustedAt ?? null,
    lastPushError: opts.lastPushError ?? null,
    adminExhaustionNotifiedAt: opts.adminExhaustionNotifiedAt ?? null,
    adminFollowupAcknowledgedAt: opts.adminFollowupAcknowledgedAt ?? null,
  }).returning({ id: walletWithdrawalNotifyAttemptsTable.id });
  attemptIds.push(a.id);
  return a.id;
}

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_WdExhRetry_${stamp}`,
    slug: `test-wd-exh-retry-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const adminId = await makeUser({ displayName: "Admin User" });
  admin = {
    id: adminId,
    username: "admin",
    role: "org_admin",
    organizationId: testOrgId,
  };
  app = createTestApp(admin);

  const nonAdminId = await makeUser({ displayName: "Member User" });
  nonAdminApp = createTestApp({
    id: nonAdminId,
    username: "member",
    role: "player",
    organizationId: testOrgId,
  });

  memberUserId = await makeUser({ displayName: "Wallet Owner", email: "wallet@test.example" });
  await makeMember(memberUserId, {
    firstName: "Wallet",
    lastName: "Owner",
    email: "member@test.example",
  });

  const [wallet] = await db.insert(clubWalletsTable).values({
    organizationId: testOrgId,
    userId: memberUserId,
    currency: "INR",
    balance: "0.00",
  }).returning({ id: clubWalletsTable.id });
  testWalletId = wallet.id;
});

afterAll(async () => {
  for (const id of attemptIds) {
    await db.delete(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, id));
  }
  for (const id of withdrawalIds) {
    await db.delete(clubWalletWithdrawalsTable)
      .where(eq(clubWalletWithdrawalsTable.id, id));
  }
  await db.delete(clubWalletsTable).where(eq(clubWalletsTable.id, testWalletId));
  for (const id of memberIds) {
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, id));
  }
  for (const id of userIds) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, id));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(async () => {
  for (const id of attemptIds.splice(0)) {
    await db.delete(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, id));
  }
  for (const id of withdrawalIds.splice(0)) {
    await db.delete(clubWalletWithdrawalsTable)
      .where(eq(clubWalletWithdrawalsTable.id, id));
  }
  processedEmailMock.mockReset();
  failedEmailMock.mockReset();
  pushMock.mockReset();
  // Default both back to a `sent` outcome — individual tests override.
  processedEmailMock.mockImplementation(async () => undefined);
  failedEmailMock.mockImplementation(async () => undefined);
  pushMock.mockImplementation(async () => ({ attempted: 1, sent: 1, failed: 0, invalid: 0 }));
});

describe("POST /api/admin/wallet-withdrawal-exhaustion-alerts/:attemptId/retry", () => {
  it("rejects non-admins with 403", async () => {
    const wd = await makeWithdrawal(memberUserId);
    const id = await makeAttempt({
      withdrawalId: wd,
      userId: memberUserId,
      emailRetryExhaustedAt: new Date(),
      adminExhaustionNotifiedAt: new Date(),
    });
    const res = await request(nonAdminApp)
      .post(`/api/admin/wallet-withdrawal-exhaustion-alerts/${id}/retry`);
    expect(res.status).toBe(403);
  });

  it("400s on a non-numeric attemptId", async () => {
    const res = await request(app)
      .post("/api/admin/wallet-withdrawal-exhaustion-alerts/not-a-number/retry");
    expect(res.status).toBe(400);
  });

  it("404s for an unknown attempt", async () => {
    const res = await request(app)
      .post("/api/admin/wallet-withdrawal-exhaustion-alerts/999999999/retry");
    expect(res.status).toBe(404);
  });

  it("409s if the row was never alerted to admins", async () => {
    const wd = await makeWithdrawal(memberUserId);
    const id = await makeAttempt({
      withdrawalId: wd,
      userId: memberUserId,
      adminExhaustionNotifiedAt: null,
    });
    const res = await request(app)
      .post(`/api/admin/wallet-withdrawal-exhaustion-alerts/${id}/retry`);
    expect(res.status).toBe(409);
  });

  it("409s if the row has already been acknowledged", async () => {
    const wd = await makeWithdrawal(memberUserId);
    const id = await makeAttempt({
      withdrawalId: wd,
      userId: memberUserId,
      emailRetryExhaustedAt: new Date(),
      adminExhaustionNotifiedAt: new Date(),
      adminFollowupAcknowledgedAt: new Date(),
    });
    const res = await request(app)
      .post(`/api/admin/wallet-withdrawal-exhaustion-alerts/${id}/retry`);
    expect(res.status).toBe(409);
  });

  it("re-dispatches a successful email retry, clears exhaustion stamps, and acknowledges the row", async () => {
    const wd = await makeWithdrawal(memberUserId);
    const id = await makeAttempt({
      withdrawalId: wd,
      userId: memberUserId,
      emailRetryExhaustedAt: new Date(),
      lastEmailError: "550 mailbox not found",
      adminExhaustionNotifiedAt: new Date(),
    });

    // Sanity: row is on the worklist before the retry.
    const before = await request(app)
      .get(`/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}`);
    expect(before.body.count).toBe(1);

    const res = await request(app)
      .post(`/api/admin/wallet-withdrawal-exhaustion-alerts/${id}/retry`);
    expect(res.status).toBe(200);
    expect(res.body.anySent).toBe(true);
    expect(res.body.email).toMatchObject({ attempted: true, status: "sent", exhausted: false });
    expect(res.body.push).toEqual({ attempted: false });
    expect(res.body.acknowledgedAt).toBeTruthy();
    expect(res.body.acknowledgedBy).toBe(admin.id);

    // Email mailer was actually invoked once via the per-channel retry
    // helper (i.e. we went through the existing notify pipeline, not
    // a side-channel).
    expect(processedEmailMock).toHaveBeenCalledTimes(1);

    const [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, id));
    expect(row.emailStatus).toBe("sent");
    expect(row.emailRetryExhaustedAt).toBeNull();
    // Reset to 0 then bumped to 1 by the per-channel retry helper.
    expect(row.emailAttempts).toBe(1);
    expect(row.adminFollowupAcknowledgedAt).toBeTruthy();
    expect(row.adminFollowupAcknowledgedBy).toBe(admin.id);

    // Row drops off the worklist after a successful retry — exactly
    // what the task says should happen "(just like acknowledge)".
    const after = await request(app)
      .get(`/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}`);
    expect(after.body.count).toBe(0);
  });

  it("re-dispatches both email and push when both channels are exhausted", async () => {
    const wd = await makeWithdrawal(memberUserId);
    const id = await makeAttempt({
      withdrawalId: wd,
      userId: memberUserId,
      emailRetryExhaustedAt: new Date(),
      pushRetryExhaustedAt: new Date(),
      adminExhaustionNotifiedAt: new Date(),
      outcome: "failed",
    });

    const res = await request(app)
      .post(`/api/admin/wallet-withdrawal-exhaustion-alerts/${id}/retry`);
    expect(res.status).toBe(200);
    expect(res.body.anySent).toBe(true);
    expect(res.body.email).toMatchObject({ attempted: true, status: "sent" });
    expect(res.body.push).toMatchObject({ attempted: true, status: "sent" });
    expect(failedEmailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);

    const [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, id));
    expect(row.emailRetryExhaustedAt).toBeNull();
    expect(row.pushRetryExhaustedAt).toBeNull();
    expect(row.adminFollowupAcknowledgedAt).toBeTruthy();
  });

  it("on a no-op retry the row stays on the worklist (no acknowledge stamp)", async () => {
    // Force the email retry helper's mailer call to fail again so the
    // re-dispatch produces status=failed instead of sent.
    processedEmailMock.mockImplementation(async () => {
      throw new Error("connect ETIMEDOUT");
    });

    const wd = await makeWithdrawal(memberUserId);
    const id = await makeAttempt({
      withdrawalId: wd,
      userId: memberUserId,
      emailRetryExhaustedAt: new Date(),
      adminExhaustionNotifiedAt: new Date(),
    });

    const res = await request(app)
      .post(`/api/admin/wallet-withdrawal-exhaustion-alerts/${id}/retry`);
    expect(res.status).toBe(200);
    expect(res.body.anySent).toBe(false);
    expect(res.body.email).toMatchObject({ attempted: true, status: "failed" });
    expect(res.body.acknowledgedAt).toBeNull();

    const [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.id, id));
    // Row is NOT acknowledged because the retry didn't actually
    // re-deliver — it stays on the worklist so the admin can fix the
    // underlying issue and try again or manually mark it followed up.
    expect(row.adminFollowupAcknowledgedAt).toBeNull();
    // Worklist still surfaces the row.
    const list = await request(app)
      .get(`/api/admin/wallet-withdrawal-exhaustion-alerts?organizationId=${testOrgId}`);
    expect(list.body.count).toBe(1);
  });
});
