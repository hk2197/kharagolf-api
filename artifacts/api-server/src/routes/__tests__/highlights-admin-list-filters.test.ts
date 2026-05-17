/**
 * Task #1022 — Filters on the org-admin reel engagement list.
 *
 * Pins the contract for the optional query params on
 *   GET /api/portal/highlights/admin/list
 *
 * Covers:
 *   • `tournamentId` filter scopes returned reels.
 *   • `since` / `until` date-range filter scopes returned reels.
 *   • A `tournamentId` belonging to a *different* org is silently
 *     ignored — the response still lists the caller's full org reel
 *     set rather than leaking another club's data.
 *   • The `tournaments` array shipped with the response only contains
 *     tournaments from the caller's org, never anyone else's.
 *
 * Render queue is stubbed so the create-side never touches ffmpeg.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";

vi.mock("../../lib/highlightQueue.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/highlightQueue.js")>(
    "../../lib/highlightQueue.js",
  );
  return { ...actual, enqueueRender: vi.fn(async () => {}) };
});

import {
  db,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  tournamentsTable,
  highlightReelsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "../../tests/helpers.js";

let orgAId: number;
let orgBId: number;
let adminAId: number;
let adminBId: number;
let tourA1Id: number;
let tourA2Id: number;
let tourBId: number;
const reelIds: number[] = [];

// Fixed timestamps so date-range assertions are deterministic.
const T_OLD = new Date("2025-01-01T12:00:00Z");
const T_MID = new Date("2025-06-15T12:00:00Z");
const T_NEW = new Date("2025-12-20T12:00:00Z");

let reelOldA1: number;
let reelMidA1: number;
let reelNewA2: number;
let reelB: number;

async function seedReel(opts: {
  orgId: number; userId: number; tournamentId: number; createdAt: Date; title: string;
}): Promise<number> {
  const [r] = await db.insert(highlightReelsTable).values({
    organizationId: opts.orgId,
    userId: opts.userId,
    tournamentId: opts.tournamentId,
    templateId: "classic",
    title: opts.title,
    status: "queued",
    createdAt: opts.createdAt,
    updatedAt: opts.createdAt,
  }).returning({ id: highlightReelsTable.id });
  reelIds.push(r.id);
  return r.id;
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [orgA] = await db.insert(organizationsTable).values({
    name: `T1022_A_${stamp}`, slug: `t1022-a-${stamp}`, subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `T1022_B_${stamp}`, slug: `t1022-b-${stamp}`, subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [adminA] = await db.insert(appUsersTable).values({
    replitUserId: `t1022-admin-a-${stamp}`,
    username: `t1022_admin_a_${stamp}`,
    email: `admin_a_${stamp}@t1022.test`,
    role: "org_admin",
    organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  adminAId = adminA.id;

  const [adminB] = await db.insert(appUsersTable).values({
    replitUserId: `t1022-admin-b-${stamp}`,
    username: `t1022_admin_b_${stamp}`,
    email: `admin_b_${stamp}@t1022.test`,
    role: "org_admin",
    organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  adminBId = adminB.id;

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgAId, userId: adminAId, role: "org_admin" },
    { organizationId: orgBId, userId: adminBId, role: "org_admin" },
  ]);

  const [t1] = await db.insert(tournamentsTable).values({
    organizationId: orgAId, name: `T1022 A1 ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  tourA1Id = t1.id;

  const [t2] = await db.insert(tournamentsTable).values({
    organizationId: orgAId, name: `T1022 A2 ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  tourA2Id = t2.id;

  const [t3] = await db.insert(tournamentsTable).values({
    organizationId: orgBId, name: `T1022 B ${stamp}`,
  }).returning({ id: tournamentsTable.id });
  tourBId = t3.id;

  // Org A: two reels on tourA1 (old + mid), one on tourA2 (new).
  reelOldA1 = await seedReel({
    orgId: orgAId, userId: adminAId, tournamentId: tourA1Id,
    createdAt: T_OLD, title: "A1-old",
  });
  reelMidA1 = await seedReel({
    orgId: orgAId, userId: adminAId, tournamentId: tourA1Id,
    createdAt: T_MID, title: "A1-mid",
  });
  reelNewA2 = await seedReel({
    orgId: orgAId, userId: adminAId, tournamentId: tourA2Id,
    createdAt: T_NEW, title: "A2-new",
  });
  // Org B: one reel — must never appear for admin A.
  reelB = await seedReel({
    orgId: orgBId, userId: adminBId, tournamentId: tourBId,
    createdAt: T_MID, title: "B-mid",
  });
});

afterAll(async () => {
  if (reelIds.length > 0) {
    await db.delete(highlightReelsTable).where(inArray(highlightReelsTable.id, reelIds));
  }
  await db.delete(tournamentsTable).where(inArray(tournamentsTable.id, [tourA1Id, tourA2Id, tourBId]));
  await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, [adminAId, adminBId]));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [adminAId, adminBId]));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgAId, orgBId]));
});

function asAdmin(userId: number, orgId: number): TestUser {
  return { id: userId, username: `u${userId}`, role: "org_admin", organizationId: orgId };
}

async function adminList(query = "") {
  const app = createTestApp(asAdmin(adminAId, orgAId));
  const res = await request(app).get(`/api/portal/highlights/admin/list${query}`);
  expect(res.status).toBe(200);
  return res.body as {
    reels: Array<{ id: number; tournamentId: number | null; title: string }>;
    tournaments: Array<{ id: number; name: string }>;
  };
}

describe("GET /api/portal/highlights/admin/list — filters", () => {
  it("scopes results by the tournamentId filter", async () => {
    const body = await adminList(`?tournamentId=${tourA1Id}`);
    const ids = body.reels.map(r => r.id).sort((a, b) => a - b);
    expect(ids).toEqual([reelOldA1, reelMidA1].sort((a, b) => a - b));
    // Org B reel must never appear.
    expect(ids).not.toContain(reelB);
  });

  it("scopes results by the since/until date range", async () => {
    // Window that captures only the mid reel (June 1 – July 1, 2025).
    const body = await adminList(
      `?since=${encodeURIComponent("2025-06-01T00:00:00Z")}` +
      `&until=${encodeURIComponent("2025-07-01T00:00:00Z")}`,
    );
    const ids = body.reels.map(r => r.id);
    expect(ids).toEqual([reelMidA1]);
  });

  it("silently ignores a tournamentId that belongs to another org", async () => {
    // Pass the cross-org tournament id — handler must drop the filter
    // (NOT 400, NOT leak Org B's reel) and return Org A's full reel set.
    const body = await adminList(`?tournamentId=${tourBId}`);
    const ids = body.reels.map(r => r.id).sort((a, b) => a - b);
    expect(ids).toEqual([reelOldA1, reelMidA1, reelNewA2].sort((a, b) => a - b));
    expect(ids).not.toContain(reelB);
  });

  it("only includes the caller's own org tournaments in the dropdown", async () => {
    const body = await adminList();
    const tIds = body.tournaments.map(t => t.id).sort((a, b) => a - b);
    expect(tIds).toEqual([tourA1Id, tourA2Id].sort((a, b) => a - b));
    expect(tIds).not.toContain(tourBId);
  });
});
