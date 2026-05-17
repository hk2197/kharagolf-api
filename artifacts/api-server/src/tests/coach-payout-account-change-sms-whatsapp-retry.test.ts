/**
 * Task #1864 — coach payout-account change SMS / WhatsApp retry pipeline.
 *
 * Mirrors `wallet-topup-refund-sms-whatsapp-notify.test.ts` (Task #1508)
 * and `coach-payout-account-change-notify-retry.test.ts` (Task #1280):
 *
 *   - billing-category opt-in (`member_comm_prefs.smsEnabled` /
 *     `whatsappEnabled`) gates whether the leg fires; default is OFF;
 *   - the coach's phone is loaded from `club_members.phone` for
 *     `(orgId, coachUserId)`;
 *   - persists `sms_status="failed"` + `next_sms_retry_at` on the
 *     initial Twilio failure (and the equivalent for WhatsApp);
 *   - `retryCoachPayoutAccountChangeSms` clears `next_sms_retry_at`
 *     and stamps `sms_attempts++` on a successful retry;
 *   - re-checking the opt-in: a coach who flips `smsEnabled=false`
 *     between the original send and the retry gets `opted_out` (no
 *     phone re-fire);
 *   - `SMS_PROVIDER not configured` (and the equivalent
 *     `WHATSAPP_PROVIDER not configured`) flips the row to terminal
 *     `skipped` so the cron stops re-selecting it;
 *   - exhausting the cap stamps `sms_retry_exhausted_at` /
 *     `whatsapp_retry_exhausted_at` and clears the next-retry-at so the
 *     cron stops re-selecting it;
 *   - the cron sweep (`retryFailedCoachPayoutAccountChangeEmailPush`)
 *     picks up due SMS / WhatsApp rows and runs the retry helpers.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendCoachPayoutAccountChangedEmail: vi.fn(async () => undefined),
    sendCoachPayoutAccountChangedAdminEmail: vi.fn(async () => undefined),
  };
});
vi.mock("../lib/push.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/push.js")>();
  return {
    ...actual,
    sendPushToUsers: vi.fn(async () => ({ attempted: 1, sent: 1, failed: 0, invalid: 0 })),
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
  teachingProsTable,
  coachPayoutAccountHistoryTable,
  coachPayoutAccountChangeNotifyAttemptsTable,
  memberCommPrefsTable,
  memberMessagesTable,
  notificationDigestQueueTable,
  notificationAuditLogTable,
  userNotificationPrefsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  notifyCoachPayoutAccountChanged,
  retryCoachPayoutAccountChangeSms,
  retryCoachPayoutAccountChangeWhatsapp,
  COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_SMS_ATTEMPTS,
  COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_WHATSAPP_ATTEMPTS,
} from "../lib/coachPayoutAccountChangeNotify.js";
import { retryFailedCoachPayoutAccountChangeEmailPush } from "../lib/cron.js";
import { sendTransactionalSms, sendTransactionalWhatsapp } from "../lib/comms.js";
import { sendCoachPayoutAccountChangedEmail } from "../lib/mailer.js";
import { sendPushToUsers } from "../lib/push.js";

const smsMock = vi.mocked(sendTransactionalSms);
const waMock = vi.mocked(sendTransactionalWhatsapp);
const emailMock = vi.mocked(sendCoachPayoutAccountChangedEmail);
const pushMock = vi.mocked(sendPushToUsers);

const PHONE = "+919812345670";

let orgId: number;
let coachUserId: number;
let proId: number;
let clubMemberId: number;
const createdHistoryIds: number[] = [];

let counter = 0;
function uniq(label: string): string {
  counter++;
  return `${label}_${Date.now()}_${counter}_${Math.random().toString(36).slice(2, 8)}`;
}

async function makeHistoryRow(opts: {
  changeKind?: "created" | "updated";
  method?: "upi" | "bank_account";
} = {}): Promise<number> {
  const method = opts.method ?? "upi";
  const [h] = await db.insert(coachPayoutAccountHistoryTable).values({
    proId,
    organizationId: orgId,
    changedByUserId: coachUserId,
    changedByRole: "coach",
    changeKind: opts.changeKind ?? "updated",
    method,
    accountHolderName: "SMS Coach",
    upiVpaMasked: method === "upi" ? "te****@ybl" : null,
    bankAccountLast4: method === "bank_account" ? "9876" : null,
    bankIfsc: method === "bank_account" ? "HDFC0001234" : null,
    ipAddress: "10.0.0.2",
    userAgent: "vitest",
  }).returning({ id: coachPayoutAccountHistoryTable.id });
  createdHistoryIds.push(h.id);
  return h.id;
}

async function setBillingPref(opts: { sms?: boolean; whatsapp?: boolean }) {
  await db.delete(memberCommPrefsTable).where(and(
    eq(memberCommPrefsTable.clubMemberId, clubMemberId),
    eq(memberCommPrefsTable.category, "billing"),
  ));
  await db.insert(memberCommPrefsTable).values({
    clubMemberId,
    organizationId: orgId,
    category: "billing",
    emailEnabled: true,
    smsEnabled: !!opts.sms,
    whatsappEnabled: !!opts.whatsapp,
  });
}

beforeAll(async () => {
  const stamp = uniq("t1864cp");
  const [org] = await db.insert(organizationsTable).values({
    name: `Org ${stamp}`, slug: stamp,
  }).returning();
  orgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `coach-sms-${stamp}`,
    username: `cs_${stamp}`,
    email: `${stamp}@example.com`,
    displayName: "SMS Coach",
    role: "player",
  }).returning();
  coachUserId = user.id;

  const [pro] = await db.insert(teachingProsTable).values({
    organizationId: orgId,
    userId: coachUserId,
    displayName: `Coach ${stamp}`,
  }).returning();
  proId = pro.id;

  const [cm] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId: coachUserId,
    firstName: "SMS",
    lastName: "Coach",
    email: `cm-${stamp}@example.com`,
    phone: PHONE,
  }).returning({ id: clubMembersTable.id });
  clubMemberId = cm.id;
});

afterAll(async () => {
  // Wait one tick so any in-flight admin-notify background tasks finish.
  await new Promise((r) => setTimeout(r, 100));

  if (createdHistoryIds.length > 0) {
    await db.delete(coachPayoutAccountChangeNotifyAttemptsTable).where(inArray(coachPayoutAccountChangeNotifyAttemptsTable.historyId, createdHistoryIds));
    await db.delete(coachPayoutAccountHistoryTable).where(inArray(coachPayoutAccountHistoryTable.id, createdHistoryIds));
  }
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.clubMemberId, clubMemberId));
  await db.delete(memberCommPrefsTable).where(eq(memberCommPrefsTable.clubMemberId, clubMemberId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.id, clubMemberId));
  await db.delete(notificationDigestQueueTable).where(eq(notificationDigestQueueTable.notificationKey, "coach.payout.account.changed.admin"));
  await db.delete(notificationAuditLogTable).where(eq(notificationAuditLogTable.notificationKey, "coach.payout.account.changed.admin"));
  await db.delete(notificationAuditLogTable).where(and(
    eq(notificationAuditLogTable.notificationKey, "coach.payout.account.changed.coach"),
    eq(notificationAuditLogTable.userId, coachUserId),
  ));
  await db.delete(teachingProsTable).where(eq(teachingProsTable.id, proId));
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, coachUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, coachUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  smsMock.mockReset();
  waMock.mockReset();
  emailMock.mockReset();
  pushMock.mockReset();
  smsMock.mockResolvedValue(undefined as unknown as void);
  waMock.mockResolvedValue("wa-msg-id" as unknown as string);
  emailMock.mockResolvedValue(undefined as unknown as void);
  pushMock.mockResolvedValue({ attempted: 1, sent: 1, failed: 0, invalid: 0 });
  await db.delete(memberCommPrefsTable).where(eq(memberCommPrefsTable.clubMemberId, clubMemberId));
});

describe("Task #1864 — coach payout-account change SMS retry", () => {
  it("persists sms_status=failed and stamps next_sms_retry_at on first Twilio failure", async () => {
    await setBillingPref({ sms: true });
    smsMock.mockRejectedValueOnce(new Error("Twilio 503 service unavailable"));

    const historyId = await makeHistoryRow();
    const r = await notifyCoachPayoutAccountChanged(historyId);
    expect(r.sms.status).toBe("failed");
    expect(r.sms.error).toMatch(/Twilio/);

    const [row] = await db.select()
      .from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(row).toBeDefined();
    expect(row.smsStatus).toBe("failed");
    expect(row.smsAttempts).toBe(1);
    expect(row.lastSmsError).toMatch(/Twilio/);
    expect(row.nextSmsRetryAt).toBeTruthy();
    expect(row.smsRetryExhaustedAt).toBeNull();
  });

  it("clears next_sms_retry_at and bumps sms_attempts on a successful retry", async () => {
    await setBillingPref({ sms: true });
    smsMock.mockRejectedValueOnce(new Error("transient"));

    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);
    const [before] = await db.select()
      .from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(before.smsStatus).toBe("failed");
    expect(before.smsAttempts).toBe(1);

    smsMock.mockResolvedValueOnce(undefined as unknown as void);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const ret = await retryCoachPayoutAccountChangeSms({ attempt: before, now: future });
    expect(ret).not.toBeNull();
    expect(ret!.status).toBe("sent");

    const [after] = await db.select()
      .from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(after.smsStatus).toBe("sent");
    expect(after.smsAttempts).toBe(2);
    expect(after.nextSmsRetryAt).toBeNull();
    expect(after.lastSmsError).toBeNull();
  });

  it("exhausts the SMS retry cap and stamps sms_retry_exhausted_at", async () => {
    await setBillingPref({ sms: true });
    smsMock.mockRejectedValue(new Error("provider down"));

    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);

    let last = await db.select()
      .from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId))
      .then((rows) => rows[0]);

    for (let attempt = 2; attempt <= COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_SMS_ATTEMPTS; attempt++) {
      const future = new Date(Date.now() + attempt * 24 * 60 * 60 * 1000);
      const r = await retryCoachPayoutAccountChangeSms({ attempt: last, now: future });
      expect(r).not.toBeNull();
      last = await db.select()
        .from(coachPayoutAccountChangeNotifyAttemptsTable)
        .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId))
        .then((rows) => rows[0]);
    }

    expect(last.smsAttempts).toBe(COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_SMS_ATTEMPTS);
    expect(last.smsStatus).toBe("failed");
    expect(last.smsRetryExhaustedAt).toBeTruthy();
    expect(last.nextSmsRetryAt).toBeNull();

    // Subsequent retry calls return null — cap reached.
    const past = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const noop = await retryCoachPayoutAccountChangeSms({ attempt: last, now: past });
    expect(noop).toBeNull();
  });

  it("retries to opted_out when the coach toggles billing.smsEnabled off between sends", async () => {
    await setBillingPref({ sms: true });
    smsMock.mockRejectedValueOnce(new Error("Twilio blip"));

    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);
    const [row] = await db.select()
      .from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(row.smsStatus).toBe("failed");

    // Coach opts out before the cron's next pass.
    await setBillingPref({ sms: false });
    smsMock.mockClear();

    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const r = await retryCoachPayoutAccountChangeSms({ attempt: row, now: future });
    expect(r!.status).toBe("opted_out");
    expect(smsMock).not.toHaveBeenCalled();

    const [after] = await db.select()
      .from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(after.smsStatus).toBe("opted_out");
    expect(after.nextSmsRetryAt).toBeNull();
  });

  it("flips to terminal skipped when SMS_PROVIDER is not configured", async () => {
    await setBillingPref({ sms: true });
    smsMock.mockRejectedValueOnce(new Error("Twilio outage"));

    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);
    const [row] = await db.select()
      .from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(row.smsStatus).toBe("failed");

    smsMock.mockRejectedValueOnce(new Error("SMS_PROVIDER not configured"));
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const r = await retryCoachPayoutAccountChangeSms({ attempt: row, now: future });
    expect(r!.status).toBe("skipped");
    expect(r!.error).toBe("provider_not_configured");

    const [after] = await db.select()
      .from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(after.smsStatus).toBe("skipped");
    expect(after.lastSmsError).toBe("provider_not_configured");
    expect(after.nextSmsRetryAt).toBeNull();
  });
});

describe("Task #1864 — coach payout-account change WhatsApp retry", () => {
  it("persists whatsapp_status=failed on first failure and recovers on retry", async () => {
    await setBillingPref({ whatsapp: true });
    waMock.mockRejectedValueOnce(new Error("WhatsApp Business 502"));

    const historyId = await makeHistoryRow();
    const r = await notifyCoachPayoutAccountChanged(historyId);
    expect(r.whatsapp.status).toBe("failed");

    const [row] = await db.select()
      .from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(row.whatsappStatus).toBe("failed");
    expect(row.whatsappAttempts).toBe(1);
    expect(row.nextWhatsappRetryAt).toBeTruthy();

    waMock.mockResolvedValueOnce("wa-ok" as unknown as string);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const ret = await retryCoachPayoutAccountChangeWhatsapp({ attempt: row, now: future });
    expect(ret!.status).toBe("sent");

    const [after] = await db.select()
      .from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(after.whatsappStatus).toBe("sent");
    expect(after.whatsappAttempts).toBe(2);
    expect(after.nextWhatsappRetryAt).toBeNull();
  });

  it("flips to terminal skipped when WHATSAPP_PROVIDER is not configured", async () => {
    await setBillingPref({ whatsapp: true });
    waMock.mockRejectedValueOnce(new Error("network blip"));

    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);
    const [row] = await db.select()
      .from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(row.whatsappStatus).toBe("failed");

    waMock.mockRejectedValueOnce(new Error("WHATSAPP_PROVIDER not configured"));
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const r = await retryCoachPayoutAccountChangeWhatsapp({ attempt: row, now: future });
    expect(r!.status).toBe("skipped");
    expect(r!.error).toBe("provider_not_configured");

    const [after] = await db.select()
      .from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(after.whatsappStatus).toBe("skipped");
    expect(after.lastWhatsappError).toBe("provider_not_configured");
    expect(after.nextWhatsappRetryAt).toBeNull();
    expect(after.whatsappRetryExhaustedAt).toBeNull();
  });

  it("exhausts the WhatsApp retry cap", async () => {
    await setBillingPref({ whatsapp: true });
    waMock.mockRejectedValue(new Error("provider down"));

    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);
    let last = await db.select()
      .from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId))
      .then((rows) => rows[0]);

    for (let attempt = 2; attempt <= COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_WHATSAPP_ATTEMPTS; attempt++) {
      const future = new Date(Date.now() + attempt * 24 * 60 * 60 * 1000);
      const r = await retryCoachPayoutAccountChangeWhatsapp({ attempt: last, now: future });
      expect(r).not.toBeNull();
      last = await db.select()
        .from(coachPayoutAccountChangeNotifyAttemptsTable)
        .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId))
        .then((rows) => rows[0]);
    }

    expect(last.whatsappAttempts).toBe(COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_WHATSAPP_ATTEMPTS);
    expect(last.whatsappStatus).toBe("failed");
    expect(last.whatsappRetryExhaustedAt).toBeTruthy();
    expect(last.nextWhatsappRetryAt).toBeNull();
  });
});

describe("Task #1864 — cron sweep dispatches SMS / WhatsApp retries", () => {
  it("retryFailedCoachPayoutAccountChangeEmailPush picks up due SMS + WhatsApp rows", async () => {
    await setBillingPref({ sms: true, whatsapp: true });
    smsMock.mockRejectedValueOnce(new Error("Twilio blip"));
    waMock.mockRejectedValueOnce(new Error("WhatsApp blip"));

    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);
    const [row] = await db.select()
      .from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(row.smsStatus).toBe("failed");
    expect(row.whatsappStatus).toBe("failed");

    // Make both rows eligible for the cron sweep right now.
    await db.update(coachPayoutAccountChangeNotifyAttemptsTable)
      .set({ nextSmsRetryAt: null, nextWhatsappRetryAt: null })
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.id, row.id));

    smsMock.mockResolvedValueOnce(undefined as unknown as void);
    waMock.mockResolvedValueOnce("wa-ok" as unknown as string);
    await retryFailedCoachPayoutAccountChangeEmailPush();

    const [after] = await db.select()
      .from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(after.smsStatus).toBe("sent");
    expect(after.smsAttempts).toBe(2);
    expect(after.whatsappStatus).toBe("sent");
    expect(after.whatsappAttempts).toBe(2);
    expect(smsMock).toHaveBeenCalledTimes(2);
    expect(waMock).toHaveBeenCalledTimes(2);
  });
});
