// Contract tests for the super-admin manual-entry alert delivery-health
// endpoints (Task #1193).
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
  manualEntryAlertRecipientsTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "../../tests/helpers.js";

let orgAId: number;
let orgBId: number;
let superAdminId: number;
let orgAdminId: number;
let playerUserId: number;
let tournA1Id: number;
let tournA2Id: number;
let tournBId: number;
let playerP1Id: number;
let playerP2Id: number;
let playerP3Id: number;
const submissionIds: number[] = [];
const alertIds: number[] = [];
// Distinct user ids used as recipients in `manual_entry_alert_recipients`
// rows seeded for the summary tests (Task #1671). Created in beforeAll.
const recipientUserIds: number[] = [];

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
  pushAttempted: number; pushSent: number; emailAttempted: number; emailSent: number;
  recipientCount?: number; sentAt?: Date;
}): Promise<number> {
  const [r] = await db.insert(manualEntryAlertsTable).values({
    submissionId: opts.submissionId,
    tournamentId: opts.tournamentId,
    playerId: opts.playerId,
    round: opts.round,
    manualPct: "73.40",
    manualShots: 11,
    totalShots: 15,
    recipientCount: opts.recipientCount ?? Math.max(opts.pushAttempted, opts.emailAttempted),
    pushAttempted: opts.pushAttempted,
    pushSent: opts.pushSent,
    emailAttempted: opts.emailAttempted,
    emailSent: opts.emailSent,
    sentAt: opts.sentAt ?? new Date(),
  }).returning({ id: manualEntryAlertsTable.id });
  alertIds.push(r.id);
  return r.id;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const [orgA] = await db.insert(organizationsTable).values({
    name: `T1193_OrgA_${stamp}`, slug: `t1193-orga-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgAId = orgA.id;

  const [orgB] = await db.insert(organizationsTable).values({
    name: `T1193_OrgB_${stamp}`, slug: `t1193-orgb-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgBId = orgB.id;

  const [su] = await db.insert(appUsersTable).values({
    replitUserId: `t1193-su-${stamp}`,
    username: `t1193_su_${stamp}`,
    email: `su_${stamp}@t1193.test`,
    role: "super_admin", organizationId: null,
  }).returning({ id: appUsersTable.id });
  superAdminId = su.id;

  const [adm] = await db.insert(appUsersTable).values({
    replitUserId: `t1193-adm-${stamp}`,
    username: `t1193_adm_${stamp}`,
    email: `adm_${stamp}@t1193.test`,
    role: "org_admin", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  orgAdminId = adm.id;

  const [pl] = await db.insert(appUsersTable).values({
    replitUserId: `t1193-pl-${stamp}`,
    username: `t1193_pl_${stamp}`,
    email: `pl_${stamp}@t1193.test`,
    role: "player", organizationId: orgAId,
  }).returning({ id: appUsersTable.id });
  playerUserId = pl.id;

  const [tA1] = await db.insert(tournamentsTable).values({
    organizationId: orgAId,
    name: `T1193_TournA1_${stamp}`,
    startDate: new Date("2026-04-01T00:00:00Z"),
    endDate: new Date("2026-04-03T00:00:00Z"),
    rounds: 3,
  }).returning({ id: tournamentsTable.id });
  tournA1Id = tA1.id;

  const [tA2] = await db.insert(tournamentsTable).values({
    organizationId: orgAId,
    name: `T1193_TournA2_${stamp}`,
    startDate: new Date("2026-04-10T00:00:00Z"),
    endDate: new Date("2026-04-12T00:00:00Z"),
    rounds: 3,
  }).returning({ id: tournamentsTable.id });
  tournA2Id = tA2.id;

  const [tB] = await db.insert(tournamentsTable).values({
    organizationId: orgBId,
    name: `T1193_TournB_${stamp}`,
    startDate: new Date("2026-04-15T00:00:00Z"),
    endDate: new Date("2026-04-17T00:00:00Z"),
    rounds: 3,
  }).returning({ id: tournamentsTable.id });
  tournBId = tB.id;

  const [p1] = await db.insert(playersTable).values({
    tournamentId: tournA1Id, firstName: "Pat", lastName: `One_${stamp}`,
  }).returning({ id: playersTable.id });
  playerP1Id = p1.id;

  const [p2] = await db.insert(playersTable).values({
    tournamentId: tournA2Id, firstName: "Pat", lastName: `Two_${stamp}`,
  }).returning({ id: playersTable.id });
  playerP2Id = p2.id;

  const [p3] = await db.insert(playersTable).values({
    tournamentId: tournBId, firstName: "Pat", lastName: `Three_${stamp}`,
  }).returning({ id: playersTable.id });
  playerP3Id = p3.id;

  const now = Date.now();

  // Tournament A1 + Player P1: 3 alerts in last 7d (2 delivered, 1 silent w/ 3 recipients).
  const sub1 = await seedSubmission(playerP1Id, tournA1Id, 1);
  await seedAlert({ submissionId: sub1, tournamentId: tournA1Id, playerId: playerP1Id, round: 1,
    pushAttempted: 3, pushSent: 3, emailAttempted: 3, emailSent: 3, sentAt: new Date(now - 1 * DAY) });
  const sub2 = await seedSubmission(playerP1Id, tournA1Id, 2);
  await seedAlert({ submissionId: sub2, tournamentId: tournA1Id, playerId: playerP1Id, round: 2,
    pushAttempted: 3, pushSent: 2, emailAttempted: 3, emailSent: 1, sentAt: new Date(now - 2 * DAY) });
  const sub3 = await seedSubmission(playerP1Id, tournA1Id, 3);
  await seedAlert({ submissionId: sub3, tournamentId: tournA1Id, playerId: playerP1Id, round: 3,
    pushAttempted: 3, pushSent: 0, emailAttempted: 3, emailSent: 0, recipientCount: 3,
    sentAt: new Date(now - 3 * DAY) });

  // Tournament A2 + Player P2: 2 alerts (push-only, email-only) — neither silent.
  const sub4 = await seedSubmission(playerP2Id, tournA2Id, 1);
  await seedAlert({ submissionId: sub4, tournamentId: tournA2Id, playerId: playerP2Id, round: 1,
    pushAttempted: 2, pushSent: 1, emailAttempted: 2, emailSent: 0, sentAt: new Date(now - 4 * DAY) });
  const sub5 = await seedSubmission(playerP2Id, tournA2Id, 2);
  await seedAlert({ submissionId: sub5, tournamentId: tournA2Id, playerId: playerP2Id, round: 2,
    pushAttempted: 2, pushSent: 0, emailAttempted: 2, emailSent: 1, sentAt: new Date(now - 5 * DAY) });

  // Tournament B + Player P3: silent alert at -6d (4 recipients), delivered at -20d.
  const sub6 = await seedSubmission(playerP3Id, tournBId, 1);
  await seedAlert({ submissionId: sub6, tournamentId: tournBId, playerId: playerP3Id, round: 1,
    pushAttempted: 4, pushSent: 0, emailAttempted: 4, emailSent: 0, recipientCount: 4,
    sentAt: new Date(now - 6 * DAY) });
  const sub7 = await seedSubmission(playerP3Id, tournBId, 2);
  await seedAlert({ submissionId: sub7, tournamentId: tournBId, playerId: playerP3Id, round: 2,
    pushAttempted: 4, pushSent: 4, emailAttempted: 4, emailSent: 4, sentAt: new Date(now - 20 * DAY) });

  // 60d-old alert — outside both windows. Different round to satisfy
  // round_submissions' unique (playerId, round) index.
  const sub8 = await seedSubmission(playerP1Id, tournA1Id, 99);
  await seedAlert({ submissionId: sub8, tournamentId: tournA1Id, playerId: playerP1Id, round: 99,
    pushAttempted: 3, pushSent: 3, emailAttempted: 3, emailSent: 3, sentAt: new Date(now - 60 * DAY) });

  // ── Per-recipient seeding for the silent-recipient totals (Task #1671)
  // The summary now derives `silentRecipientTotal` from
  // `manual_entry_alert_recipients` (count of distinct (alert, user)
  // pairs whose only attempt rows are non-`sent`). We seed five
  // distinct recipient users and write rows that exercise:
  //   - a partially-silent alert (alertIds[1], tournA1 r2): three
  //     recipients, one of whom got nothing on either channel — the
  //     case the old proxy missed entirely.
  //   - a fully-silent alert (alertIds[2], tournA1 r3): three silent
  //     recipients.
  //   - a fully-silent alert with extra inboxes (alertIds[5], tournB
  //     r1): five silent recipients (more than the alert-level
  //     `recipientCount=4`, deliberately, to prove the count comes
  //     from the recipient table — not the alert aggregate).
  //
  // Per-alert breakdowns (for the assertions below):
  //   tournA1 r2 (alertIds[1]) → 1 silent
  //   tournA1 r3 (alertIds[2]) → 3 silent
  //   tournB  r1 (alertIds[5]) → 5 silent
  // 7d total silent (alert, user) pairs = 1 + 3 + 5 = 9
  // 30d total silent = 9 (the 20d-old tournB r2 has no recipient rows)
  // tournA1 silent in 7d = 4   tournB silent in 7d = 5
  // orgA silent in 30d = 4 across 2 alerts; orgB silent in 30d = 5 in 1.
  const recipientStamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const recipientRows = await db.insert(appUsersTable).values([
    { replitUserId: `t1671-r1-${recipientStamp}`, username: `t1671_r1_${recipientStamp}`,
      email: `r1_${recipientStamp}@t1671.test`, role: "org_admin", organizationId: orgAId },
    { replitUserId: `t1671-r2-${recipientStamp}`, username: `t1671_r2_${recipientStamp}`,
      email: `r2_${recipientStamp}@t1671.test`, role: "org_admin", organizationId: orgAId },
    { replitUserId: `t1671-r3-${recipientStamp}`, username: `t1671_r3_${recipientStamp}`,
      email: `r3_${recipientStamp}@t1671.test`, role: "org_admin", organizationId: orgAId },
    { replitUserId: `t1671-r4-${recipientStamp}`, username: `t1671_r4_${recipientStamp}`,
      email: `r4_${recipientStamp}@t1671.test`, role: "org_admin", organizationId: orgBId },
    { replitUserId: `t1671-r5-${recipientStamp}`, username: `t1671_r5_${recipientStamp}`,
      email: `r5_${recipientStamp}@t1671.test`, role: "org_admin", organizationId: orgBId },
  ]).returning({ id: appUsersTable.id });
  for (const r of recipientRows) recipientUserIds.push(r.id);
  const [rU1, rU2, rU3, rU4, rU5] = recipientUserIds;

  await db.insert(manualEntryAlertRecipientsTable).values([
    // alertIds[1] tournA1 r2 — partial silence: rU3 got nothing.
    { alertId: alertIds[1], userId: rU1, channel: "push", status: "sent" },
    { alertId: alertIds[1], userId: rU1, channel: "email", status: "sent" },
    { alertId: alertIds[1], userId: rU2, channel: "push", status: "sent" },
    { alertId: alertIds[1], userId: rU2, channel: "email", status: "failed", errorMessage: "smtp 550" },
    { alertId: alertIds[1], userId: rU3, channel: "push", status: "failed", errorMessage: "expo 404" },
    { alertId: alertIds[1], userId: rU3, channel: "email", status: "opted_out" },

    // alertIds[2] tournA1 r3 — fully silent for three users.
    { alertId: alertIds[2], userId: rU1, channel: "push", status: "failed", errorMessage: "expo 502" },
    { alertId: alertIds[2], userId: rU1, channel: "email", status: "failed", errorMessage: "smtp 421" },
    { alertId: alertIds[2], userId: rU2, channel: "push", status: "no_address" },
    { alertId: alertIds[2], userId: rU2, channel: "email", status: "no_email" },
    { alertId: alertIds[2], userId: rU3, channel: "push", status: "failed", errorMessage: "expo 502" },
    { alertId: alertIds[2], userId: rU3, channel: "email", status: "opted_out" },

    // alertIds[5] tournB r1 — fully silent for five users (intentionally
    // exceeds the alert-level recipientCount=4 to prove the new total
    // is sourced from this table, not the aggregate column).
    { alertId: alertIds[5], userId: rU1, channel: "push", status: "failed", errorMessage: "expo 502" },
    { alertId: alertIds[5], userId: rU1, channel: "email", status: "failed", errorMessage: "smtp 421" },
    { alertId: alertIds[5], userId: rU2, channel: "push", status: "no_address" },
    { alertId: alertIds[5], userId: rU2, channel: "email", status: "no_email" },
    { alertId: alertIds[5], userId: rU3, channel: "push", status: "failed", errorMessage: "expo 502" },
    { alertId: alertIds[5], userId: rU3, channel: "email", status: "opted_out" },
    { alertId: alertIds[5], userId: rU4, channel: "push", status: "failed", errorMessage: "expo 502" },
    { alertId: alertIds[5], userId: rU4, channel: "email", status: "failed", errorMessage: "smtp 421" },
    { alertId: alertIds[5], userId: rU5, channel: "push", status: "no_address" },
    { alertId: alertIds[5], userId: rU5, channel: "email", status: "no_email" },
  ]);
});

afterAll(async () => {
  if (alertIds.length > 0) {
    // Cascades delete the seeded `manual_entry_alert_recipients` rows.
    await db.delete(manualEntryAlertsTable).where(inArray(manualEntryAlertsTable.id, alertIds));
  }
  if (submissionIds.length > 0) {
    await db.delete(roundSubmissionsTable).where(inArray(roundSubmissionsTable.id, submissionIds));
  }
  await db.delete(playersTable).where(inArray(playersTable.id, [playerP1Id, playerP2Id, playerP3Id]));
  await db.delete(tournamentsTable).where(inArray(tournamentsTable.id, [tournA1Id, tournA2Id, tournBId]));
  const userIds = [superAdminId, orgAdminId, playerUserId, ...recipientUserIds];
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgAId, orgBId]));
});

