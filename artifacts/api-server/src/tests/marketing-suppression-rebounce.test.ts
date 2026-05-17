/**
 * Integration tests: GET /organizations/:orgId/marketing/suppressions
 *   — Task #1548 "Re-bounced after re-enable" indicator.
 *
 * Verifies that when a recent re-enable audit row (within 14 days) exists
 * for either the bouncing address or the replacement address an admin
 * patched in, the corresponding suppression row in the API response is
 * tagged with a `recentReenable` summary so the admin UI can render the
 * "Re-bounced after re-enable" badge with hover detail.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  emailSuppressionsTable,
  memberAuditLogTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "./helpers.js";

let orgAId: number;
let orgBId: number;
let adminUserId: number;
let admin: TestUser;

const createdSuppressionIds: number[] = [];

async function makeSuppression(opts: {
  orgId: number;
  email: string;
  reason?: string;
  bounceType?: string | null;
  description?: string | null;
  createdAt?: Date;
}): Promise<number> {
  const values: Record<string, unknown> = {
    organizationId: opts.orgId,
    email: opts.email.toLowerCase(),
    reason: opts.reason ?? "bounced",
    bounceType: opts.bounceType ?? "BadMailbox",
    description: opts.description ?? "The recipient's mailbox does not exist",
  };
  if (opts.createdAt) values.createdAt = opts.createdAt;
  const [row] = await db.insert(emailSuppressionsTable).values(values as typeof emailSuppressionsTable.$inferInsert).returning({ id: emailSuppressionsTable.id });
  createdSuppressionIds.push(row.id);
  return row.id;
}

async function insertReenableAudit(opts: {
  orgId: number;
  action: "reenable" | "reenable_with_replacement";
  oldEmail: string;
  replacementEmail?: string | null;
  actorUserId?: number | null;
  actorName?: string | null;
  actorRole?: string | null;
  createdAt?: Date;
  entityId?: number | null;
}): Promise<number> {
  const [row] = await db.insert(memberAuditLogTable).values({
    organizationId: opts.orgId,
    clubMemberId: null,
    actorUserId: opts.actorUserId ?? null,
    actorName: opts.actorName ?? "Test Admin",
    actorRole: opts.actorRole ?? "org_admin",
    entity: "email_suppression",
    entityId: opts.entityId ?? null,
    action: opts.action,
    reason: `Re-enabled ${opts.oldEmail}`,
    metadata: {
      oldEmail: opts.oldEmail.toLowerCase(),
      replacementEmail: opts.replacementEmail ? opts.replacementEmail.toLowerCase() : null,
      suppressionReason: "bounced",
      bounceType: "BadMailbox",
    },
    createdAt: opts.createdAt ?? new Date(),
  }).returning({ id: memberAuditLogTable.id });
  return row.id;
}

async function clearAudits() {
  await db.delete(memberAuditLogTable).where(and(
    eq(memberAuditLogTable.entity, "email_suppression"),
    inArray(memberAuditLogTable.organizationId, [orgAId, orgBId].filter(Boolean) as number[]),
  ));
}

beforeAll(async () => {
  const stamp = uid("rebounce");
  const [orgA] = await db.insert(organizationsTable).values({
    name: `TestOrg_Rebounce_A_${stamp}`,
    slug: `test-rebounce-a-${stamp}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `TestOrg_Rebounce_B_${stamp}`,
    slug: `test-rebounce-b-${stamp}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `rebounce-admin-${stamp}`,
    username: `rebounce_admin_${stamp}`,
    email: `rebounce_admin_${stamp}@example.com`,
    displayName: "Rebounce Admin",
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  admin = {
    id: adminUserId,
    username: `rebounce_admin_${stamp}`,
    displayName: "Rebounce Admin",
    role: "org_admin",
    organizationId: orgAId,
  };
});

afterAll(async () => {
  await clearAudits();
  if (createdSuppressionIds.length) {
    await db.delete(emailSuppressionsTable).where(inArray(emailSuppressionsTable.id, createdSuppressionIds));
  }
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.userId, adminUserId));
  if (adminUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  if (orgAId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgAId));
  if (orgBId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgBId));
});

beforeEach(async () => {
  await clearAudits();
  if (createdSuppressionIds.length) {
    await db.delete(emailSuppressionsTable).where(inArray(emailSuppressionsTable.id, createdSuppressionIds));
    createdSuppressionIds.length = 0;
  }
});

const URL = (orgId: number) => `/api/organizations/${orgId}/marketing/suppressions`;

function findRow(body: unknown, id: number): Record<string, unknown> | undefined {
  if (!Array.isArray(body)) return undefined;
  return (body as Array<Record<string, unknown>>).find(r => r.id === id);
}

describe("GET /suppressions — recentReenable enrichment (Task #1548)", () => {
  it("tags a row whose email matches a recent reenable audit's oldEmail", async () => {
    const app = createTestApp(admin);
    const email = `rebounce-${uid()}@example.com`;
    const reenableAt = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    await insertReenableAudit({
      orgId: orgAId,
      action: "reenable",
      oldEmail: email,
      actorUserId: adminUserId,
      actorName: "Rebounce Admin",
      actorRole: "org_admin",
      createdAt: reenableAt,
    });
    // New bounce arrives *after* the re-enable.
    const supId = await makeSuppression({ orgId: orgAId, email, createdAt: new Date() });

    const res = await request(app).get(URL(orgAId));
    expect(res.status).toBe(200);
    const row = findRow(res.body, supId) as { recentReenable?: Record<string, unknown> | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.recentReenable).toBeTruthy();
    expect(row!.recentReenable!.action).toBe("reenable");
    expect(row!.recentReenable!.actorName).toBe("Rebounce Admin");
    expect(row!.recentReenable!.actorRole).toBe("org_admin");
    expect(row!.recentReenable!.actorUserId).toBe(adminUserId);
    expect(typeof row!.recentReenable!.at).toBe("string");
    // Within ~1 second of what we wrote.
    expect(Math.abs(new Date(row!.recentReenable!.at as string).getTime() - reenableAt.getTime())).toBeLessThan(2000);
  });

  it("tags a row whose email matches a recent reenable's replacementEmail", async () => {
    const app = createTestApp(admin);
    const oldEmail = `typo-${uid()}@exmaple.com`;
    const newEmail = `typo-${uid()}@example.com`;
    const reenableAt = new Date(Date.now() - 30 * 60 * 1000);
    await insertReenableAudit({
      orgId: orgAId,
      action: "reenable_with_replacement",
      oldEmail,
      replacementEmail: newEmail,
      createdAt: reenableAt,
    });
    // The replacement address itself bounces afterwards.
    const supId = await makeSuppression({ orgId: orgAId, email: newEmail, createdAt: new Date() });

    const res = await request(app).get(URL(orgAId));
    expect(res.status).toBe(200);
    const row = findRow(res.body, supId) as { recentReenable?: Record<string, unknown> | null } | undefined;
    expect(row?.recentReenable).toBeTruthy();
    expect(row!.recentReenable!.action).toBe("reenable_with_replacement");
    expect(row!.recentReenable!.replacementEmail).toBe(newEmail.toLowerCase());
  });

  it("does NOT tag a row when the audit is older than 14 days", async () => {
    const app = createTestApp(admin);
    const email = `stale-${uid()}@example.com`;
    const tooOld = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    await insertReenableAudit({
      orgId: orgAId,
      action: "reenable",
      oldEmail: email,
      createdAt: tooOld,
    });
    const supId = await makeSuppression({ orgId: orgAId, email });

    const res = await request(app).get(URL(orgAId));
    const row = findRow(res.body, supId) as { recentReenable?: unknown } | undefined;
    expect(row).toBeDefined();
    expect(row!.recentReenable).toBeNull();
  });

  it("does NOT tag a row when the re-enable audit happened AFTER the suppression (no rebound)", async () => {
    const app = createTestApp(admin);
    const email = `noreb-${uid()}@example.com`;
    // Suppression created an hour ago.
    const supCreatedAt = new Date(Date.now() - 60 * 60 * 1000);
    const supId = await makeSuppression({ orgId: orgAId, email, createdAt: supCreatedAt });
    // Re-enable audit logged *just now* — but the suppression we're seeing
    // is the original one (not a re-bounce). The new audit predates no
    // future bounce.
    await insertReenableAudit({
      orgId: orgAId,
      action: "reenable",
      oldEmail: email,
      createdAt: new Date(),
    });

    const res = await request(app).get(URL(orgAId));
    const row = findRow(res.body, supId) as { recentReenable?: unknown } | undefined;
    expect(row).toBeDefined();
    expect(row!.recentReenable).toBeNull();
  });

  it("does NOT tag a row when the audit belongs to a different org", async () => {
    const app = createTestApp(admin);
    const email = `crossorg-${uid()}@example.com`;
    await insertReenableAudit({
      orgId: orgBId, // different org
      action: "reenable",
      oldEmail: email,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const supId = await makeSuppression({ orgId: orgAId, email });

    const res = await request(app).get(URL(orgAId));
    const row = findRow(res.body, supId) as { recentReenable?: unknown } | undefined;
    expect(row?.recentReenable).toBeNull();
  });

  it("returns the most recent re-enable when multiple exist for the same address", async () => {
    const app = createTestApp(admin);
    const email = `multi-${uid()}@example.com`;
    await insertReenableAudit({
      orgId: orgAId,
      action: "reenable",
      oldEmail: email,
      actorName: "Older Admin",
      createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    });
    const newerAt = new Date(Date.now() - 60 * 60 * 1000);
    await insertReenableAudit({
      orgId: orgAId,
      action: "reenable_with_replacement",
      oldEmail: email,
      replacementEmail: email, // same address re-tried (edge case: still flag)
      actorName: "Newer Admin",
      createdAt: newerAt,
    });
    const supId = await makeSuppression({ orgId: orgAId, email });

    const res = await request(app).get(URL(orgAId));
    const row = findRow(res.body, supId) as { recentReenable?: Record<string, unknown> | null } | undefined;
    expect(row?.recentReenable).toBeTruthy();
    expect(row!.recentReenable!.actorName).toBe("Newer Admin");
    expect(Math.abs(new Date(row!.recentReenable!.at as string).getTime() - newerAt.getTime())).toBeLessThan(2000);
  });

  it("leaves recentReenable null on a fresh suppression with no prior re-enable history", async () => {
    const app = createTestApp(admin);
    const email = `clean-${uid()}@example.com`;
    const supId = await makeSuppression({ orgId: orgAId, email });

    const res = await request(app).get(URL(orgAId));
    const row = findRow(res.body, supId) as { recentReenable?: unknown } | undefined;
    expect(row?.recentReenable).toBeNull();
  });
});
