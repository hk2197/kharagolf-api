// Task #1656 — verifies the data-quality endpoint joins manual_entry_alerts
// onto each flagged round with correct alertedAt + delivery counts, and that
// "most recent alert wins" when multiple rows exist for the same (player, round).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import {
  db,
  organizationsTable,
  appUsersTable,
  tournamentsTable,
  playersTable,
  shotsTable,
  roundSubmissionsTable,
  manualEntryAlertsTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { createTestApp, uid, type TestUser } from "../../tests/helpers.js";

let orgId: number;
let tournamentId: number;
let superAdminId: number;
let playerP1Id: number;
let playerP2Id: number;

const submissionIds: number[] = [];
const alertIds: number[] = [];

const P1_R1_ALERT = {
  recipientCount: 4,
  pushAttempted: 4, pushSent: 4,
  emailAttempted: 4, emailSent: 2,
  sentAt: new Date("2026-04-15T10:30:00Z"),
};
const P1_R2_OLDER_ALERT = {
  recipientCount: 2,
  pushAttempted: 2, pushSent: 1,
  emailAttempted: 2, emailSent: 0,
  sentAt: new Date("2026-04-16T08:00:00Z"),
};
const P1_R2_NEWER_ALERT = {
  recipientCount: 5,
  pushAttempted: 5, pushSent: 5,
  emailAttempted: 5, emailSent: 4,
  sentAt: new Date("2026-04-16T09:15:00Z"),
};

async function seedSubmission(playerId: number, round: number): Promise<number> {
  const [s] = await db.insert(roundSubmissionsTable).values({
    tournamentId, playerId, round, status: "countersigned",
  }).returning({ id: roundSubmissionsTable.id });
  submissionIds.push(s.id);
  return s.id;
}

async function seedAlert(opts: {
  submissionId: number; playerId: number; round: number;
  recipientCount: number;
  pushAttempted: number; pushSent: number;
  emailAttempted: number; emailSent: number;
  sentAt: Date;
  manualPct?: string; manualShots?: number; totalShots?: number;
}): Promise<number> {
  const [r] = await db.insert(manualEntryAlertsTable).values({
    submissionId: opts.submissionId,
    tournamentId,
    playerId: opts.playerId,
    round: opts.round,
    manualPct: opts.manualPct ?? "75.00",
    manualShots: opts.manualShots ?? 3,
    totalShots: opts.totalShots ?? 4,
    recipientCount: opts.recipientCount,
    pushAttempted: opts.pushAttempted,
    pushSent: opts.pushSent,
    emailAttempted: opts.emailAttempted,
    emailSent: opts.emailSent,
    sentAt: opts.sentAt,
  }).returning({ id: manualEntryAlertsTable.id });
  alertIds.push(r.id);
  return r.id;
}

async function seedShot(opts: {
  playerId: number; round: number; holeNumber: number; shotNumber: number;
  source: "manual" | "watch" | "phone" | "scorer";
}) {
  await db.insert(shotsTable).values({
    tournamentId,
    playerId: opts.playerId,
    round: opts.round,
    holeNumber: opts.holeNumber,
    shotNumber: opts.shotNumber,
    source: opts.source,
  });
}

