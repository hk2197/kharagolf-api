/**
 * Task #1354 — server coverage for the shot delete + restore Undo flow on
 * the casual ("general play") round path.
 *
 *   DELETE /api/portal/shots/:id
 *   POST   /api/portal/shots/restore
 *
 * Task #1176 already pins the same contract for tournament-scoped shots in
 * `portal-shots-delete-restore.test.ts`. The restore endpoint also serves
 * casual rounds via a separate ownership branch (it checks the round
 * belongs to the calling user instead of looking up tournament enrolment),
 * and that branch was previously untested. These tests mirror the
 * tournament cases against a `generalPlayRoundsTable` round so a future
 * refactor of the casual-round path cannot silently break the mobile Undo
 * flow for players logging shots outside of a tournament.
 *
 * Coverage:
 *   1. DELETE returns deletedShot with `generalPlayRoundId` and `userId`
 *      set (and `tournamentId`/`playerId` left null), matching the casual
 *      ownership shape that POST /restore expects on the way back in.
 *   2. Restore reinserts a casual-round shot at its original shotNumber
 *      and bumps later shots in the same (round, hole) group up by 1.
 *   3. Restore rejects a different user who does NOT own the casual round
 *      with 403, and never inserts a row.
 *   4. Restore rejects a snapshot that omits BOTH tournamentId and
 *      generalPlayRoundId with 400.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  shotsTable,
  appUsersTable,
  generalPlayRoundsTable,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

let orgId: number;
let courseId: number;
let ownerUserId: number;
let outsiderUserId: number;
let generalPlayRoundId: number;
let outsiderRoundId: number;

beforeAll(async () => {
  const stamp = Date.now();

  const [org] = await db.insert(organizationsTable).values({
    name: `T1354_${stamp}`,
    slug: `t1354-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "T1354 Course",
    slug: `t1354-course-${stamp}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  const [oUser] = await db.insert(appUsersTable).values({
    replitUserId: `t1354-owner-${stamp}`,
    username: `t1354_owner_${stamp}`,
  }).returning({ id: appUsersTable.id });
  ownerUserId = oUser.id;

  const [xUser] = await db.insert(appUsersTable).values({
    replitUserId: `t1354-outsider-${stamp}`,
    username: `t1354_outsider_${stamp}`,
  }).returning({ id: appUsersTable.id });
  outsiderUserId = xUser.id;

  const [gpRound] = await db.insert(generalPlayRoundsTable).values({
    userId: ownerUserId,
    organizationId: orgId,
    courseId,
    holesPlayed: 18,
    status: "in_progress",
  }).returning({ id: generalPlayRoundsTable.id });
  generalPlayRoundId = gpRound.id;

  // A second casual round, owned by the outsider — used to drive the
  // "wrong user posting a snapshot pinned to someone else's round" 403 path.
  const [otherRound] = await db.insert(generalPlayRoundsTable).values({
    userId: outsiderUserId,
    organizationId: orgId,
    courseId,
    holesPlayed: 18,
    status: "in_progress",
  }).returning({ id: generalPlayRoundsTable.id });
  outsiderRoundId = otherRound.id;
});

afterAll(async () => {
  await db.delete(shotsTable).where(eq(shotsTable.generalPlayRoundId, generalPlayRoundId));
  await db.delete(shotsTable).where(eq(shotsTable.generalPlayRoundId, outsiderRoundId));
  await db.delete(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, generalPlayRoundId));
  await db.delete(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, outsiderRoundId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, ownerUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, outsiderUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

function ownerApp() {
  return createTestApp({
    id: ownerUserId, username: "t1354_owner", role: "member",
  });
}

function outsiderApp() {
  return createTestApp({
    id: outsiderUserId, username: "t1354_outsider", role: "member",
  });
}

/**
 * Insert a casual-round shot directly via Drizzle (bypassing the route
 * layer) so each test starts from a known (round, hole, shotNumber)
 * layout. The casual-round shape pins userId + generalPlayRoundId and
 * leaves the tournament-scoped fields null.
 */
async function insertShot(opts: {
  round: number; hole: number; shotNumber: number;
  shotType?: typeof shotsTable.$inferInsert["shotType"];
  club?: string | null;
}) {
  const [row] = await db.insert(shotsTable).values({
    userId: ownerUserId,
    generalPlayRoundId,
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
    eq(shotsTable.userId, ownerUserId),
    eq(shotsTable.generalPlayRoundId, generalPlayRoundId),
    eq(shotsTable.round, round),
    eq(shotsTable.holeNumber, hole),
  )).orderBy(asc(shotsTable.shotNumber));
  return rows;
}

