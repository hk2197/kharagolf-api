/**
 * Task #2045 — POST /api/portal/coaching-tip-impression contract.
 *
 * Task #1641 already records *acted-on* coaching tips by tagging the
 * resulting practice session with `source='coaching_tip'`. That gives
 * us the numerator for "tip → practice conversion" but not the
 * denominator: we don't know how many tips were shown and ignored.
 *
 * Task #2045 adds a lightweight impression endpoint the web + mobile
 * stats screens call once per render of each "Work on This Club" card
 * (deduped client-side per session). This suite locks in:
 *
 *   1. A normal render call inserts one row keyed to the authed user
 *      with the supplied `clubKey` and `practiceDistanceYards`.
 *   2. `practiceDistanceYards: null` is allowed (a tip without a
 *      mapped practice distance still counts as shown).
 *   3. A missing or empty `clubKey` 400s — defensive guard so a buggy
 *      future client can't pollute the table with empty-key rows that
 *      would silently wreck the per-club conversion-rate join.
 *   4. Unauthenticated callers 401 (basic auth gate), so anonymous
 *      traffic can't inflate the denominator.
 *   5. Multiple impressions for the same user/club are accepted as
 *      independent rows — dedup is the *client's* job (per-session
 *      ref, see `kharagolf-web/src/pages/stats.tsx` and the mobile
 *      twin). The server intentionally stays append-only so an
 *      offline-buffered batch with backdated `shownAt` still lands.
 *   6. A custom `shownAt` ISO string is honoured so a future
 *      offline-buffered batch can backfill correctly without losing
 *      the original render time.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, appUsersTable, coachingTipImpressionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

let userId: number;

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `t2045-user-${stamp}`,
    username: `t2045_user_${stamp}`,
  }).returning({ id: appUsersTable.id });
  userId = u.id;
});

afterAll(async () => {
  // Cascade on `app_users.id` deletes the impression rows too, but we
  // delete explicitly first for symmetry with the rest of the suite.
  await db.delete(coachingTipImpressionsTable).where(eq(coachingTipImpressionsTable.userId, userId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
});

function asPlayerApp() {
  return createTestApp({ id: userId, username: "t2045_user", role: "member" });
}

async function rowsForUser() {
  return db
    .select()
    .from(coachingTipImpressionsTable)
    .where(eq(coachingTipImpressionsTable.userId, userId));
}

describe("POST /api/portal/coaching-tip-impression (Task #2045)", () => {
  it("inserts one row with the supplied clubKey + practiceDistanceYards", async () => {
    const before = (await rowsForUser()).length;

    const res = await request(asPlayerApp())
      .post("/api/portal/coaching-tip-impression")
      .send({ clubKey: "7i", practiceDistanceYards: 150 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      userId,
      clubKey: "7i",
      practiceDistanceYards: 150,
    });
    expect(typeof res.body.id).toBe("number");
    expect(typeof res.body.shownAt).toBe("string");

    const after = await rowsForUser();
    expect(after.length).toBe(before + 1);
  });

  it("accepts a tip with no mapped practice distance (null)", async () => {
    const res = await request(asPlayerApp())
      .post("/api/portal/coaching-tip-impression")
      .send({ clubKey: "pw", practiceDistanceYards: null });

    expect(res.status).toBe(201);
    expect(res.body.practiceDistanceYards).toBeNull();
    expect(res.body.clubKey).toBe("pw");
  });

  it("rejects a missing clubKey with 400 (no row written)", async () => {
    const before = (await rowsForUser()).length;

    const res = await request(asPlayerApp())
      .post("/api/portal/coaching-tip-impression")
      .send({ practiceDistanceYards: 150 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/clubKey/);
    expect((await rowsForUser()).length).toBe(before);
  });

  it("rejects an empty / whitespace clubKey with 400", async () => {
    const before = (await rowsForUser()).length;

    const res = await request(asPlayerApp())
      .post("/api/portal/coaching-tip-impression")
      .send({ clubKey: "   " });

    expect(res.status).toBe(400);
    expect((await rowsForUser()).length).toBe(before);
  });

  it("requires an authenticated player (401)", async () => {
    const res = await request(createTestApp())
      .post("/api/portal/coaching-tip-impression")
      .send({ clubKey: "7i", practiceDistanceYards: 150 });

    expect(res.status).toBe(401);
  });

  it("treats every call as an independent row — dedup is the client's job", async () => {
    // Use a club key not exercised by the other tests so the count is
    // unambiguous regardless of test ordering.
    const before = await db
      .select()
      .from(coachingTipImpressionsTable)
      .where(eq(coachingTipImpressionsTable.clubKey, "8i"));

    await request(asPlayerApp())
      .post("/api/portal/coaching-tip-impression")
      .send({ clubKey: "8i", practiceDistanceYards: 140 });
    await request(asPlayerApp())
      .post("/api/portal/coaching-tip-impression")
      .send({ clubKey: "8i", practiceDistanceYards: 140 });

    const after = await db
      .select()
      .from(coachingTipImpressionsTable)
      .where(eq(coachingTipImpressionsTable.clubKey, "8i"));

    expect(after.length).toBe(before.length + 2);
  });

  it("honours a client-supplied shownAt for offline-buffered backfills", async () => {
    const backdated = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const res = await request(asPlayerApp())
      .post("/api/portal/coaching-tip-impression")
      .send({ clubKey: "9i", practiceDistanceYards: 130, shownAt: backdated });

    expect(res.status).toBe(201);
    expect(new Date(res.body.shownAt).toISOString()).toBe(backdated);
  });
});
