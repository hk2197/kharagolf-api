/**
 * Integration tests: Uploader filter on the pending-verification queue
 * (Task #318 — covers the `uploadedByUserId` / `uploadedByUsername` query
 * params and the `uploaders` options list added in Task #255).
 *
 * Covers GET /api/organizations/:orgId/members-360/documents/pending:
 *   - returns only the matching uploader's docs when `uploadedByUserId` is set
 *   - returns only the matching uploader's docs when `uploadedByUsername` is set
 *     (and is case-insensitive)
 *   - the `uploaders` response field is a stable distinct list of every staff
 *     member with pending uploads under the *other* filters, ignoring the
 *     uploader filter itself
 *   - verified / rejected docs and other-org docs never appear in the list
 *
 * Uses the real PostgreSQL database (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberDocumentsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgAId: number;
let orgBId: number;
let adminUserId: number;
let uploaderAliceId: number;
let uploaderBobId: number;
let uploaderCarolOrgBId: number;
let memberAId: number;
let memberBId: number; // belongs to orgB
let admin: TestUser;
let aliceUsername: string;
let bobUsername: string;

const PENDING_URL = () => `/api/organizations/${orgAId}/members-360/documents/pending`;

async function insertDoc(opts: {
  orgId: number;
  memberId: number;
  uploadedByUserId: number | null;
  isVerified?: boolean;
  isRejected?: boolean;
  documentType?: string;
}): Promise<number> {
  const [row] = await db.insert(memberDocumentsTable).values({
    organizationId: opts.orgId,
    clubMemberId: opts.memberId,
    documentType: opts.documentType ?? "id_proof",
    title: `Doc ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    fileUrl: "https://example.com/test.pdf",
    isVerified: opts.isVerified ?? false,
    isRejected: opts.isRejected ?? false,
    rejectedAt: opts.isRejected ? new Date() : null,
    rejectionReason: opts.isRejected ? "test" : null,
    uploadedByUserId: opts.uploadedByUserId ?? undefined,
  }).returning({ id: memberDocumentsTable.id });
  return row.id;
}

async function clearDocs() {
  await db.delete(memberDocumentsTable)
    .where(inArray(memberDocumentsTable.organizationId, [orgAId, orgBId]));
}

beforeAll(async () => {
  const stamp = Date.now();
  const [orgA] = await db.insert(organizationsTable).values({
    name: `TestOrg_PendingUploaderA_${stamp}`,
    slug: `test-pending-uploader-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `TestOrg_PendingUploaderB_${stamp}`,
    slug: `test-pending-uploader-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-pending-uploader-admin-${stamp}`,
    username: `pending_uploader_admin_${stamp}`,
    email: `pending_uploader_admin_${stamp}@example.com`,
    displayName: "Pending Uploader Admin",
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  aliceUsername = `pending_alice_${stamp}`;
  bobUsername = `pending_bob_${stamp}`;
  const [aliceRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-pending-alice-${stamp}`,
    username: aliceUsername,
    email: `${aliceUsername}@example.com`,
    displayName: "Alice Front Desk",
    role: "membership_secretary",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  uploaderAliceId = aliceRow.id;

  const [bobRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-pending-bob-${stamp}`,
    username: bobUsername,
    email: `${bobUsername}@example.com`,
    displayName: "Bob Front Desk",
    role: "membership_secretary",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  uploaderBobId = bobRow.id;

  const [carolRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-pending-carol-${stamp}`,
    username: `pending_carol_${stamp}`,
    email: `pending_carol_${stamp}@example.com`,
    displayName: "Carol OtherOrg",
    role: "membership_secretary",
    organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  uploaderCarolOrgBId = carolRow.id;

  const [m1] = await db.insert(clubMembersTable).values({
    organizationId: orgAId,
    firstName: "Mary",
    lastName: "Member",
    email: `mary_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  memberAId = m1.id;

  const [m2] = await db.insert(clubMembersTable).values({
    organizationId: orgBId,
    firstName: "OtherOrg",
    lastName: "Member",
    email: `other_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  memberBId = m2.id;

  admin = {
    id: adminUserId,
    username: `pending_uploader_admin_${stamp}`,
    displayName: "Pending Uploader Admin",
    role: "org_admin",
    organizationId: orgAId,
  };
});

afterAll(async () => {
  await clearDocs();
  if (memberAId) await db.delete(clubMembersTable).where(eq(clubMembersTable.id, memberAId));
  if (memberBId) await db.delete(clubMembersTable).where(eq(clubMembersTable.id, memberBId));
  for (const id of [adminUserId, uploaderAliceId, uploaderBobId, uploaderCarolOrgBId]) {
    if (id) await db.delete(appUsersTable).where(eq(appUsersTable.id, id));
  }
  if (orgAId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgAId));
  if (orgBId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgBId));
});

beforeEach(async () => {
  await clearDocs();
});

describe("GET /documents/pending — uploadedByUserId filter", () => {
  it("returns only documents uploaded by the supplied user id", async () => {
    const app = createTestApp(admin);
    const aliceDoc1 = await insertDoc({ orgId: orgAId, memberId: memberAId, uploadedByUserId: uploaderAliceId });
    const aliceDoc2 = await insertDoc({ orgId: orgAId, memberId: memberAId, uploadedByUserId: uploaderAliceId });
    await insertDoc({ orgId: orgAId, memberId: memberAId, uploadedByUserId: uploaderBobId });

    const res = await request(app).get(PENDING_URL()).query({ uploadedByUserId: String(uploaderAliceId) });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    const ids = (res.body.documents as Array<{ id: number; uploadedByUserId: number }>).map((d) => d.id).sort();
    expect(ids).toEqual([aliceDoc1, aliceDoc2].sort());
    for (const d of res.body.documents) {
      expect(d.uploadedByUserId).toBe(uploaderAliceId);
    }
  });

  it("ignores verified, rejected, and other-org documents", async () => {
    const app = createTestApp(admin);
    const alicePendingDoc = await insertDoc({ orgId: orgAId, memberId: memberAId, uploadedByUserId: uploaderAliceId });
    await insertDoc({ orgId: orgAId, memberId: memberAId, uploadedByUserId: uploaderAliceId, isVerified: true });
    await insertDoc({ orgId: orgAId, memberId: memberAId, uploadedByUserId: uploaderAliceId, isRejected: true });
    await insertDoc({ orgId: orgBId, memberId: memberBId, uploadedByUserId: uploaderAliceId });

    const res = await request(app).get(PENDING_URL()).query({ uploadedByUserId: String(uploaderAliceId) });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.documents[0].id).toBe(alicePendingDoc);
  });
});

describe("GET /documents/pending — uploadedByUsername filter", () => {
  it("returns only documents uploaded by the supplied username (case-insensitive)", async () => {
    const app = createTestApp(admin);
    const bobDoc = await insertDoc({ orgId: orgAId, memberId: memberAId, uploadedByUserId: uploaderBobId });
    await insertDoc({ orgId: orgAId, memberId: memberAId, uploadedByUserId: uploaderAliceId });

    const res = await request(app).get(PENDING_URL()).query({ uploadedByUsername: bobUsername.toUpperCase() });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.documents[0].id).toBe(bobDoc);
    expect(res.body.documents[0].uploadedByUserId).toBe(uploaderBobId);
    expect(res.body.documents[0].uploadedByUsername).toBe(bobUsername);
  });
});

describe("GET /documents/pending — uploaders options list", () => {
  it("returns a distinct uploader list ignoring the uploader filter itself", async () => {
    const app = createTestApp(admin);
    // Two pending docs by Alice, one by Bob — both should appear in `uploaders`
    // even when the request narrows to only Alice's documents.
    await insertDoc({ orgId: orgAId, memberId: memberAId, uploadedByUserId: uploaderAliceId });
    await insertDoc({ orgId: orgAId, memberId: memberAId, uploadedByUserId: uploaderAliceId });
    await insertDoc({ orgId: orgAId, memberId: memberAId, uploadedByUserId: uploaderBobId });
    // Verified / rejected / other-org rows must NOT contribute uploaders.
    await insertDoc({ orgId: orgAId, memberId: memberAId, uploadedByUserId: uploaderBobId, isVerified: true });
    await insertDoc({ orgId: orgBId, memberId: memberBId, uploadedByUserId: uploaderCarolOrgBId });

    const res = await request(app).get(PENDING_URL()).query({ uploadedByUserId: String(uploaderAliceId) });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    const uploaderIds = (res.body.uploaders as Array<{ userId: number }>).map((u) => u.userId).sort((a, b) => a - b);
    expect(uploaderIds).toEqual([uploaderAliceId, uploaderBobId].sort((a, b) => a - b));

    // Each entry carries the user metadata used by the dropdown.
    const alice = res.body.uploaders.find((u: { userId: number }) => u.userId === uploaderAliceId);
    expect(alice.username).toBe(aliceUsername);
    expect(alice.displayName).toBe("Alice Front Desk");
  });

  it("respects other (non-uploader) filters when building the uploaders list", async () => {
    const app = createTestApp(admin);
    // Alice uploads an `id_proof`, Bob uploads a `medical_form`. When we filter
    // to documentType=id_proof the uploaders list must contain only Alice.
    await insertDoc({ orgId: orgAId, memberId: memberAId, uploadedByUserId: uploaderAliceId, documentType: "id_proof" });
    await insertDoc({ orgId: orgAId, memberId: memberAId, uploadedByUserId: uploaderBobId, documentType: "medical_form" });

    const res = await request(app).get(PENDING_URL()).query({ documentType: "id_proof" });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    const uploaderIds = (res.body.uploaders as Array<{ userId: number }>).map((u) => u.userId);
    expect(uploaderIds).toEqual([uploaderAliceId]);
  });
});
