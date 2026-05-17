/**
 * Task #1444 — club-wide combined levy ledger CSV digest failure
 * handling. Same three guarantees as the per-levy digest above but
 * dispatched under `levy.ledger.org.digest.failed`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendOrgLevyLedgerScheduleEmail: vi.fn(async () => {}),
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
  levyLedgerEmailOrgSchedulesTable,
  levyLedgerEmailOrgRunsTable,
  emailSuppressionsTable,
  notificationAuditLogTable,
} from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { runOneOrgLevyLedgerEmailSchedule } from "../routes/member-360.js";
import { sendOrgLevyLedgerScheduleEmail } from "../lib/mailer.js";
import { hydrate as hydrateRegistry } from "../lib/notificationRegistry.js";
import { _clearSpecCacheForTests } from "../lib/notifyDispatch.js";
import { uid } from "./helpers.js";

const sendMock = vi.mocked(sendOrgLevyLedgerScheduleEmail);

let orgId: number;
let adminId: number;
let treasurerId: number;
let nonAdminId: number;
let scheduleId: number;

beforeAll(async () => {
  const tag = uid("t1444b");
  const [org] = await db.insert(organizationsTable).values({
    name: `T1444b ${tag}`,
    slug: tag,
    contactEmail: `${tag}@example.test`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-admin`,
    username: `${tag}_admin`,
    email: `admin_${tag}@example.test`,
    displayName: "Org Levy Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminId = admin.id;

  const [treasurer] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-treas`,
    username: `${tag}_treas`,
    email: `treas_${tag}@example.test`,
    displayName: "Org Levy Treasurer",
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
    displayName: "Plain Player",
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
  await db.delete(notificationAuditLogTable).where(eq(notificationAuditLogTable.notificationKey, "levy.ledger.org.digest.failed"));
  await db.delete(levyLedgerEmailOrgRunsTable).where(eq(levyLedgerEmailOrgRunsTable.organizationId, orgId));
  await db.delete(levyLedgerEmailOrgSchedulesTable).where(eq(levyLedgerEmailOrgSchedulesTable.organizationId, orgId));
  await db.delete(emailSuppressionsTable).where(eq(emailSuppressionsTable.organizationId, orgId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, orgId));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [adminId, treasurerId, nonAdminId]));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  sendMock.mockClear();
  sendMock.mockImplementation(async () => {});
  await db.delete(notificationAuditLogTable).where(eq(notificationAuditLogTable.notificationKey, "levy.ledger.org.digest.failed"));
  await db.delete(levyLedgerEmailOrgRunsTable).where(eq(levyLedgerEmailOrgRunsTable.organizationId, orgId));
  await db.delete(levyLedgerEmailOrgSchedulesTable).where(eq(levyLedgerEmailOrgSchedulesTable.organizationId, orgId));
  await db.delete(emailSuppressionsTable).where(eq(emailSuppressionsTable.organizationId, orgId));

  const [s] = await db.insert(levyLedgerEmailOrgSchedulesTable).values({
    organizationId: orgId,
    frequency: "weekly",
    recipients: ["finance@example.test", "ops@example.test"],
    deliveryFormat: "combined",
    nextRunAt: new Date(),
  }).returning({ id: levyLedgerEmailOrgSchedulesTable.id });
  scheduleId = s.id;
});

describe("Task #1444 — club-wide combined levy ledger digest failure handling", () => {
  it("pauses every recipient when all are on the suppression list, skips the send, and notifies admins", async () => {
    await db.insert(emailSuppressionsTable).values([
      { organizationId: orgId, email: "finance@example.test", reason: "bounced", bounceType: "HardBounce" },
      { organizationId: orgId, email: "ops@example.test", reason: "bounced", bounceType: "BadMailbox" },
    ]);

    const result = await runOneOrgLevyLedgerEmailSchedule(scheduleId);
    expect(result.status).toBe("skipped");
    expect(result.recipients).toEqual([]);
    expect(result.pausedRecipients?.sort()).toEqual(["finance@example.test", "ops@example.test"]);
    expect(sendMock).not.toHaveBeenCalled();

    const [sched] = await db.select().from(levyLedgerEmailOrgSchedulesTable)
      .where(eq(levyLedgerEmailOrgSchedulesTable.id, scheduleId));
    expect(sched.recipients).toEqual([]);

    const runs = await db.select().from(levyLedgerEmailOrgRunsTable)
      .where(eq(levyLedgerEmailOrgRunsTable.scheduleId, scheduleId));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("skipped");
    expect(runs[0].errorMessage).toMatch(/paused all configured recipients/);

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
    sendMock.mockImplementationOnce(async () => { throw new Error("Postmark 422 InactiveRecipient"); });
    const r1 = await runOneOrgLevyLedgerEmailSchedule(scheduleId);
    expect(r1.status).toBe("failed");
    expect(r1.errorMessage).toMatch(/Postmark/);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const dispatch1 = await loadLatestDispatchPayload(adminId);
    expect(dispatch1!.consecutiveFailures).toBe(1);
    expect(dispatch1!.status).toBe("failed");

    sendMock.mockImplementationOnce(async () => { throw new Error("Postmark 422 InactiveRecipient"); });
    const r2 = await runOneOrgLevyLedgerEmailSchedule(scheduleId);
    expect(r2.status).toBe("failed");
    const dispatch2 = await loadLatestDispatchPayload(adminId);
    expect(dispatch2!.consecutiveFailures).toBe(2);
  });

  it("pauses only the bounced recipient on a partial-suppression run, sends to the survivor, and does NOT raise the failure notification", async () => {
    await db.insert(emailSuppressionsTable).values({
      organizationId: orgId, email: "ops@example.test", reason: "spam_complaint", bounceType: "SpamComplaint",
    });

    const result = await runOneOrgLevyLedgerEmailSchedule(scheduleId);
    expect(result.status).toBe("sent");
    expect(result.recipients).toEqual(["finance@example.test"]);
    expect(result.pausedRecipients).toEqual(["ops@example.test"]);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const sendArgs = sendMock.mock.calls[0]?.[0];
    expect(sendArgs?.to).toEqual(["finance@example.test"]);

    const [sched] = await db.select().from(levyLedgerEmailOrgSchedulesTable)
      .where(eq(levyLedgerEmailOrgSchedulesTable.id, scheduleId));
    expect(sched.recipients).toEqual(["finance@example.test"]);

    const runs = await db.select().from(levyLedgerEmailOrgRunsTable)
      .where(eq(levyLedgerEmailOrgRunsTable.scheduleId, scheduleId));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("sent");
    expect(runs[0].errorMessage).toMatch(/paused 1 bounced.*ops@example\.test/);

    const adminAudit = await loadAuditFor(adminId);
    expect(adminAudit).toHaveLength(0);
  });

  it("advances the cadence after auto-pausing every recipient so a second poll does not re-fire on the same period", async () => {
    await db.insert(emailSuppressionsTable).values([
      { organizationId: orgId, email: "finance@example.test", reason: "bounced" },
      { organizationId: orgId, email: "ops@example.test", reason: "bounced" },
    ]);
    const r1 = await runOneOrgLevyLedgerEmailSchedule(scheduleId);
    expect(r1.status).toBe("skipped");

    const [after1] = await db.select().from(levyLedgerEmailOrgSchedulesTable)
      .where(eq(levyLedgerEmailOrgSchedulesTable.id, scheduleId));
    expect(after1.recipients).toEqual([]);
    const firstNextRunAt = after1.nextRunAt;
    expect(firstNextRunAt).not.toBeNull();
    expect(after1.lastSentAt).not.toBeNull();

    const r2 = await runOneOrgLevyLedgerEmailSchedule(scheduleId);
    expect(r2.status).toBe("skipped");
    expect(r2.errorMessage).toMatch(/no recipients configured/);

    const [after2] = await db.select().from(levyLedgerEmailOrgSchedulesTable)
      .where(eq(levyLedgerEmailOrgSchedulesTable.id, scheduleId));
    expect(after2.nextRunAt!.getTime()).toBeGreaterThanOrEqual(firstNextRunAt!.getTime());

    const runs = await db.select().from(levyLedgerEmailOrgRunsTable)
      .where(eq(levyLedgerEmailOrgRunsTable.scheduleId, scheduleId));
    expect(runs).toHaveLength(2);
    expect(runs.every(r => r.status === "skipped")).toBe(true);

    const adminAudit = await loadAuditFor(adminId);
    expect(adminAudit.length).toBeGreaterThanOrEqual(2);
  });
});

async function loadAuditFor(userId: number) {
  return db.select().from(notificationAuditLogTable)
    .where(and(
      eq(notificationAuditLogTable.userId, userId),
      eq(notificationAuditLogTable.notificationKey, "levy.ledger.org.digest.failed"),
    ))
    .orderBy(desc(notificationAuditLogTable.createdAt));
}

async function loadDispatchPayloadsForUser(userId: number) {
  const rows = await loadAuditFor(userId);
  const BUCKET_MS = 2_000;
  const seen = new Set<number>();
  const out: Array<{ scheduleId: unknown; status: unknown; consecutiveFailures: number; pausedRecipients: unknown; errorMessage: unknown }> = [];
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
    });
  }
  return out;
}

async function loadLatestDispatchPayload(userId: number) {
  const rows = await loadDispatchPayloadsForUser(userId);
  return rows[0];
}
