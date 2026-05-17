/**
 * Task #1176 — server coverage for the shot delete + restore Undo flow added
 * in Task #1009.
 *
 *   DELETE /api/portal/shots/:id
 *   POST   /api/portal/shots/restore
 *
 * The mobile ShotReviewModal "Undo" affordance relies on two contracts:
 *   1. DELETE returns the full deleted row as `deletedShot` so the client
 *      can echo it back on Undo.
 *   2. POST /restore re-inserts the snapshot at its original shotNumber,
 *      shifting any later shots in the same (round, hole) group up by 1
 *      to keep the sequence contiguous. The response carries the freshly
 *      inserted row (with a NEW id) so the client can update local state.
 *
 * These tests pin the contract:
 *   1. DELETE returns deletedShot with the expected fields (round,
 *      holeNumber, shotNumber, playerId, tournamentId, source, etc.).
 *   2. Restore reinserts at the original shotNumber and bumps later
 *      shots in the same hole up by 1 (so a delete-then-restore round
 *      trip leaves the per-hole sequence identical to the pre-delete
 *      state, modulo new row ids).
 *   3. Restore rejects callers who don't own the target tournament/round
 *      with 403.
 *   4. Restore is effectively a no-op shift when the original shotNumber
 *      slot is no longer occupied (no later shots to bump): the snapshot
 *      is inserted at its original shotNumber without disturbing anything
 *      else.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  tournamentsTable,
  playersTable,
  shotsTable,
  appUsersTable,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

let orgId: number;
let courseId: number;
let tournamentId: number;
let otherTournamentId: number;
let playerUserId: number;
let outsiderUserId: number;
let playerId: number;

beforeAll(async () => {
  const stamp = Date.now();

  const [org] = await db.insert(organizationsTable).values({
    name: `T1176_${stamp}`,
    slug: `t1176-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "T1176 Course",
    slug: `t1176-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `T1176 Tournament ${stamp}`,
    status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  tournamentId = tournament.id;

  const [other] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `T1176 Other ${stamp}`,
    status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  otherTournamentId = other.id;

  const [pUser] = await db.insert(appUsersTable).values({
    replitUserId: `t1176-player-${stamp}`,
    username: `t1176_player_${stamp}`,
  }).returning({ id: appUsersTable.id });
  playerUserId = pUser.id;

  const [oUser] = await db.insert(appUsersTable).values({
    replitUserId: `t1176-outsider-${stamp}`,
    username: `t1176_outsider_${stamp}`,
  }).returning({ id: appUsersTable.id });
  outsiderUserId = oUser.id;

  const [pPlayer] = await db.insert(playersTable).values({
    tournamentId, userId: playerUserId, firstName: "Pat", lastName: "Player",
    email: `t1176-player-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  playerId = pPlayer.id;
});

afterAll(async () => {
  await db.delete(shotsTable).where(eq(shotsTable.tournamentId, tournamentId));
  await db.delete(shotsTable).where(eq(shotsTable.tournamentId, otherTournamentId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, tournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, otherTournamentId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, playerUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, outsiderUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

function playerApp() {
  return createTestApp({
    id: playerUserId, username: "t1176_player", role: "member",
  });
}

function outsiderApp() {
  // outsiderUserId has NO playersTable row for `tournamentId` — used to
  // drive the restore-not-enrolled (403) path.
  return createTestApp({
    id: outsiderUserId, username: "t1176_outsider", role: "member",
  });
}

/**
 * Insert a shot directly via Drizzle (bypassing the route layer) so each
 * test starts from a known (round, hole, shotNumber) layout. Tests that
 * need to exercise the route do so explicitly via supertest.
 */
async function insertShot(opts: {
  round: number; hole: number; shotNumber: number;
  shotType?: typeof shotsTable.$inferInsert["shotType"];
  club?: string | null;
}) {
  const [row] = await db.insert(shotsTable).values({
    tournamentId,
    playerId,
    round: opts.round,
    holeNumber: opts.hole,
    shotNumber: opts.shotNumber,
    shotType: opts.shotType ?? "fairway",
    club: opts.club ?? null,
    source: "manual",
  }).returning();
  return row;
}

