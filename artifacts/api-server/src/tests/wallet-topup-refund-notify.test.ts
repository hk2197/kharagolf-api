/**
 * Task #1280 — wallet top-up auto-refund notify retry pipeline.
 *
 * The original notify (`notifyWalletTopupAutoRefunded`) is fire-and-forget:
 * the bank charge has already been refunded, so a transient SMTP / Expo
 * blip on the very first try used to silently drop the only confirmation
 * the member ever sees. This suite mirrors the wallet-withdrawal retry
 * coverage from Task #1108:
 *
 *   - persists an attempts row on first failure (one row per paymentId,
 *     unique index also defends against a re-fire);
 *   - `computeNextRetryAt` follows the 5/10/20/40/80-minute schedule;
 *   - `retryWalletTopupRefundEmail` returns null when the row is no
 *     longer eligible (status not failed, cap reached, backoff window
 *     pending), clears `nextEmailRetryAt` on a successful retry, and
 *     stamps `emailRetryExhaustedAt` after the cap;
 *   - the cron batch (`retryFailedWalletTopupRefundEmailPush`) only
 *     picks up due rows;
 *   - `retryWalletTopupRefundPush` honours `preferPush` opt-outs that
 *     happen between the original send and the retry.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendWalletTopupAutoRefundedEmail: vi.fn(async () => undefined),
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
    sendTransactionalWhatsapp: vi.fn(async () => undefined),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberMessagesTable,
  memberCommPrefsTable,
  userNotificationPrefsTable,
  walletTopupRefundNotifyAttemptsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  notifyWalletTopupAutoRefunded,
  retryWalletTopupRefundEmail,
  retryWalletTopupRefundPush,
  retryWalletTopupRefundSms,
  retryWalletTopupRefundWhatsapp,
  computeNextRetryAt,
  WALLET_TOPUP_REFUND_NOTIFY_MAX_EMAIL_ATTEMPTS,
  WALLET_TOPUP_REFUND_NOTIFY_MAX_SMS_ATTEMPTS,
  WALLET_TOPUP_REFUND_NOTIFY_MAX_WHATSAPP_ATTEMPTS,
} from "../lib/walletTopupRefundNotify.js";
import { retryFailedWalletTopupRefundEmailPush } from "../lib/cron.js";
import { sendWalletTopupAutoRefundedEmail } from "../lib/mailer.js";
import { sendPushToUsers } from "../lib/push.js";
import { sendTransactionalSms, sendTransactionalWhatsapp } from "../lib/comms.js";

const emailMock = vi.mocked(sendWalletTopupAutoRefundedEmail);
const pushMock = vi.mocked(sendPushToUsers);
const smsMock = vi.mocked(sendTransactionalSms);
const whatsappMock = vi.mocked(sendTransactionalWhatsapp);

let orgId: number;
let userId: number;
let clubMemberId: number;

let paymentSeq = 0;
function nextPaymentId(label: string): string {
  paymentSeq++;
  return `pay_t1280_${label}_${Date.now()}_${paymentSeq}`;
}

beforeAll(async () => {
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `T1280-${ts}`, slug: `t1280-${ts}`, contactEmail: `t1280-${ts}@example.test`,
  }).returning();
  orgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `ep_t1280_${ts}`,
    username: `t1280_user_${ts}`,
    email: `t1280_${ts}@example.test`,
    displayName: "Refund Member",
    role: "player",
    organizationId: orgId,
  }).returning();
  userId = user.id;

  const [cm] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId,
    firstName: "Refund",
    lastName: "Member",
    email: `t1280_${ts}@example.test`,
    phone: "+919812340000",
  }).returning();
  clubMemberId = cm.id;
});

afterAll(async () => {
  await db.delete(walletTopupRefundNotifyAttemptsTable).where(eq(walletTopupRefundNotifyAttemptsTable.organizationId, orgId));
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, orgId));
  await db.delete(memberCommPrefsTable).where(eq(memberCommPrefsTable.clubMemberId, clubMemberId));
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, orgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  emailMock.mockReset();
  emailMock.mockResolvedValue(undefined as unknown as void);
  pushMock.mockReset();
  pushMock.mockResolvedValue({ attempted: 1, sent: 1, failed: 0, invalid: 0 });
  smsMock.mockReset();
  smsMock.mockResolvedValue(undefined as unknown as void);
  whatsappMock.mockReset();
  whatsappMock.mockResolvedValue(null);
  await db.delete(walletTopupRefundNotifyAttemptsTable).where(eq(walletTopupRefundNotifyAttemptsTable.organizationId, orgId));
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, orgId));
  await db.delete(memberCommPrefsTable).where(eq(memberCommPrefsTable.clubMemberId, clubMemberId));
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
});

describe("Task #1280 — wallet top-up auto-refund notify retry", () => {
  it("computeNextRetryAt follows the 5/10/20/40/80 minute backoff schedule", () => {
    const base = new Date("2030-01-01T00:00:00Z");
    expect(computeNextRetryAt(1, base).getTime() - base.getTime()).toBe(5 * 60 * 1000);
    expect(computeNextRetryAt(2, base).getTime() - base.getTime()).toBe(10 * 60 * 1000);
    expect(computeNextRetryAt(3, base).getTime() - base.getTime()).toBe(20 * 60 * 1000);
    expect(computeNextRetryAt(4, base).getTime() - base.getTime()).toBe(40 * 60 * 1000);
    expect(computeNextRetryAt(5, base).getTime() - base.getTime()).toBe(80 * 60 * 1000);
  });

  it("persists an attempts row on first send and stamps next retry on email failure", async () => {
    emailMock.mockRejectedValueOnce(new Error("SMTP timeout"));
    const paymentId = nextPaymentId("first_fail");
    await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId, refundId: "rfnd_1", amount: 250, currency: "INR",
    });

    const [row] = await db.select()
      .from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    expect(row).toBeDefined();
    expect(row.emailStatus).toBe("failed");
    expect(row.emailAttempts).toBe(1);
    expect(row.lastEmailError).toMatch(/SMTP timeout/);
    expect(row.nextEmailRetryAt).toBeTruthy();
    expect(row.refundId).toBe("rfnd_1");
    expect(Number(row.amount)).toBe(250);
    expect(row.currency).toBe("INR");
  });

  it("does NOT double-insert if notify is somehow re-invoked for the same paymentId", async () => {
    const paymentId = nextPaymentId("dup");
    await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId, refundId: "rfnd_dup", amount: 100, currency: "INR",
    });
    await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId, refundId: "rfnd_dup", amount: 100, currency: "INR",
    });

    const rows = await db.select()
      .from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    expect(rows.length).toBe(1);
  });

  it("retryWalletTopupRefundEmail clears nextEmailRetryAt and bumps attempts on a successful retry", async () => {
    emailMock.mockRejectedValueOnce(new Error("transient SMTP"));
    const paymentId = nextPaymentId("retry_ok");
    await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId, refundId: "rfnd_ok", amount: 320, currency: "INR",
    });

    let [row] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    expect(row.emailStatus).toBe("failed");

    // Cron picks it up after the backoff window.
    const ret = await retryWalletTopupRefundEmail({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret).not.toBeNull();
    expect(ret!.status).toBe("sent");
    expect(emailMock).toHaveBeenCalledTimes(2);

    [row] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    expect(row.emailStatus).toBe("sent");
    expect(row.emailAttempts).toBe(2);
    expect(row.nextEmailRetryAt).toBeNull();
    expect(row.emailRetryExhaustedAt).toBeNull();
  });

  // Task #1502 / Task #1850 — provider_unconfigured branch on the initial
  // send (lib line 333). When `classifyMailerError` returns
  // `provider_unconfigured`, the helper must mark email as terminal
  // `skipped`/`provider_not_configured`. The attempts row is still
  // persisted (the writer always records the dispatch outcome for
  // observability), but with `emailAttempts = 0` (skip is not a delivery
  // attempt) and `nextEmailRetryAt = null` so the cron — which only
  // picks rows with a non-null `nextEmailRetryAt` — never re-selects it
  // and bills another N attempts for the same env-wide misconfig.
  it("provider_unconfigured (initial send): persists attempts row as skipped/provider_not_configured with nextEmailRetryAt=null and emailAttempts=0", async () => {
    emailMock.mockRejectedValueOnce(new Error("SMTP host not configured"));
    const paymentId = nextPaymentId("provider_unconfigured_initial");
    const result = await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId, refundId: "rfnd_pu_init", amount: 175, currency: "INR",
    });
    expect(result.email.status).toBe("skipped");
    expect(result.email.error).toBe("provider_not_configured");

    const [row] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    expect(row.emailStatus).toBe("skipped");
    expect(row.lastEmailError).toBe("provider_not_configured");
    // Skip is a routing decision, not a delivery attempt.
    expect(row.emailAttempts).toBe(0);
    // The cron sweeps rows by `nextEmailRetryAt <= now`; null guarantees
    // the env-misconfig dispatch never gets re-billed.
    expect(row.nextEmailRetryAt).toBeNull();
  });

  // Task #1502 / Task #1850 — provider_unconfigured branch on the retry
  // pipeline (lib line 762). The retry helper must:
  //   1. stamp `emailStatus = "skipped"` and `lastEmailError = "provider_not_configured"`,
  //   2. clear `nextEmailRetryAt` so the cron drops the row,
  //   3. NOT increment `emailAttempts` (the skip is a routing decision, not
  //      a delivery attempt).
  it("retryWalletTopupRefundEmail provider_unconfigured: stamps skipped/provider_not_configured, clears nextEmailRetryAt, leaves attempts unchanged", async () => {
    emailMock.mockRejectedValueOnce(new Error("transient SMTP"));
    const paymentId = nextPaymentId("provider_unconfigured_retry");
    await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId, refundId: "rfnd_pu_retry", amount: 410, currency: "INR",
    });

    const [row] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    expect(row.emailStatus).toBe("failed");
    expect(row.emailAttempts).toBe(1);
    const attemptsBefore = row.emailAttempts;

    emailMock.mockReset();
    emailMock.mockRejectedValueOnce(new Error("RESEND_API_KEY not set"));
    const ret = await retryWalletTopupRefundEmail({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret).not.toBeNull();
    expect(ret!.status).toBe("skipped");
    expect(ret!.error).toBe("provider_not_configured");
    // attempts surfaced on the result reflects the *previous* count: the
    // skip is not a delivery attempt, so the budget stays at 1.
    expect(ret!.attempts).toBe(attemptsBefore);
    expect(ret!.exhausted).toBe(false);

    const [after] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    expect(after.emailStatus).toBe("skipped");
    expect(after.lastEmailError).toBe("provider_not_configured");
    // emailAttempts must NOT have been incremented.
    expect(after.emailAttempts).toBe(attemptsBefore);
    // The cron termination contract: nextEmailRetryAt cleared, exhaustion
    // stamp NOT set (this is a misconfig, not a budget cap).
    expect(after.nextEmailRetryAt).toBeNull();
    expect(after.emailRetryExhaustedAt).toBeNull();

    emailMock.mockReset();
    emailMock.mockResolvedValue(undefined as unknown as void);
  });

  it("retryWalletTopupRefundEmail returns null when the backoff window has not elapsed", async () => {
    emailMock.mockRejectedValueOnce(new Error("SMTP down"));
    const paymentId = nextPaymentId("backoff");
    await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId, refundId: "rfnd_bo", amount: 290, currency: "INR",
    });

    const [row] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    // Same instant as the original send → window not elapsed yet.
    const ret = await retryWalletTopupRefundEmail({ attempt: row, now: new Date() });
    expect(ret).toBeNull();
    expect(emailMock).toHaveBeenCalledTimes(1);
  });

  it("retryWalletTopupRefundEmail stamps emailRetryExhaustedAt after the cap is reached", async () => {
    emailMock.mockRejectedValue(new Error("SMTP perm"));
    const paymentId = nextPaymentId("exhaust");
    await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId, refundId: "rfnd_ex", amount: 360, currency: "INR",
    });

    let now = new Date();
    for (let i = 0; i < WALLET_TOPUP_REFUND_NOTIFY_MAX_EMAIL_ATTEMPTS; i++) {
      const [row] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
        .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
      now = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const ret = await retryWalletTopupRefundEmail({ attempt: row, now });
      if (!ret) break;
    }
    const [row] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    expect(row.emailAttempts).toBe(WALLET_TOPUP_REFUND_NOTIFY_MAX_EMAIL_ATTEMPTS);
    expect(row.emailStatus).toBe("failed");
    expect(row.emailRetryExhaustedAt).toBeTruthy();
    expect(row.nextEmailRetryAt).toBeNull();
    emailMock.mockReset();
    emailMock.mockResolvedValue(undefined as unknown as void);
  });

  it("retryWalletTopupRefundEmail returns null once status flips off 'failed'", async () => {
    const paymentId = nextPaymentId("done");
    await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId, refundId: "rfnd_done", amount: 200, currency: "INR",
    });
    const [row] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    expect(row.emailStatus).toBe("sent");
    const ret = await retryWalletTopupRefundEmail({
      attempt: row, now: new Date(Date.now() + 60 * 60 * 1000),
    });
    expect(ret).toBeNull();
  });

  it("retryFailedWalletTopupRefundEmailPush only picks up due rows and dispatches each channel", async () => {
    // Row A: email failed, due → must be retried.
    emailMock.mockRejectedValueOnce(new Error("transient A"));
    const paymentA = nextPaymentId("cron_a");
    await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId: paymentA, refundId: "rfnd_a", amount: 510, currency: "INR",
    });
    await db.update(walletTopupRefundNotifyAttemptsTable).set({
      nextEmailRetryAt: new Date(Date.now() - 60 * 60 * 1000),
    }).where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentA));

    // Row B: email failed, NOT due (next retry far in future) → cron must skip.
    emailMock.mockRejectedValueOnce(new Error("transient B"));
    const paymentB = nextPaymentId("cron_b");
    await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId: paymentB, refundId: "rfnd_b", amount: 520, currency: "INR",
    });
    await db.update(walletTopupRefundNotifyAttemptsTable).set({
      nextEmailRetryAt: new Date(Date.now() + 60 * 60 * 1000),
    }).where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentB));

    emailMock.mockClear();
    emailMock.mockResolvedValueOnce(undefined as unknown as void);

    await retryFailedWalletTopupRefundEmailPush();

    // Exactly one email retry happened (Row A); Row B was filtered out.
    expect(emailMock).toHaveBeenCalledTimes(1);
    const aRow = (await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentA)))[0];
    const bRow = (await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentB)))[0];
    expect(aRow.emailStatus).toBe("sent");
    expect(aRow.emailAttempts).toBe(2);
    expect(bRow.emailStatus).toBe("failed");
    expect(bRow.emailAttempts).toBe(1);
  });

  // ── Task #1508 — SMS / WhatsApp retry coverage ─────────────────────────
  // The original notify wired SMS / WhatsApp but neither channel had a
  // retry path: a transient Twilio outage on the very first try silently
  // dropped the only refund SMS the (opted-in) member ever got. These
  // tests cover the persist + retry-clears + opt-out paths added in
  // Task #1508 for both new channels.
  async function enableBillingSmsAndWhatsapp() {
    await db.insert(memberCommPrefsTable).values({
      organizationId: orgId,
      clubMemberId,
      category: "billing",
      emailEnabled: true,
      smsEnabled: true,
      whatsappEnabled: true,
      pushEnabled: true,
    });
  }

  it("persists smsStatus=failed + nextSmsRetryAt when SMS provider throws on initial send", async () => {
    await enableBillingSmsAndWhatsapp();
    smsMock.mockRejectedValueOnce(new Error("Twilio 503 Service Unavailable"));
    const paymentId = nextPaymentId("sms_first_fail");
    await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId, refundId: "rfnd_sms1", amount: 250, currency: "INR",
    });

    const [row] = await db.select()
      .from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    expect(row).toBeDefined();
    expect(row.smsStatus).toBe("failed");
    expect(row.smsAttempts).toBe(1);
    expect(row.lastSmsError).toMatch(/Twilio 503/);
    expect(row.nextSmsRetryAt).toBeTruthy();
    expect(row.smsRetryExhaustedAt).toBeNull();
  });

  it("retryWalletTopupRefundSms clears nextSmsRetryAt and bumps attempts on a successful retry", async () => {
    await enableBillingSmsAndWhatsapp();
    smsMock.mockRejectedValueOnce(new Error("transient SMS"));
    const paymentId = nextPaymentId("sms_retry_ok");
    await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId, refundId: "rfnd_sms_ok", amount: 320, currency: "INR",
    });

    let [row] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    expect(row.smsStatus).toBe("failed");

    const ret = await retryWalletTopupRefundSms({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret).not.toBeNull();
    expect(ret!.status).toBe("sent");
    // Initial send + one retry.
    expect(smsMock).toHaveBeenCalledTimes(2);

    [row] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    expect(row.smsStatus).toBe("sent");
    expect(row.smsAttempts).toBe(2);
    expect(row.nextSmsRetryAt).toBeNull();
    expect(row.smsRetryExhaustedAt).toBeNull();
  });

  it("retryWalletTopupRefundSms returns null when the backoff window has not elapsed", async () => {
    await enableBillingSmsAndWhatsapp();
    smsMock.mockRejectedValueOnce(new Error("SMS down"));
    const paymentId = nextPaymentId("sms_backoff");
    await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId, refundId: "rfnd_sms_bo", amount: 290, currency: "INR",
    });
    const [row] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    const ret = await retryWalletTopupRefundSms({ attempt: row, now: new Date() });
    expect(ret).toBeNull();
    expect(smsMock).toHaveBeenCalledTimes(1);
  });

  it("retryWalletTopupRefundSms stamps smsRetryExhaustedAt after the cap is reached", async () => {
    await enableBillingSmsAndWhatsapp();
    smsMock.mockRejectedValue(new Error("SMS perm"));
    const paymentId = nextPaymentId("sms_exhaust");
    await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId, refundId: "rfnd_sms_ex", amount: 360, currency: "INR",
    });

    let now = new Date();
    for (let i = 0; i < WALLET_TOPUP_REFUND_NOTIFY_MAX_SMS_ATTEMPTS; i++) {
      const [row] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
        .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
      now = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const ret = await retryWalletTopupRefundSms({ attempt: row, now });
      if (!ret) break;
    }
    const [row] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    expect(row.smsAttempts).toBe(WALLET_TOPUP_REFUND_NOTIFY_MAX_SMS_ATTEMPTS);
    expect(row.smsStatus).toBe("failed");
    expect(row.smsRetryExhaustedAt).toBeTruthy();
    expect(row.nextSmsRetryAt).toBeNull();
    smsMock.mockReset();
    smsMock.mockResolvedValue(undefined as unknown as void);
  });

  it("retryWalletTopupRefundSms flips status to skipped when SMS provider is unconfigured", async () => {
    await enableBillingSmsAndWhatsapp();
    smsMock.mockRejectedValueOnce(new Error("transient SMS"));
    const paymentId = nextPaymentId("sms_no_provider");
    await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId, refundId: "rfnd_sms_np", amount: 410, currency: "INR",
    });
    const [row] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    smsMock.mockRejectedValueOnce(
      new Error("SMS_PROVIDER not configured. Set SMS_PROVIDER=msg91 or SMS_PROVIDER=twilio with required credentials."),
    );
    const ret = await retryWalletTopupRefundSms({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret).not.toBeNull();
    expect(ret!.status).toBe("skipped");
    expect(ret!.error).toBe("provider_not_configured");

    const [updated] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    expect(updated.smsStatus).toBe("skipped");
    expect(updated.nextSmsRetryAt).toBeNull();
    expect(updated.lastSmsError).toBe("provider_not_configured");
  });

  it("retryWalletTopupRefundSms reports opted_out when the member toggles SMS off between sends", async () => {
    await enableBillingSmsAndWhatsapp();
    smsMock.mockRejectedValueOnce(new Error("transient SMS"));
    const paymentId = nextPaymentId("sms_optout");
    await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId, refundId: "rfnd_sms_oo", amount: 510, currency: "INR",
    });
    const [row] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    expect(row.smsStatus).toBe("failed");

    // Member opts out between the original send and the retry.
    await db.update(memberCommPrefsTable)
      .set({ smsEnabled: false })
      .where(eq(memberCommPrefsTable.clubMemberId, clubMemberId));

    const ret = await retryWalletTopupRefundSms({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret).not.toBeNull();
    expect(ret!.status).toBe("opted_out");
    // The provider must NOT be called again.
    expect(smsMock).toHaveBeenCalledTimes(1);

    const [updated] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    expect(updated.smsStatus).toBe("opted_out");
    expect(updated.nextSmsRetryAt).toBeNull();
  });

  it("persists whatsappStatus=failed + nextWhatsappRetryAt when WhatsApp throws on initial send", async () => {
    await enableBillingSmsAndWhatsapp();
    whatsappMock.mockRejectedValueOnce(new Error("WhatsApp Business 502"));
    const paymentId = nextPaymentId("wa_first_fail");
    await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId, refundId: "rfnd_wa1", amount: 220, currency: "INR",
    });

    const [row] = await db.select()
      .from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    expect(row).toBeDefined();
    expect(row.whatsappStatus).toBe("failed");
    expect(row.whatsappAttempts).toBe(1);
    expect(row.lastWhatsappError).toMatch(/WhatsApp Business 502/);
    expect(row.nextWhatsappRetryAt).toBeTruthy();
    expect(row.whatsappRetryExhaustedAt).toBeNull();
  });

  it("retryWalletTopupRefundWhatsapp clears nextWhatsappRetryAt on a successful retry", async () => {
    await enableBillingSmsAndWhatsapp();
    whatsappMock.mockRejectedValueOnce(new Error("transient WA"));
    const paymentId = nextPaymentId("wa_retry_ok");
    await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId, refundId: "rfnd_wa_ok", amount: 280, currency: "INR",
    });

    let [row] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    expect(row.whatsappStatus).toBe("failed");

    const ret = await retryWalletTopupRefundWhatsapp({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret).not.toBeNull();
    expect(ret!.status).toBe("sent");
    expect(whatsappMock).toHaveBeenCalledTimes(2);

    [row] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    expect(row.whatsappStatus).toBe("sent");
    expect(row.whatsappAttempts).toBe(2);
    expect(row.nextWhatsappRetryAt).toBeNull();
    expect(row.whatsappRetryExhaustedAt).toBeNull();
  });

  it("retryWalletTopupRefundWhatsapp flips status to skipped when WhatsApp provider is unconfigured", async () => {
    await enableBillingSmsAndWhatsapp();
    whatsappMock.mockRejectedValueOnce(new Error("transient WA"));
    const paymentId = nextPaymentId("wa_no_provider");
    await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId, refundId: "rfnd_wa_np", amount: 470, currency: "INR",
    });
    const [row] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    whatsappMock.mockRejectedValueOnce(
      new Error("WHATSAPP_PROVIDER not configured. Set WHATSAPP_PROVIDER=msg91 or WHATSAPP_PROVIDER=twilio with required credentials."),
    );
    const ret = await retryWalletTopupRefundWhatsapp({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret).not.toBeNull();
    expect(ret!.status).toBe("skipped");
    expect(ret!.error).toBe("provider_not_configured");

    const [updated] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    expect(updated.whatsappStatus).toBe("skipped");
    expect(updated.nextWhatsappRetryAt).toBeNull();
    expect(updated.lastWhatsappError).toBe("provider_not_configured");
  });

  it("retryWalletTopupRefundWhatsapp stamps whatsappRetryExhaustedAt after the cap is reached", async () => {
    await enableBillingSmsAndWhatsapp();
    whatsappMock.mockRejectedValue(new Error("WA perm"));
    const paymentId = nextPaymentId("wa_exhaust");
    await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId, refundId: "rfnd_wa_ex", amount: 380, currency: "INR",
    });

    let now = new Date();
    for (let i = 0; i < WALLET_TOPUP_REFUND_NOTIFY_MAX_WHATSAPP_ATTEMPTS; i++) {
      const [row] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
        .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
      now = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const ret = await retryWalletTopupRefundWhatsapp({ attempt: row, now });
      if (!ret) break;
    }
    const [row] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    expect(row.whatsappAttempts).toBe(WALLET_TOPUP_REFUND_NOTIFY_MAX_WHATSAPP_ATTEMPTS);
    expect(row.whatsappStatus).toBe("failed");
    expect(row.whatsappRetryExhaustedAt).toBeTruthy();
    expect(row.nextWhatsappRetryAt).toBeNull();
    whatsappMock.mockReset();
    whatsappMock.mockResolvedValue(null);
  });

  it("retryFailedWalletTopupRefundEmailPush sweeps SMS + WhatsApp due rows alongside email/push", async () => {
    await enableBillingSmsAndWhatsapp();
    // Row C: SMS failed + due → must be retried.
    smsMock.mockRejectedValueOnce(new Error("transient SMS C"));
    const paymentC = nextPaymentId("cron_sms_c");
    await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId: paymentC, refundId: "rfnd_c", amount: 610, currency: "INR",
    });
    await db.update(walletTopupRefundNotifyAttemptsTable).set({
      nextSmsRetryAt: new Date(Date.now() - 60 * 60 * 1000),
    }).where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentC));

    // Row D: WhatsApp failed + due → must be retried.
    whatsappMock.mockRejectedValueOnce(new Error("transient WA D"));
    const paymentD = nextPaymentId("cron_wa_d");
    await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId: paymentD, refundId: "rfnd_d", amount: 620, currency: "INR",
    });
    await db.update(walletTopupRefundNotifyAttemptsTable).set({
      nextWhatsappRetryAt: new Date(Date.now() - 60 * 60 * 1000),
    }).where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentD));

    smsMock.mockClear();
    whatsappMock.mockClear();
    smsMock.mockResolvedValueOnce(undefined as unknown as void);
    whatsappMock.mockResolvedValueOnce(null);

    await retryFailedWalletTopupRefundEmailPush();

    expect(smsMock).toHaveBeenCalledTimes(1);
    expect(whatsappMock).toHaveBeenCalledTimes(1);

    const [cRow] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentC));
    const [dRow] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentD));
    expect(cRow.smsStatus).toBe("sent");
    expect(cRow.smsAttempts).toBe(2);
    expect(cRow.nextSmsRetryAt).toBeNull();
    expect(dRow.whatsappStatus).toBe("sent");
    expect(dRow.whatsappAttempts).toBe(2);
    expect(dRow.nextWhatsappRetryAt).toBeNull();
  });

  it("retryWalletTopupRefundPush respects preferPush opt-out at retry time", async () => {
    pushMock.mockResolvedValueOnce({ attempted: 1, sent: 0, failed: 1, invalid: 0 });
    const paymentId = nextPaymentId("push_oo");
    await notifyWalletTopupAutoRefunded({
      organizationId: orgId, userId, paymentId, refundId: "rfnd_poo", amount: 410, currency: "INR",
    });
    let [row] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    expect(row.pushStatus).toBe("failed");

    // User opts out between the original send and the retry — retry must
    // honour it instead of pinging again.
    await db.insert(userNotificationPrefsTable).values({
      userId, preferEmail: true, preferPush: false,
    });
    const ret = await retryWalletTopupRefundPush({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret).not.toBeNull();
    expect(ret!.status).toBe("opted_out");
    expect(pushMock).toHaveBeenCalledTimes(1);

    [row] = await db.select().from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.paymentId, paymentId));
    expect(row.pushStatus).toBe("opted_out");
    expect(row.nextPushRetryAt).toBeNull();
  });
});
