/**
 * Task #852 — Scheduled sweep of stale gps_chunk_buffer rows.
 *
 * The per-(user,context) prune in shot-detection.ts only fires when the same
 * round is touched again by /portal/shots/ingest or /portal/shots/detect, so
 * abandoned rounds would otherwise leak rows in `gps_chunk_buffer` forever.
 * `sweepStaleGpsChunkBuffer` is the hourly cron that purges rows older than
 * the 8h TTL across every user, regardless of activity. This test inserts a
 * mix of fresh and stale rows and asserts the sweep deletes only the expired
 * ones (and reports the row count for the cron logger).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  appUsersTable,
  db,
  gpsChunkBufferTable,
  organizationsTable,
} from "@workspace/db";
import { sweepStaleGpsChunkBuffer } from "../lib/cron.js";

let orgId: number;
let userA: number;
let userB: number;
const CTX_ABANDONED = "g:852-abandoned:r:1";
const CTX_ACTIVE = "t:852-active:r:1";

const GPS_BUFFER_TTL_MS = 8 * 60 * 60 * 1000;

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `T852_${stamp}`,
    slug: `t852-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [a] = await db.insert(appUsersTable).values({
    replitUserId: `t852-a-${stamp}`,
    username: `t852-a-${stamp}`,
    email: `t852-a-${stamp}@example.com`,
  }).returning({ id: appUsersTable.id });
  userA = a.id;

  const [b] = await db.insert(appUsersTable).values({
    replitUserId: `t852-b-${stamp}`,
    username: `t852-b-${stamp}`,
    email: `t852-b-${stamp}@example.com`,
  }).returning({ id: appUsersTable.id });
  userB = b.id;
});

afterAll(async () => {
  await db.delete(gpsChunkBufferTable).where(inArray(gpsChunkBufferTable.userId, [userA, userB]));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [userA, userB]));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  await db.delete(gpsChunkBufferTable).where(inArray(gpsChunkBufferTable.userId, [userA, userB]));
});

async function insertRow(userId: number, contextKey: string, ageMs: number): Promise<void> {
  const ts = Date.now() - ageMs;
  await db.insert(gpsChunkBufferTable).values({
    userId,
    contextKey,
    sampleTimestampMs: String(ts),
    lat: "0.0",
    lng: "0.0",
  });
}

async function rowsFor(userId: number, contextKey: string): Promise<number> {
  const rows = await db
    .select({ id: gpsChunkBufferTable.id })
    .from(gpsChunkBufferTable)
    .where(and(
      eq(gpsChunkBufferTable.userId, userId),
      eq(gpsChunkBufferTable.contextKey, contextKey),
    ));
  return rows.length;
}

describe("sweepStaleGpsChunkBuffer (Task #852)", () => {
  it("deletes only rows older than the 8h TTL, leaving fresh rows intact", async () => {
    // Two stale rows for an abandoned round (10h and 9h old) — both beyond TTL.
    await insertRow(userA, CTX_ABANDONED, 10 * 60 * 60 * 1000);
    await insertRow(userA, CTX_ABANDONED, 9 * 60 * 60 * 1000);
    // One fresh row for a still-active round (1 min old) — well within TTL.
    await insertRow(userB, CTX_ACTIVE, 60_000);
    // Edge: a row exactly 1 min younger than the cutoff stays.
    await insertRow(userB, CTX_ACTIVE, GPS_BUFFER_TTL_MS - 60_000);

    const result = await sweepStaleGpsChunkBuffer();

    expect(result.removed).toBe(2);
    expect(await rowsFor(userA, CTX_ABANDONED)).toBe(0);
    expect(await rowsFor(userB, CTX_ACTIVE)).toBe(2);
  });

  it("is a no-op (and reports zero) when no rows are stale", async () => {
    await insertRow(userB, CTX_ACTIVE, 60_000);

    const result = await sweepStaleGpsChunkBuffer();

    expect(result.removed).toBe(0);
    expect(await rowsFor(userB, CTX_ACTIVE)).toBe(1);
  });

  it("sweeps across users — abandoned rounds from many players are all reaped", async () => {
    await insertRow(userA, CTX_ABANDONED, 12 * 60 * 60 * 1000);
    await insertRow(userB, "g:852-other:r:7", 9 * 60 * 60 * 1000);
    await insertRow(userB, CTX_ACTIVE, 60_000);

    const result = await sweepStaleGpsChunkBuffer();

    expect(result.removed).toBe(2);
    expect(await rowsFor(userA, CTX_ABANDONED)).toBe(0);
    expect(await rowsFor(userB, "g:852-other:r:7")).toBe(0);
    expect(await rowsFor(userB, CTX_ACTIVE)).toBe(1);
  });
});
