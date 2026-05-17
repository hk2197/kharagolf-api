/**
 * Task #1959 — GET/PUT /api/organizations/:orgId/analytics/events/categories/order
 *
 * Pins the contract for the per-org category display ordering used
 * across the admin analytics dashboard (Customize tab, totals tiles,
 * chart legend, filter dropdown).
 *
 * Behaviours that matter and are tested here:
 *   • Auth gating — unauthenticated 401, non-admin 403, cross-tenant
 *     org_admin 403, super_admin allowed in any org.
 *   • PUT replace-all semantics — submitting [A, B, C] then [C, A]
 *     leaves exactly two rows (C@0, A@1); B is fully cleared.
 *   • Validation — non-array body 400, non-string entries 400,
 *     duplicate entries 400, oversized names 400, "Uncategorized"
 *     silently dropped (always pinned last by the dashboard).
 *   • GET returns the saved order in position order (not insert order).
 *   • Tenancy — orgA's order does not leak into orgB's response.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  organizationsTable,
  appUsersTable,
  analyticsEventCategoryOrderTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "../../tests/helpers.js";

let orgAId: number;
let orgBId: number;
let adminAId: number;
let adminBId: number;
let playerAId: number;
let superAdminId: number;

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [orgA] = await db.insert(organizationsTable).values({
    name: `T1959_A_${stamp}`, slug: `t1959-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `T1959_B_${stamp}`, slug: `t1959-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [adminA] = await db.insert(appUsersTable).values({
    replitUserId: `t1959-admin-a-${stamp}`,
    username: `t1959_admin_a_${stamp}`,
    email: `admin_a_${stamp}@t1959.test`,
    role: "org_admin", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminAId = adminA.id;

  const [adminB] = await db.insert(appUsersTable).values({
    replitUserId: `t1959-admin-b-${stamp}`,
    username: `t1959_admin_b_${stamp}`,
    email: `admin_b_${stamp}@t1959.test`,
    role: "org_admin", organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  adminBId = adminB.id;

  const [playerA] = await db.insert(appUsersTable).values({
    replitUserId: `t1959-player-a-${stamp}`,
    username: `t1959_player_a_${stamp}`,
    email: `player_a_${stamp}@t1959.test`,
    role: "player", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  playerAId = playerA.id;

  const [superUser] = await db.insert(appUsersTable).values({
    replitUserId: `t1959-super-${stamp}`,
    username: `t1959_super_${stamp}`,
    email: `super_${stamp}@t1959.test`,
    role: "super_admin", organizationId: null,
  }).returning({ id: appUsersTable.id });
  superAdminId = superUser.id;
});

afterAll(async () => {
  // Wipe every order row we may have written for either test org.
  const orgs = [orgAId, orgBId].filter((v): v is number => typeof v === "number");
  if (orgs.length) {
    await db.delete(analyticsEventCategoryOrderTable).where(
      inArray(analyticsEventCategoryOrderTable.organizationId, orgs),
    );
  }
  const allUsers = [adminAId, adminBId, playerAId, superAdminId]
    .filter((v): v is number => typeof v === "number");
  if (allUsers.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, allUsers));
  }
  if (orgAId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgAId));
  if (orgBId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgBId));
});

function asUser(id: number, role: string, organizationId: number | null): TestUser {
  const u: TestUser = { id, username: `u${id}`, role };
  if (organizationId != null) u.organizationId = organizationId;
  return u;
}

function orderUrl(orgId: number): string {
  return `/api/organizations/${orgId}/analytics/events/categories/order`;
}

describe("/analytics/events/categories/order — auth gating", () => {
  it("returns 401 on GET when unauthenticated", async () => {
    const res = await request(createTestApp()).get(orderUrl(orgAId));
    expect(res.status).toBe(401);
  });

  it("returns 401 on PUT when unauthenticated", async () => {
    const res = await request(createTestApp())
      .put(orderUrl(orgAId)).send({ order: ["X"] });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a player on GET", async () => {
    const res = await request(createTestApp(asUser(playerAId, "player", orgAId)))
      .get(orderUrl(orgAId));
    expect(res.status).toBe(403);
  });

  it("returns 403 when an org_admin tries to read another org's order", async () => {
    const res = await request(createTestApp(asUser(adminBId, "org_admin", orgBId)))
      .get(orderUrl(orgAId));
    expect(res.status).toBe(403);
  });

  it("returns 403 when an org_admin tries to write another org's order", async () => {
    const res = await request(createTestApp(asUser(adminBId, "org_admin", orgBId)))
      .put(orderUrl(orgAId)).send({ order: ["Hacked"] });
    expect(res.status).toBe(403);

    // Nothing got written into orgA.
    const rows = await db.select().from(analyticsEventCategoryOrderTable)
      .where(eq(analyticsEventCategoryOrderTable.organizationId, orgAId));
    expect(rows.find((r) => r.category === "Hacked")).toBeUndefined();
  });

  it("allows a super_admin to read any org's order", async () => {
    const res = await request(createTestApp(asUser(superAdminId, "super_admin", null)))
      .get(orderUrl(orgAId));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.order)).toBe(true);
  });
});

describe("PUT /analytics/events/categories/order — replace-all semantics", () => {
  it("persists the supplied order and reads it back in position order", async () => {
    const app = createTestApp(asUser(adminAId, "org_admin", orgAId));
    const put = await request(app).put(orderUrl(orgAId))
      .send({ order: ["Bookings", "Marketing", "Engagement"] });
    expect(put.status).toBe(200);
    expect(put.body.order).toEqual(["Bookings", "Marketing", "Engagement"]);

    const get = await request(app).get(orderUrl(orgAId));
    expect(get.status).toBe(200);
    expect(get.body.order).toEqual(["Bookings", "Marketing", "Engagement"]);
  });

  it("replaces (not merges) the saved order on a follow-up PUT", async () => {
    const app = createTestApp(asUser(adminAId, "org_admin", orgAId));
    await request(app).put(orderUrl(orgAId))
      .send({ order: ["Alpha", "Beta", "Gamma"] }).expect(200);
    await request(app).put(orderUrl(orgAId))
      .send({ order: ["Gamma", "Alpha"] }).expect(200);

    const rows = await db.select().from(analyticsEventCategoryOrderTable)
      .where(eq(analyticsEventCategoryOrderTable.organizationId, orgAId))
      .orderBy(analyticsEventCategoryOrderTable.position);
    expect(rows.map((r) => r.category)).toEqual(["Gamma", "Alpha"]);
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
  });

  it("silently drops the implicit 'Uncategorized' bucket from the saved order", async () => {
    const app = createTestApp(asUser(adminAId, "org_admin", orgAId));
    const put = await request(app).put(orderUrl(orgAId))
      .send({ order: ["Bookings", "Uncategorized", "Marketing"] });
    expect(put.status).toBe(200);
    expect(put.body.order).toEqual(["Bookings", "Marketing"]);
  });

  it("rejects a non-array body with 400", async () => {
    const app = createTestApp(asUser(adminAId, "org_admin", orgAId));
    const res = await request(app).put(orderUrl(orgAId)).send({ order: "Bookings" });
    expect(res.status).toBe(400);
  });

  it("rejects non-string entries with 400", async () => {
    const app = createTestApp(asUser(adminAId, "org_admin", orgAId));
    const res = await request(app).put(orderUrl(orgAId)).send({ order: ["A", 42] });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate categories with 400", async () => {
    const app = createTestApp(asUser(adminAId, "org_admin", orgAId));
    const res = await request(app).put(orderUrl(orgAId))
      .send({ order: ["Bookings", "Bookings"] });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/duplicate/i);
  });

  it("rejects an oversized category name with 400", async () => {
    const app = createTestApp(asUser(adminAId, "org_admin", orgAId));
    const res = await request(app).put(orderUrl(orgAId))
      .send({ order: ["X".repeat(65)] });
    expect(res.status).toBe(400);
  });

  it("clears the saved order when an empty array is submitted", async () => {
    const app = createTestApp(asUser(adminAId, "org_admin", orgAId));
    await request(app).put(orderUrl(orgAId))
      .send({ order: ["KeepMe"] }).expect(200);
    const cleared = await request(app).put(orderUrl(orgAId)).send({ order: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.order).toEqual([]);

    const rows = await db.select().from(analyticsEventCategoryOrderTable)
      .where(eq(analyticsEventCategoryOrderTable.organizationId, orgAId));
    expect(rows).toHaveLength(0);
  });

  it("does not leak orgA's order into orgB", async () => {
    const appA = createTestApp(asUser(adminAId, "org_admin", orgAId));
    const appB = createTestApp(asUser(adminBId, "org_admin", orgBId));

    await request(appA).put(orderUrl(orgAId))
      .send({ order: ["OrgAOnly1", "OrgAOnly2"] }).expect(200);

    const orgBOrder = await request(appB).get(orderUrl(orgBId));
    expect(orgBOrder.status).toBe(200);
    expect(orgBOrder.body.order).not.toContain("OrgAOnly1");
    expect(orgBOrder.body.order).not.toContain("OrgAOnly2");
  });
});
