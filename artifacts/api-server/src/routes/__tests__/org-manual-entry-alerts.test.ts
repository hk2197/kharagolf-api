// Contract tests for the per-organization manual-entry alert rollup
// endpoint (Task #2068).
//
// The route lives at `/api/organizations/:orgId/manual-entry-alerts/rows`
// and reuses `listManualEntryAlertRows` under the hood; these tests
// pin down the auth model and assert the URL-param `orgId` always
// wins over a query-string `organizationId` so an org_admin can't
// probe sibling orgs by tampering with the query string.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";

import {
  db,
  organizationsTable,
  appUsersTable,
  tournamentsTable,
  playersTable,
  roundSubmissionsTable,
  manualEntryAlertsTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "../../tests/helpers.js";

let orgAId: number;
let orgBId: number;
let superAdminId: number;
let orgAAdminId: number;
let orgBAdminId: number;
let playerUserId: number;
let tournAId: number;
let tournBId: number;
let playerAId: number;
let playerBId: number;
const submissionIds: number[] = [];
const alertIds: number[] = [];
// Tracks the indices of the seeded alerts within `alertIds` so the tests
// can refer to them by purpose without depending on insertion order.
let orgAFailedAlertIdx: number;
let orgASkippedAlertIdx: number;
let orgASentAlertIdx: number;
let orgBSkippedAlertIdx: number;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function seedSubmission(playerId: number, tournamentId: number, round: number): Promise<number> {
  const [s] = await db.insert(roundSubmissionsTable).values({
    tournamentId,
    playerId,
    round,
    status: "countersigned",
  }).returning({ id: roundSubmissionsTable.id });
  submissionIds.push(s.id);
  return s.id;
}

async function seedAlert(opts: {
  submissionId: number; tournamentId: number; playerId: number; round: number;
  status: "sent" | "skipped" | "failed";
  reason?: string | null;
  pushAttempted?: number; pushSent?: number; emailAttempted?: number; emailSent?: number;
  sentAt?: Date;
}): Promise<number> {
  const [r] = await db.insert(manualEntryAlertsTable).values({
    submissionId: opts.submissionId,
    tournamentId: opts.tournamentId,
    playerId: opts.playerId,
    round: opts.round,
    manualPct: "73.40",
    manualShots: 11,
    totalShots: 15,
    recipientCount: 0,
    pushAttempted: opts.pushAttempted ?? 0,
    pushSent: opts.pushSent ?? 0,
    emailAttempted: opts.emailAttempted ?? 0,
    emailSent: opts.emailSent ?? 0,
    status: opts.status,
    reason: opts.reason ?? null,
    sentAt: opts.sentAt ?? new Date(),
  }).returning({ id: manualEntryAlertsTable.id });
  alertIds.push(r.id);
  return r.id;
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [orgA] = await db.insert(organizationsTable).values({
    name: `T2068_OrgA_${stamp}`, slug: `t2068-orga-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `T2068_OrgB_${stamp}`, slug: `t2068-orgb-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [su] = await db.insert(appUsersTable).values({
    replitUserId: `t2068-su-${stamp}`,
    username: `t2068_su_${stamp}`,
    email: `su_${stamp}@t2068.test`,
    role: "super_admin", organizationId: null,
  }).returning({ id: appUsersTable.id });
  superAdminId = su.id;

  const [admA] = await db.insert(appUsersTable).values({
    replitUserId: `t2068-adma-${stamp}`,
    username: `t2068_adma_${stamp}`,
    email: `adma_${stamp}@t2068.test`,
    role: "org_admin", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  orgAAdminId = admA.id;

  const [admB] = await db.insert(appUsersTable).values({
    replitUserId: `t2068-admb-${stamp}`,
    username: `t2068_admb_${stamp}`,
    email: `admb_${stamp}@t2068.test`,
    role: "org_admin", organizationId: orgBId,
  }).returning({ id: appUsersTable.id });
  orgBAdminId = admB.id;

  const [pl] = await db.insert(appUsersTable).values({
    replitUserId: `t2068-pl-${stamp}`,
    username: `t2068_pl_${stamp}`,
    email: `pl_${stamp}@t2068.test`,
    role: "player", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  playerUserId = pl.id;

  const [tA] = await db.insert(tournamentsTable).values({
    organizationId: orgAId,
    name: `T2068_TournA_${stamp}`,
    startDate: new Date("2026-04-01T00:00:00Z"),
    endDate: new Date("2026-04-03T00:00:00Z"),
    rounds: 5,
  }).returning({ id: tournamentsTable.id });
  tournAId = tA.id;

  const [tB] = await db.insert(tournamentsTable).values({
    organizationId: orgBId,
    name: `T2068_TournB_${stamp}`,
    startDate: new Date("2026-04-10T00:00:00Z"),
    endDate: new Date("2026-04-12T00:00:00Z"),
    rounds: 3,
  }).returning({ id: tournamentsTable.id });
  tournBId = tB.id;

  const [pA] = await db.insert(playersTable).values({
    tournamentId: tournAId, firstName: "Alex", lastName: `Aye_${stamp}`,
  }).returning({ id: playersTable.id });
  playerAId = pA.id;

  const [pB] = await db.insert(playersTable).values({
    tournamentId: tournBId, firstName: "Blair", lastName: `Bee_${stamp}`,
  }).returning({ id: playersTable.id });
  playerBId = pB.id;

  const now = Date.now();

  // OrgA: one delivered, one skipped (org_muted), one failed (recent).
  // sentAt windows are picked so the default 30d filter includes all
  // three but the tighter 7d filter drops the older delivered one.
  const subA1 = await seedSubmission(playerAId, tournAId, 1);
  await seedAlert({
    submissionId: subA1, tournamentId: tournAId, playerId: playerAId, round: 1,
    status: "sent", pushAttempted: 2, pushSent: 2, emailAttempted: 2, emailSent: 2,
    sentAt: new Date(now - 14 * DAY),
  });
  orgASentAlertIdx = alertIds.length - 1;

  const subA2 = await seedSubmission(playerAId, tournAId, 2);
  await seedAlert({
    submissionId: subA2, tournamentId: tournAId, playerId: playerAId, round: 2,
    status: "skipped", reason: "org_muted", sentAt: new Date(now - 1 * DAY),
  });
  orgASkippedAlertIdx = alertIds.length - 1;

  const subA3 = await seedSubmission(playerAId, tournAId, 3);
  await seedAlert({
    submissionId: subA3, tournamentId: tournAId, playerId: playerAId, round: 3,
    status: "failed", reason: "org_lookup_failed", sentAt: new Date(now - 2 * DAY),
  });
  orgAFailedAlertIdx = alertIds.length - 1;

  // OrgB: one skipped row, used to confirm cross-org isolation.
  const subB1 = await seedSubmission(playerBId, tournBId, 1);
  await seedAlert({
    submissionId: subB1, tournamentId: tournBId, playerId: playerBId, round: 1,
    status: "skipped", reason: "below_threshold", sentAt: new Date(now - 1 * DAY),
  });
  orgBSkippedAlertIdx = alertIds.length - 1;
});

afterAll(async () => {
  if (alertIds.length > 0) {
    await db.delete(manualEntryAlertsTable).where(inArray(manualEntryAlertsTable.id, alertIds));
  }
  if (submissionIds.length > 0) {
    await db.delete(roundSubmissionsTable).where(inArray(roundSubmissionsTable.id, submissionIds));
  }
  await db.delete(playersTable).where(inArray(playersTable.id, [playerAId, playerBId]));
  await db.delete(tournamentsTable).where(inArray(tournamentsTable.id, [tournAId, tournBId]));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [
    superAdminId, orgAAdminId, orgBAdminId, playerUserId,
  ]));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgAId, orgBId]));
});

function asUser(id: number, role: string, organizationId: number | null): TestUser {
  const u: TestUser = { id, username: `u${id}`, role };
  if (organizationId != null) u.organizationId = organizationId;
  return u;
}

async function callRows(orgId: number, user: TestUser | undefined, query = "") {
  const app = createTestApp(user);
  return request(app).get(`/api/organizations/${orgId}/manual-entry-alerts/rows${query}`);
}

describe("GET /api/organizations/:orgId/manual-entry-alerts/rows (Task #2068)", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await callRows(orgAId, undefined);
    expect(res.status).toBe(401);
  });

  it("returns 403 for a player on the same org", async () => {
    const res = await callRows(orgAId, asUser(playerUserId, "player", orgAId));
    expect(res.status).toBe(403);
  });

  it("returns 403 when an org_admin requests a sibling org's rollup", async () => {
    const res = await callRows(orgAId, asUser(orgBAdminId, "org_admin", orgBId));
    expect(res.status).toBe(403);
  });

  it("returns 200 with only this org's rows for an org_admin on the named org", async () => {
    const res = await callRows(
      orgAId,
      asUser(orgAAdminId, "org_admin", orgAId),
      "?sinceDays=30&limit=200",
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      rows: Array<{ id: number; organizationId: number | null; status: string; reason: string | null }>;
      total: number;
    };
    const ids = body.rows.map((r) => r.id);
    expect(ids).toContain(alertIds[orgASentAlertIdx]);
    expect(ids).toContain(alertIds[orgASkippedAlertIdx]);
    expect(ids).toContain(alertIds[orgAFailedAlertIdx]);
    // Sibling-org row must not leak through.
    expect(ids).not.toContain(alertIds[orgBSkippedAlertIdx]);
    // Every returned row in the seed window belongs to OrgA.
    for (const r of body.rows) {
      if (alertIds.includes(r.id)) {
        expect(r.organizationId).toBe(orgAId);
      }
    }
  });

  it("returns 200 for a super_admin viewing any org's rollup", async () => {
    const res = await callRows(
      orgBId,
      asUser(superAdminId, "super_admin", null),
      "?sinceDays=30&limit=200",
    );
    expect(res.status).toBe(200);
    const body = res.body as { rows: Array<{ id: number; organizationId: number | null }> };
    const seeded = body.rows.filter((r) => alertIds.includes(r.id));
    expect(seeded.map((r) => r.id)).toEqual([alertIds[orgBSkippedAlertIdx]]);
    expect(seeded[0].organizationId).toBe(orgBId);
  });

  it("ignores any query-string organizationId — URL param wins", async () => {
    // OrgA admin tries to probe OrgB by passing `?organizationId=orgBId`.
    // The route must scope to OrgA regardless and return only OrgA rows.
    const res = await callRows(
      orgAId,
      asUser(orgAAdminId, "org_admin", orgAId),
      `?organizationId=${orgBId}&sinceDays=30&limit=200`,
    );
    expect(res.status).toBe(200);
    const body = res.body as { rows: Array<{ id: number; organizationId: number | null }> };
    const ids = body.rows.map((r) => r.id);
    expect(ids).not.toContain(alertIds[orgBSkippedAlertIdx]);
    for (const r of body.rows) {
      if (alertIds.includes(r.id)) {
        expect(r.organizationId).toBe(orgAId);
      }
    }
  });

  it("filters by status=skipped", async () => {
    const res = await callRows(
      orgAId,
      asUser(orgAAdminId, "org_admin", orgAId),
      "?status=skipped&sinceDays=30&limit=200",
    );
    expect(res.status).toBe(200);
    const body = res.body as { rows: Array<{ id: number; status: string; reason: string | null }> };
    const seeded = body.rows.filter((r) => alertIds.includes(r.id));
    expect(seeded.length).toBe(1);
    expect(seeded[0].id).toBe(alertIds[orgASkippedAlertIdx]);
    expect(seeded[0].status).toBe("skipped");
    expect(seeded[0].reason).toBe("org_muted");
    for (const r of body.rows) expect(r.status).toBe("skipped");
  });

  it("filters by status=failed", async () => {
    const res = await callRows(
      orgAId,
      asUser(orgAAdminId, "org_admin", orgAId),
      "?status=failed&sinceDays=30&limit=200",
    );
    expect(res.status).toBe(200);
    const body = res.body as { rows: Array<{ id: number; status: string; reason: string | null }> };
    const seeded = body.rows.filter((r) => alertIds.includes(r.id));
    expect(seeded.map((r) => r.id)).toEqual([alertIds[orgAFailedAlertIdx]]);
    expect(seeded[0].reason).toBe("org_lookup_failed");
    for (const r of body.rows) expect(r.status).toBe("failed");
  });

  it("respects sinceDays cutoff", async () => {
    const res = await callRows(
      orgAId,
      asUser(orgAAdminId, "org_admin", orgAId),
      "?sinceDays=7&limit=200",
    );
    expect(res.status).toBe(200);
    const body = res.body as { rows: Array<{ id: number; sentAt: string }> };
    const seeded = body.rows.filter((r) => alertIds.includes(r.id));
    const seededIds = seeded.map((r) => r.id);
    // The 14d-old delivered alert is excluded by the 7d window.
    expect(seededIds).not.toContain(alertIds[orgASentAlertIdx]);
    // The 1d-old skipped + 2d-old failed rows survive.
    expect(seededIds).toContain(alertIds[orgASkippedAlertIdx]);
    expect(seededIds).toContain(alertIds[orgAFailedAlertIdx]);
    const cutoff = Date.now() - 7 * DAY;
    for (const r of seeded) {
      expect(new Date(r.sentAt).getTime()).toBeGreaterThan(cutoff - HOUR);
    }
  });

  it("rejects an unknown status value with 400", async () => {
    const res = await callRows(
      orgAId,
      asUser(orgAAdminId, "org_admin", orgAId),
      "?status=bogus",
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("status") });
  });

  it("rejects a non-numeric orgId with 400", async () => {
    const app = createTestApp(asUser(orgAAdminId, "org_admin", orgAId));
    const res = await request(app).get(
      "/api/organizations/not-a-number/manual-entry-alerts/rows",
    );
    expect(res.status).toBe(400);
  });
});
