/**
 * Task #1233 — wallet auto-refund digest dispatch failures must:
 *   1. Pause bounced/unsubscribed recipients (= remove from the
 *      schedule's stored recipients list and from the current send),
 *      so a misconfigured inbox does not silently swallow weeks of
 *      digests.
 *   2. Raise a `wallet.refund.digest.failed` notification to the org's
 *      admins / treasurers when (a) the mailer rejects the send, or
 *      (b) every configured recipient is paused (nothing to send).
 *   3. Still fire the notification on a single mailer failure (the
 *      "N consecutive failures" requirement is met by including the
 *      consecutive-failure count in the payload — admins see it
 *      escalating naturally).
 *
 * The mailer module is mocked so the suite never touches SMTP. The
 * Postgres database, suppression table, and `dispatchNotification`
 * pathway (registry → user prefs → notification audit) are all real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendWalletTopupRefundScheduleEmail: vi.fn(async () => {}),
  };
});

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
  walletTopupRefundEmailSchedulesTable,
  walletTopupRefundEmailRunsTable,
  emailSuppressionsTable,
  notificationAuditLogTable,
} from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { runOneWalletTopupRefundEmailSchedule } from "../routes/side-games-v2.js";
import { sendWalletTopupRefundScheduleEmail } from "../lib/mailer.js";
import { hydrate as hydrateRegistry } from "../lib/notificationRegistry.js";
import { _clearSpecCacheForTests } from "../lib/notifyDispatch.js";
import { uid } from "./helpers.js";

const sendMock = vi.mocked(sendWalletTopupRefundScheduleEmail);

let orgId: number;
let adminId: number;
let treasurerId: number;
let nonAdminId: number;
let scheduleId: number;

beforeAll(async () => {
  const tag = uid("t1233");
  const [org] = await db.insert(organizationsTable).values({
    name: `T1233 ${tag}`,
    slug: tag,
    contactEmail: `${tag}@example.test`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-admin`,
    username: `${tag}_admin`,
    email: `admin_${tag}@example.test`,
    displayName: "Refund Digest Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminId = admin.id;

  const [treasurer] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-treas`,
    username: `${tag}_treas`,
    email: `treas_${tag}@example.test`,
    displayName: "Refund Digest Treasurer",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  treasurerId = treasurer.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: treasurerId, role: "treasurer",
  });

  const [nonAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-player`,
    username: `${tag}_player`,
    email: `player_${tag}@example.test`,
    displayName: "Refund Digest Player",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  nonAdminId = nonAdmin.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: nonAdminId, role: "player",
  });

  await hydrateRegistry();
  _clearSpecCacheForTests();
});

afterAll(async () => {
  await db.delete(notificationAuditLogTable).where(eq(notificationAuditLogTable.notificationKey, "wallet.refund.digest.failed"));
  await db.delete(walletTopupRefundEmailRunsTable).where(eq(walletTopupRefundEmailRunsTable.organizationId, orgId));
  await db.delete(walletTopupRefundEmailSchedulesTable).where(eq(walletTopupRefundEmailSchedulesTable.organizationId, orgId));
  await db.delete(emailSuppressionsTable).where(eq(emailSuppressionsTable.organizationId, orgId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, orgId));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [adminId, treasurerId, nonAdminId]));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  sendMock.mockClear();
  sendMock.mockImplementation(async () => {});
  await db.delete(notificationAuditLogTable).where(eq(notificationAuditLogTable.notificationKey, "wallet.refund.digest.failed"));
  await db.delete(walletTopupRefundEmailRunsTable).where(eq(walletTopupRefundEmailRunsTable.organizationId, orgId));
  await db.delete(walletTopupRefundEmailSchedulesTable).where(eq(walletTopupRefundEmailSchedulesTable.organizationId, orgId));
  await db.delete(emailSuppressionsTable).where(eq(emailSuppressionsTable.organizationId, orgId));

  const [s] = await db.insert(walletTopupRefundEmailSchedulesTable).values({
    organizationId: orgId,
    frequency: "weekly",
    recipients: ["finance@example.test", "ops@example.test"],
    nextRunAt: new Date(),
  }).returning({ id: walletTopupRefundEmailSchedulesTable.id });
  scheduleId = s.id;
});

describe("Task #1233 — wallet auto-refund digest failure handling", () => {
  it("pauses every recipient when all are on the suppression list, skips the send, and notifies admins", async () => {
    // Pre-seed suppressions for both configured recipients (lower-cased
    // by the bounce webhook).
    await db.insert(emailSuppressionsTable).values([
      { organizationId: orgId, email: "finance@example.test", reason: "bounced", bounceType: "HardBounce" },
      { organizationId: orgId, email: "ops@example.test", reason: "bounced", bounceType: "BadMailbox" },
    ]);

    const result = await runOneWalletTopupRefundEmailSchedule(scheduleId);

    expect(result.status).toBe("skipped");
    expect(result.recipients).toEqual([]);
    expect(result.pausedRecipients?.sort()).toEqual(["finance@example.test", "ops@example.test"]);
    // Mailer must NOT be called when the entire recipient list is paused.
    expect(sendMock).not.toHaveBeenCalled();

    // Schedule's stored recipients should now be empty (paused).
    const [sched] = await db.select().from(walletTopupRefundEmailSchedulesTable)
      .where(eq(walletTopupRefundEmailSchedulesTable.id, scheduleId));
    expect(sched.recipients).toEqual([]);

    // Run row was inserted with status=skipped and a descriptive errorMessage.
    const runs = await db.select().from(walletTopupRefundEmailRunsTable)
      .where(eq(walletTopupRefundEmailRunsTable.scheduleId, scheduleId));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("skipped");
    expect(runs[0].errorMessage).toMatch(/paused all configured recipients/);
    // Task #1759 — the run row must persist a per-recipient snapshot of
    // who was paused (with reason metadata) so the dashboard's history
    // table can show the chip on this run even after finance later
    // lifts the suppression.
    expect(Array.isArray(runs[0].pausedRecipients)).toBe(true);
    const allPausedSnapshot = [...runs[0].pausedRecipients].sort((a, b) => a.email.localeCompare(b.email));
    expect(allPausedSnapshot).toEqual([
      { email: "finance@example.test", reason: "bounced", bounceType: "HardBounce", description: null },
      { email: "ops@example.test", reason: "bounced", bounceType: "BadMailbox", description: null },
    ]);

    // Both admin and treasurer must have audit rows for the dispatch
    // — direct org_admin app_user AND org_memberships role=treasurer.
    // Plain players must NOT. (auditRequired:true on the registry entry
    // makes `dispatchNotification` write one row per recipient/channel.)
    const adminAudit = await loadAuditFor(adminId);
    const treasAudit = await loadAuditFor(treasurerId);
    const playerAudit = await loadAuditFor(nonAdminId);
    expect(adminAudit.length).toBeGreaterThan(0);
    expect(treasAudit.length).toBeGreaterThan(0);
    expect(playerAudit).toHaveLength(0);

    const adminPayload = adminAudit[0].payload as Record<string, unknown>;
    expect(adminPayload.scheduleId).toBe(scheduleId);
    expect(adminPayload.status).toBe("skipped");
    expect(adminPayload.consecutiveFailures).toBe(1);
    expect((adminPayload.pausedRecipients as string[]).sort()).toEqual(["finance@example.test", "ops@example.test"]);
  });

  it("notifies admins when the mailer rejects the send and reports an escalating consecutive-failure count", async () => {
    // First run: mailer throws → status=failed, consecutiveFailures=1.
    sendMock.mockImplementationOnce(async () => { throw new Error("Postmark 422 InactiveRecipient"); });

    const r1 = await runOneWalletTopupRefundEmailSchedule(scheduleId);
    expect(r1.status).toBe("failed");
    expect(r1.errorMessage).toMatch(/Postmark/);
    expect(sendMock).toHaveBeenCalledTimes(1);

    const dispatch1 = await loadLatestDispatchPayload(adminId);
    expect(dispatch1).toBeDefined();
    expect(dispatch1!.consecutiveFailures).toBe(1);
    expect(dispatch1!.status).toBe("failed");

    // Second run: mailer throws again → consecutiveFailures must
    // increment to 2, demonstrating the "N consecutive failures"
    // escalation requirement.
    sendMock.mockImplementationOnce(async () => { throw new Error("Postmark 422 InactiveRecipient"); });
    const r2 = await runOneWalletTopupRefundEmailSchedule(scheduleId);
    expect(r2.status).toBe("failed");

    const dispatch2 = await loadLatestDispatchPayload(adminId);
    expect(dispatch2!.consecutiveFailures).toBe(2);
  });

  it("pauses only the bounced recipient on a partial-suppression run, sends to the survivor, and does NOT raise the failure notification", async () => {
    await db.insert(emailSuppressionsTable).values({
      organizationId: orgId, email: "ops@example.test", reason: "spam_complaint", bounceType: "SpamComplaint",
    });

    const result = await runOneWalletTopupRefundEmailSchedule(scheduleId);

    expect(result.status).toBe("sent");
    expect(result.recipients).toEqual(["finance@example.test"]);
    expect(result.pausedRecipients).toEqual(["ops@example.test"]);

    // Mailer was called with only the surviving recipient.
    expect(sendMock).toHaveBeenCalledTimes(1);
    const sendArgs = sendMock.mock.calls[0]?.[0];
    expect(sendArgs?.to).toEqual(["finance@example.test"]);
    // Branding includes orgId so future bounces from this digest get
    // attributed to the right club via Postmark Metadata.
    expect(sendArgs?.branding?.orgId).toBe(orgId);

    // Schedule's stored recipients shrank to just the survivor.
    const [sched] = await db.select().from(walletTopupRefundEmailSchedulesTable)
      .where(eq(walletTopupRefundEmailSchedulesTable.id, scheduleId));
    expect(sched.recipients).toEqual(["finance@example.test"]);

    // Run row records the pause in errorMessage even though status=sent.
    const runs = await db.select().from(walletTopupRefundEmailRunsTable)
      .where(eq(walletTopupRefundEmailRunsTable.scheduleId, scheduleId));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("sent");
    expect(runs[0].errorMessage).toMatch(/paused 1 bounced.*ops@example\.test/);
    // Task #1759 — even on a partially-successful run, the dropped
    // recipient must be snapshotted onto the run row so the dashboard's
    // history table can show "1 paused" with the bounce reason.
    expect(runs[0].pausedRecipients).toEqual([
      { email: "ops@example.test", reason: "spam_complaint", bounceType: "SpamComplaint", description: null },
    ]);

    // No admin notification — the digest WAS delivered, so finance
    // already has visibility through the run history; we only escalate
    // when nothing went out OR the mailer threw.
    const adminAudit = await loadAuditFor(adminId);
    expect(adminAudit).toHaveLength(0);
  });

  it("advances the cadence after auto-pausing every recipient so a second poll does not re-fire on the same period", async () => {
    // First run: every recipient is suppressed → schedule's recipients
    // list is auto-trimmed to []; the run row is recorded as skipped
    // and `nextRunAt` advances to the next cadence.
    await db.insert(emailSuppressionsTable).values([
      { organizationId: orgId, email: "finance@example.test", reason: "bounced" },
      { organizationId: orgId, email: "ops@example.test", reason: "bounced" },
    ]);
    const r1 = await runOneWalletTopupRefundEmailSchedule(scheduleId);
    expect(r1.status).toBe("skipped");

    const [after1] = await db.select().from(walletTopupRefundEmailSchedulesTable)
      .where(eq(walletTopupRefundEmailSchedulesTable.id, scheduleId));
    expect(after1.recipients).toEqual([]);
    const firstNextRunAt = after1.nextRunAt;
    expect(firstNextRunAt).not.toBeNull();
    expect(after1.lastSentAt).not.toBeNull();

    // Second run on the same schedule (simulates the cron polling
    // again before the next cadence elapses). The "no recipients
    // configured" early-return must STILL advance the cadence so the
    // cron does not re-fire skipped runs on every tick.
    const r2 = await runOneWalletTopupRefundEmailSchedule(scheduleId);
    expect(r2.status).toBe("skipped");
    expect(r2.errorMessage).toMatch(/no recipients configured/);

    const [after2] = await db.select().from(walletTopupRefundEmailSchedulesTable)
      .where(eq(walletTopupRefundEmailSchedulesTable.id, scheduleId));
    // `nextRunAt` must have moved forward (the second poll wrote a
    // fresh `now` into it) — proving the cadence advanced again.
    expect(after2.nextRunAt!.getTime()).toBeGreaterThanOrEqual(firstNextRunAt!.getTime());

    // Two skipped runs in the history (one per poll), each with its
    // own `lastSentAt` advancement on the schedule.
    const runs = await db.select().from(walletTopupRefundEmailRunsTable)
      .where(eq(walletTopupRefundEmailRunsTable.scheduleId, scheduleId))
      .orderBy(walletTopupRefundEmailRunsTable.id);
    expect(runs).toHaveLength(2);
    expect(runs.every(r => r.status === "skipped")).toBe(true);
    // Task #1759 — first poll snapshotted both suppressed addresses;
    // second poll's "no recipients configured" early-return ran with an
    // already-empty list and therefore must record an empty snapshot.
    const firstPaused = [...runs[0].pausedRecipients].sort((a, b) => a.email.localeCompare(b.email));
    expect(firstPaused.map(p => p.email)).toEqual(["finance@example.test", "ops@example.test"]);
    expect(runs[1].pausedRecipients).toEqual([]);

    // Both polls must have notified the org admin so finance keeps
    // being reminded each cadence the digest is undelivered. The
    // `auditDedupe` helper collapses dispatches that share a 2s
    // bucket, so the two distinct runs above (each with their own
    // db.insert + dispatch) should produce two distinct audit rows.
    const adminAudit = await loadAuditFor(adminId);
    expect(adminAudit.length).toBeGreaterThanOrEqual(2);
  });

  it("resets the consecutive-failure count after a successful recovery run", async () => {
    // Failure → counter=1
    sendMock.mockImplementationOnce(async () => { throw new Error("transient SMTP error"); });
    const r1 = await runOneWalletTopupRefundEmailSchedule(scheduleId);
    expect(r1.status).toBe("failed");

    // Recovery → counter does NOT increment (no notification fired).
    const r2 = await runOneWalletTopupRefundEmailSchedule(scheduleId);
    expect(r2.status).toBe("sent");

    // Failure again → counter must restart at 1 because the last run
    // succeeded (the "consecutive" walk halts at the recovered run).
    sendMock.mockImplementationOnce(async () => { throw new Error("transient SMTP error #2"); });
    const r3 = await runOneWalletTopupRefundEmailSchedule(scheduleId);
    expect(r3.status).toBe("failed");

    const dispatches = await loadDispatchPayloadsForUser(adminId);
    expect(dispatches.length).toBe(2);
    // Most recent failure: counter reset to 1.
    expect(dispatches[0].consecutiveFailures).toBe(1);
    // Original failure: still 1.
    expect(dispatches[1].consecutiveFailures).toBe(1);
  });
});

/** All audit rows for a given admin user, scoped to our notification key. */
async function loadAuditFor(userId: number) {
  return db.select().from(notificationAuditLogTable)
    .where(and(
      eq(notificationAuditLogTable.userId, userId),
      eq(notificationAuditLogTable.notificationKey, "wallet.refund.digest.failed"),
    ))
    .orderBy(desc(notificationAuditLogTable.createdAt));
}