function asUser(id: number, role: string, organizationId: number | null): TestUser {
  const u: TestUser = { id, username: `u${id}`, role };
  if (organizationId != null) u.organizationId = organizationId;
  return u;
}

async function callSummary(user?: TestUser) {
  const app = createTestApp(user);
  return request(app).get("/api/super-admin/manual-entry-alerts/summary");
}

async function callRows(user: TestUser | undefined, query = "") {
  const app = createTestApp(user);
  return request(app).get(`/api/super-admin/manual-entry-alerts/rows${query}`);
}

async function callRowsCsv(user: TestUser | undefined, query = "") {
  const app = createTestApp(user);
  return request(app).get(`/api/super-admin/manual-entry-alerts/rows.csv${query}`);
}

// Minimal RFC 4180 CSV parser sufficient for the export's escaping rules.
// Splits a CSV body into a 2D string array; treats CRLF or LF as record
// separators and unwraps quoted fields (doubled quotes -> single quote).
function parseCsv(body: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inQuotes) {
      if (c === '"') {
        if (body[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else { field += c; }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") { continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe("GET /api/super-admin/manual-entry-alerts/summary", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await callSummary(undefined);
    expect(res.status).toBe(401);
  });

  it("returns 403 for org_admin role", async () => {
    const res = await callSummary(asUser(orgAdminId, "org_admin", orgAId));
    expect(res.status).toBe(403);
  });

  it("returns 403 for player role", async () => {
    const res = await callSummary(asUser(playerUserId, "player", orgAId));
    expect(res.status).toBe(403);
  });

  it("aggregates 7d and 30d windows for super_admin", async () => {
    const res = await callSummary(asUser(superAdminId, "super_admin", null));
    expect(res.status).toBe(200);
    const body = res.body as {
      windows: { "7d": Record<string, number>; "30d": Record<string, number> };
      topTournaments7d: Array<{ tournamentId: number; alertCount: number; zeroDeliveryCount: number; silentRecipientTotal: number }>;
      topZeroDeliveryTournaments30d: Array<{ tournamentId: number; zeroDeliveryCount: number; silentRecipientTotal: number }>;
      topPlayers30d: Array<{ playerId: number; alertCount: number; zeroDeliveryCount: number }>;
      topSilentRecipientOrgs30d: Array<{ organizationId: number | null; zeroDeliveryAlertCount: number; silentRecipientTotal: number }>;
      generatedAt: string;
    };

    // 6 alerts in last 7d (5 newer + the silent tournB alert at -6d).
    expect(body.windows["7d"].alertCount).toBeGreaterThanOrEqual(6);
    expect(body.windows["7d"].zeroDeliveryCount).toBeGreaterThanOrEqual(2);
    expect(body.windows["7d"].pushDeliveryRate).toBeGreaterThanOrEqual(0);
    expect(body.windows["7d"].pushDeliveryRate).toBeLessThanOrEqual(100);
    expect(body.windows["7d"].emailDeliveryRate).toBeLessThanOrEqual(100);
    // Silent recipient total now comes from
    // `manual_entry_alert_recipients` (Task #1671): the seed writes 1
    // silent user for the partially-silent tournA1 r2, 3 for the fully
    // silent tournA1 r3, and 5 for tournB r1 → 9 distinct (alert,
    // user) pairs in the 7d window. Other tests in this DB may add
    // their own rows, so we lower-bound the seeded count exactly and
    // assert the floor isn't exceeded by alert-level proxy math
    // (which would have produced ≥ 7 from `recipientCount` alone).
    expect(body.windows["7d"].silentRecipientTotal).toBeGreaterThanOrEqual(9);

    // 30d window picks up the 20d-old delivered tournB alert too, but
    // since it has no recipient rows, silentRecipientTotal is unchanged.
    expect(body.windows["30d"].alertCount).toBeGreaterThan(body.windows["7d"].alertCount);
    expect(body.windows["30d"].silentRecipientTotal).toBe(body.windows["7d"].silentRecipientTotal);

    // Tournament A1 in topTournaments7d: 3 alerts; the per-recipient
    // total (1 silent on partial r2 + 3 silent on r3 = 4) replaces
    // the old recipientCount-on-zero-delivery proxy that would have
    // returned 3.
    const tournA1 = body.topTournaments7d.find(t => t.tournamentId === tournA1Id);
    expect(tournA1).toBeTruthy();
    expect(tournA1?.alertCount).toBe(3);
    expect(tournA1?.zeroDeliveryCount).toBe(1);
    expect(tournA1?.silentRecipientTotal).toBe(4);

    // Tournament B in topTournaments7d: 1 alert (r1 silent), 5 silent
    // recipients (the seed writes more recipient rows than the
    // alert-level recipientCount=4 by design, to prove the new total
    // is sourced from the recipient table).
    const tournB7d = body.topTournaments7d.find(t => t.tournamentId === tournBId);
    expect(tournB7d).toBeTruthy();
    expect(tournB7d?.alertCount).toBe(1);
    expect(tournB7d?.zeroDeliveryCount).toBe(1);
    expect(tournB7d?.silentRecipientTotal).toBe(5);

    // Zero-delivery 30d includes tournA1 and tournB; silentRecipientTotal
    // there now reflects only the silent recipients on the alert-level
    // zero-delivery alerts (excludes the partial tournA1 r2's 1 silent).
    const zeroIds = body.topZeroDeliveryTournaments30d.map(t => t.tournamentId);
    expect(zeroIds).toContain(tournA1Id);
    expect(zeroIds).toContain(tournBId);
    const tournA1Zero30d = body.topZeroDeliveryTournaments30d.find(t => t.tournamentId === tournA1Id);
    expect(tournA1Zero30d?.silentRecipientTotal).toBe(3);
    const tournBZero30d = body.topZeroDeliveryTournaments30d.find(t => t.tournamentId === tournBId);
    expect(tournBZero30d?.silentRecipientTotal).toBe(5);

    // Player P1 has 3 alerts in last 30d (60d-old excluded).
    const p1 = body.topPlayers30d.find(p => p.playerId === playerP1Id);
    expect(p1).toBeTruthy();
    expect(p1?.alertCount).toBe(3);

    // Top silent-recipient orgs: orgB has 5 silent recipients across 1
    // alert; orgA has 4 across 2 alerts (one of which is the partial
    // r2 alert, which the old proxy would have ignored entirely).
    const silentOrgB = body.topSilentRecipientOrgs30d.find(o => o.organizationId === orgBId);
    expect(silentOrgB?.silentRecipientTotal).toBe(5);
    expect(silentOrgB?.zeroDeliveryAlertCount).toBe(1);
    const silentOrgA = body.topSilentRecipientOrgs30d.find(o => o.organizationId === orgAId);
    expect(silentOrgA?.silentRecipientTotal).toBe(4);
    expect(silentOrgA?.zeroDeliveryAlertCount).toBe(2);
    // Ranked by silentRecipientTotal desc — orgB outranks orgA.
    const orgBIdx = body.topSilentRecipientOrgs30d.findIndex(o => o.organizationId === orgBId);
    const orgAIdx = body.topSilentRecipientOrgs30d.findIndex(o => o.organizationId === orgAId);
    expect(orgBIdx).toBeGreaterThanOrEqual(0);
    expect(orgAIdx).toBeGreaterThanOrEqual(0);
    expect(orgBIdx).toBeLessThan(orgAIdx);

    expect(typeof body.generatedAt).toBe("string");
  });
});

