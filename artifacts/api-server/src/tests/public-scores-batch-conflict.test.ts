/**
 * Task #1329 — automated coverage for the offline-replay batch flush
 * conflict path.
 *
 *   POST /api/public/tournaments/:tournamentId/players/:playerId/scores/batch
 *
 * Wave 1 W1-B contract: when a queued offline row carries a `clientKnownAt`
 * older than the server's current `updatedAt` for that hole, the server
 * MUST refuse to overwrite it and report the row in the response's
 * `conflicts` array. Other rows in the same batch are written normally.
 *
 * The bug this prevents: a phone that went offline at lunchtime flushes
 * its queue an hour later and silently clobbers a score that another
 * device (e.g. the marker's tablet) already corrected. We need automated
 * coverage so that regression cannot ship.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import { db } from "@workspace/db";
import {
  organizationsTable,
  coursesTable,
  tournamentsTable,
  playersTable,
  scoresTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

let orgId: number;
let courseId: number;
let tournamentId: number;
let playerId: number;

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `T1329_${stamp}`, slug: `t1329-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId, name: "T1329 Course", slug: `t1329-course-${stamp}`,
    holes: 18, par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: orgId, courseId,
    name: `T1329 Tournament ${stamp}`, status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  tournamentId = tournament.id;

  const [player] = await db.insert(playersTable).values({
    tournamentId, firstName: "Off", lastName: "Line",
    email: `t1329-player-${stamp}@example.test`,
  }).returning({ id: playersTable.id });
  playerId = player.id;
});

afterAll(async () => {
  await db.delete(scoresTable).where(eq(scoresTable.tournamentId, tournamentId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, tournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("POST /api/public/.../scores/batch — offline-replay conflict (Task #1329)", () => {
  it("writes the fresh row, leaves the stale row in the conflicts array, and does NOT overwrite the server's value", async () => {
    const app = createTestApp();
    const path = `/api/public/tournaments/${tournamentId}/players/${playerId}/scores/batch`;

    // Pre-seed hole 5 with the "tablet" device's value. This row's
    // updatedAt becomes the watermark the phone is racing.
    const [seeded] = await db.insert(scoresTable).values({
      tournamentId, playerId, round: 1, holeNumber: 5,
      strokes: 4, putts: 2, isVerified: false,
    }).returning();
    const tabletUpdatedAt: Date = seeded.updatedAt!;

    // The phone went offline BEFORE the tablet wrote. So its
    // clientKnownAt for hole 5 is older than the server's updatedAt —
    // this row must be reported as a conflict, not written.
    const stalePhoneKnownAt = new Date(tabletUpdatedAt.getTime() - 60_000).toISOString();

    // Hole 6 is brand new from the phone — no prior server row at all,
    // so the freshness check has nothing to compare against and the row
    // must be written.
    const res = await request(app).post(path).send({
      scores: [
        { round: 1, holeNumber: 5, strokes: 7, putts: 4, clientKnownAt: stalePhoneKnownAt },
        { round: 1, holeNumber: 6, strokes: 3, putts: 1 },
      ],
    });

    // Whole-batch shape: 409 (some rows conflicted) with one synced and
    // one conflict, exactly the contract the mobile flush handler expects.
    expect(res.status).toBe(409);
    expect(res.body.conflict).toBe(true);
    expect(res.body.synced).toBe(1);
    expect(Array.isArray(res.body.conflicts)).toBe(true);
    expect(res.body.conflicts).toHaveLength(1);

    const conflict = res.body.conflicts[0];
    expect(conflict.holeNumber).toBe(5);
    expect(conflict.round).toBe(1);
    // Server side of the conflict is the row the tablet wrote — NOT the
    // phone's queued 7. If this assertion ever flips, it means we silently
    // overwrote the marker's score, which is the regression #1329 guards.
    expect(conflict.server.strokes).toBe(4);
    expect(conflict.server.putts).toBe(2);
    expect(conflict.client.strokes).toBe(7);
    expect(conflict.client.putts).toBe(4);

    // Verify the database itself: hole 5 still has the tablet's value;
    // hole 6 was written by the phone.
    const [hole5] = await db.select().from(scoresTable).where(and(
      eq(scoresTable.tournamentId, tournamentId),
      eq(scoresTable.playerId, playerId),
      eq(scoresTable.round, 1),
      eq(scoresTable.holeNumber, 5),
    ));
    expect(hole5.strokes).toBe(4);
    expect(hole5.putts).toBe(2);

    const [hole6] = await db.select().from(scoresTable).where(and(
      eq(scoresTable.tournamentId, tournamentId),
      eq(scoresTable.playerId, playerId),
      eq(scoresTable.round, 1),
      eq(scoresTable.holeNumber, 6),
    ));
    expect(hole6.strokes).toBe(3);
    expect(hole6.putts).toBe(1);
  });

  it("returns 200 (no conflicts) when every row carries a fresh clientKnownAt", async () => {
    const app = createTestApp();
    const path = `/api/public/tournaments/${tournamentId}/players/${playerId}/scores/batch`;

    // Seed hole 7 so we have a server row with an updatedAt to compare against.
    const [seeded] = await db.insert(scoresTable).values({
      tournamentId, playerId, round: 1, holeNumber: 7,
      strokes: 5, putts: 2, isVerified: false,
    }).returning();
    const serverKnownAt = seeded.updatedAt!.toISOString();

    // Phone last saw the server row exactly when it was written, so its
    // clientKnownAt is fresh — server must accept the overwrite.
    const res = await request(app).post(path).send({
      scores: [
        { round: 1, holeNumber: 7, strokes: 6, putts: 3, clientKnownAt: serverKnownAt },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(1);
    expect(res.body.conflicts).toBeUndefined();

    const [hole7] = await db.select().from(scoresTable).where(and(
      eq(scoresTable.tournamentId, tournamentId),
      eq(scoresTable.playerId, playerId),
      eq(scoresTable.round, 1),
      eq(scoresTable.holeNumber, 7),
    ));
    expect(hole7.strokes).toBe(6);
    expect(hole7.putts).toBe(3);
  });
});
