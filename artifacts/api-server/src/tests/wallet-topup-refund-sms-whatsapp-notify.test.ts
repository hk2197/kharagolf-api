/**
 * Task #1231 — focused coverage for the SMS + WhatsApp branches of
 * `notifyWalletTopupAutoRefunded` (Task #1068).
 *
 * The original cron-level test (`wallet-topup-refund.test.ts`) mocks the
 * notify helper wholesale, so the new channel logic — phone lookup from
 * `club_members`, billing-category opt-in defaults, provider-not-configured
 * handling, and the per-channel result fields — is uncovered. This file
 * exercises the helper directly so the SMS/WhatsApp behaviour is locked in.
 *
 * Mailer + push are mocked too (we don't want SMTP / Expo I/O), but the
 * notify helper itself runs for real against the live test database.
 *
 * Per-user de-dup is verified via the cron entry point
 * (`refundOrphanedWalletTopups`): a second pass over the same orphaned
 * payment must NOT re-fire the SMS or WhatsApp channels because the
 * audit row already exists and the cron only invokes the notify helper
 * the first time the row is inserted.
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
    sendTransactionalWhatsapp: vi.fn(async () => "wa-msg-id"),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  clubWalletsTable,
  clubWalletTxnsTable,
  memberCommPrefsTable,
  memberMessagesTable,
  userNotificationPrefsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { notifyWalletTopupAutoRefunded } from "../lib/walletTopupRefundNotify.js";
import { refundOrphanedWalletTopups } from "../routes/side-games-v2.js";
import { sendTransactionalSms, sendTransactionalWhatsapp } from "../lib/comms.js";
import { sendWalletTopupAutoRefundedEmail } from "../lib/mailer.js";
import { sendPushToUsers } from "../lib/push.js";

const smsMock = vi.mocked(sendTransactionalSms);
const waMock = vi.mocked(sendTransactionalWhatsapp);
const emailMock = vi.mocked(sendWalletTopupAutoRefundedEmail);
const pushMock = vi.mocked(sendPushToUsers);

const PHONE = "+919812345678";

let orgId: number;
let userWithMember: number;
let userWithMemberNoPhone: number;
let userWithoutMember: number;
let memberId: number;
let memberNoPhoneId: number;

beforeAll(async () => {
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `T1231-${ts}`,
    slug: `t1231-${ts}`,
    contactEmail: `t1231-${ts}@example.test`,
  }).returning();
  orgId = org.id;

  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `ep_t1231a_${ts}`,
    username: `t1231a_${ts}`,
    email: `t1231a_${ts}@example.test`,
    displayName: "Phone Member",
    role: "player",
    organizationId: orgId,
  }).returning();
  userWithMember = u1.id;
  const [m1] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId: userWithMember,
    firstName: "Phone",
    lastName: "Member",
    email: `t1231a_${ts}@example.test`,
    phone: PHONE,
  }).returning();
  memberId = m1.id;

  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `ep_t1231b_${ts}`,
    username: `t1231b_${ts}`,
    email: `t1231b_${ts}@example.test`,
    displayName: "NoPhone Member",
    role: "player",
    organizationId: orgId,
  }).returning();
  userWithMemberNoPhone = u2.id;
  const [m2] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId: userWithMemberNoPhone,
    firstName: "NoPhone",
    lastName: "Member",
    email: `t1231b_${ts}@example.test`,
    phone: null,
  }).returning();
  memberNoPhoneId = m2.id;

  const [u3] = await db.insert(appUsersTable).values({
    replitUserId: `ep_t1231c_${ts}`,
    username: `t1231c_${ts}`,
    email: `t1231c_${ts}@example.test`,
    displayName: "Stranger",
    role: "player",
    organizationId: orgId,
  }).returning();
  userWithoutMember = u3.id;
});

afterAll(async () => {
  const wallets = await db.select({ id: clubWalletsTable.id })
    .from(clubWalletsTable).where(eq(clubWalletsTable.organizationId, orgId));
  if (wallets.length) {
    await db.delete(clubWalletTxnsTable).where(inArray(clubWalletTxnsTable.walletId, wallets.map(w => w.id)));
    await db.delete(clubWalletsTable).where(inArray(clubWalletsTable.id, wallets.map(w => w.id)));
  }
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, orgId));
  await db.delete(memberCommPrefsTable).where(eq(memberCommPrefsTable.organizationId, orgId));
  await db.delete(userNotificationPrefsTable)
    .where(inArray(userNotificationPrefsTable.userId, [userWithMember, userWithMemberNoPhone, userWithoutMember]));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.organizationId, orgId));
  await db.delete(appUsersTable)
    .where(inArray(appUsersTable.id, [userWithMember, userWithMemberNoPhone, userWithoutMember]));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  smsMock.mockClear();
  waMock.mockClear();
  emailMock.mockClear();
  pushMock.mockClear();
  smsMock.mockImplementation(async () => undefined);
  waMock.mockImplementation(async () => "wa-msg-id");
  emailMock.mockImplementation(async () => undefined);
  pushMock.mockImplementation(async () => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 }));
  await db.delete(memberCommPrefsTable).where(eq(memberCommPrefsTable.organizationId, orgId));
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.organizationId, orgId));
  await db.delete(userNotificationPrefsTable)
    .where(inArray(userNotificationPrefsTable.userId, [userWithMember, userWithMemberNoPhone, userWithoutMember]));
  // Reset wallet ledger between tests so the cron-level de-dup test
  // starts from a clean slate.
  const wallets = await db.select({ id: clubWalletsTable.id })
    .from(clubWalletsTable).where(eq(clubWalletsTable.organizationId, orgId));
  if (wallets.length) {
    await db.delete(clubWalletTxnsTable).where(inArray(clubWalletTxnsTable.walletId, wallets.map(w => w.id)));
    await db.delete(clubWalletsTable).where(inArray(clubWalletsTable.id, wallets.map(w => w.id)));
  }
});

async function notify(userId: number, paymentId: string, refundId: string | null = "rfnd_1") {
  return notifyWalletTopupAutoRefunded({
    organizationId: orgId,
    userId,
    paymentId,
    refundId,
    amount: 750,
    currency: "INR",
  });
}

describe("notifyWalletTopupAutoRefunded — SMS channel (Task #1068)", () => {
  it("sends SMS to the club_members phone when billing.smsEnabled is opted in", async () => {
    await db.insert(memberCommPrefsTable).values({
      clubMemberId: memberId,
      organizationId: orgId,
      category: "billing",
      emailEnabled: true,
      smsEnabled: true,
      whatsappEnabled: false,
    });

    const r = await notify(userWithMember, "pay_sms_optin");
    expect(r.sms.status).toBe("sent");
    expect(smsMock).toHaveBeenCalledTimes(1);
    const [phone, body] = smsMock.mock.calls[0];
    expect(phone).toBe(PHONE);
    // Body carries the human-readable refund summary including amount.
    expect(body).toMatch(/750/);
    // Body is trimmed to fit SMS payload limits.
    expect(body.length).toBeLessThanOrEqual(320);
  });

  it("opts out of SMS when the member has a club_members row but no opt-in (defaults off)", async () => {
    // No member_comm_prefs row → schema defaults: sms=off, whatsapp=off.
    const r = await notify(userWithMember, "pay_sms_default");
    expect(r.sms.status).toBe("opted_out");
    expect(smsMock).not.toHaveBeenCalled();
  });

  it("opts out of SMS when billing.smsEnabled is explicitly false", async () => {
    await db.insert(memberCommPrefsTable).values({
      clubMemberId: memberId,
      organizationId: orgId,
      category: "billing",
      emailEnabled: true,
      smsEnabled: false,
      whatsappEnabled: true,
    });

    const r = await notify(userWithMember, "pay_sms_explicit_off");
    expect(r.sms.status).toBe("opted_out");
    expect(smsMock).not.toHaveBeenCalled();
  });

  it("returns no_address for SMS when the club_members row has no phone", async () => {
    await db.insert(memberCommPrefsTable).values({
      clubMemberId: memberNoPhoneId,
      organizationId: orgId,
      category: "billing",
      emailEnabled: true,
      smsEnabled: true,
      whatsappEnabled: true,
    });

    const r = await notify(userWithMemberNoPhone, "pay_sms_no_phone");
    expect(r.sms.status).toBe("no_address");
    expect(smsMock).not.toHaveBeenCalled();
  });

  it("returns no_address for SMS when the user has no club_members row in the org", async () => {
    const r = await notify(userWithoutMember, "pay_sms_no_member");
    expect(r.sms.status).toBe("no_address");
    expect(smsMock).not.toHaveBeenCalled();
  });

  it("flips SMS to skipped (provider_not_configured) when SMS_PROVIDER is missing", async () => {
    await db.insert(memberCommPrefsTable).values({
      clubMemberId: memberId,
      organizationId: orgId,
      category: "billing",
      emailEnabled: true,
      smsEnabled: true,
      whatsappEnabled: false,
    });
    smsMock.mockImplementationOnce(async () => {
      throw new Error("SMS_PROVIDER not configured. Set SMS_PROVIDER=msg91 or SMS_PROVIDER=twilio with required credentials.");
    });

    const r = await notify(userWithMember, "pay_sms_no_provider");
    expect(r.sms.status).toBe("skipped");
    expect(r.sms.error).toBe("provider_not_configured");
  });

  it("flips SMS to failed when the upstream provider call throws an unrelated error", async () => {
    await db.insert(memberCommPrefsTable).values({
      clubMemberId: memberId,
      organizationId: orgId,
      category: "billing",
      emailEnabled: true,
      smsEnabled: true,
      whatsappEnabled: false,
    });
    smsMock.mockImplementationOnce(async () => { throw new Error("MSG91 error: 503"); });

    const r = await notify(userWithMember, "pay_sms_provider_5xx");
    expect(r.sms.status).toBe("failed");
    expect(r.sms.error).toMatch(/MSG91 error: 503/);
  });
});

describe("notifyWalletTopupAutoRefunded — WhatsApp channel (Task #1068)", () => {
  it("sends WhatsApp to the club_members phone when billing.whatsappEnabled is opted in", async () => {
    await db.insert(memberCommPrefsTable).values({
      clubMemberId: memberId,
      organizationId: orgId,
      category: "billing",
      emailEnabled: true,
      smsEnabled: false,
      whatsappEnabled: true,
    });

    const r = await notify(userWithMember, "pay_wa_optin");
    expect(r.whatsapp.status).toBe("sent");
    expect(waMock).toHaveBeenCalledTimes(1);
    const [phone, body] = waMock.mock.calls[0];
    expect(phone).toBe(PHONE);
    expect(body).toMatch(/750/);
    // WhatsApp gets the longer 1024-char allowance.
    expect(body.length).toBeLessThanOrEqual(1024);
  });

  it("opts out of WhatsApp when the member has no opt-in row (defaults off)", async () => {
    const r = await notify(userWithMember, "pay_wa_default");
    expect(r.whatsapp.status).toBe("opted_out");
    expect(waMock).not.toHaveBeenCalled();
  });

  it("opts out of WhatsApp when billing.whatsappEnabled is explicitly false", async () => {
    await db.insert(memberCommPrefsTable).values({
      clubMemberId: memberId,
      organizationId: orgId,
      category: "billing",
      emailEnabled: true,
      smsEnabled: true,
      whatsappEnabled: false,
    });

    const r = await notify(userWithMember, "pay_wa_explicit_off");
    expect(r.whatsapp.status).toBe("opted_out");
    expect(waMock).not.toHaveBeenCalled();
  });

  it("returns no_address for WhatsApp when the club_members row has no phone", async () => {
    await db.insert(memberCommPrefsTable).values({
      clubMemberId: memberNoPhoneId,
      organizationId: orgId,
      category: "billing",
      emailEnabled: true,
      smsEnabled: true,
      whatsappEnabled: true,
    });

    const r = await notify(userWithMemberNoPhone, "pay_wa_no_phone");
    expect(r.whatsapp.status).toBe("no_address");
    expect(waMock).not.toHaveBeenCalled();
  });

  it("returns no_address for WhatsApp when the user has no club_members row in the org", async () => {
    const r = await notify(userWithoutMember, "pay_wa_no_member");
    expect(r.whatsapp.status).toBe("no_address");
    expect(waMock).not.toHaveBeenCalled();
  });

  it("flips WhatsApp to skipped (provider_not_configured) when WHATSAPP_PROVIDER is missing", async () => {
    await db.insert(memberCommPrefsTable).values({
      clubMemberId: memberId,
      organizationId: orgId,
      category: "billing",
      emailEnabled: true,
      smsEnabled: false,
      whatsappEnabled: true,
    });
    waMock.mockImplementationOnce(async () => {
      throw new Error("WHATSAPP_PROVIDER not configured. Set WHATSAPP_PROVIDER=msg91 or WHATSAPP_PROVIDER=twilio with required credentials.");
    });

    const r = await notify(userWithMember, "pay_wa_no_provider");
    expect(r.whatsapp.status).toBe("skipped");
    expect(r.whatsapp.error).toBe("provider_not_configured");
  });

  it("flips WhatsApp to failed when the upstream provider call throws an unrelated error", async () => {
    await db.insert(memberCommPrefsTable).values({
      clubMemberId: memberId,
      organizationId: orgId,
      category: "billing",
      emailEnabled: true,
      smsEnabled: false,
      whatsappEnabled: true,
    });
    waMock.mockImplementationOnce(async () => { throw new Error("MSG91 WhatsApp error: 503"); });

    const r = await notify(userWithMember, "pay_wa_provider_5xx");
    expect(r.whatsapp.status).toBe("failed");
    expect(r.whatsapp.error).toMatch(/MSG91 WhatsApp error: 503/);
  });
});

describe("notifyWalletTopupAutoRefunded — combined channel rollup", () => {
  it("when only SMS+WhatsApp are opted in, both fire and the overall status is 'sent'", async () => {
    await db.insert(memberCommPrefsTable).values({
      clubMemberId: memberId,
      organizationId: orgId,
      category: "billing",
      emailEnabled: true,
      smsEnabled: true,
      whatsappEnabled: true,
    });

    const r = await notify(userWithMember, "pay_both_optin");
    expect(r.sms.status).toBe("sent");
    expect(r.whatsapp.status).toBe("sent");
    expect(r.status).toBe("sent");
    expect(smsMock).toHaveBeenCalledTimes(1);
    expect(waMock).toHaveBeenCalledTimes(1);
  });

  it("a failing SMS does not block WhatsApp from being attempted", async () => {
    await db.insert(memberCommPrefsTable).values({
      clubMemberId: memberId,
      organizationId: orgId,
      category: "billing",
      emailEnabled: true,
      smsEnabled: true,
      whatsappEnabled: true,
    });
    smsMock.mockImplementationOnce(async () => { throw new Error("sms upstream blew up"); });

    const r = await notify(userWithMember, "pay_isolation");
    expect(r.sms.status).toBe("failed");
    expect(r.whatsapp.status).toBe("sent");
    expect(waMock).toHaveBeenCalledTimes(1);
  });
});

describe("refundOrphanedWalletTopups → SMS/WhatsApp per-user de-dup (Task #1068)", () => {
  function makeFakeRazorpay(opts: {
    payments: Array<Record<string, unknown>>;
    refunded: Set<string>;
  }) {
    return {
      payments: {
        all: async () => ({ items: opts.payments }),
        refund: async (paymentId: string) => {
          opts.refunded.add(paymentId);
          return { id: `rfnd_${paymentId}`, payment_id: paymentId };
        },
      },
    } as unknown as ReturnType<typeof import("../lib/razorpay").getRazorpayClient>;
  }

  it("a second cron pass over the same orphan does NOT re-send SMS or WhatsApp", async () => {
    // Opt the member in to all billing channels so SMS+WhatsApp would
    // fire if the cron called notify a second time.
    await db.insert(memberCommPrefsTable).values({
      clubMemberId: memberId,
      organizationId: orgId,
      category: "billing",
      emailEnabled: true,
      smsEnabled: true,
      whatsappEnabled: true,
    });

    const refunded = new Set<string>();
    const payment = {
      id: "pay_dedup_smswa",
      status: "captured",
      amount: 12000, // ₹120
      amount_refunded: 0,
      currency: "INR",
      order_id: "order_dedup_smswa",
      notes: { kind: "wallet_topup", organizationId: String(orgId), userId: String(userWithMember) },
    };
    const fakeRzp = makeFakeRazorpay({ payments: [payment], refunded });

    await refundOrphanedWalletTopups({ razorpayClient: fakeRzp });
    expect(smsMock).toHaveBeenCalledTimes(1);
    expect(waMock).toHaveBeenCalledTimes(1);

    // Second pass: Razorpay now reports the payment as refunded so it
    // would otherwise hit the already-refunded branch. The audit row
    // already exists from the first pass, so notify must be skipped
    // entirely — neither SMS nor WhatsApp should be fired again.
    payment.amount_refunded = 12000;
    await refundOrphanedWalletTopups({ razorpayClient: fakeRzp });
    expect(smsMock).toHaveBeenCalledTimes(1);
    expect(waMock).toHaveBeenCalledTimes(1);

    // Sanity check: only one wallet_topup_refund audit row exists.
    const [wallet] = await db.select().from(clubWalletsTable)
      .where(and(eq(clubWalletsTable.organizationId, orgId), eq(clubWalletsTable.userId, userWithMember)));
    const audits = await db.select().from(clubWalletTxnsTable)
      .where(and(
        eq(clubWalletTxnsTable.walletId, wallet.id),
        eq(clubWalletTxnsTable.sourceType, "wallet_topup_refund"),
        eq(clubWalletTxnsTable.paymentRef, "pay_dedup_smswa"),
      ));
    expect(audits).toHaveLength(1);
  });
});