/**
 * Distinct dispatch payloads (one entry per call to `dispatchNotification`)
 * for an admin, newest first. The audit table writes one row per channel
 * per recipient for an audit-required key, so a single dispatch produces
 * multiple rows that share an exact `createdAt` — we collapse on that
 * timestamp so callers can count "how many times was this admin notified"
 * without channel-arity skew.
 */
async function loadDispatchPayloadsForUser(userId: number) {
  const rows = await loadAuditFor(userId);
  // Audit rows produced by a single dispatch arrive within a few hundred
  // milliseconds (one row per channel inserted in a tight loop). We
  // bucket by a 2-second window to collapse them into one logical
  // "this admin was notified once" entry while still keeping distinct
  // dispatches that happen seconds apart in the test separate.
  const BUCKET_MS = 2_000;
  const seen = new Set<number>();
  const out: Array<{ scheduleId: unknown; status: unknown; consecutiveFailures: number; pausedRecipients: unknown; errorMessage: unknown; organizationId: unknown }> = [];
  for (const r of rows) {
    const p = (r.payload as Record<string, unknown>) ?? {};
    const tsMs = r.createdAt instanceof Date ? r.createdAt.getTime() : new Date(r.createdAt as string).getTime();
    const bucket = Math.floor(tsMs / BUCKET_MS);
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    out.push({
      scheduleId: p.scheduleId,
      status: p.status,
      consecutiveFailures: Number(p.consecutiveFailures ?? 0),
      pausedRecipients: p.pausedRecipients,
      errorMessage: p.errorMessage,
      organizationId: p.organizationId,
    });
  }
  return out;
}

async function loadLatestDispatchPayload(userId: number) {
  const rows = await loadDispatchPayloadsForUser(userId);
  return rows[0];
}
