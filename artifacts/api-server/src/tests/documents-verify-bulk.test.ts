/**
 * Integration tests: Bulk verifying pending member documents (Task #225 / #265).
 *
 * Covers POST /api/organizations/:orgId/members-360/documents/verify-bulk:
 *   - happy path: every supplied id verifies and audit rows are written
 *   - mixed batch: returns partial errors for already-verified, already-rejected,
 *     and wrong-org documents while still verifying valid ones
 *   - input validation: missing body, empty array, > 200 ids, no valid numeric ids
 *   - authorization: non-admins are rejected
 *
 * Uses the real PostgreSQL database (DATABASE_URL). Fixtures are created in
 * beforeAll, refreshed before each test, and torn down in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberDocumentsTable,
  memberAuditLogTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgAId: number;
let orgBId: number;
let adminUserId: number;
let outsideUserId: number;
let memberAId: number;
let memberBId: number; // belongs to orgB
let admin: TestUser;
let outsider: TestUser;

const BULK_URL = () => `/api/organizations/${orgAId}/members-360/documents/verify-bulk`;

async function insertDoc(opts: {
  orgId: number;
  memberId: number;
  isVerified?: boolean;
  isRejected?: boolean;
  title?: string;
}): Promise<number> {
  const [row] = await db.insert(memberDocumentsTable).values({
    organizationId: opts.orgId,
    clubMemberId: opts.memberId,
    documentType: "id_proof",
    title: opts.title ?? `Doc ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    fileUrl: "https://example.com/test.pdf",
    isVerified: opts.isVerified ?? false,
    isRejected: opts.isRejected ?? false,
    rejectedAt: opts.isRejected ? new Date() : null,
    rejectionReason: opts.isRejected ? "test rejection" : null,
  }).returning({ id: memberDocumentsTable.id });
  return row.id;
}

async function clearDocsAndAudits() {
  // Clean up any docs from previous tests (and their audit rows) to keep
  // assertions about per-doc audit writes precise.
  const existing = await db.select({ id: memberDocumentsTable.id })
    .from(memberDocumentsTable)
    .where(inArray(memberDocumentsTable.organizationId, [orgAId, orgBId]));
  if (existing.length) {
    const ids = existing.map((d) => d.id);
    await db.delete(memberAuditLogTable).where(and(
      eq(memberAuditLogTable.entity, "document"),
      inArray(memberAuditLogTable.entityId, ids),
    ));
    await db.delete(memberDocumentsTable).where(inArray(memberDocumentsTable.id, ids));
  }
}

beforeAll(async () => {
  const stamp = Date.now();
  const [orgA] = await db.insert(organizationsTable).values({
    name: `TestOrg_BulkVerifyA_${stamp}`,
    slug: `test-bulk-verify-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `TestOrg_BulkVerifyB_${stamp}`,
    slug: `test-bulk-verify-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-bulk-admin-${stamp}`,
    username: `bulk_admin_${stamp}`,
    email: `bulk_admin_${stamp}@example.com`,
    displayName: "Bulk Verify Admin",
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  const [outsideRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-bulk-outsider-${stamp}`,
    username: `bulk_outsider_${stamp}`,
    email: `bulk_outsider_${stamp}@example.com`,
    displayName: "Outsider",
    role: "player",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  outsideUserId = outsideRow.id;

  const [m1] = await db.insert(clubMembersTable).values({
    organizationId: orgAId,
    firstName: "Alice",
    lastName: "Member",
    email: `alice_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  memberAId = m1.id;

  const [m2] = await db.insert(clubMembersTable).values({
    organizationId: orgBId,
    firstName: "Bob",
    lastName: "OtherOrg",
    email: `bob_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  memberBId = m2.id;

  admin = {
    id: adminUserId,
    username: `bulk_admin_${stamp}`,
    displayName: "Bulk Verify Admin",
    role: "org_admin",
    organizationId: orgAId,
  };
  outsider = {
    id: outsideUserId,
    username: `bulk_outsider_${stamp}`,
    displayName: "Outsider",
    role: "player",
    organizationId: orgAId,
  };
});

afterAll(async () => {
  await clearDocsAndAudits();
  if (memberAId) await db.delete(clubMembersTable).where(eq(clubMembersTable.id, memberAId));
  if (memberBId) await db.delete(clubMembersTable).where(eq(clubMembersTable.id, memberBId));
  if (adminUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  if (outsideUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, outsideUserId));
  if (orgAId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgAId));
  if (orgBId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgBId));
});

beforeEach(async () => {
  await clearDocsAndAudits();
});

describe("POST /documents/verify-bulk — happy path", () => {
  it("verifies every supplied document and writes one audit row per success", async () => {
    const app = createTestApp(admin);
    const ids = [
      await insertDoc({ orgId: orgAId, memberId: memberAId }),
      await insertDoc({ orgId: orgAId, memberId: memberAId }),
      await insertDoc({ orgId: orgAId, memberId: memberAId }),
    ];

    const res = await request(app).post(BULK_URL()).send({ documentIds: ids });
    expect(res.status).toBe(200);
    expect(res.body.verifiedCount).toBe(3);
    expect(res.body.errorCount).toBe(0);
    expect(res.body.errors).toEqual([]);
    expect(res.body.verified.map((v: { id: number }) => v.id).sort()).toEqual([...ids].sort());

    // All rows are now verified in DB
    const rows = await db.select().from(memberDocumentsTable)
      .where(inArray(memberDocumentsTable.id, ids));
    for (const r of rows) {
      expect(r.isVerified).toBe(true);
      expect(r.verifiedByUserId).toBe(adminUserId);
      expect(r.verifiedAt).not.toBeNull();
    }

    // One audit row per verified doc, attributed to the admin and labelled "bulk"
    const audits = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.entity, "document"),
        inArray(memberAuditLogTable.entityId, ids),
      ));
    expect(audits.length).toBe(3);
    for (const a of audits) {
      expect(a.action).toBe("update");
      expect(a.organizationId).toBe(orgAId);
      expect(a.actorUserId).toBe(adminUserId);
      expect(a.reason).toMatch(/bulk/i);
    }
  });
});

describe("POST /documents/verify-bulk — mixed batch", () => {
  it("returns partial errors for already-verified, already-rejected, and wrong-org docs", async () => {
    const app = createTestApp(admin);
    const okId = await insertDoc({ orgId: orgAId, memberId: memberAId });
    const alreadyVerifiedId = await insertDoc({ orgId: orgAId, memberId: memberAId, isVerified: true });
    const alreadyRejectedId = await insertDoc({ orgId: orgAId, memberId: memberAId, isRejected: true });
    const wrongOrgId = await insertDoc({ orgId: orgBId, memberId: memberBId });
    const missingId = 99_999_999;

    const res = await request(app)
      .post(BULK_URL())
      .send({ documentIds: [okId, alreadyVerifiedId, alreadyRejectedId, wrongOrgId, missingId] });

    expect(res.status).toBe(200);
    expect(res.body.verifiedCount).toBe(1);
    expect(res.body.errorCount).toBe(4);
    expect(res.body.verified).toEqual([{ id: okId, clubMemberId: memberAId }]);

    const errMap = new Map<number, string>(
      res.body.errors.map((e: { documentId: number; error: string }) => [e.documentId, e.error]),
    );
    expect(errMap.get(alreadyVerifiedId)).toMatch(/already verified/i);
    expect(errMap.get(alreadyRejectedId)).toMatch(/rejected/i);
    expect(errMap.get(wrongOrgId)).toMatch(/not found/i);
    expect(errMap.get(missingId)).toMatch(/not found/i);

    // Wrong-org doc must NOT have been verified — confirms org-scoping
    const [wrongOrgRow] = await db.select().from(memberDocumentsTable)
      .where(eq(memberDocumentsTable.id, wrongOrgId));
    expect(wrongOrgRow.isVerified).toBe(false);

    // Audit row written only for the one successful verification
    const audits = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.entity, "document"),
        inArray(memberAuditLogTable.entityId, [okId, alreadyVerifiedId, alreadyRejectedId, wrongOrgId]),
      ));
    expect(audits.length).toBe(1);
    expect(audits[0].entityId).toBe(okId);
  });
});

describe("POST /documents/verify-bulk — input validation", () => {
  it("rejects an empty body with 400", async () => {
    const app = createTestApp(admin);
    const res = await request(app).post(BULK_URL()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/documentIds/i);
  });

  it("rejects an empty documentIds array with 400", async () => {
    const app = createTestApp(admin);
    const res = await request(app).post(BULK_URL()).send({ documentIds: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/documentIds/i);
  });

  it("rejects more than 200 ids with 400", async () => {
    const app = createTestApp(admin);
    const ids = Array.from({ length: 201 }, (_, i) => i + 1);
    const res = await request(app).post(BULK_URL()).send({ documentIds: ids });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/200/);
  });

  it("rejects an array of only invalid ids with 400", async () => {
    const app = createTestApp(admin);
    const res = await request(app).post(BULK_URL()).send({ documentIds: ["not-a-number", null, -3, 0] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no valid/i);
  });
});

describe("POST /documents/verify-bulk — authorization", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const docId = await insertDoc({ orgId: orgAId, memberId: memberAId });
    const res = await request(app).post(BULK_URL()).send({ documentIds: [docId] });
    expect(res.status).toBe(401);
  });

  it("returns 403 when caller is not a member-admin", async () => {
    const app = createTestApp(outsider);
    const docId = await insertDoc({ orgId: orgAId, memberId: memberAId });
    const res = await request(app).post(BULK_URL()).send({ documentIds: [docId] });
    expect(res.status).toBe(403);

    // Doc must still be unverified
    const [row] = await db.select().from(memberDocumentsTable).where(eq(memberDocumentsTable.id, docId));
    expect(row.isVerified).toBe(false);
  });
});
