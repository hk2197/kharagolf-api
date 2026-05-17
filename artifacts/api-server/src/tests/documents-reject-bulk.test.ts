/**
 * Integration tests: Bulk rejecting pending member documents (Task #264 / #326).
 *
 * Covers POST /api/organizations/:orgId/members-360/documents/reject-bulk:
 *   - happy path: every supplied id is rejected with the staff-supplied reason,
 *     audit rows are written, and one notification is dispatched per member
 *     with the same reason.
 *   - mixed batch: returns partial errors for already-verified, already-rejected,
 *     wrong-org, and missing documents while still rejecting valid ones.
 *   - input validation: missing/empty documentIds, > 200 ids, missing reason,
 *     blank reason, and reason > 1000 characters all 400.
 *   - authorization: unauthenticated callers 401, non-member-admin callers 403.
 *
 * The notification helper is mocked so the test doesn't touch real mailer /
 * push / SMS providers but can still assert that the helper was invoked once
 * per successfully-rejected document with the correct reason and member.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/documentRejectedNotify.js", () => ({
  notifyDocumentRejected: vi.fn(async () => ({
    inAppMessageId: 1,
    emailStatus: "sent" as const,
    pushStatus: "skipped" as const,
    smsStatus: "skipped" as const,
    whatsappStatus: "skipped" as const,
  })),
}));

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
import { notifyDocumentRejected } from "../lib/documentRejectedNotify.js";

const notifyMock = vi.mocked(notifyDocumentRejected);

let orgAId: number;
let orgBId: number;
let adminUserId: number;
let outsideUserId: number;
let memberAId: number; // orgA
let memberA2Id: number; // orgA, second member to verify per-member fan-out
let memberBId: number; // orgB
let admin: TestUser;
let outsider: TestUser;

const BULK_URL = () => `/api/organizations/${orgAId}/members-360/documents/reject-bulk`;

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
    name: `TestOrg_BulkRejectA_${stamp}`,
    slug: `test-bulk-reject-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `TestOrg_BulkRejectB_${stamp}`,
    slug: `test-bulk-reject-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-bulk-reject-admin-${stamp}`,
    username: `bulk_reject_admin_${stamp}`,
    email: `bulk_reject_admin_${stamp}@example.com`,
    displayName: "Bulk Reject Admin",
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  const [outsideRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-bulk-reject-outsider-${stamp}`,
    username: `bulk_reject_outsider_${stamp}`,
    email: `bulk_reject_outsider_${stamp}@example.com`,
    displayName: "Outsider",
    role: "player",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  outsideUserId = outsideRow.id;

  const [m1] = await db.insert(clubMembersTable).values({
    organizationId: orgAId,
    firstName: "Alice",
    lastName: "Member",
    email: `alice_reject_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  memberAId = m1.id;

  const [m1b] = await db.insert(clubMembersTable).values({
    organizationId: orgAId,
    firstName: "Anita",
    lastName: "Member",
    email: `anita_reject_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  memberA2Id = m1b.id;

  const [m2] = await db.insert(clubMembersTable).values({
    organizationId: orgBId,
    firstName: "Bob",
    lastName: "OtherOrg",
    email: `bob_reject_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  memberBId = m2.id;

  admin = {
    id: adminUserId,
    username: `bulk_reject_admin_${stamp}`,
    displayName: "Bulk Reject Admin",
    role: "org_admin",
    organizationId: orgAId,
  };
  outsider = {
    id: outsideUserId,
    username: `bulk_reject_outsider_${stamp}`,
    displayName: "Outsider",
    role: "player",
    organizationId: orgAId,
  };
});

afterAll(async () => {
  await clearDocsAndAudits();
  for (const id of [memberAId, memberA2Id, memberBId]) {
    if (id) await db.delete(clubMembersTable).where(eq(clubMembersTable.id, id));
  }
  if (adminUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  if (outsideUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, outsideUserId));
  if (orgAId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgAId));
  if (orgBId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgBId));
});

beforeEach(async () => {
  await clearDocsAndAudits();
  notifyMock.mockClear();
});

describe("POST /documents/reject-bulk — happy path", () => {
  it("rejects every supplied document, writes audits, and notifies each member with the reason", async () => {
    const app = createTestApp(admin);
    const reason = "Photos are blurry — please re-upload clearer scans.";
    const a1 = await insertDoc({ orgId: orgAId, memberId: memberAId });
    const a2 = await insertDoc({ orgId: orgAId, memberId: memberAId });
    const b1 = await insertDoc({ orgId: orgAId, memberId: memberA2Id });
    const ids = [a1, a2, b1];

    const res = await request(app).post(BULK_URL()).send({ documentIds: ids, reason });
    expect(res.status).toBe(200);
    expect(res.body.rejectedCount).toBe(3);
    expect(res.body.errorCount).toBe(0);
    expect(res.body.errors).toEqual([]);
    expect(res.body.rejected.map((r: { id: number }) => r.id).sort()).toEqual([...ids].sort());

    // All rows are now rejected in DB with the supplied reason and staff id.
    const rows = await db.select().from(memberDocumentsTable)
      .where(inArray(memberDocumentsTable.id, ids));
    for (const r of rows) {
      expect(r.isRejected).toBe(true);
      expect(r.rejectedByUserId).toBe(adminUserId);
      expect(r.rejectionReason).toBe(reason);
      expect(r.rejectedAt).not.toBeNull();
      expect(r.isVerified).toBe(false);
    }

    // Audit row per rejected doc, attributed to the admin and labelled "bulk".
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
      expect(a.reason).toContain(reason);
    }

    // One notification per rejected doc, with the supplied reason and the
    // matching club member id (so each member is fanned out to individually).
    expect(notifyMock).toHaveBeenCalledTimes(3);
    const notifyByDocId = new Map<number, { clubMemberId: number; reason: string; senderUserId?: number | null }>();
    for (const call of notifyMock.mock.calls) {
      const arg = call[0];
      notifyByDocId.set(arg.document.id, {
        clubMemberId: arg.clubMemberId,
        reason: arg.reason,
        senderUserId: arg.senderUserId,
      });
    }
    expect(notifyByDocId.get(a1)).toMatchObject({ clubMemberId: memberAId, reason, senderUserId: adminUserId });
    expect(notifyByDocId.get(a2)).toMatchObject({ clubMemberId: memberAId, reason, senderUserId: adminUserId });
    expect(notifyByDocId.get(b1)).toMatchObject({ clubMemberId: memberA2Id, reason, senderUserId: adminUserId });
  });
});

describe("POST /documents/reject-bulk — mixed batch", () => {
  it("returns partial errors for already-verified, already-rejected, wrong-org, and missing docs", async () => {
    const app = createTestApp(admin);
    const reason = "Document is illegible.";
    const okId = await insertDoc({ orgId: orgAId, memberId: memberAId });
    const alreadyVerifiedId = await insertDoc({ orgId: orgAId, memberId: memberAId, isVerified: true });
    const alreadyRejectedId = await insertDoc({ orgId: orgAId, memberId: memberAId, isRejected: true });
    const wrongOrgId = await insertDoc({ orgId: orgBId, memberId: memberBId });
    const missingId = 99_999_999;

    const res = await request(app)
      .post(BULK_URL())
      .send({ documentIds: [okId, alreadyVerifiedId, alreadyRejectedId, wrongOrgId, missingId], reason });

    expect(res.status).toBe(200);
    expect(res.body.rejectedCount).toBe(1);
    expect(res.body.errorCount).toBe(4);
    expect(res.body.rejected).toEqual([
      expect.objectContaining({ id: okId, clubMemberId: memberAId }),
    ]);

    const errMap = new Map<number, string>(
      res.body.errors.map((e: { documentId: number; error: string }) => [e.documentId, e.error]),
    );
    expect(errMap.get(alreadyVerifiedId)).toMatch(/already.*verified/i);
    expect(errMap.get(alreadyRejectedId)).toMatch(/already.*rejected/i);
    expect(errMap.get(wrongOrgId)).toMatch(/not found/i);
    expect(errMap.get(missingId)).toMatch(/not found/i);

    // Wrong-org doc must NOT have been touched — confirms org-scoping.
    const [wrongOrgRow] = await db.select().from(memberDocumentsTable)
      .where(eq(memberDocumentsTable.id, wrongOrgId));
    expect(wrongOrgRow.isRejected).toBe(false);
    expect(wrongOrgRow.rejectionReason).toBeNull();

    // Already-verified doc remains verified and not rejected.
    const [verRow] = await db.select().from(memberDocumentsTable)
      .where(eq(memberDocumentsTable.id, alreadyVerifiedId));
    expect(verRow.isVerified).toBe(true);
    expect(verRow.isRejected).toBe(false);

    // Audit row written only for the one successful rejection.
    const audits = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.entity, "document"),
        inArray(memberAuditLogTable.entityId, [okId, alreadyVerifiedId, alreadyRejectedId, wrongOrgId]),
      ));
    expect(audits.length).toBe(1);
    expect(audits[0].entityId).toBe(okId);

    // Notification only fires for the successfully-rejected doc.
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][0]).toMatchObject({
      clubMemberId: memberAId,
      reason,
    });
    expect(notifyMock.mock.calls[0][0].document.id).toBe(okId);
  });
});

describe("POST /documents/reject-bulk — input validation", () => {
  it("rejects an empty body with 400", async () => {
    const app = createTestApp(admin);
    const res = await request(app).post(BULK_URL()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/documentIds/i);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("rejects an empty documentIds array with 400", async () => {
    const app = createTestApp(admin);
    const res = await request(app).post(BULK_URL()).send({ documentIds: [], reason: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/documentIds/i);
  });

  it("rejects more than 200 ids with 400", async () => {
    const app = createTestApp(admin);
    const ids = Array.from({ length: 201 }, (_, i) => i + 1);
    const res = await request(app).post(BULK_URL()).send({ documentIds: ids, reason: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/200/);
  });

  it("rejects a missing reason with 400", async () => {
    const app = createTestApp(admin);
    const docId = await insertDoc({ orgId: orgAId, memberId: memberAId });
    const res = await request(app).post(BULK_URL()).send({ documentIds: [docId] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason/i);
    // The doc must still be pending (not rejected) and notification not sent.
    const [row] = await db.select().from(memberDocumentsTable).where(eq(memberDocumentsTable.id, docId));
    expect(row.isRejected).toBe(false);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("rejects a blank/whitespace-only reason with 400", async () => {
    const app = createTestApp(admin);
    const docId = await insertDoc({ orgId: orgAId, memberId: memberAId });
    const res = await request(app).post(BULK_URL()).send({ documentIds: [docId], reason: "   \n  " });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason/i);
  });

  it("rejects a reason longer than 1000 characters with 400", async () => {
    const app = createTestApp(admin);
    const docId = await insertDoc({ orgId: orgAId, memberId: memberAId });
    const res = await request(app)
      .post(BULK_URL())
      .send({ documentIds: [docId], reason: "x".repeat(1001) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/1000/);
  });

  it("rejects an array of only invalid ids with 400", async () => {
    const app = createTestApp(admin);
    const res = await request(app).post(BULK_URL())
      .send({ documentIds: ["not-a-number", null, -3, 0], reason: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no valid/i);
  });
});

describe("POST /documents/reject-bulk — authorization", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const docId = await insertDoc({ orgId: orgAId, memberId: memberAId });
    const res = await request(app).post(BULK_URL()).send({ documentIds: [docId], reason: "x" });
    expect(res.status).toBe(401);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("returns 403 when caller is not a member-admin", async () => {
    const app = createTestApp(outsider);
    const docId = await insertDoc({ orgId: orgAId, memberId: memberAId });
    const res = await request(app).post(BULK_URL()).send({ documentIds: [docId], reason: "x" });
    expect(res.status).toBe(403);

    // Doc must still be pending.
    const [row] = await db.select().from(memberDocumentsTable).where(eq(memberDocumentsTable.id, docId));
    expect(row.isRejected).toBe(false);
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