describe("GET /api/super-admin/manual-entry-alerts/rows", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await callRows(undefined);
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-super-admin roles", async () => {
    const res = await callRows(asUser(orgAdminId, "org_admin", orgAId));
    expect(res.status).toBe(403);
  });

  it("returns rows enriched with tournament + player names", async () => {
    const res = await callRows(asUser(superAdminId, "super_admin", null), "?sinceDays=30&limit=200");
    expect(res.status).toBe(200);
    const body = res.body as { rows: Array<Record<string, unknown>>; total: number };
    const seeded = body.rows.filter(r => alertIds.includes(r.id as number));
    expect(seeded.length).toBeGreaterThanOrEqual(7);
    for (const r of seeded) {
      expect(typeof r.tournamentName).toBe("string");
      expect(typeof r.playerName).toBe("string");
      expect(typeof r.zeroDelivery).toBe("boolean");
      expect(typeof r.manualPct).toBe("number");
    }
  });

  it("filters by tournamentId", async () => {
    const res = await callRows(
      asUser(superAdminId, "super_admin", null),
      `?tournamentId=${tournA1Id}&sinceDays=30&limit=200`,
    );
    expect(res.status).toBe(200);
    const body = res.body as { rows: Array<{ id: number; tournamentId: number }>; total: number };
    expect(body.rows.length).toBeGreaterThan(0);
    for (const r of body.rows) expect(r.tournamentId).toBe(tournA1Id);
    const seeded = body.rows.filter(r => alertIds.includes(r.id));
    expect(seeded.length).toBe(3);
  });

  it("filters by playerId", async () => {
    const res = await callRows(
      asUser(superAdminId, "super_admin", null),
      `?playerId=${playerP2Id}&sinceDays=30&limit=200`,
    );
    expect(res.status).toBe(200);
    const body = res.body as { rows: Array<{ playerId: number }> };
    expect(body.rows.length).toBeGreaterThan(0);
    for (const r of body.rows) expect(r.playerId).toBe(playerP2Id);
  });

  it("filters by zeroDeliveryOnly=1", async () => {
    const res = await callRows(
      asUser(superAdminId, "super_admin", null),
      "?zeroDeliveryOnly=1&sinceDays=30&limit=200",
    );
    expect(res.status).toBe(200);
    const body = res.body as { rows: Array<{ zeroDelivery: boolean; pushSent: number; emailSent: number }> };
    expect(body.rows.length).toBeGreaterThan(0);
    for (const r of body.rows) {
      expect(r.zeroDelivery).toBe(true);
      expect(r.pushSent).toBe(0);
      expect(r.emailSent).toBe(0);
    }
  });

  it("respects sinceDays cutoff", async () => {
    const res = await callRows(
      asUser(superAdminId, "super_admin", null),
      "?sinceDays=7&limit=200",
    );
    expect(res.status).toBe(200);
    const body = res.body as { rows: Array<{ id: number; sentAt: string }> };
    const seeded = body.rows.filter(r => alertIds.includes(r.id));
    expect(seeded.length).toBeLessThanOrEqual(6);
    const cutoff = Date.now() - 7 * DAY;
    for (const r of seeded) {
      expect(new Date(r.sentAt).getTime()).toBeGreaterThan(cutoff - HOUR);
    }
  });

  it("rejects non-numeric offset with 400", async () => {
    const res = await callRows(asUser(superAdminId, "super_admin", null), "?offset=abc");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("offset") });
  });

  it("rejects non-numeric tournamentId with 400", async () => {
    const res = await callRows(asUser(superAdminId, "super_admin", null), "?tournamentId=NaN");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("tournamentId") });
  });
});

