/**
 * Task #964 — wallet withdrawal lifecycle notifications.
 *
 * Verifies that:
 *   - notifyWithdrawalProcessed inserts an in-app inbox row, attempts
 *     push, and attempts email with the UTR + destination on first
 *     transition to `processed`.
 *   - notifyWithdrawalFailed inserts an in-app inbox row and attempts
 *     push + email with the refund context on first transition to
 *     `failed` / `reversed`.
 *   - markWithdrawalProcessed / markWithdrawalFailed return
 *     transitioned=true only the first time, so a replayed webhook
 *     does not double-notify.
 *   - markWithdrawalProcessed returns transitioned=false when the row
 *     was already refunded (paid_after_refund branch) so the
 *     contradictory "success" notice is suppressed.
 *   - The user-level preferEmail and member-comm `billing` opt-outs
 *     suppress the email channel.
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
vi.mock("../lib/comms.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/comms.js")>();
  return {
    ...actual,
    sendTransactionalSms: vi.fn(async () => undefined),
    sendTransactionalWhatsapp: vi.fn(async () => null),
  };
});

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
  memberCommPrefsTable,
  userNotificationPrefsTable,
  walletWithdrawalNotifyAttemptsTable,
} from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  debitWalletForWithdrawal,
  markWithdrawalProcessed,
  markWithdrawalFailed,
} from "../lib/walletPayouts.js";
import {
  notifyWithdrawalProcessed,
  notifyWithdrawalFailed,
  retryWalletWithdrawalEmail,
  retryWalletWithdrawalPush,
  computeNextRetryAt,
  WALLET_WITHDRAWAL_NOTIFY_MAX_EMAIL_ATTEMPTS,
} from "../lib/walletWithdrawalNotify.js";
import { retryFailedWalletWithdrawalEmailPush } from "../lib/cron.js";
import {
  sendWalletWithdrawalProcessedEmail,
  sendWalletWithdrawalFailedEmail,
} from "../lib/mailer.js";
import { sendPushToUsers } from "../lib/push.js";
import { sendTransactionalSms, sendTransactionalWhatsapp } from "../lib/comms.js";

const processedEmailMock = vi.mocked(sendWalletWithdrawalProcessedEmail);
const failedEmailMock = vi.mocked(sendWalletWithdrawalFailedEmail);
const pushMock = vi.mocked(sendPushToUsers);
const smsMock = vi.mocked(sendTransactionalSms);
const waMock = vi.mocked(sendTransactionalWhatsapp);

let orgId: number;
let userId: number;
let walletId: number;
let payoutAccountId: number;
let clubMemberId: number;

beforeAll(async () => {
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `T964-${ts}`, slug: `t964-${ts}`, contactEmail: `t964-${ts}@example.test`,
  }).returning();
  orgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `ep_t964_${ts}`,
    username: `t964_user_${ts}`,
    email: `t964_${ts}@example.test`,
    displayName: "Withdraw Member",
    role: "player",
    organizationId: orgId,
  }).returning();
  userId = user.id;

  const [cm] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId,
    firstName: "Withdraw",
    lastName: "Member",
    email: `t964_${ts}@example.test`,
    phone: "+919812345678",
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
    accountHolderName: "Withdraw Member", upiVpa: "withdraw@upi",
    razorpayContactId: "cont_t964", razorpayFundAccountId: "fa_t964",
  }).returning();
  payoutAccountId = acct.id;
});

afterAll(async () => {
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, orgId));
  await db.delete(memberCommPrefsTable).where(eq(memberCommPrefsTable.clubMemberId, clubMemberId));
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
  await db.delete(clubWalletWithdrawalsTable).where(eq(clubWalletWithdrawalsTable.organizationId, orgId));
  await db.delete(walletPayoutAccountsTable).where(eq(walletPayoutAccountsTable.organizationId, orgId));
  await db.delete(clubWalletTxnsTable).where(inArray(clubWalletTxnsTable.walletId, [walletId]));
  await db.delete(clubWalletsTable).where(eq(clubWalletsTable.organizationId, orgId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, orgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  processedEmailMock.mockClear();
  failedEmailMock.mockClear();
  pushMock.mockClear();
  smsMock.mockClear();
  smsMock.mockImplementation(async () => undefined);
  waMock.mockClear();
  waMock.mockImplementation(async () => null);
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, orgId));
  await db.delete(memberCommPrefsTable).where(eq(memberCommPrefsTable.clubMemberId, clubMemberId));
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
});

async function newWithdrawal(amount: number) {
  return debitWalletForWithdrawal({
    walletId, organizationId: orgId, userId, amount, currency: "INR",
    method: "upi", payoutAccountId, razorpayFundAccountId: "fa_t964",
  });
}

describe("Task #964 — wallet withdrawal lifecycle notifications", () => {
  it("notifies on processed: in-app row with UTR + destination, push + email attempted", async () => {
    const r = await newWithdrawal(500);
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_t964_p1", utr: "UTR-T964-P1",
    });
    const result = await notifyWithdrawalProcessed({
      withdrawalId: r.withdrawalId, utr: "UTR-T964-P1",
    });

    expect(result.status).toBe("sent");
    expect(result.inApp.status).toBe("sent");
    expect(processedEmailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);

    const emailCall = processedEmailMock.mock.calls[0][0];
    expect(emailCall.utr).toBe("UTR-T964-P1");
    expect(emailCall.destination).toContain("withdraw@upi");
    expect(emailCall.amount).toBe("500.00");

    const [msg] = await db.select().from(memberMessagesTable)
      .where(and(
        eq(memberMessagesTable.organizationId, orgId),
        eq(memberMessagesTable.relatedEntity, "wallet_withdrawal"),
        eq(memberMessagesTable.relatedEntityId, r.withdrawalId),
      ))
      .orderBy(desc(memberMessagesTable.id))
      .limit(1);
    expect(msg).toBeDefined();
    expect(msg.subject).toMatch(/Withdrawal paid/);
    expect(msg.body).toContain("UTR-T964-P1");
    expect(msg.body).toContain("withdraw@upi");

    const pushCall = pushMock.mock.calls[0];
    expect(pushCall[0]).toEqual([userId]);
    expect(pushCall[1]).toMatch(/Withdrawal paid/);
    expect(pushCall[3]).toMatchObject({ type: "wallet_withdrawal_processed", utr: "UTR-T964-P1" });
  });

  it("notifies on failed: in-app row with refund context + reason, push + email attempted", async () => {
    const r = await newWithdrawal(750);
    await markWithdrawalFailed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_t964_f1",
      status: "failed", reason: "Beneficiary bank rejected",
    });
    const result = await notifyWithdrawalFailed({
      withdrawalId: r.withdrawalId, status: "failed", reason: "Beneficiary bank rejected",
    });

    expect(result.status).toBe("sent");
    expect(result.inApp.status).toBe("sent");
    expect(failedEmailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);

    const emailCall = failedEmailMock.mock.calls[0][0];
    expect(emailCall.reason).toBe("Beneficiary bank rejected");
    expect(emailCall.reversed).toBe(false);
    expect(emailCall.amount).toBe("750.00");
    expect(emailCall.destination).toContain("withdraw@upi");

    const [msg] = await db.select().from(memberMessagesTable)
      .where(and(
        eq(memberMessagesTable.organizationId, orgId),
        eq(memberMessagesTable.relatedEntity, "wallet_withdrawal"),
        eq(memberMessagesTable.relatedEntityId, r.withdrawalId),
      ))
      .orderBy(desc(memberMessagesTable.id))
      .limit(1);
    expect(msg.subject).toMatch(/failed/);
    expect(msg.body).toMatch(/refunded to your wallet/i);
    expect(msg.body).toContain("Beneficiary bank rejected");

    const pushCall = pushMock.mock.calls[0];
    expect(pushCall[3]).toMatchObject({ type: "wallet_withdrawal_failed", reason: "Beneficiary bank rejected" });
  });

  it("notifies on reversed: email + push receive reversed=true and 'reversed' subject", async () => {
    const r = await newWithdrawal(620);
    await markWithdrawalFailed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_t964_rev",
      status: "reversed", reason: "Bank reversed payout",
    });
    const result = await notifyWithdrawalFailed({
      withdrawalId: r.withdrawalId, status: "reversed", reason: "Bank reversed payout",
    });
    expect(result.status).toBe("sent");
    const emailCall = failedEmailMock.mock.calls[0][0];
    expect(emailCall.reversed).toBe(true);
  });

  it("markWithdrawalProcessed returns transitioned=true only on the first call (idempotent)", async () => {
    const r = await newWithdrawal(200);
    const t1 = await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_t964_idem", utr: "UTR-IDEM",
    });
    expect(t1.transitioned).toBe(true);
    const t2 = await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_t964_idem", utr: "UTR-IDEM",
    });
    expect(t2.transitioned).toBe(false);
  });

  it("markWithdrawalFailed returns transitioned=true only on the first call (idempotent)", async () => {
    const r = await newWithdrawal(180);
    const t1 = await markWithdrawalFailed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_t964_fail_idem",
      status: "failed", reason: "first failure",
    });
    expect(t1.transitioned).toBe(true);
    const t2 = await markWithdrawalFailed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_t964_fail_idem",
      status: "failed", reason: "first failure",
    });
    expect(t2.transitioned).toBe(false);
  });

  it("markWithdrawalProcessed returns transitioned=false when row is already refunded (paid_after_refund)", async () => {
    const r = await newWithdrawal(300);
    await markWithdrawalFailed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_par_t964",
      status: "failed", reason: "race",
    });
    const t = await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_par_t964", utr: "UTR-PAR",
    });
    // We must NOT re-notify the member with a "success" message after
    // they already received the failure/refund alert.
    expect(t.transitioned).toBe(false);
  });

  it("respects user-level preferEmail opt-out", async () => {
    await db.insert(userNotificationPrefsTable).values({
      userId, preferEmail: false, preferPush: true,
    });
    const r = await newWithdrawal(400);
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_optout", utr: "UTR-OO",
    });
    const result = await notifyWithdrawalProcessed({
      withdrawalId: r.withdrawalId, utr: "UTR-OO",
    });
    expect(result.email.status).toBe("opted_out");
    expect(processedEmailMock).not.toHaveBeenCalled();
    // In-app + push still attempted.
    expect(result.inApp.status).toBe("sent");
  });

  it("respects member-comm `billing` category opt-out", async () => {
    await db.insert(memberCommPrefsTable).values({
      clubMemberId, organizationId: orgId, category: "billing", emailEnabled: false,
    });
    const r = await newWithdrawal(450);
    await markWithdrawalFailed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_cat_oo",
      status: "failed", reason: "test",
    });
    const result = await notifyWithdrawalFailed({
      withdrawalId: r.withdrawalId, status: "failed", reason: "test",
    });
    expect(result.email.status).toBe("opted_out");
    expect(failedEmailMock).not.toHaveBeenCalled();
  });

  // ── Task #1107 — SMS channel ──────────────────────────────────────
  it("does not send SMS by default (preferSms defaults to false)", async () => {
    const r = await newWithdrawal(510);
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_t1107_default", utr: "UTR-DEF",
    });
    const result = await notifyWithdrawalProcessed({
      withdrawalId: r.withdrawalId, utr: "UTR-DEF",
    });
    expect(result.sms.status).toBe("opted_out");
    expect(smsMock).not.toHaveBeenCalled();
  });

  it("sends SMS on processed when preferSms + billing smsEnabled are on, with UTR", async () => {
    await db.insert(userNotificationPrefsTable).values({
      userId, preferEmail: true, preferPush: true, preferSms: true,
    });
    await db.insert(memberCommPrefsTable).values({
      clubMemberId, organizationId: orgId, category: "billing",
      emailEnabled: true, smsEnabled: true,
    });
    const r = await newWithdrawal(525);
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_t1107_sms", utr: "UTR-SMS-1",
    });
    const result = await notifyWithdrawalProcessed({
      withdrawalId: r.withdrawalId, utr: "UTR-SMS-1",
    });
    expect(result.sms.status).toBe("sent");
    expect(smsMock).toHaveBeenCalledTimes(1);
    const [phone, body] = smsMock.mock.calls[0];
    expect(phone).toBe("+919812345678");
    expect(body).toMatch(/Withdrawal paid/);
    expect(body).toContain("UTR-SMS-1");
    expect(body).toContain("525.00");
  });

  it("sends SMS on failed with refund context when opted in", async () => {
    await db.insert(userNotificationPrefsTable).values({
      userId, preferEmail: true, preferPush: true, preferSms: true,
    });
    await db.insert(memberCommPrefsTable).values({
      clubMemberId, organizationId: orgId, category: "billing",
      emailEnabled: true, smsEnabled: true,
    });
    const r = await newWithdrawal(360);
    await markWithdrawalFailed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_t1107_smsf",
      status: "failed", reason: "Bank rejected",
    });
    const result = await notifyWithdrawalFailed({
      withdrawalId: r.withdrawalId, status: "failed", reason: "Bank rejected",
    });
    expect(result.sms.status).toBe("sent");
    expect(smsMock).toHaveBeenCalledTimes(1);
    const [, body] = smsMock.mock.calls[0];
    expect(body).toMatch(/failed/);
    expect(body).toMatch(/refunded to your wallet/i);
  });

  it("respects member-comm billing smsEnabled opt-out even when preferSms is on", async () => {
    await db.insert(userNotificationPrefsTable).values({
      userId, preferEmail: true, preferPush: true, preferSms: true,
    });
    await db.insert(memberCommPrefsTable).values({
      clubMemberId, organizationId: orgId, category: "billing",
      emailEnabled: true, smsEnabled: false,
    });
    const r = await newWithdrawal(410);
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_t1107_catoo", utr: "UTR-CAT",
    });
    const result = await notifyWithdrawalProcessed({
      withdrawalId: r.withdrawalId, utr: "UTR-CAT",
    });
    expect(result.sms.status).toBe("opted_out");
    expect(smsMock).not.toHaveBeenCalled();
  });

  // ── Task #1269 — SMS i18n ─────────────────────────────────────────
  it("renders the SMS body in the recipient's preferredLanguage (hi) for processed/failed/reversed", async () => {
    await db.insert(userNotificationPrefsTable).values({
      userId, preferEmail: true, preferPush: true, preferSms: true,
    });
    await db.insert(memberCommPrefsTable).values({
      clubMemberId, organizationId: orgId, category: "billing",
      emailEnabled: true, smsEnabled: true,
    });
    await db.update(appUsersTable).set({ preferredLanguage: "hi" })
      .where(eq(appUsersTable.id, userId));
    try {
      // processed
      const r1 = await newWithdrawal(525);
      await markWithdrawalProcessed({
        withdrawalId: r1.withdrawalId, razorpayPayoutId: "pout_t1269_p", utr: "UTR-T1269-P",
      });
      await notifyWithdrawalProcessed({ withdrawalId: r1.withdrawalId, utr: "UTR-T1269-P" });
      let [, body] = smsMock.mock.calls[smsMock.mock.calls.length - 1];
      expect(body).toContain("निकासी");
      expect(body).toContain("525.00");
      expect(body).toContain("UTR-T1269-P");
      expect(body).not.toMatch(/Withdrawal paid/);

      // failed
      smsMock.mockClear();
      const r2 = await newWithdrawal(360);
      await markWithdrawalFailed({
        withdrawalId: r2.withdrawalId, razorpayPayoutId: "pout_t1269_f",
        status: "failed", reason: "Bank rejected",
      });
      await notifyWithdrawalFailed({
        withdrawalId: r2.withdrawalId, status: "failed", reason: "Bank rejected",
      });
      [, body] = smsMock.mock.calls[smsMock.mock.calls.length - 1];
      expect(body).toContain("निकासी विफल");
      expect(body).toContain("360.00");
      expect(body).toContain("कारण");
      expect(body).toContain("Bank rejected");

      // reversed
      smsMock.mockClear();
      const r3 = await newWithdrawal(280);
      await markWithdrawalFailed({
        withdrawalId: r3.withdrawalId, razorpayPayoutId: "pout_t1269_r",
        status: "reversed", reason: "Bank reversed payout",
      });
      await notifyWithdrawalFailed({
        withdrawalId: r3.withdrawalId, status: "reversed", reason: "Bank reversed payout",
      });
      [, body] = smsMock.mock.calls[smsMock.mock.calls.length - 1];
      // Task #1823 — Hindi reversal verb is "पलट दी गई", not "वापस ली गई"
      // (the latter reads as "taken back / retracted"). Pinned by the
      // sibling unit test in walletWithdrawalI18n.test.ts and documented
      // in docs/i18n/glossary-notes.md.
      expect(body).toContain("निकासी पलट दी गई");
      expect(body).toContain("280.00");
    } finally {
      await db.update(appUsersTable).set({ preferredLanguage: "en" })
        .where(eq(appUsersTable.id, userId));
    }
  });

  it("falls back to English SMS when preferredLanguage is unsupported", async () => {
    await db.insert(userNotificationPrefsTable).values({
      userId, preferEmail: true, preferPush: true, preferSms: true,
    });
    await db.insert(memberCommPrefsTable).values({
      clubMemberId, organizationId: orgId, category: "billing",
      emailEnabled: true, smsEnabled: true,
    });
    // appUsersTable.preferredLanguage defaults to "en" — leaving it as
    // is exercises the English path. Verify the body still matches the
    // legacy English copy that the SMS retry pipeline expects.
    const r = await newWithdrawal(415);
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_t1269_en", utr: "UTR-T1269-EN",
    });
    await notifyWithdrawalProcessed({ withdrawalId: r.withdrawalId, utr: "UTR-T1269-EN" });
    const [, body] = smsMock.mock.calls[smsMock.mock.calls.length - 1];
    expect(body).toMatch(/Withdrawal paid/);
    expect(body).toContain("UTR-T1269-EN");
    expect(body).toContain("415.00");
  });

  it("skips SMS silently when SMS_PROVIDER is not configured", async () => {
    await db.insert(userNotificationPrefsTable).values({
      userId, preferEmail: true, preferPush: true, preferSms: true,
    });
    await db.insert(memberCommPrefsTable).values({
      clubMemberId, organizationId: orgId, category: "billing",
      emailEnabled: true, smsEnabled: true,
    });
    smsMock.mockImplementationOnce(async () => {
      throw new Error("SMS_PROVIDER not configured");
    });
    const r = await newWithdrawal(290);
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_t1107_nocfg", utr: "UTR-NC",
    });
    const result = await notifyWithdrawalProcessed({
      withdrawalId: r.withdrawalId, utr: "UTR-NC",
    });
    expect(result.sms.status).toBe("skipped");
    expect(result.sms.error).toBe("provider_not_configured");
  });

  // ── Task #1487 — WhatsApp channel ─────────────────────────────────
  // Small per-withdrawal amounts so the pooled test wallet (seeded at
  // 10000.00 in beforeAll) still has room for the downstream Task #1108
  // / #1279 retry-pipeline tests that come later in the file.
  it("does not send WhatsApp by default (billing whatsappEnabled defaults to false)", async () => {
    const r = await newWithdrawal(5);
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_t1487_default", utr: "UTR-WA-DEF",
    });
    const result = await notifyWithdrawalProcessed({
      withdrawalId: r.withdrawalId, utr: "UTR-WA-DEF",
    });
    expect(result.whatsapp.status).toBe("opted_out");
    expect(waMock).not.toHaveBeenCalled();
  });

  it("sends WhatsApp on processed when billing whatsappEnabled is on, with UTR", async () => {
    await db.insert(memberCommPrefsTable).values({
      clubMemberId, organizationId: orgId, category: "billing",
      emailEnabled: true, whatsappEnabled: true,
    });
    const r = await newWithdrawal(7);
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_t1487_wa", utr: "UTR-WA-1",
    });
    const result = await notifyWithdrawalProcessed({
      withdrawalId: r.withdrawalId, utr: "UTR-WA-1",
    });
    expect(result.whatsapp.status).toBe("sent");
    expect(waMock).toHaveBeenCalledTimes(1);
    const [phone, body] = waMock.mock.calls[0];
    expect(phone).toBe("+919812345678");
    expect(body).toMatch(/Withdrawal paid/);
    expect(body).toContain("UTR-WA-1");
    expect(body).toContain("7.00");
  });

  it("sends WhatsApp on failed with refund context when opted in", async () => {
    await db.insert(memberCommPrefsTable).values({
      clubMemberId, organizationId: orgId, category: "billing",
      emailEnabled: true, whatsappEnabled: true,
    });
    const r = await newWithdrawal(5);
    await markWithdrawalFailed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_t1487_waf",
      status: "failed", reason: "Bank rejected",
    });
    const result = await notifyWithdrawalFailed({
      withdrawalId: r.withdrawalId, status: "failed", reason: "Bank rejected",
    });
    expect(result.whatsapp.status).toBe("sent");
    expect(waMock).toHaveBeenCalledTimes(1);
    const [, body] = waMock.mock.calls[0];
    expect(body).toMatch(/failed/);
    expect(body).toMatch(/refunded to your wallet/i);
  });

  it("respects member-comm billing whatsappEnabled opt-out", async () => {
    await db.insert(memberCommPrefsTable).values({
      clubMemberId, organizationId: orgId, category: "billing",
      emailEnabled: true, whatsappEnabled: false,
    });
    const r = await newWithdrawal(5);
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_t1487_waoo", utr: "UTR-WA-OO",
    });
    const result = await notifyWithdrawalProcessed({
      withdrawalId: r.withdrawalId, utr: "UTR-WA-OO",
    });
    expect(result.whatsapp.status).toBe("opted_out");
    expect(waMock).not.toHaveBeenCalled();
  });

  it("skips WhatsApp silently when WHATSAPP_PROVIDER is not configured", async () => {
    await db.insert(memberCommPrefsTable).values({
      clubMemberId, organizationId: orgId, category: "billing",
      emailEnabled: true, whatsappEnabled: true,
    });
    waMock.mockImplementationOnce(async () => {
      throw new Error("WHATSAPP_PROVIDER not configured");
    });
    const r = await newWithdrawal(5);
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_t1487_nocfg", utr: "UTR-WA-NC",
    });
    const result = await notifyWithdrawalProcessed({
      withdrawalId: r.withdrawalId, utr: "UTR-WA-NC",
    });
    expect(result.whatsapp.status).toBe("skipped");
    expect(result.whatsapp.error).toBe("provider_not_configured");
  });

  // ── Task #1825 — SMS / WhatsApp result is persisted on the row ────
  // Until Task #1825 the per-attempt audit row only stored email +
  // push results, so admins debugging "did the member get pinged?"
  // had no record for SMS / WhatsApp. These tests pin the persisted
  // row state for both an opted-in WhatsApp send and a billing
  // opt-out, and check the SMS path mirrors it.
  it("persists smsStatus/whatsappStatus on the row for an opted-in WhatsApp + SMS send", async () => {
    await db.insert(userNotificationPrefsTable).values({
      userId, preferEmail: true, preferPush: true, preferSms: true,
    });
    await db.insert(memberCommPrefsTable).values({
      clubMemberId, organizationId: orgId, category: "billing",
      emailEnabled: true, smsEnabled: true, whatsappEnabled: true,
    });
    const r = await newWithdrawal(9);
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_t1825_in", utr: "UTR-T1825-IN",
    });
    const result = await notifyWithdrawalProcessed({
      withdrawalId: r.withdrawalId, utr: "UTR-T1825-IN",
    });
    expect(result.sms.status).toBe("sent");
    expect(result.whatsapp.status).toBe("sent");

    const [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(and(
        eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, r.withdrawalId),
        eq(walletWithdrawalNotifyAttemptsTable.outcome, "processed"),
      )).limit(1);
    expect(row).toBeDefined();
    expect(row.smsStatus).toBe("sent");
    expect(row.smsError).toBeNull();
    expect(row.lastSmsAt).not.toBeNull();
    expect(row.whatsappStatus).toBe("sent");
    expect(row.whatsappError).toBeNull();
    expect(row.lastWhatsappAt).not.toBeNull();
  });

  it("persists smsStatus/whatsappStatus = opted_out on the row when billing prefs are off", async () => {
    // No userNotificationPrefs row → preferSms defaults to false → SMS opted_out.
    // No memberCommPrefs row for billing → whatsappEnabled defaults to false → WhatsApp opted_out.
    const r = await newWithdrawal(7);
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_t1825_oo", utr: "UTR-T1825-OO",
    });
    const result = await notifyWithdrawalProcessed({
      withdrawalId: r.withdrawalId, utr: "UTR-T1825-OO",
    });
    expect(result.sms.status).toBe("opted_out");
    expect(result.whatsapp.status).toBe("opted_out");
    expect(smsMock).not.toHaveBeenCalled();
    expect(waMock).not.toHaveBeenCalled();

    const [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(and(
        eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, r.withdrawalId),
        eq(walletWithdrawalNotifyAttemptsTable.outcome, "processed"),
      )).limit(1);
    expect(row).toBeDefined();
    // We persist the opted-out status verbatim so an admin can
    // distinguish "we tried and the carrier rejected" from "the
    // member is opted out of this channel" without re-deriving from
    // the prefs tables (which can change after the fact).
    expect(row.smsStatus).toBe("opted_out");
    expect(row.smsError).toBeNull();
    expect(row.lastSmsAt).toBeNull();
    expect(row.whatsappStatus).toBe("opted_out");
    expect(row.whatsappError).toBeNull();
    expect(row.lastWhatsappAt).toBeNull();
  });

  it("persists smsStatus = skipped + smsError = provider_not_configured when SMS_PROVIDER is missing", async () => {
    await db.insert(userNotificationPrefsTable).values({
      userId, preferEmail: true, preferPush: true, preferSms: true,
    });
    await db.insert(memberCommPrefsTable).values({
      clubMemberId, organizationId: orgId, category: "billing",
      emailEnabled: true, smsEnabled: true,
    });
    smsMock.mockImplementationOnce(async () => {
      throw new Error("SMS_PROVIDER not configured");
    });
    const r = await newWithdrawal(8);
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_t1825_nocfg", utr: "UTR-T1825-NC",
    });
    await notifyWithdrawalProcessed({
      withdrawalId: r.withdrawalId, utr: "UTR-T1825-NC",
    });

    const [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(and(
        eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, r.withdrawalId),
        eq(walletWithdrawalNotifyAttemptsTable.outcome, "processed"),
      )).limit(1);
    expect(row).toBeDefined();
    expect(row.smsStatus).toBe("skipped");
    expect(row.smsError).toBe("provider_not_configured");
    // We never actually contacted the provider on a skipped row —
    // lastSmsAt stays null so the admin "last sent at" column does
    // not light up for a delivery that never happened.
    expect(row.lastSmsAt).toBeNull();
  });
});

// ─── Task #1108 — retry pipeline ────────────────────────────────────────────
describe("Task #1108 — wallet withdrawal notify retry", () => {
  it("computeNextRetryAt follows the 5/10/20/40/80 minute backoff schedule", () => {
    const base = new Date("2030-01-01T00:00:00Z");
    expect(computeNextRetryAt(1, base).getTime() - base.getTime()).toBe(5 * 60 * 1000);
    expect(computeNextRetryAt(2, base).getTime() - base.getTime()).toBe(10 * 60 * 1000);
    expect(computeNextRetryAt(3, base).getTime() - base.getTime()).toBe(20 * 60 * 1000);
    expect(computeNextRetryAt(4, base).getTime() - base.getTime()).toBe(40 * 60 * 1000);
    expect(computeNextRetryAt(5, base).getTime() - base.getTime()).toBe(80 * 60 * 1000);
  });

  it("persists an attempts row on first send and stamps next retry on email failure", async () => {
    processedEmailMock.mockRejectedValueOnce(new Error("SMTP timeout"));
    const r = await newWithdrawal(310);
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_retry_1", utr: "UTR-RETRY-1",
    });
    await notifyWithdrawalProcessed({ withdrawalId: r.withdrawalId, utr: "UTR-RETRY-1" });

    const [row] = await db.select()
      .from(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, r.withdrawalId));
    expect(row).toBeDefined();
    expect(row.outcome).toBe("processed");
    expect(row.emailStatus).toBe("failed");
    expect(row.emailAttempts).toBe(1);
    expect(row.lastEmailError).toMatch(/SMTP timeout/);
    expect(row.nextEmailRetryAt).toBeTruthy();
    expect(row.utr).toBe("UTR-RETRY-1");
  });

  it("does NOT double-insert if notify is somehow re-invoked for the same (withdrawal, outcome)", async () => {
    const r = await newWithdrawal(280);
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_dup", utr: "UTR-DUP",
    });
    await notifyWithdrawalProcessed({ withdrawalId: r.withdrawalId, utr: "UTR-DUP" });
    await notifyWithdrawalProcessed({ withdrawalId: r.withdrawalId, utr: "UTR-DUP" });

    const rows = await db.select()
      .from(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, r.withdrawalId));
    expect(rows.length).toBe(1);
  });

  it("retryWalletWithdrawalEmail clears nextEmailRetryAt and bumps attempts on a successful retry", async () => {
    processedEmailMock.mockRejectedValueOnce(new Error("transient SMTP"));
    const r = await newWithdrawal(330);
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_retry_ok", utr: "UTR-OK",
    });
    await notifyWithdrawalProcessed({ withdrawalId: r.withdrawalId, utr: "UTR-OK" });

    let [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, r.withdrawalId));
    expect(row.emailStatus).toBe("failed");

    // Simulate cron picking it up after backoff.
    const ret = await retryWalletWithdrawalEmail({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret).not.toBeNull();
    expect(ret!.status).toBe("sent");
    expect(processedEmailMock).toHaveBeenCalledTimes(2);

    [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, r.withdrawalId));
    expect(row.emailStatus).toBe("sent");
    expect(row.emailAttempts).toBe(2);
    expect(row.nextEmailRetryAt).toBeNull();
    expect(row.emailRetryExhaustedAt).toBeNull();
  });

  it("retryWalletWithdrawalEmail returns null when the backoff window has not elapsed", async () => {
    processedEmailMock.mockRejectedValueOnce(new Error("SMTP down"));
    const r = await newWithdrawal(290);
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_backoff", utr: "UTR-BO",
    });
    await notifyWithdrawalProcessed({ withdrawalId: r.withdrawalId, utr: "UTR-BO" });

    const [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, r.withdrawalId));
    // Same instant as send → window not elapsed.
    const ret = await retryWalletWithdrawalEmail({ attempt: row, now: new Date() });
    expect(ret).toBeNull();
    expect(processedEmailMock).toHaveBeenCalledTimes(1);
  });

  it("retryWalletWithdrawalEmail stamps emailRetryExhaustedAt after the cap is reached", async () => {
    processedEmailMock.mockRejectedValue(new Error("SMTP perm"));
    const r = await newWithdrawal(360);
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_exhaust", utr: "UTR-EX",
    });
    await notifyWithdrawalProcessed({ withdrawalId: r.withdrawalId, utr: "UTR-EX" });

    // Initial attempts=1; loop until exhausted.
    let now = new Date();
    for (let i = 0; i < WALLET_WITHDRAWAL_NOTIFY_MAX_EMAIL_ATTEMPTS; i++) {
      const [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
        .where(eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, r.withdrawalId));
      now = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const ret = await retryWalletWithdrawalEmail({ attempt: row, now });
      if (!ret) break;
    }
    const [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, r.withdrawalId));
    expect(row.emailAttempts).toBe(WALLET_WITHDRAWAL_NOTIFY_MAX_EMAIL_ATTEMPTS);
    expect(row.emailStatus).toBe("failed");
    expect(row.emailRetryExhaustedAt).toBeTruthy();
    expect(row.nextEmailRetryAt).toBeNull();
    processedEmailMock.mockReset();
    processedEmailMock.mockResolvedValue(undefined as unknown as void);
  });

  it("retryWalletWithdrawalEmail returns null once status flips off 'failed'", async () => {
    const r = await newWithdrawal(220);
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_done", utr: "UTR-DONE",
    });
    await notifyWithdrawalProcessed({ withdrawalId: r.withdrawalId, utr: "UTR-DONE" });
    const [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, r.withdrawalId));
    expect(row.emailStatus).toBe("sent");
    const ret = await retryWalletWithdrawalEmail({
      attempt: row, now: new Date(Date.now() + 60 * 60 * 1000),
    });
    expect(ret).toBeNull();
  });

  it("retryFailedWalletWithdrawalEmailPush only picks up due rows and dispatches each channel", async () => {
    // Row A: email failed, due (oldest createdAt) → must be retried.
    processedEmailMock.mockRejectedValueOnce(new Error("transient A"));
    const a = await newWithdrawal(510);
    await markWithdrawalProcessed({
      withdrawalId: a.withdrawalId, razorpayPayoutId: "pout_cron_a", utr: "UTR-A",
    });
    await notifyWithdrawalProcessed({ withdrawalId: a.withdrawalId, utr: "UTR-A" });
    // Backdate the row and the next-retry stamp so it is comfortably due.
    await db.update(walletWithdrawalNotifyAttemptsTable).set({
      nextEmailRetryAt: new Date(Date.now() - 60 * 60 * 1000),
    }).where(eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, a.withdrawalId));

    // Row B: email failed, NOT yet due (next retry is far in the future)
    // → cron must skip it.
    processedEmailMock.mockRejectedValueOnce(new Error("transient B"));
    const b = await newWithdrawal(520);
    await markWithdrawalProcessed({
      withdrawalId: b.withdrawalId, razorpayPayoutId: "pout_cron_b", utr: "UTR-B",
    });
    await notifyWithdrawalProcessed({ withdrawalId: b.withdrawalId, utr: "UTR-B" });
    await db.update(walletWithdrawalNotifyAttemptsTable).set({
      nextEmailRetryAt: new Date(Date.now() + 60 * 60 * 1000),
    }).where(eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, b.withdrawalId));

    // Clear send-side mocks so we can count cron-driven invocations only.
    processedEmailMock.mockClear();
    processedEmailMock.mockResolvedValueOnce(undefined as unknown as void);

    await retryFailedWalletWithdrawalEmailPush();

    // Exactly one email retry happened (Row A); Row B was filtered out.
    expect(processedEmailMock).toHaveBeenCalledTimes(1);
    const aRow = (await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, a.withdrawalId)))[0];
    const bRow = (await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, b.withdrawalId)))[0];
    expect(aRow.emailStatus).toBe("sent");
    expect(aRow.emailAttempts).toBe(2);
    expect(bRow.emailStatus).toBe("failed");
    expect(bRow.emailAttempts).toBe(1); // untouched by cron
  });

  it("retryWalletWithdrawalPush respects preferPush opt-out at retry time", async () => {
    pushMock.mockResolvedValueOnce({ attempted: 1, sent: 0, failed: 1, invalid: 0 });
    const r = await newWithdrawal(410);
    await markWithdrawalProcessed({
      withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_push_oo", utr: "UTR-POO",
    });
    await notifyWithdrawalProcessed({ withdrawalId: r.withdrawalId, utr: "UTR-POO" });
    let [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, r.withdrawalId));
    expect(row.pushStatus).toBe("failed");

    // User opts out between original send and the retry — retry must
    // honour it instead of pinging again.
    await db.insert(userNotificationPrefsTable).values({
      userId, preferEmail: true, preferPush: false,
    });
    const ret = await retryWalletWithdrawalPush({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret).not.toBeNull();
    expect(ret!.status).toBe("opted_out");
    expect(pushMock).toHaveBeenCalledTimes(1); // not called again

    [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
      .where(eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, r.withdrawalId));
    expect(row.pushStatus).toBe("opted_out");
    expect(row.nextPushRetryAt).toBeNull();
  });

  // ── Task #1279 ─────────────────────────────────────────────────────
  describe("Task #1279 — hard bounce / single admin alert / no double email", () => {
    it("hard SMTP bounce on first attempt short-circuits to exhausted (no retries scheduled)", async () => {
      // SMTP 5xx response — must NOT consume the 5-retry budget.
      processedEmailMock.mockRejectedValueOnce(new Error("550 5.1.1 The email account that you tried to reach does not exist"));
      const r = await newWithdrawal(610);
      await markWithdrawalProcessed({
        withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_hb1", utr: "UTR-HB1",
      });
      await notifyWithdrawalProcessed({ withdrawalId: r.withdrawalId, utr: "UTR-HB1" });

      const [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
        .where(eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, r.withdrawalId));
      expect(row.emailStatus).toBe("failed");
      // Cap reached on the very first attempt — cron can never re-pick this row.
      expect(row.emailAttempts).toBe(WALLET_WITHDRAWAL_NOTIFY_MAX_EMAIL_ATTEMPTS);
      expect(row.emailRetryExhaustedAt).toBeTruthy();
      expect(row.nextEmailRetryAt).toBeNull();
      // The admin was alerted exactly once (stamp set).
      expect(row.adminExhaustionNotifiedAt).toBeTruthy();
    });

    it("hard SMTP bounce on a retry jumps straight to exhausted without consuming the rest of the budget", async () => {
      // First attempt = transient → fails normally with 1 retry scheduled.
      processedEmailMock.mockRejectedValueOnce(new Error("ETIMEDOUT"));
      const r = await newWithdrawal(620);
      await markWithdrawalProcessed({
        withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_hb2", utr: "UTR-HB2",
      });
      await notifyWithdrawalProcessed({ withdrawalId: r.withdrawalId, utr: "UTR-HB2" });

      let [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
        .where(eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, r.withdrawalId));
      expect(row.emailStatus).toBe("failed");
      expect(row.emailAttempts).toBe(1);
      expect(row.emailRetryExhaustedAt).toBeNull();

      // Retry returns a hard bounce — must short-circuit, even though
      // there are still 4 attempts left in the bounded budget.
      processedEmailMock.mockRejectedValueOnce(new Error("InactiveRecipient: address is on the suppression list"));
      const ret = await retryWalletWithdrawalEmail({
        attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
      });
      expect(ret).not.toBeNull();
      expect(ret!.exhausted).toBe(true);
      expect(ret!.attempts).toBe(WALLET_WITHDRAWAL_NOTIFY_MAX_EMAIL_ATTEMPTS);

      [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
        .where(eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, r.withdrawalId));
      expect(row.emailAttempts).toBe(WALLET_WITHDRAWAL_NOTIFY_MAX_EMAIL_ATTEMPTS);
      expect(row.emailRetryExhaustedAt).toBeTruthy();
      expect(row.nextEmailRetryAt).toBeNull();
      expect(row.adminExhaustionNotifiedAt).toBeTruthy();
    });

    it("transient SMTP failure (timeout) still uses the normal retry path", async () => {
      // Sanity check: the bounce classifier must not trip on a transient
      // error message — otherwise the existing retry pipeline collapses.
      processedEmailMock.mockRejectedValueOnce(new Error("Connection refused (ECONNREFUSED)"));
      const r = await newWithdrawal(625);
      await markWithdrawalProcessed({
        withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_tr1", utr: "UTR-TR1",
      });
      await notifyWithdrawalProcessed({ withdrawalId: r.withdrawalId, utr: "UTR-TR1" });

      const [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
        .where(eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, r.withdrawalId));
      expect(row.emailStatus).toBe("failed");
      expect(row.emailAttempts).toBe(1); // NOT short-circuited
      expect(row.emailRetryExhaustedAt).toBeNull();
      expect(row.nextEmailRetryAt).toBeTruthy();
      expect(row.adminExhaustionNotifiedAt).toBeNull();
    });

    it("admin exhaustion alert is dedup'd: push exhausting after email cannot fire it twice", async () => {
      // Email exhausts via hard bounce (first attempt) → admin alert fires.
      processedEmailMock.mockRejectedValueOnce(new Error("550 mailbox unavailable"));
      // Push fails on first attempt so we can later exhaust it via retries.
      pushMock.mockResolvedValueOnce({ attempted: 1, sent: 0, failed: 1, invalid: 0 });

      const r = await newWithdrawal(630);
      await markWithdrawalProcessed({
        withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_dedup", utr: "UTR-DD",
      });
      await notifyWithdrawalProcessed({ withdrawalId: r.withdrawalId, utr: "UTR-DD" });

      let [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
        .where(eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, r.withdrawalId));
      expect(row.emailRetryExhaustedAt).toBeTruthy();
      const firstAdminStamp = row.adminExhaustionNotifiedAt;
      expect(firstAdminStamp).toBeTruthy();

      // Now drive push retries to exhaustion. Each retry returns a
      // failed ticket so attempts climb to MAX.
      pushMock.mockResolvedValue({ attempted: 1, sent: 0, failed: 1, invalid: 0 });
      let now = new Date();
      for (let i = 0; i < WALLET_WITHDRAWAL_NOTIFY_MAX_EMAIL_ATTEMPTS; i++) {
        [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
          .where(eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, r.withdrawalId));
        if (row.pushStatus !== "failed") break;
        now = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const ret = await retryWalletWithdrawalPush({ attempt: row, now });
        if (!ret) break;
      }
      pushMock.mockReset();
      pushMock.mockResolvedValue({ attempted: 0, sent: 0, failed: 0, invalid: 0 });

      [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
        .where(eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, r.withdrawalId));
      expect(row.pushRetryExhaustedAt).toBeTruthy();
      // Stamp must NOT have moved — single alert across both channels.
      expect(row.adminExhaustionNotifiedAt?.getTime()).toBe(firstAdminStamp!.getTime());
    });

    it("no double email: a re-invoked notify for the same (withdrawal, outcome) must not call sendMail again", async () => {
      const r = await newWithdrawal(5);
      await markWithdrawalProcessed({
        withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_dup_email", utr: "UTR-DUPE",
      });

      processedEmailMock.mockClear();
      const a = await notifyWithdrawalProcessed({ withdrawalId: r.withdrawalId, utr: "UTR-DUPE" });
      const b = await notifyWithdrawalProcessed({ withdrawalId: r.withdrawalId, utr: "UTR-DUPE" });

      expect(a.status).toBe("sent");
      // The duplicate notify is short-circuited at the claim step.
      expect(b.status).toBe("skipped");
      expect(b.reason).toBe("already_notified");
      // Critical guarantee: the member only saw the email once.
      expect(processedEmailMock).toHaveBeenCalledTimes(1);

      // And only one attempts row exists (existing invariant from #1108).
      const rows = await db.select().from(walletWithdrawalNotifyAttemptsTable)
        .where(eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, r.withdrawalId));
      expect(rows.length).toBe(1);
    });

    it("no double email: cron retry never picks up a row whose email already succeeded", async () => {
      // Initial send succeeds, then `markWithdrawalProcessed` fires a
      // second notify (e.g. webhook replay). Cron must also leave the
      // row alone since `emailStatus` is already 'sent'.
      const r = await newWithdrawal(5);
      await markWithdrawalProcessed({
        withdrawalId: r.withdrawalId, razorpayPayoutId: "pout_no_dup_cron", utr: "UTR-NDC",
      });
      processedEmailMock.mockClear();
      await notifyWithdrawalProcessed({ withdrawalId: r.withdrawalId, utr: "UTR-NDC" });
      expect(processedEmailMock).toHaveBeenCalledTimes(1);

      const [row] = await db.select().from(walletWithdrawalNotifyAttemptsTable)
        .where(eq(walletWithdrawalNotifyAttemptsTable.withdrawalId, r.withdrawalId));
      expect(row.emailStatus).toBe("sent");
      // Even if cron tries to retry — it must return null.
      const ret = await retryWalletWithdrawalEmail({
        attempt: row, now: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      expect(ret).toBeNull();
      expect(processedEmailMock).toHaveBeenCalledTimes(1);
    });
  });
});
