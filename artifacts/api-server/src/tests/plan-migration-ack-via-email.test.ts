/**
 * Task #980 — One-click "Acknowledge" link in the plan-migration digest email.
 *
 * Verifies the GET /api/super-admin/plan-migration-audit/:id/acknowledge-via-email
 * endpoint:
 *   - Stamps the audit metadata with acknowledged=true and the recipient's userId.
 *   - Rejects an unsigned / tampered token.
 *   - Rejects a token whose auditId does not match the path :id (no row swap).
 *   - Is single-use: a second click does not change the recorded acknowledger.
 *   - Refuses tokens issued for a user who is no longer a super_admin.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  memberAuditLogTable,
  appUsersTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, uid } from "./helpers.js";
import { issuePlanMigrationAckToken } from "../lib/plan-migration-ack-token.js";

let orgId: number;
let superAdminId: number;
let formerSuperAdminId: number;
const createdOrgIds: number[] = [];
const createdAuditIds: number[] = [];
const createdUserIds: number[] = [];

async function makeAuditRow() {
  const [row] = await db.insert(memberAuditLogTable).values({
    organizationId: orgId,
    entity: "organization_subscription_tier",
    entityId: orgId,
    action: "migrate",
    fieldChanges: { tier: { from: "legacy_x", to: "free" } },
    reason: "Task #980 test row",
  }).returning({ id: memberAuditLogTable.id });
  createdAuditIds.push(row.id);
  return row.id;
}

async function readMeta(auditId: number): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ metadata: memberAuditLogTable.metadata })
    .from(memberAuditLogTable)
    .where(eq(memberAuditLogTable.id, auditId));
  return (row?.metadata ?? {}) as Record<string, unknown>;
}

beforeAll(async () => {
  const slug = uid("plan-migration-ack-email");
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg ${slug}`, slug,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;
  createdOrgIds.push(orgId);

  // No email on these users so the parallel `plan-migration-digest.test.ts`
  // suite (which counts super_admins with email) is not perturbed by us.
  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `repl_${slug}_su`,
    username: `su_${slug}`,
    displayName: "Super Triager",
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  superAdminId = u1.id;
  createdUserIds.push(superAdminId);

  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `repl_${slug}_former`,
    username: `former_${slug}`,
    displayName: "Former Super",
    role: "org_admin",
  }).returning({ id: appUsersTable.id });
  formerSuperAdminId = u2.id;
  createdUserIds.push(formerSuperAdminId);
});

afterEach(async () => {
  // Clean up audit rows after each test so the parallel
  // `plan-migration-digest.test.ts` suite doesn't see our unack rows in its
  // global counts.
  if (createdAuditIds.length > 0) {
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.id, createdAuditIds));
    createdAuditIds.length = 0;
  }
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

describe("GET /api/super-admin/plan-migration-audit/:id/acknowledge-via-email", () => {
  it("acknowledges the row when called with a valid signed token", async () => {
    const auditId = await makeAuditRow();
    const token = issuePlanMigrationAckToken({ auditId, userId: superAdminId });
    const app = createTestApp(); // unauthenticated request — token-gated

    const res = await request(app)
      .get(`/api/super-admin/plan-migration-audit/${auditId}/acknowledge-via-email`)
      .query({ token });

    expect(res.status).toBe(200);
    expect(res.text).toContain("Acknowledged");

    const meta = await readMeta(auditId);
    expect(meta.acknowledged).toBe(true);
    expect(meta.acknowledgedByUserId).toBe(superAdminId);
    expect(meta.acknowledgedVia).toBe("email");
    expect(typeof meta.acknowledgedAt).toBe("string");
  });

  it("rejects an unsigned / tampered token", async () => {
    const auditId = await makeAuditRow();
    const app = createTestApp();

    const res = await request(app)
      .get(`/api/super-admin/plan-migration-audit/${auditId}/acknowledge-via-email`)
      .query({ token: "not-a-real-token.deadbeef" });

    expect(res.status).toBe(401);
    const meta = await readMeta(auditId);
    expect(meta.acknowledged).toBeUndefined();
  });

  it("rejects a token whose auditId does not match the URL :id", async () => {
    const auditId = await makeAuditRow();
    const otherAuditId = await makeAuditRow();
    // Token says auditId=otherAuditId, but URL targets auditId. Should refuse.
    const token = issuePlanMigrationAckToken({ auditId: otherAuditId, userId: superAdminId });
    const app = createTestApp();

    const res = await request(app)
      .get(`/api/super-admin/plan-migration-audit/${auditId}/acknowledge-via-email`)
      .query({ token });

    expect(res.status).toBe(401);
    expect((await readMeta(auditId)).acknowledged).toBeUndefined();
    expect((await readMeta(otherAuditId)).acknowledged).toBeUndefined();
  });

  it("is single-use — re-clicking does not change the original acknowledger", async () => {
    const auditId = await makeAuditRow();
    const firstToken = issuePlanMigrationAckToken({ auditId, userId: superAdminId });
    const app = createTestApp();

    const r1 = await request(app)
      .get(`/api/super-admin/plan-migration-audit/${auditId}/acknowledge-via-email`)
      .query({ token: firstToken });
    expect(r1.status).toBe(200);
    const metaFirst = await readMeta(auditId);
    expect(metaFirst.acknowledgedByUserId).toBe(superAdminId);
    const firstAt = metaFirst.acknowledgedAt;

    // A second token issued for a different super admin must not be able to
    // overwrite the original ack stamp once the row has been acknowledged.
    const otherSlug = uid("plan-migration-ack-other");
    const [otherSu] = await db.insert(appUsersTable).values({
      replitUserId: `repl_${otherSlug}`,
      username: `su_${otherSlug}`,
      role: "super_admin",
    }).returning({ id: appUsersTable.id });
    createdUserIds.push(otherSu.id);

    const secondToken = issuePlanMigrationAckToken({ auditId, userId: otherSu.id });
    const r2 = await request(app)
      .get(`/api/super-admin/plan-migration-audit/${auditId}/acknowledge-via-email`)
      .query({ token: secondToken });
    expect(r2.status).toBe(200);
    expect(r2.text).toContain("Already acknowledged");

    const metaSecond = await readMeta(auditId);
    expect(metaSecond.acknowledgedByUserId).toBe(superAdminId);
    expect(metaSecond.acknowledgedAt).toBe(firstAt);
  });

  it("rejects a token whose user is no longer a super_admin", async () => {
    const auditId = await makeAuditRow();
    const token = issuePlanMigrationAckToken({ auditId, userId: formerSuperAdminId });
    const app = createTestApp();

    const res = await request(app)
      .get(`/api/super-admin/plan-migration-audit/${auditId}/acknowledge-via-email`)
      .query({ token });

    expect(res.status).toBe(403);
    expect((await readMeta(auditId)).acknowledged).toBeUndefined();
  });
});
