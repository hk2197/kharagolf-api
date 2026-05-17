/**
 * Integration tests: AI Caddie pending-feedback endpoint (Task #918).
 *
 * Covers GET /api/portal/caddie/feedback/pending and the resolve-via-POST
 * round-trip with POST /api/portal/caddie/feedback.
 *
 *   - Returns only the caller's recommendations where `accepted IS NULL`,
 *     ordered by recordedAt desc, with another user's pending row excluded.
 *   - Respects the `limit` query parameter (clamped at 1..50).
 *   - 401 when unauthenticated.
 *   - 403 with CONSENT_REQUIRED when AI consent has been withdrawn.
 *   - Posting feedback for a pending row removes it from the pending list
 *     (next GET excludes it because `accepted` is no longer NULL).
 *
 * Uses the real PostgreSQL database (DATABASE_URL).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  appUsersTable,
  caddieRecommendationsTable,
  organizationsTable,
  orgMembershipsTable,
  clubMembersTable,
  memberConsentsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const URL = "/api/portal/caddie/feedback/pending";
const POST_URL = "/api/portal/caddie/feedback";

// Three personas:
//   - listUser: no club membership → consent gate is open. We seed
//     pending + decided rows here to assert filtering, ordering, limit, and
//     the resolve-round-trip.
//   - otherUser: a second pending row owned by someone else, used to assert
//     scoping (the listing must not leak across users).
//   - deniedUser: club member with AI consent withdrawn, to assert the
//     403 path.
let listUserId: number;
let otherUserId: number;
let deniedUserId: number;
let deniedOrgId: number;

let listUser: TestUser;
let deniedUser: TestUser;
let listApp: ReturnType<typeof createTestApp>;
let deniedApp: ReturnType<typeof createTestApp>;
let unauthApp: ReturnType<typeof createTestApp>;

// Track inserted recommendation ids so we can identify which belong to this
// test in assertions (other tests share the same DB and may seed rows for
// these users — though we use unique users here, this keeps assertions tight).
const seededIds: number[] = [];

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `caddie-pending-list-${stamp}`,
    username: `caddie_pending_list_${stamp}`,
    email: `caddie_pending_list_${stamp}@example.com`,
    displayName: "Caddie Pending List",
    role: "player",
  }).returning({ id: appUsersTable.id });
  listUserId = u1.id;

  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `caddie-pending-other-${stamp}`,
    username: `caddie_pending_other_${stamp}`,
    email: `caddie_pending_other_${stamp}@example.com`,
    displayName: "Caddie Pending Other",
    role: "player",
  }).returning({ id: appUsersTable.id });
  otherUserId = u2.id;

  // Consent-denied user — needs an org + club_member + a granted=false ai
  // consent row so the gate trips.
  const [org] = await db.insert(organizationsTable).values({
    name: `CaddiePendingOrg_${stamp}`,
    slug: `caddie-pending-${stamp}`,
  }).returning({ id: organizationsTable.id });
  deniedOrgId = org.id;

  const [u3] = await db.insert(appUsersTable).values({
    replitUserId: `caddie-pending-denied-${stamp}`,
    username: `caddie_pending_denied_${stamp}`,
    email: `caddie_pending_denied_${stamp}@example.com`,
    displayName: "Caddie Pending Denied",
    role: "player",
    organizationId: deniedOrgId,
  }).returning({ id: appUsersTable.id });
  deniedUserId = u3.id;

  await db.insert(orgMembershipsTable).values({
    organizationId: deniedOrgId, userId: deniedUserId, role: "player",
  });
  const [dm] = await db.insert(clubMembersTable).values({
    organizationId: deniedOrgId,
    userId: deniedUserId,
    firstName: "Denied",
    lastName: "User",
    email: `caddie_pending_denied_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  await db.insert(memberConsentsTable).values({
    clubMemberId: dm.id, organizationId: deniedOrgId,
    consentType: "ai", granted: false,
  });

  // Seed list user with:
  //   - 3 pending rows at different recordedAt timestamps
  //   - 1 already-accepted row (must be excluded)
  //   - 1 already-overridden row (must be excluded)
  // Plus 1 pending row owned by otherUser (must not leak).
  const now = Date.now();
  const t = (offsetMs: number) => new Date(now - offsetMs);
  const inserted = await db.insert(caddieRecommendationsTable).values([
    // Pending — newest
    { userId: listUserId, holeNumber: 1, distanceYards: "150",
      recommendedClub: "7 Iron", accepted: null,
      recordedAt: t(1_000) },
    // Pending — middle
    { userId: listUserId, holeNumber: 2, distanceYards: "140",
      recommendedClub: "8 Iron", accepted: null,
      recordedAt: t(60_000) },
    // Pending — oldest
    { userId: listUserId, holeNumber: 3, distanceYards: "130",
      recommendedClub: "9 Iron", accepted: null,
      recordedAt: t(120_000) },
    // Resolved — accepted
    { userId: listUserId, holeNumber: 4, distanceYards: "120",
      recommendedClub: "PW", accepted: true,
      recordedAt: t(30_000) },
    // Resolved — overridden
    { userId: listUserId, holeNumber: 5, distanceYards: "110",
      recommendedClub: "GW", accepted: false,
      recordedAt: t(45_000) },
    // Other user pending — must not appear in list user's response
    { userId: otherUserId, holeNumber: 6, distanceYards: "150",
      recommendedClub: "7 Iron", accepted: null,
      recordedAt: t(500) },
  ]).returning({ id: caddieRecommendationsTable.id });
  for (const r of inserted) seededIds.push(r.id);

  listUser = {
    id: listUserId,
    username: `caddie_pending_list_${stamp}`,
    role: "player",
  };
  deniedUser = {
    id: deniedUserId,
    username: `caddie_pending_denied_${stamp}`,
    role: "player",
    organizationId: deniedOrgId,
  };
  listApp = createTestApp(listUser);
  deniedApp = createTestApp(deniedUser);
  unauthApp = createTestApp(undefined);
});

afterAll(async () => {
  // caddie_recommendations cascade off app_users.
  // member_consents + club_members + org_memberships cascade off org/user.
  if (seededIds.length) {
    await db.delete(caddieRecommendationsTable)
      .where(inArray(caddieRecommendationsTable.id, seededIds));
  }
  for (const uid of [listUserId, otherUserId, deniedUserId]) {
    if (uid) await db.delete(appUsersTable).where(eq(appUsersTable.id, uid));
  }
  if (deniedOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, deniedOrgId));
  }
});

describe("GET /portal/caddie/feedback/pending — auth & consent", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(unauthApp).get(URL);
    expect(res.status).toBe(401);
  });

  it("returns 403 with CONSENT_REQUIRED when AI consent is withdrawn", async () => {
    const res = await request(deniedApp).get(URL);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CONSENT_REQUIRED");
    expect(res.body.consentRequired?.category).toBe("ai");
  });
});

describe("GET /portal/caddie/feedback/pending — listing", () => {
  it("returns only the caller's pending rows, ordered by recordedAt desc", async () => {
    const res = await request(listApp).get(URL);
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{
      id: number; holeNumber: number; recommendedClub: string;
      recordedAt: string;
    }>;
    // 3 pending rows seeded for listUser; resolved + other-user rows excluded.
    expect(items).toHaveLength(3);
    // Ordered by recordedAt desc → hole 1 (newest), 2, 3 (oldest).
    expect(items.map(i => i.holeNumber)).toEqual([1, 2, 3]);
    expect(items.map(i => i.recommendedClub)).toEqual([
      "7 Iron", "8 Iron", "9 Iron",
    ]);
    // recordedAt strictly descending
    const ts = items.map(i => Date.parse(i.recordedAt));
    expect(ts[0]).toBeGreaterThan(ts[1]);
    expect(ts[1]).toBeGreaterThan(ts[2]);
    // No row from otherUser leaked.
    expect(items.find(i => i.holeNumber === 6)).toBeUndefined();
    // No resolved rows (accepted/overridden) leaked.
    expect(items.find(i => i.holeNumber === 4)).toBeUndefined();
    expect(items.find(i => i.holeNumber === 5)).toBeUndefined();
  });

  it("respects the `limit` query parameter", async () => {
    const res = await request(listApp).get(`${URL}?limit=2`);
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ holeNumber: number }>;
    expect(items).toHaveLength(2);
    // Still ordered desc → newest two pending rows.
    expect(items.map(i => i.holeNumber)).toEqual([1, 2]);
  });
});

describe("POST /portal/caddie/feedback round-trip", () => {
  it("removes a row from the pending list once feedback is posted", async () => {
    // Pick the oldest pending row (hole 3) so the assertion is unambiguous.
    const before = await request(listApp).get(URL);
    expect(before.status).toBe(200);
    const beforeItems = before.body.items as Array<{ id: number; holeNumber: number }>;
    const target = beforeItems.find(i => i.holeNumber === 3);
    expect(target).toBeDefined();

    // Resolve it by accepting the AI's recommended club.
    const post = await request(listApp).post(POST_URL).send({
      recommendationId: target!.id,
      chosenClub: "9 Iron",
      accepted: true,
    });
    expect(post.status).toBe(200);
    expect(post.body.ok).toBe(true);
    expect(post.body.accepted).toBe(true);

    // Pending list should no longer include the resolved row.
    const after = await request(listApp).get(URL);
    expect(after.status).toBe(200);
    const afterItems = after.body.items as Array<{ id: number; holeNumber: number }>;
    expect(afterItems.find(i => i.id === target!.id)).toBeUndefined();
    expect(afterItems.find(i => i.holeNumber === 3)).toBeUndefined();
    // The other two pending rows are still there.
    expect(afterItems.map(i => i.holeNumber).sort()).toEqual([1, 2]);
  });
});
