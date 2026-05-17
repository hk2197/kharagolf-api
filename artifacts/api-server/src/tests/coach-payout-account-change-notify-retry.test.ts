/**
 * Task #1280 — coach payout-account change notify retry pipeline.
 *
 * Mirrors the wallet-withdrawal retry coverage from Task #1108 and the
 * wallet-topup-refund retry coverage in `wallet-topup-refund-notify.test.ts`.
 *
 *   - persists an attempts row on first failure (one row per historyId,
 *     unique index also defends against a re-fire);
 *   - `computeNextRetryAt` follows the 5/10/20/40/80-minute schedule;
 *   - `retryCoachPayoutAccountChangeEmail` returns null when the row is
 *     no longer eligible (status not failed, cap reached, backoff window
 *     pending), clears `nextEmailRetryAt` on a successful retry, stamps
 *     `emailRetryExhaustedAt` after the cap;
 *   - the cron batch (`retryFailedCoachPayoutAccountChangeEmailPush`) only
 *     picks up due rows;
 *   - `retryCoachPayoutAccountChangePush` honours `preferPush` opt-outs
 *     that happen between the original send and the retry.
 *
 * The first-attempt fan-out (in-app inbox row, channel-status reduction,
 * branding) is exercised separately by
 * `src/lib/__tests__/coachPayoutAccountChangeNotify.test.ts`.
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

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  teachingProsTable,
  coachPayoutAccountHistoryTable,
  coachPayoutAccountChangeNotifyAttemptsTable,
  memberMessagesTable,
  notificationDigestQueueTable,
  notificationAuditLogTable,
  userNotificationPrefsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  notifyCoachPayoutAccountChanged,
  retryCoachPayoutAccountChangeEmail,
  retryCoachPayoutAccountChangePush,
  computeNextRetryAt,
  COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_EMAIL_ATTEMPTS,
} from "../lib/coachPayoutAccountChangeNotify.js";
import { retryFailedCoachPayoutAccountChangeEmailPush } from "../lib/cron.js";
import { sendCoachPayoutAccountChangedEmail } from "../lib/mailer.js";
import { sendPushToUsers } from "../lib/push.js";

const emailMock = vi.mocked(sendCoachPayoutAccountChangedEmail);
const pushMock = vi.mocked(sendPushToUsers);

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
    accountHolderName: "Refund Coach",
    upiVpaMasked: method === "upi" ? "te****@ybl" : null,
    bankAccountLast4: method === "bank_account" ? "4321" : null,
    bankIfsc: method === "bank_account" ? "HDFC0001234" : null,
    ipAddress: "10.0.0.1",
    userAgent: "vitest",
  }).returning({ id: coachPayoutAccountHistoryTable.id });
  createdHistoryIds.push(h.id);
  return h.id;
}

beforeAll(async () => {
  const stamp = uniq("t1280cp");
  const [org] = await db.insert(organizationsTable).values({
    name: `Org ${stamp}`, slug: stamp,
  }).returning();
  orgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `coach-retry-${stamp}`,
    username: `cr_${stamp}`,
    email: `${stamp}@example.com`,
    displayName: "Retry Coach",
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
    firstName: "Retry",
    lastName: "Coach",
    email: `cm-${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  clubMemberId = cm.id;
});

afterAll(async () => {
  // Wait one tick so any in-flight fire-and-forget admin-notify
  // background tasks finish before we tear down their (no-op) writes.
  await new Promise((r) => setTimeout(r, 100));

  if (createdHistoryIds.length > 0) {
    await db.delete(coachPayoutAccountChangeNotifyAttemptsTable).where(inArray(coachPayoutAccountChangeNotifyAttemptsTable.historyId, createdHistoryIds));
    await db.delete(coachPayoutAccountHistoryTable).where(inArray(coachPayoutAccountHistoryTable.id, createdHistoryIds));
  }
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.clubMemberId, clubMemberId));
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
  emailMock.mockReset();
  emailMock.mockResolvedValue(undefined as unknown as void);
  pushMock.mockReset();
  pushMock.mockResolvedValue({ attempted: 1, sent: 1, failed: 0, invalid: 0 });
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, coachUserId));
});

describe("Task #1280 — coach payout-account change notify retry", () => {
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
    const historyId = await makeHistoryRow({ changeKind: "updated", method: "upi" });
    await notifyCoachPayoutAccountChanged(historyId);

    const [row] = await db.select()
      .from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(row).toBeDefined();
    expect(row.emailStatus).toBe("failed");
    expect(row.emailAttempts).toBe(1);
    expect(row.lastEmailError).toMatch(/SMTP timeout/);
    expect(row.nextEmailRetryAt).toBeTruthy();
    expect(row.changeKind).toBe("updated");
    expect(row.method).toBe("upi");
    expect(row.coachUserId).toBe(coachUserId);
    expect(row.proId).toBe(proId);
  });

  it("does NOT double-insert if notify is somehow re-invoked for the same historyId", async () => {
    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);
    await notifyCoachPayoutAccountChanged(historyId);

    const rows = await db.select()
      .from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(rows.length).toBe(1);
  });

  it("retryCoachPayoutAccountChangeEmail clears nextEmailRetryAt and bumps attempts on a successful retry", async () => {
    emailMock.mockRejectedValueOnce(new Error("transient SMTP"));
    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);

    let [row] = await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(row.emailStatus).toBe("failed");

    const ret = await retryCoachPayoutAccountChangeEmail({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret).not.toBeNull();
    expect(ret!.status).toBe("sent");
    expect(emailMock).toHaveBeenCalledTimes(2);

    [row] = await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(row.emailStatus).toBe("sent");
    expect(row.emailAttempts).toBe(2);
    expect(row.nextEmailRetryAt).toBeNull();
    expect(row.emailRetryExhaustedAt).toBeNull();
  });

  it("retryCoachPayoutAccountChangeEmail returns null when the backoff window has not elapsed", async () => {
    emailMock.mockRejectedValueOnce(new Error("SMTP down"));
    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);

    const [row] = await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    const ret = await retryCoachPayoutAccountChangeEmail({ attempt: row, now: new Date() });
    expect(ret).toBeNull();
    expect(emailMock).toHaveBeenCalledTimes(1);
  });

  it("retryCoachPayoutAccountChangeEmail stamps emailRetryExhaustedAt after the cap is reached", async () => {
    emailMock.mockRejectedValue(new Error("SMTP perm"));
    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);

    let now = new Date();
    for (let i = 0; i < COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_EMAIL_ATTEMPTS; i++) {
      const [row] = await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
        .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
      now = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const ret = await retryCoachPayoutAccountChangeEmail({ attempt: row, now });
      if (!ret) break;
    }
    const [row] = await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(row.emailAttempts).toBe(COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_EMAIL_ATTEMPTS);
    expect(row.emailStatus).toBe("failed");
    expect(row.emailRetryExhaustedAt).toBeTruthy();
    expect(row.nextEmailRetryAt).toBeNull();
    emailMock.mockReset();
    emailMock.mockResolvedValue(undefined as unknown as void);
  });

  it("retryCoachPayoutAccountChangeEmail returns null once status flips off 'failed'", async () => {
    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);
    const [row] = await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(row.emailStatus).toBe("sent");
    const ret = await retryCoachPayoutAccountChangeEmail({
      attempt: row, now: new Date(Date.now() + 60 * 60 * 1000),
    });
    expect(ret).toBeNull();
  });

  it("retryFailedCoachPayoutAccountChangeEmailPush only picks up due rows and dispatches each channel", async () => {
    // Row A: email failed, due → must be retried.
    emailMock.mockRejectedValueOnce(new Error("transient A"));
    const historyA = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyA);
    await db.update(coachPayoutAccountChangeNotifyAttemptsTable).set({
      nextEmailRetryAt: new Date(Date.now() - 60 * 60 * 1000),
    }).where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyA));

    // Row B: email failed, NOT due → cron must skip.
    emailMock.mockRejectedValueOnce(new Error("transient B"));
    const historyB = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyB);
    await db.update(coachPayoutAccountChangeNotifyAttemptsTable).set({
      nextEmailRetryAt: new Date(Date.now() + 60 * 60 * 1000),
    }).where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyB));

    emailMock.mockClear();
    emailMock.mockResolvedValueOnce(undefined as unknown as void);

    await retryFailedCoachPayoutAccountChangeEmailPush();

    expect(emailMock).toHaveBeenCalledTimes(1);
    const aRow = (await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyA)))[0];
    const bRow = (await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyB)))[0];
    expect(aRow.emailStatus).toBe("sent");
    expect(aRow.emailAttempts).toBe(2);
    expect(bRow.emailStatus).toBe("failed");
    expect(bRow.emailAttempts).toBe(1);
  });

  it("retryCoachPayoutAccountChangePush respects preferPush opt-out at retry time", async () => {
    pushMock.mockResolvedValueOnce({ attempted: 1, sent: 0, failed: 1, invalid: 0 });
    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);
    let [row] = await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(row.pushStatus).toBe("failed");

    await db.insert(userNotificationPrefsTable).values({
      userId: coachUserId, preferEmail: true, preferPush: false,
    });
    const ret = await retryCoachPayoutAccountChangePush({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret).not.toBeNull();
    expect(ret!.status).toBe("opted_out");
    expect(pushMock).toHaveBeenCalledTimes(1);

    [row] = await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(row.pushStatus).toBe("opted_out");
    expect(row.nextPushRetryAt).toBeNull();
  });

  // ── Task #1703 — retry audit-trail coverage ──────────────────────────
  // The initial fan-out already writes one audit row per leg. The retry
  // helpers used to write nothing, so a coach who was only reached on
  // attempt N had an audit trail showing `failed` and nothing after.
  // These tests assert the retry helpers now leave a trail.

  async function getCoachAuditRows(channel: "email" | "push") {
    return db.select().from(notificationAuditLogTable).where(and(
      eq(notificationAuditLogTable.notificationKey, "coach.payout.account.changed.coach"),
      eq(notificationAuditLogTable.userId, coachUserId),
      eq(notificationAuditLogTable.channel, channel),
    ));
  }

  it("Task #1703 — retry success on email writes an audit row keyed by retry attempt", async () => {
    emailMock.mockRejectedValueOnce(new Error("transient SMTP"));
    const historyId = await makeHistoryRow({ method: "upi" });
    await notifyCoachPayoutAccountChanged(historyId);

    let [row] = await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(row.emailStatus).toBe("failed");

    // Initial fan-out leg should already have written one email audit row
    // marked `failed` for this historyId.
    let auditRows = await getCoachAuditRows("email");
    const initial = auditRows.filter((r) => (r.payload as Record<string, unknown>)?.historyId === historyId);
    expect(initial.length).toBe(1);
    expect(initial[0].status).toBe("failed");

    const ret = await retryCoachPayoutAccountChangeEmail({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret!.status).toBe("sent");

    auditRows = await getCoachAuditRows("email");
    const forHistory = auditRows.filter((r) => (r.payload as Record<string, unknown>)?.historyId === historyId);
    expect(forHistory.length).toBe(2);
    const retryRow = forHistory.find((r) => r.id !== initial[0].id)!;
    expect(retryRow.status).toBe("sent");
    expect(retryRow.reason).toBe("retry_attempt_2");
    expect((retryRow.payload as Record<string, unknown>).retryAttempt).toBe(2);
    expect((retryRow.payload as Record<string, unknown>).historyId).toBe(historyId);
    expect((retryRow.payload as Record<string, unknown>).method).toBe("upi");
  });

  it("Task #1703 — retry failure on email writes an audit row including the error", async () => {
    emailMock.mockRejectedValue(new Error("first SMTP failure"));
    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);

    const [row] = await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));

    emailMock.mockReset();
    emailMock.mockRejectedValueOnce(new Error("second SMTP failure"));
    const ret = await retryCoachPayoutAccountChangeEmail({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret!.status).toBe("failed");

    const auditRows = await getCoachAuditRows("email");
    const forHistory = auditRows.filter((r) => (r.payload as Record<string, unknown>)?.historyId === historyId);
    expect(forHistory.length).toBe(2);
    const retryRow = forHistory.find((r) => (r.payload as Record<string, unknown>)?.retryAttempt === 2)!;
    expect(retryRow.status).toBe("failed");
    expect(retryRow.reason).toMatch(/^retry_attempt_2:second SMTP failure$/);

    emailMock.mockReset();
    emailMock.mockResolvedValue(undefined as unknown as void);
  });

  it("Task #1703 — opted_out email retry writes an audit row with the opt-out reason", async () => {
    emailMock.mockRejectedValueOnce(new Error("transient SMTP"));
    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);

    const [row] = await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));

    // Coach turns off email between the initial send and the retry.
    await db.insert(userNotificationPrefsTable).values({
      userId: coachUserId, preferEmail: false, preferPush: true,
    });

    emailMock.mockClear();
    const ret = await retryCoachPayoutAccountChangeEmail({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret!.status).toBe("opted_out");
    expect(emailMock).not.toHaveBeenCalled();

    const auditRows = await getCoachAuditRows("email");
    const retryRow = auditRows.find((r) =>
      (r.payload as Record<string, unknown>)?.historyId === historyId
      && (r.payload as Record<string, unknown>)?.retryAttempt === 2)!;
    expect(retryRow.status).toBe("opted_out");
    expect(retryRow.reason).toBe("retry_attempt_2:email_opted_out");
  });

  it("Task #1703 — no_address email retry writes an audit row with the no-email reason", async () => {
    emailMock.mockRejectedValueOnce(new Error("transient SMTP"));
    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);

    const [row] = await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));

    // Coach loses their on-file email between the initial send and the
    // retry — the retry helper must record this as no_address, not as a
    // delivery failure.
    const originalEmail = (await db.select({ email: appUsersTable.email })
      .from(appUsersTable).where(eq(appUsersTable.id, coachUserId)))[0].email;
    await db.update(appUsersTable).set({ email: null })
      .where(eq(appUsersTable.id, coachUserId));

    emailMock.mockClear();
    try {
      const ret = await retryCoachPayoutAccountChangeEmail({
        attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
      });
      expect(ret!.status).toBe("no_address");
      expect(emailMock).not.toHaveBeenCalled();

      const auditRows = await getCoachAuditRows("email");
      const retryRow = auditRows.find((r) =>
        (r.payload as Record<string, unknown>)?.historyId === historyId
        && (r.payload as Record<string, unknown>)?.retryAttempt === 2)!;
      expect(retryRow.status).toBe("no_address");
      expect(retryRow.reason).toBe("retry_attempt_2:no_email_on_file");
    } finally {
      await db.update(appUsersTable).set({ email: originalEmail })
        .where(eq(appUsersTable.id, coachUserId));
    }
  });

  it("Task #1703 — provider_not_configured email retry writes a terminal-skip audit row", async () => {
    emailMock.mockRejectedValueOnce(new Error("transient SMTP"));
    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);

    const [row] = await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));

    emailMock.mockReset();
    emailMock.mockRejectedValueOnce(new Error("RESEND_API_KEY not set"));
    const ret = await retryCoachPayoutAccountChangeEmail({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret!.status).toBe("skipped");
    expect(ret!.error).toBe("provider_not_configured");

    const auditRows = await getCoachAuditRows("email");
    const retryRow = auditRows.find((r) =>
      (r.payload as Record<string, unknown>)?.historyId === historyId
      && (r.payload as Record<string, unknown>)?.retryAttempt === 2)!;
    expect(retryRow.status).toBe("skipped");
    expect(retryRow.reason).toBe("retry_attempt_2:provider_not_configured");

    emailMock.mockReset();
    emailMock.mockResolvedValue(undefined as unknown as void);
  });

  it("Task #1703 — multiple email retries accumulate one audit row per attempt", async () => {
    emailMock.mockRejectedValue(new Error("flaky SMTP"));
    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);

    let now = new Date();
    // Two failed retries, then a successful third.
    for (let i = 0; i < 2; i++) {
      const [row] = await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
        .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
      now = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const ret = await retryCoachPayoutAccountChangeEmail({ attempt: row, now });
      expect(ret!.status).toBe("failed");
    }
    emailMock.mockReset();
    emailMock.mockResolvedValueOnce(undefined as unknown as void);
    const [row] = await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    now = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const ret = await retryCoachPayoutAccountChangeEmail({ attempt: row, now });
    expect(ret!.status).toBe("sent");

    const auditRows = await getCoachAuditRows("email");
    const forHistory = auditRows.filter((r) => (r.payload as Record<string, unknown>)?.historyId === historyId)
      .sort((a, b) => Number((a.payload as Record<string, unknown>)?.retryAttempt ?? 0)
        - Number((b.payload as Record<string, unknown>)?.retryAttempt ?? 0));
    // Initial leg (no retryAttempt) + three retries.
    expect(forHistory.length).toBe(4);
    const initial = forHistory.find((r) => (r.payload as Record<string, unknown>)?.retryAttempt === undefined)!;
    expect(initial.status).toBe("failed");
    const retries = forHistory.filter((r) => (r.payload as Record<string, unknown>)?.retryAttempt !== undefined);
    expect(retries.map((r) => (r.payload as Record<string, unknown>).retryAttempt)).toEqual([2, 3, 4]);
    expect(retries.map((r) => r.status)).toEqual(["failed", "failed", "sent"]);
    expect(retries[2].reason).toBe("retry_attempt_4");

    emailMock.mockReset();
    emailMock.mockResolvedValue(undefined as unknown as void);
  });

  it("Task #1703 — push retry success and failure each write an audit row", async () => {
    pushMock.mockResolvedValueOnce({ attempted: 1, sent: 0, failed: 1, invalid: 0 });
    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);

    let [row] = await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(row.pushStatus).toBe("failed");

    // First retry: still fails.
    pushMock.mockResolvedValueOnce({ attempted: 1, sent: 0, failed: 1, invalid: 0 });
    let ret = await retryCoachPayoutAccountChangePush({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret!.status).toBe("failed");

    // Second retry: succeeds.
    [row] = await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    pushMock.mockResolvedValueOnce({ attempted: 1, sent: 1, failed: 0, invalid: 0 });
    ret = await retryCoachPayoutAccountChangePush({
      attempt: row, now: new Date(Date.now() + 60 * 60 * 1000),
    });
    expect(ret!.status).toBe("sent");

    const auditRows = await db.select().from(notificationAuditLogTable).where(and(
      eq(notificationAuditLogTable.notificationKey, "coach.payout.account.changed.coach"),
      eq(notificationAuditLogTable.userId, coachUserId),
      eq(notificationAuditLogTable.channel, "push"),
    ));
    const forHistory = auditRows.filter((r) => (r.payload as Record<string, unknown>)?.historyId === historyId)
      .sort((a, b) => Number((a.payload as Record<string, unknown>)?.retryAttempt ?? 0)
        - Number((b.payload as Record<string, unknown>)?.retryAttempt ?? 0));
    expect(forHistory.length).toBe(3); // initial + 2 retries
    const retries = forHistory.filter((r) => (r.payload as Record<string, unknown>)?.retryAttempt !== undefined);
    expect(retries.map((r) => (r.payload as Record<string, unknown>).retryAttempt)).toEqual([2, 3]);
    expect(retries[0].status).toBe("failed");
    expect(retries[0].reason).toBe("retry_attempt_2:push_delivery_failed");
    expect(retries[1].status).toBe("sent");
    expect(retries[1].reason).toBe("retry_attempt_3");
  });

  it("Task #1703 — push retry opted_out writes an audit row with the opt-out reason", async () => {
    pushMock.mockResolvedValueOnce({ attempted: 1, sent: 0, failed: 1, invalid: 0 });
    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);

    const [row] = await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));

    await db.insert(userNotificationPrefsTable).values({
      userId: coachUserId, preferEmail: true, preferPush: false,
    });
    pushMock.mockClear();
    const ret = await retryCoachPayoutAccountChangePush({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret!.status).toBe("opted_out");
    expect(pushMock).not.toHaveBeenCalled();

    const auditRows = await db.select().from(notificationAuditLogTable).where(and(
      eq(notificationAuditLogTable.notificationKey, "coach.payout.account.changed.coach"),
      eq(notificationAuditLogTable.userId, coachUserId),
      eq(notificationAuditLogTable.channel, "push"),
    ));
    const retryRow = auditRows.find((r) =>
      (r.payload as Record<string, unknown>)?.historyId === historyId
      && (r.payload as Record<string, unknown>)?.retryAttempt === 2)!;
    expect(retryRow.status).toBe("opted_out");
    expect(retryRow.reason).toBe("retry_attempt_2:push_opted_out");
  });

  it("Task #1703 — push retry no_address writes an audit row with the no-token reason", async () => {
    pushMock.mockResolvedValueOnce({ attempted: 1, sent: 0, failed: 1, invalid: 0 });
    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);

    const [row] = await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));

    // Coach has no devices left at retry time → classifyPushDelivery
    // returns "no_address" (attempted = 0).
    pushMock.mockReset();
    pushMock.mockResolvedValueOnce({ attempted: 0, sent: 0, failed: 0, invalid: 0 });
    const ret = await retryCoachPayoutAccountChangePush({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret!.status).toBe("no_address");

    const auditRows = await db.select().from(notificationAuditLogTable).where(and(
      eq(notificationAuditLogTable.notificationKey, "coach.payout.account.changed.coach"),
      eq(notificationAuditLogTable.userId, coachUserId),
      eq(notificationAuditLogTable.channel, "push"),
    ));
    const retryRow = auditRows.find((r) =>
      (r.payload as Record<string, unknown>)?.historyId === historyId
      && (r.payload as Record<string, unknown>)?.retryAttempt === 2)!;
    expect(retryRow.status).toBe("no_address");
    expect(retryRow.reason).toBe("retry_attempt_2:no_push_token");

    pushMock.mockReset();
    pushMock.mockResolvedValue({ attempted: 1, sent: 1, failed: 0, invalid: 0 });
  });

  // ── Task #2122 — device-level push delivery counts in the audit trail ─
  // Both the initial fan-out and the retry helper should now stash the
  // per-device `attempted / sent / failed / invalid` breakdown inside
  // the push channel's `notification_audit_log.payload`, so admins
  // answering coach disputes can see "2 of 3 of your devices got it"
  // without another database round-trip.

  it("Task #2122 — initial fan-out push audit row carries per-device delivery counters", async () => {
    pushMock.mockResolvedValueOnce({ attempted: 3, sent: 2, failed: 0, invalid: 1 });
    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);

    const auditRows = await db.select().from(notificationAuditLogTable).where(and(
      eq(notificationAuditLogTable.notificationKey, "coach.payout.account.changed.coach"),
      eq(notificationAuditLogTable.userId, coachUserId),
      eq(notificationAuditLogTable.channel, "push"),
    ));
    const initialRow = auditRows.find((r) =>
      (r.payload as Record<string, unknown>)?.historyId === historyId
      && (r.payload as Record<string, unknown>)?.retryAttempt === undefined)!;
    expect(initialRow).toBeDefined();
    expect(initialRow.status).toBe("sent");
    const payload = initialRow.payload as Record<string, unknown>;
    expect(payload.pushDelivery).toEqual({
      attempted: 3,
      sent: 2,
      failed: 0,
      invalid: 1,
    });
  });

  it("Task #2122 — initial fan-out push audit row carries counters even on a delivery failure", async () => {
    pushMock.mockResolvedValueOnce({ attempted: 2, sent: 0, failed: 2, invalid: 0 });
    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);

    const auditRows = await db.select().from(notificationAuditLogTable).where(and(
      eq(notificationAuditLogTable.notificationKey, "coach.payout.account.changed.coach"),
      eq(notificationAuditLogTable.userId, coachUserId),
      eq(notificationAuditLogTable.channel, "push"),
    ));
    const initialRow = auditRows.find((r) =>
      (r.payload as Record<string, unknown>)?.historyId === historyId
      && (r.payload as Record<string, unknown>)?.retryAttempt === undefined)!;
    expect(initialRow.status).toBe("failed");
    expect(initialRow.reason).toBe("push_delivery_failed");
    expect((initialRow.payload as Record<string, unknown>).pushDelivery).toEqual({
      attempted: 2,
      sent: 0,
      failed: 2,
      invalid: 0,
    });
  });

  it("Task #2122 — push retry audit row carries per-device delivery counters", async () => {
    // Initial fan-out fails outright (2 attempted, both failed).
    pushMock.mockResolvedValueOnce({ attempted: 2, sent: 0, failed: 2, invalid: 0 });
    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);

    const [row] = await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));
    expect(row.pushStatus).toBe("failed");

    // Retry: 3 devices on file now, 2 succeed, 1 invalid token.
    pushMock.mockResolvedValueOnce({ attempted: 3, sent: 2, failed: 0, invalid: 1 });
    const ret = await retryCoachPayoutAccountChangePush({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret!.status).toBe("sent");

    const auditRows = await db.select().from(notificationAuditLogTable).where(and(
      eq(notificationAuditLogTable.notificationKey, "coach.payout.account.changed.coach"),
      eq(notificationAuditLogTable.userId, coachUserId),
      eq(notificationAuditLogTable.channel, "push"),
    ));
    const retryRow = auditRows.find((r) =>
      (r.payload as Record<string, unknown>)?.historyId === historyId
      && (r.payload as Record<string, unknown>)?.retryAttempt === 2)!;
    expect(retryRow).toBeDefined();
    expect(retryRow.status).toBe("sent");
    expect(retryRow.reason).toBe("retry_attempt_2");
    expect((retryRow.payload as Record<string, unknown>).pushDelivery).toEqual({
      attempted: 3,
      sent: 2,
      failed: 0,
      invalid: 1,
    });
  });

  it("Task #2122 — push retry audit row carries counters even when the retry itself fails", async () => {
    pushMock.mockResolvedValueOnce({ attempted: 1, sent: 0, failed: 1, invalid: 0 });
    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);

    const [row] = await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));

    // Retry call: still all failures — counters must still land in the
    // payload so the admin can see exactly which devices were tried.
    pushMock.mockResolvedValueOnce({ attempted: 2, sent: 0, failed: 1, invalid: 1 });
    const ret = await retryCoachPayoutAccountChangePush({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret!.status).toBe("failed");

    const auditRows = await db.select().from(notificationAuditLogTable).where(and(
      eq(notificationAuditLogTable.notificationKey, "coach.payout.account.changed.coach"),
      eq(notificationAuditLogTable.userId, coachUserId),
      eq(notificationAuditLogTable.channel, "push"),
    ));
    const retryRow = auditRows.find((r) =>
      (r.payload as Record<string, unknown>)?.historyId === historyId
      && (r.payload as Record<string, unknown>)?.retryAttempt === 2)!;
    expect(retryRow.status).toBe("failed");
    expect(retryRow.reason).toBe("retry_attempt_2:push_delivery_failed");
    expect((retryRow.payload as Record<string, unknown>).pushDelivery).toEqual({
      attempted: 2,
      sent: 0,
      failed: 1,
      invalid: 1,
    });
  });

  it("Task #2122 — push retry that bails before calling Expo (opted_out) omits the counters", async () => {
    // The opt-out branch never invokes sendPushToUsers, so there are no
    // counters to record — the audit row must still write, just without
    // a `pushDelivery` field. This guards against drifting into emitting
    // a misleading {attempted:0,sent:0,...} that would imply we tried.
    pushMock.mockResolvedValueOnce({ attempted: 1, sent: 0, failed: 1, invalid: 0 });
    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);

    const [row] = await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));

    await db.insert(userNotificationPrefsTable).values({
      userId: coachUserId, preferEmail: true, preferPush: false,
    });
    pushMock.mockClear();
    const ret = await retryCoachPayoutAccountChangePush({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret!.status).toBe("opted_out");
    expect(pushMock).not.toHaveBeenCalled();

    const auditRows = await db.select().from(notificationAuditLogTable).where(and(
      eq(notificationAuditLogTable.notificationKey, "coach.payout.account.changed.coach"),
      eq(notificationAuditLogTable.userId, coachUserId),
      eq(notificationAuditLogTable.channel, "push"),
    ));
    const retryRow = auditRows.find((r) =>
      (r.payload as Record<string, unknown>)?.historyId === historyId
      && (r.payload as Record<string, unknown>)?.retryAttempt === 2)!;
    expect(retryRow.status).toBe("opted_out");
    expect((retryRow.payload as Record<string, unknown>).pushDelivery).toBeUndefined();
  });

  it("Task #1703 — push retry provider_not_configured writes a terminal-skip audit row", async () => {
    pushMock.mockResolvedValueOnce({ attempted: 1, sent: 0, failed: 1, invalid: 0 });
    const historyId = await makeHistoryRow();
    await notifyCoachPayoutAccountChanged(historyId);

    const [row] = await db.select().from(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, historyId));

    pushMock.mockReset();
    pushMock.mockRejectedValueOnce(new Error("EXPO push provider not configured"));
    const ret = await retryCoachPayoutAccountChangePush({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret!.status).toBe("skipped");
    expect(ret!.error).toBe("provider_not_configured");

    const auditRows = await db.select().from(notificationAuditLogTable).where(and(
      eq(notificationAuditLogTable.notificationKey, "coach.payout.account.changed.coach"),
      eq(notificationAuditLogTable.userId, coachUserId),
      eq(notificationAuditLogTable.channel, "push"),
    ));
    const retryRow = auditRows.find((r) =>
      (r.payload as Record<string, unknown>)?.historyId === historyId
      && (r.payload as Record<string, unknown>)?.retryAttempt === 2)!;
    expect(retryRow.status).toBe("skipped");
    expect(retryRow.reason).toBe("retry_attempt_2:provider_not_configured");

    pushMock.mockReset();
    pushMock.mockResolvedValue({ attempted: 1, sent: 1, failed: 0, invalid: 0 });
  });
});
