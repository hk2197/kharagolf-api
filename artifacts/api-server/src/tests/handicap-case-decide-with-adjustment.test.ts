/**
 * Integration tests: POST /cases/:caseId/decide — combined committee
 * decision + handicap adjustment in a single request (Task #458).
 *
 * Covers:
 *   • Happy path for each of the three decision kinds that may carry a
 *     `createAdjustment` payload (index_adjustment / soft_cap / hard_cap),
 *     verifying the adjustment row is written, linked back into the case,
 *     and surfaced in the case audit log.
 *   • Validation errors:
 *       – positive strokes required for index_adjustment
 *       – capValue must be in 0..54 for soft/hard cap
 *       – mutual exclusion of adjustmentId and createAdjustment
 *       – createAdjustment is rejected for a no_action decision
 *   • Player-resolution fallback when the case has no playerId — the
 *     subject user's most recent player row in the org is used.
 *   • Audit-log linkage: the "decided" entry payload carries the new
 *     adjustment id so the chronology renders the link.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/comms.js", () => ({
  sendTransactionalPush: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 })),
  sendTransactionalSms: vi.fn(async () => undefined),
  sendBroadcast: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0, invalid: 0 })),
}));

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  coursesTable,
  tournamentsTable,
  playersTable,
  handicapReviewCasesTable,
  handicapCaseAuditLogTable,
  handicapCaseNotificationsTable,
  handicapAdjustmentsTable,
  type HandicapReviewCase,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

let testOrgId: number;
let testCourseId: number;
let testTournamentId: number;
let secondTournamentId: number;
let adminUserId: number;
let subjectUserId: number;
let primaryPlayerId: number;       // newer player row (used by fallback)
let secondaryPlayerId: number;     // older player row
let app: ReturnType<typeof createTestApp>;

const createdCaseIds: number[] = [];

beforeAll(async () => {
  const ts = Date.now();

  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_DecideAdjust_${ts}`,
    slug: `test-decide-adjust-${ts}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [course] = await db.insert(coursesTable).values({
    organizationId: testOrgId,
    name: "Decide-Adjust Course",
    slug: `decide-adjust-course-${ts}`,
    holes: 18,
    par: 72,
  }).returning({ id: coursesTable.id });
  testCourseId = course.id;

  const [t1] = await db.insert(tournamentsTable).values({
    organizationId: testOrgId,
    courseId: testCourseId,
    name: `Decide-Adjust T1 ${ts}`,
    format: "stroke_play",
    status: "upcoming",
    startDate: new Date(Date.now() + 7 * 86_400_000),
    endDate: new Date(Date.now() + 8 * 86_400_000),
    maxPlayers: 32,
  }).returning({ id: tournamentsTable.id });
  testTournamentId = t1.id;

  const [t2] = await db.insert(tournamentsTable).values({
    organizationId: testOrgId,
    courseId: testCourseId,
    name: `Decide-Adjust T2 ${ts}`,
    format: "stroke_play",
    status: "upcoming",
    startDate: new Date(Date.now() + 14 * 86_400_000),
    endDate: new Date(Date.now() + 15 * 86_400_000),
    maxPlayers: 32,
  }).returning({ id: tournamentsTable.id });
  secondTournamentId = t2.id;

  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `decide-admin-${ts}`,
    username: `decide_admin_${ts}`,
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = admin.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: testOrgId,
    userId: adminUserId,
    role: "org_admin",
  });

  const [subject] = await db.insert(appUsersTable).values({
    replitUserId: `decide-subject-${ts}`,
    username: `decide_subject_${ts}`,
    displayName: "Subject Player",
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  subjectUserId = subject.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: testOrgId,
    userId: subjectUserId,
    role: "player",
  });

  // Older player row (registered first, lower id).
  const [pOld] = await db.insert(playersTable).values({
    tournamentId: testTournamentId,
    userId: subjectUserId,
    firstName: "Subject",
    lastName: "Player",
    handicapIndex: "12.0",
  }).returning({ id: playersTable.id });
  secondaryPlayerId = pOld.id;

  // Newer player row — should be picked by fallback (ORDER BY id DESC).
  const [pNew] = await db.insert(playersTable).values({
    tournamentId: secondTournamentId,
    userId: subjectUserId,
    firstName: "Subject",
    lastName: "Player",
    handicapIndex: "10.0",
  }).returning({ id: playersTable.id });
  primaryPlayerId = pNew.id;

  app = createTestApp({
    id: adminUserId,
    username: `decide_admin_${ts}`,
    role: "org_admin",
    organizationId: testOrgId,
  });
});

afterAll(async () => {
  // Order: notifications → audit → cases → adjustments → players → tournaments → memberships → users → course → org
  if (createdCaseIds.length > 0) {
    for (const id of createdCaseIds) {
      await db.delete(handicapCaseNotificationsTable).where(eq(handicapCaseNotificationsTable.caseId, id));
      await db.delete(handicapCaseAuditLogTable).where(eq(handicapCaseAuditLogTable.caseId, id));
    }
  }
  await db.delete(handicapReviewCasesTable).where(eq(handicapReviewCasesTable.organizationId, testOrgId));
  await db.delete(handicapAdjustmentsTable).where(eq(handicapAdjustmentsTable.organizationId, testOrgId));
  await db.delete(playersTable).where(eq(playersTable.userId, subjectUserId));
  await db.delete(tournamentsTable).where(eq(tournamentsTable.organizationId, testOrgId));
  await db.delete(coursesTable).where(eq(coursesTable.id, testCourseId));
  await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, testOrgId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, subjectUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

// ── Helpers ────────────────────────────────────────────────────────────────

/** Insert a fresh `open` case attached to a specific player row (or none). */
async function makeCase(opts: { playerId: number | null; kind?: string } = { playerId: primaryPlayerId }): Promise<HandicapReviewCase> {
  // Cases are seeded in `assigned` state so the `open → decided` jump
  // (which the state machine forbids) is not the cause of a 400; this lets
  // the tests focus on adjustment-payload behaviour.
  const [row] = await db.insert(handicapReviewCasesTable).values({
    organizationId: testOrgId,
    subjectUserId,
    kind: opts.kind ?? "exceptional",
    status: "assigned",
    playerId: opts.playerId,
    details: "Fixture case",
  }).returning();
  createdCaseIds.push(row.id);
  return row;
}