describe("GET /api/super-admin/manual-entry-alerts/rows.csv (Task #1388)", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await callRowsCsv(undefined);
    expect(res.status).toBe(401);
  });

  it("returns 403 for org_admin role", async () => {
    const res = await callRowsCsv(asUser(orgAdminId, "org_admin", orgAId));
    expect(res.status).toBe(403);
  });

  it("returns 403 for player role", async () => {
    const res = await callRowsCsv(asUser(playerUserId, "player", orgAId));
    expect(res.status).toBe(403);
  });

  it("rejects non-numeric tournamentId with 400 (mirrors JSON endpoint)", async () => {
    const res = await callRowsCsv(asUser(superAdminId, "super_admin", null), "?tournamentId=NaN");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("tournamentId") });
  });

  it("returns text/csv with attachment Content-Disposition", async () => {
    const res = await callRowsCsv(asUser(superAdminId, "super_admin", null), "?sinceDays=30");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/^attachment;\s*filename="manual-entry-alerts-.+\.csv"$/);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("emits the documented header row in the documented order", async () => {
    const res = await callRowsCsv(asUser(superAdminId, "super_admin", null), "?sinceDays=30");
    expect(res.status).toBe(200);
    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual([
      "alertId",
      "sentAt",
      "tournamentId",
      "tournamentName",
      "organizationId",
      "organizationName",
      "playerId",
      "playerName",
      "round",
      "manualPct",
      "recipientCount",
      "pushAttempted",
      "pushSent",
      "emailAttempted",
      "emailSent",
      "zeroDelivery",
      // Task #1658 — status + reason appended at the end so existing
      // CSV consumers reading by column index aren't broken.
      "status",
      "reason",
    ]);
  });

  it("includes the same rows as the JSON endpoint under the same filters", async () => {
    const json = await callRows(asUser(superAdminId, "super_admin", null), "?sinceDays=30&limit=200");
    expect(json.status).toBe(200);
    const csv = await callRowsCsv(asUser(superAdminId, "super_admin", null), "?sinceDays=30");
    expect(csv.status).toBe(200);
    const csvRows = parseCsv(csv.text);
    const csvIds = new Set(csvRows.slice(1).map(r => Number(r[0])));
    const jsonIds = (json.body.rows as Array<{ id: number }>).map(r => r.id);
    expect(jsonIds.length).toBeGreaterThan(0);
    for (const id of jsonIds) expect(csvIds.has(id)).toBe(true);
  });

  it("honours tournamentId + zeroDeliveryOnly filters", async () => {
    const csv = await callRowsCsv(
      asUser(superAdminId, "super_admin", null),
      `?tournamentId=${tournA1Id}&zeroDeliveryOnly=1&sinceDays=30`,
    );
    expect(csv.status).toBe(200);
    const rows = parseCsv(csv.text);
    const dataRows = rows.slice(1).filter(r => alertIds.includes(Number(r[0])));
    // Only the round-3 silent alert from tournA1 should be present.
    expect(dataRows.length).toBe(1);
    const r = dataRows[0];
    // tournamentId column index = 2, zeroDelivery column index = 15.
    expect(Number(r[2])).toBe(tournA1Id);
    expect(r[15]).toBe("true");
    expect(Number(r[12])).toBe(0); // pushSent
    expect(Number(r[14])).toBe(0); // emailSent
  });

  it("formats the row payload with names + numeric counts", async () => {
    const csv = await callRowsCsv(
      asUser(superAdminId, "super_admin", null),
      `?tournamentId=${tournBId}&sinceDays=30`,
    );
    expect(csv.status).toBe(200);
    const rows = parseCsv(csv.text);
    const dataRows = rows.slice(1).filter(r => alertIds.includes(Number(r[0])));
    expect(dataRows.length).toBeGreaterThan(0);
    for (const r of dataRows) {
      expect(r[3].length).toBeGreaterThan(0); // tournamentName populated
      expect(r[5].length).toBeGreaterThan(0); // organizationName populated
      expect(r[7].length).toBeGreaterThan(0); // playerName populated
      // sentAt is a parseable ISO timestamp.
      expect(Number.isNaN(Date.parse(r[1]))).toBe(false);
      // recipientCount is a non-negative integer.
      expect(Number(r[10])).toBeGreaterThanOrEqual(0);
    }
  });
});