beforeAll(async () => {
  const stamp = uid("t1656");

  const [org] = await db.insert(organizationsTable).values({
    name: `T1656 Org ${stamp}`, slug: `t1656-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [su] = await db.insert(appUsersTable).values({
    replitUserId: `t1656-su-${stamp}`,
    username: `t1656_su_${stamp}`,
    email: `su_${stamp}@t1656.test`,
    role: "super_admin",
    organizationId: null,
  }).returning({ id: appUsersTable.id });
  superAdminId = su.id;

  const [t] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    name: `T1656 Tourn ${stamp}`,
    startDate: new Date("2026-04-15T00:00:00Z"),
    endDate: new Date("2026-04-17T00:00:00Z"),
    rounds: 2,
  }).returning({ id: tournamentsTable.id });
  tournamentId = t.id;

  const [p1] = await db.insert(playersTable).values({
    tournamentId, firstName: "Pat", lastName: `One_${stamp}`,
  }).returning({ id: playersTable.id });
  playerP1Id = p1.id;

  const [p2] = await db.insert(playersTable).values({
    tournamentId, firstName: "Pat", lastName: `Two_${stamp}`,
  }).returning({ id: playersTable.id });
  playerP2Id = p2.id;

  // P1 R1 — 4 manual + 1 watch ⇒ 80% manual ⇒ flagged.
  await seedShot({ playerId: playerP1Id, round: 1, holeNumber: 1, shotNumber: 1, source: "manual" });
  await seedShot({ playerId: playerP1Id, round: 1, holeNumber: 1, shotNumber: 2, source: "manual" });
  await seedShot({ playerId: playerP1Id, round: 1, holeNumber: 2, shotNumber: 1, source: "manual" });
  await seedShot({ playerId: playerP1Id, round: 1, holeNumber: 2, shotNumber: 2, source: "manual" });
  await seedShot({ playerId: playerP1Id, round: 1, holeNumber: 3, shotNumber: 1, source: "watch" });

  // P1 R2 — 3 manual + 1 watch ⇒ 75% manual ⇒ flagged.
  await seedShot({ playerId: playerP1Id, round: 2, holeNumber: 1, shotNumber: 1, source: "manual" });
  await seedShot({ playerId: playerP1Id, round: 2, holeNumber: 1, shotNumber: 2, source: "manual" });
  await seedShot({ playerId: playerP1Id, round: 2, holeNumber: 2, shotNumber: 1, source: "manual" });
  await seedShot({ playerId: playerP1Id, round: 2, holeNumber: 2, shotNumber: 2, source: "watch" });

  // P2 R1 — all watch ⇒ not flagged, no alert seeded.
  await seedShot({ playerId: playerP2Id, round: 1, holeNumber: 1, shotNumber: 1, source: "watch" });
  await seedShot({ playerId: playerP2Id, round: 1, holeNumber: 1, shotNumber: 2, source: "watch" });
  await seedShot({ playerId: playerP2Id, round: 1, holeNumber: 2, shotNumber: 1, source: "watch" });
  await seedShot({ playerId: playerP2Id, round: 1, holeNumber: 2, shotNumber: 2, source: "watch" });

  // One alert for (P1, R1); two for (P1, R2) to exercise "most recent wins".
  const subP1R1 = await seedSubmission(playerP1Id, 1);
  await seedAlert({
    submissionId: subP1R1, playerId: playerP1Id, round: 1,
    manualPct: "80.00", manualShots: 4, totalShots: 5, ...P1_R1_ALERT,
  });

  const subP1R2 = await seedSubmission(playerP1Id, 2);
  await seedAlert({
    submissionId: subP1R2, playerId: playerP1Id, round: 2, ...P1_R2_OLDER_ALERT,
  });
  await seedAlert({
    submissionId: subP1R2, playerId: playerP1Id, round: 2, ...P1_R2_NEWER_ALERT,
  });
});

afterAll(async () => {
  if (alertIds.length > 0) {
    await db.delete(manualEntryAlertsTable).where(inArray(manualEntryAlertsTable.id, alertIds));
  }
  if (submissionIds.length > 0) {
    await db.delete(roundSubmissionsTable).where(inArray(roundSubmissionsTable.id, submissionIds));
  }
  await db.delete(shotsTable).where(inArray(shotsTable.playerId, [playerP1Id, playerP2Id]));
  await db.delete(playersTable).where(inArray(playersTable.id, [playerP1Id, playerP2Id]));
  await db.delete(tournamentsTable).where(inArray(tournamentsTable.id, [tournamentId]));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [superAdminId]));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgId]));
});

function asSuperAdmin(): TestUser {
  return { id: superAdminId, username: `u${superAdminId}`, role: "super_admin" };
}

async function callDataQuality(user?: TestUser) {
  const app = createTestApp(user);
  return request(app).get(`/api/organizations/${orgId}/tournaments/${tournamentId}/players/data-quality`);
}

interface DataQualityRow {
  playerId: number;
  playerName: string;
  round: number;
  counts: { watch: number; phone: number; scorer: number; manual: number };
  total: number;
  manualPct: number;
  flagged: boolean;
  alertedAt: string | null;
  alertDelivery: {
    recipientCount: number;
    pushAttempted: number;
    pushSent: number;
    emailAttempted: number;
    emailSent: number;
  } | null;
}

describe("GET /organizations/:orgId/tournaments/:tournamentId/players/data-quality — alert merge", () => {
  it("populates alertedAt + alertDelivery on a flagged row", async () => {
    const res = await callDataQuality(asSuperAdmin());
    expect(res.status).toBe(200);
    const rows = res.body as DataQualityRow[];

    const p1r1 = rows.find(r => r.playerId === playerP1Id && r.round === 1);
    expect(p1r1).toBeTruthy();
    expect(p1r1!.flagged).toBe(true);
    expect(p1r1!.alertedAt).toBe(P1_R1_ALERT.sentAt.toISOString());
    expect(p1r1!.alertDelivery).toEqual({
      recipientCount: P1_R1_ALERT.recipientCount,
      pushAttempted: P1_R1_ALERT.pushAttempted,
      pushSent: P1_R1_ALERT.pushSent,
      emailAttempted: P1_R1_ALERT.emailAttempted,
      emailSent: P1_R1_ALERT.emailSent,
    });
  });

  it("returns the most recent alert when multiple exist for the same (player, round)", async () => {
    const res = await callDataQuality(asSuperAdmin());
    expect(res.status).toBe(200);
    const rows = res.body as DataQualityRow[];

    const p1r2 = rows.find(r => r.playerId === playerP1Id && r.round === 2);
    expect(p1r2).toBeTruthy();
    expect(p1r2!.flagged).toBe(true);
    expect(P1_R2_OLDER_ALERT.sentAt.getTime()).toBeLessThan(P1_R2_NEWER_ALERT.sentAt.getTime());

    expect(p1r2!.alertedAt).toBe(P1_R2_NEWER_ALERT.sentAt.toISOString());
    expect(p1r2!.alertedAt).not.toBe(P1_R2_OLDER_ALERT.sentAt.toISOString());
    expect(p1r2!.alertDelivery).toEqual({
      recipientCount: P1_R2_NEWER_ALERT.recipientCount,
      pushAttempted: P1_R2_NEWER_ALERT.pushAttempted,
      pushSent: P1_R2_NEWER_ALERT.pushSent,
      emailAttempted: P1_R2_NEWER_ALERT.emailAttempted,
      emailSent: P1_R2_NEWER_ALERT.emailSent,
    });
    expect(p1r2!.alertDelivery).not.toEqual({
      recipientCount: P1_R2_OLDER_ALERT.recipientCount,
      pushAttempted: P1_R2_OLDER_ALERT.pushAttempted,
      pushSent: P1_R2_OLDER_ALERT.pushSent,
      emailAttempted: P1_R2_OLDER_ALERT.emailAttempted,
      emailSent: P1_R2_OLDER_ALERT.emailSent,
    });
  });

  it("leaves alertedAt + alertDelivery null on rounds with no alert log row", async () => {
    const res = await callDataQuality(asSuperAdmin());
    expect(res.status).toBe(200);
    const rows = res.body as DataQualityRow[];

    const p2r1 = rows.find(r => r.playerId === playerP2Id && r.round === 1);
    expect(p2r1).toBeTruthy();
    expect(p2r1!.flagged).toBe(false);
    expect(p2r1!.alertedAt).toBeNull();
    expect(p2r1!.alertDelivery).toBeNull();
  });
});
