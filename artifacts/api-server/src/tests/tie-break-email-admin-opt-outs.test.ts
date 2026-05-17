/**
 * Task #1208 — admins can see who in their org has opted out of the
 * round-robin tie-break alert email and re-subscribe them on their behalf.
 *
 * Coverage (mirrors the bounced-digest schedule-change opt-out admin test):
 *   - GET /api/organizations/:orgId/tie-break-email-opt-outs lists opted-out
 *     recipients for an org_admin caller and is gated by the same RBAC as
 *     the rest of the tournament-admin surfaces (401 unauth, 403 non-admin).
 *   - DELETE /api/organizations/:orgId/tie-break-email-opt-outs/:userId
 *     re-subscribes a member, is idempotent, and is gated the same way.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgRoleEnum,
  roundRobinTieBreakEmailOptOutsTable,
} from "@workspace/db";
import { inArray, eq, and } from "drizzle-orm";

import { createTestApp, type TestUser, uid } from "./helpers.js";

type OrgRole = (typeof orgRoleEnum.enumValues)[number];

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];

beforeAll(() => {
  if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = "test-session-secret-for-tie-break-admin-opt-outs";
});

async function makeOrg(label: string): Promise<number> {
  const tag = uid(label);
  const [o] = await db.insert(organizationsTable).values({
    name: `TBAdmin_${tag}`,
    slug: `tbadmin-${tag}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(o.id);
  return o.id;
}

async function makeUser(orgId: number | null, role: OrgRole): Promise<TestUser> {
  const tag = uid(role);
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: tag,
    username: tag,
    email: `${tag}@test.local`,
    displayName: role,
    role,
    organizationId: (role === "org_admin" || role === "tournament_director") ? orgId : null,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return {
    id: u.id,
    username: tag,
    displayName: role,
    role,
    organizationId: (role === "org_admin" || role === "tournament_director") ? (orgId ?? undefined) : undefined,
  };
}

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(roundRobinTieBreakEmailOptOutsTable).where(inArray(roundRobinTieBreakEmailOptOutsTable.userId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

describe("GET /api/organizations/:orgId/tie-break-email-opt-outs (Task #1208)", () => {
  it("lists opted-out recipients for an org_admin caller", async () => {
    const orgId = await makeOrg("list_admin");
    const admin = await makeUser(orgId, "org_admin");
    const director = await makeUser(orgId, "player");
    await db.insert(roundRobinTieBreakEmailOptOutsTable).values({
      organizationId: orgId,
      userId: director.id,
    });

    const res = await request(createTestApp(admin))
      .get(`/api/organizations/${orgId}/tie-break-email-opt-outs`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      userId: director.id,
      email: expect.stringContaining("@test.local"),
    });
    expect(typeof res.body[0].displayName).toBe("string");
    expect(typeof res.body[0].optedOutAt).toBe("string");
  });

  it("is also accessible to tournament_director callers", async () => {
    const orgId = await makeOrg("list_td");
    const td = await makeUser(orgId, "tournament_director");
    const director = await makeUser(orgId, "player");
    await db.insert(roundRobinTieBreakEmailOptOutsTable).values({
      organizationId: orgId,
      userId: director.id,
    });

    const res = await request(createTestApp(td))
      .get(`/api/organizations/${orgId}/tie-break-email-opt-outs`)
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].userId).toBe(director.id);
  });

  it("rejects unauthenticated and non-admin callers", async () => {
    const orgId = await makeOrg("list_authz");
    await request(createTestApp())
      .get(`/api/organizations/${orgId}/tie-break-email-opt-outs`)
      .expect(401);

    const player = await makeUser(orgId, "player");
    await request(createTestApp(player))
      .get(`/api/organizations/${orgId}/tie-break-email-opt-outs`)
      .expect(403);
  });

  it("scopes results to the requested org", async () => {
    const orgA = await makeOrg("scope_a");
    const orgB = await makeOrg("scope_b");
    const adminA = await makeUser(orgA, "org_admin");
    const directorA = await makeUser(orgA, "player");
    const directorB = await makeUser(orgB, "player");
    await db.insert(roundRobinTieBreakEmailOptOutsTable).values([
      { organizationId: orgA, userId: directorA.id },
      { organizationId: orgB, userId: directorB.id },
    ]);

    const res = await request(createTestApp(adminA))
      .get(`/api/organizations/${orgA}/tie-break-email-opt-outs`)
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].userId).toBe(directorA.id);
  });
});

describe("DELETE /api/organizations/:orgId/tie-break-email-opt-outs/:userId (Task #1208)", () => {
  it("lets an org_admin re-subscribe a member and is idempotent", async () => {
    const orgId = await makeOrg("admin_resub");
    const admin = await makeUser(orgId, "org_admin");
    const director = await makeUser(orgId, "player");
    await db.insert(roundRobinTieBreakEmailOptOutsTable).values({
      organizationId: orgId,
      userId: director.id,
    });

    await request(createTestApp(admin))
      .delete(`/api/organizations/${orgId}/tie-break-email-opt-outs/${director.id}`)
      .expect(204);

    const rows = await db
      .select()
      .from(roundRobinTieBreakEmailOptOutsTable)
      .where(and(
        eq(roundRobinTieBreakEmailOptOutsTable.organizationId, orgId),
        eq(roundRobinTieBreakEmailOptOutsTable.userId, director.id),
      ));
    expect(rows).toHaveLength(0);

    // Idempotent — deleting again is still 204 even though no row remains.
    await request(createTestApp(admin))
      .delete(`/api/organizations/${orgId}/tie-break-email-opt-outs/${director.id}`)
      .expect(204);
  });

  it("rejects unauthenticated and non-admin callers and leaves the row intact", async () => {
    const orgId = await makeOrg("admin_resub_authz");
    const director = await makeUser(orgId, "player");
    await db.insert(roundRobinTieBreakEmailOptOutsTable).values({
      organizationId: orgId,
      userId: director.id,
    });

    await request(createTestApp())
      .delete(`/api/organizations/${orgId}/tie-break-email-opt-outs/${director.id}`)
      .expect(401);

    const player = await makeUser(orgId, "player");
    await request(createTestApp(player))
      .delete(`/api/organizations/${orgId}/tie-break-email-opt-outs/${director.id}`)
      .expect(403);

    const rows = await db
      .select()
      .from(roundRobinTieBreakEmailOptOutsTable)
      .where(and(
        eq(roundRobinTieBreakEmailOptOutsTable.organizationId, orgId),
        eq(roundRobinTieBreakEmailOptOutsTable.userId, director.id),
      ));
    expect(rows).toHaveLength(1);
  });

  it("does not touch opt-outs in other organizations", async () => {
    const orgA = await makeOrg("scope_del_a");
    const orgB = await makeOrg("scope_del_b");
    const adminA = await makeUser(orgA, "org_admin");
    const director = await makeUser(orgA, "player");
    // Same user opted out of two orgs (e.g. a director who manages multiple).
    await db.insert(roundRobinTieBreakEmailOptOutsTable).values([
      { organizationId: orgA, userId: director.id },
      { organizationId: orgB, userId: director.id },
    ]);

    await request(createTestApp(adminA))
      .delete(`/api/organizations/${orgA}/tie-break-email-opt-outs/${director.id}`)
      .expect(204);

    const remaining = await db
      .select()
      .from(roundRobinTieBreakEmailOptOutsTable)
      .where(eq(roundRobinTieBreakEmailOptOutsTable.userId, director.id));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].organizationId).toBe(orgB);
  });
});
