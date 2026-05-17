/**
 * Task #1109 — Replayed Razorpay payout webhook must not double-notify.
 *
 * The /api/webhooks/razorpay-payout handler fires member-facing
 * notifications only when markWithdrawalProcessed / markWithdrawalFailed
 * report transitioned=true. The unit tests already cover those helpers
 * directly; this test exercises the route end-to-end by POSTing the same
 * signed Razorpay webhook payload twice and asserting that exactly one
 * inbox row is recorded and the push channel is invoked exactly once
 * for the affected member.
 *
 * Coverage spans the three terminal events:
 *   - payout.processed
 *   - payout.failed
 *   - payout.reversed
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

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
    sendPushToUsers: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 })),
  };
});

import crypto from "node:crypto";
import express, { type Request } from "express";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  clubWalletsTable,
  clubWalletTxnsTable,
  walletPayoutAccountsTable,
  clubWalletWithdrawalsTable,
  memberMessagesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import router from "../routes/index.js";
import { debitWalletForWithdrawal } from "../lib/walletPayouts.js";
import {
  sendWalletWithdrawalProcessedEmail,
  sendWalletWithdrawalFailedEmail,
} from "../lib/mailer.js";
import { sendPushToUsers } from "../lib/push.js";

const processedEmailMock = vi.mocked(sendWalletWithdrawalProcessedEmail);
const failedEmailMock = vi.mocked(sendWalletWithdrawalFailedEmail);
const pushMock = vi.mocked(sendPushToUsers);

const WEBHOOK_SECRET = "t1109_payout_secret";

function buildWebhookApp() {
  const app = express();
  // Mirror app.ts so the route's HMAC verification sees the exact bytes.
  app.use(
    express.json({
      verify: (req: Request, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use("/api", router);
  return app;
}

const app = buildWebhookApp();

let orgId: number;
let userId: number;
let walletId: number;
let payoutAccountId: number;
let clubMemberId: number;
let prevSecret: string | undefined;
let prevSecretFallback: string | undefined;
let prevNodeEnv: string | undefined;

beforeAll(async () => {
  prevSecret = process.env.RAZORPAYX_WEBHOOK_SECRET;
  prevSecretFallback = process.env.RAZORPAY_WEBHOOK_SECRET;
  prevNodeEnv = process.env.NODE_ENV;
  process.env.RAZORPAYX_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.NODE_ENV = "test";

  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `T1109-${ts}`, slug: `t1109-${ts}`, contactEmail: `t1109-${ts}@example.test`,
  }).returning();
  orgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `ep_t1109_${ts}`,
    username: `t1109_user_${ts}`,
    email: `t1109_${ts}@example.test`,
    displayName: "Replay Member",
    role: "player",
    organizationId: orgId,
  }).returning();
  userId = user.id;

  const [cm] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId,
    firstName: "Replay",
    lastName: "Member",
    email: `t1109_${ts}@example.test`,
  }).returning();
  clubMemberId = cm.id;

  const [w] = await db.insert(clubWalletsTable).values({
    organizationId: orgId, userId, currency: "INR", balance: "10000.00",
  }).returning();
  walletId = w.id;
  await db.insert(clubWalletTxnsTable).values({
    walletId: w.id, kind: "credit", amount: "10000.00", currency: "INR",
    sourceType: "test_seed", balanceAfter: "10000.00",
  });

  const [acct] = await db.insert(walletPayoutAccountsTable).values({
    organizationId: orgId, userId, method: "upi",
    accountHolderName: "Replay Member", upiVpa: "replay@upi",
    razorpayContactId: "cont_t1109", razorpayFundAccountId: "fa_t1109",
  }).returning();
  payoutAccountId = acct.id;
});

afterAll(async () => {
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, orgId));
  await db.delete(clubWalletWithdrawalsTable).where(eq(clubWalletWithdrawalsTable.organizationId, orgId));
  await db.delete(walletPayoutAccountsTable).where(eq(walletPayoutAccountsTable.organizationId, orgId));
  await db.delete(clubWalletTxnsTable).where(inArray(clubWalletTxnsTable.walletId, [walletId]));
  await db.delete(clubWalletsTable).where(eq(clubWalletsTable.organizationId, orgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, orgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  void clubMemberId; // referenced for cleanup symmetry with the sibling test

  if (prevSecret === undefined) delete process.env.RAZORPAYX_WEBHOOK_SECRET;
  else process.env.RAZORPAYX_WEBHOOK_SECRET = prevSecret;
  if (prevSecretFallback === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
  else process.env.RAZORPAY_WEBHOOK_SECRET = prevSecretFallback;
  if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevNodeEnv;
});

beforeEach(() => {
  processedEmailMock.mockClear();
  failedEmailMock.mockClear();
  pushMock.mockClear();
});

async function newWithdrawal(amount: number) {
  return debitWalletForWithdrawal({
    walletId, organizationId: orgId, userId, amount, currency: "INR",
    method: "upi", payoutAccountId, razorpayFundAccountId: "fa_t1109",
  });
}

function payoutEvent(opts: {
  event: "payout.processed" | "payout.failed" | "payout.reversed";
  status: "processed" | "failed" | "reversed";
  withdrawalId: number;
  payoutId: string;
  utr?: string;
  failureReason?: string;
}) {
  return {
    event: opts.event,
    payload: {
      payout: {
        entity: {
          id: opts.payoutId,
          reference_id: `walletwd_${opts.withdrawalId}`,
          status: opts.status,
          utr: opts.utr ?? null,
          failure_reason: opts.failureReason ?? null,
        },
      },
    },
  };
}

function sign(body: unknown): { raw: string; signature: string } {
  const raw = JSON.stringify(body);
  const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  return { raw, signature };
}

async function postSigned(body: unknown) {
  const { raw, signature } = sign(body);
  return request(app)
    .post("/api/webhooks/razorpay-payout")
    .set("Content-Type", "application/json")
    .set("x-razorpay-signature", signature)
    .send(raw);
}

async function countInboxRows(withdrawalId: number) {
  const rows = await db.select().from(memberMessagesTable).where(and(
    eq(memberMessagesTable.organizationId, orgId),
    eq(memberMessagesTable.relatedEntity, "wallet_withdrawal"),
    eq(memberMessagesTable.relatedEntityId, withdrawalId),
  ));
  return rows.length;
}

// The webhook fires notifyWithdrawal* in the background (`.catch(...)`)
// after responding 200. Poll briefly so assertions run after the inbox
// insert + push attempt have settled, without baking in a flaky timeout.
async function waitForInboxRow(withdrawalId: number, atLeast: number, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await countInboxRows(withdrawalId)) >= atLeast) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("Task #1109 — replayed Razorpay payout webhook never double-notifies", () => {
  it("payout.processed: posting the same payload twice yields exactly one inbox row + one push", async () => {
    const r = await newWithdrawal(500);
    const body = payoutEvent({
      event: "payout.processed",
      status: "processed",
      withdrawalId: r.withdrawalId,
      payoutId: `pout_t1109_p_${r.withdrawalId}`,
      utr: "UTR-T1109-P",
    });

    const r1 = await postSigned(body);
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ walletWithdrawal: true, applied: "processed" });
    await waitForInboxRow(r.withdrawalId, 1);

    const r2 = await postSigned(body);
    expect(r2.status).toBe(200);
    // Second delivery short-circuits because the row is already `processed`.
    expect(r2.body).toMatchObject({ walletWithdrawal: true, alreadyProcessed: true });

    // Give any (stray) background handler from the replay a chance to run.
    await new Promise((res) => setTimeout(res, 100));

    expect(await countInboxRows(r.withdrawalId)).toBe(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock.mock.calls[0]![0]).toEqual([userId]);
    expect(processedEmailMock).toHaveBeenCalledTimes(1);
  });

  it("payout.failed: posting the same payload twice yields exactly one inbox row + one push", async () => {
    const r = await newWithdrawal(750);
    const body = payoutEvent({
      event: "payout.failed",
      status: "failed",
      withdrawalId: r.withdrawalId,
      payoutId: `pout_t1109_f_${r.withdrawalId}`,
      failureReason: "Beneficiary bank rejected",
    });

    const r1 = await postSigned(body);
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ walletWithdrawal: true, applied: "failed" });
    await waitForInboxRow(r.withdrawalId, 1);

    const r2 = await postSigned(body);
    expect(r2.status).toBe(200);
    // After failure the row is refunded; the second delivery sees a
    // non-pending row and markWithdrawalFailed returns transitioned=false,
    // so the route still applies "failed" but skips the notification.
    expect(r2.body).toMatchObject({ walletWithdrawal: true, applied: "failed" });

    await new Promise((res) => setTimeout(res, 100));

    expect(await countInboxRows(r.withdrawalId)).toBe(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock.mock.calls[0]![0]).toEqual([userId]);
    expect(failedEmailMock).toHaveBeenCalledTimes(1);
  });

  it("payout.reversed: posting the same payload twice yields exactly one inbox row + one push", async () => {
    const r = await newWithdrawal(620);
    const body = payoutEvent({
      event: "payout.reversed",
      status: "reversed",
      withdrawalId: r.withdrawalId,
      payoutId: `pout_t1109_r_${r.withdrawalId}`,
      failureReason: "Bank reversed payout",
    });

    const r1 = await postSigned(body);
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ walletWithdrawal: true, applied: "reversed" });
    await waitForInboxRow(r.withdrawalId, 1);

    const r2 = await postSigned(body);
    expect(r2.status).toBe(200);
    expect(r2.body).toMatchObject({ walletWithdrawal: true, applied: "reversed" });

    await new Promise((res) => setTimeout(res, 100));

    expect(await countInboxRows(r.withdrawalId)).toBe(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock.mock.calls[0]![0]).toEqual([userId]);
    expect(failedEmailMock).toHaveBeenCalledTimes(1);
  });
});
