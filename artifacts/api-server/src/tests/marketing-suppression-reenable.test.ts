/**
 * Integration tests: POST /organizations/:orgId/marketing/suppressions/:id/reenable
 *
 * Task #1311 — "Let admins one-click re-enable a suppressed email after fixing
 * a typo". Covers the two-step preview/confirm flow, the no-replacement path,
 * email/conflict validation, audit logging, org scoping and the bounced-class
 * gating semantics.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  clubMembersTable,
  emailSuppressionsTable,
  memberAuditLogTable,
} from "@workspace/db";
import { and, eq, inArray, desc } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "./helpers.js";

let orgAId: number;
let orgBId: number;
let adminUserId: number;
let outsiderUserId: number;
let admin: TestUser;
let outsider: TestUser;

const createdMemberIds: number[] = [];
const createdSuppressionIds: number[] = [];

async function makeSuppression(opts: {
  orgId: number;
  email: string;
  reason?: string;
  bounceType?: string | null;
  description?: string | null;
}): Promise<number> {
  const [row] = await db.insert(emailSuppressionsTable).values({
    organizationId: opts.orgId,
    email: opts.email.toLowerCase(),
    reason: opts.reason ?? "bounced",
    bounceType: opts.bounceType ?? "BadMailbox",
    description: opts.description ?? "The recipient's mailbox does not exist",
  }).returning({ id: emailSuppressionsTable.id });
  createdSuppressionIds.push(row.id);
  return row.id;
}

async function makeMember(opts: { orgId: number; email: string; firstName?: string; lastName?: string }): Promise<number> {
  const [row] = await db.insert(clubMembersTable).values({
    organizationId: opts.orgId,
    firstName: opts.firstName ?? "First",
    lastName: opts.lastName ?? "Last",
    email: opts.email,
  }).returning({ id: clubMembersTable.id });
  createdMemberIds.push(row.id);
  return row.id;
}

async function clearAudits() {
  await db.delete(memberAuditLogTable).where(and(
    eq(memberAuditLogTable.entity, "email_suppression"),
    inArray(memberAuditLogTable.organizationId, [orgAId, orgBId].filter(Boolean) as number[]),
  ));
}

beforeAll(async () => {
  const stamp = uid("reenable");
  const [orgA] = await db.insert(organizationsTable).values({
    name: `TestOrg_Reenable_A_${stamp}`,
    slug: `test-reenable-a-${stamp}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `TestOrg_Reenable_B_${stamp}`,
    slug: `test-reenable-b-${stamp}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `reenable-admin-${stamp}`,
    username: `reenable_admin_${stamp}`,
    email: `reenable_admin_${stamp}@example.com`,
    displayName: "Reenable Admin",
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  const [outsiderRow] = await db.insert(appUsersTable).values({
    replitUserId: `reenable-outsider-${stamp}`,
    username: `reenable_outsider_${stamp}`,
    email: `reenable_outsider_${stamp}@example.com`,
    displayName: "Reenable Outsider",
    role: "player",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  outsiderUserId = outsiderRow.id;

  admin = {
    id: adminUserId,
    username: `reenable_admin_${stamp}`,
    displayName: "Reenable Admin",
    role: "org_admin",
    organizationId: orgAId,
  };
  outsider = {
    id: outsiderUserId,
    username: `reenable_outsider_${stamp}`,
    displayName: "Reenable Outsider",
    role: "player",
    organizationId: orgAId,
  };
});

afterAll(async () => {
  await clearAudits();
  if (createdSuppressionIds.length) {
    await db.delete(emailSuppressionsTable).where(inArray(emailSuppressionsTable.id, createdSuppressionIds));
  }
  if (createdMemberIds.length) {
    await db.delete(clubMembersTable).where(inArray(clubMembersTable.id, createdMemberIds));
  }
  await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, [adminUserId, outsiderUserId].filter(Boolean) as number[]));
  if (adminUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  if (outsiderUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, outsiderUserId));
  if (orgAId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgAId));
  if (orgBId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgBId));
});

beforeEach(async () => {
  await clearAudits();
  // Drain leftover suppressions from previous tests so we start clean.
  if (createdSuppressionIds.length) {
    await db.delete(emailSuppressionsTable).where(inArray(emailSuppressionsTable.id, createdSuppressionIds));
    createdSuppressionIds.length = 0;
  }
  if (createdMemberIds.length) {
    await db.delete(clubMembersTable).where(inArray(clubMembersTable.id, createdMemberIds));
    createdMemberIds.length = 0;
  }
});

const URL = (orgId: number, supId: number) =>
  `/api/organizations/${orgId}/marketing/suppressions/${supId}/reenable`;

describe("POST /suppressions/:id/reenable — auth & 404", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const app = createTestApp();
    const supId = await makeSuppression({ orgId: orgAId, email: `bad-${uid()}@example.com` });
    const res = await request(app).post(URL(orgAId, supId)).send({ confirmed: true });
    expect(res.status).toBe(401);

    // The suppression must still exist
    const [row] = await db.select().from(emailSuppressionsTable).where(eq(emailSuppressionsTable.id, supId));
    expect(row).toBeDefined();
  });

  it("rejects non-admin players with 403", async () => {
    const app = createTestApp(outsider);
    const supId = await makeSuppression({ orgId: orgAId, email: `bad-${uid()}@example.com` });
    const res = await request(app).post(URL(orgAId, supId)).send({ confirmed: true });
    expect(res.status).toBe(403);
  });

  it("rejects admins from a different org with 403", async () => {
    const wrongOrgAdmin: TestUser = { ...admin, organizationId: orgBId };
    const app = createTestApp(wrongOrgAdmin);
    const supId = await makeSuppression({ orgId: orgAId, email: `bad-${uid()}@example.com` });
    const res = await request(app).post(URL(orgAId, supId)).send({ confirmed: true });
    expect(res.status).toBe(403);
  });

  it("returns 404 when the suppression doesn't exist in this org", async () => {
    const app = createTestApp(admin);
    const supId = await makeSuppression({ orgId: orgBId, email: `bad-${uid()}@example.com` });
    const res = await request(app).post(URL(orgAId, supId)).send({ confirmed: true });
    expect(res.status).toBe(404);
  });
});

describe("POST /suppressions/:id/reenable — happy paths", () => {
  it("removes suppression with no replacement and writes an org-level audit row", async () => {
    const app = createTestApp(admin);
    const email = `nomatch-${uid()}@example.com`;
    const supId = await makeSuppression({ orgId: orgAId, email });

    const res = await request(app).post(URL(orgAId, supId)).send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.removedSuppressionId).toBe(supId);
    expect(res.body.replacementEmail).toBeNull();
    expect(res.body.updatedMemberIds).toEqual([]);
    expect(res.body.updatedUserIds).toEqual([]);

    const remaining = await db.select().from(emailSuppressionsTable).where(eq(emailSuppressionsTable.id, supId));
    expect(remaining.length).toBe(0);

    const [audit] = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.entity, "email_suppression"),
        eq(memberAuditLogTable.entityId, supId),
      ))
      .orderBy(desc(memberAuditLogTable.createdAt));
    expect(audit).toBeDefined();
    expect(audit.action).toBe("reenable");
    expect(audit.actorUserId).toBe(adminUserId);
    expect(audit.organizationId).toBe(orgAId);
    expect(audit.clubMemberId).toBeNull();
    const md = audit.metadata as Record<string, unknown> | null;
    expect(md).toBeTruthy();
    expect(md!.oldEmail).toBe(email.toLowerCase());
    expect(md!.suppressionReason).toBe("bounced");
    expect(md!.bounceType).toBe("BadMailbox");
  });

  it("two-step: replacement returns a preview first, then commits with confirmed=true", async () => {
    const app = createTestApp(admin);
    const oldEmail = `typo-${uid()}@exmaple.com`;
    const newEmail = `typo-${uid()}@example.com`;
    const memberId = await makeMember({ orgId: orgAId, email: oldEmail, firstName: "Pat", lastName: "Typo" });
    const supId = await makeSuppression({ orgId: orgAId, email: oldEmail });

    // Preview step
    const preview = await request(app).post(URL(orgAId, supId)).send({ replacementEmail: newEmail });
    expect(preview.status).toBe(200);
    expect(preview.body.requiresConfirmation).toBe(true);
    expect(preview.body.replacementEmail).toBe(newEmail.toLowerCase());
    expect(preview.body.matchedMembers.length).toBe(1);
    expect(preview.body.matchedMembers[0].id).toBe(memberId);
    expect(preview.body.matchedMembers[0].name).toBe("Pat Typo");

    // The suppression and member must be unchanged after preview
    const [stillSup] = await db.select().from(emailSuppressionsTable).where(eq(emailSuppressionsTable.id, supId));
    expect(stillSup).toBeDefined();
    const [stillMember] = await db.select().from(clubMembersTable).where(eq(clubMembersTable.id, memberId));
    expect(stillMember.email).toBe(oldEmail);

    // No audit row written for the preview call
    const previewAudits = await db.select().from(memberAuditLogTable)
      .where(and(eq(memberAuditLogTable.entity, "email_suppression"), eq(memberAuditLogTable.entityId, supId)));
    expect(previewAudits.length).toBe(0);

    // Confirm step
    const commit = await request(app).post(URL(orgAId, supId)).send({ replacementEmail: newEmail, confirmed: true });
    expect(commit.status).toBe(200);
    expect(commit.body.ok).toBe(true);
    expect(commit.body.replacementEmail).toBe(newEmail.toLowerCase());
    expect(commit.body.updatedMemberIds).toEqual([memberId]);

    // Suppression deleted, member email patched
    const removed = await db.select().from(emailSuppressionsTable).where(eq(emailSuppressionsTable.id, supId));
    expect(removed.length).toBe(0);
    const [patched] = await db.select().from(clubMembersTable).where(eq(clubMembersTable.id, memberId));
    expect(patched.email).toBe(newEmail.toLowerCase());

    // Audit row tagged to the member with the email change
    const [audit] = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.entity, "email_suppression"),
        eq(memberAuditLogTable.entityId, supId),
      ))
      .orderBy(desc(memberAuditLogTable.createdAt));
    expect(audit).toBeDefined();
    expect(audit.action).toBe("reenable_with_replacement");
    expect(audit.clubMemberId).toBe(memberId);
    expect(audit.actorUserId).toBe(adminUserId);
    const changes = audit.fieldChanges as { email?: { from: unknown; to: unknown } } | null;
    expect(changes?.email?.from).toBe(oldEmail.toLowerCase());
    expect(changes?.email?.to).toBe(newEmail.toLowerCase());
  });

  it("commits in a single call when replacement matches no member (no preview required)", async () => {
    const app = createTestApp(admin);
    const oldEmail = `solo-${uid()}@example.com`;
    const newEmail = `solo-${uid()}@example.com`;
    const supId = await makeSuppression({ orgId: orgAId, email: oldEmail });

    // Preview step still returns requiresConfirmation even with zero matches —
    // the admin should always get a chance to confirm a replacement.
    const preview = await request(app).post(URL(orgAId, supId)).send({ replacementEmail: newEmail });
    expect(preview.status).toBe(200);
    expect(preview.body.requiresConfirmation).toBe(true);
    expect(preview.body.matchedMembers).toEqual([]);
    expect(preview.body.matchedUsers).toEqual([]);

    // Confirm
    const commit = await request(app).post(URL(orgAId, supId)).send({ replacementEmail: newEmail, confirmed: true });
    expect(commit.status).toBe(200);
    expect(commit.body.updatedMemberIds).toEqual([]);

    // Audit is org-level (clubMemberId null) when nothing was linked
    const [audit] = await db.select().from(memberAuditLogTable)
      .where(and(eq(memberAuditLogTable.entity, "email_suppression"), eq(memberAuditLogTable.entityId, supId)))
      .orderBy(desc(memberAuditLogTable.createdAt));
    expect(audit.action).toBe("reenable_with_replacement");
    expect(audit.clubMemberId).toBeNull();
  });
});

describe("POST /suppressions/:id/reenable — validation", () => {
  it("rejects malformed replacementEmail with 400", async () => {
    const app = createTestApp(admin);
    const supId = await makeSuppression({ orgId: orgAId, email: `bad-${uid()}@example.com` });
    const res = await request(app).post(URL(orgAId, supId)).send({ replacementEmail: "not-an-email", confirmed: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid email/);

    // Untouched
    const [row] = await db.select().from(emailSuppressionsTable).where(eq(emailSuppressionsTable.id, supId));
    expect(row).toBeDefined();
  });

  it("rejects replacement equal to the original (case-insensitive) with 400", async () => {
    const app = createTestApp(admin);
    const email = `same-${uid()}@example.com`;
    const supId = await makeSuppression({ orgId: orgAId, email });
    const res = await request(app).post(URL(orgAId, supId)).send({ replacementEmail: email.toUpperCase(), confirmed: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/identical/);
  });

  it("returns 409 when replacement is itself on the suppression list", async () => {
    const app = createTestApp(admin);
    const oldEmail = `orig-${uid()}@example.com`;
    const otherEmail = `other-${uid()}@example.com`;
    const supId = await makeSuppression({ orgId: orgAId, email: oldEmail });
    const conflictId = await makeSuppression({ orgId: orgAId, email: otherEmail });
    const res = await request(app).post(URL(orgAId, supId)).send({ replacementEmail: otherEmail, confirmed: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/suppression list/);
    expect(res.body.conflictId).toBe(conflictId);
  });

  it.each([
    ["unsubscribed"],
    ["spam_complaint"],
    ["manual"],
  ])("rejects re-enable on non-bounce reason %s with 409 and leaves the suppression intact", async (reason) => {
    const app = createTestApp(admin);
    const supId = await makeSuppression({
      orgId: orgAId,
      email: `nb-${reason}-${uid()}@example.com`,
      reason,
      bounceType: null,
      description: null,
    });
    const res = await request(app).post(URL(orgAId, supId)).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/bounced/i);
    expect(res.body.reason).toBe(reason);

    const [row] = await db.select().from(emailSuppressionsTable).where(eq(emailSuppressionsTable.id, supId));
    expect(row).toBeDefined();
  });
});
