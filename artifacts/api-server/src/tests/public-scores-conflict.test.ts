/**
 * Wave 1 W1-B — public score-upsert conflict detector.
 *
 * Synthesises a "two devices both edited this hole" scenario against
 *   POST /api/public/tournaments/:tournamentId/players/:playerId/scores
 * and asserts:
 *   1. First write succeeds and the response carries an `updatedAt` the
 *      mobile client can stash as `clientKnownAt` for the next save.
 *   2. A second device that posts with a stale `clientKnownAt` is rejected
 *      with HTTP 409 + the server's row + the rejected client payload — the
 *      contract the mobile conflict modal renders.
 *   3. A follow-up save that uses the server's freshly-returned `updatedAt`
 *      as `clientKnownAt` (the "Keep mine" path) succeeds and overwrites
 *      the row, confirming the resolver flow works end-to-end.
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
import { eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

let orgId: number;
let courseId: number;
let tournamentId: number;
let playerId: number;

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `W1B_${stamp}`, slug: `w1b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId, name: "W1B Course", slug: `w1b-course-${stamp}`,
    holes: 18, par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  const [tournament] = await db.insert(tournamentsTable).values({
    organizationId: orgId, courseId,
    name: `W1B Tournament ${stamp}`, status: "active",
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  tournamentId = tournament.id;

  const [player] = await db.insert(playersTable).values({
    tournamentId, firstName: "Conf", lastName: "Lict",
    email: `w1b-player-${stamp}@example.test`,
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

describe("POST /api/public/.../scores — sync-conflict detector (Wave 1 W1-B)", () => {
  it("flags 409 when a second device posts with a stale clientKnownAt, and lets the resolver overwrite", async () => {
    const app = createTestApp();
    const path = `/api/public/tournaments/${tournamentId}/players/${playerId}/scores`;

    // Device A posts the first score for hole 7 — no clientKnownAt yet.
    const deviceA1 = await request(app).post(path).send({
      round: 1, holeNumber: 7, strokes: 4, putts: 2,
    });
    expect(deviceA1.status).toBe(200);
    expect(deviceA1.body.strokes).toBe(4);
    expect(typeof deviceA1.body.updatedAt).toBe("string");
    const aKnownAt: string = deviceA1.body.updatedAt;

    // A few ms later device A bumps the row again — the server's updatedAt
    // moves forward, so any client still holding `aKnownAt` is now stale.
    await new Promise((r) => setTimeout(r, 25));
    const deviceA2 = await request(app).post(path).send({
      round: 1, holeNumber: 7, strokes: 5, putts: 2, clientKnownAt: aKnownAt,
    });
    expect(deviceA2.status).toBe(200);
    const newServerKnownAt: string = deviceA2.body.updatedAt;
    expect(new Date(newServerKnownAt).getTime()).toBeGreaterThan(new Date(aKnownAt).getTime());

    // Device B (still holding the original aKnownAt) tries to post a 6 —
    // the server should refuse with 409 and surface both payloads.
    const deviceB = await request(app).post(path).send({
      round: 1, holeNumber: 7, strokes: 6, putts: 3, clientKnownAt: aKnownAt,
    });
    expect(deviceB.status).toBe(409);
    expect(deviceB.body.conflict).toBe(true);
    expect(deviceB.body.server?.strokes).toBe(5);
    expect(deviceB.body.client?.strokes).toBe(6);
    expect(deviceB.body.client?.putts).toBe(3);

    // The resolver's "Keep mine" path: re-post with the server's fresh
    // updatedAt as clientKnownAt — the freshness check passes and the row
    // is overwritten with device B's value.
    const resolved = await request(app).post(path).send({
      round: 1, holeNumber: 7, strokes: 6, putts: 3, clientKnownAt: newServerKnownAt,
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.strokes).toBe(6);
    expect(resolved.body.putts).toBe(3);
  });

  it("accepts a save without clientKnownAt (legacy clients still work)", async () => {
    const app = createTestApp();
    const path = `/api/public/tournaments/${tournamentId}/players/${playerId}/scores`;
    const res = await request(app).post(path).send({
      round: 1, holeNumber: 8, strokes: 3,
    });
    expect(res.status).toBe(200);
    expect(res.body.strokes).toBe(3);
  });
});
