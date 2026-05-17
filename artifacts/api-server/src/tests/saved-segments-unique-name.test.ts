/**
 * Integration test: Saved segment names must be unique per org (Task #388).
 *
 * Covers POST /api/organizations/:orgId/members-360/saved-segments:
 *   - A duplicate name (case-insensitive, whitespace-trimmed) within the
 *     same org returns HTTP 409 with a user-readable error message that
 *     the dialog can surface as a toast.
 *   - The same name in a *different* org is allowed (uniqueness is scoped
 *     to organizationId).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  memberSavedSegmentsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgAId: number;
let orgBId: number;
let adminAUserId: number;
let adminBUserId: number;
let adminA: TestUser;
let adminB: TestUser;
const segmentIds: number[] = [];

beforeAll(async () => {
  const stamp = Date.now();

  const [orgA] = await db.insert(organizationsTable).values({
    name: `TestOrg_SegUniqueA_${stamp}`,
    slug: `test-seg-unique-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `TestOrg_SegUniqueB_${stamp}`,
    slug: `test-seg-unique-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [aRow] = await db.insert(appUsersTable).values({
    replitUserId: `seg-unique-admin-a-${stamp}`,
    username: `seg_unique_admin_a_${stamp}`,
    email: `seg_unique_admin_a_${stamp}@example.com`,
    displayName: "Seg Unique Admin A",
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminAUserId = aRow.id;

  const [bRow] = await db.insert(appUsersTable).values({
    replitUserId: `seg-unique-admin-b-${stamp}`,
    username: `seg_unique_admin_b_${stamp}`,
    email: `seg_unique_admin_b_${stamp}@example.com`,
    displayName: "Seg Unique Admin B",
    role: "org_admin",
    organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  adminBUserId = bRow.id;

  adminA = {
    id: adminAUserId,
    username: `seg_unique_admin_a_${stamp}`,
    displayName: "Seg Unique Admin A",
    role: "org_admin",
    organizationId: orgAId,
  };
  adminB = {
    id: adminBUserId,
    username: `seg_unique_admin_b_${stamp}`,
    displayName: "Seg Unique Admin B",
    role: "org_admin",
    organizationId: orgBId,
  };
});

afterAll(async () => {
  if (segmentIds.length) {
    await db.delete(memberSavedSegmentsTable).where(inArray(memberSavedSegmentsTable.id, segmentIds));
  }
  if (adminAUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, adminAUserId));
  if (adminBUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, adminBUserId));
  if (orgAId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgAId));
  if (orgBId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgBId));
});

describe("POST /saved-segments — name uniqueness per org", () => {
  it("rejects a duplicate name in the same org with a user-readable 409 error", async () => {
    const app = createTestApp(adminA);
    const name = `Winter freeze cohort ${Date.now()}`;
    const filters = { status: "active" };

    const first = await request(app)
      .post(`/api/organizations/${orgAId}/members-360/saved-segments`)
      .send({ name, filters, isShared: false });
    expect(first.status).toBe(201);
    expect(first.body.id).toBeTypeOf("number");
    segmentIds.push(first.body.id);

    // Exact duplicate
    const dup = await request(app)
      .post(`/api/organizations/${orgAId}/members-360/saved-segments`)
      .send({ name, filters, isShared: false });
    expect(dup.status).toBe(409);
    expect(typeof dup.body.error).toBe("string");
    expect(dup.body.error).toMatch(/already exists/i);
    expect(dup.body.error).toContain(name);

    // Case-insensitive + whitespace-trimmed duplicate
    const fuzzyDup = await request(app)
      .post(`/api/organizations/${orgAId}/members-360/saved-segments`)
      .send({ name: `  ${name.toUpperCase()}  `, filters, isShared: false });
    expect(fuzzyDup.status).toBe(409);
    expect(fuzzyDup.body.error).toMatch(/already exists/i);

    // No phantom row was inserted by the rejected attempts.
    const rows = await db.select({ id: memberSavedSegmentsTable.id })
      .from(memberSavedSegmentsTable)
      .where(eq(memberSavedSegmentsTable.organizationId, orgAId));
    expect(rows.length).toBe(1);
  });

  it("allows the same segment name in a different org", async () => {
    const sharedName = `VIP cohort ${Date.now()}`;
    const filters = { tier: "gold" };

    const appA = createTestApp(adminA);
    const inA = await request(appA)
      .post(`/api/organizations/${orgAId}/members-360/saved-segments`)
      .send({ name: sharedName, filters, isShared: false });
    expect(inA.status).toBe(201);
    segmentIds.push(inA.body.id);

    const appB = createTestApp(adminB);
    const inB = await request(appB)
      .post(`/api/organizations/${orgBId}/members-360/saved-segments`)
      .send({ name: sharedName, filters, isShared: false });
    expect(inB.status).toBe(201);
    expect(inB.body.organizationId).toBe(orgBId);
    expect(inB.body.name).toBe(sharedName);
    segmentIds.push(inB.body.id);
  });
});
