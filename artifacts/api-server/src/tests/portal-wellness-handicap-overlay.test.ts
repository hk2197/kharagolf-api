/**
 * Task #653 — Server coverage for the wellness/handicap overlay.
 *
 * GET /api/portal/wellness/daily?days=N now returns:
 *   { days, series, handicapTrend: [{ handicapIndex: number, recordedAt: string|null }, ...] }
 *
 * `handicapTrend` is sourced from the handicap_history table, filtered to
 * samples within the requested days window, ordered by recordedAt asc, and
 * reshaped so the mobile chart can overlay it directly. These tests pin:
 *
 *   1. The shape: every row has exactly { handicapIndex (number), recordedAt (ISO string) }
 *      and is ordered oldest-first.
 *   2. Filtering: rows older than `days` days ago are excluded; rows inside
 *      the window are included; switching `days=` re-filters the response.
 *   3. Empty: a player with no handicap history gets an empty array (not null),
 *      so the dashboard can render the empty-state gracefully.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  appUsersTable,
  handicapHistoryTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let userId: number;
let emptyUserId: number;
let actor: TestUser;
let emptyActor: TestUser;

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  const stamp = Date.now();

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `t653-player-${stamp}`,
    username: `t653_player_${stamp}`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  userId = u.id;

  const [empty] = await db.insert(appUsersTable).values({
    replitUserId: `t653-empty-${stamp}`,
    username: `t653_empty_${stamp}`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  emptyUserId = empty.id;

  // Seed handicap_history rows spanning ~120 days back.
  // Indices ascend so we can verify the response is ordered oldest-first.
  const now = Date.now();
  await db.insert(handicapHistoryTable).values([
    { userId, handicapIndex: "12.0", recordedAt: new Date(now - 100 * DAY_MS) },
    { userId, handicapIndex: "11.5", recordedAt: new Date(now - 45 * DAY_MS) },
    { userId, handicapIndex: "11.0", recordedAt: new Date(now - 20 * DAY_MS) },
    { userId, handicapIndex: "10.5", recordedAt: new Date(now - 5 * DAY_MS) },
    { userId, handicapIndex: "10.0", recordedAt: new Date(now - 1 * DAY_MS) },
  ]);

  actor = { id: userId, username: `t653_player_${stamp}`, role: "player" };
  emptyActor = { id: emptyUserId, username: `t653_empty_${stamp}`, role: "player" };
});

afterAll(async () => {
  await db.delete(handicapHistoryTable).where(eq(handicapHistoryTable.userId, userId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, emptyUserId));
});

describe("GET /api/portal/wellness/daily — handicapTrend overlay (Task #653)", () => {
  it("filters handicapTrend to the requested days window and shapes rows as { handicapIndex, recordedAt }", async () => {
    const res = await request(createTestApp(actor))
      .get("/api/portal/wellness/daily?days=30");

    expect(res.status).toBe(200);
    expect(res.body.days).toBe(30);
    expect(Array.isArray(res.body.series)).toBe(true);
    expect(Array.isArray(res.body.handicapTrend)).toBe(true);

    // Three samples within 30 days (20d ago, 5d ago, 1d ago) should be returned.
    // The 45d and 100d samples must be excluded.
    const trend = res.body.handicapTrend as Array<Record<string, unknown>>;
    expect(trend).toHaveLength(3);

    // Shape: each row is exactly { handicapIndex: number, recordedAt: string }.
    for (const row of trend) {
      expect(Object.keys(row).sort()).toEqual(["handicapIndex", "recordedAt"]);
      expect(typeof row.handicapIndex).toBe("number");
      expect(typeof row.recordedAt).toBe("string");
      // ISO-8601 round-trip safe.
      expect(Number.isNaN(Date.parse(row.recordedAt as string))).toBe(false);
    }

    // Ordered oldest-first: 20d-ago (11.0), 5d-ago (10.5), 1d-ago (10.0).
    const indices = trend.map((r) => r.handicapIndex as number);
    expect(indices).toEqual([11.0, 10.5, 10.0]);
    const timestamps = trend.map((r) => Date.parse(r.recordedAt as string));
    expect(timestamps[0]).toBeLessThan(timestamps[1]);
    expect(timestamps[1]).toBeLessThan(timestamps[2]);
  });

  it("widens the window when days= grows: 60 includes the 45-day-ago sample, 14 excludes the 20-day-ago sample", async () => {
    const wide = await request(createTestApp(actor))
      .get("/api/portal/wellness/daily?days=60");
    expect(wide.status).toBe(200);
    expect(wide.body.days).toBe(60);
    const wideIdx = (wide.body.handicapTrend as Array<{ handicapIndex: number }>).map(
      (r) => r.handicapIndex,
    );
    // 45d, 20d, 5d, 1d in scope; 100d still out.
    expect(wideIdx).toEqual([11.5, 11.0, 10.5, 10.0]);

    const narrow = await request(createTestApp(actor))
      .get("/api/portal/wellness/daily?days=14");
    expect(narrow.status).toBe(200);
    expect(narrow.body.days).toBe(14);
    const narrowIdx = (narrow.body.handicapTrend as Array<{ handicapIndex: number }>).map(
      (r) => r.handicapIndex,
    );
    // Only the 5d and 1d samples remain; the 20d sample is now outside the window.
    expect(narrowIdx).toEqual([10.5, 10.0]);
  });

  it("returns an empty handicapTrend (not null) when the player has no handicap history", async () => {
    const res = await request(createTestApp(emptyActor))
      .get("/api/portal/wellness/daily?days=30");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.handicapTrend)).toBe(true);
    expect(res.body.handicapTrend).toEqual([]);
  });

  it("requires authentication — anonymous callers get 401", async () => {
    const res = await request(createTestApp())
      .get("/api/portal/wellness/daily?days=30");
    expect(res.status).toBe(401);
  });
});