// Per-alert silent-recipient drill-down (Task #1386).
describe("GET /api/super-admin/manual-entry-alerts/:id/silent-recipients", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp(undefined);
    const res = await request(app).get(`/api/super-admin/manual-entry-alerts/${alertIds[0]}/silent-recipients`);
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-super-admin roles", async () => {
    const app = createTestApp(asUser(orgAdminId, "org_admin", orgAId));
    const res = await request(app).get(`/api/super-admin/manual-entry-alerts/${alertIds[0]}/silent-recipients`);
    expect(res.status).toBe(403);
  });

  it("rejects non-numeric ids with 400", async () => {
    const app = createTestApp(asUser(superAdminId, "super_admin", null));
    const res = await request(app).get("/api/super-admin/manual-entry-alerts/abc/silent-recipients");
    expect(res.status).toBe(400);
  });

  it("returns 404 when the alert id does not exist", async () => {
    const app = createTestApp(asUser(superAdminId, "super_admin", null));
    const ghostId = Math.max(...alertIds) + 1_000_000;
    const res = await request(app).get(`/api/super-admin/manual-entry-alerts/${ghostId}/silent-recipients`);
    expect(res.status).toBe(404);
  });

  it("returns the silent rows (and only the silent rows) for a seeded alert", async () => {
    // Use alertIds[3] (tournA2 r1) — the summary tests pre-seed
    // recipient rows for alertIds[1], [2] and [5] (Task #1671), so
    // we pick an alert with no pre-seeded rows to keep this test's
    // count assertions exact.
    const targetAlert = alertIds[3];

    // Seed three recipient rows: 1 sent (push) + 2 silent (failed push,
    // opted_out email). The endpoint must return exactly the two silent
    // ones and the totalRecipientRows count must be 3.
    await db.insert(manualEntryAlertRecipientsTable).values([
      { alertId: targetAlert, userId: orgAdminId, channel: "push", status: "sent", errorMessage: null },
      { alertId: targetAlert, userId: orgAdminId, channel: "push", status: "failed", errorMessage: "expo unreachable" },
      { alertId: targetAlert, userId: playerUserId, channel: "email", status: "opted_out", errorMessage: null },
    ]);

    const app = createTestApp(asUser(superAdminId, "super_admin", null));
    const res = await request(app).get(`/api/super-admin/manual-entry-alerts/${targetAlert}/silent-recipients`);
    expect(res.status).toBe(200);

    const body = res.body as {
      alertId: number;
      totalRecipientRows: number;
      silentRecipients: Array<{
        userId: number | null;
        channel: "push" | "email";
        status: string;
        errorMessage: string | null;
        displayName: string | null;
        username: string | null;
        email: string | null;
        createdAt: string;
        reconstructed: boolean;
      }>;
    };

    expect(body.alertId).toBe(targetAlert);
    expect(body.totalRecipientRows).toBe(3);
    expect(body.silentRecipients).toHaveLength(2);

    const failed = body.silentRecipients.find(r => r.status === "failed");
    expect(failed).toBeTruthy();
    expect(failed?.channel).toBe("push");
    expect(failed?.errorMessage).toBe("expo unreachable");
    expect(failed?.userId).toBe(orgAdminId);
    // Joined user fields populated from app_users.
    expect(failed?.username).toContain("t1193_adm_");
    // Task #2075 — real per-user delivery rows must report
    // reconstructed=false; the dashboard pill only fires for backfilled
    // rows whose error_message starts with the marker.
    expect(failed?.reconstructed).toBe(false);

    const optedOut = body.silentRecipients.find(r => r.status === "opted_out");
    expect(optedOut).toBeTruthy();
    expect(optedOut?.channel).toBe("email");
    expect(optedOut?.userId).toBe(playerUserId);
    expect(optedOut?.reconstructed).toBe(false);

    // Cleanup so re-runs aren't polluted.
    await db.delete(manualEntryAlertRecipientsTable)
      .where(inArray(manualEntryAlertRecipientsTable.alertId, [targetAlert]));
  });

  // Task #2075 — backfilled rows (Task #1672 reconstruction) must be
  // labelled with reconstructed=true so the dashboard renders the
  // "(reconstructed)" pill instead of treating them as confirmed
  // per-user delivery failures. Also exercises the new CSV export so
  // off-dashboard analyses carry the same provenance flag.
  it("flags Task #1672 backfilled rows as reconstructed in JSON and CSV", async () => {
    const targetAlert = alertIds[4];
    const backfillMarker =
      "backfilled (Task #1672) — original per-recipient outcome unknown";

    await db.insert(manualEntryAlertRecipientsTable).values([
      // Real delivery row — the post-#1386 notify path always records
      // a `null` errorMessage on success.
      { alertId: targetAlert, userId: orgAdminId, channel: "push", status: "sent", errorMessage: null },
      // Real per-user failure — captured at delivery time with a
      // genuine push error.
      { alertId: targetAlert, userId: orgAdminId, channel: "email", status: "failed", errorMessage: "smtp 550" },
      // Reconstructed row — the backfill stamps the marker on every
      // row it synthesizes.
      { alertId: targetAlert, userId: playerUserId, channel: "push", status: "failed", errorMessage: backfillMarker },
    ]);

    const app = createTestApp(asUser(superAdminId, "super_admin", null));
    const res = await request(app).get(`/api/super-admin/manual-entry-alerts/${targetAlert}/silent-recipients`);
    expect(res.status).toBe(200);

    const body = res.body as {
      silentRecipients: Array<{
        userId: number | null;
        errorMessage: string | null;
        reconstructed: boolean;
      }>;
    };

    const real = body.silentRecipients.find(r => r.errorMessage === "smtp 550");
    expect(real?.reconstructed).toBe(false);
    const recon = body.silentRecipients.find(r => r.errorMessage === backfillMarker);
    expect(recon?.reconstructed).toBe(true);

    // CSV export mirrors the JSON shape and includes the
    // `reconstructed` provenance column so spreadsheet/BI consumers
    // can filter on it.
    const csvRes = await request(app).get(`/api/super-admin/manual-entry-alerts/${targetAlert}/silent-recipients.csv`);
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers["content-type"]).toMatch(/text\/csv/);
    expect(csvRes.headers["content-disposition"]).toMatch(/silent-recipients\.csv/);
    const csvBody = csvRes.text as string;
    const lines = csvBody.trim().split(/\r?\n/);
    // Header + 2 silent rows (the "sent" row is filtered out).
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("reconstructed");
    // Reconstructed row's "true"/"false" provenance flag is in the
    // last column; assert at least one of each in the body.
    const dataLines = lines.slice(1).join("\n");
    expect(dataLines).toMatch(/,true\s*$/m);
    expect(dataLines).toMatch(/,false\s*$/m);

    await db.delete(manualEntryAlertRecipientsTable)
      .where(inArray(manualEntryAlertRecipientsTable.alertId, [targetAlert]));
  });

  it("rejects unauthenticated CSV requests with 401", async () => {
    const app = createTestApp(undefined);
    const res = await request(app).get(`/api/super-admin/manual-entry-alerts/${alertIds[0]}/silent-recipients.csv`);
    expect(res.status).toBe(401);
  });

  it("returns an empty silent-recipients list and totalRecipientRows=0 for an alert with no recipient rows", async () => {
    // alertIds[0] is the fully-delivered tournA1 r1 alert; we never wrote
    // any recipient rows for it, so the endpoint should report 0/0 — and
    // the dashboard renders the "no per-recipient records" hint.
    const app = createTestApp(asUser(superAdminId, "super_admin", null));
    const res = await request(app).get(`/api/super-admin/manual-entry-alerts/${alertIds[0]}/silent-recipients`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      alertId: alertIds[0],
      totalRecipientRows: 0,
      silentRecipients: [],
    });
  });
});

