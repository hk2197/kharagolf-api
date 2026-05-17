/**
 * Integration test: Renaming a saved segment (Task #643).
 *
 * Covers PATCH /api/organizations/:orgId/members-360/saved-segments/:id:
 *   - Successful rename updates the row and records an audit-log entry.
 *   - 409 when the new name collides (case-insensitive, whitespace-trimmed)
 *     with another segment in the same org.
 *   - The same name is allowed in a different org (uniqueness is org-scoped).
 *   - 404 when the segment belongs to another org.
 *   - 404 when the segment belongs to another owner inside the same org.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  memberSavedSegmentsTable,
  memberAuditLogTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgAId: number;
let orgBId: number;
let adminAUserId: number;
let adminBUserId: number;
let adminA2UserId: number;
let adminA: TestUser;
let adminB: TestUser;
let adminA2: TestUser;
const segmentIds: number[] = [];

beforeAll(async () => {
  const stamp = Date.now();

  const [orgA] = await db.insert(organizationsTable).values({
    name: `TestOrg_SegRenameA_${stamp}`,
    slug: `test-seg-rename-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `TestOrg_SegRenameB_${stamp}`,
    slug: `test-seg-rename-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [aRow] = await db.insert(appUsersTable).values({
    replitUserId: `seg-rename-admin-a-${stamp}`,
    username: `seg_rename_admin_a_${stamp}`,
    email: `seg_rename_admin_a_${stamp}@example.com`,
    displayName: "Seg Rename Admin A",
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminAUserId = aRow.id;

  const [a2Row] = await db.insert(appUsersTable).values({
    replitUserId: `seg-rename-admin-a2-${stamp}`,
    username: `seg_rename_admin_a2_${stamp}`,
    email: `seg_rename_admin_a2_${stamp}@example.com`,
    displayName: "Seg Rename Admin A2",
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminA2UserId = a2Row.id;

  const [bRow] = await db.insert(appUsersTable).values({
    replitUserId: `seg-rename-admin-b-${stamp}`,
    username: `seg_rename_admin_b_${stamp}`,
    email: `seg_rename_admin_b_${stamp}@example.com`,
    displayName: "Seg Rename Admin B",
    role: "org_admin",
    organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  adminBUserId = bRow.id;

  adminA = {
    id: adminAUserId,
    username: `seg_rename_admin_a_${stamp}`,
    displayName: "Seg Rename Admin A",
    role: "org_admin",
    organizationId: orgAId,
  };
  adminA2 = {
    id: adminA2UserId,
    username: `seg_rename_admin_a2_${stamp}`,
    displayName: "Seg Rename Admin A2",
    role: "org_admin",
    organizationId: orgAId,
  };
  adminB = {
    id: adminBUserId,
    username: `seg_rename_admin_b_${stamp}`,
    displayName: "Seg Rename Admin B",
    role: "org_admin",
    organizationId: orgBId,
  };
});

afterAll(async () => {
  if (segmentIds.length) {
    await db.delete(memberAuditLogTable).where(and(
      eq(memberAuditLogTable.entity, "saved_segment"),
      inArray(memberAuditLogTable.entityId, segmentIds),
    ));
    await db.delete(memberSavedSegmentsTable).where(inArray(memberSavedSegmentsTable.id, segmentIds));
  }
  if (adminAUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, adminAUserId));
  if (adminA2UserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, adminA2UserId));
  if (adminBUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, adminBUserId));
  if (orgAId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgAId));
  if (orgBId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgBId));
});

async function createSegment(opts: {
  user: TestUser;
  orgId: number;
  name: string;
  filters?: unknown;
  isShared?: boolean;
}): Promise<number> {
  const app = createTestApp(opts.user);
  const res = await request(app)
    .post(`/api/organizations/${opts.orgId}/members-360/saved-segments`)
    .send({
      name: opts.name,
      filters: opts.filters ?? { status: "active" },
      isShared: opts.isShared ?? false,
    });
  expect(res.status).toBe(201);
  segmentIds.push(res.body.id);
  return res.body.id as number;
}

describe("PATCH /saved-segments/:id — rename", () => {
  it("renames a segment and records an audit-log entry", async () => {
    const original = `Original cohort ${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const renamed = `Renamed cohort ${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const id = await createSegment({ user: adminA, orgId: orgAId, name: original });

    const app = createTestApp(adminA);
    const res = await request(app)
      .patch(`/api/organizations/${orgAId}/members-360/saved-segments/${id}`)
      .send({ name: renamed });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.name).toBe(renamed);

    // The row in the DB reflects the new name.
    const [row] = await db.select().from(memberSavedSegmentsTable)
      .where(eq(memberSavedSegmentsTable.id, id)).limit(1);
    expect(row.name).toBe(renamed);

    // An audit-log entry was recorded for the rename.
    const audits = await db.select().from(memberAuditLogTable).where(and(
      eq(memberAuditLogTable.organizationId, orgAId),
      eq(memberAuditLogTable.entity, "saved_segment"),
      eq(memberAuditLogTable.entityId, id),
      eq(memberAuditLogTable.action, "update"),
    ));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const renameAudit = audits.find(a => (a.reason ?? "").includes("renamed"));
    expect(renameAudit).toBeDefined();
    expect(renameAudit!.actorUserId).toBe(adminAUserId);
    expect(renameAudit!.reason).toContain(original);
    expect(renameAudit!.reason).toContain(renamed);
  });

  it("trims whitespace on the new name", async () => {
    const original = `Trim me ${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const id = await createSegment({ user: adminA, orgId: orgAId, name: original });
    const newName = `Trimmed ${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const app = createTestApp(adminA);
    const res = await request(app)
      .patch(`/api/organizations/${orgAId}/members-360/saved-segments/${id}`)
      .send({ name: `   ${newName}   ` });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(newName);
  });

  it("rejects a rename that case-insensitively duplicates another segment in the same org", async () => {
    const existingName = `Existing seg ${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const otherName = `Other seg ${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await createSegment({ user: adminA, orgId: orgAId, name: existingName });
    const otherId = await createSegment({ user: adminA, orgId: orgAId, name: otherName });

    const app = createTestApp(adminA);
    const res = await request(app)
      .patch(`/api/organizations/${orgAId}/members-360/saved-segments/${otherId}`)
      .send({ name: `  ${existingName.toUpperCase()}  ` });
    expect(res.status).toBe(409);
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error).toMatch(/already exists/i);

    // The conflicted attempt did not change the row.
    const [row] = await db.select().from(memberSavedSegmentsTable)
      .where(eq(memberSavedSegmentsTable.id, otherId)).limit(1);
    expect(row.name).toBe(otherName);
  });

  it("allows renaming to a name that exists in a different org", async () => {
    const sharedName = `CrossOrg cohort ${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    // Same name already exists in org A.
    await createSegment({ user: adminA, orgId: orgAId, name: sharedName });
    // A segment in org B that we'll rename to the same name.
    const placeholder = `Placeholder ${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const idInB = await createSegment({ user: adminB, orgId: orgBId, name: placeholder });

    const app = createTestApp(adminB);
    const res = await request(app)
      .patch(`/api/organizations/${orgBId}/members-360/saved-segments/${idInB}`)
      .send({ name: sharedName });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(sharedName);
    expect(res.body.organizationId).toBe(orgBId);
  });

  it("returns 404 when the segment belongs to another org", async () => {
    const name = `OrgScoped ${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const idInA = await createSegment({ user: adminA, orgId: orgAId, name });

    // Admin B tries to rename a segment that lives in org A by hitting the org B URL.
    const app = createTestApp(adminB);
    const res = await request(app)
      .patch(`/api/organizations/${orgBId}/members-360/saved-segments/${idInA}`)
      .send({ name: `${name}-renamed` });
    expect(res.status).toBe(404);

    // The original name is unchanged.
    const [row] = await db.select().from(memberSavedSegmentsTable)
      .where(eq(memberSavedSegmentsTable.id, idInA)).limit(1);
    expect(row.name).toBe(name);
  });

  it("returns 404 when the segment belongs to another owner in the same org", async () => {
    const name = `OwnerScoped ${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const idOwnedByA = await createSegment({ user: adminA, orgId: orgAId, name });

    // Admin A2 is in the same org but is not the owner.
    const app = createTestApp(adminA2);
    const res = await request(app)
      .patch(`/api/organizations/${orgAId}/members-360/saved-segments/${idOwnedByA}`)
      .send({ name: `${name}-renamed` });
    expect(res.status).toBe(404);

    // The original name is unchanged.
    const [row] = await db.select().from(memberSavedSegmentsTable)
      .where(eq(memberSavedSegmentsTable.id, idOwnedByA)).limit(1);
    expect(row.name).toBe(name);
  });
});
