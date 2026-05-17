/**
 * Integration tests: GET /:memberId/documents enrichment with the
 * "previously rejected — withdrawn" indicator (Task #329).
 *
 * Task #329 added a per-document `withdrawnRejection` block on the
 * Member 360 documents listing whose source of truth is the audit log:
 *   - the doc row itself loses all rejection state on un-reject, so the
 *     listing replays member_audit_log to surface a "previously rejected
 *     — withdrawn" inline note
 *   - the indicator is only present when the *most recent* audit row for
 *     that doc is a `rejection_withdrawn` event — a subsequent verify or
 *     re-reject must suppress it
 *   - the enrichment understands two encodings for the withdrawal: the
 *     new structured `metadata.kind === "rejection_withdrawn"` path and
 *     a legacy reason-string fallback for rows written before the
 *     metadata column existed.
 *
 * These tests exercise the listing endpoint directly. Audit rows are
 * inserted with explicit timestamps to guarantee ordering, so the test
 * does not depend on the wall clock of the unreject/verify/reject
 * routes.
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

let orgId: number;
let adminUserId: number;
let originalRejecterUserId: number;
let withdrawerUserId: number;
let memberId: number;
let admin: TestUser;

const URL = (mid: number) =>
  `/api/organizations/${orgId}/members-360/${mid}/documents`;

async function insertDoc(opts: {
  isVerified?: boolean;
  isRejected?: boolean;
  rejectionReason?: string | null;
  rejectedByUserId?: number | null;
  rejectedAt?: Date | null;
}): Promise<number> {
  const [row] = await db.insert(memberDocumentsTable).values({
    organizationId: orgId,
    clubMemberId: memberId,
    documentType: "id_proof",
    title: `Doc ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    fileUrl: "https://example.com/test.pdf",
    isVerified: opts.isVerified ?? false,
    isRejected: opts.isRejected ?? false,
    rejectedAt: opts.isRejected ? (opts.rejectedAt ?? new Date()) : null,
    rejectedByUserId: opts.isRejected ? (opts.rejectedByUserId ?? null) : null,
    rejectionReason: opts.isRejected ? (opts.rejectionReason ?? "blurry scan") : null,
  }).returning({ id: memberDocumentsTable.id });
  return row.id;
}

async function insertAudit(opts: {
  docId: number;
  actorUserId: number | null;
  actorName?: string | null;
  action?: string;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
}) {
  await db.insert(memberAuditLogTable).values({
    organizationId: orgId,
    clubMemberId: memberId,
    actorUserId: opts.actorUserId,
    actorName: opts.actorName ?? null,
    actorRole: null,
    entity: "document",
    entityId: opts.docId,
    action: opts.action ?? "update",
    fieldChanges: null,
    reason: opts.reason ?? null,
    metadata: opts.metadata ?? null,
    ipAddress: null,
    userAgent: null,
    createdAt: opts.createdAt,
  });
}

async function clearDocsAndAudits() {
  const existing = await db.select({ id: memberDocumentsTable.id })
    .from(memberDocumentsTable)
    .where(eq(memberDocumentsTable.organizationId, orgId));
  if (existing.length) {
    const ids = existing.map(d => d.id);
    await db.delete(memberAuditLogTable).where(and(
      eq(memberAuditLogTable.entity, "document"),
      inArray(memberAuditLogTable.entityId, ids),
    ));
    await db.delete(memberDocumentsTable).where(inArray(memberDocumentsTable.id, ids));
  }
}

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_WithdrawnInd_${stamp}`,
    slug: `test-withdrawn-ind-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-wri-admin-${stamp}`,
    username: `wri_admin_${stamp}`,
    email: `wri_admin_${stamp}@example.com`,
    displayName: "Withdrawn Indicator Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  const [origRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-wri-orig-${stamp}`,
    username: `wri_orig_${stamp}`,
    email: `wri_orig_${stamp}@example.com`,
    displayName: "Original Rejecter",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  originalRejecterUserId = origRow.id;

  const [withRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-wri-with-${stamp}`,
    username: `wri_with_${stamp}`,
    email: `wri_with_${stamp}@example.com`,
    displayName: "Withdrawing Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  withdrawerUserId = withRow.id;

  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    firstName: "Iris",
    lastName: "WithdrawnInd",
    email: `wri_member_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  memberId = m.id;

  admin = {
    id: adminUserId,
    username: `wri_admin_${stamp}`,
    displayName: "Withdrawn Indicator Admin",
    role: "org_admin",
    organizationId: orgId,
  };
});

afterAll(async () => {
  await clearDocsAndAudits();
  if (memberId) await db.delete(clubMembersTable).where(eq(clubMembersTable.id, memberId));
  for (const uid of [adminUserId, originalRejecterUserId, withdrawerUserId]) {
    if (uid) await db.delete(appUsersTable).where(eq(appUsersTable.id, uid));
  }
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  await clearDocsAndAudits();
});

describe("GET /:memberId/documents — withdrawnRejection enrichment (metadata path)", () => {
  it("returns the withdrawal block with original rejecter, original reason, and who withdrew it after a reject + unreject cycle", async () => {
    const app = createTestApp(admin);
    // Doc state mirrors what the unreject route leaves behind: the row
    // itself has no rejection state, but the audit trail remembers it.
    const docId = await insertDoc({});

    const rejectAt = new Date("2026-01-10T09:00:00Z");
    const withdrawAt = new Date("2026-01-12T15:30:00Z");

    // Original reject — recorded as a plain "rejected: ..." audit row.
    await insertAudit({
      docId,
      actorUserId: originalRejecterUserId,
      action: "update",
      reason: "rejected: blurry scan",
      createdAt: rejectAt,
    });
    // Withdrawal — structured metadata path.
    await insertAudit({
      docId,
      actorUserId: withdrawerUserId,
      action: "update",
      reason: "rejection withdrawn — previous reason: blurry scan — note: operator error",
      metadata: {
        kind: "rejection_withdrawn",
        previousReason: "blurry scan",
        previousRejectedByUserId: originalRejecterUserId,
        previousRejectedAt: rejectAt.toISOString(),
        note: "operator error",
      },
      createdAt: withdrawAt,
    });

    const res = await request(app).get(URL(memberId));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const doc = res.body.find((d: { id: number }) => d.id === docId);
    expect(doc).toBeDefined();
    expect(doc.isRejected).toBe(false);
    expect(doc.withdrawnRejection).toBeTruthy();

    const w = doc.withdrawnRejection;
    expect(w.previousReason).toBe("blurry scan");
    expect(w.previousRejectedByUserId).toBe(originalRejecterUserId);
    expect(w.previousRejectedByName).toBe("Original Rejecter");
    expect(w.previousRejectedAt).toBe(rejectAt.toISOString());
    expect(w.withdrawnByUserId).toBe(withdrawerUserId);
    expect(w.withdrawnByName).toBe("Withdrawing Admin");
    expect(w.withdrawnAt).toBe(withdrawAt.toISOString());
    expect(w.withdrawalNote).toBe("operator error");
  });
});

describe("GET /:memberId/documents — withdrawnRejection suppression", () => {
  it("suppresses the indicator once the doc is verified after the withdrawal", async () => {
    const app = createTestApp(admin);
    // Doc is now verified; withdrawal happened earlier.
    const docId = await insertDoc({ isVerified: true });

    await insertAudit({
      docId,
      actorUserId: originalRejecterUserId,
      reason: "rejected: needs colour scan",
      createdAt: new Date("2026-02-01T08:00:00Z"),
    });
    await insertAudit({
      docId,
      actorUserId: withdrawerUserId,
      reason: "rejection withdrawn",
      metadata: {
        kind: "rejection_withdrawn",
        previousReason: "needs colour scan",
        previousRejectedByUserId: originalRejecterUserId,
        previousRejectedAt: new Date("2026-02-01T08:00:00Z").toISOString(),
        note: null,
      },
      createdAt: new Date("2026-02-02T08:00:00Z"),
    });
    // Verify happened *after* the withdrawal — must suppress the note.
    await insertAudit({
      docId,
      actorUserId: adminUserId,
      reason: "verified",
      createdAt: new Date("2026-02-03T08:00:00Z"),
    });

    const res = await request(app).get(URL(memberId));
    expect(res.status).toBe(200);
    const doc = res.body.find((d: { id: number }) => d.id === docId);
    expect(doc).toBeDefined();
    expect(doc.withdrawnRejection).toBeNull();
  });

  it("suppresses the indicator once the doc is re-rejected after the withdrawal", async () => {
    const app = createTestApp(admin);
    // Doc was withdrawn, then re-rejected — current row reflects rejection.
    const reRejectAt = new Date("2026-03-05T12:00:00Z");
    const docId = await insertDoc({
      isRejected: true,
      rejectionReason: "still blurry — second look",
      rejectedByUserId: originalRejecterUserId,
      rejectedAt: reRejectAt,
    });

    await insertAudit({
      docId,
      actorUserId: originalRejecterUserId,
      reason: "rejected: blurry scan",
      createdAt: new Date("2026-03-01T10:00:00Z"),
    });
    await insertAudit({
      docId,
      actorUserId: withdrawerUserId,
      reason: "rejection withdrawn",
      metadata: {
        kind: "rejection_withdrawn",
        previousReason: "blurry scan",
        previousRejectedByUserId: originalRejecterUserId,
        previousRejectedAt: new Date("2026-03-01T10:00:00Z").toISOString(),
        note: null,
      },
      createdAt: new Date("2026-03-03T10:00:00Z"),
    });
    // Re-reject — newest audit row, must shadow the withdrawal indicator.
    await insertAudit({
      docId,
      actorUserId: originalRejecterUserId,
      reason: "rejected: still blurry — second look",
      createdAt: reRejectAt,
    });

    const res = await request(app).get(URL(memberId));
    expect(res.status).toBe(200);
    const doc = res.body.find((d: { id: number }) => d.id === docId);
    expect(doc).toBeDefined();
    expect(doc.isRejected).toBe(true);
    expect(doc.withdrawnRejection).toBeNull();
  });
});

describe("GET /:memberId/documents — legacy reason-string fallback", () => {
  it("parses the legacy withdrawal reason text when the audit row has no metadata", async () => {
    const app = createTestApp(admin);
    const docId = await insertDoc({});

    const rejectAt = new Date("2025-11-10T09:00:00Z");
    const withdrawAt = new Date("2025-11-12T15:30:00Z");

    // Legacy withdrawal: only the formatted `reason` string is present —
    // metadata is null, mimicking pre-Task-329 audit rows. The fallback
    // parser inside the listing endpoint must still extract the previous
    // rejecter id, the previous-rejected timestamp, the previous reason,
    // and the optional note.
    await insertAudit({
      docId,
      actorUserId: withdrawerUserId,
      reason:
        "rejection withdrawn — previous reason: blurry scan" +
        ` — previously rejected by user #${originalRejecterUserId}` +
        ` — previously rejected at ${rejectAt.toISOString()}` +
        " — note: operator error",
      metadata: null,
      createdAt: withdrawAt,
    });

    const res = await request(app).get(URL(memberId));
    expect(res.status).toBe(200);
    const doc = res.body.find((d: { id: number }) => d.id === docId);
    expect(doc).toBeDefined();
    expect(doc.withdrawnRejection).toBeTruthy();

    const w = doc.withdrawnRejection;
    expect(w.previousReason).toBe("blurry scan");
    expect(w.previousRejectedByUserId).toBe(originalRejecterUserId);
    expect(w.previousRejectedByName).toBe("Original Rejecter");
    expect(w.previousRejectedAt).toBe(rejectAt.toISOString());
    expect(w.withdrawnByUserId).toBe(withdrawerUserId);
    expect(w.withdrawnByName).toBe("Withdrawing Admin");
    expect(w.withdrawnAt).toBe(withdrawAt.toISOString());
    expect(w.withdrawalNote).toBe("operator error");
  });
});
