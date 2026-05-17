/**
 * Integration tests: Edit & delete posted cross-club ladder results
 * (Task #752, coverage for endpoints added in cross-club-ladders.ts)
 *
 * Endpoints under test:
 *   PATCH  /api/cross-club-ladders/:id/results/:resultId
 *   DELETE /api/cross-club-ladders/:id/results/:resultId
 *
 * Authorization rules being verified:
 *   - super_admin can always edit/delete and the standings recompute runs.
 *   - org_admin / tournament_director of the result's *originating*
 *     organization can edit/delete.
 *   - org_admin of a different org is rejected with 403.
 *   - player role is rejected with 403.
 *
 * Behaviour being verified:
 *   - PATCH with score updates recomputes pointsAwarded and the entry's
 *     totalPoints reflects the recomputed standings.
 *   - DELETE removes the result row AND triggers a standings recompute that
 *     removes the deleted result's contribution from the entry's totals.
 *   - PATCH with no body fields is a no-op edit (scores/notes unchanged).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  crossClubLaddersTable,
  crossClubLadderClubsTable,
  crossClubLadderEntriesTable,
  crossClubLadderResultsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

let orgAId: number; // originating club for the result
let orgBId: number; // a different participating club
let playerUserId: number;

const createdLadderIds: number[] = [];

beforeAll(async () => {
  const [orgA] = await db.insert(organizationsTable).values({
    name: `LadderEdit_A_${stamp}`,
    slug: `ladder-edit-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `LadderEdit_B_${stamp}`,
    slug: `ladder-edit-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `ladder-edit-${stamp}-p`,
    username: `ladder_edit_${stamp}_p`,
    email: `ladder_edit_${stamp}_p@example.com`,
    displayName: "Ladder Edit Player",
  }).returning({ id: appUsersTable.id });
  playerUserId = u.id;
});

afterAll(async () => {
  for (const id of createdLadderIds) {
    await db.delete(crossClubLaddersTable).where(eq(crossClubLaddersTable.id, id));
  }
  if (playerUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, playerUserId));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgAId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgBId));
});

/**
 * Build a fresh ladder + two participating clubs + one entry + one posted
 * result. Each test calls this so it operates on isolated rows and the
 * standings recompute can be observed deterministically.
 *
 * The result is posted with originating org = orgAId (so org_admin of orgA
 * is the per-club editor in the role-based authz tests).
 */
async function makeLadderWithResult(label: string, opts: {
  initialStableford?: number;
} = {}) {
  const initial = opts.initialStableford ?? 30;
  const [ladder] = await db.insert(crossClubLaddersTable).values({
    name: `LadderEdit_${label}_${stamp}`,
    format: "stableford",
    status: "active",
    scope: "national",
    seasonStart: new Date(Date.now() - 30 * 86_400_000),
    seasonEnd: new Date(Date.now() + 30 * 86_400_000),
    shareSlug: `ladder-edit-${label}-${stamp}`,
    isPublic: true,
  }).returning({ id: crossClubLaddersTable.id });
  createdLadderIds.push(ladder.id);

  await db.insert(crossClubLadderClubsTable).values([
    { ladderId: ladder.id, organizationId: orgAId },
    { ladderId: ladder.id, organizationId: orgBId },
  ]);

  const [entry] = await db.insert(crossClubLadderEntriesTable).values({
    ladderId: ladder.id,
    userId: playerUserId,
    playerName: `Player_${label}`,
  }).returning({ id: crossClubLadderEntriesTable.id });

  const [result] = await db.insert(crossClubLadderResultsTable).values({
    ladderId: ladder.id,
    entryId: entry.id,
    organizationId: orgAId,
    roundDate: new Date(),
    grossScore: 90,
    netScore: 72,
    stablefordPoints: initial,
    pointsAwarded: initial,
    notes: "initial",
  }).returning();

  // Reflect the initial result in the entry's standings so we can observe
  // recompute deltas later.
  await db.update(crossClubLadderEntriesTable)
    .set({ totalPoints: initial, roundsCounted: 1, position: 1 })
    .where(eq(crossClubLadderEntriesTable.id, entry.id));

  return { ladderId: ladder.id, entryId: entry.id, resultId: result.id, initial };
}

const superAdmin = {
  id: 9001,
  username: "super",
  role: "super_admin",
};
const orgAAdmin = (id = 9002) => ({
  id,
  username: "orga_admin",
  role: "org_admin",
  organizationId: orgAId,
});
const orgBAdmin = (id = 9003) => ({
  id,
  username: "orgb_admin",
  role: "org_admin",
  organizationId: orgBId,
});
const playerCaller = (id = 9004) => ({
  id,
  username: "player_caller",
  role: "player",
  organizationId: orgAId,
});
const orgATournamentDirector = (id = 9005) => ({
  id,
  username: "orga_td",
  role: "tournament_director",
  organizationId: orgAId,
});
const orgBTournamentDirector = (id = 9006) => ({
  id,
  username: "orgb_td",
  role: "tournament_director",
  organizationId: orgBId,
});