const decideUrl = (caseId: number) => `/api/organizations/${testOrgId}/handicap/cases/${caseId}/decide`;

beforeEach(() => {
  // Each test gets its own case, no shared state between scenarios.
});

// ── Happy paths ────────────────────────────────────────────────────────────

describe("POST /cases/:caseId/decide — combined create-adjustment happy paths", () => {
  it("index_adjustment: creates adjustment, links it to case + audit log", async () => {
    const c = await makeCase({ playerId: primaryPlayerId });

    const res = await request(app).post(decideUrl(c.id)).send({
      decision: "index_adjustment",
      rationale: "Three exceptional rounds in two weeks",
      createAdjustment: { adjustmentStrokes: 1.5, notes: "Bumped per committee vote" },
    });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("decided");
    expect(res.body.decision).toBe("index_adjustment");
    expect(typeof res.body.adjustmentId).toBe("number");

    const [adj] = await db.select().from(handicapAdjustmentsTable)
      .where(eq(handicapAdjustmentsTable.id, res.body.adjustmentId));
    expect(adj).toBeDefined();
    expect(adj.organizationId).toBe(testOrgId);
    expect(adj.playerId).toBe(primaryPlayerId);
    expect(adj.adjustedByUserId).toBe(adminUserId);
    expect(Number(adj.adjustmentStrokes)).toBe(1.5);
    // previous = 10.0 (newer player row), new = 10.0 + 1.5 = 11.5
    expect(Number(adj.previousHandicapIndex)).toBe(10.0);
    expect(Number(adj.newHandicapIndex)).toBe(11.5);
    expect(adj.committeeNotes).toBe("Bumped per committee vote");
    expect(adj.adjustmentReason).toMatch(/index_adjustment/);
    expect(adj.adjustmentReason).toMatch(/Three exceptional rounds/);

    // Audit log links the new adjustment.
    const audits = await db.select().from(handicapCaseAuditLogTable)
      .where(and(eq(handicapCaseAuditLogTable.caseId, c.id), eq(handicapCaseAuditLogTable.action, "decided")));
    expect(audits).toHaveLength(1);
    expect((audits[0].payload as Record<string, unknown> | null)?.adjustmentId).toBe(res.body.adjustmentId);
  });

  it("soft_cap: clamps current HI down to capValue and records strokes delta as 0", async () => {
    const c = await makeCase({ playerId: primaryPlayerId });

    const res = await request(app).post(decideUrl(c.id)).send({
      decision: "soft_cap",
      rationale: "Soft cap pending more rounds",
      createAdjustment: { capValue: 9.0 },
    });

    expect(res.status).toBe(200);
    const [adj] = await db.select().from(handicapAdjustmentsTable)
      .where(eq(handicapAdjustmentsTable.id, res.body.adjustmentId));
    expect(Number(adj.newHandicapIndex)).toBe(9.0);
    // current=10.0, cap=9.0 → strokes = max(0, 9.0 - 10.0) = 0
    expect(Number(adj.adjustmentStrokes)).toBe(0);
  });

  it("hard_cap: applies cap and records the upward stroke delta when cap > current", async () => {
    const c = await makeCase({ playerId: primaryPlayerId });

    const res = await request(app).post(decideUrl(c.id)).send({
      decision: "hard_cap",
      rationale: "Hard cap to halt further drift",
      createAdjustment: { capValue: 12.0 },
    });

    expect(res.status).toBe(200);
    const [adj] = await db.select().from(handicapAdjustmentsTable)
      .where(eq(handicapAdjustmentsTable.id, res.body.adjustmentId));
    expect(Number(adj.newHandicapIndex)).toBe(12.0);
    // current=10.0, cap=12.0 → strokes = 2.0
    expect(Number(adj.adjustmentStrokes)).toBe(2);
  });
});

