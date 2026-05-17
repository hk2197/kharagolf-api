/**
 * Task #1308 — Apply the same realtime alert when admins re-migrate plans by hand.
 *
 * Covers `POST /api/super-admin/clubs/:orgId/re-migrate`, the admin-facing
 * tier-reset endpoint that mirrors the legacy SQL migration (Task #514) and
 * the Stripe-webhook auto-downgrade (Task #1133): it persists the tier
 * change AND routes through `notifySuperAdminsOfPlanMigration()` so super
 * admins get the realtime email + push immediately instead of waiting for
 * the hourly digest cron tick.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => ({
  sendPlanMigrationDigestEmail: vi.fn(async () => undefined),
}));

vi.mock("../lib/comms.js", () => ({
  sendTransactionalPush: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 })),
}));

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  memberAuditLogTable,
  appUsersTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { createTestApp, uid } from "./helpers.js";
import { sendPlanMigrationDigestEmail } from "../lib/mailer.js";
import { sendTransactionalPush } from "../lib/comms.js";
import { _resetPlanMigrationDigestDedupForTest } from "../lib/planMigrationDigest.js";

const emailMock = vi.mocked(sendPlanMigrationDigestEmail);
const pushMock = vi.mocked(sendTransactionalPush);

let orgId: number;
let superAdminUserId: number;
const createdOrgIds: number[] = [];
const createdAuditIds: number[] = [];
const createdUserIds: number[] = [];

beforeAll(async () => {
  const slug = uid("plan-remigrate");
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg ${slug}`,
    slug,
    subscriptionTier: "pro",
    subscriptionStatus: "active",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;
  createdOrgIds.push(orgId);

  // A super admin with an email so the realtime fan-out reaches at least
  // one recipient — proves the helper was actually invoked end-to-end.
  const [su] = await db.insert(appUsersTable).values({
    replitUserId: `repl_${slug}`,
    username: `su_${slug}`,
    email: `su_${slug}@example.com`,
    displayName: "Super Admin Re-migrate",
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  superAdminUserId = su.id;
  createdUserIds.push(superAdminUserId);
});

afterAll(async () => {
  if (createdAuditIds.length > 0) {
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.id, createdAuditIds));
  }
  // Also sweep any audit rows the route inserted via the helper, since
  // each test case can add one.
  const orphanAudit = await db
    .select({ id: memberAuditLogTable.id })
    .from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.organizationId, orgId),
      eq(memberAuditLogTable.entity, "organization_subscription_tier"),
      eq(memberAuditLogTable.action, "migrate"),
    ));
  if (orphanAudit.length > 0) {
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.id, orphanAudit.map(r => r.id)));
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
  // Reset the persisted dedup so each test sees a clean realtime fan-out.
  await _resetPlanMigrationDigestDedupForTest();
  // Reset org back to the canonical "pro / active" baseline so each test
  // observes a deterministic `fromTier` transition.
  await db
    .update(organizationsTable)
    .set({ subscriptionTier: "pro", subscriptionStatus: "active", updatedAt: new Date() })
    .where(eq(organizationsTable.id, orgId));
  // Clear any audit rows left over from previous test cases so the post-call
  // assertions only see the row this test triggered.
  const prior = await db
    .select({ id: memberAuditLogTable.id })
    .from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.organizationId, orgId),
      eq(memberAuditLogTable.entity, "organization_subscription_tier"),
      eq(memberAuditLogTable.action, "migrate"),
    ));
  if (prior.length > 0) {
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.id, prior.map(r => r.id)));
  }
});

describe("POST /api/super-admin/clubs/:orgId/re-migrate", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app)
      .post(`/api/super-admin/clubs/${orgId}/re-migrate`)
      .send({ targetTier: "free" });
    expect(res.status).toBe(401);
    expect(emailMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is not a super_admin", async () => {
    const app = createTestApp({ id: 1, username: "u", role: "org_admin", organizationId: orgId });
    const res = await request(app)
      .post(`/api/super-admin/clubs/${orgId}/re-migrate`)
      .send({ targetTier: "free" });
    expect(res.status).toBe(403);
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("returns 400 when targetTier is missing or invalid", async () => {
    const app = createTestApp({ id: superAdminUserId, username: "su", role: "super_admin" });
    const missing = await request(app)
      .post(`/api/super-admin/clubs/${orgId}/re-migrate`)
      .send({});
    expect(missing.status).toBe(400);

    const bogus = await request(app)
      .post(`/api/super-admin/clubs/${orgId}/re-migrate`)
      .send({ targetTier: "platinum" });
    expect(bogus.status).toBe(400);

    expect(emailMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the club does not exist", async () => {
    const app = createTestApp({ id: superAdminUserId, username: "su", role: "super_admin" });
    const res = await request(app)
      .post("/api/super-admin/clubs/999999999/re-migrate")
      .send({ targetTier: "free" });
    expect(res.status).toBe(404);
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("persists the tier change, writes the audit row via the helper, and fires the realtime email + push", async () => {
    pushMock.mockResolvedValueOnce({ attempted: 1, sent: 1, failed: 0, invalid: 0 });

    const app = createTestApp({ id: superAdminUserId, username: "su", role: "super_admin" });
    const res = await request(app)
      .post(`/api/super-admin/clubs/${orgId}/re-migrate`)
      .send({ targetTier: "free", reason: "Suspected billing drift — manual reset" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.fromTier).toBe("pro");
    expect(res.body.toTier).toBe("free");
    expect(res.body.auditRecorded).toBe(true);
    expect(res.body.recipientsEmailed).toBeGreaterThanOrEqual(1);
    expect(res.body.pushAttempted).toBe(1);
    expect(res.body.pushSent).toBe(1);

    // Tier change persisted.
    const [orgAfter] = await db
      .select({
        subscriptionTier: organizationsTable.subscriptionTier,
        subscriptionStatus: organizationsTable.subscriptionStatus,
      })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(orgAfter.subscriptionTier).toBe("free");
    expect(orgAfter.subscriptionStatus).toBe("free");

    // Audit row written via the helper — same shape as the legacy SQL
    // migration & Stripe webhook so it shows up in the Plan Migration
    // Audit panel and the digest cron.
    const auditRows = await db
      .select({
        id: memberAuditLogTable.id,
        fieldChanges: memberAuditLogTable.fieldChanges,
        reason: memberAuditLogTable.reason,
      })
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, orgId),
        eq(memberAuditLogTable.entity, "organization_subscription_tier"),
        eq(memberAuditLogTable.action, "migrate"),
      ));
    expect(auditRows.length).toBe(1);
    const tier = (auditRows[0].fieldChanges as { tier?: { from?: unknown; to?: unknown } } | null)?.tier;
    expect(tier?.from).toBe("pro");
    expect(tier?.to).toBe("free");
    expect(auditRows[0].reason).toBe("Suspected billing drift — manual reset");

    // Realtime fan-out fired immediately (proves we routed through the
    // helper, not a direct audit-row write).
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    const [pushedUserIds, pushTitle, pushBody, pushData] = pushMock.mock.calls[0];
    expect(Array.isArray(pushedUserIds)).toBe(true);
    expect((pushedUserIds as number[]).includes(superAdminUserId)).toBe(true);
    // Task #1906 — admin-triggered re-migrations now use the "manual"
    // trigger so the push title reads "Club plan re-migrated by super
    // admin" rather than the legacy "Club auto-reset to Free", letting
    // super admins distinguish manual ops from genuine churn or a
    // slug-mapping bug at lock-screen glance.
    expect(String(pushTitle)).toMatch(/re-migrated/i);
    expect(String(pushBody)).toContain("free");
    expect(pushData).toMatchObject({
      type: "plan_migration_audit",
      organizationId: orgId,
      fromTier: "pro",
      toTier: "free",
      triggerReason: "manual",
    });
  });

  it("falls back to a default reason when none is supplied", async () => {
    const app = createTestApp({ id: superAdminUserId, username: "su", role: "super_admin" });
    const res = await request(app)
      .post(`/api/super-admin/clubs/${orgId}/re-migrate`)
      .send({ targetTier: "starter" });

    expect(res.status).toBe(200);

    const [auditRow] = await db
      .select({ reason: memberAuditLogTable.reason })
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, orgId),
        eq(memberAuditLogTable.entity, "organization_subscription_tier"),
        eq(memberAuditLogTable.action, "migrate"),
      ));
    expect(auditRow.reason).toBe("Manual plan re-migration by super admin");

    // Re-migrating to a paid tier should leave subscriptionStatus = active.
    const [orgAfter] = await db
      .select({ subscriptionStatus: organizationsTable.subscriptionStatus })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(orgAfter.subscriptionStatus).toBe("active");
  });
});
