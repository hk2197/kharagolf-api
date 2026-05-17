/**
 * Task #2047 — Coach/admin pins or unpins a player's SG baseline from the
 * admin Player Analytics view, with the change recorded in
 * `member_audit_log` so the action is attributable.
 *
 * The endpoint under test:
 *   PUT /api/portal/stats/:targetUserId/sg-baseline-preference
 *     → body { baseline: 'auto' | 'scratch' | '10' | '18' }
 *     → updates `app_users.preferred_sg_baseline` for the target player
 *       (mirrors the player-self PUT at `/portal/player/sg-baseline-preference`)
 *     → writes a `member_audit_log` row with entity='sg_baseline_preference',
 *       action='update', `actor_user_id` = the coach, `field_changes` = the
 *       from→to delta, and `reason` describing the pin/unpin.
 *
 * These tests cover:
 *   - Org-admin can pin a baseline for a player in their own org
 *   - Org-admin cannot pin for a player in a *different* org (403)
 *   - Players (no admin role) cannot use this route at all (403)
 *   - Super-admin can pin for any player
 *   - 'auto' clears the pin and re-enables auto-derivation for the player
 *   - The player's own GET /portal/stats reflects the coach's pin afterwards
 *     (ie. the "Player sees the pinned source copy when they next open Stats"
 *     part of the task acceptance criteria)
 *   - Audit row contains the from→to delta and is filed against the player's
 *     club-members row in the resolved org so it shows up on the Member 360
 *     audit timeline.
 *   - Invalid baseline values are rejected with 400.
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
  appUsersTable,
  orgMembershipsTable,
  clubMembersTable,
  memberAuditLogTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

let orgId: number;
let otherOrgId: number;
let courseId: number;
let tournamentId: number;
let playerUserId: number;
let coachUserId: number;
let outsiderCoachUserId: number;
let superAdminUserId: number;
let plainPlayerUserId: number;
let playerId: number;
let playerClubMemberId: number;

beforeAll(async () => {
  const stamp = Date.now();

  // ── Org #1 (the coach + the player both belong here) ────────────────
  const [org] = await db.insert(organizationsTable).values({
    name: `T2047_${stamp}`, slug: `t2047-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  // ── Org #2 (a coach who is NOT in the player's org — used for the
  //   cross-org forbidden case)
  const [other] = await db.insert(organizationsTable).values({
    name: `T2047_OTHER_${stamp}`, slug: `t2047-other-${stamp}`,
  }).returning({ id: organizationsTable.id });
  otherOrgId = other.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId, name: "T2047 Course", slug: `t2047-course-${stamp}`,
    holes: 18, par: 72,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  const [t] = await db.insert(tournamentsTable).values({
    organizationId: orgId, courseId,
    name: `T2047 Tournament ${stamp}`, status: "completed",
    startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
  }).returning({ id: tournamentsTable.id });
  tournamentId = t.id;

  // The player whose baseline gets pinned. 8.0 hcp lands them in the '10'
  // auto-pick band so we can clearly distinguish "auto" from a deliberate pin.
  const [pUser] = await db.insert(appUsersTable).values({
    replitUserId: `t2047-player-${stamp}`,
    username: `t2047_player_${stamp}`,
    email: `t2047-player-${stamp}@example.test`,
    displayName: "Pat Player",
  }).returning({ id: appUsersTable.id });
  playerUserId = pUser.id;

  // The coach who'll pin on the player's behalf.
  const [cUser] = await db.insert(appUsersTable).values({
    replitUserId: `t2047-coach-${stamp}`,
    username: `t2047_coach_${stamp}`,
    email: `t2047-coach-${stamp}@example.test`,
    displayName: "Coach K",
  }).returning({ id: appUsersTable.id });
  coachUserId = cUser.id;

  // A coach in a different org (used to assert the cross-org guard).
  const [oUser] = await db.insert(appUsersTable).values({
    replitUserId: `t2047-outsider-${stamp}`,
    username: `t2047_outsider_${stamp}`,
    email: `t2047-outsider-${stamp}@example.test`,
    displayName: "Outsider Coach",
  }).returning({ id: appUsersTable.id });
  outsiderCoachUserId = oUser.id;

  // A super-admin (allowed for any player).
  const [sUser] = await db.insert(appUsersTable).values({
    replitUserId: `t2047-super-${stamp}`,
    username: `t2047_super_${stamp}`,
    email: `t2047-super-${stamp}@example.test`,
    displayName: "Super Admin",
  }).returning({ id: appUsersTable.id });
  superAdminUserId = sUser.id;

  // A non-admin caller used to assert the role gate.
  const [ppUser] = await db.insert(appUsersTable).values({
    replitUserId: `t2047-plain-${stamp}`,
    username: `t2047_plain_${stamp}`,
    email: `t2047-plain-${stamp}@example.test`,
    displayName: "Plain Player",
  }).returning({ id: appUsersTable.id });
  plainPlayerUserId = ppUser.id;

  // Memberships. The player + coach both live in `orgId`; the outsider
  // coach lives in `otherOrgId`. The super-admin doesn't need an org link.
  await db.insert(orgMembershipsTable).values([
    { organizationId: orgId, userId: playerUserId, role: "player" },
    { organizationId: orgId, userId: coachUserId, role: "org_admin" },
    { organizationId: otherOrgId, userId: outsiderCoachUserId, role: "org_admin" },
  ]);

  // Player also has a club_members row so we can assert the audit row gets
  // linked to it (the Member 360 audit timeline filters by club_member_id).
  const [cm] = await db.insert(clubMembersTable).values({
    organizationId: orgId, userId: playerUserId,
    firstName: "Pat", lastName: "Player",
    email: `t2047-player-${stamp}@example.test`,
  }).returning({ id: clubMembersTable.id });
  playerClubMemberId = cm.id;

  const [p] = await db.insert(playersTable).values({
    tournamentId, userId: playerUserId,
    firstName: "Pat", lastName: "Player",
    email: `t2047-player-${stamp}@example.test`,
    handicapIndex: "8.0",
  }).returning({ id: playersTable.id });
  playerId = p.id;

  // 9-hole round so the SG block is non-null on the GET stats endpoint.
  const now = new Date();
  await db.insert(scoresTable).values(
    Array.from({ length: 9 }, (_, i) => ({
      tournamentId,
      playerId,
      round: 1,
      holeNumber: i + 1,
      strokes: 4,
      putts: 2,
      fairwayHit: true,
      girHit: true,
      submittedAt: now,
      updatedAt: now,
    })),
  );
});

afterAll(async () => {
  await db.delete(memberAuditLogTable).where(eq(memberAuditLogTable.entity, "sg_baseline_preference"));
  await db.delete(scoresTable).where(eq(scoresTable.tournamentId, tournamentId));
  await db.delete(playersTable).where(eq(playersTable.tournamentId, tournamentId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  await db.delete(coursesTable).where(eq(coursesTable.id, courseId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.id, playerClubMemberId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, orgId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, otherOrgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, playerUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, coachUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, outsiderCoachUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, superAdminUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, plainPlayerUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrgId));
});

function asCoach() {
  return createTestApp({ id: coachUserId, username: "t2047_coach", displayName: "Coach K", role: "org_admin", organizationId: orgId });
}
function asOutsiderCoach() {
  return createTestApp({ id: outsiderCoachUserId, username: "t2047_outsider", displayName: "Outsider", role: "org_admin", organizationId: otherOrgId });
}
function asSuper() {
  return createTestApp({ id: superAdminUserId, username: "t2047_super", displayName: "Super", role: "super_admin" });
}
function asPlainPlayer() {
  return createTestApp({ id: plainPlayerUserId, username: "t2047_plain", displayName: "Plain", role: "member" });
}
function asPlayerSelf() {
  return createTestApp({ id: playerUserId, username: "t2047_player", displayName: "Pat Player", role: "member", organizationId: orgId });
}

async function resetPlayerPin() {
  await db.update(appUsersTable)
    .set({ preferredSgBaseline: null })
    .where(eq(appUsersTable.id, playerUserId));
  await db.delete(memberAuditLogTable).where(eq(memberAuditLogTable.entity, "sg_baseline_preference"));
}

describe("PUT /portal/stats/:targetUserId/sg-baseline-preference — Task #2047", () => {
  it("lets an org-admin pin a baseline for a player in their own org and records the change in member_audit_log", async () => {
    await resetPlayerPin();

    const res = await request(asCoach())
      .put(`/api/portal/stats/${playerUserId}/sg-baseline-preference`)
      .send({ baseline: "scratch" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ targetUserId: playerUserId, preferredBaseline: "scratch" });

    // The persisted preference matches what was sent.
    const [u] = await db.select({ pref: appUsersTable.preferredSgBaseline })
      .from(appUsersTable).where(eq(appUsersTable.id, playerUserId));
    expect(u.pref).toBe("scratch");

    // Audit row exists, attributed to the coach, with from/to delta and
    // linked to the player's club_members row in the resolved org.
    const [audit] = await db.select()
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.entity, "sg_baseline_preference"),
        eq(memberAuditLogTable.entityId, playerUserId),
      ))
      .orderBy(desc(memberAuditLogTable.createdAt))
      .limit(1);
    expect(audit).toBeTruthy();
    expect(audit.action).toBe("update");
    expect(audit.actorUserId).toBe(coachUserId);
    expect(audit.actorRole).toBe("org_admin");
    expect(audit.organizationId).toBe(orgId);
    expect(audit.clubMemberId).toBe(playerClubMemberId);
    expect(audit.fieldChanges).toEqual({
      preferredSgBaseline: { from: "auto", to: "scratch" },
    });
    // Reason copy mentions the player's name + the human-readable cohort
    // label so it's readable in the Member 360 audit timeline.
    expect(audit.reason).toMatch(/Pinned SG baseline to Tour\/Scratch for Pat Player/);
  });

  it("the player's own GET /portal/stats reports the coach-pinned baseline as preferenced (acceptance criterion 3)", async () => {
    // The previous test left the pin as 'scratch' for this player.
    const res = await request(asPlayerSelf()).get("/api/portal/stats");
    expect(res.status).toBe(200);
    expect(res.body.strokesGained.preferredBaseline).toBe("scratch");
    expect(res.body.strokesGained.primaryBaseline).toBe("scratch");
    expect(res.body.strokesGained.baselineSource).toBe("preference");
  });

  it("clears the pin when 'auto' is sent and audits the from→to delta accordingly", async () => {
    // Player is still on 'scratch' from the first test.
    const res = await request(asCoach())
      .put(`/api/portal/stats/${playerUserId}/sg-baseline-preference`)
      .send({ baseline: "auto" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ targetUserId: playerUserId, preferredBaseline: "auto" });

    const [u] = await db.select({ pref: appUsersTable.preferredSgBaseline })
      .from(appUsersTable).where(eq(appUsersTable.id, playerUserId));
    expect(u.pref).toBeNull();

    const [audit] = await db.select()
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.entity, "sg_baseline_preference"),
        eq(memberAuditLogTable.entityId, playerUserId),
      ))
      .orderBy(desc(memberAuditLogTable.createdAt))
      .limit(1);
    expect(audit.fieldChanges).toEqual({
      preferredSgBaseline: { from: "scratch", to: "auto" },
    });
    expect(audit.reason).toMatch(/Cleared SG baseline pin/);
  });

  it("falls back to handicap-derived auto-pick on the player's GET after the coach unpins", async () => {
    const res = await request(asPlayerSelf()).get("/api/portal/stats");
    expect(res.status).toBe(200);
    expect(res.body.strokesGained.preferredBaseline).toBe("auto");
    expect(res.body.strokesGained.primaryBaseline).toBe("10"); // 8.0 hcp → '10' band
    expect(res.body.strokesGained.baselineSource).toBe("handicap");
  });

  it("forbids a coach from pinning a baseline for a player in a different org (403)", async () => {
    const res = await request(asOutsiderCoach())
      .put(`/api/portal/stats/${playerUserId}/sg-baseline-preference`)
      .send({ baseline: "scratch" });
    expect(res.status).toBe(403);

    // Persisted preference must be unchanged from the previous test.
    const [u] = await db.select({ pref: appUsersTable.preferredSgBaseline })
      .from(appUsersTable).where(eq(appUsersTable.id, playerUserId));
    expect(u.pref).toBeNull();
  });

  it("forbids a non-admin from using the route at all (403)", async () => {
    const res = await request(asPlainPlayer())
      .put(`/api/portal/stats/${playerUserId}/sg-baseline-preference`)
      .send({ baseline: "scratch" });
    expect(res.status).toBe(403);
  });

  it("lets a super-admin pin for any player", async () => {
    await resetPlayerPin();
    const res = await request(asSuper())
      .put(`/api/portal/stats/${playerUserId}/sg-baseline-preference`)
      .send({ baseline: "18" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ targetUserId: playerUserId, preferredBaseline: "18" });

    const [u] = await db.select({ pref: appUsersTable.preferredSgBaseline })
      .from(appUsersTable).where(eq(appUsersTable.id, playerUserId));
    expect(u.pref).toBe("18");
  });

  it("rejects unknown baseline values with 400", async () => {
    const res = await request(asCoach())
      .put(`/api/portal/stats/${playerUserId}/sg-baseline-preference`)
      .send({ baseline: "pro-tour" });
    expect(res.status).toBe(400);
  });

  it("rejects a missing baseline body with 400", async () => {
    const res = await request(asCoach())
      .put(`/api/portal/stats/${playerUserId}/sg-baseline-preference`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await request(createTestApp())
      .put(`/api/portal/stats/${playerUserId}/sg-baseline-preference`)
      .send({ baseline: "scratch" });
    expect(res.status).toBe(401);
  });
});
