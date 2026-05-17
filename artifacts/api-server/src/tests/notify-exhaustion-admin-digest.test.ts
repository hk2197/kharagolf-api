/**
 * Task #1507 — daily admin digest of exhausted wallet/coach-payout notify retries.
 *
 * The new `sendNotifyExhaustionAdminDigest` cron sweeps both
 * `wallet_topup_refund_notify_attempts` and
 * `coach_payout_account_change_notify_attempts` for rows where any
 * `*RetryExhaustedAt` was stamped in the last 24h, groups by org, and
 * emails the org admins (org_admin / membership_secretary / treasurer)
 * with a single digest. Each row gets `adminDigestSentAt` stamped so the
 * next daily run never re-emails the same row.
 *
 * Covered:
 *   1. Rolls up exhausted wallet AND coach rows for an org into a single
 *      digest email per admin recipient.
 *   2. Stamps `adminDigestSentAt` on every included row, even if the
 *      send threw (so a broken inbox never re-fans-out the same digest
 *      forever).
 *   3. Skips rows whose `*RetryExhaustedAt` is older than 24h.
 *   4. Skips rows that already have `adminDigestSentAt` set.
 *   5. Skips orgs with no exhausted rows entirely.
 *   6. Records the digest exactly once even if invoked twice in a row
 *      (the watermark column dedups across runs).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Task #1855 — preserve `classifyMailerError` (and the rest of the
// real mailer surface) so the failure-path branch in
// `sendNotifyExhaustionAdminDigest` can classify SMTP errors without
// hitting an `is not a function` runtime when the test stubs out the
// digest sender. importOriginal() mirrors the
// bounced-levy-reminders-digest-failure test pattern.
vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendNotifyExhaustionAdminDigestEmail: vi.fn(async () => undefined),
  };
});

// Task #1855 — stub push so the super_admin failure-fallback dispatch
// (which fans out via `dispatchNotification` → push + email + audit log)
// does not try to hit FCM during the test run.
vi.mock("../lib/push.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/push.js")>();
  return {
    ...actual,
    sendPushToUsers: vi.fn(async (uids: number[]) => ({
      attempted: uids.length, sent: uids.length, failed: 0, invalid: 0,
    })),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  teachingProsTable,
  coachPayoutAccountHistoryTable,
  walletTopupRefundNotifyAttemptsTable,
  coachPayoutAccountChangeNotifyAttemptsTable,
  notifyExhaustionAdminDigestRecipientSendsTable,
  emailSuppressionsTable,
  notificationAuditLogTable,
} from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";

import { sendNotifyExhaustionAdminDigest } from "../lib/cron.js";
import { sendNotifyExhaustionAdminDigestEmail } from "../lib/mailer.js";
import { hydrate as hydrateRegistry } from "../lib/notificationRegistry.js";
import { _clearSpecCacheForTests } from "../lib/notifyDispatch.js";

const emailMock = vi.mocked(sendNotifyExhaustionAdminDigestEmail);

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];
const createdProIds: number[] = [];
const createdHistoryIds: number[] = [];

let seq = 0;
function tag(label: string): string {
  seq++;
  return `t1507_${label}_${Date.now()}_${seq}`;
}

async function makeOrg(label: string): Promise<number> {
  const t = tag(label);
  const [org] = await db.insert(organizationsTable).values({
    name: `T1507_${label}`,
    slug: t,
    contactEmail: `${t}@example.test`,
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(org.id);
  return org.id;
}

async function makeAdmin(orgId: number, label: string, role: "org_admin" | "treasurer" | "membership_secretary" = "org_admin"): Promise<{ id: number; email: string }> {
  const t = tag(label);
  const email = `${t}@example.test`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: t,
    username: t,
    email,
    displayName: `Admin ${label}`,
    role: role === "org_admin" ? "org_admin" : "player",
    organizationId: role === "org_admin" ? orgId : null,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  if (role !== "org_admin") {
    await db.insert(orgMembershipsTable).values({
      organizationId: orgId,
      userId: u.id,
      role,
    });
  }
  return { id: u.id, email };
}

async function makeMemberUser(orgId: number, label: string): Promise<number> {
  const t = tag(label);
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: t,
    username: t,
    email: `${t}@example.test`,
    displayName: `Member ${label}`,
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return u.id;
}

async function makePro(orgId: number, displayName: string): Promise<number> {
  const [p] = await db.insert(teachingProsTable).values({
    organizationId: orgId,
    displayName,
    email: `${tag("pro")}@example.test`,
  }).returning({ id: teachingProsTable.id });
  createdProIds.push(p.id);
  return p.id;
}

async function makeWalletAttempt(opts: {
  orgId: number;
  userId: number;
  paymentId: string;
  emailExhaustedAt?: Date | null;
  pushExhaustedAt?: Date | null;
  adminDigestSentAt?: Date | null;
  lastEmailError?: string | null;
}): Promise<number> {
  const [r] = await db.insert(walletTopupRefundNotifyAttemptsTable).values({
    paymentId: opts.paymentId,
    organizationId: opts.orgId,
    userId: opts.userId,
    refundId: `rfnd_${opts.paymentId}`,
    amount: "1234.56",
    currency: "INR",
    emailStatus: opts.emailExhaustedAt ? "failed" : null,
    emailAttempts: opts.emailExhaustedAt ? 5 : 0,
    lastEmailError: opts.lastEmailError ?? null,
    emailRetryExhaustedAt: opts.emailExhaustedAt ?? null,
    pushStatus: opts.pushExhaustedAt ? "failed" : null,
    pushAttempts: opts.pushExhaustedAt ? 5 : 0,
    pushRetryExhaustedAt: opts.pushExhaustedAt ?? null,
    adminDigestSentAt: opts.adminDigestSentAt ?? null,
  }).returning({ id: walletTopupRefundNotifyAttemptsTable.id });
  return r.id;
}

async function makeCoachAttempt(opts: {
  orgId: number;
  proId: number;
  coachUserId: number;
  emailExhaustedAt?: Date | null;
  pushExhaustedAt?: Date | null;
  adminDigestSentAt?: Date | null;
}): Promise<{ historyId: number; attemptId: number }> {
  const [hist] = await db.insert(coachPayoutAccountHistoryTable).values({
    proId: opts.proId,
    organizationId: opts.orgId,
    changedByRole: "coach",
    changeKind: "updated",
    method: "upi",
    accountHolderName: "Test Coach",
    upiVpaMasked: "te****@upi",
  }).returning({ id: coachPayoutAccountHistoryTable.id });
  createdHistoryIds.push(hist.id);

  const [r] = await db.insert(coachPayoutAccountChangeNotifyAttemptsTable).values({
    historyId: hist.id,
    organizationId: opts.orgId,
    proId: opts.proId,
    coachUserId: opts.coachUserId,
    changeKind: "updated",
    method: "upi",
    emailStatus: opts.emailExhaustedAt ? "failed" : null,
    emailAttempts: opts.emailExhaustedAt ? 5 : 0,
    emailRetryExhaustedAt: opts.emailExhaustedAt ?? null,
    pushStatus: opts.pushExhaustedAt ? "failed" : null,
    pushAttempts: opts.pushExhaustedAt ? 5 : 0,
    pushRetryExhaustedAt: opts.pushExhaustedAt ?? null,
    adminDigestSentAt: opts.adminDigestSentAt ?? null,
  }).returning({ id: coachPayoutAccountChangeNotifyAttemptsTable.id });
  return { historyId: hist.id, attemptId: r.id };
}

// Track super_admins separately so the audit-row teardown can wipe
// rows for them too (created users live in `createdUserIds`).
const createdSuperAdminIds: number[] = [];

async function makeSuperAdmin(label: string): Promise<number> {
  const t = tag(label);
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: t,
    username: t,
    email: `${t}@example.test`,
    displayName: `Super ${label}`,
    role: "super_admin",
    organizationId: null,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  createdSuperAdminIds.push(u.id);
  return u.id;
}

beforeAll(async () => {
  // Task #1855 — the new failure-fallback path uses dispatchNotification
  // which reads from the in-memory notificationRegistry. Hydrate it +
  // bust the per-event spec cache so the freshly seeded
  // `notify.exhaustion.admin_digest.failed` key is visible to the
  // dispatcher in the same vitest worker.
  await hydrateRegistry();
  _clearSpecCacheForTests();
});

beforeEach(async () => {
  emailMock.mockClear();
  emailMock.mockImplementation(async () => undefined);
  // Each test seeds its own org/admins so the per-recipient send rows
  // and any super_admin failure-audit rows must also be wiped between
  // tests to keep assertions independent.
  if (createdOrgIds.length > 0) {
    await db.delete(notifyExhaustionAdminDigestRecipientSendsTable)
      .where(inArray(notifyExhaustionAdminDigestRecipientSendsTable.organizationId, createdOrgIds));
    await db.delete(emailSuppressionsTable)
      .where(inArray(emailSuppressionsTable.organizationId, createdOrgIds));
  }
  await db.delete(notificationAuditLogTable)
    .where(eq(notificationAuditLogTable.notificationKey, "notify.exhaustion.admin_digest.failed"));
});

afterAll(async () => {
  await db.delete(notificationAuditLogTable)
    .where(eq(notificationAuditLogTable.notificationKey, "notify.exhaustion.admin_digest.failed"));
  if (createdOrgIds.length > 0) {
    await db.delete(notifyExhaustionAdminDigestRecipientSendsTable)
      .where(inArray(notifyExhaustionAdminDigestRecipientSendsTable.organizationId, createdOrgIds));
    await db.delete(emailSuppressionsTable)
      .where(inArray(emailSuppressionsTable.organizationId, createdOrgIds));
  }
  if (createdHistoryIds.length > 0) {
    await db.delete(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(inArray(coachPayoutAccountChangeNotifyAttemptsTable.historyId, createdHistoryIds));
    await db.delete(coachPayoutAccountHistoryTable)
      .where(inArray(coachPayoutAccountHistoryTable.id, createdHistoryIds));
  }
  if (createdProIds.length > 0) {
    await db.delete(teachingProsTable).where(inArray(teachingProsTable.id, createdProIds));
  }
  if (createdOrgIds.length > 0) {
    await db.delete(walletTopupRefundNotifyAttemptsTable)
      .where(inArray(walletTopupRefundNotifyAttemptsTable.organizationId, createdOrgIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length > 0) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

async function loadSendsForOrg(orgId: number) {
  return db.select().from(notifyExhaustionAdminDigestRecipientSendsTable)
    .where(eq(notifyExhaustionAdminDigestRecipientSendsTable.organizationId, orgId))
    .orderBy(desc(notifyExhaustionAdminDigestRecipientSendsTable.createdAt));
}

async function loadFailureAuditFor(userId: number) {
  return db.select().from(notificationAuditLogTable)
    .where(and(
      eq(notificationAuditLogTable.userId, userId),
      eq(notificationAuditLogTable.notificationKey, "notify.exhaustion.admin_digest.failed"),
    ))
    .orderBy(desc(notificationAuditLogTable.createdAt));
}

describe("Task #1507 — notify-exhaustion admin digest", () => {
  it("rolls up wallet + coach exhausted rows into one digest per admin and stamps adminDigestSentAt", async () => {
    const orgId = await makeOrg("rollup");
    const admin1 = await makeAdmin(orgId, "admin1", "org_admin");
    const admin2 = await makeAdmin(orgId, "treasurer1", "treasurer");
    const member = await makeMemberUser(orgId, "member");
    const proId = await makePro(orgId, "Coach Carlos");
    const coachUserId = await makeMemberUser(orgId, "coach_user");

    const recent = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    const wallet1 = await makeWalletAttempt({
      orgId, userId: member,
      paymentId: `pay_${tag("wlt1")}`,
      emailExhaustedAt: recent,
      lastEmailError: "550 mailbox unavailable",
    });
    const wallet2 = await makeWalletAttempt({
      orgId, userId: member,
      paymentId: `pay_${tag("wlt2")}`,
      pushExhaustedAt: recent,
    });
    const coachAttempt = await makeCoachAttempt({
      orgId, proId, coachUserId,
      emailExhaustedAt: recent,
      pushExhaustedAt: recent,
    });

    await sendNotifyExhaustionAdminDigest();

    // 2 admins (org_admin + treasurer) → 2 emails.
    expect(emailMock).toHaveBeenCalledTimes(2);
    const recipientsSent = emailMock.mock.calls.map(c => c[0].to).sort();
    expect(recipientsSent).toEqual([admin1.email, admin2.email].sort());

    // Each call includes both wallet items and the coach item.
    for (const call of emailMock.mock.calls) {
      const args = call[0];
      expect(args.walletItems).toHaveLength(2);
      expect(args.coachItems).toHaveLength(1);
      expect(args.coachItems[0].coachName).toBe("Coach Carlos");
      // Coach item exhausted on both channels.
      expect(args.coachItems[0].channels).toEqual(expect.arrayContaining(["email", "push"]));
      // Wallet item with email error surfaces the error.
      const w1 = args.walletItems.find(w => w.lastError === "550 mailbox unavailable");
      expect(w1).toBeDefined();
      expect(w1?.channels).toEqual(["email"]);
    }

    // Watermark stamped on every row.
    const stampedWallet = await db.select({
      id: walletTopupRefundNotifyAttemptsTable.id,
      adminDigestSentAt: walletTopupRefundNotifyAttemptsTable.adminDigestSentAt,
    }).from(walletTopupRefundNotifyAttemptsTable)
      .where(inArray(walletTopupRefundNotifyAttemptsTable.id, [wallet1, wallet2]));
    expect(stampedWallet.every(r => r.adminDigestSentAt !== null)).toBe(true);

    const [stampedCoach] = await db.select({
      id: coachPayoutAccountChangeNotifyAttemptsTable.id,
      adminDigestSentAt: coachPayoutAccountChangeNotifyAttemptsTable.adminDigestSentAt,
    }).from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.id, coachAttempt.attemptId));
    expect(stampedCoach.adminDigestSentAt).not.toBeNull();
  });

  it("does not re-include rows whose adminDigestSentAt is already stamped", async () => {
    const orgId = await makeOrg("dedup");
    await makeAdmin(orgId, "admin", "org_admin");
    const member = await makeMemberUser(orgId, "member");
    const yesterday = new Date(Date.now() - 60 * 60 * 1000);

    // First exhausted row — already digested.
    await makeWalletAttempt({
      orgId, userId: member,
      paymentId: `pay_${tag("done")}`,
      emailExhaustedAt: yesterday,
      adminDigestSentAt: new Date(Date.now() - 30 * 60 * 1000),
    });
    // Second — fresh, eligible.
    await makeWalletAttempt({
      orgId, userId: member,
      paymentId: `pay_${tag("fresh")}`,
      emailExhaustedAt: yesterday,
    });

    await sendNotifyExhaustionAdminDigest();

    expect(emailMock).toHaveBeenCalledTimes(1);
    const args = emailMock.mock.calls[0][0];
    expect(args.walletItems).toHaveLength(1);
    expect(args.walletItems[0].paymentId).toMatch(/_fresh_/);
  });

  it("skips rows whose exhaustion stamp is older than 24h", async () => {
    const orgId = await makeOrg("window");
    await makeAdmin(orgId, "admin", "org_admin");
    const member = await makeMemberUser(orgId, "member");

    const tooOld = new Date(Date.now() - 30 * 60 * 60 * 1000); // 30h ago
    await makeWalletAttempt({
      orgId, userId: member,
      paymentId: `pay_${tag("old")}`,
      emailExhaustedAt: tooOld,
    });

    await sendNotifyExhaustionAdminDigest();
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("does nothing when there are zero exhausted rows", async () => {
    const orgId = await makeOrg("empty");
    await makeAdmin(orgId, "admin", "org_admin");

    await sendNotifyExhaustionAdminDigest();
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("stamps watermark even when every email send throws (broken inbox)", async () => {
    const orgId = await makeOrg("send_fail");
    await makeAdmin(orgId, "admin", "org_admin");
    const member = await makeMemberUser(orgId, "member");

    const id = await makeWalletAttempt({
      orgId, userId: member,
      paymentId: `pay_${tag("fail")}`,
      emailExhaustedAt: new Date(Date.now() - 60 * 1000),
    });

    emailMock.mockImplementationOnce(async () => {
      throw new Error("smtp blew up");
    });

    await sendNotifyExhaustionAdminDigest();

    const [row] = await db.select({
      adminDigestSentAt: walletTopupRefundNotifyAttemptsTable.adminDigestSentAt,
    }).from(walletTopupRefundNotifyAttemptsTable)
      .where(eq(walletTopupRefundNotifyAttemptsTable.id, id));
    expect(row.adminDigestSentAt).not.toBeNull();
  });

  it("running the digest twice in a row only sends one email per row", async () => {
    const orgId = await makeOrg("idem");
    await makeAdmin(orgId, "admin", "org_admin");
    const member = await makeMemberUser(orgId, "member");

    await makeWalletAttempt({
      orgId, userId: member,
      paymentId: `pay_${tag("idem")}`,
      emailExhaustedAt: new Date(Date.now() - 60 * 1000),
    });

    await sendNotifyExhaustionAdminDigest();
    expect(emailMock).toHaveBeenCalledTimes(1);

    emailMock.mockClear();
    await sendNotifyExhaustionAdminDigest();
    expect(emailMock).not.toHaveBeenCalled();
  });
});

describe("Task #1855 — bounce-aware persistence + super_admin fallback", () => {
  it("persists a paused_suppressed row for an admin on the suppression list and skips the send", async () => {
    const orgId = await makeOrg("paused_one");
    const admin1 = await makeAdmin(orgId, "paused_admin", "org_admin");
    const admin2 = await makeAdmin(orgId, "live_treas", "treasurer");
    const member = await makeMemberUser(orgId, "member");

    await db.insert(emailSuppressionsTable).values({
      organizationId: orgId,
      email: admin1.email,
      reason: "bounced",
      bounceType: "HardBounce",
      description: "550 mailbox does not exist",
    });

    await makeWalletAttempt({
      orgId, userId: member,
      paymentId: `pay_${tag("paused")}`,
      emailExhaustedAt: new Date(Date.now() - 60 * 1000),
    });

    await sendNotifyExhaustionAdminDigest();

    // Only the live treasurer was emailed; the suppressed admin was
    // skipped before the mailer was invoked.
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(emailMock.mock.calls[0][0].to).toBe(admin2.email);

    const sends = await loadSendsForOrg(orgId);
    const pausedRow = sends.find(r => r.recipientEmail === admin1.email);
    const sentRow = sends.find(r => r.recipientEmail === admin2.email);
    expect(pausedRow).toBeDefined();
    expect(pausedRow?.status).toBe("paused_suppressed");
    expect(pausedRow?.bounceType).toBe("HardBounce");
    expect(pausedRow?.suppressionReason).toBe("bounced");
    expect(sentRow).toBeDefined();
    expect(sentRow?.status).toBe("sent");
    // Mixed outcome (1 sent, 1 paused) → no super_admin alert.
    const failureAudits = await db.select().from(notificationAuditLogTable)
      .where(eq(notificationAuditLogTable.notificationKey, "notify.exhaustion.admin_digest.failed"));
    expect(failureAudits).toHaveLength(0);
  });

  it("dispatches the failure key to super_admins when every admin recipient is on the suppression list", async () => {
    const orgId = await makeOrg("all_paused");
    const admin1 = await makeAdmin(orgId, "p1", "org_admin");
    const admin2 = await makeAdmin(orgId, "p2", "treasurer");
    const member = await makeMemberUser(orgId, "member");
    const superAdminId = await makeSuperAdmin("super_paused");

    await db.insert(emailSuppressionsTable).values([
      { organizationId: orgId, email: admin1.email, reason: "bounced", bounceType: "HardBounce" },
      { organizationId: orgId, email: admin2.email, reason: "bounced", bounceType: "HardBounce" },
    ]);

    await makeWalletAttempt({
      orgId, userId: member,
      paymentId: `pay_${tag("ap")}`,
      emailExhaustedAt: new Date(Date.now() - 60 * 1000),
    });

    await sendNotifyExhaustionAdminDigest();

    expect(emailMock).not.toHaveBeenCalled();

    const sends = await loadSendsForOrg(orgId);
    expect(sends.every(r => r.status === "paused_suppressed")).toBe(true);
    expect(sends).toHaveLength(2);

    const audit = await loadFailureAuditFor(superAdminId);
    expect(audit.length).toBeGreaterThan(0);
    const payload = audit[0].payload as Record<string, unknown>;
    expect(payload.organizationId).toBe(orgId);
    expect((payload.pausedRecipients as string[]).sort()).toEqual([admin1.email, admin2.email].sort());
    expect((payload.failedRecipients as string[])).toHaveLength(0);
  });

  it("dispatches the failure key to super_admins when every send to a non-paused recipient throws", async () => {
    const orgId = await makeOrg("all_failed");
    await makeAdmin(orgId, "f1", "org_admin");
    await makeAdmin(orgId, "f2", "treasurer");
    const member = await makeMemberUser(orgId, "member");
    const superAdminId = await makeSuperAdmin("super_failed");

    await makeWalletAttempt({
      orgId, userId: member,
      paymentId: `pay_${tag("af")}`,
      emailExhaustedAt: new Date(Date.now() - 60 * 1000),
    });

    emailMock.mockImplementation(async () => {
      throw new Error("Postmark 422 InactiveRecipient");
    });

    await sendNotifyExhaustionAdminDigest();

    expect(emailMock).toHaveBeenCalledTimes(2);

    const sends = await loadSendsForOrg(orgId);
    expect(sends.length).toBe(2);
    expect(sends.every(r => r.status === "failed")).toBe(true);
    expect(sends.every(r => String(r.errorMessage ?? "").includes("Postmark"))).toBe(true);

    const audit = await loadFailureAuditFor(superAdminId);
    expect(audit.length).toBeGreaterThan(0);
    const payload = audit[0].payload as Record<string, unknown>;
    expect(payload.organizationId).toBe(orgId);
    expect((payload.failedRecipients as string[]).length).toBe(2);
  });

  it("persists a sent row for each successful recipient and does NOT raise the failure notification", async () => {
    const orgId = await makeOrg("happy_persist");
    const admin1 = await makeAdmin(orgId, "h1", "org_admin");
    const member = await makeMemberUser(orgId, "member");
    const superAdminId = await makeSuperAdmin("super_happy");

    await makeWalletAttempt({
      orgId, userId: member,
      paymentId: `pay_${tag("hp")}`,
      emailExhaustedAt: new Date(Date.now() - 60 * 1000),
    });

    await sendNotifyExhaustionAdminDigest();

    const sends = await loadSendsForOrg(orgId);
    expect(sends).toHaveLength(1);
    expect(sends[0].status).toBe("sent");
    expect(sends[0].recipientEmail).toBe(admin1.email);
    expect(sends[0].walletItemCount).toBe(1);

    const audit = await loadFailureAuditFor(superAdminId);
    expect(audit).toHaveLength(0);
  });

  it("persists a no_recipients row and dispatches the failure key when the org has no admin recipients with an email", async () => {
    const orgId = await makeOrg("no_recip");
    const admin = await makeAdmin(orgId, "noemail", "org_admin");
    const member = await makeMemberUser(orgId, "member");
    const superAdminId = await makeSuperAdmin("super_noemail");

    // Strip the admin's email so the early-return "no admin recipients
    // with email" branch fires.
    await db.update(appUsersTable).set({ email: null }).where(eq(appUsersTable.id, admin.id));

    await makeWalletAttempt({
      orgId, userId: member,
      paymentId: `pay_${tag("nr")}`,
      emailExhaustedAt: new Date(Date.now() - 60 * 1000),
    });

    await sendNotifyExhaustionAdminDigest();

    expect(emailMock).not.toHaveBeenCalled();

    const sends = await loadSendsForOrg(orgId);
    expect(sends).toHaveLength(1);
    expect(sends[0].status).toBe("no_recipients");

    const audit = await loadFailureAuditFor(superAdminId);
    expect(audit.length).toBeGreaterThan(0);
    const payload = audit[0].payload as Record<string, unknown>;
    expect(payload.adminRecipientCount).toBe(0);
  });
});
