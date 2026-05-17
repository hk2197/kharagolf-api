/**
 * Task #835 — Plan-migration audit super-admin digest.
 *
 * Verifies that:
 *   - The digest is a no-op when there are no unacknowledged migration audit rows.
 *   - The digest emails every super_admin with an email address when ≥1 row exists.
 *   - The 23h dedup prevents back-to-back sends.
 *   - Task #1551 — the dedup floor is persisted on audit row metadata, so a
 *     simulated process restart does NOT re-send a daily digest within 23h.
 *   - Acknowledged rows do not trigger the digest.
 *   - Rows from a different `entity` / `action` are ignored.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => {
  return {
    sendPlanMigrationDigestEmail: vi.fn(async () => undefined),
  };
});

vi.mock("../lib/comms.js", () => ({
  sendTransactionalPush: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 })),
}));

import { db } from "@workspace/db";
import {
  organizationsTable,
  memberAuditLogTable,
  appUsersTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  sendPlanMigrationDigestToSuperAdmins,
  notifySuperAdminsOfPlanMigration,
  _resetPlanMigrationDigestDedupForTest,
} from "../lib/planMigrationDigest.js";
import { sendPlanMigrationDigestEmail } from "../lib/mailer.js";
import { sendTransactionalPush } from "../lib/comms.js";
import { uid } from "./helpers.js";

const emailMock = vi.mocked(sendPlanMigrationDigestEmail);
const pushMock = vi.mocked(sendTransactionalPush);

let orgId: number;
const createdOrgIds: number[] = [];
const createdAuditIds: number[] = [];
const createdUserIds: number[] = [];

async function makeAuditRow(metadata: Record<string, unknown> | null = null) {
  const [row] = await db.insert(memberAuditLogTable).values({
    organizationId: orgId,
    entity: "organization_subscription_tier",
    entityId: orgId,
    action: "migrate",
    fieldChanges: { tier: { from: "legacy_x", to: "free" } },
    reason: "Task #835 test row",
    ...(metadata ? { metadata } : {}),
  }).returning({ id: memberAuditLogTable.id });
  createdAuditIds.push(row.id);
  return row.id;
}

beforeAll(async () => {
  const slug = uid("plan-migration-digest");
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg ${slug}`, slug,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;
  createdOrgIds.push(orgId);

  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `repl_${slug}_a`,
    username: `su_${slug}_a`,
    email: `su_a_${slug}@example.com`,
    displayName: "Super A",
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u1.id);

  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `repl_${slug}_b`,
    username: `su_${slug}_b`,
    email: `su_b_${slug}@example.com`,
    displayName: "Super B",
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u2.id);

  // Super admin without an email — should be skipped.
  const [u3] = await db.insert(appUsersTable).values({
    replitUserId: `repl_${slug}_c`,
    username: `su_${slug}_c`,
    displayName: "Super C",
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u3.id);
});

afterAll(async () => {
  if (createdAuditIds.length > 0) {
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.id, createdAuditIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length > 0) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

beforeEach(async () => {
  emailMock.mockClear();
  pushMock.mockClear();
  await _resetPlanMigrationDigestDedupForTest();
});

describe("sendPlanMigrationDigestToSuperAdmins", () => {
  it("is a no-op when there are no unacknowledged rows", async () => {
    const result = await sendPlanMigrationDigestToSuperAdmins();
    expect(result.totalUnacknowledged).toBe(0);
    expect(result.skipped).toBe("no-rows");
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("ignores acknowledged rows", async () => {
    await makeAuditRow({ acknowledged: true, acknowledgedAt: new Date().toISOString() });
    const result = await sendPlanMigrationDigestToSuperAdmins();
    expect(result.totalUnacknowledged).toBe(0);
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("emails every super_admin with an email when an unack row exists", async () => {
    await makeAuditRow();

    const result = await sendPlanMigrationDigestToSuperAdmins();
    expect(result.totalUnacknowledged).toBeGreaterThanOrEqual(1);
    expect(result.recipientsAttempted).toBe(2); // only the two with email
    expect(result.recipientsEmailed).toBe(2);
    expect(emailMock).toHaveBeenCalledTimes(2);

    const recipients = emailMock.mock.calls.map(c => (c[0] as { to: string }).to).sort();
    expect(recipients[0]).toContain("su_a_");
    expect(recipients[1]).toContain("su_b_");

    const firstCall = emailMock.mock.calls[0][0] as {
      totalUnacknowledged: number;
      rows: Array<{ orgName: string | null; toTier: string | null }>;
    };
    expect(firstCall.totalUnacknowledged).toBeGreaterThanOrEqual(1);
    expect(firstCall.rows.length).toBeGreaterThanOrEqual(1);
    expect(firstCall.rows[0].toTier).toBe("free");
  });

  it("includes a 'recently acknowledged' summary so the inbox reflects prior clicks (Task #1145)", async () => {
    // One row that was acknowledged 5 minutes ago (i.e. within the previous
    // digest window) and one still-unack row that should drive the dispatch.
    const ackAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await makeAuditRow({ acknowledged: true, acknowledgedAt: ackAt });
    await makeAuditRow();

    const result = await sendPlanMigrationDigestToSuperAdmins();
    expect(result.recipientsEmailed).toBe(2);

    const call = emailMock.mock.calls[0][0] as {
      recentlyAcknowledged?: { count: number; lastAcknowledgedAt: string | null };
    };
    expect(call.recentlyAcknowledged).toBeDefined();
    expect(call.recentlyAcknowledged!.count).toBeGreaterThanOrEqual(1);
    expect(call.recentlyAcknowledged!.lastAcknowledgedAt).toBeTruthy();
    // Should be a valid ISO timestamp >= the row we just acknowledged.
    const lastAt = new Date(call.recentlyAcknowledged!.lastAcknowledgedAt!).getTime();
    expect(lastAt).toBeGreaterThanOrEqual(new Date(ackAt).getTime());
  });

  it("dedupes back-to-back invocations within the 23h window", async () => {
    await makeAuditRow();

    const first = await sendPlanMigrationDigestToSuperAdmins();
    expect(first.recipientsEmailed).toBe(2);
    emailMock.mockClear();

    const second = await sendPlanMigrationDigestToSuperAdmins();
    expect(second.skipped).toBe("deduped");
    expect(second.recipientsEmailed).toBe(0);
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("Task #1551 — persists the dedup floor so a process restart does NOT re-send within 23h", async () => {
    const auditId = await makeAuditRow();

    const first = await sendPlanMigrationDigestToSuperAdmins();
    expect(first.recipientsEmailed).toBe(2);

    // The dispatched row must carry a `lastDigestedAt` stamp on its
    // metadata — that's the persisted dedup clock that survives restarts.
    const [persisted] = await db
      .select({ metadata: memberAuditLogTable.metadata })
      .from(memberAuditLogTable)
      .where(eq(memberAuditLogTable.id, auditId));
    const meta = persisted?.metadata as { lastDigestedAt?: string } | null;
    expect(meta?.lastDigestedAt).toBeTruthy();
    const stampedAtMs = Date.parse(meta!.lastDigestedAt!);
    expect(Number.isFinite(stampedAtMs)).toBe(true);

    // Simulate a process restart: a fresh boot has no in-memory state, but
    // the persisted dedup floor on the audit row should keep the next cron
    // tick from re-sending. (Pre-Task #1551 behaviour: this would re-send.)
    emailMock.mockClear();
    const second = await sendPlanMigrationDigestToSuperAdmins();
    expect(second.skipped).toBe("deduped");
    expect(second.recipientsEmailed).toBe(0);
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("Task #1551 — dedup floor survives even when newly-arrived rows are unstamped", async () => {
    // First batch establishes the persisted floor by stamping `lastDigestedAt`.
    await makeAuditRow();
    const first = await sendPlanMigrationDigestToSuperAdmins();
    expect(first.recipientsEmailed).toBe(2);

    // A brand-new unack row arrives an hour later (no stamp yet). The
    // dedup query reads MAX(lastDigestedAt) across ALL plan-migration rows,
    // so the previously-stamped row continues to anchor the 23h floor.
    await makeAuditRow();
    emailMock.mockClear();

    const second = await sendPlanMigrationDigestToSuperAdmins();
    expect(second.skipped).toBe("deduped");
    expect(second.recipientsEmailed).toBe(0);
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("stamps firstDigestedAt on first dispatch and reuses it on subsequent dispatches (Task #1313)", async () => {
    const auditId = await makeAuditRow();

    // First dispatch — no prior firstDigestedAt, so it should get stamped.
    const tBefore = new Date().toISOString();
    const first = await sendPlanMigrationDigestToSuperAdmins();
    expect(first.recipientsEmailed).toBe(2);
    const tAfter = new Date().toISOString();

    // The email payload should carry firstDigestedAt for this row, and it
    // should equal what we just persisted to the DB.
    const firstCall = emailMock.mock.calls[0][0] as {
      rows: Array<{ id: number; firstDigestedAt?: string | null }>;
    };
    const emailedRow = firstCall.rows.find((r) => r.id === auditId);
    expect(emailedRow).toBeDefined();
    expect(emailedRow!.firstDigestedAt).toBeTruthy();
    const stampedAt = emailedRow!.firstDigestedAt!;
    expect(stampedAt >= tBefore && stampedAt <= tAfter).toBe(true);

    // Persisted to DB so it survives process restarts.
    const [persisted] = await db
      .select({ metadata: memberAuditLogTable.metadata })
      .from(memberAuditLogTable)
      .where(eq(memberAuditLogTable.id, auditId));
    expect(persisted).toBeDefined();
    expect((persisted.metadata as { firstDigestedAt?: string } | null)?.firstDigestedAt).toBe(stampedAt);

    // Second dispatch (after clearing the persisted Task #1551 dedup floor
    // so we can re-send) must NOT advance the firstDigestedAt stamp — it
    // is monotonic so the "first surfaced" line stays accurate.
    await _resetPlanMigrationDigestDedupForTest();
    emailMock.mockClear();
    const second = await sendPlanMigrationDigestToSuperAdmins();
    expect(second.recipientsEmailed).toBe(2);
    const secondCall = emailMock.mock.calls[0][0] as {
      rows: Array<{ id: number; firstDigestedAt?: string | null }>;
    };
    const emailedAgain = secondCall.rows.find((r) => r.id === auditId);
    expect(emailedAgain!.firstDigestedAt).toBe(stampedAt);
  });
});

describe("notifySuperAdminsOfPlanMigration (Task #979)", () => {
  it("writes the audit row, emails super admins, and pushes — all immediately", async () => {
    pushMock.mockResolvedValueOnce({ attempted: 3, sent: 2, failed: 0, invalid: 1 });

    const result = await notifySuperAdminsOfPlanMigration({
      organizationId: orgId,
      fromTier: "legacy_x",
      toTier: "free",
      reason: "Stripe webhook saw unknown tier",
      triggerReason: "unknown_tier",
    });

    expect(result.auditRecorded).toBe(true);
    expect(result.totalUnacknowledged).toBeGreaterThanOrEqual(1);
    // Two of the three super admins have an email address.
    expect(result.recipientsAttempted).toBe(2);
    expect(result.recipientsEmailed).toBe(2);
    expect(emailMock).toHaveBeenCalledTimes(2);
    expect(result.pushAttempted).toBe(3);
    expect(result.pushSent).toBe(2);

    // Push payload should include the org id + tier transition for deep-link routing.
    expect(pushMock).toHaveBeenCalledTimes(1);
    const [userIds, title, body, data] = pushMock.mock.calls[0];
    expect(Array.isArray(userIds)).toBe(true);
    expect((userIds as number[]).length).toBe(3);
    expect(title).toMatch(/auto-reset/i);
    expect(body).toContain("legacy_x");
    expect(body).toContain("free");
    expect(data).toMatchObject({
      type: "plan_migration_audit",
      organizationId: orgId,
      fromTier: "legacy_x",
      toTier: "free",
    });

    // The audit row should now be queryable via the digest predicate.
    const persisted = await db
      .select({ id: memberAuditLogTable.id })
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, orgId),
        eq(memberAuditLogTable.entity, "organization_subscription_tier"),
        eq(memberAuditLogTable.action, "migrate"),
      ));
    expect(persisted.length).toBeGreaterThanOrEqual(1);
    for (const r of persisted) createdAuditIds.push(r.id);
  });

  it("stamps the dedup so the next cron tick skips the daily digest", async () => {
    await notifySuperAdminsOfPlanMigration({
      organizationId: orgId,
      fromTier: "legacy_y",
      toTier: "free",
      triggerReason: "unknown_tier",
    });
    emailMock.mockClear();

    const cronResult = await sendPlanMigrationDigestToSuperAdmins();
    expect(cronResult.skipped).toBe("deduped");
    expect(emailMock).not.toHaveBeenCalled();

    // Track whatever rows the helper inserted for cleanup.
    const persisted = await db
      .select({ id: memberAuditLogTable.id })
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, orgId),
        eq(memberAuditLogTable.entity, "organization_subscription_tier"),
        eq(memberAuditLogTable.action, "migrate"),
      ));
    for (const r of persisted) createdAuditIds.push(r.id);
  });
});
