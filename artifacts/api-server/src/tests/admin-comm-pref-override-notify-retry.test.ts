/**
 * Task #1845 — admin-comm-pref override notify retry pipeline.
 *
 * Mirrors the coach-payout-account-change retry coverage from Task #1280.
 * The original `notifyMemberOfAdminCommPrefOverride` (Task #1504) was
 * fire-and-forget: a transient SMTP/Postmark hiccup silently swallowed
 * the only timely consent notice the affected member would receive.
 *
 *   - persists an attempts row on first send (snapshotting prefLabel,
 *     prev/new value, reason, changedAt) and stamps `nextEmailRetryAt`
 *     when the email leg fails;
 *   - `retryAdminCommPrefOverrideEmail` returns null when the row is no
 *     longer eligible (status not failed, cap reached, backoff window
 *     pending), clears `nextEmailRetryAt` on a successful retry, stamps
 *     `emailRetryExhaustedAt` after the cap;
 *   - the cron batch (`retryFailedAdminCommPrefOverrideEmail`) only
 *     picks up due rows.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendNotificationPrefAdminOverrideEmail: vi.fn(async () => undefined),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  adminCommPrefOverrideNotifyAttemptsTable,
  memberMessagesTable,
  userNotificationPrefsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  notifyMemberOfAdminCommPrefOverride,
  retryAdminCommPrefOverrideEmail,
  computeNextRetryAt,
  ADMIN_COMM_PREF_OVERRIDE_NOTIFY_MAX_EMAIL_ATTEMPTS,
} from "../lib/adminCommPrefOverrideNotify.js";
import { retryFailedAdminCommPrefOverrideEmail } from "../lib/cron.js";
import { sendNotificationPrefAdminOverrideEmail } from "../lib/mailer.js";

const emailMock = vi.mocked(sendNotificationPrefAdminOverrideEmail);

let orgId: number;
let memberUserId: number;
let adminUserId: number;
let clubMemberId: number;
const createdAttemptIds: number[] = [];

let counter = 0;
function uniq(label: string): string {
  counter++;
  return `${label}_${Date.now()}_${counter}_${Math.random().toString(36).slice(2, 8)}`;
}

async function fireNotify(opts: {
  newValue?: boolean;
  previousValue?: boolean;
  reason?: string | null;
  prefKey?: string;
  prefLabel?: string;
} = {}): Promise<number> {
  await notifyMemberOfAdminCommPrefOverride({
    organizationId: orgId,
    targetUserId: memberUserId,
    adminUserId,
    prefKey: opts.prefKey ?? "notifySideGameReceipts",
    prefLabel: opts.prefLabel ?? "Side-game settlement receipts (email)",
    previousValue: opts.previousValue ?? true,
    newValue: opts.newValue ?? false,
    reason: opts.reason ?? "Member asked us to mute these via the front desk",
    clubMemberId,
  });
  // The notify helper is fire-and-forget on the audit/attempts row, so
  // grab the row that was just inserted for this member.
  const rows = await db
    .select()
    .from(adminCommPrefOverrideNotifyAttemptsTable)
    .where(eq(adminCommPrefOverrideNotifyAttemptsTable.targetUserId, memberUserId))
    .orderBy(adminCommPrefOverrideNotifyAttemptsTable.id);
  const last = rows[rows.length - 1];
  expect(last).toBeDefined();
  if (!createdAttemptIds.includes(last.id)) createdAttemptIds.push(last.id);
  return last.id;
}

beforeAll(async () => {
  const stamp = uniq("t1845cp");
  const [org] = await db.insert(organizationsTable).values({
    name: `Org ${stamp}`, slug: stamp,
  }).returning();
  orgId = org.id;

  const [mem] = await db.insert(appUsersTable).values({
    replitUserId: `member-${stamp}`,
    username: `mem_${stamp}`,
    email: `${stamp}@example.com`,
    displayName: "Override Target",
    role: "player",
  }).returning();
  memberUserId = mem.id;

  const [adm] = await db.insert(appUsersTable).values({
    replitUserId: `admin-${stamp}`,
    username: `adm_${stamp}`,
    email: `${stamp}-adm@example.com`,
    displayName: "Override Admin",
    role: "org_admin",
  }).returning();
  adminUserId = adm.id;

  const [cm] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId: memberUserId,
    firstName: "Override",
    lastName: "Target",
    email: `cm-${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  clubMemberId = cm.id;
});

afterAll(async () => {
  if (createdAttemptIds.length > 0) {
    await db.delete(adminCommPrefOverrideNotifyAttemptsTable)
      .where(inArray(adminCommPrefOverrideNotifyAttemptsTable.id, createdAttemptIds));
  }
  await db.delete(memberMessagesTable).where(eq(memberMessagesTable.clubMemberId, clubMemberId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.id, clubMemberId));
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, memberUserId));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [memberUserId, adminUserId]));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  emailMock.mockReset();
  emailMock.mockResolvedValue(undefined as unknown as void);
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, memberUserId));
  // Wipe any leftover attempts rows so cross-test leakage doesn't confuse
  // the cron sweep test.
  if (createdAttemptIds.length > 0) {
    await db.delete(adminCommPrefOverrideNotifyAttemptsTable)
      .where(inArray(adminCommPrefOverrideNotifyAttemptsTable.id, createdAttemptIds));
    createdAttemptIds.length = 0;
  }
});

describe("Task #1845 — admin-comm-pref override notify retry", () => {
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
    const attemptId = await fireNotify({ newValue: false, previousValue: true, reason: "muted at front desk" });

    const [row] = await db
      .select()
      .from(adminCommPrefOverrideNotifyAttemptsTable)
      .where(eq(adminCommPrefOverrideNotifyAttemptsTable.id, attemptId));
    expect(row).toBeDefined();
    expect(row.emailStatus).toBe("failed");
    expect(row.emailAttempts).toBe(1);
    expect(row.lastEmailError).toMatch(/SMTP timeout/);
    expect(row.nextEmailRetryAt).toBeTruthy();
    expect(row.targetUserId).toBe(memberUserId);
    expect(row.adminUserId).toBe(adminUserId);
    expect(row.prefKey).toBe("notifySideGameReceipts");
    expect(row.prefLabel).toBe("Side-game settlement receipts (email)");
    expect(row.previousValue).toBe(true);
    expect(row.newValue).toBe(false);
    expect(row.reason).toBe("muted at front desk");
    expect(row.changedAt).toBeTruthy();
    expect(row.emailRetryExhaustedAt).toBeNull();
  });

  it("persists a 'sent' row when the first send succeeds and never schedules a retry", async () => {
    const attemptId = await fireNotify();
    const [row] = await db
      .select()
      .from(adminCommPrefOverrideNotifyAttemptsTable)
      .where(eq(adminCommPrefOverrideNotifyAttemptsTable.id, attemptId));
    expect(row.emailStatus).toBe("sent");
    expect(row.emailAttempts).toBe(1);
    expect(row.nextEmailRetryAt).toBeNull();
    expect(row.lastEmailError).toBeNull();
  });

  it("retryAdminCommPrefOverrideEmail clears nextEmailRetryAt and bumps attempts on a successful retry", async () => {
    emailMock.mockRejectedValueOnce(new Error("transient SMTP"));
    const attemptId = await fireNotify();

    let [row] = await db.select().from(adminCommPrefOverrideNotifyAttemptsTable)
      .where(eq(adminCommPrefOverrideNotifyAttemptsTable.id, attemptId));
    expect(row.emailStatus).toBe("failed");

    const ret = await retryAdminCommPrefOverrideEmail({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret).not.toBeNull();
    expect(ret!.status).toBe("sent");
    expect(emailMock).toHaveBeenCalledTimes(2);

    [row] = await db.select().from(adminCommPrefOverrideNotifyAttemptsTable)
      .where(eq(adminCommPrefOverrideNotifyAttemptsTable.id, attemptId));
    expect(row.emailStatus).toBe("sent");
    expect(row.emailAttempts).toBe(2);
    expect(row.nextEmailRetryAt).toBeNull();
    expect(row.emailRetryExhaustedAt).toBeNull();
    expect(row.lastEmailError).toBeNull();
  });

  it("retryAdminCommPrefOverrideEmail returns null when the backoff window has not elapsed", async () => {
    emailMock.mockRejectedValueOnce(new Error("SMTP down"));
    const attemptId = await fireNotify();

    const [row] = await db.select().from(adminCommPrefOverrideNotifyAttemptsTable)
      .where(eq(adminCommPrefOverrideNotifyAttemptsTable.id, attemptId));
    const ret = await retryAdminCommPrefOverrideEmail({ attempt: row, now: new Date() });
    expect(ret).toBeNull();
    expect(emailMock).toHaveBeenCalledTimes(1);
  });

  it("retryAdminCommPrefOverrideEmail stamps emailRetryExhaustedAt after the cap is reached", async () => {
    emailMock.mockRejectedValue(new Error("SMTP perm"));
    const attemptId = await fireNotify();

    let now = new Date();
    for (let i = 0; i < ADMIN_COMM_PREF_OVERRIDE_NOTIFY_MAX_EMAIL_ATTEMPTS; i++) {
      const [row] = await db.select().from(adminCommPrefOverrideNotifyAttemptsTable)
        .where(eq(adminCommPrefOverrideNotifyAttemptsTable.id, attemptId));
      now = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const ret = await retryAdminCommPrefOverrideEmail({ attempt: row, now });
      if (!ret) break;
    }
    const [row] = await db.select().from(adminCommPrefOverrideNotifyAttemptsTable)
      .where(eq(adminCommPrefOverrideNotifyAttemptsTable.id, attemptId));
    expect(row.emailAttempts).toBe(ADMIN_COMM_PREF_OVERRIDE_NOTIFY_MAX_EMAIL_ATTEMPTS);
    expect(row.emailStatus).toBe("failed");
    expect(row.emailRetryExhaustedAt).toBeTruthy();
    expect(row.nextEmailRetryAt).toBeNull();

    // And once exhausted, further calls return null instead of bumping
    // attempts beyond the cap.
    const tail = await retryAdminCommPrefOverrideEmail({
      attempt: row, now: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    });
    expect(tail).toBeNull();

    emailMock.mockReset();
    emailMock.mockResolvedValue(undefined as unknown as void);
  });

  it("retryAdminCommPrefOverrideEmail returns null once status flips off 'failed'", async () => {
    const attemptId = await fireNotify();
    const [row] = await db.select().from(adminCommPrefOverrideNotifyAttemptsTable)
      .where(eq(adminCommPrefOverrideNotifyAttemptsTable.id, attemptId));
    expect(row.emailStatus).toBe("sent");
    const ret = await retryAdminCommPrefOverrideEmail({
      attempt: row, now: new Date(Date.now() + 60 * 60 * 1000),
    });
    expect(ret).toBeNull();
  });

  it("retryAdminCommPrefOverrideEmail honours preferEmail opt-out flipped between original send and retry", async () => {
    emailMock.mockRejectedValueOnce(new Error("transient SMTP"));
    const attemptId = await fireNotify();

    let [row] = await db.select().from(adminCommPrefOverrideNotifyAttemptsTable)
      .where(eq(adminCommPrefOverrideNotifyAttemptsTable.id, attemptId));
    expect(row.emailStatus).toBe("failed");

    await db.insert(userNotificationPrefsTable).values({
      userId: memberUserId, preferEmail: false, preferPush: true,
    });

    emailMock.mockClear();
    const ret = await retryAdminCommPrefOverrideEmail({
      attempt: row, now: new Date(Date.now() + 6 * 60 * 1000),
    });
    expect(ret).not.toBeNull();
    expect(ret!.status).toBe("opted_out");
    expect(emailMock).not.toHaveBeenCalled();

    [row] = await db.select().from(adminCommPrefOverrideNotifyAttemptsTable)
      .where(eq(adminCommPrefOverrideNotifyAttemptsTable.id, attemptId));
    expect(row.emailStatus).toBe("opted_out");
    expect(row.nextEmailRetryAt).toBeNull();
  });

  it("retryFailedAdminCommPrefOverrideEmail only picks up due rows", async () => {
    // Row A: failed + due → must be retried.
    emailMock.mockRejectedValueOnce(new Error("transient A"));
    const attemptA = await fireNotify({ prefKey: "preferEmail", prefLabel: "Email notifications" });
    await db.update(adminCommPrefOverrideNotifyAttemptsTable).set({
      nextEmailRetryAt: new Date(Date.now() - 60 * 60 * 1000),
    }).where(eq(adminCommPrefOverrideNotifyAttemptsTable.id, attemptA));

    // Row B: failed + NOT due → cron must skip.
    emailMock.mockRejectedValueOnce(new Error("transient B"));
    const attemptB = await fireNotify({ prefKey: "preferPush", prefLabel: "Push notifications" });
    await db.update(adminCommPrefOverrideNotifyAttemptsTable).set({
      nextEmailRetryAt: new Date(Date.now() + 60 * 60 * 1000),
    }).where(eq(adminCommPrefOverrideNotifyAttemptsTable.id, attemptB));

    // Row C: already sent → cron must skip.
    const attemptC = await fireNotify({ prefKey: "preferSms", prefLabel: "SMS notifications" });

    emailMock.mockClear();
    emailMock.mockResolvedValueOnce(undefined as unknown as void);

    await retryFailedAdminCommPrefOverrideEmail();

    expect(emailMock).toHaveBeenCalledTimes(1);
    const [aRow] = await db.select().from(adminCommPrefOverrideNotifyAttemptsTable)
      .where(eq(adminCommPrefOverrideNotifyAttemptsTable.id, attemptA));
    const [bRow] = await db.select().from(adminCommPrefOverrideNotifyAttemptsTable)
      .where(eq(adminCommPrefOverrideNotifyAttemptsTable.id, attemptB));
    const [cRow] = await db.select().from(adminCommPrefOverrideNotifyAttemptsTable)
      .where(eq(adminCommPrefOverrideNotifyAttemptsTable.id, attemptC));
    expect(aRow.emailStatus).toBe("sent");
    expect(aRow.emailAttempts).toBe(2);
    expect(bRow.emailStatus).toBe("failed");
    expect(bRow.emailAttempts).toBe(1);
    expect(cRow.emailStatus).toBe("sent");
    expect(cRow.emailAttempts).toBe(1);
  });

  it("provider_not_configured on first send is recorded as terminal skipped (not retried)", async () => {
    emailMock.mockRejectedValueOnce(new Error("RESEND_API_KEY not set"));
    const attemptId = await fireNotify();

    const [row] = await db.select().from(adminCommPrefOverrideNotifyAttemptsTable)
      .where(eq(adminCommPrefOverrideNotifyAttemptsTable.id, attemptId));
    expect(row.emailStatus).toBe("skipped");
    expect(row.lastEmailError).toBe("provider_not_configured");
    expect(row.nextEmailRetryAt).toBeNull();
  });
});