describe("PATCH /cross-club-ladders/:id/results/:resultId", () => {
  let ladderId: number;
  let resultId: number;
  let entryId: number;
  let initial: number;

  beforeEach(async () => {
    ({ ladderId, resultId, entryId, initial } = await makeLadderWithResult(
      `patch_${Math.random().toString(36).slice(2, 6)}`,
    ));
  });

  it("rejects unauthenticated callers with 401", async () => {
    const app = createTestApp();
    const res = await request(app)
      .patch(`/api/cross-club-ladders/${ladderId}/results/${resultId}`)
      .send({ stablefordPoints: 40 });
    expect(res.status).toBe(401);
  });

  it("rejects player role with 403", async () => {
    const app = createTestApp(playerCaller());
    const res = await request(app)
      .patch(`/api/cross-club-ladders/${ladderId}/results/${resultId}`)
      .send({ stablefordPoints: 40 });
    expect(res.status).toBe(403);
  });

  it("rejects org_admin of a different club with 403", async () => {
    const app = createTestApp(orgBAdmin());
    const res = await request(app)
      .patch(`/api/cross-club-ladders/${ladderId}/results/${resultId}`)
      .send({ stablefordPoints: 40 });
    expect(res.status).toBe(403);

    // The unchanged result must remain intact.
    const [row] = await db.select().from(crossClubLadderResultsTable)
      .where(eq(crossClubLadderResultsTable.id, resultId));
    expect(row.stablefordPoints).toBe(initial);
    expect(row.pointsAwarded).toBe(initial);
  });

  it("super_admin edit recomputes pointsAwarded and the entry standings", async () => {
    const app = createTestApp(superAdmin);
    const res = await request(app)
      .patch(`/api/cross-club-ladders/${ladderId}/results/${resultId}`)
      .send({ stablefordPoints: 42, notes: "edited" });
    expect(res.status).toBe(200);
    expect(res.body.stablefordPoints).toBe(42);
    expect(res.body.pointsAwarded).toBe(42);
    expect(res.body.notes).toBe("edited");

    const [entry] = await db.select().from(crossClubLadderEntriesTable)
      .where(eq(crossClubLadderEntriesTable.id, entryId));
    expect(entry.totalPoints).toBe(42);
    expect(entry.roundsCounted).toBe(1);
    expect(entry.position).toBe(1);
  });

  it("org_admin of the originating club can edit and standings recompute", async () => {
    const app = createTestApp(orgAAdmin());
    const res = await request(app)
      .patch(`/api/cross-club-ladders/${ladderId}/results/${resultId}`)
      .send({ stablefordPoints: 25 });
    expect(res.status).toBe(200);
    expect(res.body.pointsAwarded).toBe(25);

    const [entry] = await db.select().from(crossClubLadderEntriesTable)
      .where(eq(crossClubLadderEntriesTable.id, entryId));
    expect(entry.totalPoints).toBe(25);
  });

  it("tournament_director of the originating club can edit; of a different club is rejected", async () => {
    // Wrong-club tournament_director must be rejected.
    const wrongApp = createTestApp(orgBTournamentDirector());
    const denied = await request(wrongApp)
      .patch(`/api/cross-club-ladders/${ladderId}/results/${resultId}`)
      .send({ stablefordPoints: 17 });
    expect(denied.status).toBe(403);

    // Originating-club tournament_director succeeds and standings recompute.
    const okApp = createTestApp(orgATournamentDirector());
    const ok = await request(okApp)
      .patch(`/api/cross-club-ladders/${ladderId}/results/${resultId}`)
      .send({ stablefordPoints: 17 });
    expect(ok.status).toBe(200);
    expect(ok.body.pointsAwarded).toBe(17);

    const [entry] = await db.select().from(crossClubLadderEntriesTable)
      .where(eq(crossClubLadderEntriesTable.id, entryId));
    expect(entry.totalPoints).toBe(17);
  });

  it("PATCH with no body fields is a no-op edit (scores and notes unchanged)", async () => {
    const app = createTestApp(superAdmin);
    const res = await request(app)
      .patch(`/api/cross-club-ladders/${ladderId}/results/${resultId}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.stablefordPoints).toBe(initial);
    expect(res.body.pointsAwarded).toBe(initial);
    expect(res.body.grossScore).toBe(90);
    expect(res.body.netScore).toBe(72);
    expect(res.body.notes).toBe("initial");

    // And the entry standings still reflect the original points.
    const [entry] = await db.select().from(crossClubLadderEntriesTable)
      .where(eq(crossClubLadderEntriesTable.id, entryId));
    expect(entry.totalPoints).toBe(initial);
  });

  it("returns 404 when the result does not belong to the ladder", async () => {
    const app = createTestApp(superAdmin);
    const res = await request(app)
      .patch(`/api/cross-club-ladders/${ladderId}/results/9999999`)
      .send({ stablefordPoints: 1 });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /cross-club-ladders/:id/results/:resultId", () => {
  let ladderId: number;
  let resultId: number;
  let entryId: number;

  beforeEach(async () => {
    ({ ladderId, resultId, entryId } = await makeLadderWithResult(
      `del_${Math.random().toString(36).slice(2, 6)}`,
    ));
  });

  it("rejects unauthenticated callers with 401", async () => {
    const app = createTestApp();
    const res = await request(app)
      .delete(`/api/cross-club-ladders/${ladderId}/results/${resultId}`);
    expect(res.status).toBe(401);
  });

  it("rejects player role with 403 and leaves the row in place", async () => {
    const app = createTestApp(playerCaller());
    const res = await request(app)
      .delete(`/api/cross-club-ladders/${ladderId}/results/${resultId}`);
    expect(res.status).toBe(403);

    const rows = await db.select().from(crossClubLadderResultsTable)
      .where(eq(crossClubLadderResultsTable.id, resultId));
    expect(rows).toHaveLength(1);
  });

  it("rejects org_admin of a different club with 403", async () => {
    const app = createTestApp(orgBAdmin());
    const res = await request(app)
      .delete(`/api/cross-club-ladders/${ladderId}/results/${resultId}`);
    expect(res.status).toBe(403);

    const rows = await db.select().from(crossClubLadderResultsTable)
      .where(eq(crossClubLadderResultsTable.id, resultId));
    expect(rows).toHaveLength(1);
  });

  it("super_admin delete removes the row and recomputes standings", async () => {
    const app = createTestApp(superAdmin);
    const res = await request(app)
      .delete(`/api/cross-club-ladders/${ladderId}/results/${resultId}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const rows = await db.select().from(crossClubLadderResultsTable)
      .where(eq(crossClubLadderResultsTable.id, resultId));
    expect(rows).toHaveLength(0);

    const [entry] = await db.select().from(crossClubLadderEntriesTable)
      .where(eq(crossClubLadderEntriesTable.id, entryId));
    expect(entry.totalPoints).toBe(0);
    expect(entry.roundsCounted).toBe(0);
  });

  it("tournament_director of the originating club can delete; of a different club is rejected", async () => {
    const wrongApp = createTestApp(orgBTournamentDirector());
    const denied = await request(wrongApp)
      .delete(`/api/cross-club-ladders/${ladderId}/results/${resultId}`);
    expect(denied.status).toBe(403);

    const stillThere = await db.select().from(crossClubLadderResultsTable)
      .where(eq(crossClubLadderResultsTable.id, resultId));
    expect(stillThere).toHaveLength(1);

    const okApp = createTestApp(orgATournamentDirector());
    const ok = await request(okApp)
      .delete(`/api/cross-club-ladders/${ladderId}/results/${resultId}`);
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);

    const removed = await db.select().from(crossClubLadderResultsTable)
      .where(eq(crossClubLadderResultsTable.id, resultId));
    expect(removed).toHaveLength(0);

    const [entry] = await db.select().from(crossClubLadderEntriesTable)
      .where(eq(crossClubLadderEntriesTable.id, entryId));
    expect(entry.totalPoints).toBe(0);
    expect(entry.roundsCounted).toBe(0);
  });

  it("org_admin of the originating club can delete and standings recompute", async () => {
    const app = createTestApp(orgAAdmin());
    const res = await request(app)
      .delete(`/api/cross-club-ladders/${ladderId}/results/${resultId}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const remaining = await db.select().from(crossClubLadderResultsTable)
      .where(and(
        eq(crossClubLadderResultsTable.ladderId, ladderId),
        eq(crossClubLadderResultsTable.id, resultId),
      ));
    expect(remaining).toHaveLength(0);

    const [entry] = await db.select().from(crossClubLadderEntriesTable)
      .where(eq(crossClubLadderEntriesTable.id, entryId));
    expect(entry.totalPoints).toBe(0);
    expect(entry.roundsCounted).toBe(0);
  });

  it("returns 404 when the result does not belong to the ladder", async () => {
    const app = createTestApp(superAdmin);
    const res = await request(app)
      .delete(`/api/cross-club-ladders/${ladderId}/results/9999999`);
    expect(res.status).toBe(404);
  });
});
