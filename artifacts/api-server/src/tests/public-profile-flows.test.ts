/**
 * Integration tests: public profile + privacy flow (Task #474).
 *
 * Covers the spans of code that turn a portal user's privacy choices into
 * what the world sees on /p/:handle, /scorecard/:shareToken, and the OG
 * preview crawlers consume:
 *
 *   1. PATCH /api/portal/me/public-profile validation
 *      - reserved handle names rejected (400)
 *      - malformed handles rejected (400)
 *      - duplicate handle rejected (409, uniqueness)
 *      - cannot enable a profile without first reserving a handle (400)
 *      - happy-path: lower-cases handle, persists toggles, clears handle
 *
 *   2. GET /api/public/p/:handle
 *      - returns 404 when handle does not exist
 *      - returns 404 when the profile is OFF
 *      - returns the JSON payload when the profile is ON
 *
 *   3. GET /api/public/scorecard/:shareToken
 *      - returns 404 when the per-card publicHidden flag is true
 *
 *   4. GET /api/public/p/:handle/og
 *      - returns HTML 404 when profile is off
 *      - returns HTML with og:* meta tags + JSON-LD Person schema when on
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  coursesTable,
  tournamentsTable,
  playersTable,
  shotsTable,
  userFollowsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgId: number;
let courseId: number;
let tournamentId: number;
let userAId: number;
let userBId: number;
let hiddenPlayerId: number;
let visiblePlayerId: number;
let userA: TestUser;
let userB: TestUser;

const stamp = Date.now();
const handleA = `golferalpha${stamp}`;
const handleB = `golferbeta${stamp}`;
const hiddenShareToken = `hidden-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
const visibleShareToken = `visible-${stamp}-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_PubProfile_${stamp}`,
    slug: `test-pubprofile-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: `Test Course ${stamp}`,
    slug: `test-course-${stamp}`,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  const [t] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `Test Tournament ${stamp}`,
    status: "active",
  }).returning({ id: tournamentsTable.id });
  tournamentId = t.id;

  const [a] = await db.insert(appUsersTable).values({
    replitUserId: `pubprof-a-${stamp}`,
    username: `pubprof_a_${stamp}`,
    email: `pubprof_a_${stamp}@example.com`,
    displayName: "Alpha Golfer",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userAId = a.id;

  const [b] = await db.insert(appUsersTable).values({
    replitUserId: `pubprof-b-${stamp}`,
    username: `pubprof_b_${stamp}`,
    email: `pubprof_b_${stamp}@example.com`,
    displayName: "Beta Golfer",
    role: "player",
    organizationId: orgId,
    publicHandle: handleB,
    publicProfileEnabled: true,
    publicBio: "Plays bogey golf and proud of it.",
    publicLocation: "Bengaluru, IN",
  }).returning({ id: appUsersTable.id });
  userBId = b.id;

  // A hidden scorecard owned by user B
  const [hp] = await db.insert(playersTable).values({
    tournamentId,
    userId: userBId,
    firstName: "Beta",
    lastName: "Golfer",
    shareToken: hiddenShareToken,
    publicHidden: true,
  }).returning({ id: playersTable.id });
  hiddenPlayerId = hp.id;

  const [vp] = await db.insert(playersTable).values({
    tournamentId,
    userId: userBId,
    firstName: "Beta",
    lastName: "Golfer",
    shareToken: visibleShareToken,
    publicHidden: false,
  }).returning({ id: playersTable.id });
  visiblePlayerId = vp.id;

  userA = { id: userAId, username: `pubprof_a_${stamp}`, role: "player", organizationId: orgId };
  userB = { id: userBId, username: `pubprof_b_${stamp}`, role: "player", organizationId: orgId };
});

afterAll(async () => {
  if (hiddenPlayerId || visiblePlayerId) {
    await db.delete(playersTable).where(inArray(playersTable.id, [hiddenPlayerId, visiblePlayerId].filter(Boolean) as number[]));
  }
  if (tournamentId) await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  if (courseId) await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  if (userAId) await db.delete(appUsersTable).where(eq(appUsersTable.id, userAId));
  if (userBId) await db.delete(appUsersTable).where(eq(appUsersTable.id, userBId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("PATCH /api/portal/me/public-profile — validation", () => {
  it("rejects malformed handles with 400", async () => {
    const app = createTestApp(userA);
    for (const bad of ["AB", "ab", "_starts_with_underscore", "has spaces", "thisistoolongahandlefortheservertoaccept123", "üñîçødé"]) {
      const r = await request(app)
        .patch("/api/portal/me/public-profile")
        .send({ publicHandle: bad });
      expect(r.status, `handle="${bad}"`).toBe(400);
      expect(typeof r.body.error).toBe("string");
    }
  });

  it("rejects reserved handle names with 400", async () => {
    const app = createTestApp(userA);
    for (const reserved of ["admin", "api", "www", "kharagolf", "support", "p", "scorecard", "clubs"]) {
      const r = await request(app)
        .patch("/api/portal/me/public-profile")
        .send({ publicHandle: reserved });
      expect(r.status, `handle="${reserved}"`).toBe(400);
    }
  });

  it("rejects a handle already taken by another user with 409", async () => {
    const app = createTestApp(userA);
    const r = await request(app)
      .patch("/api/portal/me/public-profile")
      .send({ publicHandle: handleB });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/already taken/i);
  });

  it("refuses to enable a public profile without first reserving a handle", async () => {
    // user A has no handle reserved at this point
    const app = createTestApp(userA);
    const r = await request(app)
      .patch("/api/portal/me/public-profile")
      .send({ publicProfileEnabled: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/reserve a handle/i);
  });

  it("accepts a valid handle, lowercases it, and persists privacy toggles", async () => {
    const app = createTestApp(userA);
    const upper = handleA.toUpperCase();
    const r = await request(app)
      .patch("/api/portal/me/public-profile")
      .send({
        publicHandle: upper,
        publicProfileEnabled: true,
        publicShowHandicap: false,
        publicShowAchievements: false,
        publicBio: "Just a weekend hacker.",
        publicLocation: "Mumbai, IN",
      });
    expect(r.status).toBe(200);
    expect(r.body.publicHandle).toBe(handleA);
    expect(r.body.publicProfileEnabled).toBe(true);
    expect(r.body.publicShowHandicap).toBe(false);
    expect(r.body.publicShowAchievements).toBe(false);
    expect(r.body.publicShowRecentRounds).toBe(true); // unchanged default
    expect(r.body.publicBio).toBe("Just a weekend hacker.");
    expect(r.body.publicLocation).toBe("Mumbai, IN");
  });

  it("allows clearing the handle by sending null", async () => {
    const app = createTestApp(userA);
    // First disable the profile since clearing the handle implicitly orphans
    // any "enabled" state; production code allows null even with enabled=true
    // but a paranoid client might toggle it off first.
    const r = await request(app)
      .patch("/api/portal/me/public-profile")
      .send({ publicHandle: null, publicProfileEnabled: false });
    expect(r.status).toBe(200);
    expect(r.body.publicHandle).toBeNull();
    expect(r.body.publicProfileEnabled).toBe(false);
  });

  it("returns 401 when called without an authenticated portal session", async () => {
    const app = createTestApp(); // no user
    const r = await request(app)
      .patch("/api/portal/me/public-profile")
      .send({ publicHandle: "nope" });
    expect(r.status).toBe(401);
  });
});

describe("GET /api/public/p/:handle — JSON profile gating", () => {
  it("returns 404 for an unknown handle", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/public/p/no-such-handle-${stamp}`);
    expect(r.status).toBe(404);
  });

  it("returns 404 when the user has a handle but the profile is OFF", async () => {
    // re-create handle on user A, profile off
    await db.update(appUsersTable)
      .set({ publicHandle: `${handleA}-off`, publicProfileEnabled: false })
      .where(eq(appUsersTable.id, userAId));
    const app = createTestApp();
    const r = await request(app).get(`/api/public/p/${handleA}-off`);
    expect(r.status).toBe(404);
  });

  it("returns the public profile JSON when enabled", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/public/p/${handleB}`);
    expect(r.status).toBe(200);
    expect(r.body.handle).toBe(handleB);
    expect(r.body.displayName).toBe("Beta Golfer");
    expect(r.body.bio).toBe("Plays bogey golf and proud of it.");
    expect(r.body.location).toBe("Bengaluru, IN");
    expect(r.body.privacy).toBeDefined();
    expect(r.body.deepLinks?.mobile).toBe(`kharagolf://profile/${handleB}`);
    expect(Array.isArray(r.body.recentRounds)).toBe(true);
    expect(Array.isArray(r.body.achievements)).toBe(true);
  });

  // Task #1738 — followers / following counts surfaced on the public
  // profile page. Visitors should see them next to the existing badges
  // without having to log in.
  it("returns followerCount=0 and followingCount=0 when nobody follows the user", async () => {
    // Make sure no follow rows exist for user B before checking the
    // baseline. The test isolates by user id so any leftover rows from
    // other tests in this file are scrubbed first.
    await db.delete(userFollowsTable).where(eq(userFollowsTable.followeeId, userBId));
    await db.delete(userFollowsTable).where(eq(userFollowsTable.followerId, userBId));
    const app = createTestApp();
    const r = await request(app).get(`/api/public/p/${handleB}`);
    expect(r.status).toBe(200);
    expect(r.body.followerCount).toBe(0);
    expect(r.body.followingCount).toBe(0);
  });

  it("returns the live followerCount and followingCount when follow rows exist", async () => {
    // user A follows user B → user B has 1 follower
    await db.insert(userFollowsTable).values({ followerId: userAId, followeeId: userBId });
    // user B follows user A → user B is following 1
    await db.insert(userFollowsTable).values({ followerId: userBId, followeeId: userAId });
    try {
      const app = createTestApp();
      const r = await request(app).get(`/api/public/p/${handleB}`);
      expect(r.status).toBe(200);
      expect(r.body.followerCount).toBe(1);
      expect(r.body.followingCount).toBe(1);
    } finally {
      await db.delete(userFollowsTable).where(eq(userFollowsTable.followeeId, userBId));
      await db.delete(userFollowsTable).where(eq(userFollowsTable.followerId, userBId));
    }
  });
});

describe("GET /api/public/scorecard/:shareToken — hidden cards 404", () => {
  it("returns 404 when the scorecard is marked publicHidden", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/public/scorecard/${hiddenShareToken}`);
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/scorecard not found/i);
  });

  it("returns 200 for a non-hidden scorecard sharing token", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/public/scorecard/${visibleShareToken}`);
    expect(r.status).toBe(200);
    // Confirms the privacy flag is the gate (and not a generic data-shape failure)
    expect(r.body.error).toBeUndefined();
  });

  it("returns HTML 404 from /scorecard/:shareToken/og when hidden", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/public/scorecard/${hiddenShareToken}/og`);
    expect(r.status).toBe(404);
    expect(r.headers["content-type"]).toMatch(/html/);
    expect(r.text).toMatch(/Scorecard not found/i);
  });
});

describe("GET /api/public/scorecard/:shareToken/source-breakdown/:round — shot-source badges (Task #1017)", () => {
  // The source-breakdown endpoint powers the Watch/Phone/Scorer/Manual %
  // badges on the shared scorecard page. It must:
  //   1. Resolve the player by shareToken (no auth)
  //   2. Aggregate shots in that player's tournament for the given round,
  //      grouped by `source`, returning {counts, total}
  //   3. Return 404 when the scorecard is `publicHidden` so we never leak
  //      shot-volume telemetry for cards the player chose to hide
  const breakdownRound = 7;

  beforeAll(async () => {
    // Seed shots from every supported source for the visible scorecard.
    // Mix of holes/shotNumbers to satisfy the unique
    // (player, tournament, round, hole, shotNumber) constraint while
    // exercising aggregation across multiple rows per source.
    const seed: Array<{ source: "watch" | "phone" | "scorer" | "manual"; hole: number; shotNumber: number }> = [
      { source: "watch", hole: 1, shotNumber: 1 },
      { source: "watch", hole: 1, shotNumber: 2 },
      { source: "watch", hole: 2, shotNumber: 1 },
      { source: "phone", hole: 3, shotNumber: 1 },
      { source: "phone", hole: 3, shotNumber: 2 },
      { source: "scorer", hole: 4, shotNumber: 1 },
      { source: "manual", hole: 5, shotNumber: 1 },
      { source: "manual", hole: 5, shotNumber: 2 },
      { source: "manual", hole: 5, shotNumber: 3 },
      { source: "manual", hole: 6, shotNumber: 1 },
    ];
    await db.insert(shotsTable).values(seed.map(s => ({
      tournamentId,
      playerId: visiblePlayerId,
      round: breakdownRound,
      holeNumber: s.hole,
      shotNumber: s.shotNumber,
      shotType: "fairway" as const,
      source: s.source,
    })));

    // A single shot in a different round to verify the endpoint filters by
    // round (this should NOT appear in the breakdownRound counts).
    await db.insert(shotsTable).values({
      tournamentId,
      playerId: visiblePlayerId,
      round: breakdownRound + 1,
      holeNumber: 1,
      shotNumber: 1,
      shotType: "fairway" as const,
      source: "watch",
    });

    // A shot belonging to the *hidden* player in the same round — the endpoint
    // must scope by player (via shareToken) so this should never bleed into
    // the visible card's counts.
    await db.insert(shotsTable).values({
      tournamentId,
      playerId: hiddenPlayerId,
      round: breakdownRound,
      holeNumber: 1,
      shotNumber: 1,
      shotType: "fairway" as const,
      source: "phone",
    });
  });

  it("returns the per-source counts and total for a visible scorecard's round", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/public/scorecard/${visibleShareToken}/source-breakdown/${breakdownRound}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      counts: { watch: 3, phone: 2, scorer: 1, manual: 4 },
      total: 10,
    });
  });

  it("returns zeroed counts for a round that has no shots yet", async () => {
    // The shared scorecard always tries to fetch a breakdown per round so
    // this contract matters: empty != 404 for visible cards.
    const app = createTestApp();
    const r = await request(app).get(`/api/public/scorecard/${visibleShareToken}/source-breakdown/99`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(0);
    expect(r.body.counts).toEqual({ watch: 0, phone: 0, scorer: 0, manual: 0 });
  });

  it("returns 404 when the scorecard is marked publicHidden", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/public/scorecard/${hiddenShareToken}/source-breakdown/${breakdownRound}`);
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/scorecard not found/i);
  });

  it("returns 404 for an unknown share token", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/public/scorecard/no-such-token-${stamp}/source-breakdown/${breakdownRound}`);
    expect(r.status).toBe(404);
  });

  it("returns 400 when the round path segment is not a number", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/public/scorecard/${visibleShareToken}/source-breakdown/not-a-round`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/invalid round/i);
  });
});

describe("GET /api/public/users/:userId/handle — userId → publicHandle resolver (Task #1457)", () => {
  // Mobile screens (leaderboards, league members, the /member/[userId]
  // stub, social feed, etc.) only know the integer appUsersTable.id of a
  // player. The resolver lets them route into the public profile viewer
  // (or the private member fallback) without each call site knowing the
  // handle up-front.
  it("returns the handle for a user with a reserved handle and publicProfileEnabled=true", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/public/users/${userBId}/handle`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ handle: handleB });
  });

  it("returns { handle: null } when publicProfileEnabled is false (caller falls back to private view)", async () => {
    // The earlier test suite already toggled user A's profile OFF with a
    // handle reserved (handleA-off). That user must still resolve to
    // null so the mobile stub keeps showing the private member card.
    const app = createTestApp();
    const r = await request(app).get(`/api/public/users/${userAId}/handle`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ handle: null });
  });

  it("returns { handle: null } for a user that exists but has no public handle reserved", async () => {
    // Wipe user A's handle entirely so we exercise the "no handle" branch.
    await db.update(appUsersTable)
      .set({ publicHandle: null, publicProfileEnabled: false })
      .where(eq(appUsersTable.id, userAId));
    const app = createTestApp();
    const r = await request(app).get(`/api/public/users/${userAId}/handle`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ handle: null });
  });

  it("returns { handle: null } for a user id that does not exist", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/public/users/9999999/handle`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ handle: null });
  });

  it("returns 400 when the userId path segment is not a positive integer", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/public/users/abc/handle`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/invalid userid/i);
  });

  it("rejects mixed alphanumeric input rather than silently truncating it", async () => {
    // Without strict integer validation parseInt("123abc") would return 123
    // and resolve a totally different user's handle than the one the caller
    // typed. Guard the resolver against that footgun explicitly.
    const app = createTestApp();
    const r = await request(app).get(`/api/public/users/${userAId}abc/handle`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/invalid userid/i);
  });
});

describe("POST /api/public/users/handles — batch userId → publicHandle resolver (Task #2234)", () => {
  // The leaderboard / leagues members tab pre-warms the React Query
  // handle cache for every visible row in a single request via this
  // endpoint, so the *first* tap on each player opens the public
  // profile (or private fallback) without a centred spinner.
  it("returns one entry per requested userId — handle when reserved+enabled, null otherwise", async () => {
    const app = createTestApp();
    const r = await request(app)
      .post("/api/public/users/handles")
      .send({ userIds: [userBId, userAId, 9999999] });
    expect(r.status).toBe(200);
    expect(r.body.handles).toEqual({
      [String(userBId)]: handleB,           // reserved + enabled
      [String(userAId)]: null,              // earlier test wiped A's handle
      "9999999": null,                      // unknown id still gets a null entry
    });
  });

  it("dedupes repeated userIds so the same player isn't returned twice", async () => {
    const app = createTestApp();
    const r = await request(app)
      .post("/api/public/users/handles")
      .send({ userIds: [userBId, userBId, userBId] });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.handles)).toEqual([String(userBId)]);
    expect(r.body.handles[String(userBId)]).toBe(handleB);
  });

  it("returns { handles: {} } for an empty array (no DB hit, no waste)", async () => {
    const app = createTestApp();
    const r = await request(app).post("/api/public/users/handles").send({ userIds: [] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ handles: {} });
  });

  it("silently drops non-integer / negative entries instead of failing the whole batch", async () => {
    // A single bad row in a leaderboard payload (string id, NaN, 0, …)
    // shouldn't stall pre-warming for everyone else on screen.
    const app = createTestApp();
    const r = await request(app)
      .post("/api/public/users/handles")
      .send({ userIds: [userBId, 0, -5, 1.5, "abc", null] });
    expect(r.status).toBe(200);
    expect(r.body.handles).toEqual({ [String(userBId)]: handleB });
  });

  it("rejects when userIds is not an array (400)", async () => {
    const app = createTestApp();
    const r = await request(app)
      .post("/api/public/users/handles")
      .send({ userIds: "not-an-array" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/userIds/i);
  });

  it("rejects oversize requests (max 200) so a runaway caller cannot scan the table", async () => {
    const app = createTestApp();
    const tooMany = Array.from({ length: 201 }, (_, i) => i + 1);
    const r = await request(app)
      .post("/api/public/users/handles")
      .send({ userIds: tooMany });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/too many/i);
  });
});

describe("GET /api/public/p/:handle/og — Open Graph + JSON-LD", () => {
  it("returns HTML 404 when the profile is OFF", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/public/p/no-such-${stamp}/og`);
    expect(r.status).toBe(404);
    expect(r.headers["content-type"]).toMatch(/html/);
    expect(r.text).toMatch(/Profile not found/i);
  });

  it("renders og:* meta tags, twitter card, canonical url, and a Person JSON-LD block", async () => {
    const app = createTestApp();
    const r = await request(app).get(`/api/public/p/${handleB}/og`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/html/);

    const html = r.text;
    // Core OG tags
    expect(html).toMatch(/<meta property="og:type" content="profile"/);
    expect(html).toMatch(/<meta property="og:title" content="Beta Golfer — KHARAGOLF"/);
    expect(html).toMatch(/<meta property="og:url" content="[^"]+\/p\/[^"]+"/);
    expect(html).toMatch(/<meta property="og:image" content="[^"]+"/);
    expect(html).toMatch(new RegExp(`<meta property="profile:username" content="${handleB}"`));
    // Twitter card
    expect(html).toMatch(/<meta name="twitter:card" content="summary_large_image"/);
    expect(html).toMatch(/<meta name="twitter:title" content="Beta Golfer — KHARAGOLF"/);
    // Canonical
    expect(html).toMatch(/<link rel="canonical" href="[^"]+\/p\/[^"]+"/);
    // JSON-LD block
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(m, "JSON-LD <script> block must be present").toBeTruthy();
    const ld = JSON.parse(m![1]);
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("Person");
    expect(ld.name).toBe("Beta Golfer");
    expect(ld.identifier).toBe(handleB);
    expect(ld.url).toMatch(new RegExp(`/p/${handleB}$`));
    expect(ld.address?.addressLocality).toBe("Bengaluru, IN");
  });
});
