/**
 * Integration tests for the profile-share leaderboard admin endpoint
 * (Task #786):
 *
 *   GET /api/organizations/:orgId/analytics/profile-share-leaderboard
 *     - 401 when unauthenticated
 *     - 403 when caller is not an org admin
 *     - 200 for org_admin: aggregates events for org members only,
 *       sorts by total desc, breaks down by method, exposes org totals,
 *       and respects the `limit` query param
 *     - excludes events from other organizations
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  profileShareEventsTable,
  orgRoleEnum,
} from "@workspace/db";

type OrgRole = (typeof orgRoleEnum.enumValues)[number];
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser, uid } from "./helpers.js";

let orgId: number;
let otherOrgId: number;
let adminUser: TestUser;
let strangerUser: TestUser;
let memberAId: number;
let memberBId: number;
let memberCId: number;
let outsiderId: number;
let adminId: number;
let strangerId: number;

const tag = uid("pshare-lb");

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `LB Org ${tag}`,
    slug: `lb-org-${tag}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [otherOrg] = await db.insert(organizationsTable).values({
    name: `LB Other ${tag}`,
    slug: `lb-other-${tag}`,
  }).returning({ id: organizationsTable.id });
  otherOrgId = otherOrg.id;

  async function mkUser(suffix: string, opts: {
    role?: OrgRole;
    orgId?: number;
    handle?: string;
  } = {}) {
    const [u] = await db.insert(appUsersTable).values({
      replitUserId: `${tag}-${suffix}`,
      username: `${tag}_${suffix}`,
      email: `${tag}_${suffix}@example.com`,
      displayName: `User ${suffix}`,
      role: opts.role ?? "player",
      organizationId: opts.orgId ?? orgId,
      publicHandle: opts.handle ?? null,
      publicProfileEnabled: !!opts.handle,
    }).returning({ id: appUsersTable.id });
    return u.id;
  }

  adminId = await mkUser("admin", { role: "org_admin" });
  strangerId = await mkUser("stranger", { role: "player" });
  memberAId = await mkUser("a", { handle: `${tag}-a` });
  memberBId = await mkUser("b", { handle: `${tag}-b` });
  memberCId = await mkUser("c", { handle: `${tag}-c` });
  outsiderId = await mkUser("outsider", { orgId: otherOrgId, handle: `${tag}-out` });

  adminUser = { id: adminId, username: `${tag}_admin`, role: "org_admin", organizationId: orgId };
  strangerUser = { id: strangerId, username: `${tag}_stranger`, role: "player", organizationId: orgId };

  // Seed events:
  // memberA: 3 copy + 2 native_share = 5 total
  // memberB: 1 copy + 4 qr_open + 1 web_share = 6 total
  // memberC: 1 copy = 1 total
  // outsider: 99 copy (other org, must be excluded)
  const rows: Array<{
    userId: number;
    handle: string;
    method: "copy" | "web_share" | "native_share" | "qr_open";
  }> = [];
  for (let i = 0; i < 3; i++) rows.push({ userId: memberAId, handle: `${tag}-a`, method: "copy" });
  for (let i = 0; i < 2; i++) rows.push({ userId: memberAId, handle: `${tag}-a`, method: "native_share" });
  rows.push({ userId: memberBId, handle: `${tag}-b`, method: "copy" });
  for (let i = 0; i < 4; i++) rows.push({ userId: memberBId, handle: `${tag}-b`, method: "qr_open" });
  rows.push({ userId: memberBId, handle: `${tag}-b`, method: "web_share" });
  rows.push({ userId: memberCId, handle: `${tag}-c`, method: "copy" });
  for (let i = 0; i < 99; i++) rows.push({ userId: outsiderId, handle: `${tag}-out`, method: "copy" });
  await db.insert(profileShareEventsTable).values(rows);
});

afterAll(async () => {
  const allUserIds = [adminId, strangerId, memberAId, memberBId, memberCId, outsiderId].filter(Boolean);
  if (allUserIds.length) {
    await db.delete(profileShareEventsTable).where(inArray(profileShareEventsTable.userId, allUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, allUserIds));
  }
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (otherOrgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrgId));
});

describe("GET /api/organizations/:orgId/analytics/profile-share-leaderboard", () => {
  it("requires authentication", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/organizations/${orgId}/analytics/profile-share-leaderboard`);
    expect(r.status).toBe(401);
  });

  it("rejects non-admin callers with 403", async () => {
    const app = createTestApp(strangerUser);
    const r = await request(app).get(`/api/organizations/${orgId}/analytics/profile-share-leaderboard`);
    expect(r.status).toBe(403);
  });

  it("returns the org leaderboard sorted by total, broken down by method", async () => {
    const app = createTestApp(adminUser);
    const r = await request(app).get(
      `/api/organizations/${orgId}/analytics/profile-share-leaderboard?period=year`,
    );
    expect(r.status).toBe(200);

    const body = r.body as {
      totals: { total: number; byMethod: Record<string, number> };
      leaderboard: Array<{
        userId: number;
        total: number;
        publicHandle: string | null;
        byMethod: Record<string, number>;
      }>;
    };

    // Outsider's events must NOT appear.
    const ids = body.leaderboard.map(e => e.userId);
    expect(ids).not.toContain(outsiderId);

    // Org totals exclude outsider's 99 copies.
    expect(body.totals.byMethod.copy).toBe(5); // 3 + 1 + 1
    expect(body.totals.byMethod.qr_open).toBe(4);
    expect(body.totals.byMethod.web_share).toBe(1);
    expect(body.totals.byMethod.native_share).toBe(2);
    expect(body.totals.total).toBe(12);

    // Sorted by total desc: B (6), A (5), C (1).
    const ours = body.leaderboard.filter(e => [memberAId, memberBId, memberCId].includes(e.userId));
    expect(ours.map(e => e.userId)).toEqual([memberBId, memberAId, memberCId]);

    const a = ours.find(e => e.userId === memberAId)!;
    expect(a.total).toBe(5);
    expect(a.byMethod).toMatchObject({ copy: 3, native_share: 2, web_share: 0, qr_open: 0 });

    const b = ours.find(e => e.userId === memberBId)!;
    expect(b.total).toBe(6);
    expect(b.byMethod).toMatchObject({ copy: 1, web_share: 1, native_share: 0, qr_open: 4 });
    expect(b.publicHandle).toBe(`${tag}-b`);
  });

  it("respects the limit query param", async () => {
    const app = createTestApp(adminUser);
    const r = await request(app).get(
      `/api/organizations/${orgId}/analytics/profile-share-leaderboard?period=year&limit=1`,
    );
    expect(r.status).toBe(200);
    // Only the top scorer (member B) survives the limit.
    const ours = (r.body.leaderboard as Array<{ userId: number }>)
      .filter(e => [memberAId, memberBId, memberCId].includes(e.userId));
    expect(ours.length).toBe(1);
    expect(ours[0].userId).toBe(memberBId);
  });
});
