/**
 * Integration + unit tests: Task #924 — Locked-badge progress hints in
 * shared social cards (`GET /api/public/p/:handle/badge/:type/og`).
 *
 * Task #925 widened the endpoint to rasterise the SVG to PNG (so social
 * crawlers like Facebook/LinkedIn that refuse SVG og:image still preview
 * properly). That broke the original assertions in this file, which were
 * grepping the response body for human-readable strings like
 * "BADGE UNLOCKED" — those strings only exist in the pre-rasterisation
 * SVG, not in the binary PNG bytes the endpoint actually returns.
 *
 * Task #1764 extracted the pure SVG builders into `lib/badgeOgSvg.ts`,
 * which lets us test the content of each card branch directly without
 * rasterising. The split below restores real coverage:
 *
 *   • Unit tests (`describe("badgeOgSvg helpers")`) drive the pure
 *     builders and pin the textual + structural contract for each
 *     branch — unlocked celebratory card, locked card with numeric
 *     progress, locked card without numeric progress.
 *   • Integration tests (`describe("GET …/badge/:type/og — endpoint")`)
 *     hit the real Express route for each branch and assert only the
 *     wire contract: HTTP status + Content-Type + (for 404s) empty body.
 *     The SVG/PNG bytes themselves are no longer greppable, so detailed
 *     content assertions live with the helpers.
 *
 * Together these pin the same six cases the original Task #924 tests
 * covered: unlocked card content, locked card with progress, locked
 * card without progress, two privacy gates, and unknown badge type.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  coursesTable,
  holeDetailsTable,
  tournamentsTable,
  playersTable,
  scoresTable,
  achievementsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTestApp, uid } from "./helpers.js";
import {
  buildBadgeOgUnlockedSvg,
  buildBadgeOgLockedSvg,
} from "../lib/badgeOgSvg.js";

// -----------------------------------------------------------------------
// Unit tests: pure SVG builders.
// These pin the visible content of each card branch without going through
// the rasteriser, so any regression in the chrome strings, badge label,
// progress hint, or progress-bar fill rect is caught by CI.
// -----------------------------------------------------------------------
describe("badgeOgSvg helpers — Task #924 card content", () => {
  it("unlocked card includes the celebratory chrome, badge label and earned line", () => {
    const svg = buildBadgeOgUnlockedSvg({
      icon: "🎯",
      badgeLabel: "First Tournament",
      badgeDescription: "Played your first tournament",
      name: "Unlocked Player",
      earnedLine: "Earned January 1, 2026 · @og_unlocked",
      badgeUnlockedLabel: "BADGE UNLOCKED",
    });
    expect(svg).toContain("BADGE UNLOCKED");
    expect(svg).toContain("First Tournament");
    expect(svg).toContain("Earned");
    expect(svg).toContain("@og_unlocked");
    // Unlocked card must NOT carry the locked-state chrome or fill bar.
    expect(svg).not.toContain("ALMOST THERE");
    expect(svg).not.toContain('fill="url(#barFill)"');
  });

  it("locked card with numeric progress shows 'X of Y' hint and a progress fill", () => {
    const svg = buildBadgeOgLockedSvg({
      icon: "⛳",
      badgeLabel: "Ten Rounds",
      badgeDescription: "Complete 10 rounds",
      name: "Locked Player",
      handle: "og_locked",
      almostThereLabel: "ALMOST THERE",
      progressLabel: "2 of 10",
      progressFraction: 0.2,
    });
    expect(svg).toContain("ALMOST THERE");
    expect(svg).toContain("Ten Rounds");
    expect(svg).toContain("2 of 10");
    // Progress bar fill rect uses url(#barFill); it is only emitted when
    // current > 0, so its presence pins the "has progress" branch.
    expect(svg).toContain('fill="url(#barFill)"');
    // Footer carries the player name and @handle attribution.
    expect(svg).toContain("Locked Player");
    expect(svg).toContain("@og_locked");
    // Locked card must NOT include the unlocked-banner chrome.
    expect(svg).not.toContain("BADGE UNLOCKED");
  });

  it("locked card without numeric progress shows the generic 'keep playing' hint and no fill bar", () => {
    const svg = buildBadgeOgLockedSvg({
      icon: "🐦",
      badgeLabel: "First Birdie",
      badgeDescription: "Score your first birdie",
      name: "Locked Player",
      handle: "og_locked",
      almostThereLabel: "ALMOST THERE",
      progressLabel: "Keep playing to unlock",
      progressFraction: 0,
    });
    expect(svg).toContain("ALMOST THERE");
    expect(svg).toContain("First Birdie");
    expect(svg).toContain("Keep playing to unlock");
    // No "X of Y" hint and no progress fill rect for non-numeric badges.
    expect(svg).not.toMatch(/\d+ of \d+/);
    expect(svg).not.toContain('fill="url(#barFill)"');
    expect(svg).not.toContain("BADGE UNLOCKED");
  });
});

// -----------------------------------------------------------------------
// Integration tests: HTTP wire contract per branch.
// Body content is binary PNG (rasterised from the SVG via @resvg/resvg-js)
// and is intentionally NOT greppable here — those assertions live with
// the helpers above. We pin only the status code, Content-Type, and (for
// 404s) that no real body is leaked.
// -----------------------------------------------------------------------
let orgId: number;
let courseId: number;
let unlockedUserId: number;
let lockedUserId: number;
let hiddenUserId: number;
let privateUserId: number;
let tournamentId: number;
let playerId: number;

const unlockedHandle = `og_unlocked_${Date.now()}`;
const lockedHandle = `og_locked_${Date.now()}`;
const hiddenHandle = `og_hidden_${Date.now()}`;
const privateHandle = `og_private_${Date.now()}`;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `OG_Badge_Org_${uid()}`,
    slug: `og-badge-${uid()}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "OG Badge Course",
    slug: `og-badge-course-${uid()}`,
    holes: 9,
    par: 36,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  await db.insert(holeDetailsTable).values(
    Array.from({ length: 9 }, (_, i) => ({ courseId, holeNumber: i + 1, par: 4 })),
  );

  const [t] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    courseId,
    name: `OG Badge T_${uid()}`,
    format: "stroke_play",
    status: "active",
    startDate: new Date(),
    endDate: new Date(),
    maxPlayers: 16,
  }).returning({ id: tournamentsTable.id });
  tournamentId = t.id;

  // Unlocked user — has the first_tournament badge in achievements table.
  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `og-u-${uid()}`,
    username: `og_unlocked_${uid()}`,
    email: `og_unlocked_${uid()}@example.com`,
    role: "player",
    organizationId: orgId,
    publicHandle: unlockedHandle,
    publicProfileEnabled: true,
    publicShowAchievements: true,
    displayName: "Unlocked Player",
  }).returning({ id: appUsersTable.id });
  unlockedUserId = u1.id;
  await db.insert(achievementsTable).values({
    userId: unlockedUserId,
    badgeType: "first_tournament",
    badgeLabel: "First Tournament",
    badgeIcon: "🎯",
    badgeCategory: "milestone",
    organizationId: orgId,
    tournamentId,
  });

  // Locked user — has played 2 completed 9-hole rounds toward the
  // 10_rounds badge (2 of 10) and is public. We keep the score rows so
  // the locked branch exercises computeBadgeProgress end-to-end even
  // though the integration test only asserts the wire contract.
  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `og-u-${uid()}`,
    username: `og_locked_${uid()}`,
    email: `og_locked_${uid()}@example.com`,
    role: "player",
    organizationId: orgId,
    publicHandle: lockedHandle,
    publicProfileEnabled: true,
    publicShowAchievements: true,
    displayName: "Locked Player",
  }).returning({ id: appUsersTable.id });
  lockedUserId = u2.id;

  const [p] = await db.insert(playersTable).values({
    tournamentId,
    userId: lockedUserId,
    firstName: "Locked",
    lastName: "Player",
    email: `og_locked_player_${uid()}@example.com`,
  }).returning({ id: playersTable.id });
  playerId = p.id;

  for (const round of [1, 2]) {
    await db.insert(scoresTable).values(
      Array.from({ length: 9 }, (_, i) => ({
        playerId,
        tournamentId,
        round,
        holeNumber: i + 1,
        strokes: 4,
      })),
    );
  }

  // Hidden user — public profile, but achievements are hidden.
  const [u3] = await db.insert(appUsersTable).values({
    replitUserId: `og-u-${uid()}`,
    username: `og_hidden_${uid()}`,
    email: `og_hidden_${uid()}@example.com`,
    role: "player",
    organizationId: orgId,
    publicHandle: hiddenHandle,
    publicProfileEnabled: true,
    publicShowAchievements: false,
    displayName: "Hidden Player",
  }).returning({ id: appUsersTable.id });
  hiddenUserId = u3.id;

  // Private user — public profile is disabled entirely.
  const [u4] = await db.insert(appUsersTable).values({
    replitUserId: `og-u-${uid()}`,
    username: `og_private_${uid()}`,
    email: `og_private_${uid()}@example.com`,
    role: "player",
    organizationId: orgId,
    publicHandle: privateHandle,
    publicProfileEnabled: false,
    publicShowAchievements: true,
    displayName: "Private Player",
  }).returning({ id: appUsersTable.id });
  privateUserId = u4.id;
});

afterAll(async () => {
  await db.delete(achievementsTable).where(eq(achievementsTable.userId, unlockedUserId));
  await db.delete(scoresTable).where(eq(scoresTable.playerId, playerId));
  await db.delete(playersTable).where(eq(playersTable.id, playerId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(holeDetailsTable).where(eq(holeDetailsTable.courseId, courseId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(appUsersTable).where(
    and(eq(appUsersTable.organizationId, orgId)),
  );
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

describe("GET /api/public/p/:handle/badge/:type/og — endpoint wire contract (Task #925)", () => {
  it("returns 200 image/png for an unlocked badge on a public profile", async () => {
    const app = createTestApp();
    const res = await request(app)
      .get(`/api/public/p/${unlockedHandle}/badge/first_tournament/og`)
      .buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
    expect(Buffer.isBuffer(res.body) ? res.body.length : 0).toBeGreaterThan(0);
  });

  it("returns 200 image/png for a locked badge with numeric progress", async () => {
    const app = createTestApp();
    const res = await request(app)
      .get(`/api/public/p/${lockedHandle}/badge/10_rounds/og`)
      .buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
    expect(Buffer.isBuffer(res.body) ? res.body.length : 0).toBeGreaterThan(0);
  });

  it("returns 200 image/png for a locked badge without numeric progress", async () => {
    const app = createTestApp();
    const res = await request(app)
      .get(`/api/public/p/${lockedHandle}/badge/first_birdie/og`)
      .buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
    expect(Buffer.isBuffer(res.body) ? res.body.length : 0).toBeGreaterThan(0);
  });

  it("returns 404 image/png with empty body when achievements are hidden", async () => {
    const app = createTestApp();
    const res = await request(app)
      .get(`/api/public/p/${hiddenHandle}/badge/10_rounds/og`)
      .buffer(true);
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
    // Privacy gate: do not leak any rendered card body.
    expect(Buffer.isBuffer(res.body) ? res.body.length : 0).toBe(0);
    void hiddenUserId;
  });

  it("returns 404 image/png with empty body when the public profile is disabled", async () => {
    const app = createTestApp();
    const res = await request(app)
      .get(`/api/public/p/${privateHandle}/badge/first_birdie/og`)
      .buffer(true);
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
    expect(Buffer.isBuffer(res.body) ? res.body.length : 0).toBe(0);
    void privateUserId;
  });

  it("returns 404 image/png with empty body for an unknown badge type", async () => {
    const app = createTestApp();
    const res = await request(app)
      .get(`/api/public/p/${lockedHandle}/badge/not_a_real_badge/og`)
      .buffer(true);
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
    expect(Buffer.isBuffer(res.body) ? res.body.length : 0).toBe(0);
  });
});
