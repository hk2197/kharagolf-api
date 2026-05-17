/**
 * Integration test: GET /:memberId/audit-log — Task #1928
 *
 * The Marketing → Suppressions list already surfaces a "Re-bounced after
 * re-enable" badge (Task #1548). This test guards the same enrichment
 * being mirrored onto the per-member audit timeline so admins reviewing
 * a single member can see, inline next to the original re-enable row,
 * whether the recovery actually stuck.
 *
 * Covers:
 *   - reenable_with_replacement audit row whose replacement address has
 *     since bounced → row is annotated with `subsequentBounce` carrying
 *     the new bounce's reason + bounceType + timestamp.
 *   - plain reenable audit row whose original address has since bounced
 *     → annotated identically.
 *   - re-enable rows with no follow-up bounce → `subsequentBounce: null`.
 *   - bounce that PRE-DATES the re-enable (the original suppression that
 *     was just re-enabled) does not get treated as a re-bounce.
 *   - non-bounce-class suppressions (unsubscribed) for the same address
 *     do NOT trigger the badge.
 *   - enrichment is org-scoped: a same-address bounce in another org
 *     does not bleed into this org's audit timeline.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberAuditLogTable,
  emailSuppressionsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "./helpers.js";

let orgId: number;
let otherOrgId: number;
let adminUserId: number;
let memberId: number;
let admin: TestUser;

const auditIds: number[] = [];
const suppressionIds: number[] = [];

const URL = () =>
  `/api/organizations/${orgId}/members-360/${memberId}/audit-log`;

async function insertReenableAudit(opts: {
  action: "reenable" | "reenable_with_replacement";
  oldEmail: string;
  replacementEmail?: string | null;
  createdAt?: Date;
  orgIdOverride?: number;
}): Promise<number> {
  const [row] = await db.insert(memberAuditLogTable).values({
    organizationId: opts.orgIdOverride ?? orgId,
    clubMemberId: memberId,
    actorUserId: adminUserId,
    actorName: "Audit Rebounce Admin",
    actorRole: "org_admin",
    entity: "email_suppression",
    entityId: null,
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
  auditIds.push(row.id);
  return row.id;
}

async function insertSuppression(opts: {
  email: string;
  reason?: string;
  bounceType?: string | null;
  description?: string | null;
  createdAt?: Date;
  orgIdOverride?: number;
}): Promise<number> {
  const values: Record<string, unknown> = {
    organizationId: opts.orgIdOverride ?? orgId,
    email: opts.email.toLowerCase(),
    reason: opts.reason ?? "bounced",
    bounceType: opts.bounceType ?? "BadMailbox",
    description: opts.description ?? "The recipient's mailbox does not exist",
  };
  if (opts.createdAt) values.createdAt = opts.createdAt;
  const [row] = await db.insert(emailSuppressionsTable)
    .values(values as typeof emailSuppressionsTable.$inferInsert)
    .returning({ id: emailSuppressionsTable.id });
  suppressionIds.push(row.id);
  return row.id;
}

async function clearScratch() {
  if (auditIds.length) {
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.id, auditIds));
    auditIds.length = 0;
  }
  if (suppressionIds.length) {
    await db.delete(emailSuppressionsTable).where(inArray(emailSuppressionsTable.id, suppressionIds));
    suppressionIds.length = 0;
  }
}

beforeAll(async () => {
  const stamp = uid("audit-rebounce");
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_AuditRebounce_${stamp}`,
    slug: `test-audit-rebounce-${stamp}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [otherOrg] = await db.insert(organizationsTable).values({
    name: `TestOrg_AuditRebounce_Other_${stamp}`,
    slug: `test-audit-rebounce-other-${stamp}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  otherOrgId = otherOrg.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `audit-rebounce-admin-${stamp}`,
    username: `audit_rebounce_admin_${stamp}`,
    email: `audit_rebounce_admin_${stamp}@example.com`,
    displayName: "Audit Rebounce Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    firstName: "Rebounce",
    lastName: "Member",
    email: `rebounce_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  memberId = m.id;

  admin = {
    id: adminUserId,
    username: `audit_rebounce_admin_${stamp}`,
    displayName: "Audit Rebounce Admin",
    role: "org_admin",
    organizationId: orgId,
  };
});

afterAll(async () => {
  await clearScratch();
  if (memberId) {
    await db.delete(memberAuditLogTable).where(and(
      eq(memberAuditLogTable.organizationId, orgId),
      eq(memberAuditLogTable.clubMemberId, memberId),
    ));
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, memberId));
  }
  if (adminUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (otherOrgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrgId));
});

beforeEach(async () => {
  await clearScratch();
});

interface ReturnedRow {
  id: number;
  entity: string;
  action: string;
  subsequentBounce: {
    email: string;
    at: string;
    reason: string;
    bounceType: string | null;
    description: string | null;
  } | null;
}

function findById(body: unknown, id: number): ReturnedRow | undefined {
  return Array.isArray(body) ? (body as ReturnedRow[]).find(r => r.id === id) : undefined;
}

describe("GET /:memberId/audit-log — subsequentBounce enrichment (Task #1928)", () => {
  it("annotates a reenable_with_replacement row when the replacement address bounced afterwards", async () => {
    const app = createTestApp(admin);
    const oldEmail = `typo-${uid()}@exmaple.com`;
    const newEmail = `typo-${uid()}@example.com`;
    const reenableAt = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const auditId = await insertReenableAudit({
      action: "reenable_with_replacement",
      oldEmail, replacementEmail: newEmail, createdAt: reenableAt,
    });
    const bounceAt = new Date(Date.now() - 30 * 60 * 1000);
    await insertSuppression({
      email: newEmail, reason: "bounced", bounceType: "HardBounce",
      description: "Mailbox is full", createdAt: bounceAt,
    });

    const res = await request(app).get(URL());
    expect(res.status).toBe(200);
    const row = findById(res.body, auditId);
    expect(row).toBeDefined();
    expect(row!.subsequentBounce).toBeTruthy();
    expect(row!.subsequentBounce!.email).toBe(newEmail.toLowerCase());
    expect(row!.subsequentBounce!.bounceType).toBe("HardBounce");
    expect(row!.subsequentBounce!.reason).toBe("bounced");
    expect(row!.subsequentBounce!.description).toBe("Mailbox is full");
    expect(Math.abs(new Date(row!.subsequentBounce!.at).getTime() - bounceAt.getTime())).toBeLessThan(2000);
  });

  it("annotates a plain reenable row when the same address bounced afterwards", async () => {
    const app = createTestApp(admin);
    const email = `again-${uid()}@example.com`;
    const reenableAt = new Date(Date.now() - 4 * 60 * 60 * 1000);
    const auditId = await insertReenableAudit({
      action: "reenable", oldEmail: email, createdAt: reenableAt,
    });
    await insertSuppression({
      email, bounceType: "BadMailbox", createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const res = await request(app).get(URL());
    const row = findById(res.body, auditId);
    expect(row?.subsequentBounce).toBeTruthy();
    expect(row!.subsequentBounce!.email).toBe(email.toLowerCase());
    expect(row!.subsequentBounce!.bounceType).toBe("BadMailbox");
  });

  it("leaves subsequentBounce null when the only matching suppression PRE-DATES the re-enable", async () => {
    const app = createTestApp(admin);
    const email = `predate-${uid()}@example.com`;
    // The original bounce was, of course, before the re-enable; that's
    // the very row the admin re-enabled. It must not light up the badge.
    await insertSuppression({
      email, createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    });
    const auditId = await insertReenableAudit({
      action: "reenable", oldEmail: email,
      createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    });

    const res = await request(app).get(URL());
    const row = findById(res.body, auditId);
    expect(row?.subsequentBounce).toBeNull();
  });

  it("leaves subsequentBounce null when no suppression exists for the addresses", async () => {
    const app = createTestApp(admin);
    const auditId = await insertReenableAudit({
      action: "reenable", oldEmail: `clean-${uid()}@example.com`,
    });
    const res = await request(app).get(URL());
    const row = findById(res.body, auditId);
    expect(row?.subsequentBounce).toBeNull();
  });

  it("ignores non-bounce suppressions (e.g. an unsubscribe afterwards is NOT a re-bounce)", async () => {
    const app = createTestApp(admin);
    const email = `unsub-${uid()}@example.com`;
    const auditId = await insertReenableAudit({
      action: "reenable", oldEmail: email,
      createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });
    await insertSuppression({
      email, reason: "unsubscribed", bounceType: null, description: null,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const res = await request(app).get(URL());
    const row = findById(res.body, auditId);
    expect(row?.subsequentBounce).toBeNull();
  });

  it("does not surface a same-address bounce that lives in a DIFFERENT org", async () => {
    const app = createTestApp(admin);
    const email = `crossorg-${uid()}@example.com`;
    const auditId = await insertReenableAudit({
      action: "reenable", oldEmail: email,
      createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });
    // Cross-org bounce: same address, different organization.
    await insertSuppression({
      email, orgIdOverride: otherOrgId,
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const res = await request(app).get(URL());
    const row = findById(res.body, auditId);
    expect(row?.subsequentBounce).toBeNull();
  });

  it("leaves subsequentBounce null on non-email_suppression entities", async () => {
    const app = createTestApp(admin);
    const [row] = await db.insert(memberAuditLogTable).values({
      organizationId: orgId,
      clubMemberId: memberId,
      actorUserId: adminUserId,
      actorName: "Audit Rebounce Admin",
      actorRole: "org_admin",
      entity: "profile",
      entityId: 1,
      action: "update",
      reason: "profile updated",
    }).returning({ id: memberAuditLogTable.id });
    auditIds.push(row.id);

    const res = await request(app).get(URL());
    const found = findById(res.body, row.id);
    expect(found).toBeDefined();
    expect(found!.subsequentBounce).toBeNull();
  });
});