// Task #1658 — skip-row visibility on the audit endpoints.
//
// Seeds two extra rows for tournA1/playerP1 with status='skipped' (one
// org_muted, one below_threshold) and one with status='failed', then
// asserts:
//   - the rows endpoint returns them by default (status='all'),
//   - the `status` query param narrows correctly (and rejects garbage),
//   - the CSV row body emits the new status/reason columns,
//   - the aggregate /summary endpoint is **unaffected** by the skip
//     rows (delivery rates are still computed only over status='sent').
describe("manual-entry-alerts skip rows (Task #1658)", () => {
  const skipAlertIds: number[] = [];
  const skipSubmissionIds: number[] = [];

  beforeAll(async () => {
    const now = Date.now();
    // Use distinct rounds so the (playerId, round) unique index on
    // round_submissions doesn't collide with the alerts seeded above.
    const skipSub1 = await seedSubmission(playerP1Id, tournA1Id, 50);
    skipSubmissionIds.push(skipSub1);
    const [r1] = await db.insert(manualEntryAlertsTable).values({
      submissionId: skipSub1,
      tournamentId: tournA1Id,
      playerId: playerP1Id,
      round: 50,
      manualPct: "82.00",
      manualShots: 8,
      totalShots: 10,
      recipientCount: 0,
      pushAttempted: 0, pushSent: 0,
      emailAttempted: 0, emailSent: 0,
      status: "skipped",
      reason: "org_muted",
      sentAt: new Date(now - 1 * DAY),
    }).returning({ id: manualEntryAlertsTable.id });
    skipAlertIds.push(r1.id);

    const skipSub2 = await seedSubmission(playerP1Id, tournA1Id, 51);
    skipSubmissionIds.push(skipSub2);
    const [r2] = await db.insert(manualEntryAlertsTable).values({
      submissionId: skipSub2,
      tournamentId: tournA1Id,
      playerId: playerP1Id,
      round: 51,
      manualPct: "30.00",
      manualShots: 3,
      totalShots: 10,
      recipientCount: 0,
      pushAttempted: 0, pushSent: 0,
      emailAttempted: 0, emailSent: 0,
      status: "skipped",
      reason: "below_threshold",
      sentAt: new Date(now - 2 * DAY),
    }).returning({ id: manualEntryAlertsTable.id });
    skipAlertIds.push(r2.id);

    const failSub = await seedSubmission(playerP1Id, tournA1Id, 52);
    skipSubmissionIds.push(failSub);
    const [r3] = await db.insert(manualEntryAlertsTable).values({
      submissionId: failSub,
      tournamentId: tournA1Id,
      playerId: playerP1Id,
      round: 52,
      manualPct: "70.00",
      manualShots: 7,
      totalShots: 10,
      recipientCount: 0,
      pushAttempted: 0, pushSent: 0,
      emailAttempted: 0, emailSent: 0,
      status: "failed",
      reason: "org_lookup_failed",
      sentAt: new Date(now - 3 * DAY),
    }).returning({ id: manualEntryAlertsTable.id });
    skipAlertIds.push(r3.id);
  });

  afterAll(async () => {
    if (skipAlertIds.length > 0) {
      await db.delete(manualEntryAlertsTable).where(inArray(manualEntryAlertsTable.id, skipAlertIds));
    }
    if (skipSubmissionIds.length > 0) {
      await db.delete(roundSubmissionsTable).where(inArray(roundSubmissionsTable.id, skipSubmissionIds));
    }
  });

  it("rows endpoint returns skip + failed rows by default with status/reason populated", async () => {
    const res = await callRows(asUser(superAdminId, "super_admin", null), "?sinceDays=30&limit=500");
    expect(res.status).toBe(200);
    const body = res.body as { rows: Array<{ id: number; status: string; reason: string | null }> };
    const byId = new Map(body.rows.map(r => [r.id, r]));
    expect(byId.get(skipAlertIds[0])).toMatchObject({ status: "skipped", reason: "org_muted" });
    expect(byId.get(skipAlertIds[1])).toMatchObject({ status: "skipped", reason: "below_threshold" });
    expect(byId.get(skipAlertIds[2])).toMatchObject({ status: "failed", reason: "org_lookup_failed" });
    // Sent rows still report status='sent' with NULL reason.
    const sentRow = byId.get(alertIds[0]);
    expect(sentRow).toBeDefined();
    expect(sentRow?.status).toBe("sent");
    expect(sentRow?.reason).toBeNull();
  });

  it("rows?status=skipped narrows to skip rows only", async () => {
    const res = await callRows(
      asUser(superAdminId, "super_admin", null),
      "?status=skipped&sinceDays=30&limit=500",
    );
    expect(res.status).toBe(200);
    const body = res.body as { rows: Array<{ id: number; status: string }> };
    expect(body.rows.length).toBeGreaterThan(0);
    for (const r of body.rows) expect(r.status).toBe("skipped");
    const ids = body.rows.map(r => r.id);
    expect(ids).toEqual(expect.arrayContaining([skipAlertIds[0], skipAlertIds[1]]));
    expect(ids).not.toContain(alertIds[0]);
    expect(ids).not.toContain(skipAlertIds[2]); // failed row excluded
  });

  it("rows?status=failed narrows to the failed row", async () => {
    const res = await callRows(
      asUser(superAdminId, "super_admin", null),
      "?status=failed&sinceDays=30&limit=500",
    );
    expect(res.status).toBe(200);
    const body = res.body as { rows: Array<{ id: number; status: string }> };
    for (const r of body.rows) expect(r.status).toBe("failed");
    expect(body.rows.map(r => r.id)).toContain(skipAlertIds[2]);
  });

  it("rows?status=sent excludes skip + failed rows", async () => {
    const res = await callRows(
      asUser(superAdminId, "super_admin", null),
      "?status=sent&sinceDays=30&limit=500",
    );
    expect(res.status).toBe(200);
    const body = res.body as { rows: Array<{ id: number; status: string }> };
    for (const r of body.rows) expect(r.status).toBe("sent");
    const ids = body.rows.map(r => r.id);
    expect(ids).not.toContain(skipAlertIds[0]);
    expect(ids).not.toContain(skipAlertIds[1]);
    expect(ids).not.toContain(skipAlertIds[2]);
  });

  it("rejects an unknown status value with 400", async () => {
    const res = await callRows(
      asUser(superAdminId, "super_admin", null),
      "?status=bogus",
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("status") });
  });

  it("rejects status=skipped combined with zeroDeliveryOnly=1 with 400 (would always be empty)", async () => {
    // The "silent only" view by definition operates on alerts that
    // actually fired but reached nobody (status='sent', pushSent=0,
    // emailSent=0). Combining it with status='skipped' or 'failed'
    // would silently return zero rows downstream — reject the combo
    // up-front so the dashboard surfaces a real error instead.
    const res = await callRows(
      asUser(superAdminId, "super_admin", null),
      "?status=skipped&zeroDeliveryOnly=1",
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("status") });
  });

  it("allows status=sent combined with zeroDeliveryOnly=1 (mirrors the legacy silent-only toggle)", async () => {
    // Sanity check the precedence rule above: status='sent' is the
    // canonical "silent only" pre-#1658 semantic and must keep working
    // when explicitly named.
    const res = await callRows(
      asUser(superAdminId, "super_admin", null),
      "?status=sent&zeroDeliveryOnly=1&sinceDays=30&limit=200",
    );
    expect(res.status).toBe(200);
    const body = res.body as { rows: Array<{ status: string; pushSent: number; emailSent: number }> };
    for (const r of body.rows) {
      expect(r.status).toBe("sent");
      expect(r.pushSent).toBe(0);
      expect(r.emailSent).toBe(0);
    }
  });

  it("CSV body emits status + reason columns for skip rows", async () => {
    const csv = await callRowsCsv(
      asUser(superAdminId, "super_admin", null),
      "?status=skipped&sinceDays=30",
    );
    expect(csv.status).toBe(200);
    const rows = parseCsv(csv.text);
    const dataRows = rows.slice(1).filter(r => skipAlertIds.includes(Number(r[0])));
    expect(dataRows.length).toBe(2);
    for (const r of dataRows) {
      // status column is index 16 (after the 16 pre-existing columns).
      expect(r[16]).toBe("skipped");
      // reason column is index 17, populated for skip rows.
      expect(["org_muted", "below_threshold"]).toContain(r[17]);
    }
  });

  it("CSV body leaves the reason column empty for status='sent' rows", async () => {
    const csv = await callRowsCsv(
      asUser(superAdminId, "super_admin", null),
      "?status=sent&sinceDays=30",
    );
    expect(csv.status).toBe(200);
    const rows = parseCsv(csv.text);
    const dataRows = rows.slice(1).filter(r => alertIds.includes(Number(r[0])));
    expect(dataRows.length).toBeGreaterThan(0);
    for (const r of dataRows) {
      expect(r[16]).toBe("sent");
      // Reason is NULL in the row payload; CSV serialises that as empty.
      expect(r[17]).toBe("");
    }
  });

  it("/summary delivery-rate aggregates are unaffected by the new skip rows", async () => {
    // Re-run /summary now that skip rows exist and assert the same
    // tournA1 7d invariants from the headline aggregation test still
    // hold — proves the health queries filtered to status='sent'.
    const res = await callSummary(asUser(superAdminId, "super_admin", null));
    expect(res.status).toBe(200);
    const body = res.body as {
      topTournaments7d: Array<{ tournamentId: number; alertCount: number; zeroDeliveryCount: number; silentRecipientTotal: number }>;
      topPlayers30d: Array<{ playerId: number; alertCount: number }>;
    };
    const tournA1 = body.topTournaments7d.find(t => t.tournamentId === tournA1Id);
    expect(tournA1).toBeTruthy();
    // Same 3 sent alerts as before — the two skipped rows for the same
    // tournament must NOT inflate the alert count or zero-delivery count.
    expect(tournA1?.alertCount).toBe(3);
    expect(tournA1?.zeroDeliveryCount).toBe(1);
    // Per-recipient semantics (Task #1671): tournA1's silent inbox tally
    // is 4 (the partially-silent r2 alert contributes 1 + the
    // fully-silent r3 alert contributes 3), matching the headline
    // aggregation test above. The two skip-status rows seeded here
    // have zero recipient rows AND are filtered out by status='sent',
    // so they cannot inflate this number.
    expect(tournA1?.silentRecipientTotal).toBe(4);

    // P1 still shows 3 alerts in last 30d (its 2 skipped + 1 failed
    // rows live in the same tournament but must not be aggregated).
    const p1 = body.topPlayers30d.find(p => p.playerId === playerP1Id);
    expect(p1?.alertCount).toBe(3);
  });
});