async function listShotNumbers(round: number, hole: number) {
  const rows = await db.select({
    id: shotsTable.id,
    shotNumber: shotsTable.shotNumber,
    shotType: shotsTable.shotType,
  }).from(shotsTable).where(and(
    eq(shotsTable.tournamentId, tournamentId),
    eq(shotsTable.playerId, playerId),
    eq(shotsTable.round, round),
    eq(shotsTable.holeNumber, hole),
  )).orderBy(asc(shotsTable.shotNumber));
  return rows;
}

describe("DELETE /portal/shots/:id + POST /portal/shots/restore (Task #1009 / #1176)", () => {
  it("DELETE returns the full deletedShot snapshot", async () => {
    // Use a hole no other test touches so we can assert exact contents.
    const round = 1, hole = 11;
    const a = await insertShot({ round, hole, shotNumber: 1, shotType: "tee", club: "DR" });
    const b = await insertShot({ round, hole, shotNumber: 2, shotType: "approach", club: "7I" });

    const res = await request(playerApp()).delete(`/api/portal/shots/${b.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      deletedId: b.id,
      // Only `a` remains on this hole, so resequencing visited 1 row.
      resequenced: 1,
    });
    expect(res.body.deletedShot).toBeDefined();
    expect(res.body.deletedShot.id).toBe(b.id);
    expect(res.body.deletedShot.tournamentId).toBe(tournamentId);
    expect(res.body.deletedShot.playerId).toBe(playerId);
    expect(res.body.deletedShot.round).toBe(round);
    expect(res.body.deletedShot.holeNumber).toBe(hole);
    expect(res.body.deletedShot.shotNumber).toBe(2);
    expect(res.body.deletedShot.shotType).toBe("approach");
    expect(res.body.deletedShot.club).toBe("7I");
    expect(res.body.deletedShot.source).toBe("manual");

    // Sanity: row is actually gone, and `a` remains at shotNumber=1.
    const remaining = await listShotNumbers(round, hole);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(a.id);
    expect(remaining[0].shotNumber).toBe(1);

    // Cleanup for next test.
    await db.delete(shotsTable).where(and(
      eq(shotsTable.tournamentId, tournamentId),
      eq(shotsTable.holeNumber, hole),
    ));
  });

  it("restore reinserts at the original shotNumber and bumps later shots up", async () => {
    // Layout: shotNumbers 1, 2, 3 on this hole. Delete the middle one
    // (which then causes the trailing shot 3 to be resequenced to 2).
    // Restoring the snapshot must put it back at shotNumber=2 and shift
    // the now-2 shot up to 3 again.
    const round = 1, hole = 12;
    const a = await insertShot({ round, hole, shotNumber: 1, shotType: "tee", club: "DR" });
    const b = await insertShot({ round, hole, shotNumber: 2, shotType: "approach", club: "7I" });
    const c = await insertShot({ round, hole, shotNumber: 3, shotType: "putt", club: "PT" });

    const del = await request(playerApp()).delete(`/api/portal/shots/${b.id}`);
    expect(del.status).toBe(200);
    expect(del.body.deletedShot.shotNumber).toBe(2);

    // After delete + resequence, the previous shot 3 should now be at 2.
    let layout = await listShotNumbers(round, hole);
    expect(layout.map(r => r.shotNumber)).toEqual([1, 2]);
    expect(layout[0].id).toBe(a.id);
    expect(layout[1].id).toBe(c.id);

    const restore = await request(playerApp())
      .post("/api/portal/shots/restore")
      .send(del.body.deletedShot);
    expect(restore.status).toBe(200);
    expect(restore.body).toMatchObject({ ok: true });
    expect(restore.body.shot).toBeDefined();
    // The restored row carries a NEW id (not the deleted one) but the
    // same logical position.
    expect(restore.body.shot.id).not.toBe(b.id);
    expect(restore.body.shot.shotNumber).toBe(2);
    expect(restore.body.shot.shotType).toBe("approach");
    expect(restore.body.shot.club).toBe("7I");
    expect(restore.body.shot.tournamentId).toBe(tournamentId);
    expect(restore.body.shot.playerId).toBe(playerId);

    // Sequence is back to 1, 2, 3 with the third row being the original
    // `c` (now bumped back up from 2 → 3 by the restore shift).
    layout = await listShotNumbers(round, hole);
    expect(layout.map(r => r.shotNumber)).toEqual([1, 2, 3]);
    expect(layout[0].id).toBe(a.id);
    expect(layout[1].id).toBe(restore.body.shot.id);
    expect(layout[2].id).toBe(c.id);
    expect(layout[1].shotType).toBe("approach");
    expect(layout[2].shotType).toBe("putt");

    await db.delete(shotsTable).where(and(
      eq(shotsTable.tournamentId, tournamentId),
      eq(shotsTable.holeNumber, hole),
    ));
  });

  it("restore rejects callers who don't own the target tournament with 403", async () => {
    // Build a snapshot pinned to `tournamentId` (which the outsider is
    // NOT enrolled in) and POST it as the outsider — must be 403, and
    // no row may land in the database.
    const round = 1, hole = 13;
    const snapshot = {
      tournamentId,
      playerId, // server should ignore and re-derive from the caller
      round,
      holeNumber: hole,
      shotNumber: 1,
      shotType: "tee",
      club: "DR",
      source: "manual",
    };

    const res = await request(outsiderApp())
      .post("/api/portal/shots/restore")
      .send(snapshot);
    expect(res.status).toBe(403);
    expect(String(res.body?.error ?? "")).toMatch(/not enrolled/i);

    // The outsider's attempt must not have inserted a row.
    const after = await listShotNumbers(round, hole);
    expect(after).toHaveLength(0);

    // Same shape, but for a tournament the player IS enrolled in but
    // pointed at the *other* tournament — also 403.
    const otherSnap = { ...snapshot, tournamentId: otherTournamentId };
    const res2 = await request(playerApp())
      .post("/api/portal/shots/restore")
      .send(otherSnap);
    expect(res2.status).toBe(403);
    expect(String(res2.body?.error ?? "")).toMatch(/not enrolled/i);
  });

  it("restore is a no-op shift when the original shotNumber slot is no longer occupied", async () => {
    // The "no-op" branch of the restore route: the shift loop only
    // touches rows with shotNumber >= snap.shotNumber. When no such
    // rows exist (for example, after the user deletes the only shot
    // on the hole and then immediately taps Undo), the loop iterates
    // zero times and the snapshot is inserted at its original position
    // with NO renumbering of any other row.
    const round = 1, hole = 14;
    const a = await insertShot({ round, hole, shotNumber: 1, shotType: "tee", club: "DR" });

    const del = await request(playerApp()).delete(`/api/portal/shots/${a.id}`);
    expect(del.status).toBe(200);
    // No later shots existed → resequenced visited 0 rows.
    expect(del.body.resequenced).toBe(0);

    // Hole is now empty.
    expect(await listShotNumbers(round, hole)).toHaveLength(0);

    // Also seed a shot on a SEPARATE hole to confirm restore's shift
    // is correctly scoped to (round, hole) and does not renumber rows
    // outside the deleted shot's group.
    const otherHole = 15;
    const sentinel = await insertShot({ round, hole: otherHole, shotNumber: 1, shotType: "tee", club: "DR" });

    const restore = await request(playerApp())
      .post("/api/portal/shots/restore")
      .send(del.body.deletedShot);
    expect(restore.status).toBe(200);
    expect(restore.body.shot.shotNumber).toBe(1);
    expect(restore.body.shot.shotType).toBe("tee");
    expect(restore.body.shot.club).toBe("DR");

    // Exactly one row on the original hole, at the original shotNumber.
    const after = await listShotNumbers(round, hole);
    expect(after).toHaveLength(1);
    expect(after[0].shotNumber).toBe(1);
    expect(after[0].shotType).toBe("tee");

    // The sentinel on the other hole is untouched (same id, same
    // shotNumber): restore did not spill across hole boundaries.
    const otherAfter = await listShotNumbers(round, otherHole);
    expect(otherAfter).toHaveLength(1);
    expect(otherAfter[0].id).toBe(sentinel.id);
    expect(otherAfter[0].shotNumber).toBe(1);
  });
});
