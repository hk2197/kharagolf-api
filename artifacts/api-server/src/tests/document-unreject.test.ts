/**
 * Integration tests: PATCH /:memberId/documents/:docId/unreject (Task #257 / #328).
 *
 * Covers the "undo rejection" flow on Member 360:
 *   - happy path: a rejected document returns to pending, the rejection state
 *     is cleared on the row, an audit log entry tagged "rejection withdrawn"
 *     is written with structured metadata, and an in-app member_messages row
 *     is created.
 *   - 409 when the document is not currently rejected (verified or already
 *     pending).
 *   - 404 when the document belongs to a different organization (org scoping
 *     via the param middleware should refuse to touch it).
 *   - 404 when the document id does not exist for the given member.
 *   - 401/403 authorization paths.
 *
 * The mailer / comms providers are mocked so the test never touches real
 * SMTP / push / SMS providers — but the notification helper itself runs end
 * to end, so the in-app message insertion is exercised.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/mailer.js", async () => {
  return {
    sendBroadcastEmail: vi.fn(async () => undefined),
  };
});

vi.mock("../lib/comms.js", async () => {
  return {
    sendTransactionalPush: vi.fn(async (userIds: number[]) => ({
      attempted: userIds.length,
      sent: userIds.length,
      failed: 0,
      invalid: 0,
    })),
    sendTransactionalSms: vi.fn(async () => undefined),
    sendTransactionalWhatsapp: vi.fn(async () => undefined),
    sendBroadcast: vi.fn(async () => ({
      email: { sent: 0, failed: 0 },
      push: { attempted: 0, sent: 0, failed: 0, invalid: 0 },
      sms: { sent: 0, failed: 0 },
    })),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberDocumentsTable,
  memberAuditLogTable,
  memberMessagesTable,
} from "@workspace/db";
import { and, eq, inArray, desc } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgAId: number;
let orgBId: number;
let adminUserId: number;
let outsiderUserId: number;
let memberAId: number;
let memberBId: number;
let admin: TestUser;
let outsider: TestUser;

const URL = (memberId: number, docId: number) =>
  `/api/organizations/${orgAId}/members-360/${memberId}/documents/${docId}/unreject`;

async function insertDoc(opts: {
  orgId: number;
  memberId: number;
  isVerified?: boolean;
  isRejected?: boolean;
  rejectionReason?: string | null;
  rejectedByUserId?: number | null;
}): Promise<number> {
  const [row] = await db.insert(memberDocumentsTable).values({
    organizationId: opts.orgId,
    clubMemberId: opts.memberId,
    documentType: "id_proof",
    title: `Doc ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    fileUrl: "https://example.com/test.pdf",
    isVerified: opts.isVerified ?? false,
    isRejected: opts.isRejected ?? false,
    rejectedAt: opts.isRejected ? new Date() : null,
    rejectedByUserId: opts.isRejected ? (opts.rejectedByUserId ?? null) : null,
    rejectionReason: opts.isRejected ? (opts.rejectionReason ?? "blurry scan") : null,
  }).returning({ id: memberDocumentsTable.id });
  return row.id;
}

async function clearDocsAndAudits() {
  const existing = await db.select({ id: memberDocumentsTable.id })
    .from(memberDocumentsTable)
    .where(inArray(memberDocumentsTable.organizationId, [orgAId, orgBId]));
  if (existing.length) {
    const ids = existing.map(d => d.id);
    await db.delete(memberAuditLogTable).where(and(
      eq(memberAuditLogTable.entity, "document"),
      inArray(memberAuditLogTable.entityId, ids),
    ));
    await db.delete(memberDocumentsTable).where(inArray(memberDocumentsTable.id, ids));
  }
  await db.delete(memberMessagesTable).where(inArray(
    memberMessagesTable.clubMemberId,
    [memberAId, memberBId].filter(Boolean) as number[],
  ));
}

beforeAll(async () => {
  const stamp = Date.now();
  const [orgA] = await db.insert(organizationsTable).values({
    name: `TestOrg_Unreject_A_${stamp}`,
    slug: `test-unreject-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `TestOrg_Unreject_B_${stamp}`,
    slug: `test-unreject-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-unreject-admin-${stamp}`,
    username: `unreject_admin_${stamp}`,
    email: `unreject_admin_${stamp}@example.com`,
    displayName: "Unreject Admin",
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  const [outsideRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-unreject-outsider-${stamp}`,
    username: `unreject_outsider_${stamp}`,
    email: `unreject_outsider_${stamp}@example.com`,
    displayName: "Outsider",
    role: "player",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  outsiderUserId = outsideRow.id;

  const [m1] = await db.insert(clubMembersTable).values({
    organizationId: orgAId,
    firstName: "Alice",
    lastName: "Member",
    email: `unreject_alice_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  memberAId = m1.id;

  const [m2] = await db.insert(clubMembersTable).values({
    organizationId: orgBId,
    firstName: "Bob",
    lastName: "OtherOrg",
    email: `unreject_bob_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  memberBId = m2.id;

  admin = {
    id: adminUserId,
    username: `unreject_admin_${stamp}`,
    displayName: "Unreject Admin",
    role: "org_admin",
    organizationId: orgAId,
  };
  outsider = {
    id: outsiderUserId,
    username: `unreject_outsider_${stamp}`,
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
  if (outsiderUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, outsiderUserId));
  if (orgAId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgAId));
  if (orgBId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgBId));
});

beforeEach(async () => {
  await clearDocsAndAudits();
});

describe("PATCH /unreject — happy path", () => {
  it("clears rejection state, writes audit row, and inserts in-app message", async () => {
    const app = createTestApp(admin);
    const docId = await insertDoc({
      orgId: orgAId,
      memberId: memberAId,
      isRejected: true,
      rejectionReason: "blurry scan",
      rejectedByUserId: adminUserId,
    });

    const res = await request(app)
      .patch(URL(memberAId, docId))
      .send({ reason: "operator error — withdrawing" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(docId);
    expect(res.body.isRejected).toBe(false);
    expect(res.body.rejectedAt).toBeNull();
    expect(res.body.rejectedByUserId).toBeNull();
    expect(res.body.rejectionReason).toBeNull();
    expect(res.body.notification).toBeDefined();
    expect(res.body.notification.inAppMessageId).toBeTypeOf("number");
    // Fan-out: the route should invoke the notify helper and surface
    // per-channel statuses (not just the in-app row). With default
    // operations prefs (email on, push on, sms off), an email-on-file
    // member with no linked app user, the helper reports email=sent,
    // push=no_user, sms=opted_out.
    expect(res.body.notification.emailStatus).toBe("sent");
    expect(res.body.notification.pushStatus).toBe("no_user");
    expect(res.body.notification.smsStatus).toBe("opted_out");

    // Document row reflects the cleared state in DB
    const [row] = await db.select().from(memberDocumentsTable)
      .where(eq(memberDocumentsTable.id, docId));
    expect(row.isRejected).toBe(false);
    expect(row.isVerified).toBe(false);
    expect(row.rejectedAt).toBeNull();
    expect(row.rejectedByUserId).toBeNull();
    expect(row.rejectionReason).toBeNull();

    // Audit row written, attributed to the staff actor, marked as "rejection withdrawn"
    const [audit] = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.entity, "document"),
        eq(memberAuditLogTable.entityId, docId),
      ))
      .orderBy(desc(memberAuditLogTable.createdAt));
    expect(audit).toBeDefined();
    expect(audit.action).toBe("update");
    expect(audit.actorUserId).toBe(adminUserId);
    expect(audit.organizationId).toBe(orgAId);
    expect(audit.reason).toMatch(/rejection withdrawn/i);
    expect(audit.reason).toMatch(/previous reason: blurry scan/);
    expect(audit.reason).toMatch(/note: operator error — withdrawing/);

    const md = audit.metadata as Record<string, unknown> | null;
    expect(md).toBeTruthy();
    expect(md!.kind).toBe("rejection_withdrawn");
    expect(md!.previousReason).toBe("blurry scan");
    expect(md!.previousRejectedByUserId).toBe(adminUserId);
    expect(typeof md!.previousRejectedAt).toBe("string");
    expect(md!.note).toBe("operator error — withdrawing");

    // In-app message persisted, addressed to the member, with the doc title
    const messages = await db.select().from(memberMessagesTable)
      .where(eq(memberMessagesTable.clubMemberId, memberAId));
    expect(messages.length).toBe(1);
    expect(messages[0].channel).toBe("in_app");
    expect(messages[0].status).toBe("sent");
    expect(messages[0].subject).toMatch(/rejection withdrawn/i);
    expect(messages[0].senderUserId).toBe(adminUserId);
  });

  it("works without a reason (note is null) and still clears state", async () => {
    const app = createTestApp(admin);
    const docId = await insertDoc({
      orgId: orgAId,
      memberId: memberAId,
      isRejected: true,
      rejectionReason: "wrong document type",
      rejectedByUserId: adminUserId,
    });

    const res = await request(app).patch(URL(memberAId, docId)).send({});
    expect(res.status).toBe(200);
    expect(res.body.isRejected).toBe(false);

    const [audit] = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.entity, "document"),
        eq(memberAuditLogTable.entityId, docId),
      ))
      .orderBy(desc(memberAuditLogTable.createdAt));
    expect(audit.reason).toMatch(/rejection withdrawn/i);
    expect(audit.reason).not.toMatch(/note:/);
    const md = audit.metadata as Record<string, unknown> | null;
    expect(md!.note).toBeNull();
  });
});

describe("PATCH /unreject — negative cases", () => {
  it("returns 409 when the document is not currently rejected (pending)", async () => {
    const app = createTestApp(admin);
    const docId = await insertDoc({ orgId: orgAId, memberId: memberAId });

    const res = await request(app).patch(URL(memberAId, docId)).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not currently rejected/i);

    // No audit row should have been written
    const audits = await db.select().from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.entity, "document"),
        eq(memberAuditLogTable.entityId, docId),
      ));
    expect(audits.length).toBe(0);

    // No in-app message should have been written
    const messages = await db.select().from(memberMessagesTable)
      .where(eq(memberMessagesTable.clubMemberId, memberAId));
    expect(messages.length).toBe(0);
  });

  it("returns 409 when the document is verified (also not rejected)", async () => {
    const app = createTestApp(admin);
    const docId = await insertDoc({ orgId: orgAId, memberId: memberAId, isVerified: true });

    const res = await request(app).patch(URL(memberAId, docId)).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not currently rejected/i);
  });

  it("returns 404 when the document belongs to another organization", async () => {
    const app = createTestApp(admin);
    // Doc lives in orgB / memberB but we hit the orgA URL with memberA id —
    // the param middleware should 404 because memberA never owned this doc.
    const wrongOrgDocId = await insertDoc({
      orgId: orgBId,
      memberId: memberBId,
      isRejected: true,
    });

    const res = await request(app).patch(URL(memberAId, wrongOrgDocId)).send({});
    expect(res.status).toBe(404);

    // Doc must remain rejected — the un-reject must NOT have been applied
    const [row] = await db.select().from(memberDocumentsTable)
      .where(eq(memberDocumentsTable.id, wrongOrgDocId));
    expect(row.isRejected).toBe(true);
    expect(row.rejectionReason).not.toBeNull();
  });

  it("returns 404 when the document id does not exist", async () => {
    const app = createTestApp(admin);
    const res = await request(app).patch(URL(memberAId, 99_999_999)).send({});
    expect(res.status).toBe(404);
  });

  it("returns 400 when the reason is over 1000 characters", async () => {
    const app = createTestApp(admin);
    const docId = await insertDoc({
      orgId: orgAId, memberId: memberAId, isRejected: true,
    });
    const res = await request(app)
      .patch(URL(memberAId, docId))
      .send({ reason: "x".repeat(1001) });
    expect(res.status).toBe(400);

    // Doc must remain rejected
    const [row] = await db.select().from(memberDocumentsTable)
      .where(eq(memberDocumentsTable.id, docId));
    expect(row.isRejected).toBe(true);
  });
});

describe("PATCH /unreject — authorization", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const docId = await insertDoc({
      orgId: orgAId, memberId: memberAId, isRejected: true,
    });
    const res = await request(app).patch(URL(memberAId, docId)).send({});
    expect(res.status).toBe(401);

    const [row] = await db.select().from(memberDocumentsTable)
      .where(eq(memberDocumentsTable.id, docId));
    expect(row.isRejected).toBe(true);
  });

  it("returns 403 when caller is not a member-admin", async () => {
    const app = createTestApp(outsider);
    const docId = await insertDoc({
      orgId: orgAId, memberId: memberAId, isRejected: true,
    });
    const res = await request(app).patch(URL(memberAId, docId)).send({});
    expect(res.status).toBe(403);

    const [row] = await db.select().from(memberDocumentsTable)
      .where(eq(memberDocumentsTable.id, docId));
    expect(row.isRejected).toBe(true);
  });
});