describe("DELETE /portal/shots/:id + POST /portal/shots/restore — casual rounds (Task #1354)", () => {
  it("DELETE returns the full deletedShot snapshot with casual-round ownership fields", async () => {
    // Use a hole no other test touches so we can assert exact contents.
    const round = 1, hole = 11;
    const a = await insertShot({ round, hole, shotNumber: 1, shotType: "tee", club: "DR" });
    const b = await insertShot({ round, hole, shotNumber: 2, shotType: "approach", club: "7I" });

    const res = await request(ownerApp()).delete(`/api/portal/shots/${b.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      deletedId: b.id,
      // Only `a` remains on this hole, so resequencing visited 1 row.
      resequenced: 1,
    });
    expect(res.body.deletedShot).toBeDefined();
    expect(res.body.deletedShot.id).toBe(b.id);
    // Casual-round ownership shape: userId + generalPlayRoundId set,
    // tournamentId + playerId left null. This is the exact snapshot the
    // mobile client will echo back on Undo, so the field set MUST match
    // the route's "snap.generalPlayRoundId" branch in /portal/shots/restore.
    expect(res.body.deletedShot.userId).toBe(ownerUserId);
    expect(res.body.deletedShot.generalPlayRoundId).toBe(generalPlayRoundId);
    expect(res.body.deletedShot.tournamentId).toBeNull();
    expect(res.body.deletedShot.playerId).toBeNull();
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
      eq(shotsTable.generalPlayRoundId, generalPlayRoundId),
      eq(shotsTable.holeNumber, hole),
    ));
  });

  it("restore reinserts a casual-round shot at the original shotNumber and bumps later shots up", async () => {
    // Layout: shotNumbers 1, 2, 3 on this hole. Delete the middle one
    // (which then causes the trailing shot 3 to be resequenced to 2).
    // Restoring the snapshot must put it back at shotNumber=2 and shift
    // the now-2 shot up to 3 again.
    const round = 1, hole = 12;
    const a = await insertShot({ round, hole, shotNumber: 1, shotType: "tee", club: "DR" });
    const b = await insertShot({ round, hole, shotNumber: 2, shotType: "approach", club: "7I" });
    const c = await insertShot({ round, hole, shotNumber: 3, shotType: "putt", club: "PT" });

    const del = await request(ownerApp()).delete(`/api/portal/shots/${b.id}`);
    expect(del.status).toBe(200);
    expect(del.body.deletedShot.shotNumber).toBe(2);
    expect(del.body.deletedShot.generalPlayRoundId).toBe(generalPlayRoundId);

    // After delete + resequence, the previous shot 3 should now be at 2.
    let layout = await listShotNumbers(round, hole);
    expect(layout.map(r => r.shotNumber)).toEqual([1, 2]);
    expect(layout[0].id).toBe(a.id);
    expect(layout[1].id).toBe(c.id);

    const restore = await request(ownerApp())
      .post("/api/portal/shots/restore")
      .send(del.body.deletedShot);
    expect(restore.status).toBe(200);
    expect(restore.body).toMatchObject({ ok: true });
    expect(restore.body.shot).toBeDefined();
    // The restored row carries a NEW id (not the deleted one) but the
    // same logical position, scoped to the casual round.
    expect(restore.body.shot.id).not.toBe(b.id);
    expect(restore.body.shot.shotNumber).toBe(2);
    expect(restore.body.shot.shotType).toBe("approach");
    expect(restore.body.shot.club).toBe("7I");
    expect(restore.body.shot.userId).toBe(ownerUserId);
    expect(restore.body.shot.generalPlayRoundId).toBe(generalPlayRoundId);
    expect(restore.body.shot.tournamentId).toBeNull();
    expect(restore.body.shot.playerId).toBeNull();

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
      eq(shotsTable.generalPlayRoundId, generalPlayRoundId),
      eq(shotsTable.holeNumber, hole),
    ));
  });

  it("restore rejects a different user who doesn't own the casual round with 403", async () => {
    // Snapshot pinned to the owner's casual round; POST it as the
    // outsider — must be 403, and no row may land in the database.
    const round = 1, hole = 13;
    const snapshot = {
      generalPlayRoundId,
      userId: ownerUserId, // server should ignore and re-derive from the caller
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

    // The outsider's attempt must not have inserted a row in the
    // owner's round.
    const after = await listShotNumbers(round, hole);
    expect(after).toHaveLength(0);

    // Same shape, but pointed at the outsider's OWN round and POSTed
    // by the owner — also 403, since the owner doesn't own that round.
    const otherSnap = { ...snapshot, generalPlayRoundId: outsiderRoundId };
    const res2 = await request(ownerApp())
      .post("/api/portal/shots/restore")
      .send(otherSnap);
    expect(res2.status).toBe(403);

    const otherAfter = await db.select({ id: shotsTable.id }).from(shotsTable).where(and(
      eq(shotsTable.generalPlayRoundId, outsiderRoundId),
      eq(shotsTable.round, round),
      eq(shotsTable.holeNumber, hole),
    ));
    expect(otherAfter).toHaveLength(0);
  });

  it("restore rejects a snapshot that omits both tournamentId and generalPlayRoundId with 400", async () => {
    // Without either ownership anchor, the route can't decide which
    // branch to validate against — must reject with 400 and never
    // insert. Use a hole no other test touches so we can assert nothing
    // landed.
    const round = 1, hole = 16;
    const snapshot = {
      // tournamentId and generalPlayRoundId both intentionally omitted
      userId: ownerUserId,
      round,
      holeNumber: hole,
      shotNumber: 1,
      shotType: "tee",
      club: "DR",
      source: "manual",
    };

    const res = await request(ownerApp())
      .post("/api/portal/shots/restore")
      .send(snapshot);
    expect(res.status).toBe(400);
    expect(String(res.body?.error ?? "")).toMatch(/tournamentId.*generalPlayRoundId/i);

    // No row landed under the owner's casual round on this hole.
    const after = await listShotNumbers(round, hole);
    expect(after).toHaveLength(0);
  });
});
