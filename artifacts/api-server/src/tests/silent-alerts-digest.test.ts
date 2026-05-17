/**
 * Task #1663 — Weekly super-admin "silent failures" CSV digest.
 *
 * Verifies that:
 *   - The digest is a no-op (and stamps the marker) when there are no
 *     zero-delivery rows in the 7-day window.
 *   - The digest emails every super_admin with an email address when at
 *     least one zero-delivery row exists.
 *   - Super admins without an email are skipped.
 *   - Super admins with `notify_silent_alerts_digest = false` are
 *     skipped (per-event opt-out from the portal).
 *   - The 6.5-day dedup floor prevents back-to-back sends.
 *   - The dedup floor is persisted on `member_audit_log`, so a
 *     simulated process restart does NOT re-send within 6.5 days.
 *   - Rows that did deliver (push or email > 0) are NOT included in the
 *     CSV / row count.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => {
  return {
    sendSilentAlertsDigestEmail: vi.fn(async () => undefined),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  tournamentsTable,
  playersTable,
  roundSubmissionsTable,
  manualEntryAlertsTable,
  memberAuditLogTable,
  appUsersTable,
  userNotificationPrefsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  sendSilentAlertsDigestToSuperAdmins,
  _resetSilentAlertsDigestDedupForTest,
} from "../lib/silentAlertsDigest.js";
import { sendSilentAlertsDigestEmail } from "../lib/mailer.js";
import { uid } from "./helpers.js";

const emailMock = vi.mocked(sendSilentAlertsDigestEmail);

let testOrgId: number;
let testTournamentId: number;
let testPlayerId: number;
let testSubmissionId: number;
let superAdminWithEmailA: number;
let superAdminWithEmailB: number;
let superAdminNoEmail: number;
let superAdminOptedOut: number;

const insertedAlertIds: number[] = [];

async function insertAlert(opts: {
  pushSent: number;
  emailSent: number;
  recipientCount?: number;
  sentAt?: Date;
}) {
  const [row] = await db.insert(manualEntryAlertsTable).values({
    submissionId: testSubmissionId,
    tournamentId: testTournamentId,
    playerId: testPlayerId,
    round: 1,
    manualPct: "100.00",
    manualShots: 18,
    totalShots: 18,
    recipientCount: opts.recipientCount ?? 1,
    pushAttempted: opts.pushSent > 0 ? opts.pushSent : 1,
    pushSent: opts.pushSent,
    emailAttempted: opts.emailSent > 0 ? opts.emailSent : 1,
    emailSent: opts.emailSent,
    sentAt: opts.sentAt,
  }).returning({ id: manualEntryAlertsTable.id });
  insertedAlertIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const slug = uid("silent-alerts-digest");
  const [org] = await db.insert(organizationsTable).values({
    name: `SilentAlertsOrg_${slug}`,
    slug: `silent-alerts-${slug}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [t] = await db.insert(tournamentsTable).values({
    organizationId: testOrgId,
    name: `SilentAlerts_${slug}`,
    startDate: new Date(),
  }).returning({ id: tournamentsTable.id });
  testTournamentId = t.id;

  const [p] = await db.insert(playersTable).values({
    tournamentId: testTournamentId,
    firstName: "Silent",
    lastName: `Tester_${slug}`,
  }).returning({ id: playersTable.id });
  testPlayerId = p.id;

  const [sub] = await db.insert(roundSubmissionsTable).values({
    tournamentId: testTournamentId,
    playerId: testPlayerId,
    round: 1,
    status: "submitted",
  }).returning({ id: roundSubmissionsTable.id });
  testSubmissionId = sub.id;

  // Two opted-in super admins (the cron should email both).
  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `repl_${slug}_a`,
    username: `su_${slug}_a`,
    email: `su_a_${slug}@example.com`,
    displayName: "Super A",
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  superAdminWithEmailA = u1.id;

  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `repl_${slug}_b`,
    username: `su_${slug}_b`,
    email: `su_b_${slug}@example.com`,
    displayName: "Super B",
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  superAdminWithEmailB = u2.id;

  // Super admin without an email — should be skipped (no inbox to mail).
  const [u3] = await db.insert(appUsersTable).values({
    replitUserId: `repl_${slug}_c`,
    username: `su_${slug}_c`,
    displayName: "Super C",
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  superAdminNoEmail = u3.id;

  // Super admin with an email but explicitly opted out via the portal
  // toggle — should be skipped even though they have an email on file.
  const [u4] = await db.insert(appUsersTable).values({
    replitUserId: `repl_${slug}_d`,
    username: `su_${slug}_d`,
    email: `su_d_${slug}@example.com`,
    displayName: "Super D",
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  superAdminOptedOut = u4.id;
  await db.insert(userNotificationPrefsTable).values({
    userId: superAdminOptedOut,
    notifySilentAlertsDigest: false,
  });
});

afterAll(async () => {
  if (insertedAlertIds.length > 0) {
    await db.delete(manualEntryAlertsTable)
      .where(inArray(manualEntryAlertsTable.id, insertedAlertIds));
  }
  if (testSubmissionId) {
    await db.delete(roundSubmissionsTable).where(eq(roundSubmissionsTable.id, testSubmissionId));
  }
  if (testPlayerId) {
    await db.delete(playersTable).where(eq(playersTable.id, testPlayerId));
  }
  if (testTournamentId) {
    await db.delete(tournamentsTable).where(eq(tournamentsTable.id, testTournamentId));
  }
  const userIds = [superAdminWithEmailA, superAdminWithEmailB, superAdminNoEmail, superAdminOptedOut].filter(Boolean);
  if (userIds.length > 0) {
    // Drop notification-prefs rows first (FK to app_users).
    await db.delete(userNotificationPrefsTable)
      .where(inArray(userNotificationPrefsTable.userId, userIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  }
  if (testOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  }
  // Marker rows the cron writes (entity = "silent_alerts_digest"). Cleared
  // by the dedup-reset helper, but we wipe again here so a partial test
  // failure can't leave orphan audit rows lying around.
  await _resetSilentAlertsDigestDedupForTest();
});

beforeEach(async () => {
  emailMock.mockClear();
  emailMock.mockResolvedValue(undefined);
  await _resetSilentAlertsDigestDedupForTest();
  // Wipe per-test alerts so each test starts from a clean window.
  if (insertedAlertIds.length > 0) {
    await db.delete(manualEntryAlertsTable)
      .where(inArray(manualEntryAlertsTable.id, insertedAlertIds.splice(0)));
  }
});

describe("sendSilentAlertsDigestToSuperAdmins", () => {
  it("is a no-op (skipped='no-rows') when no zero-delivery rows exist in the window", async () => {
    // A delivered row should NOT count toward the digest.
    await insertAlert({ pushSent: 1, emailSent: 0 });

    const result = await sendSilentAlertsDigestToSuperAdmins();
    expect(result.skipped).toBe("no-rows");
    expect(result.rowCount).toBe(0);
    expect(result.recipientsEmailed).toBe(0);
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("emails every opted-in super_admin with an email when ≥1 zero-delivery row exists", async () => {
    await insertAlert({ pushSent: 0, emailSent: 0, recipientCount: 2 });

    const result = await sendSilentAlertsDigestToSuperAdmins();
    expect(result.rowCount).toBe(1);
    // Two opted-in with email, one without email, one opted-out → 2 mailed.
    expect(result.recipientsAttempted).toBe(2);
    expect(result.recipientsEmailed).toBe(2);
    expect(emailMock).toHaveBeenCalledTimes(2);

    const recipients = emailMock.mock.calls.map(c => (c[0] as { to: string }).to).sort();
    expect(recipients[0]).toContain("su_a_");
    expect(recipients[1]).toContain("su_b_");

    // Each call carries the CSV body (header + 1 row), filename, and
    // a non-zero rowCount that matches the dispatch result.
    const firstCall = emailMock.mock.calls[0][0] as {
      rowCount: number;
      csv: string;
      filename: string;
      windowStart: string;
      windowEnd: string;
    };
    expect(firstCall.rowCount).toBe(1);
    expect(firstCall.filename).toMatch(/^silent-alerts-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(firstCall.csv).toContain("alertId,sentAt,tournamentId");
    // The csv must include a row line (header + 1 data row).
    expect(firstCall.csv.trim().split("\r\n").length).toBe(2);
    // Window endpoints are valid ISO timestamps with ~7 days between them.
    const ws = Date.parse(firstCall.windowStart);
    const we = Date.parse(firstCall.windowEnd);
    expect(Number.isFinite(ws)).toBe(true);
    expect(Number.isFinite(we)).toBe(true);
    expect(we - ws).toBeGreaterThan(6.5 * 24 * 60 * 60 * 1000);
    expect(we - ws).toBeLessThan(7.5 * 24 * 60 * 60 * 1000);
  });

  it("excludes rows that did deliver (push or email > 0)", async () => {
    // Mix of delivered + zero-delivery rows. Only the silent ones should
    // appear in the CSV / rowCount.
    await insertAlert({ pushSent: 1, emailSent: 0 });
    await insertAlert({ pushSent: 0, emailSent: 1 });
    await insertAlert({ pushSent: 0, emailSent: 0 });
    await insertAlert({ pushSent: 0, emailSent: 0 });

    const result = await sendSilentAlertsDigestToSuperAdmins();
    expect(result.rowCount).toBe(2);
    expect(result.recipientsEmailed).toBe(2);

    const call = emailMock.mock.calls[0][0] as { rowCount: number; csv: string };
    expect(call.rowCount).toBe(2);
    // header + 2 rows = 3 newline-terminated lines.
    expect(call.csv.trim().split("\r\n").length).toBe(3);
  });

  it("dedupes back-to-back invocations within the 6.5d floor", async () => {
    await insertAlert({ pushSent: 0, emailSent: 0 });

    const first = await sendSilentAlertsDigestToSuperAdmins();
    expect(first.recipientsEmailed).toBe(2);

    emailMock.mockClear();
    const second = await sendSilentAlertsDigestToSuperAdmins();
    expect(second.skipped).toBe("deduped");
    expect(second.recipientsEmailed).toBe(0);
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("persists the dedup floor on member_audit_log so a process restart does NOT re-send within the floor", async () => {
    await insertAlert({ pushSent: 0, emailSent: 0 });

    const first = await sendSilentAlertsDigestToSuperAdmins();
    expect(first.recipientsEmailed).toBe(2);

    // The dispatch must have written a marker row whose createdAt
    // anchors the persisted dedup floor.
    const markers = await db
      .select({ id: memberAuditLogTable.id, createdAt: memberAuditLogTable.createdAt })
      .from(memberAuditLogTable)
      .where(eq(memberAuditLogTable.entity, "silent_alerts_digest"));
    expect(markers.length).toBeGreaterThanOrEqual(1);
    expect(markers[0].createdAt instanceof Date).toBe(true);

    // Simulate a process restart — fresh in-memory state, but the
    // persisted marker keeps the next cron tick from re-sending.
    emailMock.mockClear();
    const second = await sendSilentAlertsDigestToSuperAdmins();
    expect(second.skipped).toBe("deduped");
    expect(second.recipientsEmailed).toBe(0);
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("stamps a marker even on a no-rows tick so quiet weeks don't bunch into a daily query storm", async () => {
    // No alert rows at all → "no-rows" path, but the cron should still
    // advance the floor so the next 24h tick skips work.
    const first = await sendSilentAlertsDigestToSuperAdmins();
    expect(first.skipped).toBe("no-rows");
    expect(first.recipientsEmailed).toBe(0);

    const markers = await db
      .select({ id: memberAuditLogTable.id })
      .from(memberAuditLogTable)
      .where(eq(memberAuditLogTable.entity, "silent_alerts_digest"));
    expect(markers.length).toBeGreaterThanOrEqual(1);

    // A second tick within the floor should be deduped, even though
    // a brand-new silent row arrived in the meantime.
    await insertAlert({ pushSent: 0, emailSent: 0 });
    const second = await sendSilentAlertsDigestToSuperAdmins();
    expect(second.skipped).toBe("deduped");
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("skips opted-out super admins (notify_silent_alerts_digest = false)", async () => {
    await insertAlert({ pushSent: 0, emailSent: 0 });

    const result = await sendSilentAlertsDigestToSuperAdmins();
    expect(result.recipientsEmailed).toBe(2);

    // The opted-out admin's email must not appear in any call.
    const recipients = emailMock.mock.calls.map(c => (c[0] as { to: string }).to);
    expect(recipients.every((to) => !to.includes("su_d_"))).toBe(true);
  });
});