// ── Player-resolution fallback ────────────────────────────────────────────

describe("POST /cases/:caseId/decide — player resolution fallback", () => {
  it("uses the subject user's most recent player row when case.playerId is null", async () => {
    const c = await makeCase({ playerId: null });

    const res = await request(app).post(decideUrl(c.id)).send({
      decision: "index_adjustment",
      rationale: "Fallback resolution test",
      createAdjustment: { adjustmentStrokes: 0.5 },
    });

    expect(res.status).toBe(200);
    const [adj] = await db.select().from(handicapAdjustmentsTable)
      .where(eq(handicapAdjustmentsTable.id, res.body.adjustmentId));
    // Newest player row (highest id) belongs to the second tournament with HI 10.0.
    expect(adj.playerId).toBe(primaryPlayerId);
    expect(Number(adj.previousHandicapIndex)).toBe(10.0);
    expect(Number(adj.newHandicapIndex)).toBe(10.5);
  });
});

// ── Validation errors ─────────────────────────────────────────────────────

describe("POST /cases/:caseId/decide — validation rejects malformed createAdjustment", () => {
  it("rejects no_action + createAdjustment (cannot apply HI change to no_action)", async () => {
    const c = await makeCase({ playerId: primaryPlayerId });

    const res = await request(app).post(decideUrl(c.id)).send({
      decision: "no_action",
      rationale: "No action warranted",
      createAdjustment: { adjustmentStrokes: 1.0 },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no_action/);

    // Case must remain untouched, no adjustment row created.
    const [after] = await db.select().from(handicapReviewCasesTable).where(eq(handicapReviewCasesTable.id, c.id));
    expect(after.status).toBe("assigned");
    expect(after.adjustmentId).toBeNull();
  });

  it("rejects index_adjustment with non-positive strokes", async () => {
    const c = await makeCase({ playerId: primaryPlayerId });

    const res = await request(app).post(decideUrl(c.id)).send({
      decision: "index_adjustment",
      rationale: "Bad strokes value",
      createAdjustment: { adjustmentStrokes: 0 },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/adjustmentStrokes/);

    const [after] = await db.select().from(handicapReviewCasesTable).where(eq(handicapReviewCasesTable.id, c.id));
    expect(after.status).toBe("assigned");
  });

  it("rejects soft_cap with capValue out of range (>54)", async () => {
    const c = await makeCase({ playerId: primaryPlayerId });

    const res = await request(app).post(decideUrl(c.id)).send({
      decision: "soft_cap",
      rationale: "Cap out of range",
      createAdjustment: { capValue: 99 },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/capValue/);
  });

  it("rejects hard_cap with negative capValue", async () => {
    const c = await makeCase({ playerId: primaryPlayerId });

    const res = await request(app).post(decideUrl(c.id)).send({
      decision: "hard_cap",
      rationale: "Negative cap",
      createAdjustment: { capValue: -1 },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/capValue/);
  });

  it("rejects providing both adjustmentId and createAdjustment", async () => {
    const c = await makeCase({ playerId: primaryPlayerId });

    // Pre-create a real adjustment row to satisfy the FK existence check.
    const [adj] = await db.insert(handicapAdjustmentsTable).values({
      organizationId: testOrgId,
      playerId: primaryPlayerId,
      adjustedByUserId: adminUserId,
      previousHandicapIndex: "10.0",
      newHandicapIndex: "11.0",
      adjustmentStrokes: "1.0",
      adjustmentReason: "pre-existing",
    }).returning({ id: handicapAdjustmentsTable.id });

    const res = await request(app).post(decideUrl(c.id)).send({
      decision: "index_adjustment",
      rationale: "Both linkage modes at once",
      adjustmentId: adj.id,
      createAdjustment: { adjustmentStrokes: 1.0 },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/either adjustmentId or createAdjustment/);
  });
});
